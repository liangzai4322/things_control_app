const TYPE_META = {
  daily_action_proposal: { label: '日省行动', cadence: 'DAY', target: 'TaskBox' },
  weekly_experiment_proposal: { label: '周省实验', cadence: 'WEEK', target: '战略实验' },
  monthly_bet_proposal: { label: '月省押注', cadence: 'MONTH', target: '资源押注' },
};

const STATUS_META = {
  proposed: { label: '待审批', tone: 'pending' },
  approved: { label: '已批准', tone: 'approved' },
  rejected: { label: '已拒绝', tone: 'rejected' },
  deferred: { label: '已延期', tone: 'deferred' },
  promoted: { label: '已写回', tone: 'promoted' },
};

export function proposalTypeMeta(proposalType) {
  return TYPE_META[proposalType] || { label: '未知提案', cadence: 'OTHER', target: '待确认' };
}

export function proposalStatusMeta(status) {
  return STATUS_META[status] || { label: '状态未知', tone: 'unknown' };
}

export function proposalPeriodLabel(proposal = {}) {
  const source = proposal.sourceRef || {};
  if (source.periodKey) return source.periodKey;
  if (source.briefDate) return source.briefDate;
  if (source.reviewDate) return source.reviewDate;
  return '周期未标记';
}

export function proposalActionModel(proposal = {}) {
  const isDaily = proposal.proposalType === 'daily_action_proposal';
  const provisionalMonthly = proposal.proposalType === 'monthly_bet_proposal'
    && proposal.evidenceStatus === 'provisional';
  const active = ['proposed', 'approved', 'deferred'].includes(proposal.status);
  return {
    canApprove: ['proposed', 'deferred'].includes(proposal.status) && !provisionalMonthly,
    canReject: active,
    canDefer: ['proposed', 'approved'].includes(proposal.status),
    canPromote: proposal.status === 'approved' && isDaily,
    provisionalMonthly,
    writebackLabel: isDaily ? '批准后写入盒子' : '批准后保留为战略对象',
  };
}

export function summarizeProposalCalibration(snapshot = {}) {
  const proposals = Array.isArray(snapshot.proposals)
    ? snapshot.proposals.filter((item) => item.status !== 'rejected')
    : [];
  const pending = proposals.filter((item) => item.status === 'proposed').length;
  const approved = proposals.filter((item) => item.status === 'approved').length;
  const deferred = proposals.filter((item) => item.status === 'deferred').length;
  const evidenceBlocked = proposals.filter((item) => proposalActionModel(item).provisionalMonthly).length;
  const completionRate = snapshot.review?.completionRate;
  const hasCompletionRate = completionRate !== null && completionRate !== undefined && completionRate !== '';
  return {
    total: proposals.length,
    pending,
    approved,
    deferred,
    evidenceBlocked,
    completionRate: hasCompletionRate && Number.isFinite(Number(completionRate)) ? Number(completionRate) : null,
    cadenceCounts: {
      daily: proposals.filter((item) => item.proposalType === 'daily_action_proposal').length,
      weekly: proposals.filter((item) => item.proposalType === 'weekly_experiment_proposal').length,
      monthly: proposals.filter((item) => item.proposalType === 'monthly_bet_proposal').length,
    },
  };
}
