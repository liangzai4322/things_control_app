export const POINTS_CACHE_KEY = 'taskbox_points_cache';
const POINTS_PENDING_WRITES_KEY = 'taskbox_points_pending_api_writes';
const DEFAULT_API_ENDPOINT = 'https://liangzai666.com/taskbox-api/v1';

const TASKBOX_STORAGE_KEY = 'taskbox_data';
const DEFAULT_POINTS_TEMPLATE = {
  version: 1,
  account: {
    title: '任务积分账户',
    unit: '分',
  },
  rules: {
    defaultTaskPoints: 5,
    pointPresets: [
      { id: 'quick', label: '临时小任务', points: 3 },
      { id: 'normal', label: '标准任务', points: 5 },
      { id: 'important', label: '重要任务', points: 10 },
      { id: 'deep', label: '高投入任务', points: 20 },
    ],
    priorityDefaults: { 0: 3, 1: 5, 2: 10, 3: 20 },
    boxColorDefaults: {
      important: 10,
      misc: 5,
      health: 10,
      study: 3,
      relax: 0,
      reward: 0,
      punish: 0,
    },
    milestoneBonuses: [
      { id: 'growth-session', label: '成长聚会 / 局', points: 10, description: '参加一次对成长有帮助的聚会、局或交流。' },
      { id: 'growth-review', label: '1k 复盘', points: 10, description: '活动结束后完成 1000 字复盘，额外加分。' },
    ],
  },
  rewards: [],
  transactions: [],
  meta: {
    createdAt: '',
    updatedAt: '',
    sourceLabel: 'server-cache',
    openingBalanceRecorded: false,
    dirty: false,
  },
};
let pointsSyncTimer = null;
let pointsFlushPromise = null;

function showPointsSyncToast(message) {
  window.TaskBoxApp?.showToast?.(message);
}

function uid() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function nowIso() {
  return new Date().toISOString();
}

function localDay(value = new Date()) {
  const date = new Date(value);
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readTaskboxData() {
  const raw = localStorage.getItem(TASKBOX_STORAGE_KEY);
  if (!raw) return {};
  try {
    return JSON.parse(raw) || {};
  } catch {
    return {};
  }
}

function readTaskboxSettings() {
  return readTaskboxData().settings || {};
}

function getApiConfig() {
  const settings = readTaskboxSettings();
  const endpoint = String(settings.apiEndpoint || '').trim().replace(/\/$/, '');
  const token = String(settings.apiToken || '').trim();
  return {
    enabled: Boolean(endpoint && token),
    endpoint,
    token,
  };
}

async function apiRequest(path, options = {}) {
  const config = getApiConfig();
  if (!config.enabled) return null;
  const response = await fetch(`${config.endpoint}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.token}`,
      ...(options.headers || {}),
    },
  });
  if (!response.ok) throw new Error(`points_api_${response.status}`);
  if (response.status === 204) return null;
  return response.json();
}

function scheduleApiRequest(path, options = {}) {
  if (!getApiConfig().enabled) return false;
  const pending = readPendingApiWrites();
  pending.push({
    id: uid(),
    path,
    options: {
      method: options.method || 'GET',
      headers: options.headers || {},
      body: options.body || null,
    },
    createdAt: nowIso(),
  });
  writePendingApiWrites(pending);
  flushPendingApiWrites().catch(() => {});
  return true;
}

function readPendingApiWrites() {
  const raw = localStorage.getItem(POINTS_PENDING_WRITES_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item) => item?.path && item?.options) : [];
  } catch {
    return [];
  }
}

function writePendingApiWrites(items) {
  localStorage.setItem(POINTS_PENDING_WRITES_KEY, JSON.stringify(items));
}

function markCacheSyncedIfIdle() {
  if (readPendingApiWrites().length) return;
  const cached = readCache();
  if (cached?.meta?.dirty) writeCache(cached, { dirty: false });
}

async function flushPendingApiWrites() {
  if (!getApiConfig().enabled) return false;
  if (pointsFlushPromise) return pointsFlushPromise;

  pointsFlushPromise = (async () => {
    while (readPendingApiWrites().length) {
      const [next] = readPendingApiWrites();
      await apiRequest(next.path, next.options);
      const latest = readPendingApiWrites();
      const index = latest.findIndex((item) => item.id === next.id);
      if (index >= 0) latest.splice(index, 1);
      else latest.shift();
      writePendingApiWrites(latest);
    }
    markCacheSyncedIfIdle();
    return true;
  })().finally(() => {
    pointsFlushPromise = null;
  });

  return pointsFlushPromise;
}

