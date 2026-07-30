import {
  getBoxes,
  getMainlines,
  getTasks,
  pullDataFromCloud,
  requestTaskboxApi,
  updateTask,
} from './db.js';
import { navigate, openSheet, showToast } from './app.js';
import { buildLocalHqSnapshot, normalizeHqBrief, normalizeReviewStatus } from './hq-model.js';
import { bindHqDimensionNav, renderHqDimensionNav, renderHqPeriodPage } from './hq-period-page.js';
import { localDateKey } from './task-utils.js';

const HQ_CACHE_KEY = 'taskbox_hq_cache_v1';
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
const SYSTEMS = [
  { id: 'daily', code: '003', name: '日省', note: '复盘、证据与明日承诺', state: 'connected', action: 'brief' },
  { id: 'mainline', code: '002', name: '主线系统', note: '项目、里程碑与下一步', state: 'connected', action: 'projects' },
  { id: 'taskbox', code: 'BOX', name: '行动盒子', note: '任务执行与场景分发', state: 'connected', action: 'home' },
  { id: 'trade', code: '001', name: '交易系统', note: '工具入口与风险信号', state: 'reserved' },
  { id: 'mirror', code: '010', name: '镜像系统', note: '状态校准与同日补充', state: 'reserved' },
  { id: 'gap', code: '009', name: 'GAP 教练', note: '重复问题与待决策项', state: 'reserved' },
];

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function readCache() {
  try {
    return JSON.parse(localStorage.getItem(HQ_CACHE_KEY) || '{}');
  } catch {
    return {};
  }
}

