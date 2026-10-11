# Relay E2EE Noise state machine — third-party audit scope

This document scopes a security audit with one cryptographic core and one bounded integration
delta: the first-party Noise handshake state machine of the Ryco relay E2EE protocol, plus the
suite-`0x02` account-grant path that invokes it. It exists so that commissioning the audit is a
short email rather than a research project.

The audit is not optional polish. [§14.1 of the protocol](./relay-e2ee-protocol.md) makes a
scoped third-party audit of this module a **precondition for flipping the `requireE2EE` default**
(§12.3), and §17.1 records the unaudited state machine as the protocol's largest open risk,
carried deliberately until that audit completes.

All `§` references below are to [`docs/relay-e2ee-protocol.md`](./relay-e2ee-protocol.md), the
normative specification, unless a reference says "Noise §", which means the Noise Protocol
Framework at the revision named in [section 3](#3-protocol-names-spec-revision-and-the-exporter).

## 1. What is being audited

**In scope — one file:**

| Path                                         | Lines | Role                                     |
| -------------------------------------------- | ----- | ---------------------------------------- |
| `packages/shared/src/relayE2eeNoise.ts`      | 986   | The state machine. The audit target.     |
| `packages/shared/src/relayE2eeNoise.test.ts` | 1,088 | Its colocated suite, 46 cases. Evidence. |

The module is heavily commented; the executable surface is roughly half its line count. It
is a single file by protocol obligation, not by accident: §14.1 permits **exactly one** first-party
module implementing the Noise `CipherState`/`SymmetricState`/`HandshakeState` composition, and that
bound is what makes a scoped audit possible at all.

**What the module does.** For the two protocol names of §3.4, at the Noise revision of §3.2:
`Initialize` (protocol name, prologue, IK pre-message static), `WriteMessage`/`ReadMessage` for the
two message patterns, `MixKey`/`MixHash`/`EncryptAndHash`/`DecryptAndHash`, the handshake
`CipherState` with its nonce, `Split()`, and the §6.5 exporter. It enforces message ordering,
single use, and its own key-material length preconditions.

**What it delegates to the audited primitives.** Every AEAD, hash, HMAC/HKDF, and curve operation
is a call into `@noble/ciphers`, `@noble/hashes`, or `@noble/curves`, through their documented
public entry points only (§14.6). §14.1 requires the module to "perform no primitive arithmetic of
its own". Confirming that it in fact performs none is a legitimate audit question; performing an
analysis of the primitives is not (section 4).

**What it deliberately does not do** — each of these is a boundary the auditor should hold the code
to, not a gap:

- **No transport encryption.** §6.5 consumes the two `Split()` outputs as the directional epoch-0
  secrets of §9 and forbids using the Noise cipher states for transport, so `split()` returns raw
  key bytes and no post-handshake `CipherState` is ever constructed. Record protection, the
  `epoch ‖ counter` record nonce, AEAD framing, and the rekey ratchet live in
  `packages/shared/src/relayE2eeWire.ts` and are outside this scope.
- **No §8 payload schema enforcement.** The §8.5 rule that an NX message-1 payload MUST be
  zero-length, the CBOR payload shapes of §8.5/§8.7, and the ordering of responder checks in §8.6
  belong to the handshake driver. The module carries whatever payload bytes it is given, because
  the official §16.3 F15 vectors carry payloads on every message of both patterns and the module
  MUST reproduce them exactly.
- **No clock, no channel state, no logging, no I/O, no network, no persistence.**

**Context for the core review.** These siblings are worth reading to understand the module's
callers, but are not part of the core state-machine target: `relayE2eeConstants.ts` (§3.2
constants), `relayE2eeWire.ts` (envelope codec, record framing, AAD/nonce),
`relayE2eeTranscripts.ts` (the §8.4 prologue and the §7 certificate transcripts),
`relayE2eeKeys.ts`, and `relayE2eeVerificationDisplay.ts`.

**Account-enrolled extension delta — in scope for the current engagement:**

| Path / bounded portion                                                                                                               | Review target                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared/src/relayE2eeHubDeviceGrant.ts`                                                                                     | The exact 35-element canonical claims array, signed envelope, strict decode/re-encode checks, bounds, signatures, time and binding validation.                                                             |
| Suite-`0x02` portions of `relayE2eeTranscripts.ts` and `relayE2eeHandshake.ts`                                                       | The six-element IK payload, 29-element authorization context, distinct domains, exact ticket/grant/statement/certificate bindings, and suite/tier separation.                                              |
| Suite-`0x02` use of `relayE2eeWire.ts` and `relayE2eeSession.ts`                                                                     | Confirmation that account enrollment changes no envelope, nonce, AAD, counter, rekey, close, or erasure rule after the handshake.                                                                          |
| `packages/client-runtime/src/authorization/nativeE2eeTrustResolver.ts` and the account-grant branch of `relay/relayE2eeInitiator.ts` | Trust-source precedence, client-side verification before hello, requested-authority intersection, downgrade refusal, and no plaintext release.                                                             |
| `apps/server/src/hubConnector/NodeAccountGrantVerifier.ts` and the account-grant branch of `NodeE2eeChannelSession.ts`               | Authenticated connector-state inputs, server-side re-verification, authorization callback ordering, immutable lease creation, revocation/generation fencing, and absence of durable local approval writes. |
| `packages/contracts/src/nativeE2ee.ts` and relay 1.3 account-grant schemas                                                           | Closed vocabularies and pre-cryptographic size/range bounds used by both endpoints.                                                                                                                        |

Everything else in the Hub account API, directory UI, native key-store adapters, and relay routing
service is integration context rather than source-review scope. Findings that show one of those
boundaries can violate a reviewed assumption are still actionable and should identify the missing
assumption explicitly.

## 2. Why a first-party implementation exists

The library policy this protocol was drafted under required an **audited** full Noise
implementation, with primitive packages alone explicitly not satisfying the requirement, and a hard
stop rather than a bespoke composition if no qualifying dependency existed. That stop condition
fired. §14.1 records the resolution verbatim as an accepted deviation:

> No audited pure-TS Noise implementation exists (research verdict, 2026-07-30). Owner accepted:
> first-party minimal frozen Noise IK+NX state machine implemented in `packages/shared` on audited
> noble primitives.

The survey behind that verdict found the gap structural rather than a search failure:

- No pure-TS/JS Noise implementation has ever been audited **as** a Noise implementation.
- The libraries that cover IK+NX are built on native-binding or unaudited-JS sodium splits, with no
  Hermes support — and Ryco needs Bun, evergreen browsers, and Hermes from one codebase.
- No JS Noise library exposes a supported exporter or post-`Split()` derivation API, which §6.5
  requires.
- The one widely deployed JS Noise library is XX-only, WASM-assisted, and carries CVE-2022-24759 —
  an unvalidated handshake-payload signature permitting MITM — which is itself a concrete
  demonstration of how unaudited handshake state machines fail.

§14.1 bounds the deviation with normative obligations: the single frozen module above; official
Noise vectors MUST pass; cross-implementation vectors against at least one independent
implementation MUST pass; property-based tests MUST cover the state machine; the full adversarial
suite MUST run against it; and **this audit** is required before the `requireE2EE` default flip.

## 3. Protocol names, spec revision, and the exporter

- **Native signed tier (IK):** `Noise_IK_25519_ChaChaPoly_SHA256`
- **Web tier (NX):** `Noise_NX_25519_ChaChaPoly_SHA256`
- Both are suite `0x01` in the §3.4 registry. X25519 (RFC 7748), ChaCha20-Poly1305 (RFC 8439),
  SHA-256. The client is always the initiator and the node always the responder (§8.1).
- **Noise Protocol Framework revision 34** (`NOISE_SPEC_REVISION`, §3.2). Both protocol names are
  exactly 32 bytes, so `InitializeSymmetric` takes the zero-padding branch, not the hashing branch.
- **Prologue:** the canonical-CBOR array of §8.4, domain-separated by
  `"ryco.relay-e2ee.prologue.v1"` and containing the channel id, so every Noise message and derived
  key is channel-unique. The module receives it as opaque bytes.

**The exporter is first-party, not standard Noise.** §6.5 defines exactly three extractable values
and forbids extracting anything else from handshake state:

```text
(k_c2n, k_n2c)      = Noise Split() outputs, in Noise order (initiator-to-responder first)
epochSecret_c2n[0]  = k_c2n
epochSecret_n2c[0]  = k_n2c
exporterSecret      = HKDF-Expand(ck_final, "ryco.relay-e2ee.exporter.v1", 32)
```

`ck_final` is the Noise chaining key at the moment `Split()` is invoked. The chaining key itself is
never handed out; `split()` derives all three values and erases the symmetric state before
returning. `exporterSecret` feeds only `serverConfirmationKey` (§8.7). §14.6 satisfies its
no-undocumented-internals rule by construction here: the exporter **is** this protocol's documented
API, because the state machine defining it is first-party.

## 4. Threat model to assume

**The relay is a fully active man-in-the-middle.** The Hub authenticates both relay connections,
mints the single-use tickets, and authors `channel.open` including its `capability` and
`effectiveRole` fields; node ids and channel ids are Hub-minted. Nothing in the relay protocol lets
a node distinguish a genuine client from a session the Hub originated itself (§2.1). The auditor
should assume the adversary controls all traffic and all timing between the endpoints and may
substitute, reorder, replay, truncate, drop, or originate messages at will. E2EE treats the Hub's
own ordering and size checks as untrusted.

**Endpoints are honest.** Compromise of the node host or the client device is outside the threat
model (§2.6), as are traffic analysis of the §2.5 metadata, an operator-proof web client (§2.4),
cryptographic attribution of an abrupt close, and post-compromise recovery within an open channel.

**Explicitly out of scope: a full primitive re-audit.** The primitive lineages have independent
audits, while the current 2.x pins additionally have only the maintainer self-audit described
below. Re-auditing every primitive implementation is not what this engagement buys; validating the
way Ryco invokes its production import closure remains in scope. §14.2 states the lineage exactly:

| Package          | Independent audit                          | Scope relevant here                                                                                                      |
| ---------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `@noble/curves`  | Cure53, September 2024 (baseline `1.6.0`)  | Scope includes ed25519, ed448, hash-to-curve, and the low-level Edwards **and Montgomery** modules — X25519 is in scope. |
| `@noble/curves`  | Trail of Bits, February 2023 (v0.7.3)      | Abstract Weierstrass, modular arithmetic, hash-to-curve, secp256k1.                                                      |
| `@noble/curves`  | Kudelski Security, September 2023 (v1.2.0) | Curve, modular, Poseidon, Weierstrass modules.                                                                           |
| `@noble/ciphers` | Cure53, September 2024 (baseline `1.0.0`)  | Full scope, explicitly including ChaCha20 and Poly1305 — exactly the suite AEAD.                                         |
| `@noble/hashes`  | Cure53, January 2022 (baseline `1.0.0`)    | Everything except BLAKE3, SHA-3 addons, SHA-1, and Argon2 — SHA-256, HMAC, and HKDF are in scope.                        |

The runtime pins `@noble/curves@2.3.0`, `@noble/ciphers@2.3.0`, and
`@noble/hashes@2.3.0`, each with a lockfile integrity digest. The protocol baseline remains the
maintainers' all-files self-audit at `2.2.0` (April 2026). The accepted runtime delta is exactly
`2.2.0…2.3.0` for the production import closure: curves `ed25519.js`/`nist.js` and their abstract
dependencies; ciphers `chacha.js`/`utils.js`; and hashes `sha2.js`/`hmac.js`/`hkdf.js`/`utils.js`.
That delta contains broad upstream refactoring, hardening, performance, type-checking, and
tree-shaking work rather than a narrowly audited patch. On 2026-09-04 the owner explicitly accepted
using those exact `2.3.0` pins after Ryco's byte-exact vectors, differential replay, adversarial
suite, Chromium corpus, Hermes/mobile tests, and full repository backstop passed. This acceptance
does **not** turn the upstream maintainer self-audit into an independent audit of Noble 2.x, Ryco's
Noise state machine, or the suite-`0x02` composition.

Two additional caveats remain explicit: P-256 is a thin configuration over independently audited
abstract Weierstrass code, but the top-level NIST-curve module was never named in an independent
audit scope; and the account-enrolled delta uses P-256 and canonical CBOR even though the core Noise
module itself does not. Those are reasons to include the bounded extension above, not reasons to
describe it as already audited.

Exact upstream comparisons for reviewer intake:
[curves 2.2.0…2.3.0](https://github.com/paulmillr/noble-curves/compare/2.2.0...2.3.0),
[ciphers 2.2.0…2.3.0](https://github.com/paulmillr/noble-ciphers/compare/2.2.0...2.3.0), and
[hashes 2.2.0…2.3.0](https://github.com/paulmillr/noble-hashes/compare/2.2.0...2.3.0).

Also accepted, not findings: JavaScript cannot guarantee constant-time execution under JIT and GC
(§17.2), and zeroization in a managed runtime bounds but cannot eliminate residual copies (§17.3).
Timing and memory-residue observations are welcome as context; they are known and accepted risks.

## 5. Questions worth the auditor's attention

1. **Message ordering and single-use enforcement.** The two patterns are two messages long, so the
   sequence is fixed and every other order must be rejected. The module distinguishes two failure
   classes deliberately: a precondition rejection (calling an operation this party does not owe)
   touches no state and leaves a live handshake usable, while any failure raised while _processing_
   a message destroys the handshake, because a partially applied message leaves a symmetric state
   no conforming peer can agree with. Is that split correct, and is it exploitable? Is `split()`
   reachable exactly once, only after both messages, with every later operation refused? §8.1
   allows exactly one handshake attempt per channel.
2. **Nonce handling and exhaustion.** The handshake cipher nonce is Noise §5.1's 32 zero bits
   followed by little-endian `n`. Every AEAD invocation in both patterns should use counter 0,
   because each is preceded by a `MixKey()` that resets the counter — meaning no handshake
   transcript can distinguish this encoding from a wrong one, which is exactly why it is pinned by
   literal test vectors instead. Is there any reachable path that reuses a `(key, nonce)` pair? Is
   `n` incremented only on successful decryption? Is `2^64 − 1` correctly reserved rather than used?
3. **The exporter derivation.** `Split()` is `HKDF(ck_final, empty, 2)` and the exporter is
   `HKDF-Expand(ck_final, "ryco.relay-e2ee.exporter.v1", 32)` over the _same_ chaining key. Is that
   domain separation sound, and is the exporter output independent of the two split outputs? A
   second question underneath it: the module expresses Noise §4.3's `HKDF(ck, ikm, 2)` on RFC 5869
   `extract`/`expand` rather than on a hand-rolled HMAC chain. The claimed identity — Noise's
   `temp_key` is `extract` with the chaining key as salt, and Noise's two outputs are the first
   2·HASHLEN bytes of `expand` with empty `info` — is the single most load-bearing rewrite in the
   file and deserves direct verification.
4. **Erasure.** §6.5 and §9.5 require the ephemeral private key, the static copy, the chaining key,
   the handshake hash, and the cipher state to be overwritten with zeros. Are all of them zeroed on
   `split()`, on `destroy()`, and on every failure path? Are intermediate buffers (HKDF outputs,
   shared secrets, derived nonces) zeroed? Does the module ever retain a reference to a caller's
   buffer, or hand back a view aliasing internal state? Ownership of the test-only injected
   ephemeral is worth a look.
5. **The all-zero DH abort.** §8.1 and §14.3 make an all-zero X25519 output — the invalid and
   low-order input case — a mandatory handshake abort, signalled by the pinned primitive's own
   throw. The module does not catch or reclassify it. Is there any path where a zero shared secret
   could be mixed instead of aborting? Relatedly, §11.2 requires every pre-key failure to be
   externally indistinguishable; the module's `reason` field is documented as local classification
   only and must never reach a peer, a log, or an error surface. Does the code make that easy to
   honour, or easy to leak?
6. **Do the §8.10 payload security properties actually hold for this implementation?** §8.10 makes
   no blanket claim; it states a Noise authentication/confidentiality grade per payload and per
   direction, and the whole tier story of §2.2 rests on it:

   | Payload / direction           | Auth | Conf | Claim that must hold                                             |
   | ----------------------------- | ---- | ---- | ---------------------------------------------------------------- |
   | IK message-1 payload          | 1    | 2    | KCI against the node agreement key; no forward secrecy           |
   | IK message-2 payload          | 2    | 4    | KCI-resistant; weak FS conditional on the node agreement prekey  |
   | IK transport, both directions | 2    | 5    | Mutual static auth, KCI-resistant, strong forward secrecy        |
   | NX message-1 payload          | 0    | 0    | Nothing; MUST be empty (enforced by the driver, not this module) |
   | NX message-2 payload          | 2    | 1    | Node authenticated; encrypted to an anonymous ephemeral          |
   | NX client→node transport      | 0    | 5    | **The client is never authenticated at the Noise level**         |
   | NX node→client transport      | 2    | 1    | Node-authenticated to whoever initiated; FS via `ee`             |

   The question is whether the code as written realizes exactly those grades — no accidental
   strengthening, and more importantly no accidental weakening. Concretely: are the message-pattern
   token sequences right; does `#mixDh` resolve each DH token's local and remote key correctly for
   _both_ roles (`es` is `DH(e, rs)` for the initiator and `DH(s, re)` for the responder, `se` is
   the mirror); is the IK pre-message `MixHash` of the responder static performed identically by
   both parties; and is the prologue mixed before it? Identity hiding is part of the same question:
   the IK client static and certificate are encrypted under keys derived from `es` only, so they are
   hidden from passive observers but readable — including retroactively — by any holder of the node
   agreement private key. That exposure is documented and accepted; silently widening it would not
   be.

7. **Grant and certificate canonicality.** Can any alternate CBOR, base64url, ECDSA, Ed25519,
   point, integer, array, or duplicate representation verify while hashing to a different bound
   value? Are the complete signed envelope and exact six-element Noise payload bounded before
   signature or DH work? Does every carried digest get recomputed from exact bytes rather than
   trusted from the carrier?
8. **Authorization intersection and callback ordering.** Do the ticket, grant, node statement,
   certificate, Noise static, account/enrollment epochs, role, capability, continuity id, policy
   generation, and connector generation all name one attempt? Can a callback race, stale snapshot,
   or partial intersection widen authority? Is an account-enrolled success confined to one
   in-memory lease with no durable §13.6 approval or verified-pin write?
9. **Downgrade, revocation, and record integration.** Can suite `0x02` enter Web or relay minor
   0–2, can an unknown/new suite suppress a valid stronger local choice, or can a Hub grant outrank
   a local pin/denial? Do account switch, epoch advancement, connector-generation loss, policy
   withdrawal, and live revocation synchronously remove read/mutation readiness and close the
   lease? After establishment, is the suite-`0x01` record layer reused without a second nonce
   space, altered AAD, or account-specific rekey exception?

## 6. Evidence available to the auditor

| Evidence                                    | Status                                                                                                        |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| The specification                           | Landed: `docs/relay-e2ee-protocol.md`, normative, ~6,200 lines                                                |
| Colocated unit and golden-transcript suite  | Landed: `packages/shared/src/relayE2eeNoise.test.ts`, 46 cases                                                |
| Official Noise vectors (§16.3 family F15)   | Landed: `packages/shared/fixtures/e2ee/v1/f15-noise-core-vectors.json`                                        |
| Cross-implementation vectors                | Landed: F15 plus Snow replay of Ryco F6/F7; see below                                                         |
| Property-based state-machine suite          | Landed: `packages/shared/src/relayE2eeNoiseProperties.test.ts`, 24 properties                                 |
| Adversarial suite                           | Landed: `packages/shared/src/relayE2eeAttackerRelay.test.ts`, 128 cases                                       |
| — of which run on the hostile-relay harness | 16 (section K); the other 112 hand-carry delivery one record at a time                                        |
| Account-enrolled generated vectors          | Landed: §16 family F19, including positive `0x02`, rejection, bounds, and Web-isolation cases                 |
| Cross-version and policy evidence           | Landed: relay 1.2/1.3 fixtures, old/new interop, policy migration, revocation, reconnect, and rotation suites |
| Chromium corpus                             | Landed and wired: F1/F2/F3/F7/F8/F10/F14/F16/F17/F19 browser scopes pass                                      |

That table is deliberately honest: an auditor should know which evidence exists today and the
limits of each item. Every row is landed, and none of them is a deliverable the auditor is being
asked to produce. Landed automated evidence is not an external audit and does not satisfy the
separate audit gate in §14.1.

The adversarial row is split into two lines for a reason worth stating before an engagement is
sized: 128 cases is the size of the adversarial suite, not the size of the harness-driven evidence
inside it. §14.1's requirement that the suite run against an attacker-controlled relay harness is
discharged by section K, which is 16 of those cases; the rest predate the harness and pass records
between endpoints by hand. That is the right shape for most of what §14.1 enumerates — key and
suite-list substitution, tier and pattern confusion, transcript and context-commitment mismatch,
role escalation and reduction, cross-account splice, node-fingerprint substitution, mode-lock
violations, and key-material validation are properties of a **value**, and a schedule adds nothing
to a value — and the wrong shape for the seven the schedule does change: replay, reorder and gap,
implicit-finish abuse, the §9.4 rekey boundary, the §10.2 simultaneous branch, a §11.3 error record
the relay simply keeps, and the §8.6/§13.6 authorization withdrawal — which is a **race** rather
than a value, since the window between the client minting its first envelope and the node
authenticating it is one the relay widens for free by holding the frame. Those seven are what
section K drives.

**F15, precisely.** The corpus holds the four applicable vectors — the `Noise_IK_25519_ChaChaPoly_SHA256`
and `Noise_NX_25519_ChaChaPoly_SHA256` entries of the published cacophony (Haskell) and snow (Rust)
vector sets, transcoded verbatim, with each source repository, commit, retrieval URL, and upstream
file SHA-256 recorded in the file's `provenance` array and the family file's own digest pinned both
in `manifest.json` and as a literal in the suite. All four pass: every handshake message byte for
byte in both directions, both cacophony handshake hashes, and every post-handshake transport message
under the `Split()` outputs. Those transport messages are what pin `Split()`: the sets publish no
split keys, but each transport ciphertext is produced under one of them, so reproducing them pins
both outputs and their §6.5 order.

Because cacophony and snow are independent implementations in different languages, F15 checks
identical static keys, ephemerals, prologues, and payloads against both implementations. The
test-only Rust crate at `packages/shared/test/independent-e2ee/snow` closes the protocol-input gap:
Snow 0.9.6 consumes the generated F6 IK and F7 NX §8.4 prologues and §8.5/§8.7 payloads, then checks
both messages byte for byte, payload recovery, the standard Noise handshake hash, and both raw
`Split()` outputs. Its exact upstream tag, commit, archive digest, dependency lock, and dual-license
provenance are recorded beside the harness.

The bounds matter. Snow's fixed-ephemeral and raw-split APIs are test-only and must never enter
production. Snow does not expose `ck_final`, so this harness cannot independently calculate Ryco's
exporter or validate server confirmation, epoch ratchets, record protection, CBOR carriers,
certificates, authorization, timeouts, or downgrade policy. A separate import-isolated,
straight-line TypeScript composition checks `ck_final`, the exporter, canonical CBOR, record
protection, ratchets, P-256 validation, and the production maximum fixture without importing any
production `relayE2ee*` module. That composition is useful differential evidence, but it is
first-party reference code and is not represented as an independent implementation.

**What the landed suite already pins**, all as exact byte literals so that any change to a token
order, a DH argument, the nonce encoding, the HKDF chain, a protocol name, or the exporter label
fails a test:

- Byte-exact golden transcripts and all three session values for both patterns, cross-checked
  against a straight-line transcription of the revision-34 pseudocode written independently of the
  module under test. The static keys are the published RFC 7748 §6.1 X25519 test vectors, so a wrong
  curve or a wrong encoding shows up immediately.
- The Noise cipher-nonce encoding, the reserved `2^64 − 1` value, the exporter label and derivation.
- Ordering: operations neither party owes, second writes, second reads, `split()` before both
  messages, and single-use behaviour after both `split()` and `destroy()`.
- The all-zero X25519 abort in three distinct positions (IK initiator against a low-order responder
  static, NX initiator against a low-order responder ephemeral, IK responder against a low-order
  initiator ephemeral).
- Handshake aborts on a mutated ciphertext byte, a truncated message, a message beyond the Noise
  bound, a prologue disagreement, and a wrong responder static.
- Role and key-material preconditions, erasure of ephemeral secrets at `split()` and `destroy()`,
  non-mutation of caller buffers, determinism, and re-derivation of every session value when a
  single ephemeral changes.

The golden transcripts explicitly do **not** discharge §14.1's official-vector obligation; they are
a first-party cross-check, and the official vectors are family F15 of the §16 corpus, described
above.

**The property suite, precisely.** `relayE2eeNoiseProperties.test.ts` holds 24 properties in seven
groups, run under `fast-check` with a fixed seed recorded in the file header, so a failure on CI
reproduces byte for byte with no extra flags. It quantifies over what the enumerated suite can only
sample. Message ordering is checked against a model of the module's own status across arbitrary
interleavings of `writeMessage`/`readMessage`/`split`/`destroy` on a real initiator and a real
responder, with the bytes between them chosen adversarially (the peer's genuine message, the party's
own message reflected back, an empty buffer, a corrupted copy) — the property is that no generated
sequence reaches `split()` except through the pattern's exact legal order over authentic bytes, and
that two ends that both split always agree. The two failure classes of section 5 question 1 are
separated as properties: any number of precondition refusals leaves a handshake completing normally,
and every operation after a handshake is spent — by `split()`, by `destroy()`, or by a processing
failure — is refused. Mutation and truncation are stated in the only form that is true for both
patterns without assuming AEAD unforgeability, since an NX message-1 payload is cleartext and a
mutated one is legitimately read: no mutation and no truncation of any handshake message may leave
the two ends holding the same session keys. In practice the NX cleartext read only **defers** the
refusal by one message — message 2's `s` token is AEAD-protected under the diverged `h` — so on
every generated case one of the two ends refuses, and each of those properties counts the runs in
which neither did and fails if that count is ever non-zero. The remaining groups cover role symmetry
(both roles reaching one handshake hash and one `Split()`), prologue binding (stated where it
actually lives — in `h`, not in `ck`, which is why a fixed key set under two prologues yields the
_same_ `Split()` outputs and a differing handshake hash), the IK pre-message static, key-material
bounds, the exporter as a pure confined function of `ck`, and the Noise §5.1 nonce encoding against
an independently written little-endian reference.

Three things about that suite are worth stating rather than leaving to be inferred, because each is
a bound on what it proves:

- **Erasure is asserted on a buffer where a buffer is reachable, and only there.** The injected
  test-only ephemeral is the one piece of private key material the module adopts from a caller, so
  three properties watch the caller's own bytes go to zero — over every prefix of a handshake, on a
  fatal read taken before the ephemeral was generated, and on a fatal read taken with it live in
  `#e` — and a fourth watches a refused constructor leave the same buffer untouched. The handshake
  hash is watched through `testOnlyHandshakeHash`, which reports the erased state by reading `h` and
  finding it all-zero rather than by consulting a status flag. The chaining key, the handshake
  cipher key, and the module's defensive copy of the static agreement secret are **not** observable
  from outside the module and nothing in this repository proves they are zeroed;
  `NoiseSymmetricState.erase()` and `#eraseSecrets` each zero their buffers in a single call that
  also covers an observable one, and section 5 question 4 asks the auditor to confirm the rest by
  reading the code.
- **The chaining key is proven un-extractable even so.** One property reads every accessor the class
  publishes after `split()` and checks each against the three §6.5 outputs, against the handshake
  hash captured while the handshake was live, and — because `ck_final` is never handed to a test —
  against `ck_final`'s consequence: any 32-byte buffer that reproduces `exporterSecret` under
  `e2eeNoiseExporterSecret` **is** the chaining key, whatever the accessor returning it is called.
- **Nonce _progression_ is not proven here, and cannot be.** §14.1 asks for "nonce-progression
  properties" and this group covers the encoding and its injectivity only. Every AEAD invocation in
  both patterns runs at counter 0, because each is preceded by a `MixKey()` that resets it, and both
  parties perform the same operations in the same order — so an implementation that dropped Noise
  §5.1's reset stays in lockstep with its peer and completes every handshake. What pins the reset is
  the F15 official vectors, which are byte-exact; what pins the §9.3/§9.4 record-layer counter and
  epoch progression is `relayE2eeSession.test.ts` and `relayE2eeWire.test.ts`, over a different
  nonce (`epoch ‖ counter`, big-endian) in a module outside this audit target.

**The hostile-relay harness, precisely.** `relayE2eeAttackerRelay.test.ts` runs two complete
endpoints — record session and close machine — against each other with the relay between them, and
its final section replaces the hand-carried delivery of the earlier sections with a relay that
**owns** delivery: frames are captured into a queue nothing drains on its own, and each §2.1
capability is one operation — hold and release later, drop, reorder, duplicate (release the same
held frame twice), modify (which subsumes truncate and restamp), reflect, and inject bytes no
endpoint produced. The §8 negotiation records are **not** scheduled: `establishHostile` runs an
honest §8 exchange by handing hello and accept straight between the two handshake objects and then
attaches the live endpoints to the relay, so the harness carries §9 records and §10 close records
only. §8 admits no schedule anyway — it is two records long and §8.1 allows one attempt per channel
— and the substitution and duplication attacks on those two records are hand-carried cases that say
so in their titles. The harness adds no key material; cases needing a record that is authentic but
non-conforming still say so and still mint it from a peer's own keys. What the schedule buys over
value mutation is the second half of each attack: the withheld record released into the erasure the
overtaking one caused, the same across a §9.4 rekey boundary, the duplicate landing after the peer
moved on, the genuine implicit finish released after an injected record spent the node's session, an
ack held past `T_CLOSE` and released after the verdict, the §10.2 simultaneous branch driven through
all four orderings of the two closes and the two acks, an owner withdrawal landing strictly inside
the §8.6/§13.6 re-read window because the relay held the client's first envelope open, and — the
case only a schedule can state — the relay **keeping** the single §11.3 `E2EEError`, which leaves
the two ends in the asymmetric state §10.4 resolves as an unattributed **Unclean — abrupt** rather
than in one either side can be walked out of.

**One accessor exists only for F15.** `E2eeNoiseHandshake.testOnlyHandshakeHash` returns the Noise
§5.2 handshake hash of a live handshake and `undefined` once `split()` or `destroy()` has erased it.
Nothing in the protocol consumes `h` — §6.5 fixes the three extractable values and requires the
handshake hash to be erased, and §8.7/§8.8 hash exact wire bytes instead — but the cacophony vectors
publish a `handshake_hash` per vector and `h` is unobservable through every other surface here,
since the `Split()` outputs and the exporter all derive from `ck`. The accessor is the only way that
field could be checked rather than silently dropped. It derives its `undefined` from `h` **itself**,
by reading the buffer and finding it all-zero, rather than from the handshake's status — which is
what makes the `undefined` both suites assert a witness of the §6.5 erasure rather than of a state
transition an implementation could reach with the symmetric state still live. An auditor should
confirm that no production path reads it, and that a live `h` is never all-zero.

## 7. Practical notes

**Repository.** `https://github.com/sak0a/ryco` — public, MIT licensed, a Bun monorepo. Everything
named in this document is in the public repository; no private infrastructure is involved in the
audit.

**Build and test.**

```sh
bun install --frozen-lockfile
bun run test                       # whole repository (Vitest)
bun run --cwd packages/shared test # the module's own suite
bun typecheck
```

Use the Bun version pinned in `package.json` (`packageManager`, currently `bun@1.4.3`). Never invoke
`bun test`, which runs Bun's own runner instead of the configured Vitest setup and will not execute
these suites.

**Minimal reproduction environment.** The module is pure computation: no clock, no network, no
filesystem, no database, no build step of its own. Its complete closure is the file itself, two
intra-repo imports (`relayE2eeConstants.ts` for the §3.2 sizes, and two pattern constants and a type
from `relayE2eeTranscripts.ts`), and the three noble packages. An auditor who prefers to work
outside the monorepo can copy those files into a bare Bun or Node project with the three pinned
dependencies and run the state machine standalone; nothing in it requires the rest of Ryco to exist.
Deterministic handshakes are available through the module's test-only ephemeral injection, which is
the same mechanism the §16.1 fixture generator uses.

**Reporting.** Findings anchored to specification section numbers are the most useful form, since
every rule this module implements has one.

## 8. Readiness

**The package is prepared; no independent audit has been commissioned or completed in this
workspace.** The state machine was written before the
implementation phases that exercise it, and it has now been driven from both directions: the node
responder (`apps/server/src/hubConnector/NodeE2eeChannelSession.ts`) and the client initiator
(`packages/client-runtime/src/relay/relayE2eeInitiator.ts`) both complete real IK handshakes against
it, and the §16.3 corpus is generated through it. That was the point of auditing after those phases
rather than before: an audit commissioned now is auditing the code that ships. Nothing in the
handshake logic has changed since the client and node work landed. The one edit since is inside
`testOnlyHandshakeHash`, which now reports erasure by reading `h` instead of by reading the status
flag — a strictly stronger witness of the same rule, described in section 6.

**The §14.1 automated-evidence obligations are now landed** — official vectors, protocol-input
cross-implementation replay, the property-based state-machine suite, and the adversarial suite
driven through a hostile-relay harness, all described in section 6. None was ever a deliverable the
auditor was asked to produce; they are the evidence the engagement is read alongside, and an
auditor should find them in the tree rather than be told they are coming. Landed is not the same as
exhaustive, and section 6 states each bound where it applies: Snow cannot expose `ck_final` or the
Ryco exporter; the harness drives 16 of the adversarial suite's 128 cases and the §8 negotiation
records do not cross it; erasure is asserted on a buffer for the ephemeral and the handshake hash
and by code reading for the chaining key, the cipher key, and the static copy; and §14.1's
nonce-progression obligation is discharged over the encoding here and over byte-exact transcripts
in F15 and F6/F7.

What the audit gates, precisely: §14.1 makes it a precondition for flipping the `requireE2EE`
default (§12.3), and the account-enrolled rollout additionally keeps broad suite-`0x02` enablement
behind the extension review above. Automated evidence is not an external audit. Broad default
enablement remains blocked until an independent reviewer closes high-severity findings and the
affected evidence is rerun. Current gate status is recorded in
[`relay-e2ee-rollout-readiness.md`](./relay-e2ee-rollout-readiness.md).
