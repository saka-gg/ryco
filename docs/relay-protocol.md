# Ryco relay protocol 1.2

## Scope

The Ryco relay protocol multiplexes bounded logical channels between a client, a relay, and an
execution node. It defines connection authentication envelopes, version negotiation, channel
lifecycle, flow signals, heartbeat frames, stable errors, and opaque binary data frames.

The protocol does not define account behavior, credential verification, ticket issuance or
consumption, node enrollment, persistence, application RPC messages, connection scheduling, or
end-to-end encryption. Those behaviors belong to each deployment and runtime.

## Transport and framing

Each WebSocket binary message contains exactly one CBOR data item. The WebSocket message boundary
is the relay-frame boundary; there is no internal length prefix. WebSocket text messages are
invalid.

Frames use deterministic CBOR as defined by RFC 8949. The protocol profile is:

- The top-level value is a CBOR map.
- Structured nested values are maps; map keys are ASCII names matching
  `[A-Za-z][A-Za-z0-9._-]{0,63}`.
- Allowed scalar values are `null`, booleans, text strings, byte strings, and safe integers.
- Arrays may contain values from the same profile.
- Byte strings decode directly to `Uint8Array` and are never converted through text.
- Integers and lengths use their shortest representation.
- Maps use RFC 8949 deterministic bytewise key ordering.
- The decoder rejects indefinite-length values, tags, `undefined`, floats, unsafe integers,
  duplicate map keys, non-text map keys, trailing bytes, and noncanonical encodings.

An implementation can enforce canonical input by decoding strictly, validating the profile,
deterministically re-encoding the raw value, and comparing the result byte for byte before schema
validation.

## Version envelope

Every handshake and frame contains:

| Field           | Type                      | Meaning                               |
| --------------- | ------------------------- | ------------------------------------- |
| `type`          | bounded text discriminant | Stable frame class                    |
| `protocolMajor` | unsigned 16-bit integer   | Compatibility-breaking version        |
| `protocolMinor` | unsigned 16-bit integer   | Backward-compatible extension version |

The current version is `1.2`; the minimum compatible version is `1.0`. Version 1.1 adds the
optional `retryAfterMs` field on `channel.reject` and `error`. Version 1.2 adds negotiated channel
authorization metadata and bounded lifecycle close reasons.

For a peer using major version 1, the negotiated minor is the smaller of the peer's minor and 2.
The relay returns that version in `ready`. Every later frame on the connection must carry the exact
negotiated version. `retryAfterMs` is invalid when the frame declares minor version 0. The
`channel.open` authorization fields and the new 1.2 close reasons are invalid below minor 2.

An implementation receiving an unsupported major returns a fatal `error` frame with code
`protocol_unsupported`, its supported version range, and then closes the connection. It must not
attempt to translate opaque data between major versions.

Within a major version, fields introduced by a new minor may become required only after both peers
negotiate that minor. An older peer negotiates an older minor and never receives the conditional
field. Outside an established connection, an older implementation ignores unknown canonical
fields on a recognized structure after counting their bytes toward the encoded-size limit.
Missing or malformed fields required by the frame's declared minor, version-inappropriate known
fields, unknown `type` values, and unknown `auth.peer` values are rejected. Changing a field's
meaning or adding an incompatible frame class requires a new major version.

## Identifiers and binary material

| Value                     | Wire representation | Bound                                                                |
| ------------------------- | ------------------- | -------------------------------------------------------------------- |
| Node ID                   | text                | `node_` plus 22–43 Base64URL characters; at most 48 ASCII characters |
| Channel ID                | text                | `ch_` plus exactly 22 Base64URL characters                           |
| Data sequence             | unsigned integer    | 0 through 4,294,967,295                                              |
| Heartbeat nonce           | byte string         | exactly 8 bytes                                                      |
| Node authentication nonce | byte string         | exactly 32 bytes                                                     |
| Node signature material   | byte string         | 64 through 512 bytes                                                 |
| Relay ticket material     | byte string         | 32 through 64 bytes                                                  |

The node's registered identity determines signature verification semantics. Tickets, nonces, and
signatures are opaque to the codec. Schema validation never verifies credentials or consumes a
ticket. Hosted node authentication uses the existing nonce and signature fields with the exact
HTTPS-preflight transcript documented in [Node identity primitives](./node-identity.md); this adds
no relay frame or version change.

## Authentication handshakes

Authentication is the first frame and must arrive within the fixed pre-negotiation authentication
deadline. There are two explicitly separate shapes.

Node authentication:

```text
{
  type: "auth",
  peer: "node",
  protocolMajor,
  protocolMinor,
  nodeId,
  nonce,
  signature
}
```

Client authentication:

```text
{
  type: "auth",
  peer: "client",
  protocolMajor,
  protocolMinor,
  relayTicket
}
```

The schema defines representation and bounds only. Authentication policy and credential state are
outside the protocol contract.

## Negotiated limits

After successful deployment-specific authentication, the relay sends `ready` with the negotiated
version and authoritative connection limits:

