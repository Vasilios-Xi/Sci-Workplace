# Paper Presentation 插件设计决策

## 产品结论

论文转学术汇报应作为 `openlab.paper-presentation` Candidate 发布，而不是做成聊天提示词或把任意 HTML 直接导出为 PPT。插件的核心对象是“可反查的逐页论证”，PPTX 只是其中一个交付格式。

## 逆向分析对应决策

`clawsgo-science-capability-summary.md` 显示，参考实现能完成 15 分钟/12 页、原图裁切和无明显溢出，但存在来源页脚过小、过度使用整页文字裁图、panel 可读性和“看起来完成”即被当作“已验证”的问题。因此本插件将对应能力收紧为可检验合同：15 分钟目标 12 页，每页最多一张 Reader 原图，来源页脚不小于 10 pt，文字有静态版式预算，任何未完成的像素或 Office 回读均显式降级为 `needs_review`。

## 输入与输出

输入是带 SHA-256 的 `DocumentRevisionRef`、汇报语言、受众、时长、显式文本模型，以及可选视觉模型。第一版只接受具有文本层的单篇 PDF；加密 PDF 和扫描件 fail closed。

若项目中存在同一 `paperId`、同一 PDF SHA-256、状态为 `complete` 且 `anchorsValid/numbersValid` 均通过的 Fine Reading V2 Artifact，插件读取其 `presentationBrief` 作为上游叙事建议。它不会把精读报告当作新的科学来源：模型仍只能输出本次 Reader 解析得到的原始 block/figure 来源 ID。上游 Artifact Revision ID 进入 operation key 和最终 provenance，因此精读报告更新不会静默复用旧 deck。

每次成功运行交付：

- `presentation.pptx`：可编辑文字与原图；
- `slides/slide-*.svg`：与构建坐标同源的逐页预览；
- `slide_manifest.json`：逐页唯一主张、断言类型、时间、来源和视觉状态；
- `figure_usage.json`：每张原图的来源页、bbox、Reader 裁切哈希、使用页和视觉状态；
- `deck_spec.json`：模型叙事和确定性版式之间的中间契约；
- `speaker_notes.md`：逐页讲稿和固定来源锚点；
- `source_map.json`：slide → claim/source/figure 的映射；
- `presentation_quality.json`：规划、像素输入、构建和 Office 回读四类门禁；
- `manifest.json` 与 `provenance.json`：输入修订、模型 generation、Reader 指纹、Job 与文件哈希。

## 可信边界

```text
固定 PDF 修订
  → Host Reader Runtime（文本块、页码、bbox、原图裁切、哈希）
  → 模型（受 schema 约束的主论点、来源 ID、图选择、讲稿）
  → 确定性校验（锚点存在、数字反查、页数、综合来源数）
  → 可选真实像素审计（Host 明确知道图片是否进入模型）
  → 本地固定版式构建器（PPTX + SVG + source map）
  → Host Artifact Revision（Job、模型、输入输出哈希）
```

模型不能直接产生坐标、主题、代码、哈希、页码或“已核验”状态。`visualInputRead` 由插件是否实际向模型提交图片引用派生，不采信模型自述。`officeRenderVerified` 只能来自将 PPTX 交给受 Host 管理的 Office/LibreOffice 渲染工具链后的 Receipt。

叙事规划、修复和视觉审计都调用 Host `models.runStructured`：每次调用必须携带 source references 与 `snippet` 送模范围。论文阶段只披露被选中的 Reader 文本块/图注，视觉阶段只披露一张 Host 哈希绑定的 Reader PNG 及其图注；调用回执保存这些范围，不需要插件接触模型密钥。

operation key 同时绑定 PDF SHA-256、汇报参数、文本/视觉模型、插件与 prompt 版本、Reader Runtime 版本与 SHA-256，以及可选 Fine Reading Artifact Revision。已完成的构建 Job 只有在本次暂存 `deck_plan.json` 的 SHA-256 完全相同时才能复用。

## 质量门禁

正式 `complete` 同时要求：

1. 所有非标题页存在固定修订来源；
2. 可见数字和单位可以在本页来源文本中反查；
3. 读者综合至少引用两个来源；
4. 所有使用原图都真实进入视觉模型，且被判定可整图使用、可读且不包含过多正文；
5. 构建器证明对象边界、最小字号、引用页脚、预览和 PPTX 文件齐全；
6. PPTX 内每页图片 relationship 指向的媒体字节与对应 Reader PNG SHA-256 完全一致；
7. PowerPoint/LibreOffice 实际渲染回读通过溢出、空白页、字体替换与 panel 可读性检查。

插件已实现前六项门禁；当前本体尚无第七项的通用 Office 渲染工具链，因此 Candidate 输出诚实停在 `needs_review`。本机 PowerPoint 冒烟测试只是开发验证，不写入跨机器的 Artifact 质量回执。

PPTX 构建依赖 `pptxgenjs@4.0.1`。其当前 `image-size` 间接依赖对 ICNS/JXL/HEIF 存在拒绝服务公告；本插件只暂存 Host 哈希绑定的 Reader PNG，并在进入库前校验 PNG 签名、IHDR、50 MB 文件上限、20,000 像素单边上限和总像素上限，因此相应格式解析路径不可达。该缓解需要保留为安全回归测试，上游修复发布后再解除例外。

## 后续本体增量

正式 bundled 之前只需要增加一个通用而非插件私有的 `presentation-renderer` Toolchain：输入固定 PPTX，输出逐页 PNG/PDF、字体替换清单、页面尺寸、渲染器版本和文件哈希。插件随后将真实渲染图送入 Visual QA，并把 Receipt 合并进现有 Artifact Revision；不需要修改 Agent loop、权限系统或 Renderer 主应用。
