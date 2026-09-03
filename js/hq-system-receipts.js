const SYSTEM_IDS = Object.freeze(['mission', 'health', 'attention', 'execution', 'feedback']);
const FRESHNESS = new Set(['fresh', 'stale', 'unknown']);
const SYNC_STATES = new Set(['online', 'offline', 'pending', 'authBlocked', 'deadLetter', 'unknown']);

function list(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function text(value) {
  return value === null || value === undefined ? null : String(value);
}

function inferFreshness(snapshot = {}) {
  if (FRESHNESS.has(snapshot.freshness)) return snapshot.freshness;
  if (snapshot.status === 'stale' || snapshot.health === 'stale') return 'stale';
  if (['unknown', 'unavailable'].includes(snapshot.status) || snapshot.health === 'unknown') return 'unknown';
  return snapshot.generatedAt || snapshot.updatedAt ? 'fresh' : 'unknown';
}

function inferSyncState(snapshot = {}, fallback = {}) {
  const value = snapshot.syncState || (fallback.authBlocked ? 'authBlocked' : fallback.offline ? 'offline' : fallback.status);
  return SYNC_STATES.has(value) ? value : 'unknown';
}

export function buildDailyReviewIntakeRef(brief = {}, reviewDate = '') {
  const sourceReviewDate = brief.plannedFromReviewDate || brief.sourceReviewDate || reviewDate || brief.reviewDate || 'unknown';
  const effectiveDate = brief.reviewDate || reviewDate || 'unknown';
  return `daily-review:${sourceReviewDate}:${effectiveDate}`;
}

export function normalizeSystemReceipt(receipt = {}, { systemId, intakeRef, effectiveDate, syncState = {} } = {}) {
  const id = text(receipt.systemId || systemId) || 'unknown';
  const revision = Math.max(1, Number(receipt.revision) || 1);
  const generatedAt = text(receipt.generatedAt || receipt.updatedAt);
  const status = text(receipt.status || receipt.health) || 'unknown';
  return Object.freeze({
    systemId: id,
    receiptId: text(receipt.receiptId || receipt.snapshotId) || `system:${id}:${effectiveDate || 'unknown'}:${revision}`,
    intakeRef: text(receipt.intakeRef) || intakeRef || null,
    effectiveDate: text(receipt.effectiveDate) || effectiveDate || null,
    generatedAt,
    freshness: inferFreshness(receipt),
    status,
    riskLevel: text(receipt.riskLevel) || (['alert', 'blocked'].includes(status) ? 'action' : status === 'attention' ? 'watch' : 'none'),
    needsUserInput: receipt.needsUserInput === true,
    inputGaps: list(receipt.inputGaps || receipt.missingRequiredFields),
    factRefs: list(receipt.factRefs || receipt.sourceRefs),
    evidenceRefs: list(receipt.evidenceRefs),
    syncState: inferSyncState(receipt, syncState),
    revision,
    candidateCount: Math.max(0, Number(receipt.candidateCount) || 0),
    appliedStatePresent: receipt.appliedStatePresent === true,
  });
}

export function buildSystemReceiptProjection({ systemSnapshots = {}, receipts = [], brief = {}, reviewDate = '', syncState = {} } = {}) {
  const intakeRef = buildDailyReviewIntakeRef(brief, reviewDate);
  const bySystem = new Map(list(receipts).map((item) => [item.systemId, item]));
  const items = SYSTEM_IDS.map((systemId) => normalizeSystemReceipt(bySystem.get(systemId) || systemSnapshots[systemId] || {}, {
    systemId, intakeRef, effectiveDate: reviewDate || brief.reviewDate || null, syncState,
  }));

  const groups = { know: [], decide: [], do: [], doneOrWaiting: [] };
  items.forEach((item) => {
    if (item.needsUserInput || item.inputGaps.length || ['action', 'critical'].includes(item.riskLevel)) groups.do.push(item);
    else if (item.candidateCount > 0 || ['proposed', 'pending_approval'].includes(item.status)) groups.decide.push(item);
    else if (item.freshness === 'fresh' && item.syncState === 'online' && !['unknown', 'pending'].includes(item.status)) groups.know.push(item);
    else groups.doneOrWaiting.push(item);
  });
  return Object.freeze({ contractVersion: '2026-09-03.1', intakeRef, items: Object.freeze(items), groups: Object.freeze(groups) });
}

function receiptList(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.receipts)) return payload.receipts;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
}

export function selectSystemReceipts(payload, reviewDate = '') {
  const selected = new Map();
  receiptList(payload).forEach((item) => {
    if (!item || typeof item !== 'object' || !item.systemId) return;
    if (reviewDate && item.effectiveDate && item.effectiveDate !== reviewDate) return;
    const receiptId = text(item.receiptId || item.snapshotId);
    if (!receiptId) return;
    const current = selected.get(receiptId);
    const revision = Math.max(1, Number(item.revision) || 1);
    if (!current || revision > (Number(current.revision) || 1)) selected.set(receiptId, { ...item, revision });
  });
  return [...selected.values()];
}

function degradedReceipts(reviewDate, error) {
  const status = Number(error?.status) || 0;
  const syncState = status === 401 ? 'authBlocked' : status === 404 ? 'online' : 'offline';
  return SYSTEM_IDS.map((systemId) => ({
    systemId,
    receiptId: `system-receipt-unavailable:${systemId}:${reviewDate || 'unknown'}`,
    effectiveDate: reviewDate || null,
    freshness: status === 404 ? 'unknown' : 'stale',
    status: 'unknown',
    syncState,
    revision: 1,
  }));
}

export async function readSystemReceipts(request, reviewDate, { limit = 100 } = {}) {
  const path = `/hq/system-receipts?reviewDate=${encodeURIComponent(reviewDate || '')}&limit=${Math.max(1, Number(limit) || 100)}`;
  try {
    const payload = await request(path);
    return Object.freeze({ receipts: selectSystemReceipts(payload, reviewDate), degraded: false, reason: null });
  } catch (error) {
    const status = Number(error?.status) || 0;
    return Object.freeze({
      receipts: degradedReceipts(reviewDate, error),
      degraded: true,
      reason: status === 401 ? 'auth' : status === 404 ? 'unsupported' : 'network',
    });
  }
}
