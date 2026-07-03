import { getTasksByBox, playSound } from './db.js';
import { openSheet } from './app.js';

const WHEEL_THEMES = {
  important: {
    glow: 'rgba(249, 115, 78, 0.34)',
    center: '#fff4ec',
    ring: '#ffd1be',
    shadow: 'rgba(249, 115, 78, 0.24)',
    slices: ['#f9734e', '#fb923c', '#fb7185', '#ea580c', '#ff7a59'],
  },
  relax: {
    glow: 'rgba(45, 212, 191, 0.3)',
    center: '#ecfffb',
    ring: '#b9f6ee',
    shadow: 'rgba(20, 184, 166, 0.22)',
    slices: ['#14b8a6', '#2dd4bf', '#4ade80', '#0d9488', '#34d399'],
  },
  reward: {
    glow: 'rgba(245, 158, 11, 0.32)',
    center: '#fff8e2',
    ring: '#ffe29b',
    shadow: 'rgba(251, 146, 60, 0.24)',
    slices: ['#f59e0b', '#fbbf24', '#fb923c', '#f97316', '#facc15'],
  },
  punish: {
    glow: 'rgba(71, 85, 105, 0.3)',
    center: '#f4f7fb',
    ring: '#d8e0ec',
    shadow: 'rgba(51, 65, 85, 0.24)',
    slices: ['#334155', '#475569', '#64748b', '#1e293b', '#0f172a'],
  },
  misc: {
    glow: 'rgba(59, 130, 246, 0.3)',
    center: '#eef5ff',
    ring: '#c7dcff',
    shadow: 'rgba(59, 130, 246, 0.22)',
    slices: ['#2563eb', '#3b82f6', '#0ea5e9', '#22c3dd', '#1d4ed8'],
  },
  study: {
    glow: 'rgba(34, 197, 94, 0.32)',
    center: '#efffed',
    ring: '#c2f4b8',
    shadow: 'rgba(34, 197, 94, 0.22)',
    slices: ['#22c55e', '#16a34a', '#65a30d', '#4ade80', '#15803d'],
  },
  health: {
    glow: 'rgba(14, 165, 233, 0.3)',
    center: '#edfaff',
    ring: '#b7ecff',
    shadow: 'rgba(14, 165, 233, 0.22)',
    slices: ['#0ea5e9', '#06b6d4', '#38bdf8', '#2563eb', '#0284c7'],
  },
};

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function clampProgress(value) {
  const num = Number(value) || 0;
  return Math.max(0, Math.min(100, num));
}

function getPriorityLabel(priority) {
  if (priority === 3) return 'P3 紧急';
  if (priority === 2) return 'P2 重要';
  if (priority === 1) return 'P1 常规';
  return '普通';
}

function getTheme(color) {
  return WHEEL_THEMES[color] || WHEEL_THEMES.important;
}

function getWeights(entries) {
  return entries.map((entry) => Math.max(1, Number(entry.weight) || 1));
}

function getSlices(entries, startAngle = 0) {
  const weights = getWeights(entries);
  const total = weights.reduce((sum, value) => sum + value, 0) || 1;
  let current = startAngle;
  return entries.map((entry, index) => {
    const sweep = (weights[index] / total) * Math.PI * 2;
    const slice = { entry, start: current, end: current + sweep, sweep };
    current += sweep;
    return slice;
  });
}

function pickByPointer(entries, angle) {
  const pointerAngle = -Math.PI / 2;
  const normalized = ((pointerAngle - angle) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
  const slices = getSlices(entries, 0);
  const hit = slices.find((slice) => normalized >= slice.start && normalized < slice.end);
  return entries.findIndex((entry) => entry.id === (hit?.entry?.id || entries[0]?.id));
}

function truncateLabel(value, maxChars) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= maxChars) return text;
  if (maxChars <= 2) return text.slice(0, maxChars);
  return `${text.slice(0, Math.max(1, maxChars - 3))}...`;
}

function splitLabel(value, charsPerLine, maxLines) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return [''];

  const lines = [];
  let remaining = text;
  while (remaining && lines.length < maxLines) {
    if (lines.length === maxLines - 1) {
      lines.push(truncateLabel(remaining, charsPerLine));
      break;
    }
    lines.push(remaining.slice(0, charsPerLine));
    remaining = remaining.slice(charsPerLine).trim();
  }
  return lines;
}

