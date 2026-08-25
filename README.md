# Sci Workplace

Sci Workplace 是面向科研工作的本地优先、多 Agent 桌面 Harness。当前仓库保存对话端本体的可复现开发快照：以科研对话为主入口，统一管理 Agent、模型、上下文、工具审批、项目文件与本地事件记录。

> 当前阶段：对话端可运行；“工作台”仅保留导航入口和占位页。旧工作台界面、旧内置插件、安装包、截图、缓存与本机数据均不属于本仓库。后续工作台与插件体系会重新设计。

## 当前能力

- 对话与会话：流式输出、推理过程、Markdown、引用、分支、重新生成、多选和会话级草稿恢复。
- 多 Agent：持久 Agent、头像、主管与会话成员、`@Agent` 委派、工具能力快照、暂停/恢复和主管收敛。
- 工具与审批：文件读取、搜索、diff 写入/删除、受控终端、审批卡、撤销、科研对象与 Artifact 溯源。
- 项目与工作区：项目创建/切换、会话延迟创建、项目文件夹、授权目录、对话文件和上下文引用。
- 模型接入：DeepSeek、OpenAI-compatible、本地模型服务以及只读的 Codex App Server 对话桥接。
- 扩展基础：Skills 与 MCP 仍由 Harness 管理；旧插件前端和旧工作台不再随当前产品启用。
- 桌面安全：Electron Renderer sandbox、`contextIsolation`、严格 CSP、无 Node integration、localhost 临时令牌和 Windows 安全存储。
- 界面：ChatGPT/Codex 与 HanaAgent 交互习惯启发下的独立实现，支持多套明暗主题、侧栏动画和窄窗口抽屉。

## 当前边界

- 工作台入口保留，但内容区是待重建占位页。
- 不打包旧工作台插件，也不把本地安装的插件上传到仓库。
- Runtime 中仍保留部分旧工作台和 Plugin API 的兼容类型/服务，以避免一次性破坏事件、数据库和通信契约；这些兼容层不代表当前 UI 已开放对应能力。
- 当前是 Windows x64、中文优先、单用户本地版本；没有账号、云同步、遥测、在线插件市场或公开更新服务。

详细进度、已完成项目和下一阶段计划见 [开发进度](docs/DEVELOPMENT_STATUS.md)。

## 架构

```text
Electron Main
  ├─ BrowserWindow / safeStorage / native dialogs
  ├─ Local Runtime child process (127.0.0.1 + ephemeral token)
  │    ├─ scoped microkernel / event store
  │    ├─ context compiler / agent loop / model providers
  │    ├─ approvals / core tools / project workspace
  │    └─ Skills / MCP / dormant compatibility services
  └─ React Renderer (sandboxed, no Node.js)
       ├─ chat shell / session sidebar / timeline
       ├─ composer / overlays / approvals
       └─ workspace side panel / worktable placeholder
```

详细设计见 [架构说明](docs/ARCHITECTURE.md)，威胁模型见 [安全说明](docs/SECURITY.md)。

## 本地开发

要求：Windows、Node.js 24、pnpm 11。

```powershell
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e:built
pnpm dev
```

生成 Windows 安装包：

```powershell
pnpm --filter @openlab/desktop package:win
pnpm test:e2e:packaged
```

安装产物写入 `apps/desktop/release/`，文件名为 `Sci-Workplace-<version>-windows-<arch>.exe`。构建产物不提交到 Git。

## 工程结构

```text
apps/
  desktop/       Electron Main、preload 与 Windows 打包
  renderer/      React 对话端界面
packages/
  protocol/      进程无关的通信与数据契约
  kernel/        作用域服务、事件与可逆副作用
  runtime/       事件库、模型、Agent、工具与项目服务
  plugin-sdk/    暂存的旧扩展兼容契约（当前 UI 不启用）
  reader-runtime/旧文档读取兼容运行时（当前 UI 不启用）
docs/            架构、安全、事件与开发记录
```

## 兼容与数据

产品可见名称已改为 **Sci Workplace**。为保护已有本机数据，当前版本继续读取旧的 `%APPDATA%\OpenLab` 数据目录，并暂时保留 `OPENLAB_*` 环境变量、`.openlab` 项目元数据与 `@openlab/*` 内部包名。它们是迁移兼容标识，不是旧产品名称仍在对外展示。

模型凭据由 Electron `safeStorage`/Windows DPAPI 加密，不进入 Git、SQLite 事件、日志或项目目录。真实密钥只通过本机设置、环境变量或 GitHub Actions Secret 提供。

## 安全与发布

外部文件、网页与 MCP 资源均作为不可信资料处理，不能提升为系统或用户指令。写入、终端、删除、联网、工作区外访问与扩展安装遵循统一审批策略。正式分发前还需要 Authenticode 签名和干净 Windows 环境验收。

本仓库使用私有、保留所有权的源码许可。Copyright © 2026 Vasilios-Xi。见 [LICENSE](LICENSE)。
