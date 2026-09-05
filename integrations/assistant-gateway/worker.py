#!/usr/bin/env python3
"""Lease verified Weixin messages and run the Assistant Gateway echo gate."""

from __future__ import annotations

import hashlib
import json
import os
import re
import signal
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping

from crypto_payload import open_text, read_key, seal_text


class GatewayError(RuntimeError):
    def __init__(self, code: str, status: int | None = None, response: Mapping[str, Any] | None = None):
        super().__init__(code)
        self.code = code
        self.status = status
        self.response = dict(response or {})


class JsonClient:
    def __init__(self, base_url: str, token_file: Path, timeout: int = 35):
        self.base_url = base_url.rstrip("/")
        self.token_file = token_file
        self.timeout = timeout

    def request(self, method: str, route: str, payload: Mapping[str, Any] | None = None,
                headers: Mapping[str, str] | None = None) -> dict[str, Any]:
        token = self.token_file.read_text(encoding="utf-8").strip()
        if not token:
            raise GatewayError("credential_empty")
        request_headers = {
            "Authorization": f"Bearer {token}",
            "User-Agent": "taskbox-assistant-gateway/1",
            **dict(headers or {}),
        }
        data = None
        if payload is not None:
            request_headers["Content-Type"] = "application/json"
            data = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        request = urllib.request.Request(
            self.base_url + route,
            data=data,
            headers=request_headers,
            method=method,
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                result = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            try:
                response = json.loads(error.read().decode("utf-8"))
            except (json.JSONDecodeError, UnicodeDecodeError):
                response = {}
            raise GatewayError(f"remote_http_{error.code}", error.code, response) from error
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            raise GatewayError("remote_unavailable") from error
        if not isinstance(result, dict):
            raise GatewayError("remote_response_invalid")
        return result

    def get(self, route: str, headers: Mapping[str, str] | None = None) -> dict[str, Any]:
        return self.request("GET", route, headers=headers)

    def post(self, route: str, payload: Mapping[str, Any], headers: Mapping[str, str] | None = None) -> dict[str, Any]:
        return self.request("POST", route, payload, headers)


class DecisionStore:
    def __init__(self, path: Path):
        self.path = path

    def _read(self) -> dict[str, dict[str, Any]]:
        try:
            value = json.loads(self.path.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            return {}
        return value if isinstance(value, dict) else {}

    def get(self, inbound_message_id: str) -> dict[str, Any] | None:
        record = self._read().get(inbound_message_id)
        return dict(record) if isinstance(record, dict) else None

    def put(self, inbound_message_id: str, record: Mapping[str, Any]) -> None:
        records = self._read()
        records[inbound_message_id] = dict(record)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_name(f".{self.path.name}.{os.getpid()}.tmp")
        temporary.write_text(json.dumps(records, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        os.chmod(temporary, 0o600)
        temporary.replace(self.path)

    def remove(self, inbound_message_id: str) -> None:
        records = self._read()
        if inbound_message_id not in records:
            return
        records.pop(inbound_message_id, None)
        self.put_all(records)

    def put_all(self, records: Mapping[str, Mapping[str, Any]]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_name(f".{self.path.name}.{os.getpid()}.tmp")
        temporary.write_text(json.dumps(records, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        os.chmod(temporary, 0o600)
        temporary.replace(self.path)

    def count_promotion_pending(self) -> int:
        return sum(
            1 for record in self._read().values()
            if isinstance(record, Mapping) and record.get("promotionPending") is True
        )


STATUS_FIELDS = (
    "lastClaimAt", "lastReplyAt", "pendingCount", "automationCount",
    "promotionPendingCount", "retryCount", "deadLetterCount",
)


def utc_timestamp() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


class GatewayStatus:
    """Persist only the operational fields safe for local health aggregation."""

    def __init__(self, path: Path):
        self.path = path
        self.value = self._read()

    def _read(self) -> dict[str, Any]:
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            raw = {}
        if not isinstance(raw, dict):
            raw = {}
        def count(name: str) -> int:
            try:
                return max(0, int(raw.get(name) or 0))
            except (TypeError, ValueError):
                return 0

        return {
            "lastClaimAt": raw.get("lastClaimAt") if isinstance(raw.get("lastClaimAt"), str) else None,
            "lastReplyAt": raw.get("lastReplyAt") if isinstance(raw.get("lastReplyAt"), str) else None,
            "pendingCount": count("pendingCount"),
            "automationCount": count("automationCount"),
            "promotionPendingCount": count("promotionPendingCount"),
            "retryCount": count("retryCount"),
            "deadLetterCount": count("deadLetterCount"),
        }

    def snapshot(self) -> dict[str, Any]:
        return {field: self.value[field] for field in STATUS_FIELDS}

    def _write(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_name(f".{self.path.name}.{os.getpid()}.tmp")
        temporary.write_text(
            json.dumps(self.snapshot(), ensure_ascii=False, separators=(",", ":")),
            encoding="utf-8",
        )
        os.chmod(temporary, 0o600)
        temporary.replace(self.path)

    def record_claim(self, pending_count: int) -> None:
        self.value["lastClaimAt"] = utc_timestamp()
        self.value["pendingCount"] = max(0, int(pending_count))
        self._write()

    def record_automation_count(self, automation_count: int) -> None:
        self.value["automationCount"] = max(0, int(automation_count))
        self._write()

    def record_reply(self) -> None:
        self.value["lastReplyAt"] = utc_timestamp()
        self._write()

    def record_outcome(self, outcome: str) -> None:
        if outcome == "retry":
            self.value["retryCount"] += 1
        elif outcome == "dead_letter":
            self.value["deadLetterCount"] += 1
        else:
            return
        self._write()

    def sync_promotion_pending(self, store: DecisionStore) -> None:
        self.value["promotionPendingCount"] = store.count_promotion_pending()
        self._write()


def verify_message(message: Mapping[str, Any]) -> str:
    verification = message.get("authVerification") or {}
    if verification.get("transport") != "ilink_bearer_poll" or verification.get("senderBound") is not True:
        raise GatewayError("inbound_identity_unverified")
    for field in ("inboundMessageId", "senderIdentity", "conversationRef", "receivedAt", "bridgeRequestId", "leaseToken"):
        if not str(message.get(field) or "").strip():
            raise GatewayError(f"inbound_{field}_missing")
    text = str(message.get("text") or "")
    supplied_hash = str(message.get("originalMessageHash") or "").lower()
    actual_hash = hashlib.sha256(text.encode("utf-8")).hexdigest()
    if supplied_hash != actual_hash:
        raise GatewayError("inbound_text_hash_mismatch")
    return text.strip()


def claim(client: JsonClient) -> list[dict[str, Any]]:
    result = client.post("/v1/weixin-inbound/claim", {
        "consumerId": "assistant-gateway",
        "limit": 1,
        "leaseSeconds": 120,
        "waitSeconds": 20,
    })
    messages = result.get("messages")
    if not isinstance(messages, list):
        raise GatewayError("claim_response_invalid")
    return [dict(item) for item in messages if isinstance(item, Mapping)]


def acknowledge(client: JsonClient, message: Mapping[str, Any], outcome: str, error: str | None = None,
                status: GatewayStatus | None = None, retry_after_seconds: int = 3600) -> None:
    inbound_id = urllib.parse.quote(str(message["inboundMessageId"]), safe="")
    payload: dict[str, Any] = {
        "consumerId": "assistant-gateway",
        "leaseToken": str(message["leaseToken"]),
        "outcome": outcome,
    }
    if outcome == "retry":
        payload["retryAfterSeconds"] = max(5, min(3600, int(retry_after_seconds)))
    if error:
        payload["error"] = error[:240]
    client.post(f"/v1/weixin-inbound/{inbound_id}/ack", payload)
    if status:
        status.record_outcome(outcome)


def send_echo(client: JsonClient, message: Mapping[str, Any], status: GatewayStatus | None = None) -> None:
    inbound_id = urllib.parse.quote(str(message["inboundMessageId"]), safe="")
    client.post(f"/v1/weixin-inbound/{inbound_id}/reply", {
        "consumerId": "assistant-gateway",
        "leaseToken": str(message["leaseToken"]),
        "replyKey": f"echo:{message['inboundMessageId']}",
        "text": "已收到，微信助手通路正常",
    })
    if status:
        status.record_reply()


def verified_user_ref(message: Mapping[str, Any]) -> str:
    sender_hash = hashlib.sha256(str(message["senderIdentity"]).encode("utf-8")).hexdigest()
    return f"notification-hub-user:{sender_hash}"


def conversation_ref_hash(message: Mapping[str, Any]) -> str:
    return hashlib.sha256(str(message["conversationRef"]).encode("utf-8")).hexdigest()


def parse_decision(text: str) -> tuple[str, dict[str, str]] | None:
    normalized = text.strip().lower()
    exact = {
        "同意": "approve",
        "批准": "approve",
        "approve": "approve",
        "拒绝": "reject",
        "不同意": "reject",
        "reject": "reject",
        "展开": "expand",
        "补充说明": "expand",
        "expand": "expand",
    }
    if normalized in exact:
        decision = exact[normalized]
        return decision, ({"clarification": "用户通过微信请求展开提案信息。"} if decision == "expand" else {})
    match = re.fullmatch(r"(?:延期|延期到|defer\s+)(\d{4}-\d{2}-\d{2})", normalized)
    if match:
        try:
            time.strptime(match.group(1), "%Y-%m-%d")
        except ValueError:
            return None
        return "defer", {"deferUntil": match.group(1)}
    return None


def pending_proposals(client: JsonClient, message: Mapping[str, Any]) -> list[dict[str, Any]]:
    response = client.get("/v1/assistant-gateway/proposals/pending-user-decision?limit=20", {
        "X-Assistant-Verified-User-Ref": verified_user_ref(message),
        "X-Assistant-Conversation-Ref-Hash": conversation_ref_hash(message),
    })
    items = response.get("items")
    if not isinstance(items, list):
        raise GatewayError("pending_response_invalid")
    return [dict(item) for item in items if isinstance(item, Mapping)]


def automation_queue(client: JsonClient) -> list[dict[str, Any]]:
    response = client.get("/v1/assistant-gateway/proposals/automation-queue?limit=20")
    items = response.get("items")
    if not isinstance(items, list):
        raise GatewayError("automation_queue_response_invalid")
    return [dict(item) for item in items if isinstance(item, Mapping)]


def conversation_dispatch_key(message: Mapping[str, Any]) -> str:
    value = f"{message['inboundMessageId']}\0{message['originalMessageHash']}"
    return f"weixin-chat:{hashlib.sha256(value.encode('utf-8')).hexdigest()}"


def process_conversation(hub: JsonClient, conversation: JsonClient, payload_key: bytes,
                         message: Mapping[str, Any], text: str,
                         status: GatewayStatus | None = None) -> None:
    inbound_id = str(message["inboundMessageId"])
    dispatch_key = conversation_dispatch_key(message)
    turn = conversation.post("/v1/assistant-gateway/conversation/turns", {
        "conversationKeyHash": conversation_ref_hash(message),
        "dispatchKey": dispatch_key,
        "inboundMessageId": inbound_id,
        "textHash": str(message["originalMessageHash"]),
        "promptPayload": seal_text(text, payload_key),
    })
    turn_id = str(turn.get("turnId") or "")
    if not turn_id:
        raise GatewayError("conversation_turn_invalid")
    wait_seconds = max(0, min(100, int(os.environ.get("ASSISTANT_CONVERSATION_WAIT_SECONDS", "90"))))
    deadline = time.monotonic() + wait_seconds
    while turn.get("status") in {"pending", "leased"} and time.monotonic() < deadline:
        time.sleep(min(2, max(0.05, deadline - time.monotonic())))
        route_key = urllib.parse.quote(dispatch_key, safe="")
        turn = conversation.get(f"/v1/assistant-gateway/conversation/turns/by-dispatch/{route_key}")
    turn_status = str(turn.get("status") or "")
    if turn_status in {"result_ready", "replied"}:
        try:
            reply = open_text(str(turn.get("resultPayload") or ""), payload_key)
        except (TypeError, ValueError) as error:
            raise GatewayError("conversation_result_payload_invalid") from error
        if turn_status == "result_ready":
            escaped_id = urllib.parse.quote(inbound_id, safe="")
            hub.post(f"/v1/weixin-inbound/{escaped_id}/reply", {
                "consumerId": "assistant-gateway",
                "leaseToken": str(message["leaseToken"]),
                "replyKey": f"conversation:{hashlib.sha256(dispatch_key.encode('utf-8')).hexdigest()}",
                "text": reply,
            })
            if status:
                status.record_reply()
            conversation.post(f"/v1/assistant-gateway/conversation/turns/{turn_id}/replied", {})
        acknowledge(hub, message, "processed", status=status)
        conversation.post(f"/v1/assistant-gateway/conversation/turns/{turn_id}/completed", {})
        emit("conversation_processed", inboundMessageId=inbound_id, outcome="processed", mode="decision")
        return
    if turn_status == "completed":
        acknowledge(hub, message, "processed", status=status)
        return
    if turn_status == "dead_letter":
        acknowledge(hub, message, "dead_letter", str(turn.get("errorCode") or "conversation_failed"), status)
        return
    acknowledge(hub, message, "retry", "assistant_conversation_pending", status, retry_after_seconds=15)
    emit("conversation_pending", inboundMessageId=inbound_id, outcome="retry", mode="decision")


def decision_confirmation(decision: str, patch: Mapping[str, str]) -> str:
    if decision == "approve":
        return "已记录：同意。提案已批准并安全加入任务盒。"
    if decision == "reject":
        return "已记录：拒绝。"
    if decision == "defer":
        return f"已记录：延期到 {patch['deferUntil']}。"
    return "已记录：请补充提案信息。"


SAFE_PROMOTION_FIELDS = {
    "boxId", "content", "clearAction", "boxReason", "note", "scheduledAt", "dueDate",
    "visibleAfter", "deviceContext", "executionMode",
}


def validate_manual_promotion(proposal: Mapping[str, Any]) -> None:
    if proposal.get("proposalType") != "daily_action_proposal" or proposal.get("evidenceStatus") == "provisional":
        raise GatewayError("promotion_proposal_not_safe")
    if proposal.get("disposition") != "confirmation_required" or proposal.get("promotionEligible") is not True:
        raise GatewayError("promotion_eligibility_missing")
    spec = proposal.get("taskSpec") if isinstance(proposal.get("taskSpec"), Mapping) else {}
    if set(spec) - SAFE_PROMOTION_FIELDS:
        raise GatewayError("promotion_fields_denied")
    content = str(spec.get("content") or "").strip()
    clear_action = str(spec.get("clearAction") or "").strip()
    if (not str(spec.get("boxId") or "").strip() or not str(spec.get("boxReason") or "").strip()
            or not content or content != clear_action):
        raise GatewayError("promotion_task_spec_invalid")


def validate_auto_promotion(proposal: Mapping[str, Any]) -> tuple[str, int]:
    validate_manual_promotion({**proposal, "disposition": "confirmation_required", "promotionEligible": True})
    if proposal.get("disposition") != "auto_eligible":
        raise GatewayError("auto_promotion_eligibility_missing")
    rule_id = str(proposal.get("standingRuleId") or "")
    rule_version = int(proposal.get("standingRuleVersion") or 0)
    if rule_id != "execution.daily_action_proposal.auto_approve" or rule_version < 1:
        raise GatewayError("auto_promotion_rule_invalid")
    return rule_id, rule_version


def process_automation_queue(reader: JsonClient, writer: JsonClient, store: DecisionStore,
                             status: GatewayStatus | None = None) -> None:
    proposals = automation_queue(reader)
    if status:
        status.record_automation_count(len(proposals))
    for proposal in proposals:
        proposal_id = str(proposal.get("proposalId") or "")
        revision = int(proposal.get("revision") or 0)
        rule_id, rule_version = validate_auto_promotion(proposal)
        state_id = f"automation:{proposal_id}:{revision}"
        fingerprint = hashlib.sha256(state_id.encode("utf-8")).hexdigest()
        record = store.get(state_id) or {
            "proposalId": proposal_id,
            "revision": revision,
            "approvalApplied": False,
            "promotionPending": False,
            "promotionApplied": False,
            "approvalKey": f"assistant-gateway:auto-approve:{fingerprint}",
            "promotionKey": f"assistant-gateway:auto-promote:{fingerprint}",
        }
        if record.get("proposalId") != proposal_id or int(record.get("revision") or 0) != revision:
            raise GatewayError("automation_state_conflict", 409)
        if not record.get("approvalApplied"):
            approved = writer.post(
                f"/v1/hq/proposals/{urllib.parse.quote(proposal_id, safe='')}/approve",
                {
                    "proposalId": proposal_id,
                    "expectedProposalRevision": revision,
                    "standingRuleId": rule_id,
                    "standingRuleVersion": rule_version,
                    "reasonCode": "standing_rule_low_risk_auto_approve",
                },
                {"X-Idempotency-Key": record["approvalKey"], "If-Match": f'"proposal-revision-{revision}"'},
            )
            if approved.get("status") != "approved" or approved.get("decisionId") != proposal_id:
                raise GatewayError("auto_approval_contract_invalid")
            record["approvalApplied"] = True
            record["promotionPending"] = True
            store.put(state_id, record)
        if not record.get("promotionApplied"):
            promoted = writer.post(
                f"/v1/hq/proposals/{urllib.parse.quote(proposal_id, safe='')}/promote",
                {
                    "proposalId": proposal_id,
                    "expectedProposalRevision": revision,
                    "authorizationSource": "standing_rule",
                    "standingRuleId": rule_id,
                    "standingRuleVersion": rule_version,
                    "reasonCode": "standing_rule_low_risk_auto_promote",
                },
                {"X-Idempotency-Key": record["promotionKey"], "If-Match": f'"proposal-revision-{revision}"'},
            )
            if (promoted.get("status") != "promoted" or promoted.get("proposalId") != proposal_id
                    or promoted.get("taskboxMutation") is not True or not promoted.get("taskId")):
                raise GatewayError("auto_promotion_contract_invalid")
            record["promotionApplied"] = True
            record["promotionPending"] = False
            store.put(state_id, record)
        store.remove(state_id)
        emit("automation_promoted", mode="decision")


def build_decision_record(message: Mapping[str, Any], proposal: Mapping[str, Any],
                          decision: str, patch: Mapping[str, str]) -> dict[str, Any]:
    inbound_id = str(message["inboundMessageId"])
    proposal_id = str(proposal.get("proposalId") or "")
    revision = int(proposal.get("revision") or 0)
    binding = proposal.get("replyBinding") if isinstance(proposal.get("replyBinding"), Mapping) else {}
    if (not proposal_id or revision < 1 or binding.get("verifiedSource") != "notification_hub_weixin"
            or not str(binding.get("signatureRef") or "") or not str(binding.get("bindingRef") or "")
            or not str(binding.get("sessionRef") or "")):
        raise GatewayError("pending_binding_invalid")
    allowed = proposal.get("allowedDecisions")
    if not isinstance(allowed, list) or decision not in allowed:
        raise GatewayError("decision_not_allowed")
    if decision == "approve":
        validate_manual_promotion(proposal)
    message_hash = str(message["originalMessageHash"])
    decision_fingerprint = hashlib.sha256(
        f"{inbound_id}\0{proposal_id}\0{decision}".encode("utf-8"),
    ).hexdigest()
    bridge_ref = hashlib.sha256(str(message["bridgeRequestId"]).encode("utf-8")).hexdigest()
    idempotency_key = f"assistant-gateway:decision:{decision_fingerprint}"
    payload = {
        "proposalId": proposal_id,
        "inboundMessageId": inbound_id,
        "replyRef": f"notification-hub:bridge:{bridge_ref}",
        "verifiedUserRef": verified_user_ref(message),
        "conversationRefHash": conversation_ref_hash(message),
        "sessionRef": str(binding["sessionRef"]),
        "expectedProposalRevision": revision,
        "decision": decision,
        "textHash": message_hash,
        "receivedAt": str(message["receivedAt"]),
        "verification": {
            "verified": True,
            "source": "notification_hub_weixin",
            "signatureRef": str(binding["signatureRef"]),
        },
        "reasonCode": "verified_weixin_user_decision",
        "scopeKey": str(binding.get("bindingRef") or ""),
        "fingerprint": message_hash,
        **dict(patch),
    }
    return {
        "proposalId": proposal_id,
        "revision": revision,
        "decision": decision,
        "textHash": message_hash,
        "idempotencyKey": idempotency_key,
        "payload": payload,
        "confirmation": decision_confirmation(decision, patch),
        "hqApplied": False,
        "promotionPending": False,
        "promotionApplied": False,
        "replySent": False,
    }


def process_decision(hub: JsonClient, hq_reader: JsonClient, hq_writer: JsonClient,
                     store: DecisionStore, message: Mapping[str, Any],
                     status: GatewayStatus | None = None,
                     conversation: JsonClient | None = None, payload_key: bytes | None = None) -> None:
    inbound_id = str(message.get("inboundMessageId") or "")
    try:
        text = verify_message(message)
        if text == "测试" or text.startswith("测试-"):
            send_echo(hub, message, status)
            acknowledge(hub, message, "processed", status=status)
            emit("echo_processed", inboundMessageId=inbound_id, outcome="processed", mode="decision")
            return
        parsed = parse_decision(text)
        if not parsed:
            if conversation is not None and payload_key is not None:
                process_conversation(hub, conversation, payload_key, message, text, status)
                return
            acknowledge(hub, message, "retry", "decision_not_explicit", status)
            emit("message_deferred", inboundMessageId=inbound_id, attemptCount=message.get("attemptCount"), mode="decision")
            return
        decision, patch = parsed
        record = store.get(inbound_id)
        if record and record.get("textHash") != message.get("originalMessageHash"):
            raise GatewayError("decision_state_hash_conflict", 409)
        if not record:
            proposals = pending_proposals(hq_reader, message)
            if len(proposals) != 1:
                if not proposals and conversation is not None and payload_key is not None:
                    process_conversation(hub, conversation, payload_key, message, text, status)
                    return
                reason = "no_pending_proposal" if not proposals else "ambiguous_pending_proposals"
                acknowledge(hub, message, "retry", reason, status)
                emit("message_deferred", inboundMessageId=inbound_id, attemptCount=message.get("attemptCount"), mode="decision")
                return
            record = build_decision_record(message, proposals[0], decision, patch)
            store.put(inbound_id, record)
        if not record.get("hqApplied"):
            response = hq_writer.post(
                f"/v1/hq/proposals/{urllib.parse.quote(str(record['proposalId']), safe='')}/replies",
                record["payload"],
                {
                    "X-Idempotency-Key": str(record["idempotencyKey"]),
                    "If-Match": f'"proposal-revision-{record["revision"]}"',
                },
            )
            if response.get("taskboxMutation") is not False or response.get("proposalId") != record["proposalId"]:
                raise GatewayError("hq_reply_contract_invalid")
            if record.get("decision") == "approve":
                proposal = response.get("proposal") if isinstance(response.get("proposal"), Mapping) else {}
                reply_id = str(response.get("replyId") or "")
                if proposal.get("status") != "approved" or not reply_id:
                    raise GatewayError("hq_approval_receipt_invalid")
                promotion_fingerprint = hashlib.sha256(
                    f"{inbound_id}\0{record['proposalId']}\0{record['revision']}\0{record['payload']['scopeKey']}".encode("utf-8"),
                ).hexdigest()
                record["promotion"] = {
                    "idempotencyKey": f"assistant-gateway:promotion:{promotion_fingerprint}",
                    "payload": {
                        "proposalId": record["proposalId"],
                        "expectedProposalRevision": record["revision"],
                        "authorizationSource": "explicit_user",
                        "approvalReplyId": reply_id,
                        "inboundMessageId": inbound_id,
                        "bindingRef": record["payload"]["scopeKey"],
                        "sessionRef": record["payload"]["sessionRef"],
                        "reasonCode": "verified_weixin_user_approval",
                    },
                }
                record["promotionPending"] = True
            record["hqApplied"] = True
            store.put(inbound_id, record)
        if record.get("decision") == "approve" and not record.get("promotionApplied"):
            promotion = record.get("promotion") if isinstance(record.get("promotion"), Mapping) else {}
            promotion_payload = promotion.get("payload") if isinstance(promotion.get("payload"), Mapping) else {}
            promotion_key = str(promotion.get("idempotencyKey") or "")
            if not record.get("promotionPending") or not promotion_key or not promotion_payload:
                raise GatewayError("promotion_state_missing", 409)
            response = hq_writer.post(
                f"/v1/hq/proposals/{urllib.parse.quote(str(record['proposalId']), safe='')}/promote",
                promotion_payload,
                {
                    "X-Idempotency-Key": promotion_key,
                    "If-Match": f'"proposal-revision-{record["revision"]}"',
                },
            )
            if (response.get("taskboxMutation") is not True or response.get("proposalId") != record["proposalId"]
                    or response.get("status") != "promoted" or not str(response.get("taskId") or "")):
                raise GatewayError("hq_promotion_contract_invalid")
            record["promotionApplied"] = True
            record["promotionPending"] = False
            record["taskId"] = str(response["taskId"])
            store.put(inbound_id, record)
        if not record.get("replySent"):
            escaped_id = urllib.parse.quote(inbound_id, safe="")
            hub.post(f"/v1/weixin-inbound/{escaped_id}/reply", {
                "consumerId": "assistant-gateway",
                "leaseToken": str(message["leaseToken"]),
                "replyKey": f"decision:{hashlib.sha256(inbound_id.encode('utf-8')).hexdigest()}",
                "text": str(record["confirmation"]),
            })
            if status:
                status.record_reply()
            record["replySent"] = True
            store.put(inbound_id, record)
        acknowledge(hub, message, "processed", status=status)
        store.remove(inbound_id)
        emit("decision_processed", inboundMessageId=inbound_id, outcome="processed", mode="decision")
    except GatewayError as error:
        permanent = error.status in {400, 401, 403, 409} or error.code.startswith("inbound_")
        try:
            acknowledge(hub, message, "dead_letter" if permanent else "retry", error.code, status)
            if permanent:
                store.remove(inbound_id)
        except GatewayError:
            pass
        emit("message_failed", inboundMessageId=inbound_id, error=error.code, mode="decision")


def emit(event: str, **fields: Any) -> None:
    safe = {key: value for key, value in fields.items() if key in {
        "inboundMessageId", "attemptCount", "outcome", "error", "mode",
    }}
    print(json.dumps({"event": event, **safe}, ensure_ascii=False, separators=(",", ":")), flush=True)


def process_echo(client: JsonClient, message: Mapping[str, Any], status: GatewayStatus | None = None) -> None:
    inbound_id = str(message.get("inboundMessageId") or "")
    try:
        text = verify_message(message)
        if text != "测试" and not text.startswith("测试-"):
            acknowledge(client, message, "retry", "echo_mode_only", status)
            emit("message_deferred", inboundMessageId=inbound_id, attemptCount=message.get("attemptCount"), mode="echo")
            return
        send_echo(client, message, status)
        acknowledge(client, message, "processed", status=status)
        emit("echo_processed", inboundMessageId=inbound_id, outcome="processed", mode="echo")
    except GatewayError as error:
        permanent = error.status in {400, 401, 403, 409} or error.code.startswith("inbound_")
        try:
            acknowledge(client, message, "dead_letter" if permanent else "retry", error.code, status)
        except GatewayError:
            pass
        emit("message_failed", inboundMessageId=inbound_id, error=error.code, mode="echo")


def credential_path(name: str) -> Path:
    directory = os.environ.get("CREDENTIALS_DIRECTORY", "").strip()
    if not directory:
        raise GatewayError("credentials_directory_missing")
    path = Path(directory) / name
    if not path.is_file():
        raise GatewayError(f"credential_missing_{name}")
    return path


def main() -> int:
    configured_mode = os.environ.get("ASSISTANT_GATEWAY_MODE", "echo").strip().lower()
    # Older production units used the human-facing name; keep it as a strict
    # alias for decision mode so a stale drop-in cannot dead-letter messages.
    mode = {"production": "decision", "prod": "decision"}.get(configured_mode, configured_mode)
    if mode not in {"echo", "decision"}:
        raise GatewayError("unsupported_gateway_mode")
    ingress_token = credential_path("weixin-ingress.token")
    hq_reply_token = credential_path("hq-reply.token")
    hq_read_token = credential_path("hq-read.token")
    conversation_token = credential_path("conversation-producer.token")
    payload_key = read_key(credential_path("conversation-payload.key"))
    hub = JsonClient(os.environ.get("NOTIFICATION_HUB_BASE_URL", "http://127.0.0.1:3219"), ingress_token)
    hq_base_url = os.environ.get("TASKBOX_HQ_BASE_URL", "http://127.0.0.1:3107")
    hq_reader = JsonClient(hq_base_url, hq_read_token)
    hq_writer = JsonClient(hq_base_url, hq_reply_token)
    conversation = JsonClient(hq_base_url, conversation_token)
    store = DecisionStore(Path(os.environ.get(
        "ASSISTANT_GATEWAY_STATE_FILE", "/var/lib/taskbox-assistant-gateway/decision-state.json",
    )))
    status = GatewayStatus(Path(os.environ.get(
        "ASSISTANT_GATEWAY_STATUS_FILE", "/var/lib/taskbox-assistant-gateway/status.json",
    )))
    status.sync_promotion_pending(store)
    disable_file = Path(os.environ.get("ASSISTANT_GATEWAY_WORKER_DISABLE_FILE", "/etc/taskbox-assistant-gateway-worker.disabled"))
    running = True

    def stop(_signum: int, _frame: Any) -> None:
        nonlocal running
        running = False

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    emit("worker_started", mode=mode)
    while running:
        if disable_file.exists():
            time.sleep(5)
            continue
        try:
            if mode == "decision":
                process_automation_queue(hq_reader, hq_writer, store, status)
            messages = claim(hub)
            status.record_claim(len(messages))
            for message in messages:
                if mode == "decision":
                    process_decision(hub, hq_reader, hq_writer, store, message, status, conversation, payload_key)
                else:
                    process_echo(hub, message, status)
        except GatewayError as error:
            emit("claim_failed", error=error.code, mode=mode)
            if error.status in {401, 403}:
                return 1
            time.sleep(10)
        finally:
            status.sync_promotion_pending(store)
    emit("worker_stopped", mode=mode)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except GatewayError as error:
        emit("worker_configuration_failed", error=error.code)
        raise SystemExit(1)
