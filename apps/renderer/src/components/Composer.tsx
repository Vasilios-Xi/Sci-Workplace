import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AtSign, Check, ChevronDown, FolderOpen, FolderPlus, FolderX, GitBranch, GripHorizontal, Link2, MessageSquareQuote, Monitor,
  Paperclip, Plus, Search, Send, Shield, Sparkles, Square, WandSparkles, X,
} from 'lucide-react';
import type { AgentDefinition, ChatAttachmentRef, ModelDescriptor, PermissionMode, ReasoningEffort, ResearchObject, SkillDescriptor } from '@openlab/protocol';
import { hanaZhCN as copy } from '../i18n/zh-CN.js';
import { clampComposerHeight } from '../lib/chat-layout.js';
import { useFloatingPosition } from '../lib/floating-position.js';
import { ModelPicker } from './ModelPicker.js';
import { ReasoningPicker } from './ReasoningPicker.js';

interface QuotedNodeRef { id: string; label: string }

interface ComposerTransientState {
  text: string;
  model: string;
  reasoningEffort: ReasoningEffort;
  permissionMode: PermissionMode;
  selectedSkills: string[];
  attachments: ChatAttachmentRef[];
  researchObjectIds: string[];
  mentionedAgentIds: string[];
}

const transientSessions = new Map<string, ComposerTransientState>();
const draftKey = (sessionKey: string) => `openlab.composer-draft.v1:${encodeURIComponent(sessionKey)}`;

function createTransientState(sessionKey: string | undefined, model: string): ComposerTransientState {
  const stored = sessionKey ? transientSessions.get(sessionKey) : undefined;
  if (stored) return { ...stored, selectedSkills: [...stored.selectedSkills], attachments: [...stored.attachments], researchObjectIds: [...stored.researchObjectIds], mentionedAgentIds: [...stored.mentionedAgentIds] };
  let text = '';
  if (sessionKey) {
    try { text = sessionStorage.getItem(draftKey(sessionKey)) ?? ''; } catch { /* Draft persistence is optional. */ }
  }
  return { text, model, reasoningEffort: 'high', permissionMode: 'ask', selectedSkills: [], attachments: [], researchObjectIds: [], mentionedAgentIds: [] };
}

function persistTransientState(sessionKey: string, state: ComposerTransientState) {
  transientSessions.set(sessionKey, { ...state, selectedSkills: [...state.selectedSkills], attachments: [...state.attachments], researchObjectIds: [...state.researchObjectIds], mentionedAgentIds: [...state.mentionedAgentIds] });
  try {
    if (state.text) sessionStorage.setItem(draftKey(sessionKey), state.text);
    else sessionStorage.removeItem(draftKey(sessionKey));
  } catch {
    // The in-memory state still preserves the draft for the current renderer lifetime.
  }
}

interface ComposerProps {
  testId?: string;
  sessionKey?: string;
  composerHeight?: number | null;
  onComposerHeightChange?(height: number | null): void;
  models: ModelDescriptor[];
  skills: SkillDescriptor[];
  agents: AgentDefinition[];
  researchObjects: ResearchObject[];
  running: boolean;
  projectContext?: { name: string; location: string; gitBranch?: string } | undefined;
  onOpenProjectContext?(): void;
  onCreateProject?(): void;
  onLeaveProject?(): Promise<void>;
  injectedAttachments: ChatAttachmentRef[];
  quotedNodes: QuotedNodeRef[];
  onRemoveInjectedAttachment(id: string): void;
  onRemoveQuotedNode(id: string): void;
  onClearInjected(): void;
  onOpenWorkspace(): void;
  onSend(text: string, options: {
    model?: string;
    thinking: 'enabled' | 'disabled';
    reasoningEffort: ReasoningEffort;
    permissionMode: PermissionMode;
    skillIds?: string[];
    attachments?: ChatAttachmentRef[];
    researchObjectIds?: string[];
    mentionedAgentIds?: string[];
    quotedNodeIds?: string[];
  }): Promise<void>;
  onCancel(): Promise<void>;
}

