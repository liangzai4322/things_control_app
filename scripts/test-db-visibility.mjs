import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

const storage = new Map();
if (!globalThis.crypto) globalThis.crypto = webcrypto;
globalThis.localStorage = {
  getItem(key) { return storage.has(key) ? storage.get(key) : null; },
  setItem(key, value) { storage.set(key, String(value)); },
  removeItem(key) { storage.delete(key); },
  key(index) { return [...storage.keys()][index] ?? null; },
  get length() { return storage.size; },
};
globalThis.window = new EventTarget();
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { onLine: true },
});

const {
  addRecurringTask,
  addTask,
  bindTaskboxOnlineRecovery,
  dedupeTasksByIdentity,
  getBoxes,
  getData,
  getDeferredTasksByBox,
  getLocalIdeaBoxRecoveryPlan,
  getApiSyncState,
  getPendingApiMutationCount,
  mergeData,
  pullDataFromCloud,
  queueTaskboxApiMutation,
  replayPendingApiMutations,
  setSettings,
  getTaskById,
  getTasks,
  getTimelineTasks,
  updateTask,
  waitForPendingApiMutations,
} = await import('../js/db.js');

const taskBox = getBoxes().find((box) => box.color === 'important');
assert.ok(taskBox);
assert.equal(getData().tasks[0].deviceContext, 'universal');

const normal = addTask({ content: 'default device test', boxId: taskBox.id });
assert.equal(normal.deviceContext, 'desktop');
assert.equal(normal.executionMode, 'self');
assert.equal(normal.pinLevel, null);

const ranked = addTask({ content: 'top three test', boxId: taskBox.id, pinLevel: 2 });
assert.equal(ranked.pinLevel, 2);
assert.equal(ranked.pinned, true);

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

const duplicateCreatedAt = new Date().toISOString();
const collapsedDuplicates = dedupeTasksByIdentity([
  { id: 'copy-a', boxId: taskBox.id, content: ' 修改后重复的任务 ', createdAt: duplicateCreatedAt, updatedAt: duplicateCreatedAt },
  { id: 'copy-b', boxId: taskBox.id, content: '修改后重复的任务', createdAt: duplicateCreatedAt, updatedAt: new Date(Date.now() + 1000).toISOString() },
]);
assert.equal(collapsedDuplicates.length, 1);
assert.deepEqual(collapsedDuplicates[0].duplicateIds, ['copy-a']);

const intentionalDuplicates = dedupeTasksByIdentity([
  { id: 'later-a', boxId: taskBox.id, content: '允许再次创建', createdAt: '2026-01-01T00:00:00.000Z' },
  { id: 'later-b', boxId: taskBox.id, content: '允许再次创建', createdAt: '2026-01-01T01:00:00.000Z' },
]);
assert.equal(intentionalDuplicates.length, 2);

const cloudDeletedAt = '2026-08-05T08:00:00.000Z';
const mergedCloudDeletion = mergeData({
  boxes: [taskBox],
  tasks: [{
    id: 'cloud-deleted-task',
    boxId: taskBox.id,
    content: 'stale local task',
    deleted: false,
    updatedAt: '2026-08-05T09:00:00.000Z',
  }],
}, {
  boxes: [taskBox],
  tasks: [{
    id: 'cloud-deleted-task',
    boxId: taskBox.id,
    content: 'stale local task',
    deleted: true,
    deletedAt: cloudDeletedAt,
    updatedAt: cloudDeletedAt,
  }],
});
assert.equal(mergedCloudDeletion.tasks.length, 1);
assert.equal(mergedCloudDeletion.tasks[0].deleted, true);

