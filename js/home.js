import { addBox, addRecurringTask, addTask, deleteBox, deleteRecurringSeries, getBoxes, getMainlines, getMilestones, getRecurringTemplates, getSettings, getTasks, getTimelineTasks, playSound, pullDataFromCloud, setHomePinnedBox, setRecurringTemplatePaused, updateRecurringTemplate, updateTask } from './db.js';
import { navigate, openSheet, showToast } from './app.js';
import { getPointsSummary, getTaskPointValue, syncTaskCompletionPoints } from './points-store.js';
import { getRecurrenceLabel } from './recurrence.js';
import { bindRecurrenceEditor, renderRecurrenceEditor } from './recurrence-ui.js';
import { openBoxTypeChangeSheet } from './box-type-sheet.js';
import { renderCoreBoxNav } from './core-box-nav.js';
import { bindMainlineTaskFields, renderMainlineTaskFields } from './mainline-fields.js';
import { bindDeviceContextField, getDeviceContextLabel, getTaskContextRank, isTaskReleased, renderDeviceContextField } from './task-visibility.js';
import { bindExecutionModeField, getExecutionModeLabel, renderExecutionModeField } from './task-execution.js';
import {
  BOX_TYPE_COLLECTION,
  BOX_TYPE_POOL,
  bindBoxTypeOptions,
  getBoxTypeDefinition,
  getPoolCooldownState,
  inferBoxType,
  isTaskBox,
  renderBoxTypeOptions,
} from './box-types.js';
import {
  formatDueLabel,
  formatScheduledLabel,
  fromDateTimeLocalValue,
  getBoxDailySentence,
  getDeadlinePresetValue,
  getLocalWeek,
  getSchedulePresetValue,
  isSameLocalDay,
  isTaskNeedsReschedule,
  isTaskOverdue,
  localDateFromKey,
  localDateKey,
  toDateTimeLocalValue,
} from './task-utils.js';

const BOX_FALLBACK_COPY = {
  important: '把最高优先级的事情放到最显眼的位置。',
  relax: '给自己留一块明确的恢复区，休息也有边界。',
  reward: '完成关键任务后，用奖励把正反馈接起来。',
  misc: '零散待办先收纳，再集中处理。',
  punish: '拖延的代价被看见，执行会更坚定。',
  study: '把碎片时间沉淀成持续学习的轨迹。',
  health: '每天推进一点，身体状态会稳定很多。',
};
const FIXED_HOME_BOX_COLORS = new Set(['important', 'misc']);
const BOX_ACCENTS = {
  important: '#f9734e',
  misc: '#2f6df6',
  relax: '#0ea5a4',
  reward: '#f6c445',
  punish: '#334155',
  study: '#22c55e',
  health: '#0f9bd7',
};
const WEEKDAY_LABELS = ['一', '二', '三', '四', '五', '六', '日'];
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

let selectedHomeDateKey = localDateKey(new Date());
let showAllAgendaTasks = false;
let boxContextMenuCleanup = null;

function cardSizeClass(box) {
  if (box.sortOrder === 0) return 'large';
  if (box.sortOrder === 1 || box.sortOrder === 2) return 'mid';
  return 'small';
}

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function getMainlineColor(value) {
  return /^#[0-9a-f]{6}$/i.test(value || '') ? value : '#6f4bd8';
}

function renderHomeMainlines(mainlines, milestones, tasks) {
  const visible = mainlines.filter((mainline) => mainline.status === 'active' || mainline.status === 'maintenance');
  if (!visible.length) {
    return '<button class="mainline-home-empty" id="emptyMainlineBtn"><span>◇</span><strong>建立第一条主线</strong><small>把分散任务串成一个明确结果。</small></button>';
  }
  return visible.map((mainline) => {
    const lineMilestones = milestones.filter((milestone) => milestone.mainlineId === mainline.id);
    const completed = lineMilestones.filter((milestone) => milestone.status === 'completed').length;
    const percent = lineMilestones.length ? Math.round((completed / lineMilestones.length) * 100) : 0;
    const openTasks = tasks.filter((task) => task.mainlineId === mainline.id && !task.isCompleted);
    const next = [...openTasks].sort((left, right) => new Date(left.dueDate || left.scheduledAt || left.createdAt) - new Date(right.dueDate || right.scheduledAt || right.createdAt))[0];
    return `
      <button class="mainline-home-card ${mainline.isWeeklyFocus ? 'focus' : ''}" data-mainline-id="${mainline.id}" style="--mainline-color:${getMainlineColor(mainline.color)}">
        <span class="mainline-home-rail"><i style="height:${percent}%"></i></span>
        <span class="mainline-home-copy">
          <span class="mainline-home-kicker">${mainline.isWeeklyFocus ? '本周重点' : (mainline.status === 'maintenance' ? '维持中' : '推进中')} · ${completed}/${lineMilestones.length} 里程碑</span>
          <strong>${escapeHtml(mainline.name)}</strong>
          <small>${escapeHtml(mainline.currentPhase || '尚未填写当前阶段')}</small>
          <em>${next ? `下一步：${escapeHtml(next.content)}` : '主线断档 · 补一条下一步行动'}</em>
        </span>
        <b>${percent}%</b>
      </button>
    `;
  }).join('');
}

function getGreeting(now = new Date()) {
  const hour = now.getHours();
  if (hour < 6) return '夜间收束';
  if (hour < 12) return '早晨推进';
  if (hour < 18) return '午后节奏';
  return '今晚聚焦';
}

function formatToday(now = new Date()) {
  return now.toLocaleDateString('zh-CN', {
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  });
}

function getBoxDescription(box) {
  return getBoxDailySentence(box, BOX_FALLBACK_COPY[box.color] || '把相关任务装进一个盒子，减少注意力切换。');
}

