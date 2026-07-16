import assert from 'node:assert/strict';
import {
  formatVisibleAfter,
  getDefaultDeferredUntil,
  getTaskContextRank,
  isTaskContextMismatch,
  isTaskReleased,
  normalizeDeviceContext,
  normalizeDeviceMode,
} from '../js/task-visibility.js';

assert.equal(normalizeDeviceContext(undefined), 'universal');
assert.equal(normalizeDeviceContext(undefined, 'desktop'), 'desktop');
assert.equal(normalizeDeviceMode('unknown'), 'auto');

const reference = new Date(2026, 6, 16, 15, 20, 0, 0);
const deferredUntil = getDefaultDeferredUntil(reference);
const deferredDate = new Date(deferredUntil);
assert.equal(deferredDate.getDate(), 17);
assert.equal(deferredDate.getHours(), 8);
assert.equal(formatVisibleAfter(deferredUntil, reference), '明天 08:00');
assert.equal(isTaskReleased({ visibleAfter: deferredUntil }, reference), false);
assert.equal(isTaskReleased({ visibleAfter: deferredUntil }, new Date(2026, 6, 17, 8, 0, 0, 0)), true);
assert.equal(isTaskReleased({ isCompleted: true, visibleAfter: deferredUntil }, reference), true);

const desktopSettings = { deviceContextMode: 'desktop' };
assert.equal(getTaskContextRank({ deviceContext: 'desktop' }, desktopSettings), 0);
assert.equal(getTaskContextRank({ deviceContext: 'universal' }, desktopSettings), 1);
assert.equal(getTaskContextRank({ deviceContext: 'mobile' }, desktopSettings), 2);
assert.equal(isTaskContextMismatch({ deviceContext: 'mobile' }, desktopSettings), true);
assert.equal(isTaskContextMismatch({ deviceContext: 'mobile' }, { deviceContextMode: 'all' }), false);

console.log('task visibility tests passed');
