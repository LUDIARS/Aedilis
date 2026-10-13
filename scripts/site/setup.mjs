/** @implements SPEC-AEDILIS-BOOTSTRAP */
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { runNpm } from './npm.mjs';

// Setup owns dependencies and UI artifacts. Runtime owns schema initialization.
const root = fileURLToPath(new URL('../../', import.meta.url));
const loggingLibrary = join(root, 'lib/vestigium');
// The checked-in submodule owns its lockfile and build; no sibling checkout is used.
await runNpm(loggingLibrary, ['ci', '--include=dev', '--ignore-scripts', '--no-audit', '--no-fund']);
await runNpm(loggingLibrary, ['run', 'build']);
await runNpm(loggingLibrary, ['prune', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund']);
await runNpm(root, ['ci', '--include=dev', '--no-audit', '--no-fund']);
await runNpm(root, ['run', 'build']);
// Runtime does not need TypeScript, esbuild, test tools, or their dependency trees.
await runNpm(root, ['prune', '--omit=dev', '--no-audit', '--no-fund']);
