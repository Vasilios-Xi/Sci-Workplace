# Sci Workplace Plugin API 契约

当前版本：Plugin API v3。类型事实源为 [`packages/plugin-sdk/src/index.ts`](../packages/plugin-sdk/src/index.ts)，Manifest 事实源为 [`packages/protocol/src/index.ts`](../packages/protocol/src/index.ts)。本文只描述外部插件可依赖的稳定边界。

## 版本

- v1：兼容旧工具与上下文插件，不提供能力型 Host API。
- v2：兼容旧 Workbench、工作流、资源、作业、模型、批注、产物和科研对象 API。
- v3：新增持久 Worktable、浏览器代理与生成应用；新插件应声明 `schemaVersion: 3`、`apiVersion: 3`。

Manifest 权限只提供能力上限，不会跳过项目授权、Agent 工具策略、权限模式、逐次审批、路径边界或审计。

## v3 Host 能力

插件只可通过 `context.host` 使用已声明能力：

- `workspace:read/edit`：结构化读取、预览 diff、确认后应用编辑；
- `resources:read`：按不可变 `DocumentRevisionRef` 分段读取；
- `jobs:run`、`models:invoke`、`annotations:read/write`、`artifacts:write`、`research:read/write`；
- `plugin-storage`：带 revision 的用户/项目插件命名空间；
- `worktable:read/write`：实例检查、创建、乐观并发更新、绑定会话、挂载内容/产物、证据跳转；
- `browser:observe/interact`：只通过宿主代理，并保留观察版本与人工操作边界；
- `generated-apps:publish`：只发布用户确认的项目静态资源和网络域名/宿主能力白名单。

工具和工作流收到 `AbortSignal`。取消、超时、插件停用或应用关闭时必须停止；返回值必须满足 SDK 的结构化结果类型。

## UI 面板桥

面板运行在 `sandbox="allow-scripts"` iframe 中，具有不透明 origin。CSP 禁止网络、表单、外部脚本和 Node。宿主在 iframe 加载后传入一次性 `MessagePort`：

```js
window.addEventListener('message', (event) => {
  if (event.data?.type !== 'openlab.plugin-panel.connect') return;
  const { token } = event.data;
  const port = event.ports[0];
  port.start();
  port.postMessage({ id: 'context-1', token, method: 'context.read', params: {} });
  port.onmessage = ({ data }) => console.log(data);
});
```

允许的方法只有：

- `context.read`：返回调用插件自身模板、实例、pane 和 tab 的受限上下文；
- `tool.execute`：`params` 为 `{ tool, params }`。工具必须同时列在面板声明与插件工具贡献中；非只读工具弹出用户确认；
- `evidence.reveal`：`params` 为 `{ document, selector, target? }`。Runtime 校验文档修订、选择器和目标 pane/tab/panel 的归属。

每个请求必须携带连接消息中的 `token`、唯一 `id`、方法和对象型 `params`；单条消息上限 128 KiB。响应为 `{ id, ok: true, value }` 或 `{ id, ok: false, error }`。不要依赖主窗口 DOM、React 对象、Runtime bearer token、绝对路径或未文档化消息。

## 生成应用桥

生成应用与插件面板不是同一权限域。它只获得发布时用户确认的 `hostCapabilities`，当前方法为 `worktable.read`、`artifacts.read`、`annotations.read`、`annotations.create` 和 `research.read`。宿主对产物/批注数据去除私有路径和 provenance，并从当前不可变修订重建批注目标，不能由应用伪造文件引用。
