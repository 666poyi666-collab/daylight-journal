# 迭代操作日志

本文件是每次开发的统一入口，记录“为什么改、改了什么、怎么验证、还剩什么”。它不替代：

- `REQUIREMENTS.md`：需求基线、状态、统计与分析。
- `BUGS.md`：可复现 Bug、工程风险、根因与防复发证据。
- `CHANGELOG.md`：版本级、用户可感知的变化。

编号格式为 `ITER-YYYYMMDD-NN`，同一天从 `01` 递增。每次开发必须新增记录，不覆盖历史；文件路径使用仓库相对路径，删除项也必须保留原因。日志必须脱敏。

## ITER-20260730-01：建立每次迭代的治理闭环

- 关联需求：NFR-006、NFR-010
- 根因：现有需求、Bug 和变更文档彼此独立，缺少逐次开发的统一操作入口和自动结构校验。
- 影响范围：AI 协作规则、需求流程、开发手册、文档索引、CI 与 npm scripts；不改变产品运行行为和用户数据。
- 验收方式：运行 `npm run check:governance`、`npm run lint`、`npm run test:unit` 和 `npm run build`；确认 Git diff 只包含治理文件。

### 操作日志

#### 新增

- `docs/ITERATION-LOG.md`：建立迭代编号、操作清单、Bug、需求分析、验证和遗留项的统一模板。
- `scripts/check-governance.mjs`：检查治理文档、编号唯一性和迭代记录必填结构。

#### 修改

- `AGENTS.md`：把需求、Bug 和迭代日志设为每次开发的强制前置与完成条件。
- `README.md`、`docs/README.md`：增加迭代日志入口。
- `docs/REQUIREMENTS.md`：新增 NFR-010，并补当前需求统计与重点分析。
- `docs/DEVELOPMENT.md`、`docs/AI-CODING-GUIDE.md`：补齐开工、落账和验收顺序。
- `docs/CHANGELOG.md`：登记用户要求建立的持续治理能力。
- `package.json`、`.github/workflows/ci.yml`：增加并执行 `check:governance`。

#### 删除

- 无。

### Bug 记录

- 本轮未发现新的产品 Bug；解决的是缺少统一迭代追踪和自动结构校验的治理缺口。

### 用户需求统计与分析

- 用户明确要求每次迭代都记录操作删改、Bug 与防复发信息、需求统计与分析。
- 本轮新增 NFR-010；功能需求总数不变，非功能需求由 9 项增至 10 项。
- 该需求属于长期维护基础设施，后续所有功能和修复均必须引用本日志、需求基线和 Bug 台账。

### 验证结果

- `npm run check:governance`：通过；识别 18 项功能需求、10 项非功能需求、20 个 Bug、4 个风险和 1 次迭代。
- `npm run lint`：通过。
- `npm run test:unit`：39 项测试全部通过，无失败、跳过或待办。
- `npm run build`：通过；TypeScript 与 Vite 生产构建成功。
- `git diff --check`：通过；工作区仅包含本轮治理文件变更，无产品运行代码和用户数据变更。

### 遗留项

- 现有历史变更继续以 `CHANGELOG.md` 和 `BUGS.md` 为准，不伪造过去不存在的逐次操作记录。

## ITER-20260730-02：完成 production 迁移与 Cloud MCP 真实验收

- 关联需求：FR-009、FR-010、FR-013、FR-015、FR-018，NFR-007、NFR-008、NFR-010
- 根因：production 旧明文行尚未完成 encrypted-only cutover，且 migration readiness 先前
  遮蔽了 Cloudflare service binding 丢失标准 `Authorization` 所导致的 OAuth introspection 401。
- 影响范围：production D1 旧数据迁移、Journal/OAuth Worker 的服务间 introspection、
  ChatGPT 只读连接器和同步/MCP 运维文档；不修改冻结 UI，不上传附件。
- 验收方式：迁移前后核对 source/ledger/密文/MCP 投影；验证 OAuth 与 Journal ready；
  在 ChatGPT 真实调用四个只读工具、embedded Resource 与 PC-off 等价状态；运行主仓治理、
  lint、单元测试、生产构建和 diff 检查，并运行两端 Worker 契约/安全测试。

### 操作日志

#### 新增

- production cutover ledger：记录旧表已在双投影一致后完成一次性切换；不含正文。

#### 修改

