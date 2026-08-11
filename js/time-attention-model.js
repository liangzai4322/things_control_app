export const TIME_ATTENTION_STORAGE_KEY = 'taskbox_time_attention_os_v1';
export const TIME_ATTENTION_SCHEMA_VERSION = 3;

const MINUTE_MS = 60 * 1000;
const num = (value, min, max) => value === '' || value == null || !Number.isFinite(Number(value)) ? null : Math.min(max, Math.max(min, Number(value)));
const clean = (value) => String(value || '').trim();
const clock = (value) => /^([01]\d|2[0-3]):[0-5]\d$/.test(value || '') ? value : '';
const timestamp = (value) => {
  if (value == null || value === '') return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

export const clockMinutes = (value) => {
  const valid = clock(value);
  if (!valid) return null;
  const [hours, minutes] = valid.split(':').map(Number);
  return hours * 60 + minutes;
};

export function normalizeTimePlan(value = {}) {
  const actualFocusMinutes = num(value.actualFocusMinutes, 0, 1440);
  return {
    date: /^\d{4}-\d{2}-\d{2}$/.test(value.date || '') ? value.date : '',
    availableMinutes: num(value.availableMinutes, 0, 1440),
    fixedCommitmentMinutes: num(value.fixedCommitmentMinutes, 0, 1440) ?? 0,
    bufferMinutes: num(value.bufferMinutes, 0, 480) ?? 0,
    fixedCommitments: clean(value.fixedCommitments),
    focusStart: clock(value.focusStart),
    focusEnd: clock(value.focusEnd),
    focusTaskId: clean(value.focusTaskId) || null,
    triggerAnchor: clean(value.triggerAnchor),
    actualFocusMinutes,
    actualFocusSource: actualFocusMinutes == null ? null : clean(value.actualFocusSource) || null,
    interruptions: num(value.interruptions, 0, 99),
    biggestLeak: clean(value.biggestLeak),
    stoppedAt: clock(value.stoppedAt),
    notes: clean(value.notes),
    updatedAt: value.updatedAt || null,
  };
}

const CANDIDATE_RECORD_TYPES = new Set(['observation', 'claim', 'source_proposal']);
const CANDIDATE_DATE_MAPPINGS = new Set(['exact', 'range', 'unknown']);
const CANDIDATE_STATUSES = new Set(['pending', 'confirmed_date', 'rejected']);

export function normalizeTimeCandidate(value = {}) {
  const activity = value.activity && typeof value.activity === 'object' ? value.activity : {};
  const dateMapping = CANDIDATE_DATE_MAPPINGS.has(activity.dateMapping || value.dateMapping)
    ? (activity.dateMapping || value.dateMapping)
    : 'unknown';
  const status = CANDIDATE_STATUSES.has(value.status) ? value.status : 'pending';
  const confirmedActivityDate = /^\d{4}-\d{2}-\d{2}$/.test(value.confirmedActivityDate || '')
    ? value.confirmedActivityDate
    : null;
  return {
    candidateId: clean(value.candidateId || value.claimId || value.candidateLineId),
    candidateLineId: clean(value.candidateLineId) || null,
    recordType: CANDIDATE_RECORD_TYPES.has(value.recordType) ? value.recordType : 'observation',
    domain: 'time',
    authority: ['external_evidence', 'user_interpretation', 'ai_summary'].includes(value.authority) ? value.authority : 'ai_summary',
    epistemicState: clean(value.epistemicState) || 'missing_evidence',
    content: clean(value.content || value.sourceExcerpt),
    reviewDate: /^\d{4}-\d{2}-\d{2}$/.test(value.reviewDate || '') ? value.reviewDate : null,
    dateMapping,
    sourceRef: clean(value.sourceRef),
    status: status === 'confirmed_date' && !confirmedActivityDate ? 'pending' : status,
    confirmedActivityDate,
    confirmedAt: timestamp(value.confirmedAt)?.toISOString() || null,
    rejectedAt: timestamp(value.rejectedAt)?.toISOString() || null,
    rejectionReason: clean(value.rejectionReason),
    validatedFact: false,
    readOnlySource: true,
  };
}

export function importTimeCandidates(store = {}, records = []) {
  const current = normalizeTimeStore(store);
  const byId = new Map(current.candidates.map((candidate) => [candidate.candidateId, candidate]));
  let accepted = 0;
  let ignored = 0;
  (Array.isArray(records) ? records : []).forEach((record) => {
    if (record?.domain !== 'time' || !CANDIDATE_RECORD_TYPES.has(record.recordType)) { ignored += 1; return; }
    const candidate = normalizeTimeCandidate({ ...record, status: 'pending', confirmedActivityDate: null, confirmedAt: null, rejectedAt: null, rejectionReason: '' });
    if (!candidate.candidateId || !candidate.content || !candidate.sourceRef) { ignored += 1; return; }
    const existing = byId.get(candidate.candidateId);
    byId.set(candidate.candidateId, existing ? { ...candidate, ...existing } : candidate);
    accepted += 1;
  });
  return {
    store: normalizeTimeStore({ ...current, candidates: [...byId.values()] }),
    accepted,
    ignored,
  };
}

export function updateTimeCandidate(store = {}, candidateId, patch = {}, now = new Date()) {
  const current = normalizeTimeStore(store);
  const id = clean(candidateId);
  const candidates = current.candidates.map((candidate) => {
    if (candidate.candidateId !== id) return candidate;
    if (patch.status === 'confirmed_date') {
      const confirmedActivityDate = /^\d{4}-\d{2}-\d{2}$/.test(patch.confirmedActivityDate || '') ? patch.confirmedActivityDate : null;
      if (!confirmedActivityDate) return candidate;
      return normalizeTimeCandidate({ ...candidate, status: 'confirmed_date', confirmedActivityDate, confirmedAt: now.toISOString(), rejectedAt: null, rejectionReason: '' });
    }
    if (patch.status === 'rejected') {
      return normalizeTimeCandidate({ ...candidate, status: 'rejected', confirmedActivityDate: null, confirmedAt: null, rejectedAt: now.toISOString(), rejectionReason: patch.rejectionReason });
    }
    return candidate;
  });
  return normalizeTimeStore({ ...current, candidates });
}

export function buildTimeCandidateInbox(store = {}) {
  const candidates = normalizeTimeStore(store).candidates;
  return {
    candidates,
    pendingCount: candidates.filter((candidate) => candidate.status === 'pending').length,
    confirmedDateCount: candidates.filter((candidate) => candidate.status === 'confirmed_date').length,
    rejectedCount: candidates.filter((candidate) => candidate.status === 'rejected').length,
    dailySequenceCandidates: candidates.filter((candidate) => candidate.status === 'confirmed_date' && candidate.confirmedActivityDate),
  };
}

export function normalizeCalendarEvent(value = {}) {
  const start = timestamp(value.startAt);
  const end = timestamp(value.endAt);
  if (!start || !end || end <= start) return null;
  return {
    eventId: clean(value.eventId) || `calendar-${start.getTime()}-${end.getTime()}`,
    title: clean(value.title) || '外部日历事项',
    startAt: start.toISOString(),
    endAt: end.toISOString(),
    allDay: Boolean(value.allDay),
    busy: value.busy !== false,
    source: 'calendar',
    readOnly: true,
  };
}

export function normalizeCalendarSnapshot(value = {}) {
  const events = (Array.isArray(value.events) ? value.events : []).map(normalizeCalendarEvent).filter(Boolean);
  return {
    status: events.length || value.status === 'connected' ? 'connected' : 'unavailable',
    sourceName: clean(value.sourceName),
    readAt: timestamp(value.readAt)?.toISOString() || null,
    events,
  };
}

function unfoldIcs(text) {
  return String(text || '').replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '').split(/\r?\n/);
}

