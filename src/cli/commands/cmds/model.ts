import { dim, icons, red, yellow } from '../../../ui/ansi';
import { rememberSession } from '../../../model/session';
import { refreshModelCapabilities, describeCapabilities, modelFitOnce } from '../../../agent/workspace/profile';
import { judgeModel } from '../../../agent/workspace/model-fit';
import { formatModelFit } from '../../chat/render';
import { CmdResult } from './types';
import { reportCard } from '../../eval-card';

export async function runModel(ctx: any, arg: string): Promise<boolean | 'exit'> {
  let models: { name: string; size?: number; }[];
  try {
    models = await ctx.session.provider.listModels();
  } catch (err) {
    ctx.write(`${red(`  could not list models: ${(err as Error).message}`)}\n`);
    return CmdResult.HANDLED;
  }
  const names = models.map((m) => m.name);
  let picked: any = null;
  if (arg.trim()) {
    const wanted = String(arg).trim();
    if (names.includes(wanted)) picked = wanted;
    else {
      ctx.write(`${red(`  unknown model "${wanted}"`)}${dim(` — available: ${names.slice(0, 12).join(', ')}`)}\n`);
      return CmdResult.HANDLED;
    }
  } else {
    const shown = models.slice(0, 20);
    const fits = await pickerFits(ctx.session.provider, shown.map((m) => m.name));
    picked = await ctx.select(
      'Model:',
      shown.map((m) => ({ label: m.name, value: m.name, hint: fits.get(m.name) }))
    );
  }
  if (picked) {
    ctx.session.model = String(picked);
    await refreshModelCapabilities(ctx.workspace, {
      provider: ctx.session.provider,
      model: ctx.session.model,
    });
    rememberSession({ provider: ctx.session.provider, model: ctx.session.model });
    ctx.persist();
    const caps = describeCapabilities(ctx.workspace);
    const capsText = ctx.workspace.nativeTools === false ? yellow(`${icons.warn} ${caps}`) : dim(caps);
    ctx.write(`  model → ${ctx.session.model} · ${capsText}\n`);
    const fit = modelFitOnce(ctx.workspace);
    if (fit) ctx.write(`  ${formatModelFit(fit)}\n`);
    const card = reportCard(ctx.session.model);
    if (card) ctx.write(`${dim(`  eval report card: ${card}`)}\n`);
  }
  return CmdResult.HANDLED;
}

/** Waiting longer than this for model details leaves the picker unmarked rather than slow. */
const PICKER_INFO_MS = 3000;
const FIT_HINT = { ready: 'ready for coding', limited: 'limited for coding', unsuited: 'not suited for coding' } as const;

// A picker hint per model from what the backend declares; CPU placement is only known once a model runs, so it is left out here.
async function pickerFits(provider: any, names: string[]): Promise<Map<string, string>> {
  const fits = new Map<string, string>();
  if (typeof provider?.modelInfo !== 'function') return fits;
  const lookups = names.map(async (name) => {
    const info = await provider.modelInfo(name).catch(() => ({}));
    const verdict = judgeModel({ model: name, nativeTools: info.supportsTools, parameterSize: info.parameterSize, contextLength: info.contextLength, remote: info.remote });
    fits.set(name, [info.parameterSize, FIT_HINT[verdict.fit]].filter(Boolean).join(' · '));
  });
  await Promise.race([Promise.allSettled(lookups), new Promise((resolve) => setTimeout(resolve, PICKER_INFO_MS).unref?.())]);
  return fits;
}
