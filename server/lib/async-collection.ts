/** Retain input ordering while evaluating an asynchronous visibility policy for every item. */
export async function filterAsync<T>(items: T[], predicate: (item: T, index: number) => Promise<boolean>): Promise<T[]> {
  const visible = await Promise.all(items.map(predicate));
  return items.filter((_, index) => visible[index] === true);
}
