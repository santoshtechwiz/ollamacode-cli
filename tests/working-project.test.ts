import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { workingProject } from '../src/context/workspace-state';

describe('where commands run when no folder is given', () => {
  it('a project whose name matches the request is not where a new one is built', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ocode-wp-'));
    try {
      const todo = path.join(root, 'todo-app');
      fs.mkdirSync(todo);
      // "create a todo app": the index matched the existing todo-app, but no work has happened there.
      assert.equal(workingProject({ root, workedProject: null, activeProject: { id: 1, root: todo, name: 'todo-app' } } as any), null);
      // Once files are changed in a project, that is where the work is.
      const fresh = path.join(root, 'e-hailing-service');
      fs.mkdirSync(fresh);
      fs.writeFileSync(path.join(fresh, 'package.json'), '{}');
      assert.equal(workingProject({ root, workedProject: { root: fresh, name: 'e-hailing-service' } } as any), fresh);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
