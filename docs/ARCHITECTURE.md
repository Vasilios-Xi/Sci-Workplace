# Sci Workplace 架构说明

## 1. 边界

Sci Workplace Core 只管理 Harness 通用能力：服务生命周期、事件、模型调用、工具执行、权限、上下文、Agent 协作和科研通用对象。文献检索、PDF 解析、统计分析、Notebook、引用管理和论文写作均由后续扩展提供。

核心模块不能被外部插件替换：

- 微内核与作用域；
- SQLite 事件库；
- Agent loop；
- 权限与审批；
- 项目路径边界。

## 2. 进程模型

Electron Main 创建安全窗口并管理 Runtime 子进程。Runtime 随机选择端口，只监听 `127.0.0.1`；主进程生成 256-bit 临时令牌。Renderer 通过 preload 获取连接信息，使用 Bearer token 和 WebSocket 通信，但没有 Node 权限。

供应商请求、文件系统、终端、MCP 和插件进程全部位于 Runtime 侧。API Key 只在 Electron Main 的加密文件和 Runtime 内存中出现；Codex OAuth 由本机 Codex App Server 管理，Renderer 不接触 OAuth 凭据。

## 3. 微内核

`@openlab/kernel` 提供：

- `ServiceToken<T>`：稳定、类型化服务标识；事件库、审批、工具注册表等特权服务使用 `sealed` Token，后代作用域即使构造同名 Token 也不能覆盖；
- `KernelModule<TConfig>`：模块 ID、版本、依赖、作用域和健康检查；
- `KernelScope`：严格执行 `app → project → session → agent`，拒绝跨级或嵌套 Agent；模块在隔离的候选子作用域启动；
- `Effect`：资源 setup/disposer，逆序、幂等、异步释放；
- `EventBus`：观察型 `publish`、顺序型 `serial`、拦截型 `pipeline`；
- `Registry<T>`：工具、模型、上下文和贡献项的动态注册；
- `Kernel.hotSwap`：候选启动与健康检查通过后原子切换，失败保留旧实例；候选解析服务时排除同模块旧实例，避免健康检查误用旧服务而产生假成功。

模块图在应用前完成缺失依赖和循环诊断，也允许后续批次依赖同一作用域内已经激活的模块。批量启动失败时逆序回滚。

## 4. 事件与投影

SQLite WAL 是运行状态事实源。所有状态界面都是事件投影；项目 `.openlab` 文件用于可移植科研元数据和产物索引，不替代会话事件。投影文件损坏或缺失时从事件重建；投影领先于事件的异常状态会被拒绝或调和，避免静默覆盖事实源。

关键不变量是“模型可见即已记录”：`context.compiled` 和 `model.requested` 在 Provider 调用前提交，包含贡献来源、最终消息投影和工具 schema。模型流按批次写入 `model.chunk_batch`，最终消息写入 `message.recorded`。

重启时 Runtime 重放 `timeline.append`/`timeline.patch`、消息、Agent 定义、项目/会话绑定、能力快照、记忆、任务和频道事件。未完成节点与审批标记为 `interrupted`/`expired`，已经落盘的 chunk 原样保留。会话 fork 复制可回放事件并记录来源，同时为原会话成员生成新的能力快照，而不是复制不可审计的内存状态。

## 5. Agent loop

```text
user input
  → context contributions
  → deterministic budget/compiler
  → record model-visible request
  → provider stream
  → tool calls
  → approval policy
  → execute + record result
  → next step or finish turn
```

每轮最多 12 个模型 step，避免无界工具循环。工具参数使用 JSON Schema/Ajv 验证。权限模式分为 `auto`（按分类安全策略自动审核）、`trusted`（跳过普通项目操作的询问，但不越过禁止项与高风险边界）、`ask`（写入、执行和外部操作前询问）与 `read_only`；`read_only` 会在送模前移除变更型工具，而不只是在执行阶段拒绝。写入与删除工具先生成 unified diff，批准后创建 SHA-256 变更集和快照；撤销会校验当前哈希，防止覆盖后续修改。

