import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Bot, Check, CheckSquare, ChevronDown, ChevronRight, CircleAlert, Clock3, Code2, Copy, Download, FileOutput,
  Diamond, FolderOpen, FolderPlus, GitBranch, GitCompareArrows, ImageDown, Lightbulb, LoaderCircle, MessageSquareQuote, Pause, Play, RefreshCw,
  ShieldCheck, Sparkles, Square, UserRound, X,
} from 'lucide-react';
import { toPng } from 'html-to-image';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeSanitize from 'rehype-sanitize';
import rehypeKatex from 'rehype-katex';
import type { AgentRun, AgentTask, ApprovalRequest, PrimaryAgentAvatar, PrimaryAgentProfile, TimelineNode, TurnVariantGroup } from '@openlab/protocol';
import 'katex/dist/katex.min.css';
import { hanaZhCN as copy } from '../i18n/zh-CN.js';
import { formatClockTime } from '../lib/date-time.js';
import { AgentAvatar } from './AgentAvatar.js';
import { promptInApp } from './AppDialog.js';
import { SemanticIcon, SemanticStatus, semanticRoleForStatus } from './SemanticVisual.js';

interface TimelineProps {
  nodes: TimelineNode[];
  approvals: ApprovalRequest[];
  variants: TurnVariantGroup[];
  agents: AgentRun[];
  tasks: AgentTask[];
  primaryAgent: PrimaryAgentProfile;
  timeZone: string;
  sessionKey?: string;
  emptyProjectName?: string | undefined;
  onChooseProject?: (() => void) | undefined;
  emptyAgent?: { id: string; name: string; avatar: PrimaryAgentAvatar; memoryEnabled: boolean } | undefined;
  emptyAgentOptions?: Array<{ id: string; name: string; avatar: PrimaryAgentAvatar }> | undefined;
  onChooseAgent?: ((id: string) => void) | undefined;
  onApprove(id: string, approved: boolean): void;
  onRegenerate(turnId: string): Promise<void>;
  onFork(nodeId: string): Promise<void>;
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
  if (streaming) return <div className="streaming-text" aria-live="polite">{content || copy.timeline.generating}</div>;
  return content ? <Markdown>{content}</Markdown> : <span className="streaming-placeholder">{copy.timeline.generating}</span>;
});

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
  return <details className="reasoning-block" open={node.status === 'streaming'} data-node-id={node.id}>
    <summary><span><Lightbulb size={13}/>{node.status === 'streaming' ? copy.timeline.thinking : copy.timeline.thoughtComplete}{node.status === 'streaming' && <LoaderCircle className="spin" size={12}/>}</span><ChevronDown size={13}/></summary>
    <div>{node.content || copy.timeline.organizing}</div>
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
    {choices.map((option) => <button key={option.id} className={`hana-draft-agent ${option.id === agent.id ? 'is-active' : ''}`} type="button" data-testid="draft-agent-option" role="radio" aria-checked={option.id === agent.id} title={option.name} disabled={!onChange} onClick={() => onChange?.(option.id)}><AgentAvatar avatar={option.avatar} size="tiny"/><strong>{option.name}</strong></button>)}
  </div>;
}

