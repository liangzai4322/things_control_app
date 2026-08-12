import { buildMissionHqSnapshot } from './mission-model.js';
import { readMissionStore } from './mission-store.js';

export function readMissionHqPort({ mainlines = [], now = new Date(), storage = localStorage } = {}) {
  return buildMissionHqSnapshot(readMissionStore(storage), { mainlines, now });
}
