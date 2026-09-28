/** @implements SPEC-AEDILIS-BOOTSTRAP */
import { realpath, access } from 'node:fs/promises';
import { dirname, delimiter, join } from 'node:path';
import { spawn } from 'node:child_process';

// Invoke npm through Node: npm.cmd cannot be spawned without a shell on Windows.
async function npmCli() {
  const candidates = [join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')];
  for (const directory of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    if (process.platform === 'win32') candidates.push(join(directory, 'node_modules/npm/bin/npm-cli.js'));
    else {
      try { candidates.push(await realpath(join(directory, 'npm'))); }
      catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
    }
  }
  for (const candidate of candidates) {
    try { await access(candidate); return candidate; }
    catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
  }
  throw new Error('npm CLI is required. Install npm with the Node runtime.');
}

export async function runNpm(root, args) {
  const cli = await npmCli();
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: root, shell: false, windowsHide: true,
      stdio: ['ignore', 'inherit', 'inherit'],
      env: { ...process.env, CI: 'true', npm_config_yes: 'true' },
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error('npm ' + args[0] + ' failed (' + (signal ?? code) + ')'));
    });
  });
}
