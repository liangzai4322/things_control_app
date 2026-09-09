export const MISSION_STORAGE_KEY = 'taskbox_mission_os_v1';
export const MISSION_SCHEMA_VERSION = 3;
export const MISSION_HQ_STANDING_RULE_ID = 'mission-hq-specific-actions-2026-08-23';
export const MISSION_CANDIDATE_DECISIONS = Object.freeze({
  UNREVIEWED: 'unreviewed', IGNORED: 'ignored', OBSERVING: 'observing', INCLUDED: 'included_in_draft',
});
export const MISSION_PORTFOLIO_CLASSES = Object.freeze({ primary: '主战', maintenance: '维护', exploration: '探索', waiting: '等待', stopped: '停止' });
export const MISSION_EVENT_TYPES = Object.freeze({
  VERSION_ACTIVATED: 'MissionVersionActivated',
  CAMPAIGN_ACTIVATED: 'CampaignActivated',
  PRIORITY_CHANGED: 'StrategicPriorityChanged',
  PORTFOLIO_RECLASSIFIED: 'PortfolioItemReclassified',
  REVIEW_REQUIRED: 'StrategicReviewRequired',
});

const clean = (value) => String(value || '').trim();
const lines = (value) => [...new Set((Array.isArray(value) ? value : String(value || '').split(/\r?\n/)).map(clean).filter(Boolean))];
const date = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value || '') ? value : '';
const timestamp = (value) => value && !Number.isNaN(new Date(value).getTime()) ? value : null;
const stableId = (value, fallback) => clean(value) || fallback;
const eventId = (version, type, subject = '') => `mission:v${version}:${type}${subject ? `:${subject}` : ''}`;
const clone = (value, fallback = null) => {
  try { return value == null ? fallback : JSON.parse(JSON.stringify(value)); }
  catch { return fallback; }
};
const portfolioItem = (mainlineId, value = {}) => ({
  itemId: stableId(value.itemId, `portfolio:${mainlineId}`),
  mainlineId,
  class: Object.hasOwn(MISSION_PORTFOLIO_CLASSES, value.class) ? value.class : 'waiting',
  strategicContribution: clean(value.strategicContribution),
  resourceShare: Math.min(100, Math.max(0, Number(value.resourceShare) || 0)),
  replacementTarget: clean(value.replacementTarget) || null,
});

function authorizeMissionAction(sourceAuthority, authorization, action, objectId) {
  if (sourceAuthority === 'explicit_user') return { sourceAuthority, standingRuleId: null, action, objectId, expectedResult: null };
  if (sourceAuthority !== 'standing_rule'
    || authorization?.standingRuleId !== MISSION_HQ_STANDING_RULE_ID
    || authorization?.action !== action
    || authorization?.objectId !== objectId
    || !clean(authorization?.expectedResult)) return null;
  return {
    sourceAuthority,
    standingRuleId: MISSION_HQ_STANDING_RULE_ID,
    action,
    objectId,
    expectedResult: clean(authorization.expectedResult),
  };
}

export const emptyMissionDraft = () => ({
  missionId: 'mission-001', statement: '', constraints: [], nonNegotiables: [],
  campaign: { campaignId: 'campaign-001', title: '', whyNow: '', successConditions: [], exitConditions: [], reviewAt: '' },
  portfolio: {}, notDoing: [],
});

export function normalizeMissionDraft(value = {}) {
  return {
    missionId: stableId(value.missionId, 'mission-001'),
    statement: clean(value.statement), constraints: lines(value.constraints), nonNegotiables: lines(value.nonNegotiables),
    campaign: {
      campaignId: stableId(value.campaign?.campaignId, 'campaign-001'),
      title: clean(value.campaign?.title), whyNow: clean(value.campaign?.whyNow),
      successConditions: lines(value.campaign?.successConditions), exitConditions: lines(value.campaign?.exitConditions),
      reviewAt: date(value.campaign?.reviewAt),
    },
    portfolio: Object.fromEntries(Object.entries(value.portfolio || {}).map(([mainlineId, item]) => [mainlineId, portfolioItem(mainlineId, item)])),
    notDoing: lines(value.notDoing),
  };
}

