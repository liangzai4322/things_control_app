import assert from 'node:assert/strict';
import {
  buildExecutionProposalDraft,
  deriveExecutionState,
  normalizeExecutionCandidates,
  taskExecutionReadiness,
  taskSourceProposalId,
} from '../js/execution-model.js';

const reviewDate = '2026-08-09';
const boxes = [{ id: 'box-1', name: '重要的事' }];
const base = { boxId: 'box-1', createdAt: '2026-08-09T01:00:00Z', updatedAt: '2026-08-09T02:00:00Z' };
const tasks = [
  { ...base, id: 'primary', content: '发布执行系统', note: '页面、测试和构建通过', progress: 40, commitmentDate: reviewDate, commitmentRole: 'primary' },
  { ...base, id: 'maintenance', content: '回复关键消息', note: '完成三条回复', commitmentDate: reviewDate, commitmentRole: 'maintenance' },
  { ...base, id: 'unready', content: '准备材料', scheduledAt: '2026-08-09T08:00:00+08:00' },
  { ...base, id: 'waiting', content: '等待反馈', note: '收到对方确认', deferredAt: '2026-08-09T02:00:00Z', deferNote: '等待客户回复' },
  { ...base, id: 'done', content: '完成原型', note: '原型可访问', isCompleted: true, completedAt: '2026-08-09T06:00:00+08:00', executionMode: 'ai', completionReceipt: { sourceTaskId: 'done', note: '链接已验证' } },
];
const brief = { reviewDate, strategicCommitmentTaskId: 'primary', currentActionTaskId: 'primary', maintenanceTaskIds: ['maintenance'] };
const state = deriveExecutionState({ tasks, boxes, brief, reviewDate, syncState: { pendingCount: 2 } });

assert.equal(state.currentAction.id, 'primary');
assert.equal(state.strategicCommitment.id, 'primary');
assert.equal(state.status, 'active');
assert.deepEqual(state.maintenance.map((task) => task.id), ['maintenance']);
assert.deepEqual(state.lanes.active.map((task) => task.id), ['primary', 'maintenance']);
assert.deepEqual(state.lanes.preparation.map((task) => task.id), ['unready']);
assert.deepEqual(state.lanes.waiting.map((task) => task.id), ['waiting']);
assert.equal(state.outcomes[0].needsHumanVerification, true);
assert.equal(state.outcomes[0].hasEvidence, true);
assert.equal(state.metrics.wipCount, 3);
assert.equal(state.metrics.wipRisk, false);
assert.equal(state.metrics.pendingSync, 2);
assert.deepEqual(taskExecutionReadiness({ content: '动作' }).missing, ['完成标准', '执行时段']);
assert.equal(taskSourceProposalId({ proposalDecisionId: 'proposal-current' }), 'proposal-current');
assert.equal(taskSourceProposalId({ sourceDecisionId: 'proposal-legacy' }), 'proposal-legacy');
assert.equal(taskSourceProposalId({ syncKey: 'hq-proposal:proposal-from-sync-key' }), 'proposal-from-sync-key');
assert.equal(taskSourceProposalId({ syncKey: 'manual-task' }), null);

const nonTaskState = deriveExecutionState({
  tasks: [{ ...base, id: 'pool-option', itemType: 'pool', content: '抽一次奖励', note: '记录使用一次' }],
  boxes,
  brief: { reviewDate, strategicCommitmentTaskId: 'pool-option', currentActionTaskId: 'pool-option' },
  reviewDate,
});
assert.equal(nonTaskState.currentAction, null, '可重复选项不得占据需要完成回执的行动席位');
assert.equal(nonTaskState.strategicCommitment, null);
assert.deepEqual(nonTaskState.outcomes, []);

const completedPrimary = {
  ...base,
  id: 'primary',
  content: '后来修改的任务名',
  note: '页面、测试和构建通过',
  isCompleted: true,
  progress: 100,
  completedAt: '2026-08-09T06:30:00+08:00',
  updatedAt: '2026-08-09T06:30:00+08:00',
  completionReceipt: { sourceTaskId: 'primary', completedAt: '2026-08-09T06:30:00+08:00', note: '验收通过' },
};
const staleBrief = {
  ...brief,
  strategicCommitmentSnapshot: { taskId: 'primary', content: '发布执行系统', committedAt: '2026-08-09T01:30:00Z' },
  currentActionTaskId: 'primary',
};
const completedState = deriveExecutionState({ tasks: [completedPrimary, tasks[1]], boxes, brief: staleBrief, reviewDate });
assert.equal(completedState.status, 'awaiting_candidate');
assert.equal(completedState.currentAction, null, '旧 brief 不得让已完成任务重新占据行动席位');
assert.equal(completedState.strategicCommitment.content, '发布执行系统', '原始战略承诺文案必须保持冻结');
assert.deepEqual(completedState.lanes.active.map((task) => task.id), ['maintenance']);
assert.equal(completedState.lanes.active.some((task) => task.id === 'primary'), false);
assert.equal(completedState.outcomes.length, 1);
assert.equal(completedState.outcomes[0].id, 'primary');
assert.equal(completedState.outcomes[0].isStrategicCommitment, true);
assert.equal(completedState.outcomes[0].completionReceipt.note, '验收通过');

