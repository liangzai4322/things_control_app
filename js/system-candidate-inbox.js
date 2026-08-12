import { requestTaskboxApi } from './db.js';
import { showToast } from './app.js';

const esc = (v = '') => String(v).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
export async function mountSystemCandidateInbox(app, systemId, beforeSelector) {
  const host = document.createElement('section'); host.className = 'system-daily-candidates'; host.dataset.systemCandidateInbox = systemId;
  host.innerHTML = '<header><div><span>DAILY REVIEW INBOX</span><h2>日省候选收件箱</h2></div><p>正在读取……</p></header>';
  const before = app.querySelector(beforeSelector); if (before) before.before(host); else app.querySelector('main')?.append(host);
  try {
    const result = await requestTaskboxApi(`/system-candidates?systemId=${encodeURIComponent(systemId)}&limit=100`);
    if (!result) { host.innerHTML = '<header><div><span>DAILY REVIEW INBOX</span><h2>日省候选收件箱</h2></div><p>API未连接</p></header><div class="system-candidate-empty">不影响系统独立运行。</div>'; return; }
    const items = result.items || []; const pending = items.filter((x) => x.status === 'pending').length;
    host.innerHTML = `<header><div><span>DAILY REVIEW INBOX · READ ONLY</span><h2>日省候选收件箱</h2></div><p>${pending} 待处理 · ${items.length} 全部</p></header><p class="system-candidate-rule">只读候选。保留或忽略不会修改系统事实、任务、实验、规则或已发布版本。</p><div>${items.length ? items.map((x) => `<article data-system-candidate="${esc(x.candidateId)}"><div><span>${esc(x.reviewDate)} · ${esc(x.kind)} · ${esc(x.authority)}</span><strong>${esc(x.statement)}</strong><small>${esc((x.evidenceRefs || []).join(' · ') || '无证据引用')} · ${esc(x.epistemicState)}</small></div><aside><em>${x.status === 'pending' ? '待处理' : x.status === 'kept' ? '保留观察' : '已忽略'}</em>${x.status === 'pending' ? '<button data-candidate-status="kept">保留观察</button><button data-candidate-status="dismissed">忽略</button>' : ''}</aside></article>`).join('') : '<div class="system-candidate-empty">当前没有日省候选。</div>'}</div>`;
    host.onclick = async (event) => { const button = event.target.closest('[data-candidate-status]'); if (!button) return; const card = button.closest('[data-system-candidate]'); try { await requestTaskboxApi(`/system-candidates/${encodeURIComponent(card.dataset.systemCandidate)}`, { method: 'PATCH', body: JSON.stringify({ status: button.dataset.candidateStatus }) }); showToast('候选状态已保存；系统事实未改变'); host.remove(); await mountSystemCandidateInbox(app, systemId, beforeSelector); } catch { showToast('候选同步失败，请稍后重试'); } };
  } catch { host.innerHTML = '<header><div><span>DAILY REVIEW INBOX</span><h2>日省候选收件箱</h2></div><p>读取失败</p></header><div class="system-candidate-empty">系统主体仍可独立使用。</div>'; }
}
