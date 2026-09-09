const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const dbPath = path.join(os.tmpdir(), `taskbox-mission-api-${process.pid}-${Date.now()}.sqlite`);
const port = 3900 + (process.pid % 100);
const token = 'mission-integration-test-token';
let serverError = '';

function request(route, method = 'GET', payload = null) {
  return new Promise((resolve, reject) => {
    const body = payload == null ? null : Buffer.from(JSON.stringify(payload));
    const req = http.request({ hostname: '127.0.0.1', port, path: route, method, headers: {
      Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(body ? { 'Content-Length': body.length } : {}),
    } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        const result = text ? JSON.parse(text) : null;
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(Object.assign(new Error(result?.error || text), { status: res.statusCode }));
        return resolve(result);
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const child = spawn(process.execPath, [path.join(root, 'src', 'server.js')], {
  cwd: root,
  env: { ...process.env, TASKBOX_DB_PATH: dbPath, TASKBOX_API_PORT: String(port), TASKBOX_API_TOKEN: token },
  stdio: ['ignore', 'ignore', 'pipe'],
});
child.stderr.on('data', (chunk) => { serverError += chunk.toString('utf8'); });

async function waitForServer() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { return await request('/health'); } catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
  }
  throw new Error(`server did not start: ${serverError}`);
}

(async () => {
  try {
    await waitForServer();
    const snapshot = {
      missionId: 'mission-cloud-test', statement: '建设可持续人生系统', constraints: [], nonNegotiables: [], notDoing: [], portfolio: {},
      campaign: { campaignId: 'campaign-cloud-test', title: '跑通云端使命闭环', whyNow: '消除单设备故障', successConditions: ['云端可读'], exitConditions: ['审计丢失'], reviewAt: '2026-09-23' },
    };
    const historyItem = {
      version: 1, versionId: 'mission-cloud-test:v1', activatedAt: '2026-08-23T08:00:00.000Z', snapshot,
      approval: { approvalId: 'mission-approval-v1', sourceAuthority: 'standing_rule', standingRuleId: 'mission-hq-specific-actions-2026-08-23', action: 'publish_mission_version', objectId: 'mission-cloud-test', expectedResult: '发布为唯一活动使命', approvedAt: '2026-08-23T08:00:00.000Z' },
      evidenceChain: { triggerDecision: '启用云端使命闭环', candidateRefs: [], externalEvidenceRefs: [], judgmentChanges: { retained: [], withdrawn: [], replaced: [] }, approvedBy: 'standing_rule', approvedAt: '2026-08-23T08:00:00.000Z' },
    };
    const candidate = { candidateId: 'mission-candidate-cloud', domain: 'mission', v2Layer: 'claim', content: '云端候选', decision: { status: 'unreviewed', decidedAt: null, decidedBy: null, publishedVersionId: null } };
    const event = { eventId: 'mission:v1:MissionVersionActivated', type: 'MissionVersionActivated', version: 1, occurredAt: '2026-08-23T08:00:00.000Z', subjectId: 'mission-cloud-test', payload: {} };
    const firstPayload = {
      records: [
        { recordId: 'mission-cloud-test', recordType: 'draft', missionId: 'mission-cloud-test', idempotencyKey: 'mission:draft:mission-cloud-test', expectedRevision: 0, payload: { schemaVersion: 3, draft: snapshot, activeVersion: 1, reviewContext: {}, updatedAt: '2026-08-23T08:00:00.000Z' } },
        { recordId: historyItem.versionId, recordType: 'version', missionId: 'mission-cloud-test', idempotencyKey: `mission:version:${historyItem.versionId}`, expectedRevision: 0, payload: historyItem },
      ],
      candidates: [{ candidateId: candidate.candidateId, idempotencyKey: `mission:candidate:${candidate.candidateId}`, expectedRevision: 0, payload: candidate }],
      events: [{ eventId: event.eventId, operationId: event.eventId, recordId: historyItem.versionId, payload: event }],
    };
    const first = await request('/v1/mission/sync', 'POST', firstPayload);
    const repeated = await request('/v1/mission/sync', 'POST', firstPayload);
    if (first.records.some((item) => item.unchanged) || repeated.records.some((item) => !item.unchanged)) throw new Error('mission record sync is not idempotent');

    const decided = { ...candidate, decision: {
      status: 'included_in_draft', decidedAt: '2026-08-23T08:05:00.000Z', decidedBy: 'standing_rule',
      standingRuleId: 'mission-hq-specific-actions-2026-08-23', action: 'decide_mission_candidate:included_in_draft',
      objectId: candidate.candidateId, expectedResult: '纳入使命草稿证据链', publishedVersionId: null,
    } };
    const updated = await request('/v1/mission/sync', 'POST', {
      records: [], events: [], candidates: [{ candidateId: candidate.candidateId, idempotencyKey: `mission:candidate:${candidate.candidateId}`, expectedRevision: 1, payload: decided }],
    });
    if (updated.candidates[0].revision !== 2) throw new Error('mission candidate revision did not advance');

    let conflict = false;
    try {
      await request('/v1/mission/sync', 'POST', {
        candidates: [], events: [], records: [{ ...firstPayload.records[0], payload: { ...firstPayload.records[0].payload, activeVersion: null } }],
      });
    } catch (error) { conflict = error.status === 409 && error.message === 'mission_revision_conflict'; }
    if (!conflict) throw new Error('stale mission revision must conflict');

    let rejectedAi = false;
    try {
      await request('/v1/mission/sync', 'POST', {
        candidates: [], events: [], records: [{ ...firstPayload.records[1], recordId: 'mission-cloud-test:v2', idempotencyKey: 'mission:version:mission-cloud-test:v2', payload: { ...historyItem, version: 2, versionId: 'mission-cloud-test:v2', approval: { sourceAuthority: 'ai_derived' } } }],
      });
    } catch (error) { rejectedAi = error.status === 400 && error.message === 'mission_version_authority_invalid'; }
    if (!rejectedAi) throw new Error('AI-derived mission version must be rejected');

    let rejectedOrphanEvent = false;
    try {
      await request('/v1/mission/sync', 'POST', {
        records: [], candidates: [], events: [{ eventId: 'orphan-event', operationId: 'orphan-event', recordId: 'missing:v1', payload: { eventId: 'orphan-event', type: 'MissionVersionActivated' } }],
      });
    } catch (error) { rejectedOrphanEvent = error.status === 400 && error.message === 'mission_event_version_missing'; }
    if (!rejectedOrphanEvent) throw new Error('orphan mission event must be rejected');

    const state = await request('/v1/mission/state');
    if (state.store.activeVersion !== 1 || state.store.history.length !== 1 || state.store.candidateInbox[0].decision.status !== 'included_in_draft' || state.store.events.length !== 1) {
      throw new Error('mission cloud state reconstruction mismatch');
    }
    console.log('mission api integration tests passed');
  } finally {
    child.kill('SIGTERM');
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.rmSync(`${dbPath}${suffix}`, { force: true }); } catch {}
    }
  }
})().catch((error) => {
  console.error(error.stack || error.message, serverError);
  process.exitCode = 1;
});
