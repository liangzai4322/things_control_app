import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DAILY_INTAKE_FAILURE_EVENT_KEY, DailyIntakeConsumer, DailyIntakeError, createDailyIntakeConsumerFromEnv, validateDailyIntake } from '../integrations/execution-system/daily-intake-consumer.mjs';

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-intake-consumer-'));
let clock = new Date('2026-09-03T12:00:00.000Z');
const now = () => new Date(clock);
const intake = {
  id: 'intake-1', schemaVersion: 1, contractVersion: '2026-09-03.1', systemId: 'execution', status: 'accepted', reviewDate: '2026-09-03',
  observationPeriod: { start: '2026-09-03T00:00:00+08:00', end: '2026-09-03T11:59:00+08:00' }, sourceRef: 'daily-review:2026-09-03', evidenceRefs: ['review-evidence:1'],
  freshness: { status: 'fresh', generatedAt: '2026-09-03T11:30:00.000Z' }, revision: 2, idempotencyKey: 'execution:2026-09-03:2:abc',
  data: { candidates: [{ epistemicState: 'candidate_unvalidated', writesTargetSystem: false }], explicitDispatches: [{ authorizationSource: 'explicit_user' }] },
};

assert.equal(validateDailyIntake(intake, { now: now() }).revision, 2);
assert.throws(() => validateDailyIntake({ ...intake, contractVersion: 'unknown' }, { now: now() }), /daily_intake_contract_invalid/);
assert.throws(() => validateDailyIntake({ ...intake, freshness: { status: 'stale', generatedAt: '2026-09-01T00:00:00.000Z' } }, { now: now() }), /daily_intake_stale/);
assert.throws(() => createDailyIntakeConsumerFromEnv({ TASKBOX_API_TOKEN: 'generic-token' }, { fetchImpl: async () => new Response('{}') }), /daily_intake_token_required/, 'generic TaskBox token must never be a fallback');
assert.throws(() => createDailyIntakeConsumerFromEnv({ DAILY_INTAKE_TOKEN: 'raw-token' }, { fetchImpl: async () => new Response('{}') }), /daily_intake_token_required/, 'raw environment tokens must never be accepted');
const tokenDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-intake-token-'));
const tokenFile = path.join(tokenDir, 'execution.token');
fs.writeFileSync(tokenFile, 'fixture-intake-token\n', { mode: 0o600 });
const fileConfigured = createDailyIntakeConsumerFromEnv({ DAILY_INTAKE_TOKEN_FILE: tokenFile }, { fetchImpl: async () => new Response(JSON.stringify({ intakes: [] }), { status: 200 }) });
assert.equal(fileConfigured.token, 'fixture-intake-token', 'only the dedicated mounted token file is accepted');

