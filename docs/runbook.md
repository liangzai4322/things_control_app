# TaskBox 运维手册

最后核对：2026-08-23。

## 本地验证

```powershell
npm ci
npm --prefix server/taskbox-api ci
npm test
npm run test:feedback-python
npm run test:v3-integration
npm run test:v3-five-system
npm run test:hq
npm run test:period-review
npm run build
npm run preview -- --port 4173
```

访问 `http://127.0.0.1:4173/`。源码调试可运行 `python -m http.server 8000`，但发布验证必须使用 `dist/`。

## 前端部署

推送 `main` 后，`.github/workflows/deploy-pages.yml` 会安装依赖、执行 `npm run build`，并把 `dist/` 作为 GitHub Pages Artifact 发布。GitHub Pages Source 必须设为 GitHub Actions。

发布前：

1. 运行测试和生产构建。
2. 确认 `dist/` 不含 Token、密码、Cookie、源映射和调试文件。
3. 创建可识别的 Git 标签或本地备份。
4. 推送一次完整提交，避免把同一功能拆成多个不可用的线上中间状态。

## API 配置

服务器环境文件不提交仓库，至少包含：

```text
TASKBOX_DB_PATH=<SQLite absolute path>
TASKBOX_API_PORT=<loopback port>
TASKBOX_API_TOKEN=<secret>
TASKBOX_ALLOWED_ORIGINS=<comma-separated origins>
HQ_PROPOSAL_PROMOTION_ENABLED=0|1
ASSISTANT_GATEWAY_API_ENABLED=0|1
ASSISTANT_GATEWAY_API_TOKEN_FILE=<private credential file>
ASSISTANT_GATEWAY_API_DISABLE_FILE=<fail-closed marker file>
ASSISTANT_GATEWAY_API_SCOPES=proposal-replies:write
```

API 目录默认 `/opt/taskbox-api`，数据库默认 `/opt/taskbox-api/data/taskbox.sqlite`。生产进程应由 systemd 或等价守护程序管理，Nginx 把 HTTPS `/taskbox-api/` 反向代理到本地端口。

## 服务器发布

1. 备份 API 目录和 SQLite 数据库；WAL 模式下优先使用 SQLite 在线备份或停服务后复制数据库、`-wal`、`-shm`。
2. 上传 `server/taskbox-api/` 的变更，不覆盖环境文件和数据目录。
3. 执行 `npm ci --omit=dev` 和 `npm run init-db`。
   发布前可在 API 源码目录运行 `npm run test:schema`，验证旧库补列和索引创建。
4. 重启服务并查看不含敏感信息的最近日志。
5. 验证认证健康检查为 `200`、未认证访问为 `401`、生产 Origin 的 OPTIONS 为 `204`。
6. 用测试记录完成新增、修改、删除，再清理测试记录。

主线/支线发布后再验证：

1. `GET /v1/taskbox` 返回 `mainlines / branches / milestones / boxes`，且历史任务可在无 `branchId` 时正常加载。
2. 为一条测试主线执行支线 POST → PATCH，再通过 `GET /v1/taskbox` 核对记录，并将测试任务的 `branchId` 指向该支线。
3. 打开 `#mainline/:id` 和 `#branch/:id`，确认支线卡片、关联任务、完成标准与移动端横向列表正常。
4. 删除测试支线后，确认任务仍保留且仅解除 `branchId`；最后清理测试主线和任务。

人生参谋部发布后再验证：

