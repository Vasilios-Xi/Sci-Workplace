import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { BookOpen, CircleHelp, Shield, SquareTerminal } from 'lucide-react';
import type { PermissionMode } from '@openlab/protocol';
import { useFloatingPosition } from '../lib/floating-position.js';

export interface PermissionPickerOption {
  value: PermissionMode;
  label: string;
  description: string;
}

interface PermissionPickerProps {
  value: PermissionMode;
  label: string;
  options: PermissionPickerOption[];
  onChange(value: PermissionMode): void;
  onOpen?(): void;
}

function PermissionIcon({ mode, size = 16 }: { mode: PermissionMode; size?: number }) {
  if (mode === 'trusted') return <SquareTerminal size={size}/>;
  if (mode === 'ask') return <CircleHelp size={size}/>;
  if (mode === 'read_only') return <BookOpen size={size}/>;
  return <Shield size={size}/>;
}

export function PermissionPicker({ value, label, options, onChange, onOpen }: PermissionPickerProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const selected = options.find((option) => option.value === value) ?? options[0];
  const menuStyle = useFloatingPosition({ open, anchorRef: triggerRef, surfaceRef: menuRef, placement: 'top-start' });

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
    const optionElements = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? [])];
    if (optionElements.length === 0) return;
    const activeIndex = optionElements.indexOf(document.activeElement as HTMLButtonElement);
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? optionElements.length - 1
        : event.key === 'ArrowDown'
          ? (activeIndex + 1 + optionElements.length) % optionElements.length
          : (activeIndex - 1 + optionElements.length) % optionElements.length;
    optionElements[nextIndex]?.focus();
  };

  return <div ref={rootRef} className={`composer-control permission-picker tone-${value} ${open ? 'is-open' : ''}`}>
    <button
      ref={triggerRef}
      type="button"
      className="permission-picker__trigger"
      data-testid="composer-permission"
      aria-label={label}
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-controls={open ? menuId : undefined}
      title={`${selected?.label ?? label} · ${selected?.description ?? ''}`}
      onClick={() => open ? close() : openMenu()}
      onKeyDown={(event) => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          if (!open) openMenu();
        }
      }}
    ><PermissionIcon mode={value} size={15}/></button>
    {open && createPortal(<div
      ref={menuRef}
      id={menuId}
      className="permission-picker__menu"
      style={menuStyle}
      data-testid="permission-picker-menu"
      role="listbox"
      aria-label={label}
      onKeyDown={handleMenuKeyDown}
    >
      {options.map((option) => <button
        key={option.value}
        type="button"
        role="option"
        autoFocus={option.value === value}
        aria-selected={option.value === value}
        className={`tone-${option.value} ${option.value === value ? 'is-selected' : ''}`}
        data-permission-mode={option.value}
        title={option.description}
        onClick={() => {
          onChange(option.value);
          close(true);
        }}
      ><span className="permission-picker__option-icon" aria-hidden="true"><PermissionIcon mode={option.value}/></span><span className="permission-picker__option-label">{option.label}</span></button>)}
    </div>, document.body)}
  </div>;
}
