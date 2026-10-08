// A command that detaches its program (cmd's `start`, Start-Process, nohup, a trailing `&`) leaves it running where
// ocode cannot see it, stop it or read its output — an orphan that keeps its port. exec_shell background: true runs a program in
// the background and keeps it tracked, so a detaching command is refused and pointed there.

/** The command's own segments, with `cmd /c "…"` and `powershell -Command "…"` wrappers opened up. */
function segments(command: string): string[] {
  const out: string[] = [];
  const split = (text: string) => {
    let current = '';
    let quote: string | null = null;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (quote) {
        current += ch;
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        current += ch;
        continue;
      }
      if (ch === ';' || ch === '|' || ch === '&') {
        // A lone trailing `&` is itself the detach, so it stays visible on the segment before it.
        const lone = ch === '&' && text[i + 1] !== '&' && text[i - 1] !== '&';
        if (lone && !text.slice(i + 1).trim()) current += ' &';
        out.push(current);
        current = '';
        if ((ch === '&' || ch === '|') && text[i + 1] === ch) i += 1;
        continue;
      }
      current += ch;
    }
    out.push(current);
  };
  split(command);
  // Open one level of wrapper: the program a shell is told to run is what decides.
  return out.flatMap((segment) => {
    // PowerShell flags before -Command may take a value (-ExecutionPolicy Bypass).
    const wrapped = /^\s*(?:cmd(?:\.exe)?\s+\/[ck]|(?:powershell|pwsh)(?:\.exe)?(?:\s+-(?!c(?:ommand)?\b)\w+(?:\s+(?!-)[^\s"']+)?)*\s+-c(?:ommand)?)\s+(["']?)([\s\S]*)\1\s*$/i.exec(segment);
    if (!wrapped) return [segment];
    const inner: string[] = [];
    const saved = out.length;
    split(wrapped[2]);
    inner.push(...out.splice(saved));
    return inner;
  }).map((s) => s.trim()).filter(Boolean);
}

/** Why the command would detach a program from ocode, or null when it does not. */
export function detachReason(command: string): string | null {
  for (const segment of segments(String(command ?? ''))) {
    // `start https://…` only opens a page in the browser: nothing of the project's keeps running.
    // `start /wait` and `Start-Process -Wait` wait for the program (an installer, an elevated step): nothing is left behind.
    if (/^start(?:\s|$)/i.test(segment) && !/^start\s+(?:""\s+)?https?:\/\//i.test(segment) && !/\s\/wait\b/i.test(segment)) return "cmd's start runs the program detached";
    if (/^(?:Start-Process|saps)\b/i.test(segment) && !/\s-Wait\b/i.test(segment)) return 'Start-Process runs the program detached';
    if (/^(?:nohup|setsid|disown)\b/.test(segment)) return `${segment.split(/\s+/)[0]} detaches the program`;
    if (/\s&$/.test(segment)) return 'a trailing & runs the program detached';
  }
  return null;
}
