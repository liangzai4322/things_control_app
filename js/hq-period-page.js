import { navigate } from './app.js';
import { requestTaskboxApi } from './db.js';
import { normalizePeriodSnapshot } from './hq-model.js';
import { localDateKey } from './task-utils.js';

const PERIOD_CACHE_KEY = 'taskbox_hq_period_cache_v1';

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function readCache() {
  try { return JSON.parse(localStorage.getItem(PERIOD_CACHE_KEY) || '{}'); } catch { return {}; }
}

export function readHqPeriodCache() {
  return readCache();
}

export async function refreshHqPeriodCache(dateKey = localDateKey(new Date())) {
  const results = await Promise.allSettled(['week', 'month'].map(async (type) => {
    const snapshot = await requestTaskboxApi(`/hq/periods/${type}/current?date=${encodeURIComponent(dateKey)}&offset=-1`);
    if (snapshot) writeCache(type, snapshot);
    return [type, snapshot];
  }));
  return Object.fromEntries(results
    .filter((item) => item.status === 'fulfilled' && item.value[1])
    .map((item) => item.value));
}

function writeCache(type, value) {
  const next = { ...readCache(), [type]: value, updatedAt: new Date().toISOString() };
  localStorage.setItem(PERIOD_CACHE_KEY, JSON.stringify(next));
}

function emptySnapshot(type, dateKey) {
  const monthKey = dateKey.slice(0, 7);
  return normalizePeriodSnapshot({
    periodType: type,
    periodKey: type === 'month' ? monthKey : '',
    startDate: type === 'month' ? `${monthKey}-01` : '',
    endDate: type === 'month' ? dateKey : '',
  }, type);
}

export function renderHqDimensionNav(active = 'day') {
  const items = [
    ['day', '今日驾驶舱', '#hq'],
    ['week', '本周作战室', '#hq/week'],
    ['month', '本月参谋会', '#hq/month'],
  ];
  return `<nav class="hq-dimension-nav" aria-label="参谋部时间尺度">
    ${items.map(([id, label, href]) => `<button class="${active === id ? 'active' : ''}" data-hq-dimension="${id}" data-hq-href="${href}"><span>${id === 'day' ? 'D' : id === 'week' ? 'W' : 'M'}</span>${label}</button>`).join('')}
  </nav>`;
}

export function bindHqDimensionNav(app) {
  app.querySelectorAll('[data-hq-dimension]').forEach((button) => {
    button.addEventListener('click', () => navigate(button.dataset.hqHref));
  });
}

function rangeTitle(snapshot, type) {
  if (type === 'month') return snapshot.periodKey || '本月';
  if (!snapshot.startDate || !snapshot.endDate) return '本周';
  return `${snapshot.startDate.slice(5).replace('-', '/')} — ${snapshot.endDate.slice(5).replace('-', '/')}`;
}

function safeHttpUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch { return ''; }
}

function completionLabel(derived) {
  const rate = derived.commitments?.rate;
  return rate === null || rate === undefined ? '证据不足' : `${rate}%`;
}

function outcomeValue(derived, key) {
  const metric = derived.outcomes?.[key];
  return metric?.recordedDays ? metric.value : '—';
}

function renderPeriodHeader(snapshot, type, remote) {
  const isWeek = type === 'week';
  return `
    <section class="hq-period-command safe-top">
      <div class="hq-period-command-line"><span>${isWeek ? 'WEEKLY OPERATIONS' : 'MONTHLY STRATEGY'}</span><i>${escapeHtml(snapshot.periodKey || '等待周期数据')}</i></div>
      <div class="hq-period-title-row">
        <button class="hq-back" id="hqPeriodBack" aria-label="返回盒子">←</button>
        <div><p>${escapeHtml(rangeTitle(snapshot, type))}</p><h1>${isWeek ? '本周作战室' : '本月参谋会'}</h1><small>${isWeek ? '把月度方向压成一个可验证实验。' : '决定资源押注、退出条件和下月目标。'}</small></div>
        <span class="hq-period-cloud ${remote ? 'online' : ''}">${remote ? '云端周期数据' : '本地周期快照'}</span>
      </div>
      ${renderHqDimensionNav(type)}
    </section>
  `;
}

function renderMetrics(snapshot, type) {
  const derived = snapshot.derived;
  const items = type === 'week' ? [
    ['DAILY REVIEWS', derived.dailyReviewCount, '已完成日省'],
    ['COMMITMENT HIT', completionLabel(derived), '唯一承诺完成率'],
    ['EVIDENCE DAYS', derived.evidenceDays, '产生外部证据'],
    ['TASKS DONE', derived.tasks?.completed || 0, '盒子明确完成'],
  ] : [
    ['DAILY REVIEWS', derived.dailyReviewCount, '本月日省覆盖'],
    ['COMMITMENT HIT', completionLabel(derived), '日承诺完成率'],
    ['DEALS', outcomeValue(derived, 'deals'), '本月成交'],
    ['FEEDBACK', outcomeValue(derived, 'feedback'), '真实反馈样本'],
  ];
  return `<section class="hq-period-metrics">${items.map(([code, value, label]) => `<article><span>${code}</span><strong>${escapeHtml(value)}</strong><small>${label}</small></article>`).join('')}</section>`;
}

