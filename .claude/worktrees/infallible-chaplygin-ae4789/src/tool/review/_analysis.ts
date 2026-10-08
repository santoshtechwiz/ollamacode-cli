/** Static JS/TS analysis for code_review: one parse per file with the bundled TypeScript parser, no type program. */

import ts from 'typescript';

export type FindingSeverity = 'error' | 'warning' | 'info';

export interface Finding {
  file: string;
  line: number;
  category: string;
  severity: FindingSeverity;
  message: string;
}

export interface ImportBinding {
  /** The exported name it reads: "default", "*" for a namespace/side-effect/dynamic import, or the named export. */
  imported: string;
  /** The local name, or "" when nothing is bound. */
  local: string;
}

export interface ImportInfo {
  source: string;
  line: number;
  kind: 'import' | 'reexport' | 'dynamic';
  typeOnly: boolean;
  bindings: ImportBinding[];
}

export interface ExportInfo {
  name: string;
  line: number;
}

export interface FunctionMetric {
  file: string;
  name: string;
  line: number;
  endLine: number;
  complexity: number;
  lines: number;
}

export interface FileAnalysis {
  file: string;
  imports: ImportInfo[];
  exports: ExportInfo[];
  functions: FunctionMetric[];
  /** How often each identifier appears outside import clauses; a declaration's own name counts once. */
  identifierCounts: Map<string, number>;
  /** Imported bindings never referenced in the file. */
  unusedImports: Array<{ name: string; line: number; source: string }>;
  findings: Finding[];
}

export const COMPLEXITY_THRESHOLD = 10;

const ANALYZABLE = /\.(?:m|c)?[jt]sx?$/i;

export function isAnalyzable(file: string): boolean {
  return ANALYZABLE.test(file) && !/\.d\.(?:m|c)?ts$/i.test(file);
}

