# 安全模型

## 信任边界

高信任：Electron Main、Sci Workplace Runtime、微内核、事件库、权限服务。

低信任：Renderer 内容、项目文件、网页资料、MCP 数据、Skills 指令生成的操作、第三方插件、模型输出和终端命令。

## 已实施控制

- Electron：`contextIsolation: true`、renderer sandbox、`nodeIntegration: false`、严格 CSP、拒绝权限请求、拒绝任意导航和弹窗。
- 本地协议：仅 `127.0.0.1`、随机端口、256-bit 临时 Bearer token、无缓存响应。
- 凭据：DeepSeek Key 与 MCP secret 使用独立的 `safeStorage`/Windows DPAPI 存储；项目 `mcp.json` 只保存随机 credential ID，事件、项目文件和诊断日志不保存 secret。
- 路径：读取基于 realpath；写入验证最近存在父目录、拒绝工作区逃逸和符号链接目标。
- 写入/删除：执行前 unified diff；执行后文件哈希、快照与变更集；撤销时检测后续修改，删除撤销也拒绝覆盖已重新创建的文件。
- 工具：定义和参数都经校验，风险分类、统一审批、超时、输出上限和取消信号贯穿执行链；只读模式在模型能力层移除写入工具。
- Agent：深度 1、并发 3、子权限不超过父权限、上下文显式隔离。
- 插件来源：目录/ZIP 在复制前检查 traversal、Windows 保留名、符号链接/junction、文件数量、单文件与解压总量；源目录不得携带 `node_modules`。导出包不包含已安装依赖。
- 插件供应链：只接受 npm registry 形式的依赖说明，拒绝 `file:`/`link:`/`workspace:`/Git/HTTP 等本地或直连来源；候选的 `.npmrc`、workspace 与 pnpm hook 配置被移除，依赖在独立临时工作区以 `--ignore-scripts` 安装并复制为无符号链接目录。
- 插件执行：Manifest/工具 schema 校验、最终树 SHA-256、独立进程、Node 权限模型、RPC 超时与单行 2 MB 上限、命名空间工具、取消即终止进程、所有调用审批；先加入 Windows Job Object 再允许加载插件入口。UI 面板使用无同源权限的 CSP iframe 和一次性 MessagePort；上下文、声明工具与证据跳转均在 Runtime 再验证，写工具逐次确认。
- 插件信任：项目锁文件不是执行授权；自动启动还要求本机用户数据目录中的项目—插件哈希锁一致。显式启用会重验 manifest 和哈希，热替换失败保留旧进程。
- Prompt injection：外部内容和所有工具返回值以不可信边界包装，明确禁止把资料中的指令、角色声明、审批暗示和工具请求提升为高优先级指令。
- 数据：SQLite WAL、schema migration、checkpoint/VACUUM 一致性备份、诊断递归脱敏。

## 资源上限

- 本地 API 正文 2 MB；单条聊天文本 200,000 字符；单附件 100 MB、单轮总附件 250 MB，附件使用路径引用和 SHA-256 校验而不是上传正文。
- 通用文本读取 20 MB；对话写入/删除 5 MB；搜索单文件 5 MB、单次扫描 100 MB，并跳过二进制文件。
- DeepSeek 模型列表正文 2 MB、10 秒；单个 SSE 帧/缓冲 4 MB；首字节 30 秒、流空闲 60 秒。
- MCP 模型可见输出 2,000,000 字符，resources 列表最多 5,000 项。
- Skill：2,000 文件、单文件 5 MB、总量 50 MB；插件：20,000 文件、单文件 128 MB、总量 512 MB；压缩包在解压前验证元数据。
- 插件依赖最多 128 个，构建输出 128 KB；运行时 JSON-RPC 单行 2 MB。

## 应用层防护说明

Node 权限模型不能完整限制网络；PowerShell/任意本地程序也可能调用系统级能力。因此：

- 所有终端命令逐次审批，即使会话为受信任模式；
- 网络、删除、插件和 MCP 调用始终逐次审批；
- 终端环境变量收缩，不传递 DeepSeek Key；
- 进程设置 wall-clock timeout、输出上限和取消；
- Windows 终端和插件进程由 Job Object 宿主管理，限制累计 CPU 时间、总内存和活动进程数，并启用 `KILL_ON_JOB_CLOSE`；
- 界面明确标注“应用层防护”，不宣称强沙箱。

Job Object 不能限制所有网络与系统调用，也不能替代 OS 级容器。当前 NSIS 可执行文件在没有发布证书时不会带 Authenticode 签名；正式外部分发前必须在受控 CI 中完成签名和安装包信誉验证。不应把第三方插件或终端当作处理恶意代码的安全沙箱。

## 不在首版范围

OAuth、远程市场、远程访问、账号/多租户、浏览器自动化、公开更新、遥测和云端密钥托管。
