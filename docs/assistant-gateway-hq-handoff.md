# Assistant Gateway × HQ 交接（2026-09-04）

## 已验证事实

- 生产已验证基线为 `697e1cb`：Gateway read/write token 分离，read scope 为 `proposal-decisions:read`，reply source 仅允许 `notification_hub_weixin`。
- Gateway 已由盒子 APP 切换到 `decision`，切换时 TaskBox `625→625`、execution audit `0→0`；模式回滚点为 `/opt/taskbox-api/backups/assistant-gateway-mode-20260904T144924Z`。
- 已审批 `daily_action_proposal` 的唯一任务写路径裁决为 `POST /v1/hq/proposals/:id/promote`。服务端以 `syncKey=hq-proposal:<proposalId>` 幂等写 TaskBox并记录 HQ promote event。`/v1/execution/task-operations` 不创建此类任务。
- 本地提交 `3f1155d` 实现 HQ 三分流草案与合成合同测试；`node server/taskbox-api/scripts/test-hq-proposal-replies.js` 通过。提交已推送 `deploy/main`。

## 三分流合同（目标状态）

1. `auto_eligible`：仅明确、低风险、唯一真实 task box、动作/理由完整、无重复并精确命中可撤销 standing rule 的 `daily_action_proposal`。允许 `approve`；写操作必须依次执行 HQ approve 和正式幂等 promote。
2. `confirmation_required`：信息不足、疑似重复、目标不唯一、周/月/战略或 provisional。必须保留并可展示；`allowedReplies` 不含 `approve`，仅支持 expand（详情/补充）、defer、reject，补充后重新评估。
3. `auto_reject`：确认重复、已完成、仅原则或无具体行动。保留 machine-readable reason 和可查询记录，不写 TaskBox。

任何类别都不得静默消失。GET 只分类，不改变 proposal 状态。

## 已完成但尚未作为最终版本验收

- `3f1155d` 的 `server.js` 已改为三分流并返回 `disposition/reasonCodes/allowedReplies`。
- 合同测试覆盖 eligible daily、provisional monthly（可见但无 approve）、字段缺失、确认重复、字段脱敏和 replyBinding。
- 当前草案要求显式 `automationAuthorization`：`source=standing_rule`、`ruleId`匹配、`exact/enabled/revocable=true`；要求唯一 `box_type=task`、`taskSpec.content===clearAction`、无 `existingTaskId`、任务字段在 allowlist 内。

## 当前状态与部署

- Gateway writer 已合并提交 `c41dfd3`；automation queue 与 canonical read scope 修复提交为 `6420b4c`、`b0fa06a`，部署探针兼容修复为 `432f539`。
- 生产 workflow `33895481145` 已成功，head SHA 为 `432f539ce8289c44409812ce0d9096f1c10146ea`。部署脚本完成 schema/HQ/reply/执行测试、Gateway worker 测试与认证探针；未创建业务测试数据。
- 生产 decision mode 仍由 systemd drop-in 维护，TaskBox 写路径不变。回滚点仍以服务器部署脚本输出为准。

## 未完成与关键阻塞

- 后续若继续优化，需补一条独立的生产 authenticated 读取探针，确认真实 read token 返回三分流投影；本轮部署脚本已完成空数据与权限探针。
- 需要正式登记窄规则 `execution.daily_action_proposal.auto_approve`，包含 ruleId、version、scope、allowlist、enabled、revocable、授权来源和撤销时间；旧规则不能替代。
- 自动 approve/promote 已有合成 Worker 测试和生产开关，但真实业务 proposal 仍未处理；不得把空队列探针当成真实业务闭环证明。

## 下一位 Agent 直接执行

```bash
cd /tmp/time-control-decision-mode
git status --short --branch
git log -3 --oneline
# 等盒子 APP 任务 019d8138-ece0-70b0-8c9d-90b4003aa46f 回传 writer 提交后：
git cherry-pick <BOX_APP_WRITER_COMMIT>
node server/taskbox-api/scripts/test-hq-proposal-replies.js
npm --prefix server/taskbox-api run test:hq
git diff --check
```

随后以合成数据验证三分流、Token 交叉隔离、revision/session/idempotency、重启恢复 `promotion_pending`、provisional monthly 不可 approve/promote、TaskBox 零副作用；全部通过后才部署并回传 workflow SHA 与生产探针。
