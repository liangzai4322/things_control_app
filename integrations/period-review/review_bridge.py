from __future__ import annotations

import datetime as dt
import json
import os
import re
import urllib.request
from pathlib import Path


DEFAULT_ENDPOINT = "https://liangzai666.com/taskbox-api/v1"
DEFAULT_ORIGIN = "https://liangzai4322.github.io"


def resolve_token() -> str:
    token = os.environ.get("TASKBOX_API_TOKEN", "").strip()
    if token:
        return token
    token_file = Path(os.environ.get(
        "TASKBOX_API_TOKEN_FILE",
        Path.home() / ".codex" / "secrets" / "taskbox-api-token",
    ))
    return token_file.read_text(encoding="utf-8").strip() if token_file.exists() else ""


class Api:
    def __init__(self, endpoint: str, token: str):
        self.endpoint = endpoint.rstrip("/")
        self.token = token

    def request(self, path: str, method: str = "GET", payload: dict | None = None):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8") if payload is not None else None
        request = urllib.request.Request(
            f"{self.endpoint}{path}",
            data=body,
            method=method,
            headers={
                "Authorization": f"Bearer {self.token}",
                "Content-Type": "application/json",
                "Origin": os.environ.get("TASKBOX_API_ORIGIN", DEFAULT_ORIGIN),
                "User-Agent": "TaskBox-Period-Review/1.0",
            },
        )
        with urllib.request.urlopen(request, timeout=30) as response:
            raw = response.read()
            return json.loads(raw.decode("utf-8")) if raw else None


def section(markdown: str, heading: str, level: int = 2) -> str:
    marker = "#" * level
    pattern = re.compile(
        rf"^{marker}\s+{re.escape(heading)}\s*$\n(.*?)(?=^#{{1,{level}}}\s+|\Z)",
        re.MULTILINE | re.DOTALL,
    )
    match = pattern.search(markdown)
    return match.group(1).strip() if match else ""


def section_prefix(markdown: str, prefix: str, level: int = 2) -> tuple[str, str]:
    marker = "#" * level
    pattern = re.compile(
        rf"^{marker}\s+({re.escape(prefix)}.*?)\s*$\n(.*?)(?=^#{{1,{level}}}\s+|\Z)",
        re.MULTILINE | re.DOTALL,
    )
    match = pattern.search(markdown)
    return (match.group(1).strip(), match.group(2).strip()) if match else ("", "")


def bullet_map(block: str) -> dict[str, str]:
    result = {}
    for line in block.splitlines():
        match = re.match(r"^\s*-\s*([^：:]+)[：:]\s*(.*?)\s*$", line)
        if match:
            result[match.group(1).strip()] = match.group(2).strip()
    return result


def list_lines(block: str) -> list[str]:
    values = []
    for line in block.splitlines():
        match = re.match(r"^\s*-\s*(?:\[[ xX]\]\s*)?(.*?)\s*$", line)
        if match and match.group(1).strip():
            values.append(match.group(1).strip())
    return values


def table_rows(block: str) -> list[dict[str, str]]:
    lines = [line.strip() for line in block.splitlines() if line.strip().startswith("|")]
    if len(lines) < 2:
        return []
    headers = [cell.strip() for cell in lines[0].strip("|").split("|")]
    rows = []
    for line in lines[1:]:
        cells = [cell.strip() for cell in line.strip("|").split("|")]
        if all(re.fullmatch(r":?-{3,}:?", cell.replace(" ", "")) for cell in cells):
            continue
        if len(cells) == len(headers):
            rows.append(dict(zip(headers, cells)))
    return rows


def plain_summary(block: str) -> str:
    lines = []
    for line in block.splitlines():
        value = line.strip()
        if not value or value.startswith("|") or value.startswith(">"):
            continue
        value = re.sub(r"^[-*]\s*", "", value)
        value = re.sub(r"^#{1,6}\s+", "", value)
        if value:
            lines.append(value)
    return "\n".join(lines).strip()


def completed_at() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def period_key(period_type: str, start_date: str, end_date: str) -> str:
    return start_date[:7] if period_type == "month" else f"{start_date}_to_{end_date}"