function writeCache(patch) {
  const next = { ...readCache(), ...patch, updatedAt: new Date().toISOString() };
  localStorage.setItem(HQ_CACHE_KEY, JSON.stringify(next));
  return next;
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

function renderPrimaryAction(task) {
  if (!task) {
    return `
      <button class="hq-primary-empty" id="editBriefEmpty">
        <span>01</span>
        <strong>今天还没有唯一主动作</strong>
        <small>先确定一件能产生外部结果的行动。</small>
      </button>
    `;
  }
  return `
    <article class="hq-primary-action">
      <div class="hq-action-index"><span>NOW</span><strong>01</strong></div>
      <div class="hq-action-copy">
        <p>今日唯一主动作</p>
        <h2>${escapeHtml(task.content)}</h2>
        <small>${escapeHtml(taskMeta(task) || '完成后留下明确证据')}</small>
      </div>
      <div class="hq-action-progress">
        <span>${Math.max(0, Math.min(100, Number(task.progress) || 0))}%</span>
        <i><b style="width:${Math.max(0, Math.min(100, Number(task.progress) || 0))}%"></b></i>
        <button data-open-task="${escapeHtml(task.id)}" data-command-role="primary">进入行动</button>
      </div>
    </article>
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
    <button class="hq-system-card ${system.state}" data-system-action="${escapeHtml(system.action || '')}">
      <span>${escapeHtml(system.code)}</span>
      <div>
        <strong>${escapeHtml(system.name)}</strong>
        <small>${escapeHtml(system.note)}</small>
      </div>
      <i>${system.state === 'connected' ? '已接入' : '下一阶段'}</i>
    </button>
  `;
}

function renderSnapshot(app, snapshot, { remote = false } = {}) {
  const brief = normalizeHqBrief(snapshot.brief, snapshot.reviewDate);
  const primary = snapshot.commitments?.primary || null;
  const maintenance = snapshot.commitments?.maintenance || [];
  const projects = snapshot.projects || [];
  const decisions = snapshot.decisions || [];
  const closure = brief.yesterdayClosure || {};
  const riskCount = projects.filter((project) => ['blocked', 'stale', 'needs_action'].includes(project.health)).length;

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
            <span class="${remote ? 'online' : ''}">${remote ? '云端已连接' : '本地快照'}</span>
            <button id="hqRefresh" aria-label="刷新">↻</button>
            <button id="hqEditBrief">编辑今日</button>
          </div>
        </div>
        <div class="hq-situation-line" aria-label="今日态势">
          <article><span>ACTIVE PROJECTS</span><strong>${projects.length}</strong><small>活跃项目</small></article>
          <article><span>DECISIONS</span><strong>${decisions.length}</strong><small>待决策</small></article>
          <article><span>RISK SIGNALS</span><strong>${riskCount}</strong><small>项目预警</small></article>
          <article><span>AI QUEUE</span><strong>${snapshot.ai?.open || 0}</strong><small>AI执行中</small></article>
        </div>
      </section>

      ${renderHqDimensionNav('day')}
      ${renderReviewLoop(snapshot.review, snapshot.reviewDate)}

      <section class="hq-grid hq-action-zone">
        <div class="hq-zone-label"><span>01</span><p>今日行动驾驶舱</p><small>只承诺 1 个主动作 + 2 个维护动作</small></div>
        <div class="hq-action-stack">
          ${renderPrimaryAction(primary)}
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

      <section class="hq-section" id="hqProjects">
        <div class="hq-section-head">
          <div><span>02 / PROJECT CENTER</span><h2>项目中心</h2></div>
          <p>${riskCount ? `${riskCount} 个项目需要注意` : '所有活跃项目均有下一步'}</p>
        </div>
        <div class="hq-project-grid">
          ${projects.length ? projects.map(renderProject).join('') : '<div class="hq-empty-panel"><strong>还没有活跃项目</strong><span>在盒子中建立主线后，这里会自动形成项目健康视图。</span></div>'}
        </div>
      </section>

      <section class="hq-split-zone">
        <div class="hq-section hq-decision-zone">
          <div class="hq-section-head">
            <div><span>03 / DECISION QUEUE</span><h2>待决策队列</h2></div>
            <button id="hqAddDecision">＋ 记录决策</button>
          </div>
          <div class="hq-decision-list">
            ${decisions.length ? decisions.map(renderDecision).join('') : '<div class="hq-empty-panel compact"><strong>当前没有悬而未决</strong><span>连续拖延、项目阻塞和方向冲突会进入这里。</span></div>'}
          </div>
        </div>

        <div class="hq-section hq-systems-zone">
          <div class="hq-section-head">
            <div><span>04 / SYSTEM PORTS</span><h2>系统接入口</h2></div>
          </div>
          <div class="hq-system-grid">${SYSTEMS.map(renderSystem).join('')}</div>
        </div>
      </section>
    </main>
  `;

  bindPageEvents(app, snapshot);
}

function renderTaskOptions(tasks, selectedId, excludedIds = []) {
  return [
    '<option value="">暂不设置</option>',
    ...tasks
      .filter((task) => !excludedIds.includes(task.id))
      .map((task) => `<option value="${escapeHtml(task.id)}" ${task.id === selectedId ? 'selected' : ''}>${escapeHtml(task.content)}</option>`),
  ].join('');
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
  const tasks = getTasks().filter((task) => !task.isCompleted);
  const brief = normalizeHqBrief(snapshot.brief, snapshot.reviewDate);
  const { root, close } = openSheet(`
    <div class="sheet-header">
      <div><p class="eyebrow">TODAY COMMAND</p><h2>编辑今日驾驶舱</h2></div>
      <button class="icon-btn" id="closeHqBrief">×</button>
    </div>
    <div class="hq-brief-form">
      <label>唯一主动作
        <select class="input" id="hqPrimaryTask">${renderTaskOptions(tasks, brief.primaryTaskId)}</select>
      </label>
      <div class="hq-form-pair">
        <label>维护动作 1
          <select class="input" id="hqMaintenanceOne">${renderTaskOptions(tasks, brief.maintenanceTaskIds[0], [brief.primaryTaskId])}</select>
        </label>
        <label>维护动作 2
          <select class="input" id="hqMaintenanceTwo">${renderTaskOptions(tasks, brief.maintenanceTaskIds[1], [brief.primaryTaskId])}</select>
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
  root.querySelector('#saveHqBrief').addEventListener('click', async () => {
    const primaryTaskId = root.querySelector('#hqPrimaryTask').value || null;
    const maintenanceTaskIds = [
      root.querySelector('#hqMaintenanceOne').value,
      root.querySelector('#hqMaintenanceTwo').value,
    ].filter((id, index, all) => id && id !== primaryTaskId && all.indexOf(id) === index);
    const outcomes = Object.fromEntries(OUTCOME_FIELDS.map(([key]) => {
      const value = root.querySelector(`#hqOutcome_${key}`).value;
      return [key, value === '' ? null : Math.max(0, Number(value) || 0)];
    }));
    const nextBrief = {
      ...brief,
      reviewDate: snapshot.reviewDate,
      primaryTaskId,
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
    if (primaryTaskId) updateTask(primaryTaskId, {
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
      await requestTaskboxApi(`/hq/daily-briefs/${snapshot.reviewDate}`, {
        method: 'POST',
        body: JSON.stringify(nextBrief),
      });
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

function bindPageEvents(app, snapshot) {
  bindHqDimensionNav(app);
  app.querySelector('#hqBack').addEventListener('click', () => navigate('#home'));
  app.querySelector('#hqRefresh').addEventListener('click', async () => {
    showToast('正在刷新参谋部');
    await pullDataFromCloud({ force: true }).catch(() => null);
    renderHqPage(app, { refreshRemote: true });
  });
  app.querySelector('#hqEditBrief').addEventListener('click', () => openBriefEditor(app, snapshot));
  app.querySelector('#hqReviewEvidence')?.addEventListener('click', () => openReviewEvidence(snapshot));
  app.querySelector('#editBriefEmpty')?.addEventListener('click', () => openBriefEditor(app, snapshot));
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
  app.querySelectorAll('[data-system-action]').forEach((button) => {
    button.addEventListener('click', () => {
      const action = button.dataset.systemAction;
      if (action === 'home') navigate('#home');
      else if (action === 'projects') app.querySelector('#hqProjects')?.scrollIntoView({ behavior: 'smooth' });
      else if (action === 'brief') openBriefEditor(app, snapshot);
      else showToast('入口已预留，将在下一阶段接入');
    });
  });
}

export async function renderHqPage(app, { refreshRemote = true, dimension = 'day' } = {}) {
  if (dimension !== 'day') {
    await renderHqPeriodPage(app, { dimension, refreshRemote });
    return;
  }
  const reviewDate = localDateKey(new Date());
  const cache = readCache();
  const localSnapshot = buildLocalHqSnapshot({
    reviewDate,
    brief: cache.brief,
    decisions: cache.decisions || [],
    tasks: getTasks(),
    mainlines: getMainlines(),
  });
  renderSnapshot(app, localSnapshot, { remote: false });

  if (!refreshRemote) return;
  try {
    const remote = await requestTaskboxApi(`/hq/today?date=${encodeURIComponent(reviewDate)}`);
    if (!remote) return;
    writeCache({ brief: remote.brief, decisions: remote.decisions || [] });
    renderSnapshot(app, remote, { remote: true });
  } catch {
    // Local snapshot remains fully usable.
  }
}
