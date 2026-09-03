import fs from 'node:fs';
import { buildFeedbackDailyIntakeReceipt } from '../../js/feedback-daily-intake.js';

const endpoint = String(process.env.FEEDBACK_DAILY_INTAKE_ENDPOINT || 'http://127.0.0.1:3107/v1').replace(/\/$/, '');
const tokenFile = process.env.FEEDBACK_DAILY_INTAKE_TOKEN_FILE || '/etc/taskbox-daily-intake/feedback.token';
const disableFile = process.env.DAILY_INTAKE_DISABLE_FILE || '/etc/taskbox-daily-intake.disabled';
const lockFile = process.env.FEEDBACK_DAILY_INTAKE_LOCK_FILE || '/run/taskbox-feedback-daily-intake/runner.js.lock';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function token() {
  return fs.readFileSync(tokenFile, 'utf8').trim();
}

async function request(path, options = {}, attempt = 0) {
  let response;
  try {
    response = await fetch(`${endpoint}${path}`, {
      ...options,
      headers: { Accept: 'application/json', Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(12_000),
    });
  } catch (error) {
    if (attempt < 3) { await sleep(250 * (2 ** attempt)); return request(path, options, attempt + 1); }
    throw error;
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    if ([408, 425, 429, 500, 502, 503, 504].includes(response.status) && attempt < 3) {
      await sleep(250 * (2 ** attempt)); return request(path, options, attempt + 1);
    }
    const error = new Error(payload.error || `feedback_intake_http_${response.status}`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

async function list(status, limit = 100) {
  const result = await request(`/system-candidates?intake=1&systemId=feedback&status=${status}&limit=${limit}`);
  if (!Array.isArray(result.intakes)) throw new Error('invalid_feedback_intake_response');
  return result.intakes;
}

async function run({ probe = false } = {}) {
  if (fs.existsSync(disableFile)) return { ok: true, disabled: true, processed: 0, failed: 0 };
  const accepted = await list('accepted', probe ? 1 : 100);
  const retrying = await list('retrying', probe ? 1 : 100);
  if (probe) return { ok: true, disabled: false, queueDepth: accepted.length + retrying.length };
  const records = [...new Map([...accepted, ...retrying].map((item) => [item.id, item])).values()];
  let processed = 0; let ignored = 0; const failures = [];
  for (const intake of records) {
    try {
      const { receipt } = buildFeedbackDailyIntakeReceipt(intake);
      await request(`/system-candidates/${encodeURIComponent(intake.id)}/receipt`, { method: 'POST', body: JSON.stringify(receipt) });
      if (receipt.status === 'processed') processed += 1; else ignored += 1;
    } catch (error) {
      failures.push({ intakeId: intake.id, code: error.message, status: error.status || 0 });
    }
  }
  return { ok: failures.length === 0, disabled: false, queueDepth: records.length, processed, ignored, failed: failures.length, failures };
}

let lock;
try {
  lock = fs.openSync(lockFile, 'wx', 0o600);
} catch (error) {
  if (error.code === 'EEXIST') { console.log(JSON.stringify({ ok: true, locked: true })); process.exit(0); }
  throw error;
}
try {
  const result = await run({ probe: process.argv.includes('--probe') });
  console.log(JSON.stringify(result));
  if (!result.ok) process.exitCode = 1;
} finally {
  fs.closeSync(lock);
  fs.rmSync(lockFile, { force: true });
}
