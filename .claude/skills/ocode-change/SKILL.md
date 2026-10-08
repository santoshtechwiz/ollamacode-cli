---
name: ocode-change
description: Rules for changing ocode's agent behaviour — the turn loop, tools, tool results, what the chat UI shows, or any bug report pasted from an ocode session (loops, stuck turns, wrong edits, noisy errors). Use before editing src/agent/turn, src/tool, src/agent/router or src/ui for a behaviour fix.
---

# Changing ocode behaviour

ocode must work with any model the user picks. A fix that only works because of how one model behaves, or that adds a flag to steer around one bug report, is wrong even when it makes the report go away.

## 1. Follow the turn

Every fix lives in the stage of the turn that owns the concern. Trace it before editing:

```
executeTurn (src/agent/turn/index.ts)      config · scope · context · plan
  └ runTurn loop (src/agent/turn/turn.ts)
      ask model → reply
      ├ text only → the turn ends
      └ tool calls → processToolCalls, per call:
           prepareCall          parse → normalize → validate arguments
           decideToolExecution  EXECUTE / REUSE / REJECT / STOP
           execute
           → ToolCallRecord     the one place a call settles
               ├ recordExchange  → what the model reads
               ├ onToolResult    → what the person sees
               ├ recordProgress  → progress tracker
               └ summarizeRound / buildResult → stop guards, final report
```

- A repeat is what the decider says: `isRepeat` is REUSE or REJECT, nothing else.
- The turn ends when the model answers in text, when a guard sees a repeat or a refusal-only round, or at the iteration limit.
- A tool reports its own failure in its own result (`error`, `hint`, `display`). The turn doesn't reinterpret it.

## 2. No brute force

Never:
- add a boolean or conditional flag to steer the turn (`freshAttempt`, `lenient`, `slip`, `ran || X`, `!confirmFinish`, filters on side fields);
- inject hidden user messages to push the model on (the finish check and the empty-reply nudge were removed for looping);
- special-case one tool name, argument value or error string in shared code;
- add a normalizer rule per model mistake (`sandboxed: "true"`, `mode: "w"`): the error goes back to the model and it corrects itself. The one schema-wide rule is `dropUnsetOptionals`: an optional path, choice, number or flag sent as `""` (or a choice sent as `false`) is "not set", for every tool.

If a fix seems to need any of these, stop, explain the flow, and ask. Removing a rule beats adding one. Before editing, name the stage you will change, propose it, and wait for approval.

## 3. What the person sees

- Output reads as plain human language: no raw codes, no internal jargon, no unearned alarm.
- A tool's `hint` is recovery advice for the model; the UI shows only approval hints.
- Advice meant only for the model on a successful result goes in `modelNote`, never in `display`.

## 4. Verify

1. `npx tsc --noEmit -p .`
2. `npm test` — always run it. When it fails, fix the code, never the tests. Add or retire tests only when the user asks. `tests/turn-flow.test.ts` pins the turn rules above.
3. Prove the change live. Only real `ocode` chat runs count as proof:
   - `npm run eval -- --model <name> [--only id,...]` runs fixed tasks (node, py, .NET, Go) in fresh clones and prints pass/fail, errors, stuck turns and missing answers;
   - `npm run eval -- --mine <dir...>` groups the tool errors in saved sessions;
   - for a one-off, pipe a task into `node bin/cli.js --yes --new --model <name>` from a fresh clone in the temp folder, and add `--plan` to exercise plan mode.
4. Only one live run at a time. Try the strongest model available first, then the user's current one.

## 5. Hands off

- Never commit, stage or push. The user tests first and commits.
- Never edit `C:\projects\empty` or another tool's files. Read the session files there only to diagnose.
- `C:\projects\ocode-lab` repos are testbeds. Prefer fresh clones in the temp folder over editing them in place.