const calls = [];
const client = new DailyIntakeConsumer({ endpoint: 'https://example.test/taskbox-api', token: 'intake-only-token', stateDir, now, fetchImpl: async (url, options) => {
  calls.push({ url, options });
  if (options.method === 'GET') return new Response(JSON.stringify({ intakes: [intake] }), { status: 200 });
  return new Response(JSON.stringify({ ok: true }), { status: 200 });
} });
await assert.rejects(() => client.run(), (error) => error instanceof DailyIntakeError && error.code === 'daily_intake_review_date_required');
const first = await client.run({ reviewDate: '2026-09-03' });
assert.equal(first.fetched, 1); assert.equal(first.receiptDelivered, 1); assert.equal(first.outbox.pending || 0, 0);
assert.match(calls[0].url, /intake=1/); assert.match(calls[0].url, /status=accepted/); assert.match(calls[1].url, /status=retrying/);
const receiptCall = calls.find((call) => call.options.method === 'POST');
const receipt = JSON.parse(receiptCall.options.body);
assert.deepEqual(Object.keys(receipt).sort(), ['idempotencyKey', 'projection', 'status']);
assert.equal(receipt.projection[0].outcome, 'candidate_read_only'); assert.equal(receipt.projection[1].outcome, 'explicit_dispatch_read_only');
assert.equal(receiptCall.options.headers['X-Idempotency-Key'], receipt.idempotencyKey);
assert.equal(/taskbox-client|\.operate\(/.test(fs.readFileSync(new URL('../integrations/execution-system/daily-intake-consumer.mjs', import.meta.url), 'utf8')), false, 'intake must not write TaskBox');

const duplicate = await client.run({ reviewDate: '2026-09-03' });
assert.equal(duplicate.receiptDelivered, 1, 'same receipt is safely replayed with its stable idempotency key');

const retryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-intake-retry-'));
let networkFails = true;
let includeRetryIntake = true;
const retryClient = new DailyIntakeConsumer({ endpoint: 'https://example.test', token: 'intake-only-token', stateDir: retryDir, now, fetchImpl: async (url, options) => {
  if (options.method === 'GET') return new Response(JSON.stringify({ intakes: url.includes('accepted') && includeRetryIntake ? [intake] : [] }), { status: 200 });
  if (networkFails) throw new Error('offline'); return new Response(JSON.stringify({ ok: true }), { status: 200 });
} });
const retried = await retryClient.run({ reviewDate: '2026-09-03' });
assert.equal(retried.retried, 1); assert.equal(retried.outbox.retrying, 1);
networkFails = false; clock = new Date(clock.getTime() + 61 * 1000);
includeRetryIntake = false;
const afterRestart = new DailyIntakeConsumer({ endpoint: 'https://example.test', token: 'intake-only-token', stateDir: retryDir, now, fetchImpl: retryClient.fetchImpl });
const recovered = await afterRestart.run({ reviewDate: '2026-09-03' });
assert.equal(recovered.receiptDelivered, 1); assert.equal(recovered.outbox.retrying || 0, 0, 'persistent receipt outbox recovers after restart');

for (const [status, state] of [[401, 'authBlocked'], [409, 'deadLetter']]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `daily-intake-${status}-`));
  const failing = new DailyIntakeConsumer({ endpoint: 'https://example.test', token: 'intake-only-token', stateDir: dir, now, fetchImpl: async (url, options) => {
    if (options.method === 'GET') return new Response(JSON.stringify({ intakes: url.includes('accepted') ? [intake] : [] }), { status: 200 });
    return new Response(JSON.stringify({ error: status === 401 ? 'unauthorized' : 'conflict' }), { status });
  } });
  const result = await failing.run({ reviewDate: '2026-09-03' });
  assert.equal(result.outbox[state], 1); assert.equal(failing.outbox.list()[0].eventKey, DAILY_INTAKE_FAILURE_EVENT_KEY);
  const postCount = failing.outbox.list()[0].attempts;
  await failing.drain({ receiptDelivered: 0, retried: 0, authBlocked: 0, deadLetters: 0 });
  assert.equal(failing.outbox.list()[0].attempts, postCount, `${status} must not overwrite or retry terminal receipt failure`);
}

const unknownDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-intake-unknown-'));
let unknownReceipt = null;
const unknownConsumer = new DailyIntakeConsumer({ endpoint: 'https://example.test', token: 'intake-only-token', stateDir: unknownDir, now, fetchImpl: async (url, options) => {
  if (options.method === 'GET') return new Response(JSON.stringify({ intakes: url.includes('accepted') ? [{ ...intake, contractVersion: 'unknown' }] : [] }), { status: 200 });
  unknownReceipt = JSON.parse(options.body); return new Response(JSON.stringify({ ok: true }), { status: 200 });
} });
await unknownConsumer.run({ reviewDate: '2026-09-03' });
assert.equal(unknownReceipt.status, 'ignored'); assert.equal(unknownReceipt.errorCode, 'daily_intake_contract_invalid');

const lockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-intake-lock-'));
const locked = new DailyIntakeConsumer({ endpoint: 'https://example.test', token: 'intake-only-token', stateDir: lockDir, now, fetchImpl: async () => new Response(JSON.stringify({ intakes: [] }), { status: 200 }) });
const lease = locked.acquireLock();
await assert.rejects(() => locked.run({ reviewDate: '2026-09-03' }), (error) => error instanceof DailyIntakeError && error.code === 'daily_intake_consumer_locked');
locked.releaseLock(lease);

const pausedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-intake-paused-'));
const pausedConsumer = new DailyIntakeConsumer({ endpoint: 'https://example.test', token: 'intake-only-token', stateDir: pausedDir, now, fetchImpl: async () => new Response(JSON.stringify({ error: 'daily_intake_api_disabled' }), { status: 503 }) });
const paused = await pausedConsumer.run({ reviewDate: '2026-09-03' });
assert.equal(paused.paused, true); assert.equal(paused.reason, 'daily_intake_api_disabled');

fs.rmSync(stateDir, { recursive: true, force: true }); fs.rmSync(retryDir, { recursive: true, force: true }); fs.rmSync(lockDir, { recursive: true, force: true }); fs.rmSync(unknownDir, { recursive: true, force: true }); fs.rmSync(tokenDir, { recursive: true, force: true }); fs.rmSync(pausedDir, { recursive: true, force: true });
console.log('daily intake consumer tests passed');
