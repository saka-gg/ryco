# Unified cross-node workspace

Ryco presents work from every eligible machine as one workspace. Inbox, Projects, search, and new
work are workspace views; choosing a machine is not a prerequisite for using them. A machine stays
visible as the provenance and execution location of each physical project, worktree, and thread.

The Hub is not an aggregation service. Relay payload encryption keeps project and thread content
node-owned, so Mobile, Desktop, and hosted Web build the unified view from environment-scoped node
snapshots and client-owned caches. Hosted Web can also remember bounded conversation text when
the user enables **Account → Overview → Remember this browser**.

## Physical ownership and logical projects

Every physical resource is keyed by at least `(environmentId, resourceId)`. Two machines may use
the same project, worktree, or thread ID without colliding. Routes, subscriptions, leases, outbox
entries, and mutations keep that environment identity through to RPC.

Projects with the same unambiguous canonical repository identity may be grouped as one logical
project for presentation. Every physical copy remains visible and independently owns its path,
worktrees, threads, trust, role, presence, and connection state. Repository identity ambiguity
keeps copies separate. A logical project key or repository identity is never an RPC target.

Opening an existing thread navigates directly to its owning machine. Ryco may render cached metadata
while it acquires that environment; it never silently sends an existing thread mutation to a
different copy of the repository.

## New work

New work chooses an eligible physical copy automatically. The ranking is deterministic:

1. the user's explicit pre-send override;
2. the most recently used eligible copy;
3. the local Desktop copy when otherwise tied; and
4. stable environment ordering.

The chosen machine is visible beside provider and model before the first send. Changing it preserves
the authored prompt, attachments, provider, model, and interaction settings. After the first send,
the created thread remains owned by that machine. If no online, authorized, eligible copy exists,
Ryco keeps the draft and reports **No verified machine available** instead of guessing.

## Demand-driven connections

Cached lists do not connect to machines. Mounted work retains only the live streams it consumes:

- thread detail;
- VCS status; and
- provider status.

Those scopes are refcounted and released on unmount. Mobile, Desktop and hosted Web use the
assessed absolute limit of three concurrent environments per client (per tab on hosted Web). Hosted
Web reached it with its own qualification (see the "Hosted Web warm set qualification (measured)"
section of [relay-capacity-assessment-3b.md](relay-capacity-assessment-3b.md)); the sustained
full-PNG simulator fallback stays bounded because a tab samples at most one device preview at a
time. Demand beyond the platform limit waits; retained work is not evicted and the limit is never
exceeded.

The connected environments form a warm set ordered by recency. LRU recency keeps an unretained
connection warm until capacity is needed, so switching among up to three recently used machines
selects a session that is already live instead of opening a new one. Hosted Web also holds demand
for an environment while one of its server threads has queued messages, and for a few seconds after
a navigation press on one of its thread rows.

Only demanded environments (the one in view, or one holding a scope) reconnect after a relay or Hub
drop; a warm environment nothing demands is released instead and reconnects when it is demanded
again, so a Hub restart costs one reconnect per demanded environment rather than one per warm one.
Backgrounding a native client releases non-retained connections; hosted Web does so once a tab has
been hidden for 90 seconds.

On hosted Web and Mobile, foreground or visibility recovery restores retained demand and then the
last warm set: the up to three most recently used environments, never the catalog. The warm set
comes back as preemptible leases that last 10 minutes unless use renews them, only after the
environment in view has connected, and staggered after it. Warm leases take only free connections:
they never displace a mounted view or other demand and never close a connection to make room.
Backgrounding drops them (on hosted Web also a page freeze or going offline), and the next
foreground restores them. They get one connection attempt and do not count as demanded: a warm
environment whose connection drops, is refused or is rate limited is released, and is not restored
again for a few minutes unless the user opens it or its directory entry changes, so the Hub-restart
reconnect burst is unchanged. A warm environment waiting for a free connection is not shown as
reconnecting or queued. Every restore stays within the limit of three connections and is staggered;
there is no reconnect-all-cached-machines path.

Hosted Web restores a warm set only in a visible tab, so the tabs of one browser do not each wake
the same machines. At boot, once access is revalidated, a remembered browser restores the machines
it cached the same way, newest first, and returning to the home screen re-warms the recently used
machines. Mobile keeps the recently used environments in memory only, so a new process starts with
none, and it re-warms only on returning to the foreground.

On Desktop, switching to another app or window does not background the client, so warm connections
survive it. Minimizing or hiding the window, or locking the screen, backgrounds it after a
three-minute grace period; sleeping does so at once, and any return to use ends it. Machine
presence is refreshed when the window gains focus (at most every 30 seconds), on wake and unlock,
and every 90 seconds while a window is in sight.

## Cache and failure behavior

