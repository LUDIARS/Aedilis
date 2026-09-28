/** @implements SPEC-AEDILIS-BOOTSTRAP */
import { fileURLToPath } from 'node:url';
import { runNpm } from './npm.mjs';

// Setup owns dependencies and UI artifacts. Runtime owns schema initialization.
const root = fileURLToPath(new URL('../../', import.meta.url));
await runNpm(root, ['ci', '--include=dev', '--no-audit', '--no-fund']);
await runNpm(root, ['run', 'build:web']);
