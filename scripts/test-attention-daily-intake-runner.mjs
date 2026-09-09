import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  attentionRunnerHealth,
  createAttentionIntakeRequest,
  runAttentionIntakeCycle,
} from '../integrations/attention-system/daily-intake-runner.mjs';

assert.match(fs.readFileSync(new URL('./consume-daily-intake-attention.mjs', import.meta.url), 'utf8'), /CREDENTIALS_DIRECTORY/);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'attention-intake-runner-'));
const stateFile = path.join(root, 'state.json');
const tokenFile = path.join(root, 'attention.token');
const disableFile = path.join(root, 'disabled');
fs.writeFileSync(tokenFile, 'attention-only-token\n', { mode: 0o600 });

const calls = [];
const intake = {
  id: 'attention-intake-1', schemaVersion: 1, contractVersion: '2026-09-03.1', systemId: 'attention',
  reviewDate: '2026-09-03', observationPeriod: { activity_start: '2026-09-03T00:00:00+08:00', activity_end: '2026-09-03T23:59:59+08:00' },
  sourceRef: 'review:2026-09-03', evidenceRefs: [], freshness: '2026-09-03T20:00:00+08:00', revision: 1,
  idempotencyKey: 'attention:2026-09-03:1:hash', status: 'accepted', receivedAt: '2026-09-03T20:01:00+08:00', updatedAt: '2026-09-03T20:01:00+08:00', receipt: null,
  data: { reviewDate: '2026-09-03', capacity: { availableMinutes: 240, remainingMinutes: 60, healthCapacity: 0.6, overloadState: 'warning' }, planned: {}, actual: {}, variance: {}, protectedFocusWindows: [], calendarCoverage: 'partial' },
};
let acceptedRead = 0;
const request = async (requestPath, options = {}) => {
  calls.push({ requestPath, options });
  if (options.method === 'POST') return { receipt: { reviewDate: intake.reviewDate } };
  if (requestPath.includes('status=accepted')) return { intakes: acceptedRead++ ? [] : [intake] };
  return { intakes: [] };
};
const now = () => new Date('2026-09-03T12:00:00.000Z');
const result = await runAttentionIntakeCycle({ request, tokenFile, disableFile, stateFile, now });
assert.deepEqual(result, { ok: true, disabled: false, processed: 1, ignored: 0, failures: 0 });
assert.equal(calls.some((call) => call.requestPath.includes('status=accepted')), true);
assert.equal(calls.some((call) => call.requestPath.includes('status=retrying')), true);
assert.equal(calls.some((call) => call.options.method === 'PATCH'), false);
const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
assert.equal(state.lastSuccessAt, '2026-09-03T12:00:00.000Z');
assert.equal(state.lastReviewDate, '2026-09-03');
assert.equal(state.consecutiveFailures, 0);
assert.equal(JSON.stringify(state).includes('capacity'), false, 'runner state must not persist intake data');

const health = attentionRunnerHealth({ tokenFile, disableFile, stateFile });
assert.equal(health.enabled, true);
assert.equal(health.tokenConfigured, true);
assert.deepEqual(health.scopes, ['intakes:read:attention', 'receipts:write:attention']);

fs.writeFileSync(disableFile, 'disabled\n');
const disabled = await runAttentionIntakeCycle({ request: async () => { throw new Error('must not call'); }, tokenFile, disableFile, stateFile, now });
assert.equal(disabled.disabled, true);
fs.rmSync(disableFile);

let attempts = 0;
const retryingRequest = createAttentionIntakeRequest({
  endpoint: 'https://example.test/taskbox-api', token: 'secret', requestAttempts: 3, random: () => 0,
  fetchImpl: async (_url, options) => {
    attempts += 1;
    assert.equal(options.headers.Authorization, 'Bearer secret');
    if (attempts < 3) return new Response('{"error":"temporary"}', { status: 500, headers: { 'Content-Type': 'application/json' } });
    return new Response('{"intakes":[]}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  },
});
assert.deepEqual(await retryingRequest('/system-candidates?intake=1&systemId=attention'), { intakes: [] });
assert.equal(attempts, 3);

fs.rmSync(root, { recursive: true, force: true });
console.log('attention daily-intake runner tests passed');
