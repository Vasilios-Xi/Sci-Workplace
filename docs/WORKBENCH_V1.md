# Workbench v1 设计与实现

## 状态模型

一个 `Project` 包含多个 `WorkbenchInstanceV1`。实例保存 Blueprint 身份/版本、主对话、输入、布局树、窗格、角色槽位、业务 revision 和运行状态。一个实例可对应多条 `RunRecordV1`；Run 不等同于对话，也不会覆盖实例状态。

`WorkbenchDeviceStateV1` 按 instance × device 保存抽屉/对话宽度、折叠状态、窗格比例、活动标签和焦点。这些字段不写入共享业务事件，不进入 provenance，也不触发布局 revision。

所有共享事件带稳定 event/stream ID、actor、deviceId、revision、idempotencyKey 与时间戳。v1 只启用本地 owner，但协议预留 owner/editor/reviewer/viewer。

## 壳层

- 左：项目与工作台实例抽屉，可搜索、归档和恢复。
- 中：递归 split/pane 布局树，标签可挂载 Artifact、文档、生成应用或插件面板。
- 右：实例绑定的主 Agent 对话。默认只显示方形展开箭头；宽屏打开后占据网格列，窄屏成为右侧覆盖层。
- 控制室：纯事件/任务/审批/失败聚合，不调用模型。

结构性布局改动必须创建 `LayoutProposalV1`，展示当前/提案差异并确认。拖动比例和切换标签只是设备状态。自动产物挂载只能使用 Blueprint 中 `autoMount=true` 的角色槽位，并以幂等键去重。

## 论文精读 Blueprint

`sci.paper-reader:deep-read` 对应一篇主论文及可选 SI。默认布局为 source 58% / analysis 42%。原始 PDF 只读并按 SHA-256 固定修订；解析输出保存页、标题层级、段落块、坐标、图表、公式与参考文献。

来源面板支持 PDF 原版、逐段双语、主文/SI、选段翻译和自动跟随。精读面板包含章节跟读与研究问题、方法、主张—证据、结果、图表/公式、复现、贡献、局限和未证明事项。结论点击后通过 EvidenceAnchor 定位来源；来源选择反向筛选解读。证据抽屉显示原句、页/坐标、文档修订、置信度、生成版本和批注。

任务状态包含 ready/inspecting/parsing/analyzing/completed/interrupted/failed/unsupported_scanned，支持调用量预览、取消、检查点恢复、失败重试和局部重跑。扫描件文本层不足时明确进入 `unsupported_scanned`，不会隐式 OCR。

## 生成应用

状态机：`draft → awaiting_confirmation → building → preview → accepted`，拒绝和构建错误分别进入 `rejected/failed`。蓝图先声明布局、Host 能力与网络域名；确认后才生成不可变静态资源、执行构建检查并签发沙箱预览票据。接受会创建/挂载新 Workbench 实例，旧修订仍可回滚。