const mergedCloudReplacement = mergeData({
  boxes: [taskBox],
  tasks: [{
    id: 'stale-local-id',
    syncKey: 'shared-action-key',
    boxId: taskBox.id,
    content: 'stale local action',
    updatedAt: '2026-08-05T09:00:00.000Z',
  }],
}, {
  boxes: [taskBox],
  tasks: [{
    id: 'cloud-replacement-id',
    syncKey: 'shared-action-key',
    boxId: taskBox.id,
    content: 'cloud replacement action',
    updatedAt: '2026-08-05T08:00:00.000Z',
  }],
});
assert.deepEqual(mergedCloudReplacement.tasks.map((task) => task.id), ['cloud-replacement-id']);

setSettings({ apiEndpoint: 'https://taskbox.test/v1', apiToken: 'test-token' });
let apiOnline = false;
const apiRequests = [];
const remoteDailyBriefs = new Map();
let missingMutationPath = '';
const forcedStatusByPath = new Map();
let hangingMutationPath = '';
let delayedOldMutation = null;
globalThis.fetch = async (url, options = {}) => {
  if (!apiOnline) throw new Error('offline');
  apiRequests.push({ url, method: options.method || 'GET', body: options.body || null });
  if (hangingMutationPath && url.endsWith(hangingMutationPath)) {
    return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  }
  if (delayedOldMutation && url.endsWith(delayedOldMutation.path)
    && JSON.parse(options.body || '{}').currentActionTaskId === 'OLD') {
    delayedOldMutation.started();
    await delayedOldMutation.release;
  }
  const forcedStatus = [...forcedStatusByPath.entries()].find(([path]) => url.endsWith(path))?.[1];
  if (forcedStatus) {
    return { ok: false, status: forcedStatus, json: async () => ({ error: `forced_${forcedStatus}` }) };
  }
  if (missingMutationPath && url.endsWith(missingMutationPath)) {
    return { ok: false, status: 404, json: async () => ({ error: 'not_found' }) };
  }
  if (url.endsWith('/taskbox')) {
    return { ok: true, status: 200, json: async () => getData() };
  }
  if (url.includes('/hq/daily-briefs/') && (options.method || 'GET') === 'POST') {
    const payload = JSON.parse(options.body || '{}');
    remoteDailyBriefs.set(url, payload);
    return { ok: true, status: 200, json: async () => payload };
  }
  return { ok: true, status: 200, json: async () => ({ ok: true }) };
};
addTask({ content: 'offline mutation outbox', boxId: taskBox.id });
await waitForPendingApiMutations();
assert.equal(getPendingApiMutationCount(), 1);
assert.equal(getApiSyncState().status, 'pending');
await assert.rejects(() => pullDataFromCloud({ force: true }), /api_pending_mutations/);
assert.equal(getPendingApiMutationCount(), 1);
apiOnline = true;
const replayed = await replayPendingApiMutations();
assert.equal(replayed.replayed, 1);
assert.equal(getPendingApiMutationCount(), 0);
assert.equal(getApiSyncState().status, 'synced');

apiOnline = false;
const legacyAggregateBeforeBrief = localStorage.getItem('taskbox_api_mutation_outbox_v1');
const briefMutation = queueTaskboxApiMutation('/hq/daily-briefs/2026-08-07', {
  method: 'POST',
  body: JSON.stringify({
    reviewDate: '2026-08-07',
    primaryTaskId: 'offline-primary',
    currentActionTaskId: 'offline-primary',
  }),
});
assert.ok(briefMutation);
assert.equal(localStorage.getItem('taskbox_api_mutation_outbox_v1'), legacyAggregateBeforeBrief,
  'new tabs must not rewrite the legacy aggregate');
const persistedBriefEntries = [...storage.entries()]
  .filter(([key]) => key.startsWith('taskbox_api_mutation_outbox_v1:entry:'))
  .map(([, value]) => JSON.parse(value));
assert.equal(persistedBriefEntries.length, 1);
assert.ok(persistedBriefEntries[0].syncMutation?.generation);
assert.ok(JSON.parse(persistedBriefEntries[0].body)._syncMutation?.generation,
  'the authoritative per-entry mutation must carry server fence metadata');
