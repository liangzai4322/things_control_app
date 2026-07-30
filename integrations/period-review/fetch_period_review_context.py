#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
import urllib.error
from pathlib import Path

from review_bridge import Api, DEFAULT_ENDPOINT, period_key, resolve_token


DEFAULT_OUTPUT_ROOT = Path(r"D:\note_new\06-日常输入_输出\99_系统\缓存\人生参谋部")


def render_metric(label: str, metric: dict) -> str:
    if not metric or not metric.get("recordedDays"):
        return f"- {label}：未记录"
    return f"- {label}：{metric.get('value', 0)}（有记录 {metric.get('recordedDays', 0)} 天）"


def render_context(snapshot: dict, recent: list[dict]) -> str:
    period_type = snapshot["periodType"]
    label = "周省" if period_type == "week" else "月省"
    derived = snapshot.get("derived") or {}
    review = snapshot.get("review") or {}
    outcomes = derived.get("outcomes") or {}
    commitments = derived.get("commitments") or {}
    lines = [
        f"# 人生参谋部{label}事实包 {snapshot['startDate']} 至 {snapshot['endDate']}",
        "",
        "> 本文件只提供服务器事实和上个周期承诺。复盘结论仍需回到日省、周省与明确证据，不根据空值补写结果。",
        "",
        "## 当前周期状态",
        f"- 周期键：{snapshot['periodKey']}",
        f"- 已同步{label}：{'是' if review.get('completedAt') else '否'}",
        f"- 日省记录：{derived.get('dailyReviewCount', 0)}",
        f"- 触达任务：{(derived.get('tasks') or {}).get('touched', 0)}",
        f"- 完成任务：{(derived.get('tasks') or {}).get('completed', 0)}",
        f"- 主动作完成率：{commitments.get('rate') if commitments.get('rate') is not None else '证据不足'}",
        "",
        "## 外部结果",
        render_metric("发布数", outcomes.get("published") or {}),
        render_metric("有效客户 / 合作对话数", outcomes.get("conversations") or {}),
        render_metric("报价数", outcomes.get("quotes") or {}),
        render_metric("成交数", outcomes.get("deals") or {}),
        render_metric("新增真实反馈样本数", outcomes.get("feedback") or {}),
        "",
        "## 项目预警",
    ]
    risks = derived.get("projectRisks") or []
    lines.extend(
        f"- {item.get('name') or '未命名项目'}｜{item.get('health')}｜下一步：{(item.get('nextAction') or {}).get('content') or '缺少下一步'}"
        for item in risks
    )
    if not risks:
        lines.append("- 当前没有项目预警")
    lines.extend(["", "## 待决策"])
    decisions = snapshot.get("decisions") or []
    lines.extend(f"- {item.get('title')}｜{item.get('context') or '未记录背景'}" for item in decisions)
    if not decisions:
        lines.append("- 当前没有待决策事项")
    lines.extend(["", f"## 最近已同步{label}"])
    for item in recent[:3]:
        lines.append(f"- {item.get('periodKey')}｜{item.get('verdict') or '未填写经营裁决'}｜{item.get('status')}")
    if not recent:
        lines.append(f"- 暂无历史{label}")
    lines.append("")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--type", choices=["week", "month"], required=True)
    parser.add_argument("--start", required=True)
    parser.add_argument("--end", required=True)
    parser.add_argument("--endpoint", default=DEFAULT_ENDPOINT)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--json-output", type=Path)
    args = parser.parse_args()
    token = resolve_token()
    if not token:
        print(json.dumps({"ok": False, "error": "TASKBOX_API_TOKEN_missing"}, ensure_ascii=False))
        return 2
    key = period_key(args.type, args.start, args.end)
    api = Api(args.endpoint, token)
    snapshot = api.request(f"/hq/periods/{args.type}/{key}")
    recent = api.request(f"/hq/periods?type={args.type}&limit=3")
    folder = "周省" if args.type == "week" else "月省"
    output = args.output or DEFAULT_OUTPUT_ROOT / folder / f"{key}-事实包.md"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(render_context(snapshot, recent), encoding="utf-8")
    if args.json_output:
        args.json_output.parent.mkdir(parents=True, exist_ok=True)
        args.json_output.write_text(json.dumps(snapshot, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({
        "ok": True, "periodType": args.type, "periodKey": key,
        "output": str(output.resolve()),
        "dailyReviews": (snapshot.get("derived") or {}).get("dailyReviewCount", 0),
        "projectRisks": len((snapshot.get("derived") or {}).get("projectRisks") or []),
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, urllib.error.URLError) as exc:
        print(json.dumps({"ok": False, "error": type(exc).__name__, "message": str(exc)}, ensure_ascii=False))
        raise SystemExit(1)
