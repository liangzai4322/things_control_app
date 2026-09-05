const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const dbPath = path.join(os.tmpdir(), `taskbox-hq-api-${process.pid}-${Date.now()}.sqlite`);
// Keep integration tests away from service ports; allow CI to inject a fixed
// port when needed, while using a high, per-process default locally.
const port = Number(process.env.TASKBOX_TEST_PORT || (30000 + ((Date.now() + process.pid) % 20000)));
const token = 'hq-integration-test-token';
const baselinePath = path.join(os.tmpdir(), `taskbox-five-system-baseline-${process.pid}-${Date.now()}.json`);
const hqReceiptCachePath = path.join(os.tmpdir(), `taskbox-hq-receipts-${process.pid}-${Date.now()}.json`);
fs.writeFileSync(baselinePath, JSON.stringify({
  schemaVersion: 'five-system-bootstrap-v1',
  dataset: { runId: 'integration-baseline', sourceReviewCount: 30 },
}), 'utf8');
fs.writeFileSync(hqReceiptCachePath, JSON.stringify({
  schemaVersion: 1,
  receipts: [
    { id: 'safe-health-receipt', intakeId: 'health-intake', systemId: 'health', reviewDate: '2026-07-30', status: 'processed', revision: 2,
      projection: { riskLevel: 'watch', inputGaps: ['sleepHours'], factRefs: ['health:obs:1'], evidenceRefs: ['review:1'], syncState: 'fresh', hidden: 'must-not-leak' }, data: { hidden: true } },
    { id: 'wrong-date', systemId: 'mission', reviewDate: '2026-07-29', status: 'processed' },
  ],
}), 'utf8');
let serverError = '';

function request(route, method = 'GET', payload = null) {
  return new Promise((resolve, reject) => {
    const body = payload === null ? null : Buffer.from(JSON.stringify(payload));
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: route,
      method,
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
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`${method} ${route} -> ${res.statusCode}: ${text}`));
          return;
        }
        resolve(text ? JSON.parse(text) : null);
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
    try {
      return await request('/health');
    } catch (error) {
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
    TASKBOX_ALLOWED_ORIGINS: 'http://127.0.0.1:4176',
    TASKBOX_FIVE_SYSTEM_BASELINE_PATH: baselinePath,
    HQ_DAILY_INTAKE_CACHE_FILE: hqReceiptCachePath,
  },
  stdio: ['ignore', 'ignore', 'pipe'],
});
child.stderr.on('data', (chunk) => { serverError += chunk.toString('utf8'); });