function getProgressLabel(box, boxTasks, pendingTasks, finished) {
  const boxType = inferBoxType(box);
  if (boxType === BOX_TYPE_POOL) {
    if (!boxTasks.length) return '等待加入可重复选项';
    return `${pendingTasks.length} 个现在可用`;
  }
  if (boxType === BOX_TYPE_COLLECTION) {
    if (!boxTasks.length) return '等待收藏第一条内容';
    return `${boxTasks.length} 条收藏 · ${finished} 条常用`;
  }
  if (!boxTasks.length) return '空盒子';
  if (!pendingTasks.length) return '已清空';
  return `完成 ${finished}/${boxTasks.length}`;
}

function isActionableBox(box) {
  return isTaskBox(box);
}

function getBoxContentLabel(box, pendingCount) {
  const boxType = inferBoxType(box);
  if (boxType === 'task') return pendingCount ? '待处理任务' : '暂无待办';
  if (boxType === BOX_TYPE_COLLECTION) return pendingCount ? '收藏条目' : '暂无内容';
  return pendingCount ? '可抽取项' : '暂无内容';
}

function getBoxMetaLabel(box, pendingCount) {
  const boxType = inferBoxType(box);
  if (boxType === 'task') return `${pendingCount} 项待办`;
  if (boxType === BOX_TYPE_COLLECTION) return `${pendingCount} 条收藏`;
  return `${pendingCount} 项候选`;
}

function renderBoxPreview(box, pendingTasks) {
  if (box.sortOrder === 0) {
    const preview = pendingTasks.slice(0, 3);
    if (!preview.length) {
      return '<ul class="important-preview empty"><li>当前没有待办，继续保持。</li></ul>';
    }

    return `<ul class="important-preview">${preview.map((task) => `<li>${escapeHtml(task.content)}</li>`).join('')}</ul>`;
  }

  return `
    <div class="box-main">
      <b>${pendingTasks.length}</b>
      <span>${getBoxContentLabel(box, pendingTasks.length)}</span>
    </div>
  `;
}

function shiftDate(value, days) {
  const date = new Date(value);
  date.setDate(date.getDate() + days);
  return date;
}

function formatWeekRange(week) {
  const first = week[0];
  const last = week[6];
  if (first.getMonth() === last.getMonth()) {
    return `${first.getMonth() + 1}月${first.getDate()}日 - ${last.getDate()}日`;
  }
  return `${first.getMonth() + 1}月${first.getDate()}日 - ${last.getMonth() + 1}月${last.getDate()}日`;
}

function formatSelectedDay(date, now) {
  if (isSameLocalDay(date, now)) return `今天 · ${date.getMonth() + 1}月${date.getDate()}日`;
  if (isSameLocalDay(date, shiftDate(now, 1))) return `明天 · ${date.getMonth() + 1}月${date.getDate()}日`;
  return `${date.getMonth() + 1}月${date.getDate()}日 · 周${WEEKDAY_LABELS[(date.getDay() || 7) - 1]}`;
}

function getAgenda(tasks, boxMap, dateKey, now) {
  const selectedDate = localDateFromKey(dateKey) || now;
  const isToday = isSameLocalDay(selectedDate, now);
  const actionable = (task) => isActionableBox(boxMap.get(task.boxId));
  const matchesSelectedDate = (task) => (
    localDateKey(task.scheduledAt) === dateKey
    || localDateKey(task.dueDate) === dateKey
  );
  const open = tasks
    .filter((task) => !task.isCompleted && !task.deleted && actionable(task))
    .filter((task) => (isToday ? isTaskReleased(task, now) : !task.deferredAt))
    .filter((task) => matchesSelectedDate(task) || (isToday && isTaskOverdue(task, now)))
    .sort((left, right) => {
      const overdueDiff = Number(isTaskOverdue(right, now)) - Number(isTaskOverdue(left, now));
      const leftTime = new Date(left.scheduledAt || left.dueDate || '9999-12-31').getTime();
      const rightTime = new Date(right.scheduledAt || right.dueDate || '9999-12-31').getTime();
      return overdueDiff
        || (Number(left.pinLevel) || 99) - (Number(right.pinLevel) || 99)
        || getTaskContextRank(left, getSettings()) - getTaskContextRank(right, getSettings())
        || leftTime - rightTime
        || (Number(right.priority) || 0) - (Number(left.priority) || 0);
    });
  const completed = tasks.filter((task) => task.isCompleted && actionable(task) && localDateKey(task.completedAt) === dateKey);
  return { open, completed, selectedDate };
}

function getDayTaskCount(tasks, boxMap, date, now = new Date()) {
  const key = localDateKey(date);
  const isToday = isSameLocalDay(date, now);
  return tasks.filter((task) => (
    !task.isCompleted
    && !task.deleted
    && (isToday ? isTaskReleased(task, now) : !task.deferredAt)
    && isActionableBox(boxMap.get(task.boxId))
    && (localDateKey(task.scheduledAt) === key || localDateKey(task.dueDate) === key)
  )).length;
}

function renderAgendaTask(task, box, now) {
  const overdue = isTaskOverdue(task, now);
  const needsReschedule = isTaskNeedsReschedule(task, now);
  const planned = task.scheduledAt ? formatScheduledLabel(task.scheduledAt, now) : '';
  const due = task.dueDate ? formatDueLabel(task.dueDate, now) : '';
  let timing = planned ? `计划 ${planned}` : due;
  if (overdue) timing = due || '已逾期';
  if (needsReschedule) timing = `待重新安排 · ${planned}`;

  return `
    <article class="day-task-row execution-${escapeHtml(task.executionMode || 'self')} ${overdue ? 'is-overdue' : ''} ${needsReschedule ? 'needs-reschedule' : ''}" data-agenda-task="${task.id}">
      <button class="day-task-check task-check-control" style="--check-color:${BOX_ACCENTS[box?.color] || BOX_ACCENTS.important}" data-agenda-complete="${task.id}" aria-label="完成 ${escapeHtml(task.content)}"></button>
      <button class="day-task-open" data-agenda-open="${task.id}">
        <span class="day-task-title">${escapeHtml(task.content)}</span>
        <span class="day-task-meta">
          <i class="day-box-mark ${escapeHtml(box?.color || 'important')}"></i>
          ${escapeHtml(box?.name || '未分类')} · ${escapeHtml(getDeviceContextLabel(task.deviceContext))} · ${task.executionMode === 'ai' ? '✦ ' : ''}${escapeHtml(getExecutionModeLabel(task.executionMode))}${task.recurrence ? ` · ↻ ${escapeHtml(getRecurrenceLabel(task.recurrence))}` : ''}${timing ? ` · ${escapeHtml(timing)}` : ''}
        </span>
      </button>
    </article>
  `;
}

