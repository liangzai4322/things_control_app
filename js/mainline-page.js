import {
  addMainline,
  addMilestone,
  addTask,
  deleteMainline,
  deleteMilestone,
  getBoxes,
  getMainlines,
  getMilestones,
  getTasks,
  updateMainline,
  updateMilestone,
} from './db.js';
import { navigate, openSheet, showToast } from './app.js';
import { isTaskBox } from './box-types.js';
import { renderCoreBoxNav } from './core-box-nav.js';
import { getTaskPointValue } from './points-store.js';
import { fromDateTimeLocalValue } from './task-utils.js';

const MAINLINE_COLORS = ['#e85d45', '#dc8a2f', '#159b8a', '#377fae', '#69795e'];
const STATUS_LABELS = { active: '推进中', maintenance: '维持中', paused: '已暂停', completed: '已完成' };

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function safeColor(value) {
  return /^#[0-9a-f]{6}$/i.test(value || '') ? value : MAINLINE_COLORS[0];
}

function formatDate(value) {
  if (!value) return '暂未设定';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '暂未设定';
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

function mainlineMetrics(mainline, milestones, tasks) {
  const openTasks = tasks.filter((task) => !task.isCompleted);
  const completedMilestones = milestones.filter((milestone) => milestone.status === 'completed').length;
  const milestoneProgress = milestones.length ? Math.round((completedMilestones / milestones.length) * 100) : 0;
  const nextAction = [...openTasks].sort((left, right) => new Date(left.dueDate || left.scheduledAt || left.createdAt) - new Date(right.dueDate || right.scheduledAt || right.createdAt))[0] || null;
  const recentCompletion = tasks.filter((task) => task.isCompleted && task.completedAt)
    .sort((left, right) => new Date(right.completedAt) - new Date(left.completedAt))[0];
  const stale = recentCompletion && Date.now() - new Date(recentCompletion.completedAt).getTime() > 7 * 86400000;
  return { openTasks, completedMilestones, milestoneProgress, nextAction, stale };
}

export function openMainlineEditor(mainline = null, onDone = () => {}) {
  const lines = getMainlines();
  const activeCount = lines.filter((item) => item.status === 'active' || item.status === 'maintenance').length;
  const focusCount = lines.filter((item) => item.isWeeklyFocus && item.id !== mainline?.id).length;
  const { root, close } = openSheet(`
    <div class="sheet-handle"></div>
    <div class="sheet-content mainline-editor">
      <p class="eyebrow">Main Thread</p>
      <h3>${mainline ? '修改主线' : '建立一条主线'}</h3>
      <p class="sheet-lead">主线说明任务为什么存在。保持 2–5 条，每条都要能说清最终成果和下一阶段。</p>
      <label>主线名称<input id="mainlineName" class="input" value="${escapeHtml(mainline?.name || '')}" placeholder="例如：公众号商业化"></label>
      <label>最终成果<textarea id="mainlineOutcome" class="input" rows="3" placeholder="完成到什么程度，才算这条主线结束">${escapeHtml(mainline?.outcome || '')}</textarea></label>
      <label>当前阶段<input id="mainlinePhase" class="input" value="${escapeHtml(mainline?.currentPhase || '')}" placeholder="例如：验证第一版产品"></label>
      <div class="mainline-editor-grid">
        <label>状态<select id="mainlineStatus" class="input">${Object.entries(STATUS_LABELS).map(([value, label]) => `<option value="${value}" ${value === (mainline?.status || 'active') ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
        <label>目标日期<input id="mainlineTarget" class="input" type="date" value="${escapeHtml((mainline?.targetDate || '').slice(0, 10))}"></label>
      </div>
      <label>识别色<div class="mainline-color-picker">${MAINLINE_COLORS.map((color) => `<button type="button" data-mainline-color="${color}" class="${color === safeColor(mainline?.color) ? 'active' : ''}" style="--mainline-color:${color}" aria-label="选择颜色"></button>`).join('')}</div></label>
      <label class="mainline-focus-toggle"><input id="mainlineFocus" type="checkbox" ${mainline?.isWeeklyFocus ? 'checked' : ''}><span><strong>设为本周重点</strong><small>同时最多 2 条，首页优先显示。</small></span></label>
      <div class="sheet-actions">
        ${mainline ? '<button class="btn danger" id="deleteMainlineBtn">删除</button>' : '<button class="btn" id="cancelMainlineBtn">取消</button>'}
        <button class="btn primary" id="saveMainlineBtn">保存主线</button>
      </div>
    </div>
  `, { height: '88vh' });
  let color = safeColor(mainline?.color);
  root.querySelectorAll('[data-mainline-color]').forEach((button) => button.addEventListener('click', () => {
    color = button.dataset.mainlineColor;
    root.querySelectorAll('[data-mainline-color]').forEach((item) => item.classList.toggle('active', item === button));
  }));
  root.querySelector('#cancelMainlineBtn')?.addEventListener('click', close);
  root.querySelector('#deleteMainlineBtn')?.addEventListener('click', (event) => {
    if (event.currentTarget.dataset.confirm !== '1') {
      event.currentTarget.dataset.confirm = '1';
      event.currentTarget.textContent = '再点一次确认删除';
      return;
    }
    deleteMainline(mainline.id);
    close();
    showToast('主线已删除，原任务仍然保留');
    onDone(null);
  });
  const save = () => {
    const name = root.querySelector('#mainlineName').value.trim();
    const status = root.querySelector('#mainlineStatus').value;
    const isWeeklyFocus = root.querySelector('#mainlineFocus').checked;
    if (!name) return showToast('先填写主线名称');
    if (!mainline && activeCount >= 5 && ['active', 'maintenance'].includes(status)) return showToast('同时推进的主线最多 5 条，先暂停一条');
    if (isWeeklyFocus && focusCount >= 2) return showToast('本周重点最多 2 条');
    const payload = {
      name,
      outcome: root.querySelector('#mainlineOutcome').value.trim(),
      currentPhase: root.querySelector('#mainlinePhase').value.trim(),
      status,
      targetDate: root.querySelector('#mainlineTarget').value || null,
      color,
      isWeeklyFocus,
    };
    try {
      const saved = mainline ? updateMainline(mainline.id, payload) : addMainline(payload);
      close();
      showToast(mainline ? '主线已更新' : '主线已建立');
      onDone(saved);
    } catch (error) {
      showToast(error.message === 'mainline exists' ? '同名主线已经存在' : '主线保存失败');
    }
  };
  root.querySelector('#saveMainlineBtn').addEventListener('click', save);
  root.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      save();
    }
  });
}

function openMilestoneEditor(mainline, milestone, onDone) {
  const { root, close } = openSheet(`
    <div class="sheet-handle"></div>
    <div class="sheet-content">
      <p class="eyebrow">Milestone</p>
      <h3>${milestone ? '修改里程碑' : '添加里程碑'}</h3>
      <label>阶段成果<input id="milestoneTitle" class="input" value="${escapeHtml(milestone?.title || '')}" placeholder="例如：完成 10 位用户访谈"></label>
      <label>目标日期<input id="milestoneTarget" class="input" type="date" value="${escapeHtml((milestone?.targetDate || '').slice(0, 10))}"></label>
      <div class="sheet-actions">
        ${milestone ? '<button class="btn danger" id="deleteMilestoneBtn">删除</button>' : '<button class="btn" id="cancelMilestoneBtn">取消</button>'}
        <button class="btn primary" id="saveMilestoneBtn">保存</button>
      </div>
    </div>
  `, { height: '52vh' });
  root.querySelector('#cancelMilestoneBtn')?.addEventListener('click', close);
  root.querySelector('#deleteMilestoneBtn')?.addEventListener('click', () => {
    deleteMilestone(milestone.id);
    close();
    showToast('里程碑已删除，任务仍然保留');
    onDone();
  });
  const save = () => {
    const title = root.querySelector('#milestoneTitle').value.trim();
    if (!title) return showToast('先填写阶段成果');
    const payload = { title, targetDate: root.querySelector('#milestoneTarget').value || null };
    if (milestone) updateMilestone(milestone.id, payload);
    else addMilestone(mainline.id, payload);
    close();
    showToast(milestone ? '里程碑已更新' : '里程碑已添加');
    onDone();
  };
  root.querySelector('#saveMilestoneBtn').addEventListener('click', save);
}

function openMainlineTaskEditor(mainline, onDone) {
  const boxes = getBoxes().filter(isTaskBox);
  const milestones = getMilestones(mainline.id).filter((milestone) => milestone.status !== 'completed');
  const defaultBox = boxes.find((box) => box.color === 'important') || boxes[0];
  if (!defaultBox) return showToast('先创建一个待办类型盒子');
  const { root, close } = openSheet(`
    <div class="sheet-handle"></div>
    <div class="sheet-content mainline-task-editor">
      <p class="eyebrow">Next Action</p>
      <h3>为“${escapeHtml(mainline.name)}”安排下一步</h3>
      <label>具体行动<input id="lineTaskContent" class="input" placeholder="下一步要做什么"></label>
      <div class="mainline-editor-grid">
        <label>所属盒子<select id="lineTaskBox" class="input">${boxes.map((box) => `<option value="${box.id}" ${box.id === defaultBox.id ? 'selected' : ''}>${escapeHtml(box.name)}</option>`).join('')}</select></label>
        <label>里程碑<select id="lineTaskMilestone" class="input"><option value="">暂不绑定</option>${milestones.map((milestone) => `<option value="${milestone.id}">${escapeHtml(milestone.title)}</option>`).join('')}</select></label>
      </div>
      <label>计划时间<input id="lineTaskScheduled" class="input" type="datetime-local"></label>
      <label>截止时间<input id="lineTaskDue" class="input" type="datetime-local"></label>
      <label>完成积分<input id="lineTaskPoints" class="input" type="number" min="0" value="${getTaskPointValue({ boxId: defaultBox.id }, defaultBox)}"></label>
      <div class="sheet-actions"><button class="btn" id="cancelLineTask">取消</button><button class="btn primary" id="saveLineTask">保存下一步</button></div>
    </div>
  `, { height: '76vh' });
  root.querySelector('#cancelLineTask').addEventListener('click', close);
  root.querySelector('#lineTaskBox').addEventListener('change', (event) => {
    const box = boxes.find((item) => item.id === event.target.value);
    root.querySelector('#lineTaskPoints').value = getTaskPointValue({ boxId: box?.id }, box);
  });
  const save = () => {
    const content = root.querySelector('#lineTaskContent').value.trim();
    if (!content) return showToast('先写清楚下一步行动');
    addTask({
      content,
      boxId: root.querySelector('#lineTaskBox').value,
      mainlineId: mainline.id,
      milestoneId: root.querySelector('#lineTaskMilestone').value || null,
      scheduledAt: fromDateTimeLocalValue(root.querySelector('#lineTaskScheduled').value),
      dueDate: fromDateTimeLocalValue(root.querySelector('#lineTaskDue').value),
      pointsValue: Math.max(0, Number(root.querySelector('#lineTaskPoints').value) || 0),
    });
    close();
    showToast('下一步行动已加入盒子');
    onDone();
  };
  root.querySelector('#saveLineTask').addEventListener('click', save);
}

export function renderMainlinePage(app, mainlineId) {
  const mainline = getMainlines().find((item) => item.id === mainlineId);
  if (!mainline) return navigate('#home');
  const milestones = getMilestones(mainline.id);
  const tasks = getTasks().filter((task) => task.mainlineId === mainline.id);
  const boxes = getBoxes();
  const boxMap = new Map(boxes.map((box) => [box.id, box]));
  const metrics = mainlineMetrics(mainline, milestones, tasks);
  const color = safeColor(mainline.color);

  app.innerHTML = `
    <main class="page mainline-page" style="--mainline-color:${color}">
      <header class="topbar safe-top mainline-topbar">
        <button class="icon-btn icon-btn-ghost" id="mainlineBack">←</button>
        <div class="topbar-core-actions">${renderCoreBoxNav()}<button class="icon-btn icon-btn-ghost" id="editMainline" aria-label="修改主线">✎</button></div>
      </header>
      <section class="mainline-hero panel">
        <div class="mainline-hero-mark">${escapeHtml(mainline.icon || '◆')}</div>
        <div class="mainline-hero-copy">
          <div class="mainline-kicker"><span>${STATUS_LABELS[mainline.status]}</span>${mainline.isWeeklyFocus ? '<b>本周重点</b>' : ''}</div>
          <h1>${escapeHtml(mainline.name)}</h1>
          <p class="mainline-phase">${escapeHtml(mainline.currentPhase || '先写下当前阶段，让下一步更明确。')}</p>
          <p class="mainline-outcome">${escapeHtml(mainline.outcome || '还没有定义最终成果。')}</p>
        </div>
        <div class="mainline-rail-progress"><span style="height:${metrics.milestoneProgress}%"></span></div>
      </section>
      <section class="mainline-signal-grid">
        <article><span>里程碑</span><strong>${metrics.completedMilestones}/${milestones.length}</strong></article>
        <article><span>进行中</span><strong>${metrics.openTasks.length}</strong></article>
        <article><span>目标日期</span><strong>${formatDate(mainline.targetDate)}</strong></article>
      </section>
      <section class="mainline-next panel ${metrics.nextAction ? '' : 'is-empty'}">
        <p class="eyebrow">Next Action</p>
        ${metrics.nextAction ? `
          <button data-open-task-box="${metrics.nextAction.boxId}"><strong>${escapeHtml(metrics.nextAction.content)}</strong><span>${escapeHtml(boxMap.get(metrics.nextAction.boxId)?.name || '待办盒')} · ${formatDate(metrics.nextAction.dueDate || metrics.nextAction.scheduledAt)}</span></button>
        ` : '<div><strong>主线断档</strong><span>现在补一条足够具体的下一步行动。</span></div>'}
        <button class="btn primary compact" id="addMainlineTask">＋ 下一步</button>
      </section>
      <section class="section-heading mainline-section-heading"><div><p class="eyebrow">Milestones</p><h2>阶段里程碑</h2></div><button class="btn subtle compact" id="addMilestone">＋ 添加</button></section>
      <section class="mainline-milestones">
        ${milestones.length ? milestones.map((milestone, index) => `
          <article class="mainline-milestone ${milestone.status === 'completed' ? 'completed' : ''}" data-milestone-id="${milestone.id}">
            <button class="mainline-milestone-check" data-toggle-milestone="${milestone.id}" aria-label="切换完成状态">${milestone.status === 'completed' ? '✓' : index + 1}</button>
            <button class="mainline-milestone-copy" data-edit-milestone="${milestone.id}"><strong>${escapeHtml(milestone.title)}</strong><span>${formatDate(milestone.targetDate)}</span></button>
          </article>
        `).join('') : '<div class="empty-state mainline-empty"><div>◇</div><h3>先拆出第一个阶段成果</h3><p>里程碑衡量真正的推进，不让大量小任务制造虚假进度。</p></div>'}
      </section>
      <section class="section-heading mainline-section-heading"><div><p class="eyebrow">Workstream</p><h2>关联任务</h2></div><p class="section-note">${tasks.length} 项</p></section>
      <section class="mainline-task-list">
        ${tasks.length ? [...tasks].sort((a, b) => Number(a.isCompleted) - Number(b.isCompleted) || new Date(a.dueDate || a.createdAt) - new Date(b.dueDate || b.createdAt)).map((task) => `
          <button class="mainline-task-row ${task.isCompleted ? 'completed' : ''}" data-open-task-box="${task.boxId}">
            <i>${task.isCompleted ? '✓' : ''}</i><span><strong>${escapeHtml(task.content)}</strong><small>${escapeHtml(boxMap.get(task.boxId)?.name || '盒子')} · ${formatDate(task.dueDate || task.scheduledAt)}</small></span>
          </button>
        `).join('') : '<p class="mainline-no-tasks">还没有关联任务。</p>'}
      </section>
    </main>
  `;

  app.querySelector('#mainlineBack').addEventListener('click', () => navigate('#home'));
  app.querySelector('#editMainline').addEventListener('click', () => openMainlineEditor(mainline, (saved) => saved ? renderMainlinePage(app, mainline.id) : navigate('#home')));
  app.querySelector('#addMilestone').addEventListener('click', () => openMilestoneEditor(mainline, null, () => renderMainlinePage(app, mainline.id)));
  app.querySelector('#addMainlineTask').addEventListener('click', () => openMainlineTaskEditor(mainline, () => renderMainlinePage(app, mainline.id)));
  app.querySelectorAll('[data-toggle-milestone]').forEach((button) => button.addEventListener('click', () => {
    const milestone = milestones.find((item) => item.id === button.dataset.toggleMilestone);
    updateMilestone(milestone.id, { status: milestone.status === 'completed' ? 'open' : 'completed' });
    renderMainlinePage(app, mainline.id);
  }));
  app.querySelectorAll('[data-edit-milestone]').forEach((button) => button.addEventListener('click', () => {
    const milestone = milestones.find((item) => item.id === button.dataset.editMilestone);
    openMilestoneEditor(mainline, milestone, () => renderMainlinePage(app, mainline.id));
  }));
  app.querySelectorAll('[data-open-task-box]').forEach((button) => button.addEventListener('click', () => navigate(`#box/${button.dataset.openTaskBox}`)));
}