export function Composer(props: ComposerProps) {
  const fallbackModel = props.models[0]?.id ?? 'deepseek::deepseek-v4-pro';
  const initial = useRef<ComposerTransientState>(createTransientState(props.sessionKey, fallbackModel)).current;
  const [loadedSessionKey, setLoadedSessionKey] = useState(props.sessionKey);
  const [text, setText] = useState(initial.text);
  const [model, setModel] = useState(initial.model);
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>(initial.reasoningEffort);
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(initial.permissionMode);
  const [selectedSkills, setSelectedSkills] = useState<string[]>(initial.selectedSkills);
  const [attachments, setAttachments] = useState<ChatAttachmentRef[]>(initial.attachments);
  const [researchObjectIds, setResearchObjectIds] = useState<string[]>(initial.researchObjectIds);
  const [mentionedAgentIds, setMentionedAgentIds] = useState<string[]>(initial.mentionedAgentIds);
  const [busy, setBusy] = useState(false);
  const [plusOpen, setPlusOpen] = useState(false);
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [projectSearch, setProjectSearch] = useState('');
  const [dragging, setDragging] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const composer = useRef<HTMLDivElement>(null);
  const plusTrigger = useRef<HTMLButtonElement>(null);
  const plusMenu = useRef<HTMLDivElement>(null);
  const projectTrigger = useRef<HTMLButtonElement>(null);
  const projectMenu = useRef<HTMLDivElement>(null);
  const currentSession = useRef(props.sessionKey);
  currentSession.current = props.sessionKey;
  const plusMenuStyle = useFloatingPosition({ open: plusOpen, anchorRef: plusTrigger, surfaceRef: plusMenu, placement: 'top-start' });
  const projectMenuStyle = useFloatingPosition({ open: projectMenuOpen, anchorRef: projectTrigger, surfaceRef: projectMenu, placement: 'top-start' });

  useEffect(() => {
    if (!props.sessionKey || props.sessionKey === loadedSessionKey) return;
    if (loadedSessionKey) persistTransientState(loadedSessionKey, { text, model, reasoningEffort, permissionMode, selectedSkills, attachments, researchObjectIds, mentionedAgentIds });
    const next = createTransientState(props.sessionKey, fallbackModel);
    setText(next.text);
    setModel(next.model);
    setReasoningEffort(next.reasoningEffort);
    setPermissionMode(next.permissionMode);
    setSelectedSkills(next.selectedSkills);
    setAttachments(next.attachments);
    setResearchObjectIds(next.researchObjectIds);
    setMentionedAgentIds(next.mentionedAgentIds);
    setPlusOpen(false);
    setProjectMenuOpen(false);
    setProjectSearch('');
    setLoadedSessionKey(props.sessionKey);
  }, [attachments, fallbackModel, loadedSessionKey, mentionedAgentIds, model, permissionMode, props.sessionKey, reasoningEffort, researchObjectIds, selectedSkills, text]);

  useEffect(() => {
    if (!props.sessionKey || loadedSessionKey !== props.sessionKey) return;
    persistTransientState(props.sessionKey, { text, model, reasoningEffort, permissionMode, selectedSkills, attachments, researchObjectIds, mentionedAgentIds });
  }, [attachments, loadedSessionKey, mentionedAgentIds, model, permissionMode, props.sessionKey, reasoningEffort, researchObjectIds, selectedSkills, text]);

  useEffect(() => {
    if (props.models.length > 0 && !props.models.some((item) => item.id === model)) setModel(props.models[0]!.id);
  }, [model, props.models]);
  const selectedModel = props.models.find((item) => item.id === model) ?? props.models[0];
  const reasoning = selectedModel?.reasoning ?? (selectedModel?.supportsThinking
    ? { mode: 'levels' as const, efforts: ['low', 'medium', 'high'] as ReasoningEffort[], defaultEffort: 'high' as const, canDisable: true }
    : { mode: 'unsupported' as const, efforts: [] as ReasoningEffort[], canDisable: false });
  const reasoningOptions = useMemo(() => {
    const option = (effort: ReasoningEffort) => ({ value: effort, label: copy.composer.reasoningLevels[effort], description: copy.composer.reasoningDescriptions[effort] });
    if (reasoning.mode === 'unsupported') return [{ value: 'none' as const, label: copy.composer.reasoningUnavailable, description: copy.composer.reasoningDescriptions.unsupported }];
    if (reasoning.mode === 'always') return [{ value: reasoning.defaultEffort ?? 'high', label: copy.composer.reasoningLevels.fixed, description: copy.composer.reasoningDescriptions.fixed }];
    if (reasoning.mode === 'toggle') return [...(reasoning.canDisable ? [option('none')] : []), { value: reasoning.defaultEffort ?? 'medium', label: copy.composer.reasoningLevels.enabled, description: copy.composer.reasoningDescriptions.enabled }];
    return [...(reasoning.canDisable ? [option('none')] : []), ...reasoning.efforts.map(option)];
  }, [reasoning.canDisable, reasoning.defaultEffort, reasoning.efforts, reasoning.mode]);
  useEffect(() => {
    if (!reasoningOptions.some((option) => option.value === reasoningEffort)) setReasoningEffort(reasoningOptions[0]?.value ?? 'none');
  }, [reasoningEffort, reasoningOptions]);
  useEffect(() => {
    const element = textarea.current;
    if (!element) return;
    if (props.composerHeight !== null && props.composerHeight !== undefined) {
      element.style.height = 'auto';
      return;
    }
    element.style.height = '0px';
    element.style.height = `${Math.min(190, Math.max(56, element.scrollHeight))}px`;
  }, [props.composerHeight, text]);

  useEffect(() => {
    if (!plusOpen) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!plusMenu.current?.contains(target) && !plusTrigger.current?.contains(target)) setPlusOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setPlusOpen(false);
      requestAnimationFrame(() => plusTrigger.current?.focus());
    };
    document.addEventListener('pointerdown', outside);
    window.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      window.removeEventListener('keydown', escape);
    };
  }, [plusOpen]);

  useEffect(() => {
    if (!projectMenuOpen) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!projectMenu.current?.contains(target) && !projectTrigger.current?.contains(target)) setProjectMenuOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setProjectMenuOpen(false);
      requestAnimationFrame(() => projectTrigger.current?.focus());
    };
    document.addEventListener('pointerdown', outside);
    window.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      window.removeEventListener('keydown', escape);
    };
  }, [projectMenuOpen]);

  const allAttachments = useMemo(() => {
    const values = [...attachments, ...props.injectedAttachments];
    return [...new Map(values.map((item) => [item.id, item])).values()];
  }, [attachments, props.injectedAttachments]);
  const canSend = (text.trim().length > 0 || allAttachments.length > 0 || researchObjectIds.length > 0 || props.quotedNodes.length > 0) && !busy && !props.running;

  const submit = async () => {
    if (!canSend) return;
    const submittedSession = loadedSessionKey;
    setBusy(true);
    try {
      await props.onSend(text.trim(), {
        model,
        thinking: reasoningEffort === 'none' ? 'disabled' : 'enabled',
        reasoningEffort,
        permissionMode,
        ...(selectedSkills.length ? { skillIds: selectedSkills } : {}),
        ...(allAttachments.length ? { attachments: allAttachments } : {}),
        ...(researchObjectIds.length ? { researchObjectIds } : {}),
        ...(mentionedAgentIds.length ? { mentionedAgentIds } : {}),
        ...(props.quotedNodes.length ? { quotedNodeIds: props.quotedNodes.map((item) => item.id) } : {}),
      });
      if (!submittedSession || currentSession.current === submittedSession) {
        setText(''); setSelectedSkills([]); setAttachments([]); setResearchObjectIds([]); setMentionedAgentIds([]);
      } else {
        transientSessions.delete(submittedSession);
        try { sessionStorage.removeItem(draftKey(submittedSession)); } catch { /* Optional persistence. */ }
      }
      props.onClearInjected();
    } finally { setBusy(false); }
  };

  const chooseAttachments = async () => {
    const selected = await window.openlab?.chooseAttachments() ?? [];
    setAttachments((current) => [...new Map([...current, ...selected].map((item) => [item.id, item])).values()].slice(0, 10));
    setPlusOpen(false);
  };

  const beginResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!props.onComposerHeightChange || !composer.current) return;
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = composer.current.getBoundingClientRect().height;
    const move = (pointer: PointerEvent) => props.onComposerHeightChange?.(clampComposerHeight(startHeight + startY - pointer.clientY));
    const finish = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish, { once: true });
    window.addEventListener('pointercancel', finish, { once: true });
  };

  const plusSurface = plusOpen && createPortal(<div ref={plusMenu} className="composer-plus__menu floating-composer-menu" style={plusMenuStyle} data-testid="composer-plus-menu">
    <button onClick={() => void chooseAttachments()}><Paperclip size={15}/><span><strong>{copy.composer.uploadFile}</strong><small>{copy.composer.copyToConversation}</small></span></button>
    <button onClick={() => { props.onOpenWorkspace(); setPlusOpen(false); }}><FolderOpen size={15}/><span><strong>{copy.composer.referenceWorkspace}</strong><small>{copy.composer.browseAuthorizedFiles}</small></span></button>
    <label><AtSign size={15}/><span><strong>{copy.composer.mentionAgent}</strong><small>{copy.composer.addExecutor}</small></span><select value="" onChange={(event) => { if (event.target.value) setMentionedAgentIds((items) => [...new Set([...items, event.target.value])]); setPlusOpen(false); }}><option value="">{copy.composer.select}</option>{props.agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label>
    <label><Link2 size={15}/><span><strong>{copy.composer.referenceResearch}</strong><small>{copy.composer.relateEvidence}</small></span><select value="" onChange={(event) => { if (event.target.value) setResearchObjectIds((items) => [...new Set([...items, event.target.value])]); setPlusOpen(false); }}><option value="">{copy.composer.select}</option>{props.researchObjects.map((object) => <option key={object.id} value={object.id}>{object.title}</option>)}</select></label>
  </div>, document.body);

  const normalizedProjectSearch = projectSearch.trim().toLocaleLowerCase();
  const projectMatches = !normalizedProjectSearch || props.projectContext?.name.toLocaleLowerCase().includes(normalizedProjectSearch);
  const showProjectContext = Boolean(props.projectContext || props.onCreateProject);
  const projectSurface = props.projectContext && projectMenuOpen && createPortal(<div
    ref={projectMenu}
    className="composer-project-menu"
    style={projectMenuStyle}
    data-testid="composer-project-menu"
    role="menu"
    aria-label={copy.composer.chooseProject}
  >
    <label className="composer-project-menu__search"><Search size={15}/><input autoFocus value={projectSearch} placeholder={copy.composer.searchProjects} aria-label={copy.composer.searchProjects} onChange={(event) => setProjectSearch(event.target.value)}/></label>
    <div className="composer-project-menu__section">
      {projectMatches ? <button type="button" className="composer-project-menu__project is-active" role="menuitem" onClick={() => setProjectMenuOpen(false)}>
        <FolderOpen size={17}/><span><strong>{props.projectContext.name}</strong><small>{copy.composer.currentProject}</small></span><Check size={15}/>
      </button> : <p>{copy.composer.noProjectMatches}</p>}
    </div>
    <div className="composer-project-menu__actions">
      {props.onOpenProjectContext && <button type="button" role="menuitem" onClick={() => { setProjectMenuOpen(false); props.onOpenProjectContext?.(); }}><FolderOpen size={17}/><span>{copy.composer.openProject}</span></button>}
      {props.onCreateProject && <button type="button" role="menuitem" onClick={() => { setProjectMenuOpen(false); props.onCreateProject?.(); }}><FolderPlus size={17}/><span>{copy.composer.newProject}</span></button>}
      {props.onLeaveProject && <button type="button" role="menuitem" onClick={() => { setProjectMenuOpen(false); void props.onLeaveProject?.(); }}><FolderX size={17}/><span>{copy.composer.workWithoutProject}</span></button>}
    </div>
  </div>, document.body);

  return <div className={`composer-wrap ${showProjectContext ? 'has-project-context' : ''}`}>
    {showProjectContext && <div className={`composer-project-context ${props.projectContext ? '' : 'is-empty'}`} data-testid="composer-project-context" aria-label={copy.composer.projectContext}>
      <button ref={projectTrigger} type="button" title={props.projectContext ? copy.composer.chooseProject : copy.composer.newProject} aria-haspopup={props.projectContext ? 'menu' : undefined} aria-expanded={props.projectContext ? projectMenuOpen : undefined} onClick={() => {
        setPlusOpen(false);
        if (!props.projectContext) { props.onCreateProject?.(); return; }
        setProjectSearch('');
        setProjectMenuOpen((value) => !value);
      }}>{props.projectContext ? <FolderOpen size={16}/> : <FolderPlus size={16}/>}<strong>{props.projectContext?.name ?? copy.composer.noWorkspace}</strong>{props.projectContext && <ChevronDown size={13}/>}</button>{projectSurface}
      {props.projectContext && <span><Monitor size={15}/><strong>{props.projectContext.location}</strong></span>}
      {props.projectContext?.gitBranch && <span><GitBranch size={15}/><strong>{props.projectContext.gitBranch}</strong></span>}
    </div>}
    <div ref={composer} className={`composer ${props.running ? 'is-running' : ''} ${dragging ? 'is-dragging' : ''} ${props.composerHeight ? 'has-custom-height' : ''}`} style={props.composerHeight ? { height: props.composerHeight } : undefined} onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={(event) => {
      event.preventDefault(); setDragging(false);
      const files = [...event.dataTransfer.files].slice(0, 10);
      if (files.length) void window.openlab?.importDroppedAttachments(files).then((items) => setAttachments((current) => [...new Map([...current, ...items].map((item) => [item.id, item])).values()].slice(0, 10)));
    }}>
      {props.onComposerHeightChange && <div className="composer-resize-handle" data-testid="composer-resize-handle" role="separator" aria-label={copy.composer.resizeHeight} aria-orientation="horizontal" tabIndex={0} onPointerDown={beginResize} onDoubleClick={() => props.onComposerHeightChange?.(null)} onKeyDown={(event) => {
        if (!['ArrowUp', 'ArrowDown', 'Home'].includes(event.key)) return;
        event.preventDefault();
        if (event.key === 'Home') props.onComposerHeightChange?.(null);
        else props.onComposerHeightChange?.(clampComposerHeight((props.composerHeight ?? composer.current?.getBoundingClientRect().height ?? 112) + (event.key === 'ArrowUp' ? 8 : -8)));
      }}><GripHorizontal size={14}/></div>}
      {(selectedSkills.length > 0 || allAttachments.length > 0 || researchObjectIds.length > 0 || mentionedAgentIds.length > 0 || props.quotedNodes.length > 0) && <div className="composer-chips">
        {allAttachments.map((attachment) => <button key={attachment.id} onClick={() => props.injectedAttachments.some((item) => item.id === attachment.id) ? props.onRemoveInjectedAttachment(attachment.id) : setAttachments((items) => items.filter((item) => item.id !== attachment.id))}><Paperclip size={12}/>{attachment.name}<X size={11}/></button>)}
        {props.quotedNodes.map((item) => <button key={item.id} onClick={() => props.onRemoveQuotedNode(item.id)}><MessageSquareQuote size={12}/>{item.label}<X size={11}/></button>)}
        {researchObjectIds.map((id) => <button key={id} onClick={() => setResearchObjectIds((items) => items.filter((item) => item !== id))}><Link2 size={12}/>{props.researchObjects.find((object) => object.id === id)?.title ?? id}<X size={11}/></button>)}
        {mentionedAgentIds.map((id) => <button key={id} onClick={() => setMentionedAgentIds((items) => items.filter((item) => item !== id))}><AtSign size={12}/>{props.agents.find((agent) => agent.id === id)?.name ?? id}<X size={11}/></button>)}
        {selectedSkills.map((id) => <button key={id} onClick={() => setSelectedSkills((items) => items.filter((item) => item !== id))}><WandSparkles size={12}/>{props.skills.find((skill) => skill.id === id)?.name ?? id}<X size={11}/></button>)}
      </div>}
      <textarea ref={textarea} data-testid={props.testId ?? 'composer-input'} value={text} onChange={(event) => setText(event.target.value)} placeholder={copy.composer.placeholder} rows={2} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); } }}/>
      <div className="composer__toolbar">
        <div className="composer__tools">
          <div className="composer-plus"><button ref={plusTrigger} className={plusOpen ? 'is-active' : ''} title={copy.composer.addContent} aria-haspopup="menu" aria-expanded={plusOpen} onClick={() => setPlusOpen((value) => !value)}><Plus size={18}/></button>{plusSurface}</div>
          <label className="composer-control skill"><Sparkles size={14}/><select aria-label={copy.composer.loadSkill} value="" onChange={(event) => event.target.value && setSelectedSkills((items) => [...new Set([...items, event.target.value])])}><option value="">{copy.composer.skill}</option>{props.skills.filter((skill) => skill.enabled).map((skill) => <option key={skill.id} value={skill.id}>{skill.name}</option>)}</select><ChevronDown size={12}/></label>
        </div>
        <div className="composer__options">
          <ReasoningPicker value={reasoningEffort} label={copy.composer.reasoning} options={reasoningOptions} onChange={setReasoningEffort} onOpen={() => setPlusOpen(false)}/>
          <ModelPicker models={props.models} value={model} label={copy.composer.model} onChange={setModel} onOpen={() => setPlusOpen(false)}/>
          <label className="composer-control permission"><Shield size={14}/><select aria-label={copy.composer.permissionMode} value={permissionMode} onChange={(event) => setPermissionMode(event.target.value as PermissionMode)}><option value="ask">{copy.composer.ask}</option><option value="read_only">{copy.composer.readOnly}</option><option value="trusted">{copy.composer.trusted}</option></select><ChevronDown size={12}/></label>
          {props.running ? <button data-testid="cancel-turn" className="send-button stop" title={copy.composer.stop} onClick={() => void props.onCancel()}><Square size={14} fill="currentColor"/></button> : <button data-testid="send-message" className="send-button" title={copy.composer.send} disabled={!canSend} onClick={() => void submit()}><Send size={16}/></button>}
        </div>
      </div>
      {dragging && <div className="composer-drop-overlay"><Paperclip size={19}/>{copy.composer.dropFiles}</div>}
    </div>
  </div>;
}
