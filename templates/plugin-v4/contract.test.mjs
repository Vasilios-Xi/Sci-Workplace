import assert from 'node:assert/strict';
import plugin from './src/index.ts';

assert.equal(plugin.apiVersion, 4);
assert.equal(plugin.tools.length, 1);
assert.equal(plugin.tools[0].definition.name, 'inspect_evidence');
process.stdout.write('Plugin API v4 template contract: ok\n');
