# @ryco/mobile

The Ryco iOS-first native app (Expo / React Native), consuming
`@ryco/client-runtime`. It ships the scaffold, platform adapters, direct-node
bearer pairing loop, and full-screen native Hub identity gate.

The workspace mounts only after a Hub session is revalidated or a saved direct-node credential can
be read. Native identity v2 remains unavailable unless the selected Hub explicitly advertises the
complete capability. Email-first signup, passkey/password login, second factor, reset, recovery,
and recovery-code custody stay inside the native gate; browser cookies are never adopted.

## Prerequisites

- The repo's pinned Bun (`bun --version` must match `package.json`'s
  `packageManager`) and `bun install --frozen-lockfile` from the repo root.
- Xcode + an iOS 18 Simulator (native modules; **Expo Go is not supported** —
  a dev client is required).
- A reachable Ryco node (a local desktop node or a staging node) on the same
  LAN / tailnet. The scaffold ships the ATS local-network entitlement.

## Agent-runnable gates (CI-independent)

These run without driving the Simulator:

```sh
bun install --frozen-lockfile
bun run --cwd apps/mobile typecheck        # tsc --noEmit
bun run --cwd apps/mobile test             # vp test run (NEVER `bun test`)
cd apps/mobile && APP_VARIANT=development ./node_modules/.bin/expo config  # config resolves
```

A native `expo prebuild` / EAS `--local` build additionally needs Xcode + the
CocoaPods toolchain (see the runbook below); it cannot be validated in a
headless CI container.

## Launch the dev client + connect to a local/staging node (owner, on a Mac)

Simulator QA uses the development client. Hosted identity uses native DPoP-mint
routes; the custom scheme remains for verified-email and reset links.

1. **Install deps** (repo root): `bun install --frozen-lockfile`.
2. **Prebuild the native iOS project** (first run, or after native-dep/plugin
   changes): `cd apps/mobile && APP_VARIANT=development bun run ios:dev`.
   This runs `expo prebuild --clean --platform ios` and `expo run:ios`, building
   the dev client into the Simulator. A physical device can use a free Apple
   Personal Team — set `RYCO_IOS_PERSONAL_TEAM=1` and
   `RYCO_IOS_PERSONAL_TEAM_BUNDLE_ID`. This omits associated-domain
   entitlements but still supports Hub sign-in through
   `ryco-dev://hosted/complete`; no paid Apple Developer membership is required
   for development.
3. **Start Metro** (if not already running): `bun run --cwd apps/mobile dev:client`.
4. **Start a Ryco node** on the LAN/tailnet and open its pairing screen to
   produce a pairing URL (`ryco://pair?host=…#token=…`, or an
   `https://…/pair` link). The token is single-use.
5. **Pair** in the app: open **Add a machine**, paste the pairing URL, and tap
   **Pair**. The app exchanges the credential for a bearer session token
   (`/api/auth/bootstrap/bearer`), stores it in the iOS Keychain (SecureStore),
   and upserts the environment into the catalog. That upsert fires the
   environment-connection driver: the supervisor opens the live WebSocket with a
   freshly issued ws-token (`/api/auth/ws-token`), subscribes the node's shell
   stream, and syncs it into `state/threads`.
6. **Verify the loop** (the B1 runtime acceptance):
   - **Pairing** shows `paired to <node label>`; **Socket** reaches `connected`.
   - The **thread list** populates from the node stream.
   - Background the app, then foreground it: the connection reconnects. The
     supervisor's `subscribeBrowserResume` seam is bound to RN AppState, so every
     background -> foreground transition re-drives reconnect for any connection
     whose heartbeat went stale while iOS suspended the socket.

## Relay E2EE runtime acceptance (owner, on a physical device)

The relay E2EE protocol (`docs/relay-e2ee-protocol.md`) puts three requirements
on the mobile runtime that no Node test can discharge, because Hermes is the only
engine the app ships and no Node test runs on it:

- §14.5 randomness. Hermes has no `crypto.getRandomValues`, and the pinned
  primitives capture `globalThis.crypto` when their module evaluates — so the
  adapter has to be installed before the first import, not checked later.
- §3.6 canonical CBOR. `cborg` builds a `TextEncoder` at module scope, and React
  Native provides none. Its string codec builds a `TextDecoder` at module scope
  too — Expo's winter runtime supplies that one — and `encode.js` imports it, so
  encoding a transcript needs both.
