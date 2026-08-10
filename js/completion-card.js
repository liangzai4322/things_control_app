import { openSheet, showToast } from './app.js';

const CARD_WIDTH = 1080;
const CARD_HEIGHT = 1440;
const NOTE_LINES_PER_PAGE = 13;
const CARD_VERSION = 2;

export const COMPLETION_RECEIPT_TEMPLATES = Object.freeze([
  { id: 'focus', name: '留白焦点', source: 'Apple' },
  { id: 'finish-line', name: '冲线时刻', source: 'Nike' },
  { id: 'level-clear', name: '像素通关', source: 'Nintendo 2001' },
  { id: 'paper-file', name: '纸页档案', source: 'Notion' },
  { id: 'soundwave', name: '声波庆典', source: 'Spotify' },
  { id: 'track-number', name: '赛道编号', source: 'BMW M' },
  { id: 'pinboard', name: '灵感拼贴', source: 'Pinterest' },
  { id: 'field-notes', name: '思考手记', source: 'Claude' },
]);

const TEMPLATE_IDS = new Set(COMPLETION_RECEIPT_TEMPLATES.map((item) => item.id));

const CARD_THEMES = {
  important: { start: '#5c2035', end: '#d66b42', accent: '#ffcb7d', glow: '#ff875f' },
  misc: { start: '#152d61', end: '#277f9d', accent: '#9ee8ff', glow: '#5c8cff' },
  relax: { start: '#40306f', end: '#cf6d6a', accent: '#ffd49f', glow: '#de8cff' },
  reward: { start: '#754020', end: '#d48a35', accent: '#fff0ad', glow: '#ffb452' },
  punish: { start: '#1c2638', end: '#515b70', accent: '#dbe4f2', glow: '#7788a8' },
  study: { start: '#174c46', end: '#3b8c69', accent: '#c3f5cf', glow: '#52c98a' },
  health: { start: '#133f59', end: '#3475a5', accent: '#c3efff', glow: '#50bce8' },
  idea: { start: '#183e42', end: '#477c68', accent: '#d1f0c9', glow: '#6dc9a4' },
};

function cleanText(value = '') {
  return String(value || '').replace(/\r\n/g, '\n').trim();
}

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function validDate(value) {
  const date = new Date(value || 0);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function formatCompletedAt(value) {
  return validDate(value).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).replaceAll('/', '.');
}

function resolveTheme(color) {
  return CARD_THEMES[color] || CARD_THEMES.idea;
}

function stableTemplateId(seed = '') {
  const hash = Array.from(String(seed)).reduce((value, character) => (
    Math.imul(value ^ character.codePointAt(0), 16777619) >>> 0
  ), 2166136261);
  return COMPLETION_RECEIPT_TEMPLATES[hash % COMPLETION_RECEIPT_TEMPLATES.length].id;
}

export function pickCompletionReceiptTemplate(excludedId = '') {
  const choices = COMPLETION_RECEIPT_TEMPLATES.filter((item) => item.id !== excludedId);
  const random = globalThis.crypto?.getRandomValues
    ? globalThis.crypto.getRandomValues(new Uint32Array(1))[0] / 4294967296
    : Math.random();
  return choices[Math.floor(random * choices.length)]?.id || COMPLETION_RECEIPT_TEMPLATES[0].id;
}

function resolveTemplateId(value, seed = '') {
  return TEMPLATE_IDS.has(value) ? value : stableTemplateId(seed);
}

function templateName(templateId) {
  return COMPLETION_RECEIPT_TEMPLATES.find((item) => item.id === templateId)?.name || '完成回执';
}

export function createCompletionReceiptSnapshot(task, {
  box = null,
  mainline = null,
  branch = null,
  pointsAwarded = null,
  templateId = '',
} = {}) {
  const completedAt = task?.completedAt || new Date().toISOString();
  return {
    version: CARD_VERSION,
    sourceTaskId: task?.id || '',
    createdAt: new Date().toISOString(),
    completedAt,
    content: cleanText(task?.content) || '已完成一项任务',
    note: cleanText(task?.note),
    boxName: cleanText(box?.name) || '行动盒子',
    boxColor: cleanText(box?.color) || 'idea',
    mainlineName: cleanText(mainline?.name),
    branchName: cleanText(branch?.name),
    pointsAwarded: Math.max(0, Number(pointsAwarded ?? task?.pointsValue) || 0),
    executionMode: task?.executionMode || 'self',
    templateId: TEMPLATE_IDS.has(templateId) ? templateId : pickCompletionReceiptTemplate(),
  };
}