1. 无 Hash 打开生产根地址，确认默认呈现`#hq`内容且“参谋部”切换项激活；切换到`#home`后“盒子”激活。
2. `GET /v1/hq/today?date=YYYY-MM-DD` 返回 `brief / commitments / projects / decisions / review / ai`。
3. 点击参谋部主动作，确认 URL 为`#box/:boxId/:taskId/hq-primary`，目标任务自动展开并高亮。
4. 盒子指挥链应显示最近已完成周省的唯一实验、所属项目和“今日主动作”，并能返回参谋部或进入项目。
5. 新建一条临时决策、标记已决定并删除测试记录。
6. `GET /v1/daily-snapshot?date=YYYY-MM-DD` 只返回目标日期相关记录。
7. `GET /v1/hq/review-status?date=YYYY-MM-DD&days=7` 返回逐日承诺判定和事实计数。
8. GitHub Pages 的 `#hq` 可打开，日省闭环卡与事实包抽屉可见，未配置 Token 时仍能显示本地快照。
9. `#hq/week`与`#hq/month`可切换；`offset=-1`周期 API 分别返回最近已完成周省/月省的`review / derived / projects / decisions`。
10. 对测试周期执行一次 POST → GET → DELETE，确认周省/月省按周期键幂等写入。
11. 在 1440px 与 390px 视口检查参谋部、盒子和任务指挥链：无横向溢出、控制台错误或失败资源请求。
12. 完成一条带备注的测试任务，确认回执从 8 款模板随机抽取、模板名正确、“换一款”不重复当前款、长内容分页保持同款、已完成列表可再次打开；用 390px 窄屏确认卡片与分享/保存按钮可见，手机支持时调用系统分享，其他浏览器回退为 PNG 保存。
13. 把一条临时任务设为当日主动作，在盒子完成后立即切回参谋部；本地卡片应立即退出，远端刷新后不得回闪或重新占位。随后主动取消完成并再次刷新，确认较新的未完成版本可以正常恢复。弱网测试时还应确认离开`#hq`后，较早发出的 HQ 请求不会覆盖盒子或其他页面。
14. P4 发布后分别创建日/周/月提案：重复 POST 不增加 decision，内容变化只增加 revision；验证 approve/reject/defer/restore 与审计事件。前端拒绝应立即进入折叠回收池，并可通过6秒撤销或回收池恢复；日动作选盒后应一次完成 approve/promote。只有批准的日动作在`HQ_PROPOSAL_PROMOTION_ENABLED=1`且请求`shadowMode=false`时可晋升 TaskBox；周/月 promote 返回`409`，`provisional`月度 approve 返回`409`。
15. 五系统 V3 Gate 0–3 发布前检查 `#hq/#mission/#health/#time/#execution/#feedback`：HQ 首屏五入口、接入卡跳转、刷新、返回 HQ、1440px/390×844 无溢出和控制台无 warning/error。
16. 使命云端Beta发布前运行`npm run test:mission`、`npm --prefix server/taskbox-api run test:mission`和`npm --prefix server/taskbox-api run test:schema`；用临时数据库验证首次同步、重复同步、revision冲突、AI发布拒绝和云端store重建。
17. 使命先保存草稿，确认 HQ 仍只显示 unknown 或原 activeVersion；完成明确`explicit_user`或精确`standing_rule`批准后再确认 L1 更新。健康依次验证无快照、发布最小快照、冲突来源和超过 36 小时，HQ 应为 unknown/对应状态/unknown/stale，且不出现症状或医疗记录原文。
18. 执行系统 API 发布前运行`npm --prefix server/taskbox-api run test:execution`。发布脚本会生成或复用`/etc/taskbox-execution-system-token`、登记显式授权引用和最小 scopes，并验证 execution Token 可访问 capabilities、通用 TaskBox Token 被拒绝。生产写入再验证创建幂等、`If-Match`冲突、审计与软删除恢复；不得使用通用`/v1/tasks`替代。
19. Assistant Gateway 回复接口发布前运行`npm --prefix server/taskbox-api run test:hq`和`test:schema`。发布脚本生成或复用独立凭据文件并验证：Gateway 身份仅能访问 proposal replies、通用 Token 被拒绝、Gateway Token 不能访问通用 API。生产只做不存在 proposal 的认证探针，不发送真实审批；停用时创建配置中的 disable 文件。
20. Assistant Gateway worker 发布前确认 Notification Hub 的 lease-bound reply 路由已上线，运行`npm run test:assistant-gateway`。发布脚本只用 ingress 专用身份对不存在消息执行`404`认证探针，并验证 pending-read `200`、读写 Token 交叉访问`401`、通用健康路由拒绝，再以独立无登录用户启动`assistant-gateway.service`。生产默认仍为 echo：只处理“测试”或“测试-...”，回声成功后才ack；其他消息延后一小时。Decision代码只有显式修改 systemd feature flag 后才启用，并必须要求单一、未过期、用户/会话/版本完全匹配的`replyBinding`；它只调用HQ reply API，绝不promote或写TaskBox。
21. 五系统候选 API 发布后运行 `server/taskbox-api/scripts/verify-system-candidates-production.sh`，必须依次得到认证健康`200`、未认证`401`、CORS`204`、候选路由`200`。随后重放日省候选 outbox 两次：首次只允许`created`，第二次相同候选必须全部`unchanged`；分别读取五个`systemId`，不得跨系统返回候选。
22. 首次打开五系统时，在HQ“五系统固定入口”选择本机私有`五系统初始化包-v1.json`并发布V1基线。必须显示版本号，以及使命39、健康事实12/上下文72、时间事实22/上下文113、执行历史375/当前任务0、反馈observed 42/proposed 5。再次发布应形成下一版本且不重复健康Observation；点击“回退上一版”必须原子恢复五store和前一版本号。初始化包包含私人日省内容，禁止提交Git、部署Pages或上传到无认证位置。
23. 生产服务器将同一私有包放在Git外路径并设置`TASKBOX_FIVE_SYSTEM_BASELINE_PATH`。带Token的新浏览器首次打开HQ时应自动显示V1版本，无需文件选择；未认证请求必须401，响应必须`Cache-Control: private, no-store`。没有Token时文件入口继续可用。
24. P5–P6 发布后，确认唯一赌注只读取已批准月度押注；proposed/deferred/rejected月押注不得显示为正式赌注。项目资源字段与周省治理指标缺失时必须显示未知，不得换算为0。`observationDays < 14`或五项指标不全时只能显示“继续观测”；达到门槛后才显示保留、简化或停止建议，且不得产生任何TaskBox写入。

