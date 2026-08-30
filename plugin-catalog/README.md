# Sci Workplace 策展插件目录

社区插件通过 Pull Request 修改 `index.source.json`。每个条目必须指向不可变的 HTTPS ZIP，声明 SHA-256、Plugin API v4 权限和发布时间。CI 下载包并检查哈希、v4 清单、权限一致性、路径穿越、符号链接、压缩规模、嵌入式可执行文件、包管理器控制文件和 lifecycle scripts。

平台发布任务使用受保护的 Ed25519 私钥签署规范化索引，私钥和签名中间文件不进入仓库。应用只接受内置可信公钥对应的签名、递增的 sequence 和未被撤回的包；离线时使用上次验证通过的缓存。
