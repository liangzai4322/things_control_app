import { addBox, addTask, getBoxes, getTasks, playSound, pullDataFromCloud, updateTask } from './db.js';
import { navigate, openSheet, showToast } from './app.js';
import { getPointsSummary, getTaskPointValue, syncTaskCompletionPoints } from './points-store.js';
import {
  formatDueLabel,
  formatScheduledLabel,
  fromDateTimeLocalValue,
  getBoxDailySentence,
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
const NON_TODO_BOX_COLORS = new Set(['relax', 'reward', 'punish', 'study']);
const WEEKDAY_LABELS = ['一', '二', '三', '四', '五', '六', '日'];
const SCHEDULE_PRESETS = [
  { value: 'today', label: '今天' },
  { value: 'tonight', label: '今晚' },
  { value: 'tomorrow', label: '明天' },
  { value: 'weekend', label: '周末' },
  { value: 'clear', label: '不安排' },
];

let selectedHomeDateKey = localDateKey(new Date());
let showAllAgendaTasks = false;

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

function getProgressLabel(boxTasks, pendingTasks, finished) {
  if (!boxTasks.length) return '空盒子';
  if (!pendingTasks.length) return '已清空';
  return `完成 ${finished}/${boxTasks.length}`;
}

function isActionableBox(box) {
  return !NON_TODO_BOX_COLORS.has(box?.color);
}

function getBoxContentLabel(box, pendingCount) {
  if (isActionableBox(box)) return pendingCount ? '待处理任务' : '暂无待办';
  if (box.color === 'study') return pendingCount ? '储备条目' : '暂无内容';
  return pendingCount ? '可抽取项' : '暂无内容';
}

function getBoxMetaLabel(box, pendingCount) {
  if (isActionableBox(box)) return `${pendingCount} 项待办`;
  if (box.color === 'study') return `${pendingCount} 条储备`;
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
    .filter((task) => matchesSelectedDate(task) || (isToday && isTaskOverdue(task, now)))
    .sort((left, right) => {
      const overdueDiff = Number(isTaskOverdue(right, now)) - Number(isTaskOverdue(left, now));
      const leftTime = new Date(left.scheduledAt || left.dueDate || '9999-12-31').getTime();
      const rightTime = new Date(right.scheduledAt || right.dueDate || '9999-12-31').getTime();
      return overdueDiff
        || (Number(left.pinLevel) || 99) - (Number(right.pinLevel) || 99)
        || leftTime - rightTime
        || (Number(right.priority) || 0) - (Number(left.priority) || 0);
    });
  const completed = tasks.filter((task) => task.isCompleted && actionable(task) && localDateKey(task.completedAt) === dateKey);
  return { open, completed, selectedDate };
}

function getDayTaskCount(tasks, boxMap, date) {
  const key = localDateKey(date);
  return tasks.filter((task) => (
    !task.isCompleted
    && !task.deleted
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
    <article class="day-task-row ${overdue ? 'is-overdue' : ''} ${needsReschedule ? 'needs-reschedule' : ''}" data-agenda-task="${task.id}">
      <button class="day-task-check" data-agenda-complete="${task.id}" aria-label="完成 ${escapeHtml(task.content)}"></button>
      <button class="day-task-open" data-agenda-open="${task.id}">
        <span class="day-task-title">${escapeHtml(task.content)}</span>
        <span class="day-task-meta">
          <i class="day-box-mark ${escapeHtml(box?.color || 'important')}"></i>
          ${escapeHtml(box?.name || '未分类')}${timing ? ` · ${escapeHtml(timing)}` : ''}
        </span>
      </button>
    </article>
  `;
}

function renderSchedulePresets() {
  return SCHEDULE_PRESETS.map((preset) => `<button class="schedule-preset" data-schedule-preset="${preset.value}">${preset.label}</button>`).join('');
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
  const tasks = getTasks();
  const pointsSummary = getPointsSummary();
  const boxMap = new Map(boxes.map((box) => [box.id, box]));
  const taskMap = new Map(tasks.map((task) => [task.id, task]));
  const now = new Date();
  if (!localDateFromKey(selectedHomeDateKey)) selectedHomeDateKey = localDateKey(now);
  const selectedDate = localDateFromKey(selectedHomeDateKey) || now;
  const week = getLocalWeek(selectedDate);
  const agenda = getAgenda(tasks, boxMap, selectedHomeDateKey, now);
  const visibleAgenda = showAllAgendaTasks ? agenda.open : agenda.open.slice(0, 4);
  const doneTasks = tasks.filter((task) => task.isCompleted);
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
            const count = getDayTaskCount(tasks, boxMap, date);
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
            <button class="agenda-add-btn" id="agendaAddBtn">＋ 安排</button>
          </div>
          <div class="day-task-list">
            ${visibleAgenda.length
              ? visibleAgenda.map((task) => renderAgendaTask(task, boxMap.get(task.boxId), now)).join('')
              : '<div class="day-agenda-empty"><strong>这一天还没有安排</strong><span>给重要行动一个明确的位置，执行会更轻松。</span></div>'}
          </div>
          ${agenda.open.length > 4 ? `<button class="agenda-expand-btn" id="agendaExpandBtn">${showAllAgendaTasks ? '收起' : `展开其余 ${agenda.open.length - 4} 项`}</button>` : ''}
        </div>
      </section>

      <section class="section-heading">
        <div><p class="eyebrow">Task Boxes</p><h2>按场景管理任务</h2></div>
        <p class="section-note">${boxes.length} 个盒子，${tasks.length} 条任务</p>
      </section>

      <section class="box-grid scroll-area home-grid">
        ${boxes.map((box) => {
          const boxTasks = tasks.filter((task) => task.boxId === box.id);
          const pendingTasks = boxTasks.filter((task) => !task.isCompleted);
          const finished = boxTasks.filter((task) => task.isCompleted).length;
          const percent = boxTasks.length ? Math.round((finished / boxTasks.length) * 100) : 0;

          return `
            <button class="box-card ${cardSizeClass(box)} ${box.color}" data-box-id="${box.id}">
              <div class="box-head">
                <div class="box-title-group">
                  <span class="box-icon">${escapeHtml(box.icon)}</span>
                  <div class="box-title-block"><strong>${escapeHtml(box.name)}</strong><small>${escapeHtml(getProgressLabel(boxTasks, pendingTasks, finished))}</small></div>
                </div>
                <span class="box-progress-label">${percent}%</span>
              </div>
              <div class="box-desc box-daily-sentence"><span>每日一句</span><p>${escapeHtml(getBoxDescription(box))}</p></div>
              ${renderBoxPreview(box, pendingTasks)}
              <div class="box-meta"><span>${getBoxMetaLabel(box, pendingTasks.length)}</span><span>进入盒子 →</span></div>
              <div class="progress"><span style="width:${percent}%"></span></div>
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
    element.addEventListener('click', () => navigate(`#box/${element.dataset.boxId}`));
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

function openAddTaskSheet(boxes, options = {}) {
  const defaultBox = boxes[0] || null;
  const defaultPoints = defaultBox ? getTaskPointValue({ boxId: defaultBox.id }, defaultBox) : 5;
  const { root, close } = openSheet(`
    <div class="sheet-handle"></div>
    <div class="sheet-content">
      <p class="eyebrow">Quick Add</p>
      <h3>手动添加任务</h3>
      <p class="sheet-lead">先确定要做什么，再把它放进具体的一天。</p>
      <label>任务内容<input id="newTaskContent" class="input" placeholder="输入任务内容"></label>
      <label>所属盒子
        <select id="newTaskBox" class="input">${boxes.map((box) => `<option value="${box.id}">${escapeHtml(box.name)}</option>`).join('')}</select>
      </label>
      <label>计划时间
        <div class="schedule-presets" aria-label="快捷安排时间">${renderSchedulePresets()}</div>
        <input id="newTaskScheduledAt" class="input" type="datetime-local" value="${escapeHtml(toDateTimeLocalValue(options.scheduledAt))}">
      </label>
      <label>完成可得积分<input id="newTaskPoints" class="input" type="number" min="0" step="1" value="${defaultPoints}"></label>
      <div class="sheet-actions">
        <button class="btn" id="cancelTaskBtn">取消</button>
        <button class="btn primary" id="saveTaskBtn">保存任务</button>
      </div>
    </div>
  `, { height: '66vh' });

  const boxSelect = root.querySelector('#newTaskBox');
  const pointsInput = root.querySelector('#newTaskPoints');
  const scheduledInput = root.querySelector('#newTaskScheduledAt');
  bindSchedulePresets(root, scheduledInput);
  pointsInput.addEventListener('input', () => {
    pointsInput.dataset.touched = '1';
  });
  boxSelect.addEventListener('change', () => {
    if (pointsInput.dataset.touched === '1') return;
    const selectedBox = boxes.find((box) => box.id === boxSelect.value);
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
    addTask({
      content,
      boxId,
      pointsValue,
      scheduledAt: fromDateTimeLocalValue(scheduledInput.value),
    });
    close();
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
      <p class="sheet-lead">给一组相似任务一个固定容器，首页会更清晰。</p>
      <label>盒子名称<input id="newBoxName" class="input" placeholder="例如：运动盒"></label>
      <label>每日一句 / 盒子介绍<textarea id="newBoxDesc" class="input" rows="4" placeholder="写两三句话，作为这个盒子的每日一句"></textarea></label>
      <div class="sheet-actions">
        <button class="btn" id="cancelBoxBtn">取消</button>
        <button class="btn primary" id="saveBoxBtn">创建盒子</button>
      </div>
    </div>
  `, { height: '58vh' });

  root.querySelector('#cancelBoxBtn').addEventListener('click', close);
  const saveBox = async () => {
    const name = root.querySelector('#newBoxName').value.trim();
    const description = root.querySelector('#newBoxDesc').value.trim();
    if (!name) {
      showToast('先填写盒子名称');
      return;
    }
    try {
      await addBox({ name, description });
      showToast('盒子已创建并尝试上传云端');
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
