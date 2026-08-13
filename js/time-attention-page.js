import { getTasks, getTimelineTasks } from './db.js';
import { navigate, showToast } from './app.js';
import {
  buildTimeCandidateInbox,
  buildUnifiedTimeDay,
  buildTimeAttentionSnapshot,
  clockMinutes,
  normalizeTimePlan,
  parseIcsCalendar,
  summarizeTimeWeek,
} from './time-attention-model.js';
import { addTimeCandidates, confirmTimeCandidateDate, readTimeStore, rejectTimeCandidate, upsertTimePlan, writeTimeStore } from './time-attention-store.js';
import { buildHealthHqSnapshot } from './health-model.js';
import { readHealthProtocolStore } from './health-store.js';
import { mountSystemCandidateInbox } from './system-candidate-inbox.js';

const esc = (value = '') => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
const labels = { unknown: '等待计划', protected: '时段已保护', warning: '存在偏差', overloaded: '已经超载' };
const timeText = (minutes) => minutes == null ? '—' : minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
const clockText = (value) => new Date(value).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false });
const dateKey = (value) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date(value));

function taskOptions(selected, tasks) {
  return `<option value="">暂不绑定任务</option>${tasks.filter((task) => !task.deleted && !task.isCompleted && !task.isRecurringTemplate).map((task) => `<option value="${esc(task.id)}" ${task.id === selected ? 'selected' : ''}>${esc(task.content)}</option>`).join('')}`;
}

function tape(day) {
  const { plan, commitments } = day;
  const start = clockMinutes(plan.focusStart);
  const end = clockMinutes(plan.focusEnd);
  const valid = start != null && end != null && end > start;
  const segments = commitments.filter((event) => !event.allDay).map((event) => {
    const eventStart = new Date(event.startAt);
    const eventEnd = new Date(event.endAt);
    const startMinute = Number(clockText(eventStart).slice(0, 2)) * 60 + Number(clockText(eventStart).slice(3));
    const endMinute = dateKey(eventEnd) === day.date ? Number(clockText(eventEnd).slice(0, 2)) * 60 + Number(clockText(eventEnd).slice(3)) : 1440;
    const left = Math.max(0, startMinute / 1440 * 100);
    const width = Math.max(.5, (Math.min(1440, endMinute) - startMinute) / 1440 * 100);
    return `<i class="time-calendar-segment" style="--start:${left}%;--duration:${width}%" title="${esc(event.title)} ${esc(clockText(event.startAt))}–${esc(clockText(event.endAt))}"></i>`;
  }).join('');
  const left = valid ? start / 1440 * 100 : 0;
  const width = valid ? (end - start) / 1440 * 100 : 0;
  return `<div class="time-tape"><div class="time-ticks"><span>00</span><span>06</span><span>12</span><span>18</span><span>24</span></div><div class="time-track">${segments}<i class="time-focus-segment ${valid ? '' : 'empty'}" style="--start:${left}%;--duration:${width}%"><b>${valid ? `${plan.focusStart}–${plan.focusEnd}` : '尚未设置保护时段'}</b></i></div><div class="time-tape-legend"><span><i class="calendar"></i>外部固定事实</span><span><i class="focus"></i>人工计划保护时段</span></div></div>`;
}

function calendarRows(day) {
  if (day.calendarStatus !== 'connected') return '<div class="time-readonly-empty"><strong>尚未读取日历事实</strong><span>导入 .ics 快照后，只读取固定占用；不会修改源日历。</span></div>';
  if (!day.commitments.length) return '<div class="time-readonly-empty"><strong>今天没有外部固定占用</strong><span>快照已读取，人工计划仍保持独立。</span></div>';
  return day.commitments.map((event) => {
    const conflict = day.conflictSources.find((item) => item.sourceId === event.id);
    return `<article class="time-fact-row ${conflict ? 'conflict' : ''}"><span>${event.allDay ? '全天' : `${clockText(event.startAt)}–${clockText(event.endAt)}`}</span><strong>${esc(event.title)}</strong><small>${conflict ? `${esc(conflict.sourceName)} · ${esc(conflict.reason)}` : `${esc(day.calendarSourceName || '日历快照')} · busy事实 · 只读`}</small></article>`;
  }).join('');
}

function taskRows(day) {
  if (!day.taskReferences.length) return '<div class="time-readonly-empty compact"><strong>今天没有 TaskBox 排期引用</strong><span>这里只展示引用，不复制任务状态或正文到时间账本。</span></div>';
  return day.taskReferences.map((task) => `<article class="time-task-reference"><span>${clockText(task.scheduledAt)}</span><div><strong>${esc(task.title)}</strong><small>${esc(task.taskId)} · ${task.durationMinutes ? `需求 ${timeText(task.durationMinutes)}` : '时长待补充'} · 不是正式承诺</small></div><button data-open-time-task="${esc(task.taskId)}" data-time-task-box="${esc(task.boxId || '')}">查看任务</button></article>`).join('');
}

