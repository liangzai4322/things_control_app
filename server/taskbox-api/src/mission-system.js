const crypto = require('crypto');

const STANDING_RULE_ID = 'mission-hq-specific-actions-2026-08-23';
const RECORD_TYPES = new Set(['draft', 'version']);
const CANDIDATE_STATUSES = new Set(['unreviewed', 'ignored', 'observing', 'included_in_draft']);

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value ?? null);
}

function contentHash(value) {
  return crypto.createHash('sha256').update(stableJson(value)).digest('hex');
}

function httpError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function validApproval(historyItem = {}) {
  const approval = historyItem.approval || {};
  if (approval.sourceAuthority === 'explicit_user') return true;
  return approval.sourceAuthority === 'standing_rule'
    && approval.standingRuleId === STANDING_RULE_ID
    && approval.action === 'publish_mission_version'
    && approval.objectId === historyItem.snapshot?.missionId
    && Boolean(String(approval.expectedResult || '').trim());
}

function validCandidateDecision(candidate = {}) {
  const decision = candidate.decision || {};
  if (decision.status === 'unreviewed') return true;
  if (decision.decidedBy === 'explicit_user') return true;
  return decision.decidedBy === 'standing_rule'
    && decision.standingRuleId === STANDING_RULE_ID
    && decision.action === `decide_mission_candidate:${decision.status}`
    && decision.objectId === candidate.candidateId
    && Boolean(String(decision.expectedResult || '').trim());
}

