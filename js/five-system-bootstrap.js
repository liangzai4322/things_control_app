import { importMissionCandidates } from './mission-model.js';
import { adaptMissionV2Candidate } from './mission-v2-adapter.js';
import { importHealthCandidates } from './health-model.js';
import { importTimeCandidates } from './time-attention-model.js';
import { normalizeExecutionCandidates } from './execution-model.js';
import { importV2FeedbackCandidates } from './feedback-model.js';

export const FIVE_SYSTEM_BOOTSTRAP_STATE_KEY = 'taskbox_five_system_bootstrap_v1';
export const FIVE_SYSTEM_BASELINE_HISTORY_KEY = 'taskbox_five_system_baseline_history_v1';
const STORE_KEYS = Object.freeze({
  mission: 'taskbox_mission_os_v1',
  health: 'taskbox_health_energy_os_v1',
  time: 'taskbox_time_attention_os_v1',
  execution: 'taskbox_execution_v2_candidates_v1',
  feedback: 'taskbox_feedback_evolution_os_v1',
});
const DOMAINS = ['mission', 'health', 'time', 'execution', 'feedback'];
const EXPECTED_COUNTS = Object.freeze({ mission: 72, health: 84, time: 135, execution: 375, feedback: 790 });
const BASELINE_KEYS = Object.freeze([...Object.values(STORE_KEYS), FIVE_SYSTEM_BOOTSTRAP_STATE_KEY]);

const parse = (value, fallback) => {
  try { return JSON.parse(value ?? '') ?? fallback; } catch { return fallback; }
};
const countByDomain = (records) => Object.fromEntries(DOMAINS.map((domain) => [domain, records.filter((item) => item?.domain === domain).length]));

export function validateFiveSystemBootstrapPackage(payload = {}) {
  const errors = [];
  if (payload.schemaVersion !== 'five-system-bootstrap-v1') errors.push('初始化包版本不受支持');
  if (payload.dataset?.runId !== 'historical-daily-review-backfill-v2-2026-06-29_2026-08-08') errors.push('初始化包不是首轮30日V2数据');
  const claims = Array.isArray(payload.claimsObservations) ? payload.claimsObservations : [];
  const counts = countByDomain(claims);
  DOMAINS.forEach((domain) => { if (counts[domain] !== EXPECTED_COUNTS[domain]) errors.push(`${domain}候选应为${EXPECTED_COUNTS[domain]}条，实际${counts[domain]}条`); });
  if ((payload.validatedFacts || []).length) errors.push('初始化包不得包含validated facts');
  if (!Array.isArray(payload.semanticClusters) || payload.semanticClusters.length !== 22) errors.push('语义簇应为22条');
  if (!Array.isArray(payload.patternCandidates) || payload.patternCandidates.length !== 42) errors.push('模式候选应为42条');
  if (!Array.isArray(payload.calibrationProposals) || payload.calibrationProposals.length !== 5) errors.push('校准提案应为5条');
  if (payload.permissions?.writesTargetSystems !== false || payload.permissions?.createsTaskboxTasks !== false || payload.permissions?.activatesRulesOrExperiments !== false) errors.push('初始化包权限断言不完整');
  return { valid: errors.length === 0, errors, counts };
}

export function readFiveSystemBootstrapState(storage = localStorage) {
  return parse(storage.getItem(FIVE_SYSTEM_BOOTSTRAP_STATE_KEY), null);
}

export function readFiveSystemBaselineHistory(storage = localStorage) {
  const value = parse(storage.getItem(FIVE_SYSTEM_BASELINE_HISTORY_KEY), []);
  return Array.isArray(value) ? value : [];
}

const snapshotStores = (storage) => Object.fromEntries(BASELINE_KEYS.map((key) => [key, storage.getItem(key)]));
const restoreStores = (storage, snapshot = {}) => BASELINE_KEYS.forEach((key) => {
  const value = Object.hasOwn(snapshot, key) ? snapshot[key] : null;
  if (value == null) storage.removeItem(key); else storage.setItem(key, value);
});

