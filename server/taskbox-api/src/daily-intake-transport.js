const crypto = require('crypto');

const SYSTEM_IDS = new Set(['execution', 'health', 'attention', 'feedback', 'mission', 'box-app', 'life-hq', 'governance']);
const INTAKE_STATUSES = new Set(['accepted', 'processing', 'processed', 'retrying', 'failed', 'ignored']);
const RECEIPT_STATUSES = new Set(['received', 'processing', 'processed', 'retrying', 'failed', 'ignored']);

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function meaningful(value) {
  if (value === null || value === undefined || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  if (isObject(value)) return Object.values(value).some(meaningful);
  return true;
}

function error(code, status = 422, detail = {}) {
  const value = new Error(code);
  value.code = code;
  value.status = status;
  value.detail = detail;
  return value;
}

function stableHash(stableJson, value) {
  return crypto.createHash('sha256').update(stableJson(value)).digest('hex');
}

function packagesFrom(body = {}) {
  if (Array.isArray(body.packages)) return body.packages;
  if (isObject(body.sentSystems)) return Object.values(body.sentSystems);
  if (body.systemId && body.contractVersion) return [body];
  return [];
}

function normalizePackage(input, fallbackContractVersion, stableJson, validDateKey) {
  const schemaVersion = Number(input?.schemaVersion ?? 1);
  const systemId = String(input?.systemId || '').trim();
  const contractVersion = String(input?.contractVersion || fallbackContractVersion || '').trim();
  const reviewDate = validDateKey(input?.reviewDate);
  const observationPeriod = input?.observationPeriod;
  const sourceRef = input?.sourceRef;
  const evidenceRefs = input?.evidenceRefs;
  const freshness = input?.freshness;
  const revision = Number(input?.revision);
  const idempotencyKey = String(input?.idempotencyKey || '').trim();
  const data = input?.data;
  if (schemaVersion !== 1) throw error('unsupported_schema_version');
  if (!SYSTEM_IDS.has(systemId)) throw error('invalid_system_id');
  if (!contractVersion || contractVersion.length > 80) throw error('invalid_contract_version');
  if (!reviewDate) throw error('invalid_review_date');
  if (!isObject(observationPeriod)) throw error('invalid_observation_period');
  if (!meaningful(sourceRef)) throw error('invalid_source_ref');
  if (!Array.isArray(evidenceRefs)) throw error('invalid_evidence_refs');
  if (!meaningful(freshness)) throw error('invalid_freshness');
  if (!Number.isSafeInteger(revision) || revision < 1) throw error('invalid_revision');
  if (!idempotencyKey || idempotencyKey.length > 512) throw error('invalid_idempotency_key');
  if (!isObject(data) || !meaningful(data)) throw error('empty_intake_data');
  const canonical = {
    schemaVersion, contractVersion, systemId, reviewDate, observationPeriod, sourceRef,
    evidenceRefs, freshness, revision, idempotencyKey, data,
  };
  return { ...canonical, payloadHash: stableHash(stableJson, canonical) };
}

function rowToIntake(row, parseJson) {
  if (!row) return null;
  return {
    id: row.id,
    schemaVersion: Number(row.schema_version),
    contractVersion: row.contract_version,
    systemId: row.system_id,
    reviewDate: row.review_date,
    observationPeriod: parseJson(row.observation_period_json, {}),
    sourceRef: parseJson(row.source_ref_json, null),
    evidenceRefs: parseJson(row.evidence_refs_json, []),
    freshness: parseJson(row.freshness_json, 'unknown'),
    revision: Number(row.revision),
    idempotencyKey: row.idempotency_key,
    data: parseJson(row.data_json, {}),
    status: row.status,
    receivedAt: row.received_at,
    updatedAt: row.updated_at,
  };
}

function rowToReceipt(row, parseJson) {
  if (!row) return null;
  return {
    id: row.id,
    intakeId: row.intake_id,
    systemId: row.system_id,
    reviewDate: row.review_date,
    status: row.status,
    projection: parseJson(row.projection_json, {}),
    errorCode: row.error_code || null,
    errorMessage: row.error_message || null,
    retryAt: row.retry_at || null,
    attempts: Number(row.attempts) || 0,
    processedAt: row.processed_at || null,
    updatedAt: row.updated_at,
  };
}

function receiptRowFor(db, intakeId) {
  return db.prepare('SELECT * FROM system_intake_receipts WHERE intake_id=?').get(intakeId);
}

function queryRows(db, clauses, params, limit) {
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db.prepare(`
    SELECT i.*, r.id AS receipt_id, r.intake_id AS receipt_intake_id, r.system_id AS receipt_system_id,
      r.review_date AS receipt_review_date, r.status AS receipt_status, r.projection_json AS receipt_projection_json,
      r.error_code AS receipt_error_code, r.error_message AS receipt_error_message, r.retry_at AS receipt_retry_at,
      r.attempts AS receipt_attempts, r.processed_at AS receipt_processed_at, r.updated_at AS receipt_updated_at
    FROM system_intakes i LEFT JOIN system_intake_receipts r ON r.intake_id=i.id
    ${where} ORDER BY i.review_date DESC, i.revision DESC, i.received_at DESC LIMIT ?
  `).all(...params, limit);
}

function receiptFromJoinedRow(row, parseJson) {
  if (!row.receipt_id) return null;
  return rowToReceipt({
    id: row.receipt_id, intake_id: row.receipt_intake_id, system_id: row.receipt_system_id,
    review_date: row.receipt_review_date, status: row.receipt_status, projection_json: row.receipt_projection_json,
    error_code: row.receipt_error_code, error_message: row.receipt_error_message, retry_at: row.receipt_retry_at,
    attempts: row.receipt_attempts, processed_at: row.receipt_processed_at, updated_at: row.receipt_updated_at,
  }, parseJson);
}

function initializeSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS system_intakes (
      id TEXT PRIMARY KEY, system_id TEXT NOT NULL, schema_version INTEGER NOT NULL, contract_version TEXT NOT NULL,
      review_date TEXT NOT NULL, observation_period_json TEXT NOT NULL, source_ref_json TEXT NOT NULL,
      evidence_refs_json TEXT NOT NULL, freshness_json TEXT NOT NULL, revision INTEGER NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE, payload_hash TEXT NOT NULL, data_json TEXT NOT NULL,
      status TEXT NOT NULL, received_at TEXT NOT NULL, updated_at TEXT NOT NULL, raw_json TEXT NOT NULL,
      UNIQUE(system_id, review_date, revision)
    );
    CREATE INDEX IF NOT EXISTS idx_system_intakes_system_date ON system_intakes(system_id, review_date DESC, revision DESC);
    CREATE TABLE IF NOT EXISTS system_intake_receipts (
      id TEXT PRIMARY KEY, intake_id TEXT NOT NULL UNIQUE, system_id TEXT NOT NULL, review_date TEXT NOT NULL,
      status TEXT NOT NULL, projection_json TEXT NOT NULL, error_code TEXT, error_message TEXT, retry_at TEXT,
      attempts INTEGER NOT NULL DEFAULT 0, processed_at TEXT, updated_at TEXT NOT NULL, raw_json TEXT NOT NULL,
      FOREIGN KEY (intake_id) REFERENCES system_intakes(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_system_intake_receipts_date ON system_intake_receipts(system_id, review_date DESC, updated_at DESC);
    CREATE TABLE IF NOT EXISTS system_intake_receipt_requests (
      idempotency_key TEXT PRIMARY KEY, receipt_id TEXT NOT NULL, request_hash TEXT NOT NULL, created_at TEXT NOT NULL,
      FOREIGN KEY (receipt_id) REFERENCES system_intake_receipts(id) ON DELETE CASCADE
    );
  `);
}

function createTransport({ app, db, now, uid, json, parseJson, stableJson, validDateKey, authorizeDailyIntake }) {
  initializeSchema(db);
  const isIntakeRead = (req) => String(req.query?.intake || '') === '1';
  const isIntakeBatch = (req) => Array.isArray(req.body?.packages) || isObject(req.body?.sentSystems) || Boolean(req.body?.contractVersion && req.body?.systemId);
  const authorize = (req, res, scope, systemId = null) => {
    const result = authorizeDailyIntake(req, scope, systemId);
    if (result.ok) return true;
    res.status(result.status).json({ error: result.error });
    return false;
  };

  const list = (req, res) => {
    const systemId = String(req.query.systemId || '').trim();
    if (!authorize(req, res, 'intakes:read', systemId)) return;
    const reviewDate = String(req.query.reviewDate || '').trim();
    const status = String(req.query.status || '').trim();
    if (!SYSTEM_IDS.has(systemId)) return res.status(400).json({ error: 'invalid_system_id' });
    if (reviewDate && !validDateKey(reviewDate)) return res.status(400).json({ error: 'invalid_review_date' });
    if (status && !INTAKE_STATUSES.has(status)) return res.status(400).json({ error: 'invalid_intake_status' });
    const clauses = ['i.system_id=?']; const params = [systemId];
    if (reviewDate) { clauses.push('i.review_date=?'); params.push(reviewDate); }
    if (status) { clauses.push('i.status=?'); params.push(status); }
    const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50));
    const intakes = queryRows(db, clauses, params, limit).map((row) => ({
      ...rowToIntake(row, parseJson), receipt: receiptFromJoinedRow(row, parseJson),
    }));
    return res.json({ systemId, intakes, count: intakes.length });
  };

  const receive = (req, res) => {
    if (!authorize(req, res, 'intakes:write')) return;
    const packages = packagesFrom(req.body);
    if (!packages.length || packages.length > 50) return res.status(422).json({ error: 'invalid_batch_size', max: 50 });
    const accepted = []; const rejected = [];
    packages.forEach((input, index) => {
      try {
        const intake = normalizePackage(input, req.body?.contractVersion, stableJson, validDateKey);
        const byKey = db.prepare('SELECT * FROM system_intakes WHERE idempotency_key=?').get(intake.idempotencyKey);
        if (byKey) {
          if (byKey.payload_hash !== intake.payloadHash) throw error('idempotency_key_conflict', 409);
          accepted.push({ index, intake: rowToIntake(byKey, parseJson), receipt: rowToReceipt(receiptRowFor(db, byKey.id), parseJson), idempotent: true });
          return;
        }
        const byRevision = db.prepare('SELECT * FROM system_intakes WHERE system_id=? AND review_date=? AND revision=?')
          .get(intake.systemId, intake.reviewDate, intake.revision);
        if (byRevision) {
          if (byRevision.payload_hash !== intake.payloadHash) throw error('revision_conflict', 409, { intakeId: byRevision.id });
          accepted.push({ index, intake: rowToIntake(byRevision, parseJson), receipt: rowToReceipt(receiptRowFor(db, byRevision.id), parseJson), idempotent: true });
          return;
        }
        const timestamp = now(); const id = uid(); const receiptId = uid();
        db.transaction(() => {
          db.prepare(`INSERT INTO system_intakes (
            id,system_id,schema_version,contract_version,review_date,observation_period_json,source_ref_json,evidence_refs_json,
            freshness_json,revision,idempotency_key,payload_hash,data_json,status,received_at,updated_at,raw_json
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'accepted',?,?,?)`).run(
            id, intake.systemId, intake.schemaVersion, intake.contractVersion, intake.reviewDate, json(intake.observationPeriod),
            json(intake.sourceRef), json(intake.evidenceRefs), json(intake.freshness), intake.revision, intake.idempotencyKey,
            intake.payloadHash, json(intake.data), timestamp, timestamp, json(intake),
          );
          db.prepare(`INSERT INTO system_intake_receipts (
            id,intake_id,system_id,review_date,status,projection_json,attempts,updated_at,raw_json
          ) VALUES (?,?,?,?, 'received', ?,0,?,?)`).run(
            receiptId, id, intake.systemId, intake.reviewDate,
            json({ intakeRef: id, sourceRef: intake.sourceRef, freshness: intake.freshness }), timestamp,
            json({ intakeRef: id, status: 'received' }),
          );
        })();
        accepted.push({ index, intake: rowToIntake(db.prepare('SELECT * FROM system_intakes WHERE id=?').get(id), parseJson), receipt: rowToReceipt(receiptRowFor(db, id), parseJson), idempotent: false });
      } catch (cause) {
        rejected.push({ index, systemId: String(input?.systemId || ''), error: cause.code || 'invalid_intake', detail: cause.detail || {} });
      }
    });
    return res.status(rejected.length ? 207 : 201).json({ status: rejected.length ? (accepted.length ? 'partial' : 'rejected') : 'accepted', accepted, rejected });
  };

  const recordReceipt = (req, res) => {
    if (!authorize(req, res, 'receipts:write')) return;
    const intake = db.prepare('SELECT * FROM system_intakes WHERE id=?').get(req.params.id);
    if (!intake) return res.status(404).json({ error: 'system_intake_not_found' });
    if (!authorize(req, res, 'receipts:write', intake.system_id)) return;
    const status = String(req.body?.status || '').trim(); const idempotencyKey = String(req.body?.idempotencyKey || '').trim();
    const projection = req.body?.projection;
    if (!RECEIPT_STATUSES.has(status)) return res.status(422).json({ error: 'invalid_receipt_status' });
    if (!idempotencyKey || idempotencyKey.length > 512) return res.status(422).json({ error: 'invalid_idempotency_key' });
    if (!isObject(projection) && !Array.isArray(projection)) return res.status(422).json({ error: 'invalid_receipt_projection' });
    const errorCode = req.body?.errorCode == null ? null : String(req.body.errorCode).slice(0, 160);
    const errorMessage = req.body?.errorMessage == null ? null : String(req.body.errorMessage).slice(0, 1200);
    const retryAt = req.body?.retryAt == null ? null : String(req.body.retryAt).slice(0, 80);
    const requestHash = stableHash(stableJson, { intakeId: intake.id, status, projection, errorCode, errorMessage, retryAt });
    const previousRequest = db.prepare('SELECT * FROM system_intake_receipt_requests WHERE idempotency_key=?').get(idempotencyKey);
    if (previousRequest) {
      if (previousRequest.request_hash !== requestHash) return res.status(409).json({ error: 'idempotency_key_conflict' });
      return res.json({ receipt: rowToReceipt(db.prepare('SELECT * FROM system_intake_receipts WHERE id=?').get(previousRequest.receipt_id), parseJson), idempotent: true });
    }
    const current = receiptRowFor(db, intake.id); const timestamp = now(); const receiptId = current?.id || uid();
    const receipt = { id: receiptId, intakeId: intake.id, systemId: intake.system_id, reviewDate: intake.review_date, status, projection,
      errorCode, errorMessage, retryAt, attempts: Number(current?.attempts || 0) + 1,
      processedAt: ['processed', 'ignored'].includes(status) ? timestamp : (current?.processed_at || null), updatedAt: timestamp };
    db.transaction(() => {
      db.prepare(`INSERT INTO system_intake_receipts (
        id,intake_id,system_id,review_date,status,projection_json,error_code,error_message,retry_at,attempts,processed_at,updated_at,raw_json
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(intake_id) DO UPDATE SET
        status=excluded.status,projection_json=excluded.projection_json,error_code=excluded.error_code,error_message=excluded.error_message,
        retry_at=excluded.retry_at,attempts=excluded.attempts,processed_at=excluded.processed_at,updated_at=excluded.updated_at,raw_json=excluded.raw_json`).run(
        receipt.id, receipt.intakeId, receipt.systemId, receipt.reviewDate, receipt.status, json(receipt.projection), receipt.errorCode,
        receipt.errorMessage, receipt.retryAt, receipt.attempts, receipt.processedAt, receipt.updatedAt, json(receipt));
      db.prepare('UPDATE system_intakes SET status=?, updated_at=? WHERE id=?').run(status === 'received' ? 'accepted' : status, timestamp, intake.id);
      db.prepare('INSERT INTO system_intake_receipt_requests (idempotency_key,receipt_id,request_hash,created_at) VALUES (?,?,?,?)')
        .run(idempotencyKey, receipt.id, requestHash, timestamp);
    })();
    return res.status(201).json({ receipt: rowToReceipt(db.prepare('SELECT * FROM system_intake_receipts WHERE id=?').get(receipt.id), parseJson), idempotent: false });
  };

  app.post('/v1/system-candidates/:id/receipt', recordReceipt);
  app.get('/v1/hq/system-receipts', (req, res) => {
    if (!authorize(req, res, 'receipts:read')) return;
    const clauses = []; const params = [];
    const reviewDate = String(req.query.reviewDate || '').trim(); const systemId = String(req.query.systemId || '').trim();
    if (reviewDate) { if (!validDateKey(reviewDate)) return res.status(400).json({ error: 'invalid_review_date' }); clauses.push('r.review_date=?'); params.push(reviewDate); }
    if (systemId) { if (!SYSTEM_IDS.has(systemId)) return res.status(400).json({ error: 'invalid_system_id' }); clauses.push('r.system_id=?'); params.push(systemId); }
    const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50)); const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = db.prepare(`SELECT r.*,i.contract_version,i.source_ref_json,i.evidence_refs_json,i.freshness_json,i.revision,i.idempotency_key AS intake_idempotency_key
      FROM system_intake_receipts r JOIN system_intakes i ON i.id=r.intake_id ${where}
      ORDER BY r.review_date DESC,r.updated_at DESC LIMIT ?`).all(...params, limit);
    return res.json({ receipts: rows.map((row) => ({ ...rowToReceipt(row, parseJson), contractVersion: row.contract_version,
      sourceRef: parseJson(row.source_ref_json, null), evidenceRefs: parseJson(row.evidence_refs_json, []), freshness: parseJson(row.freshness_json, 'unknown'),
      revision: Number(row.revision), intakeIdempotencyKey: row.intake_idempotency_key })) });
  });
  return { isIntakeRead, isIntakeBatch, list, receive };
}

module.exports = { createTransport };
