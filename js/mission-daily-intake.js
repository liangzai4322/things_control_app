import { requestTaskboxApi } from './db.js';
import { MISSION_CANDIDATE_DECISIONS, activeMissionSnapshot, buildMissionHqSnapshot, normalizeMissionStore } from './mission-model.js';
import { MISSION_SYNC_STORAGE_KEY, readMissionStore } from './mission-store.js';

export const MISSION_DAILY_INTAKE_STORAGE_KEY = 'taskbox_mission_daily_intake_v1';
export const MISSION_DAILY_INTAKE_SCHEMA = 'daily-mission-intake-v1';
export const MISSION_DAILY_INTAKE_MAX_AGE_MS = 36 * 60 * 60 * 1000;
export const MISSION_DAILY_INTAKE_RESULTS = Object.freeze({
  NO_CHANGE: 'no_change',
  CANDIDATE_RECORDED: 'candidate_recorded',
  NEEDS_DECISION: 'needs_decision',
  INVALID: 'invalid',
  SYNC_CONFLICT: 'sync_conflict',
});

// The shared transport owns the exact version string. Callers may narrow this
// list during rollout; unknown versions are never consumed optimistically.
export const SUPPORTED_SYSTEM_CANDIDATE_CONTRACTS = Object.freeze(['2026-09-03.1']);

const clean = (value) => String(value || '').trim();
const clone = (value, fallback = null) => {
  try { return value == null ? fallback : JSON.parse(JSON.stringify(value)); }
  catch { return fallback; }
};
const validDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value || '');
const validTimestamp = (value) => Boolean(value) && !Number.isNaN(new Date(value).getTime());
const stableStringify = (value) => {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
};
const digest = (value) => {
  const text = stableStringify(value); let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) { hash ^= text.charCodeAt(index); hash = Math.imul(hash, 16777619); }
  return (hash >>> 0).toString(16).padStart(8, '0');
};

export function readMissionDailyIntakeLedger(storage = localStorage) {
  try {
    const parsed = JSON.parse(storage.getItem(MISSION_DAILY_INTAKE_STORAGE_KEY) || '{}');
    return { schemaVersion: 1, entries: parsed.entries && typeof parsed.entries === 'object' ? parsed.entries : {} };
  } catch { return { schemaVersion: 1, entries: {} }; }
}

function writeMissionDailyIntakeLedger(ledger, storage) {
  storage.setItem(MISSION_DAILY_INTAKE_STORAGE_KEY, JSON.stringify({ schemaVersion: 1, entries: ledger.entries || {} }));
}

function missionSyncIsConflicted(storage) {
  try { return JSON.parse(storage.getItem(MISSION_SYNC_STORAGE_KEY) || '{}').status === 'conflict'; }
  catch { return false; }
}

export function validateMissionDailyIntake(intake, {
  now = new Date(),
  supportedContractVersions = SUPPORTED_SYSTEM_CANDIDATE_CONTRACTS,
} = {}) {
  const errors = [];
  const data = intake?.data;
  if (!intake || typeof intake !== 'object' || !data || typeof data !== 'object') return { valid: false, errors: ['intake_not_object'], data: null };
  if (!clean(intake.id)) errors.push('intake_id_required');
  if (!clean(intake.idempotencyKey) || !Number.isInteger(Number(intake.revision)) || Number(intake.revision) < 1) errors.push('transport_identity_invalid');
  if (Number(intake.schemaVersion) !== 1) errors.push('transport_schema_unsupported');
  if (!supportedContractVersions.includes(intake.contractVersion)) errors.push('contract_version_unsupported');
  if (intake.systemId !== 'mission' || data.targetSystem !== 'mission') errors.push('wrong_target_system');
  if (data.sourceSystem !== 'daily-review') errors.push('wrong_source_system');
  if (data.schemaVersion !== MISSION_DAILY_INTAKE_SCHEMA) errors.push('domain_schema_unsupported');
  if (data.intakeId !== intake.id || data.idempotencyKey !== intake.idempotencyKey) errors.push('identity_mismatch');
  if (data.writesTargetSystem !== false) errors.push('write_boundary_violated');
  if (data.epistemicState !== 'candidate_unvalidated') errors.push('epistemic_state_invalid');
  if (!validDate(intake.reviewDate) || data.reviewDate !== intake.reviewDate) errors.push('review_date_invalid');
  if (!validTimestamp(data.generatedAt)) errors.push('generated_at_invalid');
  else {
    const age = new Date(now).getTime() - new Date(data.generatedAt).getTime();
    if (age > MISSION_DAILY_INTAKE_MAX_AGE_MS || age < -5 * 60 * 1000) errors.push('intake_not_current');
  }
  if (intake.freshness !== 'current' || data.evidenceCoverage?.freshness !== 'current') errors.push('evidence_not_current');
  if (!data.baseline || !['known', 'unknown'].includes(data.baseline.baselineState)) errors.push('baseline_invalid');
  if (!data.observedProgress || data.observedProgress.assessmentIsFormalStatus !== false) errors.push('formal_status_boundary_violated');
  if (data.observedProgress && !['milestoneChanges', 'commitmentResults', 'deviationSignals'].every((key) => Array.isArray(data.observedProgress[key]))) errors.push('observed_progress_shape_invalid');
  if (!Array.isArray(data.evidenceRefs) || !Array.isArray(data.evidenceCoverage?.missingSources)) errors.push('evidence_shape_invalid');
  return { valid: errors.length === 0, errors, data };
}

