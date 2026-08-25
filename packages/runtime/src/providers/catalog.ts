import type {
  ModelDescriptor,
  ModelProviderConfig,
  ModelProviderDefinition,
  ModelProviderId,
  ModelRequest,
  ReasoningEffort,
} from '@openlab/protocol';

export const PROVIDER_DEFINITIONS: ModelProviderDefinition[] = [
  { id: 'chatgpt-oauth', label: 'ChatGPT Plus / Pro', category: 'oauth', auth: 'oauth', docsUrl: 'https://learn.chatgpt.com/docs/app-server', local: false, configurableBaseUrl: false },
  { id: 'grok-oauth', label: 'xAI Grok', category: 'oauth', auth: 'oauth', docsUrl: 'https://docs.x.ai/build/enterprise', local: false, configurableBaseUrl: false },
  { id: 'minimax-coding-plan', label: 'MiniMax Coding Plan', category: 'coding_plan', auth: 'api_key', defaultBaseUrl: 'https://api.minimax.io/v1', docsUrl: 'https://platform.minimax.io/docs/token-plan/other-tools', local: false, configurableBaseUrl: false },
  { id: 'kimi-coding-plan', label: 'Kimi Coding Plan', category: 'coding_plan', auth: 'api_key', defaultBaseUrl: 'https://api.kimi.com/coding/v1', docsUrl: 'https://www.kimi.com/code/docs/en/', local: false, configurableBaseUrl: false },
  { id: 'glm-coding-plan', label: 'GLM Coding Plan', category: 'coding_plan', auth: 'api_key', defaultBaseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4', docsUrl: 'https://docs.bigmodel.cn/cn/coding-plan/quick-start', local: false, configurableBaseUrl: false, policyNotice: '套餐仅面向智谱官方支持的编码工具；Sci Workplace 会使用真实客户端标识，是否计入套餐额度由服务端决定。' },
  { id: 'deepseek', label: 'DeepSeek API', category: 'api', auth: 'api_key', defaultBaseUrl: 'https://api.deepseek.com', docsUrl: 'https://api-docs.deepseek.com/guides/thinking_mode/', local: false, configurableBaseUrl: true },
  { id: 'ollama', label: 'Ollama', category: 'api', auth: 'none', defaultBaseUrl: 'http://127.0.0.1:11434', docsUrl: 'https://docs.ollama.com/api/chat', local: true, configurableBaseUrl: true },
  { id: 'lm-studio', label: 'LM Studio · Bionic', category: 'api', auth: 'none', defaultBaseUrl: 'http://127.0.0.1:1234/v1', docsUrl: 'https://lmstudio.ai/docs/developer/rest', local: true, configurableBaseUrl: true },
];

export function definitionFor(id: ModelProviderId): ModelProviderDefinition {
  const definition = PROVIDER_DEFINITIONS.find((item) => item.id === id);
  if (!definition) throw new Error(`Unknown provider: ${id}`);
  return definition;
}

export function defaultProviderConfigs(): ModelProviderConfig[] {
  const timestamp = new Date(0).toISOString();
  return PROVIDER_DEFINITIONS.map((definition) => ({
    id: definition.id,
    enabled: definition.id === 'deepseek' || definition.id === 'ollama' || definition.id === 'lm-studio',
    ...(definition.defaultBaseUrl ? { baseUrl: definition.defaultBaseUrl } : {}),
    updatedAt: timestamp,
  }));
}

function descriptor(
  providerId: ModelProviderId,
  nativeId: string,
  label: string,
  contextWindow: number,
  options: Pick<ModelDescriptor, 'supportsThinking' | 'supportsTools' | 'supportsVision'> & Partial<Pick<ModelDescriptor, 'reasoning' | 'isDefault'>>,
): ModelDescriptor {
  return { id: `${providerId}::${nativeId}`, providerId, nativeId, label, contextWindow, ...options };
}

export const MINIMAX_MODELS: ModelDescriptor[] = [
  descriptor('minimax-coding-plan', 'MiniMax-M3', 'MiniMax M3', 1_048_576, { supportsThinking: true, supportsTools: true, supportsVision: true, reasoning: { mode: 'always', efforts: [], canDisable: false }, isDefault: true }),
  descriptor('minimax-coding-plan', 'MiniMax-M2.7', 'MiniMax M2.7', 204_800, { supportsThinking: true, supportsTools: true, supportsVision: false, reasoning: { mode: 'always', efforts: [], canDisable: false } }),
  descriptor('minimax-coding-plan', 'MiniMax-M2.7-highspeed', 'MiniMax M2.7 Highspeed', 204_800, { supportsThinking: true, supportsTools: true, supportsVision: false, reasoning: { mode: 'always', efforts: [], canDisable: false } }),
];

export const KIMI_MODELS: ModelDescriptor[] = [
  descriptor('kimi-coding-plan', 'k3', 'Kimi K3 · 1M', 1_048_576, { supportsThinking: true, supportsTools: true, supportsVision: true, reasoning: { mode: 'levels', efforts: ['low', 'high', 'max'], defaultEffort: 'high', canDisable: false }, isDefault: true }),
  descriptor('kimi-coding-plan', 'k3-256k', 'Kimi K3 · 256K', 262_144, { supportsThinking: true, supportsTools: true, supportsVision: true, reasoning: { mode: 'levels', efforts: ['low', 'high', 'max'], defaultEffort: 'high', canDisable: false } }),
  descriptor('kimi-coding-plan', 'kimi-for-coding', 'Kimi K2.7 Code', 262_144, { supportsThinking: true, supportsTools: true, supportsVision: true, reasoning: { mode: 'always', efforts: [], canDisable: false } }),
  descriptor('kimi-coding-plan', 'kimi-for-coding-highspeed', 'Kimi K2.7 Code Highspeed', 262_144, { supportsThinking: true, supportsTools: true, supportsVision: true, reasoning: { mode: 'always', efforts: [], canDisable: false } }),
];

export const GLM_MODELS: ModelDescriptor[] = [
  descriptor('glm-coding-plan', 'glm-5.2', 'GLM 5.2', 1_000_000, { supportsThinking: true, supportsTools: true, supportsVision: false, reasoning: { mode: 'levels', efforts: ['high', 'max'], defaultEffort: 'max', canDisable: true }, isDefault: true }),
  descriptor('glm-coding-plan', 'glm-5-turbo', 'GLM 5 Turbo', 200_000, { supportsThinking: true, supportsTools: true, supportsVision: false, reasoning: { mode: 'toggle', efforts: [], canDisable: true } }),
  descriptor('glm-coding-plan', 'glm-4.7', 'GLM 4.7', 200_000, { supportsThinking: true, supportsTools: true, supportsVision: false, reasoning: { mode: 'always', efforts: [], canDisable: false } }),
];

export const GROK_MODELS: ModelDescriptor[] = [
  descriptor('grok-oauth', 'grok-build', 'Grok Build', 1_000_000, { supportsThinking: true, supportsTools: false, supportsVision: true, reasoning: { mode: 'levels', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high', canDisable: false }, isDefault: true }),
  descriptor('grok-oauth', 'grok-4.6', 'Grok 4.6', 1_000_000, { supportsThinking: true, supportsTools: false, supportsVision: true, reasoning: { mode: 'levels', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high', canDisable: false } }),
];

export function kimiEffort(effort: ReasoningEffort): 'low' | 'high' | 'max' {
  if (['max', 'xhigh'].includes(effort)) return 'max';
  if (effort === 'low' || effort === 'minimal') return 'low';
  return 'high';
}

export function glmEffort(effort: ReasoningEffort): 'high' | 'max' {
  return ['max', 'xhigh'].includes(effort) ? 'max' : 'high';
}

export function compatibleRequestExtras(providerId: ModelProviderId, request: ModelRequest, nativeModel: string): Record<string, unknown> {
  if (providerId === 'minimax-coding-plan') return nativeModel.startsWith('MiniMax-M2') ? { reasoning_split: true } : {};
  if (providerId === 'kimi-coding-plan') {
    if (nativeModel.startsWith('k3')) return { thinking: { type: 'enabled' }, reasoning_effort: kimiEffort(request.reasoningEffort) };
    return { thinking: { type: 'enabled' } };
  }
  if (providerId === 'glm-coding-plan') {
    return request.thinking === 'disabled'
      ? { thinking: { type: 'disabled' } }
      : { thinking: { type: 'enabled' }, reasoning_effort: glmEffort(request.reasoningEffort), tool_stream: true };
  }
  if (providerId === 'lm-studio') {
    return { reasoning_effort: request.thinking === 'disabled' ? 'none' : request.reasoningEffort };
  }
  return {};
}
