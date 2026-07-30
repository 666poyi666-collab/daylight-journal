# Journal MCP 独立部署与验收

本文是拾光日记 MCP 的长期运维事实来源。不得把 tunnel ID、API key、Bearer token、
真实日记、ChatGPT 会话或未经裁剪的生产日志写入本文或 Git。

## 生产固定架构

```text
ChatGPT「拾光日记」应用
→ Journal OAuth authorization server
→ https://journal-mcp...workers.dev/mcp
→ JournalMCP Durable Object
→ D1 journal_mcp_entries（正文类字段，无附件）

网页/手机/平板 → /sync/v2/exchange → encrypted replica + journal_mcp_entries
手机/平板 ↔ `_poyi-journal._tcp.local` → 8781 认证附件密文 API（无 MCP）
```

Journal 运行时不依赖 Windows、PersonalMcpGateway 或其他产品。设备 `dj1`、管理员
`SYNC_KEY`、OAuth access token 和 resource-server client secret 互不通用。旧本机 MCP/Tunnel
仅保留维护兼容，不能作为电脑关机验收链路。

## 云端服务与固定标识

| 项目 | 固定值 |
| --- | --- |
| MCP endpoint | Journal Worker 的 `https://<host>/mcp` |
| OAuth resource/audience | 与 MCP endpoint 完全相同 |
| OAuth scope | `journal:read`；当前 Cloud MCP 只读 |
| 同步入口 | `/sync/v2/exchange` |
| MCP 可读表 | `journal_mcp_entries` |
| 附件 | 云端永久禁用；所有 `/sync/v2/objects*` 返回 410 |

## 本机兼容服务与端口

| 项目 | 固定值 |
| --- | --- |
| MCP 服务 | `PoyiJournalMcp` |
| Tunnel 服务 | `PoyiJournalTunnel` |
| MCP/业务 API | `127.0.0.1:8780` |
| MCP endpoint | `http://127.0.0.1:8780/mcp` |
| LAN 业务 API | `0.0.0.0:8781`，仅 Private/LocalSubnet |
| mDNS 类型 | `_poyi-journal._tcp.local` |
| Tunnel operator | `127.0.0.1:8887` |
| Tunnel profile | `journal` |
| Tunnel 名称 | `journal-tunnel` |
| 运行数据 | `%ProgramData%\Poyi\JournalMcp` |
| 安装目录 | `%ProgramFiles%\Poyi\JournalMcp` |

MCP 服务提供 `GET /healthz`、`GET /readyz`、`GET /metrics`。8781 只提供健康、版本化
业务 API 和兼容同步接口，任何 `/mcp` 请求必须为 404。Tunnel 自身也在 8887
提供健康和就绪状态。两个 WinSW 服务均为 Automatic (Delayed)、三级失败重启。

本机 Windows 保留了 `8901-9000` TCP 端口范围，因此不得将 Tunnel operator 配置到
该范围；`8887` 是 Journal 的固定、独立且经实际绑定验证的健康端口。doctor 使用
`127.0.0.1:0` 临时端口执行并行诊断，避免与正在运行的 operator 争用 `8887`。

## 认证与权限

- Cloud `/mcp`：只接受 RS256、`typ=at+jwt`、精确 issuer/resource/audience 的 OAuth token，
  每次请求执行 fail-closed introspection。`journal_get_status` 也只要求 `journal:read`。
- Journal 到 OAuth 的 introspection 保持 `client_secret_basic` 语义；通过 Cloudflare service
  binding 时同时发送标准 `Authorization` 和 `X-Poyi-Resource-Server-Authorization`。
  OAuth 仅在两者缺一或完全一致时取值，冲突立即 401，专用头不得由公网客户端或日志生成。
- Cloud `/sync/v2/*`：只接受可撤销 `dj1` 设备凭据；浏览器 Origin 必须精确 allowlist。
- Cloud 管理设备：只接受仓库外 `SYNC_KEY`；它不能调用 MCP。