function closeBoxContextMenu() {
  boxContextMenuCleanup?.();
  boxContextMenuCleanup = null;
  document.querySelector('.box-context-menu')?.remove();
}

function openDeleteBoxSheet(app, box, activeCount) {
  closeBoxContextMenu();
  if (FIXED_HOME_BOX_COLORS.has(box.color)) {
    showToast('重要盒和待办盒属于核心盒，不能删除');
    return;
  }
  if (activeCount > 0) {
    showToast(`盒内还有 ${activeCount} 条内容，清空后才能删除`);
    return;
  }

  const { root, close } = openSheet(`
    <div class="sheet-handle"></div>
    <div class="sheet-content box-delete-confirm">
      <p class="eyebrow">Delete Box</p>
      <h3>删除“${escapeHtml(box.name)}”？</h3>
      <p class="sheet-lead">这个盒子已经清空。删除后将从首页移除，操作不可撤销。</p>
      <div class="sheet-actions">
        <button class="btn" id="cancelBoxDeleteBtn">保留盒子</button>
        <button class="btn danger" id="confirmBoxDeleteBtn">确认删除</button>
      </div>
    </div>
  `, { height: '38vh' });
  root.querySelector('#cancelBoxDeleteBtn').addEventListener('click', close);
  root.querySelector('#confirmBoxDeleteBtn').addEventListener('click', () => {
    try {
      deleteBox(box.id);
      close();
      showToast('盒子已删除');
      renderHome(app);
    } catch (error) {
      showToast(error?.message === 'box_not_empty' ? '盒内仍有内容，暂时不能删除' : '盒子删除失败');
    }
  });
}

function openBoxContextMenu(event, app, box, tasks) {
  event.preventDefault();
  event.stopPropagation();
  closeBoxContextMenu();
  const fixed = FIXED_HOME_BOX_COLORS.has(box.color);
  const activeCount = tasks.filter((task) => task.boxId === box.id).length;
  const menu = document.createElement('div');
  menu.className = 'task-context-menu box-context-menu';
  menu.style.setProperty('--box-accent', BOX_ACCENTS[box.color] || BOX_ACCENTS.important);
  menu.innerHTML = `
    <div class="task-context-title">${escapeHtml(box.name)}</div>
    ${fixed ? `
      <div class="box-position-lock">
        <span aria-hidden="true">⌂</span>
        <div><strong>固定在第${box.color === 'important' ? '一' : '二'}位</strong><small>核心盒无需置顶</small></div>
      </div>
    ` : `
      <button type="button" data-action="pin" class="pin-box-action">
        <span class="task-context-action-icon" aria-hidden="true">${box.homePinned ? '↓' : '↑'}</span>
        <span>${box.homePinned ? '取消第三位置顶' : '置顶到第三位'}</span>
      </button>
    `}
    <div class="task-context-divider" aria-hidden="true"></div>
    <button type="button" data-action="type">
      <span class="task-context-action-icon" aria-hidden="true">${getBoxTypeDefinition(box).icon}</span>
      <span>修改盒子类型</span>
    </button>
    <button type="button" data-action="delete" class="danger ${fixed ? 'is-disabled' : ''}">${fixed ? '核心盒不可删除' : '删除盒子'}</button>
  `;
  document.body.appendChild(menu);

  const rect = menu.getBoundingClientRect();
  const x = Math.min(event.clientX, window.innerWidth - rect.width - 12);
  const y = Math.min(event.clientY, window.innerHeight - rect.height - 12);
  menu.style.left = `${Math.max(12, x)}px`;
  menu.style.top = `${Math.max(12, y)}px`;

  menu.addEventListener('click', (clickEvent) => {
    const action = clickEvent.target?.closest?.('button[data-action]')?.dataset?.action;
    if (action === 'pin' && !fixed) {
      const pinned = setHomePinnedBox(box.id);
      closeBoxContextMenu();
      showToast(pinned ? `${box.name}已置顶到第三位` : `${box.name}已取消置顶`);
      renderHome(app);
    }
    if (action === 'type') {
      closeBoxContextMenu();
      openBoxTypeChangeSheet(box, () => renderHome(app));
    }
    if (action === 'delete') openDeleteBoxSheet(app, box, activeCount);
  });

  const onPointerDown = (pointerEvent) => {
    if (!menu.contains(pointerEvent.target)) closeBoxContextMenu();
  };
  const onKeyDown = (keyEvent) => {
    if (keyEvent.key === 'Escape') closeBoxContextMenu();
  };
  setTimeout(() => document.addEventListener('pointerdown', onPointerDown), 0);
  document.addEventListener('keydown', onKeyDown);
  boxContextMenuCleanup = () => {
    document.removeEventListener('pointerdown', onPointerDown);
    document.removeEventListener('keydown', onKeyDown);
  };
}

function renderSchedulePresets() {
  return SCHEDULE_PRESETS.map((preset) => `<button class="schedule-preset" data-schedule-preset="${preset.value}">${preset.label}</button>`).join('');
}

function renderDeadlinePresets() {
  return DEADLINE_PRESETS.map((preset) => `<button class="schedule-preset deadline-preset" data-deadline-preset="${preset.value}"><strong>${preset.label}</strong>${preset.time ? `<small>${preset.time}</small>` : ''}</button>`).join('');
}

