const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const root = path.resolve(__dirname, '..');
const prefix = path.join(os.tmpdir(), `taskbox-hq-replies-${process.pid}-${Date.now()}`);
const dbPath = `${prefix}.sqlite`;
const gatewayTokenFile = `${prefix}.token`;
const gatewayReadTokenFile = `${prefix}.read.token`;
const port = 3900 + (process.pid % 100);
const genericToken = 'generic-test-token';
const gatewayToken = 'assistant-gateway-test-token';
const gatewayReadToken = 'assistant-gateway-read-test-token';
const conversationRefHash = crypto.createHash('sha256').update('weixin:bound-user').digest('hex');
const verifiedUserRef = `notification-hub-user:${crypto.createHash('sha256').update('bound-user').digest('hex')}`;
let serverError = '';

function replyBinding(suffix) {
  return {
    bindingRef: `notification-hub-binding:${suffix}`,
    verifiedSource: 'notification_hub_weixin',
    verifiedUserRef,
    conversationRefHash,
    signatureRef: `notification-hub-signature:${suffix}`,
    sessionRef: `notification-hub-session:${suffix}`,
    allowedDecisions: ['approve', 'reject', 'defer', 'expand'],
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  };
}

function request(route, { method = 'GET', payload = null, token = genericToken, headers = {}, expected = 200 } = {}) {
  return new Promise((resolve, reject) => {
    const body = payload === null ? null : Buffer.from(JSON.stringify(payload));
    const req = http.request({
      hostname: '127.0.0.1', port, path: route, method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(body ? { 'Content-Length': body.length } : {}),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        const data = text ? JSON.parse(text) : null;
        if (res.statusCode !== expected) {
          reject(new Error(`${method} ${route} -> ${res.statusCode}: ${text}`));
          return;
        }
        resolve({ data, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function waitForServer() {
  let lastError;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { return await request('/health'); } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw lastError;
}

function replyPayload(proposal, suffix, decision, patch = {}) {
  return {
    proposalId: proposal.decisionId,
    inboundMessageId: `weixin-message-${suffix}`,
    replyRef: `notification-outbox:${suffix}`,
    verifiedUserRef: proposal.replyBinding.verifiedUserRef,
    conversationRefHash: proposal.replyBinding.conversationRefHash,
    sessionRef: proposal.replyBinding.sessionRef,
    expectedProposalRevision: proposal.revision,
    decision,
    textHash: crypto.createHash('sha256').update(`reply-${suffix}`).digest('hex'),
    receivedAt: new Date().toISOString(),
    verification: {
      verified: true,
      source: 'notification_hub_weixin',
      signatureRef: proposal.replyBinding.signatureRef,
    },
    scopeKey: proposal.replyBinding.bindingRef,
    note: `reply ${suffix}`,
    ...patch,
  };
}

async function createProposal(suffix, patch = {}) {
  const response = await request('/v1/hq/proposals', {
    method: 'POST',
    expected: 201,
    payload: {
      proposalType: 'daily_action_proposal',
      sourceAuthority: 'ai_derived',
      title: `Gateway proposal ${suffix}`,
      idempotencyKey: `gateway-proposal:${suffix}`,
      taskSpec: { boxId: 'gateway-box', content: `Gateway proposal ${suffix}` },
      actor: 'gateway_test',
      replyBinding: replyBinding(suffix),
      ...patch,
    },
  });
  return response.data;
}

fs.writeFileSync(gatewayTokenFile, `${gatewayToken}\n`, { mode: 0o600 });
fs.writeFileSync(gatewayReadTokenFile, `${gatewayReadToken}\n`, { mode: 0o600 });
const child = spawn(process.execPath, [path.join(root, 'src', 'server.js')], {
  cwd: root,
  env: {
    ...process.env,
    TASKBOX_DB_PATH: dbPath,
    TASKBOX_API_PORT: String(port),
    TASKBOX_API_TOKEN: genericToken,
    ASSISTANT_GATEWAY_API_ENABLED: '1',
    ASSISTANT_GATEWAY_API_TOKEN_FILE: gatewayTokenFile,
    ASSISTANT_GATEWAY_API_SCOPES: 'proposal-replies:write',
    ASSISTANT_GATEWAY_READ_TOKEN_FILE: gatewayReadTokenFile,
    ASSISTANT_GATEWAY_READ_SCOPES: 'proposal-decisions:read',
    ASSISTANT_GATEWAY_REPLY_MAX_AGE_SECONDS: '86400',
    HQ_PROPOSAL_PROMOTION_ENABLED: '1',
  },
  stdio: ['ignore', 'ignore', 'pipe'],
});
child.stderr.on('data', (chunk) => { serverError += chunk.toString('utf8'); });

(async () => {
  try {
    await waitForServer();
    await request('/v1/boxes', { method: 'POST', expected: 201, payload: { id: 'gateway-box', name: 'Gateway Box' } });

    const pendingHeaders = {
      'X-Assistant-Verified-User-Ref': verifiedUserRef,
      'X-Assistant-Conversation-Ref-Hash': conversationRefHash,
    };
    const binding = replyBinding('owner');
    await request('/v1/hq/proposals', {
      method: 'POST', expected: 400,
      payload: {
        proposalType: 'daily_action_proposal', sourceAuthority: 'ai_derived',
        title: 'Invalid binding', idempotencyKey: 'gateway-proposal:invalid-binding',
        replyBinding: { ...binding, verifiedSource: 'personal_wechat' },
      },
    });
    const pendingProposal = await createProposal('pending-read', { replyBinding: binding });
    const staleBindingProposal = await createProposal('stale-binding', {
      replyBinding: { ...binding, bindingRef: 'stale-binding' },
    });
    await request('/v1/hq/proposals', {
      method: 'POST', expected: 200,
      payload: {
        proposalType: 'daily_action_proposal', sourceAuthority: 'ai_derived',
        title: 'Gateway proposal stale-binding revised',
        idempotencyKey: staleBindingProposal.idempotencyKey,
        taskSpec: { boxId: 'gateway-box', content: 'Revised without a binding' },
        actor: 'gateway_test',
      },
    });
    const pendingRoute = '/v1/assistant-gateway/proposals/pending-user-decision?limit=20';
    await request(pendingRoute, { token: genericToken, headers: pendingHeaders, expected: 401 });
    await request(pendingRoute, { token: gatewayToken, headers: pendingHeaders, expected: 401 });
    await request('/health', { token: gatewayReadToken, expected: 401 });
    await request(pendingRoute, { token: gatewayReadToken, expected: 400 });
    const wrongBinding = await request(pendingRoute, {
      token: gatewayReadToken,
      headers: { ...pendingHeaders, 'X-Assistant-Conversation-Ref-Hash': '0'.repeat(64) },
    });
    if (wrongBinding.data.count !== 0) throw new Error('pending read crossed conversation binding');
    const pending = await request(pendingRoute, { token: gatewayReadToken, headers: pendingHeaders });
    if (pending.data.count !== 1 || pending.data.items[0].proposalId !== pendingProposal.decisionId
      || pending.data.items[0].revision !== pendingProposal.revision
      || pending.data.items[0].replyBinding.verifiedSource !== 'notification_hub_weixin'
      || Object.hasOwn(pending.data.items[0], 'taskSpec') || Object.hasOwn(pending.data.items[0], 'content')) {
      throw new Error(`pending proposal projection mismatch: ${JSON.stringify(pending.data)}`);
    }
    await createProposal('expired-binding', {
      replyBinding: { ...binding, bindingRef: 'expired', expiresAt: new Date(Date.now() - 1000).toISOString() },
    });
    await createProposal('provisional-monthly', {
      proposalType: 'monthly_bet_proposal', evidenceStatus: 'provisional',
      replyBinding: { ...binding, bindingRef: 'provisional' },
    });
    const stillOnePending = await request(pendingRoute, { token: gatewayReadToken, headers: pendingHeaders });
    if (stillOnePending.data.count !== 1) throw new Error('unsafe proposal entered pending decision projection');

    const approveProposal = await createProposal('approve');
    const approveRoute = `/v1/hq/proposals/${approveProposal.decisionId}/replies`;
    const approveBody = replyPayload(approveProposal, 'approve', 'approve');
    const approveKey = 'gateway-reply:approve';

    await request(approveRoute, {
      method: 'POST', payload: approveBody, token: gatewayReadToken, expected: 401,
      headers: { 'X-Idempotency-Key': approveKey },
    });
    await request(approveRoute, {
      method: 'POST', payload: approveBody, token: genericToken, expected: 401,
      headers: { 'X-Idempotency-Key': approveKey },
    });
    await request('/health', { token: gatewayToken, expected: 401 });
    await request(approveRoute, {
      method: 'POST', payload: {
        ...approveBody,
        inboundMessageId: 'weixin-message-stale',
        expectedProposalRevision: approveProposal.revision + 1,
      },
      token: gatewayToken, expected: 409,
      headers: { 'X-Idempotency-Key': 'gateway-reply:stale', 'If-Match': `"proposal-revision-${approveProposal.revision + 1}"` },
    });
    await request(approveRoute, {
      method: 'POST', payload: {
        ...approveBody,
        inboundMessageId: 'weixin-message-expired',
        receivedAt: new Date(Date.now() - 2 * 86400000).toISOString(),
      },
      token: gatewayToken, expected: 409,
      headers: { 'X-Idempotency-Key': 'gateway-reply:expired' },
    });
    await request(approveRoute, {
      method: 'POST', payload: {
        ...approveBody,
        inboundMessageId: 'weixin-message-wrong-binding',
        conversationRefHash: '0'.repeat(64),
      },
      token: gatewayToken, expected: 409,
      headers: { 'X-Idempotency-Key': 'gateway-reply:wrong-binding' },
    });

    const approved = await request(approveRoute, {
      method: 'POST', payload: approveBody, token: gatewayToken,
      headers: { 'X-Idempotency-Key': approveKey, 'If-Match': `"proposal-revision-${approveProposal.revision}"` },
    });
    if (approved.data.status !== 'applied' || approved.data.proposal.status !== 'approved'
      || approved.data.taskboxMutation !== false || approved.data.proposal.taskId) {
      throw new Error('approve reply changed more than proposal approval state');
    }
    if (approved.headers.etag !== `"proposal-revision-${approveProposal.revision}"`) {
      throw new Error('proposal reply ETag mismatch');
    }
    const replayed = await request(approveRoute, {
      method: 'POST', payload: approveBody, token: gatewayToken,
      headers: { 'X-Idempotency-Key': approveKey },
    });
    if (replayed.data.replyId !== approved.data.replyId) throw new Error('reply replay was not idempotent');
    await request(approveRoute, {
      method: 'POST', payload: { ...approveBody, decision: 'reject' }, token: gatewayToken, expected: 409,
      headers: { 'X-Idempotency-Key': approveKey },
    });

    const expandProposal = await createProposal('expand');
    const expanded = await request(`/v1/hq/proposals/${expandProposal.decisionId}/replies`, {
      method: 'POST', token: gatewayToken,
      headers: { 'X-Idempotency-Key': 'gateway-reply:expand' },
      payload: replyPayload(expandProposal, 'expand', 'expand', { clarification: '请补充完成标准和期限。' }),
    });
    if (expanded.data.status !== 'clarification_recorded' || expanded.data.proposal.status !== 'proposed') {
      throw new Error('expand reply mutated proposal status');
    }

    const rejectProposal = await createProposal('reject');
    const rejected = await request(`/v1/hq/proposals/${rejectProposal.decisionId}/replies`, {
      method: 'POST', token: gatewayToken,
      headers: { 'X-Idempotency-Key': 'gateway-reply:reject' },
      payload: replyPayload(rejectProposal, 'reject', 'reject', { reasonCode: 'user_rejected' }),
    });
    if (rejected.data.proposal.status !== 'rejected') throw new Error('reject reply failed');

    const deferProposal = await createProposal('defer');
    const deferred = await request(`/v1/hq/proposals/${deferProposal.decisionId}/replies`, {
      method: 'POST', token: gatewayToken,
      headers: { 'X-Idempotency-Key': 'gateway-reply:defer' },
      payload: replyPayload(deferProposal, 'defer', 'defer', { deferUntil: '2026-09-30' }),
    });
    if (deferred.data.proposal.status !== 'deferred' || deferred.data.proposal.deferUntil !== '2026-09-30') {
      throw new Error('defer reply failed');
    }

    const taskbox = await request('/v1/taskbox');
    if (taskbox.data.tasks.length !== 0) throw new Error('proposal reply route wrote TaskBox tasks');

    const db = new Database(dbPath, { readonly: true });
    const appliedReplies = Number(db.prepare("SELECT COUNT(*) AS count FROM hq_proposal_replies WHERE status IN ('applied','clarification_recorded')").get().count);
    const rejectedReplies = Number(db.prepare("SELECT COUNT(*) AS count FROM hq_proposal_replies WHERE status='rejected'").get().count);
    const approveReceipts = Number(db.prepare("SELECT COUNT(*) AS count FROM hq_proposal_replies WHERE inbound_message_id='weixin-message-approve'").get().count);
    const auditCount = Number(db.prepare('SELECT COUNT(*) AS count FROM hq_proposal_reply_audit').get().count);
    const clarificationCount = Number(db.prepare("SELECT COUNT(*) AS count FROM hq_proposal_events WHERE event_type='clarification_requested'").get().count);
    db.close();
    if (appliedReplies !== 4 || rejectedReplies !== 3 || approveReceipts !== 1 || auditCount < 12 || clarificationCount !== 1) {
      throw new Error(`reply audit mismatch: ${JSON.stringify({ appliedReplies, rejectedReplies, approveReceipts, auditCount, clarificationCount })}`);
    }
    console.log('HQ proposal reply gateway tests passed');
  } catch (error) {
    console.error(error.stack || error.message);
    if (serverError) console.error(serverError);
    process.exitCode = 1;
  } finally {
    child.kill();
    for (const file of [gatewayTokenFile, gatewayReadTokenFile, dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      try { fs.rmSync(file, { force: true }); } catch {}
    }
  }
})();
