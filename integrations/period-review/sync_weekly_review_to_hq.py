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
    section_prefix,
    table_rows,
)


def list_or_summary(block: str) -> list[str]:
    values = list_lines(block)
    if values:
        return values
    summary = plain_summary(block)
    return [summary] if summary else []


def parse_weekly_review(markdown: str) -> dict:
    bottleneck_heading, bottleneck_block = section_prefix(markdown, "主瓶颈：", 3)
    bottleneck_fields = bullet_map(bottleneck_block)
    experiment = bullet_map(section(markdown, "六、下周唯一实验"))
    return {
        "verdict": plain_summary(section(markdown, "一、本周经营裁决")),
        "previousCommitments": table_rows(section(markdown, "二、上周承诺验收")),
        "metrics": {"rows": table_rows(section(markdown, "三、本周外部结果仪表盘"))},
        "bottleneck": {
            "title": re.sub(r"^主瓶颈[：:]\s*", "", bottleneck_heading),
            "rootCause": bottleneck_fields.get("根因", ""),
            "systemFix": bottleneck_fields.get("系统修正", ""),
            "evidence": bottleneck_fields.get("验证证据", ""),
        },
        "experiment": {
            "hypothesis": experiment.get("假设", ""),
            "action": experiment.get("实验动作", ""),
            "sampleSize": experiment.get("样本数量", ""),
            "successThreshold": experiment.get("成功阈值", ""),
            "failureThreshold": experiment.get("失败阈值", ""),
            "dueDate": experiment.get("截止日期", ""),
            "decisionAfter": experiment.get("到期后的决策", ""),
        },
        "resources": table_rows(section(markdown, "七、下周资源分配")),
        "startStopContinue": {
            "start": list_or_summary(section(markdown, "Start（最多 1 条）", 3)),
            "stop": list_or_summary(section(markdown, "Stop（最多 1 条）", 3)),
            "continue": list_or_summary(section(markdown, "Continue（最多 1 条）", 3)),
        },
        "scoreboard": list_lines(section(markdown, "十一、下周记分牌")),
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
    parsed = parse_weekly_review(markdown)
    key = period_key("week", args.start, args.end)
    payload = {
        **parsed,
        "periodType": "week",
        "periodKey": key,
        "startDate": args.start,
        "endDate": args.end,
        "status": "synced",
        "source": "weekly_review",
        "completedAt": completed_at(),
        "artifacts": {
            "markdownPath": str(args.file.resolve()),
            "feishuUrl": args.feishu_url.strip(),
            "cardUrl": args.card_url.strip(),
        },
    }
    review = Api(args.endpoint, token).request(f"/hq/periods/week/{key}", "POST", payload)
    print(json.dumps({
        "ok": True,
        "periodKey": key,
        "status": review.get("status"),
        "experiment": (review.get("experiment") or {}).get("action"),
        "scoreboardItems": len(review.get("scoreboard") or []),
        "updatedAt": review.get("updatedAt"),
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, urllib.error.URLError) as exc:
        print(json.dumps({"ok": False, "error": type(exc).__name__, "message": str(exc)}, ensure_ascii=False))
        raise SystemExit(1)
