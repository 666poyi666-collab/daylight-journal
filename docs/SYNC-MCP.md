# 同步与 MCP

## REST 接口

- `GET /journal/all`：读取完整日期映射
- `POST /journal/sync`：接收日记数组，在串行写入队列中按 `updatedAt` 合并后写入 `data/journals.json`；旧修订不能覆盖同日期的新修订
- `GET /health`：服务探活

当前服务未启用 token（个人环境、用户明确接受该取舍）。如果部署到公开环境，必须设置 `MCP_TOKEN` 并让同步客户端带上认证头。

日记可以带一张前端压缩后的 `coverImage`，同步服务将请求体上限设为 4 MB。schema v2 还会同步有序 `blocks`、每片的 `writeTimes`、`writeStops` 和可选 `textColor`；旧版 `content` 作为展平镜像继续随记录同步。停笔偏移与文字颜色只影响客户端显示，不进入 MCP 复盘正文。

MCP 文本工具不会返回图片 data URL，只返回 `hasImage`。对于 schema v2，按记录片返回正文和写作时间，不再同时返回重复的展平 `content`，避免复盘上下文重复。

当前同步仍按整日 `updatedAt` 执行 last-write-wins，并未宣称 block 级实时合并；跨设备同时编辑同一天的冲突治理需要后续加入 block tombstone 与排序冲突协议。

自动化测试通过 `JOURNAL_DATA_DIR` 指向系统临时目录，避免接口回归写入真实日记副本。生产运行不设置该变量时仍使用仓库下的 `data/`。

## MCP 工具

- `get_today_journal(date?)`
- `get_journal_by_date(date)`
- `list_recent_journals(limit?)`

三个工具均为只读。MCP 服务同时提供新版 `/mcp` 与兼容 `/sse`/`/messages`，以适配不同 ChatGPT 连接器版本。

## ChatGPT 使用方式

1. 在 ChatGPT 插件/连接器设置中安装「拾光日记」。
2. URL 填写当前公网 MCP 地址的 `/mcp`。
3. 身份验证选择「未授权」（个人本地服务）。
4. 在「日记」项目的聊天中，从“添加文件等”菜单选择「拾光日记」。
5. 第一次调用时选择“始终允许”，可勾选记住本次对话答案。

应用不会调用 OpenAI API，也不会依赖 Edge 桥接来完成默认复盘；复盘由 ChatGPT 网页端在项目内完成。

## 运行检查

```powershell
curl.exe -s http://127.0.0.1:3001/health
curl.exe -s https://<当前隧道域名>/health
Get-Content .\data\journals.json
```

Quick Tunnel 地址不是永久地址。长期使用前应换成固定 Cloudflare Tunnel 或域名，并把客户端地址移到可编辑配置中。
