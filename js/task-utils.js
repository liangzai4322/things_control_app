const DEFAULT_BOX_DAILY_SENTENCE = '把同类任务放进一个盒子里，降低来回切换的成本。';

function pad2(value) {
  return String(value).padStart(2, '0');
}

function toDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function startOfLocalDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function localDateKey(value = new Date()) {
  const date = toDate(value);
  if (!date) return '';
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

export function localDateFromKey(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(date.getTime()) ? null : date;
}

export function isSameLocalDay(left, right) {
  const leftKey = localDateKey(left);
  return Boolean(leftKey && leftKey === localDateKey(right));
}

export function getLocalWeek(value = new Date()) {
  const date = toDate(value) || new Date();
  const start = startOfLocalDay(date);
  const day = start.getDay() || 7;
  start.setDate(start.getDate() - day + 1);
  return Array.from({ length: 7 }, (_, index) => {
    const item = new Date(start);
    item.setDate(start.getDate() + index);
    return item;
  });
}

function nextUsefulTime(date, preferredHour) {
  const target = new Date(date);
  target.setHours(preferredHour, 0, 0, 0);
  if (target > date) return target;
  target.setTime(date.getTime() + 60 * 60 * 1000);
  target.setMinutes(target.getMinutes() < 30 ? 30 : 0, 0, 0);
  if (target.getMinutes() === 0) target.setHours(target.getHours() + 1);
  return target;
}

export function getSchedulePresetValue(preset, now = new Date()) {
  const current = toDate(now) || new Date();
  if (preset === 'clear') return null;

  if (preset === 'today') return nextUsefulTime(current, 18).toISOString();
  if (preset === 'tonight') return nextUsefulTime(current, 20).toISOString();

  const target = startOfLocalDay(current);
  if (preset === 'tomorrow') {
    target.setDate(target.getDate() + 1);
    target.setHours(9, 0, 0, 0);
    return target.toISOString();
  }

  if (preset === 'weekend') {
    const daysUntilSaturday = (6 - target.getDay() + 7) % 7 || 7;
    target.setDate(target.getDate() + daysUntilSaturday);
    target.setHours(10, 0, 0, 0);
    return target.toISOString();
  }

  return null;
}

export function toDateTimeLocalValue(value) {
  const date = toDate(value);
  if (!date) return '';

  return [
    date.getFullYear(),
    '-',
    pad2(date.getMonth() + 1),
    '-',
    pad2(date.getDate()),
    'T',
    pad2(date.getHours()),
    ':',
    pad2(date.getMinutes()),
  ].join('');
}

export function fromDateTimeLocalValue(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;

  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function formatDueLabel(dueDate, now = new Date()) {
  const target = toDate(dueDate);
  const current = toDate(now);
  if (!target || !current) return '';

  const diff = Math.round((startOfLocalDay(target) - startOfLocalDay(current)) / 86400000);
  const time = `${pad2(target.getHours())}:${pad2(target.getMinutes())}`;

  if (diff === 0) return `今天 ${time} 截止`;
  if (diff === 1) return `明天 ${time} 截止`;
  if (diff === -1) return `昨天 ${time} 到期`;
  return `${target.getMonth() + 1}/${target.getDate()} ${time} 截止`;
}

export function formatScheduledLabel(scheduledAt, now = new Date()) {
  const target = toDate(scheduledAt);
  const current = toDate(now);
  if (!target || !current) return '';

  const diff = Math.round((startOfLocalDay(target) - startOfLocalDay(current)) / 86400000);
  const time = `${pad2(target.getHours())}:${pad2(target.getMinutes())}`;

  if (diff === 0) return `今天 ${time}`;
  if (diff === 1) return `明天 ${time}`;
  if (diff === -1) return `昨天 ${time}`;
  return `${target.getMonth() + 1}/${target.getDate()} ${time}`;
}

export function isTaskOverdue(task, now = new Date()) {
  if (!task?.dueDate || task.isCompleted) return false;
  const target = toDate(task.dueDate);
  const current = toDate(now);
  return Boolean(target && current && target < current);
}

export function isTaskNeedsReschedule(task, now = new Date()) {
  if (!task?.scheduledAt || task.isCompleted || isTaskOverdue(task, now)) return false;
  const target = toDate(task.scheduledAt);
  const current = toDate(now);
  return Boolean(target && current && target < current);
}

export function getBoxDailySentence(box, fallback = DEFAULT_BOX_DAILY_SENTENCE) {
  const sentence = String(box?.description || '').trim();
  return sentence || fallback;
}
