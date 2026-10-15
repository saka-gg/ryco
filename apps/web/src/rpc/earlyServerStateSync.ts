import type { ServerLifecycleWelcomePayload } from "@ryco/contracts";
import { onWelcome, startServerStateSync } from "@ryco/client-runtime/rpc";

type ServerStateConnection = Parameters<typeof startServerStateSync>[0];

/**
 * How long the boot path holds the primary server state sync on its own. The
 * shell's `ServerStateBootstrap` takes over long before this; the bound only
 * covers a shell that never mounts (its chunk failed), so the streams do not
 * outlive the boot that wanted them.
 */
export const EARLY_SERVER_STATE_SYNC_HOLD_MS = 60_000;

interface EarlyHold {
  readonly release: () => void;
}

let earlyHold: EarlyHold | null = null;

export interface EarlyPrimaryServerStateSyncOptions {
  /**
   * Opens the streams only once this settles: the provider catalogs this page
   * persisted, so the config subscription can name them and the snapshot
   * leaves them out. It must not reject; a rejection is treated as settled.
   */
  readonly after?: PromiseLike<unknown> | null;
  /** Runs once with the first welcome (warming what it names). */
  readonly onFirstWelcome?: (payload: ServerLifecycleWelcomePayload) => void;
}

/**
 * Starts the primary welcome and config subscriptions on the connection the
 * root `beforeLoad` opens early, so they ride alongside its shell subscription
 * instead of waiting for the shell chunk to load and commit. The sync is
 * reference-counted per connection: `ServerStateBootstrap` takes its own hold on
 * mount and then ends this one, so no stream opens twice and none closes in
 * between. A hold ended before `after` settles never opens anything.
 * `onFirstWelcome` is dropped with the hold.
 */
export function startEarlyPrimaryServerStateSync(
  connection: ServerStateConnection,
  options: EarlyPrimaryServerStateSyncOptions = {},
): void {
  releaseEarlyPrimaryServerStateSync();
  let stopSync: (() => void) | null = null;
  let stopWelcome: (() => void) | null = null;
  const timer = globalThis.setTimeout(() => hold.release(), EARLY_SERVER_STATE_SYNC_HOLD_MS);
  const hold: EarlyHold = {
    release: () => {
      if (earlyHold !== hold) return;
      earlyHold = null;
      globalThis.clearTimeout(timer);
      stopWelcome?.();
      stopSync?.();
    },
  };
  earlyHold = hold;

  const open = () => {
    if (earlyHold !== hold) return;
    stopSync = startServerStateSync(connection);
    const { onFirstWelcome } = options;
    if (!onFirstWelcome) return;
    let welcomed = false;
    stopWelcome = onWelcome((payload) => {
      if (welcomed) return;
      welcomed = true;
      stopWelcome?.();
      try {
        onFirstWelcome(payload);
      } catch {
        // Warming is advisory; the shell's own welcome handling still runs.
      }
    });
    // A welcome already held by the store is delivered synchronously.
    if (welcomed) stopWelcome();
  };
  if (options.after == null) {
    open();
    return;
  }
  Promise.resolve(options.after).then(open, open);
}

/** Ends the boot path's hold, once the shell holds the sync itself. */
export function releaseEarlyPrimaryServerStateSync(): void {
  earlyHold?.release();
}
