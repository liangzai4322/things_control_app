import assert from 'node:assert/strict';
import {
  buildHqProjectHealth,
  normalizeHqBrief,
  normalizeReviewStatus,
  selectHqCommitments,
} from '../js/hq-model.js';

const reviewDate = '2026-07-30';
const tasks = [
  { id: 'main', content: '完成 MVP', pinLevel: 1, commitmentRole: 'primary', commitmentDate: reviewDate },
  { id: 'maintenance-a', content: '回复客户', pinLevel: 2 },
  { id: 'maintenance-b', content: '运动', pinLevel: 3 },
  { id: 'done', content: '已完成', pinLevel: 1, isCompleted: true },
];

const normalized = normalizeHqBrief({
  primaryTaskId: 'main',
  maintenanceTaskIds: ['maintenance-a', 'maintenance-a', 'maintenance-b', 'overflow'],
}, reviewDate);
assert.equal(normalized.reviewDate, reviewDate);
assert.deepEqual(normalized.maintenanceTaskIds, ['maintenance-a', 'maintenance-b']);

const commitments = selectHqCommitments(tasks, normalized, reviewDate);
assert.equal(commitments.primary.id, 'main');
assert.deepEqual(commitments.maintenance.map((task) => task.id), ['maintenance-a', 'maintenance-b']);

const [project] = buildHqProjectHealth([
  { id: 'project', name: '人生参谋部', status: 'active', updatedAt: '2026-07-29T00:00:00.000Z' },
], [
  { id: 'next', mainlineId: 'project', content: '部署 MVP', createdAt: '2026-07-29T00:00:00.000Z', updatedAt: '2026-07-29T00:00:00.000Z' },
], new Date('2026-07-30T00:00:00.000Z'));
assert.equal(project.health, 'healthy');
assert.equal(project.nextAction.id, 'next');

const review = normalizeReviewStatus({
  status: 'synced',
  todayEvidence: { touched: 4, completed: 2, progress: 3 },
  history: [
    { date: '2026-07-28', state: 'completed' },
    { date: '2026-07-29', state: 'partial' },
    { date: '2026-07-30', state: 'missed' },
  ],
}, reviewDate);
assert.equal(review.status, 'synced');
assert.equal(review.knownCount, 3);
assert.equal(review.completedCount, 1);
assert.equal(review.completionRate, 33);
assert.deepEqual(review.todayEvidence, { touched: 4, completed: 2, progress: 3 });

console.log('hq model tests passed');
