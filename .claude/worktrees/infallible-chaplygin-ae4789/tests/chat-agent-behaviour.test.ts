import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, mock } from 'node:test';
import { SESSION_RECORD_VERSION } from '../src/protocol';
import { sanitizeMessages } from '../src/agent/response/demux';
import { ModelGateway } from '../src/model/gateway';
import { parseArgs } from '../src/cli/args';
import { saveSession, lastSession, deleteSession, newSessionId } from '../src/core/sessions';
import { ToolExecutor } from '../src/tool/core/tool-runtime';
import { ToolRegistry } from '../src/tool/execution/registry';

const call = (id: string, name: string, args: Record<string, unknown> = {}) => ({ id, type: 'function', function: { name, arguments: args } });

describe('reasoning tags never reach history', () => {
  it('the gateway returns the answer without the tags the provider sent', async () => {
    const provider = {
      id: 'fake', label: 'Fake',
      detect: async () => true, ensureAuth: async () => true, listModels: async () => [],
      async streamChat({ onDelta }: any) {
        const raw = '</think>\n</think>\nHello there';
        onDelta?.(raw);
        return { content: raw, toolCalls: [], finishReason: 'stop' };
      },
    };
    const gateway = new ModelGateway({ provider, model: 'm', config: { maxRetries: 0, idleTimeoutMs: 10_000, firstTokenTimeoutMs: 10_000, maxTokens: 256 } });
    const called = await gateway.stream({ messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(called.result.content.trim(), 'Hello there');
  });

  it('a saved reply that is nothing but tags is not restored', () => {
    const { messages } = sanitizeMessages([
      { role: 'user', content: 'continue' },
      { role: 'assistant', content: '</think>\n</think>\n' },
      { role: 'assistant', content: '', tool_calls: [call('1', 'read_file', { path: 'a' })] },
      { role: 'assistant', content: 'A real answer.' },
    ] as any[]);
    assert.deepEqual(messages.map((m: any) => m.content), ['continue', '', 'A real answer.']);
  });
});

describe('command line', () => {
  it('reads bundled switches and --prompt, and still refuses what it does not know', () => {
    assert.deepEqual(parseArgs(['-cy']).flags, { continue: true, yes: true });
    assert.equal(parseArgs(['--prompt', 'list files']).flags.prompt, 'list files');
    assert.deepEqual(parseArgs(['-s', 'abc']).unknown, ['-s']);
    assert.deepEqual(parseArgs(['-cz']).unknown, ['-cz']);
  });
});

describe('a workspace keeps its conversations', () => {
  const record = (id: string, messages: any[]) => ({ version: SESSION_RECORD_VERSION, id, providerId: 'p', model: 'm', toolsEnabled: true, messages });

  it('an empty new session does not replace the last conversation; its first message does', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ocode-sessions-'));
    const old = newSessionId();
    saveSession(record(old, [{ role: 'user', content: 'build it' }, { role: 'assistant', content: 'built' }]), root);
    const fresh = newSessionId();
    saveSession(record(fresh, []), root);
    assert.equal(lastSession(root)?.id, old);
    saveSession(record(fresh, [{ role: 'user', content: 'next task' }]), root);
    assert.equal(lastSession(root)?.id, fresh);
    deleteSession(root, fresh);
    assert.equal(lastSession(root)?.id, old, 'the earlier conversation is kept, not replaced');
  });
});

describe('long commands in the live chat', () => {
  // A tool that runs until it is stopped, so only the keep-waiting question can end it.
  function slowTool() {
    const registry = new ToolRegistry();
    registry.register({
      name: 'slow_job', description: 'waits', parameters: { type: 'object', properties: {} },
      preview: () => 'run: slow job',
      execute: (_args: any, ctx: any) => new Promise((resolve) => {
        ctx.signal.addEventListener('abort', () => resolve({ ok: false, kind: 'text', error: 'aborted', display: 'aborted' }), { once: true });
      }),
    } as any);
    return registry;
  }

  it('asks after two minutes and stops the command when told to', async () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    try {
      const asked: string[] = [];
      const executor = new ToolExecutor({
        root: os.tmpdir(), registry: slowTool(), approve: async () => true,
        ask: async (question: string, options: string[]) => { asked.push(`${question} [${options.join('/')}]`); return 'Stop it'; },
      } as any);
      const running = executor.run('slow_job', {});
      await new Promise((r) => setImmediate(r));
      mock.timers.tick(120_000);
      const { result } = await running;
      assert.deepEqual(asked, ['Still running after 2 min — run: slow job [Keep waiting/Stop it]']);
      assert.equal(result.ok, false);
      assert.match(String((result as any).error), /stopped by the user after 2 min/);
    } finally {
      mock.timers.reset();
    }
  });

  /** A risky job (so it is approved first) that finishes `workMs` after it starts, or asks the person first when told to. */
  function approvedJob({ workMs, asks = false }: { workMs: number; asks?: boolean }) {
    const registry = new ToolRegistry();
    registry.register({
      name: 'approved_job', description: 'waits', parameters: { type: 'object', properties: {} }, risky: true,
      preview: () => 'run: approved job',
      execute: async (_args: any, ctx: any) => {
        if (asks) await ctx.ask('Which one?', ['a', 'b']);
        return new Promise((resolve) => {
          const done = setTimeout(() => resolve({ ok: true, kind: 'text', display: 'done' }), workMs);
          ctx.signal.addEventListener('abort', () => { clearTimeout(done); resolve({ ok: false, kind: 'text', error: 'aborted' }); }, { once: true });
        });
      },
    } as any);
    return registry;
  }

  /** A person who answers only when `answer()` is called; the check-in question is recorded and answered at once. */
  function slowPerson(checkInAnswer = 'Keep waiting') {
    const checkIns: string[] = [];
    let release: (value: any) => void = () => {};
    const waiting = (value: any) => new Promise((resolve) => { release = () => resolve(value); });
    return {
      checkIns,
      answer: () => release(undefined),
      approve: () => waiting(true),
      ask: (question: string) => {
        if (question.startsWith('Still running')) {
          checkIns.push(question);
          return Promise.resolve(checkInAnswer);
        }
        return waiting('a');
      },
    };
  }

  const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };

  it('does not ask "still running" while the person is still deciding on the approval', async () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    try {
      const person = slowPerson();
      const executor = new ToolExecutor({ root: os.tmpdir(), registry: approvedJob({ workMs: 1_000 }), approve: person.approve, ask: person.ask } as any);
      const running = executor.run('approved_job', {});
      await settle();
      mock.timers.tick(150_000);
      await settle();
      assert.deepEqual(person.checkIns, [], 'a second prompt over the approval prompt is what hung the session');
      person.answer();
      await settle();
      mock.timers.tick(1_000);
      const { result, timedOut } = await running;
      assert.equal(result.ok, true);
      assert.equal(timedOut, false);
    } finally {
      mock.timers.reset();
    }
  });

  it('counts the two minutes from when the approved command starts', async () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    try {
      const person = slowPerson('Stop it');
      const executor = new ToolExecutor({ root: os.tmpdir(), registry: approvedJob({ workMs: 600_000 }), approve: person.approve, ask: person.ask } as any);
      const running = executor.run('approved_job', {});
      await settle();
      mock.timers.tick(150_000);
      person.answer();
      await settle();
      mock.timers.tick(119_000);
      await settle();
      assert.deepEqual(person.checkIns, []);
      mock.timers.tick(1_000);
      const { result } = await running;
      assert.deepEqual(person.checkIns, ['Still running after 2 min — run: approved job']);
      assert.match(String((result as any).error), /stopped by the user after 2 min/);
    } finally {
      mock.timers.reset();
    }
  });

  it('does not spend the time limit on the approval', async () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    try {
      const person = slowPerson();
      const executor = new ToolExecutor({ root: os.tmpdir(), registry: approvedJob({ workMs: 10_000 }), approve: person.approve, ask: person.ask, timeoutMs: 60_000 } as any);
      const running = executor.run('approved_job', {});
      await settle();
      mock.timers.tick(90_000);
      person.answer();
      await settle();
      mock.timers.tick(10_000);
      const { result, timedOut } = await running;
      assert.equal(timedOut, false);
      assert.equal(result.ok, true);
    } finally {
      mock.timers.reset();
    }
  });

  it('does not ask "still running" while a tool waits on its own question to the person', async () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    try {
      const person = slowPerson();
      const executor = new ToolExecutor({ root: os.tmpdir(), registry: approvedJob({ workMs: 1_000, asks: true }), approve: async () => true, ask: person.ask } as any);
      const running = executor.run('approved_job', {});
      await settle();
      mock.timers.tick(180_000);
      await settle();
      assert.deepEqual(person.checkIns, []);
      person.answer();
      await settle();
      mock.timers.tick(1_000);
      const { result } = await running;
      assert.equal(result.ok, true);
    } finally {
      mock.timers.reset();
    }
  });

  it('never asks when there is no one to answer', async () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    try {
      const executor = new ToolExecutor({ root: os.tmpdir(), registry: slowTool(), approve: async () => true, timeoutMs: 180_000 } as any);
      const running = executor.run('slow_job', {});
      await new Promise((r) => setImmediate(r));
      mock.timers.tick(180_000);
      const { timedOut } = await running;
      assert.equal(timedOut, true, 'a piped run keeps the plain time limit');
    } finally {
      mock.timers.reset();
    }
  });
});
