import assert from 'node:assert/strict';
import { taskboxCalendarDateKey } from '../js/db.js';

assert.equal(taskboxCalendarDateKey('2026-08-07T15:59:59.999Z'), '2026-08-07');
assert.equal(taskboxCalendarDateKey('2026-08-07T16:00:00.000Z'), '2026-08-08');
assert.equal(taskboxCalendarDateKey('not-a-date'), '');

console.log('db calendar tests passed');
