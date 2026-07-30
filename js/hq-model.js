const DAY_MS = 86400000;

export function normalizeHqBrief(brief = {}, reviewDate = '') {
  return {
    reviewDate: brief.reviewDate || reviewDate,
    primaryTaskId: brief.primaryTaskId || null,
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

export function selectHqCommitments(tasks = [], briefInput = {}, reviewDate = '') {
  const brief = normalizeHqBrief(briefInput, reviewDate);
  const open = tasks.filter((task) => !task.deleted && !task.isCompleted && !task.isRecurringTemplate);
  const byId = new Map(open.map((task) => [task.id, task]));
  const primary = byId.get(brief.primaryTaskId)
    || open.find((task) => task.commitmentDate === reviewDate && task.commitmentRole === 'primary')
    || open.find((task) => Number(task.pinLevel) === 1)
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
    commitments: selectHqCommitments(tasks, normalizedBrief, reviewDate),
    projects: buildHqProjectHealth(mainlines, tasks),
    decisions: decisions.filter((decision) => decision.status !== 'resolved'),
    ai: {
      open: tasks.filter((task) => !task.deleted && !task.isCompleted && task.executionMode === 'ai').length,
      needsInput: tasks.filter((task) => !task.deleted && !task.isCompleted && task.executionMode === 'ai' && task.executionState === 'needs_input').length,
      needsReview: tasks.filter((task) => !task.deleted && !task.isCompleted && task.executionMode === 'ai' && task.executionState === 'needs_review').length,
    },
    generatedAt: new Date().toISOString(),
  };
}