export function getCompletionReceiptSnapshot(task, context = {}) {
  const saved = task?.completionReceipt;
  if (saved && Number(saved.version) >= 1 && saved.sourceTaskId === task?.id) {
    return {
      ...saved,
      content: cleanText(saved.content) || cleanText(task?.content),
      note: cleanText(saved.note),
      boxColor: cleanText(saved.boxColor) || cleanText(context.box?.color) || 'idea',
      templateId: resolveTemplateId(saved.templateId, `${task?.id}:${saved.completedAt}`),
    };
  }
  return createCompletionReceiptSnapshot(task, context);
}

function roundedRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function splitCanvasLines(ctx, value, maxWidth) {
  const source = cleanText(value);
  if (!source) return ['这次完成没有留下备注。'];
  const lines = [];
  source.split('\n').forEach((paragraph, paragraphIndex, paragraphs) => {
    if (!paragraph.trim()) {
      lines.push('');
      return;
    }
    let line = '';
    Array.from(paragraph).forEach((character) => {
      const candidate = `${line}${character}`;
      if (line && ctx.measureText(candidate).width > maxWidth) {
        lines.push(line);
        line = character;
      } else {
        line = candidate;
      }
    });
    if (line) lines.push(line);
    if (paragraphIndex < paragraphs.length - 1) lines.push('');
  });
  while (lines.at(-1) === '') lines.pop();
  return lines.length ? lines : ['这次完成没有留下备注。'];
}

function clampCanvasLines(ctx, value, maxWidth, maxLines) {
  const lines = splitCanvasLines(ctx, value, maxWidth);
  if (lines.length <= maxLines) return lines;
  const result = lines.slice(0, maxLines);
  let last = result.at(-1) || '';
  while (last && ctx.measureText(`${last}…`).width > maxWidth) last = last.slice(0, -1);
  result[result.length - 1] = `${last}…`;
  return result;
}

function drawStamp(ctx, color, label = '结 案', x = 892, y = 155) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(-0.1);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.9;
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.arc(0, 0, 72, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(0, 0, 59, 0, Math.PI * 2);
  ctx.stroke();
  ctx.textAlign = 'center';
  ctx.font = '700 34px "Microsoft YaHei", sans-serif';
  ctx.fillText(label, 0, 3);
  ctx.font = '700 19px ui-monospace, monospace';
  ctx.fillText('DONE', 0, 32);
  ctx.restore();
}

function fillCanvas(ctx, color) {
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT);
}

