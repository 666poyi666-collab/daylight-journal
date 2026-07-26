# 开发与发布手册

## 环境

- Node.js 20 或更高版本
- npm
- Android 构建需要 JDK 21 与 Android SDK
- 浏览器回归需要本机 Chrome 或 Edge

## 首次启动

```powershell
npm install
npm run dev
```

同步与 MCP 服务单独启动：

```powershell
npm run mcp
curl.exe -s http://127.0.0.1:8780/healthz
```

`data/journals.json` 是个人运行数据，禁止提交。公开构建默认连接本机
`http://127.0.0.1:8780`。远端地址和 ChatGPT 项目必须在构建时显式注入：

```powershell
$env:VITE_JOURNAL_API_URL = 'https://your-sync.example.com'
$env:VITE_CHATGPT_PROJECT_URL = 'https://chatgpt.com/g/your-project'
npm run build
```

Vite 的 `VITE_*` 变量会进入客户端包，不能用于保存秘密。服务端密钥只放在运行环境的
`JOURNAL_API_TOKEN` 或运行时生成的 token 文件，不得写入代码、APK 或 `.env.example`。

## 日常开发

1. 阅读根目录 `AGENTS.md`、`README.md`、`docs/README.md` 和任务专题文档。
2. 写明根因、影响范围和验收方式，再做最小改动。
3. 业务行为、技术协议和视觉决策分别更新对应文档。
4. 使用虚构测试数据；不得让 E2E 请求命中真实同步服务。
5. 提交前检查变更、敏感信息、构建与测试结果。

## 验证命令

```powershell
npm run lint
npm run test:unit
npm run build
```

运行前端开发服务后执行：

```powershell
npm run test:e2e
```

PWA 或 service worker 变更额外执行：

```powershell
npm run test:pwa
```

同步/MCP 变更还要验证 `/healthz`、`/readyz`、`/metrics`、`/v1/*`、兼容同步接口和相关 MCP 工具，
测试数据目录必须通过 `JOURNAL_DATA_DIR` 隔离。

Windows 服务、Tunnel、Inspector 和 ChatGPT 验收命令见 `MCP-OPERATIONS.md`。不得用
PersonalMcpGateway 的服务、profile、端口或密钥代替 Journal 独立链路。

手机/平板不使用桌面 loopback。安装版在 Private/LocalSubnet 的 8781 发布
`_poyi-journal._tcp.local`，设置页保存发现到的 `.local` 地址和配对令牌。调试和生产均
禁止以 ADB 转发或固定 IP 作为长期同步配置。

## Android 构建

```powershell
npm run build
npx cap copy android
.\android\gradlew.bat -p android assembleDebug
```

调试 APK 位于 `android/app/build/outputs/apk/debug/app-debug.apk`。APK 作为 GitHub Release
附件发布，不提交到 Git。正式分发前必须配置独立签名、更新 `versionCode`/`versionName`，
并在目标设备上重新安装验证；调试签名包只用于测试。

## 发布检查表

- 需求编号和范围已确认。
- `CHANGELOG.md` 已更新；相关 Bug 状态和回归证据已更新。
- 源码扫描不含真实日记、令牌、Cookie、个人 URL、日志或签名文件。
- Build、Lint、单元测试及受影响的 E2E/PWA/接口测试通过。
- Android 变更已重建、安装并检查目标设备。
- GitHub Release 标明版本、构建类型、安装限制和校验值。

## 文档归属

需求写 `REQUIREMENTS.md`，产品边界写 `PRODUCT.md`，代码事实写 `ARCHITECTURE.md`，
同步协议写 `SYNC-MCP.md`，视觉决策写 `UX-VISUAL-DIRECTION.md`，缺陷写 `BUGS.md`，
版本变化写 `CHANGELOG.md`。一次性讨论只有转写到这些文件后才成为长期项目事实。
