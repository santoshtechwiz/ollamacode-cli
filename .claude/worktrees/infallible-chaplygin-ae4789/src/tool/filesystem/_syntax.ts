import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import treeSitter from '@vscode/tree-sitter-wasm';
import type { Language, Node, Tree } from '@vscode/tree-sitter-wasm';

import { parseAllDocuments } from 'yaml';

import { logger } from '../../core/logger';

// to the grammar shipped under node_modules/@vscode/tree-sitter-wasm/wasm (or vendored in ./grammars).
// to the grammar shipped under node_modules/@vscode/tree-sitter-wasm/wasm.
// Adding a language is one row here, provided its wasm exists. Files with no
// row skip the check — a missing grammar never blocks an edit.
const GRAMMAR_BY_EXT: Record<string, string> = {
  '.cs': 'c-sharp', '.py': 'python',
  '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'javascript',
  '.ts': 'typescript', '.mts': 'typescript', '.cts': 'typescript', '.tsx': 'tsx',
  '.go': 'go', '.java': 'java', '.rs': 'rust',
  '.rb': 'ruby', '.php': 'php',
  '.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp', '.hpp': 'cpp',
  '.css': 'css', '.sh': 'bash', '.bash': 'bash',
  '.ps1': 'powershell', '.psm1': 'powershell',
  '.tf': 'hcl', '.tfvars': 'hcl', '.hcl': 'hcl',
  sh: 'bash', bash: 'bash', python: 'python', python3: 'python', node: 'javascript',
};

const wasmDir = path.dirname(createRequire(import.meta.url).resolve('@vscode/tree-sitter-wasm'));
// Grammars tree-sitter-wasm does not ship, kept next to this file: HCL (Terraform) from tree-sitter-grammars/tree-sitter-hcl 1.2.0.
const vendoredDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'grammars');
const VENDORED = new Set(['hcl']);

// The WASM runtime boots once; each grammar then gets its own Parser so two
// concurrent checks in different languages cannot race on setLanguage.
let runtimeReady: Promise<void> | null = null;
const parsers = new Map<string, Promise<InstanceType<typeof treeSitter.Parser>>>();

function grammarFor(rel: string, text: string): string | undefined {
  const byExt = GRAMMAR_BY_EXT[path.extname(rel).toLowerCase()];
  if (byExt) return byExt;
  const shebang = /^#!\S*?([\w.]+)(?:\s+([\w.]+))?/.exec(text);
  if (!shebang) return undefined;
  const interp = shebang[1] === 'env' ? (shebang[2] ?? '') : shebang[1];
  return GRAMMAR_BY_EXT[interp];
}

async function parserFor(grammar: string): Promise<InstanceType<typeof treeSitter.Parser>> {
  const cached = parsers.get(grammar);
  if (cached) return cached;
  const loading = (async () => {
    runtimeReady ??= treeSitter.Parser.init({
      locateFile: (file: string) => path.join(wasmDir, file),
    });
    await runtimeReady;
    const language: Language = await treeSitter.Language.load(
      path.join(VENDORED.has(grammar) ? vendoredDir : wasmDir, `tree-sitter-${grammar}.wasm`),
    );
    const parser = new treeSitter.Parser();
    parser.setLanguage(language);
    return parser;
  })();
  parsers.set(grammar, loading);
  try {
    return await loading;
  } catch (err) {
    parsers.delete(grammar);
    throw err;
  }
}

/** Parse `text` with the grammar its file name picks and hand the root node to `use`; null when there is no grammar or it fails to load. The tree is freed afterwards, so `use` must not keep nodes. */
export async function withSyntaxTree<T>(rel: string, text: string, use: (root: Node, grammar: string) => T): Promise<T | null> {
  const grammar = grammarFor(rel, text);
  if (!grammar) return null;
  let tree: Tree | null = null;
  try {
    tree = (await parserFor(grammar)).parse(text);
    return tree ? use(tree.rootNode, grammar) : null;
  } catch (err) {
    logger.debug(`parse skipped for ${rel}:`, err);
    return null;
  } finally {
    tree?.delete();
  }
}

// Start rows of every syntax error, walking only into subtrees that contain one.
function errorRows(tree: Tree): number[] {
  const rows: number[] = [];
  const cursor = tree.walk();
  try {
    for (;;) {
      const node = cursor.currentNode;
      if (node.isError || node.isMissing) rows.push(node.startPosition.row);
      if (node.hasError && cursor.gotoFirstChild()) continue;
      while (!cursor.gotoNextSibling()) if (!cursor.gotoParent()) return rows;
    }
  } finally {
    cursor.delete();
  }
}

