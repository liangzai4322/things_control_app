#!/usr/bin/env python3
"""Sync a generated 日省 Markdown into Life HQ and TaskBox.

Credentials are read from TASKBOX_API_TOKEN first, then from the private
TASKBOX_API_TOKEN_FILE (defaults to ~/.codex/secrets/taskbox-api-token).
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path


DEFAULT_ENDPOINT = "https://liangzai666.com/taskbox-api/v1"
DEFAULT_ORIGIN = "https://liangzai4322.github.io"


def resolve_token() -> str:
    token = os.environ.get("TASKBOX_API_TOKEN", "").strip()
    if token:
        return token
    token_file = Path(
        os.environ.get(
            "TASKBOX_API_TOKEN_FILE",
            Path.home() / ".codex" / "secrets" / "taskbox-api-token",
        )
    )
    if token_file.exists():
        return token_file.read_text(encoding="utf-8").strip()
    return ""


def section(markdown: str, heading: str) -> str:
    pattern = re.compile(
        rf"^###\s+{re.escape(heading)}\s*$\n(.*?)(?=^###\s+|^##\s+|\Z)",
        re.MULTILINE | re.DOTALL,
    )
    match = pattern.search(markdown)
    return match.group(1).strip() if match else ""


def bullet_value(block: str, label: str) -> str:
    match = re.search(rf"^\s*-\s*{re.escape(label)}[：:]\s*(.*?)\s*$", block, re.MULTILINE)
    return match.group(1).strip() if match else ""


def list_lines(block: str) -> list[str]:
    values = []
    for line in block.splitlines():
        match = re.match(r"^\s*-\s*(?:\[[ xX]\]\s*)?(.*?)\s*$", line)
        if match and match.group(1).strip():
            values.append(match.group(1).strip())
    return values


def parse_outcomes(block: str) -> dict[str, int | None]:
    labels = {
        "发布数": "published",
        "有效客户 / 合作对话数": "conversations",
        "报价数": "quotes",
        "成交数": "deals",
        "新增真实反馈样本数": "feedback",
    }
    result = {key: None for key in labels.values()}
    for line in block.splitlines():
        if "|" not in line:
            continue
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        if len(cells) < 2:
            continue
        for label, key in labels.items():
            if cells[0] == label:
                number = re.search(r"-?\d+", cells[1])
                result[key] = max(0, int(number.group())) if number else None
    return result


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
                "User-Agent": "TaskBox-Daily-Review/1.0",
            },
        )
        with urllib.request.urlopen(request, timeout=25) as response:
            raw = response.read()
            return json.loads(raw.decode("utf-8")) if raw else None


def normalized_text(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip().casefold()


def upsert_commitment_task(
    api: Api,
    snapshot: dict,
    content: str,
    box_id: str | None,
    role: str,
    pin_level: int,
    brief_date: str,
) -> tuple[dict | None, str | None]:
    if not content:
        return None, None
    tasks = snapshot.get("tasks") or []
    task = next(
        (
            item
            for item in tasks
            if not item.get("deleted")
            and not item.get("isCompleted")
            and normalized_text(item.get("content", "")) == normalized_text(content)
        ),
        None,
    )
    patch = {
        "content": content,
        "boxId": task.get("boxId") if task else box_id,
        "commitmentRole": role,
        "commitmentDate": brief_date,
        "commitmentSource": "daily_review",
        "pinLevel": pin_level,
        "pinned": True,
        "visibleAfter": f"{brief_date}T00:00:00+08:00",
        "updatedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
    }
    if task:
        task = api.request(
            f"/tasks/{urllib.parse.quote(task['id'])}",
            "PATCH",
            {**task, **patch},
        )
        action = "updated"
    else:
        now = dt.datetime.now(dt.timezone.utc).isoformat()
        task = api.request(
            "/tasks",
            "POST",
            {
                "id": str(uuid.uuid4()),
                **patch,
                "deviceContext": "universal",
                "executionMode": "self",
                "priority": 1 if role == "primary" else 2,
                "progress": 0,
                "isCompleted": False,
                "createdAt": now,
                "syncKey": f"daily-review::{brief_date}::{role}::{hashlib.sha1(content.encode('utf-8')).hexdigest()[:12]}",
            },
        )
        snapshot.setdefault("tasks", []).append(task)
        action = "created"
    return task, action


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--file", required=True, type=Path)
    parser.add_argument("--date", required=True, help="日省归属日期，YYYY-MM-DD")
    parser.add_argument("--brief-date", help="行动驾驶舱日期，默认日省日期 + 1 天")
    parser.add_argument("--endpoint", default=os.environ.get("TASKBOX_API_ENDPOINT", DEFAULT_ENDPOINT))
    parser.add_argument("--feishu-url", default="")
    parser.add_argument("--card-url", default="")
    args = parser.parse_args()

    token = resolve_token()
    if not token:
        print(json.dumps({"ok": False, "error": "TASKBOX_API_TOKEN_missing"}, ensure_ascii=False))
        return 2
    review_date = dt.date.fromisoformat(args.date)
    brief_date = dt.date.fromisoformat(args.brief_date) if args.brief_date else review_date + dt.timedelta(days=1)
    review_key = review_date.isoformat()
    brief_key = brief_date.isoformat()
    markdown = args.file.read_text(encoding="utf-8")
    api = Api(args.endpoint, token)

    taskbox = api.request("/taskbox")
    boxes = taskbox.get("boxes") or []
    important_box = next((box for box in boxes if box.get("color") == "important" or box.get("name") == "重要盒"), None)
    todo_box = next((box for box in boxes if box.get("color") == "misc" or box.get("name") == "待办盒"), None)

    action_block = section(markdown, "明日唯一动作")
    primary_content = bullet_value(action_block, "动作")
    maintenance = list_lines(section(markdown, "维护动作（最多 2 项）"))[:2]
    primary_task, primary_action = upsert_commitment_task(
        api, taskbox, primary_content, important_box.get("id") if important_box else None,
        "primary", 1, brief_key,
    )
    maintenance_results = [
        upsert_commitment_task(
            api, taskbox, content, todo_box.get("id") if todo_box else None,
            "maintenance", index + 2, brief_key,
        )
        for index, content in enumerate(maintenance)
    ]
    maintenance_tasks = [task for task, _ in maintenance_results if task]
    task_actions = [action for _, action in [(primary_task, primary_action), *maintenance_results] if action]

    closure_block = section(markdown, "昨日唯一承诺闭环")
    closure = {
        "commitment": bullet_value(closure_block, "承诺"),
        "result": bullet_value(closure_block, "结果"),
        "evidence": bullet_value(closure_block, "完成证据"),
        "reason": bullet_value(closure_block, "未完成的直接原因"),
        "decision": bullet_value(closure_block, "处理决定"),
    }
    api.request(
        f"/hq/daily-briefs/{review_key}",
        "POST",
        {
            "reviewDate": review_key,
            "outcomes": parse_outcomes(section(markdown, "今日外部结果")),
            "yesterdayClosure": closure,
            "source": "daily_review",
            "reviewCompletedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
            "reviewArtifacts": {
                "markdownPath": str(args.file.resolve()),
                "feishuUrl": args.feishu_url.strip(),
                "cardUrl": args.card_url.strip(),
            },
        },
    )
    tomorrow_brief = api.request(
        f"/hq/daily-briefs/{brief_key}",
        "POST",
        {
            "reviewDate": brief_key,
            "primaryTaskId": primary_task.get("id") if primary_task else None,
            "maintenanceTaskIds": [task["id"] for task in maintenance_tasks],
            "stopDoing": list_lines(section(markdown, "明日停止做")),
            "continueDoing": list_lines(section(markdown, "明日继续做")),
            "source": "daily_review",
            "plannedFromReviewDate": review_key,
        },
    )

    if closure.get("decision") in {"升级处理", "待用户决定"}:
        decision_title = closure.get("commitment") or "连续未完成事项需要处理"
        decision_id = f"daily-{review_key}-{hashlib.sha1(decision_title.encode('utf-8')).hexdigest()[:12]}"
        api.request(
            "/hq/decisions",
            "POST",
            {
                "id": decision_id,
                "title": decision_title,
                "context": closure.get("reason") or "来自日省承诺闭环",
                "urgency": "high" if closure.get("decision") == "升级处理" else "normal",
                "status": "open",
                "createdAt": dt.datetime.now(dt.timezone.utc).isoformat(),
                "source": "daily_review",
            },
        )

    print(json.dumps({
        "ok": True,
        "reviewDate": review_key,
        "briefDate": brief_key,
        "primaryTaskId": primary_task.get("id") if primary_task else None,
        "maintenanceTaskIds": [task["id"] for task in maintenance_tasks],
        "tasksCreated": task_actions.count("created"),
        "tasksUpdated": task_actions.count("updated"),
        "briefUpdatedAt": tomorrow_brief.get("updatedAt"),
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, urllib.error.URLError) as exc:
        print(json.dumps({"ok": False, "error": type(exc).__name__, "message": str(exc)}, ensure_ascii=False))
        raise SystemExit(1)
