import assert from 'node:assert/strict';
import {
  buildDailyHealthReading,
  buildHealthProtocolSnapshot,
  buildHealthHqSnapshot,
  buildHealthTrend,
  calculateHealthBaseline,
  calculatePersonalBaseline,
  addSingleVariableIntervention,
  deriveHealthAssessment,
  deriveHealthDrivingPlan,
  deriveHealthState,
  importHealthCandidates,
  inferEnergyScore,
  normalizeHealthStore,
  resolveHealthCandidate,
} from '../js/health-model.js';
import { decideHealthCandidate, publishHealthSnapshot, readHealthProtocolStore } from '../js/health-store.js';

assert.equal(deriveHealthState({}).state, 'unknown');
assert.equal(deriveHealthState({ sleepHours: 7.5, energy: 4 }).state, 'green');
assert.deepEqual(deriveHealthState({ sleepHours: 5, energy: 2 }).availableCapacity, 0.6);
assert.equal(deriveHealthState({ sleepHours: 8, energy: 5, riskLevel: 'professional' }).state, 'red');
assert.equal(inferEnergyScore('中等偏好'), 4);
assert.equal(inferEnergyScore('中等偏低'), 2);
assert.equal(inferEnergyScore('可出门工作，但作息仍在调整'), null);

const inferredEnergy = normalizeHealthStore({ observations: [{
  observationDate: '2026-08-22', effectiveDate: '2026-08-23', source: 'daily_review',
  sleepHours: 7, energyText: '中等偏好',
}] }).observations[0];
assert.equal(inferredEnergy.energy, 4);
assert.equal(inferredEnergy.energyText, '中等偏好');
assert.equal(inferredEnergy.energyScoreSource, 'qualitative_mapping');
assert.equal(deriveHealthDrivingPlan([inferredEnergy], '2026-08-23').state, 'green');
assert.equal(normalizeHealthStore({ observations: [{
  observationDate: '2026-08-22', source: 'daily_review', energy: 4,
  energyText: '中等偏好', energyScoreSource: 'qualitative_mapping',
}] }).observations[0].energyScoreSource, 'qualitative_mapping', 'server-side qualitative scoring provenance must survive client normalization');

const baseline = calculateHealthBaseline([
  { date: '2026-08-08', sleepHours: 6, energy: 3 },
  { date: '2026-08-09', sleepHours: 8, energy: 5 },
]);
assert.deepEqual(baseline, { sampleDays: 2, averageSleep: 7, averageEnergy: 4 });

const migrated = normalizeHealthStore({ observations: [{ date: '2026-08-09', sleepHours: 8, energy: 4 }] });
assert.equal(migrated.schemaVersion, 3);
assert.equal(migrated.observations.length, 1);
assert.deepEqual(migrated.candidates, []);
assert.equal(migrated.observations[0].source, 'manual');
assert.equal(migrated.observations[0].confidence, 0.8);

const conflicting = [
  { date: '2026-08-09', source: 'manual', sleepHours: 8, energy: 4, confidence: 0.8 },
  { date: '2026-08-09', source: 'wearable', sleepHours: 5.5, energy: 2, confidence: 0.9 },
];
assert.equal(buildDailyHealthReading(conflicting, '2026-08-09').conflicts.length, 2);
assert.equal(deriveHealthAssessment(conflicting, '2026-08-09').state, 'unknown');
assert.equal(deriveHealthAssessment([
  ...conflicting,
  { date: '2026-08-09', source: 'medical_record', riskLevel: 'professional' },
], '2026-08-09').state, 'red', 'explicit professional concern wins over source conflict');

const stableBaseline = ['01', '02', '03', '04', '05'].map((day) => ({
  date: `2026-08-${day}`,
  source: 'manual',
  sleepHours: 8,
  energy: 5,
}));
assert.equal(calculatePersonalBaseline(stableBaseline).ready, true);
const consecutiveDeviation = [
  ...stableBaseline,
  { date: '2026-08-06', source: 'manual', sleepHours: 6.5, energy: 3 },
  { date: '2026-08-07', source: 'manual', sleepHours: 6.5, energy: 3 },
];
const trendAssessment = deriveHealthAssessment(consecutiveDeviation, '2026-08-07');
assert.equal(trendAssessment.state, 'yellow');
assert.match(trendAssessment.reasons.join(''), /连续两次偏离个人基线/);
assert.equal(deriveHealthAssessment([{ date: '2026-08-09', source: 'manual', sleepHours: 8 }], '2026-08-09').state, 'unknown');