function unescapeIcs(value) {
  return String(value || '').replace(/\\n/gi, ' ').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\').trim();
}

function parseIcsDate(value, parameters = '') {
  const raw = clean(value);
  if (!raw) return null;
  const allDay = /VALUE=DATE/i.test(parameters) || /^\d{8}$/.test(raw);
  const match = raw.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?)?(Z)?$/);
  if (!match) return null;
  const [, year, month, day, hours = '00', minutes = '00', seconds = '00', utc] = match;
  const iso = `${year}-${month}-${day}T${hours}:${minutes}:${seconds}${utc ? 'Z' : '+08:00'}`;
  const date = timestamp(iso);
  return date ? { date, allDay } : null;
}

export function parseIcsCalendar(text, { sourceName = 'calendar.ics', readAt = new Date().toISOString() } = {}) {
  const events = [];
  let current = null;
  unfoldIcs(text).forEach((line) => {
    if (line === 'BEGIN:VEVENT') { current = {}; return; }
    if (line === 'END:VEVENT') {
      if (current && current.status !== 'CANCELLED') {
        const start = parseIcsDate(current.start, current.startParams);
        const end = parseIcsDate(current.end, current.endParams);
        const fallbackEnd = start ? new Date(start.date.getTime() + (start.allDay ? 1440 : 30) * MINUTE_MS) : null;
        const normalized = normalizeCalendarEvent({
          eventId: current.uid,
          title: current.summary,
          startAt: start?.date,
          endAt: end?.date || fallbackEnd,
          allDay: start?.allDay,
          busy: current.transparency !== 'TRANSPARENT',
        });
        if (normalized) events.push(normalized);
      }
      current = null;
      return;
    }
    if (!current) return;
    const separator = line.indexOf(':');
    if (separator < 0) return;
    const header = line.slice(0, separator);
    const value = line.slice(separator + 1);
    const [name, ...parameters] = header.split(';');
    const key = name.toUpperCase();
    if (key === 'UID') current.uid = unescapeIcs(value);
    else if (key === 'SUMMARY') current.summary = unescapeIcs(value);
    else if (key === 'DTSTART') { current.start = value; current.startParams = parameters.join(';'); }
    else if (key === 'DTEND') { current.end = value; current.endParams = parameters.join(';'); }
    else if (key === 'TRANSP') current.transparency = value.toUpperCase();
    else if (key === 'STATUS') current.status = value.toUpperCase();
  });
  return normalizeCalendarSnapshot({ status: 'connected', sourceName, readAt, events });
}

