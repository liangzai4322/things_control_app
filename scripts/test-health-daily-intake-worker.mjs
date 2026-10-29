import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HealthDailyIntakeWorker, createHealthDailyIntakeWorkerFromEnv } from '../integrations/health-system/daily-intake-worker.mjs';

function intake(overrides = {}) {
  return {
    id: 'health-worker-fixture', schemaVersion: 1, contractVersion: '2026-09-03.1', systemId: 'health',
    reviewDate: '2026-09-03', observationPeriod: { activity_start: '2026-09-02', activity_end: '2026-09-02' },
    sourceRef: 'fixture:daily-review', evidenceRefs: ['fixture:evidence'], freshness: { status: 'fresh' },
    revision: 1, idempotencyKey: 'fixture:health:1', status: 'accepted', receipt: null,
    data: { authority: 'explicit_user', observationDate: '2026-09-02', sleepHours: 7, energy: 4, confidence: 0.8 },
    ...overrides,
  };
}

function response(status, data) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(data) };
}

const credentialDir = fs.mkdtempSync(path.join(os.tmpdir(), 'health-intake-credential-'));
fs.writeFileSync(path.join(credentialDir, 'health.token'), 'credential-health-token\n', { mode: 0o600 });
assert.equal(createHealthDailyIntakeWorkerFromEnv({ CREDENTIALS_DIRECTORY: credentialDir }, { fetchImpl: async () => response(200, {}) }).token, 'credential-health-token');
fs.rmSync(credentialDir, { recursive: true, force: true });

const requests = [];
const current = intake();
const fetchImpl = async (url, options = {}) => {
  const parsed = new URL(url);
  const body = options.body ? JSON.parse(options.body) : null;
  requests.push({ path: `${parsed.pathname}${parsed.search}`, method: options.method || 'GET', body, token: options.headers.Authorization });
  if (parsed.pathname === '/v1/system-candidates' && parsed.searchParams.get('systemId') === 'execution') {
    return response(403, { error: 'daily_intake_system_denied' });
  }
  if (parsed.pathname === '/v1/system-candidates' && parsed.searchParams.get('status') === 'accepted') {
    return response(200, { intakes: [current] });
  }
  if (parsed.pathname === '/v1/system-candidates') return response(200, { intakes: [] });
  if (parsed.pathname === '/v1/health/observations') return response(200, { observations: [] });
  if (parsed.pathname === '/v1/health/observations/batch') return response(200, { created: 1, updated: 0 });
  if (parsed.pathname === '/v1/health/snapshots') return response(200, { created: 1, updated: 0 });
  if (parsed.pathname.endsWith('/receipt')) return response(201, { receipt: body });
  return response(404, { error: 'not_found' });
};

const worker = new HealthDailyIntakeWorker({
  endpoint: 'http://fixture.invalid', token: 'health-scope-token', fetchImpl,
  now: () => new Date('2026-09-03T08:00:00.000Z'), globalDisableFile: '', healthDisableFile: '',
});
assert.deepEqual(await worker.probe(), { ok: true, accepted: 1, retrying: 0, healthRead: true, crossSystemDenied: true });
requests.length = 0;
const result = await worker.runOnce();
assert.equal(result.processed, 1);
assert.equal(result.results[0].status, 'processed');
assert.equal(requests.every((item) => item.token === 'Bearer health-scope-token'), true);
assert.equal(requests.some((item) => item.path === '/v1/health/observations/batch'), true);
assert.equal(requests.some((item) => item.path === '/v1/health/snapshots'), true);
assert.equal(requests.some((item) => item.path.endsWith('/receipt')), true);
const savedReceipt = requests.find((item) => item.path.endsWith('/receipt')).body;
assert.equal(savedReceipt.status, 'processed');
assert.deepEqual(Object.keys(savedReceipt.projection), [
  'status', 'availableCapacity', 'confidence', 'constraints', 'missingFields', 'conflictCount', 'sourceRefs',
]);