function normalizeApproval(value = {}, version = 0, activatedAt = null, missionId = 'mission-001') {
  if (!version) return null;
  const explicit = value.sourceAuthority === 'explicit_user' || value.approvedBy === 'explicit_user';
  const standing = value.sourceAuthority === 'standing_rule'
    && value.standingRuleId === MISSION_HQ_STANDING_RULE_ID
    && value.action === 'publish_mission_version'
    && value.objectId === missionId
    && Boolean(clean(value.expectedResult));
  return {
    approvalId: stableId(value.approvalId, `mission-approval-v${version}`),
    sourceAuthority: explicit ? 'explicit_user' : standing ? 'standing_rule' : null,
    standingRuleId: standing ? MISSION_HQ_STANDING_RULE_ID : null,
    approvedAt: timestamp(value.approvedAt || activatedAt),
    action: 'publish_mission_version',
    objectId: standing ? missionId : clean(value.objectId) || null,
    expectedResult: standing ? clean(value.expectedResult) : clean(value.expectedResult) || null,
  };
}

function normalizeHistoryItem(item = {}) {
  const version = Math.max(0, Number(item.version) || 0);
  const activatedAt = timestamp(item.activatedAt);
  const snapshot = normalizeMissionDraft(item.snapshot);
  const approval = normalizeApproval(item.approval || item, version, activatedAt, snapshot.missionId);
  return {
    version,
    versionId: stableId(item.versionId, `${item.snapshot?.missionId || 'mission-001'}:v${version}`),
    activatedAt,
    approval,
    snapshot,
    evidenceChain: normalizeEvidenceChain(item.evidenceChain, approval, activatedAt),
  };
}

function normalizeJudgmentChanges(value = {}) {
  return { retained: lines(value.retained), withdrawn: lines(value.withdrawn), replaced: lines(value.replaced) };
}

function normalizeEvidenceChain(value = {}, approval = {}, approvedAt = null) {
  const approvedBy = value.approvedBy === 'explicit_user' || approval.sourceAuthority === 'explicit_user'
    ? 'explicit_user'
    : approval.sourceAuthority === 'standing_rule' ? 'standing_rule' : null;
  return {
    triggerDecision: clean(value.triggerDecision) || '用户明确批准当前使命草稿',
    candidateRefs: lines(value.candidateRefs),
    externalEvidenceRefs: lines(value.externalEvidenceRefs),
    judgmentChanges: normalizeJudgmentChanges(value.judgmentChanges),
    approvedBy,
    approvedAt: timestamp(value.approvedAt || approvedAt),
  };
}

const emptyReviewContext = () => ({ triggerDecision: '', candidateRefs: [], externalEvidenceRefs: [], judgmentChanges: normalizeJudgmentChanges() });

function normalizeReviewContext(value = {}) {
  return {
    triggerDecision: clean(value.triggerDecision), candidateRefs: lines(value.candidateRefs),
    externalEvidenceRefs: lines(value.externalEvidenceRefs), judgmentChanges: normalizeJudgmentChanges(value.judgmentChanges),
  };
}

function normalizeCandidateDecision(value = {}, candidateId = '') {
  const allowed = new Set(Object.values(MISSION_CANDIDATE_DECISIONS));
  const status = allowed.has(value.status) ? value.status : MISSION_CANDIDATE_DECISIONS.UNREVIEWED;
  const standing = value.decidedBy === 'standing_rule'
    && value.standingRuleId === MISSION_HQ_STANDING_RULE_ID
    && value.action === `decide_mission_candidate:${status}`
    && value.objectId === candidateId
    && Boolean(clean(value.expectedResult));
  return {
    status,
    decidedAt: timestamp(value.decidedAt),
    decidedBy: value.decidedBy === 'explicit_user' ? 'explicit_user' : standing ? 'standing_rule' : null,
    standingRuleId: standing ? MISSION_HQ_STANDING_RULE_ID : null,
    action: standing ? value.action : null,
    objectId: standing ? candidateId : null,
    expectedResult: standing ? clean(value.expectedResult) : null,
    publishedVersionId: clean(value.publishedVersionId) || null,
  };
}

function normalizeMissionCandidate(value = {}) {
  const layer = ['observation', 'claim', 'pattern_candidate', 'calibration_proposal'].includes(value.v2Layer) ? value.v2Layer : null;
  const candidateId = clean(value.candidateId);
  if (!candidateId || value.domain !== 'mission' || !layer) return null;
  return {
    candidateId, candidateLineId: clean(value.candidateLineId) || null, domain: 'mission', v2Layer: layer,
    content: clean(value.content), authority: clean(value.authority) || 'unknown', epistemicState: clean(value.epistemicState) || 'unknown',
    sourceRef: clone(value.sourceRef), evidenceRefs: clone(value.evidenceRefs, []), dateMapping: clone(value.dateMapping, 'unknown'),
    activity: clone(value.activity), confidence: Number.isFinite(Number(value.confidence)) ? Number(value.confidence) : null,
    importedAt: timestamp(value.importedAt), decision: normalizeCandidateDecision(value.decision, candidateId),
  };
}

