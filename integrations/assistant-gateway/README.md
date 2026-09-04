# Assistant Gateway Worker

This integration runs on the shared server as `assistant-gateway.service`. Notification Hub remains the only personal-Weixin poller and message outbox. The worker consumes only its lease API and never reads the Hub SQLite database or iLink directly.

## Echo gate

The initial production mode is `ASSISTANT_GATEWAY_MODE=echo`:

- A verified bound-user message whose trimmed text is `测试` or starts with `测试-` receives `已收到，微信助手通路正常` through the lease-bound Notification Hub reply route, then receives a `processed` acknowledgement.
- Every other valid message receives a one-hour `retry` acknowledgement with `echo_mode_only`; echo mode never parses or submits an HQ decision.
- Unverified identity or a changed text hash is dead-lettered.
- The reply uses a stable key derived from `inboundMessageId`, so retrying after a network failure cannot send a second echo.

`ASSISTANT_GATEWAY_MODE=decision` is implemented behind the systemd feature flag but is not the production default. It preserves the echo health command, and otherwise accepts only exact `同意`/`批准`/`approve`, `拒绝`/`不同意`/`reject`, `展开`/`补充说明`/`expand`, or `延期到YYYY-MM-DD`/`defer YYYY-MM-DD`. Unknown text, no matching proposal, and multiple matching proposals are retried without an HQ write.

Decision mode reads only the dedicated pending projection for the hashed bound conversation. Exactly one unexpired, revision-matched `replyBinding` must exist. It writes only the existing HQ proposal reply endpoint, sends a confirmation through Notification Hub, then acknowledges the inbound message. A private state file records only IDs, hashes, binding references and processing flags so an HQ success followed by a Hub failure can resume with the same idempotency key. It never stores the Weixin text or a credential.

## Credentials and stop controls

systemd exposes three unrelated root-owned source files through `LoadCredential`:

- `weixin-ingress.token` from `/etc/notification-ingress/weixin-ingress.token`: Notification Hub claim/reply/ack only.
- `hq-reply.token` from `/etc/taskbox-assistant-gateway-token`: HQ proposal replies only.
- `hq-read.token` from `/etc/taskbox-assistant-gateway-read-token`: bound pending-proposal projection only.

No credential value may enter environment variables, command-line arguments, logs, Git, or TaskBox. The worker runs as the no-login `taskbox-assistant-gateway` user.

The decision recovery file is `/var/lib/taskbox-assistant-gateway/decision-state.json`, owned through systemd `StateDirectory`. Production remains `echo` until a separate release explicitly changes the unit feature flag after bound-proposal probes pass.

Stop only worker consumption by stopping/disabling `assistant-gateway.service` or creating `/etc/taskbox-assistant-gateway-worker.disabled`. Disable the HQ reply endpoint separately with `/etc/taskbox-assistant-gateway.disabled`. Notification Hub retains unprocessed messages and owns lease retry/dead-letter behavior.

## Verification

```bash
npm run test:assistant-gateway
python3 -m compileall -q integrations/assistant-gateway
```

Deployment must also authenticate a nonexistent-message probe against Notification Hub's `/v1/weixin-inbound/:id/reply` and receive `404` before starting the worker. This verifies the dedicated identity without claiming or replying to a real message.
