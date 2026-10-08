import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';

function writers(): { command: string; args: string[]; }[] {
  if (process.platform === 'win32') return [{ command: 'clip', args: [] }];
  if (process.platform === 'darwin') return [{ command: 'pbcopy', args: [] }];
  return [
    { command: 'wl-copy', args: [] },
    { command: 'xclip', args: ['-selection', 'clipboard'] },
    { command: 'xsel', args: ['--clipboard', '--input'] },
  ];
}

function encode(text: string): Buffer | string {
  if (process.platform !== 'win32') return text;
  return Buffer.from(text, 'utf16le');
}

function feed(writer: { command: string; args: string[]; }, text: string): Promise<boolean> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(writer.command, writer.args, { stdio: ['pipe', 'ignore', 'ignore'] });
    } catch {
      resolve(false);
      return;
    }
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
    child.stdin.on('error', () => resolve(false));
    child.stdin.end(encode(text));
  });
}

export async function copyToClipboard(text: string): Promise<{ ok: boolean; via?: string; }> {
  const payload = String(text ?? '');
  if (!payload) return { ok: false };
  for (const writer of writers()) {
    if (await feed(writer, payload)) return { ok: true, via: writer.command };
  }
  if (copyViaOsc52(payload)) return { ok: true, via: 'OSC52' };
  return { ok: false };
}

/** Terminal-level clipboard fallback for SSH / containers where no clipboard binary exists. */
const OSC52_MAX_BYTES = 256 * 1024;

function copyViaOsc52(text: string, out: NodeJS.WriteStream = process.stdout): boolean {
  const payload = String(text ?? '');
  if (!payload || !out?.isTTY) return false;
  if (Buffer.byteLength(payload, 'utf8') > OSC52_MAX_BYTES) return false;
  try {
    const b64 = Buffer.from(payload, 'utf8').toString('base64');
    out.write(`\x1b]52;c;${b64}\x07`);
    return true;
  } catch {
    return false;
  }
}

/** Pull the nth fenced code block out of markdown text (1-based). */
export function codeBlockAt(text: string, n: number): { lang: string; code: string; total: number; } | null {
  const blocks: Array<{ lang: string; code: string; }> = [];
  const re = /```([^\n]*)\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(String(text ?? ''))) !== null) {
    blocks.push({ lang: String(m[1] ?? '').trim(), code: String(m[2] ?? '').replace(/\n+$/, '') });
  }
  if (n < 1 || n > blocks.length) return null;
  return { ...blocks[n - 1], total: blocks.length };
}

/** How many fenced code blocks a text carries — for `/copy` hints. */
export function countCodeBlocks(text: string): number {
  return (String(text ?? '').match(/```/g) ?? []).length >> 1;
}

export function clipboardHint() {
  return writers()
    .map((w) => w.command)
    .join(' or ');
}

