const crypto = require('crypto');

const CONTRACT_VERSION = '2026-09-02';
const OPERATIONS = new Set([
  'create', 'update', 'schedule', 'record_progress', 'record_blocker', 'clear_blocker',
  'append_evidence', 'complete', 'reopen', 'soft_delete', 'restore',
]);
const OPERATION_SCOPES = {
  create: 'tasks:create',
  update: 'tasks:update',
  schedule: 'tasks:schedule',
  record_progress: 'tasks:progress',
  record_blocker: 'tasks:progress',
  clear_blocker: 'tasks:progress',
  append_evidence: 'tasks:evidence',
  complete: 'tasks:complete',
  reopen: 'tasks:complete',
  soft_delete: 'tasks:delete',
  restore: 'tasks:delete',
};
const CREATE_FIELDS = new Set([
  'content', 'boxId', 'scheduledAt', 'dueDate', 'visibleAfter', 'priority', 'weight',
  'pointsValue', 'note', 'deviceContext', 'executionMode', 'durationMinutes',
]);
const UPDATE_FIELDS = new Set([
  'content', 'note', 'priority', 'weight', 'pointsValue', 'deviceContext', 'executionMode',
  'durationMinutes', 'cooldownMinutes',
]);
const SCHEDULE_FIELDS = new Set(['scheduledAt', 'dueDate', 'visibleAfter', 'deferredAt', 'deferNote']);

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function hash(value) {
  return crypto.createHash('sha256').update(stableJson(value)).digest('hex');
}

function error(code, status = 400, detail = {}) {
  return Object.assign(new Error(code), { code, status, detail });
}

function text(value, max = 1000) {
  return String(value || '').trim().slice(0, max);
}

function etag(revision) {
  return `"task-revision-${Number(revision)}"`;
}

function parseExpectedRevision(req, body) {
  const header = text(req.headers['if-match'], 100);
  if (header) {
    const match = header.match(/^(?:W\/)?"task-revision-(\d+)"$/);
    if (!match) throw error('invalid_if_match', 400);
    return Number(match[1]);
  }
  const value = Number(body.revision ?? body.expectedRevision);
  if (!Number.isSafeInteger(value) || value < 1) throw error('task_revision_required', 428);
  return value;
}

function sanitizeEvidence(value) {
  if (typeof value === 'string') return { ref: text(value, 500) };
  if (!value || typeof value !== 'object') return null;
  const evidence = {
    id: text(value.id || value.evidenceId, 200),
    ref: text(value.ref || value.reference || value.referenceId, 500),
    type: text(value.type, 100),
    summary: text(value.summary, 1000),
    url: text(value.url, 1000),
  };
  return Object.fromEntries(Object.entries(evidence).filter(([, item]) => item));
}

function fieldNames(operation, mutation) {
  if (operation === 'create') return Object.keys(mutation.task || mutation);
  if (operation === 'update' || operation === 'schedule') return Object.keys(mutation);
  if (operation === 'record_progress') return ['progress', 'progressLogs'];
  if (operation === 'record_blocker' || operation === 'clear_blocker') return ['blocker', 'executionState'];
  if (operation === 'append_evidence') return ['executionEvidence'];
  if (operation === 'complete' || operation === 'reopen') return ['isCompleted', 'completedAt', 'completionReceipt'];
  if (operation === 'soft_delete' || operation === 'restore') return ['deleted', 'deletedAt'];
  return [];
}

function subset(actual, allowed) {
  return actual.every((item) => allowed.includes(item));
}

const SUMMARY_SCOPE = 'execution:audit:summary';
const SUMMARY_MAX_WINDOW_MS = 24 * 60 * 60 * 1000;
const SUMMARY_OPERATIONS = [
  'create', 'update', 'schedule', 'record_progress', 'record_blocker',
  'clear_blocker', 'append_evidence', 'complete', 'reopen', 'soft_delete', 'restore',
];

function parseWindow(value, name) {
  const parsed = new Date(String(value || ''));
  if (!value || Number.isNaN(parsed.getTime())) throw error(`invalid_${name}`, 400);
  return parsed;
}

function auditSummarySnapshot(row) {
  return row ? {
    capturedAt: row.captured_at,
    taskCount: Number(row.task_count),
    taskIdSetHash: row.task_id_set_hash,
    executionAuditCount: Number(row.execution_audit_count),
    projectionRevision: row.projection_revision,
  } : null;
}