- §14.2's curve, AEAD, and hash implementations, which are BigInt- and
  typed-array-heavy pure JavaScript.

**There is no Detox/Maestro/e2e infrastructure in this repository.** The evidence
below is this written procedure plus the development-only in-app runner
(`src/devtools/e2eeVectorRunner.ts`), run by the owner on hardware. The embedded
smoke suite remains **partial** evidence. A bounded side-load entry point now
allows selected corpus families to run without entering the app bundle, but a
recorded complete-corpus pass on both physical platforms is still the §16.4
release gate (see below).

### Procedure

1. Build and launch the **development** variant on a **physical device** — not
   the Simulator, whose entropy and native module hosting are the Mac's:
   `cd apps/mobile && APP_VARIANT=development bun run ios:dev`, with
   `RYCO_IOS_PERSONAL_TEAM=1` and `RYCO_IOS_PERSONAL_TEAM_BUNDLE_ID` set for a
   free Apple Personal Team.
2. **The app reaching its first screen is itself step 2.** `polyfills.ts` runs
   before `expo` and before `react-native/Libraries/Core/InitializeCore`; it
   reaches `expo-crypto` through a lazy `require` inside the installed function
   precisely so it does not pull `expo-modules-core` in that early. A white
   screen or an immediate native crash on launch is the signal that the ordering
   broke — check it here rather than assuming it.
3. Open the JS console for the running app (Metro's dev menu → **Open debugger**,
   or `j` in the Metro terminal — the JS keeps running in the device's Hermes,
   which is the point) and run:

   ```js
   await __rycoRunE2eeVectors();
   ```

4. Expect `ok: true` and five `ok: true` checks:

   ```
   { ok: true,
     checks: [ { name: 'runtime globals (§14.5)',           ok: true },
               { name: 'F15 Noise IK vector (§14.1)',       ok: true },
               { name: 'F6 record protection (§9.1)',       ok: true },
               { name: 'F4 node prekey certificate (§7.3)', ok: true },
               { name: 'X25519 agreement keygen (§6.2)',    ok: true } ],
     globals: { csprng: 'adapter', textEncoder: 'adapter' } }
   ```

5. **Record `globals`.** `adapter` means this app installed the implementation;
   `platform` means the Hermes build already had one. Which of the two Hermes
   provides is not knowable from the checked-in tree, and this line is the only
   place the answer is observed. Report it with the run.
6. If `runtime globals (§14.5)` is `false`, **every later case is `false` too and
   none of them ran**: §14.5 is fail-closed, so a runtime the preflight has
   condemned gets no handshake and no key generation, not even diagnostic ones.
   The suite reports the verdict and nothing else on purpose — the values that
   would explain it are key material. Separate the causes from the console
   directly:

   ```js
   typeof globalThis.crypto?.getRandomValues; // "function", or nothing is installed
   typeof globalThis.TextEncoder; // "function", or canonical CBOR cannot load
   typeof globalThis.TextDecoder; // "function", or canonical CBOR cannot load
   crypto.getRandomValues(new Uint8Array(32)); // throws, or comes back all zeros
   ```

   An all-zero return is `expo-crypto`'s native call silently no-opping — the
   failure that asserting the function merely _exists_ would have missed. A throw
   usually means its native module is not registered in this build. If a later
   check is `false` while this one passes, the primitives disagree with the
   corpus on Hermes; capture the failing case name and stop — do not ship E2EE.

### Side-loading selected corpus routes

The development hook also installs `__rycoRunSideloadedE2eeVectors`. The caller,
not the app, supplies raw manifest JSON, its independently transported SHA-256,
raw JSON for only the selected families, and exact fixture IDs. For example:

```js
await __rycoRunSideloadedE2eeVectors({
  manifestJson,
  manifestSha256,
  families: [
    { file: "f06-ik-handshake.json", json: f06Json },
    { file: "f07-nx-handshake.json", json: f07Json },
  ],
  fixtureIds: ["F06/ik-handshake-complete-trace", "F07/nx-handshake-complete-trace"],
});
```

