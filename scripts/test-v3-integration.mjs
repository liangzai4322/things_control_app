import assert from 'node:assert/strict';
import fs from 'node:fs';
import { HQ_SYSTEM_REGISTRY, buildHqSystemViews } from '../js/hq-systems.js';
import { buildMissionHqSnapshot, normalizeMissionStore, publishMissionVersion } from '../js/mission-model.js';
import { buildHealthHqSnapshot, buildHealthProtocolSnapshot, normalizeHealthStore } from '../js/health-model.js';
import { buildTimeAttentionSnapshot, parseIcsCalendar } from '../js/time-attention-model.js';
import { buildFeedbackHqSummary, importFeedbackContinuity } from '../js/feedback-model.js';

const appSource = fs.readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
const hqSource = fs.readFileSync(new URL('../js/hq-page.js', import.meta.url), 'utf8');
const executionSource = fs.readFileSync(new URL('../js/execution-model.js', import.meta.url), 'utf8');
const executionPageSource = fs.readFileSync(new URL('../js/execution-page.js', import.meta.url), 'utf8');
for (const route of ['mission', 'health', 'time', 'execution', 'feedback']) {
  assert.match(appSource, new RegExp(`path === '${route}'`));
}
for (const [systemId, route] of [['mission', '#mission'], ['health', '#health'], ['time', '#time'], ['execution', '#execution'], ['feedback', '#feedback']]) {
  assert.match(hqSource, new RegExp(`systemId: '${systemId}'`));
  assert.match(hqSource, new RegExp(route.replace('#', '\\#')));
}
assert.match(hqSource, /data-fixed-system-entry/);

