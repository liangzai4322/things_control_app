import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  MISSION_HQ_STANDING_RULE_ID,
  decideMissionCandidate,
  importMissionCandidates,
  publishMissionVersion,
} from '../js/mission-model.js';
import { parseMissionV2Text } from '../js/mission-v2-adapter.js';
import {
  importHealthCandidates,
  resolveHealthCandidate,
} from '../js/health-model.js';
import {
  buildTimeCandidateInbox,
  importTimeCandidates,
  updateTimeCandidate,
} from '../js/time-attention-model.js';
import {
  buildExecutionProposalDraft,
  normalizeExecutionCandidates,
} from '../js/execution-model.js';
import {
  activateRuleVersion,
  approveExperiment,
  completeExperiment,
  decideCrossSystemChange,
  deprecateRuleVersion,
  deriveFeedbackDashboard,
  importFeedbackContinuity,
  importV2FeedbackCandidates,
  normalizeFeedbackStore,
  observePatternCandidate,
  rejectPatternCandidate,
} from '../js/feedback-model.js';
import { parseFeedbackImportFiles } from '../js/feedback-import.js';
import { HQ_SYSTEM_REGISTRY } from '../js/hq-systems.js';

const V2_DATA_DIR = process.env.V2_DATA_DIR || '/Users/ylw/Documents/知识库/01-plan/2026/系统/014人生参谋部五系统/历史日省回填/首轮30日-V2/data';
const claimsPath = path.join(V2_DATA_DIR, '04-claims-observations.jsonl');
const claimsText = fs.readFileSync(claimsPath, 'utf8');
const claims = claimsText.split(/\r?\n/).filter(Boolean).map(JSON.parse);
const byDomain = (domain) => claims.filter((item) => item.domain === domain);

assert.equal(claims.length, 1456);
assert.equal(claims.filter((item) => item.validated_fact || item.validatedFact).length, 0, 'V2 validated_fact must remain zero');
assert.deepEqual(
  Object.fromEntries(['mission', 'health', 'time', 'execution', 'feedback'].map((domain) => [domain, byDomain(domain).length])),
  { mission: 72, health: 84, time: 135, execution: 375, feedback: 790 },
  'real V2 domain boundaries must remain stable',
);

// Mission: real V2 candidates remain unreviewed; omitted/AI authority cannot decide or publish.
const missionParsed = parseMissionV2Text(claimsText, { importedAt: '2026-08-11T00:00:00Z' });
assert.equal(missionParsed.candidates.length, 38, 'mission M2 admits observation/claim from 04 and isolates source_proposal');
assert.equal(missionParsed.candidates.length, byDomain('mission').filter((item) => ['observation', 'claim'].includes(item.recordType)).length);
let mission = importMissionCandidates({}, missionParsed.candidates).store;
const missionCandidateId = mission.candidateInbox[0].candidateId;
for (const sourceAuthority of [undefined, 'ai_derived', 'ai_summary', 'admin']) {
  const denied = decideMissionCandidate(mission, missionCandidateId, 'included_in_draft', { sourceAuthority });
  assert.match(denied.error, /用户明确/);
  assert.deepEqual(denied.store, mission);
}
const standingMissionDecision = decideMissionCandidate(mission, missionCandidateId, 'included_in_draft', {
  sourceAuthority: 'standing_rule', authorization: {
    standingRuleId: MISSION_HQ_STANDING_RULE_ID,
    action: 'decide_mission_candidate:included_in_draft',
    objectId: missionCandidateId,
    expectedResult: '将指定候选纳入使命草稿，不发布版本',
  },
});
assert.equal(standingMissionDecision.error, null);
assert.equal(standingMissionDecision.store.candidateInbox.find((item) => item.candidateId === missionCandidateId).decision.decidedBy, 'standing_rule');
assert.equal(standingMissionDecision.store.activeVersion, null, 'standing mission candidate decision must not publish');
const invalidMissionDraft = { ...mission, draft: {} };
for (const sourceAuthority of [undefined, 'ai_derived', 'ai_summary']) {
  const denied = publishMissionVersion(invalidMissionDraft, [], { sourceAuthority });
  assert.match(denied.errors[0], /用户明确批准/);
  assert.equal(denied.version, null);
}

