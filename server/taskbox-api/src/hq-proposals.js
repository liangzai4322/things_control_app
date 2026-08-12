const crypto = require('crypto');

const PROPOSAL_TYPES = new Set([
  'daily_action_proposal',
  'weekly_experiment_proposal',
  'monthly_bet_proposal',
]);
const AUTHORITIES = new Set(['explicit_user', 'standing_rule', 'ai_derived']);
const STATUSES = new Set(['proposed', 'approved', 'promoted', 'rejected', 'deferred', 'legacy']);
const TERMINAL_STATUSES = new Set(['promoted', 'rejected']);

function stableHash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function installHqProposalRoutes({ app, db, now, uid, json, parseJson, rowToTask, taskParams, upsertDailyBrief }) {
  const promotionEnabled = () => process.env.HQ_PROPOSAL_PROMOTION_ENABLED === '1';

  function rowToProposal(row) {
    if (!row) return null;
    return {
      ...parseJson(row.raw_json, {}),
      decisionId: row.decision_id,
      proposalType: row.proposal_type,
      sourceAuthority: row.source_authority,
      standingRuleId: row.standing_rule_id,
      status: STATUSES.has(row.status) ? row.status : 'legacy',
      title: row.title,
      idempotencyKey: row.idempotency_key,
      revisionHash: row.revision_hash,
      revision: Number(row.revision || 1),
      existingTaskId: row.existing_task_id,
      taskId: row.task_id,
      deferredUntil: row.deferred_until,
      approvedAt: row.approved_at,
      rejectedAt: row.rejected_at,
      promotedAt: row.promoted_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  function getProposal(decisionId) {
    return rowToProposal(db.prepare('SELECT * FROM hq_proposals WHERE decision_id=?').get(decisionId));
  }

  function addEvent(proposal, eventType, actor, fromStatus, toStatus, detail = {}) {
    db.prepare(`
      INSERT INTO hq_proposal_events (
        event_id, decision_id, event_type, actor, from_status, to_status,
        revision, detail_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(uid(), proposal.decisionId, eventType, actor || 'system', fromStatus || null,
      toStatus || null, Number(proposal.revision || 1), json(detail), now());
  }

  function proposalParams(proposal) {
    return {
      decision_id: proposal.decisionId,
      proposal_type: proposal.proposalType,
      source_authority: proposal.sourceAuthority,
      standing_rule_id: proposal.standingRuleId || null,
      status: proposal.status,
      title: proposal.title,
      idempotency_key: proposal.idempotencyKey,
      revision_hash: proposal.revisionHash,
      revision: Number(proposal.revision || 1),
      existing_task_id: proposal.existingTaskId || null,
      task_id: proposal.taskId || null,
      deferred_until: proposal.deferredUntil || null,
      approved_at: proposal.approvedAt || null,
      rejected_at: proposal.rejectedAt || null,
      promoted_at: proposal.promotedAt || null,
      created_at: proposal.createdAt,
      updated_at: proposal.updatedAt,
      raw_json: json(proposal),
    };
  }

  function writeProposal(proposal) {
    db.prepare(`
      INSERT INTO hq_proposals (
        decision_id, proposal_type, source_authority, standing_rule_id, status,
        title, idempotency_key, revision_hash, revision, existing_task_id, task_id,
        deferred_until, approved_at, rejected_at, promoted_at, created_at, updated_at, raw_json
      ) VALUES (
        @decision_id, @proposal_type, @source_authority, @standing_rule_id, @status,
        @title, @idempotency_key, @revision_hash, @revision, @existing_task_id, @task_id,
        @deferred_until, @approved_at, @rejected_at, @promoted_at, @created_at, @updated_at, @raw_json
      )
      ON CONFLICT(decision_id) DO UPDATE SET
        proposal_type=excluded.proposal_type,
        source_authority=excluded.source_authority,
        standing_rule_id=excluded.standing_rule_id,
        status=excluded.status,
        title=excluded.title,
        idempotency_key=excluded.idempotency_key,
        revision_hash=excluded.revision_hash,
        revision=excluded.revision,
        existing_task_id=excluded.existing_task_id,
        task_id=excluded.task_id,
        deferred_until=excluded.deferred_until,
        approved_at=excluded.approved_at,
        rejected_at=excluded.rejected_at,
        promoted_at=excluded.promoted_at,
        updated_at=excluded.updated_at,
        raw_json=excluded.raw_json
    `).run(proposalParams(proposal));
    return getProposal(proposal.decisionId);
  }

  function normalizeIncoming(body = {}) {
    const proposalType = String(body.proposalType || '').trim();
    const sourceAuthority = String(body.sourceAuthority || '').trim();
    const idempotencyKey = String(body.idempotencyKey || '').trim();
    const title = String(body.title || '').trim();
    if (!PROPOSAL_TYPES.has(proposalType)) throw Object.assign(new Error('invalid_proposal_type'), { status: 400 });
    if (!AUTHORITIES.has(sourceAuthority)) throw Object.assign(new Error('invalid_source_authority'), { status: 400 });
    if (!idempotencyKey) throw Object.assign(new Error('idempotency_key_required'), { status: 400 });
    if (!title) throw Object.assign(new Error('title_required'), { status: 400 });
    if (sourceAuthority === 'standing_rule' && !String(body.standingRuleId || '').trim()) {
      throw Object.assign(new Error('standing_rule_id_required'), { status: 400 });
    }
    if (sourceAuthority === 'standing_rule') {
      const rule = db.prepare('SELECT * FROM hq_standing_rules WHERE rule_id=? AND revoked_at IS NULL').get(String(body.standingRuleId).trim());
      if (!rule) throw Object.assign(new Error('standing_rule_not_active'), { status: 400 });
    }
    const revisionBody = {
      proposalType,
      sourceAuthority,
      standingRuleId: body.standingRuleId || null,
      title,
      content: body.content && typeof body.content === 'object' ? body.content : {},
      evidence: body.evidence && typeof body.evidence === 'object' ? body.evidence : {},
      taskSpec: body.taskSpec && typeof body.taskSpec === 'object' ? body.taskSpec : null,
      existingTaskId: body.existingTaskId || null,
      sourceRef: body.sourceRef && typeof body.sourceRef === 'object' ? body.sourceRef : {},
    };
    const revisionHash = String(body.revisionHash || '').trim()
      || stableHash(JSON.stringify(canonical(revisionBody)));
    return {
      ...body,
      ...revisionBody,
      decisionId: String(body.decisionId || `proposal-${stableHash(idempotencyKey).slice(0, 24)}`),
      idempotencyKey,
      revisionHash,
      shadowMode: body.shadowMode !== false,
    };
  }

  function updateStatus(decisionId, nextStatus, body = {}) {
    const current = getProposal(decisionId);
    if (!current) return null;
    if (current.status === 'promoted') return current;
    const timestamp = now();
    const next = {
      ...current,
      status: nextStatus,
      deferredUntil: nextStatus === 'deferred' ? body.deferredUntil : null,
      approvedAt: nextStatus === 'approved' ? (current.approvedAt || timestamp) : current.approvedAt,
      rejectedAt: nextStatus === 'rejected' ? timestamp : current.rejectedAt,
      resolution: String(body.resolution || current.resolution || ''),
      updatedAt: timestamp,
    };
    const saved = writeProposal(next);
    addEvent(saved, nextStatus, body.actor || 'user', current.status, nextStatus, {
      resolution: next.resolution,
      deferredUntil: next.deferredUntil,
    });
    return saved;
  }

  function reviewDateKey() {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date());
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  }

  function reactivateDueDeferred() {
    const dueRows = db.prepare(`
      SELECT * FROM hq_proposals
      WHERE status='deferred' AND deferred_until IS NOT NULL AND deferred_until<=?
    `).all(reviewDateKey());
    dueRows.forEach((row) => {
      const current = rowToProposal(row);
      const saved = writeProposal({ ...current, status: 'proposed', deferredUntil: null, updatedAt: now() });
      addEvent(saved, 'defer_elapsed', 'system', 'deferred', 'proposed', {});
    });
  }

  function chooseBox(taskSpec = {}) {
    if (taskSpec.boxId) return taskSpec.boxId;
    const preferred = taskSpec.role === 'primary' ? 'important' : 'misc';
    const row = db.prepare(`
      SELECT * FROM boxes
      ORDER BY CASE WHEN color=? THEN 0 ELSE 1 END, sort_order, name
      LIMIT 1
    `).get(preferred);
    return row?.id || null;
  }

  function writeTask(currentTask, proposal) {
    const spec = proposal.taskSpec || {};
    const timestamp = now();
    const role = ['primary', 'maintenance'].includes(spec.role) ? spec.role : null;
    const task = {
      ...(currentTask || {}),
      id: currentTask?.id || uid(),
      boxId: currentTask?.boxId || chooseBox(spec),
      content: String(spec.content || currentTask?.content || proposal.title).trim(),
      priority: Number(spec.priority || currentTask?.priority || (role === 'primary' ? 1 : 2)),
      progress: Number(currentTask?.progress || 0),
      isCompleted: Boolean(currentTask?.isCompleted),
      deviceContext: spec.deviceContext || currentTask?.deviceContext || 'universal',
      executionMode: spec.executionMode || currentTask?.executionMode || 'self',
      scheduledAt: spec.scheduledAt || currentTask?.scheduledAt || null,
      visibleAfter: spec.visibleAfter || currentTask?.visibleAfter || spec.scheduledAt || null,
      mainlineId: spec.mainlineId || currentTask?.mainlineId || null,
      branchId: spec.branchId || currentTask?.branchId || null,
      milestoneId: spec.milestoneId || currentTask?.milestoneId || null,
      note: spec.note || currentTask?.note || '来源：HQ审批晋升',
      syncKey: currentTask?.syncKey || `hq-proposal:${proposal.decisionId}`,
      sourceAuthority: proposal.sourceAuthority,
      standingRuleId: proposal.standingRuleId || null,
      sourceDecisionId: proposal.decisionId,
      commitmentRole: role,
      commitmentDate: role ? (spec.commitmentDate || null) : (currentTask?.commitmentDate || null),
      commitmentSource: role ? 'hq_approval' : (currentTask?.commitmentSource || null),
      pinLevel: role === 'primary' ? 1 : (role === 'maintenance' ? Number(spec.pinLevel || 2) : Number(currentTask?.pinLevel || 0)),
      pinned: Boolean(role || currentTask?.pinned),
      createdAt: currentTask?.createdAt || timestamp,
      updatedAt: timestamp,
    };
    if (currentTask) {
      db.prepare(`
        UPDATE tasks SET box_id=@box_id, content=@content, is_completed=@is_completed, sort_order=@sort_order,
          priority=@priority, weight=@weight, points_value=@points_value, progress=@progress,
          is_recurring_template=@is_recurring_template, recurrence_template_id=@recurrence_template_id,
          recurrence_key=@recurrence_key, recurrence_json=@recurrence_json, next_run_at=@next_run_at,
          occurrence_status=@occurrence_status, mainline_id=@mainline_id, branch_id=@branch_id, milestone_id=@milestone_id,
          device_context=@device_context, execution_mode=@execution_mode, visible_after=@visible_after,
          deferred_at=@deferred_at, defer_note=@defer_note, progress_logs_json=@progress_logs_json,
          scheduled_at=@scheduled_at, due_date=@due_date, deleted=@deleted, deleted_at=@deleted_at,
          note=@note, sync_key=@sync_key, completed_at=@completed_at, created_at=@created_at,
          updated_at=@updated_at, raw_json=@raw_json WHERE id=@id
      `).run(taskParams(task));
    } else {
      db.prepare(`
        INSERT INTO tasks (id, box_id, content, is_completed, sort_order, priority, weight, points_value, progress,
          is_recurring_template, recurrence_template_id, recurrence_key, recurrence_json, next_run_at, occurrence_status,
          mainline_id, branch_id, milestone_id, device_context, execution_mode, visible_after, deferred_at, defer_note,
          progress_logs_json, scheduled_at, due_date, deleted, deleted_at, note, sync_key, completed_at,
          created_at, updated_at, raw_json)
        VALUES (@id, @box_id, @content, @is_completed, @sort_order, @priority, @weight, @points_value, @progress,
          @is_recurring_template, @recurrence_template_id, @recurrence_key, @recurrence_json, @next_run_at, @occurrence_status,
          @mainline_id, @branch_id, @milestone_id, @device_context, @execution_mode, @visible_after, @deferred_at, @defer_note,
          @progress_logs_json, @scheduled_at, @due_date, @deleted, @deleted_at, @note, @sync_key, @completed_at,
          @created_at, @updated_at, @raw_json)
      `).run(taskParams(task));
    }
    return rowToTask(db.prepare('SELECT * FROM tasks WHERE id=?').get(task.id));
  }

  function promote(decisionId, body = {}) {
    const proposal = getProposal(decisionId);
    if (!proposal) return { status: 404, payload: { error: 'not_found' } };
    if (proposal.status === 'promoted') return { status: 200, payload: proposal };
    if (proposal.proposalType !== 'daily_action_proposal') {
      return { status: 409, payload: { error: 'strategic_proposal_has_no_task_promotion', proposal } };
    }
    if (proposal.status !== 'approved') return { status: 409, payload: { error: 'proposal_not_approved', proposal } };
    if (!promotionEnabled() || proposal.shadowMode || body.shadowMode === true) {
      addEvent(proposal, 'promotion_shadowed', body.actor || 'system', proposal.status, proposal.status, {
        promotionEnabled: promotionEnabled(),
      });
      return { status: 409, payload: { error: 'promotion_shadow_mode', proposal, expectedTaskAction: proposal.taskSpec || {} } };
    }
    let task = null;
    if (proposal.existingTaskId || proposal.taskId) {
      const taskRow = db.prepare('SELECT * FROM tasks WHERE id=?').get(proposal.existingTaskId || proposal.taskId);
      task = taskRow ? rowToTask(taskRow) : null;
      if (!task) return { status: 409, payload: { error: 'referenced_task_not_found', proposal } };
    } else {
      const taskRow = db.prepare('SELECT * FROM tasks WHERE sync_key=?').get(`hq-proposal:${proposal.decisionId}`);
      task = taskRow ? rowToTask(taskRow) : null;
    }
    task = writeTask(task, proposal);
    const timestamp = now();
    const saved = writeProposal({
      ...proposal,
      status: 'promoted',
      taskId: task.id,
      promotedAt: timestamp,
      updatedAt: timestamp,
    });
    const spec = proposal.taskSpec || {};
    if (spec.commitmentDate && ['primary', 'maintenance'].includes(spec.role)) {
      const briefPatch = { reviewDate: spec.commitmentDate, source: 'hq_approval' };
      if (spec.role === 'primary') briefPatch.primaryTaskId = task.id;
      else {
        const currentBrief = db.prepare('SELECT raw_json FROM hq_daily_briefs WHERE review_date=?').get(spec.commitmentDate);
        const currentIds = parseJson(currentBrief?.raw_json, {}).maintenanceTaskIds || [];
        briefPatch.maintenanceTaskIds = [...new Set([...currentIds, task.id])].slice(-2);
      }
      upsertDailyBrief(spec.commitmentDate, briefPatch);
    }
    addEvent(saved, 'promoted', body.actor || 'system', proposal.status, 'promoted', { taskId: task.id });
    return { status: 200, payload: saved };
  }

  app.get('/v1/hq/proposals', (req, res) => {
    reactivateDueDeferred();
    const statuses = String(req.query.status || '').split(',').map((value) => value.trim()).filter((value) => STATUSES.has(value));
    const proposalType = String(req.query.type || '').trim();
    const clauses = [];
    const params = [];
    if (statuses.length) {
      clauses.push(`status IN (${statuses.map(() => '?').join(',')})`);
      params.push(...statuses);
    }
    if (PROPOSAL_TYPES.has(proposalType)) {
      clauses.push('proposal_type=?');
      params.push(proposalType);
    }
    const rows = db.prepare(`SELECT * FROM hq_proposals ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY updated_at DESC`).all(...params);
    res.json(rows.map(rowToProposal));
  });

  app.get('/v1/hq/proposals/:id', (req, res) => {
    const proposal = getProposal(req.params.id);
    if (!proposal) return res.status(404).json({ error: 'not_found' });
    return res.json(proposal);
  });

  app.get('/v1/hq/proposals/:id/audit', (req, res) => {
    if (!getProposal(req.params.id)) return res.status(404).json({ error: 'not_found' });
    const events = db.prepare('SELECT * FROM hq_proposal_events WHERE decision_id=? ORDER BY created_at, rowid').all(req.params.id)
      .map((row) => ({
        eventId: row.event_id,
        decisionId: row.decision_id,
        eventType: row.event_type,
        actor: row.actor,
        fromStatus: row.from_status,
        toStatus: row.to_status,
        revision: row.revision,
        detail: parseJson(row.detail_json, {}),
        createdAt: row.created_at,
      }));
    return res.json(events);
  });

  app.post('/v1/hq/proposals', (req, res) => {
    let incoming;
    try {
      incoming = normalizeIncoming(req.body);
    } catch (error) {
      return res.status(error.status || 400).json({ error: error.message });
    }
    const existingRow = db.prepare('SELECT * FROM hq_proposals WHERE decision_id=? OR idempotency_key=?').get(incoming.decisionId, incoming.idempotencyKey);
    const existing = rowToProposal(existingRow);
    if (existing?.revisionHash === incoming.revisionHash) return res.json(existing);
    if (existing && (TERMINAL_STATUSES.has(existing.status) || (existing.status === 'deferred' && existing.deferredUntil))) {
      addEvent(existing, 'revision_ignored', req.body.actor || 'system', existing.status, existing.status, {
        incomingRevisionHash: incoming.revisionHash,
      });
      return res.json(existing);
    }
    const timestamp = now();
    const initialStatus = incoming.sourceAuthority === 'ai_derived' ? 'proposed' : 'approved';
    const proposal = {
      ...(existing || {}),
      ...incoming,
      decisionId: existing?.decisionId || incoming.decisionId,
      status: existing?.status || initialStatus,
      revision: existing ? existing.revision + 1 : 1,
      approvedAt: (existing?.approvedAt || (initialStatus === 'approved' ? timestamp : null)),
      createdAt: existing?.createdAt || timestamp,
      updatedAt: timestamp,
    };
    const saved = writeProposal(proposal);
    addEvent(saved, existing ? 'revised' : 'created', req.body.actor || 'system', existing?.status || null, saved.status, {
      revisionHash: saved.revisionHash,
      sourceAuthority: saved.sourceAuthority,
      standingRuleId: saved.standingRuleId,
      shadowMode: saved.shadowMode,
    });
    return res.status(existing ? 200 : 201).json(saved);
  });

  app.post('/v1/hq/proposals/:id/approve', (req, res) => {
    const proposal = updateStatus(req.params.id, 'approved', req.body);
    if (!proposal) return res.status(404).json({ error: 'not_found' });
    if (req.body.promote) {
      const result = promote(req.params.id, req.body);
      return res.status(result.status).json(result.payload);
    }
    return res.json(proposal);
  });

  app.post('/v1/hq/proposals/:id/reject', (req, res) => {
    const current = getProposal(req.params.id);
    if (!current) return res.status(404).json({ error: 'not_found' });
    if (current.status === 'promoted') return res.status(409).json({ error: 'promoted_proposal_is_immutable', proposal: current });
    return res.json(updateStatus(req.params.id, 'rejected', req.body));
  });

  app.post('/v1/hq/proposals/:id/defer', (req, res) => {
    const deferredUntil = String(req.body.deferredUntil || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(deferredUntil)) return res.status(400).json({ error: 'valid_deferred_until_required' });
    const current = getProposal(req.params.id);
    if (!current) return res.status(404).json({ error: 'not_found' });
    if (current.status === 'promoted') return res.status(409).json({ error: 'promoted_proposal_is_immutable', proposal: current });
    return res.json(updateStatus(req.params.id, 'deferred', { ...req.body, deferredUntil }));
  });

  app.post('/v1/hq/proposals/:id/promote', (req, res) => {
    const result = promote(req.params.id, req.body);
    return res.status(result.status).json(result.payload);
  });

  app.get('/v1/hq/standing-rules', (req, res) => {
    const includeRevoked = req.query.includeRevoked === '1';
    const rows = db.prepare(`SELECT * FROM hq_standing_rules ${includeRevoked ? '' : 'WHERE revoked_at IS NULL'} ORDER BY updated_at DESC`).all();
    res.json(rows.map((row) => ({
      ...parseJson(row.raw_json, {}),
      ruleId: row.rule_id,
      category: row.category,
      description: row.description || '',
      scope: parseJson(row.scope_json, {}),
      createdAt: row.created_at,
      revokedAt: row.revoked_at,
      updatedAt: row.updated_at,
    })));
  });

  app.post('/v1/hq/standing-rules', (req, res) => {
    const ruleId = String(req.body.ruleId || '').trim();
    const category = String(req.body.category || '').trim();
    if (!ruleId) return res.status(400).json({ error: 'rule_id_required' });
    if (!category) return res.status(400).json({ error: 'category_required' });
    const timestamp = now();
    const existing = db.prepare('SELECT * FROM hq_standing_rules WHERE rule_id=?').get(ruleId);
    if (existing?.revoked_at) return res.status(409).json({ error: 'revoked_rule_is_immutable' });
    const rule = {
      ruleId,
      category,
      description: String(req.body.description || ''),
      scope: req.body.scope && typeof req.body.scope === 'object' ? req.body.scope : {},
      createdAt: existing?.created_at || req.body.createdAt || timestamp,
      revokedAt: null,
      updatedAt: timestamp,
    };
    db.prepare(`
      INSERT INTO hq_standing_rules (rule_id, category, description, scope_json, created_at, revoked_at, updated_at, raw_json)
      VALUES (@rule_id, @category, @description, @scope_json, @created_at, NULL, @updated_at, @raw_json)
      ON CONFLICT(rule_id) DO UPDATE SET category=excluded.category, description=excluded.description,
        scope_json=excluded.scope_json, updated_at=excluded.updated_at, raw_json=excluded.raw_json
    `).run({
      rule_id: ruleId, category, description: rule.description, scope_json: json(rule.scope),
      created_at: rule.createdAt, updated_at: timestamp, raw_json: json(rule),
    });
    return res.status(existing ? 200 : 201).json(rule);
  });

  app.post('/v1/hq/standing-rules/:id/revoke', (req, res) => {
    const existing = db.prepare('SELECT * FROM hq_standing_rules WHERE rule_id=?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'not_found' });
    const revokedAt = existing.revoked_at || now();
    const raw = { ...parseJson(existing.raw_json, {}), revokedAt, updatedAt: now(), revocationReason: String(req.body.reason || '') };
    db.prepare('UPDATE hq_standing_rules SET revoked_at=?, updated_at=?, raw_json=? WHERE rule_id=?')
      .run(revokedAt, raw.updatedAt, json(raw), req.params.id);
    return res.json(raw);
  });

  return {
    listForSnapshot() {
      reactivateDueDeferred();
      return db.prepare(`
        SELECT * FROM hq_proposals
        WHERE status IN ('proposed', 'approved', 'deferred')
        ORDER BY CASE status WHEN 'proposed' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, updated_at DESC
      `).all().map(rowToProposal);
    },
  };
}

module.exports = { installHqProposalRoutes };
