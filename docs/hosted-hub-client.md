# Hosted Hub client

Ryco's web application has an explicit `hosted-hub` mode for interoperating with a compatible Hub.
It is the same React client, RPC client, stores, and feature UI used by direct-browser and desktop
sessions. Hub mode changes authentication, scoped node acquisition, the WebSocket transport, and the payload
encryption layer carried inside that transport. The client presents cached work from every eligible
browser-accessible node as one [unified workspace](./unified-workspace.md); each Ryco node remains
authoritative for the physical projects, files, terminals, conversations, providers, orchestration,
attachments, approvals, and relay payloads it owns.

Sameness of client ends at that encryption layer, and this is the one place the difference matters.
The browser runs the **unsigned ephemeral** tier of
[relay payload encryption](./relay-e2ee-protocol.md) (Noise NX). Independently distributed Desktop
and mobile clients run signed native Noise IK: either locally verified suite `0x01`, or the automatic
account-enrolled suite `0x02` of that specification's §18. Everything in the browser sections below
is about NX and MUST NOT be read across to native clients. In particular, the browser never requests,
receives, decodes, stores, or forwards a native `HubDeviceGrant`.

This mode is separate from the hosted-static pairing client. It is opt-in and does not change direct
LAN, desktop-local, saved remote, or desktop-managed SSH behavior.

## Topology and configuration

Build the web application with:

```sh
VITE_RYCO_CLIENT_MODE=hosted-hub bun --cwd apps/web run build
```

A compatible Hub serves the resulting assets from its own public origin. The page, authentication
HTTP APIs, node directory, relay-ticket endpoint, and `/v1/relay/client` WebSocket therefore share
one origin:

```text
https://hub.example/
  web assets
  /api/auth/*
  /api/nodes
  /api/relay/tickets
  /v1/relay/client
```

That topology is required. Ryco does not add permissive CORS, alternate browser tokens, or a second
session format. The Hub's configured public origin and WebAuthn RP ID must cover the browser origin.
Hub continues to validate `Host` and `Origin`; WebAuthn validates RP ID; mutation requests carry the
Hub-issued CSRF value in `X-Ryco-CSRF`. Requests use relative paths, `credentials: "same-origin"`,
and `cache: "no-store"`. The browser never reads the HttpOnly session cookie.

For local development, set `VITE_WS_URL` to the local Hub backend as well as
`VITE_RYCO_CLIENT_MODE=hosted-hub`. Vite proxies `/api` and `/v1/relay` without rewriting the public
Host. Configure the Hub public origin/RP ID for that exact local browser origin. Do not use this
proxy arrangement to bypass production origin policy.

## Authentication and registration

Desktop and mobile builds default to `https://app.ryco.space`; compatible custom Hub profiles
remain supported. On macOS Desktop, **Connect Ryco account** starts browser authentication and
automatically enables the local node connector after the session has been durably stored. The
connector restart resumes the local claim and trusted introduction. Temporary local-node setup
failure does not sign the account out or grant unverified remote access.

A fresh Desktop workspace does not initialize Keychain credentials just to display the UI. Native
sign-in and restoration of a retained session still use protected storage. A locked store produces
a retryable failure rather than silently discarding the session. Development launchers keep mutable
checkout paths and environment outside their signed bundle and use a single available Apple
Development identity, falling back to ad-hoc signing when none can be selected unambiguously.
Production releases need stable Developer ID signing to preserve macOS trust across updates;
Ryco never changes Keychain access rules to suppress an operating-system prompt.

Native mobile authentication requires a hardware-backed device key. If the device cannot provide
one, setup explains the limitation and offers retry without falling back to a software key.
Node-level security details live under **Settings → Connections → Node security · Advanced**;
the existing owner and connection-readiness checks still apply.

Sign-in uses the existing Hub passkey options and verification endpoints. The client converts the
Hub's JSON WebAuthn options into the browser API and returns the standard WebAuthn response shape.
It does not create a bearer token or alternate transcript. Invitation redemption uses the existing
closed-invitation registration ceremony. A new Hub's first owner can explicitly select the bootstrap
flow and use the operator-provided bootstrap credential with the existing credential-gated WebAuthn
registration endpoints. The server remains authoritative for whether bootstrap is available; the
client does not probe or publish account state. Invitation secrets and bootstrap credentials are
submitted in an HTTPS request body, cleared from the form immediately, and never added to a URL or
browser storage. One-time recovery codes are memory-only and are cleared when dismissed.