function parseErrors(
  parser: InstanceType<typeof treeSitter.Parser>,
  text: string,
): number[] {
  if (!text) return [];
  const tree = parser.parse(text);
  if (!tree) return [];
  try {
    return errorRows(tree);
  } finally {
    tree.delete();
  }
}

// No XML or YAML grammar ships with tree-sitter-wasm. XML-family files (project files, configs) get a well-formedness
// check of their own: tags open and close in order, and every markup construct ends. YAML uses the yaml package below.
const XML_EXTS = new Set([
  '.xml', '.csproj', '.vbproj', '.fsproj', '.proj', '.props', '.targets', '.config', '.xaml', '.resx', '.nuspec', '.svg',
]);

/** Start row of the first well-formedness error in `text`, as a one-item list (or none), to compare like parseErrors. */
export function xmlErrors(text: string): number[] {
  const rowAt = (index: number) => text.slice(0, index).split('\n').length - 1;
  const open: { name: string; at: number }[] = [];
  const ends: [string, string][] = [['<!--', '-->'], ['<![CDATA[', ']]>'], ['<?', '?>'], ['<!', '>']];
  let i = text.indexOf('<');
  while (i !== -1) {
    const special = ends.find(([start]) => text.startsWith(start, i));
    if (special) {
      const end = text.indexOf(special[1], i + special[0].length);
      if (end === -1) return [rowAt(i)];
      i = text.indexOf('<', end + special[1].length);
      continue;
    }
    // A tag ends at the first '>' outside a quoted attribute value.
    let j = i + 1;
    let quote = '';
    for (; j < text.length; j++) {
      const c = text[j];
      if (quote) { if (c === quote) quote = ''; }
      else if (c === '"' || c === "'") quote = c;
      else if (c === '>' || c === '<') break;
    }
    if (text[j] !== '>') return [rowAt(i)];
    const tag = text.slice(i + 1, j);
    const name = /^\/?\s*([^\s/>]+)/.exec(tag)?.[1];
    if (!name) return [rowAt(i)];
    if (tag.startsWith('/')) {
      const top = open.pop();
      if (!top || top.name !== name) return [rowAt(i)];
    } else if (!tag.trimEnd().endsWith('/')) {
      open.push({ name, at: i });
    }
    i = text.indexOf('<', j + 1);
  }
  return open.length > 0 ? [rowAt(open[open.length - 1].at)] : [];
}

/** Start rows of every YAML error, from the yaml package the project already depends on. Multi-document files are fine. */
export function yamlErrors(text: string): number[] {
  const rows = parseAllDocuments(text).flatMap((doc) => doc.errors.map((e) => (e.linePos?.[0]?.line ?? 1) - 1));
  return [...new Set(rows)].sort((a, b) => a - b);
}

/** Formats with no tree-sitter grammar here, checked by a parser of their own. */
function textCheckFor(rel: string): ((text: string) => number[]) | undefined {
  const ext = path.extname(rel).toLowerCase();
  if (XML_EXTS.has(ext)) return xmlErrors;
  if (ext === '.yml' || ext === '.yaml') return yamlErrors;
  return undefined;
}

/** Lines of the would-be file shown before and after the first new error: enough to see what was left behind. */
const CONTEXT_BEFORE = 8;
const CONTEXT_AFTER = 2;

/**
 * Why `after` breaks the code `before` parsed as, or null: only errors the change adds count, so an already-broken file
 * never blocks a fix. `context` is the would-be file around that line, numbered, the error line marked: a line number
 * alone left the model unable to see that its edit kept part of the old code.
 */
export async function syntaxBreak(rel: string, before: string, after: string): Promise<{ why: string; context: string } | null> {
  if (after === before) return null;
  const textCheck = textCheckFor(rel);
  const grammar = textCheck ? undefined : grammarFor(rel, after);
  if (!textCheck && !grammar) return null;
  try {
    const parser = grammar ? await parserFor(grammar) : null;
    const errors = parser ? (text: string) => parseErrors(parser, text) : textCheck!;
    const was = errors(before);
    const now = errors(after);
    if (now.length <= was.length) return null;
    const row = now.find((r) => !was.includes(r)) ?? now[0];
    const lines = after.split(/\r?\n/);
    const line = lines[row]?.trim().slice(0, 80) ?? '';
    const from = Math.max(0, row - CONTEXT_BEFORE);
    const context = lines.slice(from, row + CONTEXT_AFTER + 1)
      .map((text, i) => `${from + i === row ? '>' : ' '}${String(from + i + 1).padStart(5)}\t${text}`)
      .join('\n');
    return { why: `this would leave ${rel} with a syntax error at line ${row + 1}${line ? ` ("${line}")` : ''}`, context };
  } catch (err) {
    logger.debug(`syntax check skipped for ${rel}:`, err);
    return null;
  }
}

