const PANEL_SCRIPT = String.raw`
(() => {
  const state = { port: null, token: '', pending: new Map(), context: null, view: 'original', document: 'main', selected: new Set(), evidence: null, busy: false };
  const panel = document.body.dataset.panel;
  const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    if (!state.port) return reject(new Error('宿主桥尚未连接'));
    const id = crypto.randomUUID();
    state.pending.set(id, { resolve, reject });
    state.port.postMessage({ id, token: state.token, method, params });
  });
  const statusLabel = (value) => ({unconfigured:'未配置',ready:'待确认',inspecting:'离线预检',parsing:'解析版面',analyzing:'全文模型处理',completed:'已完成',unsupported_scanned:'不支持扫描件',interrupted:'已中断',failed:'失败'}[value] || value);
  const categoryLabel = (value) => ({'research-question':'研究问题','method':'方法','claim-evidence':'主张—证据','key-result':'关键结果','figure-formula':'图表 / 公式','reproduction':'复现','contribution':'贡献','limitation':'局限','unproven':'未证明事项'}[value] || value);
  const running = () => ['inspecting','parsing','analyzing'].includes(state.context?.reader?.status);
  const requestContext = async () => {
    try {
      state.context = await call('context.read');
      render();
    } catch (error) { renderError(error); }
  };
  const tool = async (name, params = {}) => {
    if (state.busy) return;
    state.busy = true; render();
    try { await call('tool.execute', { tool: name, params }); await requestContext(); }
    catch (error) { renderError(error); }
    finally { state.busy = false; render(); }
  };
  const reveal = async (blockId) => {
    const context = state.context;
    const document = state.document === 'si' ? context?.supportingDocument : context?.document;
    const parsed = state.document === 'si' ? context?.supportingParsed : context?.parsed;
    const block = parsed?.blocks?.find((candidate) => candidate.id === blockId);
    if (!document || !block) return;
    state.evidence = { block, document };
    renderEvidence();
    await call('evidence.reveal', {
      document,
      selector: { kind: 'document-anchor', scheme: 'sci.paper-reader.block.v1', anchor: block.id, exact: block.originalText },
      target: { panelId: 'source' },
    });
  };
  const renderStatus = () => {
    const value = state.context;
    if (!value) return '<div class="loading">正在读取精读上下文…</div>';
    const reader = value.reader;
    const action = reader.status === 'ready' ? (value.callPreview?.ready
      ? '<button class="primary" data-action="start">确认并自动处理全文</button>'
      : '<button class="primary" data-action="prepare">生成调用量预览</button>')
      : ['interrupted','failed'].includes(reader.status) ? (value.callPreview?.ready
        ? '<button class="primary" data-action="resume">从检查点自动重试</button>'
        : '<button class="primary" data-action="prepare">重新离线预检</button>')
      : reader.status === 'unsupported_scanned' ? ''
      : running() ? '<button class="danger" data-action="cancel">取消任务</button>' : '';
    return '<section class="status-card ' + escape(reader.status) + '"><div><span class="status-dot"></span><strong>' + escape(statusLabel(reader.status)) + '</strong><small>' + escape(reader.stage) + '</small></div><div class="progress"><i style="width:' + Math.round(reader.progress * 100) + '%"></i></div><span>' + Math.round(reader.progress * 100) + '%</span>' + action + (reader.error ? '<p>' + escape(reader.error) + '</p>' : '') + (!value.toolchainAvailable ? '<p>离线 Reader Runtime 尚未安装，解析按钮会保持禁用。</p>' : '') + '</section>';
  };
  const blockCards = (parsed, bilingual) => {
    if (!parsed?.blocks?.length) return '<div class="empty">解析完成后，这里会出现逐段来源视图。</div>';
    return parsed.blocks.filter((block) => !['running_matter'].includes(block.type)).map((block) => {
      const translation = state.context.analysis.translations[block.id];
      const selected = state.selected.has(block.id);
      return '<article id="block-' + escape(block.id) + '" class="source-block ' + (selected ? 'selected' : '') + '" data-block="' + escape(block.id) + '"><header><label><input type="checkbox" data-select="' + escape(block.id) + '" ' + (selected ? 'checked' : '') + '><b>' + escape(block.id) + '</b></label><span>p.' + escape(block.page) + '</span><em>' + escape(block.type) + '</em></header><div class="source-grid ' + (bilingual ? 'bilingual' : '') + '"><p>' + escape(block.originalText) + '</p>' + (bilingual ? '<p class="translation">' + escape(translation || '确认全文任务后将自动生成本段译文。') + '</p>' : '') + '</div></article>';
    }).join('');
  };
  const sourceView = () => {
    const context = state.context;
    const parsed = state.document === 'si' ? context?.supportingParsed : context?.parsed;
    const document = state.document === 'si' ? context?.supportingDocument : context?.document;
    const docControls = context?.supportingDocument ? '<button data-doc="main" class="' + (state.document === 'main' ? 'active' : '') + '">主文</button><button data-doc="si" class="' + (state.document === 'si' ? 'active' : '') + '">SI</button>' : '<span class="pill">主文</span>';
    return '<header class="toolbar"><div class="segmented"><button data-view="original" class="' + (state.view === 'original' ? 'active' : '') + '">PDF 原版</button><button data-view="bilingual" class="' + (state.view === 'bilingual' ? 'active' : '') + '">逐段双语</button></div><div class="segmented">' + docControls + '</div><label class="follow"><input type="checkbox" data-action="follow" ' + (context?.reader?.autoFollow ? 'checked' : '') + '>自动跟随</label></header>' + renderStatus() + (state.view === 'original' ? '<div class="pdf-shell" data-pdf><div class="empty">' + (document ? '正在申请只读 PDF 票据…' : '未绑定 PDF') + '</div></div>' : '<div class="block-actions"><span>已选 ' + state.selected.size + ' 段</span><button data-action="translate" ' + (state.selected.size ? '' : 'disabled') + '>翻译所选</button><button data-action="regenerate" ' + (state.selected.size ? '' : 'disabled') + '>局部重新生成</button></div><main class="blocks">' + blockCards(parsed, true) + '</main>') + '<aside id="evidence-drawer" class="evidence-drawer"></aside>';
  };
  const analysisView = () => {
    const context = state.context;
    const analysis = context?.analysis;
    const reader = context?.reader;
    const selectedHint = reader?.activeBlockId ? '<div class="active-source">当前原文：<b>' + escape(reader.activeBlockId) + '</b>（跟读卡已筛选）</div>' : '';
    const conclusions = analysis?.conclusions?.filter((item) => !reader?.activeBlockId || item.blockIds.includes(reader.activeBlockId));
    const cards = conclusions?.length ? conclusions.map((item) => '<article class="conclusion" data-conclusion="' + escape(item.id) + '"><header><span>' + escape(categoryLabel(item.category)) + '</span><em>' + escape(item.confidence) + '</em></header><h3>' + escape(item.title) + '</h3><p>' + escape(item.content) + '</p><footer><button data-reveal="' + escape(item.blockIds[0]) + '">定位 ' + escape(item.blockIds.join('、')) + '</button><small>生成 v' + escape(item.generationVersion) + ' · ' + item.evidenceAnchorIds.length + ' 个证据锚点</small></footer></article>').join('') : '<div class="empty">完成解析后将生成研究问题、方法、主张—证据、结果、复现、贡献、局限与未证明事项。</div>';
    const terms = analysis?.terms?.slice(0, 24).map((term) => '<div class="term"><b>' + escape(term.source) + '</b><input data-term="' + escape(term.source) + '" value="' + escape(term.translation) + '" placeholder="固定译法"><button data-freeze="' + escape(term.source) + '">' + (term.frozen ? '已冻结' : '冻结') + '</button></div>').join('') || '<div class="empty compact">解析后自动抽取全文术语。</div>';
    const questions = analysis?.questions?.map((item) => '<article class="question"><b>Q：' + escape(item.question) + '</b><p>' + escape(item.answer) + '</p><button data-reveal="' + escape(item.blockIds[0]) + '">查看来源</button></article>').join('') || '';
    return '<header class="toolbar"><div><strong>章节跟读与全局报告</strong><small>' + escape(reader?.blockCount || 0) + ' 块 · ' + escape(reader?.figureCount || 0) + ' 图表 · ' + escape(reader?.evidenceAnchorIds?.length || 0) + ' 锚点</small></div><button data-action="export" ' + (reader?.status === 'completed' ? '' : 'disabled') + '>导出 Markdown / JSON</button></header>' + renderStatus() + selectedHint + '<main class="analysis-layout"><section class="report"><div class="section-title"><h2>来源约束结论</h2><span>无锚点结论无法通过质量门</span></div>' + cards + '</section><aside class="side"><section><h2>全文术语冻结</h2>' + terms + '</section><section><h2>仅来源问答</h2><form id="qa"><textarea name="question" placeholder="问题只会依据当前论文来源块回答"></textarea><button class="primary">提问</button></form>' + questions + '</section><section class="call-preview"><h2>一次确认的调用量预览</h2><p>模型：' + escape(context?.callPreview?.model || '未配置') + '</p><p>离线解析调用：' + escape(context?.callPreview?.parseCalls || 0) + '</p><p>自动模型调用：' + escape(context?.callPreview?.modelCalls || 0) + '</p><p>预计输入 token：' + escape(context?.callPreview?.estimatedInputTokens || 0) + '</p><p>预计输出 token：' + escape(context?.callPreview?.estimatedOutputTokens || 0) + '</p><p><b>预计总 token：' + escape(context?.callPreview?.estimatedTotalTokens || 0) + '</b></p><p>本次硬上限：' + escape(context?.callPreview?.maximumTotalTokens || 0) + '</p><small>' + escape(context?.callPreview?.note || '') + '</small></section></aside></main><aside id="evidence-drawer" class="evidence-drawer"></aside>';
  };
  const renderEvidence = () => {
    const drawer = document.getElementById('evidence-drawer');
    if (!drawer) return;
    const value = state.evidence;
    if (!value) { drawer.innerHTML = ''; drawer.classList.remove('open'); return; }
    drawer.classList.add('open');
    drawer.innerHTML = '<header><strong>证据抽屉</strong><button data-action="close-evidence">×</button></header><blockquote>' + escape(value.block.originalText) + '</blockquote><dl><dt>页码</dt><dd>p.' + escape(value.block.page) + '</dd><dt>来源块</dt><dd>' + escape(value.block.id) + '</dd><dt>文档修订</dt><dd><code>' + escape(value.document.sha256.slice(0, 16)) + '…</code></dd><dt>坐标</dt><dd>' + escape(value.block.bbox?.join(', ') || '无坐标区域') + '</dd><dt>置信度</dt><dd>' + escape(value.block.confidence || '未声明') + '</dd><dt>生成版本</dt><dd>v' + escape(state.context?.reader?.generationVersion || 0) + '</dd></dl>';
  };
  const attachPdf = async () => {
    if (panel !== 'source' || state.view !== 'original') return;
    const shell = document.querySelector('[data-pdf]');
    const target = state.document === 'si' ? state.context?.supportingDocument : state.context?.document;
    if (!shell || !target) return;
    try {
      const access = await call('resource.open', { document: target });
      shell.innerHTML = '<iframe title="原始 PDF" src="' + escape(access.url) + '#toolbar=1&navpanes=0"></iframe>';
    } catch (error) { shell.innerHTML = '<div class="empty">' + escape(error.message || error) + '</div>'; }
  };
  const render = () => {
    document.getElementById('app').innerHTML = panel === 'source' ? sourceView() : analysisView();
    bind(); renderEvidence(); void attachPdf();
    const reveal = state.context?.reveal;
    const anchor = reveal?.instanceId === state.context?.reader?.instanceId && reveal?.selector?.kind === 'document-anchor' ? reveal.selector.anchor : null;
    if (anchor && panel === 'source' && state.view !== 'original') setTimeout(() => document.getElementById('block-' + CSS.escape(anchor))?.scrollIntoView({behavior:'smooth',block:'center'}), 20);
  };
  const renderError = (error) => {
    const host = document.getElementById('error');
    host.textContent = error?.message || String(error); host.hidden = false;
    setTimeout(() => { host.hidden = true; }, 6000);
  };
  const bind = () => {
    document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => { state.view = button.dataset.view; render(); }));
    document.querySelectorAll('[data-doc]').forEach((button) => button.addEventListener('click', () => { state.document = button.dataset.doc; render(); }));
    document.querySelectorAll('[data-block]').forEach((element) => element.addEventListener('click', (event) => {
      if (event.target.matches('input')) return;
      const id = element.dataset.block; void tool('paper.select-block', { blockId: id }); void reveal(id);
    }));
    document.querySelectorAll('[data-select]').forEach((input) => input.addEventListener('change', () => { input.checked ? state.selected.add(input.dataset.select) : state.selected.delete(input.dataset.select); render(); }));
    document.querySelectorAll('[data-reveal]').forEach((button) => button.addEventListener('click', () => void reveal(button.dataset.reveal)));
    document.querySelector('[data-action="prepare"]')?.addEventListener('click', () => void tool('paper.prepare'));
    document.querySelector('[data-action="start"]')?.addEventListener('click', () => void tool('paper.start'));
    document.querySelector('[data-action="resume"]')?.addEventListener('click', () => void tool('paper.resume'));
    document.querySelector('[data-action="cancel"]')?.addEventListener('click', () => void tool('paper.cancel'));
    document.querySelector('[data-action="follow"]')?.addEventListener('change', (event) => void tool('paper.auto-follow', { enabled: event.target.checked }));
    document.querySelector('[data-action="translate"]')?.addEventListener('click', () => void tool('paper.translate', { blockIds: [...state.selected] }));
    document.querySelector('[data-action="regenerate"]')?.addEventListener('click', () => void tool('paper.regenerate', { blockIds: [...state.selected] }));
    document.querySelector('[data-action="export"]')?.addEventListener('click', () => void tool('paper.export'));
    document.querySelector('[data-action="close-evidence"]')?.addEventListener('click', () => { state.evidence = null; renderEvidence(); });
    document.querySelectorAll('[data-freeze]').forEach((button) => button.addEventListener('click', () => { const source = button.dataset.freeze; const input = document.querySelector('[data-term="' + CSS.escape(source) + '"]'); void tool('paper.freeze-term', { source, translation: input?.value || '' }); }));
    document.getElementById('qa')?.addEventListener('submit', (event) => { event.preventDefault(); const question = new FormData(event.currentTarget).get('question'); void tool('paper.ask', { question: String(question || '') }); });
  };
  window.addEventListener('message', (event) => {
    if (event.data?.type !== 'openlab.plugin-panel.connect' || !event.ports?.[0]) return;
    state.token = event.data.token; state.port = event.ports[0];
    state.port.onmessage = (message) => {
      const pending = state.pending.get(message.data?.id); if (!pending) return;
      state.pending.delete(message.data.id); message.data.ok ? pending.resolve(message.data.value) : pending.reject(new Error(message.data.error || '宿主调用失败'));
    };
    state.port.start(); void requestContext();
  });
  setInterval(() => { if (state.port && running()) void requestContext(); }, 1600);
})();
`;

