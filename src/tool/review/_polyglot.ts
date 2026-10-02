/** code_review's analysis for languages other than JS/TS, on the tree-sitter grammars ocode already ships (see filesystem/_syntax.ts). */

import path from 'node:path';
import type { Node } from '@vscode/tree-sitter-wasm';

import { withSyntaxTree } from '../filesystem/_syntax';
import { COMPLEXITY_THRESHOLD, markerFindings, type FileAnalysis, type Finding, type FunctionMetric } from './_analysis';

interface Rules {
  /** Node types that are a function or method. */
  functions: string[];
  /** Node types that each add one path through a function. */
  decisions: string[];
  /** catch/except nodes, and the node types their body can be. */
  catches?: { types: string[]; bodies: string[] };
  /** Statements after which nothing in the same block runs. */
  exits?: string[];
  /** Node types whose children are a run of statements. */
  blocks?: string[];
  /** How an import binds a name, for the unused-import check; left out where imports work without naming (Rust traits, C# namespaces). */
  imports?: (node: Node) => Array<{ name: string; line: number; source: string }> | null;
}

// Short-circuit operators, as their anonymous token types, across grammars.
const LOGICAL = new Set(['&&', '||', 'and', 'or', '-and', '-or', '??']);
// Statements that do nothing, so a catch holding only these still swallows the error.
const NO_OP = new Set(['pass_statement', 'empty_statement', 'comment']);

const line = (n: Node) => n.startPosition.row + 1;

const pythonImports = (node: Node) => {
  if (node.type === 'import_statement') {
    return node.namedChildren.filter((c): c is Node => Boolean(c)).map((c) => {
      const alias = c.type === 'aliased_import' ? c.childForFieldName('alias')?.text : undefined;
      const dotted = c.type === 'aliased_import' ? c.childForFieldName('name')?.text ?? '' : c.text;
      return { name: alias ?? dotted.split('.')[0], line: line(node), source: dotted };
    });
  }
  if (node.type === 'import_from_statement') {
    const source = node.childForFieldName('module_name')?.text ?? '';
    return node.childrenForFieldName('name').filter((c): c is Node => Boolean(c)).map((c) => {
      const alias = c.type === 'aliased_import' ? c.childForFieldName('alias')?.text : undefined;
      const name = c.type === 'aliased_import' ? c.childForFieldName('name')?.text ?? '' : c.text;
      return { name: alias ?? name, line: line(node), source };
    });
  }
  return null;
};

const goImports = (node: Node) => {
  if (node.type !== 'import_spec') return null;
  const source = (node.childForFieldName('path')?.text ?? '').replace(/^"|"$/g, '');
  const alias = node.childForFieldName('name')?.text;
  if (alias === '_' || alias === '.') return [];
  return [{ name: alias ?? source.split('/').pop() ?? source, line: line(node), source }];
};

const javaImports = (node: Node) => {
  if (node.type !== 'import_declaration') return null;
  if (node.namedChildren.some((c) => c?.type === 'asterisk') || /^import\s+static\b/.test(node.text)) return [];
  const source = node.namedChildren.find((c) => c?.type === 'scoped_identifier' || c?.type === 'identifier')?.text ?? '';
  return [{ name: source.split('.').pop() ?? source, line: line(node), source }];
};

