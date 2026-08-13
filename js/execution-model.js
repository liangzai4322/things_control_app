import {
  buildHqActionState,
  isHqExecutableTaskRecord,
  normalizeHqBrief,
  selectHqCommitments,
} from './hq-model.js';

const dateKey = (value, timeZone = 'Asia/Shanghai') => {
  const date = new Date(value || 0);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-CA', { timeZone }).format(date);
};

const number = (value) => Math.max(0, Math.min(100, Number(value) || 0));
const text = (value) => String(value || '').trim();
const V2_RECORD_TYPES = new Set(['observation', 'claim', 'source_proposal']);
const V2_AUTHORITIES = new Set(['external_evidence', 'user_interpretation', 'ai_summary']);

function isV2CandidateRecord(value = {}) {
  return Boolean(value?.candidateLineId || V2_RECORD_TYPES.has(value?.recordType) || value?.layer === 'candidate');
}

function candidateDateMapping(value = {}) {
  return text(value?.activity?.dateMapping || value?.dateMapping) || 'unknown';
}

function proposalTitle(value = '') {
  return text(value)
    .replace(/^[-*+]\s*/, '')
    .replace(/^\[[ xX]\]\s*/, '')
    .replace(/^\*\*(.*?)\**:?\s*/, '$1 ')
    .trim();
}

export function normalizeExecutionCandidates(records = []) {
  const byClaimId = new Map();
  const rejected = [];
  (Array.isArray(records) ? records : []).forEach((record) => {
    const candidateId = text(record?.candidateLineId || record?.candidateId);
    const claimId = text(record?.claimId || record?.recordId || candidateId);
    const recordType = text(record?.recordType);
    const sourceRef = text(record?.sourceRef);
    const authority = text(record?.authority);
    const content = text(record?.content || record?.sourceExcerpt);
    if (record?.domain !== 'execution') return;
    if (!candidateId || !claimId || !sourceRef || !content || !V2_RECORD_TYPES.has(recordType) || !V2_AUTHORITIES.has(authority)) {
      rejected.push({ claimId: claimId || null, reason: 'invalid_v2_candidate_contract' });
      return;
    }
    const activity = record.activity && typeof record.activity === 'object' ? record.activity : {};
    const dateMapping = candidateDateMapping(record);
    byClaimId.set(claimId, {
      candidateId,
      claimId,
      recordType,
      domain: 'execution',
      content,
      sourceRef,
      authority,
      epistemicState: text(record.epistemicState) || 'uncertain',
      reviewDate: text(record.reviewDate) || null,
      dateMapping,
      sequenceEligible: Boolean(record.sequenceEligible ?? activity.sequenceEligible) && dateMapping !== 'unknown',
      lineKind: text(record.lineKind) || null,
      confidence: Number.isFinite(Number(record.confidence)) ? Number(record.confidence) : null,
      layer: 'candidate',
      factStatus: record.factStatus === 'historical_baseline' ? 'historical_baseline' : 'unvalidated',
      baselineVersionId: text(record.baselineVersionId) || null,
      baselinePublishedAt: text(record.baselinePublishedAt) || null,
      taskStatus: record.taskStatus === 'not_a_current_task' ? 'not_a_current_task' : 'not_a_task',
      readOnly: true,
    });
  });
  const candidates = [...byClaimId.values()].sort((left, right) => (
    String(right.reviewDate || '').localeCompare(String(left.reviewDate || ''))
    || left.claimId.localeCompare(right.claimId)
  ));
  return {
    candidates,
    rejected,
    metrics: {
      total: candidates.length,
      sourceProposalCount: candidates.filter((item) => item.recordType === 'source_proposal').length,
      checkboxCount: candidates.filter((item) => item.lineKind === 'checkbox').length,
      unknownDateCount: candidates.filter((item) => item.dateMapping === 'unknown').length,
      validatedFactCount: 0,
      taskCount: 0,
    },
  };
}

export function buildExecutionProposalDraft(candidate = {}, {
  title = '', completionCriteria = '', commitmentDate = null,
} = {}) {
  const normalized = normalizeExecutionCandidates([candidate]).candidates[0];
  if (!normalized) throw new Error('invalid_execution_candidate');
  const actionTitle = proposalTitle(title || normalized.content);
  if (!actionTitle) throw new Error('proposal_title_required');
  return {
    schemaVersion: 1,
    interface: 'hq_proposal_create_input',
    proposalType: 'daily_action_proposal',
    sourceAuthority: 'ai_derived',
    title: actionTitle,
    idempotencyKey: `v2-execution-candidate:${normalized.claimId}`,
    shadowMode: true,
    content: {
      candidateId: normalized.candidateId,
      claimId: normalized.claimId,
      candidateRecordType: normalized.recordType,
      candidateAuthority: normalized.authority,
      dateMapping: normalized.dateMapping,
      factStatus: 'unvalidated',
    },
    evidence: {
      sourceRef: normalized.sourceRef,
      reviewDate: normalized.reviewDate,
      epistemicState: normalized.epistemicState,
      confidence: normalized.confidence,
    },
    sourceRef: {
      type: 'v2_execution_candidate',
      candidateId: normalized.candidateId,
      claimId: normalized.claimId,
      sourceRef: normalized.sourceRef,
    },
    taskSpec: {
      content: actionTitle,
      note: text(completionCriteria),
      commitmentDate: text(commitmentDate) || null,
      role: 'primary',
    },
    workflow: {
      state: 'interface_draft',
      writesTaskBox: false,
      requires: ['hq_proposal_creation', 'explicit_user_approval', 'idempotent_promote'],
    },
  };
}