function dayBounds(date) {
  const start = timestamp(`${date}T00:00:00+08:00`);
  return start ? [start.getTime(), start.getTime() + 1440 * MINUTE_MS] : [0, 0];
}

function localDateKey(value) {
  const parsed = timestamp(value);
  if (!parsed) return '';
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(parsed);
}

function unionMinutes(ranges = []) {
  const sorted = ranges.filter(([start, end]) => end > start).sort((left, right) => left[0] - right[0]);
  if (!sorted.length) return 0;
  const merged = [sorted[0]];
  sorted.slice(1).forEach(([start, end]) => {
    const previous = merged[merged.length - 1];
    if (start <= previous[1]) previous[1] = Math.max(previous[1], end);
    else merged.push([start, end]);
  });
  return Math.round(merged.reduce((total, [start, end]) => total + end - start, 0) / MINUTE_MS);
}

function rangesOverlap(left, right) {
  return left[0] < right[1] && right[0] < left[1];
}

export function deriveTimePlanState(input = {}, { fixedCommitmentMinutes = null, conflicts = [] } = {}) {
  const plan = normalizeTimePlan(input);
  const start = clockMinutes(plan.focusStart);
  const end = clockMinutes(plan.focusEnd);
  const focusMinutes = start != null && end != null && end > start ? end - start : null;
  if (plan.availableMinutes == null || focusMinutes == null) {
    return { state: 'unknown', focusMinutes, allocatedMinutes: null, remainingMinutes: null, reasons: ['可用时间或保护时段尚未完整设置'] };
  }
  const fixedMinutes = fixedCommitmentMinutes == null ? plan.fixedCommitmentMinutes : Math.max(0, Number(fixedCommitmentMinutes) || 0);
  const allocatedMinutes = fixedMinutes + plan.bufferMinutes + focusMinutes;
  const remainingMinutes = plan.availableMinutes - allocatedMinutes;
  const reasons = [];
  let state = 'protected';
  if (remainingMinutes < 0) { state = 'overloaded'; reasons.push(`超出真实容量 ${Math.abs(remainingMinutes)} 分钟`); }
  if (conflicts.length) { state = 'overloaded'; reasons.push(`保护时段与 ${conflicts.length} 项固定事实冲突`); }
  if (state !== 'overloaded' && plan.interruptions != null && plan.interruptions >= 3) { state = 'warning'; reasons.push(`${plan.interruptions} 次重要打断`); }
  if (state !== 'overloaded' && plan.actualFocusSource && plan.actualFocusMinutes != null && plan.actualFocusMinutes < focusMinutes * 0.7) { state = 'warning'; reasons.push('有来源的实际专注低于计划的70%'); }
  if (!reasons.length) reasons.push('主动作已有完整保护时段');
  return { state, focusMinutes, allocatedMinutes, remainingMinutes, fixedCommitmentMinutes: fixedMinutes, reasons };
}

