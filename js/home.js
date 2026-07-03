import { getBoxes, getTasks, addTask, addBox, pullDataFromCloud } from './db.js';
import { navigate, openSheet, showToast } from './app.js';
import { getPointsSummary, getTaskPointValue } from './points-store.js';

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
  const description = String(box.description || '').trim();
  if (description) return description;
  return BOX_FALLBACK_COPY[box.color] || '把相关任务装进一个盒子，减少注意力切换。';
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
      return `
        <ul class="important-preview empty">
          <li>当前没有待办，继续保持。</li>
        </ul>
      `;
    }

    return `
      <ul class="important-preview">
        ${preview.map((task) => `<li>${escapeHtml(task.content)}</li>`).join('')}
      </ul>
    `;
  }

  return `
    <div class="box-main">
      <b>${pendingTasks.length}</b>
      <span>${getBoxContentLabel(box, pendingTasks.length)}</span>
    </div>
  `;
}

export function renderHome(app) {
  const boxes = getBoxes();
  const tasks = getTasks();
  const pointsSummary = getPointsSummary();
  const boxMap = new Map(boxes.map((box) => [box.id, box]));
  const now = new Date();
  const doneTasks = tasks.filter((task) => task.isCompleted);
  const openTasks = tasks.filter((task) => !task.isCompleted);
  const actionableTasks = openTasks.filter((task) => isActionableBox(boxMap.get(task.boxId)));
  const overdueTasks = actionableTasks.filter((task) => task.dueDate && new Date(task.dueDate) < now);
  const focusBox = boxes.find((box) => isActionableBox(box)) || boxes[0];

  app.innerHTML = `
    <main id="home" class="page">
      <section class="home-hero panel safe-top">
        <div class="home-topline">
          <div class="hero-copy">
            <p class="eyebrow">${escapeHtml(formatToday(now))}</p>
            <h1 class="hero-title">${escapeHtml(getGreeting(now))}</h1>
            <p class="hero-subtitle">把任务拆进盒子，按场景推进，每次只盯住下一件事。</p>
          </div>
          <div class="row gap8 hero-tools">
            <button class="icon-btn icon-btn-ghost" id="homePullBtn" aria-label="拉取盒子数据">↻</button>
            <button class="icon-btn icon-btn-ghost" id="aiTopBtn" aria-label="AI提取">✦</button>
            <button class="icon-btn icon-btn-ghost" id="settingsBtn" aria-label="设置">⚙</button>
          </div>
        </div>

        <div class="hero-stats">
          <article class="stat-card">
            <span>待处理</span>
            <strong>${actionableTasks.length}</strong>
          </article>
          <article class="stat-card">
            <span>已完成</span>
            <strong>${doneTasks.length}</strong>
          </article>
          <article class="stat-card">
            <span>逾期项</span>
            <strong>${overdueTasks.length}</strong>
          </article>
        </div>

        <div class="hero-actions">
          <button class="btn subtle sw-entry-btn" id="smallWorldEntry">进入小世界</button>
          <button class="btn subtle points-entry-btn" id="pointsEntry">积分 ${pointsSummary.balance}</button>
          <button class="btn subtle" id="heroFocusBtn">${focusBox ? `打开 ${escapeHtml(focusBox.name)}` : '查看任务盒'}</button>
        </div>
      </section>

      <section class="section-heading">
        <div>
          <p class="eyebrow">Task Boxes</p>
          <h2>按场景管理任务</h2>
        </div>
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
                  <div class="box-title-block">
                    <strong>${escapeHtml(box.name)}</strong>
                    <small>${escapeHtml(getProgressLabel(boxTasks, pendingTasks, finished))}</small>
                  </div>
                </div>
                <span class="box-progress-label">${percent}%</span>
              </div>

              <p class="box-desc">${escapeHtml(getBoxDescription(box))}</p>
              ${renderBoxPreview(box, pendingTasks)}

              <div class="box-meta">
                <span>${getBoxMetaLabel(box, pendingTasks.length)}</span>
                <span>进入盒子 →</span>
              </div>
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

  app.querySelector('#smallWorldEntry').addEventListener('click', () => {
    const fx = document.createElement('div');
    fx.className = 'sw-lightflow';
    fx.innerHTML = Array.from({ length: 28 }).map(() => '<span></span>').join('');
    app.appendChild(fx);
    requestAnimationFrame(() => fx.classList.add('show'));
    setTimeout(() => {
      navigate('#smallworld');
      fx.remove();
    }, 420);
  });
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

  app.querySelector('#heroFocusBtn').addEventListener('click', () => {
    if (focusBox) navigate(`#box/${focusBox.id}`);
  });
  app.querySelector('#settingsBtn').addEventListener('click', () => navigate('#settings'));
  app.querySelector('#aiTopBtn').addEventListener('click', openAIExtractSheetLazy);

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

function openAddTaskSheet(boxes) {
  const defaultBox = boxes[0] || null;
  const defaultPoints = defaultBox ? getTaskPointValue({ boxId: defaultBox.id }, defaultBox) : 5;
  const { root, close } = openSheet(`
    <div class="sheet-handle"></div>
    <div class="sheet-content">
      <p class="eyebrow">Quick Add</p>
      <h3>手动添加任务</h3>
      <p class="sheet-lead">先记录下来，再决定它属于哪个盒子。</p>
      <label>任务内容<input id="newTaskContent" class="input" placeholder="输入任务内容"></label>
      <label>所属盒子
        <select id="newTaskBox" class="input">
          ${boxes.map((box) => `<option value="${box.id}">${escapeHtml(box.name)}</option>`).join('')}
        </select>
      </label>
      <label>完成可得积分<input id="newTaskPoints" class="input" type="number" min="0" step="1" value="${defaultPoints}"></label>
      <div class="sheet-actions">
        <button class="btn" id="cancelTaskBtn">取消</button>
        <button class="btn primary" id="saveTaskBtn">保存任务</button>
      </div>
    </div>
  `, { height: '48vh' });

  const boxSelect = root.querySelector('#newTaskBox');
  const pointsInput = root.querySelector('#newTaskPoints');
  pointsInput.addEventListener('input', () => {
    pointsInput.dataset.touched = '1';
  });
  boxSelect.addEventListener('change', () => {
    if (pointsInput.dataset.touched === '1') return;
    const selectedBox = boxes.find((box) => box.id === boxSelect.value);
    pointsInput.value = String(getTaskPointValue({ boxId: boxSelect.value }, selectedBox));
  });

  root.querySelector('#cancelTaskBtn').addEventListener('click', close);
  root.querySelector('#saveTaskBtn').addEventListener('click', () => {
    const content = root.querySelector('#newTaskContent').value.trim();
    const boxId = root.querySelector('#newTaskBox').value;
    const pointsValue = Math.max(0, Number(root.querySelector('#newTaskPoints').value) || 0);
    if (!content) {
      showToast('先输入任务内容');
      return;
    }
    addTask({ content, boxId, pointsValue });
    close();
    renderHome(document.getElementById('app'));
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
      <label>盒子介绍<textarea id="newBoxDesc" class="input" rows="4" placeholder="写一句这个盒子主要做什么"></textarea></label>
      <div class="sheet-actions">
        <button class="btn" id="cancelBoxBtn">取消</button>
        <button class="btn primary" id="saveBoxBtn">创建盒子</button>
      </div>
    </div>
  `, { height: '58vh' });

  root.querySelector('#cancelBoxBtn').addEventListener('click', close);
  root.querySelector('#saveBoxBtn').addEventListener('click', async () => {
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
  });
}
