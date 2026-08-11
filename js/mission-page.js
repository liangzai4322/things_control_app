import { getMainlines, getTasks } from './db.js';
import { navigate, showToast } from './app.js';
import { MISSION_CANDIDATE_DECISIONS, MISSION_PORTFOLIO_CLASSES, activeMissionSnapshot, decideMissionCandidate, deriveMissionEvidence, importMissionCandidates, normalizeMissionDraft, publishMissionVersion, updateMissionReviewContext } from './mission-model.js';
import { readMissionStore, writeMissionStore } from './mission-store.js';
import { readTimeStore } from './time-attention-store.js';
import { parseMissionV2Text } from './mission-v2-adapter.js';

const esc = (v = '') => String(v).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const text = (v = []) => Array.isArray(v) ? v.join('\n') : '';
const eventLabels = { MissionVersionActivated: '版本激活', CampaignActivated: '战役激活', StrategicPriorityChanged: '优先级变更', PortfolioItemReclassified: '项目重分类' };
const candidateDecisionLabels = { unreviewed: '待裁决', ignored: '已忽略', observing: '保留观察', included_in_draft: '已纳入草稿证据' };

function readDailyReviews(storage = localStorage) {
  try {
    const cache = JSON.parse(storage.getItem('taskbox_hq_cache_v1') || '{}');
    return Object.entries(cache.byReviewDate || {}).filter(([, value]) => value?.brief?.source === 'daily_review' || value?.review).map(([reviewDate, value]) => ({ reviewDate, todayEvidence: value.review?.todayEvidence || null }));
  } catch { return []; }
}

function missionDailyReviews(tasks) {
  const cached = readDailyReviews();
  const taskDates = tasks.filter((task) => task.commitmentSource === 'daily_review' && /^\d{4}-\d{2}-\d{2}$/.test(task.commitmentDate || '')).map((task) => ({ reviewDate: task.commitmentDate, todayEvidence: null }));
  return [...new Map([...cached, ...taskDates].map((item) => [item.reviewDate, item])).values()];
}

