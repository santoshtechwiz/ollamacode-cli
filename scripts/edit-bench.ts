// `npm run bench:edit`: replay the edit_file mistakes models really make, with no model, and score what ocode does
// with each. A case passes when the edit lands as meant, or when it is refused and what the model is shown holds
// exactly what it needs for its next call: the real file lines it got wrong. `--json` prints the scores for tracking.
//
// Every case is a shape seen in a saved session. Add one when a new shape turns up; never loosen one to make it pass.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import '../src/tool/index';
import { createExecutor } from '../src/tool/execution/executor';
import { createWorkspaceState } from '../src/context/workspace-state';
import { createAgentState } from '../src/agent/state';
import { applyApprovalPolicy } from '../src/tool/policy/permission-policy';
import { renderToolResult } from '../src/agent/router/render';

type Args = Record<string, unknown>;
type Step = { tool: string; args: Args } | { touch: (file: string) => string };

interface Case {
  id: string;
  /** Where it was seen, or what it stands for. */
  seen: string;
  file: string;
  content: string;
  /** Calls (or an outside change to the file) before the call under test. */
  before?: Step[];
  call: Args;
  /** The edit is right and should land: the file must then read exactly this. */
  applies?: string;
  /** The edit is wrong and should be refused, showing these file lines (1-based) and, if given, saying this. */
  refused?: { show: number[]; says?: RegExp };
}

const lines = (...l: string[]) => l.join('\n');

const TODO_MODEL = lines(
  "const { v4: uuidv4 } = require('uuid');", '', 'class TodoModel {', '    constructor() {', '        this.todos = [];', '    }', '',
  '    findAll() {', '        return this.todos;', '    }', '',
  '    findById(id) {', '        return this.todos.find(t => t.id === id);', '    }', '',
  '    create(data) {', '        const todo = { id: uuidv4(), title: data.title, completed: false };', '        this.todos.push(todo);', '        return todo;', '    }', '',
  '    update(id, data) {', '        const todo = this.findById(id);', '        if (!todo) return null;', '        if (data.title !== undefined) todo.title = data.title;',
  '        if (data.completed !== undefined) todo.completed = data.completed;', '', '        return todo;', '    }', '',
  '    delete(id) {', '        const i = this.todos.findIndex(t => t.id === id);', '        if (i === -1) return false;', '        this.todos.splice(i, 1);', '        return true;', '    }', '}', '',
  'module.exports = new TodoModel();', '',
);
const TODO = TODO_MODEL.split('\n');
const APP_JS = lines(
  "const path = require('path');", "require('dotenv').config();", "const express = require('express');",
  "const todoRoutes = require('./src/routes/todoRoutes');", "const errorHandler = require('./src/middleware/errorHandler');", '',
  'const app = express();', 'const PORT = process.env.PORT || 3000;', '', 'app.use(express.json());', "app.use('/api/todos', todoRoutes);",
  'app.use(errorHandler);', '', 'app.listen(PORT, () => console.log(`listening on ${PORT}`));', '',
);
const APP = APP_JS.split('\n');
const RESULT_CS = lines(
  'namespace Demo.Domain.Common;', '', 'public class Result', '{', '    public bool IsSuccess { get; }', '    public string Error { get; }', '',
  '    protected Result(bool isSuccess, string error)', '    {', '        IsSuccess = isSuccess;', '        Error = error;', '    }', '',
  '    public static Result Success() => new Result(true, null!);', '    public static Result Failure(string error) => new Result(false, error);', '}', '',
);
const gutter = (text: string, from = 1) => text.split('\n').map((l, i) => `${String(from + i).padStart(6)}\t${l}`).join('\n');

