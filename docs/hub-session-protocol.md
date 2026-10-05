# Persistent Hub session protocol

Hosted browsers hold one account-scoped WebSocket at `/v1/relay/session`. Execution nodes
keep their existing outbound `/v1/relay/node` connections. The Hub routes independently
authorized logical relay streams through the browser session. Changing a thread or device,
closing a logical stream, or losing a node does not close the account socket.

The upgrade requires the same exact-origin, matching-host, HttpOnly browser-session policy
as the existing relay client endpoint. Native DPoP clients retain `/v1/relay/client`.
The physical session grants no node or mutation authority. Each logical stream still
consumes a fresh single-use node ticket, negotiates the existing relay protocol and E2EE
channel, and accepts a current shell snapshot before mutations become available.

## Version 1 wire format

The canonical schema is `@ryco/contracts/hub-session`; the codec is
`@ryco/shared/hubSessionCodec`. Every binary message starts with a one-byte kind and a
four-byte unsigned big-endian stream ID. Session control frames use ID zero. Stream IDs
start above zero, increase monotonically, and are never reused within a physical connection.

| Kind | Frame        | Payload                                                                            |
| ---- | ------------ | ---------------------------------------------------------------------------------- |
| 1    | `open`       | Empty; reserves a logical stream awaiting its relay authentication frame           |
| 2    | `data`       | One unchanged canonical relay frame, including its E2EE payload                    |
| 3    | `close`      | Two-byte big-endian close code followed by at most 64 UTF-8 bytes of stable reason |
| 4    | `ready`      | Protocol version byte (1), then maximum logical channel count                      |
| 5    | `ping`       | Eight-byte nonce                                                                   |
| 6    | `pong`       | The exact eight-byte ping nonce                                                    |
| 7    | `invalidate` | One-byte mask: bit 0 directory changed, bit 1 thread cache changed                 |

The Hub sends `ready` before any other frame. Unknown versions, kinds, invalid IDs,
oversized messages, or invalid control payloads fail closed. A stream's first `data`
contains the existing relay `auth` frame with its ticket. Subsequent bytes are handled
by the existing relay engine. Stream IDs never replace node, role, grant, ticket, or
generation checks. Closed stream data cannot enter a newer stream.

There are at most eight logical streams per session. The outer queue is bounded at
2 MiB including native socket buffering and at most 2,048 queued frames; individual relay and process limits still
apply. Send capacity reserves room for control frames. Tickets and queued payload bytes
are erased on disposal or loss. The manager never replays application writes across
physical reconnections: fresh logical streams must establish fresh authority.

The idle session uses a 20-second heartbeat and 45-second liveness bound. Successful
stable operation resets the bounded reconnect backoff. Authentication revocation is
terminal; ordinary network loss uses bounded, jittered retries. Signing out disposes
every logical stream and the physical socket. Account/session generations fence stale
callbacks. An unsupported session endpoint or protocol does not silently fall back to
a weaker transport.

## Subscriptions and lifecycle

Authorized, coalesced invalidations carry no conversation content or identifiers.
Clients re-read the existing authorized directory and opted-in thread cache HTTP APIs.
Reconnection invalidates both domains to catch changes missed while disconnected.
Directory polling slows to a two-minute backstop while the account subscription is
online; cached history polling is retained as a fallback when it is unavailable.

Ordinary tab hiding preserves a healthy connection. Offline, page freeze, and page
history suspension withdraw mutation authority immediately. Recovery after an actual
suspension still belongs to the shared hosted lifecycle owner: session revalidation,
current directory, a fresh relay attempt, and current shell snapshot. Foregrounding an
already healthy or initially synchronizing connection does not restart it.

This transport does not persist arbitrary RPC, terminal, file, or attachment content.
Opted-in cloud history remains the bounded projection described in
[`hosted-hub-client.md`](./hosted-hub-client.md). The service worker remains a static-shell
mechanism and never carries or caches the data plane.
