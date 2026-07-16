const DEVICE_CONTEXTS = new Set(['desktop', 'mobile', 'universal']);
const DEVICE_MODES = new Set(['auto', 'desktop', 'mobile', 'all']);
const DEVICE_LABELS = {
  desktop: '电脑',
  mobile: '手机',
  universal: '通用',
};

function toDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? new Date(value) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

export function normalizeDeviceContext(value, fallback = 'universal') {
  return DEVICE_CONTEXTS.has(value) ? value : fallback;
}

export function normalizeDeviceMode(value) {
  return DEVICE_MODES.has(value) ? value : 'auto';
}

export function detectDeviceContext() {
  if (typeof navigator !== 'undefined' && navigator.userAgentData?.mobile === true) return 'mobile';
  if (typeof window === 'undefined') return 'desktop';
  const coarsePointer = window.matchMedia?.('(pointer: coarse)')?.matches;
  const narrowViewport = window.matchMedia?.('(max-width: 760px)')?.matches;
  return coarsePointer && narrowViewport ? 'mobile' : 'desktop';
}

export function getEffectiveDeviceContext(settings = {}) {
  const mode = normalizeDeviceMode(settings.deviceContextMode);
  return mode === 'auto' ? detectDeviceContext() : mode;
}

export function getDeviceContextLabel(value) {
  return DEVICE_LABELS[normalizeDeviceContext(value)] || DEVICE_LABELS.universal;
}

export function isTaskReleased(task, referenceTime = new Date()) {
  if (!task || task.isCompleted) return true;
  const visibleAfter = toDate(task.visibleAfter);
  const now = toDate(referenceTime) || new Date();
  return !visibleAfter || visibleAfter <= now;
}

export function isTaskContextMismatch(task, settings = {}) {
  const effective = getEffectiveDeviceContext(settings);
  if (effective === 'all') return false;
  const context = normalizeDeviceContext(task?.deviceContext);
  return context !== 'universal' && context !== effective;
}

export function getTaskContextRank(task, settings = {}) {
  const effective = getEffectiveDeviceContext(settings);
  const context = normalizeDeviceContext(task?.deviceContext);
  if (effective === 'all' || context === effective) return 0;
  if (context === 'universal') return 1;
  return 2;
}

export function getDefaultDeferredUntil(referenceTime = new Date(), releaseTime = '08:00') {
  const now = toDate(referenceTime) || new Date();
  const [hours, minutes] = String(releaseTime || '08:00').split(':').map(Number);
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  next.setHours(Number.isFinite(hours) ? hours : 8, Number.isFinite(minutes) ? minutes : 0, 0, 0);
  return next.toISOString();
}

export function formatVisibleAfter(value, referenceTime = new Date()) {
  const target = toDate(value);
  const now = toDate(referenceTime) || new Date();
  if (!target) return '';
  const targetKey = `${target.getFullYear()}-${target.getMonth()}-${target.getDate()}`;
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const tomorrowKey = `${tomorrow.getFullYear()}-${tomorrow.getMonth()}-${tomorrow.getDate()}`;
  const time = `${pad2(target.getHours())}:${pad2(target.getMinutes())}`;
  if (targetKey === tomorrowKey) return `明天 ${time}`;
  return `${target.getMonth() + 1}/${target.getDate()} ${time}`;
}

export function renderDeviceContextField(selected = 'desktop', name = 'task-device') {
  const current = normalizeDeviceContext(selected, 'desktop');
  return `
    <fieldset class="device-context-field" data-device-context-field="${name}">
      <legend>执行设备</legend>
      <div class="device-context-options">
        ${[
          ['desktop', '电脑', '需要完整工作台'],
          ['mobile', '手机', '碎片时间可完成'],
          ['universal', '通用', '任何设备都可以'],
        ].map(([value, label, hint]) => `
          <button type="button" data-device-context="${value}" class="${current === value ? 'active' : ''}">
            <strong>${label}</strong><small>${hint}</small>
          </button>
        `).join('')}
      </div>
    </fieldset>
  `;
}

export function bindDeviceContextField(root, name = 'task-device', fallback = 'desktop') {
  const field = root.querySelector(`[data-device-context-field="${name}"]`);
  let value = normalizeDeviceContext(field?.querySelector('[data-device-context].active')?.dataset.deviceContext, fallback);
  field?.querySelectorAll('[data-device-context]').forEach((button) => {
    button.addEventListener('click', () => {
      value = normalizeDeviceContext(button.dataset.deviceContext, fallback);
      field.querySelectorAll('[data-device-context]').forEach((item) => item.classList.toggle('active', item === button));
    });
  });
  return { getValue: () => value };
}