Only the CSRF value is readable by client code, and it is kept in memory. Sign-out uses the existing
session-bound logout endpoint. A `401` or `session_invalid` result clears account, role, node,
transport, and Ryco-session state before closing every live environment channel. Duplicate or cancelled
ceremonies abort the earlier browser operation. Denial, malformed options/responses, expired
challenges, revoked sessions, and network loss surface bounded messages that do not reflect response
bodies.

### Native account enrollment boundary

After a native Hub login, the shared client runtime automatically ensures the installation's public
hardware identity and client agreement-prekey certificate, then idempotently enrolls those public
values under the DPoP-bound account session. Private identity, agreement, DPoP, Noise, and session keys
never leave the native device. Enrollment and directory refresh run in parallel where their inputs
permit; directory success alone never makes a node channel ready.

For an eligible online node, the native relay-ticket response includes the same single-use ticket plus
the exact signed grant, grant digest, public ticket id, selected node capability statement/digest,
keyset generation, capability, effective role, and common expiry. The client validates the grant with
the separately fetched authenticated Hub verifier keyset before constructing suite-`0x02` message 1.
The grant is owned by that one connection attempt, is never placed in shared UI state or persistence,
and is discarded with the ticket. There is no second per-node HTTP request.

Trust selection is deterministic: Local Trusted Introduction or a matching verified pin uses suite
`0x01`; otherwise an eligible enrollment uses suite `0x02`; otherwise native access fails closed and
offers explicit secure recovery. A grant never replaces a verified pin. The user may inspect keys,
fingerprints, safety numbers, reported backing, enrollment history, and revocation state without
performing an onboarding ceremony. Connection labels are **Encrypted · Verified locally**,
**Encrypted · Account trusted**, **Encrypted web**, and **Legacy connection**.

Account Security may list, rename, and revoke public device enrollments. Revoking the current device
invalidates its hosted connection generation immediately; the Hub stops ticket/grant issuance and
closes its relay channels, while nodes retire matching ephemeral leases. These controls are account
operations, not node-owned durable approval records.

## Independent state models

Hosted mode deliberately does not expose one ambiguous `connected` flag.

| Model                           | States                                                                                                                 |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Account                         | signed out, authenticating, authenticated, signing out, session expired, unavailable                                   |
| Directory                       | idle, loading, ready, stale                                                                                            |
| Per-machine directory state     | online, offline, incompatible, revoked, authorization removed, native-only locked                                      |
| Per-environment relay transport | idle, requesting ticket, connecting, authenticating, opening channel, online, reconnecting, draining, terminal failure |
| Per-environment Ryco session    | synchronizing, ready, stale, replaying, delivery unknown, closed                                                       |
| Relay encryption                | no channel, negotiating, browser-encrypted (unsigned ephemeral), legacy plaintext                                      |

Relay encryption is a property of one channel and never of a node, an account, or a tab: it is
republished as negotiating when a channel begins and dropped when that channel ends, so a state one
channel earned never describes the next one. One path is deliberately outside that rule. A page that
refuses encryption outright at startup — no cryptographic random source, or no secure context — has
no per-channel machine to publish from, so its legacy label is published once when the socket is
built, before any channel exists, and stands until the node is torn down or the session ends. The
signed native tier's two states are not in this client's state type at all, so the browser cannot
report them even by mistake.

Directory refresh runs on a bounded 20-second visible-page cadence. Failures retain the last bounded
directory as stale, clear role authority, disable selection/actions, and retry with a capped delay.
Machine-detail focus is preserved only while both node ID and environment ID match. Authorization
removal or an identity change closes that exact environment's live demand.

## Directory, roles, and environment demand

The selector renders only the Hub's authorized directory response. It shows online/offline presence
and the effective Viewer, Operator, or Owner role. Revocation, authorization removal, and version
incompatibility are distinct terminal selection states; the selector does not display fingerprints,
grant internals, or unbounded operations metadata.

Two other surfaces deliberately do show identity material, and neither is the selector: node
enrollment shows the enrolling node's public-key fingerprint for the owner to compare out of band
(see **First-owner and node onboarding**), and a connected node's menu shows the current channel's
session verification code for the same purpose (see **Relay payload encryption in the browser**).
Both are comparison values an owner is asked to read, not directory metadata.

