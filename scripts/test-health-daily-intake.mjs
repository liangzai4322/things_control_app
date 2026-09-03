import assert from 'node:assert/strict';
import {
  HEALTH_DAILY_INTAKE_CONTRACT_VERSION,
  buildHealthIntakeReceipt,
  buildHealthReceiptProjection,
  classifyHealthDailyIntake,
  consumeHealthDailyIntakes,
} from '../js/health-daily-intake.js';
import { HEALTH_STORAGE_KEY, normalizeHealthStore } from '../js/health-model.js';

function memoryStorage(initial = {}) {
  const memory = new Map(Object.entries(initial));
  return {
    getItem: (key) => memory.get(key) ?? null,
    setItem: (key, value) => memory.set(key, value),
    snapshot: () => Object.fromEntries(memory),
  };
}

function intake(overrides = {}) {
  const base = {
    id: 'health-intake-2026-09-02',
    schemaVersion: 1,
    contractVersion: HEALTH_DAILY_INTAKE_CONTRACT_VERSION,
    systemId: 'health',
    reviewDate: '2026-09-03',
    observationPeriod: { activity_start: '2026-09-02', activity_end: '2026-09-02' },
    sourceRef: 'daily-review:2026-09-03',
    evidenceRefs: ['review:2026-09-03'],
    freshness: 'fresh',
    revision: 1,
    idempotencyKey: 'daily-review:health:2026-09-03:r1',
    data: {
      authority: 'explicit_user',
      observationDate: '2026-09-02',
      sleepHours: 7.2,
      energy: 4,
      confidence: 0.8,
    },
    status: 'received',
    receivedAt: '2026-09-03T08:00:00.000Z',
    updatedAt: '2026-09-03T08:00:00.000Z',
    receipt: null,
  };
  return {
    ...base,
    ...overrides,
    observationPeriod: { ...base.observationPeriod, ...(overrides.observationPeriod || {}) },
    data: { ...base.data, ...(overrides.data || {}) },
  };
}

assert.equal(classifyHealthDailyIntake(intake()).action, 'process_fact');
assert.equal(classifyHealthDailyIntake(intake({ contractVersion: '2026-09-02' })).action, 'failed');
assert.equal(classifyHealthDailyIntake(intake({ contractVersion: '2026-09-02' })).errorCode, 'unsupported_contract_version');
assert.equal(classifyHealthDailyIntake(intake({ data: { observationDate: '2026-09-01' } })).action, 'failed');
assert.equal(classifyHealthDailyIntake(intake({ data: { authority: undefined } })).action, 'ignored');
assert.equal(classifyHealthDailyIntake(intake({ data: { authority: 'ai_summary' } })).action, 'ignored');
assert.equal(classifyHealthDailyIntake(intake({ status: 'processed' })).action, 'already_terminal');

const conflict = classifyHealthDailyIntake(intake({ data: { conflicts: ['睡眠来源冲突'] } }));
assert.equal(conflict.action, 'candidate_unknown');
assert.equal(conflict.conflictCount, 1);

const incomplete = classifyHealthDailyIntake(intake({ data: { sleepHours: undefined, energy: undefined, energyText: '疲惫' } }));
assert.equal(incomplete.action, 'process_fact');
assert.equal(incomplete.observation.sleepHours, null);
assert.equal(incomplete.observation.energy, 2);
assert.equal(incomplete.observation.energyScoreSource, 'qualitative_mapping');

const missingProjection = buildHealthReceiptProjection(normalizeHealthStore({
  observations: [incomplete.observation],
}), '2026-09-03');
assert.equal(missingProjection.status, 'unknown');
assert.equal(missingProjection.availableCapacity, null);
assert.deepEqual(missingProjection.missingFields, ['sleep']);

const privateProjection = buildHealthReceiptProjection(normalizeHealthStore({ observations: [{
  observationId: 'private-health', observationDate: '2026-09-02', effectiveDate: '2026-09-03',
  source: 'daily_review', authority: 'explicit_user', confidence: 0.8, sleepHours: 7, energy: 4,
  symptoms: 'private symptoms', training: 'private training', nutrition: 'private nutrition', notes: 'private notes',
}] }), '2026-09-03');
const receipt = buildHealthIntakeReceipt(intake(), { action: 'process_fact' }, privateProjection);
assert.deepEqual(Object.keys(receipt.projection), [
  'status', 'availableCapacity', 'confidence', 'constraints', 'missingFields', 'conflictCount', 'sourceRefs',
]);
for (const privateField of ['symptoms', 'training', 'nutrition', 'notes', 'intervention']) {
  assert.equal(JSON.stringify(receipt).includes(privateField), false);
}

const storage = memoryStorage();
const calls = [];
const valid = intake();
const request = async (path, options = {}) => {
  calls.push({ path, options });
  if (path.startsWith('/system-candidates?')) return { intakes: [valid] };
  return { ok: true };
};
await consumeHealthDailyIntakes({ storage, request, now: () => new Date('2026-09-03T08:00:00.000Z') });
await consumeHealthDailyIntakes({ storage, request, now: () => new Date('2026-09-03T08:01:00.000Z') });
const stored = JSON.parse(storage.getItem(HEALTH_STORAGE_KEY));
assert.equal(stored.observations.length, 1, 'the same intake revision creates one local Observation');
assert.equal(calls.filter((item) => item.path === '/health/observations/batch').length, 1, 'the same intake revision has no repeated Observation side effect');
const observation = stored.observations[0];
assert.equal(observation.observationId, 'health-daily-intake:health-intake-2026-09-02:r1');
assert.equal(observation.observationDate, '2026-09-02');
assert.equal(observation.effectiveDate, '2026-09-03');
assert.equal(observation.authority, 'explicit_user');