function bindSchedulePresets(root, input) {
  root.querySelectorAll('[data-schedule-preset]').forEach((button) => {
    button.addEventListener('click', () => {
      input.value = toDateTimeLocalValue(getSchedulePresetValue(button.dataset.schedulePreset));
      root.querySelectorAll('[data-schedule-preset]').forEach((item) => item.classList.toggle('active', item === button));
    });
  });
  input.addEventListener('input', () => {
    root.querySelectorAll('[data-schedule-preset]').forEach((item) => item.classList.remove('active'));
  });
}

function bindDeadlinePresets(root, input) {
  root.querySelectorAll('[data-deadline-preset]').forEach((button) => {
    button.addEventListener('click', () => {
      input.value = toDateTimeLocalValue(getDeadlinePresetValue(button.dataset.deadlinePreset));
      root.querySelectorAll('[data-deadline-preset]').forEach((item) => item.classList.toggle('active', item === button));
    });
  });
  input.addEventListener('input', () => {
    root.querySelectorAll('[data-deadline-preset]').forEach((item) => item.classList.remove('active'));
  });
}

function getScheduleForDate(dateKey, now = new Date()) {
  const date = localDateFromKey(dateKey);
  if (!date || isSameLocalDay(date, now)) return getSchedulePresetValue('today', now);
  date.setHours(9, 0, 0, 0);
  return date.toISOString();
}

function enterSmallWorld(app) {
  const fx = document.createElement('div');
  fx.className = 'sw-lightflow';
  fx.innerHTML = Array.from({ length: 28 }).map(() => '<span></span>').join('');
  app.appendChild(fx);
  requestAnimationFrame(() => fx.classList.add('show'));
  setTimeout(() => {
    navigate('#smallworld');
    fx.remove();
  }, 420);
}

