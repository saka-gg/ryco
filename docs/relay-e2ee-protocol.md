# Ryco relay E2EE protocol 1

- **Status**: Normative. This document completed its dedicated adversarial protocol-security
  review with no blocking finding and has merged; its wire formats, constants, and registries
  bind every implementation. A change to any of them is a protocol change: it requires its own
  review, and it may not be made to accommodate an implementation difficulty. Implementations
  track the merged revision. The §18 account-enrolled extension is implemented and covered by its
  normative amendment and generated corpus, but broad admission/default rollout remains gated by
  independent review, physical-device qualification, and live staged-rollout evidence.
- **Protocol version**: 1 (`E2EE_PROTOCOL_VERSION`, §3).
- **Layers inside**: [Ryco relay protocol 1.2/1.3](./relay-protocol.md) `data.payload`.
- **Companion documents**: [relay protocol](./relay-protocol.md),
  [node identity primitives](./node-identity.md), [hosted Hub client](./hosted-hub-client.md),
  [browser vectors](./relay-e2ee-web-browser-vectors.md),
  [third-party audit scope](./relay-e2ee-noise-audit-scope.md), and
  [rollout readiness](./relay-e2ee-rollout-readiness.md).

## 1. Status and scope

This protocol makes relayed application payloads AEAD ciphertext end to end between a client and
its execution node. It defines the encrypted envelope, negotiation and handshake records, the
capability advertisement, key hierarchy and custody, record protection and rekeying, authenticated
close, downgrade resistance, node admission policies, and the trust-establishment surfaces
(pinning, pairing, safety numbers). It is the canonical wire specification: where prose elsewhere
disagrees with this document, this document governs.

### 1.1 Relationship to the relay protocol

The E2EE layer lives entirely inside the relay `data.payload` byte string, beneath the relay frame
schema and above the application RPC JSON. The relay protocol reserves exactly this evolution:
"Keeping the payload schema opaque allows later application-level end-to-end encryption without
changing relay routing" ([relay-protocol.md](./relay-protocol.md), Opaque data boundary).
Accordingly, the original locally approved IK and unsigned Web NX modes remain ordinary relay
protocol 1.2 channels and require no relay data-plane change. The account-enrolled native extension
of §18 negotiates relay protocol 1.3 because its authorization is bound to public ticket and
grant digests carried by `channel.open`, and because nodes publish acknowledged capability statements
and consume Hub verifier-key and revocation control frames. Those protocol-1.3 additions remain
control-plane metadata: the relay still forwards `data.payload` without parsing it and never receives
Noise keys or plaintext.

E2EE vectors remain separate from the relay contract fixture corpus in
`packages/shared/fixtures/e2ee/v1`. Relay 1.2 behavior and suite `0x01` bytes are compatibility
fixtures and MUST NOT change when §18 is implemented.

The reference implementation home is `packages/shared`, beside
`packages/shared/src/relayMessageChunks.ts`, whose message-chunking pipeline this protocol slots
into (§4). `relay-protocol.md` references this document.

### 1.2 Terminology

- **The Hub** — the hosted relay deployment in the sense the public documents already use: the
  operator that terminates TLS, authenticates relay connections, mints and consumes tickets,
  authors `channel.open`, and serves the hosted web client
  ([hosted-hub-client.md](./hosted-hub-client.md)). This protocol treats the Hub as untrusted for
  payload confidentiality and integrity while it remains the authorization and routing authority.
- **Node** — the execution endpoint holding the durable Ed25519 node identity key.
- **Signed native tier** — a native mobile client holding a hardware-backed device identity key;
  uses the Noise IK pattern (§3.4).
- **Locally verified native authorization** — suite `0x01` IK admitted through Local Trusted
  Introduction or a durable approved-client record (§13.6).
- **Account-enrolled native authorization** — suite `0x02` IK admitted through a short-lived,
  ticket-bound Hub grant (§18). It is encrypted and mutually key-authenticated, but the Hub
  remains its authorization root.
- **Unsigned web tier** — the hosted web client; ephemeral, no durable client identity; uses the
  Noise NX pattern (§3.4).
- **Legacy** — a peer or channel operating the pre-E2EE plaintext RPC protocol.
- **Effective `requireE2EE`** — true for every policy mode except `compatibility` (§18.8).

RFC 2119/8174 requirement language applies as declared in §3.1.

### 1.3 Out of scope

The following are explicitly not provided by protocol version 1:

- **Operator-proof web E2EE.** Impossible under the served-code model; see §2.4.
- **Active-operator client authentication for the unsigned web tier.** NX authenticates the node
  to the web client, never the reverse.
- **Encrypted history mirroring.** Later work with its own specification.
- **Multi-party or group channels.** Relay channels remain 1:1 client-to-node per ticket.
- **Post-quantum or hybrid suites.** The envelope carries a suite identifier so these can be
  added later; adding different cryptographic primitives still requires its own reviewed handshake
  revision (§8). Suite `0x02` changes authorization inputs, not primitives.
- **Key escrow or recovery of session history.** Version 1 encrypts transport, not storage.
  Losing a device destroys its keys, pins, and accumulated local trust. A Hub login may enroll the
  replacement as a new account-trusted device under §18, but never restores or silently
  recreates locally verified trust.
- **Hardware-bound agreement keys.** The suite field keeps the migration path open (§6).
- **Post-compromise recovery within an open channel.** Epoch rekeying is a one-way symmetric
  ratchet, not a fresh DH; compromise of live session state can expose later epochs until the
  channel closes (§9).
- **Hub-mediated client-key synchronization.** Cross-device owner approval is defined by
  [`relay-e2ee-cross-device-approval-protocol.md`](./relay-e2ee-cross-device-approval-protocol.md),
  but the Hub never synchronizes private keys, pins, or trust decisions.

## 2. Threat model and guarantees

What this protocol delivers depends on the client tier, on whether the channel actually
negotiated E2EE, and on the node's admission policy. The statements below are deliberately
tiered; implementations and user-facing documentation MUST NOT present a stronger claim for a
weaker configuration.

### 2.1 Trust model

The Hub authenticates both relay connections, mints the single-use tickets, and authors
`channel.open` including its `capability` and `effectiveRole` fields. Node ids and channel ids
are Hub-minted identifiers. Nothing in the relay protocol lets a node distinguish a genuine
client from a session the Hub originated itself; only the locally verified signed-native tier plus
node-side client authorization (§13) closes that gap. The account-enrolled tier deliberately keeps
the Hub as authorization root (§18). Relay ordering and size checks are enforced by
the Hub, which E2EE treats as untrusted: the E2EE layer therefore provides its own replay,
reorder, and gap detection (§9) and authenticates nominally orderly termination (§10).

### 2.2 Per-channel guarantees by tier

Every claim in this table is per payload class as well as per tier. §8.10 states the Noise
authentication and confidentiality grade of each individual payload, and **§8.10 is
authoritative wherever this table is summarised in user-facing text**.

| Tier (channel state)                                                          | Pattern | Passive read                                  | Retroactive read                                 | Active Hub (originate an endpoint or substitute a node)                                                                    |
| ----------------------------------------------------------------------------- | ------- | --------------------------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| Legacy plaintext                                                              | —       | **Not protected** — operator policy only      | **Not protected**                                | **Not protected** — the plaintext flow has no client identity proof                                                        |
| Web, unsigned ephemeral                                                       | NX      | Protected while the served web code is honest | Protected while the served web code is honest    | **Not protected** — the Hub can originate an unsigned NX session and controls the served code                              |
| Native signed, not yet mutually verified                                      | IK      | Protected                                     | Protected (except IK message-1 metadata — §8.10) | **Not protected** — restricted to the pairing ceremony (§13); no application payload is released under an active-Hub claim |
| Native signed, account-enrolled                                               | IK      | Protected                                     | Protected (except IK message-1 metadata — §8.10) | **Not protected** — the Hub is the explicit authorization root and may enroll or substitute keys (§18)                     |
| Native signed, mutually verified (verified node pin + approved client record) | IK      | Protected                                     | Protected (except IK message-1 metadata — §8.10) | **Protected for this channel**                                                                                             |

- **Passive read**: a Hub or proxy that records, inspects, or leaks traffic sees only ciphertext
  and the metadata in §2.5. This closes accidental payload-persistence bugs and passive
  compromise.
- **Retroactive read**: recorded ciphertext stays sealed even if long-term identity or agreement
  keys leak later. This holds for all application payload and for every post-handshake record.
  §8.10 grades three of the four transport directions confidentiality 5 and the fourth — NX
  node→client — confidentiality 1, which is a statement about _whom_ the node is encrypting to
  rather than about forward secrecy; forward secrecy holds there through `ee`, which is exactly
  the passive/retroactive guarantee the web row of the table above claims (§8.10). It does
  **not** hold for the IK message-1 handshake payload, which
  Noise grades confidentiality 2: an observer who recorded the handshake and _later obtains the
  node agreement private key_ can decrypt it, exposing the §7.4 client certificate, the client
  identity key and its `ryco.client-key.v1` fingerprint, and the account and authority claim —
  certification metadata only, never application data (§8.10, §2.6). The exposure window per
  prekey is bounded by `E2EE_PREKEY_LIFETIME` and by destruction of the outgoing key after
  `E2EE_PREKEY_ROTATION_OVERLAP` (§6.4). Compromise of _live_ session state is excluded (§1.3).
- **Active Hub**: on the mutually verified signed native tier, a malicious or compelled Hub can
  complete neither endpoint of the session. It cannot originate the client, because the node
  accepts only client identity keys the owner approved for the claimed Hub/account namespace,
  role ceiling, and capability (§13). It cannot substitute its own node, because the native
  client releases no application payload until the node identity is verified against the local
  enrollment fingerprint and pinned (§13). The Noise static-key proofs prevent copied public
  keys or fingerprints from satisfying either gate. The row is **per channel** and presupposes
  that the client resolves the channel to one of its own pins before any Hub-supplied evidence
  arrives (§12.1.1). A channel whose selection resolves to no pin is not this row: it is
  genuine first contact, or the unexpected-node surface of §13.2.1, and neither releases
  application payload under this guarantee. That presupposition fails **wholesale**, for every
  channel at once, on a device whose durable trust state was destroyed by a reinstall, restore,
  transfer, or secure-store reset (§6.3, §13.1.1): such a device holds no pins, so no channel is
  this row until the owner re-runs §13.2.

### 2.3 Node admission policies

| Policy mode                            | Legacy | Web NX | Account-grant IK | Locally approved IK | Whole-node active-Hub protection |
| -------------------------------------- | ------ | ------ | ---------------- | ------------------- | -------------------------------- |
| `compatibility`                        | yes    | yes    | yes              | yes                 | no                               |
| `require-e2ee`                         | no     | yes    | yes              | yes                 | no                               |
| `require-native-e2ee`                  | no     | no     | yes              | yes                 | no                               |
| `require-locally-approved-native-e2ee` | no     | no     | no               | yes                 | **yes**                          |

`require-e2ee` closes only plaintext downgrade. `require-native-e2ee` additionally excludes Web,
but a malicious Hub can still enroll and authorize a native device. Only
`require-locally-approved-native-e2ee` removes every Hub-originatable admission path. Section 18.8
defines the durable enum, migration from the two legacy booleans, and live-channel withdrawal rules.

**The rows above describe the node's live channels, not only its future ones.** Narrowing a policy
is the **policy withdrawal** of §12.6 and §18.8: the node durably commits the change, then closes
every channel the new mode would no longer admit — legacy, then unsigned NX, then account-grant IK
as the mode moves right — and only then acknowledges the operator command. Without that sweep each
row would be true only of channels opened after the flip, because §15 arms no per-channel idle
deadline in `legacy` or in established `e2ee` and a channel therefore persists for as long as its
peer keeps it.

Downgrade resistance is tiered, and the two tiers deliver materially different things. Neither
may be described in the other's terms.

- **Native.** Resistance is a property of a pin the client resolves from **its own** node
  selection (§12.1.1), so it is evaluable before any Hub-supplied evidence arrives and survives
  process and device restarts. A channel whose selection resolves to a latched pin never falls
  back to plaintext, including when the advertisement is withheld or delayed. Every selection
  §12.1.1 classifies as **unexpected** — a pin that resolves but is not latched and carries no
  recorded consent, no resolved pin under a `(hubOrigin, accountId)` pair that already holds a
  verified pin, or no resolved pin on a Hub origin this install has already verified some node on
  — requires explicit owner consent before any plaintext is released, never a silent legacy lock
  (§13.2.1). The third case exists because `accountId` is **Hub-issued and not client-anchored**:
  the Hub picks the account half of the pair, so the guard is anchored on the device-level
  `anyNodeVerified(hubOrigin)` marker (§13.1) rather than on the pair alone. The retained exposure
  is a node on a Hub origin where this install has verified nothing at all, plus whatever the
  owner has explicitly consented to (§12.1.1, §17.4).

  **This resistance is install-scoped durable state, and it is not durable against the device.**
  Pins, latches, consents, and the marker all live in the device-only, non-synchronizing,
  non-backup class of §6.3, so an app reinstall, an OS device transfer or restore, or a platform
  secure-store reset destroys every one of them. A client in that state cannot tell it ever had
  any, behaves as a fresh install, and returns the whole device to the first-contact exposure
  above until the owner re-runs the §13.2 ceremony per node. §13.1.1 fixes what such a client may
  and may not do and what the owner MUST be shown; §17.11 records the residual risk. Disclosure
  text MUST NOT describe native downgrade resistance as surviving reinstall, restore, or device
  transfer.

- **Web.** The web client retains no durable latch, no pin of any kind, and no durable
  policy-generation memory (§5.7, §13.1). It sets an in-memory latch on the **first capability
  statement it validates** for a node in an application session (§12.1). Before that first
  validated statement, and again in every fresh application session, a web session has **no
  downgrade resistance at all**. Even once set, the web latch is best-effort with the same
  bounded scope as the `WebSAS` (§13.5): it catches accidental wrong-node routing and some
  non-Hub network interposition while the loaded code is honest, and it provides **nothing**
  against the Hub, which serves the code that implements it (§2.4). Only node-enforced
  effective `requireE2EE` closes the plaintext path for web.

The web disclosure text MUST state the web bullet above. It MUST NOT describe the web latch as
durable, cross-session, or Hub-resistant.

**One availability precondition applies to every row of both tables above.** E2EE is offered at
all only on relay connections whose Hub-asserted `maxDataChunkBytes` is at least
`E2EE_ADVERTISEMENT_MIN_CHUNK_BYTES`, and only by a node that can build and sign a conforming
capability statement (§5.5, §7.6.1). Below that limit no conforming advertisement can be carried,
so the node cannot advertise and no channel on that connection can negotiate E2EE. The
consequences are stated plainly rather than assumed away: under effective `requireE2EE` every
such channel fails closed and the node is unreachable until the condition is corrected; under the
compatibility default the channel is plaintext for exactly those selections §12.1.1 already
classifies as legacy-eligible — latched and unexpected selections still fail closed, because they
are decided before any evidence arrives. This is a Hub-reachable availability and downgrade
lever, it is counted and displayed in its own class (§12.5), it does not gate the §12.3 default
flip, and it is recorded as a residual risk in §17.4 and §17.13.

### 2.4 The web ceiling

The served web client is **never operator-proof**. The Hub serves every byte of the web
application's JavaScript. A malicious Hub may serve code that completes the genuine node
handshake, displays the genuine session `WebSAS` (§13), and separately exfiltrates plaintext or
traffic keys; an out-of-band comparison cannot make an attacker-controlled display trustworthy.
The web comparison flow remains mandatory because it catches accidental wrong-node routing and
some network interposition while the loaded code is honest, but it is explicitly advisory against
the Hub operator. Native mobile (independently distributed code, hardware-anchored identity,
durable pins) and the node are the endpoints that can support the active-Hub guarantee.

### 2.5 Retained Hub visibility

The following metadata remains visible to the Hub on every channel, including E2EE channels, by
design and not as a defect:

- which account and session talk to which node;
- channel open and close events and their reasons;
- frame sizes and timing;
- the `capability` and `effectiveRole` carried in `channel.open`;
- heartbeats;
- transfer-budget accounting.

### 2.6 Never delivered

- Protection of compromised endpoints (node host or client device).
- Traffic-analysis protection for the metadata in §2.5.
- An operator-proof web client (§2.4).
- Cryptographic proof that an abrupt channel close was attacker-caused rather than ordinary
  network failure. Authenticated close (§10) detects whether a nominally orderly termination is
  complete; an abrupt close is reported as **unclean, not attributed**, and detection of a
  dropped final message is not guaranteed. Specifically, the last close-machine record of an
  exchange is unacknowledged by construction, so a Clean verdict proves in-order delivery only up
  to the record named by the endpoint's close anchor — in a simultaneous close, only up to each
  side's `E2EEClose` (§10.1.1, §10.4). A sequence mismatch is likewise detection without
  attribution: a peer's own local send failure produces the same gap (§9.3, §9.7).
- Forward secrecy for the IK message-1 handshake payload. Later compromise of the node agreement
  private key exposes the certification metadata of every recorded IK handshake — the §7.4 client
  certificate, the client identity key and its `ryco.client-key.v1` fingerprint, and the account
  and authority claim. That is strictly more than the §2.5 metadata view, because §13.6 keeps
  client keys and fingerprints out of Hub persistence entirely. No application data is exposed
  (§8.10, §2.2).
- Post-compromise recovery within an open channel (§1.3).

## 3. Notation, constants, and registries

### 3.1 Requirement language and notation

The key words MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD NOT, RECOMMENDED, MAY,
and OPTIONAL in this document are to be interpreted as described in RFC 2119 and RFC 8174 when,
and only when, they appear in all capitals.

- `‖` denotes byte-string concatenation.
- `0xNN` denotes a single byte value in hexadecimal.
- `uint32be` / `uint64be` denote fixed-width unsigned big-endian integer fields of the widths
  given in §3.2. Every multi-byte integer field in this protocol is big-endian.
- `"…"` denotes the ASCII bytes of the quoted string, without a terminator.
- `bstr(x)` denotes the value `x` carried as a CBOR byte string.
- SHA-256 is FIPS 180-4. HMAC is RFC 2104. HKDF-Extract/HKDF-Expand are RFC 5869 instantiated
  with HMAC-SHA-256.
- Epoch and counter values MUST be represented as fixed-width byte arrays or arbitrary-precision
  integers that exactly cover their field range. IEEE-754 doubles (the JavaScript `number` type)
  are forbidden for these values in any conforming implementation.

Verified-behavior citations of the form "(verified against `<path>:<line>`, 2026-07-30)" appear
only in paragraphs marked _Note (non-normative)_ and refer to repository-relative paths in this
repository at the time of writing.

### 3.2 Constants

This table is the single source of truth for every constant in this protocol. Later sections
reference constants by name and never restate their values, with one bounded exception: the
paragraphs explicitly marked _Note (non-normative)_ that work an arithmetic example may show the
numbers, because an example with only names in it demonstrates nothing. Those notes are never
normative and never define a value. Registry **values** — inner and negotiation record types,
suite ids, direction labels (§3.4), and the encrypted error codes (§11.3) — are not constants in
this sense: each has exactly one defining registry, which governs it, and where a later section
repeats such a value it does so only to name the registry entry whose behavior it is specifying,
never to define one. The **identifier-format table of §7.1** — the fixed prefixes and body widths
of the node, key, prekey, and continuity identifiers — is a defining registry in exactly this
sense and is the only other one; no further table may claim this status without being named here.
The post-strip discriminators this protocol itself defines go the other way:
`E2EE_ENVELOPE_DISCRIMINATOR` and `E2EE_NEGOTIATION_DISCRIMINATOR` are named constants of this
table and the §3.4 registry refers to them by name; the legacy-JSON first bytes that registry also
enumerates are properties of the pinned RPC serialization rather than constants of this protocol.
The rows marked area _Relay chunking_
or _Relay connection_
are defined by the relay protocol and its message-chunking layer
(`packages/contracts/src/relay.ts`, `packages/shared/src/relayMessageChunks.ts`); the row marked
area _RPC keepalive_ is defined by the pinned RPC client; and the two `ED25519_*` rows are defined
by the node identity primitives. All four groups are restated here for
cross-checking and their defining modules remain authoritative for them. One row in those groups —
`RELAY_CLOSE_REASONS` — **names** a relay-owned set without restating its members: the set is large
enough that a copy here would become a second definition site rather than a cross-check, and §1.1
forbids forking a relay-owned registry. The name exists so §11.1 can state membership over one
name, exactly as `RELAY_CAPABILITY_LITERALS` exists so §8.3 element 11 can.

| Area               | Name                                       | Value                                                                                                                            | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------ | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Wire               | `E2EE_ENVELOPE_DISCRIMINATOR`              | `0x01`                                                                                                                           | First post-strip byte of every E2EE envelope                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Wire               | `E2EE_NEGOTIATION_DISCRIMINATOR`           | `0x02`                                                                                                                           | First post-strip byte of every negotiation record                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Wire               | `E2EE_PROTOCOL_VERSION`                    | `0x01`                                                                                                                           | Envelope `version` field value for protocol version 1                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Wire               | `E2EE_ENVELOPE_HEADER_BYTES`               | 15                                                                                                                               | Envelope header length: discriminator, version, suite, epoch, counter                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Wire               | `E2EE_EPOCH_FIELD_BYTES`                   | 4                                                                                                                                | Epoch field width (`uint32be`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Wire               | `E2EE_COUNTER_FIELD_BYTES`                 | 8                                                                                                                                | Counter field width (`uint64be`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Wire               | `E2EE_AEAD_TAG_BYTES`                      | 16                                                                                                                               | ChaCha20-Poly1305 authentication tag length                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Wire               | `E2EE_INNER_TYPE_BYTES`                    | 1                                                                                                                                | Encrypted inner-record type prefix length                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Wire               | `E2EE_ENVELOPE_OVERHEAD_BYTES`             | 32                                                                                                                               | `E2EE_ENVELOPE_HEADER_BYTES + E2EE_AEAD_TAG_BYTES + E2EE_INNER_TYPE_BYTES`; also the minimum envelope length                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Wire               | `E2EE_AEAD_NONCE_BYTES`                    | 12                                                                                                                               | AEAD nonce length: epoch ‖ counter, exactly the ChaCha20-Poly1305 nonce                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Wire               | `E2EE_SESSION_BINDING_HASH_BYTES`          | 32                                                                                                                               | Length of `sessionBindingHash` (SHA-256 output, §8)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Wire               | `E2EE_DIRECTION_LABEL_BYTES`               | 3                                                                                                                                | Length of a direction label (§3.4)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Wire               | `E2EE_AAD_BYTES`                           | 50                                                                                                                               | AAD length: header ‖ `sessionBindingHash` ‖ direction label                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Wire               | `E2EE_CONTEXT_COMMITMENT_BYTES`            | 32                                                                                                                               | Length of `contextCommitment` (SHA-256 output, §8)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Wire               | `E2EE_HANDSHAKE_NONCE_BYTES`               | 32                                                                                                                               | Length of the `E2EEClientHello` `clientNonce` field (§8)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Wire               | `E2EE_CONFIRMATION_BYTES`                  | 32                                                                                                                               | Length of `serverConfirmation` (HMAC-SHA-256 output, §8)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Wire               | `E2EE_CLOSE_COMMITMENT_BYTES`              | 32                                                                                                                               | Length of `closeCommitment` (SHA-256 output, §10)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Wire               | `E2EE_ERROR_BODY_MAX_BYTES`                | 16                                                                                                                               | Maximum `E2EEError` body length (§11)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Negotiation        | `E2EE_CLIENT_HELLO_MAX_BYTES`              | 4,096                                                                                                                            | Maximum total `E2EEClientHello` record length. Deliberate headroom, not a derived bound: the worst conforming record is far smaller, and no S-invariant ties this value to the record's structure. A revision that grows §7.4 or §8.5 MUST re-check the worst case against this value by hand, because no fixture will fail first                                                                                                                                                                                                                                                                                   |
| Negotiation        | `E2EE_SERVER_ACCEPT_MAX_BYTES`             | 8,192                                                                                                                            | Maximum total `E2EEServerAccept` record length (carries the Noise response, the `channel.open` authority echo, and the prekey binding). Deliberate headroom on the same terms as the row above, with the same hand-check obligation on any revision that grows §8.7                                                                                                                                                                                                                                                                                                                                                 |
| Negotiation        | `E2EE_HANDSHAKE_REJECT_BYTES`              | 64                                                                                                                               | Exact total `E2EEHandshakeReject` record length — the only pre-key error record, generic and fixed-size                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Negotiation        | `E2EE_HANDSHAKE_REJECT_PAD_BYTES`          | 60                                                                                                                               | Zero-byte padding length inside `E2EEHandshakeReject`, sized so the record totals exactly `E2EE_HANDSHAKE_REJECT_BYTES` (§11)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Negotiation        | `E2EE_HUB_ORIGIN_MAX_BYTES`                | 128                                                                                                                              | Maximum UTF-8 byte length of a canonical Hub origin appearing in any E2EE transcript; deliberately tighter than the bound the node identity primitives apply, so the §3.2.1 size invariants close (§7.1)                                                                                                                                                                                                                                                                                                                                                                                                            |
| Negotiation        | `E2EE_SUITE_REGISTRY_MAX_ENTRIES`          | 8                                                                                                                                | Maximum number of suite ids a capability statement may offer (§7.6 element 9)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Negotiation        | `E2EE_CAPABILITY_TRANSCRIPT_MAX_BYTES`     | 5,120                                                                                                                            | Maximum capability-statement transcript length (§7.6); the transcript is signed through the fixed-size §7.2.1 envelope, so this bound is set by the carrier arithmetic and not by the signing interface                                                                                                                                                                                                                                                                                                                                                                                                             |
| Negotiation        | `E2EE_STATEMENT_WRAPPER_MAX_BYTES`         | 70                                                                                                                               | Maximum canonical-CBOR overhead the `[ bstr(transcript), bstr(signature) ]` statement wrapper adds to a transcript of at most `E2EE_CAPABILITY_TRANSCRIPT_MAX_BYTES` bytes (§7.6)                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Negotiation        | `E2EE_CAPABILITY_STATEMENT_MAX_BYTES`      | 5,190                                                                                                                            | Maximum capability-statement CBOR length before base64url encoding; derived by §3.2.1 S4                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Negotiation        | `E2EE_CAPABILITY_CARRIER_TAG`              | `"ryco.e2ee.capability.v1"`                                                                                                      | Reserved `_tag` value of the capability carrier (§5.3)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Negotiation        | `E2EE_CAPABILITY_CARRIER_FIXED_BYTES`      | 49                                                                                                                               | Length of the §5.3 carrier JSON with an empty `statement` member — the fixed wrapper the base64url statement text is placed into                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Negotiation        | `E2EE_CAPABILITY_CARRIER_MAX_BYTES`        | 6,969                                                                                                                            | Maximum carrier JSON length; derived by §3.2.1 S5                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Negotiation        | `E2EE_ADVERTISEMENT_MIN_CHUNK_BYTES`       | 8,192                                                                                                                            | Smallest Hub-asserted `maxDataChunkBytes` on which the advertisement is serviceable (§5.5); satisfies §3.2.1 S6                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Negotiation        | `E2EE_ACCOUNT_ID_MAX_BYTES`                | 256                                                                                                                              | Maximum UTF-8 byte length of an account identifier carried in any E2EE structure (§7, §8)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Negotiation        | `E2EE_NEGOTIATION_BUFFER_MAX_BYTES`        | `maxQueuedBytes − maxControlFrameBytes`                                                                                          | Total plaintext bytes an E2EE-capable client MAY hold in its `negotiating` send buffers, **summed across every channel on one relay connection**: the same aggregate send budget the relay send queue enforces, charged as though the buffered bytes had already been enqueued (§4.4). Derived from the Hub-asserted `ready` limits, so it is a per-connection value rather than a literal — and the accounting is per connection for the same reason, because that is the scope of the single send queue it mirrors (§4.4)                                                                                         |
| Timers             | `T_ADV`                                    | 1,500 ms                                                                                                                         | Client advertisement wait, measured from receipt of `channel.accept`. Its value is fixed by the §3.2.2 L1 keepalive budget together with `T_TRUST_COMMIT` and `T_HANDSHAKE`; it is not chosen independently                                                                                                                                                                                                                                                                                                                                                                                                         |
| Timers             | `T_TRUST_COMMIT`                           | 3,000 ms                                                                                                                         | Local pre-key deadline, armed after a usable authenticated statement cancels `T_ADV`, for the client to durably commit the statement's authenticated trust advance before emitting `E2EEClientHello`. Rejection or expiry is FATAL-PRE and never cancels the underlying operating-system write (§4.4 K1, §5.2)                                                                                                                                                                                                                                                                                                      |
| Timers             | `T_HANDSHAKE`                              | 3,000 ms                                                                                                                         | **Client** handshake deadline, from `E2EEClientHello` emit (§4.4 K15). Bounded by §3.2.2 L1                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Timers             | `T_HANDSHAKE_NODE`                         | 10,000 ms                                                                                                                        | **Node** handshake deadline, from advertisement emit, extending through the authenticated implicit client finish (§8.9). The `negotiating`-phase half is enforced only under effective `requireE2EE` (row N8); the implicit-finish half is enforced always (§8.9). Bounded below by §3.2.2 L2                                                                                                                                                                                                                                                                                                                       |
| Timers             | `T_KEEPALIVE_FLUSH_MARGIN`                 | 500 ms                                                                                                                           | Budget reserved inside `RPC_KEEPALIVE_INTERVAL` for the tail of a window in which an E2EE-capable client cannot write the keepalive `Ping`. It is spent two different ways and both are invariants over this one name: flushing the single stalled `Ping` and receiving its `Pong` after a negotiating window (§3.2.2 L1), and completing channel teardown after a close phase that swallowed one (§3.2.2 L5)                                                                                                                                                                                                       |
| Timers             | `T_CLOSE`                                  | 1,500 ms                                                                                                                         | Close-exchange deadline: maximum wait for the peer's next close-machine record after sending one's own, at every step of the close exchange, before the close is reported unclean (§10). Its value is fixed by the §3.2.2 L5 keepalive budget together with `T_CLOSE_LINGER_MAX`; it is not chosen independently. L5 charges it **twice**, because §10.2 admits two `T_CLOSE`-bounded waits on the simultaneous path and only one on either sequential path; it was reduced from a value equal to `RPC_KEEPALIVE_INTERVAL`, and again when L5 was re-derived over the two-wait worst case                           |
| Timers             | `T_CLOSE_LINGER_MAX`                       | 1,000 ms                                                                                                                         | Maximum last-record linger before the outer `channel.close` (§10.3). An implementation chooses any bound at most this; the constant exists so the close phase is bounded by named values and §3.2.2 L5 is evaluable from this table                                                                                                                                                                                                                                                                                                                                                                                 |
| Timers             | `E2EE_CAPABILITY_STATEMENT_VALIDITY`       | 600 s                                                                                                                            | Maximum capability-statement validity interval (`expiresAt − issuedAt`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Timers             | `E2EE_MAX_CLOCK_SKEW`                      | 300 s                                                                                                                            | Maximum verifier clock skew for statement and prekey validity checks                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Timers             | `E2EE_PREKEY_LIFETIME`                     | 30 days                                                                                                                          | Agreement-prekey certificate lifetime (§6)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Timers             | `E2EE_PREKEY_ROTATION_OVERLAP`             | 48 hours                                                                                                                         | Staged-rotation window during which outgoing and incoming prekeys both verify (§6)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Timers             | `E2EE_FALLBACK_OBSERVATION_WINDOW`         | 14 days                                                                                                                          | Fallback-observation window of representative use that MUST precede the `requireE2EE` default flip; the flip criterion assessed over it is a maintainer judgement, not a zero test (§12.3, §12.5)                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Rekey              | `E2EE_REKEY_MAX_RECORDS`                   | 65,536                                                                                                                           | Per-direction protected-record count threshold _N_ (§9)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Rekey              | `E2EE_REKEY_MAX_BYTES`                     | 268,435,456                                                                                                                      | Per-direction authenticated inner-plaintext byte threshold _B_ (§9)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Rekey              | `E2EE_EPOCH_MAX`                           | 2^32 − 1                                                                                                                         | Epoch exhaustion bound; reaching it terminates the channel before wrap (§9)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Rekey              | `E2EE_COUNTER_MAX`                         | 2^64 − 1                                                                                                                         | Counter exhaustion bound; reaching it terminates the channel before wrap (§9)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Rekey              | `E2EE_CLOSE_RECORDS_RESERVED`              | 2                                                                                                                                | Per-direction record capacity — under **both** §9.4 thresholds, not only the counter — that an endpoint MUST hold in reserve for the authenticated close; equals the maximum number of close-machine records one endpoint protects in one exchange (§9.6, §10.2). It is **not** the whole §9.6 post-application reserve, which is this plus `E2EE_ERROR_RECORDS_RESERVED`                                                                                                                                                                                                                                           |
| Rekey              | `E2EE_ERROR_RECORDS_RESERVED`              | 1                                                                                                                                | Per-direction record capacity an endpoint MUST hold in reserve, in addition to `E2EE_CLOSE_RECORDS_RESERVED` and under both §9.4 thresholds, for the single terminal `E2EEError` a FATAL-POST detected during or after the close machine requires (§9.6, §10.2, §11.3). One is the exact maximum: §11.3 makes an `E2EEError` terminal in both directions, so no exchange contains two                                                                                                                                                                                                                               |
| Keys               | `E2EE_AGREEMENT_PUBLIC_KEY_BYTES`          | 32                                                                                                                               | X25519 agreement public-key length (§6, §7)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Keys               | `E2EE_KEY_FINGERPRINT_BYTES`               | 32                                                                                                                               | Key-fingerprint digest length (SHA-256 output, §7)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Keys               | `E2EE_SECRET_BYTES`                        | 32                                                                                                                               | Length of every handshake-derived secret and per-epoch AEAD key (HKDF-Expand output length; equals the ChaCha20-Poly1305 key length) (§6, §8, §9)                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Keys               | `ED25519_PUBLIC_KEY_BYTES`                 | 32                                                                                                                               | Ed25519 public-key length; defined by the node identity primitives and restated for cross-checking (§7)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Keys               | `ED25519_SIGNATURE_BYTES`                  | 64                                                                                                                               | Ed25519 signature length; defined by the node identity primitives and restated for cross-checking (§7)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Keys               | `P256_PUBLIC_KEY_BYTES`                    | 65                                                                                                                               | P-256 public-key length: X9.63 uncompressed point `0x04 ‖ X ‖ Y` (§7)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Keys               | `P256_SIGNATURE_BYTES`                     | 64                                                                                                                               | P-256 ECDSA signature length: fixed-width raw `r ‖ s` (§7)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Signing            | `E2EE_SIGNING_INPUT_MAX_BYTES`             | 4,096                                                                                                                            | Hard input bound of the node identity signing interface: it rejects any input outside 1..this many bytes, so no signed structure of this protocol may exceed it (§7.2)                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Signing            | `E2EE_DIRECT_SIGNING_TRANSCRIPT_MAX_BYTES` | 1,024                                                                                                                            | Maximum length of an E2EE transcript that is signed directly, without the §7.2.1 envelope (§7.3, §7.4, §7.5)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Signing            | `E2EE_TRANSCRIPT_DIGEST_BYTES`             | 32                                                                                                                               | Transcript-digest length inside the §7.2.1 signing envelope (SHA-256 output)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Signing            | `E2EE_CAPABILITY_SIGNING_ENVELOPE_BYTES`   | 72                                                                                                                               | Exact encoded length of the §7.2.1 capability signing envelope, for every input                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Chains             | `E2EE_CONTINUITY_CHAIN_MAX_LENGTH`         | 8                                                                                                                                | Maximum identity-continuity certificate chain length (§13)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Client records     | `E2EE_PENDING_CLIENTS_MAX_GLOBAL`          | 64                                                                                                                               | Global cap on pending client-key records (§13)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Client records     | `E2EE_PENDING_CLIENTS_MAX_PER_ACCOUNT`     | 8                                                                                                                                | Pending client-key records per (Hub origin, account id) (§13)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Client records     | `E2EE_PENDING_CLIENT_RETENTION`            | 7 days                                                                                                                           | Pending client-key record retention (§13)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Client records     | `E2EE_APPROVED_CLIENTS_MAX`                | 256                                                                                                                              | Maximum approved client-key records (§13)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Client records     | `E2EE_REVOKED_CLIENTS_RETAINED_MAX`        | 1,024                                                                                                                            | Maximum retained revoked client-key records; only the oldest revoked records past this cap are evicted (§13)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Client records     | `E2EE_LAST_SEEN_WRITE_INTERVAL`            | 3,600 s                                                                                                                          | Last-seen writes per record are coalesced to at most one per interval (§13)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Client records     | `E2EE_CLIENT_DISPLAY_LABEL_MAX_CHARS`      | 100                                                                                                                              | Maximum owner-assigned display-label length in a client authorization record (§13)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Client records     | `E2EE_PAIRING_WINDOW`                      | 300 s                                                                                                                            | Maximum duration of an owner-opened pairing window on the node, during which the owner-bound pending-cap reservation rule of §13.6 applies (§13.6)                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Client records     | `E2EE_PAIRING_RESERVATION_LIFETIME`        | 3,600 s                                                                                                                          | Maximum age, measured from record creation, for which a pending record created under an owner-opened pairing window retains its reservation against a later pairing-window eviction (§13.6). Sized for the human comparison ceremony of §13.2 steps 4–5 with margin, and deliberately far below `E2EE_PENDING_CLIENT_RETENTION` so a reservation the owner never converts to `approved` stops occupying the reserved class within the hour rather than within the week (§3.2.2 L4). Its equality with `E2EE_LAST_SEEN_WRITE_INTERVAL` is coincidental: the two bound unrelated things and no invariant couples them |
| Client trust state | `E2EE_PIN_NODE_ID_HINTS_MAX`               | 8                                                                                                                                | Maximum Hub-minted node ids retained per client-side pin record as untrusted selection-resolution hints; oldest-first eviction (§13.1)                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Instrumentation    | `E2EE_FALLBACK_RING_SIZE`                  | 32                                                                                                                               | Bounded ring of most recent fallback occurrences retained by the node; occurrences evicted past it are counted by the per-class ring-overflow counter, which is what tells §12.3 the ring is an incomplete account of a window (§12.3, §12.5)                                                                                                                                                                                                                                                                                                                                                                       |
| Instrumentation    | `E2EE_FALLBACK_WRITE_INTERVAL`             | 3,600 s                                                                                                                          | Fallback-counter durable writes are coalesced to at most one per interval per class, after a leading-edge durable write (§12.5). Deliberately equal to `E2EE_LAST_SEEN_WRITE_INTERVAL`, which it mirrors                                                                                                                                                                                                                                                                                                                                                                                                            |
| Pre-auth bounds    | `E2EE_HANDSHAKE_RATE_BURST`                | 8                                                                                                                                | Token-bucket capacity of the node's per-Hub-origin handshake-attempt budget; satisfies §3.2.2 L3 (§15)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Pre-auth bounds    | `E2EE_HANDSHAKE_RATE_REFILL`               | 2 per second                                                                                                                     | Refill rate of that bucket, per Hub origin. Sized at or above the per-node ticket-issuance rate the Hub deployment authorizes, so a conforming node never refuses a handshake the Hub was entitled to authorize; a deployment MUST re-check this against its Hub's ticket rate limits (§15)                                                                                                                                                                                                                                                                                                                         |
| Display            | `E2EE_SAFETY_NUMBER_DIGITS`                | 60 decimal digits, rendered as 12 groups of 5, separated by single spaces                                                        | Native long-term safety-number output format; roughly 199 displayed bits against `E2EE_SAFETY_NUMBER_MIN_DISPLAYED_BITS`; the fixed length is the checksum (§13.4)                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Display            | `E2EE_SAFETY_NUMBER_MIN_DISPLAYED_BITS`    | 60                                                                                                                               | Required minimum anti-grinding entropy of the rendered native safety number. The adversary model is offline: the value is long-term and an attacker may grind key material against it without interacting (§13.4)                                                                                                                                                                                                                                                                                                                                                                                                   |
| Display            | `E2EE_WEB_SAS_CHARS`                       | 8 Crockford base32 characters, rendered 4-4, separated by a single hyphen                                                        | `WebSAS` output format; `E2EE_WEB_SAS_HKDF_BYTES` × 8 displayed bits against `E2EE_WEB_SAS_MIN_DISPLAYED_BITS` (§13.5)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Display            | `E2EE_WEB_SAS_MIN_DISPLAYED_BITS`          | 30                                                                                                                               | Required minimum displayed entropy of the rendered `WebSAS`. Unlike `E2EE_SAFETY_NUMBER_MIN_DISPLAYED_BITS` this floor is **not** an offline work factor: §13.5 derives it from the grinding window an interposer actually has — `T_HANDSHAKE`, at one handshake attempt per channel (§8.1) — and that derivation, not this number, is the justification (§13.5, §17.5)                                                                                                                                                                                                                                             |
| Display            | `E2EE_SAFETY_NUMBER_GROUP_BYTES`           | 5                                                                                                                                | HKDF output bytes consumed per displayed safety-number group (§13)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Display            | `E2EE_SAFETY_NUMBER_GROUP_MODULUS`         | 100,000                                                                                                                          | Modulus reducing each safety-number group to its five-digit decimal form (§13)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Display            | `E2EE_SAFETY_NUMBER_HKDF_BYTES`            | 60                                                                                                                               | Total safety-number HKDF-Expand output length (§13)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Display            | `E2EE_WEB_SAS_HKDF_BYTES`                  | 5                                                                                                                                | `WebSAS` HKDF-Expand output length — exactly the displayed bits (§13)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Display            | `E2EE_CROCKFORD_ALPHABET`                  | `0123456789ABCDEFGHJKMNPQRSTVWXYZ`                                                                                               | Crockford base32 alphabet used by `WebSAS` rendering (§13)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Encoding           | `E2EE_CBOR_CODEC`                          | `cborg@6.1.2`                                                                                                                    | Pinned canonical-CBOR codec and version (§3.6)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Dependencies       | `E2EE_NOBLE_CURVES_AUDIT_BASELINE`         | `@noble/curves@2.2.0`                                                                                                            | Maintainer security-audit baseline for the X25519/Ed25519/P-256 dependency (all files, April 2026; §14)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Dependencies       | `E2EE_NOBLE_CIPHERS_AUDIT_BASELINE`        | `@noble/ciphers@2.2.0`                                                                                                           | Maintainer security-audit baseline for the ChaCha20-Poly1305 dependency (all files, April 2026; §14)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Dependencies       | `E2EE_NOBLE_HASHES_AUDIT_BASELINE`         | `@noble/hashes@2.2.0`                                                                                                            | Maintainer security-audit baseline for the SHA-256/HMAC/HKDF dependency (all files, April 2026; §14)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Handshake          | `NOISE_SPEC_REVISION`                      | 34                                                                                                                               | Noise Protocol Framework specification revision the suite registry is defined against                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Relay chunking     | `RELAY_CHUNK_CAPABILITY_PRELUDE`           | `0x20 0x09 0x0D 0x0A 0x20 0x09 0x0D 0x0A`                                                                                        | JSON-whitespace prelude advertising chunk support on unchunked payloads                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Relay chunking     | `RELAY_CHUNK_CAPABILITY_PRELUDE_BYTES`     | 8                                                                                                                                | Length of `RELAY_CHUNK_CAPABILITY_PRELUDE`, named so the §3.2.1 carrier invariants are expressible over constant names alone                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Relay chunking     | `RELAY_CHUNK_MAGIC`                        | `0x00`                                                                                                                           | First byte of every chunk payload                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Relay chunking     | `RELAY_CHUNK_HEADER_BYTES`                 | 8                                                                                                                                | Chunk header: magic (1), version (1) = `0x01`, flags (1), reserved (1) = `0x00`, totalBytes (4, `uint32be`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Relay chunking     | `RELAY_MAX_RPC_MESSAGE_BYTES`              | 4,194,304                                                                                                                        | Hard ceiling on a reassembled message                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Relay chunking     | `RELAY_MAX_DATA_CHUNK_BYTES`               | 262,144                                                                                                                          | Maximum Hub-asserted data-chunk size                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Relay chunking     | `RELAY_MIN_DATA_CHUNK_BYTES`               | 1,024                                                                                                                            | Minimum Hub-asserted data-chunk size the relay protocol admits; strictly below `E2EE_ADVERTISEMENT_MIN_CHUNK_BYTES` (§3.2.1 S7, §5.5, §17.13)                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Relay connection   | `RELAY_CAPABILITY_LITERALS`                | `{ "ryco.rpc" }`                                                                                                                 | The relay contract's closed set of channel capability literals ([relay-protocol.md](./relay-protocol.md), Frame classes). This protocol **adds none** (§1.1) and validates against the relay contract's current set; it is named here only so §8.3 element 11 and the §13.6 `capabilitySet` vocabulary reference one name instead of restating the literal                                                                                                                                                                                                                                                          |
| Relay connection   | `RELAY_CLOSE_REASONS`                      | The relay contract's closed close-reason set ([relay-protocol.md](./relay-protocol.md)); named, deliberately not enumerated here | The vocabulary every close on a relay channel draws from. This protocol uses exactly one member, `channel_rejected`, and **adds none** (§1.1, §11.1); the relay contract's defining module remains authoritative for the members, and this row exists only so §11.1 states membership over one name rather than asserting the set's contents                                                                                                                                                                                                                                                                        |
| Relay connection   | `RELAY_MAX_CHANNELS`                       | 8                                                                                                                                | Maximum simultaneous channels on one relay connection. The Hub asserts `maxChannels` in the `ready` frame, but the frame schema rejects any value above this bound, so the untrusted Hub can lower it and cannot raise it. Combined with §4.4's one-handshake-per-channel rule this is the **structural** bound on a node's concurrent handshakes (§15)                                                                                                                                                                                                                                                             |
| RPC keepalive      | `RPC_KEEPALIVE_INTERVAL`                   | 8,000 ms                                                                                                                         | Period of the pinned RPC client's keepalive fiber (§3.2.2 L1), including the client-local authenticated trust-commit window                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

_Note (non-normative)_: the relay-chunking rows were cross-checked against
`packages/shared/src/relayMessageChunks.ts:28-30` (prelude bytes) and
`packages/contracts/src/relay.ts:36-49` (chunk header constants, message ceiling, chunk bounds);
`RELAY_MAX_CHANNELS` against `packages/contracts/src/relay.ts:14` and the `ready`-limits schema
check at `:191-194` (verified 2026-07-30).

_Note (non-normative) — what the pinned keepalive actually does._ The pinned RPC client forks a
keepalive fiber at **RPC-protocol-socket construction**, not at `channel.accept`, and the fiber
loops on a fixed `RPC_KEEPALIVE_INTERVAL` delay. On each tick it opens a timeout latch if the
previous `Pong` never arrived, and otherwise clears the flag and writes a `Ping`. The latch is
raced against the whole protocol socket and, when it opens, fails the socket with a transport
timeout that tears down the connection and every channel on it. `reset()` sets the
prior-`Pong`-received flag and closes the latch but does **not** interrupt or re-phase the delay
fiber, including across reconnects. Two consequences follow and both are load-bearing for
§3.2.2 L1: the interval is **free-running**, so no phase relationship to `channel.accept` or to
any negotiation event may be assumed, and the dead-peer verdict lands somewhere in
`[RPC_KEEPALIVE_INTERVAL, 2 · RPC_KEEPALIVE_INTERVAL)` after the last `Pong`. An earlier revision
of this document justified `T_ADV` as "chosen below the keepalive interval so a buffering client
never stalls the keepalive"; that justification was wrong twice over — a tick inside the
buffering window _is_ stalled, and the quantity that must fit the interval is the whole
negotiating window, not `T_ADV` alone. The node runs no keepalive fiber, so this constraint is
client-side only (verified against `patches/effect@4.0.0-beta.106.patch`, `makePinger` /
`makeProtocolSocket`, and the single `makePinger` call site therein, 2026-07-30).

#### 3.2.1 Size-relationship invariants (normative)

The size constants above are **not** independent, and an earlier revision of this document
carried a set of them that could not all hold at once: a statement bound four times larger than
what the node's signing interface accepts, and a carrier that could not fit the smallest
data-chunk limit the relay protocol permits once the continuity chain held a single entry. A
node could satisfy each constant individually and still be unable to advertise. Every size
relationship this protocol depends on is therefore written below as
an inequality over constant **names**, so that a conformance test can evaluate it directly from
the table. The two display-entropy floors of §13 are stated in the same form for the same
reason. A release in which any of S1–S11 is false is a specification defect, not an
implementation choice.

```text
S1  E2EE_CAPABILITY_SIGNING_ENVELOPE_BYTES    ≤ E2EE_SIGNING_INPUT_MAX_BYTES
S2  E2EE_DIRECT_SIGNING_TRANSCRIPT_MAX_BYTES  ≤ E2EE_SIGNING_INPUT_MAX_BYTES
S3  E2EE_CAPABILITY_SIGNING_ENVELOPE_BYTES
      = cborArrayHeader(2)
      + cborText("ryco.node-e2ee-capability-digest.v1")
      + cborBytes(E2EE_TRANSCRIPT_DIGEST_BYTES)
S4  E2EE_CAPABILITY_STATEMENT_MAX_BYTES
      = E2EE_CAPABILITY_TRANSCRIPT_MAX_BYTES + E2EE_STATEMENT_WRAPPER_MAX_BYTES
S5  E2EE_CAPABILITY_CARRIER_MAX_BYTES
      = E2EE_CAPABILITY_CARRIER_FIXED_BYTES
      + ⌈4 · E2EE_CAPABILITY_STATEMENT_MAX_BYTES / 3⌉
S6  E2EE_CAPABILITY_CARRIER_MAX_BYTES + RELAY_CHUNK_CAPABILITY_PRELUDE_BYTES
      ≤ E2EE_ADVERTISEMENT_MIN_CHUNK_BYTES
S7  E2EE_ADVERTISEMENT_MIN_CHUNK_BYTES        ≤ RELAY_MAX_DATA_CHUNK_BYTES
S8  worstCaseCapabilityTranscript(E2EE_HUB_ORIGIN_MAX_BYTES,
                                  E2EE_CONTINUITY_CHAIN_MAX_LENGTH,
                                  E2EE_SUITE_REGISTRY_MAX_ENTRIES)
      ≤ E2EE_CAPABILITY_TRANSCRIPT_MAX_BYTES
S9  worstCaseDirectTranscript(E2EE_HUB_ORIGIN_MAX_BYTES,
                              E2EE_ACCOUNT_ID_MAX_BYTES)
      ≤ E2EE_DIRECT_SIGNING_TRANSCRIPT_MAX_BYTES
S10 (E2EE_SAFETY_NUMBER_HKDF_BYTES / E2EE_SAFETY_NUMBER_GROUP_BYTES)
      · log2(E2EE_SAFETY_NUMBER_GROUP_MODULUS)
      ≥ E2EE_SAFETY_NUMBER_MIN_DISPLAYED_BITS
S11 E2EE_WEB_SAS_HKDF_BYTES · 8                ≥ E2EE_WEB_SAS_MIN_DISPLAYED_BITS
```

`cborArrayHeader`, `cborText`, and `cborBytes` are the canonical-CBOR encoded lengths of §3.6.
`worstCaseCapabilityTranscript` is the §7.6 transcript encoded at every bound simultaneously —
maximum Hub origin, maximum continuity chain, maximum suite registry, and the widest canonical
integer encoding each unsigned field admits — and `worstCaseDirectTranscript` is the largest of
the §7.3, §7.4, and §7.5 transcripts under the same rule. S8 and S9 are **not** asserted by
inspection: they are discharged by the generated fixtures of §16.3 F3 and F5, which build the
worst case and assert its exact byte length, so a future element added to any transcript breaks
a test rather than a deployment.

S10 and S11 are the display-entropy floors of §13.4 and §13.5, stated here so that both are
evaluable from §3.2 instead of asserted in prose. Note that they are floors of **different
kinds**, and the justification for each lives at its definition site: the safety-number floor is
sized against an offline adversary because the value is long-term (§13.4), while the `WebSAS`
floor is bounded by the online window an interposer actually has — `T_HANDSHAKE` at one handshake
attempt per channel — and buys no offline work factor at all (§13.5, §17.5). Like S8 and S9 they
are discharged by fixture rather than by inspection, in §16.3 F14.

S6 is what makes the §5.5 carrier rule satisfiable; S1 and S2 are what make every signature in
§7 producible. S7 states that the required floor is _reachable_ on this relay protocol, and
deliberately does **not** claim it is guaranteed: `RELAY_MIN_DATA_CHUNK_BYTES` is strictly below
`E2EE_ADVERTISEMENT_MIN_CHUNK_BYTES`, so the relay protocol still admits connections on which
no conforming advertisement can be carried. §5.5 defines the behavior in that case and §17.13
records the residual gap.

#### 3.2.2 Liveness and concurrency invariants (normative)

The timer and pre-authentication constants are likewise not independent. Like S1–S11 these are
written as inequalities over constant **names** so a conformance test can evaluate them directly
from §3.2. A release in which any of L1–L5 is false is a specification defect.

```text
L1  T_ADV + T_TRUST_COMMIT + T_HANDSHAKE
     + T_KEEPALIVE_FLUSH_MARGIN                     ≤ RPC_KEEPALIVE_INTERVAL
L2  T_ADV + T_TRUST_COMMIT + T_HANDSHAKE            ≤ T_HANDSHAKE_NODE
L3  E2EE_HANDSHAKE_RATE_BURST                       ≥ RELAY_MAX_CHANNELS
L4  E2EE_PAIRING_WINDOW ≤ E2EE_PAIRING_RESERVATION_LIFETIME
                        < E2EE_PENDING_CLIENT_RETENTION
L5  2 · T_CLOSE + T_CLOSE_LINGER_MAX + T_KEEPALIVE_FLUSH_MARGIN
                                                    ≤ RPC_KEEPALIVE_INTERVAL
```

**L1 — the negotiating window fits inside one keepalive period.** While a channel is
`negotiating`, an E2EE-capable client emits no plaintext at all, including the RPC keepalive
`Ping` (§4.4). The longest contiguous such window is `T_ADV`, followed by `T_TRUST_COMMIT` for a
usable authenticated statement, followed by `T_HANDSHAKE`. Because
the pinned keepalive is free-running with unknown phase, a window shorter than
`RPC_KEEPALIVE_INTERVAL` can contain **at most one** tick; L1 additionally reserves
`T_KEEPALIVE_FLUSH_MARGIN` so the `Ping` that tick wrote is flushed — as an envelope on entering
`e2ee`, as plaintext on entering `legacy` — and its `Pong` returns before the following tick
would declare the peer dead. L1 is what makes row K15 reachable at all: under the previous
values the combined window spanned two ticks unconditionally, so the transport died
mid-handshake and the specified FATAL-PRE, with the uniform observable of §11.5, could never
execute. The property L1 buys holds while the actual `Ping` round trip is strictly less than
`T_KEEPALIVE_FLUSH_MARGIN`; when it is not, the transport-level dead-peer verdict may still
pre-empt K15. That outcome is fail-closed — a transport error and a backed-off reconnect, never
a legacy lock and never a flushed plaintext byte — and it is recorded as §17.14.

An implementation whose transport exposes a keepalive suspend/resume facility, or that can
inject a locally synthesized `Pong` into its own inbound decoded response stream, MAY use it to
hold off the dead-peer verdict while `negotiating` instead of relying on the L1 margin alone. If
it does: the synthesized `Pong` MUST NOT reach the wire; injection MUST stop the instant the
mode locks, so that liveness is policed by the real peer from that point on and a genuine
plaintext `Pong` arriving in `e2ee` is still the K18 fatal it is; and L1 MUST still hold,
because the facility is an optimization and not a substitute for a satisfiable timer budget.

**L2 — the node never times out a handshake the client still considers live.** The node's
deadline starts at advertisement emit, which §5.4 places immediately after `channel.accept`; the
client's worst case measured from that same instant is `T_ADV` (a delayed carrier), followed by
`T_TRUST_COMMIT` and `T_HANDSHAKE`. L2 keeps `T_HANDSHAKE_NODE` above that sum so the two
endpoints cannot both be conforming and disagree about which one failed. It also leaves the node
the slack the client cannot afford: only the client is bound by L1.

**L3 — the pre-authentication rate limit cannot bite before the structural bound does.** A node
can hold at most the connection's asserted `maxChannels` simultaneous channels, at most
`RELAY_MAX_CHANNELS`, and §4.4 permits exactly one handshake per channel. A burst capacity below
that would let the node refuse handshakes on channels the relay itself admitted. §15 states the
consequences.

**L4 — a pairing reservation outlives the window that granted it and expires before the record
does.** The left inequality keeps the mechanism coherent: a reservation shorter than the window
that granted it could lapse while that same window was still open. The right inequality is the
load-bearing half and it is not cosmetic. A pending record's reservation makes it ineligible for
pairing-window eviction (§13.6); if the reservation could outlast the record's own retention, the
reservation would never be spent while the record existed, and the reserved class could only
grow — which is precisely the failure an earlier revision shipped, where the reservation was a
plain boolean with the record's full `E2EE_PENDING_CLIENT_RETENTION` lifetime and a saturated
reserved class disabled every future window for a week (§17.16). Making the reservation strictly
shorter than the retention guarantees the reserved class drains on its own.

**L5 — the close phase fits inside one keepalive period.** §10.2 forbids an endpoint from
protecting any record after its first close-machine record other than the close-machine records
its role requires and the single terminal `E2EEError` of §11.3, and §10 makes the keepalive
`Ping` an application RPC record for that purpose. The close phase is therefore a second window
in which an E2EE-capable client writes no `Ping` — and unlike the `negotiating` window of L1 it
has **no flush**: the channel ends when the phase ends, so a `Ping` the phase stalls can never be
written on that channel and is discarded rather than buffered (§10.2). The terminal `E2EEError`
does not lengthen the window: it is protected at the instant the fatal condition is detected and
is immediately followed by the `channel.close` of §11.1, which ends the phase early rather than
extending it.

The longest such window, measured from an endpoint's own first close-machine record to the outer
`channel.close`, is **two** `T_CLOSE`-bounded waits followed by `T_CLOSE_LINGER_MAX` (the §10.3
linger). Two, not one, and this is the correction of a model an earlier revision of L5 stated:
§10.2 bounds _each_ wait step by `T_CLOSE` and places no limit on how late the peer's own
`E2EEClose` may arrive. An endpoint sends `E2EEClose` at `t = 0`; the peer's `E2EEClose` arrives
at just under `T_CLOSE`, which is inside the first deadline and puts the endpoint in the
simultaneous branch; the endpoint sends its `E2EECloseAck` and waits a **second** `T_CLOSE` for
the peer's ack, which arrives at just under `2 · T_CLOSE`. The endpoint is a last-record sender in
that branch (§10.3), so the linger follows. §10.2 caps the count at two:
an endpoint's close phase contains exactly one wait on either sequential path and exactly two on
the simultaneous path, and no path admits a third. Because the pinned keepalive is free-running
with unknown phase, a window shorter than `RPC_KEEPALIVE_INTERVAL` can contain **at most one**
tick; L5 additionally reserves `T_KEEPALIVE_FLUSH_MARGIN` so the channel is torn down before the
_following_ tick — the one that would read the stalled `Ping`'s missing `Pong` and open the
dead-peer latch — can fire. Without L5 the pair `T_CLOSE = T_CLOSE_LINGER_MAX =
RPC_KEEPALIVE_INTERVAL` an earlier revision carried let a clean, fully authenticated close span
two ticks unconditionally, so a Hub that returned the peer's acknowledgement just under `T_CLOSE`
and withheld the peer's `channel.close` turned every successful close into a transport timeout
that tore down the connection and every channel on it. Charging `T_CLOSE` once rather than twice
left the same case reachable on the simultaneous path at one extra `T_CLOSE`, which is why the
inequality above charges it twice and the two constants were re-chosen against it.

L5 removes that deterministic case; it does **not** make the close phase keepalive-proof, and
§10.3 and §17.14 say so rather than implying otherwise. A `Ping` written _before_ the close phase
whose `Pong` the peer can no longer send — because the peer has itself entered a close phase and
is equally forbidden to protect it — expires on the pinger's own schedule, which no timer in this
document bounds. That is why §10.4 requires the verdict to be determined and recorded when the
exchange completes or `T_CLOSE` expires, never when the outer `channel.close` is delivered. Like
L1, L5 binds the client only: the node runs no keepalive fiber. The suspend/resume and
synthesized-`Pong` facility permitted for `negotiating` above MAY equally be used across a close
phase, under the identical conditions — nothing synthesized reaches the wire, the facility stops
when the channel ends, and L5 MUST still hold.

### 3.3 Wire layouts

E2EE envelope — every post-strip payload whose first byte is `E2EE_ENVELOPE_DISCRIMINATOR`:

```text
offset 0   discriminator  1 byte                      E2EE_ENVELOPE_DISCRIMINATOR
offset 1   version        1 byte                      MUST equal E2EE_PROTOCOL_VERSION
offset 2   suite          1 byte                      suite registry identifier (§3.4)
offset 3   epoch          E2EE_EPOCH_FIELD_BYTES      uint32be
offset 7   counter        E2EE_COUNTER_FIELD_BYTES    uint64be
offset 15  ciphertext     variable                    AEAD output over the record plaintext,
                                                      ending in the E2EE_AEAD_TAG_BYTES tag
```

The first `E2EE_ENVELOPE_HEADER_BYTES` bytes are the envelope header. The record plaintext is:

```text
record plaintext = innerType (E2EE_INNER_TYPE_BYTES) ‖ body
```

AEAD parameters for every envelope:

```text
nonce = epoch ‖ counter                                   (E2EE_AEAD_NONCE_BYTES)
AAD   = envelope header ‖ sessionBindingHash ‖ direction  (E2EE_AAD_BYTES)
```

where `sessionBindingHash` is defined in §8 and `direction` is the direction label (§3.4) of the
direction the record travels. An envelope shorter than `E2EE_ENVELOPE_OVERHEAD_BYTES` is
malformed and MUST be rejected before any cryptographic processing.

Negotiation record — every post-strip payload whose first byte is
`E2EE_NEGOTIATION_DISCRIMINATOR` (pre-key only; §4.4 forbids it in every other state):

```text
offset 0  discriminator  1 byte   E2EE_NEGOTIATION_DISCRIMINATOR
offset 1  recordType     1 byte   negotiation type registry (§3.4)
offset 2  body           canonical CBOR (§3.6)
```

`E2EEClientHello`, `E2EEServerAccept`, and `E2EEHandshakeReject` records are bounded by
`E2EE_CLIENT_HELLO_MAX_BYTES`, `E2EE_SERVER_ACCEPT_MAX_BYTES`, and (exactly)
`E2EE_HANDSHAKE_REJECT_BYTES` total record bytes respectively. A negotiation record exceeding its
bound MUST be rejected without parsing its body. Body contents are defined in §8 and §11.

### 3.4 Registries

Post-strip payload discriminators (the first byte of a reassembled, prelude-stripped payload):

| First byte                                  | Class              | Accepted per §4.4                               |
| ------------------------------------------- | ------------------ | ----------------------------------------------- |
| `E2EE_ENVELOPE_DISCRIMINATOR`               | E2EE envelope      | `e2ee` state; also completes the handshake (§8) |
| `E2EE_NEGOTIATION_DISCRIMINATOR`            | Negotiation record | `negotiating` state only                        |
| `0x7B` (`{`) or `0x5B` (`[`)                | Legacy JSON        | Where the mode machine admits legacy input      |
| (no bytes — zero-length post-strip payload) | Malformed          | Fatal in every state                            |
| any other value                             | Malformed          | Fatal in every state                            |

Legacy JSON payloads always begin `{` or `[`; the pinned RPC serialization emits a single JSON
object or a JSON array of messages. The capability carrier (§5.3) is the single legacy-JSON
payload this protocol itself defines.

The zero-length row exists because a payload with no first byte would otherwise match no class:
the relay frame schema admits a `data.payload` of length zero, and a payload consisting of
exactly `RELAY_CHUNK_CAPABILITY_PRELUDE` also post-strips to nothing. Both are enumerated here
rather than left to the catch-all, so that every conforming implementation reaches the same
outcome on them (§4.3, §4.4, §11.2 P6, §11.3 Q6).

_Note (non-normative)_: the zero-length reachability was cross-checked against the relay payload
schema (`packages/contracts/src/relay.ts`, `data.payload` lower bound of zero) and the assembler,
which surfaces a zero-length payload as a completed message
(`packages/shared/src/relayMessageChunks.ts`); the chunked path cannot produce it, because a
zero-length chunk body and a zero total length are both chunk-layer failures (verified
2026-07-30).

Encrypted inner-record types (the authenticated `innerType` byte inside an envelope):

| Value      | Name           | Body                                                          |
| ---------- | -------------- | ------------------------------------------------------------- |
| `0x01`     | RPC            | Opaque application RPC message bytes, handed to the RPC layer |
| `0x02`     | `E2EEClose`    | Canonical-CBOR close control (§10)                            |
| `0x03`     | `E2EEError`    | Canonical-CBOR bounded encrypted error (§11)                  |
| `0x04`     | `E2EECloseAck` | Canonical-CBOR close acknowledgement (§10)                    |
| all others | reserved       | Fatal (§4.4)                                                  |

Negotiation record types:

| Value      | Name                  | Direction     | Bound                                 |
| ---------- | --------------------- | ------------- | ------------------------------------- |
| `0x01`     | `E2EEClientHello`     | client → node | `E2EE_CLIENT_HELLO_MAX_BYTES`         |
| `0x02`     | `E2EEServerAccept`    | node → client | `E2EE_SERVER_ACCEPT_MAX_BYTES`        |
| `0x03`     | `E2EEHandshakeReject` | node → client | exactly `E2EE_HANDSHAKE_REJECT_BYTES` |
| all others | reserved              | —             | Fatal (§4.4)                          |

Suite registry (protocol version 1). The tier selects the pattern; the client selects the suite;
the server may only accept or reject the client's selection (§8):

| Suite id   | Locally verified native tier (IK)  | Account-enrolled native tier (IK)  | Unsigned web tier (NX)             | Definition                                                                                                        |
| ---------- | ---------------------------------- | ---------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `0x01`     | `Noise_IK_25519_ChaChaPoly_SHA256` | forbidden                          | `Noise_NX_25519_ChaChaPoly_SHA256` | Noise Protocol Framework revision `NOISE_SPEC_REVISION`; X25519 (RFC 7748), ChaCha20-Poly1305 (RFC 8439), SHA-256 |
| `0x02`     | forbidden                          | `Noise_IK_25519_ChaChaPoly_SHA256` | forbidden                          | Same primitives; distinct grant payload and authorization context (§18)                                           |
| all others | reserved                           | reserved                           | reserved                           | Ignore while intersecting an advertisement; reject if selected                                                    |

Direction labels (ASCII, `E2EE_DIRECTION_LABEL_BYTES` bytes):

| Label   | Bytes            | Direction     |
| ------- | ---------------- | ------------- |
| `"c2n"` | `0x63 0x32 0x6E` | client → node |
| `"n2c"` | `0x6E 0x32 0x63` | node → client |

Two further vocabularies are normative but are **delegated**, not restated here, so that each has
exactly one definition site: the encrypted `E2EEError` code registry is defined once in §11.3,
where `E2EEError` itself is defined and where the length-uniformity requirement that registry
carries belongs; and the channel capability vocabulary is owned by the relay contract and named
in §3.2 as `RELAY_CAPABILITY_LITERALS` (§1.1 — this protocol defines no capability literal).

### 3.5 HKDF labels and transcript domains

HKDF labels (all HKDF-Expand invocations use HMAC-SHA-256; where a label is marked _directional_
the `info` input is the label bytes followed by the direction label of the derived direction):

| Label                                 | Directional | Derives                                                 |
| ------------------------------------- | ----------- | ------------------------------------------------------- |
| `ryco.relay-e2ee.exporter.v1`         | no          | `exporterSecret` from the final Noise chaining key (§6) |
| `ryco.relay-e2ee.confirmation-key.v1` | no          | `serverConfirmationKey` from `exporterSecret` (§8)      |
| `ryco.relay-e2ee.aead-key.v1`         | yes         | Per-epoch directional AEAD key (§9)                     |
| `ryco.relay-e2ee.ratchet.v1`          | yes         | Next directional epoch secret (§9)                      |
| `ryco.relay-e2ee.safety-number.v1`    | no          | Native long-term safety number (§13)                    |
| `ryco.relay-e2ee.web-sas.v1`          | no          | Per-session `WebSAS` (§13)                              |

Transcript and derivation domains (each appears exactly once, as the first element of its
canonical-CBOR structure):

| Domain                                | Structure                                                                                                                                                                            | Defined in |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- |
| `ryco.node-e2ee-prekey.v1`            | Node agreement-prekey certificate transcript                                                                                                                                         | §7         |
| `ryco.client-e2ee-prekey.v1`          | Client agreement-prekey certificate transcript                                                                                                                                       | §7         |
| `ryco.node-e2ee-capability.v1`        | Capability statement transcript (`encodeNodeE2eeCapabilityTranscript`)                                                                                                               | §5, §7     |
| `ryco.node-e2ee-capability-digest.v1` | Capability signing envelope (`encodeNodeE2eeCapabilitySigningEnvelope`) — the fixed-size structure actually handed to the node identity signing interface for a capability statement | §7.2.1     |
| `ryco.node-identity-continuity.v1`    | Identity-continuity certificate transcript                                                                                                                                           | §7, §13    |
| `ryco.relay-e2ee.prologue.v1`         | Noise prologue array                                                                                                                                                                 | §8         |
| `ryco.relay-e2ee.confirmation.v1`     | Confirmation transcript array                                                                                                                                                        | §8         |
| `ryco.relay-e2ee.session.v1`          | Session-binding transcript array                                                                                                                                                     | §8         |
| `ryco.relay-e2ee.safety-number.v1`    | Safety-number input array                                                                                                                                                            | §13        |
| `ryco.relay-e2ee.web-sas.v1`          | `WebSAS` input array                                                                                                                                                                 | §13        |
| `ryco.relay-e2ee.context.v1`          | Authorization context block                                                                                                                                                          | §8         |
| `ryco.relay-e2ee.close.v1`            | Close-commitment input array                                                                                                                                                         | §10        |
| `ryco.relay-e2ee.fallback-origin.v1`  | Fallback-occurrence origin-hash input array                                                                                                                                          | §12        |
| `ryco.node-key.v1`                    | Node identity-key fingerprint input (existing; defined by the node identity primitives)                                                                                              | §7         |
| `ryco.client-key.v1`                  | Client identity-key fingerprint input                                                                                                                                                | §7         |
| `ryco.e2ee-agreement-key.v1`          | Agreement-key fingerprint input                                                                                                                                                      | §7         |

No consumer of a signing key may construct transcript bytes ad hoc: every signature in this
protocol covers bytes produced by the named encoder for one of the domains above, and every
domain string is distinct across the node-identity and E2EE transcript families.

### 3.6 Canonical CBOR profile

Canonical CBOR in this document means bytes produced and consumed under the following pinned
profile:

- **Codec pin**: `E2EE_CBOR_CODEC`. Both repositories already pin this exact version; changing
  it is a protocol-relevant change because canonical bytes participate in signatures and hashes.
- **Encoding**: the codec's `rfc8949EncodeOptions` — the RFC 8949 §4.2 core deterministic
  profile with bytewise map-key ordering, definite lengths only, and shortest-form integers.
- **Decoding**: `strict: true`, `useMaps: true`, `rejectDuplicateMapKeys: true`,
  `allowIndefinite: false`, `allowUndefined: false`, `allowNaN: false`, `allowInfinity: false`.
  `allowBigInt` MAY be enabled only where a structure field requires the full `uint64` range; no
  E2EE structure requires it, because counters and epochs travel as fixed-width byte fields
  (§3.3) or CBOR byte strings, never as CBOR integers.
- **Floats are forbidden** in every E2EE structure; a decoder MUST reject any floating-point
  value.
- **Re-encode equality**: wherever this protocol signs or hashes CBOR bytes, a verifier MUST
  decode strictly, re-encode with the same profile, and require byte equality with the received
  bytes before using the value.

_Note (non-normative)_: this matches the relay codec's existing practice of strict decode plus
canonical re-encode byte-equality (verified against `packages/shared/src/relayCodec.ts:23-33` and
`:111-137`, 2026-07-30).

## 4. Layering, payload discrimination, and the mode machine

### 4.1 Layering

The E2EE layer lives entirely inside `data.payload`, beneath the relay frame schema and above the
application RPC JSON:

```text
relay frame (canonical CBOR map — relay-protocol.md)
 └─ data.payload (opaque byte string)
     └─ relay message chunking: RELAY_CHUNK_CAPABILITY_PRELUDE on fitting messages,
        RELAY_CHUNK_MAGIC chunk framing on oversized messages
         └─ post-strip payload: E2EE envelope | negotiation record | legacy JSON (§3.4)
             └─ inside an envelope: authenticated inner record — RPC bytes or E2EE control
```

Relay contracts, frames, limits, tickets, close reasons, and the relay fixture corpus are
untouched. Negotiation is in-band (§5); errors map onto existing close reasons (§11). Handshake
and pre-key negotiation and error records use the `E2EE_NEGOTIATION_DISCRIMINATOR` framing and
are **negotiation-only**: once keys are established, close and error controls travel as encrypted
inner records inside normal envelopes and consume the same directional epoch/counter sequence as
RPC records — there is no second post-handshake nonce space.

### 4.2 Send pipeline

On an E2EE channel, a sender MUST process every outbound application message in exactly this
order:

1. Take the RPC message bytes as the record body.
2. Enforce the plaintext ceiling (§4.5). A body larger than `plaintextCeiling` fails with the
   sender-local error `e2ee_message_too_large` and MUST NOT be encrypted or transmitted.
3. Prepend the inner-record type for RPC (§3.4), forming the record plaintext.
4. Encrypt under the sender's current directional epoch and counter (§9), producing the
   ciphertext.
5. Build the envelope per §3.3.
6. Hand the envelope to the relay message-chunking layer **unchanged**: the envelope, like any
   message, receives the `RELAY_CHUNK_CAPABILITY_PRELUDE` when it fits with headroom, or is
   split into `RELAY_CHUNK_MAGIC` chunks when oversized. E2EE senders MUST keep emitting the
   prelude so the peer's chunk-support latch behaves exactly as today.

Encrypted control records (§10, §11) follow the same pipeline from step 2 with their control
inner type and canonical-CBOR body.

_Note (non-normative)_: without the prelude, oversized sends fail `peer_unsupported`, because the
chunk-support latch is fed only by inbound evidence (verified against
`packages/shared/src/relayMessageChunks.ts:135-174` and
`packages/client-runtime/src/relay/relayEngine.ts:198-206`, 2026-07-30).

### 4.3 Receive pipeline and post-strip discrimination

A receiver MUST process every inbound `data.payload` in exactly this order:

1. Apply the relay chunk check — the payload is chunked exactly when it is at least
   `RELAY_CHUNK_HEADER_BYTES` long **and** its first byte is `RELAY_CHUNK_MAGIC`, which is the
   chunk layer's own test and the reason both are named constants of §3.2 — and feed the payload
   to the relay message assembler, which reassembles chunked messages and
   strips the `RELAY_CHUNK_CAPABILITY_PRELUDE` from unchunked ones. Chunk-layer failures keep
   their existing semantics and are not redefined by this protocol. No structure this protocol
   emits can be taken for a chunk by that test: every E2EE envelope and negotiation record begins
   with a discriminator that is not `RELAY_CHUNK_MAGIC` (§3.4), and legacy JSON begins `{` or `[`.
2. Discriminate the reassembled, prelude-stripped payload by its first byte per §3.4, subject to
   the mode machine (§4.4). A **zero-length** post-strip payload has no first byte, matches no
   class, and is fatal in every state (FATAL-PRE before keys, FATAL-POST after) — it is never a
   benign no-op and never silently dropped. Discrimination happens **only after** the assembler,
   never on raw wire bytes: chunk payloads legitimately begin `RELAY_CHUNK_MAGIC`, and ciphertext
   may contain any byte at any interior position.
3. For an envelope: check the length bound (§3.3); check that `version` equals
   `E2EE_PROTOCOL_VERSION` and `suite` equals the established session suite **before selecting
   any AEAD implementation**; check that the transmitted epoch and counter equal the
   receiver-expected next values (§9); then authenticate and decrypt with the AAD of §3.3. Only
   after authentication succeeds is the inner-record type read; RPC bodies go to the RPC parser
   and control bodies to the control handler. Any failure at any of these steps is fatal.
4. For a negotiation record: enforce the per-type bound before parsing; accept only in the
   states §4.4 permits.
5. For legacy JSON: deliver to the RPC parser only in the states §4.4 permits.
6. Any other first byte — and an absent one, per step 2 — is fatal in every state.

**Unauthenticated bytes never reach the RPC parser.** On a channel in `e2ee` mode the only path
to the RPC parser is a successfully authenticated inner RPC record.

### 4.4 Mode machine

Each channel has exactly one receiver mode machine, created when the channel is accepted and
destroyed when the channel closes. E2EE state is per channel and never resumed (§6); there is
**no mid-channel upgrade** from `legacy` to `e2ee` and no downgrade from `e2ee` to `legacy`.

States:

- `negotiating` — initial state, entered at `channel.accept`.
- `e2ee` — entered only through a complete authenticated handshake (§8).
- `legacy` — entered only when fallback policy accepts the first legacy RPC message or the
  client's advertisement wait expires (rows N2, N17, K9, K13). Effective `requireE2EE` (node) and
  a latched or unexpected selection (client, §12.1.1) forbid entering `legacy`.

Input classes (post-strip, per §3.4): `ENVELOPE`, `NEGOTIATION(type)`, `LEGACY-JSON`, `CARRIER`
(the subclass of `LEGACY-JSON` that is a top-level JSON object whose `_tag` member equals
`E2EE_CAPABILITY_CARRIER_TAG`, §5.3), `OTHER` (any other first byte, **or a zero-length
post-strip payload**, §3.4), plus timer expiries and the channel-creation event
`channel.accept`, which is the input of node rows N15 and N16.

Fatal outcomes use one of two procedures, elaborated in §11:

- **FATAL-PRE** (no established session keys): if the endpoint is the node and the channel is
  still writable, send the fixed-size `E2EEHandshakeReject` (§11; the §3.4 registry fixes its
  direction as node to client, and a client never emits a negotiation record toward a peer
  whose E2EE support is unproven, §5.1); close the channel with the existing close reason
  `channel_rejected`; deliver nothing to the application. The externally observable result of
  every pre-key failure is identical: a generic fixed-size reject record when the node was
  writable, the `channel_rejected` close reason, and zero application payload.
- **FATAL-POST** (session keys established): when sendable, emit an encrypted `E2EEError` inner
  record consuming the normal directional sequence, then close with `channel_rejected`.

_Note (non-normative)_: `channel_rejected` is an existing stable protocol 1.2+ close reason;
this protocol introduces no close-reason literal (verified against
`packages/contracts/src/relay.ts:57-86`, 2026-07-30).

Node (responder) transitions:

| #   | State                            | Input                                                | Guard                                                                                                                                   | Action                                                                                                                                                                                                | Next                             |
| --- | -------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| N1  | `negotiating`                    | `LEGACY-JSON`                                        | effective `requireE2EE`                                                                                                                 | FATAL-PRE                                                                                                                                                                                             | closed                           |
| N2  | `negotiating`                    | `LEGACY-JSON`                                        | otherwise, node E2EE-capable, **advertisement emitted**                                                                                 | Lock legacy; count one **peer-legacy** fallback occurrence (§12.5); deliver to the RPC parser                                                                                                         | `legacy`                         |
| N3  | `negotiating`                    | `NEGOTIATION(E2EEClientHello)`                       | advertisement emitted; first hello on this channel; within bound                                                                        | Run the responder handshake (§8); on success emit `E2EEServerAccept`; any handshake failure is FATAL-PRE                                                                                              | `e2ee`                           |
| N4  | `negotiating`                    | `NEGOTIATION(E2EEClientHello)`                       | advertisement unavailable (§5.5) or a hello was already consumed                                                                        | FATAL-PRE                                                                                                                                                                                             | closed                           |
| N5  | `negotiating`                    | `NEGOTIATION` (any other or misdirected type)        | —                                                                                                                                       | FATAL-PRE                                                                                                                                                                                             | closed                           |
| N6  | `negotiating`                    | `ENVELOPE`                                           | —                                                                                                                                       | FATAL-PRE                                                                                                                                                                                             | closed                           |
| N7  | `negotiating`                    | `OTHER`                                              | —                                                                                                                                       | FATAL-PRE                                                                                                                                                                                             | closed                           |
| N8  | `negotiating`                    | `T_HANDSHAKE_NODE` expires (from advertisement emit) | effective `requireE2EE`; handshake incomplete — covers a silent peer, an oversized or excessive negotiation exchange, and timeout alike | FATAL-PRE                                                                                                                                                                                             | closed                           |
| N9  | `e2ee`                           | `ENVELOPE`                                           | §4.3 step 3 checks pass; known inner type                                                                                               | Deliver the authenticated inner record. The first authenticated client→node envelope completes the implicit client finish (§8); the node MUST NOT emit RPC output or invoke the RPC handler before it | `e2ee`                           |
| N10 | `e2ee`                           | `ENVELOPE`                                           | any §4.3 step 3 check fails, or reserved inner type                                                                                     | FATAL-POST                                                                                                                                                                                            | closed                           |
| N11 | `e2ee`                           | `NEGOTIATION` / `LEGACY-JSON` / `OTHER`              | —                                                                                                                                       | FATAL-POST; plaintext after E2EE never reaches the RPC parser                                                                                                                                         | closed                           |
| N12 | `legacy`                         | `LEGACY-JSON`                                        | —                                                                                                                                       | Deliver to the RPC parser                                                                                                                                                                             | `legacy`                         |
| N13 | `legacy`                         | `ENVELOPE` / `NEGOTIATION`                           | —                                                                                                                                       | FATAL-PRE (no session keys exist in `legacy`)                                                                                                                                                         | closed                           |
| N14 | `legacy`                         | `OTHER`                                              | —                                                                                                                                       | FATAL-PRE                                                                                                                                                                                             | closed                           |
| N15 | `negotiating`                    | `channel.accept`                                     | advertisement unavailable (§5.5 U1 or U2); effective `requireE2EE`                                                                      | FATAL-PRE, before any carrier is built and before any peer input; §11.2 P2 (U1) or P23 (U2), plus the §5.5 operator diagnostic                                                                        | closed                           |
| N16 | `negotiating`                    | `channel.accept`                                     | advertisement unavailable (§5.5 U1 or U2); otherwise                                                                                    | Suppress the advertisement; record exactly one **advertisement-unavailable** occurrence for this channel (§12.5) — never a peer-legacy occurrence; emit no carrier                                    | `negotiating` (no advertisement) |
| N17 | `negotiating` (no advertisement) | `LEGACY-JSON`                                        | otherwise, node E2EE-capable                                                                                                            | Lock legacy; deliver to the RPC parser. The channel's single fallback occurrence was already recorded by N16, so N2's peer-legacy count MUST NOT also fire                                            | `legacy`                         |

Rows N2 and N17 partition legacy admission by whether the node actually advertised, so an
advertisement the node could not emit is never recorded as evidence that a legacy peer exists
(§12.3, §12.5).

**Row N8 is deliberately guarded and rows N9/N12 deliberately have no idle deadline.** Arming
N8 unconditionally was considered and rejected: it would make the default-policy node strictly
less permissive than today's node — any peer whose first channel-borne JSON is later than
`T_HANDSHAKE_NODE` would be closed where it is currently served — while buying no availability,
because a peer that sends one legacy message (N2 → `legacy`) or one envelope holds its channel
slot indefinitely in every configuration anyway. The channel slot is consumed at
`channel.accept`, before any E2EE state exists, and `negotiating` costs the node no more than a
legacy channel that has not yet spoken. Per-channel idle reaping and per-account concurrent-
channel quotas are relay- and Hub-layer concerns and are deliberately not bolted onto a payload
encryption handshake; §15 states the structural bound that does apply. The **implicit-finish**
deadline of §8.9 is a different matter and _is_ armed unconditionally, because there the node is
holding live key material rather than an idle slot.

**Node-local terminations are not input rows, and the absence of a row is not an absence of a
rule.** The node table above enumerates transitions driven by peer input, timer expiry, or
`channel.accept`. Three node-local events terminate an already-admitted channel and are defined
elsewhere rather than as rows, because none is driven by anything the peer sends:

- the §8.9 implicit-finish deadline (FATAL-POST, §11.3 Q8), on an `e2ee` channel;
- the §13.6 **authorization withdrawal** sweep (FATAL-POST with code `policy`, §11.3 Q9), on an
  `e2ee` channel;
- the §12.6 **policy withdrawal** sweep, which reaches `e2ee` channels the narrowed policy no
  longer admits (FATAL-POST with code `policy`, §11.3 Q12) **and** — uniquely among the three —
  `legacy` channels, which hold no session keys and therefore close with `channel_rejected` and no
  record of any kind, not even an `E2EEHandshakeReject` (§12.6, §11.3).

The `e2ee` cases exit that state exactly as rows N10 and N11 do — one encrypted error record when
the send path is usable, then `channel_rejected` — and an implementation that treats the node
table as the complete list of ways a channel ends is non-conforming. The two withdrawal sweeps
are the ones that can fire on a channel that has been serving application RPC for an arbitrary
time, because §15 arms no idle deadline in `legacy` or in `e2ee`; they are disjoint transitions
with disjoint tests — §13.6 asks what a _client_ is authorized to do, §12.6 asks what the _node_
admits — and an implementation MUST evaluate both.

Both withdrawal transitions additionally terminate channels that are **not yet admitted to
anything**: a handshake in flight in `negotiating` is aborted as FATAL-PRE — §11.2 `P12` for the
§13.6 authorization withdrawal, §11.2 `P25` for the §12.6 policy withdrawal — with the ordinary
generic reject and no distinguishable signal. These are not rows either, for the same reason: no
peer input drives them.

**The keepalive `Ping` is plaintext.** Rows N1, N2, N11, K18 and K19 classify a bare
`{"_tag":"Ping"}` exactly as they classify any other plaintext RPC message: in `negotiating` it
is `LEGACY-JSON`, so a client that let one escape would trigger N1 (a spurious FATAL-PRE) or, far
worse, N2 — a silent legacy lock of a channel that was about to go E2EE, counted as evidence
that a legacy client population exists (§12.5). This is why the send-buffering rule below covers
_all_ plaintext and not only application RPC, and why §3.2.2 L1 exists to make that safe.

Client (initiator) transitions:

| #   | State         | Input                                         | Guard                                                                                                                                                                                                                                                                                                     | Action                                                                                                                                                                                                                             | Next                       |
| --- | ------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| K1  | `negotiating` | `CARRIER`                                     | first carrier; statement validates and yields a usable protocol version, suite, and admitted pattern (§5.2 including steps 8–9, §8.2); the client proceeds (see the no-legacy-after-evidence rule below)                                                                                                  | Cancel `T_ADV`; select the suite (§8.2); durably commit any authenticated native trust advance within `T_TRUST_COMMIT`; then send `E2EEClientHello` and start a fresh `T_HANDSHAKE`. Commit rejection or expiry is local FATAL-PRE | `negotiating` (hello sent) |
| K2  | `negotiating` | `CARRIER`                                     | statement fails validation, or is valid but unusable — protocol range excluding `E2EE_PROTOCOL_VERSION` (§5.2 step 8), empty suite intersection (§8.2), or an effective admitted pattern set omitting this client's tier's pattern (§5.2 step 9, §7.6 element 14); the selection is **latched** (§12.1.1) | FATAL-PRE                                                                                                                                                                                                                          | closed                     |
| K3  | `negotiating` | `CARRIER`                                     | statement fails validation or is unusable (as K2); the selection is not latched                                                                                                                                                                                                                           | Treat as absent evidence: discard, record a client diagnostic; MUST NOT send a hello on unvalidated or unusable evidence; the `T_ADV` rows below still decide the channel                                                          | `negotiating`              |
| K4  | `negotiating` | `CARRIER`                                     | duplicate carrier                                                                                                                                                                                                                                                                                         | FATAL-PRE                                                                                                                                                                                                                          | closed                     |
| K5  | `negotiating` | `NEGOTIATION(E2EEServerAccept)`               | hello sent; within bound; verification succeeds (§8)                                                                                                                                                                                                                                                      | Enter `e2ee`; flush the buffered sends as envelopes                                                                                                                                                                                | `e2ee`                     |
| K6  | `negotiating` | `NEGOTIATION(E2EEServerAccept)`               | no hello sent, or verification fails                                                                                                                                                                                                                                                                      | FATAL-PRE                                                                                                                                                                                                                          | closed                     |
| K7  | `negotiating` | `NEGOTIATION(E2EEHandshakeReject)`            | hello sent; exact size                                                                                                                                                                                                                                                                                    | FATAL-PRE — the handshake failed; retry requires a fresh ticket, channel, and handshake                                                                                                                                            | closed                     |
| K8  | `negotiating` | `NEGOTIATION` (any other or misdirected type) | —                                                                                                                                                                                                                                                                                                         | FATAL-PRE                                                                                                                                                                                                                          | closed                     |
| K9  | `negotiating` | `LEGACY-JSON` (non-carrier)                   | hello not sent; the selection is **legacy-eligible** (§12.1.1); local policy permits legacy                                                                                                                                                                                                               | Lock legacy; deliver; flush the buffered sends as plaintext                                                                                                                                                                        | `legacy`                   |
| K10 | `negotiating` | `LEGACY-JSON` (non-carrier)                   | the selection is **latched** (§12.1.1), local policy forbids legacy, or hello sent                                                                                                                                                                                                                        | FATAL-PRE                                                                                                                                                                                                                          | closed                     |
| K11 | `negotiating` | `ENVELOPE`                                    | —                                                                                                                                                                                                                                                                                                         | FATAL-PRE                                                                                                                                                                                                                          | closed                     |
| K12 | `negotiating` | `OTHER`                                       | —                                                                                                                                                                                                                                                                                                         | FATAL-PRE                                                                                                                                                                                                                          | closed                     |
| K13 | `negotiating` | `T_ADV` expires (from `channel.accept`)       | no validated statement; hello not sent; the selection is **legacy-eligible** (§12.1.1); policy permits legacy                                                                                                                                                                                             | Lock legacy; flush the buffered sends as plaintext                                                                                                                                                                                 | `legacy`                   |
| K14 | `negotiating` | `T_ADV` expires                               | the selection is **latched** (§12.1.1), or policy forbids legacy                                                                                                                                                                                                                                          | FATAL-PRE                                                                                                                                                                                                                          | closed                     |
| K15 | `negotiating` | `T_HANDSHAKE` expires (from hello emit)       | no valid `E2EEServerAccept` received                                                                                                                                                                                                                                                                      | FATAL-PRE — never a legacy fallback after a hello                                                                                                                                                                                  | closed                     |
| K16 | `e2ee`        | `ENVELOPE`                                    | §4.3 step 3 checks pass; known inner type                                                                                                                                                                                                                                                                 | Deliver the authenticated inner record                                                                                                                                                                                             | `e2ee`                     |
| K17 | `e2ee`        | `ENVELOPE`                                    | any check fails, or reserved inner type                                                                                                                                                                                                                                                                   | FATAL-POST                                                                                                                                                                                                                         | closed                     |
| K18 | `e2ee`        | `NEGOTIATION` / `LEGACY-JSON` / `OTHER`       | —                                                                                                                                                                                                                                                                                                         | FATAL-POST                                                                                                                                                                                                                         | closed                     |
| K19 | `legacy`      | `LEGACY-JSON` (non-carrier)                   | —                                                                                                                                                                                                                                                                                                         | Deliver to the RPC parser                                                                                                                                                                                                          | `legacy`                   |
| K20 | `legacy`      | `CARRIER`                                     | —                                                                                                                                                                                                                                                                                                         | Ignore as a no-op; MAY record a fallback diagnostic; MUST NOT upgrade                                                                                                                                                              | `legacy`                   |
| K21 | `legacy`      | `ENVELOPE` / `NEGOTIATION`                    | —                                                                                                                                                                                                                                                                                                         | FATAL-PRE                                                                                                                                                                                                                          | closed                     |
| K22 | `legacy`      | `OTHER`                                       | —                                                                                                                                                                                                                                                                                                         | FATAL-PRE                                                                                                                                                                                                                          | closed                     |
| K23 | `negotiating` | `LEGACY-JSON` (non-carrier)                   | hello not sent; the selection is **unexpected** (§12.1.1); local policy permits legacy                                                                                                                                                                                                                    | FATAL-PRE; raise the §13.2.1 unexpected-node surface; the buffered sends are discarded unflushed                                                                                                                                   | closed                     |
| K24 | `negotiating` | `T_ADV` expires                               | no validated statement; hello not sent; the selection is **unexpected** (§12.1.1); policy permits legacy                                                                                                                                                                                                  | FATAL-PRE; raise the §13.2.1 unexpected-node surface; the buffered sends are discarded unflushed                                                                                                                                   | closed                     |

Rows K9/K10/K23 and K13/K14/K24 partition their input: §12.1.1 classifies every selection as
exactly one of legacy-eligible, latched, or unexpected, so no client input reaches an
unspecified outcome and "absence of evidence" can never by itself select the legacy branch.
**That classification is computed from client-anchored state only** — the resolved pin, the set of
verified pins under the pair, the device-level `anyNodeVerified(hubOrigin)` marker (§13.1), and
the owner's recorded consent. No Hub-supplied value may move a selection _into_ the
legacy-eligible class: not the `nodeId`, which the Hub re-mints at will, and not the `accountId`,
which the Hub issues (§12.1.1). Rows K13 and K9 are the only rows that release plaintext, and
their guard is exactly the class this rule protects.

Cross-cutting rules:

- **Exactly one handshake attempt per channel.** Any failure after a hello was sent or consumed
  is fatal for the channel; neither endpoint retries a handshake on the same channel. A fresh
  attempt requires a fresh ticket, channel, and handshake.
- **Send buffering.** An E2EE-capable client MUST NOT transmit **any** plaintext on the channel
  while in `negotiating`, including RPC keepalive `Ping` frames and every other protocol-level
  frame the RPC layer would otherwise write: it buffers them until it enters `e2ee` (flushed as
  envelopes) or `legacy` (flushed as plaintext). On every FATAL-PRE row the buffer is discarded
  unsent — no buffered byte is ever flushed as plaintext on a channel that closed rather than
  locking `legacy`. The maximum contiguous duration of this window is bounded by §3.2.2 L1.
- **Send-buffer bound and disposition.** The buffer sits _above_ the relay send queue precisely
  so that nothing is handed down to it, so it does not inherit the queue's accounting by
  accident and MUST be bounded explicitly. Each buffered send MUST satisfy the §4.5 per-message
  bounds at submission time, and the total buffered bytes MUST be charged against
  `E2EE_NEGOTIATION_BUFFER_MAX_BYTES` — the same aggregate budget the relay send queue enforces
  — as though the bytes had already been enqueued. **The accounting is per relay connection, not
  per channel**, and this is normative rather than an implementation choice: the budget is
  derived from `ready` limits that govern one send queue on one connection, so charging it once
  per channel would let a client with the connection's full complement of channels — up to
  `RELAY_MAX_CHANNELS`, every one of them able to be `negotiating` at once — commit up to
  `RELAY_MAX_CHANNELS` times the queue's whole capacity and then discover the overcommitment only
  at flush, on the path that flushes plaintext. The charge is therefore the sum of the buffered
  bytes held by every channel on that connection; a channel releases its share the instant it
  leaves `negotiating`, whether by flushing as envelopes, flushing as plaintext, or discarding on
  a FATAL-PRE exit. An implementation MAY additionally impose a per-channel share so one channel
  cannot starve the others, provided the connection-wide total still governs. A submission that
  would exceed it is refused
  with the sender-local `e2ee_send_unavailable` (§11.4): the same disposition an already-full
  relay send queue produces, non-fatal to the channel, never a silent drop, and never unbounded
  growth. On any FATAL-PRE exit from `negotiating` — that is, on every client FATAL-PRE row of
  that state: K2, K4, K6, K7, K8, K10, K11, K12, K14, K15, K23, and K24 — the buffered sends
  are discarded unflushed; the channel's `channel.close` is the caller's signal,
  and an implementation MAY surface a local failed-send diagnostic (§11.4) provided it alters no
  wire behavior. This is consistent with §13.2, where a pairing-only attempt never flushes.
- **No legacy after validated evidence.** A client holding a usable validated capability
  statement for the channel MUST either send the hello (row K1 — for an unverified pin, as the
  §13.2 pairing attempt) or close the channel with FATAL-PRE (for example, when the §13.2
  enrollment-fingerprint product flow requires owner input that has not yet happened). It MUST
  NOT fall back to legacy after validated evidence and MUST NOT idle in `negotiating` past
  `T_ADV`. **Usable** is the qualifier §5.2 steps 8–9 and §8.2 define, and it has exactly three
  failure modes: a statement that verifies completely but whose advertised protocol range excludes
  `E2EE_PROTOCOL_VERSION` (§5.2 step 8), whose suite intersection with the client is empty (§8.2),
  or whose effective admitted pattern set omits the Noise pattern this client's tier runs (§5.2
  step 9, §7.6 element 14) is not usable, no hello may be built from it, and rows K2/K3 govern the
  channel instead of this rule.
- **Selection guards are resolved at `channel.accept`.** Every latch and pin guard in the
  client rows (K2, K3, K9, K10, K13, K14, K23, K24) is evaluated against the pin the client
  resolves from **its own** channel selection, together with the device-level
  `anyNodeVerified(hubOrigin)` marker of §13.1, per §12.1.1 — never against evidence carried on
  the channel and never against a scope value the Hub supplies. A client MUST be able to evaluate
  these guards before it has received any payload, and MUST NOT treat unobtainable evidence as an
  unset latch or an unset marker.
- **Timers.** `T_ADV` is cancelled immediately when a usable verified statement selects K1, or
  when a mode is locked. The native client's authenticated trust hook then has `T_TRUST_COMMIT`
  to become durable; rejection or expiry is local FATAL-PRE, and the underlying storage operation
  may finish later but cannot resume the closed channel. The client's fresh `T_HANDSHAKE` starts
  only at hello emit (row K1); the node's `T_HANDSHAKE_NODE` starts at
  advertisement emit and, per §8.9, stays armed through the `e2ee` state until the implicit
  client finish authenticates. A timer expiry matches only the rows of the state in which it
  fires; a cancelled or superseded timer is ignored. The deadlines are separate constants
  because only the client is subject to the pinned keepalive budget of §3.2.2 L1; §3.2.2 L2
  keeps them ordered.
- **Malformed, unknown, and absent first bytes are fatal in every state** — a zero-length
  post-strip payload is the absent case (§3.4) and matches the same `OTHER` rows. Never an
  implicit legacy path and never a silent drop (rows N7, N11, N14, K12, K18, K22).
- **Mode transitions are one-way.** `negotiating → e2ee` and `negotiating → legacy` are the only
  mode transitions; plaintext after E2EE (N11, K18) and E2EE material after a legacy lock (N13,
  K21) are fatal.
- **The authenticated close is not a state and adds no row.** The close exchange of §10 happens
  entirely inside `e2ee`. Rows N9/N10/N11 and K16/K17/K18 apply unchanged for its whole duration:
  a negotiation record, legacy JSON, or an unknown or absent first byte arriving during a close
  is the same FATAL-POST it is at any other point in `e2ee` (§11.3 Q6), and an envelope beyond
  what the close machine expects is FATAL-POST `Q7` — in both cases the close verdict is
  **Failed** and never one of the unclean verdicts (§10.2, §10.4). The one envelope that is not
  `Q7` there is an authenticated `E2EEError`: it is the peer's terminal record, the receiver
  closes without replying, and the verdict is still **Failed** (§10.2, §11.3). Correspondingly,
  the single terminal `E2EEError` §10.2 permits after an endpoint's last close-machine record is
  the only record this protocol allows past the close machine, and §9.6 reserves the sequence
  capacity for it. The close phase does, however,
  create the **second** window in which an E2EE-capable client writes no keepalive `Ping`: §10.2
  makes the `Ping` an application RPC record for §10's purposes, and unlike the `negotiating`
  window above that one has no flush, because the channel ends when the phase does. Its duration
  is bounded by §3.2.2 L5 as this one is bounded by L1.

### 4.5 Size budget and plaintext ceiling

The relay size caps continue to apply to the **encrypted** byte count at both ends: the envelope
is the message the chunking layer sees, bounded by `RELAY_MAX_RPC_MESSAGE_BYTES` and chunked
against the data-chunk limit exactly as today. In addition, each endpoint computes, from its own
`ready` limits (relay-protocol.md, Negotiated limits):

```text
effectiveMessageCeiling = min(RELAY_MAX_RPC_MESSAGE_BYTES,
                              maxQueuedBytes − maxControlFrameBytes)

plaintextCeiling        = effectiveMessageCeiling − E2EE_ENVELOPE_OVERHEAD_BYTES
```

Rules:

- Every inner-record body — RPC and control alike — MUST satisfy
  `len(body) ≤ plaintextCeiling`, enforced **before encryption**. A violation is the
  sender-local error `e2ee_message_too_large`, distinct from the relay chunk layer's
  `message_too_large`; the record MUST NOT be encrypted or transmitted. Surfacing is defined in
  §11.
- A channel whose `plaintextCeiling` is not positive MUST fail during establishment, before the
  channel is released to the application.
- The plaintext ceiling is a deliberate, documented reduction of the maximum plaintext message
  size by `E2EE_ENVELOPE_OVERHEAD_BYTES` relative to a legacy channel.

**These limits are Hub-asserted, not negotiated.** `maxQueuedBytes`, `maxControlFrameBytes`, and
`maxDataChunkBytes` all arrive in the relay `ready` frame the Hub sends, and both endpoints adopt
them verbatim; neither endpoint proposes or vetoes a value. The upstream relay document's
"Negotiated limits" heading is inherited terminology, and this document does not repeat it for
security-relevant thresholds — §2.1 declares the party that chooses them untrusted. Here the
consequence is already fail-closed: an asserted combination that drives `plaintextCeiling`
non-positive fails the channel during establishment rather than shrinking anything silently. The
same adversary control over `maxDataChunkBytes` is **not** fail-closed by itself, which is why
§5.5 handles it explicitly.

_Note (non-normative)_: the sender-side ceiling formula matches the existing negotiated-limit
computation on both current senders, and because `effectiveMessageCeiling` never exceeds
`RELAY_MAX_RPC_MESSAGE_BYTES`, envelopes produced under it always pass the receiving assembler's
fixed reassembly cap (verified against `packages/client-runtime/src/relay/relayEngine.ts:198-206`,
`apps/server/src/hubConnector/RelayChannelRegistry.ts:232-239`, and
`packages/shared/src/relayMessageChunks.ts:228-235`, 2026-07-30).

## 5. Capability advertisement and negotiation

### 5.1 Advertise, never probe

E2EE support is discovered exclusively from the node's signed capability advertisement. A client
MUST NOT send any negotiation record — or infer E2EE support or policy from any failure — without
a validated capability statement. Probing an unknown node with a hello is destructive: a legacy
node cannot parse it, fails its session, and the single-use ticket and channel are burned.

Negotiation and the handshake complete on the **same channel** that carried the advertisement.
This protocol defines no reopen step, and an implementation MUST NOT close and reopen a channel
merely to switch modes.

_Note (non-normative)_: a legacy node's byte session deliberately fails on unparseable input
(verified against `apps/server/src/ws/RpcByteSession.ts:49-56`, 2026-07-30), and nothing in the
current runtimes forbids node-first data at the first node-to-client sequence or a same-channel
handshake after it (verified against `packages/client-runtime/src/relay/relayEngine.ts:303-335`,
2026-07-30).

### 5.2 Signed capability statement

An E2EE-capable node emits one capability statement per channel over the domain-separated
canonical-CBOR transcript produced by `encodeNodeE2eeCapabilityTranscript` under domain
`ryco.node-e2ee-capability.v1`. The node identity key signs that transcript through the
fixed-size signing envelope of §7.2.1 — the transcript grows with the carried continuity chain
and would otherwise be able to exceed `E2EE_SIGNING_INPUT_MAX_BYTES`. §7 fixes the byte-level
transcript encoding; the statement MUST contain exactly the following information:

| Field                                      | Content                                                                                                                                                                      |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hub origin                                 | Canonical Hub origin the node serves                                                                                                                                         |
| Node id                                    | Hub-assigned node identifier                                                                                                                                                 |
| Identity algorithm and key id              | The active node identity key's algorithm and key id                                                                                                                          |
| Identity public key and fingerprint        | The raw identity public key and its domain-separated fingerprint                                                                                                             |
| Continuity id                              | The node's stable continuity id (§7.5). REQUIRED in every statement, including from a node that has never rotated                                                            |
| E2EE protocol range                        | Minimum and maximum supported E2EE protocol versions; consumed by verifier step 8 below and by §8.6 step 2, and by nothing else (§7.6 elements 7–8)                          |
| Suite registry                             | The ordered suite registry entries the node offers (§3.4)                                                                                                                    |
| Node prekey certificate                    | Bounded agreement-prekey certificate: key id, raw agreement public key, identity cross-signature (§7), fingerprint, creation time, expiry                                    |
| Continuity chain                           | Bounded ordered identity-continuity certificate chain, at most `E2EE_CONTINUITY_CHAIN_MAX_LENGTH` entries (§13)                                                              |
| `requireE2EE`, `requireApprovedClientE2EE` | The raw admission-policy values                                                                                                                                              |
| Effective admission set                    | The effective admitted tier/pattern set; IK-only when `requireApprovedClientE2EE` is enabled (§12). Consumed by verifier step 9 below, and by nothing else (§7.6 element 14) |
| Policy generation                          | Monotonic policy generation (§5.7)                                                                                                                                           |
| Issued-at, expires-at                      | Statement validity interval (§5.7)                                                                                                                                           |

The raw responder static agreement public key is REQUIRED in the prekey certificate: Noise IK
cannot construct its first message from a fingerprint alone.

A verifier MUST, before acting on any statement:

0. reject a statement whose CBOR exceeds `E2EE_CAPABILITY_STATEMENT_MAX_BYTES` or whose
   transcript exceeds `E2EE_CAPABILITY_TRANSCRIPT_MAX_BYTES`, before decoding either (§7.6, §15);
1. verify the identity signature over the §7.2.1 signing envelope **rebuilt locally** from the
   exact transcript bytes received (§3.6 re-encode equality, §7.2.1 digest recomputation); no
   digest is carried on the wire and none may be accepted from it;
2. recompute **every** advertised fingerprint from its algorithm-labelled raw public key and
   reject any disagreement;
3. check the validity interval and clock-skew bounds (§5.7);
4. check the Hub origin against the origin the client is actually connected to;
5. check the prekey certificate's cross-signature, lifetime, and rotation-overlap rules (§6, §7);
6. when a **verified** pin exists for this node (§13.1), authenticate the current identity key
   back to the pin through the continuity chain (§13), and check the statement's continuity id
   against the pinned continuity id (§7.5, §13.1) — a differing value is channel-fatal and takes
   the §13.3 re-verification path, never the new-node path;
7. enforce the policy-generation rollback rules (§5.7); and
8. check the advertised **E2EE protocol range** (§7.6 elements 7–8): the statement is **unusable
   evidence** when `E2EE_PROTOCOL_VERSION` lies outside `[e2eeVersionMin, e2eeVersionMax]`, or
   when `e2eeVersionMin > e2eeVersionMax`; and
9. check the advertised **effective admitted pattern set** (§7.6 element 14): the statement is
   **unusable evidence** when the Noise pattern the client's own tier runs — `"IK"` for signed
   native, `"NX"` for web (§8.1) — is absent from that set.

Every defined verification verdict MUST be delivered to the client-local trust hook and the
serialized inbound state machine MUST await that hook before applying the verdict's K-row. This
includes valid-but-unusable evidence, because the web tier sets its in-memory latch from a
validated statement before K2/K3 is chosen. For a usable native verdict authenticated to an
existing pin (`pin-unchanged` or `pin-updated`), the hook MUST durably commit the latch,
policy-generation high-water, and any authenticated continuity rotation before K1 may emit a
hello. `T_ADV` is cancelled before that await; the commit has the separate `T_TRUST_COMMIT`
deadline; and only successful durability permits a fresh `T_HANDSHAKE` to begin at hello emit.
A hook throw, rejection, or deadline is local FATAL-PRE. Deadline and channel cancellation do not
cancel the underlying storage operation: a late success may tighten only its captured durable
selection, but no late settlement may resume the closed channel or publish into another active
selection. The web hook remains synchronous and behaviorally unchanged.

**Step 8 disposition, and why the range is consumed at all.** Elements 7–8 are decisive signed
fields, and a field no rule consumes is not neutral: it lets two conforming clients resolve the
same statement differently. §8.5 element 0 hard-codes `E2EE_PROTOCOL_VERSION` and §8.6 step 2
refuses any `e2eeVersion` outside the range the node advertised, so a hello sent against a range
that excludes the client's version cannot succeed and spends the channel and its single-use
ticket for nothing — exactly the destructive probing §5.1 forbids. A step 8 failure therefore
takes the disposition §8.2 gives an empty suite intersection: the client MUST NOT send a hello,
and rows K2/K3 of §4.4 apply as for invalid evidence — §11.2 P15 when the channel's selection is
latched, otherwise K3's absent-evidence treatment, with the `T_ADV` rows still deciding the
channel. Step 8 is placed **after every validation step** deliberately: a statement that also fails
step 6 is an identity event and MUST surface as the §13.3 re-verification path, which a version
check running earlier would mask. Steps 8 and 9 are the two usability checks and both run last,
after steps 0–7 have decided whether the statement is valid at all; their relative order is fixed
but carries no such requirement, since neither masks the other. For a latched selection the outcome is fatal on every channel until the
client implements a version the node advertises; that is the same standing as a node that
genuinely lost E2EE support, with the same recovery — the owner-initiated re-pair of §13.3, never
a legacy consent (§12.1.1, §17.19).

**Step 9 disposition, and why element 14 is consumed at all.** Element 14 is a REQUIRED signed
decisive field on exactly the footing elements 7–8 are on, and it fails in exactly the same way.
§8.6 step 2 refuses any hello whose `tier` the node's committed policy does not admit (`P9`), and
under `requireApprovedClientE2EE` element 14 is precisely `["IK"]` (§7.6, §12.4) — so a web client
that validated such a statement and built an NX hello anyway would spend the channel and its
single-use ticket on a refusal the signed evidence already announced, which is the
destructive probing §5.1 forbids and which no local diagnostic would explain. Because the policy
is durable node state rather than a transient, every session against that node would repeat it.
A step 9 failure therefore takes the identical disposition to step 8 and to §8.2's empty suite
intersection: **no hello may be built from the statement**, and rows K2/K3 of §4.4 govern the
channel — §11.2 `P15` when the channel's selection is latched, otherwise K3's absent-evidence
treatment with the `T_ADV` rows still deciding it. Step 9 is placed after step 8 for the same
reason step 8 is placed after the validation steps: an identity event (step 6) and a version
failure (step 8) each carry their own required surface, and a pattern check running earlier would
mask them.

**What that means per tier, stated rather than left to be derived.** For **web** the outcome is
fail-closed and there is no plaintext release: the in-memory latch of §12.1 is set on the first
statement the session **validates**, and steps 8 and 9 run after validation has succeeded, so the
selection is latched by the time either check fails and the channel takes K2/`P15` — never K3
followed by a K13 `T_ADV` flush of buffered plaintext. The cost is availability, and it is real:
a web client cannot reach a node running `requireApprovedClientE2EE` at all, which is what §12.4
already says that policy does, and §17.20 records the residual. For **native** the pattern is
`"IK"`, which element 14 never omits under any version-1 policy state, so step 9 is unreachable
for a conforming native client against a conforming version-1 node; it is written over the tier's
pattern rather than over the literal `"NX"` so that a future tier or pattern addition changes one
rule and not several.

"A verified pin exists for this node" is decided by the client's own selection resolution
(§12.1.1), not by any identifier the statement carries. An `unverified` pin record is not a
verified pin: it carries the §13.2 pairing flow and anchors nothing (§13.1), so step 6 has no
anchor to authenticate against for such a selection. A statement's continuity id may additionally resolve a
channel to a pin under the same `(hubOrigin, accountId)` that the selection did not resolve, but
only ever to tighten the applicable guards (§12.1.1); a matching continuity id authenticates
nothing on its own.

Against an already verified pin or identity-continuity chain, the Hub cannot forge or splice the
statement. On first contact, a statement authenticates the advertised fields **to the carried
key only** — self-consistency, not identity. A self-signed first-contact statement MUST NOT set
a trusted pin and MUST NOT activate the active-Hub guarantee (§13). A first-contact statement
arriving under a `(hubOrigin, accountId)` pair that already holds a verified pin MUST be
presented as a possible node substitution, per §13.2.1 situation 2 — never as routine new-node
pairing. Because the Hub chooses the account half of that pair (§12.1.1), the pair test alone
would be shed by an account re-mint: a first-contact statement arriving on a `hubOrigin` whose
device-level `anyNodeVerified` marker is set but under an account scope holding no verified pin
MUST therefore be presented per §13.2.1 situation 3, also never as routine new-node pairing.

### 5.3 Legacy-safe capability carrier

Because the upgraded node sends the advertisement before knowing the client tier, its carrier
MUST be a bounded, legacy-valid application message that existing RPC decoders demonstrably
ignore without invoking a method or failing the session (§5.6). The carrier is a single JSON
text:

```text
{"_tag":"ryco.e2ee.capability.v1","statement":"<base64url of the capability statement CBOR>"}
```

Normative requirements:

- Direction is **node to client only**. A client MUST NOT send the carrier — or any
  unknown-tag JSON — to a node (§5.6, case C5).
- The carrier is a top-level JSON object with exactly the two members shown, in that order,
  byte-identical to the output of a standard JSON encoder with no added whitespace
  (`JSON.stringify` of the two-member object). Its first byte is therefore `{`.
- It MUST NOT contain a `requestId` member.
- `_tag` is exactly `E2EE_CAPABILITY_CARRIER_TAG`. This tag is reserved by this protocol and
  MUST NOT be reused by any RPC message or effect tag.
- `statement` is the unpadded base64url encoding of the canonical-CBOR capability statement
  (§5.2). The statement CBOR MUST NOT exceed `E2EE_CAPABILITY_STATEMENT_MAX_BYTES`, and the
  complete carrier JSON MUST NOT exceed `E2EE_CAPABILITY_CARRIER_MAX_BYTES`. The two bounds are
  not independent assertions: §3.2.1 S5 derives the second from the first, given that the
  carrier's fixed part is exactly `E2EE_CAPABILITY_CARRIER_FIXED_BYTES` bytes and unpadded
  base64url expands the statement to exactly `⌈4 · len / 3⌉` characters.
- The node sends the carrier exactly once per channel, unless the advertisement is unavailable
  under §5.5.

_Note (non-normative)_: a malformed carrier is **not** ignored by legacy clients — a JSON parse
failure fails every in-flight request — which is why the carrier bytes must come from a real
JSON encoder rather than hand assembly (verified against the pinned `effect@4.0.0-beta.106` RPC
client's decode-failure path, 2026-07-30). The JSON-whitespace chunk prelude alone does not make
an arbitrary extra message legacy-safe; the safety argument is the tag-routing analysis in §5.6.

### 5.4 Carrier sequencing

The carrier MUST be the first node-to-client data payload on the channel, carried at relay data
sequence 0 for that direction, enqueued immediately after `channel.accept`, and sent through the
node's single ordered channel send path — the same path as all other node data — so that:

- the shared per-direction output sequence stays continuous: the node's next data payload,
  E2EE or legacy, carries relay sequence 1; and
- the `RELAY_CHUNK_CAPABILITY_PRELUDE` is prepended exactly as for any other fitting message,
  establishing the upgraded node's chunking support to the peer.

_Note (non-normative)_: `channel.accept` travels on the control lane, which is flushed before
data, and the client accepts data from sequence 0 immediately after the accept frame flips its
channel state; sending the carrier outside the shared send path would break the single output
sequence counter and close the channel (verified against
`apps/server/src/hubConnector/RelayChannelRegistry.ts:232-261` and
`packages/client-runtime/src/relay/relayEngine.ts:303-335`, 2026-07-30).

### 5.5 Size bound, advertisement serviceability, and undersized connections

The carrier is sent before the node has any evidence of peer chunking support, so it MUST fit in
a single unchunked payload **with the full prelude headroom**:

```text
len(carrier JSON) + RELAY_CHUNK_CAPABILITY_PRELUDE_BYTES ≤ asserted maxDataChunkBytes
```

**The data-chunk limit is Hub-asserted, not negotiated.** `maxDataChunkBytes` arrives in the
relay `ready` frame the Hub sends and both endpoints adopt it verbatim; the relay protocol admits
any value in `[RELAY_MIN_DATA_CHUNK_BYTES, RELAY_MAX_DATA_CHUNK_BYTES]`, and neither endpoint
proposes, counters, or vetoes it. This document therefore calls it **asserted**, never
_negotiated_ (§4.5): it is a security-relevant threshold chosen by the party §2.1 declares
untrusted.

**The fit is guaranteed by construction, not by advice.** A conforming node's carrier can never
exceed `E2EE_CAPABILITY_CARRIER_MAX_BYTES`: §7.6 bounds the transcript by
`E2EE_CAPABILITY_TRANSCRIPT_MAX_BYTES`, §3.2.1 S4 and S5 derive the statement and carrier bounds
from it, and §7.6.1 makes the node prove each of them before it advertises at all. By §3.2.1 S6
the inequality above therefore holds for **every** conforming carrier — including one carrying a
full `E2EE_CONTINUITY_CHAIN_MAX_LENGTH` chain at `E2EE_HUB_ORIGIN_MAX_BYTES` — on any connection
whose asserted `maxDataChunkBytes` is at least `E2EE_ADVERTISEMENT_MIN_CHUNK_BYTES`.

An earlier revision of this rule instead told the node to "bound its continuity chain and
certificate material so the carrier fits comfortably even at small negotiated limits". That
advice was unactionable and is deleted: §7.5 forbids the node from shrinking the chain to fit,
because it cannot know the peer's pin at advertise time and a truncated chain is channel-fatal
for a pinned client. The node has no lever; the bounds do.

**Advertisement availability is decided per connection and per node configuration, never per
carrier.** The node's advertisement is **unavailable** on a channel when either:

- **U1 — undersized connection.** The relay connection carrying the channel asserted
  `maxDataChunkBytes < E2EE_ADVERTISEMENT_MIN_CHUNK_BYTES`. This is evaluated **once per relay
  connection**, on `ready`, before any channel on it is accepted — never per carrier, and never
  after a statement has been built. No conforming carrier can be delivered on such a connection,
  so there is nothing channel-specific to decide.
- **U2 — no conforming statement.** The node holds no currently valid signed capability
  statement because its §7.6.1 self-check fails: the transcript exceeds
  `E2EE_CAPABILITY_TRANSCRIPT_MAX_BYTES`, the canonical Hub origin exceeds
  `E2EE_HUB_ORIGIN_MAX_BYTES`, the identity signing interface refused the §7.2.1 envelope, or the
  node cannot resolve the continuity id §7.6 element 18 requires — its stored value and its
  continuity-id anchor disagree, or the anchor is unreadable (§7.5). The last condition is
  deliberately U2 and not a mint: a node that cannot prove which lineage it belongs to declines to
  advertise rather than assert a fresh one, because asserting one is a fleet-wide re-verification
  event (§7.5, §13.3, §17.11).

In neither case may the node truncate, split, chunk, or re-shape the carrier, and in neither case
may it emit a partial, pruned, or unsigned statement. The disposition is:

- **Under effective `requireE2EE`** (§12.4): every channel on the affected connection (U1), or
  every channel the node serves at all (U2), is FATAL-PRE — close with `channel_rejected`, row
  N15 of §4.4, condition P2 (U1) or P23 (U2) of §11.2. The wire surface stays the generic one of
  §11.2; separately, and node-locally, the node
  MUST surface an operator diagnostic naming the condition, and for U1 both the asserted
  `maxDataChunkBytes` and `E2EE_ADVERTISEMENT_MIN_CHUNK_BYTES`. This is fail-closed and is not
  weakened by anything below.
- **Otherwise**: the node suppresses the advertisement (row N16) and serves the channel as an
  ordinary legacy channel if and when the client sends legacy JSON (row N17). At `channel.accept`
  — with row N16, and whether or not the peer ever speaks legacy — it MUST record exactly one
  occurrence for the channel under the **advertisement-unavailable** class of §12.5, naming
  `undersized-connection` or `statement-unavailable`, and MUST NOT record a peer-legacy
  occurrence for the same channel.

**Why the second branch is not a silent Hub downgrade lever.** Three properties bound it, and
they are the reason this branch is retained rather than promoted to a universal fail-closed:

1. _It cannot reach a protected selection._ The client resolves its selection at
   `channel.accept`, before any evidence arrives (§12.1.1), so an absent carrier is fatal for a
   **latched** selection (row K14, §11.2 P19) and fatal-plus-owner-surface for an **unexpected**
   one (row K24, P22). U1 and U2 can therefore produce plaintext only on a selection already
   classified legacy-eligible — precisely the exposure §17.4 already retains for a Hub that
   simply strips the carrier. Suppression buys the Hub no victim that stripping did not.
2. _It is not silent._ The occurrence is counted in its own class, displayed separately by the
   node CLI, and accompanied by the operator diagnostic above (§12.5).
3. _It cannot veto the rollout._ Because the Hub chooses `maxDataChunkBytes`, counting U1 in the
   same bucket as a genuine legacy peer would let the Hub hold the §12.3 flip criterion above
   zero forever. §12.3 therefore gates on the peer-legacy class only.

Failing this branch closed instead would not add confidentiality — a Hub that can assert a small
limit can equally strip the carrier — while handing that same Hub a universal, one-integer
outage of every node. The honest statement is in §2.3 and §17.13.

_Note (non-normative) — worst-case carrier arithmetic._ This is the evidence that S6 — and
therefore the carrier-fit inequality at the top of this section — is satisfiable, so every figure
below is derived from a stated rule rather than asserted, and each one is reproducible from §3.6,
§7.1, §7.5, and §7.6 alone.

Encoding rules used, all of them §3.6 canonical CBOR: definite lengths and shortest-form
integers throughout; a text or byte string of length _n_ costs a header of 1 byte for
_n_ ≤ 23, 2 bytes for 24 ≤ _n_ ≤ 255, and 3 bytes for 256 ≤ _n_ ≤ 65,535, plus _n_; an array of
at most 23 elements costs a 1-byte header; a boolean costs 1 byte. Every bound is taken
simultaneously: Hub origin at `E2EE_HUB_ORIGIN_MAX_BYTES` (128 bytes), continuity chain at
`E2EE_CONTINUITY_CHAIN_MAX_LENGTH` (8 entries), suite registry at
`E2EE_SUITE_REGISTRY_MAX_ENTRIES` (8 entries), and 22-character identifier bodies behind the
§7.1 prefixes (`node_`/`nkey_` → 27 characters, `epk_`/`nct_` → 26). **Every unsigned field is
charged its widest canonical encoding, 9 bytes**, including `e2eeVersionMin`, `e2eeVersionMax`,
and each suite id, whose values in the version-1 registries encode in one byte. That deliberately
over-charges by 80 bytes today; it is done so the figures remain an upper bound if a later
registry carries larger values, and it is the reading §3.2.1 gives `worstCaseCapabilityTranscript`.

```text
§7.5 continuity transcript (13 elements, origin 128)              =   421 B
  array header 1 · domain 2+32 · hubOrigin 2+128 · continuityId 2+26
  · generation 9 · oldAlgorithm 1+7 · oldKeyId 2+27
  · oldPublicKey 2+32 · oldFingerprint 2+32 · newAlgorithm 1+7
  · newKeyId 2+27 · newPublicKey 2+32 · newFingerprint 2+32
  · createdAt 9
  carried entry [ bstr(421), bstr(64) ]  = 1 + 3 + 421 + 2 + 64   =   491 B
  chain array header + 8 entries         = 1 + 8 × 491            = 3,929 B

§7.6 capability transcript                                        = 4,560 B
  fixed elements (every element except 1 and 11)                  =   501 B
    array header (19 elements)                                    =     1
    0  domain "ryco.node-e2ee-capability.v1" (28)  2 + 28         =    30
    2  nodeId (27)                                 2 + 27         =    29
    3  identityAlgorithm "ed25519" (7)             1 +  7         =     8
    4  identityKeyId (27)                          2 + 27         =    29
    5  identityPublicKey                           2 + 32         =    34
    6  identityFingerprint                         2 + 32         =    34
    7  e2eeVersionMin                                             =     9
    8  e2eeVersionMax                                             =     9
    9  suiteRegistry                               1 + 8 × 9      =    73
    10 prekeyCertificate (6-element array)                        =   181
         header 1 · prekeyId 2+26 · agreementPublicKey 2+32
         · crossSignature 2+64 · agreementFingerprint 2+32
         · createdAt 9 · expiresAt 9
    12 requireE2EE                                                =     1
    13 requireApprovedClientE2EE                                  =     1
    14 admittedPatterns ["IK","NX"]                 1 + 3 + 3     =     7
    15 policyGeneration                                           =     9
    16 issuedAt                                                   =     9
    17 expiresAt                                                  =     9
    18 continuityId (26)                            2 + 26        =    28
  1  hubOrigin (2-byte header + 128)                              =   130 B
  11 continuity chain (above)                                     = 3,929 B
  ⇒ 501 + 130 + 3,929 = 4,560
                     ≤ E2EE_CAPABILITY_TRANSCRIPT_MAX_BYTES (5,120)  ✓ S8

signed statement [ bstr(4,560), bstr(64) ] = 1 + 3 + 4,560 + 2 + 64
                                                                  = 4,630 B
  wrapper overhead 1 + 3 + 2 + 64 = 70 = E2EE_STATEMENT_WRAPPER_MAX_BYTES
  ⇒ 4,630 ≤ E2EE_CAPABILITY_STATEMENT_MAX_BYTES (5,190)           ✓ S4

base64url, unpadded: ⌈4 × 4,630 / 3⌉                              = 6,174 chars
carrier JSON: 49 + 6,174                                          = 6,223 B
  ⇒ 6,223 ≤ E2EE_CAPABILITY_CARRIER_MAX_BYTES (6,969)             ✓ S5
carrier + prelude: 6,223 + 8                                      = 6,231 B
  ⇒ 6,231 ≤ E2EE_ADVERTISEMENT_MIN_CHUNK_BYTES (8,192)            ✓ S6

signing input: §7.2.1 envelope, fixed                             =    72 B
  ⇒ 72 ≤ E2EE_SIGNING_INPUT_MAX_BYTES (4,096)                     ✓ S1
```

_Note (non-normative), continued._ For contrast, the same worst-case transcript signed
**directly** would be 4,560 bytes against an
`E2EE_SIGNING_INPUT_MAX_BYTES` of 4,096 — unsignable, on a node that had done nothing worse than
rotate its identity the permitted number of times. That is the defect §7.2.1 removes. The
headroom left inside `E2EE_CAPABILITY_TRANSCRIPT_MAX_BYTES` is 560 bytes against this upper
bound, and 640 bytes against the largest transcript the version-1 registries can actually
produce — the 80-byte difference is the deliberate over-charge described above; §16.3 F3 pins the exact
figures above so that adding an element to §7.6 breaks a fixture rather than a deployment. An
earlier revision of this note carried a fixed-element figure that no breakdown reproduced and a
chain of totals derived from it; the per-element derivation above exists so that the one number
S6 rests on cannot again be an assertion.

_Note (non-normative)_: the relay's own default asserts `maxDataChunkBytes =
RELAY_MAX_DATA_CHUNK_BYTES`, far above `E2EE_ADVERTISEMENT_MIN_CHUNK_BYTES`, so U1 does not fire
against a cooperating relay (verified against `packages/contracts/src/relay.ts:183-225`,
2026-07-30). U1 exists because the schema also admits `RELAY_MIN_DATA_CHUNK_BYTES`, not because
the deployed value is close to the floor.

### 5.6 Compatibility cases (normative)

The carrier's legacy safety is not an assumption; it is a set of testable invariants against the
current legacy receive paths. Cases C1–C6 are normative compatibility requirements, and the §16
fixture corpus MUST include a vector family demonstrating each outcome against the pinned
implementations. All verification citations are as of 2026-07-30.

**Version binding and re-verification.** C1–C6 are claims about the behavior of a third-party RPC
client implementation that this protocol does not control. They are verified against, and
normatively scoped to, the RPC client pinned by the workspace catalog at the time of writing —
`effect@4.0.0-beta.106` as patched by `patches/effect@4.0.0-beta.106.patch`. The scope is not
cosmetic: the relevant routing internals have already changed once inside this repository's own
dependency history. Before `effect@4.0.0-beta.45`, `RpcClient.makeProtocolSocket` had no
multi-client fan-out and performed no `requestId` lookup, forwarding every decoded response
unconditionally; the broadcast path C2 names did not exist. That change arrived in an ordinary
beta bump. Accordingly:

- Changing the pinned `effect` version — including a patch-level beta bump, and including a
  change to `patches/effect@<version>.patch` that touches `dist/unstable/rpc/RpcClient.js` — MUST
  re-run the §16 C1–C6 vector family against the new build before the pin lands. A bump that
  cannot satisfy C1–C6 is a protocol-breaking change and MUST NOT be taken as an incidental
  dependency update.
- The §16 corpus, not this prose, is the normative enforcement point for C1–C6. Each case MUST
  have a vector that fails if the behavior regresses.
- The load-bearing properties a conforming legacy client path MUST exhibit, stated independently
  of any one implementation's internals, are: (i) a decoded response bearing an unrecognized
  `_tag` and no `requestId` reaches the response dispatcher without being treated as a transport
  error; (ii) the dispatcher's unmatched-tag branch performs no method invocation, no reply, no
  request-state mutation, and no session failure; (iii) a payload the deserializer rejects
  produces a client protocol error delivered to in-flight requests and does not close the
  transport; and (iv) no path in the chain emits a reply in response to an unrecognized tag. A
  build that violates any of (i)–(iv) is outside this protocol's compatibility envelope and MUST
  be treated as such, whatever its version number.

_Note (non-normative)._ The population these cases must survive is narrower than it appears. The
relay contract, the client relay engine, and the chunking module all postdate the current pin, so
no build carrying an earlier RPC client contains relay client code at all and none can open a
channel to meet the carrier. The properties above are nonetheless stated implementation-
independently, because that coincidence is a property of today's history rather than a guarantee
about future builds.

**C1 — client chunk-assembler pass-through.** The carrier payload, with and without the
prelude, presented to the current client reassembly path MUST yield a completed message whose
bytes equal the carrier JSON (prelude stripped when present), with no reassembly error; when the
prelude is present the peer chunk-support latch is set exactly as for any other message. The
carrier can never enter the chunk parser because its first byte is `{`, not
`RELAY_CHUNK_MAGIC`. (Verified against `packages/shared/src/relayMessageChunks.ts:197-207` and
`packages/client-runtime/src/relay/relayEngine.ts:364-388`.)

**C2 — protocol-socket routing.** The decoded carrier object MUST be routed to the client
protocol's broadcast path: its tag is not the keepalive response tag and it has no `requestId`
member, so no request-entry lookup occurs and no reply is generated. (Normatively scoped to the
pinned `effect@4.0.0-beta.106` RPC client as patched by `patches/effect@4.0.0-beta.106.patch`;
verified against its `makeProtocolSocket` response routing, 2026-08-10. Re-verification is
required on any pin change per the version-binding rule above.)

**C3 — client dispatcher ignore.** The carrier's tag matches no known response tag, so the RPC
client's response dispatcher MUST take its default branch: no method invocation, no reply, no
request-state mutation, no session failure. (Normatively scoped as for C2; verified against the
same pinned RPC client's run dispatcher default branch, 2026-07-30.)

**C4 — client-runtime wrapper pass-through.** The client-runtime connection wrapper inspects
only protocol-error and defect tags; the carrier MUST pass through without failing in-flight
requests or the connection. (Verified against
`packages/client-runtime/src/rpc/protocol.ts:247-265`.)

**C5 — node-direction hazard (prohibited direction).** The same JSON sent client-to-node is
**not** silent: the node's RPC server replies with a defect ("unknown request tag"), and a
legacy client receiving a defect fails all in-flight requests. The carrier direction is
therefore node-to-client only, and a client MUST NOT emit the carrier or any unknown-tag JSON
toward a node. The corresponding fixture demonstrates the defect reply that makes this
direction unsafe. (Verified against `apps/server/src/ws/RpcByteSession.ts:31` and the pinned
RPC server's encoded-loop default branch.)

**C6 — prelude whitespace tolerance.** A JSON parser consuming the unstripped payload
(`RELAY_CHUNK_CAPABILITY_PRELUDE ‖ carrier`) MUST yield the identical object, because the
prelude consists solely of JSON-permitted whitespace bytes. Clients that predate chunk
reassembly therefore also ignore the carrier. (Verified against
`packages/shared/src/relayMessageChunks.ts:23-30`.)

An analyzed alternative bidirectional carrier shape exists but is **not** part of this protocol;
it is recorded, non-normatively, in Appendix A.

### 5.7 Freshness, replay, and rollback resistance

**Statement freshness.** A verifier MUST reject a statement whose validity interval exceeds
`E2EE_CAPABILITY_STATEMENT_VALIDITY`, whose issued-at is in the future, or whose expires-at is
in the past, each evaluated against the verifier's clock with at most `E2EE_MAX_CLOCK_SKEW`
allowance.

**Replay.** Replaying an expired, wrong-origin, wrong-identity, superseded-policy
(lower-generation), or wrong-prekey statement MUST fail validation. Client handling of an
invalid statement is rows K2/K3 of §4.4: fatal when the channel's selection is latched
(§12.1.1), treated as absent evidence when it is not — never a trigger for sending a hello.
Treating it as absent evidence does not make the channel legacy by default: the `T_ADV` rows
K13/K14/K24 then classify the selection.

**Policy generation (node side).** The node increments the policy generation whenever any
advertised admission policy, suite registry entry, prekey, or rotation state changes. The
generation MUST be strictly increasing and MUST never silently reset; unlike the §7.5 rotation
generation it MAY advance by more than 1, which is what makes the recovery command below
well-defined. The advertised value is durable node-side security state and MUST be updated
crash-atomically.

**Policy-generation high-water anchor (node side).** "Refuse to advertise a lower generation
than it has ever advertised" is only implementable against a record the restore cannot roll
back, so this specification requires one. The node MUST maintain a durable **policy-generation
high-water mark** that is (a) updated crash-atomically before the corresponding generation is
first advertised, and (b) held outside the operator-restorable state and configuration set — so
that restoring that set cannot lower it. On startup the node MUST cross-check the advertised
generation against the high-water mark, mirroring the §7.5 chain cross-check. If the advertised
generation is lower than the mark, the node MUST treat this as a hard startup condition: it MUST
NOT advertise, MUST NOT reuse the lower value, and MUST surface the §5.7 recovery command below.
§7.5's "durable generation high-water mark" for the rotation generation is subject to the same
two properties.

_Note (non-normative)_: no store with both properties exists in the node today. The protected
secret store is create-only (`get` / `create` / `remove`, `create` conflicting on an existing
name), so it cannot hold a monotonically updated value without a non-atomic remove-then-create
window; and both the identity state file and the permissioned-file secret root live under the
server state directory, which is exactly what an operator restore replaces (verified against
`apps/server/src/hubIdentity/ProtectedSecretStore.ts`,
`apps/server/src/hubIdentity/LocalHubIdentityState.ts`, and `apps/server/src/config.ts`,
2026-07-30). As with the §6.3 mobile storage class, the requirement above is a new, explicit
obligation on the implementation, not a description of current behavior.

**Recovery (node side).** A node whose advertised generation is below its high-water mark
recovers through one explicit node CLI command that durably advances the policy generation to a
value strictly greater than any value the node may previously have advertised, updating the
high-water mark first and the advertised value second. The command MUST warn the operator that
clients accept only a strictly higher value and that the jump is deliberate. Authenticated
identity rotation is **not** a recovery path: §13.3 carries the client's remembered generation
across a valid-chain rotation, so a rotated-but-restored node is still rejected.

**Rollback resistance (client side).**

- **Native** persists the highest accepted policy generation in the pin record (§13.1), in the
  same device-only, non-synchronizing, non-backup storage class as the agreement key (§6, §13),
  and MUST reject any statement from that identity carrying a lower generation.
- **Web** remembers the highest accepted generation in memory for the application-session
  lifetime only, set on the first statement it validates for a node in that session — the same
  scope and the same best-effort threat bound as the web latch (§12.1). Web therefore has **no
  cross-session rollback resistance**, and its downgrade resistance is bounded exactly as
  §12.1 and §2.3 state; §2.3's disclosure requirement applies to both.
- **Wire behavior is unchanged and undistinguished.** A regressed generation is an invalid
  statement: rows K2/K3 of §4.4, §11.2 P15 when the selection is latched. It MUST NOT
  auto-launch the §13.2 ceremony or the §13.3 re-verification UI — a Hub can replay a genuine
  older statement inside `E2EE_CAPABILITY_STATEMENT_VALIDITY`, and an on-demand identity prompt
  is exactly the click-through training §13.3 exists to prevent. The client MUST instead record
  the local diagnostic `e2ee_policy_generation_regressed` (§11.4), which is local-only and never
  wire-visible. A client that surfaces anything automatically SHOULD require the regression to
  persist across statements with distinct issued-at values rather than acting on one statement.
- **Recovery (client side)** is the owner-initiated re-pair action of §13.3, which clears the
  pin, the latch, and the remembered generation together and re-enters §13.2.

**First contact.** A statement that chains to a verified pin authenticates the node's current
identity key. On first contact the statement proves only self-consistency of the carried key;
trust establishment is exclusively the pairing ceremony of §13.

## 6. Key hierarchy and custody

### 6.1 Identity keys (existing, sign-only, unchanged)

This protocol adds no identity key and changes no identity-key algorithm:

- **Node**: the durable Ed25519 node identity keypair defined by the node identity primitives
  ([node-identity.md](./node-identity.md)). It remains **sign-only**: within this protocol it
  signs the node agreement-prekey certificate (§7.3), the capability statement — through the
  fixed-size §7.2.1 signing envelope of the §7.6 transcript — and, as the outgoing key at
  rotation time, the identity-continuity certificate (§7.5), in every case only through the named
  encoders of §7 and never over more than `E2EE_SIGNING_INPUT_MAX_BYTES` bytes (§7.2). It is
  never used for key agreement.
- **Native client**: the hardware-backed P-256 device key (Secure Enclave / StrongBox; ECDSA,
  sign-only). Within this protocol it signs exactly one new structure, the client
  agreement-prekey certificate (§7.4), only through its named encoder.
- **Web**: no client identity key exists, by design (§1.3, §2.4).

`"ed25519"` is the only node identity algorithm this protocol version accepts in any E2EE
certificate or statement; `"p256"` node identities remain reserved (§7.1). The client identity
algorithm is `"p256"` only.

_Note (non-normative)_: the node signing interface exposes generate/sign/delete over named
secrets and signs caller-supplied bytes without internal domain separation (verified against
`apps/server/src/hubIdentity/NodeSigningIdentity.ts:38-43`, 2026-07-30) — and hard-rejects any
input longer than 4,096 bytes with `node_signing_failed` (`:128-135`, verified 2026-07-30), which
is the constraint `E2EE_SIGNING_INPUT_MAX_BYTES` names and §7.2 enforces; the mobile device-key
module exposes only ensureKey/sign/hasKey/deleteKey over a hardware P-256 key (verified against
`apps/mobile/modules/ryco-device-key/index.ts:13-33`, 2026-07-30). §7.2 turns that into a
normative signing discipline.

### 6.2 Static agreement keys and cross-signatures

Key agreement uses X25519 agreement keys that are distinct from the identity keys. The identity
key never performs key agreement, and an agreement key never signs; this key-separation rule is
absolute.

- **Node**: one active static X25519 keypair — the **node agreement prekey** — cross-signed by
  the node identity key through `encodeNodeE2eePrekeyTranscript` (§7.3). It is the Noise
  responder static `s` in both the IK and NX patterns (§8).
- **Native client**: one static X25519 keypair per device, cross-signed by the device key
  through `encodeClientE2eePrekeyTranscript` (§7.4). It is the Noise initiator static `s` in IK.
- **Web**: **no static agreement key exists.** The NX pattern gives the initiator no static; the
  web tier's only asymmetric material is the per-handshake Noise ephemeral. Every reference to
  "the web ephemeral" in this document means that per-handshake key.
- **Ephemerals**: each handshake uses fresh ephemeral X25519 keypairs generated from the
  platform CSPRNG; ephemeral private keys MUST be erased when the Noise `Split()` completes
  (§8), on any handshake failure, and on channel close.

Raw agreement public keys appear only where proof verification requires them: the endpoint key
stores of §6.3, the certificates and statements of §7, and Noise handshake messages. Every
other surface — records, pins, client-authorization records, instrumentation, display, logs —
uses the fingerprints of §7.1.

### 6.3 Custody by endpoint

| Endpoint      | Private-key home                                                                                                                                           | Properties                                                                                                                                                                                                                                                                                       |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Node          | A new named secret in the node's protected secret store, in the same store class and under the same create-only naming discipline as the node identity key | Durable; loaded transiently for use and zeroized after each use; staged rotation per §6.4                                                                                                                                                                                                        |
| Native client | Platform secure store (`expo-secure-store`) entry                                                                                                          | Durable; **device-only, non-synchronizing, excluded from backup, restore, and device-transfer on both platforms**; the iOS keychain item MUST use a this-device-only accessibility class and MUST NOT be synchronized; the Android entry MUST be excluded from every backup and transfer surface |
| Web           | Process memory only                                                                                                                                        | Ephemeral per application session; MUST NOT touch `localStorage`, `sessionStorage`, IndexedDB, service-worker caches, URL or history state, configuration exports, or logs — the hosted-client no-durable-secrets policy ([hosted-hub-client.md](./hosted-hub-client.md)) applies verbatim       |

**Clone and restore prohibition (native).** Restoring or cloning a signed mobile agreement
private key onto another device is forbidden even while its cross-signature remains unexpired.
An implementation that detects it is holding restored or transferred agreement-key material
MUST NOT use it, MUST destroy it, and MUST require re-pairing (§13). The storage class above
exists to make such material unavailable to backup and transfer surfaces in the first place.

_Note (non-normative)_: the protected secret store's three backends and create-only semantics
are defined in `apps/server/src/hubIdentity/ProtectedSecretStore.ts` (verified 2026-07-30). The
current mobile secure-store wrapper passes no options and therefore inherits library defaults
(verified against `apps/mobile/src/platform/secretKv.ts:29-44`, 2026-07-30); the storage class
required above is a new, explicit requirement for the E2EE agreement key, not a description of
current default behavior.

### 6.4 Prekey lifetime, rotation, and expiry

- **Lifetime.** `expiresAt − createdAt` of an agreement-prekey certificate MUST NOT exceed
  `E2EE_PREKEY_LIFETIME`; issuers SHOULD use exactly that lifetime.
- **Expiry is evaluated at handshake time only**, against the verifier's clock with at most
  `E2EE_MAX_CLOCK_SKEW` allowance: by the client when validating the capability statement and
  building `E2EEClientHello` (§5.2, §8), and by the node when validating the client certificate
  in the IK payload (§8.6). An **established channel is never affected** by prekey rotation or
  expiry for its lifetime; no expiry timer runs against open channels.
- **Expired prekey is a hard failure** with its own error: the verifier fails the validation
  with the local diagnostic error `e2ee_prekey_expired`. The wire behavior remains the generic
  surface of §11 — on the node, FATAL-PRE; on the client, rows K2/K3 of §4.4 (an expired
  statement is invalid evidence). The named error is a local diagnostic and API code, never a
  distinct wire signal.
- **Node remedy.** The node MUST validate its own prekey certificate at startup and re-sign a
  fresh certificate when it is expired or would expire within `E2EE_PREKEY_ROTATION_OVERLAP`.
  The node CLI MUST provide a command that forces an immediate prekey rotation (new keypair and
  certificate). The client remedy for an expired client certificate is the same re-sign at
  application start.
- **Staged rotation (node)**, mirroring the identity-key staging discipline: the replacement
  keypair is created under a new named secret first; the new certificate is signed and durably
  referenced before it is advertised; the outgoing agreement private key is retained for
  `E2EE_PREKEY_ROTATION_OVERLAP` after the new certificate activates, then destroyed. During
  the overlap both the outgoing and incoming certificates verify (each within its own validity
  window), and the responder MUST complete a handshake against the prekey it advertised **on
  that channel** (§5.1 pins negotiation and handshake to the advertising channel, so the
  responder always knows which prekey a hello targets). A crash at any point leaves either the
  old state or the new state fully intact, never a torn mixture.

_Note (non-normative)_: the staged create-new-secret-first, promote, then delete-old pattern
mirrors `apps/server/src/hubIdentity/HubKeyRotationClient.ts:229-288` (verified 2026-07-30).

### 6.5 Session keys

E2EE session state is **per channel, destroyed on close, and never resumed**. There is no
session ticket, no resumption secret, no 0-RTT, and no cross-channel key derivation; every
reconnect (new ticket, new channel) runs a fresh handshake (§4.4, §8).

The completed Noise state exposes exactly three values — this is the supported exporter/Split
API this protocol defines, and an implementation MUST NOT extract or reuse anything else from
the handshake state:

```text
(k_c2n, k_n2c)  = Noise Split() outputs, in Noise order (initiator-to-responder first;
                  the client is always the initiator, §8.1)
epochSecret_c2n[0] = k_c2n
epochSecret_n2c[0] = k_n2c
exporterSecret     = HKDF-Expand(ck_final, "ryco.relay-e2ee.exporter.v1", E2EE_SECRET_BYTES)
```

where `ck_final` is the final Noise chaining key at the moment `Split()` is invoked. The two
`Split()` outputs are consumed only as the directional epoch-0 secrets of §9; the Noise cipher
states themselves MUST NOT be used for transport. `exporterSecret` feeds only
`serverConfirmationKey` (§8.7). After these three values are extracted, the entire Noise
handshake state — ephemeral private keys, chaining key, handshake hash, cipher states — MUST be
erased.

On channel close (clean, unclean, or fatal), every session secret — epoch secrets, AEAD keys,
`exporterSecret`, `serverConfirmationKey`, and any buffered plaintext — MUST be erased (§9.5).

## 7. Certificates and transcripts

### 7.1 Encoding conventions, fingerprints, and key material validation

**Transcript form.** Every transcript in this protocol is a canonical-CBOR (§3.6)
definite-length array whose first element is the domain string (§3.5), matching the existing
node-identity transcript convention. Field types are restricted to text strings, unsigned
integers within the IEEE-754 safe-integer range, byte strings, booleans, and nested
definite-length arrays of the same types. Timestamps are unsigned integers in epoch
milliseconds. Signatures always cover the exact transcript bytes; verifiers MUST apply the §3.6
re-encode equality rule before acting on any decoded transcript.

_Note (non-normative)_: the existing encoders emit exactly this shape — a flat definite-length
CBOR array with the domain string first, encoded with the pinned codec's RFC 8949 options
(verified against `packages/shared/src/nodeIdentity.ts:146-205`, 2026-07-30).

**Identifier formats** (transcript-side, exact):

| Identifier           | Format                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node id              | `node_` plus exactly 22 Base64URL characters                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Node identity key id | `nkey_` plus exactly 22 Base64URL characters                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Node prekey id       | `epk_` plus exactly 22 Base64URL characters                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Continuity id        | `nct_` plus exactly 22 Base64URL characters                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Account id           | Nonempty UTF-8 text, at most `E2EE_ACCOUNT_ID_MAX_BYTES` bytes, treated as opaque; the empty string is not a valid identifier and is reserved for the absence semantics of §8.3. **Provenance: Hub-issued and not client-anchored** — the client never verifies it against anything and the Hub may present a different value at any time, so no downgrade guard may rest on it alone (§12.1.1)                                                                                                                                                                                                                                                                     |
| Hub origin           | The canonical Hub origin as defined by the node identity primitives (scheme-validated, exactly equal to the URL origin, bounded), **and additionally at most `E2EE_HUB_ORIGIN_MAX_BYTES` bytes in every E2EE transcript**. The E2EE bound is deliberately tighter than the primitives' own, because the origin appears once per §7.6 statement and once per carried §7.5 certificate — up to `E2EE_CONTINUITY_CHAIN_MAX_LENGTH + 1` occurrences — and is therefore the dominant term in §3.2.1 S8. A node whose canonical Hub origin exceeds it cannot serve E2EE and MUST fail the §7.6.1 self-check rather than emit a shorter or elided origin (§5.5 U2, §17.13) |

**Fingerprints.** A key fingerprint is:

```text
fingerprint(domain, algorithm, publicKey) =
  SHA-256(canonical-CBOR([ domain, algorithm, bstr(publicKey) ]))
```

producing `E2EE_KEY_FINGERPRINT_BYTES` bytes. The domains and algorithm labels are:

| Domain                       | Key family                                                 | Algorithm label |
| ---------------------------- | ---------------------------------------------------------- | --------------- |
| `ryco.node-key.v1`           | Node identity keys (existing definition, reused unchanged) | `"ed25519"`     |
| `ryco.client-key.v1`         | Client identity keys                                       | `"p256"`        |
| `ryco.e2ee-agreement-key.v1` | X25519 agreement keys (node and client)                    | `"x25519"`      |

The display form is the literal prefix `SHA256:` followed by the unpadded base64url encoding of
the digest, which is ⌈4 · `E2EE_KEY_FINGERPRINT_BYTES` / 3⌉ characters — derived, not chosen, and
stated here as the derivation so no second definition of the length exists (§3.2).
Fingerprints travel in transcripts as raw digest byte strings, never
in display form. A verifier MUST recompute every fingerprint it consumes from the
algorithm-labelled raw public key and reject disagreement; a fingerprint is never accepted on
the carrier's authority alone (§5.2).

_Note (non-normative)_: construction and display form match `fingerprintNodePublicKey` and
`formatNodePublicKeyFingerprint` (verified against `packages/shared/src/nodeIdentity.ts:132-144`,
2026-07-30).

**Key and signature wire encodings and validation** (normative for every E2EE structure):

| Material              | Encoding                                                                          | Mandatory validation                                                                                                                                                                                                                                                                                                                                                       |
| --------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ed25519 public key    | `ED25519_PUBLIC_KEY_BYTES` raw bytes                                              | Exact length; strict RFC 8032 decoding                                                                                                                                                                                                                                                                                                                                     |
| Ed25519 signature     | `ED25519_SIGNATURE_BYTES` raw bytes                                               | **Strict RFC 8032 verification**: canonical point and scalar encodings only, non-canonical values rejected; permissive (ZIP215-style) acceptance is forbidden. Signatures are PureEdDSA over the exact bytes emitted by the applicable named encoder (§7.2): the transcript itself for §7.3 and §7.5, and the fixed-size §7.2.1 envelope for the §7.6 capability statement |
| P-256 public key      | `P256_PUBLIC_KEY_BYTES` bytes, X9.63 uncompressed `0x04 ‖ X ‖ Y`                  | First byte `0x04`; coordinates below the field prime; point on the curve; not the identity                                                                                                                                                                                                                                                                                 |
| P-256 ECDSA signature | `P256_SIGNATURE_BYTES` bytes, fixed-width raw `r ‖ s`, each coordinate big-endian | `1 ≤ r, s ≤ n − 1`; ASN.1/DER encodings rejected on the wire. The signature is ECDSA over SHA-256 of the exact transcript bytes. Either `s` value is accepted; the protocol derives no uniqueness from signature bytes                                                                                                                                                     |
| X25519 public key     | `E2EE_AGREEMENT_PUBLIC_KEY_BYTES` raw bytes                                       | Exact length. No point validation exists for X25519; the **single mandated behavior** for invalid or low-order inputs is defined in §8.6: any X25519 operation whose shared-secret output is all zeros MUST abort the handshake. Public-key equality comparisons are byte-wise on the transmitted encoding                                                                 |

A node certificate or statement declaring any node identity algorithm other than `"ed25519"`,
or a client certificate declaring any client identity algorithm other than `"p256"`, MUST be
rejected in protocol version 1.

_Note (non-normative)_: hardware signers return ASN.1 DER ECDSA signatures; the mobile platform
already converts DER to fixed-width raw `r ‖ s` before any wire use (verified against
`apps/mobile/src/platform/ecdsa.ts:96-129` and `apps/mobile/src/platform/deviceKey.ts:66-70`,
2026-07-30).

### 7.2 The no-ad-hoc-transcript rule

**No consumer of the node identity signing interface or of the mobile device key may construct
to-be-signed bytes ad hoc.** Every signature these keys produce under this protocol MUST cover
bytes emitted by exactly one of the named encoders — `encodeNodeE2eePrekeyTranscript`,
`encodeClientE2eePrekeyTranscript`, `encodeNodeIdentityContinuityTranscript`,
`encodeNodeE2eeCapabilityTranscript`, `encodeNodeE2eeCapabilitySigningEnvelope` — or by the
pre-existing node-identity encoders. The encoders live beside the existing node-identity encoders
in `packages/shared/src/nodeIdentity.ts` (module home, §1.1).

**Signing-input bound (normative).** The node identity signing interface rejects any input
outside 1..`E2EE_SIGNING_INPUT_MAX_BYTES` bytes. A structure this protocol requires to be signed
but that the interface refuses is not a runtime error to be discovered in the field: it means the
node cannot produce its own advertisement, and under effective `requireE2EE` it means the node
has locked itself out. The relationship is therefore fixed here rather than left implicit:

- Every value handed to the node identity signing interface under this protocol MUST be at most
  `E2EE_SIGNING_INPUT_MAX_BYTES` bytes, and this MUST be checked before the call, not inferred
  from its success.
- The §7.3, §7.4, and §7.5 transcripts are of bounded, non-growing shape and are signed
  **directly**. Each MUST be at most `E2EE_DIRECT_SIGNING_TRANSCRIPT_MAX_BYTES` bytes (§3.2.1 S2,
  S9); an encoder producing more is a defect, not an oversized input to be handled.
- The §7.6 capability transcript is the only structure in this protocol whose signed length
  grows with carried data — one continuity certificate per rotation, each repeating the Hub
  origin — so it is **never** signed directly. It is signed through the fixed-size envelope of
  §7.2.1 (§3.2.1 S1, S3), whose length is independent of the transcript.

This is a size rule, not a relaxation of the rule above it. The envelope is itself a named
encoder's output carrying its own distinct domain, so no ad-hoc bytes, and no attacker-influenced
byte string, reach the key on either path.

Rationale (normative motivation): the node signing interface signs arbitrary caller-supplied
bytes with no internal domain separation, and the deployment already routes externally
influenced bytes — the relay authentication challenge — to that key. An ad-hoc concatenation
would hand an attacker-influenced signing oracle over attacker-chosen agreement keys. Domain
separation therefore lives entirely in the encoders: every signed structure begins with a
distinct domain string (§3.5), and the E2EE domains are disjoint from the node-identity domains.

_Note (non-normative)_: the mobile device key's only pre-existing signatures are DPoP JWS
signing inputs, which are ASCII (base64url segments joined by `.`); a canonical-CBOR transcript
begins with an array-header byte of `0x80` or above, so the two signed-byte families cannot
collide (verified against `packages/client-runtime/src/relay/dpop.ts:116`, 2026-07-30). The
node signing interface's 1..4,096-byte input contract lives at
`apps/server/src/hubIdentity/NodeSigningIdentity.ts:128-135`, which returns
`node_signing_failed` for anything longer (verified 2026-07-30);
`E2EE_SIGNING_INPUT_MAX_BYTES` restates that bound so this protocol's structures can be checked
against it without reaching into that module.

#### 7.2.1 Capability signing envelope

Encoder `encodeNodeE2eeCapabilitySigningEnvelope`, domain
`ryco.node-e2ee-capability-digest.v1`. The envelope is a canonical-CBOR array of exactly 2
elements:

| #   | Field              | Type  | Constraint                                                                 |
| --- | ------------------ | ----- | -------------------------------------------------------------------------- |
| 0   | domain             | text  | `"ryco.node-e2ee-capability-digest.v1"`                                    |
| 1   | `transcriptDigest` | bytes | `E2EE_TRANSCRIPT_DIGEST_BYTES`; SHA-256 of the exact §7.6 transcript bytes |

Both elements are fixed-width, so the encoded envelope is exactly
`E2EE_CAPABILITY_SIGNING_ENVELOPE_BYTES` bytes for every input, whatever the transcript's length
(§3.2.1 S3). The capability-statement signature (§7.6) is the node identity key's Ed25519
signature over these envelope bytes.

Normative rules:

- The envelope is **never transmitted**. It is reconstructed independently by the signer and by
  every verifier. A statement carrying a digest field, or any structure inviting a verifier to
  accept a digest it did not compute, is invalid.
- A verifier MUST recompute SHA-256 over the exact transcript bytes it received — after the §3.6
  re-encode equality check and after the `E2EE_CAPABILITY_TRANSCRIPT_MAX_BYTES` length check —
  rebuild the envelope with this encoder, and verify the signature over the rebuilt bytes.
- The signer MUST apply the same order: encode the transcript, check its length, digest it,
  encode the envelope, sign.

Two properties are preserved deliberately, and neither may be traded away by an implementation
that finds the extra hop inconvenient:

- **Domain separation.** The envelope carries its own domain (§3.5), disjoint from every other
  E2EE and node-identity domain, and like every other signed structure it begins with a
  canonical-CBOR array header followed by that domain string. A bare 32-byte digest is **not** an
  acceptable signing input under §7.2 and MUST NOT be signed: it carries no domain, and its first
  byte is unconstrained, which is exactly the ad-hoc signing-oracle shape §7.2 exists to forbid.
- **Binding strength.** A signature over the envelope binds the exact transcript bytes under the
  collision resistance of SHA-256 — the same assumption this protocol already makes for every key
  fingerprint (§7.1) and every commitment (§8, §10). Nothing about the statement's authentication
  is weakened; only the number of bytes the key sees changes.

_Note (non-normative)_: the envelope exists because the §7.6 transcript can legitimately exceed
`E2EE_SIGNING_INPUT_MAX_BYTES`. At every bound simultaneously the transcript is 4,560 bytes
(§5.5 worked example), so a node that had merely rotated its identity
`E2EE_CONTINUITY_CHAIN_MAX_LENGTH` times would otherwise be unable to sign its own
advertisement, deterministically and with no attacker involved. The alternative resolution —
shrinking the chain or the Hub origin until a direct signature fits — was rejected: it would
make effective chain depth, and therefore whether a §13.3 rotation is silent or raises a
re-verification prompt, depend on how long the operator's Hub origin happens to be.

### 7.3 Node agreement-prekey certificate

Encoder `encodeNodeE2eePrekeyTranscript`, domain `ryco.node-e2ee-prekey.v1`. The transcript is a
canonical-CBOR array of exactly 13 elements:

| #   | Field                 | Type  | Constraint                                                                |
| --- | --------------------- | ----- | ------------------------------------------------------------------------- |
| 0   | domain                | text  | `"ryco.node-e2ee-prekey.v1"`                                              |
| 1   | `hubOrigin`           | text  | Canonical Hub origin (§7.1)                                               |
| 2   | `nodeId`              | text  | Node id format (§7.1)                                                     |
| 3   | `identityAlgorithm`   | text  | `"ed25519"`                                                               |
| 4   | `identityKeyId`       | text  | The active node identity key id                                           |
| 5   | `prekeyId`            | text  | Node prekey id format (§7.1); fresh per certificate                       |
| 6   | `identityPublicKey`   | bytes | `ED25519_PUBLIC_KEY_BYTES`                                                |
| 7   | `identityFingerprint` | bytes | `E2EE_KEY_FINGERPRINT_BYTES`; `ryco.node-key.v1` fingerprint of element 6 |
| 8   | `agreementPublicKey`  | bytes | `E2EE_AGREEMENT_PUBLIC_KEY_BYTES`                                         |
| 9   | `noiseDh`             | text  | `"25519"`                                                                 |
| 10  | `noiseHash`           | text  | `"SHA256"`                                                                |
| 11  | `createdAt`           | uint  | Epoch milliseconds                                                        |
| 12  | `expiresAt`           | uint  | Epoch milliseconds; lifetime bound per §6.4                               |

The **cross-signature** is the node identity key's Ed25519 signature over the exact transcript
bytes. Elements 9 and 10 pin the key's Noise usage to the suite-registry functions (§3.4); a
certificate whose usage fields disagree with the negotiated suite MUST be rejected.

Verification: strict decode with re-encode equality; domain check; identifier-format checks;
`hubOrigin`, `nodeId`, `identityAlgorithm`, `identityKeyId`, `identityPublicKey`, and
`identityFingerprint` MUST equal the corresponding capability-statement fields (§7.6);
fingerprint recomputation for elements 7 and for the statement's advertised agreement-key
fingerprint (from element 8); validity window against the verifier's clock with
`E2EE_MAX_CLOCK_SKEW` (§6.4); signature verification under §7.1 rules.

### 7.4 Client agreement-prekey certificate

Encoder `encodeClientE2eePrekeyTranscript`, domain `ryco.client-e2ee-prekey.v1`. Signed by the
mobile device key. The transcript is a canonical-CBOR array of exactly 11 elements:

| #   | Field                 | Type  | Constraint                                                                  |
| --- | --------------------- | ----- | --------------------------------------------------------------------------- |
| 0   | domain                | text  | `"ryco.client-e2ee-prekey.v1"`                                              |
| 1   | `hubOrigin`           | text  | Canonical Hub origin — with element 2, the Hub/account namespace binding    |
| 2   | `accountId`           | text  | Account id format (§7.1); the account this key claims to act for            |
| 3   | `identityAlgorithm`   | text  | `"p256"`                                                                    |
| 4   | `identityPublicKey`   | bytes | `P256_PUBLIC_KEY_BYTES`, X9.63 uncompressed; point-validated (§7.1)         |
| 5   | `identityFingerprint` | bytes | `E2EE_KEY_FINGERPRINT_BYTES`; `ryco.client-key.v1` fingerprint of element 4 |
| 6   | `agreementPublicKey`  | bytes | `E2EE_AGREEMENT_PUBLIC_KEY_BYTES`                                           |
| 7   | `noiseDh`             | text  | `"25519"`                                                                   |
| 8   | `noiseHash`           | text  | `"SHA256"`                                                                  |
| 9   | `createdAt`           | uint  | Epoch milliseconds                                                          |
| 10  | `expiresAt`           | uint  | Epoch milliseconds; lifetime bound per §6.4                                 |

The signature is ECDSA P-256 over SHA-256 of the exact transcript bytes, in the fixed-width raw
encoding of §7.1. The certificate binds the client identity key, the client agreement key, and
the `(hubOrigin, accountId)` namespace into one signed statement: a node MUST reject a
certificate whose namespace does not exactly match the channel's Hub origin and the account
claim presented in the handshake (§8.6). The certificate travels only inside the encrypted IK
handshake payload (§8.5); it never appears in a clear wrapper.

### 7.5 Node identity-continuity certificate

Encoder `encodeNodeIdentityContinuityTranscript`, domain `ryco.node-identity-continuity.v1`.
Signed by the **outgoing** node identity key at rotation time, before that key is destroyed.
The transcript is a canonical-CBOR array of exactly 13 elements:

| #   | Field            | Type  | Constraint                                         |
| --- | ---------------- | ----- | -------------------------------------------------- |
| 0   | domain           | text  | `"ryco.node-identity-continuity.v1"`               |
| 1   | `hubOrigin`      | text  | Canonical Hub origin                               |
| 2   | `continuityId`   | text  | Continuity id format (§7.1); see semantics below   |
| 3   | `generation`     | uint  | Monotonic rotation generation; see semantics below |
| 4   | `oldAlgorithm`   | text  | `"ed25519"`                                        |
| 5   | `oldKeyId`       | text  | Outgoing identity key id                           |
| 6   | `oldPublicKey`   | bytes | `ED25519_PUBLIC_KEY_BYTES`                         |
| 7   | `oldFingerprint` | bytes | `ryco.node-key.v1` fingerprint of element 6        |
| 8   | `newAlgorithm`   | text  | `"ed25519"`                                        |
| 9   | `newKeyId`       | text  | Incoming identity key id                           |
| 10  | `newPublicKey`   | bytes | `ED25519_PUBLIC_KEY_BYTES`                         |
| 11  | `newFingerprint` | bytes | `ryco.node-key.v1` fingerprint of element 10       |
| 12  | `createdAt`      | uint  | Epoch milliseconds                                 |

The signature is the **outgoing** key's Ed25519 signature over the exact transcript bytes. The
carried form of one certificate is the canonical-CBOR array
`[ bstr(transcript), bstr(signature) ]`.

**Continuity id.** A stable node-local identifier generated randomly once, when the node
identity is first created, and durably retained across every rotation. It is never the
Hub-minted `nodeId`, is never derived from it, and never changes while the chain is unbroken. A
new continuity id appears only after a chain break followed by fresh owner verification (§13).
Node ids are Hub-assigned and reissuable at will; keying continuity to them would let the
operator manufacture identity-change events (§13).

The continuity id is carried in **every** capability statement as a required signed element
(§7.6 element 18), including from a node that has never rotated and therefore carries an empty
chain. Without it, a substituted node with a fresh self-signed identity presents as routine
first contact and the §13.3 path is unreachable in exactly the case it exists for.

**Storage lifecycle (continuity id).** Because §5.2 step 6 makes a differing continuity id
channel-fatal and routes it to the §13.3 re-verification UI, the value is durable node-local
security state of the same class as the chain, and it carries the same discipline. It is not
enough to say it is "durably retained": a node that loses it and mints a replacement pushes every
pinned client into a re-verification ceremony for an identity that never changed, and the
chain cross-check below cannot catch that for the node this requirement was added for — one that
has never rotated, whose chain is empty and whose rotation generation is 0, so there is nothing
for that check to compare. The rules are therefore:

- **Creation is crash-atomic and precedes advertisement.** The id is generated once, from the
  §14.5 CSPRNG, and both the stored value and the anchor below MUST be durably committed —
  anchor first — **before** the first statement carrying it is advertised. A crash at any point
  leaves either no continuity id and no advertisement, or the complete pair; never a value that
  was advertised but not retained.
- **A continuity-id anchor is REQUIRED.** The node MUST maintain a durable **continuity-id
  anchor** holding the continuity id it has advertised, satisfying the two properties §5.7 states
  for the policy-generation high-water mark: crash-atomic update, and residence outside the
  operator-restorable state and configuration set. The value is not a secret — it travels in
  cleartext in every statement the Hub relays — so the anchor buys integrity and existence, not
  confidentiality: it is what distinguishes "this node has never advertised" from "this node
  advertised and its stored copy was rolled back", a distinction nothing else in this document
  can make for a never-rotated node.
- **Retention.** The id is retained unchanged across every prekey rotation, every identity
  rotation, and every continuity-chain append or prune. Chain pruning never touches it; the
  bounded chain forgets old certificates, and the continuity id is precisely the part that must
  not be forgotten with them.
- **Startup cross-check (normative).** On startup, and before any advertisement, the node MUST
  compare its stored continuity id against the anchor and take exactly one of:
  - _anchor unset, stored value unset_ — the node has never advertised. Mint once, crash-atomically,
    per the creation rule above. This is also the migration rule for a node whose identity
    predates this protocol: mint once at upgrade, durably, before the first advertisement.
  - _anchor set, stored value equal_ — normal operation.
  - _anchor set, stored value absent_ — an operator restore rolled the stored copy back. The node
    MUST restore the stored copy **from the anchor**, crash-atomically, and MUST NOT mint. This
    is the benign case and it is deliberately silent on the wire: the node re-advertises the
    identical value, every pin still matches, and no client sees an identity event. The node MUST
    surface a node-local operator diagnostic recording the repair.
  - _anchor unset, stored value present_ — the anchor was lost, the value was not. Adopt the
    stored value into the anchor crash-atomically, then proceed. Minting is forbidden whenever a
    stored value exists.
  - _anchor set, stored value present and different, or the anchor unreadable_ — unresolvable:
    two values claim the node's lineage, or none can be proven. The node MUST NOT advertise, MUST
    NOT mint, MUST NOT choose between them, and MUST surface the recovery command below. This is
    §5.5 U2 (`statement-unavailable`): under effective `requireE2EE` every channel is FATAL-PRE
    (§11.2 P23) and the node fails startup; otherwise the advertisement is suppressed (row N16)
    and counted in the **advertisement-unavailable** class (§12.5).
- **Recovery is explicit and never silent.** A node in the unresolvable state recovers through
  one explicit node CLI command offering exactly two outcomes, both of which the operator must
  choose deliberately: re-adopt a specific continuity id the operator confirms, which restores
  every existing pin; or **deliberately break continuity**, which mints a fresh id under the same
  crash-atomic ordering. The second outcome is equivalent in effect to a deliberate chain break —
  every pinned client takes the §13.3 re-verification path and requires a fresh §13.2 ceremony —
  and the CLI MUST say exactly that at the point of use. No automatic path mints a replacement.
- **A deliberate change updates the anchor first.** When a break followed by fresh owner
  verification produces a new continuity id, the anchor MUST be updated crash-atomically before
  the first statement carrying the new value is advertised, in the same commit that records the
  break.

**The continuity id is an anchor, not a proof.** It travels in cleartext in every statement the
Hub relays, so an adversary can mint a fresh one or copy a genuine one onto a substitute key. A
matching continuity id therefore MUST NOT, on its own, re-anchor a pin, promote a pin state, set
the latch, satisfy the §12.1 set condition, or relax any guard. Its only sanctioned effects are
classification, presentation, and mutual agreement: resolving a channel to an existing pin so
that a fingerprint change is handled as §13.3 identity change rather than as a new node;
tightening — never loosening — the §12.1.1 guards; and entering the §8.3 authorization context as
element 17, so that the two endpoints must agree on which lineage the channel belongs to. That
last effect detects disagreement and nothing more: agreement in the context block is not evidence
of identity, and element 17 relaxes no guard and anchors no pin.

**Generation.** Starts at 1 for the first rotation and increments by exactly 1 per rotation. A
node MUST NOT issue two certificates with the same generation, MUST NOT skip generations, and
MUST NOT issue a certificate when it cannot determine the previous generation (fail closed —
the resulting break requires fresh owner verification, never a synthesized link).

**Chain rules.** The node durably retains a bounded ordered chain of at most
`E2EE_CONTINUITY_CHAIN_MAX_LENGTH` certificates and carries it in the capability statement
(§5.2, §7.6). Within the carried chain: generations MUST be consecutive and strictly
increasing; each certificate's `oldPublicKey`/`oldFingerprint` MUST equal the previous
certificate's `newPublicKey`/`newFingerprint`; every entry's `continuityId` MUST equal the
statement-level `continuityId` (§7.6 element 18), which subsumes the requirement that the
entries agree with each other; `hubOrigin` MUST be identical across all entries; and the final
certificate's new key MUST equal the statement's current identity key. A verifier with a pinned
fingerprint accepts the current identity key only by
walking the chain from the certificate whose `oldFingerprint` equals the pin to the final
entry, verifying every signature under that entry's old key and every fingerprint by
recomputation. A pinned client whose pin verifies the complete chain updates its pin
**silently** — no re-verification prompt, subject to the custody caveat in §13.3. A missing,
spliced, reordered, truncated, or signature-invalid chain, a generation regression, a
`continuityId` disagreeing with the statement or with the pinned value, or a chain that does not
reach the pin is **channel-fatal** and surfaces the re-verification UI (§13).

**Storage lifecycle (node side).** The chain is durable node-local security state. Updates MUST
be crash-atomic: a certificate is written and durably synced before the rotation that it
describes completes, and a crash at any point leaves either the pre-rotation or post-rotation
state observable, never a torn mixture. Retention keeps the most recent
`E2EE_CONTINUITY_CHAIN_MAX_LENGTH` certificates; pruning removes only the oldest entries and
only when appending beyond the bound. Pruned history is gone: a client whose pin predates the
retained chain cannot silently re-anchor and MUST go through re-verification (§13).

**Advertised-chain retention (normative).** §8.3 builds authorization-context element 15 from the
continuity chain the node advertised **on that channel**, so the node MUST retain that chain
snapshot — the exact ordered certificate transcript bytes, or a digest list sufficient to rebuild
element 15 byte for byte — from advertisement emit until the channel closes, and MUST use it,
rather than its current chain, when it reconstructs the context at §8.6 step 7. The same rule
covers the identity and continuity-id material of elements 7–9 and 17. Without it a rotation or
prune landing inside the `T_ADV + T_TRUST_COMMIT + T_HANDSHAKE` window (and, on the node side, inside
`T_HANDSHAKE_NODE`) would make the node rebuild a context the client could not have built,
failing an honest handshake as `P13` with no diagnostic separating it from a real cross-account
splice, and leaving two conforming nodes disagreeing on the same trace. Retention is bounded and
adds no durable state: at most one snapshot per open channel, at most
`E2EE_CONTINUITY_CHAIN_MAX_LENGTH` entries each, released when the channel closes (§15). It does
not delay or alter the rotation itself — §7.6.1 regenerates the statement immediately, and the new
chain reaches every channel advertised on after that point.

**Backup rollback fails closed.** On startup the node MUST cross-check its current identity key
against the newest retained certificate. If restored state rolls the chain back — the newest
certificate's new key is not the current identity key, or a durable generation high-water mark
exceeds the newest retained generation — the node MUST NOT reuse or re-issue generations, MUST
NOT synthesize the missing links, and MUST treat the chain as broken. The rotation-generation
high-water mark used here MUST satisfy the two anchor properties §5.7 states for the
policy-generation high-water mark: crash-atomic update, and residence outside the
operator-restorable state and configuration set.

The continuity-id cross-check above runs in the same startup pass and against an anchor with the
same two properties, and it is **not** subsumed by this one: a rollback that leaves the chain and
the identity key entirely consistent — the ordinary case for a node that has never rotated — is
invisible to this check and is caught only there. The three node-side rollback paths and their
different client-visible outcomes are enumerated together in §17.11.

**Recovery and legacy breaks are never synthesized.** Administrative lost-key recovery,
**rotation motivated by compromise or suspected compromise of the outgoing identity key**, and
any rotation performed by a mechanism that did not issue a continuity certificate deliberately
break the chain. A broken chain requires fresh owner verification (§13). Neither the node nor
any other party may fabricate, backdate, or accept a substitute for a missing link. A
compromise rotation MUST NOT be executed as a continuity rotation: the chain authenticates a
rotation only while the outgoing identity private key was under exclusive honest custody
(§13.3), so a continuity certificate signed by a key an adversary also holds proves nothing.
The node CLI rotation command MUST make this distinction explicit at the point of use and MUST
require the operator to choose between a continuity rotation and a deliberate break.

### 7.6 Capability statement transcript

Encoder `encodeNodeE2eeCapabilityTranscript`, domain `ryco.node-e2ee-capability.v1`. This fixes
the byte-level encoding of the §5.2 statement. The transcript is a canonical-CBOR array of
exactly 19 elements:

| #   | Field                       | Type          | Constraint                                                                                                                                                                         |
| --- | --------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0   | domain                      | text          | `"ryco.node-e2ee-capability.v1"`                                                                                                                                                   |
| 1   | `hubOrigin`                 | text          | Canonical Hub origin; at most `E2EE_HUB_ORIGIN_MAX_BYTES` (§7.1)                                                                                                                   |
| 2   | `nodeId`                    | text          | Node id format                                                                                                                                                                     |
| 3   | `identityAlgorithm`         | text          | `"ed25519"`                                                                                                                                                                        |
| 4   | `identityKeyId`             | text          | Active identity key id                                                                                                                                                             |
| 5   | `identityPublicKey`         | bytes         | `ED25519_PUBLIC_KEY_BYTES`                                                                                                                                                         |
| 6   | `identityFingerprint`       | bytes         | `ryco.node-key.v1` fingerprint of element 5                                                                                                                                        |
| 7   | `e2eeVersionMin`            | uint          | Minimum supported E2EE protocol version                                                                                                                                            |
| 8   | `e2eeVersionMax`            | uint          | Maximum supported E2EE protocol version; `min ≤ max`, and the range MUST contain every version the node will accept at §8.6 step 2 — in version 1, exactly `E2EE_PROTOCOL_VERSION` |
| 9   | `suiteRegistry`             | array of uint | Ordered suite ids offered, in the node's preference order; nonempty; at most `E2EE_SUITE_REGISTRY_MAX_ENTRIES` entries; each in the §3.4 registry                                  |
| 10  | `prekeyCertificate`         | array         | Exactly `[ prekeyId (text), agreementPublicKey (bytes), crossSignature (bytes), agreementFingerprint (bytes), createdAt (uint), expiresAt (uint) ]`                                |
| 11  | `continuityChain`           | array         | Zero or more `[ bstr(transcript), bstr(signature) ]` entries (§7.5), at most `E2EE_CONTINUITY_CHAIN_MAX_LENGTH`                                                                    |
| 12  | `requireE2EE`               | bool          | Raw policy value (§12)                                                                                                                                                             |
| 13  | `requireApprovedClientE2EE` | bool          | Raw policy value (§12)                                                                                                                                                             |
| 14  | `admittedPatterns`          | array of text | Effective admitted pattern set, in fixed order `"IK"` then `"NX"`; exactly `["IK"]` when `requireApprovedClientE2EE` is true (§12)                                                 |
| 15  | `policyGeneration`          | uint          | Monotonic policy generation (§5.7)                                                                                                                                                 |
| 16  | `issuedAt`                  | uint          | Epoch milliseconds                                                                                                                                                                 |
| 17  | `expiresAt`                 | uint          | Epoch milliseconds; interval bound per §5.7                                                                                                                                        |
| 18  | `continuityId`              | text          | Continuity id format (§7.1). **REQUIRED in every statement**, including from a node that has never rotated; every entry of element 11 MUST carry the identical value (§7.5)        |

Element 18 is appended rather than inserted so the index mapping of the cross-signature
reconstruction below is unaffected. It is the node's Hub-independent anchor (§7.5): a verifier
uses it to classify a fingerprint change as a §13.3 identity change rather than as a new node,
and never as evidence of identity. A statement omitting it, carrying a malformed value, or
disagreeing with any carried chain entry is invalid (§5.2, §7.5).

**Advertised protocol range (elements 7–8).** The range is what the node offers, and exactly two
rules consume it. The client's is §5.2 step 8: a client whose `E2EE_PROTOCOL_VERSION` falls
outside the range — or that receives an inverted range — treats the statement as unusable
evidence and never sends a hello. The node's is §8.6 step 2: the responder refuses any hello
whose `e2eeVersion` falls outside the range it advertised **on that channel** (§5.1 pins
negotiation to the advertising channel). A node MUST NOT advertise a range it cannot serve — the
range MUST contain every version it will accept at §8.6 step 2, which in version 1 is exactly
`E2EE_PROTOCOL_VERSION` — and §7.6.1 checks that once per configuration change rather than once
per channel. Multi-version negotiation is out of scope for version 1 (§1.3); when it arrives,
those two rules and the §8.2 suite selection are the places that change, and nothing else reads
elements 7–8.

**Effective admitted pattern set (element 14).** The set is what the node's committed policy
admits, and exactly **one** rule consumes it: §5.2 step 9, where a client whose tier's Noise
pattern (§8.1 — `"IK"` for signed native, `"NX"` for web) is absent from the set treats the
statement as unusable evidence and never sends a hello, taking the disposition of §5.2 step 8 and
§8.2. Nothing else reads element 14. In particular the **node** does not: §8.6 step 2 evaluates
`tier` against the node's own committed policy and never against the set an advertisement carries,
which is the §12.6 rule that keeps a stale replayed advertisement from widening admission. Element
14 therefore needs no §7.6.1 self-check line of its own, unlike elements 7–8: it is _computed_
from the committed policy — exactly `["IK"]` when `requireApprovedClientE2EE` is true, otherwise
`["IK", "NX"]` — rather than configured independently, so a node cannot advertise a set it does not
serve. When a future revision adds a tier or a pattern, §5.2 step 9 and this element are the two
places that change.

**Transcript size bound.** The encoded transcript MUST NOT exceed
`E2EE_CAPABILITY_TRANSCRIPT_MAX_BYTES`. A node MUST check this at encode time and MUST NOT emit a
statement over it (§7.6.1); a verifier MUST reject an over-long transcript before decoding it
(§5.2 step 0, §15). Element 1 and element 11 are the only elements whose size varies with
deployment or history, and both are bounded — by `E2EE_HUB_ORIGIN_MAX_BYTES` and
`E2EE_CONTINUITY_CHAIN_MAX_LENGTH` — so §3.2.1 S8 is a closed inequality over named constants
rather than an aspiration.

The **signed capability statement** carried by §5.3 is the canonical-CBOR array
`[ bstr(transcript), bstr(signature) ]`, where the signature is the node identity key's Ed25519
signature over the §7.2.1 signing envelope of those exact transcript bytes. The envelope is not
carried: the wire form holds the transcript and the signature only, and every verifier rebuilds
the envelope itself. The complete statement CBOR MUST NOT exceed
`E2EE_CAPABILITY_STATEMENT_MAX_BYTES`, which §3.2.1 S4 derives from the transcript bound plus
`E2EE_STATEMENT_WRAPPER_MAX_BYTES` (§5.3).

**Cross-signature reconstruction.** The statement does not carry the node prekey transcript
bytes; the verifier reconstructs them, which is what binds the prekey to the statement's
identity fields. Build the §7.3 array as: elements 1–4 and 6–7 from statement elements 1–4 and
5–6; element 5 (`prekeyId`) and elements 8, 11, 12 from `prekeyCertificate` members 0, 1, 4, 5;
elements 9–10 the fixed usage literals. Verify `crossSignature` (member 2) over those
reconstructed bytes under the statement's identity key, and recompute `agreementFingerprint`
(member 3, domain `ryco.e2ee-agreement-key.v1`) from member 1. Any disagreement invalidates the
statement.

Statement verification order and freshness, replay, and rollback rules are fixed in §5.2 and
§5.7; §7 adds only the byte-level obligations above (re-encode equality, fingerprint
recomputation, chain verification per §7.5).

#### 7.6.1 Statement self-check (normative)

Whether a node can build and sign a conforming statement is a function of the node's **own**
configuration and history — Hub origin length, continuity-chain depth, suite registry, identifier
widths — and of nothing any peer supplies. It is therefore checked once per configuration change,
never once per channel, and a failure is an operator-actionable startup condition rather than a
per-channel degradation. This mirrors the §6.4 prekey self-validation.

The node MUST build the §7.6 transcript, the §7.2.1 envelope, and the complete signed statement
and carrier, and MUST verify all of:

```text
len(hubOrigin)  ≤ E2EE_HUB_ORIGIN_MAX_BYTES
len(transcript) ≤ E2EE_CAPABILITY_TRANSCRIPT_MAX_BYTES
len(envelope)   = E2EE_CAPABILITY_SIGNING_ENVELOPE_BYTES
len(statement)  ≤ E2EE_CAPABILITY_STATEMENT_MAX_BYTES
len(carrier)    ≤ E2EE_CAPABILITY_CARRIER_MAX_BYTES
e2eeVersionMin  ≤ E2EE_PROTOCOL_VERSION ≤ e2eeVersionMax
```

The last line is not a size bound but belongs to the same class of check: whether the node can
advertise a statement it is able to serve is a function of its own configuration alone (§7.6
elements 7–8), and a node advertising a range excluding the version it implements would refuse
at §8.6 step 2 every hello its own advertisement invited.

and that the §7.5 continuity-id startup cross-check resolved to a single value the node may
advertise — element 18 is REQUIRED, so a node in the unresolvable state of §7.5 has no conforming
statement to build — and that the signing call itself succeeds, at each of: node startup; after
every identity
rotation and every continuity-chain append or prune (§7.5); after every prekey rotation (§6.4);
and after every policy change that increments the policy generation (§5.7).

A failing self-check is handled as follows, and in no case by shrinking what is advertised:

- The node MUST NOT advertise, MUST NOT emit a partial, pruned, elided, or unsigned statement,
  and MUST surface the failure as a startup error naming the failing bound or check. Pruning the
  continuity chain to make the transcript fit is explicitly forbidden: §7.5 makes chain
  truncation channel-fatal for a pinned client, so size-driven pruning would convert an operator
  configuration problem into silent, deployment-wide re-verification prompts.
- Under effective `requireE2EE` the node MUST fail startup rather than start and close every
  channel one at a time. If the condition instead arises after startup — a rotation that grows
  the chain past a bound — it is §5.5 U2 and every subsequent channel is FATAL-PRE (§11.2 P23).
- Otherwise the condition is §5.5 U2: the advertisement is suppressed and occurrences are counted
  under the **advertisement-unavailable** class of §12.5, never the peer-legacy class, and are
  excluded from the §12.3 default-flip criterion.

## 8. Handshake

### 8.1 Roles, preconditions, and general rules

The client is always the Noise **initiator**; the node is always the **responder**. The tier
selects the pattern (§3.4): signed native runs IK with the client static agreement key; web
runs NX with no client static. The responder static in both patterns is the node agreement
prekey advertised **on this channel** (§5.1, §6.4). Noise protocol names, DH, AEAD, and hash
functions are fixed by the negotiated suite (§3.4) at Noise revision `NOISE_SPEC_REVISION`.

Preconditions:

- The channel is a relay protocol 1.2 (or newer minor) channel — the authorization context
  (§8.3) requires the `channel.open` `capability` and `effectiveRole` fields, which exist only
  at minor 2 and above.
- The client holds a validated capability statement for this channel (§5.2); rows K1–K4 of
  §4.4 govern when a hello may be sent.
- The node applies the pre-authentication bounds and rate limits of §15 **before** any
  signature verification or DH computation.
- **Exactly one handshake attempt per channel** (§4.4). Any failure after a hello is sent or
  consumed is fatal for the channel; retry requires a fresh ticket, channel, and handshake.
- **No application RPC may appear in any Noise handshake payload**, in either direction. The
  defined payload structures below are exhaustive; any additional or unexpected payload content
  is a handshake failure.
- Any X25519 operation in the handshake whose shared-secret output is all zeros — the invalid
  and low-order input case — MUST abort the handshake. This is the single mandated behavior;
  no distinct error is surfaced (FATAL-PRE, §11).

### 8.2 Client-selected suite

The client verifies the signed ordered `suiteRegistry` (§7.6), intersects it with its local suite
and trust-source policy, and deterministically selects a suite: it takes its own fixed local
preference order and selects the first eligible entry that appears in the advertised registry.
Unknown advertised identifiers are ignored during intersection. Suite `0x01` is eligible for Web
NX or locally verified native IK; suite `0x02` is eligible only for account-enrolled native IK under
§18.1. Trust-source eligibility is evaluated before numeric preference, so a valid local pin always
selects `0x01`.
An empty intersection means the client MUST NOT send a hello (evidence is unusable; rows K2/K3
apply as for invalid evidence, and §11.2 P15 when the channel's selection is latched). It has two
analogues with the identical disposition: §5.2 step 8, which disposes of a protocol range
excluding the client's `E2EE_PROTOCOL_VERSION`, and §5.2 step 9, which disposes of an effective
admitted pattern set (§7.6 element 14) omitting the pattern the client's tier runs. **Suite,
version, and admitted pattern are the three ways a well-formed, correctly signed statement can
still be unusable**, and they are exhaustive because they are exactly the three signed fields a
hello must satisfy before §8.6 can accept it: `selectedSuite` at §8.6 step 2, `e2eeVersion` at
§8.6 step 2, and `tier` at §8.6 step 2. A revision that adds a fourth such field MUST add its
check here and to §4.4's **usable** qualifier, or it reintroduces the destructive probing §5.1
forbids.

The client builds its first Noise message for the selected suite. The server may only accept
that selection — echoing it in `E2EEServerAccept` — or reject the handshake; it MUST NOT select
a different suite. Multi-suite negotiation requires its own reviewed handshake revision (§1.3).

### 8.3 Authorization context block

The context block is a canonical-CBOR array of exactly 18 elements under domain
`ryco.relay-e2ee.context.v1`:

| #   | Field                           | Type           | Content                                                                                                                                                                                                                                                                                                |
| --- | ------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0   | domain                          | text           | `"ryco.relay-e2ee.context.v1"`                                                                                                                                                                                                                                                                         |
| 1   | `hubOrigin`                     | text           | Canonical Hub origin the endpoint is actually connected to                                                                                                                                                                                                                                             |
| 2   | `channelId`                     | text           | The relay channel id                                                                                                                                                                                                                                                                                   |
| 3   | `relayProtocolMajor`            | uint           | Negotiated relay protocol major                                                                                                                                                                                                                                                                        |
| 4   | `relayProtocolMinor`            | uint           | Negotiated relay protocol minor                                                                                                                                                                                                                                                                        |
| 5   | `e2eeVersion`                   | uint           | This protocol's version (`E2EE_PROTOCOL_VERSION`)                                                                                                                                                                                                                                                      |
| 6   | `suiteId`                       | uint           | The selected suite                                                                                                                                                                                                                                                                                     |
| 7   | `nodeId`                        | text           | The selected node id                                                                                                                                                                                                                                                                                   |
| 8   | `nodeIdentityAlgorithm`         | text           | Expected node identity algorithm (`"ed25519"`)                                                                                                                                                                                                                                                         |
| 9   | `nodeIdentityFingerprint`       | bytes          | Expected node identity fingerprint (`ryco.node-key.v1`)                                                                                                                                                                                                                                                |
| 10  | `accountId`                     | text           | Client-claimed account id; the namespace is the pair with element 1. **Hub-issued and not client-anchored** (§12.1.1). **NX: the empty string**                                                                                                                                                        |
| 11  | `clientIntendedCapability`      | text           | Capability the client commits to exercise                                                                                                                                                                                                                                                              |
| 12  | `clientIntendedRole`            | text           | Role the client commits to exercise                                                                                                                                                                                                                                                                    |
| 13  | `channelOpenCapability`         | text           | The `channel.open.capability` the endpoint received                                                                                                                                                                                                                                                    |
| 14  | `channelOpenEffectiveRole`      | text           | The `channel.open.effectiveRole` the endpoint received                                                                                                                                                                                                                                                 |
| 15  | `nodeCertificateFingerprints`   | array of bytes | Element 0: node agreement-key fingerprint (`ryco.e2ee-agreement-key.v1`); elements 1…n: SHA-256 of each continuity-certificate transcript in chain order (empty chain contributes none). Both are taken from the capability statement advertised **on this channel**, per the construction rules below |
| 16  | `clientCertificateFingerprints` | array of bytes | IK: exactly `[ clientIdentityFingerprint, clientAgreementFingerprint ]`. **NX: the empty array**                                                                                                                                                                                                       |
| 17  | `nodeContinuityId`              | text           | The node continuity id (§7.5) this endpoint expects for this channel. Nonempty on **both** tiers; it has no absence semantics, because a continuity id exists for every node and §7.6 element 18 makes it a required signed element of every statement                                                 |

Element 17 is appended rather than inserted, so elements 0–16 keep their indices and every
previously fixed ordering is unchanged.

Construction rules:

- **The native client constructs its expected values from the selection and authority it is
  willing to exercise, not from relay frames it later receives** — with two bounded exceptions:
  elements 13–14, which each endpoint fills from the `channel.open` it received, and the
  first-contact provenance of elements 9 and 17, which is stated below and in §13.2. The selection
  is the client-side handle of §13.1, resolved to a pin per §12.1.1. Its expected node
  fingerprint (element 9) comes from that resolved pin's verified fingerprint or from the
  continuity chain authenticated to it, or from the pairing flow of §13; a key merely carried
  by a self-signed first-contact statement is not a trust anchor.
- **Element 17 follows element 9's provenance rule exactly.** When the channel's selection
  resolves to a **verified** pin (§12.1.1, §13.1), the native client MUST use the continuity id
  recorded in that pin and MUST NOT adopt the value the statement carries; the two are compared
  at §5.2 step 6 and any disagreement is already channel-fatal before a hello may be sent. Only
  where no verified pin resolves — genuine first contact, the §13.2 pairing flow, whose pin
  record is still `unverified` and therefore anchors nothing, and the web tier, which holds no
  pins at all — does the endpoint take element 17 from the statement it validated, exactly as it
  does for element 9. Agreement on element 17 is **not** evidence of identity: §7.5's rule that a
  matching continuity id can never re-anchor a pin, promote a pin state, set the latch, or relax
  any guard applies unchanged here.
- **Element 15 has one source at each end, and it is the same statement.** The client builds it
  from the prekey certificate and continuity chain of the capability statement it validated on
  this channel (§5.2) — it has no other source, and the first bullet forbids taking such material
  from relay frames it later receives. The node builds it from the statement it advertised on that
  channel, per the rule below. Where the selection resolves to a **verified** pin, §5.2 step 6 has
  already authenticated that chain back to the pin, so the shared source is authenticated material
  and not merely agreed material; on first contact and on web it is agreed material only, exactly
  as for elements 9 and 17.
- The node constructs elements 13–14 from its received `channel.open` and elements 10–12 from the
  authenticated IK payload claims (§8.5).
- **The node's own material — elements 7–9, 15, and 17 — is pinned to the statement it advertised
  on this channel**, not to its current state: the `nodeId` and identity algorithm and fingerprint
  it signed as §7.6 elements 2–3 and 6, the agreement prekey it advertised (§6.4), the continuity
  chain it carried as §7.6 element 11, in that order, and the continuity id it signed as §7.6
  element 18. This mirrors §6.4's prekey rule and §5.1's channel pinning — a statement belongs to
  the channel that carried it — and it makes the two ends provably build element 15 from the same
  bytes: the client has no source but the statement it validated on this channel, and §8.3 forbids
  it taking element 9 from relay frames it later receives. The consequence is normative: an
  identity rotation, a continuity-chain append, or a chain prune (§7.5) that lands between
  advertisement emit and hello arrival does **not** retroactively change what an open channel's
  context block contains, and the handshake completes against the advertised material. §7.5
  requires the node to retain that snapshot for the channel's lifetime and §15 bounds it. The
  node's element 17 is therefore the value it signed as §7.6 element 18 of that statement — its
  own stored state at advertisement time — and is never taken from anything a peer or the Hub
  supplies. This pins **identity material only**: the node's admission policy is always evaluated
  from its own committed state, never from the advertised snapshot (§8.6 step 2, §12.6), and the
  context block carries no policy field.
- **Role ordering** is `viewer < operator < owner`. **Exact equality is required**: element 11
  MUST equal element 13, and element 12 MUST equal element 14, at both endpoints. On IK, the
  node additionally requires element 11 to be within the approved capability set and element 12
  to be no greater than the approved role ceiling of the Branch A record (§13), and element 10
  to equal the account id bound in the client certificate. A **silent role reduction — the
  received effective role differing from the committed role in either direction — is a context
  mismatch**; the handshake fails and a retry requires a fresh ticket built from the newly
  presented authority.
- **Absence semantics.** NX has no client identity or Branch A claim: element 10 is the empty
  string and element 16 the empty array; elements 11–12 MUST equal the received `channel.open`
  values (the web client exercises exactly the granted authority, and the equality still
  detects a Hub presenting different authority to the two ends). On IK every one of elements
  10–12 MUST be nonempty. Elements 10 and 16 are the **only** tier-dependent elements: element 17
  has no absence form and MUST be nonempty on both tiers, because the node it describes exists on
  both.
- Element 11 MUST be a member of `RELAY_CAPABILITY_LITERALS` — the relay contract's closed
  capability vocabulary ([relay-protocol.md](./relay-protocol.md), Frame classes), which this
  protocol does not extend (§1.1) and whose defining module remains authoritative for it (§3.2).

**Why the continuity id needs its own element.** Element 15 carries the SHA-256 of each carried
continuity-certificate transcript, and each of those transcripts contains the continuity id — so
for a node that has rotated, the id is already bound into the context transitively. A node that
has **never** rotated carries an empty chain, which contributes no element-15 entry, so before
element 17 the continuity id of exactly that node class was bound into nothing the handshake
authenticates — while §5.2 step 6 and §7.5 simultaneously made a disagreeing value channel-fatal.
The binding of a decisive field must not depend on the node's rotation history. Element 17
removes that dependence and buys two further properties: the check becomes **mutual**, because
the responder now reconstructs the id from its own stored state — as of the advertisement it
emitted on this channel, per the construction rules above — and a client whose expectation
differs cannot complete the handshake at all (the same reason element 9 is present even though
the client also checks the statement); and, because `confirmationTranscript` and
`sessionBindingHash` embed the whole block (§8.7, §8.8), every protected record's AAD is bound to
the continuity id the two ends agreed on. What it does **not** buy is any evidence of identity —
see §7.5 and the construction rule above.

`contextCommitment = SHA-256(canonical-CBOR(contextBlock))`, of length
`E2EE_CONTEXT_COMMITMENT_BYTES`.

### 8.4 Noise prologue

Both sides construct the identical Noise prologue, the canonical-CBOR array:

```text
[ "ryco.relay-e2ee.prologue.v1", hubOrigin, channelId, relayProtocolMajor,
  relayProtocolMinor, e2eeVersion, suiteId, nodeId, bstr(contextCommitment) ]
```

The responder takes `contextCommitment` from the hello wrapper (§8.5); every other prologue
element comes from its own channel state. In version 1 `e2eeVersion` is fixed by
`E2EE_PROTOCOL_VERSION`; `suiteId` is selected from §3.4 under §8.2. Both are established by the
§8.6 step 2
registry check rather than adopted from the wrapper. The only **other** wrapper field consumed
before Noise processing begins is `tier`, which selects the pattern (§8.1, §8.6 step 4);
`e2eeVersion`, `selectedSuite`, and `offeredSuites` are validated against the responder's own
state at §8.6 step 2 and never adopted. **No wrapper value is trusted**: the full authorization
context is independently reconstructed from the responder's own state and compared at §8.6 step 7. Because Noise mixes the prologue into the handshake hash, any disagreement about these public
fields or about the commitment makes the handshake fail cryptographically.

_Note (non-normative)_: tier integrity is not carried by a prologue field, and deliberately so —
a responder-populated tier element would be derived from the same unauthenticated wrapper value
that chose the pattern, so it would detect nothing. Tier confusion is caught in three places
instead: the tier-dependent shape of context elements 10 and 16 (§8.3 absence semantics), which
enters the commitment the responder rebuilds; the NX zero-length message-1 rule (§8.5); and the
coverage of the **exact hello wire bytes** — the `tier` field among them — by
`confirmationTranscript` (§8.7) and `sessionBindingHash` (§8.8), so a mutated tier breaks key
confirmation. Those are the concrete assertions the §14.1 tier/pattern-confusion suite tests
against.

_Note (non-normative)_: channel ids are unique per channel, which makes the prologue — and
therefore every Noise message and derived key — channel-unique; a recorded `E2EEClientHello`
replayed on another channel fails Noise processing outright.

### 8.5 `E2EEClientHello`

Negotiation record type `0x01` (§3.4), bounded by `E2EE_CLIENT_HELLO_MAX_BYTES`. The body is a
canonical-CBOR array of exactly 7 elements:

| #   | Field               | Type          | Content                                                                                                                                                                                                                                                                                                                  |
| --- | ------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0   | `e2eeVersion`       | uint          | MUST equal `E2EE_PROTOCOL_VERSION`                                                                                                                                                                                                                                                                                       |
| 1   | `tier`              | text          | `"native"` (IK) or `"web"` (NX)                                                                                                                                                                                                                                                                                          |
| 2   | `selectedSuite`     | uint          | The client-selected suite (§8.2)                                                                                                                                                                                                                                                                                         |
| 3   | `offeredSuites`     | array of uint | The client's complete ordered local suite-preference list; MUST contain element 2; MUST NOT exceed `E2EE_SUITE_REGISTRY_MAX_ENTRIES` entries, matching the cap on the node's registry (§7.6 element 9). The record is in any case bounded by `E2EE_CLIENT_HELLO_MAX_BYTES`, enforced before any body parse (§8.6 step 1) |
| 4   | `clientNonce`       | bytes         | `E2EE_HANDSHAKE_NONCE_BYTES` fresh CSPRNG bytes; contributes transcript entropy; not otherwise interpreted                                                                                                                                                                                                               |
| 5   | `contextCommitment` | bytes         | `E2EE_CONTEXT_COMMITMENT_BYTES` (§8.3)                                                                                                                                                                                                                                                                                   |
| 6   | `noiseMessage1`     | bytes         | The Noise first handshake message for the tier's pattern                                                                                                                                                                                                                                                                 |

**The clear wrapper carries no client identifier**: no account id, no client key, no client
fingerprint, no certificate. On IK those travel only inside the encrypted Noise payload; the
Noise `s` token transmits and proves possession of the client static agreement key under
handshake encryption.

**IK message-1 payload** — the encrypted handshake payload of `noiseMessage1` — is a
canonical-CBOR array of exactly 5 elements:

| #   | Field                    | Type  | Content                                                              |
| --- | ------------------------ | ----- | -------------------------------------------------------------------- |
| 0   | `clientPrekeyTranscript` | bytes | Exact §7.4 transcript bytes                                          |
| 1   | `clientPrekeySignature`  | bytes | Device-key signature over element 0 (§7.1)                           |
| 2   | `accountId`              | text  | The account claim; MUST equal the certificate's namespace account id |
| 3   | `intendedCapability`     | text  | Context element 11                                                   |
| 4   | `intendedRole`           | text  | Context element 12                                                   |

**NX message-1 payload MUST be zero-length.** The NX first message has no encryption keys
(§8.10); nothing may ride in it, and a responder MUST treat a nonempty NX message-1 payload as
a handshake failure.

### 8.6 Responder processing

The responder processes a hello in exactly this order; every failure at any step is FATAL-PRE
(§4.4, §11) and externally indistinguishable from every other pre-key failure:

1. **Bounds before crypto.** Record-size bound (§3.3), §4.4 admission rows, and the §15
   concurrency and rate bounds — all before any signature or DH work. Admitting the hello
   creates the channel's **in-flight handshake entry** (§15), which is retired at the first of:
   authenticated implicit finish (§8.9), any FATAL-PRE or FATAL-POST outcome, or channel close.
2. **Wrapper checks.** Strict decode (§3.6); `e2eeVersion` inside the protocol range the node
   advertised on this channel (§7.6 elements 7–8) and implemented by the node — in version 1,
   exactly `E2EE_PROTOCOL_VERSION`; `tier` admitted by
   policy — under `requireApprovedClientE2EE`, only `"native"` (§12); `selectedSuite` present
   in both the node's registry and `offeredSuites`; field lengths exact. The policy read here is
   always the node's own **committed** policy, never the one the advertised snapshot carries
   (§12.6). This step's policy read and the channel's transition into `e2ee` (row N3) MUST be
   atomic with respect to the **§12.6 policy-withdrawal commit**, exactly as step 6's read is with
   respect to the §13.6 authorization-withdrawal write. A handshake whose step-2 read preceded the
   commit therefore either reached row N3 before the commit — where the §12.6 sweep finds it in
   `e2ee` — or had not reached it when the commit landed, where §12.6's in-flight clause finds it;
   no interleaving exists in which it becomes `e2ee` after the commit and behind the sweep. This
   is what supports §12.6's two-case exhaustion and what removes the need for per-channel
   policy-generation bookkeeping; without it a handshake could cross row N3 between §12.6 step
   (b)'s two enumerations and be missed by both.
3. **Prologue.** Construct §8.4 from own channel state plus the wrapper commitment.
4. **Noise.** Run the responder side of the tier's pattern using the agreement prekey
   advertised on this channel. Any Noise failure — AEAD authentication, malformed message
   length, all-zero DH output (§8.1) — aborts.
5. **IK bindings.** Decode the message-1 payload; verify the client certificate per §7.4 and
   §7.1 (re-encode equality, domain, formats, point validation, device-key signature,
   fingerprint recomputation, validity with `E2EE_MAX_CLOCK_SKEW`); require the Noise-received
   client static `s` to byte-equal the certificate's `agreementPublicKey`; require the payload
   `accountId` to equal the certificate's account id and the certificate's `hubOrigin` to equal
   the channel's; require the certificate's usage fields to match the negotiated suite.
6. **Authorization (IK).** Look up the Branch A record for
   `(hubOrigin, accountId, clientIdentityFingerprint)` (§13). Absent, pending, or revoked →
   no application authorization: the pairing-only flow of §13 governs first contact, and the
   channel closes without application payload. Approved → enforce the capability set and role
   ceiling per §8.3. The responder MUST record, on this channel's in-flight handshake entry
   (step 1) and at the moment of this read, the **admitted-authority snapshot**: the full record
   key `(hubOrigin, accountId, clientIdentityFingerprint)` together with the `status`, `maxRole`,
   and `capabilitySet` this read returned. It carries no other record content — not the safety
   number, not the display label, not any timestamp — and it survives onto the established
   channel for the channel's lifetime (§15). §13.6 uses the key half to abort a handshake whose
   authorization is withdrawn between this step and row N3, and both halves to decide the §13.6
   sweep and the §8.9 re-check; recording the fingerprint alone would leave a channel admitted
   under one `(hubOrigin, accountId)` scope matched by a withdrawal in another. This step's read
   and the transition into `e2ee` MUST be atomic with respect to the §13.6 authorization-withdrawal
   write.
7. **Context reconstruction.** Build the full §8.3 block from the node's own `channel.open`,
   the authenticated payload claims, and the identity, prekey, chain, and continuity-id material
   **it advertised on this channel** (elements 7–9, 15, and 17; §8.3 construction rules, §7.5
   advertised-chain retention) — never its current state, which a rotation or prune concurrent
   with this channel may already have moved; hash it; compare with the wrapper commitment in
   constant time.
   Mismatch → failure, externally identical to every other handshake authorization failure.
8. On success, build and send `E2EEServerAccept` (§8.7) — row N3 of §4.4.

### 8.7 `E2EEServerAccept`, `ServerAcceptTBS`, and confirmation

Negotiation record type `0x02` (§3.4), bounded by `E2EE_SERVER_ACCEPT_MAX_BYTES`. The body is a
canonical-CBOR array of exactly 5 elements:

| #   | Field                | Type  | Content                                                     |
| --- | -------------------- | ----- | ----------------------------------------------------------- |
| 0   | `acceptedSuite`      | uint  | MUST equal the hello's `selectedSuite`                      |
| 1   | `nodePrekeyId`       | text  | MUST equal the `prekeyId` advertised on this channel (§7.6) |
| 2   | `contextCommitment`  | bytes | MUST byte-equal the hello's commitment                      |
| 3   | `noiseMessage2`      | bytes | The Noise second handshake message                          |
| 4   | `serverConfirmation` | bytes | `E2EE_CONFIRMATION_BYTES`; defined below                    |

**Message-2 payload** (both patterns) — the encrypted handshake payload of `noiseMessage2` —
is a canonical-CBOR array of exactly 3 elements carrying the node-received authority fields and
the certificate binding the client must compare:

| #   | Field                         | Type  | Content                                                               |
| --- | ----------------------------- | ----- | --------------------------------------------------------------------- |
| 0   | `channelOpenCapability`       | text  | The `channel.open.capability` the node received                       |
| 1   | `channelOpenEffectiveRole`    | text  | The `channel.open.effectiveRole` the node received                    |
| 2   | `nodeAgreementKeyFingerprint` | bytes | `ryco.e2ee-agreement-key.v1` fingerprint of the responder static used |

In NX, the Noise `s` token in message 2 transmits and proves possession of the node static
agreement key; the client MUST require it to byte-equal the advertised prekey certificate's
`agreementPublicKey`. In IK the initiator already supplied that verified static to the Noise
state from the advertisement, as the pattern requires.

**Transcript definitions.** "Wire bytes" below always means the complete post-strip negotiation
record — discriminator, record type, and body (§3.3):

```text
ServerAcceptTBS         = the negotiation record whose body is the canonical-CBOR
                          4-element array of fields 0-3 above (the confirmation
                          field absent)

confirmationTranscript  = SHA-256(canonical-CBOR([
                            "ryco.relay-e2ee.confirmation.v1",
                            bstr(exact E2EEClientHello wire bytes),
                            bstr(ServerAcceptTBS wire bytes),
                            contextBlock
                          ]))

serverConfirmationKey   = HKDF-Expand(exporterSecret,
                            "ryco.relay-e2ee.confirmation-key.v1", E2EE_SECRET_BYTES)

serverConfirmation      = HMAC-SHA256(serverConfirmationKey, confirmationTranscript)
```

`contextBlock` is embedded as the nested canonical array itself, not as a byte string; the two
wire-byte elements are byte strings with explicit CBOR boundaries, so no consumer concatenates
transcript fields ad hoc. The responder completes `Split()` after producing `noiseMessage2`,
derives `exporterSecret` (§6.5) and `serverConfirmationKey`, computes the confirmation, and
appends it as field 4; the final `E2EEServerAccept` body is the 5-element array. **The
confirmation MAC never includes itself** — it covers `ServerAcceptTBS`, not the final record.

Hashing exact wire bytes binds the offered-suite list, the Noise messages, any future extension
bytes, and — through `contextBlock` — the full authorization context. Suite-list stripping,
role or capability escalation, node substitution, and cross-account splice each change one of
the hashed inputs and MUST break confirmation or fail the §8.3/§8.6 checks.

### 8.8 Client verification and session binding

On receiving `E2EEServerAccept` (row K5/K6 of §4.4), the client, in order:

1. enforces the record bound and strict decode;
2. checks `acceptedSuite` equals its selection, `nodePrekeyId` equals the advertised prekey id,
   and `contextCommitment` byte-equals its own;
3. processes `noiseMessage2` (NX: including the responder-static equality check of §8.7); any
   Noise failure or all-zero DH aborts;
4. decodes the message-2 payload and verifies: fields 0–1 byte-equal elements 13–14 of its own
   context block (which it constructed from its own `channel.open` and intent, §8.3), and
   field 2 equals the advertised prekey certificate's agreement fingerprint;
5. completes `Split()`, derives `exporterSecret` and `serverConfirmationKey` (§6.5, §8.7),
   recomputes `confirmationTranscript` — this is the client's symmetric context check: the
   transcript embeds its own `contextBlock`, so a responder that verified a different context
   cannot have produced a matching MAC — and compares `serverConfirmation` in constant time;
6. computes the session binding over the final wire bytes:

```text
sessionBindingHash = SHA-256(canonical-CBOR([
                       "ryco.relay-e2ee.session.v1",
                       bstr(exact E2EEClientHello wire bytes),
                       bstr(exact final E2EEServerAccept wire bytes),
                       contextBlock
                     ]))
```

and enters `e2ee` (row K5). The node computes the identical value from the bytes it emitted.
The session binding includes the final confirmation (inside the final record bytes) without a
self-reference cycle: confirmation covers TBS; session binding covers the finished record.
`sessionBindingHash` is `E2EE_SESSION_BINDING_HASH_BYTES` long and enters the AAD of every
envelope (§3.3, §9).

Any client-side failure in steps 1–5 is fatal for the channel (K6; one attempt, §8.1). The
client's buffered sends — application RPC and the keepalive frames §4.4 held — flush as
envelopes only after step 6.

### 8.9 Implicit client finish

The one-round-trip exchange has no separate client-finish record. Instead:

- The **first valid client-to-node `0x01` envelope** — whose AAD includes the
  `sessionBindingHash` and which authenticates under the client's epoch-0 sequence (§9) — is
  the client's confirmation that it verified `E2EEServerAccept`, matched the context, and
  derived identical keys. Both the flushed first application record and an encrypted control
  record qualify; the RPC keepalive traffic guarantees one promptly — the client's first
  keepalive `Ping` after the mode locks is exactly the buffered frame §4.4 held and §3.2.2 L1
  budgets for, and it is flushed as an envelope.
- Until that envelope authenticates, the node MUST NOT emit node-to-client application RPC and
  MUST NOT invoke the RPC handler for anything (row N9 of §4.4). It MAY emit an encrypted
  `E2EEError` or `E2EEClose` if a post-key fatal condition or shutdown intervenes.
- **The implicit-finish deadline is armed unconditionally**, under every policy including the
  compatibility default. `T_HANDSHAKE_NODE` is satisfied only by an authenticated implicit
  finish: the deadline stays armed through the `e2ee` state until the first client-to-node
  envelope authenticates, and expiry is FATAL-POST (§11.3 Q8) regardless of `requireE2EE`. The
  justification is **key-material lifetime, not availability**: between row N3 and the finish
  the node holds a complete set of live session secrets for a peer that has not yet demonstrated
  it derived the same ones, and §9.5 erasure must have a deterministic trigger in every
  configuration rather than only in the hardened ones. (Row N8
  covers expiry while still `negotiating` and remains guarded on effective `requireE2EE` for the
  compatibility reason stated in §4.4; the two halves of the deadline are deliberately not
  guarded alike.)
- A channel between row N3 and the authenticated implicit finish **is an active E2EE channel**
  for §13.6: its node-side mode machine is in `e2ee`, so the authorization-withdrawal sweep
  covers it. The implicit finish is also the first point at which the node may invoke the RPC
  handler, and it is therefore the last re-check point before a withdrawn authority could reach
  application state. On the IK tier, an implementation that cannot locally prove the §13.6
  ordering (durable withdrawal commit, then sweep and in-flight abort, then acknowledgement)
  MUST re-read the Branch A record it looked up at §8.6 step 6 before that first delivery and
  apply the **§13.6 withdrawal test** to the re-read record against the channel's
  admitted-authority snapshot: FATAL-POST with code `policy` if the record is absent, if its
  `status` is no longer `approved`, if its `maxRole` is below the snapshot's `maxRole` under the
  §8.3 role ordering, or if its `capabilitySet` no longer contains every member of the
  snapshot's `capabilitySet`. Re-reading only `status` is **not** sufficient: a demotion or a
  capability removal leaves `status = approved`, so a status-only re-check passes a channel the
  owner has just narrowed. The re-read MUST use the full record key of the snapshot, not the
  fingerprint alone. NX carries no Branch A record and therefore no snapshot, so no withdrawal
  can name an NX channel and there is nothing to re-read: NX admission is governed by node policy
  (§12.4), not by a per-key record.

This adds no round trip and no record type.

### 8.10 Per-payload security properties

The properties below are the payload security properties of the Noise IK and NX pattern tables
at revision `NOISE_SPEC_REVISION` (authentication / confidentiality as defined in the Noise
specification §7.7), stated per payload and per post-handshake direction, with their concrete
consequences in this protocol. There is no blanket claim.

| Payload / direction                                                           | Noise auth | Noise conf | Consequences here                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------------------------------------------------------- | ---------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| IK message-1 payload (client certificate, account claim, requested authority) | 1          | 2          | Sender authentication rests on `ss`: a holder of the **node agreement private key** could forge it (KCI) — within this design that holder is the node itself or a compromised node, which is outside the threat model (§2.6). No forward secrecy: later compromise of the node agreement key exposes recorded message-1 payloads. Replayable at the Noise level, neutralized by the channel-unique prologue (§8.4) and the one-hello rule (N3/N4). Therefore this payload carries **certification metadata only, never application data**, and the node acts on it only as §8.6 describes                                                                                                                                                                                                                                                                              |
| IK message-2 payload (authority echo, prekey binding)                         | 2          | 4          | Responder authentication via `es` is KCI-resistant. Weak forward secrecy **conditional on the node agreement prekey**: the node's binding of the client's apparent ephemeral to the client static rests only on `es` and `ss`, both computed with the **node agreement private key**, so an attacker who had **previously** compromised that key could have substituted its own ephemeral for the client's. Such an attacker still cannot read this payload at the time — message 2 also mixes `se`, which requires the client agreement private key — but a **later** compromise of the client agreement key would then decrypt it, which the strong forward secrecy of grade 5 would otherwise prevent. Prior compromise of the _client_ agreement key is a separate and strictly stronger case: it is outright client impersonation, not this caveat. Metadata only |
| IK client→node transport (incl. the implicit finish)                          | 2          | 5          | Mutual static authentication, KCI-resistant, strong forward secrecy                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| IK node→client transport                                                      | 2          | 5          | Same                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| NX message-1 payload                                                          | 0          | 0          | No keys exist yet: no authentication, no confidentiality. **MUST be empty** (§8.5)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| NX message-2 payload                                                          | 2          | 1          | Node authenticated (KCI-resistant via `es`); encryption is to an **anonymous ephemeral initiator** — any active party, including the Hub, could be that initiator. Contents are limited to relay-visible authority fields and a public fingerprint                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| NX client→node transport                                                      | 0          | 5          | **The client is never authenticated at the Noise level.** This is the structural fact behind the web row of §2.2 and §2.3: a Hub can originate an NX session. Confidentiality toward the node is strong (forward secrecy via `ee`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| NX node→client transport                                                      | 2          | 1          | Node-authenticated to whoever initiated. Forward secrecy holds via `ee` — recorded traffic stays sealed after ephemerals are erased — which is exactly the passive/retroactive (not active) guarantee of §2.2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

_Note (non-normative)_: both IK handshake-payload caveats above are rooted in the **node
agreement prekey** — retroactively for message 1, and, in combination with a later client-key
compromise, for message 2. §2.6 places node compromise outside the threat model and §6.4 governs
that key's rotation; rotation does not mitigate a caveat whose trigger is prior compromise of the
prekey a recorded handshake already used.

Identity hiding (stated structurally, not as a table index):

- **IK client identity**: the client static and certificate are encrypted under keys derived
  from `es` only. They are hidden from passive observers, but any holder of the node agreement
  private key can decrypt them — including retroactively; identity hiding here has **no
  forward secrecy**. The account-to-node relationship is already Hub-visible metadata (§2.5),
  but the client identity key and fingerprint are not — §13.6 keeps them out of Hub persistence
  entirely — so this exposure is a genuine widening of the Hub's view, not a restatement of it
  (§2.2, §2.6).
- **NX client identity**: none exists.
- **Node identity**: not an identity-hiding goal in either pattern — the node identity key,
  fingerprint, and agreement prekey are published in the clear capability statement (§5.2).

Cross-direction reflection of transport records is excluded independently of the pattern
tables: the two directions use distinct keys and distinct direction labels in the AAD (§3.3,
§9).

## 9. Record protection

### 9.1 AEAD invocation

Every `0x01` envelope protects exactly one authenticated inner record — RPC or control — with
the suite AEAD (ChaCha20-Poly1305 for suite `0x01`), before relay chunking (§4.2). Per §3.3:

- key: the sender's directional per-epoch AEAD key (§9.4), `E2EE_SECRET_BYTES` long;
- nonce: `epoch ‖ counter`, exactly `E2EE_AEAD_NONCE_BYTES` — the envelope's own header fields;
- AAD: the exact envelope header, then `sessionBindingHash`, then the sender's direction label
  (`E2EE_AAD_BYTES` total);
- plaintext: `innerType ‖ body`, with `len(body)` at most `plaintextCeiling` (§4.5), enforced
  before encryption; a zero-length body is valid at this layer.

The transmitted `version` and `suite` MUST equal the established session state **before any
AEAD implementation is selected**, on both send and receive (§4.3). Control records consume
the same directional epoch/counter sequence as RPC records; there is no second nonce space
(§4.1).

Nonce uniqueness follows from construction: within a direction, `(epoch, counter)` is strictly
increasing and never reused (§9.2, §9.3), and each `(direction, epoch)` pair has its own key.

### 9.2 Receiver-state sequencing

The receiver — not the sender — defines the expected sequence. For each direction the receiver
maintains the expected next `(epoch, counter)` pair, starting at epoch 0, counter 0, and
advancing deterministically per §9.4. For every arriving envelope:

- the transmitted epoch and counter MUST equal the expected pair, compared **before
  decryption**; a mismatch is fatal (FATAL-POST) and the ciphertext MUST NOT be decrypted;
- an epoch transition is accepted only as exactly `+1` with counter 0, and only at the exact
  threshold boundary of §9.4 — an early, late, or skipped rekey is by construction a sequence
  mismatch;
- after successful authentication the receiver advances its expectation.

A **gap, repeat, or regression is fatal**, not recoverable: see §9.7 for what this detects.

### 9.3 Sender rules and integer representation

- **Send serialization.** Sends within one direction MUST be serialized: assigning
  `(epoch, counter)`, invoking the AEAD, and committing the state advance are atomic with
  respect to every other send in that direction. Concurrent callers MUST NOT observe the same
  pair.
- **Reserve before you encrypt.** A sender MUST obtain transmission admission for the **entire**
  record — every chunk of it — _before_ it assigns `(epoch, counter)` and invokes the AEAD. A
  refused admission is therefore a sender-local error (`e2ee_send_unavailable`, §11.4): no pair
  is consumed, no record is encrypted, no wire record of any kind is produced, and the channel
  is unaffected and remains usable. Ordinary backpressure MUST NOT be allowed to consume a
  sequence pair, and a conforming sender consequently never reaches the failure dispositions
  below through backpressure alone.
- **No reuse, even on failure.** Once a `(epoch, counter)` pair has been passed to an AEAD
  invocation, it is consumed and MUST NOT be reused under any circumstance. If the send
  subsequently fails locally after that point, the sender's disposition is determined by what it
  can establish about delivery — the choice is **not** free:
  - _No byte of the record reached the relay._ The peer's expected-next pair is still the
    consumed one, so every later record in that direction would be a §9.2 gap and fatal at the
    peer. The sender MUST NOT protect any further record on that channel. It terminates as a
    local internal failure whose send path is unusable (§11.3, condition Q10): it MUST NOT emit
    an `E2EEError`, because that record would itself consume the next pair and create exactly
    the gap being avoided, and it emits the outer `channel.close`. The peer records
    **Unclean — abrupt** (§10.4), which is unattributed, rather than a spurious tampering
    signal.
  - _Delivery ambiguous or partial_ — the realistic case once a record is chunked, where earlier
    chunks may already have been transmitted. The sender MAY continue with the next pair. If the
    record did not in fact arrive, the peer's next comparison is a §9.2 mismatch it cannot
    distinguish from tampering; see the §9.7 caveat.
- **Representation.** Epochs and counters are held as fixed-width byte arrays or
  arbitrary-precision integers that exactly cover `uint32`/`uint64`; the IEEE-754 `number`
  type is forbidden for these values (§3.1). Arithmetic and comparisons MUST be exact over the
  full field range.

### 9.4 Epoch key schedule and rekey ratchet

Per direction `d` (labels per §3.4) and epoch `e`, with `label_d` appended to the HKDF `info`
as fixed in §3.5:

```text
epochSecret_d[0]   = Split() output for direction d                     (§6.5)
aeadKey_d[e]       = HKDF-Expand(epochSecret_d[e],
                       "ryco.relay-e2ee.aead-key.v1" ‖ label_d, E2EE_SECRET_BYTES)
epochSecret_d[e+1] = HKDF-Expand(epochSecret_d[e],
                       "ryco.relay-e2ee.ratchet.v1" ‖ label_d, E2EE_SECRET_BYTES)
```

Both direction schedules are always derived, at both endpoints, regardless of traffic volume.

**Thresholds.** Within one direction and epoch, after a record is protected (sender) or
authenticated (receiver), the epoch's usage is updated: the record count increments, and the
byte count increases by the length of the **authenticated inner plaintext — the type byte plus
the body**. The epoch is complete when the record count reaches `E2EE_REKEY_MAX_RECORDS` or
the byte count reaches or exceeds `E2EE_REKEY_MAX_BYTES`, whichever occurs first. **Control
records count toward both thresholds**; no traffic class bypasses them.

**Boundary ownership.** The record that reaches a threshold is the **last record of its
epoch**. The next record in that direction MUST carry epoch `e+1` and counter 0. Rekeying is
exact and mandatory: a sender MUST NOT enter the next epoch early and MUST NOT protect a
further record in a completed epoch. Both endpoints evaluate the thresholds over identical
authenticated data, so the boundary is deterministic and needs no signaling; boundary vectors
are part of the §16 corpus.

A consequence of the record threshold is that a counter never exceeds
`E2EE_REKEY_MAX_RECORDS − 1` within an epoch; the counter-exhaustion rule of §9.6 is
defensive.

### 9.5 Erasure

- `epochSecret_d[e]` MUST be erased immediately after `epochSecret_d[e+1]` and `aeadKey_d[e+1]`
  are derived.
- `aeadKey_d[e]` MUST be erased as soon as the last record of epoch `e` has been protected
  (sender side) or authenticated (receiver side) — for the boundary record, that is immediately
  after the threshold evaluation completes.
- On channel close or any fatal condition, all directional secrets, AEAD keys,
  `exporterSecret`, `serverConfirmationKey`, and buffered plaintext MUST be erased (§6.5).
- Erasure means overwriting the byte buffers with zeros before releasing the references.

_Note (non-normative)_: managed runtimes may retain unreachable copies (garbage-collector
moves, JIT spills); the zeroization discipline bounds, but cannot eliminate, that exposure.
Residual-risk treatment belongs to §17.

### 9.6 Exhaustion

Reaching `E2EE_COUNTER_MAX` within an epoch, or completing epoch `E2EE_EPOCH_MAX`, exhausts the
direction's sequence space. A sender that cannot derive the next required `(epoch, counter)`
without wrapping MUST NOT wrap, reuse, or continue.

**Close reservation.** The authenticated close of §10, and the single terminal `E2EEError` §10.2
permits after it, are themselves protected traffic, so the capacity they need MUST be reserved
before it is needed. Call the sum the **post-application reserve**:

```text
post-application reserve = E2EE_CLOSE_RECORDS_RESERVED + E2EE_ERROR_RECORDS_RESERVED
```

- An endpoint MUST hold, in each direction it sends, enough capacity to protect that many
  further records **under both §9.4 thresholds** — the record count and the
  authenticated-inner-plaintext byte count — within epoch `E2EE_EPOCH_MAX`. The
  byte half is nearly free (a close body is a few tens of plaintext bytes against
  `E2EE_REKEY_MAX_BYTES`, and an `E2EEError` body is bounded by `E2EE_ERROR_BODY_MAX_BYTES`), but
  it is normative: in the terminal epoch the direction is exhausted
  by whichever threshold completes that epoch first, and §10.1 makes close records count toward
  both.
- An endpoint MUST NOT protect an application record that would leave less than that reserve,
  and MUST initiate the close of §10 no later than the point at which exactly that reserve
  remains.
- The close half is `E2EE_CLOSE_RECORDS_RESERVED` unconditionally, in every role. An endpoint
  cannot know at reservation time whether it will initiate, respond, or land in the simultaneous
  branch of §10.2, and the initiating side — like each side of a simultaneous close — protects
  `E2EE_CLOSE_RECORDS_RESERVED` close-machine records.
- The error half is `E2EE_ERROR_RECORDS_RESERVED` unconditionally, in every role, and it is not
  optional slack. §11.3's procedure obliges an endpoint that detects a post-key fatal condition to
  emit one `E2EEError` **when the send path is still usable**, and §10.2 permits exactly one such
  record after the last close-machine record; an endpoint that had spent its whole reserve on the
  close machine would face a stray envelope (§11.3 Q7) with no capacity left, and would have to
  wrap, reuse, or silently drop the obligation. None of the three is authorised, so the capacity
  is reserved instead.

_Note (non-normative)_: a sequential responder in fact protects only a single close-machine
record, and a close that meets no fatal condition never protects the error record at all, so both
finish with part of the reserve unused. That is the intended slack; sizing the reserve to the
responder role, or to a close that no fatal condition interrupts, is the defect this rule exists
to prevent.

**Degenerate state.** If fewer than the post-application reserve of protectable records remains in
a direction — for example, in a state that already violated the reservation — the endpoint still
MUST NOT wrap or reuse. It protects as many close-machine records as remaining capacity allows,
MUST NOT emit the outer `channel.close` before §10.3 permits it or `T_CLOSE` expires, and records
the close as **Unclean — abrupt** (§10.4). This remains outside the §11.3 error table: it is a
close outcome, not an `E2EEError` condition. If capacity for the terminal `E2EEError` is likewise
unavailable when a fatal condition arises, the send path is unusable for that record in exactly
the sense §11.3 means: the endpoint closes without it, and the §11.5 observable is the
"none when the send path is unusable" case rather than a violation of §11.3's procedure.

### 9.7 What sequencing violations detect

Because the relay is untrusted, the E2EE layer cannot rely on relay ordering (§2.1). The
receiver-state rule converts any mid-stream tampering — replay of an old envelope, reordering,
deletion, or cross-epoch confusion — into a deterministic fatal mismatch **as soon as any
subsequent record arrives**. What it cannot detect is a silently dropped tail: if the relay
discards the final records of a direction and nothing follows, no mismatch ever fires. That
gap is exactly what authenticated close (§10) exists to bound, and why an abrupt close is
reported unclean rather than attributed (§2.6).

**A mismatch is detection, not attribution.** A sequence mismatch proves only that the stream
this endpoint authenticated is not the stream the peer protected. It can equally arise from the
peer's own post-AEAD local send failure under the ambiguous-delivery branch of §9.3, which
produces a byte-identical gap. Implementations MUST report the fatal condition and MUST NOT
present a mismatch as proof of an attack (consistent with §2.6 and §10.4).

## 10. Authenticated close

### 10.1 Close records and the close commitment

Orderly termination is authenticated in-band with two encrypted control record types (§3.4):
`E2EEClose` (inner type `0x02`) and `E2EECloseAck` (inner type `0x04`). Both consume the
normal directional sequence and count toward the rekey thresholds like every record (§9.4);
how many of each an endpoint protects depends on its role in §10.2, and §9.6 reserves the
capacity for them.
Authenticated close exists only in `e2ee` mode; pre-key channels have nothing to authenticate
and close generically (§4.4, §11).

Both record bodies are the same canonical-CBOR array of exactly 5 elements:

| #   | Field                 | Type                                  | Content                                                           |
| --- | --------------------- | ------------------------------------- | ----------------------------------------------------------------- |
| 0   | `finalSendEpoch`      | bytes (`E2EE_EPOCH_FIELD_BYTES`)      | MUST byte-equal the carrying envelope's epoch field               |
| 1   | `finalSendCounter`    | bytes (`E2EE_COUNTER_FIELD_BYTES`)    | MUST byte-equal the carrying envelope's counter field             |
| 2   | `expectedRecvEpoch`   | bytes (`E2EE_EPOCH_FIELD_BYTES`)      | The sender's §9.2 expected-next epoch for its receive direction   |
| 3   | `expectedRecvCounter` | bytes (`E2EE_COUNTER_FIELD_BYTES`)    | The sender's §9.2 expected-next counter for its receive direction |
| 4   | `closeCommitment`     | bytes (`E2EE_CLOSE_COMMITMENT_BYTES`) | Defined below                                                     |

The commitment binds the declared final session state to the session and to the record's role:

```text
closeCommitment = SHA-256(canonical-CBOR([
                    "ryco.relay-e2ee.close.v1",
                    innerType,                      ; uint: 0x02 close / 0x04 close-ack
                    directionLabel,                 ; text: sender's direction (§3.4)
                    bstr(sessionBindingHash),
                    bstr(finalSendEpoch), bstr(finalSendCounter),
                    bstr(expectedRecvEpoch), bstr(expectedRecvCounter)
                  ]))
```

A receiver MUST verify, for every close-machine record: strict decode with re-encode equality
(§3.6); fields 0–1 equal to the carrying envelope header; and the recomputed commitment equal
to field 4. Any failure is FATAL-POST (§11.3 Q7) and the endpoint's verdict is **Failed**
(§10.4) — a detected protocol violation, never one of the unattributed unclean verdicts.

The `expectedRecv` pair is validated against the **receiver's own send state**:

- **Passed-through rule** (applied to a received `E2EEClose`): the pair MUST be less than or
  equal to the receiver's own **current** next-send `(epoch, counter)` in lexicographic order — a
  state the peer's receive window could legitimately hold, since records may still be in flight.
- **Strict rule** (applied to a received `E2EECloseAck`): the pair MUST exactly equal the
  receiver's **close anchor**, defined below — proof that the acknowledging peer received and
  authenticated, in order, everything the receiver had sent up to and including the
  close-machine record the anchor names.

#### 10.1.1 The close anchor

An endpoint's **close anchor** is the `(epoch, counter)` value obtained by applying the §9.2
expected-next advance function — the same function §9.4 defines, so a record that completes an
epoch advances to `(e + 1, 0)` and **not** to counter + 1 — to the position at which the endpoint
transmitted its own **first** close-machine record on that channel. Equivalently: the anchor is
the endpoint's next-send state as of immediately after it transmitted that record. It is fixed at
that instant and MUST NOT be recomputed from the endpoint's later next-send state.

| Branch and role                                                                    | The endpoint's first close-machine record | Anchor                                    |
| ---------------------------------------------------------------------------------- | ----------------------------------------- | ----------------------------------------- |
| Sequential initiator (validating the responder's `E2EECloseAck`, §10.2 step 3)     | its `E2EEClose`                           | advance of that `E2EEClose`'s position    |
| Sequential responder (validating the initiator's final confirmation, §10.2 step 4) | its `E2EECloseAck`                        | advance of that `E2EECloseAck`'s position |
| Simultaneous close, either side (validating the peer's `E2EECloseAck`, §10.2)      | its `E2EEClose`                           | advance of that `E2EEClose`'s position    |

The anchor — rather than the receiver's current next-send — is normative because in the
simultaneous branch the two are never equal for an honest pair. Each side sends `E2EEClose`, then
`E2EECloseAck` computed after processing the peer's close but necessarily before the peer's ack
exists; each side is therefore permanently one advance ahead of anything the peer could have
acknowledged. Validating against current next-send would make every simultaneous close between
two honest endpoints a strict-rule failure (§11.3, Q7) — or, worse, would make the outcome depend
on whether an implementation happens to read the peer's close and ack in the same batch, a race
between conforming implementations. In the sequential branch the anchor equals the current
next-send, because the validating endpoint has sent nothing since its own first close-machine
record; using the anchor there simply removes an implicit "validate before you send" ordering
dependency.

Adding further round trips would not let the strict rule hold against current next-send: the last
record of any finite exchange is always unacknowledged, so the one-advance offset is invariant
under adding rounds. §10.2 and §10.4 state the resulting guarantee plainly instead.

Because §9.2 makes sequences gapless, an authenticated close-machine record also proves that
every prior record in its direction was received in order — "all prior counters present" is
implied, never separately signaled.

### 10.2 Close state machine

Either endpoint may initiate after establishment — application shutdown, policy, or sequence
exhaustion (§9.6). After sending `E2EEClose`, an endpoint MUST NOT protect further application
RPC records; inbound records MUST still be authenticated in order (they are required to
validate the exchange) and authentic RPC records MAY still be delivered. Each wait step below
is bounded by `T_CLOSE`; expiry ends the exchange with an **Unclean — abrupt** verdict (§10.4).

**How many wait steps a close phase contains, and why the count is normative.** An endpoint's
close phase contains **exactly one** `T_CLOSE`-bounded wait on either sequential path — the
initiator waits for the responder's `E2EECloseAck`, the responder waits for the initiator's final
confirmation — and **exactly two** on the simultaneous path, because the transition into that
branch does not end the first wait's obligation: the endpoint has received the peer's `E2EEClose`
but not yet the peer's ack, and the wait for that ack is a second step. No path admits a third,
in either branch or either role. §3.2.2 L5 charges `T_CLOSE` twice for exactly this reason and
sizes it, together with `T_CLOSE_LINGER_MAX`, so that `2 · T_CLOSE + T_CLOSE_LINGER_MAX` still
fits inside one `RPC_KEEPALIVE_INTERVAL` with the flush margin reserved. An implementation MUST
NOT restart or extend a wait on any other event.

**The keepalive `Ping` is an application RPC record for the purposes of §10.** This is normative
and it resolves the only reading under which the prohibition above would be ambiguous: the
pinned transport keepalive writes an ordinary RPC message, and on an `e2ee` channel that message
is protected like any other (§4.4). Once an endpoint has sent its first close-machine record it
MUST NOT protect a keepalive `Ping`, exactly as it MUST NOT protect any other RPC record. The
prohibition is load-bearing rather than tidy: the §10.1.1 close anchor is fixed at that record's
position, and any record protected after it moves the peer's expected-receive state past the
anchor, so the peer's `E2EECloseAck` would then fail the strict rule at the very endpoint that
sent the stray `Ping`. An implementation that exempted the keepalive would break every close it
participated in, and would do so against a conforming peer.

A `Ping` the close phase stalls is **discarded, not buffered**: unlike the `negotiating` window
of §4.4 there is no later moment at which it could be flushed, because the channel ends when the
phase ends. The consequences for the transport's own dead-peer verdict are bounded by §3.2.2 L5,
which sizes `T_CLOSE` and `T_CLOSE_LINGER_MAX` so the whole close phase fits inside one
`RPC_KEEPALIVE_INTERVAL`, and are stated in full — including the part L5 does not remove — in
§10.3 and §17.14.

Sequential close:

| Step | Endpoint  | Action                                                                                                                                                                                                                                                                                       |
| ---- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | Initiator | Sends `E2EEClose` as its final application-phase record; waits                                                                                                                                                                                                                               |
| 2    | Responder | Authenticates the close in sequence; validates §10.1 (passed-through rule); stops sending RPC; sends `E2EECloseAck` (its own final state declaration); waits                                                                                                                                 |
| 3    | Initiator | Validates the ack (strict rule, against the initiator's close anchor, which names its own `E2EEClose`, §10.1.1 — at this point the whole of its stream, since it has sent nothing since); sends a final `E2EECloseAck` (the **final confirmation**, strict fields); its exchange is complete |
| 4    | Responder | Validates the final confirmation (strict rule, against the responder's close anchor — its own `E2EECloseAck`, §10.1.1 — proof the initiator received the responder's entire stream, including that ack); its exchange is complete                                                            |

**Simultaneous close.** An endpoint that receives `E2EEClose` after having sent its own treats
the exchange as simultaneous: each side validates the peer's close under the passed-through
rule, responds with `E2EECloseAck` (strict fields, computed after processing the peer's
close), and completes when the peer's ack validates under the strict rule against that side's
close anchor — the advance of its own `E2EEClose` position (§10.1.1), never its current
next-send. Four records total, no final-confirmation step: each side's proof is the peer's ack.

The initiating endpoint, and each side of a simultaneous close, protects
`E2EE_CLOSE_RECORDS_RESERVED` close-machine records; §9.6's post-application reserve exists so
that budget is always available, including at sequence exhaustion, and it covers
`E2EE_ERROR_RECORDS_RESERVED` beyond it for the terminal error record defined below.

**What a complete exchange proves.** A completed exchange proves that the peer received and
authenticated, in order, every record the endpoint sent up to and including the close-machine
record its anchor names — no more:

- the sequential responder's anchor is its `E2EECloseAck`, the last record it sends, so its
  proof covers its entire stream;
- the sequential initiator's anchor is its `E2EEClose`; its final confirmation is itself
  unacknowledged;
- in simultaneous close both anchors are the two `E2EEClose` records, so **simultaneous close
  proves in-order delivery only up to each side's `E2EEClose`** — the two acks are themselves
  unacknowledged.

Consequently a dropped ack (simultaneous branch) or dropped final confirmation (sequential
branch) is not caught by the strict rule at all: the endpoint waiting for it reaches `T_CLOSE`
and records **Unclean — abrupt** (§10.4), unattributed. This is the two-generals limit already
conceded in §2.6 and §9.7 — the last record of any finite exchange is unacknowledged — and no
additional round trip removes it (§10.1.1).

**After the last close-machine record: exactly one terminal `E2EEError`, and nothing else.**
After sending its last close-machine record an endpoint MUST NOT protect any further
application-phase or close-machine record — no RPC record, no keepalive `Ping`, no further
`E2EEClose` or `E2EECloseAck`. It MAY, and per §11.3's procedure MUST when the send path is still
usable, protect **exactly one** `E2EEError` as the terminal record of a post-key fatal condition
detected at or after that point, and MUST NOT protect anything after that record. §9.6 reserves
capacity for it in addition to `E2EE_CLOSE_RECORDS_RESERVED`, so the obligation is satisfiable
even in the terminal epoch. This carve-out is exhaustive: no other record type, and no second
`E2EEError`, may follow the close machine.

The carve-out cannot disturb the §10.1.1 close anchor, which is the property the prohibition
exists to protect. The anchor is fixed at an endpoint's **first** close-machine record and is
validated by the _peer's_ strict-rule declaration; what would break it is a record protected
between that first record and the peer's proof, which is exactly what the paragraph above still
forbids. The terminal `E2EEError` is protected only once no further strict-rule validation of
this endpoint's stream can occur — either the exchange has completed, or it has just been
declared fatal — and §11.3 makes the record terminal in both directions, so no peer that receives
it answers with a close-machine record whose `expectedRecv` could have moved past the anchor.

**A record beyond the machine's expectation is a detected violation, not an unclean close.** An
earlier revision called it "unclean" here while §11.3 Q7 listed the same event as FATAL-POST,
which are mutually exclusive §10.4 verdicts with opposite obligations — one reports an
unattributed close and emits nothing, the other emits an encrypted error record — so two
conforming endpoints could produce different wire output on one trace. The single normative
outcome is:

- receiving any **envelope** beyond what the machine expects is FATAL-POST per §11.3 Q7, code
  `protocol_violation`, and the endpoint's verdict is **Failed** (§10.4);
- with exactly one exception: an authenticated envelope carrying an **`E2EEError`** (inner type
  `0x03`) is not a Q7 record. It is the peer's terminal record under §11.3, permitted after the
  close machine by the carve-out above, and the receiver erases secrets and closes **without
  replying** — a reply would be a second error record, which §11.3 forbids and §9.6 does not
  reserve. Its verdict is **Failed** (§10.4), which by §10.4's precedence supersedes a Clean
  verdict already recorded at exchange completion;
- receiving a **negotiation record, legacy JSON, or an unknown or absent first byte** during the
  close phase is FATAL-POST per §11.3 Q6 and rows N11/K18 of §4.4, likewise verdict **Failed** —
  the close phase adds no exemption to the `e2ee` rows and changes nothing about them.

**Unclean — abrupt** is reserved for the two events §10.4 lists and that this protocol declines
to attribute: a `T_CLOSE` expiry, and the channel, connection, or socket ending without a
completed exchange. Neither is a peer statement the endpoint can adjudicate; a record beyond the
machine's expectation is.

Close verdicts are per endpoint: the two ends of a channel can legitimately reach different
verdicts (for example, when the last confirmation is dropped); no protocol mechanism can
prevent that, and implementations MUST NOT report the peer's verdict as their own.

### 10.3 Outer `channel.close` ordering

**Lower bound (MUST).** An endpoint MUST NOT emit the outer relay `channel.close` — nor
otherwise tear down the channel or connection — until it has received the encrypted peer proof
its role requires:

- sequential initiator: the responder's valid `E2EECloseAck`;
- sequential responder: the initiator's valid final confirmation;
- simultaneous close: the peer's valid `E2EECloseAck`;

or until `T_CLOSE` expires, in which case it MAY close but MUST record **Unclean — abrupt**
(§10.4).
Enqueueing one's own final records is never sufficient: **enqueueing a record is not delivering
it**, and only the encrypted peer proof demonstrates delivery.

**Last-record linger (SHOULD).** Satisfying the lower bound does not by itself make it safe to
close, because an endpoint's role may still require it to _send_ one more record. The endpoint
that transmits the **last close-machine record of the exchange** — the sequential initiator's
final confirmation (§10.2 step 3), and each side's `E2EECloseAck` in the simultaneous branch —
holds a proof its peer does not yet hold, and per the paragraph below the relay may discard that
record when the channel closes. After transmitting it, such an endpoint SHOULD delay the outer
`channel.close` until the earliest of: observing the peer's `channel.close`, the transport
ending, or an implementation-chosen linger bound at most `T_CLOSE_LINGER_MAX`. The linger is a
courtesy to the peer's verdict, not a wait for anything owed: no further encrypted record is
expected, and the endpoint's own verdict is already determined by §10.4 and MUST NOT depend on
which of the three events ends the linger.

**The close phase is inside the client's keepalive budget, and where it is not, the transport
verdict is an accepted terminator.** §10.2 makes the keepalive `Ping` an application RPC record
for the whole close phase, so an E2EE-capable client writes no `Ping` from its first
close-machine record until the channel closes. `T_CLOSE` and `T_CLOSE_LINGER_MAX` are sized by
§3.2.2 L5 so that whole window — **both** `T_CLOSE`-bounded waits of the simultaneous branch plus
the linger — plus `T_KEEPALIVE_FLUSH_MARGIN` fits inside one
`RPC_KEEPALIVE_INTERVAL`; at the values an earlier revision carried it did not, and a Hub that
returned the peer proof just under `T_CLOSE` and withheld the peer's `channel.close` — letting
the linger run its full bound — turned a _successful_ authenticated close into a transport
timeout that tore down the connection and every channel on it, deterministically. The same Hub
strategy applied one step later — delivering the peer's `E2EEClose` just under `T_CLOSE` so the
endpoint enters the simultaneous branch and waits a second time — reached the identical outcome
against an L5 that charged `T_CLOSE` only once. L5 charges it twice and removes both cases.

L5 does not make the close phase immune, and this document does not claim it does. A `Ping`
written before the close phase whose `Pong` the peer can no longer send — because the peer has
itself entered a close phase and is under the identical prohibition — expires on the pinger's own
schedule, which no timer here bounds. The transport-level dead-peer verdict is therefore an
**accepted and expected** terminator of a close phase, and the specification is arranged so that
it costs nothing cryptographic:

- An endpoint MUST determine and record its §10.4 verdict at the instant its exchange completes
  or `T_CLOSE` expires, **before** and independently of the outer `channel.close` being emitted
  or delivered. A verdict MUST NOT be contingent on the socket surviving the linger.
- The `channel.close` of the paragraph below, and the linger itself, are best-effort courtesies.
  Losing the socket during the linger changes the peer's verdict, never this endpoint's, and MUST
  NOT be reported as a failure of this endpoint's exchange.
- An implementation MAY hold off the dead-peer verdict across a close phase using the same
  suspend/resume or synthesized-`Pong` facility §3.2.2 permits for `negotiating`, under the same
  conditions.

§17.14 records the residual.

**The two roles are complementary, and mutual waiting is forbidden.** The sequential responder
is not a last-record sender: on validating the initiator's final confirmation (§10.2 step 4) its
exchange is complete and it SHOULD close immediately, which is precisely what ends the
initiator's linger. In the simultaneous branch, by contrast, both endpoints are last-record
senders — each side's ack is unacknowledged by construction (§10.2) — so a rule requiring each to
await the peer's `channel.close` would deadlock every simultaneous close until `T_CLOSE`. The
bounded, non-blocking linger above MUST be used instead; an endpoint MUST NOT make its own close
conditional on the peer closing first.

This ordering is mandatory because of relay data-discard behavior on close: the relay protocol
gives **no delivery guarantee for channel data already queued when a channel closes** — queued
data for a closing channel can be discarded, and preservation of any queued frame at close is
relay-implementation-dependent, not a contract right ([relay-protocol.md](./relay-protocol.md)
defines close semantics without any queued-delivery promise). An endpoint that emits
`channel.close` while its final records may still be queued can therefore destroy the very
records the peer needs to verify the exchange. Only the encrypted peer proof demonstrates
delivery. After a clean exchange the endpoint SHOULD send `channel.close` without a reason —
the relay protocol's orderly close.

### 10.4 Close verdicts

| Verdict                  | Condition                                                                                                                                                                                                                                       |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Clean**                | The endpoint's complete close exchange verified (§10.2), every inbound record authenticated in order with no partial reassembly outstanding, and the strict-rule proof was received and validated against the endpoint's close anchor (§10.1.1) |
| **Unclean — truncation** | The relay chunk assembler holds an incomplete reassembled message when the channel ends: a partial reassembled message at close **is truncation**, regardless of any other state                                                                |
| **Unclean — abrupt**     | The channel, connection, or socket ends — including an outer `channel.close` arriving — without a completed close exchange, or a `T_CLOSE` expiry                                                                                               |
| **Failed**               | The channel was terminated by FATAL-POST (`E2EEError`, §11) or any fatal condition of §4.4/§9 — including every close-machine violation of §11.3 Q7 and every §10.2 record beyond the machine's expectation; never reported as clean            |

**Exactly one verdict per endpoint, resolved in this order:** **Failed**, then **Unclean —
truncation**, then **Unclean — abrupt**, then **Clean**. The truncation row's "regardless of any
other state" orders it above Clean and above abrupt — a partial reassembly is never explained
away by a completed exchange — and not above Failed: a detected protocol violation is the more
specific fact and is what the endpoint reports, though it MAY additionally record that
reassembly was incomplete. This ordering exists because §10.2 and §11.3 Q7 describe the same
event from two sides, and without it two conforming endpoints could disagree on the verdict for
one trace.

An abrupt close is reported **unclean, not attributed**: it may be ordinary network failure,
attacker denial of service, or a peer's own local send failure (§9.3, §9.7), and this protocol
claims no cryptographic attribution and no guaranteed detection of a dropped final message
(§2.6, §9.7). Implementations MUST NOT label an unclean close as an attack, and MUST NOT label
it clean.

**What Clean does and does not assert.** A Clean verdict is exactly the §10.2 statement and no
more: the peer received and authenticated, in order, everything this endpoint sent up to and
including the close-machine record its anchor names (§10.1.1). It never asserts that the peer
received this endpoint's _last_ close-machine record, because that record is unacknowledged by
construction — the sequential initiator's final confirmation, and both acks in a simultaneous
close. A Clean verdict at one end is therefore compatible with **Unclean — abrupt** at the
other when that last record is dropped, which is why §10.2 forbids reporting the peer's verdict
as one's own. In particular, in a simultaneous close each side's Clean verdict covers in-order
delivery of its own stream only up to its own `E2EEClose`; its `E2EECloseAck` is not covered.
Implementations and user-facing text MUST NOT present a Clean verdict as proof that the peer
completed its own exchange.

**When the verdict is fixed.** Every verdict above is determined and recorded at the moment its
condition is met — exchange completion, `T_CLOSE` expiry, the fatal condition, or the channel
ending — and never at the outer `channel.close` (§10.3). A close phase can outlive the transport
that carried it (§3.2.2 L5, §17.14), so a verdict contingent on the socket surviving the §10.3
linger would be unrecordable in exactly the cases an operator most needs it.

A condition of **higher** precedence arising after a verdict was recorded supersedes it; a
condition of lower or equal precedence never does. The two cases this reaches are both in the
window §10.2 opens after a completed exchange: a stray envelope (Q7) and a peer's terminal
`E2EEError` (§11.3) each make the verdict **Failed** even though **Clean** was recorded at
completion, while a `T_CLOSE` expiry or a socket loss during the §10.3 linger leaves the Clean
verdict standing. This is the ordering rule above applied over time rather than a second rule.

## 11. Errors and close-reason mapping

### 11.1 No new close reasons

Every E2EE-fatal condition maps onto the **existing** relay close reason `channel_rejected`, a
member of the relay contract's closed `RELAY_CLOSE_REASONS` set (§3.2), which this protocol
**adds none to**: it introduces no close-reason literal, no relay validation code, no relay frame
type, and no relay error field. Every close this document specifies **with a reason** — FATAL-PRE,
FATAL-POST, the §12.6 policy-withdrawal sweep, and the §13.6 authorization-withdrawal sweep alike
— MUST name a member of that set, and the relay contract's defining module remains authoritative
for its contents; after a clean exchange §10.3 has the endpoint send no reason at all. The
endpoint that detects a fatal condition emits the outer
relay `channel.close` with reason `channel_rejected` after completing the applicable procedure
below; the §10.3 ordering rule applies only to the authenticated close exchange, never to
fatal terminations, whose close verdict is **Failed** (§10.4).

Sender-local errors (§11.4) are API-level diagnostics and never appear on the wire.

_Note (non-normative)_: `channel_rejected`'s membership was verified against
`packages/contracts/src/relay.ts:57-77`, entry at `:73`, 2026-07-30. It is a
relay protocol minor 2 reason, which is compatible with the §8.1 precondition that every E2EE
channel is a minor 2 (or newer) channel. Extending the close-reason set would force a relay
protocol-minor, fixture, and codec cascade this design exists to avoid.

### 11.2 Pre-key failures (FATAL-PRE)

**The reject record.** `E2EEHandshakeReject` (negotiation type `0x03`, §3.4) is the only
pre-key error record. Its bytes are fixed completely:

```text
E2EEHandshakeReject = E2EE_NEGOTIATION_DISCRIMINATOR ‖ 0x03 ‖ body
body                = the canonical-CBOR byte string containing exactly
                      E2EE_HANDSHAKE_REJECT_PAD_BYTES zero-valued bytes
```

The total record length is exactly `E2EE_HANDSHAKE_REJECT_BYTES`. Every conforming reject
record is **byte-identical**: it carries no cause, no code, no text, and no variable field. A
received reject of any other length is itself malformed (§3.3). Only the node emits the
reject (§3.4 direction registry); a client executing FATAL-PRE sends nothing and closes.

**Procedure.** On any pre-key fatal condition the detecting endpoint MUST: stop processing the
triggering input immediately; (node only, when the channel is still writable) send the reject
record; erase any partial handshake state (§6.2 ephemerals, buffered negotiation records);
emit `channel.close` with reason `channel_rejected`; and deliver nothing to the application.
Pre-key failures MUST NOT create, refresh, evict, or delete any pending client-authorization
record (§13.6, §15) — the sole exception is the pairing flow of §13.2, which creates its bounded
pending record only after the §8.6 step 5 bindings verified, and which under an owner-opened
pairing window may additionally evict exactly one existing pending record to make room (§13.6).

**The reject is never gated on a durable write.** That single exception is also the only pre-key
failure class that carries an fsync, and an fsync on the response path dwarfs every
cryptographic step in the ordering of §8.6, so leaving it there would partition failure timing
by whether the client's key was already known. The rule is therefore stated over the whole class
rather than over one record: the node MUST NOT delay the `E2EEHandshakeReject` or the
`channel.close` on the durability of **any pending-class mutation reachable from a pre-key
path** — the creation of the new record, and equally the pairing-window eviction of an existing
one. The §15 caps and the §13.6 pairing-window reservation are evaluated **before** emission,
entirely in memory, so a cap-exceeding attempt outside a window still creates nothing and a
window-admitted attempt still emits the identical reject at the identical point; the eviction
target is _selected_ before emission and _committed_ after it. Both mutations — the delete and
the create, including the new record's §13.4 safety number — are committed after the reject and
the close, on a best-effort basis, and MUST be committed atomically with respect to each other so
that a crash cannot leave the slot freed without the record that was admitted into it (§13.2
step 3). Losing an uncommitted pending mutation to a crash is a benign availability event: the
client re-pairs. Naming only the created record here — as an earlier revision did — would have
left a conforming implementation free to perform the eviction synchronously inside the
pre-emission cap evaluation, partitioning failure timing by whether an owner-opened window was
active and turning owner CLI activity into a wire-measurable observable on an unauthenticated
path.

**Anti-oracle requirements.** Pre-key failure behavior MUST be uniform across causes:

- One record shape: the byte-identical fixed-size reject, or nothing. An implementation MUST
  NOT vary the record count, record size, close reason, or close timing structure by cause.
- No wire-visible diagnostics: no error strings, codes, stack fragments, or field echoes ever
  appear in any pre-key record or close.
- **Approval membership, parser detail, transcript values, and node-local owner state MUST NOT
  be distinguishable** from the wire response: an unknown, pending, or revoked client key
  (§13.6), a certificate parse or signature failure, a context-commitment mismatch, an expired
  prekey, a policy rejection, a saturated pending cap, and an owner-opened pairing window —
  whether or not the attempt matched its discriminator (§13.6) — all produce the identical
  observable result. Secret-dependent comparisons —
  context commitments (§8.6 step 7), confirmation tags (§8.8 step 5), key and fingerprint
  equality (§7.1) — MUST use constant-time comparison.
- Implementations SHOULD structure responder processing so that failure timing does not
  partition into cause-revealing classes; the §15 bounds run before expensive cryptography for
  resource reasons, and the residual coarse-timing exposure of a managed runtime is recorded
  in §17. The one partition this document is able to remove outright — the durable pending-class
  write, creation and eviction alike, which is orders of magnitude slower than any step it would
  otherwise follow — is removed by the MUST NOT above rather than left to this SHOULD.

**Pre-key condition table.** Every condition below maps to FATAL-PRE; the table is the
normative enumeration and each row cites its defining rule.

| #   | Condition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Detecting endpoint | Defined in                                 |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ------------------------------------------ |
| P1  | Legacy JSON first message under effective `requireE2EE`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | node               | §4.4 N1, §12.3                             |
| P2  | Advertisement unavailable — undersized connection (§5.5 U1: asserted `maxDataChunkBytes` below `E2EE_ADVERTISEMENT_MIN_CHUNK_BYTES`) — under effective `requireE2EE`. Evaluated once per relay connection, so every channel on it takes this row                                                                                                                                                                                                                                                                                                                                                                                                                                         | node               | §5.5, N15                                  |
| P3  | Negotiation record **in `negotiating`** exceeding its per-type bound, or of an unknown or misdirected negotiation type. A negotiation record in `legacy` is P24 regardless of its type or size                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | both               | §3.3, §3.4, N5/K8                          |
| P4  | Hello without an emitted advertisement, or a second hello or carrier on the channel                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | node / client      | N4, K4                                     |
| P5  | **Envelope** received before establishment or in `legacy` state — the envelope half of rows N13/K21; the negotiation half is P24                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | both               | N6/N13, K11/K21                            |
| P6  | Unknown **or absent** first byte in any state — the absent case is a zero-length post-strip payload (§3.4)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | both               | §3.4, §4.3 step 2, N7/N14, K12/K22         |
| P7  | `T_HANDSHAKE_NODE` expiry from advertisement emit under effective `requireE2EE` (silent peer, oversized or excessive negotiation exchange, timeout alike)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | node               | N8                                         |
| P8  | Any §15 concurrency, rate, or size bound exceeded                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | node               | §15                                        |
| P9  | Hello wrapper failure: strict-decode failure, an `e2eeVersion` outside the protocol range the node advertised on this channel (§7.6 elements 7–8) or not implemented by it, tier not admitted by policy, `selectedSuite` not in both registries, wrong field length                                                                                                                                                                                                                                                                                                                                                                                                                      | node               | §8.6 step 2                                |
| P10 | Noise processing failure: AEAD failure, malformed message, all-zero X25519 output                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | both               | §8.1, §8.6 step 4, §8.8 step 3             |
| P11 | IK binding failure: client certificate invalid, expired (with `E2EE_MAX_CLOCK_SKEW`), namespace mismatch, Noise static not byte-equal to the certificate key, usage-field mismatch                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | node               | §8.6 step 5                                |
| P12 | Authorization failure: client record absent, pending, or revoked; capability outside the approved set; role above the approved ceiling. Also the **in-flight withdrawal abort** — an owner authorization withdrawal (§13.6) committed after this handshake's §8.6 step 6 read and failing the withdrawal test against its admitted-authority snapshot. That abort takes this generic surface and never a `policy` code, which exists only post-key. Its node-policy counterpart is **P25**, a separate row on a separate ground                                                                                                                                                          | node               | §8.6 step 6, §13.6                         |
| P13 | Context mismatch: the reconstructed `contextCommitment` differing from the wrapper's, or any §8.3 exact-equality or absence rule violated — elements 11/13, elements 12/14 in **either** direction, a substituted element 9, element 10, or element 17, or the NX absence semantics of elements 10 and 16                                                                                                                                                                                                                                                                                                                                                                                | both               | §8.3, §8.6 step 7, §8.8                    |
| P14 | `plaintextCeiling` not positive at establishment                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | both               | §4.5                                       |
| P15 | Invalid **or unusable** capability statement while the channel's selection is latched (§12.1.1); includes a regressed policy generation, a continuity id disagreeing with the pinned value, an advertised protocol range excluding `E2EE_PROTOCOL_VERSION` or with `min > max` (§5.2 step 8), an empty suite intersection (§8.2), and an effective admitted pattern set omitting the pattern this client's tier runs (§5.2 step 9, §7.6 element 14)                                                                                                                                                                                                                                      | client             | K2, §5.2, §7.6, §8.2, §5.7, §12.1.1, §13.3 |
| P16 | `E2EEServerAccept` without a sent hello, or failing any §8.8 step 1–5 check                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | client             | K6                                         |
| P17 | `E2EEHandshakeReject` received after a hello                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | client             | K7                                         |
| P18 | Non-carrier legacy JSON while the selection is latched (§12.1.1), while local policy forbids legacy, or after a hello was sent                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | client             | K10                                        |
| P19 | `T_ADV` expiry with the selection latched (§12.1.1) or local policy forbidding legacy                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | client             | K14                                        |
| P20 | `T_HANDSHAKE` expiry after hello emit without a valid accept. Reachable only because §3.2.2 L1 keeps the client's whole negotiating window inside one keepalive period; without L1 the transport dies first and this row never executes (§17.14)                                                                                                                                                                                                                                                                                                                                                                                                                                         | client             | K15                                        |
| P21 | Usable validated statement present but the client cannot proceed (unverified pin with no pairing attempt under way)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | client             | §4.4 no-legacy-after-evidence rule         |
| P22 | Unexpected selection (§12.1.1) — a resolved-but-unlatched pin; no resolved pin under a `(hubOrigin, accountId)` pair holding a verified pin; or no resolved pin under the pair while the device-level `anyNodeVerified(hubOrigin)` marker is set (§13.1), which is the account-scope-change case — in each case with no recorded owner legacy consent, on non-carrier legacy JSON or at `T_ADV` expiry. The channel closes and the §13.2.1 unexpected-node surface is raised locally; the wire surface is the ordinary generic one                                                                                                                                                       | client             | K23, K24, §12.1.1, §13.2.1                 |
| P23 | Advertisement unavailable — no conforming signed statement (§5.5 U2: §7.6.1 self-check failure, including an over-long Hub origin, an over-long transcript, a refused signing call, an advertised protocol range excluding the version the node implements, or an unresolvable continuity id under the §7.5 startup cross-check) — under effective `requireE2EE`. The node MUST also have failed startup when the condition was present at start; this row covers the case where it arose afterwards                                                                                                                                                                                     | node               | §5.5, §7.5, §7.6.1, N15                    |
| P24 | **Negotiation record received in `legacy` state** — any type, any size, in either direction, including a correctly sized and correctly directed `E2EEClientHello` or `E2EEServerAccept`, which is neither over-bound nor misdirected and so is not P3, and is not an envelope and so is not P5. No session keys exist in `legacy`, so the disposition is FATAL-PRE and never FATAL-POST                                                                                                                                                                                                                                                                                                  | both               | N13/K21, §4.4 one-way-transitions rule     |
| P25 | **Policy-withdrawal in-flight abort** — a §12.6 policy withdrawal durably committed after this handshake's §8.6 step 2 read and before its row-N3 transition, whose narrowed policy would refuse the handshake's tier or selected suite. It is P9's condition re-evaluated after step 2 rather than at it, which is why it is its own row: P9 is defined at step 2 and a fixture naming P9 would assert a refusal the node did not make there. Like P12's second clause it takes the generic surface — the fixed-size reject and `channel_rejected` — and **never** a `policy` code, which exists only post-key; the established-channel counterpart of this transition is `Q12` (§11.3) | node               | §12.6, §8.6 step 2                         |

**Every fatal input in `legacy` and in `negotiating` matches exactly one row above.** Rows
N13/K21 accept two input classes, and each has its own condition here: an envelope
after a legacy lock is P5, a negotiation record after a legacy lock is P24, and an unknown or
absent first byte is P6 (rows N14/K22). In `negotiating`, a negotiation record that is over-bound,
of an unknown type, or misdirected is P3, a second hello or carrier is P4, and a well-formed
hello or accept is the ordinary path (rows N3, K1, K5). A fixture naming a §11 row for a
legacy-lock injection case therefore has exactly one row to name (§16.2, §16.3 F10); the wire
outcome of P3, P5, P6 and P24 is the identical generic FATAL-PRE, so the distinction is one of
enumeration and diagnosis, never of observable behavior.

Rows P2 and P23 are node-local _availability_ conditions, not peer-input failures. They are
listed here because their wire surface is identical to every other FATAL-PRE — a generic
fixed-size reject and `channel_rejected`, revealing nothing about the cause — while their
node-local surface is a specific operator diagnostic (§5.5). No client-observable behavior
distinguishes them from any other pre-key failure.

Rows P12 (second clause) and P25 are node-local _owner- and operator-action_ conditions, likewise
not peer-input failures: they fire when a §13.6 authorization withdrawal or a §12.6 policy
withdrawal lands on a handshake already past the step whose read admitted it. They are enumerated
here for the same reason P2 and P23 are — the wire surface is the identical generic FATAL-PRE, and
§16.2 requires every expected failure to name a row of this table, which §16.3 F16 and F18 both
rely on. Neither may be reported to the peer with a distinguishable signal; the counts §12.6 (c)
and §13.6 require are operator-facing only.

### 11.3 Post-key failures (FATAL-POST) and `E2EEError`

Once session keys are established, fatal conditions are signaled inside the encrypted channel.
`E2EEError` (inner type `0x03`, §3.4) has the body:

```text
E2EEError body = canonical-CBOR array [ errorCode (uint) ]
```

bounded by `E2EE_ERROR_BODY_MAX_BYTES`. Error codes:

| Code       | Name                 | Meaning                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0x01`     | `protocol_violation` | A §4, §9, or §10 fatal condition was detected on peer input                                                                                                                                                                                                                                                                                                                                                      |
| `0x02`     | `internal`           | A local failure unrelated to peer input                                                                                                                                                                                                                                                                                                                                                                          |
| `0x03`     | `policy`             | An owner **authorization withdrawal** — revocation, role reduction, or capability removal — terminated the channel (§13.6, Q9); or a **policy withdrawal** — a node admission policy narrowed so that the channel would no longer be admitted — terminated it (§12.6, Q12). Both clauses name a defined transition with an ordered procedure; neither is a general licence to close a channel and call it policy |
| all others | reserved             | The channel still closes; a reserved code is not separately actionable                                                                                                                                                                                                                                                                                                                                           |

This table is the sole definition site of the encrypted error-code registry; §3.4 delegates to
it rather than restating it. Every defined code encodes to the same body length, so every
`E2EEError` envelope is length-identical: the relay observes only that one more fixed-size
encrypted record was sent.

**Procedure.** On a post-key fatal condition the detecting endpoint MUST: stop delivering
records; when the send path is still usable, emit one `E2EEError` inner record — consuming the
normal directional sequence (§9.1) — with the applicable code; erase all session secrets
(§9.5); and emit `channel.close` with reason `channel_rejected`. When the send path is
unusable, it closes without the error record. A received `E2EEError` is itself terminal: the
receiver erases secrets and closes; it MUST NOT reply.

**The procedure applies unchanged during and after the close phase, and this is the only record
permitted there.** A fatal condition detected between an endpoint's first close-machine record
and the channel's end — including one detected after the endpoint's own exchange has already
completed — takes this procedure like any other: one `E2EEError`, then the close. §10.2 states
the matching permission from the close machine's side and confirms that the record cannot disturb
the §10.1.1 close anchor, and §9.6 reserves `E2EE_ERROR_RECORDS_RESERVED` of capacity beyond
`E2EE_CLOSE_RECORDS_RESERVED` so the emission is possible even in the terminal epoch. Because a
received `E2EEError` is terminal in both directions, the exchange contains at most one such record
in total, and the receiver's obligation not to reply is what keeps it at one: §10.2 classifies a
received `E2EEError` in that window as this terminal record and **not** as a Q7 envelope beyond
the machine's expectation.

**Post-key condition table** (all map to FATAL-POST with code `protocol_violation` unless
another code is named):

| #   | Condition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Defined in                         |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| Q1  | Envelope `version` or `suite` differing from established session state                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | §4.3, §9.1                         |
| Q2  | Transmitted epoch/counter not equal to the receiver-expected pair; epoch transition other than exactly +1 with counter 0 at the exact boundary. Fatal, but **not attributable**: the same gap arises from a peer's post-AEAD local send failure (§9.3, §9.7)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | §9.2                               |
| Q3  | AEAD authentication failure                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | §4.3                               |
| Q4  | Envelope shorter than `E2EE_ENVELOPE_OVERHEAD_BYTES`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | §3.3                               |
| Q5  | Reserved inner-record type                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | §3.4, N10/K17                      |
| Q6  | Negotiation record, legacy JSON, or unknown **or absent** first byte in `e2ee` state — the absent case is a zero-length post-strip payload (§3.4). A close phase in progress grants no exemption: this row applies unchanged from the first close-machine record to the channel's end (§10.2)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | §3.4, §4.3 step 2, N11, K18, §10.2 |
| Q7  | Close-machine violation: decode failure, envelope-header mismatch, commitment mismatch, passed-through-rule failure (against the receiver's current next-send), strict-rule failure (against the receiver's **close anchor**, §10.1.1 — not its current next-send), and any **envelope** beyond what the machine expects, with the single exception of an authenticated `E2EEError`, which §10.2 classifies as the peer's terminal record of this section rather than as a Q7 envelope. Every Q7 condition yields close verdict **Failed** (§10.4) and never an unclean verdict; a non-envelope payload in the same window is Q6, and is equally Failed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | §10.1, §10.1.1, §10.2, §10.4       |
| Q8  | Implicit-finish deadline (`T_HANDSHAKE_NODE`) expiry, under **every** policy including the compatibility default                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | §8.9                               |
| Q9  | **Authorization withdrawal** against an active E2EE channel — a channel whose node-side mode machine is in `e2ee`, whether or not its implicit finish has authenticated. The transition is any of `status` leaving `approved` (including revocation and record deletion), a `maxRole` reduction under the §8.3 role ordering, or a `capabilitySet` removal, applied to a record whose key matches the channel's §8.6 step 6 admitted-authority snapshot and failing the §13.6 withdrawal test against it (code `policy`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | §13.6, §8.9                        |
| Q10 | Local internal failure (code `internal`). Includes a post-AEAD send failure that reached no byte of the relay, which per §9.3 closes **without** an `E2EEError` because the error record would itself create the sequence gap being avoided                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | §9.3, this section                 |
| Q11 | `E2EEError` body oversized, non-canonical, or structurally invalid                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | this section                       |
| Q12 | **Policy withdrawal** against a live `e2ee` channel — a node admission policy narrowed so that the channel's own admitted state would no longer be admitted: `requireApprovedClientE2EE` becoming true, a suite leaving the advertised registry, or a pattern leaving the effective admitted set. (Effective `requireE2EE` becoming true is also a §12.6 narrowing, but it withdraws only `legacy` channels, which this table excludes; it never reaches a live `e2ee` channel and so is not a clause of this row.) Evaluated per channel by the §12.6 policy-withdrawal test and swept before the operator command is acknowledged (code `policy`). Unlike Q9 it is keyed on the channel's tier, suite, and mode rather than on a Branch A record, so it reaches NX channels, which hold no record and no snapshot. The clauses are not uniformly tier-scoped and §12.6 fixes which is which: the `requireApprovedClientE2EE` and admitted-pattern clauses reach **NX channels only**, because §8.6 step 6 admitted no IK channel without an `approved` record; the **suite** clause is tier-independent and reaches an IK channel established on the withdrawn suite exactly as it reaches an NX one. The pre-key counterpart of this transition, on a handshake that has not reached row N3, is `P25` (§11.2) | §12.6, §12.3, §12.4                |

Sequence exhaustion (§9.6) is deliberately **not** in this table: it is handled by the
authenticated close of §10, not by an error. A `legacy` channel closed by a §12.6 policy
withdrawal is likewise not in this table: it holds no session keys, so no `E2EEError` exists to
send and §12.6 defines its disposition — a bare `channel.close` with reason `channel_rejected`,
and in particular **not** an `E2EEHandshakeReject`, which is a negotiation record and would be
row N13/K21 at the peer.

### 11.4 Sender-local errors

- **`e2ee_message_too_large`** — raised when an inner-record body exceeds `plaintextCeiling`
  (§4.5). It is a sender-local API error: the record MUST NOT be encrypted or transmitted, no
  wire record of any kind is produced, and the channel is unaffected and remains usable. It is
  deliberately distinct from the relay chunk layer's `message_too_large`, which fires on the
  encrypted byte count; a conforming sender that enforces the plaintext ceiling never triggers
  the relay error for E2EE payloads.
- **`e2ee_send_unavailable`** (§9.3, §4.4) — raised when the sender cannot obtain transmission
  admission for the entire record before protecting it (relay send queue full, or the send path
  otherwise unable to accept every chunk), and equally when a client's `negotiating` send buffer
  is already at `E2EE_NEGOTIATION_BUFFER_MAX_BYTES` (§4.4). Because §9.3 requires admission
  _before_ the pair is assigned, no `(epoch, counter)` is consumed, the record MUST NOT be
  encrypted or transmitted, no wire record of any kind is produced, and the channel is
  unaffected and remains usable. It is the correct disposition for ordinary backpressure, which
  MUST NOT be escalated to a channel-fatal condition. The two cases share one code deliberately:
  to the caller a full negotiation buffer and a full send queue are the same backpressure, and
  giving them separate codes would invite an implementation to treat one of them as fatal.
- **`e2ee_prekey_expired`** (§6.4) — a local diagnostic and API code attached to prekey
  validity failures. On the wire the failure remains the generic surface of this section.
- **`e2ee_advertisement_unavailable`** (§5.5) — a node-local operator diagnostic raised when the
  node cannot emit its advertisement, carrying exactly one of the two §12.5 reason labels:
  `undersized-connection` (with the asserted `maxDataChunkBytes` and
  `E2EE_ADVERTISEMENT_MIN_CHUNK_BYTES`) or `statement-unavailable` (with the failing §7.6.1
  bound, or the unresolvable continuity-id condition of §7.5 and the recovery command it names).
  It is node-local and MUST NOT alter the wire surface, which stays P2/P23 under
  effective `requireE2EE` and silent suppression otherwise. It exists so an operator can
  distinguish a squeezed or misconfigured connection from a genuinely legacy client population,
  which the fallback counter alone cannot (§12.5).
- **`e2ee_policy_generation_regressed`** (§5.7) — a client-local diagnostic distinguishing a
  policy-generation regression from every other invalid-statement cause, so an owner or support
  path can tell a restored node from a corrupt or substituted one. It is local-only: the wire
  behavior is rows K2/K3 and, when latched, P15, byte-identical to any other invalid statement.
  It MUST NOT by itself launch the §13.2 ceremony or the §13.3 re-verification UI (§5.7).

Local diagnostic codes MUST NOT alter wire behavior: two failures with different local codes
are indistinguishable on the wire.

### 11.5 Acceptance observable

The named acceptance observable for E2EE-fatal handling is:

> For every pre-key E2EE-fatal condition, the complete externally observable behavior of the
> affected channel is (a) at most one `E2EEHandshakeReject` record, byte-identical across all
> causes and exactly `E2EE_HANDSHAKE_REJECT_BYTES` long, emitted only by the node and only
> while the channel was writable; (b) an outer `channel.close` with the existing reason
> `channel_rejected`; and (c) zero application payload in either direction. For every post-key
> fatal condition it is at most one length-uniform encrypted record — none when the send path is
> unusable (§11.3), including the post-AEAD send failure of §9.3 and the exhausted-reserve case
> of §9.6 — followed by the same close reason. This holds for a fatal condition detected during
> or after the close phase as well: §10.2 permits exactly one terminal `E2EEError` there and
> §9.6 reserves the capacity for it, so the count is one, never two and never zero for want of
> sequence space. No new close-reason literal exists anywhere in the system.

## 12. Downgrade resistance and node policies

### 12.1 The latch

The latch is a client-side downgrade lock carried **on a pin record** (§13.1), whose latched
value is the pin's verified node identity fingerprint (§7.1, `ryco.node-key.v1`). It is never
keyed by the Hub-minted `nodeId`, which the Hub can reissue at will. A set latch means:
channels that resolve to that pin MUST negotiate E2EE; legacy fallback and absent or invalid
advertisements are fatal (rows K2, K10, K14 of §4.4).

- **Set condition (native).** A native client sets the latch when it has authenticated a
  capability statement to an **already verified** pin or identity-continuity chain (§5.2,
  §13.3), or when it has completed the mutual pairing ceremony of §13.2. Merely validating a
  self-signed first-contact statement MUST NOT set the latch, exactly as it MUST NOT set a
  trusted pin (§5.2). A matching continuity id (§7.5) never satisfies this condition — including
  when it agrees as §8.3 element 17, which proves only that the two endpoints expected the same
  lineage.
- **Native** persists the latch durably in the pin record, together with the verified
  fingerprint and the highest accepted policy generation, in the device-only,
  non-synchronizing, non-backup storage class of §6.3. A latched native client never silently
  falls back on any channel that resolves to that pin, across restarts and across channels —
  for the life of the pin record, which §13.1.1 bounds honestly: that class does not survive
  reinstall, restore, device transfer, or a secure-store reset. Because the resolution is from
  the client's own selection (§12.1.1), the guarantee holds for as long as the record does, even
  when the Hub delivers no evidence at all.
- **Web (tier-specific set condition, narrowly scoped exception).** The web client sets an
  in-memory latch, keyed `(hubOrigin, accountId, nodeId)`, on the **first capability statement
  it validates** (§5.2) for that node in the application session — including a self-signed
  first-contact statement, which is the exception to the native set condition above. It is set
  on statement validation, not on handshake completion, so a Hub that lets the statement
  validate and then fails the handshake cannot leave the retry channel unlatched. **Validates**
  means §5.2 steps 0–7, the validity checks. A statement that is valid but **unusable** under
  §5.2 step 8, §5.2 step 9, or §8.2 has validated and therefore sets the latch, so such a channel
  takes K2 (`P15`) rather than K3 and no buffered plaintext is flushed at `T_ADV`. That is the
  fail-closed direction, and it is stated rather than left to be derived so no implementation
  defers the latch until it has a hello it can build. This
  in-memory latch is **not a pin**: it MUST NOT be treated as a verified pin, MUST NOT promote
  any pin state, MUST NOT activate the active-Hub guarantee (§2.2, §5.2), MUST NOT persist
  beyond the application session, and MUST NOT satisfy any §13 release gate. Its only effect
  is rows K2, K10, and K14, which are therefore reachable on web; rows K23/K24 are not, because
  web has no pins and so never produces an _unexpected_ selection (§12.1.1).
- **Web threat scope (bounded, and it MUST be disclosed as bounded).** The web latch resists a
  same-session downgrade only while the served code is honest. It buys nothing against the Hub
  under any keying, because the Hub serves every byte of the code that implements it (§2.4) —
  which is also why `nodeId` keying is sufficient here and `(hubOrigin, accountId)` keying
  would only cost availability against genuinely un-upgraded nodes. Its real value is the same
  bounded claim §13.5 makes for the `WebSAS`: accidental wrong-node routing and some non-Hub
  network interposition. Before the first validated statement of a session, and in every fresh
  session, web has no downgrade resistance at all (§2.3, §17.5).
- Same node identity under a new Hub-minted `nodeId` is continuity (the pinned fingerprint is
  unchanged). A fingerprint change on a channel that resolves to a **verified** pin is an
  identity-change event handled by §13.3 — never a silent new node. A channel that resolves to
  **no** verified pin is
  not thereby a new node either: §12.1.1 classifies it, and §13.2.1 presents it.

#### 12.1.1 Selection resolution and latch evaluation (normative)

The latch guards of §4.4 must be answerable at `channel.accept`, before any payload arrives —
otherwise a Hub that simply withholds or delays the carrier past `T_ADV` makes every guard
evaluate as "not latched" and every conforming client flushes plaintext. The evidence the Hub
withholds is therefore never an input to these guards.

- **Provenance of every scope component (normative).** These guards are only as strong as the
  weakest component of the scope they are indexed by, so each one's origin is stated rather than
  assumed:
  - `hubOrigin` — **client-anchored**. It is the origin the client configured and is actually
    connected to, checked against every statement at §5.2 step 4. The Hub does not choose it.
  - `localNodeHandle` — **client-generated** at §13.2 pairing, never Hub-supplied, never derived
    from `nodeId`, never re-minted by anything the Hub sends (§13.1).
  - `nodeId` — **Hub-minted and reissuable at will**, which is why it is never a trust anchor and
    only ever an untrusted resolution hint (§12.1, §13.1).
  - `accountId` — **Hub-issued and not client-anchored**. It is opaque to the client (§7.1), the
    client never verifies it against anything, and the Hub can present a different value on the
    next authentication with no owner-visible change. §13.6 concedes the matching node-side
    point: it is a client claim authenticated only for self-consistency.

  It follows that **no guard in this document may rest a downgrade decision on `accountId`
  alone**, in either direction. Where a rule uses the `(hubOrigin, accountId)` pair, an
  account-scope change MUST be able to move a selection only _into_ a stricter class, never into
  the legacy-eligible one — which is what the device-level marker below enforces. Rules that
  _relax_ on a pair are the ones a Hub re-mint would shed, and they are enumerated and corrected
  here: the legacy-eligible branch (a) below, the account-wide strict-mode policy below, and the
  first-contact substitution surface of §5.2 and §13.2.1.

- **Selection.** Every client channel is opened against a **selection**: the client-local node
  handle the owner chose. On native the handle is client-generated at §13.2 pairing and is
  never Hub-supplied; the client keeps it in the pin record (§13.1). On web the selection is
  the in-memory `(hubOrigin, accountId, nodeId)` triple of §12.1. §8.3's construction rule
  already presumes this handle exists, since element 9 must come "from the selection … not
  from relay frames it later receives".
- **Resolved pin.** At `channel.accept` the client resolves the selection to at most one pin
  record under `(hubOrigin, accountId)`. Resolution MAY consult the Hub-minted node ids
  recorded as untrusted hints in the pin record (§13.1). A validated statement MAY additionally
  resolve a channel whose selection resolved to no pin, by matching its continuity id (§7.5)
  against a pin under the same pair; such a late resolution can only **tighten** the
  classification below, never move a channel into the legacy-eligible class.
- **Why an untrusted hint is safe here.** Misresolution cannot release anything. A Hub that
  suppresses a hint produces _no_ resolution, which lands the channel in the unexpected class
  and demands owner consent; a Hub that induces a resolution to the wrong pin produces a
  channel whose statement cannot match that pin's fingerprint or chain, which is §13.3 fatal.
  The pin's verified fingerprint and the continuity chain remain the only trust anchors; the
  hint decides only which strict guard applies.
- **Classification.** Every selection is exactly one of:
  - **latched** — a pin resolves and its latch is set. Legacy is unreachable. Recovery from a
    node that genuinely lost E2EE support is the owner-initiated re-pair of §13.3, never a
    legacy consent.
  - **legacy-eligible** — the resolved pin, if any, is not latched, and either (a) no pin
    resolves, the `(hubOrigin, accountId)` pair holds no verified pin, **and the device-level
    `anyNodeVerified(hubOrigin)` marker of §13.1 is unset** — that is, this install has never
    verified any node on this Hub origin under _any_ account scope — or (b) the owner has
    recorded explicit legacy consent for this selection (§13.1).
  - **unexpected** — everything else. The three clauses below are illustrative, and each is
    subject to the same exclusion: a selection for which the owner has recorded explicit legacy
    consent is claimed by legacy-eligible branch (b) and is never unexpected. The clauses are
    (i) a pin resolves but is not latched; (ii) no pin resolves while the `(hubOrigin,
accountId)` pair holds at least one verified pin; (iii) no pin resolves under the pair while
    `anyNodeVerified(hubOrigin)` is set. Evaluate the three classes in the order stated above —
    latched, then legacy-eligible, then unexpected — which resolves every selection identically
    to the precise rule of §11.2 P22.
- **Why branch (a) is scoped to the Hub origin and not to the pair.** The `(hubOrigin,
accountId)` pair is half Hub-chosen (see provenance above), so a pair test alone is a guard the
  Hub can retire by re-minting the account identifier: a fully verified, latched device resolves
  its selection under the new pair, finds no pin and no verified pin _in that pair_, and would
  classify as "genuine first contact" — after which withholding the carrier reaches row K13 and a
  plaintext flush. The `anyNodeVerified(hubOrigin)` marker closes that: it is written only by the
  owner's §13.2 step 5 verification and read under the client-anchored `hubOrigin` alone, so an
  account-scope change lands in **unexpected** (rows K23/K24, §11.2 P22) and raises the §13.2.1
  surface instead of releasing plaintext. Note the asymmetry this restores: on the node side the
  same re-mint already fails **closed**, because §8.6 step 6 looks up `(hubOrigin, accountId,
clientIdentityFingerprint)` and finds no record (§11.2 P12). Before the marker, the client
  failed _open_ on exactly the input the node failed closed on.
- **The marker never relaxes anything.** It can only move a selection from legacy-eligible to
  unexpected, never the reverse, and it is not evidence about the node on the channel: it says
  only that this install has completed at least one §13.2 ceremony on this Hub origin. It is
  native-only; web has no durable state and its degenerate mapping below is unaffected. Because
  the whole guard is the marker, losing it must not be easier than losing the pins it summarizes:
  §13.1 requires it to be a lower bound on the verified-pin set, committed atomically with the
  promotion that sets it and reconciled from the pin set before any classification is evaluated.
  A client that could hold a verified pin with the marker unset would still fall to the account
  re-mint described above.
- **Web mapping.** Web has no pin records, no durable consent, no verified-pin scope, and no
  verification marker, so
  the classification degenerates: a web selection is **latched** when the §12.1 in-memory latch
  is set for its `(hubOrigin, accountId, nodeId)` triple in the current application session, and
  **legacy-eligible** otherwise. Web never produces an _unexpected_ selection, and consequently
  never raises §13.2.1. This degeneracy is the mechanism behind the honest web statement in
  §2.3 and §17.5, not an oversight.
- **Unexpected selections never lock legacy silently.** They are FATAL-PRE (rows K23, K24;
  §11.2 P22) and raise the owner-visible surface of §13.2.1. Buffered application sends are
  discarded, never flushed. This is what closes the `nodeId`-remint variant: the Hub can
  manufacture an unrecognized selection at will, but it cannot manufacture owner consent. When
  local policy forbids legacy outright, the channel is instead row K10/K14 (§11.2 P18, P19); the
  §13.2.1 surface is still raised for an unexpected selection, but it offers pairing only, since
  a legacy consent is unavailable under that policy. The **`accountId`-remint variant** closes the
  same way and for the same reason: the Hub can manufacture a fresh account scope as easily as a
  fresh `nodeId`, and under the marker rule above both land here rather than in legacy-eligible.
- **Consent is explicit, per selection, and durable.** Accepting legacy for an unexpected
  selection is an owner action recorded per §13.1; it is never inferred from a timeout, a
  retry, a dismissed dialog, or a repeat occurrence, and it never applies to a latched pin.
- **Strict mode is an opt-in, never automatic, and it is recorded per Hub origin.** A client MAY
  offer the owner a local policy of "never legacy on this Hub", which makes local policy forbid
  legacy for every selection under that `hubOrigin` — the "policy forbids legacy" guard of rows
  K10/K14. It MUST NOT be a silent consequence of the first verified pin: turning it on
  automatically makes a genuinely un-upgraded node unreachable during exactly the compatibility
  window §12.3's default-`false` `requireE2EE` exists to protect. It MUST be recorded and
  evaluated under `hubOrigin` alone and MUST NOT be keyed on `(hubOrigin, accountId)`: a
  pair-keyed strict mode is a downgrade guard resting on a Hub-issued value, which the Hub sheds
  by re-minting the account scope. The cost is that the policy also covers any other account
  scope the owner uses on the same Hub, and the setting's copy MUST say so.

### 12.2 Fallback rule

- **Never probe.** A client with no validated capability evidence MUST NOT send any
  negotiation record and MUST NOT infer E2EE support or policy from any failure (§5.1).
- **Bounded wait.** The client waits at most `T_ADV` from `channel.accept` for the
  advertisement, buffering every plaintext send including keepalives (§4.4). On expiry it locks
  the channel to legacy before its first RPC message (row K13) and flushes as plaintext **only
  if** the selection is legacy-eligible (§12.1.1) and local policy permits legacy. A latched
  selection is fatal (row K14) and an unexpected selection is fatal plus the §13.2.1 owner
  surface (row K24); in neither case is buffered data flushed.
- **No reopen.** Fallback happens on the **same channel** that waited: the advertisement, the
  wait, and the legacy lock share one channel, and same-channel continuation is possible under
  the current runtimes (§5.1 note). This protocol therefore defines no fallback reopen, and an
  implementation MUST NOT close and reopen a channel — burning a single-use ticket — to probe,
  to fall back, or to switch modes. If a future runtime change ever makes same-channel
  continuation impossible, this specification MUST be revised to define the exact single
  bounded reopen before any implementation adds one.
- **Honest labeling.** A client that falls back MUST label the channel **legacy** in every
  user-facing surface and diagnostic and MUST NOT display any E2EE or active-Hub
  confidentiality claim for it. A missing or stripped advertisement causing plaintext fallback
  on a **legacy-eligible** selection (§12.1.1) is the explicitly retained downgrade exposure of
  the compatibility window (§2.3, §17.4) — and "missing" includes an advertisement the node
  itself could not emit because the Hub asserted a data-chunk limit below
  `E2EE_ADVERTISEMENT_MIN_CHUNK_BYTES` (§5.5 U1). Its bound is not "first contact has passed":
  a Hub that re-mints the `nodeId` — or the `accountId`, which it also issues — and withholds the
  carrier can synthesize an unrecognized selection at any time. The bound is that such a selection
  is legacy-eligible only on a `hubOrigin` whose device-level `anyNodeVerified` marker is unset
  and under a `(hubOrigin, accountId)` pair holding no verified pin, or after explicit owner
  consent — plus, at the node end, effective `requireE2EE`. Labeling does not close it; §12.1.1
  and node policy do. A device that lost its durable trust state (§13.1.1) satisfies the marker
  test vacuously, which is the exposure §17.11 records.

### 12.3 `requireE2EE`

Node admission policy, default **false** at introduction.

- **Semantics.** After emitting its capability advertisement the node accepts, as the
  channel's first application-bearing input, only a valid `E2EEClientHello` arriving within
  `T_HANDSHAKE_NODE` of the advertisement emit. Legacy JSON is rejected (row N1); a silent peer,
  an oversized or excessive negotiation exchange, or a timeout closes generically (row N8). The
  same deadline extends through the implicit client finish, but that half of it is armed under
  every policy and is not part of what this one adds (§8.9). All failures are the generic
  FATAL-PRE surface of §11 — the policy adds no distinguishable rejection.
- **Scope of the guarantee.** `requireE2EE` closes exactly the **plaintext downgrade** path.
  It still admits unsigned web NX sessions, which a malicious Hub can originate (§2.2, §2.3),
  so it makes no whole-node active-Hub claim.
- **Enabling it is a policy withdrawal.** `requireE2EE` false → true is the §12.6 transition:
  before the CLI acknowledges the change, the node durably commits it, increments the policy
  generation, and closes every `legacy` channel — which is what makes the "Plaintext rejected" row
  of §2.3 true of the node's live channels and not only of its future ones. Nothing in this
  section takes effect on an open `legacy` channel by itself; §15 arms no idle deadline that
  would retire one.
- **Operator override, stated first because it is the primary path.** Independently of every
  criterion below, operators MAY enable `requireE2EE` at any time by explicit configuration.
  That path does not consult the fallback counter, cannot be delayed by anything the Hub does,
  and is the RECOMMENDED action for any operator who does not need legacy compatibility. The
  default flip is a shipping decision about _other people's_ nodes; it is not the mechanism by
  which a given operator obtains the guarantee. A default flip is a policy withdrawal like any
  other (§12.6): a node that starts under the new default with channels carried across a restart
  has none, because no channel survives a restart, but a node whose default is flipped by
  configuration while running MUST run the §12.6 procedure.
- **Default flip.** A later release MAY flip the default to true only when all of the
  following hold: both released client tiers speak E2EE in at least one shipped release each;
  the §14.1 scoped third-party audit of the handshake state-machine module is complete; and the
  node-side **peer-legacy** fallback counter (§12.5) shows, over a full
  `E2EE_FALLBACK_OBSERVATION_WINDOW` of representative use, **no occurrence attributable to a
  released legacy client tier**, as assessed by the maintainers from the counter, the shape of
  the occurrences retained in the §12.5 ring, and shipped-release telemetry.
- **Why the criterion is a judgement and not a zero test.** An earlier revision required the
  counter to read exactly zero. That made the gate forgeable by the party this protocol treats
  as the adversary: row N2 fires on the first unauthenticated `LEGACY-JSON` byte, before any
  hello, key, or §15 bound, so anyone who can originate a channel (§2.1 concedes the Hub can)
  can inject one legacy-first channel per window and hold a monotonic, manually-resettable
  counter above zero forever — pinning the compatibility default open at a cost of one channel
  per `E2EE_FALLBACK_OBSERVATION_WINDOW`. A **nonzero counter alone therefore MUST NOT block the
  flip.**
- **What the counter still buys, and what the amendment cost.** An earlier revision of this
  section kept, alongside the amended criterion, the safety claim the zero test had earned: that
  the counter "can be inflated but never suppressed, so it can never falsely permit a flip, only
  delay one". Half of that survives the amendment and half does not, and the difference is stated
  here rather than left standing.
  - _Survives._ The counter's **value** is a monotone lower bound on legacy acceptances on
    channels the node advertised on. It can be inflated and never deflated (§12.5), so no party
    can make a node under-report that legacy was accepted at all.
  - _Does not survive._ Under an attributability judgement the decisive evidence is no longer
    that value — a nonzero counter no longer blocks — but the per-occurrence shape retained in
    the §12.5 ring, and that ring is bounded and lossy. An adversary injecting legacy-first
    channels at a plausible, deliberately non-metronomic rate fills `E2EE_FALLBACK_RING_SIZE`
    within one window and evicts every genuine occurrence, leaving only attacker-authored entries
    for the maintainers to read. It can therefore drive the decision toward a **premature** flip
    — which turns row N1 into a hard lockout of every genuinely un-upgraded client — as readily
    as away from one. **Inflation biases the criterion in both directions.** The one-directional
    claim is withdrawn: it was a property of the zero test and is false of this one.
  - _Made visible, not repaired._ §12.5 therefore requires a per-class **ring-overflow counter**:
    a monotonic count of occurrences observed while the ring was already full. A nonzero overflow
    count for a window means the ring holds no complete account of that window, and the
    maintainers MUST NOT treat ring shape as evidence in **either** direction for it. That
    records the loss; it does not undo it, and nothing here does. It is deliberately **not** a
    hard block, because making overflow blocking would hand back the same fortnightly veto this
    amendment removed, merely repriced from one channel to `E2EE_FALLBACK_RING_SIZE`.
  - _Therefore._ For a window whose ring overflowed, the criterion's remaining inputs are a lower
    bound and shipped-release telemetry — which §12.5 forbids resting a security decision on, and
    which is itself Hub-relayed and suppressible. The honest conclusion is that the default-flip
    criterion is Hub-influenceable in both directions and is not a security mechanism. The
    operator override above is the only path whose outcome the Hub cannot influence, which is why
    it is stated first and is the RECOMMENDED action for any operator who does not need legacy
    compatibility.

  The ring still cannot be used to attribute
  individual occurrences — the stored fields are deliberately non-identifying (§12.5) — so
  per-occurrence
  accounting is not required and MUST NOT be introduced by widening what the ring retains. The
  residual is §17.15.

- **Why the criterion names one class.** The §12.5 **advertisement-unavailable** class (§5.5 U1
  and U2) is deliberately **excluded** from the criterion above. U1 is triggered by an
  integer the Hub asserts, so folding it into the gate would let the party this protocol treats
  as the adversary hold the counter above zero indefinitely and permanently veto the security
  rollout aimed at it. Exclusion is not dismissal: those occurrences MUST still be recorded,
  displayed separately, and reviewed as part of the flip decision (§12.5), and under effective
  `requireE2EE` the same conditions are already fail-closed (§11.2 P2, P23). What they must not
  do is silently masquerade as evidence that legacy clients still exist.

### 12.4 `requireApprovedClientE2EE`

Node admission policy, default **false**, and **never enabled by the `requireE2EE` default
flip** — it is a deliberate operator opt-in with an availability cost.

- **Implication.** `requireApprovedClientE2EE=true` implies effective `requireE2EE=true` even
  while the raw `requireE2EE` value is false (§1.2). The deterministic effective-policy rule
  is: effective `requireE2EE` = `requireE2EE` OR `requireApprovedClientE2EE`.
- **Admission.** Only the signed native IK tier with an approved client-authorization record
  (§13.6) and verified authority ceilings reaches application payload. Legacy is rejected
  pre-payload (row N1); an NX hello is rejected at the tier check (§8.6 step 2). The signed
  advertisement reports the raw policy values and an effective admission set of exactly
  `["IK"]` (§7.6 element 14) — it advertises only what is actually admitted. A conforming web
  client never sends that NX hello: §5.2 step 9 reads element 14, finds `"NX"` absent, and treats
  the statement as unusable evidence, so the refusal happens client-side without spending a
  channel and its single-use ticket on a `P9` the advertisement already announced. The `P9` path
  remains the node's enforcement against a client that ignores the field; §17.20 records the
  availability consequence for web.
- **Whole-node guarantee.** This is the only policy state that supports the whole-node
  active-Hub guarantee (§2.3), because it removes both Hub-originatable paths: plaintext and
  unsigned NX. The guarantee is over the node's channels, not over its future channels only, and
  it is §12.6 that makes the difference: enabling this policy is a policy withdrawal, so every
  `legacy` channel and every NX `e2ee` channel — precisely the two Hub-originatable paths — is
  closed before the CLI acknowledges the change. IK `e2ee` channels are unaffected **by this
  narrowing**, because §8.6 step 6 admitted none without an `approved` record; narrowing what one
  of those clients may do is the separate transition of §13.6, and withdrawing the suite one of
  them is running is the tier-independent third clause of the §12.6 test, which does close it.
- **Restart and recovery never weaken it.** The effective policy MUST be recomputed
  deterministically from durable configuration on every start. No restart, crash recovery,
  backup restore, or migration path may produce a weaker effective policy than the durable
  configuration states; any policy change increments the policy generation with the §5.7
  crash-atomic, rollback-fails-closed discipline. A recovery procedure that cannot read the
  durable policy MUST fail closed rather than admit broader tiers.
- **Operator lockout warning (duty).** The node CLI and configuration documentation MUST warn,
  at enable time, that this policy disables web and legacy access entirely and can strand
  remote access if every approved native client key is lost; and MUST document the local node
  recovery procedure, which never silently relaxes admission policy. The warning MUST also state
  that enabling it closes the live channels the policy no longer admits, and the command MUST
  report how many it closed (§12.6) — an owner enabling this policy to end a session they believe
  is hostile is precisely the case where "takes effect on the next channel" would be the wrong
  reading of an acknowledgement.

### 12.5 Fallback-occurrence instrumentation

The node-side **peer-legacy** fallback counter is the authoritative **lower bound** on legacy
acceptances, and the only rollout signal a malicious Hub cannot suppress: it is incremented by
the node's own act of locking legacy on a channel it advertised on, so no such plaintext channel
can go uncounted — a channel the node could not advertise on at all is counted in the second
class below, never in this one — and client-side diagnostics, which a malicious Hub _can_
suppress, never substitute for it.

It is not an authenticated measure of how many _genuine_ legacy clients exist, and this
document does not claim it is. Row N2 fires on the first unauthenticated `LEGACY-JSON` byte,
before any hello, key, signature, or §15 bound, so a party that can originate channels (§2.1:
the Hub can, and a node cannot tell a Hub-originated session from a genuine one) can inflate
the counter at will. **The counter can be inflated by the Hub and never deflated.** That is a
property of the counter's _value_, and it is the reason §12.3's gate is a maintainer judgement
rather than a zero test. It is **not** a claim that inflation is harmless in only one direction:
under the judgement criterion the decisive evidence is the bounded ring below, and inflation
evicts genuine occurrences from it, so inflation can bias the flip decision toward a premature
flip as well as away from one (§12.3, §17.15). The ring-overflow counter below exists to make
that loss visible; the operator override of §12.3 exists because it is the only path the Hub
cannot influence at all. No counter a
node can keep is integrity-protected against a party that can originate channels; §17.15 records
the residual. The counter is authoritative for exactly the fact it measures — that legacy was
accepted on a channel the node advertised on — which is also why the second class below is
counted separately rather than being allowed to move the same number.

- **Event definition, in two disjoint classes.** One fallback occurrence is counted when an
  E2EE-capable node either locks a channel to legacy or accepts a channel it cannot advertise
  on. Every occurrence belongs to exactly one class, and at most one occurrence is counted per
  channel:
  - **peer-legacy** — the node emitted its advertisement and then locked legacy on the first
    legacy RPC message (row N2). This is the class that means "a legacy client exists".
  - **advertisement-unavailable** — the node could not emit an advertisement at all (§5.5), so
    the channel was accepted without one (row N16). Its reason label is
    `undersized-connection` (§5.5 U1) or `statement-unavailable` (§5.5 U2). This class means
    "this node could not advertise", which is a different fact about a different party, and
    conflating the two is what let a Hub-asserted chunk limit look like compatibility traffic.

    The occurrence is recorded by row N16 at `channel.accept`, **not** when the channel later
    locks legacy: with the §12.1.1 classification decided before any evidence arrives, a latched
    or unexpected selection closes the channel without ever sending legacy JSON, and the fact
    being measured — that this node could not advertise — is already true and complete at
    accept. Row N17 therefore adds nothing on top, and it never adds a peer-legacy occurrence
    (§4.4 N16/N17, §16.3 F10).

- **Durable bounded state.** The node retains, durably and crash-consistently: **one monotonic
  occurrence counter per class**; **one monotonic ring-overflow counter per class**; the
  observation-window start timestamp; the last-occurrence
  timestamp per class; and a bounded ring of the most recent `E2EE_FALLBACK_RING_SIZE`
  occurrences across both classes. Each ring entry contains exactly three fields: `originHash =
SHA-256(canonical-CBOR([ "ryco.relay-e2ee.fallback-origin.v1", hubOrigin ]))`, the occurrence
  timestamp, and the reason label — one of the fixed set `peer-legacy`, `undersized-connection`,
  `statement-unavailable`. The label is a bounded enumerated value carrying no account, channel,
  session, key, or payload data, so it does not widen what this record retains. Counters are
  never decremented and survive restart.

  The **ring-overflow counter** is incremented, in the class of the occurrence being recorded,
  each time an occurrence is written into a ring that is already holding
  `E2EE_FALLBACK_RING_SIZE` entries — that is, once per evicted entry. It is a count and nothing
  more: it stores no origin, timestamp, or label, so it widens what the node retains by two
  integers and by nothing identifying. Its purpose is stated at its consumer (§12.3): a nonzero
  overflow count for an observation window means the ring is not a complete account of that
  window, so ring _shape_ is evidence in neither direction for it. The node MUST NOT infer
  anything else from it, and MUST NOT use it to block anything automatically.

- **Durable writes are coalesced, leading edge first.** The event is driven by unauthenticated
  peer input on a path that has no authentication ahead of it, so an uncoalesced crash-consistent
  write per occurrence would let channel churn drive the node's durable security state at
  whatever rate the party opening channels chooses. The node therefore keeps the precise counters
  and the ring in memory and commits durably as follows: the **first** occurrence of a class
  after each flush is committed immediately; further occurrences of that class within
  `E2EE_FALLBACK_WRITE_INTERVAL` are coalesced in memory and flushed at the interval boundary
  and on clean shutdown. Ring entries are covered by the same coalescing and travel in the same
  commit as the counters they accompany. Ring-overflow counters travel in the same commit as the
  ring whose evictions they count, so a flush can never record the evictions without the ring
  state that caused them. Leading-edge ordering is required rather than an
  implementation detail: the first occurrence of a class in a window is the one that puts that
  class in front of the maintainers at all, so losing it to a crash would remove a whole class
  from the §12.3 review and bias toward a premature flip — an
  availability break for legacy clients — whereas losing a later occurrence of a class that has
  already recorded one only lowers an already-approximate count that §12.3 reads as a lower bound
  anyway. This mirrors the `lastSeenAt` coalescing of §13.6 and is bounded in §15.
- **Reset authority.** Only an explicit node CLI command resets the state; the reset zeroes both
  occurrence counters, both ring-overflow counters, and the ring, and records a new
  observation-window start. No automatic reset
  exists.
- **Display.** The node CLI displays **both occurrence counters separately**, never a single
  total, plus **both ring-overflow counters**, the window start, the per-class last-occurrence
  timestamps, and each ring entry's reason
  label. A nonzero ring-overflow count MUST be displayed adjacent to the ring itself and
  labelled as what it means — that the ring is an incomplete account of the window — so that a
  reader cannot take a truncated ring for the whole picture (§12.3). For a live `undersized-connection` condition it MUST also display the asserted
  `maxDataChunkBytes` and `E2EE_ADVERTISEMENT_MIN_CHUNK_BYTES` (§11.4
  `e2ee_advertisement_unavailable`); that pair is read from the current connection and is not
  retained in the ring. The CLI MUST NOT display account, channel, session, or key identifiers —
  none are stored — and MUST NOT display payload-derived data.

  Because §12.3's gate is a judgement about the _shape_ of the occurrences rather than a zero
  test, the display MUST make that shape legible: the retained ring entries in time order with
  their reason labels, not only the totals. A sparse, metronomic peer-legacy pattern with no
  corresponding released legacy client population is the signature of deliberate inflation and is
  diagnostically useful — it is evidence of Hub-originated sessions, not of compatibility
  traffic. This constrains presentation of fields the node
  already keeps, and the ring's deliberate non-identifiability (no account, channel, session, or
  key data) is unchanged and MUST NOT be widened to make attribution easier.

  The display MUST NOT present that shape as reliable when the ring overflowed. An adversary that
  wants a premature flip does the opposite of the metronomic pattern above: it injects at a
  plausible, jittered rate sized to occupy the whole ring at review time, so every genuine
  occurrence is evicted and the only legible shape is the one it authored. The ring-overflow
  counter is the signal that this is possible for the window in question, and §12.3 states what
  the maintainers must do with it.

- **Client diagnostics are corroborating only.** Clients SHOULD record local fallback
  diagnostics (rows K13/K20), but no rollout or security decision may rest on them. The
  unexpected-selection closes of rows K23/K24 are **not** diagnostics: they are owner-visible
  by requirement (§12.1.1, §13.2.1), and a client MUST NOT downgrade them to a silent counter.

### 12.6 Policy withdrawal (normative)

§12.3 and §12.4 define what a policy admits at the moment a channel is admitted. This section
defines what happens to channels **already open** when a policy narrows. Without it the node
table of §4.4 would be read as complete, §15 arms no idle deadline in `legacy` or in established
`e2ee`, and an owner who enabled `requireApprovedClientE2EE` on a node already carrying a
plaintext channel and an unsigned NX channel would keep both indefinitely while §2.3 told them
the node was whole-node protected. This is the node-policy counterpart of §13.6's authorization
withdrawal, and it deliberately carries the same three-step ordering and the same acknowledgement
meaning.

**The transition.** A **policy withdrawal** is any owner- or operator-initiated change to node
configuration that narrows the set of channels the node's admission policy would admit. There
are exactly four, and this document treats them as one transition with one procedure:

1. `requireE2EE` false → true, whether raw or effective (§12.4's implication makes 2 a case
   of 1 as well as a case in its own right);
2. `requireApprovedClientE2EE` false → true;
3. any removal from the advertised suite registry (§7.6 element 9);
4. any reduction of the effective admitted pattern set (§7.6 element 14) — in version 1 the
   removal of `"NX"`, which is also what 2 causes.

A single command that both narrows and widens — enabling `requireE2EE` while adding a suite, say
— **is** a policy withdrawal: it contains a reduction and the reduction governs, exactly as in
§13.6. A pure **widening** (`requireE2EE` or `requireApprovedClientE2EE` true → false, a suite
added, a pattern re-admitted) is not a withdrawal and sweeps nothing: it takes effect on the next
advertisement and on channels admitted after it, never retroactively on an open one, mirroring
§13.6's treatment of authority-widening changes.

**The policy-withdrawal test for one live channel.** The test is evaluated per channel against
the channel's own admitted state — its mode (§4.4), its tier, and its established suite — and
never against the authority a Branch A record grants, which is §13.6's subject. A channel is
**withdrawn** if any of the following holds under the post-change policy:

- it is in `legacy` and effective `requireE2EE` is now true;
- it is in `e2ee`, its handshake was NX, and `requireApprovedClientE2EE` is now true or `"NX"` has
  left the effective admitted pattern set;
- it is in `e2ee` and its established suite is no longer in the node's advertised suite registry.

The test therefore requires **no new per-channel state**: the mode is the §4.4 machine's own, the
established suite is already retained because §9.1 and §4.3 reject any envelope whose `suite`
differs from it, and the tier is fixed at §8.6 step 4 by the pattern the channel ran. In
particular the test does not read, and MUST NOT be implemented in terms of, the §8.6 step 6
admitted-authority snapshot, which exists for §13.6 and which NX channels do not carry at all.

**The per-channel test above is the single governing rule, and it is stated by tier exactly once.**
An IK `e2ee` channel is never withdrawn by the `requireApprovedClientE2EE` narrowing (case 2) or
the admitted-pattern narrowing (case 4), and that is a consequence rather than an exemption:
§8.6 step 6 admits no IK channel without an `approved` Branch A record, and element 14 under
`requireApprovedClientE2EE` is exactly `["IK"]`, so every established IK channel already satisfies
what those two narrowings require — which is why the test's second bullet is written over NX
handshakes and reaches no IK channel. The **suite-registry narrowing (case 3) is
tier-independent and does reach IK channels**: the test's third bullet is unqualified by tier on
purpose, because a suite leaves the registry exactly when the operator has concluded its
construction is no longer one they will run, and an IK channel established on that suite is
running it as much as an NX channel is. Exempting IK there would leave every IK channel on a
withdrawn suite open indefinitely — §15 arms no idle deadline in established `e2ee` — under an
acknowledgement that claims the opposite. The first bullet is tier-independent for a different
reason: it is about `legacy`, which has no tier. Narrowing what a _particular_ client is
authorized to do is the §13.6 transition, not this one; the two are disjoint and an implementation
MUST run both tests, not one.

A `negotiating` channel is **not** swept. It has been admitted to nothing yet, and step (a) below
makes the newly committed policy govern its next input: a hello whose tier or suite the new
policy refuses fails §8.6 step 2 as `P9`, and legacy JSON under a newly effective `requireE2EE`
is row N1. Both are fail-closed. What the node MUST do instead is abort every **in-flight
handshake** — one that has passed §8.6 step 2 under the old policy but has not yet reached row N3
— whose tier or selected suite the new policy would not admit, as FATAL-PRE (§4.4, §11.2 **P25**),
taking the generic fixed-size `E2EEHandshakeReject` and never a distinguishable signal, for the
same reason §13.6's in-flight abort does. P25 is the row a fixture names for this abort (§16.2,
§16.3 F18); it is P9's condition re-evaluated after step 2 rather than at it, and it is a separate
row from §13.6's in-flight abort (P12) because the two fire on different grounds and neither
implies the other.

**The ordered procedure.** On any policy withdrawal the node MUST, in this order:

- **(a) Durably commit the new policy**, increment the policy generation, and update the §5.7
  high-water mark before the new generation is first advertised, with the §5.7 crash-atomic,
  rollback-fails-closed discipline; then re-run the §7.6.1 self-check so the next advertisement
  carries the new values (§7.6 elements 12–15).
- **(b) Close every channel the test above withdraws**, and abort every in-flight handshake the
  paragraph above names. An `e2ee` channel closes as FATAL-POST with error code `policy`
  (§11.3 Q12): one `E2EEError` when the send path is usable, then `channel.close` with reason
  `channel_rejected`. A `legacy` channel holds no session keys, so there is no encrypted record
  to send: the node emits `channel.close` with reason `channel_rejected` and **no record at all**
  — in particular not an `E2EEHandshakeReject`, which is a negotiation record and would itself be
  row K21 at the peer. An in-flight handshake is aborted as FATAL-PRE (§11.2 `P25`) with the
  generic fixed-size reject.

  **Both enumerations are one pass over one consistent snapshot of channel state**, and that is
  normative rather than an implementation choice: no channel may be observed in one mode by the
  live-channel enumeration and in another by the in-flight enumeration. The sufficient
  construction is stated so that no implementation has to derive it — walk the §15 **in-flight
  handshake list**, which is retired only at authenticated implicit finish, at any FATAL-PRE or
  FATAL-POST outcome, or at channel close, and therefore outlives row N3, alongside the set of
  live channels, and dispatch each entry by the mode it holds **in that snapshot**: still pre-N3
  and refused by the new policy → the FATAL-PRE abort (`P25`); already `e2ee` and withdrawn by the
  test → the FATAL-POST close (`Q12`). **Each channel MUST be dispatched exactly once.** A channel
  between row N3 and its authenticated implicit finish appears on both the in-flight handshake list
  and the live-channel set; it is one channel, it takes the disposition its snapshot mode selects,
  and it is counted once in the step (c) report. Two independent passes run in sequence, with a channel free
  to cross row N3 between them, would miss such a channel in both — not yet `e2ee` for the first,
  no longer pre-N3 for the second — leaving an established channel the new policy refuses open
  behind an acknowledgement that says none is. §8.6 step 2's atomicity requirement is what makes
  that crossing impossible in the first place; this rule is the cheap second line and MUST also be
  implemented.

- **(c) Only then acknowledge.** The CLI command MUST NOT complete or be acknowledged to the
  operator until (a) and (b) have completed, and it MUST report how many channels it closed,
  broken out by class — `legacy`, NX `e2ee`, suite-withdrawn `e2ee` **of either tier** — and how
  many in-flight handshakes it aborted.

This is what makes the acknowledgement mean what an owner reads it to mean: **no channel the new
policy would not admit is still open.** It is the identical guarantee §13.6 gives for a withdrawn
authority, and the identical reason: §15 arms no per-channel idle deadline in `legacy` or in
established `e2ee`, so a channel that is not swept persists for as long as its peer keeps it, and
the peer here is reachable only through the party this protocol treats as the adversary.

**The ordering is load-bearing for the same reason it is in §13.6, and the exhaustion rests on two
stated rules rather than on an assumption.** Committing first means every handshake that reaches
§8.6 step 2 afterwards reads the narrowed policy and is refused there. Any handshake that passed
step 2 before the commit is either already in `e2ee` — caught by the sweep — or still in flight —
caught by the in-flight clause. There is no third case, and that is true **because** §8.6 step 2
requires the step-2 policy read and the row-N3 transition to be atomic with respect to this
section's commit, and because step (b) above evaluates both enumerations over one consistent
snapshot. Neither rule is optional: drop the first and a handshake may cross row N3 after the
commit; drop the second and it may cross between the sweep's two passes; in either case it is
missed by both classes and the two-case argument fails. With both in place no per-channel
policy-generation bookkeeping is required beyond the generation §5.7 already increments. A node
that swept first and committed second would leave a window whose length is the sweep's own
duration, during which a hello could establish a channel the sweep had already passed.

**Restart, recovery, and the advertised snapshot.** §12.4's rule that the effective policy is
recomputed deterministically from durable configuration on every start already covers a crash
between (a) and (b): the commit is durable, every channel is lost with the process, and the node
restarts under the narrowed policy. A restore that would lower the policy generation is the §5.7
fail-closed startup condition and never a silent widening. One consequence is stated rather than
implied: an advertisement already emitted on an open `negotiating` channel is a signed snapshot
of the **pre-withdrawal** policy and stays valid for its own `E2EE_CAPABILITY_STATEMENT_VALIDITY`.
It cannot widen admission — the node evaluates its own committed policy at §8.6 step 2 and at
every §4.4 row — but a client acting on it is refused rather than served, and a Hub may replay it
to clients holding no higher remembered generation (§5.7). §17.18 records that residual.

**Display duty.** The node CLI MUST warn, at the point a policy withdrawal is requested, that
live channels will be closed and roughly how many currently match; MUST NOT return before the
ordering above has completed; and MUST report the counts of (c). These are display and
instrumentation duties only: they MUST NOT alter the uniform wire surfaces of §11.2 and §11.5,
and a swept channel's peer observes exactly what any other FATAL-POST or generic close produces.
A policy withdrawal MUST NOT record a §12.5 fallback occurrence of either class: it is neither a
legacy acceptance nor an advertisement failure, and folding it into either counter would corrupt
the §12.3 flip criterion with the operator's own action.

## 13. Trust establishment

### 13.1 Node pins

A pin is the client-side trust anchor for a node: the **owner-verified node identity public
key fingerprint** (§7.1, `ryco.node-key.v1`) — never the Hub-minted `nodeId`, which the Hub
can reissue at will. Fingerprint keying makes "same node, new Hub-assigned id" continuity and
makes a fingerprint change an explicit identity-change event (§13.3).

The fingerprint is the anchor, but it cannot also be the **index**: it is learned only from a
statement the Hub may withhold. The record is therefore indexed by a client-side selection
handle and carries the anchor as a value.

- **Index.** One record per `(hubOrigin, accountId, localNodeHandle)`, where
  `localNodeHandle` is a client-generated identifier created when the owner first pairs or
  first accepts a node (§13.2). It is never Hub-supplied, never derived from `nodeId`, and
  never re-minted by anything the Hub sends. It is what §12.1.1 resolves a channel selection
  against and what §8.3 presumes when it requires the client's expected values to come "from
  the selection … not from relay frames it later receives".
- **States.** A native pin is `unverified` or `verified`. `unverified` exists only to carry
  the pairing flow of §13.2; only the owner's out-of-band comparison promotes it. A capability
  statement signed by the key it carries proves self-consistency, not identity (§5.2); trust
  on first use alone does not resist an active Hub, and a self-signed first-contact key MUST
  NOT set a trusted pin. A record may also exist with **no pin at all** — holding only the
  handle, the hints, and an owner legacy consent — for a node the owner has explicitly chosen
  to reach over legacy (§12.1.1).
- **Record contents (a `verified` record).** Native persists, in the same device-only,
  non-synchronizing, non-backup
  secure-store class as the agreement key (§6.3):
  - the verified node identity **fingerprint** and the pin **state**;
  - the node's **continuity id** (§7.5), unconditionally present because §7.6 element 18 makes
    it a required signed element of every statement — an anchor for classification only, never
    a proof and never sufficient to re-anchor, promote, or latch anything;
  - the highest accepted **policy generation** (§5.7);
  - the **latch** (§12.1);
  - the **approval state** that §13.3 carries across a silent pin update: the client identity
    key fingerprint (§7.1, `ryco.client-key.v1`) under which the owner completed the §13.2
    ceremony for this node, and the time of that approval. This is the client-side record of
    the owner's decision; the authoritative record is node-side (§13.6);
  - an **owner legacy consent** flag and its timestamp, set only by the explicit owner action
    of §12.1.1 and never by a timeout, retry, or dismissed prompt;
  - the set of Hub-minted **node ids** under which this record has been observed, at most
    `E2EE_PIN_NODE_ID_HINTS_MAX`, oldest-first eviction. These are stored explicitly as
    **untrusted selection-resolution hints** (§12.1.1) and are never a trust anchor; a hint
    match alone authorizes nothing and releases nothing.
- **What an `unverified` record holds (normative).** The list above describes a record **after**
  §13.2 step 5, which is the owner decision that populates it; the fields it names are not all
  present before then, and which ones are must be stated rather than inferred. Between §13.2
  step 2 and step 5 the record carries the pairing flow and nothing more. It holds: the index —
  the client-generated `localNodeHandle` under its `(hubOrigin, accountId)` — the pin state
  `unverified`, the node-id hints, and, where the owner has taken the §13.2.1 consent resolution
  for this selection, the owner legacy consent flag and its timestamp. It holds **no** verified
  fingerprint, **no** recorded continuity id, no accepted policy generation, no latch, and no
  approval state: every one of those is written by the promotion at step 5. A client MAY hold the
  first-contact statement's fingerprint and continuity id as pairing-ceremony display material,
  but MUST keep it distinguishable from a recorded value and MUST NOT let any guard read it as
  one — a self-signed first-contact statement sets nothing (§5.2, and the states bullet above).
  Every guard therefore reads an `unverified` record as holding none of the promoted fields:
  §5.2 step 6 has no anchor to authenticate against, §8.3 elements 9 and 17 take their
  first-contact provenance, §12.1 cannot latch it, and §12.1.1 classifies a selection that
  resolves to it as _unexpected_ unless that consent is present — §12.1.1's branch (a) cannot
  apply, because a pin did resolve. A record with **no pin at all** is the third shape and holds
  the index, the hints, and the consent only (states bullet above). Promotion at step 5 is what
  writes the rest, and it is atomic with the `anyNodeVerified(hubOrigin)` marker below.
- **Device-level verification marker (native, normative).** Separately from any pin record, a
  native client MUST persist, in the same §6.3 storage class, one marker per Hub origin:
  `anyNodeVerified(hubOrigin)`. It is **set** when any pin under that `hubOrigin` first reaches
  `verified` at §13.2 step 5, under **any** account scope. It is read under `hubOrigin` alone —
  never under the `(hubOrigin, accountId)` pair — because `accountId` is Hub-issued and not
  client-anchored (§12.1.1). Its only use is the §12.1.1 classification, where it can move a
  selection from _legacy-eligible_ to _unexpected_ and never the reverse.
  - It is **never** set, cleared, refreshed, or influenced by anything the Hub sends: not by a
    statement, a continuity id, a `nodeId`, an account scope, a channel outcome, or a timeout.
  - It is cleared only by the explicit owner action that removes the last verified pin under that
    `hubOrigin` — the §13.3 owner-initiated re-pair clears one selection's pin and clears the
    marker only if no verified pin under that origin remains.
  - It carries no key material and no node-identifying value: a single boolean per configured Hub
    origin. It is written only by an owner ceremony, or by the local reconciliation required
    below, so it is unreachable from unauthenticated input and needs no §15 rate or count bound.
  - **It is a lower bound on the client's own pin set, and MUST NOT be losable independently of
    it.** The marker summarizes state the pin records already hold, so the invariant _the marker
    is set whenever a `verified` pin exists under that `hubOrigin` under any account scope_ MUST
    hold at every point a §12.1.1 classification is evaluated. Two consequences are normative.
    First, the write at §13.2 step 5 MUST be crash-atomic with the pin's promotion to `verified`:
    a crash leaves both applied or neither, never the pin alone. Second, a client MUST reconcile
    the marker against its own pin set — setting it wherever a verified pin exists and the marker
    does not — before it evaluates any classification on that Hub origin; this is also the
    required behavior for any release that adds the marker to an install whose pins were created
    by an earlier build. Without both, an ordinary crash or a staged client rollout leaves a
    device holding verified pins with the marker unset, and that is precisely the state an
    account re-mint converts back into the legacy-eligible class (§12.1.1). Reconciliation reads
    only client-side state and is not an exception to the rule above that nothing the Hub sends
    may influence the marker.
- **Release gate.** A native client MUST NOT release application payload under the active-Hub
  guarantee until the pin is `verified` (§2.2). With an `unverified` pin the client is
  restricted to the pairing ceremony.
- **Web** has no durable pin of any kind (§6.3), and therefore no durable latch, no durable
  policy-generation memory, no durable consent, and no verification marker. Its only human
  verification aid is the advisory `WebSAS` (§13.5), and its only downgrade resistance is the
  bounded in-memory, session-scoped latch of §12.1.

#### 13.1.1 Durable trust state, its loss, and what a client holding none may do (normative)

Everything §13.1 and §12.1 make durable — pin records and their states, verified fingerprints,
recorded continuity ids, latches, policy generations, approval state, owner legacy consents, the
strict-mode policy, and the `anyNodeVerified(hubOrigin)` marker — lives in the device-only,
non-synchronizing, non-backup storage class of §6.3, alongside the client agreement key. That
class is chosen deliberately, and its consequence must be stated rather than left implicit:

- **The state does not survive ordinary device-lifecycle events.** App reinstall, OS migration to
  a new handset, restore from any backup, and a platform secure-store reset or key invalidation
  each destroy all of it. These are routine events, not rare failures, and each one returns the
  device to the state of a fresh install for **every** node under **every** Hub origin.
- **A client with no durable trust state cannot detect that it ever had any.** It is
  indistinguishable from a fresh install both to itself and on the wire; no rule in this document
  can require it to notice. It therefore behaves as a fresh install: every selection classifies as
  genuine first contact under §12.1.1, and the full plaintext-downgrade exposure of §17.4 is
  reopened for the whole device until the owner re-runs §13.2 for each node.
- **What such a client MUST NOT do.** It MUST NOT claim, display, or rely on the active-Hub
  guarantee for any channel (§2.2). It MUST NOT set a verified pin, a latch, or the marker from a
  self-signed first-contact statement (§5.2, §12.1). It MUST NOT reconstruct any lost state from
  anything the Hub supplies — a statement's continuity id, fingerprint, `nodeId`, or account scope
  is not a substitute for the owner's verification (§7.5). And it MUST label every resulting
  fallback channel **legacy** (§12.2).
- **What the owner MUST be shown.** A native client that supports E2EE and holds **no** verified
  pin for a Hub origin it is connected to — equivalently, one whose `anyNodeVerified(hubOrigin)`
  marker is unset after the reconciliation §13.1 requires — MUST surface that state in its
  security UI: an explicit, persistent indication that this device has not verified any node on
  this Hub, together with the §13.2 pairing entry point. It MUST NOT be presented as a transient
  banner that dismisses into a
  verified-looking state, and dismissing it MUST NOT change any channel's label or unlock any
  guarantee. This is the only owner-visible signal the protocol can offer for this condition,
  because the loss itself is undetectable to the client.
- **Partial loss.** If a product happens to retain non-secret application state recording a prior
  E2EE association for a Hub origin — state that outlives the secure store but not a reinstall —
  it MUST treat the missing E2EE state as **unexpected** (rows K23/K24 and the §13.2.1 surface),
  not as legacy-eligible. This specification does not require such a record, and a conforming
  client that keeps none is a fresh install by the rule above.

Restored or cloned agreement-key material is a different case and is destroyed on detection
(§6.3). The residual risk is recorded in §17.11 and bounded in §17.4.

### 13.2 First-contact mutual pairing ceremony

First contact is a pairing ceremony, not an application session. Neither endpoint carries
application RPC payload at any point, in either direction; the §8.1 rule that no application
data rides in handshake payloads applies with no pairing exception.

1. The unverified native client validates the capability statement for self-consistency
   (§5.2). This authenticates nothing about identity.
2. The client MAY send exactly **one** bounded pairing `E2EEClientHello` — byte-identical in
   format and bounds to §8.5 — solely to introduce its identity to the node. The client marks
   the attempt pairing-only: buffered application sends are never flushed, and no application
   payload is released regardless of outcome.
3. The node processes the hello through §8.6 step 5 (all bindings verified). At step 6 it
   finds no approved record: it creates a bounded **pending** client record (§13.6) — subject
   to the §15 caps, which when exceeded close generically **without** creating the record —
   and then fails the handshake with FATAL-PRE. The node MUST NOT send `E2EEServerAccept` to
   an unapproved client; the pairing attempt always ends without application authorization.

   **Ordering.** The §15 caps and the §13.6 pairing-window reservation are evaluated **before**
   anything is emitted and entirely in memory, so a cap-exceeding attempt outside a window still
   creates no record, and inside a window the eviction target is _selected_ here but not yet
   removed. The node then emits the generic `E2EEHandshakeReject` and closes, and only afterwards
   commits the pending-class mutation — the eviction, where one was selected, and the creation of
   the new record including its §13.4 safety number — on a best-effort basis, and atomically with
   respect to itself. The node MUST NOT gate the reject or the close on that commit (§11.2): this
   is the only pre-key failure path that carries an fsync, and leaving it on the response path
   would make "this key is not on file" — or "the owner has a pairing window open" — measurable
   from the wire by latency alone. A pending-class mutation lost to a crash before it commits is a
   benign availability event; the client re-pairs.

4. Both ends display the safety number (§13.4): the node CLI from the pending record, the
   client computed locally from its own keys and the advertised node identity key. The
   pending record persists the **derived safety number only** as bounded display metadata —
   never either raw key.
5. The owner compares the safety number and node fingerprint against the local node
   CLI/enrollment surface, approves the client key on the node with an explicit maximum role
   and capability set, and marks the node pin `verified` on the device. Marking it `verified`
   is what populates the §13.1 record for this selection: the local node handle (minted here if
   the selection did not already have one), the verified fingerprint, the statement's continuity
   id, the approval state, the accepted policy generation, and the latch (§12.1). The same step
   sets the device-level `anyNodeVerified(hubOrigin)` marker (§13.1) if it was not already set,
   **atomically with the promotion** — a crash leaves the pin unpromoted rather than promoted
   without the marker. This is the only owner decision that establishes the marker; the only
   other write to it is the client-local reconciliation §13.1 requires against its own pin set.
6. Application traffic starts only on a **fresh ticket, channel, and handshake** after both
   decisions are durable. Approval never retroactively authorizes the pairing channel or any
   channel already open.

A product MAY instead require entry of the node enrollment fingerprint before any pairing
exchange; in that flow the client verifies the advertised identity fingerprint against the
entered value before sending the pairing hello. In no flow may a product silently promote a
self-signed first-contact key to a verified pin.

A native client MAY replace the manual comparison and device-side half of step 5 with the
owner-scanned, node-signed attestation in
[`relay-e2ee-cross-device-approval-protocol.md`](./relay-e2ee-cross-device-approval-protocol.md).
That extension starts only after steps 1–3 created the exact pending client record and the owner
durably approved it on a locally trusted node surface. The attestation is bound to that client's
authenticated identity fingerprint and the current node identity, continuity, and policy
generation. The safety number remains locally derived and never travels in the QR. Step 6 remains
unchanged: neither approval nor scanning upgrades an existing channel.

#### 13.2.1 The unexpected-node surface

Genuine first contact and a Hub-synthesized first contact are indistinguishable on the wire, so
they are distinguished by local state instead. Three situations MUST NOT be presented as routine
new-node pairing:

1. **Unexpected selection with no evidence** (§12.1.1, rows K23/K24). The channel closes
   FATAL-PRE with no payload released. The client MUST then show the owner an explicit surface
   naming the selection, and MUST offer exactly two resolutions: pair the node (re-entering the
   ceremony above), or record an explicit legacy consent for that selection (§13.1). Neither
   may be the default, and neither may be inferred from dismissal. Where local policy forbids
   legacy the same selection closes under rows K10/K14 instead, and the surface offers pairing
   alone — the consent resolution is unavailable, not defaulted (§12.1.1). A latched pin is not
   offered a legacy consent at all (§12.1.1).
2. **First-contact statement under an account that already holds a verified pin** (§5.2). The
   client MUST present it as a **possible node substitution**: it MUST display the previously
   verified fingerprint and safety number (§13.4) alongside the newly presented ones, for
   comparison, before any pairing step proceeds.
3. **A selection under an account scope that holds no verified pin, on a Hub origin whose
   `anyNodeVerified` marker is set** (§12.1.1, §13.1). This is the account-scope change: the
   device has verified a node on this Hub before, but not under the account identifier now
   presented. Because `accountId` is Hub-issued (§12.1.1), the client cannot tell an owner who
   genuinely added a second account from a Hub that re-minted the identifier to shed the owner's
   accumulated trust state. It is therefore classified **unexpected** (rows K23/K24) and
   presented as its own case, never as routine new-node pairing and never as a node substitution
   — no previously verified fingerprint is being contradicted, so displaying one would be
   misleading.

The presentation MUST distinguish the three underlying situations in its copy, because they carry
different meanings for the owner:

- _"You have other verified nodes on this account, but this one is new"_ — the expected message
  when the owner is legitimately adding a second node. This will fire on every genuine
  additional node, which is an accepted cost: adding a node is already a ceremony.
- _"This device has verified nodes on this Hub, but not for this account"_ — situation 3, the
  expected message when the owner is legitimately signing in under a second account. It fires on
  every genuine additional account scope on a Hub origin the device already uses, which is the
  same accepted cost for the same reason. It MUST NOT be worded as an identity change.
- _"The node you previously verified is presenting a different identity"_ — the §13.3 message,
  which fires when a channel resolves to a **verified** pin and the identity fails to
  authenticate to it.

Conflating them re-creates exactly the click-through training §13.3 opens by forbidding.

Nothing here changes what a first-contact statement grants: §5.2 step 6 and §13.1's refusal to
pin a self-signed key are unchanged, and this surface affects classification and presentation
only.

### 13.3 Authenticated identity rotation

Legitimate node identity rotation MUST NOT surface a re-verification prompt: training owners
to click through "identity changed" warnings destroys the only signal a real substitution
raises. Rotation is instead authenticated by the identity-continuity certificate chain of
§7.5, carried in every capability statement.

- **Silent pin update.** A pinned client whose pin verifies the **complete, valid** chain to
  the statement's current identity key (§7.5 chain rules) updates its pin to the new
  fingerprint silently — no prompt, no ceremony. The latch, policy-generation memory, and
  approval state (§13.1) carry over to the new fingerprint; the continuity id is unchanged by
  construction. The safety number changes with the key (§13.4); no re-verification is required
  while the chain verifies.
- **Custody caveat (normative).** A continuity chain authenticates a rotation **only while the
  outgoing identity private key was under exclusive honest custody**. It offers no protection
  once that key is compromised: a party holding a retired-but-once-current identity key can
  sign its own `old → attacker` certificate, present a one-entry chain anchored at the client's
  pin, and have the client silently re-pin — carrying the latch, the policy-generation memory,
  and the approval state to the attacker's key. No pin-local check detects this at accept time,
  and none is specified: the pinned generation does not separate the two certificates, since
  both sit at the same next generation, and the continuity id is public and copyable. This is
  why §7.5 requires a compromise rotation to be a deliberate chain break, and why §17.12
  records the residual asymmetry.
- **Chain failure is channel-fatal.** A missing, spliced, reordered, truncated, or
  signature-invalid chain, a generation regression, a continuity id that disagrees with the
  statement or with the pinned value (§7.5, §13.1), or a chain that does not reach the pin is
  fatal for the channel (row K2 when the selection is latched, §11.2 P15) and surfaces the
  **re-verification UI**: the client explains that the node's identity changed without proof of
  continuity, displays the new fingerprint and safety number, and requires a fresh §13.2
  ceremony before any application payload flows to the new identity. A **policy-generation**
  regression is deliberately _not_ on this list: it is an invalid statement with a local-only
  diagnostic (§5.7, §11.4), because a Hub can replay a genuine older statement on demand.
- **Deliberate breaks.** Administrative lost-key recovery, rotation motivated by compromise or
  suspected compromise of the outgoing identity key, and any rotation performed by a mechanism
  that did not issue a continuity certificate deliberately break the chain (§7.5). A broken
  chain always takes the re-verification path; no party may fabricate, backdate, or accept a
  substitute link, and the node never synthesizes one.
- **Owner-initiated re-pair (client side).** The client MUST offer one explicit owner action
  that clears, together and atomically, the pin, its state, the latch, the remembered policy
  generation, the recorded continuity id, the approval state, and any legacy consent for that
  selection (§13.1), and re-enters §13.2. It clears the device-level
  `anyNodeVerified(hubOrigin)` marker only if no verified pin remains under that Hub origin
  afterwards; while any other verified pin remains, the marker stays set and the other
  selections' classifications are unaffected. This is the only client-side recovery from a node
  that legitimately broke its chain, was restored below a remembered policy generation (§5.7),
  or genuinely lost E2EE support while latched. It is owner-initiated by requirement: nothing
  the Hub sends may trigger, suggest, or pre-select it.

### 13.4 Native safety number

The owner-facing verification value for the signed native tier is a long-term safety number
over both **identity** keys and the Hub/account namespace — not the per-channel transcript,
which re-rolls every channel and is unusable for asynchronous human verification. The
per-channel transcript stays inside machine-checked key confirmation (§8.7).

Derivation:

```text
safetyNumberInput  = canonical-CBOR([
                       "ryco.relay-e2ee.safety-number.v1",
                       "node",   "ed25519", bstr(nodeIdentityPublicKey),
                       "client", "p256",    bstr(clientIdentityPublicKey),
                       hubOrigin, accountId ])
safetyNumberSecret = SHA-256(safetyNumberInput)
out                = HKDF-Expand(safetyNumberSecret,
                       "ryco.relay-e2ee.safety-number.v1",
                       E2EE_SAFETY_NUMBER_HKDF_BYTES)
```

The SHA-256 digest is used directly as the HKDF-Expand pseudorandom key; there is no
HKDF-Extract step and no salt.

Rendering: `out` is consumed in consecutive runs of `E2EE_SAFETY_NUMBER_GROUP_BYTES` bytes;
each run, read as a big-endian unsigned integer, is reduced modulo
`E2EE_SAFETY_NUMBER_GROUP_MODULUS` and rendered as a zero-padded five-digit decimal group.
The groups are displayed in derivation order per the `E2EE_SAFETY_NUMBER_DIGITS` format. The
modulus bias per group is below one part in ten million and is negligible at this length.

Properties and duties:

- The fixed role labels order the inputs, so both endpoints and the node CLI derive the
  identical value with no key-sorting rule. The Hub origin and account id bind the namespace:
  the same key pair paired under a different account yields a different number.
- The rendered value's displayed entropy per `E2EE_SAFETY_NUMBER_DIGITS` exceeds
  `E2EE_SAFETY_NUMBER_MIN_DISPLAYED_BITS` of anti-grinding entropy; the fixed length and grouping
  are the checksum — there is no separate check digit. The floor is sized for an **offline**
  adversary, because this value is long-term: an attacker may grind candidate key material
  against a displayed number indefinitely and without interacting.
- **Surfaces.** The node CLI MUST provide a command that shows the safety number for a named
  pending or approved client record (per `(hubOrigin, accountId)`), and the native client MUST
  display it in its verification UI (§13.2) and on identity-change events (§13.3).
- The safety number is display-only: it never travels in any protocol message, log, or
  analytics surface. Only the pending-record copy of §13.2 is persisted.

### 13.5 `WebSAS`

Web has no long-term client identity, so it cannot compute the §13.4 value. The web
verification aid is a per-session short authentication string:

```text
webSasInput = canonical-CBOR([
                "ryco.relay-e2ee.web-sas.v1",
                "node", "ed25519", bstr(nodeIdentityPublicKey),
                "web",  "x25519",  bstr(webEphemeralPublicKey) ])
prk         = HKDF-Extract(salt = sessionBindingHash, IKM = webSasInput)
out         = HKDF-Expand(prk, "ryco.relay-e2ee.web-sas.v1", E2EE_WEB_SAS_HKDF_BYTES)
```

where `webEphemeralPublicKey` is the web client's Noise ephemeral public key for this
handshake (§6.2) and `sessionBindingHash` is the §8.8 value — making the string
**session-bound**: it changes on every channel.

Rendering: `out` is read as a bit string, most significant bit first, in five-bit groups; each
group indexes `E2EE_CROCKFORD_ALPHABET`. The result is the `E2EE_WEB_SAS_CHARS` format, whose
displayed entropy meets `E2EE_WEB_SAS_MIN_DISPLAYED_BITS`. There is no separate check character;
as with the safety number, the fixed length and grouping are the checksum.

**The `WebSAS` threat model, stated plainly.** Session binding buys **non-precomputability, not
unforgeability**, and the entropy floor here is _not_ an offline work factor the way
`E2EE_SAFETY_NUMBER_MIN_DISPLAYED_BITS` is. An interposer running one NX session with the node
and another with the client **authors the client-facing `E2EEServerAccept` itself**. It therefore
knows every input to `sessionBindingHash` — the client's hello wire bytes, the accept bytes it is
about to write, and the context block — while it already knows the target value the node CLI is
displaying for the node-side session. It can vary its own Noise ephemeral and recompute the
`WebSAS` until the two strings match, entirely offline with respect to the network. What bounds
that attack is not the derivation but the window and the retry cost:

- the grinding must finish inside `T_HANDSHAKE`, which the client enforces from hello emit and
  whose expiry is FATAL-PRE, never a legacy fallback (§4.4 K15, §11.2 P20); and
- §8.1 allows **exactly one handshake attempt per channel**, so every additional window costs the
  attacker a fresh ticket, a fresh channel, and a victim-side reconnect, and restarts the search
  against new hello bytes and a new target.

`E2EE_WEB_SAS_MIN_DISPLAYED_BITS` is derived from that bound and from nothing else: matching _k_
displayed bits costs about 2^_k_ trials of roughly two X25519 operations each, all of which must
land inside one `T_HANDSHAKE`. §3.2.1 S11 states the resulting relationship over constant names.
Implementations MUST NOT present the `WebSAS` as unforgeable against an active interposer, and
MUST NOT use this derivation to strengthen the claims of §2.4 or §17.5.

_Note (non-normative)_: at the shipped `E2EE_WEB_SAS_CHARS` the search is ~2^40 expected trials,
i.e. a sustained ~7·10^11 X25519/s across the whole 3-second window — far beyond a large GPU
fleet — while the `E2EE_WEB_SAS_MIN_DISPLAYED_BITS` floor corresponds to ~7·10^8 X25519/s over
the same window, which is where a well-resourced attacker becomes relevant. The shipped format
therefore sits about a thousandfold above the floor. Neither figure is a guarantee against the
Hub, which serves the code that draws the string (§2.4).

Surfaces and duties:

- Shown in the web UI for the active session and by the node CLI for the active session; the
  owner compares the two out of band.
- **Advisory-only disclosure duty.** The web UI text accompanying the `WebSAS` MUST state that
  the comparison catches accidental wrong-node routing and some network interposition while
  the loaded code is honest, and **cannot** protect against the Hub operator, who serves the
  code that displays it (§2.4). Implementations MUST NOT present the `WebSAS` as an
  operator-proof or E2EE-verification guarantee, and MUST NOT describe a match as proof that no
  interposer is present: the interposition it catches is bounded by the grinding model above.
- The `WebSAS` is ephemeral display state: never logged, never persisted, never sent to
  analytics ([hosted-hub-client.md](./hosted-hub-client.md) storage rules apply).

### 13.6 Client authorization records (the Branch A record set)

The node maintains the owner-approved client-key authorization state that makes the §2.2
active-Hub row true. This is **node-side durable public state — never relay-operator (Hub)
persistence**: no client agreement or identity key, fingerprint, or authorization record is
registered with or stored by the Hub.

**Record shape.** One bounded record per key `(hubOrigin, accountId,
clientIdentityFingerprint)` — the fingerprint per §7.1 (`ryco.client-key.v1`), never a raw
key:

| Field                                  | Content                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status`                               | `pending` \| `approved` \| `revoked`                                                                                                                                                                                                                                                                                                                                                               |
| `maxRole`                              | Maximum role the owner granted; §8.3 role ordering                                                                                                                                                                                                                                                                                                                                                 |
| `capabilitySet`                        | The subset of `RELAY_CAPABILITY_LITERALS` the owner granted (§3.2, §8.3)                                                                                                                                                                                                                                                                                                                           |
| `createdAt`, `approvedAt`, `revokedAt` | Epoch-millisecond timestamps for the transitions taken                                                                                                                                                                                                                                                                                                                                             |
| `lastSeenAt`                           | Coalesced: at most one durable write per `E2EE_LAST_SEEN_WRITE_INTERVAL` per record                                                                                                                                                                                                                                                                                                                |
| `safetyNumber`                         | The derived §13.4 display string — the only pairing display metadata; never either raw key                                                                                                                                                                                                                                                                                                         |
| `displayLabel`                         | Optional owner-assigned label, at most `E2EE_CLIENT_DISPLAY_LABEL_MAX_CHARS` characters                                                                                                                                                                                                                                                                                                            |
| `pairingReservedAt`                    | Absent, or the epoch-millisecond time at which a `pending` record was created as the single record admitted by an owner-opened pairing window whose discriminator it matched. A bounded, non-identifying timestamp consulted only by the pending eviction rule below; the record's reservation is held while `now − pairingReservedAt ≤ E2EE_PAIRING_RESERVATION_LIFETIME` and is spent thereafter |

**Lifecycle.**

- A first-seen key produces only a `pending` record via the §13.2 ceremony. `approved`
  requires explicit owner action naming the maximum role and capability set. `revoked` is
  explicit owner action; a revoked record MAY later be re-approved only by explicit owner
  action.
- **Enforcement** is §8.6 step 6: absent, `pending`, or `revoked` records receive no
  application authorization; `approved` records are enforced against `maxRole` and
  `capabilitySet` with exact-equality context rules (§8.3), independently of any matching Hub
  claim. **Authority-widening** changes — a first approval, a re-approval, a `maxRole` increase,
  a `capabilitySet` addition — take effect only on a fresh ticket, channel, and handshake, and
  never retroactively on an open one. **Authority-narrowing** changes do not wait for a fresh
  channel: they are the authorization withdrawal below, and they are effective before the CLI
  acknowledges them.
- **Unknown keys never hold a channel open** awaiting owner action: the pairing channel closes
  after creating the pending record (§13.2).
- **Authorization withdrawal is effective before acknowledgement.** An **active E2EE channel** is
  a channel whose node-side mode machine is in the `e2ee` state of §4.4, whether or not its
  implicit client finish has authenticated (§8.9).

  An **authorization withdrawal** is any owner-initiated change to a record that reduces what it
  authorizes. There are exactly three, and this document treats them as one transition with one
  procedure:
  1. `status` leaving `approved` — revocation to `revoked`, and equally deletion of the record;
  2. any `maxRole` reduction under the §8.3 role ordering `viewer < operator < owner`;
  3. any `capabilitySet` removal — any change whose new set is not a superset of the old one.

  A single owner command that both narrows and widens (say, dropping `owner` to `operator` while
  adding a capability) **is** a withdrawal: it contains a reduction, and the reduction governs.

  The **withdrawal test** for one active E2EE channel or one in-flight handshake is evaluated
  against that channel's §8.6 step 6 admitted-authority snapshot: the channel is withdrawn if the
  snapshot's record key equals the changed record's key **and** the post-change record is absent,
  or its `status` is not `approved`, or its `maxRole` is below the snapshot's `maxRole`, or its
  `capabilitySet` does not contain every member of the snapshot's `capabilitySet`. The key
  comparison is over the **full** key `(hubOrigin, accountId, clientIdentityFingerprint)` — a
  sweep keyed on the fingerprint alone would close channels admitted under a different
  `(hubOrigin, accountId)` scope, whose authority the owner did not touch.

  On any withdrawal the node MUST, in this order: (a) durably commit the changed record; then
  (b) close every active E2EE channel that fails the withdrawal test — FATAL-POST with error code
  `policy` (§11.3 Q9) — and abort every in-flight handshake whose §8.6 step 6 snapshot fails it,
  as FATAL-PRE (§4.4). The command MUST NOT complete or be acknowledged to the operator until
  both (a) and (b) have completed. This is what makes the CLI's acknowledgement mean what an
  owner reads it to mean: **no channel admitted under the withdrawn authority is still open.**
  An earlier revision wrote this procedure for revocation alone, so a demotion or a capability
  removal was acknowledged immediately while every live channel kept the ceiling §8.6 step 6
  had captured — indefinitely, because §15 arms no idle deadline in `e2ee` — and §11.3 Q9
  promised a close that no rule delivered.

  The test is deliberately evaluated against the snapshot rather than against the authority the
  channel is currently exercising (its §8.3 elements 11 and 12). A channel admitted at `viewer`
  under an `owner` ceiling is closed when the ceiling drops to `viewer`, even though `viewer` is
  still granted. That is the conservative direction and it is chosen on purpose: the snapshot is
  exactly what step 6 read and what §8.3 was evaluated against, it needs no per-RPC bookkeeping,
  and the cost of the extra closes is a reconnect on a device the owner has just narrowed.

  The ordering is the load-bearing part, and it is what closes the window that would otherwise
  exist between the §8.6 step 6 read and row N3. Committing first means any handshake that
  reaches step 6 afterwards reads the narrowed record and fails P12 if the request no longer
  fits. Any handshake that read the old record before the commit is either already in `e2ee` —
  caught by the sweep — or still in flight — caught by the in-flight clause, using the snapshot
  §8.6 step 6 records on the in-flight entry. There is no third case, so no
  authorization-generation counter is required. A conforming implementation that swept first and
  committed second would leave a window whose length is the sweep's own duration, during which a
  hello could land a live channel the sweep had already passed.

  The in-flight abort takes the generic fixed-size `E2EEHandshakeReject`, **not** a `policy`
  code: §8.6 requires every pre-key failure to be externally indistinguishable, and emitting a
  distinguishable withdrawal signal there would leak record status to a peer that holds no
  authorization. The `policy` code appears only on the post-key side, where the peer is already
  authenticated.

  **What withdrawal does not do.** It terminates channels; it does not roll back application
  operations the RPC handler already dispatched under the old authority, and it does not reach a
  channel's peer any faster than the channel's own send path. Its granularity is the channel, and
  its guarantee is the acknowledgement ordering above, not per-RPC revocation (§17.17).

**Caps, retention, and eviction** (constants in §3.2):

- Pending: at most `E2EE_PENDING_CLIENTS_MAX_GLOBAL` records globally and
  `E2EE_PENDING_CLIENTS_MAX_PER_ACCOUNT` per `(hubOrigin, accountId)`; retained at most
  `E2EE_PENDING_CLIENT_RETENTION`, then deterministically expired. A pairing attempt that
  would exceed a cap closes generically **without creating or refreshing any record** (§15),
  except under the owner-opened pairing window below.
- **`accountId` is not an isolation boundary.** The per-account partition key is a client claim
  authenticated only for self-consistency at the point the cap is applied (§8.3 element 10, §7.4
  element 2): §8.6 step 5 checks the payload `accountId` against the certificate's and the
  certificate's `hubOrigin` against the channel's, and the certificate is self-signed by the
  client's own device key (§7.4) against no external authority.
  `E2EE_PENDING_CLIENTS_MAX_PER_ACCOUNT` is therefore a **bookkeeping partition** that bounds
  per-namespace growth. It is not fairness and not isolation between accounts, and nothing may
  be built on it as though it were. The client-side counterpart of this concession is §12.1.1's
  provenance rule: `accountId` is Hub-issued at the other end of the same value, so no downgrade
  guard rests on it alone. Note that the Branch A key `(hubOrigin, accountId,
clientIdentityFingerprint)` fails **closed** under an account re-mint — the lookup at §8.6 step
  6 simply finds no record and takes §11.2 P12 — which is the behavior §12.1.1's marker restores
  on the client side.
- Approved: at most `E2EE_APPROVED_CLIENTS_MAX`; exceeding it fails the approval explicitly —
  approval never evicts anything.
- Revoked: at most `E2EE_REVOKED_CLIENTS_RETAINED_MAX` retained; past the cap only the
  **oldest revoked** records are evicted.
- **No pending record is ever evicted to make room by unsolicited peer action.** Eviction is
  deterministic and oldest-first within a class, but an attempt that would exceed a pending cap
  is refused without creating or refreshing anything; pending records leave the class only by
  expiry at `E2EE_PENDING_CLIENT_RETENTION`, by explicit owner action, or by the owner-bound
  pairing-window reservation below — which admits at most one record per window and only for the
  one client key the owner named, so no party that has not been named by the owner can cause an
  eviction at all. An unapproved flood therefore cannot evict `approved` or `revoked` security
  state — that invariant is unconditional and no rule in this section relaxes it.

**Pending-cap saturation denies pairing, and the owner must always be able to recover.** The
records are created from unattested, self-signed §7.4 certificates naming a client-chosen
`accountId`, so a party that can open channels can fill
`E2EE_PENDING_CLIENTS_MAX_PER_ACCOUNT` for a chosen namespace, and
`E2EE_PENDING_CLIENTS_MAX_GLOBAL` outright, with fabricated identities. Under the refuse-newest
rule alone the owner's genuine device would then be refused with the byte-identical §11.2
surface, for up to `E2EE_PENDING_CLIENT_RETENTION`, renewable indefinitely — a durable
fail-closed denial against the owner. This document does not pretend to solve that
cryptographically: no attestation is available at this layer, and requiring one would be a
different protocol. It bounds it instead, with two owner-side mechanisms:

- **Owner-opened pairing window, bound to one owner-named client key.** The owner MAY open a
  pairing window at the node CLI, lasting at most `E2EE_PAIRING_WINDOW`. A window is **not** a
  blanket suspension of the caps; it is a reservation for one attempt, and it is defined by four
  rules.
  - **Discriminator (REQUIRED).** Opening a window MUST name a discriminator: the
    `ryco.client-key.v1` fingerprint (§7.1) of the device the owner intends to pair, entered at
    the node CLI in the `SHA256:` display form. A window without one MUST be refused by the CLI;
    there is no undiscriminated window. The reservation is granted only to a pairing attempt
    whose **authenticated** `clientIdentityFingerprint` — the value §8.6 step 5 has already bound
    to a certificate self-signed by that client identity key, whose Noise static byte-equals the
    certificate's agreement key — equals the named value. A flood of fabricated identities
    therefore never receives the reservation and never causes an eviction, however precisely it is
    timed against the window: matching the discriminator requires the private key whose public
    fingerprint the owner read off their own device. A product that offers this window MUST
    therefore provide a device-local surface displaying the client's own `ryco.client-key.v1`
    fingerprint in the §7.1 display form, computed from the device's own key and requiring no
    node contact. Version 1 defines no hello field for a CLI-displayed pairing code, so the
    fingerprint is the only discriminator available here; a code-based binding would be a new
    wire field and is deliberately not added. The ordering works because the pending caps and
    this reservation are evaluated at §13.2 step 3 — _after_ §8.6 step 5 has authenticated the
    fingerprint — so the discriminator is matched against a value the node has proven, never one
    the peer merely asserted.
  - **One record per window.** A window admits **at most one** pending record, and that record
    carries `pairingReservedAt` whether or not an eviction was needed to admit it. The
    reservation is spent by the first attempt that matches the discriminator, whatever that
    attempt's outcome, and the window is closed at that point; it is closed in any case at
    `E2EE_PAIRING_WINDOW`. Re-opening is an owner action.
  - **Partition-scoped eviction.** While a window is open and the matching attempt would exceed a
    pending cap, the attempt MUST NOT be refused for the cap. The node instead evicts one existing
    pending record **in the same partition as the cap that was exceeded** — for
    `E2EE_PENDING_CLIENTS_MAX_PER_ACCOUNT`, the oldest eligible record under the _same_
    `(hubOrigin, accountId)` as the attempt; for `E2EE_PENDING_CLIENTS_MAX_GLOBAL`, the oldest
    eligible record anywhere — and then creates the new record with `pairingReservedAt` set to
    now. **When both caps are exceeded the per-account partition governs**, and one eviction
    suffices: a record removed from that partition frees a slot against the per-account cap and
    against the global cap simultaneously, whereas a globally chosen victim outside the partition
    relieves only the global one and would leave the owner refused, or the record admitted in
    violation of a cap that was never relieved.
  - **Eligibility, and the lifetime of a reservation.** A pending record is eligible for this
    eviction unless it still **holds a reservation** — that is, unless it carries
    `pairingReservedAt` and `now − pairingReservedAt ≤ E2EE_PAIRING_RESERVATION_LIFETIME`.
    `approved` and `revoked` records are never eligible, under any rule in this section. A held
    reservation is what stops a later flood from displacing the record the owner just obtained;
    bounding it at `E2EE_PAIRING_RESERVATION_LIFETIME` rather than at
    `E2EE_PENDING_CLIENT_RETENTION` is what stops the reserved class from filling up with records
    the owner never approved. Once the owner approves, the record is `approved` and no eviction
    rule reaches it at all. If no eligible record exists, the attempt is refused as usual.

  Outside a window the behavior is exactly the refuse-newest rule above, which is the default.

  **What the window is and is not observable as.** The window changes no wire _record_, no close
  reason, and no close timing: a pairing attempt ends in the identical FATAL-PRE either way
  (§13.2 step 3), and because §11.2's ordering rule covers the eviction as well as the creation,
  the durable mutation the window adds sits after the reject and the close rather than inside the
  pre-emission cap evaluation. The claim is exactly that — no wire record, no close reason, no
  timing class — and it rests on that ordering rule. It is not the stronger claim that the window
  introduces no observable at all; a node's coarse timing behavior in a managed runtime remains
  what §11.2's SHOULD and §17.2 already describe.

- **Purge.** Purging or revoking a `pending` record is an owner action that frees its slot
  against both pending caps immediately.

Together these are the documented owner recovery path: the owner sees the saturation on the CLI,
purges the junk, or reads the fingerprint off the device and opens a window naming it, and pairs.
The two are not equally strong and §17.16 says which is which: purge is unconditional, and the
window is conditional on the product exposing the client's own fingerprint and on the owner
approving within `E2EE_PAIRING_RESERVATION_LIFETIME`. A product MAY additionally gate pairing
behind the enrollment-fingerprint flow of §13.2; that is a product choice, not a requirement of
this document.

**Display surfaces.** The node CLI lists records with the `SHA256:` fingerprint display form
(§7.1), status, authority ceiling, timestamps, safety number, and display label. **List,
approve, revoke, narrow (reduce `maxRole` or remove capabilities), purge pending, and open a
pairing window are all CLI commands.** The listing MUST flag when either pending cap is saturated
and MUST show a bounded, owner-clearable count of pairing attempts refused for pending-cap — the
state has to be legible without the owner inferring it from record counts. While a window is open
the CLI MUST show that it is open, which fingerprint it names, and whether its single reservation
has been spent, so the owner can tell "my device has not reached the node" from "some other
attempt consumed the window" — the latter being impossible without the owner's own client key,
which is exactly the property the discriminator buys. A command that performs an authorization
withdrawal MUST report how many active channels it closed, and MUST NOT return before the §13.6
ordering has completed. These are display and instrumentation duties only: they MUST NOT alter
the uniform wire reject of §11.2 in any way. Raw keys are never displayed and never stored.

## 14. Cryptographic dependencies and library policy

### 14.1 The Noise implementation: a resolved, owner-accepted deviation

The library policy this protocol was drafted under required an **audited** full Noise
implementation — no hand-rolled handshake, primitive, record crypto, signature codec, or
canonical-CBOR security boundary, with primitive packages alone not satisfying the
requirement for a reviewed Noise state machine, and a hard stop rather than composing a
bespoke protocol if no qualifying dependency existed.

That stop condition fired, and its resolution is recorded here verbatim as an accepted
deviation:

> No audited pure-TS Noise implementation exists (research verdict, 2026-07-30). Owner
> accepted: first-party minimal frozen Noise IK+NX state machine implemented in
> `packages/shared` on audited noble primitives.

_Note (non-normative)_: the survey behind that verdict found the gap structural, not a search
failure: no pure-TS/JS Noise implementation has ever been audited **as** a Noise
implementation; the libraries covering IK+NX are built on native-binding or unaudited-JS
sodium splits with no Hermes support; and no JS Noise library exposes a supported
exporter/post-`Split()` derivation API. The one widely deployed JS Noise library is XX-only,
WASM-assisted, and carries CVE-2022-24759 — an unvalidated handshake-payload-signature MITM —
as a concrete demonstration of how unaudited handshake state machines fail.

The deviation is bounded as follows — these are normative obligations, not aspirations:

- **Scope of first-party code.** Exactly one frozen module implements the Noise
  `HandshakeState`/`SymmetricState`/`CipherState` composition for the two §3.4 protocol
  names, message ordering, nonce handling, `Split()`, and the §6.5 exporter. It lives in
  `packages/shared` (§1.1), performs no primitive arithmetic of its own, and calls only the
  §14.2 primitive packages. Everything else — AEAD, hashing, HKDF/HMAC, curve operations,
  signatures — comes from the audited primitives.
- **Official Noise test vectors MUST pass**: the published cacophony and snow vector sets for
  `Noise_IK_25519_ChaChaPoly_SHA256` and `Noise_NX_25519_ChaChaPoly_SHA256`, checked into the
  §16 corpus (family F15).
- **Cross-implementation vector tests MUST pass** against at least one independent Noise
  implementation: identical inputs (static keys, ephemerals, prologue, payloads) MUST produce
  identical transcripts and `Split()` outputs.
- **Property-based tests MUST cover the state machine** (the repository's established
  property-testing framework), including message-order, truncation, mutation, and
  nonce-progression properties.
- **The full adversarial suite MUST run against the module** with an attacker-controlled
  relay harness: key and suite-list substitution, tier/pattern confusion, reflection,
  transcript and context-commitment mismatch, **role and capability escalation, role reduction,
  cross-account splice, node-fingerprint substitution, Branch A record-state enforcement
  (absent, pending, revoked, capability outside the approved set, role above the ceiling), and
  authorization withdrawal against live and in-flight channels (revocation, `maxRole` reduction,
  and `capabilitySet` removal, each raced against §8.6 step 6 and row N3), and policy withdrawal
  against live and in-flight channels (§12.6, raced against §8.6 step 2 and row N3)**,
  **key-material validation (all-zero X25519 output from a low-order point, P-256 point
  validation, DER and out-of-range ECDSA encodings, non-canonical Ed25519 signatures, and
  cross-domain signature substitution)**, replay/reorder/gap, implicit-finish abuse,
  counter/rekey/exhaustion boundaries, and mode-lock violations. The deterministic byte-level
  half of the authorization-context and key-material classes is pinned by §16.3 F16 and F17; the
  suite exercises the behavioral and state-dependent half.
- **A scoped third-party audit of the state-machine module is REQUIRED before any release
  flips the `requireE2EE` default** (§12.3). Until that audit completes, the residual risk is
  carried openly in §17 and the default stays compatibility-off.

### 14.2 Primitive dependencies and audit lineage

The primitive set is `@noble/curves` (X25519, Ed25519, P-256), `@noble/ciphers`
(ChaCha20-Poly1305), and `@noble/hashes` (SHA-256, HMAC, HKDF) — pure-JS, BigInt-based,
running on Bun, evergreen browsers, and Hermes (which has supported BigInt since well before
the pinned mobile runtime).

Audit lineage facts, stated exactly. Each package's independently audited baseline is named by
its §3.2 constant rather than by its version literal, because §3.2 is the single source of truth
for those three values and the pin-audited-lineage rule below tests against the same names; the
older audits are cited by version because they define no constant:

- **`@noble/curves`** — Trail of Bits, February 2023, v0.7.3: abstract Weierstrass, modular
  arithmetic, hash-to-curve, secp256k1, and related modules. Kudelski Security, September
  2023, v1.2.0: curve, modular, Poseidon, and Weierstrass modules. **Cure53, September 2024,
  `E2EE_NOBLE_CURVES_AUDIT_BASELINE`**: scope explicitly including ed25519, ed448,
  hash-to-curve, and the low-level
  Edwards **and Montgomery** modules — X25519 is inside independent audit scope. Maintainer
  self-audit of the 2.x line, April 2026. **P-256 caveat, stated plainly**: P-256 is a thin
  configuration over the Trail of Bits/Kudelski-audited abstract Weierstrass code, but the
  top-level NIST-curve module was not named in any independent audit scope.
- **`@noble/ciphers`** — **Cure53, September 2024, `E2EE_NOBLE_CIPHERS_AUDIT_BASELINE`**: full
  scope, explicitly including
  ChaCha20 and Poly1305 — exactly the suite AEAD. Maintainer self-audit of 2.x, April 2026.
- **`@noble/hashes`** — **Cure53, January 2022, `E2EE_NOBLE_HASHES_AUDIT_BASELINE`**: everything
  except BLAKE3,
  SHA-3 addons, SHA-1, and Argon2 — SHA-256, HMAC, and HKDF are all inside audit scope.
  Maintainer self-audit of 2.x, April 2026.

**The pin-audited-lineage rule.** Implementations MUST pin exact versions with integrity
digests. The pinned version of each package MUST be within the independently audited major
lineage and MUST NOT be older than its audit baseline (`E2EE_NOBLE_CURVES_AUDIT_BASELINE`,
`E2EE_NOBLE_CIPHERS_AUDIT_BASELINE`, `E2EE_NOBLE_HASHES_AUDIT_BASELINE`). The current 2.x line
of each package carries only a maintainer self-audit on top of the independently audited
lineage; adopting any version whose changes are covered only by self-audit is a
protocol-relevant decision that REQUIRES explicit recorded owner acceptance in a revision of
this section — it MUST NOT happen as an incidental dependency bump.

**Recorded owner acceptance, 2026-09-04.** The runtime pins all three packages at exactly `2.3.0`
with lockfile integrity digests; the protocol constants retain `2.2.0` as the April 2026
maintainer-self-audit baseline. The accepted delta is `2.2.0…2.3.0` over Ryco's production import
closure: curves `ed25519.js`/`nist.js` and their abstract dependencies, ciphers
`chacha.js`/`utils.js`, and hashes `sha2.js`/`hmac.js`/`hkdf.js`/`utils.js`. The owner accepted that
delta after the byte-exact, differential, adversarial, Chromium, mobile/Hermes, build, and full
repository gates passed. This is an explicit dependency-risk acceptance, not an independent audit
of Noble 2.x, Ryco's first-party Noise state machine, or the §18 composition. Those independent
review gates remain open and are tracked in the rollout-readiness document.

### 14.3 Mandated primitive behavior

- **Ed25519 verification MUST be strict RFC 8032**: in `@noble/curves` terms, every
  verification call MUST set `zip215: false`. Permissive (ZIP215-style) acceptance is
  forbidden (§7.1); strict verification also provides the non-repudiation properties the
  transcript design assumes.
- **X25519 invalid and low-order inputs**: the pinned implementation rejects all-zero shared
  secrets by throwing, which conforming implementations MUST surface as the single mandated
  behavior — abort the handshake (§8.1). No alternative handling, masking, or retry exists.
- **P-256**: full point validation per §7.1 (uncompressed encoding, coordinates below the
  field prime, on-curve, not the identity); the pinned implementation validates points on a
  cofactor-1 curve. Signatures are fixed-width raw `r ‖ s` with the §7.1 range checks.

_Note (non-normative)_: the zero-output throw was verified in the pinned Montgomery-ladder
source (the implementation throws on an all-zero shared secret after the ladder), matching the
RFC 7748 check and the Noise recommendation (verified 2026-07-30).

### 14.4 Canonical CBOR codec

The canonical-CBOR codec is pinned as `E2EE_CBOR_CODEC` with the §3.6 profile. Its vetting
status, stated plainly: **`cborg` is not audited, and no JavaScript CBOR codec has a formal
third-party audit.** Its determinism properties are battle-tested — it is the foundation of
the IPLD `dag-cbor` codec used at scale across IPFS and Filecoin — which is evidence of
robustness, not a substitute for an audit. The compensating controls are structural: the §3.6
strict-decode options, the mandatory re-encode byte-equality rule wherever bytes are signed or
hashed, the flat tstr/uint/bstr/bool transcript grammar of §7.1 (no floats, no indefinite
lengths, no tags), and the §16 vectors that pin exact bytes. Changing the codec version is a
protocol-relevant change (§3.6) and re-runs the full vector corpus.

### 14.5 Randomness

- **Node (Bun) and web (browsers)**: the built-in WebCrypto `crypto.getRandomValues` is the
  CSPRNG. Web additionally requires a secure context, which the hosted topology guarantees.
- **React Native (Hermes)**: Hermes ships no built-in `crypto.getRandomValues`. The approved
  adapter is the `expo-crypto` `getRandomValues` polyfill, backed by the OS CSPRNG, and it
  MUST be installed globally **before any noble module is imported** — the primitives capture
  the crypto object at module load.
- **Fail closed.** If `crypto.getRandomValues` is absent or the polyfill cannot be installed,
  every E2EE operation MUST fail: no key generation, no handshake, no fallback to a non-CSPRNG
  source, and no degraded mode. A conforming implementation verifies the source at startup
  and refuses E2EE, rather than discovering the absence mid-handshake.

### 14.6 The supported-API rule

An implementation MUST NOT reach into undocumented internals of any cryptographic dependency
and MUST NOT substitute a custom DH/KDF construction for any part of the §6.5 schedule. The
§6.5 exporter/`Split()` surface is the complete supported API of the first-party state
machine — the machine's exporter **is** the documented API, defined by this protocol, so the
no-undocumented-internals rule is satisfied by construction rather than by depending on a
third party's private symbols. No other value may be extracted from handshake state, and the
primitive packages are used only through their documented public entry points.

## 15. Bounds and resource limits

Every bound below is enforced **before** the work it gates; the pre-authentication bounds run
before any signature verification or DH computation. Exceeding any bound is the generic close
of §11 — FATAL-PRE before keys, FATAL-POST after — and MUST NOT create, refresh, or **evict**
any pending client record, and MUST NOT touch latch state, pin state, the device-level
verification marker (§13.1), or any
instrumentation entry other than the fallback counting §12.5 itself defines. That carve-out is the protocol's only durable write reachable on wholly
unauthenticated input — row N2 fires before any hello, key, or signature — which is exactly why
§12.5 bounds its _rate_ with `E2EE_FALLBACK_WRITE_INTERVAL` rather than leaving the write
uncoalesced.

| Bound                                                | Limit                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Enforcement point                                                                                                                                                           |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Simultaneous channels per relay connection           | The Hub-asserted `maxChannels`, itself at most `RELAY_MAX_CHANNELS` — schema-enforced at frame decode, so the Hub can lower it and cannot raise it                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Relay frame decode, unchanged; **this is the structural bound on handshake concurrency**                                                                                    |
| Concurrent in-flight handshakes                      | At most the connection's asserted `maxChannels`, by the row above and one handshake per channel (§4.4)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Node; the in-flight entry is created at §8.6 step 1 and retired at the first of authenticated implicit finish (§8.9), any FATAL-PRE or FATAL-POST outcome, or channel close |
| Handshake-attempt rate                               | Token bucket of capacity `E2EE_HANDSHAKE_RATE_BURST` refilled at `E2EE_HANDSHAKE_RATE_REFILL`, per Hub origin (§3.2.2 L3)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Node, before any signature or DH work                                                                                                                                       |
| Handshake attempts per channel                       | Exactly one (§4.4)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Both endpoints                                                                                                                                                              |
| Client `negotiating` send buffer                     | `E2EE_NEGOTIATION_BUFFER_MAX_BYTES`, charged **per relay connection** — the sum over every channel on it, matching the scope of the single send queue the value is derived from, so a connection's full complement of `negotiating` channels cannot commit a multiple of the queue's capacity (§4.4). Overflow is `e2ee_send_unavailable` (§11.4), never a silent drop and never unbounded growth                                                                                                                                                                                                                         | Client, at submission, while `negotiating` (§4.4)                                                                                                                           |
| `E2EEClientHello` size                               | `E2EE_CLIENT_HELLO_MAX_BYTES`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Both, before body parse (§3.3)                                                                                                                                              |
| `E2EEServerAccept` size                              | `E2EE_SERVER_ACCEPT_MAX_BYTES`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Both, before body parse                                                                                                                                                     |
| `E2EEHandshakeReject` size                           | Exactly `E2EE_HANDSHAKE_REJECT_BYTES`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Both                                                                                                                                                                        |
| Signing-interface input size                         | `E2EE_SIGNING_INPUT_MAX_BYTES`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Node, before **every** call to the identity signing interface (§7.2)                                                                                                        |
| Directly signed transcript size                      | `E2EE_DIRECT_SIGNING_TRANSCRIPT_MAX_BYTES`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Encoder at emit, verifier before signature check (§7.2, §7.3–§7.5)                                                                                                          |
| Capability signing envelope size                     | Exactly `E2EE_CAPABILITY_SIGNING_ENVELOPE_BYTES`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Node before sign, verifier on rebuild (§7.2.1)                                                                                                                              |
| Hub origin length in any E2EE transcript             | `E2EE_HUB_ORIGIN_MAX_BYTES`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Encoder at emit, verifier before use (§7.1)                                                                                                                                 |
| Suite registry entries                               | `E2EE_SUITE_REGISTRY_MAX_ENTRIES`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Node at emit, client before verify (§7.6 element 9)                                                                                                                         |
| Capability statement transcript size                 | `E2EE_CAPABILITY_TRANSCRIPT_MAX_BYTES`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Node at encode and at the §7.6.1 self-check; client before decoding the transcript (§5.2 step 0, §7.6)                                                                      |
| Capability statement CBOR size                       | `E2EE_CAPABILITY_STATEMENT_MAX_BYTES`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Node at emit, client before verify (§5.3)                                                                                                                                   |
| Capability carrier size                              | `E2EE_CAPABILITY_CARRIER_MAX_BYTES`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Node at emit (§5.3, §5.5); never truncated, split, or chunked                                                                                                               |
| Advertisement serviceability                         | Asserted `maxDataChunkBytes` ≥ `E2EE_ADVERTISEMENT_MIN_CHUNK_BYTES`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Node, **once per relay connection** on `ready`, before any channel is accepted (§5.5 U1)                                                                                    |
| Conforming statement available                       | §7.6.1 self-check passes, which includes the advertised protocol range containing `E2EE_PROTOCOL_VERSION` (§7.6 elements 7–8) and the §7.5 continuity-id startup cross-check resolving to a single advertisable value — element 18 is REQUIRED, so a node that cannot resolve it has no conforming statement and MUST NOT mint one (§7.5, §5.5 U2)                                                                                                                                                                                                                                                                        | Node at startup and after every rotation, prune, prekey rotation, and policy change (§5.5 U2)                                                                               |
| Negotiation records per channel                      | One carrier, one hello, one accept **or** reject; duplicates fatal (§4.4)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Both                                                                                                                                                                        |
| Continuity chain depth                               | `E2EE_CONTINUITY_CHAIN_MAX_LENGTH`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Node at emit, client before verify (§7.5)                                                                                                                                   |
| Node-id resolution hints per pin record              | `E2EE_PIN_NODE_ID_HINTS_MAX`, oldest-first eviction                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Native client, on recording a hint (§13.1)                                                                                                                                  |
| Device-level verification markers                    | One boolean per configured Hub origin, and no other content. Set **only** by the §13.2 step 5 owner ceremony — atomically with the pin promotion — or by the client-local reconciliation §13.1 requires against the client's own pin set, and cleared **only** by the §13.3 owner-initiated re-pair that leaves no verified pin under that origin, so it is unreachable from unauthenticated input and deliberately carries no numeric cap of its own (§13.1, §13.3)                                                                                                                                                      | Native client                                                                                                                                                               |
| `E2EEError` body size                                | `E2EE_ERROR_BODY_MAX_BYTES`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Both (§11.3)                                                                                                                                                                |
| Account id length                                    | `E2EE_ACCOUNT_ID_MAX_BYTES`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Both (§7.1)                                                                                                                                                                 |
| Envelope message size                                | `RELAY_MAX_RPC_MESSAGE_BYTES` and the Hub-asserted chunk limits, on encrypted bytes (§4.5)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Relay chunking layer, unchanged                                                                                                                                             |
| Inner-record body size                               | `plaintextCeiling`, pre-encryption (§4.5)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Sender                                                                                                                                                                      |
| Advertisement wait                                   | `T_ADV` (§4.4)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Client                                                                                                                                                                      |
| Authenticated trust-commit deadline                  | `T_TRUST_COMMIT`, after a usable verified statement cancels `T_ADV` and before hello emit (§4.4 K1, §5.2). Expiry closes the channel but does not cancel the underlying durable mutation                                                                                                                                                                                                                                                                                                                                                                                                                                  | Native client                                                                                                                                                               |
| Handshake deadline, client                           | `T_HANDSHAKE`, from hello emit (§4.4 K15); together with the one-attempt-per-channel rule it is also the bound on `WebSAS` grinding (§13.5, §17.5)                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Client, always                                                                                                                                                              |
| Handshake deadline, node                             | `T_HANDSHAKE_NODE`, from advertisement emit (§4.4 N8, §8.9)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Node: the `negotiating` half under effective `requireE2EE`; the implicit-finish half **always** (§8.9)                                                                      |
| Negotiating-window keepalive budget                  | `T_ADV + T_TRUST_COMMIT + T_HANDSHAKE + T_KEEPALIVE_FLUSH_MARGIN ≤ RPC_KEEPALIVE_INTERVAL` (§3.2.2 L1)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Client; a specification-level invariant, checkable from §3.2                                                                                                                |
| Close-phase keepalive budget                         | `2 · T_CLOSE + T_CLOSE_LINGER_MAX + T_KEEPALIVE_FLUSH_MARGIN ≤ RPC_KEEPALIVE_INTERVAL` (§3.2.2 L5). The close phase suppresses the keepalive `Ping` with **no** later flush, so this bounds the whole phase rather than reserving a flush; `T_CLOSE` is charged twice because the simultaneous branch of §10.2 contains two `T_CLOSE`-bounded waits. It removes the deterministic case and not the residual of §17.14                                                                                                                                                                                                     | Client; a specification-level invariant, checkable from §3.2                                                                                                                |
| Close-exchange step deadline                         | `T_CLOSE` (§10.2)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Both                                                                                                                                                                        |
| Close-exchange wait steps per endpoint per phase     | At most two — one on either sequential path, two on the simultaneous path, never three (§10.2)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Both                                                                                                                                                                        |
| Last-record linger before the outer close            | At most `T_CLOSE_LINGER_MAX` (§10.3)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | The endpoint that sent the last close-machine record                                                                                                                        |
| Close-machine records per endpoint per exchange      | At most `E2EE_CLOSE_RECORDS_RESERVED` (§10.2)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Both                                                                                                                                                                        |
| Terminal `E2EEError` records after the close machine | At most `E2EE_ERROR_RECORDS_RESERVED`, and nothing else may follow it (§10.2, §11.3)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Both                                                                                                                                                                        |
| Post-application sequence reservation                | `E2EE_CLOSE_RECORDS_RESERVED + E2EE_ERROR_RECORDS_RESERVED` records under **both** §9.4 thresholds, per direction (§9.6)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Sender, before protecting any application record                                                                                                                            |
| Policy-withdrawal sweep                              | Every live channel the narrowed policy would no longer admit, closed — and every in-flight handshake it would refuse, aborted — before the operator command is acknowledged (§12.6); `e2ee` channels as FATAL-POST `Q12` code `policy`, `legacy` channels as a bare `channel_rejected`, in-flight handshakes as FATAL-PRE `P25`. Both enumerations run over **one consistent snapshot** of channel state, walking the in-flight handshake list of the row above alongside the live-channel set, so no channel can cross row N3 between them; §8.6 step 2 additionally serializes that transition against the §12.6 commit | Node, operator-initiated                                                                                                                                                    |
| Transmission admission before protection             | Whole record, every chunk, admitted before the pair is assigned (§9.3); refusal is `e2ee_send_unavailable` (§11.4)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Sender                                                                                                                                                                      |
| Pending client records                               | `E2EE_PENDING_CLIENTS_MAX_GLOBAL`, `E2EE_PENDING_CLIENTS_MAX_PER_ACCOUNT`, `E2EE_PENDING_CLIENT_RETENTION` (§13.6); the per-account key is a bookkeeping partition, not an isolation boundary (§13.6)                                                                                                                                                                                                                                                                                                                                                                                                                     | Node                                                                                                                                                                        |
| Owner pairing window                                 | `E2EE_PAIRING_WINDOW`, and **at most one** pending record admitted per window (structural, §13.6). The window MUST name an owner-supplied discriminator — the client identity fingerprint — and only an attempt whose authenticated `clientIdentityFingerprint` equals it receives the reservation. Its cap-exceeding attempt then evicts the oldest _eligible_ pending record **in the partition of the cap that was exceeded**, per-account governing when both are exceeded, and never touches `approved` or `revoked` state (§13.6)                                                                                   | Node, owner-initiated                                                                                                                                                       |
| Pairing reservation lifetime                         | `E2EE_PAIRING_RESERVATION_LIFETIME` from record creation; past it the record becomes eligible for pairing-window eviction again, while its own expiry stays at `E2EE_PENDING_CLIENT_RETENTION` (§13.6). The ordering of the three durations is §3.2.2 L4, a specification-level invariant checkable from §3.2                                                                                                                                                                                                                                                                                                             | Node                                                                                                                                                                        |
| Per-channel advertised-statement snapshot            | The identity, prekey, continuity-chain, and continuity-id material the node advertised on that channel — exactly what §8.3 elements 7–9, 15, and 17 are built from, and no other statement content. At most one per channel, at most `E2EE_CONTINUITY_CHAIN_MAX_LENGTH` chain entries, held from advertisement emit until the channel closes and consumed at §8.6 step 7 (§7.5, §8.3). It is in-memory channel state, not durable state, and the channel count is already bounded by the first row above                                                                                                                  | Node                                                                                                                                                                        |
| Per-channel admitted-authority snapshot              | The full Branch A record key `(hubOrigin, accountId, clientIdentityFingerprint)` plus the `status`, `maxRole`, and `capabilitySet` read at §8.6 step 6, and no other record content. Recorded on the in-flight handshake entry at that read and retained for the channel's lifetime; consumed by the §13.6 withdrawal test and the §8.9 re-check. NX channels carry none                                                                                                                                                                                                                                                  | Node (IK only)                                                                                                                                                              |
| Approved / revoked client records                    | `E2EE_APPROVED_CLIENTS_MAX`, `E2EE_REVOKED_CLIENTS_RETAINED_MAX` (§13.6)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Node                                                                                                                                                                        |
| Last-seen write rate                                 | `E2EE_LAST_SEEN_WRITE_INTERVAL` (§13.6)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Node                                                                                                                                                                        |
| Fallback counter write rate                          | `E2EE_FALLBACK_WRITE_INTERVAL`, leading-edge then coalesced (§12.5)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Node                                                                                                                                                                        |
| Fallback ring                                        | `E2EE_FALLBACK_RING_SIZE` (§12.5); evictions past it are counted by the per-class monotonic **ring-overflow counter**, which stores a count and no occurrence fields, so the retained set is two integers wider and no more identifying (§12.5, §12.3)                                                                                                                                                                                                                                                                                                                                                                    | Node                                                                                                                                                                        |
| Rekey thresholds                                     | `E2EE_REKEY_MAX_RECORDS`, `E2EE_REKEY_MAX_BYTES` (§9.4)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Both, per direction                                                                                                                                                         |
| Sequence exhaustion                                  | `E2EE_COUNTER_MAX`, `E2EE_EPOCH_MAX` (§9.6)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Both, per direction                                                                                                                                                         |

**The size bounds above are mutually consistent, and that is a checkable claim.** The rows for
the signing interface, the transcript, the statement, the carrier, and the advertisement floor
are not independent limits that happen to coexist: §3.2.1 states S1–S11 as inequalities over
constant names, S4–S6 derive the statement, carrier, and floor from the transcript bound, and
S8–S9 are discharged by generated fixtures (§16.3 F3, F5) that build the worst case and assert
its exact byte length. A revision that changes one of these constants, or adds an element to any
signed transcript, must re-satisfy S1–S11 or it will fail those fixtures. The §5.5 worked example
carries the current worst-case arithmetic end to end.

**Where the concurrency guarantee actually comes from.** An earlier revision named two constants
— a global and a per-Hub-origin in-flight handshake cap — as the source of the bound on
cryptographic concurrency. Both sat _above_ the structural maximum and could therefore never
fire: a node holds one relay connection, that connection carries at most the asserted
`maxChannels` simultaneous channels and at most `RELAY_MAX_CHANNELS` under any assertion the
frame schema will decode, and §4.4 permits exactly one handshake per channel. The constants were
dead and the guarantee was being supplied by a limit this document never named. They are deleted
and the first two rows above state the real bound. Note what that means honestly: the structural
bound is set by an integer the **untrusted** Hub asserts in `ready`. That is safe in this
direction only — the Hub can lower `maxChannels` (a denial-of-service lever it already holds in
stronger forms) and cannot raise it past `RELAY_MAX_CHANNELS`, because the bound is enforced at
frame decode rather than by agreement.

**Why the rate limit is scaled the way it is, and why there is no reserved approved-client
budget.** The handshake-attempt budget is a **node-resource guard, not an authorization
control**. It is expressed as a token bucket whose burst covers a full channel complement
(§3.2.2 L3) and whose refill is at or above the rate at which the Hub deployment is entitled to
authorize fresh channels for one node, so a conforming node never refuses a handshake the Hub
was entitled to authorize. An earlier revision set it far below that — a single fixed budget per
Hub origin, which for a node serving exactly one Hub origin is one global budget shared by every
client — and a node enforcing it would have rejected connections the Hub had legitimately
authorized. Reserving a sub-budget for helloes that resolve to an `approved` Branch A record was
considered and **rejected**: it would make a pre-crypto gate depend on a post-crypto outcome,
inverting the ordering §8.6 step 1 exists to establish, and it would turn remaining budget into a
per-key observable, cutting directly against §11.2's requirement that approval membership not be
distinguishable. The honest per-client fairness lever pre-authentication is the relay channel
itself, which is already one per client connection. Backpressure on the client side is likewise
not re-invented here: the hosted reconnect policy already applies exponential backoff with
jitter and only resets its attempt counter after a sustained stable connection, so a FATAL-PRE
within a second of channel accept escalates the delay rather than resetting it (verified against
`packages/client-runtime/src/relay/reconnectPolicy.ts:23-26,36`, 2026-07-30). A client MUST NOT
hot-retry after FATAL-PRE.

**Malicious-relay denial-of-service honesty.** These bounds do not — and cannot — prevent a
malicious Hub from denying service: it can withhold traffic, drop advertisements, close
channels, burn tickets, assert a data-chunk limit too small to carry any conforming
advertisement (§5.5 U1), and saturate the pending-record caps with fabricated self-signed
identities (§13.6, §17.16), all at will (§17). What the bounds guarantee is that no sequence of
valid-looking channels can drive unbounded node memory, unbounded durable-state growth
(pending-record floods never evict approved or revoked state, §13.6), unbounded durable **write
rate** (§12.5's coalescing bounds the one unauthenticated-input-driven write), or unbounded
cryptographic concurrency. Denial of service against an untrusted relay is out of scope;
resource exhaustion of the node through the relay is not. Two things the bounds deliberately do
**not** provide are stated rather than implied: there is no per-channel idle deadline in
`legacy` or in established `e2ee` (§4.4), and there is no per-account concurrent-channel quota.
Both belong to the relay and Hub authorization layers, and with `maxChannels` at most
`RELAY_MAX_CHANNELS` the exposure is identical to a deployment with no E2EE at all.

The absence of an idle deadline is why neither the authority a channel was admitted under nor the
policy that admitted it can be left to expire on its own. A `legacy` or established `e2ee`
channel persists for as long as its peer keeps it, and the peer is reachable only through the
party this protocol treats as the adversary, so **both** narrowings need an explicit sweep:

- the §13.6 **authorization-withdrawal** sweep removes a withdrawn client authority — revocation,
  `maxRole` reduction, and `capabilitySet` removal alike — ordered before the CLI acknowledges the
  change, with §8.9's re-check as the fallback for an implementation that cannot locally prove
  that ordering. Both consume the per-channel admitted-authority snapshot listed above; without it
  a sweep could match only the client fingerprint and would reach channels in
  `(hubOrigin, accountId)` scopes the owner never touched;
- the §12.6 **policy-withdrawal** sweep removes a channel the node's own narrowed admission policy
  would no longer admit — every `legacy` channel under a newly effective `requireE2EE`, every NX
  `e2ee` channel under `requireApprovedClientE2EE` or an admitted-pattern reduction, and every
  `e2ee` channel of **either tier** whose suite left the registry — likewise ordered before the
  acknowledgement, and paired with the FATAL-PRE abort (`P25`) of every in-flight handshake the
  narrowed policy would refuse. It consumes no Branch A record and no snapshot: its inputs are the
  channel's mode, tier, and suite. The tier qualification differs by clause and §12.6 states it in
  one place: only the `requireApprovedClientE2EE` and admitted-pattern clauses are NX-only.

The two are disjoint and an implementation MUST run both. Neither is an idle deadline, and this
document does not introduce one: both fire on an explicit owner or operator action and never on
the passage of time.

## 16. Test vectors and fixtures

### 16.1 Fixture home and generation

- **Directory**: `packages/shared/fixtures/e2ee/v1/` — beside the reference module (§1.1).
  E2EE vectors MUST NOT be placed in `packages/contracts/fixtures/relay/`, which belongs to
  the relay contract corpus this protocol does not touch (§1.1).
- **Generator**: a new script `scripts/generate-e2ee-fixtures.ts`, following the established
  generator convention of `scripts/generate-relay-fixtures.ts` — a deterministic script that
  exports the fixture root, a corpus-generation function, and a write function; a root
  `generate:e2ee-fixtures` package script; and a sibling drift test that regenerates the
  corpus in memory and compares the committed files **byte for byte**, never updating them
  automatically. Fixtures are generated, never hand-edited.
- **Determinism**: fixed constant inputs only — fixed seeds, fixed identifiers, fixed
  timestamps, fixed nonces — no ambient randomness or clock reads. Handshake ephemerals are
  injected through the generator's test-only randomness source.
- **TEST-ONLY keys.** Every private key, seed, and ephemeral in the corpus is deterministic
  and conspicuously marked: the manifest carries a top-level warning that the material is
  deterministic test material and must never be used for a real endpoint, and every key
  field name carries a `testOnly` prefix. Fixture keys MUST never be accepted by any
  production code path.

The vectors are generated by the reference implementation once it exists; this section is the
normative enumeration the generator MUST satisfy, and the corpus MUST be reviewed against it.

### 16.2 File format

One JSON file per vector family, named `f<nn>-<slug>.json`, plus a `manifest.json` listing
`formatVersion`, the warning above, the encoding identifier (`deterministic-cbor-rfc8949` for
transcript bytes), and, per file, its SHA-256 digest. Inside a family file: a `family` header
(number, title, section references), the shared test-key material, and a `cases` array. Every
case has a stable `name`, its `inputs`, and its `expected` outputs; byte strings are JSON
objects of the form `{"$bytes": "<lowercase hex>"}`; expected failures name the §11 condition
row (for example `"expected": {"fatal": "P13"}`) rather than any implementation-specific
message.

### 16.3 Required vector families (normative)

The corpus MUST contain the following families and cases. Where a case names an expectation
class, the §11 tables define it.

- **F1 — Payload discrimination and chunk pipeline** (§4.2, §4.3, §4.5):
  prelude ‖ envelope (prelude stripped, first byte `E2EE_ENVELOPE_DISCRIMINATOR`); envelope
  without prelude (no-headroom path, surfaced unchanged); chunked envelope whose chunk
  payloads start `RELAY_CHUNK_MAGIC` (reassembles to the envelope); prelude ‖ legacy JSON
  (surfaced as legacy JSON); envelope exactly at the prelude-headroom boundary and one byte
  over (prelude present, then absent); ciphertext with interior `0x00` runs (never enters the
  chunk parser post-strip); envelope with a zero-length inner body (valid); inner body exactly
  at `plaintextCeiling` (sent) and one byte over (`e2ee_message_too_large`, nothing
  transmitted).

  **Empty-payload cases (§3.4, §4.3 step 2).** The corpus MUST additionally carry the
  zero-length post-strip payload along **both** of its reachability paths, in `negotiating`,
  `e2ee`, and `legacy`: a `data.payload` of length zero, and a `data.payload` equal to exactly
  `RELAY_CHUNK_CAPABILITY_PRELUDE`. Each case expects `P6` before keys and `Q6` after, and the
  prelude case MUST additionally assert that the peer's chunk-support latch still **sets** before
  the fatal outcome is taken. These are distinct from the zero-length inner-body case above,
  which is a valid §9.1 record.

- **F2 — Capability carrier compatibility** (§5.6, §5.5): one case per compatibility case
  C1–C6, each with exact carrier bytes (with and without prelude where applicable) and the
  required outcome — including the C5 defect-reply demonstration of the prohibited
  client-to-node direction. Plus the carrier boundary pair: the maximum conforming carrier of F3
  presented at an asserted `maxDataChunkBytes` of exactly
  `E2EE_ADVERTISEMENT_MIN_CHUNK_BYTES` (emitted unchunked, prelude intact) and at one byte below
  it (§5.5 U1 — advertisement suppressed, one `undersized-connection` occurrence recorded, **no**
  peer-legacy occurrence, and FATAL-PRE under effective `requireE2EE`). This family is the
  normative enforcement point for §5.6's version binding: each case MUST fail if the pinned RPC
  client's behavior regresses, and the family MUST be re-run against any new build before a
  changed `effect` pin — or a changed patch touching its RPC client — lands.
- **F3 — Capability statement** (§5.2, §5.7, §7.2.1, §7.6, §3.2.1): a valid statement
  (transcript bytes, §7.2.1 envelope bytes, signature, recomputed fingerprints, reconstructed
  prekey cross-signature); and invalid variants — expired, future issued-at, over-long validity
  interval, wrong Hub origin, lower policy generation, fingerprint mismatch, cross-signature
  reconstruction failure, oversized statement (re-anchored to the current
  `E2EE_CAPABILITY_STATEMENT_MAX_BYTES`), re-encode inequality (non-canonical bytes).

  **Size-invariant cases (these discharge §3.2.1 S1, S3, S4, S5, S6, S8).** The generator MUST
  emit, with exact expected byte lengths rather than bounds:
  - the **maximum conforming statement**: `E2EE_CONTINUITY_CHAIN_MAX_LENGTH` chain entries, a
    Hub origin of exactly `E2EE_HUB_ORIGIN_MAX_BYTES`, `E2EE_SUITE_REGISTRY_MAX_ENTRIES` suite
    ids, and the widest canonical integer encoding for every unsigned field — asserting the exact
    transcript length, the exact statement length, the exact base64url length, and the exact
    carrier JSON length against their §3.2 constants, plus
    `carrier + RELAY_CHUNK_CAPABILITY_PRELUDE_BYTES ≤ E2EE_ADVERTISEMENT_MIN_CHUNK_BYTES`. These
    are the figures tabulated in the §5.5 worked example, element by element; a mismatch means a
    transcript element changed and a constant did not. The generator MUST emit **two** numbers
    here and assert both: the §5.5 upper bound, which charges every unsigned field its widest
    canonical encoding including the version and suite-id fields whose version-1 registry values
    encode in one byte; and the largest statement that actually **validates** under those
    registries. The two differ by exactly the over-charge §5.5 names, and pinning both is what
    keeps the size argument an upper bound without pretending an unreachable statement is
    reachable;
  - the same statement one byte over `E2EE_CAPABILITY_TRANSCRIPT_MAX_BYTES` (rejected at §5.2
    step 0, and refused at emit by §7.6.1) and exactly at the bound (accepted);
  - a Hub origin exactly at and one byte over `E2EE_HUB_ORIGIN_MAX_BYTES` (accepted, then
    rejected — §7.1);
  - a suite registry exactly at and one entry over `E2EE_SUITE_REGISTRY_MAX_ENTRIES`;
  - the §7.2.1 envelope for a minimum-size and a maximum-size transcript, asserting **identical**
    lengths equal to `E2EE_CAPABILITY_SIGNING_ENVELOPE_BYTES` and both within
    `E2EE_SIGNING_INPUT_MAX_BYTES`;
  - a statement whose signature was computed over the raw transcript bytes instead of the
    §7.2.1 envelope (invalid), and one whose envelope was built from a digest of different
    transcript bytes than those carried (invalid);
  - the largest §7.3, §7.4, and §7.5 transcripts at `E2EE_HUB_ORIGIN_MAX_BYTES` and
    `E2EE_ACCOUNT_ID_MAX_BYTES`, asserting each is within
    `E2EE_DIRECT_SIGNING_TRANSCRIPT_MAX_BYTES` (§3.2.1 S9).

  Additionally: a valid statement from a never-rotated node, asserting that element 18
  `continuityId` is present with an empty element 11 chain; a statement omitting element 18 and
  one carrying a malformed continuity id (both invalid); a statement whose element 18 disagrees
  with a carried chain entry (invalid, §7.5); a statement whose continuity id differs from the
  pinned value (channel-fatal with the
  §13.3 re-verification expectation, **not** a new-node outcome); and the §5.7 policy-generation
  recovery pair — a statement at generation _N_ presented to a client holding _N + k_ (rejected,
  local diagnostic `e2ee_policy_generation_regressed`, no ceremony launched) followed by a
  statement at a generation strictly above _N + k_ (accepted).

  **Protocol-range cases (§5.2 step 8, §7.6 elements 7–8).** The corpus MUST carry a
  fully valid, correctly signed statement whose advertised range **excludes**
  `E2EE_PROTOCOL_VERSION` — both bounds strictly above it — and one whose range is inverted
  (`e2eeVersionMin > e2eeVersionMax`). Each MUST be run twice against the same bytes: with the
  channel's selection **not latched**, expecting row K3 — unusable evidence, **no hello emitted**,
  the ticket not spent on a hello, and the `T_ADV` rows still deciding the channel; and with the
  selection **latched**, expecting `P15`. Both cases MUST assert explicitly that no
  `E2EEClientHello` was produced, since sending one is what an implementation that leaves elements
  7–8 unconsumed would do. A companion node-side case MUST deliver a hello whose `e2eeVersion`
  lies outside the range the node advertised on that channel, expecting `P9` with the §11.5
  observable byte-identical to the F12 reject cases. A boundary case MUST also carry a range whose
  minimum equals `E2EE_PROTOCOL_VERSION` and whose maximum is strictly greater, expecting the
  ordinary K1 path, so the check is a range test and not an equality test.

  **Admitted-pattern cases (§5.2 step 9, §7.6 element 14, §8.2).** The corpus MUST carry a fully
  valid, correctly signed statement whose element 14 is exactly `["IK"]` — the set a node running
  `requireApprovedClientE2EE` advertises (§12.4) — evaluated as a **web** client, whose tier runs
  `"NX"` (§8.1). The reachable version-1 configuration is the **latched** one, because §12.1 sets
  the web latch on the statement's own validation and step 9 runs after it: that run expects
  `P15`, and it MUST be run with the channel's buffered sends **non-empty**, asserting that none
  was flushed as plaintext. The same bytes MUST also be run with the selection **not latched**,
  expecting row K3 — unusable evidence, the `T_ADV` rows still deciding the channel. That second
  run is a rule-level case rather than a reachable web one, and the corpus MUST label it as such:
  it pins the K3 branch of the same guard for the first future tier whose latch is unset, and
  asserting it does not claim a conforming version-1 web client can occupy that state. Both runs
  MUST assert explicitly that **no** `E2EEClientHello` was produced and that the single-use ticket
  was not spent on one, since emitting the hello is exactly what an implementation leaving element
  14 unconsumed would do. A companion case MUST evaluate the identical statement as a **native**
  client, whose tier runs `"IK"`, expecting the ordinary K1 path — so the check is a membership
  test against the client's own pattern and not a length or literal test on the set. A further
  case MUST carry `["IK", "NX"]` evaluated as web, also expecting K1. A node-side companion MUST
  deliver an NX hello to a node running `requireApprovedClientE2EE`, expecting `P9` with the §11.5
  observable byte-identical to the F12 reject cases — the enforcement that remains when a client
  ignores the field.

- **F4 — Prekey certificates** (§7.3, §7.4, §6.4): valid node and client certificates
  (transcript bytes and signatures); expiry exactly at and one beyond the
  `E2EE_MAX_CLOCK_SKEW` boundary; wrong namespace (`hubOrigin`, `accountId`); usage-field
  mismatch against the suite; strict-decode failures.
- **F5 — Continuity chains** (§7.5, §13.3, §5.5): valid chains of length one and of
  `E2EE_CONTINUITY_CHAIN_MAX_LENGTH` with the silent-pin-update expectation; and one case each
  for missing link, spliced key, reordered entries, truncated chain, generation gap and
  regression, invalid signature, over-length chain, mixed continuity ids within the chain, a
  chain entry whose continuity id disagrees with statement element 18, and a chain whose
  continuity id disagrees with the pinned value — each channel-fatal with the re-verification
  expectation.

  **Continuity-id storage and anchor cases (§7.5).** These are node-state transition cases rather
  than wire vectors: each states the node's stored continuity id, its continuity-id anchor, its
  chain depth, and its rotation generation, and expects one of the five §7.5 startup outcomes.
  The corpus MUST carry, at minimum: anchor and stored value both unset (mint exactly once,
  crash-atomically, anchor committed before the first advertisement); anchor and stored value
  equal (normal); **anchor set with the stored value absent, on a node whose chain is empty and
  whose rotation generation is 0** — the benign never-rotated restore, expecting the stored value
  restored from the anchor, the identical id re-advertised, **no** mint and **no** client-visible
  event, and the case MUST assert explicitly that it is not the §13.3 re-verification outcome,
  since minting is what a node without the anchor would have done; anchor unset with a stored
  value present (adopt into the anchor, no mint); and anchor and stored value both present and
  different, plus an unreadable anchor (each: no advertisement, no mint, §5.5 U2 with the
  `statement-unavailable` label, FATAL-PRE `P23` under effective `requireE2EE`, suppression and
  one **advertisement-unavailable** occurrence otherwise). A migration case MUST cover a node
  whose identity predates this protocol: one mint at upgrade, durable before the first
  advertisement.

  The `E2EE_CONTINUITY_CHAIN_MAX_LENGTH` case MUST be run **twice**: once with a short test Hub
  origin, and once with a Hub origin of exactly `E2EE_HUB_ORIGIN_MAX_BYTES`. A max-depth chain
  with a short origin passes every size bound trivially and would miss the interaction that
  actually breaks the arithmetic — the origin is repeated once per chain entry and once in the
  statement, so depth and origin length multiply. Both runs MUST assert the resulting carrier
  fits `E2EE_CAPABILITY_CARRIER_MAX_BYTES` and that
  `carrier + RELAY_CHUNK_CAPABILITY_PRELUDE_BYTES ≤ E2EE_ADVERTISEMENT_MIN_CHUNK_BYTES`, so
  chain depth and carrier fit can never drift apart in separate fixtures again. The long-origin
  run MUST additionally assert the silent-pin-update expectation is **unchanged** by origin
  length: effective chain depth is not permitted to depend on how long the Hub origin is.

- **F6 — IK handshake** (§8): a complete deterministic handshake with every named
  intermediate as an expected output: context block bytes, `contextCommitment`, prologue
  bytes, `E2EEClientHello` wire bytes, IK message-1 payload plaintext, `ServerAcceptTBS`
  bytes, `exporterSecret`, `serverConfirmationKey`, `confirmationTranscript`,
  `serverConfirmation`, final `E2EEServerAccept` wire bytes, `sessionBindingHash`, `k_c2n`,
  `k_n2c`, both epoch-0 AEAD keys, and the first protected envelope in each direction
  (implicit finish included).
- **F7 — NX handshake** (§8): the same shape for NX, plus: the empty message-1 payload rule
  (a nonempty payload case expecting failure) and the responder-static byte-equality check
  (mismatch case expecting failure).
- **F8 — Record protection** (§9.1–§9.3): exact AAD bytes for both directions; envelopes at
  counters zero and one; a control record consuming the shared sequence; a tampered header
  byte, a wrong direction label, and a wrong `sessionBindingHash` — each failing
  authentication.
- **F9 — Rekey boundaries** (§9.4–§9.6): epoch secrets and AEAD keys for epochs zero through
  two in both directions; the record-count boundary at `E2EE_REKEY_MAX_RECORDS` (boundary
  record is the last of its epoch; successor carries epoch +1, counter 0); the byte-threshold
  crossing at `E2EE_REKEY_MAX_BYTES` (the crossing record is the last); early, late, and
  skipped epoch transitions (each fatal); synthetic counter- and epoch-exhaustion states with
  the authenticated-close expectation — each asserting that a **complete** close exchange is
  protected entirely out of the `E2EE_CLOSE_RECORDS_RESERVED` half of the §9.6 post-application
  reserve in the final epoch,
  once for the sequential initiator (`E2EEClose` plus final confirmation), once for a
  simultaneous close (`E2EEClose` plus `E2EECloseAck`), and once for the sequential responder,
  which leaves the remainder of its reserve unused; plus a synthetic state holding less than
  the post-application reserve, expecting the §9.6 degenerate outcome (no wrap, no reuse, verdict
  unclean-abrupt).

  **Terminal-error reserve cases (§9.6, §10.2, §11.3).** The corpus MUST additionally carry, in
  the terminal epoch: a complete sequential-initiator exchange that has spent both close-machine
  records, followed by a stray protected envelope, asserting that the resulting `E2EEError` is
  protected out of `E2EE_ERROR_RECORDS_RESERVED` at the next `(epoch, counter)` with **no** wrap,
  no reuse, and no third close-machine record — this is the case that fails against an
  implementation sizing the reserve at `E2EE_CLOSE_RECORDS_RESERVED` alone; and the same trace
  from a synthetic state whose remaining capacity covers the close machine but not the error
  record, expecting the close without the error record and the §11.5 "send path unusable"
  observable rather than a wrap or a dropped obligation.

- **F10 — Mode machine** (§4.4): one case per transition row N1–N17 and K1–K24 — input
  payload bytes and state, expected action and next state — including plaintext injection
  after E2EE, envelope and negotiation injection after a legacy lock, and an unknown first
  byte in every state. The legacy-lock injection cases MUST name their §11 row per §16.2, and the
  rows are disjoint by §11.2's partition: an envelope after the lock is `P5`, a negotiation record
  after the lock is `P24` — carried at minimum as a correctly sized, correctly directed
  `E2EEClientHello` at the node and `E2EEServerAccept` at the client, which are neither over-bound
  nor misdirected and therefore **not** `P3` — and an unknown or absent first byte is `P6`. Each
  MUST also assert the disposition is FATAL-PRE, since no session keys exist in `legacy`.
  Rows N15–N17 are driven by a connection-level input rather than a
  payload: each case MUST state the asserted `maxDataChunkBytes`, the §7.6.1 self-check result,
  and the effective `requireE2EE` value, and MUST assert which §12.5 class (if any) recorded an
  occurrence — including the N17 case, which MUST assert that **no** peer-legacy occurrence is
  added on top of N16's.

  The client rows are driven by a §12.1.1 selection classification, which each case MUST state
  explicitly as an input alongside the payload bytes — and, since the classification is keyed on
  more than the pin, each case MUST also state the `(hubOrigin, accountId)` scope it runs under
  and the value of the device-level `anyNodeVerified(hubOrigin)` marker (§13.1). The corpus MUST
  include, at minimum:
  latched selection with the carrier **withheld** and `T_ADV` expiring (K14 → FATAL-PRE, no
  buffered send ever flushed); latched selection receiving non-carrier legacy JSON at data
  sequence 0 (K10 → FATAL-PRE); unexpected selection under a `(hubOrigin, accountId)` pair
  holding a verified pin, with the carrier withheld (K24 → FATAL-PRE plus the §13.2.1
  unexpected-node surface, never an automatic legacy lock) and with non-carrier legacy JSON
  (K23, same expectation);
  the same unexpected selection **after** a recorded owner legacy consent (now legacy-eligible:
  K13 / K9 lock legacy); and a legacy-eligible first-contact selection under a pair holding no
  verified pin **and with the marker unset** (K13 locks legacy — the §17.4 retained exposure).

  **Account-scope-change cases (these discharge the §12.1.1 provenance rule).** The corpus MUST
  additionally carry the account re-mint end to end: start from a device holding a `verified`,
  latched pin under `(H, A, handle)`, then replay the identical channel under `(H, A′)` with the
  carrier **withheld**. The expected row is **K24** — FATAL-PRE, the §13.2.1 situation-3 surface,
  buffered sends discarded unflushed — and the case MUST assert explicitly that it is **not**
  K13, since K13 is what a pair-scoped-only classification would have produced. A companion case
  MUST run the same scope change with non-carrier legacy JSON (K23, same expectation), and a
  third MUST run a genuinely fresh install under `(H, A′)` with the marker **unset**, expecting
  K13, so the fixtures separate "the Hub moved the account scope" from "this install has never
  verified anything here" by the marker alone.

  No case may combine an **unset** marker with a `verified` pin under any account scope on the
  same Hub origin: §13.1 makes the marker a lower bound on the pin set, so that combination is an
  unrepresentable state, and a corpus encoding it would legitimize exactly the crash or
  staged-rollout window the marker exists to close.

  Cases MUST assert the classification is computed **before** any payload arrives, so a case with
  no input bytes at all still yields a determinate row. Cases whose classification depends on
  durable pin state or on the marker are native-tier; the §16.4 browser run exercises the
  degenerate web mapping of §12.1.1 instead, including the same withheld-carrier case before and
  after the session's first validated statement (K13 then K14).

  **Timer and keepalive cases (these discharge §3.2.2 L1 and L2, and the §8.9 deadline).** An
  authenticated trust commit crosses a local operating-system storage boundary and therefore is
  not expressible as a deterministic wire vector. Native implementation tests MUST hold a usable
  statement's durable trust mutation unresolved and assert that `T_ADV` is cancelled immediately,
  no hello or application record is emitted before settlement, success becomes visible before
  hello emit, rejection is local FATAL-PRE, and exact `T_TRUST_COMMIT` expiry closes with zero
  output. Late success and late rejection after expiry or cancellation MUST NOT resume the
  channel, double-close it, or publish into a different active selection; the underlying durable
  mutation remains fenced until it actually settles.

  The corpus MUST additionally include:
  - **Stalled accept (K15).** A valid carrier, a valid hello, and then `E2EEServerAccept`
    withheld past `T_HANDSHAKE`. The case MUST assert the complete §11.5 observable — no record
    from the client, `channel_rejected`, zero application payload — and MUST assert that **no
    plaintext left the client at any point in `negotiating`, including no keepalive `Ping`**.
    This is the case that catches a runtime whose transport-level dead-peer verdict pre-empts
    K15, which is exactly the defect §3.2.2 L1 exists to prevent, so it MUST be re-run whenever
    the pinned RPC client changes.
  - **Buffered keepalive round trip.** A handshake that completes at the far end of the client
    budget, asserting that the keepalive `Ping` buffered during `negotiating` is flushed as an
    **envelope** on entering `e2ee` (and as plaintext on entering `legacy` via K13), never
    dropped and never emitted as plaintext before the mode locks.
  - **Send-buffer overflow.** Submissions past `E2EE_NEGOTIATION_BUFFER_MAX_BYTES` while
    `negotiating`, asserting `e2ee_send_unavailable` (§11.4), that the channel is unaffected and
    still reaches `e2ee`, and that nothing was silently dropped. The family MUST additionally
    carry a **multi-channel accounting** case: two or more channels `negotiating` on one relay
    connection, each buffering below the budget while their sum exceeds it, expecting the
    submission that crosses the connection-wide total to be refused with `e2ee_send_unavailable`.
    The case MUST assert that this is not per-channel accounting, since per-channel accounting
    would admit it (§4.4, §15).
  - **Node deadline under each policy.** `T_HANDSHAKE_NODE` expiry while `negotiating` MUST fire
    N8 under effective `requireE2EE` and MUST NOT fire it under the compatibility default; the
    same deadline expiring **after** row N3 with no authenticated implicit finish MUST be
    FATAL-POST `Q8` under **both** policies (§8.9).

- **F11 — Authenticated close** (§10): a sequential clean close (all three records — the
  initiator's `E2EEClose`, the responder's `E2EECloseAck`, and the initiator's final
  confirmation, §10.2 — with their bodies, commitments, and both verdicts, which MUST both be
  **Clean**); the simultaneous cases below; a
  passed-through-rule violation; a strict-rule violation; a commitment mismatch; and truncation
  at close (incomplete reassembly, verdict unclean-truncation). Ordering and linger behavior
  (§10.3) is not expressible as a deterministic wire vector and belongs to implementation tests,
  not this corpus.

  **Verdict-disambiguation cases (§10.2, §10.4, §11.3 Q6/Q7).** The corpus MUST separate the two
  readings an earlier revision left open, in both directions:
  - an **envelope beyond the machine's expectation** — an extra protected record arriving after
    the endpoint's exchange is complete, carrying any inner type other than `E2EEError` —
    expecting FATAL-POST `Q7`, `protocol_violation`, one
    length-uniform `E2EEError` on the wire, and verdict **Failed**. The case MUST assert
    explicitly that the verdict is not **Unclean — abrupt** and that the error record _is_
    emitted, since the discarded reading produces neither, and that it is the **only** record
    protected after the close machine (§10.2);
  - the **peer's view of that same trace**: an authenticated `E2EEError` arriving after the
    receiving endpoint's own exchange completed, expecting **no** record on the wire in reply,
    verdict **Failed**, and secrets erased. The case MUST assert explicitly that this is _not_
    `Q7` and produces no second error record, since the Q7 reading would have the two endpoints
    answer each other's terminal errors indefinitely;
  - **legacy JSON and a negotiation record delivered during the close phase**, expecting
    FATAL-POST `Q6` and verdict **Failed**, so the close phase is shown to add no exemption to
    rows N11/K18;
  - a `T_CLOSE` expiry at each waiting step, expecting **Unclean — abrupt** with **no** wire
    record — the contrast case that fixes which events this protocol declines to attribute;
  - a trace combining an incomplete reassembly with a `Q7` violation, asserting the §10.4
    precedence: verdict **Failed**, not **Unclean — truncation**.

  **Close-phase keepalive cases (§10.2, §3.2.2 L5).** The corpus MUST assert that **no keepalive
  `Ping` record appears between an endpoint's first close-machine record and the channel's end**,
  in the sequential-initiator, sequential-responder, and simultaneous cases alike, and that a
  `Ping` submitted during that window is discarded rather than buffered for a later flush. A
  companion case MUST show why: a `Ping` protected after the initiator's `E2EEClose` makes the
  responder's `E2EECloseAck` declare an `expectedRecv` past the initiator's close anchor, which
  the initiator MUST reject as `Q7`. Like the L1 stalled-accept case, these MUST be re-run
  whenever the pinned RPC client changes.

  **Late-simultaneous phase-duration case (§10.2, §3.2.2 L5).** The corpus MUST additionally
  carry the worst-case close phase L5 is derived from, as a timed case rather than a byte vector:
  an endpoint sends `E2EEClose` at `t = 0`; the peer's `E2EEClose` is delivered just inside the
  first `T_CLOSE` deadline, so the endpoint takes the simultaneous branch; the peer's
  `E2EECloseAck` is delivered just inside the **second** `T_CLOSE` deadline; and the peer's outer
  `channel.close` is withheld so the §10.3 linger runs its full `T_CLOSE_LINGER_MAX`. The case
  MUST assert that the total phase does not exceed `2 · T_CLOSE + T_CLOSE_LINGER_MAX`, that this
  quantity plus `T_KEEPALIVE_FLUSH_MARGIN` is within `RPC_KEEPALIVE_INTERVAL` (§3.2.2 L5), that
  the endpoint's verdict is **Clean**, and that the simultaneous transition did **not** restart or
  extend either wait. It is the case that fails against constants chosen for a one-wait model,
  and against an implementation that re-arms `T_CLOSE` on any other event.

  The simultaneous cases MUST pin the §10.1.1 close anchor with explicit counters, so the two
  candidate readings of the strict rule are separated by fixture rather than by whichever one a
  reference implementation happens to pick. Shared state: epoch 0 throughout, initiator I's
  next-send `(0, 7)`, responder R's next-send `(0, 4)`.

  | Case                                                           | Wire records                                                                                                                                                                         | Expectation                                                                                                                                                                                             |
  | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | Simultaneous close, passing                                    | I `E2EEClose` at `(0, 7)`; R `E2EEClose` at `(0, 4)`; I `E2EECloseAck` at `(0, 8)` declaring `expectedRecv` `(0, 5)`; R `E2EECloseAck` at `(0, 5)` declaring `expectedRecv` `(0, 8)` | Both acks satisfy the strict rule against the validator's anchor (I's anchor `(0, 8)`, R's anchor `(0, 5)`); verdict **Clean** at both endpoints                                                        |
  | Simultaneous close, ack declaring current next-send (negative) | as above, except R's `E2EECloseAck` at `(0, 5)` declares `expectedRecv` `(0, 9)` — I's _current_ next-send after sending its own ack, rather than I's anchor `(0, 8)`                | Strict-rule failure at I: FATAL-POST `Q7`, `protocol_violation`, verdict **Failed**. A conforming implementation MUST reject this record; accepting it is the disallowed reading                        |
  | Close anchor across an epoch boundary                          | I's `E2EEClose` is the last record of epoch `e` under a §9.4 threshold; R's `E2EECloseAck` declares `expectedRecv` `(e + 1, 0)`                                                      | Accepted: the anchor is the §9.2/§9.4 advance, so an epoch-completing close advances to `(e + 1, 0)` and never to counter + 1. A companion negative case declaring `(e, counter + 1)` MUST fail as `Q7` |

- **F12 — Error records** (§11): the exact, byte-identical `E2EEHandshakeReject` record; one
  `E2EEError` envelope per defined code, demonstrating identical envelope lengths. The reject
  case MUST be asserted **byte-identical across causes** — at minimum an absent Branch A record,
  a `pending` record, a `revoked` record, and a context-commitment mismatch — since those four
  are precisely the approval-membership classes §11.2 forbids distinguishing. Reject _timing_ is
  not a fixture assertion: the §11.2 ordering rule that keeps the durable pending write off the
  response path constrains an implementation, not a wire vector.
- **F13 — Fingerprints** (§7.1): node, client, and agreement fingerprint vectors from the
  fixture keys, raw digests and `SHA256:` display forms.
- **F14 — Safety number and `WebSAS`** (§13.4, §13.5): input arrays, intermediates
  (`safetyNumberSecret`, `prk`), HKDF outputs, and the exact rendered display strings for
  fixed inputs. Each rendering case MUST additionally assert its displayed entropy against
  §3.2.1 S10 and S11, so the two floors are discharged by fixture rather than by inspection.
- **F15 — Noise core vectors** (§14.1): the official cacophony/snow vector sets for
  `Noise_IK_25519_ChaChaPoly_SHA256` and `Noise_NX_25519_ChaChaPoly_SHA256`, transcoded into
  the corpus format; the state machine MUST reproduce them exactly.
- **F16 — Authorization context and Branch A enforcement** (§8.3, §7.5, §8.6 steps 6–7, §8.7,
  §8.9, §11.3 Q9, §13.6). This family exists because the §2.2 active-Hub row rests entirely on the §8.3
  exact-equality rules and the §13.6 ceiling, and an implementation that never compares those
  elements would otherwise pass the whole corpus. It reuses the F6 (IK) and F7 (NX) happy-path
  material and emits the **context-block bytes and `contextCommitment` for both tiers**, then one
  case per single-element mutation, each giving the mutated context bytes, the resulting
  commitment, and the expected outcome:
  - element 9 node-fingerprint substitution — `P13`;
  - element 10 cross-account splice — `P13`;
  - element 17 continuity-id substitution — `P13`. This case MUST be run **twice**: once against
    a **never-rotated** node, whose §7.6 element 11 continuity chain is empty and whose context
    element 15 therefore carries no chain digest, and once against a node at
    `E2EE_CONTINUITY_CHAIN_MAX_LENGTH`. Only
    the first run exercises the gap element 17 exists to close, and a corpus carrying only the
    second would pass against an implementation that omitted element 17 entirely. The first run
    MUST additionally assert that the responder rebuilt element 17 from its **own** stored
    continuity id — a mutated statement element 18 delivered to a pinned client is a §5.2 step 6
    channel-fatal before any hello (family F3 above), not a `P13`;
  - element 11 capability mismatch against element 13 — `P13`;
  - element 12 role **escalation** above element 14 — `P13`;
  - element 12 role **reduction** below element 14 — `P13`, since §8.3 makes a difference in
    _either_ direction a context mismatch;
  - a commitment/preimage mismatch: a well-formed context block presented under a
    `contextCommitment` computed over different bytes — `P13`;
  - the NX absence semantics violated: a nonempty element 10 or element 16 on the web tier —
    `P13`;
  - a suite-list strip: `offeredSuites` mutated after the hello wire bytes were hashed,
    expecting **confirmation failure** (§8.7 hashes exact hello wire bytes), surfaced as `P16`
    at the client.

  **Advertised-snapshot cases (§8.3 construction rules, §7.5 advertised-chain retention, §8.6
  step 7).** These pin which material the responder hashes into elements 7–9, 15, and 17. Each
  states the node's advertised statement, the node-state change applied after the advertisement is
  emitted but before the hello arrives, and the expected outcome:
  - an **identity rotation appending a continuity certificate** in that window — the handshake
    **completes**, against the chain and identity fingerprint the statement advertised. The case
    MUST assert that rebuilding element 15 from the node's _current_ chain yields a different
    context and would fail as `P13`, since that is the implementation this rule exists to exclude,
    and that the client's element 15 is unchanged because it has only the validated statement to
    build from;
  - the same window at `E2EE_CONTINUITY_CHAIN_MAX_LENGTH`, where the append also **prunes** the
    oldest entry — same expectation, and the case MUST assert the pruned entry's digest is still
    present in the channel's element 15;
  - a **prekey rotation** in the same window, asserting the handshake completes against the prekey
    advertised on that channel (§6.4) and that element 15's entry 0 is the advertised agreement
    fingerprint;
  - the next channel opened after either change, asserting its statement and its element 15 carry
    the **new** material — the snapshot is per channel and never a freeze of the node.

  **Branch A record-state cases.** Each case MUST state the node's Branch A record for
  `(hubOrigin, accountId, clientIdentityFingerprint)` as an explicit input — exactly as the F10
  client rows state their §12.1.1 selection classification — so the corpus stays deterministic:
  record absent, `pending`, `revoked`, an approved record whose `capabilitySet` excludes the
  requested capability, and an approved record whose `maxRole` is below the requested role. All
  five expect `P12`, and each MUST assert the §11.5 observable is byte-identical to the others
  and to the F12 reject cases — approval membership is exactly what §11.2 forbids
  distinguishing.

  **Authorization-withdrawal cases (§13.6, §8.9, §11.3 Q9).** These are node-state transition
  cases rather than wire vectors: each states the channel's §8.6 step 6 admitted-authority
  snapshot, the owner command applied, and the expected verdict of the §13.6 withdrawal test. The
  corpus MUST carry, at minimum:
  - `status approved → revoked` — withdrawn; **Q9**, code `policy`;
  - `maxRole owner → viewer` with `status` unchanged at `approved` — withdrawn; **Q9**. This case
    MUST assert explicitly that a status-only re-check passes it, since that is the defect the
    withdrawal test exists to close, and it MUST be run once against a channel admitted at
    element-12 `owner` and once against a channel admitted at element-12 `viewer`, both expecting
    Q9, since the test reads the snapshot rather than the exercised authority;
  - `capabilitySet` losing a member the snapshot held, with `maxRole` and `status` unchanged —
    withdrawn; **Q9**;
  - a widening — first approval, re-approval, `maxRole` increase, `capabilitySet` addition — not
    withdrawn; the channel stays open and the widened authority reaches it only on a fresh
    ticket, channel, and handshake;
  - a combined narrow-and-widen command — withdrawn, because it contains a reduction;
  - a withdrawal applied to the **same client fingerprint under a different**
    `(hubOrigin, accountId)` **scope** — _not_ withdrawn for this channel. The case MUST assert
    the channel stays open, since a fingerprint-only sweep would close it;
  - a withdrawal landing between §8.6 step 6 and row N3 — the in-flight abort, which MUST take
    the generic fixed-size `E2EEHandshakeReject` and be byte-identical to the F12 reject cases,
    **never** a `policy` code;
  - a withdrawal landing after row N3 but before the authenticated implicit finish — **Q9**, per
    §8.9;
  - an NX channel present while any of the above is applied — no snapshot, no re-check, never
    matched by the sweep, and asserted to stay open (§12.4 governs NX admission instead).

  **Pending-cap and pairing-window cases (§13.6, §11.2, §15; the reservation-ageing case
  additionally exercises what §3.2.2 L4 guarantees).** Also node-state cases; each states
  the pending set with each record's partition and `pairingReservedAt`, whether a window is open
  and which discriminator it names, and the attempt's authenticated
  `clientIdentityFingerprint`. The corpus MUST carry, at minimum: a cap-exceeding attempt with no
  window (refused, **no** record created, **no** eviction); a window open and the attempt's
  fingerprint **not** matching the discriminator (refused, no eviction — this is the flood case,
  and it MUST be run at a rate sufficient to fill `E2EE_PENDING_CLIENTS_MAX_GLOBAL` to assert the
  window is still usable afterwards); a matching attempt exceeding only
  `E2EE_PENDING_CLIENTS_MAX_PER_ACCOUNT` (evicts within the same `(hubOrigin, accountId)`); a
  matching attempt exceeding only `E2EE_PENDING_CLIENTS_MAX_GLOBAL` (evicts the oldest eligible
  record anywhere); a matching attempt exceeding **both** (one eviction, taken from the
  per-account partition, asserting both caps are relieved); a second matching attempt in the same
  window (refused — the reservation is spent); an eviction candidate set in which every record
  holds an unexpired reservation (refused); the same set with one reservation aged past
  `E2EE_PAIRING_RESERVATION_LIFETIME` (that record evicted); and, in every one of these cases, the
  assertion that `approved` and `revoked` records were untouched and that the §11.5 observable was
  byte-identical throughout. Eviction and creation _timing_ is not a fixture assertion, for the
  same reason F12 excludes reject timing: §11.2's ordering rule constrains an implementation, not
  a wire vector.

- **F17 — Key-material validation** (§7.1, §8.1, §14.3): the strict validation rules the
  headline guarantee assumes, one case per rejected encoding. Each case MUST name the §11
  outcome for the position the material occupies: `P11` for material inside the IK client
  certificate (§8.6 step 5); rows K2/K3 — and `P15` when the channel's selection is latched —
  for material inside a node-signed capability statement, prekey, or continuity certificate
  (§5.2, §12.1.1); and `P10` for a Noise-level failure.
  - an X25519 input producing an **all-zero shared secret** from a low-order point, expecting the
    single mandated behavior of §8.1 — abort, `P10` — in both the IK and NX handshake positions;
  - P-256 public keys that are off the curve, have a coordinate at or above the field prime, are
    the identity, or carry a first byte other than `0x04` (compressed and hybrid prefixes
    included) — each rejected by §7.1 before any signature check;
  - P-256 ECDSA signatures presented as ASN.1/DER instead of fixed-width raw `r ‖ s`, and raw
    signatures with `r` or `s` equal to zero or at or above the group order — each rejected;
  - Ed25519 signatures that are **non-canonical** in point or scalar encoding — values a
    ZIP215-style verifier accepts and RFC 8032 MUST reject (§14.3);
  - **cross-domain signature substitution**: one valid signature per §3.5 transcript domain —
    node prekey, client prekey, capability statement (through the §7.2.1 envelope), identity
    continuity, and the node-identity domains — replayed into every other domain's verification
    path, all rejected. This is the vector behind the §7.2 no-ad-hoc-transcript rule.
- **F18 — Node admission policy transitions** (§12.3, §12.4, §12.6, §11.3 Q12, §11.2 P25, §8.6
  step 2, §4.4, §5.7). These
  are node-state transition cases rather than wire vectors, in the same form as F16's
  authorization-withdrawal cases: each states the node's pre-change policy
  (`requireE2EE`, `requireApprovedClientE2EE`, suite registry, effective admitted pattern set) and
  policy generation, the set of live channels with each channel's mode, tier, established suite,
  and — for IK — its §8.6 step 6 admitted-authority snapshot, the operator command applied, and
  the expected verdict of the §12.6 policy-withdrawal test per channel. The corpus MUST carry, at
  minimum:
  - `requireE2EE` false → true with one `legacy` channel, one NX `e2ee` channel, and one IK
    `e2ee` channel open — the `legacy` channel withdrawn and closed with reason
    `channel_rejected` and **no** record of any kind, both `e2ee` channels untouched. The case
    MUST assert explicitly that no `E2EEHandshakeReject` was emitted on the `legacy` channel,
    since that is the plausible wrong implementation and would be row K21 at the peer;
  - `requireApprovedClientE2EE` false → true over the same three channels — the `legacy` channel
    and the NX `e2ee` channel both withdrawn, the NX channel as FATAL-POST `Q12` with code
    `policy` and one length-uniform `E2EEError`, and the IK channel asserted to stay open, since
    §8.6 step 6 admitted it only against an `approved` record;
  - a suite leaving the advertised registry with an `e2ee` channel established on that suite —
    withdrawn, `Q12`; and a companion channel on a retained suite — not withdrawn. This case MUST
    be run **twice against the same command**: once with the established channel's handshake IK
    and once with it NX, **both** expecting `Q12`, since §12.6's suite clause is tier-independent
    and a generator free to pick a tier would leave the rule pinned by prose alone. The IK run
    MUST additionally carry an unchanged `approved` Branch A record and assert the channel is
    closed anyway, since "the record is still approved" is the plausible wrong exemption;
  - a **widening** — `requireE2EE` or `requireApprovedClientE2EE` true → false, a suite added —
    asserting that **no** channel is closed and that the policy generation still advances (§5.7);
  - a combined narrow-and-widen command — a withdrawal, because it contains a reduction, with the
    same per-channel expectations as the narrowing alone;
  - a `negotiating` channel present while any of the above is applied — asserted **not** swept,
    and then asserted fail-closed on its next input: a hello whose tier the new policy refuses is
    `P9`, legacy JSON under a newly effective `requireE2EE` is row N1;
  - an in-flight handshake that passed §8.6 step 2 under the old policy and has not reached row
    N3 — aborted as FATAL-PRE naming §11.2 **`P25`**, with the generic fixed-size
    `E2EEHandshakeReject`, asserted byte-identical to the F12 reject cases and **never** a `policy`
    code, exactly as F16's in-flight authorization abort names `P12`. The case MUST name `P25` and
    not `P9`: P9 is defined at §8.6 step 2 and this handshake passed it;
  - the ordering itself: a hello that reaches §8.6 step 2 after the durable commit reads the
    narrowed policy and is refused there, asserting that no channel can be established behind a
    sweep that has already passed;
  - **the row-N3 race**, which is what §8.6 step 2's atomicity rule and §12.6 step (b)'s
    single-snapshot rule exist to close: a handshake that passed §8.6 step 2 under the old policy
    and whose row-N3 transition is scheduled to land **concurrently with the sweep**, between the
    live-channel enumeration and the in-flight enumeration. The case MUST assert that the channel
    is accounted for exactly once and is not left open — closed as `Q12` and counted in the step
    (c) `e2ee` class if it reached row N3, or aborted as `P25` and counted in the in-flight class
    if it did not — and MUST be run with the two enumerations attempted in **both** orders. A
    conforming implementation produces the same outcome in both; an implementation that runs two
    independent passes loses the channel in one of them, which is the defect this case pins;
  - the §12.5 non-interaction: every case above MUST assert that **no** fallback occurrence of
    either class was recorded by the withdrawal (§12.6), since the sweep is an operator action
    and not a legacy acceptance;
  - the reported counts of §12.6 step (c), broken out by class — `legacy`, NX `e2ee`,
    suite-withdrawn `e2ee` of either tier, and in-flight handshakes aborted — asserted against the
    channel set, so a channel missed by one of the two enumerations is visible as a count and not
    only as a surviving channel.

- **F19 — Account-enrolled native authorization** (§18): one generated family containing:
  - exact grant claims, signing input, signature, envelope, envelope digest, certificate carrier and
    digest, suite-`0x02` context block/commitment, hello, both Noise messages, confirmation,
    `sessionBindingHash`, and both directional epoch-zero secrets for a valid deterministic trace;
  - minimum and maximum conforming fields, the exact 2,048-byte envelope boundary, the 3,610-byte
    worst-case hello construction, and one-byte-over rejection before CBOR or signature work;
  - malformed and non-canonical arrays, wrong element counts/types, excess fields, invalid identifier
    and collection bounds, duplicate capabilities and key ids, unsupported versions/suites, unknown or
    retired signing keys, non-canonical Ed25519 signatures, and cross-domain signature substitution;
  - every binding changed one at a time: origin, account/device epoch, enrollment/revision, both device
    keys and fingerprints, certificate digest, node id/keys/fingerprints/continuity/policy generation,
    statement digest, ticket id, role, capabilities, nonce, and each time bound;
  - suite confusion (`0x01` plus grant, `0x02` without grant, Web plus `0x02`), relay minor 2, partial
    `channel.open` context, stale connector generation, unacknowledged statement, missing retained
    prekey, replay on another channel/ticket, expiry, key rotation overlap, and revocation during an
    in-flight and established channel;
  - the four policy modes, verified-pin/local-denial precedence, exact authority intersection, and proof
    that successful account admission performs no durable approved-client write; and
  - Web-only negative cases proving `[0x02,0x01]` selects NX suite `0x01`, `0x02` alone emits no hello,
    browser tickets stay grant-free, mixed responses fail, and grant canaries reach no decoder, state,
    DOM, service-worker cache, or relay send.

### 16.4 Cross-runtime equality

Every family runs under the repository's Node test gate. Families exercising web-facing
surfaces — F1, F2, F7, F8, F10, the admitted-pattern cases of F3, the `WebSAS` half of F14, the NX
cases of F16, the P-256 cases of F17, and F19's Web-isolation cases — MUST also run in the web
browser test suite. Before the native client ships E2EE
support, the complete corpus MUST additionally pass on physical devices on both mobile
platforms; until then the Node run uses RN-realistic crypto adapters (§14.5), and the
physical-device check is an explicit acceptance
gate of the native rollout, not an optional extra. A vector that produces different bytes on
any supported runtime is a release-blocking defect.

## 17. Security considerations and residual risks

This section is the honest list. Each entry names what is **not** covered and what bounds it.
Entries are numbered and are referenced elsewhere in this document as §17.\<n\>.

1. **Unaudited first-party Noise state machine.** The §14.1 deviation ships a first-party
   handshake state machine that has, at introduction, no independent audit. Bounds: frozen
   minimal scope, audited primitives underneath, official and cross-implementation vectors,
   property-based and adversarial suites (§14.1, §16), and a REQUIRED scoped third-party
   audit before the `requireE2EE` default flip (§12.3). Until that audit, this is the
   protocol's largest open risk and is carried deliberately.
2. **JavaScript constant-time limits.** No pure-JS implementation can guarantee constant-time
   execution (JIT, garbage collection); the pinned primitive author documents this. Mandated
   constant-time comparisons (§7.1, §11.2) and uniform failure surfaces bound the wire-level
   oracle, but micro-architectural and coarse timing side channels on shared hosts remain
   possible and are accepted.
3. **Zeroization limits in managed runtimes.** §9.5 zeroization bounds, but cannot eliminate,
   residual plaintext and key copies (collector moves, JIT spills). Endpoint memory
   compromise is outside the threat model (§2.6) either way.
4. **Plaintext fallback on a legacy-eligible selection.** A Hub that strips the advertisement
   causes silent legacy fallback (row K13/K9) on any selection §12.1.1 classifies as
   legacy-eligible. **Stripping is not the only lever that reaches this exposure**: a Hub that
   asserts a `ready.maxDataChunkBytes` below `E2EE_ADVERTISEMENT_MIN_CHUNK_BYTES` makes every
   conforming advertisement uncarriable, so the node suppresses its own carrier (§5.5 U1) and the
   client sees the identical absent-advertisement condition. The victim set is the same, because
   the client decides before any evidence arrives; what differs is where it is visible — the node
   counts and displays it in its own class (§12.5) and it does not gate the §12.3 flip. The
   same condition is also reachable by benign relay misconfiguration. The bound is **not** "first
   contact has passed": the Hub can re-mint the `nodeId` — and, being the issuer of account
   identity, the `accountId` — and withhold the carrier to synthesize an unrecognized selection at
   any time. The actual bounds, stated per tier:
   - _Native._ A selection is legacy-eligible only on a `hubOrigin` whose device-level
     `anyNodeVerified` marker is unset **and** under a `(hubOrigin, accountId)` pair that holds no
     verified pin, or after an explicit owner legacy consent (§13.1). A latched selection is fatal
     (K14) and an unexpected one demands owner consent (K23/K24), on every channel, before any
     evidence arrives. The marker is what keeps this bound out of the Hub's hands: without it the
     pair test is half Hub-chosen, and re-minting the account identifier would return every
     latched selection on the device to the legacy-eligible class (§12.1.1). What remains exposed
     is a node on a Hub origin where this install has verified nothing at all, plus whatever the
     owner consents to. That second clause is the honest residue: because re-minting an id costs
     the Hub nothing, it can raise the §13.2.1 surface as often as it likes, so on an install that
     has verified something the guard is not "the Hub cannot get plaintext" but "the Hub cannot
     get plaintext without an explicit owner decision it can ask for repeatedly". §13.2.1's
     requirement that the three situations be worded distinctly, and §13.1's rule that consent is
     never inferred from a timeout, a retry, or a dismissal, are what keep that decision meaningful;
     nothing in the protocol bounds how often it is put to the owner.
   - _Native, after durable-state loss._ The bound above is **install-scoped state in the §6.3
     class**, not a permanent property of the device or the account. App reinstall, OS device
     transfer, restore, and a platform secure-store reset each destroy every pin, latch, consent,
     and marker, and a client cannot detect that it ever held them (§13.1.1). Each such event
     therefore reopens this item in full, for every node under every Hub origin, until the owner
     re-runs §13.2 per node. These are routine device-lifecycle events; this is the most
     frequently reached path into this item in practice, and it is bounded only by §13.1.1's
     required owner-visible "no verified node on this Hub" surface and by node-side effective
     `requireE2EE` (item 11).
   - _Web._ Exposed until the first validated statement of each application session, and again
     in every fresh session (§12.1); nothing web-side closes it against the Hub (§2.4).
     Node-side, effective `requireE2EE` (§12.3) closes it for both tiers. Occurrences are counted
     (§12.5) and channels are labeled legacy (§12.2), but neither closes it.
5. **The web ceiling.** The web tier is never operator-proof (§2.4); the `WebSAS` is advisory
   by construction (§13.5). **The `WebSAS` is additionally grindable, and its floor is an online
   bound rather than an offline one.** An interposer that authors the client-facing
   `E2EEServerAccept` knows the node-side string in advance and can search its own ephemeral for
   a colliding rendering; session binding prevents precomputation but not this search. The only
   things bounding it are `T_HANDSHAKE` and the one-attempt-per-channel rule (§8.1, §4.4 K15), so
   `E2EE_WEB_SAS_MIN_DISPLAYED_BITS` is justified by that window and not by an offline work
   factor (§13.5). Raising the displayed length was considered and rejected: it degrades a human
   comparison that §2.4 already declares advisory against the only realistic active adversary,
   and committing the responder's ephemeral before it learns the target would add a round trip to
   a deliberately one-round-trip handshake (§8.9). Web downgrade resistance is a **best-effort,
   in-session, honest-code only** property: the in-memory latch of §12.1 is set on the first
   validated statement of an application session, is never durable, and buys nothing against a
   Hub that serves the code implementing it. Before that first validated statement, and in every
   fresh session, web has no downgrade resistance at all. The web latch and the durable native
   latch are different mechanisms with different guarantees and MUST NOT be described in the same
   terms (§2.3).
6. **No post-compromise security within a channel.** The epoch ratchet is one-way (§9.4);
   compromise of live session state can expose later epochs until the channel closes (§1.3).
   Channels are short-lived by design, which bounds the window.
7. **Metadata visibility.** The §2.5 list — who talks to which node, when, how much, with
   what authority — remains fully Hub-visible on every channel. This protocol encrypts
   payloads, not traffic patterns.
8. **Hub-authored `channel.open` authority.** `capability` and `effectiveRole` are Hub
   claims. The exact-equality context rules (§8.3) detect inconsistent presentations, and the
   node-local authorization ceiling (§13.6) caps what any claim can authorize on the signed
   tier — but the Hub retains full authority to refuse, delay, or close channels and to
   present consistent-but-denied service.
9. **No attribution of abrupt closes, and no proof of the last record.** An abrupt close is
   unclean, not attributed (§10.4); the protocol cannot distinguish attacker denial of service
   from network failure and does not guarantee detection of a dropped final message (§9.7).
   Two consequences are stated rather than papered over. First, the **last close-machine record
   of any exchange is unacknowledged by construction** — the sequential initiator's final
   confirmation, and both acks in a simultaneous close — so a Clean verdict proves in-order
   delivery only up to the record the endpoint's close anchor names (§10.1.1, §10.2, §10.4). In
   the simultaneous branch that is each side's `E2EEClose`. Dropping such a record leaves the
   waiting end at `T_CLOSE` with **Unclean — abrupt**, indistinguishable from network loss. No
   number of additional round trips closes this: it is the two-generals limit, and the §10.3
   linger only reduces how often the sender itself causes the loss. Second, a §9.2 sequence
   mismatch is **detection without attribution**: the identical gap is produced by a peer's own
   post-AEAD local send failure (§9.3), so implementations MUST NOT present a mismatch as proof
   of tampering (§9.7, §11.3 Q2).
10. **Ticket burn by a malicious relay.** Every failed handshake consumes a single-use ticket
    and a channel; a malicious Hub can force failures at will. This is denial of service only
    — the §15 bounds keep node resources bounded, and no confidentiality or authorization
    property depends on a channel surviving.
11. **Backup and restore rollback, and client-side durable-state loss.** Node-side restores fail
    closed or repair silently, but into three _different_ paths, and the differences matter
    operationally.
    - A rolled-back **continuity chain** is detected against the §7.5 startup cross-check and
      surfaces client-side as the §13.3 re-verification UI.
    - A rolled-back **continuity id** is detected against the §7.5 continuity-id anchor, and it is
      the one path that is _not_ a client-visible event. The node restores the stored value from
      the anchor and re-advertises the identical id, so every pin still matches and no client sees
      anything. That outcome is the point of the anchor: the case is reached by an ordinary
      operator restore of a node that has **never rotated**, whose chain is empty and whose
      rotation generation is 0, so the chain cross-check above has nothing to compare and cannot
      catch it. Without the anchor the node's only defined behavior would be to mint a fresh id,
      which every pinned client reads as a §5.2 step 6 mismatch — channel-fatal, §13.3
      re-verification UI — turning a benign restore into a fleet-wide re-verification storm with
      no attacker involved, and training owners to click through the one warning that matters
      (§13.3). Where the anchor and the stored value _disagree_, or the anchor is unreadable, the
      node fails closed instead: it declines to advertise (§5.5 U2) until an operator resolves it,
      and minting is never automatic (§7.5).
    - A rolled-back **policy generation** is detected only against the §5.7 high-water anchor,
      which this specification requires the implementation to build because no store with both
      required properties exists in the node today. Client-side it is _not_ re-verification: it
      is an ordinary invalid statement (rows K2/K3, §11.2 P15) with a local-only diagnostic,
      deliberately, because a Hub can replay a genuine older statement on demand and an
      automatic identity prompt would be a Hub-triggered click-through trainer. Until the
      operator runs the §5.7 recovery command, a restored node is unreachable by every client
      holding a higher remembered generation. Authenticated identity rotation does not help:
      §13.3 carries the remembered generation across it. The client-side escape is the
      owner-initiated re-pair of §13.3.
      All three are resolved by failing closed or by an explicit, recorded repair — availability
      costs accepted deliberately over silent trust regression.

    **The client side of a restore is not symmetric, and this document no longer claims it is.**
    An earlier revision asserted that a restored device "holds no E2EE identity and MUST re-pair".
    The first half is true — native key material, pins, latches, consents, and the §13.1 marker
    are all excluded from backup by the §6.3 storage class — but the obligation is unenforceable:
    a device with no durable trust state is indistinguishable from a fresh install, to itself and
    on the wire, so no rule can make it notice that a re-pair is owed. What actually happens is
    that every selection re-enters the first-contact classification of §12.1.1 and the plaintext
    downgrade window of item 4 reopens in full, device-wide, until the owner re-runs §13.2 for
    each node. §13.1.1 defines what such a client may and may not do — no active-Hub claim, no
    pin, latch, or marker from a self-signed statement, no reconstruction of lost state from
    anything the Hub sends, legacy labeling throughout — and requires the persistent
    owner-visible "this device has not verified any node on this Hub" surface, which is the only
    signal available for a condition the client cannot detect. The same reopening follows from an
    ordinary app reinstall, an OS device transfer, and a secure-store or platform-key reset; these
    are routine events rather than rare failures, so this is a recurring exposure and not a
    one-time migration cost. Restored or cloned agreement keys are a separate case and are
    destroyed on detection (§6.3).

12. **Continuity chains do not survive outgoing-key compromise.** The chain authenticates a
    rotation only while the outgoing identity private key was under exclusive honest custody
    (§13.3). An adversary holding a retired-but-once-current node identity key can sign a
    certificate to a key of its choosing and move a client's pin **silently**, carrying the
    latch, the policy-generation memory, and the approval state with it. Bounds and honesty:
    holding that key means the node host is compromised, which §2.6 already lists under _Never
    delivered_, and §7.5 requires a compromise rotation to be executed as a deliberate
    chain break plus a fresh §13.2 verification, with the node CLI warning at the point of use.
    No pin-local mechanism detects the fork at accept time, and none is specified: both
    certificates sit at the same generation, and the continuity id is public and copyable. The
    residual asymmetry is stated plainly — after such a fork the honest node's real chain no
    longer reaches the moved pin, so the **genuine** node becomes the party that raises the
    §13.3 re-verification UI.
13. **Advertisement serviceability rests on a Hub-asserted relay limit and on a bounded Hub
    origin.** Two availability conditions are accepted rather than solved here.
    - _The relay floor is below the E2EE floor._ `RELAY_MIN_DATA_CHUNK_BYTES` is strictly less
      than `E2EE_ADVERTISEMENT_MIN_CHUNK_BYTES` (§3.2.1 S7), so the relay protocol still permits
      a connection on which no conforming advertisement can be carried (§5.5 U1). Closing the gap
      genuinely — rather than documenting it — is a **relay-protocol** change: raising the
      minimum data-chunk limit, or requiring a floor on connections carrying an E2EE-capable
      node. That change belongs in the relay protocol and must be sequenced there; it is
      deliberately not bolted onto this document. Two alternatives were considered and rejected:
      a multi-part carrier, which would destroy the §5.6 C1–C6 per-message safety argument,
      contradict row K4, and hand the Hub a selective-drop lever that turns a clean absent
      advertisement into an ambiguous partial one; and moving the continuity chain into the
      encrypted `E2EEServerAccept`, which would invert §5.1's verify-before-you-act ordering by
      making the client send a hello to a static it has not yet checked against its pin.
    - _A long Hub origin disables E2EE for a deployment._ A canonical Hub origin longer than
      `E2EE_HUB_ORIGIN_MAX_BYTES` fails the §7.6.1 self-check (§5.5 U2, §7.1). The bound sits far
      above any realistic origin and buys a closed, machine-checkable size argument for the
      carrier; the cost is that an operator can configure a node out of E2EE eligibility.
      Both conditions are deterministic, operator-visible at startup or at `ready`, and never
      silent: under effective `requireE2EE` they are FATAL-PRE (§11.2 P2, P23) and the node is
      unreachable until corrected; otherwise they are counted and displayed in a class distinct
      from peer-legacy fallback (§12.5) so they cannot be mistaken for compatibility traffic, and
      they are excluded from the §12.3 flip criterion so the Hub cannot use them to veto the
      rollout. What they are _not_ is a new confidentiality exposure: the client-side classification
      of §12.1.1 is computed before any evidence arrives, so a suppressed advertisement is fatal for
      latched and unexpected selections and can only reach the legacy-eligible selections item 4
      already retains.
14. **The client's handshake and close budgets are coupled to a pinned transport keepalive.**
    Because an
    E2EE-capable client emits no plaintext while `negotiating` (§4.4), the pinned RPC client's
    free-running keepalive constrains how long negotiation may take: §3.2.2 L1 fixes `T_ADV`,
    `T_TRUST_COMMIT`, and `T_HANDSHAKE` so the whole window plus
    `T_KEEPALIVE_FLUSH_MARGIN` fits inside one `RPC_KEEPALIVE_INTERVAL`. Two costs are carried
    deliberately. First, the handshake budget is
    smaller than it would otherwise be, so a link whose `Ping` round trip exceeds
    `T_KEEPALIVE_FLUSH_MARGIN`, or whose handshake genuinely needs longer than `T_HANDSHAKE`,
    loses the channel. That failure is fail-closed — it surfaces as a transport error and a
    backed-off reconnect (§15), never as a legacy lock and never as a flushed plaintext byte —
    but it surfaces as a transport error rather than as the K15 FATAL-PRE the mode machine
    describes, so a diagnostic that only reads mode-machine outcomes will misattribute it.
    Second, `T_ADV` is now short enough that an honest but slow path can expire it, locking
    legacy on a _legacy-eligible_ selection where a longer wait would have negotiated E2EE; that
    lands inside the exposure item 4 already retains and is not a new one, since a Hub that
    wants the same outcome simply drops the carrier. The bound on the whole coupling is that it
    is checkable: L1 is an inequality over §3.2 names, and §16.3 F10 carries a stalled-accept
    vector that MUST be re-run whenever the pinned RPC client moves.

    **The same coupling applies to the authenticated close, and there it is only partly
    removable.** §10.2 makes the keepalive `Ping` an application RPC record for the whole close
    phase — it must, because the §10.1.1 close anchor is fixed at the endpoint's first
    close-machine record and any record protected after it, and before the peer's strict-rule
    proof arrives, would fail that validation (the one carve-out, §10.2's single terminal
    `E2EEError`, is protected only once no such validation remains outstanding)
    — and unlike the `negotiating` window that `Ping` has no flush: the channel ends
    when the phase ends, so it is discarded. §3.2.2 L5 sizes `T_CLOSE` and `T_CLOSE_LINGER_MAX`
    so the whole close phase plus `T_KEEPALIVE_FLUSH_MARGIN` fits inside one
    `RPC_KEEPALIVE_INTERVAL`, which is why `T_CLOSE` is smaller than it would otherwise be — an
    earlier revision carried `T_CLOSE` equal to `RPC_KEEPALIVE_INTERVAL` with a linger bound
    equal to `T_CLOSE`, so a Hub that returned the peer proof just under `T_CLOSE` and withheld
    the peer's `channel.close` made a _successful_ authenticated close end in a transport timeout
    that tore down the connection and every channel on it, deterministically. A later revision
    fixed the constants against a one-wait model of the phase and left the same attack reachable
    one step further along: §10.2 bounds _each_ wait by `T_CLOSE` and the simultaneous branch has
    two, so a Hub delivering the peer's `E2EEClose` just inside the first deadline and its
    `E2EECloseAck` just inside the second reconstituted the deterministic teardown at
    `2 · T_CLOSE + T_CLOSE_LINGER_MAX`. L5 now charges `T_CLOSE` twice, §10.2 caps the wait count
    at two on every path, and §16.3 F11 pins the resulting worst case. Two costs remain.
    First, a close-exchange step that genuinely needs longer than `T_CLOSE` now ends in
    **Unclean — abrupt** where a longer deadline would have completed; that is an unattributed
    verdict and never a confidentiality event (§10.4, item 9). Second, and not removable by any
    timer: a `Ping` written _before_ the close phase whose `Pong` the peer can no longer send —
    because the peer has itself entered a close phase and is under the identical prohibition —
    expires on the pinger's own schedule. The transport dead-peer verdict is therefore an
    accepted and expected terminator of a close phase, which is why §10.3 and §10.4 require each
    endpoint's verdict to be determined and recorded when its exchange completes or `T_CLOSE`
    expires, never when the outer `channel.close` is emitted or delivered. As with L1, a runtime
    exposing keepalive suspend/resume MAY hold the verdict off, and L5 must hold regardless.

15. **The rollout signal is upward-forgeable.** Row N2 counts a fallback occurrence on the first
    unauthenticated `LEGACY-JSON` byte, so any party that can originate a channel — the Hub can,
    and §2.1 concedes a node cannot tell a Hub-originated session from a genuine one — can
    inflate the §12.5 peer-legacy counter at a cost of one channel per observation window, and
    the ring's deliberately non-identifying fields cannot distinguish an injected occurrence
    from a genuine one.

    **The signal is forgeable in both directions, and this document no longer claims otherwise.**
    An earlier revision paired the amended §12.3 criterion with the zero test's safety claim —
    "the counter can be inflated but never suppressed, so it can never falsely permit a flip,
    only delay one". That implication holds for a zero test and fails for an attributability
    judgement. Under the amended criterion the decisive evidence is the per-occurrence shape held
    in the §12.5 ring, which is bounded at `E2EE_FALLBACK_RING_SIZE` and lossy: an adversary
    injecting at a plausible jittered rate — deliberately unlike the metronomic pattern §12.5
    tells the operator to read as inflation — can occupy the whole ring at review time, evict
    every genuine occurrence, and leave the maintainers a counter they have been told not to
    treat as blocking beside evidence it authored. That is a **false permit**: a premature flip
    turns row N1 into a hard lockout of every genuinely un-upgraded client. Inflation therefore
    biases the decision in both directions.

    Bounds, stated exactly. The counter's _value_ remains a monotone lower bound that cannot be
    deflated, so the node can never be made to under-report that legacy was accepted at all.
    §12.5's per-class **ring-overflow counter** records how much per-occurrence evidence a window
    lost, so the loss is visible even though it is not recoverable, and §12.3 requires the
    maintainers to treat ring shape as evidence in neither direction for an overflowed window; it
    is deliberately not a hard block, because a blocking overflow would restore the veto the
    amendment removed at a price of `E2EE_FALLBACK_RING_SIZE` channels instead of one. Shipped
    release telemetry is not a substitute: §12.5 forbids resting a security decision on it and it
    is itself Hub-relayed and suppressible. §12.5's leading-edge coalescing bounds the
    durable-write amplification the same injection would otherwise produce. What remains is that
    no counter or ring a node keeps can be integrity-protected against a party that originates
    channels, that the default-flip criterion is consequently Hub-influenceable in both
    directions and is not a security mechanism, and that **§12.3's operator override is the only
    path whose outcome the Hub cannot influence** — which is why it is stated first there and
    recommended to every operator who does not need legacy compatibility.

16. **Pairing can be denied by flooding the pending-record caps.** §7.4 client certificates are
    self-signed and name a client-chosen `accountId`, and §13.6 creates a pending record from
    them once the §8.6 step 5 bindings verify, so a party that can open channels can saturate
    `E2EE_PENDING_CLIENTS_MAX_PER_ACCOUNT` for a chosen namespace and
    `E2EE_PENDING_CLIENTS_MAX_GLOBAL` outright with fabricated identities, and the owner's
    genuine device is then refused with the byte-identical §11.2 surface. Unlike ticket burn
    (item 10) the denial is durable past the adversary's activity — up to
    `E2EE_PENDING_CLIENT_RETENTION`, renewable. Bounds: it is denial of service only and confers
    no read, authorization, or approval capability; the flood can never evict `approved` or
    `revoked` state (§13.6); and the saturation is loudly visible on the node CLI, which must
    flag it and count refusals. No attestation exists at this layer to make the records costly to
    create, and none is invented here; the actor who can deliver these helloes already holds the
    stronger denial of simply never opening the channel (§15, §17.8).

    **The two recovery paths are not equally strong, and this document no longer calls either of
    them unconditional.** An earlier revision described the owner-opened pairing window as
    window-scoped: while open, _any_ cap-exceeding attempt evicted the oldest record created
    outside a window and was itself marked as created inside one. That was self-poisoning. The
    flood did not have to detect the window; running continuously at the permitted §15 rate, it
    converted every pending slot into a marked, un-evictable record within the window's own
    duration, and — because the mark lasted as long as the record — disabled every _subsequent_
    window for the whole of `E2EE_PENDING_CLIENT_RETENTION`. It was also silent on partition
    scope, so a per-account saturation could be answered by evicting a record in some other
    account and relieving nothing. §13.6 now binds the reservation to an owner-supplied
    discriminator, caps a window at one record, scopes the eviction to the partition of the cap
    that was exceeded, and bounds the reservation at `E2EE_PAIRING_RESERVATION_LIFETIME`. What
    that buys, stated exactly:
    - **Purge is unconditional.** It is a local owner action on local state and nothing an
      adversary does affects it.
    - **The window is conditional, in two ways that a product can satisfy but this document
      cannot guarantee.** It requires the client device to display its own `ryco.client-key.v1`
      fingerprint locally, which §13.6 makes a REQUIREMENT of any product offering the window and
      which a product that has not built that surface simply does not have; and it requires the
      owner to reach approval within `E2EE_PAIRING_RESERVATION_LIFETIME`, after which the record
      is evictable again like any other. What it _is_ proof against is the flood: matching the
      discriminator requires the private key behind a public fingerprint the owner read off their
      own device, so no volume of fabricated identities receives the reservation, causes an
      eviction, or burns the window — this window or any later one.
    - **Neither path stops the denial itself.** They let the owner get one intended device paired
      through a saturated cap; the cap stays saturated, the flood can resume, and the owner must
      act again. And neither reaches the case where the Hub simply never delivers the owner's
      channel (§17.8, §17.10), which no node-side mechanism can.

17. **Authorization withdrawal is channel-granular, not operation-granular.** §13.6 makes
    revocation, `maxRole` reduction, and `capabilitySet` removal one transition with one ordered
    procedure — durable commit, then sweep and in-flight abort, then acknowledgement — so a
    narrowed device does not keep its old ceiling on live channels, and the CLI's acknowledgement
    means no channel admitted under the withdrawn authority is still open. Three limits are stated
    rather than implied. First, the unit is the channel: an RPC the handler had already dispatched
    under the old authority runs to completion, and this protocol neither cancels nor compensates
    it — payload encryption is the wrong layer for transactional revocation, and the node's
    application layer owns that question. Second, the sweep's effect on the _peer_ is bounded by
    the peer's own send path: the `E2EEError(policy)` and the `channel_rejected` close are ordinary
    records, and a Hub that drops them leaves the peer at an abrupt close it cannot attribute
    (item 9) — the node-side guarantee is that it stopped delivering, not that the peer was told
    why. Third, the test reads the §8.6 step 6 snapshot rather than the authority the channel is
    actually exercising, so it closes some channels whose traffic still fit the narrowed record;
    that is the conservative direction and it is chosen deliberately (§13.6), but it means a
    narrowing is an availability event for every live channel of that key, not only for the ones
    that were over the new line.
18. **Policy withdrawal is channel-granular, and the advertised policy snapshot outlives it.**
    §12.6 makes every narrowing of a node admission policy one transition with the same ordered
    procedure as §13.6 — durable commit and generation increment, then sweep and in-flight abort,
    then acknowledgement — so §2.3's rows describe the node's live channels and the CLI's
    acknowledgement means no channel the new policy would refuse is still open. Four limits are
    stated rather than implied. First, the unit is the channel, exactly as in item 17: an RPC the
    handler had already dispatched runs to completion. Second, the sweep's effect on the _peer_ is
    bounded by the peer's own send path — the `E2EEError(policy)` and the `channel_rejected` close
    are ordinary records, and a `legacy` channel's peer receives no record at all by construction,
    so a Hub that drops or reorders them leaves the peer at an unattributed close (item 9); the
    node-side guarantee is that it stopped serving, not that the peer was told why. Third, the
    capability statement already advertised on an open `negotiating` channel is a **signed
    snapshot of the pre-withdrawal policy** and stays verifiable for its own
    `E2EE_CAPABILITY_STATEMENT_VALIDITY`; a Hub may replay it to any client holding no higher
    remembered generation (§5.7), so a client's _displayed_ view of a node's policy can lag the
    node's committed one by up to that interval. This cannot widen admission — the node evaluates
    its own committed policy at §8.6 step 2 and at every §4.4 row, and a client acting on the stale
    statement is refused fail-closed at `P9` — but it can waste a channel and a single-use ticket,
    and it means the advertisement is evidence of what the node offered when it was signed and not
    of what it admits now. §5.2 steps 8 and 9 do not close this and are not claimed to: they read
    the range and the pattern set the statement itself carries, so a replayed pre-withdrawal
    statement still lets a conforming client build a hello the node now refuses. Those checks
    remove the ticket burn when the advertisement is current (§17.20); against a replayed one the
    bound is §5.7's policy-generation rules, which stop the replay from widening anything but not
    from being acted on. Fourth, nothing here reaches a node that is not running: a withdrawal
    committed while the node is down applies at the next start (§12.4), and until then the old
    policy is simply not serving anyone.
19. **Protocol-version skew is an availability failure by design, and on a latched selection it
    has no legacy escape.** §5.2 step 8 makes the advertised `[e2eeVersionMin, e2eeVersionMax]`
    decisive: a client whose `E2EE_PROTOCOL_VERSION` falls outside it never sends a hello. That is
    the right disposition — the alternative is a hello the node refuses at §8.6 step 2, which
    burns the channel and its single-use ticket and is the destructive probing §5.1 forbids — but
    its cost is stated rather than implied. On a **latched** selection the channel is fatal
    (`P15`) and stays fatal on every subsequent channel until one side is upgraded into a common
    range; the owner-initiated re-pair of §13.3 is the only in-protocol recovery, exactly as for a
    node that genuinely lost E2EE support (§12.1.1). On an unlatched selection the same statement
    is absent evidence, so the channel resolves through the `T_ADV` rows and a legacy-eligible
    selection falls back in the clear — the §17.4 exposure, reached here by version skew rather
    than by a stripped advertisement. What the Hub cannot do is manufacture the skew: the range is
    a signed element of the statement (§7.6 elements 7–8), so the most it can do is replay an
    older signed statement, which §5.7's policy-generation rules bound and which cannot widen
    anything. Version 1 keeps the whole item unreachable in practice — every conforming version-1
    node advertises a range containing `E2EE_PROTOCOL_VERSION`, and §7.6.1 checks that at the node
    — so this is a forward-looking bound on the first revision that ships a second version, which
    §1.3 leaves to its own reviewed handshake revision.
20. **Admitted-pattern exclusion is an availability failure by design, and for web it is total.**
    §5.2 step 9 makes the advertised effective admitted pattern set (§7.6 element 14) decisive in
    the same way §5.2 step 8 makes the version range decisive: a client whose tier's Noise pattern
    is absent from the set never sends a hello. That is the right disposition for the same reason —
    the alternative is a hello the node refuses at §8.6 step 2, burning the channel and its
    single-use ticket, and unlike a version skew this condition is a **durable node policy** rather
    than a build-time mismatch, so every session would repeat it — but its cost is stated rather
    than implied. The reachable version-1 case is `requireApprovedClientE2EE`, under which element
    14 is exactly `["IK"]`: every web session against that node is fatal at the carrier (`P15`,
    because §12.1's in-memory latch is set by the validation that precedes step 9), on every
    channel, with no in-protocol recovery and no legacy escape. That is not a regression — §12.4
    already states that this policy disables web access entirely, and §12.4's operator lockout
    warning is where an owner is told so before enabling it — but step 9 is what makes the refusal
    local, diagnosable, and free of ticket burn rather than a silent backed-off loop of `P9`s the
    client cannot explain. Two limits remain honest. First, an owner who enables the policy without
    reading the warning strands every web session, and the node-side counters see only the absence
    of channels, not a population that wanted one. Second, on the **native** tier step 9 is
    unreachable against any conforming version-1 node — element 14 always contains `"IK"` — so this
    item, like item 19, is mostly a forward-looking bound on the first revision that ships a new
    tier or pattern, and §7.6's element-14 closure names the two places such a revision changes.

## 18. Account-enrolled native authorization

This section is normative. It adds a login-authorized native IK mode without changing any suite
`0x01` byte, durable local approval, Web NX behavior, or record-layer rule. Where an older sentence
in §§1–17 says protocol version 1 has only one suite or every IK authorization uses a Branch A
record, this section is the additive exception.

### 18.1 Compatibility and trust source

Suite `0x02` is `Noise_IK_25519_ChaChaPoly_SHA256` with the account-grant payload and context below.
It is valid only for the native tier and only on a relay protocol 1.3 channel whose
`channel.open` carries the matching public ticket and grant digests. Suite `0x01` remains the only
suite for locally approved native IK and Web NX. Web clients MUST exclude `0x02` before suite
selection and MUST NOT decode, store, or forward a Hub device grant.

Capability statements continue carrying an array of unsigned suite identifiers. A client ignores
unknown identifiers while intersecting that array with its local registry; it does not reject an
otherwise valid statement merely because a future suite is present. This rule is what lets an old
client select `0x01` from `[0x02, 0x01]`. A node still rejects any selected identifier it does not
implement.

Native selection is trust-aware, not merely numeric preference:

1. Local Trusted Introduction or a matching approved/verified pin selects `0x01`.
2. Otherwise, a current native enrollment and matching grant selects `0x02`.
3. Otherwise, no native hello is emitted automatically. Manual verification is an explicit recovery
   path; plaintext is not.

An established channel records exactly one public trust source: `locally-verified`,
`account-enrolled`, or `web-unsigned`. `account-enrolled` MUST NOT create, modify, promote, or repair
a §13.6 client record or a §13.1 verified node pin. A conflicting local denial, revocation, or
verified pin is fatal and outranks the grant.

### 18.2 Constants and bounds

The following constants extend §3.2:

| Name                                     | Value      | Meaning                                                   |
| ---------------------------------------- | ---------- | --------------------------------------------------------- |
| `E2EE_HUB_DEVICE_GRANT_MAX_BYTES`        | 2,048      | Maximum complete signed grant envelope                    |
| `E2EE_HUB_DEVICE_GRANT_B64URL_MAX_CHARS` | 2,731      | Maximum unpadded base64url encoding of that envelope      |
| `E2EE_HUB_DEVICE_GRANT_NONCE_BYTES`      | 32         | Grant nonce length                                        |
| `E2EE_HUB_DEVICE_GRANT_VALIDITY`         | 120,000 ms | Maximum `expiresAt - issuedAt`                            |
| `E2EE_HUB_DEVICE_GRANT_CLOCK_SKEW`       | 30,000 ms  | Allowed early-arrival skew; expiry itself is not extended |
| `E2EE_HUB_DEVICE_GRANT_KEYSET_MAX_KEYS`  | 4          | Maximum simultaneous current/overlap verification keys    |
| `E2EE_HUB_DEVICE_GRANT_ID_MAX_BYTES`     | 47         | `hgr_` plus a 22–43 character base64url body              |
| `E2EE_HUB_GRANT_KEY_ID_MAX_BYTES`        | 47         | `hgk_` plus a 22–43 character base64url body              |
| `E2EE_NATIVE_ENROLLMENT_ID_MAX_BYTES`    | 47         | `enr_` plus a 22–43 character base64url body              |
| `E2EE_RELAY_TICKET_ID_MAX_BYTES`         | 47         | `rtk_` plus a 22–43 character base64url body              |
| `E2EE_ACCOUNT_GRANT_CAPABILITIES_MAX`    | 32         | Maximum distinct ordered relay capability literals        |
| `E2EE_ACCOUNT_GRANT_SUITE`               | `0x02`     | Registry identifier from §3.4                             |

Identifiers use the exact prefix shown and the ASCII regex `[A-Za-z0-9_-]` for their body. Epochs,
revisions, and keyset generations are integers in `0…2^32-1`; an enrollment revision is at least
one. Timestamps are non-negative epoch milliseconds no greater than `Number.MAX_SAFE_INTEGER`.
Roles and capabilities come only from the relay contract's closed vocabularies. Capability arrays
are nonempty, contain no duplicates, and use relay-contract order. All public-key, signature,
fingerprint, and digest widths remain those of §3.2 and §7.1.

Every bound is checked before signature or DH work. The complete envelope is rejected before CBOR
decode when it exceeds `E2EE_HUB_DEVICE_GRANT_MAX_BYTES`.

### 18.3 `HubDeviceGrant`

`encodeHubDeviceGrantClaims` emits a canonical-CBOR array of exactly 35 elements:

| #   | Field                           | Type          | Constraint                                               |
| --- | ------------------------------- | ------------- | -------------------------------------------------------- |
| 0   | domain                          | text          | `"ryco.hub-device-grant-claims.v1"`                      |
| 1   | version                         | uint          | `1`                                                      |
| 2   | suiteId                         | uint          | `E2EE_ACCOUNT_GRANT_SUITE`                               |
| 3   | `issuerHubOrigin`               | text          | Canonical origin, bounded by `E2EE_HUB_ORIGIN_MAX_BYTES` |
| 4   | `keyId`                         | text          | Hub grant-verification key identifier                    |
| 5   | `grantId`                       | text          | Unique grant identifier                                  |
| 6   | `accountId`                     | text          | Nonempty; bounded by `E2EE_ACCOUNT_ID_MAX_BYTES`         |
| 7   | `accountAuthEpoch`              | uint          | Current account authorization epoch                      |
| 8   | `enrollmentId`                  | text          | Native installation enrollment identifier                |
| 9   | `enrollmentRevision`            | uint          | Current revision, at least one                           |
| 10  | `deviceAuthEpoch`               | uint          | Current device authorization epoch                       |
| 11  | `deviceIdentityAlgorithm`       | text          | `"p256"`                                                 |
| 12  | `deviceIdentityPublicKey`       | bytes         | `P256_PUBLIC_KEY_BYTES`; point-validated                 |
| 13  | `deviceIdentityFingerprint`     | bytes         | Recomputed `ryco.client-key.v1` fingerprint              |
| 14  | `deviceAgreementAlgorithm`      | text          | `"x25519"`                                               |
| 15  | `deviceAgreementPublicKey`      | bytes         | `E2EE_AGREEMENT_PUBLIC_KEY_BYTES`; validated             |
| 16  | `deviceAgreementFingerprint`    | bytes         | Recomputed `ryco.e2ee-agreement-key.v1` fingerprint      |
| 17  | `clientPrekeyCertificateDigest` | bytes         | SHA-256 of the exact §18.4 certificate carrier           |
| 18  | `nodeId`                        | text          | Relay node-id format                                     |
| 19  | `nodeIdentityAlgorithm`         | text          | `"ed25519"`                                              |
| 20  | `nodeIdentityPublicKey`         | bytes         | `ED25519_PUBLIC_KEY_BYTES`; strictly validated           |
| 21  | `nodeIdentityFingerprint`       | bytes         | Recomputed `ryco.node-key.v1` fingerprint                |
| 22  | `nodeAgreementAlgorithm`        | text          | `"x25519"`                                               |
| 23  | `nodeAgreementPublicKey`        | bytes         | Exact agreement key in the named capability statement    |
| 24  | `nodeAgreementFingerprint`      | bytes         | Recomputed `ryco.e2ee-agreement-key.v1` fingerprint      |
| 25  | `nodeContinuityId`              | text          | §7.1 continuity-id format                                |
| 26  | `nodePolicyGeneration`          | uint          | Exact generation in the named capability statement       |
| 27  | `nodeCapabilityStatementDigest` | bytes         | SHA-256 of the exact signed capability-statement bytes   |
| 28  | `relayTicketId`                 | text          | Public identifier of the single-use relay ticket         |
| 29  | `maximumRole`                   | text          | Closed relay-role ceiling                                |
| 30  | `capabilities`                  | array of text | Nonempty, distinct, ordered, and bounded                 |
| 31  | `issuedAt`                      | uint          | Epoch milliseconds                                       |
| 32  | `notBefore`                     | uint          | Epoch milliseconds; `notBefore ≤ issuedAt ≤ expiresAt`   |
| 33  | `expiresAt`                     | uint          | Earliest lifetime bound described below                  |
| 34  | `nonce`                         | bytes         | `E2EE_HUB_DEVICE_GRANT_NONCE_BYTES` fresh CSPRNG bytes   |

The signed envelope is the canonical-CBOR array
`[ bstr(exact claims bytes), bstr(Ed25519 signature) ]`. The signature input is not the claims and
not a bare digest. Both signer and verifier construct the fixed-size canonical-CBOR array:

```text
[ "ryco.hub-device-grant.v1", bstr(SHA-256(exact claims bytes)) ]
```

The verifier first enforces envelope and claims bounds, strict-decodes both arrays with §3.6
re-encode equality, reads `keyId` only to select one entry from an authenticated immutable keyset,
reconstructs the signing input, and performs strict RFC 8032 verification. A carried digest or
fingerprint is never accepted on the carrier's authority. The grant digest used elsewhere is
`SHA-256(exact signed envelope bytes)`.

HTTP/JSON contracts carry the complete envelope as canonical unpadded base64url: URL-safe alphabet
only, no whitespace or `=`, at most `E2EE_HUB_DEVICE_GRANT_B64URL_MAX_CHARS`, and decode followed by
byte-for-byte re-encode equality. The encrypted Noise payload carries the decoded envelope bytes.

`expiresAt` MUST equal or precede the relay ticket expiry, `issuedAt +
E2EE_HUB_DEVICE_GRANT_VALIDITY`, the client prekey certificate expiry, and the node capability
statement and agreement-prekey expiry. A verifier permits at most
`E2EE_HUB_DEVICE_GRANT_CLOCK_SKEW` before `notBefore`, never after `expiresAt`, and never extends a
relay ticket's own validity. The Hub key selected by `keyId` must be valid for the entire grant
interval. Unknown, duplicate, not-yet-valid, retired, or out-of-overlap keys fail closed.

### 18.4 Client certificate carrier

The exact client certificate carrier is canonical CBOR:

```text
[ bstr(exact §7.4 clientPrekeyTranscript), bstr(P-256 signature) ]
```

It is bounded by `E2EE_DIRECT_SIGNING_TRANSCRIPT_MAX_BYTES + 70`, strict-decoded, and re-encoded
before use. Its digest is SHA-256 of the complete carrier, not of the transcript alone. The grant's
device identity/agreement keys and fingerprints, account namespace, and certificate digest MUST all
match the validated carrier. The Noise-received client static key MUST equal its agreement key.

### 18.5 Relay protocol 1.3 authorization context

Relay minor 3 adds the following bounded control-plane structures; it changes no data-frame format:

- `node.e2ee.statement` carries a connector generation, exact signed capability-statement bytes,
  their SHA-256 digest, and their expiry. A node publishes after `ready` and after every identity,
  prekey, continuity, suite, policy, expiry, or connector-generation change.
- `node.e2ee.statement.ack` carries the same connector generation and digest. Only an exact current
  acknowledgement enables account-grant admission.
- `e2ee.verifier-keys` carries a monotonically increasing keyset generation and at most
  `E2EE_HUB_DEVICE_GRANT_KEYSET_MAX_KEYS` entries of
  `[ keyId, Ed25519 public key, notBefore, notAfter ]`. Nodes and native clients receive it only on
  their authenticated Hub control path; a ticket-carried key is never a trust source.
- `e2ee.enrollment-revoked` carries enrollment id/revision plus the new account and device epochs.
  A stale epoch is ignored; a newer matching event aborts handshakes and closes leases.
- An account-grant `channel.open` carries `accountGrantContext =
[ 0x02, relayTicketId, bstr(deviceGrantDigest), bstr(nodeCapabilityStatementDigest) ]` in addition
  to minor-2 capability and role. All four members are required together on minor 3 and forbidden on
  minors 0–2. Local suite-`0x01` and Web channels omit it.

The Hub returns the same ticket id, grant envelope/digest, node statement/digest, keyset generation,
capability, and effective role to the native ticket requester over authenticated HTTPS. This adds no
per-node request. The grant itself is never present in relay control frames.

Connector generations own statement acknowledgements, keysets, revocation subscriptions, and open
ticket contexts. Reconnect clears them before readiness. A stale generation cannot publish or consume
any of those values. The node retains the exact acknowledged statement and matching prekey until every
ticket/grant that names them has expired.

### 18.6 Suite-`0x02` handshake bytes

The §8.5 seven-element `E2EEClientHello` wrapper is unchanged. For suite `0x02`, its encrypted IK
message-1 payload is a canonical-CBOR array of exactly six elements:

| #   | Field                    | Type  | Content                                          |
| --- | ------------------------ | ----- | ------------------------------------------------ |
| 0   | `clientPrekeyTranscript` | bytes | Exact §7.4 transcript bytes                      |
| 1   | `clientPrekeySignature`  | bytes | Exact P-256 signature from the §18.4 carrier     |
| 2   | `accountId`              | text  | Exact grant/certificate account id               |
| 3   | `intendedCapability`     | text  | Effective capability exercised on this channel   |
| 4   | `intendedRole`           | text  | Effective role exercised on this channel         |
| 5   | `hubDeviceGrant`         | bytes | Exact signed §18.3 envelope, at most 2,048 bytes |

Suite `0x01` retains its exact five-element payload. A grant in `0x01`, a six-element payload in
`0x01`, a five-element payload in `0x02`, or suite `0x02` with tier `web` is FATAL-PRE.

Suite `0x02` uses a distinct authorization context: a canonical-CBOR array of exactly 29 elements.
Elements 1–17 have the same meaning and construction as §8.3 elements 1–17; element 0 is the new
domain.

| #    | Field                           | Type          | Content                                |
| ---- | ------------------------------- | ------------- | -------------------------------------- |
| 0    | domain                          | text          | `"ryco.relay-e2ee.account-context.v1"` |
| 1–17 | existing context fields         | —             | Exact §8.3 fields 1–17                 |
| 18   | `deviceGrantDigest`             | bytes         | SHA-256 of the exact grant envelope    |
| 19   | `relayTicketId`                 | text          | Exact public ticket id                 |
| 20   | `nodeCapabilityStatementDigest` | bytes         | SHA-256 of exact advertised statement  |
| 21   | `clientPrekeyCertificateDigest` | bytes         | SHA-256 of exact §18.4 carrier         |
| 22   | `enrollmentId`                  | text          | Exact grant enrollment                 |
| 23   | `enrollmentRevision`            | uint          | Exact grant revision                   |
| 24   | `accountAuthEpoch`              | uint          | Exact grant epoch                      |
| 25   | `deviceAuthEpoch`               | uint          | Exact grant epoch                      |
| 26   | `grantMaximumRole`              | text          | Grant's role ceiling                   |
| 27   | `grantCapabilities`             | array of text | Exact ordered grant capability ceiling |
| 28   | `grantNonce`                    | bytes         | Exact grant nonce                      |

The context commitment remains SHA-256 of the complete canonical block and the existing §8.4
prologue therefore separates `0x02` by suite id as well. The ticket id is the public relay-attempt
identifier; together with `channelId` it binds the grant to the exact channel generation. The
client uses values from its authenticated ticket response and validated statement. The node uses
its current connector-owned `channel.open`, acknowledged statement, retained prekey, and keyset.

Worst-case wire arithmetic is closed without changing `E2EE_CLIENT_HELLO_MAX_BYTES`:

```text
suite-0x02 IK payload
  array header                                                     1
  client transcript bstr (≤ 1,024 plus 3-byte header)          1,027
  P-256 signature bstr (64 plus 2-byte header)                     66
  account id text (≤ 256 plus 3-byte header)                       259
  capability text (`ryco.rpc`)                                      9
  longest role text (`operator`)                                    9
  grant bstr (≤ 2,048 plus 3-byte header)                        2,051
                                                                  -----
                                                                  3,422

Noise IK message 1 = e(32) + encrypted s(32 + 16) +
                     encrypted payload(3,422 + 16)               3,518

seven-element hello body = array/version/tier/suite/offered(19) +
                           nonce bstr(34) + commitment bstr(34) +
                           Noise bstr(3 + 3,518)                  3,608
negotiation discriminator + record type                              2
                                                                  -----
worst complete E2EEClientHello                                   3,610
E2EE_CLIENT_HELLO_MAX_BYTES                                     4,096
headroom                                                           486
```

The generator MUST prove that the largest conforming claims/envelope under the closed registries fits
the 2,048-byte hard limit. It MUST separately reproduce the conservative hello arithmetic above with
a synthetic 2,048-byte bounded grant carrier and test a 2,049-byte pre-decode rejection. Neither a
grant nor a hello is fragmented to make it fit.

### 18.7 Verification, authority, and revocation

Before constructing message 1, the native client verifies the authenticated Hub keyset, strict grant
encoding and signature, time window, ticket id, account/device epochs, enrollment revision, device
keys, certificate digest, exact node statement digest and contents, node keys, continuity id, policy
generation, capability, and role. It preserves the existing locally verified fingerprint and policy
generation high-water checks. Failure releases no application bytes.

After the existing pre-crypto bounds and rate checks and after Noise decrypts message 1, the node
performs the same checks from its own connector and channel state. Authorization succeeds only when
all values are equal and the effective authority is the intersection of:

1. the directory and `channel.open` capability/role;
2. the grant's capability and role ceilings;
3. the node's current policy;
4. any matching local restriction or denial.

No input widens another. Success creates an immutable in-memory `account-enrolled` lease for that
single channel and enrollment revision. It performs no durable approval write. Ticket/grant expiry
prevents a new channel but does not impose a mid-session timer; channel close, a newer matching
revocation epoch, account switch, connector-generation loss, or policy withdrawal destroys the lease
and all read/mutation readiness synchronously.

All grant failures use the existing fixed-size FATAL-PRE rejection and `channel_rejected` close. Local
diagnostics may use only these bounded reason codes: `grant_oversize`, `grant_malformed`,
`grant_non_canonical`, `grant_version`, `grant_unknown_key`, `grant_signature`, `grant_not_yet_valid`,
`grant_expired`, `grant_binding`, `grant_revoked`, and `grant_policy`. They MUST NOT contain claims,
identifiers, keys, signatures, grant/ticket bytes, or peer-controlled text. Grant verification shares
the §15 per-origin token bucket and in-flight handshake bound; failures never produce a key oracle.

### 18.8 Policy source of truth and migration

The durable source of truth is the closed enum shown in §2.3. Its advertised projection is:

| Policy mode                            | `requireE2EE` | `requireApprovedClientE2EE` | suites offered | admitted patterns |
| -------------------------------------- | ------------- | --------------------------- | -------------- | ----------------- |
| `compatibility`                        | false         | false                       | `[0x02,0x01]`  | `["IK","NX"]`     |
| `require-e2ee`                         | true          | false                       | `[0x02,0x01]`  | `["IK","NX"]`     |
| `require-native-e2ee`                  | true          | false                       | `[0x02,0x01]`  | `["IK"]`          |
| `require-locally-approved-native-e2ee` | true          | true                        | `[0x01]`       | `["IK"]`          |

The two booleans remain compatibility projections in the version-1 capability transcript; they are
not independently writable after migration. A version-1 policy record migrates crash-atomically as:
`requireApprovedClientE2EE=true` → `require-locally-approved-native-e2ee`, otherwise
`requireE2EE=true` → `require-e2ee`, otherwise `compatibility`. No legacy record maps implicitly to
`require-native-e2ee`.

Moving rightward in §2.3's table, withdrawing suite `0x02`, advancing a revocation epoch, or narrowing
role/capabilities is a policy/authorization withdrawal: commit durable state and its monotonic
generation first, abort newly disallowed in-flight handshakes, close newly disallowed live channels,
then acknowledge. Moving left affects only later channels. The strongest legacy boolean keeps its
exact security meaning and never starts accepting account grants after migration.

## Appendix A — Analyzed alternative carrier (not part of this protocol)

_This appendix is non-normative._

During carrier analysis (§5.3, §5.6), a second legacy-safe shape was identified that is
silent in **both** directions against the pinned RPC implementations:

```text
{"_tag":"Ack","requestId":"<decimal string of an id never used by a live request>"}
```

At the node, an `Ack` whose request id matches no live request hits the RPC server's
latch-miss path and is discarded without a reply; at the client, the same object falls to the
response dispatcher's default branch and is ignored. Extra members are tolerated, so the
shape could smuggle a bounded payload bidirectionally before tier knowledge exists.

Version 1 deliberately does not use it:

- **It is unnecessary.** The only pre-tier message this protocol needs is the node-to-client
  advertisement, and the reserved-tag carrier of §5.3 is strictly safer in that direction. A
  client never needs a legacy-safe message toward a node: its first E2EE send (the hello)
  happens only after validated evidence that the node is not legacy.
- **Collision fragility.** Request ids are allocated by a live counter; safety depends on
  choosing an id outside the range any long-lived session could reach, and a collision with a
  live streaming request would acknowledge — and thereby perturb — real traffic.
- **Behavioral dependence.** Its silence rests on the unpatched upstream latch-miss and
  default-branch behaviors of the pinned RPC implementation, which carry no compatibility
  contract, and a malformed instance (unparseable id) is not silent — it defects the
  receiving loop.

The shape is recorded so a future revision needing a bidirectional pre-tier signal starts
from the analysis rather than rediscovering it; any such use requires its own compatibility
proof against the then-current pinned implementations.

## Appendix B — Deliverable checklist cross-reference

_This appendix is non-normative._ The protocol was authored against a 44-item deliverable
checklist; the table maps each item number and a one-line paraphrase to the sections that
satisfy it.

| #   | Item (paraphrase)                                                                                                                                                                                                                                                                                          | Sections                          |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| 1   | E2EE envelope byte layout, field widths, endianness                                                                                                                                                                                                                                                        | §3.2, §3.3                        |
| 2   | Encrypted inner-record framing, type registry, max sizes                                                                                                                                                                                                                                                   | §3.3, §3.4, §9.1, §10.1, §11.3    |
| 3   | Negotiation-only `0x02` record layout, registry, bounds                                                                                                                                                                                                                                                    | §3.3, §3.4, §8.5, §8.7, §11.2     |
| 4   | Proven legacy-safe capability carrier + compatibility cases + prelude-headroom fit                                                                                                                                                                                                                         | §3.2.1, §5.3–§5.6, §16.3 F2       |
| 5   | Overhead constant, effective-ceiling formula, plaintext ceiling, distinct error, fail-before-release                                                                                                                                                                                                       | §3.2, §4.5, §11.4                 |
| 6   | negotiating/e2ee/legacy mode machine, deadlines, fatal inputs per state                                                                                                                                                                                                                                    | §4.4, §3.2.2                      |
| 7   | Single client-selected v1 suite, concrete Noise names, spec revision                                                                                                                                                                                                                                       | §3.4, §8.2                        |
| 8   | Noise library decision with audit status and supported exporter API                                                                                                                                                                                                                                        | §14.1, §14.2, §6.5                |
| 9   | Exact IK/NX message composition; no identifiers in clear wrappers; no app RPC in payloads                                                                                                                                                                                                                  | §8.5, §8.7, §8.1                  |
| 10  | Client-selected suite rule; server may only accept or reject                                                                                                                                                                                                                                               | §8.2                              |
| 11  | Per-payload security properties, stated per payload and direction                                                                                                                                                                                                                                          | §8.10, §2.2, §2.6                 |
| 12  | Implicit client finish; no node RPC before it authenticates                                                                                                                                                                                                                                                | §8.9                              |
| 13  | Authorization context block: fields, order, role rules, absence semantics                                                                                                                                                                                                                                  | §8.3, §16.3 F16                   |
| 14  | `contextCommitment`, prologue, responder pre-check, symmetric client check                                                                                                                                                                                                                                 | §8.3, §8.4, §8.6, §8.8, §16.3 F16 |
| 15  | `ServerAcceptTBS`, confirmation transcript, confirmation key derivation                                                                                                                                                                                                                                    | §8.7                              |
| 16  | `sessionBindingHash` without self-reference                                                                                                                                                                                                                                                                | §8.8                              |
| 17  | Key schedule: Split/exporter, directional keys, per-channel, destroyed, never resumed                                                                                                                                                                                                                      | §6.5, §9.4, §9.5                  |
| 18  | Per-record AEAD: nonce, AAD, version/suite gate, receiver-state counters, uint64 rules                                                                                                                                                                                                                     | §3.3, §9.1–§9.3                   |
| 19  | Rekey ratchet: thresholds, boundary ownership, labels, erasure, exhaustion                                                                                                                                                                                                                                 | §9.4–§9.6                         |
| 20  | Authenticated close machine, outer-close ordering, truncation, unattributed abrupt close                                                                                                                                                                                                                   | §10                               |
| 21  | Agreement keys, cross-signing transcripts and domains, no ad-hoc signing, signing-input bound                                                                                                                                                                                                              | §6.2, §7.2, §7.2.1, §7.3, §7.4    |
| 22  | Custody: node secret store, mobile device-only, web memory-only, clone/restore ban, and what a client whose durable trust state was lost may do                                                                                                                                                            | §6.3, §13.1.1                     |
| 23  | Prekey expiry semantics, skew, remedies, rotation overlap                                                                                                                                                                                                                                                  | §6.4                              |
| 24  | Identity/signature wire encodings and strict validation rules                                                                                                                                                                                                                                              | §7.1, §14.3, §16.3 F17            |
| 25  | Pin = identity fingerprint anchor, indexed by client-side selection handle; states; storage; device-level verification marker; release gate                                                                                                                                                                | §13.1, §13.1.1, §12.1.1           |
| 26  | First-contact pairing ceremony, pending record, fresh-ticket effectiveness, unexpected-node surface                                                                                                                                                                                                        | §13.2, §13.2.1                    |
| 27  | Identity-continuity certificate, chain rules, storage, recovery and compromise breaks, custody caveat                                                                                                                                                                                                      | §7.5, §13.3                       |
| 28  | Native safety number derivation, format, surfaces, entropy floor                                                                                                                                                                                                                                           | §3.2, §13.4                       |
| 29  | `WebSAS` derivation, format, advisory-only language, grinding bound                                                                                                                                                                                                                                        | §3.2, §13.5, §17.5                |
| 30  | Client authorization records: schema, caps, partition-scoped eviction, owner-bound pairing window, authorization withdrawal (revocation, role reduction, capability removal) and its acknowledgement ordering, node-side state                                                                             | §13.6, §8.6, §8.9, §16.3 F16      |
| 31  | Capability advertisement transcript, freshness, replay, policy generation and its high-water anchor, statement self-check                                                                                                                                                                                  | §5.2, §5.7, §7.2.1, §7.6, §7.6.1  |
| 32  | Latch carried on a pin whose latched value is the verified fingerprint, resolved from the client's own selection; native durable, first contact never latches; web in-memory and session-scoped, set on the first validated statement as an explicit narrowly-scoped exception with a bounded threat claim | §12.1, §12.1.1                    |
| 33  | Fallback rule: no probe, bounded wait, no reopen, legacy labeling                                                                                                                                                                                                                                          | §12.2                             |
| 34  | `requireE2EE` semantics and default-flip criteria; policy withdrawal on narrowing                                                                                                                                                                                                                          | §12.3, §12.6, §16.3 F18           |
| 35  | `requireApprovedClientE2EE`: implication, IK-only advertisement, warnings, no silent weakening, live-channel sweep on enable                                                                                                                                                                               | §12.4, §12.6, §16.3 F18           |
| 36  | Pre-authentication bounds, size-relationship invariants, liveness and concurrency invariants, one attempt per channel, generic close on excess                                                                                                                                                             | §3.2.1, §3.2.2, §15, §4.4         |
| 37  | Error taxonomy onto existing close reasons; generic pre-key surface; named observable                                                                                                                                                                                                                      | §11                               |
| 38  | Fallback-occurrence instrumentation: two disjoint classes, event, state, reset, display                                                                                                                                                                                                                    | §12.5, §5.5                       |
| 39  | Fixture directory, file format, required vector families                                                                                                                                                                                                                                                   | §16                               |
| 40  | Shared-module home beside the chunking module; referenced from the relay protocol                                                                                                                                                                                                                          | §1.1                              |
| 41  | Canonical-CBOR dependency, version, strictness, vetting status                                                                                                                                                                                                                                             | §3.6, §14.4                       |
| 42  | React Native randomness adapter, fail closed                                                                                                                                                                                                                                                               | §14.5                             |
| 43  | Mobile custody: device-only, non-backup on both platforms                                                                                                                                                                                                                                                  | §6.3                              |
| 44  | Honest guarantees: tier table, web ceiling, retained metadata, non-goals                                                                                                                                                                                                                                   | §2, §1.3                          |
