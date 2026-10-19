import type { ServerLifecycleWelcomePayload } from "@ryco/contracts";
import { onWelcome, startServerStateSync } from "@ryco/client-runtime/rpc";

import { retainActiveServerConfigProjection } from "./activeServerConfig";

type ServerStateConnection = Parameters<typeof startServerStateSync>[0];

/**
 * How long the boot path holds the primary server state sync on its own. The
 * shell's `ServerStateBootstrap` takes over long before this; the bound only
 * covers a shell that never mounts (its chunk failed), so the stream and the
 * config projection do not outlive the boot that wanted them.
 */
export const EARLY_SERVER_STATE_SYNC_HOLD_MS = 60_000;

interface EarlyHold {
  readonly release: () => void;
}

let earlyHold: EarlyHold | null = null;

export interface EarlyPrimaryServerStateSyncOptions {
  /** Runs once with the first welcome (warming what it names). */
  readonly onFirstWelcome?: (payload: ServerLifecycleWelcomePayload) => void;
}

/**
 * Starts the primary welcome subscription on the connection the root
 * `beforeLoad` opens early, so it rides alongside the connection's shell and
 * config subscriptions instead of waiting for the shell chunk to load and
 * commit, and starts showing the connection's config as it arrives, so the
 * shell's first render has it. The sync and the projection are
 * reference-counted: `ServerStateBootstrap` takes its own hold on mount and then
 * ends this one, so no stream opens twice and none closes in between.
 * `onFirstWelcome` is dropped with the hold.
 */
export function startEarlyPrimaryServerStateSync(
  connection: ServerStateConnection,
  options: EarlyPrimaryServerStateSyncOptions = {},
): void {
  releaseEarlyPrimaryServerStateSync();
  const timer = globalThis.setTimeout(() => hold.release(), EARLY_SERVER_STATE_SYNC_HOLD_MS);
  const stopSync = startServerStateSync(connection);
  const stopProjection = retainActiveServerConfigProjection();
  let stopWelcome: (() => void) | null = null;
  const hold: EarlyHold = {
    release: () => {
      if (earlyHold !== hold) return;
      earlyHold = null;
      globalThis.clearTimeout(timer);
      stopWelcome?.();
      stopSync();
      stopProjection();
    },
  };
  earlyHold = hold;

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
}

/** Ends the boot path's hold, once the shell holds the sync itself. */
export function releaseEarlyPrimaryServerStateSync(): void {
  earlyHold?.release();
}
