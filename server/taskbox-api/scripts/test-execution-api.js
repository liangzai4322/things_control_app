const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const stamp = `${process.pid}-${Date.now()}`;
const dbPath = path.join(os.tmpdir(), `taskbox-execution-${stamp}.sqlite`);
const disableFile = path.join(os.tmpdir(), `taskbox-execution-${stamp}.disabled`);
const port = 4100 + (process.pid % 200);
const adminToken = 'taskbox-admin-test-token';
const executionToken = 'execution-system-test-token';
const explicitGrant = 'standing-execution-taskbox-normal-2026-09-02';
let stderr = '';

function request(route, { method = 'GET', payload = null, token = executionToken, headers = {}, expected = 200 } = {}) {
  return new Promise((resolve, reject) => {
    const body = payload == null ? null : Buffer.from(JSON.stringify(payload));
    const req = http.request({
      hostname: '127.0.0.1', port, path: route, method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(body ? { 'Content-Length': body.length } : {}),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        const data = raw ? JSON.parse(raw) : null;
        if (res.statusCode !== expected) return reject(new Error(`${method} ${route} -> ${res.statusCode}: ${raw}`));
        resolve({ data, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const operation = (overrides = {}) => ({
  contractVersion: '2026-09-02', sourceSystem: 'execution',
  requestId: `request-${stamp}-${Math.random()}`, idempotencyKey: `operation-${stamp}-${Math.random()}`,
  operation: 'create', reason: '执行系统合同测试',
  authorizationSource: 'explicit_user', authorizationEvidence: { referenceId: explicitGrant },
  requestedMutation: {}, ...overrides,
});

const child = spawn(process.execPath, [path.join(root, 'src', 'server.js')], {
  cwd: root,
  env: {
    ...process.env,
    TASKBOX_DB_PATH: dbPath, TASKBOX_API_PORT: String(port), TASKBOX_API_TOKEN: adminToken,
    EXECUTION_SYSTEM_API_ENABLED: '1', EXECUTION_SYSTEM_API_TOKEN: executionToken,
    EXECUTION_SYSTEM_API_DISABLE_FILE: disableFile,
    EXECUTION_SYSTEM_API_SCOPES: 'tasks:read,tasks:create,tasks:update,tasks:schedule,tasks:progress,tasks:evidence,tasks:complete,tasks:delete,tasks:audit',
    EXECUTION_SYSTEM_EXPLICIT_GRANT_IDS: explicitGrant,
  },
  stdio: ['ignore', 'ignore', 'pipe'],
});
child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });

async function waitForServer() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try { return await request('/v1/execution/capabilities'); } catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
  }
  throw new Error(`execution API did not start: ${stderr}`);
}

(async () => {
  try {
    const capabilities = (await waitForServer()).data;
    if (!capabilities.operations.includes('complete') || capabilities.hardDelete !== false) throw new Error('capability contract mismatch');

    await request('/v1/taskbox', { token: executionToken, expected: 401 });
    await request('/v1/execution/capabilities', { token: adminToken, expected: 401 });
    await request('/v1/boxes', {
      method: 'POST', token: adminToken, expected: 201,
      payload: { id: 'execution-task-box', name: '执行盒', color: 'important', boxType: 'task' },
    });

    const createPayload = operation({
      requestId: 'execution-create-1', idempotencyKey: 'execution-create-1', operation: 'create',
      requestedMutation: { task: { content: '完成执行系统生产合同', boxId: 'execution-task-box', executionMode: 'ai' } },
    });
    const created = await request('/v1/execution/task-operations', { method: 'POST', payload: createPayload, expected: 201 });
    const replayed = await request('/v1/execution/task-operations', { method: 'POST', payload: createPayload, expected: 201 });
    if (created.data.task.id !== replayed.data.task.id || created.data.task.revision !== 1) throw new Error('create idempotency failed');
    const taskId = created.data.task.id;

    await request('/v1/execution/task-operations', {
      method: 'POST', expected: 409,
      payload: { ...createPayload, requestedMutation: { task: { content: '不同内容', boxId: 'execution-task-box' } } },
    });
    await request('/v1/execution/task-operations', {
      method: 'POST', expected: 409,
      payload: operation({ requestId: 'duplicate-create', idempotencyKey: 'duplicate-create', operation: 'create', requestedMutation: createPayload.requestedMutation }),
    });

    const approvedProposal = (await request('/v1/hq/proposals', {
      method: 'POST', token: adminToken, expected: 201,
      payload: { proposalType: 'daily_action_proposal', sourceAuthority: 'explicit_user', title: '执行已批准 HQ 行动',
        idempotencyKey: 'execution-approved-proposal', shadowMode: false,
        taskSpec: { content: '执行已批准 HQ 行动', boxId: 'execution-task-box' } },
    })).data;
    const proposalCreated = await request('/v1/execution/task-operations', {
      method: 'POST', expected: 201,
      payload: operation({ requestId: 'proposal-create', idempotencyKey: 'proposal-create', operation: 'create',
        authorizationSource: 'approved_hq_proposal', authorizationEvidence: { proposalId: approvedProposal.decisionId },
        requestedMutation: { task: { content: '执行已批准 HQ 行动', boxId: 'execution-task-box' } } }),
    });
    if (proposalCreated.data.task.proposalDecisionId == null) throw new Error('approved HQ proposal was not linked');

    const scheduledPayload = operation({
      requestId: 'execution-schedule-1', idempotencyKey: 'execution-schedule-1', operation: 'schedule', taskId,
      requestedMutation: { scheduledAt: '2026-09-02T10:00:00.000Z', dueDate: '2026-09-02T12:00:00.000Z' },
    });
    const scheduled = await request('/v1/execution/task-operations', {
      method: 'POST', payload: scheduledPayload, headers: { 'If-Match': '"task-revision-1"' },
    });
    if (scheduled.data.task.revision !== 2 || scheduled.headers.etag !== '"task-revision-2"') throw new Error('revision/ETag did not advance');
    await request('/v1/execution/task-operations', {
      method: 'POST', expected: 409, headers: { 'If-Match': '"task-revision-1"' },
      payload: operation({ requestId: 'stale-update', idempotencyKey: 'stale-update', operation: 'update', taskId, requestedMutation: { note: 'stale' } }),
    });

    let revision = 2;
    async function mutate(name, operationName, requestedMutation, extra = {}) {
      const response = await request('/v1/execution/task-operations', {
        method: 'POST', headers: { 'If-Match': `"task-revision-${revision}"` },
        payload: operation({ requestId: name, idempotencyKey: name, operation: operationName, taskId, requestedMutation, ...extra }),
      });
      revision += 1;
      if (response.data.task.revision !== revision) throw new Error(`${operationName} revision mismatch`);
      return response.data.task;
    }

    await mutate('progress-1', 'record_progress', { progress: 40, note: '完成接口主体' }, { evidenceRef: 'evidence:progress:1' });
    await mutate('blocker-1', 'record_blocker', { blocker: '等待联调' });
    await mutate('clear-blocker-1', 'clear_blocker', {});
    await mutate('evidence-1', 'append_evidence', {}, { evidenceRef: { id: 'evidence-1', ref: 'artifact:test' } });
    const completed = await mutate('complete-1', 'complete', { note: '合同自动化通过' }, { evidenceRef: 'evidence:complete:1' });
    if (!completed.isCompleted || !completed.completionReceipt) throw new Error('completion receipt missing');
    await mutate('reopen-1', 'reopen', {});
    const deleted = await mutate('delete-1', 'soft_delete', {});
    if (!deleted.deleted) throw new Error('soft delete failed');
    const restored = await mutate('restore-1', 'restore', {});
    if (restored.deleted) throw new Error('restore failed');

    await request('/v1/execution/task-operations', {
      method: 'POST', expected: 400, headers: { 'If-Match': `"task-revision-${revision}"` },
      payload: operation({ requestId: 'hard-delete', idempotencyKey: 'hard-delete', operation: 'hard_delete', taskId }),
    });
    await request('/v1/execution/task-operations', {
      method: 'POST', expected: 403, headers: { 'If-Match': `"task-revision-${revision}"` },
      payload: operation({ requestId: 'candidate-write', idempotencyKey: 'candidate-write', operation: 'update', taskId,
        authorizationSource: 'ai_derived', authorizationEvidence: { referenceId: 'candidate' }, requestedMutation: { note: '不允许' } }),
    });

    await request('/v1/hq/review-rules', {
      method: 'POST', token: adminToken, expected: 201,
      payload: { ruleId: 'execution-schedule-rule', source: 'standing_rule', reasonCode: 'approved_schedule', scopeKey: 'execution.task.write',
        match: { operations: ['schedule'], taskIds: [taskId], fields: ['scheduledAt'] } },
    });
    const standing = operation({
      requestId: 'standing-schedule', idempotencyKey: 'standing-schedule', operation: 'schedule', taskId,
      authorizationSource: 'standing_rule', authorizationEvidence: { ruleId: 'execution-schedule-rule' },
      requestedMutation: { scheduledAt: '2026-09-03T02:00:00.000Z' },
    });
    const standingResult = await request('/v1/execution/task-operations', {
      method: 'POST', payload: standing, headers: { 'If-Match': `"task-revision-${revision}"` },
    });
    revision += 1;
    if (standingResult.data.task.revision !== revision) throw new Error('standing rule write failed');

    const audit = (await request(`/v1/execution/audit?taskId=${encodeURIComponent(taskId)}`)).data;
    if (!audit.items.some((item) => item.outcome === 'applied') || !audit.items.some((item) => item.outcome === 'rejected')) {
      throw new Error('execution audit trail incomplete');
    }

    fs.writeFileSync(disableFile, 'disabled\n');
    await request('/v1/execution/capabilities', { expected: 503 });
    console.log('execution system API tests passed');
  } finally {
    child.kill('SIGTERM');
    for (const file of [disableFile, dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      try { fs.rmSync(file, { force: true }); } catch {}
    }
  }
})().catch((failure) => {
  console.error(failure);
  process.exitCode = 1;
});
