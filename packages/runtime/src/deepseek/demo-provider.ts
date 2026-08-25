import type { ModelDescriptor, ModelEvent, ModelProvider, ModelRequest } from '@openlab/protocol';

const DEMO_MODELS: ModelDescriptor[] = [
  { id: 'openlab-demo', label: 'Sci Workplace 离线演示', contextWindow: 128_000, supportsThinking: true, supportsTools: true, supportsVision: false },
];

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  });
}

export class DemoProvider implements ModelProvider {
  readonly id = 'demo';

  async listModels(): Promise<ModelDescriptor[]> {
    return DEMO_MODELS;
  }

  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    const last = [...request.messages].reverse().find((message) => message.role === 'user');
    const input = typeof last?.content === 'string' ? last.content : '当前任务';
    const reasoning = '正在识别任务目标、可用上下文与需要保留的证据链。';
    for (const part of reasoning.match(/.{1,8}/gu) ?? []) {
      await sleep(24, signal);
      yield { type: 'reasoning_delta', text: part };
    }
    const answer = `已收到“${input.slice(0, 80)}”。\n\n当前处于离线演示模式：会话事件、上下文计划、多 Agent 任务板和科研对象溯源均在本地运行。配置 DeepSeek API Key 后，同一条运行链路会切换为真实模型，并继续沿用当前项目与权限设置。`;
    for (const part of answer.match(/.{1,10}/gu) ?? []) {
      await sleep(18, signal);
      yield { type: 'text_delta', text: part };
    }
    yield {
      type: 'usage',
      usage: { promptTokens: 820, completionTokens: 112, totalTokens: 932, cacheHitTokens: 604, cacheMissTokens: 216, reasoningTokens: 28 },
    };
    yield { type: 'done', finishReason: 'stop' };
  }
}
