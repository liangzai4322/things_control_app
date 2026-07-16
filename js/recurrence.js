const VALID_TYPES = new Set(['daily', 'interval', 'weekly', 'monthly']);
const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function toDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? new Date(value) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function clampInteger(value, min, max, fallback) {
  const number = Math.round(Number(value));
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

function timeFromDate(value, fallback = '09:00') {
  const date = toDate(value);
  return date ? `${pad2(date.getHours())}:${pad2(date.getMinutes())}` : fallback;
}

function parseTime(value, fallback = '09:00') {
  const match = String(value || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return parseTime(fallback, '09:00');
  return {
    hours: clampInteger(match[1], 0, 23, 9),
    minutes: clampInteger(match[2], 0, 59, 0),
  };
}

function normalizedTime(value, fallback = '09:00') {
  const parsed = parseTime(value, fallback);
  return `${pad2(parsed.hours)}:${pad2(parsed.minutes)}`;
}

function applyTime(date, time) {
  const next = new Date(date);
  const parsed = parseTime(time);
  next.setHours(parsed.hours, parsed.minutes, 0, 0);
  return next;
}

function addCalendarDays(value, days, time) {
  const date = toDate(value) || new Date();
  const next = new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
  return applyTime(next, time);
}

function daysInMonth(year, month) {
  return new Date(year, month + 1, 0).getDate();
}

function monthlyDate(year, month, monthDay, time) {
  const day = monthDay === 'last'
    ? daysInMonth(year, month)
    : Math.min(clampInteger(monthDay, 1, 31, 1), daysInMonth(year, month));
  return applyTime(new Date(year, month, day), time);
}

export function normalizeRecurrenceRule(rule = {}, scheduledAt = null, dueDate = null) {
  const type = VALID_TYPES.has(rule.type) ? rule.type : 'none';
  if (type === 'none') return null;

  const anchor = toDate(rule.anchorAt || scheduledAt) || new Date();
  const due = toDate(dueDate);
  const hasDeadlineOffset = rule.deadlineOffsetMinutes !== null
    && rule.deadlineOffsetMinutes !== undefined
    && Number.isFinite(Number(rule.deadlineOffsetMinutes));
  const deadlineOffsetMinutes = hasDeadlineOffset
    ? Math.max(0, Math.round(Number(rule.deadlineOffsetMinutes)))
    : (due ? Math.max(0, Math.round((due.getTime() - anchor.getTime()) / 60000)) : null);

  return {
    type,
    interval: type === 'interval' ? clampInteger(rule.interval, 1, 365, 2) : 1,
    mode: type === 'interval' && rule.mode === 'completion' ? 'completion' : 'calendar',
    weekday: clampInteger(rule.weekday, 0, 6, anchor.getDay()),
    monthDay: rule.monthDay === 'last' ? 'last' : clampInteger(rule.monthDay, 1, 31, anchor.getDate()),
    time: normalizedTime(rule.time || timeFromDate(anchor)),
    releaseTime: normalizedTime(rule.releaseTime || '08:00', '08:00'),
    anchorAt: anchor.toISOString(),
    deadlineOffsetMinutes,
    missPolicy: rule.missPolicy === 'skip' ? 'skip' : 'carry',
    paused: Boolean(rule.paused),
  };
}

export function getNextOccurrenceAt(rule, previousScheduledAt, completedAt = null) {
  const normalized = normalizeRecurrenceRule(rule, previousScheduledAt);
  if (!normalized) return null;
  const previous = toDate(previousScheduledAt || normalized.anchorAt) || new Date();

  if (normalized.type === 'daily') {
    return addCalendarDays(previous, 1, normalized.time).toISOString();
  }

  if (normalized.type === 'interval') {
    const base = normalized.mode === 'completion' ? (toDate(completedAt) || previous) : previous;
    return addCalendarDays(base, normalized.interval, normalized.time).toISOString();
  }

  if (normalized.type === 'weekly') {
    const next = addCalendarDays(previous, 1, normalized.time);
    const daysUntilTarget = (normalized.weekday - next.getDay() + 7) % 7;
    return addCalendarDays(next, daysUntilTarget, normalized.time).toISOString();
  }

  const current = toDate(previous) || new Date();
  const nextMonth = new Date(current.getFullYear(), current.getMonth() + 1, 1);
  return monthlyDate(nextMonth.getFullYear(), nextMonth.getMonth(), normalized.monthDay, normalized.time).toISOString();
}

export function getOccurrenceDueAt(rule, scheduledAt) {
  const normalized = normalizeRecurrenceRule(rule, scheduledAt);
  const scheduled = toDate(scheduledAt);
  if (!normalized || !scheduled || normalized.deadlineOffsetMinutes === null) return null;
  return new Date(scheduled.getTime() + normalized.deadlineOffsetMinutes * 60000).toISOString();
}

export function getOccurrenceVisibleAfter(rule, scheduledAt) {
  const normalized = normalizeRecurrenceRule(rule, scheduledAt);
  const scheduled = toDate(scheduledAt);
  if (!normalized || !scheduled) return null;
  const releaseDate = new Date(scheduled.getFullYear(), scheduled.getMonth(), scheduled.getDate());
  return applyTime(releaseDate, normalized.releaseTime).toISOString();
}

export function getRecurrenceLabel(rule) {
  const normalized = normalizeRecurrenceRule(rule, rule?.anchorAt);
  if (!normalized) return '';
  const release = ` · ${normalized.releaseTime} 出现`;
  if (normalized.type === 'daily') return `每天 ${normalized.time}${release}`;
  if (normalized.type === 'interval') {
    const label = normalized.mode === 'completion'
      ? `完成后 ${normalized.interval} 天`
      : `每 ${normalized.interval} 天`;
    return `${label}${release}`;
  }
  if (normalized.type === 'weekly') return `每${WEEKDAY_LABELS[normalized.weekday]} ${normalized.time}${release}`;
  const label = normalized.monthDay === 'last'
    ? `每月最后一天 ${normalized.time}`
    : `每月 ${normalized.monthDay} 日 ${normalized.time}`;
  return `${label}${release}`;
}

export function getRecurrenceKey(templateId, scheduledAt) {
  const date = toDate(scheduledAt);
  if (!templateId || !date) return '';
  return `${templateId}::${date.toISOString()}`;
}

export function getRecurringOccurrenceId(templateId, scheduledAt) {
  const date = toDate(scheduledAt);
  if (!templateId || !date) return '';
  return `rec-${templateId}-${date.getTime()}`;
}

export function getFirstOccurrenceAt(rule, scheduledAt = null) {
  const normalized = normalizeRecurrenceRule(rule, scheduledAt);
  if (!normalized) return null;
  const anchor = toDate(scheduledAt || normalized.anchorAt) || new Date();
  if (normalized.type === 'weekly') {
    const candidate = applyTime(anchor, normalized.time);
    const daysUntilTarget = (normalized.weekday - candidate.getDay() + 7) % 7;
    candidate.setDate(candidate.getDate() + daysUntilTarget);
    return candidate.toISOString();
  }
  if (normalized.type === 'monthly') {
    let candidate = monthlyDate(anchor.getFullYear(), anchor.getMonth(), normalized.monthDay, normalized.time);
    if (candidate < anchor) {
      const nextMonth = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 1);
      candidate = monthlyDate(nextMonth.getFullYear(), nextMonth.getMonth(), normalized.monthDay, normalized.time);
    }
    return candidate.toISOString();
  }
  return applyTime(anchor, normalized.time).toISOString();
}

export function getWeekdayLabels() {
  return [...WEEKDAY_LABELS];
}
