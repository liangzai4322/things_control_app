# TaskBox / things_control_app

TaskBox 是一个本地静态 Web 应用，用来做游戏化任务管理、积分、抽奖转盘和“小世界”奖励/挑战池。这个目录也放了一些内容导出脚本，用于把 SCYS、ZSXQ、飞书等来源整理成 Markdown 或 JSON 产物。

## 本地运行

这个项目没有 `package.json`，前端入口是 `index.html`，核心代码是原生 ES module。因为应用会 `fetch` 本地 JSON，并注册 `service-worker.js`，建议通过静态服务器打开：

```powershell
python -m http.server 8000
```

然后访问 `http://localhost:8000/`。主要入口文件：

- `index.html`: PWA 壳和 `js/app.js` 入口。
- `css/style.css`: 全局界面样式。
- `js/`: 任务墙、盒子详情、积分、AI 提取、设置和“小世界”等功能模块。
- `data/`: “小世界”奖励池和挑战塔数据。
- `assets/`: 图标、图片、音效占位说明。
- `service-worker.js`: App shell 和静态资源缓存。

## 内容导出脚本

`scripts/` 里是本地内容处理脚本，常见产物放在 `outputs/`。运行这些脚本前，优先确认输出目录，避免把不同批次混在一起。

### 飞书导出策略（2026-05-10 起）

- 直接导出飞书 `docs/docx/wiki` 链接时，优先使用官方 CLI skill：`C:\Users\86180\.codex\skills\feishu-cli-markdown-export`。
- 现代 `docx/wiki` 链路调用 `lark-cli.cmd docs +fetch --api-version v2 --doc-format markdown`，比浏览器扩展更稳定，也更适合批量任务。
- 2026-05-19 起，老式 `/docs/` 链接也由 CLI skill 优先处理：脚本调用 `lark-cli.cmd drive +export --doc-type doc --file-extension docx` 导出 DOCX 到 `legacy_docx/`，再通过 `python-docx` 本地转换为 Markdown。
- Windows 下优先使用 `lark-cli.cmd`，不要直接用 `lark-cli`，否则容易撞到 PowerShell execution policy。
- 2026-05-11 已修补 `feishu-cli-markdown-export` 的 Windows 启动兼容性：Node 24 直接 `execFile` 本机 `.cmd` shim 可能报 `spawn EINVAL`，脚本现在会对 `.cmd` / `.bat` 启用 shell 启动；保留这个兼容逻辑。
- 如果 CLI 授权失效，先重新执行：
  - `lark-cli.cmd config init --new`
  - `lark-cli.cmd auth login --domain docs,wiki,drive`
  - `lark-cli.cmd auth status`
- 浏览器扩展 skill `C:\Users\86180\.codex\skills\feishu-batch-markdown-export` 仍然保留，作为 CLI 未授权、权限不足、导出失败或必须依赖网页渲染视图时的兜底方案；不要仅因为链接是老式 `/docs/` 就直接切到扩展。
- 截至 2026-05-21，`C:\Users\86180\.codex\skills\scys-fulltext-markdown-export` 的飞书分支也是 CLI 优先，CLI 不可用或导出失败时再回退浏览器扩展。

### ZSXQ 2022-04 至 2022-05 老式 /docs/ 飞书回填修复（2026-05-19）

2026-05-19 用新版 Feishu CLI legacy `/docs/` fallback 重跑了 2022-04 与 2022-05 的飞书导出，并重新回填到源 topic Markdown 后刷新 `final_merged_articles.md`。

- `outputs/zsxq-1824528822-2022-05/`：9 条旧 `/docs/`，成功回填 4 条，5 条因权限或导出失败进入 `failed_feishu_links_after_two_attempts.*`。
- `outputs/zsxq-1824528822-2022-04/`：3 条旧 `/docs/`，成功回填 2 条，1 条因权限失败进入 `failed_feishu_links_after_two_attempts.*`。
- 如存在首轮导出加重试导出，回填时优先使用 `feishu_cli_manifest_combined.json`，避免已成功的重试结果没有写回文章 Markdown。