const nextDayPlan = deriveHealthDrivingPlan([{
  observationId: 'daily-review-health:2026-08-09', observationDate: '2026-08-09', effectiveDate: '2026-08-10',
  reviewDate: '2026-08-09', source: 'daily_review', sleepHours: 5.5, energy: 2, riskLevel: 'none', constraint: '保留午休',
}], '2026-08-10');
assert.equal(nextDayPlan.basisDate, '2026-08-09');
assert.equal(nextDayPlan.basisSource, 'daily_review');
assert.equal(nextDayPlan.state, 'yellow');
assert.equal(nextDayPlan.freshness, 'current');
const morningOverride = deriveHealthDrivingPlan([
  nextDayPlan.basisObservation,
  { observationId: 'manual-2026-08-10', date: '2026-08-10', source: 'manual', sleepHours: 8, energy: 4, riskLevel: 'professional' },
], '2026-08-10');
assert.equal(morningOverride.basisDate, '2026-08-10', 'fresh explicit morning risk overrides the prior review baseline');
assert.equal(morningOverride.state, 'red');
assert.equal(deriveHealthDrivingPlan([], '2026-08-10').state, 'unknown');

const candidateRecords = [
  {
    claimId: 'claim-health-exact', candidateLineId: 'cl-health-exact', domain: 'health', recordType: 'observation',
    sourceExcerpt: '明确活动日的日省健康候选原文', sourceRef: '/daily/2026-08-08.md#L10', authority: 'user_interpretation',
    epistemicState: 'asserted', activity: { activityStart: '2026-08-08', activityEnd: '2026-08-08', dateMapping: 'next-day', sequenceEligible: true },
    sequenceEligible: true,
  },
  {
    claimId: 'claim-health-unknown', candidateLineId: 'cl-health-unknown', domain: 'health', recordType: 'claim',
    content: '日期未知的日省健康候选原文', sourceRef: '/daily/unknown.md#L20', authority: 'ai_summary',
    epistemicState: 'uncertain', activity: { activityStart: null, activityEnd: null, dateMapping: 'unknown', sequenceEligible: false },
    sequenceEligible: false,
  },
  {
    claimId: 'claim-health-range', candidateLineId: 'cl-health-range', domain: 'health', recordType: 'claim',
    content: '日期范围候选原文', sourceRef: '/daily/range.md#L30', authority: 'user_interpretation',
    epistemicState: 'asserted', activity: { activityStart: '2026-08-01', activityEnd: '2026-08-03', dateMapping: 'range', sequenceEligible: false },
    sequenceEligible: false,
  },
  {
    claimId: 'claim-health-dismiss', candidateLineId: 'cl-health-dismiss', domain: 'health', recordType: 'claim',
    content: '用户决定忽略的候选原文', sourceRef: '/daily/dismiss.md#L40', authority: 'ai_summary',
    epistemicState: 'uncertain', activity: { activityStart: '2026-08-08', activityEnd: '2026-08-08', dateMapping: 'same-day', sequenceEligible: true },
    sequenceEligible: true,
  },
  { claimId: 'claim-time-ignore', domain: 'time', content: '其他域不得导入', sourceRef: '/daily/time.md#L1' },
];
const inbox = importHealthCandidates({}, candidateRecords, '2026-08-10T08:00:00.000Z');
assert.equal(inbox.candidates.length, 4);
assert.equal(inbox.observations.length, 0, 'unconfirmed candidates never become observations');
assert.equal(inbox.candidates.find((item) => item.candidateId === 'claim-health-exact').temporalEligible, true);
assert.equal(inbox.candidates.find((item) => item.candidateId === 'claim-health-unknown').temporalEligible, false);
assert.equal(inbox.candidates.find((item) => item.candidateId === 'claim-health-range').temporalEligible, false);
assert.equal(importHealthCandidates(inbox, candidateRecords, '2026-08-10T09:00:00.000Z').candidates.length, 4, 'candidate import is idempotent');

assert.strictEqual(
  resolveHealthCandidate(inbox, 'claim-health-exact', 'confirm'),
  inbox,
  'omitted authority must not change the store or create an Observation',
);
assert.strictEqual(
  resolveHealthCandidate(inbox, 'claim-health-exact', 'confirm', { sourceAuthority: 'ai_derived' }),
  inbox,
  'AI-derived authority must not change the store or create an Observation',
);
assert.strictEqual(
  resolveHealthCandidate(inbox, 'claim-health-exact', 'confirm', { sourceAuthority: 'administrator' }),
  inbox,
  'illegal authority must not change the store or create an Observation',
);
assert.strictEqual(
  decideHealthCandidate(inbox, 'claim-health-exact', 'confirm'),
  inbox,
  'store wrapper must preserve the model authorization gate',
);
assert.equal(inbox.observations.length, 0);
assert.equal(inbox.candidates.find((item) => item.candidateId === 'claim-health-exact').status, 'pending');
assert.equal(inbox.candidates.find((item) => item.candidateId === 'claim-health-exact').resolvedBy, null);

