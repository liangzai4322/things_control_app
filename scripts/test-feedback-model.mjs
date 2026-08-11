import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  activateRuleVersion, addPrediction, approveExperiment, completeExperiment,
  buildFeedbackHqSummary, deprecateRuleVersion, deriveFeedbackDashboard, importFeedbackContinuity,
  decideCrossSystemChange, importV2FeedbackCandidates, observePatternCandidate,
  proposeCandidateExperiment, proposeCrossSystemChange, proposeExperiment, proposeRuleVersion, rejectPatternCandidate, settlePrediction,
} from '../js/feedback-model.js';
import { parseFeedbackImportFiles } from '../js/feedback-import.js';

const at = (value) => ({ now: new Date(value) });
const explicitAt = (value) => ({ now: new Date(value), sourceAuthority: 'explicit_user' });
let store = {};
let first = addPrediction(store, { predictionId: 'p1', subjectRef: '发布系统', expectedResult: '周一上线', expectedAt: '2026-08-10T10:00:00+08:00', assumptions: ['构建通过'] }, at('2026-08-09T01:00:00Z'));
assert.equal(first.error, null); store = first.store;
let settled = settlePrediction(store, 'p1', { actualResult: '周二上线', type: 'estimation', severity: 'medium', facts: ['多出一次返工'] }, at('2026-08-10T04:00:00Z'));
assert.equal(settled.prediction.status, 'settled'); store = settled.store;
store = addPrediction(store, { predictionId: 'p2', subjectRef: '发布系统', expectedResult: '当天验收', expectedAt: '2026-08-11T10:00:00+08:00' }, at('2026-08-10T05:00:00Z')).store;
store = settlePrediction(store, 'p2', { actualResult: '第二天验收', type: 'estimation', severity: 'low', facts: ['移动端返工'] }, at('2026-08-11T05:00:00Z')).store;
assert.equal(deriveFeedbackDashboard(store).patterns[0].count, 2);

let experiment = proposeExperiment(store, { experimentId: 'e1', hypothesis: '先做移动端验收会减少返工', changedVariable: '验收顺序', evaluateAt: '2026-08-18', successConditions: ['返工不超过一次'], stopConditions: ['阻塞主发布'] }, at('2026-08-11T06:00:00Z'));
assert.equal(experiment.experiment.status, 'proposed'); store = experiment.store;
for (const sourceAuthority of [undefined, 'ai_derived', 'operator']) {
  const denied = approveExperiment(store, 'e1', { ...at('2026-08-11T07:00:00Z'), sourceAuthority });
  assert.match(denied.error, /explicit_user/);
  assert.equal(denied.store.experiments.find((item) => item.experimentId === 'e1').status, 'proposed');
}
let approved = approveExperiment(store, 'e1', explicitAt('2026-08-11T07:00:00Z'));
assert.equal(approved.experiment.approvedBy, 'explicit_user'); store = approved.store;
const duplicate = proposeExperiment(store, { experimentId: 'e2', hypothesis: '另一个实验', changedVariable: '时间', evaluateAt: '2026-08-19', successConditions: ['完成'], stopConditions: ['失败'] }).store;
assert.match(approveExperiment(duplicate, 'e2', { sourceAuthority: 'explicit_user' }).error, /已有一个/);
store = completeExperiment(store, 'e1', 'inconclusive', '样本不足', explicitAt('2026-08-18T07:00:00Z')).store;
assert.match(completeExperiment(store, 'e1', 'failed', '', explicitAt('2026-08-18T08:00:00Z')).error, /现实结果/);

let proposedRule = proposeRuleVersion(store, { ruleId: 'r1', targetSystem: 'execution', statement: '发布前先验收移动端', evidenceRefs: ['p1', 'p2', 'e1'], validationAt: '2026-08-25', invalidationConditions: ['返工次数没有下降'] }, at('2026-08-18T08:00:00Z'));
assert.equal(proposedRule.rule.version, 1); store = proposedRule.store;
for (const sourceAuthority of [undefined, 'ai_derived', 'imported']) {
  const denied = activateRuleVersion(proposedRule.store, 'r1', 1, { ...at('2026-08-18T09:00:00Z'), sourceAuthority });
  assert.match(denied.error, /explicit_user/);
  assert.equal(denied.store.rules.find((item) => item.ruleId === 'r1').status, 'proposed');
}
let active = activateRuleVersion(store, 'r1', 1, explicitAt('2026-08-18T09:00:00Z'));
assert.equal(active.rule.status, 'active'); assert.equal(active.rule.approvedBy, 'explicit_user'); store = active.store;
let v2 = proposeRuleVersion(store, { ruleId: 'r1', targetSystem: 'execution', statement: '发布前先验收390px移动端', evidenceRefs: ['e1'], validationAt: '2026-09-01', invalidationConditions: ['交付时间显著增加'] }, at('2026-08-25T08:00:00Z'));
assert.equal(v2.rule.version, 2); store = activateRuleVersion(v2.store, 'r1', 2, explicitAt('2026-08-25T09:00:00Z')).store;
assert.equal(store.rules.find((x) => x.ruleId === 'r1' && x.version === 1).status, 'deprecated');
assert.equal(deriveFeedbackDashboard(store).activeRules[0].version, 2);
assert.equal(deriveFeedbackDashboard(store).ruleHistory[0].version, 1);
assert.equal(deriveFeedbackDashboard(store).metrics.evidenceCoverage, 100);

