# Assistant Gateway → HQ Proposal Reply Contract

Contract version: `2026-09-03`

The Assistant Gateway may deliver a verified personal-WeChat reply to one existing HQ proposal. It cannot create proposals, promote approved proposals, or call TaskBox task routes.

## Authentication and shutdown

- Authentication: `Authorization: Bearer <assistant-gateway-token>`.
- The token is loaded only from `ASSISTANT_GATEWAY_API_TOKEN_FILE` and has the single scope `proposal-replies:write`.
- The generic browser, HQ, execution-system and Daily Intake tokens cannot use this route. The Assistant Gateway token cannot use generic TaskBox or other HQ routes.
- Creating `ASSISTANT_GATEWAY_API_DISABLE_FILE` immediately makes the route fail closed with `503 assistant_gateway_api_disabled`.

## Endpoint

```http
POST /v1/hq/proposals/:proposalId/replies
Authorization: Bearer <assistant-gateway-token>
Content-Type: application/json
X-Idempotency-Key: <stable-key-for-this-inbound-message-and-decision>
If-Match: "proposal-revision-<expectedProposalRevision>"
```

```json
{
  "proposalId": "proposal-id",
  "inboundMessageId": "durable-inbound-message-id",
  "replyRef": "notification-outbox:reply-id",
  "verifiedUserRef": "verified-user-reference",
  "expectedProposalRevision": 2,
  "decision": "approve",
  "textHash": "64-character-sha256-hex",
  "receivedAt": "2026-09-03T12:00:00.000Z",
  "verification": {
    "verified": true,
    "source": "notification_hub_weixin",
    "signatureRef": "non-secret-verification-reference"
  },
  "note": "optional decision note",
  "deferUntil": "2026-09-10",
  "clarification": "required only for expand"
}
```

`decision` is one of `approve`, `reject`, `defer`, or `expand`:

- `approve` changes only the proposal approval state. It never calls promotion and never writes a TaskBox task.
- `reject` and `defer` reuse the existing HQ proposal state machine. `defer` requires `deferUntil`.
- `expand` appends a clarification audit event and leaves proposal status and revision unchanged.

The path and optional body `proposalId` must match. `expectedProposalRevision` is mandatory; an optional `If-Match` header must use the exact `"proposal-revision-N"` form and match the body. The default accepted message age is 24 hours and is configurable with `ASSISTANT_GATEWAY_REPLY_MAX_AGE_SECONDS`.

## Idempotency and audit

`inboundMessageId` and `X-Idempotency-Key` are independently unique. An identical retry returns the stored response. Reusing either identifier with a changed request returns `409 reply_idempotency_conflict`.

After structural validation and proposal lookup, the service persists the verified reply and an immutable `received` audit before applying any state transition. It then records the decision result. The audit stores references and hashes, not access tokens, authorization headers or raw signatures.

## Responses and errors

Success returns the canonical proposal and `ETag: "proposal-revision-N"`:

```json
{
  "contractVersion": "2026-09-03",
  "replyId": "server-reply-id",
  "inboundMessageId": "durable-inbound-message-id",
  "proposalId": "proposal-id",
  "proposalRevision": 2,
  "decision": "approve",
  "status": "applied",
  "proposal": {},
  "taskboxMutation": false
}
```

- `400`: malformed or incomplete verified reply.
- `401 assistant_gateway_unauthorized`: wrong service identity.
- `403 assistant_gateway_scope_denied`: identity lacks `proposal-replies:write`.
- `404 proposal_not_found`: target proposal does not exist.
- `409 proposal_revision_conflict`: proposal revision changed; no decision was applied.
- `409 reply_expired|reply_timestamp_in_future`: reply is outside the accepted time window.
- `409 reply_idempotency_conflict`: a stable identifier was reused with different content.
- `503 assistant_gateway_api_disabled|assistant_gateway_api_not_configured`: fail-closed shutdown or missing credential.

The WeChat/Notification Hub bridge must stop on conflicts and return them to HQ. It must never fall back to generic HQ or TaskBox write routes.