- `/v1/*`：独立随机 Bearer token，首次启动生成到运行数据目录；匿名请求返回 401。
- `/mcp`：只监听 loopback，由独立 Secure MCP Tunnel 和 OpenAI tunnel/runtime key 保护，
  不直接暴露公网。
- 手机/平板：使用 mDNS 发现的稳定 serviceId/端口和同一独立随机配对令牌；不使用 ADB
  转发或固定 IP。token 只保存在应用本地存储的密码配置中。
- Tunnel runtime key：LocalMachine DPAPI 加密，仅 Administrators 和
  `NT SERVICE\PoyiJournalTunnel` 可读密文文件。
- Journal MCP 账户：只对安装目录有 RX、对 Journal 数据目录有 M。
- Tunnel 账户：只读程序/profile/DPAPI 密文并修改自己的日志；不授予日记文件或 API
  token 内容读取权限。

任何 Vite `VITE_*` 变量都会进入前端包，禁止把上述秘密放入 Vite、APK、GitHub Actions
明文变量、命令行输出或日志。

## API、工具与 Resource

Cloud MCP 工具：

- `journal_get_status`
- `journal_list_recent`
- `journal_search`
- `journal_get_entry`

Cloud Resource：`journal://entries/{date}`。完整正文通过 embedded Resource 与
`resources/read` 提供；所有输出都不包含 `coverImage`、图片、附件路径或附件存在性。

以下 7 个写入工具属于本机兼容 MCP，不是 PC-off Cloud MCP：

版本化 API：`/v1/status`、`/v1/health`、`/v1/capabilities`、列表、单篇读取、创建、
追加和元数据更新。Gateway 或 MCP 层不得绕过 JournalStore 直接读 JSON。

MCP 工具：

- `journal_get_status`
- `journal_list_recent`
- `journal_search`
- `journal_get_entry`
- `journal_create_entry`
- `journal_append_entry`
- `journal_update_entry`

Resource：`journal://entries/{date}`。`journal_get_entry` 的普通文本与 `structuredContent`
只返回元数据、`resourceIncluded` 和正文长度，完整正文放在标准 MCP Resource 内容块中；
服务同时保留 `resources/read` 模板契约。所有写工具要求 UUID `requestId` 和
`expectedRevision`。Journal 没有控制命令，capabilities 中 `controlCommands` 是空数组。

## 安装和升级

Cloud staging 必须按以下顺序：仓外加密 D1 备份 → additive migrations 到 `0010` →
同一 Worker bundle 部署 → `/readyz` → 虚构数据同步 → OAuth MCP 非空调用。staging 已完成
`0006` 的空库可直接应用 `0009`/`0010`；`wrangler deploy` 不会自动执行 SQL migration。

production 旧库禁止执行 `0006`。先执行 `0002`（仅尚未有这些列时）、`0003`、`0004`、
更新后的 `0005`、`0007`、`0008`、`0009`、`0010`，部署与 staging 完全相同的 Worker
bundle，再由两个独立 `dj1` 中任一端完成认证 migration。`/readyz.migration` 必须从
`discovery_pending` 经过 `migrating` 到 `cutover_required`；只有 preflight 证明旧行、ledger、
密文实体和 MCP 镜像全部一致后，才执行 `0011_legacy_cutover.sql`。任何计数不一致都中止。
`/readyz` 必须同时核对 migration 与 OAuth；migration 未 cutover 时不能据此推断 OAuth 已就绪。

本机兼容服务仍按以下方式维护：

在管理员 PowerShell 中：

```powershell
.\mcp\service\install.ps1
.\mcp\service\status.ps1
.\mcp\service\verify.ps1

# Tunnel 必须使用新建的 Journal 专用 tunnel ID 和 runtime API key。
$key = Read-Host 'Journal Tunnel runtime API key' -AsSecureString
.\mcp\tunnel\install.ps1 -TunnelId 'tunnel_<journal-only>' -RuntimeApiKey $key
.\mcp\tunnel\doctor.ps1
.\mcp\tunnel\verify.ps1
```

