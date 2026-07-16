import assert from 'node:assert/strict';
import {
  getNextOccurrenceAt,
  getOccurrenceDueAt,
  getOccurrenceVisibleAfter,
  getFirstOccurrenceAt,
  getRecurrenceLabel,
  getRecurringOccurrenceId,
  normalizeRecurrenceRule,
} from '../js/recurrence.js';

const daily = normalizeRecurrenceRule({ type: 'daily', time: '10:00' }, '2026-07-14T02:00:00.000Z');
assert.equal(getRecurrenceLabel(daily), '每天 10:00 · 08:00 出现');
assert.equal(new Date(getNextOccurrenceAt(daily, daily.anchorAt)).getDate(), 15);

const rolling = normalizeRecurrenceRule({ type: 'interval', interval: 2, mode: 'completion', time: '19:30' }, '2026-07-14T11:30:00.000Z');
const rollingNext = new Date(getNextOccurrenceAt(rolling, rolling.anchorAt, '2026-07-15T13:00:00.000Z'));
assert.equal(rollingNext.getDate(), 17);
assert.equal(rollingNext.getHours(), 19);
assert.equal(rollingNext.getMinutes(), 30);

const weekly = normalizeRecurrenceRule({ type: 'weekly', weekday: 0, time: '22:00' }, '2026-07-14T14:00:00.000Z');
const weeklyNext = new Date(getNextOccurrenceAt(weekly, weekly.anchorAt));
assert.equal(weeklyNext.getDay(), 0);
assert.equal(weeklyNext.getHours(), 22);
assert.equal(new Date(getFirstOccurrenceAt(weekly, '2026-07-14T14:00:00.000Z')).getDay(), 0);

const monthly = normalizeRecurrenceRule({ type: 'monthly', monthDay: 'last', time: '22:00' }, '2026-01-31T14:00:00.000Z');
const february = new Date(getNextOccurrenceAt(monthly, monthly.anchorAt));
assert.equal(february.getMonth(), 1);
assert.equal(february.getDate(), 28);
assert.equal(new Date(getFirstOccurrenceAt(monthly, '2026-01-14T14:00:00.000Z')).getDate(), 31);

const withDeadline = normalizeRecurrenceRule({ type: 'daily' }, '2026-07-14T02:00:00.000Z', '2026-07-14T14:00:00.000Z');
assert.equal(getOccurrenceDueAt(withDeadline, '2026-07-15T02:00:00.000Z'), '2026-07-15T14:00:00.000Z');
assert.equal(getRecurringOccurrenceId('template-a', '2026-07-14T02:00:00.000Z'), 'rec-template-a-1783994400000');
const visibleAfter = new Date(getOccurrenceVisibleAfter(daily, daily.anchorAt));
assert.equal(visibleAfter.getHours(), 8);
assert.equal(visibleAfter.getMinutes(), 0);

console.log('recurrence tests passed');