(async () => {
  try {
    const health = await waitForServer();
    if (!health.ok) throw new Error('health check failed');
    const serverBaseline = await request('/v1/system-baseline/current');
    if (serverBaseline.dataset?.runId !== 'integration-baseline') throw new Error('server baseline read failed');
    const hqCacheSnapshot = await request('/v1/hq/today?date=2026-07-30');
    if (hqCacheSnapshot.systemReceipts?.length !== 1 || hqCacheSnapshot.systemReceipts[0]?.systemId !== 'health'
      || hqCacheSnapshot.systemReceipts[0]?.riskLevel !== 'watch' || Object.hasOwn(hqCacheSnapshot.systemReceipts[0], 'data')
      || Object.hasOwn(hqCacheSnapshot.systemReceipts[0], 'projection')) {
      throw new Error('HQ daily intake cache projection was not safely merged');
    }
    const candidateBatch = await request('/v1/system-candidates/batch', 'POST', { candidates: [{
      candidateId: 'daily-review:2026-08-12:mission:test:1', systemId: 'mission', reviewDate: '2026-08-12',
      kind: 'alignment_deviation_candidate', statement: '方向偏离候选', authority: 'ai_summary',
      epistemicState: 'candidate_unvalidated', evidenceRefs: ['review:L1'], writesTargetSystem: false,
    }] });
    if (candidateBatch.created !== 1) throw new Error('system candidate batch create failed');
    const repeatedBatch = await request('/v1/system-candidates/batch', 'POST', { candidates: [{
      candidateId: 'daily-review:2026-08-12:mission:test:1', systemId: 'mission', reviewDate: '2026-08-12',
      kind: 'alignment_deviation_candidate', statement: '方向偏离候选', epistemicState: 'candidate_unvalidated', writesTargetSystem: false,
    }] });
    if (repeatedBatch.unchanged !== 1) throw new Error('system candidate batch is not idempotent');
    const missionCandidates = await request('/v1/system-candidates?systemId=mission&status=pending');
    if (missionCandidates.count !== 1 || missionCandidates.items[0].writesTargetSystem !== false) throw new Error('system candidate isolation failed');
    const keptCandidate = await request('/v1/system-candidates/daily-review%3A2026-08-12%3Amission%3Atest%3A1', 'PATCH', { status: 'kept' });
    if (keptCandidate.status !== 'kept') throw new Error('system candidate decision failed');
    const brief = await request('/v1/hq/daily-briefs/2026-07-30', 'POST', {
      stopDoing: ['停止无效切换'],
      continueDoing: ['先做唯一动作'],
      outcomes: { published: 1 },
      yesterdayClosure: { commitment: '完成 MVP', result: '完成', evidence: '线上页面' },
      reviewCompletedAt: '2026-07-30T14:00:00.000Z',
      reviewArtifacts: { markdownPath: 'D:/reviews/2026-07-30.md' },
      source: 'integration_test',
    });
    if (brief.reviewDate !== '2026-07-30' || brief.outcomes.published !== 1) {
      throw new Error('daily brief upsert mismatch');
    }
    await request('/v1/boxes', 'POST', {
      id: 'integration-brief-box',
      name: '集成测试盒',
      color: 'important',
      sortOrder: 0,
    });
    const firstCandidateTask = await request('/v1/tasks', 'POST', {
      id: 'integration-candidate-task-a',
      boxId: 'integration-brief-box',
      content: '解除集成测试项目阻塞',
      syncKey: 'hq-candidate:mainline:integration-project:risk',
      candidateDedupeKey: 'mainline:integration-project:risk',
      candidateSourceSystemId: 'mainline',
      candidateSourceRef: 'integration-project',
    });
    const repeatedCandidateTask = await request('/v1/tasks', 'POST', {
      id: 'integration-candidate-task-b',
      boxId: 'integration-brief-box',
      content: '重复提交不应创建副本',
      syncKey: 'hq-candidate:mainline:integration-project:risk',
    });
    if (firstCandidateTask.id !== repeatedCandidateTask.id
      || firstCandidateTask.candidateDedupeKey !== 'mainline:integration-project:risk') {
      throw new Error('candidate task syncKey idempotency mismatch');
    }
    await request('/v1/tasks', 'POST', {
      id: 'integration-primary-task',
      boxId: 'integration-brief-box',
      content: '集成测试主动作',
      isCompleted: false,
      sortOrder: 0,
    });
    const assignedBrief = await request('/v1/hq/daily-briefs/2026-07-30', 'POST', {
      primaryTaskId: 'integration-primary-task',
    });
    if (assignedBrief.primaryTaskId !== 'integration-primary-task'
      || assignedBrief.strategicCommitmentTaskId !== 'integration-primary-task'
      || assignedBrief.currentActionTaskId !== 'integration-primary-task'
      || assignedBrief.strategicCommitmentSnapshot?.content !== '集成测试主动作') {
      throw new Error('legacy daily brief assignment did not initialize P1 action semantics');
    }
    await request('/v1/tasks/integration-primary-task', 'PATCH', { content: '后续改名不应改写原始承诺' });
    const frozenSnapshot = await request('/v1/hq/today?date=2026-07-30');
    if (frozenSnapshot.actionState.strategicCommitment?.content !== '集成测试主动作') {
      throw new Error('strategic commitment snapshot was not frozen');
    }
    const activeSnapshot = await request('/v1/hq/today?date=2026-07-30');
    if (activeSnapshot.actionState.status !== 'active'
      || activeSnapshot.actionState.strategicCommitment?.id !== 'integration-primary-task'
      || activeSnapshot.actionState.currentAction?.id !== 'integration-primary-task') {
      throw new Error('active action seat mismatch');
    }
    await request('/v1/tasks/integration-primary-task', 'PATCH', {
      isCompleted: true,
      completedAt: '2026-07-30T14:32:00.000Z',
      completionReceipt: {
        version: 1,
        sourceTaskId: 'integration-primary-task',
        content: '集成测试主动作',
        note: '线上完成证据',
        completedAt: '2026-07-30T14:32:00.000Z',
      },
    });
    const completedSnapshot = await request('/v1/hq/today?date=2026-07-30');
    if (completedSnapshot.actionState.status !== 'awaiting_candidate'
      || completedSnapshot.actionState.currentAction !== null
      || completedSnapshot.actionState.outcomes[0]?.completionReceipt?.note !== '线上完成证据') {
      throw new Error('completed task did not leave the action seat and enter outcomes');
    }
    await request('/v1/tasks', 'POST', {
      id: 'integration-handoff-task',
      boxId: 'integration-brief-box',
      content: '集成测试接棒动作',
      isCompleted: false,
      sortOrder: 1,
    });
    await request('/v1/hq/daily-briefs/2026-07-30', 'POST', {
      primaryTaskId: 'integration-primary-task',
      strategicCommitmentTaskId: 'integration-primary-task',
      strategicCommitmentSnapshot: {
        taskId: 'integration-primary-task',
        content: '最初的战略承诺',
        committedAt: '2026-07-30T08:00:00.000Z',
      },
      currentActionTaskId: 'integration-handoff-task',
    });
    const handoffSnapshot = await request('/v1/hq/today?date=2026-07-30');
    if (handoffSnapshot.actionState.status !== 'active'
      || handoffSnapshot.actionState.strategicCommitment?.content !== '集成测试主动作'
      || handoffSnapshot.actionState.currentAction?.id !== 'integration-handoff-task') {
      throw new Error('handoff action overwrote the original commitment or failed to occupy the seat');
    }
    const apiCompleted = await request('/v1/tasks/integration-handoff-task', 'PATCH', { isCompleted: true });
    if (!apiCompleted.completedAt
      || apiCompleted.completionReceipt?.sourceTaskId !== 'integration-handoff-task'
      || apiCompleted.completionReceipt?.source !== 'taskbox-api') {
      throw new Error('api-only completion did not receive a completion time and receipt');
    }
    const midnightOutcome = await request('/v1/tasks', 'POST', {
      id: 'integration-midnight-outcome',
      boxId: 'integration-brief-box',
      content: '本地凌晨完成事项',
      isCompleted: true,
      completedAt: '2026-07-29T16:30:00.000Z',
      sortOrder: 2,
    });
    if (midnightOutcome.completionReceipt?.sourceTaskId !== 'integration-midnight-outcome') {
      throw new Error('completed task creation did not receive a receipt');
    }
    const midnightSnapshot = await request('/v1/hq/today?date=2026-07-30');
    if (!midnightSnapshot.actionState.outcomes.some((task) => task.id === 'integration-midnight-outcome')) {
      throw new Error('UTC+8 early-morning completion was omitted from today outcomes');
    }
    const midnightDailySnapshot = await request('/v1/daily-snapshot?date=2026-07-30');
    if (!midnightDailySnapshot.completedTasks.some((task) => task.id === 'integration-midnight-outcome')) {
      throw new Error('UTC+8 early-morning completion was omitted from daily evidence');
    }
    const seatClearedBrief = await request('/v1/hq/daily-briefs/2026-07-30', 'POST', {
      currentActionTaskId: null,
    });
    if (seatClearedBrief.primaryTaskId !== 'integration-primary-task'
      || seatClearedBrief.strategicCommitmentTaskId !== 'integration-primary-task'
      || seatClearedBrief.currentActionTaskId !== null
      || seatClearedBrief.strategicCommitmentSnapshot?.content !== assignedBrief.strategicCommitmentSnapshot?.content) {
      throw new Error('clearing only the action seat also cleared the original commitment');
    }
    const fullP1ClearedBrief = await request('/v1/hq/daily-briefs/2026-07-30', 'POST', {
      primaryTaskId: null,
      strategicCommitmentTaskId: null,
      strategicCommitmentSnapshot: null,
      currentActionTaskId: null,
    });
    if (fullP1ClearedBrief.primaryTaskId !== null
      || fullP1ClearedBrief.strategicCommitmentTaskId !== null
      || fullP1ClearedBrief.currentActionTaskId !== null
      || fullP1ClearedBrief.strategicCommitmentSnapshot !== null) {
      throw new Error('full P1 daily brief clear mismatch');
    }
    await request('/v1/hq/daily-briefs/2026-07-30', 'POST', {
      primaryTaskId: 'integration-primary-task',
    });
    const pairedNullClearedBrief = await request('/v1/hq/daily-briefs/2026-07-30', 'POST', {
      primaryTaskId: null,
      currentActionTaskId: null,
    });
    if (pairedNullClearedBrief.primaryTaskId !== null
      || pairedNullClearedBrief.strategicCommitmentTaskId !== null
      || pairedNullClearedBrief.currentActionTaskId !== null
      || pairedNullClearedBrief.strategicCommitmentSnapshot !== null) {
      throw new Error('paired primary/action null did not honor the P0 full-clear contract');
    }
    await request('/v1/hq/daily-briefs/2026-07-30', 'POST', {
      primaryTaskId: 'integration-primary-task',
    });
    const authoritativeNullBrief = await request('/v1/hq/daily-briefs/2026-07-30', 'POST', {
      primaryTaskId: null,
      currentActionTaskId: 'integration-handoff-task',
    });
    if (authoritativeNullBrief.primaryTaskId !== null
      || authoritativeNullBrief.strategicCommitmentTaskId !== null
      || authoritativeNullBrief.currentActionTaskId !== null
      || authoritativeNullBrief.strategicCommitmentSnapshot !== null) {
      throw new Error('explicit primary null was not authoritative over companion P1 fields');
    }
    await request('/v1/hq/daily-briefs/2026-07-30', 'POST', {
      primaryTaskId: 'integration-primary-task',
    });
    const legacyClearedBrief = await request('/v1/hq/daily-briefs/2026-07-30', 'POST', {
      primaryTaskId: null,
    });
    if (legacyClearedBrief.primaryTaskId !== null
      || legacyClearedBrief.strategicCommitmentTaskId !== null
      || legacyClearedBrief.currentActionTaskId !== null
      || legacyClearedBrief.strategicCommitmentSnapshot !== null) {
      throw new Error('legacy daily brief primary clear mismatch');
    }
    const fencedNew = await request('/v1/hq/daily-briefs/2026-07-31', 'POST', {
      primaryTaskId: 'integration-primary-task',
      currentActionTaskId: 'integration-handoff-task',
      _syncMutation: {
        clientId: 'tab-new', mutationId: 'new',
        generation: '0000000002000|00000001|new', issuedAt: '2026-07-31T00:00:02.000Z',
      },
    });
    if (fencedNew.primaryTaskId !== 'integration-primary-task'
      || fencedNew.currentActionTaskId !== 'integration-handoff-task') {
      throw new Error('new fenced daily brief write mismatch');
    }
    const delayedOld = await request('/v1/hq/daily-briefs/2026-07-31', 'POST', {
      primaryTaskId: null,
      currentActionTaskId: null,
      _syncMutation: {
        clientId: 'tab-old', mutationId: 'old',
        generation: '0000000001000|00000001|old', issuedAt: '2026-07-31T00:00:01.000Z',
      },
    });
    if (delayedOld.primaryTaskId !== 'integration-primary-task'
      || delayedOld.currentActionTaskId !== 'integration-handoff-task'
      || delayedOld._syncMutation?.mutationId !== 'new') {
      throw new Error('delayed OLD daily brief mutation crossed the monotonic fence');
    }
    const fencedNull = await request('/v1/hq/daily-briefs/2026-07-31', 'POST', {
      primaryTaskId: null,
      currentActionTaskId: 'integration-handoff-task',
      _syncMutation: {
        clientId: 'tab-new', mutationId: 'newer-null',
        generation: '0000000003000|00000001|newer-null', issuedAt: '2026-07-31T00:00:03.000Z',
      },
    });
    if (fencedNull.primaryTaskId !== null
      || fencedNull.strategicCommitmentTaskId !== null
      || fencedNull.currentActionTaskId !== null
      || fencedNull.strategicCommitmentSnapshot !== null) {
      throw new Error('fenced primary null did not preserve the P0 authoritative-clear contract');
    }
    const candidateBrief = await request('/v1/hq/daily-briefs/2026-08-01', 'POST', {
      primaryTaskId: 'integration-primary-task',
      currentActionTaskId: null,
      candidateState: {
        dismissals: {
          'task:integration-handoff-task': {
            reason: 'manual_skip',
            at: '2026-08-01T01:00:00.000Z',
            until: '2026-08-01T05:00:00.000Z',
          },
        },
        accepted: [],
      },
    });
    if (candidateBrief.candidateState?.dismissals?.['task:integration-handoff-task']?.reason !== 'manual_skip') {
      throw new Error('P2 candidate state did not round-trip through daily brief raw JSON');
    }
    await request('/v1/hq/decisions', 'POST', {
      id: 'integration-decision',
      title: '集成测试决策',
      status: 'open',
    });
    const snapshot = await request('/v1/hq/today?date=2026-07-30');
    if (!snapshot.decisions.some((item) => item.id === 'integration-decision')) {
      throw new Error('decision missing from HQ snapshot');
    }
    if (snapshot.review.status !== 'synced' || snapshot.review.completionRate !== 100) {
      throw new Error('review loop missing from HQ snapshot');
    }
    const reviewStatus = await request('/v1/hq/review-status?date=2026-07-30&days=7');
    if (reviewStatus.completedCount !== 1 || reviewStatus.history.length !== 7) {
      throw new Error('review history aggregation mismatch');
    }
    const weekly = await request('/v1/hq/periods/week/2026-07-27_to_2026-08-02', 'POST', {
      startDate: '2026-07-27',
      endDate: '2026-08-02',
      status: 'synced',
      verdict: '用一个实验验证主瓶颈',
      experiment: { action: '发布周期面板', successThreshold: '线上可访问' },
      source: 'weekly_review',
      completedAt: '2026-08-02T12:00:00.000Z',
    });
    if (weekly.periodType !== 'week' || weekly.experiment.action !== '发布周期面板') {
      throw new Error('weekly review upsert mismatch');
    }
    const weeklySnapshot = await request('/v1/hq/periods/week/current?date=2026-07-30');
    if (weeklySnapshot.periodKey !== '2026-07-27_to_2026-08-02' || weeklySnapshot.review.status !== 'synced') {
      throw new Error('weekly period snapshot mismatch');
    }
    await request('/v1/hq/periods/week/2026-07-20_to_2026-07-26', 'POST', {
      startDate: '2026-07-20', endDate: '2026-07-26', status: 'synced', verdict: '上周裁决', source: 'weekly_review',
    });
    const previousWeekly = await request('/v1/hq/periods/week/current?date=2026-07-30&offset=-1');
    if (previousWeekly.periodKey !== '2026-07-20_to_2026-07-26' || previousWeekly.review.verdict !== '上周裁决') {
      throw new Error('previous weekly offset mismatch');
    }
    await request('/v1/hq/periods/month/2026-07', 'POST', {
      startDate: '2026-07-01',
      endDate: '2026-07-31',
      status: 'synced',
      verdict: '集中资源完成可视化成果物',
      goals: [{ title: '发布人生参谋部' }],
      source: 'monthly_review',
    });
    const monthlySnapshot = await request('/v1/hq/periods/month/current?date=2026-07-30');
    if (monthlySnapshot.review.goals[0].title !== '发布人生参谋部') {
      throw new Error('monthly period snapshot mismatch');
    }
    await request('/v1/hq/periods/month/2026-06', 'POST', {
      startDate: '2026-06-01', endDate: '2026-06-30', status: 'synced', verdict: '上月裁决', source: 'monthly_review',
    });
    const previousMonthly = await request('/v1/hq/periods/month/current?date=2026-07-30&offset=-1');
    if (previousMonthly.periodKey !== '2026-06' || previousMonthly.review.verdict !== '上月裁决') {
      throw new Error('previous monthly offset mismatch');
    }
    const weeklyList = await request('/v1/hq/periods?type=week&limit=3');
    if (weeklyList.length !== 2) throw new Error('period review list mismatch');
    await request('/v1/hq/decisions/integration-decision', 'PATCH', { status: 'resolved' });
    const openDecisions = await request('/v1/hq/decisions?status=open');
    if (openDecisions.some((item) => item.id === 'integration-decision')) {
      throw new Error('resolved decision remained open');
    }
    await request('/v1/hq/decisions/integration-decision', 'DELETE');
    await request('/v1/hq/periods/week/2026-07-27_to_2026-08-02', 'DELETE');
    await request('/v1/hq/periods/week/2026-07-20_to_2026-07-26', 'DELETE');
    await request('/v1/hq/periods/month/2026-07', 'DELETE');
    await request('/v1/hq/periods/month/2026-06', 'DELETE');
    const evidence = await request('/v1/daily-snapshot?date=2026-07-30');
    if (evidence.reviewDate !== '2026-07-30') throw new Error('daily snapshot date mismatch');
    console.log('hq api integration tests passed');
  } catch (error) {
    console.error(error.stack || error.message);
    if (serverError) console.error(serverError);
    process.exitCode = 1;
  } finally {
    child.kill();
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.rmSync(`${dbPath}${suffix}`, { force: true }); } catch {}
    }
    try { fs.rmSync(baselinePath, { force: true }); } catch {}
  }
})();
