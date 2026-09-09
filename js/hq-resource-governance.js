const clean = (value) => String(value ?? '').trim();
const finite = (value) => value !== '' && value != null && Number.isFinite(Number(value)) ? Number(value) : null;

function firstValue(source = {}, keys = []) {
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null && source[key] !== '') return source[key];
  }
  return null;
}

function latestApprovedMonthlyBet(proposals = []) {
  return [...proposals]
    .filter((item) => item?.proposalType === 'monthly_bet_proposal' && item.status === 'approved')
    .sort((left, right) => new Date(right.updatedAt || right.decidedAt || 0) - new Date(left.updatedAt || left.decidedAt || 0))[0] || null;
}

export function buildHqWeeklyBet(proposals = [], monthSnapshot = {}) {
  const proposal = latestApprovedMonthlyBet(proposals);
  const review = monthSnapshot?.review && typeof monthSnapshot.review === 'object' ? monthSnapshot.review : {};
  const fallback = Array.isArray(review.strategicDecisions) ? review.strategicDecisions[0] : null;
  const content = proposal?.content && typeof proposal.content === 'object' ? proposal.content : {};
  const evidence = proposal?.evidence && typeof proposal.evidence === 'object' ? proposal.evidence : {};
  const title = clean(proposal?.title || content.decision || fallback?.decision);
  return {
    status: proposal ? 'approved' : title ? 'review_only' : 'unknown',
    title: title || '尚未批准本周唯一赌注',
    successCriteria: clean(firstValue(content, ['successThreshold', 'successCriteria', 'successCondition']) || fallback?.evidence),
    bottleneck: clean(evidence.bottleneck?.title || content.bottleneck || review.bottleneck?.title),
    killCondition: clean(firstValue(content, ['killCondition', 'exitCondition', 'failureThreshold', 'stopCondition']) || fallback?.exitCondition),
    nextReviewAt: clean(firstValue(content, ['nextReviewAt', 'evaluateAt', 'dueDate'])),
    sourceRef: proposal?.decisionId || proposal?.id || null,
  };
}

function allocationRows(weekSnapshot = {}, monthSnapshot = {}) {
  const weekRows = Array.isArray(weekSnapshot?.review?.resources) ? weekSnapshot.review.resources : [];
  const monthRows = Array.isArray(monthSnapshot?.review?.portfolio) ? monthSnapshot.review.portfolio : [];
  return [...weekRows, ...monthRows];
}

function rowName(row = {}) {
  return clean(firstValue(row, ['项目', '项目名', '主线', '业务线', 'name', 'project']));
}

export function buildHqProjectResourceBias(projects = [], weekSnapshot = {}, monthSnapshot = {}) {
  const rows = allocationRows(weekSnapshot, monthSnapshot);
  return projects.map((project) => {
    const row = rows.find((item) => rowName(item) === clean(project.name)) || {};
    const planned = firstValue(row, ['计划投入', '计划时间', '时间预算', '下周投入', 'planned']);
    const actual = firstValue(row, ['实际投入', '实际时间', '时间投入', 'actual']);
    const outcome = firstValue(row, ['外部结果', '现金结果', '结果', 'outcome']);
    const decision = firstValue(row, ['是否应停止', '决策', 'decision']);
    return {
      projectId: project.id,
      name: clean(project.name),
      planned: clean(planned) || '未知',
      actual: clean(actual) || '未知',
      outcome: clean(outcome) || '未知',
      decision: clean(decision) || (project.health === 'blocked' || project.health === 'stale' ? '需要判断' : '继续观测'),
      known: [planned, actual, outcome].filter((value) => value !== null).length,
    };
  });
}

export function buildHqSystemEfficiency(weekSnapshot = {}) {
  const metrics = weekSnapshot?.review?.metrics && typeof weekSnapshot.review.metrics === 'object'
    ? weekSnapshot.review.metrics
    : {};
  const maintenanceMinutes = finite(firstValue(metrics, ['systemMaintenanceMinutes', '系统维护分钟', '系统维护耗时']));
  const effectiveDecisions = finite(firstValue(metrics, ['effectiveDecisionCount', '有效决策数']));
  const externalResults = finite(firstValue(metrics, ['externalResultCount', '外部结果数']));
  const duplicateEntries = finite(firstValue(metrics, ['duplicateEntryCount', '重复录入次数']));
  const medianLatency = finite(firstValue(metrics, ['medianSignalToActionMinutes', '信号到行动中位分钟']));
  const observationDays = finite(firstValue(metrics, ['observationDays', '观测天数'])) || 0;
  const idiotIndex = maintenanceMinutes !== null && externalResults !== null
    ? Math.round((maintenanceMinutes / Math.max(1, externalResults)) * 10) / 10
    : null;
  const knownCount = [maintenanceMinutes, effectiveDecisions, externalResults, duplicateEntries, medianLatency]
    .filter((value) => value !== null).length;
  let recommendation = '继续观测';
  if (observationDays >= 14 && knownCount === 5) {
    if (externalResults === 0 && maintenanceMinutes > 0) recommendation = '停止或降级';
    else if (duplicateEntries > 0 || medianLatency > 1440 || idiotIndex > 240) recommendation = '简化';
    else recommendation = '保留';
  }
  return {
    maintenanceMinutes,
    effectiveDecisions,
    externalResults,
    duplicateEntries,
    medianLatency,
    observationDays,
    idiotIndex,
    knownCount,
    ready: observationDays >= 14 && knownCount === 5,
    recommendation,
  };
}

export function buildHqResourceGovernance({ proposals = [], projects = [], periods = {} } = {}) {
  return {
    bet: buildHqWeeklyBet(proposals, periods.month),
    projects: buildHqProjectResourceBias(projects, periods.week, periods.month),
    efficiency: buildHqSystemEfficiency(periods.week),
  };
}