function readTaskboxBoxes() {
  return Array.isArray(readTaskboxData().boxes) ? readTaskboxData().boxes : [];
}

function normalizeReward(reward = {}, index = 0) {
  return {
    id: reward.id || `reward-${index + 1}`,
    title: String(reward.title || reward.name || '').trim(),
    description: String(reward.description || reward.desc || '').trim(),
    cost: Math.max(0, Math.round(toNumber(reward.cost, 0))),
    category: String(reward.category || '未分类').trim(),
    icon: String(reward.icon || '🎁').trim(),
    active: reward.active !== false,
  };
}

function normalizeTransaction(transaction = {}) {
  const delta = Math.round(toNumber(transaction.delta ?? transaction.points, 0));
  const bucket = transaction.bucket || (delta >= 0 ? 'earn' : 'spend');
  return {
    id: transaction.id || uid(),
    bucket,
    sourceType: transaction.sourceType || 'manual_adjustment',
    sourceKey: String(transaction.sourceKey || transaction.id || uid()),
    title: String(transaction.title || '积分变动').trim(),
    note: String(transaction.note || '').trim(),
    delta,
    createdAt: transaction.createdAt || nowIso(),
    status: transaction.status || 'active',
    reversedAt: transaction.reversedAt || null,
  };
}

function normalizePointsData(data = {}) {
  const createdAt = data.meta?.createdAt || nowIso();
  const updatedAt = data.meta?.updatedAt || createdAt;
  return {
    version: Number(data.version) || 1,
    account: {
      title: String(data.account?.title || DEFAULT_POINTS_TEMPLATE.account.title).trim(),
      unit: String(data.account?.unit || DEFAULT_POINTS_TEMPLATE.account.unit).trim(),
    },
    rules: {
      defaultTaskPoints: Math.max(0, Math.round(toNumber(data.rules?.defaultTaskPoints, DEFAULT_POINTS_TEMPLATE.rules.defaultTaskPoints))),
      pointPresets: (Array.isArray(data.rules?.pointPresets) ? data.rules.pointPresets : DEFAULT_POINTS_TEMPLATE.rules.pointPresets)
        .map((preset, index) => ({
          id: preset.id || `preset-${index + 1}`,
          label: String(preset.label || preset.title || `档位 ${index + 1}`).trim(),
          points: Math.max(0, Math.round(toNumber(preset.points, 0))),
        }))
        .filter((preset) => preset.label),
      priorityDefaults: {
        0: Math.max(0, Math.round(toNumber(data.rules?.priorityDefaults?.[0] ?? data.rules?.priorityDefaults?.['0'], 3))),
        1: Math.max(0, Math.round(toNumber(data.rules?.priorityDefaults?.[1] ?? data.rules?.priorityDefaults?.['1'], 5))),
        2: Math.max(0, Math.round(toNumber(data.rules?.priorityDefaults?.[2] ?? data.rules?.priorityDefaults?.['2'], 10))),
        3: Math.max(0, Math.round(toNumber(data.rules?.priorityDefaults?.[3] ?? data.rules?.priorityDefaults?.['3'], 20))),
      },
      boxColorDefaults: {
        important: Math.max(0, Math.round(toNumber(data.rules?.boxColorDefaults?.important, 10))),
        misc: Math.max(0, Math.round(toNumber(data.rules?.boxColorDefaults?.misc, 5))),
        health: Math.max(0, Math.round(toNumber(data.rules?.boxColorDefaults?.health, 10))),
        study: Math.max(0, Math.round(toNumber(data.rules?.boxColorDefaults?.study, 3))),
        relax: Math.max(0, Math.round(toNumber(data.rules?.boxColorDefaults?.relax, 0))),
        reward: Math.max(0, Math.round(toNumber(data.rules?.boxColorDefaults?.reward, 0))),
        punish: Math.max(0, Math.round(toNumber(data.rules?.boxColorDefaults?.punish, 0))),
      },
      milestoneBonuses: (Array.isArray(data.rules?.milestoneBonuses) ? data.rules.milestoneBonuses : DEFAULT_POINTS_TEMPLATE.rules.milestoneBonuses)
        .map((bonus, index) => ({
          id: bonus.id || `bonus-${index + 1}`,
          label: String(bonus.label || bonus.title || `加成 ${index + 1}`).trim(),
          points: Math.max(0, Math.round(toNumber(bonus.points, 0))),
          description: String(bonus.description || bonus.desc || '').trim(),
        }))
        .filter((bonus) => bonus.label),
    },
    rewards: (Array.isArray(data.rewards) ? data.rewards : DEFAULT_POINTS_TEMPLATE.rewards)
      .map(normalizeReward)
      .filter((reward) => reward.title),
    transactions: (Array.isArray(data.transactions) ? data.transactions : DEFAULT_POINTS_TEMPLATE.transactions)
      .map(normalizeTransaction)
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt)),
    meta: {
      createdAt,
      updatedAt,
      sourceLabel: String(data.meta?.sourceLabel || 'server-cache').trim(),
      sourceUrl: String(data.meta?.sourceUrl || '').trim(),
      openingBalanceRecorded: Boolean(data.meta?.openingBalanceRecorded),
      dirty: Boolean(data.meta?.dirty),
      lastLoadedAt: data.meta?.lastLoadedAt || null,
    },
  };
}

