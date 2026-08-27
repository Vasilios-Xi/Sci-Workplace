import { createPortal } from 'react-dom';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import { chatShellZhCN as copy } from '../i18n/zh-CN.js';

export interface ShortcutItem {
  label: string;
  keys: string[];
}

export interface ShortcutGroup {
  title: string;
  items: ShortcutItem[];
}

export function KeyboardShortcutsDialog({ open, groups, onClose }: {
  open: boolean;
  groups: ShortcutGroup[];
  onClose(): void;
}) {
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase('zh-CN');
    if (!normalized) return groups;
    return groups.map((group) => ({
      ...group,
      items: group.items.filter((item) => `${item.label} ${item.keys.join(' ')}`.toLocaleLowerCase('zh-CN').includes(normalized)),
    })).filter((group) => group.items.length > 0);
  }, [groups, query]);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [onClose, open]);

  if (!open) return null;
  return createPortal(<div className="shell-dialog-backdrop" role="presentation" onPointerDown={(event) => {
    if (event.target === event.currentTarget) onClose();
  }}>
    <section className="keyboard-shortcuts-dialog" role="dialog" aria-modal="true" aria-labelledby="keyboard-shortcuts-title">
      <header><h2 id="keyboard-shortcuts-title">{copy.shortcuts.title}</h2><button aria-label={copy.shortcuts.close} onClick={onClose}><X size={18}/></button></header>
      <label className="keyboard-shortcuts-search"><Search size={16}/><input ref={inputRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={copy.shortcuts.search}/></label>
      <div className="keyboard-shortcuts-list">
        {filtered.map((group) => <section key={group.title} className="keyboard-shortcuts-group">
          <h3>{group.title}</h3>
          {group.items.map((item) => <div key={item.label} className="keyboard-shortcuts-row"><span>{item.label}</span><span>{item.keys.map((combination, index) => <span className="keyboard-shortcuts-combination" key={combination}>{index > 0 && <em>{copy.shortcuts.alternative}</em>}{combination.split('+').map((key) => <kbd key={`${combination}-${key}`}>{key}</kbd>)}</span>)}</span></div>)}
        </section>)}
        {filtered.length === 0 && <p className="keyboard-shortcuts-empty">{copy.shortcuts.noMatches}</p>}
      </div>
    </section>
  </div>, document.body);
}

export function ShellInfoDialog({ open, title, lines, actionLabel, onAction, onClose }: {
  open: boolean;
  title: string;
  lines: string[];
  actionLabel?: string;
  onAction?(): void;
  onClose(): void;
}) {
  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onClose, open]);

  if (!open) return null;
  return createPortal(<div className="shell-dialog-backdrop" role="presentation" onPointerDown={(event) => {
    if (event.target === event.currentTarget) onClose();
  }}>
    <section className="shell-info-dialog" role="dialog" aria-modal="true" aria-labelledby="shell-info-title">
      <header><h2 id="shell-info-title">{title}</h2><button aria-label={copy.shortcuts.close} onClick={onClose}><X size={18}/></button></header>
      <div>{lines.map((line) => <p key={line}>{line}</p>)}</div>
      {actionLabel && onAction && <footer><button onClick={() => { onAction(); onClose(); }}>{actionLabel}</button></footer>}
    </section>
  </div>, document.body);
}
