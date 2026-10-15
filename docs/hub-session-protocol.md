# Persistent Hub session protocol

Hosted browsers hold one account-scoped WebSocket at `/v1/relay/session`. Execution nodes
keep their existing outbound `/v1/relay/node` connections. The Hub routes independently
authorized logical relay streams through the browser session. Changing a thread or device,
closing a logical stream, or losing a node does not close the account socket.

The upgrade requires the same exact-origin, matching-host, HttpOnly browser-session policy
as the existing relay client endpoint. Native DPoP clients retain `/v1/relay/client`.
The physical session grants no node or mutation authority. Each logical stream still
consumes a fresh single-use node ticket, negotiates the existing relay protocol and E2EE
channel, and accepts a current shell snapshot before mutations become available. On version 2
the Hub may mint and consume that ticket itself (`openNode`, below); it is never weaker than the
HTTP ticket it replaces.

## Version negotiation

A client advertises the highest version it decodes as its WebSocket subprotocol,
`ryco.hub-session.v<N>` (today `ryco.hub-session.v2`). The upgrade path, origin policy, and
credentials are unchanged, and the URL still carries no query string. The Hub answers in `ready`
with the lower of the client's maximum and its own; it selects the offered subprotocol unchanged,
so the selection carries no meaning. A client that offers nothing, or an unrecognised token, gets
version 1. A Hub that predates version 2 ignores the offer: it accepts the upgrade, selects the
offered token, and sends version 1 `ready`. A version 2 Hub enables version 2 only behind its
rollout flag; with the flag off it is a version 1 Hub.

Browsers fail a handshake that offered a subprotocol and got none back, so an intermediary that
strips `Sec-WebSocket-Protocol` would break every connection, version 1 included. A browser cannot
tell that failure apart from any other failure before the socket opens (a Hub restart, a draining
`503`, a rate-limited `429`), so the client acts only on a repeated pattern. A handshake that
offered the subprotocol and failed before opening is retried offering none. If that one opens,
stripping is only suspected: that connection runs version 1, and the next reconnect offers again.
Only when that offered handshake fails again and the next one offering none opens does the client
stop offering, for ten minutes. A handshake offering none that fails too is an outage, and all
evidence is dropped. A deploy or restart therefore costs at most one version 1 connection, and the
fallback only ever costs latency: version 1 is always available.

The negotiated version applies to that physical connection only. Each replacement connection
negotiates again, and the client reads every frame with the version its current `ready` named: a
frame a lower version does not define fails closed exactly as an unknown kind does in version 1.

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
contains the existing relay `auth` frame with its ticket (version 2 `openNode` streams carry
none; see below). Subsequent bytes are handled
by the existing relay engine. Stream IDs never replace node, role, grant, ticket, or
generation checks. Closed stream data cannot enter a newer stream.

## Version 2 additions

Version 2 changes no version 1 frame: `open`, `data`, `close`, `ping`, `pong`, `invalidate`, and
version 1 `ready` stay byte for byte identical, and a version 2 session still accepts `open`.

| Kind | Frame        | Payload                                                                                                                                                                              |
| ---- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 4    | `ready` (v2) | Version byte (2), maximum logical channel count, then the account id and the browser session id, each as a one-byte length and ASCII                                                 |
| 8    | `openNode`   | Relay protocol major (1), minor (2 or 3), capability code (1 = `ryco.rpc`), then the node id and the expected browser session id, each as a one-byte length and ASCII; stream ID > 0 |

Version 2 `ready` names the account and browser session the Hub authenticated the socket as. It is
sent only to a client that advertised version 2, and the ids are the ones the authenticated session
API already returns to that browser. The client binds server-minted opens to them: it offers
`openNode` only when both ids equal the account and session it restored and created the socket
for. A connection authenticated as anyone else (say, the cookie was replaced by a sign-in in
another tab) opens nothing server-minted, closes any stream waiting to, and hands the session back
to the hosted lifecycle owner to revalidate. `openNode` also names the expected session id, and the
Hub refuses the open (`authentication_failed`) when it is not the socket's own: a server-minted
ticket is bound to one browser session exactly as an HTTP ticket is to the session that bought it.

`openNode` opens a logical stream that the Hub authenticates itself. Before anything else the Hub
re-authorizes the socket's cookie session exactly as for `open` and checks the expected session id.
It then mints and consumes, in one operation, a single-use ticket for that session and the named
node, under the authorization checks of the HTTP ticket endpoint: browser session kind, the
session's active space, node authorization and revocation, node presence and its live protocol
binding, and the protocol minor rules; the Hub's ticket rate limiting and auditing apply to it as
to an HTTP request. No unconsumed ticket exists at any point, and no ticket value ever leaves the Hub. The
stream then continues exactly as one whose relay `auth` frame was accepted: its first inbound frame
is the relay `ready`, or a canonical relay refusal and close, and the client sends no `auth` frame.
On an `openNode` stream, `authentication_failed` always refers to the session (re-authorization
failed, the named session is not the socket's, or issuance found the session revoked); a node
connection that changes during the open is reported as `node_offline`. A session refusal is the
counterpart of an HTTP `401`. The client hands the session to its lifecycle owner to revalidate,
at most once per 30 seconds per session. The owner expires a session the Hub no longer accepts, and
otherwise leaves the relay transport's own backoff in charge. The relay authentication
deadline, node `channel.open`/`channel.accept`, E2EE, and every later check are unchanged.

Fail-closed rules:

- `openNode` and version 2 `ready` on a connection that negotiated version 1 are invalid frames: a
  version 1 Hub, or a version 2 Hub whose flag is off, closes the physical socket with
  `invalid_request`. A client never sends `openNode` unless its current `ready` was version 2.
- A stream the client created for `openNode` that is still waiting for a replacement connection
  when that connection negotiates version 1 is closed locally with a retryable reason. Nothing was
  sent for it; the owner's next attempt finds no version 2 session and buys an HTTP ticket.
- The client does not choose `openNode` while the connection is under a liveness probe or before
  `ready`; those attempts use an HTTP ticket.
- An unsupported relay minor is refused like an HTTP `426`, with the `protocol_unsupported` close.

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
