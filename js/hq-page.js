import {
  getBoxes,
  getApiSyncState,
  getPendingApiMutationCount,
  getMainlines,
  getTasks,
  pullDataFromCloud,
  queueTaskboxApiMutation,
  replayPendingApiMutations,
  requestTaskboxApi,
  updateTask,
  waitForPendingApiMutations,
} from './db.js';
import { navigate, openSheet, showToast } from './app.js';
import {
  buildHqActionState,
  buildLocalHqSnapshot,
  describeHqSyncState,
  freezeHqStrategicCommitmentSnapshot,
  hqReviewDateKey,
  mergeHqCacheDate,
  normalizeHqBrief,
  normalizeReviewStatus,
  readHqCacheDate,
  reconcileHqSnapshotCommitments,
  resolveHqOutcomeTask,
} from './hq-model.js';
import { openCompletionReceiptSheet } from './completion-card.js';
import { bindHqDimensionNav, renderHqDimensionNav, renderHqPeriodPage } from './hq-period-page.js';
import { isTaskReleased } from './task-visibility.js';
import { isTaskBox } from './box-types.js';
import { buildHqActionCandidates, dismissHqCandidate } from './hq-candidates.js';
import { buildHqSystemViews, summarizeHqSystemViews } from './hq-systems.js';
import { readFiveSystemHqPorts } from './five-system-hq-ports.js';
import {
  parseFiveSystemBootstrapFile,
  publishFiveSystemBaseline,
  readFiveSystemBaselineHistory,
  readFiveSystemBootstrapState,
  rollbackFiveSystemBaseline,
} from './five-system-bootstrap.js';
import {
  proposalActionModel,
  proposalPeriodLabel,
  proposalStatusMeta,
  proposalTypeMeta,
  summarizeProposalCalibration,
} from './hq-proposals.js';

const HQ_CACHE_KEY = 'taskbox_hq_cache_v1';
let hqRenderVersion = 0;
let baselineAutoSyncAttempted = false;
const OUTCOME_FIELDS = [
  ['published', '发布'],
  ['conversations', '有效对话'],
  ['quotes', '报价'],
  ['deals', '成交'],
  ['feedback', '真实反馈'],
];
const HEALTH_LABELS = {
  healthy: '推进中',
  stale: '停滞',
  blocked: '阻塞',
  needs_action: '缺下一步',
};
function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function readRawCache() {
  try {
    return JSON.parse(localStorage.getItem(HQ_CACHE_KEY) || '{}');
  } catch {
    return {};
  }
}

function readCache(reviewDate = hqReviewDateKey()) {
  return readHqCacheDate(readRawCache(), reviewDate);
}

function writeCache(patch, reviewDate = patch.brief?.reviewDate || patch.reviewDate || hqReviewDateKey()) {
  const next = mergeHqCacheDate(readRawCache(), patch, reviewDate);
  localStorage.setItem(HQ_CACHE_KEY, JSON.stringify(next));
  return readHqCacheDate(next, reviewDate);
}

function splitLines(value) {
  return String(value || '').split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
}

function formatDateTitle(dateKey) {
  const date = new Date(`${dateKey}T12:00:00`);
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  }).format(date);
}

function formatRelativeDate(value) {
  if (!value) return '尚无记录';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '尚无记录';
  const days = Math.max(0, Math.floor((Date.now() - date.getTime()) / 86400000));
  if (days === 0) return '今天有推进';
  if (days === 1) return '昨天有推进';
  return `${days} 天前推进`;
}

function taskMeta(task) {
  if (!task) return '';
  const parts = [];
  if (task.deviceContext === 'desktop') parts.push('电脑');
  if (task.deviceContext === 'mobile') parts.push('手机');
  if (task.deviceContext === 'universal') parts.push('通用');
  if (task.executionMode === 'ai') parts.push('交给 AI');
  if (task.dueDate) parts.push(`截止 ${new Date(task.dueDate).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`);
  return parts.join(' · ');
}

