import assert from 'node:assert/strict';
import { MISSION_CANDIDATE_DECISIONS, MISSION_EVENT_TYPES, MISSION_HQ_STANDING_RULE_ID, activeMissionSnapshot, buildMissionHqSnapshot, decideMissionCandidate, deriveMissionEvidence, importMissionCandidates, normalizeMissionStore, publishMissionVersion, updateMissionReviewContext, validateMissionDraft } from '../js/mission-model.js';
import { adaptMissionV2Candidate, parseMissionV2Text } from '../js/mission-v2-adapter.js';

const mainlines = [{ id: 'a', name: '使命系统' }, { id: 'b', name: '内容业务' }];
const draft = { statement: '建设能持续放大个人能力的人生系统', campaign: { title: '跑通使命系统', whyNow: '参谋部已有接入基础', reviewAt: '2026-09-01', successConditions: ['连续使用14天'], exitConditions: ['没有改变资源分配'] }, portfolio: { a: { class: 'primary', resourceShare: 70, strategicContribution: '完成战略协议' }, b: { class: 'maintenance', resourceShare: 20, replacementTarget: '减少低价值选题' } } };

assert.equal(validateMissionDraft(draft, mainlines).valid, true);
assert.equal(validateMissionDraft({ ...draft, statement: '' }, mainlines).valid, false);
assert.equal(validateMissionDraft({ ...draft, portfolio: { a: { class: 'primary' }, b: { class: 'primary' } } }, mainlines).valid, false);

const migrated = normalizeMissionStore({ schemaVersion: 1, draft, activeVersion: 1, history: [{ version: 1, activatedAt: '2026-08-08T08:00:00.000Z', approvedBy: 'explicit_user', snapshot: draft }] });
assert.equal(migrated.schemaVersion, 3);
assert.equal(migrated.draft.missionId, 'mission-001');
assert.equal(migrated.draft.campaign.campaignId, 'campaign-001');
assert.equal(migrated.draft.portfolio.a.itemId, 'portfolio:a');
assert.equal(migrated.history[0].approval.sourceAuthority, 'explicit_user');
assert.equal(migrated.history[0].evidenceChain.triggerDecision, '用户明确批准当前使命草稿');

const denied = publishMissionVersion({ draft }, mainlines, { sourceAuthority: 'ai_derived' });
assert.equal(denied.version, null);
assert.match(denied.errors[0], /用户明确批准/);

const unpublishedStore = normalizeMissionStore({ draft });
const omittedPublication = publishMissionVersion(unpublishedStore, mainlines);
assert.equal(omittedPublication.version, null);
assert.match(omittedPublication.errors[0], /用户明确批准/);
assert.equal(omittedPublication.store.activeVersion, null);
assert.deepEqual(omittedPublication.store.history, []);
assert.deepEqual(omittedPublication.store.events, []);
assert.deepEqual(omittedPublication.store, unpublishedStore, 'omitted publication authority must not mutate the store');
const illegalPublication = publishMissionVersion(unpublishedStore, mainlines, { sourceAuthority: 'admin' });
assert.equal(illegalPublication.version, null);
assert.deepEqual(illegalPublication.store, unpublishedStore, 'illegal publication authority must not mutate the store');
const incompleteStandingPublication = publishMissionVersion(unpublishedStore, mainlines, {
  sourceAuthority: 'standing_rule', authorization: { standingRuleId: MISSION_HQ_STANDING_RULE_ID },
});
assert.equal(incompleteStandingPublication.version, null);
const wrongStandingPublication = publishMissionVersion(unpublishedStore, mainlines, {
  sourceAuthority: 'standing_rule', authorization: {
    standingRuleId: 'wrong-rule', action: 'publish_mission_version', objectId: 'mission-001', expectedResult: '发布当前使命版本',
  },
});
assert.equal(wrongStandingPublication.version, null);

const standingPublication = publishMissionVersion(unpublishedStore, mainlines, {
  now: new Date('2026-08-09T07:00:00Z'), sourceAuthority: 'standing_rule', authorization: {
    standingRuleId: MISSION_HQ_STANDING_RULE_ID, action: 'publish_mission_version', objectId: 'mission-001', expectedResult: '发布当前已校验使命草稿为唯一活动版本',
  },
});
const standingHistory = activeMissionSnapshot(standingPublication.store);
assert.equal(standingPublication.version, 1);
assert.equal(standingHistory.approval.sourceAuthority, 'standing_rule');
assert.equal(standingHistory.approval.standingRuleId, MISSION_HQ_STANDING_RULE_ID);
assert.equal(standingHistory.evidenceChain.approvedBy, 'standing_rule');
assert.equal(buildMissionHqSnapshot(standingPublication.store, { mainlines, now: new Date('2026-08-09T07:30:00Z') }).status, 'healthy');

