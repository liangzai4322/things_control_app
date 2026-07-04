import { navigate, openSheet, showToast } from './app.js';
import { getSettings, setSettings } from './db.js';
import { openWeightedWheel } from './lucky-wheel.js';

const NUMERALS = ['壹', '貳', '參', '肆', '伍', '陸', '柒', '捌'];
const SW_CACHE_KEYS = {
  pavilion: 'taskbox_sw_pavilion_cache',
  tower: 'taskbox_sw_tower_cache',
};
const SW_CACHE_META_KEYS = {
  pavilion: 'taskbox_sw_pavilion_meta',
  tower: 'taskbox_sw_tower_meta',
};
const SW_MAP_REALM_KEY = 'taskbox_sw_map_active_realm';
const SW_LAST_VISITED_KEY = 'taskbox_sw_last_visited_floor';
const SW_RUNTIME_CACHE = {
  pavilion: null,
  tower: null,
};
const SW_FILTER_STATE = new Map();
const REALM_META = {
  pavilion: {
    label: 'Reward Realm',
    title: '珍宝阁 · 因果台',
    shortTitle: '珍宝阁',
    entityName: '珍宝',
    entityPlural: '奖励',
    addLabel: '添加奖励',
    emptyTitle: '还没有奖励',
    emptyBody: '先加一条奖励，让这一层真正可以被抽中。',
    intro: '把奖励按强度和门槛分层，完成试炼后直接从对应层级领取。',
  },
  tower: {
    label: 'Trial Realm',
    title: '弑神塔 · 天劫台',
    shortTitle: '弑神塔',
    entityName: '试炼',
    entityPlural: '挑战',
    addLabel: '添加试炼',
    emptyTitle: '还没有试炼',
    emptyBody: '给这一层放入真正要面对的挑战，地图才会完整。',
    intro: '把挑战按难度分层，抽取时更容易保持当前阶段的节奏。',
  },
};

async function loadJson(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(path);
  const text = await response.text();
  return parseJsonLenient(text);
}

function extractFirstJsonObject(text) {
  const start = text.indexOf('{');
  if (start < 0) return text;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return text;
}

function parseJsonLenient(text) {
  try {
    return JSON.parse(text);
  } catch {
    const normalized = extractFirstJsonObject(text)
      .replace(/[\u201C\u201D]/g, '"')
      .replace(/[\u2018\u2019]/g, '\'')
      .replace(/^\uFEFF/, '');
    return JSON.parse(normalized);
  }
}

