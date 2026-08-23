# TaskBox 架构

最后核对：2026-08-23。

## 系统边界

```text
GitHub Pages (dist)
  -> 原生 ES module / PWA / Service Worker
  -> 浏览器 localStorage 缓存与待同步队列
  -> HTTPS Bearer API
  -> Nginx / Express
  -> SQLite WAL 数据库
```

前端可离线启动，但服务器 API 是唯一正式云端数据源。Gist、GitHub Contents 和飞书不参与业务数据读写。

## 前端结构

- `js/app.js`: 路由、底部 Sheet、Toast 和按路由懒加载。
- `js/db.js`: 盒子、任务、主线、支线、里程碑、设置、本地缓存和同步队列。
- `js/home.js`: 首页、日期视图、盒子墙和主线概览。
- `js/box-detail.js`: 三类盒子的详情、编辑、右键菜单、完成/删除/还原。
- `js/recurrence.js`、`js/recurrence-ui.js`: 周期规则计算和编辑控件。
- `js/task-visibility.js`: 设备场景识别、任务释放时间、今天收工和编辑器设备控件。
- `js/task-execution.js`: 任务执行者模式、编辑器选择控件和显示标签。
- `js/points-store.js`: 积分账户、奖励、流水和任务完成对账。
- `js/small-world.js`: 珍宝阁、弑神塔和转盘入口。
- `js/mainline-page.js`: 主线、支线入口、里程碑和关联任务页面。
- `js/branch-page.js`: 支线编辑器、独立详情、完成流程和支线行动编辑器。
- `js/completion-card.js`: 完成回执快照、8 款 Canvas 模板、稳定分页、PNG 保存和 Web Share 图片分享。
- `js/hq-proposals.js`: P4 提案类型、状态、按钮权限和日/周/月校准汇总的纯视图模型。
- `js/mission-model.js`、`js/mission-v2-adapter.js`: 使命版本、精确授权、V2 候选隔离和 HQ L1 activeVersion 投影；`js/mission-store.js`保留本地优先缓存，并把草稿、正式版本、候选和事件按记录同步到使命云端账本。
- `js/health-model.js`: 来源化观测、候选授权审计、定性精力自动换算、保守容量和不含原始症状的 HQ L1 投影。
- `js/time-attention-model.js`: 保持日历、人工计划、TaskBox 引用和健康容量分离；确认日期也不把 V2 候选升级为事实。
- `js/execution-model.js`: 只读 TaskBox 事实，并把 V2 执行候选转换为本地 shadow HQ proposal draft。
- `js/feedback-model.js`、`js/feedback-import.js`: 反馈状态机、四层 V2 候选和多文件原子导入。
- `scripts/build-app.mjs`: JavaScript/CSS 压缩、哈希、Service Worker 生成和 `dist/` 组装。
- `scripts/preview-app.mjs`: 无 Python 依赖的跨平台 `dist/` 静态预览。

## 同步模型

- 拉取服务器数据前会生成受限的遗留恢复计划：仅补传本地独有的语义化思路盒及其任务，避免把已主动删除的普通盒子重新创建。
- 同名盒子合并时始终保留服务器记录 ID，本地任务通过 ID 映射归入服务器盒子，后续 PATCH 不会指向失效的本地 ID。
- 拉取开始前等待记录级写入队列稳定；云端与本地存在相同`id / syncKey / recurrenceKey`时，云端版本（包括`deleted=true` tombstone）是权威记录，避免旧浏览器时间戳让外部删除或替换失效。服务器从未见过的本地离线记录继续保留。
- 每次记录级写入先持久化到`taskbox_api_mutation_outbox_v1`，成功后按 mutation ID 删除；失败项跨重载保留。主动拉取先重放 outbox，仍有失败项时停止整库合并，避免云端旧版本覆盖离线完成事实。
- `taskbox_api_sync_state_v1`只保存最后成功/失败时间；HQ 根据 outbox、`navigator.onLine`和最近同步结果显示“云端已连接 / 待同步 / 离线 · 本地事实 / 数据未知”。
- 同一来源任务完成身份合并后，再对创建时间接近且时间语义一致的同内容副本做保守折叠。折叠后的主记录保存 `duplicateIds`，写入和删除会同步到别名记录。

