import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { probeProviders, resolveModel } from '../../model/session';
import { getProvider, resolveProviderId, knownProviderIds } from '../../model/providers/registry';
import { updateConfig, loadConfig, configFile } from '../../core/config';
import { detectWorkspaceStacks } from '../../env/tooling/detector';
import {
  claudeMdFile,
  memoryDirName,
  memoryFile,
  projectFingerprint,
  fingerprintMatches,
  seedMemoryFromStacks,
  summarizeMemory,
} from '../../context/memory';
import { select, confirm, isInteractive } from '../../ui/prompts';
import { bold, dim, green, red, cyan, yellow, icons } from '../../ui/ansi';
import { resolveWantProjectMemory } from '../flags';
import { withProgress } from '../../ui/progress';
import { TcError } from '../../core/errors';
import { statType } from '../../tool/filesystem/_fs';
import { run as runOneShot } from '../chat/repl';
import { writeProjectDoc, isEffectivelyEmpty } from './project-doc';

// Model-driven write of OLLAMACODE.md lives in ./project-doc.ts so this flow can be reached without a cycle.

export async function run(flags: any) {
  const interactive = isInteractive() && !flags.yes;
  process.stdout.write(`\n${bold('  ocode init — detecting LLM backends…')}\n\n`);

  const statuses = await withProgress('probing providers', () => probeProviders(), {
    successText: (s) => {
      const up = s.filter((p) => p.status.available).length;
      return `probed ${s.length} backend${s.length === 1 ? '' : 's'} — ${up} reachable`;
    },
  });
  for (const { provider, status } of statuses) {
    const mark = status.available ? green(icons.ok) : red(icons.fail);
    process.stdout.write(`  ${mark} ${provider.label.padEnd(16)} ${dim(status.detail)}\n`);
  }

  let providerId = flags.provider ? resolveProviderId(flags.provider) : undefined;

  if (providerId && !getProvider(providerId)) {
    throw new TcError(
      `Unknown provider "${flags.provider}". Available: ${knownProviderIds().join(', ')}`,
      { code: 'EPROVIDER_UNKNOWN' }
    );
  }

  if (!providerId) {
    const available = statuses.filter((s) => s.status.available);
    if (available.length === 0) {
      process.stdout.write(
        `\n  No backend is reachable.\n` +
          `    ${cyan('Ollama')}        install from ollama.com, then: ollama pull qwen2.5-coder:7b\n` +
          `    ${cyan('Ollama Cloud')}  create a key at ollama.com/settings/keys, then:\n` +
          `                   ocode init --provider ollama-cloud --token <key>\n` +
          `    ${cyan('HuggingFace')}   create a token at huggingface.co/settings/tokens\n` +
          `                   (enable "Make calls to Inference Providers"), then:\n` +
          `                   ocode init --provider hf --token hf_...\n\n`
      );
      process.exitCode = 1;
      return;
    }

    if (available.length > 1 && interactive) {
      const picked = await select(
        'Which backend should ocode use?',
        available.map(({ provider, status }: any) => ({
          label: provider.label,
          value: provider.id,
          hint: status.detail,
        }))
      );
      providerId = picked ? String(picked) : available[0].provider.id;
    } else {
      providerId = available[0].provider.id;
    }
  }

  const provider = getProvider(providerId);
  if (!provider) throw new TcError(`Unknown provider "${providerId}"`, { code: 'EPROVIDER_UNKNOWN' });

  const needsToken = Boolean( (provider as any).tokenEnvVar);
  if (flags.token && !needsToken) {
    process.stdout.write(`${dim(`  note: --token is not used by ${provider.label}; ignoring it`)}\n`);
  }

  await provider.ensureAuth?.({
    interactive,
    token: needsToken ? flags.token : undefined,
  });

  let model;
  try {
    model = await resolveModel(provider, { model: flags.model, interactive: interactive && !flags.model });
  } catch (err) {
    process.stdout.write(`\n  ${red(icons.warn)} ${ (err as Error).message}\n`);
    process.exitCode = 1;
    return;
  }

  updateConfig((c) => {
    c.activeProvider = provider.id;
    c.models[provider.id] = model;
  });

  const providerInfo = (provider as any);
  if (typeof providerInfo.modelInfo === 'function') {
    const meta = await providerInfo.modelInfo(model).catch((): null => null);
    if (meta?.supportsTools === false) {
      process.stdout.write(
        `\n  ${yellow(icons.warn)} ${model} has no native tool-calling support — ocode falls back to parsing ` +
          `tool calls out of the model's text, which is noticeably less reliable (missed calls, invented ` +
          `results). Pick a tool-calling model if one is available, or expect to confirm its work more closely.\n`
      );
    }
  }

  const { tokens } = loadConfig();
  const persisted = Boolean(tokens?.[provider.id]);
  const fromEnv =
    needsToken && !persisted && Boolean(process.env[ (provider as any).tokenEnvVar]);

  let memoryNote = '';
  const wantProjectMemory = resolveWantProjectMemory(flags);
  if (wantProjectMemory) {
    try {
      const root = process.cwd();
      const stacks = await withProgress('detecting project stack', () => detectWorkspaceStacks(root), {
        successText: (s) =>
          s.length > 0
            ? `detected ${s.map((t) => t.label).filter(Boolean).join(', ') || `${s.length} toolchains`}`
            : 'no known toolchains detected',
      });
      const { created, mem } = seedMemoryFromStacks(root, stacks);
      memoryNote =
        `    project    ${summarizeMemory(mem)}\n` +
        `               ${dim(memoryFile(root))}${created ? dim(' (new)') : ''}\n`;

       const fingerprint = projectFingerprint(stacks, root);
      const claudeMdExists = (await statType(claudeMdFile(root)))?.type === 'file';
      if (claudeMdExists && fingerprintMatches(mem.project.initFingerprint, stacks, root)) {
        memoryNote += `    OLLAMACODE.md  up to date — matches the current project\n`;
      } else if (!claudeMdExists && (await isEffectivelyEmpty(root))) {
        memoryNote += `    OLLAMACODE.md  skipped — project is empty, nothing to document yet\n`;
      } else {
         let regenerate = Boolean(flags.yes) || !claudeMdExists;
         if (claudeMdExists) {
          const reason = mem.project.initFingerprint
            ? 'the detected stack/commands no longer match what init recorded'
            : 'there is no init record for it';
           if (interactive && !flags.yes) {
            try {
              regenerate = await confirm(
                `\n  ${yellow(icons.warn)} OLLAMACODE.md does not match the current project (${reason}). Overwrite it?`,
                false
              );
            } catch {
              regenerate = false; // no prompt channel: decline, never clobber
            }
          }
          if (!regenerate) {
            process.stdout.write(`${dim('  kept the existing OLLAMACODE.md — nothing changed')}\n`);
          }
        }
        if (regenerate) {
        process.stdout.write(`\n  ${cyan(icons.arrow)} inspecting the project to ${claudeMdExists ? 'update' : 'write'} OLLAMACODE.md…\n`);
        // /init is itself the approval to write OLLAMACODE.md — never plan-gate it.
        const outcome = await writeProjectDoc(
          root,
          stacks,
          claudeMdExists,
          fingerprint,
          (prompt) => runOneShot({ prompt, yes: flags.yes, provider: provider.id, model, plan: false, ephemeral: true }),
          (text) => process.stdout.write(text)
        );
        if (outcome === 'written') {
          memoryNote += `    OLLAMACODE.md  ${dim(claudeMdFile(root))}${claudeMdExists ? '' : dim(' (new)')}\n`;
        } else if (outcome === 'cancelled') {
          memoryNote += `    OLLAMACODE.md  stopped — nothing was written\n`;
        } else {
          memoryNote += `    ${yellow(icons.warn)} model explored the project but did not write OLLAMACODE.md, even after a retry — run ocode chat and try "write OLLAMACODE.md" directly\n`;
        }
        }
      }

      const isGitRepo = (await statType(path.join(root, '.git')))?.type === 'dir';
      if (isGitRepo) {
        const dirName = memoryDirName();
        const gitignorePath = path.join(root, '.gitignore');
        const existing = await readFile(gitignorePath, 'utf8').catch((): null => null);
        const ignoreRule = /(^|\n)\s*\/?\.ollamacode\/?\s*(\n|$)/;
        const alreadyIgnored = existing !== null && ignoreRule.test(existing);
        if (!alreadyIgnored) {
          let add = true;
          if (interactive) {
            try {
              add = await confirm(
                `  ${cyan(icons.arrow)} Add ${dirName}/ to .gitignore? It holds full session transcripts.`,
                true
              );
            } catch {
            }
          }
          if (add) {
            const body = existing ?? '';
            const sep = body && !body.endsWith('\n') ? '\n' : '';
            await writeFile(gitignorePath, `${body}${sep}${dirName}/\n`);
            memoryNote += `    .gitignore ${dim(`added ${dirName}/`)}\n`;
          }
        }
      }
    } catch (err) {
      process.stdout.write(
        `${dim(`  note: could not seed project memory: ${ (err as Error).message}`)}\n`
      );
    }
  }

  process.stdout.write(
    `\n  ${green(`${icons.ok} Ready`)}\n` +
      `    provider   ${provider.label}\n` +
      `    model      ${model}\n` +
      `    config     saved to ${configFile()}\n` +
      memoryNote +
      (needsToken
        ? `    token      ${persisted ? 'saved' : fromEnv ? `from ${ (provider as any).tokenEnvVar} (not saved)` : 'not set'}\n`
        : '') +
      '\n' +
      (fromEnv
        ? `  ${yellow(icons.warn)} The token came from the environment, so it was not saved.\n` +
          `    Outside this shell (or this directory's .env) ocode will not find it.\n` +
          `    To store it: ${dim(`ocode init --provider ${provider.id} --token ...`)}\n\n`
        : '') +
      `  Next:\n` +
      `    ${dim('ocode chat')}                 interactive session\n` +
      `    ${dim('echo "list src files" | ocode')} one-shot task\n\n`
  );
}

