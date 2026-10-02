import { CmdResult } from './types';

export async function runExit(): Promise<boolean | 'exit'> {
  return CmdResult.EXIT;
}
