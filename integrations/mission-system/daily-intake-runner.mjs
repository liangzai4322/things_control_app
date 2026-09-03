import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MISSION_DAILY_INTAKE_STORAGE_KEY, consumeMissionDailyIntakes } from '../../js/mission-daily-intake.js';
import { MISSION_STORAGE_KEY } from '../../js/mission-model.js';

export const MISSION_DAILY_INTAKE_RUNNER_KEY = 'taskbox_mission_daily_intake_runner_v1';

const clean = (value) => String(value || '').trim();
const expandHome = (value) => clean(value).startsWith('~/') ? path.join(os.homedir(), clean(value).slice(2)) : clean(value);
const readJson = (filePath, fallback = {}) => {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch { return fallback; }
};
const atomicJson = (filePath, value) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, filePath);
};

export class MissionDailyIntakeRunnerError extends Error {
  constructor(code, { status = 0, payload = null, cause = null } = {}) {
    super(code, cause ? { cause } : undefined); this.code = code; this.status = status; this.payload = payload;
  }
}

export class JsonFileStorage {
  constructor(filePath) { this.filePath = filePath; this.values = readJson(filePath, {}); }
  getItem(key) { return Object.hasOwn(this.values, key) ? this.values[key] : null; }
  setItem(key, value) { this.values[key] = String(value); atomicJson(this.filePath, this.values); }
  removeItem(key) { delete this.values[key]; atomicJson(this.filePath, this.values); }
}

export function readMissionServiceToken({ token = '', tokenFile = '' } = {}) {
  if (clean(token)) return clean(token);
  try { return fs.readFileSync(expandHome(tokenFile), 'utf8').trim(); }
  catch { return ''; }
}

