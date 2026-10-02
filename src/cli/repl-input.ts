export function interruptAction({ busy, armed }: any): { action: 'cancel' | 'arm' | 'exit'; armed: boolean; } {
  if (busy) return { action: 'cancel', armed: false };
  if (!armed) return { action: 'arm', armed: true };
  return { action: 'exit', armed: false };
}

// Detects an image paste (iTerm2/kitty inline-image escapes, OSC 52, or raw base64) so it can be refused with a clear message instead of fed to the model as text it can't read.
// eslint-disable-next-line no-control-regex
const ITERM2_IMAGE_RE = /\x1b\]1337;File=/i;
// eslint-disable-next-line no-control-regex
const KITTY_IMAGE_RE = /\x1b_G[0-9a-zA-Z=,;]+;/i;
// eslint-disable-next-line no-control-regex
const OSC52_CLIPBOARD_RE = /\x1b\]52;[cps][;:]/i;

const IMAGE_PASTE_PROTOCOLS: Array<{ kind: string; re: RegExp; }> = [
  { kind: 'iTerm2 inline image', re: ITERM2_IMAGE_RE },
  { kind: 'kitty graphics', re: KITTY_IMAGE_RE },
  { kind: 'OSC 52 clipboard', re: OSC52_CLIPBOARD_RE },
];

const IMAGE_PASTE_BASE64 = new RegExp([
  String.raw`data:image\/[a-z0-9_.+-]+;base64,`,
  String.raw`iVBORw0KGgo`, // PNG
  String.raw`R0lGOD[dlh]`, // GIF
  String.raw`Qk[0-9A-Za-z]{4,}`, // BMP
  String.raw`\/9j\/[0-9A-Za-z]`, // JPEG
].join('|'), 'i');

export function detectImagePaste(text: string): { kind: string; } | null {
  const raw = String(text ?? '');
  for (const proto of IMAGE_PASTE_PROTOCOLS) {
    if (proto.re.test(raw)) return { kind: proto.kind };
  }
  if (IMAGE_PASTE_BASE64.test(raw)) return { kind: 'inline base64' };
  return null;
}

/** Hold a TTY in raw mode while the REPL owns it; returns the release. On Windows, leaving raw mode while a read is active starts a line-mode read that keeps eating keys (Y/N, Ctrl+C, the prompt) after the next prompt goes raw again. */
export function pinRawMode(stdin: NodeJS.ReadStream): () => void {
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') return () => {};
  const real = stdin.setRawMode.bind(stdin);
  real(true);
  stdin.setRawMode = ((mode: boolean) => (mode ? real(true) : stdin)) as typeof stdin.setRawMode;
  return () => {
    stdin.setRawMode = real;
    real(false);
  };
}