// Exercise the real consumer write order for the two reported merged-date shapes.
for (const [reviewDate, observationDate] of [['2026-10-29', '2026-10-28'], ['2026-10-28', '2026-10-27']]) {
  const writes = [];
  const bounded = new HealthDailyIntakeWorker({
    endpoint: 'http://fixture.invalid', token: 'health-scope-token', globalDisableFile: '', healthDisableFile: '',
    fetchImpl: async (url, options = {}) => {
      const pathname = new URL(url).pathname;
      const body = options.body ? JSON.parse(options.body) : null;
      writes.push({ pathname, body });
      return response(pathname.endsWith('/receipt') ? 201 : 200, {});
    },
  });
  const item = intake({
    id: `synthetic-merged-${reviewDate}`, reviewDate,
    observationPeriod: { activity_start: observationDate, activity_end: reviewDate },
    data: { healthObservation: { authority: 'explicit_user', observationDate, effectiveDate: reviewDate, energy: 3, confidence: 0.8 } },
  });
  const outcome = await bounded.consume(item, { observations: [] });
  assert.equal(outcome.status, 'processed');
  assert.deepEqual(writes.map((write) => write.pathname), [
    '/v1/health/observations/batch', '/v1/health/snapshots', `/v1/system-candidates/${item.id}/receipt`,
  ]);
  const fact = writes[0].body.observations[0];
  assert.equal(fact.observationDate, observationDate);
  assert.equal(fact.effectiveDate, reviewDate);
  assert.equal(fact.observationId, `health-daily-intake:${item.id}:r1`);
  assert.equal(writes[1].body.basisDate, observationDate, 'snapshot refers to the real previous day');
  assert.equal(writes[2].body.projection.status, 'unknown', 'missing sleep is not made healthy by successful transport');
  assert.equal(writes[2].body.projection.availableCapacity, null);
  const invalid = { ...item, id: `outside-${reviewDate}`, data: { ...item.data, healthObservation: { ...item.data.healthObservation, observationDate: '2026-10-30' } } };
  writes.length = 0;
  assert.equal((await bounded.consume(invalid, { observations: [] })).status, 'failed');
  assert.deepEqual(writes.map((write) => write.pathname), [`/v1/system-candidates/${invalid.id}/receipt`], 'outside-range facts never write observations or snapshots');
  assert.equal(writes[0].body.errorCode, 'observation_period_mismatch');
}

const futureRetry = intake({
  id: 'health-worker-retry', status: 'retrying',
  receipt: { attempts: 2, retryAt: '2026-09-03T09:00:00.000Z' },
});
const retryRequests = [];
const retryWorker = new HealthDailyIntakeWorker({
  endpoint: 'http://fixture.invalid', token: 'health-scope-token', globalDisableFile: '', healthDisableFile: '',
  now: () => new Date('2026-09-03T08:00:00.000Z'),
  fetchImpl: async (url, options = {}) => {
    const parsed = new URL(url); retryRequests.push(parsed.pathname);
    if (parsed.pathname === '/v1/system-candidates' && parsed.searchParams.get('status') === 'retrying') return response(200, { intakes: [futureRetry] });
    if (parsed.pathname === '/v1/system-candidates') return response(200, { intakes: [] });
    if (parsed.pathname === '/v1/health/observations') return response(200, { observations: [] });
    if (parsed.pathname.endsWith('/receipt')) return response(201, { ok: true });
    return response(404, { error: 'not_found' });
  },
});
const skippedRetry = await retryWorker.runOnce();
assert.equal(skippedRetry.processed, 0, 'retryAt in the future is respected');
assert.equal(retryRequests.some((item) => item.endsWith('/receipt')), false);

const unsupported = intake({ id: 'health-worker-unsupported', contractVersion: 'future-contract' });
const unsupportedRequests = [];
const unsupportedWorker = new HealthDailyIntakeWorker({
  endpoint: 'http://fixture.invalid', token: 'health-scope-token', globalDisableFile: '', healthDisableFile: '',
  fetchImpl: async (url, options = {}) => {
    const parsed = new URL(url); const body = options.body ? JSON.parse(options.body) : null;
    unsupportedRequests.push({ path: parsed.pathname, body });
    if (parsed.pathname === '/v1/system-candidates' && parsed.searchParams.get('status') === 'accepted') return response(200, { intakes: [unsupported] });
    if (parsed.pathname === '/v1/system-candidates') return response(200, { intakes: [] });
    if (parsed.pathname === '/v1/health/observations') return response(200, { observations: [] });
    if (parsed.pathname.endsWith('/receipt')) return response(201, { ok: true });
    return response(404, { error: 'not_found' });
  },
});
await unsupportedWorker.runOnce();
assert.equal(unsupportedRequests.some((item) => item.path === '/v1/health/observations/batch'), false);
const ignored = unsupportedRequests.find((item) => item.path.endsWith('/receipt')).body;
assert.equal(ignored.status, 'ignored');
assert.equal(ignored.errorCode, 'unsupported_contract_version');

console.log('health daily intake worker tests passed');
