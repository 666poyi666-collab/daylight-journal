# 拾光项目文档

## 项目判断

拾光不是“再做一个富文本编辑器”，而是一个低摩擦的个人复盘入口：先记录，再由用户选择是否交给 ChatGPT 复盘。AI 是复盘能力，不应阻塞写作。

## 文档地图

| 文档 | 用途 |
| --- | --- |
| [PRODUCT](PRODUCT.md) | 明确第一阶段做什么、不做什么 |
| [REQUIREMENTS](REQUIREMENTS.md) | 用户需求、非功能要求和验收追踪 |
| [ARCHITECTURE](ARCHITECTURE.md) | 代码、数据和端到端链路 |
| [DEVELOPMENT](DEVELOPMENT.md) | 环境准备、开发、测试和发布流程 |
| [SYNC-MCP](SYNC-MCP.md) | 多端同步、MCP 工具和 ChatGPT 项目 |
| [MCP-OPERATIONS](MCP-OPERATIONS.md) | 独立 MCP 服务、Tunnel、密钥、运维和验收 |
| [AI-CODING-GUIDE](AI-CODING-GUIDE.md) | AI 开发工作流、日志和验收 |
| [BUGS](BUGS.md) | 已知问题、修复记录和回归证据 |
| [CHANGELOG](CHANGELOG.md) | 面向版本的开发变更日志 |
| [CONTEXT-MANAGEMENT](CONTEXT-MANAGEMENT.md) | 项目/模块/任务三级上下文 |
| [COMPONENT-TEMPLATE](COMPONENT-TEMPLATE.md) | 组件文档与验收模板 |
| [PROMPT-LIBRARY](PROMPT-LIBRARY.md) | 可复用 AI 提示词资产 |
| [UX-VISUAL-DIRECTION](UX-VISUAL-DIRECTION.md) | Ink & Daylight 视觉设计约束 |
| [ROADMAP](ROADMAP.md) | 迭代顺序与技术债 |

## 当前状态（2026-07-26）

- 写日记、历史、日历、心情、标签、可选单图封面：可用
- 手机/平板/网页同步：本地优先；Android 可通过 mDNS/NSD 发现电脑 LAN 服务，电脑关机时暂不能同步
- 独立 `PoyiJournalMcp`：本地安装、健康检查、故障自动恢复和 MCP 契约已验证
- 独立 `PoyiJournalTunnel` 与 ChatGPT「拾光日记」应用：真实读写、Resource、重放和重启恢复已验收
- Obsidian：目前提供 Markdown 导出，尚未做 Vault 双向同步
- 前端视觉：Ink & Daylight 已落地；样式收敛为 `index.css` + `journal-ui.css` 两层，四档响应式与深浅色均已回归
- 工程治理：需求基线、开发手册、Bug 台账和变更日志已建立

## 规则

1. 先读本文档和相关专题文档，再改代码。
2. 每次修改只解决一个可验证的问题，避免无边界重写。
3. 修改同步、MCP 或数据结构时，必须更新对应文档和验收记录。
4. 真实日记只留在本地运行数据，不进入代码仓库。
5. UI 重构前先写出状态、层级、响应式和可访问性规则，再实现。
6. 新需求先分配需求编号；Bug 修复同步更新 `BUGS.md`，用户可感知变更同步更新 `CHANGELOG.md`。
