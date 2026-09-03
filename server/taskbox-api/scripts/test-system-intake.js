const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskbox-system-intake-'));
const dbPath = path.join(tempDir, 'taskbox.sqlite');
const port = 3700 + (process.pid % 500);
const token = 'system-intake-integration-token';
const senderToken = 'daily-intake-sender-token';
const hqToken = 'daily-intake-hq-token';
const consumerTokens = Object.fromEntries(['execution', 'health', 'attention', 'feedback', 'mission', 'governance']
  .map((systemId) => [systemId, `daily-intake-${systemId}-token`]));
const tokenFile = (name, value) => {
  const filePath = path.join(tempDir, name);
  fs.writeFileSync(filePath, `${value}\n`, { mode: 0o600 });
  return filePath;
};
const senderTokenFile = tokenFile('sender.token', senderToken);
const hqTokenFile = tokenFile('hq.token', hqToken);
const consumerTokenFiles = Object.fromEntries(Object.entries(consumerTokens)
  .map(([systemId, value]) => [systemId, tokenFile(`${systemId}.token`, value)]));
let serverError = '';

function request(route, method = 'GET', payload = null, { authenticated = true, authToken = token } = {}) {
  return new Promise((resolve, reject) => {
    const body = payload === null ? null : Buffer.from(JSON.stringify(payload));
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: route,
      method,
      headers: {
        ...(authenticated ? { Authorization: `Bearer ${authToken}` } : {}),
        'Content-Type': 'application/json',
        ...(body ? { 'Content-Length': body.length } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch { data = text; }
        resolve({ status: res.statusCode, data });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function waitForServer() {
  let response;
  let lastError;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      response = await request('/health');
      if (response.status === 200) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`server did not start: ${JSON.stringify(response)} ${lastError?.message || ''}`);
}

function executionPackage(overrides = {}) {
  return {
    schemaVersion: 1,
    contractVersion: '2026-09-03.1',
    systemId: 'execution',
    reviewDate: '2026-09-03',
    observationPeriod: { activity_start: '2026-09-02', activity_end: '2026-09-02' },
    sourceRef: '10-日省/2026-09-03.md',
    evidenceRefs: ['10-日省/2026-09-03.md#taskbox'],
    freshness: '2026-09-03T08:00:00.000Z',
    revision: 2,
    idempotencyKey: 'execution:2026-09-03:2:abc123',
    data: { currentActions: [{ taskId: 'task-ref-only', status: 'progressed' }], results: { completed: 1 } },
    ...overrides,
  };
}

function dailyPackage(systemId, overrides = {}) {
  return executionPackage({
    systemId,
    idempotencyKey: `${systemId}:2026-09-03:2:daily-intake`,
    sourceRef: `10-日省/2026-09-03-${systemId}.md`,
    evidenceRefs: [`10-日省/2026-09-03-${systemId}.md#receipt`],
    data: { summary: `${systemId} daily review`, indicators: { sample: true } },
    ...overrides,
  });
}

const child = spawn(process.execPath, [path.join(root, 'src', 'server.js')], {
  cwd: root,
  env: {
    ...process.env,
    TASKBOX_DB_PATH: dbPath,
    TASKBOX_API_PORT: String(port),
    TASKBOX_API_TOKEN: token,
    TASKBOX_ALLOWED_ORIGINS: 'http://127.0.0.1:4176',
    DAILY_INTAKE_API_ENABLED: '1',
    DAILY_INTAKE_SENDER_TOKEN_FILE: senderTokenFile,
    DAILY_INTAKE_HQ_TOKEN_FILE: hqTokenFile,
    ...Object.fromEntries(Object.entries(consumerTokenFiles)
      .map(([systemId, filePath]) => [`DAILY_INTAKE_${systemId.toUpperCase()}_TOKEN_FILE`, filePath])),
  },
  stdio: ['ignore', 'ignore', 'pipe'],
});
child.stderr.on('data', (chunk) => { serverError += chunk.toString('utf8'); });

(async () => {
  try {
    await waitForServer();
    const unauthenticated = await request('/v1/system-candidates', 'GET', null, { authenticated: false });
    if (unauthenticated.status !== 401) throw new Error('system intake list must require API authentication');
    const genericTokenRead = await request('/v1/system-candidates?intake=1&systemId=execution');
    if (genericTokenRead.status !== 401) throw new Error('generic TaskBox token must not access daily intake routes');
    const genericHealthRead = await request('/v1/health/observations');
    if (genericHealthRead.status !== 401) throw new Error('generic TaskBox token must not access scoped health facts');
    const genericMissionRead = await request('/v1/mission/state');
    if (genericMissionRead.status !== 401) throw new Error('generic TaskBox token must not access mission state');
    const genericReceiptRead = await request('/v1/hq/system-receipts');
    if (genericReceiptRead.status !== 401) throw new Error('generic TaskBox token must not access HQ receipt projection');
    const genericLegacyRead = await request('/v1/system-candidates?systemId=execution');
    if (genericLegacyRead.status !== 200) throw new Error('legacy system candidate route compatibility regressed');
    const crossSystemHealthRead = await request('/v1/health/observations', 'GET', null, { authToken: consumerTokens.execution });
    if (crossSystemHealthRead.status !== 403) throw new Error('non-health daily identity must not access health facts');
    const crossSystemMissionRead = await request('/v1/mission/state', 'GET', null, { authToken: consumerTokens.execution });
    if (crossSystemMissionRead.status !== 403) throw new Error('non-mission daily identity must not access mission state');
    const healthRead = await request('/v1/health/observations', 'GET', null, { authToken: consumerTokens.health });
    if (healthRead.status !== 200 || !Array.isArray(healthRead.data.observations)) throw new Error('health identity must read health facts');
    const healthWrite = await request('/v1/health/observations/batch', 'POST', { observations: [{
      observationId: 'daily-intake-health-scope-fixture', observationDate: '2026-09-03', effectiveDate: '2026-09-03',
      source: 'manual', authority: 'explicit_user', confidence: 1, sourceRef: 'scope-test', energy: 3,
    }] }, { authToken: consumerTokens.health });
    if (healthWrite.status !== 200 || healthWrite.data.created !== 1) throw new Error(`health identity must write health facts: ${JSON.stringify(healthWrite)}`);
    const senderHealthWrite = await request('/v1/health/observations/batch', 'POST', { observations: [] }, { authToken: senderToken });
    if (senderHealthWrite.status !== 403) throw new Error('daily sender must not write health facts');

    const partial = await request('/v1/system-candidates/batch', 'POST', {
      contractVersion: '2026-09-03.1',
      packages: [
        executionPackage(),
        dailyPackage('health'),
        dailyPackage('attention'),
        dailyPackage('feedback'),
        dailyPackage('mission'),
        dailyPackage('governance', { idempotencyKey: 'governance:2026-09-03:1:future', revision: 1, contractVersion: 'future-v2' }),
        dailyPackage('box-app', { idempotencyKey: 'box-app:2026-09-03:2:bad', sourceRef: '' }),
      ],
    }, { authToken: senderToken });
    if (partial.status !== 207 || partial.data.status !== 'partial' || partial.data.accepted.length !== 6
      || partial.data.rejected[0]?.error !== 'invalid_source_ref') {
      throw new Error(`batch partial-success contract mismatch: ${JSON.stringify(partial)}`);
    }
    const intake = partial.data.accepted.find((item) => item.intake.systemId === 'execution').intake;
    if (intake.data.currentActions[0].taskId !== 'task-ref-only' || partial.data.accepted[0].receipt.status !== 'received') {
      throw new Error('intake payload or initial receipt did not round trip');
    }

    const repeated = await request('/v1/system-candidates/batch', 'POST', { packages: [executionPackage()] }, { authToken: senderToken });
    if (repeated.status !== 201 || repeated.data.accepted[0]?.idempotent !== true || repeated.data.accepted[0]?.intake.id !== intake.id) {
      throw new Error('stable intake idempotency failed');
    }

    const conflict = await request('/v1/system-candidates/batch', 'POST', {
      packages: [executionPackage({ data: { currentActions: [{ taskId: 'different', status: 'progressed' }], results: { completed: 1 } } })],
    }, { authToken: senderToken });
    if (conflict.status !== 207 || conflict.data.rejected[0]?.error !== 'idempotency_key_conflict') {
      throw new Error('same idempotency key with changed content must conflict');
    }

    const revisionConflict = await request('/v1/system-candidates/batch', 'POST', {
      packages: [executionPackage({
        idempotencyKey: 'execution:2026-09-03:2:different-key',
        data: { currentActions: [{ taskId: 'different', status: 'progressed' }], results: { completed: 1 } },
      })],
    }, { authToken: senderToken });
    if (revisionConflict.status !== 207 || revisionConflict.data.rejected[0]?.error !== 'revision_conflict') {
      throw new Error('same system/date/revision with different content must conflict');
    }

    const inbox = await request('/v1/system-candidates?intake=1&systemId=execution&reviewDate=2026-09-03', 'GET', null, { authToken: consumerTokens.execution });
    if (inbox.status !== 200 || inbox.data.intakes.length !== 1 || inbox.data.intakes[0].id !== intake.id) {
      throw new Error('system inbox did not return the accepted package');
    }

    for (const systemId of ['health', 'attention', 'feedback', 'mission']) {
      const response = await request(`/v1/system-candidates?intake=1&systemId=${systemId}&reviewDate=2026-09-03`, 'GET', null, { authToken: consumerTokens[systemId] });
      if (response.status !== 200 || response.data.intakes.length !== 1 || response.data.intakes[0].systemId !== systemId) {
        throw new Error(`${systemId} intake was not readable through the daily intake view`);
      }
      const systemIntake = response.data.intakes[0];
      const systemReceipt = await request(`/v1/system-candidates/${systemIntake.id}/receipt`, 'POST', {
        status: 'processed',
        idempotencyKey: `${systemId}:2026-09-03:2:daily-intake:processed`,
        projection: { summary: `${systemId} receipt`, intakeRef: systemIntake.id },
      }, { authToken: consumerTokens[systemId] });
      if (systemReceipt.status !== 201 || systemReceipt.data.receipt.status !== 'processed') {
        throw new Error(`${systemId} receipt did not persist`);
      }
    }

    const futureInbox = await request('/v1/system-candidates?intake=1&systemId=governance&reviewDate=2026-09-03', 'GET', null, { authToken: consumerTokens.governance });
    if (futureInbox.status !== 200 || futureInbox.data.intakes[0]?.contractVersion !== 'future-v2') {
      throw new Error('unknown contract intake was not safely stored for consumer acknowledgement');
    }
    const futureReceipt = await request(`/v1/system-candidates/${futureInbox.data.intakes[0].id}/receipt`, 'POST', {
      status: 'ignored',
      idempotencyKey: 'governance:2026-09-03:1:future:ignored',
      projection: { reason: 'unsupported_contract_version' },
      errorCode: 'unsupported_contract_version',
    }, { authToken: consumerTokens.governance });
    if (futureReceipt.status !== 201 || futureReceipt.data.receipt.status !== 'ignored') {
      throw new Error('unknown contract intake could not receive an ignored receipt');
    }

    const retryReceipt = await request(`/v1/system-candidates/${intake.id}/receipt`, 'POST', {
      status: 'retrying',
      idempotencyKey: 'execution:2026-09-03:2:abc123:receipt:retry-1',
      projection: { summary: '等待执行系统重试', taskRefs: ['task-ref-only'] },
      errorCode: 'downstream_unavailable',
      retryAt: '2026-09-03T09:00:00.000Z',
    }, { authToken: consumerTokens.execution });
    if (retryReceipt.status !== 201 || retryReceipt.data.receipt.status !== 'retrying' || retryReceipt.data.receipt.attempts !== 1) {
      throw new Error('retry receipt state did not persist');
    }

    const receiptPayload = {
      status: 'processed',
      idempotencyKey: 'execution:2026-09-03:2:abc123:receipt:processed',
      projection: { summary: '已读取任务引用，无任务写入', taskRefs: ['task-ref-only'], sourceRunId: 'daily-2026-09-03' },
    };
    const receipt = await request(`/v1/system-candidates/${intake.id}/receipt`, 'POST', receiptPayload, { authToken: consumerTokens.execution });
    if (receipt.status !== 201 || receipt.data.receipt.status !== 'processed' || receipt.data.receipt.attempts !== 2) {
      throw new Error(`receipt write failed: ${JSON.stringify(receipt)}`);
    }
    const repeatedReceipt = await request(`/v1/system-candidates/${intake.id}/receipt`, 'POST', receiptPayload, { authToken: consumerTokens.execution });
    if (repeatedReceipt.status !== 200 || repeatedReceipt.data.idempotent !== true || repeatedReceipt.data.receipt.attempts !== 2) {
      throw new Error('receipt idempotency failed');
    }

    const hqProjection = await request('/v1/hq/system-receipts?reviewDate=2026-09-03&systemId=execution', 'GET', null, { authToken: hqToken });
    const hqReceipt = hqProjection.data.receipts?.[0];
    if (hqProjection.status !== 200 || !hqReceipt || hqReceipt.projection.summary !== '已读取任务引用，无任务写入'
      || Object.hasOwn(hqReceipt, 'data') || hqReceipt.sourceRef !== '10-日省/2026-09-03.md') {
      throw new Error('HQ receipt projection leaked candidate data or lost reference metadata');
    }

    const taskbox = await request('/v1/taskbox');
    if (taskbox.status !== 200 || taskbox.data.tasks.length !== 0) {
      throw new Error('system intake must not create or mutate TaskBox tasks');
    }

    console.log(JSON.stringify({ ok: true, intakeId: intake.id, receiptId: receipt.data.receipt.id }));
  } catch (error) {
    console.error(error.stack || error.message);
    if (serverError) console.error(serverError);
    process.exitCode = 1;
  } finally {
    child.kill('SIGTERM');
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
})();