const first = publishMissionVersion({ draft }, mainlines, { now: new Date('2026-08-09T08:00:00Z'), sourceAuthority: 'explicit_user' });
assert.equal(first.version, 1);
assert.equal(activeMissionSnapshot(first.store).snapshot.campaign.title, '跑通使命系统');
assert.equal(activeMissionSnapshot(first.store).approval.sourceAuthority, 'explicit_user');
assert.deepEqual(first.events.map((event) => event.type), [MISSION_EVENT_TYPES.VERSION_ACTIVATED, MISSION_EVENT_TYPES.CAMPAIGN_ACTIVATED, MISSION_EVENT_TYPES.PRIORITY_CHANGED, MISSION_EVENT_TYPES.PORTFOLIO_RECLASSIFIED, MISSION_EVENT_TYPES.PORTFOLIO_RECLASSIFIED]);
assert.equal(new Set(first.events.map((event) => event.eventId)).size, first.events.length);

const secondDraft = { ...first.store.draft, campaign: { ...first.store.draft.campaign, title: '验证使命系统连续性' }, portfolio: { ...first.store.draft.portfolio, b: { ...first.store.draft.portfolio.b, class: 'waiting' } } };
const second = publishMissionVersion({ ...first.store, draft: secondDraft }, mainlines, { now: new Date('2026-08-10T08:00:00Z'), sourceAuthority: 'explicit_user' });
assert.equal(second.version, 2);
assert.equal(second.store.draft.missionId, first.store.draft.missionId);
assert.equal(second.events.filter((event) => event.type === MISSION_EVENT_TYPES.PORTFOLIO_RECLASSIFIED).length, 1);
assert.equal(second.events.find((event) => event.type === MISSION_EVENT_TYPES.PORTFOLIO_RECLASSIFIED).payload.from, 'maintenance');

const v2Claim = {
  claimId: 'claim-mission-v2', candidateLineId: 'cl-mission-v2', recordType: 'claim', domain: 'mission',
  content: '现金流项目不能永远吃掉全部重心', authority: 'user_interpretation', epistemicState: 'asserted', confidence: 0.6,
  sourceRef: '/reviews/2026-07-02.md#L73', activity: { activityStart: null, activityEnd: null, dateMapping: 'unknown', sequenceEligible: false },
};
const adapted = adaptMissionV2Candidate(v2Claim, { importedAt: '2026-08-10T01:00:00.000Z' });
assert.equal(adapted.v2Layer, 'claim');
assert.equal(adapted.authority, 'user_interpretation');
assert.equal(adapted.epistemicState, 'asserted');
assert.equal(adapted.sourceRef, '/reviews/2026-07-02.md#L73');
assert.equal(adapted.dateMapping, 'unknown');
assert.deepEqual(adapted.activity, v2Claim.activity);
assert.equal(adaptMissionV2Candidate({ ...v2Claim, domain: 'health' }), null, 'non-mission candidate must be rejected');

const v2Pattern = { patternId: 'pattern-mission-v2', domain: 'mission', status: 'candidate_unvalidated', statement: '候选模式，不是事实', authority: 'ai_summary', evidenceRefs: ['source:a'] };
const v2Proposal = { proposalId: 'cal-proposal-mission-v2', domain: 'mission', status: 'proposed', title: '使命校准实验', authority: 'ai_derived', evidenceRefs: ['metric:a'] };
const parsedV2 = parseMissionV2Text(`${JSON.stringify(v2Claim)}\n${JSON.stringify(v2Pattern)}\n${JSON.stringify(v2Proposal)}\nnot-json`, { importedAt: '2026-08-10T01:00:00.000Z' });
assert.deepEqual(parsedV2.candidates.map((item) => item.v2Layer), ['claim', 'pattern_candidate', 'calibration_proposal']);
assert.equal(parsedV2.rejected.length, 1);

