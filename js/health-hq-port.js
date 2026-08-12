import { buildHealthHqSnapshot } from './health-model.js';
import { readHealthProtocolStore } from './health-store.js';

export function readHealthHqPort({ now = new Date(), storage = localStorage } = {}) {
  return buildHealthHqSnapshot(readHealthProtocolStore(storage), { now });
}