await waitForPendingApiMutations();
assert.equal(getPendingApiMutationCount(), 1);
await assert.rejects(() => pullDataFromCloud({ force: true }), /api_pending_mutations/);
apiOnline = true;
const briefReplay = await replayPendingApiMutations();
assert.equal(briefReplay.replayed, 1);
assert.equal(getPendingApiMutationCount(), 0);
const replayedBrief = apiRequests.find((request) => request.url.endsWith('/hq/daily-briefs/2026-08-07'));
assert.equal(replayedBrief?.method, 'POST');
assert.equal(JSON.parse(replayedBrief?.body || '{}').currentActionTaskId, 'offline-primary');

// A newer online write must join the same persisted drain behind an older
// offline write for that daily brief. Sending NEW before replaying OLD would
// leave the remote value stale after OLD eventually replays.
apiOnline = false;
const orderedPath = '/hq/daily-briefs/2026-08-08';
queueTaskboxApiMutation(orderedPath, {
  method: 'POST',
  body: JSON.stringify({ currentActionTaskId: 'OLD' }),
});
await waitForPendingApiMutations();
assert.equal(getPendingApiMutationCount(), 1);
apiOnline = true;
await queueTaskboxApiMutation(orderedPath, {
  method: 'POST',
  body: JSON.stringify({ currentActionTaskId: 'NEW' }),
});
const orderedWrites = apiRequests
  .filter((request) => request.url.endsWith(orderedPath))
  .map((request) => JSON.parse(request.body).currentActionTaskId);
assert.deepEqual(orderedWrites, ['OLD', 'NEW']);
assert.equal(remoteDailyBriefs.get(`https://taskbox.test/v1${orderedPath}`).currentActionTaskId, 'NEW');
assert.equal(getPendingApiMutationCount(), 0);

// Persisted entries from a previous page lifecycle are drained without any
// in-memory queue state.
const reloadPath = '/hq/daily-briefs/2026-08-09';
const reloadLegacyEntry = {
  id: 'reload-old-entry',
  queueKey: reloadPath,
  path: reloadPath,
  method: 'POST',
  body: JSON.stringify({ currentActionTaskId: 'RELOADED' }),
  createdAt: '2026-08-09T01:00:00.000Z',
};
localStorage.setItem('taskbox_api_mutation_outbox_v1', JSON.stringify([reloadLegacyEntry]));
const reloadReplay = await replayPendingApiMutations();
assert.equal(reloadReplay.replayed, 1);
assert.equal(remoteDailyBriefs.get(`https://taskbox.test/v1${reloadPath}`).currentActionTaskId, 'RELOADED');
assert.equal(getPendingApiMutationCount(), 0);
assert.equal(localStorage.getItem('taskbox_api_mutation_outbox_v1:legacy_ack:reload-old-entry'), '1');
assert.equal(apiRequests.filter((request) => request.url.endsWith(reloadPath)).length, 1);
const acknowledgedReloadReplay = await replayPendingApiMutations();
assert.equal(acknowledgedReloadReplay.replayed, 0);
assert.equal(apiRequests.filter((request) => request.url.endsWith(reloadPath)).length, 1,
  'an acknowledged legacy aggregate entry must not replay');

// An old tab may append to its aggregate after migration. Keep the acknowledged
// item in place and import only the newly appended mutation exactly once.
const appendedReloadPath = '/hq/daily-briefs/2026-08-09-appended';
const appendedLegacyEntry = {
  id: 'reload-appended-entry',
  queueKey: appendedReloadPath,
  path: appendedReloadPath,
  method: 'POST',
  body: JSON.stringify({ currentActionTaskId: 'APPENDED' }),
  createdAt: '2026-08-09T01:01:00.000Z',
};
localStorage.setItem('taskbox_api_mutation_outbox_v1', JSON.stringify([
  reloadLegacyEntry,
  appendedLegacyEntry,
]));
const appendedReloadReplay = await replayPendingApiMutations();
assert.equal(appendedReloadReplay.replayed, 1);
assert.equal(remoteDailyBriefs.get(`https://taskbox.test/v1${appendedReloadPath}`).currentActionTaskId, 'APPENDED');
assert.equal(localStorage.getItem('taskbox_api_mutation_outbox_v1:legacy_ack:reload-appended-entry'), '1');
assert.equal(apiRequests.filter((request) => request.url.endsWith(reloadPath)).length, 1);
assert.equal(apiRequests.filter((request) => request.url.endsWith(appendedReloadPath)).length, 1);
const acknowledgedAppendReplay = await replayPendingApiMutations();
assert.equal(acknowledgedAppendReplay.replayed, 0);
assert.equal(apiRequests.filter((request) => request.url.endsWith(appendedReloadPath)).length, 1,
  'an acknowledged append must not replay');

