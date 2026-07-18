const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const dbPath = path.join(os.tmpdir(), `taskbox-schema-${process.pid}-${Date.now()}.sqlite`);

try {
  const legacy = new Database(dbPath);
  legacy.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, box_id TEXT, content TEXT NOT NULL, is_completed INTEGER DEFAULT 0,
      sort_order INTEGER DEFAULT 0, priority INTEGER DEFAULT 2, weight REAL DEFAULT 1,
      points_value REAL, progress REAL DEFAULT 0, is_recurring_template INTEGER DEFAULT 0,
      recurrence_template_id TEXT, recurrence_key TEXT, recurrence_json TEXT, next_run_at TEXT,
      occurrence_status TEXT, mainline_id TEXT, milestone_id TEXT, scheduled_at TEXT, due_date TEXT,
      deleted INTEGER DEFAULT 0, deleted_at TEXT, note TEXT, sync_key TEXT, completed_at TEXT,
      created_at TEXT, updated_at TEXT NOT NULL, raw_json TEXT NOT NULL
    );
  `);
  legacy.close();

  execFileSync(process.execPath, [path.join(__dirname, 'init-db.js')], {
    env: { ...process.env, TASKBOX_DB_PATH: dbPath },
    stdio: 'pipe',
  });

  const db = new Database(dbPath);
  const columns = db.prepare('PRAGMA table_info(tasks)').all().map((item) => item.name);
  const indexes = db.prepare('PRAGMA index_list(tasks)').all().map((item) => item.name);
  ['device_context', 'execution_mode', 'visible_after', 'deferred_at', 'defer_note', 'progress_logs_json'].forEach((name) => {
    if (!columns.includes(name)) throw new Error(`missing column ${name}`);
  });
  ['idx_tasks_visible_after', 'idx_tasks_device_context', 'idx_tasks_execution_mode', 'idx_tasks_recurrence_key'].forEach((name) => {
    if (!indexes.includes(name)) throw new Error(`missing index ${name}`);
  });
  db.close();
  console.log('server schema migration tests passed');
} finally {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(`${dbPath}${suffix}`, { force: true }); } catch {}
  }
}
