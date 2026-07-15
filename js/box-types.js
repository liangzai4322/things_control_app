export const BOX_TYPE_TASK = 'task';
export const BOX_TYPE_POOL = 'pool';
export const BOX_TYPE_COLLECTION = 'collection';

export const BOX_TYPE_DEFINITIONS = {
  [BOX_TYPE_TASK]: {
    label: '待办盒',
    shortLabel: '待办',
    icon: '✓',
    eyebrow: 'Action Box',
    description: '有明确完成状态，可安排日期、截止时间、积分和周期。',
    itemName: '任务',
    emptyTitle: '还没有进行中的任务',
    emptyDescription: '先加一条任务，让这个盒子开始运转。',
  },
  [BOX_TYPE_POOL]: {
    label: '选项池',
    shortLabel: '选项池',
    icon: '✦',
    eyebrow: 'Choice Pool',
    description: '内容可以反复使用，适合放松、奖励、惩罚和随机抽取。',
    itemName: '选项',
    emptyTitle: '选项池还是空的',
    emptyDescription: '加入几个随时可用的选项，之后可以随机抽取或直接使用。',
  },
  [BOX_TYPE_COLLECTION]: {
    label: '资料清单',
    shortLabel: '清单',
    icon: '⌑',
    eyebrow: 'Reference List',
    description: '不强调完成，适合收藏链接、资料、灵感和稍后阅读内容。',
    itemName: '条目',
    emptyTitle: '清单里还没有内容',
    emptyDescription: '收藏第一条资料、链接或灵感，之后随时回来查看。',
  },
};

const BOX_TYPES = new Set(Object.keys(BOX_TYPE_DEFINITIONS));
const POOL_COLORS = new Set(['relax', 'reward', 'punish']);
const COLLECTION_COLORS = new Set(['study']);

export function inferBoxType(box = {}) {
  if (BOX_TYPES.has(box.boxType)) return box.boxType;
  if (POOL_COLORS.has(box.color)) return BOX_TYPE_POOL;
  if (COLLECTION_COLORS.has(box.color)) return BOX_TYPE_COLLECTION;
  return BOX_TYPE_TASK;
}

export function normalizeBoxType(value, fallbackBox = {}) {
  return BOX_TYPES.has(value) ? value : inferBoxType(fallbackBox);
}

export function normalizeBoxTypeConfig(type, config = {}) {
  const normalizedType = normalizeBoxType(type);
  const defaults = normalizedType === BOX_TYPE_POOL
    ? { drawEnabled: true, defaultCooldownMinutes: 0 }
    : normalizedType === BOX_TYPE_COLLECTION
      ? { linksEnabled: true, archiveEnabled: true }
      : { pointsEnabled: true, recurrenceEnabled: true };
  return { ...defaults, ...(config && typeof config === 'object' ? config : {}) };
}

export function getBoxTypeDefinition(boxOrType) {
  const type = typeof boxOrType === 'string' ? normalizeBoxType(boxOrType) : inferBoxType(boxOrType);
  return BOX_TYPE_DEFINITIONS[type];
}

export function isTaskBox(box) {
  return inferBoxType(box) === BOX_TYPE_TASK;
}

export function isPoolBox(box) {
  return inferBoxType(box) === BOX_TYPE_POOL;
}

export function isCollectionBox(box) {
  return inferBoxType(box) === BOX_TYPE_COLLECTION;
}

export function getPoolCooldownState(item, referenceTime = new Date()) {
  const cooldownMinutes = Math.max(0, Number(item?.cooldownMinutes) || 0);
  const lastUsedAt = item?.lastUsedAt ? new Date(item.lastUsedAt) : null;
  if (!cooldownMinutes || !lastUsedAt || Number.isNaN(lastUsedAt.getTime())) {
    return { available: true, remainingMinutes: 0, availableAt: null };
  }
  const availableAt = new Date(lastUsedAt.getTime() + cooldownMinutes * 60_000);
  const remainingMinutes = Math.max(0, Math.ceil((availableAt.getTime() - new Date(referenceTime).getTime()) / 60_000));
  return {
    available: remainingMinutes === 0,
    remainingMinutes,
    availableAt: availableAt.toISOString(),
  };
}

export function formatCooldownRemaining(minutes) {
  const value = Math.max(0, Number(minutes) || 0);
  if (!value) return '现在可用';
  if (value < 60) return `${value} 分钟后可用`;
  const hours = Math.ceil(value / 60);
  if (hours < 24) return `${hours} 小时后可用`;
  return `${Math.ceil(hours / 24)} 天后可用`;
}

export function renderBoxTypeOptions(selectedType = BOX_TYPE_TASK) {
  const normalized = normalizeBoxType(selectedType);
  return Object.entries(BOX_TYPE_DEFINITIONS).map(([type, definition]) => `
    <button type="button" class="box-type-option ${normalized === type ? 'active' : ''}" data-box-type-option="${type}" aria-pressed="${normalized === type}">
      <span class="box-type-option-icon">${definition.icon}</span>
      <span><strong>${definition.label}</strong><small>${definition.description}</small></span>
      <i></i>
    </button>
  `).join('');
}

export function bindBoxTypeOptions(root, initialType = BOX_TYPE_TASK) {
  let value = normalizeBoxType(initialType);
  const buttons = [...root.querySelectorAll('[data-box-type-option]')];
  const select = (nextType) => {
    value = normalizeBoxType(nextType);
    buttons.forEach((button) => {
      const active = button.dataset.boxTypeOption === value;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
  };
  buttons.forEach((button) => button.addEventListener('click', () => select(button.dataset.boxTypeOption)));
  return { getValue: () => value, setValue: select };
}
