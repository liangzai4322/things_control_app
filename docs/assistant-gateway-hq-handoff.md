# Assistant Gateway × HQ 交接（2026-09-05）

## 当前生产事故与恢复工作（优先于下方历史状态）

- 已验证：workflow `33946890510` 将旧分支 `3ae02e0` 发布到生产；该分支不含 `8254958` 的 durable conversation 路由和 `5d4c4ae` 的 runner 修复。盒子 APP 已通过祖先与源码核对确认。Mac runner 报 `conversation_api_http_401`、反复 exit 1；Notification Hub owning system 报 Gateway `remote_http_401` 后重启。此为生产功能回退，不是单纯缺少审计凭据。
- Hub 2026-09-05 晚间只读回执：available=1、acked=4、dead_letter=4、sent replies=4。没有手工 claim/ack 或重放旧消息。故障 B 通知稳定键为 `assistant-runner-auth-regression:2026-09-05`，不得重复发送。
- 工作树 `/private/tmp/time-control-decision-mode`：分支 `codex/weixin-production-bridge`，原 HEAD `5d4c4ae`，已无冲突合入 `deploy/main=1656105`，恢复编辑尚待提交/部署。不得用旧工作树替代当前主线。
- 本地新增 `assistant-audit-summary.js`，复用既有 `EXECUTION_AUDIT_SUMMARY_TOKEN_FILE/SCOPES/DISABLE_FILE`，不生成或轮换凭据。`/v1/execution/audit-summary` 只返回 count/hash/sequence/status；用真实 `sequence_no`，不再创建同名不兼容表。`status_timestamps_json` 是真实状态更新的新增记录，历史 leased/result_ready 缺失必须保持 null。
- 审计快照新增 `task_state_hash/hq_state_hash`，覆盖 boxes/tasks 及 HQ 表；仅任务数和 ID hash 相同不足以证明无修改。窗口两端缺失、旧快照缺 hash 或距离边界超过 120 秒时，`insufficientEvidence=true`、业务结论为 null。哈希不证明没有发生过又被撤销的写入，仍需结合权限与正式审计。
- Runner 已本地加入持续 401/403 的 60 秒退避、状态变化日志和结果保留；修复 `RunnerError.code` 缺失导致错误上报再次异常。发布 probe 使用空 runnerId 验证 400，不领取真实任务。CI 在上传前要求 durable baseline 与 main 祖先及组合合同测试；这不等于 GitHub 已配置禁止旧 workflow 分支的环境保护。
- 已通过本地：25 项 worker/runner、HQ、execution、schema、system-intake、conversation、audit-summary、release 脚本测试。新增 audit 测试覆盖同任务 ID/数量但正文改变、历史缺失、窗口不足和私密字段不外泄。生产尚未验证此恢复版本。
- 网页桥接 Doctor/consent READY；预检见已登录页面，模型未查看/切换。`weixin-recovery-20260905-v2` 已发送一次，等待期间浏览器连接超时；未复制/取得结果，不得称网页评审通过或重发同包。Packet 位于治理项目 `.bridge/packet-weixin-recovery-20260905-v2.md`。
- Goal 保持 active：仍需恢复生产、Mac runner 更新后验证两轮真实上下文、失败恢复与无重复发送；严格 HQ/TaskBox 零副作用证据仍未满足。2026-09-05 12:49–12:51 的历史成功不证明当前运行健康，没有前快照不能补造。

文档同步范围：本轮优先修正助手 README/AGENTS/本交接与治理事故入口；未完成全部历史 docs 的完整 neat-freak 同步，未改动其余领域事实。

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

### 普通微信自然语言会话

- 2026-09-05 durable 链路曾完成两条真实消息，Mac runner 已安装；随后被旧分支发布覆盖。当前故障与恢复以本文顶部为准，不能再称“从未部署”。

- 2026-09-05 已确认：`decision` worker 只处理测试 echo 与显式审批 grammar；普通文本在 `parse_decision` 返回空后以 `decision_not_explicit` retry，因此“你好”没有回复。它没有 generic conversation handler。
- 普通聊天不得复用 proposal 的 `sessionRef`，也不得在服务器硬编码 Mac Codex task ID。服务器当前没有到 Mac app-server 的已验证安全调用入口。
- 最小安全架构是两段式：服务器 Gateway 仅验证、分流并写 durable conversation outbox；Mac 上独立最小权限 runner 按 `verifiedUserRef + conversationRefHash` 串行 claim，调用专用 Codex 会话取得真实结果，再回传 reply 并 ack。
- 必须先实现并测试 authenticated claim/reply/ack、稳定幂等键、每会话单飞、超时/重试/dead-letter、停用开关与正文脱敏日志。审批 grammar 继续走现有 HQ 路径；普通聊天永远不进入 approve/promote。
- 在该跨机通道落地前，不得用固定字符串冒充自然语言结果，也不得宣称微信通用助理已可用。

- 后续若继续优化，需补一条独立的生产 authenticated 读取探针，确认真实 read token 返回三分流投影；本轮部署脚本已完成空数据与权限探针。
- 需要正式登记窄规则 `execution.daily_action_proposal.auto_approve`，包含 ruleId、version、scope、allowlist、enabled、revocable、授权来源和撤销时间；旧规则不能替代。
- 自动 approve/promote 已有合成 Worker 测试和生产开关，但真实业务 proposal 仍未处理；不得把空队列探针当成真实业务闭环证明。

## 下一位 Agent 直接执行

```bash
cd /tmp/time-control-decision-mode
git status --short --branch
git log -3 --oneline
git diff --check
git diff --stat
git merge-base --is-ancestor deploy/main HEAD
# 如果 merge 尚未提交，先复核工作树和 MERGE_HEAD；不得重复合并/丢弃改动。
python3 -m unittest discover -s integrations/assistant-gateway/tests -v
npm --prefix server/taskbox-api run test:assistant-conversation
npm --prefix server/taskbox-api run test:audit-summary
node server/taskbox-api/scripts/test-hq-proposal-replies.js
npm --prefix server/taskbox-api run test:hq
git diff --check
```

恢复前先通过既有盒子 APP/Notification Hub 任务核对生产边界，再审查组合变更和 release 脚本。保留现有数据库、凭据、Hub 队列与 Mac state.json；不得整库回滚、清空 outbox 或重放 dead letter。发布后通过生产探针和真实消息验收，不以 CI 绿灯结案。
