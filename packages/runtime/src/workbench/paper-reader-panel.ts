const PANEL_SCRIPT = String.raw`
(() => {
  const state = {
    port: null, token: '', pending: new Map(), context: null, mode: 'deep', documentId: '',
    section: 'report', selected: new Set(), evidence: null, busy: false,
  };
  const panel = document.body.dataset.panel;
  const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
  const chemicalElements = new Set('H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn Ga Ge As Se Br Kr Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te I Xe Cs Ba La Ce Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb Lu Hf Ta W Re Os Ir Pt Au Hg Tl Pb Bi Po At Rn Fr Ra Ac Th Pa U Np Pu Am Cm Bk Cf Es Fm Md No Lr Rf Db Sg Bh Hs Mt Ds Rg Cn Nh Fl Mc Lv Ts Og'.split(' '));
  const chemicalToken = (token) => {
    let core = token; let charge = '';
    const explicitCharge = core.match(/\^(\d*[+−-])$/u);
    if (explicitCharge) {
      charge = explicitCharge[1]; core = core.slice(0, -explicitCharge[0].length);
    } else {
      const sign = core.match(/([+−-])$/u)?.[1] || '';
      if (sign) {
        charge = sign; core = core.slice(0, -1);
        const magnitude = core.match(/(\d+)$/u)?.[1] || '';
        if (magnitude) {
          const beforeMagnitude = core.slice(0, -magnitude.length);
          const isSingleElementIon = /^[A-Z][a-z]?$/u.test(beforeMagnitude);
          const isDiatomicIon = /^(?:H|N|O|F|Cl|Br|I)$/u.test(beforeMagnitude) && magnitude === '2';
          const isBracketedComplex = /[)\]]$/u.test(beforeMagnitude);
          if ((isSingleElementIon && !isDiatomicIon) || isBracketedComplex) {
            charge = magnitude + sign; core = beforeMagnitude;
          }
        }
      }
    }
    const symbols = [...core.matchAll(/[A-Z][a-z]?/gu)].map((match) => match[0]);
    if (!symbols.length || symbols.some((symbol) => !chemicalElements.has(symbol))) return null;
    const residue = core.replace(/[A-Z][a-z]?/gu, '').replace(/\d+(?:\.\d+)?/gu, '').replace(/[()[\].·+−-]/gu, '');
    const hasCount = /\d/u.test(core);
    const commonDiatomic = /^(?:H2|N2|O2|F2|Cl2|Br2|I2)$/u.test(core);
    if (residue || (!charge && !hasCount) || (symbols.length < 2 && !commonDiatomic && !charge)) return null;
    let html = ''; let cursor = 0;
    for (const match of core.matchAll(/([A-Z][a-z]?|\)|\])(\d+(?:\.\d+)?)/gu)) {
      html += escape(core.slice(cursor, match.index)) + escape(match[1]) + '<sub>' + escape(match[2]) + '</sub>';
      cursor = match.index + match[0].length;
    }
    html += escape(core.slice(cursor));
    if (charge) html += '<sup>' + escape(charge.replace('-', '−')) + '</sup>';
    return html;
  };
  const scientific = (value) => {
    const source = String(value ?? ''); let html = ''; let cursor = 0;
    for (const match of source.matchAll(/(?:[([{][A-Z]|[A-Z])[A-Za-z0-9()[\]{}.·^+−-]{1,47}/gu)) {
      const rendered = chemicalToken(match[0]);
      if (!rendered) continue;
      html += escape(source.slice(cursor, match.index)) + '<span class="chemical-formula">' + rendered + '</span>';
      cursor = match.index + match[0].length;
    }
    return html + escape(source.slice(cursor));
  };
  const number = (value) => new Intl.NumberFormat('zh-CN').format(Number(value) || 0);
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    if (!state.port) return reject(new Error('宿主桥尚未连接'));
    const id = crypto.randomUUID();
    state.pending.set(id, { resolve, reject });
    state.port.postMessage({ id, token: state.token, method, params });
  });
  const statusLabel = (value) => ({
    unconfigured:'未配置', ready:'待一次确认', inspecting:'离线预检', parsing:'解析版面', analyzing:'全文自动处理中',
    completed:'已完成', stale:'结果已陈旧', unsupported_scanned:'不支持扫描件', interrupted:'已中断', failed:'失败',
  }[value] || value);
  const stageLabel = (value) => ({
    'document-profile':'文档画像', terminology:'全文术语', 'bilingual-translation':'块级双语', 'section-digest':'逐章节精读',
    'figure-analysis':'逐图 / 逐表视觉核验', 'formula-analysis':'公式语义', 'claim-evidence':'主张—证据—限定',
    reproduction:'复现条件', synthesis:'全局综合', 'quality-gate':'确定性质量门', publish:'原子产物',
  }[value] || value);
  const typeLabel = (value) => ({
    'source-fact':'来源事实', 'author-interpretation':'作者解释', 'reader-inference':'读者推断', hypothesis:'研究假设',
  }[value] || value);
  const resultLabel = (value) => ({
    verified:'已核验', needs_review:'待复核', failed:'失败', complete:'完整', incomplete:'不完整',
    pending:'等待', running:'处理中', completed:'完成', skipped:'已跳过', invalidated:'需重跑', canceled:'已取消',
    consistent:'与文本层一致', text_layer_incomplete:'文本层不完整', conflict:'与文本层冲突',
  }[value] || value);
  const hiddenSourceTypes = new Set(['running_matter','reference','front_matter','figure_text','formula']);
  const presentationType = (block) => {
    const label = String(block?._doclingLabel || '');
    if (block?.type === 'caption' && label && label !== 'caption') {
      if (['title','section_header'].includes(label)) return 'heading';
      if (['text','paragraph','list_item'].includes(label)) return 'paragraph';
      if (label === 'footnote' || label === 'note') return 'note';
    }
    return String(block?.type || 'paragraph');
  };
  const looksLikePageChrome = (block) => /^Nature(?:Communications|Sustainability)\|.*\d$/iu.test(String(block?.originalText || '').replace(/\s+/gu, ''));
  const visibleSourceBlocks = (parsed) => (parsed?.blocks || []).filter((block) => !hiddenSourceTypes.has(presentationType(block)) && !looksLikePageChrome(block));
  const running = () => ['inspecting','parsing','analyzing'].includes(state.context?.reader?.status);
  const documents = () => state.context?.documents || [];
  const current = () => documents().find((item) => item.document?.id === state.documentId) || documents()[0] || null;
  const composite = (blockId, documentId = current()?.document?.id) => documentId ? documentId + ':' + blockId : blockId;
  const rawId = (id) => String(id || '').includes(':') ? String(id).slice(String(id).indexOf(':') + 1) : String(id || '');
  const blockForComposite = (id) => {
    const value = String(id || '');
    const document = documents().find((item) => value.startsWith(item.document.id + ':')) || current();
    return { document, block: document?.parsed?.blocks?.find((candidate) => candidate.id === rawId(value)) };
  };
  const selectorFor = (parsed, block) => {
    const bbox = block?.bbox;
    if (!Array.isArray(bbox) || bbox.length !== 4 || !bbox.every(Number.isFinite)) return null;
    const page = parsed?.pages?.find((candidate) => candidate.page === block.page);
    const normalized = bbox.every((value) => value >= 0 && value <= 1) ? bbox
      : page?.width > 0 && page?.height > 0 ? [bbox[0] / page.width, bbox[1] / page.height, bbox[2] / page.width, bbox[3] / page.height] : null;
    if (!normalized) return null;
    const x = Math.max(0, Math.min(1, normalized[0])); const y = Math.max(0, Math.min(1, normalized[1]));
    const right = Math.max(x, Math.min(1, normalized[2])); const bottom = Math.max(y, Math.min(1, normalized[3]));
    return right > x && bottom > y ? { kind: 'pdf-text', page: block.page, rects: [{ x, y, width: right - x, height: bottom - y }], exact: block.originalText } : null;
  };
  const requestContext = async () => {
    state.context = await call('context.read');
    if (!state.documentId || !documents().some((item) => item.document.id === state.documentId)) state.documentId = documents()[0]?.document?.id || '';
    render();
  };
  const tool = async (name, params = {}) => {
    if (state.busy) return;
    state.busy = true; render();
    try { await call('tool.execute', { tool: name, params }); await requestContext(); }
    catch (error) { renderError(error); }
    finally { state.busy = false; render(); }
  };
  const reveal = async (blockId, documentId) => {
    const pair = blockForComposite(documentId ? composite(rawId(blockId), documentId) : blockId);
    const document = pair.document?.document; const parsed = pair.document?.parsed; const block = pair.block;
    if (!document || !parsed || !block) return;
    state.documentId = document.id;
    state.evidence = { block, document };
    renderEvidence();
    const anchor = state.context?.anchors?.find((candidate) => candidate.documentId === document.id && candidate.blockId === block.id);
    const selector = ['pdf-text','pdf-rect'].includes(anchor?.selector?.kind) ? anchor.selector : selectorFor(parsed, block);
    await call('evidence.reveal', {
      document: document.revision,
      selector: selector || { kind: 'document-anchor', scheme: 'sci.paper-reader.block.v2', anchor: block.id, exact: block.originalText },
    });
  };
  const openPdf = async () => {
    const document = current()?.document?.revision;
    if (document) await call('resource.open', { document });
  };
  const documentTabs = () => '<div class="document-tabs">' + documents().map((item) =>
    '<button data-document="' + escape(item.document.id) + '" class="' + (item.document.id === state.documentId ? 'active' : '') + '">' +
    escape(item.document.role === 'main' ? '主文' : item.document.label) + '</button>'
  ).join('') + '</div>';
  const profileHeader = () => {
    const profile = (state.context?.analysis?.documentProfiles || []).find((item) => item.documentId === current()?.document?.id)
      || (state.context?.analysis?.documentProfiles || []).find((item) => current()?.document?.role === 'main' && item.status !== 'failed');
    if (!profile) return '';
    const authors = (profile.authors || []).slice(0, 12);
    const more = Math.max(0, (profile.authors || []).length - authors.length);
    return '<section class="paper-profile"><div><span class="quality quality-' + escape(profile.status) + '">' + (profile.status === 'verified' ? '整页视觉核验' : '信息待复核') + '</span><h1>' + scientific(profile.title) + '</h1>' +
      (authors.length ? '<p class="profile-authors">' + authors.map(scientific).join('，') + (more ? ' 等 ' + number(more) + ' 位作者' : '') + '</p>' : '') +
      '<p class="profile-meta">' + [profile.journal, profile.articleType, profile.publicationDate, profile.doi ? 'DOI ' + profile.doi : ''].filter(Boolean).map(scientific).join(' · ') + '</p></div></section>';
  };
  const renderStatus = () => {
    const value = state.context;
    if (!value) return '<div class="loading">正在读取精读上下文…</div>';
    const reader = value.reader; const preview = value.callPreview || {}; const auth = reader.batchAuthorization;
    const action = reader.status === 'ready' || reader.status === 'stale'
      ? (preview.ready ? '<button class="primary" data-action="start">确认一次并自动处理全文</button>' : '<button class="primary" data-action="prepare">完成离线预检</button>')
      : ['interrupted','failed'].includes(reader.status)
        ? (preview.ready ? '<button class="primary" data-action="resume">从检查点自动恢复</button>' : '<button class="primary" data-action="prepare">重新离线预检</button>')
        : reader.status === 'unsupported_scanned' ? '' : running() ? '<button class="danger" data-action="cancel">安全停止</button>' : '';
    const consumed = auth?.consumed || {};
    return '<section class="status-card status-' + escape(reader.status) + '"><div class="status-title"><i></i><strong>' + escape(statusLabel(reader.status)) + '</strong><small>' + escape(reader.stage) + '</small></div>' +
      '<div class="progress"><i style="width:' + Math.round((reader.progress || 0) * 100) + '%"></i></div><b>' + Math.round((reader.progress || 0) * 100) + '%</b>' + action +
      '<div class="usage"><span>阶段 ' + escape(stageLabel(reader.pipeline?.stage)) + '</span><span>单元 ' + number(reader.pipeline?.completedUnits) + ' / ' + number(reader.pipeline?.totalUnits) + '</span><span>调用 ' + number(consumed.modelCalls) + (auth ? ' / ' + number(auth.maximum?.modelCalls) : '') + '</span><span>token ' + number(consumed.totalTokens) + (auth ? ' / ' + number(auth.maximum?.totalTokens) : '') + '</span></div>' +
      (reader.error ? '<p class="error-text">' + escape(reader.error) + '</p>' : '') + (!value.toolchainAvailable ? '<p class="error-text">离线 Reader Runtime 尚未安装。</p>' : '') + '</section>';
  };
  const statementCard = (item, compact = false) => {
    const first = item.evidenceAnchorIds?.[0];
    const anchor = state.context?.anchors?.find((candidate) => candidate.id === first);
    const block = anchor?.documentId && anchor?.blockId ? composite(anchor.blockId, anchor.documentId) : item.blockIds?.[0];
    const quantities = item.quantities?.length ? '<div class="quantities">' + item.quantities.map((quantity) => '<span>' + scientific([quantity.comparator, quantity.value, quantity.unit, quantity.condition].filter(Boolean).join(' ')) + '</span>').join('') + '</div>' : '';
    return '<article class="statement ' + (compact ? 'compact' : '') + '"><header><span>' + escape(typeLabel(item.type)) + '</span><em>' + escape(item.confidence) + '</em></header><p>' + scientific(item.text) + '</p>' + quantities +
      '<footer><button data-reveal="' + escape(block || '') + '" ' + (block ? '' : 'disabled') + '>定位证据</button><small>' + number(item.evidenceAnchorIds?.length) + ' 锚点</small></footer></article>';
  };
  const relatedDigest = (blockId) => (state.context?.analysis?.sectionDigests || []).find((item) => item.blockIds?.includes(blockId));
  const blockCards = () => {
    const doc = current(); const parsed = doc?.parsed; const analysis = state.context?.analysis;
    if (!parsed?.blocks?.length) return '<div class="empty">离线解析完成后，这里会出现可回溯的全文来源块。</div>';
    return visibleSourceBlocks(parsed).map((block) => {
      const id = composite(block.id, doc.document.id); const translation = analysis?.translations?.[id]; const selected = state.selected.has(id);
      const digest = state.mode === 'deep' ? relatedDigest(id) : null;
      const reading = digest ? '<aside class="reading-card"><header><b>' + scientific(digest.heading) + '</b><span>' + scientific(digest.argumentativeFunction) + '</span></header>' + (digest.summary || []).slice(0, 6).map((item) => statementCard(item, true)).join('') + '</aside>' : '';
      return '<article id="block-' + escape(id.replace(/[^a-zA-Z0-9_-]/g, '-')) + '" class="source-block ' + (selected ? 'selected' : '') + '" data-block="' + escape(block.id) + '"><label class="block-select"><input type="checkbox" data-select="' + escape(id) + '" ' + (selected ? 'checked' : '') + '><span>选择本段</span></label><div class="source-grid ' + (state.mode === 'bilingual' ? 'bilingual' : '') + '"><p>' + scientific(block.originalText) + '</p>' +
        (state.mode === 'bilingual' ? '<p class="translation">' + scientific(translation || '全文任务确认后自动生成本段译文。') + '</p>' : '') + '</div>' + reading + '</article>';
    }).join('');
  };
  const pipeline = () => {
    const units = state.context?.reader?.pipeline?.units || [];
    const stages = [...new Set(units.map((unit) => unit.stage))];
    return '<section class="pipeline"><h3>执行单元与检查点</h3>' + (stages.length ? stages.map((stage) => {
      const stageUnits = units.filter((unit) => unit.stage === stage); const complete = stageUnits.filter((unit) => ['completed','skipped'].includes(unit.status)).length;
      return '<details ' + (stage === state.context.reader.pipeline.stage ? 'open' : '') + '><summary><b>' + escape(stageLabel(stage)) + '</b><span>' + complete + '/' + stageUnits.length + '</span></summary>' + stageUnits.map((unit, index) => '<div class="unit unit-' + escape(unit.status) + '"><i></i><span>第 ' + number(index + 1) + ' 项</span><em>' + escape(resultLabel(unit.status)) + '</em><small>' + number(unit.usage?.totalTokens) + ' token</small>' + (unit.error ? '<p>' + escape(unit.error) + '</p>' : '') + '</div>').join('') + '</details>';
    }).join('') : '<div class="empty compact">预检后建立执行单元。</div>') + '</section>';
  };
  const sourceView = () => {
    const doc = current();
    const parsed = doc?.parsed; const hiddenCount = Math.max(0, (parsed?.blocks?.length || 0) - visibleSourceBlocks(parsed).length);
    const modes = '<div class="segmented"><button data-mode="deep" class="' + (state.mode === 'deep' ? 'active' : '') + '">深度精读</button><button data-mode="bilingual" class="' + (state.mode === 'bilingual' ? 'active' : '') + '">双语全文</button><button data-mode="pdf" class="' + (state.mode === 'pdf' ? 'active' : '') + '">PDF 原文</button></div>';
    const body = state.mode === 'pdf'
      ? '<main class="pdf-mode"><div><b>原始 PDF 保持不可变</b><p>点击下方按钮在原文窗格打开论文；证据定位信息由插件内部维护。</p><button class="primary" data-action="open-pdf">打开 PDF 原文</button></div></main>'
      : '<div class="block-actions"><span>已选 ' + state.selected.size + ' 个正文段落' + (hiddenCount ? ' · 已自动收纳非正文内容' : '') + '</span><button data-action="translate" ' + (state.selected.size ? '' : 'disabled') + '>重新翻译所选</button><button data-action="regenerate" ' + (state.selected.size ? '' : 'disabled') + '>局部精读重跑</button></div><main class="blocks">' + blockCards() + '</main>';
    return '<header class="toolbar">' + modes + '<label class="follow"><input type="checkbox" data-action="follow" ' + (state.context?.reader?.autoFollow ? 'checked' : '') + '>自动跟随</label></header>' + documentTabs() + profileHeader() + renderStatus() + body + '<aside id="evidence-drawer" class="evidence-drawer"></aside>';
  };
  const reportSection = () => {
    const report = state.context?.analysis?.report; const analysis = state.context?.analysis;
    const groups = report ? [
      ['论文论点', report.thesis], ['研究问题', report.researchQuestion], ['研究策略', report.strategy], ['主张—证据—限定', report.evidenceChain], ['机制', report.mechanism],
      ['关键结果', report.keyResults], ['贡献', report.contributions], ['局限', report.limitations], ['未证明事项', report.unproven], ['研究启示', report.researchImplications],
    ] : [];
    const html = groups.filter(([, items]) => items?.length).map(([title, items]) => '<section class="report-group"><h2>' + escape(title) + '</h2>' + items.map((item) => statementCard(item)).join('') + '</section>').join('');
    const legacy = !report && analysis?.legacyConclusions?.length ? '<section class="legacy"><b>V1 旧版报告（只读）</b><p>旧产物不会自动触发模型调用或被 V2 覆盖。</p>' + analysis.legacyConclusions.map((item) => '<article><h3>' + escape(item.title) + '</h3><p>' + escape(item.content) + '</p></article>').join('') + '</section>' : '';
    return html || legacy || '<div class="empty">完成分阶段流水线后生成全局综合报告。</div>';
  };
  const sectionSection = () => {
    const active = state.context?.reader?.activeBlockId;
    const values = (state.context?.analysis?.sectionDigests || []).filter((item) => !active || item.blockIds?.includes(active));
    return values.length ? values.map((item) => '<section class="digest"><header><div><h2>' + scientific(item.heading) + '</h2></div><button data-rerun-module="section-digest" data-targets="' + escape(item.blockIds.join(',')) + '">重跑本节</button></header><p class="argument">' + scientific(item.argumentativeFunction) + '</p>' + (item.summary || []).map((statement) => statementCard(statement)).join('') + '</section>').join('') : '<div class="empty">尚无逐节精读结果。</div>';
  };
  const visualSection = () => {
    const analysis = state.context?.analysis; const figures = analysis?.figureAnalyses || []; const formulas = analysis?.formulaAnalyses || [];
    const parsedFigure = (item) => documents().flatMap((document) => document.parsed?.figures || []).find((figure) => figure.id === item.figureId);
    const visualName = (item, index) => {
      const figure = parsedFigure(item); const caption = String(figure?.originalCaption || figure?.altText || '');
      const match = caption.match(/^(?:(?:Supplementary|Extended\s+Data)\s+)?(?:Fig(?:ure)?\.?|Table)\s*([A-Za-z]?\d+[A-Za-z]?)/iu);
      return match ? (item.kind === 'table' ? '表 ' : '图 ') + match[1] : (item.kind === 'table' ? '数据表 ' : '科研图 ') + number(index + 1);
    };
    const figureHtml = figures.map((item, index) => '<article class="visual"><header><div><b>' + escape(visualName(item, index)) + '</b><span class="quality quality-' + escape(item.status) + '">' + escape(resultLabel(item.status)) + '</span></div><button data-rerun-figure="' + escape(item.figureId) + '">仅重跑此图</button></header><p>' + scientific(item.purpose) + '</p><dl><dt>分面观察</dt><dd>' + scientific(item.panelObservations.join('；') || '无') + '</dd><dt>坐标轴 / 变量</dt><dd>' + scientific(item.axesAndVariables.join('；') || '无') + '</dd><dt>对照</dt><dd>' + scientific(item.controls.join('；') || '无') + '</dd></dl>' + item.authorInterpretation.map((value) => statementCard(value, true)).join('') + item.independentJudgment.map((value) => statementCard(value, true)).join('') + (item.error ? '<p class="error-text">' + escape(item.error) + '</p>' : '') + '</article>').join('');
    const formulaHtml = formulas.map((item, index) => '<article class="formula"><header><b>公式 ' + number(index + 1) + '</b><span class="quality quality-' + escape(item.status || 'needs_review') + '">' + escape(resultLabel(item.status || 'needs_review')) + '</span></header><code class="formula-expression">' + scientific(item.expression) + '</code><p>' + scientific(item.purpose) + '</p><dl><dt>视觉核验</dt><dd>' + escape(resultLabel(item.sourceTextAgreement || '旧版结果待复核')) + '</dd><dt>歧义字符</dt><dd>' + scientific((item.ambiguousSymbols || []).join('；') || '无') + '</dd><dt>变量</dt><dd>' + scientific(item.variables.map((value) => value.symbol + ' = ' + value.meaning).join('；')) + '</dd><dt>假设</dt><dd>' + scientific(item.assumptions.join('；')) + '</dd><dt>适用范围</dt><dd>' + scientific(item.applicability.join('；')) + '</dd></dl>' + (item.error ? '<p class="error-text">' + escape(item.error) + '</p>' : '') + '</article>').join('');
    return '<section class="visual-grid"><div><h2>逐图 / 逐表视觉核验</h2>' + (figureHtml || '<div class="empty compact">尚无视觉结果。</div>') + '</div><div><h2>公式语义分析</h2>' + (formulaHtml || '<div class="empty compact">尚无公式结果。</div>') + '</div></section>';
  };
  const reproductionSection = () => {
    const value = state.context?.analysis?.report?.reproduction || state.context?.analysis?.reproduction;
    if (!value) return '<div class="empty">尚无复现清单。</div>';
    return '<section class="reproduction">' + Object.entries(value).filter(([, items]) => Array.isArray(items)).map(([key, items]) => '<div><h2>' + escape(key) + '</h2>' + (items.length ? items.map((item) => statementCard(item)).join('') : '<p class="missing">原文未报告</p>') + '</div>').join('') + '</section>';
  };
  const qualitySection = () => {
    const reader = state.context?.reader; const report = state.context?.analysis?.report; const quality = reader?.quality || report?.quality; const coverage = report?.coverage;
    const checkNames = { schemaValid:'报告 Schema', anchorsValid:'证据锚点', quantitiesValid:'数字 / 单位', documentProfileComplete:'首页整页视觉核验', textCoverageComplete:'逐节正文覆盖', translationCoverageComplete:'全文翻译覆盖', visualCoverageComplete:'图表视觉核验', formulaCoverageComplete:'公式精确核验' };
    const checks = quality ? Object.entries(checkNames).map(([key, label]) => { const ok = quality[key] === true; return '<li class="' + (ok ? 'pass' : 'fail') + '"><i></i><span>' + escape(label) + '</span><b>' + (ok ? '通过' : '未通过') + '</b></li>'; }).join('') : '';
    const coverageNames = { documentProfileCount:'首页画像', verifiedDocumentProfileCount:'已核验首页', substantiveBlockCount:'正文段落', digestedBlockCount:'已精读段落', translatedBlockCount:'已翻译段落', mainVisualCount:'主文图表', verifiedMainVisualCount:'已核验主文图表', referencedSupplementaryVisualCount:'被引用补充图表', analyzedSupplementaryVisualCount:'已核验补充图表', formulaCount:'公式', analyzedFormulaCount:'已核验公式' };
    const coverageHtml = coverage ? Object.entries(coverage).map(([key, value]) => '<div><span>' + escape(coverageNames[key] || key) + '</span><b>' + number(value) + '</b></div>').join('') : '';
    return '<section class="quality-panel"><header><div><small>精读报告 V2</small><h2>质量状态：<span class="quality quality-' + escape(quality?.status || 'pending') + '">' + escape(resultLabel(quality?.status || 'pending')) + '</span></h2></div></header><div class="coverage">' + coverageHtml + '</div><ul>' + checks + '</ul>' + (quality?.issues?.length ? '<div class="issues">' + quality.issues.map((item) => '<p>' + escape(item) + '</p>').join('') + '</div>' : '') + pipeline() + '</section>';
  };
  const budgetCard = () => {
    const preview = state.context?.callPreview || {}; const auth = state.context?.reader?.batchAuthorization;
    return '<section class="budget"><h2>一次授权预算</h2><dl><dt>文本模型</dt><dd>' + escape(preview.textModel || '未配置') + '</dd><dt>视觉模型</dt><dd>' + escape(preview.visionModel || '未配置') + '</dd><dt>文本调用</dt><dd>' + number(preview.textModelCalls) + '</dd><dt>视觉调用</dt><dd>' + number(preview.visionModelCalls) + '</dd><dt>预计 token</dt><dd><b>' + number(preview.estimatedTotalTokens) + '</b></dd><dt>硬上限</dt><dd>' + number(preview.maximumTotalTokens) + '</dd></dl>' + (auth ? '<p>已用 ' + number(auth.consumed?.modelCalls) + ' 次 / ' + number(auth.consumed?.totalTokens) + ' token</p>' : '') + '<small>' + escape(preview.note || '') + '</small></section>';
  };
  const termsAndQuestions = () => {
    const analysis = state.context?.analysis; const terms = (analysis?.terms || []).slice(0, 80).map((term) => '<div class="term"><b>' + scientific(term.source) + '</b><input data-term="' + escape(term.source) + '" value="' + escape(term.translation) + '"><button data-freeze="' + escape(term.source) + '">' + (term.frozen ? '已冻结' : '冻结') + '</button></div>').join('') || '<div class="empty compact">尚无术语。</div>';
    const questions = (analysis?.questions || []).map((item) => '<article class="question"><b>Q：' + scientific(item.question) + '</b><p>' + scientific(item.answer) + '</p><footer><button data-reveal="' + escape(item.blockIds?.[0] || '') + '">定位来源</button><small>' + number(item.evidenceAnchorIds?.length) + ' 锚点</small></footer></article>').join('');
    return '<section><h2>全文术语冻结</h2>' + terms + '</section><section><h2>真实来源约束问答</h2><form id="qa"><textarea name="question" placeholder="只依据当前论文来源；来源不足时明确说明"></textarea><button class="primary">提问</button></form>' + questions + '</section>';
  };
  const analysisView = () => {
    const reader = state.context?.reader; const tabs = [['report','全局报告'],['sections','逐节精读'],['visuals','图表 / 公式'],['reproduction','复现'],['quality','质量 / 进度']];
    const main = state.section === 'sections' ? sectionSection() : state.section === 'visuals' ? visualSection() : state.section === 'reproduction' ? reproductionSection() : state.section === 'quality' ? qualitySection() : reportSection();
    return '<header class="toolbar"><div><strong>论文精读 V2</strong><small>' + number(reader?.blockCount) + ' 个正文段落 · ' + number(reader?.figureCount) + ' 个图表 · ' + number(reader?.evidenceAnchorIds?.length) + ' 条证据关联</small></div><button data-action="export" ' + (reader?.status === 'completed' && reader?.quality?.status !== 'failed' ? '' : 'disabled') + '>导出原子产物</button></header>' + profileHeader() + renderStatus() + '<nav class="analysis-tabs">' + tabs.map(([id,label]) => '<button data-section="' + id + '" class="' + (state.section === id ? 'active' : '') + '">' + label + '</button>').join('') + '</nav><main class="analysis-layout"><div class="analysis-main">' + main + '</div><aside class="side">' + termsAndQuestions() + budgetCard() + '</aside></main><aside id="evidence-drawer" class="evidence-drawer"></aside>';
  };
  const renderEvidence = () => {
    const drawer = document.getElementById('evidence-drawer'); if (!drawer) return;
    const value = state.evidence;
    if (!value) { drawer.innerHTML = ''; drawer.classList.remove('open'); return; }
    const key = composite(value.block.id, value.document.id); const translation = state.context?.analysis?.translations?.[key] || '尚未生成译文';
    const annotations = (state.context?.annotations || []).filter((item) => item.target?.sha256 === value.document.revision.sha256 && (item.selector?.anchor === value.block.id || (item.selector?.page === value.block.page && item.selector?.exact === value.block.originalText)));
    drawer.classList.add('open');
    drawer.innerHTML = '<header><strong>证据抽屉</strong><button data-action="close-evidence">×</button></header><blockquote>' + scientific(value.block.originalText) + '</blockquote><section><b>译文</b><p>' + scientific(translation) + '</p></section><dl><dt>原文位置</dt><dd>第 ' + number(value.block.page) + ' 页</dd><dt>定位状态</dt><dd>已绑定原文区域</dd><dt>来源置信度</dt><dd>' + escape(value.block.confidence || '未声明') + '</dd></dl><section><h3>批注</h3>' + (annotations.map((item) => item.comments.map((comment) => '<p>' + scientific(comment.content) + '</p>').join('')).join('') || '<p class="muted">暂无批注</p>') + '<form id="annotation-form"><textarea name="comment" maxlength="20000" placeholder="为当前证据添加批注"></textarea><button class="primary">保存</button></form></section>';
    drawer.querySelector('[data-action="close-evidence"]')?.addEventListener('click', () => { state.evidence = null; renderEvidence(); });
    drawer.querySelector('#annotation-form')?.addEventListener('submit', (event) => { event.preventDefault(); const comment = String(new FormData(event.currentTarget).get('comment') || '').trim(); if (comment) void tool('paper.annotate', { document: value.document.id, blockId: value.block.id, comment }); });
  };
  const render = () => {
    document.getElementById('app').innerHTML = panel === 'source' ? sourceView() : analysisView(); bind(); renderEvidence();
    const revealTarget = state.context?.reveal; const anchor = revealTarget?.selector?.kind === 'document-anchor' ? revealTarget.selector.anchor : null;
    if (anchor && panel === 'source') setTimeout(() => document.querySelector('[data-block="' + CSS.escape(anchor) + '"]')?.scrollIntoView({behavior:'smooth',block:'center'}), 20);
  };
  const renderError = (error) => { const host = document.getElementById('error'); host.textContent = error?.message || String(error); host.hidden = false; setTimeout(() => { host.hidden = true; }, 8000); };
  const bind = () => {
    document.querySelectorAll('[data-mode]').forEach((button) => button.addEventListener('click', () => { state.mode = button.dataset.mode; render(); if (state.mode === 'pdf') void openPdf().catch(renderError); }));
    document.querySelectorAll('[data-document]').forEach((button) => button.addEventListener('click', () => { state.documentId = button.dataset.document; state.selected.clear(); render(); }));
    document.querySelectorAll('[data-section]').forEach((button) => button.addEventListener('click', () => { state.section = button.dataset.section; render(); }));
    document.querySelectorAll('[data-block]').forEach((element) => element.addEventListener('click', (event) => { if (event.target.matches('input,button')) return; const id = element.dataset.block; void tool('paper.select-block', { blockId: id, document: state.documentId }); void reveal(id, state.documentId); }));
    document.querySelectorAll('[data-select]').forEach((input) => input.addEventListener('change', () => { input.checked ? state.selected.add(input.dataset.select) : state.selected.delete(input.dataset.select); render(); }));
    document.querySelectorAll('[data-reveal]').forEach((button) => button.addEventListener('click', () => void reveal(button.dataset.reveal)));
    document.querySelector('[data-action="prepare"]')?.addEventListener('click', () => void tool('paper.prepare'));
    document.querySelector('[data-action="start"]')?.addEventListener('click', () => void tool('paper.start'));
    document.querySelector('[data-action="resume"]')?.addEventListener('click', () => void tool('paper.resume'));
    document.querySelector('[data-action="cancel"]')?.addEventListener('click', () => void tool('paper.cancel'));
    document.querySelector('[data-action="follow"]')?.addEventListener('change', (event) => void tool('paper.auto-follow', { enabled: event.target.checked }));
    document.querySelector('[data-action="open-pdf"]')?.addEventListener('click', () => void openPdf().catch(renderError));
    document.querySelector('[data-action="translate"]')?.addEventListener('click', () => void tool('paper.translate', { blockIds: [...state.selected], document: state.documentId }));
    document.querySelector('[data-action="regenerate"]')?.addEventListener('click', () => void tool('paper.regenerate', { blockIds: [...state.selected] }));
    document.querySelector('[data-action="export"]')?.addEventListener('click', () => void tool('paper.export'));
    document.querySelectorAll('[data-rerun-module]').forEach((button) => button.addEventListener('click', () => void tool('paper.regenerate-module', { module: button.dataset.rerunModule, targetIds: String(button.dataset.targets || '').split(',').filter(Boolean) })));
    document.querySelectorAll('[data-rerun-figure]').forEach((button) => button.addEventListener('click', () => void tool('paper.regenerate-figure', { figureId: button.dataset.rerunFigure })));
    document.querySelectorAll('[data-freeze]').forEach((button) => button.addEventListener('click', () => { const source = button.dataset.freeze; const input = document.querySelector('[data-term="' + CSS.escape(source) + '"]'); void tool('paper.freeze-term', { source, translation: input?.value || '' }); }));
    document.getElementById('qa')?.addEventListener('submit', (event) => { event.preventDefault(); const question = new FormData(event.currentTarget).get('question'); void tool('paper.ask', { question: String(question || '') }); });
  };
  window.addEventListener('message', (event) => {
    if (event.data?.type !== 'openlab.plugin-panel.connect' || !event.ports?.[0]) return;
    state.token = event.data.token; state.port = event.ports[0];
    state.port.onmessage = (message) => { const pending = state.pending.get(message.data?.id); if (!pending) return; state.pending.delete(message.data.id); message.data.ok ? pending.resolve(message.data.value) : pending.reject(new Error(message.data.error || '宿主调用失败')); };
    state.port.start(); void requestContext().catch(renderError);
  });
  setInterval(() => { if (state.port && running()) void requestContext().catch(renderError); }, 1500);
})();
`;

