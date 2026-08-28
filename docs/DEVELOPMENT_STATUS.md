# Sci Workplace Harness 开发状态

更新日期：2026-08-28
版本：`0.1.0` Workbench v1 开发快照
平台：Windows x64、中文优先、本地单用户

## 结论

Sci Workplace 已从空白入口升级为可运行的科研应用底座。Workbench v1 壳层、薄科研内核、Plugin API v4、论文精读闭环、提示词生成应用、策展插件目录和外部工具链代理均已接入正式 Runtime/Renderer，不是静态原型。

## 交付矩阵

| 模块 | 状态 | 关键证据 |
| --- | --- | --- |
| 备份与重置 | 完成 | 旧自管状态在重置前备份到 `%APPDATA%/OpenLab-backups/20260828-201052`；新默认根为 `%APPDATA%/SciWorkplace`。外部项目目录不参与删除或迁移。 |
| Workbench v1 壳层 | 完成 | 项目多实例、主对话绑定、抽屉、split/pane、标签、控制室、归档/恢复、设备状态、宽屏挤压/窄屏覆盖和方形 Agent 箭头。 |
| 事件与薄科研内核 | 完成 | schema v5；稳定 actor/device/revision/idempotency；文档/Artifact 修订、EvidenceAnchor、Annotation v1、科研对象/关系、Run 与 ReviewRequest。 |
| Plugin API v4 | 完成 | 正式入口只接受 v4；`workbenches`、Evidence、MountIntent、LayoutProposal、GeneratedApp 与 Toolchain Host；v4 代码不含旧 worktable Host 名称，并拒绝直接项目文件、子进程与裸网络权限。 |
| 论文精读 | 完成 | 主文/SI、不可变 PDF、文本层检测、扫描件拒绝、58/42、双语/术语、来源问答、双向定位、证据抽屉、取消/恢复/重试、局部重跑和 Markdown/JSON 导出。 |
| 提示词生成应用 | 完成 | 蓝图预览、能力/网络确认、构建检查、CSP 沙箱预览、不可变版本、接受挂载和回滚数据结构。 |
| 策展插件目录 | 完成 | Ed25519、SHA-256、递增 sequence、撤回、可信离线缓存、开发者模式门禁、控制室导入/安装入口及 GitHub PR/签名 CI。 |
| 工具链代理 | 完成 | ToolchainAdapter/ToolRun、探测/授权/暂存/日志/取消/回收；无第三方依赖模拟适配器已验收。 |
| Windows 发布 | 完成（未签名） | Reader Runtime 6,639 文件完整性通过；NSIS 与 `win-unpacked` 构建成功；源码构建版和打包版 Electron E2E 均通过；加密 AppData 下的 `EXDEV` 原子写入降级与 Runtime IPC 安全关闭已实机验证。 |

## 自动化基线

| 检查 | 结果 |
| --- | --- |
| `pnpm typecheck` | 通过，全部 workspace strict 类型检查。 |
| `pnpm test` | 通过，49 个测试文件、262 项测试。 |
| `pnpm build` | 通过。 |
| `pnpm test:e2e:built` | 通过，真实 Electron 源码构建版。 |
| `pnpm package:win` | 通过，含 Reader Runtime 完整性门。 |
| `pnpm test:e2e:packaged` | 通过，真实 `win-unpacked/Sci Workplace.exe` 并覆盖重启。 |
| `pnpm verify:plugin-catalog` | 通过。 |
| `git diff --check` | 通过。 |

Electron E2E 真实创建两个 Workbench v1 实例并绑定主对话，验证论文精读 58/42、Agent 宽/窄屏行为、工作台重启恢复以及项目/授权目录输入文件字节级不变。单元/集成测试覆盖布局接受/拒绝/陈旧 revision、MountIntent 幂等、证据质量门、扫描件拒绝、生成应用 CSP、市场签名/哈希/撤回/离线缓存和工具链取消/产物回收。

## 当前安装包

- 路径：`apps/desktop/release/Sci-Workplace-0.1.0-windows-x64.exe`
- 大小：725,010,294 bytes
- SHA-256：`744754417D16E647D9B4A1633C6C4026941EEB6469D67E1E56FA51B4C29FEB12`
- Authenticode：`NotSigned`

构建产物和截图被 `.gitignore` 排除。正式外部分发仍需要组织证书、时间戳签名、SBOM、SmartScreen 与干净 Windows 11 安装/升级/卸载验收。

## 明确不在 v1 范围

真实云同步、实时协作、公共自助发布后台、付费系统、投稿引用插件、真实 Origin/C4D 适配器、多论文综合和扫描 PDF OCR。数据身份、角色与事件字段已为未来能力预留，但不把尚未实现的远程能力伪装为可用。
