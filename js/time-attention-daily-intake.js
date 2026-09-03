export const ATTENTION_INTAKE_SYSTEM_ID = 'attention';
export const ATTENTION_INTAKE_CONTRACT_VERSION = '2026-09-03.1';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TERMINAL_STATUSES = new Set(['processed', 'failed', 'ignored']);
const INTAKE_STATUSES = new Set(['accepted', 'processing', 'retrying', 'failed', 'processed', 'ignored']);
const OVERLOAD_VALUES = new Set(['normal', 'warning', 'overloaded', 'unknown']);
const VARIANCE_VALUES = new Set(['within_plan', 'overrun', 'underrun', 'unknown']);
const CONFLICT_VALUES = new Set(['clear', 'conflict', 'unknown']);

const plainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const clean = (value) => typeof value === 'string' ? value.trim() : '';
const finiteNumber = (value, min = -Infinity, max = Infinity) => (
  value === null || value === undefined || value === '' || !Number.isFinite(Number(value))
    ? null
    : Math.min(max, Math.max(min, Number(value)))
);
const validTimestamp = (value) => typeof value === 'string' && value && !Number.isNaN(new Date(value).getTime());
const validDateKey = (value) => {
  if (!DATE_PATTERN.test(value || '')) return false;
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
};
const cleanRefs = (value) => Array.isArray(value)
  ? [...new Set(value.map(clean).filter(Boolean))]
  : [];
const mergeRefs = (...values) => cleanRefs(values.flatMap((value) => Array.isArray(value) ? value : []));

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!plainObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function intakeFingerprint(intake) {
  return JSON.stringify(stableValue({
    id: intake.id,
    contractVersion: intake.contractVersion,
    revision: intake.revision,
    reviewDate: intake.reviewDate,
    observationPeriod: intake.observationPeriod,
    freshness: intake.freshness,
    data: intake.data,
  }));
}

function validationError(code, detail = {}) {
  return { ok: false, code, ...detail };
}

export function validateAttentionIntake(intake, {
  reviewDate = null,
  expectedStatus = null,
  supportedContractVersions = [ATTENTION_INTAKE_CONTRACT_VERSION],
} = {}) {
  if (!plainObject(intake)) return validationError('invalid_intake');
  if (!clean(intake.id)) return validationError('missing_intake_id');
  if (intake.schemaVersion !== 1) return validationError('unsupported_schema_version');
  if (!supportedContractVersions.includes(intake.contractVersion)) {
    return validationError('unsupported_contract_version', { contractVersion: intake.contractVersion || null });
  }
  if (intake.systemId !== ATTENTION_INTAKE_SYSTEM_ID) return validationError('wrong_system_id');
  if (!validDateKey(intake.reviewDate)) return validationError('invalid_review_date');
  if (reviewDate && intake.reviewDate !== reviewDate) return validationError('review_date_mismatch');
  if (!plainObject(intake.observationPeriod)) return validationError('invalid_observation_period');
  const activityStart = intake.observationPeriod.activity_start;
  const activityEnd = intake.observationPeriod.activity_end;
  if (!validTimestamp(activityStart) || !validTimestamp(activityEnd) || new Date(activityEnd) < new Date(activityStart)) {
    return validationError('invalid_activity_period');
  }
  if (!clean(intake.sourceRef)) return validationError('invalid_source_ref');
  if (!Array.isArray(intake.evidenceRefs) || intake.evidenceRefs.some((item) => typeof item !== 'string')) {
    return validationError('invalid_evidence_refs');
  }
  if (intake.freshness !== 'unknown' && !validTimestamp(intake.freshness)) return validationError('invalid_freshness');
  if (!Number.isSafeInteger(intake.revision) || intake.revision < 1) return validationError('invalid_revision');
  if (!clean(intake.idempotencyKey)) return validationError('missing_idempotency_key');
  if (!plainObject(intake.data)) return validationError('invalid_data');
  if (intake.data.reviewDate !== intake.reviewDate) return validationError('data_review_date_mismatch');
  for (const field of ['capacity', 'planned', 'actual', 'variance']) {
    if (!plainObject(intake.data[field])) return validationError('missing_attention_field', { field });
  }
  if (!Array.isArray(intake.data.protectedFocusWindows)) {
    return validationError('missing_attention_field', { field: 'protectedFocusWindows' });
  }
  if (!Object.hasOwn(intake.data, 'calendarCoverage')) {
    return validationError('missing_attention_field', { field: 'calendarCoverage' });
  }
  if (!INTAKE_STATUSES.has(intake.status)) return validationError('invalid_status');
  if (expectedStatus && intake.status !== expectedStatus) return validationError('intake_status_mismatch');
  if (!validTimestamp(intake.receivedAt) || !validTimestamp(intake.updatedAt)) return validationError('invalid_transport_timestamp');
  if (new Date(intake.updatedAt) < new Date(intake.receivedAt)) return validationError('invalid_transport_timestamp_order');
  if (intake.receipt != null && !plainObject(intake.receipt)) return validationError('invalid_receipt');
  return { ok: true };
}

