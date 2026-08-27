import { memo, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft, ArrowRight, ArrowUpRight, ChevronLeft, ChevronRight, Copy, EllipsisVertical, ExternalLink,
  File, FileImage, FileText, Globe2, LoaderCircle, Minus, Plus, RefreshCw, SquareTerminal, X,
} from 'lucide-react';
import type { BrowserSessionSummary, JsonValue, WorkspacePreview } from '@openlab/protocol';
import ReactMarkdown from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import rehypeSanitize from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import 'katex/dist/katex.min.css';
import '@xterm/xterm/css/xterm.css';
import { hanaZhCN as copy } from '../i18n/zh-CN.js';

export type WorkspacePreviewTab =
  | { id: string; kind: 'file'; preview: WorkspacePreview }
  | { id: string; kind: 'browser'; sessionId: string; initialUrl: string }
  | { id: string; kind: 'terminal'; terminalId: string; title: string };

interface WorkspacePreviewDeckProps {
  tabs: WorkspacePreviewTab[];
  activeId: string;
  browserSessions: BrowserSessionSummary[];
  onActivate(id: string): void;
  onClose(id: string): void;
  onAddFile(): void;
  onAddBrowser(): void;
  onAddTerminal(): void;
  onNavigateBrowser(sessionId: string, url: string): Promise<void>;
  onBrowserHistory(sessionId: string, action: 'back' | 'forward' | 'reload'): Promise<void>;
  onSetBrowserBounds(sessionId: string, bounds: { x: number; y: number; width: number; height: number }, visible: boolean): Promise<void>;
  onHideBrowsers(): Promise<void>;
  onTerminalAction(terminalId: string, input: Record<string, unknown>): Promise<JsonValue | undefined>;
  onOpenSystem(preview: WorkspacePreview): void;
}

function previewIcon(preview: WorkspacePreview) {
  if (preview.kind === 'image') return <FileImage size={13}/>;
  if (preview.kind === 'pdf' || preview.kind === 'word' || preview.mediaType === 'text/markdown') return <FileText size={13}/>;
  return <File size={13}/>;
}

function dataUrlArrayBuffer(dataUrl: string): ArrayBuffer {
  const marker = dataUrl.indexOf(',');
  if (marker < 0) throw new Error(copy.workspace.previewPanel.invalidData);
  const encoded = dataUrl.slice(marker + 1);
  const binary = atob(encoded);
  const output = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(output);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return output;
}

function openPreviewLink(href: string | undefined) {
  if (href?.startsWith('https://')) void window.openlab?.openExternal(href);
}