function renderVerdict(review, type) {
  const empty = type === 'week'
    ? '完成周省后，这里显示本周经营裁决。'
    : '完成月省后，这里显示本月资源与业务裁决。';
  const artifactLinks = [
    ['复盘卡片', safeHttpUrl(review.artifacts?.cardUrl)],
    ['飞书原文', safeHttpUrl(review.artifacts?.feishuUrl)],
  ].filter(([, url]) => url);
  return `<article class="hq-period-verdict">
    <span>${type === 'week' ? 'WEEKLY VERDICT' : 'MONTHLY VERDICT'}</span>
    <h2>${escapeHtml(review.verdict || empty)}</h2>
    <small>${review.completedAt ? `复盘已同步 · ${new Date(review.completedAt).toLocaleDateString('zh-CN')}` : '周期复盘尚未同步，派生指标已从日省与盒子生成。'}</small>
    ${artifactLinks.length ? `<div class="hq-period-artifacts">${artifactLinks.map(([label, url]) => `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${label} ↗</a>`).join('')}</div>` : ''}
  </article>`;
}

function renderExperiment(experiment = {}) {
  return `<article class="hq-period-focus">
    <div><span>NEXT EXPERIMENT</span><strong>下周唯一实验</strong></div>
    <h2>${escapeHtml(experiment.action || '等待周省确定唯一实验')}</h2>
    <p>${escapeHtml(experiment.hypothesis || '实验必须验证当前最大不确定性，而不是继续堆内部任务。')}</p>
    <dl>
      <div><dt>成功阈值</dt><dd>${escapeHtml(experiment.successThreshold || '待设置')}</dd></div>
      <div><dt>失败阈值</dt><dd>${escapeHtml(experiment.failureThreshold || '待设置')}</dd></div>
      <div><dt>截止</dt><dd>${escapeHtml(experiment.dueDate || '待设置')}</dd></div>
    </dl>
  </article>`;
}

function renderBottleneck(bottleneck = {}) {
  return `<article class="hq-period-note danger">
    <span>PRIMARY BOTTLENECK</span><h3>${escapeHtml(bottleneck.title || '尚未识别唯一主瓶颈')}</h3>
    <p>${escapeHtml(bottleneck.rootCause || '周省会从重复问题中选择一个可行动的系统原因。')}</p>
    <small>${escapeHtml(bottleneck.systemFix ? `系统修正：${bottleneck.systemFix}` : '等待周省同步')}</small>
  </article>`;
}

function renderScoreboard(items = []) {
  return `<article class="hq-period-list-card"><div><span>SCOREBOARD</span><h3>下周记分牌</h3></div><ol>${items.length
    ? items.map((item, index) => `<li><i>${String(index + 1).padStart(2, '0')}</i><span>${escapeHtml(item)}</span></li>`).join('')
    : '<li class="empty"><i>—</i><span>周省完成后显示最多四项验收指标</span></li>'}</ol></article>`;
}

function rowLabel(row, fallback) {
  const values = Object.values(row || {}).filter(Boolean);
  return values[0] || fallback;
}

function renderResources(rows = [], type) {
  return `<article class="hq-period-list-card resources"><div><span>RESOURCE MAP</span><h3>${type === 'week' ? '下周资源分配' : '下月资源分配'}</h3></div><section>${rows.length
    ? rows.map((row) => `<div><strong>${escapeHtml(rowLabel(row, '未命名业务线'))}</strong><p>${escapeHtml(Object.entries(row).slice(1).map(([key, value]) => `${key} ${value}`).join(' · '))}</p></div>`).join('')
    : '<div class="empty"><strong>尚未分配</strong><p>完成周期复盘后显示时间、预算、上限和退出条件。</p></div>'}</section></article>`;
}

function renderSsc(ssc = {}, type) {
  const labels = type === 'week' ? [['start', 'START'], ['stop', 'STOP'], ['continue', 'CONTINUE']] : [['start', 'START'], ['stop', 'STOP'], ['continue', 'KEEP']];
  return `<section class="hq-period-ssc">${labels.map(([key, label]) => `<article class="${key}"><span>${label}</span><strong>${escapeHtml(ssc[key]?.[0] || '待周期复盘确认')}</strong></article>`).join('')}</section>`;
}

