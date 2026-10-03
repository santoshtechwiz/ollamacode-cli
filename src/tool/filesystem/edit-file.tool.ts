import type { ToolContextInput, ToolResult } from '../../types';
import crypto from 'node:crypto';

import { TOOL_ERROR_CODE } from '../../protocol';
import { fileStamp, samePath } from '../../core/paths';

import { defineTool } from '../core/defineTool';
import { ok, fail, fromError } from '../core/tool-result';
import { noteChange } from './_fs';
import { openTextFile, writeAndVerify, safeDiff } from './_text-file';
import { numberedWindow } from './_window';
import {
  planEdit,
  lineAt,
  countLines,
  bestMatchLine,
  fuzzyLines,
  lineSpanLabel,
  offsetOfLines,
  type MatchRange,
} from './_match';
import { applyTextEdits, type TextEditOp } from './_edit-apply';
import { syntaxBreak, nearbyDefinitions, findSymbolRanges } from './_syntax';
import { validateJson, detectJsonIndent, isJsonPath } from './_json';
import { workspaceFor } from '../../agent/workspace/manager';


/** How much of the file a failure may show. */
const HEADLESS_PREVIEW_LINES = 16;

const STRUCTURAL_LINES = new Set(['{', '}', '[', ']']);

// JSON pointer candidate discovery