function compactSliceLabel(value, sweep, entryCount) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';

  if (entryCount <= 12) return text;

  const parts = text.split(/[·•|｜/:：-]/).map((part) => part.trim()).filter(Boolean);
  const compact = parts.length > 1 ? parts[parts.length - 1] : text;

  if (entryCount > 28 || sweep < 0.16) return truncateLabel(compact, 2) || truncateLabel(text, 2);
  if (entryCount > 20 || sweep < 0.2) return truncateLabel(compact, 4) || truncateLabel(text, 4);
  if (entryCount > 14) return truncateLabel(compact, 6) || truncateLabel(text, 6);
  return text;
}

function renderWheelResult(root, {
  eyebrow = '准备就绪',
  title = '等待抽取',
  description = '点击开始，让转盘随机落到其中一项。',
  chips = [],
} = {}) {
  const result = root.querySelector('#wheelResult');
  result.innerHTML = `
    <section class="wheel-result-shell">
      <p class="eyebrow">${escapeHtml(eyebrow)}</p>
      <h4>${escapeHtml(title)}</h4>
      <p class="wheel-result-note">${escapeHtml(description)}</p>
      ${chips.length ? `<div class="wheel-meta-row">${chips.map((chip) => `<span class="wheel-pill">${escapeHtml(chip)}</span>`).join('')}</div>` : ''}
    </section>
  `;

  const card = result.querySelector('.wheel-result-shell');
  requestAnimationFrame(() => card?.classList.add('show'));
}

function drawSliceLabel(ctx, label, radius, sweep, entryCount) {
  const minSweep = entryCount > 28 ? 0.1 : entryCount > 20 ? 0.12 : entryCount > 14 ? 0.15 : 0.12;
  if (sweep < minSweep) return;

  const displayLabel = compactSliceLabel(label, sweep, entryCount);
  if (!displayLabel) return;

  const isDenseWheel = entryCount > 20 || sweep < 0.2;
  const charsPerLine = isDenseWheel ? (sweep > 0.22 ? 4 : 2) : (sweep > 0.46 ? 8 : sweep > 0.3 ? 6 : 4);
  const lines = splitLabel(displayLabel, charsPerLine, isDenseWheel ? 1 : (sweep > 0.44 ? 2 : 1));
  const fontSize = entryCount > 28 ? 8 : entryCount > 20 ? 9 : Math.max(10, Math.min(15, 17 - entryCount / 3));
  const lineHeight = fontSize + 2;
  const startY = -((lines.length - 1) * lineHeight) / 2;
  const textRadius = isDenseWheel ? radius - 16 : radius - 22;

  ctx.fillStyle = 'rgba(255, 255, 255, 0.96)';
  ctx.font = `700 ${fontSize}px "Avenir Next", "PingFang SC", sans-serif`;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = 'rgba(15, 23, 42, 0.18)';
  ctx.shadowBlur = 8;

  lines.forEach((line, index) => {
    ctx.fillText(line, textRadius, startY + index * lineHeight);
  });

  ctx.shadowBlur = 0;
}