function normalizeEvent(value = {}) {
  return {
    eventId: clean(value.eventId), type: clean(value.type), occurredAt: timestamp(value.occurredAt),
    version: Math.max(0, Number(value.version) || 0), subjectId: clean(value.subjectId) || null,
    payload: value.payload && typeof value.payload === 'object' ? { ...value.payload } : {},
    approvalId: clean(value.approvalId) || null,
  };
}

export function normalizeMissionStore(value = {}) {
  const history = (Array.isArray(value.history) ? value.history : []).filter((item) => item?.version && item?.snapshot).map(normalizeHistoryItem).sort((a, b) => a.version - b.version);
  const activeVersion = history.some((item) => item.version === Number(value.activeVersion)) ? Number(value.activeVersion) : null;
  const candidateInbox = (Array.isArray(value.candidateInbox) ? value.candidateInbox : []).map(normalizeMissionCandidate).filter(Boolean);
  return {
    schemaVersion: MISSION_SCHEMA_VERSION,
    draft: normalizeMissionDraft(value.draft), activeVersion, history,
    events: (Array.isArray(value.events) ? value.events : []).map(normalizeEvent).filter((item) => item.eventId && item.type && item.version),
    candidateInbox: [...new Map(candidateInbox.map((item) => [item.candidateId, item])).values()],
    reviewContext: normalizeReviewContext(value.reviewContext),
    updatedAt: timestamp(value.updatedAt),
  };
}

export function importMissionCandidates(input = {}, candidates = []) {
  const store = normalizeMissionStore(input);
  const existing = new Map(store.candidateInbox.map((item) => [item.candidateId, item]));
  let imported = 0;
  candidates.map(normalizeMissionCandidate).filter(Boolean).forEach((item) => {
    const previous = existing.get(item.candidateId);
    existing.set(item.candidateId, previous ? { ...item, decision: previous.decision } : item);
    if (!previous) imported += 1;
  });
  return { imported, store: normalizeMissionStore({ ...store, candidateInbox: [...existing.values()] }) };
}

export function decideMissionCandidate(input = {}, candidateId, status, { now = new Date(), sourceAuthority = null, authorization = null } = {}) {
  const store = normalizeMissionStore(input);
  const action = `decide_mission_candidate:${status}`;
  const approval = authorizeMissionAction(sourceAuthority, authorization, action, candidateId);
  if (!approval) return { store, error: '候选裁决必须由用户明确执行或符合使命系统长期授权' };
  if (![MISSION_CANDIDATE_DECISIONS.IGNORED, MISSION_CANDIDATE_DECISIONS.OBSERVING, MISSION_CANDIDATE_DECISIONS.INCLUDED].includes(status)) return { store, error: '未知候选裁决' };
  if (!store.candidateInbox.some((item) => item.candidateId === candidateId)) return { store, error: '找不到候选' };
  const decidedAt = new Date(now).toISOString();
  const candidateInbox = store.candidateInbox.map((item) => item.candidateId === candidateId ? { ...item, decision: {
    status, decidedAt, decidedBy: approval.sourceAuthority, standingRuleId: approval.standingRuleId,
    action: approval.action, objectId: approval.objectId, expectedResult: approval.expectedResult, publishedVersionId: null,
  } } : item);
  let candidateRefs = store.reviewContext.candidateRefs.filter((ref) => ref !== candidateId);
  if (status === MISSION_CANDIDATE_DECISIONS.INCLUDED) candidateRefs = [...candidateRefs, candidateId];
  return { error: null, store: normalizeMissionStore({ ...store, candidateInbox, reviewContext: { ...store.reviewContext, candidateRefs } }) };
}

export function updateMissionReviewContext(input = {}, value = {}) {
  const store = normalizeMissionStore(input);
  return normalizeMissionStore({ ...store, reviewContext: { ...store.reviewContext, ...value, judgmentChanges: { ...store.reviewContext.judgmentChanges, ...(value.judgmentChanges || {}) } } });
}

