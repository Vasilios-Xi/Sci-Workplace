/// <reference path="../types/openlab-plugin.d.ts" />
import type { OpenLabPlugin } from '@openlab/plugin-sdk';

const plugin = {
  apiVersion: 4,
  tools: [{
    definition: {
      name: 'inspect_evidence',
      title: '检查证据锚点',
      description: '读取当前项目中由宿主管理的证据锚点数量。',
      inputSchema: { type: 'object', additionalProperties: false },
      risk: 'read',
      renderHint: 'generic',
    },
    async execute(_input, context) {
      const anchors = await context.host.evidence.list();
      return {
        callId: context.traceId,
        ok: true,
        content: `当前项目包含 ${anchors.length} 个证据锚点。`,
        artifactIds: [],
        metadata: { anchorCount: anchors.length },
      };
    },
  }],
} satisfies OpenLabPlugin;

export default plugin;
