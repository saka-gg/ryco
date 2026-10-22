# Relay E2EE — §16.4 browser-suite coverage and what remains

`docs/relay-e2ee-protocol.md` §16.4 requires part of the §16.3 vector corpus to run in the web
browser test suite as well as under the repository's Node gate:

> Families exercising web-facing surfaces — F1, F2, F7, F8, F10, the admitted-pattern cases of F3,
> the `WebSAS` half of F14, the NX cases of F16, and the P-256 cases of F17 — MUST also run in the
> web browser test suite.

This note records exactly what runs in Chromium today, what does not, and why. It exists so any gap
is a tracked obligation rather than an omission somebody has to rediscover from the suite listing.

The complete browser scope is now wired. The generated manifest says `browserRun.state: "wired"`,
and `E2eeCrossRuntimeCoverage.browser.tsx` consumes the executable family/scope/consumer census in
`packages/shared/src/relayE2eeCorpusLiveness.ts`. That census deliberately does not pretend to be a
fourth reader in the Node-only leaf census: Chromium is a separate process, so inventing one union
would publish false liveness numbers.

## What runs in Chromium today

Every file is under `apps/web/src/components/hostedHub/` because
`apps/web/vitest.browser.config.ts` includes only `src/components/**/*.browser.tsx` — a browser
vector placed anywhere else silently matches nothing, and `vp test run` reports success over zero
matched files. A new vector file is only real once it appears by path in the run's own file list.

| Family                                   | Where                                                                                          | What it drives                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1 — payload discrimination and chunking | `E2eeCodecParity.browser.tsx`                                                                  | The §4.3 receive pipeline for all 12 cases carrying a wire payload, the §4.5 budget and both sides of the plaintext ceiling re-protected from the family's own §6.5 stand-in secrets, the chunked reassembly, and both prelude-headroom cases re-prepared through `prepareRelayMessage` at their own chunk limit.                                                                                                         |
| F2 — carrier compatibility (§5.5, §5.6)  | `E2eeCodecParity.browser.tsx`                                                                  | C1 through the assembler in both prelude states; C6 parsed by **Chromium's own** `JSON.parse`, with and without the prelude; the maximum carrier re-prepared at the §5.5 advertisement floor.                                                                                                                                                                                                                             |
| F3 — admitted-pattern cases              | `E2eeNxHandshake.browser.tsx`                                                                  | All five committed admitted-pattern cases: the require-approved encoder output, the identical IK-only statement as native (`K1`), web latched (`K2`/`P15`, buffered sends non-empty and none flushed), web unlatched (`K3`, labelled rule-level), and `["IK","NX"]` as web (`K1`).                                                                                                                                        |
| F7 — NX handshake and negative rules     | `E2eeNxHandshake.browser.tsx`, `E2eeMaliciousRelay.browser.tsx`                                | The exact committed complete trace is rebuilt through both deterministic production handshake halves, including both Noise messages, confirmation, session binding, all §6.5 secrets, implicit finish, and both first protected records. The responder-static substitution and nonempty message-1 payload are driven live too.                                                                                            |
| F8 — record protection (§9.1–§9.3)       | `E2eeRecordProtection.browser.tsx`                                                             | Every case, on a session established from the F6 trace's committed §6.5 outputs: both AADs and the nonce, both counter-zero-and-one traces re-protected byte for byte, and all six tampers through `unprotect`.                                                                                                                                                                                                           |
| F10 — complete mode machine              | `E2eeModeMachine.browser.tsx`, `E2eeNxHandshake.browser.tsx`, `E2eeMaliciousRelay.browser.tsx` | All 34 committed cases and all 57 committed byte leaves are loaded and pinned. Chromium re-derives every carried classifier decision, record direction/bound, P3/P24 partition, N9 authentication, N10 rejection, N1–N17 structure, §11 disposition, deadlines, fallback accounting, and advertisement diagnostics. The shipped Web client separately drives its `K1`, `K2`, `K3`, `K5`, `K10`–`K15`, and `P16` behavior. |
| F14 — the `WebSAS` half                  | `E2eeNxHandshake.browser.tsx`                                                                  | Both `web-sas-session-*` cases re-derived through the shared `@noble/hashes` HKDF/SHA-256 under Chromium's JS engine and byte-matched against the committed intermediates, plus §3.2.1 S11.                                                                                                                                                                                                                               |
| F16 — the NX cases                       | `E2eeCodecParity.browser.tsx`                                                                  | The web/NX context block's §8.3 commitment and both absence forms against the IK arm; the absence-semantics violation as `P13`; and the NX channel that no §13.6 withdrawal matches, beside the sweep that does.                                                                                                                                                                                                          |
| F17 — the P-256 cases                    | `E2eeCodecParity.browser.tsx`                                                                  | All nine rejected §7.1 public-key encodings plus the valid control, and all seven rejected signature encodings verified against F04's committed transcript through `verifyE2eeSignature`.                                                                                                                                                                                                                                 |
| F19 — Web account-grant isolation        | `E2eeAccountGrantIsolation.browser.tsx`                                                        | The exact valid native grant is delivered as hostile Web relay input. Web has only suite `0x01` and `{tier:"web"}` credentials, classifies the grant before grant decoding, emits no hello or buffered plaintext, closes, and leaves the DOM, URL, storage, IndexedDB, JSON parser, console, and relay free of grant bytes. Ticket/API and service-worker isolation have their own browser tests.                         |

