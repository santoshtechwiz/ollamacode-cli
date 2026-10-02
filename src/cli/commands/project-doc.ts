import { readFile, readdir } from 'node:fs/promises';
import { buildClaudeMdPrompt } from '../../prompts/memory';
import { claudeMdFile, representativeCommands, updateMemory } from '../../context/memory';
import { statType, SKIP_DIRS } from '../../tool/filesystem/_fs';
import { dim } from '../../ui/ansi';

/** Nothing but tool and dependency folders: there is no project yet to document. */
export async function isEffectivelyEmpty(root: string): Promise<boolean> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return !entries.some((e) => !SKIP_DIRS.has(e.name));
  } catch {
    return false;
  }
}

/** How one turn that was asked to write the doc ended; a cancelled turn is the person stopping /init. */
export type DocTurn = (prompt: string) => Promise<{ cancelled?: boolean } | void>;

export type DocOutcome = 'written' | 'not-written' | 'cancelled';

/**
 * Model-driven write of OLLAMACODE.md with one retry if the first pass explored but never wrote.
 * Shared by `ocode init` and `/init`, and kept out of `init.ts` so the command module does not depend on the
 * top-level init flow — that edge closed a cycle back through the REPL and the command registry.
 */
export async function writeProjectDoc(
  root: string,
  stacks: { label?: string }[],
  exists: boolean,
  fingerprint: string,
  runTurn: DocTurn,
  write: (text: string) => void
): Promise<DocOutcome> {
  const claudeMd = claudeMdFile(root);
  const beforeContent = exists ? await readFile(claudeMd, 'utf8').catch((): null => null) : null;
  const labels = stacks.map((s) => s.label).filter(Boolean) as string[];
  const commands = representativeCommands(stacks as any);

  const checkWrote = async () => {
    const afterExists = (await statType(claudeMd))?.type === 'file';
    if (!afterExists) return false;
    if (!exists) return true;
    const afterContent = await readFile(claudeMd, 'utf8').catch((): null => null);
    return afterContent !== null && afterContent !== beforeContent;
  };

  const first = await runTurn(buildClaudeMdPrompt({ stacks: labels, commands, exists }));
  let wrote = await checkWrote();
  // A stopped turn is the person's answer, not a model that needs a more direct instruction.
  if (!wrote && first?.cancelled) return 'cancelled';
  if (!wrote) {
    write(`${dim('  explored but did not write OLLAMACODE.md — retrying with a more direct instruction…')}\n`);
    const retry = await runTurn(buildClaudeMdPrompt({ stacks: labels, commands, exists, retry: true }));
    wrote = await checkWrote();
    if (!wrote && retry?.cancelled) return 'cancelled';
  }
  if (wrote) {
    updateMemory(root, (m) => {
      m.project.initFingerprint = fingerprint;
    });
  }
  return wrote ? 'written' : 'not-written';
}