// A permanent PATCH 404 is dead-lettered visibly, then the following HQ write
// and a cloud pull still run. DELETE 404 remains an idempotent success.
missingMutationPath = '/tasks/missing-for-patch';
const afterMissingPath = '/hq/daily-briefs/2026-08-10';
localStorage.setItem('taskbox_api_mutation_outbox_v1', JSON.stringify([
  {
    id: 'missing-patch-entry',
    queueKey: 'tasks:missing-for-patch',
    path: '/tasks/missing-for-patch',
    method: 'PATCH',
    body: JSON.stringify({ content: 'stale local patch' }),
    createdAt: '2026-08-10T01:00:00.000Z',
  },
  {
    id: 'hq-after-missing-entry',
    queueKey: afterMissingPath,
    path: afterMissingPath,
    method: 'POST',
    body: JSON.stringify({ currentActionTaskId: 'AFTER_404' }),
    createdAt: '2026-08-10T01:01:00.000Z',
  },
]));
const permanentReplay = await replayPendingApiMutations();
assert.equal(permanentReplay.deadLetters.length, 1);
assert.equal(permanentReplay.deadLetters[0].status, 404);
assert.equal(getPendingApiMutationCount(), 0);
assert.equal(getApiSyncState().deadLetterCount, 1);
assert.equal(getApiSyncState().lastPermanentError?.path, '/tasks/missing-for-patch');
assert.equal(remoteDailyBriefs.get(`https://taskbox.test/v1${afterMissingPath}`).currentActionTaskId, 'AFTER_404');
missingMutationPath = '';
await pullDataFromCloud({ force: true });
assert.ok(apiRequests.some((request) => request.url.endsWith('/taskbox')));

missingMutationPath = '/tasks/already-deleted';
localStorage.setItem('taskbox_api_mutation_outbox_v1', JSON.stringify([{
  id: 'delete-404-entry',
  queueKey: 'tasks:already-deleted',
  path: '/tasks/already-deleted',
  method: 'DELETE',
  body: null,
  createdAt: '2026-08-10T02:00:00.000Z',
}]));
const deleteReplay = await replayPendingApiMutations();
assert.equal(deleteReplay.replayed, 1);
assert.equal(deleteReplay.deadLetters.length, 0);
assert.equal(getApiSyncState().deadLetterCount, 1);
assert.equal(getPendingApiMutationCount(), 0);

// Different module instances (the browser equivalent of two tabs) must share
// one drain. A slow OLD request cannot finish after NEW and overwrite it.
const tabA = await import(`../js/db.js?tab=a-${Date.now()}`);
const crossTabPath = '/hq/daily-briefs/2026-08-11';
apiOnline = false;
tabA.queueTaskboxApiMutation(crossTabPath, {
  method: 'POST',
  body: JSON.stringify({ currentActionTaskId: 'OLD' }),
});
await tabA.waitForPendingApiMutations();
apiOnline = true;
let releaseOld;
let markOldStarted;
const oldStarted = new Promise((resolve) => { markOldStarted = resolve; });
const oldRelease = new Promise((resolve) => { releaseOld = resolve; });
delayedOldMutation = { path: crossTabPath, started: markOldStarted, release: oldRelease };
const oldDrain = tabA.replayPendingApiMutations();
await oldStarted;
const tabB = await import(`../js/db.js?tab=b-${Date.now()}`);
const newDrain = tabB.queueTaskboxApiMutation(crossTabPath, {
  method: 'POST',
  body: JSON.stringify({ currentActionTaskId: 'NEW' }),
});
releaseOld();
const crossTabSettled = await Promise.allSettled([oldDrain, newDrain]);
assert.deepEqual(crossTabSettled.map((result) => result.status), ['fulfilled', 'fulfilled'],
  'both coordinated drains must fulfill');