function drawReceiptArt(ctx, templateId, theme, pageIndex) {
  const style = { ink: '#fff', muted: 'rgba(255,255,255,.68)', accent: theme.accent, panel: 'rgba(255,255,255,.105)', border: 'rgba(255,255,255,.22)', serif: false };

  if (templateId === 'focus') {
    Object.assign(style, { ink: '#1d1d1f', muted: '#6e6e73', accent: '#0066cc', panel: '#f5f5f7', border: '#e0e0e0' });
    fillCanvas(ctx, '#ffffff');
    ctx.fillStyle = '#f5f5f7';
    ctx.fillRect(0, 0, CARD_WIDTH, 28);
    ctx.fillStyle = style.accent;
    ctx.beginPath(); ctx.arc(934, 118, 42, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.font = '700 42px system-ui'; ctx.textAlign = 'center'; ctx.fillText('✓', 934, 133); ctx.textAlign = 'left';
  } else if (templateId === 'finish-line') {
    Object.assign(style, { accent: '#dfff00', panel: '#151515', border: '#3b3b3b' });
    fillCanvas(ctx, '#050505');
    ctx.fillStyle = style.accent;
    ctx.beginPath(); ctx.moveTo(680, 0); ctx.lineTo(1080, 0); ctx.lineTo(1080, 460); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#050505'; ctx.font = '900 164px Impact, sans-serif'; ctx.fillText('DONE', 688, 172);
  } else if (templateId === 'level-clear') {
    Object.assign(style, { ink: '#fff8df', muted: '#d9e5ff', accent: '#ffd43b', panel: '#163f9a', border: '#fff8df' });
    fillCanvas(ctx, '#2256c7');
    const pixels = ['#e53935', '#ffd43b', '#fff8df'];
    for (let index = 0; index < 12; index += 1) {
      ctx.fillStyle = pixels[index % pixels.length];
      ctx.fillRect(820 + (index % 4) * 54, 52 + Math.floor(index / 4) * 54, 40, 40);
    }
    ctx.strokeStyle = '#fff8df'; ctx.lineWidth = 10; ctx.strokeRect(34, 34, 1012, 1372);
  } else if (templateId === 'paper-file') {
    Object.assign(style, { ink: '#191919', muted: '#787774', accent: '#eb5757', panel: '#fff', border: '#d8d8d6', serif: true });
    fillCanvas(ctx, '#f7f6f3');
    ctx.strokeStyle = '#deddd9'; ctx.lineWidth = 2;
    for (let y = 88; y < CARD_HEIGHT; y += 54) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(CARD_WIDTH, y); ctx.stroke(); }
    ctx.fillStyle = '#191919'; ctx.font = '900 104px Georgia, serif'; ctx.fillText('✓', 886, 162);
  } else if (templateId === 'soundwave') {
    Object.assign(style, { accent: '#1ed760', panel: '#29145f', border: '#8b5cf6' });
    fillCanvas(ctx, '#170f2f');
    ['#ff4ecd', '#8b5cf6', '#1ed760'].forEach((color, index) => {
      ctx.strokeStyle = color; ctx.lineWidth = 38; ctx.beginPath();
      for (let x = -80; x <= 1160; x += 40) {
        const y = 150 + index * 44 + Math.sin((x + pageIndex * 30) / 90) * (54 + index * 16);
        if (x === -80) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    });
  } else if (templateId === 'track-number') {
    Object.assign(style, { ink: '#111', muted: '#5d6570', accent: '#0066b1', panel: '#f2f4f7', border: '#ccd2d8' });
    fillCanvas(ctx, '#fff');
    ['#00a4e4', '#173f8a', '#e1262f'].forEach((color, index) => {
      ctx.fillStyle = color; ctx.save(); ctx.translate(774 + index * 76, -70); ctx.rotate(-0.34); ctx.fillRect(0, 0, 54, 430); ctx.restore();
    });
    ctx.fillStyle = '#111'; ctx.font = '900 158px Arial Narrow, sans-serif'; ctx.fillText('01', 812, 250);
  } else if (templateId === 'pinboard') {
    Object.assign(style, { ink: '#2f1b20', muted: '#75565f', accent: '#bd081c', panel: '#fffaf7', border: '#e5c8c2', serif: true });
    fillCanvas(ctx, '#f8d9d0');
    ctx.fillStyle = '#bd081c'; ctx.beginPath(); ctx.arc(916, 126, 104, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.font = '700 72px Georgia, serif'; ctx.textAlign = 'center'; ctx.fillText('✓', 916, 151); ctx.textAlign = 'left';
    ctx.save(); ctx.translate(52, 31); ctx.rotate(-0.018); ctx.fillStyle = '#fffaf7'; ctx.fillRect(0, 0, 620, 238); ctx.restore();
  } else {
    Object.assign(style, { ink: '#242321', muted: '#6f6a63', accent: '#cc785c', panel: '#eee8dc', border: '#d6cdbf', serif: true });
    fillCanvas(ctx, '#f4efe6');
    ctx.fillStyle = '#cc785c'; ctx.fillRect(0, 0, 22, CARD_HEIGHT);
    ctx.strokeStyle = '#242321'; ctx.lineWidth = 4;
    for (let index = 0; index < 4; index += 1) { ctx.save(); ctx.translate(920, 130); ctx.rotate(index * Math.PI / 2); ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, 72); ctx.stroke(); ctx.restore(); }
  }
  return style;
}

function renderReceiptCanvas(receipt, noteLines, pageIndex, pageCount) {
  const canvas = document.createElement('canvas');
  canvas.width = CARD_WIDTH;
  canvas.height = CARD_HEIGHT;
  canvas.className = 'completion-receipt-canvas';
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', `任务完成回执${pageCount > 1 ? `第 ${pageIndex + 1} 页` : ''}`);
  const ctx = canvas.getContext('2d');
  const theme = resolveTheme(receipt.boxColor);
  const templateId = resolveTemplateId(receipt.templateId, `${receipt.sourceTaskId}:${receipt.completedAt}`);
  const style = drawReceiptArt(ctx, templateId, theme, pageIndex);
  if (templateId === 'paper-file') drawStamp(ctx, style.accent, '归 档', 900, 150);

  ctx.fillStyle = style.muted;
  ctx.font = '700 22px ui-monospace, "Microsoft YaHei", sans-serif';
  ctx.fillText(`TASKBOX / ${templateName(templateId).toUpperCase()}`, 76, 94);
  ctx.fillStyle = style.accent;
  ctx.font = '700 23px "Microsoft YaHei", sans-serif';
  ctx.fillText(`✓ ${receipt.boxName}`, 76, 154);

  const path = [receipt.mainlineName, receipt.branchName].filter(Boolean).join('  /  ');
  if (path) {
    ctx.fillStyle = style.muted;
    ctx.font = '500 24px "Microsoft YaHei", sans-serif';
    ctx.fillText(path.length > 36 ? `${path.slice(0, 36)}…` : path, 76, 199);
  }

  ctx.fillStyle = style.ink;
  ctx.font = `${style.serif ? '600' : '800'} 60px ${style.serif ? 'Georgia, "Songti SC", serif' : '"Microsoft YaHei", "PingFang SC", sans-serif'}`;
  const titleLines = clampCanvasLines(ctx, receipt.content, 810, 3);
  titleLines.forEach((line, index) => ctx.fillText(line, 76, 290 + index * 78));

  const panelY = 290 + titleLines.length * 78 + 34;
  const panelHeight = 700;
  ctx.fillStyle = style.panel;
  roundedRect(ctx, 64, panelY, 952, panelHeight, 36);
  ctx.fill();
  ctx.strokeStyle = style.border;
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.fillStyle = style.accent;
  ctx.font = '700 22px ui-monospace, "Microsoft YaHei", sans-serif';
  ctx.fillText(pageIndex ? `COMPLETION NOTES / CONTINUED ${pageIndex + 1}` : 'COMPLETION NOTES / 完成记录', 104, panelY + 66);
  ctx.fillStyle = receipt.note ? style.ink : style.muted;
  ctx.font = `500 35px ${style.serif ? 'Georgia, "Songti SC", serif' : '"Microsoft YaHei", "PingFang SC", sans-serif'}`;
  noteLines.forEach((line, index) => ctx.fillText(line, 104, panelY + 132 + index * 45));

  const footerY = 1288;
  ctx.fillStyle = style.muted;
  ctx.font = '500 24px ui-monospace, "Microsoft YaHei", sans-serif';
  ctx.fillText(formatCompletedAt(receipt.completedAt), 76, footerY);
  if (receipt.executionMode === 'ai') {
    ctx.fillStyle = style.accent;
    ctx.fillText('✦ AI 协作', 76, footerY + 42);
  }
  if (receipt.pointsAwarded > 0) {
    ctx.textAlign = 'right';
    ctx.fillStyle = style.accent;
    ctx.font = '700 38px "Microsoft YaHei", sans-serif';
    ctx.fillText(`+${receipt.pointsAwarded} 积分`, 1004, footerY + 8);
  }
  ctx.textAlign = 'right';
  ctx.fillStyle = style.muted;
  ctx.font = '500 20px ui-monospace, monospace';
  ctx.fillText(pageCount > 1 ? `${String(pageIndex + 1).padStart(2, '0')} / ${String(pageCount).padStart(2, '0')}` : '行动留痕 · 完成有据', 1004, 1372);
  ctx.textAlign = 'left';
  return canvas;
}

export function renderCompletionReceiptCanvases(receipt) {
  const measureCanvas = document.createElement('canvas');
  const measure = measureCanvas.getContext('2d');
  measure.font = '500 35px "Microsoft YaHei", "PingFang SC", sans-serif';
  const allLines = splitCanvasLines(measure, receipt.note, 872);
  const pages = [];
  for (let index = 0; index < allLines.length; index += NOTE_LINES_PER_PAGE) {
    pages.push(allLines.slice(index, index + NOTE_LINES_PER_PAGE));
  }
  return pages.map((lines, index) => renderReceiptCanvas(receipt, lines, index, pages.length));
}

function canvasBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('image_export_failed')), 'image/png', 1);
  });
}

