const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const root = path.resolve(__dirname, '..');
const dbPath = process.env.TASKBOX_DB_PATH || path.join(root, 'data', 'taskbox.sqlite');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
const schema = fs.readFileSync(path.join(root, 'schema.sql'), 'utf8');
db.exec(schema);
const boxColumns = new Set(db.prepare("PRAGMA table_info('boxes')").all().map((column) => column.name));
[
  ['box_type', "TEXT DEFAULT 'task'"],
  ['type_config_json', 'TEXT'],
].forEach(([name, definition]) => {
  if (!boxColumns.has(name)) db.exec(`ALTER TABLE boxes ADD COLUMN ${name} ${definition}`);
});
const taskColumns = new Set(db.prepare("PRAGMA table_info('tasks')").all().map((column) => column.name));
[
  ['scheduled_at', 'TEXT'],
  ['is_recurring_template', 'INTEGER DEFAULT 0'],
  ['recurrence_template_id', 'TEXT'],
  ['recurrence_key', 'TEXT'],
  ['recurrence_json', 'TEXT'],
  ['next_run_at', 'TEXT'],
  ['occurrence_status', 'TEXT'],
  ['mainline_id', 'TEXT'],
  ['milestone_id', 'TEXT'],
  ['device_context', "TEXT DEFAULT 'universal'"],
  ['visible_after', 'TEXT'],
  ['deferred_at', 'TEXT'],
  ['defer_note', 'TEXT'],
  ['progress_logs_json', 'TEXT'],
].forEach(([name, definition]) => {
  if (!taskColumns.has(name)) db.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${definition}`);
});
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_recurrence_key ON tasks(recurrence_key) WHERE recurrence_key IS NOT NULL');
db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_recurrence_template_id ON tasks(recurrence_template_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_mainline_id ON tasks(mainline_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_milestone_id ON tasks(milestone_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_visible_after ON tasks(visible_after)');
db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_device_context ON tasks(device_context)');
db.close();

console.log(JSON.stringify({ ok: true, dbPath }));