function installMissionSystemRoutes({ app, db, now, json, parseJson, authorizeDailyIntake }) {
  function authorizeState(req, res) {
    if (!req.dailyIntakeIdentity) return true;
    const result = authorizeDailyIntake(req, 'mission-state:read', 'mission');
    if (result.ok) return true;
    res.status(result.status).json({ error: result.error });
    return false;
  }
  const recordUpsert = db.prepare(`
    INSERT INTO mission_records (
      record_id, record_type, mission_id, version, status, revision, content_hash,
      idempotency_key, payload_json, created_at, updated_at
    ) VALUES (
      @record_id, @record_type, @mission_id, @version, @status, @revision, @content_hash,
      @idempotency_key, @payload_json, @created_at, @updated_at
    ) ON CONFLICT(record_id) DO UPDATE SET
      status=excluded.status, revision=excluded.revision, content_hash=excluded.content_hash,
      payload_json=excluded.payload_json, updated_at=excluded.updated_at
  `);
  const candidateUpsert = db.prepare(`
    INSERT INTO mission_candidates (
      candidate_id, status, revision, content_hash, idempotency_key, payload_json, created_at, updated_at
    ) VALUES (
      @candidate_id, @status, @revision, @content_hash, @idempotency_key, @payload_json, @created_at, @updated_at
    ) ON CONFLICT(candidate_id) DO UPDATE SET
      status=excluded.status, revision=excluded.revision, content_hash=excluded.content_hash,
      payload_json=excluded.payload_json, updated_at=excluded.updated_at
  `);

  function normalizeRecord(value = {}) {
    const recordId = String(value.recordId || '').trim();
    const recordType = String(value.recordType || '').trim();
    const missionId = String(value.missionId || '').trim();
    const payload = value.payload && typeof value.payload === 'object' ? value.payload : null;
    if (!recordId || !missionId || !RECORD_TYPES.has(recordType) || !payload) throw httpError('mission_record_invalid');
    if (!String(value.idempotencyKey || '').trim()) throw httpError('idempotency_key_required');
    if (recordType === 'version' && !validApproval(payload)) throw httpError('mission_version_authority_invalid');
    return { ...value, recordId, recordType, missionId, payload, expectedRevision: Math.max(0, Number(value.expectedRevision) || 0) };
  }

  function saveRecord(value) {
    const record = normalizeRecord(value);
    const existing = db.prepare('SELECT * FROM mission_records WHERE record_id=?').get(record.recordId);
    const hash = contentHash(record.payload);
    if (existing?.content_hash === hash) return { recordId: record.recordId, revision: existing.revision, unchanged: true };
    if (existing && record.recordType === 'version') throw httpError('mission_version_immutable', 409);
    if ((existing?.revision || 0) !== record.expectedRevision) throw httpError('mission_revision_conflict', 409);
    const revision = (existing?.revision || 0) + 1;
    const timestamp = now();
    recordUpsert.run({
      record_id: record.recordId, record_type: record.recordType, mission_id: record.missionId,
      version: record.recordType === 'version' ? Math.max(1, Number(record.payload.version) || 1) : null,
      status: record.recordType === 'version' ? 'published' : 'draft', revision, content_hash: hash,
      idempotency_key: String(record.idempotencyKey).trim(), payload_json: json(record.payload),
      created_at: existing?.created_at || timestamp, updated_at: timestamp,
    });
    db.prepare(`INSERT INTO mission_record_versions
      (record_id,revision,content_hash,payload_json,created_at) VALUES (?,?,?,?,?)`)
      .run(record.recordId, revision, hash, json(record.payload), timestamp);
    return { recordId: record.recordId, revision, unchanged: false };
  }

  function saveCandidate(value = {}) {
    const candidateId = String(value.candidateId || value.payload?.candidateId || '').trim();
    const payload = value.payload && typeof value.payload === 'object' ? value.payload : null;
    const status = String(payload?.decision?.status || '').trim();
    if (!candidateId || !payload || payload.candidateId !== candidateId || !CANDIDATE_STATUSES.has(status)) throw httpError('mission_candidate_invalid');
    if (!String(value.idempotencyKey || '').trim()) throw httpError('idempotency_key_required');
    if (!validCandidateDecision(payload)) throw httpError('mission_candidate_authority_invalid');
    const existing = db.prepare('SELECT * FROM mission_candidates WHERE candidate_id=?').get(candidateId);
    const hash = contentHash(payload);
    if (existing?.content_hash === hash) return { candidateId, revision: existing.revision, unchanged: true };
    if (existing && existing.status !== 'unreviewed' && status === 'unreviewed') return { candidateId, revision: existing.revision, unchanged: true };
    const expectedRevision = Math.max(0, Number(value.expectedRevision) || 0);
    if ((existing?.revision || 0) !== expectedRevision) throw httpError('mission_candidate_revision_conflict', 409);
    const revision = (existing?.revision || 0) + 1;
    const timestamp = now();
    candidateUpsert.run({
      candidate_id: candidateId, status, revision, content_hash: hash,
      idempotency_key: String(value.idempotencyKey).trim(), payload_json: json(payload),
      created_at: existing?.created_at || timestamp, updated_at: timestamp,
    });
    return { candidateId, revision, unchanged: false };
  }

  function saveEvent(value = {}) {
    const payload = value.payload && typeof value.payload === 'object' ? value.payload : null;
    const eventId = String(value.eventId || payload?.eventId || '').trim();
    const operationId = String(value.operationId || eventId).trim();
    const recordId = String(value.recordId || '').trim();
    if (!eventId || !operationId || !recordId || !payload?.type) throw httpError('mission_event_invalid');
    if (!db.prepare("SELECT 1 FROM mission_records WHERE record_id=? AND record_type='version'").get(recordId)) {
      throw httpError('mission_event_version_missing');
    }
    const existing = db.prepare('SELECT payload_json FROM mission_events WHERE event_id=? OR operation_id=?').get(eventId, operationId);
    if (existing) {
      if (contentHash(parseJson(existing.payload_json, {})) !== contentHash(payload)) throw httpError('mission_event_conflict', 409);
      return { eventId, unchanged: true };
    }
    db.prepare(`INSERT INTO mission_events
      (event_id,operation_id,record_id,event_type,payload_json,created_at) VALUES (?,?,?,?,?,?)`)
      .run(eventId, operationId, recordId, payload.type, json(payload), now());
    return { eventId, unchanged: false };
  }

  const sync = db.transaction((body = {}) => {
    const records = Array.isArray(body.records) ? body.records : [];
    const candidates = Array.isArray(body.candidates) ? body.candidates : [];
    const events = Array.isArray(body.events) ? body.events : [];
    if (records.length > 200 || candidates.length > 500 || events.length > 500) throw httpError('mission_sync_too_large');
    return {
      records: records.map(saveRecord),
      candidates: candidates.map(saveCandidate),
      events: events.map(saveEvent),
    };
  });

  app.post('/v1/mission/sync', (req, res) => {
    try { return res.json(sync(req.body || {})); }
    catch (error) {
      if (error?.status) return res.status(error.status).json({ error: error.message });
      throw error;
    }
  });

  app.get('/v1/mission/state', (req, res) => {
    if (!authorizeState(req, res)) return;
    const records = db.prepare('SELECT * FROM mission_records ORDER BY record_type, version, updated_at').all();
    const draftRow = records.filter((row) => row.record_type === 'draft').sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
    const draftPayload = parseJson(draftRow?.payload_json, {});
    const history = records.filter((row) => row.record_type === 'version').map((row) => parseJson(row.payload_json, null)).filter(Boolean).sort((a, b) => a.version - b.version);
    const candidateRows = db.prepare('SELECT * FROM mission_candidates ORDER BY updated_at').all();
    const eventRows = db.prepare('SELECT * FROM mission_events ORDER BY created_at').all();
    const revisions = Object.fromEntries([
      ...records.map((row) => [`record:${row.record_id}`, row.revision]),
      ...candidateRows.map((row) => [`candidate:${row.candidate_id}`, row.revision]),
    ]);
    return res.json({
      store: records.length || candidateRows.length || eventRows.length ? {
        schemaVersion: draftPayload.schemaVersion || 3,
        draft: draftPayload.draft || {}, activeVersion: draftPayload.activeVersion ?? null,
        reviewContext: draftPayload.reviewContext || {}, history,
        candidateInbox: candidateRows.map((row) => parseJson(row.payload_json, null)).filter(Boolean),
        events: eventRows.map((row) => parseJson(row.payload_json, null)).filter(Boolean),
        updatedAt: draftPayload.updatedAt || draftRow?.updated_at || null,
      } : null,
      revisions,
      generatedAt: now(),
    });
  });
}

module.exports = { installMissionSystemRoutes };
