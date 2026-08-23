const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const dbPath = path.join(os.tmpdir(), `taskbox-hq-proposals-${process.pid}-${Date.now()}.sqlite`);
const port = 3700 + (process.pid % 200);
const token = 'hq-proposal-test-token';
let serverError = '';

function request(route, method = 'GET', payload = null, expectedStatus = 200) {
  return new Promise((resolve, reject) => {
    const body = payload === null ? null : Buffer.from(JSON.stringify(payload));
    const req = http.request({
      hostname: '127.0.0.1', port, path: route, method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(body ? { 'Content-Length': body.length } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        const data = text ? JSON.parse(text) : null;
        if (res.statusCode !== expectedStatus) {
          reject(new Error(`${method} ${route} -> ${res.statusCode}: ${text}`));
          return;
        }
        resolve(data);
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function waitForServer() {
  let lastError;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { return await request('/health'); } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw lastError;
}

const child = spawn(process.execPath, [path.join(root, 'src', 'server.js')], {
  cwd: root,
  env: {
    ...process.env,
    TASKBOX_DB_PATH: dbPath,
    TASKBOX_API_PORT: String(port),
    TASKBOX_API_TOKEN: token,
    HQ_PROPOSAL_PROMOTION_ENABLED: '1',
  },
  stdio: ['ignore', 'ignore', 'pipe'],
});
child.stderr.on('data', (chunk) => { serverError += chunk.toString('utf8'); });

(async () => {
  try {
    await waitForServer();
    await request('/v1/boxes', 'POST', { id: 'proposal-box', name: '重要盒', color: 'important' }, 201);
    await request('/v1/tasks', 'POST', { content: '失效盒引用', boxId: 'missing-box' }, 409);
    await request('/v1/hq/daily-briefs/2026-08-10', 'POST', { primaryTaskId: 'missing-task' }, 409);
    await request('/v1/hq/proposals', 'POST', {
      proposalType: 'daily_action_proposal', sourceAuthority: 'explicit_user',
      title: '失效任务引用', idempotencyKey: 'missing-existing-task', existingTaskId: 'missing-task',
    }, 409);

    const dailyInput = {
      proposalType: 'daily_action_proposal',
      sourceAuthority: 'explicit_user',
      title: '发布 P4 审批闭环',
      idempotencyKey: 'daily-review:2026-08-09:2026-08-10:primary',
      content: { role: 'primary', plannedFromReviewDate: '2026-08-09' },
      evidence: { markdownDate: '2026-08-09' },
      sourceRef: { type: 'daily_review', reviewDate: '2026-08-09', briefDate: '2026-08-10' },
      taskSpec: {
        boxId: 'proposal-box', content: '发布 P4 审批闭环', role: 'primary',
        commitmentDate: '2026-08-10', scheduledAt: '2026-08-10T00:00:00+08:00',
      },
      actor: 'proposal_test',
    };
    const approved = await request('/v1/hq/proposals', 'POST', dailyInput, 201);
    if (approved.status !== 'approved' || approved.revision !== 1 || !approved.decisionId) {
      throw new Error('explicit daily proposal did not enter approved revision 1');
    }
    const repeated = await request('/v1/hq/proposals', 'POST', dailyInput);
    if (repeated.decisionId !== approved.decisionId || repeated.revision !== 1) {
      throw new Error('same proposal was not idempotent');
    }
    const revised = await request('/v1/hq/proposals', 'POST', {
      ...dailyInput,
      title: '发布 P4 审批闭环并留下验证证据',
      taskSpec: { ...dailyInput.taskSpec, content: '发布 P4 审批闭环并留下验证证据' },
    });
    if (revised.decisionId !== approved.decisionId || revised.revision !== 2) {
      throw new Error('changed proposal did not create a revision on the same decision');
    }
    const promoted = await request(`/v1/hq/proposals/${approved.decisionId}/promote`, 'POST', {
      actor: 'proposal_test', shadowMode: false,
    });
    if (promoted.status !== 'promoted' || !promoted.taskId) {
      throw new Error('approved daily proposal did not promote to TaskBox');
    }
    const promotedAgain = await request(`/v1/hq/proposals/${approved.decisionId}/promote`, 'POST', {
      actor: 'proposal_test', shadowMode: false,
    });
    if (promotedAgain.taskId !== promoted.taskId) throw new Error('promotion was not idempotent');

    const aiDaily = await request('/v1/hq/proposals', 'POST', {
      ...dailyInput,
      sourceAuthority: 'ai_derived',
      title: 'AI 建议动作',
      idempotencyKey: 'daily-review:2026-08-09:2026-08-10:maintenance-1',
      taskSpec: { ...dailyInput.taskSpec, content: 'AI 建议动作', role: 'maintenance' },
    }, 201);
    if (aiDaily.status !== 'proposed') throw new Error('AI proposal bypassed approval');
    await request(`/v1/hq/proposals/${aiDaily.decisionId}/promote`, 'POST', { actor: 'proposal_test' }, 409);
    const acceptedAi = await request(`/v1/hq/proposals/${aiDaily.decisionId}/approve`, 'POST', {
      actor: 'user', note: '确认执行',
    });
    if (acceptedAi.status !== 'approved') throw new Error('AI proposal approval failed');
    const promotedAi = await request(`/v1/hq/proposals/${aiDaily.decisionId}/promote`, 'POST', {
      actor: 'user', shadowMode: false,
    });
    if (promotedAi.status !== 'promoted' || !promotedAi.taskId) {
      throw new Error('approved AI-origin proposal did not promote after explicit approval');
    }

    const weekly = await request('/v1/hq/proposals', 'POST', {
      proposalType: 'weekly_experiment_proposal', sourceAuthority: 'ai_derived',
      title: '本周只验证一个实验', idempotencyKey: 'weekly-experiment:2026-08-03_to_2026-08-09',
      content: { action: '发布审批队列', successThreshold: '连续三次无重复提案' },
      evidence: { bottleneck: { title: '人工搬运' } },
      sourceRef: { type: 'weekly_review', periodKey: '2026-08-03_to_2026-08-09' },
    }, 201);
    await request(`/v1/hq/proposals/${weekly.decisionId}/approve`, 'POST', { actor: 'user' });
    await request(`/v1/hq/proposals/${weekly.decisionId}/promote`, 'POST', { actor: 'user' }, 409);

    const monthly = await request('/v1/hq/proposals', 'POST', {
      proposalType: 'monthly_bet_proposal', sourceAuthority: 'ai_derived',
      title: '资源押注审批闭环', idempotencyKey: 'monthly-bet:2026-08',
      content: { decision: '资源押注审批闭环' },
      evidence: { evidenceStatus: 'provisional', inputCoverage: { percentage: 60 } },
      sourceRef: { type: 'monthly_review', periodKey: '2026-08' },
    }, 201);
    await request(`/v1/hq/proposals/${monthly.decisionId}/approve`, 'POST', { actor: 'user' }, 409);

    const deferred = await request(`/v1/hq/proposals/${weekly.decisionId}/defer`, 'POST', {
      actor: 'user', deferUntil: '2026-08-16', note: '下周再评估',
    });
    if (deferred.status !== 'deferred' || deferred.deferUntil !== '2026-08-16') {
      throw new Error('proposal defer failed');
    }
    const notRevived = await request('/v1/hq/proposals', 'POST', {
      proposalType: 'weekly_experiment_proposal', sourceAuthority: 'ai_derived',
      title: '改写也不应复活', idempotencyKey: 'weekly-experiment:2026-08-03_to_2026-08-09',
      content: { action: '改写也不应复活' },
      sourceRef: { type: 'weekly_review', periodKey: '2026-08-03_to_2026-08-09' },
    });
    if (notRevived.status !== 'deferred' || notRevived.revision !== 2) {
      throw new Error('deferred proposal was revived or revision was not recorded');
    }

    const rejected = await request(`/v1/hq/proposals/${monthly.decisionId}/reject`, 'POST', {
      actor: 'user', note: '证据不足',
    });
    if (rejected.status !== 'rejected') throw new Error('proposal rejection failed');
    const restored = await request(`/v1/hq/proposals/${monthly.decisionId}/restore`, 'POST', { actor: 'user' });
    if (restored.status !== 'proposed') throw new Error('rejected proposal did not restore its previous status');
    const rejectedAgain = await request(`/v1/hq/proposals/${monthly.decisionId}/reject`, 'POST', { actor: 'user' });
    if (rejectedAgain.status !== 'rejected') throw new Error('restored proposal could not be rejected again');

    const queue = await request('/v1/hq/proposals?status=proposed,approved,deferred&limit=20');
    if (!queue.items.some((item) => item.decisionId === weekly.decisionId)
      || queue.items.some((item) => item.decisionId === monthly.decisionId)) {
      throw new Error('proposal queue filtering mismatch');
    }
    const detail = await request(`/v1/hq/proposals/${approved.decisionId}`);
    if (detail.auditTrail.length < 3 || detail.revision !== 2) {
      throw new Error('proposal audit trail or revision detail missing');
    }
    console.log('hq proposal integration tests passed');
  } catch (error) {
    console.error(error.stack || error.message);
    if (serverError) console.error(serverError);
    process.exitCode = 1;
  } finally {
    child.kill();
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.rmSync(`${dbPath}${suffix}`, { force: true }); } catch {}
    }
  }
})();
