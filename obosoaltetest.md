# Test Redundancy Analysis: Tool Execution Decider

## Summary
The "unifications" refer to consolidation of tool deduplication logic into **ToolExecutionDecider** (see `newdesing.txt` lines 178-182, 211). Old functions (`findPriorNoOp`, `findPriorDeclined`, `findPriorSequentialThought`, `attemptCount`, `lastRun`, `hasProgress`, `markProgress`, etc.) were removed and merged into this single component.

---

## Redundant Tests Found

### Location: `tests/regression.test.ts` lines 425-557
**3 tests under "Tool execution decisions"** are redundant with unit tests in `tests/tool-execution-decider.test.ts`:

| Regression Test | Tool-Execution-Decider Test | Status |
|-----------------|----------------------------|--------|
| `reuses an identical successful read` (L426-466) | `reuses a successful call with the same workspace world` (L55-63) | **Duplicate** |
| `rejects an identical denied call instead of retrying it` (L468-514) | `rejects a repeated declined call` (L65-73) | **Duplicate** |
| `executes the same read again after the target changes` (L516-556) | `executes the same successful read after the workspace world changes` (L83-103) | **Duplicate** |

These regression tests:
- Use different helper setup (`createState`/`createCall` vs inline objects)
- Test **identical scenarios** on the **same function** (`decideToolExecution`)
- Add **no new coverage**
- Increase **maintenance burden**

---

## Valuable Tests (Keep)

| File | Description |
|------|-------------|
| `tool-execution-decider.test.ts` | 21 focused unit tests for the decider |
| `turn-flow.test.ts` | Integration tests for full turn behavior |
| `turn.integration.test.ts` | Full turn integration tests |
| `progress-tracker.test.ts` | Tests for new ProgressTracker (replaces old progress functions) |

---

## Potential Bug in ToolExecutionDecider

**File**: `src/agent/turn/tool-execution-decider.ts`, lines 85-90 (`unchangedSince` function)

```typescript
const unchangedSince = (c: ToolCallRecord): boolean => {
  if (target == null) {
    return typeof providedTargetStamp === 'string' ? actuallyRan(c) && c.targetStamp === providedTargetStamp : true; // BUG: returns true when no stamp provided
  }
  return actuallyRan(c) && c.target === target && (providedTargetStamp == null || c.targetStamp === providedTargetStamp);
};
```

**Issue**: When `target == null` (non-file tools) and `providedTargetStamp` is not a string (undefined/null), it returns `true` assuming unchanged. This could cause incorrect reuse for non-file tools if callers forget to pass `targetStamp`.

**Mitigation**: Existing tests pass, suggesting callers do provide `targetStamp` correctly. Consider adding explicit test for this edge case.

---

## Recommendation

1. **Delete** the 3 redundant tests in `regression.test.ts` (lines 425-557)
2. **Run full test suite** to verify no regressions
3. **Optional**: Add test for `targetStamp` edge case in `tool-execution-decider.test.ts`