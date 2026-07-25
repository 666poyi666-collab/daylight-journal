# AI 上下文管理

## 三层上下文

### 项目层

`AGENTS.md`、`README.md`、`docs/ARCHITECTURE.md`、`docs/PRODUCT.md` 定义长期稳定的项目事实、边界和规则。

### 模块层

以后新增较大模块时，在模块目录放 `MODULE.md`，只描述该模块的职责、输入输出、依赖、状态机、常见坑和验收命令。当前优先模块：`sync`、`mcp`、`editor`、`design-system`。

### 任务层

每次编码前只补充本任务相关的目标、约束、现状证据和验收标准，避免把整段历史对话当作规范。

## 上下文压缩格式

长任务交接时使用以下结构：

```text
目标：
已完成：
当前文件：
关键决策：
已验证证据：
未解决风险：
下一步：
```

## 防止风格漂移

- 新组件先参考 `docs/UX-VISUAL-DIRECTION.md`。
- 新接口先参考 `docs/SYNC-MCP.md`。
- 新提示词先加入 `docs/PROMPT-LIBRARY.md`，不要散落在聊天记录里。
- 不因一次临时报错改变已经确认的技术边界。
