import assert from 'node:assert/strict';
import {
  createStorageRefreshScheduler,
  isTaskboxRefreshStorageKey,
} from '../js/app-storage.js';

assert.equal(isTaskboxRefreshStorageKey('taskbox_hq_cache_v1'), true);
assert.equal(isTaskboxRefreshStorageKey('taskbox_api_sync_state_v1'), true);
assert.equal(isTaskboxRefreshStorageKey('taskbox_mission_os_v1'), true);
assert.equal(isTaskboxRefreshStorageKey('taskbox_health_energy_os_v1'), true);
assert.equal(isTaskboxRefreshStorageKey('taskbox_time_attention_os_v1'), true);
assert.equal(isTaskboxRefreshStorageKey('taskbox_api_mutation_outbox_v1:entry:abc'), true);
assert.equal(isTaskboxRefreshStorageKey('taskbox_api_mutation_dead_letters_v1:entry:def'), true);
assert.equal(isTaskboxRefreshStorageKey('unrelated'), false);

let timerId = 0;
const callbacks = new Map();
let invalidations = 0;
let refreshes = 0;
const schedule = createStorageRefreshScheduler({
  invalidate: () => { invalidations += 1; },
  refresh: () => { refreshes += 1; },
  setTimer: (callback) => {
    timerId += 1;
    callbacks.set(timerId, callback);
    return timerId;
  },
  clearTimer: (id) => callbacks.delete(id),
});

assert.equal(schedule('taskbox_hq_cache_v1'), true);
assert.equal(schedule('taskbox_api_sync_state_v1'), true);
assert.equal(schedule('taskbox_api_mutation_outbox_v1:entry:abc'), true);
assert.equal(callbacks.size, 1);
callbacks.forEach((callback, id) => { callbacks.delete(id); callback(); });
assert.equal(refreshes, 1);
assert.equal(invalidations, 0);

assert.equal(schedule('taskbox_data'), true);
assert.equal(schedule('taskbox_hq_cache_v1'), true);
assert.equal(callbacks.size, 1);
callbacks.forEach((callback, id) => { callbacks.delete(id); callback(); });
assert.equal(refreshes, 2);
assert.equal(invalidations, 1);

assert.equal(schedule('unrelated'), false);
assert.equal(callbacks.size, 0);
assert.equal(refreshes, 2);

console.log('app storage tests passed');
