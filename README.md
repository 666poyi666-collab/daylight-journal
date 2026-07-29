# 拾光 · 日记复盘

拾光是一个面向个人使用的跨端日记工作台：网页、Android 手机和平板共用一套日记数据，并通过 MCP 让 ChatGPT 在「日记」项目中完成复盘。

当前阶段优先保证三件事：记录足够顺手、跨端同步可靠、AI 读取路径清晰。前端已完成 Editorial Paper 视觉重构，设计与响应式约束见 [`docs/UX-VISUAL-DIRECTION.md`](docs/UX-VISUAL-DIRECTION.md)。

## 当前能力

- 今日记录、历史记录、日历、标题、可排序记录片、分次写作时间、心情和标签
- 自动保存到本地 localStorage
- 手机、平板、网页通过同步服务合并日记
- ChatGPT 自定义连接器「拾光日记」
- 独立 Journal MCP：7 个 `journal_*` 工具和按日期读取完整正文的 Resource
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

公开构建不会内置个人 Tunnel、设备凭据、根密钥或 ChatGPT 项目标识。未配置 URL 时仍显示
`http://127.0.0.1:8780`，但生产客户端只调用 `/sync/v2/*`；必须在设置页保存有效的
`dj1` 设备凭据和共享 `jk1` 根密钥后才会同步，不会回退 `/journal/*` 或 V1。

Android：

```bash
npx cap copy android
./android/gradlew.bat -p android assembleDebug
```

真机 staging 验收使用独立包名与存储沙箱，避免读取或覆盖正式 Journal 数据：

```powershell
$env:VITE_JOURNAL_API_URL = 'https://<journal-staging-worker>'
npm run build
npx cap copy android
./android/gradlew.bat -p android assembleStaging
```

staging 包以“拾光 Staging”独立显示，只用于验收；完成后清除构建变量并重新执行
默认 build/copy，不能把 staging 资源当作 production APK 发布。

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
生产同步 authority 必须提供 `/sync/v2/exchange` 和 `/sync/v2/objects/*`。

手机/平板同步：通过设置页保存 mDNS 地址（`http://<host>.local:8781`）和独立配对令牌；
LAN listener 不提供 `/mcp`，不依赖 ADB 或固定 IP。

MCP 接口：`http://127.0.0.1:8780/mcp`

ChatGPT 通过项目独立的 `PoyiJournalTunnel` 访问 MCP。Tunnel 是只出站的 Secure MCP
Tunnel，MCP 不直接暴露公网，也不依赖 PersonalMcpGateway。安装、密钥和验收流程见
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
- [`docs/CHANGELOG.md`](docs/CHANGELOG.md)：按版本维护的开发变更日志
- [`docs/UX-VISUAL-DIRECTION.md`](docs/UX-VISUAL-DIRECTION.md)：Soft Tech 视觉方向与前端重构约束
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

数据默认保存在浏览器本地，并同步到服务端 `data/journals.json`。不要把真实日记提交到 Git。