```text
{
  type: "ready",
  protocolMajor,
  protocolMinor,
  limits: {
    maxControlFrameBytes,
    maxDataChunkBytes,
    maxQueuedBytes,
    maxChannels,
    heartbeatIntervalMs,
    deadConnectionTimeoutMs,
    authenticationDeadlineMs
  }
}
```

Initial values and protocol ranges are:

| Limit                          | Initial value |  Inclusive range |
| ------------------------------ | ------------: | ---------------: |
| Control-frame bytes            |       262,144 |    1,024–262,144 |
| Data or attachment chunk bytes |       262,144 |    1,024–262,144 |
| Queued bytes per connection    |     8,388,608 |  2,048–8,388,608 |
| Simultaneous channels          |             8 |              1–8 |
| Heartbeat interval             |     20,000 ms |  5,000–20,000 ms |
| Dead-connection timeout        |     45,000 ms | 15,000–45,000 ms |
| Authentication deadline        |      5,000 ms |   1,000–5,000 ms |

`maxQueuedBytes` must be at least the larger of `maxControlFrameBytes` and
`maxDataChunkBytes + 1,024`. `deadConnectionTimeoutMs` must be at least twice
`heartbeatIntervalMs`. A peer rejects a `ready` frame that violates an individual or relational
limit.

## Frame classes

All fields listed without “optional” are required.

| `type`           | Fields beyond the version envelope                             | Purpose                                |
| ---------------- | -------------------------------------------------------------- | -------------------------------------- |
| `auth`           | `peer` plus the node or client handshake fields                | Authenticate the connection            |
| `ready`          | `limits`                                                       | Confirm negotiated version and limits  |
| `channel.open`   | `channelId`; on 1.2+, `capability`, `effectiveRole`            | Announce an authorized logical channel |
| `channel.accept` | `channelId`                                                    | Accept a logical channel               |
| `channel.reject` | `channelId`, `reason`, optional `retryAfterMs`                 | Reject a logical channel               |
| `data`           | `channelId`, `sequence`, `payload`                             | Carry opaque bytes                     |
| `flow.pause`     | `channelId`                                                    | Ask a producer to pause one channel    |
| `flow.resume`    | `channelId`                                                    | Resume one paused channel              |
| `channel.close`  | `channelId`, optional `reason`                                 | Close one channel                      |
| `ping`           | `nonce`                                                        | Probe connection liveness              |
| `pong`           | matching `nonce`                                               | Answer a liveness probe                |
| `error`          | `code`, `fatal`, optional `supported`, optional `retryAfterMs` | Report a connection-level error        |

An omitted `channel.close.reason` is an orderly close. When present, it must be one of the stable
close reasons. `retryAfterMs` is an integer from 0 through 300,000 and is available only in protocol
minor 1 or newer.

Protocol 1.2 `channel.open` requires both authorization fields:

```text
{
  type: "channel.open",
  protocolMajor: 1,
  protocolMinor: 2,
  channelId,
  capability: "ryco.rpc",
  effectiveRole: "viewer" | "operator" | "owner"
}
```

`capability` identifies the bounded application surface authorized for the logical channel.
`ryco.rpc` is the only initial capability. `effectiveRole` is the authorizing deployment's
least-privilege result and lets the receiving execution node enforce role policy without decoding
opaque relay data or trusting browser state. Both fields are absent on protocol 1.0 and 1.1 and
required on protocol 1.2 or newer.

A `protocol_unsupported` error is fatal and must include:

```text
supported: {
  protocolMajor,
  minimumMinor,
  maximumMinor
}
```

No frame carries an arbitrary validation-error message.

## Frame direction

The contract permits these normal directions without defining connection-management behavior:

| Frame                                        | Normal direction                                       |
| -------------------------------------------- | ------------------------------------------------------ |
| `auth`                                       | Client or node to relay                                |
| `ready`                                      | Relay to authenticated peer                            |
| `channel.open`                               | Relay to node and client                               |
| `channel.accept`, `channel.reject`           | Node to relay, then relay to client                    |
| `data`                                       | Bidirectional across an accepted channel               |
| `flow.pause`, `flow.resume`, `channel.close` | Either endpoint through the relay                      |
| `ping`, `pong`                               | Per connection in either direction                     |
| `error`                                      | Any peer detecting a connection-level protocol failure |

## Opaque data boundary

`data.payload` is a CBOR byte string no larger than the negotiated data-chunk limit. The relay
routes it using `channelId` and ordering metadata but does not parse it as Ryco RPC, events,
terminal data, attachments, JSON, text, or any other application format.

Transport ordering is per WebSocket connection. `sequence` is an unsigned per-direction channel
counter that starts at zero and increases by one; a connection runtime may close a channel on a
gap, duplicate, or wrap. Durable application replay remains inside the opaque application
protocol.

The trusted-relay boundary permits TLS termination and the forwarding process to observe the bytes
it forwards in memory — which are the application-level layer's ciphertext on a channel that
negotiated payload encryption. A conforming relay must not log or persist opaque payloads. Keeping
the payload schema opaque is what lets that encryption layer exist without changing relay routing.

