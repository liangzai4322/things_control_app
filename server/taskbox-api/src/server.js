const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const Database = require('better-sqlite3');

const root = path.resolve(__dirname, '..');
const dbPath = process.env.TASKBOX_DB_PATH || path.join(root, 'data', 'taskbox.sqlite');
const port = Number(process.env.TASKBOX_API_PORT || 3107);
const apiToken = String(process.env.TASKBOX_API_TOKEN || '').trim();
const allowedOrigins = String(process.env.TASKBOX_ALLOWED_ORIGINS || 'https://liangzai4322.github.io,http://localhost:8000,http://127.0.0.1:8000')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);

const app = express();
const db = new Database(dbPath);
db.pragma('foreign_keys = ON');
db.exec(fs.readFileSync(path.join(root, 'schema.sql'), 'utf8'));
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

const now = () => new Date().toISOString();
const parseJson = (value, fallback) => {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
};
const json = (value) => JSON.stringify(value ?? null);
const bool = (value) => (value ? 1 : 0);
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
const boxTypes = new Set(['task', 'pool', 'collection']);
const inferBoxType = (box = {}) => {
  if (boxTypes.has(box.boxType)) return box.boxType;
  if (['relax', 'reward', 'punish'].includes(box.color)) return 'pool';
  if (box.color === 'study') return 'collection';
  return 'task';
};

db.transaction(() => {
  const rows = db.prepare('SELECT id, color, raw_json FROM boxes').all();
  const update = db.prepare('UPDATE boxes SET box_type=? WHERE id=?');
  rows.forEach((row) => {
    const raw = parseJson(row.raw_json, {});
    update.run(inferBoxType({ ...raw, color: row.color }), row.id);
  });
})();

app.use(express.json({ limit: '2mb' }));
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Taskbox-Token');
  if (req.method === 'OPTIONS') return res.status(204).end();
  return next();
});
app.use((req, res, next) => {
  if (!apiToken) return next();
  const auth = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  const headerToken = String(req.headers['x-taskbox-token'] || '').trim();
  if (auth === apiToken || headerToken === apiToken) return next();
  return res.status(401).json({ error: 'unauthorized' });
});

function getMeta(key, fallback) {
  const row = db.prepare('SELECT value_json FROM app_meta WHERE key=?').get(key);
  return parseJson(row?.value_json, fallback);
}

function setMeta(key, value) {
  db.prepare(`
    INSERT INTO app_meta (key, value_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at
  `).run(key, json(value), now());
}

const DEFAULT_DAILY_QUOTE = '把任务放进盒子，把注意力还给当下。';

function normalizeDailyQuoteRecord(record = {}) {
  const updatedAt = record.updatedAt || record.dailyQuoteUpdatedAt || now();
  const current = String(record.current || record.text || record.dailyQuote || '').trim() || DEFAULT_DAILY_QUOTE;
  const history = [
    { text: current, updatedAt },
    ...(Array.isArray(record.history) ? record.history : []),
    ...(Array.isArray(record.dailyQuoteHistory) ? record.dailyQuoteHistory : []),
  ]
    .map((item) => ({
      text: String(item?.text || '').trim(),
      updatedAt: item?.updatedAt || updatedAt,
    }))
    .filter((item) => item.text)
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
    .slice(0, 365);

  return { current, updatedAt, history };
}

function getDailyQuote() {
  const stored = getMeta('daily_quote', null);
  if (stored) return normalizeDailyQuoteRecord(stored);
  const settings = getMeta('taskbox_settings', {});
  return normalizeDailyQuoteRecord({
    current: settings.dailyQuote || DEFAULT_DAILY_QUOTE,
    updatedAt: settings.dailyQuoteUpdatedAt || now(),
    history: settings.dailyQuoteHistory || [],
  });
}

