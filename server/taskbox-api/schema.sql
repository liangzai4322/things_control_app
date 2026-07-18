PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS app_meta (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS boxes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT,
  icon TEXT,
  sort_order INTEGER DEFAULT 0,
  is_default INTEGER DEFAULT 0,
  description TEXT,
  box_type TEXT DEFAULT 'task',
  type_config_json TEXT,
  created_at TEXT,
  updated_at TEXT NOT NULL,
  raw_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mainlines (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  outcome TEXT,
  current_phase TEXT,
  color TEXT,
  icon TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  is_weekly_focus INTEGER DEFAULT 0,
  target_date TEXT,
  sort_order INTEGER DEFAULT 0,
  created_at TEXT,
  updated_at TEXT NOT NULL,
  raw_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mainlines_status_order ON mainlines(status, sort_order);

CREATE TABLE IF NOT EXISTS milestones (
  id TEXT PRIMARY KEY,
  mainline_id TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  target_date TEXT,
  sort_order INTEGER DEFAULT 0,
  completed_at TEXT,
  created_at TEXT,
  updated_at TEXT NOT NULL,
  raw_json TEXT NOT NULL,
  FOREIGN KEY (mainline_id) REFERENCES mainlines(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_milestones_mainline_order ON milestones(mainline_id, sort_order);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  box_id TEXT,
  content TEXT NOT NULL,
  is_completed INTEGER DEFAULT 0,
  sort_order INTEGER DEFAULT 0,
  priority INTEGER DEFAULT 2,
  weight REAL DEFAULT 1,
  points_value REAL,
  progress REAL DEFAULT 0,
  is_recurring_template INTEGER DEFAULT 0,
  recurrence_template_id TEXT,
  recurrence_key TEXT,
  recurrence_json TEXT,
  next_run_at TEXT,
  occurrence_status TEXT,
  mainline_id TEXT,
  milestone_id TEXT,
  device_context TEXT NOT NULL DEFAULT 'universal',
  execution_mode TEXT NOT NULL DEFAULT 'self',
  visible_after TEXT,
  deferred_at TEXT,
  defer_note TEXT,
  progress_logs_json TEXT,
  scheduled_at TEXT,
  due_date TEXT,
  deleted INTEGER DEFAULT 0,
  deleted_at TEXT,
  note TEXT,
  sync_key TEXT,
  completed_at TEXT,
  created_at TEXT,
  updated_at TEXT NOT NULL,
  raw_json TEXT NOT NULL,
  FOREIGN KEY (box_id) REFERENCES boxes(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_box_id ON tasks(box_id);
CREATE INDEX IF NOT EXISTS idx_tasks_updated_at ON tasks(updated_at);
CREATE INDEX IF NOT EXISTS idx_tasks_deleted ON tasks(deleted);

CREATE TABLE IF NOT EXISTS usage_logs (
  id TEXT PRIMARY KEY,
  box_id TEXT,
  task_id TEXT,
  action TEXT NOT NULL DEFAULT 'used',
  title TEXT,
  used_at TEXT NOT NULL,
  snapshot_json TEXT,
  raw_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (box_id) REFERENCES boxes(id) ON DELETE CASCADE,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_usage_logs_box_used_at ON usage_logs(box_id, used_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_logs_task_used_at ON usage_logs(task_id, used_at DESC);

CREATE TABLE IF NOT EXISTS points_account (
  id TEXT PRIMARY KEY DEFAULT 'default',
  title TEXT,
  unit TEXT,
  raw_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS points_rules (
  id TEXT PRIMARY KEY DEFAULT 'default',
  default_task_points INTEGER DEFAULT 5,
  point_presets_json TEXT NOT NULL,
  priority_defaults_json TEXT NOT NULL,
  box_color_defaults_json TEXT NOT NULL,
  milestone_bonuses_json TEXT NOT NULL,
  raw_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS points_rewards (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  cost INTEGER DEFAULT 0,
  category TEXT,
  icon TEXT,
  active INTEGER DEFAULT 1,
  raw_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS points_transactions (
  id TEXT PRIMARY KEY,
  bucket TEXT NOT NULL,
  source_type TEXT,
  source_key TEXT,
  title TEXT NOT NULL,
  note TEXT,
  delta INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  status TEXT DEFAULT 'active',
  reversed_at TEXT,
  raw_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_points_transactions_created_at ON points_transactions(created_at);
CREATE INDEX IF NOT EXISTS idx_points_transactions_bucket ON points_transactions(bucket);

CREATE TABLE IF NOT EXISTS sw_floors (
  realm TEXT NOT NULL,
  floor_id INTEGER NOT NULL,
  name TEXT,
  description TEXT,
  difficulty TEXT,
  total_count INTEGER DEFAULT 0,
  dimension_summary_json TEXT,
  raw_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (realm, floor_id)
);

CREATE TABLE IF NOT EXISTS sw_items (
  realm TEXT NOT NULL,
  floor_id INTEGER NOT NULL,
  item_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  tags_json TEXT,
  types_json TEXT,
  narrative_line TEXT,
  triangle_json TEXT,
  dimension TEXT,
  difficulty TEXT,
  reward_tier INTEGER,
  priority TEXT,
  progress REAL DEFAULT 0,
  is_completed INTEGER DEFAULT 0,
  completed_at TEXT,
  sort_order INTEGER DEFAULT 0,
  raw_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (realm, item_id),
  FOREIGN KEY (realm, floor_id) REFERENCES sw_floors(realm, floor_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sw_items_floor ON sw_items(realm, floor_id);
