#!/usr/bin/env python3
"""Fetch a compact TaskBox/Life HQ evidence pack before running 日省."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


DEFAULT_ENDPOINT = "https://liangzai666.com/taskbox-api/v1"
DEFAULT_ORIGIN = "https://liangzai4322.github.io"
DEFAULT_OUTPUT_DIR = Path(r"D:\note_new\06-日常输入_输出\99_系统\缓存\人生参谋部")


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


class Api:
    def __init__(self, endpoint: str, token: str):
        self.endpoint = endpoint.rstrip("/")
        self.token = token

    def get(self, path: str) -> dict:
        request = urllib.request.Request(
            f"{self.endpoint}{path}",
            headers={
                "Authorization": f"Bearer {self.token}",
                "Origin": os.environ.get("TASKBOX_API_ORIGIN", DEFAULT_ORIGIN),
                "User-Agent": "TaskBox-Daily-Review/1.0",
            },
        )
        with urllib.request.urlopen(request, timeout=25) as response:
            return json.loads(response.read().decode("utf-8"))


def task_line(task: dict) -> str:
    content = str(task.get("content") or "未命名任务").strip()
    evidence = str(task.get("completionEvidence") or "").strip()
    progress = max(0, min(100, int(task.get("progress") or 0)))
    suffix = []
    if task.get("isCompleted"):
        suffix.append("盒子已完成")
    elif progress:
        suffix.append(f"进度 {progress}%")
    if evidence:
        suffix.append(f"证据：{evidence}")
    return f"- {content}" + (f"（{'；'.join(suffix)}）" if suffix else "")


def project_line(project: dict) -> str:
    name = str(project.get("name") or "未命名项目").strip()
    health = {
        "healthy": "推进中",
        "stale": "停滞",
        "blocked": "阻塞",
        "needs_action": "缺少下一步",
    }.get(project.get("health"), project.get("health") or "未知")
    next_action = (project.get("nextAction") or {}).get("content") or "尚无下一步"
    return f"- {name}｜{health}｜下一步：{next_action}"


def build_evidence_pack(review_date: str, daily: dict, hq: dict, review: dict) -> dict:
    commitments = hq.get("commitments") or {}
    primary = commitments.get("primary")
    maintenance = commitments.get("maintenance") or []
    projects = hq.get("projects") or []
    decisions = hq.get("decisions") or []
    touched = daily.get("tasks") or []
    completed = daily.get("completedTasks") or []
    progress = daily.get("progressTasks") or []
    risks = [item for item in projects if item.get("health") in {"blocked", "stale", "needs_action"}]
    return {
        "schemaVersion": 1,
        "reviewDate": review_date,
        "fetchedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
        "commitments": {"primary": primary, "maintenance": maintenance},
        "evidence": {"touched": touched, "completed": completed, "progress": progress},
        "projects": {"all": projects, "risks": risks},
        "decisions": decisions,
        "ai": hq.get("ai") or {},
        "review": review,
    }


def render_markdown(pack: dict) -> str:
    commitments = pack["commitments"]
    primary = commitments.get("primary")
    maintenance = commitments.get("maintenance") or []
    evidence = pack["evidence"]
    risks = pack["projects"]["risks"]
    decisions = pack["decisions"]
    review = pack.get("review") or {}
    lines = [
        f"# 人生参谋部事实包 {pack['reviewDate']}",
        "",
        "> 本文件由服务器事实生成。日省可以引用其中的盒子状态、进度和证据，但仍需保持原始表述，不补写不存在的结果。",
        "",
        "## 今日承诺",
        task_line(primary) if primary else "- 未设置唯一主动作",
    ]
    lines.extend(task_line(task) for task in maintenance)
    if not maintenance:
        lines.append("- 未设置维护动作")
    lines.extend(["", "## 今日明确完成"])
    lines.extend(task_line(task) for task in evidence["completed"])
    if not evidence["completed"]:
        lines.append("- 盒子没有今日完成记录")
    lines.extend(["", "## 今日进度记录"])
    lines.extend(task_line(task) for task in evidence["progress"])
    if not evidence["progress"]:
        lines.append("- 盒子没有今日进度记录")
    lines.extend(["", "## 项目预警"])
    lines.extend(project_line(project) for project in risks)
    if not risks:
        lines.append("- 当前没有项目预警")
    lines.extend(["", "## 待决策"])
    lines.extend(f"- {item.get('title') or '未命名决策'}｜{item.get('context') or '未记录背景'}" for item in decisions)
    if not decisions:
        lines.append("- 当前没有待决策事项")
    lines.extend([
        "",
        "## 最近 7 天承诺",
        f"- 有效判定：{review.get('knownCount', 0)} 天",
        f"- 完成：{review.get('completedCount', 0)} 天",
        f"- 完成率：{review.get('completionRate') if review.get('completionRate') is not None else '证据不足'}",
        "",
        "## 事实包统计",
        f"- 今日触达任务：{len(evidence['touched'])}",
        f"- 今日完成任务：{len(evidence['completed'])}",
        f"- 今日有进度任务：{len(evidence['progress'])}",
        f"- 项目预警：{len(risks)}",
        f"- 待决策：{len(decisions)}",
        "",
    ])
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--date", required=True, help="日省归属日期，YYYY-MM-DD")
    parser.add_argument("--endpoint", default=os.environ.get("TASKBOX_API_ENDPOINT", DEFAULT_ENDPOINT))
    parser.add_argument("--output", type=Path)
    parser.add_argument("--json-output", type=Path)
    args = parser.parse_args()

    review_date = dt.date.fromisoformat(args.date).isoformat()
    output = args.output or DEFAULT_OUTPUT_DIR / f"{review_date}-事实包.md"
    token = resolve_token()
    if not token:
        print(json.dumps({"ok": False, "error": "TASKBOX_API_TOKEN_missing"}, ensure_ascii=False))
        return 2

    api = Api(args.endpoint, token)
    encoded = urllib.parse.quote(review_date)
    daily = api.get(f"/daily-snapshot?date={encoded}")
    hq = api.get(f"/hq/today?date={encoded}")
    review = hq.get("review")
    if not review:
        try:
            review = api.get(f"/hq/review-status?date={encoded}&days=7")
        except urllib.error.HTTPError as exc:
            if exc.code != 404:
                raise
            review = {"status": "pending", "history": [], "knownCount": 0, "completedCount": 0}
    pack = build_evidence_pack(review_date, daily, hq, review)

    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(render_markdown(pack), encoding="utf-8")
    if args.json_output:
        args.json_output.parent.mkdir(parents=True, exist_ok=True)
        args.json_output.write_text(json.dumps(pack, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({
        "ok": True,
        "reviewDate": review_date,
        "output": str(output.resolve()),
        "completedTasks": len(pack["evidence"]["completed"]),
        "progressTasks": len(pack["evidence"]["progress"]),
        "projectRisks": len(pack["projects"]["risks"]),
        "decisions": len(pack["decisions"]),
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, urllib.error.URLError) as exc:
        print(json.dumps({"ok": False, "error": type(exc).__name__, "message": str(exc)}, ensure_ascii=False))
        raise SystemExit(1)
