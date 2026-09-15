/** TanStack navigation promises remain pending when a history blocker rejects.
 * This receipt lets pane input ownership settle without bypassing that blocker.
 * It carries only the destination pathname, never editor contents.
 */
const blockedListeners = new Set<(pathname: string) => void>();
export function reportPreviewNavigationBlocked(pathname: string): void {
  for (const listener of blockedListeners) listener(pathname);
}
export async function navigateWithPreviewGuard(
  pathname: string,
  navigate: () => Promise<void>,
  signal: AbortSignal,
): Promise<boolean> {
  if (signal.aborted) return false;
  let release = () => {};
  const blocked = new Promise<boolean>((resolve) => {
    const onBlocked = (next: string) => {
      if (next === pathname) resolve(false);
    };
    const onAbort = () => resolve(false);
    blockedListeners.add(onBlocked);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) resolve(false);
    release = () => {
      blockedListeners.delete(onBlocked);
      signal.removeEventListener("abort", onAbort);
    };
  });
  try {
    return await Promise.race([blocked, navigate().then(() => true)]);
  } finally {
    release();
  }
}
