import { getBoxes, getSettings, addTask } from './db.js';
import { openSheet, showToast, navigate, checkOnline } from './app.js';

const draftState = {
  input: '',
  rows: [],
  extracted: false,
};

export function openAIExtractSheet() {
  if (!checkOnline()) return;

  const { root, close } = openSheet(`
    <div class="sheet-handle"></div>
    <div class="sheet-content ai-sheet">
      <header class="row between center"><h3>✦ AI 智能提取</h3><button class="icon-btn" id="closeAi">✕</button></header>
      <textarea id="aiInput" class="input" rows="6" placeholder="输入你的任务文本，例如：重要事项有开会、写报告，杂事有买菜、回消息…">${draftState.input}</textarea>
      <button class="link-btn" id="toSettings">使用 DeepSeek AI · 前往设置配置 API Key</button>
      <button class="btn primary" id="runExtract">✦ 开始提取</button>
      <div id="extractResult"></div>
    </div>
  `, { height: '70vh' });

  const input = root.querySelector('#aiInput');
  input.addEventListener('input', () => {
    draftState.input = input.value;
  });

  root.querySelector('#closeAi').addEventListener('click', close);
  root.querySelector('#toSettings').addEventListener('click', () => {
    close();
    navigate('#settings');
  });

  root.querySelector('#runExtract').addEventListener('click', async () => {
    const settings = getSettings();
    if (!settings.deepseekApiKey) {
      showToast('请先在设置中配置 DeepSeek API Key');
      return;
    }

    const userInput = root.querySelector('#aiInput').value.trim();
    if (!userInput) return;

    root.querySelector('#runExtract').disabled = true;
    try {
      const boxes = getBoxes();
      const boxNames = boxes.map((b) => b.name).join('、');
      const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
        method: 'POST',
        mode: 'cors',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${settings.deepseekApiKey}`,
        },
        body: JSON.stringify({
          model: 'deepseek-chat',
          messages: [
            {
              role: 'system',
              content: `你是一个任务提取助手。用户会输入一段包含任务信息的文字，请将其中的任务按盒子分类提取出来，返回严格的JSON格式：{"boxes":[{"boxName":"重要事项","tasks":["任务1","任务2"]}]}只返回JSON，不要有其他文字。可用盒子名称：${boxNames}`,
            },
            { role: 'user', content: userInput },
          ],
          temperature: 0.3,
        }),
      });

      const data = await response.json();
      const text = data.choices?.[0]?.message?.content || '{"boxes":[]}';
      const parsed = JSON.parse(text);
      draftState.rows = convertToRows(parsed, boxes);
      draftState.extracted = true;
      renderResult(root, boxes);
    } catch {
      showToast('提取失败，请检查网络或Key');
    } finally {
      root.querySelector('#runExtract').disabled = false;
    }
  });

  if (draftState.extracted && draftState.rows.length) {
    renderResult(root, getBoxes());
  }
}

function convertToRows(parsed, boxes) {
  const rows = [];
  (parsed.boxes || []).forEach((group) => {
    const box = boxes.find((b) => b.name === group.boxName) || boxes[0];
    (group.tasks || []).forEach((task) => rows.push({ checked: true, content: task, boxId: box.id }));
  });
  return rows;
}

function clearDraft(root) {
  draftState.input = '';
  draftState.rows = [];
  draftState.extracted = false;
  if (root) {
    root.querySelector('#aiInput').value = '';
    root.querySelector('#extractResult').innerHTML = '';
  }
}

function renderResult(root, boxes) {
  const wrap = root.querySelector('#extractResult');
  if (!draftState.rows.length) {
    wrap.innerHTML = '<p class="muted">未提取到任务</p>';
    return;
  }

  const render = () => {
    const count = draftState.rows.filter((r) => r.checked).length;
    wrap.innerHTML = `
      <div class="extract-list">
        ${draftState.rows.map((r, i) => `
          <div class="extract-row">
            <input type="checkbox" data-i="${i}" ${r.checked ? 'checked' : ''}>
            <input class="input" data-c="${i}" value="${r.content}">
            <select class="input" data-b="${i}">${boxes.map((b) => `<option value="${b.id}" ${b.id === r.boxId ? 'selected' : ''}>${b.name}</option>`).join('')}</select>
            <button class="icon-btn" data-del="${i}">×</button>
          </div>
        `).join('')}
      </div>
      <button class="btn primary" id="confirmAdd">确认添加 (${count}项)</button>
    `;

    wrap.querySelectorAll('[data-i]').forEach((el) => el.addEventListener('change', () => {
      draftState.rows[el.dataset.i].checked = el.checked;
      render();
    }));
    wrap.querySelectorAll('[data-c]').forEach((el) => el.addEventListener('input', () => {
      draftState.rows[el.dataset.c].content = el.value;
    }));
    wrap.querySelectorAll('[data-b]').forEach((el) => el.addEventListener('change', () => {
      draftState.rows[el.dataset.b].boxId = el.value;
    }));
    wrap.querySelectorAll('[data-del]').forEach((el) => el.addEventListener('click', () => {
      draftState.rows.splice(el.dataset.del, 1);
      render();
    }));

    wrap.querySelector('#confirmAdd')?.addEventListener('click', () => {
      draftState.rows
        .filter((r) => r.checked && r.content.trim())
        .forEach((r) => addTask({ boxId: r.boxId, content: r.content.trim() }));
      showToast('任务已添加');
      clearDraft(root);
    });
  };

  render();
}