// Node types that introduce a named code unit, across the shipped grammars.
// Deliberately coarse — this feeds a "closest definitions" hint on a missed
// search, never an edit address. `method_invocation` and friends are excluded
// by requiring declaration/definition/item shape, so call sites don't qualify.
function isDefinitionType(type: string): boolean {
  if (type.includes('declaration') || type.includes('definition')) return true;
  if (type.endsWith('_item')) return true;
  return type === 'method' || type === 'class' || type === 'module';
}

/**
 * Definition headlines near a line, for a miss hint ("closest definitions
 * near line 40: ..."). Parse-based, so strings and comments can't match and
 * every grammar shares one path — the retired signature regex only spoke
 * C#/Java. Never throws; empty when there is no grammar or nothing is near.
 */
export async function nearbyDefinitions(
  rel: string,
  content: string,
  centerLine: number | null,
  max = 3,
): Promise<string[]> {
  if (centerLine === null || !content) return [];
  const grammar = grammarFor(rel, content);
  if (!grammar) return [];
  try {
    const parser = await parserFor(grammar);
    const tree = parser.parse(content);
    if (!tree) return [];
    try {
      const found: Array<{ line: number; text: string }> = [];
      const cursor = tree.walk();
      try {
        const visit = (depth: number): void => {
          const node = cursor.currentNode;
          // Depth 0 is the file root (`module`, `program`, …) spanning the
          // whole file — its "headline" is just line 1, never a definition.
          if (depth > 0 && node.isNamed && !node.isError && !node.isMissing && isDefinitionType(node.type)) {
            const head = node.text.split(/\r?\n/, 1)[0]?.trim() ?? '';
            // A body list (`declaration_list`) headlines as a bare brace.
            if (head && !/^[{}[\]]+$/.test(head)) {
              const clipped = head.length > 88 ? `${head.slice(0, 87)}…` : head;
              if (!found.some((f) => f.text === clipped)) {
                found.push({ line: node.startPosition.row + 1, text: clipped });
              }
            }
          }
          if (cursor.gotoFirstChild()) {
            do {
              visit(depth + 1);
            } while (cursor.gotoNextSibling());
            cursor.gotoParent();
          }
        };
        visit(0);
      } finally {
        cursor.delete();
      }
      return found
        .filter((f) => Math.abs(f.line - centerLine) <= 7)
        .sort((a, b) => Math.abs(a.line - centerLine) - Math.abs(b.line - centerLine))
        .slice(0, max)
        .map((f) => f.text);
    } finally {
      tree.delete();
    }
  } catch (err) {
    logger.debug(`definition hint skipped for ${rel}:`, err);
    return [];
  }
}

/** One definition a `symbol` locator resolved to: byte range plus its line. */
export interface SymbolRange {
  start: number;
  end: number;
  line: number;
}
// The declared name of a definition node: the `name` field first, then the
// first identifier-ish child for grammars that don't label it. Field-based,
// never text-scanned, so strings and comments can't match.
function definitionName(node: Node): string | null {
  const field = node.childForFieldName('name');
  if (field && field.text) return field.text;
  for (const child of node.namedChildren) {
    if (child && (child.type.includes('identifier') || child.type.includes('name'))) {
      return child.text || null;
    }
  }
  return null;
}

function stripQuotes(text: string): string | null {
  const t = String(text ?? '').trim();
  if (t.length >= 2) {
    const q = t[0];
    if ((q === '"' || q === "'" || q === '`') && t.endsWith(q)) return t.slice(1, -1) || null;
  }
  return t || null;
}

// Test names live in calls, not definitions: `it('creates a user', …)`.
// The first string argument names the block the line sits in.
function callName(node: Node): string | null {
  if (!node.type.includes('call') && !node.type.includes('invocation')) return null;
  for (const child of node.namedChildren) {
    if (!child) continue;
    if (child.type.includes('string')) return stripQuotes(child.text);
    if (child.type.includes('argument')) {
      for (const grand of child.namedChildren) {
        if (grand && grand.type.includes('string')) return stripQuotes(grand.text);
      }
      break;
    }
  }
  return null;
}