const continuity = {
  continuityId: 'feedback:week:2026-W33', cycleType: 'week', cycleKey: '2026-W33',
  deviations: [{ deviationId: 'dev-shared-1', subjectRef: '发布系统', type: 'estimation', severity: 'high', facts: ['连续两次延期'], evidenceRefs: [{ refId: 'taskbox_task:t1', type: 'taskbox_task', sourceId: 't1', label: '发布任务' }] }],
  experiments: [{ experimentId: 'exp-shared-1', hypothesis: '先验收移动端可减少延期', changedVariable: '验收顺序', evaluateAt: '2026-08-25', successConditions: ['按时'], stopConditions: ['阻塞'] }],
  rules: [{ ruleId: 'rule-shared-1', version: 1, targetSystem: 'execution', statement: '发布前验收390px', validationAt: '2026-09-01', invalidationConditions: ['交付时长上升'], evidenceRefs: [{ refId: 'deviation:dev-shared-1', type: 'deviation', sourceId: 'dev-shared-1' }], status: 'active', approvedBy: 'imported' }],
};
let imported = importFeedbackContinuity(store, continuity, at('2026-08-19T01:00:00Z'));
assert.equal(imported.error, null);
assert.equal(imported.store.schemaVersion, 3);
assert.equal(imported.store.deviations[0].evidenceRefs[0].sourceId, 't1');
assert.equal(imported.store.experiments.find((item) => item.experimentId === 'exp-shared-1').status, 'proposed', 'imports cannot activate experiments');
assert.equal(imported.store.rules.find((item) => item.ruleId === 'rule-shared-1').status, 'proposed', 'imports cannot activate target-system rules');
assert.equal(importFeedbackContinuity(imported.store, continuity).store.deviations.length, 1, 'cycle import is idempotent');
const summary = buildFeedbackHqSummary(imported.store);
assert.equal(summary.pendingRuleCount, 1);
assert.equal(summary.latestDeviation.deviationId, 'dev-shared-1');

const v2Payload = {
  importId: 'feedback-v2:first-30-days', datasetVersion: 'v2', sourceRef: '/read-only/v2',
  observationsClaims: [
    { claimId: 'claim-v2-1', candidateLineId: 'cl-v2-1', recordType: 'observation', domain: 'feedback', content: '可能存在估算偏差', authority: 'ai_summary', epistemicState: 'uncertain', sourceRef: '/review.md#L1', activity: { dateMapping: 'unknown', sequenceEligible: true } },
    { claimId: 'claim-v2-2', candidateLineId: 'cl-v2-2', recordType: 'claim', domain: 'feedback', content: '一条待核断言', authority: 'user_interpretation', epistemicState: 'asserted', sourceRef: '/review.md#L2', activity: { dateMapping: 'same-day', sequenceEligible: true } },
  ],
  semanticClusters: [
    { clusterId: 'cluster-template', representativeText: '| 指标 | 结果 |', occurrenceCount: 13, sourceRefs: ['/a', '/b'], reviewDates: ['2026-07-01', '2026-07-02'], activityDates: ['2026-07-01', '2026-07-02'], sequenceEligibleOccurrenceCount: 2, templateLike: true, filteredReasons: ['markdown_table_header'] },
    { clusterId: 'cluster-range', representativeText: '重复文本', occurrenceCount: 2, sourceRefs: ['/c', '/d'], reviewDates: ['2026-07-03', '2026-07-04'], activityDates: [], sequenceEligibleOccurrenceCount: 0, templateLike: false },
  ],
  patternCandidates: [{ patternId: 'pattern-v2-1', status: 'active', basis: 'explicit_pattern_language', domain: 'feedback', statement: '这只是模式候选', evidenceRefs: ['/review.md#L3'], temporalInferenceAllowed: true, activity: { dateMapping: 'range', sequenceEligible: true } }],
  calibrationProposals: [{ proposalId: 'cal-v2-1', domain: 'feedback', status: 'active', title: '采集校准', hypothesis: '冻结预测可改善证据', successConditions: ['5组配对'], stopConditions: ['记录负担过高'], evidenceRefs: ['/review.md#L4'], risks: ['事后改写'], implementationAuthorized: true }],
};
let v2Imported = importV2FeedbackCandidates(imported.store, v2Payload, at('2026-08-20T01:00:00Z'));
assert.equal(v2Imported.error, null);
assert.equal(v2Imported.store.v2Candidates.observationsClaims[0].sequenceEligible, false, 'unknown dateMapping cannot enter sequences');
assert.equal(v2Imported.store.v2Candidates.semanticClusters[0].behaviorPatternEligible, false, 'template clusters are isolated from behavior patterns');
assert.equal(v2Imported.store.v2Candidates.semanticClusters[0].temporalEligible, false, 'templates never enter temporal inference');
assert.equal(v2Imported.store.v2Candidates.semanticClusters[1].temporalEligible, false, 'missing/range activity dates never enter temporal inference');
assert.equal(v2Imported.store.v2Candidates.patternCandidates[0].status, 'candidate_unvalidated', 'imported patterns cannot retain active authority');
assert.equal(v2Imported.store.v2Candidates.patternCandidates[0].temporalInferenceAllowed, false, 'range mapping cannot enable pattern timing');
assert.equal(v2Imported.store.v2Candidates.calibrationProposals[0].status, 'proposed');
assert.equal(v2Imported.store.v2Candidates.calibrationProposals[0].implementationAuthorized, false);
const v2Again = importV2FeedbackCandidates(v2Imported.store, v2Payload, at('2026-08-20T02:00:00Z')).store;
assert.equal(v2Again.v2Candidates.observationsClaims.length, 2, 'V2 record import is idempotent');
assert.equal(v2Again.v2Candidates.semanticClusters.length, 2, 'V2 cluster import is idempotent');
assert.equal(v2Again.v2Candidates.patternCandidates.length, 1, 'V2 pattern import is idempotent');