The shared RPC access table drives both the server RPC principal and hosted client affordances.
Viewer can read supported projections, Operator can run node mutations, approvals, and terminals,
and Owner can use owner-only configuration/statistics APIs. Missing or stale role state fails closed.
The server remains authoritative, including for legacy RPC aliases and `direct_owner` APIs that are
never available through Hub relay sessions.

Opening mounted work creates an exact-environment scope. Releasing that work removes only its own
scope; it does not globally tear down another retained environment. When capacity requires an
environment to close, teardown is ordered:

1. cancel ticket/reconnect work and close the previous relay channel;
2. unsubscribe shell, thread-detail, lifecycle, config, and terminal listeners;
3. clear request queues, terminal references, drafts, pending actions, UI selections, query/Atom
   caches, timers, and the previous environment projection;
4. start any queued replacement as a new environment generation.

Hosted Web keeps the shared absolute ceiling of three but uses a qualified platform ceiling of one.
Cached directory, Inbox, Projects, and search hydration acquire no relay connection. A mounted
thread detail, VCS status, or provider status scope acquires its owner automatically. Excess demand
waits without evicting retained work or exceeding the bound. Hiding the page releases non-retained
connections; restoring visibility reconnects retained demand only.

Tabs do not share tickets, sockets, queues, reconnect timers, or store instances. Closing a hosted
channel cannot close direct clients or another tab.

## Stable node routes

The owning node is a stable URL segment: hosted browser URLs take the shape
`/node/<node id>` for the node root and `/node/<node id>/<environmentId>/<threadId>` (plus the
existing panel search parameters) for nested views. The segment value is the bounded node
identifier the authorized directory already renders to signed-in users — directory metadata, never
node-owned content or authentication material. The mapping lives in the history layer of the
hosted build only; the shared logical route tree is unchanged and direct-browser, desktop-local,
and SSH-assisted routing keep their current URL shapes.

Refresh, deep links, and history restore the routed node strictly through the ordered fail-closed
pipeline: restore the Hub session → refresh the authorized directory → validate the routed node id
against the directory → issue a fresh one-use relay ticket → establish the relay channel → validate
the node's signed capability advertisement and run the browser handshake, which locks the channel
either encrypted or legacy plaintext → synchronize canonical node state → only then enable
mutations. No application payload leaves the tab before that lock, and the lock decides which of
three things becomes of it: sends issued while a channel is still negotiating are buffered, and are
then flushed as encrypted records on an encrypted lock, flushed **in the clear** on a legacy lock,
or discarded unflushed when the channel fails closed. The legacy branch is the one that hands the
buffer to the Hub in readable form, and it is reached whenever a channel falls back — against an
un-upgraded node, or against any node whose capability advertisement did not arrive. The UI stays on
read-only blocked surfaces until each stage completes. Possession of a node URL grants nothing.

A reload starts a fresh application session, and the tab's downgrade check starts empty again with
it. That check is set on the first capability statement the session validates for a node and is held
in memory for that tab only, so between a reload — or a newly opened tab — and that first validated
statement, the tab has no downgrade resistance at all, and it never has any against the Hub, which
serves the code implementing it. This is a different mechanism from the mobile app's, with different
guarantees, and the two MUST NOT be described in the same terms. Only the node's own admission
policy refuses plaintext for browsers.

Absent, revoked, unauthorized, removed, offline, or incompatible routed nodes and malformed
segments fail closed to the node directory with a bounded explanation. A signed-out or expired
session shows the normal passkey surface; the routed node resumes only after re-authentication and
revalidation. Back and Forward navigate between the directory and selected-node views: returning
to the directory releases exactly that route's scope. A non-retained connection may remain warm as
LRU state until backgrounding or capacity requires its slot; unrelated retained work is unchanged.
Forward re-enters through the restore pipeline with a fresh ticket when acquisition is required. Legacy hosted URLs
without the node segment redirect to the node-scoped shape when the directory can identify the
node, otherwise to the directory. No session, ticket, credential, challenge, or signature material
appears in URLs, history state, or browser storage.

## Relay transport and ticket custody

The existing `WsTransport` and Effect RPC client accept a WebSocket-compatible hosted adapter. RPC
feature components do not know whether their ordered bytes use the direct WebSocket, desktop-local
transport, or Hub relay.

