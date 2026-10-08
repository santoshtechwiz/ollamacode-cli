/** What the shells and the OS say, in the words they say it in. */

/** "That path is not here." PowerShell, cmd and POSIX rm each have their own. */
const NOT_FOUND =
  /cannot find path|does not exist|no such file or directory|could not find|cannot find the (?:file|path) specified|ItemNotFoundException/i;

/** One list of "unknown command" messages, shared so every hint agrees. */
const UNKNOWN_COMMAND =
  /\bcommand not found\b|not recognized as (?:the|a) name of a cmdlet|is not recognized as the name of|is not recognized as an internal or external command|is not a recognized command|\bnot a name of a cmdlet\b/i;

/** The OS refusing a file another process holds, in any toolchain's wording: sharing violation, access denied, text file busy. */
const FILE_LOCKED = /being used by another process|access (?:to the path .* )?is denied|access denied|os error (?:5|26|32)\b|text file busy|\bE(?:TXTBSY|BUSY|ACCES|PERM)\b/i;

/** A port already held. */
const PORT_IN_USE = /EADDRINUSE|address already in use/i;

/** PowerShell's "At line:N char:N" location marker — decoration, never an absence complaint of its own. */
const PS_ERROR_LOCATION = /^at line:\d+ char:\d+$/i;

/** Every substantive line is an absence complaint, and there is at least one. */
export function everyLineSaysNotFound(text: string): boolean {
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((line) => !PS_ERROR_LOCATION.test(line) && !line.startsWith('+'));
  return lines.length > 0 && lines.every((line) => NOT_FOUND.test(line));
}

export function saysUnknownCommand(text: string): boolean {
  return UNKNOWN_COMMAND.test(String(text ?? ''));
}

export function saysFileLocked(text: string): boolean {
  return FILE_LOCKED.test(String(text ?? ''));
}

export function saysPortInUse(text: string): boolean {
  return PORT_IN_USE.test(String(text ?? ''));
}

/** The lines that carry the lock complaint, for the evidence a recovery shows. */
export function fileLockedLines(text: string): string[] {
  return String(text ?? '').split(/\r?\n/).filter((line) => FILE_LOCKED.test(line));
}

/** The lines that carry the port complaint, for the same reason. */
export function portInUseLines(text: string): string[] {
  return String(text ?? '').match(/.*(?:EADDRINUSE|address already in use).*/gi) ?? [];
}

/** The port a "already in use" message is about, read from the surrounding text. */
export function portFromOutput(text: string): string | null {
  if (!saysPortInUse(text)) return null;
  return /:(\d{2,5})\b/.exec(String(text ?? ''))?.[1] ?? null;
}