export function validateMissionDraft(input = {}, mainlines = []) {
  const draft = normalizeMissionDraft(input); const errors = [];
  if (!draft.statement) errors.push('长期使命不能为空');
  if (!draft.campaign.title) errors.push('当前主战役不能为空');
  if (!draft.campaign.whyNow) errors.push('必须说明为什么是现在');
  if (!draft.campaign.successConditions.length) errors.push('至少填写一个成功条件');
  if (!draft.campaign.exitConditions.length) errors.push('至少填写一个退出条件');
  if (!draft.campaign.reviewAt) errors.push('必须设置战略复查日期');
  const known = new Set(mainlines.map((item) => item.id)); const portfolio = Object.entries(draft.portfolio).filter(([id]) => known.has(id));
  if (portfolio.filter(([, item]) => item.class === 'primary').length > 1) errors.push('项目组合只能有一个主战项目');
  if (portfolio.filter(([, item]) => ['primary', 'maintenance', 'exploration'].includes(item.class)).reduce((sum, [, item]) => sum + item.resourceShare, 0) > 100) errors.push('活动项目资源权重合计不能超过100%');
  return { valid: !errors.length, errors, draft };
}

function publicationEvents(version, snapshot, previous, activatedAt, approvalId) {
  const shared = { occurredAt: activatedAt, version, approvalId };
  const events = [
    { ...shared, eventId: eventId(version, MISSION_EVENT_TYPES.VERSION_ACTIVATED), type: MISSION_EVENT_TYPES.VERSION_ACTIVATED, subjectId: snapshot.missionId, payload: { versionId: `${snapshot.missionId}:v${version}` } },
    { ...shared, eventId: eventId(version, MISSION_EVENT_TYPES.CAMPAIGN_ACTIVATED), type: MISSION_EVENT_TYPES.CAMPAIGN_ACTIVATED, subjectId: snapshot.campaign.campaignId, payload: { title: snapshot.campaign.title, reviewAt: snapshot.campaign.reviewAt } },
  ];
  if (!previous || previous.campaign.title !== snapshot.campaign.title) events.push({ ...shared, eventId: eventId(version, MISSION_EVENT_TYPES.PRIORITY_CHANGED), type: MISSION_EVENT_TYPES.PRIORITY_CHANGED, subjectId: snapshot.campaign.campaignId, payload: { from: previous?.campaign.title || null, to: snapshot.campaign.title } });
  const ids = new Set([...Object.keys(previous?.portfolio || {}), ...Object.keys(snapshot.portfolio)]);
  ids.forEach((mainlineId) => {
    const before = previous?.portfolio?.[mainlineId]?.class || null; const after = snapshot.portfolio[mainlineId]?.class || null;
    if (before !== after) events.push({ ...shared, eventId: eventId(version, MISSION_EVENT_TYPES.PORTFOLIO_RECLASSIFIED, mainlineId), type: MISSION_EVENT_TYPES.PORTFOLIO_RECLASSIFIED, subjectId: snapshot.portfolio[mainlineId]?.itemId || previous?.portfolio?.[mainlineId]?.itemId || `portfolio:${mainlineId}`, payload: { mainlineId, from: before, to: after } });
  });
  return events;
}

export function publishMissionVersion(input, mainlines = [], { now = new Date(), sourceAuthority = null, authorization = null } = {}) {
  const store = normalizeMissionStore(input); const check = validateMissionDraft(store.draft, mainlines);
  const actionApproval = authorizeMissionAction(sourceAuthority, authorization, 'publish_mission_version', check.draft.missionId);
  if (!actionApproval) return { store, errors: ['战略发布必须由用户明确批准或符合使命系统长期授权'], version: null, events: [] };
  if (!check.valid) return { store, errors: check.errors, version: null, events: [] };
  const version = Math.max(0, ...store.history.map((item) => item.version)) + 1; const activatedAt = new Date(now).toISOString();
  const approval = { approvalId: `mission-approval-v${version}`, ...actionApproval, approvedAt: activatedAt };
  const previous = activeMissionSnapshot(store)?.snapshot || null;
  const versionId = `${check.draft.missionId}:v${version}`;
  const evidenceChain = normalizeEvidenceChain({ ...store.reviewContext, approvedBy: approval.sourceAuthority, approvedAt: activatedAt }, approval, activatedAt);
  const historyItem = { version, versionId, activatedAt, approval, snapshot: check.draft, evidenceChain };
  const events = publicationEvents(version, check.draft, previous, activatedAt, approval.approvalId);
  const candidateRefs = new Set(evidenceChain.candidateRefs);
  const candidateInbox = store.candidateInbox.map((item) => candidateRefs.has(item.candidateId) ? { ...item, decision: { ...item.decision, publishedVersionId: versionId } } : item);
  return { errors: [], version, events, store: normalizeMissionStore({ ...store, draft: check.draft, activeVersion: version, history: [...store.history, historyItem], events: [...store.events, ...events], candidateInbox, reviewContext: emptyReviewContext(), updatedAt: activatedAt }) };
}