function appendBaselineVersion(storage, version) {
  const history = readFiveSystemBaselineHistory(storage);
  storage.setItem(FIVE_SYSTEM_BASELINE_HISTORY_KEY, JSON.stringify([...history, version].slice(-2)));
}

function promoteHistoricalBaseline(storage, state, { now, authorization }) {
  if (authorization?.sourceAuthority !== 'explicit_user') throw new Error('发布历史基线需要用户明确授权');
  const publishedAt = now.toISOString();
  const versionNumber = Math.max(0, ...readFiveSystemBaselineHistory(storage).map((item) => Number(item.versionNumber) || 0)) + 1;
  const versionId = `five-system-baseline-v${versionNumber}`;
  const mission = parse(storage.getItem(STORE_KEYS.mission), {});
  const health = parse(storage.getItem(STORE_KEYS.health), {});
  const time = parse(storage.getItem(STORE_KEYS.time), {});
  const execution = parse(storage.getItem(STORE_KEYS.execution), []);
  const feedback = parse(storage.getItem(STORE_KEYS.feedback), {});

  const missionIncluded = (mission.candidateInbox || []).map((item) => ({
    ...item,
    decision: {
      status: 'included_in_draft', decidedAt: publishedAt, decidedBy: 'explicit_user', publishedVersionId: versionId,
    },
  }));
  const healthCandidates = (health.candidates || []).map((item) => ({
    ...item,
    status: item.temporalEligible && item.recordType !== 'source_proposal' ? 'confirmed' : 'context_only',
    resolvedAt: publishedAt,
    resolvedBy: 'explicit_user',
    decisionId: `${versionId}:health:${item.candidateId}`,
    observationId: item.temporalEligible && item.recordType !== 'source_proposal' ? `health-observation-baseline-${item.candidateId}` : null,
  }));
  const historicalObservations = healthCandidates.filter((item) => item.status === 'confirmed').map((item) => ({
    observationId: item.observationId,
    date: item.activityStart,
    notes: item.content,
    source: 'daily_review',
    confidence: item.authority === 'external_evidence' ? 0.7 : 0.6,
    observedAt: publishedAt,
    candidateId: item.candidateId,
    sourceRef: item.sourceRef,
    authority: item.authority,
    dateMapping: item.dateMapping,
  }));
  const observationById = new Map([...(health.observations || []), ...historicalObservations].map((item) => [item.observationId, item]));
  const timeCandidates = (time.candidates || []).map((item) => {
    const baselineFact = Boolean(item.recordType !== 'source_proposal' && item.activityStart && item.activityStart === item.activityEnd && !['unknown', 'range', 'next-day-range'].includes(item.dateMapping));
    return {
      ...item,
      status: baselineFact ? 'baseline_fact' : 'baseline_context',
      baselineFact,
      baselineVersionId: versionId,
      validatedFact: baselineFact,
      confirmedAt: publishedAt,
    };
  });
  const executionBaseline = execution.map((item) => ({
    ...item,
    factStatus: 'historical_baseline',
    baselineVersionId: versionId,
    baselinePublishedAt: publishedAt,
    taskStatus: 'not_a_current_task',
  }));
  const feedbackPatterns = (feedback.v2Candidates?.patternCandidates || []).map((item) => ({
    ...item,
    status: item.status === 'candidate_unvalidated' ? 'observed' : item.status,
    observedAt: item.observedAt || publishedAt,
    supportingEvidence: item.supportingEvidence?.length ? item.supportingEvidence : item.evidenceRefs,
    transitionLog: [...(item.transitionLog || []), {
      from: item.status,
      to: item.status === 'candidate_unvalidated' ? 'observed' : item.status,
      at: publishedAt,
      authority: 'explicit_user',
      baselineVersionId: versionId,
    }],
  }));
  const promotedCounts = {
    mission: missionIncluded.length,
    healthObservations: historicalObservations.length,
    healthContext: healthCandidates.length - historicalObservations.length,
    timeFacts: timeCandidates.filter((item) => item.status === 'baseline_fact').length,
    timeContext: timeCandidates.filter((item) => item.status === 'baseline_context').length,
    executionHistory: executionBaseline.length,
    feedbackObservedPatterns: feedbackPatterns.filter((item) => item.status === 'observed').length,
    feedbackProposals: feedback.v2Candidates?.calibrationProposals?.length || 0,
    taskboxTasksCreated: 0,
  };
  storage.setItem(STORE_KEYS.mission, JSON.stringify({ ...mission, candidateInbox: missionIncluded, updatedAt: publishedAt }));
  storage.setItem(STORE_KEYS.health, JSON.stringify({ ...health, observations: [...observationById.values()], candidates: healthCandidates, updatedAt: publishedAt }));
  storage.setItem(STORE_KEYS.time, JSON.stringify({ ...time, candidates: timeCandidates, factsUpdatedAt: publishedAt }));
  storage.setItem(STORE_KEYS.execution, JSON.stringify(executionBaseline));
  storage.setItem(STORE_KEYS.feedback, JSON.stringify({
    ...feedback,
    v2Candidates: { ...feedback.v2Candidates, patternCandidates: feedbackPatterns },
    updatedAt: publishedAt,
  }));
  storage.setItem(FIVE_SYSTEM_BOOTSTRAP_STATE_KEY, JSON.stringify({
    ...state,
    mode: 'published_baseline',
    activeBaselineVersion: versionId,
    publishedAt,
    publishedBy: 'explicit_user',
    promotedCounts,
  }));
  return { versionId, versionNumber, publishedAt, promotedCounts };
}

