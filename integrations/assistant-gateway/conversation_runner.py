#!/usr/bin/env python3
"""Mac-side authenticated runner for durable personal-Weixin conversation turns."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

from crypto_payload import open_text, read_key, seal_text


class RunnerError(RuntimeError):
    pass


class RunnerApiError(RunnerError):
    def __init__(self, code: str, status: int | None = None):
        super().__init__(code)
        self.code = code
        self.status = status


class ApiClient:
    def __init__(self, base_url: str, token_file: Path, timeout: int = 35):
        self.base_url = base_url.rstrip("/")
        self.token_file = token_file
        self.timeout = timeout

    def post(self, route: str, body: dict) -> dict:
        token = self.token_file.read_text(encoding="utf-8").strip()
        request_data = json.dumps(body, separators=(",", ":")).encode("utf-8")
        last_error: Exception | None = None
        for attempt in range(3):
            request = urllib.request.Request(
                self.base_url + route, data=request_data,
                headers={
                    "Authorization": f"Bearer {token}",
                    "Content-Type": "application/json",
                    "User-Agent": "taskbox-assistant-conversation-runner/1",
                }, method="POST",
            )
            try:
                with urllib.request.urlopen(request, timeout=self.timeout) as response:
                    value = json.loads(response.read().decode("utf-8"))
                break
            except urllib.error.HTTPError as error:
                last_error = error
                if error.code not in {502, 503, 504} or attempt == 2:
                    raise RunnerApiError(f"conversation_api_http_{error.code}", error.code) from error
            except (urllib.error.URLError, TimeoutError, OSError, json.JSONDecodeError) as error:
                last_error = error
                if attempt == 2:
                    raise RunnerApiError("conversation_api_unavailable") from error
            time.sleep(1 + attempt)
        else:
            raise RunnerApiError("conversation_api_unavailable") from last_error
        if not isinstance(value, dict):
            raise RunnerError("conversation_api_invalid")
        return value


class SessionStore:
    def __init__(self, path: Path):
        self.path = path

    def _read(self) -> dict:
        try:
            value = json.loads(self.path.read_text(encoding="utf-8"))
        except (FileNotFoundError, OSError, json.JSONDecodeError):
            return {"sessions": {}, "pendingResults": {}}
        if not isinstance(value, dict):
            return {"sessions": {}, "pendingResults": {}}
        if "sessions" not in value:
            value = {"sessions": value, "pendingResults": {}}
        if not isinstance(value.get("sessions"), dict):
            value["sessions"] = {}
        if not isinstance(value.get("pendingResults"), dict):
            value["pendingResults"] = {}
        return value

    def _write(self, value: dict) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_name(f".{self.path.name}.{os.getpid()}.tmp")
        temporary.write_text(json.dumps(value, separators=(",", ":")), encoding="utf-8")
        os.chmod(temporary, 0o600)
        temporary.replace(self.path)

    def get(self, conversation_key: str) -> str | None:
        value = self._read()["sessions"].get(conversation_key)
        return value if isinstance(value, str) and value else None

    def stage_result(self, turn_id: str, record: dict) -> None:
        value = self._read()
        value["pendingResults"][turn_id] = record
        self._write(value)

    def first_pending(self) -> tuple[str, dict] | None:
        pending = self._read()["pendingResults"]
        if not pending:
            return None
        turn_id = next(iter(pending))
        return turn_id, dict(pending[turn_id])

    def commit_result(self, turn_id: str) -> None:
        value = self._read()
        record = value["pendingResults"].pop(turn_id)
        value["sessions"][record["conversationKey"]] = record["nextSessionId"]
        self._write(value)

    def drop_result(self, turn_id: str) -> None:
        value = self._read()
        value["pendingResults"].pop(turn_id, None)
        self._write(value)


def run_codex(prompt: str, session_id: str | None, output_path: Path,
              executable: str = "/Applications/ChatGPT.app/Contents/Resources/codex") -> tuple[str, str]:
    command = [executable, "exec"]
    if session_id:
        command += ["resume", "--skip-git-repo-check", "-o", str(output_path), session_id, "-"]
    else:
        command += ["--skip-git-repo-check", "--json", "-o", str(output_path), "-"]
    result = subprocess.run(command, input=prompt, text=True, capture_output=True, timeout=300, check=False)
    if result.returncode != 0:
        raise RunnerError("codex_execution_failed")
    next_session = session_id
    if not session_id:
        for line in result.stdout.splitlines():
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if event.get("type") == "thread.started" and event.get("thread_id"):
                next_session = str(event["thread_id"])
                break
    if not next_session:
        raise RunnerError("codex_session_missing")
    try:
        reply = output_path.read_text(encoding="utf-8").strip()
    except OSError as error:
        raise RunnerError("codex_result_missing") from error
    if not reply or len(reply) > 12000:
        raise RunnerError("codex_result_invalid")
    return next_session, reply


def flush_pending_result(client: ApiClient, sessions: SessionStore) -> bool:
    pending = sessions.first_pending()
    if not pending:
        return True
    turn_id, record = pending
    try:
        client.post(f"/assistant-gateway/conversation/turns/{turn_id}/result", {
            "runnerId": record["runnerId"],
            "leaseToken": record["leaseToken"],
            "resultPayload": record["resultPayload"],
            "resultHash": record["resultHash"],
        })
    except RunnerApiError as error:
        if error.status == 409:
            sessions.drop_result(turn_id)
            return True
        return False
    sessions.commit_result(turn_id)
    return True


def run_once(client: ApiClient, sessions: SessionStore, payload_key: bytes,
             runner_id: str = "mac-personal-assistant") -> bool:
    if sessions.first_pending():
        return flush_pending_result(client, sessions)
    claimed = client.post("/assistant-gateway/conversation/turns/claim", {
        "runnerId": runner_id, "leaseSeconds": 360,
    })
    item = claimed.get("item")
    if not isinstance(item, dict):
        return False
    turn_id = str(item["turnId"])
    lease_token = str(item["leaseToken"])
    conversation_key = str(item["conversationKeyHash"])
    try:
        prompt = open_text(str(item["promptPayload"]), payload_key)
        session_id = sessions.get(conversation_key)
        if not session_id:
            prompt = (
                "你是佩宣的个人小助理。用简洁自然的中文直接回应用户；可读取当前工作区和系统上下文，"
                "但只能在现有授权边界内行动。不要用固定收件回执冒充回答。用户消息：\n" + prompt
            )
        with tempfile.TemporaryDirectory() as directory:
            output_path = Path(directory) / "reply.txt"
            next_session, reply = run_codex(prompt, session_id, output_path)
        result_hash = __import__("hashlib").sha256(reply.encode("utf-8")).hexdigest()
        sessions.stage_result(turn_id, {
            "runnerId": runner_id,
            "leaseToken": lease_token,
            "resultPayload": seal_text(reply, payload_key),
            "resultHash": result_hash,
            "conversationKey": conversation_key,
            "nextSessionId": next_session,
        })
        flush_pending_result(client, sessions)
    except Exception as error:
        if not sessions.first_pending():
            error_code = error.code if isinstance(error, (RunnerError, RunnerApiError)) else "runner_unexpected_failure"
            client.post(f"/assistant-gateway/conversation/turns/{turn_id}/fail", {
                "runnerId": runner_id,
                "leaseToken": lease_token,
                "errorCode": error_code,
            })
    return True


def main() -> int:
    token_file = Path(os.environ.get("ASSISTANT_CONVERSATION_RUNNER_TOKEN_FILE", ""))
    key_file = Path(os.environ.get("ASSISTANT_CONVERSATION_PAYLOAD_KEY_FILE", ""))
    if not token_file.is_file() or not key_file.is_file():
        return 2
    client = ApiClient(os.environ.get("TASKBOX_API_ENDPOINT", "https://liangzai666.com/taskbox-api/v1"), token_file)
    sessions = SessionStore(Path(os.environ.get(
        "ASSISTANT_CONVERSATION_SESSION_FILE",
        str(Path.home() / ".codex" / "assistant-conversation-sessions.json"),
    )))
    key = read_key(key_file)
    while True:
        worked = run_once(client, sessions, key)
        if not worked:
            time.sleep(3)


if __name__ == "__main__":
    raise SystemExit(main())
