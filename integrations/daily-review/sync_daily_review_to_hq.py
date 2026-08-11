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
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from feedback_continuity import build_continuity, evidence_ref, stable_id


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


def proposal_payload(
    content: str,
    role: str,
    index: int,
    review_key: str,
    brief_key: str,
    source_authority: str,
    standing_rule_id: str,
    existing_task_id: str | None,
    shadow_mode: bool,
) -> dict:
    stable_role = role if role == "primary" else f"maintenance-{index}"
    return {
        "proposalType": "daily_action_proposal",
        "sourceAuthority": source_authority,
        "standingRuleId": standing_rule_id or None,
        "title": content,
        "idempotencyKey": f"daily-review:{review_key}:{brief_key}:{stable_role}",
        "existingTaskId": existing_task_id or None,
        "shadowMode": shadow_mode,
        "content": {"role": role, "plannedFromReviewDate": review_key},
        "evidence": {"markdownDate": review_key},
        "sourceRef": {"type": "daily_review", "reviewDate": review_key, "briefDate": brief_key},
        "taskSpec": {
            "content": content,
            "role": role,
            "pinLevel": 1 if role == "primary" else index + 1,
            "commitmentDate": brief_key,
            "scheduledAt": f"{brief_key}T00:00:00+08:00",
            "visibleAfter": f"{brief_key}T00:00:00+08:00",
            "priority": 1 if role == "primary" else 2,
            "deviceContext": "universal",
            "executionMode": "self",
            "note": f"来源：{review_key}日省；审批状态由HQ管理",
        },
        "actor": "daily_review",
    }