For every browser connection attempt the adapter requests the existing grant-free short-lived ticket
over authenticated Hub HTTP. A ticket exists only in a per-tab in-memory attempt object, is consumed
once, and is discarded before another attempt. Cookie/browser sessions cannot request native ticket
mode, and a response that mixes browser and native fields is rejected. The relay WebSocket has no
query credentials, cookies added by application code, or Authorization header. Its first binary frame
is canonical protocol 1.2 client authentication and must complete within five seconds. Native
account-grant attempts negotiate relay 1.3 through the separate DPoP-bound API described above.

The adapter consumes canonical `ready`, authorized `channel.open`, `channel.accept/reject`, data,
flow pause/resume, ping/pong, error, and close frames. Relay frames, relay ordering, and the RPC
message the application hands down are all unchanged — but on an encrypted channel the bytes inside
`data.payload` are the encryption layer's record envelope rather than the RPC message itself, and
that layer runs its own replay, reorder, and gap detection over its own
records because it treats the relay's ordering guarantees as untrusted
([relay protocol](./relay-protocol.md), [relay payload encryption](./relay-e2ee-protocol.md)).
Inbound and outbound queues honor negotiated chunk/control/queue limits, include native
`bufferedAmount`, pause at negotiated pressure, resume below the low-water mark, and close a slow
consumer rather than growing without bound. No TCP forwarding, SSH, WebRTC, or peer discovery is
part of the client. One encryption protocol is part of it, and only one: the relay payload
encryption layer described below, which lives entirely inside `data.payload` and adds no relay
frame, field, close reason, or version.

It does cost message budget, and that is the one thing it changes that a caller can observe. The
per-message plaintext ceiling on a channel carrying the layer is the relay's effective message
ceiling less the record envelope overhead, and a send submitted while the channel is still
negotiating is additionally bounded by the negotiation buffer. Both refusals are sender-local: they
put nothing on the wire and leave the channel usable. So a message sized between the two ceilings is
accepted on a channel with no encryption layer and refused on one that is negotiating or locked
encrypted.

## Relay payload encryption in the browser

Where the node offers it, a hosted channel negotiates
[relay payload encryption](./relay-e2ee-protocol.md) at the browser's tier: an unsigned ephemeral
(Noise NX) handshake and record layer that run in the page, encrypting what the tab sends to the far
end of that channel and decrypting what comes back. Two conditions bound what that is worth, and
both belong in the sentence that makes the claim: the Hub relays ciphertext instead of readable
payload only while the code it served this page is honest, and this tier pins no node identity, so
the far end is the node this tab was routed to and is never established to be your machine rather
than the Hub standing in for it. A channel that does not negotiate it locks legacy plaintext and is
labeled legacy on every surface that reports it. A page with no cryptographic random source, or one
not served in a secure context, refuses encryption at startup and runs the legacy path rather than a
partial one.

That claim has a ceiling made of two independent limits. Both are structural rather than gaps to be
closed later, and neither is a lesser degree of the other.

**The first needs no substituted code at all.** This tier holds no node pin and no prior
fingerprint, so the signed capability statement a locked channel validated is one it has no anchor
for: a self-signed first-contact statement whose key the client takes as agreed material rather than
as evidence. A genuine handshake therefore establishes only that the far end holds the key in the
statement the channel itself carried — and the Hub can supply both, minting an identity key,
self-signing a statement, and being the far end of a channel that is genuinely encrypted and
genuinely verified against nothing. Nor does the handshake authenticate the browser to the node in
the other direction, which is why what can close this gap is the node's admission policy and never
this client.

**The second is the served code.** The Hub serves every byte of this application's JavaScript, so a
malicious or compelled Hub can serve code that completes the genuine handshake, displays the genuine
session code, and exfiltrates plaintext or traffic keys anyway; no in-page check and no out-of-band
comparison can make an attacker-controlled display trustworthy. The browser tier is therefore
**never operator-proof**, and the specification does not offer it as such.

Independently distributed code with hardware-anchored identity and durable pins is what supports the
stronger claim, and that is the Ryco mobile app, not this client. "Durable" there is scoped to one
install: the stronger guarantee is per channel and holds for channels the app resolves to a pin the
owner verified through the pairing comparison, and a reinstall, an OS restore, a device transfer, or
a secure-store reset destroys every pin on that device at once and returns it to first contact until
the owner re-pairs.

