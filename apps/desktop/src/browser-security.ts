import { createHash } from 'node:crypto';

export interface AxNodeLike {
  nodeId?: string;
  backendDOMNodeId?: number;
  ignored?: boolean;
  role?: { value?: unknown };
  name?: { value?: unknown };
  value?: { value?: unknown };
  properties?: Array<{ name?: string; value?: { value?: unknown } }>;
}

export interface BrowserElementObservation {
  ref: string;
  role: string;
  name: string;
  disabled?: boolean;
  sensitive?: boolean;
  backendDOMNodeId?: number;
}

export const BROWSER_AUTOMATION_ACTIONS = ['click', 'type', 'select', 'press', 'scroll'] as const;
export type BrowserAutomationAction = (typeof BROWSER_AUTOMATION_ACTIONS)[number];

const BROWSER_AUTOMATION_ACTION_SET = new Set<string>(BROWSER_AUTOMATION_ACTIONS);

export function parseBrowserAutomationAction(value: unknown): BrowserAutomationAction {
  if (typeof value !== 'string' || !BROWSER_AUTOMATION_ACTION_SET.has(value)) {
    throw new Error('Browser action is invalid');
  }
  return value as BrowserAutomationAction;
}

const INTERACTIVE_ROLES = new Set([
  'button', 'checkbox', 'combobox', 'link', 'listbox', 'menuitem', 'option',
  'radio', 'searchbox', 'slider', 'spinbutton', 'switch', 'tab', 'textbox',
]);

const SECRET_AUTOCOMPLETE = /^(?:current-password|new-password|one-time-code|cc-number|cc-csc|cc-exp|cc-exp-month|cc-exp-year)$/u;
const SECRET_LANGUAGE = /\b(?:password|passcode|one[ -]?time(?: code| password)?|otp|verification code|security code|card number|credit card|cvv|cvc|two[ -]?factor|2fa)\b|\u5bc6\u7801|\u53e3\u4ee4|\u9a8c\u8bc1\u7801|\u52a8\u6001\u7801|\u5b89\u5168\u7801|\u4fe1\u7528\u5361|\u94f6\u884c\u5361|\u53cc\u91cd\u9a8c\u8bc1|\u4e8c\u6b21\u9a8c\u8bc1/u;
const HIGH_RISK_ACTION = /\b(?:pay|payment|purchase|buy now|place order|checkout|transfer money|wire transfer|confirm transaction)\b|\u652f\u4ed8|\u4ed8\u6b3e|\u8d2d\u4e70|\u4e0b\u5355|\u7ed3\u7b97|\u8f6c\u8d26|\u786e\u8ba4\u4ea4\u6613/u;

export function normalizeHttpsUrl(raw: string): string {
  if (typeof raw !== 'string' || raw.length > 4_096) throw new Error('Browser URL is invalid');
  const parsed = new URL(raw);
  if (parsed.protocol !== 'https:') throw new Error('Browser navigation requires HTTPS');
  parsed.username = '';
  parsed.password = '';
  parsed.hash = '';
  return parsed.toString();
}

export function browserDomain(raw: string): string {
  return new URL(normalizeHttpsUrl(raw)).hostname.toLocaleLowerCase();
}

export function profilePartition(profileId: string): string {
  const suffix = createHash('sha256').update(profileId).digest('hex').slice(0, 24);
  return `persist:openlab-browser-${suffix}`;
}

function property(node: AxNodeLike, name: string): unknown {
  return node.properties?.find((candidate) => candidate.name === name)?.value?.value;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim().slice(0, 500) : '';
}

export function sanitizeAccessibilityTree(nodes: AxNodeLike[]): {
  text: string;
  elements: BrowserElementObservation[];
  sensitive: boolean;
} {
  const text: string[] = [];
  const elements: BrowserElementObservation[] = [];
  let counter = 0;
  let sensitiveContext = false;
  for (const node of nodes.slice(0, 5_000)) {
    if (!node || node.ignored) continue;
    const role = stringValue(node.role?.value).toLocaleLowerCase();
    const rawName = stringValue(node.name?.value);
    const protectedValue = property(node, 'protected') === true;
    const autocomplete = stringValue(property(node, 'autocomplete')).toLocaleLowerCase();
    const secretLanguage = SECRET_LANGUAGE.test(`${rawName} ${autocomplete}`.toLocaleLowerCase());
    const highRiskAction = INTERACTIVE_ROLES.has(role) && HIGH_RISK_ACTION.test(rawName.toLocaleLowerCase());
    const sensitive = protectedValue || SECRET_AUTOCOMPLETE.test(autocomplete) || secretLanguage || highRiskAction;
    if (sensitive) sensitiveContext = true;
    const name = sensitive ? '[sensitive field]' : rawName;
    if (['statictext', 'heading', 'paragraph', 'cell', 'listitem'].includes(role) && name) {
      text.push(sensitive ? '[sensitive content]' : name);
    }
    if (!INTERACTIVE_ROLES.has(role) || (!node.backendDOMNodeId && !node.nodeId)) continue;
    counter += 1;
    elements.push({
      ref: `e${counter}`,
      role: role || 'control',
      name,
      ...(property(node, 'disabled') === true ? { disabled: true } : {}),
      ...(sensitive ? { sensitive: true } : {}),
      ...(node.backendDOMNodeId ? { backendDOMNodeId: node.backendDOMNodeId } : {}),
    });
    if (elements.length >= 500) break;
  }
  return { text: text.join('\n').slice(0, 200_000), elements, sensitive: sensitiveContext };
}
