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
const SOUND_CACHE = new Map();
const BOX_COLOR_POOL = ['important', 'relax', 'reward', 'misc', 'punish', 'study', 'health'];
const DATA_GIST_OWNER = 'liangzai4322';
const DATA_GIST_ID = 'dee00431619fe628079ffa9713994fc7';
const DATA_GIST_RAW_BASE = `https://gist.githubusercontent.com/${DATA_GIST_OWNER}/${DATA_GIST_ID}/raw`;
const DATA_REPO_OWNER = 'liangzai4322';
const DATA_REPO_NAME = 'things-control-data';
const DATA_REPO_BRANCH = 'main';
const DATA_REPO_RAW_BASE = `https://raw.githubusercontent.com/${DATA_REPO_OWNER}/${DATA_REPO_NAME}/${DATA_REPO_BRANCH}`;
const DEFAULT_PAVILION_URL = `${DATA_GIST_RAW_BASE}/pavilion.json`;
const LEGACY_TOWER_URL = 'https://gist.githubusercontent.com/wangjun6561-ui/6a56c7352da690f8aeca47262361243b/raw/1f947c59ab7be5f873b92d66f71f3d941f7ea5e1/tower.json';
const DEFAULT_TOWER_URL = `${DATA_GIST_RAW_BASE}/tower.json`;
const DEFAULT_POINTS_URL = `${DATA_GIST_RAW_BASE}/mock-points.json`;
const DEFAULT_TASKBOX_URL = `${DATA_GIST_RAW_BASE}/taskbox-backup.json`;
const DEFAULT_FLOMO_WEBHOOK = '';

export function uid() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function normalizeRemoteUrl(value, fallback, filename) {
  const url = String(value || '').trim();
  if (!url) return fallback;
  const isLegacyGist = url.includes('gist.githubusercontent.com/wangjun6561-ui/');
  const isOldDataRepo = url.includes(`${DATA_REPO_OWNER}/${DATA_REPO_NAME}/`);
  const isExpectedFile = !filename || decodeURIComponent(url).endsWith(`/${filename}`);
  return (isLegacyGist || isOldDataRepo) && isExpectedFile ? fallback : url;
}

function normalize(data = {}) {
  return {
    boxes: (Array.isArray(data.boxes) ? data.boxes : []).map((b) => {
      const renamed = b.name === '杂事盒' ? '待办盒' : (b.name === '重要事项' ? '重要盒' : b.name);
      const orderMap = { '重要盒': 0, '待办盒': 1, '放松盒': 2, '奖励盒': 3, '惩罚盒': 4, '碎片学习盒': 5, '健康盒': 6 };
      return { ...b, name: renamed, sortOrder: orderMap[renamed] ?? b.sortOrder ?? 99, color: b.color || BOX_COLOR_POOL[orderMap[renamed] ?? 0] };
    }),
    tasks: (Array.isArray(data.tasks) ? data.tasks : []).map((t) => ({
      ...t,
      weight: t.weight ?? 1,
      pointsValue: t.pointsValue !== undefined && t.pointsValue !== null && Number.isFinite(Number(t.pointsValue)) ? Number(t.pointsValue) : null,
      progress: t.progress ?? (t.isCompleted ? 100 : 0),
      deleted: t.deleted ?? false,
      deletedAt: t.deletedAt ?? null,
      note: t.note ?? [t.reflection, t.review, t.summaryText].filter(Boolean).join('\n').trim(),
      syncKey: t.syncKey || `${t.createdAt || ''}::${t.content || ''}`,
      updatedAt: t.updatedAt || t.createdAt || new Date().toISOString()
    })),
    settings: {
      deepseekApiKey: data.settings?.deepseekApiKey || '',
      themeMode: data.settings?.themeMode || 'system',
      soundEnabled: data.settings?.soundEnabled ?? true,
      cloudProvider: ['json', 'gist', 'github'].includes(data.settings?.cloudProvider) ? data.settings.cloudProvider : 'gist',
      cloudEnabled: data.settings?.cloudEnabled ?? true,
      cloudEndpoint: normalizeRemoteUrl(data.settings?.cloudEndpoint, DEFAULT_TASKBOX_URL, 'taskbox-backup.json'),
      cloudToken: data.settings?.cloudToken || '',
      pavilionDataUrl: normalizeRemoteUrl(data.settings?.pavilionDataUrl, DEFAULT_PAVILION_URL, 'pavilion.json'),
      towerDataUrl: !data.settings?.towerDataUrl || data.settings?.towerDataUrl === LEGACY_TOWER_URL
        ? DEFAULT_TOWER_URL
        : normalizeRemoteUrl(data.settings.towerDataUrl, DEFAULT_TOWER_URL, 'tower.json'),
      pointsDataUrl: normalizeRemoteUrl(data.settings?.pointsDataUrl, DEFAULT_POINTS_URL, 'mock-points.json'),
      flomoWebhook: data.settings?.flomoWebhook || DEFAULT_FLOMO_WEBHOOK,
      githubToken: data.settings?.githubToken || '',
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
      cloudProvider: 'gist',
      cloudEnabled: true,
      cloudEndpoint: DEFAULT_TASKBOX_URL,
      cloudToken: '',
      pointsDataUrl: DEFAULT_POINTS_URL,
      flomoWebhook: DEFAULT_FLOMO_WEBHOOK,
      githubToken: ''
    },
    meta: { updatedAt: now, lastDailyReset: '', lastSummaryExportAt: null },
  });
  localStorage.setItem(STORAGE_KEY, JSON.stringify(initial));
  return initial;
}



