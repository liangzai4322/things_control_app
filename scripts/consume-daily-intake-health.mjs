import fs from 'node:fs';
import path from 'node:path';
import { createHealthDailyIntakeWorkerFromEnv } from '../integrations/health-system/daily-intake-worker.mjs';

const args = new Set(process.argv.slice(2));
const lockFile = process.env.HEALTH_DAILY_INTAKE_LOCK_FILE || '/tmp/taskbox-health-daily-intake.lock';
const stateFile = process.env.HEALTH_DAILY_INTAKE_STATE_FILE || '/var/lib/taskbox-health-daily-intake/status.json';

function writeState(value) {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true, mode: 0o750 });
  const temporary = `${stateFile}.tmp.${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o640 });
  fs.renameSync(temporary, stateFile);
}

function acquireLock() {
  const create = () => {
    const descriptor = fs.openSync(lockFile, 'wx', 0o600);
    fs.writeFileSync(descriptor, `${process.pid}\n`);
    return () => { try { fs.closeSync(descriptor); } catch {} try { fs.unlinkSync(lockFile); } catch {} };
  };
  try {
    return create();
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const owner = Number(readFileSafe(lockFile));
    try { if (owner > 0) process.kill(owner, 0); return null; }
    catch (signalError) {
      if (signalError.code !== 'ESRCH') return null;
      try { fs.unlinkSync(lockFile); } catch { return null; }
      return create();
    }
  }
}

function readFileSafe(filePath) {
  try { return fs.readFileSync(filePath, 'utf8').trim(); } catch { return ''; }
}

const release = acquireLock();
if (!release) {
  console.log(JSON.stringify({ ok: true, skipped: 'lock_held' }));
  process.exit(0);
}

const startedAt = new Date().toISOString();
try {
  const worker = createHealthDailyIntakeWorkerFromEnv();
  const result = args.has('--probe') ? await worker.probe() : await worker.runOnce();
  const state = { ok: true, startedAt, completedAt: new Date().toISOString(), ...result };
  writeState(state);
  console.log(JSON.stringify(state));
} catch (error) {
  const state = {
    ok: false, startedAt, failedAt: new Date().toISOString(),
    error: error.code || error.message || 'health_daily_intake_failed',
    status: Number(error.status) || 0,
  };
  writeState(state);
  console.error(JSON.stringify(state));
  process.exitCode = 1;
} finally {
  release();
}
