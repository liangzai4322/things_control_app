import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DAILY_INTAKE_CONTRACT_VERSION = '2026-09-03.1';
export const DAILY_INTAKE_FAILURE_EVENT_KEY = 'daily-intake:execution-consumer-readiness-failed:2026-09-03';
const MAX_FRESHNESS_MS = 24 * 60 * 60 * 1000;
const LOCK_LEASE_MS = 15 * 60 * 1000;
const MAX_RECEIPT_ATTEMPTS = 5;
const RETRY_BASE_MS = 60 * 1000;

function text(value) { return String(value || '').trim(); }
function object(value) { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function validDate(value) { return /^\d{4}-\d{2}-\d{2}$/.test(text(value)); }
function expandHome(value) { const file = text(value); return file.startsWith('~/') ? path.join(os.homedir(), file.slice(2)) : file; }
function iso(now) { return now.toISOString(); }
function digest(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function parsePayload(raw) { try { return raw ? JSON.parse(raw) : {}; } catch { return { error: 'daily_intake_invalid_json_response' }; } }
function freshnessAt(freshness = {}) { return text(freshness.generatedAt || freshness.updatedAt || freshness.observedAt); }
function recordsFrom(payload) { return Array.isArray(payload?.intakes) ? payload.intakes : []; }
function safeErrorCode(error) { return text(error?.code) || 'daily_intake_unknown_failure'; }
function isTerminal(status) { return status === 'processed' || status === 'ignored'; }
function readPrivateToken(token, tokenFile) {
  if (text(token)) return text(token);
  try { return fs.readFileSync(expandHome(tokenFile), 'utf8').trim(); } catch { return ''; }
}

export class DailyIntakeError extends Error {
  constructor(code, { status = 0, payload = {}, cause } = {}) {
    super(code, cause ? { cause } : undefined);
    this.name = 'DailyIntakeError'; this.code = code; this.status = status; this.payload = payload;
  }
}

export function validateDailyIntake(intake, { now = new Date() } = {}) {
  const required = [
    Number(intake?.schemaVersion) === 1,
    text(intake?.contractVersion) === DAILY_INTAKE_CONTRACT_VERSION,
    text(intake?.systemId) === 'execution', Boolean(text(intake?.id)), validDate(intake?.reviewDate),
    object(intake?.observationPeriod), Boolean(text(intake?.sourceRef) || object(intake?.sourceRef)),
    Array.isArray(intake?.evidenceRefs), object(intake?.freshness), object(intake?.data),
    Number.isSafeInteger(Number(intake?.revision)) && Number(intake.revision) > 0, Boolean(text(intake?.idempotencyKey)),
  ];
  if (!required.every(Boolean)) throw new DailyIntakeError('daily_intake_contract_invalid');
  const timestamp = Date.parse(freshnessAt(intake.freshness));
  if (!Number.isFinite(timestamp) || text(intake.freshness.status) !== 'fresh' || now.getTime() - timestamp > MAX_FRESHNESS_MS) {
    throw new DailyIntakeError('daily_intake_stale');
  }
  if (now.getTime() < timestamp - 5 * 60 * 1000) throw new DailyIntakeError('daily_intake_freshness_invalid');
  return {
    intakeId: text(intake.id), revision: Number(intake.revision), sourceIdempotencyKey: text(intake.idempotencyKey),
    readOnlyCandidateCount: Array.isArray(intake.data.candidates) ? intake.data.candidates.length : 0,
    explicitDispatchCount: Array.isArray(intake.data.explicitDispatches) ? intake.data.explicitDispatches.length : 0,
  };
}

function makeReceipt({ intakeId, revision, sourceIdempotencyKey, status, projection, errorCode }) {
  return {
    status, idempotencyKey: `execution-receipt:${intakeId}:${revision || 'invalid'}:${sourceIdempotencyKey || 'invalid'}`, projection,
    ...(errorCode ? { errorCode } : {}),
  };
}

export class ReceiptOutbox {
  constructor({ stateDir, now = () => new Date(), maxAttempts = MAX_RECEIPT_ATTEMPTS } = {}) {
    this.stateDir = expandHome(stateDir); this.outboxDir = path.join(this.stateDir, 'receipt-outbox');
    this.now = now; this.maxAttempts = maxAttempts;
  }

  initialize() { fs.mkdirSync(this.outboxDir, { recursive: true, mode: 0o700 }); }
  key({ intakeId, revision }) { return digest(`${intakeId}:${revision || 'invalid'}`); }
  pathFor(item) { return path.join(this.outboxDir, `${this.key(item)}.json`); }
  writeAtomic(file, value) {
    const temp = `${file}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600 }); fs.renameSync(temp, file);
  }
  list() {
    this.initialize();
    return fs.readdirSync(this.outboxDir).filter((file) => file.endsWith('.json')).sort().flatMap((file) => {
      try { return [JSON.parse(fs.readFileSync(path.join(this.outboxDir, file), 'utf8'))]; } catch { return []; }
    });
  }
  enqueue({ intakeId, revision, receipt }) {
    this.initialize(); const key = this.key({ intakeId, revision }); const current = this.list().find((entry) => entry.key === key);
    const next = { schemaVersion: 1, key, intakeId, revision: revision || null, receipt, state: 'pending', attempts: 0, nextRetryAt: iso(this.now()), createdAt: iso(this.now()), updatedAt: iso(this.now()) };
    if (current) {
      if (JSON.stringify(current.receipt) !== JSON.stringify(receipt)) throw new DailyIntakeError('daily_intake_outbox_conflict');
      return { entry: current, created: false };
    }
    this.writeAtomic(this.pathFor(next), next); return { entry: next, created: true };
  }
  update(entry, changes) { const next = { ...entry, ...changes, updatedAt: iso(this.now()) }; this.writeAtomic(this.pathFor(next), next); return next; }
  remove(entry) { try { fs.unlinkSync(this.pathFor(entry)); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  due() { const now = this.now().getTime(); return this.list().filter((entry) => (entry.state === 'pending' || entry.state === 'retrying') && Date.parse(entry.nextRetryAt) <= now); }
  summary() { return this.list().reduce((result, entry) => ({ ...result, [entry.state]: (result[entry.state] || 0) + 1 }), {}); }
}

export class DailyIntakeConsumer {
  constructor({ endpoint, token, stateDir, fetchImpl = globalThis.fetch, now = () => new Date(), lockLeaseMs = LOCK_LEASE_MS } = {}) {
    this.endpoint = text(endpoint).replace(/\/+$/, ''); this.token = text(token); this.fetchImpl = fetchImpl; this.now = now; this.lockLeaseMs = lockLeaseMs;
    this.outbox = new ReceiptOutbox({ stateDir, now }); this.stateDir = this.outbox.stateDir; this.lockPath = path.join(this.stateDir, 'consumer.lock');
    if (!this.endpoint) throw new DailyIntakeError('daily_intake_endpoint_required');
    if (!this.token) throw new DailyIntakeError('daily_intake_token_required');
    if (typeof fetchImpl !== 'function') throw new DailyIntakeError('daily_intake_fetch_required');
  }

  acquireLock() {
    fs.mkdirSync(this.stateDir, { recursive: true, mode: 0o700 }); const lease = { id: crypto.randomUUID(), pid: process.pid, acquiredAt: iso(this.now()) };
    try { fs.writeFileSync(this.lockPath, `${JSON.stringify(lease)}\n`, { flag: 'wx', mode: 0o600 }); return lease; } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let current = {}; try { current = JSON.parse(fs.readFileSync(this.lockPath, 'utf8')); } catch {}
      const expired = !Number.isFinite(Date.parse(current.acquiredAt)) || this.now().getTime() - Date.parse(current.acquiredAt) > this.lockLeaseMs;
      if (!expired) throw new DailyIntakeError('daily_intake_consumer_locked');
      fs.unlinkSync(this.lockPath); return this.acquireLock();
    }
  }
  releaseLock(lease) { try { if (JSON.parse(fs.readFileSync(this.lockPath, 'utf8')).id === lease.id) fs.unlinkSync(this.lockPath); } catch {} }
  async request(pathname, { method = 'GET', body, idempotencyKey } = {}) {
    let response;
    try {
      response = await this.fetchImpl(`${this.endpoint}${pathname}`, { method, headers: {
        Accept: 'application/json', Authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(idempotencyKey ? { 'X-Idempotency-Key': idempotencyKey } : {}),
      }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    } catch (cause) { throw new DailyIntakeError('daily_intake_unreachable', { cause }); }
    const payload = parsePayload(await response.text());
    if (!response.ok) throw new DailyIntakeError(payload.error || 'daily_intake_request_failed', { status: response.status, payload });
    return payload;
  }
  async list({ reviewDate, status, limit = 20 } = {}) {
    const query = new URLSearchParams({ intake: '1', systemId: 'execution' });
    if (text(status)) query.set('status', text(status)); if (validDate(reviewDate)) query.set('reviewDate', reviewDate);
    if (Number.isSafeInteger(Number(limit)) && Number(limit) > 0) query.set('limit', String(limit));
    return recordsFrom(await this.request(`/v1/system-candidates?${query}`));
  }
  async postReceipt(intakeId, receipt) {
    return this.request(`/v1/system-candidates/${encodeURIComponent(intakeId)}/receipt`, { method: 'POST', body: receipt, idempotencyKey: receipt.idempotencyKey });
  }
  receiptFor(record) {
    try {
      const intake = validateDailyIntake(record, { now: this.now() });
      const projection = Array.from({ length: intake.readOnlyCandidateCount }, () => ({ taskId: null, outcome: 'candidate_read_only' }));
      if (intake.explicitDispatchCount) projection.push({ taskId: null, outcome: 'explicit_dispatch_read_only', needsUserAction: 'taskbox_write_requires_separate_authorized_path' });
      return { ...intake, receipt: makeReceipt({ ...intake, status: 'received', projection }) };
    } catch (error) {
      const intakeId = text(record?.id); if (!intakeId) throw error;
      return { intakeId, revision: null, receipt: makeReceipt({ intakeId, status: 'ignored', projection: [], errorCode: safeErrorCode(error) }) };
    }
  }
  queue(record) {
    if (isTerminal(text(record?.status))) return { skippedTerminal: 1 };
    const item = this.receiptFor(record); const queued = this.outbox.enqueue(item);
    return { queued: queued.created ? 1 : 0, duplicate: queued.created ? 0 : 1 };
  }
  retry(entry, error) {
    const code = safeErrorCode(error);
    if (error?.status === 503 && code === 'daily_intake_api_disabled') return this.outbox.update(entry, { state: 'paused', lastError: code });
    if (error?.status === 401 || error?.status === 403) return this.outbox.update(entry, { state: 'authBlocked', lastError: code, eventKey: DAILY_INTAKE_FAILURE_EVENT_KEY });
    if (error?.status === 409) return this.outbox.update(entry, { state: 'deadLetter', lastError: code, eventKey: DAILY_INTAKE_FAILURE_EVENT_KEY });
    const attempts = Number(entry.attempts || 0) + 1;
    if (attempts >= this.outbox.maxAttempts) return this.outbox.update(entry, { state: 'deadLetter', attempts, lastError: code, eventKey: DAILY_INTAKE_FAILURE_EVENT_KEY });
    const delay = Math.min(RETRY_BASE_MS * (2 ** (attempts - 1)), 60 * 60 * 1000);
    return this.outbox.update(entry, { state: 'retrying', attempts, lastError: code, nextRetryAt: new Date(this.now().getTime() + delay).toISOString() });
  }
  async drain(summary) {
    for (const entry of this.outbox.due()) {
      try { await this.postReceipt(entry.intakeId, entry.receipt); this.outbox.remove(entry); summary.receiptDelivered += 1; }
      catch (error) {
        const state = this.retry(entry, error).state;
        if (state === 'retrying') summary.retried += 1;
        if (state === 'authBlocked') summary.authBlocked += 1;
        if (state === 'deadLetter') summary.deadLetters += 1;
      }
    }
  }
  async run({ reviewDate, limit = 20 } = {}) {
    if (!validDate(reviewDate)) throw new DailyIntakeError('daily_intake_review_date_required');
    const lease = this.acquireLock(); const summary = { fetched: 0, queued: 0, duplicate: 0, skippedTerminal: 0, receiptDelivered: 0, retried: 0, authBlocked: 0, deadLetters: 0, eventKey: DAILY_INTAKE_FAILURE_EVENT_KEY };
    try {
      await this.drain(summary);
      let records;
      try {
        records = [...await this.list({ reviewDate, status: 'accepted', limit }), ...await this.list({ reviewDate, status: 'retrying', limit })];
      } catch (error) {
        if (error?.status === 503 && safeErrorCode(error) === 'daily_intake_api_disabled') return { ...summary, paused: true, reason: safeErrorCode(error), outbox: this.outbox.summary() };
        throw error;
      }
      const seen = new Set();
      for (const record of records) {
        if (seen.has(record.id)) continue; seen.add(record.id); summary.fetched += 1;
        const result = this.queue(record); for (const [key, value] of Object.entries(result)) summary[key] += value;
      }
      await this.drain(summary); return { ...summary, outbox: this.outbox.summary() };
    } finally { this.releaseLock(lease); }
  }
  async healthcheck() {
    const accepted = await this.list({ status: 'accepted', limit: 1 });
    const retrying = await this.list({ status: 'retrying', limit: 1 });
    const records = [...accepted, ...retrying]; for (const record of records) validateDailyIntake(record, { now: this.now() });
    const outbox = this.outbox.summary(); return { ok: !outbox.authBlocked && !outbox.deadLetter, intakeCount: records.length, outbox, eventKey: DAILY_INTAKE_FAILURE_EVENT_KEY };
  }
}

export function createDailyIntakeConsumerFromEnv(env = process.env, options = {}) {
  const tokenFile = env.DAILY_INTAKE_TOKEN_FILE
    || (env.CREDENTIALS_DIRECTORY ? path.join(env.CREDENTIALS_DIRECTORY, 'execution.token') : '/etc/taskbox-daily-intake/execution.token');
  return new DailyIntakeConsumer({
    endpoint: env.DAILY_INTAKE_ENDPOINT || 'https://liangzai666.com/taskbox-api', token: readPrivateToken('', tokenFile),
    stateDir: env.DAILY_INTAKE_STATE_DIR || path.join(os.homedir(), '.codex', 'state', 'execution-daily-intake'), ...options,
  });
}
