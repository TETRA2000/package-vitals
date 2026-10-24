/**
 * Maps `items` through `fn` with at most `limit` calls running at once.
 * Results keep the input order. After the first rejection no new calls start,
 * and the returned promise rejects with that error once in-flight calls settle.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failure: { error: unknown } | null = null;

  const worker = async () => {
    while (failure === null && next < items.length) {
      const index = next++;
      try {
        results[index] = await fn(items[index]!, index);
      } catch (error) {
        failure ??= { error };
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
  if (failure !== null) throw (failure as { error: unknown }).error;
  return results;
}
