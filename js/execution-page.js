import { getApiSyncState, getBoxes, getMainlines, getTasks } from './db.js';
import { navigate, showToast } from './app.js';
import {
  freezeHqStrategicCommitmentSnapshot,
  hqReviewDateKey,
  mergeHqCacheDate,
  readHqCacheDate,
} from './hq-model.js';
import {
  buildExecutionProposalDraft,
  deriveExecutionState,
  normalizeExecutionCandidates,
  taskSourceProposalId,
} from './execution-model.js';

const HQ_CACHE_KEY = 'taskbox_hq_cache_v1';
const EXECUTION_CANDIDATES_KEY = 'taskbox_execution_v2_candidates_v1';
const EXECUTION_PROPOSAL_DRAFTS_KEY = 'taskbox_execution_hq_proposal_drafts_v1';
const esc = (value = '') => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');

function taskHref(task, origin = 'hq-maintenance') {
  return `#box/${encodeURIComponent(task.boxId)}/${encodeURIComponent(task.id)}/${origin}`;
}

function formatTime(value) {
  if (!value) return '未排期';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '时间未知';
  return date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
}

function readBrief(reviewDate, tasks) {
  try {
    const raw = JSON.parse(localStorage.getItem(HQ_CACHE_KEY) || '{}');
    const brief = readHqCacheDate(raw, reviewDate).brief;
    const frozen = freezeHqStrategicCommitmentSnapshot(brief, tasks, reviewDate);
    if (!brief.strategicCommitmentSnapshot && frozen.strategicCommitmentSnapshot) {
      localStorage.setItem(HQ_CACHE_KEY, JSON.stringify(mergeHqCacheDate(raw, { brief: frozen }, reviewDate)));
    }
    return frozen;
  } catch {
    return {};
  }
}

function readJson(key, fallback) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || 'null');
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

function readCandidateInbox() {
  return normalizeExecutionCandidates(readJson(EXECUTION_CANDIDATES_KEY, []));
}

