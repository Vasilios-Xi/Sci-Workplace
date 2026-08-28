# Sci Workplace Plugin API v4

事实源：[`packages/protocol/src/index.ts`](../packages/protocol/src/index.ts) 与 [`packages/plugin-sdk/src/index.ts`](../packages/plugin-sdk/src/index.ts)。正式安装入口只接受 `HarnessPluginManifestV4`；旧清单和旧工作台投影不属于 v4 作者契约。

## 清单与贡献

```json
{
  "schemaVersion": 4,
  "apiVersion": 4,
  "id": "lab.example",
  "name": "Example Research Plugin",
  "version": "0.1.0",
  "engine": "^0.1.0",
  "entry": "src/index.ts",
  "permissions": ["documents:read", "evidence:read", "workbench:read"],
  "contributes": {
    "tools": ["inspect_evidence"],
    "workbenchBlueprints": [],
    "workflows": [],
    "uiPanels": [],
    "surfaces": [],
    "artifactRenderers": [],
    "toolchainAdapters": []
  }
}
```

所有 contribution ID 必须使用插件命名空间。清单权限只是能力上限，不能跳过项目授权、Agent 能力快照、只读模式、逐次审批、文件边界或审计。v4 使用 `workbench:*`、`models:invoke` 与 `generated-apps:build`，拒绝 `worktable:*`、`models:run` 和 `generated-apps:publish`。`project:*`、`process:spawn`、裸 `network` 与 `settings:write` 不属于 v4 权限；文件、浏览器、模型和桌面程序均须经过宿主代理。

## Workbench v1

- `WorkbenchBlueprintV1`：不可变模板版本、输入 Schema、布局树、窗格、角色槽位、命令和初始内容。
- `WorkbenchInstanceV1`：共享业务状态；一个项目可有多个实例，每个实例可绑定 `primaryConversationId`。
- `WorkbenchDeviceStateV1`：设备本地几何和导航，不进入模型上下文或共享事件。
- `MountIntentV1`：只能把不可变 Artifact 修订挂到声明为 `autoMount` 的目标角色槽位，并由 `idempotencyKey` 去重。
- `LayoutProposalV1`：以当前 revision 为基线描述完整差异。新增、删除或重排窗格只能先提案，再由用户确认；陈旧基线变为 `stale`。

v4 Host 只暴露复数 `context.host.workbenches`：

```ts
const instances = await context.host.workbenches.list();
const proposal = await context.host.workbenches.proposeLayout({
  instanceId,
  baseRevision: instance.revision,
  title: '增加复现窗格',
  reason: '展示可执行复现步骤',
  layout,
  panes,
  slots,
});
```

插件不能直接改布局，也不能操作其他插件贡献的 Blueprint。跨插件协作只通过宿主的文档修订、证据锚点、研究对象、Artifact 和角色槽位完成，不允许插件间代码依赖。

## 文档、证据与 Artifact

- `documents:read`：通过 `resources.open/read/release` 读取用户已授权的不可变 `DocumentRevisionRef`；宿主每次核对 SHA-256。
- `evidence:read/write`：读写 `EvidenceAnchorV1`。锚点包含文档修订、页、块、选择器以及可选坐标、图、表或公式。
- `artifacts:publish`：创建内容寻址 Artifact 修订和 Source Map。输入文件哈希、Agent、会话、trace 与插件版本进入 provenance。
- `annotations:*`、`research:*`：由宿主管理批注、科研对象和关系；插件不能直接访问数据库。

没有证据锚点的 AI 结论不能进入首方论文精读质量门。

## 工作流、模型与工具链

工具和工作流都收到 `AbortSignal`。取消、超时、插件停用或应用关闭时必须停止。v4 工作流上下文使用 `workbenchInstanceId`。

`toolchains:execute` 暴露 `toolchains.adapters/run/getRun/cancelRun/runLog`。适配器清单声明探测、版本约束、输入/输出 Schema 和操作；真正的可执行程序、暂存目录、环境、日志和产物导入由宿主控制，插件拿不到任意进程句柄。

## 专业沙箱界面

普通表单、任务、审批和权限提示由宿主渲染。PDF 阅读器、知识图谱与绘图画布可贡献 `uiPanels`/`surfaces`，运行在独立 iframe 沙箱中：无 Node、无密钥、无 Runtime bearer token、无直接文件或互联网访问。

宿主通过一次性 `MessagePort` 提供四个有界方法：

- `context.read`
- `tool.execute`
- `evidence.reveal`
- `resource.open`

请求必须携带一次性 token、唯一 ID、方法和对象型参数，单条消息上限 128 KiB。非只读工具由宿主展示确认，后端再次校验插件、Blueprint、实例、pane/tab、工具声明和证据目标。PDF 票据限时、限次且仅指向经哈希验证的只读资源。

## 生成应用

v4 仅提供 `generatedApps.list/propose`。固定流程为：提示词 → `GeneratedAppBlueprintV1` → 布局/能力预览 → 用户确认 → 构建 → CSP 沙箱预览 → 接受并挂载。生成应用项目私有、版本不可变，默认 `networkDomains=[]` 且没有文件能力；能力升级必须重新确认。它不能自行发布到插件市场。

## 运行与分发边界

插件在独立 Node 进程中通过 JSON-RPC/stdio 调宿主；主 Renderer 不加载插件代码。正式目录只安装平台签名且未撤回的包；未签名目录/ZIP 仅在开发者模式下允许。策展包同时校验 Ed25519 索引、SHA-256、manifest 身份/版本/权限和目录安全。