1. 应用启动先读取本地缓存，确保首屏不等待网络。
2. 存在 API Token 时拉取 `/v1/taskbox`、`/v1/points` 和小世界记录。
3. 远端快照先标准化；同身份任务采用云端版本，本地只补入云端没有对应身份的离线记录。
4. 本地 CRUD 立即更新 UI 和 localStorage，把单条 `POST`、`PATCH` 或 `DELETE`同时写入持久化 outbox 和记录级串行队列。
5. 请求成功后清理对应 outbox 项；失败保留本地状态，重载或主动拉取后按原顺序重放。
6. `contentFingerprint` 只比较业务内容，避免 `updatedAt` 等噪声触发虚假的“Cloud synced”。

使命系统Beta沿用同一原则但保持独立命名空间：本地写入先更新`taskbox_mission_os_v1`并生成`taskbox_mission_sync_v1`待同步载荷，后台调用`POST /v1/mission/sync`。云端用内容哈希消除重复写入，草稿和候选使用`expectedRevision`防止跨设备静默覆盖，正式版本和事件不可变。outbox未结算或发生`409`时不拉取云端覆盖本地；云端同步完成后，HQ仍只通过`js/mission-hq-port.js`读取正式`activeVersion`，待发布草稿只输出差异字段名。

人生参谋部读取`/hq/today`前会等待当前记录级变更队列结算。远端返回后，主动作和维护动作按任务`updatedAt`与最新本地记录合并：本地较新的完成/删除状态优先，版本相同时完成/删除优先，真正更新的远端版本仍可覆盖本地旧状态。HQ 页面同时使用渲染版本号和当前路由校验，避免更早发出的异步请求在切换面板后覆盖新页面。

所有新增记录必须在客户端生成稳定 ID。服务端 `POST` 对同 ID 采用幂等更新，周期任务通过 `recurrenceKey` 额外防止重复实例。

完成回执存在任务 `raw_json.completionReceipt` 中，不建立重复任务表。首次完成时固定标题、备注、完成时间、盒子、主线、支线、积分和随机 `templateId`；8 款模板均由本地 Canvas 绘制，不依赖外部字体或图片。长备注分页沿用同一个 `templateId`，用户可主动换款并保存到原快照；旧版回执缺少该字段时，按任务 ID 与完成时间确定性补款，避免每次打开跳变。之后编辑任务不会静默改写历史回执，只有用户选择“按最新任务内容重新生成”才更新内容快照，并保留当前模板。

## 数据表

| 表 | 记录粒度 |
| --- | --- |
| `app_meta` | 设置、每日一句等应用元数据 |
| `boxes` | 单个盒子及类型配置 |
| `tasks` | 单个任务、池项目、清单项或周期模板/实例；设备、执行方式、释放时间、暂存状态和进度日志使用独立列 |
| `mainlines` | 单条主线 |
| `branches` | 主线下的一条可独立推进、完成和复盘的支线 |
| `milestones` | 单个主线里程碑 |
| `usage_logs` | 放松池等项目的一次使用记录 |
| `points_account` | 积分账户配置 |
| `points_rules` | 积分规则和默认值 |
| `points_rewards` | 单个奖励 |
| `points_transactions` | 单笔积分流水 |
| `sw_floors` | 小世界单层元数据 |
| `sw_items` | 小世界单条内容 |
| `hq_daily_briefs` | 按日期唯一保存的驾驶舱、行动承诺和日省闭环 |
| `hq_decisions` | 一条待裁决或已裁决事项 |
| `hq_proposals` | 按稳定幂等键保存一条日省行动、周省实验或月省押注提案及当前 revision |
| `hq_proposal_events` | 提案创建、修订、批准、拒绝、延期和晋升的不可变审计事件 |
| `hq_period_reviews` | 按 `week/month + period_key` 幂等保存的周省或月省 |
| `system_candidates` | 按稳定 `candidate_id` 保存日省派给五个独立系统的未验证候选及保留/忽略状态 |
| `mission_records` | 一条使命草稿或一个不可变正式版本的当前记录、revision与内容哈希 |
| `mission_record_versions` | 使命记录每次有效内容变化的不可变revision快照 |
| `mission_candidates` | 一条使命候选及其授权裁决状态；已裁决状态不会被未裁决同步复活 |
| `mission_events` | 使命发布和组合变化的不可变、按operation ID幂等审计事件 |

业务字段有独立列便于查询和索引，同时保留 `raw_json` 兼容尚未拆列的前端字段。数据库定义位于 `server/taskbox-api/schema.sql`，启动和导入脚本会为旧库补列。

