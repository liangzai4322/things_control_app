import assert from 'node:assert/strict';
import {
  proposalActionModel,
  proposalPeriodLabel,
  proposalStatusMeta,
  proposalTypeMeta,
  summarizeProposalCalibration,
} from '../js/hq-proposals.js';

const daily = {
  proposalType: 'daily_action_proposal', status: 'approved', evidenceStatus: 'unknown',
  sourceRef: { briefDate: '2026-08-10' },
};
assert.equal(proposalTypeMeta(daily.proposalType).label, '日省行动');
assert.equal(proposalStatusMeta(daily.status).label, '已批准');
assert.equal(proposalPeriodLabel(daily), '2026-08-10');
assert.equal(proposalActionModel(daily).canPromote, true);

const weekly = {
  proposalType: 'weekly_experiment_proposal', status: 'approved',
  sourceRef: { periodKey: '2026-08-03_to_2026-08-09' },
};
assert.equal(proposalActionModel(weekly).canPromote, false);
assert.match(proposalActionModel(weekly).writebackLabel, /战略对象/);

const provisionalMonthly = {
  proposalType: 'monthly_bet_proposal', status: 'proposed', evidenceStatus: 'provisional',
};
assert.equal(proposalActionModel(provisionalMonthly).canApprove, false);
assert.equal(proposalActionModel(provisionalMonthly).provisionalMonthly, true);

const summary = summarizeProposalCalibration({
  proposals: [daily, weekly, provisionalMonthly, { proposalType: 'daily_action_proposal', status: 'deferred' }, { proposalType: 'daily_action_proposal', status: 'rejected' }],
  review: { completionRate: 75 },
});
assert.deepEqual(summary.cadenceCounts, { daily: 2, weekly: 1, monthly: 1 });
assert.equal(summary.pending, 1);
assert.equal(summary.approved, 2);
assert.equal(summary.deferred, 1);
assert.equal(summary.evidenceBlocked, 1);
assert.equal(summary.completionRate, 75);
assert.equal(summary.total, 4);
assert.equal(summarizeProposalCalibration({ review: { completionRate: null } }).completionRate, null);

console.log('hq proposal view-model tests passed');