function scriptKind(file: string): ts.ScriptKind {
  if (/\.tsx$/i.test(file)) return ts.ScriptKind.TSX;
  if (/\.jsx$/i.test(file)) return ts.ScriptKind.JSX;
  if (/\.(?:m|c)?js$/i.test(file)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

type FunctionNode =
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.MethodDeclaration
  | ts.ConstructorDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration;

function isFunctionNode(node: ts.Node): node is FunctionNode {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

function isLoop(node: ts.Node): boolean {
  return (
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    (ts.isForOfStatement(node) && !node.awaitModifier) ||
    ts.isWhileStatement(node) ||
    ts.isDoStatement(node)
  );
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return Boolean(mods?.some((m) => m.kind === kind));
}

function functionName(node: FunctionNode, sf: ts.SourceFile): string {
  if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) && node.name) return node.name.text;
  if (ts.isConstructorDeclaration(node)) return 'constructor';
  if ((ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) && node.name) {
    return node.name.getText(sf);
  }
  const parent = node.parent;
  if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  if (parent && ts.isPropertyAssignment(parent)) return parent.name.getText(sf);
  if (parent && ts.isPropertyDeclaration(parent)) return parent.name.getText(sf);
  return '<anonymous>';
}

/** Cyclomatic complexity of one function body, not counting nested functions. */
function complexityOf(fn: FunctionNode): number {
  let score = 1;
  const visit = (node: ts.Node) => {
    if (node !== fn && isFunctionNode(node)) return;
    switch (node.kind) {
      case ts.SyntaxKind.IfStatement:
      case ts.SyntaxKind.ConditionalExpression:
      case ts.SyntaxKind.ForStatement:
      case ts.SyntaxKind.ForInStatement:
      case ts.SyntaxKind.ForOfStatement:
      case ts.SyntaxKind.WhileStatement:
      case ts.SyntaxKind.DoStatement:
      case ts.SyntaxKind.CaseClause:
      case ts.SyntaxKind.CatchClause:
        score += 1;
        break;
      case ts.SyntaxKind.BinaryExpression: {
        const op = (node as ts.BinaryExpression).operatorToken.kind;
        if (
          op === ts.SyntaxKind.AmpersandAmpersandToken ||
          op === ts.SyntaxKind.BarBarToken ||
          op === ts.SyntaxKind.QuestionQuestionToken
        ) score += 1;
        break;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(fn);
  return score;
}

const SHELL_CALLS = new Set(['exec', 'execSync']);

function calleeName(expr: ts.Expression): string | null {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return null;
}

function isInterpolated(arg: ts.Expression | undefined): boolean {
  if (!arg) return false;
  if (ts.isTemplateExpression(arg)) return true;
  return ts.isBinaryExpression(arg) && arg.operatorToken.kind === ts.SyntaxKind.PlusToken;
}

/** Analyze one JS/TS source. `file` is only a label; nothing is read from disk. */
export function analyzeSource(file: string, text: string): FileAnalysis {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file));
  const lineOf = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const isTs = !/\.(?:m|c)?jsx?$/i.test(file);

  const imports: ImportInfo[] = [];
  const exportsList: ExportInfo[] = [];
  const functions: FunctionMetric[] = [];
  const findings: Finding[] = [];
  const add = (node: ts.Node | number, category: string, severity: FindingSeverity, message: string) => {
    findings.push({ file, line: typeof node === 'number' ? node : lineOf(node), category, severity, message });
  };

  // Imported local names, and the identifiers that name them anywhere else.
  const importedLocals: Array<{ name: string; line: number; source: string }> = [];
  const importNameNodes = new Set<ts.Node>();
  const asyncNames = new Set<string>();

  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
      const clause = stmt.importClause;
      const bindings: ImportBinding[] = [];
      if (clause?.name) {
        bindings.push({ imported: 'default', local: clause.name.text });
        importNameNodes.add(clause.name);
      }
      const named = clause?.namedBindings;
      if (named && ts.isNamespaceImport(named)) {
        bindings.push({ imported: '*', local: named.name.text });
        importNameNodes.add(named.name);
      } else if (named && ts.isNamedImports(named)) {
        for (const el of named.elements) {
          bindings.push({ imported: (el.propertyName ?? el.name).text, local: el.name.text });
          importNameNodes.add(el.name);
          if (el.propertyName) importNameNodes.add(el.propertyName);
        }
      }
      if (!clause) bindings.push({ imported: '*', local: '' });
      const line = lineOf(stmt);
      // `import { type A, type B }` is erased at runtime just like `import type { A, B }`.
      const typeOnly = Boolean(clause?.isTypeOnly) || Boolean(
        clause && !clause.name && named && ts.isNamedImports(named) && named.elements.length > 0 && named.elements.every((el) => el.isTypeOnly),
      );
      imports.push({ source: stmt.moduleSpecifier.text, line, kind: 'import', typeOnly, bindings });
      for (const b of bindings) if (b.local) importedLocals.push({ name: b.local, line, source: stmt.moduleSpecifier.text });
    } else if (ts.isExportDeclaration(stmt)) {
      const line = lineOf(stmt);
      const clause = stmt.exportClause;
      if (stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)) {
        const bindings: ImportBinding[] = !clause || ts.isNamespaceExport(clause)
          ? [{ imported: '*', local: '' }]
          : clause.elements.map((el) => ({ imported: (el.propertyName ?? el.name).text, local: '' }));
        imports.push({ source: stmt.moduleSpecifier.text, line, kind: 'reexport', typeOnly: stmt.isTypeOnly, bindings });
        if (clause && ts.isNamedExports(clause)) for (const el of clause.elements) exportsList.push({ name: el.name.text, line });
        else if (clause && ts.isNamespaceExport(clause)) exportsList.push({ name: clause.name.text, line });
      } else if (clause && ts.isNamedExports(clause)) {
        for (const el of clause.elements) exportsList.push({ name: el.name.text, line });
      }
    } else if (ts.isExportAssignment(stmt)) {
      exportsList.push({ name: 'default', line: lineOf(stmt) });
    } else if (hasModifier(stmt, ts.SyntaxKind.ExportKeyword)) {
      const line = lineOf(stmt);
      if (hasModifier(stmt, ts.SyntaxKind.DefaultKeyword)) exportsList.push({ name: 'default', line });
      else if (ts.isVariableStatement(stmt)) {
        for (const decl of stmt.declarationList.declarations) {
          if (ts.isIdentifier(decl.name)) exportsList.push({ name: decl.name.text, line: lineOf(decl) });
        }
      } else if (
        (ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt) || ts.isInterfaceDeclaration(stmt) ||
          ts.isTypeAliasDeclaration(stmt) || ts.isEnumDeclaration(stmt)) && stmt.name
      ) {
        exportsList.push({ name: stmt.name.text, line });
      }
    }
  }

  // Names of functions declared async in this file, for the unawaited-call check.
  const collectAsync = (node: ts.Node) => {
    if (isFunctionNode(node) && hasModifier(node, ts.SyntaxKind.AsyncKeyword)) {
      const name = functionName(node, sf);
      if (name !== '<anonymous>' && name !== 'constructor') asyncNames.add(name);
    }
    ts.forEachChild(node, collectAsync);
  };
  collectAsync(sf);

  const identifierCounts = new Map<string, number>();
  const visit = (node: ts.Node, fn: FunctionNode | null, loopDepth: number) => {
    if (ts.isIdentifier(node) && !importNameNodes.has(node)) identifierCounts.set(node.text, (identifierCounts.get(node.text) ?? 0) + 1);

    if (isFunctionNode(node)) {
      const start = lineOf(node);
      const end = sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
      functions.push({ file, name: functionName(node, sf), line: start, endLine: end, complexity: complexityOf(node), lines: end - start + 1 });
      ts.forEachChild(node, (child) => visit(child, node, 0));
      return;
    }

    if (ts.isCatchClause(node)) {
      const body = node.block;
      const inner = text.slice(body.getStart(sf) + 1, body.getEnd() - 1);
      if (body.statements.length === 0 && !/\/\/|\/\*/.test(inner)) {
        add(node, 'error-handling', 'warning', 'empty catch block silently swallows the error');
      }
    }

    if (ts.isAwaitExpression(node) && loopDepth > 0) {
      add(node, 'performance', 'info', 'await inside a loop runs sequentially; consider Promise.all if the iterations are independent');
    }

    if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) && fn && hasModifier(fn, ts.SyntaxKind.AsyncKeyword)) {
      const name = calleeName(node.expression.expression);
      if (name && asyncNames.has(name)) {
        add(node, 'async', 'warning', `call to async ${name}() is not awaited; errors and ordering are lost`);
      }
    }

    if (ts.isCallExpression(node)) {
      const spec = node.arguments[0];
      const dynamic = node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require');
      if (dynamic && spec && ts.isStringLiteralLike(spec)) {
        imports.push({ source: spec.text, line: lineOf(node), kind: 'dynamic', typeOnly: false, bindings: [{ imported: '*', local: '' }] });
      }
      const name = calleeName(node.expression);
      if (name === 'eval' && ts.isIdentifier(node.expression)) add(node, 'security', 'warning', 'eval() executes arbitrary code');
      if (name && SHELL_CALLS.has(name) && isInterpolated(node.arguments[0])) {
        add(node, 'security', 'warning', `${name}() with an interpolated command string risks shell injection; pass an argv array to execFile/spawn`);
      }
      if (ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression) &&
          node.expression.expression.text === 'console' && ['log', 'debug'].includes(node.expression.name.text)) {
        add(node, 'leftover', 'info', `console.${node.expression.name.text} left in code`);
      }
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Function') {
      add(node, 'security', 'warning', 'new Function() executes arbitrary code');
    }
    if (node.kind === ts.SyntaxKind.DebuggerStatement) add(node, 'leftover', 'warning', 'debugger statement left in code');
    if (isTs && node.kind === ts.SyntaxKind.AnyKeyword) add(node, 'type', 'info', 'explicit any disables type checking here');

    if (ts.isBlock(node) || ts.isSourceFile(node) || ts.isCaseClause(node) || ts.isDefaultClause(node)) {
      const stmts = node.statements;
      for (let i = 0; i < stmts.length - 1; i++) {
        const s = stmts[i];
        if (ts.isReturnStatement(s) || ts.isThrowStatement(s) || ts.isBreakStatement(s) || ts.isContinueStatement(s)) {
          const next = stmts.slice(i + 1).find((n) => !ts.isFunctionDeclaration(n) && !ts.isEmptyStatement(n));
          if (next) add(next, 'dead-code', 'warning', 'unreachable code after return/throw/break/continue');
          break;
        }
      }
    }

    const nextDepth = isLoop(node) ? loopDepth + 1 : loopDepth;
    ts.forEachChild(node, (child) => visit(child, fn, nextDepth));
  };
  visit(sf, null, 0);

  findings.push(...markerFindings(file, text));

  for (const fnMetric of functions) {
    if (fnMetric.complexity > COMPLEXITY_THRESHOLD) {
      add(fnMetric.line, 'complexity', 'info', `${fnMetric.name} has cyclomatic complexity ${fnMetric.complexity} (threshold ${COMPLEXITY_THRESHOLD}); consider splitting it`);
    }
  }

  // JSX in a .jsx/.tsx file reads React without naming it.
  const jsxReact = /\.[jt]sx$/i.test(file);
  const unusedImports = importedLocals.filter((imp) => !identifierCounts.has(imp.name) && !(jsxReact && imp.name === 'React'));
  for (const imp of unusedImports) add(imp.line, 'unused', 'warning', `import ${imp.name} from "${imp.source}" is never used`);

  findings.sort((a, b) => a.line - b.line);
  return { file, imports, exports: exportsList, functions, identifierCounts, unusedImports, findings };
}

