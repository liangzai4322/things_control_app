import assert from 'node:assert/strict';
import {
  buildHqProjectResourceBias,
  buildHqSystemEfficiency,
  buildHqWeeklyBet,
} from '../js/hq-resource-governance.js';

const bet = buildHqWeeklyBet([{
  proposalType: 'monthly_bet_proposal', status: 'approved', title: '发布资源驾驶舱', decisionId: 'bet-1',
  content: { successThreshold: '获得一周真实数据', killCondition: '无外部结果即停止', evaluateAt: '2026-08-30' },
  evidence: { bottleneck: { title: '资源投入不可见' } },
}]);
assert.equal(bet.status, 'approved');
assert.equal(bet.killCondition, '无外部结果即停止');
assert.equal(buildHqWeeklyBet([{ proposalType: 'monthly_bet_proposal', status: 'proposed', title: '草稿' }]).status, 'unknown');

const resources = buildHqProjectResourceBias([{ id: 'p1', name: '核心收入', health: 'healthy' }], {
  review: { resources: [{ 项目: '核心收入', 计划投入: '15h', 实际投入: '8h', 外部结果: '1个报价', 是否应停止: '否' }] },
});
assert.deepEqual(resources[0], {
  projectId: 'p1', name: '核心收入', planned: '15h', actual: '8h', outcome: '1个报价', decision: '否', known: 3,
});

const efficiency = buildHqSystemEfficiency({ review: { metrics: {
  systemMaintenanceMinutes: 180, effectiveDecisionCount: 4, externalResultCount: 2,
  duplicateEntryCount: 0, medianSignalToActionMinutes: 60, observationDays: 14,
} } });
assert.equal(efficiency.idiotIndex, 90);
assert.equal(efficiency.recommendation, '保留');
assert.equal(buildHqSystemEfficiency({ review: { metrics: { observationDays: 7 } } }).recommendation, '继续观测');

console.log('hq resource governance tests passed');
