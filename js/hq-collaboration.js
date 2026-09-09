const EMPTY_STATE = Object.freeze({ label: '无数据', tone: 'empty' });

export function systemCollaborationState(system = {}, candidateCount = 0) {
  if (['stale'].includes(system.health)) return { label: '数据过期', tone: 'stale' };
  if (['alert'].includes(system.health)) return { label: '发现异常', tone: 'alert' };
  if (['attention'].includes(system.health)) return { label: '需要关注', tone: 'attention' };
  if (system.health === 'unknown') {
    return candidateCount > 0
      ? { label: `${candidateCount} 个候选待处理`, tone: 'candidate' }
      : EMPTY_STATE;
  }
  if (candidateCount > 0) return { label: `${candidateCount} 个候选待处理`, tone: 'candidate' };
  if (system.health === 'healthy') return { label: '正式状态正常', tone: 'healthy' };
  return system.accessLevel === 'L0' ? { label: '仅提供入口', tone: 'entry' } : EMPTY_STATE;
}

export function buildCollaborationInbox({ systems = [], candidateCounts = {}, syncState = {}, brief = {}, tasks = [] } = {}) {
  const items = [];
  if (syncState.authBlocked) items.push({ id: 'taskbox-auth', systemId: 'execution', severity: 'error', title: '盒子连接需要重新认证', need: '检查 API Token', reason: 'HQ无法确认任务、完成证据和系统投影。' });
  else if (syncState.offline || syncState.status === 'offline') items.push({ id: 'taskbox-offline', systemId: 'execution', severity: 'warning', title: '盒子连接处于离线状态', need: '恢复网络后自动重试', reason: '当前显示的是最后一次成功快照。' });

  systems.forEach((system) => {
    const count = Number(candidateCounts[system.systemId]) || 0;
    if (system.health === 'stale') items.push({ id: `${system.systemId}-stale`, systemId: system.systemId, severity: 'warning', title: `${system.name}数据已过期`, need: system.systemId === 'health' ? '补充实际活动日期、睡眠和精力' : system.systemId === 'time' ? '补充今日可用分钟和保护时段' : '刷新该系统的正式快照', reason: system.highestSignal });
    else if (system.health === 'unknown' && !count && ['health', 'time', 'mission'].includes(system.systemId)) items.push({ id: `${system.systemId}-empty`, systemId: system.systemId, severity: 'input', title: `${system.name}尚无正式状态`, need: system.systemId === 'health' ? '实际活动日期；睡眠；精力；异常约束' : system.systemId === 'time' ? '今日可用分钟；主动作保护时段' : '在使命系统发布正式版本', reason: system.highestSignal });
    if (count) items.push({ id: `${system.systemId}-candidates`, systemId: system.systemId, severity: 'review', title: `${system.name}有 ${count} 个候选`, need: '需要时进入对应系统处理', reason: '候选不会自动改写正式事实。' });
  });

  const currentTask = tasks.find((task) => task.id === (brief.currentActionTaskId || brief.primaryTaskId));
  if (currentTask && !String(currentTask.nextAction || currentTask.note || '').trim()) items.push({ id: 'action-next-step', systemId: 'execution', severity: 'input', title: '当前行动缺少明确下一步', need: '补充下一步和完成标准', reason: '缺口会降低执行和日省结算质量。' });
  return items;
}

export function summarizePeriodCollaboration({ systems = [], periodType = 'week' } = {}) {
  const unavailable = systems.filter((item) => ['unknown', 'stale'].includes(item.health));
  return {
    cadence: periodType === 'month' ? 'monthly' : 'weekly',
    systemCount: systems.length,
    unavailableCount: unavailable.length,
    ready: unavailable.length === 0,
    missingSystems: unavailable.map((item) => item.systemId),
  };
}
