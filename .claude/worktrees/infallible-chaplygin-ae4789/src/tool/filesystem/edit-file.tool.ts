import type { ToolContextInput, ToolResult } from '../../types';
import crypto from 'node:crypto';

import { TOOL_ERROR_CODE } from '../../protocol';
import { fileStamp, samePath } from '../../core/paths';

import { defineTool } from '../core/defineTool';
import { ok, fail, fromError } from '../core/tool-result';
import { noteChange } from './_fs';
import { noteSeen, hasSeen } from './_seen';
import { openTextFile, writeAndVerify, safeDiff } from './_text-file';
import { numberedWindow } from './_window';
import {
  planEdit,
  lineAt,
  countLines,
  bestMatchLine,
  fuzzyLines,
  lineSpanLabel,
  linesRepeatedAfter,
  type MatchRange,
} from './_match';
import { applyTextEdits, type TextEditOp } from './_edit-apply';
import { syntaxBreak, nearbyDefinitions } from './_syntax';
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
  replace?: string;
  replace_all?: boolean;
}

export interface EditArgs extends EditSpec {
  path?: string;
}

type OpenedTextFile = Awaited<ReturnType<typeof openTextFile>>;
type OpenedTextFileSuccess = Extract<OpenedTextFile, { ok: true }>;

type EditOutcome =
  | { status: 'ok'; content: string; replacements: number; exact: boolean; note: string; repeated?: Repeated }
  | { status: 'fail'; result: ToolResult };

/** Lines the edit wrote that were already right after it, in the new file: `from`–`to`, and again from `again`. */
type Repeated = { from: number; to: number; again: number };

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
  repeated?: Repeated,
): EditOutcome => ({ status: 'ok', content, replacements, exact, note, ...(repeated ? { repeated } : {}) });

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
  // Written as regex literals: the escapes were once doubled as if in a string, so `[\\s]` matched a backslash or an
  // "s" and none of these ever fired.
  return /(?:^|\s)(?:…|\.\.\.)(?:$|\s)/.test(s) ||
    /…\s*$/.test(s) ||
    /\.{3}\s*$/.test(s);
}

function notFoundFailure(
  content: string,
  search: string,
  rel: string,
  ctx: ToolContextInput,
  isJson: boolean,
  why: string,
  definitions: string[] = [],
  where: { focus?: { line: number; lineEnd: number }; divergedAt?: number } = {},
): ToolResult {
  const totalLines = countLines(content);
  // The listing shows the line the verdict names; a listing chosen another way showed lines the model had not got wrong.
  const best = where.focus?.line ?? bestMatchLine(content, search);
  const preview =
    best !== null
      ? numberedWindow(content, best, best, { pad: 6, mark: where.divergedAt !== undefined })
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
    'including line breaks and indentation.';

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
  // A search that parted ways at a named line needs no guess at where it was meant to go.
  const fuzzy = where.divergedAt === undefined ? fuzzyLines(content, search, best) : null;
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
    // Where the listing points, so a caller that rebuilds this failure (with definitions) points at the same place.
    data: { path: rel, lines: totalLines, where },
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
    `Widen search with surrounding text so it names one place (lines ${lines.join(', ')} hold it now). ` +
    `Use replace_all: true only to change every match.`;

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
      return { status: 'fail', result: notFoundFailure(content, String(edit.search), rel, ctx, isJson, plan.why, [], plan) };
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
          : 'Pass search: the exact text to change, copied from the file as read_file shows it.',
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
  // One edit with replace_all makes several ops.
  const ops: TextEditOp[] = [];
  const notes: string[] = [];
  let totalReplacements = 0;
  let allExact = true;

  planned.forEach((p) => {
    notes.push(p.note);
    totalReplacements += p.replacements;
    allExact = allExact && p.exact;
    for (const t of p.targets) {
      ops.push({ start: t.start, end: t.end, replacement: p.replacement });
    }
  });

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
      // In lines, as the model reads the file: character offsets told it nothing it could act on.
      const from = lineAt(content, current.start);
      const to = lineAt(content, Math.max(current.start, Math.min(previous.end, current.end) - 1));
      return failOutcome(
        fail(`Nothing was written — two matches of search overlap at ${lineSpanLabel(from, to)}.`, {
          code: TOOL_ERROR_CODE.EINVAL,
          hint: 'Widen search so its matches do not overlap.',
          display: numberedWindow(content, from, to, { pad: 3, mark: true }),
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
          'The matches of search overlap. Widen search so they do not.',
      }),
    );
  }

  return okOutcome(applied.content, totalReplacements, allExact, notes.join(', '), firstRepeat(content, applied.content, ordered));
}

