import {
  addBranch,
  addTask,
  deleteBranch,
  getBoxes,
  getBranches,
  getMainlines,
  getSettings,
  getTasks,
  updateBranch,
  updateTask,
} from './db.js';
import { navigate, openSheet, showToast } from './app.js';
import { isTaskBox } from './box-types.js';
import { renderCoreBoxNav } from './core-box-nav.js';
import { getTaskPointValue } from './points-store.js';
import { fromDateTimeLocalValue } from './task-utils.js';
import { bindDeviceContextField, getTaskContextRank, renderDeviceContextField } from './task-visibility.js';
import { bindExecutionModeField, getExecutionModeLabel, renderExecutionModeField } from './task-execution.js';

export const BRANCH_STATUS_LABELS = {
  idea: '构思中',
  planned: '待启动',
  active: '进行中',
  wrapping: '待收尾',
  completed: '已完成',
  paused: '已暂停',
  abandoned: '已放弃',
};

const BRANCH_TYPES = {
  project: ['项目', '◫'],
  travel: ['旅行', '⌁'],
  experiment: ['实验', '⌬'],
  growth: ['成长', '↗'],
  relationship: ['关系', '◎'],
  life: ['生活', '⌂'],
};

const BRANCH_COLORS = [
  ['#287a78', '#bfe9df', '潮汐青'],
  ['#4268a9', '#c9d8f4', '远行蓝'],
  ['#9a5c28', '#efd2a9', '岩茶棕'],
  ['#a54162', '#f0c0cf', '山莓红'],
  ['#4d7048', '#cce0bd', '苔原绿'],
  ['#73559b', '#dac9ee', '晶簇紫'],
  ['#a44c39', '#efc0b2', '陶土橙'],
  ['#53626d', '#cad3d8', '铅笔灰'],
];

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function safeColor(value) {
  return /^#[0-9a-f]{6}$/i.test(value || '') ? value : BRANCH_COLORS[0][0];
}

