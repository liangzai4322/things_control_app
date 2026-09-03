import assert from 'node:assert/strict';
import {
  ATTENTION_INTAKE_CONTRACT_VERSION,
  buildAttentionReceipt,
  consumeAttentionDailyReviewIntakes,
  prepareAttentionIntakes,
  validateAttentionIntake,
} from '../js/time-attention-daily-intake.js';

const intake = {
  id: 'daily-review:2026-09-03:attention:1',
  schemaVersion: 1,
  contractVersion: ATTENTION_INTAKE_CONTRACT_VERSION,
  systemId: 'attention',
  reviewDate: '2026-09-03',
  observationPeriod: {
    activity_start: '2026-09-03T00:00:00+08:00',
    activity_end: '2026-09-03T23:59:59+08:00',
  },
  sourceRef: 'daily-review:2026-09-03',
  evidenceRefs: ['review:2026-09-03#attention'],
  freshness: '2026-09-03T19:55:00+08:00',
  revision: 2,
  idempotencyKey: 'daily-review-attention:2026-09-03',
  data: {
    reviewDate: '2026-09-03',
    capacity: { availableMinutes: 300, remainingMinutes: 90, healthCapacity: 0.7, overloadState: 'warning' },
    planned: { focusMinutes: 120 },
    actual: { focusMinutes: 75 },
    protectedFocusWindows: [
      { startAt: '2026-09-03T09:00:00+08:00', endAt: '2026-09-03T10:30:00+08:00', conflict: true, title: '不得进入投影' },
    ],
    topLeakage: { type: 'context_switch', occurredAt: '2026-09-03T11:00:00+08:00', durationMinutes: 18, severity: 'high', detail: '不得进入投影' },
    variance: { plannedMinutes: 120, actualMinutes: 75, deltaMinutes: -45, status: 'underrun', note: '不得进入投影' },
    calendarCoverage: 'partial',
    dataQuality: { missingFields: ['actual.stopAt'], staleSources: ['calendar.snapshot'] },
    commitments: [{ title: '不得进入回执' }],
  },
  status: 'pending',
  receivedAt: '2026-09-03T20:00:00+08:00',
  updatedAt: '2026-09-03T20:00:00+08:00',
  receipt: null,
};
assert.deepEqual(validateAttentionIntake(intake, { reviewDate: intake.reviewDate }), { ok: true });
assert.equal(validateAttentionIntake({ ...intake, contractVersion: 'future-v2' }).code, 'unsupported_contract_version');
assert.equal(validateAttentionIntake({ ...intake, revision: 0 }).code, 'invalid_revision');
assert.equal(validateAttentionIntake({ ...intake, freshness: 'assumed-fresh' }).code, 'invalid_freshness');
assert.equal(validateAttentionIntake({ ...intake, reviewDate: '2026-02-30', data: { ...intake.data, reviewDate: '2026-02-30' } }).code, 'invalid_review_date');
assert.equal(validateAttentionIntake({ ...intake, reviewDate: '2026-09-02' }, { reviewDate: '2026-09-03' }).code, 'review_date_mismatch');

const receipt = buildAttentionReceipt(intake);
assert.equal(receipt.status, 'processed');
assert.equal(receipt.idempotencyKey, 'daily-review-attention:2026-09-03:attention:processed:r2');
assert.deepEqual(receipt.projection, {
  availableMinutes: 300,
  remainingMinutes: 90,
  healthCapacity: 0.7,
  overloadState: 'warning',
  protectedWindows: [{ startAt: '2026-09-03T09:00:00+08:00', endAt: '2026-09-03T10:30:00+08:00', conflictState: 'conflict' }],
  conflictCount: 1,
  topLeakage: { type: 'context_switch', occurredAt: '2026-09-03T11:00:00+08:00', durationMinutes: 18, severity: 'high' },
  variance: { plannedMinutes: 120, actualMinutes: 75, deltaMinutes: -45, status: 'underrun' },
  missingFieldRefs: ['actual.stopAt'],
  staleFieldRefs: ['calendar.snapshot'],
});
assert.doesNotMatch(JSON.stringify(receipt), /不得进入/);

const duplicate = prepareAttentionIntakes([intake, structuredClone(intake), { ...intake, revision: 3 }], { reviewDate: intake.reviewDate });
assert.equal(duplicate.accepted.length, 1);
assert.equal(duplicate.skipped[0].reason, 'duplicate_idempotent_replay');
assert.equal(duplicate.rejected[0].code, 'idempotency_key_collision');
assert.equal(prepareAttentionIntakes([{ ...intake, status: 'processed' }]).skipped[0].reason, 'terminal_status');

