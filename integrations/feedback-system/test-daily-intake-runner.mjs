import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-intake-runner-'));
const tokenFile = path.join(root, 'feedback.token');
const disableFile = path.join(root, 'disabled');
const lockFile = path.join(root, 'runner.lock');
fs.writeFileSync(tokenFile, 'feedback-test-secret\n', { mode: 0o600 });

const now = new Date();
const reviewDate = now.toISOString().slice(0, 10);
const intake = (id, revision, status) => ({
  id, schemaVersion: 1, contractVersion: '2026-09-03.1', systemId: 'feedback', reviewDate,
  observationPeriod: { activity_start: reviewDate, activity_end: reviewDate },
  sourceRef: `fixture:${id}`, evidenceRefs: [`evidence:${id}`], freshness: now.toISOString(), revision,
  idempotencyKey: `feedback:${reviewDate}:${revision}:${id}`,
  data: {
    reviewDate,
    published: { value: 1, evidenceRefs: [`published:${id}`] },
    conversations: { value: 1, evidenceRefs: [`conversation:${id}`] },
    quotes: { value: 0 }, deals: { value: 0 }, feedback: { value: 0 },
  }, status, receipt: null,
});

const posts = [];
const server = http.createServer((req, res) => {
  assert.equal(req.headers.authorization, 'Bearer feedback-test-secret');
  const url = new URL(req.url, 'http://127.0.0.1');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'GET') {
    assert.equal(url.searchParams.get('intake'), '1');
    assert.equal(url.searchParams.get('systemId'), 'feedback');
    const status = url.searchParams.get('status');
    const rows = status === 'accepted' ? [intake('accepted-1', 1, status), intake('accepted-fails', 2, status)]
      : status === 'retrying' ? [intake('retrying-1', 3, status)] : [];
    res.end(JSON.stringify({ intakes: rows })); return;
  }
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    if (url.pathname.includes('accepted-fails')) { res.statusCode = 409; res.end('{"error":"idempotency_key_conflict"}'); return; }
    posts.push({ path: url.pathname, body: JSON.parse(raw) });
    res.statusCode = 201; res.end('{"receipt":{"status":"processed"}}');
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

const env = {
  ...process.env,
  FEEDBACK_DAILY_INTAKE_ENDPOINT: `http://127.0.0.1:${server.address().port}/v1`,
  CREDENTIALS_DIRECTORY: root,
  DAILY_INTAKE_DISABLE_FILE: disableFile,
  FEEDBACK_DAILY_INTAKE_LOCK_FILE: lockFile,
};
const runner = path.join(import.meta.dirname, 'daily-intake-runner.mjs');
const execute = (args = []) => new Promise((resolve) => {
  const child = spawn(process.execPath, [runner, ...args], { env });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('close', (status) => resolve({ status, stdout, stderr }));
});

const child = await execute();
await new Promise((resolve) => server.close(resolve));
assert.equal(child.status, 1, child.stderr);
const result = JSON.parse(child.stdout);
assert.deepEqual({ queueDepth: result.queueDepth, processed: result.processed, failed: result.failed }, { queueDepth: 3, processed: 2, failed: 1 });
assert.equal(posts.length, 2, 'one 409 is isolated and later intake still posts');
assert.ok(posts.every((item) => item.body.status === 'processed'));
assert.doesNotMatch(child.stdout, /feedback-test-secret|fixture:|published:/);

fs.writeFileSync(disableFile, 'disabled\n');
const disabled = await execute();
assert.equal(disabled.status, 0);
assert.deepEqual(JSON.parse(disabled.stdout), { ok: true, disabled: true, processed: 0, failed: 0 });

const source = fs.readFileSync(runner, 'utf8');
assert.match(source, /status=\$\{status\}/);
assert.match(source, /openSync\(lockFile, 'wx'/);
assert.match(source, /\[408, 425, 429, 500, 502, 503, 504\]/);
assert.doesNotMatch(source, /TASKBOX_API_TOKEN|EXECUTION_SYSTEM/);
fs.rmSync(root, { recursive: true, force: true });
console.log('feedback daily intake production runner tests passed');
