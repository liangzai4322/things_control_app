import {
  getFirstOccurrenceAt,
  getNextOccurrenceAt,
  getOccurrenceDueAt,
  getRecurrenceKey,
  getRecurringOccurrenceId,
  normalizeRecurrenceRule,
} from './recurrence.js';

const STORAGE_KEY = 'taskbox_data';

const DEFAULT_BOXES = [
  { name: '重要盒', color: 'important', icon: '⭐', sortOrder: 0, isDefault: true, description: '放这里的，都是不做会后悔的事。别拖了，一件一件来。' },
  { name: '待办盒', color: 'misc', icon: '📦', sortOrder: 1, isDefault: true, description: '想到就记，统一处理，减少脑内占用。' },
  { name: '放松盒', color: 'relax', icon: '☕', sortOrder: 2, isDefault: true, description: '累了就来这里抽一个，给自己一个正当的休息理由。' },
  { name: '奖励盒', color: 'reward', icon: '🎁', sortOrder: 3, isDefault: true, description: '完成了重要任务？来这里随机抽一个奖励犒劳自己吧。' },
  { name: '惩罚盒', color: 'punish', icon: '⚡', sortOrder: 4, isDefault: true, description: '没完成计划？随机抽一个惩罚，对自己狠一点才能进步。' },
  { name: '碎片学习盒', color: 'study', icon: '🧩', sortOrder: 5, isDefault: true, description: '碎片时间学习清单，想到就看。' },
  { name: '健康盒', color: 'health', icon: '💪', sortOrder: 6, isDefault: true, description: '每天一点点，练身体、稳心态。' },
];

const DEFAULT_TASKS = [
  { boxName: '放松盒', content: '听音乐两首' },
  { boxName: '放松盒', content: '冥想 5min' },
  { boxName: '放松盒', content: '靠墙站立' },

  { boxName: '奖励盒', content: '高分牛肉火锅' },
  { boxName: '奖励盒', content: '高分自助餐' },

  { boxName: '惩罚盒', content: '复盘 1k 字' },
  { boxName: '惩罚盒', content: '输出主题文章 2k 字' },
  { boxName: '惩罚盒', content: '手写笔记整理 30min' },

  { boxName: '碎片学习盒', content: '生财有术中标' },
  { boxName: '碎片学习盒', content: '生财有术亦仁收藏夹' },
  { boxName: '碎片学习盒', content: '生财有术资源对接' },
  { boxName: '健康盒', content: '每天站桩 10 分钟（一开始可以 5 分钟）' },
  { boxName: '健康盒', content: '每天冥想 10 分钟（一开始可以 5 分钟）' },
  { boxName: '健康盒', content: '5楼以下通通走楼梯' },
];


let cloudSyncTimer = null;
let dataCache = null;
let dataCacheDay = '';
const apiMutationQueues = new Map();
let apiMutationVersion = 0;
let ensuringRecurringTasks = false;
const SOUND_CACHE = new Map();
const BOX_COLOR_POOL = ['important', 'relax', 'reward', 'misc', 'punish', 'study', 'health'];
const FIXED_HOME_BOX_COLORS = new Set(['important', 'misc']);
const DEFAULT_API_ENDPOINT = 'https://liangzai666.com/taskbox-api/v1';
const DEFAULT_FLOMO_WEBHOOK = '';
export const DEFAULT_DAILY_QUOTE = '把任务放进盒子，把注意力还给当下。';

export function uid() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function normalize(data = {}) {
  return {
    boxes: (Array.isArray(data.boxes) ? data.boxes : []).map((b) => {
      const renamed = b.name === '杂事盒' ? '待办盒' : (b.name === '重要事项' ? '重要盒' : b.name);
      const orderMap = { '重要盒': 0, '待办盒': 1, '放松盒': 2, '奖励盒': 3, '惩罚盒': 4, '碎片学习盒': 5, '健康盒': 6 };
      const color = b.color || BOX_COLOR_POOL[orderMap[renamed] ?? 0];
      return {
        ...b,
        name: renamed,
        sortOrder: orderMap[renamed] ?? b.sortOrder ?? 99,
        color,
        homePinned: FIXED_HOME_BOX_COLORS.has(color) ? false : Boolean(b.homePinned),
        updatedAt: b.updatedAt || b.createdAt || data.meta?.updatedAt || new Date().toISOString(),
      };
    }),
    tasks: (Array.isArray(data.tasks) ? data.tasks : []).map((t) => {
      const rawPinLevel = Number(t.pinLevel ?? (t.pinned ? 1 : 0));
      const pinLevel = rawPinLevel >= 1 && rawPinLevel <= 3 ? rawPinLevel : null;
      return {
        ...t,
        weight: t.weight ?? 1,
        pointsValue: t.pointsValue !== undefined && t.pointsValue !== null && Number.isFinite(Number(t.pointsValue)) ? Number(t.pointsValue) : null,
        progress: t.progress ?? (t.isCompleted ? 100 : 0),
        pinLevel,
        pinned: Boolean(pinLevel),
        deleted: t.deleted ?? false,
        deletedAt: t.deletedAt ?? null,
        scheduledAt: t.scheduledAt ?? null,
        isRecurringTemplate: Boolean(t.isRecurringTemplate),
        recurrenceTemplateId: t.recurrenceTemplateId || null,
        recurrenceKey: t.recurrenceKey || null,
        recurrence: t.recurrence && typeof t.recurrence === 'object' ? t.recurrence : null,
        nextRunAt: t.nextRunAt || null,
        occurrenceStatus: t.occurrenceStatus || null,
        note: t.note ?? [t.reflection, t.review, t.summaryText].filter(Boolean).join('\n').trim(),
        syncKey: t.syncKey || `${t.createdAt || ''}::${t.content || ''}`,
        updatedAt: t.updatedAt || t.createdAt || new Date().toISOString()
      };
    }),
    settings: {
      deepseekApiKey: data.settings?.deepseekApiKey || '',
      themeMode: data.settings?.themeMode || 'system',
      soundEnabled: data.settings?.soundEnabled ?? true,
      cloudProvider: 'api',
      cloudEnabled: false,
      cloudEndpoint: '',
      cloudToken: '',
      pavilionDataUrl: '',
      towerDataUrl: '',
      pointsDataUrl: '',
      flomoWebhook: data.settings?.flomoWebhook || DEFAULT_FLOMO_WEBHOOK,
      githubToken: '',
      apiEnabled: true,
      apiEndpoint: data.settings?.apiEndpoint || DEFAULT_API_ENDPOINT,
      apiToken: data.settings?.apiToken || '',
      dailyQuote: data.settings?.dailyQuote || DEFAULT_DAILY_QUOTE,
      dailyQuoteUpdatedAt: data.settings?.dailyQuoteUpdatedAt || data.meta?.updatedAt || new Date().toISOString(),
      dailyQuoteHistory: Array.isArray(data.settings?.dailyQuoteHistory) ? data.settings.dailyQuoteHistory : [],
    },
    meta: {
      updatedAt: data.meta?.updatedAt || new Date().toISOString(),
      lastDailyReset: data.meta?.lastDailyReset || '',
      lastSummaryExportAt: data.meta?.lastSummaryExportAt || null,
    },
  };
}

