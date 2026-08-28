# 策展插件市场

v1 不建设发布者账号、自助上传后台或付费系统。社区通过 GitHub PR 修改 [`plugin-catalog/index.source.json`](../plugin-catalog/index.source.json)，条目指向不可变 HTTPS ZIP。

CI 会下载每个包并验证：目录元数据、SHA-256、Manifest/API v4、ID/版本/权限一致、路径穿越、Windows 保留名、符号链接、文件/解压规模、`node_modules`、包管理器控制文件、lifecycle scripts 和嵌入式可执行文件。平台受保护任务用 Ed25519 私钥签署规范化索引；私钥不进入仓库或日志。

应用导入签名索引时校验 keyId、Ed25519、结构、时间和递增 sequence，再原子写入可信离线缓存。安装时重新校验 ZIP 哈希、manifest 与撤回状态。被撤回版本从目录隐藏、停止启动并记录原因；更新失败保留旧版本与旧可信缓存。

控制室的“策展插件目录”可导入离线签名索引，并为条目选择已下载的 ZIP。未签名目录/ZIP 使用另一条开发路径，要求显式开发者模式并显示持续警示；它们不会被视为市场包。