### The disclosure this client shows

The relay-trust disclosure is a function of the channel state, and it is shown on the hosted
authentication, node-selection, connection, and installation surfaces. It takes no state from the
surface it mounts on: every mount site reads the live channel projection, so install help opened
from a connected node's menu or from the phone connection sheet states that channel's disclosure and
not the no-channel one. The paragraphs below are the shipped strings, quoted verbatim from
`apps/web/src/components/hostedHub/HostedRelayTrustNotice.logic.ts`. They are quoted rather than
paraphrased on purpose: a paraphrase here would be a second copy of a security claim, free to drift
away from the one the application renders. `HostedRelayTrustNotice.logic.test.ts` reads this file
and asserts that each quotation below is exactly the shipped copy for its state, so a divergence
fails a test instead of surviving a review.

No node channel open in this tab — the sign-in surface, the node directory, and install help reached
from the directory:

<!-- shipped-copy:unavailable -->

> Hosted connections reach your nodes through the Ryco Hub over WSS. No node channel is open in
> this tab, so the Hub still forwards what you send in a form it can read, and it is expected not
> to log or keep it.

<!-- /shipped-copy:unavailable -->

A channel that is still negotiating:

<!-- shipped-copy:negotiating -->

> This tab is still agreeing a channel with your node and has released nothing to it yet. Until
> that settles, treat this connection as one the Hub can read.

<!-- /shipped-copy:negotiating -->

A channel that locked encrypted:

<!-- shipped-copy:web-unsigned -->

> This tab and the node it was routed to agreed a browser channel, so while the code this page is
> running is honest the Hub relays ciphertext instead of readable payload. It is weaker than the
> channel the Ryco mobile app gets, in two ways this tab cannot close. This tab pins no node
> identity, so it cannot tell whether the far end of that channel is your machine or the Hub
> standing in for it. And it cannot protect against the Hub operator, who serves every byte of this
> page's JavaScript and could serve code that completes the same handshake and copies your data
> anyway. Its downgrade check is held in memory only — empty again in every new tab and after every
> reload, and worth nothing against that operator. Only your node can close the plaintext path for
> browsers.

<!-- /shipped-copy:web-unsigned -->

A channel that fell back to plaintext:

<!-- shipped-copy:legacy -->

> This channel fell back to legacy plaintext. This tab cannot tell whether your node offered no
> encrypted channel or something on the path removed the offer, so treat everything sent over it as
> readable by the Hub, which is expected not to log or keep it. Only your node can refuse plaintext
> for browsers.

<!-- /shipped-copy:legacy -->

### Key custody, and what the node decides

The browser's agreement key material, handshake state, session keys, downgrade check, and session
verification code exist in process memory and nowhere else: there is no storage class any of them
may enter, and the no-durable-secrets rules under **Security and browser persistence** apply to all
of them verbatim. The bound is where they live, not how long — each is scoped to the channel that
produced it and is erased when that channel ends, with session keys zeroized, handshake state
destroyed on every terminal path, and the verification code dropped. The downgrade check is the one
value scoped to the application session instead of to a channel, and it is cleared on sign-out.
Nothing is resumed: every reconnect obtains a fresh ticket, opens a fresh channel, and runs a fresh
handshake.

Only your node can refuse plaintext for browsers, and that is the durable half of the decision: this
client keeps no policy of its own and cannot make a node offer encryption. It is not a passenger in
the other direction, though. A page that fails the startup random-source or secure-context check
refuses encryption itself whatever the node offers, and that channel is legacy because of the
browser rather than because of the node. And once this session's downgrade check is set for a node,
a channel that would otherwise fall back closes instead of running plaintext. Under the
compatibility default a node still admits legacy plaintext, so a browser session against an
un-upgraded node is legacy and is labeled legacy. A node configured to require encryption rejects
plaintext but still admits unsigned browser sessions — it closes the downgrade path, not the
active-Hub gap above. A node configured to require approved native clients disables browser and
legacy access entirely, which is the only whole-node setting that closes that gap and is documented
with the other admission options in the [hub connector guide](./hub-connector.md).

## Comparing the session code with your node

