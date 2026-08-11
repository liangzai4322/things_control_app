#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import re
import urllib.error
from pathlib import Path

import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from feedback_continuity import build_continuity

from review_bridge import (
    Api,
    DEFAULT_ENDPOINT,
    bullet_map,
    completed_at,
    first_section,
    list_lines,
    period_key,
    plain_summary,
    resolve_token,
    section,
    table_rows,
)


def clean_markdown(value: str) -> str:
    value = re.sub(r"[*_`]", "", value)
    return re.sub(r"\s+", " ", value).strip()


def subsection(markdown: str, heading: str) -> str:
    return section(markdown, heading, 3)


def parse_new_review(markdown: str) -> dict:
    bet_block = section(markdown, "5. 下月主要战略押注")
    bet = bullet_map(bet_block)
    guardrails = list_lines(subsection(bet_block, "经营护栏"))
    if not guardrails:
        guardrail_text = bet.get("经营护栏", "")
        guardrails = [item.strip() for item in re.split(r"[；;]", guardrail_text) if item.strip()]
    final_block = section(markdown, "6. 待核与不做清单")
    stop = list_lines(subsection(final_block, "明确停止"))
    not_doing = list_lines(subsection(final_block, "不做清单"))
    unresolved = list_lines(subsection(final_block, "待核"))
    if not stop:
        stop_value = bet.get("明确停止", "")
        stop = [stop_value] if stop_value else []
    strategic_bet = {
        "decision": bet.get("押注", "") or bet.get("主要押注", "") or bet.get("假设", ""),
        "hypothesis": bet.get("假设", ""),
        "target": bet.get("对象", ""),
        "incrementalLimit": bet.get("增量投入上限", ""),
        "maintenanceLimit": bet.get("维护上限", ""),
        "lossLimit": bet.get("损失上限", ""),
        "guardrails": guardrails[:2],
        "reviewDate": bet.get("复查日期", ""),
        "exitCondition": bet.get("退出条件", ""),
    }
    return {
        "format": "six-chapter-v1",
        "verdict": plain_summary(section(markdown, "1. 本月经营判决")),
        "previousBetReview": table_rows(section(markdown, "2. 上月押注验收")),
        "metrics": {"rows": table_rows(section(markdown, "3. 经营结果与数据完整性")),
                    "summary": plain_summary(section(markdown, "3. 经营结果与数据完整性"))},
        "portfolio": table_rows(section(markdown, "4. 业务组合")),
        "strategicBet": strategic_bet,
        "strategicDecisions": [strategic_bet] if strategic_bet["decision"] else [],
        "resources": [],
        "goals": [],
        "startStopContinue": {"start": [], "stop": stop[:1], "continue": []},
        "stopDoing": stop[:1],
        "guardrails": guardrails[:2],
        "notDoing": not_doing,
        "unresolvedQuestions": unresolved,
    }


def parse_legacy_decisions(markdown: str) -> list[dict]:
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
                "incrementalLimit": fields.get("时间 / 预算上限", ""),
                "reviewDate": fields.get("复查日期", ""),
                "exitCondition": fields.get("退出条件", ""),
            })
    if decisions:
        return decisions[:3]
    legacy = first_section(markdown, ["D｜决策与行动：下个月要怎么变", "D｜决策与行动"], 3)
    for match in re.finditer(r"^\s*\d+[.、]\s*(.+?)\s*$", legacy, re.MULTILINE):
        decision = clean_markdown(match.group(1))
        if decision:
            decisions.append({"decision": decision, "evidence": "历史月省", "exitCondition": ""})
    return decisions[:3]


def parse_legacy_review(markdown: str) -> dict:
    decisions = parse_legacy_decisions(markdown)
    goals = []
    for heading, goal_type in (("现金结果目标", "cash"), ("增长验证目标", "growth"), ("能力 / 系统目标", "system")):
        block = section(markdown, heading, 3)
        summary = plain_summary(block)
        if summary:
            goals.append({"type": goal_type, "title": bullet_map(block).get("目标", "") or summary.splitlines()[0], "detail": summary})
    if not goals:
        for goal_type, action in zip(("cash", "growth", "system"), list_lines(section(markdown, "六、下月最小行动清单"))[:3]):
            goals.append({"type": goal_type, "title": clean_markdown(action), "detail": clean_markdown(action)})
    start_items = list_lines(first_section(markdown, ["Start（最多 1 条）", "Start"], 3))
    stop_items = list_lines(first_section(markdown, ["Stop（最多 1 条）", "Stop"], 3))
    keep_items = list_lines(first_section(markdown, ["Keep（最多 1 条）", "Keep"], 3))
    return {
        "format": "legacy-monthly-markdown",
        "verdict": plain_summary(first_section(markdown, ["一、本月经营裁决", "一、本月一句话判断"])),
        "previousBetReview": table_rows(section(markdown, "二、上月承诺验收")),
        "metrics": {"summary": plain_summary(
            section(markdown, "三、本月经营仪表盘")
            or section(markdown, "O｜客观事实：这个月发生了什么", 3)
        )},
        "portfolio": table_rows(section(markdown, "四、业务组合与 ROI")),
        "strategicBet": decisions[0] if decisions else {},
        "strategicDecisions": decisions,
        "legacyGoals": goals,
        "goals": goals,
        "resources": table_rows(section(markdown, "八、下月资源分配")),
        "startStopContinue": {"start": start_items, "stop": stop_items, "continue": keep_items},
        "stopDoing": stop_items,
        "guardrails": [],
        "notDoing": list_lines(section(markdown, "十二、下月不做清单")),
        "unresolvedQuestions": list_lines(section(markdown, "十三、待核")) or list_lines(section(markdown, "七、待核")),
    }