/** TODO/FIXME/XXX/HACK left in a comment, by line: comments are not nodes in every parser, so this is a line scan. */
export function markerFindings(file: string, text: string): Finding[] {
  const out: Finding[] = [];
  text.split('\n').forEach((line, i) => {
    if (/(?:\/\/|\/\*|\*|#|--)\s*(?:TODO|FIXME|XXX|HACK)\b/.test(line)) {
      out.push({ file, line: i + 1, category: 'leftover', severity: 'info', message: `marker: ${line.trim().slice(0, 100)}` });
    }
  });
  return out;
}

export interface DuplicateBlock {
  lines: number;
  locations: Array<{ file: string; line: number; endLine: number }>;
  preview: string;
}

const TRIVIAL_LINE = /^[\s{}()[\];,]*$/;

/** Blocks of at least `minLines` meaningful lines that appear more than once, after whitespace normalization. */
export function findDuplicateBlocks(
  sources: Array<{ file: string; text: string }>,
  { minLines = 6, touches }: { minLines?: number; touches?: (file: string, start: number, end: number) => boolean } = {},
): DuplicateBlock[] {
  type Line = { n: number; key: string; raw: string };
  const files = sources.map(({ file, text }) => ({
    file,
    lines: text.split('\n').map((raw, i) => ({ n: i + 1, key: raw.trim().replace(/\s+/g, ' '), raw })).filter((l) => !TRIVIAL_LINE.test(l.key) && !/^(?:import|export\s+\{|from\s+\S+\s+import|using\s|use\s|#include|\/\/|\*|\/\*|#)/.test(l.key)) as Line[],
  }));

  const windows = new Map<string, Array<{ f: number; i: number }>>();
  files.forEach(({ lines }, f) => {
    for (let i = 0; i + minLines <= lines.length; i++) {
      const key = lines.slice(i, i + minLines).map((l) => l.key).join('\n');
      const list = windows.get(key);
      if (list) list.push({ f, i });
      else windows.set(key, [{ f, i }]);
    }
  });

  // Extend runs of consecutive duplicate windows into one block instead of one report per window.
  const groupAt = new Map<string, Array<{ f: number; i: number }>>();
  for (const list of windows.values()) {
    if (list.length < 2) continue;
    for (const loc of list) groupAt.set(`${loc.f}:${loc.i}`, list);
  }
  const blocks: Array<{ starts: Array<{ f: number; i: number }>; length: number }> = [];
  const consumed = new Set<string>();
  // Positional order, so every run is entered at its first window.
  const ordered = [...groupAt.keys()].map((k) => k.split(':').map(Number)).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  for (const [f0, i0] of ordered) {
    const key = `${f0}:${i0}`;
    if (consumed.has(key)) continue;
    const list = groupAt.get(key)!;
    let length = minLines;
    let cur = list;
    for (const loc of cur) consumed.add(`${loc.f}:${loc.i}`);
    for (;;) {
      const next = cur.map((l) => groupAt.get(`${l.f}:${l.i + 1}`));
      if (!next.every((n) => n && n.length === cur.length)) break;
      cur = cur.map((l) => ({ f: l.f, i: l.i + 1 }));
      for (const loc of cur) consumed.add(`${loc.f}:${loc.i}`);
      length += 1;
    }
    blocks.push({ starts: list, length });
  }

  const seen = new Set<string>();
  const out: DuplicateBlock[] = [];
  for (const block of blocks) {
    const locations = block.starts.map(({ f, i }) => {
      const lines = files[f].lines;
      return { file: files[f].file, line: lines[i].n, endLine: lines[i + block.length - 1].n };
    });
    const id = locations.map((l) => `${l.file}:${l.line}`).sort().join('|');
    if (seen.has(id)) continue;
    seen.add(id);
    if (touches && !locations.some((l) => touches(l.file, l.line, l.endLine))) continue;
    const first = block.starts[0];
    const preview = files[first.f].lines.slice(first.i, first.i + Math.min(block.length, 3)).map((l) => l.raw.trim()).join(' ⏎ ');
    out.push({ lines: block.length, locations, preview: preview.slice(0, 160) });
  }
  return out.sort((a, b) => b.lines - a.lines);
}
