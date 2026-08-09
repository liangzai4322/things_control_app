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

assert.equal(HQ_SYSTEM_REGISTRY.length, 6);
assert.equal(HQ_SYSTEM_ACCESS_LEVELS.L1.canWrite, false);
assert.equal(HQ_SYSTEM_ACCESS_LEVELS.L2.canWrite, true);
assert.deepEqual(summarizeHqSystemViews(views), { l0: 3, l1: 1, l2: 2, unknown: 0, actionable: 1 });

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
