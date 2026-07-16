import { getBoxes, getDeferredTasksByBox, getDeletedTasksByBox, getMainlines, getSettings, getTasksByBox, getUsageLogs, recordPoolUsage, updateTask, deleteTask, deleteRecurringSeries, reorderTasks, updateBox, addRecurringTask, addTask, playSound, restoreTask, pullDataFromCloud } from './db.js';
import { navigate, openSheet, showToast } from './app.js';
import { openLuckyWheel } from './lucky-wheel.js';
import { getPointsBalance, getTaskPointValue, recordPointsTransaction, reconcileCompletedTaskPoints, syncTaskCompletionPoints } from './points-store.js';
import { formatDueLabel as formatDueDateLabel, formatScheduledLabel, fromDateTimeLocalValue, getBoxDailySentence, getDeadlinePresetValue, getSchedulePresetValue, isTaskNeedsReschedule, isTaskOverdue, toDateTimeLocalValue } from './task-utils.js';
import { getRecurrenceLabel } from './recurrence.js';
import { bindRecurrenceEditor, renderRecurrenceEditor } from './recurrence-ui.js';
import { openBoxTypeChangeSheet } from './box-type-sheet.js';
import { isIdeaBox, renderCoreBoxNav } from './core-box-nav.js';
import { bindMainlineTaskFields, renderMainlineTaskFields } from './mainline-fields.js';
import { bindDeviceContextField, formatVisibleAfter, getDefaultDeferredUntil, getDeviceContextLabel, isTaskContextMismatch, isTaskReleased, renderDeviceContextField } from './task-visibility.js';
import {
  BOX_TYPE_COLLECTION,
  BOX_TYPE_POOL,
  BOX_TYPE_TASK,
  formatCooldownRemaining,
  getBoxTypeDefinition,
  getPoolCooldownState,
  inferBoxType,
  isTaskBox,
} from './box-types.js';

const LONG_PRESS_MS = 500;
const DELETE_SWIPE_THRESHOLD = 120;
const QUICK_SWITCH_LABELS = {
  important: '重要',
  misc: '待办',
  relax: '放松',
};
const PIN_LEVELS = [
  { value: 1, label: '第一', hint: '最高优先' },
  { value: 2, label: '第二', hint: '紧跟其后' },
  { value: 3, label: '第三', hint: '保留提醒' },
];
const SCHEDULE_PRESETS = [
  { value: 'today', label: '今天' },
  { value: 'tonight', label: '今晚' },
  { value: 'tomorrow', label: '明天' },
  { value: 'weekend', label: '周末' },
  { value: 'clear', label: '不安排' },
];
const DEADLINE_PRESETS = [
  { value: 'today', label: '今天', time: '22:00' },
  { value: 'tonight', label: '今晚', time: '24:00' },
  { value: 'tomorrow', label: '明天', time: '22:00' },
  { value: 'weekend', label: '周日', time: '22:00' },
  { value: 'clear', label: '不设置', time: '' },
];
const BOX_PIN_THEMES = {
  important: { start: '#f9734e', end: '#ff9a5a', soft: 'rgba(249, 115, 78, 0.15)', border: 'rgba(249, 115, 78, 0.46)', shadow: 'rgba(249, 115, 78, 0.16)', text: '#c2410c' },
  misc: { start: '#2f6df6', end: '#22c3dd', soft: 'rgba(47, 109, 246, 0.14)', border: 'rgba(47, 109, 246, 0.42)', shadow: 'rgba(47, 109, 246, 0.14)', text: '#1d4ed8' },
  relax: { start: '#0ea5a4', end: '#4ade80', soft: 'rgba(14, 165, 164, 0.15)', border: 'rgba(14, 165, 164, 0.42)', shadow: 'rgba(14, 165, 164, 0.15)', text: '#047857' },
  reward: { start: '#f6c445', end: '#fb923c', soft: 'rgba(246, 196, 69, 0.18)', border: 'rgba(246, 196, 69, 0.48)', shadow: 'rgba(246, 196, 69, 0.16)', text: '#b45309' },
  punish: { start: '#334155', end: '#0f172a', soft: 'rgba(51, 65, 85, 0.16)', border: 'rgba(51, 65, 85, 0.42)', shadow: 'rgba(51, 65, 85, 0.14)', text: '#334155' },
  study: { start: '#22c55e', end: '#15803d', soft: 'rgba(34, 197, 94, 0.15)', border: 'rgba(34, 197, 94, 0.42)', shadow: 'rgba(34, 197, 94, 0.14)', text: '#15803d' },
  health: { start: '#0f9bd7', end: '#2563eb', soft: 'rgba(15, 155, 215, 0.15)', border: 'rgba(15, 155, 215, 0.42)', shadow: 'rgba(15, 155, 215, 0.14)', text: '#0369a1' },
};

let undoTimer = null;
let contextMenuCleanup = null;

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

function getCompletedTime(task) {
  const candidates = [task.completedAt, task.updatedAt, task.createdAt];
  for (const value of candidates) {
    if (!value) continue;
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return new Date(0);
}

function startOfLocalDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function formatCompletedGroupLabel(date) {
  const today = startOfLocalDay(new Date());
  const target = startOfLocalDay(date);
  const diffDays = Math.round((today - target) / 86400000);
  if (diffDays === 0) return '今天';
  if (diffDays === 1) return '昨天';
  const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][date.getDay()];
  return `${date.getMonth() + 1}月${date.getDate()}日 ${week}`;
}

function getCompletedGroupKey(date) {
  const today = startOfLocalDay(new Date());
  const target = startOfLocalDay(date);
  const diffDays = Math.round((today - target) / 86400000);
  if (diffDays >= 0 && diffDays < 7) {
    return target.toISOString().slice(0, 10);
  }
  return 'older';
}

function renderCompletedTaskGroups(tasks, box) {
  const sorted = [...tasks].sort((a, b) => getCompletedTime(b) - getCompletedTime(a));
  const groups = [];
  const groupMap = new Map();

  sorted.forEach((task) => {
    const completedTime = getCompletedTime(task);
    const key = getCompletedGroupKey(completedTime);
    if (!groupMap.has(key)) {
      const group = {
        key,
        label: key === 'older' ? '一周以前' : formatCompletedGroupLabel(completedTime),
        tasks: [],
      };
      groupMap.set(key, group);
      groups.push(group);
    }
    groupMap.get(key).tasks.push(task);
  });

  return groups.map((group) => `
    <section class="completed-group">
      <div class="completed-group-head">
        <span>${escapeHtml(group.label)}</span>
        <small>${group.tasks.length} 项</small>
      </div>
      <div class="completed-group-list">
        ${group.tasks.map((task) => taskItem(task, box)).join('')}
      </div>
    </section>
  `).join('');
}

function renderDeletedTasks(tasks, box) {
  return tasks.map((task) => `
    <article class="task-item deleted-task" data-id="${task.id}" style="${getBoxPinStyle(box)}">
      <div class="task-main" data-main="1">
        <span class="deleted-mark">×</span>
        <div class="task-content">
          <div class="task-title-row">
            <span class="task-title">${escapeHtml(task.content)}</span>
            <span class="task-note-badge">已删除</span>
          </div>
          <div class="task-meta">
            <span class="task-chip">${task.deletedAt ? escapeHtml(formatDueDateLabel(task.deletedAt).replace('截止', '删除')) : '已删除'}</span>
            <span class="task-chip">${escapeHtml(getPriorityLabel(task.priority ?? 0))}</span>
          </div>
        </div>
        <button class="btn subtle compact restore-task-btn" data-restore="${task.id}">还原</button>
      </div>
    </article>
  `).join('');
}