On an encrypted channel the connected node's menu shows a short per-session verification code
together with the sentence that bounds it. The code is derived from the node's identity key and this
tab's ephemeral key and is bound to the single channel that produced it, so it changes on every
channel and is meaningless once that channel closes.

Compare it out of band with the node's own view of the same session:

```sh
ryco e2ee sessions
```

The sentence shown beside the code states what a match is worth. It ships at two lengths, both
quoted here for the reason the disclosure above is, and the same test holds each to the shipped
string.

Beside the code in the node menu — where an owner is mid-comparison — the accompanying text is one
line and the pointer at the rest of it:

<!-- shipped-text:web-sas-advisory -->

> Compare this code with the one your node's CLI shows for this session. A match catches accidental
> wrong-node routing and some network interposition while the loaded code is honest; it cannot
> protect against the Hub operator, who serves this page, and it does not rule out someone sitting
> in the middle.

<!-- /shipped-text:web-sas-advisory -->

<!-- shipped-text:web-sas-more -->

> Settings → Connections → Node security explains what else this tab cannot check.

<!-- /shipped-text:web-sas-more -->

In Settings → Connections → Node security, the same code is drawn with the longer account. It names both of the reasons
the browser tier is denied the active-Hub column, and keeps them apart: one needs a substituted
bundle and one needs nothing at all.

<!-- shipped-text:web-sas-detail -->

> Compare this code with the one your node's CLI shows for this session. A match catches accidental
> wrong-node routing and some network interposition while the loaded code is honest. This tab pins
> no node identity, so that comparison is the only thing that speaks to whether the far end is your
> machine or the Hub standing in for it — and it cannot protect against the Hub operator, who serves
> this page and could serve code that completes the same handshake and displays this same code
> anyway. A match does not rule out someone sitting in the middle.

<!-- /shipped-text:web-sas-detail -->

<!-- shipped-text:web-sas-compare -->

> Run `ryco e2ee sessions` on the machine running the node to read its end of the comparison.

<!-- /shipped-text:web-sas-compare -->

Read the whole code in order: its fixed length and grouping are the only check it has, and the
comparison stays advisory for the reason both forms end on — a match does not rule out someone
sitting in the middle, because an interposer can grind its own ephemeral until the two strings agree
and what bounds that is the handshake window rather than the derivation. Neither form states the
character count, the grouping, or the displayed entropy: the entropy is a derivation rather than
something an owner acts on, and the format is in front of them while they read.

The code is ephemeral display state. It is never logged, never persisted, and never sent to
analytics, and it must not be captured into qualification evidence, screenshots, or diagnostics. If
a channel locked encrypted but produced no code, the surface says so rather than rendering nothing —
an absent comparison value is reported, not silently dropped.

The code renders in the desktop-width node menu and again in Settings → Connections → Node security, which is where the
menu's pointer leads. That section is owner-only in hosted mode, so the menu asks whether this
reader can open it before it points there: a viewer, an operator, or an owner whose role snapshot
has gone stale is shown the longer account in the menu itself, with the `ryco e2ee sessions`
sentence in place of a pointer at a section their settings list does not have. The narrow phone
presentation does not draw the code at all, and its disclosure deliberately points at no comparison
it cannot show; on a phone, use the Ryco mobile app.

## Reconnect, replay, and delivery uncertainty

Each demanded environment has at most one active connection attempt in a tab, and the hosted Web
platform ceiling permits only one active environment. Reconnect uses exponential
backoff from one second to 60 seconds with bounded ±20% jitter and bounded Hub `retryAfterMs` input.
The delay resets only after a session remains stable for 60 seconds. Every retry obtains a fresh
ticket.

Retryable cases include generic browser network failure, node offline, Hub draining, connection
replacement, rate limiting, slow-consumer closure, and retryable ticket expiry. Revocation,
authorization removal, unsupported protocol, invalid protocol, and authentication-required failure
are terminal. Browser WebSocket APIs intentionally do not reveal whether a pre-handshake network
failure was DNS or TLS, so the hosted UI reports those cases as a bounded network failure; direct
and node-side diagnostics retain their more specific classification.

On reconnect, the existing shell and thread subscriptions resubscribe. Ryco marks the session
`replaying`, accepts the authoritative shell snapshot, discards duplicate/older projection versions,
reconciles thread subscriptions, and then marks it ready. Conversations, running tasks, approvals,
and terminal projections recover from the node, never from Hub.

