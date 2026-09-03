import fs from 'node:fs';
import path from 'node:path';

const SYSTEM_IDS = new Set(['mission', 'health', 'attention', 'execution', 'feedback']);
const RECEIPT_FIELDS = ['id', 'intakeId', 'systemId', 'reviewDate', 'updatedAt', 'status', 'freshness', 'revision', 'projection'];
const PROJECTION_FIELDS = ['riskLevel', 'needsUserInput', 'inputGaps', 'factRefs', 'evidenceRefs', 'syncState'];
const text = (value) => String(value || '').trim();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function pick(source, fields) {
  return Object.fromEntries(fields.filter((key) => source?.[key] !== undefined).map((key) => [key, source[key]]));
}

export function sanitizeReceipt(item) {
  if (!item || typeof item !== 'object' || !SYSTEM_IDS.has(text(item.systemId))) return null;
  const safe = pick(item, RECEIPT_FIELDS);
  safe.projection = pick(item.projection && typeof item.projection === 'object' ? item.projection : {}, PROJECTION_FIELDS);
  return safe;
}

async function fetchReceipts({ endpoint, token, fetchImpl, attempts = 3 }) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(`${endpoint.replace(/\/+$/, '')}/v1/hq/system-receipts?limit=200`, {
        headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
      });
      if (!response.ok) throw Object.assign(new Error(`hq_receipts_http_${response.status}`), { status: response.status });
      const payload = await response.json();
      return (Array.isArray(payload?.receipts) ? payload.receipts : []).map(sanitizeReceipt).filter(Boolean);
    } catch (error) {
      lastError = error;
      if ([401, 403, 503].includes(Number(error.status)) || attempt === attempts) break;
      await sleep(250 * attempt);
    }
  }
  throw lastError;
}

export async function syncHqReceipts({
  endpoint = 'https://liangzai666.com/taskbox-api',
  tokenFile = '/etc/taskbox-daily-intake/hq.token',
  cacheFile = '/var/lib/taskbox-hq-daily-intake/receipts-summary.json',
  disableFile = '/etc/taskbox-daily-intake.disabled',
  lockFile = '/var/lib/taskbox-hq-daily-intake/sync.lock',
  fetchImpl = globalThis.fetch,
} = {}) {
  if (fs.existsSync(disableFile)) return { ok: true, skipped: 'disabled' };
  const token = text(fs.readFileSync(tokenFile, 'utf8'));
  if (!token) throw new Error('hq_receipts_token_missing');
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true, mode: 0o700 });
  let lock;
  try {
    lock = fs.openSync(lockFile, 'wx', 0o600);
  } catch (error) {
    if (error.code === 'EEXIST') return { ok: true, skipped: 'locked' };
    throw error;
  }
  try {
    const receipts = await fetchReceipts({ endpoint, token, fetchImpl });
    const body = JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(), receipts });
    const temporary = `${cacheFile}.tmp.${process.pid}`;
    fs.writeFileSync(temporary, `${body}\n`, { mode: 0o600 });
    fs.renameSync(temporary, cacheFile);
    fs.chmodSync(cacheFile, 0o600);
    return { ok: true, receiptCount: receipts.length };
  } finally {
    fs.closeSync(lock);
    fs.unlinkSync(lockFile);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const result = await syncHqReceipts({
      endpoint: process.env.DAILY_INTAKE_ENDPOINT,
      tokenFile: process.env.DAILY_INTAKE_HQ_TOKEN_FILE,
      cacheFile: process.env.HQ_DAILY_INTAKE_CACHE_FILE,
      disableFile: process.env.DAILY_INTAKE_DISABLE_FILE,
      lockFile: process.env.HQ_DAILY_INTAKE_LOCK_FILE,
    });
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: text(error.message).slice(0, 160) }));
    process.exitCode = 1;
  }
}