function dedupeByContentPerBox(data) {
  const map = new Map();
  data.tasks.forEach((t) => {
    const key = `${t.boxId}::${(t.content || '').trim()}`;
    const prev = map.get(key);
    if (!prev) {
      map.set(key, t);
      return;
    }
    const chosen = prev.deleted && !t.deleted ? t : (!prev.deleted && t.deleted ? prev : (new Date(prev.updatedAt) >= new Date(t.updatedAt) ? prev : t));
    chosen.isCompleted = Boolean(prev.isCompleted || t.isCompleted || chosen.isCompleted);
    chosen.progress = Math.max(Number(prev.progress) || 0, Number(t.progress) || 0, Number(chosen.progress) || 0);
    map.set(key, chosen);
  });
  data.tasks = Array.from(map.values());
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
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return seed();
  try {
    const normalized = normalize(JSON.parse(raw));
    const refreshed = enforceUniqueBoxColors(dedupeByContentPerBox(applyDailyTaskRefresh(normalized)));
    localStorage.setItem(STORAGE_KEY, JSON.stringify(refreshed));
    return refreshed;
  } catch {
    return seed();
  }
}

export function saveData(data, { skipCloud = false } = {}) {
  const normalized = normalize(data);
  normalized.meta.updatedAt = new Date().toISOString();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
  if (!skipCloud) scheduleCloudPush();
}

export function updateData(updater, options = {}) {
  const next = updater(structuredClone(getData()));
  saveData(next, options);
  return next;
}

export const getBoxes = () => getData().boxes.sort((a, b) => a.sortOrder - b.sortOrder);
export const getTasks = () => getData().tasks.filter((t) => !t.deleted);
export const getSettings = () => getData().settings;

export function getTasksByBox(boxId) {
  return getTasks()
    .filter((t) => t.boxId === boxId)
    .sort((a, b) => (Number(b.weight)||1) - (Number(a.weight)||1)
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
  return created;
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
    };
    data.boxes.push(created);
    return data;
  });

  try {
    await pushDataToCloud({ force: true });
  } catch {
    // cloud push best-effort
  }
  return created;
}


export function restoreTask(task) {
  updateData((data) => {
    const existing = data.tasks.find((t) => t.id === task.id || t.syncKey === task.syncKey);
    if (existing) {
      Object.assign(existing, { ...task, deleted: false, deletedAt: null, updatedAt: new Date().toISOString() });
    } else {
      data.tasks.push({ ...task, deleted: false, deletedAt: null, updatedAt: new Date().toISOString() });
    }
    return data;
  });
}