function rows(mainlines, draft) {
  if (!mainlines.length) return '<div class="mission-empty">盒子里还没有主线。先建立主线，再编入战略组合。</div>';
  return mainlines.map((line) => {
    const item = draft.portfolio[line.id] || { class: 'waiting', resourceShare: 0, strategicContribution: '', replacementTarget: '' };
    return `<article class="mission-portfolio-row" data-line="${esc(line.id)}"><div><strong>${esc(line.name)}</strong><small>${esc(line.currentPhase || line.outcome || '尚未说明阶段')}</small><code>${esc(item.itemId || `portfolio:${line.id}`)}</code></div><label>角色<select class="input" data-field="class">${Object.entries(MISSION_PORTFOLIO_CLASSES).map(([v, l]) => `<option value="${v}" ${item.class === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label><label>资源 %<input class="input" data-field="share" type="number" min="0" max="100" value="${item.resourceShare}"></label><label class="mission-contribution">战略贡献<input class="input" data-field="contribution" value="${esc(item.strategicContribution)}" placeholder="如何推动当前战役"></label><label class="mission-replacement">替换什么<input class="input" data-field="replacement" value="${esc(item.replacementTarget || '')}" placeholder="新投入的机会成本"></label></article>`;
  }).join('');
}

function readDraft(root, previous) {
  const portfolio = {};
  root.querySelectorAll('[data-line]').forEach((row) => {
    const mainlineId = row.dataset.line;
    portfolio[mainlineId] = { itemId: previous.portfolio[mainlineId]?.itemId, class: row.querySelector('[data-field=class]').value, resourceShare: row.querySelector('[data-field=share]').value, strategicContribution: row.querySelector('[data-field=contribution]').value, replacementTarget: row.querySelector('[data-field=replacement]').value };
  });
  return normalizeMissionDraft({ missionId: previous.missionId, statement: root.querySelector('#missionStatement').value, constraints: root.querySelector('#missionConstraints').value, nonNegotiables: root.querySelector('#missionNonNegotiables').value, notDoing: root.querySelector('#missionNotDoing').value, campaign: { campaignId: previous.campaign.campaignId, title: root.querySelector('#missionCampaign').value, whyNow: root.querySelector('#missionWhyNow').value, successConditions: root.querySelector('#missionSuccess').value, exitConditions: root.querySelector('#missionExit').value, reviewAt: root.querySelector('#missionReviewAt').value }, portfolio });
}

function readReviewContext(root) {
  return {
    triggerDecision: root.querySelector('#missionTriggerDecision')?.value || '',
    externalEvidenceRefs: root.querySelector('#missionExternalEvidence')?.value || '',
    judgmentChanges: {
      retained: root.querySelector('#missionJudgmentRetained')?.value || '',
      withdrawn: root.querySelector('#missionJudgmentWithdrawn')?.value || '',
      replaced: root.querySelector('#missionJudgmentReplaced')?.value || '',
    },
  };
}

function publishedPanel(active) {
  if (!active) return `<section class="mission-published empty"><div><span>PUBLISHED STRATEGY</span><h2>还没有已批准使命</h2><p>下方内容都只是草稿。只有明确发布后，其他系统才可把它视为战略事实。</p></div></section>`;
  const snapshot = active.snapshot;
  return `<section class="mission-published"><div class="mission-published-id"><span>ACTIVE · V${active.version}</span><code>${esc(active.versionId)}</code></div><div class="mission-published-copy"><span>当前唯一主战役</span><h2>${esc(snapshot.campaign.title)}</h2><p>${esc(snapshot.campaign.whyNow)}</p></div><dl><div><dt>复查</dt><dd>${esc(snapshot.campaign.reviewAt)}</dd></div><div><dt>成功条件</dt><dd>${snapshot.campaign.successConditions.length} 条</dd></div><div><dt>退出条件</dt><dd>${snapshot.campaign.exitConditions.length} 条</dd></div></dl><small>批准：${esc(active.approval?.approvalId || '历史版本')} · explicit_user</small></section>`;
}

function evidencePanel(evidence) {
  const summary = evidence.status === 'unpublished' ? '需先发布战略' : evidence.status === 'insufficient' ? '投入证据不足，不做判断' : evidence.mismatches.length ? `发现 ${evidence.mismatches.length} 项偏差` : '声明与已记录投入未见明显偏差';
  return `<section class="mission-evidence"><header><div><span>READ-ONLY FACT CHAIN · ${esc(evidence.start)}—${esc(evidence.end)}</span><h2>声明，接受现实校验</h2></div><em class="${evidence.mismatches.length ? 'warning' : ''}">${esc(summary)}</em></header>${evidence.rows.length ? `<div class="mission-fact-rows">${evidence.rows.map((row) => `<article class="${evidence.mismatches.some((item) => item.mainlineId === row.mainlineId) ? 'warning' : ''}"><div><span>${esc(MISSION_PORTFOLIO_CLASSES[row.class])} · 声明 ${row.resourceShare}%</span><strong>${esc(row.title)}</strong><small>${row.sourceAvailable ? 'TaskBox 主线引用有效' : 'TaskBox 主线已不可读'}</small></div><div class="mission-fact-meter"><i style="--declared:${row.resourceShare}%;--actual:${row.actualShare ?? 0}%"></i><small>实际 ${row.actualShare == null ? '—' : `${row.actualShare}%`} · ${row.actualMinutes} 分钟</small></div><dl><div><dt>任务触达</dt><dd>${row.touchedTasks}</dd></div><div><dt>完成</dt><dd>${row.completedTasks}</dd></div><div><dt>事实引用</dt><dd>${row.evidenceRefs.length}</dd></div></dl></article>`).join('')}</div>` : '<div class="mission-empty">发布后才会按已批准项目组合读取事实。</div>'}${evidence.mismatches.length ? `<aside class="mission-review-signal"><strong>只生成复查信号，不自动改战略</strong>${evidence.mismatches.map((item) => `<p>${esc(item.title)}：${esc(item.reason)}</p>`).join('')}</aside>` : ''}<footer><span>时间系统：${evidence.totalActualMinutes} 分钟实际专注</span><span>日省只读样本：${evidence.reviewCoverage} 天</span><span>TaskBox：任务事实源</span></footer></section>`;
}

function historyPanel(store) {
  const events = [...store.events].reverse().slice(0, 12);
  const versions = [...store.history].reverse().slice(0, 5);
  return `<section class="mission-block mission-history"><header><div><span>APPROVAL & EVIDENCE CHAIN</span><h2>审批、证据与事件</h2></div><p>每次发布固化触发决定、候选/外部证据、判断变化与明确批准。</p></header>${versions.map((item) => `<article><b>V${item.version}</b><div><strong>${esc(item.evidenceChain.triggerDecision)}</strong><small>${item.evidenceChain.candidateRefs.length} 条候选 · ${item.evidenceChain.externalEvidenceRefs.length} 条外部证据 · ${esc(item.evidenceChain.approvedBy || '历史批准来源未知')} · ${esc(item.evidenceChain.approvedAt || item.activatedAt || '')}</small></div></article>`).join('')}${events.length ? events.map((item) => `<article><b>V${item.version}</b><div><strong>${esc(eventLabels[item.type] || item.type)}</strong><small>${esc(item.eventId)} · ${esc(new Date(item.occurredAt).toLocaleString('zh-CN', { hour12: false }))}</small></div></article>`).join('') : '<div class="mission-empty">首次明确发布后，这里开始记录协议事件。</div>'}</section>`;
}

function candidateInboxPanel(store) {
  const candidates = [...store.candidateInbox].sort((a, b) => String(b.importedAt || '').localeCompare(String(a.importedAt || '')));
  const unreviewed = candidates.filter((item) => item.decision.status === MISSION_CANDIDATE_DECISIONS.UNREVIEWED).length;
  const cards = candidates.map((item) => {
    const source = typeof item.sourceRef === 'string' ? item.sourceRef : item.evidenceRefs?.join(' · ') || '无可定位来源';
    return `<article data-candidate-id="${esc(item.candidateId)}"><div><span>V2 ${esc(item.v2Layer)} · ${esc(item.authority)} · ${esc(item.epistemicState)}</span><strong>${esc(item.content)}</strong><small>${esc(item.candidateId)} · dateMapping=${esc(typeof item.dateMapping === 'string' ? item.dateMapping : JSON.stringify(item.dateMapping))} · confidence=${item.confidence ?? 'unknown'}</small><code>${esc(source)}</code></div><div><em>${esc(candidateDecisionLabels[item.decision.status] || item.decision.status)}</em>${item.decision.publishedVersionId ? `<small>证据已进入 ${esc(item.decision.publishedVersionId)}</small>` : ''}<button data-candidate-action="ignored">忽略</button><button data-candidate-action="observing">保留观察</button><button data-candidate-action="included_in_draft">纳入使命草稿</button></div></article>`;
  }).join('');
  return `<details class="mission-block mission-candidates"><summary><strong>非事实候选收件箱</strong> · ${unreviewed} 条待裁决 / ${candidates.length} 条全部</summary><p>这里只接收 V2 使命候选。候选不是事实；“纳入使命草稿”只把引用放进待审批证据链，不会改写当前使命，也不会自动发布。</p><label>导入 V2 JSON / JSONL<input id="missionCandidateFiles" type="file" accept=".json,.jsonl,application/json" multiple></label>${cards || '<div class="mission-empty">尚未导入使命候选。可选择 V2 claim、pattern 或 calibration proposal 的 JSON/JSONL 文件。</div>'}</details>`;
}

function reviewContextPanel(store) {
  const context = store.reviewContext;
  return `<section class="mission-block mission-review-context"><header><div><span>DRAFT EVIDENCE CHAIN</span><h2>本次复盘如何改变版本</h2></div><p>${context.candidateRefs.length} 条候选已进入草稿证据；仍需下方二次明确批准。</p></header><label>触发本次变更的用户决定<textarea class="input" id="missionTriggerDecision" rows="2" placeholder="例如：我决定把未来30天主战役调整为……">${esc(context.triggerDecision)}</textarea></label><label>外部证据引用（每行一个）<textarea class="input" id="missionExternalEvidence" rows="2">${esc(text(context.externalEvidenceRefs))}</textarea></label><div class="mission-guards"><label><span>保留的旧判断</span><textarea class="input" id="missionJudgmentRetained" rows="3">${esc(text(context.judgmentChanges.retained))}</textarea></label><label><span>撤销的旧判断</span><textarea class="input" id="missionJudgmentWithdrawn" rows="3">${esc(text(context.judgmentChanges.withdrawn))}</textarea></label><label><span>替换的旧判断</span><textarea class="input" id="missionJudgmentReplaced" rows="3">${esc(text(context.judgmentChanges.replaced))}</textarea></label></div></section>`;
}

export function renderMissionPage(app) {
  const store = readMissionStore(); const active = activeMissionSnapshot(store); const draft = store.draft;
  const mainlines = getMainlines().filter((item) => item.status !== 'completed'); const tasks = getTasks();
  const evidence = deriveMissionEvidence({ store, mainlines: getMainlines(), tasks, timePlans: readTimeStore().plans, dailyReviews: missionDailyReviews(tasks) });
  app.innerHTML = `<main class="page mission-page safe-top"><header class="mission-top"><button id="missionBack" aria-label="返回人生参谋部">←</button><div><span>MISSION OS · V3 PROTOCOL</span><h1>使命系统</h1></div><em>${active ? `V${active.version} 已发布` : '仅有草稿'}</em></header>
  ${publishedPanel(active)}${evidencePanel(evidence)}
  ${candidateInboxPanel(store)}
  <section class="mission-draft-label"><div><span>UNPUBLISHED WORKSPACE</span><h2>战略草稿</h2></div><p>保存只留在本机；草稿和 AI 建议都不会覆盖上方已发布版本。</p></section>
  <section class="mission-vector"><div class="mission-rail"><i></i><i></i><i></i></div><article><span>长期使命 · ${esc(draft.missionId)}</span><textarea id="missionStatement" rows="3" placeholder="长期想让什么发生？">${esc(draft.statement)}</textarea></article><article><span>当前唯一战役 · ${esc(draft.campaign.campaignId)}</span><input id="missionCampaign" value="${esc(draft.campaign.title)}" placeholder="这个阶段只打哪一场仗"><textarea id="missionWhyNow" rows="2" placeholder="为什么必须是现在？">${esc(draft.campaign.whyNow)}</textarea></article><article class="mission-check"><span>现实如何判定</span><label>成功条件<textarea id="missionSuccess" rows="3" placeholder="每行一个结果">${esc(text(draft.campaign.successConditions))}</textarea></label><label>退出条件<textarea id="missionExit" rows="3" placeholder="什么证据出现时停止">${esc(text(draft.campaign.exitConditions))}</textarea></label><label>复查日期<input id="missionReviewAt" type="date" value="${esc(draft.campaign.reviewAt)}"></label></article></section>
  <section class="mission-block"><header><div><span>PORTFOLIO</span><h2>项目组合</h2></div><p>引用盒子主线，不复制项目事实；新增投入必须写机会成本。</p></header><div class="mission-portfolio">${rows(mainlines, draft)}</div></section>
  <section class="mission-guards"><label><span>现实约束</span><textarea class="input" id="missionConstraints" rows="4">${esc(text(draft.constraints))}</textarea></label><label><span>不可突破</span><textarea class="input" id="missionNonNegotiables" rows="4">${esc(text(draft.nonNegotiables))}</textarea></label><label class="stop"><span>明确不做</span><textarea class="input" id="missionNotDoing" rows="4">${esc(text(draft.notDoing))}</textarea></label></section>
  ${reviewContextPanel(store)}
  ${historyPanel(store)}
  <aside class="mission-boundary"><strong>V3 边界</strong><p>当前协议与事件保存在本机。V2候选始终不是事实；使命系统只读 TaskBox、时间系统与候选缓存，不创建任务、不写回其他系统、不向 HQ 自动提交提案。</p></aside>
  <footer class="mission-actions safe-bottom"><button id="missionSave">保存未发布草稿</button><button class="primary" id="missionPublish">发布战略版本</button></footer></main>`;
  app.querySelector('#missionBack').onclick = () => navigate('#hq');
  app.querySelector('#missionSave').onclick = () => { const next = updateMissionReviewContext({ ...readMissionStore(), draft: readDraft(app, draft) }, readReviewContext(app)); writeMissionStore(next); showToast('未发布草稿与证据链已保存到本机'); };
  app.querySelector('.mission-candidates').onclick = (event) => {
    const action = event.target.closest('[data-candidate-action]');
    if (!action) return;
    const candidateId = action.closest('[data-candidate-id]')?.dataset.candidateId;
    const result = decideMissionCandidate(readMissionStore(), candidateId, action.dataset.candidateAction, { sourceAuthority: 'explicit_user' });
    if (result.error) { showToast(result.error); return; }
    writeMissionStore(result.store); showToast(candidateDecisionLabels[action.dataset.candidateAction]); renderMissionPage(app);
  };
  app.querySelector('#missionCandidateFiles').onchange = async (event) => {
    const files = [...event.target.files]; let candidates = []; let rejected = [];
    for (const file of files) {
      const parsed = parseMissionV2Text(await file.text()); candidates = candidates.concat(parsed.candidates); rejected = rejected.concat(parsed.rejected);
    }
    const result = importMissionCandidates(readMissionStore(), candidates); writeMissionStore(result.store);
    showToast(`新增 ${result.imported} 条使命候选${rejected.length ? `，跳过 ${rejected.length} 条` : ''}`); renderMissionPage(app);
  };
  app.querySelector('#missionPublish').onclick = (event) => {
    if (event.currentTarget.dataset.confirm !== '1') { event.currentTarget.dataset.confirm = '1'; event.currentTarget.textContent = '确认由我批准并发布'; showToast('发布后会生成审批记录和不可变事件'); return; }
    const saved = writeMissionStore(updateMissionReviewContext({ ...readMissionStore(), draft: readDraft(app, draft) }, readReviewContext(app)));
    const result = publishMissionVersion(saved, mainlines, { sourceAuthority: 'explicit_user' });
    if (result.errors.length) { event.currentTarget.dataset.confirm = ''; event.currentTarget.textContent = '发布战略版本'; showToast(result.errors[0]); return; }
    writeMissionStore(result.store); showToast(`战略 V${result.version} 已由你批准并发布`); renderMissionPage(app);
  };
}
