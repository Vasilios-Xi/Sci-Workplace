import { describe, expect, it } from 'vitest';
import {
  parseBrowserAutomationAction,
  sanitizeAccessibilityTree,
} from '../src/browser-security.js';

describe('desktop browser security', () => {
  it('accepts only the fixed browser action enum', () => {
    expect(parseBrowserAutomationAction('click')).toBe('click');
    expect(parseBrowserAutomationAction('scroll')).toBe('scroll');
    expect(() => parseBrowserAutomationAction('executeJavaScript')).toThrow('Browser action is invalid');
    expect(() => parseBrowserAutomationAction(1)).toThrow('Browser action is invalid');
  });

  it('redacts credentials, verification codes, payment controls, and two-factor fields', () => {
    const result = sanitizeAccessibilityTree([
      { role: { value: 'StaticText' }, name: { value: 'Verification code 123456' } },
      { role: { value: 'textbox' }, name: { value: 'Account password' }, backendDOMNodeId: 1 },
      { role: { value: 'textbox' }, name: { value: 'Security token' }, backendDOMNodeId: 2, properties: [{ name: 'autocomplete', value: { value: 'one-time-code' } }] },
      { role: { value: 'button' }, name: { value: 'Pay now' }, backendDOMNodeId: 3 },
      { role: { value: 'button' }, name: { value: 'Read article' }, backendDOMNodeId: 4 },
    ]);

    expect(result.sensitive).toBe(true);
    expect(result.text).toContain('[sensitive content]');
    expect(result.text).not.toContain('123456');
    expect(result.elements).toEqual(expect.arrayContaining([
      expect.objectContaining({ ref: 'e1', sensitive: true, name: '[sensitive field]' }),
      expect.objectContaining({ sensitive: true, name: '[sensitive field]' }),
      expect.objectContaining({ role: 'button', name: 'Read article' }),
    ]));
  });
});
