# Language-aware editing: design notes

How to make `edit_file` understand code in any language, and which npm packages to use. Written 2026-09-24, after the guard rework (`CallLedger`) and the "write_file only creates" change.

## Where we are today

- **`edit_file`** does search/replace. It matches `search` exactly, then falls back to whitespace-normalized matching (`src/tool/filesystem/_match.ts`), and applies the splices with `magic-string` (`_edit-apply.ts`). It knows nothing about the language.
- **`write_file`** only creates files or appends to them. An overwrite of an existing file is skipped, and the model is handed the equivalent `edit_file` call, computed from the LCS line diff in `src/ui/diff.ts`.
- **Guards** (`src/agent/turn/engine/guards.ts`, `ledger.ts`) decide from content hashes and tool metadata (`volatile`, `dangerReason`, `wouldWrite`). No regex scans code any more; the old `definedNames` regex was removed because it misfired.

What's missing: nothing checks that an edit leaves the file **syntactically valid**, and the model can't address code **by structure** ("replace function `foo`"). It can only copy text verbatim.

## Recommendation, in order of value

### 1. Syntax check after every edit: `@vscode/tree-sitter-wasm` ✅ done

This is the highest value for the least risk, and it works the same for every language.

- `@vscode/tree-sitter-wasm` (0.3.x) bundles the tree-sitter WASM runtime *and* the grammars VS Code ships (C#, Python, JS/TS/TSX, Go, Rust, Java, Ruby, PHP, C++, CSS, Bash, Powershell). No native build step, so it works on Windows without node-gyp. Chosen over `web-tree-sitter` + `tree-sitter-wasms` because it is one dependency with matching runtime/grammar ABIs — no version-pinning dance.
- Implemented as `syntaxBreak(rel, before, after)` in `src/tool/filesystem/_syntax.ts`: one extension→grammar table, one lazily-booted runtime, one cached Parser per grammar (concurrent checks in different languages can't race on `setLanguage`). Trees and cursors are deleted after each parse.

Rule to implement: parse the file before and after the edit. **Refuse the edit if it adds syntax errors the file didn't already have** (compare the counts of ERROR/MISSING nodes, before vs after). Counting against "before" means a file that was already broken never blocks a fix. The refusal hint should say where the new error is (line and column from the node) so the model can correct its `replace`.

Where it goes (done):
- in `edit_file`'s async `openEdit` (shared by `cannotRun` and `execute`), so a broken edit is refused before the approval prompt. `dryRunEdit` stays sync — the ledger's `wouldWrite` hash preview calls it and can't await WASM;
- as the same check in `write_file`'s `cannotRun` (create path) and `execute` (create + append).

Retired as subsumed by the parse: the stray-escape scanner (`hasStrayEscapeLiteral` — a literal `\n` outside a string is a syntax error with a line number now) and the C#/Java-only signature regex (`nearbySignatures`, replaced by parse-based `nearbyDefinitions` in the same module — the read half of option 2, no ast-grep needed for hints).

Caveats:
- The bundle has no JSON/YAML/TOML grammars, so those extensions skip the check. JSON is already covered by `validateJson`; YAML gets its own handling under option 4.
- Map a file to its grammar by extension, from one table next to the parse call. Unknown extensions and shebang-less files skip the check. Never block an edit because a grammar is missing.

### 2. Structural addressing: tree-sitter queries ✅ done, no ast-grep

The query-first bet paid off: `findSymbolRanges(rel, content, symbol)` in `_syntax.ts` walks the same parses option 1 already loads — field-based name lookup (`name` field, identifier fallback), dotted `Class.method` matched against definition ancestors. No second dependency.

- `edit_file` accepts `symbol` as an alternative to `search` (schema `requiredOneOf` extended, top-level and per batch item). Resolution synthesizes the definition's exact bytes as `search`, so matching, overlap checks, and the JSON/syntax guards apply unchanged. Whole-line widening covers the node's skipped indentation; `line_start` disambiguates same-named definitions with the same semantics as `search`.
- Limitation, shared with any structural tool: on already-broken code the parse may assign lines elsewhere (e.g. a body at the def's own indent belongs to the enclosing block, not the def), so the replace can duplicate rather than fix. The syntax guard still bounds the damage; quoting via `search` is the fallback the failure hints point at.

### 3. Fuzzy matching when exact search fails: `@sanity/diff-match-patch` ✅ done

- `@sanity/diff-match-patch` (3.2.x) is the maintained fork of Google's diff-match-patch. Its v3 API is a functional `match(text, pattern, loc, { threshold, distance })` (not the old `match_main` method).
- Implemented as `fuzzyLines(content, search, nearLine)` in `_match.ts`, called from the `ENOMATCH` hint builder: the search's first non-blank line (clipped to 32 chars — Bitap throws above that; skipped under 8 as noise), threshold 0.3, search biased at the token-best line so the distance penalty can't hide the target. Returns a line span quoted as "did you mean lines 40–52?" — never applied, only suggested, and skipped when it collapses onto the already-shown preview.

### 4. Structured formats: edit the data, not the text ✅ done

- **JSON / JSONC:** `jsonc-parser` (Microsoft, 3.3.x). `json_patch` keeps its ops, pointer forms, messages and codes, but the engine is now `modify()` + `applyEdits()`: one key changes, comments/formatting/trailing commas survive (tsconfig.json works now — it used to be refused outright), and diffs are minimal instead of whole-file rewrites. A typed pre-walk (`locate`) keeps the old errors, because `modify` alone throws on numeric strings, silently appends past array ends, and no-ops on missing remove targets. Deliberate change: setting through a primitive is now refused instead of silently overwriting it.
- **YAML:** `yaml` (2.9.x). New `yaml_patch` tool mirroring `json_patch` (get/set/remove, same pointer forms, same result shapes) on the Document API (`parseDocument` → `getIn`/`setIn`/`deleteIn` → `toString`), so comments and ordering survive. Registered, previewable, classified mutating, and covered by undo like the other file writers.

### 5. Unified-diff input: `diff` (jsdiff)

- `diff` (9.x): `applyPatch` / `structuredPatch` with a `fuzzFactor`. It's only worth adding if we ever accept patches in the `apply_patch` style from models trained on that format. `src/ui/diff.ts` already covers our own line diffs, so don't add it just for diffing.

## What not to do

- **Native `tree-sitter` (node-gyp).** Build pain on Windows; the WASM runtime is enough.
- **Per-language AST libraries as the core** (ts-morph, recast, babel, Roslyn bridges). Every one is a separate stack; tree-sitter covers them all with one API.
- **Language servers (LSP) inside the edit path.** Starting and synchronizing a server per language is heavy and slow. LSP is for rename-symbol or find-references features later, not for validating an edit.
- **A wrapper module or registry around any of these.** Call the library inline in the tool that uses it (see the "thin library integration" rule): one module-level lazy loader, and no `LanguageService` class.
- **Silent fuzzy applies**, or auto-fixing the model's edit. Refuse with a precise hint, and let the model send the corrected call.

## Suggested order of work

1. ~~Add the `web-tree-sitter` syntax check in `edit_file` and `write_file` (option 1).~~ Done via `@vscode/tree-sitter-wasm` (`_syntax.ts`), smoke-tested on TS/Python/C#/Go. Remaining: live `ocode` runs in `ocode-lab` measuring fewer `ENOMATCH` failures in `~/.ollamacode/logs`, and no whole-file rewrites.
2. ~~Add the `@sanity/diff-match-patch` "did you mean" hint on `ENOMATCH` (option 3).~~ Done (`fuzzyLines` in `_match.ts`, suggestion-only).
3. ~~Try `symbol` addressing with a tree-sitter query (option 2). Add ast-grep only if queries fall short.~~ Done — queries sufficed, ast-grep not added.
4. ~~Move `json_patch` onto `jsonc-parser`, and add YAML handling with `yaml` (option 4).~~ Done — `json_patch` re-engined, `yaml_patch` added.

Measure each step with live runs, not unit tests. The test suite was removed on purpose. The measure: fewer `ENOMATCH` failures in `~/.ollamacode/logs`, and no whole-file rewrites.

## Correct error details: tree-sitter-verified diagnostics

Regex-parsed diagnostics (`parseDiagnostics`) are guesses: the file may not exist, the line may be out of range, and the location may name logging boilerplate rather than the fault. `verifyDiagnostics` (`src/env/diagnostics/verify.ts`) checks each one against the parse before the model ever sees it:

- Drop locations that are provably wrong (the file reads and the line is outside it). Unreadable files, missing grammars, and parse failures keep the diagnostic — only a verified miss is dropped.
- Attach the enclosing block via `symbolAtLine` (`_syntax.ts`): the innermost definition, or the first string argument of a test-like call (`it('creates a user', …)` → "creates a user"). Rendered as `tests/api.test.js:5:24: failure: … (in \`creates a user\`)` and carried into the failure headline, so the first line the model reads names the place, not just "exited with code 1".

Hooked into both readers of command output: `exec_shell` (the model path) and the interactive `!` shell (the human path).
