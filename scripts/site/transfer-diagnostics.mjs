import { mkdir, open, realpath } from 'node:fs/promises';
import { join } from 'node:path';

/** Record stage outcomes only; exception text and personal/secret data never enter this log. */
export async function withTransferDiagnostics(root, run) {
  const directory = join(root, '.local');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (await realpath(directory) !== directory) throw new Error('symlink_diagnostics_directory');
  const log = await open(join(directory, 'aedilis-transfer.jsonl'), 'a', 0o600);
  const record = (stage, outcome) => log.write(JSON.stringify({ at: new Date().toISOString(), stage, outcome }) + '\n');
  const step = async (stage, work) => {
    await record(stage, 'started');
    try { const value = await work(); await record(stage, 'succeeded'); return value; }
    catch (error) { await record(stage, 'failed'); throw error; }
  };
  try { return await run(step); }
  finally { await log.close(); }
}
