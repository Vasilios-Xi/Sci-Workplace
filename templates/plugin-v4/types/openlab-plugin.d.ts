declare module '@openlab/plugin-sdk' {
  export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
  export type HarnessPluginPermissionV4 =
    | 'settings:read'
    | 'ui'
    | 'workspace:read'
    | 'workspace:edit'
    | 'resources:read'
    | 'documents:read'
    | 'jobs:run'
    | 'models:invoke'
    | 'annotations:read'
    | 'annotations:write'
    | 'evidence:read'
    | 'evidence:write'
    | 'artifacts:write'
    | 'artifacts:publish'
    | 'research:read'
    | 'research:write'
    | 'plugin-storage'
    | 'workbench:read'
    | 'workbench:write'
    | 'workbench:mount'
    | 'workbench:propose-layout'
    | 'browser:observe'
    | 'browser:interact'
    | 'generated-apps:build'
    | 'toolchains:execute';
  export interface EvidenceAnchorV1 {
    id: string;
    projectId: string;
    page?: number;
    blockId?: string;
    exact?: string;
    createdAt: string;
  }
  export interface ToolExecutionResult {
    callId: string;
    ok: boolean;
    content: string;
    artifactIds: string[];
    metadata: Record<string, JsonValue>;
  }
  export interface PluginHostV4 {
    readonly capabilities: HarnessPluginPermissionV4[];
    evidence: { list(): Promise<EvidenceAnchorV1[]> };
    workbenches: { list(): Promise<Array<{ id: string; title: string; revision: number; primaryConversationId?: string }>> };
  }
  export interface OpenLabPlugin {
    apiVersion: 4;
    tools?: Array<{
      definition: {
        name: string;
        title: string;
        description: string;
        inputSchema: Record<string, unknown>;
        risk: 'read' | 'write' | 'execute' | 'network' | 'delete' | 'external';
        renderHint: 'generic' | 'terminal' | 'diff' | 'artifact' | 'form' | 'agent';
      };
      execute(input: Record<string, JsonValue>, context: { projectId: string; sessionId: string; agentId: string; traceId: string; settings: Record<string, JsonValue>; host: PluginHostV4; signal: AbortSignal }): Promise<ToolExecutionResult>;
    }>;
  }
}
