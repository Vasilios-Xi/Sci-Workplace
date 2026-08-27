# Sci Workplace Harness 开发进度

更新日期：2026-08-26

版本：`0.1.0` 开发快照

范围：桌面 Harness、对话、Agent、工具、项目文件与离线 Reader Runtime

## 当前结论

Sci Workplace 已具备可实际使用的本地科研 Harness：持久会话与多 Agent、流式模型对话、受审计工具调用、四种权限模式、项目与授权目录、上下文压缩、附件、恢复/分支、右侧项目文件与工作区、Skills/MCP/插件，以及 Windows 打包版。

本轮不只验证界面。真实 Sci Workplace 使用 `GPT-5.3-Codex-Spark` 完成了只读 `list_files`、询问后写入、询问后删除、连续第二轮、停止生成和发送按钮恢复；读写探针全部位于隔离临时目录。最新复验再次完成 `list_files` 后命中账户用量上限，Runtime 将供应商错误明确展示并安全结束，没有遗留运行状态。

Codex OAuth 现通过 App Server 动态工具协议接入 Sci 工具，不再是只读文字桥接。Codex 原生 shell、文件修改、MCP、浏览器等能力在该桥中禁用；模型只能提出 Sci 已注册的工具调用，实际审批、路径边界、执行和审计仍由 Sci Runtime 负责。

## 已完成

| 模块 | 当前状态 |
| --- | --- |
| 桌面外壳 | 融合标题栏、文件/编辑/视图/帮助菜单、窗口快捷键、左右栏、可拖动分隔线、窄窗口抽屉和安全 Electron 壳已完成。 |
| 会话侧栏 | 固定名称/新对话区域、工作台/频道/项目技能、置顶/项目/最近分组、搜索、重命名、归档和延迟创建会话已完成；未绑定项目的会话进入“最近”。 |
| 对话生命周期 | 流式文本、停止、恢复发送按钮、第二轮、重试/变体、分支、归档、重启恢复与后台标题精炼已完成。标题精炼不会继续占用前台运行状态。 |
| 思考与工具轨迹 | Agent 头像和名称下显示可展开思考行；生成期三点动画、完成态摘要、工具/网页/文件等可审计活动均可显示。只展示供应商可见摘要和真实活动，不伪造或暴露隐藏推理。 |
| 输入框 | 会话级草稿、附件、引用、Skills、模型/思考/权限选择、高度调节和停止生成已接入；阴影已移除，默认字重为 400。 |
| 权限 | `auto`、`trusted`、`ask`、`read_only` 均进入 Runtime 实际工具集合与审批策略，不是前端装饰。读写/删除实机审批已验证。 |
| 多 Agent | Agent 定义可跨项目复用；项目只决定可用范围。每个会话独立选择主管和成员，同一项目可有多个不同 Agent 的对话。 |
| 项目与文件 | 新对话默认“不在项目中工作”；选择后显示项目名。文件夹图标只在绑定项目时出现并可打开目录。右侧“工作区/项目文件”、对话文件、预览、移除引用和“手账”项目目标已完成。 |
| 独立工作台 | “工作台”入口现打开真实 Worktable：实例模板、搜索、会话绑定、控制室、项目文件、任务、受控终端、Git、标签挂载、分栏键盘/鼠标缩放、归档/恢复和重启持久化均接入 Runtime，不再是占位页。正式包已实际运行 ConPTY 命令。 |
| 插件与生成应用面板 | 插件面板使用无同源权限的沙箱与一次性 MessagePort，只能读取本插件当前标签上下文、调用已声明工具和请求受验证的证据跳转；写工具逐次确认。生成应用使用精确 loopback origin、一次性令牌与能力白名单桥，可读取当前工作台/产物/批注/研究元数据并创建边界内批注。 |
| 模型入口 | 主输入框、Agent 设置与供应商设置复用同一分组模型选择器，新增模型自动保持一致格式。DeepSeek、OpenAI-compatible、Ollama、LM Studio、Codex OAuth 等路由已接入。 |
| Codex OAuth 工具 | App Server `dynamicTools`、服务端工具请求、Runtime 审批/执行、工具结果续轮、取消、推理摘要与用量事件已接入。 |
| 上下文 | 稳定前缀、强制工具 schema、最近消息/输出预留、80% 阈值压缩、可追溯摘要和 Context Inspector 已实现；压缩不删除原始事件。 |
| 附件与视觉 | 事件只保存 SHA-256 校验的文件引用；文本附件按不可信资料注入，视觉模型请求才临时物化图像。OpenAI-compatible、DeepSeek、Ollama 与 Codex App Server 均使用各自原生格式。 |
| 视觉能力防误用 | 模型能力来自供应商模型清单。当前 App Server 明确标记 `GPT-5.3-Codex-Spark` 不支持视觉，因此附图会在建立轮次前明确拒绝，不再静默丢图后让模型误答。 |
| 用户资料 | 设置中可维护姓名、头像和用户档案；左下角只显示常规字重的用户头像与姓名，未设置头像时使用首字符。Runtime 连接状态不暴露给普通用户。 |
| 离线 PDF Runtime | 已冻结并校验 6,639 个文件、1,260,522,727 bytes；包含 Docling 2.120.1、模型、许可证和完整性清单。正式包启动时注册为 `available / bundled`。 |
| 安全 | Renderer sandbox/CSP、随机 localhost 令牌、Windows 安全存储、路径 realpath 边界、哈希变更集、输出/时间上限、诊断脱敏与生产依赖审计已完成。 |
| 主题与布局 | 12 套现有主题、Provider/Agent 设置、菜单、模型/权限弹层、920/1100/1480 px 布局、无横向溢出与非粗体默认风格已做真实 Electron 断言。 |

## 验证基线

