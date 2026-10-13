/** @implements SPEC-AEDILIS-PG-TRANSFER */
import { argument, readBundle } from './transfer-file.mjs';
import { postgresProgram } from './postgres-transfer.mjs';
import { importContainer, executePostgres } from './postgres-command.mjs';
import { withTransferDiagnostics } from './transfer-diagnostics.mjs';

try {
  const args = process.argv.slice(2), input = argument(args, '--input'), hash = argument(args, '--sha256');
  const root = process.cwd();
  const receipt = await withTransferDiagnostics(root, async step => {
    const bundle = await step('artifact-validation', () => readBundle(input, hash));
    const container = await step('destination-config', () => importContainer(root));
    const program = await step('postgres-program', () => postgresProgram(bundle, hash, new Date().toISOString()));
    return step('postgres-import-verification', () => executePostgres(root, container, program));
  });
  if (receipt.sha256 !== hash) throw new Error('receipt_hash_mismatch');
  process.stdout.write(JSON.stringify(receipt) + '\n');
} catch {
  process.stderr.write('Ae PostgreSQL import failed; inspect the operation status before retrying.\n');
  process.exitCode = 1;
}