async function loadJsonAny(paths) {
  let lastError;
  for (const path of paths) {
    try {
      const data = await loadJson(path);
      return { data, path };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('No candidate path loaded');
}

function readCachedData(type) {
  const raw = localStorage.getItem(SW_CACHE_KEYS[type]);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function readCacheMeta(type) {
  const raw = localStorage.getItem(SW_CACHE_META_KEYS[type]);
  if (!raw) return {};
  try {
    return JSON.parse(raw) || {};
  } catch {
    return {};
  }
}

function writeCachedData(type, data, meta = {}) {
  localStorage.setItem(SW_CACHE_KEYS[type], JSON.stringify(data));
  localStorage.setItem(SW_CACHE_META_KEYS[type], JSON.stringify({
    ...readCacheMeta(type),
    ...meta,
    updatedAt: new Date().toISOString(),
  }));
}

function setRuntimeCache(type, payload) {
  SW_RUNTIME_CACHE[type] = payload;
}

function getMapRealmPreference(defaultRealm = 'tower') {
  const stored = localStorage.getItem(SW_MAP_REALM_KEY);
  return stored === 'pavilion' || stored === 'tower' ? stored : defaultRealm;
}

function setMapRealmPreference(type) {
  localStorage.setItem(SW_MAP_REALM_KEY, type);
}

function readLastVisitedState() {
  const raw = localStorage.getItem(SW_LAST_VISITED_KEY);
  if (!raw) return {};
  try {
    return JSON.parse(raw) || {};
  } catch {
    return {};
  }
}

function getLastVisitedFloor(type) {
  return readLastVisitedState()[type] || null;
}

function setLastVisitedFloor(type, floorId) {
  const next = {
    ...readLastVisitedState(),
    [type]: String(floorId),
  };
  localStorage.setItem(SW_LAST_VISITED_KEY, JSON.stringify(next));
}

function getRealmEntryTarget(type, floors, isPavilion) {
  const key = isPavilion ? 'level' : 'floor';
  const orderedFloors = sortFloorsForDisplay(floors, isPavilion);
  if (!orderedFloors.length) return null;

  const lastVisited = getLastVisitedFloor(type);
  const resumedFloor = orderedFloors.find((floor) => String(floor[key]) === String(lastVisited));
  const targetFloor = resumedFloor || orderedFloors[0];
  const orderLabel = `${getFloorOrderLabel(Number(targetFloor[key]))}层`;

  return {
    floorId: String(targetFloor[key]),
    actionLabel: `${resumedFloor ? '继续' : '直达'}${orderLabel}`,
    hint: resumedFloor ? `上次停在${orderLabel}` : `默认从${orderLabel}开始`,
  };
}

function getRealmMeta(type) {
  return REALM_META[type];
}

function getRealmUrl(type) {
  return '';
}

function getApiConfig() {
  const settings = getSettings();
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
  if (!response.ok) throw new Error(`small_world_api_${response.status}`);
  if (response.status === 204) return null;
  return response.json();
}

function getSourceBadge(payload) {
  if (!payload) return '未加载';
  if (payload.dirty) return '本地缓存未同步';
  if (payload.source === 'remote') return '远端数据';
  if (payload.source === 'local') return '内置数据';
  return '本地缓存';
}

function refreshRemoteInBackground(type, customUrl) {
  if (readCacheMeta(type).dirty) return;
  loadJson(customUrl)
    .then((data) => {
      writeCachedData(type, data, { source: 'remote', dirty: false });
      setRuntimeCache(type, { data, path: customUrl, source: 'remote', dirty: false });
    })
    .catch(() => {});
}

async function loadSmallWorldSource(type, options = {}) {
  const { preferCache = true, strictRemote = false } = options;
  const customUrl = getRealmUrl(type);
  const remotePath = customUrl;
  const runtime = SW_RUNTIME_CACHE[type];
  if (preferCache && runtime && (runtime.path === remotePath || (!remotePath && runtime.source !== 'remote'))) return runtime;

  const cached = readCachedData(type);
  const cacheMeta = readCacheMeta(type);

  if (getApiConfig().enabled) {
    try {
      const data = await apiRequest(`/smallworld/${type}`);
      writeCachedData(type, data, { source: 'api', dirty: false });
      const payload = { data, path: `api:${type}`, source: 'remote', dirty: false };
      setRuntimeCache(type, payload);
      return payload;
    } catch {
      if (strictRemote) throw new Error(`${type} api pull failed`);
    }
  }

  if (preferCache && cached) {
    const payload = {
      data: cached,
      path: customUrl || `cache:${type}`,
      source: 'cache',
      dirty: Boolean(cacheMeta.dirty),
    };
    setRuntimeCache(type, payload);
    if (customUrl && !payload.dirty) refreshRemoteInBackground(type, customUrl);
    return payload;
  }

  if (customUrl) {
    try {
      const data = await loadJson(customUrl);
      writeCachedData(type, data, { source: 'remote', dirty: false });
      const payload = { data, path: customUrl, source: 'remote', dirty: false };
      setRuntimeCache(type, payload);
      return payload;
    } catch {
      if (strictRemote) throw new Error(`${type} remote pull failed`);
      if (cached) {
        const payload = {
          data: cached,
          path: `cache:${type}`,
          source: 'cache',
          dirty: Boolean(cacheMeta.dirty),
        };
        setRuntimeCache(type, payload);
        return payload;
      }
    }
  }

  try {
    const local = await loadJsonAny(type === 'pavilion' ? ['data/pavilion.json', 'pavilion.json'] : ['data/tower.json', 'tower.json']);
    writeCachedData(type, local.data, { source: 'local', dirty: false });
    const payload = { ...local, source: 'local', dirty: false };
    setRuntimeCache(type, payload);
    return payload;
  } catch {
    if (cached) {
      const payload = {
        data: cached,
        path: `cache:${type}`,
        source: 'cache',
        dirty: Boolean(cacheMeta.dirty),
      };
      setRuntimeCache(type, payload);
      return payload;
    }
    throw new Error(`${type} data load failed`);
  }
}

export async function pullSmallWorldData() {
  const [pavilion, tower] = await Promise.all([
    loadSmallWorldSource('pavilion', { preferCache: false, strictRemote: true }),
    loadSmallWorldSource('tower', { preferCache: false, strictRemote: true }),
  ]);
  return { pavilion, tower };
}

export async function prewarmSmallWorldData() {
  const [pavilion, tower] = await Promise.all([
    loadSmallWorldSource('pavilion', { preferCache: true, strictRemote: false }),
    loadSmallWorldSource('tower', { preferCache: true, strictRemote: false }),
  ]);
  return { pavilion, tower };
}

function mapLevelName(level, name) {
  return `${NUMERALS[level - 1] || level}·${name || ''}`;
}

function truncateText(value, maxLength = 80) {
  const text = safeText(value).trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1)}…`;
}

function getFloorCount(floor, countField) {
  const raw = floor[countField];
  if (Array.isArray(raw)) return raw.length;
  if (Number.isFinite(raw)) return raw;
  if (Number.isFinite(floor.items_count)) return floor.items_count;
  if (Number.isFinite(floor.tasks_count)) return floor.tasks_count;
  if (Array.isArray(floor.items)) return floor.items.length;
  if (Array.isArray(floor.tasks)) return floor.tasks.length;
  if (Number.isFinite(floor.total_tasks)) return floor.total_tasks;
  return 0;
}

function safeText(value) {
  return String(value ?? '');
}

function escapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = safeText(value);
  return div.innerHTML;
}

function clampProgress(value) {
  const num = Number(value) || 0;
  return Math.max(0, Math.min(100, num));
}

function isItemCompleted(item) {
  return Boolean(item?.isCompleted || clampProgress(item?.progress) >= 100);
}

function getItemTitle(item, isPavilion) {
  return safeText(isPavilion
    ? (item.title || item.name || item.label || item.content)
    : (item.name || item.title || item.label || item.content));
}

function getItemDescription(item, isPavilion) {
  return safeText(isPavilion
    ? (item.description || item.desc || item.note)
    : (item.desc || item.description || item.note));
}

function getItemTags(item, isPavilion) {
  return (isPavilion ? item.types : item.tags) || [];
}

function normalizePavilionFloor(floor = {}) {
  const firstArray = (...keys) => {
    for (const key of keys) if (Array.isArray(floor[key])) return floor[key];
    const fuzzy = Object.keys(floor).find((key) => /item/i.test(key) && Array.isArray(floor[key]));
    return fuzzy ? floor[fuzzy] : [];
  };
  return {
    ...floor,
    level: Number(floor.level ?? floor.floor ?? floor.tier ?? 0),
    level_name: floor.level_name || floor.name || floor.title || '',
    level_description: floor.level_description || floor.description || floor.desc || '',
    items_count: Number(floor.items_count ?? floor.total_items ?? floor.count ?? 0),
    items: firstArray('items', 'rewards', 'reward_items'),
    sample_item_titles: firstArray('sample_item_titles', 'sample_titles'),
    sample_item_ids: firstArray('sample_item_ids', 'sample_ids'),
  };
}

function normalizeTowerFloor(floor = {}) {
  const firstArray = (...keys) => {
    for (const key of keys) if (Array.isArray(floor[key])) return floor[key];
    const fuzzy = Object.keys(floor).find((key) => /task/i.test(key) && Array.isArray(floor[key]));
    return fuzzy ? floor[fuzzy] : [];
  };
  return {
    ...floor,
    floor: Number(floor.floor ?? floor.level ?? floor.tier ?? 0),
    floor_name: floor.floor_name || floor.name || floor.title || '',
    floor_desc: floor.floor_desc || floor.description || floor.desc || '',
    difficulty: floor.difficulty || floor.floor_difficulty || floor.difficulty_label || '',
    total_tasks: Number(floor.total_tasks ?? floor.tasks_count ?? floor.count ?? 0),
    tasks_count: Number(floor.tasks_count ?? floor.total_tasks ?? floor.count ?? 0),
    tasks: firstArray('tasks', 'task_list', 'challenges', 'trials'),
    sample_task_names: firstArray('sample_task_names', 'sample_names'),
    sample_task_ids: firstArray('sample_task_ids', 'sample_ids'),
  };
}

function normalizePavilionItem(item = {}, idx = 0, level = 0, fallbackDesc = '') {
  return {
    ...item,
    id: item.id || `L${level}_${idx + 1}`,
    title: item.title || item.name || item.label || '',
    description: item.description || item.desc || fallbackDesc || '',
    types: Array.isArray(item.types) ? item.types : (Array.isArray(item.tags) ? item.tags : []),
  };
}

function normalizeTowerTask(task = {}, idx = 0, floor = 0, fallbackDesc = '') {
  return {
    ...task,
    id: task.id || `F${floor}-${idx + 1}`,
    name: task.name || task.title || task.label || '',
    desc: task.desc || task.description || fallbackDesc || '',
    tags: Array.isArray(task.tags) ? task.tags : (Array.isArray(task.types) ? task.types : []),
  };
}

function pickVaultArray(raw) {
  if (!raw || typeof raw !== 'object') return [];
  const candidates = [raw.treasure_vault, raw.tower, raw.floors, raw.data];
  const hit = candidates.find((candidate) => Array.isArray(candidate));
  return hit || [];
}

function getRawFloor(floorsRaw, floorId, isPavilion) {
  const idKeyCandidates = isPavilion ? ['level', 'floor', 'tier'] : ['floor', 'level', 'tier'];
  return floorsRaw.find((floor = {}) => idKeyCandidates.some((key) => String(floor[key]) === String(floorId)));
}

function buildEditableItems(floor, rawFloor, isPavilion) {
  if (isPavilion) {
    const sourceItems = Array.isArray(rawFloor?.items) && rawFloor.items.length > 0
      ? rawFloor.items
      : (Array.isArray(floor.items) && floor.items.length > 0
        ? floor.items
        : (floor.sample_item_titles || []).map((title, index) => ({
          id: floor.sample_item_ids?.[index],
          title,
        })));
    return sourceItems
      .map((item, index) => normalizePavilionItem(item, index, floor.level, floor.level_description))
      .filter((item) => item.title);
  }

  const sourceTasks = Array.isArray(rawFloor?.tasks) && rawFloor.tasks.length > 0
    ? rawFloor.tasks
    : (Array.isArray(floor.tasks) && floor.tasks.length > 0
      ? floor.tasks
      : (floor.sample_task_names || []).map((name, index) => ({
        id: floor.sample_task_ids?.[index],
        name,
      })));
  return sourceTasks
    .map((item, index) => normalizeTowerTask(item, index, floor.floor, floor.floor_desc))
    .filter((item) => item.name);
}

function getPriorityLabel(priority) {
  if (priority === 3) return 'P3 紧急';
  if (priority === 2) return 'P2 重要';
  if (priority === 1) return 'P1 常规';
  return '普通';
}

function getPriorityColor(priority) {
  if (priority === 3) return '#ef4444';
  if (priority === 2) return '#fb923c';
  if (priority === 1) return '#94a3b8';
  return '#1f2937';
}

function getFloorDescription(floor, isPavilion) {
  return safeText(isPavilion ? floor.level_description : floor.floor_desc);
}

function getFloorDifficulty(floor, isPavilion) {
  if (isPavilion) return '';
  return safeText(floor.difficulty);
}

function getFloorDimensions(floor, limit = 3) {
  return Object.entries(floor)
    .filter(([key, value]) => key.startsWith('dim_') && Number(value) > 0)
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .slice(0, limit)
    .map(([key, value]) => ({
      label: key.replace(/^dim_/, ''),
      value: Number(value),
    }));
}

function getItemStats(items) {
  const total = items.length;
  const completed = items.filter((item) => isItemCompleted(item)).length;
  const active = total - completed;
  return { total, completed, active };
}

function getFloorOrderLabel(value) {
  return NUMERALS[value - 1] || String(value);
}

function getFloorFilter(type, floorId) {
  return SW_FILTER_STATE.get(`${type}:${floorId}`) || 'active';
}

function setFloorFilter(type, floorId, filter) {
  SW_FILTER_STATE.set(`${type}:${floorId}`, filter);
}

function renderSourceBadge(payload) {
  return `<span class="sw-status-badge ${payload?.dirty ? 'warn' : ''}">${escapeHtml(getSourceBadge(payload))}</span>`;
}

function renderMapFloorCard(floor, type, isPavilion) {
  const key = isPavilion ? 'level' : 'floor';
  const nameField = isPavilion ? 'level_name' : 'floor_name';
  const countField = isPavilion ? 'items' : 'tasks';
  const dimensions = !isPavilion ? getFloorDimensions(floor, 2) : [];
  const summaryTags = [
    `${getFloorCount(floor, countField)} 项${getRealmMeta(type).entityName}`,
    ...(!isPavilion && getFloorDifficulty(floor, isPavilion) ? [getFloorDifficulty(floor, isPavilion)] : []),
    ...dimensions.map((item) => `${item.label} ${item.value}`),
  ].slice(0, 3);

  return `
    <button class="sw-floor-card" data-type="${type}" data-floor="${Number(floor[key])}">
      <span class="sw-floor-order">${escapeHtml(getFloorOrderLabel(Number(floor[key])))}</span>
      <div class="sw-floor-copy">
        <div class="sw-floor-headline">
          <strong>${escapeHtml(safeText(floor[nameField]))}</strong>
          <span class="sw-floor-enter">进入 →</span>
        </div>
        <p>${escapeHtml(truncateText(getFloorDescription(floor, isPavilion), 72) || '暂无楼层说明')}</p>
        <div class="sw-chip-row">
          ${summaryTags.map((tag) => `<span class="sw-chip">${escapeHtml(tag)}</span>`).join('')}
        </div>
      </div>
    </button>
  `;
}

function sortFloorsForDisplay(floors, isPavilion) {
  const key = isPavilion ? 'level' : 'floor';
  return [...floors].sort((a, b) => Number(b[key]) - Number(a[key]));
}

function renderFloorJumpBar(type, floors, isPavilion, currentFloorId = null) {
  const orderedFloors = sortFloorsForDisplay(floors, isPavilion);
  const key = isPavilion ? 'level' : 'floor';
  return `
    <div class="sw-floor-jump-row">
      ${orderedFloors.map((floor) => `
        <button class="sw-floor-jump ${String(floor[key]) === String(currentFloorId) ? 'active' : ''}" data-type="${type}" data-floor="${Number(floor[key])}">
          ${escapeHtml(getFloorOrderLabel(Number(floor[key])))}
        </button>
      `).join('')}
    </div>
  `;
}

function renderRealmPortal(type, floors, payload, isPavilion, activeRealm) {
  const meta = getRealmMeta(type);
  const countField = isPavilion ? 'items' : 'tasks';
  const totalEntries = floors.reduce((sum, floor) => sum + getFloorCount(floor, countField), 0);
  const entryTarget = getRealmEntryTarget(type, floors, isPavilion);
  const isActive = activeRealm === type;

  return `
    <article class="sw-realm-portal sw-realm-portal-${type} ${isActive ? 'active' : ''}">
      <div class="sw-realm-portal-head">
        <div>
          <p class="eyebrow">${escapeHtml(meta.label)}</p>
          <h3>${escapeHtml(meta.shortTitle)}</h3>
        </div>
        <span class="sw-realm-portal-mark">${isActive ? '当前领域' : '快速切换'}</span>
      </div>
      <p class="panel-note">${escapeHtml(isActive ? '地图只展开这一组楼层，进来就能直接继续。' : '切到这个领域后，只看这一组楼层，不用再往下翻。')}</p>
      <div class="sw-chip-row">
        <span class="sw-chip">${floors.length} 层结构</span>
        <span class="sw-chip">${totalEntries} 项内容</span>
        ${payload?.dirty ? '<span class="sw-chip warn">有未同步改动</span>' : ''}
      </div>
      <div class="sw-realm-portal-actions">
        <button class="btn ${isActive ? '' : 'subtle'} compact" data-realm-enter="${type}" data-floor="${escapeHtml(entryTarget?.floorId || '')}" ${entryTarget ? '' : 'disabled'}>
          ${escapeHtml(entryTarget ? entryTarget.actionLabel : '暂无可进入楼层')}
        </button>
        <button class="btn subtle compact" data-realm-switch="${type}" ${isActive ? 'disabled' : ''}>
          ${isActive ? '当前已展开' : '展开详情'}
        </button>
      </div>
      <p class="sw-realm-portal-note">${escapeHtml(entryTarget ? entryTarget.hint : meta.emptyBody)}</p>
    </article>
  `;
}

function renderRealmPortalGrid(realms, activeRealm) {
  return `
    <section class="panel sw-realm-picker">
      <div class="sw-realm-picker-head">
        <div>
          <p class="eyebrow">Realm Switch</p>
          <h3>先选领域，再直达楼层</h3>
        </div>
        <p class="panel-note">弑神塔默认优先显示，并记住你上次停留的楼层。</p>
      </div>
      <div class="sw-realm-portals">
        ${realms.map((realm) => renderRealmPortal(realm.type, realm.floors, realm.payload, realm.isPavilion, activeRealm)).join('')}
      </div>
    </section>
  `;
}

function renderRealmSection(type, floors, payload, isPavilion) {
  const meta = getRealmMeta(type);
  const orderedFloors = sortFloorsForDisplay(floors, isPavilion);
  const totalEntries = floors.reduce((sum, floor) => sum + getFloorCount(floor, isPavilion ? 'items' : 'tasks'), 0);

  return `
    <section class="panel sw-realm sw-realm-${type}">
      <div class="sw-realm-head">
        <div>
          <p class="eyebrow">${escapeHtml(meta.label)}</p>
          <h3>${escapeHtml(meta.title)}</h3>
          <p class="panel-note">${escapeHtml(meta.intro)}</p>
        </div>
        ${renderSourceBadge(payload)}
      </div>
      <div class="sw-chip-row sw-summary-row">
        <span class="sw-chip">${floors.length} 层结构</span>
        <span class="sw-chip">${totalEntries} 项内容</span>
        ${payload?.dirty ? '<span class="sw-chip warn">存在仅本地保存的改动</span>' : ''}
      </div>
      ${orderedFloors.length ? renderFloorJumpBar(type, orderedFloors, isPavilion) : ''}
      <div class="sw-floor-stack">
        ${orderedFloors.length
          ? orderedFloors.map((floor) => renderMapFloorCard(floor, type, isPavilion)).join('')
          : `<div class="sw-empty-card"><h4>${escapeHtml(meta.emptyTitle)}</h4><p>${escapeHtml(meta.emptyBody)}</p></div>`}
      </div>
    </section>
  `;
}

export async function renderSmallWorldMap(app) {
  app.innerHTML = `
    <main class="page sw-page" id="small-world">
      <header class="topbar safe-top">
        <button class="icon-btn icon-btn-ghost" id="swBack">←</button>
        <h2>小世界</h2>
        <button class="icon-btn icon-btn-ghost" id="swSettingsBtn" aria-label="小世界设置">⚙</button>
      </header>
      <section class="panel sw-world-loading" id="swContent">
        <p class="eyebrow">Loading</p>
        <h3>正在读取小世界地图</h3>
        <p class="panel-note">会优先使用本地缓存，同时尝试刷新远端数据。</p>
      </section>
    </main>
  `;

  app.querySelector('#swBack').addEventListener('click', () => navigate('#home'));
  app.querySelector('#swSettingsBtn').addEventListener('click', () => navigate('#sw-settings'));

  const [pavilionResult, towerResult] = await Promise.allSettled([
    loadSmallWorldSource('pavilion'),
    loadSmallWorldSource('tower'),
  ]);

  const pavilionPayload = pavilionResult.status === 'fulfilled' ? pavilionResult.value : null;
  const towerPayload = towerResult.status === 'fulfilled' ? towerResult.value : null;
  const pavilionFloors = pavilionPayload ? pickVaultArray(pavilionPayload.data).map(normalizePavilionFloor).filter((floor) => Number.isFinite(floor.level) && floor.level > 0) : [];
  const towerFloors = towerPayload ? pickVaultArray(towerPayload.data).map(normalizeTowerFloor).filter((floor) => Number.isFinite(floor.floor) && floor.floor > 0) : [];

  const totalFloors = pavilionFloors.length + towerFloors.length;
  const totalEntries = pavilionFloors.reduce((sum, floor) => sum + getFloorCount(floor, 'items'), 0)
    + towerFloors.reduce((sum, floor) => sum + getFloorCount(floor, 'tasks'), 0);
  const dirtyRealms = [pavilionPayload, towerPayload].filter((payload) => payload?.dirty).length;
  const realms = [
    { type: 'tower', floors: towerFloors, payload: towerPayload, isPavilion: false },
    { type: 'pavilion', floors: pavilionFloors, payload: pavilionPayload, isPavilion: true },
  ];
  const preferredRealm = getMapRealmPreference('tower');
  const activeRealm = realms.find((realm) => realm.type === preferredRealm && realm.floors.length)
    ? preferredRealm
    : (realms.find((realm) => realm.floors.length)?.type || preferredRealm);
  const activeRealmConfig = realms.find((realm) => realm.type === activeRealm) || realms[0];

  setMapRealmPreference(activeRealm);

  app.querySelector('#swContent').innerHTML = `
    <section class="panel sw-world-hero">
      <div class="sw-world-hero-top">
        <div>
          <p class="eyebrow">World Map</p>
          <h1>把奖励与试炼放回一张地图</h1>
          <p class="panel-note">每一层都是一个明确的难度区间。完成试炼，再从对应层级里抽取真正匹配的反馈。</p>
        </div>
        <button class="btn subtle compact" id="swRefreshBtn">刷新数据</button>
      </div>
      <div class="hero-stats sw-world-stats">
        <article class="stat-card">
          <span>总楼层</span>
          <strong>${totalFloors}</strong>
        </article>
        <article class="stat-card">
          <span>总内容</span>
          <strong>${totalEntries}</strong>
        </article>
        <article class="stat-card">
          <span>本地未同步</span>
          <strong>${dirtyRealms}</strong>
        </article>
      </div>
    </section>

    ${renderRealmPortalGrid(realms, activeRealm)}
    ${renderRealmSection(activeRealmConfig.type, activeRealmConfig.floors, activeRealmConfig.payload, activeRealmConfig.isPavilion)}
  `;

  app.querySelector('#swRefreshBtn').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      await pullSmallWorldData();
      showToast('小世界数据已刷新');
      renderSmallWorldMap(app);
    } catch {
      showToast('刷新失败，请检查数据源 URL 或网络');
      button.disabled = false;
    }
  });

  app.querySelectorAll('.sw-floor-card').forEach((button) => {
    button.addEventListener('click', () => {
      navigate(`#sw/${button.dataset.type}/${button.dataset.floor}`);
    });
  });
  app.querySelectorAll('.sw-floor-jump').forEach((button) => {
    button.addEventListener('click', () => {
      navigate(`#sw/${button.dataset.type}/${button.dataset.floor}`);
    });
  });
  app.querySelectorAll('[data-realm-switch]').forEach((button) => {
    button.addEventListener('click', () => {
      setMapRealmPreference(button.dataset.realmSwitch);
      renderSmallWorldMap(app);
    });
  });
  app.querySelectorAll('[data-realm-enter]').forEach((button) => {
    button.addEventListener('click', () => {
      if (!button.dataset.floor) return;
      navigate(`#sw/${button.dataset.realmEnter}/${button.dataset.floor}`);
    });
  });
}

