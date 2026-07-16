import { getSettings, setSettings, exportData, importData, pullDataFromCloud, exportDailySummary } from './db.js';
import { navigate, showToast } from './app.js';
import { pullPointsFromCloud } from './points-store.js';
import { renderCoreBoxNav } from './core-box-nav.js';
import { detectDeviceContext, normalizeDeviceMode } from './task-visibility.js';

const DEFAULT_API_ENDPOINT = 'https://liangzai666.com/taskbox-api/v1';
let lastAutoPullSignature = '';
let autoPullPromise = null;

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function persistServerSettings(app) {
  setSettings({
    apiEnabled: true,
    apiEndpoint: app.querySelector('#apiEndpoint').value.trim() || DEFAULT_API_ENDPOINT,
    apiToken: app.querySelector('#apiToken').value.trim(),
    cloudProvider: 'api',
    cloudEnabled: false,
    cloudEndpoint: '',
    cloudToken: '',
    githubToken: '',
    pointsDataUrl: '',
    pavilionDataUrl: '',
    towerDataUrl: '',
  });
}

function getServerFormConfig(app) {
  const endpoint = app.querySelector('#apiEndpoint').value.trim() || DEFAULT_API_ENDPOINT;
  const token = app.querySelector('#apiToken').value.trim();
  return {
    endpoint,
    token,
    signature: `${endpoint.replace(/\/$/, '')}::${token}`,
  };
}

async function autoPullServerData(app, { force = false } = {}) {
  persistServerSettings(app);

  const config = getServerFormConfig(app);
  if (!config.endpoint || !config.token) return;
  if (!force && config.signature === lastAutoPullSignature) return;
  if (autoPullPromise) return autoPullPromise;

  showToast('正在拉取服务器数据...');

  autoPullPromise = Promise.allSettled([
    pullDataFromCloud({ force: true }),
    pullPointsFromCloud(),
  ]).then(([boxResult, pointsResult]) => {
    const boxOk = boxResult.status === 'fulfilled' && boxResult.value === 'merged';
    const pointsOk = pointsResult.status === 'fulfilled' && pointsResult.value?.status === 'remote';

    if (boxOk && pointsOk) showToast('已拉取盒子和积分数据');
    else if (boxOk) showToast('已拉取盒子数据，积分拉取失败');
    else if (pointsOk) showToast('已拉取积分数据，盒子拉取失败');
    else showToast('服务器拉取失败，请检查 API Token');

    lastAutoPullSignature = boxOk || pointsOk ? config.signature : '';
  }).finally(() => {
    autoPullPromise = null;
  });

  return autoPullPromise;
}

