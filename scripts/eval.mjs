// `npm run eval -- --model <name>`: drive real ocode chat turns through fixed tasks and score how the model behaved.
// `npm run eval -- --mine <dir...>`: group the tool errors in saved sessions, so the next argument fix comes from data.
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const cli = join(root, 'bin', 'cli.js');
const LAB = process.env.OCODE_LAB ?? 'C:\\projects\\ocode-lab';
const ANSI = /\x1b\[[0-9;]*m/g;

const argv = process.argv.slice(2);
const flag = (name) => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 ? argv[at + 1] : undefined;
};

const sh = (cmd, cwd, timeout = 300_000) => spawnSync(cmd, { cwd, shell: true, encoding: 'utf8', timeout });
const read = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : '');
// Runs a snippet of ES module code in the workspace; exit 0 means the behaviour held.
const script = (cwd, code) => spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd, encoding: 'utf8' }).status === 0;
const clean = (cwd) => sh('git status --porcelain --untracked-files=no', cwd).stdout.trim() === '';

// Each task names its repo, what the person asks, and an objective check run after the turn; a check is the only thing that decides pass.
// Optional: `args` (extra CLI flags), `inputs` (several chat lines instead of one prompt), `config` (settings merged into a private copy of the user's config).
const GO_MAIN = 'package main\n\nimport (\n\t"fmt"\n\t"os"\n)\n\nfunc greet(name string) string {\n\treturn "Hi " + name + "!"\n}\n\nfunc main() {\n\tif len(os.Args) > 1 {\n\t\tfmt.Println(greet(os.Args[1]))\n\t}\n}\n';
// A generated workspace becomes a repo so `clean` can tell whether the run changed anything.
const commitAll = (cwd) => sh('git init -q && git add -A && git -c user.email=eval@local -c user.name=eval commit -qm init', cwd);
const writeAll = (cwd, files) => {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(cwd, rel, '..'), { recursive: true });
    writeFileSync(join(cwd, rel), text);
  }
  commitAll(cwd);
};

// 2,000 log lines, more matches than one search shows: counting them is a job for a script, not for paging.
const APP_LOG = Array.from({ length: 2000 }, (_, i) =>
  i % 5 === 0 ? `2026-01-01T00:${String(i % 60).padStart(2, '0')} ERROR db timeout`
  : i % 7 === 0 ? `2026-01-01T00:${String(i % 60).padStart(2, '0')} ERROR auth failed`
  : i % 23 === 0 ? `2026-01-01T00:${String(i % 60).padStart(2, '0')} ERROR disk full`
  : `2026-01-01T00:${String(i % 60).padStart(2, '0')} INFO request ok`).join('\n') + '\n';
const LOG_TOP = APP_LOG.split('\n').filter((l) => l.endsWith('ERROR db timeout')).length;

const PACKAGES = Object.fromEntries(['api', 'web', 'worker', 'cli', 'admin', 'shared'].map((name, i) => [
  `packages/${name}/package.json`,
  JSON.stringify({ name, dependencies: { react: i === 2 ? '17.0.2' : '18.2.0', lodash: i === 1 || i === 4 ? '4.17.15' : '4.17.21', express: '4.19.2' } }, null, 2),
]));

const DUPLICATED = '  const out = [];\n  for (const item of items) {\n    const key = String(item.id).trim();\n    if (!key) continue;\n    out.push({ key, value: item.value * 2 });\n  }\n  return out.sort((a, b) => a.key.localeCompare(b.key));\n';
const DEAD_CODE_SRC = {
  'package.json': JSON.stringify({ name: 'shop', type: 'module' }, null, 2),
  'src/math.js': 'export function add(a, b) {\n  return a + b;\n}\n\nexport function legacyRound(x) {\n  return Math.round(x * 100) / 100;\n}\n',
  'src/orders.js': `export function normalizeOrders(items) {\n${DUPLICATED}}\n`,
  'src/carts.js': `export function normalizeCarts(items) {\n${DUPLICATED}}\n`,
  'src/index.js': "import { add } from './math.js';\nimport { normalizeOrders } from './orders.js';\nimport { normalizeCarts } from './carts.js';\n\nconsole.log(add(1, 2), normalizeOrders([]), normalizeCarts([]));\n",
};