delayedOldMutation = null;
const crossTabWrites = apiRequests
  .filter((request) => request.url.endsWith(crossTabPath))
  .map((request) => JSON.parse(request.body).currentActionTaskId);
assert.deepEqual(crossTabWrites, ['OLD', 'NEW']);
assert.equal(remoteDailyBriefs.get(`https://taskbox.test/v1${crossTabPath}`).currentActionTaskId, 'NEW');
assert.equal(getPendingApiMutationCount(), 0);

// A fetch that never answers is aborted. Its mutation remains pending and the
// fallback lease is released so a later tab/recovery pass can drain it.
const timeoutPath = '/hq/daily-briefs/2026-08-11-timeout';
hangingMutationPath = timeoutPath;
globalThis.__TASKBOX_API_REQUEST_TIMEOUT_MS__ = 5;
const timeoutSettled = await Promise.allSettled([queueTaskboxApiMutation(timeoutPath, {
  method: 'POST',
  body: JSON.stringify({ currentActionTaskId: 'TIMEOUT' }),
})]);
assert.equal(timeoutSettled[0].status, 'rejected');
assert.equal(getPendingApiMutationCount(), 1);
assert.equal(localStorage.getItem('taskbox_api_mutation_outbox_v1:drain_lease'), null);
hangingMutationPath = '';
delete globalThis.__TASKBOX_API_REQUEST_TIMEOUT_MS__;
const afterTimeoutReplay = await replayPendingApiMutations();
assert.equal(afterTimeoutReplay.replayed, 1);
assert.equal(getPendingApiMutationCount(), 0);

// Retryable failure blocks only its queue key. Later writes for the same key
// stay FIFO, while an unrelated HQ write continues instead of starving.
const fairRetryPath = '/tasks/retry-fair';
const fairOtherPath = '/hq/daily-briefs/2026-08-12';
localStorage.setItem('taskbox_api_mutation_outbox_v1', JSON.stringify([
  {
    id: 'fair-retry-1', queueKey: 'tasks:retry-fair', path: fairRetryPath, method: 'PATCH',
    body: JSON.stringify({ content: 'A1' }), createdAt: '2026-08-12T01:00:00.000Z',
  },
  {
    id: 'fair-retry-2', queueKey: 'tasks:retry-fair', path: fairRetryPath, method: 'PATCH',
    body: JSON.stringify({ content: 'A2' }), createdAt: '2026-08-12T01:01:00.000Z',
  },
  {
    id: 'fair-other', queueKey: fairOtherPath, path: fairOtherPath, method: 'POST',
    body: JSON.stringify({ currentActionTaskId: 'B' }), createdAt: '2026-08-12T01:02:00.000Z',
  },
]));
forcedStatusByPath.set(fairRetryPath, 503);
const fairBlocked = await replayPendingApiMutations();
assert.deepEqual(fairBlocked.blockedQueueKeys, ['tasks:retry-fair']);
assert.equal(getPendingApiMutationCount(), 2);
assert.equal(remoteDailyBriefs.get(`https://taskbox.test/v1${fairOtherPath}`).currentActionTaskId, 'B');
assert.deepEqual(apiRequests
  .filter((request) => request.url.endsWith(fairRetryPath))
  .map((request) => JSON.parse(request.body).content), ['A1']);
forcedStatusByPath.delete(fairRetryPath);
await replayPendingApiMutations();
assert.deepEqual(apiRequests
  .filter((request) => request.url.endsWith(fairRetryPath))
  .map((request) => JSON.parse(request.body).content), ['A1', 'A1', 'A2']);
