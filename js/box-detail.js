import { getBoxes, getTasksByBox, updateTask, deleteTask, reorderTasks, updateBox, addTask, playSound, restoreTask } from './db.js';
import { navigate, openSheet, showToast } from './app.js';
import { openLuckyWheel } from './lucky-wheel.js';
import { getTaskPointValue, reconcileCompletedTaskPoints, syncTaskCompletionPoints } from './points-store.js';

const LONG_PRESS_MS = 500;
const DELETE_SWIPE_THRESHOLD = 120;

let undoTimer = null;

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function getPriorityColor(priority) {
  if (priority === 3) return '#ff4d4f';
  if (priority === 2) return '#ff922b';
  if (priority === 1) return '#94a3b8';
  return '#1f2937';
}

function getPriorityLabel(priority) {
  if (priority === 3) return 'P3 紧急';
  if (priority === 2) return 'P2 重要';
  if (priority === 1) return 'P1 常规';
  return '普通';
}

function formatDueLabel(dueDate) {
  if (!dueDate) return '';

  const target = new Date(dueDate);
  const today = new Date();
  const targetDay = new Date(target.getFullYear(), target.getMonth(), target.getDate());
  const todayDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const diff = Math.round((targetDay - todayDay) / 86400000);

  if (diff === 0) return '今天截止';
  if (diff === 1) return '明天截止';
  if (diff === -1) return '昨天到期';
  return `${target.getMonth() + 1}/${target.getDate()} 截止`;
}

function showUndo(task, onUndo, onExpire) {
  clearTimeout(undoTimer);
  document.querySelector('.undo-banner')?.remove();

  const banner = document.createElement('div');
  banner.className = 'undo-banner';
  banner.innerHTML = `已删除任务：${escapeHtml(task.content)} <button id="undoBtn">撤销</button>`;
  document.body.appendChild(banner);

  banner.querySelector('#undoBtn').addEventListener('click', () => {
    clearTimeout(undoTimer);
    banner.remove();
    onUndo();
  });

  undoTimer = setTimeout(() => {
    banner.remove();
    onExpire?.();
  }, 3000);
}

export function renderBoxDetail(app, boxId) {
  const box = getBoxes().find((item) => item.id === boxId);
  if (!box) return navigate('#home');

  const tasks = getTasksByBox(boxId);
  const taskMap = new Map(tasks.map((task) => [task.id, task]));
  const openTasks = tasks.filter((task) => !task.isCompleted);
  const doneTasks = tasks.filter((task) => task.isCompleted);
  const progress = tasks.length ? Math.round((doneTasks.length / tasks.length) * 100) : 0;

  app.innerHTML = `
    <main id="box-detail" class="page detail-page">
      <header class="topbar safe-top detail-topbar">
        <button class="icon-btn icon-btn-ghost" id="backBtn">←</button>
        <div class="row gap8 detail-actions">
          <button class="icon-btn icon-btn-ghost" id="wheelBtn" aria-label="随机抽取">🎡</button>
          <button class="icon-btn icon-btn-ghost" id="settingsBtn" aria-label="设置">⚙</button>
        </div>
      </header>

      <section class="detail-hero panel ${box.color}">
        <div class="detail-hero-head">
          <span class="detail-icon">${escapeHtml(box.icon)}</span>
          <div class="detail-hero-copy">
            <p class="eyebrow">任务盒</p>
            <input id="boxNameInput" class="title-input" value="${escapeHtml(box.name)}" aria-label="盒子名称">
            <p class="detail-hero-desc">${escapeHtml(String(box.description || '').trim() || '把同类任务放进一个盒子里，降低来回切换的成本。')}</p>
          </div>
        </div>

        <div class="detail-summary">
          <article class="summary-chip">
            <span>进行中</span>
            <strong>${openTasks.length}</strong>
          </article>
          <article class="summary-chip">
            <span>已完成</span>
            <strong>${doneTasks.length}</strong>
          </article>
          <article class="summary-chip">
            <span>完成率</span>
            <strong>${progress}%</strong>
          </article>
        </div>

        <section class="box-progress ${box.color} detail-progress"><span style="width:${progress}%"></span></section>
      </section>

      <section class="task-section-header">
        <div>
          <p class="eyebrow">In Progress</p>
          <h2>当前任务</h2>
        </div>
        <button class="btn subtle compact" id="addTaskInlineBtn">＋ 新任务</button>
      </section>

      <section class="task-list scroll-area" id="taskList">
        ${openTasks.length === 0 ? `
          <div class="empty-state">
            <div>${escapeHtml(box.icon)}</div>
            <h3>还没有进行中的任务</h3>
            <p>先加一条任务，让这个盒子开始运转。</p>
          </div>
        ` : `
          <div id="openTasks">${openTasks.map((task) => taskItem(task, box)).join('')}</div>
        `}

        ${doneTasks.length ? `
          <button class="completed-toggle" id="toggleDone">已完成 ${doneTasks.length} 项 ▸</button>
          <div id="doneTasks" class="collapsed">${doneTasks.map((task) => taskItem(task, box)).join('')}</div>
        ` : ''}
      </section>

      <footer class="safe-bottom footer-fixed">
        <button class="btn primary ${box.color}" id="addTaskBtn">${tasks.length ? '＋ 添加任务' : '创建第一条任务'}</button>
      </footer>
    </main>
  `;

  app.querySelector('#backBtn').addEventListener('click', () => navigate('#home'));
  app.querySelector('#wheelBtn').addEventListener('click', () => openLuckyWheel(box));
  app.querySelector('#settingsBtn').addEventListener('click', () => navigate('#settings'));
  app.querySelector('#boxNameInput').addEventListener('blur', (event) => {
    const name = event.target.value.trim();
    if (name) updateBox(box.id, { name });
  });

  const openEditor = () => openTaskEditor({ boxId: box.id }, () => renderBoxDetail(app, box.id));
  app.querySelector('#addTaskBtn').addEventListener('click', openEditor);
  app.querySelector('#addTaskInlineBtn').addEventListener('click', openEditor);

  const toggle = app.querySelector('#toggleDone');
  if (toggle) {
    const doneList = app.querySelector('#doneTasks');
    toggle.addEventListener('click', () => {
      doneList.classList.toggle('collapsed');
      toggle.textContent = `已完成 ${doneTasks.length} 项 ${doneList.classList.contains('collapsed') ? '▸' : '▾'}`;
    });
  }

  bindTaskEvents(app, box, taskMap);
}

