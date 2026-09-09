import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncHqReceipts } from './sync-hq-daily-intake-receipts.mjs';

assert.match(fs.readFileSync(new URL('./sync-hq-daily-intake-receipts.mjs', import.meta.url), 'utf8'), /CREDENTIALS_DIRECTORY/);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-receipts-'));
const tokenFile = path.join(root, 'hq.token');
const cacheFile = path.join(root, 'cache', 'receipts.json');
const disableFile = path.join(root, 'disabled');
const lockFile = path.join(root, 'cache', 'sync.lock');
fs.writeFileSync(tokenFile, 'fixture-token\n', { mode: 0o600 });
let calls = 0;
const fetchImpl = async (_url, options) => {
  calls += 1;
  assert.equal(options.headers.Authorization, 'Bearer fixture-token');
  return { ok: true, json: async () => ({ receipts: [{ id: 'r1', intakeId: 'i1', systemId: 'health', reviewDate: '2026-09-03', status: 'processed', revision: 1, projection: { riskLevel: 'none', factRefs: ['f1'], candidateBody: 'secret' }, data: { secret: true } }] }) };
};
const result = await syncHqReceipts({ endpoint: 'https://fixture.invalid', tokenFile, cacheFile, disableFile, lockFile, fetchImpl });
assert.equal(result.receiptCount, 1);
assert.equal(fs.statSync(cacheFile).mode & 0o777, 0o600);
const cache = JSON.parse(fs.readFileSync(cacheFile));
assert.equal(cache.receipts.length, 1);
assert.ok(!Object.hasOwn(cache.receipts[0], 'data'));
assert.ok(!Object.hasOwn(cache.receipts[0].projection, 'candidateBody'));
fs.writeFileSync(disableFile, 'disabled\n');
const disabled = await syncHqReceipts({ tokenFile, cacheFile, disableFile, lockFile, fetchImpl });
assert.equal(disabled.skipped, 'disabled');
assert.equal(calls, 1);
console.log('hq daily intake runner tests passed');
