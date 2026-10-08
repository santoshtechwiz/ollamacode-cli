import fs from 'node:fs';
import path from 'node:path';
import {
  claimSession,
  deleteSession,
  lastSession,
  listSessions,
  readSession,
  sessionTitle,
  newSessionId,
  releaseSessionClaim,
  saveSession,
  type SessionRecord,
} from '../../core/sessions';
import { isInteractive, select } from '../../ui/prompts';
import { loadConfig } from '../../core/config';
import { resolveSession, rememberSession } from '../../model/session';
import { resolveScope as resolveWorkspaceRoot } from '../../agent/workspace/scope';
import { inspectWorkspace } from '../../agent/workspace/session';
import { refreshModelCapabilities, textToolsFit } from '../../agent/workspace/profile';
import { windowLabel } from '../../agent/workspace/model-fit';
import { createAgentState, resetSessionState } from '../../agent/state';
import { createAgentRuntime } from '../../agent/runtime';
import { autoSelectModel } from '../../model/catalog';
import { replaceSession } from '../../context/workspace-state';
import { loadMemory, projectDocStale, recordSessionState } from '../../context/memory';
import { detectWorkspaceStacks } from '../../env/tooling/detector';
import { noteWorkIn } from '../../context/workspace-state';
import { closeMcpServers } from '../../mcp/registry';
import { applyApprovalPolicy, clearAlwaysAllow, permissionsFromRecord, persistentPermissions } from '../../tool/policy/permission-policy';
import { classifyCall } from '../../tool/common/wired-policy';
import { THINKING_MODE, SESSION_RECORD_VERSION, EPHEMERAL_SESSION } from '../../protocol';
import { sessionHasLedger } from '../../core/session-recovery';
import { asCompactable } from '../../context/builder';
import { TOOL_META } from '../../tool/index';
import { resolveToolName } from '../../agent/router/names';
import { bold, dim, setColorMode } from '../../ui/ansi';
import { modeOf, type AgentMode } from './mode';
import { bindSessionContext, logger } from '../../core/logger';
import {
  resolveContextWindow,
  resolveMaxTokens,
  resolvePlanMode,
  resolveScope,
  resolveThinkFlag,
  resolveThinkingPreference,
  resolveYes,
  type TypedFlags,
} from '../flags';
import { sanitizeMessages } from '../../agent/response/demux';
import { restoreContextStore, createContextStore } from '../../context/store';
import { describeChoice } from '../../model/router';
import { resetUsage, usageTotals, type UsageTotals, type TurnUsage } from '../../core/usage';

export const isKnownTool = (name: string) => Boolean(TOOL_META[resolveToolName(String(name ?? ''))]);

type StartPlan = { action: 'new' | 'resume' | 'ask'; note?: string };

/** Continue the last session or start new, from the flags alone; 'ask' means offer the choice on the terminal. */
function planSessionStart({ flags, last, interactive }: {
  flags: { new?: boolean; continue?: boolean };
  last: SessionRecord | null;
  interactive: boolean;
}): StartPlan {
  if (flags.new === true) return { action: 'new' };
  // After /clear the last record is empty: there is nothing to continue.
  const continuable = Boolean(last && last.messages.length > 0);
  if (flags.continue === true) return continuable ? { action: 'resume' } : { action: 'new', note: 'nothing to continue — starting a new session' };
  return continuable && interactive ? { action: 'ask' } : { action: 'new' };
}

type StartChoice = StartPlan & { record?: SessionRecord };