### ZSXQ 2020-12 项目案例

2026-04-30 已完成一次 ZSXQ 小组 `1824528822` 的 2020 年 12 月精华帖导出，产物位于：

```text
outputs/zsxq-1824528822-2020-12/
```

本次结果：

- `summary.json`: 抓取摘要。共 90 条主题，5 页，详情页失败 0 条，飞书链接 0 条。
- `topics_normalized.json` / `topics_normalized.md`: 已补详情页后的标准化全集。
- `filtered_project_cases.json` / `filtered_project_cases.md`: 手动筛选后保留的 60 条项目案例。
- `excluded_non_project.json` / `excluded_non_project.md`: 剔除的 30 条通知、招募、榜单、见面会、纯认知/投资/社交/管理类内容。
- `project_cases_md/`: 一个项目一个 Markdown 文件，另有 `00_index.md` 和 `manifest.json`。
- `feishu_links.json`: 本批次没有发现飞书 docx/wiki 链接，内容为 `{"feishuRows":[]}`。

筛选口径：保留项目案例、实操复盘、赚钱/增长/运营项目拆解；剔除通知、招募、榜单、见面会安排、纯认知/投资/社交/管理类内容。

有 11 条保留项标记了 `needs_external_article=true`，表示星球详情里出现外部长文入口。2020-12 批次按用户当时的要求未做二层长文补采，所以该批次 Markdown 只保留已抓到的 topic 正文、摘要和链接；如需长文正文，可用 2026-05-01 新增的全局 skill 重新导出该月份。

### ZSXQ 2020-11 精华帖

2026-05-01 已完成 ZSXQ 小组 `1824528822` 的 2020 年 11 月精华帖导出，产物位于：

```text
outputs/zsxq-1824528822-2020-11/
```

本次结果：

- `summary.json`: 抓取摘要。共 99 条主题，5 页，topic 详情页失败 0 条，飞书链接 0 条。
- `topics_normalized.json` / `topics_normalized.md`: 已补 topic 详情页后的标准化全集。
- `articles_normalized.json` / `articles_normalized.md`: `articles.zsxq.com/id_*.html` 二层长文正文合集。共发现 13 个长文链接，成功补采 12 篇。
- `article_failures.json`: 1 篇二层长文失败，rank 83《最近被职业打假人打假了，做的产品是初级农产品》对应页面返回“该文章不存在或已被删除”。
- `topics_md/`: 一个 topic 一个 Markdown 文件，另有 `00_index.md` 和 `manifest.json`；成功补采的二层长文已写入对应文件的 `External Article Details` 章节。

2020 年 11 月批次未做“只保留项目案例”的人工筛选，`topics_md/00_index.md` 保留完整精华帖索引。

### ZSXQ 2021-12 精华帖与飞书导出

2026-05-02 已完成 ZSXQ 小组 `1824528822` 的 2021 年 12 月精华帖导出，产物位于：

```text
outputs/zsxq-1824528822-2021-12/
```

本次结果：

- `summary.json`: 抓取摘要。共 68 条主题，4 页，topic 详情页失败 0 条。
- `topics_normalized.json` / `topics_normalized.md`: 已补 topic 详情页后的标准化全集。
- `articles_normalized.json` / `articles_normalized.md`: 已识别 `/v2/topics/{topic_id}` 详情中的 `talk.article.article_url`，共补采 33 篇 `articles.zsxq.com/id_*.html` 长文，失败 0 篇。
- `topics_md/`: 一个 topic 一个 Markdown 文件，另有 `00_index.md` 和 `manifest.json`；补采的长文已写入对应文件的 `External Article Details` 章节。
- `feishu_links.json`: 从 topic 正文和补采长文正文中提取到 21 条有效飞书链接，其中 20 条为老式 `/docs/`，1 条为 `/docx/`。
- `feishu_export/`: 已调用飞书导出 skill。`summary.json` 显示 21 条输入中 3 条新导出成功、1 条复用既有导出、17 条失败；成功文件在 `feishu_export/feishu_markdown/`，合集在 `feishu_export/merged_feishu.md`，失败清单在 `feishu_export/failed_feishu_links.md`。