export function renderHome(app) {
  const boxes = getBoxes();
  const mainlines = getMainlines();
  const milestones = getMilestones();
  const tasks = getTasks();
  const timelineTasks = getTimelineTasks();
  const recurringTemplates = getRecurringTemplates();
  const pointsSummary = getPointsSummary();
  const boxMap = new Map(boxes.map((box) => [box.id, box]));
  const taskMap = new Map(timelineTasks.map((task) => [task.id, task]));
  const now = new Date();
  if (!localDateFromKey(selectedHomeDateKey)) selectedHomeDateKey = localDateKey(now);
  const selectedDate = localDateFromKey(selectedHomeDateKey) || now;
  const week = getLocalWeek(selectedDate);
  const agenda = getAgenda(timelineTasks, boxMap, selectedHomeDateKey, now);
  const visibleAgenda = showAllAgendaTasks ? agenda.open : agenda.open.slice(0, 4);
  const doneTasks = tasks.filter((task) => task.isCompleted && isActionableBox(boxMap.get(task.boxId)));
  const openTasks = tasks.filter((task) => !task.isCompleted);
  const actionableTasks = openTasks.filter((task) => isActionableBox(boxMap.get(task.boxId)));
  const overdueTasks = actionableTasks.filter((task) => isTaskOverdue(task, now));

  app.innerHTML = `
    <main id="home" class="page">
      <section class="home-hero panel safe-top">
        <div class="home-topline">
          <div class="hero-copy">
            <p class="eyebrow">${escapeHtml(formatToday(now))}</p>
            <h1 class="hero-title">${escapeHtml(getGreeting(now))}</h1>
            <p class="hero-subtitle">把任务拆进盒子，也把行动放回具体的一天。</p>
          </div>
          <div class="row gap8 hero-tools">
            ${renderCoreBoxNav()}
            <button class="icon-btn icon-btn-ghost" id="homePullBtn" aria-label="拉取盒子数据">↻</button>
            <button class="icon-btn icon-btn-ghost" id="smallWorldEntry" aria-label="进入小世界">◎</button>
            <button class="icon-btn icon-btn-ghost points-tool-btn" id="pointsEntry" aria-label="积分 ${pointsSummary.balance}"><span>◆</span><small>${pointsSummary.balance}</small></button>
            <button class="icon-btn icon-btn-ghost" id="settingsBtn" aria-label="设置">⚙</button>
          </div>
        </div>

        <div class="hero-stats">
          <article class="stat-card"><span>待处理</span><strong>${actionableTasks.length}</strong></article>
          <article class="stat-card"><span>已完成</span><strong>${doneTasks.length}</strong></article>
          <article class="stat-card"><span>逾期项</span><strong>${overdueTasks.length}</strong></article>
        </div>
      </section>

      <section class="home-date-board panel" aria-label="本周行动节奏">
        <div class="home-week-head">
          <div>
            <p class="eyebrow">Weekly Rhythm</p>
            <h2>${escapeHtml(formatWeekRange(week))}</h2>
          </div>
          <div class="week-nav">
            <button id="previousWeekBtn" aria-label="上一周">‹</button>
            <button id="homeTodayBtn">今天</button>
            <button id="nextWeekBtn" aria-label="下一周">›</button>
          </div>
        </div>

        <div class="week-strip">
          ${week.map((date, index) => {
            const key = localDateKey(date);
            const count = getDayTaskCount(timelineTasks, boxMap, date, now);
            return `
              <button class="week-day ${key === selectedHomeDateKey ? 'active' : ''} ${isSameLocalDay(date, now) ? 'today' : ''}" data-home-date="${key}">
                <span>周${WEEKDAY_LABELS[index]}</span>
                <strong>${date.getDate()}</strong>
                <i class="${count ? 'has-tasks' : ''}">${count || ''}</i>
              </button>
            `;
          }).join('')}
        </div>

        <div class="day-agenda">
          <div class="day-agenda-head">
            <div>
              <h3>${escapeHtml(formatSelectedDay(agenda.selectedDate, now))}</h3>
              <p>${agenda.open.length} 项行动${agenda.completed.length ? ` · 已完成 ${agenda.completed.length}` : ''}</p>
            </div>
            <div class="day-agenda-actions">
              <button class="recurring-manager-btn" id="recurringManagerBtn">↻ 周期 ${recurringTemplates.length}</button>
              <button class="agenda-add-btn" id="agendaAddBtn">＋ 安排</button>
            </div>
          </div>
          <div class="day-task-list">
            ${visibleAgenda.length
              ? visibleAgenda.map((task) => renderAgendaTask(task, boxMap.get(task.boxId), now)).join('')
              : '<div class="day-agenda-empty"><strong>这一天还没有安排</strong><span>给重要行动一个明确的位置，执行会更轻松。</span></div>'}
          </div>
          ${agenda.open.length > 4 ? `<button class="agenda-expand-btn" id="agendaExpandBtn">${showAllAgendaTasks ? '收起' : `展开其余 ${agenda.open.length - 4} 项`}</button>` : ''}
        </div>
      </section>

      <section class="section-heading mainline-home-heading">
        <div><p class="eyebrow">Main Threads</p><h2>当前主线</h2></div>
        <button class="btn subtle compact" id="addMainlineBtn">＋ 新主线</button>
      </section>
      <section class="mainline-home-grid">
        ${renderHomeMainlines(mainlines, milestones, tasks)}
      </section>

      <section class="section-heading">
        <div><p class="eyebrow">Life Boxes</p><h2>按场景管理内容</h2></div>
        <p class="section-note">${boxes.length} 个盒子，${tasks.length} 条内容</p>
      </section>

      <section class="box-grid scroll-area home-grid">
        ${boxes.map((box) => {
          const boxType = inferBoxType(box);
          const typeDefinition = getBoxTypeDefinition(boxType);
          const boxTasks = tasks.filter((task) => task.boxId === box.id && !task.archived);
          let pendingTasks = boxTasks.filter((task) => !task.isCompleted);
          let finished = boxTasks.filter((task) => task.isCompleted).length;
          let percent = boxTasks.length ? Math.round((finished / boxTasks.length) * 100) : 0;
          let statusLabel = `${percent}%`;
          if (boxType === BOX_TYPE_POOL) {
            pendingTasks = boxTasks.filter((task) => getPoolCooldownState(task, now).available);
            finished = boxTasks.length - pendingTasks.length;
            percent = boxTasks.length ? Math.round((pendingTasks.length / boxTasks.length) * 100) : 0;
            statusLabel = `${pendingTasks.length}/${boxTasks.length}`;
          } else if (boxType === BOX_TYPE_COLLECTION) {
            pendingTasks = boxTasks;
            finished = boxTasks.filter((task) => task.favorite).length;
            percent = boxTasks.length ? Math.round((finished / boxTasks.length) * 100) : 0;
            statusLabel = `${boxTasks.length} 条`;
          }

          return `
            <button class="box-card ${cardSizeClass(box)} ${box.color} type-${boxType} ${box.homePinned ? 'home-pinned' : ''}" data-box-id="${box.id}">
              <div class="box-head">
                <div class="box-title-group">
                  <span class="box-icon">${escapeHtml(box.icon)}</span>
                  <div class="box-title-block"><strong>${escapeHtml(box.name)}</strong><small>${escapeHtml(getProgressLabel(box, boxTasks, pendingTasks, finished))}</small></div>
                </div>
                <span class="box-card-status">${box.homePinned ? '<i class="box-pinned-mark">第三位</i>' : ''}<i class="box-type-stamp ${boxType}">${typeDefinition.icon} ${typeDefinition.shortLabel}</i><span class="box-progress-label">${statusLabel}</span></span>
              </div>
              <div class="box-desc box-daily-sentence"><span>每日一句</span><p>${escapeHtml(getBoxDescription(box))}</p></div>
              ${renderBoxPreview(box, pendingTasks)}
              <div class="box-meta"><span>${getBoxMetaLabel(box, pendingTasks.length)}</span><span>进入盒子 →</span></div>
              <div class="progress ${boxType === BOX_TYPE_COLLECTION ? 'collection-progress' : ''}"><span style="width:${boxType === BOX_TYPE_COLLECTION ? 100 : percent}%"></span></div>
            </button>
          `;
        }).join('')}
      </section>

      <div class="fab-wrap safe-bottom" id="fabWrap">
        <button class="fab-sub" id="fabBox">＋ 添加盒子</button>
        <button class="fab-sub" id="fabManual">＋ 手动添加</button>
        <button class="fab-sub" id="fabAI">✦ AI提取</button>
        <button class="fab-main" id="fabMain" aria-label="快捷操作">＋</button>
      </div>
    </main>
  `;

  app.querySelectorAll('.box-card').forEach((element) => {
    const box = boxes.find((item) => item.id === element.dataset.boxId);
    let longPressTimer = null;
    let suppressClick = false;
    element.addEventListener('click', (event) => {
      if (suppressClick) {
        suppressClick = false;
        event.preventDefault();
        return;
      }
      navigate(`#box/${element.dataset.boxId}`);
    });
    element.addEventListener('contextmenu', (event) => {
      if (box) openBoxContextMenu(event, app, box, tasks);
    });
    element.addEventListener('pointerdown', (event) => {
      if (event.pointerType !== 'touch' || !box) return;
      longPressTimer = setTimeout(() => {
        suppressClick = true;
        openBoxContextMenu(event, app, box, tasks);
      }, 520);
    });
    ['pointerup', 'pointercancel', 'pointermove'].forEach((eventName) => {
      element.addEventListener(eventName, () => clearTimeout(longPressTimer));
    });
  });
  app.querySelectorAll('[data-home-date]').forEach((button) => {
    button.addEventListener('click', () => {
      selectedHomeDateKey = button.dataset.homeDate;
      showAllAgendaTasks = false;
      renderHome(app);
    });
  });
  app.querySelector('#previousWeekBtn').addEventListener('click', () => {
    selectedHomeDateKey = localDateKey(shiftDate(selectedDate, -7));
    showAllAgendaTasks = false;
    renderHome(app);
  });
  app.querySelector('#nextWeekBtn').addEventListener('click', () => {
    selectedHomeDateKey = localDateKey(shiftDate(selectedDate, 7));
    showAllAgendaTasks = false;
    renderHome(app);
  });
  app.querySelector('#homeTodayBtn').addEventListener('click', () => {
    selectedHomeDateKey = localDateKey(new Date());
    showAllAgendaTasks = false;
    renderHome(app);
  });
  app.querySelector('#agendaAddBtn').addEventListener('click', () => {
    openAddTaskSheet(boxes, { scheduledAt: getScheduleForDate(selectedHomeDateKey, now) });
  });
  app.querySelector('#recurringManagerBtn').addEventListener('click', () => openRecurringManager(app, boxes));
  app.querySelector('#agendaExpandBtn')?.addEventListener('click', () => {
    showAllAgendaTasks = !showAllAgendaTasks;
    renderHome(app);
  });
  app.querySelectorAll('[data-agenda-open]').forEach((button) => {
    button.addEventListener('click', () => {
      const task = taskMap.get(button.dataset.agendaOpen);
      if (task) navigate(`#box/${task.boxId}`);
    });
  });
  app.querySelectorAll('[data-agenda-complete]').forEach((button) => {
    button.addEventListener('click', () => {
      const task = taskMap.get(button.dataset.agendaComplete);
      const box = task ? boxMap.get(task.boxId) : null;
      if (!task || !box) return;
      button.classList.add('checked');
      const nextTask = { ...task, isCompleted: true, progress: 100, completedAt: new Date().toISOString() };
      updateTask(task.id, { isCompleted: true, progress: 100, completedAt: nextTask.completedAt });
      const pointsResult = syncTaskCompletionPoints({ task: nextTask, box, completed: true });
      playSound('complete');
      showToast(pointsResult.changed ? `已完成 · +${pointsResult.delta} 积分` : '任务已完成');
      setTimeout(() => renderHome(app), 180);
    });
  });

  app.querySelector('#smallWorldEntry').addEventListener('click', () => enterSmallWorld(app));
  app.querySelector('#pointsEntry').addEventListener('click', () => navigate('#points'));
  app.querySelector('#homePullBtn').addEventListener('click', async () => {
    try {
      const result = await pullDataFromCloud({ force: true });
      showToast(result === 'merged' ? '已拉取最新盒子数据' : '本地已是最新');
      renderHome(app);
    } catch {
      showToast('盒子数据拉取失败，请检查云端配置');
    }
  });
  app.querySelector('#settingsBtn').addEventListener('click', () => navigate('#settings'));
  app.querySelectorAll('[data-mainline-id]').forEach((button) => button.addEventListener('click', () => navigate(`#mainline/${button.dataset.mainlineId}`)));
  const openNewMainline = async () => {
    const { openMainlineEditor } = await import('./mainline-page.js');
    openMainlineEditor(null, (created) => {
      if (created) navigate(`#mainline/${created.id}`);
      else renderHome(app);
    });
  };
  app.querySelector('#addMainlineBtn').addEventListener('click', openNewMainline);
  app.querySelector('#emptyMainlineBtn')?.addEventListener('click', openNewMainline);
  const fabWrap = app.querySelector('#fabWrap');
  app.querySelector('#fabMain').addEventListener('click', () => fabWrap.classList.toggle('open'));
  app.querySelector('#fabAI').addEventListener('click', openAIExtractSheetLazy);
  app.querySelector('#fabManual').addEventListener('click', () => openAddTaskSheet(boxes));
  app.querySelector('#fabBox').addEventListener('click', openAddBoxSheet);
}

