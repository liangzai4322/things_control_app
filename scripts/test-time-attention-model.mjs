import assert from 'node:assert/strict';
import {
  buildTimeCandidateInbox,
  buildTimeAttentionSnapshot,
  buildUnifiedTimeDay,
  deriveHealthCapacity,
  deriveTimePlanState,
  importTimeCandidates,
  normalizeTimeStore,
  parseIcsCalendar,
  summarizeTimeWeek,
  updateTimeCandidate,
} from '../js/time-attention-model.js';
import { readTimeStore, writeTimeStore } from '../js/time-attention-store.js';

assert.equal(deriveTimePlanState({}).state, 'unknown');
assert.equal(deriveTimePlanState({ availableMinutes: 360, fixedCommitmentMinutes: 120, bufferMinutes: 30, focusStart: '09:00', focusEnd: '10:30' }).state, 'protected');
assert.equal(deriveTimePlanState({ availableMinutes: 180, fixedCommitmentMinutes: 120, bufferMinutes: 30, focusStart: '09:00', focusEnd: '10:30' }).state, 'overloaded');
assert.equal(deriveTimePlanState({ availableMinutes: 360, focusStart: '09:00', focusEnd: '10:30', actualFocusMinutes: 30 }).state, 'protected', 'an actual number without a reliable source must not create a deviation');
assert.equal(deriveTimePlanState({ availableMinutes: 360, focusStart: '09:00', focusEnd: '10:30', actualFocusMinutes: 30, actualFocusSource: 'explicit_user_manual' }).state, 'warning');

const calendar = parseIcsCalendar(`BEGIN:VCALENDAR
BEGIN:VEVENT
UID:meeting-1
DTSTART:20260809T011500Z
DTEND:20260809T020000Z
SUMMARY:固定会议
END:VEVENT
BEGIN:VEVENT
UID:free-1
DTSTART:20260809T030000Z
DTEND:20260809T040000Z
SUMMARY:仅提醒
TRANSP:TRANSPARENT
END:VEVENT
BEGIN:VEVENT
UID:cancelled-1
DTSTART:20260809T050000Z
DTEND:20260809T060000Z
SUMMARY:已取消
STATUS:CANCELLED
END:VEVENT
END:VCALENDAR`, { sourceName: 'facts.ics', readAt: '2026-08-09T00:00:00.000Z' });
assert.equal(calendar.status, 'connected');
assert.equal(calendar.events.length, 2, 'cancelled events must not enter the read-only snapshot');
assert.equal(calendar.events.find((event) => event.eventId === 'free-1').busy, false);

const plan = {
  date: '2026-08-09', availableMinutes: 180, fixedCommitmentMinutes: 90, bufferMinutes: 30,
  focusStart: '09:00', focusEnd: '10:00', focusTaskId: 'task-1', biggestLeak: '即时消息',
};
const tasks = [
  { id: 'task-1', boxId: 'box-1', content: '推进主战役', scheduledAt: '2026-08-09T01:00:00.000Z', durationMinutes: 60 },
  { id: 'done', content: '已完成任务', scheduledAt: '2026-08-09T01:00:00.000Z', isCompleted: true },
];
const day = buildUnifiedTimeDay({ plan, calendar, tasks, date: '2026-08-09' });
assert.equal(day.calendarBusyMinutes, 45);
assert.equal(day.effectiveFixedMinutes, 45, 'connected calendar facts must drive the derived allocation without overwriting manual minutes');
assert.equal(day.manualFixedMinutes, 90);
assert.equal(day.commitments.length, 1, 'transparent events must not consume capacity');
assert.equal(day.conflicts.length, 1);
assert.deepEqual(day.conflictSources.map((item) => [item.sourceType, item.sourceName, item.sourceId]), [['calendar', 'facts.ics', 'meeting-1']]);
assert.equal(day.state.state, 'overloaded');
assert.equal(day.taskReferences.length, 1);
assert.equal(day.taskReferences[0].commitment, false, 'TaskBox scheduling is a reference, not a user commitment');
assert.equal(day.taskReferences[0].boxId, 'box-1');
assert.equal(day.actualFocus.status, 'unrecorded', 'TaskBox schedule must not stand in for actual focus');

const localFallback = buildUnifiedTimeDay({ plan, calendar: {}, tasks, date: '2026-08-09' });
assert.equal(localFallback.calendarStatus, 'unavailable');
assert.equal(localFallback.effectiveFixedMinutes, 90, 'calendar failure must degrade to the manual plan');

const migrated = normalizeTimeStore({ schemaVersion: 1, plans: [plan] });
assert.equal(migrated.schemaVersion, 3);
assert.equal(migrated.plans.length, 1);
assert.equal(migrated.calendar.status, 'unavailable');

const memory = new Map();
const storage = { getItem: (key) => memory.get(key) || null, setItem: (key, value) => memory.set(key, value) };
writeTimeStore({ plans: [plan], calendar }, storage);
const roundTrip = readTimeStore(storage);
assert.equal(roundTrip.schemaVersion, 3);
assert.equal(roundTrip.calendar.sourceName, 'facts.ics');
assert.equal(roundTrip.plans[0].fixedCommitmentMinutes, 90, 'calendar facts must not overwrite the manual plan on persistence');