function seed() {
  const now = new Date().toISOString();
  const boxes = DEFAULT_BOXES.map((b, i) => ({ ...b, id: uid(), createdAt: now, sortOrder: i }));
  const boxMap = new Map(boxes.map((b) => [b.name, b.id]));
  const tasks = DEFAULT_TASKS.map((t, i) => ({
    id: uid(),
    boxId: boxMap.get(t.boxName),
    content: t.content,
    isCompleted: false,
    sortOrder: i,
    priority: 2,
    weight: 1,
    progress: 0,
    deleted: false,
    deletedAt: null,
    note: '',
    syncKey: `${now}::${t.content}`,
    dueDate: null,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
  }));
  const initial = normalize({
    boxes,
    tasks,
    settings: {
      deepseekApiKey: '',
      themeMode: 'system',
      soundEnabled: true,
      cloudProvider: 'api',
      cloudEnabled: false,
      cloudEndpoint: '',
      cloudToken: '',
      pointsDataUrl: '',
      flomoWebhook: DEFAULT_FLOMO_WEBHOOK,
      githubToken: '',
      apiEnabled: true,
      apiEndpoint: DEFAULT_API_ENDPOINT,
      apiToken: '',
      dailyQuote: DEFAULT_DAILY_QUOTE,
      dailyQuoteUpdatedAt: now,
      dailyQuoteHistory: [{ text: DEFAULT_DAILY_QUOTE, updatedAt: now }],
    },
    meta: { updatedAt: now, lastDailyReset: '', lastSummaryExportAt: null },
  });
  localStorage.setItem(STORAGE_KEY, JSON.stringify(initial));
  dataCache = initial;
  dataCacheDay = new Date().toDateString();
  return initial;
}