// The edit tasks: each is a shape edit_file failed on in a saved session, in a project that needs nothing installed.
const TODO_APP = {
  'package.json': JSON.stringify({ name: 'todo-app', private: true }, null, 2),
  'src/models/todoModel.js': [
    "const { randomUUID } = require('node:crypto');",
    '',
    'class TodoModel {',
    '    constructor() {',
    '        this.todos = [];',
    '    }',
    '',
    '    findAll() {',
    '        return this.todos;',
    '    }',
    '',
    '    findById(id) {',
    '        return this.todos.find((t) => t.id === id) || null;',
    '    }',
    '',
    '    create(data) {',
    '        const todo = { id: randomUUID(), title: data.title, completed: false };',
    '        this.todos.push(todo);',
    '        return todo;',
    '    }',
    '',
    '    update(id, data) {',
    '        const todo = this.findById(id);',
    '        if (!todo) return null;',
    '        if (data.title !== undefined) todo.title = data.title;',
    '        if (data.completed !== undefined) todo.completed = data.completed;',
    '',
    '        return todo;',
    '    }',
    '',
    '    remove(id) {',
    '        const i = this.todos.findIndex((t) => t.id === id);',
    '        if (i === -1) return false;',
    '        this.todos.splice(i, 1);',
    '        return true;',
    '    }',
    '}',
    '',
    'module.exports = new TodoModel();',
    '',
  ].join('\n'),
  'src/service.js': [
    "const model = require('./models/todoModel');",
    '',
    'function addTodo(title) {',
    "    if (!title) throw new Error('title is required');",
    '    return model.create({ title });',
    '}',
    '',
    'function complete(id) {',
    '    return model.update(id, { completed: true });',
    '}',
    '',
    'function openTodos() {',
    '    return model.findAll().filter((t) => !t.completed);',
    '}',
    '',
    'module.exports = { addTodo, complete, openTodos };',
    '',
  ].join('\n'),
  'test.js': [
    "const assert = require('node:assert/strict');",
    "const model = require('./src/models/todoModel');",
    "const service = require('./src/service');",
    '',
    '(async () => {',
    "    const a = await service.addTodo('write tests');",
    "    await service.addTodo('ship');",
    '    await service.complete(a.id);',
    "    assert.deepEqual((await service.openTodos()).map((t) => t.title), ['ship']);",
    '    assert.equal(await model.remove(a.id), true);',
    "    console.log('ok');",
    '})().catch((err) => { console.error(err); process.exit(1); });',
    '',
  ].join('\n'),
};

const PRICING = {
  'src/pricing.js': [
    'function withTax(amount, rate) {',
    '  return round(amount * (1 + rate));',
    '}',
    '',
    'function taxOnly(amount, rate) {',
    '  return round(amount * rate);',
    '}',
    '',
    'function lineTotal(qty, price, rate) {',
    '  return withTax(qty * price, rate);',
    '}',
    '',
    'function round(x) {',
    '  return Math.round(x * 100) / 100;',
    '}',
    '',
    'module.exports = { withTax, taxOnly, lineTotal, round };',
    '',
  ].join('\n'),
  'test.js': [
    "const assert = require('node:assert/strict');",
    "const p = require('./src/pricing');",
    'assert.equal(p.withTax(100, 0.2), 120);',
    'assert.equal(p.taxOnly(50, 0.1), 5);',
    'assert.equal(p.lineTotal(3, 10, 0.5), 45);',
    "console.log('ok');",
    '',
  ].join('\n'),
};

// Saved by an editor on Windows: CRLF throughout, indented with tabs.
const CRLF_JS = [
  'function parsePort(value) {',
  '\tconst n = Number(value);',
  '\treturn n;',
  '}',
  '',
  'module.exports = { parsePort };',
  '',
].join('\r\n');

const SERVER_APP = {
  'app.js': [
    "const http = require('node:http');",
    '',
    'const HOST = process.env.HOST || "127.0.0.1";',
    'const PORT = Number(process.env.PORT) || 3000;',
    '',
    'function start() {',
    "    return http.createServer((req, res) => res.end('ok')).listen(PORT, HOST);",
    '}',
    '',
    'module.exports = { HOST, PORT, start };',
    '',
  ].join('\n'),
  // Run first by the task: it adds lines above everything, so line numbers from before it name other lines after it.
  'add-license.js': [
    "const fs = require('node:fs');",
    "const text = fs.readFileSync('app.js', 'utf8');",
    "if (!text.startsWith('// SPDX')) fs.writeFileSync('app.js', '// SPDX-License-Identifier: MIT\\n// (c) Example\\n\\n' + text);",
    '',
  ].join('\n'),
};

// A long file: three changes far apart in it, asked for at once. Twenty plain functions pad it out so a search quoted
// from memory has lots of near-identical text to drift into.
const BIG_INVENTORY = (() => {
  const helpers = Array.from({ length: 20 }, (_, i) => [
    `function metric${i}(items) {`,
    `  let total = 0;`,
    `  for (const item of items) {`,
    `    total += item.qty * ${i + 1};`,
    `  }`,
    `  return total;`,
    `}`,
    '',
  ].join('\n')).join('\n');
  return {
    'src/inventory.js': [
      "'use strict';",
      '',
      'const LOW_STOCK = 5;',
      'const MAX_QTY = 1000;',
      '',
      'function restock(stock, sku, qty) {',
      '  stock[sku] = (stock[sku] || 0) + qty;',
      '  return stock[sku];',
      '}',
      '',
      helpers,
      'function reserve(stock, sku, qty) {',
      '  if ((stock[sku] || 0) < qty) return false;',
      '  stock[sku] -= qty;',
      '  return true;',
      '}',
      '',
      'function lowStock(stock) {',
      '  return Object.keys(stock).filter((sku) => stock[sku] <= LOW_STOCK);',
      '}',
      '',
      'module.exports = { LOW_STOCK, MAX_QTY, restock, reserve, lowStock, metric0, metric19 };',
      '',
    ].join('\n'),
    'test.js': [
      "const assert = require('node:assert/strict');",
      "const inv = require('./src/inventory');",
      'const stock = {};',
      "assert.equal(inv.addStock(stock, 'a', 4), 4);",
      "assert.throws(() => inv.addStock(stock, 'a', 0));",
      "assert.throws(() => inv.addStock(stock, 'a', 1001));",
      "assert.equal(inv.reserve(stock, 'a', 3), true);",
      "assert.deepEqual(inv.lowStock(stock), ['a']);",
      "inv.addStock(stock, 'b', 9);",
      "assert.deepEqual(inv.lowStock(stock), ['a', 'b']);",
      "assert.equal(inv.metric19([{ qty: 2 }]), 40);",
      "console.log('ok');",
      '',
    ].join('\n'),
  };
})();

