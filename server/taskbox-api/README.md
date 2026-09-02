# TaskBox API

Lightweight SQLite API for the static Taskbox PWA.

## Runtime

- Node.js 22+
- SQLite via `better-sqlite3`
- Express on `127.0.0.1:3107`
- Nginx should expose it under `https://liangzai666.com/taskbox-api/`

## Environment

Create `/etc/taskbox-api.env` on the server:

```bash
TASKBOX_DB_PATH=/opt/taskbox-api/data/taskbox.sqlite
TASKBOX_API_PORT=3107
TASKBOX_API_TOKEN=<server-side-api-token>
TASKBOX_ALLOWED_ORIGINS=https://liangzai4322.github.io,http://localhost:8000,http://127.0.0.1:8000
HQ_PROPOSAL_PROMOTION_ENABLED=1
EXECUTION_SYSTEM_API_ENABLED=1
EXECUTION_SYSTEM_API_TOKEN_FILE=/etc/taskbox-execution-system-token
EXECUTION_SYSTEM_API_DISABLE_FILE=/etc/taskbox-execution-system.disabled
EXECUTION_SYSTEM_API_SCOPES=tasks:read,tasks:create,tasks:update,tasks:schedule,tasks:progress,tasks:evidence,tasks:complete,tasks:delete,tasks:audit
EXECUTION_SYSTEM_EXPLICIT_GRANT_IDS=standing-execution-taskbox-normal-2026-09-02
```

Do not commit this file. Do not put the API token in the GitHub Pages repository.

## Import

```bash
cd /opt/taskbox-api
npm ci --omit=dev
npm run init-db
npm run import-json -- /opt/taskbox-api/seed
```

`import-json` 用于一次性迁移或恢复，不是日常同步路径。运行前必须备份数据库；重复导入按记录 ID 更新。

## Data and routes

- `GET /v1/taskbox`: boxes, tasks, mainlines, milestones, settings and usage logs.
- `/v1/boxes`, `/v1/tasks`, `/v1/mainlines`, `/v1/milestones`: record-level POST/PATCH/DELETE.
- `GET/PATCH /v1/daily-quote`: daily quote archive.
- `GET /v1/points` plus transaction and reward write routes.
- `/v1/smallworld/:realm`: pavilion/tower reads and item-level writes.
- `GET /v1/hq/today`: aggregated Life HQ cockpit for one date.
- `GET /v1/hq/review-status`: review sync state, evidence counts, and 3-31 day commitment trend.
- `/v1/hq/periods`: weekly/monthly review list, current snapshot, period upsert and delete.
- `GET/POST /v1/hq/daily-briefs/:date`: daily command brief and review result upsert. Omitting `primaryTaskId` preserves the original strategic commitment; sending `primaryTaskId: null` clears commitment and action seat. P1 production builds use `currentActionTaskId` for the current action seat and `_syncMutation`/`_syncFence` to reject stale generation or client-sequence replays.
- `/v1/hq/decisions`: decision queue record-level CRUD.
- `GET/POST /v1/hq/proposals`, `GET /v1/hq/proposals/:id`, and proposal `approve/reject/defer/promote` actions. Only approved daily proposals can promote to TaskBox; weekly/monthly proposals remain strategic records.
- `POST /v1/system-candidates/batch`, `GET /v1/system-candidates?systemId=...`, and `PATCH /v1/system-candidates/:id`: idempotent daily-review candidate inboxes isolated by system. Candidates can only become `kept` or `dismissed`; this API cannot publish mission versions, health/time facts, TaskBox tasks, experiments, or rules.
- `POST /v1/mission/sync` and `GET /v1/mission/state`: Mission OS Beta record sync for drafts, immutable published versions, candidates, and audit events. Mutable records require `expectedRevision`; stale writes return `409`. Published versions require valid `explicit_user` or exact Mission HQ `standing_rule` authority and never write TaskBox records.
- `GET /v1/system-baseline/current`: authenticated, no-store delivery of the private five-system V1 bootstrap package. Configure `TASKBOX_FIVE_SYSTEM_BASELINE_PATH`; the file stays outside Git/Pages and is never exposed without the API token.
- `GET /v1/daily-snapshot`: evidence snapshot consumed by 日省.
- `/v1/execution/*`: execution-system-only task reads, capability discovery, immutable audit and allowlisted production operations. It uses a separate identity, scope checks, explicit authority evidence, idempotency and task revision/ETag conflicts; see `../../docs/execution-system-taskbox-api.md`.

