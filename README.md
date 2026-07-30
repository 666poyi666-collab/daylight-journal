# 拾光 · 日记复盘

拾光是一个面向个人使用的跨端日记工作台：网页、Android 手机和平板共用一套日记数据，并通过 MCP 让 ChatGPT 在「日记」项目中完成复盘。

当前阶段优先保证三件事：记录足够顺手、跨端同步可靠、AI 读取路径清晰。前端视觉为 Ink & Daylight（暖纸墨色 + 单一赭金强调色 + 发丝线分层），设计与响应式约束见 [`docs/UX-VISUAL-DIRECTION.md`](docs/UX-VISUAL-DIRECTION.md)。

## 当前能力

- 今日记录、历史记录、日历、标题、可排序记录片、分次写作时间、心情和标签
- 自动保存到本地 localStorage
- 可选应用锁：4–6 位数字密码本机哈希存储，防翻看；不加密数据、不上传密码
- 书写字体可选衬线/黑体：衬线为默认，中文衬线子集随应用打包，手机离线同样生效
- 手机、平板、网页通过 Journal Cloud Worker 合并日记；电脑关机时云端仍在线
- ChatGPT 自定义连接器「拾光日记」
- 独立 Journal Cloud MCP：OAuth 只读工具和按日期读取完整正文的 Resource，不依赖电脑在线
- 点击 AI 复盘时固定打开 ChatGPT「日记」项目，并复制复盘提示词
- Markdown 导出，方便后续进入 Obsidian

## 开发

```bash
npm install
npm run dev
npm run build
npm run lint
npm run test:unit
# 保持 dev 服务运行后，在另一终端执行
npm run test:e2e
# 先 build；脚本会自行启动并关闭生产预览
npm run test:pwa
```

需要连接远端同步服务或固定 ChatGPT 项目时，在构建环境中设置：

```powershell
$env:VITE_JOURNAL_API_URL = 'https://your-sync.example.com'
$env:VITE_CHATGPT_PROJECT_URL = 'https://chatgpt.com/g/your-project'
npm run build
```

公开构建不会内置设备凭据、根密钥或 ChatGPT 项目标识。未配置 URL 时不启动远端同步；
生产客户端只调用 `/sync/v2/*`；必须在设置页保存有效的
`dj1` 设备凭据和共享 `jk1` 根密钥后才会同步，不会回退 `/journal/*` 或 V1。

Android：

```bash
npx cap copy android
./android/gradlew.bat -p android assembleDebug
```

发布候选只构建一次。先记录 commit、`dist` hash 和 APK hash，再用虚构数据连接 staging；
staging 通过后直接提升同一份 `dist`/APK，不重新 build，也不制作另一版 UI：

```powershell
npm run build
npx cap copy android
./android/gradlew.bat -p android assembleDebug
Get-FileHash android/app/build/outputs/apk/debug/app-debug.apk -Algorithm SHA256
```

staging endpoint、虚构 `dj1` 与测试 `jk1` 通过现有设置页配置，不进入构建。验收设备必须先
备份并清空应用数据，避免把 production 日记带入 staging；不能用 `assembleStaging` 产物替代
最终待发布 APK。

## Android 安装包

测试版 APK 在 [GitHub Releases](https://github.com/666poyi666-collab/daylight-journal/releases)
下载。当前附件使用 Android debug 签名，仅用于测试安装；升级或正式分发前应配置独立的
release 签名和版本号。

## 服务

启动同步与 MCP 服务：

```bash
npm run mcp
```

`http://127.0.0.1:8780/journal/*` 是旧本地兼容接口，不再是生产客户端数据链路。
生产同步 authority 必须提供 `/sync/v2/exchange`；云端对象路由永久禁用并返回 410。

手机/平板同步：通过设置页保存 mDNS 地址（`http://<host>.local:8781`）和独立配对令牌；
LAN listener 不提供 `/mcp`，不依赖 ADB 或固定 IP。

MCP 接口：`http://127.0.0.1:8780/mcp`

Windows 安装服务同时在 `http://127.0.0.1:8780/` 提供当前 `dist` 的可安装 PWA；
它与 MCP 共用进程但不共用正文 API 凭据，8781 仍只处理附件密文。
非管理员安装可执行 `desktop/install-pwa.ps1`，使用当前用户的登录启动项在
`http://127.0.0.1:8782/` 持久提供同一构建，并创建无浏览器工具栏的“拾光”
Edge App 开始菜单入口。

ChatGPT 生产连接器直接访问 Journal 自己的 Cloud OAuth MCP，因此电脑关机后仍能读取
已同步正文。它不依赖 PersonalMcpGateway 或其他产品；本机 `PoyiJournalTunnel` 仅保留
兼容维护。部署、OAuth 和 PC-off 验收流程见
[`docs/MCP-OPERATIONS.md`](docs/MCP-OPERATIONS.md)。

## 文档入口

- [`docs/README.md`](docs/README.md)：文档索引与项目状态
- [`docs/PRODUCT.md`](docs/PRODUCT.md)：产品边界与核心交互
- [`docs/REQUIREMENTS.md`](docs/REQUIREMENTS.md)：用户需求、验收条件与追踪关系
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)：代码、数据与端到端架构
- [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md)：本地开发、测试与发布流程
- [`docs/SYNC-MCP.md`](docs/SYNC-MCP.md)：同步协议与 ChatGPT/MCP 配置
- [`docs/MCP-OPERATIONS.md`](docs/MCP-OPERATIONS.md)：独立 MCP、Windows 服务、Tunnel 与验收手册
- [`docs/AI-CODING-GUIDE.md`](docs/AI-CODING-GUIDE.md)：AI coding 工作流、日志和验收规则
- [`docs/BUGS.md`](docs/BUGS.md)：已知问题、修复记录与 Bug 模板
- [`docs/ITERATION-LOG.md`](docs/ITERATION-LOG.md)：每次开发的操作、需求、Bug 与验证闭环
- [`docs/CHANGELOG.md`](docs/CHANGELOG.md)：按版本维护的开发变更日志
- [`docs/UX-VISUAL-DIRECTION.md`](docs/UX-VISUAL-DIRECTION.md)：Ink & Daylight 视觉方向与响应式约束
- [`docs/ROADMAP.md`](docs/ROADMAP.md)：阶段计划与暂不做事项

## 目录约定

```text
src/                 React 应用
public/              PWA 静态资源
android/             Capacitor Android 工程
mcp/                 独立 Journal MCP、Windows 服务与 Tunnel
mcp-server.mjs       兼容启动入口
edge-bridge.mjs      旧版 Edge 桥接实验，不是主链路
data/                MCP 服务运行数据（本地生成，不提交隐私内容）
docs/                项目文档与治理规则
```

数据默认保存在浏览器本地，并通过 Journal Cloud V2 同步设备密文副本和无附件 MCP
正文镜像。本机 `data/journals.json` 只属于旧兼容服务，不是生产同步 authority。不要把真实日记提交到 Git。
