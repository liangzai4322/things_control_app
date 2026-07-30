#!/usr/bin/env python3
from __future__ import annotations

import unittest

import sync_monthly_review_to_hq as monthly
import sync_weekly_review_to_hq as weekly
from fetch_period_review_context import render_context


class PeriodReviewBridgeTests(unittest.TestCase):
    def test_weekly_parser(self):
        markdown = """
# 周省 · 2026-07-27 至 2026-08-02
## 一、本周经营裁决
集中完成周期面板，不新增方向。
## 二、上周承诺验收
| 上周承诺 | 结果 | 证据 | 本周处理 |
|---|---|---|---|
| 发布 MVP | 完成 | 线上链接 | 进入验证 |
## 三、本周外部结果仪表盘
| 指标 | 本周结果 | 数据完整性 | 证据 |
|---|---:|---|---|
| 发布数 | 1 | 完整 | 页面 |
## 四、唯一主瓶颈与 5Why
### 主瓶颈：周期目标未进入每日执行
- 根因：系统未打通
- 系统修正：增加同步
- 验证证据：面板可见
## 六、下周唯一实验
- 假设：周期视图能减少方向切换
- 实验动作：连续使用周面板 7 天
- 样本数量：7 天
- 成功阈值：5 天完成主动作
- 失败阈值：少于 3 天
- 截止日期：2026-08-09
- 到期后的决策：保留或删除
## 七、下周资源分配
| 业务线 / 任务类型 | 时间比例 | 日历时间块 | 预期证据 |
|---|---:|---|---|
| 人生参谋部 | 60% | 上午 | 页面 |
## 八、Start / Stop / Continue
### Start（最多 1 条）
- 每天查看周实验
### Stop（最多 1 条）
- 临时换方向
### Continue（最多 1 条）
- 先做 MVP
## 十一、下周记分牌
- [ ] 完成 5 次主动作
""".strip()
        result = weekly.parse_weekly_review(markdown)
        self.assertIn("集中完成周期面板", result["verdict"])
        self.assertEqual(result["bottleneck"]["title"], "周期目标未进入每日执行")
        self.assertEqual(result["experiment"]["action"], "连续使用周面板 7 天")
        self.assertEqual(result["startStopContinue"]["stop"], ["临时换方向"])
        self.assertEqual(len(result["scoreboard"]), 1)

    def test_weekly_parser_accepts_bold_field_labels(self):
        markdown = """
## 一、本周经营裁决
本周只验证**一个外部结果**。
## 六、下周唯一实验
### 服务标准化实验
- **假设：** 标准化后可以复用
- **实验动作：** 完成一版 SOP
- **截止日期：** 2026-08-05
## 八、Start / Stop / Continue
### Start（最多 1 条）
开始执行 24 小时资产化。
""".strip()
        result = weekly.parse_weekly_review(markdown)
        self.assertEqual(result["verdict"], "本周只验证一个外部结果。")
        self.assertEqual(result["experiment"]["hypothesis"], "标准化后可以复用")
        self.assertEqual(result["experiment"]["action"], "完成一版 SOP")
        self.assertEqual(result["startStopContinue"]["start"], ["开始执行 24 小时资产化。"])

    def test_monthly_parser(self):
        markdown = """
# 月省 · 2026-07-01 至 2026-07-31
## 一、本月经营裁决
削减低反馈项目，集中成果物。
## 二、上月承诺验收
| 上月承诺 / 决策 | 结果 | 证据 | 本月处理 |
|---|---|---|---|
| 发布工具 | 完成 | URL | 加码 |
## 三、本月经营仪表盘
### 现金结果
未记录
## 四、业务组合与 ROI
| 业务线 | 分类 | 时间投入 | 现金结果 | 外部样本 | 沉淀资产 | 置信度 | 决策 |
|---|---|---:|---:|---:|---|---|---|
| 人生参谋部 | 增长业务 | 30% | 未记录 | 3 | 面板 | 高 | 加码 |
## 七、本月战略决策（最多 3 条）
### 决策 1
- 决定：加码人生参谋部
- 证据：已经上线
- 可逆性：高
- 时间 / 预算上限：30%
- 复查日期：2026-08-31
- 退出条件：连续两周无使用
## 八、下月资源分配
| 业务线 | 时间比例 | 预算比例 | 月度上限 | 退出条件 |
|---|---:|---:|---|---|
| 人生参谋部 | 30% | 10% | 40小时 | 无使用 |
## 九、Stop / Keep / Start
### Stop（最多 1 条）
- 无证据扩方向
### Keep（最多 1 条）
- MVP 先行
### Start（最多 1 条）
- 周度实验
## 十、下月三层目标
### 现金结果目标
- 目标：获得一个付费样本
### 增长验证目标
- 目标：获得十个反馈
### 能力 / 系统目标
- 目标：完成周期面板
## 十二、下月不做清单
- 不新增第四个系统
""".strip()
        result = monthly.parse_monthly_review(markdown)
        self.assertIn("削减低反馈项目", result["verdict"])
        self.assertEqual(result["portfolio"][0]["决策"], "加码")
        self.assertEqual(result["strategicDecisions"][0]["decision"], "加码人生参谋部")
        self.assertEqual(len(result["goals"]), 3)
        self.assertEqual(result["notDoing"], ["不新增第四个系统"])

    def test_monthly_parser_accepts_legacy_review_shape(self):
        markdown = """
# 月省 · 2026-06-02 至 2026-07-01
## 一、本月一句话判断
先完成杠杆化，再启动新方向。
## 二、ORID 月度复盘
### O｜客观事实：这个月发生了什么
站点已经上线，但反馈传感器仍缺失。
### D｜决策与行动：下个月要怎么变
1. **现金流业务：** 完成代理 SOP。
2. **增长业务：** 给站点安装反馈传感器。
3. **内容系统：** 每周发布一篇实操复盘。
## 四、Stop / Keep / Start
### Stop
- 停止模糊任务
### Keep
- 保留复盘节律
### Start
- 开始固定发布
## 六、下月最小行动清单
- [ ] 完成代理 SOP v0.2
- [ ] SEO 站接入反馈传感器
- [ ] 每周发布 1 篇实操文章
""".strip()
        result = monthly.parse_monthly_review(markdown)
        self.assertIn("先完成杠杆化", result["verdict"])
        self.assertEqual(len(result["strategicDecisions"]), 3)
        self.assertEqual(result["goals"][0]["title"], "完成代理 SOP v0.2")
        self.assertEqual(result["startStopContinue"]["stop"], ["停止模糊任务"])

    def test_context_renderer(self):
        snapshot = {
            "periodType": "week",
            "periodKey": "2026-07-27_to_2026-08-02",
            "startDate": "2026-07-27",
            "endDate": "2026-08-02",
            "review": {},
            "derived": {
                "dailyReviewCount": 4,
                "tasks": {"touched": 12, "completed": 5},
                "commitments": {"rate": 75},
                "outcomes": {},
                "projectRisks": [{"name": "项目 A", "health": "stale", "nextAction": None}],
            },
            "decisions": [],
        }
        text = render_context(snapshot, [])
        self.assertIn("日省记录：4", text)
        self.assertIn("项目 A", text)


if __name__ == "__main__":
    unittest.main()
