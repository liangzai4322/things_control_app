import assert from 'node:assert/strict';
import {
  buildHqActionState,
  buildHqProjectHealth,
  describeHqSyncState,
  freezeHqStrategicCommitmentSnapshot,
  hqReviewDateKey,
  mergeHqCacheDate,
  normalizeHqBrief,
  normalizePeriodSnapshot,
  normalizeReviewStatus,
  readHqCacheDate,
  reconcileHqSnapshotCommitments,
  resolveHqOutcomeTask,
  resolveTaskCommandContext,
  selectHqCommitments,
} from '../js/hq-model.js';

const reviewDate = '2026-07-30';
const tasks = [
  { id: 'main', content: '完成 MVP', pinLevel: 1, commitmentRole: 'primary', commitmentDate: reviewDate },
  { id: 'maintenance-a', content: '回复客户', pinLevel: 2 },
  { id: 'maintenance-b', content: '运动', pinLevel: 3 },
  { id: 'done', content: '已完成', pinLevel: 1, isCompleted: true },
];

const normalized = normalizeHqBrief({
  primaryTaskId: 'main',
  maintenanceTaskIds: ['maintenance-a', 'maintenance-a', 'maintenance-b', 'overflow'],
}, reviewDate);
assert.equal(normalized.reviewDate, reviewDate);
assert.deepEqual(normalized.maintenanceTaskIds, ['maintenance-a', 'maintenance-b']);
assert.equal(normalized.strategicCommitmentTaskId, 'main');
assert.equal(normalized.currentActionTaskId, 'main');
assert.deepEqual(normalized.candidateState, { dismissals: {}, accepted: [] });

const authoritativeClear = normalizeHqBrief({
  primaryTaskId: null,
  strategicCommitmentTaskId: 'stale-primary',
  strategicCommitmentSnapshot: { taskId: 'stale-primary', content: '旧承诺' },
  currentActionTaskId: 'stale-action',
}, reviewDate);
assert.equal(authoritativeClear.primaryTaskId, null);
assert.equal(authoritativeClear.strategicCommitmentTaskId, null);
assert.equal(authoritativeClear.strategicCommitmentSnapshot, null);
assert.equal(authoritativeClear.currentActionTaskId, null);
const seatOnlyClear = normalizeHqBrief({
  primaryTaskId: 'main',
  strategicCommitmentTaskId: 'main',
  strategicCommitmentSnapshot: { taskId: 'main', content: '最初承诺' },
  currentActionTaskId: null,
}, reviewDate);
assert.equal(seatOnlyClear.strategicCommitmentTaskId, 'main');
assert.equal(seatOnlyClear.strategicCommitmentSnapshot.content, '最初承诺');
assert.equal(seatOnlyClear.currentActionTaskId, null);

assert.equal(hqReviewDateKey('2026-08-07T15:59:59.999Z'), '2026-08-07');
assert.equal(hqReviewDateKey('2026-08-07T16:00:00.000Z'), '2026-08-08');
assert.equal(hqReviewDateKey(), hqReviewDateKey(new Date()));
assert.equal(hqReviewDateKey(undefined), '');
assert.equal(hqReviewDateKey(null), '');
assert.equal(hqReviewDateKey(''), '');

