#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
import urllib.error
from pathlib import Path

import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from feedback_continuity import build_continuity, evidence_ref, stable_id

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


def first_section(markdown: str, *headings: str, level: int = 2) -> str:
    for heading in headings:
        block = section(markdown, heading, level)
        if block:
            return block
    return ""


def first_section_prefix(markdown: str, *prefixes: str, level: int = 3) -> tuple[str, str]:
    for prefix in prefixes:
        heading, block = section_prefix(markdown, prefix, level)
        if heading or block:
            return heading, block
    return "", ""


def parse_weekly_review(markdown: str) -> dict:
    bottleneck_heading, bottleneck_block = first_section_prefix(
        markdown, "主瓶颈：", "主瓶颈:", level=3
    )
    bottleneck_fields = bullet_map(bottleneck_block)
    experiment = bullet_map(
        first_section(markdown, "4. 下周唯一实验", "六、下周唯一实验")
    )
    previous_commitments = first_section(
        markdown, "上周承诺验收", level=3
    ) or first_section(markdown, "二、上周承诺验收")
    metrics = first_section(
        markdown, "本周外部结果", level=3
    ) or first_section(markdown, "三、本周外部结果仪表盘")
    resources = first_section(
        markdown, "保护时段与维护上限", level=3
    ) or first_section(markdown, "七、下周资源分配")
    scoreboard = first_section(
        markdown, "下周记分牌", level=3
    ) or first_section(markdown, "十一、下周记分牌")
    return {
        "verdict": plain_summary(
            first_section(markdown, "1. 本周判决", "一、本周经营裁决")
        ),
        "previousCommitments": table_rows(previous_commitments),
        "metrics": {"rows": table_rows(metrics)},
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
        "resources": table_rows(resources),
        "startStopContinue": {
            "start": list_or_summary(
                first_section(markdown, "Start", "Start（最多 1 条）", level=3)
            ),
            "stop": list_or_summary(
                first_section(markdown, "Stop", "Stop（最多 1 条）", level=3)
            ),
            "continue": list_or_summary(
                first_section(markdown, "Continue", "Continue（最多 1 条）", level=3)
            ),
        },
        "scoreboard": list_lines(scoreboard),
    }