export function updateTask(taskId, patch) {
  const cloudCriticalKeys = new Set(['content', 'boxId', 'priority', 'weight', 'pointsValue', 'progress', 'dueDate', 'isCompleted', 'deleted', 'deletedAt', 'sortOrder', 'completedAt', 'note']);
  const shouldCloudPush = Object.keys(patch || {}).some((k) => cloudCriticalKeys.has(k));
  let updated = null;
  updateData((data) => {
    const t = data.tasks.find((x) => x.id === taskId);
    if (t) {
      Object.assign(t, patch);
      if (Object.prototype.hasOwnProperty.call(patch, 'content')) {
        t.syncKey = `${t.createdAt}::${t.content}`;
      }
      t.updatedAt = new Date().toISOString();
      updated = { ...t };
    }
    return data;
  }, { skipCloud: !shouldCloudPush });
  return updated;
}

export function deleteTask(taskId) {
  updateData((data) => {
    const t = data.tasks.find((x) => x.id === taskId);
    if (t) {
      t.deleted = true;
      t.deletedAt = new Date().toISOString();
      t.updatedAt = new Date().toISOString();
    }
    return data;
  });
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
  updateData((data) => {
    const box = data.boxes.find((b) => b.id === boxId);
    if (box) Object.assign(box, patch);
    return data;
  });
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
  cloudSyncTimer = setTimeout(() => {
    pushDataToCloud().catch(() => {});
  }, 700);
}


function isJsonBinEndpoint(url) {
  return /api\.jsonbin\.io\/v3\/b\//.test(url || '');
}

function normalizeToken(token = '') {
  return token.trim().replace(/^\[|\]$/g, '');
}


function resolveCloudEndpoint(rawEndpoint, { forRead = false } = {}) {
  const value = (rawEndpoint || '').trim();
  if (!value) return '';

  let endpoint = value;
  if (/^[a-f0-9]{24}$/i.test(endpoint)) {
    endpoint = `https://api.jsonbin.io/v3/b/${endpoint}`;
  } else if (endpoint.startsWith('/v3/')) {
    endpoint = `https://api.jsonbin.io${endpoint}`;
  } else if (endpoint.startsWith('v3/')) {
    endpoint = `https://api.jsonbin.io/${endpoint}`;
  }

  if (forRead && isJsonBinEndpoint(endpoint) && !/\/latest$/i.test(endpoint) && !/\/\d+$/i.test(endpoint)) {
    endpoint = `${endpoint.replace(/\/$/, '')}/latest`;
  }

  return endpoint;
}

function buildCloudHeaders(endpoint, token, includeJson = true) {
  const cleanToken = normalizeToken(token);
  const headers = includeJson ? { 'Content-Type': 'application/json' } : {};

  if (!cleanToken) return headers;

  if (isJsonBinEndpoint(endpoint)) {
    headers['X-Master-Key'] = cleanToken;
    headers['X-Access-Key'] = cleanToken;
  } else {
    headers.Authorization = `Bearer ${cleanToken}`;
  }

  return headers;
}

function parseGistRawUrl(url) {
  const match = String(url || '').match(/gist\.githubusercontent\.com\/([^/]+)\/([a-f0-9]+)\/raw(?:\/[a-f0-9]+)?\/(.+)$/i);
  if (!match) return null;
  return { owner: match[1], gistId: match[2], filename: decodeURIComponent(match[3]) };
}

function getStableGistRawUrl(parsed) {
  return `https://gist.githubusercontent.com/${parsed.owner}/${parsed.gistId}/raw/${encodeURIComponent(parsed.filename)}`;
}

function parseGitHubRawUrl(url) {
  const match = String(url || '').match(/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/i);
  if (!match) return null;
  return {
    owner: match[1],
    repo: match[2],
    branch: match[3],
    path: decodeURIComponent(match[4]),
  };
}

