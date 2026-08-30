# Plugin API v4 开发指南

## 生成模板

推荐在 Sci Workplace 对话中调用 `scaffold_plugin`。它会在 `<project>/.openlab/plugin-dev/<plugin-id>` 创建：

```text
manifest.json
package.json
tsconfig.json
types/openlab-plugin.d.ts
src/index.ts
contract.test.mjs
README.md
```

生成的本地 `.d.ts` 包含 v4 Workbench、证据、生成应用与工具链 Host 类型，入口不在运行时导入 Sci Workplace 内部包。也可复制 [`templates/plugin-v4`](../templates/plugin-v4/README.md)。

## 最小入口

```ts
/// <reference path="../types/openlab-plugin.d.ts" />
import type { OpenLabPlugin } from '@openlab/plugin-sdk';

const plugin = {
  apiVersion: 4,
  tools: [{
    definition: {
      name: 'inspect_evidence',
      title: '检查证据',
      description: '列出当前项目的证据锚点。',
      inputSchema: { type: 'object', additionalProperties: false },
      risk: 'read',
      renderHint: 'generic',
    },
    async execute(_input, context) {
      const anchors = await context.host.evidence.list();
      return { callId: context.traceId, ok: true, content: `锚点：${anchors.length}`, artifactIds: [], metadata: {} };
    },
  }],
} satisfies OpenLabPlugin;

export default plugin;
```

Runtime 注册的模型工具名带插件命名空间。工具输入必须有 JSON Schema，输出必须是结构化 `ToolExecutionResult`，再次送模时始终标为不可信资料。

v4 插件不得申请 `project:*`、`process:spawn`、裸 `network` 或 `settings:write`。分别使用 `workspace:*`、`browser:*`、`models:invoke` 和 `toolchains:execute`；运行进程即使收到伪造清单也不会为 v4 打开直接网络或子进程权限。

## 测试与本地安装

`test_plugin` 在临时副本中执行清单/目录检查、禁用 lifecycle scripts 的依赖准备、TypeScript strict 检查、`contract.test.mjs`、独立进程健康检查和贡献验证；不会修改插件源码。依赖只允许 npm registry 版本，拒绝 `file:`、`link:`、`workspace:`、Git 与 HTTP 依赖。

未签名开发目录或 ZIP 必须先在“设置 → 安全”开启开发者模式。安装仍展示权限和 SHA-256；关闭开发者模式会立即停用所有未被策展签名证明覆盖的插件。

## 工作台插件规则

1. 在 manifest 贡献版本化 `WorkbenchBlueprintV1`，输入由宿主 Schema 表单收集。
2. 用角色槽位表达 `source`、`analysis`、`evidence`、`output` 等语义，不依赖其他插件的 pane ID。
3. 自动结果用 `MountIntentV1` 挂载；幂等键必须对同一逻辑产物稳定。
4. 布局拓扑变化只能提交 `LayoutProposalV1`，不可在工具执行中静默改 UI。
5. 结论保存 EvidenceAnchor ID；不要把绝对路径、数据库 ID 或密钥写进面板上下文。
6. 工作流响应 `AbortSignal` 并支持局部恢复；长任务通过 Job/Run 报告 stage 与 progress。

## 专业面板

面板只能通过 token 绑定的 MessagePort 调 `context.read`、`tool.execute`、`evidence.reveal` 和 `resource.open`。不要访问父窗口 DOM，不要假设 iframe 同源，不要发起网络请求。宿主会限制 CSP、消息大小、资源票据寿命和工具权限。

## 策展提交

将不含 `node_modules` 的源 ZIP 发布到不可变 HTTPS 地址，计算 SHA-256，并通过 PR 更新 `plugin-catalog/index.source.json`。CI 下载并检查包；平台受保护任务签署索引。生成应用不能直接提交，必须显式转换为 v4 插件包并经过同一审核。
