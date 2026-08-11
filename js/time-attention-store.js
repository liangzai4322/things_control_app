import { TIME_ATTENTION_STORAGE_KEY, importTimeCandidates, normalizeTimeStore, updateTimeCandidate } from './time-attention-model.js';
export function readTimeStore(storage = localStorage) { try { return normalizeTimeStore(JSON.parse(storage.getItem(TIME_ATTENTION_STORAGE_KEY) || '{}')); } catch { return normalizeTimeStore(); } }
export function writeTimeStore(value, storage = localStorage, { touchFacts = true } = {}) { const now = new Date().toISOString(); const next = normalizeTimeStore({ ...value, factsUpdatedAt: touchFacts ? now : value.factsUpdatedAt, updatedAt: now }); storage.setItem(TIME_ATTENTION_STORAGE_KEY, JSON.stringify(next)); return next; }
export function upsertTimePlan(store, plan) { const current = normalizeTimeStore(store); return normalizeTimeStore({ ...current, plans: [...current.plans.filter((x) => x.date !== plan.date), { ...plan, updatedAt: new Date().toISOString() }] }); }
export function addTimeCandidates(store, records) { return importTimeCandidates(store, records); }
export function confirmTimeCandidateDate(store, candidateId, confirmedActivityDate) { return updateTimeCandidate(store, candidateId, { status: 'confirmed_date', confirmedActivityDate }); }
export function rejectTimeCandidate(store, candidateId, rejectionReason = '') { return updateTimeCandidate(store, candidateId, { status: 'rejected', rejectionReason }); }