const PANEL_STYLE = String.raw`
.paper-profile{margin:10px 12px;padding:16px 18px;border:1px solid #314653;border-radius:13px;background:linear-gradient(135deg,#13212b,#0e151b)}
.paper-profile h1{margin:8px 0 5px;max-width:1050px;font:700 21px/1.35 Georgia,"Times New Roman","Microsoft YaHei",serif}
.profile-authors,.profile-meta{margin:4px 0;color:#b7c7d2}.profile-meta{color:#8fa5b4}
.chemical-formula{white-space:nowrap}.chemical-formula sub{font-size:.72em;vertical-align:-.28em}.chemical-formula sup{font-size:.72em;vertical-align:.48em}
.formula-expression{font-family:"Cambria Math","STIX Two Math",serif;font-size:15px}
.source-block{position:relative}.block-select{position:absolute;right:8px;top:9px;z-index:2;display:flex;align-items:center;gap:5px;padding:3px 6px;border-radius:6px;background:#101820cc;color:#8fa2b0;font-size:11px}.source-block:hover .block-select{color:#d7e4ec}.source-grid{padding-right:82px}
:root{color-scheme:dark;font:13px/1.55 Inter,"Microsoft YaHei",system-ui,sans-serif;background:#0a0d10;color:#e9edf2}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 12% 0,#17232d 0,transparent 32%),#0a0d10}button,input,textarea{font:inherit;color:inherit}button{border:1px solid #303a44;background:#161c22;border-radius:7px;padding:6px 10px;cursor:pointer}button:hover{border-color:#72abd6;background:#202a33}button:disabled{opacity:.38;cursor:not-allowed}.primary{background:#dceeff;color:#102437;border-color:#dceeff;font-weight:700}.danger{border-color:#82444d;color:#ffc7cb}.toolbar{position:sticky;top:0;z-index:8;min-height:54px;padding:9px 12px;display:flex;align-items:center;justify-content:space-between;gap:10px;background:rgba(9,12,15,.95);backdrop-filter:blur(16px);border-bottom:1px solid #252d35}.toolbar>div{display:flex;align-items:center;gap:8px}.toolbar small,.muted{color:#8e9ba8}.segmented{padding:3px;border:1px solid #303944;border-radius:9px;background:#10151a}.segmented button{border:0;background:transparent;padding:5px 9px}.segmented button.active,.analysis-tabs button.active,.document-tabs button.active{background:#293a48;color:#e4f5ff;border-color:#4d718a}.follow{display:flex;align-items:center;gap:5px;color:#acb9c4}.document-tabs{display:flex;gap:6px;overflow:auto;padding:8px 12px;border-bottom:1px solid #252d35}.document-tabs button{display:flex;align-items:center;gap:7px;white-space:nowrap}.document-tabs small{color:#7f8e9b}.status-card{margin:10px 12px;padding:11px 12px;border:1px solid #2b343e;border-radius:11px;background:#11171d;display:grid;grid-template-columns:minmax(220px,1fr) minmax(100px,280px) auto auto;align-items:center;gap:10px}.status-title{display:grid;grid-template-columns:auto auto 1fr;align-items:center;gap:7px}.status-title i{width:8px;height:8px;border-radius:50%;background:#697987}.status-title small{color:#99a6b2}.status-completed .status-title i{background:#65d494;box-shadow:0 0 12px #65d494}.status-analyzing .status-title i,.status-inspecting .status-title i,.status-parsing .status-title i{background:#65afe2;box-shadow:0 0 12px #65afe2}.status-failed .status-title i,.status-unsupported_scanned .status-title i{background:#df6d78}.progress{height:6px;background:#29323b;border-radius:6px;overflow:hidden}.progress i{display:block;height:100%;background:linear-gradient(90deg,#70a8d2,#7fe0c3)}.usage{grid-column:1/-1;display:flex;flex-wrap:wrap;gap:7px}.usage span{padding:3px 7px;border:1px solid #27343e;border-radius:12px;color:#a8bbc9}.error-text{grid-column:1/-1;margin:0;color:#f1a99f}.block-actions{position:sticky;top:54px;z-index:7;display:flex;align-items:center;gap:8px;padding:8px 12px;background:#0e1318;border-bottom:1px solid #252d35}.block-actions span{margin-right:auto;color:#9baab6}.blocks{padding:5px 12px 90px}.source-block{border-bottom:1px solid #242e36;padding:12px 8px;scroll-margin-top:112px}.source-block:hover,.source-block.selected{background:#131c23}.source-block>header{display:flex;gap:10px;color:#8495a3;font-size:11px}.source-block>header label{margin-right:auto}.source-block em{font-style:normal;color:#77b1da}.source-grid{display:grid;grid-template-columns:1fr;gap:18px}.source-grid.bilingual{grid-template-columns:1fr 1fr}.source-grid p{font:14px/1.7 Georgia,"Times New Roman",serif;margin:8px 0;color:#f1f1ed}.source-grid .translation{font-family:"Microsoft YaHei",system-ui,sans-serif;color:#c5dcec;border-left:2px solid #426d89;padding-left:14px}.reading-card{margin:10px 0 2px;padding:10px;border:1px solid #2d4658;border-radius:9px;background:#0d1820}.reading-card>header{display:flex;justify-content:space-between;gap:8px}.reading-card>header span{color:#8ea7b9}.statement{padding:11px;margin:8px 0;border:1px solid #293641;border-radius:9px;background:#141b21}.statement.compact{padding:8px;background:#101a21}.statement header,.statement footer,.visual>header,.formula>header,.digest>header{display:flex;align-items:center;justify-content:space-between;gap:8px}.statement header span{color:#9ad2f5;font-weight:700}.statement em{font-style:normal;color:#8999a7;font-size:11px}.statement p{color:#cbd5dd}.statement footer small{color:#7e8d99}.quantities{display:flex;flex-wrap:wrap;gap:5px}.quantities span{padding:2px 6px;border:1px solid #3e594d;border-radius:9px;color:#a7e1bc}.pdf-mode{height:calc(100vh - 190px);display:grid;place-items:center;padding:24px}.pdf-mode>div{max-width:540px;padding:24px;border:1px solid #2d3e4a;border-radius:13px;background:#111920;text-align:center}.pdf-mode code{word-break:break-all}.analysis-tabs{position:sticky;top:54px;z-index:7;display:flex;gap:6px;overflow:auto;padding:8px 12px;background:#0d1217;border-bottom:1px solid #252d35}.analysis-tabs button{white-space:nowrap}.analysis-layout{display:grid;grid-template-columns:minmax(360px,1fr) minmax(270px,33%);gap:12px;padding:0 12px 90px}.analysis-main{min-width:0}.report-group,.digest,.visual,.formula,.reproduction>div,.quality-panel,.side>section,.pipeline{margin:10px 0;padding:12px;border:1px solid #29343d;border-radius:10px;background:#10161b}.report-group h2,.digest h2,.visual-grid h2,.reproduction h2,.quality-panel h2,.side h2,.pipeline h3{font-size:14px;margin:0 0 9px}.digest header small{color:#758a9a}.digest .argument{padding:8px;border-left:2px solid #5495bd;background:#0d171e;color:#bcd2e0}.visual-grid{display:grid;grid-template-columns:1fr;gap:10px}.visual dl,.formula dl,.budget dl{display:grid;grid-template-columns:110px 1fr;gap:5px}.visual dt,.formula dt,.budget dt{color:#8294a2}.visual dd,.formula dd,.budget dd{margin:0}.visual code,.formula code{display:block;padding:8px;background:#090e12;border-radius:6px;white-space:pre-wrap}.quality{padding:2px 7px;border-radius:9px;background:#28323a}.quality-verified,.quality-complete{background:#183d2b;color:#8fe0ae}.quality-needs_review,.quality-incomplete{background:#493b1b;color:#ffd98a}.quality-failed{background:#4c2429;color:#ffadb4}.reproduction{display:grid;grid-template-columns:1fr 1fr;gap:10px}.missing{color:#d5a074}.coverage{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}.coverage div{padding:8px;border:1px solid #293842;border-radius:8px}.coverage span{display:block;color:#8095a4;font-size:11px}.quality-panel ul{padding:0;list-style:none}.quality-panel li{display:flex;align-items:center;gap:8px;padding:7px;border-bottom:1px solid #26313a}.quality-panel li i{width:8px;height:8px;border-radius:50%;background:#d96470}.quality-panel li.pass i{background:#63d491}.quality-panel li span{margin-right:auto}.issues p{color:#eda89e}.pipeline details{border-top:1px solid #29343d;padding:7px 0}.pipeline summary{display:flex;justify-content:space-between;cursor:pointer}.unit{display:grid;grid-template-columns:auto 1fr auto auto;gap:7px;padding:5px 2px;align-items:center}.unit i{width:7px;height:7px;border-radius:50%;background:#72818d}.unit-completed i{background:#64d493}.unit-failed i{background:#df6874}.unit p{grid-column:2/-1;margin:0;color:#e7a098}.unit em{font-style:normal;color:#8b9ba7}.unit small{color:#768692}.side{display:flex;flex-direction:column;gap:2px}.term{display:grid;grid-template-columns:minmax(70px,.8fr) minmax(90px,1fr) auto;gap:5px;margin:5px 0;align-items:center}.term b{overflow:hidden;text-overflow:ellipsis}.term input,textarea{width:100%;border:1px solid #2d3943;background:#0a1014;border-radius:6px;padding:6px}.term button{font-size:11px;padding:5px}#qa{display:grid;gap:7px}#qa textarea{min-height:72px;resize:vertical}.question{border-top:1px solid #29343d;margin-top:10px;padding-top:9px}.question footer{display:flex;justify-content:space-between}.budget p{color:#9fc1d8}.budget small{color:#8797a3}.legacy{margin:10px 0;padding:14px;border:1px solid #5b4930;background:#211b13;border-radius:10px}.empty,.loading{padding:34px;text-align:center;color:#8494a1}.empty.compact{padding:12px}.evidence-drawer{position:fixed;z-index:30;right:10px;bottom:10px;width:min(420px,calc(100vw - 20px));max-height:70vh;overflow:auto;transform:translateY(calc(100% + 18px));transition:transform .2s ease;border:1px solid #4b6e84;border-radius:12px;background:#101a22;box-shadow:0 16px 60px #000b;padding:12px}.evidence-drawer.open{transform:translateY(0)}.evidence-drawer>header{display:flex;justify-content:space-between}.evidence-drawer blockquote{margin:10px 0;padding:10px;border-left:3px solid #69b0dc;background:#091116}.evidence-drawer section{margin:9px 0;padding:9px;border:1px solid #293d4b;border-radius:8px}.evidence-drawer dl{display:grid;grid-template-columns:88px 1fr;gap:5px}.evidence-drawer dt{color:#8495a2}.evidence-drawer dd{margin:0;word-break:break-all}.evidence-drawer form{display:grid;gap:6px}.evidence-drawer textarea{min-height:65px}#error{position:fixed;z-index:60;left:50%;top:16px;transform:translateX(-50%);max-width:82%;padding:10px 14px;border:1px solid #91464e;background:#371b1f;color:#ffdade;border-radius:8px;box-shadow:0 8px 30px #0009}@media(max-width:800px){.source-grid.bilingual,.analysis-layout,.reproduction{grid-template-columns:1fr}.status-card{grid-template-columns:1fr auto}.status-card .progress{grid-column:1/-1}.toolbar{flex-wrap:wrap}.analysis-layout{padding:0 7px 80px}.coverage{grid-template-columns:1fr 1fr}}
`;

export function paperReaderPanelHtml(panelId: string): string {
  if (panelId !== 'source' && panelId !== 'analysis') throw new Error('论文精读面板不存在');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>论文精读 V2</title><style>${PANEL_STYLE}</style></head><body data-panel="${panelId}"><div id="error" hidden></div><div id="app"><div class="loading">正在连接 Sci Workplace 宿主…</div></div><script>${PANEL_SCRIPT}</script></body></html>`;
}
