# AGENTS.md

## Repo role

This workspace has two jobs:

1. A static local web app (`index.html`, `js/`, `css/`, `data/`, `service-worker.js`).
2. A script workspace for exporting and normalizing SCYS, ZSXQ, Feishu, and related content into Markdown/JSON under `outputs/`.

## Working rules

- The web app has a `package.json`. Use `npm ci`, `npm run build`, and `npm run preview` for production-like verification; `python -m http.server 8000` is only the unbundled source fallback.
- Production business data comes from `server/taskbox-api/` (SQLite + Express) through record-level API calls. Do not reintroduce Gist JSON as a fallback data source.
- Frontend changes should preserve local-cache/offline behavior, record-level sync, and idempotent server writes.
- Put disposable browser/auth/debug artifacts in `tmp/`.
- Put durable batch outputs in `outputs/<batch-name>/`.
- After ZSXQ Markdown conversion/backfill/final merge, put only title-named per-article Markdown files larger than 60 KB in `outputs/太大/`, with a per-month `oversized_files_moved.json` / `.md` audit left in the month directory. Before moving, filenames should look like `<rank>_<topic_id>_<title>.md`; keep aggregate Markdown files such as `topics_normalized.md`, `articles_normalized.md`, `merged_feishu.md`, and `final_merged_articles.md` in the source month directory. Do not move JSON, DOCX, raw payloads, or auth/debug artifacts just because they are large.
- Put persistent crawler state in `data/`.
- Never write cookies, tokens, signed curl payloads, Chrome storage dumps, or raw auth headers into tracked files.

## Export entry points

- Direct Feishu `docs/docx/wiki` export: prefer `C:\Users\86180\.codex\skills\feishu-cli-markdown-export`.
- Browser-extension Feishu export fallback: `C:\Users\86180\.codex\skills\feishu-batch-markdown-export`.
- SCYS JSON fulltext export: `C:\Users\86180\.codex\skills\scys-fulltext-markdown-export`.
- ZSXQ month digest export: `C:\Users\86180\.codex\skills\shengcai-zsxq-digest-export`.

## Feishu notes

- On this Windows machine, prefer `lark-cli.cmd` over `lark-cli`.
- When a Node script launches `lark-cli.cmd` or any `.cmd` / `.bat` shim on Windows, use shell execution; Node 24 `execFile` can otherwise fail with `spawn EINVAL`.
- The official CLI path is now the default for standalone Feishu exports because it is more stable than the browser extension flow.
- Since 2026-05-19, the Feishu CLI skill also handles legacy `/docs/` links by running `lark-cli.cmd drive +export --doc-type doc --file-extension docx`, storing DOCX exports in `legacy_docx/`, and converting them locally with `python-docx`.
- The browser extension path is still useful as a fallback when CLI auth expires, permissions are missing, CLI export fails, or a workflow explicitly depends on the extension's rendered view; do not fall back only because a link uses old `/docs/`.
- The ZSXQ backfill script accepts either browser-export manifests or the CLI manifest as long as entries include `feishu_url` and `markdown_path`; if retry exports are merged, backfill from `feishu_cli_manifest_combined.json`.

## ZSXQ notes

- Since 2026-05-13, ZSXQ detail hydration should use human-like pacing: pass `--detail-delay-ms 900 --detail-jitter-ms 1400` to the global ZSXQ skill script, or set the matching `ZSXQ_DETAIL_DELAY_MS` / `ZSXQ_DETAIL_JITTER_MS` environment variables. This only throttles `/v2/topics/{topic_id}` requests; Feishu CLI export can stay fast.
- After Feishu CLI export, always backfill exported Feishu Markdown into the source topic Markdown before building `final_merged_articles.md`.
- For monthly ZSXQ batches, keep filtering decisions, failed Feishu links, detail/article failures, backfill reports, and small-article review files under the month output directory.
- Every ZSXQ filtering pass must also write a rejected-only audit file, such as `topics_rejected_invalid_links.md` / `.json`, containing each filtered-out title, ZSXQ topic URL, and reject reason.
- Since 2026-05-21, after final merge and small-article review, move only title-named per-article Markdown files larger than 60 KB to `D:\page\2023\2025\2026\4\12_\time_control_app\outputs\太大\`; preserve source-month/original-path context in the audit manifest, and use filenames like `<rank>_<topic_id>_<title>.md`. Leave aggregate Markdown, JSON, DOCX, raw API payloads, and auth/debug artifacts in place or delete temporary ones; never move auth/debug artifacts there.
- Since 2026-05-22, if a prior batch audit shows aggregate Markdown was moved into `outputs\太大\`, restore those aggregate files to the month directory first, then rewrite `oversized_files_moved.json` / `.md` so it records only valid title-named per-article Markdown moves.

## Main local scripts

- `scripts/fetch_scys_digested_posts.mjs`
- `scripts/hydrate_scys_topic_details.mjs`
- `scripts/fetch_zsxq_topics.mjs`
- `scripts/filter_zsxq_december_project_cases.mjs`
- `scripts/split_zsxq_project_cases.mjs`
- `scripts/export_tt_json_to_markdown.mjs`
- `scripts/reextract_scys_json_with_feishu.mjs`

## Documentation intent

- `README.md` is the project-facing operations log and rerun guide.
- `docs/taskbox-core-features.md` is the current product and business-rule reference.
- `docs/architecture.md` records the frontend, API, data model, and synchronization architecture.
- `docs/runbook.md` records local verification, deployment, backup, rollback, and incident checks.
- Keep absolute dates in docs when rules changed, especially for export policy shifts.
- If Feishu export policy changes again, update both `README.md` and this file in the same pass.
