---
name: ocode-audit
description: Check a change to ocode for brute force before it is handed back — flags that steer the turn, tool-name special cases in shared code, per-mistake normalizers, word lists guessing at intent, hidden nudges. Use after editing src/agent, src/tool or src/context, and before saying a change is done.
---

# Auditing a change for brute force

ocode must work with any model. Run these on the working tree and read every hit; each needs a reason to stay.

## 1. Greps on the diff

```
git diff HEAD -U0 -- src | grep '^+' | grep -v '^+++' > "$TMP/added.txt"

# A tool named in shared code (router, turn, execution, context, policy):
git diff HEAD -U0 -- src/agent src/context src/tool/execution src/tool/policy | grep '^+' | grep -nE "(name|resolved|toolName) === '[a-z_]+'|case '[a-z_]+':"

# New flags that steer the turn:
grep -nE "\b(fresh|lenient|slip|force|retry|nudge|confirm)[A-Z]?\w*\s*[:=]\s*(true|false)" "$TMP/added.txt"

# Word lists and phrase regexes (guessing what a person or a model meant):
grep -nE "new Set\(\[\s*'[a-z]|/\\\\b\((\w+\|){4,}" "$TMP/added.txt"

# Value rewrites for one mistake:
grep -nE "'(true|false|w|write|save|done)'\s*[:?]" "$TMP/added.txt"

# Hidden messages to the model:
grep -nE "addUser\(|role: *ROLE\.USER|role: *'user'" "$TMP/added.txt"
```

## 2. Questions for each hit

- Does it decide something from how text is worded (the person's or the model's)? Replace it with an explicit control (a flag the person sets, a command, a schema field the model fills) or delete it.
- Does it rewrite an argument a model got wrong? Delete it: the tool's error goes back and `suggestCall` shows the corrected call.
- Does shared code know a tool's name? Move the rule onto the tool definition (`profiles`, `aliases`, `argAliases`, `cannotRun`, `resultKey`).
- Is it a new stop or retry condition? A repeat is only what the decider says (REUSE / REJECT).

## 3. Intentional exceptions (reviewed 2026-09-30)

These match the greps on purpose; leave them unless the reason no longer holds:

- `src/core/ids.ts` `cleanToolName`: strips the harmony `functions.` namespace and chat-template tokens — protocol, not a mistake fix.
- `src/agent/response/*`: result-line and `tool_result` shapes, channel tags, text-mode tool-call JSON — the harness's own protocol.
- `src/agent/intent.ts` `isContinueInput`: exact match on the text `/continue` records, never a phrase list.
- `src/tool/web/intent.ts` `understand`: keyword routing only when the model did not set `kind` on `web_search`.
- `src/agent/planning/plan.ts` `KNOWN_EXTENSIONS` / `PROSE_ABBREVIATIONS`: file scope read from a plan given only in words; a plan with `present_plan` `files` never uses them.
- `coerceArgvCommand`, `dropUnsetOptionals` (`src/agent/router/args.ts`): schema-driven for every tool — `false` on an optional choice and `""` on an optional path/choice/number/flag mean "not set" (approved 2026-09-30).
- Tool-owned `argAliases` / `aliases` on definitions: kept because tests pin them (`cat` → `read_file`); new ones need a reason.

## 4. Then verify

`npx tsc --noEmit -p .`, `npm test`, and the eval scenarios the change touches (ocode-change §4).