async function askSessionStart(last: SessionRecord, root: string): Promise<StartChoice> {
  process.stdout.write(`\n${bold('  Welcome back')} ${dim(`— ${root}`)}\n`);
  const earlier = listSessions(root).filter((rec) => rec.id !== last.id);
  const resume = { label: 'Continue last session', value: 'last', hint: `${describeLast(last)} · ${sessionTitle(last, 40)}` };
  const fresh = { label: 'Start new session', value: 'new', hint: 'the last one is kept; /sessions goes back to it' };
  // Enter takes the first choice: after a long break or a long conversation, that is a fresh start, not a day of old work.
  const stale = staleSession(last);
  if (stale) fresh.hint = `recommended — the last session is ${stale}; it is kept`;
  const choice = await select('  Session:', [
    ...(stale ? [fresh, resume] : [resume, fresh]),
    ...(earlier.length ? [{ label: 'Choose an earlier session', value: 'pick', hint: `${earlier.length} more` }] : []),
  ]);
  // Cancelling the picker is never a vote for old context nobody asked for.
  if (choice === undefined) return { action: 'new', note: 'no session chosen — started a new one' };
  if (choice === 'pick') {
    const id = await select('  Which one:', earlier.map((rec) => ({ label: sessionTitle(rec), value: rec.id, hint: describeLast(rec) })));
    const record = id ? earlier.find((rec) => rec.id === id) : undefined;
    return record ? { action: 'resume', record } : { action: 'new', note: 'no session chosen — started a new one' };
  }
  return { action: choice === 'last' ? 'resume' : 'new' };
}

/** Older than this, or longer, and starting fresh is the default choice. */
const STALE_AFTER_MS = 6 * 60 * 60 * 1000;
const STALE_MESSAGES = 120;

/** Why the last session is better left than continued, in words, or '' when it is fresh enough to carry on. */
export function staleSession(rec: SessionRecord, at: number = Date.now()): string {
  const age = at - (rec.updatedAt ?? rec.createdAt ?? at);
  if (age > STALE_AFTER_MS) return `from ${relativeTime(rec.updatedAt ?? rec.createdAt ?? 0, at)}`;
  if (rec.messages.length > STALE_MESSAGES) return `${rec.messages.length} messages long`;
  return '';
}

function describeLast(rec: SessionRecord, at: number = Date.now()): string {
  const n = rec.messages.length;
  return `${relativeTime(rec.updatedAt ?? rec.createdAt ?? 0, at)} · ${n} message${n === 1 ? '' : 's'}`;
}

