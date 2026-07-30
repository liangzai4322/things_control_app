# 日省 × 人生参谋部

双向桥接包含两个标准库脚本：

- `fetch_daily_review_context.py`：日省开始前读取盒子/HQ，生成 Markdown 事实包。
- `sync_daily_review_to_hq.py`：日省结束后写回闭环、外部结果、次日承诺和待决策事项。

认证优先读取`TASKBOX_API_TOKEN`，否则读取`TASKBOX_API_TOKEN_FILE`或用户目录下的`.codex/secrets/taskbox-api-token`。凭据文件不进入仓库。

```powershell
python fetch_daily_review_context.py --date YYYY-MM-DD
python sync_daily_review_to_hq.py --file "PATH\YYYY-MM-DD.md" --date YYYY-MM-DD
```

运行`python test_daily_review_bridge.py`执行无网络单元测试。
