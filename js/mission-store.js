import { MISSION_STORAGE_KEY, normalizeMissionStore } from './mission-model.js';
import { requestTaskboxApi } from './db.js';

export const MISSION_SYNC_STORAGE_KEY = 'taskbox_mission_sync_v1';

const readSyncMeta = (storage) => {
  try { return JSON.parse(storage.getItem(MISSION_SYNC_STORAGE_KEY) || '{}'); }
  catch { return {}; }
};

const persistMissionStore = (value, storage) => {
  const next = normalizeMissionStore(value);
  storage.setItem(MISSION_STORAGE_KEY, JSON.stringify(next));
  return next;
};

export function buildMissionSyncPayload(value, revisions = {}) {
  const store = normalizeMissionStore(value);
  const missionId = store.draft.missionId;
  return {
    records: [
      {
        recordId: missionId, recordType: 'draft', missionId,
        idempotencyKey: `mission:draft:${missionId}`,
        expectedRevision: revisions[`record:${missionId}`] || 0,
        payload: {
          schemaVersion: store.schemaVersion, draft: store.draft, activeVersion: store.activeVersion,
          reviewContext: store.reviewContext, updatedAt: store.updatedAt,
        },
      },
      ...store.history.map((item) => ({
        recordId: item.versionId, recordType: 'version', missionId: item.snapshot.missionId,
        idempotencyKey: `mission:version:${item.versionId}`,
        expectedRevision: revisions[`record:${item.versionId}`] || 0,
        payload: item,
      })),
    ],
    candidates: store.candidateInbox.map((item) => ({
      candidateId: item.candidateId,
      idempotencyKey: `mission:candidate:${item.candidateId}`,
      expectedRevision: revisions[`candidate:${item.candidateId}`] || 0,
      payload: item,
    })),
    events: store.events.map((item) => ({
      eventId: item.eventId, operationId: item.eventId,
      recordId: store.history.find((version) => version.version === item.version)?.versionId || null,
      payload: item,
    })),
  };
}

function queueMissionSync(store, storage) {
  const meta = readSyncMeta(storage);
  const generation = Math.max(0, Number(meta.generation) || 0) + 1;
  storage.setItem(MISSION_SYNC_STORAGE_KEY, JSON.stringify({
    ...meta, generation, status: 'pending', pending: buildMissionSyncPayload(store, meta.revisions || {}),
  }));
  if (storage === globalThis.localStorage) queueMicrotask(() => flushMissionSyncOutbox(storage).catch(() => {}));
}

export function readMissionStore(storage = localStorage) {
  try { return normalizeMissionStore(JSON.parse(storage.getItem(MISSION_STORAGE_KEY) || '{}')); }
  catch { return normalizeMissionStore(); }
}

export function writeMissionStore(value, storage = localStorage) {
  const next = normalizeMissionStore({ ...value, updatedAt: new Date().toISOString() });
  persistMissionStore(next, storage);
  queueMissionSync(next, storage);
  return next;
}

export async function flushMissionSyncOutbox(storage = localStorage) {
  const before = readSyncMeta(storage);
  if (!before.pending) return 0;
  try {
    const result = await requestTaskboxApi('/mission/sync', { method: 'POST', body: JSON.stringify(before.pending) });
    if (!result) return 0;
    const revisions = { ...(before.revisions || {}) };
    result.records?.forEach((item) => { revisions[`record:${item.recordId}`] = item.revision; });
    result.candidates?.forEach((item) => { revisions[`candidate:${item.candidateId}`] = item.revision; });
    const current = readSyncMeta(storage);
    storage.setItem(MISSION_SYNC_STORAGE_KEY, JSON.stringify({
      ...current, revisions, status: 'synced', lastSyncedAt: new Date().toISOString(),
      pending: current.generation === before.generation ? null : buildMissionSyncPayload(readMissionStore(storage), revisions),
    }));
    if (current.generation !== before.generation) return 1 + await flushMissionSyncOutbox(storage);
    return 1;
  } catch (error) {
    const current = readSyncMeta(storage);
    storage.setItem(MISSION_SYNC_STORAGE_KEY, JSON.stringify({
      ...current, status: error?.status === 409 ? 'conflict' : 'offline', lastError: error?.message || 'mission_sync_failed',
    }));
    throw error;
  }
}

export async function syncMissionFromServer(storage = localStorage) {
  await flushMissionSyncOutbox(storage).catch(() => {});
  if (readSyncMeta(storage).pending) return 'pending';
  const result = await requestTaskboxApi('/mission/state');
  if (!result) return 'local';
  const meta = readSyncMeta(storage);
  storage.setItem(MISSION_SYNC_STORAGE_KEY, JSON.stringify({ ...meta, revisions: result.revisions || {}, status: 'synced' }));
  if (result.store) {
    const cloud = normalizeMissionStore(result.store);
    const local = readMissionStore(storage);
    if (JSON.stringify(cloud) !== JSON.stringify(local)) {
      persistMissionStore(cloud, storage);
      return 'merged';
    }
    return 'synced';
  }
  const local = readMissionStore(storage);
  if (local.history.length || local.candidateInbox.length || local.draft.statement || local.draft.campaign.title) {
    queueMissionSync(local, storage);
    await flushMissionSyncOutbox(storage).catch(() => {});
  }
  return 'synced';
}