const requests = [];
const consumed = await consumeAttentionDailyReviewIntakes({
  reviewDate: intake.reviewDate,
  request: async (path, options = {}) => {
    requests.push({ path, options });
    if (!options.method) return { intakes: [intake] };
    return { accepted: true, receipt: JSON.parse(options.body) };
  },
});
assert.equal(consumed.processed.length, 1);
assert.match(requests[0].path, /^\/system-candidates\?systemId=attention&intake=1&reviewDate=2026-09-03&status=pending&limit=100$/);
assert.equal(requests[1].path, '/system-candidates/daily-review%3A2026-09-03%3Aattention%3A1/receipt');
assert.equal(requests[1].options.method, 'POST');
assert.deepEqual(Object.keys(JSON.parse(requests[1].options.body)).sort(), ['idempotencyKey', 'projection', 'status']);
assert.equal(requests.some((item) => item.options.method === 'PATCH'), false, 'intake consumer must never PATCH candidates');

const disconnected = await consumeAttentionDailyReviewIntakes({ reviewDate: intake.reviewDate, request: async () => null });
assert.equal(disconnected.connected, false, 'offline API must not affect independent attention operation');

const incompatibleRequests = [];
const incompatible = await consumeAttentionDailyReviewIntakes({
  reviewDate: intake.reviewDate,
  request: async (path, options = {}) => {
    incompatibleRequests.push({ path, options });
    return { intakes: [{ ...intake, contractVersion: 'future-v2' }] };
  },
});
assert.equal(incompatible.processed.length, 0);
assert.equal(incompatible.rejected.length, 0);
assert.equal(incompatible.ignored.length, 1);
assert.equal(incompatibleRequests.length, 2, 'safely identified incompatible contracts must receive one terminal receipt');
const ignoredReceipt = JSON.parse(incompatibleRequests[1].options.body);
assert.equal(ignoredReceipt.status, 'ignored');
assert.equal(ignoredReceipt.idempotencyKey, 'daily-review-attention:2026-09-03:attention:ignored:r2');
assert.equal(ignoredReceipt.errorCode, 'unsupported_contract_version');
assert.deepEqual(ignoredReceipt.projection.protectedWindows, []);
assert.doesNotMatch(JSON.stringify(ignoredReceipt), /不得进入/);

const unsafeIncompatibleRequests = [];
const unsafeIncompatible = await consumeAttentionDailyReviewIntakes({
  reviewDate: intake.reviewDate,
  request: async (path, options = {}) => {
    unsafeIncompatibleRequests.push({ path, options });
    return { intakes: [{ ...intake, id: '', contractVersion: 'future-v2' }] };
  },
});
assert.equal(unsafeIncompatible.ignored.length, 0);
assert.equal(unsafeIncompatible.rejected[0].code, 'missing_intake_id');
assert.equal(unsafeIncompatibleRequests.length, 1, 'unsafe identity must not be acknowledged');

const retryRequests = [];
await consumeAttentionDailyReviewIntakes({
  reviewDate: intake.reviewDate,
  status: 'retrying',
  request: async (path, options = {}) => {
    retryRequests.push({ path, options });
    if (!options.method) return { intakes: [{ ...intake, status: 'retrying' }] };
    return { accepted: true };
  },
});
assert.match(retryRequests[0].path, /status=retrying/);
assert.equal(JSON.parse(retryRequests[1].options.body).idempotencyKey, 'daily-review-attention:2026-09-03:attention:processed:r2');

const unknownFreshnessReceipt = buildAttentionReceipt({
  ...intake,
  freshness: 'unknown',
  data: { ...intake.data, capacity: { overloadState: 'unknown' }, dataQuality: {} },
});
assert.deepEqual(unknownFreshnessReceipt.projection.missingFieldRefs, [
  'capacity.availableMinutes', 'capacity.remainingMinutes', 'capacity.healthCapacity', 'intake.freshness',
]);

const pageSource = (await import('node:fs')).readFileSync('js/time-attention-page.js', 'utf8');
assert.match(pageSource, /consumeAttentionDailyReviewIntakes\(\{ reviewDate: date \}\)/);
const intakeSource = (await import('node:fs')).readFileSync('js/time-attention-daily-intake.js', 'utf8');
assert.doesNotMatch(intakeSource, /writeTimeStore|upsertTimePlan|addTask|updateTask|calendar.*(?:PATCH|POST)/i);

console.log('time attention P1 model tests passed');
