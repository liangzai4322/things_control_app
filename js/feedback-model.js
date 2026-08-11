export const FEEDBACK_STORAGE_KEY = 'taskbox_feedback_evolution_os_v1';
export const DEVIATION_TYPES = Object.freeze({ estimation: '估算', capacity: '容量', priority: '优先级', execution: '执行', external: '外部', unknown: '未知' });
export const TARGET_SYSTEMS = Object.freeze({ mission: '使命', health: '健康与能量', time: '时间与注意力', execution: '执行', feedback: '反馈与进化' });
export const CANDIDATE_STATES = Object.freeze([
  'candidate_unvalidated', 'observed', 'experiment_proposed', 'experiment_active',
  'evaluated', 'rule_proposed', 'rule_active', 'superseded', 'rejected',
]);

const clean = (value) => String(value || '').trim();
const lines = (value) => [...new Set((Array.isArray(value) ? value : String(value || '').split(/\r?\n/)).map(clean).filter(Boolean))];
const enumValue = (value, allowed, fallback) => allowed.includes(value) ? value : fallback;
const stamp = (now = new Date()) => new Date(now).toISOString();
const id = (prefix, now = new Date()) => `${prefix}-${new Date(now).getTime()}-${Math.random().toString(36).slice(2, 7)}`;
const explicitUserError = (sourceAuthority) => clean(sourceAuthority) === 'explicit_user' ? null : '该状态转换必须由 explicit_user 明确授权';

export function normalizeEvidenceRef(value = {}) {
  if (typeof value === 'string') {
    const refId = clean(value);
    return refId ? { refId, type: 'legacy', sourceId: refId, label: refId, uri: '', capturedAt: null } : null;
  }
  const type = clean(value.type) || 'reference';
  const sourceId = clean(value.sourceId || value.id || value.refId);
  const refId = clean(value.refId) || `${type}:${sourceId}`;
  if (!sourceId || !refId) return null;
  return {
    refId, type, sourceId, label: clean(value.label) || sourceId,
    uri: clean(value.uri || value.url || value.path), capturedAt: value.capturedAt || null,
  };
}

const evidenceRefs = (value) => {
  const refs = (Array.isArray(value) ? value : lines(value)).map(normalizeEvidenceRef).filter(Boolean);
  return [...new Map(refs.map((ref) => [ref.refId, ref])).values()];
};

export function normalizeDeviation(value = {}) {
  return {
    deviationId: clean(value.deviationId || value.id), predictionId: clean(value.predictionId),
    subjectRef: clean(value.subjectRef), type: enumValue(value.type, Object.keys(DEVIATION_TYPES), 'unknown'),
    severity: enumValue(value.severity, ['low', 'medium', 'high'], 'low'),
    expectedResult: clean(value.expectedResult), actualResult: clean(value.actualResult),
    facts: lines(value.facts), interpretation: clean(value.interpretation), evidenceRefs: evidenceRefs(value.evidenceRefs),
    sourceCycle: enumValue(value.sourceCycle, ['day', 'week', 'month', 'event'], 'event'),
    sourceRef: clean(value.sourceRef), observedAt: value.observedAt || value.recordedAt || null,
  };
}

export function normalizePrediction(value = {}) {
  const deviation = value.deviation && typeof value.deviation === 'object' ? {
    type: enumValue(value.deviation.type, Object.keys(DEVIATION_TYPES), 'unknown'),
    severity: enumValue(value.deviation.severity, ['low', 'medium', 'high'], 'low'),
    facts: lines(value.deviation.facts), interpretation: clean(value.deviation.interpretation),
    recordedAt: value.deviation.recordedAt || null,
  } : null;
  return {
    predictionId: clean(value.predictionId || value.id), subjectRef: clean(value.subjectRef),
    expectedResult: clean(value.expectedResult), expectedAt: value.expectedAt || '',
    assumptions: lines(value.assumptions), evidenceRefs: evidenceRefs(value.evidenceRefs),
    actualResult: clean(value.actualResult), status: deviation ? 'settled' : 'open', deviation,
    createdAt: value.createdAt || null, settledAt: value.settledAt || null,
  };
}

export function normalizeExperiment(value = {}) {
  return {
    experimentId: clean(value.experimentId || value.id), hypothesis: clean(value.hypothesis),
    changedVariable: clean(value.changedVariable), startAt: value.startAt || '', evaluateAt: value.evaluateAt || '',
    successConditions: lines(value.successConditions), stopConditions: lines(value.stopConditions),
    status: enumValue(value.status, ['proposed', 'approved', 'active', 'succeeded', 'failed', 'inconclusive', 'stopped'], 'proposed'),
    result: clean(value.result), approvedBy: value.approvedBy || null, approvedAt: value.approvedAt || null,
    completedAt: value.completedAt || null, createdAt: value.createdAt || null,
    evidenceRefs: evidenceRefs(value.evidenceRefs), sourceCycle: clean(value.sourceCycle), sourceRef: clean(value.sourceRef),
    patternCandidateId: clean(value.patternCandidateId),
  };
}