function drawWheel(ctx, size, entries, angle, theme, getText, highlightedIndex = -1) {
  ctx.clearRect(0, 0, size, size);

  const cx = size / 2;
  const cy = size / 2;
  const outerRadius = size / 2 - 10;
  const wheelRadius = outerRadius - 14;

  const halo = ctx.createRadialGradient(cx, cy, wheelRadius * 0.55, cx, cy, outerRadius + 24);
  halo.addColorStop(0, 'rgba(255, 255, 255, 0.08)');
  halo.addColorStop(0.7, theme.glow);
  halo.addColorStop(1, 'rgba(255, 255, 255, 0)');
  ctx.fillStyle = halo;
  ctx.beginPath();
  ctx.arc(cx, cy, outerRadius + 24, 0, Math.PI * 2);
  ctx.fill();

  ctx.save();
  ctx.shadowColor = theme.shadow;
  ctx.shadowBlur = 28;
  ctx.fillStyle = 'rgba(15, 23, 42, 0.12)';
  ctx.beginPath();
  ctx.arc(cx, cy, outerRadius, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
  ctx.beginPath();
  ctx.arc(cx, cy, outerRadius, 0, Math.PI * 2);
  ctx.fill();

  ctx.save();
  ctx.translate(cx, cy);

  if (!entries.length) {
    ctx.fillStyle = 'rgba(148, 163, 184, 0.16)';
    ctx.beginPath();
    ctx.arc(0, 0, wheelRadius, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = theme.ring;
    ctx.lineWidth = 10;
    ctx.beginPath();
    ctx.arc(0, 0, wheelRadius + 5, 0, Math.PI * 2);
    ctx.stroke();

    ctx.fillStyle = '#64748b';
    ctx.font = '700 18px "Avenir Next", "PingFang SC", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('空空如也', 0, -8);
    ctx.font = '13px "Avenir Next", "PingFang SC", sans-serif';
    ctx.fillText('先添加内容再来抽取', 0, 16);
    ctx.restore();
    return;
  }

  const slices = getSlices(entries, angle);

  slices.forEach((slice, index) => {
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, wheelRadius, slice.start, slice.end);
    ctx.closePath();
    ctx.fillStyle = theme.slices[index % theme.slices.length];
    ctx.fill();

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.26)';
    ctx.lineWidth = 1.6;
    ctx.stroke();

    const mid = (slice.start + slice.end) / 2;
    ctx.save();
    ctx.rotate(mid);
    drawSliceLabel(ctx, getText(slice.entry), wheelRadius, slice.sweep, entries.length);
    ctx.restore();
  });

  if (highlightedIndex >= 0 && slices[highlightedIndex]) {
    const hit = slices[highlightedIndex];
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, wheelRadius, hit.start, hit.end);
    ctx.closePath();
    ctx.fillStyle = 'rgba(255, 255, 255, 0.14)';
    ctx.fill();
  }

  ctx.strokeStyle = theme.ring;
  ctx.lineWidth = 12;
  ctx.beginPath();
  ctx.arc(0, 0, wheelRadius + 5, 0, Math.PI * 2);
  ctx.stroke();

  for (let index = 0; index < 24; index += 1) {
    const tickAngle = (index / 24) * Math.PI * 2;
    const start = wheelRadius + 10;
    const end = wheelRadius + (index % 2 === 0 ? 18 : 14);
    ctx.strokeStyle = index % 2 === 0 ? 'rgba(255,255,255,0.92)' : theme.ring;
    ctx.lineWidth = index % 2 === 0 ? 2.4 : 1.4;
    ctx.beginPath();
    ctx.moveTo(Math.cos(tickAngle) * start, Math.sin(tickAngle) * start);
    ctx.lineTo(Math.cos(tickAngle) * end, Math.sin(tickAngle) * end);
    ctx.stroke();
  }

  const hubGradient = ctx.createRadialGradient(0, 0, 6, 0, 0, 42);
  hubGradient.addColorStop(0, '#ffffff');
  hubGradient.addColorStop(1, theme.center);
  ctx.fillStyle = hubGradient;
  ctx.beginPath();
  ctx.arc(0, 0, 42, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = theme.ring;
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.arc(0, 0, 42, 0, Math.PI * 2);
  ctx.stroke();

  ctx.fillStyle = '#1f2937';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '800 18px "Avenir Next", "PingFang SC", sans-serif';
  ctx.fillText('抽', 0, -6);
  ctx.font = '12px "Avenir Next", "PingFang SC", sans-serif';
  ctx.fillText(`${entries.length} 项`, 0, 14);

  ctx.restore();
}

export function openLuckyWheel(box) {
  const pendingTasks = getTasksByBox(box.id).filter((task) => !task.isCompleted);
  return openWeightedWheel({
    title: `${box.name} · 随机抽取`,
    entries: pendingTasks,
    color: box.color,
    getText: (task) => task.content,
    onPicked: (root, task, helpers) => {
      const chips = [
        getPriorityLabel(task.priority ?? 0),
        `进度 ${clampProgress(task.progress)}%`,
        `权重 ${Math.max(1, Number(task.weight) || 1)}`,
      ];
      helpers.renderResult({
        eyebrow: '任务结果',
        title: task.content,
        description: task.note?.trim() || '下一步已经替你选出来了，现在去执行它。',
        chips,
      });
    },
  });
}