function taskTime(value) {
  const date = new Date(value || 0);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

function chooseTaskCopy(current, candidate) {
  if (!current) return { ...candidate };
  const currentTime = Math.max(taskTime(current.updatedAt), taskTime(current.deletedAt), taskTime(current.createdAt));
  const candidateTime = Math.max(taskTime(candidate.updatedAt), taskTime(candidate.deletedAt), taskTime(candidate.createdAt));
  return candidateTime >= currentTime ? { ...current, ...candidate } : current;
}

function dedupeTasksByIdentity(tasks = []) {
  const byId = new Map();
  const noIdTasks = [];

  tasks.forEach((task) => {
    if (task.id) byId.set(task.id, chooseTaskCopy(byId.get(task.id), task));
    else noIdTasks.push(task);
  });

  const bySyncKey = new Map();
  [...byId.values(), ...noIdTasks].forEach((task) => {
    if (task.syncKey) bySyncKey.set(task.syncKey, chooseTaskCopy(bySyncKey.get(task.syncKey), task));
    else bySyncKey.set(`no-sync::${task.boxId || ''}::${task.createdAt || ''}::${task.content || ''}::${Math.random()}`, task);
  });

  const byRecurrenceKey = new Map();
  const oneTimeTasks = [];
  bySyncKey.forEach((task) => {
    if (task.recurrenceKey) {
      byRecurrenceKey.set(task.recurrenceKey, chooseTaskCopy(byRecurrenceKey.get(task.recurrenceKey), task));
    } else {
      oneTimeTasks.push(task);
    }
  });

  return [...oneTimeTasks, ...byRecurrenceKey.values()];
}

function dedupeLocalTasks(data) {
  data.tasks = dedupeTasksByIdentity(data.tasks);
  return data;
}

function applyDailyTaskRefresh(data) {
  const today = new Date().toISOString().slice(0, 10);
  if (data.meta.lastDailyReset === today) return data;

  const targetBoxNames = new Set(['放松盒', '奖励盒', '惩罚盒']);
  const targetBoxIds = new Set(data.boxes.filter((b) => targetBoxNames.has(b.name)).map((b) => b.id));

  data.tasks = data.tasks.map((t) => (
    (targetBoxIds.has(t.boxId) && !t.deleted) ? { ...t, isCompleted: false, completedAt: null, progress: 0 } : t
  ));
  data.meta.lastDailyReset = today;
  return data;
}

function enforceUniqueBoxColors(data) {
  const used = new Set();
  const ordered = [...data.boxes].sort((a, b) => (a.sortOrder ?? 99) - (b.sortOrder ?? 99));
  ordered.forEach((box, idx) => {
    if (!box.color || used.has(box.color)) {
      const replacement = BOX_COLOR_POOL.find((c) => !used.has(c)) || BOX_COLOR_POOL[idx % BOX_COLOR_POOL.length];
      box.color = replacement;
    }
    used.add(box.color);
  });
  return data;
}

export function getData() {
  const today = new Date().toDateString();
  if (dataCache && dataCacheDay === today) return dataCache;
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return seed();
  try {
    const normalized = normalize(JSON.parse(raw));
    const refreshed = enforceUniqueBoxColors(dedupeLocalTasks(applyDailyTaskRefresh(normalized)));
    const serialized = JSON.stringify(refreshed);
    if (serialized !== raw) localStorage.setItem(STORAGE_KEY, serialized);
    dataCache = refreshed;
    dataCacheDay = today;
    return refreshed;
  } catch {
    return seed();
  }
}

export function invalidateDataCache() {
  dataCache = null;
  dataCacheDay = '';
}

export function saveData(data, { skipCloud = false } = {}) {
  const normalized = normalize(data);
  normalized.meta.updatedAt = new Date().toISOString();
  dataCache = normalized;
  dataCacheDay = new Date().toDateString();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
  if (!skipCloud) scheduleCloudPush();
}

export function updateData(updater, options = {}) {
  const next = updater(structuredClone(getData()));
  saveData(next, options);
  return next;
}

export const getBoxes = () => [...getData().boxes].sort((a, b) => {
  const homeRank = (box) => {
    if (box.color === 'important') return 0;
    if (box.color === 'misc') return 1;
    if (box.homePinned) return 2;
    return 3;
  };
  return homeRank(a) - homeRank(b)
    || (Number(a.sortOrder) || 0) - (Number(b.sortOrder) || 0)
    || taskTime(a.createdAt) - taskTime(b.createdAt);
});
export const getTasks = () => {
  ensureRecurringTaskInstances();
  return getData().tasks.filter((t) => !t.deleted && !t.isRecurringTemplate);
};
export const getSettings = () => getData().settings;

function normalizeDailyQuoteHistory(history = []) {
  const seen = new Set();
  return history
    .map((item) => ({
      text: String(item?.text || '').trim(),
      updatedAt: item?.updatedAt || new Date().toISOString(),
    }))
    .filter((item) => item.text)
    .sort((a, b) => taskTime(b.updatedAt) - taskTime(a.updatedAt))
    .filter((item) => {
      const key = `${item.updatedAt}::${item.text}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 365);
}

function normalizeDailyQuoteRecord(record = {}) {
  const text = String(record.current || record.text || record.dailyQuote || '').trim() || DEFAULT_DAILY_QUOTE;
  const updatedAt = record.updatedAt || record.dailyQuoteUpdatedAt || new Date().toISOString();
  const history = normalizeDailyQuoteHistory([
    { text, updatedAt },
    ...(Array.isArray(record.history) ? record.history : []),
    ...(Array.isArray(record.dailyQuoteHistory) ? record.dailyQuoteHistory : []),
  ]);
  return { current: text, updatedAt, history };
}

export function getDailyQuote() {
  const settings = getSettings();
  return normalizeDailyQuoteRecord({
    current: settings.dailyQuote,
    updatedAt: settings.dailyQuoteUpdatedAt,
    history: settings.dailyQuoteHistory,
  });
}

function saveDailyQuoteLocal(record) {
  const normalized = normalizeDailyQuoteRecord(record);
  setSettings({
    dailyQuote: normalized.current,
    dailyQuoteUpdatedAt: normalized.updatedAt,
    dailyQuoteHistory: normalized.history,
  });
  return normalized;
}

export function saveDailyQuote(text) {
  const cleanText = String(text || '').trim() || DEFAULT_DAILY_QUOTE;
  const updatedAt = new Date().toISOString();
  const current = getDailyQuote();
  const record = normalizeDailyQuoteRecord({
    current: cleanText,
    updatedAt,
    history: [{ text: cleanText, updatedAt }, ...current.history],
  });
  saveDailyQuoteLocal(record);
  scheduleApiRequest('/daily-quote', {
    method: 'PATCH',
    body: JSON.stringify(record),
  });
  return record;
}

export async function pullDailyQuoteFromCloud() {
  try {
    const record = await apiRequest('/daily-quote');
    if (!record) return getDailyQuote();
    return saveDailyQuoteLocal(record);
  } catch {
    return getDailyQuote();
  }
}

export function exportDailyQuoteArchive() {
  const quote = getDailyQuote();
  const lines = [
    '# 每日一句',
    '',
    `当前：${quote.current}`,
    `更新时间：${quote.updatedAt}`,
    '',
    '## 历史记录',
    '',
    ...quote.history.map((item) => `- ${item.updatedAt} ${item.text}`),
    '',
  ];
  const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = '每日一句.md';
  a.click();
  URL.revokeObjectURL(a.href);
}

export function getDeletedTasksByBox(boxId) {
  return getData().tasks
    .filter((t) => t.boxId === boxId && t.deleted && !t.isRecurringTemplate)
    .sort((a, b) => taskTime(b.deletedAt || b.updatedAt) - taskTime(a.deletedAt || a.updatedAt));
}

export function getTasksByBox(boxId) {
  const pinRank = (task) => {
    const level = Number(task.pinLevel ?? (task.pinned ? 1 : 0));
    return level >= 1 && level <= 3 ? level : 99;
  };

  return getTasks()
    .filter((t) => t.boxId === boxId)
    .sort((a, b) => pinRank(a) - pinRank(b)
      || (Number(b.weight)||1) - (Number(a.weight)||1)
      || (Number(b.priority)||0) - (Number(a.priority)||0)
      || (Number(b.progress)||0) - (Number(a.progress)||0)
      || a.sortOrder - b.sortOrder
      || new Date(a.createdAt) - new Date(b.createdAt));
}

export function addTask(task) {
  let created = null;
  updateData((data) => {
    const maxOrder = Math.max(-1, ...data.tasks.filter((t) => t.boxId === task.boxId && !t.isCompleted).map((t) => t.sortOrder));
    created = {
      id: uid(),
      content: task.content,
      boxId: task.boxId,
      priority: task.priority ?? null,
      weight: task.weight ?? 1,
      pointsValue: task.pointsValue ?? null,
      progress: task.progress ?? 0,
      pinLevel: task.pinLevel ?? null,
      pinned: Boolean(task.pinLevel ?? task.pinned),
      scheduledAt: task.scheduledAt ?? null,
      dueDate: task.dueDate ?? null,
      isCompleted: task.isCompleted ?? false,
      deleted: false,
      deletedAt: null,
      note: task.note ?? '',
      sortOrder: maxOrder + 1,
      completedAt: task.completedAt ?? null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      syncKey: `${new Date().toISOString()}::${task.content}`,
    };
    data.tasks.push(created);
    return data;
  });
  scheduleApiRequest('/tasks', {
    method: 'POST',
    body: JSON.stringify(created),
  });
  return created;
}

function buildRecurringOccurrence(template, scheduledAt, data) {
  const recurrence = normalizeRecurrenceRule(template.recurrence, scheduledAt, template.dueDate);
  const recurrenceKey = getRecurrenceKey(template.id, scheduledAt);
  const maxOrder = Math.max(-1, ...data.tasks
    .filter((task) => task.boxId === template.boxId && !task.isCompleted && !task.isRecurringTemplate)
    .map((task) => Number(task.sortOrder) || 0));
  const createdAt = new Date().toISOString();

  return {
    id: getRecurringOccurrenceId(template.id, scheduledAt),
    content: template.content,
    boxId: template.boxId,
    priority: template.priority ?? null,
    weight: template.weight ?? 1,
    pointsValue: template.pointsValue ?? null,
    progress: 0,
    pinLevel: template.pinLevel ?? null,
    pinned: Boolean(template.pinLevel ?? template.pinned),
    scheduledAt,
    dueDate: getOccurrenceDueAt(recurrence, scheduledAt),
    isCompleted: false,
    deleted: false,
    deletedAt: null,
    note: template.note || '',
    sortOrder: maxOrder + 1,
    completedAt: null,
    createdAt,
    updatedAt: createdAt,
    syncKey: recurrenceKey,
    recurrenceTemplateId: template.id,
    recurrenceKey,
    recurrence,
    occurrenceStatus: 'pending',
  };
}

function getTemplateInstances(data, templateId) {
  return data.tasks.filter((task) => task.recurrenceTemplateId === templateId && !task.isRecurringTemplate);
}

function advancePastUsedSlots(data, template, candidate) {
  let next = candidate;
  let attempts = 0;
  while (next && attempts < 400) {
    const key = getRecurrenceKey(template.id, next);
    if (!data.tasks.some((task) => task.recurrenceKey === key)) return next;
    next = getNextOccurrenceAt(template.recurrence, next);
    attempts += 1;
  }
  return next;
}

export function ensureRecurringTaskInstances(referenceTime = new Date()) {
  if (ensuringRecurringTasks) return [];
  ensuringRecurringTasks = true;
  const created = [];
  const updated = [];

  try {
    const data = structuredClone(getData());
      const currentTime = new Date(referenceTime).getTime();
      data.tasks
        .filter((task) => task.isRecurringTemplate && !task.deleted && !task.recurrence?.paused)
        .forEach((template) => {
          const instances = getTemplateInstances(data, template.id);
          let pending = instances.find((task) => !task.deleted && !task.isCompleted);
          const rule = normalizeRecurrenceRule(template.recurrence, template.scheduledAt, template.dueDate);
          if (!rule) return;

          if (pending && rule.missPolicy === 'skip') {
            const following = getNextOccurrenceAt(rule, pending.scheduledAt);
            if (following && new Date(following).getTime() <= currentTime) {
              pending.deleted = true;
              pending.deletedAt = new Date().toISOString();
              pending.updatedAt = pending.deletedAt;
              pending.occurrenceStatus = 'skipped';
              updated.push({ ...pending });
              pending = null;
              template.nextRunAt = following;
            }
          }

          if (pending) return;
          let candidate = template.nextRunAt || (instances.length ? null : (template.scheduledAt || rule.anchorAt));
          candidate = advancePastUsedSlots(data, template, candidate);
          if (!candidate) return;

          if (rule.missPolicy === 'skip') {
            let following = getNextOccurrenceAt(rule, candidate);
            while (following && new Date(following).getTime() <= currentTime) {
              candidate = following;
              following = getNextOccurrenceAt(rule, candidate);
            }
          }

          const occurrence = buildRecurringOccurrence(template, candidate, data);
          data.tasks.push(occurrence);
          created.push(occurrence);
          template.nextRunAt = rule.mode === 'completion' ? null : getNextOccurrenceAt(rule, candidate);
          template.updatedAt = new Date().toISOString();
          updated.push({ ...template });
        });
    if (created.length || updated.length) saveData(data, { skipCloud: true });
  } finally {
    ensuringRecurringTasks = false;
  }

  created.forEach((task) => scheduleApiRequest('/tasks', { method: 'POST', body: JSON.stringify(task) }));
  updated.forEach((task) => scheduleApiRequest(`/tasks/${encodeURIComponent(task.id)}`, { method: 'PATCH', body: JSON.stringify(task) }));
  return created;
}

export function addRecurringTask(task, recurrenceInput) {
  const fallbackSchedule = task.scheduledAt || new Date().toISOString();
  const recurrence = normalizeRecurrenceRule(recurrenceInput, fallbackSchedule, task.dueDate);
  if (!recurrence) return addTask(task);
  const firstRunAt = getFirstOccurrenceAt(recurrence, fallbackSchedule);
  const createdAt = new Date().toISOString();
  let template = null;

  updateData((data) => {
    const maxOrder = Math.max(-1, ...data.tasks.filter((item) => item.boxId === task.boxId).map((item) => Number(item.sortOrder) || 0));
    template = {
      id: uid(),
      content: task.content,
      boxId: task.boxId,
      priority: task.priority ?? null,
      weight: task.weight ?? 1,
      pointsValue: task.pointsValue ?? null,
      progress: 0,
      pinLevel: task.pinLevel ?? null,
      pinned: Boolean(task.pinLevel ?? task.pinned),
      scheduledAt: firstRunAt,
      dueDate: getOccurrenceDueAt(recurrence, firstRunAt),
      isCompleted: false,
      deleted: false,
      deletedAt: null,
      note: task.note || '',
      sortOrder: maxOrder + 1,
      completedAt: null,
      createdAt,
      updatedAt: createdAt,
      syncKey: `recurring-template::${createdAt}::${task.content}`,
      isRecurringTemplate: true,
      recurrence,
      nextRunAt: firstRunAt,
    };
    data.tasks.push(template);
    return data;
  }, { skipCloud: true });

  scheduleApiRequest('/tasks', { method: 'POST', body: JSON.stringify(template) });
  return ensureRecurringTaskInstances().find((item) => item.recurrenceTemplateId === template.id) || null;
}

export function getRecurringTemplates() {
  ensureRecurringTaskInstances();
  return getData().tasks
    .filter((task) => task.isRecurringTemplate && !task.deleted)
    .sort((left, right) => taskTime(left.nextRunAt || left.scheduledAt) - taskTime(right.nextRunAt || right.scheduledAt));
}

export function setRecurringTemplatePaused(templateId, paused) {
  let updated = null;
  updateData((data) => {
    const template = data.tasks.find((task) => task.id === templateId && task.isRecurringTemplate);
    if (!template) return data;
    template.recurrence = { ...template.recurrence, paused: Boolean(paused) };
    template.updatedAt = new Date().toISOString();
    updated = { ...template };
    return data;
  }, { skipCloud: true });
  if (updated) {
    scheduleApiRequest(`/tasks/${encodeURIComponent(templateId)}`, { method: 'PATCH', body: JSON.stringify(updated) });
    if (!paused) ensureRecurringTaskInstances();
  }
  return updated;
}

export function updateRecurringTemplate(templateId, patch = {}) {
  const changed = [];
  let result = null;
  const data = structuredClone(getData());
  const template = data.tasks.find((task) => task.id === templateId && task.isRecurringTemplate && !task.deleted);
  if (!template) return null;
  const current = getTemplateInstances(data, templateId)
    .filter((task) => !task.deleted && !task.isCompleted)
    .sort((left, right) => taskTime(left.scheduledAt) - taskTime(right.scheduledAt))[0] || null;
  const anchorAt = patch.scheduledAt || current?.scheduledAt || template.scheduledAt || template.recurrence?.anchorAt;
  const dueDate = patch.dueDate !== undefined ? patch.dueDate : (current?.dueDate || template.dueDate);
  const recurrenceInput = {
    ...template.recurrence,
    ...(patch.recurrence || {}),
    paused: Boolean(template.recurrence?.paused),
  };
  if (patch.dueDate !== undefined) recurrenceInput.deadlineOffsetMinutes = null;
  const recurrence = normalizeRecurrenceRule(recurrenceInput, anchorAt, dueDate);
  const sharedFields = ['content', 'boxId', 'priority', 'weight', 'pointsValue', 'note', 'pinLevel', 'pinned'];
  sharedFields.forEach((key) => {
    if (patch[key] !== undefined) template[key] = patch[key];
  });
  template.recurrence = recurrence;
  template.scheduledAt = anchorAt;
  template.dueDate = getOccurrenceDueAt(recurrence, anchorAt);
  template.updatedAt = new Date().toISOString();

  if (current) {
    sharedFields.forEach((key) => {
      if (patch[key] !== undefined) current[key] = patch[key];
    });
    current.scheduledAt = anchorAt;
    current.dueDate = getOccurrenceDueAt(recurrence, anchorAt);
    current.recurrence = recurrence;
    current.recurrenceKey = getRecurrenceKey(templateId, anchorAt);
    current.syncKey = current.recurrenceKey;
    current.updatedAt = template.updatedAt;
    changed.push({ ...current });
  }

  template.nextRunAt = recurrence?.mode === 'completion'
    ? null
    : getNextOccurrenceAt(recurrence, current?.scheduledAt || anchorAt);
  changed.push({ ...template });
  result = { ...template };
  saveData(data, { skipCloud: true });
  changed.forEach((task) => scheduleApiRequest(`/tasks/${encodeURIComponent(task.id)}`, { method: 'PATCH', body: JSON.stringify(task) }));
  return result;
}

export function deleteRecurringSeries(templateId) {
  const deleted = [];
  updateData((data) => {
    const timestamp = new Date().toISOString();
    data.tasks.forEach((task) => {
      const belongsToSeries = task.id === templateId || task.recurrenceTemplateId === templateId;
      if (!belongsToSeries || task.isCompleted || task.deleted) return;
      task.deleted = true;
      task.deletedAt = timestamp;
      task.updatedAt = timestamp;
      if (!task.isRecurringTemplate) task.occurrenceStatus = 'cancelled';
      deleted.push({ ...task });
    });
    return data;
  }, { skipCloud: true });
  deleted.forEach((task) => scheduleApiRequest(`/tasks/${encodeURIComponent(task.id)}`, { method: 'DELETE' }));
  return deleted.length;
}

function nextUniqueBoxColor(boxes) {
  const used = new Set(boxes.map((b) => b.color));
  const available = BOX_COLOR_POOL.find((c) => !used.has(c));
  if (available) return available;
  return BOX_COLOR_POOL[boxes.length % BOX_COLOR_POOL.length];
}

export async function addBox({ name, description = '' }) {
  const cleanName = (name || '').trim();
  if (!cleanName) throw new Error('box name required');

  let created = null;
  updateData((data) => {
    if (data.boxes.some((b) => b.name.trim() === cleanName)) {
      throw new Error('box exists');
    }
    created = {
      id: uid(),
      name: cleanName,
      description: description.trim(),
      color: nextUniqueBoxColor(data.boxes),
      icon: '📦',
      sortOrder: data.boxes.length,
      isDefault: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    data.boxes.push(created);
    return data;
  });

  const syncedToApi = scheduleApiRequest('/boxes', {
    method: 'POST',
    body: JSON.stringify(created),
  });
  return created;
}


export function restoreTask(task) {
  let restored = null;
  const superseded = [];
  let recurringTemplate = null;
  updateData((data) => {
    const existing = data.tasks.find((t) => t.id === task.id) || (!task.id && task.syncKey ? data.tasks.find((t) => t.syncKey === task.syncKey) : null);
    if (existing) {
      Object.assign(existing, { ...task, deleted: false, deletedAt: null, updatedAt: new Date().toISOString() });
      restored = { ...existing };
    } else {
      restored = { ...task, deleted: false, deletedAt: null, updatedAt: new Date().toISOString() };
      data.tasks.push(restored);
    }
    if (restored?.recurrenceTemplateId) {
      const otherPending = data.tasks
        .filter((item) => item.id !== restored.id
          && item.recurrenceTemplateId === restored.recurrenceTemplateId
          && !item.deleted
          && !item.isCompleted)
        .sort((left, right) => taskTime(left.scheduledAt) - taskTime(right.scheduledAt));
      const timestamp = new Date().toISOString();
      otherPending.forEach((item) => {
        item.deleted = true;
        item.deletedAt = timestamp;
        item.updatedAt = timestamp;
        item.occurrenceStatus = 'cancelled';
        superseded.push({ ...item });
      });
      const template = data.tasks.find((item) => item.id === restored.recurrenceTemplateId && item.isRecurringTemplate && !item.deleted);
      if (template && otherPending[0]?.scheduledAt) {
        template.nextRunAt = otherPending[0].scheduledAt;
        template.updatedAt = timestamp;
        recurringTemplate = { ...template };
      }
    }
    return data;
  });
  if (restored) {
    scheduleApiRequest(`/tasks/${encodeURIComponent(restored.id)}`, {
      method: 'PATCH',
      body: JSON.stringify(restored),
    });
  }
  superseded.forEach((item) => scheduleApiRequest(`/tasks/${encodeURIComponent(item.id)}`, { method: 'DELETE' }));
  if (recurringTemplate) {
    scheduleApiRequest(`/tasks/${encodeURIComponent(recurringTemplate.id)}`, { method: 'PATCH', body: JSON.stringify(recurringTemplate) });
  }
}

export function updateTask(taskId, patch) {
  const cloudCriticalKeys = new Set(['content', 'boxId', 'priority', 'weight', 'pointsValue', 'progress', 'pinLevel', 'pinned', 'scheduledAt', 'dueDate', 'isCompleted', 'deleted', 'deletedAt', 'sortOrder', 'completedAt', 'note', 'recurrence', 'nextRunAt', 'occurrenceStatus']);
  const shouldCloudPush = Object.keys(patch || {}).some((k) => cloudCriticalKeys.has(k));
  let updated = null;
  let previous = null;
  updateData((data) => {
    const t = data.tasks.find((x) => x.id === taskId);
    if (t) {
      previous = { ...t };
      Object.assign(t, patch);
      t.updatedAt = new Date().toISOString();
      updated = { ...t };
    }
    return data;
  }, { skipCloud: !shouldCloudPush });
  if (updated && shouldCloudPush) {
    scheduleApiRequest(`/tasks/${encodeURIComponent(taskId)}`, {
      method: 'PATCH',
      body: JSON.stringify(updated),
    });
  }
  if (updated?.recurrenceTemplateId && !previous?.isCompleted && updated.isCompleted) {
    const templateId = updated.recurrenceTemplateId;
    updateData((data) => {
      const template = data.tasks.find((task) => task.id === templateId && task.isRecurringTemplate && !task.deleted);
      if (!template) return data;
      const rule = normalizeRecurrenceRule(template.recurrence, updated.scheduledAt, updated.dueDate);
      if (rule?.mode === 'completion') {
        template.nextRunAt = getNextOccurrenceAt(rule, updated.scheduledAt, updated.completedAt);
        template.updatedAt = new Date().toISOString();
        scheduleApiRequest(`/tasks/${encodeURIComponent(template.id)}`, { method: 'PATCH', body: JSON.stringify(template) });
      }
      return data;
    }, { skipCloud: true });
    ensureRecurringTaskInstances();
  }
  return updated;
}

export function deleteTask(taskId) {
  let deleted = null;
  updateData((data) => {
    const t = data.tasks.find((x) => x.id === taskId);
    if (t) {
      t.deleted = true;
      t.deletedAt = new Date().toISOString();
      t.updatedAt = new Date().toISOString();
      if (t.recurrenceTemplateId) t.occurrenceStatus = 'skipped';
      deleted = { ...t };
    }
    return data;
  });
  if (deleted) {
    scheduleApiRequest(`/tasks/${encodeURIComponent(taskId)}`, {
      method: 'DELETE',
    });
  }
  if (deleted?.recurrenceTemplateId) {
    updateData((data) => {
      const template = data.tasks.find((task) => task.id === deleted.recurrenceTemplateId && task.isRecurringTemplate && !task.deleted);
      if (template?.recurrence?.mode === 'completion' && !template.nextRunAt) {
        template.nextRunAt = getNextOccurrenceAt(template.recurrence, deleted.scheduledAt);
        template.updatedAt = new Date().toISOString();
        scheduleApiRequest(`/tasks/${encodeURIComponent(template.id)}`, { method: 'PATCH', body: JSON.stringify(template) });
      }
      return data;
    }, { skipCloud: true });
    ensureRecurringTaskInstances();
  }
}

export function reorderTasks(boxId, orderedTaskIds) {
  updateData((data) => {
    const indexMap = new Map(orderedTaskIds.map((id, i) => [id, i]));
    data.tasks.forEach((t) => {
      if (t.boxId === boxId && !t.isCompleted && indexMap.has(t.id)) t.sortOrder = indexMap.get(t.id);
    });
    return data;
  });
}

export function updateBox(boxId, patch) {
  let updated = null;
  updateData((data) => {
    const box = data.boxes.find((b) => b.id === boxId);
    if (box) {
      Object.assign(box, patch);
      box.updatedAt = new Date().toISOString();
      updated = { ...box };
    }
    return data;
  });
  if (updated) {
    scheduleApiRequest(`/boxes/${encodeURIComponent(boxId)}`, {
      method: 'PATCH',
      body: JSON.stringify(updated),
    });
  }
  return updated;
}

export function setHomePinnedBox(boxId) {
  const current = getData().boxes.find((box) => box.id === boxId);
  if (!current || FIXED_HOME_BOX_COLORS.has(current.color)) return null;
  const shouldPin = !current.homePinned;
  const changed = [];
  const timestamp = new Date().toISOString();

  updateData((data) => {
    data.boxes.forEach((box) => {
      const nextPinned = FIXED_HOME_BOX_COLORS.has(box.color) ? false : (shouldPin && box.id === boxId);
      if (Boolean(box.homePinned) === nextPinned) return;
      box.homePinned = nextPinned;
      box.updatedAt = timestamp;
      changed.push({ ...box });
    });
    return data;
  }, { skipCloud: true });

  changed.forEach((box) => {
    scheduleApiRequest(`/boxes/${encodeURIComponent(box.id)}`, {
      method: 'PATCH',
      body: JSON.stringify(box),
    });
  });
  return shouldPin;
}

export function deleteBox(boxId) {
  const snapshot = getData();
  const box = snapshot.boxes.find((item) => item.id === boxId);
  if (!box) throw new Error('box_not_found');
  if (FIXED_HOME_BOX_COLORS.has(box.color)) throw new Error('box_fixed');
  const activeCount = snapshot.tasks.filter((task) => task.boxId === boxId && !task.deleted).length;
  if (activeCount) {
    const error = new Error('box_not_empty');
    error.count = activeCount;
    throw error;
  }

  updateData((data) => {
    data.boxes = data.boxes.filter((item) => item.id !== boxId);
    data.tasks = data.tasks.filter((task) => task.boxId !== boxId);
    return data;
  }, { skipCloud: true });
  scheduleApiRequest(`/boxes/${encodeURIComponent(boxId)}`, { method: 'DELETE' });
  return box;
}

export function setSettings(patch) {
  updateData((data) => {
    data.settings = { ...data.settings, ...patch };
    return data;
  });
}

const SECRET_VALUE_PATTERNS = [
  /ghp_[A-Za-z0-9]{36}/g,
  /github_pat_[A-Za-z0-9_]+/g,
  /gho_[A-Za-z0-9]{36}/g,
  /ghu_[A-Za-z0-9]{36}/g,
  /ghs_[A-Za-z0-9]{36}/g,
  /ghr_[A-Za-z0-9]{36}/g,
  /sk-[A-Za-z0-9_-]{20,}/g,
  /https:\/\/flomoapp\.com\/iwh\/[^\s"']+/g,
];

function scrubSecretString(value = '') {
  return SECRET_VALUE_PATTERNS.reduce((text, pattern) => text.replace(pattern, ''), String(value));
}

function scrubSecretValues(value) {
  if (typeof value === 'string') return scrubSecretString(value);
  if (Array.isArray(value)) return value.map(scrubSecretValues);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, scrubSecretValues(item)])
    );
  }
  return value;
}

function sanitizeDataForExternal(data) {
  const sanitized = scrubSecretValues(structuredClone(data));
  sanitized.settings = {
    ...sanitized.settings,
    deepseekApiKey: '',
    cloudToken: '',
    githubToken: '',
    flomoWebhook: '',
    apiToken: '',
  };
  return sanitized;
}

export function exportData() {
  const backup = {
    ...sanitizeDataForExternal(getData()),
    __pointsCache: (() => {
      const raw = localStorage.getItem('taskbox_points_cache');
      if (!raw) return null;
      try {
        return scrubSecretValues(JSON.parse(raw));
      } catch {
        return null;
      }
    })(),
  };
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'taskbox-backup.json';
  a.click();
  URL.revokeObjectURL(a.href);
}

export async function importData(file) {
  const text = await file.text();
  const imported = JSON.parse(text);
  const parsed = normalize(imported);
  saveData(parsed);
  if (imported?.__pointsCache) {
    localStorage.setItem('taskbox_points_cache', JSON.stringify(imported.__pointsCache));
  }
}

export function exportDailySummary() {
  const data = getData();
  const targetNames = new Set(['重要盒', '待办盒']);
  const boxMap = new Map(data.boxes.map((b) => [b.id, b.name]));
  const today = new Date().toISOString().slice(0, 10);
  const now = new Date().toISOString();
  const since = data.meta.lastSummaryExportAt ? new Date(data.meta.lastSummaryExportAt) : null;

  const shouldInclude = (t) => {
    if (t.deleted || !targetNames.has(boxMap.get(t.boxId))) return false;
    const completedAt = t.completedAt ? new Date(t.completedAt) : null;
    const updatedAt = t.updatedAt ? new Date(t.updatedAt) : null;
    if (!since) return t.isCompleted || ((Number(t.progress) || 0) > 0);
    if (t.isCompleted && completedAt && completedAt > since) return true;
    if (!t.isCompleted && (Number(t.progress) || 0) > 0 && updatedAt && updatedAt > since) return true;
    return false;
  };

  const rows = data.tasks.filter(shouldInclude);

  const lines = [
    `# ${today} 每日汇总`,
    '',
    `统计区间：${data.meta.lastSummaryExportAt || '首次导出'} -> ${now}`,
    '',
    '## 重要盒 & 待办盒（新增完成/进行中）',
    ''
  ];

  if (!rows.length) lines.push('- 本时段无新增内容');
  rows.forEach((t) => {
    const mark = t.isCompleted ? '[x]' : `[~ ${Math.max(0, Math.min(100, Number(t.progress) || 0))}%]`;
    lines.push(`- ${mark} (${boxMap.get(t.boxId)}) ${t.content}`);
    if (t.note) lines.push(`  - 备注：${t.note}`);
  });

  const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${today}.md`;
  a.click();
  URL.revokeObjectURL(a.href);

  updateData((next) => {
    next.meta.lastSummaryExportAt = now;
    return next;
  });
}

export function playSound(name) {
  if (!getSettings().soundEnabled) return;
  const src = `assets/sounds/${name}.mp3`;
  if (!SOUND_CACHE.has(src)) {
    const audio = new Audio(src);
    audio.preload = 'auto';
    SOUND_CACHE.set(src, audio);
  }
  const base = SOUND_CACHE.get(src);
  const s = base.cloneNode(true);
  s.play().catch(() => {});
}

function scheduleCloudPush() {
  clearTimeout(cloudSyncTimer);
  // Server mode syncs changed records through API calls at the mutation point.
  // Full JSON cloud uploads are intentionally disabled.
  cloudSyncTimer = null;
}


const LOCAL_ONLY_SETTING_KEYS = [
  'deepseekApiKey',
  'flomoWebhook',
  'apiToken',
];

function getApiConfig(settings = getSettings()) {
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
  if (!response.ok) throw new Error(`api_${response.status}`);
  if (response.status === 204) return null;
  return response.json();
}

function scheduleApiRequest(path, options = {}) {
  const config = getApiConfig();
  if (!config.enabled) return false;
  const body = (() => {
    try {
      return typeof options.body === 'string' ? JSON.parse(options.body) : options.body;
    } catch {
      return null;
    }
  })();
  const recordMatch = path.match(/^\/(tasks|boxes)\/([^/?]+)/);
  const collectionMatch = path.match(/^\/(tasks|boxes)$/);
  const queueKey = recordMatch
    ? `${recordMatch[1]}:${decodeURIComponent(recordMatch[2])}`
    : (collectionMatch && body?.id ? `${collectionMatch[1]}:${body.id}` : path);
  const previous = apiMutationQueues.get(queueKey) || Promise.resolve();
  const queued = previous
    .catch(() => null)
    .then(() => apiRequest(path, options));
  apiMutationVersion += 1;
  apiMutationQueues.set(queueKey, queued);
  queued
    .finally(() => {
      if (apiMutationQueues.get(queueKey) === queued) apiMutationQueues.delete(queueKey);
    })
    .catch(() => {});
  return true;
}

async function waitForApiMutations() {
  while (apiMutationQueues.size) {
    await Promise.allSettled([...apiMutationQueues.values()]);
  }
}

function preserveLocalOnlySettings(nextSettings = {}, localSettings = {}) {
  const preserved = { ...nextSettings };
  LOCAL_ONLY_SETTING_KEYS.forEach((key) => {
    if (localSettings[key]) preserved[key] = localSettings[key];
  });
  return preserved;
}

export async function pushDataToCloud(options = {}) {
  return false;
}


function dedupeTasks(tasks) {
  return dedupeTasksByIdentity(tasks);
}

function chooseBoxCopy(current, candidate) {
  if (!current) return { ...candidate };
  const currentTime = Math.max(taskTime(current.updatedAt), taskTime(current.createdAt));
  const candidateTime = Math.max(taskTime(candidate.updatedAt), taskTime(candidate.createdAt));
  return candidateTime >= currentTime ? { ...current, ...candidate } : current;
}

function mergeData(local, cloud) {
  const merged = normalize({
    ...local,
    boxes: [...local.boxes, ...cloud.boxes],
    tasks: [...local.tasks, ...cloud.tasks],
    meta: { updatedAt: new Date().toISOString() },
  });

  const boxesByName = new Map();
  const idRemap = new Map();
  merged.boxes.forEach((b) => {
    if (!boxesByName.has(b.name)) boxesByName.set(b.name, []);
    boxesByName.get(b.name).push(b);
  });

  merged.boxes = Array.from(boxesByName.values()).map((group) => {
    const chosen = group.reduce((current, candidate) => chooseBoxCopy(current, candidate), null);
    group.forEach((box) => idRemap.set(box.id, chosen.id));
    return chosen;
  }).map((b, i) => ({ ...b, sortOrder: i }));
  const validBoxIds = new Set(merged.boxes.map((b) => b.id));

  merged.tasks = dedupeTasks(
    merged.tasks
      .map((t) => ({ ...t, boxId: idRemap.get(t.boxId) || t.boxId }))
      .filter((t) => validBoxIds.has(t.boxId))
  );

  return merged;
}

export async function pullDataFromCloud(options = {}) {
  const apiConfig = getApiConfig();

  if (!apiConfig.enabled) return false;

  await waitForApiMutations();
  const versionBeforePull = apiMutationVersion;
  let cloudData = normalize(await apiRequest('/taskbox'));
  if (apiMutationVersion !== versionBeforePull) {
    await waitForApiMutations();
    cloudData = normalize(await apiRequest('/taskbox'));
  }
  // Read after the request: the user may have edited records while the pull was in flight.
  const local = getData();
  const merged = mergeData(local, cloudData);
  merged.settings = preserveLocalOnlySettings(merged.settings, local.settings);
  saveData(merged, { skipCloud: true });
  ensureRecurringTaskInstances();
  return 'merged';
}