const legacyCache = {
  brief: { reviewDate, primaryTaskId: 'main' },
  decisions: [{ id: 'decision' }],
};
assert.equal(readHqCacheDate(legacyCache, reviewDate).brief.primaryTaskId, 'main');
assert.equal(readHqCacheDate(legacyCache, '2026-07-31').brief.primaryTaskId, null);
const scopedCache = mergeHqCacheDate(legacyCache, {
  brief: { reviewDate, primaryTaskId: 'main' },
}, reviewDate);
assert.equal(scopedCache.brief, undefined);
assert.equal(readHqCacheDate(scopedCache, reviewDate).brief.primaryTaskId, 'main');
assert.equal(readHqCacheDate(scopedCache, '2026-07-31').brief.primaryTaskId, null);
assert.deepEqual(readHqCacheDate(scopedCache, '2026-07-31').decisions, [{ id: 'decision' }]);
const partialBriefCache = mergeHqCacheDate(scopedCache, {
  brief: { reviewDate, currentActionTaskId: null, candidateState: { dismissals: { skipped: { until: '2026-07-30T12:00:00.000Z' } } } },
}, reviewDate);
const preservedStrategicBrief = readHqCacheDate(partialBriefCache, reviewDate).brief;
assert.equal(preservedStrategicBrief.strategicCommitmentTaskId, 'main');
assert.equal(preservedStrategicBrief.currentActionTaskId, null);
assert.ok(preservedStrategicBrief.candidateState.dismissals.skipped);
const clearedBriefCache = mergeHqCacheDate(partialBriefCache, { brief: { primaryTaskId: null } }, reviewDate);
assert.equal(readHqCacheDate(clearedBriefCache, reviewDate).brief.strategicCommitmentTaskId, null);

assert.equal(describeHqSyncState({ authBlocked: true, pendingCount: 2 }).label, '认证失效 · 2 项待同步');
assert.equal(describeHqSyncState({ deadLetterCount: 1 }).label, '同步失败 · 1 项需处理');
assert.equal(describeHqSyncState({ offline: true, status: 'pending', pendingCount: 3 }).label, '离线 · 本地事实 · 3 项待同步');
assert.equal(describeHqSyncState({ status: 'pending', pendingCount: 2 }).label, '2 项待同步');

const migratedBrief = freezeHqStrategicCommitmentSnapshot({
  primaryTaskId: 'main',
  updatedAt: '2026-07-30T08:00:00.000Z',
}, tasks, reviewDate);
assert.equal(migratedBrief.strategicCommitmentSnapshot.content, '完成 MVP');
assert.equal(migratedBrief.strategicCommitmentSnapshot.committedAt, '2026-07-30T08:00:00.000Z');

const commitments = selectHqCommitments(tasks, normalized, reviewDate);
assert.equal(commitments.primary.id, 'main');
assert.deepEqual(commitments.maintenance.map((task) => task.id), ['maintenance-a', 'maintenance-b']);

const activeActionState = buildHqActionState(tasks, normalized, reviewDate);
assert.equal(activeActionState.status, 'active');
assert.equal(activeActionState.strategicCommitment.id, 'main');
assert.equal(activeActionState.currentAction.id, 'main');
assert.deepEqual(activeActionState.outcomes, []);

const completedActionState = buildHqActionState([
  {
    id: 'main',
    content: '完成 MVP',
    isCompleted: true,
    completedAt: '2026-07-30T14:32:00.000Z',
    updatedAt: '2026-07-30T14:32:00.000Z',
    completionReceipt: { version: 1, sourceTaskId: 'main', note: '线上已发布' },
  },
], normalized, reviewDate);
assert.equal(completedActionState.status, 'awaiting_candidate');
assert.equal(completedActionState.currentAction, null);
assert.equal(completedActionState.outcomes[0].id, 'main');
assert.equal(completedActionState.outcomes[0].completionReceipt.note, '线上已发布');
assert.equal(completedActionState.outcomes[0].isStrategicCommitment, true);
const legacyCompletedWithoutTimestamp = buildHqActionState([{
  id: 'legacy-done',
  content: 'legacy completion',
  isCompleted: true,
}], {}, reviewDate);
assert.deepEqual(legacyCompletedWithoutTimestamp.outcomes, []);

const afterMidnightLocalActionState = buildHqActionState([{
  id: 'after-midnight',
  content: '凌晨完成',
  isCompleted: true,
  completedAt: '2026-07-29T16:30:00.000Z',
}], {}, reviewDate);
assert.equal(afterMidnightLocalActionState.outcomes[0].id, 'after-midnight');