async function openAIExtractSheetLazy() {
  const { openAIExtractSheet } = await import('./ai-extract.js');
  openAIExtractSheet();
}

function openRecurringManager(app, boxes) {
  const templates = getRecurringTemplates();
  const tasks = getTasks();
  const boxMap = new Map(boxes.map((box) => [box.id, box]));
  const { root, close } = openSheet(`
    <div class="sheet-handle"></div>
    <div class="sheet-content recurring-manager-sheet">
      <p class="eyebrow">Recurring Tasks</p>
      <div class="recurring-manager-head">
        <div><h3>周期任务</h3><p class="sheet-lead">每一期独立记录，暂停不会删除历史。</p></div>
        <button class="btn subtle compact" id="newRecurringTaskBtn">＋ 新建</button>
      </div>
      <div class="recurring-template-list">
        ${templates.length ? templates.map((template) => {
          const current = tasks.find((task) => task.recurrenceTemplateId === template.id && !task.isCompleted && !task.deleted);
          const nextAt = current?.scheduledAt || template.nextRunAt || template.scheduledAt;
          const paused = Boolean(template.recurrence?.paused);
          return `
            <article class="recurring-template-card ${paused ? 'is-paused' : ''}" data-recurring-template="${template.id}">
              <div class="recurring-template-main">
                <span class="recurring-mark">↻</span>
                <div>
                  <strong>${escapeHtml(template.content)}</strong>
                  <p>${escapeHtml(boxMap.get(template.boxId)?.name || '未分类')} · ${escapeHtml(getRecurrenceLabel(template.recurrence))}</p>
                  <small>${paused ? '已暂停，不会生成下一期' : `当前/下次：${escapeHtml(formatScheduledLabel(nextAt))}`}</small>
                </div>
              </div>
              <div class="recurring-template-actions">
                <button type="button" data-recurring-edit="${template.id}">编辑</button>
                <button type="button" data-recurring-pause="${template.id}">${paused ? '恢复' : '暂停'}</button>
                <button type="button" class="danger" data-recurring-stop="${template.id}">停止周期</button>
              </div>
            </article>
          `;
        }).join('') : `
          <div class="recurring-empty-state"><span>↻</span><strong>还没有周期任务</strong><p>适合每天上新、间隔发朋友圈、周复盘和月复盘。</p></div>
        `}
      </div>
      <button class="btn" id="closeRecurringManagerBtn">关闭</button>
    </div>
  `, { height: '78vh' });

  root.querySelector('#closeRecurringManagerBtn').addEventListener('click', close);
  root.querySelector('#newRecurringTaskBtn').addEventListener('click', () => {
    close();
    setTimeout(() => openAddTaskSheet(boxes, { focusRecurrence: true }), 240);
  });
  root.querySelectorAll('[data-recurring-edit]').forEach((button) => {
    button.addEventListener('click', () => {
      const template = templates.find((item) => item.id === button.dataset.recurringEdit);
      if (!template) return;
      close();
      setTimeout(() => openRecurringTemplateEditor(app, boxes, template), 240);
    });
  });
  root.querySelectorAll('[data-recurring-pause]').forEach((button) => {
    button.addEventListener('click', () => {
      const template = templates.find((item) => item.id === button.dataset.recurringPause);
      if (!template) return;
      setRecurringTemplatePaused(template.id, !template.recurrence?.paused);
      showToast(template.recurrence?.paused ? '周期任务已恢复' : '周期任务已暂停');
      close();
      renderHome(app);
      setTimeout(() => openRecurringManager(app, boxes), 240);
    });
  });
  root.querySelectorAll('[data-recurring-stop]').forEach((button) => {
    button.addEventListener('click', () => {
      if (button.dataset.confirm !== '1') {
        button.dataset.confirm = '1';
        button.textContent = '再点一次确认';
        setTimeout(() => {
          if (!button.isConnected) return;
          button.dataset.confirm = '';
          button.textContent = '停止周期';
        }, 2600);
        return;
      }
      deleteRecurringSeries(button.dataset.recurringStop);
      showToast('周期已停止，历史记录仍然保留');
      close();
      renderHome(app);
      setTimeout(() => openRecurringManager(app, boxes), 240);
    });
  });
}