飞书导出失败的主要原因是老式 `/docs/` 页面没有触发 Cloud Document Converter 扩展的 popup，少数链接出现 `ERR_CONNECTION_RESET`；失败链接已保留来源文章和错误原因。历史说明：该批次在 2026-05-19 之前使用浏览器扩展处理老式 `/docs/`，失败多因 popup 未触发。2026-05-19 起应优先用 Feishu CLI skill 的 legacy `/docs/` fallback 重跑；若 Drive export 返回 no permission，则保留失败清单。

### ZSXQ 2024-11 至 2024-12 精华帖、项目筛选与 Feishu CLI 回填

2026-05-13 已完成 ZSXQ 小组 `1824528822` 的 2024 年 11 月和 12 月精华帖导出、人工项目筛选、Feishu CLI 导出、飞书正文回填、小文件复查和最终合并。每个月分别落盘到独立目录：

```text
outputs/zsxq-1824528822-2024-11/
outputs/zsxq-1824528822-2024-12/
```

统一输出形态：

- `summary.json`: ZSXQ 抓取、详情页和 `articles.zsxq.com` 二层正文补采摘要。
- `filter_decisions.json`: 人工筛选决策；保留项目案例、变现复盘、平台打法、工具工作流和可执行教程，剔除营销、公告、招募、榜单、活动、纯心法和非项目行政攻略。
- `topics_filtered_valid.json` / `topics_rejected_invalid.json`: 保留和剔除清单。
- `topics_rejected_invalid_links.md` / `.json`: 单独保存被过滤帖的标题、ZSXQ 链接和剔除原因，便于人工复核。
- `feishu_links_filtered_valid.json`: 只来自保留文章的首个飞书链接输入。
- `feishu_cli_export_filtered_valid/`: 官方 Feishu CLI 导出的飞书 Markdown、manifest、summary 和失败清单。
- `topics_filtered_valid_with_feishu_md/`: 已将成功导出的飞书正文回填到源文章后的 Markdown 目录。
- `small_article_review.json` / `.md`: 小于 3 KB 文章复查结果。
- `final_merged_articles.md`: 基于回填后 Markdown 生成的最终合并文档。

批次结果：

- 2024-12：原始 101 篇，保留 74 篇，剔除 27 篇；详情页 101 成功 / 0 失败，二层正文 19 成功 / 0 失败；Feishu CLI 63 成功 / 0 失败，回填 63；短文复查 3 个，无待处理项。
- 2024-11：原始 90 篇，保留 67 篇，剔除 23 篇；详情页 90 成功 / 0 失败，二层正文 24 成功 / 0 失败；Feishu CLI 54 成功 / 1 失败，唯一失败链接第二次仍为无权限，已停止重试并保留到失败清单；回填 54；短文复查 2 个，无待处理项。

这两个批次使用 2026-05-13 更新后的详情页访问节奏：ZSXQ `/v2/topics/{topic_id}` 详情请求按 `--detail-delay-ms 900 --detail-jitter-ms 1400` 限速，仅影响知识星球详情页补采，不降低 Feishu CLI 导出速度。批次结束时已确认输出文件中未写入 `ZSXQ_COOKIE`、`zsxq_access_token` 或浏览器原始 cookie，临时 `ZSXQ_COOKIE` 已清理。

### ZSXQ 2025-06 至 2025-09 精华帖、项目筛选与 Feishu CLI 回填

2026-05-11 已完成 ZSXQ 小组 `1824528822` 的 2025 年 6 月、7 月、8 月、9 月精华帖导出、人工项目筛选、Feishu CLI 导出、飞书正文回填、小文件复查和最终合并。每个月分别落盘到独立目录：

```text
outputs/zsxq-1824528822-2025-06/
outputs/zsxq-1824528822-2025-07/
outputs/zsxq-1824528822-2025-08/
outputs/zsxq-1824528822-2025-09/
```

