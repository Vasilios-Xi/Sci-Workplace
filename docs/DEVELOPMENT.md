# 开发与验收

## 常用命令

```powershell
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
pnpm dev
```

Windows 安装包：

```powershell
pnpm --filter @openlab/desktop package:win
pnpm test:e2e:packaged
```

`test:e2e` 会先构建，再启动真实 Electron；`test:e2e:built` 复用已有构建；`test:e2e:packaged` 启动 `release/win-unpacked/Sci Workplace.exe`，用于发现 ASAR、依赖打包和生产路径问题。

## 测试层次

- 微内核：依赖顺序、循环、失败回滚、异步/幂等清理、作用域覆盖、热替换、三种事件模式。
- 事件库：严格序号、重开恢复、JSON KV、schema migration、一致性备份、损坏投影重建和领先投影调和。
- Provider：SSE 任意分片、4 MB 帧上限、思考、文本、跨 chunk 工具参数、usage、缓存 token、重试、取消与超时。
- 上下文：stable prefix、强制工具 schema、最近消息预留、不可信包装、预算卸载、压缩追溯和原始历史不变。
- 项目服务：路径穿越/符号链接、读取/搜索上限、diff 写入与删除、哈希快照、冲突撤销、科研对象/关系/provenance。
- 持久 Agent：零角色首启、创建/导入/归档/恢复、项目启停、主管锁定、成员变更、最大并发、显式引用隔离、`@Agent` 路由、主管收敛、暂停/取消和崩溃恢复。
- 记忆与工具：默认关闭、项目隔离、全局置顶、秘密/提示注入/低置信拦截、FTS5 重建、能力组映射、不可变会话快照和动态安全失效。
- 频道：项目私聊唯一复用、2–6 人群聊、有限回复轮数、只读/写入权限上限、暂停/恢复/取消、来源引用和 Markdown 导出。
- 扩展：Skill/ZIP 安全、MCP stdio/HTTP tools/resources、TypeScript 插件依赖隔离安装、类型检查、契约/健康测试、进程崩溃、取消、热替换回滚和本机执行授权。
- Workbench v1：Blueprint/实例/设备状态分离、两个实例绑定不同主对话、角色槽位幂等挂载、布局提案接受/拒绝/陈旧 revision 和重启恢复。
- 论文精读：PDF/SI 修订哈希、文本层/扫描件识别、块/图表/公式锚点、术语冻结、模型翻译记录、来源问答、取消恢复、局部重跑与可复现导出。
- 生成应用/市场/工具链：非法蓝图、构建失败、CSP/网络拒绝、消息上限、Ed25519/哈希/撤回/离线缓存、模拟适配器发现/授权/隔离/取消/日志/回收。
- Runtime：完整离线 turn、模型输入先记录、localhost auth/origin、2 MB 请求限制、附件哈希、会话 fork/archive 和重启恢复。
- Electron E2E：真实窗口验证确认前零 Agent、创建唯一首名 Agent、角色编辑、再创建三名持久 Agent、会话成员绑定、记忆/经验、工具能力快照、并行委派、私聊频道、插件安装、会话 fork/archive、重启恢复和截图。

## 发布检查

1. `pnpm typecheck`、`pnpm test`、`pnpm build` 与 `node scripts/verify-plugin-index.mjs` 全通过；
2. `pnpm test:e2e:built` 在临时用户数据目录通过并人工查看截图；
3. 生成 NSIS 后运行 `pnpm test:e2e:packaged`，确认打包后的 Runtime、TypeScript 插件工具链和持久化都可用；
4. 在具备专用测试 Key 时运行 `pnpm test:deepseek`；常规 CI 不读取真实密钥；
5. 执行数据库备份/恢复演练并检查诊断导出不存在凭据；
6. 运行 `git diff --check`，确认工作台重置和插件测试没有改变任何外部项目文件；
7. 对安装包计算 SHA-256，在正式外部分发环境完成 Authenticode 签名、安全审计和干净 Windows x64 安装测试。

当前实现证据与尚需外部凭据/证书完成的发布条件见 [完成度审计](COMPLETION_AUDIT.md)。
