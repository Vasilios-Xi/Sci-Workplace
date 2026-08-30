# Sci Workplace Harness 开发状态

更新日期：2026-08-30
版本：`0.1.0` Workbench v1 开发快照
平台：Windows x64、中文优先、本地单用户

## 结论

Sci Workplace 已从空白入口升级为可运行的科研应用底座。Workbench v1 壳层、薄科研内核、Plugin API v4、论文精读 V2、提示词生成应用、策展插件目录和外部工具链代理均已接入正式 Runtime/Renderer，不是静态原型。论文精读 V2 的功能开发和离线质量门已经落地，但当前实现指纹下的 Zotero 全库离线复验以及付费真实模型全库验收尚未完成，因此不得标记为最终完成。

## 交付矩阵

| 模块 | 状态 | 关键证据 |
| --- | --- | --- |
| 备份与重置 | 完成 | 旧自管状态在重置前备份到 `%APPDATA%/OpenLab-backups/20260828-201052`；新默认根为 `%APPDATA%/SciWorkplace`。外部项目目录不参与删除或迁移。 |
| Workbench v1 壳层 | 完成 | 项目多实例、主对话绑定、抽屉、split/pane、标签、控制室、归档/恢复、设备状态、宽屏挤压/窄屏覆盖和方形 Agent 箭头。 |
| 事件与薄科研内核 | 完成 | schema v5；稳定 actor/device/revision/idempotency；文档/Artifact 修订、EvidenceAnchor、Annotation v1、科研对象/关系、Run 与 ReviewRequest。 |
| Plugin API v4 | 完成 | 正式入口只接受 v4；`workbenches`、Evidence、MountIntent、LayoutProposal、GeneratedApp 与 Toolchain Host；v4 代码不含旧 worktable Host 名称，并拒绝直接项目文件、子进程与裸网络权限。 |
| 论文精读 | 功能完成，真实全库验收待续 | 主文/SI、不可变 PDF、确认前离线解析与精确调用量预览、一次确认后自动全文处理、扫描件拒绝、58/42、双语/术语、来源问答、双向定位、证据抽屉、取消/恢复/自适应拆批、跨重启安全批次检查点、局部重跑和 Markdown/JSON 导出。当前 Parser 为 `0.2.23`；界面已隐藏块 ID、`p.N` 和解析类型，首页元数据改用整页视觉输入，微小图像/公式裁剪有确定性门禁，化学式支持化学计量下标与离子电荷上标。 |
| 提示词生成应用 | 完成 | 蓝图预览、能力/网络确认、构建检查、CSP 沙箱预览、不可变版本、接受挂载和回滚数据结构。 |
| 策展插件目录 | 完成 | Ed25519、SHA-256、递增 sequence、撤回、可信离线缓存、开发者模式门禁、控制室导入/安装入口及 GitHub PR/签名 CI。 |
| 工具链代理 | 完成 | ToolchainAdapter/ToolRun、探测/授权/暂存/日志/取消/回收；无第三方依赖模拟适配器已验收。 |
| Windows 发布 | 完成（未签名） | Reader Runtime 完整性门、NSIS 与 `win-unpacked` 构建成功；源码构建版和打包版 Electron E2E 均通过；加密 AppData 下的 `EXDEV` 原子写入降级与 Runtime IPC 安全关闭已实机验证。 |

## 自动化基线

| 检查 | 结果 |
| --- | --- |
| `pnpm typecheck` | 通过，全部 workspace strict 类型检查。 |
| `pnpm test` | 最近完整基线通过：53 个测试文件、284 项测试；最后一次化学式渲染边界修改后，定向 `paper-reader-v2` 3/3 通过，完整套件需恢复后再跑。 |
| `pnpm build` | 通过。 |
| `pnpm test:e2e:built` | 通过，真实 Electron 源码构建版。 |
| `pnpm package:win` | 通过，含 Reader Runtime 完整性门。 |
| `pnpm test:e2e:packaged` | 通过，真实 `win-unpacked/Sci Workplace.exe` 并覆盖重启。 |
| `pnpm test:e2e:paper-reader-live` | 通过，打包应用对真实 Zotero PDF 完成零模型调用离线审计；来源面板不再显示内部 ID、`p.N`、解析类型和图中文字碎片，原 PDF SHA-256 不变。 |
| Zotero 离线解析全库 | 上一完整实现指纹 `8fad6259…` 下 30/30 个可访问唯一 PDF 通过、11 条失效附件单列。化学式边界修正产生新指纹 `9a4597ac…`，重跑到 6/30 后因系统迁移请求安全中止，需恢复后从头完成。 |
| Zotero 真实模型全库 | **未执行**。没有获得当前预算的一次性付费授权；`fullCorpusComplete=false`。必须在当前代码指纹离线 30/30 后重新展示预算并等待一次明确确认。 |
| `pnpm verify:plugin-catalog` | 通过。 |
| `git diff --check` | 通过。 |

Electron E2E 真实创建两个 Workbench v1 实例并绑定主对话，验证论文精读 58/42、Agent 宽/窄屏行为、工作台重启恢复以及项目/授权目录输入文件字节级不变。单元/集成测试覆盖布局接受/拒绝/陈旧 revision、MountIntent 幂等、证据质量门、扫描件拒绝、生成应用 CSP、市场签名/哈希/撤回/离线缓存和工具链取消/产物回收。

论文全文任务在用户确认前先完成不消耗 token 的主文/SI 离线解析，按真实来源块给出正常调用数、预计 token 与包含自动纠错/拆批余量的硬上限。运行中翻译批次按 8→4→2→1 自动缩小；已完成的模型解读、逐块译文和每块最大安全批次进入事件检查点，Runtime 重启后不会重新生成全文解读或把失败单块重新扩成大批次。

## 当前安装包

- 路径：`apps/desktop/release/Sci-Workplace-0.1.0-windows-x64.exe`
- 大小：729,052,992 bytes
- SHA-256：`6AFCA361689D9BA2CF5BBFDE4065B38A979B5C419B83DC215A3A770C68B3CE65`
- Authenticode：`NotSigned`

构建产物和截图被 `.gitignore` 排除。正式外部分发仍需要组织证书、时间戳签名、SBOM、SmartScreen 与干净 Windows 11 安装/升级/卸载验收。

## 当前停止点

- 当前源码实现指纹：`9a4597acfa9cbf5fefb5f3a5e431f2d2b71aff564909f3944f140027f3d2b3e9`。
- Zotero 语料身份：`c661b6ae369209f923eb8629e971cc5c8e3c4e527f9e3e5c06da4658398cd629`；41 个非回收站 PDF 附件，30 个可访问唯一 PDF，11 个 `missing_attachment`。
- 新指纹离线复验在 6/30 通过后被安全中止；测试沙箱按篇清理，没有模型调用。
- 上一完整离线预算（已因实现指纹变化而失效）：1,335 次预计调用（文本 1,018、视觉 317），预计 24,422,165 token，硬上限 44,205,669 token。
- 恢复后先执行完整类型检查、单元/集成、Python、Electron 与 Windows packaged E2E，再以 `CORPUS_FRESH=1` 重跑全库离线清单。只有新的 30/30 预算经用户一次确认后，才允许执行真实模型全库任务。

## 明确不在 v1 范围

真实云同步、实时协作、公共自助发布后台、付费系统、投稿引用插件、真实 Origin/C4D 适配器、多论文综合和扫描 PDF OCR。数据身份、角色与事件字段已为未来能力预留，但不把尚未实现的远程能力伪装为可用。