| 检查 | 结果 |
| --- | --- |
| `pnpm typecheck` | 通过，全部可类型检查 workspace。 |
| `pnpm test` | 通过，42 个测试文件、231/231 项测试。 |
| `pnpm build` | 通过，Renderer production bundle 与全部 TypeScript package。 |
| `pnpm test:e2e:built` | 通过，真实 Electron 源码构建版。 |
| `pnpm --filter @openlab/reader-runtime verify` | 通过，6,639 文件完整性与语义/许可证清单一致。 |
| 正式包 Reader 实读 | 通过；对 30 页、6,879,484-byte 论文完成 `inspect`，确认可选文本层。 |
| `pnpm --filter @openlab/desktop package:win` | 通过；打包流程会先强制验证 Reader Runtime，缺失时不再静默出包。 |
| `pnpm test:e2e:packaged` | 通过；验证正式 `win-unpacked`、应用重启、内置 Reader、真实 ConPTY 终端、Worktable 布局与归档恢复。 |
| `pnpm audit --prod` | 通过，未发现已知生产依赖漏洞。 |

## 当前发布物

- 安装器：`apps/desktop/release/Sci-Workplace-0.1.0-windows-x64.exe`
- 大小：723,679,498 bytes
- SHA-256：`659121DEB8BBB2AB4499E3883F0FD6D29201BA9435594E560EC386F774BCC07D`
- 解包程序：`apps/desktop/release/win-unpacked/Sci Workplace.exe`
- Authenticode：安装器与解包程序均为 `NotSigned`

安装器、解包目录、Reader 冻结产物和验收截图均被忽略，不进入源码提交。每次重新构建都会改变安装器指纹，正式发布应重新登记。

## 已知外部限制

1. `GPT-5.3-Codex-Spark` 的账户用量由 OpenAI 控制；达到上限后只能等待恢复或由用户主动选择其他模型，应用不会静默切换。
2. 当前 App Server 模型清单把 Spark 标记为无视觉；需要图片时应选择供应商声明支持视觉的模型，例如 DeepSeek V4 Flash Vision 或当前清单中的视觉模型。
3. 当前没有组织 Authenticode 证书；正式外部分发前必须签名并在干净 Windows 11 x64 上验证 SmartScreen、安装、升级和卸载。
4. `node-pty` 使用上游随包提供的 Windows x64 预编译二进制；打包流程禁止无意义的本机 ABI 重编译，正式包 E2E 已实际启动终端验证该二进制。

## 下一阶段

1. 增加可控的供应商 live-smoke 预算与配额前置检查，避免长验收在最后一步才遇到额度上限。
2. 为视觉能力增加更直接的输入框提示，并在切换到非视觉模型时保留附件但阻止发送。
3. 为 Reader Runtime 增加小型固定 PDF 的安装包内 `inspect/render-page` CI 探针。
4. 完成 Authenticode、SBOM、发布 CI 与干净 Windows 安装/卸载验收。
5. 继续保持默认不使用粗体的视觉规范，并用 920/1100/1480 px 几何断言防止响应式回归。

## 2026-08-26 质量审核矩阵

| 用户要求 | 实现证据 | 验收证据 |
| --- | --- | --- |
| 完成 Codex/HanaAgent 式连续对话 | 流式轮次、停止/恢复、重试/分支、标题后台精炼、持久会话、可见思考摘要和活动轨迹 | 真实 Spark 完成两轮与停止恢复；构建版/打包版 E2E 覆盖生命周期与重启 |
| 基础工具调用与权限必须真实生效 | Codex App Server 动态工具桥；Runtime 统一 schema、权限求交、审批、路径边界、工具结果续轮与审计 | 真实 Spark 完成列表、询问写入与询问删除；E2E 覆盖四种权限、diff、撤销和多 Agent 工具 |
| 上下文压缩 | 80% 阈值、稳定前缀、最近消息预留、可追溯摘要、原始事件保留 | Runtime 单元测试覆盖压缩触发、摘要持久化、重启恢复与 Inspector 来源 |
| 项目可含多 Agent 对话，Agent 可跨项目 | Agent 为全局定义；项目仅启停能力；会话独立绑定主管/成员 | Agent v3 与 E2E 覆盖同项目多会话、跨项目复用、成员任务收敛 |
| 右侧项目文件与独立工作台功能 | 右侧保留 ChatGPT 式项目文件；工作台按入口懒加载真实实例和多窗格工具 | Electron E2E 真实执行终端、浏览项目文件、调整并持久化分栏、归档恢复 |
| 前端与功能同步 | 模型/权限/项目/记忆/手账/菜单/用户资料/思考行全部调用 Runtime 或设备持久化接口 | 12 主题、三档宽度、菜单、模型选择、无粗体默认和无溢出均有真实 DOM/几何断言 |
| 正式 Windows 包可用 | Reader 冻结校验、ASAR 解包、原生 PTY 预编译、NSIS | `package:win` 与 `test:e2e:packaged` 通过，安装器哈希已登记 |

Renderer 已将设置和 Worktable 改为按需加载，并按 React、Markdown、图标库的稳定依赖边界拆包；最大脚本块由约 992 kB 降至约 433 kB，构建不再产生大 chunk 提示。

## 不进入仓库的内容

- `apps/desktop/release*/` 下的安装包与解包程序
- `packages/reader-runtime/dist/`、`.freeze/` 下的离线运行时与模型
- `artifacts/` 下的截图、视频和临时报告
- `.openlab/`、`.research/`、`.tmp/` 与用户项目数据
- `node_modules/`、普通 `dist/`、覆盖率和测试缓存
- `.env*`、凭据文件、私钥、证书和本机数据库
- 用户在 `%APPDATA%\OpenLab` 中的模型凭据、插件与会话数据
