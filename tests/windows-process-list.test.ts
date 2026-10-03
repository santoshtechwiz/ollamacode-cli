import assert from 'node:assert/strict';
import test from 'node:test';
import { parseWindowsProcesses } from '../src/tool/process/processes/discovery';

test('reads the Windows listing, with command lines or without (the quick fallback)', () => {
  const full = '4\t0\tSystem\t\t\r\n1200\t900\tnode.exe\tC:\\Program Files\\nodejs\\node.exe\t"node" bin\\cli.js --tab\there\r\n';
  assert.deepEqual(parseWindowsProcesses(full), [
    { pid: 4, image: 'System', exePath: undefined, command: '' },
    { pid: 1200, parentPid: 900, image: 'node.exe', exePath: 'C:\\Program Files\\nodejs\\node.exe', command: '"node" bin\\cli.js --tab\there' },
  ]);

  const light = '1200\t900\tnode.exe\r\n900\t1\tpwsh.exe\r\n';
  assert.deepEqual(parseWindowsProcesses(light).map((p) => [p.pid, p.parentPid, p.image]), [[1200, 900, 'node.exe'], [900, 1, 'pwsh.exe']]);
});
