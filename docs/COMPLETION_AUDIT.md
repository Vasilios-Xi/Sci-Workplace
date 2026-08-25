# Sci Workplace 历史基线审计

> 本文保留 2026-08-24 的首版验收记录，作为 Runtime 与安全能力的历史基线。2026-08-25 起产品已更名为 Sci Workplace，旧工作台与旧内置插件已从活跃界面和发布范围移出，因此本文中相关 UI、插件和旧安装包名称不代表当前交付状态。当前状态以 [Harness 开发进度](DEVELOPMENT_STATUS.md) 为准。

审计日期：2026-08-24。目标版本：`0.1.0`，Windows x64。

## 1. 结论

计划内的本地首版与 v3 持久 Agent 改造均已实现，并通过源码构建版与 Windows 打包版的真实 Electron 端到端验收。仓库内没有以 OpenAI SDK 或 OpenAI 服务作为默认运行依赖；默认生产 Provider 直接接入 DeepSeek，未配置密钥时只使用可识别的离线演示 Provider。

下列两项属于外部发布条件，不伪装为已完成：

- 本次环境没有用户的真实 DeepSeek API Key，因此没有执行付费 live smoke；仓库提供显式的 `pnpm test:deepseek`，常规测试使用本地 SSE fixture，且不打印密钥。
- 当前没有 Authenticode 发布证书；PowerShell 验证安装器和解包可执行文件均为 `NotSigned`。私有试用可以运行，正式外部分发前必须签名。

Windows Job Object 与 Node 权限模型属于应用层防护，不是恶意代码强沙箱。这一限制在 UI 和安全文档中保持明确。

## 2. 原计划逐项对应

| 计划域 | 状态 | 实现与证据 |
|---|---|---|
| Electron Main / Runtime / Renderer 分层 | 已实现并验收 | Main 管理安全窗口、加密凭据和 Runtime 子进程；Runtime 仅监听 `127.0.0.1` 随机端口；Renderer sandbox、无 Node，通过临时令牌 HTTP/WebSocket 通信。打包版 E2E 实际启动 `OpenLab.exe`。 |
| pnpm TypeScript monorepo | 已实现 | `apps/desktop`、`apps/renderer`、`packages/protocol`、`kernel`、`runtime`、`plugin-sdk` 分包；全仓 strict typecheck。 |
| 自研 Cordis-like 微内核 | 已实现并单测 | 服务 token、密封特权服务、严格 `app→project→session→agent` scope、模块依赖/拓扑/循环诊断、Effect 逆序幂等清理、publish/serial/pipeline、Registry、候选隔离健康检查与原子 hot swap；不依赖 Cordis。 |
| SQLite WAL 事件事实源 | 已实现并单测 | schema v3、严格 stream sequence、事务、migration、时间线/消息/Agent 定义与绑定/能力快照/记忆/任务/频道重放、流式 chunk 批量落盘、中断恢复、session fork、一致性备份；损坏/领先投影调和。 |
| “模型可见即已记录” | 已实现并单测 | `context.compiled` 与包含最终消息、工具 schema 的 `model.requested` 在 Provider 调用前写入；模型异常也保留部分流并写 `model.failed`。 |
| DeepSeek Provider | 已实现；live smoke 待密钥 | 原生 fetch、SSE 任意分片、reasoning、文本、跨 chunk 工具调用、usage/cache token、取消、首字节前重试、超时、模型动态发现与版本化价格表。Agent loop 不接触 DeepSeek 专属结构。 |
| 单 Agent 工具循环 | 已实现并验收 | 固定 context→model→approval→tool→next step 流程，最多 12 step；工具 schema 校验；超长结果转 Artifact。E2E 覆盖聊天、写入、审批和撤销。 |
| 文件与终端工具 | 已实现并单测 | 列举、读取、搜索、diff 写入、diff 删除、哈希快照、冲突检测撤销、受控 PowerShell；路径 realpath/symlink 边界与文件/输出/时间资源上限。 |
| 权限模型 | 已实现并单测 | 项目读取默认允许；写入/终端审批；删除、网络、外部路径与安装逐次确认；`read_only` 在送模工具列表中移除变更能力；持久成员实际能力由 Agent 策略、会话快照、频道上限、权限模式、目录授权、模型和扩展状态求交。 |
| Context Compiler / Inspector | 已实现并单测/验收 | 稳定前缀、强制 request-schema、最近消息/输出预留、固定对象、显式信任、80% 可追溯压缩、长结果卸载、token/来源/缓存命中 UI。原始事件不删除。 |
| 科研对象与 provenance | 已实现并单测 | `Source`、`Dataset`、`Experiment`、`Evidence`、`Artifact`，六种核心关系；Artifact 记录输入对象、哈希、Agent、模型、工具/插件版本、session/task/trace。 |
| 持久多 Agent | 已实现并验收 | 确认前零 Agent，首启只创建用户确认的一名角色；其后只允许用户创建/导入/确认模板。全局角色库、项目启停、会话主管锁定与成员绑定、`@Agent` 并行路由、主管收敛、1–8 并发限制均已实现；模型工具中不存在 Agent 创建能力。 |
| Agent 角色编辑 | 已实现并验收 | Hana 风格头像堆叠、模板创建、角色卡导入/导出、名称、模型、身份与行为准则编辑；头像支持三种内置样式与本地 PNG/JPEG/WebP，自动中心裁切压缩、签名/大小校验、事件持久化和重启恢复；同时支持归档/恢复、变量展开、事件审计和历史引用。 |
| Agent 记忆与经验 | 已实现并单测/验收 | 默认关闭；全局置顶、Agent × Project 隔离记忆和经验、异步小模型提取、0.75 置信阈值、秘密/外部指令拦截、来源事件、编辑/删除/清空、FTS5 可重建投影与上下文预算。 |
| Agent 工具策略 | 已实现并单测/验收 | Hana 风格能力组与具体工具开关；核心能力全局配置、项目 MCP/插件能力绑定、每名会话成员不可变能力快照、主动刷新和失效扩展的即时安全移除。 |
| 多 Agent 恢复 | 已实现并单测 | 持久角色、会话绑定、成员运行、任务、能力快照、记忆与频道从事件重建；未闭合工具调用合成中断结果，既有 Artifact 可重新引用，关机运行安全暂停。 |
| 协作频道 | 已实现并单测/验收 | 项目 + Agent 对唯一私聊、2–6 人手动群聊、1–8 有限回复轮次、只读/写入权限上限、暂停/恢复/取消、来源引用、Markdown 导出和重启恢复；用户不能在频道直接发言。 |
| Skills | 已实现并单测 | YAML frontmatter `SKILL.md`、用户/项目作用域、描述触发/显式选择、引用文件、目录/ZIP 安装；路径、symlink、保留名和压缩包资源限制。Skill 不获得额外权限。 |
| MCP | 已实现并集成测试 | stdio 与 Streamable HTTP，credential ID 解析，tools/resources，统一审批/注册/不可信输出/资源上限，失败连接清理；不实现 OAuth/市场/自动发现。 |
| TypeScript 插件 | 已实现并单测/验收 | Manifest/engine/贡献校验，JSON-RPC stdio 独立进程，命名空间工具、设置/context/Agent 模板/对象/UI contribution、目录/ZIP 导入导出、启停/卸载/热重载与回滚；模板必须由用户确认，旧 preset 只兼容映射。 |
| 对话内插件开发 | 已实现并打包验收 | 生成 `src/index.ts`/类型契约/测试，临时副本隔离依赖安装、strict typecheck、契约和健康测试、权限/依赖预览、staging 安装、哈希锁与原子切换。打包版 E2E 实际完成脚手架→测试→批准→安装→重启恢复。 |
| 插件供应链与机器授权 | 已实现并单测 | 拒绝本地/Git/HTTP 依赖、移除包管理器配置、禁用 lifecycle scripts、无 symlink 依赖树、tree/ZIP 限额；项目锁不是自动执行授权，另需本机项目—插件哈希锁。 |
| 插件 UI | 已实现 | Runtime 校验 realpath，注入严格 CSP；Renderer 使用无 `allow-same-origin` 的 sandbox iframe 和只读初始化桥。 |
| Hana 风格中文科研工作台 | 已实现并视觉验收 | 顶部对话/频道切换与可拖动区域、会话成员头像芯片、连续浅色画布、悬浮输入框、紧凑 Agent/工具/diff/审批卡、右侧对话文件/工作台/便笺，以及独立频道三栏视图；未复制 HanaAgent 源码或素材。 |
| 本地数据与恢复 | 已实现并验收 | `%APPDATA%` 数据、项目 `.openlab` 投影、安全存储、日志脱敏导出、数据库备份、未完成流/审批恢复。E2E 关闭并重启后验证会话、四名持久 Agent、成员绑定、记忆、能力快照、频道和插件。 |
| Windows 打包 | 已实现并验收 | Electron Builder NSIS x64；打包版 E2E 验证 ASAR 解包后的 Runtime、pnpm/TypeScript 插件工具链与生产资源路径。 |
| 计划外功能 | 保持不实现 | 无 CLI、账号/多租户、云服务、远程访问、市场、遥测、定时任务、浏览器控制或内置学科能力。 |