统一输出形态：
- `summary.json`: ZSXQ 抓取、详情页和 `articles.zsxq.com` 二层正文补采摘要。
- `filter_decisions.json`: 人工筛选决策；保留项目案例、变现复盘、平台打法、工具工作流和可执行教程，剔除营销、公告、招募、榜单、活动、纯心法和非项目行政攻略。
- `topics_filtered_valid.json` / `topics_rejected_invalid.json`: 保留和剔除清单。
- `topics_rejected_invalid_links.md` / `.json`: 单独保存被过滤帖的标题、ZSXQ 链接和剔除原因，便于人工复核。
- `feishu_links_filtered_valid.json`: 只来自保留文章的首个飞书链接输入。
- `feishu_cli_export_filtered_valid/`: 官方 Feishu CLI 导出的飞书 Markdown、manifest、summary 和失败清单。
- `topics_filtered_valid_with_feishu_md/`: 已将成功导出的飞书正文回填到源文章后的 Markdown 目录。
- `small_article_review.json` / `.md`: 小于 3 KB 文章复查结果。
- `final_merged_articles.md`: 基于回填后的 Markdown 生成的最终合并文档。

批次结果：
- 2025-09：原始 109 篇，保留 79 篇，剔除 30 篇；详情页 109 成功 / 0 失败，二层正文 34 成功 / 0 失败；飞书 CLI 72 成功 / 0 失败，回填 72，短文复查 0 个待处理。
- 2025-08：原始 125 篇，保留 100 篇，剔除 25 篇；详情页 125 成功 / 0 失败，二层正文 46 成功 / 0 失败；飞书 CLI 86 成功 / 1 失败，失败链接第二次仍为无权限，已停止重试并保留到失败清单；回填 86，短文复查 1 个但已按二次失败规则闭环。
- 2025-07：原始 134 篇，保留 103 篇，剔除 31 篇；详情页 134 成功 / 0 失败，二层正文 32 成功 / 0 失败；飞书 CLI 94 成功 / 0 失败，回填 94；短文复查 1 个，无飞书链接。
- 2025-06：原始 100 篇，保留 79 篇，剔除 21 篇；详情页 100 成功 / 0 失败，二层正文 29 成功 / 0 失败；飞书 CLI 72 成功 / 1 失败，失败链接第二次仍为文档不存在，已停止重试并保留到失败清单；回填有效 72，短文复查 1 个但已按二次失败规则闭环。

这四个批次均已确认：导出文件中未写入 `ZSXQ_COOKIE`、`zsxq_access_token` 或浏览器原始 cookie；任务结束时临时 `ZSXQ_COOKIE` 已清理。

### ZSXQ 2026-02 精华帖、项目筛选与飞书导出

2026-05-05 已完成 ZSXQ 小组 `1824528822` 的 2026 年 2 月精华帖导出、项目案例筛选和飞书导出，产物位于：

```text
outputs/zsxq-1824528822-2026-02/
```

本次结果：

- `summary.json`: 共 71 条主题，4 页；topic 详情页成功 18 条、失败 53 条；二层 `articles.zsxq.com` 长文发现 15 篇、成功 15 篇、失败 0 篇；首个飞书链接行 47 条。
- `topic_detail_failures.json`: 53 条详情页失败已留档；导出保留列表页 payload 和成功补采到的二层长文正文，不能把失败详情页视为已完整补齐。
- `filter_decisions.json`: 人工筛选决策。保留 61 条项目案例/实操复盘/增长运营案例，剔除 10 条宣传、活动、招募、通知、纯讨论或其他无关项目内容。
- `topics_filtered_valid.json` / `topics_filtered_valid_index.md` / `topics_filtered_valid_md/`: 过滤后保留项及一项目一 Markdown 文件。
- `topics_rejected_invalid.json`: 被过滤掉的无效帖清单。
- `feishu_links_filtered_valid.json`: 过滤后 47 条首个飞书链接。
- `feishu_export_filtered_valid/`: 47 条过滤后飞书链接中 46 条已成功导出，1 条失败；失败链接已达到两次尝试上限，保留在 `failed_feishu_links.md` / `.json`。
- `small_article_review.json` / `.md`: 已回顾 38 个小于 3 KB 的输出，其中 1 个对应飞书链接失败两次，1 个无飞书链接，其余已有成功导出或既有内容。
- `final_merged_articles.md`: 最终汇总 Markdown。