The hash covers the exact UTF-8 bytes in `manifestJson`; each family is likewise
checked against `manifest.files[file].sha256`. The runner then requires the
fixture ID, file, case name, and `mobile-dev-sideload` runner to agree with an
explicit `portableExecution.routes` entry. It accepts at most 2 MiB of JSON in
total, 256 KiB per family, 32 families, 64 cases per family, 512 cases total,
128 UTF-8 bytes per fixture ID, and 16 KiB per ordinary decoded byte string.
The manifest reserves 4,194,304 bytes for recipe payloads. Corpus v1 uses one
bounded fill recipe for the reference-only F1 production-maximum case; no
`mobile-dev-sideload` route uses a recipe. The mobile runner therefore refuses
every `$recipe` object until a mobile-routed recipe and oracle are specified.

Admission failures expose one fixed error and no input. Admitted execution
returns only `[{ fixtureId, ok }]`; it never returns fixture bytes, hashes, key
material, decrypted payloads, or primitive errors. A `false` result is a release
gate failure. The hook has no file/network loader and persists nothing, so the
operator must transfer these strings through the development debugger or an
equivalently local development-only channel. Preview and production variants do
not install either vector hook.

### What this does and does not prove

It **does** prove, on the shipped engine: that the §14.5 source is installed
early enough and returns real bytes; that a full Noise IK handshake reproduces a
published upstream vector at both roles; that a §9.1 record protects to the exact
corpus envelope, round-trips, and rejects a one-byte tamper; that a §7.3
transcript re-encodes to bytes a strict Ed25519 signature still covers; and that
X25519 keygen off the live CSPRNG produces consistent, non-repeating keys.

It does **not** prove:

- **The production binary.** The runner is absent from a release bundle by
  construction — its only reference sits behind `if (__DEV__)`, which Metro folds
  away before it collects dependencies. What a development build shares with
  production is the code that matters: `polyfills.ts` and
  `src/platform/e2eeRuntime.ts` are the same source, and the primitives are the
  same pinned packages.
- **Any live channel.** There is no relay, no node, and no Hub in this procedure;
  it is the primitive and codec layer only.
- **§16.4's device gate.** §16.4 requires the **complete** corpus to pass on
  physical devices on **both** mobile platforms before the native client ships
  E2EE support, and calls it an explicit acceptance gate of the native rollout.
  The default smoke run still carries only four transcribed families (F15 IK,
  F6, F4, F13 — the corpus is not bundled, and `e2eeVectorRunner.test.ts` proves
  those bytes match). The side-load path covers the manifest-selected portable
  primitive cases without changing that bundle boundary, including IK, NX,
  canonical-CBOR rejection, and P-256 validation. It does not turn manifest
  exclusions into runnable tests, prove that every selected route passed on
  hardware, or supply the state-machine/UI/platform oracles those exclusions
  name. Green from only the embedded smoke run or a selected side-load therefore
  does not satisfy §16.4. **The recorded complete-corpus gate remains open and
  blocks the native E2EE rollout.**
- **Anything about Android.** Run the same procedure per platform.

§14.5's startup verification is no longer open: `src/platform/e2eeAgreementKey.ts`
runs `assertE2eeRuntimeGlobals` before **every** operation that produces or uses
this device's static X25519 key — creating it, deriving its public half, and
lending the scalar to a handshake — and turns a refusal into
`agreement_key_runtime_unavailable`, with no key created and nothing written.
Gating creation alone would have verified the source on the one launch that mints
the key and on no other, so a runtime that lost its CSPRNG between launches would
have kept issuing §7.4 certificates and discovered the absence mid-handshake.
Destruction is the one ungated path: §6.3's purge must still run on a runtime
E2EE is refused on. The handshake that reaches this custody path — and the screen
state that surfaces the refusal — lands with the mobile E2EE client; until then
no launch calls it.

**§13.1.1's partial-loss surface is closed**, by the second of the two remedies
§13.1.1 offers rather than the first. The §7.4 certificate record no longer lives
in the plain KV: `src/platform/e2eeSecureStore.ts` holds it in the §6.3 namespace
beside the agreement key it names, so iOS iCloud backup and Android Auto Backup
carry neither and an OS migration to a new handset destroys both together. There
is then no "non-secret application state recording a prior E2EE association" to
survive the secure store, and §13.1.1's own rule applies instead — "a conforming
client that keeps none is a fresh install by the rule above". The record is not a
secret and never was; the class governs survival, not confidentiality. An entry an
earlier build left in the plain KV is removed once per process and never read.

One obligation the agreement-key slice created remains open:

- **The screen state for a refused runtime.** `agreement_key_runtime_unavailable`
  and `e2ee_prekey_custody_failed` have no owner-visible surface yet, because no
  launch calls this path.