function hasCandidateContent(data) {
  const observed = data.observedProgress || {};
  return Boolean(
    clean(observed.progressSummary)
    || (observed.campaignAssessment && !['no_evidence', 'unknown'].includes(observed.campaignAssessment))
    || ['milestoneChanges', 'commitmentResults', 'deviationSignals'].some((key) => Array.isArray(observed[key]) && observed[key].length)
    || (Array.isArray(data.evidenceRefs) && data.evidenceRefs.length)
  );
}

function requiresDecision(data) {
  const observed = data.observedProgress || {};
  return data.conditional?.requiresDecision === true
    || ['at_risk', 'blocked'].includes(observed.campaignAssessment)
    || (Array.isArray(observed.deviationSignals) && observed.deviationSignals.length > 0);
}

function currentActiveVersionId(store) { return activeMissionSnapshot(store)?.versionId || null; }

export function classifyMissionDailyIntake(intake, storeInput = {}, {
  storage = null,
  now = new Date(),
  supportedContractVersions = SUPPORTED_SYSTEM_CANDIDATE_CONTRACTS,
} = {}) {
  const store = normalizeMissionStore(storeInput);
  const checked = validateMissionDailyIntake(intake, { now, supportedContractVersions });
  if (!checked.valid) return { result: MISSION_DAILY_INTAKE_RESULTS.INVALID, errors: checked.errors, decisionRequired: false };
  const sourceActiveVersionId = checked.data.baseline.activeVersionId ?? null;
  if (checked.data.baseline.baselineState !== 'known' || sourceActiveVersionId !== currentActiveVersionId(store) || (storage && missionSyncIsConflicted(storage))) {
    return { result: MISSION_DAILY_INTAKE_RESULTS.SYNC_CONFLICT, errors: ['active_version_baseline_conflict'], decisionRequired: true };
  }
  if (!hasCandidateContent(checked.data)) return { result: MISSION_DAILY_INTAKE_RESULTS.NO_CHANGE, errors: [], decisionRequired: false };
  if (requiresDecision(checked.data)) return { result: MISSION_DAILY_INTAKE_RESULTS.NEEDS_DECISION, errors: [], decisionRequired: true };
  return { result: MISSION_DAILY_INTAKE_RESULTS.CANDIDATE_RECORDED, errors: [], decisionRequired: false };
}

export function buildMissionIntakeProjection(storeInput = {}, ledgerInput = {}, receipt = null, { now = new Date() } = {}) {
  const store = normalizeMissionStore(storeInput);
  const active = activeMissionSnapshot(store);
  const hq = buildMissionHqSnapshot(store, { now });
  const intakeDecisions = Object.values(ledgerInput.entries || {}).filter((entry) => entry.decisionRequired).length;
  const candidateDecisions = store.candidateInbox.filter((item) => item.decision.status === MISSION_CANDIDATE_DECISIONS.UNREVIEWED).length;
  return {
    schemaVersion: 1,
    systemId: 'mission',
    activeVersion: active ? {
      versionId: active.versionId,
      statement: active.snapshot.statement,
      campaignId: active.snapshot.campaign.campaignId,
      campaignTitle: active.snapshot.campaign.title,
      reviewAt: active.snapshot.campaign.reviewAt || null,
      approvedAt: active.approval?.approvedAt || active.activatedAt,
    } : null,
    pending: {
      hasPendingDraft: hq.summary.hasPendingDraft,
      pendingDiffFields: hq.summary.pendingDiffFields,
      decisionRequiredCount: intakeDecisions + candidateDecisions,
    },
    ...(receipt ? { intakeReceipt: receipt } : {}),
  };
}

