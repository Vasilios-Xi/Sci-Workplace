# 系统重置恢复记录（2026-08-30）

本文件记录系统重置前上传到 GitHub 的可恢复开发状态。它是恢复入口，不是“开发完成”声明。

## GitHub 与分支

- 私有仓库：`https://github.com/Vasilios-Xi/Sci-Workplace`
- 默认分支：`main`
- 主线在制作快照前的本地提交：`ae5d417`，比当时 `origin/main` 领先 3 个提交。
- 独立功能分支：`vasilios/citation-workbench`（制作快照前为 `5c3e5e9`）。
- 历史开发分支：`vasilios/sci-workplace-next`（`98fa0f3`）。
- 当前 Workbench/Paper Reader V2 未完成验收的源码保存于 `vasilios/system-reset-snapshot-20260830`。
- 制作快照时 stash 为空，另外两个工作树均为 clean。

## 已实现内容

- Workbench v1 壳层：项目多实例、主 Agent 对话、多个 Run、可拆分布局、持久设备状态、自动挂载、布局确认和控制室。
- 薄科研内核：文档/产物不可变修订、证据锚点、批注、研究对象关系、Run、审批、幂等事件与本地 owner 权限。
- Plugin API v4：`Workbench*` 契约、模板、命令、工作流、沙箱面板、产物渲染器和宿主代理能力；正式入口不保留 v3/v5 兼容投影。
- 提示词生成应用：`WorkbenchBlueprint` 预览、能力确认、构建检查、CSP 沙箱、不可变版本、接受挂载与回滚。
- 策展插件市场：签名索引、包哈希、撤回、可信离线缓存、开发者模式与 GitHub PR/CI 流程。
- 外部工具链代理：发现、版本、授权、隔离暂存、日志、取消和产物导入，包含无第三方依赖模拟适配器。
- Paper Reader V2：主文/多 SI、完整离线画像、一次预算授权、全文双语、逐节精读、图表/公式分析、证据链、复现、综合、确定性质量门、断点恢复、局部重跑、来源约束问答和原子导出。

## 解析与显示问题的当前修复

- 来源面板不再显示 `S003`、`C005` 等内部块 ID，不再显示 `p.1`/`p.3` 或 `front_matter`、`figure_text` 等解析类型。
- `front_matter`、图中文字、页眉页脚、参考文献和公式块不作为逐段正文卡显示；内部 ID 仅保留在 DOM/证据定位数据中。
- 首页题名、作者、期刊、日期和 DOI 使用完整首页 2× 渲染图进入视觉模型，不向模型发送本地抽取的小碎片。
- 普通图表最低 96×42 pt、页面面积至少 1.2%、图片至少 192×84 px；低于门槛不会进入视觉模型。
- 公式裁剪最低 96×28 pt、3× 渲染、至少 288×84 px；宽公式即使文本层只有编号也会保留完整行。
- Parser/runtime 版本为 `0.2.23`；已对 Butler–Volmer 宽公式和 84 px 临界高度公式做真实 PDF 回归。
- 化学式渲染覆盖整数/小数化学计量、括号、结晶水、显式电荷、单原子离子、双原子离子和配合物，例如 `Li6.25Al0.25La3Zr2O12`、`(NH4)2SO4`、`CuSO4·5H2O`、`NH4+`、`Fe3+` 和 `[Fe(CN)6]3−`。

## 已验证与尚未验证

最近一次完整基线（最后的化学式边界小改之前）：

- `pnpm typecheck` 通过。
- Vitest 53 个文件、284 项测试通过。
- Reader Runtime Python：48 项收集，38 通过、10 条依赖条件跳过。
- `pnpm build`、Electron 源码 E2E、Windows 打包、packaged E2E、真实 PDF packaged 离线审计和 `git diff --check` 通过。
- Windows 安装包：729,052,992 bytes；SHA-256 `6AFCA361689D9BA2CF5BBFDE4065B38A979B5C419B83DC215A3A770C68B3CE65`；未签名。

最后一次化学式边界修改之后：

- `pnpm build` 通过。
- `packages/runtime/tests/paper-reader-v2.test.ts` 3/3 通过。
- 完整测试套件尚未重跑。
- 当前实现指纹 `9a4597acfa9cbf5fefb5f3a5e431f2d2b71aff564909f3944f140027f3d2b3e9` 的 Zotero 离线全库复验在 6/30 后按用户要求安全停止。
- 真实模型全库测试尚未获得付费确认，`fullCorpusComplete=false`，不得标记完成。

## Zotero 当前语料与失效预算

- 只读本地 API：`http://127.0.0.1:23119`（重装后需重新安装并启动 Zotero）。
- 语料身份：`c661b6ae369209f923eb8629e971cc5c8e3c4e527f9e3e5c06da4658398cd629`。
- 41 个非回收站 PDF 附件；30 个可访问唯一 PDF；11 个 `missing_attachment`。
- 上一完整离线实现指纹：`8fad6259539807db0e1a541b99d56b121cbdf7784ef3b94b2f5ebc781c7bd7fc`，30/30 离线通过。
- 上一预算：文本调用 1,018、视觉调用 317、合计 1,335；预计输入 21,375,282、输出 3,046,883、总计 24,422,165 token；硬上限 44,205,669 token / 4,005 次调用。
- 该预算因源码指纹变更而失效。恢复后必须重做完整离线清单并展示新预算，不能复用旧授权 ID。

## 未上传内容

以下内容故意不进入 GitHub：Zotero PDF、由论文生成的调试截图与解析中间文件、`tmp/`、`artifacts/`、`node_modules/`、打包目录、安装包、AppData、数据库、OAuth token、API key 和其他凭据。它们不是恢复源码所必需，且可能包含版权内容、隐私或机器绑定加密数据。

## 新系统恢复步骤

```powershell
git clone https://github.com/Vasilios-Xi/Sci-Workplace.git F:\Sci-Workplace-dev
Set-Location F:\Sci-Workplace-dev
git fetch --all --prune
git switch vasilios/system-reset-snapshot-20260830
corepack enable
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

然后按 `docs/DEVELOPMENT.md` 重建 Reader Runtime 和 Windows 安装包。重新安装 Zotero 后先确认本地 API 可用，再运行：

```powershell
$env:CORPUS_FRESH='1'
pnpm test:zotero:paper-reader:v2:inventory
Remove-Item Env:CORPUS_FRESH
```

仅当新指纹的离线清单 30/30 通过并向用户展示精确预算、获得一次明确确认后，才可带 `--run --authorization <new-id>` 执行真实模型全库测试。

## 重装后必须重新配置

- GitHub CLI 登录。
- Codex/ChatGPT 登录与用量授权。
- 文本模型、视觉模型及其他供应商凭据；不要假设旧 Windows 加密凭据可在新系统解密。
- Zotero 数据目录或同步恢复。
- Origin/C4D 等外部软件路径与工具链授权。