注意：本批次在 2026-05-05 新增“飞书正文必须回填到源文章 Markdown”规则前完成；按用户要求未重跑任务，所以没有生成 `topics_filtered_valid_with_feishu_md/`。当前 `final_merged_articles.md` 已包含导出的飞书合集，但不是逐篇回填到源 topic Markdown 的形态。2026-05-05 起的月份采集必须执行回填脚本生成 enriched Markdown，再基于 enriched Markdown 合并和回顾。

### ZSXQ 2026-03 精华帖与飞书导出

2026-05-04 已完成 ZSXQ 小组 `1824528822` 的 2026 年 3 月精华帖导出，产物位于：

```text
outputs/zsxq-1824528822-2026-03/
```

本次结果：

- `summary.json`: 共 110 条主题，6 页；topic 详情页成功 25 条、失败 85 条；二层 `articles.zsxq.com` 长文发现 32 篇、成功 32 篇、失败 0 篇；首个飞书链接行 81 条。
- `topic_detail_failures.json`: 85 条详情页失败已留档；导出保留列表页 payload 和成功补采到的二层长文正文，不能把失败详情页视为已完整补齐。
- `topics_normalized.json` / `topics_normalized.md`: 标准化全集，包含列表页内容、成功详情页内容和成功补采的二层长文。
- `articles_normalized.json` / `articles_normalized.md`: 二层 ZSXQ 长文正文合集。
- `topics_md/`: 原始 split 目录，含 `00_index.md` 和 `manifest.json`；2026-05-05 检查发现目录实际只有 102 个 topic Markdown，少于 manifest 记录的 110 条。
- `topics_md_regenerated/`: 2026-05-05 从 `topics_normalized.json` 重新生成的完整 split 目录，含 110 个 topic Markdown，另有 `00_index.md` 和 `manifest.json`。
- `feishu_links.json`: 按 2026-05-04 新口径，只保留每篇源文章的第一个飞书链接；其中 57 条来自 topic 正文，24 条来自二层长文正文。
- `feishu_export/`: 调用飞书导出 skill 后，81 条首链中 78 条成功，3 条失败；成功文件在 `feishu_export/feishu_markdown/`，合集在 `feishu_export/merged_feishu.md`，失败清单在 `feishu_export/failed_feishu_links.md` / `.json`。
- `topics_md_with_feishu/`: 2026-05-05 基于 `topics_md_regenerated/` 回填飞书正文后的 enriched 目录。`feishu_backfill_report.json` 显示 81 条飞书输入中 78 条已回填，3 条因原始导出失败跳过，missing 为 0；另有 1 条同一飞书 URL 已在别处成功导出、但又出现在另一个 topic Markdown 中，已通过 existing-export 兜底回填。

本批次按用户当时要求没有继续补 3 条失败飞书链接，也没有递归采集飞书文档里的飞书链接。2026-05-05 已补做飞书正文回填：全量 110 个 topic Markdown 已齐，79 个文件含 `Feishu Document Body`，回填后仍有飞书链接但没有正文的 3 个文件均对应 `failed_feishu_links.*` 中的失败链接。2026-05-05 起的月份采集默认要先筛掉营销/无用帖，补详情页和 `zsxq...html` 正文，导出每篇源文章的第一个飞书链接，失败最多尝试两次，回填成功导出的飞书正文，生成最终合并 Markdown，并回顾小于 3 KB 的文章。

### ZSXQ 2026-04 精华帖、项目筛选与飞书补采

2026-05-03 已完成 ZSXQ 小组 `1824528822` 的 2026 年 4 月精华帖导出、项目案例筛选和部分飞书嵌套链接补采，产物位于：