function taskItem(task, box) {
  const overdue = task.dueDate && !task.isCompleted && new Date(task.dueDate) < new Date();
  const color = getPriorityColor(task.priority ?? 0);
  const taskProgress = Math.max(0, Math.min(100, Number(task.progress) || 0));
  const hasNote = Boolean((task.note || '').trim());
  const notePreview = hasNote ? escapeHtml(String(task.note).trim().slice(0, 40)) : '';
  const pointsValue = getTaskPointValue(task, box);

  return `
    <article class="task-item ${task.isCompleted ? 'done' : ''}" data-id="${task.id}">
      <div class="task-main" data-main="1">
        <button class="check ${task.isCompleted ? 'checked' : ''}" style="--check-color:${color}">${task.isCompleted ? '✓' : ''}</button>
        <button class="task-content" data-action="edit">
          <div class="task-title-row">
            <span class="task-title">${escapeHtml(task.content)}</span>
            ${hasNote ? '<span class="task-note-badge">备注</span>' : ''}
          </div>
          <div class="task-meta">
            <span class="task-chip">${escapeHtml(getPriorityLabel(task.priority ?? 0))}</span>
            ${task.dueDate ? `<span class="task-chip ${overdue ? 'overdue-chip' : ''}">${escapeHtml(formatDueLabel(task.dueDate))}</span>` : ''}
            <span class="task-chip">${taskProgress}%</span>
            ${pointsValue > 0 ? `<span class="task-chip points-chip">+${pointsValue} 分</span>` : ''}
          </div>
          ${hasNote ? `<p class="task-note-preview">${notePreview}${String(task.note).trim().length > 40 ? '…' : ''}</p>` : ''}
          <div class="mini-progress"><span style="width:${taskProgress}%; background:${color}"></span></div>
        </button>
        <span class="grip" aria-hidden="true">⋮⋮</span>
      </div>
    </article>
  `;
}

function bindTaskEvents(app, box, taskMap) {
  app.querySelectorAll('.task-item').forEach((item) => {
    const taskId = item.dataset.id;

    item.querySelector('.check').addEventListener('click', (event) => {
      event.stopPropagation();
      const checked = item.classList.contains('done');
      const currentTask = taskMap.get(taskId);
      const nextTask = {
        ...currentTask,
        isCompleted: !checked,
        progress: checked ? 80 : 100,
        completedAt: checked ? null : new Date().toISOString(),
      };
      updateTask(taskId, {
        isCompleted: nextTask.isCompleted,
        progress: nextTask.progress,
        completedAt: nextTask.completedAt,
      });
      const pointsResult = syncTaskCompletionPoints({ task: nextTask, box, completed: nextTask.isCompleted });
      playSound('complete');
      if (pointsResult.changed) {
        showToast(pointsResult.delta > 0 ? `已获得 +${pointsResult.delta} 积分` : `已回收 ${Math.abs(pointsResult.delta)} 积分`);
      }
      setTimeout(() => renderBoxDetail(app, box.id), 220);
    });

    item.querySelector('[data-action="edit"]').addEventListener('click', () => {
      openTaskEditor({ taskId, boxId: box.id }, () => renderBoxDetail(app, box.id));
    });

    bindSwipeDelete(item, box.id, app, taskMap.get(taskId));
  });

  enableLongPressReorder(app, box.id);
}

