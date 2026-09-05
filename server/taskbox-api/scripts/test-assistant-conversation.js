const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'taskbox-assistant-conversation-'));
const dbPath = path.join(temp, 'taskbox.sqlite');
const producerTokenPath = path.join(temp, 'producer.token');
const runnerTokenPath = path.join(temp, 'runner.token');
const disablePath = path.join(temp, 'disabled');
const producerToken = 'conversation-producer-test-token';
const runnerToken = 'conversation-runner-test-token';
const genericToken = 'generic-taskbox-test-token';
const port = 3500 + (process.pid % 400);
fs.writeFileSync(producerTokenPath, `${producerToken}\n`, { mode: 0o600 });
fs.writeFileSync(runnerTokenPath, `${runnerToken}\n`, { mode: 0o600 });
let serverError = '';

function request(route, { method = 'GET', token = producerToken, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const encoded = body === null ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      hostname: '127.0.0.1', port, path: route, method,
      headers: {
        Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
        ...(encoded ? { 'Content-Length': encoded.length } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let value = null;
        try { value = text ? JSON.parse(text) : null; } catch { value = text; }
        resolve({ status: res.statusCode, body: value });
      });
    });
    req.on('error', reject);
    if (encoded) req.write(encoded);
    req.end();
  });
}

async function expectStatus(route, options, expected) {
  const response = await request(route, options);
  if (response.status !== expected) {
    throw new Error(`${options?.method || 'GET'} ${route}: expected ${expected}, got ${response.status} ${JSON.stringify(response.body)}`);
  }
  return response.body;
}

async function waitForServer() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await request('/health', { token: genericToken });
      if (response.status === 200) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`server failed to start: ${serverError}`);
}

const child = spawn(process.execPath, [path.join(root, 'src', 'server.js')], {
  cwd: root,
  env: {
    ...process.env,
    TASKBOX_DB_PATH: dbPath,
    TASKBOX_API_PORT: String(port),
    TASKBOX_API_TOKEN: genericToken,
    ASSISTANT_GATEWAY_API_ENABLED: '1',
    ASSISTANT_GATEWAY_API_DISABLE_FILE: disablePath,
    ASSISTANT_CONVERSATION_PRODUCER_TOKEN_FILE: producerTokenPath,
    ASSISTANT_CONVERSATION_RUNNER_TOKEN_FILE: runnerTokenPath,
  },
  stdio: ['ignore', 'ignore', 'pipe'],
});
child.stderr.on('data', (chunk) => { serverError += chunk.toString('utf8'); });

function turn(conversationKeyHash, dispatchKey, inboundMessageId, text) {
  return {
    conversationKeyHash,
    dispatchKey,
    inboundMessageId,
    textHash: crypto.createHash('sha256').update(text).digest('hex'),
    promptPayload: `v1.encrypted.${crypto.createHash('sha256').update(text).digest('hex')}`,
  };
}