- `docs/REQUIREMENTS.md`：将 FR-010、FR-013、FR-015、FR-018 更新为 production 已完成并重算统计。
- `docs/BUGS.md`：登记 BUG-021 的 readiness 遮蔽与 service-binding 凭据头根因及回归证据。
- `docs/MCP-OPERATIONS.md`、`docs/SYNC-MCP.md`、`docs/ARCHITECTURE.md`：补 production
  cutover、OAuth introspection 转发约束、ChatGPT 四工具/Resource 与 PC-off 证据。
- `docs/CHANGELOG.md`：登记用户可感知的生产同步和 ChatGPT 读取恢复。
- Journal Cloud Worker `src/oauth.ts`、`tests/worker-contract.test.mjs`：服务绑定请求重复发送
  secret-backed Basic 凭据到专用头，并验证标准头与专用头完全一致。
- OAuth Worker `src/worker.ts`、`tests/security.test.ts`：接受标准头或专用头，对冲突值返回 401。
- Journal Cloud Worker `tests/worker-contract.test.mjs`：把测试启动器的 Wrangler 固定版本从
  4.114.0 对齐到项目已锁定的 4.115.0，消除 Windows 回归中的版本漂移。
- 两个 Cloud Worker 的 `README.md`：记录专用头只适用于 service binding，认证语义不变。

#### 删除

- production 旧明文源表已由 `0011_legacy_cutover.sql` 删除；临时 owner credential
  rotation endpoint 已撤销，公网复验为 404。

### Bug 记录

- 新增并修复 BUG-021：migration 未完成时 `/readyz` 的 `cutover_required` 掩盖了 OAuth
  introspection 失败；cutover 后定位到 service binding 不转发标准 `Authorization`。
- 修复采用双头同值与 OAuth 冲突拒绝，没有放宽 issuer、audience、scope、签名或 introspection。
- 新增并修复 BUG-022：最终全量复跑发现契约启动器仍固定 Wrangler 4.114.0；失败用例
  单独复跑均通过，随后将启动器对齐项目锁定的 4.115.0 并重新执行全量契约。

### 用户需求统计与分析

- 功能需求仍为 18 项；production 验收使已完成项由 12 项增至 16 项。
- FR-009 的密文副本与无附件 MCP 投影在旧数据上完成 production 一致性验证。
- FR-010、FR-013、FR-015、FR-018 已闭环；剩余 FR-016、FR-017 仅是附件双端真机验收，
  不影响正文 Cloud 同步和 ChatGPT PC-off 复盘。
- 未新增需求；KR-001 的整日 last-write-wins 限制仍存在，不宣称 block 级无冲突合并。

### 验证结果

- production migration：旧行 7、discovered 7、completed 7、pending 0；缺失密文副本 0、
  缺失 MCP 投影 0；cutover 后旧表 0、不完整迁移 0、cutover ledger 1。
- production readiness：OAuth 与 Journal `/readyz` 均为 200；Journal 为 `oauth=ready`、
  `migration=complete`、`storage=encrypted_replica_plus_mcp_read_model`。
- ChatGPT：四个只读工具成功；可读条目为非零、revision 为非零；embedded Resource
  实体化和读取成功、内容长度大于 0，验收没有记录正文或元数据。
- PC-off 等价复验：Cloud status 返回 `journal_cloud_authoritative`、`pcOffReadable=true`
  和非零可读计数；未使用本机 8780、Tunnel 或 Gateway。
- OAuth Worker：typecheck、34 项安全测试、6 项脚本测试通过。
- Journal Cloud Worker：typecheck、8 项 Worker 契约测试通过。
- `npm run check:governance`：通过；识别 18 项功能需求、10 项非功能需求、22 个 Bug、
  4 个风险和 2 次迭代。
- `npm run lint`：通过。
- `npm run test:unit`：39 项全部通过，无失败、跳过或待办。
- `npm run build`：通过；TypeScript 与 Vite production build 成功。
- 主仓及两个 Cloud Worker 仓库 `git diff --check`：通过，仅有既有 LF/CRLF 提示。

### 遗留项

- FR-016、FR-017 仍待双端附件真机验收；不影响本轮正文同步、迁移和 PC-off MCP 结论。
- KR-001、KR-005、KR-006、KR-007 状态不变。

## ITER-20260730-03：统一拾光品牌图标

- 关联需求：FR-019、NFR-003、NFR-005、NFR-010
- 根因：现有 PWA 主图标是 1.7MB 高细节 3D 位图，favicon 和 Android adaptive
  foreground 仍保留旧模板资产；缩到启动器、浏览器标签和 ChatGPT 插件后不可稳定识别。
