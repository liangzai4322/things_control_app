import { navigate, openSheet, showToast } from './app.js';
import {
  DEVIATION_TYPES, TARGET_SYSTEMS, activateRuleVersion, addPrediction, approveExperiment,
  completeExperiment, deprecateRuleVersion, deriveFeedbackDashboard, proposeExperiment,
  importFeedbackContinuity, importV2FeedbackCandidates, observePatternCandidate,
  proposeCandidateExperiment, proposeCrossSystemChange, proposeRuleVersion, rejectPatternCandidate, settlePrediction,
} from './feedback-model.js';
import { readFeedbackStore, writeFeedbackStore } from './feedback-store.js';
import { parseFeedbackImportFiles } from './feedback-import.js';
import { mountSystemCandidateInbox } from './system-candidate-inbox.js';

const esc = (value = '') => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const lines = (value) => String(value || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
const USER_AUTHORITY = 'explicit_user';
const dateTimeLocal = (date = new Date(Date.now() + 86400000)) => new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
const statusLabel = { proposed: '待批准', active: '运行中', succeeded: '有效', failed: '无效', inconclusive: '无法判断', stopped: '已停止', deprecated: '已废弃' };

function saveResult(result, success) {
  if (result.error) { showToast(result.error); return false; }
  writeFeedbackStore(result.store); showToast(success); return true;
}

function options(map, selected = '') { return Object.entries(map).map(([value, label]) => `<option value="${value}" ${value === selected ? 'selected' : ''}>${label}</option>`).join(''); }

function openPredictionSheet(app) {
  const { root, close } = openSheet(`<div class="sheet-header"><div><p class="eyebrow">FREEZE THE FORECAST</p><h2>冻结一项预测</h2></div><button class="icon-btn" data-close>×</button></div><div class="feedback-form">
    <label>对象引用<input class="input" id="fbSubject" placeholder="任务、战役或健康干预"></label><label>预期结果<textarea class="input" id="fbExpected" rows="3" placeholder="到期时，现实中具体会发生什么？"></textarea></label><label>兑现时间<input class="input" id="fbExpectedAt" type="datetime-local" value="${dateTimeLocal()}"></label><label>关键假设<textarea class="input" id="fbAssumptions" rows="3" placeholder="每行一个，写下预测依赖什么"></textarea></label><label>已有证据引用<textarea class="input" id="fbEvidence" rows="2" placeholder="TaskBox任务ID、日省日期或文档引用"></textarea></label>
    <div class="sheet-actions"><button class="btn" data-close>取消</button><button class="btn primary" id="fbSavePrediction">保存预测</button></div></div>`, { height: '82vh' });
  root.querySelectorAll('[data-close]').forEach((x) => x.onclick = close);
  root.querySelector('#fbSavePrediction').onclick = () => {
    const result = addPrediction(readFeedbackStore(), { subjectRef: root.querySelector('#fbSubject').value, expectedResult: root.querySelector('#fbExpected').value, expectedAt: root.querySelector('#fbExpectedAt').value, assumptions: lines(root.querySelector('#fbAssumptions').value), evidenceRefs: lines(root.querySelector('#fbEvidence').value) });
    if (saveResult(result, '预测已冻结')) { close(); renderFeedbackPage(app); }
  };
}

function openSettleSheet(app, predictionId) {
  const prediction = readFeedbackStore().predictions.find((x) => x.predictionId === predictionId); if (!prediction) return;
  const { root, close } = openSheet(`<div class="sheet-header"><div><p class="eyebrow">PREDICTION → REALITY</p><h2>结算预测</h2></div><button class="icon-btn" data-close>×</button></div><div class="feedback-form"><div class="feedback-freeze"><span>原始预测</span><strong>${esc(prediction.expectedResult)}</strong><small>${esc(prediction.expectedAt)}</small></div>
    <label>实际结果<textarea class="input" id="fbActual" rows="3" placeholder="只写已经发生的现实"></textarea></label><div class="feedback-form-grid"><label>偏差类型<select class="input" id="fbType">${options(DEVIATION_TYPES)}</select></label><label>严重度<select class="input" id="fbSeverity"><option value="low">低</option><option value="medium">中</option><option value="high">高</option></select></label></div><label>观察事实<textarea class="input" id="fbFacts" rows="3" placeholder="每行一条，不写人格判断"></textarea></label><label>机制解释<textarea class="input" id="fbInterpretation" rows="2" placeholder="可选：什么机制可能导致偏差？"></textarea></label>
    <div class="sheet-actions"><button class="btn" data-close>取消</button><button class="btn primary" id="fbSettle">保存现实结果</button></div></div>`, { height: '86vh' });
  root.querySelectorAll('[data-close]').forEach((x) => x.onclick = close);
  root.querySelector('#fbSettle').onclick = () => { const result = settlePrediction(readFeedbackStore(), predictionId, { actualResult: root.querySelector('#fbActual').value, type: root.querySelector('#fbType').value, severity: root.querySelector('#fbSeverity').value, facts: lines(root.querySelector('#fbFacts').value), interpretation: root.querySelector('#fbInterpretation').value }); if (saveResult(result, '预测已按现实结算')) { close(); renderFeedbackPage(app); } };
}

function openExperimentSheet(app, patternCandidateId = '') {
  const nextWeek = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  const { root, close } = openSheet(`<div class="sheet-header"><div><p class="eyebrow">ONE VARIABLE</p><h2>提出单变量实验</h2></div><button class="icon-btn" data-close>×</button></div><div class="feedback-form"><label>假设<textarea class="input" id="fbHypothesis" rows="2" placeholder="如果改变X，那么Y会改善"></textarea></label><label>唯一改变变量<input class="input" id="fbVariable" placeholder="一次只改一个关键变量"></label><label>验证日期<input class="input" id="fbEvaluate" type="date" value="${nextWeek}"></label><label>成功条件<textarea class="input" id="fbSuccess" rows="3" placeholder="每行一个可检查阈值"></textarea></label><label>停止条件<textarea class="input" id="fbStop" rows="3" placeholder="每行一个提前停止条件"></textarea></label><div class="sheet-actions"><button class="btn" data-close>取消</button><button class="btn primary" id="fbSaveExperiment">保存为待批准</button></div></div>`, { height: '86vh' });
  root.querySelectorAll('[data-close]').forEach((x) => x.onclick = close);
  root.querySelector('#fbSaveExperiment').onclick = () => { const draft = { hypothesis: root.querySelector('#fbHypothesis').value, changedVariable: root.querySelector('#fbVariable').value, evaluateAt: root.querySelector('#fbEvaluate').value, successConditions: lines(root.querySelector('#fbSuccess').value), stopConditions: lines(root.querySelector('#fbStop').value) }; const result = patternCandidateId ? proposeCandidateExperiment(readFeedbackStore(), patternCandidateId, draft) : proposeExperiment(readFeedbackStore(), draft); if (saveResult(result, '实验提案已保存，尚未运行')) { close(); renderFeedbackPage(app); } };
}

function openExperimentResultSheet(app, experimentId) {
  const { root, close } = openSheet(`<div class="sheet-header"><div><p class="eyebrow">EVALUATE, DON'T SPIN</p><h2>结算实验</h2></div><button class="icon-btn" data-close>×</button></div><div class="feedback-form"><label>验证结论<select class="input" id="fbExperimentStatus"><option value="succeeded">达到成功条件</option><option value="failed">未达到成功条件</option><option value="inconclusive">证据冲突，无法判断</option><option value="stopped">触发停止条件</option></select></label><label>现实结果<textarea class="input" id="fbExperimentResult" rows="5" placeholder="记录事实与证据，不补写故事"></textarea></label><div class="sheet-actions"><button class="btn" data-close>取消</button><button class="btn primary" id="fbFinishExperiment">保存结论</button></div></div>`, { height: '62vh' });
  root.querySelectorAll('[data-close]').forEach((x) => x.onclick = close);
  root.querySelector('#fbFinishExperiment').onclick = () => { const result = completeExperiment(readFeedbackStore(), experimentId, root.querySelector('#fbExperimentStatus').value, root.querySelector('#fbExperimentResult').value, { sourceAuthority: USER_AUTHORITY }); if (!root.querySelector('#fbExperimentResult').value.trim()) { showToast('必须记录现实结果'); return; } if (saveResult(result, '实验已结算')) { close(); renderFeedbackPage(app); } };
}

function openRuleSheet(app, ruleId = '', patternCandidateId = '') {
  const nextWeek = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  const { root, close } = openSheet(`<div class="sheet-header"><div><p class="eyebrow">REVERSIBLE RULE</p><h2>${ruleId ? '提出规则新版本' : '提出一条规则'}</h2></div><button class="icon-btn" data-close>×</button></div><div class="feedback-form"><label>目标系统<select class="input" id="fbTarget">${options(TARGET_SYSTEMS)}</select></label><label>规则陈述<textarea class="input" id="fbStatement" rows="3" placeholder="一条规则只表达一个约束"></textarea></label><label>证据引用<textarea class="input" id="fbRuleEvidence" rows="3" placeholder="每行一个预测、偏差或实验ID"></textarea></label><label>验证日期<input class="input" id="fbValidation" type="date" value="${nextWeek}"></label><label>失效条件<textarea class="input" id="fbInvalidation" rows="3" placeholder="什么证据出现时应废弃这条规则？"></textarea></label><div class="sheet-actions"><button class="btn" data-close>取消</button><button class="btn primary" id="fbSaveRule">保存为待批准</button></div></div>`, { height: '84vh' });
  root.querySelectorAll('[data-close]').forEach((x) => x.onclick = close);
  root.querySelector('#fbSaveRule').onclick = () => { const result = proposeRuleVersion(readFeedbackStore(), { ruleId, patternCandidateId, targetSystem: root.querySelector('#fbTarget').value, statement: root.querySelector('#fbStatement').value, evidenceRefs: lines(root.querySelector('#fbRuleEvidence').value), validationAt: root.querySelector('#fbValidation').value, invalidationConditions: lines(root.querySelector('#fbInvalidation').value) }); if (saveResult(result, '规则提案已保存，尚未生效')) { close(); renderFeedbackPage(app); } };
}

function openCandidateObservationSheet(app, patternId) {
  const candidate = readFeedbackStore().v2Candidates.patternCandidates.find((item) => item.patternId === patternId); if (!candidate) return;
  const { root, close } = openSheet(`<div class="sheet-header"><div><p class="eyebrow">CANDIDATE → OBSERVED</p><h2>补充现实证据</h2></div><button class="icon-btn" data-close>×</button></div><div class="feedback-form"><div class="feedback-freeze"><span>未验证候选</span><strong>${esc(candidate.statement)}</strong></div><label>支持证据引用<textarea class="input" id="fbSupporting" rows="3" placeholder="至少一条可定位回执、任务完成证据或原始记录"></textarea></label><label>反例证据引用<textarea class="input" id="fbCounter" rows="2"></textarea></label><label>仍缺证据<textarea class="input" id="fbMissing" rows="2"></textarea></label><div class="sheet-actions"><button class="btn" data-close>取消</button><button class="btn primary" id="fbObserve">明确标记为 observed</button></div></div>`, { height: '76vh' });
  root.querySelectorAll('[data-close]').forEach((x) => x.onclick = close);
  root.querySelector('#fbObserve').onclick = () => { const result = observePatternCandidate(readFeedbackStore(), patternId, { supportingEvidence: lines(root.querySelector('#fbSupporting').value), counterEvidence: lines(root.querySelector('#fbCounter').value), missingEvidence: lines(root.querySelector('#fbMissing').value) }, { sourceAuthority: USER_AUTHORITY }); if (saveResult(result, '已记录观察证据，仍不是规则')) { close(); renderFeedbackPage(app); } };
}

function openCrossSystemProposalSheet(app) {
  const { root, close } = openSheet(`<div class="sheet-header"><div><p class="eyebrow">PROPOSE, DON'T APPLY</p><h2>提出跨系统变更</h2></div><button class="icon-btn" data-close>×</button></div><div class="feedback-form"><label>目标系统<select class="input" id="fbChangeTarget">${options(TARGET_SYSTEMS)}</select></label><label>偏差<textarea class="input" id="fbChangeDeviation" rows="2"></textarea></label><label>证据引用<textarea class="input" id="fbChangeEvidence" rows="2"></textarea></label><label>建议变更<textarea class="input" id="fbSuggestedChange" rows="2"></textarea></label><label>成功条件<textarea class="input" id="fbChangeSuccess" rows="2"></textarea></label><label>停止条件<textarea class="input" id="fbChangeStop" rows="2"></textarea></label><label>风险<textarea class="input" id="fbChangeRisks" rows="2"></textarea></label><label>回滚方式<textarea class="input" id="fbChangeRollback" rows="2"></textarea></label><div class="sheet-actions"><button class="btn" data-close>取消</button><button class="btn primary" id="fbSaveChange">保存提案，不执行</button></div></div>`, { height: '90vh' });
  root.querySelectorAll('[data-close]').forEach((x) => x.onclick = close);
  root.querySelector('#fbSaveChange').onclick = () => { const result = proposeCrossSystemChange(readFeedbackStore(), { targetSystem: root.querySelector('#fbChangeTarget').value, deviation: root.querySelector('#fbChangeDeviation').value, evidenceRefs: lines(root.querySelector('#fbChangeEvidence').value), suggestedChange: root.querySelector('#fbSuggestedChange').value, successConditions: lines(root.querySelector('#fbChangeSuccess').value), stopConditions: lines(root.querySelector('#fbChangeStop').value), risks: lines(root.querySelector('#fbChangeRisks').value), rollback: root.querySelector('#fbChangeRollback').value }); if (saveResult(result, '跨系统提案已保存，目标系统尚未改变')) { close(); renderFeedbackPage(app); } };
}

function renderPrediction(prediction) {
  return `<article class="feedback-prediction"><span>${esc(prediction.subjectRef || '未命名对象')}</span><strong>${esc(prediction.expectedResult)}</strong><small>兑现 ${esc(prediction.expectedAt.replace('T', ' ').slice(0, 16))}</small><button data-settle="${esc(prediction.predictionId)}">记录现实结果</button></article>`;
}

function renderRule(rule, pending = false) {
  return `<article class="feedback-rule ${rule.status}"><div><span>${esc(TARGET_SYSTEMS[rule.targetSystem])} OS</span><b>V${rule.version}</b></div><strong>${esc(rule.statement)}</strong><small>${pending ? `验证日 ${esc(rule.validationAt)} · ${rule.evidenceRefs.length} 条证据` : `批准：${esc(rule.approvedBy || '—')} · 验证日 ${esc(rule.validationAt)}`}</small><div>${pending ? `<button data-activate-rule="${esc(rule.ruleId)}" data-version="${rule.version}">明确批准并激活</button>` : `<button data-new-rule="${esc(rule.ruleId)}">提出新版本</button><button class="danger" data-deprecate-rule="${esc(rule.ruleId)}" data-version="${rule.version}">废弃</button>`}</div></article>`;
}

function renderV2Candidate(candidate) {
  const action = candidate.status === 'candidate_unvalidated' ? `<button data-observe-candidate="${esc(candidate.patternId)}">补充证据</button>`
    : candidate.status === 'observed' ? `<button data-candidate-experiment="${esc(candidate.patternId)}">提出实验</button>`
      : candidate.status === 'evaluated' ? `<button data-candidate-rule="${esc(candidate.patternId)}">提出规则</button>` : '';
  const reject = ['candidate_unvalidated', 'observed', 'experiment_proposed', 'evaluated', 'rule_proposed'].includes(candidate.status) ? `<button class="danger" data-reject-candidate="${esc(candidate.patternId)}">拒绝</button>` : '';
  return `<article><div><span>${esc(candidate.patternId)}</span><i>${esc(candidate.status)}</i></div><strong>${esc(candidate.statement)}</strong><small>支持 ${candidate.supportingEvidence.length} · 反例 ${candidate.counterEvidence.length} · 缺失 ${candidate.missingEvidence.length}</small><div>${action}${reject}</div></article>`;
}

export function renderFeedbackPage(app) {
  const dashboard = deriveFeedbackDashboard(readFeedbackStore()); const experiment = dashboard.activeExperiment;
  app.innerHTML = `<main class="page feedback-page safe-top safe-bottom"><header class="feedback-top"><button id="feedbackBack" aria-label="返回人生参谋部">←</button><div><span>FEEDBACK & EVOLUTION OS · V3 CANDIDATE LAYERS</span><h1>缩小预测与现实的误差</h1></div><div><button id="feedbackImport">导入 JSON / JSONL</button><button class="primary" id="feedbackAddPrediction">＋ 冻结预测</button></div><input id="feedbackImportFile" type="file" accept="application/json,application/x-ndjson,.json,.jsonl" multiple hidden></header>
    <section class="feedback-calibration"><article class="forecast"><span>PREDICTION · 预测</span><strong>${dashboard.metrics.open}</strong><p>项仍等待现实结算</p></article><div class="feedback-seam"><i></i><b>Δ</b><small>不允许事后改写</small></div><article class="reality"><span>REALITY · 现实</span><strong>${dashboard.metrics.evidenceCoverage == null ? '—' : `${dashboard.metrics.evidenceCoverage}%`}</strong><p>已结算记录有事实证据</p></article></section>
    <section class="feedback-grid"><article class="feedback-panel predictions"><header><div><span>OPEN LOOP</span><h2>等待结算的预测</h2></div><b>${dashboard.openPredictions.length}</b></header><div>${dashboard.openPredictions.length ? dashboard.openPredictions.map(renderPrediction).join('') : '<p class="feedback-empty">先冻结一个重要预测。没有原始预期，就无法判断偏差。</p>'}</div></article>
      <article class="feedback-panel patterns"><header><div><span>REPEATED SIGNAL</span><h2>重复模式</h2></div><b>${dashboard.patterns.length}</b></header><div>${dashboard.patterns.length ? dashboard.patterns.map((pattern) => `<article><i>${esc(DEVIATION_TYPES[pattern.type])}</i><strong>${esc(pattern.subjectRef)}</strong><span>${pattern.count} 次 · ${pattern.evidenceRefs.length} 个证据引用${pattern.highSeverityCount ? ` · ${pattern.highSeverityCount} 次高严重度` : ''}</span></article>`).join('') : '<p class="feedback-empty">单次普通偏差只记录；重复或高严重度后才形成模式候选。</p>'}</div></article></section>
    <section class="feedback-deviations"><header><div><span>V2 READ-ONLY INBOX</span><h2>历史候选分层收件箱</h2></div><b>${dashboard.v2Inbox.patternCandidates.length}</b></header><div><article><div><span>observation / claim</span><i>候选，不是事实</i></div><small>${dashboard.v2Inbox.observationsClaims.length} 条 · 保留 authority / epistemicState / dateMapping</small></article><article><div><span>semantic_cluster</span><i>文本重复，不等于行为重复</i></div><small>${dashboard.v2Inbox.semanticClusters.length} 个 · ${dashboard.v2Inbox.templateClusters.length} 个模板簇已隔离 · ${dashboard.v2Inbox.temporalEligibleClusters.length} 个可进入时序</small></article><article><div><span>pattern_candidate</span><i>逐级授权</i></div><small>${dashboard.v2Inbox.patternCandidates.length} 个 · ${dashboard.v2Inbox.patternCandidates.filter((item) => item.status === 'candidate_unvalidated').length} 个仍未验证</small></article><article><div><span>calibration_proposal</span><i>未经选择不运行</i></div><small>${dashboard.v2Inbox.calibrationProposals.length} 个 · 全部保持 proposed</small></article>${dashboard.v2Inbox.patternCandidates.slice(0, 8).map(renderV2Candidate).join('')}</div></section>
    <section class="feedback-deviations"><header><div><span>RECENT CALIBRATION</span><h2>最近预测与现实偏差</h2></div><b>${dashboard.settled.length + dashboard.importedDeviations.length}</b></header><div>${dashboard.importedDeviations.length + dashboard.settled.length ? `${dashboard.importedDeviations.map((item) => `<article><div><span>${esc(item.subjectRef || item.sourceRef || '跨周期观察')}</span><i>${esc(DEVIATION_TYPES[item.type])} · ${esc(item.severity)} · ${esc(item.sourceCycle)}</i></div><section><p><b>预测</b>${esc(item.expectedResult || '原始预测缺失，仅记录观察')}</p><em>→</em><p><b>现实</b>${esc(item.actualResult || '未提供结果')}</p></section><small>${esc(item.facts.join('；'))} · ${item.evidenceRefs.length} 条证据引用 · ${esc(item.deviationId)}</small></article>`).join('')}${dashboard.settled.slice(0, 6).map((item) => `<article><div><span>${esc(item.subjectRef || '通用')}</span><i>${esc(DEVIATION_TYPES[item.deviation.type])} · ${esc(item.deviation.severity)}</i></div><section><p><b>预测</b>${esc(item.expectedResult)}</p><em>→</em><p><b>现实</b>${esc(item.actualResult)}</p></section><small>${esc(item.deviation.facts.join('；'))}</small></article>`).join('')}` : '<p class="feedback-empty">预测结算后会在这里保留原始预期、现实结果和事实证据。</p>'}</div></section>
    <section class="feedback-experiment"><header><div><span>ONE EXPERIMENT AT A TIME</span><h2>当前唯一实验</h2></div>${experiment ? `<button data-finish-experiment="${esc(experiment.experimentId)}">到期结算</button>` : '<button id="feedbackAddExperiment">＋ 提出实验</button>'}</header>${experiment ? `<div class="feedback-experiment-body"><span>唯一变量</span><strong>${esc(experiment.changedVariable)}</strong><h3>${esc(experiment.hypothesis)}</h3><dl><div><dt>验证日期</dt><dd>${esc(experiment.evaluateAt)}</dd></div><div><dt>成功条件</dt><dd>${esc(experiment.successConditions.join('；'))}</dd></div><div><dt>停止条件</dt><dd>${esc(experiment.stopConditions.join('；'))}</dd></div></dl></div>` : '<p class="feedback-empty">没有运行中的实验。实验提案必须由你明确批准后才会启动。</p>'}<div class="feedback-proposals">${dashboard.proposedExperiments.map((item) => `<article><span>待批准实验</span><strong>${esc(item.hypothesis)}</strong><small>只改变：${esc(item.changedVariable)}</small><button data-approve-experiment="${esc(item.experimentId)}">明确批准并启动</button></article>`).join('')}</div></section>
    <section class="feedback-rulebook"><header><div><span>VERSIONED RULEBOOK</span><h2>规则版本库</h2></div><button id="feedbackAddRule">＋ 提出规则</button></header>${dashboard.validationDue.length ? `<div class="feedback-due">${dashboard.validationDue.length} 条规则已到验证日，不能仅凭感觉续期。</div>` : ''}<div class="feedback-rule-columns"><section><h3>待批准 · ${dashboard.proposedRules.length}</h3>${dashboard.proposedRules.length ? dashboard.proposedRules.map((x) => renderRule(x, true)).join('') : '<p class="feedback-empty">没有待批准规则。</p>'}</section><section><h3>已启用 · ${dashboard.activeRules.length}</h3>${dashboard.activeRules.length ? dashboard.activeRules.map((x) => renderRule(x)).join('') : '<p class="feedback-empty">尚无已验证并批准的规则。</p>'}</section></div><section class="feedback-rule-history"><h3>版本历史 · ${dashboard.ruleHistory.length}</h3>${dashboard.ruleHistory.length ? dashboard.ruleHistory.map((rule) => `<article><span>${esc(TARGET_SYSTEMS[rule.targetSystem])} · ${esc(rule.ruleId)} · V${rule.version}</span><strong>${esc(rule.statement)}</strong><i>${esc(statusLabel[rule.status] || rule.status)}</i></article>`).join('') : '<p class="feedback-empty">被替换或主动废弃的版本会留在这里，不会被删除。</p>'}</section></section>
    <section class="feedback-rulebook"><header><div><span>CROSS-SYSTEM PROPOSALS</span><h2>跨系统变更提案</h2></div><button id="feedbackAddChange">＋ 提出变更</button></header><div class="feedback-rule-history">${dashboard.crossSystemProposals.length ? dashboard.crossSystemProposals.map((item) => `<article><span>${esc(TARGET_SYSTEMS[item.targetSystem])} · ${esc(item.status)}</span><strong>${esc(item.suggestedChange)}</strong><i>仅提案，未写入目标系统</i></article>`).join('') : '<p class="feedback-empty">反馈系统只能提出建议，不能直接改写其他系统。</p>'}</div></section>
    <footer class="feedback-guard">事实 → 解释 → 实验/规则提案 → 用户批准 → 到期验证。反馈系统不自动改写其他系统。</footer></main>`;
  app.querySelector('#feedbackBack').onclick = () => navigate('#hq');
  mountSystemCandidateInbox(app, 'feedback', '.feedback-deviations');
  app.querySelector('#feedbackAddPrediction').onclick = () => openPredictionSheet(app);
  app.querySelector('#feedbackImport').onclick = () => app.querySelector('#feedbackImportFile').click();
  app.querySelector('#feedbackImportFile').onchange = async (event) => {
    const parsed = await parseFeedbackImportFiles(event.target.files);
    event.target.value = '';
    if (parsed.error) { showToast(`${parsed.error}${parsed.errors[0] ? `：${parsed.errors[0]}` : ''}`); return; }
    const result = parsed.mode === 'v2' ? importV2FeedbackCandidates(readFeedbackStore(), parsed.payload) : importFeedbackContinuity(readFeedbackStore(), parsed.payload);
    const message = parsed.mode === 'v2' ? `已分层导入 ${result.imported?.observationsClaims || 0} 条 observation/claim、${result.imported?.semanticClusters || 0} 个语义簇、${result.imported?.patternCandidates || 0} 个未验证模式、${result.imported?.calibrationProposals || 0} 个校准提案` : `已导入 ${result.imported?.deviations || 0} 个偏差、${result.imported?.experiments || 0} 个实验、${result.imported?.rules || 0} 个规则提案`;
    if (saveResult(result, message)) renderFeedbackPage(app);
  };
  app.querySelectorAll('[data-settle]').forEach((button) => button.onclick = () => openSettleSheet(app, button.dataset.settle));
  app.querySelector('#feedbackAddExperiment')?.addEventListener('click', () => openExperimentSheet(app));
  app.querySelectorAll('[data-observe-candidate]').forEach((button) => button.onclick = () => openCandidateObservationSheet(app, button.dataset.observeCandidate));
  app.querySelectorAll('[data-candidate-experiment]').forEach((button) => button.onclick = () => openExperimentSheet(app, button.dataset.candidateExperiment));
  app.querySelectorAll('[data-candidate-rule]').forEach((button) => button.onclick = () => openRuleSheet(app, '', button.dataset.candidateRule));
  app.querySelectorAll('[data-reject-candidate]').forEach((button) => button.onclick = () => { const result = rejectPatternCandidate(readFeedbackStore(), button.dataset.rejectCandidate, { sourceAuthority: USER_AUTHORITY }); if (saveResult(result, '候选已拒绝并保留审计轨迹')) renderFeedbackPage(app); });
  app.querySelectorAll('[data-approve-experiment]').forEach((button) => button.onclick = () => { const result = approveExperiment(readFeedbackStore(), button.dataset.approveExperiment, { sourceAuthority: USER_AUTHORITY }); if (saveResult(result, '实验已由你批准并启动')) renderFeedbackPage(app); });
  app.querySelectorAll('[data-finish-experiment]').forEach((button) => button.onclick = () => openExperimentResultSheet(app, button.dataset.finishExperiment));
  app.querySelector('#feedbackAddRule').onclick = () => openRuleSheet(app);
  app.querySelector('#feedbackAddChange').onclick = () => openCrossSystemProposalSheet(app);
  app.querySelectorAll('[data-new-rule]').forEach((button) => button.onclick = () => openRuleSheet(app, button.dataset.newRule));
  app.querySelectorAll('[data-activate-rule]').forEach((button) => button.onclick = () => { const result = activateRuleVersion(readFeedbackStore(), button.dataset.activateRule, button.dataset.version, { sourceAuthority: USER_AUTHORITY }); if (saveResult(result, '规则版本已由你明确激活')) renderFeedbackPage(app); });
  app.querySelectorAll('[data-deprecate-rule]').forEach((button) => button.onclick = () => { const result = deprecateRuleVersion(readFeedbackStore(), button.dataset.deprecateRule, button.dataset.version, { sourceAuthority: USER_AUTHORITY }); if (saveResult(result, '规则版本已废弃')) renderFeedbackPage(app); });
}
