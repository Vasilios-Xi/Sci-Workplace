import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  Bot, Check, CheckSquare, ChevronDown, ChevronRight, CircleAlert, Clock3, Code2, Copy, Download, FileOutput,
  Diamond, FolderOpen, FolderPlus, GitBranch, GitCompareArrows, ImageDown, Lightbulb, LoaderCircle, MessageSquareQuote, Pause, Pencil, Play, RefreshCw,
  ShieldCheck, Sparkles, Square, UserRound, X,
} from 'lucide-react';
import { toPng } from 'html-to-image';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeSanitize from 'rehype-sanitize';
import rehypeKatex from 'rehype-katex';
import type { AgentDefinition, AgentRun, AgentTask, ApprovalRequest, PrimaryAgentAvatar, PrimaryAgentProfile, TimelineNode, TurnVariantGroup } from '@openlab/protocol';
import 'katex/dist/katex.min.css';
import { hanaZhCN as copy } from '../i18n/zh-CN.js';
import { formatClockTime } from '../lib/date-time.js';
import { useFloatingPosition } from '../lib/floating-position.js';
import { assistantIdentityNodeIds, toolNodeBatches } from '../lib/timeline-grouping.js';
import { AgentAvatar } from './AgentAvatar.js';
import { promptInApp } from './AppDialog.js';
import { SemanticIcon, SemanticStatus, semanticRoleForStatus } from './SemanticVisual.js';

interface TimelineProps {
  nodes: TimelineNode[];
  approvals: ApprovalRequest[];
  variants: TurnVariantGroup[];
  agents: AgentRun[];
  tasks: AgentTask[];
  agentDefinitions: AgentDefinition[];
  primaryAgent: PrimaryAgentProfile;
  timeZone: string;
  sessionKey?: string;
  emptyProjectName?: string | undefined;
  emptyProjectPath?: string | undefined;
  projectOptions?: Array<{ rootPath: string; name: string }> | undefined;
  onChooseProject?: (() => void) | undefined;
  onSelectProject?: ((rootPath: string) => void) | undefined;
  onClearProject?: (() => void) | undefined;
  emptyAgent?: { id: string; name: string; avatar: PrimaryAgentAvatar; memoryEnabled: boolean } | undefined;
  emptyAgentOptions?: Array<{ id: string; name: string; avatar: PrimaryAgentAvatar }> | undefined;
  onChooseAgent?: ((id: string) => void) | undefined;
  onToggleMemory?: ((enabled: boolean) => Promise<void>) | undefined;
  onApprove(id: string, approved: boolean): void;
  onRegenerate(turnId: string): Promise<void>;
  onFork(nodeId: string): Promise<void>;
  onEdit(nodeId: string, content: string): void;
  onQuote(nodeIds: string[]): void;
  onActivateVariant(turnId: string, variantId: string): Promise<unknown>;
  onAgentAction(id: string, action: 'pause' | 'resume' | 'cancel' | 'takeover'): Promise<void>;
  onAgentMessage(id: string, content: string): Promise<void>;
}

const statusLabels: Record<string, string> = copy.timeline.statuses;
const timelineScrollPositions = new Map<string, number>();

