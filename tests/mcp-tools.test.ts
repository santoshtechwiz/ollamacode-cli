import assert from 'node:assert/strict';
import os from 'node:os';
import { describe, it } from 'node:test';
import '../src/tool/index';
import { bridgeTool } from '../src/mcp/registry';
import { PermissionPolicy } from '../src/tool/policy/permission-policy';
import { createAgentState } from '../src/agent/state';

const client = { name: 'docs', callTool: async () => ({ text: 'ok', isError: false }) } as any;
const decide = (def: any, grantAll = false) => {
  const permissions = createAgentState().permissions;
  if (grantAll) permissions.alwaysAllowAll = true;
  return new PermissionPolicy().decide({
    toolName: def.name, args: {}, toolDef: def, cwd: os.tmpdir(), root: os.tmpdir(),
    permissions, yes: false, policy: 'ask', interactive: true, grantedRoots: [],
  });
};

describe('what an MCP server declares about its tools', () => {
  it('a read-only tool runs without asking', async () => {
    assert.equal(await decide(bridgeTool(client, { name: 'search', annotations: { readOnlyHint: true } })), 'allow');
  });

  it('a tool with no declaration is asked about, and "always" covers it', async () => {
    const def = bridgeTool(client, { name: 'update' });
    assert.equal(await decide(def), 'ask');
    assert.notEqual(await decide(def, true), 'ask');
  });

  it('a tool declared destructive is asked about every time, even under "always"', async () => {
    const def = bridgeTool(client, { name: 'wipe', annotations: { destructiveHint: true } });
    assert.equal(await decide(def, true), 'ask');
  });
});