## Relay E2EE client trust state (§12.1, §12.1.1, §13.1)

`src/platform/e2eeTrustModel.ts` is the §13.1 record model and the §12.1.1
classifier; `src/platform/e2eeTrustStore.ts` is their durable custody. Four
properties are structural rather than documented, because each of them is a
downgrade if it is only documented:

- **`verified` and `unverified` are separate types.** §13.1 states what an
  `unverified` record holds and that it holds "**no** verified fingerprint, **no**
  recorded continuity id, no accepted policy generation, no latch, and no approval
  state". Those fields are absent from the type, so a guard has no field to read
  first-contact display material out of, and the only constructor of a `verified`
  record is `promote`, which takes an owner decision whose minting re-derives the
  §13.4 safety number from **both** identity keys. A capability statement carries
  only the node's key, so "silently promote a self-signed first-contact key" has
  no code path.
- **A store that has not loaded cannot look like unset state.** The classifier
  consumes a four-variant snapshot — `latched`, `pinned-unlatched`, `none`,
  `unobtainable` — that is branded and constructible only from a completed load,
  and `unobtainable` classifies UNEXPECTED. There is no boolean anywhere in the
  classifier. This is §4.4's "MUST NOT treat unobtainable evidence as an unset
  latch or an unset marker", and the case it protects is the first channel after
  every cold start.
- **The §13.2 step 5 marker write is in the same durable write as the promotion.**
  The whole trust document is one secure-store entry, because neither platform
  store has a transaction across entries and §13.1 requires the two to be
  crash-atomic. The write is adopted in memory only after it lands.
- **Reconciliation runs from the classifier's own entry point.** §13.1 requires
  the marker to be reconciled against the pin set "before it evaluates any
  classification on that Hub origin", including for an install whose pins predate
  the marker, so `classify` does it rather than leaving it to a call site — and it
  is the only classification the store exposes. A synchronous snapshot accessor
  beside it skipped the reconciliation, and on the install §13.1's migration names
  it answered legacy-eligible branch (a) where `classify` answers `unexpected`.
- **The writer cannot produce a document the reader refuses.** `parseDocument`
  fails the whole document on one out-of-bounds field, which would take every pin,
  latch, consent and marker on the device to `unobtainable` permanently — and
  `accountId` and `nodeId` are Hub-issued (§12.1.1). Every write boundary bounds
  its own inputs against the reader's bound, an unbounded node id is dropped rather
  than refused because §13.1 makes it an untrusted hint, and `commit` re-parses what
  it is about to write as the backstop for a boundary anyone adds later.
- **A scoped forget never widens into a whole-namespace wipe.** Forgetting one node
  or leaving one Hub origin refuses over a document that will not parse, rather
  than removing it: the wipe clears `anyNodeVerified` for origins the owner never
  named, and §13.1 clears that marker only by "the explicit owner action that
  removes the last verified pin under that `hubOrigin`". Destroying an unreadable
  document is its own owner action.

Hydration slots into the ordered bootstrap in `src/hostedHub/runtime.ts`, before
the call that installs the relay socket factory. Cleanup is registered by hand in
two places, because no generic secret-wipe path exists: the Hub-domain change in
`src/features/settings/SettingsHubRouteScreen.tsx` clears everything recorded
under the origin being left, and `removeSavedEnvironment` in
`src/connection/environmentActions.ts` clears the records for the node the owner
forgot. Both registrations have their own tests, since nothing else would catch
one going missing.

Since S7 the record also keeps the **verified node identity public key** beside
its fingerprint. §13.2.1 situation 2 requires "the previously verified fingerprint
and safety number" beside the newly presented pair, and a safety number is not
recomputable from a fingerprint; §13.4 says the value itself "never travels in any
protocol message, log, or analytics surface" and that only the node's §13.2
pending-record copy is persisted. Keeping the public key — which the statement
carries in the clear, and which the fingerprint is a digest of — is what lets the
client recompute the display value on demand without persisting it. The field is
**required** on a `verified` record, on the same fail-closed reading as every
other promoted field: a document written by a build that lacked it does not parse,
and no build before this one ever wrote a `verified` record, because nothing
injected the §4.4 machine.

## Relay E2EE, on (§4.4 injection)