export function normalizeRuleVersion(value = {}) {
  return {
    ruleId: clean(value.ruleId), version: Math.max(1, Number(value.version) || 1),
    targetSystem: Object.hasOwn(TARGET_SYSTEMS, value.targetSystem) ? value.targetSystem : 'execution',
    statement: clean(value.statement), status: enumValue(value.status, ['proposed', 'active', 'deprecated', 'rejected'], 'proposed'),
    evidenceRefs: evidenceRefs(value.evidenceRefs), validationAt: value.validationAt || '', invalidationConditions: lines(value.invalidationConditions),
    approvedBy: value.approvedBy || null, approvedAt: value.approvedAt || null, deprecatedAt: value.deprecatedAt || null,
    createdAt: value.createdAt || null, sourceCycle: clean(value.sourceCycle), sourceRef: clean(value.sourceRef),
    patternCandidateId: clean(value.patternCandidateId), supersedesRuleRef: clean(value.supersedesRuleRef),
  };
}

const safeDateMapping = (value = {}) => clean(value.dateMapping || value.activity?.dateMapping) || 'unknown';
const sequenceEligible = (value = {}) => Boolean(value.sequenceEligible ?? value.activity?.sequenceEligible)
  && !['unknown', 'range'].includes(safeDateMapping(value));
const stringRefs = (value) => [...new Set((Array.isArray(value) ? value : []).map(clean).filter(Boolean))];

export function normalizeV2CandidateRecord(value = {}) {
  return {
    candidateId: clean(value.claimId || value.candidateId || value.id),
    candidateLineId: clean(value.candidateLineId),
    recordType: enumValue(value.recordType, ['observation', 'claim', 'source_proposal'], 'observation'),
    domain: Object.hasOwn(TARGET_SYSTEMS, value.domain) ? value.domain : 'feedback',
    content: clean(value.content || value.sourceExcerpt), authority: clean(value.authority) || 'ai_summary',
    epistemicState: clean(value.epistemicState) || 'uncertain', sourceRef: clean(value.sourceRef),
    sourceRefs: stringRefs([value.sourceRef, ...(value.sourceRefs || [])]), reviewDate: value.reviewDate || null,
    dateMapping: safeDateMapping(value), sequenceEligible: sequenceEligible(value),
  };
}

export function normalizeSemanticCluster(value = {}) {
  const templateLike = Boolean(value.templateLike);
  const activityDates = stringRefs(value.activityDates);
  const temporalEligible = !templateLike && Number(value.sequenceEligibleOccurrenceCount || 0) >= 2 && activityDates.length >= 2;
  return {
    clusterId: clean(value.clusterId || value.id), representativeText: clean(value.representativeText),
    occurrenceCount: Math.max(0, Number(value.occurrenceCount) || 0), sourceRefs: stringRefs(value.sourceRefs),
    reviewDates: stringRefs(value.reviewDates), activityDates, templateLike,
    filteredReasons: stringRefs(value.filteredReasons), behaviorPatternEligible: !templateLike,
    temporalEligible, epistemicState: clean(value.epistemicState) || 'candidate_unvalidated',
  };
}

export function normalizeV2PatternCandidate(value = {}, { imported = false } = {}) {
  const status = imported ? 'candidate_unvalidated' : enumValue(value.status, CANDIDATE_STATES, 'candidate_unvalidated');
  return {
    patternId: clean(value.patternId || value.id), status, basis: clean(value.basis),
    domain: Object.hasOwn(TARGET_SYSTEMS, value.domain) ? value.domain : 'feedback',
    statement: clean(value.statement), clusterId: clean(value.clusterId),
    evidenceRefs: evidenceRefs(value.evidenceRefs), supportingEvidence: evidenceRefs(value.supportingEvidence),
    counterEvidence: evidenceRefs(value.counterEvidence), missingEvidence: lines(value.missingEvidence),
    temporalInferenceAllowed: sequenceEligible(value) && Boolean(value.temporalInferenceAllowed),
    authority: clean(value.authority) || 'ai_summary', epistemicState: clean(value.epistemicState) || 'candidate_unvalidated',
    observedAt: value.observedAt || null, experimentId: clean(value.experimentId), ruleRef: clean(value.ruleRef),
    transitionLog: Array.isArray(value.transitionLog) ? value.transitionLog : [],
  };
}