assert.equal(getPendingApiMutationCount(), 0);

// Authentication errors are recoverable configuration blocks: keep them in
// the outbox, expose the status, and never convert them to dead letters.
for (const authStatus of [401, 403]) {
  const authPath = `/tasks/auth-${authStatus}`;
  const deadLettersBefore = getApiSyncState().deadLetterCount;
  localStorage.setItem('taskbox_api_mutation_outbox_v1', JSON.stringify([{
    id: `auth-${authStatus}`, queueKey: `tasks:auth-${authStatus}`, path: authPath, method: 'PATCH',
    body: JSON.stringify({ content: `AUTH-${authStatus}` }), createdAt: `2026-08-12T02:${authStatus === 401 ? '01' : '02'}:00.000Z`,
  }]));
  forcedStatusByPath.set(authPath, authStatus);
  const authReplay = await replayPendingApiMutations();
  assert.equal(authReplay.authBlocked, true);
  assert.equal(getPendingApiMutationCount(), 1);
  assert.equal(getApiSyncState().deadLetterCount, deadLettersBefore);
  assert.equal(getApiSyncState().authBlocked, true);
  assert.equal(getApiSyncState().lastAuthError?.status, authStatus);
  await assert.rejects(() => pullDataFromCloud({ force: true }), /api_pending_mutations/);
  forcedStatusByPath.delete(authPath);
  await replayPendingApiMutations();
  assert.equal(getPendingApiMutationCount(), 0);
  assert.equal(getApiSyncState().authBlocked, false);
}

// A genuine permanent 4xx remains observable as a dead letter.
const permanent400Path = '/tasks/permanent-400';
const deadLettersBefore400 = getApiSyncState().deadLetterCount;
localStorage.setItem('taskbox_api_mutation_outbox_v1', JSON.stringify([{
  id: 'permanent-400', queueKey: 'tasks:permanent-400', path: permanent400Path, method: 'PATCH',
  body: JSON.stringify({ content: 'bad request' }), createdAt: '2026-08-12T03:00:00.000Z',
}]));
forcedStatusByPath.set(permanent400Path, 400);
const permanent400 = await replayPendingApiMutations();
assert.equal(permanent400.deadLetters[0]?.status, 400);
assert.equal(getApiSyncState().deadLetterCount, deadLettersBefore400 + 1);
assert.equal(getPendingApiMutationCount(), 0);
forcedStatusByPath.delete(permanent400Path);

// Reconnect while the page stays open automatically drains, then pulls and
// notifies once even if the browser emits a short online-event burst.
const reconnectPath = '/hq/daily-briefs/2026-08-13';
globalThis.__TASKBOX_API_RECOVERY_RETRY_MS__ = 5;
apiOnline = false;
navigator.onLine = false;
queueTaskboxApiMutation(reconnectPath, {
  method: 'POST',
  body: JSON.stringify({ currentActionTaskId: 'RECONNECTED' }),
});
await waitForPendingApiMutations();
let recoveryCalls = 0;
bindTaskboxOnlineRecovery((report) => {
  if (!report.error && !report.pending) recoveryCalls += 1;
});
await new Promise((resolve) => setTimeout(resolve, 100));
apiOnline = true;
navigator.onLine = true;
for (let attempt = 0; attempt < 30 && getPendingApiMutationCount(); attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 20));
}
assert.equal(getPendingApiMutationCount(), 0);
for (let attempt = 0; attempt < 20 && recoveryCalls === 0; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 20));
}
assert.equal(recoveryCalls, 1);
assert.equal(remoteDailyBriefs.get(`https://taskbox.test/v1${reconnectPath}`).currentActionTaskId, 'RECONNECTED');
assert.equal(getApiSyncState().nextRetryAt, null);
delete globalThis.__TASKBOX_API_RECOVERY_RETRY_MS__;

console.log('db visibility tests passed');
