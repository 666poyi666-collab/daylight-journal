# 技术架构

## 分层

```text
React/Vite/Capacitor
        │
        ├─ localStorage（本端快速读写）
        ├─ 正文 durable outbox
        │           │
        │   /sync/v2/exchange（密文副本 + 无附件 mcpEntry）
        │           │
        │   Journal Cloud Worker / D1
        │        ├─ encrypted replica（设备恢复）
        │        └─ journal_mcp_entries（OAuth MCP 只读）
        │
        └─ 附件 AES-256-GCM peer pending
                    │
            私有网段 8781（电脑在线时）
                    │
            opaque peer attachment store

手机/平板 → mDNS `_poyi-journal._tcp.local` → LAN 8781（仅附件密文，无正文/MCP）

ChatGPT → Journal Cloud OAuth MCP → D1 `journal_mcp_entries`（电脑关机仍可读）
```

## 代码职责

- `src/App.tsx`：应用壳、视图导航、跨页面状态组合和 ChatGPT 入口；不再直接解析或写入日记存储
- `src/pages/`：编辑、日历、历史和设置页面；页面只通过显式 props 读写应用状态
- `src/journal/model.ts`：日记类型、运行时数据校验、时间戳合并和不可变 patch
- `src/journal/storage.ts`：localStorage 安全适配、损坏数据识别、恢复副本和持久化结果分类
- `src/journal/peer-attachment-sync.ts`：私有地址校验、附件独立 AAD、密文 pending、tombstone 与直连 materialization
- `src/journal/image.ts`、`moods.ts`、`status.ts`：图片压缩、心情选项和保存/同步状态协议
- `src/journal/review.ts`：生成只读、深度且包含长期模式对照的 ChatGPT 复盘提示词
- `src/hooks/useTodayKey.ts`、`src/hooks/useMediaQuery.ts`：跨午夜日期刷新与响应式无障碍状态
- `tests/`：Node 数据层测试与拦截真实同步请求的 Playwright 浏览器回归
- `src/index.css`：设计 token 与元素基线；`src/journal-ui.css`：唯一组件样式层，负责 Ink & Daylight 视觉、三区独立滚动和四档响应式布局；历史样式文件已删除，不要再新增并行样式层
- `journal-store.mjs`：Journal 数据、整数 revision、原子写入和持久化幂等重放
- `journal-api.mjs`：带随机 Bearer 令牌的版本化 `/v1` API
- `peer-attachment-store.mjs`、`peer-attachment-api.mjs`：8781 专用的密文附件 authority 与严格 V1 合同
- `mcp/`：独立 Streamable HTTP MCP、Resource、脱敏审计、健康指标、Windows 服务和 Tunnel
- `mcp-server.mjs`：指向独立 MCP 的兼容启动入口
- `public/`：PWA manifest、service worker 和静态图标
- `android/`：Capacitor 生成和维护的 Android 工程
- `edge-bridge.mjs`：历史 Edge CDP 桥接实验，不属于默认 AI 链路，除非明确需要不继续扩展

## 数据模型

```ts
type JournalEntry = {
  schemaVersion: 2
  date: string        // YYYY-MM-DD，当前以天为主键
  title: string
  content: string     // blocks 展平后的兼容镜像
  blocks: JournalBlock[]
  mood: number | null // 1-5
  tags: string[]
  coverImage?: string // 可选，前端压缩后的 JPEG data URL；旧记录没有此字段
  createdAt: string
  updatedAt: string
}

type JournalBlock = {
  id: string
  content: string
  writeTimes: string[] // 每次写作会话开始时间
  writeStops: Array<{ sessionIndex: number; offset: number; at: string }>
  textColor?: 'ink' | 'sage' | 'terracotta'
  createdAt: string
  updatedAt: string
}
```

`writeStops` 把一次停笔映射到 `content` 字符偏移，不把 UI 时间徽标混入日记正文。旧 block 没有该字段时，以最后一次 `updatedAt` 和正文末尾确定性生成一条兼容停笔记录；任意编辑发生在历史停笔点之前时，前端会按文本增删长度重定位后续偏移，无法可靠映射到被替换区间的停笔点会被移除而不是伪造位置。

加粗和斜体使用 `**文字**`、`*文字*` 写入现有纯文本 `content`；文字颜色只允许墨色、鼠尾草绿和陶土色三档，以可选 `textColor` 保存到记录片。它不引入任意 HTML，也不改变 schema 主版本，旧记录默认使用墨色，Markdown 导出和 MCP 仍读取纯文本。

同步仍以日期作为唯一键，并按整日 `updatedAt` 合并。v1 单正文会确定性迁移为 `legacy-<date>` 记录片；`content` 继续作为兼容镜像，使旧版搜索、导出和服务端仍可读取。当前不是 block 级冲突合并，两台设备同时编辑同一天时仍以较新的整日修订为准。