function readAtText(value) {
  if (!value) return '尚未读取';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '读取时间未知' : parsed.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
}

function parseCandidateFile(text) {
  const source = String(text || '').trim();
  if (!source) return [];
  if (source.startsWith('[')) return JSON.parse(source);
  return source.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line));
}

function candidateRows(inbox) {
  if (!inbox.candidates.length) return '<div class="time-readonly-empty"><strong>尚未导入时间候选</strong><span>仅接受 V2 time 域 observation / claim / source_proposal；候选不会成为事实或任务。</span></div>';
  return inbox.candidates.map((candidate) => {
    const mapping = candidate.activityStart && candidate.activityStart === candidate.activityEnd ? `单日映射 ${candidate.activityStart}` : candidate.dateMapping === 'range' ? '日期范围，不进入日级统计' : '日期未知，不进入日级统计';
    const status = candidate.status === 'baseline_fact' ? `V1历史事实 · ${candidate.baselineVersionId}` : candidate.status === 'baseline_context' ? `V1历史上下文 · ${candidate.baselineVersionId}` : candidate.status === 'confirmed_date' ? `已确认活动日 ${candidate.confirmedActivityDate} · 时间事实候选` : candidate.status === 'rejected' ? '已驳回' : '待核候选';
    const actions = candidate.status === 'pending'
      ? `<label>确认活动日期<input class="input" type="date" data-candidate-date="${esc(candidate.candidateId)}"></label><button data-confirm-time-candidate="${esc(candidate.candidateId)}">确认日期</button><button data-reject-time-candidate="${esc(candidate.candidateId)}">驳回</button>`
      : '';
    return `<article class="time-task-reference"><span>${esc(candidate.recordType)}</span><div><strong>${esc(candidate.content)}</strong><small>${esc(mapping)} · ${esc(status)} · ${esc(candidate.authority)}<br>${esc(candidate.sourceRef)}</small></div><div>${actions}</div></article>`;
  }).join('');
}

