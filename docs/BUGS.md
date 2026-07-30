# Bug 与风险台账

本文档只记录可复现缺陷和已确认工程风险，不保存完整日志或真实日记。状态使用
`待处理`、`处理中`、`已修复`、`已验证`、`暂缓`。

## 当前已知问题

| 编号 | 严重度 | 状态 | 现象与影响 | 计划/验收 |
| --- | --- | --- | --- | --- |
| KR-001 | 高 | 暂缓 | 两台设备同时编辑同一天时按整日 `updatedAt` 后写覆盖，不是 block 级合并 | P2 设计 tombstone、块排序和冲突用例 |
| KR-005 | 中 | 暂缓 | GitHub 提供的是 debug 签名 APK，不适合作为正式商店或长期升级包 | 配置 release keystore、版本号和签名验证 |
| KR-006 | 低 | 待上游 | MCP Inspector 1.0.0 在 Windows Node 24 完成响应后触发 libuv 退出断言 | 保留成功响应证据；CI/兼容 Node 复验并跟踪 Inspector 上游 |
| KR-007 | 中 | 待上游 | MCP SDK 1.29 间接依赖的 Hono Windows 静态文件适配器有路径穿越公告 | Journal 只使用 Express、不挂载该适配器；持续审计并升级到上游修复版本 |

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
| BUG-017 | 2026-07 | 浏览器默认 `fetch` 作为客户端成员调用时触发 `Illegal invocation`，V2 outbox 无法发出 | 默认 transport 改为保持浏览器全局调用语义；入口 E2E 捕获真实非空 mutation exchange |
| BUG-018 | 2026-07 | 云附件对象链路与 LAN 全量正文兼容接口不符合“附件只在电脑与手机直连时同步”的边界 | 云 exchange 固定 `objects=[]`；新增私有地址白名单、独立附件 AAD/密文 pending/tombstone，并把 LAN 8781 收窄为附件密文接口；Node 集成测试覆盖公网拒绝、加密落盘、更新、删除、重启、离线保留与分歧拒绝 |
| BUG-019 | 2026-07 | Journal Cloud MCP 只有密文 revision 元数据，电脑关机后 ChatGPT 无法读取正文，健康检查却容易被误当作完成 | V2 upsert 增加严格无附件 `mcpEntry`；ACK 时与密文 revision 同批维护 D1 可读镜像，delete 同批清除；隔离 Worker 以真实 OAuth JWT 完成 initialize、tools/list、非空 `journal_get_entry`、Resource、删除和恢复回归 |
| BUG-020 | 2026-07 | 旧云日记没有可重试回填合同，直接执行 encrypted-only cutover 会拒绝迁移或导致旧表长期保留 | 新增 pending import 与 migration ledger；客户端同日去重/合并、断网重启续传，Worker 同批提交双投影与 ledger，本地 7 行/6 日期夹具、竞争、失败恢复和 fail-closed cutover 契约通过 |
| BUG-021 | 2026-07 | production `/readyz` 先被 `cutover_required` 遮蔽，完成迁移后才暴露 OAuth introspection 401；Cloudflare service binding 未转发标准 `Authorization`，导致所有 ChatGPT MCP 工具失败 | Journal introspection 同时发送标准头和仅供 service binding 的 `X-Poyi-Resource-Server-Authorization`；OAuth 只接受二者之一或完全一致的双头，冲突即 401。两端契约测试、直接认证 probe、双 Worker ready、ChatGPT 四工具、embedded Resource 和 PC-off 等价调用均通过 |
| BUG-022 | 2026-07 | Journal Cloud 契约测试的 Worker 启动器固定使用 Wrangler 4.114.0，与项目锁定的 4.115.0 不一致，在 Windows 全量串行回归中出现子进程异常退出 | 测试运行时版本对齐 `package.json`/lockfile 的 Wrangler 4.115.0；此前两个失败用例均已单独复跑通过，并以对齐后的全量契约结果作为最终证据 |
| BUG-023 | 2026-07 | PWA 主图标为 1.7MB 高细节 3D 图，favicon 仍是紫色 Vite 默认图，Android 启动资源还混有旧模板标志；小尺寸和 ChatGPT 10KB 约束下品牌不一致 | 重构为同一扁平“日记本＋晨光＋书签”母版；PWA 主图降至 12KB、插件 256px PNG 为 5.9KB，favicon/manifest/adaptive icon/mipmap/splash 全部替换；build、PWA、浏览器和真机回归通过 |
| BUG-024 | 2026-07 | Android 重装后启动动画显示新图标，但锁屏仍由 Service Worker `daylight-journal-v4` 返回旧 3D 图标 | cache namespace 提升至 `daylight-journal-v5`，由 skipWaiting/clients.claim 激活并删除旧缓存；重新 build、`cap copy`、assemble、安装后，Redmi Note 11T Pro 冷启动和锁屏均显示新图标 |

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