Every family in the table reads the committed fixtures in `packages/shared/fixtures/e2ee/v1/`
directly through `apps/web/test/e2eeCorpus.ts`, including F10 and F19. Nothing in `apps/web`
regenerates or copies them, so §16.4's "a vector that produces different bytes on any supported
runtime is a release-blocking defect" is checked against the corpus and not against a second copy.

`apps/web/test/e2eeCorpus.ts` also carries the §9 session harness. F8 is the only family here that
cannot be checked from bytes alone — every case is a record protected or authenticated by a session
that already holds epoch secrets — and that is the whole reason it was deferred. The harness builds
one from a family's own committed secrets; F1's two boundary cases reuse it unchanged, differing
only in which family's secrets they hand over.

**No cross-runtime byte divergence was found in the required browser scope.** Every committed envelope,
AAD, header, nonce, authorization-context commitment, `WebSAS` intermediate, and reassembly it
recomputes reproduces in Chromium exactly as it does under Node. §16.4 makes a divergence
release-blocking; there is none to report, over the cases listed above and not over the corpus.

The §8.3 context BLOCK is not in that list on purpose: neither runtime re-derives it from its 18
elements. Both read the committed block and re-hash it, so what reproduces is the commitment over
those bytes and not the encoding that produced them. None of these runs uses a browser-supplied
primitive either — no E2EE path in this repository calls `crypto.subtle`, and WebCrypto does not
expose ChaCha20-Poly1305 at all — so the parity established is that the same `@noble` JS produces
the same bytes on Chromium's engine, not that a second implementation agrees with it. The genuinely
browser-supplied behaviour these files exercise is the DOM, `WebSocket`, `JSON.parse` (F2's C6 case)
and `TextDecoder`.

**None of this adds a security property the web tier claims.** §2.2 and §2.3 deny that tier any
operator-proof protection: the Hub serves every byte of the JavaScript, so it can complete a genuine
handshake, draw a genuine §13.5 `WebSAS`, and exfiltrate the plaintext regardless of which vectors
pass in which runtime. These families are correctness parity and nothing more. Read as a security
claim they would say something false.

## What remains

The browser obligation is closed. The remaining §16.4 gate is physical: the complete corpus must
pass on real iOS and Android devices before native E2EE ships. The repository has a portable mobile
runner and RN-realistic Node adapters, but neither is evidence that a physical-device run occurred.
The manifest therefore remains `browser-wired-physical-deferred`, and every named family repeats
that exact limitation. Device model, OS version, application build, corpus digest, result, and date
must be recorded by the native rollout; a simulator or Chromium pass cannot substitute for it.

F19's positive grant verification and full suite-`0x02` IK trace continue to run in shared/native and
node tests. Its Chromium scope is intentionally negative: Web must remain grant-free and suite
`0x01`-only. That isolation coverage does not upgrade the Web threat model.

## The web §13 surfaces: what is wired, and what is still owed

The web tier runs a §4.4 machine on every relay socket, publishes what that machine locked
(`apps/web/src/hostedHub/e2eeSession.ts`), and all three hosted connection surfaces — the desktop
thread connection badge, the phone connection sheet, and the pill — read it; the badge reads its
thread's node's own channel rather than the selection's. §12.2's "MUST label the channel **legacy**
in every user-facing surface" is therefore met in shipped code, and the browser render sweeps draw
`Legacy`, `Unsigned web`, and `Securing` like every other bounded status
(`apps/web/test/hostedConnectionVocabulary.ts` carries the §4.4 dimension).

The two §13.5 duties this note previously recorded as owed are now discharged:

| Duty                             | Where it is discharged                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §13.5 "Shown in the web UI"      | `HostedE2eeVerification.tsx` in the desktop thread connection popover, for that thread's node's own session, and `NodeSecuritySettings.tsx` in Settings → Security. `hostedE2eeVerificationView` (`HostedE2eeVerification.logic.ts`) returns the display groups, the display value, §13.5's advisory sentence, and the second sentence that goes with it as ONE object of four REQUIRED fields, taking a non-defaultable `placement` that selects the length — so a caller cannot draw the characters without the "cannot protect against the Hub operator, who serves this page" denial, and cannot pick a length that omits it. Both lengths also end on the residual denial ("a match does not rule out someone sitting in the middle"), which is the clause that survives an honest bundle and a trusted operator. A locked channel that reached the surface with no conforming code — the derivation is allowed to fail without costing the channel — draws the absence as a sentence rather than as nothing, so the display duty cannot fail open. |
| The relay trust notice's wording | `HostedRelayTrustNotice.logic.ts`. The claim is now a selector over the channel state, keyed on the tier-fenced `WebHostedE2eeChannelStatus`, so a new channel state cannot ship without a sentence. The `web-unsigned` copy states §2.3's web bullet and §2.4's served-code ceiling; the `legacy` copy is §12.2's mandatory label.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

The glyph and tone at all three connection surfaces now key on
`HostedConnectionStatusIndicator.guarantee` rather than on connectedness
(`HostedConnectionControls.logic.ts`). Both `legacy` and `web-unsigned` are usable sessions, so
keyed on `connected` they drew the identical green connected glyph — §2.2's "MUST NOT present a
stronger claim for a weaker configuration", arrived at through an icon.

**One §13.5 surface gap remains, and it is a scope ruling rather than an oversight.** The `WebSAS`
renders at two desktop surfaces — the desktop thread connection popover and Settings → Security,
which is where the popover's pointer leads (`docs/hosted-hub-client.md` documents both) — and at no
phone-tier surface. `AGENTS.md` freezes the `apps/web` phone tier — "Do not extend the web phone
tier" — and mounting a new block inside the phone connection sheet is a new phone-tier surface.
`apps/mobile` is the intended phone experience and ships the native §13 trust surfaces. Unfreezing
the web phone tier to add the `WebSAS` is a separate approved change.

The popover chooses between the two lengths on `settingsSectionReachable("security", …)`, the same
predicate the settings navs filter on: Settings → Security is owner-only in hosted mode, so a reader
who cannot open it is drawn the long form where they are rather than a pointer at a section their
dialog does not list.

**What makes the phone tier truthful is the copy, and that had to be fixed rather than asserted.**
This note previously claimed the phone tier "claims nothing the absent code would have qualified".
That was false as shipped: the `web-unsigned` disclosure told every reader on both tiers that a
malicious Hub "could serve code that … shows the same session code", which presupposes a comparison
value on the page. On the phone connection sheet there is none, so that sentence described a §13.5
affordance the reader did not have. The disclosure no longer refers to a session code in any state,
and `HostedRelayTrustNotice.logic.test.ts` scans all four bodies for the reference so it cannot come
back; the pointer at the ceremony now lives in `HostedE2eeVerification.logic.ts`, which renders only
where the characters do. Both tiers still carry the same state-keyed disclosure and the same
guarantee-keyed glyph, and the claim they carry is now one the phone tier can support.

## Still outstanding beyond this document

§16.4 also requires the COMPLETE corpus to pass on physical devices on both mobile platforms before
the native client ships E2EE support. That is a separate acceptance gate of the native rollout, is
not discharged by anything in this repository's automated suites, and is not what this note tracks.
The dated status and explicit rollout blockers are maintained in
[`relay-e2ee-rollout-readiness.md`](./relay-e2ee-rollout-readiness.md).