function encodeRepoPath(path) {
  return String(path || '').split('/').map((part) => encodeURIComponent(part)).join('/');
}

function getStableGitHubRawUrl(parsed) {
  return `https://raw.githubusercontent.com/${parsed.owner}/${parsed.repo}/${parsed.branch}/${encodeRepoPath(parsed.path)}`;
}

function toBase64Utf8(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function fetchGitHubRepoJson(parsed, rawUrl) {
  const response = await fetch(getStableGitHubRawUrl(parsed) || rawUrl, { cache: 'no-store' });
  if (!response.ok) throw new Error('github_raw_fetch_failed');
  return response.json();
}

async function updateGitHubRepoJson(parsed, token, value) {
  const cleanToken = normalizeToken(token);
  if (!cleanToken) return false;

  const apiPath = encodeRepoPath(parsed.path);
  const apiBase = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/contents/${apiPath}`;
  const currentResponse = await fetch(`${apiBase}?ref=${encodeURIComponent(parsed.branch)}`, {
    method: 'GET',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${cleanToken}`,
    },
    cache: 'no-store',
  });
  if (!currentResponse.ok) throw new Error('github_file_fetch_failed');
  const current = await currentResponse.json();

  const updateResponse = await fetch(apiBase, {
    method: 'PUT',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${cleanToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message: `Update ${parsed.path}`,
      content: toBase64Utf8(`${JSON.stringify(value, null, 2)}\n`),
      sha: current.sha,
      branch: parsed.branch,
    }),
  });
  if (!updateResponse.ok) throw new Error('github_file_update_failed');
  return true;
}

async function fetchGistJson(parsed, rawUrl, token = '') {
  const cleanToken = normalizeToken(token);
  if (!cleanToken) {
    const response = await fetch(getStableGistRawUrl(parsed) || rawUrl, { cache: 'no-store' });
    if (!response.ok) throw new Error('gist_raw_fetch_failed');
    return response.json();
  }

  try {
    const response = await fetch(`https://api.github.com/gists/${parsed.gistId}`, {
      method: 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${cleanToken}`,
      },
      cache: 'no-store',
    });
    if (!response.ok) throw new Error('gist_fetch_failed');
    const payload = await response.json();
    const file = payload?.files?.[parsed.filename];
    if (!file) throw new Error('gist_file_missing');
    const content = file.content || (file.raw_url ? await fetch(file.raw_url, { cache: 'no-store' }).then((res) => res.text()) : '');
    if (!content) throw new Error('gist_file_empty');
    return JSON.parse(content);
  } catch (error) {
    const response = await fetch(getStableGistRawUrl(parsed) || rawUrl, { cache: 'no-store' });
    if (!response.ok) throw error;
    return response.json();
  }
}

async function updateGistJson(parsed, token, value) {
  const cleanToken = normalizeToken(token);
  if (!cleanToken) return false;

  const response = await fetch(`https://api.github.com/gists/${parsed.gistId}`, {
    method: 'PATCH',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${cleanToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      files: {
        [parsed.filename]: {
          content: JSON.stringify(value, null, 2),
        },
      },
    }),
  });
  if (!response.ok) throw new Error('gist_patch_failed');
  return true;
}

const LOCAL_ONLY_SETTING_KEYS = [
  'deepseekApiKey',
  'cloudToken',
  'githubToken',
  'flomoWebhook',
];

function preserveLocalOnlySettings(nextSettings = {}, localSettings = {}) {
  const preserved = { ...nextSettings };
  LOCAL_ONLY_SETTING_KEYS.forEach((key) => {
    if (localSettings[key]) preserved[key] = localSettings[key];
  });
  return preserved;
}