function formatCompletionTime(value) {
  if (!value) return '完成时间未记录';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '完成时间未记录';
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function renderStrategicCommitment(task) {
  if (!task) return '';
  const completedAt = task.completedAt || task.completionReceipt?.completedAt;
  return `
    <div class="hq-strategic-commitment ${task.isCompleted ? 'completed' : 'open'}">
      <span>ORIGINAL COMMITMENT · 今日原始战略承诺</span>
      <strong>${escapeHtml(task.content)}</strong>
      <small>${task.isCompleted ? `已于 ${escapeHtml(formatCompletionTime(completedAt))} 完成，不因接棒动作改写` : '当日固定，用于日省核对承诺是否命中'}</small>
    </div>
  `;
}

function renderActionSeat(actionState) {
  const strategic = actionState?.strategicCommitment || null;
  const task = actionState?.currentAction || null;
  if (!task) {
    const completed = actionState?.status === 'awaiting_candidate';
    return `
      ${renderStrategicCommitment(strategic)}
      <article class="hq-primary-empty ${completed ? 'commitment-complete' : ''}">
        <span>${completed ? '✓' : '01'}</span>
        <div>
          <p>${completed ? 'CURRENT ACTION · 当前行动席位空置' : 'CURRENT ACTION · 当前行动席位'}</p>
          <strong>${completed ? '今天的战略承诺已经闭环' : (strategic ? '当前没有执行中的接棒动作' : '今天还没有原始战略承诺')}</strong>
          <small>${completed ? '候选先过资格门槛，再按可解释投产比排序；确认后才接棒。' : '先确定一件能产生外部结果的行动。'}</small>
        </div>
        <div class="hq-empty-actions">
          <button id="editBriefEmpty">${strategic ? '从盒子选择当前动作' : '设置今日承诺'}</button>
          ${completed ? '<button class="subtle" id="viewTodayOutcomes">查看今日战果</button>' : ''}
        </div>
      </article>
    `;
  }
  const isHandoff = strategic && strategic.id !== task.id;
  return `
    ${renderStrategicCommitment(strategic)}
    <article class="hq-primary-action">
      <div class="hq-action-index"><span>NOW</span><strong>01</strong></div>
      <div class="hq-action-copy">
        <p>${isHandoff ? '当前行动席位 · 接棒动作' : '今日战略主动作 · 当前行动席位'}</p>
        <h2>${escapeHtml(task.content)}</h2>
        <small>${escapeHtml(taskMeta(task) || (isHandoff ? '原始承诺保持不变，完成后进入今日战果' : '完成后留下明确证据'))}</small>
      </div>
      <div class="hq-action-progress">
        <span>${Math.max(0, Math.min(100, Number(task.progress) || 0))}%</span>
        <i><b style="width:${Math.max(0, Math.min(100, Number(task.progress) || 0))}%"></b></i>
        <button data-open-task="${escapeHtml(task.id)}" data-command-role="primary">进入行动</button>
      </div>
    </article>
  `;
}

function renderActionCandidates(candidates = [], actionState = {}) {
  if (actionState.currentAction) return '';
  if (!candidates.length) return `
    <section class="hq-candidate-dock empty" id="hqActionCandidates">
      <div><span>NEXT BEST</span><strong>当前没有达到 55 分门槛的候选</strong><small>不为了填满席位推荐低价值任务；仍可手动选择。</small></div>
      <button id="hqManualCandidate">手动选择</button>
    </section>
  `;
  return `
    <section class="hq-candidate-dock" id="hqActionCandidates">
      <header><div><span>NEXT BEST · ROI ENGINE</span><h3>下一件高投产比行动</h3></div><small>最多 3 项 · 确认后进入行动席位</small></header>
      <div class="hq-candidate-list">${candidates.map((candidate, index) => `
        <article class="hq-candidate-card ${index === 0 ? 'recommended' : ''}">
          <div class="hq-candidate-score"><strong>${candidate.score}</strong><span>ROI</span></div>
          <div class="hq-candidate-copy">
            <p>${index === 0 ? '优先推荐' : `候选 ${index + 1}`} · ${escapeHtml(candidate.reason)}</p>
            <h4>${escapeHtml(candidate.title)}</h4>
            <small>完成标准：${escapeHtml(candidate.completionCriteria)}</small>
            <i>${candidate.estimatedMinutes ? `预计 ${candidate.estimatedMinutes} 分钟` : '预计时间待补充'} · ${candidate.sourceSystemId === 'mainline' ? '主线系统信号，确认后创建任务' : '盒子已有任务，来源可追溯'}</i>
          </div>
          <div class="hq-candidate-actions">
            <button class="primary" data-confirm-candidate="${escapeHtml(candidate.id)}">设为当前动作</button>
            <button data-skip-candidate="${escapeHtml(candidate.id)}">跳过 4 小时</button>
          </div>
        </article>
      `).join('')}</div>
      <button class="hq-candidate-manual" id="hqManualCandidate">从盒子手动选择</button>
    </section>
  `;
}

function renderMaintenance(tasks) {
  const filled = [...tasks];
  while (filled.length < 2) filled.push(null);
  return filled.slice(0, 2).map((task, index) => `
    <article class="hq-maintenance-card ${task ? '' : 'empty'}">
      <span>0${index + 2}</span>
      <div>
        <p>维护动作 ${index + 1}</p>
        <strong>${task ? escapeHtml(task.content) : '留空，不临时塞任务'}</strong>
        <small>${task ? escapeHtml(taskMeta(task) || '维持系统正常运转') : '最多两个维护动作'}</small>
      </div>
      ${task ? `<button data-open-task="${escapeHtml(task.id)}" data-command-role="maintenance" aria-label="进入任务">↗</button>` : ''}
    </article>
  `).join('');
}

function renderBehaviorList(items, type) {
  const fallback = type === 'stop' ? '今天还没有明确停止事项' : '尚未记录已验证有效的行为';
  return items.length
    ? items.map((item) => `<li><i>${type === 'stop' ? '×' : '✓'}</i><span>${escapeHtml(typeof item === 'string' ? item : item.text || item.title)}</span></li>`).join('')
    : `<li class="empty"><i>·</i><span>${fallback}</span></li>`;
}

function renderOutcomes(outcomes = {}) {
  return OUTCOME_FIELDS.map(([key, label]) => `
    <article>
      <strong>${Number.isFinite(Number(outcomes[key])) ? Number(outcomes[key]) : '—'}</strong>
      <span>${label}</span>
    </article>
  `).join('');
}

function renderTodayOutcomes(outcomes = []) {
  if (!outcomes.length) {
    return '<div class="hq-empty-panel compact"><strong>今天还没有完成回执</strong><span>在盒子完成任务后，原任务会带着完成证据进入这里。</span></div>';
  }
  return outcomes.map((task) => {
    const receipt = task.completionReceipt || {};
    const completedAt = task.completedAt || receipt.completedAt;
    return `
      <article class="hq-outcome-row ${task.isStrategicCommitment ? 'strategic' : ''}">
        <span class="hq-outcome-check">✓</span>
        <div>
          <p>${task.isStrategicCommitment ? 'STRATEGIC WIN · 原始承诺' : 'DONE · 今日完成'}</p>
          <strong>${escapeHtml(receipt.content || task.content)}</strong>
          <small>${escapeHtml(receipt.note || task.note || '已完成，回执中暂未填写说明')}</small>
        </div>
        <div class="hq-outcome-meta">
          <time>${escapeHtml(formatCompletionTime(completedAt))}</time>
          <button data-outcome-receipt="${escapeHtml(task.id)}">查看回执</button>
        </div>
      </article>
    `;
  }).join('');
}

function renderReviewLoop(reviewInput, reviewDate) {
  const review = normalizeReviewStatus(reviewInput, reviewDate);
  const statusLabel = review.status === 'synced' ? '今日日省已同步' : '今晚待复盘';
  const rateLabel = review.completionRate === null ? '证据不足' : `${review.completionRate}%`;
  const history = review.history.length ? review.history : Array.from({ length: 7 }, (_, index) => ({
    date: '',
    state: 'empty',
    result: '',
    placeholder: index,
  }));
  return `
    <section class="hq-review-loop ${review.status}">
      <div class="hq-review-copy">
        <span>DAILY REVIEW LOOP</span>
        <h2>日省闭环</h2>
        <p>参谋部定方向，盒子留证据，日省做结算。</p>
      </div>
      <div class="hq-review-status">
        <i></i>
        <div><strong>${statusLabel}</strong><small>${review.latestReviewAt ? `最近同步 ${escapeHtml(formatRelativeDate(review.latestReviewAt))}` : '完成日省后自动生成明日驾驶舱'}</small></div>
      </div>
      <div class="hq-review-evidence">
        <article><strong>${review.todayEvidence.completed}</strong><span>今日完成</span></article>
        <article><strong>${review.todayEvidence.progress}</strong><span>有进度</span></article>
        <article><strong>${review.todayEvidence.touched}</strong><span>触达任务</span></article>
      </div>
      <div class="hq-review-trend">
        <div><strong>${rateLabel}</strong><span>7 天唯一承诺完成率</span></div>
        <ol>${history.map((item) => `
          <li class="${escapeHtml(item.state || 'empty')}" title="${escapeHtml(item.result || '尚无判定')}">
            <i></i><span>${item.date ? escapeHtml(item.date.slice(5).replace('-', '/')) : '·'}</span>
          </li>
        `).join('')}</ol>
      </div>
      <button class="hq-review-button" id="hqReviewEvidence">查看今日事实包 <span>↗</span></button>
    </section>
  `;
}

function renderProject(project) {
  const total = Number(project.openTaskCount || 0) + Number(project.completedTaskCount || 0);
  const percent = total ? Math.round((Number(project.completedTaskCount || 0) / total) * 100) : 0;
  return `
    <button class="hq-project-card health-${escapeHtml(project.health || 'healthy')}" data-mainline="${escapeHtml(project.id)}">
      <span class="hq-project-signal"></span>
      <div class="hq-project-head">
        <span>${escapeHtml(HEALTH_LABELS[project.health] || '推进中')}</span>
        <small>${escapeHtml(formatRelativeDate(project.lastProgressAt))}</small>
      </div>
      <h3>${escapeHtml(project.name)}</h3>
      <p>${escapeHtml(project.currentPhase || project.outcome || '尚未填写当前阶段')}</p>
      <div class="hq-project-next">
        <small>下一步</small>
        <strong>${escapeHtml(project.nextAction?.content || '需要补一条可执行行动')}</strong>
      </div>
      <div class="hq-project-foot">
        <i><b style="width:${percent}%"></b></i>
        <span>${project.openTaskCount || 0} 项待推进</span>
      </div>
    </button>
  `;
}

function renderDecision(decision) {
  return `
    <article class="hq-decision-row ${decision.urgency === 'high' ? 'urgent' : ''}">
      <span class="hq-decision-mark">${decision.urgency === 'high' ? '!' : '?'}</span>
      <div>
        <strong>${escapeHtml(decision.title)}</strong>
        <p>${escapeHtml(decision.context || '需要明确继续、排期、拆小或停止。')}</p>
      </div>
      <button data-resolve-decision="${escapeHtml(decision.id)}">已决定</button>
    </article>
  `;
}

function renderSystem(system) {
  return `
    <button class="hq-system-card access-${escapeHtml(system.accessLevel.toLowerCase())} health-${escapeHtml(system.health)}" data-system-id="${escapeHtml(system.systemId)}" aria-label="查看${escapeHtml(system.name)}接入详情">
      <span class="hq-system-code">${escapeHtml(system.code)}</span>
      <div class="hq-system-copy">
        <header><strong>${escapeHtml(system.name)}</strong><em>${escapeHtml(system.access.label)}</em></header>
        <small>${escapeHtml(system.responsibility)}</small>
        <p>${escapeHtml(system.factSummary)}</p>
      </div>
      <i><b></b>${escapeHtml(system.healthLabel)}${system.candidateSignalCount ? ` · ${system.candidateSignalCount} 个行动信号` : ''}</i>
    </button>
  `;
}

function renderHqSystemEntryBand(systems = []) {
  const bootstrap = readFiveSystemBootstrapState();
  const baselineHistory = readFiveSystemBaselineHistory();
  const promoted = bootstrap?.promotedCounts;
  const baselineLabel = bootstrap?.mode === 'published_baseline'
    ? `基线 ${escapeHtml(bootstrap.activeBaselineVersion)} · 健康事实 ${escapeHtml(promoted?.healthObservations || 0)} · 时间事实 ${escapeHtml(promoted?.timeFacts || 0)} · 执行历史 ${escapeHtml(promoted?.executionHistory || 0)} · 反馈模式 ${escapeHtml(promoted?.feedbackObservedPatterns || 0)}`
    : bootstrap
      ? `已导入 ${escapeHtml(bootstrap.sourceReviewCount)} 份日省候选 · 尚未发布V1基线`
      : '尚未导入历史基线';
  const entries = [
    { systemId: 'mission', label: '使命', route: '#mission' },
    { systemId: 'health', label: '健康', route: '#health' },
    { systemId: 'time', label: '时间', route: '#time' },
    { systemId: 'execution', label: '执行', route: '#execution' },
    { systemId: 'feedback', label: '反馈', route: '#feedback' },
  ];
  return `
    <section class="hq-system-entry-band" aria-labelledby="hqSystemEntryTitle">
      <header>
        <div><span>FIVE SYSTEMS · 决策输入链</span><strong id="hqSystemEntryTitle">五系统固定入口</strong></div>
        <div class="hq-system-bootstrap"><small>${baselineLabel}</small><button id="hqBootstrapSystems">${bootstrap?.mode === 'published_baseline' ? '发布下一版基线' : '发布30日日省V1基线'}</button>${baselineHistory.length ? '<button id="hqRollbackSystems">回退上一版</button>' : ''}<input id="hqBootstrapSystemsFile" type="file" accept="application/json,.json" hidden></div>
      </header>
      <nav aria-label="五系统固定入口">
        ${entries.map((entry, index) => {
          const system = systems.find((item) => item.systemId === entry.systemId);
          const health = system?.health || 'unknown';
          const level = system?.access?.shortLabel || 'L0';
          const status = system?.healthLabel || '状态未知';
          const summary = system?.highestSignal || system?.factSummary || '等待系统事实';
          return `
            <a class="hq-system-entry health-${escapeHtml(health)}" href="${entry.route}" data-fixed-system-entry="${escapeHtml(entry.systemId)}">
              <span><b>${String(index + 1).padStart(2, '0')}</b>${escapeHtml(entry.label)}</span>
              <em>${escapeHtml(level)}</em>
              <strong>${escapeHtml(status)}</strong>
              <small>${escapeHtml(summary)}</small>
            </a>
          `;
        }).join('')}
      </nav>
    </section>
  `;
}

function renderProposal(proposal) {
  const type = proposalTypeMeta(proposal.proposalType);
  const status = proposalStatusMeta(proposal.status);
  const actions = proposalActionModel(proposal);
  const evidenceLabel = actions.provisionalMonthly
    ? '证据暂定，批准已锁定'
    : proposal.evidenceStatus === 'sufficient' ? '证据充分' : '证据待复核';
  return `
    <article class="hq-proposal-card status-${escapeHtml(status.tone)}">
      <header>
        <div><span>${escapeHtml(type.cadence)} · ${escapeHtml(type.label)}</span><strong>${escapeHtml(proposal.title)}</strong></div>
        <em>${escapeHtml(status.label)}</em>
      </header>
      <div class="hq-proposal-meta">
        <span>${escapeHtml(proposalPeriodLabel(proposal))}</span>
        <span>REV ${Number(proposal.revision) || 1}</span>
        <span>${escapeHtml(evidenceLabel)}</span>
      </div>
      <p>${escapeHtml(actions.writebackLabel)} · 来源 ${escapeHtml(proposal.sourceAuthority || 'unknown')}</p>
      <div class="hq-proposal-actions">
        ${actions.canApprove ? `<button class="primary" data-proposal-action="approve" data-proposal-id="${escapeHtml(proposal.decisionId)}">${proposal.proposalType === 'daily_action_proposal' ? '同意并入盒' : '同意'}</button>` : ''}
        ${actions.canPromote ? `<button class="primary" data-proposal-action="promote" data-proposal-id="${escapeHtml(proposal.decisionId)}">选择盒子并写入</button>` : ''}
        ${actions.canDefer ? `<button data-proposal-action="defer" data-proposal-id="${escapeHtml(proposal.decisionId)}">延期 7 天</button>` : ''}
        ${actions.canReject ? `<button data-proposal-action="reject" data-proposal-id="${escapeHtml(proposal.decisionId)}">拒绝</button>` : ''}
        <button data-proposal-detail="${escapeHtml(proposal.decisionId)}">审计</button>
      </div>
    </article>
  `;
}

function renderRejectedProposal(proposal) {
  return `<article class="hq-rejected-proposal">
    <div><span>${escapeHtml(proposalTypeMeta(proposal.proposalType).label)} · ${escapeHtml(proposalPeriodLabel(proposal))}</span><strong>${escapeHtml(proposal.title)}</strong></div>
    <button data-proposal-action="restore" data-proposal-id="${escapeHtml(proposal.decisionId)}">恢复审批</button>
  </article>`;
}

function chooseProposalBox(proposal) {
  const boxes = getBoxes().filter(isTaskBox);
  if (!boxes.length) {
    showToast('请先创建一个待办盒');
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (boxId = null) => {
      if (settled) return;
      settled = true;
      resolve(boxId);
    };
    const { root, close } = openSheet(`
      <div class="hq-proposal-picker-sheet">
        <div class="sheet-header hq-proposal-picker-head">
          <div><p class="eyebrow">APPROVE & ROUTE</p><h2>同意后放进哪个盒子？</h2></div>
          <button class="icon-btn" id="closeProposalBoxPicker">×</button>
        </div>
        <p class="sheet-lead">${escapeHtml(proposal.title)}</p>
        <div class="hq-proposal-box-picker">
          ${boxes.map((box) => `<button data-proposal-box="${escapeHtml(box.id)}"><span>${escapeHtml(box.icon || '□')}</span><strong>${escapeHtml(box.name)}</strong><small>同意并立即写入</small></button>`).join('')}
        </div>
      </div>
    `, { height: '70vh', onClose: () => finish(null) });
    root.querySelector('#closeProposalBoxPicker').addEventListener('click', close);
    root.querySelectorAll('[data-proposal-box]').forEach((button) => button.addEventListener('click', () => {
      finish(button.dataset.proposalBox);
      close();
    }));
  });
}