- 影响范围：品牌母版、PWA manifest/favicon、Android launcher/splash、ChatGPT 插件上传资产
  和视觉文档；不修改页面布局、日记数据或同步/MCP 协议。
- 验收方式：确认图标在 24/48/192/512px 清晰，Android adaptive safe zone 不裁核心图形，
  ChatGPT PNG 至少 256px 且不超过 10KB；运行治理、lint、unit、build 和 Android assemble。

### 操作日志

#### 新增

- `resources/icon-journal-sunrise.svg`：无文字、五色以内的品牌矢量母版。
- `resources/chatgpt-plugin-icon.png`：256×256、5.9KB 的 ChatGPT 插件上传资产。
- `public/icon-journal-sunrise.svg`、`public/icon-journal-sunrise-192.png`、
  `public/icon-journal-sunrise-512.png`、`public/icon-journal-sunrise-maskable-512.png`、
  `public/favicon.png`：Web/PWA 尺寸与 maskable 资产。

#### 修改

- `docs/REQUIREMENTS.md`、`docs/BUGS.md`、`docs/ITERATION-LOG.md`：登记需求、缺陷和本轮验收。
- `resources/icon-journal-sunrise.png`、`public/icon-journal-sunrise.png`、`public/favicon.svg`：
  以扁平母版替换旧 3D/模板图，主 Web 图由约 1.7MB 降至约 12KB。
- `public/manifest.webmanifest`、`index.html`、`public/sw.js`：声明 ordinary/maskable/favicon，
  预缓存新资产并将 cache namespace 从 v4 提升到 v5。
- `tests/desktop-pwa.test.mjs`：锁定 manifest 图标清单、PNG 尺寸、插件 10KB 预算、
  favicon 品牌色与 Service Worker v5，防止模板图标和旧缓存回归。
- `android/app/src/main/res/`：替换 adaptive vector、各密度 launcher/round/foreground 和
  横竖屏 splash，统一背景为 Ink & Daylight 纸色。
- `docs/UX-VISUAL-DIRECTION.md`、`docs/CHANGELOG.md`：记录图标视觉规则、文件预算和用户变化。

#### 删除

- 无文件删除；旧 Vite、Capacitor 和高细节 3D 图像内容已由同路径新资产替换。

### Bug 记录

- BUG-023 已修复并真机回归：PWA、favicon、Android 和插件上传资产已统一。
- BUG-024 已修复并真机回归：Service Worker v5 不再返回旧缓存图标。

### 用户需求统计与分析

- 功能需求由 18 项增至 19 项；已完成项由 16 项增至 17 项。FR-019 只收敛品牌资产，
  不扩张运行功能。
- 当前同步和 Cloud MCP 结论不变；图标改动不接触正文、凭据、Worker 或数据库。

### 验证结果

- 尺寸/预算：主 PWA PNG 512×512、12,039 bytes；ChatGPT PNG 256×256、5,898 bytes；
  manifest ordinary 192/512 与 maskable 512 均存在。
- `npm run check:governance`：通过；识别 19 项功能需求、10 项非功能需求、24 个 Bug、
  4 个风险和 3 次迭代。
- `npm run lint`、`npm run build`：通过。
- `npm run test:unit`：40 项全部通过，包含新增品牌资产预算回归。
- `npm run test:pwa`：通过；离线壳在 Service Worker v5 下可恢复。
- `npm run test:e2e`：通过；使用已确认属于本项目的独立 Vite 端口，避免本机其他应用和
  Android emulator 占用默认端口产生误判。
- Android：`npx cap copy android`、`:app:assembleDebug` 和 ADB 覆盖安装成功；
  Redmi Note 11T Pro（Android 15）冷启动动画与锁屏均显示新图标。
- `git diff --check`：通过，仅有既有 LF/CRLF 提示。

### 遗留项

- ChatGPT 已连接 development 插件不提供创建后的图标编辑入口；为避免破坏已验收 OAuth
  连接，本轮不删除重建，上传资产已备好供下一次换版使用。
- FR-016、FR-017 的附件双端真机验收和既有 KR 状态不变。

## 新迭代填写规则

复制上一条记录的结构并替换内容。每条记录必须包含关联需求、根因、影响范围、验收方式，以及操作日志（新增/修改/删除）、Bug 记录、用户需求统计与分析、验证结果和遗留项。没有内容的栏目明确写“无”，不得删除栏目。