/** "Lines 3-4 now appear twice …": said first in the result, where it is read first. */
function twiceLine(r: Repeated): string {
  const n = r.to - r.from + 1;
  const span = n === 1 ? `Line ${r.from} now appears` : `Lines ${r.from}-${r.to} now appear`;
  const copy = n === 1 ? `line ${r.again}` : `lines ${r.again}-${r.again + n - 1}`;
  return `${span} twice: replace wrote again what already followed the match (also at ${copy}). ` +
    'If that was not meant, edit again to remove one copy.';
}

/** The first place, in file order, where the replacement wrote again the lines that already followed the match. */
function firstRepeat(before: string, after: string, ordered: TextEditOp[]): Repeated | undefined {
  let shift = 0;
  for (const op of ordered) {
    const found = linesRepeatedAfter(before, op, op.replacement);
    const grew = op.replacement.length - (op.end - op.start);
    if (found) {
      const from = lineAt(after, op.start + shift) + found.at;
      // The lines that followed the match, where they sit now: right after the replacement.
      const end = op.end + shift + grew;
      const again = lineAt(after, end === 0 || after[end - 1] === '\n' ? end : end + (after[end] === '\r' ? 2 : 1));
      return { from, to: from + found.count - 1, again };
    }
    shift += grew;
  }
  return undefined;
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
  const outcome = applyEdit(content, args, ctx, rel, isJson);
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
  | { failure: ToolResult; rel: null; opened: null; outcome: null; stamp: null }
  | {
      failure: null;
      rel: string;
      opened: OpenedTextFileSuccess;
      outcome: EditOutcome;
      stamp: string | null;
    };

async function openEdit(
  abs: string,
  args: EditArgs,
  ctx: ToolContextInput,
): Promise<OpenedEdit> {
  const refused = (result: ToolResult): OpenedEdit => ({ failure: result, rel: null, opened: null, outcome: null, stamp: null });

  // Whether search names one place is checked by planEdit against the file; here only what needs no file.
  if (typeof args.replace !== 'string') {
    return refused(fail('Invalid edit request.', {
      code: TOOL_ERROR_CODE.EINVAL,
      hint: 'Every edit needs replace: the new text. Use replace: "" explicitly to delete.',
    }));
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
  if (!opened.ok) return { failure: opened.result, rel: null, opened: null, outcome: null, stamp: null };

  // An edit changes what the model has read: one it never read, it would be editing from memory.
  if (!hasSeen(ctx?.state, rel)) {
    return refused(fail(`${rel} has not been read in this session — nothing was written.`, {
      code: TOOL_ERROR_CODE.EINVAL,
      hint: `Read ${rel} with read_file first, then copy the text to change into search.`,
    }));
  }

  let outcome = dryRunEdit(opened.content, args, ctx, rel, opened.isJson);
  if (outcome.status === 'fail' && outcome.result.code === TOOL_ERROR_CODE.ENOMATCH) {
    // The sync match path
    // can't parse (WASM load is async), so the hint is enriched here, on the
    // async path both cannotRun and execute share.
    const where = ((outcome.result.data as { where?: { focus?: { line: number; lineEnd: number }; divergedAt?: number } } | undefined)?.where) ?? {};
    const defs = await nearbyDefinitions(
      rel,
      opened.content,
      where.focus?.line ?? bestMatchLine(opened.content, String(args.search ?? '')),
    );
    if (defs.length > 0) {
      outcome = failOutcome(
        notFoundFailure(
          opened.content,
          String(args.search),
          rel,
          ctx,
          opened.isJson,
          String(outcome.result.error),
          defs,
          where,
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
        outcome: failOutcome(
          {
            ...fail(`Refusing to edit ${rel}: ${broken.why}. Nothing was written.`, {
              code: TOOL_ERROR_CODE.EINVAL,
              hint: 'Fix the replacement so the file still parses. When search names only the start of a block (its first line) but replace is the whole new block, the rest of the old block stays behind it: search for the whole old block. Only errors this edit adds count, so fixing an already-broken file is never blocked.',
            }),
            modelNote: `What ${rel} would look like around line ${broken.why.match(/line (\d+)/)?.[1] ?? ''} after this edit (> marks the error):\n${broken.context}`,
          },
        ),
        stamp,
      };
    }
  }

  return { failure: null, rel, opened, outcome, stamp };
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
  },
  profiles: ['core'],
  category: 'filesystem',
  activity: 'Editing a file',
  label: 'Edit File',
  brief: 'Change a file you have read: replace the text search names with replace.',
  risky: true,
  restorable: true,
  description:
    'Change a file you have read this session. search is the text to change, copied from the file ' +
    '(without read_file\'s line-number gutter), including indentation and line breaks. It is matched exactly; only ' +
    'when nothing matches exactly is it matched ignoring differences in whitespace, and the result says so. It must ' +
    'name exactly one place — widen it with surrounding lines until it does, or set replace_all to change every match. Whatever ' +
    'search matches is replaced by replace ("" deletes). One call makes one change; for several changes, make one ' +
    'call each. To add new text, include a neighbouring line in search and repeat it in replace — e.g. ' +
    '{"path": "src/a.js", "search": "assert(x)", "replace": "assert(y)"}.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', pathArg: true, description: 'Workspace-relative file path' },
      search: {
        type: 'string',
        description: 'The text to change, copied from the file including indentation (matched exactly, else ignoring whitespace differences); it must appear exactly once unless replace_all is set.',
      },
      replace: {
        type: 'string',
        description: 'The new text that replaces what search matched; "" deletes it.',
      },
      replace_all: { type: 'boolean', description: 'Replace every occurrence of search instead of requiring it to be unique' },
    },
    required: ['path', 'search', 'replace'],
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
    const edit = args ?? {};
    const target = typeof edit.search === 'string' && edit.search !== '' ? firstMeaningfulLine(edit.search) : '(no search)';
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
        // Only the fact: replace gives back the text that is there. Guessing at a cause elsewhere sent a model that meant
        // to delete lines (and copied them into replace again) away from its own edit, round and round.
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
          modelNote: 'Nothing changed: replace gives the same text that is already there, so resending this edit changes nothing. ' +
            'replace is what the matched text becomes — to remove lines, leave them out of replace.',
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
      // The model knows what it just wrote: the file stays read.
      noteSeen(ctx?.state, rel, updated);

      const diff = safeDiff(content, updated);
      const changeCount = totalReplacements;
      const flexNote = allExact ? '' : ' (matched ignoring whitespace)';
      const noteText = note ? ` (${note})` : '';
      const header = `Edited ${rel}${changeCount > 1 ? ` — ${changeCount} changes` : ''}${flexNote}${noteText}`;
      // First, where it is read first: replace wrote again lines the file already had right after the match.
      const twice = outcome.repeated
        ? `${twiceLine(outcome.repeated)}\n`
        : '';

      return ok({
        kind: 'file',
        display: `${twice}${diff ? `${header}\n${diff}` : header}`,
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