export function buildUnifiedTimeDay({ plan = {}, calendar = {}, tasks = [], date = plan.date } = {}) {
  const normalizedPlan = normalizeTimePlan({ ...plan, date });
  const snapshot = normalizeCalendarSnapshot(calendar);
  const [dayStart, dayEnd] = dayBounds(date);
  const commitments = snapshot.events.filter((event) => event.busy && rangesOverlap([
    new Date(event.startAt).getTime(), new Date(event.endAt).getTime(),
  ], [dayStart, dayEnd])).map((event) => ({
    kind: 'calendar_fact',
    id: event.eventId,
    title: event.title,
    startAt: event.startAt,
    endAt: event.endAt,
    allDay: event.allDay,
    readOnly: true,
  }));
  const busyRanges = commitments.map((event) => [
    Math.max(dayStart, new Date(event.startAt).getTime()),
    Math.min(dayEnd, new Date(event.endAt).getTime()),
  ]);
  const focusStartMinute = clockMinutes(normalizedPlan.focusStart);
  const focusEndMinute = clockMinutes(normalizedPlan.focusEnd);
  const focusRange = focusStartMinute != null && focusEndMinute != null && focusEndMinute > focusStartMinute
    ? [dayStart + focusStartMinute * MINUTE_MS, dayStart + focusEndMinute * MINUTE_MS]
    : null;
  const conflicts = focusRange ? commitments.filter((_, index) => rangesOverlap(focusRange, busyRanges[index])) : [];
  const conflictSources = conflicts.map((event) => ({
    sourceType: 'calendar',
    sourceName: snapshot.sourceName || '日历快照',
    sourceId: event.id,
    title: event.title,
    startAt: event.startAt,
    endAt: event.endAt,
    reason: '外部日历 busy 事实与人工计划保护时段重叠',
    readOnly: true,
  }));
  const taskReferences = (Array.isArray(tasks) ? tasks : [])
    .filter((task) => !task.deleted && !task.isCompleted && !task.isRecurringTemplate && localDateKey(task.scheduledAt) === date)
    .map((task) => ({
      kind: 'task_reference',
      taskId: task.id,
      boxId: task.boxId || null,
      title: clean(task.content) || 'TaskBox 任务',
      scheduledAt: task.scheduledAt,
      durationMinutes: Math.max(0, Number(task.durationMinutes) || 0) || null,
      commitment: false,
    }));
  const calendarBusyMinutes = unionMinutes(busyRanges);
  const effectiveFixedMinutes = snapshot.status === 'connected' ? calendarBusyMinutes : normalizedPlan.fixedCommitmentMinutes;
  const state = deriveTimePlanState(normalizedPlan, { fixedCommitmentMinutes: effectiveFixedMinutes, conflicts });
  return {
    date,
    plan: normalizedPlan,
    calendarStatus: snapshot.status,
    calendarReadAt: snapshot.readAt,
    calendarSourceName: snapshot.sourceName,
    commitments,
    taskReferences,
    calendarBusyMinutes,
    manualFixedMinutes: normalizedPlan.fixedCommitmentMinutes,
    effectiveFixedMinutes,
    conflicts,
    conflictSources,
    actualFocus: normalizedPlan.actualFocusSource && normalizedPlan.actualFocusMinutes != null
      ? { status: 'recorded', minutes: normalizedPlan.actualFocusMinutes, source: normalizedPlan.actualFocusSource }
      : { status: 'unrecorded', minutes: null, source: null },
    state,
  };
}

export function deriveHealthCapacity(plan = {}, healthSnapshot = {}) {
  const normalizedPlan = normalizeTimePlan(plan);
  const summary = healthSnapshot?.summary && typeof healthSnapshot.summary === 'object' ? healthSnapshot.summary : {};
  const status = clean(healthSnapshot?.status) || 'unknown';
  const generatedAt = timestamp(healthSnapshot?.generatedAt)?.toISOString() || null;
  const constraints = Array.isArray(summary.constraints) ? summary.constraints.map(clean).filter(Boolean) : [];
  const rawFactor = Number(summary.availableCapacity);
  const usable = ['healthy', 'attention', 'alert'].includes(status) && generatedAt && Number.isFinite(rawFactor);
  const factor = usable ? Math.min(1, Math.max(0, rawFactor)) : null;
  const suggestedMinutes = normalizedPlan.availableMinutes == null || factor == null
    ? null
    : Math.floor(normalizedPlan.availableMinutes * factor);
  let explanation = '容量依据不足：健康快照缺失、过期或状态未知；仅保留人工计划。';
  if (usable && normalizedPlan.availableMinutes == null) explanation = `健康约束系数 ${Math.round(factor * 100)}% 已读取，但人工计划尚未填写基础可用分钟。`;
  else if (suggestedMinutes != null) explanation = `基础计划 ${normalizedPlan.availableMinutes} 分钟 × 健康约束 ${Math.round(factor * 100)}% = 建议容量 ${suggestedMinutes} 分钟；是否采用仍由用户确认。`;
  return {
    status,
    generatedAt,
    constraints,
    usable,
    factor,
    baseMinutes: normalizedPlan.availableMinutes,
    suggestedMinutes,
    explanation,
    readOnly: true,
  };
}