function receiptStatus(result) {
  if (result === MISSION_DAILY_INTAKE_RESULTS.INVALID) return 'failed';
  if (result === MISSION_DAILY_INTAKE_RESULTS.SYNC_CONFLICT) return 'retrying';
  return 'processed';
}

function ledgerKey(intake) { return `${clean(intake.id)}::${Number(intake.revision) || 0}`; }

function immutableIntakePayload(intake) {
  return {
    id: intake?.id, schemaVersion: intake?.schemaVersion, contractVersion: intake?.contractVersion,
    systemId: intake?.systemId, reviewDate: intake?.reviewDate, observationPeriod: intake?.observationPeriod,
    sourceRef: intake?.sourceRef, evidenceRefs: intake?.evidenceRefs, freshness: intake?.freshness,
    revision: intake?.revision, idempotencyKey: intake?.idempotencyKey, data: intake?.data,
  };
}

export function prepareMissionDailyIntakeReceipt(intake, storeInput, ledgerInput, {
  storage = null,
  now = new Date(),
  supportedContractVersions = SUPPORTED_SYSTEM_CANDIDATE_CONTRACTS,
} = {}) {
  const key = ledgerKey(intake);
  const existing = ledgerInput.entries?.[key];
  const payloadDigest = digest(immutableIntakePayload(intake));
  if (existing) {
    if (existing.payloadDigest !== payloadDigest) {
      const classified = { result: MISSION_DAILY_INTAKE_RESULTS.SYNC_CONFLICT, errors: ['same_revision_payload_changed'], decisionRequired: true };
      return { key, replay: false, conflict: true, payloadDigest, classified, body: null };
    }
    return { key, replay: true, payloadDigest, classified: existing.classified, body: clone(existing.body) };
  }
  const classified = classifyMissionDailyIntake(intake, storeInput, { storage, now, supportedContractVersions });
  const receipt = {
    intakeId: clean(intake.id),
    processedAt: new Date(now).toISOString(),
    result: classified.result,
    candidateCountDelta: [MISSION_DAILY_INTAKE_RESULTS.CANDIDATE_RECORDED, MISSION_DAILY_INTAKE_RESULTS.NEEDS_DECISION].includes(classified.result) ? 1 : 0,
    decisionRequiredCount: classified.decisionRequired ? 1 : 0,
    sourceActiveVersionId: intake?.data?.baseline?.activeVersionId ?? null,
  };
  const nextLedger = clone(ledgerInput, { schemaVersion: 1, entries: {} });
  nextLedger.entries[key] = { payloadDigest, classified, body: null, intake: clone(intake), processedAt: receipt.processedAt, decisionRequired: classified.decisionRequired };
  const projection = buildMissionIntakeProjection(storeInput, nextLedger, receipt, { now });
  const body = {
    status: receiptStatus(classified.result),
    idempotencyKey: `mission-intake-receipt:${clean(intake.id)}:r${Number(intake.revision) || 0}:${bodyTransition(receiptStatus(classified.result))}`,
    projection,
    ...(classified.errors.length ? { errorCode: classified.errors[0], errorMessage: classified.errors.join(',') } : {}),
  };
  return { key, replay: false, payloadDigest, classified, body };
}

function bodyTransition(status) { return status === 'retrying' ? 'retrying' : status === 'failed' ? 'failed' : 'processed'; }