const withConfirmedObservation = decideHealthCandidate(inbox, 'claim-health-exact', 'confirm', {
  sourceAuthority: 'explicit_user',
  resolvedAt: '2026-08-10T09:00:00.000Z',
  decisionId: 'decision-health-exact',
});
assert.equal(withConfirmedObservation.observations.length, 1);
assert.equal(withConfirmedObservation.observations[0].source, 'daily_review');
assert.equal(withConfirmedObservation.observations[0].date, '2026-08-08');
assert.equal(withConfirmedObservation.candidates.find((item) => item.candidateId === 'claim-health-exact').status, 'confirmed');
assert.equal(withConfirmedObservation.candidates.find((item) => item.candidateId === 'claim-health-exact').resolvedBy, 'explicit_user');
assert.equal(withConfirmedObservation.candidates.find((item) => item.candidateId === 'claim-health-exact').resolvedAt, '2026-08-10T09:00:00.000Z');
assert.equal(withConfirmedObservation.candidates.find((item) => item.candidateId === 'claim-health-exact').decisionId, 'decision-health-exact');
const withUnknownContext = resolveHealthCandidate(withConfirmedObservation, 'claim-health-unknown', 'confirm', {
  sourceAuthority: 'explicit_user', resolvedAt: '2026-08-10T09:01:00.000Z',
});
const withRangeContext = resolveHealthCandidate(withUnknownContext, 'claim-health-range', 'confirm', {
  sourceAuthority: 'explicit_user', resolvedAt: '2026-08-10T09:02:00.000Z',
});
assert.equal(withRangeContext.observations.length, 1, 'unknown and range candidates remain outside Observation');
assert.equal(withRangeContext.candidates.find((item) => item.candidateId === 'claim-health-unknown').status, 'context_only');
assert.equal(withRangeContext.candidates.find((item) => item.candidateId === 'claim-health-range').status, 'context_only');
assert.equal(withRangeContext.candidates.find((item) => item.candidateId === 'claim-health-unknown').resolvedBy, 'explicit_user');
assert.equal(withRangeContext.candidates.find((item) => item.candidateId === 'claim-health-range').resolvedBy, 'explicit_user');
assert.match(withRangeContext.candidates.find((item) => item.candidateId === 'claim-health-range').decisionId, /context_only$/);
assert.deepEqual(buildHealthTrend(withRangeContext.observations).map((item) => item.date), ['2026-08-08']);

const withDismissedCandidate = resolveHealthCandidate(withRangeContext, 'claim-health-dismiss', 'dismiss', {
  sourceAuthority: 'explicit_user', resolvedAt: '2026-08-10T09:03:00.000Z', decisionId: 'decision-health-dismiss',
});
const dismissedCandidate = withDismissedCandidate.candidates.find((item) => item.candidateId === 'claim-health-dismiss');
assert.equal(dismissedCandidate.status, 'dismissed');
assert.equal(dismissedCandidate.resolvedBy, 'explicit_user');
assert.equal(dismissedCandidate.resolvedAt, '2026-08-10T09:03:00.000Z');
assert.equal(dismissedCandidate.decisionId, 'decision-health-dismiss');
assert.equal(withDismissedCandidate.observations.length, 1);
const reimportedAfterDecisions = importHealthCandidates(withDismissedCandidate, candidateRecords, '2026-08-10T10:00:00.000Z');
assert.equal(reimportedAfterDecisions.candidates.find((item) => item.candidateId === 'claim-health-exact').resolvedBy, 'explicit_user');
assert.equal(reimportedAfterDecisions.candidates.find((item) => item.candidateId === 'claim-health-dismiss').decisionId, 'decision-health-dismiss');

const firstIntervention = addSingleVariableIntervention({}, {
  id: 'intervention-single-1', primaryVariable: '入睡时间', targetDeviation: '睡眠不足', action: '提前结束工作',
  evaluationAt: '2026-08-12', successCondition: '睡眠增加', stopCondition: '负担增加', status: 'active',
});
assert.equal(firstIntervention.started, true);
const blockedIntervention = addSingleVariableIntervention(firstIntervention.store, {
  id: 'intervention-single-2', primaryVariable: '训练量', targetDeviation: '恢复不足', action: '降低训练量',
});
assert.equal(blockedIntervention.started, false, 'only one primary intervention variable may be active');