const registry = Object.fromEntries(HQ_SYSTEM_REGISTRY.map((item) => [item.systemId, item]));
for (const systemId of ['mission', 'health', 'time', 'feedback']) {
  assert.equal(registry[systemId].accessLevel, 'L1');
  assert.equal(registry[systemId].writeMethod, '');
}
assert.equal(registry.execution.accessLevel, 'L2');
assert.match(hqSource, /readFiveSystemHqPorts/);
assert.doesNotMatch(hqSource, /from '.\/(?:mission|health|time-attention|feedback)-(?:model|store)\.js'/, 'HQ must consume system ports instead of internal stores/models');
assert.match(executionPageSource, /getTasks/);
assert.doesNotMatch(executionSource, /addTask\s*\(/);
assert.doesNotMatch(executionPageSource, /addTask\s*\(/);

const missionDraft = {
  statement: '已批准使命',
  campaign: { title: '已批准战役', whyNow: '现在', reviewAt: '2026-09-01', successConditions: ['完成'], exitConditions: ['停止'] },
};
const publishedMission = publishMissionVersion({ draft: missionDraft }, [], { now: new Date('2026-08-10T00:00:00Z'), sourceAuthority: 'explicit_user' });
const missionWithDraft = { ...publishedMission.store, draft: { ...missionDraft, statement: '未发布草稿', campaign: { ...missionDraft.campaign, title: '草稿战役' } } };
const missionSnapshot = buildMissionHqSnapshot(missionWithDraft, { now: new Date('2026-08-10T01:00:00Z') });
assert.equal(missionSnapshot.summary.statement, '已批准使命');
assert.equal(missionSnapshot.summary.campaignTitle, '已批准战役');
assert.equal(missionSnapshot.summary.hasPendingDraft, true);
assert.equal(JSON.stringify(missionSnapshot).includes('未发布草稿'), false);
assert.equal(buildMissionHqSnapshot({ candidateLine: [{ text: 'V2候选' }] }).status, 'unknown');

const privateHealth = normalizeHealthStore({ observations: [{
  date: '2026-08-10', source: 'manual', sleepHours: 6, energy: 2,
  symptoms: '隐私症状原文', notes: '医疗记录原文',
}] });
const protocol = buildHealthProtocolSnapshot(privateHealth, '2026-08-10', '2026-08-10T01:00:00Z');
const healthSnapshot = buildHealthHqSnapshot({ latest: protocol }, { now: new Date('2026-08-10T02:00:00Z') });
assert.equal(healthSnapshot.status, 'attention');
assert.equal(JSON.stringify(healthSnapshot).includes('隐私症状原文'), false);
assert.equal(JSON.stringify(healthSnapshot).includes('医疗记录原文'), false);
assert.equal(buildHealthHqSnapshot({ candidateLine: [{ text: 'V2健康候选' }] }).status, 'unknown');

const conflictingProtocol = buildHealthProtocolSnapshot(normalizeHealthStore({ observations: [
  { date: '2026-08-10', source: 'manual', sleepHours: 8, energy: 4 },
  { date: '2026-08-10', source: 'wearable', sleepHours: 5, energy: 2 },
] }), '2026-08-10', '2026-08-10T01:00:00Z');
assert.equal(buildHealthHqSnapshot({ latest: conflictingProtocol }, { now: new Date('2026-08-10T02:00:00Z') }).status, 'unknown');
assert.equal(buildHealthHqSnapshot({ latest: protocol }, { now: new Date('2026-08-12T00:00:00Z') }).status, 'stale');

const timeSnapshot = buildTimeAttentionSnapshot({
  store: { plans: [{ date: '2026-08-10', availableMinutes: 300 }] },
  healthSnapshot,
  date: '2026-08-10',
});
assert.equal(timeSnapshot.planningCapacityMinutes, 180);
assert.equal(timeSnapshot.healthConstraints.length > 0, true);
assert.equal(timeSnapshot.systemId, 'time');
assert.equal(timeSnapshot.schemaVersion, 1);
assert.equal(timeSnapshot.effectiveDate, '2026-08-10');
assert.equal(timeSnapshot.summary.planningCapacityMinutes, 180);

const calendar = parseIcsCalendar(`BEGIN:VCALENDAR
BEGIN:VEVENT
UID:busy
DTSTART:20260810T090000
DTEND:20260810T100000
END:VEVENT
BEGIN:VEVENT
UID:free
DTSTART:20260810T100000
DTEND:20260810T110000
TRANSP:TRANSPARENT
END:VEVENT
BEGIN:VEVENT
UID:cancelled
DTSTART:20260810T110000
DTEND:20260810T120000
STATUS:CANCELLED
END:VEVENT
END:VCALENDAR`);
assert.equal(calendar.events.length, 2);
assert.equal(calendar.events.find((event) => event.eventId === 'free').busy, false);

const feedback = importFeedbackContinuity({}, {
  cycleType: 'day', cycleKey: '2026-08-10',
  rules: [{ ruleId: 'r1', statement: '候选规则', status: 'active' }],
  experiments: [{ experimentId: 'e1', hypothesis: '候选实验', status: 'active' }],
});
assert.equal(feedback.store.rules[0].status, 'proposed');
assert.equal(feedback.store.experiments[0].status, 'proposed');
const feedbackSnapshot = buildFeedbackHqSummary(feedback.store);
assert.equal(feedbackSnapshot.systemId, 'feedback');
assert.equal(feedbackSnapshot.schemaVersion, 1);
assert.equal(feedbackSnapshot.status, 'attention');
assert.equal(feedbackSnapshot.summary.pendingRuleCount, 1);

const views = buildHqSystemViews({ missionSnapshot, healthSnapshot, timeSnapshot, feedback: {}, now: new Date('2026-08-10T02:00:00Z') });
for (const systemId of ['mission', 'health', 'time', 'feedback']) {
  assert.equal(views.find((item) => item.systemId === systemId).canWrite, false);
}
const confirmation = hqSource.slice(hqSource.indexOf("app.querySelectorAll('[data-confirm-candidate]')"), hqSource.indexOf("app.querySelectorAll('[data-skip-candidate]')"));
assert.match(confirmation, /\/hq\/proposals/);
assert.match(confirmation, /\/promote/);
assert.doesNotMatch(confirmation, /addTask\s*\(/);
assert.doesNotMatch(confirmation, /updateTask\s*\(/);

const legacyMission = normalizeMissionStore({ schemaVersion: 1, draft: { statement: 'P0草稿' } });
const legacyHealth = normalizeHealthStore({ schemaVersion: 1, observations: [{ date: '2026-08-09', sleepHours: 7, energy: 3 }] });
assert.equal(legacyMission.draft.statement, 'P0草稿');
assert.equal(legacyHealth.observations[0].source, 'manual');

console.log('V3 Gate 0-3 integration contract tests passed');
