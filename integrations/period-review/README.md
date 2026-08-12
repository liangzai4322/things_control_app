# 周省 / 月省 × 人生参谋部

- `fetch_period_review_context.py`：复盘开始前生成周/月事实包。
- `sync_weekly_review_to_hq.py`：同步周度裁决、瓶颈、实验、资源与记分牌。
- `sync_monthly_review_to_hq.py`：同步月度业务组合、战略决策、资源、目标与不做清单。
- `review_bridge.py`：认证、API、Markdown 区块和表格解析公共模块。
- `feedback_continuity.py`：为日/周/月偏差、实验和规则生成稳定共享 ID 与结构化证据引用；任何导入的 active 规则或实验都会降级为 `proposed`。

凭据读取规则与日省一致：环境变量优先，私有 Token 文件回退，凭据不进入仓库和复盘产物。
