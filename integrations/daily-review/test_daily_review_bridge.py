#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent


def load(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, ROOT / filename)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


fetch = load("fetch_daily_review_context", "fetch_daily_review_context.py")
sync = load("sync_daily_review_to_hq", "sync_daily_review_to_hq.py")


class DailyReviewBridgeTests(unittest.TestCase):
    def test_evidence_pack_markdown(self):
        pack = fetch.build_evidence_pack(
            "2026-07-30",
            {
                "tasks": [{"id": "done", "content": "发布 MVP", "isCompleted": True}],
                "completedTasks": [{"id": "done", "content": "发布 MVP", "isCompleted": True}],
                "progressTasks": [],
            },
            {
                "commitments": {"primary": {"content": "发布 MVP"}, "maintenance": []},
                "projects": [{"name": "人生参谋部", "health": "stale", "nextAction": {"content": "拉取事实"}}],
                "decisions": [{"title": "确定下一阶段", "context": "已有 MVP"}],
                "ai": {},
            },
            {"knownCount": 3, "completedCount": 2, "completionRate": 67},
        )
        markdown = fetch.render_markdown(pack)
        self.assertIn("发布 MVP", markdown)
        self.assertIn("人生参谋部｜停滞", markdown)
        self.assertIn("完成率：67", markdown)

    def test_daily_review_markdown_parsing(self):
        markdown = """
### 明日唯一动作

- 动作：发布人生参谋部第二版

### 维护动作（最多 2 项）

- [ ] 回复客户
- [ ] 运动

### 明日停止做

- 无目的切换窗口
""".strip()
        self.assertEqual(sync.bullet_value(sync.section(markdown, "明日唯一动作"), "动作"), "发布人生参谋部第二版")
        self.assertEqual(sync.list_lines(sync.section(markdown, "维护动作（最多 2 项）")), ["回复客户", "运动"])
        self.assertEqual(sync.list_lines(sync.section(markdown, "明日停止做")), ["无目的切换窗口"])


if __name__ == "__main__":
    unittest.main()