function formatDate(value) {
  if (!value) return '未设日期';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '未设日期';
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

function getBranchTasks(branchId) {
  return getTasks().filter((task) => task.branchId === branchId);
}

export function openBranchEditor(branch = null, mainlineId = null, onDone = () => {}) {
  const mainlines = getMainlines().filter((line) => line.status !== 'completed' || line.id === branch?.mainlineId);
  const selectedMainlineId = branch?.mainlineId || mainlineId || mainlines[0]?.id || '';
  if (!selectedMainlineId) return showToast('先建立一条主线');
  const initialType = branch?.branchType || 'project';
  const initialColor = safeColor(branch?.color);
  const { root, close } = openSheet(`
    <div class="sheet-handle"></div>
    <div class="sheet-content branch-editor">
      <p class="eyebrow">Side Quest</p>
      <h3>${branch ? '修改支线' : '添加主线支线'}</h3>
      <p class="sheet-lead">支线是一段可以单独打开、推进和完成的经历；具体行动仍放进盒子。</p>
      <label>支线名称<input id="branchName" class="input" value="${escapeHtml(branch?.name || '')}" placeholder="例如：去青岛住一周"></label>
      <label>所属主线<select id="branchMainline" class="input">${mainlines.map((line) => `<option value="${line.id}" ${line.id === selectedMainlineId ? 'selected' : ''}>${escapeHtml(line.name)}</option>`).join('')}</select></label>
      <fieldset class="branch-type-field">
        <legend>支线类型</legend>
        <div class="branch-type-options">${Object.entries(BRANCH_TYPES).map(([value, [label, icon]]) => `<button type="button" data-branch-type="${value}" class="${value === initialType ? 'active' : ''}"><b>${icon}</b><span>${label}</span></button>`).join('')}</div>
      </fieldset>
      <label>为什么要做<textarea id="branchDescription" class="input" rows="3" placeholder="这段支线值得记录的原因">${escapeHtml(branch?.description || '')}</textarea></label>
      <label>完成标准<textarea id="branchCriteria" class="input" rows="2" placeholder="发生什么，才算这条支线真正完成">${escapeHtml(branch?.completionCriteria || '')}</textarea></label>
      <label>下一步<input id="branchNextAction" class="input" value="${escapeHtml(branch?.nextAction || '')}" placeholder="最小且具体的下一步"></label>
      <div class="mainline-editor-grid">
        <label>状态<select id="branchStatus" class="input">${Object.entries(BRANCH_STATUS_LABELS).map(([value, label]) => `<option value="${value}" ${value === (branch?.status || 'planned') ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
        <label>目标日期<input id="branchTarget" class="input" type="date" value="${escapeHtml((branch?.targetDate || '').slice(0, 10))}"></label>
      </div>
      <label>识别色<div class="branch-color-picker">${BRANCH_COLORS.map(([value, accent, name]) => `<button type="button" data-branch-color="${value}" class="${value === initialColor ? 'active' : ''}" style="--branch-color:${value};--branch-accent:${accent}" title="${name}" aria-label="${name}"></button>`).join('')}</div></label>
      ${branch ? `<label>支线记录<textarea id="branchReview" class="input" rows="4" placeholder="沿途发现、复盘或纪念">${escapeHtml(branch.review || '')}</textarea></label>` : ''}
      <div class="sheet-actions">
        ${branch ? '<button class="btn danger" id="deleteBranchBtn">删除</button>' : '<button class="btn" id="cancelBranchBtn">取消</button>'}
        <button class="btn primary" id="saveBranchBtn">保存支线</button>
      </div>
    </div>
  `, { height: '90vh' });
  let color = initialColor;
  let branchType = initialType;
  root.querySelectorAll('[data-branch-color]').forEach((button) => button.addEventListener('click', () => {
    color = button.dataset.branchColor;
    root.querySelectorAll('[data-branch-color]').forEach((item) => item.classList.toggle('active', item === button));
  }));
  root.querySelectorAll('[data-branch-type]').forEach((button) => button.addEventListener('click', () => {
    branchType = button.dataset.branchType;
    root.querySelectorAll('[data-branch-type]').forEach((item) => item.classList.toggle('active', item === button));
  }));
  root.querySelector('#cancelBranchBtn')?.addEventListener('click', close);
  root.querySelector('#deleteBranchBtn')?.addEventListener('click', (event) => {
    if (event.currentTarget.dataset.confirm !== '1') {
      event.currentTarget.dataset.confirm = '1';
      event.currentTarget.textContent = '再点一次确认删除';
      return;
    }
    deleteBranch(branch.id);
    close();
    showToast('支线已删除，关联任务已保留在原盒子');
    onDone(null);
  });
  const save = () => {
    const name = root.querySelector('#branchName').value.trim();
    if (!name) return showToast('先填写支线名称');
    const payload = {
      mainlineId: root.querySelector('#branchMainline').value,
      name,
      branchType,
      status: root.querySelector('#branchStatus').value,
      color,
      icon: BRANCH_TYPES[branchType]?.[1] || '◇',
      description: root.querySelector('#branchDescription').value.trim(),
      completionCriteria: root.querySelector('#branchCriteria').value.trim(),
      nextAction: root.querySelector('#branchNextAction').value.trim(),
      targetDate: root.querySelector('#branchTarget').value || null,
      review: root.querySelector('#branchReview')?.value.trim() || branch?.review || '',
    };
    try {
      const saved = branch ? updateBranch(branch.id, payload) : addBranch(payload.mainlineId, payload);
      close();
      showToast(branch ? '支线已更新' : '支线已添加');
      onDone(saved);
    } catch (error) {
      const messages = {
        'branch limit': '同一主线同时推进的支线最多 6 条',
        'branch exists': '这条主线下已有同名支线',
      };
      showToast(messages[error.message] || '支线保存失败');
    }
  };
  root.querySelector('#saveBranchBtn').addEventListener('click', save);
  root.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      save();
    }
  });
}

function openBranchTaskEditor(branch, onDone) {
  const boxes = getBoxes().filter(isTaskBox);
  const defaultBox = boxes.find((box) => box.color === 'important') || boxes[0];
  if (!defaultBox) return showToast('先创建一个待办类型盒子');
  const { root, close } = openSheet(`
    <div class="sheet-handle"></div>
    <div class="sheet-content branch-task-editor">
      <p class="eyebrow">Branch Action</p>
      <h3>推进“${escapeHtml(branch.name)}”</h3>
      <label>具体行动<input id="branchTaskContent" class="input" placeholder="下一步要做什么"></label>
      <label>所属盒子<select id="branchTaskBox" class="input">${boxes.map((box) => `<option value="${box.id}" ${box.id === defaultBox.id ? 'selected' : ''}>${escapeHtml(box.name)}</option>`).join('')}</select></label>
      <div class="mainline-editor-grid">
        <label>计划时间<input id="branchTaskScheduled" class="input" type="datetime-local"></label>
        <label>截止时间<input id="branchTaskDue" class="input" type="datetime-local"></label>
      </div>
      ${renderDeviceContextField('desktop', 'branch-task-device')}
      ${renderExecutionModeField('self', 'branch-task-execution')}
      <label>完成积分<input id="branchTaskPoints" class="input" type="number" min="0" value="${getTaskPointValue({ boxId: defaultBox.id }, defaultBox)}"></label>
      <div class="sheet-actions"><button class="btn" id="cancelBranchTask">取消</button><button class="btn primary" id="saveBranchTask">加入盒子</button></div>
    </div>
  `, { height: '78vh' });
  const deviceField = bindDeviceContextField(root, 'branch-task-device', 'desktop');
  const executionField = bindExecutionModeField(root, 'branch-task-execution', 'self');
  root.querySelector('#cancelBranchTask').addEventListener('click', close);
  root.querySelector('#branchTaskBox').addEventListener('change', (event) => {
    const box = boxes.find((item) => item.id === event.target.value);
    root.querySelector('#branchTaskPoints').value = getTaskPointValue({ boxId: box?.id }, box);
  });
  const save = () => {
    const content = root.querySelector('#branchTaskContent').value.trim();
    if (!content) return showToast('先写清楚下一步行动');
    addTask({
      content,
      boxId: root.querySelector('#branchTaskBox').value,
      mainlineId: branch.mainlineId,
      branchId: branch.id,
      scheduledAt: fromDateTimeLocalValue(root.querySelector('#branchTaskScheduled').value),
      dueDate: fromDateTimeLocalValue(root.querySelector('#branchTaskDue').value),
      pointsValue: Math.max(0, Number(root.querySelector('#branchTaskPoints').value) || 0),
      deviceContext: deviceField.getValue(),
      executionMode: executionField.getValue(),
    });
    close();
    showToast('支线行动已加入盒子');
    onDone();
  };
  root.querySelector('#saveBranchTask').addEventListener('click', save);
}

function openCompleteBranchSheet(branch, onDone) {
  const pending = getBranchTasks(branch.id).filter((task) => !task.isCompleted);
  const { root, close } = openSheet(`
    <div class="sheet-handle"></div>
    <div class="sheet-content branch-complete-sheet">
      <p class="eyebrow">Close The Loop</p>
      <h3>完成这条支线</h3>
      <p class="sheet-lead">${pending.length ? `还有 ${pending.length} 个行动未完成。你可以保留关联，或将它们释放回原盒子。` : '这段经历已经形成闭环，写下一句带走的东西。'}</p>
      <label>支线复盘<textarea id="branchCompleteReview" class="input" rows="5" placeholder="发生了什么？以后还想记住什么？">${escapeHtml(branch.review || '')}</textarea></label>
      <div class="branch-complete-actions">
        ${pending.length ? '<button class="btn" id="completeReleaseTasks">完成并释放未完成任务</button>' : ''}
        <button class="btn primary" id="completeKeepTasks">完成支线${pending.length ? '，保留关联' : ''}</button>
      </div>
    </div>
  `, { height: '58vh' });
  const complete = (releaseTasks) => {
    if (releaseTasks) pending.forEach((task) => updateTask(task.id, { branchId: null }));
    updateBranch(branch.id, {
      status: 'completed',
      review: root.querySelector('#branchCompleteReview').value.trim(),
      completedAt: new Date().toISOString(),
    });
    close();
    showToast(releaseTasks ? '支线已完成，未完成任务已释放' : '支线已完成');
    onDone();
  };
  root.querySelector('#completeKeepTasks').addEventListener('click', () => complete(false));
  root.querySelector('#completeReleaseTasks')?.addEventListener('click', () => complete(true));
}

export function renderBranchPage(app, branchId) {
  const branch = getBranches().find((item) => item.id === branchId);
  if (!branch) return navigate('#home');
  const mainline = getMainlines().find((item) => item.id === branch.mainlineId);
  if (!mainline) return navigate('#home');
  const tasks = getBranchTasks(branch.id);
  const boxes = getBoxes();
  const boxMap = new Map(boxes.map((box) => [box.id, box]));
  const openTasks = tasks.filter((task) => !task.isCompleted);
  const color = safeColor(branch.color);
  const typeLabel = BRANCH_TYPES[branch.branchType]?.[0] || '项目';

  app.innerHTML = `
    <main class="page branch-page" style="--branch-color:${color};--mainline-color:${safeColor(mainline.color)}">
      <header class="topbar safe-top">
        <button class="icon-btn icon-btn-ghost" id="branchBack" aria-label="返回主线">←</button>
        <div class="topbar-core-actions">${renderCoreBoxNav()}<button class="icon-btn icon-btn-ghost" id="editBranch" aria-label="修改支线">✎</button></div>
      </header>
      <section class="branch-hero panel">
        <div class="branch-breadcrumb"><button id="branchMainlineLink">◆ ${escapeHtml(mainline.name)}</button><span>/</span><b>${escapeHtml(typeLabel)}</b></div>
        <div class="branch-title-row"><span>${escapeHtml(branch.icon)}</span><div><p>${escapeHtml(BRANCH_STATUS_LABELS[branch.status] || branch.status)}</p><h1>${escapeHtml(branch.name)}</h1></div></div>
        <p class="branch-description">${escapeHtml(branch.description || '还没有写下这条支线为什么值得开始。')}</p>
        <div class="branch-date-stamp"><small>目标日期</small><strong>${formatDate(branch.targetDate)}</strong></div>
      </section>
      <section class="branch-field-note panel">
        <p class="eyebrow">Next Move</p>
        <strong>${escapeHtml(branch.nextAction || openTasks[0]?.content || '先补一个足够小的下一步。')}</strong>
        <button class="btn primary compact" id="addBranchTask">＋ 行动</button>
      </section>
      <section class="branch-criteria panel">
        <p class="eyebrow">Done Means</p>
        <p>${escapeHtml(branch.completionCriteria || '还没有定义完成标准。')}</p>
      </section>
      <section class="section-heading branch-section-heading"><div><p class="eyebrow">Action Log</p><h2>关联行动</h2></div><p class="section-note">${openTasks.length} 待办 · ${tasks.length - openTasks.length} 完成</p></section>
      <section class="mainline-task-list branch-task-list">
        ${tasks.length ? [...tasks].sort((a, b) => Number(a.isCompleted) - Number(b.isCompleted) || getTaskContextRank(a, getSettings()) - getTaskContextRank(b, getSettings()) || new Date(a.dueDate || a.createdAt) - new Date(b.dueDate || b.createdAt)).map((task) => `
          <button class="mainline-task-row execution-${escapeHtml(task.executionMode || 'self')} ${task.isCompleted ? 'completed' : ''}" data-open-task-box="${task.boxId}">
            <i>${task.isCompleted ? '✓' : (task.executionMode === 'ai' ? '✦' : '')}</i>
            <span><strong>${escapeHtml(task.content)}</strong><small>${escapeHtml(boxMap.get(task.boxId)?.name || '盒子')} · ${escapeHtml(getExecutionModeLabel(task.executionMode))} · ${formatDate(task.dueDate || task.scheduledAt)}</small></span>
          </button>
        `).join('') : '<div class="empty-state branch-empty"><div>⌁</div><h3>这条支线还没有行动</h3><p>添加一个能在盒子里直接完成的动作。</p></div>'}
      </section>
      ${branch.review ? `<section class="branch-review panel"><p class="eyebrow">Field Notes</p><p>${escapeHtml(branch.review).replaceAll('\n', '<br>')}</p></section>` : ''}
      ${branch.status === 'completed' ? `<div class="branch-closed-mark"><span>✓</span><strong>支线已完成</strong><small>${formatDate(branch.completedAt)}</small></div>` : `<button class="btn branch-complete-btn" id="completeBranch">完成这条支线</button>`}
    </main>
  `;

  app.querySelector('#branchBack').addEventListener('click', () => navigate(`#mainline/${mainline.id}`));
  app.querySelector('#branchMainlineLink').addEventListener('click', () => navigate(`#mainline/${mainline.id}`));
  app.querySelector('#editBranch').addEventListener('click', () => openBranchEditor(branch, mainline.id, (saved) => saved ? renderBranchPage(app, branch.id) : navigate(`#mainline/${mainline.id}`)));
  app.querySelector('#addBranchTask').addEventListener('click', () => openBranchTaskEditor(branch, () => renderBranchPage(app, branch.id)));
  app.querySelector('#completeBranch')?.addEventListener('click', () => openCompleteBranchSheet(branch, () => renderBranchPage(app, branch.id)));
  app.querySelectorAll('[data-open-task-box]').forEach((button) => button.addEventListener('click', () => navigate(`#box/${button.dataset.openTaskBox}`)));
}