const RULES: Record<string, Rules> = {
  python: {
    functions: ['function_definition'],
    decisions: ['if_statement', 'elif_clause', 'for_statement', 'while_statement', 'except_clause', 'conditional_expression', 'case_clause'],
    catches: { types: ['except_clause'], bodies: ['block'] },
    exits: ['return_statement', 'raise_statement', 'break_statement', 'continue_statement'],
    blocks: ['block', 'module'],
    imports: pythonImports,
  },
  'c-sharp': {
    functions: ['method_declaration', 'constructor_declaration', 'local_function_statement'],
    decisions: ['if_statement', 'for_statement', 'foreach_statement', 'while_statement', 'do_statement', 'switch_section', 'catch_clause', 'conditional_expression', 'switch_expression_arm'],
    catches: { types: ['catch_clause'], bodies: ['block'] },
    exits: ['return_statement', 'throw_statement', 'break_statement', 'continue_statement'],
    blocks: ['block'],
  },
  go: {
    functions: ['function_declaration', 'method_declaration', 'func_literal'],
    decisions: ['if_statement', 'for_statement', 'expression_case', 'type_case', 'communication_case'],
    exits: ['return_statement', 'break_statement', 'continue_statement'],
    blocks: ['statement_list'],
    imports: goImports,
  },
  java: {
    functions: ['method_declaration', 'constructor_declaration'],
    decisions: ['if_statement', 'for_statement', 'enhanced_for_statement', 'while_statement', 'do_statement', 'switch_label', 'catch_clause', 'ternary_expression'],
    catches: { types: ['catch_clause'], bodies: ['block'] },
    exits: ['return_statement', 'throw_statement', 'break_statement', 'continue_statement'],
    blocks: ['block'],
    imports: javaImports,
  },
  rust: {
    functions: ['function_item'],
    decisions: ['if_expression', 'while_expression', 'for_expression', 'match_arm'],
    exits: ['return_expression', 'break_expression', 'continue_expression'],
    blocks: ['block'],
  },
  ruby: {
    functions: ['method', 'singleton_method'],
    decisions: ['if', 'elsif', 'unless', 'while', 'until', 'for', 'when', 'rescue', 'conditional', 'if_modifier', 'unless_modifier'],
    catches: { types: ['rescue'], bodies: ['then'] },
    exits: ['return', 'break', 'next'],
    blocks: ['body_statement', 'then'],
  },
  php: {
    functions: ['function_definition', 'method_declaration'],
    decisions: ['if_statement', 'else_if_clause', 'for_statement', 'foreach_statement', 'while_statement', 'do_statement', 'case_statement', 'catch_clause', 'conditional_expression'],
    catches: { types: ['catch_clause'], bodies: ['compound_statement'] },
    exits: ['return_statement', 'break_statement', 'continue_statement'],
    blocks: ['compound_statement'],
  },
  cpp: {
    functions: ['function_definition'],
    decisions: ['if_statement', 'for_statement', 'for_range_loop', 'while_statement', 'do_statement', 'case_statement', 'catch_clause', 'conditional_expression'],
    catches: { types: ['catch_clause'], bodies: ['compound_statement'] },
    exits: ['return_statement', 'throw_statement', 'break_statement', 'continue_statement'],
    blocks: ['compound_statement'],
  },
  bash: {
    functions: ['function_definition'],
    decisions: ['if_statement', 'elif_clause', 'for_statement', 'c_style_for_statement', 'while_statement', 'case_item'],
  },
  powershell: {
    functions: ['function_statement'],
    decisions: ['if_statement', 'elseif_clause', 'for_statement', 'foreach_statement', 'while_statement', 'do_statement', 'catch_clause', 'switch_clause'],
    catches: { types: ['catch_clause'], bodies: ['statement_block'] },
    blocks: ['statement_list'],
  },
};

// The extensions _syntax.ts maps to a grammar that has rules above; JS/TS stay with the TypeScript analysis.
const EXT_GRAMMAR: Record<string, string> = {
  '.py': 'python', '.cs': 'c-sharp', '.go': 'go', '.java': 'java', '.rs': 'rust', '.rb': 'ruby', '.php': 'php',
  '.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp', '.hpp': 'cpp', '.sh': 'bash', '.bash': 'bash', '.ps1': 'powershell', '.psm1': 'powershell',
};

export function hasPolyglotRules(file: string): boolean {
  return Boolean(EXT_GRAMMAR[path.extname(file).toLowerCase()]);
}

function children(node: Node): Node[] {
  return node.namedChildren.filter((c): c is Node => Boolean(c));
}

function functionName(node: Node): string {
  const named = node.childForFieldName('name');
  if (named) return named.text;
  let declarator = node.childForFieldName('declarator');
  while (declarator) {
    if (/identifier|name$/.test(declarator.type)) return declarator.text;
    declarator = declarator.childForFieldName('declarator') ?? children(declarator).find((c) => /identifier/.test(c.type)) ?? null;
  }
  return children(node).find((c) => c.type === 'function_name' || c.type === 'identifier' || c.type === 'word')?.text ?? '<anonymous>';
}