for (const sourceAuthority of [undefined, 'ai_derived', 'external_evidence']) {
  const denied = observePatternCandidate(v2Again, 'pattern-v2-1', { supportingEvidence: ['/receipt/1'] }, { ...at('2026-08-20T03:00:00Z'), sourceAuthority });
  assert.match(denied.error, /explicit_user/);
  assert.equal(denied.store.v2Candidates.patternCandidates[0].status, 'candidate_unvalidated');
  const rejected = rejectPatternCandidate(v2Again, 'pattern-v2-1', { ...at('2026-08-20T03:00:00Z'), sourceAuthority });
  assert.match(rejected.error, /explicit_user/);
  assert.equal(rejected.store.v2Candidates.patternCandidates[0].status, 'candidate_unvalidated');
}
let observed = observePatternCandidate(v2Again, 'pattern-v2-1', { supportingEvidence: ['/receipt/1'], counterEvidence: ['/receipt/2'], missingEvidence: ['还缺第二周期'] }, explicitAt('2026-08-20T03:00:00Z'));
assert.equal(observed.candidate.status, 'observed');
let candidateExperiment = proposeCandidateExperiment(observed.store, 'pattern-v2-1', { experimentId: 'candidate-exp-1', hypothesis: '提前冻结预测会降低误差', changedVariable: '冻结时点', evaluateAt: '2026-08-27', successConditions: ['产生5组配对'], stopConditions: ['记录负担上升'] }, at('2026-08-20T04:00:00Z'));
assert.equal(candidateExperiment.candidate.status, 'experiment_proposed');
let candidateApproved = approveExperiment(candidateExperiment.store, 'candidate-exp-1', explicitAt('2026-08-20T05:00:00Z'));
assert.equal(candidateApproved.store.v2Candidates.patternCandidates[0].status, 'experiment_active');
for (const sourceAuthority of [undefined, 'ai_derived', 'automation']) {
  const denied = completeExperiment(candidateApproved.store, 'candidate-exp-1', 'succeeded', '伪造评估', { ...at('2026-08-27T05:00:00Z'), sourceAuthority });
  assert.match(denied.error, /explicit_user/);
  assert.equal(denied.store.experiments.find((item) => item.experimentId === 'candidate-exp-1').status, 'active');
}
let candidateEvaluated = completeExperiment(candidateApproved.store, 'candidate-exp-1', 'succeeded', '形成5组可定位配对', explicitAt('2026-08-27T05:00:00Z'));
assert.equal(candidateEvaluated.store.v2Candidates.patternCandidates[0].status, 'evaluated');
let candidateRule = proposeRuleVersion(candidateEvaluated.store, { ruleId: 'candidate-rule-1', patternCandidateId: 'pattern-v2-1', targetSystem: 'feedback', statement: '关键预测必须事前冻结', evidenceRefs: ['candidate-exp-1'], validationAt: '2026-09-03', invalidationConditions: ['记录负担超过收益'] }, at('2026-08-27T06:00:00Z'));
assert.equal(candidateRule.store.v2Candidates.patternCandidates[0].status, 'rule_proposed');
let candidateRuleActive = activateRuleVersion(candidateRule.store, 'candidate-rule-1', 1, explicitAt('2026-08-27T07:00:00Z'));
assert.equal(candidateRuleActive.store.v2Candidates.patternCandidates[0].status, 'rule_active');
for (const sourceAuthority of [undefined, 'ai_derived', 'automation']) {
  const denied = deprecateRuleVersion(candidateRuleActive.store, 'candidate-rule-1', 1, { ...at('2026-08-27T08:00:00Z'), sourceAuthority });
  assert.match(denied.error, /explicit_user/);
  assert.equal(denied.store.rules.find((item) => item.ruleId === 'candidate-rule-1').status, 'active');
}

