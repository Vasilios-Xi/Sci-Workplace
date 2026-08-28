# Plugin API v4 模板

复制此目录后先修改 `manifest.json` 的 `id/name/version`，并让 contribution ID 使用同一插件命名空间。模板不含运行时依赖；`types/openlab-plugin.d.ts` 仅用于本地 TypeScript 检查。

```powershell
pnpm exec tsc -p tsconfig.json
node --experimental-transform-types contract.test.mjs
```

正式导入前，在 Sci Workplace 中运行插件测试。未签名副本只能在开发者模式下安装；公共目录提交必须走策展 PR、包审计和平台签名。