本地4173端口已被占用时，选择其他未占用端口（例如`npm run preview -- --port 4178`），不要把其他本地站点误认为本项目。

2026-08-23 P5–P6 已完成生产发布：PR #12 合并提交`4237b97`，Pages工作流`32634346744`成功，线上Build ID`8956dbc8f134`；全量测试、周期桥接、线上分块及1440px/390×844验收通过，无横向溢出或warning/error。本轮没有API/schema运行时变更，服务器无需重新部署。

2026-08-07 已完成 P0 全链路：此前通过的完成后不回显、取消完成恢复、跨来源删除/本地缓存收敛、3.5 秒弱网跨路由防覆盖和离线 outbox 重放均保持有效；服务端`primaryTaskId: null`修复已发布生产。服务器发布由临时 GitHub 托管 Runner 完成，因为当前执行环境仍被源站入站规则过滤，而 Runner 到 22/8090/80/443 可达。发布前停止`taskbox-api.service`并备份代码与 SQLite/WAL/SHM，恢复点为`/opt/taskbox-api/backups/p0-null-clear-20260807T060141Z`；服务端 schema 与 HQ 集成测试、systemd active 检查全部通过。线上验收为认证健康 200、未认证 401、生产 Origin 预检 204、清空读回`null`且原 brief 恢复成功。

2026-08-09 已完成 P1 生产收尾：前端/桥接全量测试、API schema/HQ 集成测试通过，`npm run build` 生成 Build ID `b96ffcdfc533`，`git diff --check` 仅报告既存 LF/CRLF warning。API 发布后认证健康为 200、未认证为 401、生产 Origin 预检为 204，线上 HQ 字段探针确认`primaryTaskId`与`currentActionTaskId`同时存在，`taskbox-api.service`保持 active。P1 回滚点为`/opt/taskbox-api/backups/p1-action-seat-20260809T022214Z`；P0 回滚点继续保留。

