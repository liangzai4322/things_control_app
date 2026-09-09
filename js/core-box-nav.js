import { getBoxes } from './db.js';

const CORE_BOX_ROLES = [
  { key: 'important', label: '重要', match: (box) => box.color === 'important' || /^重要(?:盒|事项)?$/.test(box.name) },
  { key: 'misc', label: '待办', match: (box) => box.color === 'misc' || /^(?:待办|杂事)(?:盒)?$/.test(box.name) },
  { key: 'relax', label: '放松', match: (box) => box.color === 'relax' || /^放松(?:盒)?$/.test(box.name) },
  { key: 'ideas', label: '思路', match: (box) => /(?:思路|灵感|想法)(?:盒)?/.test(box.name) },
];

const BOX_NAV_COLORS = {
  important: '#e85d45',
  misc: '#2f6df6',
  relax: '#0f9b87',
  reward: '#d99716',
  punish: '#64748b',
  study: '#2f9d62',
  health: '#2580c3',
};

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function isIdeaBox(box) {
  return Boolean(box && CORE_BOX_ROLES[3].match(box));
}

export function getCoreBoxEntries(boxes = getBoxes()) {
  return CORE_BOX_ROLES.map((role) => ({ ...role, box: boxes.find(role.match) || null }));
}

export function renderCoreBoxNav({ currentBoxId = null } = {}) {
  const entries = getCoreBoxEntries().filter((entry) => entry.box && entry.box.id !== currentBoxId);
  if (!entries.length) return '';

  return `
    <nav class="core-box-nav" aria-label="核心盒快速入口">
      ${entries.map((entry) => `
        <a class="core-box-link ${entry.key}" href="#box/${encodeURIComponent(entry.box.id)}" title="进入${escapeHtml(entry.box.name)}">
          ${entry.label}
        </a>
      `).join('')}
    </nav>
  `;
}

export function renderAllBoxNav({ currentBoxId = null } = {}) {
  const boxes = getBoxes().filter((box) => box.id !== currentBoxId);
  if (!boxes.length) return '';

  return `
    <nav class="core-box-nav all-box-nav" aria-label="全部盒子快速入口">
      ${boxes.map((box) => {
        const color = BOX_NAV_COLORS[box.color] || '#6b7280';
        const label = String(box.name || '未命名').replace(/盒$/, '') || String(box.name || '盒子');
        return `
        <a class="core-box-link" href="#box/${encodeURIComponent(box.id)}" title="进入${escapeHtml(box.name)}" style="--core-color:${color}">
          <span aria-hidden="true">${escapeHtml(box.icon || '□')}</span>${escapeHtml(label)}
        </a>
      `;
      }).join('')}
    </nav>
  `;
}
