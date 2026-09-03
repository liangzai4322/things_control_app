# Feedback Daily Intake runner

Production-readiness status on 2026-09-03: the Feedback-owned runner is implemented and tested, but no trigger is included in this commit. TaskBox owns the shared API, authentication and systemd/deployment integration and must keep the timer disabled until its production enable gate passes.

## Runtime contract

- Run `daily-intake-runner.mjs` as a dedicated unprivileged service account.
- Provide only `FEEDBACK_DAILY_INTAKE_TOKEN_FILE=/etc/taskbox-daily-intake/feedback.token`; never pass the browser TaskBox token or execution-system token.
- The token may read only the Feedback intake inbox and write receipts for Feedback.
- `DAILY_INTAKE_DISABLE_FILE=/etc/taskbox-daily-intake.disabled` is the global fail-closed switch. Its presence produces a successful, quiet no-op.
- The server-side `accepted` and `retrying` intake rows are the durable queue. The runner creates no second business outbox and never writes Feedback store or TaskBox facts.
- Every run scans `accepted` and `retrying`, isolates per-intake failures, retries only transient HTTP/network failures with short exponential backoff, and relies on receipt idempotency for response-loss replay.
- `processed`, `ignored`, and `failed` are terminal because they are not scanned. A `409` is not retried with another key; it remains visible as a failed run for operator review.
- Output contains aggregate counters and failure IDs/codes only. It must never include tokens, producer payloads or evidence content.

## TaskBox integration handoff

TaskBox should install this runner as an independent `taskbox-feedback-daily-intake.service` oneshot with `flock`, plus a disabled `taskbox-feedback-daily-intake.timer` at a 15-minute interval. Before enabling the timer, TaskBox must verify:

1. the global disable switch is absent;
2. the Feedback-scoped token can read `systemId=feedback` and cannot read another system or write intake batches/TaskBox facts;
3. the generic TaskBox and execution tokens are rejected by Daily Intake;
4. `node daily-intake-runner.mjs --probe` returns `queueDepth: 0` in production;
5. the API and runner rollback snapshots are recorded.

On rollback, disable the Feedback timer first and restore/remove only the runner installation. Preserve intake and receipt audit rows; do not downgrade the shared schema or restore TaskBox business data solely to roll back this consumer.

## Verification

Run:

```bash
node integrations/feedback-system/test-daily-intake-runner.mjs
npm run test:feedback-intake
npm run test:daily-intake-e2e
npm test
npm run build
```