export function relativeTime(then: number, at: number = Date.now()): string {
  const min = Math.round(Math.max(0, at - (then || 0)) / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hours = Math.round(min / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.round(days / 30)}mo ago`;
}

export type ChatSession = NonNullable<Awaited<ReturnType<typeof openSession>>>;

/** The one session every front end runs: live chat, piped chat and `ocode init`. Null means startup already reported an error. */
export async function openSession(flags: TypedFlags) {
  const interactive = isInteractive();
  const scope = resolveScope(flags);
  const cwd = process.cwd();
  const cfg = loadConfig();
  setColorMode(cfg.ui?.color ?? 'auto');
  // Resolved before the workspace, which sizes the session budget from it.
  const thinkFlag = resolveThinkFlag(flags);
  const session = await resolveSession(flags, { interactive });
  const bannerNotes: string[] = [];

  // The session id keys the workspace's recovery ledger, so it is settled before the workspace exists.
  const root = resolveWorkspaceRoot(cwd, scope);
  // An ephemeral run (ocode init writing OLLAMACODE.md) has no conversation of its own to continue.
  const last = flags.ephemeral ? null : lastSession(root);
  let startPlan: StartChoice = planSessionStart({ flags, last, interactive });
  if (startPlan.action === 'ask' && last) startPlan = await askSessionStart(last, root);
  if (startPlan.note) bannerNotes.push(startPlan.note);

  const saved = startPlan.action === 'resume' ? (startPlan.record ?? last) : null;
  let resumable = Boolean(saved);
  let claim: { id: string } | null = null;
  if (resumable && saved) {
    const acquired = claimSession(root, saved.id);
    if (acquired.ok !== true) {
      bannerNotes.push(`the last session is open in another ocode window (pid ${acquired.owner.pid}) — started a new one; continue it with ocode -c once that window closes`);
      resumable = false;
    } else {
      claim = { id: saved.id };
    }
  }
  const sessionId = flags.ephemeral ? EPHEMERAL_SESSION : resumable && saved ? saved.id : newSessionId();
  if (!claim && sessionHasLedger(sessionId) && claimSession(root, sessionId).ok === true) claim = { id: sessionId };
  bindSessionContext({ sessionId });

  // Safety-critical resume state rides apart from bannerNotes so a quiet resume cannot swallow it.
  const resumeSafetyNotes: string[] = [];
  const restoredPerms = resumable ? permissionsFromRecord(saved?.permissions) : null;
  // The per-tool lines are written below, once the mutating grants have been separated out —
  // saying "resumed with always-allow for write_file" and then "not carried over" is a lie twice over.

  let toolsEnabled =
    flags.tools !== undefined ? flags.tools !== false : resumable ? (saved?.toolsEnabled ?? cfg.toolsEnabled ?? true) : (cfg.toolsEnabled ?? true);

  const restored = resumable ? sanitizeMessages(saved?.messages ?? [], isKnownTool) : { messages: [], removed: 0 };
  if (restored.removed > 0) logger.debug(`resume: dropped ${restored.removed} message(s) containing invented tool output`);
  // The record on disk stays whole; the live session works from a compact window so resume never replays old tool calls.
  const history = resumable ? restoreContextStore(restored.messages, saved?.summary) : createContextStore();
  resetUsage(resumable ? saved?.usage?.totals : null);

  const workspace = await inspectWorkspace(cwd, {
    sessionId,
    provider: session.provider,
    model: session.model,
    scope,
    contextWindow: resolveContextWindow(flags),
    maxTokens: resolveMaxTokens(flags),
    thinking: resolveThinkingPreference(thinkFlag),
  });

  if (toolsEnabled && workspace.nativeTools === false) {
    const choice = await autoSelectModel({
      provider: session.provider,
      model: session.model,
      workspace,
      toolsEnabled,
      policy: { ...cfg.routing, pinned: flags.model },
    }).catch((err: unknown): null => {
      logger.debug(`model routing failed: ${(err as Error).message}`);
      return null;
    });
    if (choice) {
      session.model = choice.model;
      await refreshModelCapabilities(workspace, { provider: session.provider, model: session.model });
      rememberSession({ provider: session.provider, model: session.model });
      bannerNotes.push(describeChoice(choice));
    }
  }
  // A model without native tool calling is sent its tools as text. When the window cannot hold that text, every turn
  // would overflow before the conversation even starts, so it answers without tools unless the person asked for them.
  if (toolsEnabled && flags.tools === undefined && workspace.nativeTools === false && !textToolsFit(workspace)) {
    toolsEnabled = false;
    bannerNotes.push(
      `${session.model}'s ${windowLabel(Number(workspace.contextWindow))} window can't hold the tool instructions, so it answers without tools — /tools turns them back on`,
    );
  }
  // Reasoning stays on here; say only what is known about why it may be slow — nothing until CPU placement or a slow rate is actually seen.
  if (workspace.thinkingEnabled && workspace.thinkingSuppressed === 'unaffordable' && (workspace.cpuOnly === true || workspace.tokensPerSec !== undefined)) {
    const why = workspace.cpuOnly === true ? 'runs on CPU' : `generates at about ${Math.round(workspace.tokensPerSec!)} tokens/s`;
    bannerNotes.push(`this model reasons before it answers and ${why}, so replies can take minutes — /think hide skips the reasoning`);
  }

  // OLLAMACODE.md is read every turn; once the project has changed shape since /init wrote it, the person is told,
  // and decides whether to refresh it. It is never rewritten on its own.
  // Compared with the stacks /init records, the whole workspace's; detected only when /init has recorded any.
  const docRoot = workspace.state.root ?? root;
  if (!flags.ephemeral && loadMemory(docRoot).project.initFingerprint && projectDocStale(docRoot, await detectWorkspaceStacks(docRoot))) {
    (resumable ? resumeSafetyNotes : bannerNotes).push('the project has changed since /init wrote OLLAMACODE.md — /init refreshes it');
  }

  if (resumable) restoreWorkedProject(workspace.state, saved);
  const agentState = createAgentState();
  if (restoredPerms) {
    // An "always allow" belongs to the session that granted it. Carrying a mutating grant across a
    // resume is how a leftover plan deletes a repo with nobody asked, so only read-only grants survive.
    const carried: string[] = [];
    const dropped: string[] = [];
    for (const name of restoredPerms.alwaysAllowTools) {
      let mutating = true;
      try {
        mutating = classifyCall(name, {}, { cwd: workspace.cwd, root: workspace.cwd }) === 'mutating';
      } catch {
        mutating = true;
      }
      (mutating ? dropped : carried).push(name);
    }
    agentState.permissions.alwaysAllowTools = new Set(carried);
    if (carried.length > 0) {
      resumeSafetyNotes.push(`always-allow carried over for ${carried.join(', ')} (they change nothing)`);
    }
    if (dropped.length > 0) {
      resumeSafetyNotes.push(
        `always-allow NOT carried over for ${dropped.join(', ')} — they ask once per session (/permissions to allow again)`
      );
    }
    if (carried.length === 0 && dropped.length === 0) {
      resumeSafetyNotes.push('resumed with default permissions — everything that changes files asks');
    }
  }
  const runtime = createAgentRuntime({ provider: session.provider, model: session.model, config: cfg.agent, workspace, history, agentState });
  applyApprovalPolicy(workspace.state, { yes: resolveYes(flags), policy: cfg.permissions.risky });

  const cfgThinking = cfg.agent.thinking ?? THINKING_MODE.AUTO;
  const showReasoning: boolean | string = thinkFlag
    ? (thinkFlag === 'hide' ? false : thinkFlag)
    : !interactive || cfgThinking === THINKING_MODE.HIDE
      ? false
      : cfgThinking === THINKING_MODE.DETAILED ? 'detailed' : true;

  const { planMode } = resolvePlanMode(flags, cfg.planMode);
  // Review/ask modes come from /review or a saved session, never inferred; the flag still wins on resume.
  const reviewMode = flags.review === true || (flags.review !== false && resumable && Boolean(saved?.reviewMode));
  const askMode = resumable && Boolean((saved as any)?.askMode) && flags.review !== true;

  if (resumable && saved?.model && saved.model !== session.model) {
    logger.debug(`resume: model changed since last save: ${saved.model} → ${session.model}`);
  }

  return {
    flags, interactive, cwd, cfg, scope, session, agentState, bannerNotes, root, saved,
    resumable, claim, resumeSafetyNotes, sessionId, workspace, history, runtime,
    toolsEnabled, planMode, reviewMode, askMode, showReasoning,
    expandTools: Boolean(flags['expand-tools'] ?? cfg.ui?.expandTools ?? false),
    /** The mode the chat last told the person about; the footer shows the live one while they switch. */
    announcedMode: modeOf({ planMode, reviewMode, askMode }) as AgentMode,
    lastReadFile: null as any,
    lastOutput: null as any,
    sessionIterations: 0,
    sessionTelemetry: [] as any[],
    /** Session totals when the running turn began; null between turns. */
    turnBaseline: null as UsageTotals | null,
    turnUsage: (resumable && Array.isArray(saved?.usage?.turns) ? saved!.usage!.turns : []) as TurnUsage[],
  };
}

/** Write the session record; a failed save never fails the session. */
export function saveChat(s: ChatSession): void {
  try {
    saveSession(
      {
        version: SESSION_RECORD_VERSION,
        id: s.sessionId,
        providerId: s.session.provider.id,
        model: s.session.model,
        toolsEnabled: s.toolsEnabled,
        reviewMode: s.reviewMode,
        askMode: s.askMode,
        messages: sanitizeMessages(s.history.serialize(), isKnownTool).messages,
        ...(s.workspace.state?.subagentRuns?.length ? { subagents: s.workspace.state.subagentRuns } : {}),
        cwd: s.workspace.cwd,
        ...(s.workspace.state?.workedProject ? { workedProject: path.relative(s.workspace.state.root, s.workspace.state.workedProject.root).split(path.sep).join('/') } : {}),
        permissions: persistentPermissions(s.agentState.permissions),
        usage: { totals: usageTotals(), turns: s.turnUsage },
      },
      s.root
    );
  } catch (err) {
    logger.debug(`could not save session ${s.sessionId}: ${(err as Error).message}`);
  }
}

/** `/clear`: a fresh id starts with empty context; the old conversation is kept for /sessions, unless nothing was said in it. */
export function startNewChat(s: ChatSession): void {
  saveChat(s);
  releaseSessionClaim(s.root, s.sessionId);
  if (!readSession(s.root, s.sessionId)?.messages.length) deleteSession(s.root, s.sessionId);
  s.sessionId = newSessionId();
  s.claim = claimSession(s.root, s.sessionId).ok === true ? { id: s.sessionId } : null;
  bindSessionContext({ sessionId: s.sessionId });
  s.history.clear();
  s.workspace.state.reset();
  replaceSession(s.workspace.state, s.sessionId, 'user ran /clear');
  s.workspace.autoContext = undefined;
  s.workspace.autoContextStamp = undefined;
  s.runtime.clearCheckpoint();
  resetSessionState(s.agentState);
  // An "always allow" given in the other conversation does not carry into this one: it starts asking again.
  clearAlwaysAllow(s.agentState.permissions);
  s.sessionIterations = 0;
  s.sessionTelemetry.length = 0;
  resetUsage();
  s.turnUsage = [];
  s.lastOutput = null;
  s.lastReadFile = null;
  saveChat(s);
}

/**
 * `/sessions <n>`: carry on an earlier conversation in this window. The current one is saved first and stays in the
 * list; the earlier one comes back with default permissions, as on any resume. Returns why not, or null when done.
 */
export function switchToSession(s: ChatSession, rec: SessionRecord): string | null {
  if (rec.id === s.sessionId) return 'that is the session you are in';
  const acquired = claimSession(s.root, rec.id);
  if (acquired.ok !== true) return `it is open in another ocode window (pid ${acquired.owner.pid})`;
  saveChat(s);
  releaseSessionClaim(s.root, s.sessionId);
  if (!readSession(s.root, s.sessionId)?.messages.length) deleteSession(s.root, s.sessionId);
  s.sessionId = rec.id;
  s.claim = { id: rec.id };
  bindSessionContext({ sessionId: rec.id });
  const restored = restoreContextStore(sanitizeMessages(rec.messages ?? [], isKnownTool).messages, rec.summary);
  s.history.clear();
  const live = asCompactable(s.history);
  live.messages = restored.messages;
  live.preservedSummary = restored.preservedSummary;
  s.workspace.state.reset();
  restoreWorkedProject(s.workspace.state, rec);
  replaceSession(s.workspace.state, rec.id, 'user switched to an earlier session');
  s.workspace.autoContext = undefined;
  s.workspace.autoContextStamp = undefined;
  s.runtime.clearCheckpoint();
  resetSessionState(s.agentState);
  s.sessionIterations = 0;
  s.sessionTelemetry.length = 0;
  resetUsage(rec.usage?.totals ?? null);
  s.turnUsage = Array.isArray(rec.usage?.turns) ? rec.usage!.turns : [];
  s.lastOutput = null;
  s.lastReadFile = null;
  saveChat(s);
  return null;
}

/** The project a saved conversation was working in, back as the working project when its folder is still there. */
function restoreWorkedProject(state: any, rec: SessionRecord | null | undefined): void {
  if (!state?.root || !rec?.workedProject) return;
  const abs = path.resolve(state.root, rec.workedProject);
  if (!fs.existsSync(abs)) return;
  noteWorkIn(state, abs);
}

/** Whatever ends the process, the record is saved and the claim released; `onTerm` stops work in flight first. */
export function guardProcess(s: ChatSession, onTerm?: () => void): void {
  process.on('exit', () => { try { if (s.claim) releaseSessionClaim(s.root, s.claim.id); } catch { /* ignore */ } });
  process.on('SIGTERM', () => {
    try { onTerm?.(); } catch { /* ignore */ }
    saveChat(s);
    process.exit(143);
  });
}

export async function closeSession(s: ChatSession): Promise<void> {
  saveChat(s);
  if (s.claim) releaseSessionClaim(s.root, s.claim.id);
  s.claim = null;
  recordSessionState(s.root, { cwd: '.', turns: s.sessionIterations });
  await closeMcpServers();
}