function showProposalUndo(proposal, onUndo) {
  document.querySelector('.hq-proposal-undo')?.remove();
  const banner = document.createElement('div');
  banner.className = 'hq-proposal-undo';
  banner.innerHTML = `<span>已拒绝：${escapeHtml(proposal.title)}</span><button type="button">撤销</button>`;
  document.body.appendChild(banner);
  const timer = setTimeout(() => banner.remove(), 6000);
  banner.querySelector('button').addEventListener('click', async () => {
    clearTimeout(timer);
    banner.remove();
    await onUndo();
  });
}

async function openProposalInspector(proposal) {
  let detail = proposal;
  try {
    detail = await requestTaskboxApi(`/hq/proposals/${encodeURIComponent(proposal.decisionId)}`) || proposal;
  } catch {}
  const events = Array.isArray(detail.auditTrail) ? detail.auditTrail : [];
  const { root, close } = openSheet(`
    <div class="sheet-header">
      <div><p class="eyebrow">PROPOSAL AUDIT · REV ${Number(detail.revision) || 1}</p><h2>${escapeHtml(detail.title)}</h2></div>
      <button class="icon-btn" id="closeHqProposal">×</button>
    </div>
    <div class="hq-proposal-sheet">
      <section><span>授权来源</span><strong>${escapeHtml(detail.sourceAuthority || 'unknown')}</strong><small>${escapeHtml(detail.standingRuleId || '无持续授权规则')}</small></section>
      <section><span>写回边界</span><strong>${escapeHtml(proposalActionModel(detail).writebackLabel)}</strong><small>${escapeHtml(detail.evidenceStatus || 'unknown')} evidence</small></section>
      <ol>${events.length ? events.map((event) => `
        <li><i>${escapeHtml(event.eventType)}</i><div><strong>${escapeHtml(event.actor)}</strong><span>${escapeHtml(event.note || `revision ${event.revision}`)}</span></div><time>${escapeHtml(formatSystemSyncTime(event.createdAt))}</time></li>
      `).join('') : '<li class="empty"><div><strong>审计记录加载中</strong><span>重新联网后可查看完整轨迹</span></div></li>'}</ol>
    </div>
  `, { height: '78vh' });
  root.querySelector('#closeHqProposal').addEventListener('click', close);
}