## 同步原则

- 本地优先：网络不可用仍可写
- 生产客户端只调用 `/sync/v2/*`；V2 失败进入离线状态，不探测或回退明文 V1 路由
- 正文、标题、记录片和标签在 V2 mutation 中同时形成设备密文副本和严格无附件的
  `mcpEntry`；后者只供 Journal Cloud OAuth MCP 在电脑关机时读取
- 封面只进入独立的直连加密 envelope；公网地址和云 Tunnel 在发请求前即被拒绝
- 本地编辑分别进入正文 durable outbox 与附件 peer pending；正文 ACK、MCP 可读镜像和
  tombstone 在 D1 同一批次提交，冲突 mutation 不更新镜像
- 旧云记录先进入 durable pending import；客户端按日期无损合并后携带 `migrationIds`
  加密回传，ACK 时 pending import 与 outbox 同一次 snapshot 提交删除
- 首次正文拉取在解密与 schema 验证后推进 cursor；附件只在解密、digest 与 AAD 验证后写入本地
- 冲突保留 server current 与本地 candidate；较新的本地稿会基于 authority revision 重新排队
- 整篇删除是显式操作，先持久化 tombstone；同日期重新写作按更高 revision 恢复
- 服务端同步写入串行执行，并在写入前重新读取最新副本，避免并发请求和慢设备把旧修订写回
- 只上传有标题或正文的记录
- 日记可带一张可选封面图；附件密文只发往同机或私有网段 8781，`coverImage`、data URL、
  base64、路径和媒体 URL 不进入云 exchange 的 `mcpEntry`、D1、R2 或 MCP
- 同步失败显示“已保存到本机 · 点击重试”，不能阻塞输入；点击后立即触发一次同步重试
- 编辑变更立即写入本地 localStorage；远端同步仍采用 500ms 防抖，关闭或切后台不会丢最后一段输入
- 本地数据和远端响应都经过结构校验；存储不可用、配额不足或数据损坏会进入明确错误状态，不再静默当作空库
- 损坏或非法本地数据在首次渲染即进入保存错误态，主界面说明恢复副本已保留；编辑器页脚不得同时显示“已自动保存”
- 同步调度先串行清空已有 outbox，再拉取 changes/imports，最后排队并分批发送新 mutation；
  轮询、网络恢复、页面恢复同时触发时复用同一个同步 promise，避免旧请求覆盖新稿
- AI 复盘只有在当前修订版本完成推送后才开放；同步、剪贴板或弹窗失败分别显示恢复动作

## 独立 MCP 边界

- 生产 ChatGPT 主链路是 Journal 自己的 Cloud Worker `/mcp`，只接受精确 issuer、audience、
  scope、RS256 签名并经 introspection 确认的 OAuth access token；它不依赖 Windows 在线。
- Cloud MCP 提供 `journal_get_status`、`journal_list_recent`、`journal_search`、
  `journal_get_entry` 和 `journal://entries/{date}`，只读 D1 的无附件投影。
- 本机 `PoyiJournalMcp`/Tunnel 保留给本地维护与兼容验收，不再作为 PC-off 生产前提。

- `PoyiJournalMcp` 仅监听 `127.0.0.1:8780`，不注册其他项目工具，也不读取其他数据库。
- 同一 loopback listener 从已验收的 `dist` 提供可安装 PWA；静态壳不带设备凭据或根密钥，8781 不提供前端资源。
- 同一业务进程可在 Private/LocalSubnet 的 8781 提供带独立 Bearer capability 的附件密文 API，
  并通过 mDNS 发布稳定 serviceId；LAN listener 不注册正文 API、兼容 `/journal/*` 或 `/mcp`。
- 8781 capability 单独生成并持久化，禁止与 8780 Journal API token 复用；MCP Resource 会剥离 `coverImage`，附件内容和存在性元数据均不进入 MCP。
- `/v1/*` 使用仓库外随机 Bearer token；`/mcp` 只允许通过回环地址或独立 Secure MCP Tunnel 到达。
- 普通工具只返回状态、元数据、短摘要和 Resource URI；完整正文使用 `journal://entries/{date}`。
- 写操作由 `JournalStore` 执行，MCP 层只做 schema、错误映射和脱敏审计。
- Journal 没有后台控制命令，因此 `commandId`、`expectedState`、`expiresAt` 不适用，capabilities 明确返回空 `controlCommands`。

## PWA 离线壳

- service worker 安装时解析 Vite 生产 HTML 并缓存当前哈希 JS/CSS、manifest 和应用图标
- 同源静态资源使用缓存优先；页面导航使用网络优先并在服务不可用时回退到缓存壳
- `npm run test:pwa` 会启动临时生产预览、写入虚构草稿、关闭预览服务并验证离线刷新仍能渲染和恢复草稿
