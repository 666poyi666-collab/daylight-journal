# AI Coding 与项目治理

## 工作流

1. 先让 AI 复述需求边界和当前代码事实，并绑定 `FR-xxx` 或 `NFR-xxx`。
2. 读取 Bug 台账和最近一次迭代日志；新需求先登记，发现 Bug 或风险立即编号。
3. 先做最小可验证改动，不默认引入 agent、复杂 skill 或额外 MCP。
4. 每一步都留下可读日志：请求、响应状态、关键状态变化和失败原因。
5. 先修根因，再做视觉或架构扩展；不要用临时桥接掩盖同步问题。
6. 完成后把新增、修改、删除、Bug、需求分析、验证和遗留项写入 `ITERATION-LOG.md`。
7. 执行治理校验、构建、接口检查和目标设备验收，并记录结果。

## 上下文与资产

项目级规则放在根目录 `AGENTS.md`，模块级事实放在模块 `MODULE.md`，任务级信息只在当前任务中补充。组件说明使用 `COMPONENT-TEMPLATE.md`，验证过的提示词登记到 `PROMPT-LIBRARY.md`，避免知识只存在于某一次对话里。

## 日志标准

遇到 bug 时记录：

- 用户动作和预期
- 实际表现
- 复现步骤
- 相关端（网页/手机/平板/服务端）
- 请求 URL、HTTP 状态和时间
- 最小修复与回归结果

日志不得包含完整日记正文、凭证或浏览器会话信息。

## 变更验收

- `npm run build` 成功
- `npm run lint` 与 `npm run test:unit` 成功；纯模型、合并和存储错误矩阵可在无浏览器数据的环境执行
- 本地 Vite 服务运行时执行 `npm run test:e2e`；测试必须拦截 `/journal/*`，不得向真实同步副本写入测试日记
- PWA 或 service worker 变更执行 `npm run build && npm run test:pwa`；测试使用临时预览进程，不依赖真实同步服务
- 同步服务 `/health` 正常
- 新日记能在本端刷新后保留
- 手机写入后，平板重新进入应用能看到
- ChatGPT 项目中能调用对应 MCP 工具
- 失败时 UI 不丢稿，并能明确显示离线状态

## 文档治理

- 产品行为写 `PRODUCT.md`
- 可验收的用户需求写 `REQUIREMENTS.md`
- 技术事实写 `ARCHITECTURE.md`
- 开发、测试和发布步骤写 `DEVELOPMENT.md`
- 接口、部署和 MCP 写 `SYNC-MCP.md`
- AI 开发约束写本文档
- 视觉决策写 `UX-VISUAL-DIRECTION.md`
- Bug 现状与回归证据写 `BUGS.md`
- 版本级用户可感知变更写 `CHANGELOG.md`
- 每次开发的完整操作闭环写 `ITERATION-LOG.md`
- 不把临时命令、真实数据和截图堆在根目录
