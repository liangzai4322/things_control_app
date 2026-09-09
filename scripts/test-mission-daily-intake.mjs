import assert from 'node:assert/strict';
import {
  MISSION_DAILY_INTAKE_RESULTS,
  MISSION_DAILY_INTAKE_STORAGE_KEY,
  classifyMissionDailyIntake,
  consumeMissionDailyIntakes,
  prepareMissionDailyIntakeReceipt,
  readMissionDailyIntakeLedger,
  validateMissionDailyIntake,
} from '../js/mission-daily-intake.js';
import { MISSION_STORAGE_KEY, publishMissionVersion } from '../js/mission-model.js';
import { MISSION_SYNC_STORAGE_KEY } from '../js/mission-store.js';

class MemoryStorage {
  constructor(entries = {}) { this.map = new Map(Object.entries(entries)); }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null; }
  setItem(key, value) { this.map.set(key, String(value)); }
  removeItem(key) { this.map.delete(key); }
}

const now = new Date('2026-09-03T12:00:00.000Z');
const draft = {
  missionId: 'mission-intake-test', statement: '建立可持续的人生经营系统',
  campaign: {
    campaignId: 'campaign-intake-test', title: '验证使命连续性', whyNow: '避免把日省观察误当战略事实',
    successConditions: ['回执幂等'], exitConditions: ['正式使命被自动改写'], reviewAt: '2026-09-30',
  },
  portfolio: {}, constraints: ['不自动发布'], nonNegotiables: [], notDoing: [],
};
const published = publishMissionVersion({ draft }, [], { sourceAuthority: 'explicit_user', now: new Date('2026-09-01T08:00:00.000Z') }).store;
const withPendingDraft = { ...published, draft: { ...published.draft, statement: '这段未发布草稿绝不能进入正式投影' } };

function intake(overrides = {}) {
  const base = {
    id: 'daily-review:2026-09-03:mission', schemaVersion: 1, contractVersion: '2026-09-03.1', systemId: 'mission',
    reviewDate: '2026-09-03', observationPeriod: { activity_start: '2026-09-03', activity_end: '2026-09-03' },
    sourceRef: 'daily-review:2026-09-03', evidenceRefs: ['task:42'], freshness: 'current', revision: 1,
    idempotencyKey: 'daily-review:2026-09-03:mission', status: 'received', receivedAt: '2026-09-03T11:00:00.000Z', updatedAt: '2026-09-03T11:00:00.000Z',
    data: {
      schemaVersion: 'daily-mission-intake-v1', intakeId: 'daily-review:2026-09-03:mission', idempotencyKey: 'daily-review:2026-09-03:mission',
      sourceSystem: 'daily-review', targetSystem: 'mission', reviewDate: '2026-09-03', generatedAt: '2026-09-03T11:00:00.000Z',
      sourceAuthority: 'ai_derived', epistemicState: 'candidate_unvalidated', writesTargetSystem: false,
      baseline: { activeVersionId: 'mission-intake-test:v1', activeVersionObservedAt: '2026-09-03T10:55:00.000Z', campaignId: 'campaign-intake-test', campaignTitle: '验证使命连续性', campaignReviewAt: '2026-09-30', baselineState: 'known' },
      observedProgress: { campaignAssessment: 'on_track', assessmentIsFormalStatus: false, progressSummary: '今天出现一条值得继续观察的进展', milestoneChanges: [], commitmentResults: [], deviationSignals: [] },
      evidenceCoverage: { windowStart: '2026-09-03', windowEnd: '2026-09-03', taskboxAsOf: '2026-09-03T10:00:00.000Z', timeEvidenceAsOf: null, dailyReviewCompletedAt: '2026-09-03T11:00:00.000Z', freshness: 'current', missingSources: [] },
      evidenceRefs: ['task:42'], conditional: {},
    },
  };
  return { ...base, ...overrides, data: { ...base.data, ...(overrides.data || {}) } };
}