def parse_monthly_review(markdown: str) -> dict:
    return parse_new_review(markdown) if section(markdown, "5. 下月主要战略押注") else parse_legacy_review(markdown)


def payload_from_summary(summary: dict) -> dict:
    if summary.get("hqPayload"):
        return dict(summary["hqPayload"])
    return {
        "verdict": summary.get("verdict", ""),
        "previousBetReview": summary.get("previousBetReview", []),
        "metrics": summary.get("metrics", {}),
        "portfolio": summary.get("portfolio", []),
        "strategicBet": summary.get("strategicBet", {}),
        "strategicDecisions": [summary.get("strategicBet", {})] if summary.get("strategicBet") else [],
        "stopDoing": summary.get("stopDoing", []),
        "guardrails": summary.get("guardrails", []),
        "notDoing": summary.get("notDoing", []),
        "unresolvedQuestions": summary.get("unresolvedQuestions", []),
        "inputCoverage": summary.get("inputCoverage", {}),
        "evidenceStatus": summary.get("evidenceStatus", "provisional"),
        "feedbackContinuity": summary.get("feedbackContinuity", {}),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="同步月省结构化裁决到人生参谋部")
    parser.add_argument("--file", required=True, type=Path)
    parser.add_argument("--start", required=True)
    parser.add_argument("--end", required=True)
    parser.add_argument("--summary-json", type=Path)
    parser.add_argument("--endpoint", default=DEFAULT_ENDPOINT)
    parser.add_argument("--feishu-url", default="")
    parser.add_argument("--card-url", default="")
    parser.add_argument("--source-authority", choices=("explicit_user", "standing_rule", "ai_derived"), default="ai_derived")
    parser.add_argument("--standing-rule-id", default="")
    parser.add_argument("--dry-run", action="store_true", help="只输出提案与周期载荷，不读取Token、不发网络请求")
    args = parser.parse_args()
    if args.source_authority == "standing_rule" and not args.standing_rule_id:
        print(json.dumps({"ok": False, "error": "standing_rule_id_required"}, ensure_ascii=False))
        return 2
    key = period_key("month", args.start, args.end)
    if args.summary_json:
        summary = json.loads(args.summary_json.read_text(encoding="utf-8-sig"))
        if summary.get("periodKey") != key:
            raise ValueError(f"summary_period_mismatch:{summary.get('periodKey')}:{key}")
        parsed = payload_from_summary(summary)
    else:
        parsed = parse_monthly_review(args.file.read_text(encoding="utf-8-sig"))
    strategic_bet = parsed.get("strategicBet") or {}
    proposal_input = None
    if strategic_bet.get("decision"):
        proposal_input = {
            "proposalType": "monthly_bet_proposal",
            "sourceAuthority": args.source_authority,
            "standingRuleId": args.standing_rule_id or None,
            "title": strategic_bet.get("decision"),
            "idempotencyKey": f"monthly-bet:{key}",
            "shadowMode": True,
            "content": strategic_bet,
            "evidence": {
                "evidenceStatus": parsed.get("evidenceStatus", "provisional"),
                "inputCoverage": parsed.get("inputCoverage", {}),
            },
            "sourceRef": {"type": "monthly_review", "periodKey": key},
            "actor": "monthly_review",
        }
    proposal = None
    if proposal_input and args.dry_run:
        proposal = {
            **proposal_input,
            "decisionId": f"proposal-{hashlib.sha256(proposal_input['idempotencyKey'].encode('utf-8')).hexdigest()[:24]}",
            "status": "proposed" if args.source_authority == "ai_derived" else "approved",
            "revision": 1,
        }
    payload = {
        **parsed,
        "feedbackContinuity": build_continuity("month", key, args.file, parsed),
        "periodType": "month",
        "periodKey": key,
        "startDate": args.start,
        "endDate": args.end,
        "status": "synced",
        "source": "monthly_review",
        "completedAt": completed_at(),
        "proposalRefs": [proposal["decisionId"]] if proposal else [],
        "artifacts": {
            "markdownPath": str(args.file.resolve()),
            "feishuUrl": args.feishu_url.strip(),
            "cardUrl": args.card_url.strip(),
        },
    }
    if args.dry_run:
        print(json.dumps({"ok": True, "dryRun": True, "proposal": proposal, "periodPayload": payload}, ensure_ascii=False))
        return 0
    token = resolve_token()
    if not token:
        print(json.dumps({"ok": False, "error": "TASKBOX_API_TOKEN_missing"}, ensure_ascii=False))
        return 2
    api = Api(args.endpoint, token)
    if proposal_input:
        proposal = api.request("/hq/proposals", "POST", proposal_input)
        payload["proposalRefs"] = [proposal["decisionId"]]
    review = api.request(f"/hq/periods/month/{key}", "POST", payload)
    print(json.dumps({
        "ok": True,
        "periodKey": key,
        "status": review.get("status"),
        "strategicBets": 1 if review.get("strategicBet") else 0,
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
