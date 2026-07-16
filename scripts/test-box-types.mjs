import assert from 'node:assert/strict';
import {
  BOX_TYPE_COLLECTION,
  BOX_TYPE_POOL,
  BOX_TYPE_TASK,
  formatCooldownRemaining,
  getPoolCooldownState,
  inferBoxType,
  normalizeBoxTypeConfig,
} from '../js/box-types.js';

assert.equal(inferBoxType({ color: 'important' }), BOX_TYPE_TASK);
assert.equal(inferBoxType({ color: 'relax' }), BOX_TYPE_POOL);
assert.equal(inferBoxType({ color: 'reward' }), BOX_TYPE_POOL);
assert.equal(inferBoxType({ color: 'study' }), BOX_TYPE_COLLECTION);
assert.equal(inferBoxType({ color: 'study', boxType: 'task' }), BOX_TYPE_TASK);

assert.deepEqual(normalizeBoxTypeConfig(BOX_TYPE_POOL, { defaultCooldownMinutes: 30 }), {
  drawEnabled: true,
  defaultCooldownMinutes: 30,
});

const reference = new Date('2026-07-15T10:00:00.000Z');
assert.equal(getPoolCooldownState({ cooldownMinutes: 60 }, reference).available, true);
assert.equal(getPoolCooldownState({ cooldownMinutes: 60, lastUsedAt: '2026-07-15T09:30:00.000Z' }, reference).remainingMinutes, 30);
assert.equal(getPoolCooldownState({ cooldownMinutes: 60, lastUsedAt: '2026-07-15T08:30:00.000Z' }, reference).available, true);
assert.equal(formatCooldownRemaining(30), '30 分钟后可用');
assert.equal(formatCooldownRemaining(120), '2 小时后可用');
assert.equal(formatCooldownRemaining(2881), '3 天后可用');

console.log('box type tests passed');
