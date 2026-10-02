import { dim, green, icons, red, yellow } from '../../../ui/ansi';
import { probeProviders, resolveModel, rememberSession } from '../../../model/session';
import { refreshModelCapabilities, describeCapabilities, modelFitOnce } from '../../../agent/workspace/profile';
import { formatModelFit } from '../../chat/render';
import { AGENT_STATE } from '../../../protocol';
import { getProvider } from '../../../model/providers/registry';
import { parseProviderMode, type ProviderMode } from '../../../model/providers/mode';
import { ollamaCloudProvider } from '../../../model/providers/ollama-cloud';
import { loadConfig, updateConfig } from '../../../core/config';
import { CmdResult } from './types';

export async function runProvider(ctx: any, arg: string): Promise<boolean | 'exit'> {
  const want = String(arg ?? '').trim().toLowerCase();
  if (want === 'cloud' || want === 'local') {
    return switchOllamaBackend(ctx, want);
  }
  const statuses = await probeProviders();
  if (want) {
    const named = getProvider(want);
    if (!named) {
      ctx.write(`${dim(`  no provider called "${want}" — try one of: ${statuses.map((s) => s.provider.id).join(', ')}`)}\n`);
      return CmdResult.HANDLED;
    }
    return pickProvider(ctx, named, statuses.find((s) => s.provider.id === named.id)?.status);
  }
  // Unavailable providers stay on the list: one that only lacks a token is set up by choosing it.
  const picked = await ctx.select(
    'Provider:',
    statuses.map(({ provider, status }) => ({
      label: provider.label,
      value: provider.id,
      hint: status.available ? status.detail : `not ready: ${status.detail}`,
    }))
  );
  const chosen = picked ? getProvider(String(picked)) : null;
  if (!chosen) return CmdResult.HANDLED;
  return pickProvider(ctx, chosen, statuses.find((s) => s.provider.id === chosen.id)?.status);
}

/** A provider that cannot sign in on its own (a stopped Ollama) is refused with its reason; one that asks for a token gets to ask. */
async function pickProvider(ctx: any, chosen: import('../../../types.ts').ProviderDef, status?: import('../../../types.ts').ProviderDetect): Promise<boolean | 'exit'> {
  if (status && !status.available && !chosen.ensureAuth) {
    ctx.write(`${red(`  ${chosen.label} is not available: ${status.detail}`)}\n${dim('  provider unchanged')}\n`);
    return CmdResult.HANDLED;
  }
  if (ctx.agentState.state !== AGENT_STATE.IDLE) {
    ctx.write(`${dim(`  switching provider — preserving pending plan (${ctx.agentState.state}) and permissions`)}\n`);
  }
  return switchToProvider(ctx, chosen);
}

/** The token prompt and model picker read the terminal themselves; the chat prompt must not take the keys meanwhile. */
async function holdingTerminal<T>(ctx: any, fn: () => Promise<T>): Promise<T> {
  ctx.suspendInput?.();
  ctx.pauseRender?.();
  try {
    return await fn();
  } finally {
    ctx.resumeRender?.();
    ctx.resumeInput?.();
  }
}

async function switchToProvider(ctx: any, chosen: import('../../../types.ts').ProviderDef): Promise<boolean | 'exit'> {
  try {
    await holdingTerminal(ctx, () => chosen.ensureAuth?.({ interactive: ctx.interactive }));
    let model;
    try {
      // Non-interactive: nobody can answer the model picker, so keep the session's model when the new provider offers it.
      const offered = !ctx.interactive ? await chosen.listModels().catch((): null => null) : null;
      const keep = offered?.some((m: any) => m.name === ctx.session.model) ? ctx.session.model : undefined;
      model = keep ?? await holdingTerminal(ctx, () => resolveModel(chosen, { interactive: ctx.interactive }));
    } catch {
      const models = await chosen.listModels();
      model = await ctx.select(
        `Model for ${chosen.label}:`,
        models.slice(0, 20).map((m) => ({ label: m.name, value: m.name }))
      );
    }
    if (!model) {
      ctx.write(`${yellow('  no model selected — provider unchanged')}\n`);
      return CmdResult.HANDLED;
    }
    ctx.session.provider = chosen;
    ctx.session.model = String(model);
    await refreshModelCapabilities(ctx.workspace, { provider: chosen, model: ctx.session.model });
    // Switching backend keeps the conversation; /clear is the way to start fresh.
    rememberSession({ provider: chosen, model: ctx.session.model });
    ctx.persist();
    {
      const caps = describeCapabilities(ctx.workspace);
      const capsText = ctx.workspace.nativeTools === false ? yellow(`${icons.warn} ${caps}`) : dim(caps);
      ctx.write(`  provider → ${chosen.label} · ${ctx.session.model} · ${capsText}\n`);
      const fit = modelFitOnce(ctx.workspace);
      if (fit) ctx.write(`  ${formatModelFit(fit)}\n`);
    }
  } catch (err) {
    ctx.write(`${red(`  provider switch failed: ${(err as Error).message}`)}\n`);
  }
  return CmdResult.HANDLED;
}

/** `/provider cloud|local`: set the Ollama backend preference and switch to it now. */
async function switchOllamaBackend(ctx: any, which: 'cloud' | 'local'): Promise<boolean | 'exit'> {
  const mode: ProviderMode = which === 'cloud' ? 'cloud-first' : 'local-first';
  const def = getProvider(which === 'cloud' ? 'ollama-cloud' : 'ollama');
  if (!def) return CmdResult.HANDLED;
  if (which === 'cloud') {
    const { status, detail } = await ollamaCloudProvider.cloudStatus();
    if (status !== 'available') {
      ctx.write(`${red(`  Ollama Cloud ${status}: ${detail}`)}\n${dim('  provider unchanged')}\n`);
      return CmdResult.HANDLED;
    }
  } else {
    const status = await def.detect();
    if (!status.available) {
      ctx.write(`${red(`  local Ollama unavailable: ${status.detail}`)}\n${dim('  provider unchanged')}\n`);
      return CmdResult.HANDLED;
    }
  }
  updateConfig((c) => {
    c.providerMode = mode;
  });
  ctx.write(`${green(`  provider mode → ${mode}`)}${dim(' — saved to config.json')}\n`);
  return switchToProvider(ctx, def);
}

export function currentProviderMode(): ProviderMode {
  return parseProviderMode(loadConfig().providerMode);
}
