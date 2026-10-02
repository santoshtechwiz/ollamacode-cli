import fsp from 'node:fs/promises';

import { defineTool } from '../core/defineTool';
import { ok, fromError, clamp } from '../core/tool-result';
import { walkFiles, isBinaryExtension } from '../filesystem/_fs';

const MAX_SCAN_BYTES = 256 * 1024;
const MAX_MATCHES = 200;
const MAX_DISPLAY = 20_000;

const MARKERS: Array<{ re: RegExp; label: string; }> = [
  { re: /^<<<<<<< /, label: '<<<<<<< ours' },
  { re: /^=======$/, label: '======= separator' },
  { re: /^>>>>>>> /, label: '>>>>>>> theirs' },
];

export interface ConflictHit {
  path: string;
  line: number;
  marker: string;
}

export default defineTool({
  name: 'merge_conflicts',
  profiles: ['core', 'planning'],
  category: 'git',
  activity: 'Checking merge conflicts',
  label: 'Merge Conflicts',
  brief: 'Find files containing unresolved merge conflict markers.',
  description: `Scan the workspace for unresolved merge conflict markers (<<<<<<<, =======, >>>>>>>) and report each file and line.
Use this to find what a merge or rebase left behind, before the project will build or test.`,
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        pathArg: true,
        description: 'Directory or file to scan (default: the workspace root)',
      },
    },
    required: [],
  },

  preview(args) {
    return args?.path ? `scan ${args.path} for conflict markers` : 'scan workspace for conflict markers';
  },

  async execute(args, ctx) {
    try {
      const root = args.path ? String(args.path) : '.';
      const target = await ctx.ws.resolve(root);

      const hits: ConflictHit[] = [];
      const files = new Set<string>();

      const scanFile = async (abs: string) => {
        if (files.has(abs) || hits.length >= MAX_MATCHES) return;
        let content: string | null = null;
        try {
          const st = await fsp.stat(abs);
          if (!st.isFile() || st.size === 0 || st.size > MAX_SCAN_BYTES) return;
          if (isBinaryExtension(abs)) return;
          content = await fsp.readFile(abs, 'utf8');
        } catch {
          return;
        }
        if (!content) return;
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i += 1) {
          if (hits.length >= MAX_MATCHES) break;
          const matching = MARKERS.find((m) => m.re.exec(lines[i]));
          if (matching) {
            files.add(abs);
            hits.push({ path: ctx.ws.rel(abs), line: i + 1, marker: matching.label });
          }
        }
      };

      if ((await fsp.stat(target)).isFile()) {
        await scanFile(target);
      } else {
        for await (const { abs } of walkFiles(target, { maxEntries: 5000, signal: ctx.signal })) {
          if (ctx.signal?.aborted) break;
          if (hits.length >= MAX_MATCHES) break;
          await scanFile(abs);
        }
      }

      const lines = hits.map((h) => `  ${h.path}:${h.line} ${h.marker}`);
      const { text, truncated } = clamp(lines.join('\n'), MAX_DISPLAY);
      const display = hits.length
        ? `conflict markers in ${files.size} file(s):\n${text}${truncated ? '\n…[truncated]' : ''}`
        : `no conflict markers in ${ctx.ws.rel(target)}`;
      return ok({
        kind: 'matches',
        display,
        data: { conflicts: hits, files: [...files].map((f) => ctx.ws.rel(f)), count: hits.length },
      });
    } catch (err) {
      return fromError(err);
    }
  },
});