function getQuickSwitchLabel(box) {
  return QUICK_SWITCH_LABELS[box.color] || String(box.name || '').replace(/盒$/, '') || '切换';
}

function getBoxPinStyle(box) {
  const theme = BOX_PIN_THEMES[box?.color] || BOX_PIN_THEMES.important;
  return [
    `--pin-start:${theme.start}`,
    `--pin-end:${theme.end}`,
    `--pin-soft:${theme.soft}`,
    `--pin-border:${theme.border}`,
    `--pin-shadow:${theme.shadow}`,
    `--pin-text:${theme.text}`,
  ].join(';');
}

function getTaskPinLevel(task) {
  const level = Number(task?.pinLevel ?? (task?.pinned ? 1 : 0));
  return level >= 1 && level <= 3 ? level : 0;
}

function getTaskPinLabel(task) {
  const level = getTaskPinLevel(task);
  const option = PIN_LEVELS.find((item) => item.value === level);
  return option ? `置顶${option.label}` : '';
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

function closeTaskContextMenu() {
  contextMenuCleanup?.();
  contextMenuCleanup = null;
  document.querySelector('.task-context-menu')?.remove();
}

function deleteTaskWithUndo(app, boxId, taskSnapshot) {
  if (!taskSnapshot?.id) return;
  closeTaskContextMenu();
  deleteTask(taskSnapshot.id);
  renderBoxDetail(app, boxId);
  showUndo(taskSnapshot, () => {
    restoreTask(taskSnapshot);
    renderBoxDetail(app, boxId);
  });
}

function confirmStopRecurringSeries(app, box, task) {
  closeTaskContextMenu();
  const { root, close } = openSheet(`
    <div class="sheet-handle"></div>
    <div class="sheet-content recurring-stop-sheet">
      <p class="eyebrow">Stop Recurring</p>
      <h3>停止这个周期？</h3>
      <p class="sheet-lead">“${escapeHtml(task.content)}”以后不再生成新一期，已经完成的历史和积分都会保留。</p>
      <div class="sheet-actions">
        <button class="btn" id="cancelStopRecurring">继续保留</button>
        <button class="btn danger" id="confirmStopRecurring">停止周期</button>
      </div>
    </div>
  `, { height: '40vh' });
  root.querySelector('#cancelStopRecurring').addEventListener('click', close);
  root.querySelector('#confirmStopRecurring').addEventListener('click', () => {
    deleteRecurringSeries(task.recurrenceTemplateId);
    close();
    showToast('周期已停止，历史记录仍然保留');
    renderBoxDetail(app, box.id);
  });
}

function setTaskPinLevel(app, box, task, level) {
  if (!task?.id) return;
  closeTaskContextMenu();
  const pinLevel = Number(level);
  const normalizedLevel = pinLevel >= 1 && pinLevel <= 3 ? pinLevel : null;
  updateTask(task.id, {
    pinLevel: normalizedLevel,
    pinned: Boolean(normalizedLevel),
  });
  showToast(normalizedLevel ? `已设为置顶第 ${normalizedLevel} 档` : '已取消置顶');
  renderBoxDetail(app, box.id);
}

function commitPoolUsage(task) {
  const pointsCost = Math.max(0, Number(task?.pointsCost) || 0);
  if (pointsCost && getPointsBalance() < pointsCost) {
    showToast(`积分不足，需要 ${pointsCost} 积分`);
    return false;
  }
  if (pointsCost) {
    recordPointsTransaction({
      delta: -pointsCost,
      title: `使用：${task.content}`,
      note: '来自选项池',
      bucket: 'spend',
      sourceType: 'pool_use',
      sourceKey: `pool-use-${task.id}-${Date.now()}`,
    });
  }
  recordPoolUsage(task.id);
  return true;
}

function getTaskMoveTargets(box, boxes) {
  const important = boxes.find((item) => item.color === 'important');
  const todo = boxes.find((item) => item.color === 'misc');
  if (isIdeaBox(box)) return [important, todo].filter(Boolean);
  if (box?.color === 'important') return [todo].filter(Boolean);
  if (box?.color === 'misc') return [important].filter(Boolean);
  return [];
}

function moveTaskToBox(app, currentBox, task, targetBox) {
  if (!task?.id || !targetBox?.id || targetBox.id === currentBox.id) return;
  closeTaskContextMenu();
  const targetTasks = getTasksByBox(targetBox.id);
  const nextSortOrder = targetTasks.reduce((max, item) => Math.max(max, Number(item.sortOrder) || 0), -1) + 1;
  updateTask(task.id, {
    boxId: targetBox.id,
    itemType: inferBoxType(targetBox),
    sortOrder: nextSortOrder,
  });
  if (task.recurrenceTemplateId) updateTask(task.recurrenceTemplateId, { boxId: targetBox.id });
  showToast(`已移动到${getQuickSwitchLabel(targetBox)}盒${task.recurrenceTemplateId ? '，以后也放这里' : ''}`);
  renderBoxDetail(app, currentBox.id);
}

function resumeTaskToday(app, box, task) {
  closeTaskContextMenu();
  updateTask(task.id, { visibleAfter: new Date().toISOString(), deferredAt: null, deferNote: '' });
  showToast('任务已回到今天');
  renderBoxDetail(app, box.id);
}

function openDeferTaskSheet(app, box, task) {
  closeTaskContextMenu();
  const defaultVisibleAfter = getDefaultDeferredUntil();
  const { root, close } = openSheet(`
    <div class="sheet-handle"></div>
    <div class="sheet-content defer-task-sheet">
      <p class="eyebrow">Pause Today</p>
      <h3>今天先收工</h3>
      <p class="sheet-lead">保留当前进度，任务会在指定时间自动回到列表。</p>
      <div class="defer-task-name">${escapeHtml(task.content)}</div>
      <label>今天做到多少
        <div class="progress-select defer-progress-presets">
          ${[20, 40, 60, 80].map((value) => `<button type="button" class="progress-dot ${Number(task.progress) === value ? 'active' : ''}" data-defer-progress="${value}">${value}%</button>`).join('')}
        </div>
        <input id="deferProgress" class="input" type="number" min="0" max="99" value="${Math.min(99, Math.max(0, Number(task.progress) || 0))}">
      </label>
      <label>再次出现时间<input id="deferVisibleAfter" class="input" type="datetime-local" value="${escapeHtml(toDateTimeLocalValue(defaultVisibleAfter))}"></label>
      <label>进度备注（可选）<textarea id="deferNote" class="input" rows="3" placeholder="今天完成了什么，明天从哪里继续"></textarea></label>
      <p class="defer-warning" id="deferWarning" hidden></p>
      <div class="sheet-actions"><button class="btn" id="cancelDeferBtn">取消</button><button class="btn primary" id="confirmDeferBtn">今天收工</button></div>
    </div>
  `, { height: '76vh' });
  const progressInput = root.querySelector('#deferProgress');
  const visibleInput = root.querySelector('#deferVisibleAfter');
  const warning = root.querySelector('#deferWarning');
  const updateWarning = () => {
    const visibleAt = fromDateTimeLocalValue(visibleInput.value);
    const crossesDeadline = task.dueDate && visibleAt && new Date(visibleAt) >= new Date(task.dueDate);
    warning.hidden = !crossesDeadline;
    warning.textContent = crossesDeadline ? '再次出现时间已经晚于截止时间，任务恢复时会显示为逾期。' : '';
  };
  root.querySelectorAll('[data-defer-progress]').forEach((button) => button.addEventListener('click', () => {
    progressInput.value = button.dataset.deferProgress;
    root.querySelectorAll('[data-defer-progress]').forEach((item) => item.classList.toggle('active', item === button));
  }));
  visibleInput.addEventListener('input', updateWarning);
  updateWarning();
  root.querySelector('#cancelDeferBtn').addEventListener('click', close);
  root.querySelector('#confirmDeferBtn').addEventListener('click', () => {
    const visibleAfter = fromDateTimeLocalValue(visibleInput.value);
    if (!visibleAfter || new Date(visibleAfter) <= new Date()) return showToast('再次出现时间需要晚于现在');
    const progress = Math.min(99, Math.max(0, Number(progressInput.value) || 0));
    const note = root.querySelector('#deferNote').value.trim();
    const timestamp = new Date().toISOString();
    const progressLog = {
      id: crypto.randomUUID ? crypto.randomUUID() : `progress-${Date.now()}`,
      progress,
      note,
      createdAt: timestamp,
    };
    updateTask(task.id, {
      progress,
      visibleAfter,
      deferredAt: timestamp,
      deferNote: note,
      progressLogs: [...(task.progressLogs || []), progressLog].slice(-100),
    });
    close();
    showToast(`已收工 · ${formatVisibleAfter(visibleAfter)}再出现`);
    renderBoxDetail(app, box.id);
  });
}

function openTaskContextMenu(event, app, box, task) {
  event.preventDefault();
  event.stopPropagation();
  closeTaskContextMenu();

  const menu = document.createElement('div');
  menu.className = 'task-context-menu';
  menu.style.cssText = getBoxPinStyle(box);
  const currentPinLevel = getTaskPinLevel(task);
  const boxType = inferBoxType(box);
  const moveTargets = (boxType === BOX_TYPE_TASK || isIdeaBox(box)) ? getTaskMoveTargets(box, getBoxes()) : [];
  const itemName = getBoxTypeDefinition(boxType).itemName;
  menu.innerHTML = `
    <div class="task-context-title">${escapeHtml(itemName)}操作</div>
    <div class="pin-level-grid">
      ${PIN_LEVELS.map((option) => `
        <button type="button" data-action="pin-level" data-pin-level="${option.value}" class="${currentPinLevel === option.value ? 'active' : ''}">
          <strong>${option.label}</strong>
          <small>${option.hint}</small>
        </button>
      `).join('')}
    </div>
    ${currentPinLevel ? '<button type="button" data-action="unpin">取消置顶</button>' : ''}
    ${moveTargets.length ? `
      <div class="task-context-divider" aria-hidden="true"></div>
      <div class="task-move-targets">
        ${moveTargets.map((target) => `
          <button type="button" data-action="move" data-target-box="${target.id}" class="move-task" style="${getBoxPinStyle(target)}">
            <span class="task-context-action-icon" aria-hidden="true">⇄</span>
            <span>移动到${escapeHtml(getQuickSwitchLabel(target))}盒${task.recurrenceTemplateId ? '（本次及以后）' : ''}</span>
          </button>
        `).join('')}
      </div>
    ` : ''}
    ${boxType === BOX_TYPE_TASK ? `<button type="button" data-action="${isTaskReleased(task) ? 'defer' : 'resume'}"><span class="task-context-action-icon" aria-hidden="true">${isTaskReleased(task) ? '☾' : '↥'}</span><span>${isTaskReleased(task) ? '今天收工' : '继续显示'}</span></button>` : ''}
    ${boxType === BOX_TYPE_POOL ? '<button type="button" data-action="use"><span class="task-context-action-icon" aria-hidden="true">✦</span><span>记录使用一次</span></button>' : ''}
    ${boxType === BOX_TYPE_COLLECTION ? `<button type="button" data-action="archive"><span class="task-context-action-icon" aria-hidden="true">⌑</span><span>${task.archived ? '移出归档' : '归档条目'}</span></button>` : ''}
    ${task.recurrenceTemplateId ? '<button type="button" data-action="stop-series" class="danger subtle-danger">停止整个周期</button>' : ''}
    <button type="button" data-action="delete" class="danger">${task.recurrenceTemplateId ? '跳过本次' : `删除${itemName}`}</button>
  `;
  document.body.appendChild(menu);

  const rect = menu.getBoundingClientRect();
  const pointerX = Number.isFinite(Number(event.clientX)) ? Number(event.clientX) : window.innerWidth / 2;
  const pointerY = Number.isFinite(Number(event.clientY)) ? Number(event.clientY) : window.innerHeight / 2;
  const x = Math.min(pointerX, window.innerWidth - rect.width - 12);
  const y = Math.min(pointerY, window.innerHeight - rect.height - 12);
  menu.style.left = `${Math.max(12, x)}px`;
  menu.style.top = `${Math.max(12, y)}px`;

  menu.addEventListener('click', (clickEvent) => {
    const button = clickEvent.target?.closest?.('button[data-action]');
    const action = button?.dataset?.action;
    if (action === 'pin-level') setTaskPinLevel(app, box, task, button.dataset.pinLevel);
    if (action === 'unpin') setTaskPinLevel(app, box, task, null);
    if (action === 'move') {
      const target = moveTargets.find((item) => item.id === button.dataset.targetBox);
      moveTaskToBox(app, box, task, target);
    }
    if (action === 'defer') openDeferTaskSheet(app, box, task);
    if (action === 'resume') resumeTaskToday(app, box, task);
    if (action === 'use') {
      if (!commitPoolUsage(task)) return;
      closeTaskContextMenu();
      showToast(task.pointsCost ? `已使用 · -${task.pointsCost} 积分` : '已记录使用，选项仍保留在池中');
      renderBoxDetail(app, box.id);
    }
    if (action === 'archive') {
      updateTask(task.id, { archived: !task.archived });
      closeTaskContextMenu();
      showToast(task.archived ? '已移出归档' : '条目已归档');
      renderBoxDetail(app, box.id);
    }
    if (action === 'stop-series') confirmStopRecurringSeries(app, box, task);
    if (action === 'delete') deleteTaskWithUndo(app, box.id, task);
  });

  const onPointerDown = (pointerEvent) => {
    if (!menu.contains(pointerEvent.target)) closeTaskContextMenu();
  };
  const onKeyDown = (keyEvent) => {
    if (keyEvent.key === 'Escape') closeTaskContextMenu();
  };
  const onScroll = () => closeTaskContextMenu();

  setTimeout(() => document.addEventListener('pointerdown', onPointerDown), 0);
  document.addEventListener('keydown', onKeyDown);
  window.addEventListener('scroll', onScroll, true);
  contextMenuCleanup = () => {
    document.removeEventListener('pointerdown', onPointerDown);
    document.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('scroll', onScroll, true);
  };
}

function formatCompactTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function poolItem(task, box) {
  const cooldown = getPoolCooldownState(task);
  const pinLevel = getTaskPinLevel(task);
  const details = [
    task.durationMinutes ? `${task.durationMinutes} 分钟` : '',
    Number(task.weight) > 1 ? `权重 ${task.weight}` : '',
    task.pointsCost ? `${task.pointsCost} 积分` : '',
    task.usageCount ? `用过 ${task.usageCount} 次` : '尚未使用',
  ].filter(Boolean);
  return `
    <article class="task-item pool-item ${pinLevel ? 'pinned' : ''} ${cooldown.available ? 'is-available' : 'is-cooling'}" data-id="${task.id}" style="${getBoxPinStyle(box)}">
      <div class="task-main" data-main="1">
        <button class="pool-use-btn" data-action="use" ${cooldown.available ? '' : 'disabled'} aria-label="使用 ${escapeHtml(task.content)}"><span>✦</span><small>${cooldown.available ? '使用' : '冷却'}</small></button>
        <button class="task-content" data-action="edit">
          <div class="task-title-row"><span class="task-title">${escapeHtml(task.content)}</span>${pinLevel ? `<span class="task-note-badge">${escapeHtml(getTaskPinLabel(task))}</span>` : ''}</div>
          <div class="task-meta">${details.map((detail) => `<span class="task-chip">${escapeHtml(detail)}</span>`).join('')}</div>
          <p class="pool-availability ${cooldown.available ? 'available' : ''}">${cooldown.available ? '现在可以抽取或使用' : escapeHtml(formatCooldownRemaining(cooldown.remainingMinutes))}</p>
          ${task.note ? `<p class="task-note-preview">${escapeHtml(task.note)}</p>` : ''}
        </button>
        <span class="grip" aria-hidden="true">⋮⋮</span>
      </div>
    </article>
  `;
}

function collectionItem(task, box, { archived = false } = {}) {
  const pinLevel = getTaskPinLevel(task);
  let host = '';
  try {
    host = task.url ? new URL(task.url).hostname.replace(/^www\./, '') : '';
  } catch {
    host = task.url || '';
  }
  return `
    <article class="task-item collection-item ${task.favorite ? 'is-favorite' : ''} ${archived ? 'is-archived' : ''} ${pinLevel ? 'pinned' : ''}" data-id="${task.id}" style="${getBoxPinStyle(box)}">
      <div class="task-main" data-main="1">
        <button class="collection-favorite-btn ${task.favorite ? 'active' : ''}" data-action="favorite" aria-label="${task.favorite ? '取消常用' : '设为常用'}">★</button>
        <button class="task-content" data-action="edit">
          <div class="task-title-row"><span class="task-title">${escapeHtml(task.content)}</span>${archived ? '<span class="task-note-badge">已归档</span>' : ''}</div>
          <div class="task-meta">
            ${host ? `<span class="task-chip link-chip">↗ ${escapeHtml(host)}</span>` : ''}
            ${(task.tags || []).slice(0, 4).map((tag) => `<span class="task-chip">#${escapeHtml(tag)}</span>`).join('')}
          </div>
          ${task.note ? `<p class="task-note-preview">${escapeHtml(task.note)}</p>` : ''}
        </button>
        ${task.url ? `<a class="collection-open-link" href="${escapeHtml(task.url)}" target="_blank" rel="noopener noreferrer" aria-label="打开链接">↗</a>` : ''}
        ${archived ? '<button class="collection-restore-btn" data-action="unarchive">恢复</button>' : '<span class="grip" aria-hidden="true">⋮⋮</span>'}
      </div>
    </article>
  `;
}

function renderTypeSummary(boxType, activeItems, secondaryItems, usageLogs) {
  if (boxType === BOX_TYPE_POOL) {
    const available = activeItems.filter((item) => getPoolCooldownState(item).available).length;
    const today = new Date().toDateString();
    const usedToday = usageLogs.filter((log) => new Date(log.usedAt).toDateString() === today && log.action === 'used').length;
    return [
      ['现在可用', available],
      ['冷却中', activeItems.length - available],
      ['今日使用', usedToday],
    ];
  }
  if (boxType === BOX_TYPE_COLLECTION) {
    return [
      ['收藏条目', activeItems.length],
      ['常用', activeItems.filter((item) => item.favorite).length],
      ['已归档', secondaryItems.length],
    ];
  }
  return [
    ['进行中', activeItems.length],
    ['已完成', secondaryItems.length],
    ['已逾期', activeItems.filter((item) => isTaskOverdue(item)).length],
  ];
}

export function renderBoxDetail(app, boxId) {
  closeTaskContextMenu();
  const boxes = getBoxes();
  const box = boxes.find((item) => item.id === boxId);
  if (!box) return navigate('#home');

  const tasks = getTasksByBox(boxId);
  const deferredTasks = getDeferredTasksByBox(boxId);
  const deletedTasks = getDeletedTasksByBox(boxId);
  const taskMap = new Map([...tasks, ...deferredTasks].map((task) => [task.id, task]));
  const boxType = inferBoxType(box);
  const typeDefinition = getBoxTypeDefinition(boxType);
  const usageLogs = getUsageLogs({ boxId });
  let activeItems = boxType === BOX_TYPE_TASK
    ? tasks.filter((task) => !task.isCompleted)
    : tasks.filter((task) => !task.archived);
  if (boxType === BOX_TYPE_POOL) {
    activeItems = [...activeItems].sort((left, right) => Number(getPoolCooldownState(right).available) - Number(getPoolCooldownState(left).available));
  } else if (boxType === BOX_TYPE_COLLECTION) {
    activeItems = [...activeItems].sort((left, right) => Number(right.favorite) - Number(left.favorite));
  }
  const allActiveItems = [...activeItems];
  const otherDeviceItems = boxType === BOX_TYPE_TASK
    ? activeItems.filter((task) => isTaskContextMismatch(task, getSettings()))
    : [];
  if (otherDeviceItems.length) {
    const otherIds = new Set(otherDeviceItems.map((task) => task.id));
    activeItems = activeItems.filter((task) => !otherIds.has(task.id));
  }
  const secondaryItems = boxType === BOX_TYPE_TASK
    ? tasks.filter((task) => task.isCompleted)
    : boxType === BOX_TYPE_COLLECTION
      ? tasks.filter((task) => task.archived)
      : [];
  const manuallyDeferredTasks = deferredTasks.filter((task) => task.deferredAt);
  const upcomingTasks = deferredTasks.filter((task) => !task.deferredAt);
  const summary = renderTypeSummary(boxType, allActiveItems, secondaryItems, usageLogs);
  const sectionTitle = boxType === BOX_TYPE_TASK ? '当前任务' : boxType === BOX_TYPE_POOL ? '可重复选项' : '收藏内容';
  const sectionEyebrow = boxType === BOX_TYPE_TASK ? 'In Progress' : boxType === BOX_TYPE_POOL ? 'Ready To Use' : 'Saved For Later';
  const addLabel = `＋ 新${typeDefinition.itemName}`;
  const activeListHtml = activeItems.length
    ? (boxType === BOX_TYPE_TASK
      ? `<div id="openTasks">${activeItems.map((task) => taskItem(task, box)).join('')}</div>`
      : boxType === BOX_TYPE_POOL
        ? `<div id="openTasks" class="typed-item-list">${activeItems.map((task) => poolItem(task, box)).join('')}</div>`
        : `<div id="openTasks" class="typed-item-list">${activeItems.map((task) => collectionItem(task, box)).join('')}</div>`)
    : (boxType === BOX_TYPE_TASK && otherDeviceItems.length
      ? `<div class="empty-state typed-empty context-empty"><div>⌁</div><h3>当前设备已清空</h3><p>还有 ${otherDeviceItems.length} 项其他设备任务，展开下方分组即可查看。</p></div>`
      : `<div class="empty-state typed-empty"><div>${typeDefinition.icon}</div><h3>${typeDefinition.emptyTitle}</h3><p>${typeDefinition.emptyDescription}</p></div>`);

  app.innerHTML = `
    <main id="box-detail" class="page detail-page type-${boxType}">
      <header class="topbar safe-top detail-topbar">
        <button class="icon-btn icon-btn-ghost" id="backBtn">←</button>
        <div class="row gap8 detail-actions">
          ${renderCoreBoxNav({ currentBoxId: box.id })}
          <button class="icon-btn icon-btn-ghost" id="detailPullBtn" aria-label="拉取最新盒子数据">↻</button>
          ${boxType === BOX_TYPE_POOL ? '<button class="icon-btn icon-btn-ghost" id="wheelBtn" aria-label="随机抽取">🎡</button>' : ''}
          <button class="icon-btn icon-btn-ghost" id="settingsBtn" aria-label="设置">⚙</button>
        </div>
      </header>

      <section class="detail-hero panel ${box.color}">
        <div class="detail-hero-head">
          <span class="detail-icon">${escapeHtml(box.icon)}</span>
          <div class="detail-hero-copy">
            <button class="box-type-badge ${boxType}" id="boxTypeBtn"><span>${typeDefinition.icon}</span>${typeDefinition.label}<i>修改</i></button>
            <input id="boxNameInput" class="title-input" value="${escapeHtml(box.name)}" aria-label="盒子名称">
            <label class="box-sentence-editor">
              <span>每日一句</span>
              <textarea id="boxSentenceInput" class="box-sentence-input" rows="3" aria-label="盒子每日一句">${escapeHtml(getBoxDailySentence(box))}</textarea>
            </label>
            <p class="detail-hero-desc">${escapeHtml(typeDefinition.description)}</p>
          </div>
        </div>

        <div class="detail-summary">
          ${summary.map(([label, value]) => `<article class="summary-chip"><span>${label}</span><strong>${value}</strong></article>`).join('')}
        </div>
      </section>

      <section class="task-section-header">
        <div>
          <p class="eyebrow">${sectionEyebrow}</p>
          <h2>${sectionTitle}</h2>
        </div>
        <button class="btn subtle compact" id="addTaskInlineBtn">${addLabel}</button>
      </section>

      <section class="task-list scroll-area" id="taskList">
        ${activeListHtml}

        ${boxType === BOX_TYPE_TASK && otherDeviceItems.length ? `
          <button class="completed-toggle device-mismatch-toggle" id="toggleOtherDevice">其他设备任务 ${otherDeviceItems.length} 项 ▸</button>
          <div id="otherDeviceTasks" class="device-mismatch-timeline collapsed">${otherDeviceItems.map((task) => taskItem(task, box)).join('')}</div>
        ` : ''}

        ${boxType === BOX_TYPE_TASK && manuallyDeferredTasks.length ? `
          <button class="completed-toggle deferred-toggle" id="toggleDeferred">今日已收工 ${manuallyDeferredTasks.length} 项 ▸</button>
          <div id="deferredTasks" class="deferred-timeline collapsed">${manuallyDeferredTasks.map((task) => taskItem(task, box)).join('')}</div>
        ` : ''}

        ${boxType === BOX_TYPE_TASK && upcomingTasks.length ? `
          <button class="completed-toggle upcoming-toggle" id="toggleUpcoming">待到点出现 ${upcomingTasks.length} 项 ▸</button>
          <div id="upcomingTasks" class="upcoming-timeline collapsed">${upcomingTasks.map((task) => taskItem(task, box)).join('')}</div>
        ` : ''}

        ${boxType === BOX_TYPE_TASK && secondaryItems.length ? `
          <button class="completed-toggle" id="toggleDone">已完成 ${secondaryItems.length} 项 ▸</button>
          <div id="doneTasks" class="completed-timeline collapsed">${renderCompletedTaskGroups(secondaryItems, box)}</div>
        ` : ''}

        ${boxType === BOX_TYPE_COLLECTION && secondaryItems.length ? `
          <button class="completed-toggle archived-toggle" id="toggleArchived">已归档 ${secondaryItems.length} 条 ▸</button>
          <div id="archivedItems" class="archived-timeline collapsed">${secondaryItems.map((task) => collectionItem(task, box, { archived: true })).join('')}</div>
        ` : ''}

        ${deletedTasks.length ? `
          <button class="completed-toggle deleted-toggle" id="toggleDeleted">已删除 ${deletedTasks.length} 项 ▸</button>
          <div id="deletedTasks" class="deleted-timeline collapsed">${renderDeletedTasks(deletedTasks, box)}</div>
        ` : ''}
      </section>

      <footer class="safe-bottom footer-fixed">
        <button class="btn primary ${box.color}" id="addTaskBtn">${tasks.length + deferredTasks.length ? `＋ 添加${typeDefinition.itemName}` : `创建第一条${typeDefinition.itemName}`}</button>
      </footer>
    </main>
  `;

  app.querySelector('#backBtn').addEventListener('click', () => navigate('#home'));
  app.querySelector('#detailPullBtn').addEventListener('click', async () => {
    try {
      const result = await pullDataFromCloud({ force: true });
      showToast(result === 'merged' ? '已拉取最新盒子数据' : '本地已是最新');
      renderBoxDetail(app, box.id);
    } catch {
      showToast('盒子数据拉取失败，请检查 API Token 或网络');
    }
  });
  app.querySelector('#wheelBtn')?.addEventListener('click', () => openLuckyWheel(box));
  app.querySelector('#settingsBtn').addEventListener('click', () => navigate('#settings'));
  app.querySelector('#boxTypeBtn').addEventListener('click', () => openBoxTypeChangeSheet(box, () => renderBoxDetail(app, box.id)));
  app.querySelector('#boxNameInput').addEventListener('blur', (event) => {
    const name = event.target.value.trim();
    if (name) updateBox(box.id, { name });
  });
  app.querySelector('#boxNameInput').addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') event.target.blur();
  });
  app.querySelector('#boxSentenceInput').addEventListener('blur', (event) => {
    const description = event.target.value.trim();
    updateBox(box.id, { description });
    if (!description) event.target.value = getBoxDailySentence({ description });
  });
  app.querySelector('#boxSentenceInput').addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') event.target.blur();
  });

  const openEditor = () => openBoxItemEditor({ boxId: box.id }, () => renderBoxDetail(app, box.id));
  app.querySelector('#addTaskBtn').addEventListener('click', openEditor);
  app.querySelector('#addTaskInlineBtn').addEventListener('click', openEditor);

  const toggle = app.querySelector('#toggleDone');
  if (toggle) {
    const doneList = app.querySelector('#doneTasks');
    toggle.addEventListener('click', () => {
      doneList.classList.toggle('collapsed');
      toggle.textContent = `已完成 ${secondaryItems.length} 项 ${doneList.classList.contains('collapsed') ? '▸' : '▾'}`;
    });
  }

  const otherDeviceToggle = app.querySelector('#toggleOtherDevice');
  if (otherDeviceToggle) {
    const otherDeviceList = app.querySelector('#otherDeviceTasks');
    otherDeviceToggle.addEventListener('click', () => {
      otherDeviceList.classList.toggle('collapsed');
      otherDeviceToggle.textContent = `其他设备任务 ${otherDeviceItems.length} 项 ${otherDeviceList.classList.contains('collapsed') ? '▸' : '▾'}`;
    });
  }

  const deferredToggle = app.querySelector('#toggleDeferred');
  if (deferredToggle) {
    const deferredList = app.querySelector('#deferredTasks');
    deferredToggle.addEventListener('click', () => {
      deferredList.classList.toggle('collapsed');
      deferredToggle.textContent = `今日已收工 ${manuallyDeferredTasks.length} 项 ${deferredList.classList.contains('collapsed') ? '▸' : '▾'}`;
    });
  }

  const upcomingToggle = app.querySelector('#toggleUpcoming');
  if (upcomingToggle) {
    const upcomingList = app.querySelector('#upcomingTasks');
    upcomingToggle.addEventListener('click', () => {
      upcomingList.classList.toggle('collapsed');
      upcomingToggle.textContent = `待到点出现 ${upcomingTasks.length} 项 ${upcomingList.classList.contains('collapsed') ? '▸' : '▾'}`;
    });
  }

  const archivedToggle = app.querySelector('#toggleArchived');
  if (archivedToggle) {
    const archivedList = app.querySelector('#archivedItems');
    archivedToggle.addEventListener('click', () => {
      archivedList.classList.toggle('collapsed');
      archivedToggle.textContent = `已归档 ${secondaryItems.length} 条 ${archivedList.classList.contains('collapsed') ? '▸' : '▾'}`;
    });
  }

  const deletedToggle = app.querySelector('#toggleDeleted');
  if (deletedToggle) {
    const deletedList = app.querySelector('#deletedTasks');
    deletedToggle.addEventListener('click', () => {
      deletedList.classList.toggle('collapsed');
      deletedToggle.textContent = `已删除 ${deletedTasks.length} 项 ${deletedList.classList.contains('collapsed') ? '▸' : '▾'}`;
    });
  }

  app.querySelectorAll('[data-restore]').forEach((button) => {
    button.addEventListener('click', () => {
      const task = deletedTasks.find((item) => item.id === button.dataset.restore);
      if (!task) return;
      restoreTask(task);
      showToast(`${typeDefinition.itemName}已还原`);
      renderBoxDetail(app, box.id);
    });
  });

  bindItemEvents(app, box, taskMap);
}

function taskItem(task, box) {
  const overdue = isTaskOverdue(task);
  const needsReschedule = isTaskNeedsReschedule(task);
  const color = getPriorityColor(task.priority ?? 0);
  const taskProgress = Math.max(0, Math.min(100, Number(task.progress) || 0));
  const hasNote = Boolean((task.note || '').trim());
  const notePreview = hasNote ? escapeHtml(String(task.note).trim().slice(0, 40)) : '';
  const pointsValue = getTaskPointValue(task, box);
  const pinLevel = getTaskPinLevel(task);
  const mainline = task.mainlineId ? getMainlines().find((item) => item.id === task.mainlineId) : null;
  const released = isTaskReleased(task);
  const deferNote = String(task.deferNote || '').trim();

  return `
    <article class="task-item ${task.isCompleted ? 'done' : ''} ${pinLevel ? 'pinned' : ''} ${overdue ? 'overdue' : ''} ${needsReschedule ? 'needs-reschedule' : ''} ${released ? '' : 'deferred'}" data-id="${task.id}" style="${getBoxPinStyle(box)}">
      <div class="task-main" data-main="1">
        <button class="check task-check-control ${task.isCompleted ? 'checked' : ''}" style="--check-color:${color}" aria-label="${task.isCompleted ? '取消完成' : '完成'} ${escapeHtml(task.content)}"></button>
        <button class="task-content" data-action="edit">
          <div class="task-title-row">
            <span class="task-title">${escapeHtml(task.content)}</span>
            ${hasNote ? '<span class="task-note-badge">备注</span>' : ''}
          </div>
          <div class="task-meta">
            ${pinLevel ? `<span class="task-chip pin-chip">${escapeHtml(getTaskPinLabel(task))}</span>` : ''}
            <span class="task-chip">${escapeHtml(getPriorityLabel(task.priority ?? 0))}</span>
            <span class="task-chip device-chip device-${escapeHtml(task.deviceContext || 'universal')}">${escapeHtml(getDeviceContextLabel(task.deviceContext))}</span>
            ${!released ? `<span class="task-chip deferred-chip">${escapeHtml(formatVisibleAfter(task.visibleAfter))}再出现</span>` : ''}
            ${task.scheduledAt ? `<span class="task-chip planned-chip ${needsReschedule ? 'reschedule-chip' : ''}">${escapeHtml(needsReschedule ? `待重新安排 · ${formatScheduledLabel(task.scheduledAt)}` : `计划 ${formatScheduledLabel(task.scheduledAt)}`)}</span>` : ''}
            ${task.dueDate ? `<span class="task-chip ${overdue ? 'overdue-chip' : ''}">${escapeHtml(formatDueDateLabel(task.dueDate))}</span>` : ''}
            ${task.recurrence ? `<span class="task-chip recurrence-chip">↻ ${escapeHtml(getRecurrenceLabel(task.recurrence))}</span>` : ''}
            ${mainline ? `<span class="task-chip mainline-task-chip">◆ ${escapeHtml(mainline.name)}</span>` : ''}
            <span class="task-chip">${taskProgress}%</span>
            ${pointsValue > 0 ? `<span class="task-chip points-chip">+${pointsValue} 分</span>` : ''}
          </div>
          ${hasNote ? `<p class="task-note-preview">${notePreview}${String(task.note).trim().length > 40 ? '…' : ''}</p>` : ''}
          ${deferNote ? `<p class="task-note-preview defer-note-preview">续接点：${escapeHtml(deferNote.slice(0, 50))}${deferNote.length > 50 ? '…' : ''}</p>` : ''}
          <div class="mini-progress"><span style="width:${taskProgress}%; background:${color}"></span></div>
        </button>
        <button class="grip task-more-btn" data-action="more" aria-label="打开 ${escapeHtml(task.content)} 的操作菜单">•••</button>
      </div>
    </article>
  `;
}

function bindItemEvents(app, box, taskMap) {
  const boxType = inferBoxType(box);
  app.querySelectorAll('.task-item:not(.deleted-task)').forEach((item) => {
    const taskId = item.dataset.id;
    const task = taskMap.get(taskId);
    const checkButton = item.querySelector('.check');
    const useButton = item.querySelector('[data-action="use"]');
    const favoriteButton = item.querySelector('[data-action="favorite"]');
    const unarchiveButton = item.querySelector('[data-action="unarchive"]');
    const editButton = item.querySelector('[data-action="edit"]');
    const moreButton = item.querySelector('[data-action="more"]');
    if (!task || !editButton) return;

    checkButton?.addEventListener('click', (event) => {
      event.stopPropagation();
      const checked = item.classList.contains('done');
      checkButton.classList.toggle('checked', !checked);
      const nextTask = {
        ...task,
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

    useButton?.addEventListener('click', (event) => {
      event.stopPropagation();
      const cooldown = getPoolCooldownState(task);
      if (!cooldown.available) {
        showToast(formatCooldownRemaining(cooldown.remainingMinutes));
        return;
      }
      if (!commitPoolUsage(task)) return;
      playSound('complete');
      showToast(task.pointsCost ? `已使用 · -${task.pointsCost} 积分` : '已记录使用，选项会继续保留');
      renderBoxDetail(app, box.id);
    });

    favoriteButton?.addEventListener('click', (event) => {
      event.stopPropagation();
      updateTask(taskId, { favorite: !task.favorite });
      showToast(task.favorite ? '已取消常用' : '已设为常用');
      renderBoxDetail(app, box.id);
    });

    unarchiveButton?.addEventListener('click', (event) => {
      event.stopPropagation();
      updateTask(taskId, { archived: false });
      showToast('条目已移出归档');
      renderBoxDetail(app, box.id);
    });

    editButton.addEventListener('click', () => {
      openBoxItemEditor({ taskId, boxId: box.id }, () => renderBoxDetail(app, box.id));
    });

    moreButton?.addEventListener('click', (event) => {
      event.stopPropagation();
      const rect = moreButton.getBoundingClientRect();
      openTaskContextMenu({
        preventDefault() {},
        stopPropagation() {},
        clientX: rect.right,
        clientY: rect.bottom,
      }, app, box, task);
    });

    item.addEventListener('contextmenu', (event) => {
      if (task) openTaskContextMenu(event, app, box, task);
    });

    if (!task.archived) bindSwipeDelete(item, box.id, app, task);
  });

  if (boxType !== BOX_TYPE_COLLECTION || app.querySelector('#openTasks')) enableLongPressReorder(app, box.id);
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
        deleteTaskWithUndo(app, boxId, taskSnapshot);
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
      if (event.target.closest('button')) return;
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

function openBoxItemEditor({ taskId, boxId }, onDone) {
  const box = getBoxes().find((item) => item.id === boxId);
  const boxType = inferBoxType(box);
  if (boxType === BOX_TYPE_POOL) return openPoolItemEditor({ taskId, boxId }, onDone);
  if (boxType === BOX_TYPE_COLLECTION) return openCollectionItemEditor({ taskId, boxId }, onDone);
  return openTaskEditor({ taskId, boxId }, onDone);
}

function openPoolItemEditor({ taskId, boxId }, onDone) {
  const boxes = getBoxes().filter((box) => inferBoxType(box) === BOX_TYPE_POOL);
  const task = getTasksByBox(boxId).find((item) => item.id === taskId);
  const { root, close } = openSheet(`
    <div class="sheet-handle"></div>
    <div class="sheet-content typed-editor pool-editor">
      <p class="eyebrow">Choice Editor</p>
      <h3>${task ? '编辑选项' : '添加选项'}</h3>
      <p class="sheet-lead">选项使用后不会消失；冷却时间可以避免短时间内反复抽中。</p>
      <label>选项名称<input id="poolContent" class="input" value="${escapeHtml(task?.content || '')}" placeholder="例如：散步 20 分钟"></label>
      <div class="typed-editor-grid">
        <label>预计时长（分钟）<input id="poolDuration" class="input" type="number" min="0" step="5" value="${task?.durationMinutes || ''}" placeholder="20"></label>
        <label>抽取权重<input id="poolWeight" class="input" type="number" min="1" step="1" value="${task?.weight || 1}"></label>
      </div>
      <label>使用后冷却
        <div class="cooldown-presets">
          ${[[0, '不冷却'], [30, '30 分钟'], [120, '2 小时'], [1440, '1 天']].map(([value, label]) => `<button type="button" class="schedule-preset ${(task?.cooldownMinutes || 0) === value ? 'active' : ''}" data-cooldown="${value}">${label}</button>`).join('')}
        </div>
        <input id="poolCooldown" class="input" type="number" min="0" step="10" value="${task?.cooldownMinutes || 0}" aria-label="冷却分钟数">
      </label>
      <label>需要积分（选填）<input id="poolPointsCost" class="input" type="number" min="0" step="1" value="${task?.pointsCost || 0}"></label>
      <label>所属选项池<select id="poolBox" class="input">${boxes.map((box) => `<option value="${box.id}" ${box.id === (task?.boxId || boxId) ? 'selected' : ''}>${escapeHtml(box.name)}</option>`).join('')}</select></label>
      <label>使用说明（可选）<textarea id="poolNote" class="input" rows="4" placeholder="适用场景、准备条件或注意事项">${escapeHtml(task?.note || '')}</textarea></label>
      <div class="sheet-actions"><button class="btn" id="cancelPoolBtn">取消</button><button class="btn primary" id="savePoolBtn">保存选项</button></div>
    </div>
  `, { height: '82vh' });
  const cooldownInput = root.querySelector('#poolCooldown');
  root.querySelectorAll('[data-cooldown]').forEach((button) => {
    button.addEventListener('click', () => {
      cooldownInput.value = button.dataset.cooldown;
      root.querySelectorAll('[data-cooldown]').forEach((item) => item.classList.toggle('active', item === button));
    });
  });
  root.querySelector('#cancelPoolBtn').addEventListener('click', close);
  const save = () => {
    const content = root.querySelector('#poolContent').value.trim();
    if (!content) return showToast('先填写选项名称');
    const payload = {
      content,
      boxId: root.querySelector('#poolBox').value,
      itemType: BOX_TYPE_POOL,
      durationMinutes: Math.max(0, Number(root.querySelector('#poolDuration').value) || 0),
      weight: Math.max(1, Number(root.querySelector('#poolWeight').value) || 1),
      cooldownMinutes: Math.max(0, Number(cooldownInput.value) || 0),
      pointsCost: Math.max(0, Number(root.querySelector('#poolPointsCost').value) || 0),
      note: root.querySelector('#poolNote').value.trim(),
      isCompleted: false,
    };
    if (task) updateTask(task.id, payload);
    else addTask(payload);
    close();
    showToast(task ? '选项已更新' : '选项已加入池中');
    onDone();
  };
  root.querySelector('#savePoolBtn').addEventListener('click', save);
  root.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      save();
    }
  });
}

function normalizeExternalUrl(value) {
  const clean = String(value || '').trim();
  if (!clean) return '';
  return /^[a-z][a-z\d+.-]*:/i.test(clean) ? clean : `https://${clean}`;
}

function openCollectionItemEditor({ taskId, boxId }, onDone) {
  const boxes = getBoxes().filter((box) => inferBoxType(box) === BOX_TYPE_COLLECTION);
  const task = getTasksByBox(boxId).find((item) => item.id === taskId);
  const { root, close } = openSheet(`
    <div class="sheet-handle"></div>
    <div class="sheet-content typed-editor collection-editor">
      <p class="eyebrow">Reference Editor</p>
      <h3>${task ? '编辑条目' : '收藏新内容'}</h3>
      <p class="sheet-lead">资料不需要“完成”，用标题、链接和标签让它更容易被再次找到。</p>
      <label>标题<input id="collectionContent" class="input" value="${escapeHtml(task?.content || '')}" placeholder="例如：本周值得复习的文章"></label>
      <label>链接（可选）<input id="collectionUrl" class="input" type="url" value="${escapeHtml(task?.url || '')}" placeholder="https://"></label>
      <label>标签（用逗号分隔）<input id="collectionTags" class="input" value="${escapeHtml((task?.tags || []).join(', '))}" placeholder="复盘, 写作, 稍后阅读"></label>
      <label>所属资料清单<select id="collectionBox" class="input">${boxes.map((box) => `<option value="${box.id}" ${box.id === (task?.boxId || boxId) ? 'selected' : ''}>${escapeHtml(box.name)}</option>`).join('')}</select></label>
      <label>摘要或备注<textarea id="collectionNote" class="input" rows="5" placeholder="为什么值得保留，下次从哪里继续">${escapeHtml(task?.note || '')}</textarea></label>
      <label class="collection-favorite-toggle"><input id="collectionFavorite" type="checkbox" ${task?.favorite ? 'checked' : ''}><span>设为常用，固定在清单前面</span></label>
      <div class="sheet-actions"><button class="btn" id="cancelCollectionBtn">取消</button><button class="btn primary" id="saveCollectionBtn">保存条目</button></div>
    </div>
  `, { height: '78vh' });
  root.querySelector('#cancelCollectionBtn').addEventListener('click', close);
  const save = () => {
    const content = root.querySelector('#collectionContent').value.trim();
    if (!content) return showToast('先填写条目标题');
    const payload = {
      content,
      boxId: root.querySelector('#collectionBox').value,
      itemType: BOX_TYPE_COLLECTION,
      url: normalizeExternalUrl(root.querySelector('#collectionUrl').value),
      tags: root.querySelector('#collectionTags').value.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean),
      note: root.querySelector('#collectionNote').value.trim(),
      favorite: root.querySelector('#collectionFavorite').checked,
      isCompleted: false,
    };
    if (task) updateTask(task.id, payload);
    else addTask(payload);
    close();
    showToast(task ? '条目已更新' : '内容已收藏');
    onDone();
  };
  root.querySelector('#saveCollectionBtn').addEventListener('click', save);
  root.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      save();
    }
  });
}