function readCache() {
  const raw = localStorage.getItem(POINTS_CACHE_KEY);
  if (!raw) return null;
  try {
    return normalizePointsData(JSON.parse(raw));
  } catch {
    return null;
  }
}

function writeCache(data, { dirty = true } = {}) {
  const normalized = normalizePointsData(data);
  normalized.meta.updatedAt = nowIso();
  normalized.meta.dirty = dirty;
  localStorage.setItem(POINTS_CACHE_KEY, JSON.stringify(normalized));
  return normalized;
}

function createFallbackPointsData() {
  const fallback = structuredClone(DEFAULT_POINTS_TEMPLATE);
  fallback.meta.createdAt = nowIso();
  fallback.meta.updatedAt = fallback.meta.createdAt;
  fallback.meta.sourceUrl = '';
  return normalizePointsData(fallback);
}

async function fetchSource(url) {
  if (getApiConfig().enabled) {
    const config = getApiConfig();
    const normalized = normalizePointsData(await apiRequest('/points'));
    normalized.meta.sourceUrl = config.endpoint;
    normalized.meta.lastLoadedAt = nowIso();
    normalized.meta.dirty = false;
    return normalized;
  }
  throw new Error('points_api_not_configured');
}

function schedulePointsCloudPush() {
  clearTimeout(pointsSyncTimer);
  // Points are written to the server through record-level API calls.
  // Full JSON cloud uploads are retired.
  pointsSyncTimer = null;
}

export function getPointsSourceUrl() {
  const settings = readTaskboxSettings();
  return String(settings.apiEndpoint || '').trim().replace(/\/$/, '') || DEFAULT_API_ENDPOINT;
}

export function getPointsSyncState() {
  const sourceUrl = getPointsSourceUrl();
  const apiConfig = getApiConfig();
  return {
    sourceUrl,
    apiEnabled: apiConfig.enabled,
    autoPushEnabled: apiConfig.enabled,
  };
}

export function getPointsDataSync() {
  return readCache() || createFallbackPointsData();
}

export async function pushPointsToCloud(options = {}) {
  return false;
}

export async function pullPointsFromCloud() {
  let cached = readCache();
  const url = getPointsSourceUrl();
  const sourceChanged = cached && String(cached.meta?.sourceUrl || '').trim() !== url;

  if (!getApiConfig().enabled && cached?.meta?.dirty && !sourceChanged) {
    return { status: 'dirty-cache', data: cached };
  }

  if (getApiConfig().enabled && readPendingApiWrites().length) {
    try {
      await flushPendingApiWrites();
      cached = readCache() || cached;
    } catch {
      if (cached?.meta?.dirty && !sourceChanged) return { status: 'dirty-cache', data: cached };
    }
  }

  try {
    const seeded = await fetchSource(url);
    return {
      status: 'remote',
      data: writeCache(seeded, { dirty: false }),
    };
  } catch {
    return {
      status: cached ? 'cached' : 'fallback',
      data: cached || writeCache(createFallbackPointsData(), { dirty: false }),
    };
  }
}

