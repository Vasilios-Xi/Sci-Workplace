import { t, tf, zhCN } from "./../i18n/zh-CN.js";
import { useMemo } from 'react';
import { Activity, Bot, Box, CirclePause, CirclePlay, Database, FileCheck2, FlaskConical, GitBranch, Hand, Inbox, Layers3, MessageCircle, Network, Pause, Play, ScrollText, Square, UsersRound } from 'lucide-react';
import type { AgentRun, AgentTask, ArtifactProvenance, ContextPlan, MailboxMessage, ResearchObject, ResearchRelation } from '@openlab/protocol';
import { promptInApp } from './AppDialog.js';
export type InspectorTab = 'team' | 'context' | 'research';
interface InspectorProps {
    activeTab: InspectorTab;
    onTabChange(tab: InspectorTab): void;
    agents: AgentRun[];
    tasks: AgentTask[];
    mailbox: MailboxMessage[];
    context: ContextPlan;
    objects: ResearchObject[];
    relations: ResearchRelation[];
    provenance: ArtifactProvenance[];
    onAgentAction(id: string, action: 'pause' | 'resume' | 'cancel' | 'takeover'): void;
    onAgentMessage(id: string, content: string): void;
}
const objectIcons = {
    source: ScrollText,
    dataset: Database,
    experiment: FlaskConical,
    evidence: FileCheck2,
    artifact: Box,
} as const;
function TeamPanel({ agents, tasks, mailbox, onAgentAction, onAgentMessage }: Pick<InspectorProps, 'agents' | 'tasks' | 'mailbox' | 'onAgentAction' | 'onAgentMessage'>) {
    const active = agents.filter((agent) => agent.status === 'running').length;
    const agentName = (id: string) => agents.find((agent) => agent.id === id)?.name ?? id.slice(0, 8);
    return (<div className="inspector-panel">
      <div className="panel-summary"><span className="summary-icon violet"><UsersRound size={17}/></span><div><strong>{agents.length}{t("copy024")}</strong><small>{active}{t("copy025")}</small></div></div>
      <details className="inspector-section inspector-disclosure" open>
        <summary><span>{t("copy026")}</span><small>{t("copy027")}</small></summary>
        <div className="agent-roster">
          {agents.map((agent) => {
            const task = tasks.find((item) => item.id === agent.currentTaskId);
            return <article className="agent-row" key={agent.id}>
              <div className={`agent-avatar ${agent.role}`}><Bot size={15}/></div>
              <div className="agent-copy"><strong>{agent.name}<span>{agent.role === 'lead' ? t("copy028") : t("copy029")}</span></strong><small>{task?.title ?? (agent.status === 'idle' ? t("copy030") : zhCN.agentStatuses[agent.status])}</small><div className="agent-usage"><span style={{ width: `${Math.min(100, agent.usage.totalTokens / 200)}%` }}/></div></div>
              <span className={`agent-state ${agent.status}`}>{agent.status === 'running' ? <Activity size={12}/> : agent.status === 'paused' ? <CirclePause size={12}/> : <CirclePlay size={12}/>}</span>
              {agent.role === 'member' && <div className="agent-controls">{!['completed', 'failed', 'cancelled'].includes(agent.status) && <button onClick={() => void promptInApp(t("copy031"), '', { title: t("copy032") }).then((content) => { if (content?.trim()) onAgentMessage(agent.id, content.trim()); })} title={t("copy032")}><MessageCircle size={11}/></button>}{agent.status === 'running' && <button onClick={() => onAgentAction(agent.id, 'pause')} title={t("copy033")}><Pause size={12}/></button>}{agent.status === 'paused' && <button onClick={() => onAgentAction(agent.id, 'resume')} title={t("copy034")}><Play size={12}/></button>}{agent.status === 'failed' && <button onClick={() => onAgentAction(agent.id, 'resume')} title={t("copy311")}><Play size={12}/></button>}{!['completed', 'failed', 'cancelled'].includes(agent.status) && <button onClick={() => onAgentAction(agent.id, 'takeover')} title={t("copy035")}><Hand size={11}/></button>}{!['completed', 'failed', 'cancelled'].includes(agent.status) && <button onClick={() => onAgentAction(agent.id, 'cancel')} title={t("copy036")}><Square size={11}/></button>}</div>}
            </article>;
        })}
        </div>
      </details>
      <details className="inspector-section inspector-disclosure">
        <summary><span>{t("copy037")}</span><small>{tasks.length}{t("copy038")}</small></summary>
        <div className="task-board">
          {tasks.length === 0 && <div className="panel-empty"><Inbox size={19}/><span>{t("copy039")}</span></div>}
          {tasks.map((task) => <article className="task-card" key={task.id}><span className={`task-status ${task.status}`}/><div><strong>{task.title}</strong><small>{zhCN.taskStatuses[task.status]} · {task.outputRefs.length}{t("copy040")}</small></div></article>)}
        </div>
      </details>
      <details className="inspector-section inspector-disclosure">
        <summary><span>{t("copy275")}</span><small>{mailbox.length}</small></summary>
        <div className="mailbox-list">
          {mailbox.length === 0 && <div className="panel-empty small">{t("copy276")}</div>}
          {[...mailbox].reverse().slice(0, 12).map((message) => <article key={message.id} className={!message.readAt ? 'is-unread' : ''}>
            <header><strong>{agentName(message.fromAgentId)}</strong><span>{t("copy277")} {agentName(message.toAgentId)}</span>{!message.readAt && <em>{t("copy278")}</em>}</header>
            <p>{message.content}</p>
            <small>{new Date(message.createdAt).toLocaleString('zh-CN')}</small>
          </article>)}
        </div>
      </details>
    </div>);
}
function ContextPanel({ context }: {
    context: ContextPlan;
}) {
    const usedPercent = Math.round(context.utilization * 100);
    return (<div className="inspector-panel">
      <div className="context-meter">
        <div className="context-ring" style={{ background: `conic-gradient(var(--accent) 0 ${usedPercent}%, var(--surface-3) ${usedPercent}% 100%)` }}><span><strong>{usedPercent}%</strong><small>{t("copy041")}</small></span></div>
        <div><strong>{context.usedTokens.toLocaleString()}{t("copy042")}</strong><small>{t("copy043")}{(context.budget - context.reservedOutputTokens).toLocaleString()}</small><em>{context.cacheStableTokens.toLocaleString()}{t("copy044")}</em></div>
      </div>
      <details className="inspector-section inspector-disclosure" open>
        <summary><span>{t("copy045")}</span><small>{t("copy046")}</small></summary>
        <div className="context-items">
          {context.items.map((item) => <article key={item.id} className={!item.included ? 'is-excluded' : ''} title={!item.included ? item.exclusionReason : undefined}><span className={`context-kind ${item.category}`}><Layers3 size={13}/></span><div><strong>{item.label}</strong><small>{zhCN.contextCategories[item.category]} · {item.trust === 'untrusted' ? t("copy047") : t("copy048")}</small><small>{tf("copy299", item.priority)} · {tf("copy300", item.sourceRefs.join(', ') || '—')}{item.exclusionReason ? ` · ${tf("copy301", item.exclusionReason)}` : ''}</small></div><span>{item.estimatedTokens.toLocaleString()}</span></article>)}
        </div>
      </details>
      <details className="inspector-section compact inspector-disclosure"><summary><span>{t("copy049")}</span></summary><div className="cache-stat"><span>{t("copy050")}</span><strong>{context.usedTokens ? Math.round(context.cacheStableTokens / context.usedTokens * 100) : 0}%</strong></div><div className="cache-bar"><span style={{ width: `${context.usedTokens ? Math.round(context.cacheStableTokens / context.usedTokens * 100) : 0}%` }}/></div></details>
      <details className="inspector-section compact model-metrics inspector-disclosure"><summary><span>{t("copy279")}</span><small>{context.lastModelRun?.model}</small></summary>
        {!context.lastModelRun && <div className="panel-empty small">{t("copy285")}</div>}
        {context.lastModelRun && <div className="metrics-grid">
          <div><span>{t("copy280")}</span><strong>{context.lastModelRun.usage.cacheHitTokens.toLocaleString()}</strong></div>
          <div><span>{t("copy281")}</span><strong>{context.lastModelRun.usage.cacheMissTokens.toLocaleString()}</strong></div>
          <div><span>{t("copy282")}</span><strong>{context.lastModelRun.firstEventLatencyMs.toLocaleString()} ms</strong></div>
          <div><span>{t("copy283")}</span><strong>{context.lastModelRun.latencyMs.toLocaleString()} ms</strong></div>
          {context.lastModelRun.estimatedCost && <div className="metric-cost"><span>{t("copy284")}</span><strong>{context.lastModelRun.estimatedCost.currency} {context.lastModelRun.estimatedCost.amount.toFixed(6)}</strong></div>}
        </div>}
      </details>
      <details className="inspector-section compact inspector-disclosure"><summary><span>{t("copy051")}</span><small>{context.compactedRanges.length}{t("copy052")}</small></summary>{context.compactedRanges.length === 0 && <div className="panel-empty small">{t("copy053")}</div>}<div className="compaction-list">{context.compactedRanges.map((range) => <article key={range.summaryEventId}><span>{tf("copy302", range.fromSequence, range.toSequence)}</span><code>{range.summaryEventId.slice(0, 12)}</code></article>)}</div></details>
    </div>);
}
function ResearchPanel({ objects, relations, provenance }: Pick<InspectorProps, 'objects' | 'relations' | 'provenance'>) {
    const grouped = useMemo(() => {
        const groups = new Map<string, ResearchObject[]>();
        for (const object of objects)
            groups.set(object.type, [...(groups.get(object.type) ?? []), object]);
        return [...groups.entries()];
    }, [objects]);
    return (<div className="inspector-panel">
      <div className="panel-summary"><span className="summary-icon green"><Network size={17}/></span><div><strong>{objects.length}{t("copy054")}</strong><small>{relations.length}{t("copy055")}</small></div></div>
      <details className="inspector-section inspector-disclosure" open><summary><span>{t("copy056")}</span><small>{objects.length}</small></summary>
        <div className="research-groups">
          {grouped.map(([type, entries]) => {
            const Icon = objectIcons[type as keyof typeof objectIcons] ?? GitBranch;
            const typeLabel = type in zhCN.objectTypes ? zhCN.objectTypes[type as keyof typeof zhCN.objectTypes] : type;
            return <div key={type}><h4>{typeLabel}<span>{entries.length}</span></h4>{entries.map((object) => <article className="research-row" key={object.id}><span className={`object-icon ${type}`}><Icon size={14}/></span><div><strong>{object.title}</strong><small>{zhCN.researchStatuses[object.status]} · {object.checksum.slice(0, 8)}</small></div></article>)}</div>;
        })}
        </div>
      </details>
      <details className="inspector-section inspector-disclosure"><summary><span>{t("copy058")}</span><small>{t("copy059")}</small></summary><div className="relation-list">{relations.map((relation) => <article key={relation.id}><span>{objects.find((object) => object.id === relation.fromId)?.title ?? relation.fromId}</span><em>{relation.predicate in zhCN.relationPredicates ? zhCN.relationPredicates[relation.predicate as keyof typeof zhCN.relationPredicates] : relation.predicate}</em><span>{objects.find((object) => object.id === relation.toId)?.title ?? relation.toId}</span></article>)}{relations.length === 0 && <div className="panel-empty small">{t("copy060")}</div>}</div></details>
      <details className="inspector-section inspector-disclosure"><summary><span>{t("copy286")}</span><small>{provenance.length}</small></summary><div className="provenance-list">
        {provenance.length === 0 && <div className="panel-empty small">{t("copy287")}</div>}
        {[...provenance].reverse().map((entry) => {
          const artifact = objects.find((object) => object.id === entry.artifactId);
          return <article key={`${entry.artifactId}:${entry.traceId}`}><strong>{artifact?.title ?? entry.artifactId}</strong><small>{entry.model ?? '—'} · {entry.tool ?? entry.plugin?.id ?? '—'}</small><div><span>{t("copy288")} {entry.inputObjectIds.length}</span><span>{t("copy289")} {Object.keys(entry.inputFileHashes).length}</span></div><code>{entry.traceId.slice(0, 12)}</code></article>;
        })}
      </div></details>
    </div>);
}
export function Inspector(props: InspectorProps) {
    const supervisor = props.agents.find((agent) => agent.role === 'lead');
    return (<aside className="inspector">
      <header className="inspector-profile"><span className="inspector-profile__avatar"><FlaskConical size={15}/></span><div><strong>{supervisor?.name ?? zhCN.appName}</strong><small>{zhCN.appSubtitle}</small></div><span className={`status-dot ${supervisor?.status === 'running' ? 'is-online' : ''}`}/></header>
      <div className="inspector-tabs">
        <button className={props.activeTab === 'team' ? 'is-active' : ''} onClick={() => props.onTabChange('team')}><UsersRound size={14}/>{t("copy061")}</button>
        <button className={props.activeTab === 'context' ? 'is-active' : ''} onClick={() => props.onTabChange('context')}><Layers3 size={14}/>{t("copy062")}</button>
        <button className={props.activeTab === 'research' ? 'is-active' : ''} onClick={() => props.onTabChange('research')}><Network size={14}/>{t("copy063")}</button>
      </div>
      {props.activeTab === 'team' && <TeamPanel agents={props.agents} tasks={props.tasks} mailbox={props.mailbox} onAgentAction={props.onAgentAction} onAgentMessage={props.onAgentMessage}/>}
      {props.activeTab === 'context' && <ContextPanel context={props.context}/>}
      {props.activeTab === 'research' && <ResearchPanel objects={props.objects} relations={props.relations} provenance={props.provenance}/>}
    </aside>);
}
