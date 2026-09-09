import {
  buildHealthIntakeReceipt,
  buildHealthReceiptProjection,
  buildUnknownHealthReceiptProjection,
  classifyHealthDailyIntake,
  healthIntakeData,
} from './health-daily-intake-core.js';
import { readHealthStore, upsertHealthObservation, writeHealthStore } from './health-store.js';
import { requestTaskboxApi } from './db.js';

export * from './health-daily-intake-core.js';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const clean = (value) => String(value || '').trim();

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

    const planningDate = DATE_PATTERN.test(clean(intake.reviewDate)) ? intake.reviewDate : clean(healthIntakeData(intake).observationDate);
    let store = readHealthStore(storage);
    let receiptOutcome = outcome;
    let projection = buildUnknownHealthReceiptProjection(store, intake, outcome.conflictCount || 0);
    try {
      if (outcome.action === 'process_fact') {
        const alreadyStored = store.observations.some((item) => item.observationId === outcome.observation.observationId);
        if (!alreadyStored) {
          await request('/health/observations/batch', {
            method: 'POST', body: JSON.stringify({ observations: [outcome.observation] }),
          });
          store = writeHealthStore(upsertHealthObservation(store, outcome.observation), storage);
        }
        projection = buildHealthReceiptProjection(store, planningDate);
      }
      const receipt = buildHealthIntakeReceipt(intake, receiptOutcome, projection);
      await request(`/system-candidates/${encodeURIComponent(intake.id)}/receipt`, {
        method: 'POST', body: JSON.stringify(receipt),
      });
      results.push({ intakeId: intake.id, action: outcome.action, receiptStatus: receipt.status, observationId: outcome.observation?.observationId || null });
    } catch (error) {
      receiptOutcome = { action: 'retrying', reason: clean(error?.message) || 'health intake processing failed', errorCode: 'health_intake_retryable' };
      const retryAt = new Date(new Date(now()).getTime() + 15 * 60 * 1000).toISOString();
      const retryReceipt = buildHealthIntakeReceipt(intake, receiptOutcome, projection, { retryAt });
      try {
        await request(`/system-candidates/${encodeURIComponent(intake.id)}/receipt`, {
          method: 'POST', body: JSON.stringify(retryReceipt),
        });
      } catch {}
      results.push({ intakeId: intake.id, action: 'retrying', error: receiptOutcome.reason, observationId: outcome.observation?.observationId || null });
    }
  }
  return { processed: results.length, results };
}