const MarkdownPreview = memo(function MarkdownPreview({ content }: { content: string }) {
  return <div className="workspace-document-preview workspace-markdown-preview"><ReactMarkdown
    remarkPlugins={[remarkGfm, remarkMath]}
    rehypePlugins={[rehypeSanitize, rehypeKatex]}
    urlTransform={(url) => /^https:\/\//u.test(url) ? url : ''}
    components={{
      a: ({ href, children }) => <a href={href} onClick={(event) => { event.preventDefault(); openPreviewLink(href); }}>{children}</a>,
      img: ({ alt }) => <span className="workspace-preview-image-placeholder">{copy.workspace.previewPanel.imageAlt(alt ?? '')}</span>,
      input: ({ checked }) => <input type="checkbox" checked={checked} readOnly/>,
    }}
  >{content}</ReactMarkdown></div>;
});

function sanitizeWordHtml(value: string): string {
  const parsed = new DOMParser().parseFromString(value, 'text/html');
  const allowedTags = new Set(['A', 'B', 'BLOCKQUOTE', 'BR', 'EM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'I', 'IMG', 'LI', 'OL', 'P', 'PRE', 'S', 'STRONG', 'SUB', 'SUP', 'TABLE', 'TBODY', 'TD', 'TH', 'THEAD', 'TR', 'U', 'UL']);
  for (const element of [...parsed.body.querySelectorAll('*')]) {
    if (!allowedTags.has(element.tagName)) {
      element.replaceWith(...element.childNodes);
      continue;
    }
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLocaleLowerCase();
      const keep = (element.tagName === 'A' && name === 'href')
        || (element.tagName === 'IMG' && ['src', 'alt'].includes(name))
        || (['TD', 'TH'].includes(element.tagName) && ['colspan', 'rowspan'].includes(name));
      if (!keep) element.removeAttribute(attribute.name);
    }
    if (element instanceof HTMLAnchorElement) {
      if (!element.href.startsWith('https://')) element.removeAttribute('href');
      element.rel = 'noreferrer noopener';
    }
    if (element instanceof HTMLImageElement && !/^data:image\/(?:png|jpe?g|gif|webp);base64,/u.test(element.src)) element.removeAttribute('src');
  }
  return parsed.body.innerHTML;
}

const WordPreview = memo(function WordPreview({ dataUrl }: { dataUrl: string }) {
  const [html, setHtml] = useState('');
  const [error, setError] = useState<string>();
  useEffect(() => {
    let active = true;
    setHtml('');
    setError(undefined);
    void import('mammoth').then(({ default: mammoth }) => mammoth.convertToHtml(
      { arrayBuffer: dataUrlArrayBuffer(dataUrl) },
      { convertImage: mammoth.images.dataUri, externalFileAccess: false },
    )).then((result) => { if (active) setHtml(sanitizeWordHtml(result.value)); })
      .catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { active = false; };
  }, [dataUrl]);
  if (error) return <PreviewFailure message={copy.workspace.previewPanel.wordFailed(error)}/>;
  if (!html) return <PreviewLoading label={copy.workspace.previewPanel.wordLoading}/>;
  return <div className="workspace-document-preview workspace-word-preview" onClick={(event) => {
    const anchor = (event.target as HTMLElement).closest('a');
    if (!anchor) return;
    event.preventDefault();
    openPreviewLink(anchor.getAttribute('href') ?? undefined);
  }} dangerouslySetInnerHTML={{ __html: html }}/>;
});

const PdfPreview = memo(function PdfPreview({ dataUrl }: { dataUrl: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const renderRevision = useRef(0);
  const [document, setDocument] = useState<import('pdfjs-dist').PDFDocumentProxy>();
  const [pageNumber, setPageNumber] = useState(1);
  const [zoom, setZoom] = useState(.8);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let active = true;
    let loaded: import('pdfjs-dist').PDFDocumentProxy | undefined;
    setDocument(undefined);
    setPageNumber(1);
    setError(undefined);
    void import('pdfjs-dist').then(async (pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
      loaded = await pdfjs.getDocument({ data: new Uint8Array(dataUrlArrayBuffer(dataUrl)) }).promise;
      if (active) setDocument(loaded);
      else await loaded.loadingTask.destroy();
    }).catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { active = false; if (loaded) void loaded.loadingTask.destroy(); };
  }, [dataUrl]);
  useEffect(() => {
    if (!document || !canvas.current) return;
    const revision = ++renderRevision.current;
    let task: import('pdfjs-dist').RenderTask | undefined;
    void document.getPage(pageNumber).then((page) => {
      if (revision !== renderRevision.current || !canvas.current) return;
      const viewport = page.getViewport({ scale: zoom });
      const outputScale = Math.max(1, window.devicePixelRatio || 1);
      const target = canvas.current;
      const context = target.getContext('2d');
      if (!context) throw new Error(copy.workspace.previewPanel.pdfCanvasUnavailable);
      target.width = Math.floor(viewport.width * outputScale);
      target.height = Math.floor(viewport.height * outputScale);
      target.style.width = `${Math.floor(viewport.width)}px`;
      target.style.height = `${Math.floor(viewport.height)}px`;
      task = page.render({ canvas: target, canvasContext: context, viewport, transform: outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0] });
      return task.promise;
    }).catch((cause) => {
      if (revision === renderRevision.current && cause instanceof Error && cause.name !== 'RenderingCancelledException') setError(cause.message);
    });
    return () => { renderRevision.current += 1; task?.cancel(); };
  }, [document, pageNumber, zoom]);
  if (error) return <PreviewFailure message={copy.workspace.previewPanel.pdfFailed(error)}/>;
  if (!document) return <PreviewLoading label={copy.workspace.previewPanel.pdfLoading}/>;
  return <div className="workspace-pdf-preview">
    <div className="workspace-preview-toolbar workspace-pdf-toolbar">
      <button disabled={pageNumber <= 1} aria-label={copy.workspace.previewPanel.previousPage} onClick={() => setPageNumber((value) => Math.max(1, value - 1))}><ChevronLeft size={14}/></button>
      <span>{pageNumber} / {document.numPages}</span>
      <button disabled={pageNumber >= document.numPages} aria-label={copy.workspace.previewPanel.nextPage} onClick={() => setPageNumber((value) => Math.min(document.numPages, value + 1))}><ChevronRight size={14}/></button>
      <i/>
      <button aria-label={copy.workspace.previewPanel.zoomOut} disabled={zoom <= .4} onClick={() => setZoom((value) => Math.max(.4, value - .1))}><Minus size={13}/></button>
      <span>{Math.round(zoom * 100)}%</span>
      <button aria-label={copy.workspace.previewPanel.zoomIn} disabled={zoom >= 2.4} onClick={() => setZoom((value) => Math.min(2.4, value + .1))}><Plus size={13}/></button>
    </div>
    <div className="workspace-pdf-canvas"><canvas ref={canvas}/></div>
  </div>;
});

