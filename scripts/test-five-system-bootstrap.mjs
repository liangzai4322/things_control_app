import assert from 'node:assert/strict';
import fs from 'node:fs';
import { applyFiveSystemBootstrap, validateFiveSystemBootstrapPackage } from '../js/five-system-bootstrap.js';

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
console.log('five-system historical bootstrap tests passed');