const CASES: Case[] = [
  {
    id: 'long-search-drifts-mid',
    seen: 'todoModel.js: 20-line search from memory, findAll written as getAll on line 8',
    file: 'todoModel.js', content: TODO_MODEL,
    call: { path: 'todoModel.js', edits: [{ search: TODO.slice(0, 20).join('\n').replace('findAll() {', 'getAll() {'), replace: 'x' }] },
    refused: { show: [8], says: /line 8/ },
  },
  {
    id: 'long-search-drifts-late',
    seen: 'the same, drifting near the end of the search',
    file: 'todoModel.js', content: TODO_MODEL,
    call: { path: 'todoModel.js', search: TODO.slice(11, 29).join('\n').replace('return todo;\n    }\n\n    update', 'return todo;\n    }\n\n    patch'), replace: 'x' },
    refused: { show: [22], says: /line 22/ },
  },
  {
    id: 'search-skips-a-line',
    seen: 'app.js: the search leaves out "const PORT = …" between two lines it quotes',
    file: 'app.js', content: APP_JS,
    call: { path: 'app.js', edits: [{ search: [...APP.slice(2, 7), ...APP.slice(8, 12)].join('\n'), replace: 'x' }] },
    refused: { show: [8], says: /line 8/ },
  },
  {
    id: 'first-line-wrong',
    seen: 'the search opens with a line that is not in the file, the rest is right',
    file: 'todoModel.js', content: TODO_MODEL,
    call: { path: 'todoModel.js', search: ['    getAll() {', ...TODO.slice(8, 10)].join('\n'), replace: 'x' },
    refused: { show: [8] },
  },
  {
    id: 'read-gutter-copied',
    seen: 'the search carries read_file line numbers ("     8\\t    findAll() {")',
    file: 'todoModel.js', content: TODO_MODEL,
    call: { path: 'todoModel.js', search: gutter(TODO.slice(7, 10).join('\n'), 8), replace: '    async findAll() {\n        return this.todos;\n    }' },
    refused: { show: [8, 9, 10] },
  },
  {
    id: 'crlf-file-lf-search',
    seen: 'Result.cs saved by Visual Studio (CRLF), multi-line search sent with \\n',
    file: 'Result.cs', content: RESULT_CS.replace(/\n/g, '\r\n'),
    call: {
      path: 'Result.cs',
      search: '    public static Result Success() => new Result(true, null!);\n    public static Result Failure(string error) => new Result(false, error);',
      replace: '    public static Result Success() => new Result(true, string.Empty);\n    public static Result Failure(string error) => new Result(false, error);',
    },
    applies: RESULT_CS.replace('new Result(true, null!)', 'new Result(true, string.Empty)').replace(/\n/g, '\r\n'),
  },
  {
    id: 'tabs-for-spaces',
    seen: 'the search is indented with a tab where the file has four spaces',
    file: 'todoModel.js', content: TODO_MODEL,
    call: { path: 'todoModel.js', search: '\tfindAll() {\n\t\treturn this.todos;\n\t}', replace: '\tasync findAll() {\n\t\treturn this.todos;\n\t}' },
    applies: TODO_MODEL.replace('    findAll() {', '    async findAll() {'),
  },
  {
    id: 'trailing-space-in-file',
    seen: 'the file line ends in spaces the model never shows',
    file: 'app.js', content: APP_JS.replace('app.use(errorHandler);', 'app.use(errorHandler);   '),
    call: { path: 'app.js', search: "app.use('/api/todos', todoRoutes);\napp.use(errorHandler);", replace: "app.use('/api/v1/todos', todoRoutes);\napp.use(errorHandler);" },
    // The trailing spaces are not the model's to keep or drop: the change lands and the rest of the line stays.
    applies: APP_JS.replace("'/api/todos'", "'/api/v1/todos'").replace('app.use(errorHandler);', 'app.use(errorHandler);   '),
  },
  {
    id: 'stale-after-own-edit',
    seen: 'Result.cs: the second edit quotes a line the first edit already changed',
    file: 'Result.cs', content: RESULT_CS,
    before: [{ tool: 'edit_file', args: { path: 'Result.cs', search: 'new Result(true, null!)', replace: 'new Result(true, string.Empty)' } }],
    call: { path: 'Result.cs', search: '    public static Result Success() => new Result(true, null!);', replace: '    public static Result Success() => Ok;' },
    refused: { show: [14], says: /edited earlier in this session/ },
  },
  {
    id: 'ambiguous-line',
    seen: 'a one-line search that is in the file twice',
    file: 'todoModel.js', content: TODO_MODEL,
    call: { path: 'todoModel.js', search: '        return todo;', replace: '        return { ...todo };' },
    refused: { show: [19, 28] },
  },
  {
    id: 'truncated-search',
    seen: 'the search ends in "…" where the model cut a long block short',
    file: 'todoModel.js', content: TODO_MODEL,
    call: { path: 'todoModel.js', search: '    update(id, data) {\n        const todo = this.findById(id);\n        …', replace: 'x' },
    refused: { show: [22, 23], says: /truncation marker/ },
  },
  {
    id: 'escaped-newlines',
    seen: 'the search arrives with literal \\n instead of line breaks',
    file: 'todoModel.js', content: TODO_MODEL,
    call: { path: 'todoModel.js', search: '    findAll() {\\n        return this.todos;\\n    }', replace: '    async findAll() {\\n        return this.todos;\\n    }' },
    refused: { show: [8, 9, 10] },
  },
  {
    id: 'stale-line-range',
    seen: 'line numbers from a read made before the file gained two lines',
    file: 'app.js', content: APP_JS,
    before: [
      { tool: 'read_file', args: { path: 'app.js' } },
      { touch: (text) => text.replace("const path = require('path');\n", "'use strict';\n\nconst path = require('path');\n") },
    ],
    call: { path: 'app.js', line_start: 8, line_end: 8, replace: 'const PORT = Number(process.env.PORT) || 3000;' },
    refused: { show: [10] },
  },
  {
    id: 'overlapping-batch',
    seen: 'two items of one edits array change the same lines',
    file: 'app.js', content: APP_JS,
    call: { path: 'app.js', edits: [
      { search: 'const app = express();\nconst PORT = process.env.PORT || 3000;', replace: 'const app = express();\nconst PORT = 8080;' },
      { search: 'const PORT = process.env.PORT || 3000;', replace: 'const PORT = 9090;' },
    ] },
    refused: { show: [8] },
  },
  {
    id: 'no-op-edit',
    seen: 'replace is the same as search',
    file: 'app.js', content: APP_JS,
    call: { path: 'app.js', search: 'app.use(errorHandler);', replace: 'app.use(errorHandler);' },
    // Nothing to do is not a failure: it is reported as no change, and the file is left as it was.
    applies: APP_JS,
  },
  {
    id: 'syntax-break',
    seen: 'the replacement drops a closing brace',
    file: 'todoModel.js', content: TODO_MODEL,
    call: { path: 'todoModel.js', search: '    findAll() {\n        return this.todos;\n    }', replace: '    findAll() {\n        return this.todos;' },
    refused: { show: [] },
  },
  {
    id: 'symbol-body',
    seen: 'a whole method replaced by name',
    file: 'todoModel.js', content: TODO_MODEL,
    call: { path: 'todoModel.js', symbol: 'TodoModel.findAll', replace: '    async findAll() {\n        return [...this.todos];\n    }' },
    applies: TODO_MODEL.replace('    findAll() {\n        return this.todos;\n    }', '    async findAll() {\n        return [...this.todos];\n    }'),
  },
  {
    id: 'line-range-fresh',
    seen: 'line numbers from a fresh read',
    file: 'app.js', content: APP_JS,
    before: [{ tool: 'read_file', args: { path: 'app.js' } }],
    call: { path: 'app.js', line_start: 8, line_end: 8, replace: 'const PORT = Number(process.env.PORT) || 3000;' },
    applies: APP_JS.replace('const PORT = process.env.PORT || 3000;', 'const PORT = Number(process.env.PORT) || 3000;'),
  },
];