export function normalizeCalibrationProposal(value = {}) {
  return {
    proposalId: clean(value.proposalId || value.id), domain: Object.hasOwn(TARGET_SYSTEMS, value.domain) ? value.domain : 'feedback',
    kind: clean(value.kind) || 'data_collection_calibration_experiment', status: 'proposed',
    title: clean(value.title), hypothesis: clean(value.hypothesis), successConditions: lines(value.successConditions),
    stopConditions: lines(value.stopConditions), evidenceRefs: evidenceRefs(value.evidenceRefs), risks: lines(value.risks),
    authority: clean(value.authority) || 'ai_derived', implementationAuthorized: false,
  };
}

export function normalizeCrossSystemProposal(value = {}) {
  return {
    proposalId: clean(value.proposalId || value.id), targetSystem: Object.hasOwn(TARGET_SYSTEMS, value.targetSystem) ? value.targetSystem : '',
    deviation: clean(value.deviation), evidenceRefs: evidenceRefs(value.evidenceRefs), suggestedChange: clean(value.suggestedChange),
    successConditions: lines(value.successConditions), stopConditions: lines(value.stopConditions), risks: lines(value.risks),
    rollback: clean(value.rollback), status: enumValue(value.status, ['proposed', 'accepted_not_applied', 'rejected'], 'proposed'),
    createdAt: value.createdAt || null, decidedAt: value.decidedAt || null, decisionBy: value.decisionBy || null,
  };
}

const emptyV2Namespace = () => ({ imports: [], observationsClaims: [], semanticClusters: [], patternCandidates: [], calibrationProposals: [] });

export function normalizeFeedbackStore(value = {}) {
  const v2 = value.v2Candidates && typeof value.v2Candidates === 'object' ? value.v2Candidates : {};
  return {
    schemaVersion: 3,
    predictions: (Array.isArray(value.predictions) ? value.predictions : []).map(normalizePrediction).filter((x) => x.predictionId && x.expectedResult),
    deviations: (Array.isArray(value.deviations) ? value.deviations : []).map(normalizeDeviation).filter((x) => x.deviationId && x.facts.length),
    experiments: (Array.isArray(value.experiments) ? value.experiments : []).map(normalizeExperiment).filter((x) => x.experimentId && x.hypothesis),
    rules: (Array.isArray(value.rules) ? value.rules : []).map(normalizeRuleVersion).filter((x) => x.ruleId && x.statement),
    continuityImports: (Array.isArray(value.continuityImports) ? value.continuityImports : []).map((item) => ({
      importId: clean(item.importId), cycleType: clean(item.cycleType), cycleKey: clean(item.cycleKey), importedAt: item.importedAt || null,
    })).filter((item) => item.importId),
    v2Candidates: {
      ...emptyV2Namespace(),
      imports: (Array.isArray(v2.imports) ? v2.imports : []).map((item) => ({ importId: clean(item.importId), datasetVersion: clean(item.datasetVersion), sourceRef: clean(item.sourceRef), importedAt: item.importedAt || null, counts: item.counts || {} })).filter((item) => item.importId),
      observationsClaims: (Array.isArray(v2.observationsClaims) ? v2.observationsClaims : []).map(normalizeV2CandidateRecord).filter((item) => item.candidateId && item.content),
      semanticClusters: (Array.isArray(v2.semanticClusters) ? v2.semanticClusters : []).map(normalizeSemanticCluster).filter((item) => item.clusterId),
      patternCandidates: (Array.isArray(v2.patternCandidates) ? v2.patternCandidates : []).map((item) => normalizeV2PatternCandidate(item)).filter((item) => item.patternId && item.statement),
      calibrationProposals: (Array.isArray(v2.calibrationProposals) ? v2.calibrationProposals : []).map(normalizeCalibrationProposal).filter((item) => item.proposalId),
    },
    crossSystemProposals: (Array.isArray(value.crossSystemProposals) ? value.crossSystemProposals : []).map(normalizeCrossSystemProposal).filter((item) => item.proposalId && item.targetSystem),
    updatedAt: value.updatedAt || null,
  };
}

function upsertBy(items, incoming, key) {
  const result = [...items];
  incoming.forEach((item) => {
    const index = result.findIndex((current) => key(current) === key(item));
    if (index < 0) result.push(item); else result[index] = { ...result[index], ...item };
  });
  return result;
}

const v2Arrays = (payload = {}) => ({
  observationsClaims: payload.observationsClaims || payload.claimsObservations || payload.claims || [],
  semanticClusters: payload.semanticClusters || payload.clusters || [],
  patternCandidates: payload.patternCandidates || payload.patterns || [],
  calibrationProposals: payload.calibrationProposals || payload.calibrations || [],
});

