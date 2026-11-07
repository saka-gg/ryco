/**
 * Where the relay frame tunnel meets one relay RPC channel.
 *
 * Tunnel messages are the bodies of ordinary inner RPC records on an `e2ee`
 * channel, told from JSON RPC by their first byte (`@ryco/shared/relayFrameTunnel`).
 * The interceptor below claims them after §4.3's discrimination and the §4.4
 * decryption, so they never reach the JSON parser or the response compressor's
 * inbound filter. A `legacy` channel never admits them: its payloads are
 * plaintext to the Hub, and the same bytes there keep reaching the parser
 * exactly as they would on a node without the tunnel.
 *
 * The host itself (`relayFrameTunnelHost`, and through it the device frame
 * viewer) loads with a channel's first tunnel message, so a channel that never
 * streams a device costs one closure and a boot pays nothing for it.
 *
 * @module hubConnector/relayFrameTunnelChannel
 */
import { isRelayFrameTunnelMessage } from "@ryco/shared/relayFrameTunnel";
import { Effect } from "effect";

import { authorizeRpcPrincipal } from "../auth/wsAuthorization.ts";
import type { RpcInboundDisposition, RpcInboundInterceptor } from "../ws/RpcByteSession.ts";
import type { RpcPrincipal } from "../ws/RpcPrincipal.ts";

/** What the channel needs of the tunnel host. */
export interface RelayFrameTunnelEndpoint {
  readonly receive: (message: Uint8Array) => void;
  readonly close: () => void;
}

/**
 * Live input through the tunnel follows the device input RPC's rule, owner
 * sessions only, read from the relay channel's principal the way the direct
 * frame socket reads it from its session. Decided once per channel, like the
 * channel's role.
 */
export function relayFrameTunnelCanDrive(principal: RpcPrincipal): boolean {
  return Effect.runSync(
    authorizeRpcPrincipal(principal, "owner", "device live input").pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    ),
  );
}

const CLAIMED: RpcInboundDisposition = Object.freeze({ kind: "claimed" } as const);

/**
 * Claim tunnel messages from `inner`'s RPC dispositions, on an end-to-end
 * encrypted channel only. Malformed tunnel messages are claimed too, and the
 * host drops them: a `0xFE` body is never JSON.
 */
export function withRelayFrameTunnel(
  inner: RpcInboundInterceptor,
  options: {
    readonly endToEndEncrypted: () => boolean;
    readonly tunnel: RelayFrameTunnelEndpoint;
  },
): RpcInboundInterceptor {
  return (message) =>
    inner(message).pipe(
      Effect.map((disposition) => {
        if (
          disposition.kind !== "rpc" ||
          !isRelayFrameTunnelMessage(disposition.message) ||
          !options.endToEndEncrypted()
        ) {
          return disposition;
        }
        options.tunnel.receive(disposition.message);
        return CLAIMED;
      }),
    );
}

/**
 * Messages that may wait for the host to load. Far more than a client sends
 * before the first answer (an open, maybe a text); the rest are dropped.
 */
const MAX_PENDING_MESSAGES = 64;

/**
 * A tunnel endpoint that loads its host on the first message and hands it
 * every message in arrival order. A failed load drops what waited and tries
 * again with the next message. Never throws into the caller, which is the RPC
 * session's consumer fiber.
 */
export function makeLazyRelayFrameTunnel(
  load: () => Promise<RelayFrameTunnelEndpoint>,
  options: { readonly onError?: (error: unknown) => void } = {},
): RelayFrameTunnelEndpoint & { readonly loaded: () => boolean } {
  let host: RelayFrameTunnelEndpoint | null = null;
  let loading = false;
  let closed = false;
  const pending: Uint8Array[] = [];

  const deliver = (target: RelayFrameTunnelEndpoint, message: Uint8Array) => {
    try {
      target.receive(message);
    } catch (error) {
      options.onError?.(error);
    }
  };

  const startLoad = () => {
    loading = true;
    let promise: Promise<RelayFrameTunnelEndpoint>;
    try {
      promise = load();
    } catch (error) {
      promise = Promise.reject(error);
    }
    promise.then(
      (loaded) => {
        loading = false;
        if (closed) {
          loaded.close();
          return;
        }
        host = loaded;
        for (const message of pending.splice(0)) deliver(loaded, message);
      },
      (error: unknown) => {
        loading = false;
        pending.length = 0;
        options.onError?.(error);
      },
    );
  };

  return {
    receive: (message) => {
      if (closed) return;
      if (host) {
        deliver(host, message);
        return;
      }
      if (pending.length < MAX_PENDING_MESSAGES) pending.push(message);
      if (!loading) startLoad();
    },
    close: () => {
      if (closed) return;
      closed = true;
      pending.length = 0;
      try {
        host?.close();
      } catch {
        // The channel is ending either way.
      }
      host = null;
    },
    loaded: () => host !== null,
  };
}