2026-08-09 P2 已完成生产发布：候选专项、全量`npm test`、API schema/HQ/候选 syncKey 幂等与`npm run build`通过。浏览器完成原始承诺、战略战果、候选跳过、冷却空状态、排序、确认接棒，以及“无下一步主线→原生候选→双击确认→重要盒仅一条任务→项目恢复推进中”；390px/1440px 无横向溢出，控制台无错误。缓存回归覆盖“部分更新保留承诺、显式 null 仍清空”。Pages 工作流`31292056719`成功，生产`service-worker.js`为 Build ID`a485fa88a115`，入口为`assets/app-EXZBL2NR.js`；生产分块命中`hq-candidate:`、`candidateDedupeKey`、`主线系统信号`和`currentActionTaskId`。API 认证健康`200`、未认证`401`、生产 Origin 预检`204`，`taskbox-api.service`保持 active；P2 没有 API 运行代码发布，服务端继续使用 P1 回滚点。

2026-08-09 P3 已完成生产发布：`npm run test:hq-systems`验证接入等级、未知/过期状态、主线行动门槛、P2 候选数量一致性和完整闭环状态；全量`npm test`与`npm run build`通过。浏览器在 1440px/390px 验证六张接入卡、L0/L1/L2 图例、主线八字段契约、只读权限、五段闭环、进入项目中心跳转和无横向溢出，控制台无错误。Pages 工作流`31302177865`首轮构建成功但因旧部署并发锁拒绝 deploy，attempt 2 成功；生产 Build ID 为`dca5c12098ba`，入口为`assets/app-VLRUGPBP.js`，样式为`assets/style-VA4J23EG.css`，生产分块命中`SYSTEM CONTRACT`、`L1 只读`、`/v1/hq/today.projects`、`blocked`、`needs_action`、`READ-ONLY LOOP`与`状态未知`。现有 API 未认证健康`401`、生产 Origin 预检`204`；P3 没有 API 运行代码或 schema 变更，服务端未重新部署。

2026-08-10 P4已完成生产发布：Pages工作流`31324155726`发布Build ID`1962464071d3`；API生产探针通过认证`200`、未认证`401`、CORS`204`、proposal状态机和服务检查。服务器回滚点为`/opt/taskbox-api/backups/p4-review-proposals-20260809T170701Z`。

2026-08-11 五系统 V3 会话 G 已本地完成 B–F 统一集成和最终联合验收：`npm test`、反馈 Python 专项、Gate 0–3 组合合同、B–F 联合合同与 `npm run build`通过，Build ID 为 `eb3cac0b27a2`。独立端口 `4317` 的 1440px/390×844 六页面、固定入口、五张接入卡、返回、使命候选/二次批准、健康候选审计/隐私、时间日期确认非事实、执行 shadow draft 不晋升、反馈四 JSONL 幂等导入和明确授权激活验收通过，页面控制台无 warning/error。该增量未提交、未推送或部署；生产版本与 P4 API/schema 状态不变。完整交接见 `docs/v3-five-system-final-acceptance.md`。

2026-08-12 五系统V3已正式发布：五个系统通过独立HQ端口耦合人生参谋部，执行系统成为同级L2系统，TaskBox保留为唯一任务/完成事实引擎。全量测试、Build ID`6ee91e341ff7`、1280px与390×844六页面验收通过；PR #1合并提交`4cc2ae5`，Pages工作流`31556529819`成功，线上`service-worker.js`命中`taskbox-dist-6ee91e341ff7`。

2026-08-13 日省候选五系统消费层完成生产闭环。API发布脚本生成回滚点`/opt/taskbox-api/backups/system-candidates-20260812T163954Z`；生产探针为认证`200`、未认证`401`、CORS`204`、候选路由`200`。2026-08-11 outbox首次写入`created=3`，连续重放均为`unchanged=3`；SQLite内使命1条、执行2条，其余系统0条，五个`systemId`读取均通过隔离检查，`taskbox-api.service`保持active。部署脚本在systemd启动后最多等待10秒，只有认证健康接口就绪才报告成功，避免Node尚未绑定端口时的启动竞态误报。

2026-08-13 五系统可回退V1历史基线由PR #7完成生产发布：合并提交`47624b3`，Pages工作流`31660897657`成功，线上Build ID`0edb9e215060`。该发布只改变前端与浏览器localStorage协议，不重启API服务。

