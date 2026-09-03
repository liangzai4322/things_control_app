# 执行系统 → TaskBox 正常生产写入合同

最后核对：2026-09-02。

## 权限裁决

用户通过治理请求 `DSP-20260902-governance-011` 明确授权执行系统获得正常生产级 TaskBox 执行权限，授权引用为 `standing-execution-taskbox-normal-2026-09-02`，登记幂等键为 `governance:execution-normal-taskbox-permission:2026-09-02`。

这项授权取消 dry-run 和 1–3 条任务试运行数量限制，但不取消正常生产保护。每次写入仍必须有 `explicit_user`、精确 `standing_rule` 或 `approved_hq_proposal` 授权，并通过 TaskBox 专用 API 校验。

## 系统边界

- Execution OS 是执行领域能力和控制面；盒子 APP / TaskBox 提供专用 API、同步和唯一任务事实存储。
- 执行系统不保存可独立编辑的第二套任务状态。写成功仅以 TaskBox API 返回和后续回读为准。
- 静态 PWA 不持有 execution-system 服务凭据。正式调用只能来自私有服务运行环境。
- 禁止回退到通用 `/v1/tasks` 写接口、本地 `addTask/updateTask`、浏览器 Token 或整库快照写入。
- AI candidate、`candidate_unvalidated` 和本地 shadow draft 不得自动晋升为正式任务。
- 执行系统不进行使命/主线战略裁决，不硬删除、不强制覆盖冲突，也不管理数据库、schema 或凭据。

## TaskBox 专用接口

合同版本：`2026-09-02`。

| 能力 | 接口 |
| --- | --- |
| 能力与 scope 发现 | `GET /v1/execution/capabilities` |
| 按真实 ID 读取任务和 ETag | `GET /v1/execution/tasks/:id` |
| 执行单项正式操作 | `POST /v1/execution/task-operations` |
| 查询逐项审计 | `GET /v1/execution/audit` |

认证必须使用 execution-system 独立 Bearer Token 和最小 scope。更新类请求携带 `If-Match: "task-revision-<integer>"`；所有写请求携带稳定 `X-Idempotency-Key`。TaskBox 对 revision 冲突返回 `409 task_revision_conflict`，客户端必须停止并重新读取，不得自动覆盖或降级到旧接口。

允许操作：`create / update / schedule / record_progress / record_blocker / clear_blocker / append_evidence / complete / reopen / soft_delete / restore`。每类操作由 TaskBox 服务端使用字段白名单和独立 scope 校验，不提供任意 PATCH。

最小请求示例：

```json
{
  "contractVersion": "2026-09-02",
  "sourceSystem": "execution",
  "requestId": "DSP-20260902-governance-011",
  "operation": "schedule",
  "taskId": "real-task-id",
  "expectedRevision": 7,
  "authorizationSource": "explicit_user",
  "authorizationEvidence": {
    "referenceId": "standing-execution-taskbox-normal-2026-09-02"
  },
  "requestedMutation": {
    "scheduledAt": "2026-09-03T09:00:00+08:00"
  },
  "reason": "用户已授权执行系统进行正常排期"
}
```

创建以外的操作必须提供真实 `taskId` 和 revision。服务端身份、scope、授权证据、请求哈希、前后 revision、实际字段差异、成功/拒绝/冲突结果均进入审计；Token 不进入业务载荷或日志。

## 执行系统客户端

`integrations/execution-system/taskbox-client.mjs` 是私有运行环境使用的 fail-closed 客户端。它只调用 `/v1/execution/*`，不实现旧接口回退，也不持久化第二套任务事实。

运行环境：

```text
EXECUTION_TASKBOX_ENDPOINT=https://liangzai666.com/taskbox-api
EXECUTION_TASKBOX_TOKEN=<execution-system 专用私有 Token>
EXECUTION_TASKBOX_TOKEN_FILE=~/.codex/secrets/taskbox-execution-system-token
EXECUTION_TASKBOX_WRITE_ENABLED=1
```

`EXECUTION_TASKBOX_WRITE_ENABLED` 是即时停用开关，不是 dry-run、分批发布或数量限制。设为非 `1` 时客户端拒绝所有写入；TaskBox 端还应保留独立服务开关、disable file 或凭据撤销能力。

## 日省 intake 消费与回执（2026-09-03.1）

`integrations/execution-system/daily-intake-consumer.mjs` 读取 `GET /v1/system-candidates?intake=1&systemId=execution&reviewDate=&status=&limit=` 返回的 `intakes`；`status` 每次只能传一个精确值，消费者分别查询 `accepted` 与 `retrying`。只接收合同版本 `2026-09-03.1` 且包含 `reviewDate`、观察时间窗、来源/证据引用、`freshness.status=fresh`、24 小时内新鲜度、正整数 revision 和稳定幂等键的包。旧候选、AI 内容、缺失/过期合同均只形成 `candidate_read_only` 或 `ignored` 回执，绝不写 TaskBox。领域授权只能存在于 `data` 中作为证据，本传输通道不构成写入授权。

