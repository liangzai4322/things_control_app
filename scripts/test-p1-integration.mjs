import assert from 'node:assert/strict';
import fs from 'node:fs';
import { HQ_SYSTEM_REGISTRY, buildHqSystemViews } from '../js/hq-systems.js';
import { normalizeMissionStore, publishMissionVersion } from '../js/mission-model.js';
import { normalizeHealthStore, deriveHealthAssessment } from '../js/health-model.js';
import { parseIcsCalendar, buildUnifiedTimeDay } from '../js/time-attention-model.js';
import { deriveExecutionState } from '../js/execution-model.js';
import { importFeedbackContinuity } from '../js/feedback-model.js';

const appSource = fs.readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
for (const route of ['mission', 'health', 'time', 'execution', 'feedback']) {
  assert.match(appSource, new RegExp(`path === '${route}'`), `${route} route must coexist in the integrated router`);
}

const registry = Object.fromEntries(HQ_SYSTEM_REGISTRY.map((item) => [item.systemId, item]));
assert.equal(registry.time.accessLevel, 'L1');
assert.equal(registry.feedback.accessLevel, 'L1');
assert.equal(registry.time.writeMethod, '');
assert.equal(registry.feedback.writeMethod, '');
assert.equal(registry.mission.accessLevel, 'L1');
assert.equal(registry.health.accessLevel, 'L1');
assert.equal(registry.mission.writeMethod, '');
assert.equal(registry.health.writeMethod, '');

const hqPage = fs.readFileSync(new URL('../js/hq-page.js', import.meta.url), 'utf8');
const confirmation = hqPage.slice(
  hqPage.indexOf("app.querySelectorAll('[data-confirm-candidate]')"),
  hqPage.indexOf("app.querySelectorAll('[data-skip-candidate]')"),
);
assert.match(confirmation, /\/hq\/proposals/);
assert.match(confirmation, /\/promote/);
assert.doesNotMatch(confirmation, /addTask\s*\(/);
assert.doesNotMatch(confirmation, /updateTask\s*\(/);

const draftMission = normalizeMissionStore({ draft: {
  statement: '长期方向', campaign: { title: '当前战役', whyNow: '现在', successConditions: ['完成'], exitConditions: ['退出'], reviewAt: '2026-08-31' },
} });
const deniedMission = publishMissionVersion(draftMission, [], { sourceAuthority: 'ai_derived' });
assert.equal(deniedMission.version, null, 'AI-derived mission drafts must not publish');
assert.equal(deniedMission.store.activeVersion, null);

const health = deriveHealthAssessment([
  { date: '2026-08-10', source: 'manual', sleepHours: 8, energy: 4 },
  { date: '2026-08-10', source: 'wearable', sleepHours: 5.5, energy: 4 },
], '2026-08-10');
assert.equal(health.state, 'unknown', 'conflicting health sources must degrade conservatively');

const calendar = parseIcsCalendar(`BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:busy\nDTSTART:20260810T090000\nDTEND:20260810T100000\nSUMMARY:Busy\nEND:VEVENT\nBEGIN:VEVENT\nUID:free\nDTSTART:20260810T100000\nDTEND:20260810T110000\nTRANSP:TRANSPARENT\nSUMMARY:Free\nEND:VEVENT\nBEGIN:VEVENT\nUID:gone\nDTSTART:20260810T110000\nDTEND:20260810T120000\nSTATUS:CANCELLED\nSUMMARY:Gone\nEND:VEVENT\nEND:VCALENDAR`);
const unified = buildUnifiedTimeDay({
  date: '2026-08-10', calendar,
  plan: { date: '2026-08-10', availableMinutes: 480, focusStart: '09:30', focusEnd: '10:30' },
  tasks: [{ id: 'task-ref', content: 'TaskBox reference', scheduledAt: '2026-08-10T13:00:00+08:00' }],
});
assert.equal(unified.commitments.length, 1);
assert.equal(unified.conflicts.length, 1);
assert.equal(unified.taskReferences.length, 1);

const completedTask = {
  id: 'done-1', content: '交付联合验收', boxId: 'box-1', isCompleted: true,
  completedAt: '2026-08-10T08:00:00+08:00',
  completionReceipt: { content: '交付联合验收', completedAt: '2026-08-10T08:00:00+08:00', evidenceRefs: ['artifact:build'] },
};
const execution = deriveExecutionState({ tasks: [completedTask], boxes: [{ id: 'box-1', name: '重要盒' }], reviewDate: '2026-08-10' });
assert.equal(execution.outcomes.some((item) => item.id === completedTask.id), true, 'TaskBox completion must surface as an execution outcome');
assert.equal(execution.outcomes[0].hasEvidence, true);

const feedbackImport = importFeedbackContinuity({}, {
  cycleType: 'day', cycleKey: '2026-08-10', continuityId: 'feedback:day:2026-08-10',
  deviations: [{ deviationId: 'dev-done-1', facts: ['按完成回执结算'], evidenceRefs: [{ type: 'task_completion', sourceId: completedTask.id, label: completedTask.content }] }],
  rules: [{ ruleId: 'rule-1', version: 1, statement: '未经批准不得写回', status: 'active' }],
  experiments: [{ experimentId: 'exp-1', hypothesis: '先验证再扩展', status: 'active' }],
}, { now: new Date('2026-08-10T09:00:00.000Z') });
assert.equal(feedbackImport.store.deviations[0].evidenceRefs[0].sourceId, completedTask.id);
assert.equal(feedbackImport.store.rules[0].status, 'proposed', 'imported rules must lose activation authority');
assert.equal(feedbackImport.store.experiments[0].status, 'proposed', 'imported experiments must lose activation authority');

const views = buildHqSystemViews({
  snapshot: {}, tasks: [completedTask], timeSnapshot: { generatedAt: '2026-08-10T08:00:00.000Z', availableMinutes: 480, overloadState: 'normal', calendarStatus: 'connected' },
  feedback: { lastSyncAt: '2026-08-10T09:00:00.000Z', deviationCount: 1, pendingRuleCount: 1 }, now: new Date('2026-08-10T09:05:00.000Z'),
});
assert.equal(views.find((item) => item.systemId === 'time').canWrite, false);
assert.equal(views.find((item) => item.systemId === 'feedback').canWrite, false);

const legacyMission = normalizeMissionStore({ draft: { statement: 'P0草稿' }, activeVersion: null });
assert.equal(legacyMission.draft.statement, 'P0草稿');
const legacyHealth = normalizeHealthStore({ schemaVersion: 1, observations: [{ date: '2026-08-09', sleepHours: 7, energy: 3 }], interventions: [] });
assert.equal(legacyHealth.observations[0].sleepHours, 7);
assert.equal(legacyHealth.observations[0].source, 'manual');

console.log('five-system P1 integration contract tests passed');
