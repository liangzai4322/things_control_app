const clean = (value) => String(value ?? '').trim();
const clone = (value, fallback = null) => {
  try { return value == null ? fallback : JSON.parse(JSON.stringify(value)); }
  catch { return fallback; }
};

const LAYERS = new Set(['observation', 'claim', 'pattern_candidate', 'calibration_proposal']);

function candidateLayer(value = {}) {
  if (value.patternId) return 'pattern_candidate';
  if (value.proposalId) return 'calibration_proposal';
  return value.recordType;
}

function candidateId(value = {}) {
  return clean(value.claimId || value.patternId || value.proposalId || value.candidateLineId);
}

function candidateContent(value = {}) {
  return clean(value.content || value.statement || value.title || value.sourceExcerpt || value.hypothesis);
}

export function adaptMissionV2Candidate(value = {}, { importedAt = new Date().toISOString() } = {}) {
  const layer = candidateLayer(value);
  const id = candidateId(value);
  if (value.domain !== 'mission' || !LAYERS.has(layer) || !id || !candidateContent(value)) return null;
  return {
    candidateId: id,
    candidateLineId: clean(value.candidateLineId) || null,
    domain: 'mission',
    v2Layer: layer,
    content: candidateContent(value),
    authority: clean(value.authority) || 'unknown',
    epistemicState: clean(value.epistemicState || value.status) || 'unknown',
    sourceRef: clone(value.sourceRef),
    evidenceRefs: clone(value.evidenceRefs, []),
    dateMapping: clone(value.activity?.dateMapping ?? value.dateMapping ?? 'unknown'),
    activity: clone(value.activity),
    confidence: Number.isFinite(Number(value.confidence)) ? Number(value.confidence) : null,
    importedAt,
    decision: { status: 'unreviewed', decidedAt: null, decidedBy: null, publishedVersionId: null },
  };
}

export function parseMissionV2Text(input, options = {}) {
  const source = clean(input);
  if (!source) return { candidates: [], rejected: [] };
  let rows;
  try {
    const parsed = JSON.parse(source);
    rows = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    rows = source.split(/\r?\n/).filter((line) => line.trim()).map((line, index) => {
      try { return JSON.parse(line); }
      catch { return { __parseError: `第 ${index + 1} 行不是有效 JSON` }; }
    });
  }
  const candidates = []; const rejected = [];
  rows.forEach((row) => {
    if (row.__parseError) { rejected.push(row.__parseError); return; }
    const candidate = adaptMissionV2Candidate(row, options);
    if (candidate) candidates.push(candidate);
    else rejected.push(candidateId(row) || '非 mission 域、层级不允许或缺少必要内容');
  });
  return { candidates, rejected };
}
