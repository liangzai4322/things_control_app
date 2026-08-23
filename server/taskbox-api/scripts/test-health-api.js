const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const dbPath = path.join(os.tmpdir(), `taskbox-health-api-${process.pid}-${Date.now()}.sqlite`);
const port = 3700 + (process.pid % 200);
const token = 'health-integration-test-token';
let serverError = '';

function request(route, method = 'GET', payload = null) {
  return new Promise((resolve, reject) => {
    const body = payload == null ? null : Buffer.from(JSON.stringify(payload));
    const req = http.request({ hostname: '127.0.0.1', port, path: route, method, headers: {
      Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(body ? { 'Content-Length': body.length } : {}),
    } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`${method} ${route} -> ${res.statusCode}: ${text}`));
        return resolve(text ? JSON.parse(text) : null);
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const child = spawn(process.execPath, [path.join(root, 'src', 'server.js')], {
  cwd: root,
  env: { ...process.env, TASKBOX_DB_PATH: dbPath, TASKBOX_API_PORT: String(port), TASKBOX_API_TOKEN: token },
  stdio: ['ignore', 'ignore', 'pipe'],
});
child.stderr.on('data', (chunk) => { serverError += chunk.toString('utf8'); });

async function waitForServer() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { return await request('/health'); } catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
  }
  throw new Error(`server did not start: ${serverError}`);
}

(async () => {
  try {
    await waitForServer();
    const observation = {
      observationId: 'daily-review-health:2026-08-23', reviewDate: '2026-08-23',
      observationDate: '2026-08-23', effectiveDate: '2026-08-24', source: 'daily_review',
      authority: 'explicit_user', confidence: 0.8, sleepHours: 7, energy: 4,
    };
    const first = await request('/v1/health/observations/batch', 'POST', { observations: [observation] });
    const second = await request('/v1/health/observations/batch', 'POST', { observations: [{ ...observation, energy: 3 }] });
    if (first.created !== 1 || second.updated !== 1) throw new Error('health observation upsert not idempotent');
    const list = await request('/v1/health/observations?limit=10');
    if (list.observations.length !== 1 || list.observations[0].energy !== 3 || list.observations[0].effectiveDate !== '2026-08-24') {
      throw new Error('health observation list mismatch');
    }
    let rejectedAiFact = false;
    try {
      await request('/v1/health/observations/batch', 'POST', { observations: [{ ...observation, observationId: 'ai-fact', authority: 'ai_summary' }] });
    } catch (error) {
      rejectedAiFact = /daily_review_authority_invalid/.test(error.message);
    }
    if (!rejectedAiFact) throw new Error('AI daily-review fact must be rejected');
    const snapshot = {
      snapshotId: 'health-snapshot-2026-08-24-test', date: '2026-08-24', publishedAt: '2026-08-23T12:00:00.000Z',
      healthState: { state: 'yellow', availableCapacity: 0.6, confidence: 0.8 },
      timeSystem: { constraints: ['降低计划负载'], privacy: 'capacity_and_constraints_only' },
      dailyReview: { privacy: 'minimum_health_snapshot' },
      boundaries: { createsTasks: false, writesCalendar: false, medicalDiagnosis: false },
    };
    const saved = await request('/v1/health/snapshots', 'POST', snapshot);
    const repeated = await request('/v1/health/snapshots', 'POST', snapshot);
    const latest = await request('/v1/health/snapshots/latest?date=2026-08-24');
    if (!saved.created || !repeated.updated || latest.snapshot?.snapshotId !== snapshot.snapshotId) {
      throw new Error('health snapshot publish mismatch');
    }
    console.log('health api integration tests passed');
  } finally {
    child.kill('SIGTERM');
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.rmSync(`${dbPath}${suffix}`, { force: true }); } catch {}
    }
  }
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
