# Taskbox API

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

## Health Check

```bash
curl -H "Authorization: Bearer $TASKBOX_API_TOKEN" http://127.0.0.1:3107/health
```
