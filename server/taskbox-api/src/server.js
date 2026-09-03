const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const Database = require('better-sqlite3');
const { createTransport } = require('./daily-intake-transport');
const { installHealthSystemRoutes } = require('./health-system');
const { installMissionSystemRoutes } = require('./mission-system');
const { installExecutionSystemRoutes } = require('./execution-system');

const root = path.resolve(__dirname, '..');
const dbPath = process.env.TASKBOX_DB_PATH || path.join(root, 'data', 'taskbox.sqlite');
const port = Number(process.env.TASKBOX_API_PORT || 3107);
const apiToken = String(process.env.TASKBOX_API_TOKEN || '').trim();
const executionApiEnabled = String(process.env.EXECUTION_SYSTEM_API_ENABLED || '') === '1';
const executionTokenFile = String(process.env.EXECUTION_SYSTEM_API_TOKEN_FILE || '').trim();
const executionDisableFile = String(process.env.EXECUTION_SYSTEM_API_DISABLE_FILE || '/etc/taskbox-execution-system.disabled').trim();
const assistantGatewayApiEnabled = String(process.env.ASSISTANT_GATEWAY_API_ENABLED || '') === '1';
const assistantGatewayTokenFile = String(process.env.ASSISTANT_GATEWAY_API_TOKEN_FILE || '').trim();
const assistantGatewayDisableFile = String(process.env.ASSISTANT_GATEWAY_API_DISABLE_FILE || '/etc/taskbox-assistant-gateway.disabled').trim();
const assistantGatewayScopes = new Set(String(process.env.ASSISTANT_GATEWAY_API_SCOPES || '')
  .split(',').map((item) => item.trim()).filter(Boolean));