let change = proposeCrossSystemChange(candidateRuleActive.store, { proposalId: 'change-1', targetSystem: 'time', deviation: '保护时段多次被打断', evidenceRefs: ['/receipt/3'], suggestedChange: '将保护时段前移30分钟', successConditions: ['一周内完成率提高'], stopConditions: ['睡眠减少'], risks: ['挤压恢复'], rollback: '恢复原时段' }, at('2026-08-28T01:00:00Z'));
assert.equal(change.proposal.status, 'proposed');
assert.equal(Object.hasOwn(change.proposal, 'appliedAt'), false, 'feedback proposals expose no direct-application state');
for (const sourceAuthority of [undefined, 'ai_derived', 'admin']) {
  const denied = decideCrossSystemChange(change.store, 'change-1', 'accept', { ...at('2026-08-28T02:00:00Z'), sourceAuthority });
  assert.match(denied.error, /explicit_user/);
  assert.equal(denied.store.crossSystemProposals[0].status, 'proposed');
  assert.equal(denied.store.crossSystemProposals[0].decisionBy, null);
}
change = decideCrossSystemChange(change.store, 'change-1', 'accept', explicitAt('2026-08-28T02:00:00Z'));
assert.equal(change.proposal.status, 'accepted_not_applied', 'acceptance still cannot edit the target system');

const v2DataDir = process.env.V2_DATA_DIR || '/Users/ylw/Documents/知识库/01-plan/2026/系统/014人生参谋部五系统/历史日省回填/首轮30日-V2/data';
const v2FileNames = ['04-claims-observations.jsonl', '05-semantic-clusters.jsonl', '07-patterns.jsonl', '08-calibration-proposals.jsonl'];
const realV2Files = v2FileNames.map((name) => ({ name, text: async () => fs.readFileSync(path.join(v2DataDir, name), 'utf8') }));
const parsedRealV2 = await parseFeedbackImportFiles(realV2Files);
assert.equal(parsedRealV2.error, null);
assert.equal(parsedRealV2.mode, 'v2');
let actualV2 = importV2FeedbackCandidates({}, parsedRealV2.payload, at('2026-08-29T01:00:00Z'));
let actualDashboard = deriveFeedbackDashboard(actualV2.store);
assert.equal(actualDashboard.v2Inbox.observationsClaims.length, 790, 'real V2 must import only feedback-domain candidates');
assert.equal(actualDashboard.v2Inbox.semanticClusters.length, 22);
assert.equal(actualDashboard.v2Inbox.templateClusters.length, 20);
assert.equal(actualDashboard.v2Inbox.patternCandidates.length, 42);
assert.equal(actualDashboard.v2Inbox.patternCandidates.filter((item) => item.status === 'candidate_unvalidated').length, 42);
assert.equal(actualDashboard.v2Inbox.calibrationProposals.length, 5);
assert.equal(actualDashboard.v2Inbox.calibrationProposals.filter((item) => item.status === 'proposed').length, 5);
actualV2 = importV2FeedbackCandidates(actualV2.store, parsedRealV2.payload, at('2026-08-29T02:00:00Z'));
actualDashboard = deriveFeedbackDashboard(actualV2.store);
assert.equal(actualDashboard.v2Inbox.observationsClaims.length, 790, 'real V2 repeated import is idempotent');
assert.equal(actualV2.store.v2Candidates.imports.length, 1);

const malformedBatch = await parseFeedbackImportFiles([...realV2Files, { name: 'broken.jsonl', text: async () => '{"claimId":"ok","recordType":"claim"}\nnot-json' }]);
assert.match(malformedBatch.error, /未写入任何数据/);
assert.equal(malformedBatch.payload, null, 'one bad JSONL line rejects the entire batch');
assert.ok(malformedBatch.errors.some((item) => item.startsWith('broken.jsonl:2:')), 'line-level parse errors include filename and line number');

console.log('feedback evolution model tests passed');
