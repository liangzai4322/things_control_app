import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';

const storage = new Map();
globalThis.crypto = webcrypto;
globalThis.localStorage = {
  getItem(key) { return storage.has(key) ? storage.get(key) : null; },
  setItem(key, value) { storage.set(key, String(value)); },
  removeItem(key) { storage.delete(key); },
};

const { addTask, getBoxes, getTaskById, updateTask } = await import('../js/db.js');
const box = getBoxes().find((item) => item.color === 'important');
const task = addTask({ content: '完成回执测试', boxId: box.id, note: '这是完成备注' });
const receipt = {
  version: 1,
  sourceTaskId: task.id,
  content: task.content,
  note: task.note,
  completedAt: new Date().toISOString(),
  boxName: box.name,
  boxColor: box.color,
};

updateTask(task.id, { isCompleted: true, completedAt: receipt.completedAt, completionReceipt: receipt });
const stored = getTaskById(task.id);
assert.equal(stored.completionReceipt.note, '这是完成备注');
assert.equal(stored.completionReceipt.sourceTaskId, task.id);

updateTask(task.id, { note: '后来修改的备注' });
assert.equal(getTaskById(task.id).completionReceipt.note, '这是完成备注', '完成快照不应跟随任务备注静默改变');

const cardSource = await readFile(new URL('../js/completion-card.js', import.meta.url), 'utf8');
assert.match(cardSource, /NOTE_LINES_PER_PAGE/);
assert.match(cardSource, /navigator\.share/);
assert.match(cardSource, /completion-receipt-canvas/);

console.log('completion receipt tests passed');
