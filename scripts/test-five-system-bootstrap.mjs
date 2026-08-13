import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  applyFiveSystemBootstrap,
  publishFiveSystemBaseline,
  readFiveSystemBaselineHistory,
  rollbackFiveSystemBaseline,
  validateFiveSystemBootstrapPackage,
} from '../js/five-system-bootstrap.js';

const packagePath = process.env.FIVE_SYSTEM_BOOTSTRAP_PACKAGE || '/Users/ylw/Documents/知识库/01-plan/2026/系统/014人生参谋部五系统/历史日省回填/首轮30日-V2/五系统初始化包-v1.json';
const payload = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
assert.equal(validateFiveSystemBootstrapPackage(payload).valid, true);
class MemoryStorage {
  constructor(seed = {}) { this.values = new Map(Object.entries(seed)); }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}
const storage = new MemoryStorage();
const first = applyFiveSystemBootstrap(payload, storage, { now: new Date('2026-08-12T04:00:00Z') });
assert.equal(first.ok, true);
assert.deepEqual(first.state.counts, { mission: 39, health: 84, time: 135, execution: 375, feedbackClaims: 790, feedbackPatterns: 42, feedbackProposals: 5, validatedFacts: 0 });
const missionKey = 'taskbox_mission_os_v1';
const mission = JSON.parse(storage.getItem(missionKey));
mission.candidateInbox[0].decision = { status: 'observing', decidedAt: '2026-08-12T04:05:00Z', decidedBy: 'explicit_user', publishedVersionId: null };
storage.setItem(missionKey, JSON.stringify(mission));
const second = applyFiveSystemBootstrap(payload, storage, { now: new Date('2026-08-12T04:10:00Z') });
assert.equal(second.ok, true);
assert.deepEqual(second.state.counts, first.state.counts);
assert.equal(JSON.parse(storage.getItem(missionKey)).candidateInbox[0].decision.status, 'observing');
assert.equal(JSON.parse(storage.getItem('taskbox_health_energy_os_v1')).observations.length, 0);
assert.equal(JSON.parse(storage.getItem('taskbox_time_attention_os_v1')).candidates.every((item) => item.validatedFact === false), true);
assert.equal(JSON.parse(storage.getItem('taskbox_execution_v2_candidates_v1')).every((item) => item.taskStatus === 'not_a_task'), true);
assert.equal(JSON.parse(storage.getItem('taskbox_feedback_evolution_os_v1')).v2Candidates.patternCandidates.every((item) => item.status === 'candidate_unvalidated'), true);
const beforeInvalid = storage.getItem(missionKey);
const invalid = applyFiveSystemBootstrap({ ...payload, validatedFacts: [{ id: 'forbidden' }] }, storage);
assert.equal(invalid.ok, false);
assert.equal(storage.getItem(missionKey), beforeInvalid);

const deniedStorage = new MemoryStorage();
const denied = publishFiveSystemBaseline(payload, deniedStorage, { now: new Date('2026-08-13T05:00:00Z') });
assert.equal(denied.ok, false);
assert.equal(deniedStorage.getItem(missionKey), null);

const baselineStorage = new MemoryStorage();
const baseline = publishFiveSystemBaseline(payload, baselineStorage, {
  now: new Date('2026-08-13T05:00:00Z'),
  authorization: { sourceAuthority: 'explicit_user' },
});
assert.equal(baseline.ok, true);
assert.equal(baseline.state.mode, 'published_baseline');
assert.equal(baseline.state.activeBaselineVersion, 'five-system-baseline-v1');
assert.deepEqual(baseline.state.promotedCounts, {
  mission: 39,
  healthObservations: 12,
  healthContext: 72,
  timeFacts: 22,
  timeContext: 113,
  executionHistory: 375,
  feedbackObservedPatterns: 42,
  feedbackProposals: 5,
  taskboxTasksCreated: 0,
});
const baselineMission = JSON.parse(baselineStorage.getItem(missionKey));
assert.equal(baselineMission.candidateInbox.every((item) => item.decision.status === 'included_in_draft'), true);
assert.equal(baselineMission.candidateInbox.every((item) => item.decision.decidedBy === 'explicit_user'), true);
const baselineHealth = JSON.parse(baselineStorage.getItem('taskbox_health_energy_os_v1'));
assert.equal(baselineHealth.observations.length, 12);
assert.equal(baselineHealth.candidates.filter((item) => item.status === 'confirmed').length, 12);
assert.equal(baselineHealth.candidates.filter((item) => item.status === 'context_only').length, 72);
const baselineTime = JSON.parse(baselineStorage.getItem('taskbox_time_attention_os_v1'));
assert.equal(baselineTime.candidates.filter((item) => item.validatedFact).length, 22);
assert.equal(baselineTime.candidates.filter((item) => item.status === 'baseline_context').length, 113);
assert.equal(baselineTime.candidates.every((item) => item.baselineVersionId === 'five-system-baseline-v1'), true);
const baselineExecution = JSON.parse(baselineStorage.getItem('taskbox_execution_v2_candidates_v1'));
assert.equal(baselineExecution.every((item) => item.factStatus === 'historical_baseline'), true);
assert.equal(baselineExecution.every((item) => item.taskStatus === 'not_a_current_task'), true);
const baselineFeedback = JSON.parse(baselineStorage.getItem('taskbox_feedback_evolution_os_v1'));
assert.equal(baselineFeedback.v2Candidates.patternCandidates.every((item) => item.status === 'observed'), true);
assert.equal(baselineFeedback.v2Candidates.calibrationProposals.every((item) => item.status === 'proposed'), true);
assert.equal(readFiveSystemBaselineHistory(baselineStorage).length, 1);

const baselineAgain = publishFiveSystemBaseline(payload, baselineStorage, {
  now: new Date('2026-08-13T05:10:00Z'),
  authorization: { sourceAuthority: 'explicit_user' },
});
assert.equal(baselineAgain.ok, true);
assert.equal(baselineAgain.state.activeBaselineVersion, 'five-system-baseline-v2');
assert.equal(JSON.parse(baselineStorage.getItem('taskbox_health_energy_os_v1')).observations.length, 12);
assert.equal(readFiveSystemBaselineHistory(baselineStorage).length, 2);
const rolledBack = rollbackFiveSystemBaseline(baselineStorage, {
  authorization: { sourceAuthority: 'explicit_user' },
  now: new Date('2026-08-13T05:20:00Z'),
});
assert.equal(rolledBack.ok, true);
assert.equal(rolledBack.rolledBackVersion, 'five-system-baseline-v2');
assert.equal(rolledBack.state.activeBaselineVersion, 'five-system-baseline-v1');
assert.equal(readFiveSystemBaselineHistory(baselineStorage).length, 1);
console.log('five-system historical bootstrap tests passed');