// The Result.cs session as JavaScript: a second request changes lines right next to the first one's.
const RESULT_JS = {
  'src/result.js': [
    'class Result {',
    '  constructor(ok, error) {',
    '    this.ok = ok;',
    '    this.error = error;',
    '  }',
    '',
    '  static success() {',
    '    return new Result(true, null);',
    '  }',
    '',
    '  static failure(error) {',
    '    return new Result(false, error);',
    '  }',
    '}',
    '',
    'class ValueResult extends Result {',
    '  constructor(value, ok, error) {',
    '    super(ok, error);',
    '    this.value = value;',
    '  }',
    '',
    '  static success(value) {',
    '    return new ValueResult(value, true, null);',
    '  }',
    '',
    '  static failure(error) {',
    '    return new ValueResult(undefined, false, error);',
    '  }',
    '}',
    '',
    'module.exports = { Result, ValueResult };',
    '',
  ].join('\n'),
  'test.js': [
    "const assert = require('node:assert/strict');",
    "const { Result, ValueResult } = require('./src/result');",
    "assert.equal(Result.success().error, '');",
    "assert.equal(ValueResult.success(3).error, '');",
    'assert.equal(ValueResult.success(3).value, 3);',
    "const v = new ValueResult(7);",
    "assert.equal(v.ok, true);",
    "assert.equal(v.error, '');",
    "assert.equal(Result.failure('x').error, 'x');",
    "console.log('ok');",
    '',
  ].join('\n'),
};

// One signature, three files that must agree on it.
const FORMAT_APP = {
  'src/format.js': [
    'function formatPrice(amount) {',
    "  return '$' + amount.toFixed(2);",
    '}',
    '',
    'module.exports = { formatPrice };',
    '',
  ].join('\n'),
  'src/cart.js': [
    "const { formatPrice } = require('./format');",
    '',
    'function cartLine(name, amount) {',
    "  return name + ': ' + formatPrice(amount);",
    '}',
    '',
    'module.exports = { cartLine };',
    '',
  ].join('\n'),
  'src/invoice.js': [
    "const { formatPrice } = require('./format');",
    '',
    'function invoiceTotal(lines) {',
    '  const total = lines.reduce((sum, l) => sum + l.amount, 0);',
    "  return 'Total ' + formatPrice(total);",
    '}',
    '',
    'module.exports = { invoiceTotal };',
    '',
  ].join('\n'),
  'test.js': [
    "const assert = require('node:assert/strict');",
    "const { formatPrice } = require('./src/format');",
    "const { cartLine } = require('./src/cart');",
    "const { invoiceTotal } = require('./src/invoice');",
    "assert.equal(formatPrice(3), '$3.00');",
    "assert.equal(formatPrice(3, '€'), '€3.00');",
    "assert.equal(cartLine('tea', 2, '£'), 'tea: £2.00');",
    "assert.equal(invoiceTotal([{ amount: 1 }, { amount: 2 }], '€'), 'Total €3.00');",
    "assert.equal(invoiceTotal([{ amount: 1 }]), 'Total $1.00');",
    "console.log('ok');",
    '',
  ].join('\n'),
};

