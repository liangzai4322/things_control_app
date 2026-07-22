import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

const storage = new Map();
globalThis.crypto = webcrypto;
globalThis.localStorage = {
  getItem(key) { return storage.has(key) ? storage.get(key) : null; },
  setItem(key, value) { storage.set(key, String(value)); },
  removeItem(key) { storage.delete(key); },
};

const {
  addRecurringTask,
  addTask,
  getBoxes,
  getData,
  getDeferredTasksByBox,
  getLocalIdeaBoxRecoveryPlan,
  getTaskById,
  getTasks,
  getTimelineTasks,
  updateTask,
} = await import('../js/db.js');

const taskBox = getBoxes().find((box) => box.color === 'important');
assert.ok(taskBox);
assert.equal(getData().tasks[0].deviceContext, 'universal');

const normal = addTask({ content: 'default device test', boxId: taskBox.id });
assert.equal(normal.deviceContext, 'desktop');
assert.equal(normal.executionMode, 'self');

const nextMonth = new Date();
nextMonth.setMonth(nextMonth.getMonth() + 1, 12);
nextMonth.setHours(16, 30, 0, 0);
const future = addTask({
  content: 'future day task',
  boxId: taskBox.id,
  scheduledAt: nextMonth.toISOString(),
  executionMode: 'ai',
});
assert.equal(future.executionMode, 'ai');
assert.equal(new Date(future.visibleAfter).getHours(), 0);
assert.equal(getTasks().some((task) => task.id === future.id), false);
assert.equal(getTimelineTasks().some((task) => task.id === future.id), true);
assert.equal(getDeferredTasksByBox(taskBox.id).some((task) => task.id === future.id), true);
assert.equal(getTaskById(future.id)?.content, 'future day task');

const todayLater = new Date();
todayLater.setHours(23, 0, 0, 0);
updateTask(future.id, { scheduledAt: todayLater.toISOString() });
assert.equal(getTaskById(future.id)?.visibleAfter, null);
assert.equal(getTasks().some((task) => task.id === future.id), true);

const todayAtNine = new Date();
todayAtNine.setHours(9, 0, 0, 0);
const first = addRecurringTask({
  content: 'release gate test',
  boxId: taskBox.id,
  scheduledAt: todayAtNine.toISOString(),
  deviceContext: 'mobile',
}, {
  type: 'daily',
  time: '09:00',
  releaseTime: '00:00',
  missPolicy: 'carry',
});

assert.ok(first);
assert.equal(first.deviceContext, 'mobile');
assert.ok(getTasks().some((task) => task.id === first.id));

updateTask(first.id, {
  isCompleted: true,
  progress: 100,
  completedAt: new Date().toISOString(),
});

const nextDeferred = getDeferredTasksByBox(taskBox.id)
  .find((task) => task.recurrenceTemplateId === first.recurrenceTemplateId);
assert.ok(nextDeferred, 'next recurring occurrence should exist but stay deferred');
assert.equal(nextDeferred.deviceContext, 'mobile');
assert.ok(new Date(nextDeferred.visibleAfter) > new Date());
assert.equal(getTasks().some((task) => task.id === nextDeferred.id), false);

const localIdeaBox = { id: 'ideas-local', name: '思路盒', createdAt: new Date().toISOString() };
const recovery = getLocalIdeaBoxRecoveryPlan({
  boxes: [localIdeaBox],
  tasks: [{ id: 'idea-task-local', boxId: localIdeaBox.id, content: '尚未想清楚的项目', syncKey: 'idea-local' }],
}, { boxes: [], tasks: [] });
assert.deepEqual(recovery.boxes.map((box) => box.id), ['ideas-local']);
assert.deepEqual(recovery.tasks.map((task) => task.id), ['idea-task-local']);

const canonicalRecovery = getLocalIdeaBoxRecoveryPlan({
  boxes: [localIdeaBox],
  tasks: [{ id: 'idea-task-local', boxId: localIdeaBox.id, content: '尚未想清楚的项目', syncKey: 'idea-local' }],
}, { boxes: [{ id: 'ideas-cloud', name: '思路盒' }], tasks: [] });
assert.equal(canonicalRecovery.boxes.length, 0);
assert.equal(canonicalRecovery.tasks[0].boxId, 'ideas-cloud');

console.log('db visibility tests passed');
