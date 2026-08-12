import { importMissionCandidates } from './mission-model.js';
import { adaptMissionV2Candidate } from './mission-v2-adapter.js';
import { importHealthCandidates } from './health-model.js';
import { importTimeCandidates } from './time-attention-model.js';
import { normalizeExecutionCandidates } from './execution-model.js';
import { importV2FeedbackCandidates } from './feedback-model.js';

export const FIVE_SYSTEM_BOOTSTRAP_STATE_KEY = 'taskbox_five_system_bootstrap_v1';
const STORE_KEYS = Object.freeze({
  mission: 'taskbox_mission_os_v1',
  health: 'taskbox_health_energy_os_v1',
  time: 'taskbox_time_attention_os_v1',
  execution: 'taskbox_execution_v2_candidates_v1',
  feedback: 'taskbox_feedback_evolution_os_v1',
});
const DOMAINS = ['mission', 'health', 'time', 'execution', 'feedback'];
const EXPECTED_COUNTS = Object.freeze({ mission: 72, health: 84, time: 135, execution: 375, feedback: 790 });

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

export async function parseFiveSystemBootstrapFile(file) {
  if (!file) throw new Error('未选择初始化包');
  return JSON.parse(await file.text());
}