function renderGoals(goals = []) {
  const defaults = [
    { type: 'cash', title: '现金结果目标待设置' },
    { type: 'growth', title: '增长验证目标待设置' },
    { type: 'system', title: '能力 / 系统目标待设置' },
  ];
  const byType = new Map(goals.map((goal) => [goal.type, goal]));
  return `<section class="hq-month-goals">${defaults.map((fallback, index) => {
    const goal = byType.get(fallback.type) || fallback;
    return `<article><span>0${index + 1}</span><small>${fallback.type === 'cash' ? '现金结果' : fallback.type === 'growth' ? '增长验证' : '能力系统'}</small><h3>${escapeHtml(goal.title)}</h3><p>${escapeHtml(goal.detail || '基线、目标值、里程碑和失败处理将在月省后出现。')}</p></article>`;
  }).join('')}</section>`;
}

function renderDecisions(items = []) {
  return `<article class="hq-period-list-card decisions"><div><span>STRATEGIC DECISIONS</span><h3>本月战略决策</h3></div><ol>${items.length
    ? items.map((item, index) => `<li><i>${String(index + 1).padStart(2, '0')}</i><div><strong>${escapeHtml(item.decision)}</strong><small>${escapeHtml(item.evidence || '等待证据')}</small><p>退出条件：${escapeHtml(item.exitCondition || '待设置')}</p></div></li>`).join('')
    : '<li class="empty"><i>—</i><div><strong>尚未形成月度战略决策</strong><small>月省最多同步三条。</small></div></li>'}</ol></article>`;
}

function renderPortfolio(rows = []) {
  return `<article class="hq-period-list-card portfolio"><div><span>BUSINESS PORTFOLIO</span><h3>业务组合与 ROI</h3></div><section>${rows.length
    ? rows.map((row) => `<div><strong>${escapeHtml(row['业务线'] || rowLabel(row, '业务线'))}</strong><span>${escapeHtml(row['分类'] || '未分类')}</span><b>${escapeHtml(row['决策'] || '待决策')}</b><p>${escapeHtml(`时间 ${row['时间投入'] || '—'} · 现金 ${row['现金结果'] || '—'} · 样本 ${row['外部样本'] || '—'}`)}</p></div>`).join('')
    : '<div class="empty"><strong>等待月省完成业务组合判断</strong><p>每条业务线必须加码、保持、削减、停止或限额验证。</p></div>'}</section></article>`;
}

function renderRisks(snapshot) {
  const risks = snapshot.derived.projectRisks || [];
  return `<article class="hq-period-list-card risks"><div><span>CURRENT RISKS</span><h3>跨周期项目预警</h3></div><ol>${risks.length
    ? risks.map((item) => `<li><i>!</i><div><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.nextAction?.content || '缺少下一步')}</small></div></li>`).join('')
    : '<li class="empty"><i>✓</i><div><strong>当前没有项目预警</strong><small>活跃项目都有下一步。</small></div></li>'}</ol></article>`;
}

function renderPeriod(app, input, type, remote) {
  const snapshot = normalizePeriodSnapshot(input, type);
  const review = snapshot.review;
  const isWeek = type === 'week';
  app.innerHTML = `<main class="page hq-period-page ${type}">
    ${renderPeriodHeader(snapshot, type, remote)}
    ${renderMetrics(snapshot, type)}
    <section class="hq-period-body">
      ${renderVerdict(review, type)}
      ${isWeek ? `<div class="hq-period-focus-grid">${renderExperiment(review.experiment)}${renderBottleneck(review.bottleneck)}</div>${renderScoreboard(review.scoreboard)}` : `${renderGoals(review.goals)}<div class="hq-period-two-col">${renderDecisions(review.strategicDecisions)}${renderPortfolio(review.portfolio)}</div>`}
      <div class="hq-period-two-col">${renderResources(review.resources, type)}${renderRisks(snapshot)}</div>
      ${renderSsc(review.startStopContinue, type)}
      ${!isWeek && review.notDoing.length ? `<article class="hq-month-not-do"><span>NOT DOING</span><strong>${escapeHtml(review.notDoing.join(' · '))}</strong></article>` : ''}
    </section>
  </main>`;
  app.querySelector('#hqPeriodBack').addEventListener('click', () => navigate('#home'));
  bindHqDimensionNav(app);
}

export async function renderHqPeriodPage(app, { dimension = 'week', refreshRemote = true } = {}) {
  const dateKey = localDateKey(new Date());
  const cache = readCache()[dimension];
  renderPeriod(app, cache || emptySnapshot(dimension, dateKey), dimension, false);
  if (!refreshRemote) return;
  try {
    const remote = await requestTaskboxApi(`/hq/periods/${dimension}/current?date=${encodeURIComponent(dateKey)}&offset=-1`);
    if (!remote) return;
    writeCache(dimension, remote);
    renderPeriod(app, remote, dimension, true);
  } catch {
    // Cached period view remains usable offline.
  }
}
