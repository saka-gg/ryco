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
HTTP APIs, node directory, relay-ticket endpoint, and `/v1/relay/session` WebSocket therefore share
one origin:

```text
https://hub.example/
  web assets
  /api/auth/*
  /api/nodes
  /api/relay/tickets
  /v1/relay/session
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
Node-level security details live under **Settings → Security** (the device group of the settings page);
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

The account-scoped Hub session pushes directory changes immediately. Directory refresh retains
a two-minute visible-page backstop while the subscription is online. Without a live subscription,
it runs every 20 seconds, or every 5 seconds while demand waits on an offline node for at most five
minutes. A client that opts in (the native app, whose every directory read is signed with its device
key) keeps the 20-second cadence only while a screen that shows node presence is in front, and
otherwise uses the two-minute backstop; returning to such a screen refreshes at once when the last
read is older than 20 seconds. The faster cadence never shortens a failure backoff. Failures retain the last bounded directory as stale, clear role
authority, disable selection/actions, and retry with a capped delay.
Machine-detail focus is preserved only while both node ID and environment ID match. Authorization
removal or an identity change closes that exact environment's live demand.

## Directory, roles, and environment demand

The selector renders only the Hub's authorized directory response. It shows online/offline presence
and the effective Viewer, Operator, or Owner role. Revocation, authorization removal, and version
incompatibility are distinct terminal selection states; the selector does not display fingerprints,
grant internals, or unbounded operations metadata.

Two other surfaces deliberately do show identity material, and neither is the selector: node
enrollment shows the enrolling node's public-key fingerprint for the owner to compare out of band
(see **First-owner and node onboarding**), and an open thread's connection popover shows the current
session verification code of that thread's node for the same purpose (see **Relay payload encryption
in the browser**). Both are comparison values an owner is asked to read, not directory metadata.

The shared RPC access table drives both the server RPC principal and hosted client affordances.
Viewer can read supported projections, Operator can run node mutations, approvals, and terminals,
and Owner can use owner-only configuration/statistics APIs. Missing or stale role state fails closed.
The server remains authoritative, including for legacy RPC aliases and `direct_owner` APIs that are
never available through Hub relay sessions.

Opening mounted work creates an exact-environment scope. Releasing that work removes only its own
scope; it does not globally tear down another retained environment. When capacity requires an
environment to close, teardown releases that one environment and no other, in order:

1. cancel ticket/reconnect work and close the previous relay channel;
2. unsubscribe shell, thread-detail, lifecycle, config, and terminal listeners;
3. clear request queues, terminal references, drafts, pending actions, UI selections, query/Atom
   caches, timers, and the previous environment projection;
4. start any queued replacement as a new environment generation.

The server config the UI shows comes from a per-environment store. Each connection writes its own
node's config there from the moment it connects (its config stream is a session-sync subscription,
fenced by the hosted generation like the rest of its state), and the global config the UI reads is
derived from the active environment's entry while the shell is mounted. An entry lasts until its
environment is left: leaving an environment forgets only its own entry, and the shown config resets
with it when that environment's config was the one shown, whether or not the shell is mounted.
After a switch the shown config is the new environment's entry, once its connection has written
one; until then no config is shown. Sign-out purges all entries. `welcome` is not per-environment
state: it comes from the primary connection's lifecycle stream only, and leaving the primary node
drops it.

The Inbox classifies each environment's threads with that environment's own thread capabilities
(settlement and snooze), never with the shown config or the selected node's descriptor, so moving
the selection does not reclassify another node's threads. The store keeps what each node reported in
memory, past the entry itself: an environment released from the warm set keeps classifying by its
node's last answer until sign-out. A node this tab has not heard from, and whose Hub directory entry
does not state the capability, is unknown: its threads are classified by what the node recorded
(manual settlement, snooze and the automatic rule), and settlement and snooze changes stay disabled
until the node answers. Only a node's explicit `false` keeps every thread Active, as on nodes that
predate settlement.

The automatic settlement rule ("settle after N days without activity") belongs to each node, so every
device lists a node's threads the same way. A node that advertises `nodeAutoSettlement` keeps the rule
in its settings (`threadAutoSettleAfterDays`; absent means the shared default of seven days, `null`
means off) and carries the resolved rule in its shell snapshot (`settlementPolicy`), which the cloud
history index publishes too: the node republishes its index when the rule changes. Each environment's
threads are classified with its own node's rule: from the node's live config, else the latest shell
snapshot of it (a cold node's cached index), else the rule it last reported this session. Rows painted
from this browser's own startup cache follow this browser's rule until one of those arrives, since
that cache keeps no rule. Time boundaries are still evaluated with this tab's clock. A node that keeps no rule (an older one) follows
this browser's own choice. When an owner first connects to a node that keeps the rule but has none
set, a browser whose own choice differs from the default writes it to the node once; a node that
already has a value keeps it, and of two clients doing so at once the first one's stands. Inbox
settings edit the rule on the node they show, read-only without the owner role, and can apply it to
every connected node, naming those it could not reach.

Hosted Web keeps a warm set of up to three environments per tab, the shared absolute ceiling,
qualified for browsers in the "Hosted Web warm set qualification (measured)" section of
[relay-capacity-assessment-3b.md](relay-capacity-assessment-3b.md); a tab samples at most one device
preview at a time, which bounds the full-PNG fallback. Cached directory, Inbox, Projects, and search
hydration acquire no relay connection. A mounted thread detail, VCS status, or provider status scope
acquires its owner automatically. Excess demand waits without evicting retained work or exceeding
the bound; when a slot is needed, the least recently used environment that nothing demands is
released. Releasing an environment from the warm set — a demotion — keeps its cached rows visible as
cached until it is demanded again. This ceiling counts logical node channels; the account-owned Hub
socket remains open across selections.

Two more kinds of demand hold an environment while they last. An environment with queued messages
for one of its server threads stays demanded until its queue drains or is cleared, so it connects,
or stays warm, to send them; a draft's queued first send holds nothing (it is sent only from the
open draft). A navigation press on a thread row of an environment without a live session holds that
environment for three seconds, so its relay attempt overlaps the click; it follows only primary
mouse or pen presses, never touch, connects at most one environment per five seconds and each
environment at most once per 30 seconds, never displaces mounted work, and does nothing on the phone
presentation. Hovering a row warms its route. A hover (after its dwell) or a press reads the
thread's window only from a session that is ready to adopt, and never on the phone presentation;
for any other environment only the press pre-connect acts.

Ordinary tab hiding preserves live channels for a grace period: a tab hidden for 90 seconds plans as
backgrounded and releases every environment nothing demands. Offline, freeze, and page history
suspension invalidate readiness; restoration uses the authoritative hosted recovery path, and
foreground or visibility recovery restores retained demand and then, as preemptible demand, the
last warm set of up to three recently used environments (see
[unified-workspace.md](unified-workspace.md)).

Hosted connections are created only through the lifecycle owner's connect port, for one session
record generation. The generic primary-connection path never builds one: in hosted mode it returns
the connection already registered for the active environment, or nothing (a caller that requires a
connection gets an error), so no second constructor can bypass the ceiling or the record fencing.

Tabs do not share tickets, sockets, queues, reconnect timers, or store instances. Closing a hosted
channel cannot close direct clients or another tab.

### Retained environment sessions

Hosted Web keeps several node sessions alive side by side instead of one session for the selected
node. The hosted lifecycle owner stays the same single owner; the session state moves into one
record per environment.

- **Records and fencing.** Each environment's record carries its own transport status, session
  status, role, failure, and snapshot. Every record generation is drawn from one monotonic counter
  shared by all environments, and every relay callback names the environment and generation it
  belongs to, so a stale connection can never publish readiness, a role, a snapshot, or mutation
  authority into another generation's or another environment's record. Each environment's connect,
  release, and suspension run on that environment's own queue and name the generation they act
  for: nothing of one environment ever waits for another.
- **Selection is a cursor.** Selecting a node moves the selection and the shared session fields,
  which show the selected record, and nothing else. It never opens a connection. Connections are
  created only when the platform's bounded demand executor acquires an environment, so the
  executor's connection ceiling is the only place a slot is granted; a routed environment it cannot
  admit stays queued and is shown as such. The browser never selects a node that requires a native
  client.
- **Adopt, join, restart.** Acquiring an environment adopts its session when that session completed
  its own fresh relay attempt and accepted its own current shell snapshot and has not been
  suspended or interrupted since; selecting it then shows it ready at once, without a network
  request. Switching back to an environment of the warm set is therefore a cursor move: no Hub
  stream is opened and the node is not asked for its shell again. An acquisition joins a
  connection already requested for the record's generation, so a press followed by a click buys
  one attempt. A terminal failure refuses it until the node's
  directory entry changes or the user retries. Anything else starts over with a fresh generation, a
  fresh relay attempt, and a fresh snapshot. Selecting an environment whose session can be neither
  adopted nor joined starts it over in the same way. A connect that waited behind the
  environment's own release or suspension opens nothing once a withdrawal, a sign-out, or anything
  else has replaced its generation.
- **Suspension and withdrawal.** Page freeze, page hide, going offline, and backgrounding suspend
  every record, not only the selected one: each takes a fresh generation and none stays adoptable.
  A second suspension before a resume (hidden, then offline) leaves the records already suspended
  alone. Revoking native account authorization withdraws every record's role and session before
  the call returns, ahead of any asynchronous channel teardown. A terminal failure of the account's
  Hub session reaches every record.
- **Resume.** No record keeps its authority across a resume: one that no suspension reached, as
  after a rotated Hub session, is suspended when the resume starts. Resuming revalidates the Hub
  session and the authorized directory first. Only then does the platform re-plan its connections —
  the selected environment first, the others staggered — and each suspended record regains
  authority only through its own fresh attempt and snapshot.
- **Refused acquisitions.** The demand executor holds back an environment whose acquisition was
  refused. One refused only for a cause that passes — the account not yet restored, the browser not
  yet revalidated, the directory not current (before its first load the directory knows no node at
  all), or its generation replaced during the call — is re-planned once, when a resume succeeds or
  when the directory becomes current, its first load included, while the browser is revalidated;
  if it is refused again, it waits for the next such recovery. The node is looked up in the
  directory current by then: a recovery never re-plans one whose node is gone, revoked, or requires
  a native client, nor one a terminal failure blocks (that waits for its directory entry to change
  or for a retry), nor anything refused before signing out or for another account.
- **Readiness per record.** An environment admits requests once the browser is revalidated and its
  own session is current. Observe-only unary reads — project lists, files, local changes, thread
  history and diffs, the node's config and settings — do not wait for the session: they are
  admitted once the environment's own channel is online (its mode locked) while its session is
  synchronizing or replaying. Every other request, mutations included, waits for the session to
  be current. While the selected environment is still synchronizing the browser reports
  `synchronizing`, which never holds back another environment whose own session is ready; a slow
  or offline selection does not trigger a fresh access check on every foreground signal either.
- **Release.** The demand executor releases environments; returning to the node directory releases
  nothing. A relay drop of a live environment that nothing demands releases it instead of
  reconnecting it; it reconnects when it is demanded again. A rate limit hit by background demand
  (drafts, home discovery, queued sends, a press) stands that demand down instead of retrying it,
  while a mounted view keeps its transport's backoff. A directory refresh releases every
  environment whose node is gone, revoked, or (in the browser) requires a native client, without
  waiting for those releases, and leaves the selection
  when it is one of them. Releasing an environment ends the commands waiting to replay there and
  clears only that environment's node-scoped state — its queries, project, git, and checkpoint-diff
  caches, its encryption projection, and its config entry — unless a newer session of the same
  environment has already started. Signing out or an expired Hub session releases every environment
  and always clears that state, so no account's cached state reaches the next session; it never
  waits for those releases, and an expired session's explanation is never published onto a session
  that signed in meanwhile.

Hosted Web runs retained environment sessions. Clients that do not opt in still run one session
for the selected node.

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
against the directory → authorize a fresh one-use relay ticket (bought over HTTP, or minted and
consumed by the Hub itself on a version 2 account session) → establish the relay channel → validate
the node's signed capability advertisement and run the browser handshake, which locks the channel
either encrypted or legacy plaintext → synchronize canonical node state → only then enable
mutations. No application payload leaves the tab before that lock, and the lock decides which of
three things becomes of it: sends issued while a channel is still negotiating are buffered, and are
then flushed as encrypted records on an encrypted lock, flushed **in the clear** on a legacy lock,
or discarded unflushed when the channel fails closed. The legacy branch is the one that hands the
buffer to the Hub in readable form, and it is reached whenever a channel falls back — against an
un-upgraded node, or against any node whose capability advertisement did not arrive. The UI stays on
read-only until each stage completes. A remembered browser can show its saved conversation text and
allow local draft editing during that interval, and messages sent then wait in the tab (see
**Sending while a node connects**). Possession of a node URL grants nothing.

A reload starts a fresh application session, and the tab's downgrade check starts empty again with
it. That check is set on the first capability statement the session validates for a node and is held
in memory for that tab only, so between a reload — or a newly opened tab — and that first validated
statement, the tab has no downgrade resistance at all, and it never has any against the Hub, which
serves the code implementing it. This is a different mechanism from the mobile app's, with different
guarantees, and the two MUST NOT be described in the same terms. Only the node's own admission
policy refuses plaintext for browsers.

Absent, revoked, unauthorized, removed, or incompatible routed nodes and malformed segments fail
closed to the node directory with a bounded explanation. An offline node or temporarily stale
directory can keep an already known cached thread visible without acquiring mutation authority.
A signed-out or expired
session shows the normal passkey surface; the routed node resumes only after re-authentication and
revalidation. Back and Forward navigate between the directory and selected-node views: returning
to the directory releases exactly that route's scope. A non-retained connection may remain warm as
LRU state until backgrounding or capacity requires its slot; unrelated retained work is unchanged.
Forward adopts a session that stayed live; it re-enters through the restore pipeline with a fresh
ticket when acquisition is required. Legacy hosted URLs without the node segment redirect to the
node-scoped shape when the directory can identify the node, otherwise to the directory. No session,
ticket, credential, challenge, or signature material appears in URLs, history state, or browser
storage.

## Sending while a node connects

While a node's connection is being established — an intentional switch, or a connection that is on
its way without any error — the chat stays usable and quiet. It shows "Syncing with <node>…" as a
note rather than a warning, and the composer accepts a send at once.

- **Queued sends are local draft state.** A plain message sent while the node is being established
  waits in the tab's message queue, image attachments included. Nothing leaves the tab: the queue
  sends it only once that environment has made a fresh relay attempt, accepted a current shell
  snapshot, and admits mutations. The send button keeps its usual look with the caption "Sends when
  <node> is ready", and the queued message says the same. If the node is still not ready after the
  session's synchronization deadline (30 seconds), the queued message shows the connection's own
  reason instead; a role that does not allow sending reads "Can't send — your role on <node> doesn't
  allow it". A stale connection, a role refusal, or an unconfirmed delivery refuses new sends as
  before.
- **A draft's first send** waits under the draft. Only the draft's own open view sends it, creating
  its thread with the same receipt-idempotent bootstrap as any first send. Leaving the draft before
  the node is ready leaves the message queued: nothing is sent in the background and no thread is
  created. It is sent once, when the user returns to the draft and the node is ready. A draft's queue
  is therefore only ever shown from the open draft. While a draft has a queued send, its device
  cannot be changed.
- **Never queued.** Actions whose meaning depends on the moment they reach the node are not held
  for later: stop, approval decisions and user-input answers (moving between questions stays local;
  the answer to the last one is what reaches the node), steering a running turn, reverts,
  terminal input, git and file writes (saving open editor changes included), Agent Control decisions,
  project and settings writes, plan follow-ups, goals, side questions, and non-image uploads. While
  the connection is being established they are disabled or refused with "Available when <node> is
  connected"; any other refusal keeps its own reason.
- **Attachments.** Images travel inside the queued message. A non-image upload is never queued with
  a send: while the node connects the composer keeps it pending as "Syncing" ("Waiting for this node
  to connect."), and a message that includes it cannot be sent until the upload is resolved. Hosted
  builds do not stream non-image uploads to a node, so once the connection is established the
  attachment shows the usual "Authorize" state and has to be removed before the message can be sent.
- **Waiting for a free connection.** A routed node can wait for one of the limited connection slots
  when every slot is held by an open view. The chat then reads "Waiting for a free connection to
  <node>…", and sends wait in the queue the same way.

## Relay transport and ticket custody

The existing `WsTransport` and Effect RPC client accept a WebSocket-compatible hosted adapter. RPC
feature components do not know whether their ordered bytes use the direct WebSocket, desktop-local
transport, or Hub relay.

The browser establishes one persistent account subscription independently of node selection, using
the [Hub session protocol](./hub-session-protocol.md). Every logical node connection attempt is
authorized by its own grant-free, short-lived, single-use ticket, in one of two custodies:

- **Server-minted (Hub session version 2).** When the account socket is ready, negotiated version 2,
  and is not under a liveness probe, the attempt sends no HTTP request. It opens the stream with
  `openNode`; the Hub re-authorizes the socket's session, then mints and consumes the ticket for that
  session in one operation under exactly the checks of the HTTP endpoint, and authenticates the stream
  itself. The ticket never leaves the Hub: the client never sees, stores, or sends it, and the stream
  carries no relay `auth` frame. The engine keeps the same five-second authentication deadline for
  the relay's `ready`. Server-minted opens are bound to the restored session: the client offers
  them only while the socket's `ready` names exactly the account and browser session it restored,
  and names that session in every `openNode`. A mismatch, or a session-level refusal of such a
  stream, goes back to the hosted lifecycle owner's revalidation (at most once per 30 seconds per
  session). That revalidation expires a session the Hub no longer accepts, as an HTTP `401` would,
  runs the full resume for a different session of the same account, and changes nothing for an
  unchanged session, leaving the transport's backoff in charge.
- **HTTP ticket (version 1, and every other tier).** Otherwise the adapter requests the ticket over
  authenticated Hub HTTP (`POST /api/relay/tickets`, CSRF-protected). It exists only in a per-tab
  in-memory attempt object, is consumed once, and is discarded before another attempt. The stream's
  first relay frame is canonical client authentication carrying it and must complete within five
  seconds. This is the path against a version 1 Hub, before the account socket is ready, while it is
  under a probe, and for a stream whose account socket was replaced by one that negotiated version 1
  (that stream closes retryably and the next attempt buys a ticket). The native app and the desktop
  shell keep this path: they do not use the browser account socket.

The choice is made per attempt, after socket preparation; nothing else differs. E2EE capability
validation, the current shell snapshot gate, and generation fencing apply identically to both.
Cookie/browser sessions cannot request native ticket mode, and a response that mixes browser and
native fields is rejected. The physical Hub WebSocket has no query credentials, cookies added by
application code, or Authorization header; its only client-chosen header is the subprotocol that
advertises the session version. Native account-grant attempts negotiate relay 1.3 through the
separate DPoP-bound API described above.

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

Clients that can inflate (web and desktop through `DecompressionStream`, the native app through
fflate) advertise it in-band. The node then compresses large shell snapshot thread pages and full
provider lists inside the payload, and inside the encrypted record on an encrypted channel. The
client inflates each one under a hard cap of the relay message limit before the RPC layer sees it.
A compressed payload the client cannot deliver ends the channel with a retryable failure, and the
connection's next attempt runs without compression
([relay payload encryption §4.6](./relay-e2ee-protocol.md#46-relay-payload-compression-node-to-client)).

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
from the account page or from the phone connection sheet states the selected node's channel
disclosure and not the no-channel one. The paragraphs below are the shipped strings, quoted verbatim
from `apps/web/src/components/hostedHub/HostedRelayTrustNotice.logic.ts`. They are quoted rather
than paraphrased on purpose: a paraphrase here would be a second copy of a security claim, free to
drift away from the one the application renders. `HostedRelayTrustNotice.logic.test.ts` reads this
file and asserts that each quotation below is exactly the shipped copy for its state, so a
divergence fails a test instead of surviving a review.

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

On an encrypted channel the open thread's connection popover — opened from the node name in the
desktop workspace header — shows a short per-session verification code for that thread's node,
together with the sentence that bounds it. It is that node's own session's code even while the
selection is on another node, so it is always the one that node's CLI shows. The code is derived
from the node's identity key and this tab's ephemeral key and is bound to the single channel that
produced it, so it changes on every channel and is meaningless once that channel closes.

Compare it out of band with the node's own view of the same session:

```sh
ryco e2ee sessions
```

The sentence shown beside the code states what a match is worth. It ships at two lengths, both
quoted here for the reason the disclosure above is, and the same test holds each to the shipped
string.

Beside the code in the connection popover — where an owner is mid-comparison — the accompanying text
is one line and the pointer at the rest of it:

<!-- shipped-text:web-sas-advisory -->

> Compare this code with the one your node's CLI shows for this session. A match catches accidental
> wrong-node routing and some network interposition while the loaded code is honest; it cannot
> protect against the Hub operator, who serves this page, and it does not rule out someone sitting
> in the middle.

<!-- /shipped-text:web-sas-advisory -->

<!-- shipped-text:web-sas-more -->

> Settings → Security explains what else this tab cannot check.

<!-- /shipped-text:web-sas-more -->

In Settings → Security, the same code is drawn with the longer account. It names both of the reasons
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

The code renders in the desktop thread connection popover and again in Settings → Security, which is
where the popover's pointer leads. That section is owner-only in hosted mode, so the popover asks
whether this reader can open it before it points there: a viewer, an operator, or an owner whose
role snapshot has gone stale is shown the longer account in the popover itself, with the `ryco e2ee
sessions` sentence in place of a pointer at a section their settings list does not have. The narrow
phone presentation does not draw the code at all, and its disclosure deliberately points at no
comparison it cannot show; on a phone, use the Ryco mobile app.

## Reconnect, replay, and delivery uncertainty

Each demanded environment has at most one active connection attempt in a tab, and the hosted Web
platform ceiling permits at most three connected environments. Only demanded environments
reconnect after a relay drop or a Hub session loss (a deploy, a restart, a proxy interruption): a
warm environment nothing demands is released and reconnects on demand, so a Hub restart does not
spend a reconnect, and a ticket, per warm environment of every tab. Reconnect uses exponential
backoff from one second to 60 seconds with bounded ±20% jitter and bounded Hub `retryAfterMs` input.
The delay resets only after a session remains stable for 60 seconds. A demanded environment
waiting in that backoff retries after a short random delay when the directory reports its node
online again: at most once per presence change and per ten seconds, never before a Hub
`retryAfterMs`, and not while the Hub rate-limits the connection, has closed it as a slow consumer,
or is draining. The backoff itself keeps growing until a session stays stable. Every retry obtains
a fresh ticket.

Retryable cases include generic browser network failure, node offline, Hub draining, connection
replacement, rate limiting, slow-consumer closure, and retryable ticket expiry. Revocation,
authorization removal, unsupported protocol, invalid protocol, and authentication-required failure
are terminal. Browser WebSocket APIs intentionally do not reveal whether a pre-handshake network
failure was DNS or TLS, so the hosted UI reports those cases as a bounded network failure; direct
and node-side diagnostics retain their more specific classification.

Held demand is re-planned as soon as the directory reports its node online again, or the directory
and browser become current while its node is online. A terminal relay failure is never re-planned
from those edges — the browser turning current is then the failure itself — so a node that failed
its handshake waits for the 25-second demand renewal or for its presence to come back, and is never
hot-retried.

Access recovery is separate from relay reconnect. When the page returns to the foreground or comes
back online, the client revalidates the Hub session and directory, opens a fresh relay attempt, and
accepts a current snapshot before mutation. When that session check cannot reach the Hub — no
answer, the request deadline, a 408, 429, or 5xx response, or a body that is not the Hub's (a
captive portal or proxy page) — session material is kept, the account stays unavailable or the
browser stale (neither grants mutation), and the same full check retries on its own with
exponential backoff from one second to 60 seconds, bounded ±20% jitter, and bounded Hub
`retryAfterMs`, in the foreground only. A definite Hub answer is not retried on a timer; the next
foreground or online signal, or Refresh, re-checks it. Only the Hub's own `401` or
`session_invalid` answer ends the session.

On reconnect, the existing shell and thread subscriptions resubscribe. Ryco marks the session
`replaying`, accepts the authoritative shell snapshot, discards duplicate/older projection versions,
reconciles thread subscriptions, and then marks it ready. Conversations, running tasks, approvals,
and terminal projections recover from the node, never from Hub.

Every RPC method carries an explicit delivery-effect classification beside its access tier
(`RPC_DELIVERY_EFFECT_POLICY` in `packages/shared/src/rpcAccessPolicy.ts`). The tier is not an
effect: file, VCS, and source-control reads are operator-tier and still reads. A method nobody
classified counts as a mutation.

- **Reads** — unary reads and long-lived read streams such as the Agent Control queue or device
  events — never make delivery uncertain. Losing one is harmless, and subscriptions resubscribe on
  their own. The client tells a request refused only until its session is current (the role is
  still being validated, the transport is reconnecting, or the rebuilt client's session has not
  accepted its snapshot) from one refused for good (a role below the method's tier, a method no
  hosted role may call, or a terminally failed transport). A subscription refused only for now —
  such as the Agent Control queue on a client rebuilt during recovery — keeps re-checking locally
  with a capped backoff and starts once the session is current, instead of ending. Observe-only
  unary reads do not wait that long: they are admitted as soon as the replacement channel is
  online, before its session has accepted the snapshot. A read that refreshes derived state or
  reaches out (a fetch, a model call, a credential) still waits for the session to be current, as
  do read streams other than the session's own subscriptions, and an unconfirmed delivery holds
  every read until the replacement session has accepted its snapshot.
- **Orchestration commands** (`orchestration.dispatchCommand`) are idempotent by receipt: the node
  persists a receipt for each `commandId` in the same transaction as the command's events and
  answers a repeated id from it — before normalizing the command again — with the original result
  or rejection. `thread.archive` is the exception: a repeated archive is normalized again and its
  follow-ups (stopping the session, closing terminals) run again, since a first attempt may have
  been cut off between committing and cleaning up, while the engine still answers the archive
  itself from its receipt. A repeated id that arrives while its first attempt is still running (a
  bootstrap turn start creating its thread and worktree has no receipt until its turn starts) waits
  for that attempt and gets its outcome; the attempt runs detached from the request that started
  it, so a client disconnecting mid-command does not cut it off halfway.
- The hosted client holds the caller's promise through a reconnect and sends the identical envelope
  once more, at most once, after the environment's session has a fresh ticket, a completed
  handshake, and an accepted snapshot again. Which failures leave a command's delivery unknown is
  decided by what they are: a failure of the transport itself — a socket error, an interruption, a
  disposed or reconnecting client — or any failure at all once the connection was lost after the
  send. Whatever the node answered on a live connection is the command's outcome and reaches the
  caller at once: its typed rejection, its role check, or the defect it returns for a payload it
  cannot decode (a hosted bundle newer than the node). So does a refusal by the client before
  sending. The replay stays inside the same environment and the same account session — readiness
  is bound to those, not to a hosted generation, because every recovery publishes a new generation
  and readiness is only published from the current one. Hub session-id rotation on resume is the
  same account session. Leaving the node, signing out, or session expiry fails the command closed,
  as does a two-minute horizon after sending. Leaving covers a command still in flight when the
  node was left, too: returning to that node within the horizon is a new visit, and nothing
  replays across visits. The envelope lives in memory only, and the node re-authorizes the replay
  under the current role. Receipt retention must always outlive that horizon.
- A command Ryco cannot confirm — the horizon passed, the replay was lost to a second drop or
  refused (locally or by the node's role check), or a replayed bootstrap turn start failed on what a
  node restart left half-created — is reported to the control that issued it as unconfirmed, never
  as accepted or failed, and the environment becomes `delivery unknown` as below. A client that has
  not taken over its commands this way keeps them tracked like any other mutation.
- **Every other mutation** — terminal input, git and file writes, Agent Control decisions — is
  never automatically replayed merely because the relay disconnected. If no response chunk or exit
  made its delivery known, the environment's session becomes `delivery unknown`; the UI does not
  claim that the action was accepted. Once the replacement session has accepted a snapshot, reads
  work normally again, while new mutations to that environment wait until the user has seen the
  notice shown inline on the environment's threads and continued. A mutation tried meanwhile is
  refused with its own answer pointing at that notice, not the "still synchronizing" one, since
  waiting alone will not admit it.

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

Navigation opens a versioned, build-generated static boot document from the shell cache, with a
network fallback if that document is absent. The document contains no account, node, project, or
conversation data. With **Account → Overview → Remember this browser** enabled, the page restores
bounded encrypted text snapshots from its own IndexedDB store before session checking finishes.
This setting is off by default; anyone with access to a remembered browser profile can read its
saved copy offline. Returning online does
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

Hosted mode keeps authentication material and every value the relay payload encryption
layer produces out of localStorage, sessionStorage, IndexedDB, service-worker caches, URL/history
state, configuration exports, and browser logs. The encryption values are the browser's ephemeral
agreement key material, its handshake and session-key state, its in-memory downgrade check, and the
session verification code: all of them live in process memory, the browser has no storage class any
of them may enter, and each is erased when the channel — or, for the downgrade check, the
application session — that produced it ends. Draft, terminal, general UI, script-selection,
and other generic local-storage hooks use in-memory storage. The explicitly enabled remembered-browser
feature stores bounded conversation text, workspace metadata, text drafts, and scroll positions in
encrypted IndexedDB using a separate non-exportable local AES-GCM key. Relay keys and credentials
are never reused for this storage. Disabling the feature or observing sign-out, expiry, account
change, or loss of node eligibility deletes the corresponding records and keys. Restoring records
does not establish a session or role; fresh snapshots reconcile the saved display. See
[cache bounds and behavior](unified-workspace.md#cache-and-failure-behavior).
A separate, schema-validated inbox
preference record stores only three finite user choices: the auto-settle interval, whether AI Focus
is enabled, and its refresh interval. It contains no node identifiers, rankings, model/provider
preferences, content, or authentication material. These browser-local choices survive reloads. The
auto-settle interval there applies only to nodes that keep no rule of their own, and is what a first
connection hands to a node that keeps the rule but has none set.
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
attachments, or relay payloads to errors, diagnostics, metrics, or exports. The remembered-browser
text projection and the opt-in cloud history projection below are the conversation-persistence exceptions; neither stores relay frames,
authentication or relay encryption material, terminal output, files, or attachment bodies.

## Cloud thread history

Nodes can opt into bounded Hub-backed history with `RYCO_HUB_THREAD_CACHE_ENABLED=true`.
The Hub then holds readable project/thread metadata and recent message text. This is an explicit
privacy change from an opaque relay: encryption on the execution channel does not conceal the
separately uploaded history from the Hub. Existing nodes do not upload content by default.

After account and directory authorization, the hosted app loads each authorized node's saved
index and the routed thread's saved text without waiting for that node's relay. This works in a
fresh browser, independently of Remember this browser, and can show a read-only preview while a
node is offline. Hidden pages stop polling; stale account/directory responses cannot populate the
next account's state. Live synchronized state wins over cached data. A saved projection never
publishes transport readiness, an effective role, or mutation authority.

The preview includes at most 150 recent messages per thread. Full history, sending messages,
terminals, files, and git still use the node. Compatible old Hubs without this API fall back to the
existing relay and local preview paths. See [connector configuration](hub-connector.md#optional-cloud-thread-history)
for upload bounds and removal behavior.

## Accessibility and layout

Authentication, invitation, directory, and connection popovers use native keyboard controls,
explicit labels, focus-visible indicators, focus movement on flow changes, validation messages, and
polite/assertive live regions. Online, offline, stale, reconnecting, delivery-unknown, and
relay-encryption states use text and icons in addition to color, and an encrypted browser channel is
given an advisory rather than a success treatment, so the weaker configuration is not dressed as the
stronger one through styling. The same shell adapts from narrow browser widths through tablet and
desktop; there is no second hosted feature UI, with one deliberate exception — the session
verification code renders only in the desktop thread connection popover, so the narrow presentation
offers no comparison to make and its disclosure points at none. That sameness is otherwise about
presentation and feature surface only. It says nothing about the encryption tier, which does fork
between this browser client and the Ryco mobile app, as stated at the top of this document.

The desktop workspace has no global connected-node control. Nodes stay connected in the background,
so pages that belong to no thread — home, Settings, Diagnostics — name no node, and an open thread's
header names that thread's own node and its connection: where the thread runs and over what channel,
whichever node the selection is on. Every state keeps its word and its glyph; only a steady
encrypted browser channel is drawn quietly, and a fallen-back channel always reads "Legacy
connection". Its popover holds the role and full status, an unconfirmed delivery to acknowledge, the
session verification code, and **Manage devices**, which opens the device directory. Switching nodes
is opening another node's thread from the inbox, or a node from that directory; hosted Settings
chooses which node it edits with its own **Switch device** control. Signing out and installing or
updating the app live on the account page, one **Account** entry away in the sidebar footer, and a
node that failed to connect offers **Manage devices** and **Sign out** on its own page. The phone
presentation keeps its connection pill and sheet.

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
- **Delivery unknown:** inspect the authoritative node state — the thread's notice names the
  machine — before issuing the action again, then continue from the notice. Orchestration commands
  end up here only when their replay by `commandId` could not confirm them.
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