function bindSwipeDelete(item, boxId, app, taskSnapshot) {
  const main = item.querySelector('.task-main');
  let sx = 0;
  let sy = 0;
  let dx = 0;
  let dy = 0;

  item.addEventListener('touchstart', (event) => {
    sx = event.touches[0].clientX;
    sy = event.touches[0].clientY;
    dx = 0;
    dy = 0;
  }, { passive: true });

  item.addEventListener('touchmove', (event) => {
    dx = event.touches[0].clientX - sx;
    dy = event.touches[0].clientY - sy;

    if (Math.abs(dx) > Math.abs(dy) && dx < 0) {
      const x = Math.max(dx, -window.innerWidth * 0.9);
      main.style.transform = `translateX(${x}px)`;
    }
  }, { passive: true });

  item.addEventListener('touchend', () => {
    if (dx < -DELETE_SWIPE_THRESHOLD && Math.abs(dx) > Math.abs(dy)) {
      main.style.transform = 'translateX(-120%)';
      setTimeout(() => {
        deleteTask(taskSnapshot.id);
        renderBoxDetail(app, boxId);
        showUndo(taskSnapshot, () => {
          restoreTask(taskSnapshot);
          renderBoxDetail(app, boxId);
        });
      }, 120);
    } else {
      main.style.transform = '';
    }
  });
}

function enableLongPressReorder(app, boxId) {
  const list = app.querySelector('#openTasks');
  if (!list) return;

  let timer = null;
  let dragging = null;
  let pointerId = null;

  const onMove = (event) => {
    if (!dragging || event.pointerId !== pointerId) return;
    const under = document.elementFromPoint(event.clientX, event.clientY)?.closest('.task-item');
    if (under && under !== dragging && under.parentElement === list) {
      const rect = under.getBoundingClientRect();
      const before = event.clientY < rect.top + rect.height / 2;
      list.insertBefore(dragging, before ? under : under.nextSibling);
    }
  };

  const onUp = (event) => {
    clearTimeout(timer);
    if (!dragging || event.pointerId !== pointerId) return;
    dragging.classList.remove('dragging');
    const ids = Array.from(list.children).map((item) => item.dataset.id);
    reorderTasks(boxId, ids);
    dragging = null;
    pointerId = null;
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    document.removeEventListener('pointercancel', onUp);
    renderBoxDetail(app, boxId);
  };

  list.querySelectorAll('.task-item').forEach((element) => {
    element.addEventListener('pointerdown', (event) => {
      if (event.target.closest('.check')) return;
      clearTimeout(timer);
      pointerId = event.pointerId;
      timer = setTimeout(() => {
        dragging = element;
        dragging.classList.add('dragging');
        document.addEventListener('pointermove', onMove);
        document.addEventListener('pointerup', onUp);
        document.addEventListener('pointercancel', onUp);
      }, LONG_PRESS_MS);
    });

    element.addEventListener('pointerup', () => clearTimeout(timer));
    element.addEventListener('pointercancel', () => clearTimeout(timer));
  });
}