export function renderTimeAttentionPage(app) {
  const store = readTimeStore();
  const date = today();
  const tasks = getTasks();
  const timelineTasks = getTimelineTasks();
  const plan = store.plans.find((item) => item.date === date) || normalizeTimePlan({ date });
  const day = buildUnifiedTimeDay({ plan, calendar: store.calendar, tasks: timelineTasks, date });
  const healthSnapshot = buildHealthHqSnapshot(readHealthProtocolStore());
  const l1Snapshot = buildTimeAttentionSnapshot({ store, tasks: timelineTasks, healthSnapshot, date });
  const state = day.state;
  const week = summarizeTimeWeek(store.plans);
  const candidateInbox = buildTimeCandidateInbox(store);
  const fixedSource = day.calendarStatus === 'connected' ? '日历事实' : '人工计划';
  app.innerHTML = `<main class="page time-page safe-top"><header class="time-top"><button id="timeBack" aria-label="返回人生参谋部">←</button><div><span>TIME & ATTENTION OS · READ-ONLY V3</span><h1>今日认知带宽</h1></div><em class="${state.state}">${labels[state.state]}</em></header>
  <section class="time-hero"><div><span>PROTECTED WINDOW</span><h2>${state.focusMinutes == null ? '先保护一段完整时间' : `${timeText(state.focusMinutes)} 不被切碎`}</h2><p>${esc(state.reasons.join(' · '))}</p></div><dl><div><dt>可用</dt><dd>${timeText(plan.availableMinutes)}</dd></div><div><dt>已分配</dt><dd>${timeText(state.allocatedMinutes)}</dd></div><div><dt>剩余</dt><dd>${timeText(state.remainingMinutes)}</dd></div></dl>${tape(day)}</section>
  <section class="time-block time-readonly"><header><div><span>READ-ONLY FACTS</span><h2>外部日历固定事实</h2></div><p>${day.calendarStatus === 'connected' ? `${esc(day.calendarSourceName || '日历快照')} · 读取于 ${esc(readAtText(day.calendarReadAt))}` : '只开放本地快照读取'}</p></header><div class="time-import-actions"><label class="time-import-button">读取 .ics 快照<input id="timeCalendarFile" type="file" accept=".ics,text/calendar"></label>${day.calendarStatus === 'connected' ? '<button id="timeCalendarDisconnect">移除本地快照</button>' : ''}<small>读取后以日历 busy 区间计算固定占用；transparent / cancelled 不占容量。</small></div><div class="time-fact-list">${calendarRows(day)}</div><div class="time-readonly-summary"><span>${fixedSource}固定占用</span><strong>${timeText(day.effectiveFixedMinutes)}</strong><small>${day.calendarStatus === 'connected' && day.manualFixedMinutes !== day.calendarBusyMinutes ? `人工计划仍记录 ${timeText(day.manualFixedMinutes)}，两者保持分离` : '计划与事实未混写'}</small></div><div class="time-health-constraint"><span>健康容量只读约束</span><strong>${l1Snapshot.planningCapacityMinutes == null ? '容量依据不足' : `建议容量 ${timeText(l1Snapshot.planningCapacityMinutes)}`}</strong><small>${esc(l1Snapshot.healthCapacity.explanation)}${l1Snapshot.healthConstraints.length ? ` · ${esc(l1Snapshot.healthConstraints.join(' · '))}` : ''}</small></div></section>
  <section class="time-block time-readonly"><header><div><span>TASKBOX REFERENCES</span><h2>今日任务需求</h2></div><p>完成状态仍只来自 TaskBox</p></header><div class="time-task-list">${taskRows(day)}</div></section>
  <section class="time-block"><header><div><span>RESOURCE PLAN</span><h2>${date} 人工时间计划</h2></div><p>先扣固定承诺和缓冲，再保护主动作。</p></header><div class="time-plan-grid"><label>真实可用分钟<input class="input" id="timeAvailable" type="number" min="0" max="1440" value="${plan.availableMinutes ?? ''}"></label><label>人工计划固定分钟<input class="input" id="timeFixedMinutes" type="number" min="0" max="1440" value="${plan.fixedCommitmentMinutes}"></label><label>缓冲分钟<input class="input" id="timeBuffer" type="number" min="0" max="480" value="${plan.bufferMinutes}"></label><label>保护开始<input class="input" id="timeStart" type="time" value="${esc(plan.focusStart)}"></label><label>保护结束<input class="input" id="timeEnd" type="time" value="${esc(plan.focusEnd)}"></label><label>引用 TaskBox 任务<select class="input" id="timeTask">${taskOptions(plan.focusTaskId, tasks)}</select></label><label class="wide">人工计划固定承诺<input class="input" id="timeFixed" value="${esc(plan.fixedCommitments)}" placeholder="例如14:00会议、18:00出门"></label><label class="wide">用户确认的触发锚点<input class="input" id="timeAnchor" value="${esc(plan.triggerAnchor)}" placeholder="例如早餐结束后立即开始"></label></div></section>
  <section class="time-block"><header><div><span>REALITY CHECK</span><h2>日终实际投入</h2></div><p>${day.actualFocus.status === 'recorded' ? '实际投入来源：用户手动记录' : '实际投入未记录；TaskBox 排期不会代替实际。'}</p></header><div class="time-plan-grid settlement"><label>实际专注分钟<input class="input" id="timeActual" type="number" min="0" max="1440" value="${plan.actualFocusMinutes ?? ''}"></label><label>重要打断次数<input class="input" id="timeInterruptions" type="number" min="0" max="99" value="${plan.interruptions ?? ''}"></label><label>实际停止时间<input class="input" id="timeStopped" type="time" value="${esc(plan.stoppedAt)}"></label><label class="wide">最大注意力泄漏<input class="input" id="timeLeak" value="${esc(plan.biggestLeak)}" placeholder="今天什么最容易把完整时间切碎"></label><label class="wide">补充<textarea class="input" id="timeNotes" rows="2">${esc(plan.notes)}</textarea></label></div><button class="time-save" id="timeSave">保存人工计划与实际投入</button></section>
  <section class="time-block time-readonly"><header><div><span>V2 BASELINE + CANDIDATE INBOX</span><h2>时间历史基线与候选</h2></div><p>${candidateInbox.baselineFactCount} 条V1历史事实 · ${candidateInbox.baselineContextCount} 条上下文 · ${candidateInbox.pendingCount} 待核</p></header><div class="time-import-actions"><label class="time-import-button">导入 V2 JSON / JSONL<input id="timeCandidateFile" type="file" accept=".json,.jsonl,application/json"></label><small>V1历史基线来自用户明确发布并可整批回退；日常新增仍先进入候选层。</small></div><div class="time-task-list">${candidateRows(candidateInbox)}</div></section>
  <section class="time-block"><header><div><span>7 DAY CALIBRATION</span><h2>计划越来越准</h2></div></header><div class="time-week"><article><span>样本</span><b>${week.sampleDays} 天</b></article><article><span>计划专注</span><b>${timeText(week.plannedFocusMinutes)}</b></article><article><span>实际专注</span><b>${timeText(week.actualFocusMinutes)}</b></article><article><span>命中率</span><b>${week.adherence == null ? '—' : `${week.adherence}%`}</b></article><article><span>日均打断</span><b>${week.averageInterruptions ?? '—'}</b></article></div></section>
  <aside class="time-boundary"><strong>V3 版本边界</strong><p>健康容量、人工计划、ICS 日历事实、实际投入和 TaskBox 引用保持分离。已明确发布的历史基线可成为可回退事实；日常新增仍从候选进入，冲突与超载不写健康、日历或 TaskBox。</p></aside></main>`;

  app.querySelector('#timeBack').onclick = () => navigate('#hq');
  mountSystemCandidateInbox(app, 'time', '.time-block');
  app.querySelectorAll('[data-open-time-task]').forEach((button) => { button.onclick = () => navigate(button.dataset.timeTaskBox ? `#box/${button.dataset.timeTaskBox}/${button.dataset.openTimeTask}` : '#home'); });
  app.querySelector('#timeCalendarFile').onchange = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const calendar = parseIcsCalendar(await file.text(), { sourceName: file.name });
      writeTimeStore({ ...readTimeStore(), calendar });
      showToast(`已只读读取 ${calendar.events.length} 项日历事实`);
      renderTimeAttentionPage(app);
    } catch {
      showToast('日历快照读取失败，请确认文件为 .ics');
    }
  };
  app.querySelector('#timeCalendarDisconnect')?.addEventListener('click', () => {
    writeTimeStore({ ...readTimeStore(), calendar: {} });
    showToast('已移除本地日历快照，源日历未修改');
    renderTimeAttentionPage(app);
  });
  app.querySelector('#timeCandidateFile').onchange = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const imported = addTimeCandidates(readTimeStore(), parseCandidateFile(await file.text()));
      writeTimeStore(imported.store, localStorage, { touchFacts: false });
      showToast(`已导入 ${imported.accepted} 条时间候选，忽略 ${imported.ignored} 条`);
      renderTimeAttentionPage(app);
    } catch {
      showToast('候选读取失败，请确认文件为 V2 JSON 或 JSONL');
    }
  };
  app.querySelectorAll('[data-confirm-time-candidate]').forEach((button) => {
    button.onclick = () => {
      const input = [...app.querySelectorAll('[data-candidate-date]')].find((item) => item.dataset.candidateDate === button.dataset.confirmTimeCandidate);
      if (!input?.value) { showToast('请先选择明确活动日期'); return; }
      writeTimeStore(confirmTimeCandidateDate(readTimeStore(), button.dataset.confirmTimeCandidate, input.value), localStorage, { touchFacts: false });
      showToast('已确认活动日期；仍保持时间事实候选，不进入事实层');
      renderTimeAttentionPage(app);
    };
  });
  app.querySelectorAll('[data-reject-time-candidate]').forEach((button) => {
    button.onclick = () => {
      writeTimeStore(rejectTimeCandidate(readTimeStore(), button.dataset.rejectTimeCandidate, '用户在时间候选收件箱驳回'), localStorage, { touchFacts: false });
      showToast('候选已驳回');
      renderTimeAttentionPage(app);
    };
  });
  app.querySelector('#timeSave').onclick = () => {
    const saved = normalizeTimePlan({
      date,
      availableMinutes: app.querySelector('#timeAvailable').value,
      fixedCommitmentMinutes: app.querySelector('#timeFixedMinutes').value,
      bufferMinutes: app.querySelector('#timeBuffer').value,
      focusStart: app.querySelector('#timeStart').value,
      focusEnd: app.querySelector('#timeEnd').value,
      focusTaskId: app.querySelector('#timeTask').value,
      fixedCommitments: app.querySelector('#timeFixed').value,
      triggerAnchor: app.querySelector('#timeAnchor').value,
      actualFocusMinutes: app.querySelector('#timeActual').value,
      actualFocusSource: app.querySelector('#timeActual').value === '' ? null : 'explicit_user_manual',
      interruptions: app.querySelector('#timeInterruptions').value,
      stoppedAt: app.querySelector('#timeStopped').value,
      biggestLeak: app.querySelector('#timeLeak').value,
      notes: app.querySelector('#timeNotes').value,
    });
    writeTimeStore(upsertTimePlan(readTimeStore(), saved));
    showToast('人工计划与实际投入已保存');
    renderTimeAttentionPage(app);
  };
}
