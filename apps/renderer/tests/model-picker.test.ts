import { describe, expect, it } from 'vitest';
import type { ModelDescriptor } from '@openlab/protocol';
import { groupModelsByProvider } from '../src/components/ModelPicker.js';

const model = (id: string, label: string, providerId: ModelDescriptor['providerId']): ModelDescriptor => ({
  id,
  label,
  providerId,
  contextWindow: 128_000,
  supportsThinking: true,
  supportsTools: true,
  supportsVision: false,
});

describe('shared model picker catalog', () => {
  it('groups every newly supplied model by provider without per-screen option markup', () => {
    const groups = groupModelsByProvider([
      model('chatgpt-oauth::gpt-5.6-sol', 'GPT-5.6-Sol', 'chatgpt-oauth'),
      model('deepseek::deepseek-v4-pro', 'DeepSeek V4 Pro', 'deepseek'),
      model('chatgpt-oauth::gpt-next', 'GPT Next', 'chatgpt-oauth'),
    ]);

    expect(groups.map((group) => group.label)).toEqual(['OPENAI-CODEX', 'DEEPSEEK']);
    expect(groups[0]?.models.map((item) => item.label)).toEqual(['GPT-5.6-Sol', 'GPT Next']);
    expect(groups[1]?.models.map((item) => item.label)).toEqual(['DeepSeek V4 Pro']);
  });
});