2026-08-13 自动基线链由PR #8完成生产发布：合并提交`7a9c536`，Pages工作流`31712549246`成功，线上Build ID`56ce0c452a92`。私有包部署于服务器Git外受限目录；认证基线接口200、未认证401，`taskbox-api.service` active，回滚点`/opt/taskbox-api/backups/system-candidates-20260813T145401Z`。

### 任务中枢桥接验证

桥接脚本位于`D:\note_new\06-日常输入_输出\.agents\skills\任务中枢\scripts\task_hub_bridge.py`。先使用`--dry-run`验证认证、盒子匹配和任务字段，不产生远端测试记录：

```powershell
python "D:\note_new\06-日常输入_输出\.agents\skills\任务中枢\scripts\task_hub_bridge.py" `
  --content "任务中枢桥接验证" --date 2026-08-01 --execution-mode ai --dry-run
```

预期 JSON：`ok=true`，并返回`action / taskId / boxId / boxName / executionMode`。系统默认 Python 不可用时，使用 Codex bundled Python 执行同一脚本。正式写入必须先获得用户对任务清单的确认，并移除`--dry-run`；唯一主动作或维护动作再追加`--hq-role primary|maintenance`。

## 故障检查

- 页面一直加载：先检查 Pages 静态资源与 Service Worker 缓存版本，再检查 `/health` 和浏览器 Network。
- 拉取 `401`：检查浏览器保存的 API Token 是否对应服务器当前值；不要把 Token 发到 URL 或日志。
- 拉取失败但本地仍有数据：保留 localStorage，不要清站点数据；恢复 API 后主动拉取或触发下一次写入。
- HQ 显示“待同步”：不要清除站点数据；恢复连接后点击刷新，确认 outbox 归零且服务端记录已更新。outbox 未清空时整库拉取会主动停止，这是防覆盖机制。
- HQ 显示“数据未知”：检查最近 API 错误、Token 和网络；在拿到新远端事实前，不把本地项目/子系统状态解释为云端健康。
- 修改后出现重复：检查客户端记录 ID、服务端 `POST` 幂等逻辑和周期任务 `recurrenceKey` 唯一性。
- 页面显示旧内容：确认新构建已发布、Service Worker 缓存名已更新，并做一次强制刷新。
- 参谋部只显示本地快照：检查浏览器 API Token、`/v1/hq/today` 状态码和服务器是否已执行最新 `schema.sql`。
- 外部 API 已删除或替换任务但浏览器仍显示旧记录：先确认线上前端包含云端 tombstone 权威合并修复，再主动拉取`/v1/taskbox`；核对同一`id / syncKey / recurrenceKey`只保留云端版本，且本地独有离线任务没有被误删。
- 日省事实包没有生成：运行`fetch_daily_review_context.py --date YYYY-MM-DD`，检查私有 Token 文件或`TASKBOX_API_TOKEN`，并确认 API Origin 配置。
- 日省没有派发到盒子：检查本机私有 Token 文件或`TASKBOX_API_TOKEN`，并单独运行 `sync_daily_review_to_hq.py` 查看不含凭据的 JSON 结果。
- 周省/月省没有进入参谋部：先运行`fetch_period_review_context.py`核对周期键，再运行对应`sync_weekly_review_to_hq.py`或`sync_monthly_review_to_hq.py`。
- proposal 同步返回 404：生产 API 可能被回滚到 P4 之前或反向代理未指向当前服务；检查`/v1/hq/proposals`路由、`hq_proposals`表和当前部署版本，不要绕过提案直接创建任务。
- 五系统候选同步返回 404：生产服务可能回滚到2026-08-13候选API发布之前；保留`five-system-candidate-outbox`，检查`system_candidates`表、三条候选路由和反向代理，再重放；不得把候选改走 TaskBox 或 proposal 以绕过收件箱。
- 使命同步返回404：生产API尚未包含`/v1/mission/state`和`/v1/mission/sync`；保留`taskbox_mission_os_v1`与`taskbox_mission_sync_v1`，先完成API发布再刷新，不要清浏览器数据。
- 使命同步返回409：表示云端revision已变化；Beta会保留本地outbox并停止云端覆盖。先分别导出本地和云端版本核对，再由使命系统总部裁决；不得强行把`expectedRevision`改成云端值绕过冲突。
- promote 返回`proposal_promotion_disabled`：确认提案已批准、类型为日省动作、请求显式`shadowMode=false`，再检查服务器`HQ_PROPOSAL_PROMOTION_ENABLED=1`；周/月提案永远不走 TaskBox promotion。
- 任务中枢返回`TASKBOX_API_TOKEN_missing`：检查`TASKBOX_API_TOKEN`、`TASKBOX_API_TOKEN_FILE`或`~/.codex/secrets/taskbox-api-token`，不把 Token 粘贴进命令历史或文档。
- 任务中枢返回`box_not_found / mainline_not_found / branch_not_found`：先用`GET /v1/taskbox`核对真实名称或 ID，再重跑；不要猜测归属。
- 执行系统返回`execution_api_disabled`：检查即时停用文件；先完成故障调查，不要删除 Token 或切换到通用 API 绕过。
- 执行系统返回`task_revision_conflict`：重新读取 Task 与 ETag；同字段已有用户修改时停止并交回裁决，禁止强制覆盖。
- 执行系统返回`possible_duplicate_task`：复用返回的真实 Task ID 或交 HQ 查重，不得换幂等键重复创建。
- Assistant Gateway 返回`proposal_revision_conflict`：停止当前回复，不得改用通用 HQ 接口；重新读取提案并让用户针对新 revision 重新确认。
- Assistant Gateway 返回`reply_expired`：保留 Notification Hub 原始回执和引用，重新向用户发起确认；不得重写`receivedAt`绕过有效期。
- 任务中枢返回`skipped_duplicate`：目标日期和盒子中已有同内容任务，属于幂等成功，不再创建副本。

## 回滚

- 前端：把 `main` 回到已验证标签并重新触发 Pages 工作流，不要直接删除线上文件。
- API：恢复上一版代码后运行兼容的初始化脚本；除非已经验证迁移不可逆，否则不要回滚数据库结构。
- 使命Beta生产回滚点：`/opt/taskbox-api/backups/system-candidates-20260823T094954Z`。代码回滚默认保留新增使命表；只有确认必须恢复整库时才设置`RESTORE_TASKBOX_DATABASE=1`，避免覆盖部署后的TaskBox事实。
- 数据：从发布前备份恢复到新文件，先只读验证记录数和关键对象，再切换服务。

2026-07-15 可用恢复点包括 Git 标签 `stable-pre-mainlines-2026-07-15`、本地备份 `backups/box-app-stable-box-types-2026-07-15.zip`，以及服务器发布前备份目录。恢复时以实际存在且校验通过的文件为准。

2026-08-23 健康页收件箱收敛：明确用户日省健康事实应检查 `/v1/health/observations` 是否按 `observationId` 幂等入库；健康页的“健康事实待确认”只处理外部、历史、日期不明或未验证材料。日省候选传输故障不影响健康主体独立运行。

2026-09-03 Assistant Gateway 提案回复接口已生产发布：PR #18 合并提交`b4c9549`，API workflow `33753867348`与Pages workflow `33753833765`成功。生产验证为认证健康`200`、未认证和通用Token访问回复路由`401`、CORS`204`；发布流程使用独立最小scope身份对不存在提案执行`404`认证探针，没有制造真实审批或TaskBox写入。回滚点为`/opt/taskbox-api/backups/execution-system-20260903T121234Z`，即时停用文件为`/etc/taskbox-assistant-gateway.disabled`。

### HQ 协作收件箱验收

1. 当次日 brief 存在停止做/继续保持时，今日页在今日行为区之后显示“今晚复盘生成的明日规则”，并标明来源日期；今日 brief 不被改写。
2. 五系统卡必须区分无数据、候选待处理、正式正常、过期和异常，不再把所有空状态显示成同一种空白。
3. 协作收件箱只列需要用户提供的字段、原因和回答方向；候选本身只提示进入对应系统处理。
4. 周/月页展示五系统输入就绪度；缺少系统保持 unknown，不触发重新计算。
5. 运行 `npm run test:hq-collaboration`、`npm test` 和 `npm run build`，并检查 1440px 与 390px 无横向溢出。
