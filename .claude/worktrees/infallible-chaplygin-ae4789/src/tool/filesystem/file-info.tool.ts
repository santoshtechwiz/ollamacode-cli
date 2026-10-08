import { TOOL_ERROR_CODE } from '../../protocol';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { defineTool } from '../core/defineTool';
import { ok, fail, fromError } from '../core/tool-result';
import { isBinaryFile } from './_fs';
import { scanSource } from '../../context/workspace-index/search';

const MAX_SCAN_BYTES = 256 * 1024;

const LANGUAGE_LABELS: Record<string, string> = {
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript',
  '.mts': 'TypeScript',
  '.cts': 'TypeScript',
  '.js': 'JavaScript',
  '.jsx': 'JavaScript',
  '.mjs': 'JavaScript',
  '.cjs': 'JavaScript',
  '.py': 'Python',
  '.cs': 'C#',
  '.go': 'Go',
  '.rs': 'Rust',
};

const TS_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);

function languageFor(rel: string): string | null {
  return LANGUAGE_LABELS[path.extname(rel).toLowerCase()] ?? null;
}

function identName(name: any): string | undefined {
  if (!name) return undefined;
  return typeof name === 'string' ? name : name.text;
}

/** Structural JS/TS scan via the TypeScript compiler, loaded lazily only when this tool runs on such a file. */
async function scanTs(content: string, fileName: string): Promise<{ symbols: { kind: string; name: string; }[]; imports: string[]; exports: string[]; }> {
  const ts = await import('typescript');
  let scriptKind = ts.ScriptKind.TS;
  if (fileName.endsWith('.tsx')) scriptKind = ts.ScriptKind.TSX;
  else if (fileName.endsWith('.jsx')) scriptKind = ts.ScriptKind.JSX;
  else if (/\.m?[jt]s$/.test(fileName)) scriptKind = ts.ScriptKind.TS;
  else if (fileName.endsWith('.js') || fileName.endsWith('.cjs') || fileName.endsWith('.mjs')) scriptKind = ts.ScriptKind.JS;

  const sourceFile = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, false, scriptKind);

  const symbols: { kind: string; name: string; }[] = [];
  const imports: string[] = [];
  const exports: string[] = [];
  const seen = new Set<string>();

  const push = (kind: string, name?: string) => {
    if (!name) return;
    if (seen.has(name)) return;
    seen.add(name);
    symbols.push({ kind, name });
  };
  const pushExport = (name?: string) => {
    if (name && !exports.includes(name)) exports.push(name);
  };
  const isExported = (node: any) => Boolean(ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Export);
  const addImport = (spec?: string) => {
    if (spec && !imports.includes(spec)) imports.push(spec);
  };

  const visit = (node: any) => {
    if (ts.isImportDeclaration(node)) {
      addImport(ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : undefined);
      return;
    }
    if (ts.isImportEqualsDeclaration(node)) {
      if (node.moduleReference && ts.isExternalModuleReference(node.moduleReference)) {
        const expr = node.moduleReference.expression;
        addImport(ts.isStringLiteral(expr) ? expr.text : undefined);
      }
      push('import', node.name.text);
      return;
    }
    if (ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) addImport(node.moduleSpecifier.text);
      if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const el of node.exportClause.elements) {
          const name = identName(el.propertyName ?? el.name);
          push('export', name);
          pushExport(name);
        }
      }
      return;
    }
    if (ts.isExportAssignment(node)) {
      pushExport(ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Default ? 'default' : 'export =');
      return;
    }
    if (ts.isFunctionDeclaration(node)) {
      push('function', node.name ? node.name.text : undefined);
      if (isExported(node)) pushExport(node.name ? node.name.text : 'default');
      return;
    }
    if (ts.isClassDeclaration(node)) {
      push('class', node.name ? node.name.text : undefined);
      if (isExported(node)) pushExport(node.name ? node.name.text : 'default');
      for (const member of node.members ?? []) {
        if (ts.isMethodDeclaration(member)) {
          push('method', identName(member.name));
        } else if (ts.isConstructorDeclaration(member)) {
          push('method', 'constructor');
        } else if (ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) {
          const n = identName(member.name);
          push('method', n ? `get/set ${n}` : undefined);
        } else if (ts.isPropertyDeclaration(member)) {
          const init = member.initializer;
          if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) push('method', identName(member.name));
          else push('property', identName(member.name));
        }
      }
      return;
    }
    if (ts.isInterfaceDeclaration(node)) {
      push('interface', node.name.text);
      if (isExported(node)) pushExport(node.name.text);
      return;
    }
    if (ts.isTypeAliasDeclaration(node)) {
      push('type', node.name.text);
      if (isExported(node)) pushExport(node.name.text);
      return;
    }
    if (ts.isEnumDeclaration(node)) {
      push('enum', node.name.text);
      if (isExported(node)) pushExport(node.name.text);
      return;
    }
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        const name = identName(decl.name);
        if (!name) continue;
        const init = decl.initializer;
        const kind =
          init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init) || ts.isCallExpression(init))
            ? 'function'
            : 'const';
        push(kind, name);
        if (isExported(node)) pushExport(name);
      }
      return;
    }
    // Module/namespace blocks carry top-level declarations; function bodies do not.
    if (ts.isModuleBlock(node)) ts.forEachChild(node, visit);
  };

  ts.forEachChild(sourceFile, visit);
  return { symbols, imports, exports };
}