function installAuditSummaryRoute({ app, db, now }) {
  app.get('/v1/execution/audit-summary', (req, res) => {
    if (!req.executionIdentity?.scopes?.has(SUMMARY_SCOPE)) {
      return res.status(403).json({ error: 'execution_audit_summary_scope_denied' });
    }
    try {
      const windowStart = parseWindow(req.query.windowStart, 'window_start');
      const windowEnd = parseWindow(req.query.windowEnd, 'window_end');
      const windowMs = windowEnd.getTime() - windowStart.getTime();
      if (windowMs <= 0 || windowMs > SUMMARY_MAX_WINDOW_MS) throw error('audit_window_invalid', 400);
      if (String(req.query.projection || 'assistant-turns-v1') !== 'assistant-turns-v1') {
        throw error('audit_projection_unsupported', 400);
      }

      const beforeRow = db.prepare(`
        SELECT * FROM audit_projection_snapshots
        WHERE captured_at <= ? ORDER BY captured_at DESC LIMIT 1
      `).get(windowStart.toISOString());
      const afterRow = db.prepare(`
        SELECT * FROM audit_projection_snapshots
        WHERE captured_at >= ? ORDER BY captured_at ASC LIMIT 1
      `).get(windowEnd.toISOString());
      const before = auditSummarySnapshot(beforeRow);
      const after = auditSummarySnapshot(afterRow);
      const insufficientEvidence = !before || !after;
      const evidenceComplete = !insufficientEvidence;

      const operationCounts = Object.fromEntries(SUMMARY_OPERATIONS.map((operation) => [operation, 0]));
      const auditRows = db.prepare(`
        SELECT operation_type, outcome FROM execution_task_audit
        WHERE created_at >= ? AND created_at <= ?
      `).all(windowStart.toISOString(), windowEnd.toISOString());
      auditRows.forEach((row) => {
        if (row.outcome === 'success' && Object.hasOwn(operationCounts, row.operation_type)) {
          operationCounts[row.operation_type] += 1;
        }
      });

      const turnRows = db.prepare(`
        SELECT conversation_key_hash, sequence, status_timestamps_json
        FROM assistant_conversation_turns
        WHERE updated_at >= ? AND updated_at <= ?
        ORDER BY sequence ASC
      `).all(windowStart.toISOString(), windowEnd.toISOString());
      const turns = turnRows.map((row) => ({
        sequence: Number(row.sequence),
        conversationKeyHash: row.conversation_key_hash,
        statusTimestamps: JSON.parse(row.status_timestamps_json || '{}'),
      }));

      return res.json({
        projection: 'assistant-turns-v1',
        windowStart: windowStart.toISOString(),
        windowEnd: windowEnd.toISOString(),
        taskCountBefore: evidenceComplete ? before.taskCount : null,
        taskCountAfter: evidenceComplete ? after.taskCount : null,
        taskIdSetHashBefore: evidenceComplete ? before.taskIdSetHash : null,
        taskIdSetHashAfter: evidenceComplete ? after.taskIdSetHash : null,
        executionAuditCountBefore: evidenceComplete ? before.executionAuditCount : null,
        executionAuditCountAfter: evidenceComplete ? after.executionAuditCount : null,
        auditDelta: evidenceComplete ? after.executionAuditCount - before.executionAuditCount : null,
        operationCounts: evidenceComplete ? operationCounts : null,
        writeCount: evidenceComplete ? operationCounts.create + operationCounts.update + operationCounts.schedule
          + operationCounts.record_progress + operationCounts.record_blocker + operationCounts.clear_blocker
          + operationCounts.append_evidence + operationCounts.complete + operationCounts.reopen : null,
        softDeleteCount: evidenceComplete ? operationCounts.soft_delete : null,
        turns,
        generatedAt: now(),
        projectionRevision: after?.projectionRevision || before?.projectionRevision || 'audit-summary-v1',
        insufficientEvidence,
        noData: !before && !after,
      });
    } catch (routeError) {
      if (routeError?.status) return res.status(routeError.status).json({ error: routeError.message });
      return res.status(500).json({ error: 'audit_summary_internal_error' });
    }
  });
}