export async function consumeMissionDailyIntakes({
  request = requestTaskboxApi,
  storage = localStorage,
  now = new Date(),
  supportedContractVersions = SUPPORTED_SYSTEM_CANDIDATE_CONTRACTS,
} = {}) {
  const response = await request('/system-candidates?systemId=mission&intake=1&limit=100');
  if (!response) return { connected: false, processed: [], decisionRequiredCount: 0 };
  if (!Array.isArray(response.intakes)) return { connected: true, compatible: false, processed: [], decisionRequiredCount: 0 };
  const storeBefore = readMissionStore(storage);
  const immutableBefore = stableStringify(storeBefore);
  const ledger = readMissionDailyIntakeLedger(storage);
  const processed = [];
  for (const intake of response.intakes) {
    if (['processed', 'ignored'].includes(intake.status)) continue;
    const prepared = prepareMissionDailyIntakeReceipt(intake, storeBefore, ledger, { storage, now, supportedContractVersions });
    const entry = ledger.entries[prepared.key];
    if (prepared.conflict) {
      if (entry) { entry.receiptConflict = true; entry.decisionRequired = true; writeMissionDailyIntakeLedger(ledger, storage); }
      processed.push({ intakeId: intake.id, revision: intake.revision, result: MISSION_DAILY_INTAKE_RESULTS.SYNC_CONFLICT, receiptStatus: null, replay: false });
      continue;
    }
    if (!prepared.replay) {
      ledger.entries[prepared.key] = {
        payloadDigest: prepared.payloadDigest, classified: prepared.classified, body: prepared.body,
        intake: clone(intake), processedAt: prepared.body.projection.intakeReceipt.processedAt,
        decisionRequired: prepared.classified.decisionRequired,
      };
      writeMissionDailyIntakeLedger(ledger, storage);
    }
    try {
      await request(`/system-candidates/${encodeURIComponent(intake.id)}/receipt`, { method: 'POST', body: JSON.stringify(prepared.body) });
      processed.push({ intakeId: intake.id, revision: intake.revision, result: prepared.body.projection.intakeReceipt.result, receiptStatus: prepared.body.status, replay: prepared.replay });
    } catch (error) {
      if (error?.status === 409) {
        const saved = ledger.entries[prepared.key] || entry;
        if (saved) { saved.receiptConflict = true; writeMissionDailyIntakeLedger(ledger, storage); }
        processed.push({ intakeId: intake.id, revision: intake.revision, result: MISSION_DAILY_INTAKE_RESULTS.SYNC_CONFLICT, receiptStatus: 'retrying', replay: prepared.replay });
        continue;
      }
      throw error;
    }
  }
  if (stableStringify(readMissionStore(storage)) !== immutableBefore) throw new Error('mission_fact_boundary_violated');
  return {
    connected: true,
    compatible: true,
    processed,
    decisionRequiredCount: Object.values(ledger.entries).filter((entry) => entry.decisionRequired || entry.receiptConflict).length,
  };
}

export async function mountMissionDailyIntake(app, beforeSelector) {
  const host = document.createElement('section');
  host.className = 'system-daily-candidates';
  host.dataset.missionDailyIntake = 'true';
  host.innerHTML = '<header><div><span>DAILY REVIEW INTAKE · CANDIDATE ONLY</span><h2>日省使命观察</h2></div><p>正在核对……</p></header>';
  const before = app.querySelector(beforeSelector); if (before) before.before(host); else app.querySelector('main')?.append(host);
  try {
    const result = await consumeMissionDailyIntakes();
    const recorded = result.processed.filter((item) => item.result === MISSION_DAILY_INTAKE_RESULTS.CANDIDATE_RECORDED).length;
    host.innerHTML = `<header><div><span>DAILY REVIEW INTAKE · CANDIDATE ONLY</span><h2>日省使命观察</h2></div><p>${result.connected ? `${recorded} 条新观察 · ${result.decisionRequiredCount} 条待决策` : 'API 未连接'}</p></header><p class="system-candidate-rule">只记录未验证候选与处理回执；不会改写草稿、正式使命、战役状态、任务或跨系统规则。</p>${result.compatible === false ? '<div class="system-candidate-empty">服务端仍是旧候选协议，本轮未消费。</div>' : ''}`;
  } catch {
    host.innerHTML = '<header><div><span>DAILY REVIEW INTAKE · CANDIDATE ONLY</span><h2>日省使命观察</h2></div><p>同步失败</p></header><div class="system-candidate-empty">使命主体仍可独立使用；本轮没有改写正式事实。</div>';
  }
}
