import { useEffect, useState } from 'react';
import { Archive, Bot, Brain, Check, ChevronDown, ChevronRight, Download, Plus, Search, Sparkles, Trash2, Upload, Wrench, X } from 'lucide-react';
import type { AgentCardExport, AgentDefinition, AgentDefinitionUpdate, AgentMemoryItem, AgentToolPolicy, BootstrapSnapshot, HarnessSettings, ReasoningEffort } from '@openlab/protocol';
import { agentV3ZhCN as copy } from '../i18n/zh-CN.js';
import { AgentAvatar } from './AgentAvatar.js';
import { confirmInApp } from './AppDialog.js';

type EditorSection = 'profile' | 'memory' | 'experience' | 'tools';
type MemoryView = 'pinned' | 'current' | 'all';

interface Props {
  snapshot: BootstrapSnapshot;
  onCreate(input: { name: string; avatar?: AgentDefinition['avatar']; templateId?: AgentDefinition['templateId']; identity?: string; instructions?: string; model?: string; reasoningEffort?: ReasoningEffort }): Promise<AgentDefinition | undefined>;
  onUpdate(id: string, patch: AgentDefinitionUpdate): Promise<AgentDefinition | undefined>;
  onArchive(id: string, restore?: boolean): Promise<void>;
  onImport(card: AgentCardExport): Promise<AgentDefinition | undefined>;
  onExport(id: string): Promise<AgentCardExport | undefined>;
  onSetToolPolicy(id: string, policy: AgentToolPolicy): Promise<void>;
  onSetProjectCapabilities(id: string, capabilityIds: string[]): Promise<void>;
  onListMemories(agentId: string, options?: { kind?: AgentMemoryItem['kind']; scope?: AgentMemoryItem['scope']; query?: string }): Promise<AgentMemoryItem[]>;
  onCreateMemory(agentId: string, scope: AgentMemoryItem['scope'], content: string): Promise<void>;
  onUpdateMemory(id: string, patch: { content?: string; confidence?: number }): Promise<void>;
  onDeleteMemory(id: string): Promise<void>;
  onClearMemories(agentId: string, options?: { kind?: AgentMemoryItem['kind']; scope?: AgentMemoryItem['scope'] }): Promise<void>;
  onUpdateSettings(patch: Partial<HarnessSettings>): Promise<void>;
}