The shared workspace index contains bounded project, worktree, thread-shell, and status summaries.
Hosted Web's optional remembered-browser cache additionally stores recent message text, text drafts,
and scroll positions in page-owned encrypted IndexedDB. It uses a non-exportable per-account AES-GCM
key, with origin, account, environment and format bound to each record. Up to 16 environments,
32 conversations per environment and 150 messages per conversation fit within a 12 MiB ciphertext
budget; each environment record is limited to 2 MiB. Larger histories are trimmed, with the routed
thread preferred. Attachment bodies, preview URLs, terminal output, provider events, detailed diffs,
credentials and transport secrets are excluded. Metadata persistence uses this same opt-in boundary.

Remembered text can render before session checking, including offline. Anyone with access to that
browser profile can read it. Stored data never restores a role, session, streaming state, mutation
lease or replay cursor. Live state wins over a late cache read. A fresh bounded detail snapshot
reconciles remembered text; a trimmed display window is not a valid incremental replay baseline.
Explicit sign-out, observed expiry, account change and loss of node eligibility purge remembered
data. Disabling the setting deletes records and keys. Cross-tab invalidation and account epochs
prevent pending writes from restoring a deleted copy.

Desktop can also keep recent conversation text on the device, so a cold start shows a thread before
the relay connects. This is a separate, device-local exception to the opt-in browser boundary above.
The **Keep recent conversations on this device** setting controls it; it is on by default, and
turning it off deletes what was kept. The Desktop main process owns the cache. The renderer hands it
bounded display content and reads it back, and never receives a key. The cache is one file
encrypted with the operating system's protected storage, and nothing is written when that storage
is unavailable. It holds up to three machines of one account, each with its 32 most recently
visited conversations (150 messages at most per conversation) within about 1.9 MB; larger histories
are trimmed oldest-visited first, with the open conversation preferred. Only message text is kept:
attachments, drafts, scroll positions, tool output, credentials and transport secrets are not.
Sign-out, another account signing in, a machine being removed, revoked or losing eligibility,
revoking this installation's account authorization, and turning the setting off all delete the
affected content. Cached text is display only: a live snapshot always wins over it, it is never a
replay baseline, and it grants no role, session or mutation authority.

The service worker only caches build-generated static entry points and immutable assets. Its
data-free boot document lets the page open the encrypted cache while offline; authenticated APIs,
relay traffic and live HTML responses never enter CacheStorage.

Failures stay with their owning environment:

- an offline machine marks only its rows stale or unavailable;
- a failed acquisition does not create a workspace-wide disconnected state;
- delivery uncertainty is recorded per environment and row;
- revocation, removal, or loss of eligibility releases that machine's demand and applies its cache
  purge or lock policy;
- an identity conflict locks the affected history until explicit re-verification; and
- ambiguous repository identity leaves physical projects separate.

## Security tiers

Eligibility is client-tier specific and never inferred from presence alone.

| Client     | Machine identity and workspace policy                                                                                                                                                                                                                             |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mobile     | Native account credentials and signed native relay identity. Each machine is verified or re-verified independently; unknown, unverified, conflicted, revoked, or unauthorized machines cannot contribute normal workspace metadata or mutation authority.         |
| Desktop    | The Desktop client identity and a colocated node identity are separate principals. Native Hub trust, credentials, keys, tickets, proofs, and handshake material remain in the Desktop main process; the renderer receives opaque handles and bounded projections. |
| Hosted Web | The browser uses the unsigned ephemeral relay tier. It never labels itself natively verified. Machines that require a native client stay locked with **Open in Desktop/Mobile** and contribute no private workspace metadata.                                     |

Viewer, Operator, and Owner remain independent from trust and reachability. A connected Viewer can
read only what its role allows; an online but unverified native machine is still ineligible.

## Navigation and administration

Mobile uses the cross-node Inbox and Projects views. Desktop and Web offer full-height Inbox and
Projects sidebar modes over the same workspace projection. Changing modes or applying a machine
filter changes presentation only; it does not reconnect, refetch, or retarget mutations.

Every client sorts a machine's threads into Active and Settled with that machine's own settlement
capability, resolved the same way everywhere: what the machine reported to this client (live, or its
last answer this session), else a descriptor it sent, else the flag a directory states, else
unknown. An unknown machine (cold, cached, or still connecting) is classified by the settlement and
snooze state it recorded, with settlement and snooze changes disabled; a machine that reports no
settlement support keeps every thread Active. Which machine is selected or connected does not change
the result.

Machines is an administration surface. It can verify an exact machine, inspect identity and channel
security, retry a connection, or perform role-appropriate account actions. There is no global
selected-machine application mode.

For the browser-specific authentication, transport, and encryption boundary, see
[Hosted Hub client](./hosted-hub-client.md). For the native delivery ledger and remaining unrelated
mobile slices, see [Native mobile delivery status](./mobile-native-status.md).