def build_sync_payload(
    markdown_path: Path,
    start: str,
    end: str,
    summary_path: Path | None = None,
    context_pack: Path | None = None,
    feishu_url: str = "",
    card_url: str = "",
) -> dict:
    if summary_path and summary_path.is_file():
        summary = json.loads(summary_path.read_text(encoding="utf-8-sig"))
        parsed = summary.get("hqPayload") or {
            key: summary.get(key)
            for key in (
                "verdict", "previousCommitments", "metrics", "bottleneck", "experiment",
                "resources", "startStopContinue", "scoreboard", "feedbackContinuity",
            )
            if summary.get(key) is not None
        }
    else:
        parsed = parse_weekly_review(markdown_path.read_text(encoding="utf-8-sig"))
    key = period_key("week", start, end)
    explicit = dict(parsed.get("feedbackContinuity") or {})
    if not explicit.get("experiments"):
        experiment = parsed.get("experiment") or {}
        if experiment.get("hypothesis") or experiment.get("action"):
            explicit["experiments"] = [{
                "experimentId": stable_id("experiment", experiment.get("continuityKey") or experiment.get("hypothesis") or experiment.get("action")),
                "hypothesis": experiment.get("hypothesis") or experiment.get("action"),
                "changedVariable": experiment.get("changedVariable") or experiment.get("action"),
                "evaluateAt": experiment.get("dueDate", ""),
                "successConditions": [experiment.get("successThreshold")] if experiment.get("successThreshold") else [],
                "stopConditions": [experiment.get("failureThreshold")] if experiment.get("failureThreshold") else [],
                "status": "proposed",
            }]
    if not explicit.get("deviations"):
        bottleneck = parsed.get("bottleneck") or {}
        if bottleneck.get("title") and (bottleneck.get("evidence") or bottleneck.get("rootCause")):
            explicit["deviations"] = [{
                "deviationId": stable_id("deviation", bottleneck.get("continuityKey") or bottleneck.get("title")),
                "subjectRef": bottleneck.get("title"), "type": "execution", "severity": "medium",
                "facts": [value for value in (bottleneck.get("evidence"), bottleneck.get("rootCause")) if value],
                "interpretation": bottleneck.get("systemFix", ""), "observedAt": f"{end}T23:59:00+08:00",
            }]
    feedback_continuity = build_continuity(
        "week", key, markdown_path, {"feedbackContinuity": explicit},
        [evidence_ref("context_pack", str(context_pack.resolve()), context_pack.name, str(context_pack.resolve()))] if context_pack and context_pack.is_file() else [],
    )
    return {
        **parsed,
        "feedbackContinuity": feedback_continuity,
        "periodType": "week",
        "periodKey": key,
        "startDate": start,
        "endDate": end,
        "status": "synced",
        "source": "weekly_review",
        "completedAt": completed_at(),
        "artifacts": {
            "markdownPath": str(markdown_path.resolve()),
            "summaryPath": str(summary_path.resolve()) if summary_path and summary_path.is_file() else "",
            "contextPackPath": str(context_pack.resolve()) if context_pack and context_pack.is_file() else "",
            "feishuUrl": feishu_url.strip(),
            "cardUrl": card_url.strip(),
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--file", required=True, type=Path)
    parser.add_argument("--start", required=True)
    parser.add_argument("--end", required=True)
    parser.add_argument("--summary-json", type=Path)
    parser.add_argument("--context-pack", type=Path)
    parser.add_argument("--endpoint", default=DEFAULT_ENDPOINT)
    parser.add_argument("--feishu-url", default="")
    parser.add_argument("--card-url", default="")
    parser.add_argument("--source-authority", choices=("explicit_user", "standing_rule", "ai_derived"), default="ai_derived")
    parser.add_argument("--standing-rule-id", default="")
    args = parser.parse_args()
    if args.source_authority == "standing_rule" and not args.standing_rule_id:
        print(json.dumps({"ok": False, "error": "standing_rule_id_required"}, ensure_ascii=False))
        return 2
    token = resolve_token()
    if not token:
        print(json.dumps({"ok": False, "error": "TASKBOX_API_TOKEN_missing"}, ensure_ascii=False))
        return 2
    payload = build_sync_payload(
        args.file, args.start, args.end, args.summary_json, args.context_pack,
        args.feishu_url, args.card_url,
    )
    key = payload["periodKey"]
    api = Api(args.endpoint, token)
    experiment = payload.get("experiment") or {}
    proposal = None
    if experiment.get("action") or experiment.get("hypothesis"):
        proposal = api.request("/hq/proposals", "POST", {
            "proposalType": "weekly_experiment_proposal",
            "sourceAuthority": args.source_authority,
            "standingRuleId": args.standing_rule_id or None,
            "title": experiment.get("action") or experiment.get("hypothesis"),
            "idempotencyKey": f"weekly-experiment:{key}",
            "shadowMode": True,
            "content": experiment,
            "evidence": {"bottleneck": payload.get("bottleneck", {})},
            "sourceRef": {"type": "weekly_review", "periodKey": key},
            "actor": "weekly_review",
        })
    payload["proposalRefs"] = [proposal["decisionId"]] if proposal else []
    review = api.request(f"/hq/periods/week/{key}", "POST", payload)
    print(json.dumps({
        "ok": True,
        "periodKey": key,
        "status": review.get("status"),
        "experiment": (review.get("experiment") or {}).get("action"),
        "scoreboardItems": len(review.get("scoreboard") or []),
        "proposalId": proposal.get("decisionId") if proposal else None,
        "proposalStatus": proposal.get("status") if proposal else None,
        "updatedAt": review.get("updatedAt"),
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, urllib.error.URLError) as exc:
        print(json.dumps({"ok": False, "error": type(exc).__name__, "message": str(exc)}, ensure_ascii=False))
        raise SystemExit(1)
