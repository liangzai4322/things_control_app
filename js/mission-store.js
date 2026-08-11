import { MISSION_STORAGE_KEY, normalizeMissionStore } from './mission-model.js';

export function readMissionStore(storage = localStorage) {
  try { return normalizeMissionStore(JSON.parse(storage.getItem(MISSION_STORAGE_KEY) || '{}')); }
  catch { return normalizeMissionStore(); }
}

export function writeMissionStore(value, storage = localStorage) {
  const next = normalizeMissionStore({ ...value, updatedAt: new Date().toISOString() });
  storage.setItem(MISSION_STORAGE_KEY, JSON.stringify(next));
  return next;
}
