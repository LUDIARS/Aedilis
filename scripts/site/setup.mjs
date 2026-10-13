/** @implements SPEC-AEDILIS-BOOTSTRAP */
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { runNpm } from './npm.mjs';
import { prepareLoggingSubmodule } from './logging-submodule.mjs';
import { withSetupDiagnostics } from './setup-diagnostics.mjs';

// Setup owns dependencies and UI artifacts. Runtime owns schema initialization.
const root = fileURLToPath(new URL('../../', import.meta.url));
const loggingLibrary = join(root, 'lib/vestigium');
await withSetupDiagnostics(root, async step => {
  // Ex clones the service without submodules. Setup owns this exact pinned dependency.
  await step('logging-checkout', () => prepareLoggingSubmodule(root));
  await step('logging-install', () => runNpm(loggingLibrary, ['ci', '--include=dev', '--ignore-scripts', '--no-audit', '--no-fund']));
  await step('logging-build', () => runNpm(loggingLibrary, ['run', 'build']));
  await step('logging-prune', () => runNpm(loggingLibrary, ['prune', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund']));
  await step('application-install', () => runNpm(root, ['ci', '--include=dev', '--no-audit', '--no-fund']));
  await step('application-build', () => runNpm(root, ['run', 'build']));
  // Runtime does not need TypeScript, esbuild, test tools, or their dependency trees.
  await step('application-prune', () => runNpm(root, ['prune', '--omit=dev', '--no-audit', '--no-fund']));
});