/** Whether the listing the model reads holds file line `n` with its real text. */
function shows(seen: string, content: string, n: number): boolean {
  const want = content.replace(/\r\n/g, '\n').split('\n')[n - 1] ?? '';
  return seen.split('\n').some((l) => {
    const m = /^\s*>?\s*(\d+):\s?(.*)$/.exec(l);
    return m !== null && Number(m[1]) === n && m[2].trimEnd() === want.trimEnd();
  });
}

async function runCase(c: Case): Promise<{ id: string; pass: boolean; why: string }> {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ocode-edit-bench-'));
  const abs = path.join(cwd, c.file);
  try {
    fs.writeFileSync(abs, c.content);
    const state: any = createWorkspaceState(cwd);
    state.permissions = createAgentState().permissions;
    applyApprovalPolicy(state, { yes: true });
    const ex = createExecutor({ root: cwd, state, timeoutMs: 20_000 });
    for (const step of c.before ?? []) {
      if ('touch' in step) fs.writeFileSync(abs, step.touch(fs.readFileSync(abs, 'utf8')));
      else await ex.run(step.tool, step.args, {});
    }
    const disk = fs.readFileSync(abs, 'utf8');
    const { result } = await ex.run('edit_file', c.call, {});
    const after = fs.readFileSync(abs, 'utf8');
    const seen = renderToolResult(result, 'edit_file');
    if (c.applies !== undefined) {
      if (!result.ok) return { id: c.id, pass: false, why: `refused: ${String(result.error).split('\n')[0]}` };
      return after === c.applies ? { id: c.id, pass: true, why: 'applied as meant' } : { id: c.id, pass: false, why: 'applied, but the file is not what was meant' };
    }
    if (result.ok) return { id: c.id, pass: false, why: after === disk ? 'reported success, wrote nothing' : 'applied an edit that should have been refused' };
    if (after !== disk) return { id: c.id, pass: false, why: 'refused, but the file changed anyway' };
    const missing = (c.refused?.show ?? []).filter((n) => !shows(seen, disk, n));
    if (missing.length) return { id: c.id, pass: false, why: `refused, but the model is not shown line${missing.length > 1 ? 's' : ''} ${missing.join(', ')}` };
    if (c.refused?.says && !c.refused.says.test(seen)) return { id: c.id, pass: false, why: `refused, but never says ${c.refused.says}` };
    return { id: c.id, pass: true, why: 'refused, showing what to fix' };
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

const only = process.argv.includes('--only') ? new Set(process.argv[process.argv.indexOf('--only') + 1].split(',')) : null;
const results = [];
for (const c of CASES.filter((x) => !only || only.has(x.id))) results.push({ ...(await runCase(c)), seen: c.seen });
const passed = results.filter((r) => r.pass).length;

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ passed, total: results.length, results }, null, 2));
} else {
  const width = Math.max(...results.map((r) => r.id.length));
  for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.id.padEnd(width)}  ${r.why}`);
  console.log(`\n${passed}/${results.length} edit cases handled`);
}