const revisionTwo = intake({ revision: 2, idempotencyKey: 'daily-review:health:2026-09-03:r2', data: { energy: 3 } });
await consumeHealthDailyIntakes({
  storage,
  request: async (path) => path.startsWith('/system-candidates?') ? { intakes: [revisionTwo] } : { ok: true },
});
assert.equal(JSON.parse(storage.getItem(HEALTH_STORAGE_KEY)).observations.length, 2, 'a new revision is processed independently');

const unsafeStorage = memoryStorage();
const unsafeCalls = [];
await consumeHealthDailyIntakes({
  storage: unsafeStorage,
  request: async (path, options = {}) => {
    unsafeCalls.push({ path, options });
    if (path.startsWith('/system-candidates?')) return { intakes: [intake({ data: { conflicts: ['source conflict'] } })] };
    return { ok: true };
  },
});
assert.equal(unsafeStorage.getItem(HEALTH_STORAGE_KEY), null, 'conflicting input never becomes a formal Observation');
assert.equal(unsafeCalls.some((item) => item.path === '/health/observations/batch'), false);
const conflictReceipt = JSON.parse(unsafeCalls.find((item) => item.path.endsWith('/receipt')).options.body);
assert.equal(conflictReceipt.status, 'processed');
assert.equal(conflictReceipt.projection.status, 'unknown');
assert.equal(conflictReceipt.projection.availableCapacity, null);
assert.equal(conflictReceipt.projection.conflictCount, 1);

const rejectedInputs = [
  intake({ id: 'bad-contract', contractVersion: '2026-09-02' }),
  intake({ id: 'bad-date', data: { observationDate: '2026-09-01' } }),
  intake({ id: 'ai-only', data: { authority: 'ai_summary' } }),
];
const rejectedCalls = [];
await consumeHealthDailyIntakes({
  storage: memoryStorage(),
  request: async (path, options = {}) => {
    rejectedCalls.push({ path, options });
    if (path.startsWith('/system-candidates?')) return { intakes: rejectedInputs };
    return { ok: true };
  },
});
assert.equal(rejectedCalls.some((item) => item.path === '/health/observations/batch'), false, 'invalid or AI-only intake never writes a health fact');
assert.deepEqual(
  rejectedCalls.filter((item) => item.path.endsWith('/receipt')).map((item) => JSON.parse(item.options.body).status),
  ['failed', 'failed', 'ignored'],
);

const retryStorage = memoryStorage();
let receiptFailures = 0;
let observationWrites = 0;
const retryRequest = async (path) => {
  if (path.startsWith('/system-candidates?')) return { intakes: [valid] };
  if (path === '/health/observations/batch') { observationWrites += 1; return { ok: true }; }
  if (path.endsWith('/receipt') && receiptFailures < 2) { receiptFailures += 1; throw new Error('receipt unavailable'); }
  return { ok: true };
};
const firstRetry = await consumeHealthDailyIntakes({ storage: retryStorage, request: retryRequest, now: () => new Date('2026-09-03T08:00:00.000Z') });
assert.equal(firstRetry.results[0].action, 'retrying');
await consumeHealthDailyIntakes({ storage: retryStorage, request: retryRequest, now: () => new Date('2026-09-03T08:20:00.000Z') });
assert.equal(observationWrites, 1, 'receipt retry uses the stable local Observation and does not repeat its side effect');

const preservedStore = JSON.stringify(normalizeHealthStore({ observations: [{
  observationId: 'existing', observationDate: '2026-09-01', source: 'manual', sleepHours: 8, energy: 4,
}] }));
const getFailureStorage = memoryStorage({ [HEALTH_STORAGE_KEY]: preservedStore });
await assert.rejects(
  consumeHealthDailyIntakes({ storage: getFailureStorage, request: async () => { throw new Error('network unavailable'); } }),
  /network unavailable/,
);
assert.equal(getFailureStorage.getItem(HEALTH_STORAGE_KEY), preservedStore, 'GET failure leaves the local health store unchanged');

const failedReceipt = buildHealthIntakeReceipt(intake(), {
  action: 'failed', reason: 'unsupported', errorCode: 'unsupported_contract_version',
}, missingProjection);
const processedReceipt = buildHealthIntakeReceipt(intake(), { action: 'process_fact' }, privateProjection);
assert.notEqual(failedReceipt.idempotencyKey, processedReceipt.idempotencyKey, 'receipt transitions use a new stable key');
assert.equal(failedReceipt.idempotencyKey, buildHealthIntakeReceipt(intake(), {
  action: 'failed', reason: 'unsupported', errorCode: 'unsupported_contract_version',
}, missingProjection).idempotencyKey, 'the same receipt body replays with the same key');

console.log('health daily intake tests passed');
