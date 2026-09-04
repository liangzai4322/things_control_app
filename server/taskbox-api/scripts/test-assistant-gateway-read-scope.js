const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const prefix = path.join(os.tmpdir(), `taskbox-gateway-read-scope-${process.pid}-${Date.now()}`);
const dbPath = `${prefix}.sqlite`;
const tokenFile = `${prefix}.token`;
const port = 4100 + (process.pid % 100);
const genericToken = 'generic-test-token';
const readToken = 'read-test-token';

function request(route, token, expected) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: route,
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Assistant-Verified-User-Ref': 'notification-hub-user:test',
        'X-Assistant-Conversation-Ref-Hash': '0'.repeat(64),
      },
    }, (res) => {
      res.resume();
      res.on('end', () => {
        if (res.statusCode === expected) resolve();
        else reject(new Error(`${route} -> ${res.statusCode}, expected ${expected}`));
      });
    });
    req.on('error', reject);
    req.end();
  });
}

fs.writeFileSync(tokenFile, `${readToken}\n`, { mode: 0o600 });
const child = spawn(process.execPath, [path.join(root, 'src', 'server.js')], {
  cwd: root,
  env: {
    ...process.env,
    TASKBOX_DB_PATH: dbPath,
    TASKBOX_API_PORT: String(port),
    TASKBOX_API_TOKEN: genericToken,
    ASSISTANT_GATEWAY_API_ENABLED: '1',
    ASSISTANT_GATEWAY_READ_TOKEN_FILE: tokenFile,
    ASSISTANT_GATEWAY_READ_SCOPES: 'unrelated:scope',
  },
  stdio: ['ignore', 'ignore', 'pipe'],
});

(async () => {
  try {
    let ready = false;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        await request('/health', genericToken, 200);
        ready = true;
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    if (!ready) throw new Error('server_not_ready');
    await request('/v1/assistant-gateway/proposals/pending-user-decision?limit=20', readToken, 403);
    console.log('Assistant Gateway read scope denial test passed');
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  } finally {
    child.kill();
    for (const file of [tokenFile, dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      try { fs.rmSync(file, { force: true }); } catch {}
    }
  }
})();