assert.deepEqual(validateMissionDailyIntake(intake(), { now }).errors, []);
assert.equal(classifyMissionDailyIntake(intake(), published, { now }).result, MISSION_DAILY_INTAKE_RESULTS.CANDIDATE_RECORDED);
assert.equal(classifyMissionDailyIntake(intake({ data: { observedProgress: { campaignAssessment: 'unknown', assessmentIsFormalStatus: false, progressSummary: null, milestoneChanges: [], commitmentResults: [], deviationSignals: [] }, evidenceRefs: [] } }), published, { now }).result, MISSION_DAILY_INTAKE_RESULTS.NO_CHANGE);
assert.equal(classifyMissionDailyIntake(intake({ data: { observedProgress: { campaignAssessment: 'blocked', assessmentIsFormalStatus: false, progressSummary: '存在阻塞', milestoneChanges: [], commitmentResults: [], deviationSignals: [{ signalId: 'signal:1' }] } } }), published, { now }).result, MISSION_DAILY_INTAKE_RESULTS.NEEDS_DECISION);
assert.equal(classifyMissionDailyIntake(intake({ data: { baseline: { ...intake().data.baseline, activeVersionId: 'mission-intake-test:v0' } } }), published, { now }).result, MISSION_DAILY_INTAKE_RESULTS.SYNC_CONFLICT);
assert.equal(classifyMissionDailyIntake(intake({ data: { baseline: { ...intake().data.baseline, baselineState: 'unknown', activeVersionId: null } } }), published, { now }).result, MISSION_DAILY_INTAKE_RESULTS.SYNC_CONFLICT);
assert.equal(classifyMissionDailyIntake(intake({ freshness: { status: 'stale', generatedAt: '2026-09-03T11:00:00.000Z' } }), published, { now }).result, MISSION_DAILY_INTAKE_RESULTS.INVALID);
assert.equal(classifyMissionDailyIntake(intake({ contractVersion: 'future-version' }), published, { now }).result, MISSION_DAILY_INTAKE_RESULTS.INVALID);

const productionShape = intake({
  id: 'transport-generated-id',
  idempotencyKey: 'mission:2026-09-03:1:producerhash',
  freshness: '2026-09-03T11:00:00.000Z',
  data: {
    schemaVersion: undefined, intakeId: undefined, idempotencyKey: undefined, sourceSystem: undefined, targetSystem: undefined,
    generatedAt: undefined, epistemicState: undefined, writesTargetSystem: undefined, baseline: undefined,
    observedProgress: undefined, evidenceCoverage: undefined, evidenceRefs: undefined,
    reviewDate: '2026-09-03', activeVersion: { versionId: 'mission-intake-test:v1' },
    campaignAssessment: 'on_track', directionConflict: null, decisionRequest: null,
  },
});
assert.equal(classifyMissionDailyIntake(productionShape, published, { now }).result, MISSION_DAILY_INTAKE_RESULTS.CANDIDATE_RECORDED, 'the frozen producer contract is accepted without requiring richer optional domain fields');
const unsupported = prepareMissionDailyIntakeReceipt(intake({ contractVersion: 'future-version' }), published, { schemaVersion: 1, entries: {} }, { now });
assert.equal(unsupported.classified.result, 'invalid');
assert.equal(unsupported.body.status, 'ignored', 'unknown transport versions are acknowledged without domain side effects');

