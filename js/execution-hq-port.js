import { deriveExecutionState } from './execution-model.js';

export function readExecutionHqPort({ tasks = [], boxes = [], brief = {}, reviewDate, mainlines = [], syncState = {}, now = new Date() } = {}) {
  const state = deriveExecutionState({ tasks, boxes, brief, reviewDate, mainlines, syncState });
  const generatedAt = new Date(now).toISOString();
  const syncUnknown = syncState.authBlocked || syncState.offline || ['offline', 'unknown'].includes(syncState.status);
  return {
    snapshotId: `execution-hq:${reviewDate || generatedAt.slice(0, 10)}`,
    systemId: 'execution',
    schemaVersion: 1,
    generatedAt,
    status: syncUnknown ? 'unknown' : state.metrics.wipRisk || state.metrics.pendingSync ? 'attention' : 'healthy',
    summary: {
      currentActionId: state.currentAction?.id || null,
      currentActionTitle: state.currentAction?.content || null,
      wipCount: state.metrics.wipCount,
      wipLimit: state.metrics.wipLimit,
      waitingCount: state.metrics.waitingCount,
      outcomeCount: state.metrics.outcomeCount,
      evidenceCount: state.metrics.evidenceCount,
      pendingSync: state.metrics.pendingSync,
      factEngine: 'taskbox',
    },
    sourceRefs: [state.currentAction?.id, ...state.outcomes.map((item) => item.completionReceiptRef)].filter(Boolean),
    permissions: { hqRead: true, hqWrite: 'proposal_only', writesTaskBoxDirectly: false },
  };
}
