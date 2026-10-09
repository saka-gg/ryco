# Stable desktop connections

## Outcome

Remote machine recovery runs silently. A transient connection failure preserves the visible
workspace and never publishes a retry countdown, disconnect toast, recovery toast, or slow-RPC
toast. Machine availability and actionable authorization failures remain visible in their existing
machine and task surfaces. Command delivery must remain truthful.

## Immediate implementation

1. Use a bounded persistent retry policy for desktop remote environments. An extended retry
   budget must never fall through to a zero-delay loop. Scope status to its environment.
2. Preserve retryability and server retry-after hints across desktop IPC. A terminal relay
   failure stops automatic transport retries until an explicit new connection is requested.
3. Make main-process activation single-owner and cancellable across every asynchronous boundary.
   Closing, expiry, disposal, or superseding an attempt prevents late socket publication and
   releases native handshake resources, including partially successful preparation.
4. Make renderer socket close settle locally and detach its listener even when main has no
   active socket. Ignore late activation completion and stale transport events.
5. Remove automatic transport notifications. Keep recovery behavior independent of notification
   presentation and leave hosted browser recovery with its authoritative lifecycle owner.
6. Serialize and coalesce desktop environment connection demand. Preserve healthy established
   connections instead of restarting them merely because another consumer requests them. Reacquire
   leases that expired during renderer sleep, and report readiness only for a current shell snapshot.

## Shared, mobile, and node recovery

The shared hosted attempt factory uses persistent bounded retries and scopes connection status
to its environment. Reset, disposal, overlapping preparation, and selection changes fence ticket
issuance and socket callbacks. A stale unauthorized response cannot expire a replacement account
session. Terminal failures stop transport retries until a new session is explicitly started.

Mobile lifecycle signals suspend readiness synchronously and serialize recovery behind background
cleanup. Foreground and online signals coalesce. Backgrounding, loss of connectivity, sign-out,
and a new user selection cancel pending retained-node wake work. Concurrent demand for one node
shares its acquisition. Late release cannot erase a replacement connection's record.

Node connectors detach failed resources before asynchronous channel cleanup. Each connection owns
its ordered frame queue, so slow retired work cannot block a replacement. Automatic wake nudges
respect the Hub's retry-after floor. Mobile workspace recovery preserves the saved view without
retry alerts or a persistent recovery spinner; machine availability remains explicit.

## Subsequent transport work

Shared per-environment supervision is the migration direction for all platforms. Hosted stream
resume requires a complete projection baseline, log identity, authorization scope, projection
version, and a current caught-up acknowledgement; a trimmed display cache is insufficient.
Existing receipt-backed command replay remains authoritative. Protocol changes must retain a
bounded snapshot fallback and cannot confer mutation authority from cached content.

Compare the repaired relay with a managed-tunnel route behind the same node identity and
supervisor. Measure connection preparation, handshake, readiness, interactive latency, queue
pressure, and recovery separately. Tunnel adoption is conditional on that comparison, not a
prerequisite for correcting the desktop defects. Keep deployment and private operational evidence
outside this public repository.

## Validation

Regression tests cover retries beyond the former seven-delay limit, independent local and remote
status, terminal versus transient failure, retry-after, close/dispose during each activation
stage, partial preparation failures, duplicate activation, and listener/resource cleanup.
Exercise repeated demand and cancellation while connecting. Browser checks prove interruptions
and recovery do not generate transport toasts or replace rendered workspace content.
Use the repository's pinned Bun and frozen install. Run focused checks during development and
the required repository/browser backstop for changes crossing runtime and desktop IPC boundaries.
Real machine sleep/wake and a prolonged fault-injection soak remain separate qualification steps;
unit tests do not establish production latency or availability.