Native E2EE is on from S7. `src/hostedHub/runtime.ts` builds every hosted relay
socket with `resolveMobileRelayE2eeProvider()`, so every channel this app opens
runs the §4.4 mode machine. The timing problem is worth stating, because the
answer to it is a security decision rather than an optimisation:
`createRelaySocket` is **synchronous** and §4.4 requires the pin, the §12.1.1
classification, the device marker, and the owner's recorded consent to be
evaluable "before it has received any payload" — so `src/hostedHub/e2eeAttempt.ts`
resolves the attempt ahead of the socket, keyed by the exact `(hubOrigin,
accountId, nodeId)` it was resolved for, and re-primes on every selection change.

There are exactly three outcomes and only one of them is legacy:

- a resolved attempt for this selection gets the machine;
- a device that cannot build §8.5 credentials gets **no provider** — §6.3 admits
  "no software-key fallback and no degraded mode", so it has no E2EE, and §12.2's
  `legacy` label is applied to the channel in every surface;
- an attempt that is not ready yet gets a channel that closes **FATAL-PRE**
  without releasing anything. That is deliberately not a legacy channel: the thing
  that has not been read _is_ the classification, and §12.1.1 admits nothing into
  the legacy-eligible class on absent evidence.

The `undefined` case is asserted to be reachable only from a custody failure, and
the not-ready case is asserted to release nothing, in
`src/hostedHub/e2eeAttempt.test.ts`.

## Relay E2EE trust UI (§13.1.1, §13.2, §13.2.1, §13.3, §13.4)

`src/features/e2ee/e2eeTrustUiModel.ts` owns every decision and every string;
`src/hostedHub/e2eeSession.ts` is the projection of one channel's §13 state. Both
are free of `react-native` and of React, for the reason
`src/features/hostedHub/hostedAuthModel.ts` documents — the RN packages ship
untranspiled Flow the vp/node runner cannot parse, so anything decided inside a
`.tsx` is untestable. Two nested settings routes render them:
`SettingsNodeSecurity` (`settings/node-security`) and `SettingsNodeVerification`
(`settings/node-verification`), both pushes on both platforms.

Four properties are structural rather than documented:

- **One construction site for a §13.2 step 5 decision.**
  `mintE2eeOwnerVerificationDecision` is branded and re-derives §13.4 from both
  identity keys, which stops a token being forged; what stops a second screen
  minting one without an owner act is a scan —
  `e2eeTrustUiSurface.test.ts` fails the build if the identifier, or `.promote(`,
  appears anywhere under `src/` but the store and the one model. The action that
  reaches it is **absent, not disabled**, until the owner has said on that screen
  that they compared the number.
- **The status vocabulary is derived, never hand-written.** The §4.4 channel state
  is folded into `packages/client-runtime`'s
  `deriveHostedConnectionStatusText`/`…Indicator`, which gained a fifth bounded
  input and a `guarantee` member. `Encrypted` is the only status that carries
  `guarantee: "e2ee"`, and it is produced only by a channel that locked `e2ee`
  **and** resolved to a verified pin. The mobile side adds only the tone mapper,
  which reads that member and withholds the success token from a `legacy`
  channel — a green pill reading `Legacy` is §12.2's label wearing the verified
  session's colour. The input is **required** on every mobile status derivation
  (`deriveHostedSignInView`, `deriveHostedAccountView`,
  `deriveHubNodeSectionModel`) and supplied from `useMobileE2eeChannelStatus()`:
  an optional field with a benign default is how the whole vocabulary stayed
  unreachable in the shipped app while its unit tests passed.