RPC reads may be retried by their existing subscription behavior. An unacknowledged request is
conservatively treated as uncertain, and a non-idempotent request is never automatically replayed
merely because the relay disconnected. If no response chunk or exit made delivery known, the
session becomes `delivery unknown`; the UI does not claim that the command was accepted. After the
authoritative replay finishes, the user can explicitly acknowledge the warning.

## Browser capability adaptation

Hosted mode keeps the shared feature UI and uses each routed environment's RPC capabilities:

- terminal input/resize, approvals, remote project/filesystem operations, source control, and
  attachment uploads continue over RPC when allowed by role;
- browser downloads and clipboard actions use normal browser APIs;
- historical attachment preview URLs are not sent to Hub because node HTTP paths are not a relay
  transport; the attachment name remains visible with an explicit preview-unavailable explanation;
- auto-detected project favicons and project-image upload/preview are disabled with an explanation
  because those legacy node HTTP routes are not relayed; removing an existing image remains an
  authorized RPC operation;
- desktop updater controls, native file dialogs, native notifications, deep-link pairing, local
  project discovery, desktop IPC, and editor/Finder launch affordances remain desktop-only;
- no local filesystem path or desktop bridge is exposed to the hosted page.

Production `hosted-hub` builds are installable mobile PWAs. Standard, desktop, hosted-static, and
development builds do not register the production service worker. The hosted worker precaches only
an explicit allowlist of immutable shell assets and a static offline document. Live HTML,
authentication, API, RPC, relay, WebSocket, attachment, project, file, terminal, conversation, and
other node-owned responses remain network-only.

Native enrollment, grant-verification keyset, native relay-ticket/grant, device-list/rename/revoke,
and revocation-event routes are always network-only even if a future route name resembles a static
asset. Request method and response headers do not relax that denylist.

## Mobile installation and updates

On Android Chrome, Ryco exposes **Install Ryco** when the browser supplies its native install
prompt. If the prompt is unavailable, use the browser menu and choose **Add to home screen** or
**Install app**. On iOS Safari, open the Share or browser menu, choose **Add to Home Screen**, enable
**Open as Web App** when offered, and confirm **Add**. Installation is optional; browser use remains
available without it.

Installed Ryco uses standalone display mode. A new service worker waits while an existing client is
active. Ryco shows **Update ready** and activates it only after the user confirms; finding an update
does not reload active work automatically.

Navigation remains network-first. If the network is unavailable, the worker returns a static
offline document containing no account, node, project, or conversation data. Returning online does
not make stale browser state authoritative: hosted mutations remain disabled until Ryco validates
the current session, refreshes the authorized node directory and role, establishes a fresh relay
generation, and accepts the current node snapshot or replay point.

Installing Ryco changes nothing about who can read what crosses the relay: an installed tab gets the
same browser tier described above, with the same ceiling, because the Hub still serves every byte of
the code that does the encrypting and could serve code that completes the same handshake and copies
the payload anyway. The disclosure for the current channel state is shown on the hosted
authentication, node-selection, connection, and installation paths in the words quoted above, and
installation adds no surface that states anything stronger.

## Security and browser persistence

Hosted mode keeps authentication material, node-owned state, and every value the payload encryption
layer produces out of localStorage, sessionStorage, IndexedDB, service-worker caches, URL/history
state, configuration exports, and browser logs. The encryption values are the browser's ephemeral
agreement key material, its handshake and session-key state, its in-memory downgrade check, and the
session verification code: all of them live in process memory, the browser has no storage class any
of them may enter, and each is erased when the channel — or, for the downgrade check, the
application session — that produced it ends. Draft, terminal, general UI, script-selection,
and other generic local-storage hooks use in-memory storage. A separate, schema-validated inbox
preference record stores only three finite user choices: the auto-settle interval, whether AI Focus
is enabled, and its refresh interval. It contains no node identifiers, rankings, model/provider
preferences, content, or authentication material. These browser-local choices survive reloads.
The hosted root installs a fail-closed
console sink before authentication because older local-client feature paths may log caught values.
Relay payloads are never persisted or sent to client analytics — which is not the same as the Hub
seeing nothing, because on every channel, encrypted or not, the Hub still sees which account and
session talk to which node, channel open and close events and their reasons, frame sizes and timing,
the capability and effective role carried in `channel.open`, heartbeats, and transfer-budget
accounting. That list is what stays visible where the encryption works. It is not the boundary of
what the Hub can reach on this tier: whether the encryption works against the Hub at all is bounded
by **Relay payload encryption in the browser** above, and on a legacy channel the Hub forwards the
readable payload itself.