export function renderSmallWorldSettings(app) {
  const settings = getSettings();
  const pavilionMeta = readCacheMeta('pavilion');
  const towerMeta = readCacheMeta('tower');

  app.innerHTML = `
    <main id="sw-settings" class="page sw-page">
      <header class="topbar safe-top">
        <button class="icon-btn icon-btn-ghost" id="swSettingsBackBtn">←</button>
        <h2>小世界设置</h2>
        <span class="topbar-spacer"></span>
      </header>

      <section class="panel sw-settings-hero">
        <p class="eyebrow">Server Database</p>
        <h3>小世界统一使用服务器数据库</h3>
        <p class="panel-note">珍宝阁和弑神塔都从服务器 API 读取并按记录写回；服务器不可用时只保留本地缓存兜底，不再使用旧的整份 JSON 云同步。</p>
      </section>

      <section class="panel">
        <div class="sw-realm-head">
          <div>
            <p class="eyebrow">Pavilion</p>
            <h3>珍宝阁同步状态</h3>
          </div>
          <span class="sw-status-badge ${pavilionMeta?.dirty ? 'warn' : ''}">${escapeHtml(pavilionMeta?.dirty ? '有本地未同步改动' : '状态正常')}</span>
        </div>
        <p class="panel-note">数据源：${escapeHtml(settings.apiEndpoint || 'https://liangzai666.com/taskbox-api/v1')}</p>
      </section>

      <section class="panel">
        <div class="sw-realm-head">
          <div>
            <p class="eyebrow">Tower</p>
            <h3>弑神塔同步状态</h3>
          </div>
          <span class="sw-status-badge ${towerMeta?.dirty ? 'warn' : ''}">${escapeHtml(towerMeta?.dirty ? '有本地未同步改动' : '状态正常')}</span>
        </div>
        <p class="panel-note">数据源：${escapeHtml(settings.apiEndpoint || 'https://liangzai666.com/taskbox-api/v1')}</p>
      </section>

      <section class="panel">
        <div class="action-grid">
          <button class="btn" id="swPullBtn">从服务器拉取</button>
          <button class="btn" id="swMapBtn">返回地图</button>
        </div>
      </section>

      <section class="panel">
        <div class="sw-realm-head">
          <div>
            <p class="eyebrow">External Service</p>
            <h3>外部服务</h3>
          </div>
        </div>
        <label>Flomo Webhook（用于发送抽奖结果）
          <input id="swFlomoWebhook" class="input" value="${escapeHtml(settings.flomoWebhook || '')}" placeholder="https://flomoapp.com/iwh/...">
        </label>
      </section>
    </main>
  `;

  app.querySelector('#swSettingsBackBtn').addEventListener('click', () => navigate('#smallworld'));
  app.querySelector('#swMapBtn').addEventListener('click', () => navigate('#smallworld'));
  app.querySelector('#swFlomoWebhook').addEventListener('input', (event) => {
    setSettings({ flomoWebhook: event.target.value.trim() });
  });
  app.querySelector('#swPullBtn').addEventListener('click', async () => {
    try {
      await pullSmallWorldData();
      showToast('小世界数据已从服务器拉取');
      renderSmallWorldSettings(app);
    } catch {
      showToast('拉取失败，请检查服务器 API Token 或网络');
    }
  });
}

