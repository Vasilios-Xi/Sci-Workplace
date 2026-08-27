import { describe, expect, it } from 'vitest';
import {
  parseGeneratedSessionTitle,
  sessionTitleFallback,
  shouldRefineSessionTitle,
  shouldRepairGeneratedSessionTitle,
} from '../src/session-title.js';

describe('session titles', () => {
  it('uses the first meaningful user line as the immediate title', () => {
    expect(sessionTitleFallback('#  固态电池最新进展\n补充说明')).toBe('固态电池最新进展');
    expect(sessionTitleFallback('')).toBe('科研对话');
  });

  it('does not replace a greeting with a model-generated meta title', () => {
    expect(shouldRefineSessionTitle('你好')).toBe(false);
    expect(shouldRefineSessionTitle('您好，小弓！')).toBe(false);
    expect(shouldRepairGeneratedSessionTitle('科研对话标题生成方法', '你好')).toBe(true);
    expect(parseGeneratedSessionTitle('科研对话标题生成方法', '你好', '你好')).toBeUndefined();
  });

  it('accepts a concise topic title while stripping model formatting', () => {
    expect(shouldRefineSessionTitle('今天固态锂电池有什么新发展')).toBe(true);
    expect(parseGeneratedSessionTitle('标题：“固态锂电池最新进展”\n说明：略', '今天固态锂电池有什么新发展', '今天固态锂电池有什么新发展')).toBe('固态锂电池最新进展');
  });

  it('allows title-generation wording when that is the actual user topic', () => {
    expect(parseGeneratedSessionTitle('科研对话标题生成方法', '请研究如何生成科研对话标题', '请研究如何生成科研对话标题')).toBe('科研对话标题生成方法');
  });
});
