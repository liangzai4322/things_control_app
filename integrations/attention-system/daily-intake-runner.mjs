import fs from 'node:fs';
import path from 'node:path';
import { consumeAttentionDailyReviewIntakes } from '../../js/time-attention-daily-intake.js';

export const ATTENTION_RUNNER_DEFAULTS = Object.freeze({
  endpoint: 'https://liangzai666.com/taskbox-api',
  tokenFile: '/etc/taskbox-daily-intake/attention.token',
  disableFile: '/etc/taskbox-daily-intake.disabled',
  stateFile: '/var/lib/taskbox-attention-daily-intake/state.json',
  statuses: Object.freeze(['accepted', 'retrying']),
  limit: 100,
  maxBatches: 20,
  requestAttempts: 3,
});

const clean = (value) => String(value || '').trim();
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function readToken(tokenFile) {
  try { return clean(fs.readFileSync(tokenFile, 'utf8')); } catch { return ''; }
}

function safeState(value = {}) {
  return {
    schemaVersion: 1,
    lastRunAt: value.lastRunAt || null,
    lastSuccessAt: value.lastSuccessAt || null,
    lastReviewDate: value.lastReviewDate || null,
    consecutiveFailures: Math.max(0, Number(value.consecutiveFailures) || 0),
    nextRetryAt: value.nextRetryAt || null,
    lastErrorCode: value.lastErrorCode || null,
    lastProcessedCount: Math.max(0, Number(value.lastProcessedCount) || 0),
    lastIgnoredCount: Math.max(0, Number(value.lastIgnoredCount) || 0),
  };
}

function readState(stateFile) {
  try { return safeState(JSON.parse(fs.readFileSync(stateFile, 'utf8'))); } catch { return safeState(); }
}

function writeState(stateFile, state) {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true, mode: 0o700 });
  const temporary = `${stateFile}.tmp.${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(safeState(state), null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, stateFile);
}

function errorCode(error) {
  return clean(error?.code || error?.payload?.error) || (error?.status ? `http_${error.status}` : 'request_failed');
}

export function createAttentionIntakeRequest({ endpoint, token, fetchImpl = fetch, requestAttempts = 3, random = Math.random }) {
  const base = clean(endpoint).replace(/\/$/, '');
  return async (requestPath, options = {}) => {
    let lastError;
    for (let attempt = 0; attempt < requestAttempts; attempt += 1) {
      try {
        const response = await fetchImpl(`${base}/v1${requestPath}`, {
          ...options,
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(options.headers || {}) },
        });
        if (!response.ok) {
          const error = new Error(`http_${response.status}`);
          error.status = response.status;
          try { error.payload = await response.json(); } catch { error.payload = null; }
          if (response.status === 503 && error.payload?.error === 'daily_intake_api_disabled') {
            error.code = 'daily_intake_api_disabled';
            error.disabled = true;
          }
          if (response.status < 500 && response.status !== 429) throw error;
          lastError = error;
        } else {
          return response.status === 204 ? null : response.json();
        }
      } catch (error) {
        if (error?.disabled || (error?.status && error.status < 500 && error.status !== 429)) throw error;
        lastError = error;
      }
      if (attempt + 1 < requestAttempts) await wait(250 * (2 ** attempt) + Math.floor(random() * 150));
    }
    throw lastError || new Error('request_failed');
  };
}

export async function runAttentionIntakeCycle(options = {}) {
  const config = { ...ATTENTION_RUNNER_DEFAULTS, ...options };
  const now = options.now || (() => new Date());
  const previous = readState(config.stateFile);
  const runAt = now().toISOString();
  if (fs.existsSync(config.disableFile)) return { ok: true, disabled: true, processed: 0, ignored: 0, failures: 0 };
  const token = options.token || readToken(config.tokenFile);
  if (!token) throw Object.assign(new Error('attention_intake_token_missing'), { code: 'attention_intake_token_missing' });
  const request = options.request || createAttentionIntakeRequest({
    endpoint: config.endpoint,
    token,
    fetchImpl: config.fetchImpl,
    requestAttempts: config.requestAttempts,
    random: config.random,
  });
  let processed = 0;
  let ignored = 0;
  const failures = [];
  let lastReviewDate = previous.lastReviewDate;
  try {
    for (const status of config.statuses) {
      for (let batch = 0; batch < config.maxBatches; batch += 1) {
        const result = await consumeAttentionDailyReviewIntakes({ request, status, limit: config.limit });
        processed += result.processed.length;
        ignored += result.ignored.length;
        failures.push(...result.failures, ...result.rejected);
        const handled = [...result.processed, ...result.ignored];
        handled.forEach((item) => { if (item.result?.receipt?.reviewDate) lastReviewDate = item.result.receipt.reviewDate; });
        if (result.failures.length || result.rejected.length || result.processed.length + result.ignored.length < config.limit) break;
      }
    }
    const succeeded = failures.length === 0;
    writeState(config.stateFile, {
      ...previous,
      lastRunAt: runAt,
      lastSuccessAt: succeeded ? runAt : previous.lastSuccessAt,
      lastReviewDate,
      consecutiveFailures: succeeded ? 0 : previous.consecutiveFailures + 1,
      nextRetryAt: succeeded ? null : new Date(now().getTime() + 15 * 60 * 1000).toISOString(),
      lastErrorCode: succeeded ? null : failures[0]?.code || failures[0]?.errorCode || 'intake_processing_failed',
      lastProcessedCount: processed,
      lastIgnoredCount: ignored,
    });
    return { ok: succeeded, disabled: false, processed, ignored, failures: failures.length };
  } catch (error) {
    if (error?.disabled || errorCode(error) === 'daily_intake_api_disabled') {
      return { ok: true, disabled: true, processed, ignored, failures: 0 };
    }
    writeState(config.stateFile, {
      ...previous,
      lastRunAt: runAt,
      consecutiveFailures: previous.consecutiveFailures + 1,
      nextRetryAt: new Date(now().getTime() + 15 * 60 * 1000).toISOString(),
      lastErrorCode: errorCode(error),
      lastProcessedCount: processed,
      lastIgnoredCount: ignored,
    });
    throw error;
  }
}

export function attentionRunnerHealth(options = {}) {
  const config = { ...ATTENTION_RUNNER_DEFAULTS, ...options };
  return {
    enabled: !fs.existsSync(config.disableFile),
    tokenConfigured: Boolean(readToken(config.tokenFile)),
    contractVersion: '2026-09-03.1',
    scopes: ['intakes:read:attention', 'receipts:write:attention'],
    ...readState(config.stateFile),
  };
}