function syncEditableItemsToRawFloor(rawFloor, items, floor, isPavilion) {
  if (!rawFloor || typeof rawFloor !== 'object') return;
  if (isPavilion) {
    rawFloor.items = items.map((item, index) => ({
      ...item,
      id: item.id || `L${floor.level}_${index + 1}`,
      title: item.title || '',
      description: item.description || '',
      types: Array.isArray(item.types) ? item.types : [],
      progress: clampProgress(item.progress),
      isCompleted: isItemCompleted(item),
      completedAt: item.completedAt || null,
    }));
    rawFloor.items_count = rawFloor.items.length;
    return;
  }

  rawFloor.tasks = items.map((item, index) => ({
    ...item,
    id: item.id || `F${floor.floor}-${index + 1}`,
    name: item.name || '',
    desc: item.desc || '',
    tags: Array.isArray(item.tags) ? item.tags : [],
    progress: clampProgress(item.progress),
    isCompleted: isItemCompleted(item),
    completedAt: item.completedAt || null,
  }));
  rawFloor.tasks_count = rawFloor.tasks.length;
  rawFloor.total_tasks = rawFloor.tasks.length;
}

function normalizeItemCompletion(item, completed) {
  if (completed) {
    item.progress = 100;
    item.isCompleted = true;
    item.completedAt = new Date().toISOString();
    return;
  }
  item.progress = Math.min(clampProgress(item.progress) || 80, 80);
  item.isCompleted = false;
  item.completedAt = null;
}