任务可见性统一由 `visibleAfter` 判断。手动“今天收工”同时写入 `deferredAt`、`deferNote` 和 `progressLogs`；周期实例使用规则计算的释放时间；未来单次任务使用计划日 00:00。UI 因此能分别展示“今日已收工”和“待到点出现”。日期页通过完整时间线读取未来记录，盒子当前列表只读取已释放记录。`deviceContext` 只影响排序和分组，`executionMode` 只描述由本人、AI 或双方协作执行，两者都不能代替可见性或删除状态。

## API

基地址：`/taskbox-api/v1`。除 CORS 预检外，业务请求均需要 Bearer Token。

## 人生参谋部

人生参谋部是 TaskBox 上层的决策与项目健康视图，复用同一套 PWA、认证、SQLite API 和记录级同步，不另建任务数据库。

- `#hq`：今日驾驶舱、项目中心、待决策队列和系统接入口。
- `#hq/week`：本周作战室，展示唯一实验、主瓶颈、记分牌和下周资源分配。
- `#hq/month`：本月参谋会，展示经营裁决、业务组合、战略决策、三层目标和下月资源分配。
- 无 Hash 路由默认落到`#hq`；全局`workspace-switch`只负责主副面板导航，不复制业务数据。
- TaskBox：行动执行层，管理任务、场景、进度和完成证据。
- 日省：复盘层，开始前读取 `/daily-snapshot`、HQ 快照和 7 天承诺状态生成事实包，结束后把次日 `1 个主动作 + 2 个维护动作`回写到 TaskBox。
- `hq_daily_briefs`：按日期保存行动驾驶舱、外部结果、停止做、继续做和昨日闭环。
- `hq_decisions`：保存必须明确继续、排期、拆小或停止的事项。
- `hq_period_reviews`：按`week/month + period_key`保存周省、月省的结构化裁决与产物入口。

关键接口：

- `GET /v1/hq/today?date=YYYY-MM-DD`
- `GET /v1/hq/review-status?date=YYYY-MM-DD&days=7`
- `GET /v1/hq/periods/:type/current?date=YYYY-MM-DD&offset=-1`
- `GET/POST/DELETE /v1/hq/periods/:type/:key`
- `GET /v1/hq/periods?type=week|month&limit=N`
- `GET/POST /v1/hq/daily-briefs/:date`
- `GET/POST/PATCH/DELETE /v1/hq/decisions`
- `GET/POST /v1/hq/proposals`、`GET /v1/hq/proposals/:id`
- `POST /v1/hq/proposals/:id/approve|reject|defer|restore|promote`
- `POST /v1/system-candidates/batch`
- `GET /v1/system-candidates?systemId=mission|health|time|execution|feedback&status=pending|kept|dismissed`
- `PATCH /v1/system-candidates/:id`（只接受 `kept` 或 `dismissed`）
- `POST /v1/mission/sync`（使命草稿、正式版本、候选和事件的原子记录级同步）
- `GET /v1/mission/state`（重建使命store并返回各记录当前revision）
- `GET /v1/daily-snapshot?date=YYYY-MM-DD`

任务的 `pinLevel` 只决定显示顺序；`commitmentRole`、`commitmentDate`和`commitmentSource`记录日省/参谋部承诺语义，二者不混为同一字段。扩展字段继续保存在任务 `raw_json` 中，保持旧客户端兼容。

`hq_daily_briefs.raw_json`中的`reviewCompletedAt`用于区分“上一份日省生成的今日计划”和“今天已经完成的日省”；`reviewArtifacts`保存私有飞书入口、认知卡片入口和本地 Markdown 路径，不复制日省全文。

`POST /v1/hq/daily-briefs/:date`区分“未传`primaryTaskId`”与“显式传`primaryTaskId: null`”：前者沿用原始战略承诺，后者清空承诺与席位。P1 生产语义中，`currentActionTaskId`驱动当前行动席位，`primaryTaskId`/`strategicCommitmentTaskId`保留原始承诺，完成证据进入`completionReceipt`/今日战果。daily brief 写入带 `_syncMutation`，服务端 fence 兼容旧式`generation`与新式 client sequence，过期回放返回当前 brief，不覆盖新事实。

P2 候选层位于`js/hq-candidates.js`：先过滤未释放、已完成、暂停项目、模板和冷却项，再计算九维 ROI，达到 55 分才进入最多三项候选。TaskBox 候选直接引用任务；主线系统的阻塞或缺下一步事实生成无`taskId`的原生候选。确认原生候选时，客户端按`candidateDedupeKey`及`hq-candidate:<dedupeKey>`查找已有记录，仅在不存在时创建任务；服务端`POST /v1/tasks`继续按`syncKey`幂等返回已有记录。跳过与接受历史写入 daily brief 的`candidateState`兼容 JSON，不新增数据库列。HQ 日期缓存中的部分 brief 写入采用字段合并，显式`primaryTaskId: null`仍解释为权威清空。该层已于 2026-08-09 以 Build ID`a485fa88a115`完成生产发布；P2 未变更 API 运行代码，也没有新增生产数据库列。