export async function pushDataToCloud(options = {}) {
  const { force = false } = options;
  const data = getData();
  const payload = sanitizeDataForExternal(data);
  const { cloudEnabled, cloudEndpoint, cloudToken, githubToken } = data.settings;

  const endpoint = resolveCloudEndpoint(cloudEndpoint, { forRead: false });
  if (!endpoint) return false;
  if (!force && !cloudEnabled) return false;

  const parsedGist = parseGistRawUrl(endpoint);
  if (parsedGist) {
    return updateGistJson(parsedGist, githubToken || cloudToken, payload);
  }

  const parsedGitHub = parseGitHubRawUrl(endpoint);
  if (parsedGitHub) {
    return updateGitHubRepoJson(parsedGitHub, githubToken || cloudToken, payload);
  }

  await fetch(endpoint, {
    method: 'PUT',
    headers: buildCloudHeaders(endpoint, cloudToken, true),
    body: JSON.stringify(payload),
  });

  return true;
}


function dedupeTasks(tasks) {
  const map = new Map();

  tasks.forEach((t) => {
    const key = t.syncKey || [t.createdAt || '', t.content?.trim()].join('::');
    const current = map.get(key);

    if (!current) {
      map.set(key, { ...t });
      return;
    }

    current.deleted = Boolean(current.deleted || t.deleted);
    current.deletedAt = current.deletedAt || t.deletedAt || null;
    current.isCompleted = Boolean(current.isCompleted || t.isCompleted);
    current.completedAt = current.completedAt || t.completedAt || null;
    current.weight = Math.max(Number(current.weight) || 1, Number(t.weight) || 1);
    current.progress = Math.max(Number(current.progress) || 0, Number(t.progress) || 0);
    current.sortOrder = Math.min(Number(current.sortOrder) || 0, Number(t.sortOrder) || 0);
    map.set(key, current);
  });

  return Array.from(map.values());
}

function mergeData(local, cloud) {
  const merged = normalize({
    ...local,
    boxes: [...local.boxes, ...cloud.boxes],
    tasks: [...local.tasks, ...cloud.tasks],
    meta: { updatedAt: new Date().toISOString() },
  });

  const chosenByName = new Map();
  const idRemap = new Map();
  merged.boxes.forEach((b) => {
    if (!chosenByName.has(b.name)) chosenByName.set(b.name, b);
    idRemap.set(b.id, chosenByName.get(b.name).id);
  });

  merged.boxes = Array.from(chosenByName.values()).map((b, i) => ({ ...b, sortOrder: i }));
  const validBoxIds = new Set(merged.boxes.map((b) => b.id));

  merged.tasks = dedupeTasks(
    merged.tasks
      .map((t) => ({ ...t, boxId: idRemap.get(t.boxId) || t.boxId }))
      .filter((t) => validBoxIds.has(t.boxId))
  );

  return merged;
}

export async function pullDataFromCloud(options = {}) {
  const { force = false } = options;
  const local = getData();
  const { cloudEnabled, cloudEndpoint, cloudToken, githubToken } = local.settings;

  const endpoint = resolveCloudEndpoint(cloudEndpoint, { forRead: true });
  if (!endpoint) return false;
  if (!force && !cloudEnabled) return false;

  const parsedGist = parseGistRawUrl(endpoint);
  const parsedGitHub = parseGitHubRawUrl(endpoint);
  const payload = parsedGist
    ? await fetchGistJson(parsedGist, endpoint, githubToken || cloudToken)
    : parsedGitHub
      ? await fetchGitHubRepoJson(parsedGitHub, endpoint)
      : await (async () => {
      const response = await fetch(endpoint, {
        method: 'GET',
        headers: buildCloudHeaders(endpoint, cloudToken, false),
      });
      if (!response.ok) throw new Error('cloud pull failed');
      return response.json();
    })();

  const cloudRaw = isJsonBinEndpoint(endpoint) ? (payload.record || {}) : payload;
  const cloudData = normalize(cloudRaw);
  const merged = mergeData(local, cloudData);
  merged.settings = preserveLocalOnlySettings(merged.settings, local.settings);
  saveData(merged, { skipCloud: true });
  return 'merged';
}
