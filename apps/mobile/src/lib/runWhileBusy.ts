// React Compiler cannot lower `try/finally`, or `try` without `catch`, inside a
// component or hook. It then leaves the whole component unmemoized, so one
// press handler costs every render of a hot screen its memoization. Handlers
// that must always clear a busy or pending state call these module-level
// helpers instead, which keeps the `finally` out of the component body.

/** Runs `task` and calls `onSettled` once it resolves, rejects or throws. */
export async function runThenSettle<A>(task: () => Promise<A>, onSettled: () => void): Promise<A> {
  try {
    return await task();
  } finally {
    onSettled();
  }
}

/** Holds `setBusy(true)` for the length of `task`, then always resets it. */
export function runWhileBusy<A>(
  setBusy: (busy: boolean) => void,
  task: () => Promise<A>,
): Promise<A> {
  setBusy(true);
  return runThenSettle(task, () => setBusy(false));
}
