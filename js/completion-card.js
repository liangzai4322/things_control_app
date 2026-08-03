import { openSheet, showToast } from './app.js';

const CARD_WIDTH = 1080;
const CARD_HEIGHT = 1440;
const NOTE_LINES_PER_PAGE = 13;
const CARD_VERSION = 1;

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

export function createCompletionReceiptSnapshot(task, {
  box = null,
  mainline = null,
  branch = null,
  pointsAwarded = null,
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

function drawBackground(ctx, theme, pageIndex) {
  const gradient = ctx.createLinearGradient(0, 0, CARD_WIDTH, CARD_HEIGHT);
  gradient.addColorStop(0, theme.start);
  gradient.addColorStop(0.58, theme.end);
  gradient.addColorStop(1, '#172138');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT);

  const glow = ctx.createRadialGradient(880, 120, 10, 880, 120, 440);
  glow.addColorStop(0, `${theme.glow}c2`);
  glow.addColorStop(1, `${theme.glow}00`);
  ctx.fillStyle = glow;
  ctx.fillRect(420, 0, 660, 620);

  ctx.save();
  ctx.globalAlpha = 0.09;
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1;
  const offset = pageIndex * 13;
  for (let x = -CARD_HEIGHT + offset; x < CARD_WIDTH + CARD_HEIGHT; x += 72) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x + CARD_HEIGHT, CARD_HEIGHT);
    ctx.stroke();
  }
  ctx.restore();

  const vignette = ctx.createLinearGradient(0, 0, 0, CARD_HEIGHT);
  vignette.addColorStop(0, 'rgba(4, 12, 25, 0.02)');
  vignette.addColorStop(1, 'rgba(4, 12, 25, 0.46)');
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT);
}

function drawStamp(ctx, theme) {
  ctx.save();
  ctx.translate(892, 155);
  ctx.rotate(-0.1);
  ctx.strokeStyle = theme.accent;
  ctx.fillStyle = theme.accent;
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
  ctx.fillText('结 案', 0, 3);
  ctx.font = '700 19px ui-monospace, monospace';
  ctx.fillText('DONE', 0, 32);
  ctx.restore();
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
  drawBackground(ctx, theme, pageIndex);
  drawStamp(ctx, theme);

  ctx.fillStyle = 'rgba(255,255,255,.72)';
  ctx.font = '700 22px ui-monospace, "Microsoft YaHei", sans-serif';
  ctx.fillText('TASKBOX / COMPLETION RECEIPT', 76, 94);
  ctx.fillStyle = theme.accent;
  ctx.font = '700 23px "Microsoft YaHei", sans-serif';
  ctx.fillText(`✓ ${receipt.boxName}`, 76, 154);

  const path = [receipt.mainlineName, receipt.branchName].filter(Boolean).join('  /  ');
  if (path) {
    ctx.fillStyle = 'rgba(255,255,255,.74)';
    ctx.font = '500 24px "Microsoft YaHei", sans-serif';
    ctx.fillText(path.length > 36 ? `${path.slice(0, 36)}…` : path, 76, 199);
  }

  ctx.fillStyle = '#ffffff';
  ctx.font = '700 60px "Microsoft YaHei", "PingFang SC", sans-serif';
  const titleLines = clampCanvasLines(ctx, receipt.content, 810, 3);
  titleLines.forEach((line, index) => ctx.fillText(line, 76, 290 + index * 78));

  const panelY = 290 + titleLines.length * 78 + 34;
  const panelHeight = 700;
  ctx.fillStyle = 'rgba(255,255,255,.105)';
  roundedRect(ctx, 64, panelY, 952, panelHeight, 36);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,.22)';
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.fillStyle = theme.accent;
  ctx.font = '700 22px ui-monospace, "Microsoft YaHei", sans-serif';
  ctx.fillText(pageIndex ? `COMPLETION NOTES / CONTINUED ${pageIndex + 1}` : 'COMPLETION NOTES / 完成记录', 104, panelY + 66);
  ctx.fillStyle = receipt.note ? '#ffffff' : 'rgba(255,255,255,.56)';
  ctx.font = '500 35px "Microsoft YaHei", "PingFang SC", sans-serif';
  noteLines.forEach((line, index) => ctx.fillText(line, 104, panelY + 132 + index * 45));

  const footerY = 1288;
  ctx.fillStyle = 'rgba(255,255,255,.68)';
  ctx.font = '500 24px ui-monospace, "Microsoft YaHei", sans-serif';
  ctx.fillText(formatCompletedAt(receipt.completedAt), 76, footerY);
  if (receipt.executionMode === 'ai') {
    ctx.fillStyle = theme.accent;
    ctx.fillText('✦ AI 协作', 76, footerY + 42);
  }
  if (receipt.pointsAwarded > 0) {
    ctx.textAlign = 'right';
    ctx.fillStyle = theme.accent;
    ctx.font = '700 38px "Microsoft YaHei", sans-serif';
    ctx.fillText(`+${receipt.pointsAwarded} 积分`, 1004, footerY + 8);
  }
  ctx.textAlign = 'right';
  ctx.fillStyle = 'rgba(255,255,255,.48)';
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
  if (!task.completionReceipt) onPersist?.(receipt);
  const { root, close } = openSheet(`
    <div class="sheet-handle"></div>
    <div class="sheet-content completion-receipt-sheet">
      <div class="completion-receipt-heading">
        <div><p class="eyebrow">Completion Receipt</p><h3>完成回执</h3></div>
        <button type="button" class="completion-receipt-close" id="closeReceipt" aria-label="关闭完成回执">×</button>
      </div>
      <p class="sheet-lead">备注已按完成时状态存档；长内容会自动拆成多张图片。</p>
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
  };
  renderPreview();

  root.querySelector('#closeReceipt').addEventListener('click', close);
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
    receipt = createCompletionReceiptSnapshot(task, context);
    onPersist?.(receipt);
    renderPreview();
    showToast('已按最新备注更新回执');
  });
}
