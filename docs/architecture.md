# TaskBox 架构

最后核对：2026-08-07。

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
- `js/completion-card.js`: 完成回执快照、Canvas 分页绘制、PNG 保存和 Web Share 图片分享。
- `scripts/build-app.mjs`: JavaScript/CSS 压缩、哈希、Service Worker 生成和 `dist/` 组装。

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

人生参谋部读取`/hq/today`前会等待当前记录级变更队列结算。远端返回后，主动作和维护动作按任务`updatedAt`与最新本地记录合并：本地较新的完成/删除状态优先，版本相同时完成/删除优先，真正更新的远端版本仍可覆盖本地旧状态。HQ 页面同时使用渲染版本号和当前路由校验，避免更早发出的异步请求在切换面板后覆盖新页面。

所有新增记录必须在客户端生成稳定 ID。服务端 `POST` 对同 ID 采用幂等更新，周期任务通过 `recurrenceKey` 额外防止重复实例。

完成回执存在任务 `raw_json.completionReceipt` 中，不建立重复任务表。首次完成时固定标题、备注、完成时间、盒子、主线、支线和积分；之后编辑任务不会静默改写历史回执，只有用户选择“按最新任务内容重新生成”才更新快照。

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
| `hq_period_reviews` | 按 `week/month + period_key` 幂等保存的周省或月省 |

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
- `GET /v1/daily-snapshot?date=YYYY-MM-DD`

任务的 `pinLevel` 只决定显示顺序；`commitmentRole`、`commitmentDate`和`commitmentSource`记录日省/参谋部承诺语义，二者不混为同一字段。扩展字段继续保存在任务 `raw_json` 中，保持旧客户端兼容。

`hq_daily_briefs.raw_json`中的`reviewCompletedAt`用于区分“上一份日省生成的今日计划”和“今天已经完成的日省”；`reviewArtifacts`保存私有飞书入口、认知卡片入口和本地 Markdown 路径，不复制日省全文。

`POST /v1/hq/daily-briefs/:date`区分“未传`primaryTaskId`”与“显式传`primaryTaskId: null`”：前者沿用原始战略承诺，后者清空承诺与席位。P1 生产语义中，`currentActionTaskId`驱动当前行动席位，`primaryTaskId`/`strategicCommitmentTaskId`保留原始承诺，完成证据进入`completionReceipt`/今日战果。daily brief 写入带 `_syncMutation`，服务端 fence 兼容旧式`generation`与新式 client sequence，过期回放返回当前 brief，不覆盖新事实。

P2 候选层位于`js/hq-candidates.js`：先过滤未释放、已完成、暂停项目、模板和冷却项，再计算九维 ROI，达到 55 分才进入最多三项候选。TaskBox 候选直接引用任务；主线系统的阻塞或缺下一步事实生成无`taskId`的原生候选。确认原生候选时，客户端按`candidateDedupeKey`及`hq-candidate:<dedupeKey>`查找已有记录，仅在不存在时创建任务；服务端`POST /v1/tasks`继续按`syncKey`幂等返回已有记录。跳过与接受历史写入 daily brief 的`candidateState`兼容 JSON，不新增数据库列。HQ 日期缓存中的部分 brief 写入采用字段合并，显式`primaryTaskId: null`仍解释为权威清空。

周期数据遵循“月省定资源边界 → 周省定唯一实验 → 日省定当天动作”的下行约束；执行证据从盒子向日省、周省、月省逐层聚合。周省和月省不批量创建普通任务，避免周期记分牌污染行动盒子。

参谋部进入盒子使用`#box/:boxId/:taskId/hq-primary|hq-maintenance`深链；第四段明确链接来自参谋部及其任务角色。盒子内普通任务跳转可只使用前三段。路由把`taskId`与来源交给盒子详情页，详情页展开可能折叠的任务分组、滚动到目标任务并显示指挥上下文。周实验从周期缓存读取，并通过周期 API 异步刷新；所属项目和任务角色继续来自本地记录级任务字段或深链角色，因此离线时仍有基本上下文。

### 任务中枢桥接

任务中枢位于知识管理项目，是 TaskBox 的外部确认型写入端。它先把输入拆成明确任务、日期任务和 AI 可做任务，得到用户确认后才调用 API：

```text
用户 / 日省输入 → 任务中枢确认清单 → POST /tasks → TaskBox 执行
                                             └→ HQ 共享任务视图
明确主动作 / 维护动作 ───────────────────────→ POST /hq/daily-briefs/:date
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