That reservation is exercised by
[End-to-end relay payload encryption](./relay-e2ee-protocol.md), which defines an application-level
encryption layer carried entirely inside `data.payload`. It adds no relay frame, field, limit,
close reason, or version change; encrypted payloads remain opaque byte strings that the relay
routes exactly as this document specifies.

Node-to-client compression of large, allowlisted RPC messages
([relay payload encryption §4.6](./relay-e2ee-protocol.md#46-relay-payload-compression-node-to-client))
is likewise carried inside `data.payload`. On an encrypted channel it sits inside the encrypted
record, so the relay sees only the record's length. It is negotiated in-band between client and
node and needs nothing from the relay.

## Encoded-size enforcement

Size is checked before semantic validation:

| Class                       |                   Limit |
| --------------------------- | ----------------------: |
| Absolute WebSocket message  | 263,168 bytes (257 KiB) |
| Any non-`data` frame        | 262,144 bytes (256 KiB) |
| `data.payload`              | 262,144 bytes (256 KiB) |
| Entire encoded `data` frame | 263,168 bytes (257 KiB) |

An input above the absolute limit fails before CBOR decoding. After reading a canonical map, the
decoder applies the data or control-frame limit. Missing and unknown discriminants use the control
limit. Unknown optional fields count toward every encoded-size limit.

## Stable close reasons

The stable close-reason set is exactly:

- `authentication_required`
- `authentication_failed`
- `ticket_expired`
- `ticket_consumed`
- `node_offline`
- `node_revoked`
- `grant_revoked`
- `protocol_unsupported`
- `frame_too_large`
- `slow_consumer`
- `rate_limited`
- `server_draining`
- `internal_error`
- `authentication_timeout` (protocol 1.2+)
- `authorization_failed` (protocol 1.2+)
- `channel_rejected` (protocol 1.2+)
- `connection_replaced` (protocol 1.2+)
- `transfer_limit` (protocol 1.2+)
- `revoked` (protocol 1.2+)

The reasons marked protocol 1.2+ are invalid on `channel.reject`, `channel.close`, or `error`
frames declaring minor 0 or 1. Existing reasons retain their original meaning and availability.

## Deterministic validation errors

Codec APIs return a bounded result rather than exposing CBOR, Effect Schema, or runtime exceptions.
The stable validation codes are:

- `frame_too_large`
- `invalid_encoding`
- `invalid_frame`
- `invalid_limits`
- `missing_discriminant`
- `unknown_frame_type`
- `protocol_unsupported`

Close reasons are also valid wire `error.code` values. Failure precedence is:

1. `frame_too_large` for the absolute WebSocket-message limit, before decoding
2. `invalid_encoding`
3. `frame_too_large` for a canonical control/data frame or data payload over its class limit
4. `invalid_frame` for a missing or malformed version envelope
5. `protocol_unsupported`
6. `missing_discriminant`
7. `unknown_frame_type`
8. `invalid_limits`
9. Other schema failures as `invalid_frame`

Failures may contain documented nonsecret metadata such as a supported version range. They must
never contain input values, payload bytes, credentials, tickets, parser causes, stack traces, or
internal filesystem paths. User-facing text is selected locally from the stable code; unsupported
protocol maps to a fixed upgrade-facing message.

## Compatibility matrix

| Client or node        | Protocol 1.1 relay                                                                     |
| --------------------- | -------------------------------------------------------------------------------------- |
| Protocol 1.0          | Accepted; negotiate 1.0; v1.1 optional fields are omitted                              |
| Protocol 1.1          | Accepted with all current fields                                                       |
| Future protocol 1.x   | Negotiate 1.1; canonical optional fields are ignored; unknown frame types are rejected |
| Protocol 2.x or later | Return fatal `protocol_unsupported` with the supported range, then close               |

The matrix applies independently to client-relay and node-relay connections.

## Canonical fixtures

The source-of-truth fixtures live in
[`packages/contracts/fixtures/relay/v1`](../packages/contracts/fixtures/relay/v1). Each `.cbor` file
is exactly one WebSocket binary-message payload. `manifest.json` records each file's purpose,
encoded length, SHA-256 digest, and expected decoded value or deterministic error code. Manifest
byte strings use lowercase hexadecimal.

Valid fixtures cover both handshakes, every frame class, protocol 1.0, and a future optional field.
Invalid fixtures cover malformed and noncanonical CBOR, truncation, trailing bytes, missing and
unknown discriminants, unsupported major versions, missing fields, malformed and oversized
identifiers, invalid binary values, invalid limits, invalid minor-version fields, and every encoded
size boundary.

Run `bun run generate:relay-fixtures` only for an intentional contract change. Golden tests
regenerate the corpus in memory and compare every byte and manifest digest; tests never rewrite
fixtures. Consumers must use an immutable Ryco version or commit and verify the fixture hashes
rather than maintaining an unproven copy.