function openRecurringTemplateEditor(app, boxes, template) {
  const taskBoxes = boxes.filter(isTaskBox);
  const current = getTasks().find((task) => task.recurrenceTemplateId === template.id && !task.isCompleted && !task.deleted);
  const scheduledAt = current?.scheduledAt || template.scheduledAt || template.recurrence?.anchorAt;
  const dueDate = current?.dueDate || template.dueDate;
  const { root, close } = openSheet(`
    <div class="sheet-handle"></div>
    <div class="sheet-content recurring-series-editor">
      <p class="eyebrow">Edit Series</p>
      <h3>修改本次及以后</h3>
      <p class="sheet-lead">已完成的历史不会变化；当前未完成的一期会同步采用新设置。</p>
      <label>任务内容<input id="seriesContent" class="input" value="${escapeHtml(template.content)}"></label>
      <label>所属盒子
        <select id="seriesBox" class="input">${taskBoxes.map((box) => `<option value="${box.id}" ${box.id === template.boxId ? 'selected' : ''}>${escapeHtml(box.name)}</option>`).join('')}</select>
      </label>
      <label>当前/下次计划时间<input id="seriesScheduledAt" class="input" type="datetime-local" value="${escapeHtml(toDateTimeLocalValue(scheduledAt))}"></label>
      <label>当前/下次截止时间<input id="seriesDueAt" class="input" type="datetime-local" value="${escapeHtml(toDateTimeLocalValue(dueDate))}"></label>
      ${renderDeviceContextField(template.deviceContext, 'series-device')}
      ${renderExecutionModeField(template.executionMode, 'series-execution')}
      ${renderMainlineTaskFields(template)}
      ${renderRecurrenceEditor('series-edit', template.recurrence)}
      <label>每期完成积分<input id="seriesPoints" class="input" type="number" min="0" step="1" value="${Math.max(0, Number(template.pointsValue) || 0)}"></label>
      <div class="sheet-actions">
        <button class="btn" id="cancelSeriesEdit">取消</button>
        <button class="btn primary" id="saveSeriesEdit">保存本次及以后</button>
      </div>
    </div>
  `, { height: '84vh' });
  const scheduledInput = root.querySelector('#seriesScheduledAt');
  const recurrenceEditor = bindRecurrenceEditor(root, {
    prefix: 'series-edit',
    scheduledInput,
    initialRule: template.recurrence,
  });
  const mainlineFields = bindMainlineTaskFields(root);
  const deviceField = bindDeviceContextField(root, 'series-device', 'desktop');
  const executionField = bindExecutionModeField(root, 'series-execution', 'self');
  const noRepeatButton = root.querySelector('[data-recurrence-type="none"]');
  noRepeatButton.disabled = true;
  noRepeatButton.title = '如需停止，请返回周期任务列表选择“停止周期”';
  root.querySelector('#cancelSeriesEdit').addEventListener('click', close);
  const save = () => {
    const content = root.querySelector('#seriesContent').value.trim();
    if (!content) {
      showToast('先填写任务内容');
      return;
    }
    updateRecurringTemplate(template.id, {
      content,
      boxId: root.querySelector('#seriesBox').value,
      scheduledAt: fromDateTimeLocalValue(scheduledInput.value),
      dueDate: fromDateTimeLocalValue(root.querySelector('#seriesDueAt').value),
      pointsValue: Math.max(0, Number(root.querySelector('#seriesPoints').value) || 0),
      deviceContext: deviceField.getValue(),
      executionMode: executionField.getValue(),
      ...mainlineFields.getValue(),
      recurrence: recurrenceEditor.getValue(),
    });
    close();
    showToast('周期任务已更新');
    renderHome(app);
  };
  root.querySelector('#saveSeriesEdit').addEventListener('click', save);
  root.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      save();
    }
  });
}