const handoffActionState = buildHqActionState([
  { id: 'main', content: '完成 MVP', isCompleted: true, completedAt: '2026-07-30T10:00:00.000Z' },
  { id: 'handoff', content: '收集真实反馈', isCompleted: false },
], {
  primaryTaskId: 'main',
  strategicCommitmentTaskId: 'main',
  strategicCommitmentSnapshot: { taskId: 'main', content: '最初承诺文案', committedAt: '2026-07-30T08:00:00.000Z' },
  currentActionTaskId: 'handoff',
}, reviewDate);
assert.equal(handoffActionState.status, 'active');
assert.equal(handoffActionState.strategicCommitment.id, 'main');
assert.equal(handoffActionState.strategicCommitment.content, '最初承诺文案');
assert.equal(handoffActionState.currentAction.id, 'handoff');
const stillFrozenBrief = freezeHqStrategicCommitmentSnapshot({
  strategicCommitmentTaskId: 'main',
  strategicCommitmentSnapshot: { taskId: 'main', content: '最初承诺文案', committedAt: '2026-07-30T08:00:00.000Z' },
}, [{ id: 'main', content: '后来改名' }], reviewDate);
assert.equal(stillFrozenBrief.strategicCommitmentSnapshot.content, '最初承诺文案');

const explicitEmptySeat = buildHqActionState([
  { id: 'main', content: '完成 MVP', isCompleted: false, pinLevel: 1 },
], {
  primaryTaskId: 'main',
  strategicCommitmentTaskId: 'main',
  currentActionTaskId: null,
}, reviewDate);
assert.equal(explicitEmptySeat.status, 'seat_empty');
assert.equal(explicitEmptySeat.currentAction, null);

const deferredSeat = buildHqActionState([{
  id: 'deferred',
  content: '明天才释放',
  visibleAfter: '2999-01-01T00:00:00.000Z',
}], {
  strategicCommitmentTaskId: 'deferred',
  currentActionTaskId: 'deferred',
}, reviewDate);
assert.equal(deferredSeat.status, 'seat_empty');
assert.equal(deferredSeat.currentAction, null);

const pausedProjectSeat = buildHqActionState([{
  id: 'paused-project-task',
  content: '暂停项目任务',
  mainlineId: 'paused-project',
}], {
  strategicCommitmentTaskId: 'paused-project-task',
  currentActionTaskId: 'paused-project-task',
}, reviewDate, [{ id: 'paused-project', status: 'paused' }]);
assert.equal(pausedProjectSeat.status, 'seat_empty');
assert.equal(pausedProjectSeat.currentAction, null);

const staleRemoteSnapshot = {
  reviewDate,
  commitments: {
    primary: { id: 'main', content: '完成 MVP', isCompleted: false, updatedAt: '2026-07-30T09:00:00.000Z' },
    maintenance: [
      { id: 'maintenance-a', content: '回复客户', isCompleted: false, updatedAt: '2026-07-30T09:00:00.000Z' },
      { id: 'maintenance-b', content: '运动', isCompleted: false, updatedAt: '2026-07-30T09:00:00.000Z' },
    ],
  },
};
const reconciledStaleSnapshot = reconcileHqSnapshotCommitments(staleRemoteSnapshot, [
  { id: 'main', content: '完成 MVP', isCompleted: true, completedAt: '2026-07-30T10:00:00.000Z', updatedAt: '2026-07-30T10:00:00.000Z' },
  { id: 'maintenance-a', content: '回复客户', deleted: true, updatedAt: '2026-07-30T10:00:00.000Z' },
  { id: 'maintenance-b', content: '运动', isCompleted: false, updatedAt: '2026-07-30T10:00:00.000Z' },
]);
assert.equal(reconciledStaleSnapshot.commitments.primary, null);
assert.equal(reconciledStaleSnapshot.actionState.status, 'awaiting_candidate');
assert.equal(reconciledStaleSnapshot.actionState.outcomes[0].id, 'main');
assert.deepEqual(reconciledStaleSnapshot.commitments.maintenance.map((task) => task.id), ['maintenance-b']);
assert.equal(staleRemoteSnapshot.commitments.primary.isCompleted, false);

