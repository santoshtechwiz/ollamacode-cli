# ollamacode

A coding agent for your terminal that runs on models you choose. Point it at a
local Ollama install, Ollama Cloud or Hugging Face, and it will read your code,
make edits, run commands and use git, asking you before it changes anything.

> **Not an official product.** `ollamacode` (`@ollamacode/cli`) is an
> independent project. It is not affiliated with, endorsed by or sponsored by
> Ollama, Hugging Face or Meta. Their names and model names belong to their
> owners and are only used here to say what this tool connects to.
>
> **Experimental.** I built this to learn how a local-model coding agent works:
> how the context window gets budgeted, how permission prompts are enforced, how
> you stop an agent from going in circles. It is not finished. Please read the
> [terms](#terms) before using it on anything important.

## Install

```sh
npm install -g @ollamacode/cli
ocode init
ocode
```

`ocode init` looks for a running Ollama or asks for a token, then lets you pick
a model. After that, run `ocode` inside any project.

## Using it

```sh
ocode                                    # continue the last session or start a new one
echo "list files in src/" | ocode        # one-off task, same chat underneath
echo "explain foo" | ocode --no-tools    # plain answer, no tool calls
```

Ask for things the way you would ask a teammate: "add error handling to the
login route", "why is this test failing", "rename `foo` to `bar` everywhere".
Before it edits a file, writes one, runs a shell command or does a git write, it
asks you. Pass `--yes` if you would rather not be asked.

Besides code, it can search the web, read a web page, read or create PDF and
Excel files (`.pdf`, `.xlsx`), run servers in the background, and hand parts of
a task to subagents. The [feature guide](#feature-guide) below shows how. A file
outside the project folder works too; you approve it once and it stays open for
the session.

## Feature guide

Each part below says what the feature does, how to start it, and an example to
try. You can always just describe what you want; the examples show wording that
works well with smaller models.

### Modes: agent, plan, ask, review

`Shift+Tab` (or `Ctrl+G`) cycles **Agent → Plan → Ask**. The current mode shows
under the prompt.

| Mode | What it does | Start it |
| --- | --- | --- |
| Agent | Reads, edits, runs commands. Asks before anything risky. | default |
| Plan | Looks around without changing anything, then shows a plan for you to approve | `Shift+Tab`, `/plan`, `ocode --plan` |
| Ask | Answers questions, changes nothing | `Shift+Tab`, `/ask` |
| Review | Reads and reports problems, changes nothing | `/review`, `ocode --review` |

`/plan off`, `/ask off` and `/review off` go back to Agent.

### Plan mode

Use it for anything bigger than a one-file change.

1. Switch to Plan and describe the task:
   `add rate limiting to the API routes, with a test for it`
2. ocode looks at the code; anything that would change a file or run a command is
   refused until you approve. It then presents its plan and asks whether to start.
3. Approve it, answer with the changes you want, or say "Not yet".
4. Once approved it switches to Agent and the same turn carries the plan out,
   keeping a task list as it goes.

If the work stops part way (the step limit, you pressed `Ctrl+C`), `/continue`
picks it up.

### Subagents

A subagent is a helper that the agent starts for one self-contained task. It
works in its own fresh conversation, so long searches or reviews don't fill up
the main one, and it reports back when done. You see its tool calls in the chat
between a "subagent started" and a "subagent finished" line.

| Role | Can do | Steps | Time |
| --- | --- | --- | --- |
| `research` | read the project, search the web; changes nothing | 20 | 5 min |
| `review` | read code and report problems with file and line; changes nothing | 20 | 5 min |
| `coding` | make a focused change and check it | 25 | 8 min |
| `test` | run or write tests and report what passed and failed | 15 | 8 min |

Ask for one by name:

```text
use a research subagent to find where the app reads its configuration
use a review subagent to review src/auth for bugs and security problems
use a coding subagent to add a /health endpoint, then run the tests
use a research subagent to find the current Python release and when it reaches end of life
```

Good to know:

- One turn can start at most **3** subagents. A fourth is not started; the
  agent does that part itself.
- A subagent can't ask you questions or start subagents of its own. Approvals
  still come to you, and its time limit pauses while you decide.
- If it runs out of steps or time, you get one yellow ⚠ line, and the agent is
  told what it reported (or which files it had read) so it doesn't start over.
- File changes a subagent makes are real; `/undo` can put them back.
- Subagents are on by default. To turn them off:
  `ocode config set agent.subagents false`.

**Roles of your own.** Add them under `agent.subagentRoles` in
`~/.ollamacode/config.json`; only `instruction` is required:

```json
{
  "agent": {
    "subagentRoles": {
      "security": {
        "summary": "reviews code for security problems",
        "instruction": "Look for injection, leaked secrets and unsafe input handling. Report each with file and line."
      },
      "docs": {
        "summary": "updates documentation to match the code",
        "instruction": "Update README and docs to match the current code. Change only documentation files.",
        "readOnly": false,
        "maxIterations": 25
      }
    }
  }
}
```

A custom role is read-only unless it sets `"readOnly": false`, and gets 15
steps and 5 minutes unless it says otherwise (at most 8 minutes). `also` adds
tools on top of the read-only set, for example `["web_search", "web_fetch"]`.
A role with a built-in's name replaces it. New roles apply from the next start.

### Skills

A skill is a set of step-by-step instructions for one kind of work. The agent
sees the list of skills (name and one line each) and loads one when the work
calls for it. You don't need to ask for it by name:

```text
make a landing page for my bakery
the settings page looks cramped on phones, fix it
```

ocode ships with one skill:

| Skill | For | What it does |
| --- | --- | --- |
| `ui-ux` | building, reviewing or fixing a web UI | asks which stack and folder for a new site instead of assuming React; uses your project's theme (or its starter `tokens.css`) instead of one-off values; checks layout, spacing, type, color, forms, loading/empty/error states and accessibility; then verifies with the build and `check_page` |

When the agent reads or edits a file a skill covers (`.html`, `.css`, `.tsx`,
`.vue` … for `ui-ux`), it is reminded once per turn that the skill exists. The
reminder points at the skill; loading it is the agent's call, because a `.tsx`
file can be plain logic.

**Skills of your own.** A skill is a folder with a `SKILL.md`:

```markdown
---
name: api-design
description: designing or changing an HTTP API
paths: ["src/routes/**", "openapi.yaml"]
---
1. Read the existing routes and follow their naming, status codes and error shape.
2. ...
```

`paths` is optional. Other files in the folder (templates, references) can be
read through the skill. Skills are read from, in order (a later one replaces an
earlier one with the same name):

1. the skills that ship with ocode;
2. `~/.ollamacode/skills/<name>/SKILL.md`, yours in every project;
3. `.ocode/skills/<name>/SKILL.md` in the project, which you can commit and share.

Skills are read when ocode starts, so a new or changed skill applies from the
next start.

### Web search and web pages

The agent can look things up and read pages:

```text
what are today's top 5 tech news stories?
what is the weather in Berlin right now?
what is the AAPL share price and the USD to EUR rate?
read https://nodejs.org/en/about/previous-releases and tell me when Node 20 ends support
```

Searches pick a source by kind of question: general, news, weather, stock,
crypto or currency (see [Outside services](#terms) for which services). Page
reads take only the sections that match what was asked, so a long page doesn't
flood the conversation.

### PDF and Excel files

Read, search and create documents:

```text
summarize docs/spec.pdf
find every mention of "refund" in contracts/terms.pdf
read pages 3-5 of report.pdf
what is in the "Costs" sheet of budget.xlsx?
make report.pdf with a short summary of this project
make projects.xlsx with a table of the projects in this folder and their languages
```

Reading a large file returns an overview first; a search returns only the
matching passages or rows, with page or row numbers. New PDFs and spreadsheets
are written from markdown: each table becomes its own sheet in Excel.

Excel support uses the optional `xlsx` package, downloaded from
`cdn.sheetjs.com`. If your network blocks that site, ocode still installs and
runs, PDFs still work, and spreadsheet requests say the package is missing.

### Checking web pages

The agent can open a page in a headless browser and see what is wrong with it,
so a web UI change is checked rather than guessed at:

```text
start the dev server and check the settings page on mobile
check index.html for accessibility problems
```

`check_page` opens a URL (a running dev server) or a static `.html` file at
mobile (375px), tablet (768px) and desktop (1280px) widths and reports:

- sideways scrolling, and the elements that stick out past the screen edge;
- accessibility problems from [axe-core](https://github.com/dequelabs/axe-core)
  (WCAG 2.2 A/AA): contrast, missing labels and alt text, small tap targets;
- uncaught script errors;
- images, scripts, styles or data that failed to load.

The same problem at several widths is reported once, naming the widths. From
the shell: `node scripts/check-page.mjs index.html` (exit 1 when it finds
errors). It
uses the optional `playwright-core` and `axe-core` packages and a Chromium
browser: run `npx playwright install chromium` once, or have Chrome or Edge
installed. Without them ocode runs as usual and only page checks say they are
unavailable.

### Running programs and servers

Ask it to run things the way you would type them:

```text
run the CLI with --help and show me the output
start the dev server, then call /health on it
stop the server
```

A command that finishes quickly returns its output straight away. A server, a
watcher, or anything still running after a few seconds (a first build that is
still compiling, say) carries on in the background, and the chat says so. When
it ends, its output shows up in the chat and goes to the agent on its own; you
don't need to type anything. A long command asks after 2 minutes whether to keep
waiting.

### Checks after every edit

Have ocode check the agent's work whenever it changes files, so it cannot say "done" over code that does not build:

```sh
ocode config set agent.afterEdit check
```

`check` is each project's own compile check, detected from the project, so one setting works across a workspace
with different kinds of projects:

| Project | `check` runs |
|---|---|
| TypeScript | its `typecheck` script, or `npx tsc --noEmit` |
| Python | `python -m compileall -q` over the project (every file parsed, none run; virtualenvs skipped) |
| C# / .NET | `dotnet build` |
| Rust | `cargo check` |
| Go | `go vet ./...` |
| Terraform | `terraform validate` |
| JavaScript | its `typecheck` or `lint` script, if it has one |

A project with no check is skipped, and the agent is told so. `test`, `build` and `lint` work the same way with
each project's tests, build or linter. Name several to run them in order:

```sh
ocode config set agent.afterEdit "check lint"
```

`lint` runs on only the files that step changed when the project's linter takes files (ESLint, `ruff check`), so it
stays fast enough for every step. Framework files are included when their ESLint plugin is installed: `.vue` (eslint-plugin-vue),
`.svelte` (eslint-plugin-svelte), `.astro` (eslint-plugin-astro), Angular templates (angular-eslint). Or give a
command of your own:

```sh
ocode config set agent.afterEdit "npm test"
```

Any command works: a test suite, a linter, a type check (`npm run lint`,
`pytest -q`, `go vet ./...`, `dotnet build`). It runs once after each step that
changed files, in the folder of the project those files belong to (the nearest
folder with a `package.json`, `go.mod`, `Cargo.toml`, `.csproj` and so on), so
one global setting works across projects. It shows up as a normal tool line,
and its result goes to the model with that step, so a failing test gets fixed
straight away instead of at the end. It runs without asking because you
configured it.
`ocode config unset agent.afterEdit` turns it off.

### A check before "done"

A type check after each edit cannot see everything: a Next.js page that uses `new Date()` while prerendering, or
an image host missing from `next.config`, passes `tsc` and still fails. A build catches both, but is too slow to
run after every step. `agent.beforeDone` runs once when the agent answers:

```sh
ocode config set agent.beforeDone build
```

It runs only when files changed since it last ran, in each changed project's folder, and takes the same words
(`check`, `build`, `test`, `lint`, several at once) or a command of your own. If it fails, the agent reads the
failure and keeps working instead of saying "done"; when it can't fix it and changes nothing more, its answer
stands, so a failure it can't fix never loops. `ocode config unset agent.beforeDone` turns it off.

Each check has a time limit: 90 seconds after an edit, 5 minutes before "done". A check that runs out of time is
stopped and reported as unfinished, not as a failure the agent must fix. `ocode config set agent.checkTimeoutMs
180000` changes both. A linter or type check can be slow on a large project (a first ESLint run over a Next.js app
on Windows can take minutes), so keep the fast check after each edit and the slow ones for the end:

```sh
ocode config set agent.afterEdit check
ocode config set agent.beforeDone "lint build"
```

### Git

```text
what changed since the last commit?
write a commit message for the staged changes
commit this with a good message
```

Reading git is free; anything that writes (commit, checkout, reset) asks first.

### MCP servers

MCP servers add tools from other programs (a browser, documentation lookups,
and so on). Add a remote one by URL:

```sh
ocode mcp add https://example.com/mcp
ocode mcp           # list servers
ocode mcp --check   # connect to each and report
```

Or add a local one to `mcpServers` in `~/.ollamacode/config.json`:

```json
{
  "mcpServers": [
    { "name": "playwright", "command": "npx", "args": ["@playwright/mcp@latest"] }
  ]
}
```

Their tools are loaded when the agent first needs them. `/mcp` shows what is
connected.

## Sessions

Each project keeps its most recent conversation, so closing the terminal loses
nothing. Run `ocode` in the same folder and it asks whether to pick up where you
left off.

```sh
ocode -c       # continue without asking
ocode --new    # start fresh
```

Each project keeps its 10 most recent sessions, each named by its first
question. Starting a new one, or running `/clear`, keeps the old one:

```text
/sessions       # list them, newest first
/sessions 3     # carry on the third one in this window
```

At startup you can also pick **Choose an earlier session**. When the last
session is more than 6 hours old or very long, **Start new session** is the
default (Enter) instead. A resumed session starts with default permissions, so
anything that changes files asks again.

Start a new session when you switch to an unrelated task. Old questions are
sent along with new ones, so a long session makes replies slower and can
confuse a small model.

**When the context fills up.** Earlier exchanges are sent with each request up
to about 16,000 tokens (`agent.contextBudget` changes this). Beyond that the
oldest messages are trimmed automatically; they stay in the session file but
the model no longer sees them. You are told twice:

```text
Context is 85% full. When it fills, the oldest messages are trimmed automatically; type /compact to do it now, or /clear to start fresh.
Context trimmed to fit: the 42 oldest messages are no longer sent to the model (still kept in the session). ...
```

`/compact` trims straight away: your latest request and its work stay, older
tool output is cleared, and the oldest messages go. `/compact summary` first
asks the model for a short summary of what is removed (requests, decisions,
files changed, what is still open) and keeps that for the model; worth it with
a capable model. `/context` shows the numbers.

## Pointing at files

Type `@` to add a file to the conversation:

```text
@src/index.js
@"path with spaces.js"
@src/                   # lists the folder
```

`Tab` completes the path. If you don't remember it, `/find <text>` (or `/f`)
searches the project.

## Commands

| Command | What it does |
| --- | --- |
| `/help` | list commands, or details for one |
| `/sessions` | list saved sessions; `/sessions <n>` carries one on |
| `/status` | session, model and settings |
| `/provider` | switch provider |
| `/model` | switch model |
| `/tools` | turn tool calling on or off |
| `/permissions` | ask, always or never for risky tools |
| `/plan` | plan mode: propose first, change after you approve; `/plan off` leaves it |
| `/continue` | carry on with work that stopped part way or a cut-off answer |
| `/ask` | answer questions, change nothing |
| `/review` | read and report, change nothing |
| `/think` | how much of the model's reasoning to show |
| `/verbose` | show full tool output instead of a summary |
| `/find <text>` | find a file by name |
| `/open <path>` | page through a file |
| `/show` | print the last tool output in full |
| `/copy` | copy the last answer, a code block or a file |
| `/editor` | write a long message in your editor |
| `/shell <cmd>` | run a shell command yourself (or `!<cmd>`) |
| `/debug` | explain the last failed command |
| `/undo` | put back a file the agent changed this session |
| `/init` | write or update `OLLAMACODE.md` for the project |
| `/memory` | list, add or forget remembered notes |
| `/reindex` | rebuild the workspace index |
| `/mcp` | configured MCP servers |
| `/compact` | trim the conversation now, keeping the latest exchanges |
| `/context` | how full the context window is |
| `/usage` | tokens sent and received this session |
| `/color` | terminal colour mode |
| `/clear` | start a new session (the old one is kept) |
| `/exit` | save and quit |

Keys: `Ctrl+O` shows the last file read, `Ctrl+T` the last tool output, `Esc`
closes them. `Ctrl+C` stops the current turn (twice to quit), `Ctrl+L` clears the
screen and keeps what you typed, `Shift+Tab` switches mode, `Tab` completes
commands and paths.

Typing the word "continue" is an ordinary message. `/continue` is what picks up
unfinished work.

A plan lives in the session that made it. When its work is done it ends with a
short summary (steps done, files changed, commands run, anything left undone)
and is removed; nothing carries into the next session.

## Project notes

`ocode` reads `OLLAMACODE.md` (written by `/init`) and your own notes in
`.ollamacode/CONVENTIONS.md` at the start of every turn. Use them for things you
don't want to repeat:

```sh
ocode memory add "run npm test before saying you're done"
```

Inside a chat that is `/memory add ...`. You can also edit
`.ollamacode/CONVENTIONS.md` directly. `ocode memory show` lists what is stored
and `ocode memory forget <n>` removes an entry. Changes apply on the next turn,
no restart needed.

These notes are instructions to the model, not rules it can't break. Small
models forget them more often, especially on long tasks.

## Settings

Tokens can go in a `.env` file in your project. Real environment variables take
priority.

```sh
HF_TOKEN=hf_...
OLLAMA_API_KEY=...
```

Everything else lives in `~/.ollamacode/config.json`:

```sh
ocode config                       # show settings (tokens hidden)
ocode config get activeProvider
ocode config set toolsEnabled false
ocode config path                  # where the file is
```

Reply size is worked out per model: by default a reply may use up to 40% of the
context, at most 32,768 tokens. If a provider says a model allows less, ocode
uses that limit straight away and remembers it in
`~/.ollamacode/model-limits.json`.

On a slow or CPU-only machine, the two settings that matter most are
`agent.contextWindow` (default 32768) and `agent.maxTokens` (default 512).
Smaller means faster, at some cost in quality. You can also set them for one run:

```sh
echo "..." | ocode --ctx 8192 --max-tokens 256
```

On Windows you can run every shell command the agent starts under a restricted
token: set `permissions.shellSandbox` to `read-only` or `workspace-write`
(default `none`). This is your choice; the model cannot turn it on or off.

If you have a GPU and Ollama doesn't seem to use it, see [ollama.md](ollama.md).
One environment variable made things about five times faster on my machine.

## Providers

**Ollama (local).** No token. Install Ollama, `ollama pull` a model and keep the
daemon running; `ocode` finds it on the usual port.

**Ollama Cloud.** The same models, hosted, so you don't need a GPU. Get a key at
[ollama.com/settings/keys](https://ollama.com/settings/keys).

```sh
ocode init --provider ollama-cloud --token <key>
```

**Hugging Face.** Hosted inference, much faster than a local CPU. You need a
token with Inference Providers enabled, from
[huggingface.co/settings/tokens](https://huggingface.co/settings/tokens).

```sh
ocode init --provider hf --model openai/gpt-oss-20b --token hf_...
```

Tokens are saved with restricted file permissions, hidden in output, and never
passed to commands the agent runs.

## What it's good at, and what it isn't

These are observations from my own use on one machine, not benchmarks.

Good fits:

- **Tasks you can check quickly.** A rename across a few files, a failing test,
  a missing error case. When you can verify the result in seconds, a small
  model is genuinely useful.
- **Keeping code on your machine.** With local Ollama nothing leaves your
  computer except web lookups the agent makes. There is no telemetry and no
  update check.
- **A 7B coding model on a machine with a GPU.** That is what the prompts and
  safeguards were tuned for. [ollama.md](ollama.md) has timings from one such
  setup.
- **Long conversations.** Older history is trimmed when it fills up (and you
  are told), so a long session keeps going instead of failing.
- **Setup work in common stacks** like Node, Python, Rust, Go, .NET, Terraform
  and git. Adding a test runner or a build script is a good first try.

Poor fits:

- **Big refactors across files the agent hasn't read.** The window is limited
  and summaries lose detail, and a small model tends to guess instead of saying
  it doesn't know. Name the important files with `@`.
- **Models without tool-calling support.** There is a text-mode fallback, but it
  is much less reliable. `ocode doctor` tells you when a model lacks it.
- **Anything costly or hard to undo**, such as migrations, deploys, secrets or
  production data. The permission prompt slows things down; it doesn't review
  anything.
- **Output you don't read.** The agent can still pick the wrong file. Check the
  diff.

**Which model?** Start with `qwen2.5-coder:7b`, which is what `ocode init`
suggests. Smaller models misread requests, send broken tool calls, repeat
themselves and stop early. Much bigger ones won't fit in GPU memory and get very
slow. `ocode models` lists what you have and `/model` switches mid-session.

For cloud use, these are the models I tested with:

```text
gemma4:31b
gpt-oss:120b
gpt-oss:20b
nemotron-3-nano:30b
nemotron-3-super
nemotron-3-ultra
```

### How models behave

What I saw running the same tasks through different models. These are
observations from a handful of runs, not benchmarks.

- **gpt-oss (20b and 120b)** fills in every optional tool setting, often with an
  empty value or a guess (`path: ""`, `filename: true`). ocode treats an empty
  optional value as "not set", so most of these no longer cost a step. It
  sometimes names tools as `functions/read_file`; ocode reads that as
  `read_file`. Asked only for a summary, it still tries to call tools, so the
  summary request sends the history as plain text. It sometimes asks for the
  same search again after it already has the answer; the turn then stops and
  says which tool it kept repeating. In the last full run gpt-oss:120b passed
  10 of 13 tasks; renames were where it got stuck.
- **nemotron-3-ultra** passed every task I added, including plan mode and
  resuming with `/continue`. It occasionally ends a task without a closing
  summary.
- **Across models** the same mistakes come up: inserting code by line number,
  sending `content` where `replace` is meant, putting settings in the wrong
  place. `edit_file` accepts line ranges and an insert line, and a refused call
  comes back with the corrected call built from what the model sent, so most
  models fix it on the next try.

### When a tool call fails

Models get tool calls wrong often; what matters is what happens next.

- **Nothing half-done is written.** An edit that doesn't match, would break the
  file's syntax, or targets a file that changed since it was read is refused
  before anything is written. Several edits in one call land together or not at
  all. `write_file` never overwrites an existing file; changes go through
  `edit_file`, which names what it replaces.
- **Refused before you are asked.** A call that is bound to fail is turned down
  before the approval prompt, so you are not asked to approve something that
  cannot work.
- **The model is told how to fix it.** The error goes back to the model with the
  reason and, where it can be worked out, the corrected call. Most models get it
  right on the next try; weaker ones may try a different tool instead.
- **The same mistake is not repeated.** A call refused for bad arguments, or one
  that already returned its answer, is not run again with the same arguments. If a model
  keeps asking anyway, the turn stops and says which tool it kept repeating.
  Rephrase the request, or run `/continue` to try again.
- **A failed command is reported, not hidden.** A command that exits with an
  error shows its output and exit code; the model sees the same and can react.
- **If tools don't work at all** (the model has no tool-calling support, or the
  provider rejects tool calls), ocode falls back to text mode, which is much less
  reliable. `ocode doctor` tells you when a model lacks tool calling, and
  `/tools` turns tools off entirely for plain chat.
- **Undo is always there.** `/undo` puts back any file the agent changed this
  session, including files and whole folders it deleted (they are saved before
  the delete; the prompt says so).

## Contributing

```sh
npm install
npm run typecheck   # tsc --noEmit
npm run lint        # oxlint
npm test
```

There is no build step; the CLI runs the TypeScript source through `tsx`.
`--log debug` (or `OLLAMACODE_LOG=debug`) writes detailed logs to
`~/.ollamacode/logs/`; `--debug` adds the full prompt and wire traffic.
[docs/architecture.html](docs/architecture.html) has diagrams of how it fits
together (open it in a browser), and `OLLAMACODE.md` explains how the code is
organised.

## Terms

**License.** MIT, see [LICENSE](LICENSE). It covers this source code only.

**No affiliation.** This project is not affiliated with, endorsed by or
supervised by Ollama, Hugging Face or Meta. Their names and the model names are
trademarks of their owners, used only to describe what this tool connects to.
Nothing here grants any right to those marks.

**No warranty.** The software is provided "as is", without warranty of any
kind, express or implied, including merchantability, fitness for a particular
purpose and non-infringement. The authors are not liable for any claim, damages
or other liability arising from it. The MIT license has the full wording.

**Models have their own terms.** Each model you run is covered by its own
license and usage policy, and by the terms of whoever hosts it. This project
doesn't relicense or redistribute any model. Check a model's license before
using it commercially.

**You are responsible for what it does.** The agent can run commands, write and
delete files and use git. It asks first unless you pass `--yes`, and its
safeguards can fail. You decide what it may touch, and you check the result.

**What leaves your machine.** With local Ollama, your prompts and files stay
local. With Ollama Cloud or Hugging Face, prompts go to that provider, and they
can include anything the agent has read: file contents, git output, tool
results. Don't let it read secrets unless you know where that text ends up.

**Outside services.** Web search sends the model's query to public services
such as Bing News, DuckDuckGo, Wikipedia, Hacker News, Yahoo Finance, Stooq,
CoinGecko, Frankfurter and Open-Meteo. A weather question that names no city
looks up your approximate location from your IP address (ip-api.com or
ipapi.co). MCP servers are separate programs you install yourself; check what
each one does before turning it on.

**Local files.** Sessions, notes, logs and the workspace index are stored in
`~/.ollamacode`, plus `.ollamacode/` in your project (the index is in
`.ollamacode/index/`). Add `.ollamacode/` to `.gitignore`.
