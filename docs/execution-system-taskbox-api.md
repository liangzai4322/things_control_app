# Execution System → TaskBox Production Contract

Contract version: `2026-09-02`

TaskBox remains the only task system of record. The execution system may mutate task execution facts only through this API. It must not call the generic `/v1/tasks` write routes.

## Authentication and shutdown

- Authentication: `Authorization: Bearer <execution-system-token>`.
- The token is independent from the browser/HQ token and is read from `EXECUTION_SYSTEM_API_TOKEN_FILE`.
- Required scopes are configured in `EXECUTION_SYSTEM_API_SCOPES`.
- `EXECUTION_SYSTEM_API_ENABLED=1` enables the API.
- Creating `EXECUTION_SYSTEM_API_DISABLE_FILE` disables every execution route immediately without deleting the token. Requests then return `503 execution_api_disabled`.
- The generic TaskBox token cannot access `/v1/execution/*`; the execution token cannot access generic TaskBox routes.

## Discovery and reads

```http
GET /v1/execution/capabilities
GET /v1/execution/tasks/:taskId
GET /v1/execution/audit?taskId=:taskId&limit=50
```

Task reads require `tasks:read`; audit reads require `tasks:audit`. A task read returns:

```http
ETag: "task-revision-12"
```

## Writes

All writes use one endpoint:

```http
POST /v1/execution/task-operations
Authorization: Bearer <execution-system-token>
Content-Type: application/json
X-Idempotency-Key: <stable-operation-key>
If-Match: "task-revision-12"
```

`If-Match` is required for every operation except `create`. `revision` or `expectedRevision` in the body is accepted when an HTTP client cannot set `If-Match`.

```json
{
  "contractVersion": "2026-09-02",
  "sourceSystem": "execution",
  "requestId": "DSP-...",
  "idempotencyKey": "execution:<source-event>:<task-id>:<operation>",
  "operation": "schedule",
  "taskId": "real-task-id",
  "authorizationSource": "explicit_user",
  "authorizationEvidence": {
    "referenceId": "standing-execution-taskbox-normal-2026-09-02"
  },
  "reason": "根据用户明确安排调整执行时间",
  "requestedMutation": {
    "scheduledAt": "2026-09-02T10:00:00.000Z",
    "dueDate": "2026-09-02T12:00:00.000Z"
  },
  "evidenceRef": {
    "id": "optional-evidence-id",
    "ref": "artifact-or-event-reference"
  }
}
```

Accepted operations and scopes:

| Operation | Scope | Mutation |
| --- | --- | --- |
| `create` | `tasks:create` | `task.content`, `task.boxId`, scheduling and execution metadata |
| `update` | `tasks:update` | content, note, priority, weight, points value, device/execution metadata |
| `schedule` | `tasks:schedule` | schedule, deadline, visibility and defer fields |
| `record_progress` | `tasks:progress` | progress 0–100 and an append-only progress log |
| `record_blocker` / `clear_blocker` | `tasks:progress` | blocker and execution state |
| `append_evidence` | `tasks:evidence` | append-only evidence reference |
| `complete` / `reopen` | `tasks:complete` | completion state and TaskBox completion receipt |
| `soft_delete` / `restore` | `tasks:delete` | tombstone state; hard delete is unsupported |

Success returns the canonical TaskBox task and the new ETag:

```json
{
  "contractVersion": "2026-09-02",
  "requestId": "DSP-...",
  "idempotencyKey": "...",
  "operation": "schedule",
  "applied": true,
  "task": { "id": "real-task-id", "revision": 13 }
}
```

Identical retries return the stored status and response. Reusing an idempotency key or request ID with different content returns `409 idempotency_key_reused`.

## Authorization

Each operation must validate one of these sources:

- `explicit_user`: `authorizationEvidence.referenceId` must match an active server-side grant in `EXECUTION_SYSTEM_EXPLICIT_GRANT_IDS`.
- `standing_rule`: the referenced enabled `hq_review_rules` record must use `source=standing_rule`, `scopeKey=execution.task.write`, and explicitly allow the operation, fields, task/box scope and unexpired time window.
- `approved_hq_proposal`: the referenced daily proposal must be approved. Creation must match its task content and target box exactly. Later mutations require a linked Task ID and explicit `taskSpec.executionPermissions`.

`ai_derived`, candidates and self-declared authority are rejected. Create performs exact active-task duplicate detection in the target box and returns `409 possible_duplicate_task` with candidate Task IDs instead of creating a second record.

## Errors

- `400`: malformed contract, unsupported operation or forbidden fields.
- `401 execution_unauthorized`: wrong execution identity.
- `403`: missing scope or invalid/over-broad authorization evidence.
- `404 task_not_found`: unknown real Task ID.
- `409 task_revision_conflict`: stale revision; response includes current revision and update time.
- `409 possible_duplicate_task`: exact existing task must be reused or reviewed.
- `409 idempotency_key_reused`: key/request replayed with different content.
- `428 task_revision_required`: update omitted `If-Match`/revision.
- `503 execution_api_disabled|execution_api_not_configured`: fail-closed shutdown or missing identity configuration.

Conflicts must never be force-overwritten. The caller must re-read the TaskBox task and obtain a new authorization/idempotency key when the intended mutation still applies.

## Audit and rollback

Every authenticated operation attempt writes an immutable audit row with request ID, operation, Task ID, authorization reference, expected/result revision, outcome, error and actual diff. Tokens and raw authorization headers are never stored.

Immediate stop:

```bash
touch /etc/taskbox-execution-system.disabled
```

Resume after investigation:

```bash
rm /etc/taskbox-execution-system.disabled
```

The deployment script prints the rollback snapshot. Running `rollback-system-candidates-release.sh <snapshot>` disables the execution API before restoring code. Restore SQLite only when explicitly required with `RESTORE_TASKBOX_DATABASE=1`.