export function activeMissionSnapshot(input = {}) { const store = normalizeMissionStore(input); return store.history.find((item) => item.version === store.activeVersion) || null; }

export function buildMissionHqSnapshot(input = {}, { mainlines = [], now = new Date(), portfolioDriftCount = 0 } = {}) {
  const store = normalizeMissionStore(input);
  const active = activeMissionSnapshot(store);
  const empty = {
    snapshotId: 'mission-hq:unpublished', systemId: 'mission', schemaVersion: 1,
    generatedAt: null, effectiveDate: null, sourceRefs: [], confidence: 0,
    status: 'unknown', summary: {
      activeVersionId: null, statement: null, campaignId: null, campaignTitle: null,
      reviewAt: null, successConditionCount: 0, exitConditionCount: 0,
      stopDoingCount: 0, portfolioDriftCount: 0, lastApprovedAt: null,
      hasPendingDraft: Boolean(store.draft.statement || store.draft.campaign.title || store.reviewContext.candidateRefs.length),
      pendingDiffFields: [],
    }, constraints: [],
  };
  if (!active || !['explicit_user', 'standing_rule'].includes(active.approval?.sourceAuthority) || !active.activatedAt) return empty;
  const snapshot = active.snapshot;
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date(now));
  const knownMainlines = new Set((Array.isArray(mainlines) ? mainlines : []).map((item) => item.id));
  const missingMappings = knownMainlines.size
    ? Object.keys(snapshot.portfolio).filter((mainlineId) => !knownMainlines.has(mainlineId)).length
    : 0;
  const driftCount = Math.max(0, Number(portfolioDriftCount) || 0) + missingMappings;
  const hasPendingDraft = JSON.stringify(normalizeMissionDraft(store.draft)) !== JSON.stringify(snapshot) || store.reviewContext.candidateRefs.length > 0;
  const pendingDiffFields = hasPendingDraft ? [
    ['statement', store.draft.statement, snapshot.statement],
    ['campaign', store.draft.campaign, snapshot.campaign],
    ['portfolio', store.draft.portfolio, snapshot.portfolio],
    ['constraints', store.draft.constraints, snapshot.constraints],
    ['nonNegotiables', store.draft.nonNegotiables, snapshot.nonNegotiables],
    ['notDoing', store.draft.notDoing, snapshot.notDoing],
    ['candidateRefs', store.reviewContext.candidateRefs, []],
  ].filter(([, pending, published]) => JSON.stringify(pending) !== JSON.stringify(published)).map(([field]) => field) : [];
  let status = 'healthy';
  if (snapshot.campaign.reviewAt && snapshot.campaign.reviewAt < today) status = 'stale';
  else if (driftCount > 0) status = 'attention';
  return {
    snapshotId: `mission-hq:${active.versionId}`,
    systemId: 'mission',
    schemaVersion: 1,
    generatedAt: active.activatedAt,
    effectiveDate: active.activatedAt.slice(0, 10),
    sourceRefs: [active.versionId, active.approval.approvalId, ...store.events.filter((event) => event.version === active.version).map((event) => event.eventId)].filter(Boolean),
    confidence: 1,
    status,
    summary: {
      activeVersionId: active.versionId,
      statement: snapshot.statement,
      campaignId: snapshot.campaign.campaignId,
      campaignTitle: snapshot.campaign.title,
      reviewAt: snapshot.campaign.reviewAt || null,
      successConditionCount: snapshot.campaign.successConditions.length,
      exitConditionCount: snapshot.campaign.exitConditions.length,
      stopDoingCount: snapshot.notDoing.length,
      portfolioDriftCount: driftCount,
      lastApprovedAt: active.approval.approvedAt || active.activatedAt,
      hasPendingDraft,
      pendingDiffFields,
    },
    constraints: [],
  };
}