function normalizeProtectedWindows(value) {
  if (!Array.isArray(value)) return [];
  return value.map((window) => {
    if (!plainObject(window)) return null;
    const startAt = clean(window.startAt || window.start);
    const endAt = clean(window.endAt || window.end);
    if (!validTimestamp(startAt) || !validTimestamp(endAt) || new Date(endAt) <= new Date(startAt)) return null;
    const conflictState = CONFLICT_VALUES.has(window.conflictState)
      ? window.conflictState
      : window.conflict === true ? 'conflict' : window.conflict === false ? 'clear' : 'unknown';
    return { startAt, endAt, conflictState };
  }).filter(Boolean);
}

function normalizeLeakage(value) {
  if (!plainObject(value)) return null;
  const type = clean(value.type);
  if (!type) return null;
  return {
    type,
    occurredAt: validTimestamp(value.occurredAt) ? value.occurredAt : null,
    durationMinutes: finiteNumber(value.durationMinutes, 0, 1440),
    severity: clean(value.severity) || 'unknown',
  };
}

function normalizeVariance(value) {
  if (!plainObject(value)) return null;
  const status = VARIANCE_VALUES.has(value.status) ? value.status : 'unknown';
  return {
    plannedMinutes: finiteNumber(value.plannedMinutes, 0, 1440),
    actualMinutes: finiteNumber(value.actualMinutes, 0, 1440),
    deltaMinutes: finiteNumber(value.deltaMinutes, -1440, 1440),
    status,
  };
}

export function buildAttentionReceiptProjection(intake) {
  const data = plainObject(intake?.data?.attention) ? intake.data.attention : intake?.data || {};
  const capacity = plainObject(data.capacity) ? data.capacity : data;
  const dataQuality = plainObject(data.dataQuality) ? data.dataQuality : {};
  const protectedWindows = normalizeProtectedWindows(data.protectedFocusWindows || data.protectedWindows);
  const freshnessUnknown = intake?.freshness === 'unknown' ? ['intake.freshness'] : [];
  const availableMinutes = finiteNumber(capacity.availableMinutes, 0, 1440);
  const remainingMinutes = finiteNumber(capacity.remainingMinutes, -1440, 1440);
  const healthCapacity = finiteNumber(capacity.healthCapacity, 0, 1);
  const inferredMissing = [
    availableMinutes == null ? 'capacity.availableMinutes' : null,
    remainingMinutes == null ? 'capacity.remainingMinutes' : null,
    healthCapacity == null ? 'capacity.healthCapacity' : null,
    ...freshnessUnknown,
  ].filter(Boolean);
  return {
    availableMinutes,
    remainingMinutes,
    healthCapacity,
    overloadState: OVERLOAD_VALUES.has(capacity.overloadState) ? capacity.overloadState : 'unknown',
    protectedWindows,
    conflictCount: protectedWindows.filter((window) => window.conflictState === 'conflict').length,
    topLeakage: normalizeLeakage(data.topLeakage || data.highestLeak),
    variance: normalizeVariance(data.variance),
    missingFieldRefs: mergeRefs(dataQuality.missingFields, data.missingFieldRefs, inferredMissing),
    staleFieldRefs: mergeRefs(dataQuality.staleSources, data.staleFieldRefs),
  };
}

export function attentionReceiptIdempotencyKey(intake, status = 'processed') {
  return `${clean(intake.idempotencyKey)}:attention:${status}:r${intake.revision}`;
}

export function buildAttentionReceipt(intake, { status = 'processed' } = {}) {
  return {
    status,
    idempotencyKey: attentionReceiptIdempotencyKey(intake, status),
    projection: buildAttentionReceiptProjection(intake),
  };
}

function emptyAttentionProjection() {
  return {
    availableMinutes: null,
    remainingMinutes: null,
    healthCapacity: null,
    overloadState: 'unknown',
    protectedWindows: [],
    conflictCount: 0,
    topLeakage: null,
    variance: null,
    missingFieldRefs: ['intake.contractVersion'],
    staleFieldRefs: [],
  };
}

