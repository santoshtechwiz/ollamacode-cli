# Changelog

What changed for people using ocode, newest first. Versions follow [semver](https://semver.org).

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
