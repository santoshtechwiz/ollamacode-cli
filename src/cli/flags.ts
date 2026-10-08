import { isThinkingMode } from '../protocol';

/** Strongly typed view over the loose `Record<string, string | boolean>` every command receives. */
export interface TypedFlags {
  provider?: string;
  model?: string;
  token?: string;
  log?: string;
  timeout?: string;
  scope?: string;
  root?: string;
  cwd?: string;
  ctx?: string;
  'max-tokens'?: string;
  continue?: boolean;
  yes?: boolean;
  help?: boolean;
  debug?: boolean;
  tools?: boolean;
  plan?: boolean;
  review?: boolean;
  fix?: boolean;
  new?: boolean;
  version?: boolean;
  all?: boolean;
  staged?: boolean;
  think?: string | boolean;
  check?: boolean;
  'expand-tools'?: boolean;
  project?: boolean;
  prompt?: string;
  /** Run without a saved conversation: nothing is resumed or written, and the project's last session is left alone. Set by `ocode init`. */
  ephemeral?: boolean;
  [key: string]: string | boolean | undefined;
}

/** Chat runs from `root` unless `--scope|--root|--cwd` says otherwise. */
export function resolveScope(flags: Pick<TypedFlags, 'scope' | 'root' | 'cwd'>): string | undefined {
  return flags.scope ?? flags.root ?? flags.cwd;
}

/** `--think` is boolean-or-string: bare → `true` ("show"), `=mode` or `<mode>` → the mode string, `=false` → `false`. */
export function resolveThinkFlag(flags: Pick<TypedFlags, 'think'>): string | boolean | null {
  const t = flags.think;
  if (typeof t === 'string') return t;
  if (t === true) return 'show';
  if (t === false) return 'hide';
  return null;
}

/** `--plan`/`--no-plan`/`--plan=false` win; otherwise the stored default. */
export function resolvePlanMode(
  flags: Pick<TypedFlags, 'plan'>,
  cfgPlanMode: boolean | undefined
): { planMode: boolean } {
  if (flags.plan === true) return { planMode: true };
  if (flags.plan === false) return { planMode: false };
  return { planMode: Boolean(cfgPlanMode) };
}

export function resolveYes(flags: Pick<TypedFlags, 'yes'>): boolean {
  return Boolean(flags.yes);
}

export function resolveContextWindow(flags: Pick<TypedFlags, 'ctx'>): number | undefined {
  return flags.ctx !== undefined ? Number(flags.ctx) : undefined;
}

export function resolveMaxTokens(flags: Pick<TypedFlags, 'max-tokens'>): number | undefined {
  return flags['max-tokens'] !== undefined ? Number(flags['max-tokens']) : undefined;
}

/** `--no-project` arrives as `project: false` via Citty's `no-` negation rule for boolean flags — there is no separate `no-project` key to check. */
export function resolveWantProjectMemory(flags: Pick<TypedFlags, 'project'>): boolean {
  return flags.project !== false;
}

export function resolveThinkingPreference(
  thinkFlag: string | boolean | null
): string | undefined {
  const v = typeof thinkFlag === 'boolean' ? (thinkFlag ? 'show' : 'hide') : thinkFlag;
  return v && isThinkingMode(v) ? v : undefined;
}