function PreviewLoading({ label }: { label: string }) {
  return <div className="workspace-preview-state"><LoaderCircle className="spin" size={20}/><span>{label}</span></div>;
}

function PreviewFailure({ message }: { message: string }) {
  return <div className="workspace-preview-state is-error"><File size={24}/><span>{message}</span></div>;
}

const ImagePreview = memo(function ImagePreview({ preview }: { preview: WorkspacePreview }) {
  const [zoom, setZoom] = useState(1);
  if (!preview.dataUrl) return <PreviewFailure message={copy.workspace.previewPanel.imageUnavailable}/>;
  return <div className="workspace-image-preview">
    <div className="workspace-preview-toolbar"><button aria-label={copy.workspace.previewPanel.zoomOut} disabled={zoom <= .2} onClick={() => setZoom((value) => Math.max(.2, value - .1))}><Minus size={13}/></button><span>{Math.round(zoom * 100)}%</span><button aria-label={copy.workspace.previewPanel.zoomIn} disabled={zoom >= 3} onClick={() => setZoom((value) => Math.min(3, value + .1))}><Plus size={13}/></button></div>
    <div className="workspace-image-canvas"><img src={preview.dataUrl} alt={preview.name} style={{ width: `${zoom * 100}%` }}/></div>
  </div>;
});

function FilePreview({ preview, onOpenSystem }: { preview: WorkspacePreview; onOpenSystem(): void }) {
  const isMarkdown = preview.mediaType === 'text/markdown' || /\.m(?:arkdown|d)$/iu.test(preview.name);
  return <div className="workspace-file-preview-surface" data-testid={`workspace-preview-${preview.kind}`}>
    <div className="workspace-preview-file-actions"><span>{preview.mediaType ?? copy.workspace.previewPanel.genericFile} · {(preview.size / 1024).toFixed(preview.size > 1024 ? 0 : 1)} KB</span><button onClick={onOpenSystem}><ExternalLink size={13}/>{copy.workspace.previewPanel.open}</button></div>
    <div className="workspace-preview-file-body">
      {preview.kind === 'image' ? <ImagePreview preview={preview}/>
        : preview.kind === 'pdf' && preview.dataUrl ? <PdfPreview dataUrl={preview.dataUrl}/>
          : preview.kind === 'word' && preview.dataUrl ? <WordPreview dataUrl={preview.dataUrl}/>
            : preview.kind === 'text' && isMarkdown ? <MarkdownPreview content={preview.content ?? ''}/>
              : preview.kind === 'text' ? <pre className="workspace-text-preview">{preview.content}</pre>
                : <PreviewFailure message={copy.workspace.previewPanel.systemOnly}/>}
    </div>
  </div>;
}

function jsonRecord(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, JsonValue> : undefined;
}