def write_local_outbox(path: Path, payload: dict, error: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    record = {
        "schemaVersion": 1,
        "status": "pending",
        "controlPlanePending": True,
        "payload": payload,
        "lastError": error,
        "updatedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
    }
    if path.exists():
        try:
            previous = json.loads(path.read_text(encoding="utf-8"))
            record["attempts"] = int(previous.get("attempts", 0)) + 1
        except (OSError, ValueError, TypeError):
            record["attempts"] = 1
    else:
        record["attempts"] = 1
    path.write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--file", required=True, type=Path)
    parser.add_argument("--date", required=True, help="日省归属日期，YYYY-MM-DD")
    parser.add_argument("--brief-date", help="行动驾驶舱日期，默认日省日期 + 1 天")
    parser.add_argument("--endpoint", default=os.environ.get("TASKBOX_API_ENDPOINT", DEFAULT_ENDPOINT))
    parser.add_argument("--feishu-url", default="")
    parser.add_argument("--card-url", default="")
    parser.add_argument("--source-authority", choices=("explicit_user", "standing_rule", "ai_derived"), default="ai_derived")
    parser.add_argument("--standing-rule-id", default="")
    parser.add_argument("--existing-primary-task-id", default="")
    parser.add_argument("--existing-maintenance-task-id", action="append", default=[])
    parser.add_argument("--enable-promotion", action="store_true", help="仅对已批准来源请求TaskBox晋升；服务器仍需启用生产开关")
    parser.add_argument("--proposal-outbox", type=Path)
    args = parser.parse_args()
    if args.source_authority == "standing_rule" and not args.standing_rule_id:
        print(json.dumps({"ok": False, "error": "standing_rule_id_required"}, ensure_ascii=False))
        return 2
    review_date = dt.date.fromisoformat(args.date)
    brief_date = dt.date.fromisoformat(args.brief_date) if args.brief_date else review_date + dt.timedelta(days=1)
    review_key = review_date.isoformat()
    brief_key = brief_date.isoformat()
    markdown = args.file.read_text(encoding="utf-8")
    action_block = section(markdown, "明日唯一动作")
    primary_content = bullet_value(action_block, "动作")
    maintenance = list_lines(section(markdown, "维护动作（最多 2 项）"))[:2]
    proposal_inputs = []
    if primary_content:
        proposal_inputs.append(proposal_payload(
            primary_content, "primary", 0, review_key, brief_key,
            args.source_authority, args.standing_rule_id,
            args.existing_primary_task_id or None, not args.enable_promotion,
        ))
    for index, content in enumerate(maintenance, start=1):
        existing_id = args.existing_maintenance_task_id[index - 1] if index <= len(args.existing_maintenance_task_id) else None
        proposal_inputs.append(proposal_payload(
            content, "maintenance", index, review_key, brief_key,
            args.source_authority, args.standing_rule_id, existing_id,
            not args.enable_promotion,
        ))

    closure_block = section(markdown, "昨日唯一承诺闭环")
    closure = {
        "commitment": bullet_value(closure_block, "承诺"),
        "result": bullet_value(closure_block, "结果"),
        "evidence": bullet_value(closure_block, "完成证据"),
        "reason": bullet_value(closure_block, "未完成的直接原因"),
        "decision": bullet_value(closure_block, "处理决定"),
    }
    task_ref = evidence_ref("taskbox_task", args.existing_primary_task_id, "昨日唯一承诺")
    continuity_source = {"feedbackContinuity": {"deviations": []}}
    if closure.get("reason") or closure.get("decision") in {"升级处理", "待用户决定"}:
        continuity_source["feedbackContinuity"]["deviations"].append({
            "deviationId": stable_id("deviation", f"daily:{review_key}:primary"),
            "subjectRef": args.existing_primary_task_id or closure.get("commitment") or "昨日唯一承诺",
            "expectedResult": closure.get("commitment", ""),
            "actualResult": closure.get("result", ""),
            "type": "execution" if closure.get("reason") else "unknown",
            "severity": "high" if closure.get("decision") == "升级处理" else "medium" if closure.get("reason") else "low",
            "facts": [value for value in (closure.get("result"), closure.get("reason")) if value],
            "interpretation": closure.get("decision", ""),
            "observedAt": f"{review_key}T23:59:00+08:00",
        })
    feedback_continuity = build_continuity(
        "day", review_key, args.file, continuity_source,
        [item for item in (task_ref, evidence_ref("review_evidence", closure.get("evidence"), "日省完成证据")) if item],
    )
    sync_payload = {
        "reviewDate": review_key,
        "briefDate": brief_key,
        "sourceAuthority": args.source_authority,
        "standingRuleId": args.standing_rule_id or None,
        "proposals": proposal_inputs,
        "feedbackContinuity": feedback_continuity,
        "reviewBrief": {
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
        "tomorrowBrief": {
            "reviewDate": brief_key,
            "stopDoing": list_lines(section(markdown, "明日停止做")),
            "continueDoing": list_lines(section(markdown, "明日继续做")),
            "source": "daily_review",
            "plannedFromReviewDate": review_key,
        },
    }
    outbox = args.proposal_outbox or args.file.resolve().parents[1] / "99_系统" / "实时日省" / "proposal-outbox" / f"{review_key}.json"
    token = resolve_token()
    if not token:
        path = write_local_outbox(outbox, sync_payload, "TASKBOX_API_TOKEN_missing")
        print(json.dumps({"ok": True, "controlPlanePending": True, "outbox": str(path)}, ensure_ascii=False))
        return 0

    api = Api(args.endpoint, token)
    try:
        proposals = [api.request("/hq/proposals", "POST", payload) for payload in proposal_inputs]
        promoted = []
        if args.enable_promotion and args.source_authority != "ai_derived":
            for proposal in proposals:
                promoted.append(api.request(
                    f"/hq/proposals/{urllib.parse.quote(proposal['decisionId'])}/promote",
                    "POST",
                    {"actor": "daily_review", "shadowMode": False},
                ))
        primary_task_id = next((item.get("taskId") for item in promoted if (item.get("taskSpec") or {}).get("role") == "primary"), None)
        maintenance_task_ids = [
            item.get("taskId") for item in promoted
            if (item.get("taskSpec") or {}).get("role") == "maintenance" and item.get("taskId")
        ]
        api.request(f"/hq/daily-briefs/{review_key}", "POST", sync_payload["reviewBrief"])
        tomorrow_payload = {
            **sync_payload["tomorrowBrief"],
            "actionProposalIds": [item["decisionId"] for item in proposals],
            "controlPlanePending": any(item.get("status") == "proposed" for item in proposals),
        }
        if primary_task_id:
            tomorrow_payload["primaryTaskId"] = primary_task_id
        if maintenance_task_ids:
            tomorrow_payload["maintenanceTaskIds"] = maintenance_task_ids
        tomorrow_brief = api.request(f"/hq/daily-briefs/{brief_key}", "POST", tomorrow_payload)
    except (OSError, ValueError, urllib.error.URLError) as exc:
        path = write_local_outbox(outbox, sync_payload, f"{type(exc).__name__}:{exc}")
        print(json.dumps({"ok": True, "controlPlanePending": True, "outbox": str(path)}, ensure_ascii=False))
        return 0

    if closure.get("decision") in {"升级处理", "待用户决定"}:
        decision_title = closure.get("commitment") or "连续未完成事项需要处理"
        decision_id = f"daily-{review_key}-{hashlib.sha1(decision_title.encode('utf-8')).hexdigest()[:12]}"
        try:
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
        except (OSError, ValueError, urllib.error.URLError):
            pass

    print(json.dumps({
        "ok": True,
        "reviewDate": review_key,
        "briefDate": brief_key,
        "sourceAuthority": args.source_authority,
        "proposalIds": [item["decisionId"] for item in proposals],
        "proposalStatuses": [item["status"] for item in proposals],
        "primaryTaskId": primary_task_id,
        "maintenanceTaskIds": maintenance_task_ids,
        "controlPlanePending": any(item.get("status") == "proposed" for item in proposals),
        "briefUpdatedAt": tomorrow_brief.get("updatedAt"),
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, urllib.error.URLError) as exc:
        print(json.dumps({"ok": False, "error": type(exc).__name__, "message": str(exc)}, ensure_ascii=False))
        raise SystemExit(1)
