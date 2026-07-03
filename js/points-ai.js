import { getSettings } from './db.js';
import { checkOnline, navigate, openSheet, showToast } from './app.js';
import { recordPointsTransaction } from './points-store.js';

const draftState = {
  input: '',
  rows: [],
  extracted: false,
};

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function getDeltaLabel(delta) {
  return Number(delta) >= 0 ? '收入' : '支出';
}

function toDateTimeLocal(value = '') {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}T${hh}:${min}`;
}

function toIsoFromLocalInput(value = '') {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function extractFirstJsonObject(text = '') {
  const start = text.indexOf('{');
  if (start < 0) return '';
  let depth = 0;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return '';
}

function parseAiJson(text = '') {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidates = [fenced, text.trim(), extractFirstJsonObject(text)].filter(Boolean);
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // continue
    }
  }
  throw new Error('points_ai_parse_failed');
}

async function requestPointsRecognition(userInput, apiKey) {
  const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    mode: 'cors',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      temperature: 0.2,
      messages: [
        {
          role: 'system',
          content: `你是一个积分流水识别助手。用户会输入自然语言，描述积分收入、支出或调整。请你严格返回 JSON：{"entries":[{"title":"标题","delta":-5,"note":"备注","createdAt":"ISO时间或空字符串"}]}。规则：1. 收入为正数，支出为负数。2. title 要简短准确。3. note 保留原话里的关键信息。4. 如果没有明确时间，createdAt 返回空字符串。5. 如果没有可登记的积分记录，返回 {"entries":[]}。6. 只能返回 JSON，不能附加解释。`,
        },
        {
          role: 'user',
          content: userInput,
        },
      ],
    }),
  });

  if (!response.ok) throw new Error('points_ai_request_failed');
  const data = await response.json();
  const text = data.choices?.[0]?.message?.content || '{"entries":[]}';
  return parseAiJson(text);
}

function normalizeRows(parsed = {}, rawInput = '') {
  return (Array.isArray(parsed.entries) ? parsed.entries : [])
    .map((entry, index) => {
      const title = String(entry.title || entry.name || '').trim();
      const delta = Math.round(Number(entry.delta) || 0);
      if (!title || !delta) return null;
      return {
        id: entry.id || `points-ai-${Date.now()}-${index}`,
        checked: true,
        title,
        delta,
        note: String(entry.note || rawInput || '').trim(),
        createdAt: toDateTimeLocal(entry.createdAt || ''),
      };
    })
    .filter(Boolean);
}

function clearDraft(root = null) {
  draftState.input = '';
  draftState.rows = [];
  draftState.extracted = false;
  if (root) {
    root.querySelector('#pointsAiInput').value = '';
    root.querySelector('#pointsAiResult').innerHTML = '';
  }
}

function getSelectedRows() {
  return draftState.rows.filter((row) => row.checked && row.title.trim() && Number(row.delta));
}

function renderResult(root, { onDone, close }) {
  const wrap = root.querySelector('#pointsAiResult');
  if (!draftState.rows.length) {
    wrap.innerHTML = `
      <div class="empty-state points-empty-sheet">
        <div>🪄</div>
        <h3>还没识别到可入账记录</h3>
        <p>可以换一种更明确的表达，比如“今天买可乐花了 5 分”或者“写完复盘获得 10 分”。</p>
      </div>
    `;
    return;
  }

  const render = () => {
    const selected = getSelectedRows();
    wrap.innerHTML = `
      <div class="points-ai-list">
        ${draftState.rows.map((row, index) => `
          <article class="points-ai-card ${row.delta >= 0 ? 'positive' : 'negative'}">
            <div class="points-ai-card-head">
              <label class="points-ai-check">
                <input type="checkbox" data-row-check="${index}" ${row.checked ? 'checked' : ''}>
                <span class="points-ai-kind ${row.delta >= 0 ? 'positive' : 'negative'}">${getDeltaLabel(row.delta)}</span>
              </label>
              <button class="icon-btn" data-row-delete="${index}" aria-label="删除识别结果">×</button>
            </div>
            <label>标题
              <input class="input" data-row-title="${index}" value="${escapeHtml(row.title)}" placeholder="这条记录的标题">
            </label>
            <div class="points-ai-grid">
              <label>积分变化
                <input class="input" data-row-delta="${index}" type="number" step="1" value="${row.delta}">
              </label>
              <label>发生时间
                <input class="input" data-row-time="${index}" type="datetime-local" value="${row.createdAt}">
              </label>
            </div>
            <label>备注
              <textarea class="input" data-row-note="${index}" rows="3" placeholder="补充这条积分为什么发生">${escapeHtml(row.note)}</textarea>
            </label>
          </article>
        `).join('')}
      </div>
      <div class="sheet-actions points-ai-result-actions">
        <button class="btn" id="pointsAiResetBtn">清空结果</button>
        <button class="btn primary" id="pointsAiConfirmBtn">确认入库 (${selected.length} 条)</button>
      </div>
    `;

    wrap.querySelectorAll('[data-row-check]').forEach((element) => {
      element.addEventListener('change', () => {
        draftState.rows[Number(element.dataset.rowCheck)].checked = element.checked;
        render();
      });
    });

    wrap.querySelectorAll('[data-row-delete]').forEach((element) => {
      element.addEventListener('click', () => {
        draftState.rows.splice(Number(element.dataset.rowDelete), 1);
        render();
      });
    });

    wrap.querySelectorAll('[data-row-title]').forEach((element) => {
      element.addEventListener('input', () => {
        draftState.rows[Number(element.dataset.rowTitle)].title = element.value;
      });
    });

    wrap.querySelectorAll('[data-row-delta]').forEach((element) => {
      element.addEventListener('change', () => {
        draftState.rows[Number(element.dataset.rowDelta)].delta = Math.round(Number(element.value) || 0);
        render();
      });
    });

    wrap.querySelectorAll('[data-row-time]').forEach((element) => {
      element.addEventListener('change', () => {
        draftState.rows[Number(element.dataset.rowTime)].createdAt = element.value;
      });
    });

    wrap.querySelectorAll('[data-row-note]').forEach((element) => {
      element.addEventListener('input', () => {
        draftState.rows[Number(element.dataset.rowNote)].note = element.value;
      });
    });

    wrap.querySelector('#pointsAiResetBtn').addEventListener('click', () => {
      draftState.rows = [];
      draftState.extracted = false;
      renderResult(root, { onDone, close });
    });

    wrap.querySelector('#pointsAiConfirmBtn').addEventListener('click', () => {
      const rows = getSelectedRows();
      if (!rows.length) {
        showToast('至少保留一条有效识别记录');
        return;
      }

      rows.forEach((row) => {
        recordPointsTransaction({
          delta: row.delta,
          title: row.title.trim(),
          note: row.note.trim() || draftState.input.trim(),
          createdAt: toIsoFromLocalInput(row.createdAt),
          sourceType: 'ai_recognition',
          bucket: row.delta >= 0 ? 'earn' : 'spend',
        });
      });

      clearDraft(root);
      close();
      showToast(`AI 识别入账完成，共 ${rows.length} 条`);
      onDone?.();
    });
  };

  render();
}

export function openPointsAiSheet({ onDone } = {}) {
  if (!checkOnline()) return;

  const { root, close } = openSheet(`
    <div class="sheet-handle"></div>
    <div class="sheet-content ai-sheet points-ai-sheet">
      <header class="row between center">
        <h3>✦ AI 积分识别</h3>
        <button class="icon-btn" id="closePointsAi">✕</button>
      </header>
      <p class="sheet-lead">把自然语言描述交给 AI 先识别，再由你确认后入账。比如：今天买了一瓶可乐消耗 5 个积分。</p>
      <textarea id="pointsAiInput" class="input" rows="6" placeholder="输入你今天发生的一条或多条积分行为">${escapeHtml(draftState.input)}</textarea>
      <button class="link-btn" id="pointsAiToSettings">使用 DeepSeek AI · 前往设置配置 API Key</button>
      <div class="points-ai-runner">
        <button class="btn primary" id="runPointsAi">✦ 开始识别</button>
      </div>
      <div id="pointsAiResult"></div>
    </div>
  `, { height: '78vh' });

  const input = root.querySelector('#pointsAiInput');
  input.addEventListener('input', () => {
    draftState.input = input.value;
  });

  root.querySelector('#closePointsAi').addEventListener('click', close);
  root.querySelector('#pointsAiToSettings').addEventListener('click', () => {
    close();
    navigate('#settings');
  });

  root.querySelector('#runPointsAi').addEventListener('click', async () => {
    const settings = getSettings();
    if (!settings.deepseekApiKey) {
      showToast('请先在设置中配置 DeepSeek API Key');
      return;
    }

    const userInput = root.querySelector('#pointsAiInput').value.trim();
    if (!userInput) {
      showToast('先输入一段要识别的积分描述');
      return;
    }

    const button = root.querySelector('#runPointsAi');
    button.disabled = true;
    button.textContent = '识别中...';
    try {
      const parsed = await requestPointsRecognition(userInput, settings.deepseekApiKey);
      draftState.rows = normalizeRows(parsed, userInput);
      draftState.extracted = true;
      renderResult(root, { onDone, close });
      if (draftState.rows.length) showToast(`已识别 ${draftState.rows.length} 条候选记录`);
    } catch {
      showToast('AI 识别失败，请检查网络、Key 或稍后重试');
    } finally {
      button.disabled = false;
      button.textContent = '✦ 开始识别';
    }
  });

  if (draftState.extracted) {
    renderResult(root, { onDone, close });
  }
}
