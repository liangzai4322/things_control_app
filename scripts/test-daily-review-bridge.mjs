import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const bundled = path.join(
  os.homedir(),
  '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'python',
  process.platform === 'win32' ? 'python.exe' : 'bin/python3',
);
const candidates = [process.env.PYTHON, fs.existsSync(bundled) ? bundled : null, 'python3', 'python'].filter(Boolean);
let last = null;

for (const executable of candidates) {
  const result = spawnSync(executable, ['integrations/daily-review/test_daily_review_bridge.py'], {
    cwd: path.resolve('.'),
    encoding: 'utf8',
  });
  if (result.error?.code === 'ENOENT') continue;
  last = result;
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.status ?? 1);
}

throw last?.error || new Error('Python runtime not found');
