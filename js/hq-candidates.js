import { isTaskReleased } from './task-visibility.js';

export const HQ_CANDIDATE_SCORE_THRESHOLD = 55;
export const HQ_CANDIDATE_LIMIT = 3;
export const HQ_CANDIDATE_COOLDOWN_MS = 4 * 60 * 60 * 1000;

const DIMENSIONS = [
  'outcomeValue', 'strategicFit', 'leverage', 'timeWindow', 'anomalyRelief',
  'confidence', 'effort', 'switchCost', 'riskBlock',
];

function clamp(value, min = 0, max = 5) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function hasAny(text, words) {
  const source = String(text || '').toLowerCase();
  return words.some((word) => source.includes(word));
}

function dateKey(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 10);
}

function deriveRoiInputs(task, mainline, reviewDate, now) {
  const explicit = task.roiInputs && typeof task.roiInputs === 'object' ? task.roiInputs : {};
  const text = `${task.content || ''} ${task.note || ''} ${(task.tags || []).join(' ')}`;
  const dueAt = new Date(task.dueDate || task.scheduledAt || 0).getTime();
  const hoursToDue = Number.isFinite(dueAt) ? (dueAt - now.getTime()) / 3600000 : Infinity;
  const duration = Math.max(0, Number(task.durationMinutes) || 0);
  const numericPriority = Number(task.priority) || 0;
  const outcomeValue = task.priority === 'high' || numericPriority >= 3 || Number(task.pinLevel) === 1
    ? 5
    : numericPriority >= 2 || hasAny(text, ['发布', '报价', '成交', '交付', '反馈', '上线', '客户', '收入']) ? 4 : 3;
  const strategicFit = mainline?.status === 'active' ? 5 : (task.mainlineId ? 4 : (task.commitmentRole ? 4 : 2));
  const leverage = hasAny(text, ['解锁', '自动化', '流程', '复用', '打通', '模板', '部署']) ? 4 : (task.mainlineId ? 3 : 2);
  const timeWindow = hoursToDue <= 0 ? 5 : hoursToDue <= 24 ? 4 : dateKey(task.scheduledAt) === reviewDate ? 3 : 1;
  const anomalyRelief = hasAny(text, ['阻塞', '故障', '失败', '修复', '风险', '恢复']) ? 4 : 0;
  const confidence = task.syncKey || task.id ? (task.note || task.mainlineId ? 4 : 3) : 1;
  const effort = duration ? (duration <= 30 ? 1 : duration <= 60 ? 2 : duration <= 120 ? 3 : duration <= 240 ? 4 : 5) : 2;
  const switchCost = task.deviceContext === 'universal' ? 0 : 1;
  const riskBlock = hasAny(text, ['等待', '依赖', '阻塞中', '暂停']) ? 4 : 0;
  return Object.fromEntries(DIMENSIONS.map((key) => [key, clamp(explicit[key] ?? ({
    outcomeValue, strategicFit, leverage, timeWindow, anomalyRelief,
    confidence, effort, switchCost, riskBlock,
  })[key])]));
}

export function scoreHqCandidate(inputs = {}) {
  const raw = clamp(inputs.outcomeValue) * 3
    + clamp(inputs.strategicFit) * 2
    + clamp(inputs.leverage) * 2
    + clamp(inputs.timeWindow)
    + clamp(inputs.anomalyRelief)
    + clamp(inputs.confidence)
    - clamp(inputs.effort)
    - clamp(inputs.switchCost)
    - clamp(inputs.riskBlock) * 3;
  return Math.max(0, Math.min(100, Math.round((raw / 50) * 100)));
}

function candidateReason(inputs) {
  const ranked = [
    ['战略相关', inputs.strategicFit],
    ['结果价值', inputs.outcomeValue],
    ['杠杆效应', inputs.leverage],
    ['时间窗口', inputs.timeWindow],
    ['解除阻塞', inputs.anomalyRelief],
  ].filter(([, value]) => value >= 3).sort((a, b) => b[1] - a[1]);
  return ranked.length ? ranked.slice(0, 2).map(([label]) => label).join(' + ') : '成本可控且当前可执行';
}

function completionCriteria(task, title) {
  const explicit = String(task.completionCriteria || task.note || '').trim();
  const cleaned = explicit.replace(/^完成标准\s*[：:]\s*/u, '').trim();
  return cleaned || `完成“${title}”并留下回执`;
}

function isDismissed(dedupeKey, candidateState, now) {
  const until = candidateState?.dismissals?.[dedupeKey]?.until;
  const time = new Date(until || 0).getTime();
  return Number.isFinite(time) && time > now.getTime();
}

function compareCandidates(left, right) {
  return right.score - left.score
    || right.roiInputs.strategicFit - left.roiInputs.strategicFit
    || right.roiInputs.outcomeValue - left.roiInputs.outcomeValue
    || right.roiInputs.timeWindow - left.roiInputs.timeWindow
    || right.roiInputs.confidence - left.roiInputs.confidence
    || (left.estimatedMinutes || Infinity) - (right.estimatedMinutes || Infinity)
    || new Date(right.updatedAt || 0) - new Date(left.updatedAt || 0);
}

