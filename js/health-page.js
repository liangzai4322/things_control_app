import { navigate, showToast } from './app.js';
import {
  buildHealthProtocolSnapshot,
  buildHealthTrend,
  deriveHealthAssessment,
  normalizeHealthObservation,
  normalizeIntervention,
} from './health-model.js';
import {
  beginHealthIntervention,
  decideHealthCandidate,
  importHealthCandidateRecords,
  publishHealthSnapshot,
  readHealthProtocolStore,
  readHealthStore,
  upsertHealthObservation,
  writeHealthStore,
} from './health-store.js';
import { mountSystemCandidateInbox } from './system-candidate-inbox.js';

const esc = (value = '') => String(value)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#39;');
const softRef = (value = '') => esc(value).replaceAll('/', '/\u200b').replaceAll('#', '#\u200b');
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
const stateLabel = { green: '正常负载', yellow: '保守降载', red: '停止非必要负载', unknown: '证据不足' };
const sourceLabel = { manual: '本人记录', wearable: '穿戴/健康数据', medical_record: '专业记录', daily_review: '日省事实' };
const outcomeLabel = { effective: '有效', ineffective: '无效', inconclusive: '证据不足' };
const authorityLabel = { external_evidence: '外部证据候选', user_interpretation: '用户解释', ai_summary: 'AI 摘要' };
const candidateStatusLabel = { pending: '待确认', confirmed: '已转观测', context_only: '仅作上下文', dismissed: '已忽略' };

function parseCandidateRecords(text) {
  const input = text.trim();
  if (!input) return [];
  if (input.startsWith('[')) return JSON.parse(input);
  return input.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line));
}

function renderTrend(records) {
  const items = buildHealthTrend(records);
  if (!items.length) return '<div class="health-empty">保存第一份记录后，这里会形成连续趋势。</div>';
  return items.map((item) => {
    const level = item.energy == null ? 10 : item.energy * 18;
    return `<article title="${esc(`${item.date} · 睡眠 ${item.sleepHours ?? '未知'} · 精力 ${item.energy ?? '未知'}`)}">
      <i style="--pulse:${level}%" class="${item.state}"></i>
      <strong>${item.energy ?? '–'}</strong>
      <small>${item.date.slice(5)}</small>
    </article>`;
  }).join('');
}

function renderSourceLedger(records) {
  const recent = [...records].sort((left, right) => (
    right.date.localeCompare(left.date) || right.source.localeCompare(left.source)
  )).slice(0, 6);
  if (!recent.length) return '<div class="health-empty">还没有来源化观测。</div>';
  return recent.map((item) => `<article>
    <div><b>${esc(sourceLabel[item.source] || item.source)}</b><span>${esc(item.date)}</span></div>
    <p>睡眠 ${item.sleepHours ?? '—'}h · 精力 ${item.energy ?? '—'}/5 · 置信度 ${Math.round(item.confidence * 100)}%</p>
    <small>${esc(item.notes || item.symptoms || '无补充说明')}</small>
  </article>`).join('');
}

function renderInterventions(interventions) {
  const sorted = [...interventions].sort((left, right) => (right.createdAt || '').localeCompare(left.createdAt || ''));
  if (!sorted.length) return '<div class="health-empty">当前没有正在验证的干预。</div>';
  return sorted.map((item) => `<article class="${item.status}">
    <div><b>${esc(item.action)}</b><span>${esc(item.targetDeviation)}</span></div>
    <small>验证 ${esc(item.evaluationAt || '日期待补')} · 成功：${esc(item.successCondition || '待补')} · 停止：${esc(item.stopCondition || '待补')}</small>
    ${item.status === 'active'
      ? `<div class="health-evaluate" data-intervention="${esc(item.id)}"><input class="input" placeholder="验证证据或结果"><button data-outcome="effective">有效</button><button data-outcome="ineffective">无效</button><button data-outcome="inconclusive">证据不足</button></div>`
      : `<p class="health-outcome">${outcomeLabel[item.outcome] || '已停止'} · ${esc(item.evaluationResult || '未附结果')}</p>`}
  </article>`).join('');
}