全新安装在用户确认前没有 Agent；首次引导只创建用户命名并确认的一名角色。此后所有 Agent 都来自用户创建、角色卡导入或对模板的明确确认，插件的 `agentTemplates` 也绝不自动实例化。Agent 定义属于全局角色库，项目绑定决定可用范围；会话固定一名 `lead` 并可加入若干 `member`，首轮后主管锁定，成员只可在空闲期变更。头像可选择内置样式或本地 PNG/JPEG/WebP；本地图片在 Renderer 中中心裁切为 256×256 WebP，Runtime 校验媒体签名和 256 KB 上限后写入事件，角色卡只携带图片数据而不携带本地路径。

无显式提及时由主管回答；`@Agent` 只路由给当前会话成员，成员并行完成明确任务后由主管收敛。模型工具只能使用 `delegate_task`、`send_agent_message`、`run_channel`、`wait_for_agent_runs` 和 `ask_lead`，不存在创建 Agent 的工具。成员不能递归委派，也不能自行把其他角色加入会话；并发上限是运行限制，不是角色数量限制。成员只接收任务、显式引用、自己的项目记忆和关联频道消息，不继承主管的完整历史。

每名会话成员在加入或用户主动刷新时生成不可变的能力快照。实际工具集合是 Agent 策略、项目绑定、会话快照、频道上限、权限模式、目录授权、模型能力以及当前有效插件/MCP 的交集；插件停用或凭据撤销属于安全例外，会立即移除失效工具。

Renderer 中的主输入框、Agent 编辑器和供应商路由设置必须复用同一个 `ModelPicker`，并直接消费 `BootstrapSnapshot.models`。模型按 `providerId` 动态分组；新增或刷新模型不得在单个页面维护独立 `<option>` 列表，以保证所有模型入口自动保持同一格式与顺序。

记忆以 Agent × Project 隔离，只有用户手动创建的全局置顶记忆可以跨项目。自动记忆和经验默认关闭；开启后由无工具、低思考的小工具模型异步提取候选，秘密、外部资料指令、低置信内容和未经验证的事实被拒绝。事件流仍是事实源，SQLite FTS5 只是可重建检索投影；上下文中的记忆最多占 10% 或 8K token。

频道是 Agent 间通信的只读用户视图。项目内 Agent 对应唯一复用私聊，用户可建立 2–6 人群聊；频道不会自主启动，只能由当前对话、显式提及或主管工具触发，并受最少/最多回复轮数约束。用户通过任务卡、补充信息、暂停、恢复、接管和取消影响协作，不能直接在频道输入。

## 6. Context Compiler

贡献项先按 stable/dynamic，再按优先级排序：

1. 核心安全策略与稳定工具 schema；
2. 项目指令、Agent 定义和用户置顶记忆；
3. 固定科研对象、证据、项目记忆与经验；
4. 当前任务、关联频道消息和插件上下文；
5. 最近消息和工具结果；
6. 输出预留。

工具 schema 使用强制的 `request-schema` 投影，不能被普通上下文挤出；编译器同时预留最近消息和输出空间。达到 80% 时生成带原事件引用的可追溯摘要，长工具结果转为 Artifact。预算不足只改变模型投影，事件库不删除。Context Inspector 显示来源、信任级别、token 估算、纳入状态、压缩历史和稳定前缀占比。

所有工具返回值在再次送模前统一包裹为不可信输出；附件、科研对象、MCP 资源和插件上下文也不能把内部文本提升为系统或用户指令。

聊天附件在事件中保存为工作区根、相对路径、大小、媒体类型和 SHA-256，不保存重复的 base64。每次编译上下文都会重新验证文件修订：短文本作为 `untrusted-research-data` 投影；图像只在目标模型声明 `supportsVision` 时读入并转换为供应商原生格式。新附图若选择了非视觉模型会在创建轮次前失败，历史中的旧图片仍可保留为可追溯引用，不会阻止后续纯文本对话。

## 7. Workbench v1、科研内核与 Plugin API v4

Workbench 是项目级应用底座：同一项目可创建多个 `WorkbenchInstanceV1`，每个实例绑定一个 `primaryConversationId`，Agent、模型、工作流与工具链执行统一记为多个 `RunRecordV1`。共享业务状态和设备 UI 状态严格分离；布局拓扑变化走带 base revision 的 `LayoutProposalV1`，Artifact 自动挂载走幂等 `MountIntentV1`。

