# Toolchain Adapter v1

`ToolchainAdapterManifestV1` 描述适配器 ID/版本/类型、可执行程序候选、版本探测与操作的输入/输出 Schema。插件只能申请 `toolchains:execute` 并调用宿主代理，不能直接启动 Origin、Cinema 4D 或任意本地程序。

每个 `ToolRunV1` 记录 adapter/operation、Job、状态、请求者、创建/更新时间、暂存目录身份、日志游标和回收的 Artifact 修订。执行流程：

1. 宿主发现候选程序并校验版本。
2. UI 展示程序、输入、输出和权限，用户确认。
3. 宿主创建项目外隔离暂存目录，物化已授权输入并收缩环境变量。
4. 适配器启动后持续写受限日志，响应取消和超时。
5. 宿主只回收声明输出，计算 SHA-256，创建不可变 Artifact 修订并可用 `MountIntentV1` 挂载。
6. 成功、失败、取消与清理结果进入事件日志。

内置 `sci.mock-toolchain` 不依赖第三方软件，用 JSON 输入/输出验证发现、授权、隔离、取消、日志和产物回收。真实 Origin/C4D 适配器不在 v1 范围。
