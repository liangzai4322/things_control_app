import { getBranches, getMainlines, getMilestones } from './db.js';

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function branchOptions(mainlineId, selectedId) {
  if (!mainlineId) return '<option value="">先选择主线</option>';
  const branches = getBranches(mainlineId).filter((branch) => !['completed', 'abandoned'].includes(branch.status) || branch.id === selectedId);
  if (!branches.length) return '<option value="">这条主线还没有支线</option>';
  return `<option value="">暂不绑定支线</option>${branches.map((branch) => `
    <option value="${branch.id}" ${branch.id === selectedId ? 'selected' : ''}>${escapeHtml(branch.icon)} ${escapeHtml(branch.name)}</option>
  `).join('')}`;
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
  const selectedBranch = task.branchId ? getBranches().find((branch) => branch.id === task.branchId) : null;
  const selectedMainlineId = selectedBranch?.mainlineId || task.mainlineId || null;
  const mainlines = getMainlines().filter((mainline) => mainline.status !== 'completed' || mainline.id === selectedMainlineId);
  return `
    <div class="task-mainline-fields">
      <label>所属主线
        <select id="taskMainline" class="input">
          <option value="">无主线</option>
          ${mainlines.map((mainline) => `<option value="${mainline.id}" ${mainline.id === selectedMainlineId ? 'selected' : ''}>${mainline.isWeeklyFocus ? '★ ' : ''}${escapeHtml(mainline.name)}</option>`).join('')}
        </select>
      </label>
      <label>所属支线
        <select id="taskBranch" class="input" ${selectedMainlineId ? '' : 'disabled'}>
          ${branchOptions(selectedMainlineId, task.branchId)}
        </select>
      </label>
      <label>阶段里程碑
        <select id="taskMilestone" class="input" ${selectedMainlineId ? '' : 'disabled'}>
          ${milestoneOptions(selectedMainlineId, task.milestoneId)}
        </select>
      </label>
    </div>
  `;
}

export function bindMainlineTaskFields(root) {
  const mainlineSelect = root.querySelector('#taskMainline');
  const branchSelect = root.querySelector('#taskBranch');
  const milestoneSelect = root.querySelector('#taskMilestone');
  if (!mainlineSelect || !branchSelect || !milestoneSelect) {
    return { getValue: () => ({ mainlineId: null, branchId: null, milestoneId: null }) };
  }

  const refreshRelations = (branchId = '', milestoneId = '') => {
    const mainlineId = mainlineSelect.value || null;
    branchSelect.disabled = !mainlineId;
    milestoneSelect.disabled = !mainlineId;
    branchSelect.innerHTML = branchOptions(mainlineId, branchId);
    milestoneSelect.innerHTML = milestoneOptions(mainlineId, milestoneId);
  };

  mainlineSelect.addEventListener('change', () => refreshRelations('', ''));
  branchSelect.addEventListener('change', () => {
    const branch = getBranches().find((item) => item.id === branchSelect.value);
    if (!branch || branch.mainlineId === mainlineSelect.value) return;
    mainlineSelect.value = branch.mainlineId;
    refreshRelations(branch.id, '');
  });

  return {
    getValue: () => ({
      mainlineId: mainlineSelect.value || null,
      branchId: mainlineSelect.value ? (branchSelect.value || null) : null,
      milestoneId: mainlineSelect.value ? (milestoneSelect.value || null) : null,
    }),
  };
}
