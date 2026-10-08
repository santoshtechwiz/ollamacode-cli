# Testing the turn-loop and UX fixes

How to check every fix in [pull request #3](https://github.com/santoshtechwiz/-ollamacode-cli/pull/3) yourself.

There are three levels, from quickest to strongest:

| Level | What it proves | Time | Needs a model |
|---|---|---|---|
| 1. Automated tests | The code does what each fix says | 2 min | No |
| 2. Manual checks | You can see each fix working | 30–40 min | Yes |
| 3. Before/after eval | Real tasks score the same or better | 30+ min | Yes |

Commands are written for PowerShell on Windows. Replace `C:\path\to\-ollamacode-cli` with your ocode folder and `<model>` with your model name.

---

## Setup

```powershell
cd C:\path\to\-ollamacode-cli
git fetch origin
git checkout review/codebase-review
npm ci
```

You can get back to the original version at any time with `git checkout main`.

The manual checks use a scratch project:

```powershell
mkdir C:\temp\ocode-try
cd C:\temp\ocode-try
git init
Set-Content add.js "function add(a, b) { return a - b }`nmodule.exports = add"
```

From inside that folder, start ocode like this:

```powershell
node C:\path\to\-ollamacode-cli\bin\cli.js --new
```

---

## Level 1: automated tests

```powershell
cd C:\path\to\-ollamacode-cli
npm test            # expect: tests 339, pass 339, fail 0
npm run typecheck   # expect: no output
npm run lint        # expect: exit code 0 (warnings are fine)
```

Each fix has its own test, and each of those tests fails on `main`. To see that, run the branch's tests against `main`'s code:

```powershell
git worktree add ..\ocode-main main
cd ..\ocode-main
npm ci
git checkout review/codebase-review -- tests
npm test
cd ..\-ollamacode-cli
git worktree remove ..\ocode-main --force
```

Expect the new tests to fail there. That is the bug each one describes, still present on `main`. A few test files won't even load on `main`, because they import helpers that only exist on the branch: `plan-mode`, `mode`, `task-list` and `init-command`. That is expected too.

---

## Level 2: manual checks, one per fix

Each check lists what to do, what you should see, and the automated test that pins it.

### Turn loop

#### 1. A stuck turn ends with a real summary
- **Do:** in a folder that is *not* a git repository, ask: `run git status twice and tell me if anything changed`.
- **Expect:** the git calls fail, ocode stops the repeat, and the last thing you read is a plain summary from the model, such as "the folder is not a git repository". It should never be empty, and never a half sentence like "Let me check…".
- **Also:** ask `use web_search to get the current GOOGL price`. If the model repeats the search and gets stopped, the summary still gives the price it found. It used to be told to answer "from the results above" while being shown none of them, so it said nothing ("The model finished without saying what it did").
- **Tests:** `turn-flow` — "ends a stuck turn with the closing summary…", "ends a turn the decider stopped mid-reply…", "gives the closing summary the steps and their results as they were…".
- **Also:** after a stuck turn, the summary is prose. It never pastes back a step list like `• read file X — worked` or a todo list with its output.

#### 2. Stopping one command does not kill the turn
- **Do:** ask for something that runs a long command (for example `run npm install` in a big project). When "Still running after 2 min" appears, choose **Stop it**.
- **Expect:** the model carries on with another approach or explains; the turn does not just end. Pressing **Ctrl-C** still stops everything at once.
- **Test:** `turn-flow` — "lets the model carry on after a tool reports that the person stopped it".

#### 3. The same call in a different argument order is a repeat
- **Automated only:** this depends on how the model orders its arguments.
- **Test:** `tool-execution-decider` — "reuses a repeat whose arguments come in a different order".

#### 4. Commands that should always re-run really re-run
- **Do:** in the scratch project (a git repo), ask: `run git status twice and tell me if anything changed`.
- **Expect:** both runs execute. On `main`, the second one handed back the first result.
- **Test:** `tool-execution-decider` — "runs a volatile tool again instead of handing back its earlier result".

#### 5. Ctrl-C during the closing summary is a cancel
- **Do:** repeat check 1, and press **Ctrl-C** while the final summary is being written.
- **Expect:** a clean cancel. You should *not* see "Paused — the model repeated the same steps".
- **Test:** `turn-flow` — "ends as a cancel when the person stops the closing summary".

#### 6. The "retry without reasoning" never uses up a step
- **Automated only:** this needs a model whose reasoning fills its whole reply.
- **Test:** `turn-flow` — "asks again without reasoning as the same step, even on the last one".

#### 7. Long chats keep work already done when they hit the context limit
- **Automated only:** this needs a conversation larger than the context window.
- **Test:** `turn.integration` — "keeps the work done after the first compaction when recovery gives up".

### Plans

#### 8. Ctrl-C while plan mode is exploring is a cancel
- **Do:** start with `--plan`, ask for a change, and press **Ctrl-C** while it is reading files.
- **Expect:** a plain cancel. You should *not* see "The model produced no plan".
- **Test:** `plan-mode` — "reports a cancel during exploration as a cancel, not as a missing plan".

#### 9. A rejected plan, then "approved"
- **Do:** start with `--plan`, ask for a change, **reject** the plan, then type `approved`.
- **Expect:** it carries out the plan you were shown.
- **Test:** `plan-mode` — "saves a plan nobody approved after the request it answers".

#### 10. Plan progress counts files with any name
- **Do:** in a project, use `--plan` to ask `add Docker support (Dockerfile, .dockerignore, update appsettings.json)`. Approve it with Docker Desktop **stopped**.
- **Expect:**
  - The pause line says **3 of 5 steps done**; on `main` it said 1 of 5.
  - It names the command that failed and quotes its error: ``Stopped at `docker build …`: <Docker's own error line>. Fix that, then type /continue…``
- **Then:** start Docker Desktop and type `/continue`. The remaining Docker steps run.
- **Tests:** `plan-flow` — "ticks a step that names a file the plan really changed…", "a plan stuck on a failing command names the command and what it said".

#### 11. A cancelled plan with nothing checkable stays open
- **Do:** start a plan written only in prose (no file names), and press **Ctrl-C** while it is working.
- **Expect:** it is reported as cancelled, not as finished, and `/continue` can pick it up.
- **Test:** `settle-plan` — "a cancelled turn on a plan with nothing to check stays cancelled and can be picked up again".

#### 11b. A question asked in plan mode gets an answer, not a plan
- **Do:** start with `--plan` (or switch to Plan with Shift+Tab) and ask `explain C# 12 features`.
- **Expect:** a normal answer, with headings and bullet lists, not the yellow plan box asking for approval. Then ask a follow-up (`tell me more about primary constructors`): it builds on the answer.
- **Note:** the model decides, using the plan-mode instructions. A very weak model may still write a plan; Ask mode (Shift+Tab) is always the explicit way to just ask.
- **Tests:** `plan-mode` — "answers a question asked in plan mode instead of showing it as a plan", "keeps the answer in the conversation…".

### Modes (Shift+Tab, Ctrl+G)

#### 12. Switching modes is quiet; one line when it matters
- **Do:**
  - Press **Shift+Tab** a few times.
  - Then type some text and press **Ctrl+G**.
  - Then send a message.
- **Expect:**
  - Switching only changes the footer at the bottom. No `mode: …` lines pile up in the chat.
  - **Ctrl+G** switches even with text typed. On some Windows consoles, Shift+Tab only works when the input is empty; Ctrl+G always works.
  - When you send the message in a new mode, exactly **one** line appears, such as `Plan · read-only — was Agent`.
- **Test:** `mode` — "cycling says nothing; the first message in the new mode says it once".

#### 13. The agent says when it switches the mode
- **Do:** in Plan mode, ask for a change and **approve** the plan.
- **Expect:** one line: `Agent — was Plan · read-only · switched to carry out the approved plan`.
- **Test:** `mode` — "an approved plan switching to Agent says why".

#### 14. `/ask`, `/plan` and `/review` never leave two modes on
- **Do:** try `/plan`, then `/ask`, then `/plan off`, then `/ask off`, and watch the footer.
- **Expect:** the footer always shows exactly one mode, and `/ask off` returns to Agent.
- **Test:** `mode` — "the commands go through the one owner and never leave two modes on".

### Task list

#### 15. A new task never shows the previous task's list
- **Do:** ask for a multi-step task so the model writes a task list. When it finishes, ask something unrelated (`say hello`).
- **Expect:** the old task list is not pinned again. `/continue` on the first task still keeps its list.
- **Test:** `task-list` — "a new task starts without the previous task's list".

### `/init` and `ocode init`

#### 16. `/init` works in Ask or Review mode
- **Do:** switch to **Ask** mode, then run `/init` in a project with code.
- **Expect:** `OLLAMACODE.md` is written, and the footer returns to Ask afterwards.
- **Test:** `init-command` — "writes the doc in Agent mode even when the chat is in Ask mode, then puts Ask back".

#### 17. Cancelling `/init` stops it cleanly
- **Do:** run `/init` and press **Ctrl-C** while it works.
- **Expect:** `/init stopped — OLLAMACODE.md was not written`. No retry, and no "the model did not write…" message.
- **Test:** `init-command` — "stops when the person cancels, without retrying or blaming the model".

#### 18. `/init` in an empty folder
- **Do:** in an empty folder, run `/init`.
- **Expect:** it says the project is empty and asks the model nothing.
- **Test:** `init-command` — "does not ask the model to document an empty project".

#### 19. `ocode init` keeps your last conversation
- **Do:**
  - In a project, chat a little and exit.
  - Run `node C:\path\to\-ollamacode-cli\bin\cli.js init` and let it write `OLLAMACODE.md`.
  - Then start ocode with `-c`.
- **Expect:** your earlier conversation is still there. On `main`, `ocode init` deleted it.
- **Test:** `sessions` — "an ephemeral session (ocode init writing its doc) never replaces the last conversation".

### Tools the model was told about but never given

#### 19b. Installing a toolchain
- **Do:** in a .NET 6 project on a machine without the .NET 8 SDK, ask `install the .NET 8 SDK and move the project to net8.0`.
- **Expect:** the model calls `ensure_toolchain` (you approve the install, which uses winget or scoop) instead of saying it cannot install software. It works the same for node, python, go, rust, git and terraform.
- **Also now available:** `undo` ("undo that delete"), `save_memory` ("remember that we use tabs"), `stop_process` (port already in use) and `delete_file`.
- **Test:** `tool-reach` — "a tool is offered by some profile ocode actually chooses, or by plan mode".

### Long-running work in the background

#### 19c. A background job tells you, and the agent, when it ends
- **Do:** in a .NET or Node project, ask `run the full build in the background, and meanwhile explain the project structure`.
- **Expect:**
  - The agent starts the build with `start_subprocess` and keeps working on the explanation. It does not poll.
  - When the build ends, a note appears for you, for example `✔ background "build" finished (exit 0) after 2m 14s — the agent will see it with your next message`, or `⚠ … failed (exit 1) …`. It has one icon, not two.
  - Under that line are the last lines the job printed (up to 5), so you see the result without asking. A job that printed nothing says `printing nothing`.
  - Send any message (for example `how did the build go?`): the agent knows the result and its last lines of output without calling anything.
- **Also:** a server that crashes on its own is reported the same way; a process you or the agent stopped is not.
- **Silent jobs run alongside too:** ask `fetch the apple price in the background with Invoke-RestMethod, and meanwhile explain the project structure`. The fetch prints nothing until it ends. If it is still running after about 5 seconds, the start result says `Running in the background … No output yet`. A fetch that finishes sooner returns its result directly, like any quick job. The explanation then streams while the fetch runs, and the ✔ note with the price comes after. Before this fix, the start waited for the job to end ("finished … while starting"), so the two tasks ran one after the other.
- **Tests:** `background-inbox` — "records the end of a job it was not watching…", "hands a job that prints nothing until it ends to the background…", "a process the agent stopped itself is not reported", and the inbox rules.

#### 19d. "Always allow" on starting a process sticks, and never covers a dangerous command
- **Do:** ask `fetch apple price in background, and meanwhile explain the project structure`. At the first `Start subprocess` prompt press `a`.
- **Expect:**
  - The dim line `→ won't ask again this session for starting a process` appears. If it doesn't, the `a` was not read: tell me what the prompt showed.
  - No further `Start subprocess` prompt for routine commands in this session, whatever id the agent gives them.
  - A start whose command deletes files or changes git (for example `rm -rf build`, `git push`) still asks, and says why. A command the session never runs (a fork bomb, deleting the root or home directory) is refused without asking, the same as through `exec_shell`.
- **Tests:** `permissions-always` — "is asked once…", "still asks before a start whose command deletes files…", "refuses a command the session never runs, whichever tool carries it".

### Math and tables in answers

#### 20. Math looks the same whichever model wrote it
- **Do:** ask: `show the quadratic formula, the area of a circle, and the sum 1..n, using LaTeX`. Try it with two different models (for example gpt-oss and qwen).
- **Expect:** the math is shown with symbols (`π r²`, `∑ᵢ₌₁ⁿ`, `x₁`), never raw LaTeX like `\frac`, `\(`, `$$` or `\[`. `$\boxed{42}$` shows as `[42]`. Prices such as `$5 and $10` stay as written.
- **Tests:** `markdown-math-tables` — "math, however the model writes it", "text that only looks like math is left alone".

#### 21. Tables never overlap
- **Do:** make the terminal window narrow (about 60 columns). Ask: `compare Docker, bare metal and Azure App Service in a table with long descriptions`.
- **Expect:** the table fits the window, and long cells wrap inside their own column. In a very narrow window (about 25 columns), each row is listed as `Header: value` instead of a grid.
- **Tests:** `markdown-math-tables` — "tables fit the terminal".

---

## Level 3: before/after eval with your model

The eval runs fixed tasks from your lab repos (`C:\projects\ocode-lab`) with a real model, and scores pass/fail, errors, stuck turns and missing answers.

```powershell
cd C:\path\to\-ollamacode-cli
git checkout main
npm run eval -- --model <model> > eval-main.txt
git checkout review/codebase-review
npm run eval -- --model <model> > eval-branch.txt
```

- **Expect:** the same number of passing tasks or more, and fewer turns that end stuck with no answer.
- **Red flag:** a task that passes on `main` but fails on the branch. Models vary from run to run, so rerun just that task first: `npm run eval -- --model <model> --only <task-id>`.

---

## If something fails

Send:
- the failing test name, or the eval line, and
- what you saw on screen, from the start of the chat.

`main` is untouched until the PR is merged, so nothing reaches anyone before you approve it.
