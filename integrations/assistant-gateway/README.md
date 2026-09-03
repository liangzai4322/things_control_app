# Assistant Gateway Worker

This integration runs on the shared server as `assistant-gateway.service`. Notification Hub remains the only personal-Weixin poller and message outbox. The worker consumes only its lease API and never reads the Hub SQLite database or iLink directly.

## Echo gate

The initial production mode is `ASSISTANT_GATEWAY_MODE=echo`:

- A verified bound-user message whose exact trimmed text is `测试` receives `已收到，助手通道连接正常。` through the lease-bound Notification Hub reply route, then receives a `processed` acknowledgement.
- Every other valid message receives a one-hour `retry` acknowledgement with `echo_mode_only`; echo mode never parses or submits an HQ decision.
- Unverified identity or a changed text hash is dead-lettered.
- The reply uses a stable key derived from `inboundMessageId`, so retrying after a network failure cannot send a second echo.

The next decision-processing mode must not be enabled until the Assistant Gateway owning system supplies an authoritative pending-proposal projection and the full proposal/revision binding tests pass. The HQ credential is loaded now but deliberately unused in echo mode.

## Credentials and stop controls

systemd exposes two unrelated root-owned source files through `LoadCredential`:

- `weixin-ingress.token` from `/etc/notification-ingress/weixin-ingress.token`: Notification Hub claim/reply/ack only.
- `hq-reply.token` from `/etc/taskbox-assistant-gateway-token`: HQ proposal replies only.

Neither value may enter environment variables, command-line arguments, logs, Git, or TaskBox. The worker runs as the no-login `taskbox-assistant-gateway` user.

Stop only worker consumption by stopping/disabling `assistant-gateway.service` or creating `/etc/taskbox-assistant-gateway-worker.disabled`. Disable the HQ reply endpoint separately with `/etc/taskbox-assistant-gateway.disabled`. Notification Hub retains unprocessed messages and owns lease retry/dead-letter behavior.

## Verification

```bash
npm run test:assistant-gateway
python3 -m compileall -q integrations/assistant-gateway
```

Deployment must also authenticate a nonexistent-message probe against Notification Hub's `/v1/weixin-inbound/:id/reply` and receive `404` before starting the worker. This verifies the dedicated identity without claiming or replying to a real message.
