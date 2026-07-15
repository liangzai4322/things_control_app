import { getBoxes } from './db.js';

const CORE_BOX_ROLES = [
  { key: 'important', label: '重要', match: (box) => box.color === 'important' || /^重要(?:盒|事项)?$/.test(box.name) },
  { key: 'misc', label: '待办', match: (box) => box.color === 'misc' || /^(?:待办|杂事)(?:盒)?$/.test(box.name) },
  { key: 'relax', label: '放松', match: (box) => box.color === 'relax' || /^放松(?:盒)?$/.test(box.name) },
  { key: 'ideas', label: '思路', match: (box) => /(?:思路|灵感|想法)(?:盒)?/.test(box.name) },
];

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
