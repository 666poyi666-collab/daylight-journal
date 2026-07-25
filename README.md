# 拾光 · 日记复盘

拾光是一个面向个人使用的跨端日记工作台：网页、Android 手机和平板共用一套日记数据，并通过 MCP 让 ChatGPT 在「日记」项目中完成复盘。

当前阶段优先保证三件事：记录足够顺手、跨端同步可靠、AI 读取路径清晰。前端已完成 Editorial Paper 视觉重构，设计与响应式约束见 [`docs/UX-VISUAL-DIRECTION.md`](docs/UX-VISUAL-DIRECTION.md)。

## 当前能力

- 今日记录、历史记录、日历、标题、可排序记录片、分次写作时间、心情和标签
- 自动保存到本地 localStorage
- 手机、平板、网页通过同步服务合并日记
- ChatGPT 自定义连接器「拾光日记」
- 三个只读 MCP 工具：`get_today_journal`、`get_journal_by_date`、`list_recent_journals`
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

公开构建不会内置个人 Tunnel 或 ChatGPT 项目标识。未配置时，同步服务默认连接
`http://127.0.0.1:3001`，ChatGPT 入口默认打开首页。

Android：

```bash
npx cap copy android
./android/gradlew.bat -p android assembleDebug
```

## Android 安装包

测试版 APK 在 [GitHub Releases](https://github.com/666poyi666-collab/daylight-journal/releases)
下载。当前附件使用 Android debug 签名，仅用于测试安装；升级或正式分发前应配置独立的
release 签名和版本号。

## 服务

启动同步与 MCP 服务：

```bash
npm run mcp
```

本地同步接口：`http://127.0.0.1:3001/journal/*`

MCP 接口：`http://127.0.0.1:3001/mcp`

公网连接器可使用 Cloudflare Tunnel。Quick Tunnel 重启后地址可能改变，应通过
`VITE_JOURNAL_API_URL` 在构建时注入，禁止把个人临时地址提交到仓库。

## 文档入口

- [`docs/README.md`](docs/README.md)：文档索引与项目状态
- [`docs/PRODUCT.md`](docs/PRODUCT.md)：产品边界与核心交互
- [`docs/REQUIREMENTS.md`](docs/REQUIREMENTS.md)：用户需求、验收条件与追踪关系
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)：代码、数据与端到端架构
- [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md)：本地开发、测试与发布流程
- [`docs/SYNC-MCP.md`](docs/SYNC-MCP.md)：同步协议与 ChatGPT/MCP 配置
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
mcp-server.mjs       同步服务与 MCP 服务
edge-bridge.mjs      旧版 Edge 桥接实验，不是主链路
data/                MCP 服务运行数据（本地生成，不提交隐私内容）
docs/                项目文档与治理规则
```

数据默认保存在浏览器本地，并同步到服务端 `data/journals.json`。不要把真实日记提交到 Git。
