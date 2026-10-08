import { cyan, yellow, dim } from './ansi';

export const fmtPath = (s: string) => cyan(s);

export const fmtCommand = (s: string) => yellow(s);

export function highlightFileLineRefs(text: string): string {
  return String(text ?? '').replace(
    /(\b[A-Za-z0-9_][\w./\\~-]*\.\w+):(\d+)(?::(\d+))?\b/g,
    (_m, file, line, col) => {
      const loc = line ? dim(':') + yellow(line) : '';
      const c = col ? dim(':') + yellow(col) : '';
      return `${cyan(file)}${loc}${c}`;
    }
  );
}

export function formatShellPreview({ shell, cwd, command }: any): string {
  return `${dim('shell')} ${fmtCommand(shell)} ${dim(cwd)}\n  ${fmtCommand('>')} ${fmtCommand(command)}`;
}

