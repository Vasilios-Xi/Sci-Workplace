import AjvModule, { type ErrorObject, type ValidateFunction } from 'ajv';
import { Registry } from '@openlab/kernel';
import type { ArtifactProvenance, JsonValue, ToolDefinition, ToolExecutionResult } from '@openlab/protocol';
import { capabilityIdForTool } from './tool-capabilities.js';

export interface ToolExecutionContext {
  projectRoot: string;
  sessionId: string;
  agentId: string;
  traceId: string;
  callId: string;
  signal: AbortSignal;
  provenance: Omit<ArtifactProvenance, 'artifactId' | 'createdAt'>;
}

export interface RegisteredTool {
  definition: ToolDefinition;
  execute(input: Record<string, JsonValue>, context: ToolExecutionContext): Promise<ToolExecutionResult>;
}

interface AjvInstance {
  compile(schema: object): ValidateFunction;
  errorsText(errors?: ErrorObject[] | null, options?: { separator?: string }): string;
}

const AjvConstructor = AjvModule as unknown as new (options?: object) => AjvInstance;

export class ToolRegistry {
  readonly #registry = new Registry<RegisteredTool>();
  readonly #ajv = new AjvConstructor({ allErrors: true, strict: false });

  register(tool: RegisteredTool): () => void {
    if (!tool || typeof tool.definition !== 'object' || !/^[a-zA-Z0-9_-]{1,64}$/u.test(tool.definition.name)) throw new Error('工具名必须是 1–64 位字母、数字、下划线或连字符');
    if (typeof tool.definition.title !== 'string' || !tool.definition.title.trim() || tool.definition.title.length > 200) throw new Error(`工具标题无效：${tool.definition.name}`);
    if (typeof tool.definition.description !== 'string' || !tool.definition.description.trim() || tool.definition.description.length > 4_000) throw new Error(`工具描述无效：${tool.definition.name}`);
    if (!['read', 'write', 'execute', 'network', 'delete', 'external'].includes(tool.definition.risk)) throw new Error(`工具风险类型无效：${tool.definition.name}`);
    if (!['generic', 'terminal', 'diff', 'artifact', 'form', 'agent'].includes(tool.definition.renderHint)) throw new Error(`工具渲染类型无效：${tool.definition.name}`);
    if (typeof tool.definition.inputSchema !== 'object' || tool.definition.inputSchema === null || Array.isArray(tool.definition.inputSchema)) throw new Error(`工具 inputSchema 必须是对象：${tool.definition.name}`);
    const validate = this.#ajv.compile(tool.definition.inputSchema as object);
    const definition: ToolDefinition = { ...tool.definition, capabilityId: capabilityIdForTool(tool.definition) };
    const wrapped: RegisteredTool = {
      definition,
      execute: async (input, context) => {
        if (!validate(input)) {
          const detail = this.#ajv.errorsText(validate.errors, { separator: '; ' });
          throw new Error(`工具 ${definition.name} 参数不合法：${detail}`);
        }
        return tool.execute(input, context);
      },
    };
    return this.#registry.register(definition.name, wrapped);
  }

  require(name: string): RegisteredTool {
    return this.#registry.require(name);
  }

  definitions(): ToolDefinition[] {
    return this.#registry.values().map((tool) => tool.definition);
  }
}