薄科研内核统一持有不可变文档/Artifact 修订、`EvidenceAnchorV1`、`AnnotationV1`、科研对象与关系、Run 和 ReviewRequest。所有 AI 结论通过锚点回到文档 SHA-256、页、块与可选坐标/图表/公式。插件不能直接访问 SQLite、密钥、任意路径或桌面程序。

正式插件只使用 Plugin API v4 的复数 `workbenches` Host。TypeScript 插件由 `PluginProcess` 在独立 Node 进程运行，通过 JSON-RPC 2.0/stdio 调宿主；v4 运行上下文不暴露旧 `worktable` 或单数 `workbench` 名称。普通表单与审批由宿主渲染，专业面板使用 CSP iframe、一次性 MessagePort 和有界方法。跨插件协作只经过文档、证据、研究对象和 Artifact 接口。

插件测试在临时副本执行，移除候选包管理器控制文件，禁用 lifecycle scripts，完成严格类型检查、契约测试与进程健康检查。生产候选先 staging 再原子切换。未签名包只有开发者模式可运行；策展包必须通过 Ed25519 索引、SHA-256、撤回与清单权限复验。

## 8. DeepSeek Provider

Provider 直接调用 DeepSeek `/chat/completions`，业务层只接触 `ModelEvent`。SSE 解析支持 reasoning、文本、跨 chunk 工具参数、usage、结束原因和缓存 token。模型列表由 `/models` 与本地能力表合并；模型 ID 不写入 Agent loop。

只有首个增量到达前的 429、超时和临时 5xx 才重试。请求支持取消，首字节与流空闲分别有超时，异常结束写入 `model.failed`，已显示的部分输出标记为中断。费用估算由可替换的版本化价格表完成。

## 9. Codex App Server Provider

ChatGPT OAuth 模型通过本机 Codex App Server 的 JSON-RPC 协议接入。每个 Sci 模型 step 创建临时 Codex thread，并把最终 Sci 对话投影作为权威 transcript；模型清单、上下文窗口、推理档位和视觉能力来自 App Server，不在 UI 中硬编码。

Sci 将当前可用工具注册为 `dynamicTools`。App Server 的 `item/tool/call` 服务端请求只被转换为 `ModelEvent.tool_call_delta`，随后中断临时 Codex turn；Runtime 仍按统一权限、目录授权和审计链执行工具，下一步把真实工具结果送回模型。Provider 明确禁止 Codex 原生命令、文件修改、MCP、浏览器和协作工具，避免绕过 Sci 的审批边界。

图像输入在事件中仍使用文件引用。对支持视觉的 Codex 模型，Provider 在隔离 bridge 目录中创建精确临时图片并以 `localImage` 传给 App Server，thread 结束后立即删除；不支持视觉的模型不会收到图片。

## 10. Provider 原生多模态格式

内部 `ModelMessage` 使用统一的 `text` / `image_url` 内容部分。OpenAI-compatible 与 DeepSeek 映射为 Chat Completions `image_url`；Ollama 提取 data URL 的 base64 到 `images`；Codex App Server 映射为 `image` 或 `localImage` 用户输入。模型请求审计事件只保存引用和文本投影，不写入图像 base64。

## 11. Windows 打包与 Reader Runtime

Electron Builder 的 Windows 打包在构建前强制执行 Reader Runtime 完整性验证。离线 Runtime 包含 Worker、Docling/解析器分发元数据、模型、第三方许可证、`integrity.json` 和带语义清单的 `openlab-toolchain.json`；任一文件缺失、哈希不符、引用未列入清单或 `network` 不是 `false` 时，打包或启动注册失败。

正式包通过 `OPENLAB_READER_RUNTIME_ROOT` 把资源目录交给 Runtime，作为 `source=bundled` 的 `openlab.reader-runtime` 工具链注册。PDF 作业仍在 Job Service 的资源上限与工作目录中运行，输入必须是修订绑定的授权文件。
