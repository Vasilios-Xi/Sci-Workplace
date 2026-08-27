# TypeScript 插件开发

## 1. 生成开发目录

在对话中调用 `scaffold_plugin`，或在 UI 使用插件脚手架。默认目录为 `<project>/.openlab/plugin-dev/<plugin-id>`，包含：

```text
manifest.json
package.json
tsconfig.json
types/openlab-plugin.d.ts
src/index.ts
contract.test.mjs
README.md
```

本地 `.d.ts` 只提供编译期 SDK 契约，插件入口不需要也不应在运行时导入 Sci Workplace 内部包。

## 2. Manifest

```json
{
  "schemaVersion": 1,
  "id": "lab.example",
  "name": "Example Lab Plugin",
  "version": "0.1.0",
  "engine": "^0.1.0",
  "entry": "src/index.ts",
  "permissions": ["project:read"],
  "contributes": {
    "tools": ["inspect_sample"]
  }
}
```

上述示例是兼容的 Plugin API v1。新 Worktable 插件应使用 `schemaVersion: 3`、`apiVersion: 3` 和能力型权限；旧 Workbench 插件仍可使用 v2。完整宿主方法、工作流与沙箱桥见 [Plugin API 契约](PLUGIN_API_CONTRACT.md)。

v1 的 `project:read/write`、`process:spawn`、`network` 与设置权限继续兼容。权限变化、首次安装、重新启用和热重载都需要用户确认；任何 manifest 权限都不能绕过工具审批。

## 3. TypeScript 入口

```ts
/// <reference path="../types/openlab-plugin.d.ts" />
import type { OpenLabPlugin } from '@openlab/plugin-sdk';

const plugin = {
  apiVersion: 1,
  tools: [{
    definition: {
      name: 'inspect_sample',
      title: 'Inspect sample',
      description: 'Inspect explicitly referenced sample metadata.',
      inputSchema: {
        type: 'object',
        properties: { sampleId: { type: 'string' } },
        required: ['sampleId'],
        additionalProperties: false,
      },
      risk: 'read',
      renderHint: 'generic',
    },
    async execute(input, context) {
      return {
        callId: context.traceId,
        ok: true,
        content: `sample: ${String(input.sampleId)}`,
        artifactIds: [],
        metadata: {},
      };
    },
  }],
} satisfies OpenLabPlugin;

export default plugin;
```

Runtime 暴露的工具名为长度受限的 `plugin__<plugin_id>__<tool_name>`。定义必须包含有效 JSON Schema、风险级别和渲染提示；Sci Workplace 对所有插件工具调用仍强制逐次审批。插件返回值再次送入模型前会标记为不可信资料。

## 4. 依赖规则

依赖声明放在 `package.json` 的 `dependencies`、`optionalDependencies` 或开发期 `devDependencies`。只接受 npm registry 能解析的版本/标签；拒绝 `file:`、`link:`、`workspace:`、Git、HTTP URL 与其他本地来源。最多声明 128 个依赖。

测试和安装不会信任插件自带的 `.npmrc`、workspace、pnpm hook 或 lockfile 配置：这些配置先被移除，依赖在独立临时工作区安装，始终禁用 lifecycle scripts，再复制为不含符号链接的可移植树。生产安装只保留 production dependencies。

## 5. 测试与安装

`test_plugin` 不修改源目录，而是在临时副本中依次执行：

1. Manifest、目录树和依赖说明校验；
2. 隔离安装依赖；
3. TypeScript strict 类型检查；
4. `contract.test.mjs` 契约测试；
5. 独立进程启动、贡献项验证和健康检查；
6. 停止进程并删除临时目录。

契约进程先加入 Windows Job Object，再收到启动握手并加载不可信入口。取消测试会终止整个插件进程。测试成功不等于授权安装。

`install_plugin` 会再次显示来源、权限和依赖，并要求明确批准。生产候选在 staging 安装依赖和健康检查，通过后原子切换并计算最终目录 SHA-256；失败时旧版本继续运行并留下诊断事件。

自动启动同时要求：插件状态为启用、目录哈希与锁一致，以及本机用户数据目录存在该项目路径对应的执行授权。项目内的 `plugin-lock.json` 只是可导出的 provenance，复制项目不会在另一台机器上自动执行插件。

## 6. 上下文、Agent 模板与科研对象

插件可贡献上下文提供器、`agentTemplates`、命名空间科研对象类型、设置 schema、工具卡片和 UI 面板。旧 `agentPresets` 仅兼容映射为模板，不会自动创建角色。限制如下：

- 插件上下文始终改写为 `untrusted`；
- Agent 模板必须由用户预览并确认后才能创建角色；模板工具策略不能超过核心允许范围，也不能使用内部无限制通配符；
- 命名空间类型不能改变 `Source`、`Dataset`、`Experiment`、`Evidence`、`Artifact` 的核心字段语义；
- 插件不能替换微内核、事件库、Agent loop 或权限服务。

## 7. UI 面板

`uiPanels` contribution 由独立面板宿主加载。Runtime 校验入口的 realpath 必须位于插件目录内，签发 60 秒一次性票据并注入严格 CSP；Renderer 将其放入不带 `allow-same-origin` 的 sandbox iframe。面板只能经一次性、令牌绑定的 `MessagePort` 调用 `context.read`、`tool.execute` 和 `evidence.reveal`。写工具由宿主逐次确认，后端再次校验工具声明、插件/模板/实例/标签归属和证据目标；不开放任意文件、网络、Node、凭据或主 React 对象。准确契约见 [Plugin API 契约](PLUGIN_API_CONTRACT.md)。

## 8. 分发与卸载

支持目录或 ZIP 导入/导出。导入拒绝路径穿越、Windows 保留名、符号链接/junction、过量文件及 ZIP bomb；源包不得含 `node_modules`。导出不携带运行时安装的依赖。卸载先注销贡献和结束进程，再删除经过路径验证的安装目录；项目开发源码不会被一并删除。
