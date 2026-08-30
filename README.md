# Sci Workplace

Sci Workplace 是 Windows 本地优先的科研 Harness。它把对话、可拆分专业画布、可追溯科研对象和受控外部工具链放在同一个工作台底座中，供论文精读、投稿引用、科研绘图等插件复用。

当前 `0.1.0` 实现的是 Workbench v1：一个科研项目可以创建多个工作台实例，每个实例绑定一个主 Agent 对话，并记录多个 Agent、模型、工作流与工具链 `Run`。原始项目文件不会因工作台状态重置、插件测试或产物挂载而被修改。

## 已实现能力

- 工作台壳层：左侧项目/实例抽屉、中间可拆分画布、右侧绑定对话；Agent 默认收起为方形箭头，宽屏挤压画布、窄屏覆盖。
- 共享与设备状态分离：实例、任务、布局提案、挂载和审批进入事件日志；窗格比例、活动标签、抽屉宽度与折叠状态仅保存在本机设备状态。
- 薄科研内核：不可变文档/Artifact 修订、`EvidenceAnchorV1`、批注、研究对象/关系、Run、ReviewRequest、模型/文件/工具链代理。
- Plugin API v4：`HarnessPluginManifestV4`、`WorkbenchBlueprintV1`、角色槽位、幂等 `MountIntentV1`、需确认的 `LayoutProposalV1`、专业沙箱面板和工具链适配器。
- 论文精读样板：主文/SI、确认前离线解析与精确 token/调用量预览、一次确认后的自动全文处理、58/42 原文—精读布局、逐段双语、术语冻结、来源约束问答、双向证据定位、证据抽屉、8→4→2→1 自适应拆批、跨重启检查点、局部重跑及 Markdown/JSON 导出。扫描件会明确拒绝，v1 不含 OCR。
- 提示词生成应用：提示词 → 蓝图 → 布局/能力预览 → 确认 → 构建检查 → CSP 沙箱预览 → 接受并挂载；生成版本不可变、默认无网络和文件能力。
- 策展插件目录：Ed25519 签名索引、SHA-256 包校验、递增 sequence、撤回、可信离线缓存和失败回滚。未签名目录/ZIP 仅在显式开发者模式下运行。
- 外部工具链代理：发现、版本探测、用户授权、隔离暂存、日志、取消和产物回收；内置无第三方依赖模拟适配器用于验证未来 Origin/C4D 契约。
- 对话与多 Agent：持久会话、模型路由、流式输出、工具审批、分支/恢复、任务、频道、上下文编译、项目文件与授权目录。

## 架构概览

```text
Electron Main
  ├─ BrowserWindow / safeStorage / 本机文件选择器 / 设备 UI 状态
  ├─ Runtime (127.0.0.1 随机端口 + 临时 Bearer token)
  │   ├─ SQLite WAL 事件日志与投影
  │   ├─ Workbench v1 + 薄科研内核
  │   ├─ Agent / 模型 / 审批 / Workspace 文件代理
  │   ├─ Plugin API v4 隔离进程与沙箱桥
  │   ├─ 论文精读 / 生成应用 / 策展市场
  │   └─ Job / Toolchain Adapter 代理
  └─ React Renderer（sandbox、无 Node.js）
      ├─ 对话与控制室
      └─ 工作台抽屉 / 布局树 / 专业插件面板
```

协议事实源位于 `packages/protocol`，插件 SDK 位于 `packages/plugin-sdk`，Workbench 与科研服务位于 `packages/runtime/src/workbench`。详细说明见 [Workbench v1](docs/WORKBENCH_V1.md)、[架构](docs/ARCHITECTURE.md)、[Plugin API v4](docs/PLUGIN_API_CONTRACT.md) 与 [安全模型](docs/SECURITY.md)。

## 本地开发

要求：Windows x64、Node.js 24、pnpm 11。

```powershell
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e:built
```

开发启动：

```powershell
pnpm dev
```

生成并验收 Windows 包：

```powershell
pnpm --filter @openlab/desktop package:win
pnpm test:e2e:packaged
```

安装器写入 `apps/desktop/release/Sci-Workplace-<version>-windows-<arch>.exe`。构建、离线 Reader Runtime、截图、本机数据库、密钥、插件缓存和用户项目数据均不提交 Git。

需要重新建立应用自管状态时，先关闭应用，再运行 `powershell -File scripts/reset-app-state.ps1`。脚本只允许操作 `%APPDATA%/SciWorkplace`，会先把完整目录原子移动到带时间戳的备份、逐文件复验 SHA-256，再创建空状态根；凭据保持原加密字节，绝不遍历外部项目目录。可先加 `-WhatIf` 查看目标。

## 插件开发

正式插件必须声明 `schemaVersion: 4`、`apiVersion: 4`。可在对话中调用 `scaffold_plugin` 生成项目私有模板，或复制 [v4 模板](templates/plugin-v4/README.md)。插件只能通过声明后的宿主代理访问 Workspace、文档、证据、Artifact、Workbench、模型与工具链；v4 代码中不存在旧 `worktable`/单数 `workbench` Host 名称。

策展目录贡献流程和签名发布见 [插件市场](docs/PLUGIN_MARKETPLACE.md)。本地未签名插件要求在“设置 → 安全”显式开启开发者模式，关闭后会立即停用。

## 产品边界

首版中文优先、Windows 本地单用户。不包含真实云同步、实时团队协作、公共自助发布后台、付费系统、投稿引用插件、真实 Origin/C4D 适配器、多论文综合或扫描 PDF OCR。事件、稳定身份、actor/device/revision/idempotency 与 `owner/editor/reviewer/viewer` 数据结构已为未来同步和协作预留。

模型凭据由 Electron `safeStorage`/Windows DPAPI 加密，不进入 Git、SQLite 事件、日志、插件或项目目录。源码使用仓库内许可，见 [LICENSE](LICENSE)。