function canSafelyIgnoreContract(intake, reviewDate, supportedContractVersions) {
  return plainObject(intake)
    && intake.schemaVersion === 1
    && clean(intake.id)
    && intake.systemId === ATTENTION_INTAKE_SYSTEM_ID
    && validDateKey(intake.reviewDate)
    && (!reviewDate || intake.reviewDate === reviewDate)
    && Number.isSafeInteger(intake.revision)
    && intake.revision > 0
    && clean(intake.idempotencyKey)
    && typeof intake.contractVersion === 'string'
    && !supportedContractVersions.includes(intake.contractVersion);
}

function buildIgnoredContractReceipt(intake) {
  return {
    status: 'ignored',
    idempotencyKey: attentionReceiptIdempotencyKey(intake, 'ignored'),
    projection: emptyAttentionProjection(),
    errorCode: 'unsupported_contract_version',
    errorMessage: 'Unsupported attention intake contract version.',
  };
}

export function prepareAttentionIntakes(intakes, options = {}) {
  const accepted = [];
  const rejected = [];
  const skipped = [];
  const seen = new Map();
  (Array.isArray(intakes) ? intakes : []).forEach((intake) => {
    const validation = validateAttentionIntake(intake, options);
    if (!validation.ok) {
      rejected.push({ id: intake?.id || null, ...validation });
      return;
    }
    if (TERMINAL_STATUSES.has(intake.status)) {
      skipped.push({ id: intake.id, reason: 'terminal_status' });
      return;
    }
    const key = intake.idempotencyKey;
    const fingerprint = intakeFingerprint(intake);
    if (seen.has(key)) {
      if (seen.get(key) === fingerprint) skipped.push({ id: intake.id, reason: 'duplicate_idempotent_replay' });
      else rejected.push({ id: intake.id, ok: false, code: 'idempotency_key_collision' });
      return;
    }
    seen.set(key, fingerprint);
    accepted.push(intake);
  });
  return { accepted, rejected, skipped };
}

export async function consumeAttentionDailyReviewIntakes({
  request,
  reviewDate = null,
  status = 'accepted',
  limit = 100,
  supportedContractVersions = [ATTENTION_INTAKE_CONTRACT_VERSION],
} = {}) {
  if (typeof request !== 'function') throw new Error('attention_intake_request_required');
  if (reviewDate != null && !validDateKey(reviewDate)) throw new Error('invalid_review_date');
  if (!['accepted', 'retrying'].includes(status)) throw new Error('invalid_intake_status');
  const safeLimit = Math.max(1, Math.min(500, Number(limit) || 100));
  const query = new URLSearchParams({ systemId: ATTENTION_INTAKE_SYSTEM_ID, intake: '1' });
  if (reviewDate) query.set('reviewDate', reviewDate);
  query.set('status', status);
  query.set('limit', String(safeLimit));
  const response = await request(`/system-candidates?${query.toString()}`);
  if (response == null) return { connected: false, processed: [], ignored: [], failures: [], rejected: [], skipped: [] };
  if (!plainObject(response) || !Array.isArray(response.intakes)) throw new Error('invalid_intake_response');
  const incompatible = response.intakes.filter((intake) => canSafelyIgnoreContract(
    intake, reviewDate, supportedContractVersions,
  ));
  const ignored = [];
  const failures = [];
  for (const intake of incompatible) {
    const receipt = buildIgnoredContractReceipt(intake);
    try {
      const result = await request(`/system-candidates/${encodeURIComponent(intake.id)}/receipt`, {
        method: 'POST',
        body: JSON.stringify(receipt),
      });
      ignored.push({ id: intake.id, revision: intake.revision, receipt, result });
    } catch (error) {
      failures.push({ id: intake.id, revision: intake.revision, errorCode: clean(error?.code) || `http_${error?.status || 'request_failed'}` });
    }
  }
  const incompatibleIds = new Set(incompatible.map((intake) => intake.id));
  const prepared = prepareAttentionIntakes(
    response.intakes.filter((intake) => !incompatibleIds.has(intake?.id)),
    { reviewDate, expectedStatus: status, supportedContractVersions },
  );
  const processed = [];
  for (const intake of prepared.accepted) {
    const receipt = buildAttentionReceipt(intake);
    try {
      const result = await request(`/system-candidates/${encodeURIComponent(intake.id)}/receipt`, {
        method: 'POST',
        body: JSON.stringify(receipt),
      });
      processed.push({ id: intake.id, revision: intake.revision, receipt, result });
    } catch (error) {
      failures.push({ id: intake.id, revision: intake.revision, errorCode: clean(error?.code) || `http_${error?.status || 'request_failed'}` });
    }
  }
  return { connected: true, processed, ignored, failures, rejected: prepared.rejected, skipped: prepared.skipped };
}
