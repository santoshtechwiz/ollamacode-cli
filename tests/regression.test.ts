import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runTurn } from '../src/agent/turn/turn';
import { decideToolExecution } from '../src/agent/turn/tool-execution-decider';
import type { TurnState } from '../src/agent/turn/turn-state';
import type { ContextStore } from '../src/context/contracts';
import { createContextStore } from '../src/context/store';
import { resolveScope } from '../src/agent/workspace/scope';
import {
  STOP_REASONS,
  TOOL_ERROR_CODE,
} from '../src/protocol';
import type {
  ToolCall,
  ToolResult,
} from '../src/types';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

type MockAnswer = {
  content?: string;
  toolCalls?: ToolCall[];
  reasoning?: string;
  finishReason?: string;
};

type ToolRun = {
  name: string;
  args: Record<string, unknown>;
};

type ToolRunner = {
  run(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{
    result: ToolResult;
    timedOut: boolean;
    durationMs: number;
  }>;
};

type MockGateway = {
  model: string;
  provider: {
    id: string;
  };
  stream(input: {
    tools?: unknown;
    signal?: AbortSignal;
  }): Promise<{
    result: {
      content: string;
      toolCalls: ToolCall[];
      reasoning?: string;
      finishReason: string;
    };
    attempt: number;
    retries: number;
    startedAt: number;
  }>;
};

function createMockGateway(answers: MockAnswer[]): MockGateway & {
  getCallCount(): number;
} {
  let callCount = 0;

  return {
    model: 'test-model',
    provider: {
      id: 'test',
    },

    getCallCount() {
      return callCount;
    },

    async stream() {
      const answer =
        answers[callCount] ??
        {
          content: '',
          toolCalls: [],
          finishReason: 'stop',
        };

      callCount++;

      return {
        result: {
          content: answer.content ?? '',
          toolCalls: answer.toolCalls ?? [],
          reasoning: answer.reasoning,
          finishReason: answer.finishReason ?? 'stop',
        },
        attempt: 1,
        retries: 0,
        startedAt: Date.now(),
      };
    },
  };
}

function createMockToolRunner(
  results: Map<string, ToolResult>,
): ToolRunner & {
  calls: ToolRun[];
} {
  const calls: ToolRun[] = [];

  return {
    calls,

    async run(
      name: string,
      args: Record<string, unknown>,
    ) {
      calls.push({
        name,
        args,
      });

      const key = `${name}:${JSON.stringify(args)}`;
      const result = results.get(key);

      return {
        result:
          result ??
          {
            ok: true,
            kind: 'text',
            data: {
              content: `ok: ${name}`,
            },
          },
        timedOut: false,
        durationMs: 10,
      };
    },
  };
}

function createTestWorkspace(tmpDir: string) {
  return {
    cwd: tmpDir,
    nativeTools: true,
    contextWindow: 8000,
    contextLength: 8000,

    state: {
      mutationCount: 0,
      permissions: {
        denied: false,
      },
      sessionId: 'test-session',
    },

    index: {
      db: null,
      stamp: () => '',
      gitTracked: false,
    },

    stacks: [],
    runtimes: [],
  };
}

function createCall(
  id: string,
  name: string,
  args: Record<string, unknown>,
): ToolCall {
  return {
    id,
    type: 'function',
    function: {
      name,
      arguments: args,
    },
  };
}

function createResult(
  ok: boolean,
  data?: Record<string, unknown>,
  code?: string,
): ToolResult {
  return {
    ok,
    kind: 'text',
    ...(data ? { data } : {}),
    ...(code ? { code } : {}),
  };
}

function createState(
  toolCalls: TurnState['toolCalls'] = [],
): TurnState {
  return {
    iteration: 1,
    maxIterations: 10,
    toolCalls,
    answer: undefined,
    stopReason: undefined,
  };
}

function toolKey(
  name: string,
  args: Record<string, unknown>,
): string {
  return `${name}:${JSON.stringify(args)}`;
}

describe('Agent turn regression suite', () => {
  let tmpDir: string;

  before(() => {
    tmpDir = fs.mkdtempSync(
      path.join(__dirname, '..', 'regression-test-'),
    );

    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify(
        {
          name: 'test-project',
          scripts: {
            test: 'echo pass',
          },
        },
        null,
        2,
      ),
    );

    fs.mkdirSync(
      path.join(tmpDir, 'src'),
      {
        recursive: true,
      },
    );

    fs.writeFileSync(
      path.join(tmpDir, 'src.ts'),
      'export const x = 1;\n',
    );

    fs.writeFileSync(
      path.join(tmpDir, 'src', 'a.ts'),
      'export const a = 1;\n',
    );
  });

  after(() => {
    fs.rmSync(tmpDir, {
      recursive: true,
      force: true,
    });
  });

  describe('runTurn', () => {
    it('recovers from an output limit and continues the turn', async () => {
      const gateway = createMockGateway([
        {
          content: '',
          toolCalls: [
            createCall(
              '1',
              'read_file',
              {
                path: 'src.ts',
              },
            ),
          ],
          finishReason: 'length',
          reasoning: 'long reasoning',
        },
        {
          content: 'Done',
          toolCalls: [],
          finishReason: 'stop',
        },
      ]);

      const toolRunner =
        createMockToolRunner(
          new Map(),
        );

      const history =
        createContextStore();

      const workspace =
        createTestWorkspace(tmpDir);

      const turn = await runTurn({
        model: 'test',
        history,
        gateway,
        toolRunner,
        workspace,
        config: {
          maxIterations: 5,
          maxTokens: 100,
        },
        signal: new AbortController().signal,
      });

      assert.equal(
        turn.stopReason,
        STOP_REASONS.COMPLETE,
      );

      assert.equal(
        turn.content.trim(),
        'Done',
      );

      assert.equal(
        turn.iterations,
        2,
      );

      assert.equal(
        gateway.getCallCount(),
        2,
      );
    });

    it('executes a tool and records its structured result', async () => {
      const expectedResult: ToolResult = {
        ok: true,
        kind: 'command',
        data: {
          exitCode: 0,
          stdout: 'pass',
          stderr: '',
          truncated: false,
        },
      };

      const args = {
        command: 'npm test',
      };

      const gateway = createMockGateway([
        {
          content: '',
          toolCalls: [
            createCall(
              '1',
              'exec_shell',
              args,
            ),
          ],
          finishReason: 'stop',
        },
      ]);

      const toolRunner =
        createMockToolRunner(
          new Map([
            [
              toolKey(
                'exec_shell',
                args,
              ),
              expectedResult,
            ],
          ]),
        );

      const history =
        createContextStore();

      const workspace =
        createTestWorkspace(tmpDir);

      const turn = await runTurn({
        model: 'test',
        history,
        gateway,
        toolRunner,
        workspace,
        // The fake model calls exec_shell straight away, so it is on the wire from the start.
        toolProfile: { always: ['exec_shell'] },
        config: {
          maxIterations: 5,
        },
        signal: new AbortController().signal,
      });

      assert.equal(
        turn.toolResults.length,
        1,
      );

      assert.equal(
        turn.toolResults[0]?.result.data?.exitCode,
        0,
      );

      assert.equal(
        toolRunner.calls.length,
        1,
      );

      assert.equal(
        toolRunner.calls[0]?.name,
        'exec_shell',
      );
    });

    it('preserves structured truncated command output', async () => {
      const longOutput =
        'x'.repeat(20_000);

      const args = {
        command: 'npm test',
      };

      const expectedResult: ToolResult = {
        ok: true,
        kind: 'command',
        data: {
          exitCode: 0,
          stdout: longOutput,
          stderr: '',
          truncated: true,
        },
      };

      const gateway = createMockGateway([
        {
          content: '',
          toolCalls: [
            createCall(
              '1',
              'exec_shell',
              args,
            ),
          ],
          finishReason: 'stop',
        },
      ]);

      const toolRunner =
        createMockToolRunner(
          new Map([
            [
              toolKey(
                'exec_shell',
                args,
              ),
              expectedResult,
            ],
          ]),
        );

      const history =
        createContextStore();

      const workspace =
        createTestWorkspace(tmpDir);

      const turn = await runTurn({
        model: 'test',
        history,
        gateway,
        toolRunner,
        workspace,
        // The fake model calls exec_shell straight away, so it is on the wire from the start.
        toolProfile: { always: ['exec_shell'] },
        config: {
          maxIterations: 5,
        },
        signal: new AbortController().signal,
      });

      assert.equal(
        turn.toolResults.length,
        1,
      );

      const toolResult =
        turn.toolResults[0]?.result;

      assert.equal(
        toolResult.data?.exitCode,
        0,
      );

      assert.equal(
        toolResult.data?.truncated,
        true,
      );

      assert.equal(
        typeof toolResult.data?.stdout,
        'string',
      );

      assert.equal(
        typeof toolResult.data?.stderr,
        'string',
      );
    });

    it('allows the model to correct invalid tool arguments', async () => {
      const answers: MockAnswer[] = [
        {
          content: '',
          toolCalls: [
            createCall(
              '1',
              'read_file',
              {
                path: '',
              },
            ),
          ],
          finishReason: 'stop',
        },
        {
          content: '',
          toolCalls: [
            createCall(
              '2',
              'read_file',
              {
                path: 'src.ts',
              },
            ),
          ],
          finishReason: 'stop',
        },
        {
          content: 'Done',
          toolCalls: [],
          finishReason: 'stop',
        },
      ];

      const gateway =
        createMockGateway(answers);

      const toolRunner =
        createMockToolRunner(
          new Map(),
        );

      const history =
        createContextStore();

      const workspace =
        createTestWorkspace(tmpDir);

      const turn = await runTurn({
        model: 'test',
        history,
        gateway,
        toolRunner,
        workspace,
        config: {
          maxIterations: 5,
        },
        signal: new AbortController().signal,
      });

      assert.equal(
        turn.stopReason,
        STOP_REASONS.COMPLETE,
      );

      assert.equal(
        turn.content.trim(),
        'Done',
      );

      assert.equal(
        turn.iterations,
        3,
      );
    });

    it('does not execute an identical successful tool call twice', async () => {
      const readCall1 = createCall(
        '1',
        'read_file',
        {
          path: 'src.ts',
        },
      );

      const readCall2 = createCall(
        '2',
        'read_file',
        {
          path: 'src.ts',
        },
      );

      const gateway =
        createMockGateway([
          {
            content: '',
            toolCalls: [readCall1],
            finishReason: 'stop',
          },
          {
            content: '',
            toolCalls: [readCall2],
            finishReason: 'stop',
          },
          {
            content: 'Done',
            toolCalls: [],
            finishReason: 'stop',
          },
        ]);

      const toolRunner =
        createMockToolRunner(
          new Map([
            [
              toolKey(
                'read_file',
                {
                  path: 'src.ts',
                },
              ),
              createResult(
                true,
                {
                  content:
                    'export const x = 1;',
                },
              ),
            ],
          ]),
        );

      const history =
        createContextStore();

      const workspace =
        createTestWorkspace(tmpDir);

      const turn = await runTurn({
        model: 'test',
        history,
        gateway,
        toolRunner,
        workspace,
        config: {
          maxIterations: 5,
        },
        signal: new AbortController().signal,
      });

      // One repeat is answered from the first result and the model moves on: the turn ends on its answer, not as stuck.
      assert.equal(
        turn.stopReason,
        STOP_REASONS.COMPLETE,
      );

      assert.equal(
        toolRunner.calls.length,
        1,
      );

      assert.equal(
        toolRunner.calls[0]?.name,
        'read_file',
      );

      assert.equal(
        turn.content.trim(),
        'Done',
      );
    });

    it('does not create duplicate assistant messages for a reused call', async () => {
      const gateway =
        createMockGateway([
          {
            content: '',
            toolCalls: [
              createCall(
                '1',
                'read_file',
                {
                  path: 'src.ts',
                },
              ),
            ],
            finishReason: 'stop',
          },
          {
            content: '',
            toolCalls: [
              createCall(
                '2',
                'read_file',
                {
                  path: 'src.ts',
                },
              ),
            ],
            finishReason: 'stop',
          },
          {
            content: 'Done',
            toolCalls: [],
            finishReason: 'stop',
          },
        ]);

      const toolRunner =
        createMockToolRunner(
          new Map(),
        );

      const history =
        createContextStore();

      const workspace =
        createTestWorkspace(tmpDir);

      await runTurn({
        model: 'test',
        history,
        gateway,
        toolRunner,
        workspace,
        config: {
          maxIterations: 5,
        },
        signal: new AbortController().signal,
      });

      const assistantMessages =
        history.messages.filter(
          message =>
            message.role === 'assistant',
        );

      assert.equal(
        assistantMessages.length,
        2,
      );
    });

    it('cancels cleanly while a tool is running', async () => {
      const controller =
        new AbortController();

      let resolveTool:
        | (() => void)
        | undefined;

      const toolPromise =
        new Promise<{
          result: ToolResult;
          timedOut: boolean;
          durationMs: number;
        }>(resolve => {
          resolveTool = () => {
            resolve({
              result: {
                ok: true,
                kind: 'text',
              },
              timedOut: false,
              durationMs: 10,
            });
          };
        });

      const gateway =
        createMockGateway([
          {
            content: '',
            toolCalls: [
              createCall(
                '1',
                'read_file',
                {
                  path: 'src.ts',
                },
              ),
            ],
            finishReason: 'stop',
          },
        ]);

      const toolRunner: ToolRunner = {
        async run() {
          return toolPromise;
        },
      };

      const history =
        createContextStore();

      const workspace =
        createTestWorkspace(tmpDir);

      const turnPromise =
        runTurn({
          model: 'test',
          history,
          gateway,
          toolRunner,
          workspace,
          config: {
            maxIterations: 5,
          },
          signal: controller.signal,
        });

      await new Promise<void>(
        resolve =>
          setTimeout(
            resolve,
            25,
          ),
      );

      controller.abort();
      resolveTool?.();

      const turn =
        await turnPromise;

assert.equal(
        turn.stopReason,
        STOP_REASONS.CANCELLED,
      );
    });

    it('recovers from reasoning/output limit without losing the turn', async () => {
      const gateway =
        createMockGateway([
          {
            content: '',
            toolCalls: [
              createCall(
                '1',
                'read_file',
                {
                  path: 'src.ts',
                },
              ),
            ],
            finishReason: 'length',
            reasoning: 'long reasoning',
          },
          {
            content: 'Answer',
            toolCalls: [],
            finishReason: 'stop',
          },
        ]);

      const toolRunner =
        createMockToolRunner(
          new Map(),
        );

      const history =
        createContextStore();

      const workspace =
        createTestWorkspace(tmpDir);

      const turn = await runTurn({
        model: 'test',
        history,
        gateway,
        toolRunner,
        workspace,
        config: {
          maxIterations: 5,
        },
        signal: new AbortController().signal,
      });

      assert.equal(
        turn.stopReason,
        STOP_REASONS.COMPLETE,
      );

      assert.equal(
        turn.content.trim(),
        'Answer',
      );

      assert.equal(
        turn.iterations,
        2,
      );

      assert.equal(
        gateway.getCallCount(),
        2,
      );
    });
  });

  describe('Workspace scope', () => {
    it('returns cwd for an empty scope', () => {
      assert.equal(
        resolveScope(
          '/home/user',
          '',
        ),
        '/home/user',
      );
    });

    it('returns cwd for "."', () => {
      assert.equal(
        resolveScope(
          '/home/user',
          '.',
        ),
        '/home/user',
      );
    });

    it('returns cwd for "./"', () => {
      assert.equal(
        resolveScope(
          '/home/user',
          './',
        ),
        '/home/user',
      );
    });

    it('resolves relative paths against cwd', () => {
      assert.equal(
        resolveScope(
          '/home/user',
          'project',
        ),
        '/home/user/project',
      );
    });

    it('preserves absolute paths', () => {
      assert.equal(
        resolveScope(
          '/home/user',
          '/absolute/path',
        ),
        '/absolute/path',
      );
    });
  });
});