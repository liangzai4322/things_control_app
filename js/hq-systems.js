const MINUTE_MS = 60 * 1000;

export const HQ_SYSTEM_ACCESS_LEVELS = Object.freeze({
  L0: { label: 'L0 入口', shortLabel: 'L0', canReadFacts: false, canWrite: false },
  L1: { label: 'L1 只读', shortLabel: 'L1', canReadFacts: true, canWrite: false },
  L2: { label: 'L2 受控写回', shortLabel: 'L2', canReadFacts: true, canWrite: true },
});

export const HQ_SYSTEM_REGISTRY = Object.freeze([
  {
    systemId: 'daily', code: '003', name: '日省', accessLevel: 'L2', action: 'brief',
    responsibility: '复盘证据、承诺命中与明日方向',
    factSource: 'HQ 日省状态与每日事实包', readMethod: '/v1/hq/review-status + /v1/daily-snapshot',
    writeMethod: '用户保存后更新当日 brief', healthCheck: '远端日省状态可读且有生成时间',
    freshnessSlaMs: 36 * 60 * MINUTE_MS, actionTriggers: ['日省缺失', '承诺连续偏离'],
    evidenceReturn: '完成回执进入日省事实包', owner: '日省 skill',
  },
  {
    systemId: 'mainline', code: '002', name: '主线系统', accessLevel: 'L1', action: 'projects',
    responsibility: '项目、里程碑、阻塞与下一步',
    factSource: 'TaskBox API 的 HQ 项目健康快照', readMethod: '/v1/hq/today.projects',
    writeMethod: '', healthCheck: '读取成功、生成时间未过期且项目健康字段有效',
    freshnessSlaMs: 10 * MINUTE_MS, actionTriggers: ['blocked', 'needs_action'],
    evidenceReturn: '候选确认后关联任务；完成回执由 TaskBox 返回', owner: '人生参谋部',
  },
  {
    systemId: 'taskbox', code: 'BOX', name: '行动盒子', accessLevel: 'L2', action: 'execution',
    responsibility: '任务执行、完成事实与场景分发',
    factSource: 'TaskBox 记录级 API', readMethod: '/v1/tasks + 本地离线缓存',
    writeMethod: '用户确认后幂等创建或更新任务', healthCheck: 'API 同步状态、待同步队列与认证状态',
    freshnessSlaMs: 10 * MINUTE_MS, actionTriggers: ['任务完成', '同步阻塞'],
    evidenceReturn: 'completionReceipt 与进度记录', owner: 'TaskBox',
  },
  {
    systemId: 'mission', code: 'MIS', name: '使命系统', accessLevel: 'L1', action: 'mission',
    responsibility: '长期方向、当前战役、项目组合与不做清单', factSource: '使命系统明确批准的 activeVersion', readMethod: '本地 mission L1 最小只读快照',
    writeMethod: '', healthCheck: '已批准版本、批准时间与复查日期有效；草稿不进入事实层', freshnessSlaMs: 0, actionTriggers: ['使命复查到期', '项目组合映射缺失'], evidenceReturn: '版本ID、当前战役与计数型摘要', owner: '使命系统',
  },
  {
    systemId: 'health', code: 'HLT', name: '健康与能量', accessLevel: 'L1', action: 'health',
    responsibility: '睡眠、精力、恢复、风险与可用容量', factSource: '健康系统明确发布的本地协议 outbox 快照', readMethod: '本地 health L1 最小容量/约束快照',
    writeMethod: '', healthCheck: '36小时新鲜度、来源冲突、关键字段与置信度', freshnessSlaMs: 36 * 60 * MINUTE_MS, actionTriggers: ['容量约束', '快照过期', '来源冲突'], evidenceReturn: '容量、约束、来源计数与评估时间；不含原始健康数据', owner: '健康与能量系统',
  },
  {
    systemId: 'time', code: 'TIM', name: '时间与注意力', accessLevel: 'L1', action: 'time',
    responsibility: '时间预算、保护时段、实际投入与注意力泄漏', factSource: '时间系统统一日视图（人工计划 + 日历只读快照 + TaskBox引用）', readMethod: '本地 time-attention P1 只读快照',
    writeMethod: '', healthCheck: '今日容量与保护时段可读；外部日历不可用时明确降级', freshnessSlaMs: 36 * 60 * MINUTE_MS, actionTriggers: ['超载', '保护时段冲突', '注意力泄漏'], evidenceReturn: '容量、保护时段、超载与最高泄漏只读发布给HQ', owner: '时间与注意力系统',
  },
  {
    systemId: 'feedback', code: 'FDB', name: '反馈与进化', accessLevel: 'L1', action: 'feedback',
    responsibility: '预测误差、重复模式、单变量实验与规则版本', factSource: '反馈系统本地证据链', readMethod: '独立反馈系统入口',
    writeMethod: '', healthCheck: '读取跨周期连续性摘要；规则提案不会自动改写目标系统', freshnessSlaMs: 0, actionTriggers: [], evidenceReturn: '统一偏差、实验、规则ID与结构化证据引用', owner: '反馈与进化系统',
  },
  {
    systemId: 'trade', code: '001', name: '交易系统', accessLevel: 'L0', action: '',
    responsibility: '交易工具入口、风险与机会摘要', factSource: '待登记', readMethod: '入口链接',
    writeMethod: '', healthCheck: '尚未接入', freshnessSlaMs: 0,
    actionTriggers: [], evidenceReturn: '待定义', owner: '待登记',
  },
  {
    systemId: 'mirror', code: '010', name: '镜像系统', accessLevel: 'L0', action: '',
    responsibility: '状态校准与同日补充', factSource: '待登记', readMethod: '入口链接',
    writeMethod: '', healthCheck: '尚未接入', freshnessSlaMs: 0,
    actionTriggers: [], evidenceReturn: '待定义', owner: '待登记',
  },
  {
    systemId: 'gap', code: '009', name: 'GAP 教练', accessLevel: 'L0', action: '',
    responsibility: '重复问题与待决策事项', factSource: '待登记', readMethod: '入口链接',
    writeMethod: '', healthCheck: '尚未接入', freshnessSlaMs: 0,
    actionTriggers: [], evidenceReturn: '待定义', owner: '待登记',
  },
]);

