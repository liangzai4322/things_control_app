import { buildHealthProtocolSnapshot, normalizeHealthObservation } from './health-model.js';
import { readHealthStore, upsertHealthObservation, writeHealthStore } from './health-store.js';
import { requestTaskboxApi } from './db.js';

export const HEALTH_DAILY_INTAKE_CONTRACT_VERSION = '2026-09-03.1';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TERMINAL_STATUSES = new Set(['processed', 'ignored']);
const RECEIPT_PROJECTION_FIELDS = Object.freeze([
  'status',
  'availableCapacity',
  'confidence',
  'constraints',
  'missingFields',
  'conflictCount',
  'sourceRefs',
]);

const clean = (value) => String(value || '').trim();
const unique = (values) => [...new Set(values.filter(Boolean))];
const healthData = (intake = {}) => {
  const data = intake.data && typeof intake.data === 'object' ? intake.data : {};
  return data.healthObservation && typeof data.healthObservation === 'object'
    ? { ...data, ...data.healthObservation }
    : data;
};

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function stableHash(value) {
  let hash = 2166136261;
  for (const character of stableStringify(value)) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function invalid(reason, errorCode) {
  return { action: 'failed', reason, errorCode };
}

export function classifyHealthDailyIntake(intake = {}) {
  if (TERMINAL_STATUSES.has(intake.status)) return { action: 'already_terminal', reason: intake.status };
  if (!clean(intake.id) || !clean(intake.idempotencyKey) || !Number.isInteger(intake.revision) || intake.revision < 1) {
    return invalid('intake identity or revision is invalid', 'invalid_intake_identity');
  }
  if (intake.schemaVersion !== 1) return invalid('schema version is unsupported', 'unsupported_schema_version');
  if (intake.contractVersion !== HEALTH_DAILY_INTAKE_CONTRACT_VERSION) {
    return invalid('contract version is unsupported', 'unsupported_contract_version');
  }
  if (intake.systemId !== 'health') return { action: 'ignored', reason: 'not addressed to health' };

  const data = healthData(intake);
  const activityEnd = clean(intake.observationPeriod?.activity_end);
  if (!DATE_PATTERN.test(activityEnd) || !DATE_PATTERN.test(clean(data.observationDate))) {
    return invalid('observation date is missing or invalid', 'invalid_observation_date');
  }
  if (data.observationDate !== activityEnd) {
    return invalid('observation date does not match activity end', 'observation_period_mismatch');
  }
  if (data.authority !== 'explicit_user') {
    return { action: 'ignored', reason: 'health fact lacks explicit user authority' };
  }

  const conflicts = Array.isArray(data.conflicts) ? data.conflicts.filter(Boolean) : [];
  const conflictCount = Math.max(conflicts.length, Number.isFinite(Number(data.conflictCount)) ? Number(data.conflictCount) : 0);
  if (conflictCount > 0) return { action: 'candidate_unknown', reason: 'health facts conflict', conflictCount };

  const observation = buildHealthIntakeObservation(intake);
  const hasHealthFact = observation.sleepHours != null
    || observation.energy != null
    || Boolean(observation.energyText || observation.training || observation.nutrition || observation.symptoms || observation.constraint)
    || ['attention', 'professional'].includes(observation.riskLevel);
  return hasHealthFact
    ? { action: 'process_fact', observation }
    : { action: 'candidate_unknown', reason: 'no explicit health fact was supplied', conflictCount: 0 };
}

export function buildHealthIntakeObservation(intake = {}) {
  const data = healthData(intake);
  const observationDate = clean(data.observationDate);
  const effectiveDate = DATE_PATTERN.test(clean(data.effectiveDate))
    ? data.effectiveDate
    : (DATE_PATTERN.test(clean(intake.reviewDate)) ? intake.reviewDate : observationDate);
  return normalizeHealthObservation({
    observationId: `health-daily-intake:${clean(intake.id)}:r${Number(intake.revision) || 0}`,
    observationDate,
    effectiveDate,
    reviewDate: DATE_PATTERN.test(clean(intake.reviewDate)) ? intake.reviewDate : null,
    sleepHours: data.sleepHours,
    energy: data.energy,
    energyText: data.energyText,
    training: data.training,
    nutrition: data.nutrition,
    symptoms: data.symptoms,
    riskLevel: data.riskLevel || 'unknown',
    constraint: data.constraint,
    interventionExecuted: data.interventionExecuted,
    interventionResult: data.interventionResult,
    tomorrowCapacity: data.tomorrowCapacity,
    source: 'daily_review',
    confidence: data.confidence,
    observedAt: intake.receivedAt || intake.updatedAt || null,
    candidateId: clean(intake.id),
    sourceRef: clean(intake.sourceRef),
    sourceHash: clean(intake.idempotencyKey),
    authority: 'explicit_user',
    dateMapping: 'activity_end',
    evidenceRefs: unique([
      clean(intake.sourceRef),
      ...(Array.isArray(intake.evidenceRefs) ? intake.evidenceRefs.map(clean) : []),
    ]),
  });
}

export function buildHealthReceiptProjection(store = {}, planningDate = '') {
  const snapshot = buildHealthProtocolSnapshot(store, planningDate, `${planningDate}T12:00:00+08:00`);
  const conflictCount = snapshot.dailyReview.conflicts.length;
  const missingFields = unique(snapshot.dailyReview.missing);
  const reliable = !conflictCount
    && !missingFields.length
    && snapshot.healthState.confidence >= 0.5
    && snapshot.healthState.availableCapacity != null;
  return {
    status: reliable ? snapshot.healthState.state : 'unknown',
    availableCapacity: reliable ? snapshot.healthState.availableCapacity : null,
    confidence: snapshot.healthState.confidence,
    constraints: snapshot.timeSystem.constraints,
    missingFields,
    conflictCount,
    sourceRefs: unique(snapshot.healthState.evidenceRefs),
  };
}

export function buildHealthIntakeReceipt(intake, outcome, projection = {}, options = {}) {
  const status = outcome.action === 'process_fact' || outcome.action === 'candidate_unknown'
    ? 'processed'
    : outcome.action === 'ignored' ? 'ignored' : outcome.action === 'retrying' ? 'retrying' : 'failed';
  const defaults = {
    status: 'unknown', availableCapacity: null, confidence: 0, constraints: [],
    missingFields: [], conflictCount: 0, sourceRefs: [],
  };
  const safeProjection = Object.fromEntries(RECEIPT_PROJECTION_FIELDS.map((key) => [key, projection[key] ?? defaults[key]]));
  const body = { status, projection: safeProjection };
  if (outcome.errorCode) body.errorCode = outcome.errorCode;
  if (outcome.reason && ['failed', 'retrying'].includes(status)) body.errorMessage = outcome.reason;
  if (status === 'retrying' && options.retryAt) body.retryAt = options.retryAt;
  body.idempotencyKey = `health-receipt:${clean(intake.id)}:r${intake.revision}:${status}:${stableHash(body)}`;
  return body;
}

function unknownProjection(store, planningDate, conflictCount = 0) {
  const projection = buildHealthReceiptProjection(store, planningDate);
  return {
    ...projection,
    status: 'unknown',
    availableCapacity: null,
    confidence: 0,
    conflictCount: Math.max(projection.conflictCount, conflictCount),
  };
}

export async function consumeHealthDailyIntakes({
  storage = localStorage,
  request = requestTaskboxApi,
  reviewDate = '',
  now = () => new Date(),
} = {}) {
  const query = new URLSearchParams({ systemId: 'health', intake: '1', limit: '100' });
  if (DATE_PATTERN.test(reviewDate)) query.set('reviewDate', reviewDate);
  const payload = await request(`/system-candidates?${query}`);
  if (!Array.isArray(payload?.intakes)) throw new Error('health_daily_intakes_payload_invalid');

  const results = [];
  for (const intake of payload.intakes) {
    const outcome = classifyHealthDailyIntake(intake);
    if (outcome.action === 'already_terminal') {
      results.push({ intakeId: intake.id, action: outcome.action });
      continue;
    }

    const planningDate = DATE_PATTERN.test(clean(intake.reviewDate)) ? intake.reviewDate : clean(healthData(intake).observationDate);
    let store = readHealthStore(storage);
    let receiptOutcome = outcome;
    let projection = unknownProjection(store, planningDate, outcome.conflictCount || 0);
    try {
      if (outcome.action === 'process_fact') {
        const alreadyStored = store.observations.some((item) => item.observationId === outcome.observation.observationId);
        if (!alreadyStored) {
          await request('/health/observations/batch', {
            method: 'POST',
            body: JSON.stringify({ observations: [outcome.observation] }),
          });
          store = writeHealthStore(upsertHealthObservation(store, outcome.observation), storage);
        }
        projection = buildHealthReceiptProjection(store, planningDate);
      }
      const receipt = buildHealthIntakeReceipt(intake, receiptOutcome, projection);
      await request(`/system-candidates/${encodeURIComponent(intake.id)}/receipt`, {
        method: 'POST',
        body: JSON.stringify(receipt),
      });
      results.push({ intakeId: intake.id, action: outcome.action, receiptStatus: receipt.status, observationId: outcome.observation?.observationId || null });
    } catch (error) {
      receiptOutcome = { action: 'retrying', reason: clean(error?.message) || 'health intake processing failed', errorCode: 'health_intake_retryable' };
      const retryAt = new Date(new Date(now()).getTime() + 15 * 60 * 1000).toISOString();
      const retryReceipt = buildHealthIntakeReceipt(intake, receiptOutcome, projection, { retryAt });
      try {
        await request(`/system-candidates/${encodeURIComponent(intake.id)}/receipt`, {
          method: 'POST',
          body: JSON.stringify(retryReceipt),
        });
      } catch {
        // The intake remains remotely retryable; local health data is never rolled back or erased.
      }
      results.push({ intakeId: intake.id, action: 'retrying', error: receiptOutcome.reason, observationId: outcome.observation?.observationId || null });
    }
  }
  return { processed: results.length, results };
}
