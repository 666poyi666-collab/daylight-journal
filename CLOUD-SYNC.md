# 云同步（Cloudflare）· 拾光日记

> 2026-07-26 建立。目标：电脑关机后，ChatGPT/Claude 仍能读写日记。

## 现状架构

拾光走的是**云端权威 CRUD**（与 Watch/Foxlink 的"快照镜像"不同）：

```text
ChatGPT / Claude → journal-mcp.focuslink-poyi-6465e9.workers.dev（Workers + D1）
```

- 云端 MCP 工具：journal_create_entry（幂等键）/ journal_update_entry（revision
  乐观锁，冲突返回 revision_conflict 而不是覆盖）/ journal_get_entry /
  journal_list_recent / journal_search / journal_delete_entry（软删）。
- Worker 源码：`C:\开发\mcp开发\journal-cloud-mcp`（连接 URL 与密钥见 `.dev.vars`，不入 git）。
- 已实测：初始化、建档、读回、错误密钥 404 全通过；首篇《云端试点第一篇》已入 D1。

## 与本机/手机数据的合流（下一步）

当前云端 D1 与本机 `C:\ProgramData\Poyi\JournalMcp` 的数据是**两个池子**。合流方案：

1. 手机 App / 本机 MCP 增加"上行同步"：把本地新增/修改按 revision 推到云端
   （用 journal_create_entry 的 idempotency_key = 本地条目 ID，天然防重复）；
2. 拉取方向：设备联网时调 journal_list_recent 增量回拉；
3. 冲突：revision 不匹配 → 以云端为准生成副本，人工合并（日记场景冲突极少）。
