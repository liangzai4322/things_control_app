const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const dbPath = path.join(os.tmpdir(), `taskbox-hq-api-${process.pid}-${Date.now()}.sqlite`);
const port = 3200 + (process.pid % 500);
const token = 'hq-integration-test-token';
let serverError = '';

function request(route, method = 'GET', payload = null) {
  return new Promise((resolve, reject) => {
    const body = payload === null ? null : Buffer.from(JSON.stringify(payload));
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: route,
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(body ? { 'Content-Length': body.length } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`${method} ${route} -> ${res.statusCode}: ${text}`));
          return;
        }
        resolve(text ? JSON.parse(text) : null);
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function waitForServer() {
  let lastError;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      return await request('/health');
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw lastError;
}

const child = spawn(process.execPath, [path.join(root, 'src', 'server.js')], {
  cwd: root,
  env: {
    ...process.env,
    TASKBOX_DB_PATH: dbPath,
    TASKBOX_API_PORT: String(port),
    TASKBOX_API_TOKEN: token,
    TASKBOX_ALLOWED_ORIGINS: 'http://127.0.0.1:4176',
  },
  stdio: ['ignore', 'ignore', 'pipe'],
});
child.stderr.on('data', (chunk) => { serverError += chunk.toString('utf8'); });

(async () => {
  try {
    const health = await waitForServer();
    if (!health.ok) throw new Error('health check failed');
    const brief = await request('/v1/hq/daily-briefs/2026-07-30', 'POST', {
      stopDoing: ['停止无效切换'],
      continueDoing: ['先做唯一动作'],
      outcomes: { published: 1 },
      source: 'integration_test',
    });
    if (brief.reviewDate !== '2026-07-30' || brief.outcomes.published !== 1) {
      throw new Error('daily brief upsert mismatch');
    }
    await request('/v1/hq/decisions', 'POST', {
      id: 'integration-decision',
      title: '集成测试决策',
      status: 'open',
    });
    const snapshot = await request('/v1/hq/today?date=2026-07-30');
    if (!snapshot.decisions.some((item) => item.id === 'integration-decision')) {
      throw new Error('decision missing from HQ snapshot');
    }
    await request('/v1/hq/decisions/integration-decision', 'PATCH', { status: 'resolved' });
    const openDecisions = await request('/v1/hq/decisions?status=open');
    if (openDecisions.some((item) => item.id === 'integration-decision')) {
      throw new Error('resolved decision remained open');
    }
    await request('/v1/hq/decisions/integration-decision', 'DELETE');
    const evidence = await request('/v1/daily-snapshot?date=2026-07-30');
    if (evidence.reviewDate !== '2026-07-30') throw new Error('daily snapshot date mismatch');
    console.log('hq api integration tests passed');
  } catch (error) {
    console.error(error.stack || error.message);
    if (serverError) console.error(serverError);
    process.exitCode = 1;
  } finally {
    child.kill();
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.rmSync(`${dbPath}${suffix}`, { force: true }); } catch {}
    }
  }
})();