const protocolStoreInput = normalizeHealthStore({
  observations: [{
    date: '2026-08-09', source: 'manual', sleepHours: 5.5, energy: 2,
    symptoms: 'private symptom text', notes: 'private note text',
  }],
  interventions: [{
    id: 'intervention-1', action: '提前停止夜间工作', targetDeviation: '恢复不足',
    evaluationAt: '2026-08-12', successCondition: '精力恢复', stopCondition: '状态变差', status: 'active',
  }],
});
const snapshot = buildHealthProtocolSnapshot(protocolStoreInput, '2026-08-09', '2026-08-09T10:00:00.000Z');
assert.equal(snapshot.healthState.state, 'yellow');
assert.equal(snapshot.timeSystem.availableCapacity, 0.6);
assert.equal(snapshot.timeSystem.privacy, 'capacity_and_constraints_only');
assert.equal(snapshot.dailyReview.privacy, 'minimum_health_snapshot');
assert.equal(snapshot.boundaries.createsTasks, false);
assert.equal(snapshot.boundaries.writesCalendar, false);
assert.equal(JSON.stringify(snapshot).includes('private symptom text'), false);
assert.equal(JSON.stringify(snapshot).includes('private note text'), false);
assert.equal(JSON.stringify(snapshot).includes('提前停止夜间工作'), false, 'intervention action is not projected downstream');
const snapshotSameContent = buildHealthProtocolSnapshot(protocolStoreInput, '2026-08-09', '2026-08-09T11:00:00.000Z');
assert.equal(snapshotSameContent.snapshotId, snapshot.snapshotId, 'snapshot id is stable for same-day same-content publication');

const missingHq = buildHealthHqSnapshot({});
assert.equal(missingHq.status, 'unknown');
assert.equal(missingHq.summary.state, 'unknown');
const freshHq = buildHealthHqSnapshot({ latest: snapshot }, { now: new Date('2026-08-09T12:00:00.000Z') });
assert.equal(freshHq.systemId, 'health');
assert.equal(freshHq.schemaVersion, 1);
assert.equal(freshHq.status, 'attention');
assert.equal(freshHq.summary.availableCapacity, 0.6);
assert.equal(JSON.stringify(freshHq).includes('private symptom text'), false);
assert.equal(JSON.stringify(freshHq).includes('private note text'), false);
const staleHq = buildHealthHqSnapshot({ latest: snapshot }, { now: new Date('2026-08-11T00:00:01.000Z') });
assert.equal(staleHq.status, 'stale');
const conflictPublished = buildHealthProtocolSnapshot(normalizeHealthStore({ observations: conflicting }), '2026-08-09', '2026-08-09T10:00:00.000Z');
const conflictHq = buildHealthHqSnapshot({ latest: conflictPublished }, { now: new Date('2026-08-09T12:00:00.000Z') });
assert.equal(conflictHq.status, 'unknown');
assert.equal(conflictHq.summary.state, 'unknown');
assert.equal(conflictHq.summary.availableCapacity, null);
assert.equal(conflictHq.summary.conflictCount, 2);

const memory = new Map();
const storage = {
  getItem: (key) => memory.get(key) ?? null,
  setItem: (key, value) => memory.set(key, value),
};
publishHealthSnapshot(protocolStoreInput, '2026-08-09', storage, '2026-08-09T10:00:00.000Z');
publishHealthSnapshot(protocolStoreInput, '2026-08-09', storage, '2026-08-09T11:00:00.000Z');
let protocolStore = readHealthProtocolStore(storage);
assert.equal(protocolStore.outbox.length, 1, 'same-day same-content publication is not duplicated');
assert.equal(protocolStore.latest.publishedAt, '2026-08-09T10:00:00.000Z', 'idempotent retry preserves the original publication');
assert.equal(protocolStore.outbox[0].deliveryStatus, 'local_pending');

const changedProtocolInput = normalizeHealthStore({
  ...protocolStoreInput,
  observations: [{ date: '2026-08-09', source: 'manual', sleepHours: 8, energy: 5 }],
});
publishHealthSnapshot(changedProtocolInput, '2026-08-09', storage, '2026-08-09T12:00:00.000Z');
protocolStore = readHealthProtocolStore(storage);
assert.equal(protocolStore.outbox.length, 2, 'changed minimum projection creates a new outbox item');
assert.equal(protocolStore.latest.healthState.state, 'green');

console.log('health model tests passed');
