import { getMainlines, getMilestones } from './db.js';

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function milestoneOptions(mainlineId, selectedId) {
  if (!mainlineId) return '<option value="">先选择主线</option>';
  const milestones = getMilestones(mainlineId);
  if (!milestones.length) return '<option value="">这条主线还没有里程碑</option>';
  return `<option value="">暂不绑定里程碑</option>${milestones.map((milestone) => `
    <option value="${milestone.id}" ${milestone.id === selectedId ? 'selected' : ''}>${milestone.status === 'completed' ? '✓ ' : ''}${escapeHtml(milestone.title)}</option>
  `).join('')}`;
}

export function renderMainlineTaskFields(task = {}) {
  const mainlines = getMainlines().filter((mainline) => mainline.status !== 'completed' || mainline.id === task.mainlineId);
  return `
    <div class="task-mainline-fields">
      <label>所属主线
        <select id="taskMainline" class="input">
          <option value="">无主线</option>
          ${mainlines.map((mainline) => `<option value="${mainline.id}" ${mainline.id === task.mainlineId ? 'selected' : ''}>${mainline.isWeeklyFocus ? '★ ' : ''}${escapeHtml(mainline.name)}</option>`).join('')}
        </select>
      </label>
      <label>阶段里程碑
        <select id="taskMilestone" class="input" ${task.mainlineId ? '' : 'disabled'}>
          ${milestoneOptions(task.mainlineId, task.milestoneId)}
        </select>
      </label>
    </div>
  `;
}

export function bindMainlineTaskFields(root) {
  const mainlineSelect = root.querySelector('#taskMainline');
  const milestoneSelect = root.querySelector('#taskMilestone');
  if (!mainlineSelect || !milestoneSelect) return { getValue: () => ({ mainlineId: null, milestoneId: null }) };

  const refreshMilestones = (selectedId = '') => {
    const mainlineId = mainlineSelect.value || null;
    milestoneSelect.disabled = !mainlineId;
    milestoneSelect.innerHTML = milestoneOptions(mainlineId, selectedId);
  };
  mainlineSelect.addEventListener('change', () => refreshMilestones(''));

  return {
    getValue: () => ({
      mainlineId: mainlineSelect.value || null,
      milestoneId: mainlineSelect.value ? (milestoneSelect.value || null) : null,
    }),
  };
}