## 3. 自动化验收记录

本机最终结果：

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | 通过，6 个 workspace package/app |
| `pnpm test` | 通过，15 个 test file、97/97 tests，0 跳过 |
| `pnpm build` | 通过，Renderer production bundle 与全部 TypeScript package |
| `pnpm test:e2e:built` | 通过，真实 Electron 源码构建版 |
| `pnpm --filter @openlab/desktop package:win` | 通过，生成 NSIS 与 `win-unpacked` |
| `pnpm test:e2e:packaged` | 通过，真实打包版 `OpenLab.exe`，包含应用重启 |
| `pnpm audit --prod` | 通过，无已知生产依赖漏洞 |

E2E 截图：

- `artifacts/e2e/openlab-smoke.png`
- `artifacts/e2e/openlab-packaged-smoke.png`
- `artifacts/e2e/conversation-header-packaged.png`（顶部栏无重叠几何断言）
- `artifacts/e2e/agent-custom-avatar-packaged.png`（本地头像上传与角色编辑）

## 4. 发布物

- 安装器：`apps/desktop/release/OpenLab-0.1.0-windows-x64.exe`
- 大小：112,632,690 bytes
- SHA-256：`10D3630C8011E9A3572693EC6B97246806F3BE8ED5E059CA19C31F8BAD86D1C5`
- 解包验证程序：`apps/desktop/release/win-unpacked/OpenLab.exe`
- Authenticode：`NotSigned`（安装器与解包程序）

安装器每次重新构建都会改变大小与哈希，发布时应重新生成并登记指纹。

## 5. 正式私有 Beta 前的外部检查

1. 由发布负责人提供隔离的 DeepSeek 测试 Key，运行 `pnpm test:deepseek` 并确认当前账户可见模型；不要把 Key 写进仓库或 CI 日志。
2. 使用组织的 Authenticode 证书签名 NSIS、卸载器与主程序，再验证签名链和时间戳。
3. 在一台干净 Windows 11 x64 机器上执行安装/卸载、SmartScreen、受限用户目录和杀毒软件兼容性检查。
4. 若插件将处理不可信代码，增加 OS 沙箱/虚拟机边界；不要把当前应用层防护描述为安全执行恶意代码。
