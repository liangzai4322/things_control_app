import { openSheet, showToast } from './app.js';
import { getTasksByBox, updateBox } from './db.js';
import {
  bindBoxTypeOptions,
  getBoxTypeDefinition,
  inferBoxType,
  renderBoxTypeOptions,
} from './box-types.js';

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function openBoxTypeChangeSheet(box, onDone = () => {}) {
  const currentType = inferBoxType(box);
  const currentDefinition = getBoxTypeDefinition(currentType);
  const items = getTasksByBox(box.id);
  const completedCount = items.filter((item) => item.isCompleted).length;
  const datedCount = items.filter((item) => item.scheduledAt || item.dueDate).length;
  const { root, close } = openSheet(`
    <div class="sheet-handle"></div>
    <div class="sheet-content box-type-change-sheet">
      <p class="eyebrow">Box Type</p>
      <h3>修改“${escapeHtml(box.name)}”的类型</h3>
      <p class="sheet-lead">类型决定内容如何创建和使用。切换只改变交互方式，原始字段和历史记录都会保留。</p>
      <div class="box-type-options">${renderBoxTypeOptions(currentType)}</div>
      <div class="box-type-impact" id="boxTypeImpact">
        <span>${currentDefinition.icon}</span>
        <div><strong>当前是${currentDefinition.label}</strong><small>盒内 ${items.length} 条内容${completedCount ? ` · ${completedCount} 条完成记录` : ''}${datedCount ? ` · ${datedCount} 条带日期` : ''}</small></div>
      </div>
      <div class="box-type-safety"><b>可逆修改</b><span>日期、积分、完成状态、链接和使用次数都不会被删除；切回原类型后会重新显示。</span></div>
      <div class="sheet-actions">
        <button class="btn" id="cancelBoxTypeBtn">取消</button>
        <button class="btn primary" id="confirmBoxTypeBtn" disabled>类型未改变</button>
      </div>
    </div>
  `, { height: '72vh' });

  const picker = bindBoxTypeOptions(root, currentType);
  const impact = root.querySelector('#boxTypeImpact');
  const confirmButton = root.querySelector('#confirmBoxTypeBtn');
  const refreshConfirmation = () => {
    const nextType = picker.getValue();
    const definition = getBoxTypeDefinition(nextType);
    const unchanged = nextType === currentType;
    confirmButton.disabled = unchanged;
    confirmButton.textContent = unchanged ? '类型未改变' : `确认改为${definition.label}`;
    impact.innerHTML = `
      <span>${definition.icon}</span>
      <div><strong>${unchanged ? '保持' : '将改为'}${definition.label}</strong><small>${escapeHtml(definition.description)}</small></div>
    `;
  };
  root.querySelectorAll('[data-box-type-option]').forEach((button) => button.addEventListener('click', refreshConfirmation));
  root.querySelector('#cancelBoxTypeBtn').addEventListener('click', close);
  confirmButton.addEventListener('click', () => {
    const nextType = picker.getValue();
    if (nextType === currentType) return;
    const updated = updateBox(box.id, { boxType: nextType });
    close();
    showToast(`已改为${getBoxTypeDefinition(nextType).label}，原数据已保留`);
    onDone(updated);
  });
}