Do not add passwords, cookies, Authorization headers, CSRF values, WebAuthn challenges/responses,
invitation secrets, tickets, native device grants, Hub keysets, node proofs, encryption key material,
handshake or session-key state,
session verification codes, provider data, source code, conversations, terminal output, files,
attachments, or relay payloads to errors, diagnostics, metrics, exports, or persistence.

## Accessibility and layout

Authentication, invitation, directory, and node menus use native keyboard controls, explicit labels,
focus-visible indicators, focus movement on flow changes, validation messages, and polite/assertive
live regions. Online, offline, stale, reconnecting, delivery-unknown, and relay-encryption states use
text and icons in addition to color, and an encrypted browser channel is given an advisory rather
than a success treatment, so the weaker configuration is not dressed as the stronger one through
styling. The same shell adapts from narrow browser widths through tablet and desktop; there is no
second hosted feature UI, with one deliberate exception — the session verification code renders only
in the desktop-width node menu, so the narrow presentation offers no comparison to make and its
disclosure points at none. That sameness is otherwise about presentation and feature surface only.
It says nothing about the encryption tier, which does fork between this browser client and the Ryco
mobile app, as stated at the top of this document.

## First-owner and node onboarding

The signed-out shell requests the Hub's bounded bootstrap-availability response before offering
first-owner setup. An unavailable, malformed, or failed response hides the setup action while
leaving passkey sign-in and invitation redemption available. Successful owner setup hides the
action immediately. The Hub remains authoritative for permanent bootstrap completion.

An authenticated owner can start **Enroll node** from the node directory after running `ryco hub
enroll` on the intended node. The owner enters the short device code, then compares the displayed
label, platform, client version, algorithm, expiry, and public-key fingerprint with the node or a
trusted operator channel before approving or denying. Approval creates the owner's explicit node
grant; the directory reports the node offline until its outbound connector polls the result and
authenticates.

Device codes remain only in the active onboarding component. They are not placed in URLs, global
stores, browser storage, diagnostics, telemetry, or logs. Polling secrets and private keys never
enter the browser. Session, role, same-origin, CSRF, expiry, rate-limit, and enrollment-state checks
remain server-enforced.

## Troubleshooting

- **Passkey unavailable or rejected:** verify the page origin is inside the Hub's configured RP ID
  and public-origin policy, then restart the ceremony. Do not relax RP ID or Origin validation.
- **Session expired:** sign in again. The client intentionally discards live environment demand and
  role authority.
- **Directory is stale:** restore Hub HTTP reachability and use Refresh. Actions remain disabled
  until a fresh authorized response arrives.
- **Node offline:** confirm the node's outbound Hub connector is enrolled and online. The client will
  keep bounded retries with fresh tickets.
- **Authentication timeout:** check that the relay accepts the first binary frame within five
  seconds and both peers support canonical relay protocol 1.2.
- **Incompatible or revoked:** an administrator must restore compatible node access. The browser
  will not downgrade the protocol or bypass authorization.
- **Delivery unknown:** inspect the authoritative node state before issuing the command again.
- **Channel says legacy plaintext:** rule out the page first. An origin that is not a secure
  context, or a browser exposing no cryptographic random source, makes this client refuse encryption
  at startup, and the label is then the browser's doing and the node's configuration is untouched.
  Otherwise the browser cannot tell whether the node offered no encrypted channel or something on
  the path removed the offer, so check the node: confirm it is a version that advertises encryption,
  and use its admission policy if plaintext should be refused outright.
- **Session codes do not match:** stop using the session and reconnect, then compare again. A
  mismatch is a reason to investigate routing and the network path; a match is advisory only and
  does not clear the Hub, which serves the JavaScript that draws it.
- **No session code on an encrypted channel:** the surface says so explicitly. There is nothing to
  compare for that channel; reconnect to get a fresh one.
- **Preview unavailable:** historical attachment previews require a future bounded RPC read; the
  client intentionally does not turn the relay into an HTTP tunnel.
