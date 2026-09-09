const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { installAssistantAuditSummary } = require('../src/assistant-audit-summary');

const db = new Database(':memory:');
db.exec(fs.readFileSync(path.join(__dirname, '../schema.sql'), 'utf8'));
db.exec(`CREATE TABLE assistant_conversation_turns (
  turn_id TEXT PRIMARY KEY, conversation_key_hash TEXT, sequence_no INTEGER, status TEXT,
  created_at TEXT, updated_at TEXT, status_timestamps_json TEXT, replied_at TEXT, completed_at TEXT)`);
let handler, time = '2026-09-05T10:00:00.000Z';
const app = { get(route, fn) { assert.equal(route, '/v1/execution/audit-summary'); handler = fn; } };
const installed = installAssistantAuditSummary({ app, db, now: () => time });
const query = { windowStart: '2026-09-05T10:00:01.000Z', windowEnd: '2026-09-05T10:00:59.000Z' };
function read(overrides = {}, scopes = ['execution:audit:summary']) {
  let status = 200, body;
  handler({ query: { ...query, ...overrides }, executionIdentity: { scopes: new Set(scopes) } },
    { status(value) { status = value; return this; }, json(value) { body = value; return value; } });
  return { status, body };
}
try {
  assert.equal(read().body.insufficientEvidence, true);
  assert.equal(read().body.businessStateUnchanged, null);
  assert.equal(read({}, []).status, 403);
  assert.equal(read({ windowStart: 'invalid' }).status, 400);
  db.prepare(`INSERT INTO assistant_conversation_turns VALUES (?,?,?,?,?,?,?,?,?)`).run(
    'private-turn', 'a'.repeat(64), 2, 'completed', '2026-09-05T10:00:05.000Z',
    '2026-09-05T10:00:30.000Z', '{}', '2026-09-05T10:00:29.000Z', '2026-09-05T10:00:30.000Z');
  time = '2026-09-05T10:01:00.000Z'; installed.capture();
  const stable = read().body;
  assert.equal(stable.businessStateUnchanged, true);
  assert.equal(stable.turns[0].sequence, 2);
  assert.equal(stable.turns[0].statusTimestamps.result_ready, null);
  assert.equal(stable.turns[0].transitionEvidenceComplete, false);
  assert.ok(!JSON.stringify(stable).includes('private-turn'));
  db.prepare('INSERT INTO tasks(id,content,updated_at,raw_json) VALUES(?,?,?,?)').run('t', 'private-one', time, '{}');
  time = '2026-09-05T10:02:00.000Z'; installed.capture();
  db.prepare('UPDATE tasks SET content=? WHERE id=?').run('private-two', 't');
  time = '2026-09-05T10:03:00.000Z'; installed.capture();
  const changed = read({ windowStart: '2026-09-05T10:02:01.000Z', windowEnd: '2026-09-05T10:02:59.000Z' }).body;
  assert.equal(changed.taskIdSetHashBefore, changed.taskIdSetHashAfter);
  assert.equal(changed.taskCountBefore, changed.taskCountAfter);
  assert.equal(changed.businessStateUnchanged, false);
  assert.notEqual(changed.taskStateHashBefore, changed.taskStateHashAfter);
  assert.ok(!JSON.stringify(changed).includes('private-two'));
  assert.equal(read({ windowStart: '2026-09-05T10:10:00.000Z', windowEnd: '2026-09-05T10:11:00.000Z' }).body.insufficientEvidence, true);
  // Old snapshot rows do not become full-state evidence merely because they exist.
  db.prepare('UPDATE audit_projection_snapshots SET task_state_hash=NULL WHERE captured_at=?').run('2026-09-05T10:00:00.000Z');
  assert.equal(read().body.businessStateUnchanged, null);
  assert.equal(read().body.insufficientEvidence, true);
  console.log('audit summary compatibility, missing evidence and same-ID mutation tests passed');
} finally { clearInterval(installed.timer); db.close(); }
