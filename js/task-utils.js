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

export function isTaskOverdue(task, now = new Date()) {
  if (!task?.dueDate || task.isCompleted) return false;
  const target = toDate(task.dueDate);
  const current = toDate(now);
  return Boolean(target && current && target < current);
}

export function getBoxDailySentence(box, fallback = DEFAULT_BOX_DAILY_SENTENCE) {
  const sentence = String(box?.description || '').trim();
  return sentence || fallback;
}
