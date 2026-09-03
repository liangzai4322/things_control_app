# Daily Review Intake Transport

## Purpose and boundary

The Daily Review transport receives one immutable daily package from each independent system and records a compact processing receipt. It is a coordination channel, not a second task database: it never creates, updates, completes, or deletes TaskBox tasks. TaskBox remains the only task fact source.

The supported system identifiers are `execution`, `health`, `attention`, `feedback`, `mission`, `box-app`, `life-hq`, and `governance`. Packages retain the producer's `contractVersion`; an unfamiliar version is stored so that a consumer can explicitly acknowledge it with an `ignored` receipt rather than silently dropping evidence.

## API contract

All Daily Intake routes require a dedicated, file-backed service identity; the browser TaskBox token and the execution-system token are explicitly rejected. `DAILY_INTAKE_API_ENABLED=1` is required and `/etc/taskbox-daily-intake.disabled` immediately fail-closes the transport. Deployment creates mode-`0600` token files under `/etc/taskbox-daily-intake/`; distribute their values only through the recipient's secret manager, never through source control, browser storage, logs, or receipt payloads.

- `sender` has only `intakes:write` and may call the batch endpoint.
- `execution`, `health`, `attention`, `feedback`, and `mission` each have only `intakes:read` and `receipts:write`, restricted to their own `systemId`.
- `hq` has only `receipts:read` and may call the HQ projection endpoint.
- Every other route rejects a Daily Intake credential, preventing it from becoming a general TaskBox API token.

- `POST /v1/system-candidates/batch`
  - Daily intake mode is selected by `packages`, `sentSystems`, or a single package with `systemId` and `contractVersion`.
  - A package must include `schemaVersion: 1`, `contractVersion`, `systemId`, `reviewDate`, `observationPeriod`, `sourceRef`, `evidenceRefs`, `freshness`, positive integer `revision`, `idempotencyKey`, and non-empty `data`.
  - Returns `201` when every package is accepted, or `207` with independent `accepted` and `rejected` arrays when a batch is partial.
- `GET /v1/system-candidates?intake=1&systemId=<id>&reviewDate=<YYYY-MM-DD>&status=<status>&limit=<n>`
  - The mandatory `intake=1` preserves the older system-candidate inbox contract when it is absent.
  - Returns producer data plus the current receipt for the designated consumer only.
- `POST /v1/system-candidates/:intakeId/receipt`
  - Body: `status`, stable `idempotencyKey`, and a safe summary `projection`; optional `errorCode`, `errorMessage`, and `retryAt` support recovery.
  - Receipt statuses are `received`, `processing`, `processed`, `retrying`, `failed`, and `ignored`.
- `GET /v1/hq/system-receipts?reviewDate=<YYYY-MM-DD>&systemId=<id>`
  - Returns only the HQ-safe intake reference and receipt projection. It deliberately omits the producer's `data` payload.

## Idempotency and lifecycle

An intake is unique by both its producer idempotency key and `(systemId, reviewDate, revision)`. Retrying the identical payload returns the original intake. Reusing either key with changed content returns a conflict instead of overwriting history. Receipt requests have a separate idempotency ledger, so retrying the same receipt is safe and a changed payload using the same receipt key conflicts.

Consumers read only their own pending or retrying intake records, post one terminal `processed`, `failed`, or `ignored` receipt, and never patch the intake or write local producer facts back to TaskBox. A consumer that cannot safely interpret a newer contract must post `ignored` with `unsupported_contract_version` when the intake identity is valid.

## Legacy compatibility

The existing candidate inbox remains unchanged:

- Legacy writes use `POST /v1/system-candidates/batch` with `{ "candidates": [...] }`.
- Legacy reads omit `intake=1`.
- Legacy candidate review routes continue to use their existing `PATCH` behavior.

Daily-intake consumers must include `intake=1`; otherwise they may see legacy candidate records instead of the transport view.

## Local verification

`npm run test:daily-intake-e2e` boots an isolated temporary API/database and verifies the dedicated sender, consumer, and HQ scopes; authenticated intake writes for execution, health, attention, feedback, and mission; partial-batch behavior; identical retry behavior; unknown-contract acknowledgement; record reads; receipt persistence; the HQ-safe projection; and that no TaskBox task was created. Browser consumers are covered with pure request adapters in their individual `test:*intake` scripts; the E2E test validates the transport boundary rather than a browser runtime.