function openTaskEditor({ taskId, boxId }, onDone) {
  const boxes = getBoxes();
  const currentTasks = getTasksByBox(boxId);
  const task = currentTasks.find((item) => item.id === taskId);
  const initialBox = boxes.find((box) => box.id === (task?.boxId || boxId)) || boxes[0] || null;
  const initialPoints = task ? getTaskPointValue(task, initialBox) : getTaskPointValue({ boxId: initialBox?.id }, initialBox);
  const { root, close } = openSheet(`
    <div class="sheet-handle"></div>
    <div class="sheet-content">
      <p class="eyebrow">Task Editor</p>
      <h3>${task ? '编辑任务' : '添加任务'}</h3>
      <p class="sheet-lead">补充优先级、进度和备注，让任务状态更清楚。</p>

      <label>任务内容<input id="taskContent" class="input" value="${escapeHtml(task?.content || '')}" placeholder="例如：整理本周计划"></label>

      <label>优先级
        <div class="priority-select">
          ${[0, 1, 2, 3].map((priority) => `
            <button class="prio-dot p${priority} ${((task?.priority ?? 0) === priority) ? 'active' : ''}" data-p="${priority}">
              ${priority === 0 ? '无' : `P${priority}`}
            </button>
          `).join('')}
        </div>
      </label>

      <label>完成进度
        <div class="progress-select">
          ${[0, 20, 40, 60, 80, 100].map((value) => `
            <button class="progress-dot ${(task?.progress ?? 0) === value ? 'active' : ''}" data-progress="${value}">${value}%</button>
          `).join('')}
        </div>
      </label>

      <label>截止日期<input id="taskDate" class="input" type="date" value="${task?.dueDate ? task.dueDate.slice(0, 10) : ''}"></label>
      <label>抽奖权重（选填，默认 1）<input id="taskWeight" class="input" type="number" min="1" step="1" placeholder="1" value="${task?.weight ?? ''}"></label>
      <label>完成奖励积分<input id="taskPointsValue" class="input" type="number" min="0" step="1" value="${initialPoints}"></label>
      <label>所属盒子
        <select id="taskBox" class="input">
          ${boxes.map((box) => `<option value="${box.id}" ${box.id === (task?.boxId || boxId) ? 'selected' : ''}>${escapeHtml(box.name)}</option>`).join('')}
        </select>
      </label>
      <label>备注（可选）<textarea id="taskNote" class="input" rows="4" placeholder="写下补充说明、下一步或上下文">${escapeHtml(task?.note || '')}</textarea></label>

      <div class="sheet-actions">
        <button class="btn" id="cancelBtn">取消</button>
        <button class="btn primary" id="saveBtn">保存</button>
      </div>
    </div>
  `, { height: '80vh' });

  let priority = task?.priority ?? 0;
  let progress = task?.progress ?? 0;
  const boxSelect = root.querySelector('#taskBox');
  const pointsInput = root.querySelector('#taskPointsValue');

  root.querySelectorAll('.prio-dot').forEach((button) => {
    button.addEventListener('click', () => {
      priority = Number(button.dataset.p);
      root.querySelectorAll('.prio-dot').forEach((item) => item.classList.toggle('active', item === button));
    });
  });

  root.querySelectorAll('.progress-dot').forEach((button) => {
    button.addEventListener('click', () => {
      progress = Number(button.dataset.progress);
      root.querySelectorAll('.progress-dot').forEach((item) => item.classList.toggle('active', item === button));
    });
  });

  pointsInput.addEventListener('input', () => {
    pointsInput.dataset.touched = '1';
  });
  boxSelect.addEventListener('change', () => {
    if (pointsInput.dataset.touched === '1') return;
    const selectedBox = boxes.find((box) => box.id === boxSelect.value);
    const referenceTask = task ? { ...task, boxId: boxSelect.value, priority } : { boxId: boxSelect.value, priority };
    pointsInput.value = String(getTaskPointValue(referenceTask, selectedBox));
  });

  root.querySelector('#cancelBtn').addEventListener('click', close);
  root.querySelector('#saveBtn').addEventListener('click', () => {
    const content = root.querySelector('#taskContent').value.trim();
    if (!content) {
      showToast('先填写任务内容');
      return;
    }

    const nextBoxId = root.querySelector('#taskBox').value;
    const selectedBox = boxes.find((box) => box.id === nextBoxId) || null;
    const due = root.querySelector('#taskDate').value || null;
    const weight = Math.max(1, Number(root.querySelector('#taskWeight').value) || 1);
    const pointsValue = Math.max(0, Number(root.querySelector('#taskPointsValue').value) || 0);
    const done = progress >= 100;
    const payload = {
      content,
      priority,
      progress,
      weight,
      pointsValue,
      dueDate: due ? new Date(due).toISOString() : null,
      boxId: nextBoxId,
      note: root.querySelector('#taskNote').value.trim(),
      isCompleted: done,
      completedAt: done ? (task?.completedAt || new Date().toISOString()) : null,
    };

    if (task) {
      const previousPointsValue = getTaskPointValue(task, boxes.find((box) => box.id === task.boxId) || null);
      updateTask(task.id, payload);
      const nextTask = { ...task, ...payload, id: task.id };
      let pointsResult = { changed: false, delta: 0 };
      if (task.isCompleted !== nextTask.isCompleted) {
        pointsResult = syncTaskCompletionPoints({ task: nextTask, box: selectedBox, completed: nextTask.isCompleted });
      } else if (nextTask.isCompleted) {
        pointsResult = reconcileCompletedTaskPoints({ task: nextTask, box: selectedBox, previousPointsValue });
      }
      if (pointsResult.changed) {
        showToast(pointsResult.delta > 0 ? `积分已调整 +${pointsResult.delta}` : `积分已调整 ${pointsResult.delta}`);
      }
    } else {
      const created = addTask(payload);
      if (created?.isCompleted) {
        const pointsResult = syncTaskCompletionPoints({ task: created, box: selectedBox, completed: true });
        if (pointsResult.changed) showToast(`已获得 +${pointsResult.delta} 积分`);
      }
    }

    close();
    onDone();
  });
}
