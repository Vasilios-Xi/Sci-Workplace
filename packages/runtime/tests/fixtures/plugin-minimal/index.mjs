export default {
  apiVersion: 1,
  tools: [{
    definition: {
      name: 'ping',
      title: 'Ping',
      description: 'Minimal plugin fixture',
      inputSchema: { type: 'object', additionalProperties: false },
      risk: 'read',
      renderHint: 'generic',
    },
    async execute(_input, context) {
      return { callId: context.traceId, ok: true, content: 'pong', artifactIds: [], metadata: {} };
    },
  }],
};