function formatSystemSyncTime(value) {
  if (!value) return '尚未成功同步';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '同步时间未知';
  return date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
}

function renderSystemLoop(system) {
  const stages = [
    ['发现', system.loopEvidence?.discovered],
    ['判断', system.loopEvidence?.judged],
    ['执行', system.loopEvidence?.executed],
    ['证据', system.loopEvidence?.evidenced],
    ['复盘', system.loopEvidence?.reviewed],
  ];
  return stages.map(([label, complete], index) => `
    <li class="${complete ? 'complete' : ''}"><span>${complete ? '✓' : index + 1}</span><strong>${label}</strong></li>
  `).join('');
}

function openSystemInspector(app, snapshot, system) {
  const triggerText = system.actionTriggers.length ? system.actionTriggers.join(' / ') : '当前无自动行动触发';
  const { root, close } = openSheet(`
    <div class="sheet-header">
      <div><p class="eyebrow">SYSTEM CONTRACT · ${escapeHtml(system.code)}</p><h2>${escapeHtml(system.name)}接入卡</h2></div>
      <button class="icon-btn" id="closeHqSystem">×</button>
    </div>
    <div class="hq-system-sheet">
      <section class="hq-system-verdict health-${escapeHtml(system.health)}">
        <div><span>${escapeHtml(system.access.label)}</span><strong>${escapeHtml(system.healthLabel)}</strong></div>
        <p>${escapeHtml(system.factSummary)}</p>
        <small>最后同步：${escapeHtml(formatSystemSyncTime(system.lastSyncAt))}</small>
      </section>
      <dl class="hq-system-contract">
        <div><dt>负责解释</dt><dd>${escapeHtml(system.responsibility)}</dd></div>
        <div><dt>唯一事实源</dt><dd>${escapeHtml(system.factSource)}</dd></div>
        <div><dt>读取方式</dt><dd>${escapeHtml(system.readMethod)}</dd></div>
        <div><dt>写回权限</dt><dd>${escapeHtml(system.writeMethod || '无；只读系统不修改原数据')}</dd></div>
        <div><dt>健康检查</dt><dd>${escapeHtml(system.healthCheck)}</dd></div>
        <div><dt>行动门槛</dt><dd>${escapeHtml(triggerText)}</dd></div>
        <div><dt>证据回流</dt><dd>${escapeHtml(system.evidenceReturn)}</dd></div>
        <div><dt>维护责任</dt><dd>${escapeHtml(system.owner)}</dd></div>
      </dl>
      <section class="hq-system-signal">
        <span>HIGHEST SIGNAL · 当前最高信号</span>
        <strong>${escapeHtml(system.highestSignal)}</strong>
        <small>${system.canWrite ? '只有用户确认后才执行写回。' : '该接入等级没有自动写回权限。'}</small>
      </section>
      ${system.systemId === 'mainline' ? `
        <section class="hq-system-loop">
          <div><span>READ-ONLY LOOP</span><h3>事实到复盘链路</h3></div>
          <ol>${renderSystemLoop(system)}</ol>
          <p>主线只提供事实；信号越过门槛后进入 ROI 判断，用户确认才在盒子创建行动，完成回执再交给日省。</p>
        </section>
      ` : ''}
      <div class="sheet-actions">
        ${system.action ? '<button class="btn primary" id="openHqSystemSource">进入对应界面</button>' : '<button class="btn" id="ackHqSystemLevel">知道了</button>'}
        ${system.candidateSignalCount ? '<button class="btn" id="viewHqSystemCandidates">查看行动候选</button>' : ''}
      </div>
    </div>
  `, { height: '88vh' });
  root.querySelector('#closeHqSystem').addEventListener('click', close);
  root.querySelector('#ackHqSystemLevel')?.addEventListener('click', close);
  root.querySelector('#openHqSystemSource')?.addEventListener('click', () => {
    close();
    if (system.action === 'execution') navigate('#execution');
    else if (system.action === 'home') navigate('#home');
    else if (system.action === 'mission') navigate('#mission');
    else if (system.action === 'health') navigate('#health');
    else if (system.action === 'time') navigate('#time');
    else if (system.action === 'feedback') navigate('#feedback');
    else if (system.action === 'projects') app.querySelector('#hqProjects')?.scrollIntoView({ behavior: 'smooth' });
    else if (system.action === 'brief') openBriefEditor(app, snapshot);
  });
  root.querySelector('#viewHqSystemCandidates')?.addEventListener('click', () => {
    close();
    app.querySelector('#hqActionCandidates')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
}

function renderSnapshot(app, snapshot, { remote = false } = {}) {
  const brief = normalizeHqBrief(snapshot.brief, snapshot.reviewDate);
  const actionState = snapshot.actionState || buildHqActionState(getTasks(), brief, snapshot.reviewDate);
  const projects = snapshot.projects || [];
  const candidates = buildHqActionCandidates({
    tasks: getTasks(),
    mainlines: getMainlines(),
    projects,
    brief,
    reviewDate: snapshot.reviewDate,
  });
  const maintenance = snapshot.commitments?.maintenance || [];
  const decisions = snapshot.decisions || [];
  const proposals = (snapshot.proposals || []).filter((item) => item.status !== 'rejected');
  const rejectedProposals = (snapshot.proposals || []).filter((item) => item.status === 'rejected');
  const proposalCalibration = summarizeProposalCalibration(snapshot);
  const closure = brief.yesterdayClosure || {};
  const riskCount = projects.filter((project) => ['blocked', 'stale', 'needs_action'].includes(project.health)).length;
  const syncState = getApiSyncState();
  const syncPresentation = describeHqSyncState(syncState, { remote });
  const tasks = getTasks();
  const systemSnapshots = readFiveSystemHqPorts({
    tasks, boxes: getBoxes(), mainlines: getMainlines(), brief,
    reviewDate: snapshot.reviewDate, syncState,
  });
  const systems = buildHqSystemViews({ snapshot, syncState, tasks, systemSnapshots, remote });
  const systemSummary = summarizeHqSystemViews(systems);

  app.innerHTML = `
    <main class="page hq-page">
      <section class="hq-command-deck safe-top">
        <div class="hq-command-top">
          <button class="hq-back" id="hqBack" aria-label="返回盒子">←</button>
          <div class="hq-title-block">
            <p>${escapeHtml(formatDateTitle(snapshot.reviewDate))} · COMMAND ${snapshot.reviewDate.replaceAll('-', '')}</p>
            <h1>人生参谋部</h1>
            <span>定方向，派行动，看结果。</span>
            <small class="hq-role-badge">MAIN PANEL · 主面板</small>
          </div>
          <div class="hq-command-tools">
            <span class="${syncPresentation.className}">${syncPresentation.label}</span>
            <button id="hqRefresh" aria-label="刷新">↻</button>
            <button id="hqEditBrief">编辑今日</button>
          </div>
        </div>
        <div class="hq-situation-line" aria-label="今日态势">
          <article><span>ACTIVE PROJECTS</span><strong>${projects.length}</strong><small>活跃项目</small></article>
          <article><span>APPROVALS</span><strong>${proposalCalibration.pending}</strong><small>待审批提案</small></article>
          <article><span>RISK SIGNALS</span><strong>${riskCount}</strong><small>项目预警</small></article>
          <article><span>AI QUEUE</span><strong>${snapshot.ai?.open || 0}</strong><small>AI执行中</small></article>
        </div>
        ${renderHqSystemEntryBand(systems)}
      </section>

      ${renderHqDimensionNav('day')}
      ${renderReviewLoop(snapshot.review, snapshot.reviewDate)}

      <section class="hq-grid hq-action-zone">
        <div class="hq-zone-label"><span>01</span><p>今日行动驾驶舱</p><small>只承诺 1 个主动作 + 2 个维护动作</small></div>
        <div class="hq-action-stack">
          ${renderActionSeat(actionState)}
          ${renderActionCandidates(candidates, actionState)}
          <div class="hq-maintenance-grid">${renderMaintenance(maintenance)}</div>
        </div>
        <aside class="hq-closure-card">
          <p>昨日承诺闭环</p>
          <strong>${escapeHtml(closure.result || '等待日省确认')}</strong>
          <span>${escapeHtml(closure.commitment || '完成结果只依据盒子记录和明确证据。')}</span>
          <small>${escapeHtml(closure.evidence || '尚无完成证据')}</small>
        </aside>
      </section>

      <section class="hq-grid hq-behavior-zone">
        <article class="hq-behavior-card stop">
          <div><span>STOP</span><h2>今天停止做</h2></div>
          <ul>${renderBehaviorList(brief.stopDoing, 'stop')}</ul>
        </article>
        <article class="hq-behavior-card continue">
          <div><span>KEEP</span><h2>继续保持</h2></div>
          <ul>${renderBehaviorList(brief.continueDoing, 'continue')}</ul>
        </article>
        <article class="hq-outcome-card">
          <div><span>RESULTS</span><h2>今日外部结果</h2></div>
          <section>${renderOutcomes(brief.outcomes)}</section>
        </article>
      </section>

      <section class="hq-section hq-outcome-ledger" id="hqTodayOutcomes" tabindex="-1" aria-labelledby="hqTodayOutcomesTitle">
        <div class="hq-section-head">
          <div><span>01B / TODAY OUTCOMES</span><h2 id="hqTodayOutcomesTitle">今日战果</h2></div>
          <p>${actionState.outcomes.length ? `${actionState.outcomes.length} 项完成事实` : '完成后自动进入，不占行动席位'}</p>
        </div>
        <div class="hq-outcome-list">${renderTodayOutcomes(actionState.outcomes)}</div>
      </section>

      <section class="hq-section" id="hqProjects">
        <div class="hq-section-head">
          <div><span>02 / PROJECT CENTER</span><h2>项目中心</h2></div>
          <p>${riskCount ? `${riskCount} 个项目需要注意` : '所有活跃项目均有下一步'}</p>
        </div>
        <div class="hq-project-grid">
          ${projects.length ? projects.map(renderProject).join('') : '<div class="hq-empty-panel"><strong>还没有活跃项目</strong><span>在盒子中建立主线后，这里会自动形成项目健康视图。</span></div>'}
        </div>
      </section>

      <section class="hq-section hq-proposal-zone" id="hqProposals">
        <div class="hq-section-head">
          <div><span>03 / REVIEW CALIBRATION</span><h2>复盘审批与受控写回</h2></div>
          <p>${proposalCalibration.pending ? `${proposalCalibration.pending} 项等待判断` : '当前提案均已处理'}</p>
        </div>
        <div class="hq-calibration-strip">
          <article><strong>${proposalCalibration.completionRate === null ? '—' : `${proposalCalibration.completionRate}%`}</strong><span>7 天承诺命中率</span></article>
          <article><strong>${proposalCalibration.cadenceCounts.daily}</strong><span>日省动作</span></article>
          <article><strong>${proposalCalibration.cadenceCounts.weekly}</strong><span>周省实验</span></article>
          <article><strong>${proposalCalibration.cadenceCounts.monthly}</strong><span>月省押注</span></article>
          <article class="${proposalCalibration.evidenceBlocked ? 'blocked' : ''}"><strong>${proposalCalibration.evidenceBlocked}</strong><span>证据护栏</span></article>
        </div>
        <p class="hq-proposal-rule">日省动作：批准后才进入盒子；周省实验与月省押注：批准后仍是战略对象。相同周期只增加 revision，不制造重复提案。</p>
        <div class="hq-proposal-grid">
          ${proposals.length ? proposals.map(renderProposal).join('') : '<div class="hq-empty-panel"><strong>没有待处理提案</strong><span>完成日省、周省或月省后，提案会按授权来源进入这里。</span></div>'}
        </div>
        <details class="hq-proposal-recycle">
          <summary><span>拒绝回收池</span><strong>${rejectedProposals.length}</strong><small>误拒绝的提案可恢复审批</small></summary>
          <div>${rejectedProposals.length ? rejectedProposals.map(renderRejectedProposal).join('') : '<p>回收池为空</p>'}</div>
        </details>
      </section>

      <section class="hq-split-zone">
        <div class="hq-section hq-decision-zone">
          <div class="hq-section-head">
            <div><span>04 / DECISION QUEUE</span><h2>待决策队列</h2></div>
            <button id="hqAddDecision">＋ 记录决策</button>
          </div>
          <div class="hq-decision-list">
            ${decisions.length ? decisions.map(renderDecision).join('') : '<div class="hq-empty-panel compact"><strong>当前没有悬而未决</strong><span>连续拖延、项目阻塞和方向冲突会进入这里。</span></div>'}
          </div>
        </div>

        <div class="hq-section hq-systems-zone">
          <div class="hq-section-head">
            <div><span>05 / SYSTEM CONTRACTS</span><h2>子系统接入卡</h2></div>
            <p>${systemSummary.l1} 个 L1 只读 · ${systemSummary.l2} 个 L2 受控${systemSummary.unknown ? ` · ${systemSummary.unknown} 个状态未知` : ''}</p>
          </div>
          <div class="hq-system-legend" aria-label="接入等级说明"><span>L0 入口</span><span>L1 只读</span><span>L2 受控写回</span></div>
          <div class="hq-system-grid">${systems.map(renderSystem).join('')}</div>
        </div>
      </section>
    </main>
  `;

  bindPageEvents(app, snapshot, candidates, systems);
}

function renderTaskOptions(tasks, selectedId, excludedIds = []) {
  return [
    '<option value="">暂不设置</option>',
    ...tasks
      .filter((task) => !excludedIds.includes(task.id))
      .map((task) => `<option value="${escapeHtml(task.id)}" ${task.id === selectedId ? 'selected' : ''}>${escapeHtml(task.content)}</option>`),
  ].join('');
}

function openOutcomeReceipt(task) {
  if (!task?.isCompleted) return;
  const box = getBoxes().find((item) => item.id === task.boxId) || {
    id: task.boxId || 'archived-box',
    name: task.completionReceipt?.boxName || '原任务盒',
    color: task.completionReceipt?.boxColor || 'idea',
  };
  const mainline = task.mainlineId ? getMainlines().find((item) => item.id === task.mainlineId) : null;
  openCompletionReceiptSheet({
    task,
    box,
    mainline,
    onPersist: (completionReceipt) => updateTask(task.id, { completionReceipt }),
  });
}

async function openReviewEvidence(snapshot) {
  let daily = null;
  try {
    daily = await requestTaskboxApi(`/daily-snapshot?date=${encodeURIComponent(snapshot.reviewDate)}`) || {
      tasks: [], completedTasks: [], progressTasks: [],
    };
  } catch {
    daily = { tasks: [], completedTasks: [], progressTasks: [] };
  }
  const completed = daily.completedTasks || [];
  const progress = daily.progressTasks || [];
  const risks = (snapshot.projects || []).filter((project) => ['blocked', 'stale', 'needs_action'].includes(project.health));
  const list = (items, emptyText) => items.length
    ? items.map((item) => `<li><strong>${escapeHtml(item.content || item.name || item.title)}</strong><small>${escapeHtml(item.completionEvidence || item.nextAction?.content || item.context || taskMeta(item) || '盒子已有事实记录')}</small></li>`).join('')
    : `<li class="empty"><strong>${emptyText}</strong><small>日省会保留“未记录”，不会自动补成 0 或未完成。</small></li>`;
  const { root, close } = openSheet(`
    <div class="sheet-header">
      <div><p class="eyebrow">DAILY REVIEW EVIDENCE</p><h2>${escapeHtml(snapshot.reviewDate)} 日省事实包</h2></div>
      <button class="icon-btn" id="closeReviewEvidence">×</button>
    </div>
    <div class="hq-evidence-sheet">
      <p class="hq-evidence-rule">以下内容来自盒子和参谋部，只作为事实输入；最终复盘仍保留原始证据和不确定状态。</p>
      <section><div><span>DONE</span><h3>今日明确完成</h3></div><ul>${list(completed, '今日还没有明确完成记录')}</ul></section>
      <section><div><span>PROGRESS</span><h3>今日推进记录</h3></div><ul>${list(progress, '今日还没有进度记录')}</ul></section>
      <section><div><span>RISKS</span><h3>项目预警</h3></div><ul>${list(risks, '当前没有项目预警')}</ul></section>
      <section><div><span>DECISIONS</span><h3>待决策</h3></div><ul>${list(snapshot.decisions || [], '当前没有待决策事项')}</ul></section>
    </div>
  `, { height: '88vh' });
  root.querySelector('#closeReviewEvidence').addEventListener('click', close);
}

function openBriefEditor(app, snapshot) {
  const allTasks = getTasks();
  const allMainlines = getMainlines();
  const tasks = allTasks.filter((task) => {
    if (task.deleted || task.isCompleted || task.isRecurringTemplate || !isTaskReleased(task)) return false;
    if (!task.mainlineId) return true;
    const mainline = allMainlines.find((item) => item.id === task.mainlineId);
    return Boolean(mainline && ['active', 'maintenance'].includes(mainline.status));
  });
  const brief = normalizeHqBrief(snapshot.brief, snapshot.reviewDate);
  const strategicCommitment = allTasks.find((task) => task.id === brief.strategicCommitmentTaskId) || null;
  const strategicCommitmentContent = brief.strategicCommitmentSnapshot?.content || strategicCommitment?.content || '';
  const strategicField = brief.strategicCommitmentTaskId
    ? `<div class="hq-locked-commitment"><span>今日原始战略承诺 · 已固定</span><strong>${escapeHtml(strategicCommitmentContent || '原始承诺任务记录暂不可用')}</strong><small>接棒动作只改变当前行动席位，不改写今天最初承诺。</small></div>`
    : `<label>今日原始战略承诺
        <select class="input" id="hqStrategicCommitment">${renderTaskOptions(tasks, brief.strategicCommitmentTaskId)}</select>
        <small>首次保存后固定，用于日省核对承诺命中率。</small>
      </label>`;
  const { root, close } = openSheet(`
    <div class="sheet-header">
      <div><p class="eyebrow">TODAY COMMAND</p><h2>编辑今日驾驶舱</h2></div>
      <button class="icon-btn" id="closeHqBrief">×</button>
    </div>
    <div class="hq-brief-form">
      ${strategicField}
      <label>当前行动席位
        <select class="input" id="hqCurrentAction">${renderTaskOptions(tasks, brief.currentActionTaskId)}</select>
        <small>候选引擎负责推荐；这里保留人工选择，用于并列分或主动替换。</small>
      </label>
      <div class="hq-form-pair">
        <label>维护动作 1
          <select class="input" id="hqMaintenanceOne">${renderTaskOptions(tasks, brief.maintenanceTaskIds[0], [brief.currentActionTaskId])}</select>
        </label>
        <label>维护动作 2
          <select class="input" id="hqMaintenanceTwo">${renderTaskOptions(tasks, brief.maintenanceTaskIds[1], [brief.currentActionTaskId])}</select>
        </label>
      </div>
      <div class="hq-form-pair">
        <label>今天停止做<textarea class="input" id="hqStopDoing" rows="4" placeholder="每行一项">${escapeHtml(brief.stopDoing.map((item) => typeof item === 'string' ? item : item.text || '').join('\n'))}</textarea></label>
        <label>继续保持<textarea class="input" id="hqContinueDoing" rows="4" placeholder="每行一项">${escapeHtml(brief.continueDoing.map((item) => typeof item === 'string' ? item : item.text || '').join('\n'))}</textarea></label>
      </div>
      <fieldset class="hq-outcome-editor">
        <legend>今日外部结果</legend>
        <div>${OUTCOME_FIELDS.map(([key, label]) => `<label>${label}<input class="input" type="number" min="0" id="hqOutcome_${key}" value="${escapeHtml(brief.outcomes[key] ?? '')}"></label>`).join('')}</div>
      </fieldset>
      <label>补充说明<textarea class="input" id="hqBriefNotes" rows="3" placeholder="只记录会影响今日决策的信息">${escapeHtml(brief.notes)}</textarea></label>
      <div class="sheet-actions">
        <button class="btn" id="cancelHqBrief">取消</button>
        <button class="btn primary" id="saveHqBrief">保存并派发到盒子</button>
      </div>
    </div>
  `, { height: '92vh' });

  root.querySelector('#closeHqBrief').addEventListener('click', close);
  root.querySelector('#cancelHqBrief').addEventListener('click', close);
  root.querySelector('#hqStrategicCommitment')?.addEventListener('change', (event) => {
    const current = root.querySelector('#hqCurrentAction');
    if (current && !current.value) current.value = event.target.value;
  });
  root.querySelector('#saveHqBrief').addEventListener('click', async () => {
    const strategicCommitmentTaskId = brief.strategicCommitmentTaskId
      || root.querySelector('#hqStrategicCommitment')?.value
      || null;
    const selectedStrategicTask = allTasks.find((task) => task.id === strategicCommitmentTaskId) || null;
    const strategicCommitmentSnapshot = brief.strategicCommitmentSnapshot
      || (selectedStrategicTask ? {
        taskId: selectedStrategicTask.id,
        content: selectedStrategicTask.content,
        committedAt: new Date().toISOString(),
      } : null);
    const selectedCurrentActionTaskId = root.querySelector('#hqCurrentAction').value || null;
    const currentActionTaskId = selectedCurrentActionTaskId
      || (!brief.strategicCommitmentTaskId ? strategicCommitmentTaskId : null);
    const maintenanceTaskIds = [
      root.querySelector('#hqMaintenanceOne').value,
      root.querySelector('#hqMaintenanceTwo').value,
    ].filter((id, index, all) => id && id !== currentActionTaskId && all.indexOf(id) === index);
    const outcomes = Object.fromEntries(OUTCOME_FIELDS.map(([key]) => {
      const value = root.querySelector(`#hqOutcome_${key}`).value;
      return [key, value === '' ? null : Math.max(0, Number(value) || 0)];
    }));
    const nextBrief = {
      ...brief,
      reviewDate: snapshot.reviewDate,
      primaryTaskId: strategicCommitmentTaskId,
      strategicCommitmentTaskId,
      strategicCommitmentSnapshot,
      currentActionTaskId,
      maintenanceTaskIds,
      stopDoing: splitLines(root.querySelector('#hqStopDoing').value),
      continueDoing: splitLines(root.querySelector('#hqContinueDoing').value),
      outcomes,
      notes: root.querySelector('#hqBriefNotes').value.trim(),
      source: 'hq',
      updatedAt: new Date().toISOString(),
    };
    writeCache({ brief: nextBrief });

    getTasks()
      .filter((task) => task.commitmentDate === snapshot.reviewDate && ['hq', 'daily_review'].includes(task.commitmentSource))
      .forEach((task) => updateTask(task.id, {
        commitmentRole: null,
        commitmentDate: null,
        commitmentSource: null,
        pinLevel: null,
        pinned: false,
      }));
    if (currentActionTaskId) updateTask(currentActionTaskId, {
      commitmentRole: 'primary',
      commitmentDate: snapshot.reviewDate,
      commitmentSource: 'hq',
      pinLevel: 1,
      pinned: true,
    });
    maintenanceTaskIds.forEach((taskId, index) => updateTask(taskId, {
      commitmentRole: 'maintenance',
      commitmentDate: snapshot.reviewDate,
      commitmentSource: 'hq',
      pinLevel: index + 2,
      pinned: true,
    }));

    try {
      const queuedMutation = queueTaskboxApiMutation(`/hq/daily-briefs/${snapshot.reviewDate}`, {
        method: 'POST',
        body: JSON.stringify(nextBrief),
      });
      if (!queuedMutation) throw new Error('api_disabled');
      await queuedMutation;
      showToast('今日驾驶舱已保存并派发');
    } catch {
      showToast('已保存到本机，云端将在连接恢复后再同步');
    }
    close();
    renderHqPage(app, { refreshRemote: true });
  });
}

function openDecisionEditor(app, snapshot) {
  const { root, close } = openSheet(`
    <div class="sheet-header">
      <div><p class="eyebrow">DECISION QUEUE</p><h2>记录一项必须决定的事</h2></div>
      <button class="icon-btn" id="closeHqDecision">×</button>
    </div>
    <div class="hq-brief-form">
      <label>要决定什么<input class="input" id="hqDecisionTitle" placeholder="例如：这个项目继续、排期、拆小还是暂停？"></label>
      <label>必要背景<textarea class="input" id="hqDecisionContext" rows="5" placeholder="只写做决定需要知道的事实"></textarea></label>
      <label class="hq-check-row"><input type="checkbox" id="hqDecisionUrgent"><span>今天必须处理</span></label>
      <div class="sheet-actions">
        <button class="btn" id="cancelHqDecision">取消</button>
        <button class="btn primary" id="saveHqDecision">加入待决策队列</button>
      </div>
    </div>
  `, { height: '66vh' });
  root.querySelector('#closeHqDecision').addEventListener('click', close);
  root.querySelector('#cancelHqDecision').addEventListener('click', close);
  root.querySelector('#saveHqDecision').addEventListener('click', async () => {
    const title = root.querySelector('#hqDecisionTitle').value.trim();
    if (!title) {
      showToast('先写清楚要决定什么');
      return;
    }
    const draft = {
      id: crypto.randomUUID?.() || `decision-${Date.now()}`,
      title,
      context: root.querySelector('#hqDecisionContext').value.trim(),
      urgency: root.querySelector('#hqDecisionUrgent').checked ? 'high' : 'normal',
      status: 'open',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const cache = readCache();
    writeCache({ decisions: [draft, ...(cache.decisions || [])] });
    try {
      await requestTaskboxApi('/hq/decisions', { method: 'POST', body: JSON.stringify(draft) });
      showToast('已加入待决策队列');
    } catch {
      showToast('已记录到本机');
    }
    close();
    renderHqPage(app, { refreshRemote: true });
  });
}

function bindPageEvents(app, snapshot, candidates = [], systems = []) {
  bindHqDimensionNav(app);
  app.querySelector('#hqBack').addEventListener('click', () => navigate('#home'));
  app.querySelector('#hqRefresh').addEventListener('click', async () => {
    showToast('正在刷新参谋部');
    await pullDataFromCloud({ force: true }).catch(() => null);
    renderHqPage(app, { refreshRemote: true });
  });
  app.querySelector('#hqEditBrief').addEventListener('click', () => openBriefEditor(app, snapshot));
  app.querySelector('#hqBootstrapSystems')?.addEventListener('click', () => app.querySelector('#hqBootstrapSystemsFile')?.click());
  app.querySelector('#hqBootstrapSystemsFile')?.addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const result = publishFiveSystemBaseline(await parseFiveSystemBootstrapFile(file), localStorage, {
        authorization: { sourceAuthority: 'explicit_user' },
      });
      if (!result.ok) throw new Error(result.errors.join('；'));
      showToast(`五系统历史基线 ${result.version.versionId} 已发布，可随时回退`);
      renderHqPage(app, { refreshRemote: false });
    } catch (error) {
      event.target.value = '';
      showToast(`初始化失败：${String(error?.message || error).slice(0, 90)}`);
    }
  });
  app.querySelector('#hqRollbackSystems')?.addEventListener('click', () => {
    if (!window.confirm('确认回退上一版五系统历史基线？当前版本的整批变更将原子撤销。')) return;
    const result = rollbackFiveSystemBaseline(localStorage, { authorization: { sourceAuthority: 'explicit_user' } });
    if (!result.ok) return showToast(`回退失败：${result.errors.join('；')}`);
    showToast(`已回退 ${result.rolledBackVersion}`);
    renderHqPage(app, { refreshRemote: false });
  });
  app.querySelector('#hqReviewEvidence')?.addEventListener('click', () => openReviewEvidence(snapshot));
  app.querySelector('#editBriefEmpty')?.addEventListener('click', () => openBriefEditor(app, snapshot));
  app.querySelector('#hqManualCandidate')?.addEventListener('click', () => openBriefEditor(app, snapshot));
  app.querySelectorAll('[data-confirm-candidate]').forEach((button) => {
    button.addEventListener('click', async () => {
      const candidate = candidates.find((item) => item.id === button.dataset.confirmCandidate);
      if (!candidate) return;
      button.disabled = true;
      const task = getTasks().find((item) => item.id === candidate.taskId)
        || getTasks().find((item) => item.candidateDedupeKey === candidate.dedupeKey)
        || getTasks().find((item) => item.syncKey === `hq-candidate:${candidate.dedupeKey}`)
        || null;
      if (task?.isCompleted || task?.deleted) {
        showToast('候选事实已变化，正在重新计算');
        renderHqPage(app, { refreshRemote: true });
        return;
      }
      const boxes = getBoxes();
      const targetBox = boxes.find((item) => item.color === 'important' || item.name === '重要盒')
        || boxes.find((item) => item.boxType === 'todo')
        || boxes[0]
        || null;
      try {
        const proposal = await requestTaskboxApi('/hq/proposals', {
          method: 'POST',
          body: JSON.stringify({
            proposalType: 'daily_action_proposal',
            sourceAuthority: 'explicit_user',
            title: candidate.title,
            idempotencyKey: `hq-candidate:${candidate.dedupeKey}`,
            existingTaskId: task?.id || null,
            shadowMode: false,
            content: { candidateId: candidate.id, score: candidate.score, reason: candidate.reason },
            evidence: { sourceSystemId: candidate.sourceSystemId, sourceRef: candidate.sourceRef },
            sourceRef: { type: 'hq_candidate', dedupeKey: candidate.dedupeKey },
            taskSpec: {
              content: candidate.title,
              note: candidate.completionCriteria,
              boxId: task?.boxId || candidate.suggestedBoxId || targetBox?.id || null,
              priority: task?.priority || 2,
              mainlineId: task?.mainlineId || candidate.mainlineId || null,
              deviceContext: task?.deviceContext || 'universal',
              executionMode: task?.executionMode || 'self',
              role: 'primary',
              commitmentDate: snapshot.reviewDate,
            },
            actor: 'hq_user',
          }),
        });
        const promoted = await requestTaskboxApi(`/hq/proposals/${encodeURIComponent(proposal.decisionId)}/promote`, {
          method: 'POST', body: JSON.stringify({ actor: 'hq_user', shadowMode: false }),
        });
        await pullDataFromCloud({ force: true });
        const promotedTask = getTasks().find((item) => item.id === promoted.taskId);
        if (!promotedTask) throw new Error('promoted_task_not_loaded');
        const brief = normalizeHqBrief(snapshot.brief, snapshot.reviewDate);
        const accepted = [...brief.candidateState.accepted, {
          candidateId: candidate.id,
          dedupeKey: candidate.dedupeKey,
          taskId: promotedTask.id,
          decisionId: proposal.decisionId,
          score: candidate.score,
          acceptedAt: new Date().toISOString(),
        }].slice(-20);
        const nextBrief = {
          ...brief,
          currentActionTaskId: promotedTask.id,
          candidateState: { ...brief.candidateState, accepted },
          source: 'hq_candidate_approval',
          updatedAt: new Date().toISOString(),
        };
        writeCache({ brief: nextBrief });
        const queuedMutation = queueTaskboxApiMutation(`/hq/daily-briefs/${snapshot.reviewDate}`, {
          method: 'POST', body: JSON.stringify(nextBrief),
        });
        if (!queuedMutation) throw new Error('api_disabled');
        await queuedMutation;
        showToast('已接棒：当前行动席位已更新');
      } catch (error) {
        showToast(error?.payload?.error === 'promotion_shadow_mode'
          ? '审批链仍在影子模式，未改动盒子'
          : '候选审批或晋升失败，未改动盒子');
      }
      renderHqPage(app, { refreshRemote: true });
    });
  });
  app.querySelectorAll('[data-skip-candidate]').forEach((button) => {
    button.addEventListener('click', async () => {
      const candidate = candidates.find((item) => item.id === button.dataset.skipCandidate);
      if (!candidate) return;
      const brief = normalizeHqBrief(snapshot.brief, snapshot.reviewDate);
      const nextBrief = {
        ...brief,
        candidateState: dismissHqCandidate(brief.candidateState, candidate),
        source: 'hq_candidate',
        updatedAt: new Date().toISOString(),
      };
      writeCache({ brief: nextBrief });
      queueTaskboxApiMutation(`/hq/daily-briefs/${snapshot.reviewDate}`, {
        method: 'POST', body: JSON.stringify(nextBrief),
      })?.catch(() => null);
      showToast('已跳过，4 小时内不再推荐');
      renderHqPage(app, { refreshRemote: false });
    });
  });
  app.querySelector('#viewTodayOutcomes')?.addEventListener('click', () => {
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    const outcomes = app.querySelector('#hqTodayOutcomes');
    outcomes?.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
    outcomes?.focus({ preventScroll: true });
  });
  app.querySelectorAll('[data-outcome-receipt]').forEach((button) => {
    button.addEventListener('click', () => {
      const task = resolveHqOutcomeTask(snapshot, getTasks(), button.dataset.outcomeReceipt);
      openOutcomeReceipt(task);
    });
  });
  app.querySelector('#hqAddDecision').addEventListener('click', () => openDecisionEditor(app, snapshot));
  app.querySelectorAll('[data-open-task]').forEach((button) => {
    button.addEventListener('click', () => {
      const task = getTasks().find((item) => item.id === button.dataset.openTask);
      const role = button.dataset.commandRole === 'maintenance' ? 'maintenance' : 'primary';
      if (task?.boxId) navigate(`#box/${encodeURIComponent(task.boxId)}/${encodeURIComponent(task.id)}/hq-${role}`);
    });
  });
  app.querySelectorAll('[data-mainline]').forEach((button) => {
    button.addEventListener('click', () => navigate(`#mainline/${button.dataset.mainline}`));
  });
  app.querySelectorAll('[data-proposal-detail]').forEach((button) => {
    button.addEventListener('click', () => {
      const proposal = (snapshot.proposals || []).find((item) => item.decisionId === button.dataset.proposalDetail);
      if (proposal) openProposalInspector(proposal);
    });
  });
  app.querySelectorAll('[data-proposal-action]').forEach((button) => {
    button.addEventListener('click', async () => {
      const action = button.dataset.proposalAction;
      const proposalId = button.dataset.proposalId;
      if (!action || !proposalId) return;
      const proposal = (snapshot.proposals || []).find((item) => item.decisionId === proposalId);
      if (!proposal) return;
      let boxId = null;
      if ((action === 'approve' && proposal.proposalType === 'daily_action_proposal') || action === 'promote') {
        boxId = await chooseProposalBox(proposal);
        if (!boxId) return;
      }
      const payload = { actor: 'hq_user' };
      if (action === 'defer') {
        const date = new Date();
        date.setDate(date.getDate() + 7);
        payload.deferUntil = date.toISOString().slice(0, 10);
        payload.note = '人生参谋部延期 7 天';
      }
      if (boxId) payload.boxId = boxId;
      if (action === 'promote') payload.shadowMode = false;
      button.disabled = true;
      try {
        await requestTaskboxApi(`/hq/proposals/${encodeURIComponent(proposalId)}/${action}`, {
          method: 'POST', body: JSON.stringify(payload),
        });
        if (action === 'approve' && proposal.proposalType === 'daily_action_proposal') {
          await requestTaskboxApi(`/hq/proposals/${encodeURIComponent(proposalId)}/promote`, {
            method: 'POST', body: JSON.stringify({ actor: 'hq_user', shadowMode: false }),
          });
        }
        await renderHqPage(app, { refreshRemote: true });
        if (action === 'reject') {
          showProposalUndo(proposal, async () => {
            await requestTaskboxApi(`/hq/proposals/${encodeURIComponent(proposalId)}/restore`, {
              method: 'POST', body: JSON.stringify({ actor: 'hq_user' }),
            });
            showToast('已撤销拒绝');
            await renderHqPage(app, { refreshRemote: true });
          });
        } else {
          showToast(action === 'approve'
            ? (proposal.proposalType === 'daily_action_proposal' ? '已同意并写入盒子' : '提案已同意')
            : action === 'promote' ? '已写入所选盒子'
              : action === 'defer' ? '已延期 7 天' : '已恢复到审批区');
        }
      } catch (error) {
        button.disabled = false;
        const message = String(error?.message || error || '');
        showToast(message.includes('provisional') ? '证据仍为暂定，月度押注暂不批准' : '操作未完成，请刷新后重试');
      }
    });
  });
  app.querySelectorAll('[data-resolve-decision]').forEach((button) => {
    button.addEventListener('click', async () => {
      const decisionId = button.dataset.resolveDecision;
      const cache = readCache();
      writeCache({
        decisions: (cache.decisions || []).map((decision) => decision.id === decisionId
          ? { ...decision, status: 'resolved', resolvedAt: new Date().toISOString() }
          : decision),
      });
      await requestTaskboxApi(`/hq/decisions/${encodeURIComponent(decisionId)}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'resolved' }),
      }).catch(() => null);
      showToast('已移出待决策队列');
      renderHqPage(app, { refreshRemote: true });
    });
  });
  app.querySelectorAll('[data-system-id]').forEach((button) => {
    button.addEventListener('click', () => {
      const system = systems.find((item) => item.systemId === button.dataset.systemId);
      if (system) openSystemInspector(app, snapshot, system);
    });
  });
}

export async function renderHqPage(app, { refreshRemote = true, dimension = 'day' } = {}) {
  const renderVersion = ++hqRenderVersion;
  if (dimension !== 'day') {
    await renderHqPeriodPage(app, { dimension, refreshRemote });
    return;
  }
  if (readFiveSystemBootstrapState()?.mode !== 'published_baseline' && !baselineAutoSyncAttempted) {
    baselineAutoSyncAttempted = true;
    try {
      const payload = await requestTaskboxApi('/system-baseline/current');
      if (payload) {
        const result = publishFiveSystemBaseline(payload, localStorage, {
          authorization: { sourceAuthority: 'explicit_user' },
        });
        if (!result.ok) throw new Error(result.errors.join('；'));
        showToast(`五系统历史基线 ${result.version.versionId} 已自动上线`);
      }
    } catch {
      // Keep the private-file fallback visible when API credentials or baseline are unavailable.
    }
  }
  const reviewDate = hqReviewDateKey();
  const cache = readCache(reviewDate);
  const localTasks = getTasks();
  const localBrief = freezeHqStrategicCommitmentSnapshot(cache.brief, localTasks, reviewDate);
  if (localBrief.strategicCommitmentSnapshot && !cache.brief?.strategicCommitmentSnapshot) {
    writeCache({ brief: localBrief });
  }
  const localSnapshot = buildLocalHqSnapshot({
    reviewDate,
    brief: localBrief,
    decisions: cache.decisions || [],
    tasks: localTasks,
    mainlines: getMainlines(),
  });
  renderSnapshot(app, localSnapshot, { remote: false });

  if (!refreshRemote) return;
  try {
    await waitForPendingApiMutations();
    if (renderVersion !== hqRenderVersion) return;
    await replayPendingApiMutations();
    if (renderVersion !== hqRenderVersion) return;
    if (getPendingApiMutationCount()) return;
    const remote = await requestTaskboxApi(`/hq/today?date=${encodeURIComponent(reviewDate)}`);
    const currentHash = window.location.hash || '#hq';
    const isHqRoute = currentHash === '#hq' || currentHash.startsWith('#hq/');
    if (!remote || renderVersion !== hqRenderVersion || !isHqRoute) return;
    const reconciled = reconcileHqSnapshotCommitments(remote, getTasks());
    writeCache({ brief: reconciled.brief, decisions: reconciled.decisions || [] });
    renderSnapshot(app, reconciled, { remote: true });
  } catch {
    const currentHash = window.location.hash || '#hq';
    const isHqRoute = currentHash === '#hq' || currentHash.startsWith('#hq/');
    if (renderVersion === hqRenderVersion && isHqRoute) renderSnapshot(app, localSnapshot, { remote: false });
  }
}
