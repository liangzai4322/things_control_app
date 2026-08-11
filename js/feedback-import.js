const clean = (value) => String(value || '').trim();

const emptyLayers = () => ({ observationsClaims: [], semanticClusters: [], patternCandidates: [], calibrationProposals: [] });

function classifyV2Record(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return '';
  if (record.claimId && record.recordType) return 'observationsClaims';
  if (record.clusterId && record.occurrenceCount != null) return 'semanticClusters';
  if (record.patternId && (record.basis || record.status)) return 'patternCandidates';
  if (record.proposalId && record.kind) return 'calibrationProposals';
  return '';
}

function ingestJsonValue(value, context, state) {
  if (Array.isArray(value)) {
    value.forEach((record, index) => ingestJsonValue(record, `${context}[${index}]`, state));
    return;
  }
  const layer = classifyV2Record(value);
  if (layer) {
    state.layers[layer].push(value);
    return;
  }
  const source = value?.v2Candidates || value;
  const hasV2Layers = source && typeof source === 'object' && ['observationsClaims', 'claimsObservations', 'claims', 'semanticClusters', 'clusters', 'patternCandidates', 'patterns', 'calibrationProposals', 'calibrations'].some((key) => Array.isArray(source[key]));
  if (hasV2Layers) {
    state.layers.observationsClaims.push(...(source.observationsClaims || source.claimsObservations || source.claims || []));
    state.layers.semanticClusters.push(...(source.semanticClusters || source.clusters || []));
    state.layers.patternCandidates.push(...(source.patternCandidates || source.patterns || []));
    state.layers.calibrationProposals.push(...(source.calibrationProposals || source.calibrations || []));
    state.metadata.push({ importId: clean(source.importId), datasetVersion: clean(source.datasetVersion || source.version), sourceRef: clean(source.sourceRef || source.sourceRoot) });
    return;
  }
  const continuity = value?.feedbackContinuity || value?.periodPayload?.feedbackContinuity || value?.payload?.feedbackContinuity;
  if (continuity || (value?.cycleKey && (Array.isArray(value.deviations) || Array.isArray(value.experiments) || Array.isArray(value.rules)))) {
    state.continuity.push(continuity || value);
    return;
  }
  state.errors.push(`${context}: 无法识别记录 schema`);
}

function parseJsonLines(text, fileName, state) {
  text.split(/\r?\n/).forEach((line, index) => {
    if (!line.trim()) return;
    try {
      ingestJsonValue(JSON.parse(line), `${fileName}:${index + 1}`, state);
    } catch (error) {
      state.errors.push(`${fileName}:${index + 1}: ${error.message}`);
    }
  });
}

export async function parseFeedbackImportFiles(files) {
  const selected = [...(files || [])];
  if (!selected.length) return { error: '未选择导入文件', errors: ['未选择导入文件'], mode: null, payload: null };
  const state = { layers: emptyLayers(), continuity: [], metadata: [], errors: [] };
  for (const file of selected) {
    const fileName = clean(file?.name) || 'unnamed';
    let text = '';
    try {
      text = await file.text();
    } catch (error) {
      state.errors.push(`${fileName}: 无法读取文件：${error.message}`);
      continue;
    }
    if (/\.jsonl$/i.test(fileName)) parseJsonLines(text, fileName, state);
    else if (/\.json$/i.test(fileName)) {
      try { ingestJsonValue(JSON.parse(text), fileName, state); }
      catch (error) { state.errors.push(`${fileName}: ${error.message}`); }
    } else state.errors.push(`${fileName}: 仅支持 .json 或 .jsonl`);
  }
  if (state.errors.length) return { error: `导入批次包含 ${state.errors.length} 个错误，未写入任何数据`, errors: state.errors, mode: null, payload: null };
  const hasV2 = Object.values(state.layers).some((items) => items.length);
  if (hasV2 && state.continuity.length) return { error: '同一批次不能混合 V2 候选与连续性载荷', errors: ['同一批次不能混合 V2 候选与连续性载荷'], mode: null, payload: null };
  if (hasV2) {
    const missing = Object.entries(state.layers).filter(([, items]) => !items.length).map(([key]) => key);
    if (missing.length) return { error: `V2 批次缺少层级：${missing.join(', ')}`, errors: [`V2 批次缺少层级：${missing.join(', ')}`], mode: null, payload: null };
    const names = selected.map((file) => clean(file.name)).sort();
    const metadata = state.metadata.find((item) => item.importId || item.sourceRef || item.datasetVersion) || {};
    return {
      error: null, errors: [], mode: 'v2',
      payload: {
        importId: metadata.importId || `feedback-v2:files:${names.join('|')}`,
        datasetVersion: metadata.datasetVersion || 'v2', sourceRef: metadata.sourceRef || `browser-files:${names.join('|')}`,
        ...state.layers,
      },
    };
  }
  if (state.continuity.length !== 1) {
    const message = state.continuity.length ? '一次只能导入一个连续性载荷' : '没有识别到可导入数据';
    return { error: message, errors: [message], mode: null, payload: null };
  }
  return { error: null, errors: [], mode: 'continuity', payload: state.continuity[0] };
}
