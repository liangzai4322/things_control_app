# 日省 × 人生参谋部

双向桥接包含两个标准库脚本：

- `fetch_daily_review_context.py`：日省开始前读取盒子/HQ，生成 Markdown 事实包。
- `sync_daily_review_to_hq.py`：日省结束后写回闭环与外部结果，并为次日主动作/维护动作创建`daily_action_proposal`。AI 推导默认只进入待审批；明确授权来源获批后也只能通过 proposal promotion 幂等创建或关联 TaskBox。
- 同步载荷同时生成稳定 `feedbackContinuity`：昨日承诺偏差使用可复算 ID，并只引用 TaskBox/复盘证据 ID；它进入反馈候选层，不会自动激活规则、实验或任务。

认证优先读取`TASKBOX_API_TOKEN`，否则读取`TASKBOX_API_TOKEN_FILE`或用户目录下的`.codex/secrets/taskbox-api-token`。凭据文件不进入仓库。

```powershell
python fetch_daily_review_context.py --date YYYY-MM-DD
python sync_daily_review_to_hq.py --file "PATH\YYYY-MM-DD.md" --date YYYY-MM-DD
```

生产 promotion 需要脚本显式`--enable-promotion`、非`ai_derived`来源以及服务器`HQ_PROPOSAL_PROMOTION_ENABLED=1`。HQ 不可用时提案写入本地 proposal outbox，不回滚正式日省。

运行`python test_daily_review_bridge.py`执行无网络单元测试。
