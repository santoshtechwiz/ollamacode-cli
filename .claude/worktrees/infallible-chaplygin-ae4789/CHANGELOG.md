# Changelog

What changed for people using ocode, newest first. Versions follow [semver](https://semver.org).

## 0.5.0 — 2026-10-05

The agent's turn is now the simple loop other coding agents use: ask the model, run every tool call it makes and
return the real result, stop when it answers in text. Several layers that caused pauses and corrupted files are gone.

### New
- **Subagents side by side**: research and review subagents asked for in one reply run at the same time; coding
  subagents still run one at a time. Each one's lines are labelled (`research 1 › Read(...)`), and approvals they
  ask for are shown one after another.
- **`code_review` on existing code**: `all: true` reviews every file under a path, with or without git; when nothing
  changed since the last commit it says so and asks whether to review the existing code.

### Changed
- **`edit_file`** is search and replace on a file the model has read: `search` and `replace`, one change per call
  (`search` is matched exactly, else ignoring whitespace, and the result says so). The `edits` array, `symbol`,
  `line_start`/`line_end` and `insert_at_line` are gone. When `replace` writes again lines that already followed the
  match, the result's first line says which lines now appear twice.
- **Each model samples at its own temperature**: ocode no longer sends 0.2 to every model (gpt-oss ships 1.0, and
  reasoning models loop at low temperatures). `agent.temperature` still sets one.
- **`write_file`** replaces a file the model has read, instead of refusing every existing file.
- A turn stops early only on an explicit denial or policy refusal (that action is not tried again that turn), or on
  the same call three times in a row. No extra request is sent to get a closing summary.
- `code_review` puts check results and findings before the file list, and calls the compile check of .NET, Go and
  Rust projects **build**, not typecheck.

### Fixed
- Approval and `ask_user` prompts read what you type again (a `y` was recorded as declined, a menu's Yes as No), and
  the approval prompt is printed once.
- An edit or write that would break an XML project or config file (`.csproj`, `.props`, `.config`, `.xml`), a YAML
  file or a Terraform/HCL file (`.tf`, `.tfvars`, `.hcl`) is refused, as broken code already was.
- `/init` on an existing OLLAMACODE.md writes the whole updated file instead of patching it section by section, which
  left several copies of every section. It also sees every project in the workspace, not only the root folder, so a
  Node.js or Terraform project in a subfolder is described, and adding one marks the doc as out of date.
- A search that matches several places, or none, is named as the whole block, not just its first line.
- A turn you stop with Esc is no longer reported as "the model finished without saying what it did".
- Hints for a wrong tool call only ever suggest a call that would succeed.
- `code_review` runs `test_command` in the reviewed project's folder, and no longer lists `.git`, `bin` or `obj`
  files as changes.

## 0.3.0 — 2026-10-02

### New
- **Background jobs**: a server, watcher or long build runs in the background and the agent is told when it ends,
  with its last lines of output; a quick job still finishes in the foreground.
- **`run_script`** for scripted analysis and **`code_review`** for reviewing changes with the project's own lint,
  typecheck and tests (Python, C#, Go, Java, Rust, JavaScript/TypeScript).
- **Files**: read PDF and Excel files, and create them.
- **Web**: parallel search, page fetches aimed at the question, live news, weather and quotes with their time.
- **Token usage** in the footer and `/usage`; a coding rating when a model is chosen.
- **Tools on demand**: rarely used tools are loaded when needed, and long tool results are compressed.
- **Autocomplete** for commands and file names; a full context window is recovered by compacting history.

### Better
- The agent no longer redoes work: the request stays where it was asked instead of reappearing after each result,
  and a repeated build or search that finds nothing new ends the turn with a summary.
- Much less context per request: earlier turns' tool output and file bodies are sent in short form, and only the
  toolchains the workspace's projects use are described.
- A turn that hits its step limit ends with an account of what was done; a cut-off answer can be continued.
- Plan mode looks before it plans, shows progress from real file changes, and ends with a summary.
- The task list belongs to its task; mode switches are announced once; `/continue` resumes only when asked.
- Math and tables read cleanly in the terminal.

### Fixed
- A command such as `Stop-Process -Name node` can no longer end the session by stopping ocode itself.
- `ask_user` can ask again in later turns.
- Background job results are not lost when a turn is cancelled or fails; stopping your own dev server is not
  reported as a crash.
- An unanswered approval no longer hangs the session; files outside the workspace can be read once approved.
- A program's real exit code is kept when PowerShell runs it; Windows paths in reviews.
- `ocode init` no longer wipes the project's last conversation.
- The .NET build output (`bin/`, `obj/`) is no longer indexed; the debug log is far smaller.

## 0.2.4

Earlier releases were published without a changelog.
