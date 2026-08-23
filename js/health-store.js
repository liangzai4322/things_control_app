import {
  HEALTH_PROTOCOL_STORAGE_KEY,
  HEALTH_STORAGE_KEY,
  addSingleVariableIntervention,
  buildHealthProtocolSnapshot,
  importHealthCandidates,
  normalizeHealthProtocolStore,
  normalizeHealthStore,
  resolveHealthCandidate,
} from './health-model.js';
import { requestTaskboxApi } from './db.js';

export function readHealthStore(storage = localStorage) {
  try { return normalizeHealthStore(JSON.parse(storage.getItem(HEALTH_STORAGE_KEY) || '{}')); }
  catch { return normalizeHealthStore(); }
}

export function writeHealthStore(value, storage = localStorage) {
  const next = normalizeHealthStore({ ...value, updatedAt: new Date().toISOString() });
  storage.setItem(HEALTH_STORAGE_KEY, JSON.stringify(next));
  return next;
}

export function upsertHealthObservation(store, observation) {
  const next = normalizeHealthStore(store);
  const key = observation.observationId || `health-observation-${observation.date}-${observation.source || 'manual'}`;
  next.observations = [
    ...next.observations.filter((item) => item.observationId !== key),
    { ...observation, observationId: key, updatedAt: new Date().toISOString() },
  ];
  return normalizeHealthStore(next);
}

export function importHealthCandidateRecords(store, records, importedAt = new Date().toISOString()) {
  return importHealthCandidates(store, records, importedAt);
}

export function decideHealthCandidate(store, candidateId, decision, authorization = {}) {
  return resolveHealthCandidate(store, candidateId, decision, authorization);
}

export function beginHealthIntervention(store, intervention) {
  return addSingleVariableIntervention(store, intervention);
}

export function readHealthProtocolStore(storage = localStorage) {
  try { return normalizeHealthProtocolStore(JSON.parse(storage.getItem(HEALTH_PROTOCOL_STORAGE_KEY) || '{}')); }
  catch { return normalizeHealthProtocolStore(); }
}

export function publishHealthSnapshot(store, date, storage = localStorage, publishedAt = new Date().toISOString()) {
  const snapshot = buildHealthProtocolSnapshot(store, date, publishedAt);
  const protocol = readHealthProtocolStore(storage);
  const existing = protocol.outbox.find((item) => item.snapshotId === snapshot.snapshotId);
  if (existing) return protocol;
  const next = normalizeHealthProtocolStore({
    latest: snapshot,
    outbox: [
      ...protocol.outbox,
      { ...snapshot, deliveryStatus: 'local_pending' },
    ],
    updatedAt: publishedAt,
  });
  storage.setItem(HEALTH_PROTOCOL_STORAGE_KEY, JSON.stringify(next));
  return next;
}

export async function syncHealthFromServer(storage = localStorage) {
  const [observationsPayload, snapshotPayload] = await Promise.all([
    requestTaskboxApi('/health/observations?limit=365'),
    requestTaskboxApi('/health/snapshots/latest'),
  ]);
  if (Array.isArray(observationsPayload?.observations)) {
    const current = readHealthStore(storage);
    writeHealthStore({ ...current, observations: [...current.observations, ...observationsPayload.observations] }, storage);
  }
  if (snapshotPayload?.snapshot?.snapshotId) {
    const protocol = readHealthProtocolStore(storage);
    const snapshot = snapshotPayload.snapshot;
    const outbox = protocol.outbox.map((item) => item.snapshotId === snapshot.snapshotId
      ? { ...item, deliveryStatus: 'delivered' } : item);
    storage.setItem(HEALTH_PROTOCOL_STORAGE_KEY, JSON.stringify(normalizeHealthProtocolStore({
      ...protocol,
      latest: !protocol.latest || String(snapshot.publishedAt) >= String(protocol.latest.publishedAt) ? snapshot : protocol.latest,
      outbox,
      updatedAt: snapshot.publishedAt,
    })));
  }
  return { observations: observationsPayload?.observations?.length || 0, snapshot: snapshotPayload?.snapshot || null };
}

export async function deliverHealthProtocolOutbox(storage = localStorage) {
  const protocol = readHealthProtocolStore(storage);
  let delivered = 0;
  const outbox = [];
  for (const item of protocol.outbox) {
    if (item.deliveryStatus === 'delivered') { outbox.push(item); continue; }
    const result = await requestTaskboxApi('/health/snapshots', { method: 'POST', body: JSON.stringify(item) });
    if (!result) { outbox.push(item); continue; }
    outbox.push({ ...item, deliveryStatus: 'delivered' });
    delivered += 1;
  }
  storage.setItem(HEALTH_PROTOCOL_STORAGE_KEY, JSON.stringify(normalizeHealthProtocolStore({ ...protocol, outbox })));
  return delivered;
}
