const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const root = path.resolve(__dirname, '..');
const stamp = `${process.pid}-${Date.now()}`;
const dbPath = path.join(os.tmpdir(), `taskbox-audit-summary-${stamp}.sqlite`);
const summaryTokenFile = path.join(os.tmpdir(), `taskbox-audit-summary-${stamp}.token`);
const disableFile = path.join(os.tmpdir(), `taskbox-audit-summary-${stamp}.disabled`);
const port = 4300 + (process.pid % 200);
const summaryToken = 'audit-summary-test-token';
const genericToken = 'generic-test-token';

function request(route, { token = summaryToken, expected = 200 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, path: route, method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        const data = raw ? JSON.parse(raw) : null;
        if (res.statusCode !== expected) return reject(new Error(`${route} -> ${res.statusCode}: ${raw}`));
        resolve(data);
      });
    });
    req.on('error', reject);
    req.end();
  });
}

const child = spawn(process.execPath, [path.join(root, 'src', 'server.js')], {
  cwd: root,
  env: {
    ...process.env,
    TASKBOX_DB_PATH: dbPath,
    TASKBOX_API_PORT: String(port),
    TASKBOX_API_TOKEN: genericToken,
    EXECUTION_SYSTEM_API_ENABLED: '1',
    EXECUTION_AUDIT_SUMMARY_TOKEN_FILE: summaryTokenFile,
    EXECUTION_AUDIT_SUMMARY_SCOPES: 'execution:audit:summary',
    EXECUTION_AUDIT_SUMMARY_DISABLE_FILE: disableFile,
  },
  stdio: ['ignore', 'ignore', 'pipe'],
});
let stderr = '';
child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });

(async () => {
  try {
    fs.writeFileSync(summaryTokenFile, `${summaryToken}\n`, { mode: 0o600 });
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try { await request('/v1/execution/audit-summary?windowStart=2026-09-05T04:00:00.000Z&windowEnd=2026-09-05T04:01:00.000Z'); break; }
      catch (error) { if (attempt === 49) throw error; await new Promise((resolve) => setTimeout(resolve, 50)); }
    }

    const db = new Database(dbPath);
    db.prepare(`INSERT INTO audit_projection_snapshots
      (snapshot_id, captured_at, task_count, task_id_set_hash, execution_audit_count, projection_revision)
      VALUES (?, ?, ?, ?, ?, ?)`).run('before', '2026-09-05T03:59:00.000Z', 625, 'hash-before', 10, 'r1');
    db.prepare(`INSERT INTO audit_projection_snapshots
      (snapshot_id, captured_at, task_count, task_id_set_hash, execution_audit_count, projection_revision)
      VALUES (?, ?, ?, ?, ?, ?)`).run('after', '2026-09-05T04:02:00.000Z', 625, 'hash-after', 10, 'r1');
    db.prepare(`INSERT INTO assistant_conversation_turns
      (turn_id, conversation_key_hash, sequence, status_timestamps_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(
      'turn-private-1', 'conversation-hash', 1,
      JSON.stringify({ pending: '2026-09-05T04:00:01.000Z', completed: '2026-09-05T04:00:30.000Z' }),
      '2026-09-05T04:00:01.000Z', '2026-09-05T04:00:30.000Z',
    );
    db.close();

    const summary = await request('/v1/execution/audit-summary?windowStart=2026-09-05T04:00:00.000Z&windowEnd=2026-09-05T04:01:00.000Z');
    if (summary.taskCountBefore !== 625 || summary.taskCountAfter !== 625
      || summary.auditDelta !== 0 || summary.turns[0].sequence !== 1
      || summary.turns[0].conversationKeyHash !== 'conversation-hash'
      || Object.hasOwn(summary.turns[0], 'turnId')) throw new Error(`summary mismatch: ${JSON.stringify(summary)}`);
    await request('/v1/execution/audit-summary?windowStart=2026-09-05T04:00:00.000Z&windowEnd=2026-09-05T04:01:00.000Z', { token: genericToken, expected: 401 });
    await request('/v1/execution/audit-summary?windowStart=2026-09-05T04:00:00.000Z&windowEnd=2026-09-05T04:01:00.000Z', { token: 'execution-write-token', expected: 401 });
    const insufficient = await request('/v1/execution/audit-summary?windowStart=2026-09-06T04:00:00.000Z&windowEnd=2026-09-06T04:01:00.000Z');
    if (!insufficient.insufficientEvidence || insufficient.taskCountBefore !== null
      || insufficient.taskCountAfter !== null || insufficient.auditDelta !== null) throw new Error('missing evidence was not explicit');
    console.log('audit summary tests passed');
  } catch (error) {
    console.error(error.message);
    if (stderr) console.error(stderr);
    process.exitCode = 1;
  } finally {
    child.kill('SIGTERM');
    for (const file of [dbPath, summaryTokenFile, disableFile]) { try { fs.rmSync(file, { force: true }); } catch {} }
  }
})();
