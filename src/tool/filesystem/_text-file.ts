import fsp from 'node:fs/promises';

import { TOOL_ERROR_CODE } from '../../protocol';
import { fail, fromError } from '../core/tool-result';
import { renderDiff, renderNewFile } from '../../ui/diff';
import { decodeUtf8, isBinaryExtension, statType, writeFileAtomic, type StatInfo } from './_fs';
import { isJsonPath, stripBom } from './_json';

const BOM = '﻿';

/** The wording each tool uses for the three guards below. */
interface TextFileMessages {
  isDirHint?: string;
  binaryHint?: string;
  notUtf8Error: string;
  notUtf8Hint?: string;
}

export interface OpenedTextFile {
  ok: true;
  /** Stat taken before the read, to carry the file mode through an atomic write. */
  stat: StatInfo | null;
  /** File text with any BOM removed. */
  content: string;
  hadBom: boolean;
  isJson: boolean;
  result?: undefined;
}

type OpenTextFileResult =
  | OpenedTextFile
  | { ok: false; result: import('../../types.ts').ToolResult };

/** Open a file for in-place editing: refuse a directory, a binary file, or bytes that are not valid UTF-8, then hand back the decoded text without its BOM. */
export async function openTextFile(
  abs: string,
  rel: string,
  messages: TextFileMessages
): Promise<OpenTextFileResult> {
  const stat = await statType(abs);
  if (stat?.type === 'dir') {
    return {
      ok: false,
      result: fail(`${rel} is a directory`, {
        code: TOOL_ERROR_CODE.EISDIR,
        hint: messages.isDirHint,
      }),
    };
  }

  let raw;
  try {
    raw = await fsp.readFile(abs);
  } catch (err) {
    return { ok: false, result: fromError(err) };
  }

  if (isBinaryExtension(abs)) {
    return {
      ok: false,
      result: fail(`${rel} is a binary file`, {
        code: TOOL_ERROR_CODE.EINVAL,
        hint: messages.binaryHint,
      }),
    };
  }

  if (raw.includes(0)) {
    return {
      ok: false,
      result: fail(`${rel} is a binary file`, {
        code: TOOL_ERROR_CODE.EINVAL,
        hint: messages.binaryHint,
      }),
    };
  }

  const decoded = decodeUtf8(raw);
  if (!decoded.lossless) {
    return {
      ok: false,
      result: fail(messages.notUtf8Error, {
        code: TOOL_ERROR_CODE.EINVAL,
        hint: messages.notUtf8Hint,
      }),
    };
  }

  const { text, hadBom } = stripBom(decoded.text);
  return { ok: true, stat, content: text, hadBom, isJson: isJsonPath(rel) };
}

/** Write `text` back atomically, restoring the BOM the file arrived with. */
async function writeTextFile(
  abs: string,
  text: string,
  {
    hadBom = false,
    previousStat = null,
    expectedBytes,
  }: { hadBom?: boolean; previousStat?: StatInfo | null; expectedBytes?: Buffer | null } = {},
): Promise<void> {
  const toWrite = hadBom && text.charCodeAt(0) !== 0xfeff ? `${BOM}${text}` : text;
  await writeFileAtomic(abs, toWrite, previousStat, expectedBytes);
}

type FileConfirmation =
  | { ok: true; stat: StatInfo; describe?: undefined }
  | { ok: false; stat?: undefined; describe: string };

/** Stat the path after a write. */
async function confirmFile(abs: string): Promise<FileConfirmation> {
  const stat = await statType(abs);
  if (stat?.type === 'file') return { ok: true, stat };
  if (stat?.type === 'symlink') {
    try {
      const target = await fsp.stat(abs);
      if (target.isFile()) return { ok: true, stat: { type: 'file', size: target.size, mode: target.mode } };
    } catch {}
    return { ok: false, describe: 'a broken symlink' };
  }
  return { ok: false, describe: stat ? `a ${stat.type}` : 'missing' };
}

interface WriteVerification {
  ok: boolean;
  /** What is wrong with the file on disk, when it is not ok. */
  describe?: string;
  /** Whether the pre-write bytes were put back. */
  restored?: boolean;
}

function fileBytes(text: string, hadBom: boolean): Buffer {
  const toWrite = hadBom && text.charCodeAt(0) !== 0xfeff ? `${BOM}${text}` : text;
  return Buffer.from(toWrite, 'utf8');
}

async function matchesExpected(abs: string, expected: Buffer | null): Promise<boolean> {
  try {
    const current = await fsp.readFile(abs);
    return expected !== null ? current.equals(expected) : false;
  } catch {
    return expected === null && (await statType(abs)) === null;
  }
}

/** Write the file, then read it back and prove the bytes are the ones intended. */
export async function writeAndVerify(
  abs: string,
  text: string,
  {
    hadBom = false,
    previousStat = null,
    original = null,
    expectedContent,
  }: {
    hadBom?: boolean;
    previousStat?: StatInfo | null;
    original?: string | null;
    /** The bytes read before computing `text`; null means the file was absent. */
    expectedContent?: string | null;
  } = {}
): Promise<WriteVerification> {
  const expected = expectedContent === undefined
    ? undefined
    : expectedContent === null
      ? null
      : fileBytes(expectedContent, hadBom);
  if (expectedContent !== undefined && expected !== undefined) {
    if (!(await matchesExpected(abs, expected))) {
      return {
        ok: false,
        describe: 'changed on disk since it was read; nothing was written',
      };
    }
  }

  try {
    await writeTextFile(abs, text, { hadBom, previousStat, expectedBytes: expected });
  } catch (err) {
    if ((err as { code?: string })?.code === 'EBUSY') {
      return { ok: false, describe: 'changed on disk before the atomic write; nothing was written' };
    }
    throw err;
  }

  const present = await confirmFile(abs);
  if (!present.ok) return { ok: false, describe: present.describe };

  let readBack: Buffer;
  try {
    readBack = await fsp.readFile(abs);
  } catch (err) {
    return { ok: false, describe: `unreadable after the write (${(err as { code?: string })?.code ?? 'unknown'})` };
  }

  const decoded = decodeUtf8(readBack);
  const landed = decoded.lossless ? stripBom(decoded.text).text : null;
  if (landed === text) return { ok: true };

  const describe = landed === null
    ? 'not valid UTF-8 after the write'
    : `different on disk from what was written (${text.length} chars intended, ${landed.length} found)`;

  if (original === null || !(await matchesExpected(abs, fileBytes(text, hadBom)))) {
    return { ok: false, describe };
  }
  try {
    await writeTextFile(abs, original, {
      hadBom,
      previousStat,
      expectedBytes: fileBytes(text, hadBom),
    });
    return { ok: false, describe, restored: true };
  } catch {
    return { ok: false, describe, restored: false };
  }
}

/** The diff shown alongside a successful write. */
export function safeDiff(
  before: string | null,
  after: string,
  { maxLines = 70 }: { maxLines?: number } = {}
): string {
  try {
    return before === null ? renderNewFile(after) : renderDiff(before, after, { context: 2, maxLines });
  } catch {
    return '';
  }
}
