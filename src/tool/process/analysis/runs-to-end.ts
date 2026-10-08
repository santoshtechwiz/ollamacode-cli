/**
 * A test, lint, build or type-check run: it ends on its own however long it is quiet, and its outcome is its exit
 * code. A local address it prints on the way does not make it a server.
 */
const RUNS_TO_END = [
  // test
  /\b(npm|pnpm|yarn)\s+(test|run\s+test)\b/i,
  /\bjest\b/i,
  /\bvitest\b/i,
  /\bmocha\b/i,
  /\bplaywright\s+test\b/i,
  /\bcypress\s+run\b/i,
  /\bdotnet\s+test\b/i,
  /\bcargo\s+test\b/i,
  /\bgo\s+test\b/i,
  /\bpytest\b/i,
  /\bpython\s+-m\s+pytest\b/i,
  /\b(python[\d.]*|py)\s+-m\s+unittest\b/i,
  /\bmvn\s+test\b/i,
  /\bgradle\s+test\b/i,
  // lint
  /\b(npm|pnpm|yarn)\s+(lint|run\s+lint)\b/i,
  /\beslint\b/i,
  /\btslint\b/i,
  /\bstylelint\b/i,
  /\bdotnet\s+format\b/i,
  /\bcargo\s+clippy\b/i,
  /\bgolangci-lint\b/i,
  /\bflake8\b/i,
  /\bpylint\b/i,
  /\bmvn\s+checkstyle:check\b/i,
  /\bgradle\s+checkstyle\b/i,
  // build
  /\b(npm|pnpm|yarn)\s+(build|run\s+build|ci)\b/i,
  /\bdotnet\s+(build|publish|restore|pack)\b/i,
  /\bmsbuild\b/i,
  /\bcargo\s+(build|check)\b/i,
  /\bgo\s+build\b/i,
  /\bmvn\s+(compile|package|install)\b/i,
  /\bgradle\s+(build|assemble)\b/i,
  /\bdocker\s+build\b/i,
  /\bnext\s+build\b/i,
  /\bvite\s+build\b/i,
  /\bwebpack\b/i,
  /\btsc\b(?!\s+--noEmit)/i,
  // typecheck
  /\b(npm|pnpm|yarn)\s+(typecheck|type-check|run\s+typecheck)\b/i,
  /\btsc\s+(--noEmit|--build)\b/i,
  /\bdotnet\s+build\b/i,
  /\bcargo\s+check\b/i,
  /\bgolangci-lint\b/i,
  /\bmvn\s+compile\b/i,
  // check
  /\b(npm|pnpm|yarn)\s+(check|run\s+check)\b/i,
  /\bdotnet\s+build\b/i,
  /\bcargo\s+check\b/i,
  /\bgo\s+vet\b/i,
];

export function runsToEnd(command: string): boolean {
  return RUNS_TO_END.some((p) => p.test(command));
}
