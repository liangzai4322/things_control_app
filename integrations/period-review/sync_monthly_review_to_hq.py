#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
import urllib.error
from pathlib import Path

from review_bridge import (
    Api,
    DEFAULT_ENDPOINT,
    bullet_map,
    completed_at,
    list_lines,
    period_key,
    plain_summary,
    resolve_token,
    section,
    table_rows,
)


def parse_strategic_decisions(markdown: str) -> list[dict]:
    block = section(markdown, "七、本月战略决策（最多 3 条）")
    decisions = []
    pattern = re.compile(r"^###\s+决策\s*\d+\s*$\n(.*?)(?=^###\s+|^##\s+|\Z)", re.MULTILINE | re.DOTALL)
    for match in pattern.finditer(block):
        fields = bullet_map(match.group(1))
        if fields.get("决定"):
            decisions.append({
                "decision": fields.get("决定", ""),
                "evidence": fields.get("证据", ""),
                "reversibility": fields.get("可逆性", ""),
                "limit": fields.get("时间 / 预算上限", ""),
                "reviewDate": fields.get("复查日期", ""),
                "exitCondition": fields.get("退出条件", ""),
            })
    return decisions[:3]


def parse_goals(markdown: str) -> list[dict]:
    goal_types = [
        ("现金结果目标", "cash"),
        ("增长验证目标", "growth"),
        ("能力 / 系统目标", "system"),
    ]
    goals = []
    for heading, goal_type in goal_types:
        block = section(markdown, heading, 3)
        fields = bullet_map(block)
        summary = plain_summary(block)
        if summary:
            goals.append({"type": goal_type, "title": fields.get("目标", "") or summary.splitlines()[0], "detail": summary})
    return goals


def parse_monthly_review(markdown: str) -> dict:
    return {
        "verdict": plain_summary(section(markdown, "一、本月经营裁决")),
        "previousCommitments": table_rows(section(markdown, "二、上月承诺验收")),
        "metrics": {"summary": plain_summary(section(markdown, "三、本月经营仪表盘"))},
        "portfolio": table_rows(section(markdown, "四、业务组合与 ROI")),
        "strategicDecisions": parse_strategic_decisions(markdown),
        "resources": table_rows(section(markdown, "八、下月资源分配")),
        "startStopContinue": {
            "start": list_lines(section(markdown, "Start（最多 1 条）", 3)),
            "stop": list_lines(section(markdown, "Stop（最多 1 条）", 3)),
            "continue": list_lines(section(markdown, "Keep（最多 1 条）", 3)),
        },
        "goals": parse_goals(markdown),
        "notDoing": list_lines(section(markdown, "十二、下月不做清单")),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--file", required=True, type=Path)
    parser.add_argument("--start", required=True)
    parser.add_argument("--end", required=True)
    parser.add_argument("--endpoint", default=DEFAULT_ENDPOINT)
    parser.add_argument("--feishu-url", default="")
    parser.add_argument("--card-url", default="")
    args = parser.parse_args()
    token = resolve_token()
    if not token:
        print(json.dumps({"ok": False, "error": "TASKBOX_API_TOKEN_missing"}, ensure_ascii=False))
        return 2
    markdown = args.file.read_text(encoding="utf-8")
    parsed = parse_monthly_review(markdown)
    key = period_key("month", args.start, args.end)
    payload = {
        **parsed,
        "periodType": "month",
        "periodKey": key,
        "startDate": args.start,
        "endDate": args.end,
        "status": "synced",
        "source": "monthly_review",
        "completedAt": completed_at(),
        "artifacts": {
            "markdownPath": str(args.file.resolve()),
            "feishuUrl": args.feishu_url.strip(),
            "cardUrl": args.card_url.strip(),
        },
    }
    review = Api(args.endpoint, token).request(f"/hq/periods/month/{key}", "POST", payload)
    print(json.dumps({
        "ok": True,
        "periodKey": key,
        "status": review.get("status"),
        "strategicDecisions": len(review.get("strategicDecisions") or []),
        "goals": len(review.get("goals") or []),
        "updatedAt": review.get("updatedAt"),
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, urllib.error.URLError) as exc:
        print(json.dumps({"ok": False, "error": type(exc).__name__, "message": str(exc)}, ensure_ascii=False))
        raise SystemExit(1)
