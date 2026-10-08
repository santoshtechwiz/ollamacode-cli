---
name: ocode-bug-report
description: Triage a bug report pasted from an ocode session (a transcript, bug.txt, "it looped", "it said nothing", "it overwrote my file") by reading the saved session and debug log before touching code. Use first whenever the user pastes ocode output or points at a session; hand the fix itself to ocode-change.
---

# Triaging an ocode bug report

A pasted transcript shows what the person saw, not what happened. Find the record before deciding anything.

## 1. Find the session

- The workspace the report came from holds `.ollamacode/sessions/<id>.json`, newest by mtime. Each message has `role`, `content`, `tool_calls` (name + arguments) and, for tool results, `name` and the rendered result the model read (`OK <tool> — …` / `ERROR <tool> [CODE] — …` plus `Hint:`).
- An unfinished turn leaves `.ollamacode/checkpoints/<id>.json` with its `stopReason` (`guard_stuck`, `max_iterations`, `output_truncated`). No checkpoint means the last turn completed.
- `~/.ollamacode/logs/ocode-<date>.log` has the debug trail when the run used `--log debug` (`round finished`, `progress`, the stop decision).
- Plan mode explores in its own context: those calls are not in the session file, only the plan that came out of it.
- Read session files in `C:\projects\empty` or other users' folders only to diagnose; never edit them.

## 2. Replay what the model saw

Print the calls and results in order; one line each is enough:

```
node -e "const s=require(process.argv[1]);for(const m of s.messages){if(m.tool_calls)for(const c of m.tool_calls)console.log('CALL',c.function.name,JSON.stringify(c.function.arguments).slice(0,160));else if(m.role==='tool')console.log('  ->',String(m.content).split('\n')[0].slice(0,120));else console.log(m.role,JSON.stringify(String(m.content).slice(0,100)))}" <session.json>
```

Then answer, from the record:
- Which call went wrong first, and what did the result tell the model (error, hint, `Reused —`)?
- Did the model act on that result? A correct hint it ignored is a model problem; a wrong or missing one is ours.
- Which stage owns it (see ocode-change §1): the provider/reply parsing, `prepareCall` (parse → normalize → validate), the decider, the tool, the result the model reads, the UI, or the stop guards.
- Is it one model or several? `npm run eval -- --mine <dir>` groups errors and marks `[tool design: N models]`.

## 3. Reproduce before fixing

- Replay the exact failing call through `ToolRuntime.run` / `prepareCall` with `node --import tsx` (scratch copy of the file, never the user's).
- For a model-side symptom (empty reply, repeated call), replay the request to the provider with the saved messages and vary one thing at a time.
- For a whole-task symptom, run the matching `npm run eval -- --model <name> --only <id>` scenario, or add one.

## 4. Report, then hand off

State the root cause with the evidence (session line, replayed call, log line), the stage that owns it, and the proposed change. If it is not fixed now, say so plainly to the user. The fix follows ocode-change.