export async function ensurePointsData({ forceSource = false } = {}) {
  const cached = readCache();
  const url = getPointsSourceUrl();
  const sourceChanged = cached && String(cached.meta?.sourceUrl || '').trim() !== url;
  if (cached && !forceSource && !sourceChanged) return cached;

  const result = await pullPointsFromCloud();
  return result.data;
}

export function prewarmPointsData(options = {}) {
  return ensurePointsData(options).catch(() => {});
}

function updatePointsData(updater) {
  const current = getPointsDataSync();
  const next = updater(structuredClone(current)) || current;
  const saved = writeCache(next, { dirty: true });
  schedulePointsCloudPush();
  return saved;
}

function createTransaction(payload) {
  return normalizeTransaction({
    ...payload,
    id: payload.id || uid(),
    createdAt: payload.createdAt || nowIso(),
  });
}

function queueTransactionCreate(transaction) {
  if (!transaction?.id) return false;
  return scheduleApiRequest('/points/transactions', {
    method: 'POST',
    body: JSON.stringify(transaction),
  });
}

function queueTransactionUpdate(transaction) {
  if (!transaction?.id) return false;
  return scheduleApiRequest(`/points/transactions/${encodeURIComponent(transaction.id)}`, {
    method: 'PATCH',
    body: JSON.stringify(transaction),
  });
}

function getTaskBox(task, boxOverride = null) {
  if (boxOverride) return boxOverride;
  return readTaskboxBoxes().find((box) => box.id === task?.boxId) || null;
}

export function getTaskPointValue(task = {}, boxOverride = null, pointsData = null) {
  if (task?.pointsValue !== null && task?.pointsValue !== undefined && Number.isFinite(Number(task.pointsValue))) {
    return Math.max(0, Math.round(Number(task.pointsValue)));
  }

  const data = pointsData || getPointsDataSync();
  const box = getTaskBox(task, boxOverride);
  const color = box?.color || '';
  const explicitZeroBoxes = new Set(['relax', 'reward', 'punish']);
  if (explicitZeroBoxes.has(color)) return 0;

  const priorityDefaults = data.rules.priorityDefaults || {};
  const priority = Number(task?.priority);
  if (Number.isFinite(priority) && priorityDefaults[priority] !== undefined) {
    return Math.max(0, Math.round(toNumber(priorityDefaults[priority], data.rules.defaultTaskPoints)));
  }

  const boxDefaults = data.rules.boxColorDefaults || {};
  if (color && boxDefaults[color] !== undefined) {
    return Math.max(0, Math.round(toNumber(boxDefaults[color], data.rules.defaultTaskPoints)));
  }

  return Math.max(0, Math.round(toNumber(data.rules.defaultTaskPoints, 5)));
}

export function getPointPresets(pointsData = null) {
  return [...(pointsData || getPointsDataSync()).rules.pointPresets];
}

export function getMilestoneBonuses(pointsData = null) {
  return [...(pointsData || getPointsDataSync()).rules.milestoneBonuses];
}

export function getRewardCatalog(pointsData = null) {
  return [...(pointsData || getPointsDataSync()).rewards]
    .filter((reward) => reward.active)
    .sort((a, b) => a.cost - b.cost || a.title.localeCompare(b.title, 'zh-CN'));
}

export function getRewardPool(pointsData = null, { includeInactive = true } = {}) {
  const rewards = [...(pointsData || getPointsDataSync()).rewards];
  return rewards
    .filter((reward) => includeInactive || reward.active)
    .sort((a, b) => Number(b.active) - Number(a.active) || a.cost - b.cost || a.title.localeCompare(b.title, 'zh-CN'));
}

export function getPointsBalance(pointsData = null) {
  return (pointsData || getPointsDataSync()).transactions.reduce((sum, transaction) => sum + toNumber(transaction.delta, 0), 0);
}

