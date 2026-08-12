import { FEEDBACK_STORAGE_KEY, normalizeFeedbackStore } from './feedback-model.js';
export function readFeedbackStore(storage = localStorage) { try { return normalizeFeedbackStore(JSON.parse(storage.getItem(FEEDBACK_STORAGE_KEY) || '{}')); } catch { return normalizeFeedbackStore(); } }
export function writeFeedbackStore(value, storage = localStorage) { const next = normalizeFeedbackStore({ ...value, updatedAt: new Date().toISOString() }); storage.setItem(FEEDBACK_STORAGE_KEY, JSON.stringify(next)); return next; }
