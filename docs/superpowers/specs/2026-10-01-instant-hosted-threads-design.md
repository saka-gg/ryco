# Immediate hosted conversation restoration

Browsers can explicitly opt in to displaying remembered conversations before session revalidation
finishes. Remembered display data carries no cached authority.

## Behavior

Previously opened conversations restore from bounded encrypted IndexedDB snapshots alongside
the cached workspace. The shell, messages, scroll position, and text drafts remain available
while session, directory, relay, and fresh shell validation run in the background. A compact
connection notice replaces the full-page reconnect surface when matching cached content exists.
Cached approvals and execution controls cannot perform mutations. Account changes, explicit
sign-out, observed session expiry, node removal/revocation, or stricter native-only policy purge
the corresponding remembered data. A temporary network failure preserves offline reading.

## Boundaries

- The shared runtime owns snapshot shape, bounds, hydration, and reconciliation. Web owns
  IndexedDB and Web Crypto adapters. No DOM dependencies enter the runtime.
- Snapshots use a separate, non-exportable local AES-GCM key; relay secrets, cookies, tickets,
  provider credentials, and attachment bodies are never persisted by this feature.
- Encryption protects stored records from accidental plaintext exposure. Code executing within
  the same browser origin can use the local key. This feature does not claim protection against
  a compromised browser profile or malicious code delivered by the origin.
- Cached records carry account/environment/thread identity, a versioned storage format, and
  metadata capture time. Late disk reads cannot overwrite live data or a newly selected account.
- The service worker remains limited to a versioned, data-free static application shell. Live
  documents, API responses, relay traffic, and conversation content stay outside CacheStorage.
- Reconnection still requires fresh authorization, a fresh relay, and a current shell before
  mutations. Thread detail may resume only from a complete, compatible retained projection;
  otherwise it takes a fresh bounded snapshot. Cached history never implies live activity.

## Implementation sequence

1. Add the shared snapshot codec and safe cache hydration, with bounds and provenance tests.
2. Add encrypted browser persistence, account/session cleanup, and incremental capture.
3. Restore the cached shell before network bootstrap and keep it mounted through recovery.
4. Preserve text drafts/scroll position and expose a clear local-cache control.
5. Keep fresh bounded detail snapshots until a complete retained baseline can be proven; never
   resume the event stream from a trimmed disk display snapshot.
6. Validate reload/offline/expiry/revocation/account switching, corrupted/evicted storage,
   cross-tab logout, stale asynchronous work, and reconnect during active streaming.

## Acceptance and validation

Remembered thread reading must require zero network responses, preserve user position, and never
enable mutations from disk. Cold and uncached routes retain bounded recovery. Measure first
cached content paint separately from live readiness; approximately 200 ms on a warm desktop
browser is a target to verify, not a guarantee. Run focused tests while developing, then the
repository backstop and web browser suite because this crosses persistence and lifecycle paths.

Encrypted Hub mirroring and server-side conversation storage are deferred. The node remains
the authoritative execution and conversation owner.

Implementation decision: the current resume protocol carries only a numeric event sequence. The
remembered display window strips active sessions, pending commands, attachments and older history,
so it cannot safely serve as that protocol's complete baseline. This iteration removes network
responses from remembered reading while retaining fresh detail reconciliation. Incremental hosted
resume requires a separately validated complete projection and log-identity contract.