function parseCandidateFile(source = '') {
  const value = String(source || '').trim();
  if (!value) return [];
  if (value.startsWith('[')) return JSON.parse(value);
  return value.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function saveProposalDraft(candidate, reviewDate) {
  const draft = buildExecutionProposalDraft(candidate, { commitmentDate: reviewDate });
  const drafts = readJson(EXECUTION_PROPOSAL_DRAFTS_KEY, []);
  const next = [draft, ...drafts.filter((item) => item?.idempotencyKey !== draft.idempotencyKey)];
  localStorage.setItem(EXECUTION_PROPOSAL_DRAFTS_KEY, JSON.stringify(next));
  return draft;
}

function renderTask(task, { origin = 'hq-maintenance', state = '' } = {}) {
  const missing = task.readiness?.missing || [];
  const detail = state === 'waiting'
    ? (task.deferNote || `等待至 ${formatTime(task.visibleAfter)}`)
    : missing.length ? `缺：${missing.join('、')}` : `${Number(task.progress) || 0}% · ${formatTime(task.scheduledAt || task.dueDate)}`;
  const proposalId = task.approvedProposalId || taskSourceProposalId(task);
  return `<a class="execution-task" href="${taskHref(task, origin)}"><span>${esc(task.boxName || '行动盒子')}${proposalId ? ` · HQ提案 ${esc(proposalId)}` : ' · TaskBox原生'}</span><strong>${esc(task.content || '未命名动作')}</strong><small>${esc(detail)}</small><i>打开原任务 →</i></a>`;
}

function renderLane(title, code, items, empty, state) {
  return `<section class="execution-lane ${state}"><header><div><span>${code}</span><h2>${title}</h2></div><b>${items.length}</b></header><div class="execution-lane-items">${items.length ? items.map((task) => renderTask(task, { state })).join('') : `<p>${empty}</p>`}</div></section>`;
}

export function renderExecutionPage(app) {
  const reviewDate = hqReviewDateKey();
  const tasks = getTasks();
  const boxes = getBoxes();
  const state = deriveExecutionState({ tasks, boxes, mainlines: getMainlines(), brief: readBrief(reviewDate, tasks), reviewDate, syncState: getApiSyncState() });
  const candidateInbox = readCandidateInbox();
  const proposalDrafts = readJson(EXECUTION_PROPOSAL_DRAFTS_KEY, []);
  const current = state.currentAction;
  const strategic = state.strategicCommitment;
  const strategicCompletedAt = strategic?.completedAt || strategic?.completionReceipt?.completedAt;
  const strategicState = strategic?.isCompleted
    ? `已闭环${strategicCompletedAt ? ` · ${formatTime(strategicCompletedAt)}` : ''}`
    : strategic?.unavailable
      ? '任务事实暂不可用'
      : strategic
        ? (current?.id === strategic.id ? '正在行动席位' : '原始承诺保持不变')
        : '今天尚未设定';
  const syncLabel = state.metrics.pendingSync ? `${state.metrics.pendingSync} 项待同步` : navigator.onLine ? '事实已落盒子' : '离线 · 本地事实';
  app.innerHTML = `<main class="page execution-page safe-top safe-bottom">
    <header class="execution-top"><button id="executionBack" aria-label="返回人生参谋部">←</button><div><span>EXECUTION OS · ${esc(reviewDate)}</span><h1>把承诺变成现实</h1></div><em>${esc(syncLabel)}</em></header>
    <section class="execution-commitment ${strategic?.isCompleted ? 'completed' : ''}">
      <div><span>STRATEGIC COMMITMENT · 今日原始战略承诺</span><strong>${esc(strategic?.content || '尚未设置今日战略承诺')}</strong></div>
      <p>${esc(strategicState)}</p>
    </section>
    <section class="execution-seat ${current ? '' : 'empty'}">
      <div class="execution-seat-index">01</div><div class="execution-seat-copy"><span>CURRENT ACTION · 当前行动席位</span><h2>${esc(current?.content || (state.strategicCommitment?.isCompleted ? '战略承诺已闭环，等待下一项确认' : '当前席位空置'))}</h2><p>${current ? `${esc(current.note || '缺少完成标准')} · ${Number(current.progress) || 0}% · ${taskSourceProposalId(current) ? `来自已批准提案 ${esc(taskSourceProposalId(current))}` : 'TaskBox原生任务'}` : '只有用户确认的盒子任务才能进入这里。'}</p></div>
      ${current ? `<a href="${taskHref(current, 'hq-primary')}">继续执行 <b>→</b></a>` : '<button id="executionSetAction">回HQ设置</button>'}
    </section>
    <section class="execution-maintenance"><header><span>SUPPORT SLOTS</span><strong>维护动作 ${state.maintenance.length}/2</strong></header><div>${state.maintenance.length ? state.maintenance.map((task) => renderTask({ ...task, boxName: boxes.find((box) => box.id === task.boxId)?.name })).join('') : '<p>没有占用维护席位。保持系统轻盈。</p>'}</div></section>
    <section class="execution-flow-head"><div><span>ACTION PIPELINE</span><h2>行动流水线</h2></div><dl><div><dt>WIP</dt><dd class="${state.metrics.wipRisk ? 'risk' : ''}">${state.metrics.wipCount}/${state.metrics.wipLimit}</dd></div><div><dt>等待</dt><dd>${state.metrics.waitingCount}</dd></div><div><dt>战果</dt><dd>${state.metrics.outcomeCount}</dd></div></dl></section>
    <div class="execution-flow">
      ${renderLane('准备', 'READY?', state.lanes.preparation, '没有待补齐的动作。', 'preparation')}
      ${renderLane('执行', 'IN MOTION', state.lanes.active, '当前没有已就绪的执行中动作。', 'active')}
      ${renderLane('等待', 'BLOCKED / WAITING', state.lanes.waiting, '没有显式等待项。', 'waiting')}
    </div>
    <section class="execution-outcomes"><header><div><span>OUTCOME LEDGER</span><h2>今日战果</h2></div><b>${state.metrics.evidenceCount}/${state.metrics.outcomeCount} 有证据</b></header><div>${state.outcomes.length ? state.outcomes.map((task) => `<a href="${taskHref(task)}"><i>${task.needsHumanVerification ? '待验收' : task.hasEvidence ? '已结案' : '缺证据'}</i><strong>${esc(task.content)}</strong><small>${esc(task.completionReceipt?.note || task.note || '尚未留下完成证据说明')}</small><span>${esc(task.boxName)} · ${formatTime(task.completedAt || task.completionReceipt?.completedAt)}</span></a>`).join('') : '<p>今天还没有完成记录。完成任务后，证据会自动进入这里。</p>'}</div></section>
    <section class="execution-outcomes execution-candidates"><header><div><span>V2 CANDIDATE INBOX · READ ONLY</span><h2>执行候选隔离区</h2></div><b>${candidateInbox.metrics.total} 候选 · 0 事实 · 0 任务</b></header>
      <div>${candidateInbox.candidates.length ? candidateInbox.candidates.slice(0, 8).map((candidate) => `<article><i>${candidate.lineKind === 'checkbox' ? 'checkbox ≠ 任务' : `${esc(candidate.recordType)} ≠ 事实`}</i><strong>${esc(candidate.content)}</strong><small>${esc(candidate.authority)} · ${esc(candidate.dateMapping)} · ${esc(candidate.sourceRef)}</small><button data-execution-proposal="${esc(candidate.claimId)}">生成 HQ 接口草案</button></article>`).join('') : '<p>尚未导入V2执行候选。导入只会写入本地只读候选层，不会创建TaskBox任务。</p>'}</div>
      <footer><label for="executionCandidateImport">导入 V2 JSON/JSONL</label><input id="executionCandidateImport" type="file" accept="application/json,.json,.jsonl" hidden><span>${proposalDrafts.length} 份接口草案等待公共HQ链消费；生成草案不等于批准或promote。</span></footer>
    </section>
    <footer class="execution-rule">TaskBox保存任务、进度与证据；本页只负责观察和推进，不复制事实。</footer>
  </main>`;
  app.querySelector('#executionBack').onclick = () => navigate('#hq');
  app.querySelector('#executionSetAction')?.addEventListener('click', () => navigate('#hq'));
  app.querySelector('#executionCandidateImport')?.addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const imported = normalizeExecutionCandidates(parseCandidateFile(await file.text()));
      localStorage.setItem(EXECUTION_CANDIDATES_KEY, JSON.stringify(imported.candidates));
      showToast(`已隔离导入 ${imported.metrics.total} 条执行候选；未创建任务`);
      renderExecutionPage(app);
    } catch {
      event.target.value = '';
      showToast('V2候选文件无法读取，未写入候选层');
    }
  });
  app.querySelectorAll('[data-execution-proposal]').forEach((button) => button.addEventListener('click', () => {
    const candidate = candidateInbox.candidates.find((item) => item.claimId === button.dataset.executionProposal);
    if (!candidate) return;
    saveProposalDraft(candidate, reviewDate);
    showToast('已生成幂等HQ接口草案；尚未批准或写入TaskBox');
    renderExecutionPage(app);
  }));
}