export function buildTimeAttentionSnapshot({ store = {}, tasks = [], healthSnapshot = {}, date, now = new Date() } = {}) {
  const normalized = normalizeTimeStore(store);
  const key = date || new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(now);
  const plan = normalized.plans.find((item) => item.date === key) || normalizeTimePlan({ date: key });
  const day = buildUnifiedTimeDay({ plan, calendar: normalized.calendar, tasks, date: key });
  const healthCapacity = deriveHealthCapacity(plan, healthSnapshot);
  const planningCapacityMinutes = healthCapacity.suggestedMinutes;
  const generatedAt = normalized.factsUpdatedAt || day.calendarReadAt || null;
  const status = !generatedAt || day.state.state === 'unknown'
    ? 'unknown'
    : day.state.state === 'overloaded' || day.conflicts.length ? 'alert'
      : day.state.state === 'warning' || plan.biggestLeak ? 'attention' : 'healthy';
  const summary = {
    availableMinutes: plan.availableMinutes,
    remainingMinutes: day.state.remainingMinutes,
    protectedWindow: day.state.focusMinutes == null ? null : { start: plan.focusStart, end: plan.focusEnd, minutes: day.state.focusMinutes, taskId: plan.focusTaskId },
    overloadState: day.state.state === 'overloaded' ? 'overloaded' : day.state.state === 'unknown' ? 'unknown' : day.state.state === 'warning' ? 'warning' : 'normal',
    highestLeak: plan.biggestLeak || null,
    conflictCount: day.conflicts.length,
    calendarStatus: day.calendarStatus,
    planningCapacityMinutes,
    healthConstraintStatus: healthSnapshot.status || 'unknown',
    generatedAt,
  };
  return {
    snapshotId: `time-hq:${key}:${generatedAt || 'unpublished'}`,
    systemId: 'time', schemaVersion: 1, generatedAt, effectiveDate: key,
    sourceRefs: [...day.commitments.map((item) => `calendar:${item.id}`), ...day.taskReferences.map((item) => `task:${item.taskId}`)],
    confidence: generatedAt ? 0.8 : 0, status, summary,
    constraints: [...healthCapacity.constraints],
    date: key,
    state: day.state.state,
    ...summary,
    healthConstraints: [...healthCapacity.constraints],
    healthCapacity,
    actualFocusStatus: day.actualFocus.status,
    conflictSources: day.conflictSources,
  };
}

export function summarizeTimeWeek(plans = []) {
  const recent = [...plans].filter((item) => item?.date).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 7).map(normalizeTimePlan);
  const pairs = recent.map((item) => ({ plan: deriveTimePlanState(item).focusMinutes, actual: item.actualFocusMinutes, source: item.actualFocusSource })).filter((item) => item.plan != null && item.actual != null && item.source);
  const planned = pairs.reduce((sum, item) => sum + item.plan, 0);
  const actual = pairs.reduce((sum, item) => sum + item.actual, 0);
  const interruptions = recent.map((item) => item.interruptions).filter((item) => item != null);
  return {
    sampleDays: pairs.length,
    plannedFocusMinutes: planned,
    actualFocusMinutes: actual,
    adherence: planned ? Math.round(actual / planned * 100) : null,
    averageInterruptions: interruptions.length ? Math.round(interruptions.reduce((a, b) => a + b, 0) / interruptions.length * 10) / 10 : null,
  };
}

export function normalizeTimeStore(value = {}) {
  const legacyFactsUpdatedAt = Number(value.schemaVersion) < 3 ? value.updatedAt : null;
  return {
    schemaVersion: TIME_ATTENTION_SCHEMA_VERSION,
    plans: (Array.isArray(value.plans) ? value.plans : []).map(normalizeTimePlan).filter((item) => item.date).sort((a, b) => a.date.localeCompare(b.date)),
    calendar: normalizeCalendarSnapshot(value.calendar),
    candidates: (Array.isArray(value.candidates) ? value.candidates : []).map(normalizeTimeCandidate).filter((item) => item.candidateId && item.content && item.sourceRef),
    factsUpdatedAt: timestamp(value.factsUpdatedAt || legacyFactsUpdatedAt)?.toISOString() || null,
    updatedAt: timestamp(value.updatedAt)?.toISOString() || null,
  };
}