const handoffState = deriveExecutionState({
  tasks: [completedPrimary, { ...base, id: 'handoff', content: '收集用户反馈', note: '取得三条真实反馈' }],
  boxes,
  brief: { ...staleBrief, currentActionTaskId: 'handoff' },
  reviewDate,
});
assert.equal(handoffState.status, 'active');
assert.equal(handoffState.strategicCommitment.id, 'primary');
assert.equal(handoffState.currentAction.id, 'handoff');
assert.equal(handoffState.outcomes[0].id, 'primary');

const reopenedState = deriveExecutionState({
  tasks: [{ ...completedPrimary, isCompleted: false, completedAt: null, completionReceipt: null, updatedAt: '2026-08-09T07:00:00+08:00' }],
  boxes,
  brief: staleBrief,
  reviewDate,
});
assert.equal(reopenedState.status, 'active', '用户以更新版本取消完成后应恢复行动');
assert.equal(reopenedState.currentAction.id, 'primary');
assert.deepEqual(reopenedState.outcomes, []);

const v2Checkbox = {
  claimId: 'claim-d3f93bb8be307543eeac',
  candidateLineId: 'cl-6dad18626f27ac72b007',
  recordType: 'source_proposal',
  domain: 'execution',
  authority: 'ai_summary',
  epistemicState: 'future_or_normative',
  reviewDate: '2026-06-29',
  activity: { dateMapping: 'next-day', sequenceEligible: true },
  sequenceEligible: true,
  sourceRef: '/daily-review/2026-06-29.md#L27',
  lineKind: 'checkbox',
  content: '- [ ] SEO站核心功能继续优化完善',
};
const v2Claim = {
  ...v2Checkbox,
  claimId: 'claim-0077453238c7eb0a7245',
  candidateLineId: 'cl-f804b465e173fc0d7da2',
  recordType: 'claim',
  authority: 'user_interpretation',
  lineKind: 'bullet',
  activity: { dateMapping: 'unknown', sequenceEligible: false },
  content: 'SEO站推进慢的原因可能是结果不清楚',
};
const ignoredMission = { ...v2Checkbox, claimId: 'claim-mission', domain: 'mission' };
const inbox = normalizeExecutionCandidates([v2Checkbox, v2Claim, ignoredMission, { domain: 'execution', recordType: 'claim' }]);
assert.equal(inbox.candidates.length, 2);
assert.equal(inbox.metrics.checkboxCount, 1);
assert.equal(inbox.metrics.sourceProposalCount, 1);
assert.equal(inbox.metrics.unknownDateCount, 1);
assert.equal(inbox.metrics.validatedFactCount, 0);
assert.equal(inbox.metrics.taskCount, 0);
assert.equal(inbox.candidates.every((candidate) => candidate.readOnly && candidate.taskStatus === 'not_a_task'), true);

const proposalDraft = buildExecutionProposalDraft(v2Checkbox, { commitmentDate: reviewDate, completionCriteria: '核心路径可验收' });
assert.equal(proposalDraft.proposalType, 'daily_action_proposal');
assert.equal(proposalDraft.sourceAuthority, 'ai_derived', 'V2候选即使被选择也不能伪装成事实授权');
assert.equal(proposalDraft.idempotencyKey, 'v2-execution-candidate:claim-d3f93bb8be307543eeac');
assert.equal(proposalDraft.taskSpec.content, 'SEO站核心功能继续优化完善');
assert.equal(proposalDraft.workflow.writesTaskBox, false);
assert.deepEqual(proposalDraft.workflow.requires, ['hq_proposal_creation', 'explicit_user_approval', 'idempotent_promote']);
assert.deepEqual(buildExecutionProposalDraft(v2Checkbox), buildExecutionProposalDraft(v2Checkbox), '重复选择必须生成相同幂等接口草案');

const candidateCannotBecomeTask = deriveExecutionState({
  tasks: [{ ...v2Checkbox, id: 'candidate-shaped-like-task', boxId: 'box-1', note: '伪完成标准', progress: 90 }],
  boxes,
  brief: { reviewDate, currentActionTaskId: 'candidate-shaped-like-task' },
  reviewDate,
});
assert.equal(candidateCannotBecomeTask.currentAction, null);
assert.deepEqual(candidateCannotBecomeTask.lanes, { preparation: [], active: [], waiting: [] });
assert.deepEqual(candidateCannotBecomeTask.outcomes, []);

assert.match(completedState.outcomes[0].completionReceiptRef, /^taskbox-completion:primary:/);

const wipRiskState = deriveExecutionState({
  tasks: ['a', 'b', 'c', 'd'].map((id) => ({ ...base, id, content: id, note: '完成', progress: 1, scheduledAt: '2026-08-09T09:00:00+08:00' })),
  boxes,
  reviewDate,
});
assert.equal(wipRiskState.metrics.wipRisk, true);
assert.equal(wipRiskState.wipDecisionCandidate.status, 'proposed');
assert.equal(wipRiskState.wipDecisionCandidate.writesTaskBox, false);
assert.equal(wipRiskState.lanes.active.length, 4, 'WIP超限不能自动暂停TaskBox任务');

console.log('execution model tests passed');
