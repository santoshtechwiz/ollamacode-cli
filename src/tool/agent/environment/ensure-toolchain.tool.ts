import { TOOL_ERROR_CODE } from '../../../protocol';
import { defineTool } from '../../../tool/core/defineTool';
import { ok, fail } from '../../../tool/core/tool-result';

const KNOWN = [
  'node',
  'python',
  'dotnet',
  'git',
  'terraform',
  'go',
  'rust',
];

export default defineTool({
  name: 'ensure_toolchain',
  profiles: ['core'],
  aliases: ['install_toolchain', 'check_toolchain', 'ensure_tools', 'install_tools'],
  category: 'agent',
  activity: 'Checking the toolchain',
  label: 'Ensure Toolchain',
  description:
    'Check whether language toolchains are installed and on PATH, and optionally install the missing ones. ' +
    `Known toolchains: ${KNOWN.join(', ')}. ` +
    'With install:true this installs any missing toolchain using the best available package manager ' +
    'for this OS (winget/scoop on Windows, brew on macOS, apt on Linux, fnm/nvm for Node) and then ' +
    'verifies the tool is really on PATH. Installing requires user approval. ' +
    'Prefer this over guessing at `winget`/`brew`/`apt` install commands.',
  parameters: {
    type: 'object',
    properties: {
      toolchains: {
        type: 'array',
        items: { type: 'string' },
        description: `Toolchain ids to check or install, e.g. ["python"], ["node","dotnet"]. Known: ${KNOWN.join(', ')}`,
      },
      install: {
        type: 'boolean',
        description:
          'When true, install any toolchain that is missing (requires approval). Default false = read-only check.',
      },
    },
    required: ['toolchains'],
  },
  isRisky(args) {
    return args?.install === true;
  },
  preview(args) {
    const ids = (Array.isArray(args?.toolchains) ? args.toolchains : []).join(', ');
    return args?.install === true ? `install toolchain(s): ${ids}` : `check toolchain(s): ${ids}`;
  },
  async execute(args, ctx) {
    const tooling = ctx?.state?.tooling;
    if (!tooling) {
      return fail('The tooling manager is unavailable in this session', { code: TOOL_ERROR_CODE.EUNKNOWN });
    }

    const raw: unknown[] = Array.isArray(args?.toolchains) ? args.toolchains : [];
    const ids: string[] = [...new Set(raw.map((t) => String(t).trim().toLowerCase()).filter(Boolean))];
    if (ids.length === 0) {
      return fail('toolchains must be a non-empty array of ids', { code: TOOL_ERROR_CODE.EINVAL });
    }

    const wantInstall = args?.install === true;
    const report = wantInstall
      ? await tooling.ensure(ids, { install: true, cwd: ctx?.cwd, signal: ctx?.signal })
      : await tooling.check(ids);

    const display = tooling.render(report);

    if (!wantInstall || report.ok) {
      return ok({ kind: 'text', display, data: report });
    }
    const failed = report.toolchains.find((t) => !t.available && (t.code || t.error)) ?? report.toolchains[0];
    return fail(display, { code: (failed?.code as any) ?? 'EUNKNOWN', data: report });
  },
});