// Health: only explicit user authority can create a decision audit; unknown/range stays context_only.
let health = importHealthCandidates({}, byDomain('health'), '2026-08-11T00:00:00Z');
assert.equal(health.candidates.length, 84);
const exactHealthCandidate = {
  claimId: 'joint-health-exact', candidateLineId: 'joint-health-line', recordType: 'observation', domain: 'health',
  content: '用户待确认的健康候选', sourceRef: 'joint://health/exact', authority: 'user_interpretation',
  activity: { dateMapping: 'exact', activityStart: '2026-08-10', activityEnd: '2026-08-10', sequenceEligible: true },
};
health = importHealthCandidates(health, [exactHealthCandidate], '2026-08-11T00:00:00Z');
for (const sourceAuthority of [undefined, 'ai_derived', 'ai_summary', 'admin']) {
  const denied = resolveHealthCandidate(health, 'joint-health-exact', 'confirm', { sourceAuthority });
  assert.deepEqual(denied, health, 'non-user health authority must be a no-op');
}
const healthConfirmed = resolveHealthCandidate(health, 'joint-health-exact', 'confirm', {
  sourceAuthority: 'explicit_user', resolvedAt: '2026-08-11T00:10:00Z', decisionId: 'joint-health-confirm',
});
assert.equal(healthConfirmed.candidates.find((item) => item.candidateId === 'joint-health-exact').decisionId, 'joint-health-confirm');
assert.equal(healthConfirmed.observations.length, 1);
const unknownHealth = importHealthCandidates(healthConfirmed, [{ ...exactHealthCandidate, claimId: 'joint-health-unknown', candidateLineId: 'joint-health-unknown-line', activity: { dateMapping: 'unknown', sequenceEligible: false } }]);
const healthContext = resolveHealthCandidate(unknownHealth, 'joint-health-unknown', 'confirm', {
  sourceAuthority: 'explicit_user', decisionId: 'joint-health-context', resolvedAt: '2026-08-11T00:20:00Z',
});
assert.equal(healthContext.candidates.find((item) => item.candidateId === 'joint-health-unknown').status, 'context_only');
assert.equal(healthContext.candidates.find((item) => item.candidateId === 'joint-health-unknown').decisionId, 'joint-health-context');
assert.equal(healthContext.observations.length, 1, 'context_only must not create an Observation');
const dismissedHealth = importHealthCandidates(healthContext, [{ ...exactHealthCandidate, claimId: 'joint-health-dismiss', candidateLineId: 'joint-health-dismiss-line' }]);
const healthDismissed = resolveHealthCandidate(dismissedHealth, 'joint-health-dismiss', 'dismiss', {
  sourceAuthority: 'explicit_user', decisionId: 'joint-health-dismissed', resolvedAt: '2026-08-11T00:30:00Z',
});
assert.equal(healthDismissed.candidates.find((item) => item.candidateId === 'joint-health-dismiss').status, 'dismissed');
assert.equal(healthDismissed.candidates.find((item) => item.candidateId === 'joint-health-dismiss').decisionId, 'joint-health-dismissed');

// Time: confirmation adds an explicit date to a candidate but never validates it as a fact.
const timeImported = importTimeCandidates({}, byDomain('time'));
assert.equal(timeImported.accepted, 135);
assert.equal(timeImported.store.candidates.length, 135);
const timeCandidate = timeImported.store.candidates[0];
const timeConfirmed = updateTimeCandidate(timeImported.store, timeCandidate.candidateId, {
  status: 'confirmed_date', confirmedActivityDate: '2026-08-10',
}, new Date('2026-08-11T01:00:00Z'));
const timeInbox = buildTimeCandidateInbox(timeConfirmed);
assert.equal(timeInbox.dailySequenceCandidates.length, 1);
assert.equal(timeInbox.dailySequenceCandidates[0].validatedFact, false);

// Execution: candidates, checkboxes and source_proposals stay non-task; only a shadow HQ interface draft is produced.
const executionInbox = normalizeExecutionCandidates(byDomain('execution'));
assert.equal(executionInbox.candidates.length, 375);
assert.equal(executionInbox.metrics.validatedFactCount, 0);
assert.equal(executionInbox.metrics.taskCount, 0);
assert.equal(executionInbox.candidates.every((item) => item.taskStatus === 'not_a_task' && item.readOnly), true);
const executionDraft = buildExecutionProposalDraft(executionInbox.candidates[0]);
assert.equal(executionDraft.shadowMode, true);
assert.equal(executionDraft.workflow.writesTaskBox, false);
assert.deepEqual(executionDraft.workflow.requires, ['hq_proposal_creation', 'explicit_user_approval', 'idempotent_promote']);

// Feedback: four authoritative JSONL files are atomic, idempotent and never retain imported active authority.
const feedbackNames = ['04-claims-observations.jsonl', '05-semantic-clusters.jsonl', '07-patterns.jsonl', '08-calibration-proposals.jsonl'];
const feedbackFiles = feedbackNames.map((name) => ({ name, text: async () => fs.readFileSync(path.join(V2_DATA_DIR, name), 'utf8') }));
const parsedFeedback = await parseFeedbackImportFiles(feedbackFiles);
assert.equal(parsedFeedback.error, null);
let feedback = importV2FeedbackCandidates({}, parsedFeedback.payload, { now: new Date('2026-08-11T02:00:00Z') }).store;
let feedbackDashboard = deriveFeedbackDashboard(feedback);
assert.equal(feedbackDashboard.v2Inbox.observationsClaims.length, 790);
assert.equal(feedbackDashboard.v2Inbox.semanticClusters.length, 22);
assert.equal(feedbackDashboard.v2Inbox.templateClusters.length, 20);
assert.equal(feedbackDashboard.v2Inbox.patternCandidates.length, 42);
assert.equal(feedbackDashboard.v2Inbox.patternCandidates.every((item) => item.status === 'candidate_unvalidated'), true);
assert.equal(feedbackDashboard.v2Inbox.calibrationProposals.length, 5);
assert.equal(feedbackDashboard.v2Inbox.calibrationProposals.every((item) => item.status === 'proposed'), true);
feedback = importV2FeedbackCandidates(feedback, parsedFeedback.payload, { now: new Date('2026-08-11T02:10:00Z') }).store;
feedbackDashboard = deriveFeedbackDashboard(feedback);
assert.equal(feedbackDashboard.v2Inbox.observationsClaims.length, 790);
assert.equal(feedback.v2Candidates.imports.length, 1);
const malformedFeedback = await parseFeedbackImportFiles([...feedbackFiles, { name: 'broken.jsonl', text: async () => '{"claimId":"partial","recordType":"claim"}\nnot-json' }]);
assert.match(malformedFeedback.error, /未写入任何数据/);
assert.equal(malformedFeedback.payload, null);