const HEALTH_PRESENTATION = Object.freeze({
  healthy: { label: '运行正常', severity: 0 },
  attention: { label: '需要关注', severity: 1 },
  alert: { label: '发现异常', severity: 2 },
  stale: { label: '数据过期', severity: 2 },
  unknown: { label: '状态未知', severity: 2 },
  entry: { label: '仅提供入口', severity: 0 },
});

function timestamp(value) {
  const time = new Date(value || 0).getTime();
  return Number.isFinite(time) && time > 0 ? time : null;
}

function isFresh(value, freshnessSlaMs, now) {
  const syncedAt = timestamp(value);
  if (!syncedAt || !freshnessSlaMs) return false;
  return now.getTime() - syncedAt <= freshnessSlaMs;
}

function mainlineView(system, context) {
  const projects = Array.isArray(context.snapshot.projects) ? context.snapshot.projects : [];
  const lastSyncAt = context.snapshot.generatedAt || null;
  const actionable = projects.filter((project) => system.actionTriggers.includes(project.health));
  const topSignal = [...projects]
    .sort((left, right) => {
      const rank = { blocked: 0, needs_action: 1, stale: 2, healthy: 3 };
      return (rank[left.health] ?? 4) - (rank[right.health] ?? 4);
    })[0] || null;
  let health = 'healthy';
  if (!context.remote || !lastSyncAt) health = 'unknown';
  else if (!isFresh(lastSyncAt, system.freshnessSlaMs, context.now)) health = 'stale';
  else if (projects.some((project) => project.health === 'blocked')) health = 'alert';
  else if (projects.some((project) => ['needs_action', 'stale'].includes(project.health))) health = 'attention';

  const linkedTasks = context.tasks.filter((task) => task.candidateSourceSystemId === system.systemId);
  const completedLinkedTasks = linkedTasks.filter((task) => task.isCompleted && !task.deleted);
  return {
    health,
    lastSyncAt,
    candidateSignalCount: actionable.length,
    factSummary: context.remote
      ? `${projects.length} 个活跃项目 · ${actionable.length} 个信号越过行动门槛`
      : '等待云端只读事实确认',
    highestSignal: topSignal
      ? `${topSignal.name} · ${topSignal.health === 'blocked' ? '阻塞' : topSignal.health === 'needs_action' ? '缺下一步' : topSignal.health === 'stale' ? '停滞' : '推进中'}`
      : '当前没有项目事实',
    loopEvidence: {
      discovered: context.remote,
      judged: actionable.length > 0 || linkedTasks.length > 0,
      executed: linkedTasks.length > 0,
      evidenced: completedLinkedTasks.length > 0,
      reviewed: completedLinkedTasks.length > 0 && context.snapshot.review?.status === 'synced',
    },
  };
}