export function applyFiveSystemBootstrap(payload, storage = localStorage, { now = new Date() } = {}) {
  const validation = validateFiveSystemBootstrapPackage(payload);
  if (!validation.valid) return { ok: false, errors: validation.errors, state: readFiveSystemBootstrapState(storage) };
  const snapshot = Object.fromEntries([...Object.values(STORE_KEYS), FIVE_SYSTEM_BOOTSTRAP_STATE_KEY].map((key) => [key, storage.getItem(key)]));
  const readStore = (key) => parse(storage.getItem(key), {});
  try {
    const importedAt = now.toISOString();
    const claims = payload.claimsObservations;
    const missionCandidates = [
      ...claims.map((item) => adaptMissionV2Candidate(item, { importedAt })).filter(Boolean),
      ...payload.calibrationProposals.map((item) => adaptMissionV2Candidate(item, { importedAt })).filter(Boolean),
    ];
    const mission = importMissionCandidates(readStore(STORE_KEYS.mission), missionCandidates).store;
    const health = importHealthCandidates(readStore(STORE_KEYS.health), claims, importedAt);
    const time = importTimeCandidates(readStore(STORE_KEYS.time), claims).store;
    const existingExecution = parse(storage.getItem(STORE_KEYS.execution), []);
    const execution = normalizeExecutionCandidates([...existingExecution, ...claims]).candidates;
    const feedbackResult = importV2FeedbackCandidates(readStore(STORE_KEYS.feedback), {
      importId: payload.dataset.runId,
      datasetVersion: payload.dataset.pipelineVersion,
      sourceRef: payload.dataset.sourceRef,
      observationsClaims: claims,
      semanticClusters: payload.semanticClusters,
      patternCandidates: payload.patternCandidates,
      calibrationProposals: payload.calibrationProposals,
    }, { now });
    if (feedbackResult.error) throw new Error(feedbackResult.error);
    const state = {
      schemaVersion: 1,
      runId: payload.dataset.runId,
      packageSha256: payload.packageSha256 || null,
      appliedAt: importedAt,
      reviewRange: payload.dataset.reviewRange,
      sourceReviewCount: payload.dataset.sourceReviewCount,
      counts: {
        mission: mission.candidateInbox.length,
        health: health.candidates.length,
        time: time.candidates.length,
        execution: execution.length,
        feedbackClaims: feedbackResult.store.v2Candidates.observationsClaims.length,
        feedbackPatterns: feedbackResult.store.v2Candidates.patternCandidates.length,
        feedbackProposals: feedbackResult.store.v2Candidates.calibrationProposals.length,
        validatedFacts: 0,
      },
    };
    storage.setItem(STORE_KEYS.mission, JSON.stringify(mission));
    storage.setItem(STORE_KEYS.health, JSON.stringify(health));
    storage.setItem(STORE_KEYS.time, JSON.stringify(time));
    storage.setItem(STORE_KEYS.execution, JSON.stringify(execution));
    storage.setItem(STORE_KEYS.feedback, JSON.stringify(feedbackResult.store));
    storage.setItem(FIVE_SYSTEM_BOOTSTRAP_STATE_KEY, JSON.stringify(state));
    return { ok: true, errors: [], state };
  } catch (error) {
    Object.entries(snapshot).forEach(([key, value]) => { if (value == null) storage.removeItem(key); else storage.setItem(key, value); });
    return { ok: false, errors: [String(error?.message || error)], state: readFiveSystemBootstrapState(storage) };
  }
}

