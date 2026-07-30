# 变更日志

格式参考 Keep a Changelog。当前项目尚未形成稳定发布节奏，早期记录依据仓库现有文档、
代码和测试重建，不把不可访问的历史聊天内容当作事实。

## [Unreleased]

### Added

- 新增统一的拾光扁平品牌图标母版，以及 PWA ordinary/maskable、favicon 和 5.9KB
  ChatGPT 插件上传资产。
- 建立强制迭代台账与治理校验：每次开发统一记录关联需求、文件新增/修改/删除、Bug、需求分析、验证结果和遗留项。
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
- 书写字体：正文与历史预览默认衬线（Source Serif 4 + 自制思源宋体 GB2312 子集
  约 1.3MB 随包分发，Android 无系统宋体也能成立），设置页可切回黑体；
  预览样片按各自字族渲染，偏好只存本机。

### Changed

- PWA、应用内品牌位、Android adaptive/legacy/round launcher 和横竖屏 splash 统一为
  “日记本＋晨光＋书签”标记；主 PWA 图由约 1.7MB 降至约 12KB。
- V2 同步新增 `legacyImports`/`legacyHasMore` 与 durable `migrationIds`：客户端先恢复 outbox、
  再拉取并原子保存旧行，按日期去重/合并后以每批最多 25 条回传；两设备竞争只允许一方完成 ledger。
- staging 与 production 改为提升同一 commit 和同一构建产物；同步 endpoint 与独立 `dj1`/共享
  `jk1` 通过现有设置页配置，不再为 production 重新制作 UI 或 build。
- Journal V2 mutation 现在同时提交设备密文副本与无附件 `mcpEntry`；正文、标题、记录片、
  心情、标签和时间戳可由 Journal Cloud OAuth MCP 在电脑关机时读取，`jk1` 根密钥仍只留本机。
- ChatGPT 生产主链路改为 Journal 自己的 Cloud Worker `/mcp`；本机
  `PoyiJournalMcp`/`PoyiJournalTunnel` 降为兼容维护，不再作为 PC-off 前提。
- Journal 客户端正文同步切换到 AES-256-GCM V2：durable outbox、首次拉取、显式删除、tombstone 恢复和冲突重排均走 `/sync/v2/exchange`，不再回退明文 V1。
- 封面附件退出云端对象链路，改为电脑与手机同网/直连时的独立 AES-GCM V1 通道；公网 URL 在请求前被拒绝，云 mutation 固定 `objects=[]`。
- LAN 8781 收窄为认证后的附件密文 GET/PUT，不再复制 8780 的正文业务 API、兼容 `/journal/*` 或 MCP。
- 设置页增加 `dj1` 设备凭据与 `jk1` 根密钥的显式设备批准流程。
- 编辑器构图重排为「一页」：写作区变成深色桌面上的一张纸（页缘投影、底部纸口、
  书签丝带），当天日号以极淡巨大衬线浮印在页面右上；右栏从卡片堆退成页边注记，
  侧栏最近记录改为带点线引导的目录样式，激活态用书脊墨线取代白色盒子。
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

- 修复 favicon 仍为 Vite 默认图、Android splash 仍为 Capacitor 标志，以及 Service Worker
  v4 缓存导致安装新版后锁屏继续显示旧 3D 图标的问题；cache namespace 已提升为 v5。
- 修复 Cloudflare service binding 不转发标准 `Authorization` 导致生产 OAuth introspection
  401、ChatGPT 四个 Journal 工具全部失败的问题；专用转发头保持 Basic 语义，冲突双头
  fail-closed。production 四工具、embedded Resource 与 PC-off 等价调用已通过。
- 修复复盘提示词保留 `journal://entries/{date}` 占位符的问题；现在复制实际所选日期 URI，
  且点击复盘仍等待当前本地 revision 完成 ACK。
- 修复旧 7 条明文云记录缺少一次性、可重试迁移闭环的问题；migration ledger、密文实体、
  MCP 镜像、change 与 ACK 原子提交，cutover 在任何一条缺失时 fail-closed。
- 修复 Cloud MCP 只能列密文 revision、无法在电脑关机后向 ChatGPT 返回真实正文的问题；
  D1 可读镜像只在 ACK 时更新，冲突不覆盖，删除会清除，恢复按更高 revision 重建。
- 修复 `journal_get_status` 被 OAuth scope 路由误判为写操作的问题；Cloud MCP 四个工具均使用
  `journal:read`，设备 token、管理员 key 与 OAuth token 保持隔离。
- 附件直连增加持久化密文 pending、幂等重放、tombstone、相同时间戳分歧与 revision 回退拒绝；附件 materialize 成功后才提交本地观察状态。
- 8781 附件服务改用独立持久化 capability；主 API token 无法访问附件，MCP 工具和 Resource 不再序列化附件或附件存在性。
- 补齐 ACK 提交崩溃重试、重复附件提交、错误根密钥、tombstone 与断线重连回归。
- 修复浏览器默认 `fetch` 被当作同步客户端成员调用时的 `Illegal invocation`，使真实 App 保存与附件 outbox 能发出 V2 mutation exchange。
- V2 首次拉取在当前附件缺失或 manifest 不匹配时不再推进 cursor，并串行化显式删除与在途同步，避免本地原子快照被并发覆盖。
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

- production 旧数据迁移完成 7/7 ledger、密文副本/MCP 投影一致性与 encrypted-only
  cutover；OAuth/Journal ready 均为 200，正式只读 ChatGPT 连接器完成四工具和 Resource
  脱敏验收，重复 Cloud 状态调用确认电脑关机不影响读取。
- 隔离 Cloudflare Worker/D1 使用真实 RS256 `at+jwt` 与 introspection 完成
  `initialize → tools/list → journal_get_entry → resources/read`，读取非空测试正文；删除后正文不可读、
  恢复后重新可读，D1/MCP 不含 `coverImage`、图片字节、路径或附件存在性。
- 历史本机兼容链路：新 UI 写入 → `/journal/sync` → 本机服务落库 → MCP 读回 → 新设备
  拉取还原；该证据不再用于宣称 PC-off。
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