function taskboxView(context) {
  const sync = context.syncState || {};
  const pending = Math.max(0, Number(sync.pendingCount) || 0);
  let health = 'healthy';
  if (sync.authBlocked || sync.offline || sync.status === 'offline' || sync.status === 'unknown') health = 'unknown';
  else if (pending || Number(sync.deadLetterCount)) health = 'attention';
  return {
    health,
    lastSyncAt: context.snapshot.generatedAt || null,
    candidateSignalCount: 0,
    factSummary: `${context.tasks.filter((task) => !task.deleted && !task.isCompleted).length} 项待执行 · ${pending} 项待同步`,
    highestSignal: health === 'unknown' ? 'API 状态未确认' : pending ? `${pending} 项等待同步` : '记录级同步正常',
  };
}

function dailyView(context) {
  const review = context.snapshot.review || {};
  const health = context.remote ? 'healthy' : 'unknown';
  return {
    health,
    lastSyncAt: context.snapshot.generatedAt || review.latestReviewAt || null,
    candidateSignalCount: 0,
    factSummary: review.status === 'synced' ? '今日日省已同步' : '今晚待复盘',
    highestSignal: review.latestReviewAt ? `最近日省：${review.latestReviewDate || '已记录'}` : '尚无最近日省记录',
  };
}

function missionView(context) {
  const snapshot = context.missionSnapshot || {};
  const summary = snapshot.summary || {};
  const readable = Boolean(snapshot.generatedAt && summary.activeVersionId);
  const factSummary = readable
    ? `${summary.campaignTitle || '当前战役待命名'} · ${summary.successConditionCount || 0} 条成功条件 · ${summary.stopDoingCount || 0} 项不做`
    : '尚未发布使命版本';
  let highestSignal = readable ? `复查 ${summary.reviewAt || '日期待确认'}` : '只有明确批准的 activeVersion 才能进入 HQ';
  if (summary.portfolioDriftCount) highestSignal = `${summary.portfolioDriftCount} 项组合映射需要复核`;
  else if (summary.hasPendingDraft) highestSignal = '有待审批草稿；当前事实仍保持已发布版本';
  return {
    health: snapshot.status || 'unknown',
    lastSyncAt: snapshot.generatedAt || null,
    candidateSignalCount: 0,
    factSummary,
    highestSignal,
  };
}

function healthView(context) {
  const snapshot = context.healthSnapshot || {};
  const summary = snapshot.summary || {};
  const readable = Boolean(snapshot.generatedAt && summary.healthSnapshotId);
  const capacity = summary.availableCapacity == null ? '容量未知' : `容量 ${Math.round(summary.availableCapacity * 100)}%`;
  const factSummary = readable
    ? `${capacity} · ${(summary.constraints || []).length} 项约束 · ${summary.sourceTypeCount || 0} 类证据来源`
    : '尚无已发布健康快照';
  let highestSignal = readable ? ((summary.constraints || [])[0] || '当前没有额外容量约束') : '原始健康记录不会被 HQ 直接读取';
  if (summary.conflictCount) highestSignal = `${summary.conflictCount} 项来源冲突，已降级为未知`;
  else if ((summary.missingFields || []).length) highestSignal = '关键字段缺失，已降级为未知';
  else if (snapshot.status === 'stale') highestSignal = '健康容量快照已超过 36 小时';
  return {
    health: snapshot.status || 'unknown',
    lastSyncAt: snapshot.generatedAt || null,
    candidateSignalCount: 0,
    factSummary,
    highestSignal,
  };
}