export function renderSettings(app) {
  const settings = getSettings();
  const apiEndpoint = settings.apiEndpoint || DEFAULT_API_ENDPOINT;
  const hasToken = Boolean(String(settings.apiToken || '').trim());

  app.innerHTML = `
    <main id="settings" class="page settings-page">
      <header class="topbar safe-top">
        <button class="icon-btn icon-btn-ghost" id="backBtn">←</button>
        <h2>设置</h2>
        ${renderCoreBoxNav()}
      </header>

      <section class="panel settings-hero">
        <p class="eyebrow">Preferences</p>
        <h3>服务器数据库、主题与数据管理</h3>
        <p class="settings-intro">当前只使用服务器 API 作为云端数据库，旧的整份 JSON 云同步方案已关闭。</p>
      </section>

      <section class="panel">
        <div class="panel-heading">
          <div>
            <p class="eyebrow">AI</p>
            <h3>模型配置</h3>
          </div>
        </div>
        <label>DeepSeek API Key
          <div class="row gap8">
            <input id="apiKey" class="input" type="password" value="${escapeHtml(settings.deepseekApiKey || '')}" placeholder="sk-...">
            <button class="icon-btn" id="toggleKey" aria-label="显示或隐藏 API Key">👁</button>
          </div>
        </label>
      </section>

      <section class="panel">
        <div class="panel-heading">
          <div>
            <p class="eyebrow">Work Context</p>
            <h3>任务设备场景</h3>
          </div>
          <p class="panel-note">自动识别当前为${detectDeviceContext() === 'mobile' ? '手机' : '电脑'}；只调整排序，不会隐藏任务。</p>
        </div>
        <div class="device-mode-tabs">
          ${[['auto', '自动'], ['mobile', '手机'], ['desktop', '电脑'], ['all', '全部']].map(([value, label]) => `
            <button type="button" data-device-mode="${value}" class="${normalizeDeviceMode(settings.deviceContextMode) === value ? 'active' : ''}">${label}</button>
          `).join('')}
        </div>
      </section>

      <section class="panel">
        <div class="panel-heading">
          <div>
            <p class="eyebrow">Appearance</p>
            <h3>主题模式</h3>
          </div>
          <p class="panel-note">支持跟随系统、浅色和深色。</p>
        </div>
        <div class="tabs" id="themeTabs">
          ${[['system', '跟随系统'], ['light', '浅色'], ['dark', '深色']].map(([value, label]) => `
            <button class="tab ${settings.themeMode === value ? 'active' : ''}" data-theme="${value}">${label}</button>
          `).join('')}
        </div>
      </section>

      <section class="panel">
        <div class="setting-row">
          <div>
            <p class="eyebrow">Audio</p>
            <h3>完成音效</h3>
            <p class="panel-note">任务勾选完成后播放提示音。</p>
          </div>
          <label class="switch">
            <input id="soundEnabled" type="checkbox" ${settings.soundEnabled ? 'checked' : ''}>
            <span></span>
          </label>
        </div>
      </section>

      <section class="panel">
        <div class="panel-heading">
          <div>
            <p class="eyebrow">Server Database</p>
            <h3>服务器数据库</h3>
          </div>
          <p class="panel-note">任务、积分、珍宝阁和弑神塔统一通过服务器 API 读写。</p>
        </div>

        <div class="cloud-config-block">
          <label>服务器 API 地址
            <input id="apiEndpoint" class="input" value="${escapeHtml(apiEndpoint)}" placeholder="${DEFAULT_API_ENDPOINT}">
          </label>
          <label>服务器 API Token（只保存在本机）
            <input id="apiToken" class="input" type="password" value="${escapeHtml(settings.apiToken || '')}" placeholder="填写服务器 TASKBOX_API_TOKEN">
          </label>
          <p class="panel-note">${hasToken ? 'Token 已保存在本机，填写或更新 Token 后会自动拉取盒子和积分数据。' : '缺少 Token 时只能使用本地缓存，无法读写服务器数据库。'}</p>
        </div>

        <div class="action-grid">
          <button class="btn" id="pullCloudBtn">拉取盒子数据</button>
          <button class="btn" id="pullPointsBtn">拉取积分账本</button>
        </div>
      </section>

      <section class="panel">
        <div class="panel-heading">
          <div>
            <p class="eyebrow">Data</p>
            <h3>本地备份</h3>
          </div>
          <p class="panel-note">导出/导入只用于本地备份和恢复，不再作为云端同步方案。</p>
        </div>
        <div class="action-grid">
          <button class="btn" id="exportBtn">导出数据</button>
          <button class="btn" id="importBtn">导入数据</button>
          <button class="btn" id="dailySummaryBtn">导出今日日报</button>
          <input id="importInput" type="file" accept="application/json" hidden>
        </div>
      </section>

      <section class="panel muted settings-about">
        <p class="eyebrow">About</p>
        <h3>TaskBox</h3>
        <small>v1.1.0 · 游戏化任务管理 PWA</small>
      </section>
    </main>
  `;

  app.querySelector('#backBtn').addEventListener('click', () => navigate('#home'));
  app.querySelector('#toggleKey').addEventListener('click', () => {
    const input = app.querySelector('#apiKey');
    input.type = input.type === 'password' ? 'text' : 'password';
  });

  app.querySelector('#apiKey').addEventListener('blur', (event) => {
    setSettings({ deepseekApiKey: event.target.value.trim() });
  });

  app.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => {
    setSettings({ themeMode: tab.dataset.theme });
    renderSettings(app);
  }));

  app.querySelector('#soundEnabled').addEventListener('change', (event) => {
    setSettings({ soundEnabled: event.target.checked });
  });
  app.querySelectorAll('[data-device-mode]').forEach((button) => button.addEventListener('click', () => {
    setSettings({ deviceContextMode: button.dataset.deviceMode });
    renderSettings(app);
  }));

  const apiEndpointInput = app.querySelector('#apiEndpoint');
  const apiTokenInput = app.querySelector('#apiToken');
  apiEndpointInput.addEventListener('input', () => persistServerSettings(app));
  apiTokenInput.addEventListener('input', () => persistServerSettings(app));
  apiEndpointInput.addEventListener('change', () => autoPullServerData(app));
  apiEndpointInput.addEventListener('blur', () => autoPullServerData(app));
  apiTokenInput.addEventListener('change', () => autoPullServerData(app));
  apiTokenInput.addEventListener('blur', () => autoPullServerData(app));

  app.querySelector('#pullCloudBtn').addEventListener('click', async () => {
    persistServerSettings(app);
    try {
      const result = await pullDataFromCloud({ force: true });
      if (result === 'merged') showToast('已从服务器拉取盒子数据');
      else showToast('缺少服务器 API Token，已保留本地缓存');
      navigate('#home');
    } catch {
      showToast('服务器拉取失败，请检查 API Token 或网络');
    }
  });

  app.querySelector('#pullPointsBtn').addEventListener('click', async () => {
    persistServerSettings(app);
    try {
      const result = await pullPointsFromCloud();
      if (result.status === 'remote') showToast('已从服务器拉取积分账本');
      else showToast('服务器拉取失败，已使用本地缓存');
    } catch {
      showToast('积分账本拉取失败，请检查 API Token 或网络');
    }
  });

  app.querySelector('#exportBtn').addEventListener('click', exportData);
  app.querySelector('#dailySummaryBtn').addEventListener('click', exportDailySummary);
  app.querySelector('#importBtn').addEventListener('click', () => app.querySelector('#importInput').click());
  app.querySelector('#importInput').addEventListener('change', async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    if (!confirm('导入将覆盖当前所有数据，确认继续？')) return;
    try {
      await importData(file);
      showToast('导入成功');
      navigate('#home');
    } catch {
      showToast('导入失败，文件格式错误');
    }
  });
}