const reconciledNewerRemote = reconcileHqSnapshotCommitments({
  commitments: {
    primary: { id: 'main', content: '完成 MVP', isCompleted: false, updatedAt: '2026-07-30T11:00:00.000Z' },
    maintenance: [],
  },
}, [
  { id: 'main', content: '完成 MVP', isCompleted: true, updatedAt: '2026-07-30T10:00:00.000Z' },
]);
assert.equal(reconciledNewerRemote.commitments.primary.id, 'main');
assert.equal(reconciledNewerRemote.commitments.primary.isCompleted, false);

const reconciledEqualVersion = reconcileHqSnapshotCommitments({
  commitments: {
    primary: { id: 'main', content: '完成 MVP', isCompleted: false, updatedAt: '2026-07-30T10:00:00.000Z' },
    maintenance: [],
  },
}, [
  { id: 'main', content: '完成 MVP', isCompleted: true, updatedAt: '2026-07-30T10:00:00.000Z' },
]);
assert.equal(reconciledEqualVersion.commitments.primary, null);

const resolvedOutcome = resolveHqOutcomeTask({
  actionState: {
    outcomes: [{
      id: 'main',
      content: '完成 MVP',
      isCompleted: true,
      completionReceipt: { note: '远端最新完成证据' },
    }],
  },
}, [{ id: 'main', content: '完成 MVP', isCompleted: false }], 'main');
assert.equal(resolvedOutcome.isCompleted, true);
assert.equal(resolvedOutcome.completionReceipt.note, '远端最新完成证据');

const [project] = buildHqProjectHealth([
  { id: 'project', name: '人生参谋部', status: 'active', updatedAt: '2026-07-29T00:00:00.000Z' },
], [
  { id: 'next', mainlineId: 'project', content: '部署 MVP', createdAt: '2026-07-29T00:00:00.000Z', updatedAt: '2026-07-29T00:00:00.000Z' },
], new Date('2026-07-30T00:00:00.000Z'));
assert.equal(project.health, 'healthy');
assert.equal(project.nextAction.id, 'next');

const review = normalizeReviewStatus({
  status: 'synced',
  todayEvidence: { touched: 4, completed: 2, progress: 3 },
  history: [
    { date: '2026-07-28', state: 'completed' },
    { date: '2026-07-29', state: 'partial' },
    { date: '2026-07-30', state: 'missed' },
  ],
}, reviewDate);
assert.equal(review.status, 'synced');
assert.equal(review.knownCount, 3);
assert.equal(review.completedCount, 1);
assert.equal(review.completionRate, 33);
assert.deepEqual(review.todayEvidence, { touched: 4, completed: 2, progress: 3 });

const emptyReview = normalizeReviewStatus({ completionRate: null, history: [] }, reviewDate);
assert.equal(emptyReview.completionRate, null);

const period = normalizePeriodSnapshot({
  periodType: 'week',
  periodKey: '2026-07-27_to_2026-08-02',
  review: {
    status: 'synced',
    verdict: '集中完成唯一实验',
    experiment: { action: '连续使用周期面板 7 天' },
    startStopContinue: { start: ['每天查看'], stop: ['临时换方向'], continue: ['MVP 先行'] },
  },
  derived: { dailyReviewCount: 4, commitments: { rate: 75 }, tasks: { completed: 5 } },
}, 'week');
assert.equal(period.review.status, 'synced');
assert.equal(period.review.experiment.action, '连续使用周期面板 7 天');
assert.equal(period.derived.dailyReviewCount, 4);
assert.equal(period.derived.commitments.rate, 75);

const commandContext = resolveTaskCommandContext({
  id: 'main',
  mainlineId: 'project',
  commitmentRole: 'primary',
  commitmentDate: reviewDate,
  commitmentSource: 'hq',
}, [{ id: 'project', name: '人生参谋部' }], period);
assert.equal(commandContext.source, 'hq');
assert.equal(commandContext.roleLabel, '今日主动作');
assert.equal(commandContext.project.name, '人生参谋部');
assert.equal(commandContext.experiment.action, '连续使用周期面板 7 天');

console.log('hq model tests passed');