const Markdown = memo(function Markdown({ children }: { children: string }) {
  return <ReactMarkdown
    remarkPlugins={[remarkGfm, remarkMath]}
    rehypePlugins={[rehypeSanitize, rehypeKatex]}
    urlTransform={(url) => /^https:\/\//u.test(url) ? url : ''}
    components={{
      a: ({ href, children: label }) => <a href={href} onClick={(event) => { event.preventDefault(); if (href?.startsWith('https://')) void window.openlab?.openExternal(href); }}>{label}</a>,
      img: ({ alt }) => <span className="markdown-image-placeholder">{copy.timeline.image(alt ?? '')}</span>,
      input: ({ checked }) => <input type="checkbox" checked={checked} readOnly/>,
    }}
  >{children}</ReactMarkdown>;
});

const AssistantBody = memo(function AssistantBody({ content, streaming }: { content: string; streaming: boolean }) {
  if (streaming) return content
    ? <div className="streaming-text" aria-live="polite">{content}</div>
    : <GenerationDots label={copy.timeline.generating} testId="answer-generation-dots"/>;
  return content ? <Markdown>{content}</Markdown> : null;
});

function GenerationDots({ label, testId }: { label: string; testId: string }) {
  return <span className="generation-dots" data-testid={testId} role="status" aria-label={label}><i/><i/><i/></span>;
}

function NodeIcon({ node }: { node: TimelineNode }) {
  if (node.kind === 'user') return <UserRound size={14}/>;
  if (node.kind === 'reasoning') return <Lightbulb size={14}/>;
  if (node.kind === 'tool') return node.metadata.renderHint === 'diff' ? <GitCompareArrows size={14}/> : <Code2 size={14}/>;
  if (node.kind === 'approval') return <ShieldCheck size={14}/>;
  if (node.kind === 'agent') return <Bot size={14}/>;
  if (node.kind === 'artifact') return <FileOutput size={14}/>;
  return <Sparkles size={14}/>;
}

function Status({ value }: { value: string | undefined }) {
  if (!value) return null;
  return <SemanticStatus role={semanticRoleForStatus(value)} className={`node-status ${value}`}>{value === 'streaming' || value === 'running' ? <LoaderCircle className="spin" size={11}/> : value === 'failed' ? <CircleAlert size={11}/> : value === 'completed' ? <Check size={11}/> : <Clock3 size={11}/>} {statusLabels[value] ?? value}</SemanticStatus>;
}

const ApprovalCard = memo(function ApprovalCard({ node, approval, onApprove }: { node: TimelineNode; approval: ApprovalRequest | undefined; onApprove(id: string, approved: boolean): void }) {
  const id = approval?.id ?? (typeof node.metadata.approvalId === 'string' ? node.metadata.approvalId : undefined);
  const preview = typeof node.metadata.preview === 'string' ? node.metadata.preview : undefined;
  return <article className="compact-event-card approval-card" data-node-id={node.id}>
    <header><SemanticIcon role="warning" className="compact-card-icon approval"><ShieldCheck size={14}/></SemanticIcon><div><strong>{node.title}</strong><small>{node.content}</small></div><Status value={node.status}/></header>
    {preview && <details open={node.status === 'pending'}><summary>{copy.timeline.viewRequestDiff} <ChevronRight size={12}/></summary><pre>{preview}</pre></details>}
    {node.status === 'pending' && id && <footer><button data-testid="deny-approval" onClick={() => onApprove(id, false)}><X size={13}/>{copy.timeline.deny}</button><button data-testid="approve-tool" className="primary" onClick={() => onApprove(id, true)}><Check size={13}/>{copy.timeline.approveContinue}</button></footer>}
  </article>;
});

const CompactCard = memo(function CompactCard({ node }: { node: TimelineNode }) {
  const isDiff = node.metadata.renderHint === 'diff';
  return <article className={`compact-event-card ${node.kind} ${isDiff ? 'is-diff' : ''}`} data-node-id={node.id}>
    <header><SemanticIcon role={node.kind === 'artifact' ? 'accent' : 'info'} className={`compact-card-icon ${node.kind}`}><NodeIcon node={node}/></SemanticIcon><div><strong>{node.title}</strong><small>{node.kind === 'artifact' ? copy.timeline.researchArtifact : typeof node.metadata.toolName === 'string' ? node.metadata.toolName : copy.timeline.executionDetails}</small></div><Status value={node.status}/></header>
    {node.content && <details open={node.status === 'running' || node.status === 'failed'}><summary>{copy.timeline.viewDetails} <ChevronRight size={12}/></summary><pre>{node.content}</pre></details>}
  </article>;
});

function ToolStatusGlyph({ value }: { value: string | undefined }) {
  const label = value ? statusLabels[value] ?? value : copy.timeline.executionDetails;
  const icon = value === 'running' || value === 'proposed' || value === 'waiting'
    ? <LoaderCircle className="spin" size={12}/>
    : value === 'failed' || value === 'denied'
      ? <CircleAlert size={12}/>
      : value === 'completed'
        ? <Check size={12}/>
        : <Clock3 size={12}/>;
  return <span className={`tool-batch__status ${value ?? 'unknown'}`} role="status" aria-label={label} title={label}>{icon}</span>;
}

const ToolBatchRow = memo(function ToolBatchRow({ node }: { node: TimelineNode }) {
  const failed = node.status === 'failed' || node.status === 'denied';
  const [open, setOpen] = useState(failed);
  useEffect(() => { if (failed) setOpen(true); }, [failed]);
  const toolName = typeof node.metadata.toolName === 'string' ? node.metadata.toolName : copy.timeline.executionDetails;
  return <details className={`tool-batch__item ${failed ? 'is-failed' : ''}`} data-node-id={node.id} open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary title={`${node.title ?? toolName} · ${toolName}`}>
      <span className="tool-batch__icon"><NodeIcon node={node}/></span>
      <span className="tool-batch__copy"><strong>{node.title ?? toolName}</strong><small>{toolName}</small></span>
      {node.content && <ChevronRight className="tool-batch__detail-chevron" size={12}/>}<ToolStatusGlyph value={node.status}/>
    </summary>
    {node.content && <pre>{node.content}</pre>}
  </details>;
});

const ToolBatch = memo(function ToolBatch({ nodes }: { nodes: TimelineNode[] }) {
  const failed = nodes.some((node) => node.status === 'failed' || node.status === 'denied');
  const busy = nodes.some((node) => ['proposed', 'running', 'waiting'].includes(node.status ?? ''));
  const aggregateStatus = failed ? 'failed' : busy ? 'running' : nodes.every((node) => node.status === 'completed') ? 'completed' : undefined;
  const [open, setOpen] = useState(failed);
  useEffect(() => { if (failed) setOpen(true); }, [failed]);
  if (nodes.length === 1) return <div className="tool-batch tool-batch--single" data-testid="tool-batch"><ToolBatchRow node={nodes[0]!}/></div>;
  return <details className="tool-batch" data-testid="tool-batch" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary><span>{copy.timeline.toolCount(nodes.length)}</span>{aggregateStatus !== 'completed' && <ToolStatusGlyph value={aggregateStatus}/>}<ChevronRight className="tool-batch__chevron" size={13}/></summary>
    <div className="tool-batch__items">{nodes.map((node) => <ToolBatchRow key={node.id} node={node}/>)}</div>
  </details>;
});

const AgentCard = memo(function AgentCard({ node, agent, task, onAction, onMessage }: {
  node: TimelineNode; agent: AgentRun | undefined; task: AgentTask | undefined;
  onAction(id: string, action: 'pause' | 'resume' | 'cancel' | 'takeover'): Promise<void>;
  onMessage(id: string, content: string): Promise<void>;
}) {
  const id = node.agentId;
  return <article className="compact-event-card agent-card" data-node-id={node.id}>
    <header><SemanticIcon role="info" className="compact-card-icon agent"><Bot size={14}/></SemanticIcon><div><strong>{node.title ?? agent?.name ?? copy.timeline.executor}</strong><small>{task?.title ?? node.content}</small></div><Status value={agent?.status ?? node.status}/></header>
    {node.content && <details><summary>{copy.timeline.executorReport} <ChevronRight size={12}/></summary><div className="agent-report"><Markdown>{node.content}</Markdown></div></details>}
    {id && <footer className="agent-card__actions">
      {agent?.status === 'paused' ? <button onClick={() => void onAction(id, 'resume')}><Play size={12}/>{copy.timeline.resume}</button> : ['running', 'queued'].includes(agent?.status ?? '') && <button onClick={() => void onAction(id, 'pause')}><Pause size={12}/>{copy.timeline.pause}</button>}
      <button onClick={() => void promptInApp(copy.timeline.askExecutor, '', { title: copy.timeline.ask }).then((value) => { const content = value?.trim(); if (content) return onMessage(id, content); })}><MessageSquareQuote size={12}/>{copy.timeline.ask}</button>
      <button onClick={() => void onAction(id, 'takeover')}><UserRound size={12}/>{copy.timeline.takeover}</button>
      <button onClick={() => void onAction(id, 'cancel')}><Square size={11}/>{copy.timeline.cancel}</button>
    </footer>}
  </article>;
});

const Reasoning = memo(function Reasoning({ node }: { node: TimelineNode }) {
  const streaming = node.status === 'streaming';
  const [open, setOpen] = useState(streaming);
  const wasStreaming = useRef(streaming);
  useEffect(() => {
    if (streaming && !wasStreaming.current) setOpen(true);
    wasStreaming.current = streaming;
  }, [streaming]);
  if (!streaming && node.status === 'empty' && node.metadata.thinking === 'disabled' && !node.content.trim()) return null;
  return <details className={`reasoning-block ${streaming ? 'is-streaming' : ''}`} data-node-id={node.id} open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>
      <ChevronRight className="reasoning-block__chevron" size={12}/>
      <span>{streaming ? copy.timeline.thinking : copy.timeline.thoughtComplete}</span>
      {streaming && <GenerationDots label={copy.timeline.thinking} testId="reasoning-generation-dots"/>}
    </summary>
    {(node.content || !streaming) && <div>{node.content || copy.timeline.reasoningUnavailable}</div>}
  </details>;
});

async function saveElementAsPng(element: HTMLElement, name: string) {
  const background = getComputedStyle(document.documentElement).getPropertyValue('--conversation-bg').trim() || '#fbfcf8';
  const dataUrl = await toPng(element, { cacheBust: false, pixelRatio: 2, skipFonts: true, backgroundColor: background });
  await window.openlab?.saveMessagePng(dataUrl, name);
}

function DraftAgentPicker({ agent, options, onChange }: {
  agent: NonNullable<TimelineProps['emptyAgent']>;
  options: NonNullable<TimelineProps['emptyAgentOptions']>;
  onChange?: TimelineProps['onChooseAgent'];
}) {
  const choices = options.length ? options : [{ id: agent.id, name: agent.name, avatar: agent.avatar }];
  return <div className="hana-draft-agent-picker" data-testid="draft-agent-selector" role="radiogroup" aria-label={copy.timeline.chooseAgent}>
    {choices.map((option) => <button key={option.id} className={`hana-draft-agent ${option.id === agent.id ? 'is-active' : ''}`} type="button" data-testid="draft-agent-option" role="radio" aria-checked={option.id === agent.id} title={option.name} disabled={!onChange} onClick={() => onChange?.(option.id)}><AgentAvatar avatar={option.avatar} size="tiny"/><span className="hana-draft-agent__name">{option.name}</span></button>)}
  </div>;
}

function DraftProjectPicker({ name, rootPath, projects, onCreate, onSelect, onClear }: {
  name: string;
  rootPath?: string | undefined;
  projects: Array<{ rootPath: string; name: string }>;
  onCreate: () => void;
  onSelect?: ((rootPath: string) => void) | undefined;
  onClear?: (() => void) | undefined;
}) {
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const menuStyle = useFloatingPosition({ open, anchorRef: trigger, surfaceRef: menu, placement: 'bottom-center', offset: 4 });

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!container.current?.contains(target) && !menu.current?.contains(target)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('pointerdown', closeOutside);
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      window.removeEventListener('pointerdown', closeOutside);
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  const currentKey = rootPath?.toLocaleLowerCase();
  const menuSurface = open && createPortal(<div ref={menu} className="hana-draft-project-menu" style={menuStyle} data-testid="draft-project-menu" role="menu" aria-label={copy.timeline.chooseProject}>
    <button type="button" className="hana-draft-project-menu__create" data-testid="draft-project-create" role="menuitem" onClick={() => { setOpen(false); onCreate(); }}><FolderPlus size={15}/><span>{copy.timeline.newProject}</span></button>
    <button type="button" className={`hana-draft-project-menu__detached ${!rootPath ? 'is-active' : ''}`} data-testid="draft-project-detached" role="menuitemradio" aria-checked={!rootPath} onClick={() => { setOpen(false); onClear?.(); }}><FolderOpen size={15}/><span>{copy.timeline.noProject}</span>{!rootPath && <Check size={13}/>}</button>
    {projects.length > 0 && <div className="hana-draft-project-menu__existing">
      <small>{copy.timeline.existingProjects}</small>
      {projects.map((project) => {
        const active = project.rootPath.toLocaleLowerCase() === currentKey;
        return <button key={project.rootPath} type="button" className={active ? 'is-active' : ''} data-testid="draft-project-option" role="menuitemradio" aria-checked={active} title={project.rootPath} onClick={() => { setOpen(false); onSelect?.(project.rootPath); }}><FolderOpen size={15}/><span><strong>{project.name}</strong><small>{project.rootPath}</small></span>{active && <Check size={13}/>}</button>;
      })}
    </div>}
  </div>, document.body);
  return <div className="hana-draft-project-picker" ref={container}>
    <button
      ref={trigger}
      type="button"
      className={`empty-timeline__project ${rootPath ? '' : 'is-empty'}`}
      data-testid="draft-project-selector"
      aria-haspopup="menu"
      aria-expanded={open}
      onClick={() => setOpen((value) => !value)}
    ><FolderOpen size={14}/><span>{rootPath ? name : copy.timeline.noProject}</span><ChevronDown size={13}/></button>
    {menuSurface}
  </div>;
}

export function Timeline(props: TimelineProps) {
  const scroll = useRef<HTMLDivElement>(null);
  const scrollFrame = useRef(0);
  const nodeElements = useRef(new Map<string, HTMLElement>());
  const locator = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);
  const [multi, setMulti] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [locatorOpen, setLocatorOpen] = useState(false);
  const [locatedNodeId, setLocatedNodeId] = useState<string>();
  const [hoveredLocatorNodeId, setHoveredLocatorNodeId] = useState<string>();
  const [memoryUpdating, setMemoryUpdating] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const approvalMap = useMemo(() => new Map(props.approvals.map((approval) => [approval.id, approval])), [props.approvals]);
  const agentDefinitionMap = useMemo(() => new Map(props.agentDefinitions.map((agent) => [agent.id, agent])), [props.agentDefinitions]);
  const activeVariants = useMemo(() => new Map(props.variants.map((group) => [group.turnId, group.activeVariantId])), [props.variants]);
  const visibleNodes = useMemo(() => props.nodes.filter((node) => {
    if (node.kind === 'assistant' && node.status !== 'streaming' && !node.content.trim()) return false;
    if (node.kind === 'reasoning' && node.metadata.thinking === 'disabled' && !node.content.trim()) return false;
    const turnId = typeof node.metadata.turnId === 'string' ? node.metadata.turnId : undefined;
    const variantId = typeof node.metadata.variantId === 'string' ? node.metadata.variantId : undefined;
    return !turnId || !variantId || activeVariants.get(turnId) === variantId;
  }), [activeVariants, props.nodes]);
  const conversationOutline = useMemo(() => visibleNodes.filter((node) => node.kind === 'user'), [visibleNodes]);
  const identityNodeIds = useMemo(() => assistantIdentityNodeIds(visibleNodes), [visibleNodes]);
  const toolBatchState = useMemo(() => {
    const starts = new Map<string, TimelineNode[]>();
    const continuations = new Set<string>();
    for (const batch of toolNodeBatches(visibleNodes)) {
      const first = batch[0];
      if (!first) continue;
      starts.set(first.id, batch);
      for (const node of batch.slice(1)) continuations.add(node.id);
    }
    return { starts, continuations };
  }, [visibleNodes]);

  const updateLocatedNode = (container: HTMLDivElement) => {
    if (!conversationOutline.length) {
      setLocatedNodeId(undefined);
      return;
    }
    const threshold = container.getBoundingClientRect().top + Math.min(container.clientHeight * .3, 220);
    let current = conversationOutline[0]?.id;
    for (const node of conversationOutline) {
      const element = nodeElements.current.get(node.id);
      if (element && element.getBoundingClientRect().top <= threshold) current = node.id;
      else if (element) break;
    }
    setLocatedNodeId((previous) => previous === current ? previous : current);
  };

  useEffect(() => {
    const target = scroll.current;
    const key = props.sessionKey;
    if (!target || !key) return;
    const frame = window.requestAnimationFrame(() => {
      const restored = timelineScrollPositions.get(key);
      target.scrollTop = restored ?? target.scrollHeight;
      setFollow(restored === undefined || target.scrollHeight - target.scrollTop - target.clientHeight < 160);
      updateLocatedNode(target);
    });
    return () => {
      window.cancelAnimationFrame(frame);
      timelineScrollPositions.set(key, target.scrollTop);
    };
  }, [props.sessionKey]);

  useEffect(() => {
    setLocatorOpen(false);
    setHoveredLocatorNodeId(undefined);
    const target = scroll.current;
    const frame = window.requestAnimationFrame(() => {
      if (target) updateLocatedNode(target);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [props.sessionKey, conversationOutline.length]);

  useEffect(() => {
    if (!locatorOpen) return;
    const closeOutside = (event: PointerEvent) => {
      if (!locator.current?.contains(event.target as Node)) {
        setLocatorOpen(false);
        setHoveredLocatorNodeId(undefined);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setLocatorOpen(false);
        setHoveredLocatorNodeId(undefined);
      }
    };
    window.addEventListener('pointerdown', closeOutside);
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      window.removeEventListener('pointerdown', closeOutside);
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [locatorOpen]);

  useEffect(() => {
    if (!follow) return;
    const target = scroll.current;
    window.cancelAnimationFrame(scrollFrame.current);
    if (target) scrollFrame.current = window.requestAnimationFrame(() => target.scrollTo({ top: target.scrollHeight, behavior: 'instant' }));
    return () => window.cancelAnimationFrame(scrollFrame.current);
  }, [follow, visibleNodes.length, visibleNodes.at(-1)?.content]);

  const safe = async (action: () => Promise<void>) => {
    setActionError(undefined);
    try { await action(); } catch (cause) { setActionError(cause instanceof Error ? cause.message : String(cause)); }
  };

  const copyNodes = async (ids: string[]) => {
    const content = props.nodes.filter((node) => ids.includes(node.id)).map((node) => node.content).join('\n\n---\n\n');
    if (window.openlab?.writeClipboardText) await window.openlab.writeClipboardText(content);
    else await navigator.clipboard.writeText(content);
  };

  const exportNodes = async (ids: string[]) => {
    const container = document.createElement('div');
    container.className = 'message-export-sheet';
    container.style.position = 'fixed'; container.style.left = '-20000px'; container.style.top = '0'; container.style.width = '820px';
    for (const id of ids) { const element = nodeElements.current.get(id); if (element) container.append(element.cloneNode(true)); }
    document.body.append(container);
    try { await saveElementAsPng(container, ids.length === 1 ? `openlab-message-${ids[0]?.slice(0, 8)}` : `openlab-messages-${ids.length}`); }
    finally { container.remove(); }
  };

  const messageActions = (node: TimelineNode) => {
    const turnId = typeof node.metadata.turnId === 'string' ? node.metadata.turnId : undefined;
    const group = turnId ? props.variants.find((item) => item.turnId === turnId) : undefined;
    const activeVariant = group?.variants.find((variant) => variant.id === group.activeVariantId);
    const finalAnswer = activeVariant?.assistantNodeIds.at(-1) === node.id;
    return <div className="message-actions" aria-label={copy.timeline.messageActions}>
      <span>{formatClockTime(node.timestamp, props.timeZone)}</span>
      <button title={copy.timeline.regenerate} disabled={!turnId || !finalAnswer || group?.locked || node.status !== 'completed'} onClick={() => turnId && void safe(() => props.onRegenerate(turnId))}><RefreshCw size={13}/></button>
      <button title={copy.timeline.forkHere} disabled={node.status === 'streaming'} onClick={() => void safe(() => props.onFork(node.id))}><GitBranch size={13}/></button>
      <button title={copy.timeline.copyMarkdown} onClick={() => void safe(() => copyNodes([node.id]))}><Copy size={13}/></button>
      <button title={copy.timeline.savePng} onClick={() => { const element = nodeElements.current.get(node.id); if (element) void safe(() => saveElementAsPng(element, `openlab-message-${node.id.slice(0, 8)}`).then(() => undefined)); }}><ImageDown size={13}/></button>
      <button title={copy.timeline.quoteComposer} onClick={() => props.onQuote([node.id])}><MessageSquareQuote size={13}/></button>
      <button title={copy.timeline.multiSelect} className={multi ? 'is-active' : ''} onClick={() => { setMulti(true); setSelected(new Set([node.id])); }}><CheckSquare size={13}/></button>
    </div>;
  };

  const userMessageActions = (node: TimelineNode) => {
    const turnId = typeof node.metadata.turnId === 'string' ? node.metadata.turnId : undefined;
    const group = turnId ? props.variants.find((item) => item.turnId === turnId) : undefined;
    const activeVariant = group?.variants.find((variant) => variant.id === group.activeVariantId);
    const canRegenerate = Boolean(turnId && group && !group.locked && activeVariant?.status === 'completed');
    return <footer className="user-message__meta" data-testid="user-message-actions" aria-label={copy.timeline.messageActions}>
      <span className="user-message__time">{formatClockTime(node.timestamp, props.timeZone)}</span>
      <div className="user-message__actions">
        <button type="button" data-testid="user-message-copy" title={copy.common.copy} aria-label={copy.common.copy} onClick={() => void safe(() => copyNodes([node.id]))}><Copy size={13}/></button>
        <button type="button" data-testid="user-message-edit" title={copy.timeline.editMessage} aria-label={copy.timeline.editMessage} onClick={() => props.onEdit(node.id, node.content)}><Pencil size={13}/></button>
        <button type="button" data-testid="user-message-regenerate" title={copy.timeline.regenerate} aria-label={copy.timeline.regenerate} disabled={!canRegenerate} onClick={() => turnId && void safe(() => props.onRegenerate(turnId))}><RefreshCw size={13}/></button>
      </div>
    </footer>;
  };

  const variantSelector = (node: TimelineNode) => {
    const turnId = typeof node.metadata.turnId === 'string' ? node.metadata.turnId : undefined;
    const group = turnId ? props.variants.find((item) => item.turnId === turnId) : undefined;
    const active = group?.variants.find((variant) => variant.id === group.activeVariantId);
    if (!group || group.variants.length < 2 || active?.assistantNodeIds.at(-1) !== node.id) return null;
    const index = group.variants.findIndex((variant) => variant.id === group.activeVariantId);
    return <div className="variant-selector"><button className="previous" disabled={group.locked || index <= 0} onClick={() => { const target = group.variants[index - 1]; if (target) void safe(() => props.onActivateVariant(group.turnId, target.id).then(() => undefined)); }}><ChevronRight size={12}/></button><span>{index + 1} / {group.variants.length}{group.locked ? ` · ${copy.timeline.locked}` : ''}</span><button disabled={group.locked || index >= group.variants.length - 1} onClick={() => { const target = group.variants[index + 1]; if (target) void safe(() => props.onActivateVariant(group.turnId, target.id).then(() => undefined)); }}><ChevronRight size={12}/></button></div>;
  };

  const jumpToNode = (nodeId: string) => {
    const container = scroll.current;
    const element = nodeElements.current.get(nodeId);
    if (!container || !element) return;
    const top = container.scrollTop + element.getBoundingClientRect().top - container.getBoundingClientRect().top - 18;
    container.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    if (props.sessionKey) timelineScrollPositions.set(props.sessionKey, Math.max(0, top));
    setLocatedNodeId(nodeId);
    setFollow(false);
  };

  const locatorPreview = (content: string) => {
    const normalized = content.replace(/\s+/gu, ' ').trim() || copy.timeline.emptyMessage;
    return normalized.length > 28 ? `${normalized.slice(0, 28)}…` : normalized;
  };

  return <div className="timeline-region">
    <div className="timeline-scroll" ref={scroll} onScroll={(event) => {
      const element = event.currentTarget;
      if (props.sessionKey) timelineScrollPositions.set(props.sessionKey, element.scrollTop);
      setFollow(element.scrollHeight - element.scrollTop - element.clientHeight < 160);
      updateLocatedNode(element);
    }}>
      <div className="timeline">
      {visibleNodes.length === 0 && (props.emptyAgent ? <div className="empty-timeline hana-draft-hero" data-testid="hana-draft-hero">
        <AgentAvatar avatar={props.emptyAgent.avatar} size="large"/>
        <h2>{copy.timeline.draftGreeting(props.emptyAgent.name)}</h2>
        <DraftAgentPicker agent={props.emptyAgent} options={props.emptyAgentOptions ?? []} onChange={props.onChooseAgent}/>
        {props.onChooseProject && <DraftProjectPicker name={props.emptyProjectName ?? copy.timeline.noProject} rootPath={props.emptyProjectPath} projects={props.projectOptions ?? []} onCreate={props.onChooseProject} onSelect={props.onSelectProject} onClear={props.onClearProject}/>}
        <button
          type="button"
          className={`hana-draft-memory ${props.emptyAgent.memoryEnabled ? 'is-enabled' : 'is-disabled'}`}
          data-testid="draft-memory-status"
          aria-pressed={props.emptyAgent.memoryEnabled}
          aria-busy={memoryUpdating}
          title={copy.timeline.memoryToggleHint(props.emptyAgent.name)}
          disabled={!props.onToggleMemory || memoryUpdating}
          onClick={() => void safe(async () => {
            setMemoryUpdating(true);
            try { await props.onToggleMemory?.(!props.emptyAgent!.memoryEnabled); }
            finally { setMemoryUpdating(false); }
          })}
        ><Diamond size={12}/>{props.emptyAgent.memoryEnabled ? copy.timeline.memoryEnabled : copy.timeline.memoryDisabled}</button>
      </div> : <div className="empty-timeline"><span><Sparkles size={23}/></span><h2>{copy.timeline.emptyTitle}</h2><p>{copy.timeline.emptyDescription}</p>{props.emptyProjectName && props.onChooseProject && <button className="empty-timeline__project" data-testid="draft-project-selector" onClick={props.onChooseProject}><FolderOpen size={15}/><span>{copy.timeline.chooseProject}</span><strong>{props.emptyProjectName}</strong><RefreshCw size={13}/></button>}</div>)}
      {visibleNodes.map((node, nodeIndex) => {
        if (node.kind === 'tool' && toolBatchState.continuations.has(node.id)) return null;
        const nodeAgent = node.agentId ? agentDefinitionMap.get(node.agentId) : undefined;
        const selectable = node.kind === 'user' || node.kind === 'assistant';
        const selectedNow = selected.has(node.id);
        const previousNode = visibleNodes[nodeIndex - 1];
        const identityNode = identityNodeIds.has(node.id);
        const pairedReasoning = node.kind === 'assistant'
          && previousNode?.kind === 'reasoning'
          && previousNode.metadata.traceId === node.metadata.traceId;
        let content: ReactNode;
        if (node.kind === 'user') content = <article className="user-message" data-node-id={node.id}>
          <div className="user-message__bubble">{node.content}</div>
          {userMessageActions(node)}
        </article>;
        else if (node.kind === 'reasoning') content = <article className={`assistant-message assistant-message--reasoning ${identityNode ? '' : 'is-turn-continuation'}`} data-node-id={node.id}>
          {identityNode && <header><AgentAvatar avatar={nodeAgent?.avatar ?? props.primaryAgent.avatar} size="tiny"/><div><strong>{node.title?.split(' · ')[0] || nodeAgent?.name || props.primaryAgent.name || copy.common.supervisor}</strong></div>{!['streaming', 'completed', 'empty'].includes(node.status ?? '') && <Status value={node.status}/>}</header>}
          <Reasoning node={node}/>
        </article>;
        else if (node.kind === 'approval') { const id = typeof node.metadata.approvalId === 'string' ? node.metadata.approvalId : ''; content = <ApprovalCard node={node} approval={approvalMap.get(id)} onApprove={props.onApprove}/>; }
        else if (node.kind === 'tool') content = <ToolBatch nodes={toolBatchState.starts.get(node.id) ?? [node]}/>;
        else if (node.kind === 'artifact') content = <CompactCard node={node}/>;
        else if (node.kind === 'agent') { const runId = typeof node.metadata.runId === 'string' ? node.metadata.runId : undefined; const agent = props.agents.find((item) => item.id === runId || item.definitionId === node.agentId); const taskId = typeof node.metadata.taskId === 'string' ? node.metadata.taskId : agent?.currentTaskId; content = <AgentCard node={node} agent={agent} task={props.tasks.find((task) => task.id === taskId)} onAction={props.onAgentAction} onMessage={props.onAgentMessage}/>; }
        else if (node.kind === 'notice') content = <div className={`timeline-notice ${node.status ?? ''}`} data-node-id={node.id}><NodeIcon node={node}/><span><strong>{node.title}</strong>{node.content}</span></div>;
        else content = <article className={`assistant-message ${pairedReasoning ? 'is-reasoning-continuation' : ''} ${identityNode ? '' : 'is-turn-continuation'}`} data-node-id={node.id}>
          {identityNode && <header><AgentAvatar avatar={nodeAgent?.avatar ?? props.primaryAgent.avatar} size="tiny"/><div><strong>{node.title ?? nodeAgent?.name ?? props.primaryAgent.name ?? copy.common.supervisor}</strong></div>{!['streaming', 'completed'].includes(node.status ?? '') && <Status value={node.status}/>}</header>}
          {(node.content || identityNode) && <div className="message-content"><AssistantBody content={node.content} streaming={node.status === 'streaming'}/></div>}
          {variantSelector(node)}{messageActions(node)}
        </article>;
        return <div key={node.id} ref={(element) => { if (element) nodeElements.current.set(node.id, element); else nodeElements.current.delete(node.id); }} className={`timeline-node-wrap ${selectedNow ? 'is-selected' : ''} ${pairedReasoning ? 'is-assistant-continuation' : ''}`}>{multi && selectable && <button className={`message-select ${selectedNow ? 'is-selected' : ''}`} onClick={() => setSelected((current) => { const next = new Set(current); if (next.has(node.id)) next.delete(node.id); else next.add(node.id); return next; })}>{selectedNow ? <Check size={12}/> : null}</button>}{content}</div>;
      })}
      </div>
      {!follow && <button className="scroll-to-bottom" onClick={() => { setFollow(true); scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: 'smooth' }); }}><ChevronDown size={16}/></button>}
      {multi && <div className="multi-select-toolbar"><strong>{copy.timeline.selected(selected.size)}</strong><button disabled={!selected.size} onClick={() => void safe(() => copyNodes([...selected]))}><Copy size={13}/>{copy.common.copy}</button><button disabled={!selected.size} onClick={() => props.onQuote([...selected])}><MessageSquareQuote size={13}/>{copy.common.quote}</button><button disabled={!selected.size} onClick={() => void safe(() => exportNodes([...selected]))}><Download size={13}/>{copy.timeline.exportImage}</button><button onClick={() => { setMulti(false); setSelected(new Set()); }}><X size={13}/>{copy.timeline.exit}</button></div>}
      {actionError && <div className="timeline-action-error"><CircleAlert size={13}/>{actionError}<button onClick={() => setActionError(undefined)}><X size={12}/></button></div>}
    </div>
    {conversationOutline.length > 1 && <div
      className={`conversation-locator ${locatorOpen ? 'is-open' : ''}`}
      data-testid="conversation-locator"
      ref={locator}
      onPointerEnter={() => setLocatorOpen(true)}
      onPointerLeave={() => {
        setLocatorOpen(false);
        setHoveredLocatorNodeId(undefined);
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setLocatorOpen(false);
          setHoveredLocatorNodeId(undefined);
        }
      }}
    >
      <div
        className="conversation-locator__rail"
        data-testid="conversation-locator-trigger"
        data-state={locatorOpen ? 'open' : 'closed'}
        role="toolbar"
        aria-label={copy.timeline.conversationLocator}
        aria-orientation="vertical"
      >{conversationOutline.map((node, index) => {
        const preview = locatorPreview(node.content);
        const highlighted = node.id === (hoveredLocatorNodeId ?? locatedNodeId);
        return <button
          key={node.id}
          type="button"
          className={highlighted ? 'is-active' : ''}
          data-testid="conversation-locator-tick"
          aria-label={copy.timeline.jumpToMessage(index + 1, preview)}
          title={preview}
          onPointerEnter={() => setHoveredLocatorNodeId(node.id)}
          onFocus={() => {
            setLocatorOpen(true);
            setHoveredLocatorNodeId(node.id);
          }}
          onClick={() => jumpToNode(node.id)}
        ><i/></button>;
      })}</div>
      <nav className="conversation-locator__panel" aria-label={copy.timeline.conversationLocator} aria-hidden={!locatorOpen} inert={!locatorOpen ? true : undefined}>
        {conversationOutline.map((node, index) => {
          const preview = locatorPreview(node.content);
          const current = node.id === locatedNodeId;
          const highlighted = node.id === (hoveredLocatorNodeId ?? locatedNodeId);
          return <button
            key={node.id}
            type="button"
            className={highlighted ? 'is-active' : ''}
            data-testid="conversation-locator-item"
            aria-current={current ? 'location' : undefined}
            aria-label={copy.timeline.jumpToMessage(index + 1, preview)}
            onPointerEnter={() => setHoveredLocatorNodeId(node.id)}
            onFocus={() => setHoveredLocatorNodeId(node.id)}
            onClick={() => jumpToNode(node.id)}
          ><span>{preview}</span><i/></button>;
        })}
      </nav>
    </div>}
  </div>;
}
