/**
 * The retry rule of the web app's former `queryClient` reads, for atom-backed reads that kept it:
 * up to `retries` more attempts, 1 s, 2 s, 4 s … apart (at most 30 s). A read the hosted session
 * has not admitted yet is not retried on a timer: the post-ready refresh reads it again at once.
 * A read that stopped being its entry's current one (fenced by a reconnect, cancelled, or its
 * entry cleared) makes no further attempts.
 *
 * @module readRetry
 */
import { isAwaitingAdmission } from "@ryco/client-runtime/rpc";

function retryDelayMs(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 30_000);
}

/**
 * Called when an entry's read starts: whether that read is still the entry's current one. A
 * keyed registry bumps the controller's `fetchToken` for each read and on every fence or cancel.
 */
export function currentReadGuard(
  controllers: ReadonlyMap<string, { readonly fetchToken: number }>,
  compositeKey: string | null,
): () => boolean {
  const controller = compositeKey === null ? undefined : controllers.get(compositeKey);
  const fetchToken = controller?.fetchToken;
  return () =>
    controller !== undefined &&
    compositeKey !== null &&
    controllers.get(compositeKey) === controller &&
    controller.fetchToken === fetchToken;
}

export async function runWithReadRetry<T>(
  run: () => Promise<T>,
  retries: number,
  isCurrent: () => boolean = () => true,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      if (attempt >= retries || isAwaitingAdmission(error)) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, retryDelayMs(attempt)));
      if (!isCurrent()) throw error;
    }
  }
}
