import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { prepareLoggingSubmodule } from '../scripts/site/logging-submodule.mjs';
import { withSetupDiagnostics } from '../scripts/site/setup-diagnostics.mjs';

const execute = promisify(execFile);
const identity = ['-c', 'user.name=Setup fixture', '-c', 'user.email=fixture@example.invalid'];
// Real Git subprocesses exceed Vitest's 5-second default on the Windows reviewer.
const SCENARIO_TIMEOUT_MS = 60_000;
let directory;
let root;
let previousProtocol;
let setupWork = Promise.resolve();
let scenarioWork = Promise.resolve();
const git = (cwd, args) => execute('git', args, {
  cwd, windowsHide: true, encoding: 'utf8', timeout: 30_000,
});

function scenario(title, run) {
  it(title, () => {
    scenarioWork = Promise.resolve().then(run);
    return scenarioWork;
  }, SCENARIO_TIMEOUT_MS);
}

describe.sequential('cold logging-submodule setup', () => {
  beforeEach(() => {
    directory = undefined;
    root = undefined;
    scenarioWork = Promise.resolve();
    previousProtocol = process.env.GIT_ALLOW_PROTOCOL;
    process.env.GIT_ALLOW_PROTOCOL = 'file';
    setupWork = (async () => {
      directory = await mkdtemp(join(tmpdir(), 'aedilis-setup-test-'));
      root = join(directory, 'service');
      const library = join(directory, 'library');
      await mkdir(root);
      await mkdir(library);
      await git(library, ['init']);
      await writeFile(join(library, 'package.json'), '{"name":"fixture","version":"1.0.0"}');
      await git(library, ['add', 'package.json']);
      await git(library, [...identity, 'commit', '-m', 'Pinned fixture']);
      await git(root, ['init']);
      await git(root, ['submodule', 'add', library, 'lib/vestigium']);
      await git(root, [...identity, 'commit', '-am', 'Logging fixture']);
    })();
    return setupWork;
  }, SCENARIO_TIMEOUT_MS);

  afterEach(async () => {
    // Vitest timeouts do not cancel callbacks: wait for their complete lifetime
    // before changing the inherited protocol or removing their working directory.
    // Original failures remain attached to the hook/test that reported them.
    await Promise.allSettled([setupWork, scenarioWork]);
    if (previousProtocol === undefined) delete process.env.GIT_ALLOW_PROTOCOL;
    else process.env.GIT_ALLOW_PROTOCOL = previousProtocol;
    if (!directory) return;
    const absolute = resolve(directory);
    if (!absolute.startsWith(resolve(tmpdir()) + sep) || !basename(absolute).startsWith('aedilis-setup-test-')) {
      throw new Error('Fixture cleanup escaped its temporary directory');
    }
    await rm(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }, SCENARIO_TIMEOUT_MS);

  scenario('initializes the pinned files from a cold checkout and is repeatable', async () => {
    await git(root, ['submodule', 'deinit', '--force', '--', 'lib/vestigium']);
    await prepareLoggingSubmodule(root);
    await prepareLoggingSubmodule(root);
    const contents = await readFile(join(root, 'lib/vestigium/package.json'), 'utf8');
    expect(JSON.parse(contents).name).toBe('fixture');
    expect((await git(root, ['status', '--porcelain'])).stdout.trim()).toBe('');
  });

  scenario('preserves existing edits instead of resetting the logging library', async () => {
    const path = join(root, 'lib/vestigium/package.json');
    await writeFile(path, '{"name":"operator-edit"}');
    await expect(prepareLoggingSubmodule(root)).rejects.toThrow('modified tracked files');
    expect(await readFile(path, 'utf8')).toBe('{"name":"operator-edit"}');
  });

  scenario('refuses a mismatched commit without checking out over it', async () => {
    const library = join(root, 'lib/vestigium');
    await writeFile(join(library, 'extra.txt'), 'preserve');
    await git(library, ['add', 'extra.txt']);
    await git(library, [...identity, 'commit', '-m', 'Different revision']);
    const head = (await git(library, ['rev-parse', 'HEAD'])).stdout;
    await expect(prepareLoggingSubmodule(root)).rejects.toThrow('pinned commit');
    expect((await git(library, ['rev-parse', 'HEAD'])).stdout).toBe(head);
  });

  scenario('records a failed stage without saving a secret from the exception', async () => {
    await expect(withSetupDiagnostics(root, step => step('application-install', async () => {
      throw new Error('private-credential-value');
    }))).rejects.toThrow('private-credential-value');
    const text = await readFile(join(root, '.local/aedilis-setup.jsonl'), 'utf8');
    expect(text).not.toContain('private-credential-value');
    expect(text.trim().split('\n').map(line => JSON.parse(line).outcome)).toEqual(['started', 'failed']);
  });
});
