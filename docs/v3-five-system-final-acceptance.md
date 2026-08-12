# 五系统 V3 会话 G：统一集成与最终联合验收

最后核对：2026-08-11。

## 判决

V3 在本地联合验收范围内通过。B–F 五系统最新交付已逐文件融合到 Gate 0–3 基线，自动测试、真实 V2 数据边界、生产构建和真实浏览器验收均通过。

这个判决不等于生产就绪：本次没有提交、推送、部署、修改生产数据库或验证生产 P4 API。生产前端和服务器状态仍以 docs/hq-primary-action-system-loop-v2.md 与 docs/runbook.md 为准。

## 基线与源

- 集成 worktree HEAD：31f0cd580dca91bba4327944a7a901e231b50b72，detached HEAD。
- Gate 0–3 基线 Build ID：d8378401cd66。
- B–F 五个只读源 worktree HEAD 均为 31f0cd580dca91bba4327944a7a901e231b50b72。
- B：/Users/ylw/.codex/worktrees/61db/time_control_app。
- C：/Users/ylw/.codex/worktrees/43b8/time_control_app。
- D：/Users/ylw/.codex/worktrees/7b78/time_control_app。
- E：/Users/ylw/.codex/worktrees/da36/time_control_app。
- F：/Users/ylw/.codex/worktrees/c094/time_control_app。
- 主工作树和源 worktree 的既有脏状态、同步冲突副本、未跟踪资产均未清理或覆盖。

## 实际集成

### 使命

- js/mission-model.js
- js/mission-page.js
- js/mission-v2-adapter.js
- scripts/test-mission-model.mjs

使命候选只能由 explicit_user 裁决；省略、AI 或非法授权不改变收件箱。发布仍需第二次明确批准。使命 L1 只读已批准 activeVersion，草稿和 V2 候选不进入事实摘要。

真实 04-claims-observations.jsonl 中 mission 域共有 72 条；使命 M2 只准入其中 38 条 observation/claim，34 条 source_proposal 保持隔离。pattern/calibration 由各自权威文件进入候选层。

### 健康

- js/health-model.js
- js/health-page.js
- js/health-store.js
- scripts/test-health-model.mjs

健康候选省略、AI 或非法授权均不能生成 Observation。明确用户裁决保留 decisionId / resolvedBy / resolvedAt；最近裁决在页面置顶可见。unknown/range 只能成为 context_only，不进入 Observation 或 28 日趋势。HQ 继续只读最小容量/约束投影，不显示原始症状或医疗记录。

### 时间

- js/time-attention-model.js
- js/time-attention-page.js
- js/time-attention-store.js
- scripts/test-time-attention-model.mjs

人工计划、日历事实、TaskBox 引用和健康容量继续分离。unknown/range 不进入日级统计；用户确认活动日期后仍为 validatedFact=false 的时间事实候选。健康 unknown/stale 只显示“容量依据不足”。

### 执行

- js/execution-model.js
- js/execution-page.js
- scripts/test-execution-model.mjs

checkbox、observation、claim 和 source_proposal 都不是任务。用户选择候选只写本地 taskbox_execution_hq_proposal_drafts_v1 shadow draft；页面加载不会自动消费，草案不调用客户端 addTask/updateTask。公共链仍是 HQ proposal → 用户批准 → 幂等 promote → TaskBox；TaskBox 是唯一任务与完成事实源。

公共 shadow draft 消费者未实现。后续如实现，只能在用户明确选择并确认后提交 HQ proposal，不能自动创建 TaskBox。

### 反馈

- js/feedback-model.js
- js/feedback-page.js
- js/feedback-import.js
- integrations/feedback_continuity.py
- integrations/test_feedback_continuity.py
- scripts/test-feedback-model.mjs

js/mission-store.js 与 js/feedback-store.js 已核对为源/目标同哈希，因此没有制造无意义改写。

