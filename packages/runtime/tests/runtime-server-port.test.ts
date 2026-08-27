import { describe, expect, it } from 'vitest';
import { isBrowserSafeLoopbackPort } from '../src/server/runtime-server.js';

describe('Runtime browser port selection', () => {
  it('rejects Chromium restricted ports that the OS may allocate ephemerally', () => {
    expect(isBrowserSafeLoopbackPort(6000)).toBe(false);
    expect(isBrowserSafeLoopbackPort(6667)).toBe(false);
    expect(isBrowserSafeLoopbackPort(10080)).toBe(false);
  });

  it('accepts ordinary loopback application ports', () => {
    expect(isBrowserSafeLoopbackPort(8080)).toBe(true);
    expect(isBrowserSafeLoopbackPort(49_152)).toBe(true);
    expect(isBrowserSafeLoopbackPort(65_535)).toBe(true);
  });

  it('rejects invalid TCP port values', () => {
    expect(isBrowserSafeLoopbackPort(0)).toBe(false);
    expect(isBrowserSafeLoopbackPort(65_536)).toBe(false);
    expect(isBrowserSafeLoopbackPort(1.5)).toBe(false);
  });
});