/** One file's findings, in the same shape as the JS/TS analysis; null when no grammar or rules cover it. */
export async function analyzePolyglot(file: string, text: string): Promise<FileAnalysis | null> {
  const grammar = EXT_GRAMMAR[path.extname(file).toLowerCase()];
  const rules = grammar ? RULES[grammar] : undefined;
  if (!rules) return null;
  const fns = new Set(rules.functions);
  const decisions = new Set(rules.decisions);
  const exits = new Set(rules.exits ?? []);
  const blocks = new Set(rules.blocks ?? []);
  const catchTypes = new Set(rules.catches?.types ?? []);

  return withSyntaxTree(file, text, (root) => {
    const findings: Finding[] = [];
    const functions: FunctionMetric[] = [];
    const imported: Array<{ name: string; line: number; source: string }> = [];
    const counts = new Map<string, number>();
    const add = (at: number, category: string, severity: Finding['severity'], message: string) =>
      findings.push({ file, line: at, category, severity, message });

    const complexity = (fn: Node) => {
      let score = 1;
      const walk = (n: Node) => {
        for (let i = 0; i < n.childCount; i++) {
          const c = n.child(i);
          if (!c || fns.has(c.type)) continue;
          if (decisions.has(c.type) || (!c.isNamed && LOGICAL.has(c.type))) score += 1;
          walk(c);
        }
      };
      walk(fn);
      return score;
    };

    const isExit = (n: Node) => exits.has(n.type) || (n.type === 'expression_statement' && exits.has(children(n)[0]?.type ?? ''));

    const visit = (node: Node, inImport: boolean) => {
      const binds = !inImport ? rules.imports?.(node) : null;
      if (binds) imported.push(...binds);
      const importing = inImport || binds != null;

      if (!importing && node.childCount === 0 && node.isNamed && /identifier|^name$|^constant$|^word$/.test(node.type)) {
        counts.set(node.text, (counts.get(node.text) ?? 0) + 1);
      }

      if (fns.has(node.type)) {
        const start = line(node);
        const end = node.endPosition.row + 1;
        functions.push({ file, name: functionName(node), line: start, endLine: end, complexity: complexity(node), lines: end - start + 1 });
      }

      if (catchTypes.has(node.type)) {
        const body = children(node).find((c) => rules.catches!.bodies.includes(c.type));
        const statements = body ? children(body).filter((c) => !NO_OP.has(c.type)) : [];
        const commented = body ? children(body).some((c) => c.type === 'comment') : false;
        if (statements.length === 0 && !commented) add(line(node), 'error-handling', 'warning', 'empty catch/except block silently swallows the error');
      }

      if (blocks.has(node.type)) {
        const stmts = children(node).filter((c) => c.type !== 'comment');
        const at = stmts.findIndex(isExit);
        if (at >= 0 && at < stmts.length - 1 && !fns.has(stmts[at + 1].type)) {
          add(line(stmts[at + 1]), 'dead-code', 'warning', 'unreachable code after return/throw/break/continue');
        }
      }

      if (grammar === 'python' && node.type === 'call') {
        const callee = node.childForFieldName('function')?.text;
        if (callee === 'eval' || callee === 'exec') add(line(node), 'security', 'warning', `${callee}() executes arbitrary code`);
        const shellTrue = children(node.childForFieldName('arguments') ?? node).some(
          (a) => a.type === 'keyword_argument' && a.childForFieldName('name')?.text === 'shell' && a.childForFieldName('value')?.text === 'True',
        );
        if (shellTrue) add(line(node), 'security', 'warning', 'shell=True runs the command through a shell; pass an argv list instead');
      }

      for (const c of children(node)) visit(c, importing);
    };
    visit(root, false);

    for (const fn of functions) {
      if (fn.complexity > COMPLEXITY_THRESHOLD) {
        add(fn.line, 'complexity', 'info', `${fn.name} has cyclomatic complexity ${fn.complexity} (threshold ${COMPLEXITY_THRESHOLD}); consider splitting it`);
      }
    }
    const unusedImports = imported.filter((imp) => imp.name && !counts.has(imp.name));
    for (const imp of unusedImports) add(imp.line, 'unused', 'warning', `import ${imp.name}${imp.source && imp.source !== imp.name ? ` (${imp.source})` : ''} is never used`);
    findings.push(...markerFindings(file, text));
    findings.sort((a, b) => a.line - b.line);

    return { file, imports: [], exports: [], functions, identifierCounts: counts, unusedImports, findings };
  });
}
