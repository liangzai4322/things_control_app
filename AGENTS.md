# AGENTS.md

## Repo role

This workspace has two jobs:

1. A static local web app (`index.html`, `js/`, `css/`, `data/`, `service-worker.js`) whose default surface is Life HQ (`#hq`) and whose execution surface is the box system (`#home`).
2. A script workspace for exporting and normalizing SCYS, ZSXQ, Feishu, and related content into Markdown/JSON under `outputs/`.

## Working rules

- A task's system authority follows the applicable headquarters section below. Before modifying or operating another system, follow the cross-system coordination directory and contact that system's existing Codex task when the dependency actually arises.
- The web app has a `package.json`. Use `npm ci`, `npm run build`, and `npm run preview` for production-like verification; `python -m http.server 8000` is only the unbundled source fallback.
- Production business data comes from `server/taskbox-api/` (SQLite + Express) through record-level API calls. Do not reintroduce Gist JSON as a fallback data source.
- Frontend changes should preserve local-cache/offline behavior, record-level sync, and idempotent server writes.
- Preserve the main/sub-panel contract: Life HQ owns decisions, project health, and daily/weekly/monthly direction; boxes own task execution and evidence. Cross-panel navigation uses the persistent workspace switch and task deep links, not duplicated records.
- Execution-system production writes use only the dedicated `/v1/execution/*` contract in `docs/execution-system-taskbox-api.md`. TaskBox remains the sole task fact store. Never let execution-system fall back to generic `/v1/tasks`, reuse browser/HQ credentials, accept AI candidates as authority, hard-delete tasks, force revision conflicts, or mutate mission/mainline strategy.
- HQ task deep links use `#box/:boxId/:taskId/hq-primary|hq-maintenance`; box-only task links may omit the fourth segment. Keep task focus, command context, and return navigation working on desktop and mobile.
- Put disposable browser/auth/debug artifacts in `tmp/`.
- Put durable batch outputs in `outputs/<batch-name>/`.
- After ZSXQ Markdown conversion/backfill/final merge, put only title-named per-article Markdown files larger than 60 KB in `outputs/太大/`, with a per-month `oversized_files_moved.json` / `.md` audit left in the month directory. Before moving, filenames should look like `<rank>_<topic_id>_<title>.md`; keep aggregate Markdown files such as `topics_normalized.md`, `articles_normalized.md`, `merged_feishu.md`, and `final_merged_articles.md` in the source month directory. Do not move JSON, DOCX, raw payloads, or auth/debug artifacts just because they are large.
- Put persistent crawler state in `data/`.
- Never write cookies, tokens, signed curl payloads, Chrome storage dumps, or raw auth headers into tracked files.

## Mission system headquarters authority

- Standing user authorization recorded on 2026-08-23: Codex acting as Mission System HQ may independently inspect, change, test, commit, push, and deploy mission-system code and documentation without requesting per-change approval.
- Mission-owned files are `js/mission-model.js`, `js/mission-store.js`, `js/mission-page.js`, `js/mission-hq-port.js`, `js/mission-v2-adapter.js`, `server/taskbox-api/src/mission-system.js`, mission-specific schema sections/tests, mission-only CSS selectors, and mission-specific documentation sections.
- Shared integration files such as `js/app.js`, `js/app-storage.js`, `css/style.css`, `package.json`, build/deploy workflows, HQ ports, and cross-system contracts may receive only the smallest mission-required integration edit. Preserve other systems' behavior and run the relevant shared contract tests.
- Mission HQ has the user's standing authorization (`mission-hq-specific-actions-2026-08-23`) to approve a mission candidate or publish a mission version without another click only when the action, target object, and expected result are all exact and recorded in the audit trail. Vague or ambiguous suggestions do not qualify, `ai_derived` content cannot authorize itself, Mission HQ cannot write directly to TaskBox, and ownership of the other systems remains unchanged.
- Mission System HQ does not own TaskBox tasks, HQ decisions, health facts, time facts, or feedback rules. Do not add direct TaskBox writes or bypass the existing L1 read-only HQ projection.

## Time and attention system headquarters authority