export function importV2FeedbackCandidates(input, payload = {}, { now = new Date() } = {}) {
  const store = normalizeFeedbackStore(input);
  const source = payload.v2Candidates || payload;
  const arrays = v2Arrays(source);
  const datasetVersion = clean(source.datasetVersion || source.version) || 'v2';
  const sourceRef = clean(source.sourceRef || source.sourceRoot);
  const importId = clean(source.importId) || `feedback-v2:${datasetVersion}:${sourceRef || 'default'}`;
  const observationsClaims = arrays.observationsClaims.map(normalizeV2CandidateRecord).filter((item) => item.candidateId && item.content && item.domain === 'feedback');
  const semanticClusters = arrays.semanticClusters.map(normalizeSemanticCluster).filter((item) => item.clusterId);
  const importedPatterns = arrays.patternCandidates.map((item) => normalizeV2PatternCandidate(item, { imported: true })).filter((item) => item.patternId && item.statement);
  const patternCandidates = importedPatterns.map((item) => {
    const current = store.v2Candidates.patternCandidates.find((candidate) => candidate.patternId === item.patternId);
    return current && current.status !== 'candidate_unvalidated'
      ? { ...item, status: current.status, observedAt: current.observedAt, experimentId: current.experimentId, ruleRef: current.ruleRef, transitionLog: current.transitionLog }
      : item;
  });
  const calibrationProposals = arrays.calibrationProposals.map(normalizeCalibrationProposal).filter((item) => item.proposalId);
  const importedAt = stamp(now);
  const counts = { observationsClaims: observationsClaims.length, semanticClusters: semanticClusters.length, patternCandidates: patternCandidates.length, calibrationProposals: calibrationProposals.length };
  const next = normalizeFeedbackStore({
    ...store,
    v2Candidates: {
      imports: upsertBy(store.v2Candidates.imports, [{ importId, datasetVersion, sourceRef, importedAt, counts }], (item) => item.importId),
      observationsClaims: upsertBy(store.v2Candidates.observationsClaims, observationsClaims, (item) => item.candidateId),
      semanticClusters: upsertBy(store.v2Candidates.semanticClusters, semanticClusters, (item) => item.clusterId),
      patternCandidates: upsertBy(store.v2Candidates.patternCandidates, patternCandidates, (item) => item.patternId),
      calibrationProposals: upsertBy(store.v2Candidates.calibrationProposals, calibrationProposals, (item) => item.proposalId),
    },
    updatedAt: importedAt,
  });
  return { store: next, error: null, imported: { importId, ...counts } };
}

function transitionCandidate(store, patternId, from, to, detail = {}, now = new Date(), sourceAuthority = 'system') {
  let candidate = null;
  const transitionedAt = stamp(now);
  const patternCandidates = store.v2Candidates.patternCandidates.map((item) => {
    if (item.patternId !== patternId || !from.includes(item.status)) return item;
    candidate = normalizeV2PatternCandidate({
      ...item, ...detail, status: to,
      transitionLog: [...item.transitionLog, { from: item.status, to, at: transitionedAt, authority: clean(sourceAuthority) || 'system' }],
    });
    return candidate;
  });
  if (!candidate) return { store, error: `候选当前状态不能进入 ${to}`, candidate: null };
  return { candidate, error: null, store: normalizeFeedbackStore({ ...store, v2Candidates: { ...store.v2Candidates, patternCandidates }, updatedAt: transitionedAt }) };
}

export function observePatternCandidate(input, patternId, observation = {}, { now = new Date(), sourceAuthority } = {}) {
  const store = normalizeFeedbackStore(input);
  const authorityError = explicitUserError(sourceAuthority);
  if (authorityError) return { store, error: authorityError, candidate: null };
  const result = transitionCandidate(store, patternId, ['candidate_unvalidated'], 'observed', {
    observedAt: stamp(now), supportingEvidence: evidenceRefs(observation.supportingEvidence),
    counterEvidence: evidenceRefs(observation.counterEvidence), missingEvidence: lines(observation.missingEvidence),
  }, now, sourceAuthority);
  if (!result.error && !result.candidate.supportingEvidence.length) return { store, error: '进入 observed 必须补充至少一条可定位支持证据', candidate: null };
  return result;
}

export function proposeCandidateExperiment(input, patternId, draft = {}, { now = new Date() } = {}) {
  const store = normalizeFeedbackStore(input);
  const candidate = store.v2Candidates.patternCandidates.find((item) => item.patternId === patternId);
  if (!candidate || candidate.status !== 'observed') return { store, error: '只有 observed 候选可以提出实验', experiment: null };
  const proposed = proposeExperiment(store, { ...draft, patternCandidateId: patternId, evidenceRefs: [...candidate.evidenceRefs, ...candidate.supportingEvidence, ...(draft.evidenceRefs || [])] }, { now });
  if (proposed.error) return proposed;
  const transitioned = transitionCandidate(proposed.store, patternId, ['observed'], 'experiment_proposed', { experimentId: proposed.experiment.experimentId }, now);
  return { ...proposed, store: transitioned.store, candidate: transitioned.candidate };
}

