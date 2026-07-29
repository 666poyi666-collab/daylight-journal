# 同步与 MCP 协议

## 生产加密同步

- `POST /sync/v2/exchange`：唯一云端数据交换入口，只传输正文、标题、记录片和标签的 AES-GCM 密文 mutation、conflict、change 和 cursor。
- 云端 mutation 的 `objects` 固定为空；生产客户端不调用 `/sync/v2/objects/*`，封面、base64、文件路径和媒体 URL 均不进入云请求、D1、R2 或 MCP。
- 客户端没有 `/journal/all`、`/journal/sync` 或 `/sync/v1/*` fallback；V2 不可用时保留本机稿件与 durable outbox。
- 设置页只有同时保存 `dj1` 设备凭据和 `jk1` 端到端根密钥后，才视为设备已批准并启动同步。

## 电脑与手机直连附件

- 安装版只在显式启用 `JOURNAL_SYNC_HOST` 后监听 LAN `8781`，通过
  `_poyi-journal._tcp.local` 发布 `peerAttachments=v1`，不发布 token。
- 8781 使用独立生成并持久化的 peer capability，不能复用 8780 Journal API token、
  云端 `dj1` device token 或 observation capability。
- `GET /v1/peer-attachments` 与 `PUT /v1/peer-attachments/:date` 是 8781
  唯一数据接口；该 listener 不提供正文 API、`/journal/*` 或 `/mcp`。
- 客户端只接受 `localhost`、`.local`、回环、链路本地和 RFC1918/ULA
  私有网段地址，拒绝公网域名、Tunnel URL、URL 内凭据、query 和非根路径。
- 附件使用与正文相同的 `jk1` 根密钥，但使用独立
  `channel=peer_attachment` AAD；电脑只持有密文、nonce、digest、AAD hash、
  key version、日期和 tombstone。
- 直连失败只保留密文 pending envelope，正文云同步继续运行；相同时间戳内容
  不同、revision 回退、响应篡改和错误密钥全部 fail-closed。

电脑主服务 `127.0.0.1:8780` 的本地业务/MCP API 不是跨端同步链路。客户端仍以
localStorage 为编辑副本；正文 authority revision、conflict 和 tombstone 由云 V2
管理，附件 revision 与 tombstone 由直连 V1 管理。当前不宣称 block 级无冲突协作。

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

安装版可在 `0.0.0.0:8781` 提供独立的加密附件直连接口，防火墙必须限定
Private profile 与 LocalSubnet。手机/平板在设置页保存 `.local` 或私有地址与独立
本地配对令牌；云端 `dj1` device token 不得复用为直连凭据。

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

完整正文 Resource：`journal://entries/{date}`。

MCP 工具与 Resource 在序列化前剥离 `coverImage`，也不返回附件存在性字段。

列表、搜索和读取工具返回元数据、短摘要与 Resource URI；完整/长正文由 Resource 返回。
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