function openAddTaskSheet(boxes, options = {}) {
  const taskBoxes = boxes.filter(isTaskBox);
  const defaultBox = taskBoxes[0] || null;
  if (!defaultBox) {
    showToast('先创建一个待办类型的盒子');
    return;
  }
  const defaultPoints = defaultBox ? getTaskPointValue({ boxId: defaultBox.id }, defaultBox) : 5;
  const { root, close } = openSheet(`
    <div class="sheet-handle"></div>
    <div class="sheet-content">
      <p class="eyebrow">Quick Add</p>
      <h3>手动添加任务</h3>
      <p class="sheet-lead">先确定要做什么，再把它放进具体的一天。</p>
      <label>任务内容<input id="newTaskContent" class="input" placeholder="输入任务内容"></label>
      <label>所属盒子
        <select id="newTaskBox" class="input">${taskBoxes.map((box) => `<option value="${box.id}">${escapeHtml(box.name)}</option>`).join('')}</select>
      </label>
      <label>计划时间
        <div class="schedule-presets" aria-label="快捷安排时间">${renderSchedulePresets()}</div>
        <input id="newTaskScheduledAt" class="input" type="datetime-local" value="${escapeHtml(toDateTimeLocalValue(options.scheduledAt))}">
      </label>
      <label>截止时间
        <div class="schedule-presets deadline-presets" aria-label="快捷设置截止时间">${renderDeadlinePresets()}</div>
        <input id="newTaskDueAt" class="input" type="datetime-local">
      </label>
      ${renderDeviceContextField(options.deviceContext || 'desktop', 'new-task-device')}
      ${renderExecutionModeField(options.executionMode || 'self', 'new-task-execution')}
      ${renderMainlineTaskFields(options)}
      ${renderRecurrenceEditor('new-task')}
      <label>完成可得积分<input id="newTaskPoints" class="input" type="number" min="0" step="1" value="${defaultPoints}"></label>
      <div class="sheet-actions">
        <button class="btn" id="cancelTaskBtn">取消</button>
        <button class="btn primary" id="saveTaskBtn">保存任务</button>
      </div>
    </div>
  `, { height: '80vh' });

  const boxSelect = root.querySelector('#newTaskBox');
  const pointsInput = root.querySelector('#newTaskPoints');
  const scheduledInput = root.querySelector('#newTaskScheduledAt');
  const dueInput = root.querySelector('#newTaskDueAt');
  bindSchedulePresets(root, scheduledInput);
  bindDeadlinePresets(root, dueInput);
  const recurrenceEditor = bindRecurrenceEditor(root, { prefix: 'new-task', scheduledInput });
  const mainlineFields = bindMainlineTaskFields(root);
  const deviceField = bindDeviceContextField(root, 'new-task-device', 'desktop');
  const executionField = bindExecutionModeField(root, 'new-task-execution', 'self');
  if (options.focusRecurrence) root.querySelector('[data-recurrence-type="daily"]')?.focus();
  pointsInput.addEventListener('input', () => {
    pointsInput.dataset.touched = '1';
  });
  boxSelect.addEventListener('change', () => {
    if (pointsInput.dataset.touched === '1') return;
    const selectedBox = taskBoxes.find((box) => box.id === boxSelect.value);
    pointsInput.value = String(getTaskPointValue({ boxId: boxSelect.value }, selectedBox));
  });

  root.querySelector('#cancelTaskBtn').addEventListener('click', close);
  const saveTask = () => {
    const content = root.querySelector('#newTaskContent').value.trim();
    const boxId = root.querySelector('#newTaskBox').value;
    const pointsValue = Math.max(0, Number(root.querySelector('#newTaskPoints').value) || 0);
    if (!content) {
      showToast('先输入任务内容');
      return;
    }
    const payload = {
      content,
      boxId,
      pointsValue,
      scheduledAt: fromDateTimeLocalValue(scheduledInput.value),
      dueDate: fromDateTimeLocalValue(dueInput.value),
      deviceContext: deviceField.getValue(),
      executionMode: executionField.getValue(),
      ...mainlineFields.getValue(),
    };
    const recurrence = recurrenceEditor.getValue();
    if (recurrence) addRecurringTask(payload, recurrence);
    else addTask(payload);
    close();
    showToast(recurrence ? '周期任务已创建' : '任务已创建');
    renderHome(document.getElementById('app'));
  };
  root.querySelector('#saveTaskBtn').addEventListener('click', saveTask);
  root.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      saveTask();
    }
  });
}

function openAddBoxSheet() {
  const { root, close } = openSheet(`
    <div class="sheet-handle"></div>
    <div class="sheet-content">
      <p class="eyebrow">New Box</p>
      <h3>添加新盒子</h3>
      <p class="sheet-lead">先决定内容如何使用，再给它一个固定容器。</p>
      <label>盒子名称<input id="newBoxName" class="input" placeholder="例如：运动盒"></label>
      <label>盒子类型</label>
      <div class="box-type-options">${renderBoxTypeOptions('task')}</div>
      <label>每日一句 / 盒子介绍<textarea id="newBoxDesc" class="input" rows="4" placeholder="写两三句话，作为这个盒子的每日一句"></textarea></label>
      <div class="sheet-actions">
        <button class="btn" id="cancelBoxBtn">取消</button>
        <button class="btn primary" id="saveBoxBtn">创建盒子</button>
      </div>
    </div>
  `, { height: '78vh' });

  const typePicker = bindBoxTypeOptions(root, 'task');
  root.querySelector('#cancelBoxBtn').addEventListener('click', close);
  const saveBox = async () => {
    const name = root.querySelector('#newBoxName').value.trim();
    const description = root.querySelector('#newBoxDesc').value.trim();
    if (!name) {
      showToast('先填写盒子名称');
      return;
    }
    try {
      const boxType = typePicker.getValue();
      await addBox({ name, description, boxType });
      showToast(`${getBoxTypeDefinition(boxType).label}已创建并同步`);
      close();
      renderHome(document.getElementById('app'));
    } catch (err) {
      showToast(err?.message === 'box exists' ? '盒子名称已存在' : '创建失败，请重试');
    }
  };
  root.querySelector('#saveBoxBtn').addEventListener('click', saveBox);
  root.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      saveBox();
    }
  });
}