export function rejectPatternCandidate(input, patternId, { now = new Date(), sourceAuthority } = {}) {
  const store = normalizeFeedbackStore(input); const authorityError = explicitUserError(sourceAuthority);
  return authorityError ? { store, error: authorityError, candidate: null } : transitionCandidate(store, patternId, ['candidate_unvalidated', 'observed', 'experiment_proposed', 'evaluated', 'rule_proposed'], 'rejected', {}, now, sourceAuthority);
}

export function proposeCrossSystemChange(input, draft = {}, { now = new Date() } = {}) {
  const store = normalizeFeedbackStore(input); const createdAt = stamp(now);
  const proposal = normalizeCrossSystemProposal({ ...draft, proposalId: draft.proposalId || id('feedback-change', now), status: 'proposed', createdAt });
  if (!proposal.targetSystem || !proposal.deviation || !proposal.evidenceRefs.length || !proposal.suggestedChange || !proposal.successConditions.length || !proposal.stopConditions.length || !proposal.risks.length || !proposal.rollback) {
    return { store, error: '跨系统提案必须包含目标、偏差证据、建议、成功/停止条件、风险和回滚', proposal: null };
  }
  return { error: null, proposal, store: normalizeFeedbackStore({ ...store, crossSystemProposals: upsertBy(store.crossSystemProposals, [proposal], (item) => item.proposalId), updatedAt: createdAt }) };
}

export function decideCrossSystemChange(input, proposalId, decision, { now = new Date(), sourceAuthority } = {}) {
  const store = normalizeFeedbackStore(input); const decidedAt = stamp(now); let proposal = null;
  const authorityError = explicitUserError(sourceAuthority);
  if (authorityError) return { store, error: authorityError, proposal: null };
  const status = decision === 'accept' ? 'accepted_not_applied' : decision === 'reject' ? 'rejected' : '';
  if (!status) return { store, error: '未知提案决定', proposal: null };
  const crossSystemProposals = store.crossSystemProposals.map((item) => item.proposalId === proposalId && item.status === 'proposed'
    ? (proposal = { ...item, status, decidedAt, decisionBy: sourceAuthority }) : item);
  return proposal ? { error: null, proposal, store: normalizeFeedbackStore({ ...store, crossSystemProposals, updatedAt: decidedAt }) } : { store, error: '提案不可决定', proposal: null };
}

export function importFeedbackContinuity(input, payload = {}, { now = new Date() } = {}) {
  const store = normalizeFeedbackStore(input);
  const cycleType = enumValue(payload.cycleType, ['day', 'week', 'month'], 'day');
  const cycleKey = clean(payload.cycleKey);
  const importId = clean(payload.continuityId) || `feedback:${cycleType}:${cycleKey}`;
  if (!cycleKey) return { store, error: '连续性载荷缺少周期标识', imported: null };
  const deviations = (Array.isArray(payload.deviations) ? payload.deviations : [])
    .map((item) => normalizeDeviation({ ...item, sourceCycle: item.sourceCycle || cycleType, sourceRef: item.sourceRef || cycleKey }))
    .filter((item) => item.deviationId && item.facts.length);
  const experiments = (Array.isArray(payload.experiments) ? payload.experiments : [])
    .map((item) => normalizeExperiment({ ...item, status: 'proposed', approvedBy: null, approvedAt: null, sourceCycle: item.sourceCycle || cycleType, sourceRef: item.sourceRef || cycleKey }))
    .filter((item) => item.experimentId && item.hypothesis);
  const rules = (Array.isArray(payload.rules) ? payload.rules : [])
    .map((item) => normalizeRuleVersion({ ...item, status: 'proposed', approvedBy: null, approvedAt: null, sourceCycle: item.sourceCycle || cycleType, sourceRef: item.sourceRef || cycleKey }))
    .filter((item) => item.ruleId && item.statement);
  const guardedExperiments = experiments.map((item) => {
    const current = store.experiments.find((existing) => existing.experimentId === item.experimentId);
    return current && current.status !== 'proposed' ? { ...item, status: current.status, approvedBy: current.approvedBy, approvedAt: current.approvedAt, completedAt: current.completedAt, result: current.result } : item;
  });
  const guardedRules = rules.map((item) => {
    const current = store.rules.find((existing) => existing.ruleId === item.ruleId && existing.version === item.version);
    return current && current.status !== 'proposed' ? { ...item, status: current.status, approvedBy: current.approvedBy, approvedAt: current.approvedAt, deprecatedAt: current.deprecatedAt } : item;
  });
  const importedAt = stamp(now);
  const next = normalizeFeedbackStore({
    ...store,
    deviations: upsertBy(store.deviations, deviations, (item) => item.deviationId),
    experiments: upsertBy(store.experiments, guardedExperiments, (item) => item.experimentId),
    rules: upsertBy(store.rules, guardedRules, (item) => `${item.ruleId}:${item.version}`),
    continuityImports: upsertBy(store.continuityImports, [{ importId, cycleType, cycleKey, importedAt }], (item) => item.importId),
    updatedAt: importedAt,
  });
  return { store: next, error: null, imported: { importId, deviations: deviations.length, experiments: experiments.length, rules: rules.length } };
}

