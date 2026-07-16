# TaskBox 架构

最后核对：2026-07-16。

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
- `js/db.js`: 盒子、任务、主线、里程碑、设置、本地缓存和同步队列。
- `js/home.js`: 首页、日期视图、盒子墙和主线概览。
- `js/box-detail.js`: 三类盒子的详情、编辑、右键菜单、完成/删除/还原。
- `js/recurrence.js`、`js/recurrence-ui.js`: 周期规则计算和编辑控件。
- `js/task-visibility.js`: 设备场景识别、任务释放时间、今天收工和编辑器设备控件。
- `js/points-store.js`: 积分账户、奖励、流水和任务完成对账。
- `js/small-world.js`: 珍宝阁、弑神塔和转盘入口。
- `js/mainline-page.js`: 主线、里程碑和关联任务页面。
- `scripts/build-app.mjs`: JavaScript/CSS 压缩、哈希、Service Worker 生成和 `dist/` 组装。

## 同步模型

1. 应用启动先读取本地缓存，确保首屏不等待网络。
2. 存在 API Token 时拉取 `/v1/taskbox`、`/v1/points` 和小世界记录。
3. 远端快照先标准化，再按记录 ID 与本地待同步数据合并。
4. 本地 CRUD 立即更新 UI 和 localStorage，并把单条 `POST`、`PATCH` 或 `DELETE` 加入串行队列。
5. 请求成功后清理对应待同步标记；失败保留本地状态，下一次写入或主动拉取继续处理。
6. `contentFingerprint` 只比较业务内容，避免 `updatedAt` 等噪声触发虚假的“Cloud synced”。

所有新增记录必须在客户端生成稳定 ID。服务端 `POST` 对同 ID 采用幂等更新，周期任务通过 `recurrenceKey` 额外防止重复实例。

## 数据表

| 表 | 记录粒度 |
| --- | --- |
| `app_meta` | 设置、每日一句等应用元数据 |
| `boxes` | 单个盒子及类型配置 |
| `tasks` | 单个任务、池项目、清单项或周期模板/实例；设备、释放时间、暂存状态和进度日志使用独立列 |
| `mainlines` | 单条主线 |
| `milestones` | 单个主线里程碑 |
| `usage_logs` | 放松池等项目的一次使用记录 |
| `points_account` | 积分账户配置 |
| `points_rules` | 积分规则和默认值 |
| `points_rewards` | 单个奖励 |
| `points_transactions` | 单笔积分流水 |
| `sw_floors` | 小世界单层元数据 |
| `sw_items` | 小世界单条内容 |

业务字段有独立列便于查询和索引，同时保留 `raw_json` 兼容尚未拆列的前端字段。数据库定义位于 `server/taskbox-api/schema.sql`，启动和导入脚本会为旧库补列。

任务可见性统一由 `visibleAfter` 判断。手动“今天收工”同时写入 `deferredAt`、`deferNote` 和 `progressLogs`；周期实例只写入规则计算出的 `visibleAfter`，因此 UI 能分别展示“今日已收工”和“待到点出现”。`deviceContext` 只影响排序和分组，不能代替可见性或删除状态。

## API

基地址：`/taskbox-api/v1`。除 CORS 预检外，业务请求均需要 Bearer Token。

- 快照：`GET /taskbox`、`GET /points`。
- 盒子：`POST /boxes`、`PATCH /boxes/:id`、`DELETE /boxes/:id`。
- 任务：`POST /tasks`、`PATCH /tasks/:id`、`DELETE /tasks/:id`。
- 主线：`POST /mainlines`、`PATCH /mainlines/:id`、`DELETE /mainlines/:id`。
- 里程碑：`POST /milestones`、`PATCH /milestones/:id`、`DELETE /milestones/:id`。
- 每日一句：`GET /daily-quote`、`PATCH /daily-quote`。
- 积分：流水和奖励的记录级新增/修改接口。
- 小世界：`GET /smallworld/:realm` 与记录级 items CRUD。

## 安全边界

- API 只监听 `127.0.0.1`，由 Nginx 提供 HTTPS 和公开路径。
- Token 存储在服务器环境文件和浏览器 localStorage，不进入源码、构建产物或仓库。
- CORS 只允许生产站点和明确的本地调试 Origin。
- GitHub Pages 只能保护源码组织方式，不能让浏览器端业务逻辑真正保密；关键校验和密钥必须留在服务端。