反馈支持一次多选四个权威 JSONL，整批解析后再写入；任一损坏行会拒绝整批。导入 active 规则/实验强制降级为 proposed。观察、拒绝、评估、激活、废弃和跨系统决定均要求 explicit_user；AI 只能创建 proposed 对象。

真实 V2 四文件结果：

- feedback observation/claim：790。
- semantic cluster：22，其中模板/占位簇 20。
- pattern_candidate：42，全部 candidate_unvalidated。
- calibration_proposal：5，全部 proposed。
- 重复导入幂等；损坏 JSONL 整批拒绝，无部分写入。

## 集成会话新增

- scripts/test-v3-five-system-contract.mjs：B–F 联合授权、真实 V2 域边界、L1/L2 和 TaskBox 旁路合同。
- package.json：全量测试链接入反馈 Python 专项与 B–F 联合合同。
- scripts/preview-app.mjs：跨平台 Node 生产预览，npm run preview -- --port <port> 不再依赖 python 命令别名。
- js/health-page.js：集成源之上增加最近裁决审计可见性；这是唯一偏离 C 源文件哈希的领域文件。

## 自动验证

最终一次 npm test 全部通过，包括五系统专项、反馈 Python 专项、test:hq-systems、test:p1-integration、test:v3-integration、test:v3-five-system、P0 同步、日/周/月桥接、API schema、HQ API 和 proposal 状态机。

npm run build 通过：

- Build ID：eb3cac0b27a2。
- 应用入口：assets/app-KJ6YPCZ7.js。
- 样式：assets/style-3CDOA5OG.css。
- source map：关闭。

全量 git diff --check 被本任务继承的 CRLF/尾空格噪声淹没；本任务实际修改范围定向检查为 0 错误。

## 真实浏览器

使用独立端口 4317 的 dist：

- #hq/#mission/#health/#time/#execution/#feedback 可直接访问。
- HQ 五个固定入口和五张接入卡均跳转到正确 Hash；五页面返回 #hq。
- 1440px 与 390×844 页面宽度均等于视口，无横向溢出。
- 被测页面控制台无 warning/error。浏览器宿主自身 Statsig 上报超时不属于页面日志。
- 使命真实导入 38 条准入候选，纳入草稿后 activeVersion 仍为 V1；二次确认后发布 V2，审批记录包含 1 条候选和 explicit_user。
- 健康真实导入 84 条；unknown 候选确认后为 context_only，审计可见，HQ 不显示候选原文。
- 时间真实导入 135 条；确认日期后页面仍显示 validated_fact 仍为 0，健康容量依据不足解释可见。
- 执行真实导入 375 条；生成 1 份 shadow draft 后仍显示 0 事实、0 任务，刷新不自动晋升。
- 反馈一次多选四文件得到 790/22/20/42/5；重复导入计数不变；明确批准规则后显示 approvedBy=explicit_user，刷新保持 active。

## 未部署与未实施

- 未提交、未推送、未部署，未修改生产数据库。
- 未验证生产认证 200、未认证 401、CORS 204、生产 proposal 状态机、systemd active 或新服务器回滚快照。
- P4 API/schema 仍未部署；生产 promotion 开关状态不因本次工作改变。
- execution shadow draft 的公共 HQ 消费者未实现。
- mission/health/time/feedback 仍是 HQ L1 只读；execution 是 TaskBox L2 受控链。没有实现更深自动 L2 接线。
- 历史日省候选、42 个模式和 5 个校准提案的现实有效性未验证；validated_fact 仍为 0。

## 回滚与下一步

本次没有提交，因此回滚应按文件级集成批次处理，不得对脏工作树执行 git reset --hard 或 git checkout --。Gate 0–3 的逻辑回滚点仍是 Build ID d8378401cd66；服务器回滚点仍是 /opt/taskbox-api/backups/p1-action-seat-20260809T022214Z。

下一位 Agent 可先执行：

    npm ci
    npm --prefix server/taskbox-api ci
    npm test
    npm run build
    npm run preview -- --port 4319

只有用户明确授权后，才能提交、推送、部署或启动任一 calibration proposal。
