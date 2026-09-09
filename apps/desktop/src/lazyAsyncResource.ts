/** Share both initialization and its result; retry only after a failed attempt. */
export function lazyAsyncResource<T>(create: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () => {
    pending ??= Promise.resolve()
      .then(create)
      .catch((cause: unknown) => {
        pending = undefined;
        throw cause;
      });
    return pending;
  };
}
