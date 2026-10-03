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

describe('the names the model calls MCP tools by', () => {
  it('two servers whose names clean to the same text still get distinct tool names', () => {
    const taken = new Set<string>();
    const a = bridgeTool({ ...client, name: 'my-server' }, { name: 'run' }, taken).name;
    const b = bridgeTool({ ...client, name: 'my_server' }, { name: 'run' }, taken).name;
    assert.equal(a, 'mcp__my_server__run');
    assert.equal(b, 'mcp__my_server__run_2');
  });

  it('a long name is cut to 64 characters, stays stable, and stays distinct', () => {
    const long = 'x'.repeat(80);
    const one = bridgeTool(client, { name: `${long}_one` }).name;
    const two = bridgeTool(client, { name: `${long}_two` }).name;
    assert.ok(one.length <= 64 && two.length <= 64);
    assert.notEqual(one, two);
    assert.equal(bridgeTool(client, { name: `${long}_one` }).name, one);
  });
});
