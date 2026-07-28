# Bug 与风险台账

本文档只记录可复现缺陷和已确认工程风险，不保存完整日志或真实日记。状态使用
`待处理`、`处理中`、`已修复`、`已验证`、`暂缓`。

## 当前已知问题

| 编号 | 严重度 | 状态 | 现象与影响 | 计划/验收 |
| --- | --- | --- | --- | --- |
| KR-001 | 高 | 暂缓 | 两台设备同时编辑同一天时按整日 `updatedAt` 后写覆盖，不是 block 级合并 | P2 设计 tombstone、块排序和冲突用例 |
| KR-004 | 低 | 暂缓 | 旧 `/journal/sync` 兼容链路没有持久 outbox；云 V2 已有持久 entity/outbox/flight/object-payload，但旧客户端仍只能靠再次进入应用重试 | 旧链路退役前保留；不把它当作 PC-off 能力 |
| KR-005 | 中 | 暂缓 | GitHub 提供的是 debug 签名 APK，不适合作为正式商店或长期升级包 | 配置 release keystore、版本号和签名验证 |
| KR-006 | 低 | 待上游 | MCP Inspector 1.0.0 在 Windows Node 24 完成响应后触发 libuv 退出断言 | 保留成功响应证据；CI/兼容 Node 复验并跟踪 Inspector 上游 |
| KR-007 | 中 | 待上游 | MCP SDK 1.29 间接依赖的 Hono Windows 静态文件适配器有路径穿越公告 | Journal 只使用 Express、不挂载该适配器；持续审计并升级到上游修复版本 |
| KR-008 | 高 | 处理中 | 默认共享副本仍运行在个人电脑上；云 V2 Worker/D1/R2 已完成本地实现，但没有 staging revision 与 PC-off 证据 | 完成隔离 staging、迁移回放、真实设备三轮 PC-off 与灰度发布 |
| KR-009 | 高 | 待处理 | Web E2E 和本地 Worker 合同不能证明 Android Keystore/原生 HTTP、真实 R2/D1、Doze/网络恢复或双设备 root 恢复 | staging + 至少两台真实设备验收；证据与 manifest/revision 同步后才可关闭 |

## 已修复并回归