(async () => {
  try {
    await waitForServer();
    const route = '/v1/assistant-gateway/conversation/turns';
    const c1 = '1'.repeat(64);
    const c2 = '2'.repeat(64);
    const firstSpec = turn(c1, 'dispatch-1', 'inbound-1', 'hello');

    await expectStatus(route, { method: 'POST', token: genericToken, body: firstSpec }, 401);
    await expectStatus(route, { method: 'POST', token: runnerToken, body: firstSpec }, 403);
    await expectStatus(`${route}/claim`, { method: 'POST', token: producerToken, body: { runnerId: 'runner-a' } }, 403);
    await expectStatus('/v1/tasks', { token: runnerToken }, 401);

    const first = await expectStatus(route, { method: 'POST', body: firstSpec }, 201);
    if (first.sequence !== 1 || first.status !== 'pending' || first.promptPayload !== undefined) throw new Error('first turn projection mismatch');
    const repeated = await expectStatus(route, { method: 'POST', body: firstSpec }, 200);
    if (repeated.turnId !== first.turnId) throw new Error('dispatch idempotency failed');
    await expectStatus(route, { method: 'POST', body: { ...firstSpec, textHash: 'f'.repeat(64) } }, 409);

    const second = await expectStatus(route, { method: 'POST', body: turn(c1, 'dispatch-2', 'inbound-2', 'follow up') }, 201);
    if (second.sequence !== 2) throw new Error('per-conversation sequence allocation failed');
    const other = await expectStatus(route, { method: 'POST', body: turn(c2, 'dispatch-3', 'inbound-3', 'parallel') }, 201);
    if (other.sequence !== 1) throw new Error('independent conversation sequence mismatch');

    const claims = await Promise.all([
      request(`${route}/claim`, { method: 'POST', token: runnerToken, body: { runnerId: 'runner-a' } }),
      request(`${route}/claim`, { method: 'POST', token: runnerToken, body: { runnerId: 'runner-b' } }),
    ]);
    if (claims.some((item) => item.status !== 200)) throw new Error('concurrent claim request failed');
    const claimedItems = claims.map((item) => item.body.item).filter(Boolean);
    if (claimedItems.length !== 2 || new Set(claimedItems.map((item) => item.turnId)).size !== 2) {
      throw new Error('atomic claim did not isolate eligible turns');
    }
    if (claimedItems.some((item) => item.turnId === second.turnId)) throw new Error('later same-conversation turn was claimed early');
    if (claimedItems.some((item) => !item.promptPayload || item.resultPayload)) throw new Error('runner claim projection leaked wrong payload');

    const claimedFirst = claimedItems.find((item) => item.turnId === first.turnId);
    const claimedOther = claimedItems.find((item) => item.turnId === other.turnId);
    const resultHash = crypto.createHash('sha256').update('reply one').digest('hex');
    const resultBody = {
      runnerId: claimedFirst === claims[0].body.item ? 'runner-a' : 'runner-b',
      leaseToken: claimedFirst.leaseToken,
      resultPayload: 'v1.encrypted.reply-one', resultHash,
    };
    await expectStatus(`${route}/${first.turnId}/result`, { method: 'POST', token: runnerToken, body: { ...resultBody, runnerId: 'wrong-runner' } }, 409);
    const resulted = await expectStatus(`${route}/${first.turnId}/result`, { method: 'POST', token: runnerToken, body: resultBody }, 200);
    if (resulted.status !== 'result_ready' || resulted.resultPayload !== undefined) throw new Error('runner result projection mismatch');
    await expectStatus(`${route}/${first.turnId}/result`, { method: 'POST', token: runnerToken, body: resultBody }, 200);
    await expectStatus(`${route}/${first.turnId}/result`, {
      method: 'POST', token: runnerToken, body: { ...resultBody, resultHash: 'e'.repeat(64) },
    }, 409);
    const producerView = await expectStatus(`${route}/by-dispatch/dispatch-1`, {}, 200);
    if (producerView.resultPayload !== 'v1.encrypted.reply-one' || producerView.promptPayload !== undefined) throw new Error('producer payload projection mismatch');
    await expectStatus(`${route}/${first.turnId}/replied`, { method: 'POST', body: {} }, 200);
    await expectStatus(`${route}/${first.turnId}/completed`, { method: 'POST', body: {} }, 200);

    const nextClaim = await expectStatus(`${route}/claim`, { method: 'POST', token: runnerToken, body: { runnerId: 'runner-c' } }, 200);
    if (nextClaim.item?.turnId !== second.turnId) throw new Error('second turn did not become eligible after predecessor completion');

    const sqlite = new Database(dbPath);
    sqlite.prepare("UPDATE assistant_conversation_turns SET lease_expires_at='2000-01-01T00:00:00.000Z' WHERE turn_id=?").run(second.turnId);
    const reclaimed = await expectStatus(`${route}/claim`, { method: 'POST', token: runnerToken, body: { runnerId: 'runner-d' } }, 200);
    if (reclaimed.item?.turnId !== second.turnId || reclaimed.item.leaseToken === nextClaim.item.leaseToken) throw new Error('expired lease was not fenced and reclaimed');
    await expectStatus(`${route}/${second.turnId}/result`, {
      method: 'POST', token: runnerToken, body: {
        runnerId: 'runner-c', leaseToken: nextClaim.item.leaseToken,
        resultPayload: 'v1.old', resultHash: 'a'.repeat(64),
      },
    }, 409);
    const taskCount = sqlite.prepare('SELECT COUNT(*) AS count FROM tasks').get().count;
    if (taskCount !== 0) throw new Error(`ordinary conversation mutated TaskBox tasks: ${taskCount}`);
    sqlite.close();

    const otherOwner = claimedOther === claims[0].body.item ? 'runner-a' : 'runner-b';
    await expectStatus(`${route}/${other.turnId}/fail`, {
      method: 'POST', token: runnerToken,
      body: { runnerId: `${otherOwner}-wrong`, leaseToken: claimedOther.leaseToken, errorCode: 'test' },
    }, 409);
    await expectStatus(`${route}/${other.turnId}/fail`, {
      method: 'POST', token: runnerToken,
      body: { runnerId: otherOwner, leaseToken: claimedOther.leaseToken, errorCode: 'test' },
    }, 200);

    console.log('assistant conversation contract tests passed');
  } finally {
    child.kill('SIGTERM');
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error.stack || error);
  console.error(serverError);
  process.exitCode = 1;
});
