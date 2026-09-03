import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  JsonFileStorage,
  MISSION_DAILY_INTAKE_RUNNER_KEY,
  acquireMissionIntakeLock,
  createMissionDailyIntakeRequest,
  missionDailyIntakeConfig,
  runMissionDailyIntake,
} from '../integrations/mission-system/daily-intake-runner.mjs';

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-intake-runner-'));
const files = (name) => ({
  storagePath: path.join(temporary, name, 'state.json'), lockPath: path.join(temporary, name, 'consumer.lock'),
  healthPath: path.join(temporary, name, 'health.json'), disabledPath: path.join(temporary, name, 'disabled'),
});
const now = () => new Date('2026-09-03T12:00:00.000Z');
const missionStore = { schemaVersion: 3, activeVersion: null, history: [], draft: {}, events: [], candidateInbox: [], reviewContext: {} };

try {
  const credentialDir = path.join(temporary, 'credentials'); fs.mkdirSync(credentialDir); fs.writeFileSync(path.join(credentialDir, 'mission.token'), 'credential-mission-token\n', { mode: 0o600 });
  assert.equal(missionDailyIntakeConfig({ CREDENTIALS_DIRECTORY: credentialDir }).token, 'credential-mission-token');
  const disabled = files('disabled'); fs.mkdirSync(path.dirname(disabled.disabledPath), { recursive: true }); fs.writeFileSync(disabled.disabledPath, 'disabled\n');
  let disabledCalls = 0;
  const disabledResult = await runMissionDailyIntake({ request: async () => { disabledCalls += 1; }, storage: new JsonFileStorage(disabled.storagePath), lockPath: disabled.lockPath, healthPath: disabled.healthPath, disabledFiles: [disabled.disabledPath], now });
  assert.equal(disabledResult.reason, 'disabled'); assert.equal(disabledCalls, 0); assert.equal(JSON.parse(fs.readFileSync(disabled.healthPath)).status, 'disabled');

  const locked = files('locked'); const release = acquireMissionIntakeLock(locked.lockPath, { now: now() });
  const lockedResult = await runMissionDailyIntake({ request: async () => { throw new Error('must not call'); }, storage: new JsonFileStorage(locked.storagePath), lockPath: locked.lockPath, healthPath: locked.healthPath, now });
  assert.equal(lockedResult.reason, 'lock_held'); release();

  const probe = files('probe'); const probeCalls = [];
  const probeResult = await runMissionDailyIntake({
    request: async (requestPath) => { probeCalls.push(requestPath); return requestPath === '/mission/state' ? { store: missionStore } : { intakes: [] }; },
    storage: new JsonFileStorage(probe.storagePath), lockPath: probe.lockPath, healthPath: probe.healthPath, now, probeOnly: true, requireEmpty: true,
  });
  assert.equal(probeResult.queueCount, 0); assert.deepEqual(probeCalls, ['/mission/state', '/system-candidates?systemId=mission&intake=1&limit=100']);
  assert.equal(JSON.parse(fs.readFileSync(probe.healthPath)).status, 'healthy');

  const notEmpty = files('not-empty');
  await assert.rejects(runMissionDailyIntake({
    request: async (requestPath) => requestPath === '/mission/state' ? { store: missionStore } : { intakes: [{ id: 'business-record', status: 'accepted' }] },
    storage: new JsonFileStorage(notEmpty.storagePath), lockPath: notEmpty.lockPath, healthPath: notEmpty.healthPath, now, probeOnly: true, requireEmpty: true,
  }), /mission_intake_enable_gate_not_empty/);
  assert.equal(JSON.parse(fs.readFileSync(notEmpty.healthPath)).status, 'failed');
  const failedMeta = JSON.parse(new JsonFileStorage(notEmpty.storagePath).getItem(MISSION_DAILY_INTAKE_RUNNER_KEY));
  assert.equal(failedMeta.consecutiveFailures, 1); assert.ok(failedMeta.nextAttemptAt);
  let backoffCalls = 0;
  const backoffResult = await runMissionDailyIntake({
    request: async () => { backoffCalls += 1; }, storage: new JsonFileStorage(notEmpty.storagePath),
    lockPath: notEmpty.lockPath, healthPath: notEmpty.healthPath, now,
  });
  assert.equal(backoffResult.reason, 'backoff'); assert.equal(backoffCalls, 0);

  const fetchCalls = [];
  const request = createMissionDailyIntakeRequest({ endpoint: 'https://example.test/taskbox-api/v1/', token: 'mission-secret', fetchImpl: async (url, options) => {
    fetchCalls.push({ url, options }); return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  }});
  await request('/mission/state');
  assert.equal(fetchCalls[0].url, 'https://example.test/taskbox-api/v1/mission/state');
  assert.equal(fetchCalls[0].options.headers.Authorization, 'Bearer mission-secret');
  assert.equal(JSON.stringify(fetchCalls[0]).includes('state.json'), false);

  console.log('mission daily intake runner tests passed');
} finally { fs.rmSync(temporary, { recursive: true, force: true }); }