| 编号 | 日期 | 问题 | 修复与证据 |
| --- | --- | --- | --- |
| BUG-001 | 2026-07 | 输入后立即刷新可能丢最后一段 | 本地写入改为即时，远端仍防抖；前端回归覆盖刷新恢复 |
| BUG-002 | 2026-07 | 图片异步处理可能覆盖其间的新正文 | patch 基于最新快照；E2E 覆盖图片处理中继续输入 |
| BUG-003 | 2026-07 | 慢设备旧同步请求可能覆盖新修订 | 服务端串行写入并重读最新副本；单元测试覆盖旧修订拒绝 |
| BUG-004 | 2026-07 | 本地存储损坏或配额失败被误报为空库/已保存 | 增加结构校验、恢复副本和明确错误态；单元/E2E 覆盖 |
| BUG-005 | 2026-07 | 手机底栏与键盘、编辑器页脚互相遮挡 | 输入时隐藏底栏并加入键盘附件栏；多视口 E2E 覆盖 |
| BUG-006 | 2026-07 | 手机长文和第二记录片输入时高度或滚动跳变 | 正文自然增高并保持光标/滚动；长文 E2E 覆盖 |
| BUG-007 | 2026-07 | 公开构建硬编码个人 Tunnel 和 ChatGPT 项目地址 | 改为安全默认值和显式构建变量；源码扫描验证 |
| BUG-008 | 2026-07 | WinSW XML 的 logpath 动态赋值导致安装中断 | 改为显式 XmlNode.InnerText；提权安装和 readyz 通过 |
| BUG-009 | 2026-07 | ACL 继承标志未给已有 journals.json 形成可读 ACE | 现有对象直接授权、根目录另设继承；服务 readyz 与崩溃恢复通过 |
| BUG-010 | 2026-07 | 强制结束 WinSW 包装器会遗留 Node 子进程并形成 split listener | 服务入口改为绝对路径，安装前清理 Journal 孤儿；按正确方式终止 Node 后单进程双端口恢复通过 |
| BUG-011 | 2026-07 | 兼容 `/journal/*` 匿名且任意 CORS 来源可访问回环数据 | 兼容接口统一 Bearer；客户端增加本地配对设置，匿名/API/LAN 契约覆盖 |
| BUG-012 | 2026-07 | Tunnel 健康端口 8987 落入 Windows 保留端口段，服务启动后立即退出 | operator 迁移到独立端口 8887；补齐 HTTP MCP OAuth 发现契约并以 Tunnel doctor/ready 回归 |
| BUG-013 | 2026-07 | 服务运行时 doctor 重复绑定固定健康端口，误报端口占用 | doctor 改用 loopback 临时端口，正式 operator 仍固定监听 8887 |
| BUG-014 | 2026-07 | ChatGPT 不会把普通 JSON URI 自动读取为 MCP Resource | `journal_get_entry` 改为标准 Resource 内容块，结构化结果只附带 `resourceIncluded` 与长度；真实 ChatGPT 调用通过且正文未输出 |
| BUG-015 | 2026-07 | 升级 MCP 时依赖服务 Tunnel 被 Windows 停止后没有恢复 | 安装脚本记忆升级前状态，在 MCP ready 后恢复并等待 Tunnel ready；实际升级回归通过 |
| BUG-016 | 2026-07 | 服务验证发现敏感日志时仍可能以退出码 0 结束 | 匿名认证、LAN 隔离、单监听进程和敏感值扫描均改为硬断言；管理员上下文验证退出码 0 |
| BUG-017 | 2026-07 | ChatGPT 同样不读取嵌入式 Resource 内容块（BUG-014 方案失效），复盘只依据列表摘要 | `journal_get_entry` 改为 `offset`/`maxChars` 分页直接返回正文并附 `resource_link`；列表/搜索、服务端 instructions 与复盘提示词统一强制逐篇读完正文；契约与同步测试覆盖分块读取；真实 ChatGPT 复验通过：复盘引用正文原句而非摘要、`resource_link` 呈现为附件、行为符合“列表→逐篇读取正文”流程 |
| BUG-018 | 2026-07 | MCP 升级脚本对数据根 `/T` 遍历踩到运行中 Tunnel 锁定的 WinSW 日志，icacls 的 stderr 在 Stop 模式下中断安装，服务被重装但从未启动（假活：服务 RUNNING、端口无监听） | icacls 改经 `Invoke-Icacls` 以 Continue 执行并按退出码判定；数据 ACL 遍历排除 `service-logs`（单独授 `service-logs\mcp`）与 `tunnel-runtime-key.dpapi`，顺带取消对 Tunnel DPAPI 密钥的 MCP ACE；服务资产测试锁定新断言，提权重装 ACL 步骤全程通过 |
| BUG-019 | 2026-07 | WinNAT 动态排除端口段漂移到 8757–8856 吞掉 8780/8781：特权进程 bind“成功”但无监听、netstat 无条目、loopback 连接被拒，服务持续假活并被误判为启动卡死；同机普通用户 bind 直接 EACCES | `JOURNAL_TRACE` 打点证实进程各启动阶段全部健康、监听回调已触发，`netsh` 确认动态排除段覆盖；两个安装脚本以管理员保留段固定 8780/8781 与 8887（动态段冲突时临时重启 winnat），verify 前置检测动态排除命中即失败；重装后 readyz/metrics/LAN、verify 退出 0、Tunnel ready、部署冒烟与分页契约现场验证全部通过 |
| BUG-020 | 2026-07 | 坏 JSON 请求触发 Express 5 默认错误页，完整堆栈与安装路径以 HTML 回给客户端（8780/8781 均可触发，堆栈同时进服务 err 日志） | MCP 与 LAN app 统一注册 JSON 错误处理器：4xx 固定 `INVALID_REQUEST`、5xx 固定 `INTERNAL`，不透出堆栈；契约测试断言 400 响应不含 SyntaxError/node_modules/HTML |
| BUG-021 | 2026-07 | 手机 App 未配对时同步地址回落到手机自身 `127.0.0.1:8780`，fetch 瞬时失败且无原因提示，“点击重试”体感无反应 | 同步失败分类为未配对/令牌被拒/服务异常/网络四类；未配对与令牌被拒时状态栏按钮改为直接引导去设置页配对；build/lint/单测/前端 E2E 通过，待随下次 APK 构建到真机复验 |
| BUG-022 | 2026-07 | 文档要求手机保存 `.local` 地址，但 Android WebView 无法解析该名称，且前端没有实现 mDNS 服务发现；Redmi 的 AOSP mDNS 解码器还会拒绝局域网广播包，电脑在线时仍无法同步 | Android 增加原生 NSD 桥，并以受限私网 `/24` Journal 健康探测兼容异常网络栈；Redmi 真机已发现正确 LAN 服务，构建/单测/E2E/部署冒烟通过 |
| BUG-023 | 2026-07 | 手机配对要求手工搬运 32 位以上长期令牌，既易出错又迫使用户暴露持久凭据 | 改为管理员入口生成 6 位一次性码：5 分钟、5 次、单次使用；生产兑换成功且同码重放 410，集成测试覆盖错码、锁定、过期和重放 |
| BUG-024 | 2026-07 | Android WebView 能连接 LAN `8781`，但带 JSON/Authorization 的请求被 mixed-content/PNA 拦截为 `Failed to fetch` | Android 同步与配对改走受限原生 HTTP：HTTPS 可远端，明文仅允许私网 Journal 固定端口；Redmi 真机发现与配对接口调用通过，PNA 许可仍只向受信本地 origin 返回 |
| BUG-025 | 2026-07 | 云 V2 曾把 `coverImage` data URL 放进实体 ciphertext；虽然内容加密，但每次 exchange/重试携带整张图，无法独立校验与恢复 | 实体加密前剥离封面；封面使用独立 AES-GCM object、manifest、持久 payload outbox 与 R2 PUT/GET；浏览器回归断言 exchange 不含 data URL、对象 body 不含原文 |
| BUG-026 | 2026-07 | R2 PUT 已返回完整性 headers，但浏览器跨域脚本因缺少 `Access-Control-Expose-Headers` 读到 `null`，客户端按不可验证回执停止在上传后 | Worker 精确 expose 六个对象完整性/重放 header；E2E 实际复现后通过 PUT→exchange 与 GET→decrypt 链路 |
| BUG-027 | 2026-07 | outbox 进入 retry 后重启，stage 会为相同内容重新生成 opId/objectKey，破坏稳定重放并留下 R2 孤儿 | stage 识别相同 operation + localFingerprint，保留原 mutation/payload；故障注入覆盖“对象已上传、exchange 503、整页重启、同 opId/objectKey/ciphertext 重放、ACK 后原子清理” |
| BUG-028 | 2026-07 | Capacitor Android 的 binary `file` request body 在 API 24/25 静默写零字节，导致旧支持版本无法上传封面 | 原生桥改用专用 base64 media type；Worker 严格解码、长度/SHA-256 校验后再写 R2，base64 不进入 exchange、D1 或 R2；本地 Worker 合同已覆盖，真机仍列入 KR-009 |

## 新 Bug 模板

```md
### BUG-xxx：一句话标题

- 状态/严重度：
- 用户动作：
- 预期：
- 实际：
- 复现步骤：
- 端与版本：
- 请求 URL/状态码：仅记录脱敏后的必要部分
- 关键状态变化：
- 根因：
- 修复范围：
- 回归证据：测试命令、用例或截图路径
```

禁止记录真实日记正文、令牌、Cookie、浏览器会话、个人公网地址或未经裁剪的生产日志。
