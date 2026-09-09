# 周省 / 月省 × 人生参谋部

- `fetch_period_review_context.py`：复盘开始前生成周/月事实包。
- `sync_weekly_review_to_hq.py`：同步五章周省，并创建`weekly_experiment_proposal`；批准后仍是战略实验，不直接建任务。
- `sync_monthly_review_to_hq.py`：同步六章月省，并创建`monthly_bet_proposal`；支持`--dry-run`做无Token、无网络历史回放。
- `review_bridge.py`：认证、API、Markdown 区块和表格解析公共模块。
- `feedback_continuity.py`：为日/周/月偏差、实验和规则生成稳定共享 ID 与结构化证据引用；任何导入的 active 规则或实验都会降级为 `proposed`。

凭据读取规则与日省一致：环境变量优先，私有 Token 文件回退，凭据不进入仓库和复盘产物。