const imported = importMissionCandidates(first.store, parsedV2.candidates);
assert.equal(imported.imported, 3);
assert.equal(imported.store.activeVersion, 1, 'candidate import must not change activeVersion');
assert.equal(imported.store.candidateInbox.every((item) => item.decision.status === MISSION_CANDIDATE_DECISIONS.UNREVIEWED), true);
const omittedCandidateDecision = decideMissionCandidate(imported.store, 'claim-mission-v2', MISSION_CANDIDATE_DECISIONS.INCLUDED);
assert.match(omittedCandidateDecision.error, /用户明确/);
assert.deepEqual(omittedCandidateDecision.store, imported.store, 'omitted candidate authority must not mutate inbox or draft evidence');
assert.equal(omittedCandidateDecision.store.activeVersion, 1);
assert.equal(omittedCandidateDecision.store.history.length, imported.store.history.length);
assert.equal(omittedCandidateDecision.store.events.length, imported.store.events.length);
const illegalCandidateDecision = decideMissionCandidate(imported.store, 'claim-mission-v2', MISSION_CANDIDATE_DECISIONS.INCLUDED, { sourceAuthority: 'admin' });
assert.match(illegalCandidateDecision.error, /用户明确/);
assert.deepEqual(illegalCandidateDecision.store, imported.store, 'illegal candidate authority must not mutate the store');
for (const authorization of [
  { standingRuleId: MISSION_HQ_STANDING_RULE_ID },
  { standingRuleId: 'wrong-rule', action: 'decide_mission_candidate:included_in_draft', objectId: 'claim-mission-v2', expectedResult: '纳入草稿' },
  { standingRuleId: MISSION_HQ_STANDING_RULE_ID, action: 'decide_mission_candidate:ignored', objectId: 'claim-mission-v2', expectedResult: '纳入草稿' },
  { standingRuleId: MISSION_HQ_STANDING_RULE_ID, action: 'decide_mission_candidate:included_in_draft', objectId: 'wrong-candidate', expectedResult: '纳入草稿' },
]) {
  const result = decideMissionCandidate(imported.store, 'claim-mission-v2', MISSION_CANDIDATE_DECISIONS.INCLUDED, { sourceAuthority: 'standing_rule', authorization });
  assert.match(result.error, /长期授权/);
  assert.deepEqual(result.store, imported.store);
}
const standingCandidate = decideMissionCandidate(imported.store, 'claim-mission-v2', MISSION_CANDIDATE_DECISIONS.INCLUDED, {
  now: new Date('2026-08-10T01:59:00Z'), sourceAuthority: 'standing_rule', authorization: {
    standingRuleId: MISSION_HQ_STANDING_RULE_ID,
    action: 'decide_mission_candidate:included_in_draft',
    objectId: 'claim-mission-v2',
    expectedResult: '将该候选纳入使命草稿证据链但不自动发布',
  },
});
const standingDecision = standingCandidate.store.candidateInbox.find((item) => item.candidateId === 'claim-mission-v2').decision;
assert.equal(standingCandidate.error, null);
assert.equal(standingDecision.decidedBy, 'standing_rule');
assert.equal(standingDecision.standingRuleId, MISSION_HQ_STANDING_RULE_ID);
assert.equal(standingCandidate.store.activeVersion, 1, 'standing candidate decision must not publish');
const ignored = decideMissionCandidate(imported.store, 'pattern-mission-v2', MISSION_CANDIDATE_DECISIONS.IGNORED, { now: new Date('2026-08-10T02:00:00Z'), sourceAuthority: 'explicit_user' });
assert.equal(ignored.store.reviewContext.candidateRefs.length, 0);
const observing = decideMissionCandidate(ignored.store, 'cal-proposal-mission-v2', MISSION_CANDIDATE_DECISIONS.OBSERVING, { now: new Date('2026-08-10T02:01:00Z'), sourceAuthority: 'explicit_user' });
assert.equal(observing.store.reviewContext.candidateRefs.length, 0);
const included = decideMissionCandidate(observing.store, 'claim-mission-v2', MISSION_CANDIDATE_DECISIONS.INCLUDED, { now: new Date('2026-08-10T02:02:00Z'), sourceAuthority: 'explicit_user' });
assert.deepEqual(included.store.reviewContext.candidateRefs, ['claim-mission-v2']);
assert.equal(included.store.activeVersion, 1, 'include in draft still must not publish');
assert.equal(activeMissionSnapshot(included.store).snapshot.campaign.title, '跑通使命系统');
assert.equal(buildMissionHqSnapshot(included.store, { mainlines, now: new Date('2026-08-10T03:00:00Z') }).summary.hasPendingDraft, true);
const deniedCandidateDecision = decideMissionCandidate(imported.store, 'claim-mission-v2', MISSION_CANDIDATE_DECISIONS.INCLUDED, { sourceAuthority: 'ai_derived' });
assert.match(deniedCandidateDecision.error, /用户明确/);