export function Timeline(props: TimelineProps) {
  const scroll = useRef<HTMLDivElement>(null);
  const scrollFrame = useRef(0);
  const nodeElements = useRef(new Map<string, HTMLElement>());
  const [follow, setFollow] = useState(true);
  const [multi, setMulti] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [actionError, setActionError] = useState<string>();
  const approvalMap = useMemo(() => new Map(props.approvals.map((approval) => [approval.id, approval])), [props.approvals]);
  const activeVariants = useMemo(() => new Map(props.variants.map((group) => [group.turnId, group.activeVariantId])), [props.variants]);
  const visibleNodes = useMemo(() => props.nodes.filter((node) => {
    if (node.kind === 'assistant' && node.status !== 'streaming' && !node.content.trim()) return false;
    const turnId = typeof node.metadata.turnId === 'string' ? node.metadata.turnId : undefined;
    const variantId = typeof node.metadata.variantId === 'string' ? node.metadata.variantId : undefined;
    return !turnId || !variantId || activeVariants.get(turnId) === variantId;
  }), [activeVariants, props.nodes]);

  useEffect(() => {
    const target = scroll.current;
    const key = props.sessionKey;
    if (!target || !key) return;
    const frame = window.requestAnimationFrame(() => {
      const restored = timelineScrollPositions.get(key);
      target.scrollTop = restored ?? target.scrollHeight;
      setFollow(restored === undefined || target.scrollHeight - target.scrollTop - target.clientHeight < 160);
    });
    return () => {
      window.cancelAnimationFrame(frame);
      timelineScrollPositions.set(key, target.scrollTop);
    };
  }, [props.sessionKey]);

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
    await navigator.clipboard.writeText(content);
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

  const variantSelector = (node: TimelineNode) => {
    const turnId = typeof node.metadata.turnId === 'string' ? node.metadata.turnId : undefined;
    const group = turnId ? props.variants.find((item) => item.turnId === turnId) : undefined;
    const active = group?.variants.find((variant) => variant.id === group.activeVariantId);
    if (!group || group.variants.length < 2 || active?.assistantNodeIds.at(-1) !== node.id) return null;
    const index = group.variants.findIndex((variant) => variant.id === group.activeVariantId);
    return <div className="variant-selector"><button className="previous" disabled={group.locked || index <= 0} onClick={() => { const target = group.variants[index - 1]; if (target) void safe(() => props.onActivateVariant(group.turnId, target.id).then(() => undefined)); }}><ChevronRight size={12}/></button><span>{index + 1} / {group.variants.length}{group.locked ? ` · ${copy.timeline.locked}` : ''}</span><button disabled={group.locked || index >= group.variants.length - 1} onClick={() => { const target = group.variants[index + 1]; if (target) void safe(() => props.onActivateVariant(group.turnId, target.id).then(() => undefined)); }}><ChevronRight size={12}/></button></div>;
  };

  return <div className="timeline-scroll" ref={scroll} onScroll={(event) => {
    const element = event.currentTarget;
    if (props.sessionKey) timelineScrollPositions.set(props.sessionKey, element.scrollTop);
    setFollow(element.scrollHeight - element.scrollTop - element.clientHeight < 160);
  }}>
    <div className="timeline">
      {visibleNodes.length === 0 && (props.emptyAgent ? <div className="empty-timeline hana-draft-hero" data-testid="hana-draft-hero">
        <AgentAvatar avatar={props.emptyAgent.avatar} size="large"/>
        <h2>{copy.timeline.draftGreeting(props.emptyAgent.name)}</h2>
        <DraftAgentPicker agent={props.emptyAgent} options={props.emptyAgentOptions ?? []} onChange={props.onChooseAgent}/>
        {props.emptyProjectName && props.onChooseProject && <button className={`empty-timeline__project ${props.emptyProjectName === copy.timeline.noProject ? 'is-empty' : ''}`} data-testid="draft-project-selector" onClick={props.onChooseProject}>{props.emptyProjectName === copy.timeline.noProject ? <FolderPlus size={15}/> : <FolderOpen size={15}/>}<span>{props.emptyProjectName === copy.timeline.noProject ? copy.timeline.noProject : copy.timeline.chooseProject}</span>{props.emptyProjectName !== copy.timeline.noProject && <strong>{props.emptyProjectName}</strong>}<RefreshCw size={13}/></button>}
        <span className="hana-draft-memory" data-testid="draft-memory-status"><Diamond size={12}/>{props.emptyAgent.memoryEnabled ? copy.timeline.memoryEnabled : copy.timeline.memoryDisabled}</span>
      </div> : <div className="empty-timeline"><span><Sparkles size={23}/></span><h2>{copy.timeline.emptyTitle}</h2><p>{copy.timeline.emptyDescription}</p>{props.emptyProjectName && props.onChooseProject && <button className="empty-timeline__project" data-testid="draft-project-selector" onClick={props.onChooseProject}><FolderOpen size={15}/><span>{copy.timeline.chooseProject}</span><strong>{props.emptyProjectName}</strong><RefreshCw size={13}/></button>}</div>)}
      {visibleNodes.map((node) => {
        const selectable = node.kind === 'user' || node.kind === 'assistant';
        const selectedNow = selected.has(node.id);
        let content: ReactNode;
        if (node.kind === 'user') content = <article className="user-message" data-node-id={node.id}><div className="user-message__bubble">{node.content}</div><div className="user-message__meta">{formatClockTime(node.timestamp, props.timeZone)}<button title={copy.timeline.forkHere} onClick={() => void safe(() => props.onFork(node.id))}><GitBranch size={12}/></button><button title={copy.common.copy} onClick={() => void safe(() => copyNodes([node.id]))}><Copy size={12}/></button><button title={copy.common.quote} onClick={() => props.onQuote([node.id])}><MessageSquareQuote size={12}/></button></div></article>;
        else if (node.kind === 'reasoning') content = <Reasoning node={node}/>;
        else if (node.kind === 'approval') { const id = typeof node.metadata.approvalId === 'string' ? node.metadata.approvalId : ''; content = <ApprovalCard node={node} approval={approvalMap.get(id)} onApprove={props.onApprove}/>; }
        else if (node.kind === 'tool' || node.kind === 'artifact') content = <CompactCard node={node}/>;
        else if (node.kind === 'agent') { const runId = typeof node.metadata.runId === 'string' ? node.metadata.runId : undefined; const agent = props.agents.find((item) => item.id === runId || item.definitionId === node.agentId); const taskId = typeof node.metadata.taskId === 'string' ? node.metadata.taskId : agent?.currentTaskId; content = <AgentCard node={node} agent={agent} task={props.tasks.find((task) => task.id === taskId)} onAction={props.onAgentAction} onMessage={props.onAgentMessage}/>; }
        else if (node.kind === 'notice') content = <div className={`timeline-notice ${node.status ?? ''}`} data-node-id={node.id}><NodeIcon node={node}/><span><strong>{node.title}</strong>{node.content}</span></div>;
        else content = <article className="assistant-message" data-node-id={node.id}>
          <header><AgentAvatar avatar={props.primaryAgent.avatar} size="tiny"/><div><strong>{node.title ?? props.primaryAgent.name ?? copy.common.supervisor}</strong>{node.status === 'streaming' && <small>{copy.timeline.answering}</small>}</div>{node.status !== 'completed' && <Status value={node.status}/>}</header>
          <div className="message-content"><AssistantBody content={node.content} streaming={node.status === 'streaming'}/></div>
          {variantSelector(node)}{messageActions(node)}
        </article>;
        return <div key={node.id} ref={(element) => { if (element) nodeElements.current.set(node.id, element); else nodeElements.current.delete(node.id); }} className={`timeline-node-wrap ${selectedNow ? 'is-selected' : ''}`}>{multi && selectable && <button className={`message-select ${selectedNow ? 'is-selected' : ''}`} onClick={() => setSelected((current) => { const next = new Set(current); if (next.has(node.id)) next.delete(node.id); else next.add(node.id); return next; })}>{selectedNow ? <Check size={12}/> : null}</button>}{content}</div>;
      })}
    </div>
    {!follow && <button className="scroll-to-bottom" onClick={() => { setFollow(true); scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: 'smooth' }); }}><ChevronDown size={16}/></button>}
    {multi && <div className="multi-select-toolbar"><strong>{copy.timeline.selected(selected.size)}</strong><button disabled={!selected.size} onClick={() => void safe(() => copyNodes([...selected]))}><Copy size={13}/>{copy.common.copy}</button><button disabled={!selected.size} onClick={() => props.onQuote([...selected])}><MessageSquareQuote size={13}/>{copy.common.quote}</button><button disabled={!selected.size} onClick={() => void safe(() => exportNodes([...selected]))}><Download size={13}/>{copy.timeline.exportImage}</button><button onClick={() => { setMulti(false); setSelected(new Set()); }}><X size={13}/>{copy.timeline.exit}</button></div>}
    {actionError && <div className="timeline-action-error"><CircleAlert size={13}/>{actionError}<button onClick={() => setActionError(undefined)}><X size={12}/></button></div>}
  </div>;
}
