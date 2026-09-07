import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { selectSystemReceipts, normalizeSystemReceipt } from '../js/hq-system-receipts.js';

const require = createRequire(import.meta.url);
const { normalizeFreshness, inferPayloadKind, compatibilityShape } = require('../server/taskbox-api/src/daily-intake-transport.js');
const fixture = JSON.parse(fs.readFileSync(new URL('../server/taskbox-api/fixtures/daily-intake-real-shape-redacted.json', import.meta.url)));

assert.deepEqual(normalizeFreshness(fixture.freshness), { status: 'fresh', generatedAt: '2026-09-07T03:24:00.432Z' });
assert.deepEqual(normalizeFreshness('unknown'), { status: 'unknown', generatedAt: null });
assert.deepEqual(normalizeFreshness({ status: 'stale', generatedAt: '2026-09-06T00:00:00Z' }), { status: 'stale', generatedAt: '2026-09-06T00:00:00.000Z' });
assert.equal(inferPayloadKind(fixture.cases.execution.data), 'candidate_batch');
assert.equal(inferPayloadKind({ currentActions: [] }), 'domain_snapshot');
assert.equal(inferPayloadKind({}, 'candidate_batch'), 'candidate_batch');
assert.throws(() => inferPayloadKind({}, 'unknown_kind'), /invalid_payload_kind/);
assert.deepEqual(compatibilityShape({ data: fixture.cases.execution.data, freshness: fixture.freshness }), {
  payloadKind: 'candidate_batch', freshness: { status: 'fresh', generatedAt: '2026-09-07T03:24:00.432Z' },
});

const selected = selectSystemReceipts({ receipts: [
  { systemId: 'execution', effectiveDate: '2026-09-07', receiptId: 'old', revision: 1, updatedAt: '2026-09-07T01:00:00Z' },
  { systemId: 'execution', effectiveDate: '2026-09-07', receiptId: 'new', revision: 2, updatedAt: '2026-09-07T00:00:00Z' },
  { systemId: 'feedback', effectiveDate: '2026-09-07', receiptId: 'feedback', revision: 1, projection: { inputGaps: [{ code: 'missing_field', field: 'data.reviewDate', severity: 'high' }] }, errorCode: 'ignored' },
] }, '2026-09-07');
assert.deepEqual(selected.map((item) => item.receiptId), ['new', 'feedback']);
const normalized = normalizeSystemReceipt(selected[1]);
assert.deepEqual(normalized.inputGaps, [{ code: 'missing_field', field: 'data.reviewDate', severity: 'high' }]);
assert.equal(normalized.errorCode, 'ignored');

console.log('daily intake compatibility tests passed');