export function openWeightedWheel({
  title = '随机抽取',
  entries = [],
  color = 'important',
  getText = (item) => item.content || item.name || '',
  onPicked,
} = {}) {
  const weighted = entries.some((entry) => Math.max(1, Number(entry.weight) || 1) > 1);
  const theme = getTheme(color);
  const resolveEntryText = (entry) => {
    const primary = String(getText?.(entry) || '').trim();
    if (primary) return primary;
    return String(entry?.content || entry?.name || entry?.title || entry?.label || entry?.id || '未命名内容').trim();
  };
  const { root } = openSheet(`
    <div class="sheet-handle"></div>
    <div class="sheet-content wheel wheel-sheet">
      <p class="eyebrow">随机转盘</p>
      <h3>${escapeHtml(title)}</h3>
      <p class="wheel-subtitle">${entries.length ? `共 ${entries.length} 项候选${weighted ? '，包含权重加成。' : '，默认等权重随机。'}` : '当前没有可抽取内容。'}</p>
      <div class="wheel-meta-row">
        <span class="wheel-pill">${entries.length} 个候选</span>
        <span class="wheel-pill">${weighted ? '权重模式' : '均匀随机'}</span>
      </div>
      <div class="wheel-stage wheel-theme-${color}">
        <div class="wheel-wrap">
          <div class="wheel-pointer-shell">
            <div class="wheel-arrow">▼</div>
          </div>
          <canvas id="wheelCanvas"></canvas>
        </div>
      </div>
      <div class="wheel-actions">
        <button id="spinBtn" class="btn primary ${color}" ${entries.length ? '' : 'disabled'}>开始抽取</button>
      </div>
      <div id="wheelResult" class="result-card wheel-result-card"></div>
    </div>
  `, { height: '86vh' });

  const canvas = root.querySelector('#wheelCanvas');
  const ctx = canvas.getContext('2d');
  const size = Math.min(window.innerWidth * 0.82, 360);
  const dpr = window.devicePixelRatio || 1;
  canvas.width = size * dpr;
  canvas.height = size * dpr;
  canvas.style.width = `${size}px`;
  canvas.style.height = `${size}px`;
  ctx.scale(dpr, dpr);

  let angle = 0;
  let spinning = false;
  let highlightedIndex = -1;

  const draw = () => drawWheel(ctx, size, entries, angle, theme, resolveEntryText, highlightedIndex);

  const helpers = {
    renderResult: (options) => renderWheelResult(root, options),
  };

  renderWheelResult(root, entries.length ? {
    eyebrow: '准备就绪',
    title: '等待这一次落点',
    description: '点击开始，让转盘在这些候选项里随机选出一个。',
    chips: [weighted ? '已启用权重' : '默认等权重'],
  } : {
    eyebrow: '暂无内容',
    title: '当前没有可抽取内容',
    description: '先添加内容，再回来让转盘替你做选择。',
  });

  draw();

  root.querySelector('#spinBtn').addEventListener('click', () => {
    if (spinning || !entries.length) return;

    spinning = true;
    highlightedIndex = -1;
    const spinButton = root.querySelector('#spinBtn');
    spinButton.disabled = true;
    spinButton.textContent = '抽取中...';

    renderWheelResult(root, {
      eyebrow: '正在抽取',
      title: '命运正在转动',
      description: '结果马上出现，先别急着眨眼。',
      chips: [`候选 ${entries.length} 项`],
    });

    const duration = 3200 + Math.random() * 1800;
    const start = performance.now();
    const baseAngle = angle;
    const target = angle + Math.PI * 10 + Math.random() * Math.PI * 2;

    const tick = (now) => {
      const progress = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      angle = baseAngle + (target - baseAngle) * eased;
      draw();

      if (progress < 1) {
        requestAnimationFrame(tick);
        return;
      }

      const finalSector = pickByPointer(entries, angle);
      playSound('wheel-stop');
      const safeIndex = Number.isInteger(finalSector) && finalSector >= 0 && finalSector < entries.length ? finalSector : 0;
      highlightedIndex = safeIndex;
      draw();

      const picked = entries[safeIndex];
      try {
        if (onPicked) {
          onPicked(root, picked, helpers);
        } else {
          helpers.renderResult({
            eyebrow: '抽取结果',
            title: resolveEntryText(picked),
            description: '这次的随机结果已经落定，可以直接执行它。',
          });
        }
      } catch {
        helpers.renderResult({
          eyebrow: '抽取结果',
          title: resolveEntryText(picked) || '结果加载失败',
          description: '抽取已经完成，但结果渲染失败，请重试。',
        });
      } finally {
        spinning = false;
        spinButton.disabled = false;
        spinButton.textContent = '再抽一次';
      }
    };

    requestAnimationFrame(tick);
  });
}