function renderCandidateInbox(candidates) {
  const sorted = [...candidates].sort((left, right) => {
    const leftResolved = left.resolvedAt || '';
    const rightResolved = right.resolvedAt || '';
    if (leftResolved || rightResolved) return rightResolved.localeCompare(leftResolved);
    if (left.status === 'pending' && right.status !== 'pending') return -1;
    if (right.status === 'pending' && left.status !== 'pending') return 1;
    return (right.importedAt || '').localeCompare(left.importedAt || '');
  }).slice(0, 20);
  if (!sorted.length) return '<div class="health-empty">尚未导入 V2 health 候选。候选只进入待确认层，不会自动成为健康事实。</div>';
  return sorted.map((item) => {
    const dateStatus = item.temporalEligible
      ? `日期可信度：日级可用 · ${item.activityStart} · ${item.dateMapping}`
      : `日期可信度：无时序资格 · ${item.activityStart || '无明确活动日期'} · ${item.dateMapping}`;
    return `<article>
      <div><b>${esc(candidateStatusLabel[item.status] || item.status)}</b><span>${esc(dateStatus)}</span></div>
      <p>${esc(item.content)}</p>
      <small>${esc(authorityLabel[item.authority] || item.authority)} · ${softRef(item.sourceRef)}</small>
      ${item.status !== 'pending' ? `<small>审计：${esc(item.decisionId || 'decision-id-missing')} · ${esc(item.resolvedBy || 'authority-missing')} · ${esc(item.resolvedAt || 'time-missing')}</small>` : ''}
      ${item.status === 'pending' ? `<div class="health-evaluate" data-health-candidate="${esc(item.candidateId)}">
        <button data-candidate-decision="confirm">${item.temporalEligible ? '确认并转为日省观测' : '确认为无时序上下文'}</button>
        <button data-candidate-decision="dismiss">忽略候选</button>
      </div>` : ''}
    </article>`;
  }).join('');
}

function renderProtocolHistory(protocol) {
  const items = [...protocol.outbox].reverse().slice(0, 5);
  if (!items.length) return '<div class="health-empty">尚无本地发布历史。</div>';
  return items.map((item) => `<article>
    <div><b>${esc(item.date)} · ${esc(stateLabel[item.healthState?.state] || '证据不足')}</b><span>${esc(item.deliveryStatus || 'local_pending')}</span></div>
    <p>容量 ${item.healthState?.availableCapacity == null ? '—' : `${Math.round(item.healthState.availableCapacity * 100)}%`} · 置信度 ${Math.round((item.healthState?.confidence || 0) * 100)}%</p>
    <small>${esc(item.snapshotId)}</small>
  </article>`).join('');
}