export function PrimaryAgentSettings(props: Props) {
  const activeAgents = props.snapshot.agentDefinitions.filter((agent) => agent.status === 'active');
  const [selectedId, setSelectedId] = useState(props.snapshot.sessionAgentBinding.leadAgentId || activeAgents[0]?.id || '');
  const [section, setSection] = useState<EditorSection>('profile');
  const [creating, setCreating] = useState(false);
  const selected = props.snapshot.agentDefinitions.find((agent) => agent.id === selectedId) ?? activeAgents[0];

  useEffect(() => {
    if (!selected && activeAgents[0]) setSelectedId(activeAgents[0].id);
  }, [activeAgents, selected]);

  return <div className="agent-library-settings">
    <div className="settings-heading agent-library-heading">
      <span className="settings-heading__icon cyan"><Bot size={20}/></span>
      <div><h2>{copy.agents.library}</h2><p>{copy.agents.libraryHint}</p></div>
      <button className="button primary" data-testid="create-agent" onClick={() => setCreating(true)}><Plus size={14}/>{copy.agents.add}</button>
    </div>

    <section className="agent-roster-card">
      <div className="agent-avatar-stack">
        {activeAgents.map((agent) => <button key={agent.id} title={agent.name} className={agent.id === selected?.id ? 'is-active' : ''} onClick={() => setSelectedId(agent.id)}><AgentAvatar avatar={agent.avatar} size="small"/></button>)}
        <button className="agent-stack-add" onClick={() => setCreating(true)}><Plus size={15}/></button>
      </div>
      <div>{selected ? <><strong>{selected.name}</strong><span>{templateName(props.snapshot, selected.templateId)} · {selected.model}</span></> : <><strong>{copy.agents.empty}</strong><span>{copy.agents.emptyHint}</span></>}</div>
    </section>

    {selected && <>
      <nav className="agent-editor-tabs">
        <button className={section === 'profile' ? 'is-active' : ''} onClick={() => setSection('profile')}><Bot size={14}/>{copy.agents.profile}</button>
        <button className={section === 'memory' ? 'is-active' : ''} onClick={() => setSection('memory')}><Brain size={14}/>{copy.agents.memory}</button>
        <button className={section === 'experience' ? 'is-active' : ''} onClick={() => setSection('experience')}><Sparkles size={14}/>{copy.agents.experience}</button>
        <button className={section === 'tools' ? 'is-active' : ''} onClick={() => setSection('tools')}><Wrench size={14}/>{copy.agents.tools}</button>
      </nav>
      {section === 'profile' && <ProfileEditor key={selected.id} agent={selected} snapshot={props.snapshot} onSave={props.onUpdate} onArchive={props.onArchive} onExport={props.onExport}/>}
      {section === 'memory' && <MemoryEditor agent={selected} snapshot={props.snapshot} onUpdateAgent={props.onUpdate} onList={props.onListMemories} onCreate={props.onCreateMemory} onUpdate={props.onUpdateMemory} onDelete={props.onDeleteMemory} onClear={props.onClearMemories}/>}
      {section === 'experience' && <ExperienceEditor agent={selected} onUpdateAgent={props.onUpdate} onList={props.onListMemories} onDelete={props.onDeleteMemory}/>}
      {section === 'tools' && <ToolEditor agent={selected} snapshot={props.snapshot} onSetPolicy={props.onSetToolPolicy} onSetProjectCapabilities={props.onSetProjectCapabilities}/>}
    </>}

    <section className="settings-card agent-runtime-limit">
      <div><strong>{copy.agents.runLimit}</strong><p>{copy.agents.runLimitHint}</p></div>
      <input type="number" min={1} max={8} value={props.snapshot.settings.maxConcurrentAgentRuns} onChange={(event) => void props.onUpdateSettings({ maxConcurrentAgentRuns: Number(event.target.value) })}/>
    </section>
    {creating && <AgentCreateModal snapshot={props.snapshot} onClose={() => setCreating(false)} onCreate={async (input) => { const created = await props.onCreate(input); if (created) setSelectedId(created.id); setCreating(false); }} onImport={async (card) => { const created = await props.onImport(card); if (created) setSelectedId(created.id); setCreating(false); }}/>}
  </div>;
}