const activeImport = importFeedbackContinuity({}, {
  cycleType: 'day', cycleKey: '2026-08-10',
  experiments: [{ experimentId: 'joint-experiment', hypothesis: '导入实验', status: 'active' }],
  rules: [{ ruleId: 'joint-rule', version: 1, statement: '导入规则', status: 'active' }],
});
assert.equal(activeImport.store.experiments[0].status, 'proposed');
assert.equal(activeImport.store.rules[0].status, 'proposed');

const guardedFeedback = normalizeFeedbackStore({
  v2Candidates: { patternCandidates: [{ patternId: 'joint-pattern', statement: '候选模式', status: 'candidate_unvalidated' }] },
  experiments: [{ experimentId: 'joint-experiment', hypothesis: '实验', status: 'proposed' }],
  rules: [{ ruleId: 'joint-rule', version: 1, statement: '规则', status: 'proposed' }],
  crossSystemProposals: [{ proposalId: 'joint-change', targetSystem: 'time', deviation: '偏差', suggestedChange: '建议', status: 'proposed' }],
});
for (const sourceAuthority of [undefined, 'ai_derived', 'ai_summary', 'admin']) {
  assert.match(observePatternCandidate(guardedFeedback, 'joint-pattern', { supportingEvidence: ['joint:evidence'] }, { sourceAuthority }).error, /explicit_user/);
  assert.match(rejectPatternCandidate(guardedFeedback, 'joint-pattern', { sourceAuthority }).error, /explicit_user/);
  assert.match(approveExperiment(guardedFeedback, 'joint-experiment', { sourceAuthority }).error, /explicit_user/);
  assert.match(completeExperiment(guardedFeedback, 'joint-experiment', 'succeeded', '结果', { sourceAuthority }).error, /explicit_user/);
  assert.match(activateRuleVersion(guardedFeedback, 'joint-rule', 1, { sourceAuthority }).error, /explicit_user/);
  assert.match(deprecateRuleVersion(guardedFeedback, 'joint-rule', 1, { sourceAuthority }).error, /explicit_user/);
  assert.match(decideCrossSystemChange(guardedFeedback, 'joint-change', 'accept', { sourceAuthority }).error, /explicit_user/);
}

// Public ownership: four systems are read-only L1; execution is controlled L2; no client task-write bypass exists.
const registry = Object.fromEntries(HQ_SYSTEM_REGISTRY.map((item) => [item.systemId, item]));
for (const systemId of ['mission', 'health', 'time', 'feedback']) {
  assert.equal(registry[systemId].accessLevel, 'L1');
  assert.equal(registry[systemId].writeMethod, '');
}
assert.equal(registry.execution.accessLevel, 'L2');
const hqPageSource = fs.readFileSync('js/hq-page.js', 'utf8');
assert.match(hqPageSource, /readFiveSystemHqPorts/);
assert.doesNotMatch(hqPageSource, /from '.\/(?:mission|health|time-attention|feedback)-(?:model|store)\.js'/, 'HQ must not know five-system storage internals');
const clientSources = ['js/mission-model.js', 'js/mission-page.js', 'js/health-model.js', 'js/health-page.js', 'js/time-attention-model.js', 'js/time-attention-page.js', 'js/execution-model.js', 'js/execution-page.js', 'js/feedback-model.js', 'js/feedback-page.js'].map((file) => fs.readFileSync(file, 'utf8')).join('\n');
assert.doesNotMatch(clientSources, /\b(?:addTask|updateTask)\s*\(/, 'five-system clients must not write TaskBox directly');
const executionPageSource = fs.readFileSync('js/execution-page.js', 'utf8');
assert.match(executionPageSource, /taskbox_execution_hq_proposal_drafts_v1/);
assert.doesNotMatch(fs.readFileSync('js/app.js', 'utf8') + hqPageSource, /taskbox_execution_hq_proposal_drafts_v1/, 'shadow drafts must not auto-consume on page load');

console.log('V3 B-F joint authorization and real-data contract tests passed');
