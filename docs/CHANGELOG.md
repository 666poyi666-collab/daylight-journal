# 变更日志

格式参考 Keep a Changelog。当前项目尚未形成稳定发布节奏，早期记录依据仓库现有文档、
代码和测试重建，不把不可访问的历史聊天内容当作事实。

## [Unreleased]

### Changed

- Journal 客户端生产同步切换到 AES-256-GCM V2：durable outbox、首次拉取、附件密文、显式删除、tombstone 恢复和冲突重排均走 `/sync/v2/*`，不再回退明文 V1。
- 设置页增加 `dj1` 设备凭据与 `jk1` 根密钥的显式设备批准流程。

### Fixed

- 将 Journal Tunnel 健康端口从 Windows 保留范围内的 8987 迁移到 8887，并补齐 Secure MCP
  Tunnel doctor 所需的 HTTP MCP OAuth 发现元数据。
- Tunnel doctor 改用临时 loopback 端口，允许在正式 Tunnel 服务运行时完成诊断。
- `journal_get_entry` 使用标准 MCP Resource 内容块承载完整正文，普通文本和
  `structuredContent` 只保留元数据与脱敏长度。
- MCP 升级脚本在 Windows 自动停止依赖 Tunnel 后恢复其原运行状态，并等待 Tunnel ready。
- 服务验证将认证、LAN 隔离、单进程监听和敏感日志扫描改为失败即非零退出。

### Verified

- 独立“拾光日记”ChatGPT 应用完成真实状态、列表、Resource、元数据写入、同请求重放和
  MCP 重启后重放；revision 未在重放时再次增加。
- Journal MCP/Tunnel 均为自动服务且 ready，Tunnel doctor 通过；Journal 重启未改变其他
  MCP 服务状态，审计日志扫描未发现令牌或日记敏感值。

## [1.0.1-debug] - 2026-07-26

### Added

- 建立用户需求基线、开发与发布手册、Bug/风险台账和版本日志。
- 增加公开仓库的隐私与发布检查规则。
- 增加独立 `PoyiJournalMcp`、版本化业务 API、7 个 Journal 工具和完整正文 Resource。
- 增加持久化 requestId 重放、整数 revision 冲突、原子 JSON 写入和错误映射。
- 增加独立 `PoyiJournalTunnel`、DPAPI 密钥、WinSW 服务模板、健康指标和 CI。
- 增加 8781 认证 LAN API、mDNS 稳定 serviceId 发布、Private/LocalSubnet 防火墙规则和客户端配对设置。

### Changed

- 公开构建不再内置个人 Quick Tunnel 与 ChatGPT 项目标识；改用安全默认值和构建变量。
- 默认本地服务端口从 3001 调整为 Journal 专用 8780；旧同步接口保持兼容。
- MCP 审计改为字段白名单，日记正文、标题、标签、图片和令牌不进入日志。
- 兼容同步接口改为强制 Bearer，LAN listener 明确不暴露 MCP。

### Fixed

- 修复 WinSW XML 路径写入和已有文件 ACL 继承导致的 Windows 服务安装/readiness 失败。
- 修复包装器异常退出遗留 Journal Node 子进程造成的 split listener。

## [1.0.0-debug] - 2026-07-25

### Added

- React/Vite/PWA 与 Capacitor Android 共用的日记应用。
- 标题、记录片、写作时间、心情、标签、单图封面、日历、历史时间流与往年今日。
- localStorage 即时保存、服务端 JSON 同步副本和只读 MCP 工具。
- ChatGPT 复盘提示词、Markdown 导出和离线应用壳。
- Editorial Paper 响应式视觉与手机、平板、桌面回归测试。

### Fixed

- 修复即时刷新丢稿、异步图片覆盖新输入、旧同步修订覆盖、存储错误误报、移动端键盘
  遮挡、长文高度与滚动跳变等问题；具体证据见 `BUGS.md`。

### Known limitations

- 同步仍为按日期 last-write-wins，没有 block 级冲突合并和持久化离线队列。
- 公网部署必须自行配置认证与固定域名。
- 附带 APK 使用 debug 签名，仅用于测试安装。
