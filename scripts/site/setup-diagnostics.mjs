/** Persist stage outcomes only: never record environment values or child output. */
import { mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';

export async function withSetupDiagnostics(root, prepare) {
  const directory = join(root, '.local');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const log = await open(join(directory, 'aedilis-setup.jsonl'), 'a', 0o600);
  const record = async (stage, outcome) => {
    await log.write(JSON.stringify({ at: new Date().toISOString(), stage, outcome }) + '\n');
  };
  const step = async (stage, run) => {
    await record(stage, 'started');
    try {
      await run();
      await record(stage, 'succeeded');
    } catch (error) {
      await record(stage, 'failed');
      throw error;
    }
  };
  try { await prepare(step); }
  finally { await log.close(); }
}
