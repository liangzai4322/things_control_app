import assert from 'node:assert/strict';
import {
  HQ_SYSTEM_ACCESS_LEVELS,
  HQ_SYSTEM_REGISTRY,
  buildHqSystemViews,
  summarizeHqSystemViews,
} from '../js/hq-systems.js';
import { buildHqActionCandidates } from '../js/hq-candidates.js';

const now = new Date('2026-08-09T04:00:00.000Z');
const projects = [
  { id: 'a', name: '项目 A', health: 'blocked', blocker: '等待关键输入' },
  { id: 'b', name: '项目 B', health: 'stale' },
  { id: 'c', name: '项目 C', health: 'healthy' },
];
const views = buildHqSystemViews({
  snapshot: { projects, generatedAt: '2026-08-09T03:58:00.000Z', review: { status: 'synced' } },
  syncState: { status: 'online', pendingCount: 0 },
  tasks: [], remote: true, now,
});

assert.equal(HQ_SYSTEM_REGISTRY.length, 10);
assert.equal(HQ_SYSTEM_ACCESS_LEVELS.L1.canWrite, false);
assert.equal(HQ_SYSTEM_ACCESS_LEVELS.L2.canWrite, true);
assert.deepEqual(summarizeHqSystemViews(views), { l0: 3, l1: 5, l2: 2, unknown: 4, actionable: 1 });
assert.equal(HQ_SYSTEM_REGISTRY.find((system) => system.systemId === 'time').accessLevel, 'L1');
assert.equal(HQ_SYSTEM_REGISTRY.find((system) => system.systemId === 'feedback').accessLevel, 'L1');
assert.equal(HQ_SYSTEM_REGISTRY.find((system) => system.systemId === 'mission').accessLevel, 'L1');
assert.equal(HQ_SYSTEM_REGISTRY.find((system) => system.systemId === 'health').accessLevel, 'L1');
assert.equal(HQ_SYSTEM_REGISTRY.find((system) => system.systemId === 'mission').writeMethod, '');
assert.equal(HQ_SYSTEM_REGISTRY.find((system) => system.systemId === 'health').writeMethod, '');
assert.equal(HQ_SYSTEM_REGISTRY.find((system) => system.systemId === 'execution').accessLevel, 'L2');

const mainline = views.find((system) => system.systemId === 'mainline');
assert.equal(mainline.accessLevel, 'L1');
assert.equal(mainline.health, 'alert');
assert.equal(mainline.candidateSignalCount, 1, 'stale projects must not cross the action threshold');
assert.match(mainline.highestSignal, /项目 A/);
assert.equal(mainline.canWrite, false);
const candidates = buildHqActionCandidates({ projects, tasks: [], mainlines: [], brief: {}, reviewDate: '2026-08-09', now });
assert.equal(candidates.filter((candidate) => candidate.sourceSystemId === 'mainline').length, mainline.candidateSignalCount);

const localOnly = buildHqSystemViews({ snapshot: { projects }, remote: false, now });
assert.equal(localOnly.find((system) => system.systemId === 'mainline').health, 'unknown');

const stale = buildHqSystemViews({
  snapshot: { projects: [], generatedAt: '2026-08-09T03:40:00.000Z' }, remote: true, now,
});
assert.equal(stale.find((system) => system.systemId === 'mainline').health, 'stale');

const integratedReadOnly = buildHqSystemViews({
  snapshot: {}, now,
  missionSnapshot: {
    generatedAt: '2026-08-09T03:58:00.000Z', status: 'healthy',
    summary: { activeVersionId: 'mission-001:v1', campaignTitle: '当前战役', successConditionCount: 1, stopDoingCount: 1, reviewAt: '2026-08-31' },
  },
  healthSnapshot: {
    generatedAt: '2026-08-09T03:58:00.000Z', status: 'attention',
    summary: { healthSnapshotId: 'health-1', availableCapacity: 0.6, constraints: ['降低计划负载'], sourceTypeCount: 2 },
  },
  timeSnapshot: {
    generatedAt: '2026-08-09T03:58:00.000Z', availableMinutes: 480,
    protectedWindow: { start: '09:00', end: '10:30' }, overloadState: 'normal', calendarStatus: 'connected',
  },
  feedback: {
    lastSyncAt: '2026-08-09T03:58:00.000Z', deviationCount: 2, pendingRuleCount: 1,
    rule: { statement: '先验证再写回', status: 'proposed' },
  },
  executionSnapshot: {
    generatedAt: '2026-08-09T03:58:00.000Z', status: 'healthy',
    summary: { currentActionTitle: '推进当前行动', wipCount: 1, wipLimit: 3, outcomeCount: 2, pendingSync: 0 },
  },
});
const time = integratedReadOnly.find((system) => system.systemId === 'time');
const feedback = integratedReadOnly.find((system) => system.systemId === 'feedback');
const mission = integratedReadOnly.find((system) => system.systemId === 'mission');
const health = integratedReadOnly.find((system) => system.systemId === 'health');
const execution = integratedReadOnly.find((system) => system.systemId === 'execution');
assert.equal(mission.health, 'healthy');
assert.equal(mission.canWrite, false);
assert.equal(health.health, 'attention');
assert.equal(health.canWrite, false);
assert.equal(time.health, 'healthy');
assert.equal(time.canReadFacts, true);
assert.equal(time.canWrite, false);
assert.equal(feedback.health, 'attention');
assert.equal(feedback.canReadFacts, true);
assert.equal(feedback.canWrite, false);
assert.equal(execution.health, 'healthy');
assert.equal(execution.canWrite, true);
assert.match(execution.highestSignal, /推进当前行动/);

const loop = buildHqSystemViews({
  snapshot: {
    projects: [{ id: 'a', name: '项目 A', health: 'healthy' }],
    generatedAt: '2026-08-09T03:58:00.000Z', review: { status: 'synced' },
  },
  tasks: [{ id: 'task-a', candidateSourceSystemId: 'mainline', isCompleted: true }],
  syncState: { status: 'online' }, remote: true, now,
}).find((system) => system.systemId === 'mainline');
assert.deepEqual(loop.loopEvidence, {
  discovered: true, judged: true, executed: true, evidenced: true, reviewed: true,
});

console.log('hq system registry tests passed');
