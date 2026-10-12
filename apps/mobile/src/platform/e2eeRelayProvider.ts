import type { AppLifecycleService } from "@ryco/client-runtime/platform";
import type { RelayE2eeProvider } from "@ryco/client-runtime/relay";
import {
  makeRelayE2eeInitiator,
  type RelayE2eeInitiator,
  type RelayE2eeInitiatorAttempt,
} from "@ryco/client-runtime/relay/e2ee";

import { mobileAppLifecycle } from "./appLifecycle";

// The NATIVE tier's relay-E2EE provider — docs/relay-e2ee-protocol.md §4.4 (the
// client mode machine, built at `channel.accept`) plus the one thing that is
// genuinely this platform's and not the protocol's: the React Native lifecycle.
//
// WHAT THIS OWNS: the tier, the lifecycle hazard, and nothing else. The K rows,
// the timers, the buffer disposition, and the handshake all belong to
// `makeRelayE2eeInitiator`; the §12.1.1 classification, the credentials, and the
// pin all belong to the caller, which resolves them BEFORE the channel exists
// because §4.4 requires every selection guard to be evaluable "before it has
// received any payload".
//
// ─────────────────────────────────────────────────────────────────────────────
// THE LIFECYCLE HAZARD, STATED PLAINLY
// ─────────────────────────────────────────────────────────────────────────────
// `T_HANDSHAKE_NODE` (10 s) runs from the NODE'S ADVERTISEMENT EMIT, not from
// `channel.accept`, and §8.9 keeps it armed through the `e2ee` state until the
// client's first envelope authenticates. A mobile client that is backgrounded
// between accept and that first envelope therefore earns an encrypted §11.3 Q8
// and a dead channel — one it cannot even read, because it is suspended. iOS
// suspends WebSockets on background, so this is the ordinary case on this
// platform rather than a corner of it.
//
// The answer is to decide the channel BEFORE the node does, and to decide it
// fail-closed: a background transition while `negotiating` is a CLIENT-INITIATED
// channel abort — FATAL-PRE, no record emitted, buffered sends discarded — and
// a channel is never opened into a backgrounded app in the first place. Neither
// is a legacy fallback: §4.4 forbids one after validated evidence and this path
// cannot know whether evidence is on its way.

export interface MobileRelayE2eeProviderSources {
  /**
   * §4.4: the attempt's guards, credentials, and classification, resolved from
   * client-anchored state before the channel was opened. A caller that cannot
   * resolve them supplies no provider at all — which is a legacy channel, and is
   * the correct answer while §12.1.1 says the selection is legacy-eligible.
   */
  readonly attempt: RelayE2eeInitiatorAttempt;
  /** Injected so a test can present a backgrounded app; the default is the real one. */
  readonly lifecycle?: AppLifecycleService | undefined;
}

/**
 * A `RelayE2eeProvider` whose channel is known to be the §4.4 mode machine.
 *
 * It is assignable to `RelayE2eeProvider` — the engine wants no more than the
 * channel surface — while the caller and this app's tests keep `mode` and
 * `abort`, which the lifecycle wiring is written in terms of.
 */
export type MobileRelayE2eeProvider = (
  host: Parameters<RelayE2eeProvider>[0],
) => RelayE2eeInitiator;

/**
 * The `RelayE2eeProvider` `HostedRelayEngine` builds one mode machine from.
 *
 * `apps/web` supplies no provider and is unchanged by construction rather than
 * by a tier flag the engine branches on — there is no tier in the engine to
 * branch on, and this is the only file in the repository that names `native` to
 * the relay path.
 */
export function makeMobileRelayE2eeProvider(
  sources: MobileRelayE2eeProviderSources,
): MobileRelayE2eeProvider {
  const lifecycle = sources.lifecycle ?? mobileAppLifecycle;
  return (host) => {
    const machine: RelayE2eeInitiator = makeRelayE2eeInitiator({ host, attempt: sources.attempt });

    // A channel accepted into a backgrounded app has already lost: the OS may
    // suspend the socket before the carrier arrives, and the node's deadline
    // runs regardless. Aborting here is FATAL-PRE with no record — the same
    // observable every other pre-key condition produces (§11.5).
    if (!lifecycle.isForeground()) {
      machine.abort();
      return machine;
    }

    const unsubscribe = lifecycle.subscribe((event) => {
      if (event !== "background") return;
      // ONLY `negotiating`. An established `e2ee` channel that is backgrounded
      // has already authenticated its implicit finish, so `T_HANDSHAKE_NODE` is
      // satisfied and the ordinary transport reconnect governs it; a `legacy`
      // channel was never subject to the deadline at all. `abort` is itself a
      // no-op outside `negotiating`, and this guard says so at the call site.
      if (machine.mode() !== "negotiating") return;
      machine.abort();
    });

    return {
      ...machine,
      mode: machine.mode,
      abort: machine.abort,
      dispose: (options) => {
        unsubscribe();
        machine.dispose(options);
      },
    };
  };
}
