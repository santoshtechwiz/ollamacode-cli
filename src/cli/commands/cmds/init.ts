import { cyan, dim, green, icons, red, yellow } from '../../../ui/ansi';
import { detectStacks } from '../../../env/tooling/detector';
import { logger } from '../../../core/logger';
import { claudeMdFile, loadMemory, projectFingerprint, seedMemoryFromStacks } from '../../../context/memory';
import { statType } from '../../../tool/filesystem/_fs';
import { writeProjectDoc, isEffectivelyEmpty } from '../project-doc';
import { modeOf, setMode } from '../../chat/mode';
import { CmdResult } from './types';

export async function runInit(ctx: any): Promise<boolean | 'exit'> {
  const root = ctx.workspace.state.root;
  try {
    const stacks = await detectStacks(root);
    const fingerprint = projectFingerprint(stacks, root);
    const claudeMd = claudeMdFile(root);
    const exists = (await statType(claudeMd))?.type === 'file';
    const mem = loadMemory(root);
    const prevFingerprint = mem.project.initFingerprint;

    if (exists && prevFingerprint && prevFingerprint === fingerprint) {
      ctx.write(
        `${green(icons.ok)} OLLAMACODE.md matches the current project — nothing to change\n` +
          `${dim('  (run /init again only after the project actually changes)')}\n`
      );
      return CmdResult.HANDLED;
    }

    if (!exists && (await isEffectivelyEmpty(root))) {
      ctx.write(`${dim('  the project is empty — nothing to document yet; run /init once there is code')}\n`);
      return CmdResult.HANDLED;
    }

    if (exists) {
      const reason = prevFingerprint
        ? 'the detected stack/commands no longer match what /init recorded'
        : 'there is no /init record for it';
      let proceed = false;
       if (ctx.flags?.yes) {
         proceed = true;
       } else {
         try {
           proceed = await ctx.confirm(
             `${yellow(icons.warn)} OLLAMACODE.md does not match the current project (${reason}). Overwrite it?`,
             false
           );
         } catch (err) {
           logger.warn(`/init could not confirm overwrite (${(err as Error).message}); declining`);
         }
       }
      if (!proceed) {
        ctx.write(`${dim('  kept the existing OLLAMACODE.md — nothing changed')}\n`);
        return CmdResult.HANDLED;
      }
    }

    ctx.write(`${cyan(icons.arrow)} inspecting the project to ${exists ? 'update' : 'write'} OLLAMACODE.md…\n`);
    seedMemoryFromStacks(root, stacks);
    // /init is itself the approval to write OLLAMACODE.md: its turn runs in Agent mode whatever mode the chat is in
    // (Plan would gate it, Ask and Review would refuse the write), and the person's mode comes back afterwards.
    const savedMode = modeOf(ctx);
    setMode(ctx, 'agent');
    try {
      const outcome = await writeProjectDoc(
        root,
        stacks,
        exists,
        fingerprint,
        (prompt) => ctx.runOneTurn(prompt),
        (text) => ctx.write(text)
      );
      if (outcome === 'written') {
        ctx.write(`${green(icons.ok)} OLLAMACODE.md ${exists ? 'updated' : 'written'} — /memory to see tracked facts\n`);
      } else if (outcome === 'cancelled') {
        ctx.write(`${dim('  /init stopped — OLLAMACODE.md was not written')}\n`);
      } else {
        ctx.write(
          `${yellow(icons.warn)} the model explored the project but did not write OLLAMACODE.md, even after a retry — try /init again, or ask directly: "write OLLAMACODE.md documenting this project"\n`
        );
      }
    } finally {
      setMode(ctx, savedMode);
    }
  } catch (err) {
    ctx.write(`${red(`  init failed: ${(err as Error).message}`)}\n`);
  }
  return CmdResult.HANDLED;
}