const dayKey = (value) => {
  const parsed = new Date(value || 0);
  return Number.isNaN(parsed.getTime()) ? '' : new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(parsed);
};
const clockMinutes = (value) => { const match = /^(\d{2}):(\d{2})$/.exec(value || ''); return match ? Number(match[1]) * 60 + Number(match[2]) : null; };

export function deriveMissionEvidence({ store: input = {}, mainlines = [], tasks = [], timePlans = [], dailyReviews = [], now = new Date(), windowDays = 7 } = {}) {
  const active = activeMissionSnapshot(input); const end = dayKey(now); const startDate = new Date(`${end}T00:00:00.000Z`); startDate.setUTCDate(startDate.getUTCDate() - Math.max(1, windowDays) + 1); const start = dayKey(startDate);
  const reviewRows = dailyReviews.filter((item) => item?.reviewDate >= start && item.reviewDate <= end);
  if (!active) return { status: 'unpublished', start, end, rows: [], totalActualMinutes: 0, mismatches: [], reviewCoverage: reviewRows.length };
  const snapshot = active.snapshot; const mainlineById = new Map(mainlines.map((item) => [item.id, item])); const taskById = new Map(tasks.map((item) => [item.id, item]));
  const plans = timePlans.filter((item) => item?.date >= start && item.date <= end);
  const rows = Object.entries(snapshot.portfolio).map(([mainlineId, item]) => {
    const relatedTasks = tasks.filter((task) => task.mainlineId === mainlineId && !task.deleted && !task.isRecurringTemplate);
    const touched = relatedTasks.filter((task) => dayKey(task.updatedAt || task.createdAt) >= start && dayKey(task.updatedAt || task.createdAt) <= end);
    const completed = relatedTasks.filter((task) => task.isCompleted && dayKey(task.completedAt || task.completionReceipt?.completedAt) >= start && dayKey(task.completedAt || task.completionReceipt?.completedAt) <= end);
    const relatedPlans = plans.filter((plan) => taskById.get(plan.focusTaskId)?.mainlineId === mainlineId);
    const actualMinutes = relatedPlans.reduce((sum, plan) => sum + (Number.isFinite(Number(plan.actualFocusMinutes)) ? Math.max(0, Number(plan.actualFocusMinutes)) : 0), 0);
    const plannedMinutes = relatedPlans.reduce((sum, plan) => { const a = clockMinutes(plan.focusStart); const b = clockMinutes(plan.focusEnd); return sum + (a != null && b != null && b > a ? b - a : 0); }, 0);
    return { ...item, mainlineId, title: mainlineById.get(mainlineId)?.name || '已移除的主线', sourceAvailable: mainlineById.has(mainlineId), actualMinutes, plannedMinutes, touchedTasks: touched.length, completedTasks: completed.length, evidenceRefs: [...new Set([...relatedPlans.map((plan) => `time:${plan.date}`), ...touched.map((task) => `task:${task.id}`)])] };
  });
  const totalActualMinutes = rows.reduce((sum, row) => sum + row.actualMinutes, 0);
  rows.forEach((row) => { row.actualShare = totalActualMinutes ? Math.round(row.actualMinutes / totalActualMinutes * 100) : null; });
  const mismatches = totalActualMinutes < 60 ? [] : rows.filter((row) => ['primary', 'maintenance'].includes(row.class) && (row.class === 'primary' ? row.actualMinutes === 0 || row.actualShare + 20 < row.resourceShare : row.resourceShare >= 20 && row.actualShare + 20 < row.resourceShare)).map((row) => ({ type: MISSION_EVENT_TYPES.REVIEW_REQUIRED, mainlineId: row.mainlineId, itemId: row.itemId, title: row.title, declaredShare: row.resourceShare, actualShare: row.actualShare, actualMinutes: row.actualMinutes, reason: row.actualMinutes === 0 ? '已声明为主战，但近7日记录投入为0' : `近7日实际投入比声明低 ${row.resourceShare - row.actualShare} 个百分点` }));
  const todayReview = reviewRows.find((item) => item.reviewDate === end);
  return { status: totalActualMinutes ? 'observed' : 'insufficient', start, end, rows, totalActualMinutes, mismatches, reviewCoverage: reviewRows.length, todayEvidence: todayReview?.todayEvidence || null };
}
