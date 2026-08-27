import { describe, expect, it } from 'vitest';
import { hanaZhCN } from '../src/i18n/zh-CN.js';

describe('new-conversation draft copy', () => {
  it('describes the absence of a selected project as working outside a project', () => {
    expect(hanaZhCN.timeline.noProject).toBe('不在项目中工作');
  });

  it('identifies the memory switch as belonging to the selected Agent', () => {
    expect(hanaZhCN.timeline.memoryToggleHint('小兮')).toContain('小兮 的专属记忆');
    expect(hanaZhCN.timeline.memoryEnabled).toBe('记忆启用');
    expect(hanaZhCN.timeline.memoryDisabled).toBe('记忆停用');
  });

  it('orders project creation before existing projects in the draft picker copy', () => {
    expect(hanaZhCN.timeline.newProject).toBe('新建项目');
    expect(hanaZhCN.timeline.existingProjects).toBe('已有项目');
  });

  it('explains when an enabled thinking run has no provider summary instead of hiding the row', () => {
    expect(hanaZhCN.timeline.thinking).toBe('思考中');
    expect(hanaZhCN.timeline.thoughtComplete).toBe('思考完成');
    expect(hanaZhCN.timeline.reasoningUnavailable).toContain('没有返回可展示的思考摘要');
  });
});
