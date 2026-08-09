import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

const storage = new Map();
if (!globalThis.crypto) globalThis.crypto = webcrypto;
globalThis.localStorage = {
  getItem(key) { return storage.has(key) ? storage.get(key) : null; },
  setItem(key, value) { storage.set(key, String(value)); },
  removeItem(key) { storage.delete(key); },
};

const {
  addBranch,
  addMainline,
  addTask,
  deleteBranch,
  getBoxes,
  getBranches,
  getTaskById,
  updateBranch,
} = await import('../js/db.js');

const mainline = addMainline({ name: '支线测试主线' });
const branch = addBranch(mainline.id, {
  name: '青岛旅行',
  branchType: 'travel',
  status: 'active',
  nextAction: '确定出发日期',
});

assert.equal(getBranches(mainline.id).length, 1);
assert.equal(branch.mainlineId, mainline.id);
assert.equal(branch.branchType, 'travel');

const taskBox = getBoxes().find((box) => box.color === 'important');
const task = addTask({ content: '预订车票', boxId: taskBox.id, mainlineId: mainline.id, branchId: branch.id });
assert.equal(getTaskById(task.id).branchId, branch.id);

const completed = updateBranch(branch.id, { status: 'completed' });
assert.ok(completed.completedAt);

for (let index = 0; index < 6; index += 1) {
  addBranch(mainline.id, { name: `活跃支线 ${index + 1}`, status: 'planned' });
}
assert.throws(() => addBranch(mainline.id, { name: '第七条活跃支线', status: 'active' }), /branch limit/);

deleteBranch(branch.id);
assert.equal(getBranches(mainline.id).some((item) => item.id === branch.id), false);
assert.equal(getTaskById(task.id).branchId, null);

console.log('branch tests passed');