function ProfileEditor({ agent, snapshot, onSave, onArchive, onExport }: { agent: AgentDefinition; snapshot: BootstrapSnapshot; onSave(id: string, patch: AgentDefinitionUpdate): Promise<unknown>; onArchive(id: string, restore?: boolean): Promise<void>; onExport(id: string): Promise<AgentCardExport | undefined> }) {
  const [draft, setDraft] = useState(agent);
  const [saved, setSaved] = useState(false);
  const [avatarError, setAvatarError] = useState('');
  const modelOptions = snapshot.models.length ? snapshot.models : [{ id: agent.model, label: agent.model, contextWindow: 0, supportsThinking: true, supportsTools: true, supportsVision: false }];
  useEffect(() => { setDraft(agent); setAvatarError(''); }, [agent]);
  const save = async () => {
    await onSave(agent.id, { name: draft.name, avatar: draft.avatar, identity: draft.identity, instructions: draft.instructions, model: draft.model, reasoningEffort: draft.reasoningEffort });
    setSaved(true); window.setTimeout(() => setSaved(false), 1_500);
  };
  const uploadAvatar = async (file: File | undefined) => {
    if (!file) return;
    try { const avatar = await avatarFromFile(file); setDraft((current) => ({ ...current, avatar })); setAvatarError(''); }
    catch (cause) { setAvatarError(cause instanceof Error ? cause.message : copy.agents.avatarInvalid); }
  };
  const download = async () => {
    const card = await onExport(agent.id); if (!card) return;
    const blob = new Blob([JSON.stringify(card, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${agent.name}.openlab-agent.json`; anchor.click(); URL.revokeObjectURL(url);
  };
  return <section className="settings-card agent-profile-editor">
    <div className="agent-profile-hero"><AgentAvatar avatar={draft.avatar} size="large"/><div><strong>{draft.name}</strong><span>{copy.agents.persistentRole}</span></div><div className="agent-profile-actions"><button title={copy.agents.exportCard} onClick={() => void download()}><Download size={14}/></button><button title={copy.agents.archive} onClick={() => void onArchive(agent.id)}><Archive size={14}/></button></div></div>
    <div className="agent-avatar-choice">{(['sage', 'ocean', 'amber'] as const).map((avatar) => <button key={avatar} title={copy.agents.presetAvatar} className={draft.avatar === avatar ? 'is-active' : ''} onClick={() => { setDraft({ ...draft, avatar }); setAvatarError(''); }}><AgentAvatar avatar={avatar} size="small"/></button>)}<label className="agent-avatar-upload" title={copy.agents.uploadAvatar}><Upload size={13}/><span>{copy.agents.uploadAvatar}</span><input data-testid="agent-avatar-upload" type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; void uploadAvatar(file); }}/></label>{avatarError && <small className="agent-avatar-error" role="alert">{avatarError}</small>}</div>
    <label><span>{copy.agents.name}</span><input value={draft.name} maxLength={32} onChange={(event) => setDraft({ ...draft, name: event.target.value })}/></label>
    <div className="agent-profile-grid"><label><span>{copy.agents.model}</span><select value={draft.model} onChange={(event) => setDraft({ ...draft, model: event.target.value })}>{modelOptions.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}</select></label><label><span>{copy.agents.reasoning}</span><select value={draft.reasoningEffort} onChange={(event) => setDraft({ ...draft, reasoningEffort: event.target.value as ReasoningEffort })}><option value="none">{copy.agents.reasoningOptions.none}</option><option value="medium">{copy.agents.reasoningOptions.medium}</option><option value="high">{copy.agents.reasoningOptions.high}</option><option value="max">{copy.agents.reasoningOptions.max}</option></select></label></div>
    <label><span>{copy.agents.identity}</span><textarea data-testid="primary-agent-identity" rows={5} value={draft.identity} onChange={(event) => setDraft({ ...draft, identity: event.target.value })}/></label>
    <label><span>{copy.agents.instructions}</span><textarea data-testid="primary-agent-instructions" rows={9} value={draft.instructions} onChange={(event) => setDraft({ ...draft, instructions: event.target.value })}/></label>
    <footer><span>{copy.agents.snapshotHint}</span><button data-testid="primary-agent-settings-save" className="button primary" onClick={() => void save()}>{saved ? <><Check size={14}/>{copy.agents.saved}</> : copy.agents.save}</button></footer>
  </section>;
}

function MemoryEditor({ agent, snapshot, onUpdateAgent, onList, onCreate, onUpdate, onDelete, onClear }: { agent: AgentDefinition; snapshot: BootstrapSnapshot; onUpdateAgent(id: string, patch: AgentDefinitionUpdate): Promise<unknown>; onList(agentId: string, options?: { kind?: AgentMemoryItem['kind']; scope?: AgentMemoryItem['scope']; query?: string }): Promise<AgentMemoryItem[]>; onCreate(agentId: string, scope: AgentMemoryItem['scope'], content: string): Promise<void>; onUpdate(id: string, patch: { content?: string }): Promise<void>; onDelete(id: string): Promise<void>; onClear(agentId: string, options?: { kind?: AgentMemoryItem['kind']; scope?: AgentMemoryItem['scope'] }): Promise<void> }) {
  const [view, setView] = useState<MemoryView>('pinned');
  const [items, setItems] = useState<AgentMemoryItem[]>([]);
  const [query, setQuery] = useState('');
  const [content, setContent] = useState('');
  const [scope, setScope] = useState<AgentMemoryItem['scope']>('project');
  const load = async () => setItems(await onList(agent.id, { ...(view === 'pinned' ? { kind: 'pinned' as const } : view === 'current' ? { kind: 'current' as const } : {}), ...(query ? { query } : {}) }));
  useEffect(() => { void load(); }, [agent.id, view]);
  const summary = snapshot.memorySummaries.find((item) => item.agentId === agent.id);
  return <section className="settings-card agent-memory-editor">
    <header><div><strong>{copy.agents.memory}</strong><p>{copy.agents.memoryHint}</p></div><Toggle checked={agent.memoryPolicy.memoryEnabled} onChange={(checked) => void onUpdateAgent(agent.id, { memoryPolicy: { ...agent.memoryPolicy, memoryEnabled: checked } })}/></header>
    <nav><button className={view === 'pinned' ? 'is-active' : ''} onClick={() => setView('pinned')}>{copy.agents.pinned} <em>{summary?.pinnedCount ?? 0}</em></button><button className={view === 'current' ? 'is-active' : ''} onClick={() => setView('current')}>{copy.agents.current} <em>{summary?.currentCount ?? 0}</em></button><button className={view === 'all' ? 'is-active' : ''} onClick={() => setView('all')}>{copy.agents.all}</button></nav>
    {view === 'pinned' && <div className="memory-create"><textarea value={content} placeholder={copy.agents.pinPlaceholder} onChange={(event) => setContent(event.target.value)}/><div><select value={scope} onChange={(event) => setScope(event.target.value as AgentMemoryItem['scope'])}><option value="project">{copy.agents.currentProject}</option><option value="global">{copy.agents.allProjects}</option></select><button className="button primary" disabled={!content.trim()} onClick={() => void (async () => { await onCreate(agent.id, scope, content); setContent(''); await load(); })()}><Plus size={13}/>{copy.agents.addMemory}</button></div></div>}
    {view === 'all' && <div className="memory-search"><Search size={14}/><input value={query} placeholder={copy.agents.searchPlaceholder} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => event.key === 'Enter' && void load()}/><button onClick={() => void load()}>{copy.agents.search}</button><button className="danger-link" onClick={() => void confirmInApp(copy.agents.clearConfirm, { title: copy.agents.clear, confirmLabel: copy.agents.clear, tone: 'danger' }).then((confirmed) => confirmed ? onClear(agent.id, { scope: 'project' }).then(load) : undefined)}>{copy.agents.clear}</button></div>}
    <MemoryList items={items} editable={view !== 'current'} onUpdate={async (id, value) => { await onUpdate(id, { content: value }); await load(); }} onDelete={async (id) => { await onDelete(id); await load(); }}/>
    {!agent.memoryPolicy.memoryEnabled && <div className="memory-disabled-note">{copy.agents.memoryDisabled}</div>}
  </section>;
}

function ExperienceEditor({ agent, onUpdateAgent, onList, onDelete }: { agent: AgentDefinition; onUpdateAgent(id: string, patch: AgentDefinitionUpdate): Promise<unknown>; onList(agentId: string, options?: { kind?: AgentMemoryItem['kind'] }): Promise<AgentMemoryItem[]>; onDelete(id: string): Promise<void> }) {
  const [items, setItems] = useState<AgentMemoryItem[]>([]);
  const load = async () => setItems(await onList(agent.id, { kind: 'experience' }));
  useEffect(() => { void load(); }, [agent.id]);
  return <section className="settings-card agent-memory-editor"><header><div><strong>{copy.agents.experience}</strong><p>{copy.agents.experienceHint}</p></div><Toggle checked={agent.memoryPolicy.experienceEnabled} onChange={(checked) => void onUpdateAgent(agent.id, { memoryPolicy: { ...agent.memoryPolicy, experienceEnabled: checked, memoryEnabled: checked || agent.memoryPolicy.memoryEnabled } })}/></header><MemoryList items={items} editable={false} onUpdate={async () => undefined} onDelete={async (id) => { await onDelete(id); await load(); }}/>{!agent.memoryPolicy.experienceEnabled && <div className="memory-disabled-note">{copy.agents.experienceDisabled}</div>}</section>;
}

function MemoryList({ items, editable, onUpdate, onDelete }: { items: AgentMemoryItem[]; editable: boolean; onUpdate(id: string, content: string): Promise<void>; onDelete(id: string): Promise<void> }) {
  const [editing, setEditing] = useState<string>();
  const [draft, setDraft] = useState('');
  if (!items.length) return <div className="memory-empty"><Brain size={25}/><strong>{copy.agents.emptyMemory}</strong><span>{copy.agents.emptyMemoryHint}</span></div>;
  return <div className="memory-list">{items.map((item) => <article key={item.id}>{editing === item.id ? <textarea value={draft} onChange={(event) => setDraft(event.target.value)}/> : <p>{item.content}</p>}<footer><span>{item.kind === 'pinned' ? copy.agents.pinnedShort : item.kind === 'current' ? copy.agents.currentShort : copy.agents.experienceShort} · {item.scope === 'global' ? copy.agents.allProjects : copy.agents.currentProject}{item.confidence !== undefined ? ` · ${Math.round(item.confidence * 100)}%` : ''}</span><span title={item.sourceEventIds.join('\n')}>{copy.agents.source} {item.sourceEventIds.length}</span>{editable && (editing === item.id ? <button onClick={() => void onUpdate(item.id, draft).then(() => setEditing(undefined))}><Check size={12}/></button> : <button onClick={() => { setEditing(item.id); setDraft(item.content); }}>{copy.agents.edit}</button>)}<button onClick={() => void onDelete(item.id)}><Trash2 size={12}/></button></footer></article>)}</div>;
}

function ToolEditor({ agent, snapshot, onSetPolicy, onSetProjectCapabilities }: { agent: AgentDefinition; snapshot: BootstrapSnapshot; onSetPolicy(id: string, policy: AgentToolPolicy): Promise<void>; onSetProjectCapabilities(id: string, capabilityIds: string[]): Promise<void> }) {
  const projectBinding = snapshot.projectAgents.find((item) => item.agentId === agent.id);
  const [expanded, setExpanded] = useState<string>();
  const enabled = new Set(agent.toolPolicy.enabledCapabilityIds);
  const external = new Set(projectBinding?.externalCapabilityIds ?? []);
  const toggleCapability = async (id: string, source: 'core' | 'mcp' | 'plugin', checked: boolean) => {
    if (source === 'core') {
      const next = new Set(enabled); checked ? next.add(id) : next.delete(id);
      await onSetPolicy(agent.id, { ...agent.toolPolicy, enabledCapabilityIds: [...next], revision: agent.toolPolicy.revision + 1 });
    } else {
      const next = new Set(external); checked ? next.add(id) : next.delete(id);
      await onSetProjectCapabilities(agent.id, [...next]);
    }
  };
  const toggleTool = async (toolId: string, checked: boolean) => {
    const disabled = new Set(agent.toolPolicy.disabledToolIds); checked ? disabled.delete(toolId) : disabled.add(toolId);
    await onSetPolicy(agent.id, { ...agent.toolPolicy, disabledToolIds: [...disabled], revision: agent.toolPolicy.revision + 1 });
  };
  return <section className="settings-card agent-tools-editor"><header><div><strong>{copy.agents.tools}</strong><p>{copy.agents.toolHint}</p></div><span>{copy.agents.policy} r{agent.toolPolicy.revision}</span></header>{snapshot.toolCapabilities.map((capability) => {
    const checked = capability.source === 'core' ? enabled.has(capability.id) : external.has(capability.id);
    return <article key={capability.id} className={!capability.available ? 'is-unavailable' : ''}><div className="tool-capability-row"><button className="tool-expand" onClick={() => setExpanded(expanded === capability.id ? undefined : capability.id)}>{expanded === capability.id ? <ChevronDown size={14}/> : <ChevronRight size={14}/>}</button><span className="tool-capability-icon"><Wrench size={15}/></span><div><strong>{capability.title}</strong><p>{capability.description}</p></div><em>{capability.source === 'core' ? copy.agents.core : capability.source === 'mcp' ? 'MCP' : copy.agents.plugin}</em><Toggle checked={checked && capability.available} disabled={!capability.available} onChange={(next) => void toggleCapability(capability.id, capability.source, next)}/></div>{expanded === capability.id && <div className="tool-definition-list">{capability.toolIds.length ? capability.toolIds.map((toolId) => <label key={toolId}><input type="checkbox" checked={!agent.toolPolicy.disabledToolIds.includes(toolId)} disabled={!checked} onChange={(event) => void toggleTool(toolId, event.target.checked)}/><code>{toolId}</code></label>) : <span>{copy.agents.noTools}</span>}</div>}</article>;
  })}<footer>{copy.agents.toolSnapshotHint}</footer></section>;
}

function AgentCreateModal({ snapshot, onClose, onCreate, onImport }: { snapshot: BootstrapSnapshot; onClose(): void; onCreate(input: { name: string; avatar?: AgentDefinition['avatar']; templateId?: AgentDefinition['templateId']; identity?: string; instructions?: string }): Promise<void>; onImport(card: AgentCardExport): Promise<void> }) {
  const [name, setName] = useState(''); const [templateId, setTemplateId] = useState<AgentDefinition['templateId']>('research_lead'); const [importing, setImporting] = useState(false); const [raw, setRaw] = useState(''); const [error, setError] = useState('');
  const selected = snapshot.agentTemplates.find((template) => template.id === templateId);
  const parseImport = async () => { try { const card = JSON.parse(raw) as AgentCardExport; if (card.kind !== 'openlab-agent' || card.schemaVersion !== 1) throw new Error(copy.agents.invalidCard); await onImport(card); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } };
  const createSelected = () => onCreate({ name, ...(templateId ? { templateId } : {}), ...(selected ? { avatar: selected.avatar, identity: selected.identity, instructions: selected.instructions } : {}) });
  return <div className="agent-create-backdrop" onMouseDown={(event) => event.currentTarget === event.target && onClose()}><div className="agent-create-modal" role="dialog" aria-modal="true"><header><div><Bot size={20}/><span><strong>{copy.agents.createTitle}</strong><small>{copy.agents.createHint}</small></span></div><button onClick={onClose}><X size={17}/></button></header>{!importing ? <><label className="agent-name-field"><span>{copy.agents.giveName}</span><input data-testid="new-agent-name" autoFocus value={name} maxLength={32} placeholder={copy.agents.namePlaceholder} onChange={(event) => setName(event.target.value)}/></label><div className="agent-template-grid">{snapshot.agentTemplates.map((template) => <button data-testid={`agent-template-${template.id}`} key={template.id} className={template.id === templateId ? 'is-active' : ''} onClick={() => setTemplateId(template.id)}><AgentAvatar avatar={template.avatar} size="medium"/><span><strong>{template.name}</strong><small>{template.summary}</small></span>{template.id === templateId && <Check size={15}/>}</button>)}</div><button className="agent-import-zone" onClick={() => setImporting(true)}><Upload size={19}/><span><strong>{copy.agents.importCard}</strong><small>{copy.agents.importHint}</small></span></button><footer><button className="button secondary" onClick={onClose}>{copy.agents.cancel}</button><button data-testid="confirm-create-agent" className="button primary" disabled={!name.trim() || !selected} onClick={() => void createSelected()}>{copy.agents.confirmCreate}</button></footer></> : <><div className="agent-import-editor"><label>{copy.agents.pasteCard}<textarea autoFocus value={raw} onChange={(event) => { setRaw(event.target.value); setError(''); }}/></label>{error && <p>{error}</p>}</div><footer><button className="button secondary" onClick={() => setImporting(false)}>{copy.agents.backToTemplates}</button><button className="button primary" disabled={!raw.trim()} onClick={() => void parseImport()}>{copy.agents.validateImport}</button></footer></>}</div></div>;
}

function Toggle({ checked, disabled, onChange }: { checked: boolean; disabled?: boolean; onChange(value: boolean): void }) { return <button type="button" role="switch" aria-checked={checked} disabled={disabled} className={`hana-toggle ${checked ? 'is-on' : ''}`} onClick={() => onChange(!checked)}><span/></button>; }
function templateName(snapshot: BootstrapSnapshot, id: AgentDefinition['templateId']) { return snapshot.agentTemplates.find((template) => template.id === id)?.name ?? copy.agents.custom; }

async function avatarFromFile(file: File): Promise<AgentDefinition['avatar']> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error(copy.agents.avatarInvalid);
  if (!file.size || file.size > 5 * 1024 * 1024) throw new Error(copy.agents.avatarSourceTooLarge);
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(file); }
  catch { throw new Error(copy.agents.avatarInvalid); }
  try {
    if (!bitmap.width || !bitmap.height) throw new Error(copy.agents.avatarInvalid);
    const canvas = document.createElement('canvas'); canvas.width = 256; canvas.height = 256;
    const context = canvas.getContext('2d'); if (!context) throw new Error(copy.agents.avatarInvalid);
    const sourceSize = Math.min(bitmap.width, bitmap.height);
    const sourceX = Math.floor((bitmap.width - sourceSize) / 2); const sourceY = Math.floor((bitmap.height - sourceSize) / 2);
    context.drawImage(bitmap, sourceX, sourceY, sourceSize, sourceSize, 0, 0, 256, 256);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', .86));
    if (!blob || blob.size > 256 * 1024) throw new Error(copy.agents.avatarProcessedTooLarge);
    return await new Promise<AgentDefinition['avatar']>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error(copy.agents.avatarInvalid));
      reader.onload = () => typeof reader.result === 'string' && reader.result.startsWith('data:image/webp;base64,') ? resolve(reader.result as AgentDefinition['avatar']) : reject(new Error(copy.agents.avatarInvalid));
      reader.readAsDataURL(blob);
    });
  } finally { bitmap.close(); }
}
