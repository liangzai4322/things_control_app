const VALID_SOURCES = new Set(['manual', 'wearable', 'medical_record', 'daily_review']);
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function installHealthSystemRoutes({ app, db, now, json, parseJson }) {
  function date(value) {
    const text = String(value || '').trim();
    return DATE_PATTERN.test(text) ? text : '';
  }

  function normalize(value = {}) {
    const observationId = String(value.observationId || '').trim();
    const observationDate = date(value.observationDate || value.date);
    const effectiveDate = date(value.effectiveDate || observationDate);
    const source = VALID_SOURCES.has(value.source) ? value.source : '';
    const confidence = Number(value.confidence);
    if (!observationId) throw Object.assign(new Error('observation_id_required'), { status: 400 });
    if (!observationDate || !effectiveDate) throw Object.assign(new Error('observation_date_invalid'), { status: 400 });
    if (!source) throw Object.assign(new Error('observation_source_invalid'), { status: 400 });
    if (source === 'daily_review' && value.authority !== 'explicit_user') {
      throw Object.assign(new Error('daily_review_authority_invalid'), { status: 400 });
    }
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      throw Object.assign(new Error('observation_confidence_invalid'), { status: 400 });
    }
    return {
      ...value,
      observationId,
      observationDate,
      date: observationDate,
      effectiveDate,
      reviewDate: date(value.reviewDate) || null,
      source,
      sourceRef: String(value.sourceRef || '').trim() || null,
      sourceHash: String(value.sourceHash || '').trim() || null,
      authority: String(value.authority || 'explicit_user').trim(),
      confidence,
    };
  }

  function rowToObservation(row) {
    if (!row) return null;
    return {
      ...parseJson(row.raw_json, {}),
      observationId: row.observation_id,
      observationDate: row.observation_date,
      date: row.observation_date,
      effectiveDate: row.effective_date,
      reviewDate: row.review_date,
      source: row.source,
      sourceRef: row.source_ref,
      sourceHash: row.source_hash,
      authority: row.authority,
      confidence: Number(row.confidence),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  const upsert = db.prepare(`
    INSERT INTO health_observations (
      observation_id, observation_date, effective_date, review_date, source,
      source_ref, source_hash, authority, confidence, raw_json, created_at, updated_at
    ) VALUES (
      @observation_id, @observation_date, @effective_date, @review_date, @source,
      @source_ref, @source_hash, @authority, @confidence, @raw_json, @created_at, @updated_at
    )
    ON CONFLICT(observation_id) DO UPDATE SET
      observation_date=excluded.observation_date,
      effective_date=excluded.effective_date,
      review_date=excluded.review_date,
      source=excluded.source,
      source_ref=excluded.source_ref,
      source_hash=excluded.source_hash,
      authority=excluded.authority,
      confidence=excluded.confidence,
      raw_json=excluded.raw_json,
      updated_at=excluded.updated_at
  `);

  const upsertMany = db.transaction((values) => {
    let created = 0;
    let updated = 0;
    const observations = values.map(normalize).map((observation) => {
      const existing = db.prepare('SELECT created_at FROM health_observations WHERE observation_id=?').get(observation.observationId);
      const timestamp = now();
      upsert.run({
        observation_id: observation.observationId,
        observation_date: observation.observationDate,
        effective_date: observation.effectiveDate,
        review_date: observation.reviewDate,
        source: observation.source,
        source_ref: observation.sourceRef,
        source_hash: observation.sourceHash,
        authority: observation.authority,
        confidence: observation.confidence,
        raw_json: json(observation),
        created_at: existing?.created_at || timestamp,
        updated_at: timestamp,
      });
      if (existing) updated += 1;
      else created += 1;
      return rowToObservation(db.prepare('SELECT * FROM health_observations WHERE observation_id=?').get(observation.observationId));
    });
    return { created, updated, total: observations.length, observations };
  });

  app.get('/v1/health/observations', (req, res) => {
    const limit = Math.max(1, Math.min(365, Number(req.query.limit) || 90));
    const rows = db.prepare(`
      SELECT * FROM health_observations
      ORDER BY observation_date DESC, updated_at DESC
      LIMIT ?
    `).all(limit);
    return res.json({ observations: rows.map(rowToObservation), generatedAt: now() });
  });

  app.post('/v1/health/observations/batch', (req, res) => {
    const values = Array.isArray(req.body?.observations) ? req.body.observations : [];
    if (!values.length || values.length > 100) return res.status(400).json({ error: 'health_observations_invalid' });
    try {
      return res.json(upsertMany(values));
    } catch (error) {
      if (error?.status) return res.status(error.status).json({ error: error.message });
      throw error;
    }
  });

  function normalizeSnapshot(value = {}) {
    const snapshotId = String(value.snapshotId || '').trim();
    const effectiveDate = date(value.date || value.effectiveDate);
    const publishedAt = String(value.publishedAt || '').trim();
    if (!snapshotId) throw Object.assign(new Error('health_snapshot_id_required'), { status: 400 });
    if (!effectiveDate || Number.isNaN(new Date(publishedAt).getTime())) {
      throw Object.assign(new Error('health_snapshot_date_invalid'), { status: 400 });
    }
    if (value.boundaries?.createsTasks !== false || value.boundaries?.writesCalendar !== false
      || value.boundaries?.medicalDiagnosis !== false) {
      throw Object.assign(new Error('health_snapshot_boundary_invalid'), { status: 400 });
    }
    const serialized = json(value);
    if (/symptoms|private symptom|private note/i.test(serialized)) {
      throw Object.assign(new Error('health_snapshot_privacy_invalid'), { status: 400 });
    }
    return { ...value, snapshotId, date: effectiveDate, publishedAt };
  }

  app.post('/v1/health/snapshots', (req, res) => {
    try {
      const snapshot = normalizeSnapshot(req.body || {});
      const existing = db.prepare('SELECT created_at FROM health_snapshots WHERE snapshot_id=?').get(snapshot.snapshotId);
      const timestamp = now();
      db.prepare(`INSERT INTO health_snapshots
        (snapshot_id,effective_date,published_at,payload_json,created_at,updated_at)
        VALUES (@snapshot_id,@effective_date,@published_at,@payload_json,@created_at,@updated_at)
        ON CONFLICT(snapshot_id) DO UPDATE SET payload_json=excluded.payload_json, updated_at=excluded.updated_at`).run({
        snapshot_id: snapshot.snapshotId,
        effective_date: snapshot.date,
        published_at: snapshot.publishedAt,
        payload_json: json(snapshot),
        created_at: existing?.created_at || timestamp,
        updated_at: timestamp,
      });
      return res.json({ snapshot, created: !existing, updated: Boolean(existing) });
    } catch (error) {
      if (error?.status) return res.status(error.status).json({ error: error.message });
      throw error;
    }
  });

  app.get('/v1/health/snapshots/latest', (req, res) => {
    const effectiveDate = date(req.query.date);
    const row = effectiveDate
      ? db.prepare('SELECT * FROM health_snapshots WHERE effective_date<=? ORDER BY effective_date DESC, published_at DESC LIMIT 1').get(effectiveDate)
      : db.prepare('SELECT * FROM health_snapshots ORDER BY effective_date DESC, published_at DESC LIMIT 1').get();
    return res.json({ snapshot: row ? parseJson(row.payload_json, null) : null, generatedAt: now() });
  });
}

module.exports = { installHealthSystemRoutes };
