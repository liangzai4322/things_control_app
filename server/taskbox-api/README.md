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
- `GET /v1/daily-snapshot`: evidence snapshot consumed by 日省.

SQLite schema lives in `schema.sql`. `raw_json` is a compatibility fallback; query-critical fields use dedicated columns and indexes.

Task availability and routing fields are `device_context`, `execution_mode`, `visible_after`, `deferred_at`, `defer_note`, and `progress_logs_json`. Run `npm run test:schema` before deployment to verify an existing database can be upgraded in place.

P2-created candidate tasks use `hq-candidate:<dedupeKey>` as `syncKey`. Repeated `POST /v1/tasks` calls with the same value return the existing record, while `candidateDedupeKey`, `candidateSourceSystemId`, `candidateSourceRef`, and `roiInputs` remain available through `raw_json` compatibility fields.

## Health Check

```bash
curl -H "Authorization: Bearer $TASKBOX_API_TOKEN" http://127.0.0.1:3107/health
```

Expected behavior is authenticated `200`, unauthenticated `401`, and allowed-origin CORS preflight `204`. See `../../docs/architecture.md` and `../../docs/runbook.md` for the full integration and deployment contract.

Production verification on 2026-08-07 passed all three status checks plus an explicit `primaryTaskId: null` clear/readback/restore probe. The rollback snapshot for that release is `/opt/taskbox-api/backups/p0-null-clear-20260807T060141Z`.

P1 production verification on 2026-08-09 passed schema/HQ integration tests, authenticated health `200`, unauthenticated health `401`, production-origin preflight `204`, and an HQ shape probe containing both `primaryTaskId` and `currentActionTaskId`. The P1 rollback snapshot is `/opt/taskbox-api/backups/p1-action-seat-20260809T022214Z`.

P2 production verification on 2026-08-09 passed the candidate `syncKey` idempotency test, authenticated health `200`, unauthenticated health `401`, production-origin preflight `204`, and an active service check. P2 changed no API runtime files or database columns, so the P1 rollback snapshot remains the current server rollback point.
