import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { dryRunEdit } from '../src/tool/filesystem/edit-file.tool';

describe('edit_file on JSON writes the replacement as given', () => {
  it('keeps nested indentation instead of flattening it to the file unit', () => {
    const before = '{\n  "a": {\n    "x": 1\n  }\n}\n';
    const out = dryRunEdit(before, { path: 'p.json', search: '"x": 1', replace: '"x": 1,\n    "y": {\n      "z": 2\n    }' }, 'p.json', true);
    assert.equal(out.status, 'ok');
    assert.equal((out as any).content, '{\n  "a": {\n    "x": 1,\n    "y": {\n      "z": 2\n    }\n  }\n}\n');
  });

  it('still matches a search whose indentation differs, and still refuses invalid JSON', () => {
    const before = '{\n  "a": 1,\n  "b": 2\n}\n';
    assert.equal(dryRunEdit(before, { path: 'p.json', search: '"a": 1,\n"b": 2', replace: '"a": 1,\n  "b": 3' }, 'p.json', true).status, 'ok');
    assert.equal(dryRunEdit(before, { path: 'p.json', search: '"b": 2', replace: '"b": ' }, 'p.json', true).status, 'fail');
  });
});
