import fs from 'node:fs';
import path from 'node:path';

import { loadConfig, configFile, updateConfig } from '../../core/config';
import { escapeRegExp } from '../../core/text-utils';
import { probeProviders } from '../../model/session';
import { reportCard } from '../eval-card';
import { discoverUserProviders, getProvider, knownProviderIds } from '../../model/providers/registry';
import { resolveShell } from '../../tool/process/shell/runtime';
import { checkToolchains } from '../../env/tooling/manager';
import {
  contextFitCheck,
  diskCheck,
  envDriftCheck,
  modelToolsCheck,
} from '../../env/ollama-tuning';
import { findProjectDoc, memoryDir } from '../../context/memory';
import { confirm, isInteractive } from '../../ui/prompts';
import { bold, dim, green, red, yellow, cyan, icons } from '../../ui/ansi';
import { withProgress } from '../../ui/progress';

export interface Check {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  message: string;
  fix?: () => Promise<boolean>;
}

function isValidJsonFile(file: string) {
  try {
    JSON.parse(fs.readFileSync(file, 'utf8'));
    return true;
  } catch {
    return false;
  }
}

export async function run(flags: any) {
  const interactive = isInteractive() && !flags.yes;
  const autoFix = flags.fix === true;
  const cfg = loadConfig();
  const cwd = process.cwd();

  process.stdout.write(`\n${bold('  ocode doctor')}  ${dim(configFile())}\n\n`);

  await discoverUserProviders();

  const checks: any[] = [];

  const cfgPath = configFile();
  const cfgExists = fs.existsSync(cfgPath);
  if (!cfgExists) {
    checks.push({
      name: 'config',
      status: 'warn',
      message: 'config.json does not exist yet',
      fix: async () => {
        fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
        updateConfig(() => {}); // writes defaults
        return true;
      },
    });
  } else if (!isValidJsonFile(cfgPath)) {
    checks.push({
      name: 'config',
      status: 'fail',
      message: 'config.json is not valid JSON',
      fix: async () => {
        const backup = `${cfgPath}.broken.${Date.now()}`;
        fs.copyFileSync(cfgPath, backup);
        updateConfig(() => {}); // rewrites with defaults merged over empty
        return true;
      },
    });
  } else {
    checks.push({ name: 'config', status: 'ok', message: 'config.json is valid' });
  }

  const providerId = cfg.activeProvider;
  if (!providerId) {
    checks.push({
      name: 'provider',
      status: 'fail',
      message: 'no active provider — run "ocode init"',
    });
  } else if (!getProvider(providerId)) {
    checks.push({
      name: 'provider',
      status: 'fail',
      message: `saved provider "${providerId}" is unknown (${knownProviderIds().join(', ')})`,
    });
  } else {
    const statuses = await withProgress('probing providers', () => probeProviders());
    const status = statuses.find((s) => s.provider.id === providerId);
    if (status?.status.available) {
      checks.push({ name: 'provider', status: 'ok', message: `${status.provider.label} is reachable` });
    } else {
      checks.push({
        name: 'provider',
        status: 'fail',
        message: `${getProvider(providerId)?.label ?? providerId} is not reachable: ${status?.status.detail ?? 'unavailable'}`,
      });
    }
  }

  const activeProviderId = cfg.activeProvider;
  const provider = activeProviderId ? getProvider(activeProviderId) : null;
  if (provider && activeProviderId) {
    const model = flags.model ? String(flags.model) : cfg.models[activeProviderId];
    if (!model) {
      checks.push({
        name: 'model',
        status: 'fail',
        message: `no model saved for ${provider.label}`,
      });
    } else {
      try {
        const models = await withProgress('listing models', () => provider.listModels());
        if (models.some((m) => m.name === model)) {
          checks.push({ name: 'model', status: 'ok', message: `${model} is available` });
          const card = reportCard(model);
          checks.push({ name: 'eval', status: 'ok', message: card ? `report card: ${card}` : `not measured yet — npm run eval -- --model ${model}` });
        } else {
          checks.push({
            name: 'model',
            status: 'warn',
            message: `${model} is not reported by ${provider.label}`,
          });
        }
      } catch (err) {
        checks.push({
          name: 'model',
          status: 'warn',
          message: `could not list models: ${ (err as Error).message}`,
        });
      }
    }

    const tokenEnvVar = (provider as any).tokenEnvVar;
    if (tokenEnvVar) {
      const token = cfg.tokens?.[activeProviderId] ?? process.env[tokenEnvVar];
      if (!token) {
        checks.push({
          name: 'auth',
          status: 'fail',
          message: `${provider.label} token is missing`,
        });
      } else {
        try {
          await provider.ensureAuth({ interactive: false, token });
          checks.push({ name: 'auth', status: 'ok', message: `${provider.label} token is valid` });
        } catch (err) {
          checks.push({
            name: 'auth',
            status: 'fail',
            message: `${provider.label} token is invalid: ${ (err as Error).message}`,
          });
        }
      }
    } else {
      checks.push({ name: 'auth', status: 'ok', message: `${provider.label} needs no token` });
    }
  }

  try {
    const shell = resolveShell();
    checks.push({ name: 'shell', status: 'ok', message: `using ${shell.kind} (${path.basename(shell.file)})` });
  } catch (err) {
    checks.push({
      name: 'shell',
      status: 'fail',
      message: `could not resolve a shell: ${ (err as Error).message}`,
    });
  }

  const toolingReport = await withProgress('checking toolchains', () =>
    checkToolchains(['git', 'node', 'python', 'dotnet', 'terraform', 'go', 'rust'])
  );
  for (const t of toolingReport.toolchains) {
    checks.push({
      name: t.id,
      status: t.available ? 'ok' : 'warn',
      message: t.available
        ? `${t.command ?? t.id} found on PATH${t.version ? ` (${t.version})` : ''}`
        : `${t.id} not found on PATH`,
    });
  }

  if (activeProviderId === 'ollama') {
    checks.push(envDriftCheck());
    checks.push(diskCheck());

    const fit = contextFitCheck(cfg, updateConfig);
    if (fit) checks.push(fit);

    const ollamaModel = cfg.models?.ollama;
    if (ollamaModel && provider) {
      const tools = await modelToolsCheck(ollamaModel, provider);
      if (tools) checks.push(tools);
    }
  }

  const memDir = memoryDir(cwd);
  const memExists = fs.existsSync(memDir);
  if (memExists) {
    checks.push({ name: 'memory', status: 'ok', message: `project memory at ${path.relative(cwd, memDir) || '.'}` });
  } else {
    checks.push({
      name: 'memory',
      status: 'warn',
      message: 'no project memory yet — run "ocode init" or "/init" in chat',
    });
  }

  // Same walk the turn uses, so `doctor` cannot report a doc missing that the agent is reading — or the other way round.
  const claudeMd = findProjectDoc(cwd);
  if (claudeMd) {
    checks.push({ name: 'OLLAMACODE.md', status: 'ok', message: `found ${path.relative(cwd, claudeMd)}` });
  } else {
    checks.push({
      name: 'OLLAMACODE.md',
      status: 'warn',
      message: 'OLLAMACODE.md not found — run "/init" in chat to create it',
    });
  }

  const gitDir = path.join(cwd, '.git');
  if (fs.existsSync(gitDir)) {
    const gitignore = path.join(cwd, '.gitignore');
    const dirName = path.basename(memDir);
    const rule = new RegExp(`(^|\\n)\\s*\\/?${escapeRegExp(dirName)}\\/?\\s*(\\n|$)`);
    const existing = fs.existsSync(gitignore) ? fs.readFileSync(gitignore, 'utf8') : '';
    if (rule.test(existing)) {
      checks.push({ name: '.gitignore', status: 'ok', message: `${dirName}/ is ignored` });
    } else {
      checks.push({
        name: '.gitignore',
        status: 'warn',
        message: `${dirName}/ is not ignored in .gitignore`,
        fix: async () => {
          const body = existing ?? '';
          const sep = body && !body.endsWith('\n') ? '\n' : '';
          fs.writeFileSync(gitignore, `${body}${sep}${dirName}/\n`);
          return true;
        },
      });
    }
  }

  const ok = checks.filter((c) => c.status === 'ok').length;
  const warn = checks.filter((c) => c.status === 'warn').length;
  const fail = checks.filter((c) => c.status === 'fail').length;

  for (const c of checks) {
    const icon = c.status === 'ok' ? green(icons.ok) : c.status === 'warn' ? yellow(icons.warn) : red(icons.fail);
    const label = c.status === 'ok' ? dim(c.name.padEnd(12)) : c.status === 'warn' ? yellow(c.name.padEnd(12)) : red(c.name.padEnd(12));
    process.stdout.write(`  ${icon} ${label} ${c.message}\n`);
  }

  process.stdout.write(`\n  ${green(`${ok} ok`)} · ${yellow(`${warn} warnings`)} · ${red(`${fail} failures`)}\n`);

  const fixable = checks.filter((c) => typeof c.fix === 'function');
  if (fixable.length > 0) {
    process.stdout.write(`\n  ${cyan('Fixable issues:')}\n`);
    for (const c of fixable) {
      process.stdout.write(`    ${yellow(icons.warn)} ${c.name}: ${c.message}\n`);
    }

    let apply = autoFix;
    if (!autoFix && interactive) {
      try {
        apply = await confirm('Apply safe fixes?', false);
      } catch {
        apply = false;
      }
    }

    if (apply) {
      process.stdout.write(`\n`);
      for (const c of fixable) {
        try {
          const ok2 = await (c.fix as () => Promise<boolean>)();
          process.stdout.write(`  ${ok2 ? green(icons.ok) : yellow(icons.warn)} fixed ${c.name}\n`);
        } catch (err) {
          process.stdout.write(`  ${red(icons.fail)} could not fix ${c.name}: ${ (err as Error).message}\n`);
        }
      }
    } else if (!autoFix) {
      process.stdout.write(`\n  ${dim('Run with --fix to apply these automatically.')}\n`);
    }
  }

  if (fail > 0) {
    process.stdout.write(`\n  ${bold('Next steps:')}\n`);
    if (checks.some((c) => c.name === 'provider' && c.status === 'fail')) {
      process.stdout.write(`    ${cyan('→')} run ${dim('ocode init')} to set up a provider and model\n`);
    }
    if (checks.some((c) => c.name === 'auth' && c.status === 'fail')) {
      process.stdout.write(`    ${cyan('→')} run ${dim('ocode init --provider hf --token hf_...')} to save a token\n`);
    }
    if (checks.some((c) => c.name === 'config' && c.status === 'fail')) {
      process.stdout.write(`    ${cyan('→')} a backup was saved and config.json was rewritten with defaults\n`);
    }
  }

  process.stdout.write(`\n`);
  if (fail > 0) process.exitCode = 1;
}
