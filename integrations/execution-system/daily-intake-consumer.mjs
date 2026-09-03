import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DAILY_INTAKE_CONTRACT_VERSION = '2026-09-03.1';
const MAX_FRESHNESS_MS = 24 * 60 * 60 * 1000;

function text(value) {
  return String(value || '').trim();
}

function object(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function expandHome(value) {
  const filePath = text(value);
  return filePath.startsWith('~/') ? path.join(os.homedir(), filePath.slice(2)) : filePath;
}

function readToken({ token, tokenFile } = {}) {
  if (text(token)) return text(token);
  try {
    return fs.readFileSync(expandHome(tokenFile), 'utf8').trim();
  } catch {
    return '';
  }
}

function parsePayload(raw) {
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return { error: 'daily_intake_invalid_json_response' };
  }
}

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(text(value));
}

function freshnessTimestamp(freshness = {}) {
  return text(freshness.generatedAt || freshness.updatedAt || freshness.observedAt);
}

function receivedPackages(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload.intakes)) return payload.intakes;
  if (Array.isArray(payload.items)) return payload.items;
  return [];
}

function packageBody(record) {
  return record;
}

export class DailyIntakeError extends Error {
  constructor(code, { status = 0, payload = {}, cause } = {}) {
    super(code, cause ? { cause } : undefined);
    this.name = 'DailyIntakeError';
    this.code = code;
    this.status = status;
    this.payload = payload;
  }
}

export function validateDailyIntake(record, { now = new Date() } = {}) {
  const intake = packageBody(record);
  const intakeId = text(intake?.id);
  const required = [
    Number(intake?.schemaVersion) === 1,
    text(intake?.contractVersion) === DAILY_INTAKE_CONTRACT_VERSION,
    text(intake?.systemId) === 'execution',
    Boolean(intakeId),
    validDate(intake?.reviewDate),
    object(intake?.observationPeriod),
    Boolean(text(intake?.sourceRef) || object(intake?.sourceRef)),
    Array.isArray(intake?.evidenceRefs),
    object(intake?.freshness),
    object(intake?.data),
    Number.isSafeInteger(Number(intake?.revision)) && Number(intake.revision) > 0,
    Boolean(text(intake?.idempotencyKey)),
  ];
  if (!required.every(Boolean)) throw new DailyIntakeError('daily_intake_contract_invalid');

  const freshnessAt = Date.parse(freshnessTimestamp(intake.freshness));
  if (!Number.isFinite(freshnessAt) || text(intake.freshness.status) !== 'fresh' || now.getTime() - freshnessAt > MAX_FRESHNESS_MS) {
    throw new DailyIntakeError('daily_intake_stale');
  }
  if (now.getTime() < freshnessAt - 5 * 60 * 1000) throw new DailyIntakeError('daily_intake_freshness_invalid');

  return {
    intakeId,
    revision: Number(intake.revision),
    idempotencyKey: text(intake.idempotencyKey),
    reviewDate: intake.reviewDate,
    readOnlyCandidateCount: Array.isArray(intake.data.candidates) ? intake.data.candidates.length : 0,
    explicitDispatchCount: Array.isArray(intake.data.explicitDispatches) ? intake.data.explicitDispatches.length : 0,
  };
}

function receipt({ intakeId, revision, idempotencyKey, status, projection, errorCode }) {
  return {
    idempotencyKey: `execution-receipt:${intakeId}:${revision || 'invalid'}:${idempotencyKey || 'invalid'}`,
    status,
    projection,
    ...(errorCode ? { errorCode } : {}),
  };
}

export class DailyIntakeConsumer {
  constructor({ endpoint, token, fetchImpl = globalThis.fetch, now = () => new Date() } = {}) {
    this.endpoint = text(endpoint).replace(/\/+$/, '');
    this.token = text(token);
    this.fetchImpl = fetchImpl;
    this.now = now;
    if (!this.endpoint) throw new DailyIntakeError('daily_intake_endpoint_required');
    if (!this.token) throw new DailyIntakeError('daily_intake_token_required');
    if (typeof fetchImpl !== 'function') throw new DailyIntakeError('daily_intake_fetch_required');
  }

  async request(pathname, { method = 'GET', body, idempotencyKey } = {}) {
    let response;
    try {
      response = await this.fetchImpl(`${this.endpoint}${pathname}`, {
        method,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${this.token}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(idempotencyKey ? { 'X-Idempotency-Key': idempotencyKey } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (cause) {
      throw new DailyIntakeError('daily_intake_unreachable', { cause });
    }
    const payload = parsePayload(await response.text());
    if (!response.ok) throw new DailyIntakeError(payload.error || 'daily_intake_request_failed', { status: response.status, payload });
    return payload;
  }

  async list({ reviewDate, status, limit } = {}) {
    const query = new URLSearchParams({ systemId: 'execution', intake: '1' });
    if (validDate(reviewDate)) query.set('reviewDate', reviewDate);
    if (text(status)) query.set('status', text(status));
    if (Number.isSafeInteger(Number(limit)) && Number(limit) > 0) query.set('limit', String(limit));
    const payload = await this.request(`/v1/system-candidates?${query}`);
    return receivedPackages(payload);
  }

  async postReceipt(intakeId, value) {
    return this.request(`/v1/system-candidates/${encodeURIComponent(intakeId)}/receipt`, {
      method: 'POST', body: value, idempotencyKey: value.idempotencyKey,
    });
  }

  async consume(record) {
    let intake;
    try {
      intake = validateDailyIntake(record, { now: this.now() });
    } catch (error) {
      const intakeId = text(record?.id || 'unknown');
      const value = receipt({ intakeId, status: 'ignored', projection: [], errorCode: error.code || 'daily_intake_contract_invalid' });
      await this.postReceipt(intakeId, value);
      return value;
    }

    const projection = Array.from({ length: intake.readOnlyCandidateCount }, () => ({ taskId: null, outcome: 'candidate_read_only' }));
    if (intake.explicitDispatchCount) {
      projection.push({ taskId: null, outcome: 'explicit_dispatch_read_only', needsUserAction: 'taskbox_write_requires_separate_authorized_path' });
    }
    const value = receipt({ ...intake, status: 'received', projection });
    await this.postReceipt(intake.intakeId, value);
    return value;
  }

  async consumeAvailable(filters = {}) {
    const records = await this.list(filters);
    return Promise.all(records.map((record) => this.consume(record)));
  }
}

export function createDailyIntakeConsumerFromEnv(env = process.env, options = {}) {
  const tokenFile = env.DAILY_INTAKE_TOKEN_FILE || env.TASKBOX_API_TOKEN_FILE || path.join(os.homedir(), '.codex', 'secrets', 'taskbox-api-token');
  return new DailyIntakeConsumer({
    endpoint: env.DAILY_INTAKE_ENDPOINT || env.TASKBOX_API_ENDPOINT || 'https://liangzai666.com/taskbox-api',
    token: readToken({ token: env.DAILY_INTAKE_TOKEN || env.TASKBOX_API_TOKEN, tokenFile }),
    ...options,
  });
}
