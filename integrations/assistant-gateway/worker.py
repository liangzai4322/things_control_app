#!/usr/bin/env python3
"""Lease verified Weixin messages and run the Assistant Gateway echo gate."""

from __future__ import annotations

import hashlib
import json
import os
import signal
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Mapping


class GatewayError(RuntimeError):
    def __init__(self, code: str, status: int | None = None):
        super().__init__(code)
        self.code = code
        self.status = status


class JsonClient:
    def __init__(self, base_url: str, token_file: Path, timeout: int = 35):
        self.base_url = base_url.rstrip("/")
        self.token_file = token_file
        self.timeout = timeout

    def post(self, route: str, payload: Mapping[str, Any], headers: Mapping[str, str] | None = None) -> dict[str, Any]:
        token = self.token_file.read_text(encoding="utf-8").strip()
        if not token:
            raise GatewayError("credential_empty")
        request_headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "User-Agent": "taskbox-assistant-gateway/1",
            **dict(headers or {}),
        }
        request = urllib.request.Request(
            self.base_url + route,
            data=json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
            headers=request_headers,
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                result = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            raise GatewayError(f"remote_http_{error.code}", error.code) from error
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            raise GatewayError("remote_unavailable") from error
        if not isinstance(result, dict):
            raise GatewayError("remote_response_invalid")
        return result


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


def acknowledge(client: JsonClient, message: Mapping[str, Any], outcome: str, error: str | None = None) -> None:
    inbound_id = urllib.parse.quote(str(message["inboundMessageId"]), safe="")
    payload: dict[str, Any] = {
        "consumerId": "assistant-gateway",
        "leaseToken": str(message["leaseToken"]),
        "outcome": outcome,
    }
    if outcome == "retry":
        payload["retryAfterSeconds"] = 3600
    if error:
        payload["error"] = error[:240]
    client.post(f"/v1/weixin-inbound/{inbound_id}/ack", payload)


def send_echo(client: JsonClient, message: Mapping[str, Any]) -> None:
    inbound_id = urllib.parse.quote(str(message["inboundMessageId"]), safe="")
    client.post(f"/v1/weixin-inbound/{inbound_id}/reply", {
        "consumerId": "assistant-gateway",
        "leaseToken": str(message["leaseToken"]),
        "replyKey": f"echo:{message['inboundMessageId']}",
        "text": "已收到，微信助手通路正常",
    })


def emit(event: str, **fields: Any) -> None:
    safe = {key: value for key, value in fields.items() if key in {
        "inboundMessageId", "attemptCount", "outcome", "error", "mode",
    }}
    print(json.dumps({"event": event, **safe}, ensure_ascii=False, separators=(",", ":")), flush=True)


def process_echo(client: JsonClient, message: Mapping[str, Any]) -> None:
    inbound_id = str(message.get("inboundMessageId") or "")
    try:
        text = verify_message(message)
        if text != "测试" and not text.startswith("测试-"):
            acknowledge(client, message, "retry", "echo_mode_only")
            emit("message_deferred", inboundMessageId=inbound_id, attemptCount=message.get("attemptCount"), mode="echo")
            return
        send_echo(client, message)
        acknowledge(client, message, "processed")
        emit("echo_processed", inboundMessageId=inbound_id, outcome="processed", mode="echo")
    except GatewayError as error:
        permanent = error.status in {400, 401, 403, 409} or error.code.startswith("inbound_")
        try:
            acknowledge(client, message, "dead_letter" if permanent else "retry", error.code)
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
    mode = os.environ.get("ASSISTANT_GATEWAY_MODE", "echo").strip()
    if mode != "echo":
        raise GatewayError("unsupported_gateway_mode")
    ingress_token = credential_path("weixin-ingress.token")
    credential_path("hq-reply.token")  # Required now, but intentionally unused by echo mode.
    hub = JsonClient(os.environ.get("NOTIFICATION_HUB_BASE_URL", "http://127.0.0.1:3219"), ingress_token)
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
            messages = claim(hub)
            for message in messages:
                process_echo(hub, message)
        except GatewayError as error:
            emit("claim_failed", error=error.code, mode=mode)
            if error.status in {401, 403}:
                return 1
            time.sleep(10)
    emit("worker_stopped", mode=mode)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except GatewayError as error:
        emit("worker_configuration_failed", error=error.code)
        raise SystemExit(1)
