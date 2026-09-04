# Assistant Gateway Worker

This integration runs on the shared server as `assistant-gateway.service`. Notification Hub remains the only personal-Weixin poller and message outbox. The worker consumes only its lease API and never reads the Hub SQLite database or iLink directly.

## Runtime mode

The base unit keeps the safe installation default `ASSISTANT_GATEWAY_MODE=echo`:

- A verified bound-user message whose trimmed text is `测试` or starts with `测试-` receives `已收到，微信助手通路正常` through the lease-bound Notification Hub reply route, then receives a `processed` acknowledgement.
- Every other valid message receives a one-hour `retry` acknowledgement with `echo_mode_only`; echo mode never parses or submits an HQ decision.
- Unverified identity or a changed text hash is dead-lettered.
- The reply uses a stable key derived from `inboundMessageId`, so retrying after a network failure cannot send a second echo.

Production deployments install `assistant-gateway.service.d/20-production-mode.conf`, which fixes the effective mode to `decision` without weakening the base unit default. Future releases replace both files and verify the merged systemd environment before reporting success. It preserves the echo health command, and otherwise accepts only exact `同意`/`批准`/`approve`, `拒绝`/`不同意`/`reject`, `展开`/`补充说明`/`expand`, or `延期到YYYY-MM-DD`/`defer YYYY-MM-DD`. Unknown text, no matching proposal, and multiple matching proposals are retried without an HQ write.

Decision mode reads only the dedicated pending projection for the hashed bound conversation. Exactly one unexpired, revision-matched `replyBinding` must exist. It uses only the dedicated HQ reply, approval, and promotion operations and never falls back to generic TaskBox task routes. A private state file records only IDs, hashes, binding references and processing flags so an HQ success followed by a Hub failure can resume with the same idempotency key. It never stores the Weixin text or a credential.

## Credentials and stop controls

systemd exposes three unrelated root-owned source files through `LoadCredential`:

- `weixin-ingress.token` from `/etc/notification-ingress/weixin-ingress.token`: Notification Hub claim/reply/ack only.
- `hq-reply.token` from `/etc/taskbox-assistant-gateway-token`: HQ proposal replies only.
- `hq-read.token` from `/etc/taskbox-assistant-gateway-read-token`: bound pending-proposal projection only.

No credential value may enter environment variables, command-line arguments, logs, Git, or TaskBox. The worker runs as the no-login `taskbox-assistant-gateway` user.

The decision recovery file is `/var/lib/taskbox-assistant-gateway/decision-state.json`, owned through systemd `StateDirectory`. The separate `/var/lib/taskbox-assistant-gateway/status.json` is atomically maintained with only `lastClaimAt`, `lastReplyAt`, `pendingCount`, `automationCount`, `promotionPendingCount`, `retryCount`, and `deadLetterCount`. The two failure counters are cumulative across restarts; `pendingCount` is the most recent claim batch size and `automationCount` is the most recent bounded automation queue size. Read the sanitized projection with `/usr/bin/python3 /opt/taskbox-assistant-gateway/status.py`.

Stop only worker consumption by stopping/disabling `assistant-gateway.service` or creating `/etc/taskbox-assistant-gateway-worker.disabled`. Disable the HQ reply endpoint separately with `/etc/taskbox-assistant-gateway.disabled`. Notification Hub retains unprocessed messages and owns lease retry/dead-letter behavior.

## Verification

```bash
npm run test:assistant-gateway
python3 -m compileall -q integrations/assistant-gateway
```

Deployment must also authenticate a nonexistent-message probe against Notification Hub's `/v1/weixin-inbound/:id/reply` and receive `404` before starting the worker. This verifies the dedicated identity without claiming or replying to a real message.

Rollback restores the pre-release production-mode drop-in when one existed, or removes the release-owned drop-in when it did not. Emergency shutdown remains independent of mode: use `/etc/taskbox-assistant-gateway-worker.disabled` for worker consumption and `/etc/taskbox-assistant-gateway.disabled` for HQ writes.