P3 子系统契约层位于`js/hq-systems.js`，以代码内轻量`system_registry`配置登记六个系统，不新增数据库表。静态接入卡声明职责、唯一事实源、读取/写回方式、健康检查、同步时效、行动门槛、证据回流、负责人和接入等级；动态视图只把`/v1/hq/today.projects`成功读取且未过期的主线快照视为 L1 已确认事实。读取失败显示`unknown`，超过 SLA 显示`stale`，不会回退为健康。主线的`blocked / needs_action`与 P2 候选门槛共用同一语义；L1 模块本身不写原系统，用户确认后才由既有 TaskBox L2 路径幂等创建任务。日省与 TaskBox 标记为 L2 受控链路，交易、镜像和 GAP 保持 L0 入口。P3 只复用现有 HQ/任务 API，没有服务端运行代码和数据库 schema 变更；已于 2026-08-09 以 Build ID`dca5c12098ba`完成生产发布。

P4 控制平面把复盘输出统一保存为 proposal。`sourceAuthority=explicit_user / standing_rule`初始为`approved`（持续授权必须有`standingRuleId`），`ai_derived`初始为`proposed`；同一`idempotencyKey`内容未变时返回原 decision，内容变化只增加 revision 和审计事件。拒绝提案保留在原表，由回收池读取；`restore`按最近一次拒绝事件的`previousStatus`恢复，不删除审计。日动作选择任务盒后在同一交互内 approve/promote；周/月保持战略对象。前端与API/schema均已于2026-08-10完成生产发布，服务器回滚点为`/opt/taskbox-api/backups/p4-review-proposals-20260809T170701Z`。

P5–P6 资源治理层位于`js/hq-resource-governance.js`，只组合 HQ proposal、项目快照与`taskbox_hq_period_cache_v1`中的周/月省快照，不建立新数据库或第二套任务。唯一赌注只接受`status=approved`的`monthly_bet_proposal`；未批准月省内容最多作为周期页复盘，不进入正式赌注。项目资源偏差按项目名匹配周省`resources`或月省`portfolio`，没有明确字段时显示未知。系统效率读取周省`metrics`中的`observationDays / systemMaintenanceMinutes / effectiveDecisionCount / externalResultCount / duplicateEntryCount / medianSignalToActionMinutes`；除覆盖天数可由`inputCoverage`机械映射外，其余值不得从自然语言猜测。P6 只有在连续观测至少14天且五项指标齐全时才输出保留、简化或停止建议，始终只读，不自动改变项目、功能或TaskBox任务。

五系统 V3 于 2026-08-11 完成本地统一集成。2026-08-12 发布候选进一步恢复“系统独立、接口耦合HQ”的边界：使命、健康、时间、执行、反馈各自拥有独立页面、模型/状态与HQ端口，`js/five-system-hq-ports.js`只聚合标准快照；`js/hq-page.js`不得直接读取五系统store/model。HQ 首屏固定入口带只负责发现与跳转，仍保留参谋部/盒子两级全局导航。mission/health/time/feedback 为 L1 只读；execution 是独立L2系统，TaskBox只是其唯一任务、完成状态与完成证据事实引擎。五个系统从 V2 读取候选但保持各自域过滤和 `validated_fact=0`：使命候选必须经`explicit_user`或精确`standing_rule`裁决，纳入草稿不等于发布；健康 unknown/range 只保存上下文，裁决留审计；时间确认活动日仍不是事实；执行只写本地 shadow proposal draft；反馈多文件导入原子幂等，active 对象降级 proposed，所有高权限转换默认拒绝。TaskBox 写入仍只能走 HQ proposal → 明确批准 → 幂等 promote；execution shadow draft 公共消费者和更深自动 L2 接线未实现。

日省消费层在上述独立边界之外增加一条统一候选传输协议：六问先生成 `daily-review-envelope`，再按 `systemId`拆成最多五份候选包，通过`POST /v1/system-candidates/batch`幂等投递。`candidate_id`是跨重试身份，服务端按系统隔离读取；页面只能保留或忽略。`candidate_unvalidated`与`writesTargetSystem=false`是写入前置条件，服务端固定返回`writesTargetSystem=false`，因此“保留”只改变候选收件箱状态，不会改变任何目标系统事实或权限状态。

