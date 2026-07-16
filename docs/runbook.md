# TaskBox 运维手册

最后核对：2026-07-16。

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

## 故障检查

- 页面一直加载：先检查 Pages 静态资源与 Service Worker 缓存版本，再检查 `/health` 和浏览器 Network。
- 拉取 `401`：检查浏览器保存的 API Token 是否对应服务器当前值；不要把 Token 发到 URL 或日志。
- 拉取失败但本地仍有数据：保留 localStorage，不要清站点数据；恢复 API 后主动拉取或触发下一次写入。
- 修改后出现重复：检查客户端记录 ID、服务端 `POST` 幂等逻辑和周期任务 `recurrenceKey` 唯一性。
- 页面显示旧内容：确认新构建已发布、Service Worker 缓存名已更新，并做一次强制刷新。

## 回滚

- 前端：把 `main` 回到已验证标签并重新触发 Pages 工作流，不要直接删除线上文件。
- API：恢复上一版代码后运行兼容的初始化脚本；除非已经验证迁移不可逆，否则不要回滚数据库结构。
- 数据：从发布前备份恢复到新文件，先只读验证记录数和关键对象，再切换服务。

2026-07-15 可用恢复点包括 Git 标签 `stable-pre-mainlines-2026-07-15`、本地备份 `backups/box-app-stable-box-types-2026-07-15.zip`，以及服务器发布前备份目录。恢复时以实际存在且校验通过的文件为准。
