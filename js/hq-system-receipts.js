const SYSTEM_IDS = Object.freeze(['mission', 'health', 'attention', 'execution', 'feedback']);
const FRESHNESS = new Set(['fresh', 'stale', 'unknown']);
const SYNC_STATES = new Set(['online', 'offline', 'pending', 'authBlocked', 'deadLetter', 'unknown']);

function list(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function text(value) {
  return value === null || value === undefined ? null : String(value);
}

function normalizeInputGap(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const gap = {};
    ['code', 'field', 'severity', 'message', 'ref'].forEach((key) => {
      if (value[key] !== undefined && value[key] !== null) gap[key] = String(value[key]);
    });
    return Object.keys(gap).length ? gap : null;
  }
  const code = text(value);
  return code ? { code } : null;
}

function inferFreshness(snapshot = {}) {
  const explicit = typeof snapshot.freshness === 'object' ? snapshot.freshness?.status : snapshot.freshness;
  if (FRESHNESS.has(explicit)) return explicit;
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
  const generatedAt = text(receipt.generatedAt || receipt.updatedAt
    || (receipt.freshness && typeof receipt.freshness === 'object' ? receipt.freshness.generatedAt : ''));
  const status = text(receipt.status || receipt.health) || 'unknown';
  const projection = receipt.projection && typeof receipt.projection === 'object' ? receipt.projection : {};
  return Object.freeze({
    systemId: id,
    receiptId: text(receipt.receiptId || receipt.id || receipt.snapshotId) || `system:${id}:${effectiveDate || 'unknown'}:${revision}`,
    intakeRef: text(receipt.intakeRef || receipt.intakeId) || intakeRef || null,
    effectiveDate: text(receipt.effectiveDate || receipt.reviewDate) || effectiveDate || null,
    generatedAt,
    freshness: inferFreshness(receipt),
    status,
    riskLevel: text(receipt.riskLevel || projection.riskLevel) || (['alert', 'blocked', 'failed'].includes(status) ? 'action' : ['attention', 'retrying'].includes(status) ? 'watch' : 'none'),
    needsUserInput: receipt.needsUserInput === true || projection.needsUserInput === true,
    inputGaps: list(receipt.inputGaps || receipt.missingRequiredFields || projection.inputGaps).map(normalizeInputGap).filter(Boolean),
    factRefs: list(receipt.factRefs || receipt.sourceRefs || projection.factRefs),
    evidenceRefs: list(receipt.evidenceRefs || projection.evidenceRefs),
    syncState: inferSyncState(receipt, syncState),
    revision,
    candidateCount: Math.max(0, Number(receipt.candidateCount) || 0),
    appliedStatePresent: receipt.appliedStatePresent === true,
    errorCode: text(receipt.errorCode || projection.errorCode),
    errorMessage: text(receipt.errorMessage || projection.errorMessage),
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

const STATUS_LABELS = Object.freeze({
  processed: '已处理',
  applied: '已更新',
  completed: '已完成',
  proposed: '待你决定',
  pending_approval: '待你决定',
  pending: '处理中',
  retrying: '处理中',
  waiting: '等待条件',
  stale: '需要更新',
  blocked: '需处理异常',
  failed: '需处理异常',
  alert: '需处理异常',
  unknown: '状态待确认',
});

const SYNC_LABELS = Object.freeze({
  online: '已同步',
  offline: '等待联网',
  pending: '等待同步',
  authBlocked: '需要重新连接',
  deadLetter: '同步失败',
  unknown: '同步状态待确认',
});

const FRESHNESS_LABELS = Object.freeze({ fresh: '数据最新', stale: '数据需要更新', unknown: '更新时间待确认' });

export function describeSystemReceipt(receipt = {}) {
  let label = STATUS_LABELS[receipt.status] || '已收到回执';
  if (receipt.needsUserInput || list(receipt.inputGaps).length) label = '待补信息';
  else if (['action', 'critical'].includes(receipt.riskLevel)) label = '需处理异常';
  else if (Number(receipt.candidateCount) > 0) label = '待你决定';
  return Object.freeze({
    label,
    freshnessLabel: FRESHNESS_LABELS[receipt.freshness] || FRESHNESS_LABELS.unknown,
    syncLabel: SYNC_LABELS[receipt.syncState] || SYNC_LABELS.unknown,
  });
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
    const itemDate = text(item.effectiveDate || item.reviewDate);
    if (reviewDate && itemDate && itemDate !== reviewDate) return;
    const receiptId = text(item.receiptId || item.id || item.snapshotId);
    if (!receiptId) return;
    const revision = Math.max(1, Number(item.revision) || 1);
    const key = `${item.systemId}:${itemDate || reviewDate || 'unknown'}`;
    const current = selected.get(key);
    const currentAt = Date.parse(String(current?.updatedAt || current?.generatedAt || '')) || 0;
    const nextAt = Date.parse(String(item.updatedAt || item.generatedAt || '')) || 0;
    if (!current || revision > (Number(current.revision) || 1)
      || (revision === Number(current.revision || 1) && nextAt > currentAt)) selected.set(key, { ...item, revision });
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
