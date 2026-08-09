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
    systemId: 'taskbox', code: 'BOX', name: '行动盒子', accessLevel: 'L2', action: 'home',
    responsibility: '任务执行、完成事实与场景分发',
    factSource: 'TaskBox 记录级 API', readMethod: '/v1/tasks + 本地离线缓存',
    writeMethod: '用户确认后幂等创建或更新任务', healthCheck: 'API 同步状态、待同步队列与认证状态',
    freshnessSlaMs: 10 * MINUTE_MS, actionTriggers: ['任务完成', '同步阻塞'],
    evidenceReturn: 'completionReceipt 与进度记录', owner: 'TaskBox',
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

export function buildHqSystemViews({
  snapshot = {}, syncState = {}, tasks = [], remote = false, now = new Date(), registry = HQ_SYSTEM_REGISTRY,
} = {}) {
  const context = { snapshot, syncState, tasks, remote, now: new Date(now) };
  return registry.map((system) => {
    const access = HQ_SYSTEM_ACCESS_LEVELS[system.accessLevel] || HQ_SYSTEM_ACCESS_LEVELS.L0;
    let dynamic = {
      health: 'entry', lastSyncAt: null, candidateSignalCount: 0,
      factSummary: '尚未接入事实读取', highestSignal: '接入卡已登记，等待升级到 L1',
    };
    if (system.systemId === 'mainline') dynamic = mainlineView(system, context);
    else if (system.systemId === 'taskbox') dynamic = taskboxView(context);
    else if (system.systemId === 'daily') dynamic = dailyView(context);
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