function safeFileStem(value) {
  return cleanText(value).replace(/[\\/:*?"<>|]/g, '').slice(0, 42) || '任务完成回执';
}

async function receiptFiles(canvases, receipt) {
  const stem = safeFileStem(receipt.content);
  return Promise.all(canvases.map(async (canvas, index) => {
    const blob = await canvasBlob(canvas);
    const suffix = canvases.length > 1 ? `-${index + 1}` : '';
    return new File([blob], `${stem}${suffix}.png`, { type: 'image/png' });
  }));
}

function downloadFiles(files) {
  files.forEach((file, index) => {
    setTimeout(() => {
      const url = URL.createObjectURL(file);
      const link = document.createElement('a');
      link.href = url;
      link.download = file.name;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1200);
    }, index * 160);
  });
}

export function openCompletionReceiptSheet({
  task,
  box,
  mainline = null,
  branch = null,
  pointsAwarded = null,
  onPersist = null,
} = {}) {
  if (!task?.id || !box) return;
  const context = { box, mainline, branch, pointsAwarded };
  let receipt = getCompletionReceiptSnapshot(task, context);
  if (!task.completionReceipt || task.completionReceipt.templateId !== receipt.templateId) onPersist?.(receipt);
  const { root, close } = openSheet(`
    <div class="sheet-handle"></div>
    <div class="sheet-content completion-receipt-sheet">
      <div class="completion-receipt-heading">
        <div><p class="eyebrow">Completion Receipt</p><h3>完成回执</h3></div>
        <button type="button" class="completion-receipt-close" id="closeReceipt" aria-label="关闭完成回执">×</button>
      </div>
      <p class="sheet-lead">备注已按完成时状态存档；长内容会自动拆成多张图片。</p>
      <div class="completion-receipt-template-bar">
        <span><small>本次模板</small><strong id="receiptTemplateName"></strong></span>
        <button type="button" id="shuffleReceiptTemplate">换一款</button>
      </div>
      <div class="completion-receipt-preview" id="receiptPreview" aria-live="polite"></div>
      <div class="completion-receipt-actions">
        <button type="button" class="btn primary" id="shareReceipt">分享图片</button>
        <button type="button" class="btn" id="saveReceipt">保存图片</button>
      </div>
      <button type="button" class="completion-receipt-refresh" id="refreshReceipt">按最新任务内容重新生成</button>
    </div>
  `, { height: '94vh' });

  let canvases = [];
  const renderPreview = () => {
    canvases = renderCompletionReceiptCanvases(receipt);
    const preview = root.querySelector('#receiptPreview');
    preview.innerHTML = '';
    canvases.forEach((canvas) => preview.appendChild(canvas));
    root.querySelector('#receiptTemplateName').textContent = templateName(receipt.templateId);
  };
  renderPreview();

  root.querySelector('#closeReceipt').addEventListener('click', close);
  root.querySelector('#shuffleReceiptTemplate').addEventListener('click', () => {
    receipt = { ...receipt, version: CARD_VERSION, templateId: pickCompletionReceiptTemplate(receipt.templateId) };
    onPersist?.(receipt);
    renderPreview();
    showToast(`已换成「${templateName(receipt.templateId)}」`);
  });
  root.querySelector('#saveReceipt').addEventListener('click', async () => {
    try {
      const files = await receiptFiles(canvases, receipt);
      downloadFiles(files);
      showToast(files.length > 1 ? `已保存 ${files.length} 张完成回执` : '完成回执已保存');
    } catch {
      showToast('图片生成失败，请重试');
    }
  });
  root.querySelector('#shareReceipt').addEventListener('click', async () => {
    try {
      const files = await receiptFiles(canvases, receipt);
      if (navigator.share && (!navigator.canShare || navigator.canShare({ files }))) {
        await navigator.share({ title: '任务完成回执', text: receipt.content, files });
        return;
      }
      downloadFiles(files);
      showToast('当前浏览器已保存图片，可从相册分享');
    } catch (error) {
      if (error?.name !== 'AbortError') showToast('分享未完成，可先保存图片');
    }
  });
  root.querySelector('#refreshReceipt').addEventListener('click', () => {
    receipt = createCompletionReceiptSnapshot(task, { ...context, templateId: receipt.templateId });
    onPersist?.(receipt);
    renderPreview();
    showToast('已按最新备注更新回执');
  });
}