export function taskExecutionReadiness(task = {}, { committed = false } = {}) {
  const missing = [];
  if (!text(task.content)) missing.push('下一步动作');
  if (!text(task.note)) missing.push('完成标准');
  if (!committed && !task.scheduledAt && !task.dueDate) missing.push('执行时段');
  return { ready: missing.length === 0, missing };
}

export function taskSourceProposalId(task = {}) {
  const direct = text(task.proposalDecisionId || task.sourceDecisionId);
  if (direct) return direct;
  const syncKey = text(task.syncKey);
  return syncKey.startsWith('hq-proposal:') ? syncKey.slice('hq-proposal:'.length) : null;
}

function openTask(task) {
  return Boolean(task?.id
    && !isV2CandidateRecord(task)
    && !task.deleted
    && !task.isCompleted
    && !task.isRecurringTemplate);
}

function newestFirst(left, right) {
  return new Date(right.updatedAt || right.completedAt || right.createdAt || 0).getTime()
    - new Date(left.updatedAt || left.completedAt || left.createdAt || 0).getTime();
}

export function deriveExecutionState({
  tasks = [], boxes = [], brief: briefInput = {}, reviewDate = dateKey(new Date()), mainlines = [], syncState = {},
} = {}) {
  const brief = normalizeHqBrief(briefInput, reviewDate);
  const visible = tasks.filter((task) => task?.id
    && isHqExecutableTaskRecord(task)
    && !isV2CandidateRecord(task)
    && !task.deleted
    && !task.isRecurringTemplate);
  const boxById = new Map(boxes.map((box) => [box.id, box]));
  const actionState = buildHqActionState(visible, brief, reviewDate, mainlines);
  const selected = selectHqCommitments(visible, brief, reviewDate, mainlines);
  const maintenance = selected.maintenance.filter((task) => task.id !== actionState.currentAction?.id).slice(0, 2);
  const committedIds = new Set([actionState.currentAction?.id, ...maintenance.map((task) => task.id)].filter(Boolean));
  const relevantOpen = visible.filter((task) => openTask(task) && (
    committedIds.has(task.id)
    || task.commitmentDate === reviewDate
    || number(task.progress) > 0
    || task.deferredAt
    || task.deferNote
    || dateKey(task.scheduledAt) === reviewDate
    || dateKey(task.dueDate) === reviewDate
  ));

  const lanes = { preparation: [], active: [], waiting: [] };
  relevantOpen.forEach((task) => {
    const committed = committedIds.has(task.id);
    const readiness = taskExecutionReadiness(task, { committed });
    const item = {
      ...task,
      boxName: boxById.get(task.boxId)?.name || '行动盒子',
      readiness,
      approvedProposalId: taskSourceProposalId(task),
    };
    if (task.deferredAt || text(task.deferNote)) lanes.waiting.push(item);
    else if (!readiness.ready) lanes.preparation.push(item);
    else if (committed || number(task.progress) > 0) lanes.active.push(item);
    else lanes.preparation.push(item);
  });

  const outcomes = actionState.outcomes
    .sort(newestFirst)
    .map((task) => ({
      ...task,
      boxName: boxById.get(task.boxId)?.name || task.completionReceipt?.boxName || '行动盒子',
      hasEvidence: Boolean(task.completionReceipt),
      needsHumanVerification: task.executionMode === 'ai',
      completionReceiptRef: `taskbox-completion:${task.id}:${text(task.completedAt || task.completionReceipt?.completedAt) || 'time-unknown'}`,
    }));

  Object.values(lanes).forEach((items) => items.sort((left, right) => {
    const leftRank = committedIds.has(left.id) ? 0 : 1;
    const rightRank = committedIds.has(right.id) ? 0 : 1;
    return leftRank - rightRank || newestFirst(left, right);
  }));
  const wipCount = new Set([...lanes.active, ...lanes.waiting].map((task) => task.id)).size;
  const pendingSync = Math.max(0, Number(syncState.pendingCount) || 0);
  const wipRisk = wipCount > 3;
  return {
    reviewDate,
    status: actionState.status,
    currentAction: actionState.currentAction,
    strategicCommitment: actionState.strategicCommitment,
    maintenance,
    lanes,
    outcomes,
    metrics: {
      wipCount,
      wipLimit: 3,
      wipRisk,
      preparationCount: lanes.preparation.length,
      waitingCount: lanes.waiting.length,
      outcomeCount: outcomes.length,
      evidenceCount: outcomes.filter((task) => task.hasEvidence).length,
      pendingSync,
    },
    wipDecisionCandidate: wipRisk ? {
      type: 'wip_limit_decision_candidate',
      status: 'proposed',
      writesTaskBox: false,
      taskIds: [...new Set([...lanes.active, ...lanes.waiting].map((task) => task.id))],
    } : null,
  };
}
