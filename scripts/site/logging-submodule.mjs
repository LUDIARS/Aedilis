/** Prepare only Aedilis' pinned logging submodule; never update a remote ref. */
import { spawn } from 'node:child_process';

async function git(root, args) {
  return new Promise((resolve, reject) => {
    let output = '';
    let oversized = false;
    const child = spawn('git', ['-c', 'credential.interactive=false', ...args], {
      cwd: root, shell: false, windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (oversized) return;
      if (output.length + chunk.length > 64 * 1024) {
        oversized = true;
        child.kill();
        return;
      }
      output += chunk;
    });
    // Drain diagnostics without exposing Git URLs or credential-helper output.
    child.stderr.resume();
    child.once('error', () => reject(new Error('Logging submodule Git could not start')));
    child.once('close', (code, signal) => {
      if (code === 0 && !oversized) resolve(output);
      else reject(new Error('Logging submodule Git failed (' + (signal ?? code) + ')'));
    });
  });
}

export async function prepareLoggingSubmodule(root) {
  const status = await git(root, ['submodule', 'status', '--', 'lib/vestigium']);
  if (!/^[- ][0-9a-f]{40,64} lib\/vestigium(?:\s|$)/.test(status)) {
    throw new Error('Logging submodule must match the pinned commit');
  }
  if (status.startsWith(' ')) {
    const dirty = await git(root, ['-C', 'lib/vestigium', 'status', '--porcelain', '--untracked-files=no']);
    if (dirty.trim()) throw new Error('Logging submodule contains modified tracked files');
    return;
  }
  await git(root, ['submodule', 'update', '--init', '--checkout', '--', 'lib/vestigium']);
  const prepared = await git(root, ['submodule', 'status', '--', 'lib/vestigium']);
  if (!prepared.startsWith(' ')) throw new Error('Logging submodule initialization did not reach the pinned commit');
}