function renderFloorHero(type, floor, items, payload, isPavilion) {
  const meta = getRealmMeta(type);
  const key = isPavilion ? 'level' : 'floor';
  const nameField = isPavilion ? 'level_name' : 'floor_name';
  const stats = getItemStats(items);
  const floorTags = [
    ...(getFloorDifficulty(floor, isPavilion) ? [getFloorDifficulty(floor, isPavilion)] : []),
    ...getFloorDimensions(floor, 3).map((item) => `${item.label} ${item.value}`),
  ];

  return `
    <section class="panel sw-floor-hero sw-realm-${type}">
      <div class="sw-realm-head">
        <div>
          <p class="eyebrow">${escapeHtml(meta.label)}</p>
          <h1>${escapeHtml(mapLevelName(Number(floor[key]), safeText(floor[nameField])))}</h1>
          <p class="panel-note">${escapeHtml(getFloorDescription(floor, isPavilion) || '暂无楼层说明')}</p>
        </div>
        ${renderSourceBadge(payload)}
      </div>
      ${floorTags.length ? `<div class="sw-chip-row">${floorTags.map((tag) => `<span class="sw-chip">${escapeHtml(tag)}</span>`).join('')}</div>` : ''}
      <div class="hero-stats sw-world-stats">
        <article class="stat-card">
          <span>总数</span>
          <strong>${stats.total}</strong>
        </article>
        <article class="stat-card">
          <span>进行中</span>
          <strong>${stats.active}</strong>
        </article>
        <article class="stat-card">
          <span>已完成</span>
          <strong>${stats.completed}</strong>
        </article>
      </div>
      <div class="sw-floor-actions">
        <button class="btn subtle" id="infoBtn">楼层说明</button>
        <button class="btn subtle" id="spinBtn" ${items.length === 0 ? 'disabled' : ''}>随机抽取</button>
        <button class="btn primary" id="addBtn">${escapeHtml(meta.addLabel)}</button>
      </div>
    </section>
  `;
}

