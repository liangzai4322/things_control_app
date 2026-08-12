import { buildTimeAttentionSnapshot } from './time-attention-model.js';
import { readTimeStore } from './time-attention-store.js';

export function readTimeAttentionHqPort({ tasks = [], healthSnapshot = {}, date, now = new Date(), storage = localStorage } = {}) {
  return buildTimeAttentionSnapshot({ store: readTimeStore(storage), tasks, healthSnapshot, date, now });
}
