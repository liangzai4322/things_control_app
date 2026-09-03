import assert from 'node:assert/strict';
import { DailyIntakeConsumer, validateDailyIntake } from '../integrations/execution-system/daily-intake-consumer.mjs';

const NOW = new Date('2026-09-03T12:00:00.000Z');
const packageRecord = {
  id: 'intake-1', schemaVersion: 1, contractVersion: '2026-09-03.1', systemId: 'execution', reviewDate: '2026-09-03',
  observationPeriod: { start: '2026-09-03T00:00:00+08:00', end: '2026-09-03T11:59:00+08:00' },
  sourceRef: 'daily-review:2026-09-03', evidenceRefs: ['review-evidence:1'],
  freshness: { status: 'fresh', generatedAt: '2026-09-03T11:30:00.000Z' }, revision: 2,
  idempotencyKey: 'execution:2026-09-03:2:abc',
  data: {
    candidates: [{ epistemicState: 'candidate_unvalidated', writesTargetSystem: false }],
    explicitDispatches: [{
      requestId: 'request-1', idempotencyKey: 'dispatch-1', operation: 'schedule', taskId: 'task-1', expectedRevision: 4,
      authorizationSource: 'explicit_user', authorizationEvidence: { referenceId: 'user-2026-09-03-daily-review-system-handoff' },
      requestedMutation: { scheduledAt: '2026-09-03T13:00:00+08:00' }, reason: '用户明确要求排期',
    }],
  },
};

assert.equal(validateDailyIntake(packageRecord, { now: NOW }).revision, 2);
assert.throws(() => validateDailyIntake({ ...packageRecord, freshness: { status: 'stale', generatedAt: '2026-09-01T00:00:00.000Z' } }, { now: NOW }), /daily_intake_stale/);

const calls = [];
const consumer = new DailyIntakeConsumer({
  endpoint: 'https://example.test/taskbox-api', token: 'private-read-token', now: () => NOW,
  fetchImpl: async (url, options) => {
    calls.push({ url, options });
    if (options.method === 'GET') return new Response(JSON.stringify({ intakes: [packageRecord] }), { status: 200 });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  },
});
const [accepted] = await consumer.consumeAvailable();
assert.equal(accepted.status, 'received');
assert.deepEqual(accepted.projection[0], { taskId: null, outcome: 'candidate_read_only' });
assert.equal(accepted.projection[1].outcome, 'explicit_dispatch_read_only');
assert.match(calls[0].url, /\/v1\/system-candidates\?systemId=execution&intake=1$/);
assert.match(calls[1].url, /\/v1\/system-candidates\/intake-1\/receipt$/);
assert.equal(calls[1].options.headers['X-Idempotency-Key'], accepted.idempotencyKey);
assert.deepEqual(Object.keys(JSON.parse(calls[1].options.body)).sort(), ['idempotencyKey', 'projection', 'status']);

const staleConsumer = new DailyIntakeConsumer({ endpoint: 'https://example.test/taskbox-api', token: 'private-read-token', now: () => NOW, fetchImpl: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }) });
const ignored = await staleConsumer.consume({ ...packageRecord, freshness: { status: 'stale', generatedAt: '2026-09-01T00:00:00.000Z' } });
assert.equal(ignored.status, 'ignored');
assert.equal(ignored.errorCode, 'daily_intake_stale');
const incompatible = await staleConsumer.consume({ ...packageRecord, contractVersion: '2026-09-03.0' });
assert.equal(incompatible.status, 'ignored');
assert.equal(incompatible.errorCode, 'daily_intake_contract_invalid');

console.log('daily intake consumer tests passed');
