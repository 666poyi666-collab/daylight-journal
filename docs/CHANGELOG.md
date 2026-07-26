# 变更日志

格式参考 Keep a Changelog。当前项目尚未形成稳定发布节奏，早期记录依据仓库现有文档、
代码和测试重建，不把不可访问的历史聊天内容当作事实。

## [Unreleased]

### Added

- 应用锁：4–6 位数字密码，PBKDF2-SHA256（120k 次、随机盐）哈希只存本机；冷启动必锁、
  切后台超 30 秒重锁、连错 5 次冷却 30 秒。设置页可开启/修改/关闭（需验证当前密码），
  锁屏为纸面数字键盘，明确说明这是防翻看的进入门、不是数据加密，且不提供应用内找回。
- 开屏动画重排（约 1.26 秒，可点击跳过）：晨光洗染 → 图标掠光 → 标题字距落定 →
  墨线绘出并由一粒赭金火星走完 → 日签浮现；日签按日期从 6 句中轮换。
- 显示字族引入 Fraunces（@fontsource 打包 latin 500/600，约 45KB，离线可用）：
  日期、统计数字、密码键盘的数字换上老式衬线字形，汉字仍回落宋体。
- 全局纸纹覆层（feTurbulence 噪点，4–5% 透明度，浅色黑噪/深色白噪），运行时零开销。
- 微交互与页面动效：视图切换 240ms 浮入、历史月份错峰浮入、心情选中弹跳、标签片缩放
  进入、键盘工具条上滑、主题切换整页交叉淡化（View Transitions API）、书写光标改用强调色。
- 今天的日期副行随时刻显示时段词（清晨/上午/午后/傍晚/夜里/深夜）。

### Changed

- 前端整体重设计为 Ink & Daylight：暖纸背景配真实墨色正文，鼠尾草绿换成单一赭金强调色，
  结构改由发丝线和留白建立，阴影只保留给抽屉、键盘工具条和拖动中的记录片。
- 显示层改用"拉丁衬线先行"的混排字族（数字走 Georgia、汉字走宋体），正文放大到 16.5px /
  行高 1.95，版心固定 680px；不引入任何在线字体。
- 记录片改为左侧时间轴形态，排序、删除和字数工具默认隐藏、悬停或聚焦才出现，触屏端常驻；
  空白记录片不再显示任何工具和字数。
- 平板竖屏侧栏收成 74px 图标轨，正文与上下文栏保持双栏；手机端心情与标签压成两条窄行，
  正文提前约 200px 进入首屏。
- 专注写作改为用 `:has()` 收走侧栏与上下文栏，日期降为一行小字。
- 心情五级改为一条冷→暖的真实色阶，日历改用格子侧边色条（手机端底部短横）而非整块染色。
- 主题色统一为 `#f7f4ed` / `#131211`（`index.html`、manifest、运行时 meta 三处同步）。

### Removed

- 删除已不在级联中的 `App.css`、`editorial-ui.css`、`journal-reference.css`、
  `performance.css`、`redesign.css`、`ui-v2.css`；运行时样式收敛为 `index.css` +
  `journal-ui.css` 两个文件。
- 移除日期区不承载信息的装饰元素（环境光球、天气字形）。

### Fixed

- 侧栏最近记录被 flex 压缩后与底部"设置/深色模式"重叠，且侧栏本身无法滚动。
- 抽屉关闭按钮在桌面和平板图标轨上仍然渲染，导致品牌行与图标轨横向溢出。
- 平板竖横屏上下文栏内容溢出：心情行改用 `minmax(0, 1fr)`，窄栏隐藏提示语。
- 平板横屏日期被挤成竖排。
- 首屏空白记录片的占位文案被 `min-height` 截断。
- 手机抽屉层级低于底部标签栏。
- 列表与卡片预览会把记录片分隔符 `---` 当正文展示，统一改走 `journalPreviewText()`。
- Android 15 edge-to-edge 下顶栏钻进状态栏：`env(safe-area-inset-*)` 改为在所有断点处理，
  横屏时左右两侧的系统区域同样让出（真机 Redmi Note 11T Pro 复现）。
- 横屏手机（895×393 CSS px）宽度落进平板区间、错误地拿到图标轨双栏布局：紧凑断点补上
  `(orientation: landscape) and (max-height: 520px)`，`journal-ui.css` 与 `App.tsx` 同步。
- 设置页状态圆点在窄屏被 flex 拉成椭圆，且三段信息换行错乱。
- 正文聚焦时浏览器默认 focus ring 把书写区变成表单输入框：改为左侧 2px 赭金竖线 + 光标表达焦点。
- Android 原生启动屏仍是旧墨绿 `#31483A`，冷启动会闪一下：改为 `#F7F4ED`，
  新增 `values-night` 深色底与 `@bool/splash_light_status_bar` 跟随状态栏图标明暗。

- 将 Journal Tunnel 健康端口从 Windows 保留范围内的 8987 迁移到 8887，并补齐 Secure MCP
  Tunnel doctor 所需的 HTTP MCP OAuth 发现元数据。
- Tunnel doctor 改用临时 loopback 端口，允许在正式 Tunnel 服务运行时完成诊断。
- `journal_get_entry` 使用标准 MCP Resource 内容块承载完整正文，普通文本和
  `structuredContent` 只保留元数据与脱敏长度。
- MCP 升级脚本在 Windows 自动停止依赖 Tunnel 后恢复其原运行状态，并等待 Tunnel ready。
- 服务验证将认证、LAN 隔离、单进程监听和敏感日志扫描改为失败即非零退出。

### Verified

- 真实链路：新 UI 写入 → `/journal/sync` → 服务端落库 → MCP `journal_get_entry` /
  `journal_list_recent` 读回 → 新设备拉取还原，浏览器控制台零错误。
- 真机：Redmi Note 11T Pro（Android 15）经网络 ADB 安装调试包，竖屏、横屏、深色、抽屉、
  输入法工具条与四个页面逐项走查通过。

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
