import { contract as observe, type ContractSpec } from './contract-runtime.ts';

/** Preserve generic class method signatures across Augur's generated assignments.
 * Augur's runtime observes all calls; this project uses only observe/sample=1.
 * The runtime copy remains byte-identical to the managed template.
 */
export function contract<F extends (...args: never[]) => unknown>(fn: F,
  spec: object & { contractId: string; id: string; where: string; mode: 'observe'; sample: 1; rule: string }): F {
  return observe(fn as (...args: Parameters<F>) => ReturnType<F>,
    spec as ContractSpec<Parameters<F>, ReturnType<F>>) as F;
}