const dailyIntakeApiEnabled = String(process.env.DAILY_INTAKE_API_ENABLED || '') === '1';
const dailyIntakeDisableFile = String(process.env.DAILY_INTAKE_DISABLE_FILE || '/etc/taskbox-daily-intake.disabled').trim();
const dailyIntakeSystems = ['execution', 'health', 'attention', 'feedback', 'mission', 'governance'];
const hqDailyIntakeCacheFile = String(process.env.HQ_DAILY_INTAKE_CACHE_FILE || '/var/lib/taskbox-hq-daily-intake/receipts-summary.json').trim();
const allowedOrigins = String(process.env.TASKBOX_ALLOWED_ORIGINS || 'https://liangzai4322.github.io,http://localhost:8000,http://127.0.0.1:8000')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);
const fiveSystemBaselinePath = String(process.env.TASKBOX_FIVE_SYSTEM_BASELINE_PATH || path.join(root, 'data', 'private', 'five-system-baseline-v1.json')).trim();

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
  ['revision', 'INTEGER NOT NULL DEFAULT 1'],
  ['scheduled_at', 'TEXT'],
  ['is_recurring_template', 'INTEGER DEFAULT 0'],
  ['recurrence_template_id', 'TEXT'],
  ['recurrence_key', 'TEXT'],
  ['recurrence_json', 'TEXT'],
  ['next_run_at', 'TEXT'],
  ['occurrence_status', 'TEXT'],
  ['mainline_id', 'TEXT'],
  ['branch_id', 'TEXT'],
  ['milestone_id', 'TEXT'],
  ['device_context', "TEXT DEFAULT 'universal'"],
  ['execution_mode', "TEXT DEFAULT 'self'"],
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
db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_branch_id ON tasks(branch_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_milestone_id ON tasks(milestone_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_visible_after ON tasks(visible_after)');
db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_device_context ON tasks(device_context)');
db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_execution_mode ON tasks(execution_mode)');

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
const secretMatches = (left, right) => {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
};
const readSecretFile = (filePath) => {
  try { return filePath ? fs.readFileSync(filePath, 'utf8').trim() : ''; } catch { return ''; }
};
const bearerToken = (req) => String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
const dailyIntakeIdentities = () => {
  const identities = [
    { name: 'daily-review-sender', token: readSecretFile(String(process.env.DAILY_INTAKE_SENDER_TOKEN_FILE || '').trim()), scopes: ['intakes:write'] },
    { name: 'hq', token: readSecretFile(String(process.env.DAILY_INTAKE_HQ_TOKEN_FILE || '').trim()), scopes: ['receipts:read'] },
    ...dailyIntakeSystems.map((systemId) => ({
      name: systemId,
      systemId,
      token: readSecretFile(String(process.env[`DAILY_INTAKE_${systemId.toUpperCase()}_TOKEN_FILE`] || '').trim()),
      scopes: systemId === 'health'
        ? ['intakes:read', 'receipts:write', 'health:observations:read', 'health:observations:write']
        : systemId === 'mission'
          ? ['intakes:read', 'receipts:write', 'mission-state:read']
        : ['intakes:read', 'receipts:write'],
    })),
  ];
  return identities.filter((identity) => identity.token);
};
const resolveDailyIntakeIdentity = (req) => {
  const token = bearerToken(req);
  return dailyIntakeIdentities().find((identity) => secretMatches(token, identity.token)) || null;
};
const authorizeDailyIntake = (req, scope, systemId = null) => {
  if (!dailyIntakeApiEnabled || (dailyIntakeDisableFile && fs.existsSync(dailyIntakeDisableFile))) {
    return { ok: false, status: 503, error: 'daily_intake_api_disabled' };
  }
  const identity = req.dailyIntakeIdentity;
  if (!identity) return { ok: false, status: 401, error: 'daily_intake_unauthorized' };
  if (!identity.scopes.includes(scope)) return { ok: false, status: 403, error: 'daily_intake_scope_denied' };
  if (systemId && identity.systemId !== systemId) return { ok: false, status: 403, error: 'daily_intake_system_denied' };
  return { ok: true, identity };
};
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
  req.dailyIntakeIdentity = resolveDailyIntakeIdentity(req);
  next();
});
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Taskbox-Token,If-Match,X-Idempotency-Key');
  if (req.method === 'OPTIONS') return res.status(204).end();
  return next();
});
app.use((req, res, next) => {
  const intakeRoute = req.path === '/v1/mission/state'
    || req.path === '/v1/hq/system-receipts'
    || req.path === '/v1/health/observations'
    || req.path === '/v1/health/observations/batch'
    || /^\/v1\/system-candidates\/[^/]+\/receipt$/.test(req.path)
    || (req.path === '/v1/system-candidates' && String(req.query?.intake || '') === '1')
    || (req.path === '/v1/system-candidates/batch' && dailyIntakeTransport.isIntakeBatch(req));
  if (intakeRoute && dailyIntakeApiEnabled && !req.dailyIntakeIdentity) {
    if (dailyIntakeDisableFile && fs.existsSync(dailyIntakeDisableFile)) {
      return res.status(503).json({ error: 'daily_intake_api_disabled' });
    }
    return res.status(401).json({ error: 'daily_intake_unauthorized' });
  }
  if (req.dailyIntakeIdentity) {
    if (req.path === '/v1/system-candidates' || req.path === '/v1/system-candidates/batch'
      || /^\/v1\/system-candidates\/[^/]+\/receipt$/.test(req.path) || req.path === '/v1/hq/system-receipts'
      || req.path === '/v1/health/observations' || req.path === '/v1/health/observations/batch'
      || req.path === '/v1/mission/state') return next();
    return res.status(403).json({ error: 'daily_intake_route_denied' });
  }
  if (/^\/v1\/hq\/proposals\/[^/]+\/replies$/.test(req.path)) {
    if (!assistantGatewayApiEnabled
      || (assistantGatewayDisableFile && fs.existsSync(assistantGatewayDisableFile))) {
      return res.status(503).json({ error: 'assistant_gateway_api_disabled' });
    }
    const gatewayToken = readSecretFile(assistantGatewayTokenFile);
    if (!gatewayToken) return res.status(503).json({ error: 'assistant_gateway_api_not_configured' });
    if (!secretMatches(bearerToken(req), gatewayToken)) {
      return res.status(401).json({ error: 'assistant_gateway_unauthorized' });
    }
    if (!assistantGatewayScopes.has('proposal-replies:write')) {
      return res.status(403).json({ error: 'assistant_gateway_scope_denied' });
    }
    req.assistantGatewayIdentity = { system: 'assistant-gateway', scopes: assistantGatewayScopes };
    return next();
  }
  if (req.path.startsWith('/v1/execution')) {
    if (!executionApiEnabled || (executionDisableFile && fs.existsSync(executionDisableFile))) {
      return res.status(503).json({ error: 'execution_api_disabled' });
    }
    let executionToken = String(process.env.EXECUTION_SYSTEM_API_TOKEN || '').trim();
    if (!executionToken && executionTokenFile) {
      try { executionToken = fs.readFileSync(executionTokenFile, 'utf8').trim(); } catch {}
    }
    if (!executionToken) return res.status(503).json({ error: 'execution_api_not_configured' });
    const auth = bearerToken(req);
    if (!secretMatches(auth, executionToken)) return res.status(401).json({ error: 'execution_unauthorized' });
    req.executionIdentity = {
      system: 'execution-system',
      scopes: new Set(String(process.env.EXECUTION_SYSTEM_API_SCOPES || '').split(',').map((item) => item.trim()).filter(Boolean)),
    };
    return next();
  }
  if (dailyIntakeApiEnabled && (req.path === '/v1/health/observations' || req.path === '/v1/health/observations/batch')) {
    return res.status(401).json({ error: 'daily_intake_unauthorized' });
  }
  if (!apiToken) return next();
  const auth = bearerToken(req);
  const headerToken = String(req.headers['x-taskbox-token'] || '').trim();
  if (secretMatches(auth, apiToken) || secretMatches(headerToken, apiToken)) return next();
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
  if (!row) return null;
  return {
    ...parseJson(row.raw_json, {}),
    id: row.id,
    revision: Number(row.revision || 1),
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
    branchId: row.branch_id,
    milestoneId: row.milestone_id,
    deviceContext: row.device_context || 'universal',
    executionMode: row.execution_mode || 'self',
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

function rowToBranch(row) {
  return {
    ...parseJson(row.raw_json, {}),
    id: row.id,
    mainlineId: row.mainline_id,
    name: row.name,
    description: row.description || '',
    branchType: row.branch_type || 'project',
    status: row.status || 'planned',
    icon: row.icon || '◇',
    color: row.color || '#337a78',
    targetDate: row.target_date,
    nextAction: row.next_action || '',
    completionCriteria: row.completion_criteria || '',
    review: row.review || '',
    sortOrder: row.sort_order,
    completedAt: row.completed_at,
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

function rowToDailyBrief(row) {
  if (!row) return null;
  return {
    ...parseJson(row.raw_json, {}),
    reviewDate: row.review_date,
    primaryTaskId: row.primary_task_id,
    maintenanceTaskIds: parseJson(row.maintenance_task_ids_json, []),
    stopDoing: parseJson(row.stop_doing_json, []),
    continueDoing: parseJson(row.continue_doing_json, []),
    outcomes: parseJson(row.outcomes_json, {}),
    yesterdayClosure: parseJson(row.yesterday_closure_json, {}),
    notes: row.notes || '',
    source: row.source || 'hq',
    updatedAt: row.updated_at,
  };
}

function rowToDecision(row) {
  if (!row) return null;
  return {
    ...parseJson(row.raw_json, {}),
    id: row.id,
    title: row.title,
    context: row.context || '',
    status: row.status || 'open',
    urgency: row.urgency || 'normal',
    resolution: row.resolution || '',
    mainlineId: row.mainline_id,
    taskId: row.task_id,
    dueDate: row.due_date,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    updatedAt: row.updated_at,
  };
}

function rowToPeriodReview(row) {
  if (!row) return null;
  return {
    ...parseJson(row.raw_json, {}),
    periodType: row.period_type,
    periodKey: row.period_key,
    startDate: row.start_date,
    endDate: row.end_date,
    status: row.status || 'draft',
    verdict: row.verdict || '',
    source: row.source || 'hq',
    completedAt: row.completed_at,
    updatedAt: row.updated_at,
  };
}

function rowToProposal(row) {
  if (!row) return null;
  return {
    ...parseJson(row.raw_json, {}),
    decisionId: row.decision_id,
    proposalType: row.proposal_type,
    idempotencyKey: row.idempotency_key,
    sourceAuthority: row.source_authority,
    standingRuleId: row.standing_rule_id,
    title: row.title,
    status: row.status,
    revision: Number(row.revision) || 1,
    revisionHash: row.revision_hash,
    evidenceStatus: row.evidence_status || 'unknown',
    existingTaskId: row.existing_task_id,
    taskId: row.task_id,
    deferUntil: row.defer_until,
    decisionNote: row.decision_note || '',
    createdAt: row.created_at,
    decidedAt: row.decided_at,
    promotedAt: row.promoted_at,
    updatedAt: row.updated_at,
  };
}

function rowToProposalEvent(row) {
  return {
    id: row.id,
    revision: Number(row.revision || 1),
    proposalId: row.proposal_id,
    revision: Number(row.revision) || 1,
    eventType: row.event_type,
    actor: row.actor,
    note: row.note || '',
    detail: parseJson(row.detail_json, {}),
    createdAt: row.created_at,
  };
}

function mergeRaw(existingRaw, patch) {
  return { ...parseJson(existingRaw, {}), ...patch };
}

function validDateKey(value) {
  const date = String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
}

const HQ_PROPOSAL_TYPES = new Set([
  'daily_action_proposal',
  'weekly_experiment_proposal',
  'monthly_bet_proposal',
]);
const HQ_SOURCE_AUTHORITIES = new Set(['explicit_user', 'standing_rule', 'ai_derived']);
const HQ_PROPOSAL_STATUSES = new Set(['proposed', 'approved', 'rejected', 'deferred', 'promoted']);
const HQ_PROPOSAL_TERMINAL_SYNC_STATUSES = new Set(['rejected', 'deferred', 'promoted']);

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

const dailyIntakeTransport = createTransport({
  app, db, now, uid, json, parseJson, stableJson, validDateKey, authorizeDailyIntake,
});

function proposalRevisionHash(input = {}) {
  if (String(input.revisionHash || '').trim()) return String(input.revisionHash).trim();
  const revisionInput = {
    proposalType: input.proposalType,
    sourceAuthority: input.sourceAuthority,
    standingRuleId: input.standingRuleId || null,
    title: String(input.title || '').trim(),
    content: input.content || {},
    evidence: input.evidence || {},
    sourceRef: input.sourceRef || {},
    taskSpec: input.taskSpec || {},
    existingTaskId: input.existingTaskId || null,
  };
  return crypto.createHash('sha256').update(stableJson(revisionInput)).digest('hex');
}

function proposalEvidenceStatus(input = {}) {
  const value = String(input.evidenceStatus || input.evidence?.evidenceStatus || '').trim();
  return value || 'unknown';
}

function proposalInitialStatus(sourceAuthority) {
  return sourceAuthority === 'ai_derived' ? 'proposed' : 'approved';
}

function proposalError(code, status = 400, detail = {}) {
  const error = new Error(code);
  error.code = code;
  error.status = status;
  error.detail = detail;
  return error;
}

function validateProposalInput(input = {}) {
  const proposalType = String(input.proposalType || '').trim();
  const sourceAuthority = String(input.sourceAuthority || '').trim();
  const title = String(input.title || '').trim();
  const idempotencyKey = String(input.idempotencyKey || '').trim();
  if (!HQ_PROPOSAL_TYPES.has(proposalType)) throw proposalError('invalid_proposal_type');
  if (!HQ_SOURCE_AUTHORITIES.has(sourceAuthority)) throw proposalError('invalid_source_authority');
  if (!title) throw proposalError('title_required');
  if (!idempotencyKey) throw proposalError('idempotency_key_required');
  if (sourceAuthority === 'standing_rule' && !String(input.standingRuleId || '').trim()) {
    throw proposalError('standing_rule_id_required');
  }
  return { proposalType, sourceAuthority, title, idempotencyKey };
}

function recordProposalEvent(proposal, eventType, actor = 'hq', note = '', detail = {}) {
  db.prepare(`
    INSERT INTO hq_proposal_events (
      id, proposal_id, revision, event_type, actor, note, detail_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    uid(), proposal.decisionId, proposal.revision, eventType,
    String(actor || 'hq'), String(note || ''), json(detail || {}), now(),
  );
}

function proposalParams(proposal) {
  return {
    decision_id: proposal.decisionId,
    proposal_type: proposal.proposalType,
    idempotency_key: proposal.idempotencyKey,
    source_authority: proposal.sourceAuthority,
    standing_rule_id: proposal.standingRuleId || null,
    title: proposal.title,
    status: proposal.status,
    revision: proposal.revision,
    revision_hash: proposal.revisionHash,
    evidence_status: proposal.evidenceStatus || 'unknown',
    existing_task_id: proposal.existingTaskId || null,
    task_id: proposal.taskId || null,
    defer_until: proposal.deferUntil || null,
    decision_note: proposal.decisionNote || null,
    created_at: proposal.createdAt,
    decided_at: proposal.decidedAt || null,
    promoted_at: proposal.promotedAt || null,
    updated_at: proposal.updatedAt,
    raw_json: json(proposal),
  };
}

function saveProposal(proposal) {
  db.prepare(`
    INSERT INTO hq_proposals (
      decision_id, proposal_type, idempotency_key, source_authority, standing_rule_id,
      title, status, revision, revision_hash, evidence_status, existing_task_id, task_id,
      defer_until, decision_note, created_at, decided_at, promoted_at, updated_at, raw_json
    ) VALUES (
      @decision_id, @proposal_type, @idempotency_key, @source_authority, @standing_rule_id,
      @title, @status, @revision, @revision_hash, @evidence_status, @existing_task_id, @task_id,
      @defer_until, @decision_note, @created_at, @decided_at, @promoted_at, @updated_at, @raw_json
    )
    ON CONFLICT(decision_id) DO UPDATE SET
      proposal_type=excluded.proposal_type,
      source_authority=excluded.source_authority,
      standing_rule_id=excluded.standing_rule_id,
      title=excluded.title,
      status=excluded.status,
      revision=excluded.revision,
      revision_hash=excluded.revision_hash,
      evidence_status=excluded.evidence_status,
      existing_task_id=excluded.existing_task_id,
      task_id=excluded.task_id,
      defer_until=excluded.defer_until,
      decision_note=excluded.decision_note,
      decided_at=excluded.decided_at,
      promoted_at=excluded.promoted_at,
      updated_at=excluded.updated_at,
      raw_json=excluded.raw_json
  `).run(proposalParams(proposal));
  return rowToProposal(db.prepare('SELECT * FROM hq_proposals WHERE decision_id=?').get(proposal.decisionId));
}

function upsertProposal(input = {}) {
  const normalized = validateProposalInput(input);
  if (input.existingTaskId && !db.prepare('SELECT 1 FROM tasks WHERE id=?').get(input.existingTaskId)) {
    throw proposalError('existing_task_not_found', 409);
  }
  const revisionHash = proposalRevisionHash(input);
  const existingRow = db.prepare('SELECT * FROM hq_proposals WHERE idempotency_key=?').get(normalized.idempotencyKey);
  const existing = rowToProposal(existingRow);
  if (existing && existing.revisionHash === revisionHash) return { proposal: existing, created: false, revised: false };
  const timestamp = now();
  if (!existing) {
    const proposal = saveProposal({
      ...input,
      ...normalized,
      decisionId: input.decisionId || `proposal-${crypto.createHash('sha256').update(normalized.idempotencyKey).digest('hex').slice(0, 24)}`,
      status: proposalInitialStatus(normalized.sourceAuthority),
      revision: 1,
      revisionHash,
      evidenceStatus: proposalEvidenceStatus(input),
      existingTaskId: input.existingTaskId || null,
      taskId: null,
      deferUntil: null,
      decisionNote: '',
      createdAt: timestamp,
      decidedAt: normalized.sourceAuthority === 'ai_derived' ? null : timestamp,
      promotedAt: null,
      updatedAt: timestamp,
    });
    recordProposalEvent(proposal, 'created', input.actor, '', {
      sourceAuthority: proposal.sourceAuthority,
      initialStatus: proposal.status,
    });
    return { proposal, created: true, revised: false };
  }
  const status = HQ_PROPOSAL_TERMINAL_SYNC_STATUSES.has(existing.status)
    ? existing.status
    : (existing.status === 'approved' ? 'approved' : proposalInitialStatus(normalized.sourceAuthority));
  const proposal = saveProposal({
    ...existing,
    ...input,
    ...normalized,
    decisionId: existing.decisionId,
    status,
    revision: existing.revision + 1,
    revisionHash,
    evidenceStatus: proposalEvidenceStatus(input),
    taskId: existing.taskId || null,
    deferUntil: existing.deferUntil || null,
    decisionNote: existing.decisionNote || '',
    createdAt: existing.createdAt,
    decidedAt: existing.decidedAt || null,
    promotedAt: existing.promotedAt || null,
    updatedAt: timestamp,
  });
  recordProposalEvent(proposal, 'revised', input.actor, '', { previousRevision: existing.revision });
  return { proposal, created: false, revised: true };
}

function getProposalOrThrow(decisionId) {
  const proposal = rowToProposal(db.prepare('SELECT * FROM hq_proposals WHERE decision_id=?').get(decisionId));
  if (!proposal) throw proposalError('proposal_not_found', 404);
  return proposal;
}

function transitionProposal(decisionId, eventType, input = {}) {
  const current = getProposalOrThrow(decisionId);
  const actor = String(input.actor || 'hq').trim() || 'hq';
  const note = String(input.note || '').trim();
  if (current.status === 'promoted') throw proposalError('proposal_already_promoted', 409);
  let nextStatus = eventType;
  let deferUntil = current.deferUntil || null;
  let taskSpec = current.taskSpec || {};
  let existingTaskId = current.existingTaskId || null;
  let rejectionFeedback = current.rejectionFeedback || null;
  if (eventType === 'approve') {
    nextStatus = 'approved';
    if (current.proposalType === 'monthly_bet_proposal' && current.evidenceStatus === 'provisional') {
      throw proposalError('provisional_evidence_cannot_approve', 409);
    }
    deferUntil = null;
    if (input.boxId) taskSpec = { ...taskSpec, boxId: String(input.boxId) };
    if (input.existingTaskId) {
      const taskId = String(input.existingTaskId).trim();
      if (!db.prepare('SELECT 1 FROM tasks WHERE id=? AND is_deleted=0').get(taskId)) {
        throw proposalError('existing_task_not_found', 409, { taskId });
      }
      existingTaskId = taskId;
    }
  } else if (eventType === 'reject') {
    nextStatus = 'rejected';
    deferUntil = null;
    rejectionFeedback = {
      reasonCode: String(input.reasonCode || 'unspecified').trim() || 'unspecified',
      reason: note,
      scopeKey: String(input.scopeKey || '').trim() || null,
      fingerprint: String(input.fingerprint || '').trim() || null,
      decidedBy: actor,
      decidedAt: now(),
    };
  } else if (eventType === 'defer') {
    deferUntil = validDateKey(input.deferUntil);
    if (!deferUntil) throw proposalError('valid_defer_until_required');
    nextStatus = 'deferred';
  } else if (eventType === 'restore') {
    if (current.status !== 'rejected') throw proposalError('proposal_not_rejected', 409);
    const rejection = db.prepare(`
      SELECT detail_json FROM hq_proposal_events
      WHERE proposal_id=? AND event_type='reject' ORDER BY created_at DESC, id DESC LIMIT 1
    `).get(current.decisionId);
    const previousStatus = parseJson(rejection?.detail_json, {}).previousStatus;
    nextStatus = ['proposed', 'approved', 'deferred'].includes(previousStatus) ? previousStatus : 'proposed';
  } else {
    throw proposalError('invalid_proposal_transition');
  }
  const proposal = saveProposal({
    ...current,
    status: nextStatus,
    deferUntil,
    taskSpec,
    existingTaskId,
    rejectionFeedback,
    decisionNote: note,
    decidedAt: now(),
    updatedAt: now(),
  });
  recordProposalEvent(proposal, eventType, actor, note, { previousStatus: current.status, deferUntil, rejectionFeedback });
  return proposal;
}

function todayKey() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Singapore' }).format(new Date());
}

function dateKeyInReviewTimezone(value) {
  const date = new Date(value || 0);
  if (Number.isNaN(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Singapore',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function normalizeDailyBriefMutationMetadata(value) {
  if (!value || typeof value !== 'object') return null;
  const mutationId = String(value.mutationId || '').trim();
  const clientId = String(value.clientId || '').trim();
  const sequence = Number(value.sequence);
  const generation = String(value.generation || '').trim();
  if (!mutationId) return null;
  if (!clientId) return { legacy: true, mutationId };
  if (Number.isSafeInteger(sequence) && sequence >= 1) return { clientId, mutationId, sequence, generation };
  if (generation) return { clientId, mutationId, generation };
  return { legacy: true, mutationId };
}

function normalizeDailyBriefFence(value) {
  if (!value || typeof value !== 'object' || !value.enforced) return null;
  const byClient = Object.fromEntries(Object.entries(value.byClient || {})
    .filter(([clientId, sequence]) => clientId && Number.isSafeInteger(Number(sequence)) && Number(sequence) >= 1)
    .map(([clientId, sequence]) => [clientId, Number(sequence)]));
  const lastGeneration = String(value.lastGeneration || '').trim();
  return { enforced: true, byClient, lastGeneration };
}
function staleDailyBriefFenceError(brief) {
  const error = new Error('daily_brief_stale_sequence');
  error.code = 'daily_brief_stale_sequence';
  error.status = 409;
  error.brief = brief;
  return error;
}

function upsertDailyBrief(reviewDate, patch = {}) {
  const existing = db.prepare('SELECT * FROM hq_daily_briefs WHERE review_date=?').get(reviewDate);
  const current = rowToDailyBrief(existing) || {};
  const referencedTaskIds = [
    patch.primaryTaskId,
    patch.strategicCommitmentTaskId,
    patch.currentActionTaskId,
    ...(Array.isArray(patch.maintenanceTaskIds) ? patch.maintenanceTaskIds : []),
  ].filter(Boolean);
  const missingTaskId = referencedTaskIds.find((taskId) => !db.prepare('SELECT 1 FROM tasks WHERE id=?').get(taskId));
  if (missingTaskId) throw proposalError('daily_brief_task_not_found', 409, { taskId: missingTaskId });
  const incomingMutation = normalizeDailyBriefMutationMetadata(patch._syncMutation);
  const storedFence = normalizeDailyBriefFence(current._syncFence);
  const hasMutationPayload = Object.keys(patch).some((key) => key !== '_syncMutation');
  if (storedFence && hasMutationPayload) {
    const staleClientSequence = Number.isSafeInteger(incomingMutation?.sequence)
      && incomingMutation.sequence <= (storedFence.byClient[incomingMutation.clientId] || 0);
    const staleGeneration = incomingMutation?.generation && storedFence.lastGeneration
      && incomingMutation.generation <= storedFence.lastGeneration;
    if (!incomingMutation || incomingMutation.legacy || staleClientSequence || staleGeneration) {
      return current;
    }
  }
  let nextFence = storedFence;
  if (incomingMutation && !incomingMutation.legacy) {
    const byClient = { ...(storedFence?.byClient || {}) };
    if (Number.isSafeInteger(incomingMutation.sequence) && incomingMutation.sequence >= 1) {
      byClient[incomingMutation.clientId] = incomingMutation.sequence;
    }
    const lastGeneration = incomingMutation.generation && incomingMutation.generation > (storedFence?.lastGeneration || '')
      ? incomingMutation.generation
      : (storedFence?.lastGeneration || '');
    nextFence = { enforced: true, byClient, lastGeneration };
  }
const existingStrategicCommitmentTaskId = current.strategicCommitmentTaskId || current.primaryTaskId || null;
  // P0 compatibility contract: an explicit primaryTaskId:null is the
  // authoritative full clear, regardless of which P1 companion fields are
  // present in the same patch. A standalone currentActionTaskId:null only
  // vacates the action seat and preserves the original commitment.
  const clearsStrategicCommitment = Object.hasOwn(patch, 'primaryTaskId')
    && patch.primaryTaskId === null;
  const assignsLegacyPrimary = Object.hasOwn(patch, 'primaryTaskId')
    && Boolean(patch.primaryTaskId)
    && !Object.hasOwn(patch, 'strategicCommitmentTaskId')
    && !Object.hasOwn(patch, 'currentActionTaskId');
  let strategicCommitmentTaskId = existingStrategicCommitmentTaskId;
  if (clearsStrategicCommitment) strategicCommitmentTaskId = null;
  else if (!existingStrategicCommitmentTaskId && Object.hasOwn(patch, 'strategicCommitmentTaskId')) strategicCommitmentTaskId = patch.strategicCommitmentTaskId || null;
  else if (!existingStrategicCommitmentTaskId && Object.hasOwn(patch, 'primaryTaskId')) strategicCommitmentTaskId = patch.primaryTaskId || null;

  const requestedSnapshot = patch.strategicCommitmentSnapshot && typeof patch.strategicCommitmentSnapshot === 'object'
    ? patch.strategicCommitmentSnapshot
    : null;
  const strategicTask = strategicCommitmentTaskId
    ? rowToTask(db.prepare('SELECT * FROM tasks WHERE id=?').get(strategicCommitmentTaskId))
    : null;
  const strategicCommitmentSnapshot = clearsStrategicCommitment
    ? null
    : current.strategicCommitmentSnapshot || (strategicCommitmentTaskId
      ? {
        taskId: strategicCommitmentTaskId,
        content: String(requestedSnapshot?.content || strategicTask?.content || ''),
        committedAt: requestedSnapshot?.committedAt || now(),
      }
      : null);

  let currentActionTaskId = Object.hasOwn(current, 'currentActionTaskId')
    ? (current.currentActionTaskId || null)
    : strategicCommitmentTaskId;
  if (clearsStrategicCommitment) currentActionTaskId = null;
  else if (assignsLegacyPrimary && !existingStrategicCommitmentTaskId) currentActionTaskId = patch.primaryTaskId;
  else if (Object.hasOwn(patch, 'currentActionTaskId')) currentActionTaskId = patch.currentActionTaskId || null;
  const next = {
    ...current,
    ...patch,
    reviewDate,
    _syncFence: nextFence || undefined,
    primaryTaskId: strategicCommitmentTaskId,
    strategicCommitmentTaskId,
    strategicCommitmentSnapshot,
    currentActionTaskId,
    maintenanceTaskIds: Array.isArray(patch.maintenanceTaskIds)
      ? [...new Set(patch.maintenanceTaskIds.filter(Boolean))].slice(0, 2)
      : (current.maintenanceTaskIds || []),
    stopDoing: Array.isArray(patch.stopDoing) ? patch.stopDoing.filter(Boolean) : (current.stopDoing || []),
    continueDoing: Array.isArray(patch.continueDoing) ? patch.continueDoing.filter(Boolean) : (current.continueDoing || []),
    outcomes: patch.outcomes && typeof patch.outcomes === 'object' ? patch.outcomes : (current.outcomes || {}),
    yesterdayClosure: patch.yesterdayClosure && typeof patch.yesterdayClosure === 'object'
      ? patch.yesterdayClosure
      : (current.yesterdayClosure || {}),
    notes: String(patch.notes ?? current.notes ?? ''),
    source: String(patch.source || current.source || 'hq'),
    updatedAt: now(),
  };
  db.prepare(`
    INSERT INTO hq_daily_briefs (
      review_date, primary_task_id, maintenance_task_ids_json, stop_doing_json,
      continue_doing_json, outcomes_json, yesterday_closure_json, notes, source, raw_json, updated_at
    )
    VALUES (
      @review_date, @primary_task_id, @maintenance_task_ids_json, @stop_doing_json,
      @continue_doing_json, @outcomes_json, @yesterday_closure_json, @notes, @source, @raw_json, @updated_at
    )
    ON CONFLICT(review_date) DO UPDATE SET
      primary_task_id=excluded.primary_task_id,
      maintenance_task_ids_json=excluded.maintenance_task_ids_json,
      stop_doing_json=excluded.stop_doing_json,
      continue_doing_json=excluded.continue_doing_json,
      outcomes_json=excluded.outcomes_json,
      yesterday_closure_json=excluded.yesterday_closure_json,
      notes=excluded.notes,
      source=excluded.source,
      raw_json=excluded.raw_json,
      updated_at=excluded.updated_at
  `).run({
    review_date: reviewDate,
    primary_task_id: next.primaryTaskId,
    maintenance_task_ids_json: json(next.maintenanceTaskIds),
    stop_doing_json: json(next.stopDoing),
    continue_doing_json: json(next.continueDoing),
    outcomes_json: json(next.outcomes),
    yesterday_closure_json: json(next.yesterdayClosure),
    notes: next.notes,
    source: next.source,
    raw_json: json(next),
    updated_at: next.updatedAt,
  });
  return rowToDailyBrief(db.prepare('SELECT * FROM hq_daily_briefs WHERE review_date=?').get(reviewDate));
}

function insertProposalTask(proposal) {
  if (proposal.existingTaskId) {
    const existing = rowToTask(db.prepare('SELECT * FROM tasks WHERE id=?').get(proposal.existingTaskId));
    if (!existing) throw proposalError('existing_task_not_found', 409);
    return existing;
  }
  const taskSpec = proposal.taskSpec && typeof proposal.taskSpec === 'object' ? proposal.taskSpec : {};
  const content = String(taskSpec.content || proposal.title || '').trim();
  if (!content) throw proposalError('task_content_required', 409);
  const fallbackBox = db.prepare(`
    SELECT * FROM boxes
    ORDER BY CASE WHEN color='important' OR name='重要盒' THEN 0 ELSE 1 END, sort_order, created_at
    LIMIT 1
  `).get();
  const requestedBoxId = taskSpec.boxId || fallbackBox?.id || null;
  if (requestedBoxId && !db.prepare('SELECT 1 FROM boxes WHERE id=?').get(requestedBoxId)) {
    throw proposalError('box_not_found', 409);
  }
  if (taskSpec.branchId && !db.prepare('SELECT 1 FROM branches WHERE id=?').get(taskSpec.branchId)) {
    throw proposalError('branch_not_found', 409);
  }
  const timestamp = now();
  const task = normalizeTaskCompletionTransition(null, {
    ...taskSpec,
    id: taskSpec.id || uid(),
    boxId: requestedBoxId,
    content,
    role: undefined,
    commitmentRole: taskSpec.role || taskSpec.commitmentRole || null,
    commitmentSource: 'hq_proposal',
    pinLevel: Number(taskSpec.pinLevel || (taskSpec.role === 'primary' ? 1 : taskSpec.role === 'maintenance' ? 2 : 0)),
    pinned: ['primary', 'maintenance'].includes(taskSpec.role || taskSpec.commitmentRole),
    syncKey: taskSpec.syncKey || `hq-proposal:${proposal.decisionId}`,
    proposalDecisionId: proposal.decisionId,
    proposalRevision: proposal.revision,
    isCompleted: false,
    createdAt: taskSpec.createdAt || timestamp,
    updatedAt: timestamp,
  }, timestamp);
  const bySyncKey = db.prepare('SELECT * FROM tasks WHERE sync_key=?').get(task.syncKey);
  if (bySyncKey) return rowToTask(bySyncKey);
  db.prepare(`
    INSERT INTO tasks (id, box_id, content, is_completed, sort_order, priority, weight, points_value, progress,
      is_recurring_template, recurrence_template_id, recurrence_key, recurrence_json, next_run_at, occurrence_status,
      mainline_id, branch_id, milestone_id, device_context, execution_mode, visible_after, deferred_at, defer_note, progress_logs_json,
      scheduled_at, due_date, deleted, deleted_at, note, sync_key, completed_at, created_at, updated_at, raw_json)
    VALUES (@id, @box_id, @content, @is_completed, @sort_order, @priority, @weight, @points_value, @progress,
      @is_recurring_template, @recurrence_template_id, @recurrence_key, @recurrence_json, @next_run_at, @occurrence_status,
      @mainline_id, @branch_id, @milestone_id, @device_context, @execution_mode, @visible_after, @deferred_at, @defer_note, @progress_logs_json,
      @scheduled_at, @due_date, @deleted, @deleted_at, @note, @sync_key, @completed_at, @created_at, @updated_at, @raw_json)
  `).run(taskParams(task));
  return rowToTask(db.prepare('SELECT * FROM tasks WHERE id=?').get(task.id));
}

function promoteProposal(decisionId, input = {}) {
  const current = getProposalOrThrow(decisionId);
  if (current.status === 'promoted' && current.taskId) return current;
  if (process.env.HQ_PROPOSAL_PROMOTION_ENABLED !== '1') {
    throw proposalError('proposal_promotion_disabled', 409);
  }
  if (current.proposalType !== 'daily_action_proposal') {
    throw proposalError('strategic_proposal_cannot_promote_to_task', 409);
  }
  if (current.status !== 'approved') throw proposalError('proposal_not_approved', 409);
  if (input.shadowMode !== false && current.shadowMode !== false) {
    throw proposalError('shadow_mode_requires_explicit_disable', 409);
  }
  const actor = String(input.actor || 'hq').trim() || 'hq';
  return db.transaction(() => {
    const task = insertProposalTask(current);
    const timestamp = now();
    const proposal = saveProposal({
      ...current,
      status: 'promoted',
      taskId: task.id,
      decisionNote: String(input.note || current.decisionNote || ''),
      decidedAt: current.decidedAt || timestamp,
      promotedAt: timestamp,
      updatedAt: timestamp,
    });
    const taskSpec = proposal.taskSpec || {};
    const commitmentDate = validDateKey(taskSpec.commitmentDate);
    if (commitmentDate && taskSpec.role === 'primary') {
      upsertDailyBrief(commitmentDate, {
        primaryTaskId: task.id,
        source: 'hq_proposal',
        actionProposalIds: [proposal.decisionId],
      });
    } else if (commitmentDate && taskSpec.role === 'maintenance') {
      const brief = rowToDailyBrief(db.prepare('SELECT * FROM hq_daily_briefs WHERE review_date=?').get(commitmentDate));
      upsertDailyBrief(commitmentDate, {
        maintenanceTaskIds: [...(brief?.maintenanceTaskIds || []), task.id],
        source: 'hq_proposal',
        actionProposalIds: [...new Set([...(brief?.actionProposalIds || []), proposal.decisionId])],
      });
    }
    recordProposalEvent(proposal, 'promote', actor, input.note, { taskId: task.id, linkedExisting: Boolean(current.existingTaskId) });
    return proposal;
  })();
}

function isOpenActionTask(task, mainlines = null) {
  if (!task || task.deleted || task.isCompleted || task.isRecurringTemplate) return false;
  const visibleAfter = task.visibleAfter ? new Date(task.visibleAfter).getTime() : 0;
  if (Number.isFinite(visibleAfter) && visibleAfter > Date.now()) return false;
  if (!task.mainlineId || !Array.isArray(mainlines)) return true;
  const mainline = mainlines.find((item) => item.id === task.mainlineId);
  return Boolean(mainline && ['active', 'maintenance'].includes(mainline.status));
}

function selectCommitmentTasks(tasks, brief, reviewDate, mainlines = null) {
  const open = tasks.filter((task) => isOpenActionTask(task, mainlines));
  const byId = new Map(open.map((task) => [task.id, task]));
  const strategicCommitmentTaskId = brief?.strategicCommitmentTaskId || brief?.primaryTaskId || null;
  const currentActionTaskId = Object.hasOwn(brief || {}, 'currentActionTaskId')
    ? (brief.currentActionTaskId || null)
    : strategicCommitmentTaskId;
  const primary = byId.get(currentActionTaskId)
    || (!strategicCommitmentTaskId
      ? open.find((task) => task.commitmentDate === reviewDate && task.commitmentRole === 'primary')
        || open.find((task) => Number(task.pinLevel) === 1)
      : null)
    || null;
  const maintenance = (brief?.maintenanceTaskIds || []).map((id) => byId.get(id)).filter(Boolean);
  [
    ...open.filter((task) => task.commitmentDate === reviewDate && task.commitmentRole === 'maintenance'),
    ...open.filter((task) => [2, 3].includes(Number(task.pinLevel))),
  ].forEach((task) => {
    if (task.id !== primary?.id && !maintenance.some((item) => item.id === task.id) && maintenance.length < 2) {
      maintenance.push(task);
    }
  });
  return { primary, maintenance };
}

function buildHqActionState(tasks, brief, reviewDate, commitments, mainlines = null) {
  const visible = tasks.filter((task) => task?.id && !task.deleted && !task.isRecurringTemplate);
  const byId = new Map(visible.map((task) => [task.id, task]));
  const strategicCommitmentTaskId = brief?.strategicCommitmentTaskId || brief?.primaryTaskId || commitments.primary?.id || null;
  const currentActionTaskId = Object.hasOwn(brief || {}, 'currentActionTaskId')
    ? (brief.currentActionTaskId || null)
    : strategicCommitmentTaskId;
  const strategicTask = byId.get(strategicCommitmentTaskId) || null;
  const commitmentSnapshot = brief?.strategicCommitmentSnapshot && typeof brief.strategicCommitmentSnapshot === 'object'
    ? brief.strategicCommitmentSnapshot
    : null;
  const strategicCommitment = strategicTask
    ? { ...strategicTask, content: commitmentSnapshot?.content || strategicTask.content }
    : commitmentSnapshot
      ? {
        id: commitmentSnapshot.taskId || strategicCommitmentTaskId,
        content: commitmentSnapshot.content || '原始承诺任务记录暂不可用',
        committedAt: commitmentSnapshot.committedAt || null,
        unavailable: true,
      }
      : null;
  const currentCandidate = byId.get(currentActionTaskId) || commitments.primary || null;
  const currentAction = isOpenActionTask(currentCandidate, mainlines)
    ? currentCandidate
    : null;
  const outcomes = visible
    .filter((task) => task.isCompleted && dateKeyInReviewTimezone(task.completedAt || task.completionReceipt?.completedAt) === reviewDate)
    .sort((left, right) => new Date(right.completedAt || right.updatedAt || 0) - new Date(left.completedAt || left.updatedAt || 0))
    .map((task) => ({ ...task, isStrategicCommitment: task.id === strategicCommitmentTaskId }));
  return {
    status: currentAction
      ? 'active'
      : strategicCommitment?.isCompleted
        ? 'awaiting_candidate'
        : strategicCommitment
          ? 'seat_empty'
          : 'uncommitted',
    strategicCommitment,
    currentAction,
    outcomes,
  };
}

function buildProjectHealth(mainlines, tasks) {
  const reference = Date.now();
  return mainlines
    .filter((mainline) => ['active', 'maintenance'].includes(mainline.status))
    .map((mainline) => {
      const projectTasks = tasks.filter((task) => task.mainlineId === mainline.id && !task.deleted && !task.isRecurringTemplate);
      const openTasks = projectTasks.filter((task) => !task.isCompleted);
      const lastProgressAt = [mainline.updatedAt, ...projectTasks.map((task) => task.updatedAt || task.completedAt)]
        .filter(Boolean)
        .sort((left, right) => new Date(right) - new Date(left))[0] || mainline.createdAt;
      const staleDays = lastProgressAt
        ? Math.max(0, Math.floor((reference - new Date(lastProgressAt).getTime()) / 86400000))
        : 0;
      const nextAction = openTasks
        .sort((left, right) => new Date(left.dueDate || left.scheduledAt || left.createdAt) - new Date(right.dueDate || right.scheduledAt || right.createdAt))[0] || null;
      const health = mainline.blocker ? 'blocked' : (!nextAction ? 'needs_action' : (staleDays >= 7 ? 'stale' : 'healthy'));
      return {
        ...mainline,
        nextAction,
        openTaskCount: openTasks.length,
        completedTaskCount: projectTasks.length - openTasks.length,
        lastProgressAt,
        staleDays,
        health,
      };
    });
}

function shiftDateKey(dateKey, offset) {
  const date = new Date(`${dateKey}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

function taskTouchesDate(task, reviewDate) {
  return [
    task.scheduledAt,
    task.dueDate,
    task.completedAt,
    task.createdAt,
    task.updatedAt,
    ...(task.progressLogs || []).map((log) => log.at || log.updatedAt),
  ].some((value) => dateKeyInReviewTimezone(value) === reviewDate);
}

function validPeriodType(value) {
  return ['week', 'month'].includes(value) ? value : null;
}

function buildPeriodInfo(periodType, dateKey) {
  if (periodType === 'month') {
    const [year, month] = dateKey.split('-').map(Number);
    const endDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const monthKey = `${year}-${String(month).padStart(2, '0')}`;
    return {
      periodType,
      periodKey: monthKey,
      startDate: `${monthKey}-01`,
      endDate: `${monthKey}-${String(endDay).padStart(2, '0')}`,
    };
  }
  const date = new Date(`${dateKey}T12:00:00Z`);
  const day = date.getUTCDay();
  const startDate = shiftDateKey(dateKey, day === 0 ? -6 : 1 - day);
  const endDate = shiftDateKey(startDate, 6);
  return { periodType, periodKey: `${startDate}_to_${endDate}`, startDate, endDate };
}

function shiftPeriodAnchor(periodType, dateKey, offset) {
  if (!offset) return dateKey;
  if (periodType === 'week') return shiftDateKey(dateKey, offset * 7);
  const date = new Date(`${dateKey}T12:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + offset);
  return date.toISOString().slice(0, 10);
}

function resolvePeriodInfo(periodType, periodKey, patch = {}) {
  const startDate = validDateKey(patch.startDate);
  const endDate = validDateKey(patch.endDate);
  if (startDate && endDate && startDate <= endDate) {
    return { periodType, periodKey, startDate, endDate };
  }
  if (periodType === 'month' && /^\d{4}-\d{2}$/.test(periodKey)) {
    return buildPeriodInfo(periodType, `${periodKey}-15`);
  }
  const match = /^(\d{4}-\d{2}-\d{2})_to_(\d{4}-\d{2}-\d{2})$/.exec(periodKey);
  if (periodType === 'week' && match) {
    return { periodType, periodKey, startDate: match[1], endDate: match[2] };
  }
  return null;
}

function emptyPeriodReview(info) {
  return {
    ...info,
    status: 'draft',
    verdict: '',
    previousCommitments: [],
    metrics: {},
    bottleneck: {},
    experiment: {},
    resources: [],
    startStopContinue: { start: [], stop: [], continue: [] },
    scoreboard: [],
    portfolio: [],
    strategicDecisions: [],
    goals: [],
    notDoing: [],
    artifacts: {},
    source: 'derived',
    completedAt: null,
    updatedAt: null,
  };
}

function buildPeriodDerived(info, tasks, projects) {
  const briefs = db.prepare(`
    SELECT * FROM hq_daily_briefs
    WHERE review_date BETWEEN ? AND ?
    ORDER BY review_date
  `).all(info.startDate, info.endDate).map(rowToDailyBrief);
  const outcomeKeys = ['published', 'conversations', 'quotes', 'deals', 'feedback'];
  const outcomes = Object.fromEntries(outcomeKeys.map((key) => {
    const recorded = briefs.map((brief) => brief.outcomes?.[key]).filter((value) => value !== null && value !== undefined && value !== '');
    return [key, { value: recorded.reduce((sum, value) => sum + (Number(value) || 0), 0), recordedDays: recorded.length }];
  }));
  const closureStates = briefs.map((brief) => brief.yesterdayClosure?.result).filter(Boolean);
  const knownClosures = closureStates.filter((result) => ['完成', '部分完成', '未完成'].includes(result));
  const completedClosures = knownClosures.filter((result) => result === '完成').length;
  const touchesRange = (task) => [
    task.scheduledAt,
    task.dueDate,
    task.completedAt,
    task.createdAt,
    task.updatedAt,
    ...(task.progressLogs || []).map((log) => log.at || log.updatedAt),
  ].some((value) => {
    const date = dateKeyInReviewTimezone(value);
    return date >= info.startDate && date <= info.endDate;
  });
  const periodTasks = tasks.filter((task) => !task.deleted && !task.isRecurringTemplate && touchesRange(task));
  return {
    dailyReviewCount: briefs.filter((brief) => brief.reviewCompletedAt).length,
    dailyBriefCount: briefs.length,
    evidenceDays: briefs.filter((brief) => outcomeKeys.some((key) => brief.outcomes?.[key] !== null && brief.outcomes?.[key] !== undefined)).length,
    outcomes,
    commitments: {
      known: knownClosures.length,
      completed: completedClosures,
      rate: knownClosures.length ? Math.round((completedClosures / knownClosures.length) * 100) : null,
    },
    tasks: {
      touched: periodTasks.length,
      completed: periodTasks.filter((task) => {
        const completedDate = dateKeyInReviewTimezone(task.completedAt);
        return task.isCompleted && completedDate >= info.startDate && completedDate <= info.endDate;
      }).length,
    },
    projectRisks: projects.filter((project) => ['blocked', 'stale', 'needs_action'].includes(project.health)),
  };
}

function buildPeriodSnapshot(periodType, dateKey, periodKey = null) {
  const info = periodKey
    ? resolvePeriodInfo(periodType, periodKey)
    : buildPeriodInfo(periodType, dateKey);
  if (!info) return null;
  const stored = rowToPeriodReview(db.prepare(`
    SELECT * FROM hq_period_reviews WHERE period_type=? AND period_key=?
  `).get(periodType, info.periodKey));
  const tasks = db.prepare('SELECT * FROM tasks ORDER BY sort_order, created_at').all().map(rowToTask);
  const mainlines = db.prepare('SELECT * FROM mainlines ORDER BY sort_order, created_at').all().map(rowToMainline);
  const projects = buildProjectHealth(mainlines, tasks);
  const decisions = db.prepare("SELECT * FROM hq_decisions WHERE status='open' ORDER BY updated_at DESC").all().map(rowToDecision);
  return {
    ...info,
    review: { ...emptyPeriodReview(info), ...(stored || {}) },
    derived: buildPeriodDerived(info, tasks, projects),
    projects,
    decisions,
    generatedAt: now(),
  };
}

function upsertPeriodReview(periodType, periodKey, patch = {}) {
  const info = resolvePeriodInfo(periodType, periodKey, patch);
  if (!info) return null;
  const existing = db.prepare('SELECT * FROM hq_period_reviews WHERE period_type=? AND period_key=?').get(periodType, periodKey);
  const current = rowToPeriodReview(existing) || emptyPeriodReview(info);
  const next = {
    ...current,
    ...patch,
    ...info,
    status: ['draft', 'completed', 'synced'].includes(patch.status) ? patch.status : (current.status || 'draft'),
    verdict: String(patch.verdict ?? current.verdict ?? ''),
    source: String(patch.source || current.source || 'hq'),
    completedAt: patch.completedAt ?? current.completedAt ?? null,
    updatedAt: now(),
  };
  db.prepare(`
    INSERT INTO hq_period_reviews (
      period_type, period_key, start_date, end_date, status, verdict, source,
      completed_at, raw_json, updated_at
    ) VALUES (
      @period_type, @period_key, @start_date, @end_date, @status, @verdict, @source,
      @completed_at, @raw_json, @updated_at
    )
    ON CONFLICT(period_type, period_key) DO UPDATE SET
      start_date=excluded.start_date,
      end_date=excluded.end_date,
      status=excluded.status,
      verdict=excluded.verdict,
      source=excluded.source,
      completed_at=excluded.completed_at,
      raw_json=excluded.raw_json,
      updated_at=excluded.updated_at
  `).run({
    period_type: periodType,
    period_key: periodKey,
    start_date: info.startDate,
    end_date: info.endDate,
    status: next.status,
    verdict: next.verdict,
    source: next.source,
    completed_at: next.completedAt,
    raw_json: json(next),
    updated_at: next.updatedAt,
  });
  return rowToPeriodReview(db.prepare('SELECT * FROM hq_period_reviews WHERE period_type=? AND period_key=?').get(periodType, periodKey));
}

function buildReviewStatus(reviewDate, tasks = [], requestedDays = 7) {
  const days = Math.max(3, Math.min(31, Number(requestedDays) || 7));
  const dates = Array.from({ length: days }, (_, index) => shiftDateKey(reviewDate, index - days + 1));
  const oldest = dates[0];
  const briefs = db.prepare(`
    SELECT * FROM hq_daily_briefs
    WHERE review_date BETWEEN ? AND ?
    ORDER BY review_date
  `).all(oldest, reviewDate).map(rowToDailyBrief);
  const byDate = new Map(briefs.map((brief) => [brief.reviewDate, brief]));
  const resultState = (result) => {
    if (result === '完成') return 'completed';
    if (result === '部分完成') return 'partial';
    if (result === '未完成') return 'missed';
    if (result === '无法判断') return 'unknown';
    return 'empty';
  };
  const history = dates.map((date) => {
    const brief = byDate.get(date);
    const result = brief?.yesterdayClosure?.result || '';
    return {
      date,
      result,
      state: resultState(result),
      reviewCompletedAt: brief?.reviewCompletedAt || null,
      synced: Boolean(brief?.reviewCompletedAt),
    };
  });
  const known = history.filter((item) => ['completed', 'partial', 'missed'].includes(item.state));
  const completedCount = known.filter((item) => item.state === 'completed').length;
  const latestReview = [...briefs]
    .filter((brief) => brief.reviewCompletedAt)
    .sort((left, right) => new Date(right.reviewCompletedAt) - new Date(left.reviewCompletedAt))[0] || null;
  const todayBrief = byDate.get(reviewDate) || null;
  const touched = tasks.filter((task) => !task.deleted && !task.isRecurringTemplate && taskTouchesDate(task, reviewDate));
  return {
    status: todayBrief?.reviewCompletedAt ? 'synced' : 'pending',
    reviewDate,
    latestReviewDate: latestReview?.reviewDate || null,
    latestReviewAt: latestReview?.reviewCompletedAt || null,
    artifacts: latestReview?.reviewArtifacts || {},
    history,
    knownCount: known.length,
    completedCount,
    completionRate: known.length ? Math.round((completedCount / known.length) * 100) : null,
    todayEvidence: {
      touched: touched.length,
      completed: touched.filter((task) => task.isCompleted && dateKeyInReviewTimezone(task.completedAt) === reviewDate).length,
      progress: touched.filter((task) => (task.progressLogs || []).some((log) => dateKeyInReviewTimezone(log.at || log.updatedAt) === reviewDate)).length,
    },
  };
}

function buildHqSnapshot(reviewDate) {
  let brief = rowToDailyBrief(db.prepare('SELECT * FROM hq_daily_briefs WHERE review_date=?').get(reviewDate));
  if (brief && (brief.strategicCommitmentTaskId || brief.primaryTaskId) && !brief.strategicCommitmentSnapshot) {
    brief = upsertDailyBrief(reviewDate, {});
  }
  const tasks = db.prepare('SELECT * FROM tasks ORDER BY sort_order, created_at').all().map(rowToTask);
  const mainlines = db.prepare('SELECT * FROM mainlines ORDER BY sort_order, created_at').all().map(rowToMainline);
  const decisions = db.prepare("SELECT * FROM hq_decisions WHERE status='open' ORDER BY CASE urgency WHEN 'high' THEN 0 ELSE 1 END, updated_at DESC")
    .all()
    .map(rowToDecision);
  const proposals = db.prepare(`
    SELECT * FROM hq_proposals
    WHERE status IN ('proposed', 'approved', 'deferred', 'rejected')
    ORDER BY CASE status WHEN 'proposed' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, updated_at DESC
    LIMIT 50
  `).all().map(rowToProposal);
  const commitments = selectCommitmentTasks(tasks, brief, reviewDate, mainlines);
  const aiTasks = tasks.filter((task) => !task.deleted && !task.isCompleted && task.executionMode === 'ai');
  return {
    reviewDate,
    brief: brief || {
      reviewDate,
      primaryTaskId: commitments.primary?.id || null,
      maintenanceTaskIds: commitments.maintenance.map((task) => task.id),
      stopDoing: [],
      continueDoing: [],
      outcomes: {},
      yesterdayClosure: {},
      notes: '',
      source: 'derived',
    },
    commitments,
    actionState: buildHqActionState(tasks, brief, reviewDate, commitments, mainlines),
    projects: buildProjectHealth(mainlines, tasks),
    decisions,
    proposals,
    proposalSummary: {
      total: proposals.filter((item) => item.status !== 'rejected').length,
      proposed: proposals.filter((item) => item.status === 'proposed').length,
      approved: proposals.filter((item) => item.status === 'approved').length,
      deferred: proposals.filter((item) => item.status === 'deferred').length,
      rejected: proposals.filter((item) => item.status === 'rejected').length,
      daily: proposals.filter((item) => item.status !== 'rejected' && item.proposalType === 'daily_action_proposal').length,
      weekly: proposals.filter((item) => item.status !== 'rejected' && item.proposalType === 'weekly_experiment_proposal').length,
      monthly: proposals.filter((item) => item.status !== 'rejected' && item.proposalType === 'monthly_bet_proposal').length,
    },
    review: buildReviewStatus(reviewDate, tasks, 7),
    ai: {
      open: aiTasks.length,
      needsInput: aiTasks.filter((task) => task.executionState === 'needs_input').length,
      needsReview: aiTasks.filter((task) => task.executionState === 'needs_review').length,
    },
    generatedAt: now(),
  };
}

app.get('/health', (req, res) => {
  res.json({ ok: true, db: path.basename(dbPath), time: now() });
});

installHealthSystemRoutes({ app, db, now, json, parseJson, authorizeDailyIntake });
installMissionSystemRoutes({ app, db, now, json, parseJson, authorizeDailyIntake });
installExecutionSystemRoutes({
  app, db, now, json, parseJson, uid, rowToTask, taskParams, normalizeTaskCompletionTransition,
});

app.get('/v1/taskbox', (req, res) => {
  const boxes = db.prepare('SELECT * FROM boxes ORDER BY sort_order, name').all().map(rowToBox);
  const tasks = db.prepare('SELECT * FROM tasks ORDER BY sort_order, created_at').all().map(rowToTask);
  const mainlines = db.prepare('SELECT * FROM mainlines ORDER BY sort_order, created_at').all().map(rowToMainline);
  const branches = db.prepare('SELECT * FROM branches ORDER BY mainline_id, sort_order, created_at').all().map(rowToBranch);
  const milestones = db.prepare('SELECT * FROM milestones ORDER BY mainline_id, sort_order, created_at').all().map(rowToMilestone);
  const usageLogs = db.prepare('SELECT * FROM usage_logs ORDER BY used_at DESC LIMIT 2000').all().map(rowToUsageLog);
  const settings = getMeta('taskbox_settings', {});
  const dailyQuote = getDailyQuote();
  res.json({
    boxes,
    tasks,
    mainlines,
    branches,
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

const HQ_RECEIPT_SYSTEMS = new Set(['mission', 'health', 'attention', 'execution', 'feedback']);
const HQ_RECEIPT_FIELDS = ['systemId', 'receiptId', 'intakeRef', 'effectiveDate', 'generatedAt', 'freshness', 'status', 'riskLevel', 'needsUserInput', 'inputGaps', 'factRefs', 'evidenceRefs', 'syncState', 'revision'];
const safeReceiptText = (value, max = 240) => String(value || '').trim().slice(0, max);
const safeReceiptList = (value, maxItems = 40) => (Array.isArray(value) ? value : [])
  .map((item) => safeReceiptText(item, 500)).filter(Boolean).slice(0, maxItems);

function readHqDailyIntakeReceipts(reviewDate) {
  try {
    if (!hqDailyIntakeCacheFile || fs.statSync(hqDailyIntakeCacheFile).size > 1024 * 1024) return [];
    const cache = parseJson(fs.readFileSync(hqDailyIntakeCacheFile, 'utf8'), null);
    if (!cache || !Array.isArray(cache.receipts)) return [];
    return cache.receipts.map((item) => {
      const projection = item?.projection && typeof item.projection === 'object' ? item.projection : {};
      const effectiveDate = validDateKey(item?.effectiveDate || item?.reviewDate);
      if (!HQ_RECEIPT_SYSTEMS.has(safeReceiptText(item?.systemId, 80)) || effectiveDate !== reviewDate) return null;
      const receipt = {
        systemId: safeReceiptText(item.systemId, 80),
        receiptId: safeReceiptText(item.receiptId || item.id, 240),
        intakeRef: safeReceiptText(item.intakeRef || item.intakeId, 240),
        effectiveDate,
        generatedAt: safeReceiptText(item.generatedAt || item.updatedAt, 80),
        freshness: typeof item.freshness === 'object' ? { status: safeReceiptText(item.freshness?.status, 40) } : safeReceiptText(item.freshness, 40),
        status: safeReceiptText(item.status, 80) || 'unknown',
        riskLevel: safeReceiptText(item.riskLevel || projection.riskLevel, 80),
        needsUserInput: item.needsUserInput === true || projection.needsUserInput === true,
        inputGaps: safeReceiptList(item.inputGaps || projection.inputGaps),
        factRefs: safeReceiptList(item.factRefs || projection.factRefs),
        evidenceRefs: safeReceiptList(item.evidenceRefs || projection.evidenceRefs),
        syncState: safeReceiptText(item.syncState || projection.syncState, 80),
        revision: Math.max(1, Number(item.revision) || 1),
      };
      return Object.fromEntries(HQ_RECEIPT_FIELDS.filter((key) => receipt[key] !== undefined).map((key) => [key, receipt[key]]));
    }).filter(Boolean);
  } catch {
    return [];
  }
}

app.get('/v1/hq/today', (req, res) => {
  const reviewDate = validDateKey(req.query.date) || todayKey();
  res.json({ ...buildHqSnapshot(reviewDate), systemReceipts: readHqDailyIntakeReceipts(reviewDate) });
});

app.get('/v1/hq/review-status', (req, res) => {
  const reviewDate = validDateKey(req.query.date) || todayKey();
  const tasks = db.prepare('SELECT * FROM tasks ORDER BY sort_order, created_at').all().map(rowToTask);
  res.json(buildReviewStatus(reviewDate, tasks, req.query.days));
});

app.get('/v1/hq/periods', (req, res) => {
  const periodType = validPeriodType(req.query.type);
  if (!periodType) return res.status(400).json({ error: 'invalid_period_type' });
  const limit = Math.max(1, Math.min(36, Number(req.query.limit) || 12));
  const rows = db.prepare(`
    SELECT * FROM hq_period_reviews
    WHERE period_type=?
    ORDER BY start_date DESC
    LIMIT ?
  `).all(periodType, limit).map(rowToPeriodReview);
  return res.json(rows);
});

app.get('/v1/hq/periods/:type/current', (req, res) => {
  const periodType = validPeriodType(req.params.type);
  const reviewDate = validDateKey(req.query.date) || todayKey();
  if (!periodType) return res.status(400).json({ error: 'invalid_period_type' });
  const offset = Math.max(-24, Math.min(0, Number(req.query.offset) || 0));
  return res.json(buildPeriodSnapshot(periodType, shiftPeriodAnchor(periodType, reviewDate, offset)));
});

app.get('/v1/hq/periods/:type/:key', (req, res) => {
  const periodType = validPeriodType(req.params.type);
  if (!periodType) return res.status(400).json({ error: 'invalid_period_type' });
  const snapshot = buildPeriodSnapshot(periodType, todayKey(), req.params.key);
  if (!snapshot) return res.status(400).json({ error: 'invalid_period_key' });
  return res.json(snapshot);
});

app.post('/v1/hq/periods/:type/:key', (req, res) => {
  const periodType = validPeriodType(req.params.type);
  if (!periodType) return res.status(400).json({ error: 'invalid_period_type' });
  const review = upsertPeriodReview(periodType, req.params.key, req.body || {});
  if (!review) return res.status(400).json({ error: 'invalid_period_range' });
  return res.json(review);
});

app.delete('/v1/hq/periods/:type/:key', (req, res) => {
  const periodType = validPeriodType(req.params.type);
  if (!periodType) return res.status(400).json({ error: 'invalid_period_type' });
  db.prepare('DELETE FROM hq_period_reviews WHERE period_type=? AND period_key=?').run(periodType, req.params.key);
  return res.status(204).end();
});

app.get('/v1/hq/daily-briefs/:date', (req, res) => {
  const reviewDate = validDateKey(req.params.date);
  if (!reviewDate) return res.status(400).json({ error: 'invalid_date' });
  const brief = rowToDailyBrief(db.prepare('SELECT * FROM hq_daily_briefs WHERE review_date=?').get(reviewDate));
  return res.json(brief || {
    reviewDate,
    primaryTaskId: null,
    maintenanceTaskIds: [],
    stopDoing: [],
    continueDoing: [],
    outcomes: {},
    yesterdayClosure: {},
    notes: '',
    source: 'empty',
  });
});

app.post('/v1/hq/daily-briefs/:date', (req, res) => {
  const reviewDate = validDateKey(req.params.date);
  if (!reviewDate) return res.status(400).json({ error: 'invalid_date' });
  try {
    return res.json(upsertDailyBrief(reviewDate, req.body || {}));
  } catch (error) {
    if (error?.code === 'daily_brief_stale_sequence') {
      return res.status(409).json({ error: error.code, brief: error.brief });
    }
    if (error?.code && error?.status) return sendProposalError(res, error);
    throw error;
  }
});

function sendProposalError(res, error) {
  if (error?.code && error?.status) {
    return res.status(error.status).json({ error: error.code, ...(error.detail || {}) });
  }
  throw error;
}

const ASSISTANT_GATEWAY_REPLY_CONTRACT = '2026-09-03';
const ASSISTANT_GATEWAY_REPLY_DECISIONS = new Set(['approve', 'reject', 'defer', 'expand']);
const ASSISTANT_GATEWAY_REPLY_SOURCES = new Set(['personal_wechat', 'notification_hub_weixin']);

function boundedReplyText(value, maxLength, field, required = false) {
  const text = String(value || '').trim();
  if (required && !text) throw proposalError(`${field}_required`);
  if (text.length > maxLength) throw proposalError(`${field}_too_long`);
  return text;
}

function parseProposalRevisionTag(value) {
  const match = /^"?proposal-revision-(\d+)"?$/.exec(String(value || '').trim());
  return match ? Number(match[1]) : null;
}

function normalizeGatewayReply(req) {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const proposalId = boundedReplyText(req.params.proposalId, 200, 'proposal_id', true);
  if (body.proposalId && String(body.proposalId).trim() !== proposalId) {
    throw proposalError('proposal_id_binding_mismatch', 409);
  }
  const idempotencyKey = boundedReplyText(req.headers['x-idempotency-key'], 300, 'idempotency_key', true);
  if (body.idempotencyKey && String(body.idempotencyKey).trim() !== idempotencyKey) {
    throw proposalError('idempotency_key_binding_mismatch', 409);
  }
  const inboundMessageId = boundedReplyText(body.inboundMessageId, 200, 'inbound_message_id', true);
  const decision = boundedReplyText(body.decision, 20, 'decision', true);
  if (!ASSISTANT_GATEWAY_REPLY_DECISIONS.has(decision)) throw proposalError('invalid_reply_decision');
  const expectedProposalRevision = Number(body.expectedProposalRevision);
  if (!Number.isSafeInteger(expectedProposalRevision) || expectedProposalRevision < 1) {
    throw proposalError('expected_proposal_revision_required');
  }
  const ifMatch = String(req.headers['if-match'] || '').trim();
  if (ifMatch) {
    const headerRevision = parseProposalRevisionTag(ifMatch);
    if (!headerRevision) throw proposalError('invalid_proposal_if_match');
    if (headerRevision !== expectedProposalRevision) {
      throw proposalError('proposal_revision_binding_mismatch', 409);
    }
  }
  const textHash = boundedReplyText(body.textHash, 64, 'text_hash', true).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(textHash)) throw proposalError('invalid_text_hash');
  const receivedAt = boundedReplyText(body.receivedAt, 40, 'received_at', true);
  if (Number.isNaN(new Date(receivedAt).getTime())) throw proposalError('invalid_received_at');
  const verification = body.verification && typeof body.verification === 'object' ? body.verification : {};
  const source = boundedReplyText(verification.source || body.source, 80, 'verified_source', true);
  if (!ASSISTANT_GATEWAY_REPLY_SOURCES.has(source) || verification.verified !== true) {
    throw proposalError('verified_source_required');
  }
  const signatureRef = boundedReplyText(verification.signatureRef || body.signatureRef, 500, 'signature_ref', true);
  const replyRef = boundedReplyText(body.replyRef, 500, 'reply_ref', true);
  const verifiedUserRef = boundedReplyText(body.verifiedUserRef, 500, 'verified_user_ref', true);
  const note = boundedReplyText(body.note, 2000, 'note');
  const clarification = boundedReplyText(body.clarification || body.note, 2000, 'clarification', decision === 'expand');
  const deferUntil = body.deferUntil ? boundedReplyText(body.deferUntil, 10, 'defer_until') : '';
  return {
    proposalId, idempotencyKey, inboundMessageId, decision, expectedProposalRevision,
    textHash, receivedAt, source, signatureRef, replyRef, verifiedUserRef, note,
    clarification, deferUntil,
    reasonCode: boundedReplyText(body.reasonCode, 120, 'reason_code'),
    scopeKey: boundedReplyText(body.scopeKey, 120, 'scope_key'),
    fingerprint: boundedReplyText(body.fingerprint, 300, 'fingerprint'),
  };
}

function rowToGatewayReply(row) {
  if (!row) return null;
  return {
    replyId: row.reply_id,
    inboundMessageId: row.inbound_message_id,
    idempotencyKey: row.idempotency_key,
    requestHash: row.request_hash,
    proposalId: row.proposal_id,
    expectedProposalRevision: Number(row.expected_revision),
    decision: row.decision,
    status: row.status,
    httpStatus: Number(row.http_status || 0),
    response: parseJson(row.response_json, null),
    error: row.error_code || null,
  };
}

function recordGatewayReplyAudit(reply, eventType, detail = {}) {
  db.prepare(`
    INSERT OR IGNORE INTO hq_proposal_reply_audit (
      id, reply_id, proposal_id, event_type, actor, detail_json, created_at
    ) VALUES (?, ?, ?, ?, 'assistant-gateway', ?, ?)
  `).run(uid(), reply.replyId, reply.proposalId, eventType, json(detail), now());
}

function finalizeGatewayReply(replyId, status, httpStatus, response, errorCode = null) {
  db.prepare(`
    UPDATE hq_proposal_replies
    SET status=?, http_status=?, response_json=?, error_code=?, updated_at=?
    WHERE reply_id=?
  `).run(status, httpStatus, json(response), errorCode, now(), replyId);
  return rowToGatewayReply(db.prepare('SELECT * FROM hq_proposal_replies WHERE reply_id=?').get(replyId));
}

function replyAgeError(receivedAt) {
  const ageMs = Date.now() - new Date(receivedAt).getTime();
  const maxAgeSeconds = Math.max(60, Number(process.env.ASSISTANT_GATEWAY_REPLY_MAX_AGE_SECONDS) || 86400);
  if (ageMs > maxAgeSeconds * 1000) return 'reply_expired';
  if (ageMs < -300000) return 'reply_timestamp_in_future';
  return null;
}

function rowToReviewRule(row) {
  if (!row) return null;
  const raw = parseJson(row.raw_json, {});
  return { ...raw, ruleId: row.rule_id, version: Number(row.version), source: row.source,
    enabled: Boolean(row.enabled), revocable: Boolean(row.revocable), reasonCode: row.reason_code,
    scopeKey: row.scope_key, fingerprint: row.fingerprint || null, match: parseJson(row.match_json, {}),
    createdAt: row.created_at, updatedAt: row.updated_at };
}

app.get('/v1/hq/review-rules', (req, res) => {
  const activeOnly = String(req.query.status || 'active') === 'active';
  const rows = db.prepare(`SELECT * FROM hq_review_rules ${activeOnly ? 'WHERE enabled=1' : ''} ORDER BY updated_at DESC`).all();
  return res.json({ items: rows.map(rowToReviewRule) });
});

app.post('/v1/hq/review-rules', (req, res) => {
  const body = req.body || {};
  const ruleId = String(body.ruleId || '').trim();
  const source = String(body.source || '').trim();
  const reasonCode = String(body.reasonCode || '').trim();
  const scopeKey = String(body.scopeKey || '').trim();
  if (!ruleId || !['explicit_user', 'standing_rule'].includes(source) || !reasonCode || !scopeKey) {
    return res.status(400).json({ error: 'invalid_review_rule' });
  }
  const existing = db.prepare('SELECT * FROM hq_review_rules WHERE rule_id=?').get(ruleId);
  const timestamp = now();
  const rule = { ...body, ruleId, version: Number(body.version || (existing ? Number(existing.version) + 1 : 1)),
    source, enabled: body.enabled !== false, revocable: body.revocable !== false, reasonCode, scopeKey,
    fingerprint: String(body.fingerprint || '').trim() || null, match: body.match && typeof body.match === 'object' ? body.match : {},
    createdAt: existing?.created_at || timestamp, updatedAt: timestamp };
  db.prepare(`INSERT INTO hq_review_rules(rule_id,version,source,enabled,revocable,reason_code,scope_key,fingerprint,match_json,created_at,updated_at,raw_json)
    VALUES(@ruleId,@version,@source,@enabled,@revocable,@reasonCode,@scopeKey,@fingerprint,@matchJson,@createdAt,@updatedAt,@rawJson)
    ON CONFLICT(rule_id) DO UPDATE SET version=excluded.version,source=excluded.source,enabled=excluded.enabled,revocable=excluded.revocable,reason_code=excluded.reason_code,scope_key=excluded.scope_key,fingerprint=excluded.fingerprint,match_json=excluded.match_json,updated_at=excluded.updated_at,raw_json=excluded.raw_json`)
    .run({ ...rule, enabled: rule.enabled ? 1 : 0, revocable: rule.revocable ? 1 : 0, matchJson: json(rule.match), rawJson: json(rule) });
  return res.status(existing ? 200 : 201).json(rowToReviewRule(db.prepare('SELECT * FROM hq_review_rules WHERE rule_id=?').get(ruleId)));
});

app.get('/v1/hq/proposals', (req, res) => {
  const statuses = String(req.query.status || '')
    .split(',').map((item) => item.trim()).filter((item) => HQ_PROPOSAL_STATUSES.has(item));
  const proposalType = String(req.query.type || '').trim();
  const sourceAuthority = String(req.query.sourceAuthority || '').trim();
  const clauses = [];
  const params = [];
  if (statuses.length) {
    clauses.push(`status IN (${statuses.map(() => '?').join(',')})`);
    params.push(...statuses);
  }
  if (proposalType) {
    if (!HQ_PROPOSAL_TYPES.has(proposalType)) return res.status(400).json({ error: 'invalid_proposal_type' });
    clauses.push('proposal_type=?');
    params.push(proposalType);
  }
  if (sourceAuthority) {
    if (!HQ_SOURCE_AUTHORITIES.has(sourceAuthority)) return res.status(400).json({ error: 'invalid_source_authority' });
    clauses.push('source_authority=?');
    params.push(sourceAuthority);
  }
  const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50));
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const items = db.prepare(`
    SELECT * FROM hq_proposals ${where}
    ORDER BY CASE status WHEN 'proposed' THEN 0 WHEN 'approved' THEN 1 WHEN 'deferred' THEN 2 ELSE 3 END,
      updated_at DESC
    LIMIT ?
  `).all(...params, limit).map(rowToProposal);
  return res.json({
    items,
    count: items.length,
    statusCounts: Object.fromEntries([...HQ_PROPOSAL_STATUSES].map((status) => [
      status, Number(db.prepare('SELECT COUNT(*) AS count FROM hq_proposals WHERE status=?').get(status)?.count || 0),
    ])),
  });
});

app.get('/v1/hq/proposals/:id', (req, res) => {
  try {
    const proposal = getProposalOrThrow(req.params.id);
    const auditTrail = db.prepare(`
      SELECT * FROM hq_proposal_events WHERE proposal_id=? ORDER BY created_at, id
    `).all(proposal.decisionId).map(rowToProposalEvent);
    return res.json({ ...proposal, auditTrail });
  } catch (error) {
    return sendProposalError(res, error);
  }
});

app.post('/v1/hq/proposals', (req, res) => {
  try {
    const result = db.transaction(() => upsertProposal(req.body || {}))();
    return res.status(result.created ? 201 : 200).json(result.proposal);
  } catch (error) {
    return sendProposalError(res, error);
  }
});

app.post('/v1/hq/proposals/:proposalId/replies', (req, res) => {
  let input;
  try {
    input = normalizeGatewayReply(req);
  } catch (error) {
    return sendProposalError(res, error);
  }

  let proposal;
  try {
    proposal = getProposalOrThrow(input.proposalId);
  } catch (error) {
    return sendProposalError(res, error);
  }

  const requestHash = crypto.createHash('sha256').update(stableJson(input)).digest('hex');
  const byKey = db.prepare('SELECT * FROM hq_proposal_replies WHERE idempotency_key=?').get(input.idempotencyKey);
  const byMessage = db.prepare('SELECT * FROM hq_proposal_replies WHERE inbound_message_id=?').get(input.inboundMessageId);
  if (byKey && byMessage && byKey.reply_id !== byMessage.reply_id) {
    return res.status(409).json({ error: 'reply_idempotency_conflict' });
  }
  let reply = rowToGatewayReply(byKey || byMessage);
  if (reply && (reply.requestHash !== requestHash
    || reply.idempotencyKey !== input.idempotencyKey
    || reply.inboundMessageId !== input.inboundMessageId)) {
    return res.status(409).json({ error: 'reply_idempotency_conflict', replyId: reply.replyId });
  }
  if (reply && reply.status !== 'received') {
    res.setHeader('ETag', `"proposal-revision-${reply.expectedProposalRevision}"`);
    return res.status(reply.httpStatus || 200).json(reply.response);
  }

  if (!reply) {
    reply = db.transaction(() => {
      const timestamp = now();
      const replyId = uid();
      db.prepare(`
        INSERT INTO hq_proposal_replies (
          reply_id, inbound_message_id, idempotency_key, request_hash, proposal_id,
          expected_revision, decision, text_hash, source, reply_ref, verified_user_ref,
          signature_ref, received_at, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'received', ?, ?)
      `).run(
        replyId, input.inboundMessageId, input.idempotencyKey, requestHash, input.proposalId,
        input.expectedProposalRevision, input.decision, input.textHash, input.source,
        input.replyRef, input.verifiedUserRef, input.signatureRef, input.receivedAt,
        timestamp, timestamp,
      );
      const created = rowToGatewayReply(db.prepare('SELECT * FROM hq_proposal_replies WHERE reply_id=?').get(replyId));
      const detail = {
        inboundMessageId: input.inboundMessageId,
        replyRef: input.replyRef,
        verifiedUserRef: input.verifiedUserRef,
        source: input.source,
        signatureRef: input.signatureRef,
        textHash: input.textHash,
        decision: input.decision,
        expectedProposalRevision: input.expectedProposalRevision,
      };
      recordGatewayReplyAudit(created, 'received', detail);
      recordProposalEvent(proposal, 'gateway_reply_received', 'assistant-gateway', '', detail);
      return created;
    })();
  }

  const rejectReply = (code, detail = {}) => {
    const payload = {
      contractVersion: ASSISTANT_GATEWAY_REPLY_CONTRACT,
      error: code,
      replyId: reply.replyId,
      proposalId: input.proposalId,
      ...detail,
    };
    db.transaction(() => {
      finalizeGatewayReply(reply.replyId, 'rejected', 409, payload, code);
      recordGatewayReplyAudit(reply, 'rejected', { error: code, ...detail });
    })();
    return res.status(409).json(payload);
  };

  const ageError = replyAgeError(input.receivedAt);
  if (ageError) return rejectReply(ageError);
  proposal = getProposalOrThrow(input.proposalId);
  if (proposal.revision !== input.expectedProposalRevision) {
    return rejectReply('proposal_revision_conflict', {
      expectedRevision: input.expectedProposalRevision,
      currentRevision: proposal.revision,
      updatedAt: proposal.updatedAt,
    });
  }

  try {
    const result = db.transaction(() => {
      let nextProposal = proposal;
      let status = 'applied';
      if (input.decision === 'expand') {
        status = 'clarification_recorded';
        recordProposalEvent(proposal, 'clarification_requested', 'assistant-gateway', input.clarification, {
          replyId: reply.replyId,
          replyRef: input.replyRef,
          textHash: input.textHash,
        });
      } else {
        nextProposal = transitionProposal(input.proposalId, input.decision, {
          actor: 'assistant-gateway',
          note: input.note,
          deferUntil: input.deferUntil,
          reasonCode: input.reasonCode,
          scopeKey: input.scopeKey,
          fingerprint: input.fingerprint,
        });
      }
      const payload = {
        contractVersion: ASSISTANT_GATEWAY_REPLY_CONTRACT,
        replyId: reply.replyId,
        inboundMessageId: input.inboundMessageId,
        proposalId: input.proposalId,
        proposalRevision: nextProposal.revision,
        decision: input.decision,
        status,
        proposal: nextProposal,
        taskboxMutation: false,
      };
      finalizeGatewayReply(reply.replyId, status, 200, payload);
      recordGatewayReplyAudit(reply, status, {
        decision: input.decision,
        proposalStatus: nextProposal.status,
        proposalRevision: nextProposal.revision,
      });
      return payload;
    })();
    res.setHeader('ETag', `"proposal-revision-${result.proposalRevision}"`);
    return res.json(result);
  } catch (error) {
    const status = error?.status || 500;
    const code = error?.code || 'internal_error';
    const payload = {
      contractVersion: ASSISTANT_GATEWAY_REPLY_CONTRACT,
      error: code,
      replyId: reply.replyId,
      proposalId: input.proposalId,
      ...(error?.detail || {}),
    };
    db.transaction(() => {
      finalizeGatewayReply(reply.replyId, 'rejected', status, payload, code);
      recordGatewayReplyAudit(reply, 'rejected', { error: code, ...(error?.detail || {}) });
    })();
    return res.status(status).json(payload);
  }
});

['approve', 'reject', 'defer', 'restore'].forEach((action) => {
  app.post(`/v1/hq/proposals/:id/${action}`, (req, res) => {
    try {
      return res.json(db.transaction(() => transitionProposal(req.params.id, action, req.body || {}))());
    } catch (error) {
      return sendProposalError(res, error);
    }
  });
});

app.post('/v1/hq/proposals/:id/promote', (req, res) => {
  try {
    return res.json(promoteProposal(req.params.id, req.body || {}));
  } catch (error) {
    return sendProposalError(res, error);
  }
});

const SYSTEM_CANDIDATE_SYSTEMS = new Set(['mission', 'health', 'time', 'execution', 'feedback']);
const SYSTEM_CANDIDATE_STATUSES = new Set(['pending', 'kept', 'dismissed']);
function rowToSystemCandidate(row) {
  if (!row) return null;
  const raw = parseJson(row.raw_json, {});
  return { ...raw, candidateId: row.candidate_id, systemId: row.system_id, reviewDate: row.review_date,
    kind: row.kind, statement: row.statement, authority: row.authority, epistemicState: row.epistemic_state,
    status: row.status, evidenceRefs: parseJson(row.evidence_json, []), source: parseJson(row.source_json, {}),
    createdAt: row.created_at, updatedAt: row.updated_at, writesTargetSystem: false };
}

app.get('/v1/system-candidates', (req, res) => {
  if (dailyIntakeTransport.isIntakeRead(req)) return dailyIntakeTransport.list(req, res);
  const systemId = String(req.query.systemId || '').trim();
  const status = String(req.query.status || '').trim();
  if (!SYSTEM_CANDIDATE_SYSTEMS.has(systemId)) return res.status(400).json({ error: 'invalid_system_id' });
  if (status && !SYSTEM_CANDIDATE_STATUSES.has(status)) return res.status(400).json({ error: 'invalid_status' });
  const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 100));
  const rows = status
    ? db.prepare('SELECT * FROM system_candidates WHERE system_id=? AND status=? ORDER BY review_date DESC, updated_at DESC LIMIT ?').all(systemId, status, limit)
    : db.prepare('SELECT * FROM system_candidates WHERE system_id=? ORDER BY review_date DESC, updated_at DESC LIMIT ?').all(systemId, limit);
  res.json({ systemId, items: rows.map(rowToSystemCandidate), count: rows.length });
});

app.post('/v1/system-candidates/batch', (req, res) => {
  if (dailyIntakeTransport.isIntakeBatch(req)) return dailyIntakeTransport.receive(req, res);
  const candidates = Array.isArray(req.body?.candidates) ? req.body.candidates : [];
  if (candidates.length > 500) return res.status(400).json({ error: 'too_many_candidates' });
  try {
    const result = db.transaction(() => {
      let created = 0; let unchanged = 0;
      const insert = db.prepare(`INSERT INTO system_candidates
        (candidate_id,system_id,review_date,kind,statement,authority,epistemic_state,status,evidence_json,source_json,created_at,updated_at,raw_json)
        VALUES (@candidate_id,@system_id,@review_date,@kind,@statement,@authority,'candidate_unvalidated','pending',@evidence_json,@source_json,@created_at,@updated_at,@raw_json)
        ON CONFLICT(candidate_id) DO NOTHING`);
      candidates.forEach((item) => {
        const candidateId = String(item.candidateId || '').trim(); const systemId = String(item.systemId || '').trim();
        const reviewDate = String(item.reviewDate || '').trim(); const statement = String(item.statement || '').trim();
        if (!candidateId || !SYSTEM_CANDIDATE_SYSTEMS.has(systemId) || !/^\d{4}-\d{2}-\d{2}$/.test(reviewDate) || !statement
          || item.writesTargetSystem !== false || item.epistemicState !== 'candidate_unvalidated') {
          const error = new Error('invalid_system_candidate'); error.status = 400; throw error;
        }
        const timestamp = now();
        const info = insert.run({ candidate_id: candidateId, system_id: systemId, review_date: reviewDate,
          kind: String(item.kind || 'observation'), statement, authority: String(item.authority || 'ai_summary'),
          evidence_json: json(item.evidenceRefs || []), source_json: json(item.source || req.body.source || {}),
          created_at: timestamp, updated_at: timestamp, raw_json: json(item) });
        if (info.changes) created += 1; else unchanged += 1;
      });
      return { created, unchanged, total: candidates.length };
    })();
    res.status(result.created ? 201 : 200).json(result);
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    throw error;
  }
});

app.patch('/v1/system-candidates/:id', (req, res) => {
  const status = String(req.body?.status || '').trim();
  if (!['kept', 'dismissed'].includes(status)) return res.status(400).json({ error: 'invalid_status' });
  const row = db.prepare('SELECT * FROM system_candidates WHERE candidate_id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'candidate_not_found' });
  db.prepare('UPDATE system_candidates SET status=?, updated_at=? WHERE candidate_id=?').run(status, now(), req.params.id);
  res.json(rowToSystemCandidate(db.prepare('SELECT * FROM system_candidates WHERE candidate_id=?').get(req.params.id)));
});

app.get('/v1/system-baseline/current', (req, res) => {
  try {
    if (!fiveSystemBaselinePath || !fs.existsSync(fiveSystemBaselinePath)) return res.status(404).json({ error: 'system_baseline_not_configured' });
    const raw = fs.readFileSync(fiveSystemBaselinePath, 'utf8');
    const payload = JSON.parse(raw);
    if (payload?.schemaVersion !== 'five-system-bootstrap-v1' || !payload?.dataset?.runId) {
      return res.status(500).json({ error: 'system_baseline_invalid' });
    }
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.json(payload);
  } catch {
    return res.status(500).json({ error: 'system_baseline_unreadable' });
  }
});

app.get('/v1/hq/decisions', (req, res) => {
  const status = String(req.query.status || '').trim();
  const rows = status
    ? db.prepare('SELECT * FROM hq_decisions WHERE status=? ORDER BY updated_at DESC').all(status)
    : db.prepare('SELECT * FROM hq_decisions ORDER BY updated_at DESC').all();
  res.json(rows.map(rowToDecision));
});

app.post('/v1/hq/decisions', (req, res) => {
  const createdAt = req.body.createdAt || now();
  const decision = {
    ...req.body,
    id: req.body.id || uid(),
    title: String(req.body.title || '').trim(),
    context: String(req.body.context || ''),
    status: req.body.status === 'resolved' ? 'resolved' : 'open',
    urgency: req.body.urgency === 'high' ? 'high' : 'normal',
    resolution: String(req.body.resolution || ''),
    mainlineId: req.body.mainlineId || null,
    taskId: req.body.taskId || null,
    dueDate: req.body.dueDate || null,
    createdAt,
    resolvedAt: req.body.status === 'resolved' ? (req.body.resolvedAt || now()) : null,
    updatedAt: now(),
  };
  if (!decision.title) return res.status(400).json({ error: 'title_required' });
  db.prepare(`
    INSERT INTO hq_decisions (
      id, title, context, status, urgency, resolution, mainline_id, task_id,
      due_date, created_at, resolved_at, updated_at, raw_json
    )
    VALUES (
      @id, @title, @context, @status, @urgency, @resolution, @mainline_id, @task_id,
      @due_date, @created_at, @resolved_at, @updated_at, @raw_json
    )
    ON CONFLICT(id) DO UPDATE SET
      title=excluded.title,
      context=excluded.context,
      status=excluded.status,
      urgency=excluded.urgency,
      resolution=excluded.resolution,
      mainline_id=excluded.mainline_id,
      task_id=excluded.task_id,
      due_date=excluded.due_date,
      resolved_at=excluded.resolved_at,
      updated_at=excluded.updated_at,
      raw_json=excluded.raw_json
  `).run({
    id: decision.id,
    title: decision.title,
    context: decision.context,
    status: decision.status,
    urgency: decision.urgency,
    resolution: decision.resolution,
    mainline_id: decision.mainlineId,
    task_id: decision.taskId,
    due_date: decision.dueDate,
    created_at: decision.createdAt,
    resolved_at: decision.resolvedAt,
    updated_at: decision.updatedAt,
    raw_json: json(decision),
  });
  return res.status(201).json(rowToDecision(db.prepare('SELECT * FROM hq_decisions WHERE id=?').get(decision.id)));
});

app.patch('/v1/hq/decisions/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM hq_decisions WHERE id=?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'not_found' });
  const current = rowToDecision(existing);
  const nextStatus = req.body.status === 'resolved' ? 'resolved' : (req.body.status === 'open' ? 'open' : current.status);
  const next = {
    ...current,
    ...req.body,
    id: current.id,
    title: String(req.body.title ?? current.title).trim(),
    context: String(req.body.context ?? current.context ?? ''),
    status: nextStatus,
    urgency: (req.body.urgency ?? current.urgency) === 'high' ? 'high' : 'normal',
    resolution: String(req.body.resolution ?? current.resolution ?? ''),
    mainlineId: req.body.mainlineId ?? current.mainlineId ?? null,
    taskId: req.body.taskId ?? current.taskId ?? null,
    dueDate: req.body.dueDate ?? current.dueDate ?? null,
    resolvedAt: nextStatus === 'resolved' ? (req.body.resolvedAt || current.resolvedAt || now()) : null,
    updatedAt: now(),
  };
  if (!next.title) return res.status(400).json({ error: 'title_required' });
  db.prepare(`
    UPDATE hq_decisions SET
      title=@title, context=@context, status=@status, urgency=@urgency, resolution=@resolution,
      mainline_id=@mainline_id, task_id=@task_id, due_date=@due_date, resolved_at=@resolved_at,
      updated_at=@updated_at, raw_json=@raw_json
    WHERE id=@id
  `).run({
    id: next.id,
    title: next.title,
    context: next.context,
    status: next.status,
    urgency: next.urgency,
    resolution: next.resolution,
    mainline_id: next.mainlineId,
    task_id: next.taskId,
    due_date: next.dueDate,
    resolved_at: next.resolvedAt,
    updated_at: next.updatedAt,
    raw_json: json(next),
  });
  return res.json(rowToDecision(db.prepare('SELECT * FROM hq_decisions WHERE id=?').get(next.id)));
});

app.delete('/v1/hq/decisions/:id', (req, res) => {
  db.prepare('DELETE FROM hq_decisions WHERE id=?').run(req.params.id);
  res.status(204).end();
});

app.get('/v1/daily-snapshot', (req, res) => {
  const reviewDate = validDateKey(req.query.date);
  if (!reviewDate) return res.status(400).json({ error: 'invalid_date' });
  const tasks = db.prepare('SELECT * FROM tasks').all().map(rowToTask);
  const touchesDate = (task) => [
    task.scheduledAt,
    task.dueDate,
    task.completedAt,
    task.createdAt,
    task.updatedAt,
    ...(task.progressLogs || []).map((log) => log.at || log.updatedAt),
  ].some((value) => dateKeyInReviewTimezone(value) === reviewDate);
  const selectedTasks = tasks.filter((task) => !task.deleted && !task.isRecurringTemplate && touchesDate(task));
  const mainlines = db.prepare('SELECT * FROM mainlines ORDER BY sort_order, created_at').all().map(rowToMainline);
  const brief = rowToDailyBrief(db.prepare('SELECT * FROM hq_daily_briefs WHERE review_date=?').get(reviewDate));
  return res.json({
    reviewDate,
    brief,
    tasks: selectedTasks,
    completedTasks: selectedTasks.filter((task) => task.isCompleted && dateKeyInReviewTimezone(task.completedAt) === reviewDate),
    progressTasks: selectedTasks.filter((task) => (task.progressLogs || []).some((log) => dateKeyInReviewTimezone(log.at || log.updatedAt) === reviewDate)),
    mainlines,
    generatedAt: now(),
  });
});

app.post('/v1/boxes', (req, res) => {
  const box = { ...req.body, id: req.body.id || uid(), createdAt: req.body.createdAt || now(), updatedAt: now() };
  const existing = db.prepare('SELECT * FROM boxes WHERE id=?').get(box.id);
  if (existing) return res.json(rowToBox(existing));
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
    db.prepare('UPDATE tasks SET mainline_id=NULL, branch_id=NULL, milestone_id=NULL WHERE mainline_id=?').run(req.params.id);
    db.prepare('DELETE FROM branches WHERE mainline_id=?').run(req.params.id);
    db.prepare('DELETE FROM milestones WHERE mainline_id=?').run(req.params.id);
    db.prepare('DELETE FROM mainlines WHERE id=?').run(req.params.id);
  })();
  return res.status(204).end();
});

function branchParams(branch) {
  return {
    id: branch.id,
    mainline_id: branch.mainlineId,
    name: branch.name || '',
    description: branch.description || null,
    branch_type: branch.branchType || 'project',
    status: branch.status || 'planned',
    icon: branch.icon || '◇',
    color: branch.color || '#337a78',
    target_date: branch.targetDate || null,
    next_action: branch.nextAction || null,
    completion_criteria: branch.completionCriteria || null,
    review: branch.review || null,
    sort_order: Number(branch.sortOrder ?? 0),
    completed_at: branch.status === 'completed' ? (branch.completedAt || now()) : null,
    created_at: branch.createdAt || now(),
    updated_at: branch.updatedAt || now(),
    raw_json: json(branch),
  };
}

app.post('/v1/branches', (req, res) => {
  const branch = { ...req.body, id: req.body.id || uid(), createdAt: req.body.createdAt || now(), updatedAt: now() };
  if (!db.prepare('SELECT 1 FROM mainlines WHERE id=?').get(branch.mainlineId)) return res.status(409).json({ error: 'mainline_not_found' });
  const existing = db.prepare('SELECT * FROM branches WHERE id=?').get(branch.id);
  if (existing) return res.json(rowToBranch(existing));
  db.prepare(`
    INSERT INTO branches (id, mainline_id, name, description, branch_type, status, icon, color, target_date,
      next_action, completion_criteria, review, sort_order, completed_at, created_at, updated_at, raw_json)
    VALUES (@id, @mainline_id, @name, @description, @branch_type, @status, @icon, @color, @target_date,
      @next_action, @completion_criteria, @review, @sort_order, @completed_at, @created_at, @updated_at, @raw_json)
  `).run(branchParams(branch));
  res.status(201).json(branch);
});

app.patch('/v1/branches/:id', (req, res) => {
  const current = db.prepare('SELECT * FROM branches WHERE id=?').get(req.params.id);
  if (!current) return res.status(404).json({ error: 'branch_not_found' });
  const next = mergeRaw(current.raw_json, { ...req.body, id: req.params.id, updatedAt: now() });
  if (!db.prepare('SELECT 1 FROM mainlines WHERE id=?').get(next.mainlineId)) return res.status(409).json({ error: 'mainline_not_found' });
  db.prepare(`
    UPDATE branches SET mainline_id=@mainline_id, name=@name, description=@description, branch_type=@branch_type,
      status=@status, icon=@icon, color=@color, target_date=@target_date, next_action=@next_action,
      completion_criteria=@completion_criteria, review=@review, sort_order=@sort_order, completed_at=@completed_at,
      created_at=@created_at, updated_at=@updated_at, raw_json=@raw_json WHERE id=@id
  `).run(branchParams(next));
  res.json(next);
});

app.delete('/v1/branches/:id', (req, res) => {
  if (!db.prepare('SELECT 1 FROM branches WHERE id=?').get(req.params.id)) return res.status(404).json({ error: 'branch_not_found' });
  db.transaction(() => {
    db.prepare('UPDATE tasks SET branch_id=NULL WHERE branch_id=?').run(req.params.id);
    db.prepare('DELETE FROM branches WHERE id=?').run(req.params.id);
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

function normalizeTaskCompletionTransition(currentTask, patch, timestamp = now()) {
  const next = { ...patch };
  if (!Object.hasOwn(next, 'isCompleted')) return next;
  if (next.isCompleted && !currentTask?.isCompleted) {
    next.completedAt = next.completedAt || timestamp;
    next.completionReceipt = next.completionReceipt || {
      version: 1,
      sourceTaskId: next.id || currentTask?.id || '',
      createdAt: timestamp,
      completedAt: next.completedAt,
      content: String(next.content || currentTask?.content || ''),
      note: String(next.note ?? currentTask?.note ?? ''),
      source: 'taskbox-api',
    };
  } else if (!next.isCompleted && currentTask?.isCompleted) {
    if (!Object.hasOwn(next, 'completedAt')) next.completedAt = null;
    if (!Object.hasOwn(next, 'completionReceipt')) next.completionReceipt = null;
  }
  return next;
}

app.post('/v1/tasks', (req, res) => {
  const timestamp = now();
  const initial = { ...req.body, id: req.body.id || uid(), revision: 1, createdAt: req.body.createdAt || timestamp, updatedAt: timestamp };
  const task = normalizeTaskCompletionTransition(null, initial, timestamp);
  if (task.boxId && !db.prepare('SELECT 1 FROM boxes WHERE id=?').get(task.boxId)) {
    return res.status(409).json({ error: 'box_not_found', boxId: task.boxId });
  }
  if (task.branchId && !db.prepare('SELECT 1 FROM branches WHERE id=?').get(task.branchId)) {
    return res.status(409).json({ error: 'branch_not_found', branchId: task.branchId });
  }
  const existing = task.recurrenceKey
    ? db.prepare('SELECT * FROM tasks WHERE id=? OR recurrence_key=?').get(task.id, task.recurrenceKey)
    : (task.syncKey
      ? db.prepare('SELECT * FROM tasks WHERE id=? OR sync_key=?').get(task.id, task.syncKey)
      : db.prepare('SELECT * FROM tasks WHERE id=?').get(task.id));
  if (existing) return res.json(rowToTask(existing));
  db.prepare(`
    INSERT INTO tasks (id, revision, box_id, content, is_completed, sort_order, priority, weight, points_value, progress,
      is_recurring_template, recurrence_template_id, recurrence_key, recurrence_json, next_run_at, occurrence_status,
      mainline_id, branch_id, milestone_id, device_context, execution_mode, visible_after, deferred_at, defer_note, progress_logs_json,
      scheduled_at, due_date, deleted, deleted_at, note, sync_key, completed_at, created_at, updated_at, raw_json)
    VALUES (@id, @revision, @box_id, @content, @is_completed, @sort_order, @priority, @weight, @points_value, @progress,
      @is_recurring_template, @recurrence_template_id, @recurrence_key, @recurrence_json, @next_run_at, @occurrence_status,
      @mainline_id, @branch_id, @milestone_id, @device_context, @execution_mode, @visible_after, @deferred_at, @defer_note, @progress_logs_json,
      @scheduled_at, @due_date, @deleted, @deleted_at, @note, @sync_key, @completed_at, @created_at, @updated_at, @raw_json)
  `).run(taskParams(task));
  res.status(201).json(task);
});

app.patch('/v1/tasks/:id', (req, res) => {
  const current = db.prepare('SELECT * FROM tasks WHERE id=?').get(req.params.id);
  if (!current) return res.status(404).json({ error: 'task_not_found' });
  const timestamp = now();
  const currentTask = rowToTask(current);
  const taskPatch = normalizeTaskCompletionTransition(currentTask, { ...req.body, id: req.params.id }, timestamp);
  const next = mergeRaw(current.raw_json, { ...taskPatch, revision: Number(current.revision || 1) + 1, updatedAt: timestamp });
  if (next.boxId && !db.prepare('SELECT 1 FROM boxes WHERE id=?').get(next.boxId)) {
    return res.status(409).json({ error: 'box_not_found', boxId: next.boxId });
  }
  if (next.branchId && !db.prepare('SELECT 1 FROM branches WHERE id=?').get(next.branchId)) {
    return res.status(409).json({ error: 'branch_not_found', branchId: next.branchId });
  }
  db.prepare(`
    UPDATE tasks SET revision=@revision, box_id=@box_id, content=@content, is_completed=@is_completed, sort_order=@sort_order,
      priority=@priority, weight=@weight, points_value=@points_value, progress=@progress,
      is_recurring_template=@is_recurring_template, recurrence_template_id=@recurrence_template_id,
      recurrence_key=@recurrence_key, recurrence_json=@recurrence_json, next_run_at=@next_run_at,
      occurrence_status=@occurrence_status, mainline_id=@mainline_id, branch_id=@branch_id, milestone_id=@milestone_id,
      device_context=@device_context, execution_mode=@execution_mode, visible_after=@visible_after, deferred_at=@deferred_at,
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
  const next = mergeRaw(current.raw_json, { deleted: true, deletedAt: now(), revision: Number(current.revision || 1) + 1, updatedAt: now() });
  db.prepare('UPDATE tasks SET revision=?, deleted=1, deleted_at=?, updated_at=?, raw_json=? WHERE id=?')
    .run(next.revision, next.deletedAt, next.updatedAt, json(next), req.params.id);
  res.json(next);
});

function taskParams(task) {
  return {
    id: task.id,
    revision: Number(task.revision || 1),
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
    branch_id: task.branchId || null,
    milestone_id: task.milestoneId || null,
    device_context: ['desktop', 'mobile', 'universal'].includes(task.deviceContext) ? task.deviceContext : 'universal',
    execution_mode: ['self', 'ai', 'hybrid'].includes(task.executionMode) ? task.executionMode : 'self',
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
