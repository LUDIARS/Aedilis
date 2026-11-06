// Reproduce the reviewed backend-only source import. No checkout/fetch/install or imported code execution.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const directory = new URL('../server/vendor/cernere-composite/', import.meta.url);
const lock = JSON.parse(readFileSync(new URL('source-lock.json', directory), 'utf8'));
if (!/^[0-9a-f]{40}$/.test(lock.commit) || lock.path !== 'packages/composite/src') throw new Error('Invalid source pin');
const repository = process.argv[2];
if (!repository) throw new Error('A local reviewed Cernere repository is required');
const reviewed = ['composite.ts', 'service-session.ts', 'types.ts', 'delegation.ts', 'service-identity.ts'];
if (JSON.stringify(Object.keys(lock.files).sort()) !== JSON.stringify(reviewed.sort())) throw new Error('Unexpected import file list');
const artifacts = reviewed.map(name => {
  const content = execFileSync('git', ['-C', repository, 'show', `${lock.commit}:${lock.path}/${name}`], { windowsHide: true, maxBuffer: 1024 * 1024 });
  if (createHash('sha256').update(content).digest('hex') !== lock.files[name]) throw new Error('Source integrity mismatch');
  return { name, content };
});
for (const { name, content } of artifacts) writeFileSync(fileURLToPath(new URL(name, directory)), content);