const PANEL_STYLE = String.raw`
:root{color-scheme:dark;font:13px/1.55 Inter,"Microsoft YaHei",system-ui,sans-serif;background:#0b0d10;color:#e9edf2}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 10% 0,#17212a 0,transparent 34%),#0b0d10}button,input,textarea{font:inherit;color:inherit}button{border:1px solid #303842;background:#171b20;border-radius:7px;padding:6px 10px;cursor:pointer}button:hover{border-color:#6fa9d8;background:#202831}button:disabled{opacity:.42;cursor:not-allowed}.primary{background:#dceeff;color:#102437;border-color:#dceeff;font-weight:700}.danger{border-color:#7d3f45;color:#ffc4c8}.toolbar{position:sticky;top:0;z-index:5;min-height:52px;padding:9px 12px;display:flex;align-items:center;justify-content:space-between;gap:10px;background:rgba(10,12,15,.94);backdrop-filter:blur(16px);border-bottom:1px solid #252a31}.toolbar>div{display:flex;align-items:center;gap:8px}.toolbar>div>small{color:#8d98a5}.segmented{padding:3px;border:1px solid #2d343d;border-radius:9px;background:#101419}.segmented button{border:0;background:transparent;padding:5px 9px}.segmented button.active{background:#2a3642;color:#dff1ff}.pill{padding:4px 9px;color:#abc2d6}.follow{display:flex;align-items:center;gap:5px;color:#aeb8c3}.status-card{margin:10px 12px;padding:10px 12px;border:1px solid #2b323b;border-radius:10px;background:#11151a;display:grid;grid-template-columns:minmax(190px,1fr) minmax(90px,260px) auto auto;align-items:center;gap:10px}.status-card>div:first-child{display:grid;grid-template-columns:auto auto 1fr;align-items:center;gap:7px}.status-card small{color:#98a3af}.status-card p{grid-column:1/-1;margin:0;color:#f3b7aa}.status-dot{width:8px;height:8px;border-radius:50%;background:#6b7784}.status-card.completed .status-dot{background:#6bd391;box-shadow:0 0 12px #6bd391}.status-card.parsing .status-dot,.status-card.inspecting .status-dot,.status-card.analyzing .status-dot{background:#62a9de;box-shadow:0 0 12px #62a9de}.status-card.failed .status-dot,.status-card.unsupported_scanned .status-dot{background:#df6874}.progress{height:5px;background:#293039;border-radius:5px;overflow:hidden}.progress i{display:block;height:100%;background:linear-gradient(90deg,#71a7d0,#7de0c4)}.pdf-shell{height:calc(100vh - 86px);margin:0 12px 12px;border:1px solid #2b323b;border-radius:10px;overflow:hidden;background:#14181d}.pdf-shell iframe{border:0;width:100%;height:100%;background:white}.empty,.loading{padding:34px;text-align:center;color:#83909c}.empty.compact{padding:12px}.block-actions{position:sticky;top:52px;z-index:4;display:flex;gap:8px;align-items:center;padding:8px 12px;background:#0d1115;border-bottom:1px solid #252b32}.block-actions span{margin-right:auto;color:#9ba8b4}.blocks{padding:6px 12px 80px}.source-block{border-bottom:1px solid #252b32;padding:12px 8px;scroll-margin-top:105px}.source-block:hover,.source-block.selected{background:#141b22}.source-block>header{display:flex;gap:10px;color:#8493a1;font-size:11px}.source-block>header label{margin-right:auto}.source-block em{font-style:normal;color:#6fa9d8}.source-grid{display:grid;grid-template-columns:1fr;gap:18px}.source-grid.bilingual{grid-template-columns:1fr 1fr}.source-grid p{font:14px/1.68 Georgia,"Times New Roman",serif;margin:8px 0;color:#f2f2ef}.source-grid .translation{font-family:"Microsoft YaHei",system-ui,sans-serif;color:#c2d7e7;border-left:2px solid #426783;padding-left:14px}.analysis-layout{display:grid;grid-template-columns:minmax(320px,1fr) minmax(260px,34%);gap:12px;padding:0 12px 90px}.report,.side>section{border:1px solid #282f37;border-radius:10px;background:#101419}.report{padding:12px}.section-title{display:flex;align-items:end;justify-content:space-between}.section-title h2,.side h2{font-size:13px;margin:0 0 10px}.section-title span{font-size:11px;color:#7995aa}.conclusion{padding:12px;margin:8px 0;border:1px solid #28323b;border-radius:9px;background:#141a20}.conclusion>header{display:flex;justify-content:space-between}.conclusion>header span{color:#9ed1f5;font-weight:700}.conclusion em{font-style:normal;color:#8997a5;font-size:11px}.conclusion h3{font-size:14px;margin:8px 0}.conclusion p{color:#c8d0d8}.conclusion footer{display:flex;align-items:center;justify-content:space-between;gap:8px}.conclusion footer small{color:#74818e}.side{display:flex;flex-direction:column;gap:12px}.side>section{padding:12px}.term{display:grid;grid-template-columns:minmax(70px,.8fr) minmax(90px,1fr) auto;gap:5px;margin:5px 0;align-items:center}.term b{overflow:hidden;text-overflow:ellipsis}.term input,textarea{width:100%;border:1px solid #2c353f;background:#0b0f13;border-radius:6px;padding:6px}.term button{font-size:11px;padding:5px}#qa{display:grid;gap:7px}#qa textarea{min-height:68px;resize:vertical}.question{border-top:1px solid #29313a;margin-top:10px;padding-top:10px}.question p{color:#b8c2cc}.call-preview p{margin:3px 0}.call-preview small{color:#8795a2}.active-source{margin:0 12px 10px;padding:8px 10px;border:1px solid #35526a;background:#142230;border-radius:8px}.evidence-drawer{position:fixed;z-index:20;right:10px;bottom:10px;width:min(390px,calc(100vw - 20px));max-height:65vh;overflow:auto;transform:translateY(calc(100% + 18px));transition:transform .2s ease;border:1px solid #486478;border-radius:12px;background:#101820;box-shadow:0 16px 60px #000b;padding:12px}.evidence-drawer.open{transform:translateY(0)}.evidence-drawer>header{display:flex;justify-content:space-between}.evidence-drawer blockquote{margin:10px 0;padding:10px;border-left:3px solid #68addb;background:#0a1015}.evidence-drawer dl{display:grid;grid-template-columns:85px 1fr;gap:5px}.evidence-drawer dt{color:#8393a2}.evidence-drawer dd{margin:0;word-break:break-all}#error{position:fixed;z-index:50;left:50%;top:16px;transform:translateX(-50%);max-width:80%;padding:9px 13px;border:1px solid #8f434b;background:#351a1e;color:#ffd9db;border-radius:8px;box-shadow:0 8px 30px #0008}@media(max-width:760px){.source-grid.bilingual,.analysis-layout{grid-template-columns:1fr}.status-card{grid-template-columns:1fr auto}.status-card .progress{grid-column:1/-1}.toolbar{flex-wrap:wrap}.analysis-layout{padding:0 7px 80px}.source-block{padding:10px 3px}}
`;

export function paperReaderPanelHtml(panelId: string): string {
  if (panelId !== 'source' && panelId !== 'analysis') throw new Error('论文精读面板不存在');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>论文精读</title><style>${PANEL_STYLE}</style></head><body data-panel="${panelId}"><div id="error" hidden></div><div id="app"><div class="loading">正在连接 Sci Workplace 宿主…</div></div><script>${PANEL_SCRIPT}</script></body></html>`;
}