升级顺序：先测试源码，再更新 MCP 服务，确认 8780 ready 后更新 Tunnel。卸载只使用
Journal 的卸载脚本；禁止调用 PersonalMcpGateway 或其他项目的 WinSW 可执行文件。

## 验收命令

Cloud 代码与 staging：

```powershell
cd C:\开发\mcp开发\journal-cloud-mcp
npm test
npx wrangler deploy --dry-run --config wrangler.staging.jsonc --outdir .wrangler/candidate
Get-FileHash .wrangler/candidate/index.js -Algorithm SHA256
curl.exe -f https://<journal-staging>/healthz
curl.exe -f https://<journal-staging>/readyz
curl.exe -f https://<journal-staging>/.well-known/oauth-protected-resource/mcp
```

staging 与 production 必须记录同一 commit 和 `.wrangler/candidate/index.js` SHA-256，
production 不得重新生成 bundle。`/readyz` 必须报告
`encrypted_replica_plus_mcp_read_model`、`oauth: ready` 和 `migration.status: complete`。随后以
Journal OAuth token 执行 `initialize`、`tools/list`、`journal_get_entry` 和
`resources/read`，正文必须非空且不含附件字段。停止发起 mutation 的本地客户端后重复读取，
结果仍必须成功，才算 PC-off 等价通过。

本机兼容链路：

```powershell
npm run lint
npm run test:unit
npm run test:mcp:e2e
npm run build

curl.exe -f http://127.0.0.1:8780/healthz
curl.exe -f http://127.0.0.1:8780/readyz
curl.exe -f http://127.0.0.1:8780/metrics
curl.exe -f http://127.0.0.1:8781/healthz
# 下列匿名请求应为 401；8781/mcp 应为 404。
curl.exe -i http://127.0.0.1:8781/v1/status
curl.exe -i http://127.0.0.1:8781/mcp

npx @modelcontextprotocol/inspector --cli http://127.0.0.1:8780/mcp `
  --transport http --method tools/list
npx @modelcontextprotocol/inspector --cli http://127.0.0.1:8780/mcp `
  --transport http --method resources/templates/list
```

Inspector 必须看到 7 个带 `journal_` 命名空间的工具和一个 Resource 模板。Windows
Node 24 上若 Inspector 在打印成功响应后因已知上游退出断言返回非零，不能把它写成
“完全通过”；应保留成功协议响应，并用 CI 或兼容 Node 再验。

## 真实 ChatGPT 验收

1. ChatGPT 独立“拾光日记”应用绑定 Journal Worker `/mcp` 与其 OAuth metadata，不绑定本机 Tunnel。
2. 调用 `journal_get_status`，确认 `pcOffMcpRead=true` 且 `readableEntries>0`。
3. 调用 `journal_list_recent`、`journal_search` 和 `journal_get_entry`，再读取
   `journal://entries/{date}`；正文必须来自真实同步 revision，不是健康占位符。
4. 关闭本机 Journal 客户端/电脑后重复第 2–3 步，调用仍成功。
5. 删除一篇测试记录后，Cloud MCP 不能再读到其正文；重新写入后按更高 revision 恢复。
6. 检查响应、D1 schema 与日志不含 `coverImage`、图片字节、附件路径或 token。
7. 迁移发布额外核对 `sourceRows=7`、`discovered=7`、`completed=7`，并按 preflight
   得到的去重目标日期数核对当前密文/MCP 投影；保存脱敏计数，不得保存旧正文或 import payload。

真实验收证据只记录时间、工具名、状态、revision/replayed、脱敏 Tunnel 状态和截图路径。
禁止保存正文、标题、标签、图片、token、Cookie 或完整网络日志。

## 2026-07-30 production Cloud 验收

- 旧记录 preflight 为 `sourceRows=7`、`discovered=7`、`completed=7`、`pending=0`；缺失密文
  副本和 MCP 投影均为 0。执行 `0011_legacy_cutover.sql` 后旧表为 0、不完整迁移为 0，
  cutover ledger 为 1。