function timeView(system, context) {
  const snapshot = context.timeSnapshot || {};
  const summary = snapshot.summary || snapshot;
  const hasFacts = Boolean(snapshot.generatedAt || summary.protectedWindow || summary.availableMinutes != null);
  let health = 'healthy';
  if (!hasFacts || summary.overloadState === 'unknown') health = 'unknown';
  else if (!isFresh(snapshot.generatedAt, system.freshnessSlaMs, context.now)) health = 'stale';
  else if (summary.overloadState === 'overloaded' || Number(summary.conflictCount) > 0) health = 'alert';
  else if (summary.overloadState === 'warning' || summary.highestLeak) health = 'attention';
  const window = summary.protectedWindow;
  const signalParts = [];
  if (summary.conflictCount) signalParts.push(`${summary.conflictCount} 项保护时段冲突`);
  if (summary.overloadState === 'overloaded') signalParts.push('容量已经超载');
  if (summary.highestLeak) signalParts.push(`最高泄漏：${summary.highestLeak}`);
  return {
    health,
    lastSyncAt: snapshot.generatedAt || null,
    candidateSignalCount: 0,
    factSummary: hasFacts
      ? `${summary.availableMinutes == null ? '容量待确认' : `可用 ${summary.availableMinutes} 分钟`} · ${window ? `保护 ${window.start}–${window.end}` : '保护时段待确认'} · ${summary.calendarStatus === 'connected' ? '日历已读取' : '日历降级'}`
      : '等待时间系统生成今日只读事实',
    highestSignal: signalParts.join(' · ') || (window ? `今日保护 ${window.start}–${window.end}` : '尚无可发布保护时段'),
  };
}

function feedbackView(context) {
  const snapshot = context.feedback || {};
  const summary = snapshot.summary || snapshot;
  const readable = Boolean(summary.lastSyncAt || summary.experiment || summary.rule || summary.latestDeviation);
  const highestSignal = summary.rule
    ? `待批准规则：${summary.rule.statement}`
    : summary.experiment
      ? `${summary.experiment.status === 'active' ? '运行中' : '待批准'}实验：${summary.experiment.hypothesis}`
      : summary.latestDeviation
        ? `最近偏差：${summary.latestDeviation.subjectRef || summary.latestDeviation.deviationId}`
        : '尚未导入日省、周省或月省连续性载荷';
  return {
    health: snapshot.status || (readable ? (summary.pendingRuleCount ? 'attention' : 'healthy') : 'unknown'),
    lastSyncAt: snapshot.generatedAt || summary.lastSyncAt || null,
    candidateSignalCount: 0,
    factSummary: readable
      ? `${Number(summary.deviationCount) || 0} 个连续偏差 · ${summary.experiment ? '1 个当前实验' : '无当前实验'} · ${Number(summary.pendingRuleCount) || 0} 条待批准规则`
      : '等待反馈系统本地连续性事实',
    highestSignal,
  };
}

export function buildHqSystemViews({
  snapshot = {}, syncState = {}, tasks = [], missionSnapshot = {}, healthSnapshot = {}, timeSnapshot = {}, feedback = {}, remote = false, now = new Date(), registry = HQ_SYSTEM_REGISTRY,
} = {}) {
  const context = { snapshot, syncState, tasks, missionSnapshot, healthSnapshot, timeSnapshot, feedback, remote, now: new Date(now) };
  return registry.map((system) => {
    const access = HQ_SYSTEM_ACCESS_LEVELS[system.accessLevel] || HQ_SYSTEM_ACCESS_LEVELS.L0;
    let dynamic = {
      health: 'entry', lastSyncAt: null, candidateSignalCount: 0,
      factSummary: '尚未接入事实读取', highestSignal: '接入卡已登记，等待升级到 L1',
    };
    if (system.systemId === 'mainline') dynamic = mainlineView(system, context);
    else if (system.systemId === 'taskbox') dynamic = taskboxView(context);
    else if (system.systemId === 'daily') dynamic = dailyView(context);
    else if (system.systemId === 'mission') dynamic = missionView(context);
    else if (system.systemId === 'health') dynamic = healthView(context);
    else if (system.systemId === 'time') dynamic = timeView(system, context);
    else if (system.systemId === 'feedback') dynamic = feedbackView(context);
    const healthPresentation = HEALTH_PRESENTATION[dynamic.health] || HEALTH_PRESENTATION.unknown;
    return {
      ...system,
      ...dynamic,
      access,
      healthLabel: healthPresentation.label,
      severity: healthPresentation.severity,
      canReadFacts: access.canReadFacts,
      canWrite: access.canWrite,
    };
  });
}

export function summarizeHqSystemViews(systems = []) {
  return {
    l0: systems.filter((system) => system.accessLevel === 'L0').length,
    l1: systems.filter((system) => system.accessLevel === 'L1').length,
    l2: systems.filter((system) => system.accessLevel === 'L2').length,
    unknown: systems.filter((system) => ['unknown', 'stale'].includes(system.health)).length,
    actionable: systems.reduce((total, system) => total + (Number(system.candidateSignalCount) || 0), 0),
  };
}
