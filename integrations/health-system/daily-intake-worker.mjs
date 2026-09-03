import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildHealthIntakeReceipt,
  buildHealthReceiptProjection,
  buildUnknownHealthReceiptProjection,
  classifyHealthDailyIntake,
} from '../../js/health-daily-intake-core.js';
import { normalizeHealthStore } from '../../js/health-model.js';

const ACTIVE_STATUSES = Object.freeze(['accepted', 'retrying']);
const DEFAULT_ENDPOINT = 'https://liangzai666.com/taskbox-api';
const DEFAULT_TOKEN_FILE = '/etc/taskbox-daily-intake/health.token';
const DEFAULT_GLOBAL_DISABLE_FILE = '/etc/taskbox-daily-intake.disabled';
const DEFAULT_HEALTH_DISABLE_FILE = '/etc/taskbox-health-daily-intake.disabled';

const clean = (value) => String(value || '').trim();
const expandHome = (value) => clean(value).startsWith('~/') ? path.join(os.homedir(), clean(value).slice(2)) : clean(value);
const readFile = (filePath) => {
  try { return fs.readFileSync(expandHome(filePath), 'utf8').trim(); } catch { return ''; }
};

export class HealthDailyIntakeError extends Error {
  constructor(code, { status = 0, payload = null, cause } = {}) {
    super(code, cause ? { cause } : undefined);
    this.name = 'HealthDailyIntakeError';
    this.code = code;
    this.status = status;
    this.payload = payload;
  }
}

function parseJson(value) {
  try { return value ? JSON.parse(value) : {}; }
  catch { return {}; }
}

function deterministicRetryMinutes(intake) {
  const attempts = Math.max(0, Number(intake?.receipt?.attempts) || 0);
  const exponential = Math.min(360, 15 * (2 ** Math.min(attempts, 5)));
  const jitter = [...clean(intake?.id)].reduce((sum, character) => sum + character.codePointAt(0), 0) % 6;
  return exponential + jitter;
}

function retryDue(intake, now) {
  const retryAt = Date.parse(clean(intake?.receipt?.retryAt));
  return !Number.isFinite(retryAt) || retryAt <= now.getTime();
}

export class HealthDailyIntakeWorker {
  constructor({
    endpoint,
    token,
    fetchImpl = globalThis.fetch,
    now = () => new Date(),
    globalDisableFile = DEFAULT_GLOBAL_DISABLE_FILE,
    healthDisableFile = DEFAULT_HEALTH_DISABLE_FILE,
  } = {}) {
    this.endpoint = clean(endpoint).replace(/\/+$/, '');
    this.token = clean(token);
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.globalDisableFile = globalDisableFile;
    this.healthDisableFile = healthDisableFile;
    if (!this.endpoint) throw new HealthDailyIntakeError('health_intake_endpoint_required');
    if (!this.token) throw new HealthDailyIntakeError('health_intake_token_required');
    if (typeof this.fetchImpl !== 'function') throw new HealthDailyIntakeError('health_intake_fetch_required');
  }

  isDisabled() {
    return [this.globalDisableFile, this.healthDisableFile].some((filePath) => filePath && fs.existsSync(filePath));
  }

