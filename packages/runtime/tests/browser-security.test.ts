import { describe, expect, it } from 'vitest';
import { browserDomain, normalizeHttpsUrl, profilePartition, sanitizeAccessibilityTree } from '../../../apps/desktop/src/browser-security.js';

describe('worktable browser security helpers', () => {
  it('only accepts credential-free HTTPS URLs', () => {
    expect(normalizeHttpsUrl('https://user:secret@example.org/a#fragment')).toBe('https://example.org/a');
    expect(browserDomain('https://EXAMPLE.org/path')).toBe('example.org');
    expect(() => normalizeHttpsUrl('http://example.org')).toThrow(/HTTPS/u);
    expect(() => normalizeHttpsUrl('javascript:alert(1)')).toThrow();
  });

  it('creates stable non-identifying persistent partitions', () => {
    expect(profilePartition('profile-a')).toBe(profilePartition('profile-a'));
    expect(profilePartition('profile-a')).not.toContain('profile-a');
    expect(profilePartition('profile-a')).toMatch(/^persist:openlab-browser-[a-f0-9]{24}$/u);
  });

  it('redacts sensitive accessibility fields and keeps references host-side', () => {
    const result = sanitizeAccessibilityTree([
      { nodeId: '1', backendDOMNodeId: 10, role: { value: 'textbox' }, name: { value: 'Password' }, properties: [{ name: 'protected', value: { value: true } }] },
      { nodeId: '2', backendDOMNodeId: 11, role: { value: 'button' }, name: { value: 'Continue' } },
      { nodeId: '3', role: { value: 'StaticText' }, name: { value: 'Visible page text' } },
    ]);
    expect(result.text).toContain('Visible page text');
    expect(result.elements[0]).toMatchObject({ ref: 'e1', name: '[sensitive field]', sensitive: true, backendDOMNodeId: 10 });
    expect(result.elements[1]).toMatchObject({ ref: 'e2', name: 'Continue', backendDOMNodeId: 11 });
  });
});