const SCENARIOS = [
  {
    id: 'node-rename',
    repo: 'nodedemo',
    prompt: 'rename the Cart method subtotal to computeSubtotal everywhere it is used, then run npm test',
    check: (cwd) => sh('npm test', cwd).status === 0 && /computeSubtotal\(\)/.test(read(join(cwd, 'src/cart.js'))) && !/\bsubtotal\(\)/.test(read(join(cwd, 'src/cart.js')) + read(join(cwd, 'test/cart.test.js'))),
  },
  {
    id: 'node-tests',
    repo: 'nodedemo',
    prompt: 'add unit tests for src/inventory.js and run them',
    check: (cwd) => sh('npm test', cwd).status === 0 && readdirSync(join(cwd, 'test')).some((f) => /inventory/i.test(f) || /Inventory/.test(read(join(cwd, 'test', f)))),
  },
  {
    id: 'py-bugfix',
    repo: 'pydemo',
    prompt: 'Account.withdraw accepts negative amounts. Make it raise ValueError for amounts that are not positive, like deposit does, add a test for it, and run the tests',
    check: (cwd) => sh('python -m pytest -q', cwd).status === 0 && sh('python -c "from bank.account import Account\ntry:\n    Account(\'x\', 5).withdraw(-1)\nexcept ValueError:\n    raise SystemExit(0)\nraise SystemExit(1)"', cwd).status === 0,
  },
  {
    id: 'dotnet-rename',
    repo: 'dotnetdemo',
    prompt: 'rename FindByAuthor to FindBooksByAuthor everywhere it is used, then build and run the tests',
    check: (cwd) => sh('dotnet test', cwd, 600_000).status === 0 && /FindBooksByAuthor/.test(read(join(cwd, 'Library.Core/Catalog.cs'))) && !/FindByAuthor\(/.test(read(join(cwd, 'Library.Tests/CatalogTests.cs'))),
  },
  {
    id: 'dotnet-question',
    repo: 'dotnetdemo',
    prompt: 'What is the most a late fee can ever be? Answer from the code; do not change any files.',
    check: (cwd, run) => clean(cwd) && /\b10\b/.test(run.answer),
  },
  {
    id: 'go-tests',
    repo: null,
    setup: (cwd) => {
      writeFileSync(join(cwd, 'go.mod'), 'module greeter\n\ngo 1.22\n');
      writeFileSync(join(cwd, 'main.go'), GO_MAIN);
      sh('git init -q && git add -A && git -c user.email=eval@local -c user.name=eval commit -qm init', cwd);
    },
    prompt: 'add unit tests for main.go and run them',
    check: (cwd) => sh('go test ./...', cwd).status === 0 && readdirSync(cwd).some((f) => f.endsWith('_test.go')),
  },
  {
    id: 'node-insert',
    repo: 'nodedemo',
    prompt: 'add a clear() method to Cart, right after subtotal, that empties the items and removes any discount. Add a test for it and run npm test',
    check: (cwd) => sh('npm test', cwd).status === 0 && /\bclear\(\)\s*\{/.test(read(join(cwd, 'src/cart.js'))) && /\bsubtotal\(\)\s*\{/.test(read(join(cwd, 'src/cart.js'))),
  },
  {
    id: 'node-todo',
    repo: 'nodedemo',
    prompt: 'Make a todo list for this, then work through it: Inventory.restock and Inventory.reserve should throw an Error when qty is not a positive integer. Add tests in test/inventory.test.js and run npm test',
    check: (cwd, run) => run.tools.includes('todo_write') && sh('npm test', cwd).status === 0 && script(cwd, "import { Inventory } from './src/inventory.js'; const inv = new Inventory(); const bad = [() => inv.restock('a', 0), () => inv.reserve('a', -1), () => inv.restock('a', 1.5)]; process.exit(bad.every((f) => { try { f(); return false; } catch { return true; } }) ? 0 : 1);"),
  },
  {
    id: 'node-plan',
    repo: 'nodedemo',
    args: ['--plan'],
    prompt: 'add a Cart.itemCount() method that returns the total quantity of all items, add a test for it, and run npm test',
    check: (cwd) => sh('npm test', cwd).status === 0 && /\bitemCount\(\)\s*\{/.test(read(join(cwd, 'src/cart.js'))),
  },
  {
    // A small step budget makes the first turn stop part way, so /continue has something to resume.
    id: 'node-resume',
    repo: 'nodedemo',
    config: { maxIterations: 4 },
    inputs: ['rename Cart.removeItem to deleteItem everywhere it is used, add a test for deleteItem, and run npm test', '/continue', '/continue', '/continue'],
    check: (cwd) => sh('npm test', cwd).status === 0 && /\bdeleteItem\(/.test(read(join(cwd, 'src/cart.js'))) && !/\bremoveItem\(/.test(read(join(cwd, 'src/cart.js'))),
  },
  {
    id: 'node-documents',
    repo: 'nodedemo',
    prompt: 'Create a PDF named cart-summary.pdf listing each method of the Cart class in src/cart.js with a one-line description, and an Excel file cart-methods.xlsx with the columns Method and Description.',
    // Real files, not text named like them: a PDF opens with %PDF and an .xlsx is a zip.
    check: (cwd) => read(join(cwd, 'cart-summary.pdf')).startsWith('%PDF') && read(join(cwd, 'cart-methods.xlsx')).startsWith('PK'),
  },
  {
    id: 'web-lookup',
    repo: 'nodedemo',
    prompt: 'What is the latest published version of the npm package express? Look it up, do not answer from memory, and do not change any files.',
    // The registry is the truth the answer is checked against; offline, any looked-up version number passes.
    check: (cwd, run) => {
      const truth = sh('npm view express version', cwd, 60_000).stdout?.trim();
      const looked = run.tools.some((t) => t === 'web_search' || t === 'web_fetch' || t === 'exec_shell');
      return clean(cwd) && looked && (truth ? run.answer.includes(truth) : /\b\d+\.\d+\.\d+\b/.test(run.answer));
    },
  },
  {
    id: 'dotnet-warning',
    repo: 'dotnetdemo',
    setup: (cwd) => {
      const file = join(cwd, 'Library.Core/Catalog.cs');
      writeFileSync(file, read(file).replace('    public bool Return(', '    public int Count()\n    {\n        int checkedOut = 0;\n        return _books.Count;\n    }\n\n    public bool Return('));
    },
    prompt: 'dotnet build reports a compiler warning in Library.Core. Fix the warning without changing what the code does, then build and run the tests.',
    check: (cwd) => {
      const build = sh('dotnet build', cwd, 600_000);
      return build.status === 0 && /\b0 Warning\(s\)/.test(build.stdout) && sh('dotnet test', cwd, 600_000).status === 0 && /int Count\(\)/.test(read(join(cwd, 'Library.Core/Catalog.cs')));
    },
  },
  // The four below name no tool: they measure whether a model reaches for run_script / code_review on its own.
  {
    id: 'script-logs',
    repo: null,
    setup: (cwd) => writeAll(cwd, { 'logs/app.log': APP_LOG }),
    prompt: 'Which error message appears most often in logs/app.log, and how many times? Do not change any files.',
    check: (cwd, run) => clean(cwd) && run.tools.includes('run_script') && /db timeout/i.test(run.answer) && run.answer.includes(String(LOG_TOP)),
  },
  {
    id: 'script-deps',
    repo: null,
    setup: (cwd) => writeAll(cwd, PACKAGES),
    prompt: 'Which dependencies are used at different versions across the packages? Do not change any files.',
    check: (cwd, run) => clean(cwd) && run.tools.includes('run_script') && /react/i.test(run.answer) && /lodash/i.test(run.answer),
  },
  {
    id: 'review-dead-code',
    repo: null,
    setup: (cwd) => writeAll(cwd, DEAD_CODE_SRC),
    prompt: 'Is there dead code or duplicated code in src? Do not change any files.',
    check: (cwd, run) => clean(cwd) && run.tools.includes('code_review') && /legacyRound/.test(run.answer) && /orders/i.test(run.answer) && /carts/i.test(run.answer),
  },
  {
    id: 'review-after-change',
    repo: 'nodedemo',
    prompt: 'make Cart.subtotal round to 2 decimals and run the tests',
    // Nobody asks for a review: this measures whether the model checks its own change before it finishes.
    check: (cwd, run) => !clean(cwd) && sh('npm test', cwd).status === 0 && run.tools.includes('code_review'),
  },
  // Edit tasks: they pass on the result, and each run's line says how many edit_file calls landed (see editTally).
  {
    id: 'edit-async',
    repo: null,
    setup: (cwd) => writeAll(cwd, TODO_APP),
    prompt: 'Convert every method of TodoModel in src/models/todoModel.js to async (async/await), and update src/service.js so its functions are async and await the model. Then run node test.js.',
    check: (cwd) => sh('node test.js', cwd).status === 0 && /async findAll\(\)/.test(read(join(cwd, 'src/models/todoModel.js'))) && /await model\./.test(read(join(cwd, 'src/service.js'))),
  },
  {
    id: 'edit-rename-param',
    repo: null,
    setup: (cwd) => writeAll(cwd, PRICING),
    prompt: 'In src/pricing.js rename the parameter rate to taxRate in every function that takes it, without changing behaviour. Then run node test.js.',
    check: (cwd) => sh('node test.js', cwd).status === 0 && !/\brate\b/.test(read(join(cwd, 'src/pricing.js'))) && /taxRate/.test(read(join(cwd, 'src/pricing.js'))),
  },
  {
    id: 'edit-crlf-tabs',
    repo: null,
    setup: (cwd) => writeAll(cwd, { 'src/port.js': CRLF_JS }),
    prompt: 'Make parsePort in src/port.js throw an Error when the value is not an integer between 1 and 65535. Keep the file\'s style.',
    check: (cwd) => {
      const text = read(join(cwd, 'src/port.js'));
      // Still CRLF throughout and still tab-indented: an edit that mixed in LF or spaces fails.
      const style = !/(?<!\r)\n/.test(text) && !/^ +\S/m.test(text);
      return style && script(cwd, "import { createRequire } from 'node:module'; const { parsePort } = createRequire(import.meta.url)('./src/port.js'); const bad = ['x', '0', '70000', '1.5']; process.exit(parsePort('8080') === 8080 && bad.every((v) => { try { parsePort(v); return false; } catch { return true; } }) ? 0 : 1);");
    },
  },
  {
    id: 'edit-after-shell',
    repo: null,
    setup: (cwd) => writeAll(cwd, SERVER_APP),
    inputs: ['Read app.js and tell me which line sets the default port.', 'Run node add-license.js, then change the default port in app.js to 8080. Do not change anything else.'],
    check: (cwd) => {
      const text = read(join(cwd, 'app.js'));
      return /Number\(process\.env\.PORT\) \|\| 8080;/.test(text) && text.startsWith('// SPDX') && /HOST \|\| "127\.0\.0\.1"/.test(text) && (text.match(/SPDX/g) ?? []).length === 1;
    },
  },
  {
    id: 'edit-big-file',
    repo: null,
    setup: (cwd) => writeAll(cwd, BIG_INVENTORY),
    prompt: 'Make three changes in src/inventory.js: rename restock to addStock (and export it under the new name), make addStock throw an Error when qty is not an integer from 1 to MAX_QTY, and change LOW_STOCK to 10. Then run node test.js.',
    check: (cwd) => {
      const text = read(join(cwd, 'src/inventory.js'));
      // The twenty helpers must come through untouched: a wide edit that rewrote them is not the change asked for.
      const helpers = Array.from({ length: 20 }, (_, i) => text.includes(`    total += item.qty * ${i + 1};`)).every(Boolean);
      return sh('node test.js', cwd).status === 0 && helpers && !/\brestock\b/.test(text);
    },
  },
  {
    id: 'edit-second-change',
    repo: null,
    setup: (cwd) => writeAll(cwd, RESULT_JS),
    inputs: [
      "In src/result.js, make Result.success() and ValueResult.success() use an empty string '' for error instead of null.",
      'Now give the ValueResult constructor defaults: ok defaults to true and error to an empty string. Then run node test.js.',
    ],
    check: (cwd) => sh('node test.js', cwd).status === 0 && !/null/.test(read(join(cwd, 'src/result.js'))),
  },
  {
    id: 'edit-three-files',
    repo: null,
    setup: (cwd) => writeAll(cwd, FORMAT_APP),
    prompt: "Give formatPrice in src/format.js a second parameter, currency, defaulting to '$', and pass it through: cartLine and invoiceTotal each take an optional currency as their last parameter and hand it to formatPrice. Then run node test.js.",
    check: (cwd) => sh('node test.js', cwd).status === 0,
  },
];

// The newest saved session under a workspace; each eval workspace holds exactly one.
function sessionOf(cwd) {
  const dir = join(cwd, '.ollamacode', 'sessions');
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => join(dir, f));
  files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  try {
    return files.length ? JSON.parse(readFileSync(files[0], 'utf8')) : null;
  } catch {
    return null;
  }
}

// How the last turn stopped. A checkpoint is kept only when a turn ends unfinished, so none means it completed.
function stopReasonOf(cwd) {
  const dir = join(cwd, '.ollamacode', 'checkpoints');
  if (!existsSync(dir)) return 'complete';
  const files = readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => join(dir, f));
  files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  try {
    return files.length ? JSON.parse(readFileSync(files[0], 'utf8')).stopReason || 'complete' : 'complete';
  } catch {
    return 'unknown';
  }
}

// A private home for a scenario that changes settings: the user's config with the overrides merged in, and their provider logins.
function homeFor(base, scenario) {
  const home = join(base, `${scenario.id}.home`);
  const real = process.env.OLLAMACODE_HOME ?? join(homedir(), '.ollamacode');
  mkdirSync(home, { recursive: true });
  let config = {};
  try {
    config = JSON.parse(read(join(real, 'config.json')) || '{}');
  } catch {
    // An unreadable config runs on defaults, as ocode itself would.
  }
  writeFileSync(join(home, 'config.json'), JSON.stringify({ ...config, ...scenario.config }, null, 2));
  if (existsSync(join(real, 'providers'))) cpSync(join(real, 'providers'), join(home, 'providers'), { recursive: true });
  return home;
}

// How edit_file fared: calls made, and how many of them landed. A reused or refused repeat counts as a call that did not.
function editTally(session) {
  const messages = [...(session?.explored ?? []).flat(), ...(session?.subagents ?? []).flatMap((r) => r.messages ?? []), ...(session?.messages ?? [])];
  const edits = new Set();
  for (const m of messages) for (const c of m.tool_calls ?? []) if (c.function?.name === 'edit_file') edits.add(c.id);
  let landed = 0;
  for (const m of messages) if (m.role === 'tool' && edits.has(m.tool_call_id) && /^OK edit_file/.test(String(m.content ?? ''))) landed += 1;
  return { calls: edits.size, landed };
}

// What the model did, read from the calls and results it actually made.
function behaviour(session) {
  // Plan-mode exploration is saved beside the conversation; its calls count like any other.
  const messages = [...(session?.explored ?? []).flat(), ...(session?.subagents ?? []).flatMap((r) => r.messages ?? []), ...(session?.messages ?? [])];
  const calls = new Map();
  const tools = new Set();
  const errors = [];
  let toolCalls = 0;
  let reused = 0;
  for (const m of messages) {
    for (const c of m.tool_calls ?? []) {
      toolCalls += 1;
      calls.set(c.id, c);
      if (c.function?.name) tools.add(c.function.name);
    }
    if (m.role !== 'tool') continue;
    const text = String(m.content ?? '');
    if (/Reused —/.test(text.split('\n')[0])) reused += 1;
    const err = /^ERROR (\S+)(?: \[(\w+)\])? — (.*)$/m.exec(text);
    if (err) errors.push({ tool: err[1], code: err[2] ?? '?', message: err[3], args: calls.get(m.tool_call_id)?.function?.arguments });
  }
  const last = [...messages].reverse().find((m) => m.role === 'assistant' && !(m.tool_calls?.length));
  return { toolCalls, tools: [...tools], reused, errors, answer: String(last?.content ?? '').trim() };
}

// One chat run. What it prints goes to `logFile` as it comes, so a long task can be followed while it runs
// (tail -f the file). At the deadline the whole process tree is stopped: killing only ocode left a test or server it
// had started holding the pipes open, and on Windows the eval then waited for ever.
function runChat(args, { cwd, env, input, timeoutMs, logFile }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
    const log = createWriteStream(logFile);
    let output = '';
    const take = (chunk) => {
      const text = String(chunk);
      output += text;
      log.write(text);
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      stopTree(child);
    }, timeoutMs);
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      log.end();
      resolve({ output, code, timedOut });
    };
    // 'exit', not 'close': close waits for every holder of the pipes, which a leftover grandchild may never let go.
    child.on('exit', (code) => setTimeout(() => finish(code), 500));
    child.on('error', (err) => {
      take(String(err?.message ?? err));
      finish(null);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

function stopTree(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
  else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }
}

async function runScenario(model, scenario, base, timeoutMs) {
  const cwd = join(base, scenario.id);
  if (scenario.repo) {
    const cloned = sh(`git clone -q --local "${join(LAB, scenario.repo)}" "${cwd}"`, base);
    if (cloned.status !== 0) return { id: scenario.id, error: `clone failed: ${cloned.stderr.trim()}` };
    scenario.setup?.(cwd);
  } else {
    mkdirSync(cwd, { recursive: true });
    scenario.setup(cwd);
  }
  const started = Date.now();
  const inputs = scenario.inputs ?? [scenario.prompt];
  const env = scenario.config ? { ...process.env, OLLAMACODE_HOME: homeFor(base, scenario) } : process.env;
  const logFile = join(base, `${scenario.id}.out.txt`);
  const run = await runChat(['--yes', '--new', ...(scenario.args ?? []), ...(model ? ['--model', model] : [])], {
    cwd,
    env,
    input: `${inputs.join('\n')}\n`,
    timeoutMs: timeoutMs * inputs.length,
    logFile,
  });
  const out = run.output.replace(ANSI, '');
  writeFileSync(logFile, out);
  const seen = behaviour(sessionOf(cwd));
  const modelCalls = Number(/(\d+) model calls?/.exec(out)?.[1] ?? 0);
  const result = {
    id: scenario.id,
    seconds: Math.round((Date.now() - started) / 1000),
    timedOut: run.timedOut,
    exit: run.code,
    modelCalls,
    ...seen,
    stopReason: stopReasonOf(cwd),
    providerError: /Ollama error|usage limit|ECONNREFUSED|No LLM provider is available/i.test(out),
  };
  result.edits = editTally(sessionOf(cwd));
  result.stuck = result.stopReason === 'guard_stuck';
  result.limit = result.stopReason === 'max_iterations' || result.stopReason === 'output_truncated';
  result.pass = !result.timedOut && !result.providerError && Boolean(scenario.check(cwd, result));
  return result;
}

async function evaluate() {
  const model = flag('model');
  const only = flag('only')?.split(',');
  const timeoutMs = Number(flag('timeout') ?? 300) * 1000;
  const picked = SCENARIOS.filter((s) => !only || only.includes(s.id));
  const base = join(tmpdir(), 'ocode-eval', `${(model ?? 'default').replace(/[^\w.-]+/g, '_')}-${Date.now()}`);
  mkdirSync(base, { recursive: true });
  console.log(`model ${model ?? '(configured default)'} · ${picked.length} task(s) · workspaces in ${base}\n`);

  // One live run at a time: the backend cannot take parallel sessions.
  const results = [];
  for (const scenario of picked) {
    process.stdout.write(`  ${scenario.id} … (up to ${Math.round((timeoutMs * (scenario.inputs?.length ?? 1)) / 1000)}s; follow ${join(base, `${scenario.id}.out.txt`)}) `);
    const r = await runScenario(model, scenario, base, timeoutMs);
    results.push(r);
    console.log(r.error ?? `${r.pass ? 'PASS' : 'FAIL'} · ${r.seconds}s · ${r.toolCalls} calls${r.edits?.calls ? ` · edits ${r.edits.landed}/${r.edits.calls} landed` : ''} · ${r.errors.length} errors${r.stuck ? ' · stuck' : ''}${r.limit ? ` · stopped (${r.stopReason})` : ''}${r.timedOut ? ' · timed out' : ''}${r.providerError ? ' · provider error' : ''}${r.answer ? '' : ' · no answer'}`);
  }

  const passed = results.filter((r) => r.pass).length;
  const errors = results.flatMap((r) => r.errors ?? []);
  const edits = results.reduce((t, r) => ({ calls: t.calls + (r.edits?.calls ?? 0), landed: t.landed + (r.edits?.landed ?? 0) }), { calls: 0, landed: 0 });
  if (edits.calls) console.log(`\nedit_file: ${edits.landed}/${edits.calls} calls landed (${Math.round((100 * edits.landed) / edits.calls)}%)`);
  console.log(`\n${passed}/${results.length} passed · ${errors.length} tool error(s) · ${results.filter((r) => r.stuck).length} stuck · ${results.filter((r) => !r.answer && !r.error).length} without an answer`);
  if (errors.length) {
    console.log('\ntool errors:');
    for (const [key, n] of countErrors(errors)) console.log(`  ${String(n).padStart(3)}  ${key}`);
  }
  writeFileSync(join(base, 'report.json'), JSON.stringify({ model, results }, null, 2));
  console.log(`\nreport: ${join(base, 'report.json')}`);
  console.log(`report card: ${updateCard(model ?? 'default', results)}`);
  process.exit(passed === results.length ? 0 : 1);
}

// A report card per model: the latest result of each scenario, kept across runs, with the mistakes that model made most.
const CARDS = join(tmpdir(), 'ocode-eval', 'cards');

function updateCard(model, results) {
  mkdirSync(CARDS, { recursive: true });
  const file = join(CARDS, `${model.replace(/[^\w.-]+/g, '_')}.json`);
  let card = { model, scenarios: {} };
  try {
    card = JSON.parse(read(file) || 'null') ?? card;
  } catch {
    // A card that cannot be read is started again.
  }
  const at = new Date().toISOString();
  for (const r of results) {
    if (r.error) continue;
    card.scenarios[r.id] = {
      pass: r.pass,
      at,
      seconds: r.seconds,
      errors: r.errors.length,
      stopReason: r.stopReason,
      answered: Boolean(r.answer),
      topErrors: countErrors(r.errors).slice(0, 3).map(([key, n]) => `${n}× ${key}`),
    };
  }
  const all = Object.values(card.scenarios);
  card.summary = { passed: all.filter((s) => s.pass).length, total: all.length, updatedAt: at };
  writeFileSync(file, JSON.stringify(card, null, 2));
  return `${file} (${card.summary.passed}/${card.summary.total} scenarios passing)`;
}

// One line per kind of mistake: values that differ per call (paths, quoted text, numbers) are masked so repeats group together.
function errorKey(e) {
  const message = e.message
    .replace(/“[^”]*”|"[^"]*"|'[^']*'/g, '…')
    .replace(/\b[\w./\\-]+\.\w{1,5}\b/g, '<file>')
    .replace(/\d+/g, 'N');
  return `${e.tool} [${e.code}] ${message}`.slice(0, 180);
}

function countErrors(errors) {
  const counts = new Map();
  for (const e of errors) counts.set(errorKey(e), (counts.get(errorKey(e)) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]);
}

function* sessionFiles(dir, depth = 0) {
  if (depth > 6 || !existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'bin' || entry.name === 'obj' || entry.name === '.git') continue;
      yield* sessionFiles(path, depth + 1);
    } else if (entry.name.endsWith('.json') && /[\\/]\.ollamacode[\\/]sessions$/.test(dir)) {
      yield path;
    }
  }
}

function mine() {
  const dirs = argv.slice(argv.indexOf('--mine') + 1).filter((a) => !a.startsWith('--'));
  const errors = [];
  let sessions = 0;
  for (const dir of dirs.length ? dirs : [LAB, join(tmpdir(), 'ocode-eval')]) {
    // A folder that is not there found nothing: say so, rather than report "0 sessions" as if it had been searched.
    // Git Bash drops the backslashes of an unquoted C:\path, so the hint names the forms that survive it.
    if (!existsSync(dir)) {
      console.log(`not found: ${dir}${/^[A-Za-z]:[^\\/]/.test(dir) ? '  (in Git Bash write C:/projects/x or quote the path)' : ''}`);
      continue;
    }
    for (const file of sessionFiles(dir)) {
      try {
        const session = JSON.parse(readFileSync(file, 'utf8'));
        const model = String(session.model ?? '?');
        errors.push(...behaviour(session).errors.map((e) => ({ ...e, model })));
        sessions += 1;
      } catch {
        // A session being written or from an older format: skip it.
      }
    }
  }
  console.log(`${sessions} session(s) · ${errors.length} tool error(s)\n`);
  // A mistake several models make points at the tool's design; one model's alone is that model's problem.
  for (const [key, n] of countErrors(errors)) {
    const example = errors.find((e) => errorKey(e) === key)?.args;
    const models = [...new Set(errors.filter((e) => errorKey(e) === key).map((e) => e.model))];
    const tag = models.length > 1 ? ` [tool design: ${models.length} models]` : ` [${models[0]}]`;
    console.log(`${String(n).padStart(4)}  ${key}${tag}`);
    if (example) console.log(`        e.g. ${JSON.stringify(example).slice(0, 200)}`);
  }
}

if (argv.includes('--mine')) mine();
else await evaluate();