const reviewReady = updateMissionReviewContext({ ...included.store, draft: secondDraft }, {
  triggerDecision: '我决定把当前战役改为验证使命系统连续性', externalEvidenceRefs: ['external:decision-note'],
  judgmentChanges: { retained: ['长期使命'], withdrawn: ['旧节奏'], replaced: ['跑通 → 连续验证'] },
});
assert.equal(reviewReady.activeVersion, 1);
const deniedReviewPublish = publishMissionVersion(reviewReady, mainlines, { sourceAuthority: 'ai_derived' });
assert.equal(deniedReviewPublish.version, null, 'draft inclusion never bypasses explicit publication approval');
const reviewedPublication = publishMissionVersion(reviewReady, mainlines, { now: new Date('2026-08-10T04:00:00Z'), sourceAuthority: 'explicit_user' });
const reviewedHistory = activeMissionSnapshot(reviewedPublication.store);
assert.equal(reviewedHistory.evidenceChain.triggerDecision, '我决定把当前战役改为验证使命系统连续性');
assert.deepEqual(reviewedHistory.evidenceChain.candidateRefs, ['claim-mission-v2']);
assert.deepEqual(reviewedHistory.evidenceChain.externalEvidenceRefs, ['external:decision-note']);
assert.deepEqual(reviewedHistory.evidenceChain.judgmentChanges.withdrawn, ['旧节奏']);
assert.equal(reviewedHistory.evidenceChain.approvedBy, 'explicit_user');
assert.equal(reviewedHistory.evidenceChain.approvedAt, '2026-08-10T04:00:00.000Z');
assert.equal(reviewedPublication.store.candidateInbox.find((item) => item.candidateId === 'claim-mission-v2').decision.publishedVersionId, reviewedHistory.versionId);
assert.deepEqual(reviewedPublication.store.reviewContext.candidateRefs, []);

const unpublishedHq = buildMissionHqSnapshot({ draft });
assert.equal(unpublishedHq.status, 'unknown');
assert.equal(unpublishedHq.generatedAt, null);
assert.equal(unpublishedHq.summary.statement, null, 'draft content must not leak into the HQ fact summary');
const missionHq = buildMissionHqSnapshot({ ...first.store, draft: secondDraft }, { mainlines, now: new Date('2026-08-10T00:00:00Z') });
assert.equal(missionHq.systemId, 'mission');
assert.equal(missionHq.schemaVersion, 1);
assert.equal(missionHq.status, 'healthy');
assert.equal(missionHq.summary.campaignTitle, '跑通使命系统');
assert.notEqual(missionHq.summary.campaignTitle, secondDraft.campaign.title, 'pending draft must not replace activeVersion facts');
assert.equal(missionHq.summary.hasPendingDraft, true);
assert.deepEqual(missionHq.summary.pendingDiffFields, ['campaign', 'portfolio']);
assert.equal(missionHq.sourceRefs.includes(first.store.history[0].approval.approvalId), true);
const staleMissionHq = buildMissionHqSnapshot(first.store, { mainlines, now: new Date('2026-09-03T00:00:00Z') });
assert.equal(staleMissionHq.status, 'stale');

const evidence = deriveMissionEvidence({
  store: first.store,
  mainlines,
  tasks: [{ id: 'task-a', mainlineId: 'a', updatedAt: '2026-08-08T10:00:00Z' }, { id: 'task-b', mainlineId: 'b', updatedAt: '2026-08-08T10:00:00Z', isCompleted: true, completedAt: '2026-08-08T11:00:00Z' }],
  timePlans: [{ date: '2026-08-08', focusTaskId: 'task-b', focusStart: '09:00', focusEnd: '11:00', actualFocusMinutes: 120 }],
  dailyReviews: [{ reviewDate: '2026-08-08', todayEvidence: { completed: 1 } }],
  now: new Date('2026-08-09T12:00:00Z'),
});
assert.equal(evidence.status, 'observed');
assert.equal(evidence.totalActualMinutes, 120);
assert.equal(evidence.rows.find((row) => row.mainlineId === 'b').actualShare, 100);
assert.equal(evidence.rows.find((row) => row.mainlineId === 'b').completedTasks, 1);
assert.equal(evidence.reviewCoverage, 1);
assert.equal(evidence.mismatches[0].mainlineId, 'a');
assert.equal(evidence.mismatches[0].type, MISSION_EVENT_TYPES.REVIEW_REQUIRED);
assert.equal(first.store.events.some((event) => event.type === MISSION_EVENT_TYPES.REVIEW_REQUIRED), false);

const insufficient = deriveMissionEvidence({ store: first.store, mainlines, tasks: [], timePlans: [], now: new Date('2026-08-09T12:00:00Z') });
assert.equal(insufficient.status, 'insufficient');
assert.deepEqual(insufficient.mismatches, []);

console.log('mission model tests passed');
