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

SQLite schema lives in `schema.sql`. `raw_json` is a compatibility fallback; query-critical fields use dedicated columns and indexes.

Task availability and routing fields are `device_context`, `execution_mode`, `visible_after`, `deferred_at`, `defer_note`, and `progress_logs_json`. Run `npm run test:schema` before deployment to verify an existing database can be upgraded in place.

## Health Check

```bash
curl -H "Authorization: Bearer $TASKBOX_API_TOKEN" http://127.0.0.1:3107/health
```

Expected behavior is authenticated `200`, unauthenticated `401`, and allowed-origin CORS preflight `204`. See `../../docs/architecture.md` and `../../docs/runbook.md` for the full integration and deployment contract.
