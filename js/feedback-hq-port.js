import { buildFeedbackHqSummary } from './feedback-model.js';
import { readFeedbackStore } from './feedback-store.js';

export function readFeedbackHqPort({ storage = localStorage } = {}) {
  return buildFeedbackHqSummary(readFeedbackStore(storage));
}