function rowToBox(row) {
  return {
    ...parseJson(row.raw_json, {}),
    id: row.id,
    name: row.name,
    color: row.color,
    icon: row.icon,
    sortOrder: row.sort_order,
    isDefault: Boolean(row.is_default),
    description: row.description || '',
    boxType: row.box_type || 'task',
    typeConfig: parseJson(row.type_config_json, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToTask(row) {
  return {
    ...parseJson(row.raw_json, {}),
    id: row.id,
    boxId: row.box_id,
    content: row.content,
    isCompleted: Boolean(row.is_completed),
    sortOrder: row.sort_order,
    priority: row.priority,
    weight: row.weight,
    pointsValue: row.points_value,
    progress: row.progress,
    isRecurringTemplate: Boolean(row.is_recurring_template),
    recurrenceTemplateId: row.recurrence_template_id,
    recurrenceKey: row.recurrence_key,
    recurrence: parseJson(row.recurrence_json, null),
    nextRunAt: row.next_run_at,
    occurrenceStatus: row.occurrence_status,
    mainlineId: row.mainline_id,
    milestoneId: row.milestone_id,
    deviceContext: row.device_context || 'universal',
    visibleAfter: row.visible_after,
    deferredAt: row.deferred_at,
    deferNote: row.defer_note || '',
    progressLogs: parseJson(row.progress_logs_json, []),
    scheduledAt: row.scheduled_at,
    dueDate: row.due_date,
    deleted: Boolean(row.deleted),
    deletedAt: row.deleted_at,
    note: row.note || '',
    syncKey: row.sync_key,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToMainline(row) {
  return {
    ...parseJson(row.raw_json, {}),
    id: row.id,
    name: row.name,
    outcome: row.outcome || '',
    currentPhase: row.current_phase || '',
    color: row.color || '#e66a4e',
    icon: row.icon || '◆',
    status: row.status || 'active',
    isWeeklyFocus: Boolean(row.is_weekly_focus),
    targetDate: row.target_date,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToMilestone(row) {
  return {
    ...parseJson(row.raw_json, {}),
    id: row.id,
    mainlineId: row.mainline_id,
    title: row.title,
    status: row.status || 'open',
    targetDate: row.target_date,
    sortOrder: row.sort_order,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToReward(row) {
  return {
    ...parseJson(row.raw_json, {}),
    id: row.id,
    title: row.title,
    description: row.description || '',
    cost: row.cost,
    category: row.category || '',
    icon: row.icon || '',
    active: Boolean(row.active),
  };
}

function rowToTransaction(row) {
  return {
    ...parseJson(row.raw_json, {}),
    id: row.id,
    bucket: row.bucket,
    sourceType: row.source_type,
    sourceKey: row.source_key,
    title: row.title,
    note: row.note || '',
    delta: row.delta,
    createdAt: row.created_at,
    status: row.status,
    reversedAt: row.reversed_at,
  };
}

function rowToUsageLog(row) {
  return {
    ...parseJson(row.raw_json, {}),
    id: row.id,
    boxId: row.box_id,
    taskId: row.task_id,
    action: row.action,
    title: row.title || '',
    usedAt: row.used_at,
    snapshot: parseJson(row.snapshot_json, {}),
    createdAt: row.created_at,
  };
}

function mergeRaw(existingRaw, patch) {
  return { ...parseJson(existingRaw, {}), ...patch };
}

app.get('/health', (req, res) => {
  res.json({ ok: true, db: path.basename(dbPath), time: now() });
});

app.get('/v1/taskbox', (req, res) => {
  const boxes = db.prepare('SELECT * FROM boxes ORDER BY sort_order, name').all().map(rowToBox);
  const tasks = db.prepare('SELECT * FROM tasks ORDER BY sort_order, created_at').all().map(rowToTask);
  const mainlines = db.prepare('SELECT * FROM mainlines ORDER BY sort_order, created_at').all().map(rowToMainline);
  const milestones = db.prepare('SELECT * FROM milestones ORDER BY mainline_id, sort_order, created_at').all().map(rowToMilestone);
  const usageLogs = db.prepare('SELECT * FROM usage_logs ORDER BY used_at DESC LIMIT 2000').all().map(rowToUsageLog);
  const settings = getMeta('taskbox_settings', {});
  const dailyQuote = getDailyQuote();
  res.json({
    boxes,
    tasks,
    mainlines,
    milestones,
    usageLogs,
    settings: {
      ...settings,
      dailyQuote: dailyQuote.current,
      dailyQuoteUpdatedAt: dailyQuote.updatedAt,
      dailyQuoteHistory: dailyQuote.history,
    },
    meta: getMeta('taskbox_meta', { updatedAt: now() }),
  });
});

app.get('/v1/daily-quote', (req, res) => {
  res.json(getDailyQuote());
});

app.patch('/v1/daily-quote', (req, res) => {
  const current = getDailyQuote();
  const next = normalizeDailyQuoteRecord({
    ...req.body,
    history: [
      ...(Array.isArray(req.body.history) ? req.body.history : []),
      ...current.history,
    ],
  });
  setMeta('daily_quote', next);
  const settings = getMeta('taskbox_settings', {});
  setMeta('taskbox_settings', {
    ...settings,
    dailyQuote: next.current,
    dailyQuoteUpdatedAt: next.updatedAt,
    dailyQuoteHistory: next.history,
  });
  res.json(next);
});

app.post('/v1/boxes', (req, res) => {
  const box = { ...req.body, id: req.body.id || uid(), createdAt: req.body.createdAt || now(), updatedAt: now() };
  db.prepare(`
    INSERT INTO boxes (id, name, color, icon, sort_order, is_default, description, box_type, type_config_json, created_at, updated_at, raw_json)
    VALUES (@id, @name, @color, @icon, @sort_order, @is_default, @description, @box_type, @type_config_json, @created_at, @updated_at, @raw_json)
  `).run({
    id: box.id,
    name: box.name || '',
    color: box.color || null,
    icon: box.icon || null,
    sort_order: Number(box.sortOrder ?? 0),
    is_default: bool(box.isDefault),
    description: box.description || null,
    box_type: box.boxType || 'task',
    type_config_json: json(box.typeConfig || {}),
    created_at: box.createdAt,
    updated_at: box.updatedAt,
    raw_json: json(box),
  });
  res.status(201).json(box);
});

app.patch('/v1/boxes/:id', (req, res) => {
  const current = db.prepare('SELECT * FROM boxes WHERE id=?').get(req.params.id);
  if (!current) return res.status(404).json({ error: 'box_not_found' });
  const next = mergeRaw(current.raw_json, { ...req.body, id: req.params.id, updatedAt: now() });
  db.prepare(`
    UPDATE boxes SET name=@name, color=@color, icon=@icon, sort_order=@sort_order, is_default=@is_default,
      description=@description, box_type=@box_type, type_config_json=@type_config_json,
      updated_at=@updated_at, raw_json=@raw_json WHERE id=@id
  `).run({
    id: req.params.id,
    name: next.name || current.name,
    color: next.color || null,
    icon: next.icon || null,
    sort_order: Number(next.sortOrder ?? current.sort_order),
    is_default: bool(next.isDefault),
    description: next.description || null,
    box_type: next.boxType || current.box_type || 'task',
    type_config_json: json(next.typeConfig || parseJson(current.type_config_json, {})),
    updated_at: next.updatedAt,
    raw_json: json(next),
  });
  res.json(next);
});

app.delete('/v1/boxes/:id', (req, res) => {
  const box = db.prepare('SELECT * FROM boxes WHERE id=?').get(req.params.id);
  if (!box) return res.status(404).json({ error: 'box_not_found' });
  if (box.color === 'important' || box.color === 'misc') {
    return res.status(409).json({ error: 'box_fixed' });
  }
  const activeCount = db.prepare('SELECT COUNT(*) AS count FROM tasks WHERE box_id=? AND deleted=0').get(req.params.id).count;
  if (activeCount > 0) return res.status(409).json({ error: 'box_not_empty', count: activeCount });

  db.transaction(() => {
    db.prepare('DELETE FROM tasks WHERE box_id=?').run(req.params.id);
    db.prepare('DELETE FROM boxes WHERE id=?').run(req.params.id);
  })();
  return res.status(204).end();
});

function mainlineParams(mainline) {
  return {
    id: mainline.id,
    name: mainline.name || '',
    outcome: mainline.outcome || null,
    current_phase: mainline.currentPhase || null,
    color: mainline.color || '#e66a4e',
    icon: mainline.icon || '◆',
    status: mainline.status || 'active',
    is_weekly_focus: bool(mainline.isWeeklyFocus),
    target_date: mainline.targetDate || null,
    sort_order: Number(mainline.sortOrder ?? 0),
    created_at: mainline.createdAt || now(),
    updated_at: mainline.updatedAt || now(),
    raw_json: json(mainline),
  };
}

app.post('/v1/mainlines', (req, res) => {
  const mainline = { ...req.body, id: req.body.id || uid(), createdAt: req.body.createdAt || now(), updatedAt: now() };
  const existing = db.prepare('SELECT * FROM mainlines WHERE id=?').get(mainline.id);
  if (existing) return res.json(rowToMainline(existing));
  db.prepare(`
    INSERT INTO mainlines (id, name, outcome, current_phase, color, icon, status, is_weekly_focus, target_date, sort_order, created_at, updated_at, raw_json)
    VALUES (@id, @name, @outcome, @current_phase, @color, @icon, @status, @is_weekly_focus, @target_date, @sort_order, @created_at, @updated_at, @raw_json)
  `).run(mainlineParams(mainline));
  res.status(201).json(mainline);
});

app.patch('/v1/mainlines/:id', (req, res) => {
  const current = db.prepare('SELECT * FROM mainlines WHERE id=?').get(req.params.id);
  if (!current) return res.status(404).json({ error: 'mainline_not_found' });
  const next = mergeRaw(current.raw_json, { ...req.body, id: req.params.id, updatedAt: now() });
  db.prepare(`
    UPDATE mainlines SET name=@name, outcome=@outcome, current_phase=@current_phase, color=@color,
      icon=@icon, status=@status, is_weekly_focus=@is_weekly_focus, target_date=@target_date,
      sort_order=@sort_order, created_at=@created_at, updated_at=@updated_at, raw_json=@raw_json WHERE id=@id
  `).run(mainlineParams(next));
  res.json(next);
});

app.delete('/v1/mainlines/:id', (req, res) => {
  if (!db.prepare('SELECT 1 FROM mainlines WHERE id=?').get(req.params.id)) return res.status(404).json({ error: 'mainline_not_found' });
  db.transaction(() => {
    db.prepare('UPDATE tasks SET mainline_id=NULL, milestone_id=NULL WHERE mainline_id=?').run(req.params.id);
    db.prepare('DELETE FROM milestones WHERE mainline_id=?').run(req.params.id);
    db.prepare('DELETE FROM mainlines WHERE id=?').run(req.params.id);
  })();
  return res.status(204).end();
});

function milestoneParams(milestone) {
  return {
    id: milestone.id,
    mainline_id: milestone.mainlineId,
    title: milestone.title || '',
    status: milestone.status === 'completed' ? 'completed' : 'open',
    target_date: milestone.targetDate || null,
    sort_order: Number(milestone.sortOrder ?? 0),
    completed_at: milestone.status === 'completed' ? (milestone.completedAt || now()) : null,
    created_at: milestone.createdAt || now(),
    updated_at: milestone.updatedAt || now(),
    raw_json: json(milestone),
  };
}

app.post('/v1/milestones', (req, res) => {
  const milestone = { ...req.body, id: req.body.id || uid(), createdAt: req.body.createdAt || now(), updatedAt: now() };
  if (!db.prepare('SELECT 1 FROM mainlines WHERE id=?').get(milestone.mainlineId)) return res.status(409).json({ error: 'mainline_not_found' });
  const existing = db.prepare('SELECT * FROM milestones WHERE id=?').get(milestone.id);
  if (existing) return res.json(rowToMilestone(existing));
  db.prepare(`
    INSERT INTO milestones (id, mainline_id, title, status, target_date, sort_order, completed_at, created_at, updated_at, raw_json)
    VALUES (@id, @mainline_id, @title, @status, @target_date, @sort_order, @completed_at, @created_at, @updated_at, @raw_json)
  `).run(milestoneParams(milestone));
  res.status(201).json(milestone);
});

app.patch('/v1/milestones/:id', (req, res) => {
  const current = db.prepare('SELECT * FROM milestones WHERE id=?').get(req.params.id);
  if (!current) return res.status(404).json({ error: 'milestone_not_found' });
  const next = mergeRaw(current.raw_json, { ...req.body, id: req.params.id, updatedAt: now() });
  db.prepare(`
    UPDATE milestones SET mainline_id=@mainline_id, title=@title, status=@status, target_date=@target_date,
      sort_order=@sort_order, completed_at=@completed_at, created_at=@created_at, updated_at=@updated_at,
      raw_json=@raw_json WHERE id=@id
  `).run(milestoneParams(next));
  res.json(next);
});

app.delete('/v1/milestones/:id', (req, res) => {
  if (!db.prepare('SELECT 1 FROM milestones WHERE id=?').get(req.params.id)) return res.status(404).json({ error: 'milestone_not_found' });
  db.transaction(() => {
    db.prepare('UPDATE tasks SET milestone_id=NULL WHERE milestone_id=?').run(req.params.id);
    db.prepare('DELETE FROM milestones WHERE id=?').run(req.params.id);
  })();
  return res.status(204).end();
});

app.post('/v1/tasks', (req, res) => {
  const task = { ...req.body, id: req.body.id || uid(), createdAt: req.body.createdAt || now(), updatedAt: now() };
  const existing = task.recurrenceKey
    ? db.prepare('SELECT * FROM tasks WHERE id=? OR recurrence_key=?').get(task.id, task.recurrenceKey)
    : db.prepare('SELECT * FROM tasks WHERE id=?').get(task.id);
  if (existing) return res.json(rowToTask(existing));
  db.prepare(`
    INSERT INTO tasks (id, box_id, content, is_completed, sort_order, priority, weight, points_value, progress,
      is_recurring_template, recurrence_template_id, recurrence_key, recurrence_json, next_run_at, occurrence_status,
      mainline_id, milestone_id, device_context, visible_after, deferred_at, defer_note, progress_logs_json,
      scheduled_at, due_date, deleted, deleted_at, note, sync_key, completed_at, created_at, updated_at, raw_json)
    VALUES (@id, @box_id, @content, @is_completed, @sort_order, @priority, @weight, @points_value, @progress,
      @is_recurring_template, @recurrence_template_id, @recurrence_key, @recurrence_json, @next_run_at, @occurrence_status,
      @mainline_id, @milestone_id, @device_context, @visible_after, @deferred_at, @defer_note, @progress_logs_json,
      @scheduled_at, @due_date, @deleted, @deleted_at, @note, @sync_key, @completed_at, @created_at, @updated_at, @raw_json)
  `).run(taskParams(task));
  res.status(201).json(task);
});

app.patch('/v1/tasks/:id', (req, res) => {
  const current = db.prepare('SELECT * FROM tasks WHERE id=?').get(req.params.id);
  if (!current) return res.status(404).json({ error: 'task_not_found' });
  const next = mergeRaw(current.raw_json, { ...req.body, id: req.params.id, updatedAt: now() });
  db.prepare(`
    UPDATE tasks SET box_id=@box_id, content=@content, is_completed=@is_completed, sort_order=@sort_order,
      priority=@priority, weight=@weight, points_value=@points_value, progress=@progress,
      is_recurring_template=@is_recurring_template, recurrence_template_id=@recurrence_template_id,
      recurrence_key=@recurrence_key, recurrence_json=@recurrence_json, next_run_at=@next_run_at,
      occurrence_status=@occurrence_status, mainline_id=@mainline_id, milestone_id=@milestone_id,
      device_context=@device_context, visible_after=@visible_after, deferred_at=@deferred_at,
      defer_note=@defer_note, progress_logs_json=@progress_logs_json,
      scheduled_at=@scheduled_at, due_date=@due_date,
      deleted=@deleted, deleted_at=@deleted_at, note=@note, sync_key=@sync_key, completed_at=@completed_at,
      created_at=@created_at, updated_at=@updated_at, raw_json=@raw_json WHERE id=@id
  `).run(taskParams(next));
  res.json(next);
});

app.delete('/v1/tasks/:id', (req, res) => {
  const current = db.prepare('SELECT * FROM tasks WHERE id=?').get(req.params.id);
  if (!current) return res.status(404).json({ error: 'task_not_found' });
  const next = mergeRaw(current.raw_json, { deleted: true, deletedAt: now(), updatedAt: now() });
  db.prepare('UPDATE tasks SET deleted=1, deleted_at=?, updated_at=?, raw_json=? WHERE id=?')
    .run(next.deletedAt, next.updatedAt, json(next), req.params.id);
  res.json(next);
});

function taskParams(task) {
  return {
    id: task.id,
    box_id: task.boxId || task.box_id || null,
    content: task.content || '',
    is_completed: bool(task.isCompleted),
    sort_order: Number(task.sortOrder ?? 0),
    priority: Number(task.priority ?? 2),
    weight: Number(task.weight ?? 1),
    points_value: task.pointsValue === null || task.pointsValue === undefined ? null : Number(task.pointsValue),
    progress: Number(task.progress ?? 0),
    is_recurring_template: bool(task.isRecurringTemplate),
    recurrence_template_id: task.recurrenceTemplateId || null,
    recurrence_key: task.recurrenceKey || null,
    recurrence_json: task.recurrence ? json(task.recurrence) : null,
    next_run_at: task.nextRunAt || null,
    occurrence_status: task.occurrenceStatus || null,
    mainline_id: task.mainlineId || null,
    milestone_id: task.milestoneId || null,
    device_context: ['desktop', 'mobile', 'universal'].includes(task.deviceContext) ? task.deviceContext : 'universal',
    visible_after: task.visibleAfter || null,
    deferred_at: task.deferredAt || null,
    defer_note: task.deferNote || null,
    progress_logs_json: json(Array.isArray(task.progressLogs) ? task.progressLogs : []),
    scheduled_at: task.scheduledAt || null,
    due_date: task.dueDate || null,
    deleted: bool(task.deleted),
    deleted_at: task.deletedAt || null,
    note: task.note || null,
    sync_key: task.syncKey || null,
    completed_at: task.completedAt || null,
    created_at: task.createdAt || now(),
    updated_at: task.updatedAt || now(),
    raw_json: json(task),
  };
}

app.get('/v1/usage-logs', (req, res) => {
  const clauses = [];
  const params = [];
  if (req.query.boxId) {
    clauses.push('box_id=?');
    params.push(req.query.boxId);
  }
  if (req.query.taskId) {
    clauses.push('task_id=?');
    params.push(req.query.taskId);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = Math.max(1, Math.min(2000, Number(req.query.limit) || 200));
  const rows = db.prepare(`SELECT * FROM usage_logs ${where} ORDER BY used_at DESC LIMIT ?`).all(...params, limit);
  res.json(rows.map(rowToUsageLog));
});

app.post('/v1/usage-logs', (req, res) => {
  const log = {
    ...req.body,
    id: req.body.id || uid(),
    action: req.body.action || 'used',
    usedAt: req.body.usedAt || now(),
    createdAt: req.body.createdAt || now(),
  };
  db.prepare(`
    INSERT INTO usage_logs (id, box_id, task_id, action, title, used_at, snapshot_json, raw_json, created_at)
    VALUES (@id, @box_id, @task_id, @action, @title, @used_at, @snapshot_json, @raw_json, @created_at)
    ON CONFLICT(id) DO UPDATE SET box_id=excluded.box_id, task_id=excluded.task_id,
      action=excluded.action, title=excluded.title, used_at=excluded.used_at,
      snapshot_json=excluded.snapshot_json, raw_json=excluded.raw_json
  `).run({
    id: log.id,
    box_id: log.boxId || null,
    task_id: log.taskId || null,
    action: log.action,
    title: log.title || null,
    used_at: log.usedAt,
    snapshot_json: json(log.snapshot || {}),
    raw_json: json(log),
    created_at: log.createdAt,
  });
  res.status(201).json(log);
});

app.get('/v1/points', (req, res) => {
  const account = db.prepare('SELECT * FROM points_account WHERE id=?').get('default');
  const rules = db.prepare('SELECT * FROM points_rules WHERE id=?').get('default');
  res.json({
    version: 1,
    account: account ? { ...parseJson(account.raw_json, {}), title: account.title, unit: account.unit } : {},
    rules: rules ? {
      ...parseJson(rules.raw_json, {}),
      defaultTaskPoints: rules.default_task_points,
      pointPresets: parseJson(rules.point_presets_json, []),
      priorityDefaults: parseJson(rules.priority_defaults_json, {}),
      boxColorDefaults: parseJson(rules.box_color_defaults_json, {}),
      milestoneBonuses: parseJson(rules.milestone_bonuses_json, []),
    } : {},
    rewards: db.prepare('SELECT * FROM points_rewards ORDER BY category, cost, title').all().map(rowToReward),
    transactions: db.prepare('SELECT * FROM points_transactions ORDER BY created_at DESC').all().map(rowToTransaction),
    meta: getMeta('points_meta', { updatedAt: now() }),
  });
});

app.post('/v1/points/transactions', (req, res) => {
  const tx = { ...req.body, id: req.body.id || uid(), createdAt: req.body.createdAt || now(), status: req.body.status || 'active' };
  upsertTransaction(tx);
  res.status(201).json(tx);
});

app.patch('/v1/points/transactions/:id', (req, res) => {
  const current = db.prepare('SELECT * FROM points_transactions WHERE id=?').get(req.params.id);
  if (!current) return res.status(404).json({ error: 'transaction_not_found' });
  const next = mergeRaw(current.raw_json, { ...req.body, id: req.params.id });
  upsertTransaction(next);
  res.json(next);
});

app.post('/v1/points/rewards', (req, res) => {
  const reward = { ...req.body, id: req.body.id || uid(), active: req.body.active !== false };
  upsertReward(reward);
  res.status(201).json(reward);
});

app.patch('/v1/points/rewards/:id', (req, res) => {
  const current = db.prepare('SELECT * FROM points_rewards WHERE id=?').get(req.params.id);
  if (!current) return res.status(404).json({ error: 'reward_not_found' });
  const next = mergeRaw(current.raw_json, { ...req.body, id: req.params.id });
  upsertReward(next);
  res.json(next);
});

function transactionParams(tx) {
  return {
    id: tx.id,
    bucket: tx.bucket || (Number(tx.delta || 0) >= 0 ? 'earn' : 'spend'),
    source_type: tx.sourceType || null,
    source_key: tx.sourceKey || null,
    title: tx.title || '',
    note: tx.note || null,
    delta: Number(tx.delta || 0),
    created_at: tx.createdAt || now(),
    status: tx.status || 'active',
    reversed_at: tx.reversedAt || null,
    raw_json: json(tx),
    updated_at: now(),
  };
}

function upsertTransaction(tx) {
  db.prepare(`
    INSERT INTO points_transactions (id, bucket, source_type, source_key, title, note, delta, created_at, status, reversed_at, raw_json, updated_at)
    VALUES (@id, @bucket, @source_type, @source_key, @title, @note, @delta, @created_at, @status, @reversed_at, @raw_json, @updated_at)
    ON CONFLICT(id) DO UPDATE SET bucket=excluded.bucket, source_type=excluded.source_type,
      source_key=excluded.source_key, title=excluded.title, note=excluded.note, delta=excluded.delta,
      created_at=excluded.created_at, status=excluded.status, reversed_at=excluded.reversed_at,
      raw_json=excluded.raw_json, updated_at=excluded.updated_at
  `).run(transactionParams(tx));
}

function upsertReward(reward) {
  db.prepare(`
    INSERT INTO points_rewards (id, title, description, cost, category, icon, active, raw_json, updated_at)
    VALUES (@id, @title, @description, @cost, @category, @icon, @active, @raw_json, @updated_at)
    ON CONFLICT(id) DO UPDATE SET title=excluded.title, description=excluded.description, cost=excluded.cost,
      category=excluded.category, icon=excluded.icon, active=excluded.active, raw_json=excluded.raw_json, updated_at=excluded.updated_at
  `).run({
    id: reward.id,
    title: reward.title || '',
    description: reward.description || null,
    cost: Number(reward.cost || 0),
    category: reward.category || null,
    icon: reward.icon || null,
    active: reward.active === false ? 0 : 1,
    raw_json: json(reward),
    updated_at: now(),
  });
}

app.get('/v1/smallworld/:realm', (req, res) => {
  const realm = normalizeRealm(req.params.realm);
  if (!realm) return res.status(404).json({ error: 'realm_not_found' });
  res.json(buildSmallWorld(realm));
});

app.post('/v1/smallworld/:realm/items', (req, res) => {
  const realm = normalizeRealm(req.params.realm);
  if (!realm) return res.status(404).json({ error: 'realm_not_found' });
  const item = { ...req.body, id: req.body.id || uid() };
  upsertSwItem(realm, item);
  res.status(201).json(item);
});

app.patch('/v1/smallworld/:realm/items/:id', (req, res) => {
  const realm = normalizeRealm(req.params.realm);
  if (!realm) return res.status(404).json({ error: 'realm_not_found' });
  const current = db.prepare('SELECT * FROM sw_items WHERE realm=? AND item_id=?').get(realm, req.params.id);
  if (!current) return res.status(404).json({ error: 'item_not_found' });
  const next = mergeRaw(current.raw_json, { ...req.body, id: req.params.id });
  upsertSwItem(realm, next, current.floor_id);
  res.json(next);
});

app.delete('/v1/smallworld/:realm/items/:id', (req, res) => {
  const realm = normalizeRealm(req.params.realm);
  if (!realm) return res.status(404).json({ error: 'realm_not_found' });
  db.prepare('DELETE FROM sw_items WHERE realm=? AND item_id=?').run(realm, req.params.id);
  res.json({ ok: true });
});

function normalizeRealm(value) {
  return value === 'pavilion' || value === 'tower' ? value : '';
}

function buildSmallWorld(realm) {
  const floors = db.prepare('SELECT * FROM sw_floors WHERE realm=? ORDER BY floor_id').all(realm);
  return {
    treasure_vault: floors.map((floor) => {
      const raw = parseJson(floor.raw_json, {});
      const items = db.prepare('SELECT * FROM sw_items WHERE realm=? AND floor_id=? ORDER BY sort_order, item_id').all(realm, floor.floor_id)
        .map((item) => parseJson(item.raw_json, {}));
      if (realm === 'pavilion') {
        return {
          ...raw,
          level: floor.floor_id,
          level_name: floor.name,
          level_description: floor.description,
          items,
        };
      }
      return {
        ...raw,
        floor: floor.floor_id,
        floor_name: floor.name,
        floor_desc: floor.description,
        difficulty: floor.difficulty,
        total_tasks: floor.total_count,
        dimension_summary: parseJson(floor.dimension_summary_json, {}),
        tasks: items,
      };
    }),
  };
}

function upsertSwItem(realm, item, fallbackFloorId = null) {
  const isPavilion = realm === 'pavilion';
  const floorId = Number(item.floorId || item.level || item.floor || fallbackFloorId);
  db.prepare(`
    INSERT INTO sw_items (
      realm, floor_id, item_id, title, description, tags_json, types_json, narrative_line, triangle_json,
      dimension, difficulty, reward_tier, priority, progress, is_completed, completed_at, sort_order, raw_json, updated_at
    )
    VALUES (
      @realm, @floor_id, @item_id, @title, @description, @tags_json, @types_json, @narrative_line, @triangle_json,
      @dimension, @difficulty, @reward_tier, @priority, @progress, @is_completed, @completed_at, @sort_order, @raw_json, @updated_at
    )
    ON CONFLICT(realm, item_id) DO UPDATE SET
      floor_id=excluded.floor_id, title=excluded.title, description=excluded.description, tags_json=excluded.tags_json,
      types_json=excluded.types_json, narrative_line=excluded.narrative_line, triangle_json=excluded.triangle_json,
      dimension=excluded.dimension, difficulty=excluded.difficulty, reward_tier=excluded.reward_tier,
      priority=excluded.priority, progress=excluded.progress, is_completed=excluded.is_completed,
      completed_at=excluded.completed_at, sort_order=excluded.sort_order, raw_json=excluded.raw_json, updated_at=excluded.updated_at
  `).run({
    realm,
    floor_id: floorId,
    item_id: item.id,
    title: isPavilion ? (item.title || '') : (item.name || item.title || ''),
    description: isPavilion ? (item.description || '') : (item.desc || item.description || ''),
    tags_json: json(item.tags || []),
    types_json: json(item.types || []),
    narrative_line: item.narrative_line || null,
    triangle_json: json(item.triangle || null),
    dimension: item.dimension || null,
    difficulty: item.difficulty || null,
    reward_tier: item.reward_tier === undefined ? null : Number(item.reward_tier),
    priority: item.priority || null,
    progress: Number(item.progress || 0),
    is_completed: bool(item.isCompleted),
    completed_at: item.completedAt || null,
    sort_order: Number(item.sortOrder || 0),
    raw_json: json(item),
    updated_at: now(),
  });
}

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'internal_error' });
});

app.listen(port, '127.0.0.1', () => {
  console.log(`taskbox-api listening on 127.0.0.1:${port}`);
});