每个包处理后提交 `POST /v1/system-candidates/:intakeId/receipt`；请求体严格为 `status`（`received|processing|processed|retrying|failed|ignored`）、稳定 `idempotencyKey` 和 `projection`，失败时才追加 `errorCode/errorMessage/retryAt`。回执投影仅含真实 `taskId` 引用、outcome、progress/blocker/evidenceRefs、needsUserAction 和审计引用；不回传任务正文、Token 或任务库快照。`explicitDispatches` 也只记为 `explicit_dispatch_read_only`：真正 TaskBox 写入必须另走已授权的 execution 专用写入合同。

生产运行入口为 `node scripts/consume-daily-intake-execution.mjs`。受控 runner 只从 `DAILY_INTAKE_TOKEN_FILE` 读取专属身份；默认挂载为 `/etc/taskbox-daily-intake/execution.token`（目录 `0700`、文件 `0600`）。端点由 `DAILY_INTAKE_ENDPOINT` 指定，默认 `https://liangzai666.com/taskbox-api`。它禁止回退到 `TASKBOX_API_TOKEN`、浏览器 Token、原始环境变量 Token 或 execution TaskBox 写 Token；缺失即 fail closed。专属身份只应拥有 execution `system-candidates` 读取与 receipt 写入 scope，绝不能拥有任务 CRUD、HQ 批准或其他系统 intake scope。

消费者仅查询 `status=accepted` 与 `status=retrying`，跳过 `processed/ignored`；每次消费必须由正式日省 batch 提供精确 `DAILY_INTAKE_REVIEW_DATE=YYYY-MM-DD`，缺失或非法即 fail closed，绝不扫描所有历史 accepted 记录。每轮持有单消费者 lease，读取后将**仅 receipt**（不含候选正文）原子写入私有 `receipt-outbox`，再串行投递。网络/5xx/429 按最多五次指数退避重试；401/403 进入 `authBlocked` 且停止重试；409 进入 dead-letter，绝不覆盖。重启后优先重放 due receipt；同 intake/revision 的 receipt body 不同会 fail closed。运行摘要不含候选正文或凭据；`npm run healthcheck:daily-intake-execution` 以专属身份分别作 accepted/retrying 最小读取和 outbox 状态检查。

正式触发只能由“正式日省 batch 已 accepted”后的单次事件携带 `reviewDate` 启动；不得接到日省 Lite 高频扫描。共享 TaskBox API 当前没有 accepted webhook，首版只能由执行系统受控 runner 低频轮询，且不得由本系统直接改服务器或停用文件。若以后增加低频补偿，必须先由共享底座确认非终态筛选、lease 和 receipt 重放语义。检测到全局停用文件产生的 `503 daily_intake_api_disabled` 时，消费者按“有意暂停”成功退出、不重试也不通知。最终失败通知使用 Notification Hub B 级稳定事件键 `daily-intake:execution-consumer-readiness-failed:2026-09-03`。本模块尚未部署或注册自动化。

## 当前实施与部署状态

- 执行系统客户端、合同校验和专项测试已在本工作树实施。
- TaskBox 日省共享底座已由盒子 APP 独立部署到生产：提交 `4c64b5e`，API workflow `33729195141`、Pages workflow `33729180885`，Build ID `64e751c46d52`；回滚快照为 `/opt/taskbox-api/backups/execution-system-20260903T073934Z`，即时停用文件为 `/etc/taskbox-daily-intake.disabled`。盒子 APP 已验证认证正反例、幂等/冲突/回执状态、HQ 最小投影及零 TaskBox 任务副作用。
- 2026-09-03 本机只读核验未发现受控挂载目录 `/etc/taskbox-daily-intake/` 或 `execution.token`；因此没有运行线上空队列/权限探针，也没有部署或注册轮询。Token 必须由受控 runner 的秘密管理器挂载，不能写入本工作树、环境明文或浏览器。
- 本工作树没有配置或读取真实 Token，没有修改 TaskBox 数据，也没有通过旧接口做兼容性写入。
- 执行系统仍须在实际启用写入前调用 capabilities 核对合同版本和 scope；这是一致性检查，不是 dry-run。合同或 scope 不匹配、服务停用或认证失败时 fail closed。线上实际能力发现尚未由本工作树使用专用 Token 执行，因为本机不保存该生产凭据。

生产停用由盒子 APP 服务端控制：创建 `/etc/taskbox-execution-system.disabled` 后专用 API 返回 `503 execution_api_disabled`；移除该文件可恢复服务。执行系统侧同时可将 `EXECUTION_TASKBOX_WRITE_ENABLED` 设为非 `1`，立即拒绝本地客户端写入。