- Standing user authorization recorded on 2026-08-23: Codex thread `019fe737-b6f8-7b31-862f-7f5dd707e3de`, acting as Time & Attention System HQ, may independently inspect, change, test, merge, commit, push, and deploy time-system code and documentation without requesting per-change approval. For this thread, this section overrides the generic execution-HQ thread label above.
- Time-owned files are `js/time-attention-model.js`, `js/time-attention-store.js`, `js/time-attention-page.js`, `js/time-attention-hq-port.js`, time-specific tests, time-only CSS selectors, and time-specific documentation sections.
- Shared integration files such as `js/app.js`, `js/app-storage.js`, `css/style.css`, `package.json`, build/deploy workflows, HQ ports, and cross-system contracts may receive only the smallest time-required integration edit. Preserve other systems' behavior and run the relevant shared contract tests.
- Time HQ may resolve local/cloud conflicts and release the newest compatible time contract directly. Preserve the independent stores and standard HQ-port boundary; do not restore an older local file over a newer schema or bypass `js/five-system-hq-ports.js`.
- Time HQ owns time plans, calendar facts, focus windows, actual-attention evidence, capacity calculations, and time candidates. It does not own TaskBox task/completion facts, mission priorities, health diagnoses, or feedback rules. A derived schedule is not a user commitment; external-calendar writes and TaskBox writes must continue through their existing explicit-user/controlled-write contracts.

## Feedback system headquarters authority

- Standing user authorization recorded on 2026-08-23: Codex thread `019fe737-b6f8-7b31-862f-7f7f704e9dc0`, acting as Feedback System HQ, may independently inspect, change, test, merge, commit, push, and deploy feedback-system code and documentation without requesting per-change approval. For this thread, this section overrides the generic execution-HQ thread label above.
- Feedback-owned files are `js/feedback-model.js`, `js/feedback-store.js`, `js/feedback-import.js`, `js/feedback-page.js`, `js/feedback-hq-port.js`, `integrations/feedback_continuity.py`, feedback-specific tests, feedback-only CSS selectors, and feedback-specific documentation sections.
- Shared integration files such as `js/app.js`, `css/style.css`, `package.json`, build/deploy workflows, `js/five-system-hq-ports.js`, HQ contracts, and cross-system tests may receive only the smallest feedback-required integration edit. Preserve other systems and run relevant shared contract tests.
- Feedback HQ may resolve local/cloud conflicts and release the newest compatible feedback contract directly. Preserve the independent local store and L1 read-only HQ-port boundary; do not restore an older schema over the deployed schema v3.
- Feedback HQ owns predictions, deviations, pattern candidates, experiments, rule versions, evidence continuity, and feedback-specific candidate/audit state. It does not own TaskBox task/completion facts, mission priorities, health facts, or time facts. Imported/AI-derived content cannot authorize itself; cross-system proposals may be accepted for consideration but cannot directly mutate a target system, become a standing rule, or create a TaskBox task.

## Cross-system coordination directory

