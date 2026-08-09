# TaskBox 运维手册

最后核对：2026-08-09。

## 本地验证

```powershell
npm ci
npm test
npm run build
npm run preview
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
12. 完成一条带备注的测试任务，确认回执自动打开、备注完整、长内容可多页、已完成列表可再次打开；手机支持时用系统分享图片，其他浏览器回退为 PNG 保存。
13. 把一条临时任务设为当日主动作，在盒子完成后立即切回参谋部；本地卡片应立即退出，远端刷新后不得回闪或重新占位。随后主动取消完成并再次刷新，确认较新的未完成版本可以正常恢复。弱网测试时还应确认离开`#hq`后，较早发出的 HQ 请求不会覆盖盒子或其他页面。

2026-08-07 已完成 P0 全链路：此前通过的完成后不回显、取消完成恢复、跨来源删除/本地缓存收敛、3.5 秒弱网跨路由防覆盖和离线 outbox 重放均保持有效；服务端`primaryTaskId: null`修复已发布生产。服务器发布由临时 GitHub 托管 Runner 完成，因为当前执行环境仍被源站入站规则过滤，而 Runner 到 22/8090/80/443 可达。发布前停止`taskbox-api.service`并备份代码与 SQLite/WAL/SHM，恢复点为`/opt/taskbox-api/backups/p0-null-clear-20260807T060141Z`；服务端 schema 与 HQ 集成测试、systemd active 检查全部通过。线上验收为认证健康 200、未认证 401、生产 Origin 预检 204、清空读回`null`且原 brief 恢复成功。

2026-08-09 已完成 P1 生产收尾：前端/桥接全量测试、API schema/HQ 集成测试通过，`npm run build` 生成 Build ID `b96ffcdfc533`，`git diff --check` 仅报告既存 LF/CRLF warning。API 发布后认证健康为 200、未认证为 401、生产 Origin 预检为 204，线上 HQ 字段探针确认`primaryTaskId`与`currentActionTaskId`同时存在，`taskbox-api.service`保持 active。P1 回滚点为`/opt/taskbox-api/backups/p1-action-seat-20260809T022214Z`；P0 回滚点继续保留。

2026-08-09 P2 发布候选：候选专项、全量`npm test`、API schema/HQ/候选 syncKey 幂等与`npm run build`通过，Build ID 为`a485fa88a115`。浏览器完成原始承诺、战略战果、候选跳过、冷却空状态、排序、确认接棒，以及“无下一步主线→原生候选→双击确认→重要盒仅一条任务→项目恢复推进中”；390px/1440px 无横向溢出，控制台无错误。缓存回归覆盖“部分更新保留承诺、显式 null 仍清空”。发布后应核对 Pages Build ID、候选资源字符串和 API 健康状态。

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
- 任务中枢返回`TASKBOX_API_TOKEN_missing`：检查`TASKBOX_API_TOKEN`、`TASKBOX_API_TOKEN_FILE`或`~/.codex/secrets/taskbox-api-token`，不把 Token 粘贴进命令历史或文档。
- 任务中枢返回`box_not_found / mainline_not_found / branch_not_found`：先用`GET /v1/taskbox`核对真实名称或 ID，再重跑；不要猜测归属。
- 任务中枢返回`skipped_duplicate`：目标日期和盒子中已有同内容任务，属于幂等成功，不再创建副本。

## 回滚

- 前端：把 `main` 回到已验证标签并重新触发 Pages 工作流，不要直接删除线上文件。
- API：恢复上一版代码后运行兼容的初始化脚本；除非已经验证迁移不可逆，否则不要回滚数据库结构。
- 数据：从发布前备份恢复到新文件，先只读验证记录数和关键对象，再切换服务。

2026-07-15 可用恢复点包括 Git 标签 `stable-pre-mainlines-2026-07-15`、本地备份 `backups/box-app-stable-box-types-2026-07-15.zip`，以及服务器发布前备份目录。恢复时以实际存在且校验通过的文件为准。