/**
 * Every definition named by `symbol` ("GetById" or "ProductService.GetById"):
 * the node whose name is the last segment and whose definition ancestors are
 * the leading segments in order. Empty when there is no grammar, no match,
 * or the name is blank — the caller reports not-found vs ambiguous.
 */
export async function findSymbolRanges(
  rel: string,
  content: string,
  symbol: string,
): Promise<SymbolRange[]> {
  const segs = String(symbol ?? '').split('.').map((s) => s.trim()).filter(Boolean);
  if (segs.length === 0 || !content) return [];
  const grammar = grammarFor(rel, content);
  if (!grammar) return [];
  try {
    const parser = await parserFor(grammar);
    const tree = parser.parse(content);
    if (!tree) return [];
    try {
      const out: SymbolRange[] = [];
      const wantAncestors = segs.slice(0, -1).reverse();
      const cursor = tree.walk();
      try {
        const visit = (depth: number): void => {
          const node = cursor.currentNode;
          if (
            depth > 0 && node.isNamed && !node.isError && !node.isMissing &&
            isDefinitionType(node.type) && definitionName(node) === segs[segs.length - 1]
          ) {
            const ancestors: string[] = [];
            let parent = node.parent;
            while (parent && ancestors.length < wantAncestors.length) {
              if (parent.isNamed && isDefinitionType(parent.type)) {
                const name = definitionName(parent);
                if (name) ancestors.push(name);
              }
              parent = parent.parent;
            }
            if (wantAncestors.every((s, i) => ancestors[i] === s)) {
              // Widen to whole lines when only whitespace sits between the
              // node and the line edges. Node ranges skip indentation (it is
              // an "extra"), and replacing without it lands the new first
              // line after the old indent, duplicating the body.
              let start = node.startIndex;
              let end = node.endIndex;
              const lineStart = content.lastIndexOf('\n', start - 1) + 1;
              if (/^[ \t]*$/.test(content.slice(lineStart, start))) start = lineStart;
              const nl = content.indexOf('\n', end);
              const lineEnd = nl === -1 ? content.length : nl;
              if (/^[ \t]*$/.test(content.slice(end, lineEnd))) end = lineEnd;
              out.push({ start, end, line: node.startPosition.row + 1 });
            }
          }
          if (cursor.gotoFirstChild()) {
            do {
              visit(depth + 1);
            } while (cursor.gotoNextSibling());
            cursor.gotoParent();
          }
        };
        visit(0);
      } finally {
        cursor.delete();
      }
      return out;
    } finally {
      tree.delete();
    }
  } catch (err) {
    logger.debug(`symbol lookup skipped for ${rel}:`, err);
    return [];
  }
}

/**
 * Name of the innermost block containing `line`: a definition ("getById",
 * "ProductService") or a test-like call (`it('creates a user', …)` gives
 * "creates a user"). Null when nothing names it. Powers the enclosing-symbol
 * half of verified diagnostics: the model learns *which* test or function a
 * location sits in, not just a bare file:line.
 */
export async function symbolAtLine(rel: string, content: string, line: number): Promise<string | null> {
  if (!Number.isInteger(line) || line < 1 || !content) return null;
  const grammar = grammarFor(rel, content);
  if (!grammar) return null;
  try {
    const parser = await parserFor(grammar);
    const tree = parser.parse(content);
    if (!tree) return null;
    try {
      let bestName: string | null = null;
      let bestDepth = -1;
      const cursor = tree.walk();
      try {
        const visit = (depth: number): void => {
          const node = cursor.currentNode;
          if (depth > 0 && node.isNamed && !node.isError && !node.isMissing) {
            const startLine = node.startPosition.row + 1;
            const endLine = node.endPosition.row + 1;
            if (line >= startLine && line <= endLine) {
              // Definitions by declared name, calls by first string argument.
              const name = isDefinitionType(node.type)
                ? (definitionName(node) ?? callName(node))
                : callName(node);
              if (name && depth > bestDepth) {
                bestName = name;
                bestDepth = depth;
              }
            }
          }
          if (cursor.gotoFirstChild()) {
            do {
              visit(depth + 1);
            } while (cursor.gotoNextSibling());
            cursor.gotoParent();
          }
        };
        visit(0);
      } finally {
        cursor.delete();
      }
      return bestName;
    } finally {
      tree.delete();
    }
  } catch (err) {
    logger.debug(`enclosing symbol skipped for ${rel}:`, err);
    return null;
  }
}
