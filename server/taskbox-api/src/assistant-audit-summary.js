const crypto = require('crypto');

// A projection of the real durable table, never a second conversation store.
function installAssistantAuditSummary({ app, db, now }) {
  db.exec(`CREATE TABLE IF NOT EXISTS audit_projection_snapshots (
    snapshot_id TEXT PRIMARY KEY, captured_at TEXT NOT NULL,
    task_count INTEGER NOT NULL, task_id_set_hash TEXT NOT NULL,
    execution_audit_count INTEGER NOT NULL, projection_revision TEXT NOT NULL
  ); CREATE INDEX IF NOT EXISTS idx_audit_projection_snapshots_captured
    ON audit_projection_snapshots(captured_at)`);
  const columns = new Set(db.prepare('PRAGMA table_info(audit_projection_snapshots)').all().map(c => c.name));
  for (const name of ['task_state_hash', 'hq_state_hash']) {
    if (!columns.has(name)) db.exec(`ALTER TABLE audit_projection_snapshots ADD COLUMN ${name} TEXT`);
  }
  const hash = value => crypto.createHash('sha256').update(value).digest('hex');
  const factTables = ['boxes', 'tasks', 'hq_daily_briefs', 'hq_decisions', 'hq_proposals',
    'hq_proposal_events', 'hq_review_rules', 'hq_proposal_replies', 'hq_proposal_reply_audit', 'hq_period_reviews'];
  const tableHash = table => hash(JSON.stringify(db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
  function capture() {
    return db.transaction(() => {
      const ids = db.prepare('SELECT id FROM tasks ORDER BY id').all().map(r => r.id);
      const hashes = Object.fromEntries(factTables.map(table => [table, tableHash(table)]));
      db.prepare(`INSERT INTO audit_projection_snapshots
        (snapshot_id,captured_at,task_count,task_id_set_hash,execution_audit_count,
         projection_revision,task_state_hash,hq_state_hash) VALUES (?,?,?,?,?,?,?,?)`)
        .run(crypto.randomUUID(), now(), ids.length, hash(ids.join('\n')),
          db.prepare('SELECT COUNT(*) AS n FROM execution_task_audit').get().n,
          'audit-summary-v2', hash(JSON.stringify([hashes.boxes, hashes.tasks])),
          hash(JSON.stringify(factTables.slice(2).map(table => hashes[table]))));
    })();
  }
  capture();
  const timer = setInterval(() => {
    try { capture(); } catch { console.error('assistant_audit_snapshot_failed'); }
  }, 60000);
  timer.unref();

  app.get('/v1/execution/audit-summary', (req, res) => {
    if (!req.executionIdentity?.scopes?.has('execution:audit:summary')) {
      return res.status(403).json({ error: 'execution_audit_summary_scope_denied' });
    }
    const start = Date.parse(req.query.windowStart);
    const end = Date.parse(req.query.windowEnd);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 86400000) {
      return res.status(400).json({ error: 'audit_window_invalid' });
    }
    if (req.query.projection && req.query.projection !== 'assistant-turns-v1') {
      return res.status(400).json({ error: 'audit_projection_unsupported' });
    }
    try {
      const from = new Date(start).toISOString(), to = new Date(end).toISOString();
      const before = db.prepare('SELECT * FROM audit_projection_snapshots WHERE captured_at<=? ORDER BY captured_at DESC LIMIT 1').get(from);
      const after = db.prepare('SELECT * FROM audit_projection_snapshots WHERE captured_at>=? ORDER BY captured_at ASC LIMIT 1').get(to);
      // Old/minutes-or-hours-away snapshots are not sufficient evidence for this window.
      const sufficient = Boolean(before?.task_state_hash && before?.hq_state_hash && after?.task_state_hash && after?.hq_state_hash
        && start - Date.parse(before.captured_at) <= 120000 && Date.parse(after.captured_at) - end <= 120000);
      const turns = db.prepare(`SELECT conversation_key_hash,sequence_no,status,created_at,
        status_timestamps_json,replied_at,completed_at FROM assistant_conversation_turns
        WHERE updated_at>=? AND created_at<=? ORDER BY conversation_key_hash,sequence_no`).all(from, to)
        .map(row => {
          const recorded = JSON.parse(row.status_timestamps_json || '{}');
          const timestamps = { pending: row.created_at, leased: recorded.leased || null,
            result_ready: recorded.result_ready || null, replied: row.replied_at || null, completed: row.completed_at || null };
          // Never infer historical result/lease times from final updated_at.
          return { conversationKeyHash: row.conversation_key_hash, sequence: row.sequence_no,
            status: row.status, statusTimestamps: timestamps,
            transitionEvidenceComplete: Object.values(timestamps).every(Boolean) };
        });
      const project = column => [sufficient ? before[column] : null, sufficient ? after[column] : null];
      const [taskCountBefore, taskCountAfter] = project('task_count');
      const [taskIdSetHashBefore, taskIdSetHashAfter] = project('task_id_set_hash');
      const [executionAuditCountBefore, executionAuditCountAfter] = project('execution_audit_count');
      const [taskStateHashBefore, taskStateHashAfter] = project('task_state_hash');
      const [hqStateHashBefore, hqStateHashAfter] = project('hq_state_hash');
      return res.json({ projection: 'assistant-turns-v1', projectionRevision: 'audit-summary-v2',
        windowStart: from, windowEnd: to, generatedAt: now(),
        snapshotBeforeAt: before?.captured_at || null, snapshotAfterAt: after?.captured_at || null,
        taskCountBefore, taskCountAfter, taskIdSetHashBefore, taskIdSetHashAfter,
        executionAuditCountBefore, executionAuditCountAfter,
        auditDelta: sufficient ? executionAuditCountAfter - executionAuditCountBefore : null,
        taskStateHashBefore, taskStateHashAfter, hqStateHashBefore, hqStateHashAfter,
        businessStateUnchanged: sufficient ? taskStateHashBefore === taskStateHashAfter
          && hqStateHashBefore === hqStateHashAfter && executionAuditCountBefore === executionAuditCountAfter : null,
        insufficientEvidence: !sufficient, noData: !before && !after, turns });
    } catch { return res.status(500).json({ error: 'audit_summary_internal_error' }); }
  });
  return { capture, timer };
}

module.exports = { installAssistantAuditSummary };