```text
outputs/zsxq-1824528822-2026-04/
```

本次结果：

- `summary.json`: 共 47 条主题，3 页；topic 详情页成功 9 条、失败 38 条；二层 `articles.zsxq.com` 长文发现 17 篇、成功 17 篇、失败 0 篇；第一层飞书链接 30 条。
- `topic_detail_failures.json`: 38 条详情页失败均为 ZSXQ API 返回主题已删除或不可访问一类结果；导出已保留列表页 payload 和可补到的长文正文，不能把这批详情页视为已完整补齐。
- `topics_normalized.json` / `topics_normalized.md`: 标准化全集，包含列表页内容、成功详情页内容和成功补采的二层长文。
- `topics_md/`: 47 条精华帖一帖一个 Markdown，另有 `00_index.md` 和 `manifest.json`。
- `filter_decisions.json`: 人工筛选决策。保留 32 条项目案例/实操复盘/增长运营案例，剔除 15 条宣传、招募、活动、纯通知或其他无关项目内容。
- `topics_filtered_valid.json` / `topics_filtered_valid_index.md` / `topics_filtered_valid_md/`: 过滤后保留项及一项目一 Markdown 文件。
- `topics_rejected_invalid.json`: 被过滤掉的无效帖清单。
- `feishu_export/`: 第一层 30 条飞书链接已全部成功导出。
- `feishu_links_filtered_valid.json` 与 `feishu_export_filtered_valid/`: 过滤后 24 条飞书链接已复制/汇总为有效项目案例侧的飞书合集。
- `feishu_link_audit_round2.json` / `feishu_links_missing_nested_round2.json`: 从已导出的飞书正文里继续审计出 13 条真实嵌套飞书链接。
- `feishu_export_missing_round2/`: 第二轮嵌套飞书链接补采成功 12 条、失败 1 条；失败原因记录在该目录的 `failed_feishu_links.*`，两次重试仍为连接关闭。
- `feishu_link_audit_after_round2.json`: 第二轮后继续扫描，发现目录型飞书文档里还有大量下钻链接。
- `feishu_links_missing_round3.json`: 第三轮待补采 108 条，已移除一次性 token 类查询参数。
- `feishu_export_missing_round3/feishu_markdown_manifest.partial.json`: 第三轮长任务超时前已成功保留 30 条。
- `feishu_links_missing_round3_remaining.json`: 第三轮剩余 78 条尚未补采。2026-05-04 起采集口径改为“不补采飞书文档里的飞书链接”，所以这些嵌套飞书链接只作为历史审计记录，不要自动继续跑导出任务。
- `feishu_links_unresolved_after_round2.json`: 仍有 1 条飞书链接因网络连接关闭未解决。

本批次的完成状态：ZSXQ 列表页、可访问详情页、二层长文、项目案例筛选、第一层飞书和第二轮嵌套飞书已沉淀；详情页失败和历史嵌套飞书审计结果都已显式留档。2026-05-05 起，采集只导出每篇源文章的第一个飞书链接，不再继续补采飞书文档里的飞书链接。

### 复跑 ZSXQ 抓取