- production cutover 前完成仓外 EFS 加密备份并记录 SHA-256；路径和摘要仅留运维交接，
  不进入客户端、Worker 或 ChatGPT。
- OAuth `/readyz` 与 Journal `/readyz` 均为 200；Journal 报告 `oauth=ready`、
  `migration=complete`、`storage=encrypted_replica_plus_mcp_read_model`。
- ChatGPT 正式只读连接器以 `journal:read` 完成 OAuth exchange；刷新后发现四个工具。
  脱敏实测 `journal_get_status`、`journal_list_recent`、`journal_search`、
  `journal_get_entry` 全部成功，embedded Resource 已实体化并读取，内容长度大于 0。
- 再次只调用 Cloud `journal_get_status`，返回 `journal_cloud_authoritative`、
  `pcOffReadable=true` 和非零可读计数；链路未使用本机 8780、Journal Tunnel 或 Gateway。
- 临时 owner credential rotation endpoint 已撤销，生产访问为 404；验收未保存正文、日期、
  标题、标签、URI、token、Cookie 或完整 ChatGPT 会话。

## 日志规范

允许字段：timestamp、event、requestId、tool、resource、durationMs、outcome、errorCode。
禁止字段：content、summary、title、tags、coverImage、Authorization、token、API key 和请求体。
服务日志按 10 MB、3 个文件轮转。支持包只收集版本、服务状态、健康结果、计数指标和
脱敏错误码；采集后必须人工检查再分享。

## 2026-07-26 本机兼容链路历史证据

- `PoyiJournalMcp` 安装为 Automatic (Delayed)，服务账户为
  `NT SERVICE\PoyiJournalMcp`。
- `/healthz`、`/readyz`、`/metrics` 返回 200。
- 强制结束 MCP 服务进程后 WinSW 自动分配新 PID 并恢复 ready。
- 正确终止 Node 子进程后，8780/8781 由同一新 PID 恢复；安装器会清理绝对 Journal
  entry point 对应的孤儿进程。
- 8781 实际绑定 `0.0.0.0`，防火墙仅 Private/LocalSubnet；匿名 API 为 401、`/mcp`
  为 404。mDNS 实测发现端口 8781、稳定 serviceId 和 API v1。
- 单元/集成/契约测试 17 项通过，lint、生产构建和部署态 E2E 通过。
- Inspector 成功返回 7 个工具和 Resource 模板，但 Windows Node 24 在响应后触发已登记的
 退出断言，见 `BUGS.md` KR-006。
- Secure MCP Tunnel doctor 要求 HTTP MCP 提供 Protected Resource Metadata；Journal MCP
  已提供对应的 `/.well-known` 发现契约，元数据响应不包含日记或凭据。
- `journal-tunnel`、`PoyiJournalTunnel` 和独立“拾光日记”ChatGPT 应用已连接并 ready；
  未创建或修改 PersonalMcpGateway Adapter。
- ChatGPT 真实调用 `journal_get_status`、`journal_list_recent`、`journal_get_entry` 和
  `journal_update_entry` 通过。Resource 结果为 `resourceIncluded: true`，证据仅记录长度，
  不记录正文或元数据。
- 首次元数据原值写回返回 `replayed: false`、revision 2；相同 requestId 和参数重放返回
  `replayed: true`、revision 2；重启 MCP 后再次重放仍为 `true`、revision 2。
- MCP 升级后会自动恢复原本运行的 Tunnel；服务重启验收中 Foxlink 状态未变化，Watch
  保持重启前的停止状态。Tunnel doctor、verify 和带敏感值硬断言的服务验证均通过。
- 真实验收未输出或保存日期、标题、心情、标签、图片、正文、URI、requestId、Tunnel ID、
  runtime key、Cookie 或会话数据。CI、APK 和提交 SHA 由对应 GitHub 发布记录与最终报告给出。
