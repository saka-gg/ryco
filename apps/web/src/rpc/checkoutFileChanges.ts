import type { EnvironmentId } from "@ryco/contracts";

type CheckoutChangeListener = (environmentId: EnvironmentId, cwd: string | null) => void;
const checkoutChangeListeners = new Set<CheckoutChangeListener>();

/**
 * Lazily loaded file caches (the files panel's tree and reads) listen here
 * instead of being imported by the runtime service, which is on the boot path.
 * No imports, so a lazy cache can register without loading the runtime.
 * `cwd` null: every checkout of the environment.
 */
export function onCheckoutFilesChanged(listener: CheckoutChangeListener): () => void {
  checkoutChangeListeners.add(listener);
  return () => checkoutChangeListeners.delete(listener);
}

export function notifyCheckoutFilesChanged(environmentId: EnvironmentId, cwd: string | null): void {
  for (const listener of checkoutChangeListeners) listener(environmentId, cwd);
}