不要复用浏览器复制出来的固定 `x-signature`、`x-timestamp` 或整段 curl；它们会过期。2026-05-01 已将复跑流程沉淀为全局 Codex skill：`C:\Users\86180\.codex\skills\shengcai-zsxq-digest-export`。优先使用该 skill 的脚本，它会为每个请求动态生成 `X-Request-Id`、`X-Timestamp` 和 `X-Signature`，并默认补采 `articles.zsxq.com/id_*.html` 二层长文。2026-05-02 起，脚本同时识别 topic 正文链接和详情页里的 `talk.article.article_url`；2026-05-04 起，流程进一步写硬为“先筛选、再补正文、再导出飞书、最后合并和回顾”；2026-05-05 起，新增硬规则：飞书导出成功后必须先回填到源文章 Markdown，再做最终合并和小文回顾；2026-05-13 起，知识星球详情页补采要使用类正常访问节奏，默认给 `/v2/topics/{topic_id}` 请求加 `--detail-delay-ms 900 --detail-jitter-ms 1400`；2026-05-21 起，月度导出收尾要先完成 Markdown 转换/回填/合并，再只把大于 60 KB 的标题命名单篇文章 Markdown 文件移到 `outputs\太大\` 并写移动清单。

当前硬规则：

- 先抓取目标月份全部精华帖，再筛掉营销、广告、招募、通知、活动、无项目价值内容。
- 过滤阶段必须额外输出 `topics_rejected_invalid_links.md` 和 `topics_rejected_invalid_links.json`，单独保存被过滤帖标题、ZSXQ 链接和剔除原因，不能只依赖 `filter_decisions.json`。
- 对保留帖补 `/v2/topics/{topic_id}` 详情页；详情页请求使用 `--detail-delay-ms 900 --detail-jitter-ms 1400` 或对应环境变量限速，模拟正常访问节奏；若正文里有包含 ZSXQ 域名且以 `.html` 结尾的正文链接，优先补采该正文。
- 基于 topic 正文和补采后的 ZSXQ 正文提取飞书链接；每篇源文章只导出第一个飞书链接。
- 不递归导出飞书文档里的飞书链接。
- 独立飞书导出默认优先走官方 CLI skill；CLI skill 当前支持 `docs/docx/wiki`，其中老式 `/docs/` 通过 Drive export DOCX + 本地转换处理。只有 CLI 不可用、授权过期、权限不足、导出失败或确实需要网页渲染视图时，再退回浏览器扩展 skill。
- 飞书导出失败最多尝试两次；两次失败后停止，保留在 `failed_feishu_links.md` / `.json`。
- 飞书导出成功后必须把飞书正文回填到源文章 Markdown，生成 `topics_filtered_valid_with_feishu_md/` 和 `feishu_backfill_report.json` / `.md`；匹配时用过滤后的飞书输入恢复 `topic_id`，不要只依赖导出 manifest。
- 回填前先核对 split 目录完整性：`manifest.json` 记录数必须和实际 topic Markdown 数一致；如果不一致，从 `topics_normalized.json` 或过滤后的 JSON 重新生成 `*_regenerated/` 后再回填。
- 如果同一个已成功导出的飞书 URL 又出现在另一个源 topic Markdown 中，但因为去重没有出现在该 topic 的飞书输入行里，也要把既有导出的 Markdown 回填到这个额外源文件；这只是回填兜底，不代表可以导出新链接或递归导出飞书正文里的链接。
- 最终必须基于回填后的 Markdown 生成合并 Markdown，并回顾所有小于 3 KB 的文章；若短文里还有未处理的首个飞书链接，再按两次失败上限处理；若飞书已成功导出但短文没有 `Feishu Document Body`，先重跑回填脚本。
- 收尾时先完成所有 Markdown 转换、飞书回填和最终合并，再扫描当月输出目录里的单篇文章 `.md` 文件；只有大于 60 KB 且文件名已经是 `<rank>_<topic_id>_<title>.md` 这种标题格式的单篇文章 Markdown 才移动到 `D:\page\2023\2025\2026\4\12_\time_control_app\outputs\太大\`，并在当月目录写 `oversized_files_moved.json` / `.md`，记录原路径、移动后路径、大小和移动时间。`topics_normalized.md`、`articles_normalized.md`、`merged_feishu.md`、`final_merged_articles.md` 这类聚合 Markdown 留在当月目录；JSON、DOCX、raw API payload、鉴权调试文件不要因为超过 60 KB 就移动。
- 2026-05-22 已将 2021-11 / 2021-12 曾误移到 `outputs\太大\` 的聚合 Markdown 恢复回对应月份目录，并把对应 `oversized_files_moved.*` 改回“只记录标题命名单篇文章 Markdown”的审计口径；后续如发现旧批次审计里还有聚合 Markdown 记录，先恢复原路径再重写审计。

PowerShell 示例：

```powershell
$skill = 'C:\Users\86180\.codex\skills\shengcai-zsxq-digest-export'
$env:ZSXQ_COOKIE = '<paste-current-shell-cookie-here>'
node "$skill\scripts\fetch_zsxq_month_digests.mjs" `
  --year 2020 `
  --month 12 `
  --output-root outputs `
  --count 20 `
  --concurrency 5 `
  --detail-delay-ms 900 `
  --detail-jitter-ms 1400
```

