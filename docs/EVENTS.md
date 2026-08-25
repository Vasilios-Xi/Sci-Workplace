# 事件模型

统一事件信封字段：

```ts
interface RuntimeEventEnvelope<TPayload> {
  id: string;
  streamId: string;
  sequence: number;
  kind: string;
  schemaVersion: number;
  timestamp: string;
  actor: EventActor;
  agentId?: string;
  traceId: string;
  provenanceRefs: string[];
  payload: TPayload;
}
```

每个 `streamId` 使用 SQLite `BEGIN IMMEDIATE` 分配严格递增序号。当前 schema migration 版本存入 `schema_migrations` 和 `PRAGMA user_version`。

主要事件族：

| 事件族 | 已实现事件 | 用途 |
|---|---|---|
| session | `session.created`, `session.updated`, `session.fork_origin`, `session.forked`, `session.title_generated` | 创建、归档/恢复、切换投影、fork 来源与标题生成 |
| turn/message | `turn.started`, `turn.completed`, `turn.cancelled`, `turn.failed`, `message.recorded` | 对话历史、结束状态和恢复 |
| timeline | `timeline.append`, `timeline.patch` | 推理、助手消息、工具、审批和通知卡片的可回放 UI 投影 |
| context | `context.pinned`, `context.unpinned`, `context.pin_imported`, `context.compacted`, `context.compiled` | 固定来源、投影恢复、压缩依据与最终模型上下文 |
| model | `model.requested`, `model.chunk_batch`, `model.completed`, `model.failed` | 模型可见请求、批量流片段、usage/成本与异常结束 |
| tool | `tool.proposed`, `tool.started`, `tool.completed`, `tool.failed` | 工具 schema、参数、生命周期、结果和 Artifact 引用 |
| file change | `tool.file_changed`, `tool.file_deleted`, `tool.file_change_reverted`, `tool.file_change_imported`, `tool.file_change_recovered` | 写入/删除的 diff、哈希、快照、撤销和投影修复 |
| approval | `approval.requested`, `approval.resolved`, `approval.expired` | 用户决策、取消/重启后的过期处理 |
| agent definition | `agent.definition_created`, `agent.definition_updated`, `agent.definition_archived`, `agent.definition_restored`, `agent.tool_policy_changed` | 用户角色库、归档恢复与全局工具策略 |
| agent binding/capability | `project.agent_enabled`, `project.agent_disabled`, `session.agent_binding_created`, `session.agent_binding_changed`, `agent.capability_snapshot_created` | 项目启用、会话主管/成员及不可变工具能力快照 |
| agent run/task | `agent.run_created`, `agent.run_started`, `agent.run_paused`, `agent.run_resumed`, `agent.run_completed`, `agent.run_failed`, `agent.run_cancelled`, `agent.clarification_requested`, `task.assigned`, `task.taken_over` | 持久成员执行、暂停取消、追问、任务委派与接管 |
| agent memory | `agent.memory_created`, `agent.memory_updated`, `agent.memory_superseded`, `agent.memory_deleted`, `agent.memory_cleared`, `agent.memory_used`, `memory.extraction_requested`, `memory.extraction_completed`, `memory.extraction_failed` | 记忆来源、版本、使用审计及异步提取诊断 |
| channel/mailbox | `channel.created`, `channel.settings_changed`, `channel.message_sent`, `channel.run_started`, `channel.run_completed`, `channel.paused`, `channel.archived`, `mailbox.message_sent`, `mailbox.message_read` | 可回放私聊/群聊、有限轮执行、顺序通信和结果收敛 |
| research | `research_object.created`, `research_object.updated`, `research_object.related`, `research_object.recovered`, `research_object.relation_imported` | 科研对象图及项目投影调和 |
| artifact | `artifact.provenance_recorded`, `artifact.provenance_imported` | 产物输入、文件哈希、模型/工具/插件版本和 trace |
| skills/plugins | `skill.installed`, `plugin.scaffolded`, `plugin.installed`, `plugin.enabled`, `plugin.disabled`, `plugin.settings_changed`, `plugin.reloaded`, `plugin.reload_failed`, `plugin.exported`, `plugin.uninstalled` | 扩展来源、权限、状态、完整性和回滚诊断 |
| settings/data | `settings.primary_agent_profile_changed`, `settings.provider_changed`, `settings.harness_changed`, `settings.mcp_changed`, `settings.mcp_removed`, `settings.database_backed_up` | 旧主 Agent 兼容投影、Provider、Harness、MCP 和本地数据操作审计 |

`traceId` 贯穿一次模型 step、工具调用和产物登记。Artifact 另记录 Agent、模型、工具、插件版本、输入对象、输入文件哈希、会话和任务。

达到有效输入预算的 80% 时，Context Compiler 先写入 `context.compacted`，其中包含覆盖序号、摘要和原消息事件引用；随后 `context.compiled` 再记录真正送模的摘要投影。`model.completed` 使用带版本、日期和官方来源的外部价格表记录首事件/总延迟与费用估算。

SQLite 备份使用 WAL checkpoint + `VACUUM INTO` 创建一致性快照，不覆盖已有目标。诊断导出递归脱敏 credential-like 字段和 `sk-*` 字符串。

投影文件只缓存可移植视图。读取时会校验形状、ID、序号和路径；损坏投影由事件恢复，无法由事实源解释的领先状态不会静默写回事件。流式 chunk 只用于回放，最终 `message.recorded` 是完整消息确认；重启时没有完成事件的流显示为“已中断”。