export function getPointsSummary(pointsData = null) {
  const data = pointsData || getPointsDataSync();
  const today = localDay();
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6);

  let todayEarned = 0;
  let todaySpent = 0;
  let recentNet = 0;

  data.transactions.forEach((transaction) => {
    const delta = toNumber(transaction.delta, 0);
    if (localDay(transaction.createdAt) === today) {
      if (delta >= 0) todayEarned += delta;
      else todaySpent += Math.abs(delta);
    }
    if (new Date(transaction.createdAt) >= sevenDaysAgo) recentNet += delta;
  });

  return {
    balance: getPointsBalance(data),
    todayEarned,
    todaySpent,
    recentNet,
    openingBalanceRecorded: Boolean(data.meta.openingBalanceRecorded),
  };
}

export function getRecentTransactions(limit = 20, pointsData = null) {
  return [...(pointsData || getPointsDataSync()).transactions]
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, limit);
}

export const POINTS_SOURCE_FILTERS = [
  { id: 'all', label: '全部来源', sourceTypes: null },
  { id: 'task', label: '任务得分', sourceTypes: ['task_completion', 'task_completion_reversal', 'task_points_adjustment'] },
  { id: 'reward', label: '奖励兑换', sourceTypes: ['reward_redeem'] },
  { id: 'manual', label: '手动记账', sourceTypes: ['manual_adjustment'] },
  { id: 'ai', label: 'AI识别', sourceTypes: ['ai_recognition'] },
  { id: 'history', label: '历史补录', sourceTypes: ['historical_balance'] },
];

export function getFilteredTransactions({
  limit = 40,
  bucket = 'all',
  source = 'all',
} = {}, pointsData = null) {
  const data = pointsData || getPointsDataSync();
  const sourceFilter = POINTS_SOURCE_FILTERS.find((item) => item.id === source) || POINTS_SOURCE_FILTERS[0];

  let transactions = [...data.transactions].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  if (bucket !== 'all') {
    transactions = transactions.filter((transaction) => transaction.bucket === bucket);
  }

  if (sourceFilter.sourceTypes?.length) {
    transactions = transactions.filter((transaction) => sourceFilter.sourceTypes.includes(transaction.sourceType));
  }

  return limit ? transactions.slice(0, limit) : transactions;
}

export function recordPointsTransaction({
  delta,
  title,
  note = '',
  bucket,
  sourceType = 'manual_adjustment',
  sourceKey = uid(),
  createdAt = null,
}) {
  const amount = Math.round(toNumber(delta, 0));
  if (!amount) return null;

  let created = null;
  updatePointsData((data) => {
    created = createTransaction({
      delta: amount,
      title,
      note,
      bucket: bucket || (amount >= 0 ? 'earn' : 'spend'),
      sourceType,
      sourceKey,
      createdAt: createdAt || nowIso(),
    });
    data.transactions.push(created);
    if (sourceType === 'historical_balance') data.meta.openingBalanceRecorded = true;
    return data;
  });
  queueTransactionCreate(created);
  return created;
}

export function recordHistoricalBalance(points, note = '把系统启用前已经攒下的积分补录进来。') {
  const amount = Math.max(0, Math.round(toNumber(points, 0)));
  if (!amount) return null;
  return recordPointsTransaction({
    delta: amount,
    title: '历史积分补录',
    note,
    bucket: 'adjust',
    sourceType: 'historical_balance',
    sourceKey: `historical-balance-${uid()}`,
  });
}

export function redeemReward(rewardId) {
  const pointsData = getPointsDataSync();
  const reward = pointsData.rewards.find((item) => item.id === rewardId && item.active);
  if (!reward) return { ok: false, reason: 'not_found' };

  const balance = getPointsBalance(pointsData);
  if (balance < reward.cost) return { ok: false, reason: 'insufficient', reward, balance };

  const transaction = recordPointsTransaction({
    delta: -Math.abs(reward.cost),
    title: `兑换奖励：${reward.title}`,
    note: reward.description,
    bucket: 'spend',
    sourceType: 'reward_redeem',
    sourceKey: reward.id,
  });
  return {
    ok: true,
    reward,
    transaction,
    balance: getPointsBalance(getPointsDataSync()),
  };
}

