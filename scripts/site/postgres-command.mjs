import { spawn } from 'node:child_process';
import { readFile, lstat, realpath } from 'node:fs/promises';
import { join } from 'node:path';

/** Site-owned, nonsecret import configuration. No connection passwords enter Ae's artifact or logs. */
export async function importContainer(root) {
  const directory = join(root, '.local');
  const path = join(directory, 'postgresql-transfer.json');
  if (await realpath(directory) !== directory) throw new Error('symlink_config_directory');
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) throw new Error('invalid_import_config');
  const config = JSON.parse(await readFile(path, 'utf8'));
  if (config.backend !== 'docker-psql' || typeof config.container !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(config.container)) throw new Error('invalid_import_backend');
  return config.container;
}

/** psql owns one server session. Closing on error rolls back the active transaction. */
export async function executePostgres(root, container, program) {
  return new Promise((resolve, reject) => {
    // The container deadline also bounds the psql process if the Docker CLI is interrupted.
    const child = spawn('docker', ['exec', '-i', container, 'timeout', '110', 'psql', '--no-psqlrc', '--quiet', '--tuples-only', '--no-align', '--set=ON_ERROR_STOP=1', '--username=aedilis_app', '--dbname=aedilis'], {
      cwd: root, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
    });
    let output = '', bytes = 0, failed = false;
    const timeout = setTimeout(() => { failed = true; child.stdin.destroy(); child.kill(); }, 120_000);
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) { failed = true; child.stdin.destroy(); child.kill(); }
      else output += chunk.toString('utf8');
    });
    child.stdin.on('error', () => { failed = true; });
    child.once('error', () => { clearTimeout(timeout); reject(new Error('postgres_command_unavailable')); });
    child.once('close', code => {
      clearTimeout(timeout);
      if (code !== 0 || failed) return reject(new Error('postgres_import_failed_or_unknown'));
      try {
        const lines = output.trim().split(/\r?\n/).filter(Boolean);
        if (lines.length !== 1) throw new Error('invalid_receipt_response');
        const receipt = JSON.parse(lines[0]);
        if (receipt.service !== 'aedilis' || receipt.verified !== true) throw new Error('invalid_receipt');
        resolve(receipt);
      } catch { reject(new Error('import_receipt_not_confirmed')); }
    });
    child.stdin.end(program, 'utf8');
  });
}
