export const HEALTH_STORAGE_KEY = 'taskbox_health_energy_os_v1';
export const HEALTH_PROTOCOL_STORAGE_KEY = 'taskbox_health_energy_protocol_v1';

const VALID_SOURCES = new Set(['manual', 'wearable', 'medical_record', 'daily_review']);
const SOURCE_CONFIDENCE = { manual: 0.8, wearable: 0.75, medical_record: 0.9, daily_review: 0.7 };
const STATE_CAPACITY = { green: 1, yellow: 0.6, red: 0.3, unknown: null };
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const clean = (value) => String(value || '').trim();
const timestamp = (value) => value && !Number.isNaN(new Date(value).getTime()) ? value : null;
const numberOrNull = (value, min, max) => (
  value === '' || value == null || !Number.isFinite(Number(value))
    ? null
    : Math.min(max, Math.max(min, Number(value)))
);
const average = (values) => values.length
  ? Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10
  : null;
const unique = (values) => [...new Set(values.filter(Boolean))];
const CANDIDATE_STATUSES = new Set(['pending', 'confirmed', 'context_only', 'dismissed']);
const ENERGY_TEXT_SCORES = Object.freeze([
  [1, /(?:极差|很差|耗尽|无精打采|几乎无法工作)/],
  [2, /(?:中等偏低|中等偏差|偏低|较差|疲惫|疲劳|困倦|低能量)/],
  [5, /(?:非常好|很好|精力充沛|状态极佳|满格)/],
  [4, /(?:中等偏好|中等偏上|偏好|较好|良好|有精神)/],
  [3, /(?:中等|一般|尚可|正常)/],
]);

