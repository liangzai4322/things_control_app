import { navigate, openSheet, showToast } from './app.js';
import {
  ensurePointsData,
  getFilteredTransactions,
  getMilestoneBonuses,
  getPointPresets,
  getPointsSourceUrl,
  POINTS_SOURCE_FILTERS,
  getPointsSummary,
  getPointsSyncState,
  getRewardCatalog,
  getRewardPool,
  pullPointsFromCloud,
  recordHistoricalBalance,
  recordPointsTransaction,
  redeemReward,
  saveReward,
  toggleRewardActive,
} from './points-store.js';

const BUCKET_FILTERS = [
  { id: 'all', label: '全部流水' },
  { id: 'earn', label: '收入' },
  { id: 'spend', label: '支出' },
  { id: 'adjust', label: '调整' },
];
const SHEET_CLOSE_DELAY_MS = 240;

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatDelta(value) {
  const amount = Math.round(Number(value) || 0);
  return `${amount >= 0 ? '+' : '-'}${Math.abs(amount)} 分`;
}

function formatTime(value) {
  return new Date(value).toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function getSourceLabel(pointsData, syncState = getPointsSyncState()) {
  const url = pointsData.meta.sourceUrl || getPointsSourceUrl();
  if (url.includes('gist.githubusercontent.com')) return 'GitHub Gist';
  if (url.includes('raw.githubusercontent.com')) return 'GitHub 数据仓库';
  if (!url) return '本地 mock JSON';
  if (!/^https?:/i.test(url) && (url.endsWith('mock-points.json') || url.endsWith('data/mock-points.json'))) return '本地 mock JSON';
  return '自定义 JSON';
}

function getSyncNote(syncState) {
  if (syncState.autoPushEnabled) {
    return '进入页面会默认拉一次远端账本；本地改动会自动同步到 GitHub Gist。手动拉取入口也放在右上角。';
  }
  if (syncState.isGistSource || syncState.isGitHubSource) {
    return '进入页面会默认拉一次远端账本；要自动上传，请先在小世界设置里填写 GitHub Token。手动拉取入口也放在右上角。';
  }
  return '当前积分源不是 Gist Raw 链接，本地改动暂时只会保存在本地缓存。手动拉取入口也放在右上角。';
}

function groupRewardsByCategory(rewards = []) {
  const groups = new Map();
  rewards.forEach((reward) => {
    const category = reward.category || '未分类';
    if (!groups.has(category)) groups.set(category, []);
    groups.get(category).push(reward);
  });

  return [...groups.entries()]
    .map(([category, items]) => ({
      category,
      items: [...items].sort((a, b) => a.cost - b.cost || a.title.localeCompare(b.title, 'zh-CN')),
    }))
    .sort((a, b) => a.category.localeCompare(b.category, 'zh-CN'));
}

function renderRuleCard(item) {
  return `
    <article class="points-rule-card">
      <strong>${escapeHtml(item.label)}</strong>
      <span>${Math.round(Number(item.points) || 0)} 分</span>
      ${item.description ? `<p>${escapeHtml(item.description)}</p>` : ''}
    </article>
  `;
}

function renderRewardCard(reward, balance) {
  const affordable = balance >= reward.cost;
  return `
    <article class="points-reward-card ${affordable ? '' : 'locked'}">
      <div class="points-reward-head">
        <span class="points-reward-icon">${escapeHtml(reward.icon || '🎁')}</span>
        <div>
          <strong>${escapeHtml(reward.title)}</strong>
          <p>${escapeHtml(reward.category)}</p>
        </div>
      </div>
      <p class="points-reward-desc">${escapeHtml(reward.description || '兑换后立即记账。')}</p>
      <div class="points-reward-foot">
        <span class="points-cost">${reward.cost} 分</span>
        <button class="btn ${affordable ? '' : 'subtle'} compact" data-redeem="${reward.id}" ${affordable ? '' : 'disabled'}>
          ${affordable ? '立即兑换' : '积分不足'}
        </button>
      </div>
    </article>
  `;
}

function renderRewardGroups(rewards, balance) {
  return groupRewardsByCategory(rewards).map((group) => `
    <section class="points-group">
      <div class="points-group-head">
        <div>
          <strong>${escapeHtml(group.category)}</strong>
          <p>${group.items.length} 个奖励项</p>
        </div>
        <span class="points-group-count">总价 ${group.items.reduce((sum, item) => sum + item.cost, 0)} 分</span>
      </div>
      <div class="points-reward-grid points-reward-group-grid">
        ${group.items.map((reward) => renderRewardCard(reward, balance)).join('')}
      </div>
    </section>
  `).join('');
}

function renderTransaction(transaction) {
  const positive = Number(transaction.delta) >= 0;
  return `
    <article class="points-transaction ${positive ? 'positive' : 'negative'}">
      <span class="points-transaction-mark">${positive ? '+' : '-'}</span>
      <div class="points-transaction-body">
        <strong>${escapeHtml(transaction.title)}</strong>
        <p>${escapeHtml(transaction.note || '无备注')}</p>
        <small>${escapeHtml(formatTime(transaction.createdAt))}</small>
      </div>
      <span class="points-transaction-delta">${escapeHtml(formatDelta(transaction.delta))}</span>
    </article>
  `;
}

function renderFilterTabs(items, activeId, dataKey) {
  return `
    <div class="tabs points-filter-tabs">
      ${items.map((item) => `
        <button class="tab ${item.id === activeId ? 'active' : ''}" data-${dataKey}="${item.id}">
          ${escapeHtml(item.label)}
        </button>
      `).join('')}
    </div>
  `;
}

function renderRewardManagerCard(reward) {
  return `
    <article class="points-manage-card ${reward.active ? '' : 'inactive'}">
      <div class="points-manage-head">
        <div class="points-manage-title">
          <span class="points-reward-icon">${escapeHtml(reward.icon || '🎁')}</span>
          <div>
            <strong>${escapeHtml(reward.title)}</strong>
            <p>${escapeHtml(reward.category)} · ${reward.cost} 分</p>
          </div>
        </div>
        <span class="points-manage-state">${reward.active ? '启用中' : '已停用'}</span>
      </div>
      <p class="points-reward-desc">${escapeHtml(reward.description || '暂无说明')}</p>
      <div class="points-inline-actions">
        <button class="btn subtle compact" data-edit-reward="${reward.id}">编辑</button>
        <button class="btn subtle compact" data-toggle-reward="${reward.id}">${reward.active ? '停用' : '启用'}</button>
      </div>
    </article>
  `;
}

function renderRewardManagerGroups(rewards) {
  return groupRewardsByCategory(rewards).map((group) => `
    <section class="points-manage-group">
      <div class="points-group-head">
        <div>
          <strong>${escapeHtml(group.category)}</strong>
          <p>${group.items.length} 个奖励项</p>
        </div>
        <span class="points-group-count">${group.items.filter((item) => item.active).length} 个启用中</span>
      </div>
      <div class="points-manage-list">
        ${group.items.map(renderRewardManagerCard).join('')}
      </div>
    </section>
  `).join('');
}

function getLedgerEmptyCopy(filters) {
  if (filters.bucket !== 'all' || filters.source !== 'all') {
    return {
      title: '当前筛选下没有流水',
      body: '可以切回全部流水，或者再新增一笔积分看看效果。',
    };
  }
  return {
    title: '还没有积分流水',
    body: '先补录历史积分，或者完成第一条任务拿到第一笔积分。',
  };
}

function rerenderWithState(app, state) {
  return renderPointsPage(app, { ...state, refreshRemote: false });
}

function openNextSheetAfterClose(close, callback) {
  close();
  setTimeout(() => {
    callback?.();
  }, SHEET_CLOSE_DELAY_MS);
}

async function openPointsAiSheetLazy(app, viewState) {
  try {
    const { openPointsAiSheet } = await import('./points-ai.js');
    openPointsAiSheet({
      onDone: () => rerenderWithState(app, viewState),
    });
  } catch {
    showToast('AI 识别模块加载失败');
  }
}

function getPointsPullMessage(status) {
  if (status === 'remote') return '已拉取最新积分账本';
  if (status === 'dirty-cache') return '本地有未同步改动，已优先保留本地账本';
  return '云端拉取失败，已使用本地缓存';
}

async function refreshPointsFromCloud(app, viewState, { showFeedback = true } = {}) {
  const result = await pullPointsFromCloud();
  if (showFeedback) showToast(getPointsPullMessage(result.status));
  await rerenderWithState(app, viewState);
  return result;
}

export async function renderPointsPage(app, viewState = {}) {
  const filters = {
    bucket: viewState.bucket || 'all',
    source: viewState.source || 'all',
  };
  const shouldRefreshRemote = Boolean(viewState.refreshRemote);
  const pointsData = shouldRefreshRemote
    ? (await pullPointsFromCloud()).data
    : await ensurePointsData();
  const summary = getPointsSummary(pointsData);
  const pointPresets = getPointPresets(pointsData);
  const milestoneBonuses = getMilestoneBonuses(pointsData);
  const rewards = getRewardCatalog(pointsData);
  const rewardPool = getRewardPool(pointsData, { includeInactive: true });
  const transactions = getFilteredTransactions({ limit: 80, bucket: filters.bucket, source: filters.source }, pointsData);
  const syncState = getPointsSyncState();
  const balance = summary.balance;
  const emptyCopy = getLedgerEmptyCopy(filters);

  app.innerHTML = `
    <main class="page points-page" id="points-page">
      <header class="topbar safe-top">
        <div class="row gap8 center points-topbar-main">
          <button class="icon-btn icon-btn-ghost" id="pointsBackBtn">←</button>
          <h2>积分</h2>
        </div>
        <div class="row gap8 hero-tools points-topbar-actions">
          <button class="icon-btn icon-btn-ghost" id="pointsPullBtn" aria-label="拉取积分账本">↻</button>
          <button class="icon-btn icon-btn-ghost" id="pointsAiTopBtn" aria-label="AI识别积分">✦</button>
          <button class="icon-btn icon-btn-ghost" id="pointsSettingsBtn" aria-label="积分设置">⚙</button>
        </div>
      </header>

      <section class="panel points-hero">
        <div class="points-hero-head">
          <div>
            <p class="eyebrow">Points System</p>
            <h1>把奖励和克制都记进账本</h1>
            <p class="panel-note">${escapeHtml(getSyncNote(syncState))}</p>
          </div>
          <span class="points-source-badge">${escapeHtml(getSourceLabel(pointsData, syncState))}</span>
        </div>

        <div class="points-balance-row">
          <div>
            <p class="points-balance-label">当前余额</p>
            <strong class="points-balance">${balance}</strong>
            <span class="points-balance-unit">${escapeHtml(pointsData.account.unit || '分')}</span>
          </div>
          <div class="points-hero-actions">
            <button class="btn subtle compact" id="pointsHistoryBtn">${summary.openingBalanceRecorded ? '继续补录' : '补录历史积分'}</button>
            <button class="btn subtle compact" id="pointsManualBtn">手动记一笔</button>
            <button class="btn subtle compact" id="pointsAiEntryBtn">✦ AI识别</button>
          </div>
        </div>

        <div class="hero-stats points-stats">
          <article class="stat-card">
            <span>今日新增</span>
            <strong>${summary.todayEarned}</strong>
          </article>
          <article class="stat-card">
            <span>今日消耗</span>
            <strong>${summary.todaySpent}</strong>
          </article>
          <article class="stat-card">
            <span>近 7 天净增</span>
            <strong>${summary.recentNet}</strong>
          </article>
        </div>
      </section>

      <section class="section-heading">
        <div>
          <p class="eyebrow">Rules</p>
          <h2>默认积分规则</h2>
        </div>
        <p class="section-note">先跑固定档位，后面再细化周计划。</p>
      </section>

      <section class="points-rule-grid">
        ${pointPresets.map(renderRuleCard).join('')}
        ${milestoneBonuses.map(renderRuleCard).join('')}
      </section>

      <section class="section-heading">
        <div>
          <p class="eyebrow">Rewards</p>
          <h2>奖励兑换</h2>
        </div>
        <div class="points-heading-actions">
          <p class="section-note">${rewardPool.length} 个奖励项，支持本地编辑和停用。</p>
          <button class="btn subtle compact" id="manageRewardsBtn">管理奖励池</button>
        </div>
      </section>

      <section class="points-reward-sections">
        ${rewards.length
          ? renderRewardGroups(rewards, balance)
          : `
            <div class="empty-state points-empty">
              <div>🎁</div>
              <h3>还没有可兑换奖励</h3>
              <p>先去管理奖励池里加几项，晚上我们再一起细化价格表。</p>
            </div>
          `}
      </section>

      <section class="section-heading">
        <div>
          <p class="eyebrow">Ledger</p>
          <h2>积分流水</h2>
        </div>
        <p class="section-note">支持按收入、支出、任务得分、奖励兑换来筛选。</p>
      </section>

      <section class="panel points-filter-panel">
        ${renderFilterTabs(BUCKET_FILTERS, filters.bucket, 'bucket-filter')}
        ${renderFilterTabs(POINTS_SOURCE_FILTERS, filters.source, 'source-filter')}
      </section>

      <section class="points-ledger">
        ${transactions.length
          ? transactions.map(renderTransaction).join('')
          : `
            <div class="empty-state points-empty">
              <div>🧾</div>
              <h3>${escapeHtml(emptyCopy.title)}</h3>
              <p>${escapeHtml(emptyCopy.body)}</p>
            </div>
          `}
      </section>
    </main>
  `;

  app.querySelector('#pointsBackBtn').addEventListener('click', () => navigate('#home'));
  app.querySelector('#pointsPullBtn').addEventListener('click', async () => {
    await refreshPointsFromCloud(app, filters);
  });
  app.querySelector('#pointsAiTopBtn').addEventListener('click', () => {
    openPointsAiSheetLazy(app, filters);
  });
  app.querySelector('#pointsSettingsBtn').addEventListener('click', () => navigate('#settings'));
  app.querySelector('#pointsHistoryBtn').addEventListener('click', () => {
    openHistoricalSheet(() => rerenderWithState(app, filters));
  });
  app.querySelector('#pointsManualBtn').addEventListener('click', () => {
    openManualTransactionSheet(() => rerenderWithState(app, filters));
  });
  app.querySelector('#pointsAiEntryBtn').addEventListener('click', () => {
    openPointsAiSheetLazy(app, filters);
  });
  app.querySelector('#manageRewardsBtn').addEventListener('click', () => {
    openRewardManagerSheet({ app, viewState: filters });
  });

  app.querySelectorAll('[data-redeem]').forEach((button) => {
    button.addEventListener('click', () => {
      const reward = rewards.find((item) => item.id === button.dataset.redeem);
      if (!reward) {
        showToast('奖励不存在或已被移除');
        return;
      }
      openRewardRedeemSheet({ app, viewState: filters, reward });
    });
  });

  app.querySelectorAll('[data-bucket-filter]').forEach((button) => {
    button.addEventListener('click', () => {
      rerenderWithState(app, {
        ...filters,
        bucket: button.dataset.bucketFilter,
      });
    });
  });

  app.querySelectorAll('[data-source-filter]').forEach((button) => {
    button.addEventListener('click', () => {
      rerenderWithState(app, {
        ...filters,
        source: button.dataset.sourceFilter,
      });
    });
  });
}

function openHistoricalSheet(onDone) {
  const { root, close } = openSheet(`
    <div class="sheet-handle"></div>
    <div class="sheet-content">
      <p class="eyebrow">Opening Balance</p>
      <h3>补录历史积分</h3>
      <p class="sheet-lead">把系统启用前已经攒下来的分数补录进来，这样旧账和新账就接上了。</p>
      <label>历史积分
        <input id="historyPoints" class="input" type="number" min="0" step="1" placeholder="例如 120">
      </label>
      <label>备注
        <textarea id="historyNote" class="input" rows="3" placeholder="例如：4 月中旬前历史累计积分">${escapeHtml('系统启用前历史累计积分')}</textarea>
      </label>
      <div class="sheet-actions">
        <button class="btn" id="historyCancelBtn">取消</button>
        <button class="btn primary" id="historySaveBtn">补录</button>
      </div>
    </div>
  `, { height: '52vh' });

  root.querySelector('#historyCancelBtn').addEventListener('click', close);
  root.querySelector('#historySaveBtn').addEventListener('click', () => {
    const points = Math.max(0, Number(root.querySelector('#historyPoints').value) || 0);
    if (!points) {
      showToast('先填一个有效的历史积分数值');
      return;
    }
    const note = root.querySelector('#historyNote').value.trim();
    recordHistoricalBalance(points, note || '系统启用前历史累计积分');
    close();
    showToast(`历史积分已补录 +${points} 分`);
    onDone?.();
  });
}

function openManualTransactionSheet(onDone) {
  const { root, close } = openSheet(`
    <div class="sheet-handle"></div>
    <div class="sheet-content">
      <p class="eyebrow">Manual Entry</p>
      <h3>手动记一笔积分</h3>
      <p class="sheet-lead">用于临时奖励、手动支出或规则修正，不会替代任务完成自动记分。</p>
      <label>标题
        <input id="pointsTitle" class="input" placeholder="例如：手动兑换奶茶 / 临时奖励补记">
      </label>
      <label>积分变化
        <input id="pointsDelta" class="input" type="number" step="1" placeholder="收入填正数，支出填负数">
      </label>
      <label>备注
        <textarea id="pointsNote" class="input" rows="3" placeholder="写清楚这笔积分为什么发生"></textarea>
      </label>
      <div class="sheet-actions">
        <button class="btn" id="pointsCancelBtn">取消</button>
        <button class="btn primary" id="pointsSaveBtn">保存</button>
      </div>
    </div>
  `, { height: '56vh' });

  root.querySelector('#pointsCancelBtn').addEventListener('click', close);
  root.querySelector('#pointsSaveBtn').addEventListener('click', () => {
    const title = root.querySelector('#pointsTitle').value.trim();
    const delta = Math.round(Number(root.querySelector('#pointsDelta').value) || 0);
    const note = root.querySelector('#pointsNote').value.trim();
    if (!title) {
      showToast('先写清楚这笔积分的标题');
      return;
    }
    if (!delta) {
      showToast('积分变化不能为 0');
      return;
    }
    recordPointsTransaction({
      delta,
      title,
      note,
      sourceType: 'manual_adjustment',
      bucket: delta >= 0 ? 'earn' : 'spend',
    });
    close();
    showToast(`已记账 ${formatDelta(delta)}`);
    onDone?.();
  });
}

function openRewardManagerSheet({ app, viewState }) {
  const rewards = getRewardPool(null, { includeInactive: true });
  const { root, close } = openSheet(`
    <div class="sheet-handle"></div>
    <div class="sheet-content">
      <p class="eyebrow">Reward Pool</p>
      <h3>管理奖励池</h3>
      <p class="sheet-lead">奖励现在可以在系统里维护，后续会自动同步到 GitHub Gist。</p>
      <div class="sheet-actions">
        <button class="btn primary" id="rewardAddBtn">Add Reward</button>
      </div>
      <section class="points-manage-groups">
        ${rewards.length
          ? renderRewardManagerGroups(rewards)
          : `
            <div class="empty-state points-empty-sheet">
              <div>🎁</div>
              <h3>奖励池还是空的</h3>
              <p>先新增第一项奖励，后面就能直接兑换和扣分了。</p>
            </div>
          `}
      </section>
      <div class="sheet-actions">
        <button class="btn" id="rewardCloseBtn">关闭</button>
        <button class="btn primary" id="rewardAddBtn">新增奖励</button>
      </div>
    </div>
  `, { height: '82vh' });

  root.querySelector('#rewardCloseBtn').addEventListener('click', close);
  root.querySelectorAll('#rewardAddBtn').forEach((button) => {
    button.addEventListener('click', () => {
      openNextSheetAfterClose(close, () => {
        openRewardEditorSheet({ app, viewState, reopenManager: true });
      });
    });
  });

  root.querySelectorAll('[data-edit-reward]').forEach((button) => {
    button.addEventListener('click', () => {
      const reward = rewards.find((item) => item.id === button.dataset.editReward);
      openNextSheetAfterClose(close, () => {
        openRewardEditorSheet({ app, viewState, reward, reopenManager: true });
      });
    });
  });

  root.querySelectorAll('[data-toggle-reward]').forEach((button) => {
    button.addEventListener('click', async () => {
      const changed = toggleRewardActive(button.dataset.toggleReward);
      if (!changed) {
        showToast('奖励状态更新失败');
        return;
      }
      showToast(changed.active ? `已启用 ${changed.title}` : `已停用 ${changed.title}`);
      await rerenderWithState(app, viewState);
      openRewardManagerSheet({ app, viewState });
    });
  });
}

function openRewardRedeemSheet({ app, viewState, reward }) {
  const summary = getPointsSummary();
  const balance = summary.balance;
  const remaining = balance - reward.cost;
  const affordable = remaining >= 0;
  const { root, close } = openSheet(`
    <div class="sheet-handle"></div>
    <div class="sheet-content">
      <p class="eyebrow">Redeem Reward</p>
      <h3>确认兑换</h3>
      <p class="sheet-lead">奖励消费也要进账本。确认之后会立刻扣分，后面就按已兑换执行。</p>
      <article class="points-confirm-card">
        <div class="points-manage-title">
          <span class="points-reward-icon">${escapeHtml(reward.icon || '🎁')}</span>
          <div>
            <strong>${escapeHtml(reward.title)}</strong>
            <p>${escapeHtml(reward.category || '未分类')} · ${reward.cost} 分</p>
          </div>
        </div>
        ${reward.description ? `<p class="points-reward-desc">${escapeHtml(reward.description)}</p>` : ''}
      </article>
      <div class="points-confirm-metrics">
        <article class="points-confirm-metric">
          <span>当前余额</span>
          <strong>${balance} 分</strong>
        </article>
        <article class="points-confirm-metric">
          <span>兑换后余额</span>
          <strong>${remaining} 分</strong>
        </article>
      </div>
      ${affordable
        ? `<p class="points-confirm-warning">这次消费会被正式记到账本里，不再是口头奖励。</p>`
        : `<p class="points-confirm-warning danger">当前积分不够，先去完成任务再回来兑换。</p>`}
      <div class="sheet-actions">
        <button class="btn" id="rewardRedeemCancelBtn">取消</button>
        <button class="btn primary" id="rewardRedeemConfirmBtn" ${affordable ? '' : 'disabled'}>确认兑换</button>
      </div>
    </div>
  `, { height: '62vh' });

  root.querySelector('#rewardRedeemCancelBtn').addEventListener('click', close);
  root.querySelector('#rewardRedeemConfirmBtn').addEventListener('click', async () => {
    const result = redeemReward(reward.id);
    if (!result.ok) {
      showToast(result.reason === 'insufficient' ? '积分不够，先去完成任务攒分。' : '奖励兑换失败');
      return;
    }
    close();
    showToast(`已兑换 ${result.reward.title}，扣除 ${result.reward.cost} 分`);
    await rerenderWithState(app, viewState);
  });
}

function openRewardEditorSheet({ app, viewState, reward = null, reopenManager = false }) {
  const { root, close } = openSheet(`
    <div class="sheet-handle"></div>
    <div class="sheet-content">
      <p class="eyebrow">Reward Editor</p>
      <h3>${reward ? '编辑奖励' : '新增奖励'}</h3>
      <p class="sheet-lead">这里先把名称、价格和用途写清楚，后续再一起打磨价格体系。</p>
      <label>奖励名称
        <input id="rewardTitle" class="input" value="${escapeHtml(reward?.title || '')}" placeholder="例如：奶茶 / 短视频 30 分钟">
      </label>
      <label>积分价格
        <input id="rewardCost" class="input" type="number" min="0" step="1" value="${reward?.cost ?? ''}" placeholder="例如 18">
      </label>
      <label>分类
        <input id="rewardCategory" class="input" value="${escapeHtml(reward?.category || '')}" placeholder="例如：娱乐 / 放松 / 消费">
      </label>
      <label>图标
        <input id="rewardIcon" class="input" value="${escapeHtml(reward?.icon || '🎁')}" placeholder="例如：🥤">
      </label>
      <label>说明
        <textarea id="rewardDescription" class="input" rows="4" placeholder="写清楚这个奖励什么时候可以兑换">${escapeHtml(reward?.description || '')}</textarea>
      </label>
      <label class="points-switch-row">
        <span>启用状态</span>
        <input id="rewardActive" type="checkbox" ${reward?.active !== false ? 'checked' : ''}>
      </label>
      <div class="sheet-actions">
        <button class="btn" id="rewardCancelBtn">取消</button>
        <button class="btn primary" id="rewardSaveBtn">保存奖励</button>
      </div>
    </div>
  `, { height: '84vh' });

  root.querySelector('#rewardCancelBtn').addEventListener('click', close);
  root.querySelector('#rewardSaveBtn').addEventListener('click', async () => {
    const title = root.querySelector('#rewardTitle').value.trim();
    const cost = Math.max(0, Math.round(Number(root.querySelector('#rewardCost').value) || 0));
    const category = root.querySelector('#rewardCategory').value.trim();
    const icon = root.querySelector('#rewardIcon').value.trim();
    const description = root.querySelector('#rewardDescription').value.trim();
    const active = root.querySelector('#rewardActive').checked;

    if (!title) {
      showToast('先写奖励名称');
      return;
    }

    try {
      const saved = saveReward({
        id: reward?.id,
        title,
        cost,
        category: category || '未分类',
        icon: icon || '🎁',
        description,
        active,
      });
      close();
      showToast(`${reward ? '已更新' : '已新增'}奖励：${saved.title}`);
      await rerenderWithState(app, viewState);
      if (reopenManager) {
        setTimeout(() => {
          openRewardManagerSheet({ app, viewState });
        }, SHEET_CLOSE_DELAY_MS);
        return;
      }
      close();
    } catch {
      showToast('奖励保存失败，请检查名称和价格');
    }
  });
}