function openTaskEditor({ taskId, boxId }, onDone) {
  const boxes = getBoxes();
  const taskBoxes = boxes.filter(isTaskBox);
  const currentTasks = getTasksByBox(boxId);
  const task = currentTasks.find((item) => item.id === taskId);
  const initialBox = taskBoxes.find((box) => box.id === (task?.boxId || boxId)) || taskBoxes[0] || null;
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

      <label>计划时间
        <div class="schedule-presets" aria-label="快捷安排时间">
          ${SCHEDULE_PRESETS.map((preset) => `<button class="schedule-preset" data-schedule-preset="${preset.value}">${preset.label}</button>`).join('')}
        </div>
        <input id="taskScheduledAt" class="input" type="datetime-local" value="${escapeHtml(toDateTimeLocalValue(task?.scheduledAt))}">
      </label>
      <label>截止时间
        <div class="schedule-presets deadline-presets" aria-label="快捷设置截止时间">
          ${DEADLINE_PRESETS.map((preset) => `<button class="schedule-preset deadline-preset" data-deadline-preset="${preset.value}"><strong>${preset.label}</strong>${preset.time ? `<small>${preset.time}</small>` : ''}</button>`).join('')}
        </div>
        <input id="taskDate" class="input" type="datetime-local" value="${escapeHtml(toDateTimeLocalValue(task?.dueDate))}">
      </label>
      ${renderDeviceContextField(task?.deviceContext || 'desktop', 'detail-task-device')}
      ${task?.recurrenceTemplateId
        ? `<div class="recurrence-readonly"><span>↻</span><div><strong>${escapeHtml(getRecurrenceLabel(task.recurrence))}</strong><small>这里修改的内容只影响本次；整个周期可在首页“周期任务”中暂停或停止。</small></div></div>`
        : renderRecurrenceEditor('detail-task')}
      <label>抽奖权重（选填，默认 1）<input id="taskWeight" class="input" type="number" min="1" step="1" placeholder="1" value="${task?.weight ?? ''}"></label>
      <label>完成奖励积分<input id="taskPointsValue" class="input" type="number" min="0" step="1" value="${initialPoints}"></label>
      <label>所属盒子
        <select id="taskBox" class="input">
          ${taskBoxes.map((box) => `<option value="${box.id}" ${box.id === (task?.boxId || boxId) ? 'selected' : ''}>${escapeHtml(box.name)}</option>`).join('')}
        </select>
      </label>
      ${renderMainlineTaskFields(task || {})}
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
  const scheduledInput = root.querySelector('#taskScheduledAt');
  const dueInput = root.querySelector('#taskDate');
  const recurrenceEditor = task?.recurrenceTemplateId
    ? { getValue: () => null }
    : bindRecurrenceEditor(root, { prefix: 'detail-task', scheduledInput });
  const mainlineFields = bindMainlineTaskFields(root);
  const deviceField = bindDeviceContextField(root, 'detail-task-device', 'desktop');

  root.querySelectorAll('[data-schedule-preset]').forEach((button) => {
    button.addEventListener('click', () => {
      scheduledInput.value = toDateTimeLocalValue(getSchedulePresetValue(button.dataset.schedulePreset));
      root.querySelectorAll('[data-schedule-preset]').forEach((item) => item.classList.toggle('active', item === button));
    });
  });
  scheduledInput.addEventListener('input', () => {
    root.querySelectorAll('[data-schedule-preset]').forEach((item) => item.classList.remove('active'));
  });
  root.querySelectorAll('[data-deadline-preset]').forEach((button) => {
    button.addEventListener('click', () => {
      dueInput.value = toDateTimeLocalValue(getDeadlinePresetValue(button.dataset.deadlinePreset));
      root.querySelectorAll('[data-deadline-preset]').forEach((item) => item.classList.toggle('active', item === button));
    });
  });
  dueInput.addEventListener('input', () => {
    root.querySelectorAll('[data-deadline-preset]').forEach((item) => item.classList.remove('active'));
  });

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
    const selectedBox = taskBoxes.find((box) => box.id === boxSelect.value);
    const referenceTask = task ? { ...task, boxId: boxSelect.value, priority } : { boxId: boxSelect.value, priority };
    pointsInput.value = String(getTaskPointValue(referenceTask, selectedBox));
  });

  root.querySelector('#cancelBtn').addEventListener('click', close);
  const saveTask = () => {
    const content = root.querySelector('#taskContent').value.trim();
    if (!content) {
      showToast('先填写任务内容');
      return;
    }

    const nextBoxId = root.querySelector('#taskBox').value;
    const selectedBox = taskBoxes.find((box) => box.id === nextBoxId) || null;
    const scheduledAt = root.querySelector('#taskScheduledAt').value || null;
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
      scheduledAt: fromDateTimeLocalValue(scheduledAt),
      dueDate: fromDateTimeLocalValue(due),
      boxId: nextBoxId,
      deviceContext: deviceField.getValue(),
      ...mainlineFields.getValue(),
      note: root.querySelector('#taskNote').value.trim(),
      isCompleted: done,
      completedAt: done ? (task?.completedAt || new Date().toISOString()) : null,
    };

    if (task) {
      const previousPointsValue = getTaskPointValue(task, taskBoxes.find((box) => box.id === task.boxId) || null);
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
      const recurrence = recurrenceEditor.getValue();
      const created = recurrence ? addRecurringTask(payload, recurrence) : addTask(payload);
      if (created?.isCompleted) {
        const pointsResult = syncTaskCompletionPoints({ task: created, box: selectedBox, completed: true });
        if (pointsResult.changed) showToast(`已获得 +${pointsResult.delta} 积分`);
      }
      if (recurrence) showToast('周期任务已创建');
    }

    close();
    onDone();
  };
  root.querySelector('#saveBtn').addEventListener('click', saveTask);
  root.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      saveTask();
    }
  });
}