export function saveReward(rewardDraft = {}) {
  const normalizedDraft = normalizeReward({
    ...rewardDraft,
    id: rewardDraft.id || uid(),
  });

  if (!normalizedDraft.title) throw new Error('reward_title_required');
  if (!Number.isFinite(Number(normalizedDraft.cost)) || normalizedDraft.cost < 0) throw new Error('reward_cost_invalid');

  let saved = null;
  let existed = false;
  updatePointsData((data) => {
    const existing = data.rewards.find((reward) => reward.id === normalizedDraft.id);
    if (existing) {
      existed = true;
      Object.assign(existing, normalizedDraft);
    } else data.rewards.push(normalizedDraft);
    saved = normalizedDraft;
    return data;
  });
  scheduleApiRequest(existed ? `/points/rewards/${encodeURIComponent(saved.id)}` : '/points/rewards', {
    method: existed ? 'PATCH' : 'POST',
    body: JSON.stringify(saved),
  });

  return saved;
}

export function toggleRewardActive(rewardId) {
  let changed = null;
  updatePointsData((data) => {
    const reward = data.rewards.find((item) => item.id === rewardId);
    if (!reward) return data;
    reward.active = !reward.active;
    changed = { ...reward };
    return data;
  });
  if (changed) {
    scheduleApiRequest(`/points/rewards/${encodeURIComponent(changed.id)}`, {
      method: 'PATCH',
      body: JSON.stringify(changed),
    });
  }
  return changed;
}

export function syncTaskCompletionPoints({ task, box, completed }) {
  if (!task?.id) return { changed: false, delta: 0 };

  const nextPoints = getTaskPointValue(task, box);
  if (!completed && !nextPoints) return { changed: false, delta: 0 };

  let result = { changed: false, delta: 0 };
  const transactionsToCreate = [];
  const transactionsToUpdate = [];
  updatePointsData((data) => {
    const activeCompletion = [...data.transactions]
      .reverse()
      .find((transaction) => transaction.sourceType === 'task_completion'
        && transaction.sourceKey === String(task.id)
        && !transaction.reversedAt);

    if (completed) {
      if (activeCompletion || nextPoints <= 0) return data;

      const created = createTransaction({
        delta: nextPoints,
        title: `完成任务：${task.content}`,
        note: box?.name ? `来自 ${box.name}` : '任务完成自动加分',
        bucket: 'earn',
        sourceType: 'task_completion',
        sourceKey: String(task.id),
      });
      data.transactions.push(created);
      transactionsToCreate.push(created);
      result = { changed: true, delta: created.delta };
      return data;
    }

    if (!activeCompletion) return data;

    activeCompletion.status = 'reversed';
    activeCompletion.reversedAt = nowIso();
    transactionsToUpdate.push({ ...activeCompletion });
    const reversal = createTransaction({
      delta: -Math.abs(toNumber(activeCompletion.delta, 0)),
      title: `撤销任务积分：${task.content}`,
      note: '任务重新标记为未完成，回收已发放积分。',
      bucket: 'adjust',
      sourceType: 'task_completion_reversal',
      sourceKey: String(task.id),
    });
    data.transactions.push(reversal);
    transactionsToCreate.push(reversal);
    result = { changed: true, delta: reversal.delta };
    return data;
  });

  transactionsToUpdate.forEach(queueTransactionUpdate);
  transactionsToCreate.forEach(queueTransactionCreate);
  return result;
}

export function reconcileCompletedTaskPoints({ task, box, previousPointsValue = null }) {
  if (!task?.id || !task.isCompleted) return { changed: false, delta: 0 };

  const data = getPointsDataSync();
  const activeCompletion = [...data.transactions]
    .reverse()
    .find((transaction) => transaction.sourceType === 'task_completion'
      && transaction.sourceKey === String(task.id)
      && !transaction.reversedAt);

  const currentPoints = getTaskPointValue(task, box, data);
  const previousPoints = previousPointsValue !== null && previousPointsValue !== undefined
    ? Math.max(0, Math.round(toNumber(previousPointsValue, currentPoints)))
    : currentPoints;

  if (!activeCompletion) return syncTaskCompletionPoints({ task, box, completed: true });
  if (currentPoints === previousPoints) return { changed: false, delta: 0 };

  const diff = currentPoints - previousPoints;
  if (!diff) return { changed: false, delta: 0 };

  const transaction = recordPointsTransaction({
    delta: diff,
    title: `调整任务积分：${task.content}`,
    note: `原积分 ${previousPoints}，现积分 ${currentPoints}。`,
    bucket: 'adjust',
    sourceType: 'task_points_adjustment',
    sourceKey: String(task.id),
  });

  return { changed: Boolean(transaction), delta: diff };
}
