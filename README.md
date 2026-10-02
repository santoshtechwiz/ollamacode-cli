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

Besides code, it can search the web, read a web page, and read or create PDF and
Excel files (`.pdf`, `.xlsx`). A file outside the project folder works too; you
approve it once and it stays open for the session.

## Sessions

Each project keeps its most recent conversation, so closing the terminal loses
nothing. Run `ocode` in the same folder and it asks whether to pick up where you
left off.

```sh
ocode -c       # continue without asking
ocode --new    # start fresh
```

Only one session is kept per project. Starting a new one, or running `/clear`,
replaces it.

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
| `/status` | session, model and settings |
| `/provider` | switch provider |
| `/model` | switch model |
| `/tools` | turn tool calling on or off |
| `/permissions` | ask, always or never for risky tools |
| `/plan` | plan mode: propose first, change after you approve; `/plan close` drops the open plan |
| `/plans` | the open plan and how far it got |
| `/continue` | carry on with work that stopped part way, a paused plan or a cut-off answer |
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
| `/context` | how full the context window is |
| `/usage` | tokens sent and received this session |
| `/color` | terminal colour mode |
| `/clear` | start a new session |
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
- **Long conversations.** Older history gets summarised when the window fills
  up, so a long session keeps going instead of failing.
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
  session.

## Contributing

```sh
npm install
npm run typecheck   # tsc --noEmit
npm run lint        # oxlint
npm test
```

There is no build step; the CLI runs the TypeScript source through `tsx`.
`--debug` (or `OLLAMACODE_LOG=debug`) writes detailed logs to
`~/.ollamacode/logs/`. `OLLAMACODE.md` explains how the code is organised.

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
`~/.ollamacode`, plus `.ollamacode/` and `.agent/` in your project. Add the
project folders to `.gitignore`.