function installExecutionSystemRoutes({ app, db, now, json, parseJson, uid, rowToTask, taskParams, normalizeTaskCompletionTransition }) {
  installAuditSummaryRoute({ app, db, now });
  const insertTask = db.prepare(`
    INSERT INTO tasks (id, revision, box_id, content, is_completed, sort_order, priority, weight, points_value, progress,
      is_recurring_template, recurrence_template_id, recurrence_key, recurrence_json, next_run_at, occurrence_status,
      mainline_id, branch_id, milestone_id, device_context, execution_mode, visible_after, deferred_at, defer_note, progress_logs_json,
      scheduled_at, due_date, deleted, deleted_at, note, sync_key, completed_at, created_at, updated_at, raw_json)
    VALUES (@id, @revision, @box_id, @content, @is_completed, @sort_order, @priority, @weight, @points_value, @progress,
      @is_recurring_template, @recurrence_template_id, @recurrence_key, @recurrence_json, @next_run_at, @occurrence_status,
      @mainline_id, @branch_id, @milestone_id, @device_context, @execution_mode, @visible_after, @deferred_at, @defer_note, @progress_logs_json,
      @scheduled_at, @due_date, @deleted, @deleted_at, @note, @sync_key, @completed_at, @created_at, @updated_at, @raw_json)
  `);
  const updateTask = db.prepare(`
    UPDATE tasks SET revision=@revision, box_id=@box_id, content=@content, is_completed=@is_completed,
      sort_order=@sort_order, priority=@priority, weight=@weight, points_value=@points_value, progress=@progress,
      is_recurring_template=@is_recurring_template, recurrence_template_id=@recurrence_template_id,
      recurrence_key=@recurrence_key, recurrence_json=@recurrence_json, next_run_at=@next_run_at,
      occurrence_status=@occurrence_status, mainline_id=@mainline_id, branch_id=@branch_id, milestone_id=@milestone_id,
      device_context=@device_context, execution_mode=@execution_mode, visible_after=@visible_after,
      deferred_at=@deferred_at, defer_note=@defer_note, progress_logs_json=@progress_logs_json,
      scheduled_at=@scheduled_at, due_date=@due_date, deleted=@deleted, deleted_at=@deleted_at,
      note=@note, sync_key=@sync_key, completed_at=@completed_at, created_at=@created_at,
      updated_at=@updated_at, raw_json=@raw_json WHERE id=@id
  `);
  const insertOperation = db.prepare(`
    INSERT INTO execution_task_operations (
      idempotency_key, request_id, operation_type, task_id, authorization_source,
      authorization_ref, request_hash, expected_revision, result_revision, http_status,
      result_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertAudit = db.prepare(`
    INSERT INTO execution_task_audit (
      audit_id, request_id, idempotency_key, operation_type, task_id, authorization_source,
      authorization_ref, expected_revision, result_revision, outcome, error_code,
      request_hash, changes_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  function appendAudit(meta, outcome, resultRevision = null, errorCode = null, changes = {}) {
    insertAudit.run(
      uid(), meta.requestId || 'invalid-request', meta.idempotencyKey || null, meta.operation || null,
      meta.taskId || null, meta.authorizationSource || null, meta.authorizationRef || null,
      meta.expectedRevision ?? null, resultRevision, outcome, errorCode, meta.requestHash || null,
      json(changes || {}), now(),
    );
  }

  function operationResult(meta, status, payload, resultRevision = null) {
    insertOperation.run(
      meta.idempotencyKey, meta.requestId, meta.operation, meta.taskId || payload.task?.id || null,
      meta.authorizationSource, meta.authorizationRef, meta.requestHash,
      meta.expectedRevision ?? null, resultRevision, status, json(payload), now(),
    );
  }

  function requireScope(req, operation) {
    const scope = OPERATION_SCOPES[operation];
    if (!req.executionIdentity?.scopes?.has(scope)) throw error('execution_scope_denied', 403, { requiredScope: scope });
  }

  function validateBox(boxId) {
    const box = db.prepare('SELECT id, box_type FROM boxes WHERE id=?').get(boxId);
    if (!box) throw error('box_not_found', 409, { boxId });
    if ((box.box_type || 'task') !== 'task') throw error('box_not_task_capable', 409, { boxId });
    return box;
  }

  function validateAuthorization(meta, mutation) {
    const evidence = meta.authorizationEvidence || {};
    const fields = fieldNames(meta.operation, mutation);
    if (meta.authorizationSource === 'explicit_user') {
      const ref = text(evidence.referenceId || evidence.grantId || evidence.ref, 300);
      const grants = new Set(String(process.env.EXECUTION_SYSTEM_EXPLICIT_GRANT_IDS || '')
        .split(',').map((item) => item.trim()).filter(Boolean));
      if (!ref || !grants.has(ref)) throw error('explicit_user_authorization_invalid', 403);
      return { ref, proposal: null };
    }
    if (meta.authorizationSource === 'standing_rule') {
      const ruleId = text(evidence.ruleId || evidence.referenceId, 300);
      const row = db.prepare('SELECT * FROM hq_review_rules WHERE rule_id=? AND enabled=1').get(ruleId);
      if (!row || row.source !== 'standing_rule' || row.scope_key !== 'execution.task.write') {
        throw error('standing_rule_authorization_invalid', 403);
      }
      const match = parseJson(row.match_json, {});
      if (!Array.isArray(match.operations) || !match.operations.includes(meta.operation)) {
        throw error('standing_rule_operation_denied', 403);
      }
      if (match.expiresAt && Date.parse(match.expiresAt) <= Date.now()) throw error('standing_rule_expired', 403);
      if (Array.isArray(match.taskIds) && meta.taskId && !match.taskIds.includes(meta.taskId)) {
        throw error('standing_rule_task_denied', 403);
      }
      const boxId = mutation.task?.boxId || mutation.boxId;
      if (Array.isArray(match.boxIds) && boxId && !match.boxIds.includes(boxId)) {
        throw error('standing_rule_box_denied', 403);
      }
      if (Array.isArray(match.fields) && !subset(fields, match.fields)) {
        throw error('standing_rule_fields_denied', 403);
      }
      return { ref: ruleId, proposal: null };
    }
    if (meta.authorizationSource === 'approved_hq_proposal') {
      const proposalId = text(evidence.proposalId || evidence.referenceId, 300);
      const row = db.prepare('SELECT * FROM hq_proposals WHERE decision_id=?').get(proposalId);
      if (!row || row.proposal_type !== 'daily_action_proposal' || !['approved', 'promoted'].includes(row.status)) {
        throw error('hq_proposal_authorization_invalid', 403);
      }
      const proposal = parseJson(row.raw_json, {});
      const taskSpec = proposal.taskSpec || {};
      if (meta.operation === 'create') {
        if (row.status !== 'approved' || row.task_id) throw error('hq_proposal_already_consumed', 409);
        const task = mutation.task || mutation;
        if (text(task.content) !== text(taskSpec.content || proposal.title)
          || String(task.boxId || '') !== String(taskSpec.boxId || '')) {
          throw error('hq_proposal_task_mismatch', 403);
        }
      } else {
        if (![row.task_id, row.existing_task_id].filter(Boolean).includes(meta.taskId)) {
          throw error('hq_proposal_task_mismatch', 403);
        }
        const permissions = taskSpec.executionPermissions || {};
        if (!Array.isArray(permissions.operations) || !permissions.operations.includes(meta.operation)) {
          throw error('hq_proposal_operation_denied', 403);
        }
        if (Array.isArray(permissions.fields) && !subset(fields, permissions.fields)) {
          throw error('hq_proposal_fields_denied', 403);
        }
      }
      return { ref: proposalId, proposal: { row, value: proposal } };
    }
    throw error('authorization_source_invalid', 403);
  }

  function normalizeRequest(req) {
    const body = req.body || {};
    const requestId = text(body.requestId, 300);
    const operation = text(body.operation, 100);
    const idempotencyKey = text(req.headers['x-idempotency-key'] || body.idempotencyKey, 500);
    const taskId = text(body.taskId, 300);
    const authorizationSource = text(body.authorizationSource, 100);
    const authorizationEvidence = body.authorizationEvidence && typeof body.authorizationEvidence === 'object'
      ? body.authorizationEvidence : {};
    const mutation = body.requestedMutation && typeof body.requestedMutation === 'object' ? body.requestedMutation : {};
    const reason = text(body.reason, 2000);
    if (body.contractVersion !== CONTRACT_VERSION) throw error('execution_contract_version_unsupported', 409, { supported: CONTRACT_VERSION });
    if (body.sourceSystem !== 'execution') throw error('source_system_invalid');
    if (!requestId) throw error('request_id_required');
    if (!idempotencyKey) throw error('idempotency_key_required');
    if (!OPERATIONS.has(operation)) throw error('operation_not_allowed');
    if (!reason) throw error('reason_required');
    if (operation !== 'create' && !taskId) throw error('task_id_required');
    const expectedRevision = operation === 'create' ? null : parseExpectedRevision(req, body);
    const requestHash = hash({
      contractVersion: body.contractVersion, sourceSystem: body.sourceSystem, requestId,
      idempotencyKey, operation, taskId, authorizationSource, authorizationEvidence,
      mutation, reason, evidenceRef: sanitizeEvidence(body.evidenceRef), expectedRevision,
    });
    return {
      requestId, idempotencyKey, operation, taskId, authorizationSource, authorizationEvidence,
      mutation, reason, evidenceRef: sanitizeEvidence(body.evidenceRef), expectedRevision, requestHash,
      authorizationRef: null,
    };
  }

  function pickAllowed(value, allowed) {
    const keys = Object.keys(value || {});
    if (!keys.length || keys.some((key) => !allowed.has(key))) throw error('mutation_fields_not_allowed', 400, { fields: keys });
    return Object.fromEntries(keys.map((key) => [key, value[key]]));
  }

  function exactDuplicate(task, excludeTaskId = null) {
    return db.prepare(`SELECT id FROM tasks
      WHERE box_id=? AND deleted=0 AND is_recurring_template=0 AND trim(content)=trim(?)
        AND (? IS NULL OR id<>?) LIMIT 5`)
      .all(task.boxId, task.content, excludeTaskId, excludeTaskId).map((row) => row.id);
  }

  function createTask(meta, auth) {
    const input = pickAllowed(meta.mutation.task || meta.mutation, CREATE_FIELDS);
    const content = text(input.content, 10000);
    const boxId = text(input.boxId, 300);
    if (!content) throw error('task_content_required');
    if (!boxId) throw error('box_id_required');
    validateBox(boxId);
    const duplicates = exactDuplicate({ content, boxId });
    if (duplicates.length) throw error('possible_duplicate_task', 409, { candidateTaskIds: duplicates });
    const timestamp = now();
    let task = normalizeTaskCompletionTransition(null, {
      ...input,
      id: uid(), revision: 1, boxId, content, isCompleted: false, deleted: false,
      progress: 0, syncKey: auth.proposal ? `hq-proposal:${auth.ref}` : `execution:${meta.idempotencyKey}`,
      proposalDecisionId: auth.proposal ? auth.ref : null,
      commitmentSource: auth.proposal ? 'hq_proposal' : 'execution_system',
      createdAt: timestamp, updatedAt: timestamp,
    }, timestamp);
    insertTask.run(taskParams(task));
    task = rowToTask(db.prepare('SELECT * FROM tasks WHERE id=?').get(task.id));
    if (auth.proposal) {
      db.prepare(`UPDATE hq_proposals SET status='promoted', task_id=?, promoted_at=?, updated_at=?, raw_json=? WHERE decision_id=?`)
        .run(task.id, timestamp, timestamp, json({ ...auth.proposal.value, status: 'promoted', taskId: task.id, promotedAt: timestamp, updatedAt: timestamp }), auth.ref);
      db.prepare(`INSERT INTO hq_proposal_events
        (id, proposal_id, revision, event_type, actor, note, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(uid(), auth.ref, Number(auth.proposal.row.revision || 1), 'promote', 'execution-system', meta.reason,
          json({ taskId: task.id, via: 'execution-system-api' }), timestamp);
    }
    return { before: null, task };
  }

  function addEvidence(task, evidence, timestamp) {
    if (!evidence || !Object.keys(evidence).length) throw error('evidence_ref_required');
    const items = Array.isArray(task.executionEvidence) ? [...task.executionEvidence] : [];
    const fingerprint = hash(evidence);
    if (!items.some((item) => item.fingerprint === fingerprint)) {
      items.push({ ...evidence, fingerprint, recordedAt: timestamp, source: 'execution-system' });
    }
    return items;
  }

  function updateExistingTask(meta) {
    const row = db.prepare('SELECT * FROM tasks WHERE id=?').get(meta.taskId);
    if (!row) throw error('task_not_found', 404);
    const before = rowToTask(row);
    if (before.revision !== meta.expectedRevision) {
      throw error('task_revision_conflict', 409, { currentRevision: before.revision, currentUpdatedAt: before.updatedAt });
    }
    if (before.deleted && meta.operation !== 'restore') throw error('task_deleted', 409);
    if (before.isCompleted && !['reopen', 'append_evidence', 'soft_delete'].includes(meta.operation)) {
      throw error('task_already_completed', 409);
    }
    const timestamp = now();
    let patch = {};
    if (meta.operation === 'update') patch = pickAllowed(meta.mutation, UPDATE_FIELDS);
    if (meta.operation === 'schedule') patch = pickAllowed(meta.mutation, SCHEDULE_FIELDS);
    if (meta.operation === 'record_progress') {
      const progress = Number(meta.mutation.progress);
      if (!Number.isFinite(progress) || progress < 0 || progress > 100) throw error('progress_invalid');
      const log = {
        id: `execution-progress:${meta.idempotencyKey}`, progress, note: text(meta.mutation.note || meta.reason, 2000),
        at: timestamp, source: 'execution-system', evidenceRef: meta.evidenceRef || undefined,
      };
      patch = { progress, progressLogs: [...(before.progressLogs || []), log] };
    }
    if (meta.operation === 'record_blocker') {
      const blocker = text(meta.mutation.blocker || meta.reason, 3000);
      if (!blocker) throw error('blocker_required');
      patch = { blocker, blockedAt: timestamp, executionState: 'blocked' };
    }
    if (meta.operation === 'clear_blocker') patch = { blocker: '', blockedAt: null, executionState: 'ready' };
    if (meta.operation === 'append_evidence') patch = { executionEvidence: addEvidence(before, meta.evidenceRef, timestamp) };
    if (meta.operation === 'complete') {
      const evidence = addEvidence(before, meta.evidenceRef, timestamp);
      patch = { isCompleted: true, progress: 100, executionState: 'completed', executionEvidence: evidence };
      if (Object.hasOwn(meta.mutation, 'note')) patch.note = text(meta.mutation.note, 10000);
    }
    if (meta.operation === 'reopen') {
      if (!before.isCompleted) throw error('task_not_completed', 409);
      patch = { isCompleted: false, executionState: 'ready' };
    }
    if (meta.operation === 'soft_delete') {
      if (before.deleted) throw error('task_already_deleted', 409);
      patch = { deleted: true, deletedAt: timestamp, deletionReason: meta.reason, deletedBy: 'execution-system' };
    }
    if (meta.operation === 'restore') {
      if (!before.deleted) throw error('task_not_deleted', 409);
      patch = { deleted: false, deletedAt: null, restoredAt: timestamp, restoreReason: meta.reason, restoredBy: 'execution-system' };
    }
    let task = { ...parseJson(row.raw_json, {}), ...before, ...patch, id: before.id, revision: before.revision + 1, updatedAt: timestamp };
    task = normalizeTaskCompletionTransition(before, task, timestamp);
    if (task.boxId) validateBox(task.boxId);
    if (meta.operation === 'update' && Object.hasOwn(patch, 'content')) {
      const duplicates = exactDuplicate(task, task.id);
      if (duplicates.length) throw error('possible_duplicate_task', 409, { candidateTaskIds: duplicates });
    }
    updateTask.run(taskParams(task));
    task = rowToTask(db.prepare('SELECT * FROM tasks WHERE id=?').get(task.id));
    return { before, task };
  }

  function changes(before, after) {
    if (!before) return { created: after.id };
    const result = {};
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    keys.forEach((key) => {
      if (stableJson(before[key]) !== stableJson(after[key])) result[key] = { before: before[key] ?? null, after: after[key] ?? null };
    });
    return result;
  }

  app.get('/v1/execution/capabilities', (req, res) => {
    res.json({
      contractVersion: CONTRACT_VERSION,
      identity: req.executionIdentity.system,
      scopes: [...req.executionIdentity.scopes].sort(),
      operations: [...OPERATIONS],
      concurrency: { ifMatch: '"task-revision-<integer>"', conflictStatus: 409 },
      idempotencyHeader: 'X-Idempotency-Key',
      hardDelete: false,
    });
  });

  app.get('/v1/execution/tasks/:id', (req, res) => {
    if (!req.executionIdentity.scopes.has('tasks:read')) return res.status(403).json({ error: 'execution_scope_denied', requiredScope: 'tasks:read' });
    const task = rowToTask(db.prepare('SELECT * FROM tasks WHERE id=?').get(req.params.id));
    if (!task) return res.status(404).json({ error: 'task_not_found' });
    res.setHeader('ETag', etag(task.revision));
    return res.json({ contractVersion: CONTRACT_VERSION, task });
  });

  app.get('/v1/execution/audit', (req, res) => {
    if (!req.executionIdentity.scopes.has('tasks:audit')) return res.status(403).json({ error: 'execution_scope_denied', requiredScope: 'tasks:audit' });
    const taskId = text(req.query.taskId, 300);
    const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50));
    const rows = taskId
      ? db.prepare('SELECT * FROM execution_task_audit WHERE task_id=? ORDER BY created_at DESC LIMIT ?').all(taskId, limit)
      : db.prepare('SELECT * FROM execution_task_audit ORDER BY created_at DESC LIMIT ?').all(limit);
    return res.json({ items: rows.map((row) => ({
      auditId: row.audit_id, requestId: row.request_id, idempotencyKey: row.idempotency_key,
      operation: row.operation_type, taskId: row.task_id, authorizationSource: row.authorization_source,
      authorizationRef: row.authorization_ref, expectedRevision: row.expected_revision,
      resultRevision: row.result_revision, outcome: row.outcome, errorCode: row.error_code,
      changes: parseJson(row.changes_json, {}), createdAt: row.created_at,
    })) });
  });

  app.post('/v1/execution/task-operations', (req, res) => {
    let meta;
    try {
      meta = normalizeRequest(req);
      requireScope(req, meta.operation);
      const existing = db.prepare('SELECT * FROM execution_task_operations WHERE idempotency_key=? OR request_id=?').get(meta.idempotencyKey, meta.requestId);
      if (existing) {
        if (existing.request_hash !== meta.requestHash) {
          appendAudit(meta, 'rejected', existing.result_revision, 'idempotency_key_reused');
          return res.status(409).json({ error: 'idempotency_key_reused' });
        }
        const payload = parseJson(existing.result_json, { error: 'idempotency_replay_unavailable' });
        appendAudit(meta, 'replayed', existing.result_revision, payload.error || null);
        if (existing.result_revision) res.setHeader('ETag', etag(existing.result_revision));
        return res.status(existing.http_status).json(payload);
      }
      const auth = validateAuthorization(meta, meta.mutation);
      meta.authorizationRef = auth.ref;
      const applied = db.transaction(() => {
        const result = meta.operation === 'create' ? createTask(meta, auth) : updateExistingTask(meta);
        meta.taskId = result.task.id;
        const diff = changes(result.before, result.task);
        const payload = {
          contractVersion: CONTRACT_VERSION, requestId: meta.requestId, idempotencyKey: meta.idempotencyKey,
          operation: meta.operation, applied: true, task: result.task,
        };
        operationResult(meta, meta.operation === 'create' ? 201 : 200, payload, result.task.revision);
        appendAudit(meta, 'applied', result.task.revision, null, diff);
        return { payload, status: meta.operation === 'create' ? 201 : 200, revision: result.task.revision };
      })();
      res.setHeader('ETag', etag(applied.revision));
      return res.status(applied.status).json(applied.payload);
    } catch (caught) {
      const status = Number(caught.status || 500);
      const payload = { error: caught.code || 'execution_operation_failed', ...(caught.detail || {}) };
      if (meta?.idempotencyKey && meta?.requestId) {
        if (!meta.authorizationRef) meta.authorizationRef = text(meta.authorizationEvidence?.referenceId || meta.authorizationEvidence?.grantId || meta.authorizationEvidence?.ruleId || meta.authorizationEvidence?.proposalId, 300);
        try { operationResult(meta, status, payload, caught.detail?.currentRevision || null); } catch {}
        try { appendAudit(meta, 'rejected', caught.detail?.currentRevision || null, payload.error); } catch {}
      }
      if (status >= 500) console.error(caught);
      return res.status(status).json(payload);
    }
  });
}

module.exports = { CONTRACT_VERSION, installExecutionSystemRoutes };
