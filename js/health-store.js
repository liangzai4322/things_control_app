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
