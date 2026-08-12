import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildHqActionCandidates, dismissHqCandidate, scoreHqCandidate } from '../js/hq-candidates.js';

const now = new Date('2026-08-09T04:00:00.000Z');
const strong = {
  outcomeValue: 5, strategicFit: 5, leverage: 4, timeWindow: 4,
  anomalyRelief: 0, confidence: 5, effort: 1, switchCost: 0, riskBlock: 0,
};
assert.equal(scoreHqCandidate(strong), 82);

const tasks = [
  { id: 'best', content: '发布报价页并收集首轮反馈', boxId: 'box', mainlineId: 'active', syncKey: 'best-key', visibleAfter: '2026-08-09T00:00:00.000Z', updatedAt: '2026-08-09T03:00:00.000Z', durationMinutes: 45, roiInputs: strong },
  { id: 'second', content: '修复支付阻塞', note: '完成标准：支付链路恢复', boxId: 'box', mainlineId: 'active', syncKey: 'second-key', visibleAfter: '2026-08-09T00:00:00.000Z', updatedAt: '2026-08-09T02:00:00.000Z', roiInputs: { ...strong, outcomeValue: 4 } },
  { id: 'paused', content: '暂停项目动作', boxId: 'box', mainlineId: 'paused', syncKey: 'paused-key', visibleAfter: '2026-08-09T00:00:00.000Z', roiInputs: strong },
  { id: 'future', content: '未来才释放', boxId: 'box', syncKey: 'future-key', visibleAfter: '2026-08-10T00:00:00.000Z', roiInputs: strong },
];
const mainlines = [{ id: 'active', status: 'active' }, { id: 'paused', status: 'paused' }];
const brief = { currentActionTaskId: null, maintenanceTaskIds: [], candidateState: { dismissals: {} } };
const candidates = buildHqActionCandidates({ tasks, mainlines, brief, reviewDate: '2026-08-09', now });
assert.deepEqual(candidates.map((item) => item.taskId), ['best', 'second']);
assert.equal(candidates[0].dedupeKey, 'task:best-key');
assert.match(candidates[0].completionCriteria, /留下回执/);
assert.equal(candidates[1].completionCriteria, '支付链路恢复');

const dismissed = dismissHqCandidate(brief.candidateState, candidates[0], now);
const afterSkip = buildHqActionCandidates({ tasks, mainlines, brief: { ...brief, candidateState: dismissed }, reviewDate: '2026-08-09', now });
assert.deepEqual(afterSkip.map((item) => item.taskId), ['second']);
const afterCooldown = buildHqActionCandidates({ tasks, mainlines, brief: { ...brief, candidateState: dismissed }, reviewDate: '2026-08-09', now: new Date('2026-08-09T09:00:00.000Z') });
assert.equal(afterCooldown[0].taskId, 'best');

const nativeProjectCandidates = buildHqActionCandidates({
  tasks: [],
  mainlines,
  projects: [{
    id: 'project-needs-action', name: '交易增长', status: 'active', health: 'needs_action',
    updatedAt: '2026-08-09T03:30:00.000Z',
  }],
  brief,
  reviewDate: '2026-08-09',
  now,
});
assert.equal(nativeProjectCandidates.length, 1);
assert.equal(nativeProjectCandidates[0].sourceSystemId, 'mainline');
assert.equal(nativeProjectCandidates[0].taskId, null);
assert.equal(nativeProjectCandidates[0].dedupeKey, 'mainline:project-needs-action:project_next');
assert.ok(nativeProjectCandidates[0].score >= 55);

const convertedProjectCandidates = buildHqActionCandidates({
  tasks: [{
    id: 'converted-task', content: '为交易增长定义并启动下一步', boxId: 'box',
    syncKey: 'hq-candidate:mainline:project-needs-action:project_next',
    candidateDedupeKey: 'mainline:project-needs-action:project_next',
  }],
  mainlines,
  projects: [{ id: 'project-needs-action', name: '交易增长', status: 'active', health: 'needs_action' }],
  brief,
  reviewDate: '2026-08-09',
  now,
});
assert.equal(convertedProjectCandidates.some((item) => item.sourceSystemId === 'mainline'), false);

const hqPageSource = fs.readFileSync(new URL('../js/hq-page.js', import.meta.url), 'utf8');
const confirmationStart = hqPageSource.indexOf("app.querySelectorAll('[data-confirm-candidate]')");
const confirmationEnd = hqPageSource.indexOf("app.querySelectorAll('[data-skip-candidate]')", confirmationStart);
const confirmationBlock = hqPageSource.slice(confirmationStart, confirmationEnd);
assert.ok(confirmationStart >= 0 && confirmationEnd > confirmationStart);
assert.match(confirmationBlock, /\/hq\/proposals/);
assert.match(confirmationBlock, /sourceAuthority:\s*'explicit_user'/);
assert.match(confirmationBlock, /\/promote/);
assert.doesNotMatch(confirmationBlock, /addTask\s*\(/);
assert.doesNotMatch(confirmationBlock, /updateTask\s*\(/);

console.log('hq candidate tests passed');