export default defineTool({
  name: 'file_info',
  profiles: ['core', 'planning'],
  category: 'filesystem',
  activity: 'Inspecting a file',
  label: 'File Info',
  brief: 'Inspect a source file: language, size, imports/exports, functions/classes/types.',
  description: `Inspect a source file and return concise code-focused metadata.

Return:
- File path
- Programming language
- Line count
- File size
- Imports and exports
- Functions, classes, methods, interfaces, and types when available
- Last modified time

Use this to understand a file's structure before reading or editing it.

Do not modify the file.
Do not infer behavior that cannot be determined from the file.
Keep the output concise and relevant to code analysis.`,
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', pathArg: true, description: 'Workspace-relative file path' },
    },
    required: ['path'],
  },

  async execute(args, ctx) {
    try {
      const abs = String(args.path);
      const rel = ctx.ws.rel(abs);

      const st = await fsp.stat(abs);
      if (st.isDirectory()) {
        return fail(`${rel} is a directory`, {
          code: TOOL_ERROR_CODE.EISDIR,
          hint: 'Use list_directory to inspect a directory.',
        });
      }

      const language = languageFor(rel);
      let symbols: { kind: string; name: string; }[] = [];
      let imports: string[] = [];
      let exports: string[] = [];
      let lines: number | null = null;
      let binary = false;

      if (st.size <= MAX_SCAN_BYTES) {
        binary = await isBinaryFile(abs);
        if (!binary) {
          try {
            const content = await fsp.readFile(abs, 'utf8');
            lines = content.length ? content.split('\n').length : 0;
            if (language) {
              const scanned = TS_EXTENSIONS.has(path.extname(rel).toLowerCase())
                ? await scanTs(content, rel)
                : scanSource(content, path.extname(rel).toLowerCase());
              symbols = scanned.symbols ?? [];
              imports = scanned.imports ?? [];
              exports = scanned.exports ?? [];
            }
          } catch {}
        }
      }

      const symbolLines = symbols.map((s) => `  ${s.kind} ${s.name}`).join('\n');
      const display = [
        `path: ${rel}`,
        `language: ${language ?? 'unknown'}`,
        `lines: ${lines ?? 'too large to scan'}`,
        `size: ${st.size} bytes`,
        `mtime: ${new Date(st.mtimeMs).toISOString()}`,
        `imports: ${imports.join(', ') || '(none)'}`,
        `exports: ${exports.join(', ') || '(none)'}`,
        symbols.length ? `symbols:\n${symbolLines}` : 'symbols: (none)',
      ].join('\n');

      return ok({
        kind: 'file',
        display,
        data: {
          path: rel,
          language: language ?? null,
          lines,
          size: st.size,
          mtime: new Date(st.mtimeMs).toISOString(),
          binary,
          imports,
          exports,
          symbols,
        },
      });
    } catch (err) {
      return fromError(err);
    }
  },
});