export function renderHealthPage(app) {
  const store = readHealthStore();
  const date = today();
  const manualRecord = store.observations.find((item) => item.date === date && item.source === 'manual')
    || normalizeHealthObservation({ date, source: 'manual' });
  const assessment = deriveHealthAssessment(store.observations, date);
  const baseline = assessment.baseline;
  const capacity = assessment.availableCapacity == null ? '—' : `${Math.round(assessment.availableCapacity * 100)}%`;
  const protocol = readHealthProtocolStore();
  const preview = buildHealthProtocolSnapshot(store, date);
  const lastPublished = protocol.latest?.date === date ? protocol.latest.publishedAt : null;
  const pendingCandidates = store.candidates.filter((item) => item.status === 'pending').length;
  const contextCandidates = store.candidates.filter((item) => item.status === 'context_only').length;
  const publicationAge = protocol.latest?.publishedAt ? Date.now() - new Date(protocol.latest.publishedAt).getTime() : Infinity;
  const publicationStatus = !protocol.latest
    ? '尚未发布快照'
    : preview.snapshotId !== protocol.latest.snapshotId
      ? '当前记录有未发布变化'
      : publicationAge > 36 * 60 * 60 * 1000
        ? '最新快照已超过36小时'
        : '当前快照已发布且在时效内';
  const evidenceStatus = assessment.reading.conflicts.length
    ? `${assessment.reading.conflicts.length} 项来源冲突`
    : assessment.reading.missing.length
      ? `缺 ${assessment.reading.missing.length} 项关键数据`
      : `${assessment.reading.sources.length} 类来源可追溯`;

  app.innerHTML = `<main class="page health-page safe-top">
    <header class="health-top">
      <button id="healthBack" aria-label="返回参谋部">←</button>
      <div><span>HEALTH & ENERGY OS · P1</span><h1>今日可用容量</h1></div>
      <em class="${assessment.state}">${stateLabel[assessment.state]}</em>
    </header>

    <section class="health-vital">
      <div class="health-capacity ${assessment.state}"><b>${capacity}</b><span>CAPACITY</span></div>
      <div class="health-verdict"><span>${esc(evidenceStatus)}</span><p>${esc(assessment.reasons.join(' · '))}</p><small>容量用于资源决策，不构成医疗诊断；冲突和缺失不会被推断为正常。</small></div>
      <dl>
        <div><dt>个人基线睡眠</dt><dd>${baseline.averageSleep ?? '—'} h</dd></div>
        <div><dt>个人基线精力</dt><dd>${baseline.averageEnergy ?? '—'} / 5</dd></div>
        <div><dt>基线状态</dt><dd>${baseline.ready ? `${baseline.sampleDays} 天可用` : `${baseline.sampleDays}/${baseline.minimumSampleDays} 天`}</dd></div>
      </dl>
    </section>

    <section class="health-block">
      <header><div><span>SUBJECTIVE SIGNAL</span><h2>${date} 本人记录</h2></div><p>主观感受与设备数据并列保留。</p></header>
      <div class="health-form">
        <label>睡眠小时<input class="input" id="healthSleep" type="number" min="0" max="24" step="0.5" value="${manualRecord.sleepHours ?? ''}"></label>
        <label>主观精力<select class="input" id="healthEnergy"><option value="">未记录</option>${[1, 2, 3, 4, 5].map((value) => `<option value="${value}" ${manualRecord.energy === value ? 'selected' : ''}>${value} / 5</option>`).join('')}</select></label>
        <label>本人关注级别<select class="input" id="healthRisk"><option value="none" ${manualRecord.riskLevel === 'none' ? 'selected' : ''}>没有主动标记</option><option value="attention" ${manualRecord.riskLevel === 'attention' ? 'selected' : ''}>需要关注</option><option value="professional" ${manualRecord.riskLevel === 'professional' ? 'selected' : ''}>需要专业关注</option></select></label>
        <label>运动<input class="input" id="healthTraining" value="${esc(manualRecord.training)}" placeholder="训练或恢复活动"></label>
        <label>重要饮食<input class="input" id="healthNutrition" value="${esc(manualRecord.nutrition)}" placeholder="只记可能影响状态的部分"></label>
        <label>症状原话<input class="input" id="healthSymptoms" value="${esc(manualRecord.symptoms)}" placeholder="忠实记录，不自动诊断"></label>
        <label class="health-notes">补充<textarea class="input" id="healthNotes" rows="2">${esc(manualRecord.notes)}</textarea></label>
      </div>
      <button class="health-save" id="healthSave">保存本人记录</button>
    </section>

    <section class="health-block health-source-block">
      <header><div><span>SOURCE INTAKE</span><h2>接入一条外部健康事实</h2></div><p>保留来源和置信度，不覆盖本人记录。</p></header>
      <div class="health-source-form">
        <label>日期<input class="input" id="healthSourceDate" type="date" value="${date}"></label>
        <label>来源<select class="input" id="healthSource"><option value="wearable">穿戴/健康数据</option><option value="medical_record">专业记录</option></select></label>
        <label>睡眠小时<input class="input" id="healthSourceSleep" type="number" min="0" max="24" step="0.1"></label>
        <label>精力（如来源提供）<input class="input" id="healthSourceEnergy" type="number" min="1" max="5" step="1"></label>
        <label>置信度<input class="input" id="healthSourceConfidence" type="number" min="0" max="1" step="0.05" value="0.75"></label>
        <label class="wide">来源说明<input class="input" id="healthSourceNotes" placeholder="设备、记录名称或必要上下文；不要粘贴无关隐私"></label>
      </div>
      <button class="health-save secondary" id="healthAddSource">保存来源化观测</button>
      <div class="health-source-ledger">${renderSourceLedger(store.observations)}</div>
    </section>

    <section class="health-block health-source-block">
      <header><div><span>V2 CANDIDATE INBOX</span><h2>待确认观测收件箱</h2></div><p>待确认 ${pendingCandidates} · 无时序上下文 ${contextCandidates}</p></header>
      <p>支持导入 V2 <code>04-claims-observations.jsonl</code> 或 JSON 数组；只接收 health 域。原文、sourceRef、authority 与日期映射会保留，未经确认绝不成为 Observation。</p>
      <input class="input" id="healthCandidateFile" type="file" accept=".json,.jsonl,application/json">
      <button class="health-save secondary" id="healthImportCandidates">导入候选文件</button>
      <div class="health-source-ledger">${renderCandidateInbox(store.candidates)}</div>
    </section>

    <section class="health-block">
      <header><div><span>CONTINUOUS TRACE</span><h2>个人趋势</h2></div><p>单点只记录，连续偏离才升级。</p></header>
      <div class="health-trail">${renderTrend(store.observations)}</div>
    </section>

    <section class="health-block">
      <header><div><span>INTERVENTION LOOP</span><h2>干预与验证</h2></div><p>结果只沉淀为证据，不自动改规则。</p></header>
      <div class="health-intervention-form">
        <input class="input" id="healthTarget" placeholder="本轮唯一主要变量">
        <input class="input" id="healthAction" placeholder="具体干预动作">
        <input class="input" id="healthEvaluation" type="date" aria-label="验证日期">
        <input class="input" id="healthSuccess" placeholder="成功条件">
        <input class="input" id="healthStop" placeholder="停止条件">
        <button id="healthAddIntervention">开始验证</button>
      </div>
      <div class="health-interventions">${renderInterventions(store.interventions)}</div>
    </section>

    <section class="health-block health-protocol">
      <header><div><span>MINIMUM PROTOCOL</span><h2>发布容量与约束</h2></div><p>${esc(publicationStatus)}${lastPublished ? ` · ${esc(new Date(lastPublished).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }))}` : ''}</p></header>
      <div class="health-protocol-band ${assessment.state}">
        <article><span>给时间系统</span><b>${capacity}</b><p>${preview.timeSystem.constraints.map(esc).join(' · ') || '维持常规负载，无新增恢复约束'}</p></article>
        <article><span>给日省</span><b>${stateLabel[assessment.state]} · ${Math.round(assessment.confidence * 100)}%</b><p>仅含状态、容量、缺失/冲突、来源摘要和干预验证日期。</p></article>
      </div>
      <button class="health-publish" id="healthPublish">确认发布本日最小快照</button>
      <small class="health-protocol-note">消费者：HQ、时间系统、日省（均只读）。发布只写入本地协议 outbox；同日同内容使用稳定快照 ID，不重复入队；不创建 TaskBox 任务、不改日历、不向 HQ 暴露原始症状。</small>
      <div class="health-source-ledger">${renderProtocolHistory(protocol)}</div>
    </section>

    <aside class="health-safety"><strong>安全边界</strong><p>如果你认为存在紧急或高风险情况，停止非必要负载并寻求合适的专业帮助；本系统不提供诊断、药物或治疗建议。</p></aside>
  </main>`;

  app.querySelector('#healthBack').onclick = () => navigate('#hq');
  mountSystemCandidateInbox(app, 'health', '.health-block');
  app.querySelector('#healthSave').onclick = () => {
    const observation = normalizeHealthObservation({
      observationId: `health-observation-${date}-manual`,
      date,
      sleepHours: app.querySelector('#healthSleep').value,
      energy: app.querySelector('#healthEnergy').value,
      riskLevel: app.querySelector('#healthRisk').value,
      training: app.querySelector('#healthTraining').value,
      nutrition: app.querySelector('#healthNutrition').value,
      symptoms: app.querySelector('#healthSymptoms').value,
      notes: app.querySelector('#healthNotes').value,
      source: 'manual',
      confidence: 0.8,
      observedAt: new Date().toISOString(),
    });
    writeHealthStore(upsertHealthObservation(readHealthStore(), observation));
    showToast('本人健康记录已保存');
    renderHealthPage(app);
  };
  app.querySelector('#healthAddSource').onclick = () => {
    const sourceDate = app.querySelector('#healthSourceDate').value;
    const source = app.querySelector('#healthSource').value;
    const sleepHours = app.querySelector('#healthSourceSleep').value;
    const energy = app.querySelector('#healthSourceEnergy').value;
    if (!sourceDate || (sleepHours === '' && energy === '')) return showToast('至少填写日期和一项健康数据');
    const observation = normalizeHealthObservation({
      observationId: `health-observation-${sourceDate}-${source}`,
      date: sourceDate,
      source,
      sleepHours,
      energy,
      confidence: app.querySelector('#healthSourceConfidence').value,
      notes: app.querySelector('#healthSourceNotes').value,
      observedAt: new Date().toISOString(),
    });
    writeHealthStore(upsertHealthObservation(readHealthStore(), observation));
    showToast('来源化观测已保存');
    renderHealthPage(app);
  };
  app.querySelector('#healthImportCandidates').onclick = async () => {
    const file = app.querySelector('#healthCandidateFile').files[0];
    if (!file) return showToast('先选择 V2 JSONL 或 JSON 文件');
    try {
      const records = parseCandidateRecords(await file.text());
      const current = readHealthStore();
      const next = importHealthCandidateRecords(current, records);
      const imported = next.candidates.length - current.candidates.length;
      writeHealthStore(next);
      showToast(`已导入 ${imported} 条新的 health 候选，全部保持待确认`);
      renderHealthPage(app);
    } catch {
      showToast('候选文件解析失败，请检查 JSONL/JSON 格式');
    }
  };
  app.querySelectorAll('[data-candidate-decision]').forEach((button) => {
    button.onclick = () => {
      const row = button.closest('[data-health-candidate]');
      const candidate = readHealthStore().candidates.find((item) => item.candidateId === row.dataset.healthCandidate);
      const decision = button.dataset.candidateDecision;
      const next = decideHealthCandidate(readHealthStore(), row.dataset.healthCandidate, decision, {
        sourceAuthority: 'explicit_user',
        resolvedAt: new Date().toISOString(),
        decisionId: `health-candidate-decision:${row.dataset.healthCandidate}:${decision}`,
      });
      writeHealthStore(next);
      showToast(decision === 'dismiss'
        ? '候选已忽略，未写入健康事实'
        : candidate?.temporalEligible
          ? '已按明确活动日期转为 daily_review Observation'
          : '已确认为上下文；因日期不明确，不进入 Observation 或28日趋势');
      renderHealthPage(app);
    };
  });
  app.querySelector('#healthAddIntervention').onclick = () => {
    const targetDeviation = app.querySelector('#healthTarget').value.trim();
    const action = app.querySelector('#healthAction').value.trim();
    const evaluationAt = app.querySelector('#healthEvaluation').value;
    const successCondition = app.querySelector('#healthSuccess').value.trim();
    const stopCondition = app.querySelector('#healthStop').value.trim();
    if (!targetDeviation || !action || !evaluationAt || !successCondition || !stopCondition) return showToast('补齐偏差、动作、日期、成功和停止条件');
    const result = beginHealthIntervention(readHealthStore(), normalizeIntervention({
      primaryVariable: targetDeviation,
      targetDeviation,
      action,
      evaluationAt,
      successCondition,
      stopCondition,
      startAt: date,
    }));
    if (!result.started) return showToast(result.reason);
    writeHealthStore(result.store);
    showToast('干预已进入验证周期');
    renderHealthPage(app);
  };
  app.querySelectorAll('[data-outcome]').forEach((button) => {
    button.onclick = () => {
      const row = button.closest('[data-intervention]');
      const id = row.dataset.intervention;
      const evaluationResult = row.querySelector('input').value.trim();
      if (!evaluationResult) return showToast('先填写验证证据或结果');
      const current = readHealthStore();
      writeHealthStore({
        ...current,
        interventions: current.interventions.map((item) => item.id === id ? {
          ...item,
          status: 'completed',
          outcome: button.dataset.outcome,
          evaluationResult,
          evaluatedAt: new Date().toISOString(),
        } : item),
      });
      showToast('验证结果已保存，未自动改写规则');
      renderHealthPage(app);
    };
  });
  app.querySelector('#healthPublish').onclick = () => {
    publishHealthSnapshot(readHealthStore(), date);
    showToast('最小健康快照已发布到本地 outbox');
    renderHealthPage(app);
  };
}
