const EXECUTION_MODES = new Set(['self', 'ai', 'hybrid']);

const EXECUTION_LABELS = {
  self: '我来做',
  ai: '交给 AI',
  hybrid: '人机协作',
};

export function normalizeExecutionMode(value, fallback = 'self') {
  return EXECUTION_MODES.has(value) ? value : fallback;
}

export function getExecutionModeLabel(value) {
  return EXECUTION_LABELS[normalizeExecutionMode(value)] || EXECUTION_LABELS.self;
}

export function renderExecutionModeField(selected = 'self', name = 'task-execution') {
  const current = normalizeExecutionMode(selected);
  return `
    <fieldset class="execution-mode-field" data-execution-mode-field="${name}">
      <legend>执行方式</legend>
      <div class="execution-mode-options">
        ${[
          ['self', '我来做', '由自己直接完成'],
          ['ai', '交给 AI', 'Codex 等可独立处理'],
          ['hybrid', '人机协作', 'AI 先做，我来验收'],
        ].map(([value, label, hint]) => `
          <button type="button" data-execution-mode="${value}" class="${current === value ? 'active' : ''}">
            <strong>${label}</strong><small>${hint}</small>
          </button>
        `).join('')}
      </div>
    </fieldset>
  `;
}

export function bindExecutionModeField(root, name = 'task-execution', fallback = 'self') {
  const field = root.querySelector(`[data-execution-mode-field="${name}"]`);
  let value = normalizeExecutionMode(field?.querySelector('[data-execution-mode].active')?.dataset.executionMode, fallback);
  field?.querySelectorAll('[data-execution-mode]').forEach((button) => {
    button.addEventListener('click', () => {
      value = normalizeExecutionMode(button.dataset.executionMode, fallback);
      field.querySelectorAll('[data-execution-mode]').forEach((item) => item.classList.toggle('active', item === button));
    });
  });
  return { getValue: () => value };
}