function buildProjectCandidates(projects, tasks, brief, now) {
  const convertedKeys = new Set();
  tasks.forEach((task) => {
    if (task.candidateDedupeKey) convertedKeys.add(task.candidateDedupeKey);
    if (String(task.syncKey || '').startsWith('hq-candidate:')) {
      convertedKeys.add(String(task.syncKey).slice('hq-candidate:'.length));
    }
  });
  return projects.flatMap((project) => {
    if (!project?.id || !['blocked', 'needs_action'].includes(project.health)) return [];
    const kind = project.health === 'blocked' ? 'risk' : 'project_next';
    const dedupeKey = `mainline:${project.id}:${kind}`;
    if (convertedKeys.has(dedupeKey) || isDismissed(dedupeKey, brief.candidateState, now)) return [];
    const blocker = String(project.blocker || '').trim();
    const title = project.health === 'blocked'
      ? `解除「${project.name}」的当前阻塞${blocker ? `：${blocker}` : ''}`
      : `为「${project.name}」定义并启动下一步`;
    const roiInputs = {
      outcomeValue: 4,
      strategicFit: 5,
      leverage: 4,
      timeWindow: project.health === 'blocked' ? 4 : 3,
      anomalyRelief: project.health === 'blocked' ? 5 : 3,
      confidence: 4,
      effort: 1,
      switchCost: 0,
      riskBlock: 0,
    };
    return [{
      id: `candidate:mainline:${project.id}:${kind}`,
      taskId: null,
      sourceSystemId: 'mainline',
      sourceRef: project.id,
      sourceUpdatedAt: project.updatedAt || project.lastProgressAt || null,
      kind,
      title,
      completionCriteria: project.health === 'blocked'
        ? '记录阻塞解除证据，并明确下一条可执行动作'
        : '写清一条可执行、可验收的下一步并开始推进',
      reason: project.health === 'blocked' ? '解除阻塞 + 战略相关' : '补齐下一步 + 战略相关',
      evidenceUrl: `#mainline/${project.id}`,
      suggestedBoxId: null,
      mainlineId: project.id,
      estimatedMinutes: 20,
      roiInputs,
      score: scoreHqCandidate(roiInputs),
      status: 'proposed',
      dedupeKey,
      updatedAt: project.updatedAt || project.lastProgressAt || null,
    }];
  });
}

export function buildHqActionCandidates({
  tasks = [], mainlines = [], projects = [], brief = {}, reviewDate = '', now = new Date(),
  threshold = HQ_CANDIDATE_SCORE_THRESHOLD, limit = HQ_CANDIDATE_LIMIT,
} = {}) {
  const mainlineById = new Map(mainlines.map((item) => [item.id, item]));
  const excluded = new Set([brief.currentActionTaskId, ...(brief.maintenanceTaskIds || [])].filter(Boolean));
  const taskCandidates = tasks.flatMap((task) => {
    const mainline = task.mainlineId ? mainlineById.get(task.mainlineId) : null;
    if (!task?.id || excluded.has(task.id) || task.deleted || task.archived || task.isCompleted || task.isRecurringTemplate) return [];
    if (!isTaskReleased(task, now)) return [];
    if (task.mainlineId && (!mainline || !['active', 'maintenance'].includes(mainline.status))) return [];
    const text = String(task.content || '').trim();
    if (text.length < 2 || hasAny(text, ['关注一下', '看看情况', '以后再说'])) return [];
    const dedupeKey = `task:${task.syncKey || task.id}`;
    if (isDismissed(dedupeKey, brief.candidateState, now)) return [];
    const roiInputs = deriveRoiInputs(task, mainline, reviewDate, now);
    const score = scoreHqCandidate(roiInputs);
    if (score < threshold) return [];
    return [{
      id: `candidate:taskbox:${task.id}:project_next`,
      taskId: task.id,
      sourceSystemId: 'taskbox',
      sourceRef: task.id,
      sourceUpdatedAt: task.updatedAt || task.createdAt || null,
      kind: 'project_next',
      title: text,
      completionCriteria: completionCriteria(task, text),
      reason: candidateReason(roiInputs),
      evidenceUrl: task.url || '',
      suggestedBoxId: task.boxId || null,
      mainlineId: task.mainlineId || null,
      estimatedMinutes: Math.max(0, Number(task.durationMinutes) || 0) || null,
      roiInputs,
      score,
      status: 'proposed',
      dedupeKey,
      updatedAt: task.updatedAt || task.createdAt || null,
    }];
  });
  return [...taskCandidates, ...buildProjectCandidates(projects, tasks, brief, now)]
    .filter((candidate) => candidate.score >= threshold)
    .sort(compareCandidates)
    .slice(0, Math.max(0, limit));
}

export function dismissHqCandidate(candidateState = {}, candidate, now = new Date(), cooldownMs = HQ_CANDIDATE_COOLDOWN_MS) {
  return {
    ...candidateState,
    dismissals: {
      ...(candidateState.dismissals || {}),
      [candidate.dedupeKey]: {
        reason: 'manual_skip',
        at: now.toISOString(),
        until: new Date(now.getTime() + cooldownMs).toISOString(),
      },
    },
  };
}