export function publishFiveSystemBaseline(payload, storage = localStorage, { now = new Date(), authorization = {} } = {}) {
  const before = snapshotStores(storage);
  const historyBefore = storage.getItem(FIVE_SYSTEM_BASELINE_HISTORY_KEY);
  try {
    const imported = applyFiveSystemBootstrap(payload, storage, { now });
    if (!imported.ok) return imported;
    const version = promoteHistoricalBaseline(storage, imported.state, { now, authorization });
    appendBaselineVersion(storage, {
      schemaVersion: 1,
      ...version,
      runId: payload.dataset.runId,
      packageSha256: payload.packageSha256 || null,
      previousActiveVersion: readFiveSystemBootstrapState({ getItem: (key) => before[key] })?.activeBaselineVersion || null,
      before,
    });
    return { ok: true, errors: [], state: readFiveSystemBootstrapState(storage), version };
  } catch (error) {
    restoreStores(storage, before);
    if (historyBefore == null) storage.removeItem(FIVE_SYSTEM_BASELINE_HISTORY_KEY);
    else storage.setItem(FIVE_SYSTEM_BASELINE_HISTORY_KEY, historyBefore);
    return { ok: false, errors: [String(error?.message || error)], state: readFiveSystemBootstrapState(storage) };
  }
}

export function rollbackFiveSystemBaseline(storage = localStorage, { versionId = null, now = new Date(), authorization = {} } = {}) {
  if (authorization?.sourceAuthority !== 'explicit_user') return { ok: false, errors: ['回退历史基线需要用户明确授权'], state: readFiveSystemBootstrapState(storage) };
  const history = readFiveSystemBaselineHistory(storage);
  const index = versionId ? history.findIndex((item) => item.versionId === versionId) : history.length - 1;
  const version = history[index];
  if (!version?.before) return { ok: false, errors: ['找不到可回退的历史基线版本'], state: readFiveSystemBootstrapState(storage) };
  restoreStores(storage, version.before);
  const remaining = history.slice(0, index);
  storage.setItem(FIVE_SYSTEM_BASELINE_HISTORY_KEY, JSON.stringify(remaining));
  const restored = readFiveSystemBootstrapState(storage);
  if (restored) storage.setItem(FIVE_SYSTEM_BOOTSTRAP_STATE_KEY, JSON.stringify({ ...restored, rolledBackAt: now.toISOString(), rolledBackBy: 'explicit_user' }));
  return { ok: true, errors: [], rolledBackVersion: version.versionId, state: readFiveSystemBootstrapState(storage) };
}

export async function parseFiveSystemBootstrapFile(file) {
  if (!file) throw new Error('未选择初始化包');
  return JSON.parse(await file.text());
}
