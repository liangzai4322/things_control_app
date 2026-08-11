import { isTaskReleased } from './task-visibility.js';

const DAY_MS = 86400000;
export const HQ_REVIEW_TIME_ZONE = 'Asia/Singapore';

export function hqReviewDateKey(value) {
  if (arguments.length === 0) value = new Date();
  if (value === undefined || value === null || value === '') return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: HQ_REVIEW_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function normalizeHqBrief(brief = {}, reviewDate = '') {
  const clearsStrategicCommitment = Object.hasOwn(brief, 'primaryTaskId')
    && brief.primaryTaskId === null;
  const strategicCommitmentTaskId = clearsStrategicCommitment
    ? null
    : (brief.strategicCommitmentTaskId || brief.primaryTaskId || null);
  const sourceSnapshot = brief.strategicCommitmentSnapshot && typeof brief.strategicCommitmentSnapshot === 'object'
    ? brief.strategicCommitmentSnapshot
    : null;
  const strategicCommitmentSnapshot = !clearsStrategicCommitment
    && sourceSnapshot && (sourceSnapshot.taskId || strategicCommitmentTaskId)
    ? {
      taskId: sourceSnapshot.taskId || strategicCommitmentTaskId,
      content: String(sourceSnapshot.content || ''),
      committedAt: sourceSnapshot.committedAt || null,
    }
    : null;
  const currentActionTaskId = clearsStrategicCommitment
    ? null
    : Object.hasOwn(brief, 'currentActionTaskId')
    ? (brief.currentActionTaskId || null)
    : strategicCommitmentTaskId;
  return {
    reviewDate: brief.reviewDate || reviewDate,
    primaryTaskId: strategicCommitmentTaskId,
    strategicCommitmentTaskId,
    strategicCommitmentSnapshot,
    currentActionTaskId,
    candidateState: brief.candidateState && typeof brief.candidateState === 'object'
      ? {
        dismissals: brief.candidateState.dismissals && typeof brief.candidateState.dismissals === 'object'
          ? brief.candidateState.dismissals
          : {},
        accepted: Array.isArray(brief.candidateState.accepted) ? brief.candidateState.accepted : [],
      }
      : { dismissals: {}, accepted: [] },
    maintenanceTaskIds: Array.isArray(brief.maintenanceTaskIds)
      ? [...new Set(brief.maintenanceTaskIds.filter(Boolean))].slice(0, 2)
      : [],
    stopDoing: Array.isArray(brief.stopDoing) ? brief.stopDoing.filter(Boolean) : [],
    continueDoing: Array.isArray(brief.continueDoing) ? brief.continueDoing.filter(Boolean) : [],
    outcomes: brief.outcomes && typeof brief.outcomes === 'object' ? brief.outcomes : {},
    yesterdayClosure: brief.yesterdayClosure && typeof brief.yesterdayClosure === 'object' ? brief.yesterdayClosure : {},
    notes: String(brief.notes || ''),
    source: brief.source || 'derived',
    updatedAt: brief.updatedAt || null,
  };
}

export function readHqCacheDate(cache = {}, reviewDate = '') {
  const scoped = cache.byReviewDate && typeof cache.byReviewDate === 'object'
    ? cache.byReviewDate[reviewDate]
    : null;
  const legacy = !scoped && cache.brief?.reviewDate === reviewDate
    ? { brief: cache.brief }
    : {};
  const selected = scoped && typeof scoped === 'object' ? scoped : legacy;
  return {
    ...selected,
    reviewDate,
    brief: normalizeHqBrief(selected.brief || {}, reviewDate),
    decisions: Array.isArray(cache.decisions)
      ? cache.decisions
      : (Array.isArray(selected.decisions) ? selected.decisions : []),
    updatedAt: selected.updatedAt || cache.updatedAt || null,
  };
}

export function mergeHqCacheDate(cache = {}, patch = {}, reviewDate = '') {
  const legacy = !cache.byReviewDate && cache.brief?.reviewDate === reviewDate
    ? { brief: cache.brief }
    : {};
  const existing = cache.byReviewDate?.[reviewDate] || legacy;
  const { decisions, ...scopedPatch } = patch;
  const mergedBrief = scopedPatch.brief && typeof scopedPatch.brief === 'object'
    ? { ...(existing.brief || {}), ...scopedPatch.brief }
    : existing.brief;
  const next = {
    ...cache,
    ...(Array.isArray(decisions) ? { decisions } : {}),
    byReviewDate: {
      ...(cache.byReviewDate || {}),
      [reviewDate]: {
        ...existing,
        ...scopedPatch,
        ...(mergedBrief ? { brief: mergedBrief } : {}),
        reviewDate,
        updatedAt: new Date().toISOString(),
      },
    },
    updatedAt: new Date().toISOString(),
  };
  delete next.brief;
  return next;
}

export function describeHqSyncState(syncState = {}, { remote = false } = {}) {
  const pending = Math.max(0, Number(syncState.pendingCount) || 0);
  const dead = Math.max(0, Number(syncState.deadLetterCount) || 0);
  if (syncState.authBlocked) return { className: 'pending', label: `认证失效 · ${pending} 项待同步` };
  if (dead) return { className: 'unknown', label: `同步失败 · ${dead} 项需处理` };
  if (syncState.offline || syncState.status === 'offline') {
    return { className: 'unknown', label: `离线 · 本地事实${pending ? ` · ${pending} 项待同步` : ''}` };
  }
  if (pending) return { className: 'pending', label: `${pending} 项待同步` };
  if (syncState.status === 'unknown') return { className: 'unknown', label: '数据未知 · 本地快照' };
  return remote
    ? { className: 'online', label: '云端已连接' }
    : { className: '', label: '本地快照' };
}

export function freezeHqStrategicCommitmentSnapshot(briefInput = {}, tasks = [], reviewDate = '') {
  const brief = normalizeHqBrief(briefInput, reviewDate);
  if (brief.strategicCommitmentSnapshot || !brief.strategicCommitmentTaskId) return brief;
  const task = tasks.find((item) => item.id === brief.strategicCommitmentTaskId);
  if (!task) return brief;
  return {
    ...brief,
    strategicCommitmentSnapshot: {
      taskId: task.id,
      content: String(task.content || ''),
      committedAt: brief.updatedAt || new Date().toISOString(),
    },
  };
}

export function normalizeReviewStatus(review = {}, reviewDate = '') {
  const history = Array.isArray(review.history) ? review.history.slice(-7) : [];
  const known = history.filter((item) => ['completed', 'partial', 'missed'].includes(item?.state));
  const completedCount = Number.isFinite(Number(review.completedCount))
    ? Number(review.completedCount)
    : known.filter((item) => item.state === 'completed').length;
  const knownCount = Number.isFinite(Number(review.knownCount)) ? Number(review.knownCount) : known.length;
  return {
    status: review.status === 'synced' ? 'synced' : 'pending',
    reviewDate: review.reviewDate || reviewDate,
    latestReviewDate: review.latestReviewDate || null,
    latestReviewAt: review.latestReviewAt || null,
    artifacts: review.artifacts && typeof review.artifacts === 'object' ? review.artifacts : {},
    history,
    knownCount,
    completedCount,
    completionRate: review.completionRate !== null
      && review.completionRate !== ''
      && review.completionRate !== undefined
      && Number.isFinite(Number(review.completionRate))
      ? Number(review.completionRate)
      : (knownCount ? Math.round((completedCount / knownCount) * 100) : null),
    todayEvidence: {
      touched: Math.max(0, Number(review.todayEvidence?.touched) || 0),
      completed: Math.max(0, Number(review.todayEvidence?.completed) || 0),
      progress: Math.max(0, Number(review.todayEvidence?.progress) || 0),
    },
  };
}

export function normalizePeriodSnapshot(snapshot = {}, periodType = 'week') {
  const review = snapshot.review && typeof snapshot.review === 'object' ? snapshot.review : {};
  const derived = snapshot.derived && typeof snapshot.derived === 'object' ? snapshot.derived : {};
  return {
    periodType: snapshot.periodType || periodType,
    periodKey: snapshot.periodKey || '',
    startDate: snapshot.startDate || '',
    endDate: snapshot.endDate || '',
    review: {
      status: ['completed', 'synced'].includes(review.status) ? review.status : 'draft',
      verdict: String(review.verdict || ''),
      previousCommitments: Array.isArray(review.previousCommitments) ? review.previousCommitments : [],
      metrics: review.metrics && typeof review.metrics === 'object' ? review.metrics : {},
      bottleneck: review.bottleneck && typeof review.bottleneck === 'object' ? review.bottleneck : {},
      experiment: review.experiment && typeof review.experiment === 'object' ? review.experiment : {},
      resources: Array.isArray(review.resources) ? review.resources : [],
      startStopContinue: {
        start: Array.isArray(review.startStopContinue?.start) ? review.startStopContinue.start : [],
        stop: Array.isArray(review.startStopContinue?.stop) ? review.startStopContinue.stop : [],
        continue: Array.isArray(review.startStopContinue?.continue) ? review.startStopContinue.continue : [],
      },
      scoreboard: Array.isArray(review.scoreboard) ? review.scoreboard : [],
      portfolio: Array.isArray(review.portfolio) ? review.portfolio : [],
      strategicDecisions: Array.isArray(review.strategicDecisions) ? review.strategicDecisions : [],
      goals: Array.isArray(review.goals) ? review.goals : [],
      notDoing: Array.isArray(review.notDoing) ? review.notDoing : [],
      artifacts: review.artifacts && typeof review.artifacts === 'object' ? review.artifacts : {},
      completedAt: review.completedAt || null,
    },
    derived: {
      dailyReviewCount: Math.max(0, Number(derived.dailyReviewCount) || 0),
      dailyBriefCount: Math.max(0, Number(derived.dailyBriefCount) || 0),
      evidenceDays: Math.max(0, Number(derived.evidenceDays) || 0),
      outcomes: derived.outcomes && typeof derived.outcomes === 'object' ? derived.outcomes : {},
      commitments: derived.commitments && typeof derived.commitments === 'object' ? derived.commitments : {},
      tasks: derived.tasks && typeof derived.tasks === 'object' ? derived.tasks : {},
      projectRisks: Array.isArray(derived.projectRisks) ? derived.projectRisks : [],
    },
    projects: Array.isArray(snapshot.projects) ? snapshot.projects : [],
    decisions: Array.isArray(snapshot.decisions) ? snapshot.decisions : [],
    generatedAt: snapshot.generatedAt || null,
  };
}

export function selectHqCommitments(tasks = [], briefInput = {}, reviewDate = '', mainlines = null) {
  const brief = normalizeHqBrief(briefInput, reviewDate);
  const open = tasks.filter((task) => isOpenCommitment(task, mainlines));
  const byId = new Map(open.map((task) => [task.id, task]));
  const hasStrategicCommitment = Boolean(brief.strategicCommitmentTaskId);
  const primary = byId.get(brief.currentActionTaskId)
    || (!hasStrategicCommitment
      ? open.find((task) => task.commitmentDate === reviewDate && task.commitmentRole === 'primary')
        || open.find((task) => Number(task.pinLevel) === 1)
      : null)
    || null;
  const maintenance = brief.maintenanceTaskIds.map((id) => byId.get(id)).filter(Boolean);
  [
    ...open.filter((task) => task.commitmentDate === reviewDate && task.commitmentRole === 'maintenance'),
    ...open.filter((task) => [2, 3].includes(Number(task.pinLevel))),
  ].forEach((task) => {
    if (task.id !== primary?.id && !maintenance.some((item) => item.id === task.id) && maintenance.length < 2) {
      maintenance.push(task);
    }
  });
  return { primary, maintenance };
}

function completedOn(task, reviewDate) {
  const completedAt = task?.completedAt || task?.completionReceipt?.completedAt;
  return Boolean(task?.isCompleted && hqReviewDateKey(completedAt) === reviewDate);
}

export function isHqExecutableTaskRecord(task = {}) {
  return !task.itemType || task.itemType === 'task';
}

export function buildHqActionState(tasks = [], briefInput = {}, reviewDate = '', mainlines = null) {
  const brief = normalizeHqBrief(briefInput, reviewDate);
  const visibleTasks = tasks.filter((task) => task?.id
    && isHqExecutableTaskRecord(task)
    && !task.deleted
    && !task.isRecurringTemplate);
  const byId = new Map(visibleTasks.map((task) => [task.id, task]));
  const fallbackPrimary = !brief.strategicCommitmentTaskId
    ? selectHqCommitments(visibleTasks, briefInput, reviewDate, mainlines).primary
    : null;
  const strategicTask = byId.get(brief.strategicCommitmentTaskId) || fallbackPrimary || null;
  const strategicCommitment = strategicTask
    ? {
      ...strategicTask,
      content: brief.strategicCommitmentSnapshot?.content || strategicTask.content,
    }
    : brief.strategicCommitmentSnapshot
      ? {
        id: brief.strategicCommitmentSnapshot.taskId,
        content: brief.strategicCommitmentSnapshot.content || '原始承诺任务记录暂不可用',
        committedAt: brief.strategicCommitmentSnapshot.committedAt,
        unavailable: true,
      }
      : null;
  const currentCandidate = byId.get(brief.currentActionTaskId) || fallbackPrimary || null;
  const currentAction = isOpenCommitment(currentCandidate, mainlines) ? currentCandidate : null;
  const outcomes = visibleTasks
    .filter((task) => completedOn(task, reviewDate))
    .sort((left, right) => taskVersion(right) - taskVersion(left))
    .map((task) => ({
      ...task,
      isStrategicCommitment: task.id === brief.strategicCommitmentTaskId,
      completionReceipt: task.completionReceipt && typeof task.completionReceipt === 'object'
        ? task.completionReceipt
        : null,
    }));
  const status = currentAction
    ? 'active'
    : strategicCommitment?.isCompleted
      ? 'awaiting_candidate'
      : strategicCommitment
        ? 'seat_empty'
        : 'uncommitted';
  return {
    status,
    strategicCommitment,
    currentAction,
    outcomes,
  };
}

function taskVersion(task = {}) {
  const value = new Date(task.updatedAt || task.completedAt || task.createdAt || 0).getTime();
  return Number.isFinite(value) ? value : 0;
}

function reconcileCommitmentTask(remoteTask, localById) {
  if (!remoteTask?.id) return null;
  const localTask = localById.get(remoteTask.id);
  if (!localTask) return remoteTask;
  const localVersion = taskVersion(localTask);
  const remoteVersion = taskVersion(remoteTask);
  if (localVersion > remoteVersion) return localTask;
  if (localVersion === remoteVersion && localTask.isCompleted && !remoteTask.isCompleted) return localTask;
  if (localVersion === remoteVersion && localTask.deleted && !remoteTask.deleted) return localTask;
  return remoteTask;
}

function isOpenCommitment(task, mainlines = null) {
  if (!task || !isHqExecutableTaskRecord(task) || task.deleted || task.isCompleted || task.isRecurringTemplate || !isTaskReleased(task)) return false;
  if (!task.mainlineId || !Array.isArray(mainlines)) return true;
  const mainline = mainlines.find((item) => item.id === task.mainlineId);
  return Boolean(mainline && ['active', 'maintenance'].includes(mainline.status));
}

export function reconcileHqSnapshotCommitments(snapshot = {}, localTasks = []) {
  const activeMainlines = Array.isArray(snapshot.projects) ? snapshot.projects : null;
  const localById = new Map(localTasks.filter((task) => task?.id).map((task) => [task.id, task]));
  const remoteCommitments = snapshot.commitments && typeof snapshot.commitments === 'object'
    ? snapshot.commitments
    : {};
  const primaryCandidate = reconcileCommitmentTask(remoteCommitments.primary, localById);
  const primary = isOpenCommitment(primaryCandidate, activeMainlines) ? primaryCandidate : null;
  const maintenance = [];
  (Array.isArray(remoteCommitments.maintenance) ? remoteCommitments.maintenance : []).forEach((task) => {
    const candidate = reconcileCommitmentTask(task, localById);
    if (!isOpenCommitment(candidate, activeMainlines)) return;
    if (candidate.id === primary?.id || maintenance.some((item) => item.id === candidate.id)) return;
    if (maintenance.length < 2) maintenance.push(candidate);
  });
  const reconciledSnapshot = {
    ...snapshot,
    commitments: {
      ...remoteCommitments,
      primary,
      maintenance,
    },
  };
  const remoteActionState = snapshot.actionState && typeof snapshot.actionState === 'object'
    ? snapshot.actionState
    : {};
  const remoteTasks = [
    remoteActionState.strategicCommitment,
    remoteActionState.currentAction,
    ...(Array.isArray(remoteActionState.outcomes) ? remoteActionState.outcomes : []),
    primary,
    ...maintenance,
  ].filter((task) => task?.id);
  const mergedById = new Map(remoteTasks.map((task) => [task.id, task]));
  localTasks.filter((task) => task?.id).forEach((localTask) => {
    const remoteTask = mergedById.get(localTask.id);
    mergedById.set(localTask.id, remoteTask
      ? reconcileCommitmentTask(remoteTask, new Map([[localTask.id, localTask]]))
      : localTask);
  });
  return {
    ...reconciledSnapshot,
    actionState: buildHqActionState(
      [...mergedById.values()],
      snapshot.brief || { primaryTaskId: remoteCommitments.primary?.id || null },
      snapshot.reviewDate || snapshot.brief?.reviewDate || '',
      activeMainlines,
    ),
  };
}

export function resolveHqOutcomeTask(snapshot = {}, localTasks = [], taskId = '') {
  return snapshot.actionState?.outcomes?.find((task) => task?.id === taskId)
    || localTasks.find((task) => task?.id === taskId)
    || null;
}

export function resolveTaskCommandContext(task = {}, mainlines = [], periodSnapshot = {}) {
  const project = task.mainlineId
    ? mainlines.find((item) => item.id === task.mainlineId) || null
    : null;
  const period = normalizePeriodSnapshot(periodSnapshot, 'week');
  const role = task.commitmentRole === 'primary'
    ? 'primary'
    : task.commitmentRole === 'maintenance'
      ? 'maintenance'
      : 'execution';
  const roleLabel = role === 'primary'
    ? '今日主动作'
    : role === 'maintenance'
      ? '今日维护动作'
      : '盒子执行任务';
  return {
    source: ['hq', 'daily_review'].includes(task.commitmentSource) ? 'hq' : 'box',
    role,
    roleLabel,
    commitmentDate: task.commitmentDate || '',
    project: project ? { id: project.id, name: project.name } : null,
    experiment: {
      periodKey: period.periodKey,
      action: period.review.experiment?.action || '',
    },
  };
}

export function buildHqProjectHealth(mainlines = [], tasks = [], referenceTime = new Date()) {
  const reference = new Date(referenceTime).getTime();
  return mainlines
    .filter((mainline) => ['active', 'maintenance'].includes(mainline.status))
    .map((mainline) => {
      const projectTasks = tasks.filter((task) => task.mainlineId === mainline.id && !task.deleted && !task.isRecurringTemplate);
      const openTasks = projectTasks.filter((task) => !task.isCompleted);
      const lastProgressAt = [mainline.updatedAt, ...projectTasks.map((task) => task.updatedAt || task.completedAt)]
        .filter(Boolean)
        .sort((left, right) => new Date(right) - new Date(left))[0] || mainline.createdAt || null;
      const staleDays = lastProgressAt
        ? Math.max(0, Math.floor((reference - new Date(lastProgressAt).getTime()) / DAY_MS))
        : 0;
      const nextAction = [...openTasks]
        .sort((left, right) => new Date(left.dueDate || left.scheduledAt || left.createdAt) - new Date(right.dueDate || right.scheduledAt || right.createdAt))[0] || null;
      const health = mainline.blocker ? 'blocked' : (!nextAction ? 'needs_action' : (staleDays >= 7 ? 'stale' : 'healthy'));
      return {
        ...mainline,
        nextAction,
        openTaskCount: openTasks.length,
        completedTaskCount: projectTasks.length - openTasks.length,
        lastProgressAt,
        staleDays,
        health,
      };
    });
}

export function buildLocalHqSnapshot({ reviewDate, brief, tasks = [], mainlines = [], decisions = [] } = {}) {
  const normalizedBrief = normalizeHqBrief(brief, reviewDate);
  return {
    reviewDate,
    brief: normalizedBrief,
    commitments: selectHqCommitments(tasks, normalizedBrief, reviewDate, mainlines),
    actionState: buildHqActionState(tasks, normalizedBrief, reviewDate, mainlines),
    projects: buildHqProjectHealth(mainlines, tasks),
    decisions: decisions.filter((decision) => decision.status !== 'resolved'),
    review: normalizeReviewStatus({}, reviewDate),
    ai: {
      open: tasks.filter((task) => !task.deleted && !task.isCompleted && task.executionMode === 'ai').length,
      needsInput: tasks.filter((task) => !task.deleted && !task.isCompleted && task.executionMode === 'ai' && task.executionState === 'needs_input').length,
      needsReview: tasks.filter((task) => !task.deleted && !task.isCompleted && task.executionMode === 'ai' && task.executionState === 'needs_review').length,
    },
    generatedAt: new Date().toISOString(),
  };
}