- Standing user instruction recorded on 2026-08-23: before modifying or operating another system's owned code, data, rules, deployment, or task state, contact that system's existing Codex task, communicate the intended change, and ask the narrow question needed to proceed. Do not silently decide on behalf of another system, and do not treat silence as approval.
- Contact only when a concrete cross-system need arises; do not send routine, speculative, or pre-emptive messages merely because this directory exists. Read-only inspection, changes wholly inside the current system, and mechanical preservation of an already-approved shared contract do not require contact.
- If one action affects multiple systems, contact every affected owner before making the cross-system change. A reply may supply facts or coordination, but it does not replace the existing explicit-user approval and controlled-write boundaries. Reuse the tasks below rather than creating replacements.
- Execution system: `codex://threads/019fe737-b6f7-7121-9a26-574b22fbffed`
- Health system: `codex://threads/019fe737-b6f8-7b31-862f-7fb93f71d8d4`
- Time & Attention system: `codex://threads/019fe737-b6f8-7b31-862f-7f5dd707e3de`
- Feedback system: `codex://threads/019fe737-b6f8-7b31-862f-7f7f704e9dc0`
- Mission system: `codex://threads/019fe737-b6f8-7b31-862f-7f951f209c86`
- Box App: `codex://threads/019d8138-ece0-70b0-8c9d-90b4003aa46f`
- Daily Review / knowledge-base management: `codex://threads/019dbec0-d3c2-7c53-93f5-7570c3f1dafc`
- Life HQ: `codex://threads/019fb1e4-de37-74d0-8ea3-ebee097c18a5`

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
- `docs/hq-primary-action-system-loop-v2.md` is the single source of truth for P0-P6. All phases are in production. P5-P6 add a read-only approved weekly bet, project resource bias, weekly system-efficiency metrics, and a 14-day governance gate; missing values remain unknown and recommendations never mutate systems or TaskBox. PR #12 merge `4237b97`, Pages workflow `32634346744`, and Build ID `8956dbc8f134` passed full tests plus 1440px/390px production checks. P4 API promotion boundaries remain unchanged: only approved daily proposals can promote when both the request and `HQ_PROPOSAL_PROMOTION_ENABLED=1` allow it; weekly experiments and monthly bets remain strategic objects.
- The V3 Session A/G documents preserve pre-release evidence. Current production is Pages workflow `31556529819`, Build ID `6ee91e341ff7`: five independent systems expose `*-hq-port.js` snapshots; HQ consumes only `js/five-system-hq-ports.js`. Execution is a first-class L2 system backed by TaskBox as the sole task/completion fact engine; its shadow proposal outbox still has no automatic consumer.
- PR #2 published the five-system daily-review inbox UI in Pages workflow `31558585173`, Build ID `e95fe81c2a02`. On 2026-08-13 the matching `system_candidates` batch/read/decision API passed production `200 / 401 / 204 / 200`, idempotent outbox replay (`created=3`, then `unchanged=3`), all five isolated reads, and systemd active. The rollback point is `/opt/taskbox-api/backups/system-candidates-20260812T163954Z`. Candidate decisions are only `kept/dismissed`; never reinterpret them as target-system publication, validated facts, TaskBox promotion, or experiment/rule activation.
- Five-system historical baseline publication is coordinated only by `js/five-system-bootstrap.js` from a user-selected private local package. Never add the generated package or its daily-review contents to Git/Pages. Explicit user publication atomically versions all five local stores and keeps a rollback snapshot: mission 39 baseline items; health 12 non-proposal dated Observations + 72 contexts; time 22 non-proposal dated baseline facts + 113 contexts; execution 375 historical records with zero current TaskBox tasks; feedback 42 observed patterns + 5 still-proposed calibration experiments. Daily additions still enter candidates first.
- The versioned baseline UI shipped in PR #7 on 2026-08-13: merge `47624b3`, Pages workflow `31660897657`, production Build ID `0edb9e215060`.
- Cross-browser baseline bootstrapping uses authenticated `GET /v1/system-baseline/current`. The private package path comes from `TASKBOX_FIVE_SYSTEM_BASELINE_PATH`, stays outside Git/Pages, and HQ auto-publishes V1 only when the local browser has no published baseline. Keep the file picker as the no-token fallback.
- Production auto-bootstrap shipped in PR #8 on 2026-08-13: merge `7a9c536`, Pages workflow `31712549246`, Build ID `56ce0c452a92`; API baseline returned authenticated 200 / unauthenticated 401, with rollback `/opt/taskbox-api/backups/system-candidates-20260813T145401Z`.
- On 2026-08-23 Feedback System HQ reconciled the older local P1 worktree against `deploy/main` and kept the deployed schema v3 implementation as the compatible superset. The verified release candidate Build ID is `1bf08b491371`; full tests and 1440px/390px browser checks passed. This reconciliation changed no API runtime or production database, and the explicit-user/cross-system isolation gates remain mandatory.
- The fixed five-system entry band and public L1 adapters are owned by the integration session. B–F worktrees must not edit `js/app.js`, `js/hq-page.js`, `js/hq-systems.js`, shared entry CSS, `scripts/test-v3-integration.mjs`, or `package.json`; propose interface changes for later integration instead.
- P4 proposal types are `daily_action_proposal`, `weekly_experiment_proposal`, and `monthly_bet_proposal`. Only approved daily proposals may call `/v1/hq/proposals/:id/promote`; weekly/monthly approvals remain strategic objects, and provisional monthly evidence cannot be approved. Production promotion additionally requires `HQ_PROPOSAL_PROMOTION_ENABLED=1`.
- The downstream Task Hub bridge lives in `D:\note_new\06-日常输入_输出\.agents\skills\任务中枢\scripts\task_hub_bridge.py`. It creates an HQ proposal first and may create/link one TaskBox task only through the promotion route; it must never call the task creation route as an approval bypass.
- Keep absolute dates in docs when rules changed, especially for export policy shifts.
- If Feishu export policy changes again, update both `README.md` and this file in the same pass.
