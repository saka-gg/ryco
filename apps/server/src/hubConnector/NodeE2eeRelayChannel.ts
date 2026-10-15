import type { RelayLimits } from "@ryco/contracts/relay";
import { e2eeChannelSizeBudget } from "@ryco/shared/relayE2eeConstants";
import { Effect } from "effect";

import {
  RpcInboundRejectedError,
  RpcOutputRefusedError,
  type RpcInboundInterceptor,
} from "../ws/RpcByteSession.ts";
import type { NodeE2eeChannelSession } from "./NodeE2eeChannelSession.ts";
import type { RelayRpcChannelSession } from "./RelayChannelRegistry.ts";

// The seam between one relay RPC channel and the E2EE layer that owns its
// payloads — docs/relay-e2ee-protocol.md §4.5 (the size budget), §10 (the
// authenticated close), and §10.4 (the truncation verdict).
//
// WHAT THIS OWNS: nothing about the protocol. It decides no policy, protects no
// record, and names no close reason. It exists because the two facts below are
// the whole of what a channel's lifecycle owes the E2EE layer, and both were
// previously spelled out inline in the connector layer, where nothing could
// reach them:
//
//   - a channel that ends MUST be given §10's authenticated close before its
//     session is disposed, and
//   - the verdict §10.4 records depends on whether the relay chunk assembler
//     still holds an incomplete reassembled message at that instant.

/**
 * The RPC byte session behind one channel, reduced to what the binding reads.
 *
 * `incompleteReassembly` is the §10.4 truncation input and the reason this is an
 * interface rather than the concrete session: the assembler that answers it
 * belongs to the RPC runtime, and the E2EE layer must not reach into it.
 */
export interface NodeE2eeChannelRpcSession {
  readonly receive: (bytes: Uint8Array) => Promise<boolean>;
  readonly queuedBytes: () => Promise<number>;
  readonly supportsChunkedMessages: () => boolean;
  /** §10.4: the relay chunk assembler holds an incomplete reassembled message. */
  readonly incompleteReassembly: () => boolean;
}

export interface NodeE2eeRelayChannelBinding {
  readonly e2ee: NodeE2eeChannelSession;
  readonly rpc: NodeE2eeChannelRpcSession;
  /**
   * Tear the RPC runtime down. Called once, after the E2EE layer has finished
   * with the channel, so a close record the §10 exchange produces is protected
   * while the session that protects it still exists.
   */
  readonly release: () => Promise<void>;
}

/**
 * §4.5's `plaintextCeiling` for one relay connection.
 *
 * It delegates to `e2eeChannelSizeBudget`, which §4.5 makes the ONLY place
 * either ceiling is derived. The connector holds no second copy of the
 * arithmetic: a hand-rolled `min(...) − E2EE_ENVELOPE_OVERHEAD_BYTES` beside the
 * helper is two derivations of one normative quantity, and the day they disagree
 * is the day a record the sender believes fits is refused by the chunk layer.
 *
 * A budget §4.5 declares unestablishable yields 0, which is the value the record
 * session refuses — so such a channel fails during establishment (§11.2 P14)
 * rather than shrinking anything silently.
 */
export function nodeE2eeChannelPlaintextCeiling(limits: RelayLimits): number {
  const budget = e2eeChannelSizeBudget(limits);
  return budget.establishable ? budget.plaintextCeiling : 0;
}

/**
 * Bind one E2EE channel session to the relay registry's channel contract.
 *
 * The close path is the reason this exists. `RelayRpcChannelSession.close` is
 * the only signal the E2EE layer gets that its channel is ending, so it is where
 * §10's close is entered and where §10.4's verdict is recorded — in that order,
 * and both before the RPC runtime is released.
 */
export function makeNodeE2eeRelayChannelSession(
  binding: NodeE2eeRelayChannelBinding,
): RelayRpcChannelSession {
  const { e2ee, rpc } = binding;
  return {
    receive: (bytes) => rpc.receive(bytes),
    queuedBytes: () => rpc.queuedBytes(),
    supportsChunkedMessages: () => rpc.supportsChunkedMessages(),
    close: async () => {
      // §10: the channel is ending, so the authenticated close is entered here
      // rather than skipped. It resolves as soon as the send path will not take
      // the `E2EEClose` — which is the case for a teardown the peer or the
      // registry initiated, where the channel is already gone — so this cannot
      // hold a teardown open waiting for a peer that can no longer answer.
      await e2ee.beginClose();
      // §10.4: "the relay chunk assembler holds an incomplete reassembled
      // message when the channel ends" is truncation regardless of any other
      // state, and it is only knowable here, before the assembler is reset by
      // the release below.
      e2ee.dispose({ incompleteReassembly: rpc.incompleteReassembly() });
      await binding.release();
    },
    onAccepted: () => e2ee.announce(),
  };
}

/**
 * The RPC byte session's output sink on a relay channel: §4.2's send pipeline —
 * the ceiling, the §9.3 admission, the pair, the AEAD, and the envelope — or
 * plaintext on a `legacy` channel. A refused response is a value carrying its
 * reason, not a defect, which would kill the RPC server fiber and every request
 * on it.
 */
export function nodeE2eeRpcSink(
  e2ee: NodeE2eeChannelSession,
): (bytes: Uint8Array) => Effect.Effect<void, RpcOutputRefusedError> {
  return (bytes) =>
    Effect.promise(() => e2ee.emit(bytes)).pipe(
      Effect.flatMap((result) =>
        result === "sent" ? Effect.void : Effect.fail(new RpcOutputRefusedError(result)),
      ),
    );
}

/**
 * §4.3: discrimination on the reassembled, prelude-stripped payload, and the
 * only path to the RPC parser.
 */
export function nodeE2eeRpcInterceptor(e2ee: NodeE2eeChannelSession): RpcInboundInterceptor {
  return (message) =>
    Effect.promise(() => e2ee.intercept(message)).pipe(
      Effect.flatMap((disposition) =>
        disposition.kind === "rejected"
          ? Effect.fail(new RpcInboundRejectedError())
          : Effect.succeed(disposition),
      ),
    );
}
