import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const sourceDir = process.argv[2];
const outputPath = process.argv[3];
if (!sourceDir || !outputPath) throw new Error('usage: node scripts/build-five-system-bootstrap.mjs V2_DATA_DIR OUTPUT.json');
const readJsonl = async (name) => (await readFile(path.join(sourceDir, name), 'utf8')).split(/\r?\n/).filter(Boolean).map(JSON.parse);
const [claimsObservations, semanticClusters, validatedFacts, patternCandidates, calibrationProposals] = await Promise.all([
  readJsonl('04-claims-observations.jsonl'), readJsonl('05-semantic-clusters.jsonl'), readJsonl('06-validated-facts.jsonl'),
  readJsonl('07-patterns.jsonl'), readJsonl('08-calibration-proposals.jsonl'),
]);
const payload = {
  schemaVersion: 'five-system-bootstrap-v1',
  dataset: {
    runId: 'historical-daily-review-backfill-v2-2026-06-29_2026-08-08', pipelineVersion: '2.0.0',
    sourceRef: 'private-local:014人生参谋部五系统/历史日省回填/首轮30日-V2',
    reviewRange: { earliest: '2026-06-29', latest: '2026-08-08' }, sourceReviewCount: 30,
  },
  permissions: { writesTargetSystems: false, createsTaskboxTasks: false, activatesRulesOrExperiments: false },
  claimsObservations, semanticClusters, validatedFacts, patternCandidates, calibrationProposals,
};
const canonical = JSON.stringify(payload);
payload.packageSha256 = createHash('sha256').update(canonical).digest('hex');
await writeFile(outputPath, `${JSON.stringify(payload)}\n`, 'utf8');
console.log(JSON.stringify({ ok: true, outputPath, packageSha256: payload.packageSha256, counts: {
  claimsObservations: claimsObservations.length, semanticClusters: semanticClusters.length, validatedFacts: validatedFacts.length,
  patternCandidates: patternCandidates.length, calibrationProposals: calibrationProposals.length,
} }, null, 2));