const storage = new MemoryStorage({ [MISSION_STORAGE_KEY]: JSON.stringify(withPendingDraft) });
const missionBefore = storage.getItem(MISSION_STORAGE_KEY);
const requests = [];
const mockRequest = async (path, options = {}) => {
  requests.push({ path, options });
  if (!options.method) return { intakes: [intake()] };
  return { ok: true };
};
const first = await consumeMissionDailyIntakes({ request: mockRequest, storage, now });
assert.equal(first.processed[0].result, 'candidate_recorded');
assert.equal(first.decisionRequiredCount, 0);
assert.equal(storage.getItem(MISSION_STORAGE_KEY), missionBefore, 'daily intake must not mutate the mission store');
assert.ok(storage.getItem(MISSION_DAILY_INTAKE_STORAGE_KEY), 'consumer keeps a separate local processing ledger');
assert.equal(requests[0].path, '/system-candidates?systemId=mission&intake=1&limit=100');
assert.equal(requests[1].path, '/system-candidates/daily-review%3A2026-09-03%3Amission/receipt');
const firstBody = JSON.parse(requests[1].options.body);
assert.equal(firstBody.status, 'processed');
assert.equal(firstBody.projection.intakeReceipt.result, 'candidate_recorded');
assert.equal(firstBody.projection.activeVersion.statement, published.draft.statement);
assert.equal(firstBody.projection.pending.hasPendingDraft, true);
assert.deepEqual(firstBody.projection.pending.pendingDiffFields, ['statement']);
assert.equal(firstBody.projection.pending.decisionRequiredCount, 0);
assert.equal('draft' in firstBody.projection, false);
assert.equal('history' in firstBody.projection, false);
assert.equal('events' in firstBody.projection, false);
assert.doesNotMatch(JSON.stringify(firstBody.projection), /这段未发布草稿绝不能进入正式投影/);

await consumeMissionDailyIntakes({ request: mockRequest, storage, now: new Date('2026-09-03T12:05:00.000Z') });
const replayBody = JSON.parse(requests[3].options.body);
assert.deepEqual(replayBody, firstBody, 'receipt replay must preserve the same key and body hash');

const replayLedger = readMissionDailyIntakeLedger(storage);
const replayWithTransportState = prepareMissionDailyIntakeReceipt(intake({ status: 'retrying', updatedAt: '2026-09-03T12:06:00.000Z', receipt: { status: 'retrying' } }), withPendingDraft, replayLedger, { storage, now });
assert.equal(replayWithTransportState.replay, true, 'server-owned receipt status and timestamps do not change the immutable intake revision');
assert.deepEqual(replayWithTransportState.body, firstBody);

const conflictStorage = new MemoryStorage({
  [MISSION_STORAGE_KEY]: JSON.stringify(published),
  [MISSION_SYNC_STORAGE_KEY]: JSON.stringify({ status: 'conflict' }),
});
const conflictPrepared = prepareMissionDailyIntakeReceipt(intake(), published, readMissionDailyIntakeLedger(conflictStorage), { storage: conflictStorage, now });
assert.equal(conflictPrepared.body.status, 'retrying');
assert.equal(conflictPrepared.body.projection.intakeReceipt.result, 'sync_conflict');
assert.equal(conflictPrepared.body.projection.pending.decisionRequiredCount, 1);

let receiptAttempts = 0;
const receipt409 = async (_path, options = {}) => {
  if (!options.method) return { intakes: [intake()] };
  receiptAttempts += 1;
  const error = new Error('api_409'); error.status = 409; throw error;
};
const storage409 = new MemoryStorage({ [MISSION_STORAGE_KEY]: JSON.stringify(published) });
const result409 = await consumeMissionDailyIntakes({ request: receipt409, storage: storage409, now });
assert.equal(receiptAttempts, 1, '409 must not trigger force overwrite or an automatic second POST');
assert.equal(result409.processed[0].result, 'sync_conflict');
assert.equal(result409.decisionRequiredCount, 1);

const changedStorage = new MemoryStorage({ [MISSION_STORAGE_KEY]: JSON.stringify(published) });
let changedPosts = 0;
let returned = intake();
const changedRequest = async (_path, options = {}) => {
  if (!options.method) return { intakes: [returned] };
  changedPosts += 1; return { ok: true };
};
await consumeMissionDailyIntakes({ request: changedRequest, storage: changedStorage, now });
returned = intake({ data: { observedProgress: { ...intake().data.observedProgress, progressSummary: '同一revision却改变了载荷' } } });
const changedResult = await consumeMissionDailyIntakes({ request: changedRequest, storage: changedStorage, now });
assert.equal(changedPosts, 1, 'same revision with a changed payload is quarantined without a conflicting receipt write');
assert.equal(changedResult.processed[0].result, 'sync_conflict');

console.log('mission daily intake consumer tests passed');