function jsonPointerCandidates(content: string, search: string, max = 3): string[] {
  let doc: unknown;
  try {
    doc = JSON.parse(String(content ?? ''));
  } catch {
    return [];
  }
  const needle = String(search ?? '').toLowerCase();
  if (!needle) return [];

  const out: string[] = [];
  const esc = (s: unknown) => String(s).replace(/~/g, '~0').replace(/\//g, '~1');

  const stack: Array<{ node: unknown; ptr: string }> = [{ node: doc, ptr: '' }];

  while (stack.length > 0 && out.length < max) {
    const current = stack.pop()!;
    const node = current.node;
    const ptr = current.ptr;

    if (node !== null && typeof node === 'object') {
      const entries = Object.entries(node as Record<string, unknown>);
      for (let i = entries.length - 1; i >= 0; i--) {
        const [k, v] = entries[i];
        const child = `${ptr}/${esc(k)}`;
        if (k.toLowerCase().includes(needle) && out.length < max) out.push(child);
        if (out.length < max) stack.push({ node: v, ptr: child });
      }
    } else if (String(node ?? '').toLowerCase().includes(needle)) {
      out.push(ptr || '/');
    }
  }

  return out;
}

// Edit model

interface EditSpec {
  search?: string;
  /** Name a definition ("getById", "ProductService.GetById") instead of quoting text. Exactly one of search/symbol. */
  symbol?: string;
  replace?: string;
  replace_all?: boolean;
  line_start?: number;
  line_end?: number;
  /** Insert replace before this 1-based line; one past the last line appends. */
  insert_at_line?: number;
}

export interface EditArgs extends EditSpec {
  path?: string;
  edits?: EditSpec[];
}

type OpenedTextFile = Awaited<ReturnType<typeof openTextFile>>;
type OpenedTextFileSuccess = Extract<OpenedTextFile, { ok: true }>;

type EditOutcome =
  | { status: 'ok'; content: string; replacements: number; exact: boolean; note: string }
  | { status: 'fail'; result: ToolResult };

/** A match verdict ready to apply — no bytes have been rewritten yet. */
type PlannedEdit =
  | {
      status: 'ok';
      targets: MatchRange[];
      replacement: string;
      replacements: number;
      exact: boolean;
      note: string;
    }
  | { status: 'fail'; result: ToolResult };

const failOutcome = (result: ToolResult): EditOutcome => ({ status: 'fail', result });

const okOutcome = (
  content: string,
  replacements: number,
  exact: boolean,
  note: string,
): EditOutcome => ({ status: 'ok', content, replacements, exact, note });

// Hash comparison for "did it change?": identical verdict to `===` on strings
// (kept as the fast path), so every no-op check reads the same way.
function contentUnchanged(original: string, updated: string): boolean {
  if (original === updated) return true;
  const hashOriginal = crypto.createHash('sha256').update(original, 'utf8').digest('hex');
  const hashUpdated = crypto.createHash('sha256').update(updated, 'utf8').digest('hex');
  return hashOriginal === hashUpdated;
}

// Failure builders

function hasTruncationMarker(search: string): boolean {
  const s = String(search ?? '');
  // Only treat an ellipsis as truncation when it is clearly a standalone diagnostic marker.
  return /(?:^|[\\s])(?:…|\\.\\.\\.)(?:$|[\\s])/.test(s) ||
    /…\\s*$/.test(s) ||
    /\\.{3}\\s*$/.test(s);
}

function notFoundFailure(
  content: string,
  search: string,
  rel: string,
  ctx: ToolContextInput,
  isJson: boolean,
  why: string,
  definitions: string[] = [],
): ToolResult {
  const totalLines = countLines(content);
  const best = bestMatchLine(content, search);
  const preview =
    best !== null
      ? numberedWindow(content, best, best, { pad: 6 })
      : content
          .split('\n')
          .slice(0, HEADLESS_PREVIEW_LINES)
          .map((line, i) => `${i + 1}: ${line}`)
          .join('\n');
  const previewTail =
    best !== null
      ? ''
      : totalLines > HEADLESS_PREVIEW_LINES
        ? `\n…(${totalLines - HEADLESS_PREVIEW_LINES} more lines — pass a search that appears in the file, or read it first)`
        : '';

  const editedThisSession = (ctx?.state?.changes ?? []).some(
    (c) => c?.type === 'file' && samePath(c?.path, rel),
  );

  let hint =
    'The file exists and was read; copy the target text verbatim from the listing below, ' +
    'including line breaks and indentation, or pass line_start/line_end instead.';

  if (hasTruncationMarker(search)) {
    hint +=
      ' The search contains "…" / "..." — that is a truncation marker, not file content. Remove it and paste the full text from the listing.';
  }

  if (isJson) {
    const pointers = jsonPointerCandidates(content, search);
    const pointerHint =
      pointers.length > 0
        ? ` Or skip quoting entirely with json_patch: {"op": "set", "pointer": "${pointers[0]}", "value": …}` +
          (pointers.length > 1 ? ` (also near: ${pointers.slice(1).join(', ')})` : '')
        : ' Or use json_patch with a key pointer instead of quoting the whole block.';
    hint +=
      ' For .json: match escaping exactly (newlines inside strings must be \\n, quotes as \\"), ' + pointerHint;
  }

  if (editedThisSession) {
    hint +=
      ` This file was edited earlier in this session — the search may quote text that edit ` +
      `replaced; the listing below is current, quote from it, not from memory.`;
  }

  // Parse-based, from the async openEdit path — the sync match path passes none.
  if (definitions.length > 0) {
    hint += ` Closest definitions near line ${best}: ${definitions.map((s) => JSON.stringify(s)).join(' | ')}.`;
  }

  // Last fallback after exact and whitespace matching failed, and only as a
  // suggestion — never applied. Skipped when it collapses onto the preview.
  const fuzzy = fuzzyLines(content, search, best);
  if (fuzzy !== null && !(best !== null && fuzzy.line === best && fuzzy.lineEnd === best)) {
    hint += ` Did you mean ${lineSpanLabel(fuzzy.line, fuzzy.lineEnd)}? If so, quote that region verbatim from the listing below.`;
  }

  // An empty preview (file emptied since the plan) gets its own hint, distinct from a missing file.
  if (totalLines === 0) {
    hint += ' The file is empty on disk — it may have been deleted or restored since the plan was made; read the file first and verify the path.';
  }

  return {
    ok: false,
    kind: 'file',
    error: why,
    hint,
    code: TOOL_ERROR_CODE.ENOMATCH,
    display: `${rel} currently contains:\n${preview}${previewTail}`,
    data: { path: rel, lines: totalLines },
  };
}

function ambiguousFailure(
  content: string,
  search: string,
  ranges: { start: number; end: number }[],
  rel: string,
  isJson: boolean,
  why: string,
): ToolResult {
  const shown = ranges.slice(0, 5);
  const lines = shown.map((r) => lineAt(content, r.start));
  const snippets = lines
    .map((ln) => numberedWindow(content, ln, ln, { pad: 1 }))
    .join('\n---\n');

  let hint =
    `Resend with line_start set to one of these lines (${lines.join(', ')}) to change a single ` +
    `occurrence, or widen search with surrounding text so it is unique. Use replace_all: true ` +
    `only to change every match.`;

  if (isJson) {
    const pointers = jsonPointerCandidates(content, search);
    hint +=
      pointers.length > 0
        ? ` For .json with repeated values, prefer json_patch with a key pointer — candidates: ${pointers.join(', ')}.`
        : ' For .json with repeated values, prefer json_patch with a key pointer.';
  }

  return fail(
    why,
    {
      code: TOOL_ERROR_CODE.EAMBIGUOUS,
      hint,
      // The headline already names the file; repeating it here printed "Edit <path> — ambiguous search in <path>".
      note: `ambiguous search — nothing was changed`,
      display:
        `${rel} matches:\n${snippets}` +
        (ranges.length > shown.length ? `\n…(${ranges.length - shown.length} more)` : ''),
      data: { path: rel, lines },
    },
  );
}

// Plan (match) then apply (MagicString)

/** One matcher, one verdict. */
function planOneEdit(
  content: string,
  edit: EditSpec,
  ctx: ToolContextInput,
  rel: string,
  isJson = false,
): PlannedEdit {
  const plan = planEdit(content, edit, {
    rel,
    isJson,
    fileIndent: isJson ? detectJsonIndent(content) : '',
  });

  if (!plan.ok) {
    if (plan.code === TOOL_ERROR_CODE.ENOMATCH) {
      return { status: 'fail', result: notFoundFailure(content, String(edit.search), rel, ctx, isJson, plan.why) };
    }
    if (plan.code === TOOL_ERROR_CODE.EAMBIGUOUS) {
      return { status: 'fail', result: ambiguousFailure(content, String(edit.search), plan.ranges, rel, isJson, plan.why) };
    }
    // An argument the call got wrong.
    const missingReplace = edit.replace === undefined || edit.replace === null;
    return {
      status: 'fail',
      result: fail(plan.why, {
        code: TOOL_ERROR_CODE.EINVAL,
        hint: missingReplace
          ? 'Nothing was written. To delete the matched text rather than change it, pass replace: "" ' +
            'explicitly — include the surrounding newline in search to remove whole lines.'
          : 'Pass search (text copied verbatim from the file), or line_start/line_end to replace those whole lines, ' +
            'or insert_at_line to insert before a line — read the file first for the current line numbers.',
      }),
    };
  }

  return {
    status: 'ok',
    targets: plan.targets,
    replacement: plan.replacement,
    replacements: plan.replacements,
    exact: plan.exact,
    note: plan.why,
  };
}

/** Turn planned ranges into the next file text. */
function commitEdits(
  content: string,
  planned: Array<Extract<PlannedEdit, { status: 'ok' }>>,
): EditOutcome {
  const ops: TextEditOp[] = [];
  const notes: string[] = [];
  let totalReplacements = 0;
  let allExact = true;

  for (const p of planned) {
    notes.push(p.note);
    totalReplacements += p.replacements;
    allExact = allExact && p.exact;
    for (const t of p.targets) {
      ops.push({ start: t.start, end: t.end, replacement: p.replacement });
    }
  }

  if (ops.length === 0) {
    return okOutcome(content, 0, allExact, notes.join(', ') || 'no change');
  }

  const ordered = ops
    .map((op, index) => ({ ...op, index }))
    .sort((a, b) => a.start - b.start || a.end - b.end);

  for (let i = 1; i < ordered.length; i++) {
    const previous = ordered[i - 1];
    const current = ordered[i];
    if (current.start < previous.end) {
      return failOutcome(
        fail('Nothing was written — planned edits overlap.', {
          code: TOOL_ERROR_CODE.EINVAL,
          hint:
            `Edit operations ${previous.index + 1} and ${current.index + 1} target overlapping ` +
            `ranges (${previous.start}-${previous.end}) and (${current.start}-${current.end}). ` +
            'Widen the searches or split the changes into separate calls.',
        }),
      );
    }
  }

  const applied = applyTextEdits(content, ops);
  if (applied.ok === false) {
    return failOutcome(
      fail(`Nothing was written — ${applied.why}`, {
        code: TOOL_ERROR_CODE.EINVAL,
        hint:
          'Edits in one call must target distinct regions of the file as it was read. ' +
          'Split overlapping changes into separate calls, or widen each search so the ranges do not collide.',
      }),
    );
  }

  return okOutcome(applied.content, totalReplacements, allExact, notes.join(', '));
}

function applyEdit(
  content: string,
  edit: EditSpec,
  ctx: ToolContextInput,
  rel: string,
  isJson = false,
): EditOutcome {
  const planned = planOneEdit(content, edit, ctx, rel, isJson);
  if (planned.status === 'fail') return failOutcome(planned.result);
  return commitEdits(content, [planned]);
}

/** Batch edits are planned against the file *as read*, then applied in one MagicString pass. */
function applyBatch(
  content: string,
  edits: EditSpec[],
  ctx: ToolContextInput,
  rel: string,
  isJson: boolean,
): EditOutcome {
  const planned: Array<Extract<PlannedEdit, { status: 'ok' }>> = [];
  const notes: string[] = [];

  for (let i = 0; i < edits.length; i++) {
    const r = planOneEdit(content, edits[i], ctx, rel, isJson);
    if (r.status === 'fail') {
      const landed = notes.length > 0 ? ` Items already planned: ${notes.join('; ')}.` : '';
      const remaining = edits.length - i - 1;
      const notAttempted =
        remaining > 0 ? ` ${remaining} item(s) were not attempted.` : '';
      // What happened is for both; how to retry is recovery advice for the model, so it rides in the hint.
      const retry = `${landed}${notAttempted} Fix item ${i + 1} and resend the whole array.`.trim();
      return {
        status: 'fail',
        result: {
          ...r.result,
          error: `Edit ${i + 1} of ${edits.length} failed: ${r.result.error}\nNothing was written — edits are applied or rolled back together.`,
          hint: [r.result.hint, retry].filter(Boolean).join(' '),
        },
      };
    }
    notes.push(r.note);
    planned.push(r);
  }

  return commitEdits(content, planned);
}

// A `symbol` locator names a definition ("getById", "ProductService.GetById")
// so the model need not reproduce its body verbatim. Resolution synthesizes
// the definition's exact text as `search`, and the existing sync pipeline —
// matching, overlap checks, JSON and syntax guards — applies unchanged.

type ResolvedArgs =
  | { status: 'ok'; args: EditArgs }
  | { status: 'fail'; result: ToolResult };

function hasSymbol(edit: EditSpec): boolean {
  return typeof edit.symbol === 'string' && edit.symbol.trim() !== '';
}

async function resolveOneSymbol(
  content: string,
  edit: EditSpec,
  rel: string,
  label: string,
): Promise<EditSpec | ToolResult> {
  if (!hasSymbol(edit)) return edit;
  const symbol = String(edit.symbol).trim();
  let ranges = await findSymbolRanges(rel, content, symbol);
  // line_start/line_end choose between same-named definitions, mirroring search.
  if (ranges.length > 1 && edit.line_start !== undefined) {
    const start = Math.floor(Number(edit.line_start));
    const end = edit.line_end !== undefined ? Math.floor(Number(edit.line_end)) : start;
    const span = offsetOfLines(content, start, end);
    const picked = span === null ? [] : ranges.filter((r) => r.start < span.end && span.start < r.end);
    if (picked.length === 1) ranges = picked;
  }
  if (ranges.length === 0) {
    return fail(
      `${label}symbol "${symbol}" names no definition in ${rel} — nothing was written.`,
      {
        code: TOOL_ERROR_CODE.ENOMATCH,
        hint: 'Check the spelling against the definitions in the file (read it first), or pass search with the text copied verbatim instead.',
      },
    );
  }
  if (ranges.length > 1) {
    const lines = ranges.map((r) => r.line);
    return fail(
      `${label}symbol "${symbol}" matches ${ranges.length} definitions in ${rel} (lines ${lines.join(', ')}) — nothing was written.`,
      {
        code: TOOL_ERROR_CODE.EAMBIGUOUS,
        hint: `Resend with line_start set to one of these lines (${lines.join(', ')}) to change a single definition, or pass search with verbatim text instead.`,
      },
    );
  }
  const r = ranges[0];
  const next: EditSpec = { ...edit, search: content.slice(r.start, r.end) };
  delete next.symbol;
  return next;
}

/** ToolResults carry `ok`; resolved edits never do. */
function isToolFailure(value: EditSpec | ToolResult): value is ToolResult {
  return typeof (value as ToolResult).ok === 'boolean';
}

/** Resolve `symbol` locators to verbatim `search` text. Exported for the approval preview, like dryRunEdit. */
export async function resolveSymbols(content: string, args: EditArgs, rel: string): Promise<ResolvedArgs> {
  const items = Array.isArray(args.edits) && args.edits.length > 0 ? args.edits : null;
  if (!items && !hasSymbol(args)) return { status: 'ok', args };
  if (!items) {
    const resolved = await resolveOneSymbol(content, args, rel, '');
    if (isToolFailure(resolved)) return { status: 'fail', result: resolved };
    return { status: 'ok', args: { ...args, ...resolved } };
  }
  const out: EditSpec[] = [];
  for (let i = 0; i < items.length; i++) {
    const resolved = await resolveOneSymbol(content, items[i], rel, `Edit ${i + 1} of ${items.length} failed: `);
    if (isToolFailure(resolved)) return { status: 'fail', result: resolved };
    out.push(resolved);
  }
  return { status: 'ok', args: { ...args, edits: out } };
}

export function dryRunEdit(
  content: string,
  args: Record<string, any>,
  ctx: ToolContextInput,
  rel: string,
  isJson = false,
): EditOutcome {
  // Text matching only, kept sync so wouldWrite (the ledger's hash preview)
  // can call it. The syntax check lives in openEdit, the async path both
  // cannotRun and execute share, so a broken edit is refused before approval.
  const edits = Array.isArray(args.edits) && args.edits.length > 0 ? (args.edits as EditSpec[]) : null;
  const outcome = edits
    ? applyBatch(content, edits, ctx, rel, isJson)
    : applyEdit(content, args, ctx, rel, isJson);
  if (outcome.status === 'ok' && isJson && outcome.content !== content) {
    const checked = validateJson(outcome.content, rel);
    if (checked.ok === false) {
      const bad = checked as { error: string; hint: string };
      return failOutcome(fail(bad.error, { code: TOOL_ERROR_CODE.EINVAL, hint: bad.hint }));
    }
  }
  return outcome;
}

// Preview helper

function firstMeaningfulLine(v: unknown): string {
  const lines = String(v ?? '').split('\n');
  const line =
    lines.find((l) => l.trim() !== '' && !STRUCTURAL_LINES.has(l.trim())) ??
    lines.find((l) => l.trim() !== '') ??
    '';
  const trimmed = line.trim();
  if (!trimmed) return '(nothing)';
  return JSON.stringify(trimmed.length > 56 ? `${trimmed.slice(0, 55)}…` : trimmed);
}

// Tool definition

/** Open the target and work out what this call would do — without writing. */
type OpenedEdit =
  | { failure: ToolResult; rel: null; opened: null; edits: null; outcome: null; stamp: null }
  | {
      failure: null;
      rel: string;
      opened: OpenedTextFileSuccess;
      edits: EditSpec[] | null;
      outcome: EditOutcome;
      stamp: string | null;
    };

/** The fields one edit carries: at the top level for a single edit, inside each item for a batch. */
const EDIT_FIELDS = ['search', 'symbol', 'replace', 'replace_all', 'line_start', 'line_end', 'insert_at_line'] as const;

/** A path an edits item repeats is fine when it names the call's own file. */
function namesSameFile(ctx: ToolContextInput, itemPath: unknown, abs: string): boolean {
  if (typeof itemPath !== 'string' || itemPath === '') return false;
  try {
    return samePath(workspaceFor(ctx).resolveLexical(itemPath), workspaceFor(ctx).resolveLexical(abs));
  } catch {
    return false;
  }
}

async function openEdit(
  abs: string,
  args: EditArgs,
  ctx: ToolContextInput,
): Promise<OpenedEdit> {
  const isBatch = Array.isArray(args.edits) && args.edits.length > 0;
  const refused = (result: ToolResult): OpenedEdit => ({ failure: result, rel: null, opened: null, edits: null, outcome: null, stamp: null });

  // With edits, each item says where it goes; the same fields at the top level would be silently ignored.
  const strays = isBatch ? EDIT_FIELDS.filter((key) => args[key] !== undefined && args[key] !== null) : [];
  if (strays.length > 0) {
    return refused(fail(`${strays.join(', ')} ${strays.length === 1 ? 'was' : 'were'} given next to edits — nothing was written.`, {
      code: TOOL_ERROR_CODE.EINVAL,
      hint: `With edits, put ${strays.join(', ')} inside each edits item; the top level holds only path and edits.`,
    }));
  }

  // Where each edit goes (search, symbol, a line range or an insert line) is checked by planEdit against the file; here only what needs no file.
  const items: EditSpec[] = isBatch ? args.edits! : [args];
  for (let i = 0; i < items.length; i++) {
    const edit = (items[i] ?? {}) as EditSpec & { path?: unknown };
    const label = isBatch ? `Invalid edit ${i + 1}.` : 'Invalid edit request.';
    if (typeof edit.replace !== 'string') {
      return refused(fail(label, {
        code: TOOL_ERROR_CODE.EINVAL,
        hint: 'Every edit needs replace: the new text. Use replace: "" explicitly to delete.',
      }));
    }
    if (typeof edit.search === 'string' && edit.search !== '' && hasSymbol(edit)) {
      return refused(fail(label, {
        code: TOOL_ERROR_CODE.EINVAL,
        hint: 'Pass search or symbol, not both — either one already names the text to replace.',
      }));
    }
    if (isBatch && edit.path !== undefined && !namesSameFile(ctx, edit.path, abs)) {
      return refused(fail(`edit ${i + 1} names ${JSON.stringify(edit.path)}, but the call edits ${JSON.stringify(args.path)} — nothing was written.`, {
        code: TOOL_ERROR_CODE.EINVAL,
        hint: 'Give path once at the top level; edits items carry no path. Edit another file in a separate call.',
      }));
    }
  }

  // `workspaceFor`, not `ctx.ws`: `execute` is handed a context that already carries one, but the gate's `cannotRun` runs on a bare tool context.
  const rel = workspaceFor(ctx).rel(abs);
  const stamp = fileStamp(abs);
  const opened = await openTextFile(abs, rel, {
    isDirHint: 'edit_file works on files; use list_directory to inspect a directory.',
    binaryHint: 'edit_file rewrites the whole file as text; a binary file cannot survive that.',
    notUtf8Error: `${rel} is not valid UTF-8 text, so editing it would corrupt it`,
    notUtf8Hint:
      'Every byte that is not valid UTF-8 would be replaced. Leave this file alone, or use ' +
      'delete it and create it again with write_file if you genuinely mean to replace its contents with UTF-8 text.',
  });
  if (!opened.ok) return { failure: opened.result, rel: null, opened: null, edits: null, outcome: null, stamp: null };

  // Symbols resolve against the file as read, before matching: the rest of
  // the pipeline (and wouldWrite's sync preview, which skips symbols) is untouched.
  const resolved = await resolveSymbols(opened.content, args, rel);
  if (resolved.status === 'fail') {
    return { failure: resolved.result, rel: null, opened: null, edits: null, outcome: null, stamp: null };
  }
  const effective = resolved.args;

  const edits: EditSpec[] | null =
    Array.isArray(effective.edits) && effective.edits.length > 0 ? (effective.edits as EditSpec[]) : null;

  let outcome = dryRunEdit(opened.content, effective, ctx, rel, opened.isJson);
  if (outcome.status === 'fail' && outcome.result.code === TOOL_ERROR_CODE.ENOMATCH && !edits) {
    // Single edit only: a batch names its failing item already, and the item's
    // search isn't recoverable from the wrapped error. The sync match path
    // can't parse (WASM load is async), so the hint is enriched here, on the
    // async path both cannotRun and execute share.
    const defs = await nearbyDefinitions(
      rel,
      opened.content,
      bestMatchLine(opened.content, String(effective.search ?? '')),
    );
    if (defs.length > 0) {
      outcome = failOutcome(
        notFoundFailure(
          opened.content,
          String(effective.search),
          rel,
          ctx,
          opened.isJson,
          String(outcome.result.error),
          defs,
        ),
      );
    }
  }
  if (outcome.status === 'ok' && outcome.content !== opened.content) {
    const broken = await syntaxBreak(rel, opened.content, outcome.content);
    if (broken) {
      return {
        failure: null,
        rel,
        opened,
        edits,
        outcome: failOutcome(
          fail(`Refusing to edit ${rel}: ${broken}. Nothing was written.`, {
            code: TOOL_ERROR_CODE.EINVAL,
            hint: 'Fix the replacement so the file still parses — the line number names the first new syntax error. Only errors this edit adds count, so fixing an already-broken file is never blocked.',
          }),
        ),
        stamp,
      };
    }
  }

  return { failure: null, rel, opened, edits, outcome, stamp };
}

export default defineTool({
  name: 'edit_file',
  aliases: ['update_file', 'patch_file', 'replace_in_file'],
  argAliases: {
    file: 'path',
    filename: 'path',
    filepath: 'path',
    file_path: 'path',
    old: 'search',
    old_string: 'search',
    find: 'search',
    find_text: 'search',
    old_text: 'search',
    new: 'replace',
    new_string: 'replace',
    new_text: 'replace',
    replace_text: 'replace',
    start_line: 'line_start',
    from_line: 'line_start',
    line: 'line_start',
    end_line: 'line_end',
    to_line: 'line_end',
  },
  profiles: ['core'],
  category: 'filesystem',
  activity: 'Editing a file',
  label: 'Edit File',
  brief:
    'Change a file: replace text found by search or symbol, replace lines line_start..line_end, or insert at insert_at_line.',
  risky: true,
  restorable: true,
  description:
    'Change an existing file. First read the relevant section, then say where the change goes in one of four ways. ' +
    '(1) search: a narrow piece of the file copied verbatim, including indentation and line breaks; it must identify ' +
    'exactly one place — widen it until it does, set replace_all to change every match, or add line_start to say ' +
    'which match you mean. Whatever search matches is replaced. ' +
    '(2) symbol: a definition name ("getById", or "ProductService.GetById" for a method) whose whole body is replaced, ' +
    'with no need to quote it. ' +
    '(3) line_start/line_end with no search: those whole lines (inclusive, 1-based, as read_file numbers them) are replaced by replace. ' +
    '(4) insert_at_line: replace is inserted as new lines before that line; one past the last line appends. ' +
    'Line numbers must come from a fresh read of the file. Pass an array of edits to make several changes to the same ' +
    'file in one call; every item is placed against the file as read, and each needs its own locator. Keep the patch ' +
    'minimal and preserve unrelated code. `path` is given once at the top level, never inside `edits` items — e.g. ' +
    '{"path": "src/a.js", "edits": [{"search": "assert(x)", "replace": "assert(y)"}, {"insert_at_line": 12, "replace": "log(y);"}]}.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', pathArg: true, description: 'Workspace-relative file path' },
      search: {
        type: 'string',
        description:
          'Text to find, copied verbatim from the file including indentation. With search, line_start only chooses between several matches.',
      },
      symbol: {
        type: 'string',
        description:
          'A definition name ("getById", or "ProductService.GetById" for a member) whose whole body is replaced. ' +
          'Alternative to search for long bodies — pass one or the other, not both.',
      },
      replace: {
        type: 'string',
        description: 'The new text: it replaces what search/symbol/the line range names, or is inserted at insert_at_line. Always required; "" deletes.',
      },
      replace_all: { type: 'boolean', description: 'With search: replace every occurrence instead of requiring uniqueness' },
      line_start: {
        type: 'number',
        description:
          'First line (1-based). Without search: the first line of the range to replace. With search: picks which match to change.',
      },
      line_end: {
        type: 'number',
        description: 'Last line of that range, inclusive; defaults to line_start.',
      },
      insert_at_line: {
        type: 'number',
        description: 'Insert replace as new lines before this 1-based line; one past the last line appends. Use alone, without search or line_start.',
      },
      edits: {
        type: 'array',
        description:
          'Apply several edits to this file in one call. Each item accepts the same ' +
          'search/symbol/replace/replace_all/line_start/line_end/insert_at_line fields as a single edit, but NOT path — ' +
          'the file is named once by the top-level path. Line numbers in every item refer to the file as read. ' +
          'If any item fails, the whole call fails and nothing is written.',
        items: {
          type: 'object',
          properties: {
            search: { type: 'string', description: 'Text to find, verbatim; unique unless replace_all or line_start narrows it' },
            symbol: {
              type: 'string',
              description: 'A definition name ("getById", or "ProductService.GetById") whose whole body is replaced; alternative to search',
            },
            replace: { type: 'string', description: 'The new text; "" deletes' },
            replace_all: { type: 'boolean', description: 'With search: replace every occurrence' },
            line_start: { type: 'number', description: 'Without search: first line of the range to replace. With search: picks the match' },
            line_end: { type: 'number', description: 'Last line of that range, inclusive' },
            insert_at_line: { type: 'number', description: 'Insert replace before this line; one past the last line appends' },
          },
          required: ['replace'],
          requiredOneOf: [['search'], ['symbol'], ['line_start'], ['insert_at_line']],
        },
      },
    },
    required: ['path'],
    requiredOneOf: [['edits'], ['search', 'replace'], ['symbol', 'replace'], ['line_start', 'replace'], ['insert_at_line', 'replace']],
  },

  wouldWrite(args) {
    return [{
      path: String(args?.path ?? ''),
      after: (before, rel) => {
        const outcome = dryRunEdit(before, args, {} as never, rel, isJsonPath(rel));
        return outcome.status === 'ok' ? outcome.content : undefined;
      },
    }];
  },

  preview(args) {
    const batch = Array.isArray(args?.edits) ? args.edits : null;
    if (batch && batch.length > 1) return `${batch.length} edits to ${args?.path}`;

    const edit = batch ? batch[0] ?? {} : args ?? {};
    const target =
      typeof edit.search === 'string' && edit.search !== ''
        ? firstMeaningfulLine(edit.search)
        : typeof edit.symbol === 'string' && edit.symbol.trim() !== ''
          ? `symbol ${edit.symbol.trim()}`
          : edit.insert_at_line != null
            ? `insert before line ${edit.insert_at_line}`
            : edit.line_start != null
              ? lineSpanLabel(Number(edit.line_start), Number(edit.line_end ?? edit.line_start))
              : '(invalid edit: nothing says where it goes)';
    return `edit ${args?.path}: ${target} -> ${firstMeaningfulLine(edit.replace)}`;
  },

  /** Would this call fail before it changed anything? */
  async cannotRun(args, ctx) {
    let abs: string;
    try {
      // workspaceFor, not ctx.ws: the gate runs before path resolution and has already checked containment.
      abs = workspaceFor(ctx).resolveLexical(String(args.path));
    } catch {
      return null;
    }
    const planned = await openEdit(abs, args, ctx);
    if (planned.failure) return planned.failure;
    return planned.outcome && planned.outcome.status === 'fail' ? planned.outcome.result : null;
  },

  async execute(args, ctx) {
    try {
      const typedArgs = args as EditArgs;
      const abs = String(typedArgs.path ?? '');
      if (!typedArgs.path) {
        return fail('Missing path.', {
          code: TOOL_ERROR_CODE.EINVAL,
          hint: 'Pass the workspace-relative file path in path.',
        });
      }
      const planned = await openEdit(abs, typedArgs, ctx);
      if (planned.failure) return planned.failure;
      const rel = planned.rel;
      const opened = planned.opened;
      const { content, hadBom, isJson: jsonFile } = opened;
      const outcome = planned.outcome;

      if (outcome.status === 'fail') return outcome.result;

      const { content: updated, replacements: totalReplacements, exact: allExact, note } = outcome;

      // Detect a no-op even when replace_all matched N times but produced byte-identical content — the previous check missed that case.
      if (contentUnchanged(content, updated)) {
        // This text is already correct; it does not follow that anything else still needs fixing here.
        // Naming a cause we cannot see is what sends a model back to reapply the same no-op edit; the advice is the model's, the screen gets the fact.
        return {
          ...ok({
            kind: 'file',
            display: `No change — ${rel} already reads that way, nothing was written.`,
            data: {
            path: rel,
            replacements: totalReplacements,
            matched: totalReplacements,
            changed: 0,
            exact: allExact,
            note: note || 'no change (already in desired state)',
          },
          }),
          modelNote: 'Resending this edit will change nothing. If something is still wrong, it is not in this edit — look at what is actually failing, in this file or elsewhere.',
        };
      }

      if (jsonFile) {
        const checked = validateJson(updated, rel);
        if (checked.ok === false) {
          const bad = checked as { error: string; hint: string };
          return fail(bad.error, { code: TOOL_ERROR_CODE.EINVAL, hint: bad.hint });
        }
      }
      // No brace-balance gate: counting braces cannot tell code from string, and C# interpolation (`$"{x}"`) made it reject correct edits.

      // Refuse if the file changed since it was read, rather than overwrite someone else's bytes.
      if (planned.stamp !== null && fileStamp(abs) !== planned.stamp) {
        return fail(
          `${rel} changed on disk since it was read — nothing was written`,
          {
            code: TOOL_ERROR_CODE.EBUSY,
            hint: 'Re-read the file and resend the edit against the current contents.',
          },
        );
      }

      const written = await writeAndVerify(abs, updated, {
        hadBom,
        previousStat: opened.stat,
        original: content,
        expectedContent: content,
      });
      if (!written.ok) {
        return fail(
          `Tried to edit ${rel} but the file is ${written.describe} afterwards.` +
            (written.restored ? ' The original content was put back.' : ''),
          {
            code: TOOL_ERROR_CODE.ENOTVERIFIED,
            hint: written.restored
              ? 'Nothing was changed. Re-read the file and try again.'
              : 'Re-read the file to see what state it is in before editing it again.',
          },
        );
      }

      noteChange(ctx, 'edit', abs, 'file');

      const diff = safeDiff(content, updated);
      const changeCount = totalReplacements;
      const flexNote = allExact ? '' : ' (matched ignoring whitespace)';
      const noteText = note ? ` (${note})` : '';
      const header = `Edited ${rel}${changeCount > 1 ? ` — ${changeCount} changes` : ''}${flexNote}${noteText}`;

      return ok({
        kind: 'file',
        display: diff ? `${header}\n${diff}` : header,
        data: {
          path: rel,
          replacements: totalReplacements,
          exact: allExact,
          bytes: Buffer.byteLength(updated, 'utf8'),
          diff,
          oldContent: content,
          newContent: updated,
        },
      });
    } catch (err) {
      return fromError(err);
    }
  },
});