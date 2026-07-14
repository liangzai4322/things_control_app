import { fromDateTimeLocalValue, getSchedulePresetValue, toDateTimeLocalValue } from './task-utils.js';
import { getRecurrenceLabel, getWeekdayLabels, normalizeRecurrenceRule } from './recurrence.js';

const TYPE_OPTIONS = [
  { value: 'none', label: '不重复' },
  { value: 'daily', label: '每天' },
  { value: 'interval', label: '每隔 N 天' },
  { value: 'weekly', label: '每周' },
  { value: 'monthly', label: '每月' },
];

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

export function renderRecurrenceEditor(prefix, initialRule = null) {
  const type = initialRule?.type || 'none';
  const weekdays = getWeekdayLabels();
  return `
    <section class="recurrence-editor" data-recurrence-editor="${escapeHtml(prefix)}" data-initial-type="${escapeHtml(type)}">
      <div class="recurrence-editor-head">
        <div><strong>重复</strong><small>每一期都会留下独立完成记录</small></div>
        <span class="recurrence-summary" data-recurrence-summary>不重复</span>
      </div>
      <div class="recurrence-type-grid">
        ${TYPE_OPTIONS.map((option) => `
          <button type="button" data-recurrence-type="${option.value}" class="${type === option.value ? 'active' : ''}">${option.label}</button>
        `).join('')}
      </div>
      <div class="recurrence-options ${type === 'none' ? 'is-hidden' : ''}" data-recurrence-options>
        <label class="recurrence-field interval-field">
          <span>间隔天数</span>
          <input class="input compact-input" type="number" min="1" max="365" value="${Number(initialRule?.interval) || 2}" data-recurrence-interval>
        </label>
        <label class="recurrence-field weekly-field">
          <span>每周哪一天</span>
          <select class="input" data-recurrence-weekday>
            ${weekdays.map((label, index) => `<option value="${index}" ${Number(initialRule?.weekday) === index ? 'selected' : ''}>${label}</option>`).join('')}
          </select>
        </label>
        <label class="recurrence-field monthly-field">
          <span>每月哪一天</span>
          <select class="input" data-recurrence-monthday>
            <option value="last" ${initialRule?.monthDay === 'last' ? 'selected' : ''}>每月最后一天</option>
            ${Array.from({ length: 31 }, (_, index) => index + 1).map((day) => `<option value="${day}" ${Number(initialRule?.monthDay) === day ? 'selected' : ''}>每月 ${day} 日</option>`).join('')}
          </select>
        </label>
        <label class="recurrence-field interval-field">
          <span>下次从哪里计算</span>
          <select class="input" data-recurrence-mode>
            <option value="completion" ${initialRule?.mode !== 'calendar' ? 'selected' : ''}>完成后再间隔</option>
            <option value="calendar" ${initialRule?.mode === 'calendar' ? 'selected' : ''}>按固定日历</option>
          </select>
        </label>
        <label class="recurrence-field">
          <span>遗漏后怎么处理</span>
          <select class="input" data-recurrence-miss-policy>
            <option value="carry" ${initialRule?.missPolicy !== 'skip' ? 'selected' : ''}>保留未完成任务</option>
            <option value="skip" ${initialRule?.missPolicy === 'skip' ? 'selected' : ''}>到下一期自动跳过</option>
          </select>
        </label>
        <p class="recurrence-help" data-recurrence-help></p>
      </div>
    </section>
  `;
}

export function bindRecurrenceEditor(root, { prefix, scheduledInput, initialRule = null }) {
  const editor = root.querySelector(`[data-recurrence-editor="${prefix}"]`);
  if (!editor) return { getValue: () => null };
  let type = editor.dataset.initialType || 'none';
  const options = editor.querySelector('[data-recurrence-options]');
  const summary = editor.querySelector('[data-recurrence-summary]');
  const help = editor.querySelector('[data-recurrence-help]');
  const missPolicyInput = editor.querySelector('[data-recurrence-miss-policy]');
  let missPolicyTouched = Boolean(initialRule?.missPolicy);

  const readRawRule = () => ({
    type,
    interval: Number(editor.querySelector('[data-recurrence-interval]').value) || 2,
    mode: editor.querySelector('[data-recurrence-mode]').value,
    weekday: Number(editor.querySelector('[data-recurrence-weekday]').value),
    monthDay: editor.querySelector('[data-recurrence-monthday]').value,
    missPolicy: editor.querySelector('[data-recurrence-miss-policy]').value,
  });

  const update = () => {
    const active = type !== 'none';
    options.classList.toggle('is-hidden', !active);
    editor.querySelectorAll('[data-recurrence-type]').forEach((button) => {
      button.classList.toggle('active', button.dataset.recurrenceType === type);
    });
    editor.querySelectorAll('.interval-field').forEach((field) => field.classList.toggle('is-hidden', type !== 'interval'));
    editor.querySelectorAll('.weekly-field').forEach((field) => field.classList.toggle('is-hidden', type !== 'weekly'));
    editor.querySelectorAll('.monthly-field').forEach((field) => field.classList.toggle('is-hidden', type !== 'monthly'));
    if (!active) {
      summary.textContent = '不重复';
      return;
    }
    if (!scheduledInput.value) scheduledInput.value = toDateTimeLocalValue(getSchedulePresetValue('today'));
    const scheduledAt = fromDateTimeLocalValue(scheduledInput.value);
    const rule = normalizeRecurrenceRule(readRawRule(), scheduledAt);
    summary.textContent = getRecurrenceLabel(rule);
    help.textContent = rule.missPolicy === 'skip'
      ? '上一期未完成时，到下一期会自动跳过，不堆积。'
      : '未完成时继续保留；完成或跳过后才会出现下一期。';
  };

  editor.querySelectorAll('[data-recurrence-type]').forEach((button) => {
    button.addEventListener('click', () => {
      type = button.dataset.recurrenceType;
      if (!missPolicyTouched) missPolicyInput.value = type === 'daily' ? 'skip' : 'carry';
      update();
    });
  });
  missPolicyInput.addEventListener('input', () => {
    missPolicyTouched = true;
  });
  editor.querySelectorAll('input, select').forEach((input) => input.addEventListener('input', update));
  scheduledInput.addEventListener('input', update);
  update();

  return {
    getValue() {
      if (type === 'none') return null;
      return readRawRule();
    },
  };
}