const snapshot = buildTimeAttentionSnapshot({
  store: { plans: [plan], calendar, updatedAt: '2026-08-09T03:59:00.000Z' },
  tasks,
  healthSnapshot: { status: 'attention', generatedAt: '2026-08-09T03:00:00.000Z', summary: { availableCapacity: 0.6, constraints: ['降低计划负载'] } },
  date: '2026-08-09',
});
assert.deepEqual(snapshot.protectedWindow, { start: '09:00', end: '10:00', minutes: 60, taskId: 'task-1' });
assert.equal(snapshot.overloadState, 'overloaded');
assert.equal(snapshot.conflictCount, 1);
assert.equal(snapshot.highestLeak, '即时消息');
assert.equal(snapshot.planningCapacityMinutes, 108);
assert.deepEqual(snapshot.healthConstraints, ['降低计划负载']);
assert.match(snapshot.healthCapacity.explanation, /180 分钟 × 健康约束 60% = 建议容量 108 分钟/);
assert.equal(snapshot.actualFocusStatus, 'unrecorded');
const unknownHealthCapacity = buildTimeAttentionSnapshot({ store: { plans: [plan] }, date: '2026-08-09', healthSnapshot: { status: 'unknown', generatedAt: '2026-08-09T03:00:00.000Z', summary: { availableCapacity: 1 } } });
assert.equal(unknownHealthCapacity.planningCapacityMinutes, null, 'unknown health must not be treated as full capacity');
const staleHealthCapacity = deriveHealthCapacity(plan, { status: 'stale', generatedAt: '2026-08-07T03:00:00.000Z', summary: { availableCapacity: 0.5, constraints: ['降低负载'] } });
assert.equal(staleHealthCapacity.suggestedMinutes, null, 'stale health must not change suggested capacity');
assert.match(staleHealthCapacity.explanation, /容量依据不足/);

assert.deepEqual(summarizeTimeWeek([
  { date: '2026-08-08', focusStart: '09:00', focusEnd: '10:00', actualFocusMinutes: 30, actualFocusSource: 'explicit_user_manual', interruptions: 2 },
  { date: '2026-08-09', focusStart: '09:00', focusEnd: '10:00', actualFocusMinutes: 60, actualFocusSource: 'explicit_user_manual', interruptions: 0 },
]), { sampleDays: 2, plannedFocusMinutes: 120, actualFocusMinutes: 90, adherence: 75, averageInterruptions: 1 });

assert.deepEqual(summarizeTimeWeek([
  { date: '2026-08-09', focusStart: '09:00', focusEnd: '10:00', actualFocusMinutes: 60 },
]), { sampleDays: 0, plannedFocusMinutes: 0, actualFocusMinutes: 0, adherence: null, averageInterruptions: null }, 'legacy actual values without a source must not become plan-actual evidence');

const v2Candidates = [
  {
    claimId: 'claim-unknown', candidateLineId: 'cl-unknown', recordType: 'claim', domain: 'time',
    authority: 'ai_summary', epistemicState: 'asserted', content: '某天专注约一小时',
    activity: { dateMapping: 'unknown', sequenceEligible: false },
    sourceRef: '/daily/2026-07-18.md#L110', reviewDate: '2026-07-18',
    status: 'confirmed_date', confirmedActivityDate: '2026-07-18',
  },
  {
    claimId: 'claim-range', candidateLineId: 'cl-range', recordType: 'observation', domain: 'time',
    authority: 'user_interpretation', epistemicState: 'uncertain', content: '两天之间出现打断',
    activity: { dateMapping: 'range', sequenceEligible: false },
    sourceRef: '/daily/2026-07-19.md#L20', reviewDate: '2026-07-19',
  },
  { claimId: 'claim-health', recordType: 'claim', domain: 'health', content: '不应导入', sourceRef: '/daily/x' },
];
const imported = importTimeCandidates({}, v2Candidates);
assert.equal(imported.accepted, 2);
assert.equal(imported.ignored, 1);
let inbox = buildTimeCandidateInbox(imported.store);
assert.equal(inbox.pendingCount, 2);
assert.equal(inbox.dailySequenceCandidates.length, 0, 'unknown/range candidates must never enter daily sequence calculations by import alone');
assert.equal(inbox.candidates[0].status, 'pending', 'an imported file cannot smuggle user-confirmed status into the inbox');
assert.equal(inbox.candidates.every((candidate) => candidate.validatedFact === false), true, 'V2 validated_fact remains zero');
const noDateConfirmation = updateTimeCandidate(imported.store, 'claim-unknown', { status: 'confirmed_date' }, new Date('2026-08-10T01:00:00Z'));
assert.equal(buildTimeCandidateInbox(noDateConfirmation).dailySequenceCandidates.length, 0);
const confirmed = updateTimeCandidate(imported.store, 'claim-unknown', { status: 'confirmed_date', confirmedActivityDate: '2026-07-17' }, new Date('2026-08-10T01:00:00Z'));
inbox = buildTimeCandidateInbox(confirmed);
assert.equal(inbox.dailySequenceCandidates.length, 1);
assert.equal(inbox.dailySequenceCandidates[0].validatedFact, false, 'user-confirmed date creates a time fact candidate, not a validated fact');
assert.equal(normalizeTimeStore(confirmed).plans.length, 0, 'candidate confirmation must not mutate manual plans');
const candidateOnlyMemory = new Map();
const candidateOnlyStorage = { getItem: (key) => candidateOnlyMemory.get(key) || null, setItem: (key, value) => candidateOnlyMemory.set(key, value) };
const candidateOnlyStore = writeTimeStore(imported.store, candidateOnlyStorage, { touchFacts: false });
assert.equal(candidateOnlyStore.factsUpdatedAt, null, 'candidate inbox writes must not refresh the time fact snapshot');
assert.equal(buildTimeAttentionSnapshot({ store: candidateOnlyStore, date: '2026-08-09' }).generatedAt, null);

console.log('time attention V3 model tests passed');
