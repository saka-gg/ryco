/**
 * Runs `worker` once per index in `[0, count)` with at most `concurrency` calls
 * in flight, starting them in index order. Resolves once every call settled; a
 * worker is expected to handle its own failures (a rejection is swallowed so
 * one item cannot stop the rest).
 */
export async function forEachWithConcurrency(
  count: number,
  concurrency: number,
  worker: (index: number) => Promise<void>,
): Promise<void> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new RangeError("Concurrency must be a positive integer.");
  }
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, count) }, async () => {
      while (next < count) {
        const index = next++;
        await worker(index).catch(() => undefined);
      }
    }),
  );
}