function renderFloorFilters(type, floorId) {
  const current = getFloorFilter(type, floorId);
  const options = [
    ['active', '进行中'],
    ['all', '全部'],
    ['done', '已完成'],
  ];
  return `
    <div class="tabs sw-filter-tabs">
      ${options.map(([value, label]) => `
        <button class="tab ${current === value ? 'active' : ''}" data-filter="${value}">${label}</button>
      `).join('')}
    </div>
  `;
}

function renderFloorItemCard(item, index, isPavilion) {
  const done = isItemCompleted(item);
  const progress = clampProgress(item.progress);
  const color = getPriorityColor(item.priority ?? 0);
  const title = getItemTitle(item, isPavilion);
  const description = getItemDescription(item, isPavilion);
  const tags = getItemTags(item, isPavilion);
  const chips = [
    getPriorityLabel(item.priority ?? 0),
    `${progress}%`,
    ...(tags || []).slice(0, 3),
  ];

  return `
    <article class="sw-item-card ${done ? 'done' : ''}">
      <div class="sw-item-layout">
        <button class="sw-item-toggle ${done ? 'checked' : ''}" data-toggle="${index}" style="--check-color:${color}" aria-label="${done ? '标记为未完成' : '标记为完成'}">${done ? '✓' : '○'}</button>
        <button class="sw-item-body" data-edit="${index}">
          <div class="sw-item-head">
            <strong>${escapeHtml(title)}</strong>
            <span class="sw-item-percent">${progress}%</span>
          </div>
          <p>${escapeHtml(description || '暂无描述')}</p>
          <div class="sw-chip-row">
            ${chips.map((chip) => `<span class="sw-chip">${escapeHtml(chip)}</span>`).join('')}
          </div>
          <div class="mini-progress"><span style="width:${progress}%; background:${color}"></span></div>
        </button>
        <div class="sw-item-side">
          <button class="icon-btn" data-edit-quick="${index}" aria-label="编辑">✎</button>
          <button class="icon-btn" data-del="${index}" aria-label="删除">🗑</button>
        </div>
      </div>
    </article>
  `;
}

function renderFloorList(items, type, floorId, isPavilion) {
  const meta = getRealmMeta(type);
  const filter = getFloorFilter(type, floorId);
  const filteredItems = items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => {
      if (filter === 'done') return isItemCompleted(item);
      if (filter === 'active') return !isItemCompleted(item);
      return true;
    });

  if (!filteredItems.length) {
    const emptyCopy = filter === 'done'
      ? '当前还没有已完成内容。'
      : filter === 'active'
        ? '当前没有进行中的内容。'
        : meta.emptyBody;
    return `
      <div class="sw-empty-card">
        <h4>${escapeHtml(filter === 'all' ? meta.emptyTitle : '筛选结果为空')}</h4>
        <p>${escapeHtml(emptyCopy)}</p>
      </div>
    `;
  }

  return filteredItems
    .map(({ item, index }) => renderFloorItemCard(item, index, isPavilion))
    .join('');
}