export function addPrediction(input, draft = {}, { now = new Date() } = {}) {
  const store = normalizeFeedbackStore(input); const createdAt = stamp(now);
  const prediction = normalizePrediction({ ...draft, predictionId: draft.predictionId || id('prediction', now), createdAt });
  if (!prediction.expectedResult || !prediction.expectedAt) return { store, error: '必须填写预期结果和兑现时间', prediction: null };
  return { error: null, prediction, store: normalizeFeedbackStore({ ...store, predictions: [...store.predictions, prediction], updatedAt: createdAt }) };
}

export function settlePrediction(input, predictionId, result = {}, { now = new Date() } = {}) {
  const store = normalizeFeedbackStore(input); const settledAt = stamp(now); let settled = null;
  const predictions = store.predictions.map((prediction) => {
    if (prediction.predictionId !== predictionId || prediction.status !== 'open') return prediction;
    settled = normalizePrediction({ ...prediction, actualResult: result.actualResult, settledAt, deviation: { type: result.type, severity: result.severity, facts: result.facts, interpretation: result.interpretation, recordedAt: settledAt } });
    return settled;
  });
  if (!settled?.actualResult || !settled.deviation.facts.length) return { store, error: '必须填写实际结果和至少一条事实', prediction: null };
  return { error: null, prediction: settled, store: normalizeFeedbackStore({ ...store, predictions, updatedAt: settledAt }) };
}

export function derivePatternCandidates(predictions = []) {
  const groups = new Map();
  predictions.map(normalizePrediction).filter((x) => x.deviation).forEach((prediction) => {
    const key = `${prediction.deviation.type}::${prediction.subjectRef || '通用'}`;
    const current = groups.get(key) || { patternId: key, type: prediction.deviation.type, subjectRef: prediction.subjectRef || '通用', count: 0, highSeverityCount: 0, evidenceRefs: [] };
    current.count += 1;
    if (prediction.deviation.severity === 'high') current.highSeverityCount += 1;
    current.evidenceRefs.push(normalizeEvidenceRef(prediction.predictionId), ...prediction.evidenceRefs);
    groups.set(key, current);
  });
  return [...groups.values()].filter((pattern) => pattern.count >= 2 || pattern.highSeverityCount > 0).map((pattern) => ({
    ...pattern,
    evidenceRefs: [...new Map(pattern.evidenceRefs.filter(Boolean).map((ref) => [ref.refId, ref])).values()],
  })).sort((a, b) => b.highSeverityCount - a.highSeverityCount || b.count - a.count);
}

export function proposeExperiment(input, draft = {}, { now = new Date() } = {}) {
  const store = normalizeFeedbackStore(input); const createdAt = stamp(now);
  const experiment = normalizeExperiment({ ...draft, experimentId: draft.experimentId || id('experiment', now), status: 'proposed', createdAt });
  if (!experiment.hypothesis || !experiment.changedVariable || !experiment.evaluateAt || !experiment.successConditions.length || !experiment.stopConditions.length) return { store, error: '实验必须包含假设、唯一变量、验证日期、成功与停止条件', experiment: null };
  return { error: null, experiment, store: normalizeFeedbackStore({ ...store, experiments: [...store.experiments, experiment], updatedAt: createdAt }) };
}

export function approveExperiment(input, experimentId, { now = new Date(), sourceAuthority } = {}) {
  const store = normalizeFeedbackStore(input);
  const authorityError = explicitUserError(sourceAuthority);
  if (authorityError) return { store, error: authorityError, experiment: null };
  if (store.experiments.some((x) => ['approved', 'active'].includes(x.status) && x.experimentId !== experimentId)) return { store, error: '已有一个运行中的实验', experiment: null };
  const approvedAt = stamp(now); let experiment = null;
  const experiments = store.experiments.map((item) => item.experimentId === experimentId && item.status === 'proposed' ? (experiment = { ...item, status: 'active', approvedBy: sourceAuthority, approvedAt, startAt: item.startAt || approvedAt.slice(0, 10) }) : item);
  if (!experiment) return { store, error: '实验不可批准', experiment: null };
  let next = normalizeFeedbackStore({ ...store, experiments, updatedAt: approvedAt });
  if (experiment.patternCandidateId) {
    const transitioned = transitionCandidate(next, experiment.patternCandidateId, ['experiment_proposed'], 'experiment_active', {}, now, sourceAuthority);
    if (transitioned.error) return { store, error: transitioned.error, experiment: null };
    next = transitioned.store;
  }
  return { error: null, experiment, store: next };
}

