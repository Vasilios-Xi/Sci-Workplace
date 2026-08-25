import type { HTMLAttributes, ReactNode } from 'react';
import type { SemanticColorRole } from '@openlab/protocol';
import { semanticStatusZhCN } from '../i18n/zh-CN.js';

function classes(base: string, role: SemanticColorRole, className?: string): string {
  return [base, `semantic-${role}`, className].filter(Boolean).join(' ');
}

export function SemanticIcon({
  role = 'neutral',
  className,
  children,
  ...props
}: Omit<HTMLAttributes<HTMLSpanElement>, 'role'> & { role?: SemanticColorRole; children: ReactNode }) {
  return <span className={classes('semantic-icon', role, className)} {...props}>{children}</span>;
}

export function SemanticStatus({
  role = 'neutral',
  className,
  children,
  ...props
}: Omit<HTMLAttributes<HTMLSpanElement>, 'role'> & { role?: SemanticColorRole; children: ReactNode }) {
  return <span className={classes('semantic-status', role, className)} {...props}>{children}</span>;
}

export function semanticRoleForStatus(status: string | undefined): SemanticColorRole {
  const normalized = status?.trim().toLowerCase().replace(/[\s_-]+/gu, '') ?? '';
  if (['completed', 'complete', 'connected', 'approved', 'configured', 'success', 'succeeded'].includes(normalized) || (semanticStatusZhCN.success as readonly string[]).includes(normalized)) return 'success';
  if (['waiting', 'running', 'streaming', 'pending', 'queued', 'paused', 'approval'].includes(normalized) || (semanticStatusZhCN.warning as readonly string[]).includes(normalized)) return 'warning';
  if (['failed', 'error', 'interrupted', 'denied', 'rejected', 'unavailable', 'cancelled', 'canceled'].includes(normalized) || (semanticStatusZhCN.danger as readonly string[]).includes(normalized)) return 'danger';
  return 'neutral';
}