- **The shared vocabulary now carries a web row, and this app cannot reach it.**
  `HostedE2eeChannelStatus` has a `web-unsigned` member — §2.2's _Web, unsigned
  ephemeral_ row, rendered `Browser encrypted` with `guarantee: "web"` — because
  a Hub that serves the browser's JavaScript can exfiltrate plaintext while
  completing a genuine handshake, so §2.2 and §2.3 forbid the web tier from
  spelling its channel the way this one does. §8.1's role/tier matrix makes this
  app the IK initiator, and `lockMobileE2eeChannelMode` emits only `legacy`,
  `verified`, and `unverified` — asserted in `e2eeSession.test.ts` across every
  exported publisher, so no path through this store reaches the member. The
  member forced two native edits, and the second is the one that matters.

  The first is an arm in `e2eeTrustUiModel`'s `claimFor`, which the exhaustive
  switch would not compile without. It answers `none`, which is **not** a
  neutral value: `none` renders "No connection", "There is no node connection to
  describe yet.", and a closed padlock, so it asserts disconnection. It is
  chosen anyway because an unreachable row has no owner-visible rendering and
  understating connectedness is the safe direction for whatever inherits it; a
  tier that ever gains a real web channel here gets its own `E2eeChannelClaim`
  member the way `legacy-no-custody` did.

  The second is a `web` arm in `hostedStatusTone`. The tone mapper is
  the one that matters: an `if (guarantee === "legacy")` chain silently absorbed
  the new member into the connected branch and handed §2.2's web row the verified
  session's success token, differing from `Encrypted` by a noun and nothing else.
  It now decides from `guarantee` exhaustively, `web` takes the informational
  token, and the success rule is stated positively — connected, and `none` or
  `e2ee` — so the next guarantee added is a compile error rather than a default.

  **There are now two readers of `guarantee`, in two apps, and each is separately
  exhaustive over it.** `hostedStatusTone` here chooses this app's tone token;
  `hostedConnectionStatusPresentation` in
  `apps/web/src/components/hostedHub/HostedConnectionControls.logic.ts` chooses
  the glyph and colour every hosted web surface draws, for the same §2.2 reason
  and after the same defect (a chain keyed on connectedness gave §12.2's
  plaintext fallback the locked channel's green connected icon). A member added
  to `HostedConnectionGuarantee` is a compile error in BOTH — neither has a
  default arm — so fixing only the one named here ships a half-decided member.
  The two ladders are deliberately not shared: a native token vocabulary and a
  web Tailwind colour are different alphabets, and what §2.2 constrains is that
  each keeps its own three claims distinguishable, which each app asserts in its
  own suite.

- **Every guard is re-resolved on every owner decision.** The prepared §4.4
  attempt is keyed on the selection **and** on `mobileE2eeTrustStore.revision()`,
  which the store bumps on every commit. §13.2 step 5's promotion, §13.3's
  re-pair and §12.1.1's consent change the pin, the latch, the class and the
  marker without touching the account or the node, so a slot keyed on the
  selection alone kept serving pre-decision state for the rest of the session.
- **§13.1's release gate lives in the mode machine, not in the caller.**
  `relayE2eeInitiator` refuses the `e2ee` lock to any **native** attempt that
  resolved to no verified pin (§11.2 P21), so a node that still holds an approval
  for a device whose pin was never verified — or was cleared — cannot open an
  application session. It is deliberately not folded into `pairingOnly`, which
  closes the plaintext valve too: §12.1.1 branch (a) still lets genuine first
  contact reach a non-E2EE node through rows K9/K13.
- **Four messages, never one.** §13.2.1's three situations and §13.3's identity
  change are four distinct strings, asserted distinct; situation 3 is asserted not
  to be worded as an identity change, and situation 2 is the only one that renders
  the previously verified pair beside the newly presented one.
- **The §13.1.1 indication has no dismissal.** It is an `accessibilityRole="alert"`
  card with no dismiss affordance and no timeout, modelled on
  `HostedDeliveryUnknownNotice`, and it is shown whenever the marker is unset
  **or unobtainable** after reconciliation.

Still not in the app: `destroyUnreadableTrustState` has a model action and a
confirmation, but no screen passes `trustStateUnreadable: true` — the store
reports an unreadable document only by refusing mutations, and there is no
synchronous probe. A device whose document will not parse therefore still stays
`unobtainable` (every classification UNEXPECTED) until the owner leaves the Hub
domain, which is the existing scoped-forget path.

## Relay E2EE Phase 3 acceptance (owner, on a physical device)

This is the run that decides whether the native tier's §13 behaviour is real. It
needs a **physical device** and a **real node** on the LAN/tailnet; nothing in
this repository can execute it, and no Node test substitutes for it. Record the
outcome of every row.

Prerequisites: the development variant installed per the runbook above, a Ryco
node you control with its enrollment/pending-client CLI reachable, and a Hub
account with that node enrolled.

1. **Fresh device, unverified Hub (§13.1.1).** With no node yet verified, open
   **Settings → Security → Node security**. Expect the persistent
   _No verified node on this Hub_ card, with no dismiss control, and the channel
   labelled either `Legacy` or `Not verified` — never `Encrypted`. Confirm the
   card does not disappear when you navigate away and back.
2. **Enrollment-fingerprint-first pairing (§13.2).** Run the node's enrollment
   command and read its identity fingerprint. In the app, tap **Verify this node**
   and type it. Expect: a wrong value never advances and never shows a safety
   number; the correct value advances to the comparison.
3. **Safety number (§13.4).** Compare the twelve five-digit groups on screen with
   the number the node CLI shows for this client record. They must be **identical
   and in the same order**. Tick the acknowledgement, approve this device on the
   node with an explicit role and capability, then confirm on the device.
4. **A fresh channel is required (§13.2 step 6).** Do **not** expect traffic to
   start on the pairing channel. Background and foreground the app (or toggle the
   node selection) so a fresh ticket, channel, and handshake are made. Only then
   should the session indicator read **Encrypted**. Backgrounding alone re-opens
   the channel; the attempt behind it is re-resolved by the trust-store revision
   the promotion bumped, so no selection toggle is required for the new pin to
   take effect.
5. **Session indicator, on every surface.** Confirm the pill reads `Encrypted`
   and is the success colour on the **Hub node section**, the **hosted account
   screen**, and the sign-in surface, and that no surface reads `Legacy` for this
   connection. Then withhold E2EE (point the app at a node that runs no §4
   channel) and confirm every one of those surfaces reads `Legacy` in the warning
   colour rather than a green `Online`.
6. **Substituted node (§13.2.1 situation 2).** With one node verified under this
   account, point the app at a _different_ node under the same account (enroll a
   second node, or re-key the first so it presents a first-contact statement).
   Expect the situation-2 copy and the **side-by-side** fingerprints and safety
   numbers, _before_ any pairing step. Confirm no payload flows.
7. **Account-scope change (§13.2.1 situation 3).** Sign in under a second account
   on the same Hub. Expect the situation-3 copy, and confirm it does **not** say
   an identity changed and shows **no** previously verified fingerprint.
8. **Chain break (§13.3).** Rotate the node's identity by a mechanism that issues
   **no** continuity certificate. Expect the re-verification copy, the new
   fingerprint and safety number, and no payload to the new identity until a fresh
   §13.2 ceremony completes. Then rotate _with_ a valid chain and confirm that
   this one raises **no** prompt at all.
9. **Legacy consent (§13.2.1).** On an unexpected selection, confirm exactly two
   resolutions are offered, that neither is preselected, that dismissing the
   screen records nothing, and that the consent one carries its own confirmation.
10. **Reinstall (§6.3, §13.1.1).** Delete the app and reinstall it. Expect
    re-pairing to be required and the §13.1.1 card to be back. This is the check
    that the disclosure text is true. Leave the node's approval for the old
    client key in place: the device now has no pin, so §13.1's release gate must
    close the channel (`Not verified`, no project/conversation/terminal data)
    rather than opening a session against the surviving approval.
11. **Forget this node (§13.3).** With a node verified, tap **Forget this node's
    identity** and confirm. Expect the security screen to stop reading
    `Encrypted` **without leaving and re-entering it**, the §13.1.1 card to come
    back if that was the last verified pin, and the next channel to be release-
    gated rather than continuing under the pin that was just deleted.
12. **Vectors, both platforms.** Re-run the S1 `__rycoRunE2eeVectors()` procedure
    above on iOS **and** Android hardware and record `globals` for each.

**What this run does and does not prove.** It proves that a real node and this app
agree on the §13.4 value, that the §13.2 ceremony completes and gates payload,
that the four §13.2.1/§13.3 situations are distinguishable to an owner in
practice, and that the §6.3 custody class behaves on the two platforms. It does
**not** prove §16.4's complete-corpus device gate (still open, see above), does
not exercise a hostile Hub — every substitution above is one you staged yourself,
so it demonstrates the _presentation_, not the _detection_, of an attack — and
does not prove anything about the production binary beyond the code it shares with
the development one.

**What the app cannot tell you, and the copy does not pretend to.** Every §11.2
pre-key failure is byte-identical on the wire: one fixed-length reject plus
`channel.close(channel_rejected)`, with no cause and no code. So when a pairing
attempt ends, this app cannot distinguish _not approved_ from _revoked_, _rate
limited_, _my tier is forbidden_, _my clock is wrong_, or _my prekey expired_. If
step 4 does not reach `Encrypted`, the app will not say why — check the node's own
logs. The only causes the app names are ones it concluded about itself (§11.4),
and they are listed on the Node security screen under _On this device_.

## Relay E2EE key custody (owner, on a physical device)

`docs/relay-e2ee-protocol.md` §6.3 puts two requirements on the native client that
only a device can confirm. Both are implemented — see `src/platform/e2eeSecureStore.ts`
and `plugins/withAndroidSecureStoreBackupExclusion.cjs` — and neither is proven by
the Node suite.

- **iOS reinstall must destroy the E2EE keychain namespace.** Keychain
  generic-password items survive app deletion for the same bundle id, so the app
  writes a first-run marker into the plain SQLite-backed KV, which does not. Pair
  the device, delete the app, reinstall it, and confirm that re-pairing is
  required — not that the previous install's key is silently reused. The marker
  check runs before any read of the namespace, so nothing of the old material is
  loaded on that launch.
- **Android backup must not carry `shared_prefs/SecureStore.xml`.** These rules are
  the whole of Android's §6.3 compliance: `keychainAccessible` is an iOS-only
  option and the Android native module publishes no constants at all, so the
  store passes only `keychainService` there and there is no accessibility class to
  assert. The generated manifest and rules were verified from a real
  `expo prebuild --platform android` in this repository: `<application>` carries
  `android:fullBackupContent="@xml/ryco_e2ee_backup_rules"` and
  `android:dataExtractionRules="@xml/ryco_e2ee_data_extraction_rules"`, both files
  exclude the SecureStore preferences file from `sharedpref`, and
  `android:allowBackup` stays `true` so the environment registry and hub profile
  keep their backup. **A device check must still confirm the effect**, because a
  build artifact cannot: back the device up, restore onto a second device (and
  run a device-to-device transfer), and confirm the restored app has no E2EE
  agreement key and demands re-pairing while the ordinary saved environments come
  back. The rules exclude both `SecureStore.xml` and `SecureStore`, so this check
  also settles which spelling the backup engine honours.

## Notes / boundaries

- Expo Go is not supported because hosted sessions use Ryco's custom
  hardware-backed device-key module. Use the generated development client.
- Paid/team builds may enable associated domains for native passkey account
  actions. Core Hub sign-in does not depend on that entitlement: it uses
  `ASWebAuthenticationSession` / a Custom Tab, explicit browser consent, and a
  one-time PKCE code returned through the variant's custom scheme.
- Bundle IDs/schemes are Ryco placeholders (`dev.ryco.app*`, `ryco*`); the EAS
  project, Apple Team id, and App Store Connect record are wired in B3.

## Dependency divergences (B2)

- **`@pierre/diffs` is pinned to `1.3.0-beta.5` for mobile only** (deliberate
  divergence). The workspace catalog pins `1.1.20` (shared with `apps/web`); the
  upstream review/diff patch and the review-canvas code the screens copy were
  written against `1.3.0-beta.5`. `apps/mobile/package.json` pins the version
  directly (replacing `catalog:`); `apps/web` stays on the catalog's `1.1.20`
  untouched. This is a version split inside the existing dependency set — no new
  npm packages are added for the MVP screens.
- **`@pierre/diffs>@shikijs/transformers` override was NOT ported.** Upstream
  (pnpm) forces `@pierre/diffs`'s `@shikijs/transformers` to `^4.2.0`. Bun does
  not honor pnpm's `parent>child` scoped-override syntax, and a name-scoped
  override applies by name to _both_ `@pierre/diffs` copies — it would force
  `apps/web`'s `@pierre/diffs@1.1.20` (which declares `@shikijs/transformers:
  ^3.0.0`) to an out-of-range `4.2.0`, violating the "nothing else touching
  `apps/web`" invariant. `@pierre/diffs@1.3.0-beta.5` declares
  `^3.0.0 || ^4.0.0` and resolves `@shikijs/transformers@3.23.0`; that dependency
  is inert on the mobile code path (the native review canvas is fed the app's own
  `@shikijs/core@4.2.0` tokens, not `@pierre/diffs`'s HTML/transformer render
  path), so leaving it at its declared resolution is the faithful, web-safe
  outcome.
- **`expo-modules-jsi` patch rebased onto `56.0.12`.** Upstream keys the patch at
  `56.0.10` (its exact pnpm pin); B1's lock resolves `56.0.12`. The patch applies
  cleanly against `56.0.12`, so the `patchedDependencies` entry is keyed
  `expo-modules-jsi@56.0.12` (no exact-pin override needed). The patch file keeps
  its upstream `@56.0.10` filename.