export function completeExperiment(input, experimentId, status, result, { now = new Date(), sourceAuthority } = {}) {
  const store = normalizeFeedbackStore(input); const completedAt = stamp(now); let experiment = null;
  const authorityError = explicitUserError(sourceAuthority);
  if (authorityError) return { store, error: authorityError, experiment: null };
  if (!clean(result)) return { store, error: '必须记录实验的现实结果', experiment: null };
  const finalStatus = enumValue(status, ['succeeded', 'failed', 'inconclusive', 'stopped'], 'inconclusive');
  const experiments = store.experiments.map((item) => item.experimentId === experimentId && item.status === 'active' ? (experiment = { ...item, status: finalStatus, result: clean(result), completedAt }) : item);
  if (!experiment) return { store, error: '实验不可结算', experiment: null };
  let next = normalizeFeedbackStore({ ...store, experiments, updatedAt: completedAt });
  if (experiment.patternCandidateId) {
    const transitioned = transitionCandidate(next, experiment.patternCandidateId, ['experiment_active'], 'evaluated', {}, now, sourceAuthority);
    if (transitioned.error) return { store, error: transitioned.error, experiment: null };
    next = transitioned.store;
  }
  return { error: null, experiment, store: next };
}

export function proposeRuleVersion(input, draft = {}, { now = new Date() } = {}) {
  const store = normalizeFeedbackStore(input); const createdAt = stamp(now); const ruleId = clean(draft.ruleId) || id('rule', now);
  const version = Math.max(0, ...store.rules.filter((x) => x.ruleId === ruleId).map((x) => x.version)) + 1;
  const rule = normalizeRuleVersion({ ...draft, ruleId, version, status: 'proposed', createdAt });
  if (!rule.statement || !rule.validationAt || !rule.evidenceRefs.length || !rule.invalidationConditions.length) return { store, error: '规则提案必须包含陈述、证据、验证日期和失效条件', rule: null };
  if (rule.patternCandidateId) {
    const candidate = store.v2Candidates.patternCandidates.find((item) => item.patternId === rule.patternCandidateId);
    if (!candidate || candidate.status !== 'evaluated') return { store, error: '关联候选必须先完成实验评估', rule: null };
  }
  let next = normalizeFeedbackStore({ ...store, rules: [...store.rules, rule], updatedAt: createdAt });
  if (rule.patternCandidateId) next = transitionCandidate(next, rule.patternCandidateId, ['evaluated'], 'rule_proposed', { ruleRef: `${rule.ruleId}:${rule.version}` }, now).store;
  return { error: null, rule, store: next };
}

export function activateRuleVersion(input, ruleId, version, { now = new Date(), sourceAuthority } = {}) {
  const store = normalizeFeedbackStore(input); const approvedAt = stamp(now); let activated = null;
  const authorityError = explicitUserError(sourceAuthority);
  if (authorityError) return { store, error: authorityError, rule: null };
  const rules = store.rules.map((rule) => {
    if (rule.ruleId === ruleId && rule.version === Number(version) && rule.status === 'proposed') return (activated = { ...rule, status: 'active', approvedBy: sourceAuthority, approvedAt });
    if (rule.ruleId === ruleId && rule.status === 'active') return { ...rule, status: 'deprecated', deprecatedAt: approvedAt };
    return rule;
  });
  if (!activated) return { store, error: '规则版本不可激活', rule: null };
  let next = normalizeFeedbackStore({ ...store, rules, updatedAt: approvedAt });
  if (activated.patternCandidateId) {
    const transitioned = transitionCandidate(next, activated.patternCandidateId, ['rule_proposed'], 'rule_active', {}, now, sourceAuthority);
    if (transitioned.error) return { store, error: transitioned.error, rule: null };
    next = transitioned.store;
  }
  const supersededRefs = rules.filter((rule) => rule.ruleId === ruleId && rule.status === 'deprecated' && rule.patternCandidateId).map((rule) => rule.patternCandidateId);
  supersededRefs.forEach((patternId) => { next = transitionCandidate(next, patternId, ['rule_active'], 'superseded', {}, now, sourceAuthority).store; });
  return { error: null, rule: activated, store: next };
}