export async function renderSmallWorldFloor(app, type, floorId) {
  const isPavilion = type === 'pavilion';
  if (!isPavilion && type !== 'tower') {
    navigate('#smallworld');
    return;
  }

  const loaded = await loadSmallWorldSource(type);
  const key = isPavilion ? 'level' : 'floor';
  const raw = loaded.data;
  const floorsRaw = pickVaultArray(raw);
  const floors = isPavilion ? floorsRaw.map(normalizePavilionFloor) : floorsRaw.map(normalizeTowerFloor);
  const floor = floors.find((item) => String(item[key]) === String(floorId));
  if (!floor) {
    navigate('#smallworld');
    return;
  }

  setMapRealmPreference(type);
  setLastVisitedFloor(type, floor[key]);

  const rawFloor = getRawFloor(floorsRaw, floorId, isPavilion);
  if (!rawFloor) {
    showToast('楼层数据定位失败，请检查 JSON 结构');
    navigate('#smallworld');
    return;
  }

  const items = buildEditableItems(floor, rawFloor, isPavilion);

  app.innerHTML = `
    <main class="page sw-page sw-floor-page">
      <header class="topbar safe-top">
        <button class="icon-btn icon-btn-ghost" id="swBack">←</button>
        <h2>${escapeHtml(getRealmMeta(type).shortTitle)}</h2>
        <button class="icon-btn icon-btn-ghost" id="swMapBtn" aria-label="返回地图">⌂</button>
      </header>

      ${renderFloorHero(type, floor, items, loaded, isPavilion)}

      <section class="section-heading">
        <div>
          <p class="eyebrow">Layer Items</p>
          <h2>${escapeHtml(getRealmMeta(type).entityPlural)}</h2>
        </div>
        <p class="section-note">${items.length} 条内容</p>
      </section>

      ${renderFloorJumpBar(type, floors, isPavilion, floorId)}
      ${renderFloorFilters(type, floorId)}
      <section class="sw-item-list scroll-area" id="swList">
        ${renderFloorList(items, type, floorId, isPavilion)}
      </section>
    </main>
  `;

  app.querySelector('#swBack').addEventListener('click', () => navigate('#smallworld'));
  app.querySelector('#swMapBtn').addEventListener('click', () => navigate('#smallworld'));
  app.querySelector('#infoBtn').addEventListener('click', () => openFloorInfoSheet(type, floor, loaded, isPavilion));
  app.querySelector('#spinBtn').addEventListener('click', () => openSpin(items, isPavilion, async () => {
    await commitFloorChanges({ app, type, floorId, raw, rawFloor, floor, isPavilion, items });
  }));
  app.querySelector('#addBtn').addEventListener('click', () => {
    openFloorItemEditor({ isPavilion }, async (payload) => {
      if (isPavilion) {
        items.push({
          id: `L${floor.level}_${Date.now()}`,
          title: payload.title,
          description: payload.desc,
          types: payload.tags,
          priority: payload.priority,
          progress: payload.progress,
          triangle: { money: 1, time: 1, energy: 1 },
          narrative_line: null,
        });
      } else {
        items.push({
          id: `F${floor.floor}-${Date.now()}`,
          name: payload.title,
          desc: payload.desc,
          tags: payload.tags,
          priority: payload.priority,
          progress: payload.progress,
          dimension: payload.tags[0] || '成长与学习',
          reward_tier: floor.floor,
        });
      }
      await commitFloorChanges({ app, type, floorId, raw, rawFloor, floor, isPavilion, items });
    });
  });

  app.querySelectorAll('[data-filter]').forEach((button) => {
    button.addEventListener('click', () => {
      setFloorFilter(type, floorId, button.dataset.filter);
      renderSmallWorldFloor(app, type, floorId);
    });
  });
  app.querySelectorAll('.sw-floor-jump').forEach((button) => {
    button.addEventListener('click', () => {
      navigate(`#sw/${button.dataset.type}/${button.dataset.floor}`);
    });
  });

  app.querySelectorAll('[data-toggle]').forEach((button) => {
    button.addEventListener('click', async () => {
      const target = items[Number(button.dataset.toggle)];
      normalizeItemCompletion(target, !isItemCompleted(target));
      await commitFloorChanges({ app, type, floorId, raw, rawFloor, floor, isPavilion, items });
    });
  });

  app.querySelectorAll('[data-edit],[data-edit-quick]').forEach((button) => {
    button.addEventListener('click', () => {
      const index = Number(button.dataset.edit ?? button.dataset.editQuick);
      const target = items[index];
      openFloorItemEditor({
        isPavilion,
        initialTitle: getItemTitle(target, isPavilion),
        initialDesc: getItemDescription(target, isPavilion),
        initialTags: getItemTags(target, isPavilion),
        initialPriority: target.priority ?? 0,
        initialProgress: clampProgress(target.progress),
      }, async (payload) => {
        if (isPavilion) {
          Object.assign(target, {
            title: payload.title,
            description: payload.desc,
            types: payload.tags,
            priority: payload.priority,
            progress: payload.progress,
            isCompleted: payload.progress >= 100,
            completedAt: payload.progress >= 100 ? (target.completedAt || new Date().toISOString()) : null,
          });
        } else {
          Object.assign(target, {
            name: payload.title,
            desc: payload.desc,
            tags: payload.tags,
            priority: payload.priority,
            progress: payload.progress,
            isCompleted: payload.progress >= 100,
            completedAt: payload.progress >= 100 ? (target.completedAt || new Date().toISOString()) : null,
          });
        }
        await commitFloorChanges({ app, type, floorId, raw, rawFloor, floor, isPavilion, items });
      });
    });
  });

  app.querySelectorAll('[data-del]').forEach((button) => {
    button.addEventListener('click', async () => {
      const index = Number(button.dataset.del);
      if (!confirm(`确认删除这条${getRealmMeta(type).entityName}吗？`)) return;
      items.splice(index, 1);
      await commitFloorChanges({ app, type, floorId, raw, rawFloor, floor, isPavilion, items });
    });
  });
}

function openFloorInfoSheet(type, floor, payload, isPavilion) {
  const key = isPavilion ? 'level' : 'floor';
  const nameField = isPavilion ? 'level_name' : 'floor_name';
  const extra = [
    getFloorDifficulty(floor, isPavilion),
    ...getFloorDimensions(floor, 4).map((item) => `${item.label} ${item.value}`),
  ].filter(Boolean);

  openSheet(`
    <div class="sheet-handle"></div>
    <div class="sheet-content">
      <p class="eyebrow">${escapeHtml(getRealmMeta(type).label)}</p>
      <h3>${escapeHtml(mapLevelName(Number(floor[key]), safeText(floor[nameField])))}</h3>
      <p class="sheet-lead">${escapeHtml(getFloorDescription(floor, isPavilion) || '暂无楼层说明')}</p>
      ${extra.length ? `<div class="sw-chip-row">${extra.map((item) => `<span class="sw-chip">${escapeHtml(item)}</span>`).join('')}</div>` : ''}
      <div class="sw-info-note">
        <strong>数据来源</strong>
        <p>${escapeHtml(getSourceBadge(payload))}</p>
      </div>
    </div>
  `, { height: '46vh' });
}

