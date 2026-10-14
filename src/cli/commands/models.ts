import { probeProviders, formatModelSize, byPrice } from '../../model/session';
import { priceFlag, type TypedFlags } from '../flags';
import { loadConfig } from '../../core/config';
import { resolveProviderId } from '../../model/providers/registry';
import { bold, dim, green, red, icons } from '../../ui/ansi';
import { withProgress } from '../../ui/progress';

const MAX_SHOWN = 25;

export async function run(flags: Pick<TypedFlags, 'provider' | 'free' | 'paid'>) {
  const cfg = loadConfig();
  const price = priceFlag(flags);
  const wanted = flags.provider ? resolveProviderId(flags.provider) : null;

  const statuses = await withProgress('probing providers', () => probeProviders(), {
    successText: (s) => {
      const up = s.filter((p) => p.status.available).length;
      return `probed ${s.length} provider${s.length === 1 ? '' : 's'} — ${up} reachable`;
    },
  });
  const targets = wanted ? statuses.filter((s) => s.provider.id === wanted) : statuses;

  if (targets.length === 0) {
    process.stdout.write(`${red(`  no provider matching "${flags.provider}"`)}\n`);
    process.exitCode = 1;
    return;
  }

  for (const { provider, status } of targets) {
    const hostHint = provider.id === 'ollama' && process.env.OLLAMA_HOST ? dim(` @ ${process.env.OLLAMA_HOST}`) : '';
    process.stdout.write(`\n${bold(provider.label)}${hostHint} ${dim(status.detail)}\n`);

    if (!status.available) {
      process.stdout.write(`  ${dim('unavailable — skipping')}\n`);
      continue;
    }

    try {
      const listed = await withProgress(`listing ${provider.label} models`, () => provider.listModels(), {
        successText: (m) => `found ${m.length} model${m.length === 1 ? '' : 's'} on ${provider.label}`,
      });
      const { models, priced } = byPrice(listed, price);
      if (price && !priced) {
        process.stdout.write(`  ${dim(`${provider.label} does not say which models are free — skipping`)}\n`);
        continue;
      }
      if (price && models.length === 0) {
        process.stdout.write(`  ${dim(`(no ${price} models)`)}\n`);
        continue;
      }
      if (models.length === 0) {
        process.stdout.write(`  ${dim('(no models installed)')}\n`);
        if (provider.id === 'ollama') {
          process.stdout.write(`  ${dim('install one with: ollama pull qwen2.5-coder:7b')}\n`);
        }
        continue;
      }
      for (const model of models.slice(0, MAX_SHOWN)) {
        const active = cfg.models[provider.id] === model.name ? ` ${green('← default')}` : '';
        const size = formatModelSize(model.size);
        const free = model.free && price !== 'free' ? ` ${green('free')}` : '';
        process.stdout.write(`  ${icons.bullet} ${model.name}${size ? ` ${dim(`(${size})`)}` : ''}${free}${active}\n`);
      }
      if (models.length > MAX_SHOWN) {
        process.stdout.write(`  ${dim(`…and ${models.length - MAX_SHOWN} more`)}\n`);
      }
    } catch (err) {
      process.stdout.write(`  ${red(`${icons.fail} ${ (err as Error).message}`)}\n`);
    }
  }
  process.stdout.write('\n');
}

