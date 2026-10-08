/**
 * Builds the WASM engine from AssemblyScript.
 * The compiled .wasm is committed to the repo so end users never need the
 * AssemblyScript toolchain - this script is only for maintainers.
 */

import { execSync } from 'node:child_process';

try {
  execSync(
    'asc wasm-src/index.ts -O3 --runtime stub --outFile src/core/wasm/engine.wasm --textFile src/core/wasm/engine.wat',
    { stdio: 'inherit' }
  );
  console.log('  ✓ built src/core/wasm/engine.wasm');
} catch (err) {
  console.error(`  ${/** @type {Error} */ (err).message}`);
  console.error(
    '\n  ✗ AssemblyScript build failed. The CLI still works via the pure-JS\n' +
      '    fallback engine (src/core/wasm/loader.js) - only streaming parse\n' +
      '    speed is affected.\n'
  );
  process.exit(1);
}