function openFloorItemEditor({
  isPavilion,
  initialTitle = '',
  initialDesc = '',
  initialTags = [],
  initialPriority = 0,
  initialProgress = 0,
} = {}, onSave) {
  const { root, close } = openSheet(`
    <div class="sheet-handle"></div>
    <div class="sheet-content">
      <p class="eyebrow">Editor</p>
      <h3>${initialTitle ? '编辑内容' : '新增内容'}</h3>
      <p class="sheet-lead">${isPavilion ? '让奖励标题、描述和标签清晰可抽。' : '把试炼目标、难度线索和标签写完整。'}</p>
      <label>标题<input id="swEditTitle" class="input" value="${escapeHtml(initialTitle)}" placeholder="${isPavilion ? '奖励标题' : '试炼标题'}"></label>
      <label>描述<textarea id="swEditDesc" class="input" rows="4" placeholder="详情描述（抽奖或查看时显示）">${escapeHtml(initialDesc)}</textarea></label>
      <label>标签（逗号分隔）<input id="swEditTags" class="input" value="${escapeHtml((initialTags || []).join(', '))}" placeholder="例如：成长, 社交"></label>
      <label>优先级
        <div class="priority-select">
          ${[0, 1, 2, 3].map((priority) => `<button class="prio-dot p${priority} ${Number(initialPriority) === priority ? 'active' : ''}" data-p="${priority}">${priority === 0 ? '无' : `P${priority}`}</button>`).join('')}
        </div>
      </label>
      <label>完成进度
        <div class="progress-select">
          ${[0, 20, 40, 60, 80, 100].map((progress) => `<button class="progress-dot ${Number(initialProgress) === progress ? 'active' : ''}" data-progress="${progress}">${progress}%</button>`).join('')}
        </div>
      </label>
      <div class="sheet-actions">
        <button class="btn" id="swEditCancel">取消</button>
        <button class="btn primary" id="swEditSave">保存</button>
      </div>
    </div>
  `, { height: '78vh' });

  let priority = Number(initialPriority) || 0;
  let progress = Number(initialProgress) || 0;

  root.querySelectorAll('.prio-dot').forEach((button) => {
    button.addEventListener('click', () => {
      priority = Number(button.dataset.p);
      root.querySelectorAll('.prio-dot').forEach((item) => item.classList.toggle('active', item === button));
    });
  });

  root.querySelectorAll('.progress-dot').forEach((button) => {
    button.addEventListener('click', () => {
      progress = Number(button.dataset.progress);
      root.querySelectorAll('.progress-dot').forEach((item) => item.classList.toggle('active', item === button));
    });
  });

  root.querySelector('#swEditCancel').addEventListener('click', close);
  root.querySelector('#swEditSave').addEventListener('click', () => {
    const title = root.querySelector('#swEditTitle').value.trim();
    if (!title) {
      showToast('标题不能为空');
      return;
    }
    const desc = root.querySelector('#swEditDesc').value.trim();
    const tags = root.querySelector('#swEditTags').value.split(',').map((item) => item.trim()).filter(Boolean);
    onSave?.({ title, desc, tags, priority, progress });
    close();
  });
}

async function persistFloor(type, json) {
  const customUrl = getRealmUrl(type);

  if (getApiConfig().enabled) {
    try {
      await syncSmallWorldToApi(type, json);
      writeCachedData(type, json, { source: 'api', dirty: false });
      setRuntimeCache(type, { data: json, path: `api:${type}`, source: 'remote', dirty: false });
      showToast('已同步到服务器数据库');
      return 'remote';
    } catch {
      writeCachedData(type, json, { source: 'cache', dirty: true });
      setRuntimeCache(type, { data: json, path: customUrl || `cache:${type}`, source: 'cache', dirty: true });
      showToast('服务器同步失败，已保存到本地缓存');
      return 'cache';
    }
  }

  writeCachedData(type, json, { source: 'cache', dirty: true });
  setRuntimeCache(type, { data: json, path: customUrl || `cache:${type}`, source: 'cache', dirty: true });
  showToast('已保存到本地缓存');
  return 'cache';
}

async function commitFloorChanges({ app, type, floorId, raw, rawFloor, floor, isPavilion, items }) {
  syncEditableItemsToRawFloor(rawFloor, items, floor, isPavilion);
  await persistFloor(type, raw);
  renderSmallWorldFloor(app, type, floorId);
}

async function syncSmallWorldToApi(type, json) {
  const floors = pickVaultArray(json);
  const isPavilion = type === 'pavilion';
  for (const floor of floors) {
    const floorId = Number(isPavilion ? floor.level : floor.floor);
    const items = isPavilion ? (floor.items || []) : (floor.tasks || []);
    for (const item of items) {
      const payload = {
        ...item,
        floorId,
        level: isPavilion ? floorId : item.level,
        floor: isPavilion ? item.floor : floorId,
      };
      const id = encodeURIComponent(item.id);
      try {
        await apiRequest(`/smallworld/${type}/items/${id}`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        });
      } catch {
        await apiRequest(`/smallworld/${type}/items`, {
          method: 'POST',
          body: JSON.stringify(payload),
        });
      }
    }
  }
}

function openSpin(items, isPavilion, onComplete) {
  const list = items.filter((item) => !isItemCompleted(item));
  if (list.length === 0) {
    showToast('当前楼层暂无可抽取内容');
    return;
  }

  openWeightedWheel({
    title: isPavilion ? '珍宝阁抽取' : '弑神塔抽取',
    entries: list,
    color: isPavilion ? 'reward' : 'punish',
    getText: (item) => getItemTitle(item, isPavilion),
    onPicked: (root, picked) => showResult(root, picked, isPavilion, onComplete),
  });
}

function showResult(root, item, isPavilion, onComplete) {
  const title = getItemTitle(item, isPavilion);
  const desc = getItemDescription(item, isPavilion);
  const tags = getItemTags(item, isPavilion) || [];
  let completed = false;

  const markDone = async (toastMessage) => {
    if (completed) return;
    completed = true;
    normalizeItemCompletion(item, true);
    await onComplete?.(item);
    if (toastMessage) showToast(toastMessage);
  };

  root.querySelector('#wheelResult').innerHTML = `
    <div class="panel sw-result-card" id="resultCard">
      <p class="eyebrow">${isPavilion ? '奖励结果' : '试炼结果'}</p>
      <h4>${escapeHtml(title)}</h4>
      <p>${escapeHtml(desc || '暂无描述')}</p>
      <div class="sw-chip-row">
        ${tags.map((tag) => `<span class="sw-chip">${escapeHtml(`#${tag}`)}</span>`).join('')}
      </div>
      <div class="sheet-actions sw-result-actions">
        <button class="btn" id="markDoneBtn">标记完成</button>
        <button class="btn primary" id="sendFlomoBtn">发送到 Flomo</button>
      </div>
    </div>
  `;

  root.querySelector('#markDoneBtn').addEventListener('click', async () => {
    await markDone('已标记完成');
  });

  root.querySelector('#sendFlomoBtn').addEventListener('click', async () => {
    const webhook = (getSettings().flomoWebhook || '').trim();
    if (!webhook) {
      showToast('请先在设置中填写 Flomo Webhook');
      return;
    }

    const finalTag = isPavilion ? '#珍宝阁珍宝' : '#弑神塔试炼';
    const markdown = [
      `**${title}**`,
      '',
      desc || '无描述',
      '',
      [tags.length ? tags.map((tag) => `#${safeText(tag)}`).join(' ') : '', finalTag].filter(Boolean).join(' '),
      '',
    ].filter(Boolean).join('\n');

    try {
      const response = await fetch(webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: markdown,
          content_type: 'markdown',
        }),
      });
      if (!response.ok) throw new Error('flomo_failed');
      await markDone('已发送到 Flomo');
    } catch {
      showToast('发送失败，请检查 Flomo Webhook');
    }
  });
}