SQLite schema lives in `schema.sql`. `raw_json` is a compatibility fallback; query-critical fields use dedicated columns and indexes.

Task availability and routing fields are `device_context`, `execution_mode`, `visible_after`, `deferred_at`, `defer_note`, and `progress_logs_json`. Every task has a monotonic `revision`. Run `npm run test:schema`, `npm run test:mission`, and `npm run test:execution` before deployment.

P2-created candidate tasks use `hq-candidate:<dedupeKey>` as `syncKey`. Repeated `POST /v1/tasks` calls with the same value return the existing record, while `candidateDedupeKey`, `candidateSourceSystemId`, `candidateSourceRef`, and `roiInputs` remain available through `raw_json` compatibility fields.

## Health Check

```bash
curl -H "Authorization: Bearer $TASKBOX_API_TOKEN" http://127.0.0.1:3107/health
```

Expected behavior is authenticated `200`, unauthenticated `401`, and allowed-origin CORS preflight `204`. See `../../docs/architecture.md` and `../../docs/runbook.md` for the full integration and deployment contract.

Production verification on 2026-08-07 passed all three status checks plus an explicit `primaryTaskId: null` clear/readback/restore probe. The rollback snapshot for that release is `/opt/taskbox-api/backups/p0-null-clear-20260807T060141Z`.

P1 production verification on 2026-08-09 passed schema/HQ integration tests, authenticated health `200`, unauthenticated health `401`, production-origin preflight `204`, and an HQ shape probe containing both `primaryTaskId` and `currentActionTaskId`. The P1 rollback snapshot is `/opt/taskbox-api/backups/p1-action-seat-20260809T022214Z`.

P2 production verification on 2026-08-09 passed the candidate `syncKey` idempotency test, authenticated health `200`, unauthenticated health `401`, production-origin preflight `204`, and an active service check. P2 changed no API runtime files or database columns, so the P1 rollback snapshot remains the current server rollback point.

P4 production verification on 2026-08-10 passed schema migration, HQ integration and proposal state-machine tests; authenticated health returned `200`, unauthenticated health `401`, production-origin preflight `204`, and the proposal queue `200`. A production weekly-proposal probe recorded `created → approve → defer → reject`; strategic promotion returned `409` and created no TaskBox task. `HQ_PROPOSAL_PROMOTION_ENABLED=1` is active. The P4 rollback snapshot is `/opt/taskbox-api/backups/p4-review-proposals-20260809T170701Z`.

The five-system candidate API completed production verification on 2026-08-13: `verify-system-candidates-production.sh` returned `200 / 401 / 204 / 200`, the 2026-08-11 outbox returned `created=3` and then `unchanged=3`, every system-filtered read was isolated, and systemd remained active. The rollback snapshot is `/opt/taskbox-api/backups/system-candidates-20260812T163954Z`. Server-side deployment uses `deploy-system-candidates-release.sh`; it stops the service before copying SQLite/WAL/SHM, preserves `/etc/taskbox-api.env` and `data/`, and waits up to 10 seconds for authenticated loopback health after systemd starts. Use `rollback-system-candidates-release.sh` only with the printed snapshot; database restoration additionally requires `RESTORE_TASKBOX_DATABASE=1`.

Mission OS cloud-ledger Beta completed production deployment on 2026-08-23 through workflow `32632070021`. Schema migration and authenticated restart health passed; production probes returned authenticated mission state `200`, unauthenticated `401`, and allowed-origin preflight `204`. The pre-deployment rollback snapshot is `/opt/taskbox-api/backups/system-candidates-20260823T094954Z`.
