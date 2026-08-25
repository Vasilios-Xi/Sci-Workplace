import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Lightbulb } from 'lucide-react';
import type { ReasoningEffort } from '@openlab/protocol';
import { useFloatingPosition } from '../lib/floating-position.js';

export interface ReasoningPickerOption {
  value: ReasoningEffort;
  label: string;
  description: string;
}

interface ReasoningPickerProps {
  value: ReasoningEffort;
  label: string;
  options: ReasoningPickerOption[];
  onChange(value: ReasoningEffort): void;
  onOpen?(): void;
}

export function ReasoningPicker({ value, label, options, onChange, onOpen }: ReasoningPickerProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const selected = options.find((option) => option.value === value) ?? options[0];
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

  return <div
    ref={rootRef}
    className={`composer-control reasoning-picker ${open ? 'is-open' : ''}`}
  >
    <button
      ref={triggerRef}
      type="button"
      className="reasoning-picker__trigger"
      data-testid="reasoning-picker"
      aria-label={label}
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-controls={open ? menuId : undefined}
      title={`${label} · ${selected?.description ?? ''}`}
      onClick={() => open ? close() : openMenu()}
      onKeyDown={(event) => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          if (!open) openMenu();
        }
      }}
    ><Lightbulb size={14}/></button>
    {open && createPortal(<div
      ref={menuRef}
      id={menuId}
      className="reasoning-picker__menu"
      style={menuStyle}
      data-testid="reasoning-picker-menu"
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
        className={option.value === value ? 'is-selected' : ''}
        data-effort={option.value}
        onClick={() => {
          onChange(option.value);
          close(true);
        }}
      ><span>{option.label}</span><small>{option.description}</small></button>)}
    </div>, document.body)}
  </div>;
}
