import { dim, green, red, yellow, icons } from '../../../ui/ansi';
import { loadConfig, updateConfig } from '../../../core/config';
import { clearAlwaysAllow } from '../../../tool/policy/permission-policy';
import { CmdResult, type CmdContext } from './types';

type RiskyPermission = 'ask' | 'always' | 'never';

export async function runPermissions(ctx: CmdContext): Promise<boolean | 'exit'> {
  const select = ctx.select as (
    message: string,
    choices: Array<{ label: string; value: RiskyPermission }>,
  ) => Promise<RiskyPermission | undefined>;
  const cfg = ctx.cfg as { permissions: { risky: RiskyPermission } };
  const config = loadConfig();
  const current = config.permissions.risky as RiskyPermission;

  ctx.write(
    `${dim(
      `  current: ${current} (ask = y/N/a per tool, always = auto, never = deny)`,
    )}\n`,
  );

  const picked = await select(
    'Permissions for risky tools:',
    [
      {
        label: 'ask — prompt each time (y/N/a)',
        value: 'ask',
      },
      {
        label: 'always — auto-allow risky tools',
        value: 'always',
      },
      {
        label: 'never — auto-deny risky tools',
        value: 'never',
      },
    ],
  );

  if (!picked || picked === current) {
    return CmdResult.HANDLED;
  }

  // `always` is a dangerous persistent capability.
  if (picked === 'always') {
    ctx.write(
      `${yellow(
        `  ${icons.warn} WARNING: "always" automatically approves risky tools.`,
      )}\n`,
    );

    ctx.write(
      `${yellow(
        `  This may allow destructive operations, including deleting or modifying project files, without another prompt.`,
      )}\n`,
    );

    ctx.write(
      `${dim(
        `  "ask" is recommended for normal use.`,
      )}\n`,
    );

    const confirmed = await select(
      'Enable automatic approval for risky tools?',
      [
        {
          label: 'No — keep prompting (recommended)',
          value: 'ask',
        },
        {
          label: 'Yes — enable automatic approval',
          value: 'always',
        },
      ],
    );

    if (confirmed !== 'always') {
      ctx.write(
        `${green(
          '  permissions unchanged — risky tools will still require confirmation',
        )}\n`,
      );

      return CmdResult.HANDLED;
    }
  }

  // Persist the configuration before mutating the live permission ledger.
  try {
    updateConfig((c) => {
      c.permissions.risky = picked;
    });
  } catch {
    ctx.write(
      `${red(
        `  ${icons.fail} failed to save permissions — no permission state was changed`,
      )}\n`,
    );

    return CmdResult.HANDLED;
  }

  // Update the live context only after persistent configuration succeeded.
  cfg.permissions.risky = picked;

  // Changing the policy invalidates previously granted "always allow" decisions.
  const perms = ctx.agentState?.permissions;

  if (perms) {
    try {
      clearAlwaysAllow(
        perms as Parameters<typeof clearAlwaysAllow>[0],
      );
    } catch {
      // The persistent config is already correct.
      ctx.write(
        `${yellow(
          `  ${icons.warn} saved permission policy, but existing session grants could not be cleared; restart/reload permissions before using risky tools`,
        )}\n`,
      );

      return CmdResult.HANDLED;
    }
  }

  if (picked === 'always') {
    ctx.write(
      `${yellow(
        `  ${icons.warn} permissions → always`,
      )}${dim(
        ' — saved to config.json; risky tools may run without confirmation',
      )}\n`,
    );
  } else if (picked === 'never') {
    ctx.write(
      `${green(
        `  permissions → never`,
      )}${dim(
        ' — saved to config.json; existing always-allow grants cleared',
      )}\n`,
    );
  } else {
    ctx.write(
      `${green(
        `  permissions → ask`,
      )}${dim(
        ' — saved to config.json; existing always-allow grants cleared',
      )}\n`,
    );
  }

  return CmdResult.HANDLED;
}