export function deprecateRuleVersion(input, ruleId, version, { now = new Date(), sourceAuthority } = {}) {
  const store = normalizeFeedbackStore(input); const deprecatedAt = stamp(now); let changed = false;
  const authorityError = explicitUserError(sourceAuthority);
  if (authorityError) return { store, error: authorityError, rule: null };
  let deprecated = null;
  const rules = store.rules.map((rule) => rule.ruleId === ruleId && rule.version === Number(version) && rule.status === 'active' ? (changed = true, deprecated = { ...rule, status: 'deprecated', deprecatedAt }, deprecated) : rule);
  return changed ? { error: null, rule: deprecated, store: normalizeFeedbackStore({ ...store, rules, updatedAt: deprecatedAt }) } : { store, error: '规则版本不可废弃', rule: null };
}

export function deriveFeedbackDashboard(input = {}, { now = new Date() } = {}) {
  const store = normalizeFeedbackStore(input); const patterns = derivePatternCandidates(store.predictions);
  const openPredictions = store.predictions.filter((x) => x.status === 'open').sort((a, b) => String(a.expectedAt).localeCompare(String(b.expectedAt)));
  const settled = store.predictions.filter((x) => x.status === 'settled').sort((a, b) => String(b.settledAt).localeCompare(String(a.settledAt)));
  const evidenced = settled.filter((x) => x.deviation?.facts.length || x.evidenceRefs.length);
  const importedDeviations = [...store.deviations].sort((a, b) => String(b.observedAt).localeCompare(String(a.observedAt)));
  const activeExperiment = store.experiments.find((x) => x.status === 'active') || null;
  const proposedExperiments = store.experiments.filter((x) => x.status === 'proposed');
  const proposedRules = store.rules.filter((x) => x.status === 'proposed');
  const activeRules = store.rules.filter((x) => x.status === 'active');
  const ruleHistory = store.rules.filter((x) => ['deprecated', 'rejected'].includes(x.status)).sort((a, b) => String(b.deprecatedAt || b.createdAt).localeCompare(String(a.deprecatedAt || a.createdAt)));
  const validationDue = activeRules.filter((x) => x.validationAt && x.validationAt <= stamp(now).slice(0, 10));
  const v2Inbox = {
    observationsClaims: store.v2Candidates.observationsClaims,
    semanticClusters: store.v2Candidates.semanticClusters,
    patternCandidates: store.v2Candidates.patternCandidates,
    calibrationProposals: store.v2Candidates.calibrationProposals,
    templateClusters: store.v2Candidates.semanticClusters.filter((item) => item.templateLike),
    temporalEligibleClusters: store.v2Candidates.semanticClusters.filter((item) => item.temporalEligible),
  };
  return { store, openPredictions, settled, importedDeviations, patterns, activeExperiment, proposedExperiments, proposedRules, activeRules, ruleHistory, validationDue, v2Inbox, crossSystemProposals: store.crossSystemProposals, metrics: { open: openPredictions.length, settled: settled.length, importedDeviations: importedDeviations.length, evidenceCoverage: settled.length ? Math.round(evidenced.length / settled.length * 100) : null, patterns: patterns.length, pendingApprovals: proposedExperiments.length + proposedRules.length } };
}

export function buildFeedbackHqSummary(input = {}) {
  const dashboard = deriveFeedbackDashboard(input);
  const experiment = dashboard.activeExperiment || dashboard.proposedExperiments[0] || null;
  const rule = dashboard.proposedRules[0] || null;
  const latestDeviation = dashboard.importedDeviations[0] || null;
  const summary = {
    lastSyncAt: dashboard.store.updatedAt,
    deviationCount: dashboard.importedDeviations.length,
    pendingRuleCount: dashboard.proposedRules.length,
    experiment: experiment ? { experimentId: experiment.experimentId, hypothesis: experiment.hypothesis, status: experiment.status, evaluateAt: experiment.evaluateAt } : null,
    rule: rule ? { ruleId: rule.ruleId, version: rule.version, statement: rule.statement, targetSystem: rule.targetSystem, status: rule.status } : null,
    latestDeviation: latestDeviation ? { deviationId: latestDeviation.deviationId, subjectRef: latestDeviation.subjectRef, severity: latestDeviation.severity, evidenceCount: latestDeviation.evidenceRefs.length } : null,
  };
  const generatedAt = summary.lastSyncAt || null;
  return {
    snapshotId: `feedback-hq:${generatedAt || 'unpublished'}`,
    systemId: 'feedback', schemaVersion: 1, generatedAt,
    effectiveDate: generatedAt ? generatedAt.slice(0, 10) : null,
    sourceRefs: latestDeviation?.evidenceRefs?.map((item) => item.refId).filter(Boolean) || [],
    confidence: generatedAt ? 0.8 : 0,
    status: generatedAt ? (summary.pendingRuleCount ? 'attention' : 'healthy') : 'unknown',
    summary, constraints: [],
    ...summary,
  };
}