export function createMissionDailyIntakeRequest({ endpoint, token, fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  const base = clean(endpoint).replace(/\/+$/, '');
  if (!base) throw new MissionDailyIntakeRunnerError('mission_intake_endpoint_required');
  if (!clean(token)) throw new MissionDailyIntakeRunnerError('mission_intake_token_required');
  if (typeof fetchImpl !== 'function') throw new MissionDailyIntakeRunnerError('mission_intake_fetch_required');
  return async (pathname, options = {}) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${base}${pathname}`, {
        method: options.method || 'GET', signal: controller.signal,
        headers: { Accept: 'application/json', Authorization: `Bearer ${token}`, ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
        ...(options.body ? { body: options.body } : {}),
      });
      let payload = null;
      try { payload = await response.json(); } catch { payload = null; }
      if (!response.ok) throw new MissionDailyIntakeRunnerError(payload?.error || `mission_intake_http_${response.status}`, { status: response.status, payload });
      return payload;
    } catch (cause) {
      if (cause instanceof MissionDailyIntakeRunnerError) throw cause;
      throw new MissionDailyIntakeRunnerError(controller.signal.aborted ? 'mission_intake_timeout' : 'mission_intake_unreachable', { cause });
    } finally { clearTimeout(timer); }
  };
}

export function acquireMissionIntakeLock(lockPath, { now = new Date(), staleAfterMs = 20 * 60 * 1000 } = {}) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  try {
    const handle = fs.openSync(lockPath, 'wx', 0o600);
    fs.writeFileSync(handle, `${JSON.stringify({ pid: process.pid, startedAt: new Date(now).toISOString() })}\n`);
    return () => { try { fs.closeSync(handle); } catch {} try { fs.unlinkSync(lockPath); } catch {} };
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const existing = readJson(lockPath, {}); const startedAt = Date.parse(existing.startedAt || '');
    if (Number.isFinite(startedAt) && new Date(now).getTime() - startedAt > staleAfterMs) {
      fs.unlinkSync(lockPath); return acquireMissionIntakeLock(lockPath, { now, staleAfterMs });
    }
    return null;
  }
}

function healthState({ status, now, result = {}, error = null }) {
  return {
    schemaVersion: 1, systemId: 'mission', status, checkedAt: new Date(now).toISOString(),
    processedCount: result.processed?.length || 0, decisionRequiredCount: result.decisionRequiredCount || 0,
    ...(error ? { errorCode: error.code || error.message || 'mission_intake_failed' } : {}),
  };
}

function readRunnerMeta(storage) {
  try { return JSON.parse(storage.getItem(MISSION_DAILY_INTAKE_RUNNER_KEY) || '{}'); }
  catch { return {}; }
}

function writeRunnerMeta(storage, value) { storage.setItem(MISSION_DAILY_INTAKE_RUNNER_KEY, JSON.stringify(value)); }

function nextRetryAt(now, failures) {
  const baseMs = Math.min(6 * 60 * 60 * 1000, 5 * 60 * 1000 * (2 ** Math.min(6, Math.max(0, failures - 1))));
  const jitterMs = (failures * 7919 % 120) * 1000;
  return new Date(new Date(now).getTime() + baseMs + jitterMs).toISOString();
}

export async function runMissionDailyIntake({
  request,
  storage,
  lockPath,
  healthPath,
  disabledFiles = [],
  now = () => new Date(),
  probeOnly = false,
  requireEmpty = false,
} = {}) {
  const current = now();
  if (disabledFiles.some((filePath) => filePath && fs.existsSync(filePath))) {
    const result = { ok: true, skipped: true, reason: 'disabled' }; atomicJson(healthPath, healthState({ status: 'disabled', now: current, result })); return result;
  }
  const before = readRunnerMeta(storage);
  if (!probeOnly && before.nextAttemptAt && new Date(before.nextAttemptAt) > new Date(current)) {
    return { ok: true, skipped: true, reason: 'backoff', nextAttemptAt: before.nextAttemptAt };
  }
  const release = acquireMissionIntakeLock(lockPath, { now: current });
  if (!release) return { ok: true, skipped: true, reason: 'lock_held' };
  try {
    const missionState = await request('/mission/state');
    if (missionState?.store) storage.setItem(MISSION_STORAGE_KEY, JSON.stringify(missionState.store));
    else storage.removeItem(MISSION_STORAGE_KEY);
    const inbox = await request('/system-candidates?systemId=mission&intake=1&limit=100');
    if (!Array.isArray(inbox?.intakes)) throw new MissionDailyIntakeRunnerError('mission_intake_inbox_invalid');
    const actionable = inbox.intakes.filter((item) => !['processed', 'ignored', 'failed'].includes(clean(item.receipt?.status || item.status)));
    if (requireEmpty && actionable.length) throw new MissionDailyIntakeRunnerError('mission_intake_enable_gate_not_empty');
    if (probeOnly) {
      const result = { ok: true, probeOnly: true, queueCount: actionable.length, activeVersionId: missionState?.store?.history?.find((item) => item.version === missionState.store.activeVersion)?.versionId || null };
      atomicJson(healthPath, healthState({ status: 'healthy', now: current, result })); return result;
    }
    const result = await consumeMissionDailyIntakes({ request, storage, now: current });
    writeRunnerMeta(storage, { consecutiveFailures: 0, nextAttemptAt: null, lastSucceededAt: new Date(current).toISOString() });
    atomicJson(healthPath, healthState({ status: 'healthy', now: current, result }));
    return { ok: true, ...result };
  } catch (error) {
    const consecutiveFailures = Math.max(0, Number(before.consecutiveFailures) || 0) + 1;
    writeRunnerMeta(storage, { ...before, consecutiveFailures, nextAttemptAt: nextRetryAt(current, consecutiveFailures), lastFailedAt: new Date(current).toISOString(), lastErrorCode: error.code || error.message || 'mission_intake_failed' });
    atomicJson(healthPath, healthState({ status: 'failed', now: current, error })); throw error;
  } finally { release(); }
}

export function missionDailyIntakeConfig(env = process.env) {
  const stateDir = clean(env.MISSION_DAILY_INTAKE_STATE_DIR) || '/var/lib/taskbox-mission-intake';
  return {
    endpoint: clean(env.DAILY_INTAKE_ENDPOINT) || 'https://liangzai666.com/taskbox-api/v1',
    token: readMissionServiceToken({ token: env.DAILY_INTAKE_MISSION_TOKEN, tokenFile: env.DAILY_INTAKE_MISSION_TOKEN_FILE || '/etc/taskbox-daily-intake/mission.token' }),
    storagePath: path.join(stateDir, 'state.json'), lockPath: path.join(stateDir, 'consumer.lock'), healthPath: path.join(stateDir, 'health.json'),
    disabledFiles: [clean(env.DAILY_INTAKE_DISABLE_FILE) || '/etc/taskbox-daily-intake.disabled', clean(env.MISSION_DAILY_INTAKE_DISABLE_FILE) || '/etc/taskbox-mission-intake.disabled'],
  };
}

export { MISSION_DAILY_INTAKE_STORAGE_KEY };
