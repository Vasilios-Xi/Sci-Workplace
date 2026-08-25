import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Aperture, AudioWaveform, Bot, BrainCircuit, ChevronDown, FishSymbol, Moon, Orbit, Server,
} from 'lucide-react';
import type { ModelDescriptor, ModelProviderId } from '@openlab/protocol';
import { useFloatingPosition } from '../lib/floating-position.js';

type ProviderGroupId = ModelProviderId | 'openlab';

interface ModelGroup {
  id: ProviderGroupId;
  label: string;
  models: ModelDescriptor[];
}

const PROVIDER_LABELS: Record<ProviderGroupId, string> = {
  'chatgpt-oauth': 'OPENAI-CODEX',
  'grok-oauth': 'XAI GROK',
  'minimax-coding-plan': 'MINIMAX CODING PLAN',
  'kimi-coding-plan': 'KIMI CODING PLAN',
  'glm-coding-plan': 'GLM CODING PLAN',
  deepseek: 'DEEPSEEK',
  ollama: 'OLLAMA',
  'lm-studio': 'LM STUDIO · BIONIC',
  openlab: 'OPENLAB',
};

const PROVIDER_IDS = new Set<ModelProviderId>([
  'chatgpt-oauth', 'grok-oauth', 'minimax-coding-plan', 'kimi-coding-plan', 'glm-coding-plan',
  'deepseek', 'ollama', 'lm-studio',
]);

function providerIdFor(model: ModelDescriptor): ProviderGroupId {
  if (model.providerId) return model.providerId;
  const prefix = model.id.split('::', 1)[0];
  return PROVIDER_IDS.has(prefix as ModelProviderId) ? prefix as ModelProviderId : 'openlab';
}

export function groupModelsByProvider(models: ModelDescriptor[]): ModelGroup[] {
  const groups = new Map<ProviderGroupId, ModelGroup>();
  for (const model of models) {
    const providerId = providerIdFor(model);
    const group = groups.get(providerId) ?? { id: providerId, label: PROVIDER_LABELS[providerId], models: [] };
    group.models.push(model);
    groups.set(providerId, group);
  }
  return [...groups.values()];
}

function ProviderMark({ providerId }: { providerId: ProviderGroupId }) {
  if (providerId === 'deepseek') return <FishSymbol size={15}/>;
  if (providerId === 'chatgpt-oauth') return <Aperture size={15}/>;
  if (providerId === 'grok-oauth') return <Orbit size={15}/>;
  if (providerId === 'minimax-coding-plan') return <AudioWaveform size={15}/>;
  if (providerId === 'kimi-coding-plan') return <Moon size={15}/>;
  if (providerId === 'glm-coding-plan') return <BrainCircuit size={15}/>;
  if (providerId === 'lm-studio') return <Server size={15}/>;
  return <Bot size={15}/>;
}

interface ModelPickerProps {
  models: ModelDescriptor[];
  value: string;
  label: string;
  onChange(value: string): void;
  onOpen?(): void;
}

export function ModelPicker({ models, value, label, onChange, onOpen }: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const groups = useMemo(() => groupModelsByProvider(models), [models]);
  const selected = models.find((model) => model.id === value) ?? models[0];
  const menuStyle = useFloatingPosition({ open, anchorRef: triggerRef, surfaceRef: menuRef, placement: 'top-end' });

  const close = (restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus());
  };

  const openMenu = () => {
    onOpen?.();
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false);
    };
    document.addEventListener('pointerdown', handlePointerDown);
    const focusTimer = window.setTimeout(() => {
      const selectedOption = menuRef.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]');
      (selectedOption ?? menuRef.current?.querySelector<HTMLButtonElement>('[role="option"]'))?.focus();
    }, 0);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener('pointerdown', handlePointerDown);
    };
  }, [open]);

  const handleMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close(true);
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const options = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? [])];
    if (options.length === 0) return;
    const activeIndex = options.indexOf(document.activeElement as HTMLButtonElement);
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? options.length - 1
        : event.key === 'ArrowDown'
          ? (activeIndex + 1 + options.length) % options.length
          : (activeIndex - 1 + options.length) % options.length;
    options[nextIndex]?.focus();
  };

  return <div
    ref={rootRef}
    className={`composer-control model model-picker ${open ? 'is-open' : ''}`}
  >
    <button
      ref={triggerRef}
      type="button"
      className="model-picker__trigger"
      data-testid="model-picker"
      aria-label={label}
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-controls={open ? menuId : undefined}
      title={selected?.label ?? label}
      onClick={() => open ? close() : openMenu()}
      onKeyDown={(event) => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          if (!open) openMenu();
        }
      }}
    >
      <span>{selected?.label ?? label}</span>
      <ChevronDown size={11}/>
    </button>
    {open && createPortal(<div
      ref={menuRef}
      id={menuId}
      className="model-picker__menu"
      style={menuStyle}
      data-testid="model-picker-menu"
      role="listbox"
      aria-label={label}
      onKeyDown={handleMenuKeyDown}
    >
      {groups.map((group) => <section key={group.id} className="model-picker__group" role="group" aria-label={group.label}>
        <header><ProviderMark providerId={group.id}/><span>{group.label}</span></header>
        <div>
          {group.models.map((model) => <button
            key={model.id}
            type="button"
            role="option"
            autoFocus={model.id === value}
            aria-selected={model.id === value}
            className={model.id === value ? 'is-selected' : ''}
            data-model-id={model.id}
            onClick={() => {
              onChange(model.id);
              close(true);
            }}
          >{model.label}</button>)}
        </div>
      </section>)}
    </div>, document.body)}
  </div>;
}