如果只需要 topic API 内容，不需要二层长文正文，可追加 `--skip-articles`。

若 `feishu_links.json` 中存在 `feishuRows`，优先调用官方 Feishu CLI 导出 skill。该命令同时接受旧 `/docs/` 与现代 `docx/wiki` 链接，旧文档成功导出时会额外留下 `legacy_docx/`：

```powershell
$feishuSkill = 'C:\Users\86180\.codex\skills\feishu-cli-markdown-export'
node "$feishuSkill\scripts\export_feishu_via_lark_cli.mjs" `
  --input outputs\zsxq-1824528822-2021-12\feishu_links.json `
  --output outputs\zsxq-1824528822-2021-12\feishu_export `
  --merged-name merged_feishu.md `
  --concurrency 4 `
  --as user
```

如果 CLI 授权过期、文档权限不足，或者确实需要走网页渲染后的 Markdown 视图，再退回浏览器扩展 skill：

```powershell
$feishuBrowserSkill = 'C:\Users\86180\.codex\skills\feishu-batch-markdown-export'
node "$feishuBrowserSkill\scripts\export_feishu_links_to_md.mjs" `
  --input outputs\zsxq-1824528822-2021-12\feishu_links.json `
  --output outputs\zsxq-1824528822-2021-12\feishu_export `
  --merged-name merged_feishu.md `
  --concurrency 4
```

飞书导出完成后，必须回填到源文章 Markdown：

```powershell
node "$skill\scripts\backfill_feishu_markdown_to_topics.mjs" `
  --topics-dir outputs\zsxq-1824528822-2021-12\topics_filtered_valid_md `
  --feishu-input outputs\zsxq-1824528822-2021-12\feishu_links_filtered_valid.json `
  --manifest outputs\zsxq-1824528822-2021-12\feishu_export\feishu_cli_manifest.json `
  --failed outputs\zsxq-1824528822-2021-12\feishu_export\failed_feishu_links.json `
  --output-dir outputs\zsxq-1824528822-2021-12\topics_filtered_valid_with_feishu_md
```

2020 年 12 月项目案例筛选仍使用本仓库内的人工口径筛选脚本：

```powershell
node scripts\filter_zsxq_december_project_cases.mjs `
  --input outputs\zsxq-1824528822-2020-12\topics_normalized.json `
  --output-dir outputs\zsxq-1824528822-2020-12
```

如果需要再次生成“一项目一 Markdown 文件”，从 `filtered_project_cases.json` 派生即可，不需要重新请求 ZSXQ：

```powershell
node scripts\split_zsxq_project_cases.mjs `
  --input outputs\zsxq-1824528822-2020-12\filtered_project_cases.json `
  --output-dir outputs\zsxq-1824528822-2020-12\project_cases_md
```

## 凭据和缓存卫生

- `ZSXQ_COOKIE`、飞书 Cookie、Chrome Local Storage、Network cache 都不能提交到仓库。
- 调试登录态时只把 Cookie 放进当前 shell 环境变量；不要把完整 curl 写入脚本或文档。
- 临时浏览器资料、前端包副本和原始响应样本应放在 `tmp/`，确认正式产物进 `outputs/` 后清理。
- `outputs/` 可以保留结构化结果，但发布或共享前要确认原始内容是否允许外传。
- `outputs\太大\` 是 ZSXQ 月度导出的超大单篇文章 Markdown 集中区，只放已生成、已脱敏、且文件名为 `<rank>_<topic_id>_<title>.md` 的文章 Markdown；不要把月度聚合 Markdown、JSON、DOCX、cookie、token、Chrome profile、Network cache 或原始鉴权调试文件移动进去。
