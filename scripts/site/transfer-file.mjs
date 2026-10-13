import { open, lstat, realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { MAX_BYTES, validateBundle } from './transfer-format.mjs';

export function argument(args, name) {
  const i = args.indexOf(name);
  if (i < 0 || !args[i + 1] || args.indexOf(name, i + 1) !== -1) throw new Error('missing_argument');
  return args[i + 1];
}

export async function writeBundle(path, bundle) {
  if (!isAbsolute(path)) throw new Error('absolute_output_required');
  const data = Buffer.from(JSON.stringify(validateBundle(bundle)), 'utf8');
  if (data.length > MAX_BYTES) throw new Error('bundle_too_large');
  // Exclusive create preserves every existing artifact. Private mode protects personal data on Unix.
  const handle = await open(path, 'wx', 0o600);
  try { await handle.writeFile(data); await handle.sync(); }
  finally { await handle.close(); }
  return createHash('sha256').update(data).digest('hex');
}

export async function readBundle(path, expectedHash) {
  if (!isAbsolute(path) || !/^[a-f0-9]{64}$/.test(expectedHash)) throw new Error('invalid_import_arguments');
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_BYTES || await realpath(path) !== path) throw new Error('invalid_import_file');
  const handle = await open(path, 'r');
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > MAX_BYTES || opened.ino !== info.ino || opened.dev !== info.dev) throw new Error('import_file_changed');
    const data = await handle.readFile();
    if (data.length > MAX_BYTES || createHash('sha256').update(data).digest('hex') !== expectedHash) throw new Error('artifact_hash_mismatch');
    return validateBundle(JSON.parse(data.toString('utf8')));
  } finally { await handle.close(); }
}