function TerminalPreview({ terminalId, onAction }: {
  terminalId: string;
  onAction(terminalId: string, input: Record<string, unknown>): Promise<JsonValue | undefined>;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<'starting' | 'running' | 'idle'>('starting');
  const [notice, setNotice] = useState<string>();
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let disposed = false;
    let pollTimer = 0;
    let readPending = false;
    let running = false;
    let afterSequence = 0;
    let resizeObserver: ResizeObserver | undefined;
    let terminal: import('@xterm/xterm').Terminal | undefined;
    let fit: import('@xterm/addon-fit').FitAddon | undefined;
    let inputDisposable: { dispose(): void } | undefined;
    const fail = (cause: unknown) => {
      if (disposed) return;
      running = false;
      setPhase('idle');
      setNotice(copy.workspace.previewPanel.terminalFailed(cause instanceof Error ? cause.message : String(cause)));
    };
    const read = async () => {
      if (!running || readPending || disposed || !terminal) return;
      readPending = true;
      try {
        const value = jsonRecord(await onAction(terminalId, { action: 'read', afterSequence }));
        const chunks = Array.isArray(value?.chunks) ? value.chunks : [];
        for (const chunk of chunks) {
          const record = jsonRecord(chunk);
          if (!record || typeof record.data !== 'string') continue;
          terminal.write(record.data);
          if (typeof record.sequence === 'number') afterSequence = Math.max(afterSequence, record.sequence);
        }
        const session = jsonRecord(value?.session);
        if (session && session.status !== 'running') {
          running = false;
          setPhase('idle');
        }
      } catch (cause) { fail(cause); }
      finally { readPending = false; }
    };
    void (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')]);
      if (disposed) return;
      terminal = new Terminal({
        allowTransparency: false,
        convertEol: false,
        cursorBlink: true,
        cursorStyle: 'bar',
        fontFamily: 'Cascadia Mono, Consolas, ui-monospace, monospace',
        fontSize: 12,
        lineHeight: 1.28,
        scrollback: 10_000,
        theme: {
          background: '#0b2421',
          foreground: '#f2f7f5',
          cursor: '#9ee4d5',
          selectionBackground: '#285f55',
          black: '#172b28',
          red: '#f07178',
          green: '#7fd7a7',
          yellow: '#f1cf87',
          blue: '#82b6ff',
          magenta: '#c7a0ef',
          cyan: '#72d5d1',
          white: '#e7efec',
          brightBlack: '#78908a',
          brightRed: '#ff9a9e',
          brightGreen: '#a2ebc1',
          brightYellow: '#ffe09a',
          brightBlue: '#a8ccff',
          brightMagenta: '#dfbdff',
          brightCyan: '#9aebe7',
          brightWhite: '#ffffff',
        },
      });
      fit = new FitAddon();
      terminal.loadAddon(fit);
      terminal.open(element);
      fit.fit();
      inputDisposable = terminal.onData((data) => {
        if (!running || disposed) return;
        void onAction(terminalId, { action: 'input', data }).catch(fail);
      });
      resizeObserver = new ResizeObserver(() => {
        if (disposed || !terminal || !fit) return;
        fit.fit();
        if (running) void onAction(terminalId, { action: 'resize', cols: terminal.cols, rows: terminal.rows }).catch(fail);
      });
      resizeObserver.observe(element);
      const opened = jsonRecord(await onAction(terminalId, { action: 'start', cols: terminal.cols, rows: terminal.rows }));
      if (disposed) return;
      const session = jsonRecord(opened?.session);
      running = opened?.status === 'opened' && session?.status === 'running';
      if (!running) {
        setPhase('idle');
        setNotice(typeof opened?.reason === 'string' ? opened.reason : copy.workspace.previewPanel.terminalUnavailable);
        return;
      }
      setPhase('running');
      setNotice(undefined);
      await read();
      pollTimer = window.setInterval(() => void read(), 160);
      terminal.focus();
    })().catch(fail);
    return () => {
      disposed = true;
      window.clearInterval(pollTimer);
      resizeObserver?.disconnect();
      inputDisposable?.dispose();
      terminal?.dispose();
    };
  }, [onAction, terminalId]);
  return <div className="workspace-terminal-preview" data-testid="workspace-terminal-preview" data-terminal-id={terminalId} data-status={phase}>
    <div ref={host} className="workspace-terminal-host" role="application" aria-label={copy.workspace.previewPanel.terminal}/>
    {phase === 'starting' && <div className="workspace-terminal-notice"><LoaderCircle className="spin" size={16}/>{copy.workspace.previewPanel.terminalStarting}</div>}
    {notice && <div className="workspace-terminal-notice is-error">{notice}</div>}
  </div>;
}

function normalizeBrowserUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === 'about:blank') return '';
  return /^https:\/\//iu.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function BrowserPreview({ session, initialUrl, active, onNavigate, onHistory, onSetBounds }: {
  session: BrowserSessionSummary | undefined;
  initialUrl: string;
  active: boolean;
  onNavigate(sessionId: string, url: string): Promise<void>;
  onHistory(sessionId: string, action: 'back' | 'forward' | 'reload'): Promise<void>;
  onSetBounds(sessionId: string, bounds: { x: number; y: number; width: number; height: number }, visible: boolean): Promise<void>;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const initialAddress = session?.url ?? initialUrl;
  const [address, setAddress] = useState(initialAddress === 'about:blank' ? '' : initialAddress);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [menuOpen, setMenuOpen] = useState(false);
  const pageOpen = Boolean(session && session.url !== 'about:blank');
  useEffect(() => { if (session?.url) setAddress(session.url === 'about:blank' ? '' : session.url); }, [session?.url]);
  useEffect(() => {
    if (!session?.id || !viewport.current) return;
    const element = viewport.current;
    let disposed = false;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (disposed) return;
        const bounds = element.getBoundingClientRect();
        void onSetBounds(session.id, { x: bounds.left, y: bounds.top, width: bounds.width, height: bounds.height }, active && pageOpen && bounds.width > 1 && bounds.height > 1);
      });
    };
    const observer = new ResizeObserver(update);
    observer.observe(element);
    window.addEventListener('resize', update);
    update();
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('resize', update);
      void onSetBounds(session.id, { x: 0, y: 42, width: 1, height: 1 }, false);
    };
  }, [active, onSetBounds, pageOpen, session?.id]);
  useEffect(() => {
    if (!menuOpen) return;
    const close = () => setMenuOpen(false);
    window.addEventListener('pointerdown', close, { once: true });
    return () => window.removeEventListener('pointerdown', close);
  }, [menuOpen]);
  const navigate = async (next = address) => {
    if (!session || busy) return;
    const url = normalizeBrowserUrl(next);
    if (!url) return;
    setBusy(true);
    setError(undefined);
    try { await onNavigate(session.id, url); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const history = async (action: 'back' | 'forward' | 'reload') => {
    if (!session || busy) return;
    setBusy(true);
    setError(undefined);
    try { await onHistory(session.id, action); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  return <div className="workspace-browser-preview" data-testid="workspace-browser-preview">
    <form className="workspace-browser-address" onSubmit={(event) => { event.preventDefault(); void navigate(); }}>
      <span className="workspace-browser-history">
        <button type="button" aria-label={copy.workspace.previewPanel.back} disabled={!session?.canGoBack || busy} onClick={() => void history('back')}><ArrowLeft size={16}/></button>
        <button type="button" aria-label={copy.workspace.previewPanel.forward} disabled={!session?.canGoForward || busy} onClick={() => void history('forward')}><ArrowRight size={16}/></button>
        <button type="button" aria-label={copy.common.refresh} disabled={!pageOpen || busy} onClick={() => void history('reload')}>{busy || session?.status === 'loading' ? <LoaderCircle className="spin" size={15}/> : <RefreshCw size={15}/>}</button>
      </span>
      <label><input aria-label={copy.workspace.previewPanel.browserAddress} value={address} onChange={(event) => setAddress(event.target.value)} placeholder={copy.workspace.previewPanel.enterUrl}/><button type="submit" aria-label={copy.workspace.previewPanel.open} disabled={!session || busy || !address.trim()}><ArrowUpRight size={16}/></button></label>
      <span className="workspace-browser-more"><button type="button" aria-label={copy.workspace.previewPanel.more} aria-expanded={menuOpen} onPointerDown={(event) => event.stopPropagation()} onClick={() => setMenuOpen((value) => !value)}><EllipsisVertical size={16}/></button>{menuOpen && <span role="menu" onPointerDown={(event) => event.stopPropagation()}>
        <button type="button" role="menuitem" disabled={!pageOpen} onClick={() => { setMenuOpen(false); if (session?.url.startsWith('https://')) void window.openlab?.openExternal(session.url); }}><ExternalLink size={13}/>{copy.workspace.previewPanel.openExternal}</button>
        <button type="button" role="menuitem" disabled={!pageOpen} onClick={() => { setMenuOpen(false); if (session?.url) void window.openlab?.writeClipboardText(session.url); }}><Copy size={13}/>{copy.workspace.previewPanel.copyAddress}</button>
      </span>}</span>
    </form>
    {error && <div className="workspace-browser-error">{error}</div>}
    <div ref={viewport} className={`workspace-browser-viewport ${pageOpen ? 'has-page' : 'is-blank'}`}>
      {!session ? <PreviewLoading label={copy.workspace.previewPanel.browserLoading}/> : !pageOpen && <div className="workspace-browser-empty"><Globe2 size={34}/><strong>{copy.workspace.previewPanel.startBrowsing}</strong><span>{copy.workspace.previewPanel.startBrowsingHint}</span></div>}
    </div>
  </div>;
}

export function WorkspacePreviewDeck(props: WorkspacePreviewDeckProps) {
  const [addOpen, setAddOpen] = useState(false);
  const active = props.tabs.find((tab) => tab.id === props.activeId) ?? props.tabs[0];
  const browserSession = active?.kind === 'browser' ? props.browserSessions.find((session) => session.id === active.sessionId) : undefined;
  const titleFor = (tab: WorkspacePreviewTab) => tab.kind === 'file'
    ? tab.preview.name
    : tab.kind === 'terminal'
      ? tab.title
      : (() => {
          const session = props.browserSessions.find((candidate) => candidate.id === tab.sessionId);
          return session?.url === 'about:blank' ? copy.workspace.previewPanel.newTab : session?.title || copy.workspace.previewPanel.browser;
        })();
  useEffect(() => {
    if (active?.kind !== 'browser') void props.onHideBrowsers();
  }, [active?.kind, props.onHideBrowsers]);
  useEffect(() => {
    if (!addOpen) return;
    const close = () => setAddOpen(false);
    window.addEventListener('pointerdown', close, { once: true });
    return () => window.removeEventListener('pointerdown', close);
  }, [addOpen]);
  const tabList = useMemo(() => props.tabs.map((tab) => ({ tab, title: titleFor(tab) })), [props.browserSessions, props.tabs]);
  if (!active) return null;
  return <section className="workspace-preview-deck" data-testid="workspace-preview-deck">
    <header className="workspace-preview-tabs">
      <div role="tablist" aria-label={copy.workspace.previewPanel.tabs}>{tabList.map(({ tab, title }) => <button key={tab.id} role="tab" aria-selected={tab.id === active.id} className={tab.id === active.id ? 'is-active' : ''} onClick={() => props.onActivate(tab.id)}>{tab.kind === 'file' ? previewIcon(tab.preview) : tab.kind === 'terminal' ? <SquareTerminal size={13}/> : <Globe2 size={13}/>}<span title={title}>{title}</span><i role="button" aria-label={copy.workspace.previewPanel.closeTab(title)} onClick={(event) => { event.stopPropagation(); props.onClose(tab.id); }}><X size={12}/></i></button>)}</div>
      <span className="workspace-preview-add"><button aria-label={copy.workspace.previewPanel.add} aria-expanded={addOpen} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); setAddOpen((value) => !value); }}><Plus size={15}/></button>{addOpen && <span role="menu" onPointerDown={(event) => event.stopPropagation()}><button role="menuitem" onClick={() => { setAddOpen(false); props.onAddFile(); }}><FileText size={14}/>{copy.workspace.previewPanel.selectFile}</button><button role="menuitem" onClick={() => { setAddOpen(false); props.onAddBrowser(); }}><Globe2 size={14}/>{copy.workspace.newBrowser}</button><button role="menuitem" onClick={() => { setAddOpen(false); props.onAddTerminal(); }}><SquareTerminal size={14}/>{copy.workspace.previewPanel.terminal}</button></span>}</span>
    </header>
    <div className="workspace-preview-content">
      {active.kind === 'file' ? <FilePreview preview={active.preview} onOpenSystem={() => props.onOpenSystem(active.preview)}/>
        : active.kind === 'terminal' ? <TerminalPreview terminalId={active.terminalId} onAction={props.onTerminalAction}/>
          : <BrowserPreview session={browserSession} initialUrl={active.initialUrl} active onNavigate={props.onNavigateBrowser} onHistory={props.onBrowserHistory} onSetBounds={props.onSetBrowserBounds}/>}
    </div>
  </section>;
}
