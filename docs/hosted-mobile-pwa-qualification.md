# Hosted mobile PWA qualification

Use this checklist after a reviewed public build has been consumed by an authorized hosted
environment. It verifies installation and mobile behavior; it does not authorize deployment,
account changes, revocation, or other live mutations.

## Evidence boundary

Record only:

- immutable compatible web, service, and node revisions;
- device model, operating-system version, browser name, and browser version;
- pass/fail, UTC timestamp, and bounded duration for each check; and
- redacted screenshots of the home-screen icon, standalone chrome, and non-sensitive application
  surfaces.

Do not record account names, deployment URLs, node or grant identifiers, project names, source,
conversations, terminal output, credentials, cookies, tickets, proofs, session verification codes,
request bodies, relay payloads, or browser storage containing user data. Session verification codes
are ephemeral display state and must not reach evidence, including inside a screenshot: redact the
node menu rather than capturing one.

## Shared prerequisites

- [ ] The hosted build and repository gates are green at the recorded immutable revision.
- [ ] The manifest reports the expected relative scope/start URL, standalone display, theme, and
      conventional/maskable icons.
- [ ] The visible admission and installation paths state the relay-trust disclosure for the channel
      state actually on screen, in the words quoted in
      [Hosted Hub client](./hosted-hub-client.md) — including, before any node channel is open, that
      the Hub still forwards what you send in a form it can read.
- [ ] On a channel that negotiated encryption, the disclosure states the browser ceiling in the same
      breath as the claim: that the tab pins no node identity, and that it cannot protect against
      the Hub operator, who serves the page's code.
- [ ] Where a connected node's menu shows a session verification code — the desktop-width menu does,
      the narrow phone presentation does not — the accompanying text states that comparing it
      catches accidental wrong-node routing and some network interposition while the loaded code is
      honest, and cannot protect against the Hub operator who serves that code. Verify the wording
      only; do not record the code.
- [ ] Browser inspection shows the Ryco shell cache contains only the generated immutable allowlist
      and static offline document.
- [ ] Cache inspection finds no live HTML, API, RPC, relay, attachment, project, file, terminal,
      conversation, credential, ticket, request-body, or cross-origin response.

## iOS Safari

- [ ] Open the hosted page in Safari and complete the authorized browser sign-in and node-selection
      flow.
- [ ] Open the Share or browser menu, choose **Add to Home Screen**, enable **Open as Web App** when
      offered, and confirm **Add**.
- [ ] Launch Ryco from its home-screen icon and verify standalone display.
- [ ] At 320 CSS pixels or the device's narrowest supported portrait width, verify no page-level
      horizontal overflow and that primary controls remain reachable.
- [ ] Open the navigation drawer, select a representative thread, use the composer with the software
      keyboard open, and close the drawer without losing focus or context.
- [ ] Exercise a representative diff, approval, and terminal surface; horizontal scrolling remains
      contained within dense content.
- [ ] Rotate portrait to landscape and back without losing node, thread, draft, or panel state.
- [ ] Background and foreground the installed app. Mutations remain disabled until access and the
      current node snapshot are revalidated.
- [ ] Go offline and return online. The cached boot document contains no application data. With
      **Remember this browser** enabled, the page can display saved text from its encrypted local
      store; sending remains disabled and reconnect uses the normal fresh-session path.
- [ ] Verify a waiting update does not reload active work, then activate it with **Update ready**.

## Android Chrome

- [ ] Open the hosted page in Chrome and complete the authorized browser sign-in and node-selection
      flow.
- [ ] Use **Install Ryco** when Chrome offers it; otherwise use the browser menu and choose **Add to
      home screen** or **Install app**.
- [ ] Launch Ryco from its home-screen icon and verify standalone display.
- [ ] Repeat the narrow portrait, navigation drawer, software keyboard, diff, approval, terminal,
      rotation, background/foreground, offline/online, reconnect, and update checks from the iOS
      section.
- [ ] Confirm rejecting or dismissing the native install prompt leaves ordinary browser use intact.

## Authorization and failure behavior

Perform authorization-change checks only in an approved isolated or disposable environment.

- [ ] While the app is suspended, remove or revoke its test authorization through the supported
      administration path.
- [ ] Resume the app and verify that stale content cannot mutate node state.
- [ ] Verify session validation or directory refresh closes access and that reconnect is denied
      without manual browser-storage or database editing.
- [ ] Restore authorized test state through the supported workflow before continuing unrelated
      checks.
- [ ] Confirm a non-idempotent request interrupted at an uncertain boundary is marked **Delivery
      unknown** and is not automatically replayed.

## Decision record

- [ ] Both physical platforms passed against the same compatible revision tuple, or every mismatch
      is explicitly explained and requalified.
- [ ] Every failure has a bounded incident entry and owner; no unresolved reliability or security
      blocker is waived.
- [ ] The final record states pass or fail and links only redacted evidence stored in the approved
      evidence location.