export function inferEnergyScore(value = '') {
  const text = clean(value);
  return ENERGY_TEXT_SCORES.find(([, pattern]) => pattern.test(text))?.[0] ?? null;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function stableHash(value) {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function nextDayAtNoon(date) {
  if (!datePattern.test(date)) return null;
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return `${next.toISOString().slice(0, 10)}T12:00:00+08:00`;
}

export function normalizeHealthObservation(value = {}) {
  const date = datePattern.test(value.observationDate || value.date || '') ? (value.observationDate || value.date) : '';
  const source = VALID_SOURCES.has(value.source) ? value.source : 'manual';
  const energyText = clean(value.energyText);
  const reportedEnergy = numberOrNull(value.energy, 1, 5);
  const inferredEnergy = reportedEnergy == null ? inferEnergyScore(energyText) : null;
  return {
    observationId: clean(value.observationId) || `health-observation-${date || 'undated'}-${source}`,
    date,
    observationDate: date,
    effectiveDate: datePattern.test(value.effectiveDate || '') ? value.effectiveDate : date,
    reviewDate: datePattern.test(value.reviewDate || '') ? value.reviewDate : null,
    sleepHours: numberOrNull(value.sleepHours, 0, 24),
    energy: reportedEnergy ?? inferredEnergy,
    energyText,
    energyScoreSource: reportedEnergy != null ? 'reported' : inferredEnergy != null ? 'qualitative_mapping' : 'unknown',
    training: clean(value.training),
    nutrition: clean(value.nutrition),
    symptoms: clean(value.symptoms),
    riskLevel: ['unknown', 'none', 'attention', 'professional'].includes(value.riskLevel) ? value.riskLevel : (source === 'daily_review' ? 'unknown' : 'none'),
    notes: clean(value.notes),
    source,
    confidence: numberOrNull(value.confidence, 0, 1) ?? SOURCE_CONFIDENCE[source],
    observedAt: clean(value.observedAt) || null,
    candidateId: clean(value.candidateId) || null,
    sourceRef: clean(value.sourceRef) || null,
    sourceHash: clean(value.sourceHash) || null,
    authority: clean(value.authority) || null,
    dateMapping: clean(value.dateMapping) || null,
    interventionExecuted: ['yes', 'no', 'unknown', '无干预'].includes(value.interventionExecuted) ? value.interventionExecuted : 'unknown',
    interventionResult: clean(value.interventionResult),
    tomorrowCapacity: ['normal', 'reduced', 'recovery', 'unknown'].includes(value.tomorrowCapacity) ? value.tomorrowCapacity : 'unknown',
    constraint: clean(value.constraint),
    evidenceRefs: unique(Array.isArray(value.evidenceRefs) ? value.evidenceRefs.map(clean) : []),
    updatedAt: value.updatedAt || null,
  };
}

export function normalizeHealthCandidate(value = {}) {
  const activity = value.activity && typeof value.activity === 'object' ? value.activity : {};
  const activityStart = datePattern.test(activity.activityStart || value.activityStart || '')
    ? (activity.activityStart || value.activityStart)
    : null;
  const activityEnd = datePattern.test(activity.activityEnd || value.activityEnd || '')
    ? (activity.activityEnd || value.activityEnd)
    : null;
  const dateMapping = clean(activity.dateMapping || value.dateMapping) || 'unknown';
  const sequenceEligible = activity.sequenceEligible === true || value.sequenceEligible === true;
  const temporalEligible = sequenceEligible
    && activityStart != null
    && activityStart === activityEnd
    && !['unknown', 'range'].includes(dateMapping);
  const candidateId = clean(value.candidateId || value.claimId || value.candidateLineId);
  return {
    candidateId,
    candidateLineId: clean(value.candidateLineId) || null,
    recordType: ['observation', 'claim', 'source_proposal'].includes(value.recordType) ? value.recordType : 'claim',
    domain: clean(value.domain) || 'health',
    content: clean(value.sourceExcerpt || value.content),
    sourceRef: clean(value.sourceRef),
    authority: clean(value.authority) || 'ai_summary',
    epistemicState: clean(value.epistemicState) || 'uncertain',
    dateMapping,
    activityStart,
    activityEnd,
    sequenceEligible,
    temporalEligible,
    status: CANDIDATE_STATUSES.has(value.status) ? value.status : 'pending',
    importedAt: timestamp(value.importedAt),
    resolvedAt: timestamp(value.resolvedAt),
    resolvedBy: value.resolvedBy === 'explicit_user' ? 'explicit_user' : null,
    decisionId: clean(value.decisionId) || null,
    observationId: clean(value.observationId) || null,
  };
}

export function importHealthCandidates(store = {}, records = [], importedAt = new Date().toISOString()) {
  const normalized = normalizeHealthStore(store);
  const existing = new Map(normalized.candidates.map((item) => [item.candidateId, item]));
  records
    .filter((item) => item?.domain === 'health')
    .map((item) => normalizeHealthCandidate({ ...item, importedAt }))
    .filter((item) => item.candidateId && item.content && item.sourceRef)
    .forEach((item) => {
      const previous = existing.get(item.candidateId);
      existing.set(item.candidateId, previous
        ? {
          ...item,
          status: previous.status,
          importedAt: previous.importedAt,
          resolvedAt: previous.resolvedAt,
          resolvedBy: previous.resolvedBy,
          decisionId: previous.decisionId,
          observationId: previous.observationId,
        }
        : item);
    });
  return normalizeHealthStore({ ...normalized, candidates: [...existing.values()] });
}

export function resolveHealthCandidate(store = {}, candidateId = '', decision = 'confirm', authorization = {}) {
  if (authorization?.sourceAuthority !== 'explicit_user') return store;
  if (!['confirm', 'dismiss'].includes(decision)) return store;
  const normalized = normalizeHealthStore(store);
  const candidate = normalized.candidates.find((item) => item.candidateId === candidateId);
  if (!candidate || candidate.status !== 'pending') return normalized;
  const resolvedAt = timestamp(authorization.resolvedAt) || new Date().toISOString();
  const resolution = (status) => ({
    status,
    resolvedAt,
    resolvedBy: 'explicit_user',
    decisionId: clean(authorization.decisionId) || `health-candidate-decision:${candidateId}:${status}`,
  });
  if (decision === 'dismiss') {
    return normalizeHealthStore({
      ...normalized,
      candidates: normalized.candidates.map((item) => item.candidateId === candidateId
        ? { ...item, ...resolution('dismissed') }
        : item),
    });
  }
  if (!candidate.temporalEligible) {
    return normalizeHealthStore({
      ...normalized,
      candidates: normalized.candidates.map((item) => item.candidateId === candidateId
        ? { ...item, ...resolution('context_only') }
        : item),
    });
  }
  const observationId = `health-observation-daily-review-${candidate.candidateId}`;
  const observation = normalizeHealthObservation({
    observationId,
    date: candidate.activityStart,
    source: 'daily_review',
    confidence: candidate.authority === 'external_evidence' ? 0.7 : 0.6,
    notes: candidate.content,
    observedAt: resolvedAt,
    candidateId: candidate.candidateId,
    sourceRef: candidate.sourceRef,
    authority: candidate.authority,
    dateMapping: candidate.dateMapping,
  });
  return normalizeHealthStore({
    ...normalized,
    observations: [...normalized.observations, observation],
    candidates: normalized.candidates.map((item) => item.candidateId === candidateId
      ? { ...item, ...resolution('confirmed'), observationId }
      : item),
  });
}

export function buildDailyHealthReading(records = [], date = '') {
  const observations = records
    .map(normalizeHealthObservation)
    .filter((item) => item.date === date);
  const metric = (key) => observations
    .filter((item) => item[key] != null)
    .map((item) => ({ value: item[key], source: item.source, confidence: item.confidence, observationId: item.observationId }));
  const sleepValues = metric('sleepHours');
  const energyValues = metric('energy');
  const conflicts = [];
  if (sleepValues.length > 1 && Math.max(...sleepValues.map((item) => item.value)) - Math.min(...sleepValues.map((item) => item.value)) >= 1.5) {
    conflicts.push('睡眠来源差异达到1.5小时');
  }
  if (energyValues.length > 1 && Math.max(...energyValues.map((item) => item.value)) - Math.min(...energyValues.map((item) => item.value)) >= 2) {
    conflicts.push('精力来源差异达到2级');
  }
  const riskRank = { none: 0, attention: 1, professional: 2 };
  const riskLevel = observations.reduce(
    (highest, item) => riskRank[item.riskLevel] > riskRank[highest] ? item.riskLevel : highest,
    'none',
  );
  const sleepHours = sleepValues.length ? Math.min(...sleepValues.map((item) => item.value)) : null;
  const energy = energyValues.length ? Math.min(...energyValues.map((item) => item.value)) : null;
  const missing = [sleepHours == null ? 'sleep' : '', energy == null ? 'energy' : ''].filter(Boolean);
  const confidenceValues = observations.map((item) => item.confidence).filter((item) => item != null);
  const completeness = (2 - missing.length) / 2;
  return {
    date,
    observations,
    sleepHours,
    energy,
    riskLevel,
    conflicts,
    missing,
    evidenceRefs: unique(observations.map((item) => item.observationId)),
    sources: unique(observations.map((item) => item.source)),
    confidence: conflicts.length ? 0 : Math.round((average(confidenceValues) ?? 0) * completeness * 100) / 100,
  };
}

function previousDate(date) {
  if (!datePattern.test(date)) return '';
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() - 1);
  return value.toISOString().slice(0, 10);
}

export function calculatePersonalBaseline(records = [], options = {}) {
  const beforeDate = datePattern.test(options.beforeDate || '') ? options.beforeDate : null;
  const windowDays = Number.isFinite(Number(options.windowDays)) ? Math.max(7, Number(options.windowDays)) : 28;
  const minimumSampleDays = Number.isFinite(Number(options.minimumSampleDays)) ? Math.max(3, Number(options.minimumSampleDays)) : 5;
  const dates = unique(records.map((item) => item?.date))
    .filter((date) => datePattern.test(date) && (!beforeDate || date < beforeDate))
    .sort((left, right) => right.localeCompare(left))
    .slice(0, windowDays);
  const readings = dates.map((date) => buildDailyHealthReading(records, date)).filter((item) => !item.conflicts.length);
  const sleep = readings.map((item) => item.sleepHours).filter((value) => value != null);
  const energy = readings.map((item) => item.energy).filter((value) => value != null);
  const sampleDays = Math.max(sleep.length, energy.length);
  return {
    windowDays,
    minimumSampleDays,
    sampleDays,
    ready: sleep.length >= minimumSampleDays && energy.length >= minimumSampleDays,
    averageSleep: average(sleep),
    averageEnergy: average(energy),
    sleepSamples: sleep.length,
    energySamples: energy.length,
    lastDate: readings[0]?.date || null,
  };
}

// P0 compatibility helper used by older callers.
export function calculateHealthBaseline(records = []) {
  const recent = [...records]
    .filter((item) => item?.date)
    .sort((left, right) => right.date.localeCompare(left.date))
    .slice(0, 7)
    .map(normalizeHealthObservation);
  return {
    sampleDays: recent.length,
    averageSleep: average(recent.map((item) => item.sleepHours).filter((item) => item != null)),
    averageEnergy: average(recent.map((item) => item.energy).filter((item) => item != null)),
  };
}

function hasConsecutiveDeviation(records, date, baseline) {
  if (!baseline.ready) return false;
  const dates = unique(records.map((item) => item?.date))
    .filter((itemDate) => datePattern.test(itemDate) && itemDate <= date)
    .sort((left, right) => right.localeCompare(left))
    .slice(0, 2);
  if (dates.length < 2) return false;
  return dates.every((itemDate) => {
    const reading = buildDailyHealthReading(records, itemDate);
    if (reading.conflicts.length || reading.missing.length) return false;
    return reading.sleepHours <= baseline.averageSleep - 1.25 || reading.energy <= baseline.averageEnergy - 1;
  });
}

export function deriveHealthAssessment(records = [], date = '') {
  const reading = buildDailyHealthReading(records, date);
  const baseline = calculatePersonalBaseline(records, { beforeDate: date });
  const reasons = [];
  let state = 'unknown';

  if (reading.riskLevel === 'professional') {
    state = 'red';
    reasons.push('你明确标记了需要专业关注');
  } else if (reading.riskLevel === 'attention') {
    state = 'yellow';
    reasons.push('你明确标记了需要关注');
  } else if (reading.conflicts.length) {
    reasons.push(...reading.conflicts.map((item) => `来源冲突：${item}`));
  } else if (reading.missing.length) {
    reasons.push(`缺少${reading.missing.map((item) => item === 'sleep' ? '睡眠' : '精力').join('与')}数据`);
  } else if (reading.sleepHours < 6 || reading.energy <= 2) {
    state = 'yellow';
    if (reading.sleepHours < 6) reasons.push(`睡眠 ${reading.sleepHours} 小时，触发保守降载线`);
    if (reading.energy <= 2) reasons.push(`主观精力 ${reading.energy}/5，触发保守降载线`);
  } else if (hasConsecutiveDeviation(records, date, baseline)) {
    state = 'yellow';
    reasons.push('连续两次偏离个人基线，建议降低负载并补充恢复');
  } else {
    state = 'green';
    reasons.push(baseline.ready ? '未发现连续偏离个人基线的证据' : '当前记录未触发降载；个人基线仍在积累');
  }

  return {
    state,
    availableCapacity: STATE_CAPACITY[state],
    reasons,
    validUntil: nextDayAtNoon(date),
    evidenceRefs: reading.evidenceRefs,
    confidence: state === 'unknown' ? reading.confidence : Math.min(reading.confidence || 0.7, baseline.ready ? 0.85 : 0.7),
    reading,
    baseline,
  };
}

export function deriveHealthDrivingPlan(records = [], planningDate = '') {
  const normalized = records.map(normalizeHealthObservation);
  const current = normalized
    .filter((item) => item.date === planningDate && item.source !== 'daily_review')
    .sort((left, right) => String(right.updatedAt || right.observedAt || '').localeCompare(String(left.updatedAt || left.observedAt || '')));
  const effective = normalized
    .filter((item) => item.effectiveDate === planningDate)
    .sort((left, right) => String(right.updatedAt || right.observedAt || '').localeCompare(String(left.updatedAt || left.observedAt || '')));
  const currentRisk = current.find((item) => ['attention', 'professional'].includes(item.riskLevel));
  const currentComplete = current.find((item) => item.sleepHours != null && item.energy != null);
  const basisObservation = currentRisk || currentComplete || effective[0] || null;
  const basisDate = basisObservation?.date || planningDate;
  const assessment = basisObservation ? deriveHealthAssessment(normalized, basisDate) : deriveHealthAssessment([], planningDate);
  const priorDate = previousDate(basisDate);
  const prior = priorDate ? deriveHealthAssessment(normalized, priorDate) : null;
  const difference = (currentValue, priorValue) => currentValue == null || priorValue == null
    ? null : Math.round((currentValue - priorValue) * 10) / 10;
  return {
    ...assessment,
    planningDate,
    basisDate: basisObservation ? basisDate : null,
    basisSource: basisObservation?.source || null,
    basisObservation,
    sourceReviewDate: basisObservation?.reviewDate || null,
    freshness: basisObservation ? (basisObservation.effectiveDate === planningDate || basisDate === planningDate ? 'current' : 'stale') : 'missing',
    comparison: {
      sleepDelta: difference(assessment.reading.sleepHours, prior?.reading.sleepHours),
      energyDelta: difference(assessment.reading.energy, prior?.reading.energy),
      priorState: prior?.state || 'unknown',
    },
  };
}

export function deriveHealthState(input = {}, context = {}) {
  const observation = normalizeHealthObservation(input);
  if (!observation.date && !Array.isArray(context.records)) {
    const reasons = [];
    if (observation.riskLevel === 'professional') reasons.push('你明确标记了需要专业关注');
    if (observation.riskLevel === 'attention') reasons.push('你明确标记了需要关注');
    if (observation.sleepHours != null && observation.sleepHours < 6) reasons.push(`睡眠 ${observation.sleepHours} 小时`);
    if (observation.energy != null && observation.energy <= 2) reasons.push(`主观精力 ${observation.energy}/5`);
    let state = 'unknown';
    if (observation.riskLevel === 'professional') state = 'red';
    else if (reasons.length) state = 'yellow';
    else if (observation.sleepHours != null && observation.energy != null) state = 'green';
    return {
      state,
      availableCapacity: STATE_CAPACITY[state],
      reasons: reasons.length ? reasons : state === 'green' ? ['当前人工记录未触发降载条件'] : ['睡眠与精力数据不足'],
      confidence: state === 'unknown' ? 0 : 0.7,
    };
  }
  const records = Array.isArray(context.records) ? context.records : [observation];
  return deriveHealthAssessment(records, observation.date || context.date || '').state === 'unknown' && !observation.date
    ? { state: 'unknown', availableCapacity: null, reasons: ['睡眠与精力数据不足'], confidence: 0 }
    : (() => {
      const assessment = deriveHealthAssessment(records, observation.date || context.date || '');
      return {
        state: assessment.state,
        availableCapacity: assessment.availableCapacity,
        reasons: assessment.reasons,
        confidence: assessment.confidence,
      };
    })();
}

export function buildHealthTrend(records = [], limit = 7) {
  return unique(records.map((item) => item?.date))
    .filter((date) => datePattern.test(date))
    .sort((left, right) => right.localeCompare(left))
    .slice(0, limit)
    .reverse()
    .map((date) => {
      const assessment = deriveHealthAssessment(records, date);
      return {
        date,
        state: assessment.state,
        sleepHours: assessment.reading.sleepHours,
        energy: assessment.reading.energy,
        confidence: assessment.confidence,
      };
    });
}

export function normalizeIntervention(value = {}) {
  return {
    id: value.id || `intervention-${Date.now()}`,
    primaryVariable: clean(value.primaryVariable || value.targetDeviation),
    targetDeviation: clean(value.targetDeviation),
    action: clean(value.action),
    startAt: value.startAt || '',
    evaluationAt: value.evaluationAt || '',
    successCondition: clean(value.successCondition),
    stopCondition: clean(value.stopCondition),
    evaluationResult: clean(value.evaluationResult),
    outcome: ['effective', 'ineffective', 'inconclusive'].includes(value.outcome) ? value.outcome : null,
    evaluatedAt: value.evaluatedAt || null,
    status: ['active', 'completed', 'stopped'].includes(value.status) ? value.status : 'active',
    createdAt: value.createdAt || new Date().toISOString(),
  };
}

export function addSingleVariableIntervention(store = {}, value = {}) {
  const normalized = normalizeHealthStore(store);
  if (normalized.interventions.some((item) => item.status === 'active')) {
    return { store: normalized, started: false, reason: '已有一个主要变量正在验证，请先完成或停止它' };
  }
  const intervention = normalizeIntervention(value);
  if (!intervention.primaryVariable) {
    return { store: normalized, started: false, reason: '请填写唯一主要变量' };
  }
  return {
    store: normalizeHealthStore({ ...normalized, interventions: [...normalized.interventions, intervention] }),
    started: true,
    intervention,
  };
}

export function buildHealthProtocolSnapshot(store = {}, date = '', publishedAt = new Date().toISOString()) {
  const normalized = normalizeHealthStore(store);
  const assessment = deriveHealthDrivingPlan(normalized.observations, date);
  const constraints = unique([...(assessment.basisObservation?.constraint ? [assessment.basisObservation.constraint] : []), ...({
    green: [],
    yellow: ['将计划负载控制在当前可用容量内', '优先保留睡眠与恢复时段'],
    red: ['停止非必要负载', '由用户决定并寻求适当的专业帮助'],
    unknown: ['不得按满负荷排期', '先补充或核对健康数据'],
  }[assessment.state])]);
  const sourceSummary = assessment.reading.sources.reduce((summary, source) => {
    summary[source] = (summary[source] || 0) + 1;
    return summary;
  }, {});
  const activeInterventions = normalized.interventions
    .filter((item) => item.status === 'active')
    .map((item) => ({ id: item.id, evaluationAt: item.evaluationAt }));
  const healthState = {
    state: assessment.state,
    availableCapacity: assessment.availableCapacity,
    reasons: assessment.reasons,
    validUntil: assessment.validUntil,
    evidenceRefs: assessment.evidenceRefs,
    confidence: assessment.confidence,
  };
  const snapshot = {
    schemaVersion: 1,
    date,
    basisDate: assessment.basisDate,
    basisSource: assessment.basisSource,
    publishedAt,
    healthState,
    timeSystem: {
      eventTypes: ['CapacityChanged', 'HealthStateChanged', 'RecoveryConstraintIssued'],
      availableCapacity: assessment.availableCapacity,
      validUntil: assessment.validUntil,
      constraints,
      evidenceRefs: assessment.evidenceRefs,
      privacy: 'capacity_and_constraints_only',
    },
    dailyReview: {
      eventType: 'HealthStateChanged',
      state: assessment.state,
      availableCapacity: assessment.availableCapacity,
      confidence: assessment.confidence,
      basisDate: assessment.basisDate,
      basisSource: assessment.basisSource,
      freshness: assessment.freshness,
      missing: assessment.reading.missing,
      conflicts: assessment.reading.conflicts,
      sourceSummary,
      activeInterventions,
      privacy: 'minimum_health_snapshot',
    },
    boundaries: {
      createsTasks: false,
      writesCalendar: false,
      medicalDiagnosis: false,
      requiresUserApprovalForDownstreamAction: true,
    },
  };
  snapshot.snapshotId = `health-snapshot-${date}-${stableHash(stableStringify({ ...snapshot, publishedAt: null }))}`;
  return snapshot;
}

export function normalizeHealthStore(value = {}) {
  const observations = (Array.isArray(value.observations) ? value.observations : [])
    .map(normalizeHealthObservation)
    .filter((item) => item.date);
  const deduped = new Map(observations.map((item) => [item.observationId, item]));
  const candidates = (Array.isArray(value.candidates) ? value.candidates : [])
    .map(normalizeHealthCandidate)
    .filter((item) => item.candidateId && item.domain === 'health');
  const dedupedCandidates = new Map(candidates.map((item) => [item.candidateId, item]));
  return {
    schemaVersion: 3,
    observations: [...deduped.values()].sort((left, right) => left.date.localeCompare(right.date) || left.source.localeCompare(right.source)),
    candidates: [...dedupedCandidates.values()].sort((left, right) => (right.importedAt || '').localeCompare(left.importedAt || '') || left.candidateId.localeCompare(right.candidateId)),
    interventions: (Array.isArray(value.interventions) ? value.interventions : []).map(normalizeIntervention),
    updatedAt: value.updatedAt || null,
  };
}

export function normalizeHealthProtocolStore(value = {}) {
  const outbox = Array.isArray(value.outbox) ? value.outbox.filter((item) => item?.snapshotId) : [];
  return {
    schemaVersion: 1,
    latest: value.latest?.snapshotId ? value.latest : null,
    outbox: outbox.slice(-30),
    updatedAt: value.updatedAt || null,
  };
}

export function buildHealthHqSnapshot(input = {}, { now = new Date(), staleAfterHours = 36 } = {}) {
  const protocol = normalizeHealthProtocolStore(input);
  const published = protocol.latest;
  const empty = {
    snapshotId: 'health-hq:unpublished', systemId: 'health', schemaVersion: 1,
    generatedAt: null, effectiveDate: null, sourceRefs: [], confidence: 0,
    status: 'unknown', summary: {
      healthSnapshotId: null, effectiveDate: null, state: 'unknown', availableCapacity: null,
      confidence: 0, constraints: [], conflictCount: 0, missingFields: [],
      sourceTypeCount: 0, nextEvaluationAt: null,
    }, constraints: [],
  };
  if (!published?.snapshotId || !timestamp(published.publishedAt)) return empty;
  const publishedAt = new Date(published.publishedAt).getTime();
  const ageMs = new Date(now).getTime() - publishedAt;
  const conflictCount = Array.isArray(published.dailyReview?.conflicts) ? published.dailyReview.conflicts.length : 0;
  const missingFields = Array.isArray(published.dailyReview?.missing) ? unique(published.dailyReview.missing.map(clean)) : [];
  const confidence = numberOrNull(published.healthState?.confidence, 0, 1) ?? 0;
  const rawState = ['green', 'yellow', 'red'].includes(published.healthState?.state) ? published.healthState.state : 'unknown';
  const availableCapacity = numberOrNull(published.healthState?.availableCapacity, 0, 1);
  const constraints = Array.isArray(published.timeSystem?.constraints) ? unique(published.timeSystem.constraints.map(clean)) : [];
  const sourceTypeCount = Object.keys(published.dailyReview?.sourceSummary || {}).length;
  let status = rawState === 'green' ? 'healthy' : rawState === 'yellow' ? 'attention' : rawState === 'red' ? 'alert' : 'unknown';
  let state = rawState;
  if (conflictCount || missingFields.length || confidence < 0.5 || availableCapacity == null) {
    status = 'unknown';
    state = 'unknown';
  } else if (ageMs > Math.max(1, Number(staleAfterHours) || 36) * 60 * 60 * 1000) {
    status = 'stale';
  }
  return {
    snapshotId: `health-hq:${published.snapshotId}`,
    systemId: 'health',
    schemaVersion: 1,
    generatedAt: published.publishedAt,
    effectiveDate: datePattern.test(published.date || '') ? published.date : null,
    sourceRefs: unique(Array.isArray(published.healthState?.evidenceRefs) ? published.healthState.evidenceRefs.map(clean) : []),
    confidence,
    status,
    summary: {
      healthSnapshotId: published.snapshotId,
      effectiveDate: datePattern.test(published.date || '') ? published.date : null,
      state,
      availableCapacity: state === 'unknown' ? null : availableCapacity,
      confidence,
      constraints,
      conflictCount,
      missingFields,
      sourceTypeCount,
      nextEvaluationAt: timestamp(published.timeSystem?.validUntil),
    },
    constraints,
  };
}
