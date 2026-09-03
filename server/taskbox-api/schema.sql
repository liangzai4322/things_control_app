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

CREATE TABLE IF NOT EXISTS branches (
  id TEXT PRIMARY KEY,
  mainline_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  branch_type TEXT NOT NULL DEFAULT 'project',
  status TEXT NOT NULL DEFAULT 'planned',
  icon TEXT,
  color TEXT,
  target_date TEXT,
  next_action TEXT,
  completion_criteria TEXT,
  review TEXT,
  sort_order INTEGER DEFAULT 0,
  completed_at TEXT,
  created_at TEXT,
  updated_at TEXT NOT NULL,
  raw_json TEXT NOT NULL,
  FOREIGN KEY (mainline_id) REFERENCES mainlines(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_branches_mainline_status_order ON branches(mainline_id, status, sort_order);

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
  revision INTEGER NOT NULL DEFAULT 1,
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
  branch_id TEXT,
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
  FOREIGN KEY (box_id) REFERENCES boxes(id) ON DELETE SET NULL,
  FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_box_id ON tasks(box_id);
CREATE INDEX IF NOT EXISTS idx_tasks_updated_at ON tasks(updated_at);
CREATE INDEX IF NOT EXISTS idx_tasks_deleted ON tasks(deleted);

CREATE TABLE IF NOT EXISTS execution_task_operations (
  idempotency_key TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  operation_type TEXT NOT NULL,
  task_id TEXT,
  authorization_source TEXT NOT NULL,
  authorization_ref TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  expected_revision INTEGER,
  result_revision INTEGER,
  http_status INTEGER NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (authorization_source IN ('explicit_user','standing_rule','approved_hq_proposal'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_execution_task_operations_request
  ON execution_task_operations(request_id);

CREATE TABLE IF NOT EXISTS execution_task_audit (
  audit_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  idempotency_key TEXT,
  operation_type TEXT,
  task_id TEXT,
  authorization_source TEXT,
  authorization_ref TEXT,
  expected_revision INTEGER,
  result_revision INTEGER,
  outcome TEXT NOT NULL,
  error_code TEXT,
  request_hash TEXT,
  changes_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_execution_task_audit_task_created
  ON execution_task_audit(task_id, created_at DESC);

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

CREATE TABLE IF NOT EXISTS hq_daily_briefs (
  review_date TEXT PRIMARY KEY,
  primary_task_id TEXT,
  maintenance_task_ids_json TEXT NOT NULL DEFAULT '[]',
  stop_doing_json TEXT NOT NULL DEFAULT '[]',
  continue_doing_json TEXT NOT NULL DEFAULT '[]',
  outcomes_json TEXT NOT NULL DEFAULT '{}',
  yesterday_closure_json TEXT NOT NULL DEFAULT '{}',
  notes TEXT,
  source TEXT NOT NULL DEFAULT 'hq',
  raw_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (primary_task_id) REFERENCES tasks(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_hq_daily_briefs_updated_at ON hq_daily_briefs(updated_at DESC);

CREATE TABLE IF NOT EXISTS hq_decisions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  context TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  urgency TEXT NOT NULL DEFAULT 'normal',
  resolution TEXT,
  mainline_id TEXT,
  task_id TEXT,
  due_date TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  updated_at TEXT NOT NULL,
  raw_json TEXT NOT NULL,
  FOREIGN KEY (mainline_id) REFERENCES mainlines(id) ON DELETE SET NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_hq_decisions_status_updated ON hq_decisions(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS hq_proposals (
  decision_id TEXT PRIMARY KEY,
  proposal_type TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  source_authority TEXT NOT NULL,
  standing_rule_id TEXT,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposed',
  revision INTEGER NOT NULL DEFAULT 1,
  revision_hash TEXT NOT NULL,
  evidence_status TEXT NOT NULL DEFAULT 'unknown',
  existing_task_id TEXT,
  task_id TEXT,
  defer_until TEXT,
  decision_note TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT,
  promoted_at TEXT,
  updated_at TEXT NOT NULL,
  raw_json TEXT NOT NULL,
  CHECK (proposal_type IN ('daily_action_proposal', 'weekly_experiment_proposal', 'monthly_bet_proposal')),
  CHECK (source_authority IN ('explicit_user', 'standing_rule', 'ai_derived')),
  CHECK (status IN ('proposed', 'approved', 'rejected', 'deferred', 'promoted')),
  FOREIGN KEY (existing_task_id) REFERENCES tasks(id) ON DELETE SET NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_hq_proposals_status_updated
  ON hq_proposals(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_hq_proposals_type_updated
  ON hq_proposals(proposal_type, updated_at DESC);

CREATE TABLE IF NOT EXISTS hq_proposal_events (
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  actor TEXT NOT NULL,
  note TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  FOREIGN KEY (proposal_id) REFERENCES hq_proposals(decision_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS hq_review_rules (
  rule_id TEXT PRIMARY KEY,
  version INTEGER NOT NULL DEFAULT 1,
  source TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  revocable INTEGER NOT NULL DEFAULT 1,
  reason_code TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  fingerprint TEXT,
  match_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  raw_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_hq_review_rules_enabled_scope ON hq_review_rules(enabled, scope_key);

CREATE INDEX IF NOT EXISTS idx_hq_proposal_events_proposal_created
  ON hq_proposal_events(proposal_id, created_at ASC);

CREATE TABLE IF NOT EXISTS hq_proposal_replies (
  reply_id TEXT PRIMARY KEY,
  inbound_message_id TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL,
  proposal_id TEXT NOT NULL,
  expected_revision INTEGER NOT NULL,
  decision TEXT NOT NULL,
  text_hash TEXT NOT NULL,
  source TEXT NOT NULL,
  reply_ref TEXT NOT NULL,
  verified_user_ref TEXT NOT NULL,
  signature_ref TEXT NOT NULL,
  received_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'received',
  http_status INTEGER,
  response_json TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (decision IN ('approve', 'reject', 'defer', 'expand')),
  CHECK (status IN ('received', 'applied', 'clarification_recorded', 'rejected')),
  FOREIGN KEY (proposal_id) REFERENCES hq_proposals(decision_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_hq_proposal_replies_proposal_created
  ON hq_proposal_replies(proposal_id, created_at DESC);

CREATE TABLE IF NOT EXISTS hq_proposal_reply_audit (
  id TEXT PRIMARY KEY,
  reply_id TEXT NOT NULL,
  proposal_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  actor TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  UNIQUE(reply_id, event_type),
  FOREIGN KEY (reply_id) REFERENCES hq_proposal_replies(reply_id) ON DELETE CASCADE,
  FOREIGN KEY (proposal_id) REFERENCES hq_proposals(decision_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_hq_proposal_reply_audit_proposal_created
  ON hq_proposal_reply_audit(proposal_id, created_at ASC);

CREATE TABLE IF NOT EXISTS hq_period_reviews (
  period_type TEXT NOT NULL,
  period_key TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  verdict TEXT,
  source TEXT NOT NULL DEFAULT 'hq',
  completed_at TEXT,
  raw_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (period_type, period_key),
  CHECK (period_type IN ('week', 'month'))
);

CREATE INDEX IF NOT EXISTS idx_hq_period_reviews_range
  ON hq_period_reviews(period_type, start_date DESC, end_date DESC);

CREATE TABLE IF NOT EXISTS system_candidates (
  candidate_id TEXT PRIMARY KEY,
  system_id TEXT NOT NULL,
  review_date TEXT NOT NULL,
  kind TEXT NOT NULL,
  statement TEXT NOT NULL,
  authority TEXT NOT NULL DEFAULT 'ai_summary',
  epistemic_state TEXT NOT NULL DEFAULT 'candidate_unvalidated',
  status TEXT NOT NULL DEFAULT 'pending',
  evidence_json TEXT NOT NULL DEFAULT '[]',
  source_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  raw_json TEXT NOT NULL,
  CHECK (system_id IN ('mission','health','time','execution','feedback')),
  CHECK (status IN ('pending','kept','dismissed'))
);
CREATE INDEX IF NOT EXISTS idx_system_candidates_system_status_date
  ON system_candidates(system_id, status, review_date DESC);

CREATE TABLE IF NOT EXISTS system_intakes (
  id TEXT PRIMARY KEY,
  system_id TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  contract_version TEXT NOT NULL,
  review_date TEXT NOT NULL,
  observation_period_json TEXT NOT NULL,
  source_ref_json TEXT NOT NULL,
  evidence_refs_json TEXT NOT NULL,
  freshness_json TEXT NOT NULL,
  revision INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  payload_hash TEXT NOT NULL,
  data_json TEXT NOT NULL,
  status TEXT NOT NULL,
  received_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  raw_json TEXT NOT NULL,
  UNIQUE(system_id, review_date, revision)
);
CREATE INDEX IF NOT EXISTS idx_system_intakes_system_date
  ON system_intakes(system_id, review_date DESC, revision DESC);

CREATE TABLE IF NOT EXISTS system_intake_receipts (
  id TEXT PRIMARY KEY,
  intake_id TEXT NOT NULL UNIQUE,
  system_id TEXT NOT NULL,
  review_date TEXT NOT NULL,
  status TEXT NOT NULL,
  projection_json TEXT NOT NULL,
  error_code TEXT,
  error_message TEXT,
  retry_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  processed_at TEXT,
  updated_at TEXT NOT NULL,
  raw_json TEXT NOT NULL,
  FOREIGN KEY (intake_id) REFERENCES system_intakes(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_system_intake_receipts_date
  ON system_intake_receipts(system_id, review_date DESC, updated_at DESC);

CREATE TABLE IF NOT EXISTS system_intake_receipt_requests (
  idempotency_key TEXT PRIMARY KEY,
  receipt_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (receipt_id) REFERENCES system_intake_receipts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS health_observations (
  observation_id TEXT PRIMARY KEY,
  observation_date TEXT NOT NULL,
  effective_date TEXT NOT NULL,
  review_date TEXT,
  source TEXT NOT NULL,
  source_ref TEXT,
  source_hash TEXT,
  authority TEXT NOT NULL,
  confidence REAL NOT NULL,
  raw_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_health_observations_effective_date
  ON health_observations(effective_date DESC, observation_date DESC);

CREATE TABLE IF NOT EXISTS health_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  effective_date TEXT NOT NULL,
  published_at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_health_snapshots_effective_date
  ON health_snapshots(effective_date DESC, published_at DESC);

CREATE TABLE IF NOT EXISTS mission_records (
  record_id TEXT PRIMARY KEY,
  record_type TEXT NOT NULL,
  mission_id TEXT NOT NULL,
  version INTEGER,
  status TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  content_hash TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (record_type IN ('draft','version')),
  CHECK (status IN ('draft','published'))
);
CREATE INDEX IF NOT EXISTS idx_mission_records_type_updated
  ON mission_records(record_type, updated_at DESC);

CREATE TABLE IF NOT EXISTS mission_record_versions (
  record_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (record_id, revision),
  FOREIGN KEY (record_id) REFERENCES mission_records(record_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS mission_candidates (
  candidate_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  content_hash TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (status IN ('unreviewed','ignored','observing','included_in_draft'))
);
CREATE INDEX IF NOT EXISTS idx_mission_candidates_status_updated
  ON mission_candidates(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS mission_events (
  event_id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL UNIQUE,
  record_id TEXT,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mission_events_record_created
  ON mission_events(record_id, created_at ASC);
