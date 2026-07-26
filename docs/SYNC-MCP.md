# 同步与 MCP 协议

## 数据与兼容同步

- `GET /journal/all`：为现有 Web/Android 客户端返回完整日期映射。
- `POST /journal/sync`：串行合并客户端副本；较旧 `updatedAt` 不覆盖新版本，并推进整数 revision。
- `GET /health`：旧客户端兼容探活。运维探活使用 `/healthz` 和 `/readyz`。

客户端仍是 localStorage 本地优先，服务端 JSON 是跨端副本。跨设备同时编辑同一天仍按
整日 `updatedAt` 合并，不宣称 block 级无冲突协作。

## 版本化业务 API

服务监听 `127.0.0.1:8780`，提供：

- `GET /v1/status`、`GET /v1/health`、`GET /v1/capabilities`
- `GET /v1/entries`、`GET /v1/entries/:date`
- `POST /v1/entries`
- `POST /v1/entries/:date/append`
- `PATCH /v1/entries/:date`

`/v1/*` 必须使用 `Authorization: Bearer <random-token>`。token 自动生成在运行数据目录，
不进入 Git、APK、前端变量或日志。所有写入都要求 UUID `requestId` 和非负整数
`expectedRevision`；相同 requestId/载荷返回持久化结果重放，载荷不同返回
`REQUEST_ID_REUSED`，revision 不符返回 `REVISION_CONFLICT`。

安装版同时在 `0.0.0.0:8781` 提供相同的认证业务 API和兼容同步接口，防火墙限定
Private profile 与 LocalSubnet。它通过 `_poyi-journal._tcp.local` 发布稳定 serviceId、
端口和 API 版本，不发布 token，也不提供 `/mcp`。手机/平板在设置页保存 `.local`
地址与配对令牌，不依赖 ADB 或固定 IP。

Journal 没有开始/暂停/停止一类控制命令，故 `commandId`、`expectedState`、`expiresAt`
不适用；`/v1/capabilities` 中 `controlCommands` 固定为空数组。

## 独立 MCP

MCP endpoint 为 `http://127.0.0.1:8780/mcp`，使用 Streamable HTTP。工具：

- `journal_get_status`
- `journal_list_recent`
- `journal_search`
- `journal_get_entry`
- `journal_create_entry`
- `journal_append_entry`
- `journal_update_entry`

完整正文 Resource：`journal://entries/{date}`（`resources/read` 仍返回权威全文）。

`journal_list_recent` / `journal_search` 只返回元数据、短摘要与 Resource URI，并附带
`contentAccess` 引导：命中后必须逐篇调用 `journal_get_entry` 读取正文。
`journal_get_entry` 直接分页返回正文：入参 `offset`（默认 0）与 `maxChars`（默认
6000、上限 12000 字符），返回 `contentChunk`、`contentLength`、`contentOffset`、
`contentComplete` 与 `nextOffset`；`contentComplete` 为 false 时必须用 `nextOffset`
继续读取，结果同时附带指向权威 Resource 的 `resource_link`。服务端 instructions
向客户端声明该流程。原因：ChatGPT 不会自动读取嵌入式 Resource 内容块。
写工具必须显式提供 requestId 和 expectedRevision。审计日志只允许时间、事件、请求 ID、
工具/Resource 名、耗时、结果和错误码，禁止正文、标题、标签、图片和任何令牌。

## ChatGPT 链路

```text
ChatGPT 拾光日记应用
→ journal-tunnel（独立固定 tunnel_id）
→ PoyiJournalTunnel
→ 127.0.0.1:8780/mcp
→ PoyiJournalMcp / JournalStore
```

Journal 不接入 PersonalMcpGateway，不与 Watch、Foxlink、Music 共用 MCP Server、Tunnel、
profile、端口、数据或日志。MCP 不直接暴露公网。具体安装与真实调用验收见
`MCP-OPERATIONS.md`。
