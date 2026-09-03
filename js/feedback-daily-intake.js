const CONTRACT_VERSION = '2026-09-03.1';
const SYSTEM_ID = 'feedback';
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_FRESHNESS_AGE_MS = 72 * 60 * 60 * 1000;
const EXTERNAL_RESULT_FIELDS = Object.freeze([
  'published', 'conversations', 'quotes', 'deals', 'delivered', 'collected', 'feedback',
]);
const REQUIRED_EXTERNAL_RESULT_FIELDS = new Set(['published', 'conversations', 'quotes', 'deals', 'feedback']);

const clean = (value) => String(value ?? '').trim();
const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const asArray = (value) => value == null ? [] : Array.isArray(value) ? value : [value];
const isDate = (value) => {
  const text = clean(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const [year, month, day] = text.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
};

function normalizeEvidenceRefs(value) {
  return [...new Map(asArray(value).map((item) => {
    if (typeof item === 'string') return [clean(item), clean(item)];
    if (!isObject(item)) return ['', null];
    const key = clean(item.refId || item.sourceId || item.uri);
    return [key, key ? { ...item, refId: clean(item.refId) || key } : null];
  }).filter(([key, item]) => key && item)).values()];
}

function inputGap(code, field, severity = 'medium') {
  return Object.freeze({ code, field, severity });
}

function normalizeExternalResult(data, field, gaps) {
  const raw = data[field];
  const record = isObject(raw) ? raw : { value: raw };
  const value = record.value == null || record.value === '' ? null : Number(record.value);
  const normalizedValue = Number.isFinite(value) && value >= 0 ? value : null;
  const refs = normalizeEvidenceRefs(record.evidenceRefs || data[`${field}EvidenceRefs`]);
  const status = clean(record.status) || (normalizedValue == null ? 'unknown' : 'observed');

  if (!Object.hasOwn(data, field) && REQUIRED_EXTERNAL_RESULT_FIELDS.has(field)) {
    gaps.push(inputGap('missing_external_result', `data.${field}`, 'low'));
  }
  else if (record.value != null && normalizedValue == null) gaps.push(inputGap('invalid_external_result', `data.${field}`));
  if (normalizedValue != null && normalizedValue > 0 && !refs.length) {
    gaps.push(inputGap('missing_independent_evidence', `data.${field}.evidenceRefs`, 'high'));
  }

  return Object.freeze({ value: normalizedValue, status, evidenceRefs: refs });
}

function normalizeCandidateRecords(data, singular, plural, kind, gaps) {
  const idField = kind === 'deviation' ? 'deviationId' : kind === 'experiment' ? 'experimentId' : 'ruleId';
  const records = [...asArray(data[plural]), ...asArray(data[singular])].filter(isObject).filter((record, index, all) => {
    const id = clean(record[idField]);
    if (id) return all.findIndex((candidate) => clean(candidate[idField]) === id) === index;
    return all.findIndex((candidate) => JSON.stringify(candidate) === JSON.stringify(record)) === index;
  });
  return records.map((record, index) => {
    const refs = normalizeEvidenceRefs(record.evidenceRefs);
    if (!refs.length) gaps.push(inputGap('missing_record_evidence', `data.${plural}[${index}].evidenceRefs`));
    return Object.freeze({
      ...record,
      status: kind === 'deviation' ? 'candidate_unvalidated' : 'proposed',
      evidenceRefs: refs,
      approvedBy: null,
      approvedAt: null,
      implementationAuthorized: false,
    });
  });
}

function validateWindow(intake, now, maxFreshnessAgeMs, gaps, errors) {
  const period = isObject(intake.observationPeriod) ? intake.observationPeriod : {};
  const start = clean(period.activity_start);
  const end = clean(period.activity_end);
  const reviewDate = clean(intake.reviewDate);

  if (!isDate(start) || !isDate(end) || !isDate(reviewDate) || start > end || end > reviewDate) {
    errors.push('invalid_observation_window');
  } else {
    const ageMs = Date.parse(`${reviewDate}T23:59:59Z`) - Date.parse(`${end}T23:59:59Z`);
    if (ageMs > 7 * DAY_MS) gaps.push(inputGap('observation_window_old', 'observationPeriod', 'medium'));
  }

  const freshness = clean(intake.freshness);
  if (!freshness || freshness === 'unknown') {
    gaps.push(inputGap('freshness_unknown', 'freshness', 'medium'));
  } else {
    const freshnessAt = Date.parse(freshness);
    if (!Number.isFinite(freshnessAt)) errors.push('invalid_freshness');
    else if (freshnessAt > now.getTime() + 5 * 60 * 1000) errors.push('future_freshness');
    else if (now.getTime() - freshnessAt > maxFreshnessAgeMs) errors.push('stale_intake');
  }

  return Object.freeze({
    reviewDate: isDate(reviewDate) ? reviewDate : null,
    activityStart: isDate(start) ? start : null,
    activityEnd: isDate(end) ? end : null,
    timezone: 'Asia/Shanghai',
  });
}

function evidenceCoverage(records) {
  const evidenced = records.filter((record) => record.evidenceRefs.length).length;
  return records.length ? Math.round(evidenced / records.length * 100) : null;
}

function reference(record, idField) {
  if (!record) return null;
  const id = clean(record[idField]);
  return id ? Object.freeze({ id, status: record.status }) : null;
}

export const FEEDBACK_DAILY_INTAKE_CONTRACT = Object.freeze({
  schemaVersion: 1,
  contractVersion: CONTRACT_VERSION,
  systemId: SYSTEM_ID,
  externalResultFields: EXTERNAL_RESULT_FIELDS,
  receiptStatuses: Object.freeze(['received', 'processing', 'processed', 'retrying', 'failed', 'ignored']),
});

export function buildFeedbackDailyIntakeReceipt(intake = {}, {
  now = new Date(),
  maxFreshnessAgeMs = DEFAULT_MAX_FRESHNESS_AGE_MS,
} = {}) {
  const errors = [];
  const gaps = [];
  const data = isObject(intake.data) ? intake.data : {};
  const revision = Number(intake.revision);
  const expectedIdempotencyPrefix = `${SYSTEM_ID}:${clean(intake.reviewDate)}:${revision}:`;
  const suppliedIdempotencyKey = clean(intake.idempotencyKey);

  if (Number(intake.schemaVersion) !== 1) errors.push('unsupported_schema_version');
  if (clean(intake.contractVersion) !== CONTRACT_VERSION) errors.push('unsupported_contract_version');
  if (clean(intake.systemId) !== SYSTEM_ID) errors.push('wrong_target_system');
  if (!clean(intake.id)) errors.push('missing_intake_id');
  if (!clean(intake.sourceRef)) errors.push('missing_source_ref');
  if (!normalizeEvidenceRefs(intake.evidenceRefs).length) gaps.push(inputGap('missing_intake_evidence', 'evidenceRefs', 'high'));
  if (!Number.isSafeInteger(revision) || revision < 1) errors.push('invalid_revision');
  if (!suppliedIdempotencyKey.startsWith(expectedIdempotencyPrefix) || suppliedIdempotencyKey.length === expectedIdempotencyPrefix.length) {
    errors.push('invalid_idempotency_key');
  }
  if (!isObject(intake.data)) errors.push('invalid_data');
  if (!isDate(data.reviewDate)) errors.push('missing_data_review_date');
  else if (clean(data.reviewDate) !== clean(intake.reviewDate)) errors.push('data_review_date_mismatch');
  for (const field of REQUIRED_EXTERNAL_RESULT_FIELDS) {
    if (!Object.hasOwn(data, field)) errors.push(`missing_required_data_field:${field}`);
  }

  const window = validateWindow(intake, now, maxFreshnessAgeMs, gaps, errors);
  const externalResults = Object.fromEntries(EXTERNAL_RESULT_FIELDS.map((field) => [
    field, normalizeExternalResult(data, field, gaps),
  ]));
  const deviations = normalizeCandidateRecords(data, 'variance', 'deviations', 'deviation', gaps);
  const experiments = normalizeCandidateRecords(data, 'experiment', 'experiments', 'experiment', gaps);
  const rules = normalizeCandidateRecords(data, 'rule', 'rules', 'rule', gaps);
  const samples = [...asArray(data.sample), ...asArray(data.samples)].filter(isObject).map((record, index) => {
    const refs = normalizeEvidenceRefs(record.evidenceRefs);
    if (!refs.length) gaps.push(inputGap('missing_sample_evidence', `data.samples[${index}].evidenceRefs`, 'high'));
    return Object.freeze({ ...record, status: 'candidate_unvalidated', evidenceRefs: refs });
  });

  const factualExternalResults = Object.values(externalResults).filter((record) => record.value != null && record.value > 0);
  const evidenceRecords = [...factualExternalResults, ...deviations, ...experiments, ...rules, ...samples];
  const projection = Object.freeze({
    windowSummary: Object.freeze({
      ...window,
      externalResults: Object.freeze(Object.fromEntries(Object.entries(externalResults).map(([field, record]) => [
        field, Object.freeze({ value: record.value, status: record.status }),
      ]))),
    }),
    deviationCount: deviations.length,
    pendingApprovalCount: experiments.length + rules.length,
    currentExperimentRef: reference(experiments[0], 'experimentId'),
    currentRuleRef: reference(rules[0], 'ruleId'),
    evidenceCoverage: evidenceCoverage(evidenceRecords),
    inputGaps: Object.freeze([...new Map(gaps.map((gap) => [`${gap.code}:${gap.field}`, gap])).values()]),
  });
  const status = errors.length ? 'ignored' : 'processed';
  const receiptBaseKey = suppliedIdempotencyKey.startsWith(expectedIdempotencyPrefix)
    && suppliedIdempotencyKey.length > expectedIdempotencyPrefix.length
    ? suppliedIdempotencyKey
    : `${SYSTEM_ID}:${clean(intake.reviewDate) || 'unknown'}:${Number.isSafeInteger(revision) ? revision : 'invalid'}:${clean(intake.id) || 'missing'}`;
  const idempotencyKey = `${receiptBaseKey}:feedback-receipt:${status}:v1`;
  const receipt = Object.freeze({
    status,
    idempotencyKey,
    projection,
    ...(errors.length ? { errorCode: errors[0], errorMessage: errors.join(',') } : {}),
  });

  return Object.freeze({
    receipt,
    normalized: Object.freeze({ externalResults, deviations, experiments, rules, samples }),
    errors: Object.freeze(errors),
  });
}

export async function consumeFeedbackDailyIntakes({
  request,
  reviewDate = '',
  status = '',
  limit = 100,
  now = new Date(),
  maxFreshnessAgeMs = DEFAULT_MAX_FRESHNESS_AGE_MS,
} = {}) {
  if (typeof request !== 'function') throw new TypeError('request function is required');
  const params = new URLSearchParams({ systemId: SYSTEM_ID, intake: '1', limit: String(Math.max(1, Math.min(500, Number(limit) || 100))) });
  if (reviewDate) params.set('reviewDate', reviewDate);
  if (status) params.set('status', status);
  const response = await request(`/system-candidates?${params}`);
  if (!response || !Array.isArray(response.intakes)) throw new Error('invalid_feedback_intake_response');

  const results = [];
  const skipped = [];
  for (const intake of response.intakes) {
    const existingStatus = clean(intake?.receipt?.status || intake?.status);
    if (existingStatus === 'processed' || existingStatus === 'ignored') {
      skipped.push(Object.freeze({ intakeId: clean(intake.id), revision: Number(intake.revision), status: existingStatus }));
      continue;
    }
    const built = buildFeedbackDailyIntakeReceipt(intake, { now, maxFreshnessAgeMs });
    if (!clean(intake.id)) {
      results.push(Object.freeze({ intakeId: '', revision: Number(intake.revision), ...built, response: null }));
      continue;
    }
    const receipt = await request(`/system-candidates/${encodeURIComponent(clean(intake.id))}/receipt`, {
      method: 'POST',
      body: JSON.stringify(built.receipt),
    });
    results.push(Object.freeze({ intakeId: clean(intake.id), revision: Number(intake.revision), ...built, response: receipt }));
  }
  return Object.freeze({
    systemId: SYSTEM_ID,
    count: results.length,
    skippedCount: skipped.length,
    results: Object.freeze(results),
    skipped: Object.freeze(skipped),
  });
}