  async request(pathname, { method = 'GET', body } = {}) {
    let response;
    try {
      response = await this.fetchImpl(`${this.endpoint}${pathname}`, {
        method,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${this.token}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (cause) {
      throw new HealthDailyIntakeError('health_intake_unreachable', { cause });
    }
    const payload = parseJson(await response.text());
    if (!response.ok) throw new HealthDailyIntakeError(payload.error || 'health_intake_request_failed', { status: response.status, payload });
    return payload;
  }

  async list(status, limit = 100) {
    const query = new URLSearchParams({ systemId: 'health', intake: '1', status, limit: String(limit) });
    const payload = await this.request(`/v1/system-candidates?${query}`);
    if (!Array.isArray(payload.intakes)) throw new HealthDailyIntakeError('health_intake_payload_invalid');
    return payload.intakes;
  }

  async readHealthStore() {
    const payload = await this.request('/v1/health/observations?limit=365');
    if (!Array.isArray(payload.observations)) throw new HealthDailyIntakeError('health_observations_payload_invalid');
    return normalizeHealthStore({ observations: payload.observations });
  }

  async writeObservation(observation) {
    return this.request('/v1/health/observations/batch', {
      method: 'POST', body: { observations: [observation] },
    });
  }

  async writeReceipt(intake, receipt) {
    return this.request(`/v1/system-candidates/${encodeURIComponent(intake.id)}/receipt`, {
      method: 'POST', body: receipt,
    });
  }

  async probe() {
    const [accepted, retrying, health] = await Promise.all([
      this.list('accepted', 1),
      this.list('retrying', 1),
      this.request('/v1/health/observations?limit=1'),
    ]);
    let crossSystemDenied = false;
    try { await this.request('/v1/system-candidates?systemId=execution&intake=1&limit=1'); }
    catch (error) { crossSystemDenied = error.status === 403; }
    if (!crossSystemDenied) throw new HealthDailyIntakeError('health_intake_cross_system_scope_failed');
    return { ok: true, accepted: accepted.length, retrying: retrying.length, healthRead: Array.isArray(health.observations), crossSystemDenied };
  }

  async consume(intake, initialStore) {
    const outcome = classifyHealthDailyIntake(intake);
    let store = initialStore;
    let projection = buildUnknownHealthReceiptProjection(store, intake, outcome.conflictCount || 0);
    try {
      if (outcome.action === 'process_fact') {
        await this.writeObservation(outcome.observation);
        store = normalizeHealthStore({
          ...store,
          observations: [...store.observations.filter((item) => item.observationId !== outcome.observation.observationId), outcome.observation],
        });
        projection = buildHealthReceiptProjection(store, intake.reviewDate);
      }
      const receipt = buildHealthIntakeReceipt(intake, outcome, projection);
      await this.writeReceipt(intake, receipt);
      return { store, intakeId: intake.id, status: receipt.status, observationId: outcome.observation?.observationId || null };
    } catch (error) {
      const retryAt = new Date(this.now().getTime() + deterministicRetryMinutes(intake) * 60_000).toISOString();
      const retryOutcome = { action: 'retrying', reason: error.code || error.message || 'health_intake_retryable', errorCode: 'health_intake_retryable' };
      const receipt = buildHealthIntakeReceipt(intake, retryOutcome, projection, { retryAt });
      try { await this.writeReceipt(intake, receipt); }
      catch (receiptError) {
        throw new HealthDailyIntakeError('health_retry_receipt_failed', {
          status: receiptError.status || 0, payload: receiptError.payload, cause: receiptError,
        });
      }
      return { store, intakeId: intake.id, status: 'retrying', retryAt, error: retryOutcome.reason };
    }
  }

  async runOnce() {
    if (this.isDisabled()) return { ok: true, disabled: true, processed: 0, results: [] };
    const now = this.now();
    const groups = await Promise.all(ACTIVE_STATUSES.map((status) => this.list(status)));
    const intakes = groups.flat().filter((intake) => intake.status !== 'retrying' || retryDue(intake, now));
    let store = await this.readHealthStore();
    const results = [];
    for (const intake of intakes) {
      const result = await this.consume(intake, store);
      const { store: nextStore, ...summary } = result;
      store = nextStore;
      results.push(summary);
    }
    return { ok: true, disabled: false, processed: results.length, results };
  }
}

export function createHealthDailyIntakeWorkerFromEnv(env = process.env, options = {}) {
  const tokenFile = env.DAILY_INTAKE_HEALTH_TOKEN_FILE || DEFAULT_TOKEN_FILE;
  return new HealthDailyIntakeWorker({
    endpoint: env.DAILY_INTAKE_ENDPOINT || env.TASKBOX_API_ENDPOINT || DEFAULT_ENDPOINT,
    token: clean(env.DAILY_INTAKE_HEALTH_TOKEN) || readFile(tokenFile),
    globalDisableFile: env.DAILY_INTAKE_DISABLE_FILE || DEFAULT_GLOBAL_DISABLE_FILE,
    healthDisableFile: env.HEALTH_DAILY_INTAKE_DISABLE_FILE || DEFAULT_HEALTH_DISABLE_FILE,
    ...options,
  });
}

export const healthDailyIntakeDefaults = Object.freeze({
  endpoint: DEFAULT_ENDPOINT,
  tokenFile: DEFAULT_TOKEN_FILE,
  globalDisableFile: DEFAULT_GLOBAL_DISABLE_FILE,
  healthDisableFile: DEFAULT_HEALTH_DISABLE_FILE,
});