健康页仅保留“健康事实待确认”作为外部、历史、日期不明或未验证材料的人工准入层；明确用户日省健康事实由健康同步链路幂等入库，日省候选只作传输/审计缓冲，不在健康页重复确认。

该候选传输层已于2026-08-13完成生产发布和outbox重放。服务器持久化范围仅是每日候选收件箱；使命、健康、时间、执行、反馈的内部store以及30日私有初始化基线仍保存在当前浏览器localStorage。候选API跨设备可读不等于五系统完整状态跨设备，后者需要独立的受认证系统store协议。

为了免除每个浏览器重复选择私有包，服务器以`TASKBOX_FIVE_SYSTEM_BASELINE_PATH`指向Git外私有文件，并通过认证、`no-store`的`GET /v1/system-baseline/current`返回。HQ只在当前浏览器没有已发布基线时拉取一次并原子发布V1；基线发布后的五系统运行状态仍在当前浏览器localStorage，这不是完整五系统状态的服务器同步。

历史基线发布由`js/five-system-bootstrap.js`协调五个独立store，输入是本机私有V2初始化包，不是公开静态资源。事务开始前保存五store与初始化状态快照；用户明确发布后生成递增基线版本，并保留最近两版的发布前快照供原子回退。使命项进入已纳入基线状态；健康仅把12条非提案单日记录转为历史Observation，其余72条保留上下文；时间仅把22条非提案单日映射转为历史事实，其余113条保留上下文；执行375条只成为历史执行记录，不创建当前任务；反馈42个模式进入observed，5个校准提案继续proposed。任一校验或写入失败则恢复全部store，日常新增仍走候选层。

周期数据遵循“月省定资源边界 → 周省定唯一实验 → 日省定当天动作”的下行约束；执行证据从盒子向日省、周省、月省逐层聚合。周省和月省不批量创建普通任务，避免周期记分牌污染行动盒子。

参谋部进入盒子使用`#box/:boxId/:taskId/hq-primary|hq-maintenance`深链；第四段明确链接来自参谋部及其任务角色。盒子内普通任务跳转可只使用前三段。路由把`taskId`与来源交给盒子详情页，详情页展开可能折叠的任务分组、滚动到目标任务并显示指挥上下文。周实验从周期缓存读取，并通过周期 API 异步刷新；所属项目和任务角色继续来自本地记录级任务字段或深链角色，因此离线时仍有基本上下文。

### 任务中枢桥接

任务中枢位于知识管理项目，是 TaskBox 的外部确认型写入端。它先把输入拆成明确任务、日期任务和 AI 可做任务，得到用户确认后才调用 API：

```text
用户 / 日省输入 → 任务中枢确认清单 → POST /hq/proposals
                                            └→ approve → promote → TaskBox 执行
明确主动作 / 维护动作 ─────────────────────────────────────→ daily brief 引用 taskId
```

普通任务只有一条 TaskBox 记录。HQ 复用任务、主线、支线和里程碑数据；仅驾驶舱承诺额外保存任务 ID。AI 任务通过`executionMode=ai`被 HQ 筛选，避免以“同步”为名制造双份记录。桥接脚本使用`syncKey`与内容、日期、盒子联合去重，并从现有私有 Token 位置读取认证。

- 快照：`GET /taskbox`、`GET /points`。
- 盒子：`POST /boxes`、`PATCH /boxes/:id`、`DELETE /boxes/:id`。
- 任务：`POST /tasks`、`PATCH /tasks/:id`、`DELETE /tasks/:id`。
- 主线：`POST /mainlines`、`PATCH /mainlines/:id`、`DELETE /mainlines/:id`。
- 支线：`POST /branches`、`PATCH /branches/:id`、`DELETE /branches/:id`。
- 里程碑：`POST /milestones`、`PATCH /milestones/:id`、`DELETE /milestones/:id`。
- 每日一句：`GET /daily-quote`、`PATCH /daily-quote`。
- 积分：流水和奖励的记录级新增/修改接口。
- 小世界：`GET /smallworld/:realm` 与记录级 items CRUD。

## 安全边界

- API 只监听 `127.0.0.1`，由 Nginx 提供 HTTPS 和公开路径。
- Token 存储在服务器环境文件和浏览器 localStorage，不进入源码、构建产物或仓库。
- CORS 只允许生产站点和明确的本地调试 Origin。
- GitHub Pages 只能保护源码组织方式，不能让浏览器端业务逻辑真正保密；关键校验和密钥必须留在服务端。
