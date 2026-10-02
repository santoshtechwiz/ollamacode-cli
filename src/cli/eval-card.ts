import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** What `npm run eval` last measured for this model on this machine, as one line; null when it was never measured. */
export function reportCard(model: string): string | null {
  try {
    const file = path.join(os.tmpdir(), 'ocode-eval', 'cards', `${model.replace(/[^\w.-]+/g, '_')}.json`);
    const card = JSON.parse(fs.readFileSync(file, 'utf8'));
    const failing = Object.entries(card.scenarios ?? {}).filter(([, s]: any) => !s.pass).map(([id]) => id);
    const when = String(card.summary?.updatedAt ?? '').slice(0, 10);
    return `${card.summary.passed}/${card.summary.total} scenarios pass${failing.length ? ` (failing: ${failing.join(', ')})` : ''}${when ? `, ${when}` : ''}`;
  } catch {
    return null;
  }
}
