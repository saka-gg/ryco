# Shared thread notification events

`createThreadNotificationProjector` is exported by `@ryco/client-runtime/state/threads`.
It converts accepted shell state transitions into notification candidates for web,
desktop, and native adapters. It does not request permission, display notifications,
register device tokens, send remote push messages, or provide background delivery.
Applications must wire their own delivery adapter before this produces user-facing alerts.

## Integration

1. Provide `readGeneration(environmentId)`, returning the existing connection lifecycle's
   opaque attempt token only while its authorized shell is current. Return `null` while
   disconnected, recovering, or awaiting a current snapshot. Do not create a second
   readiness policy for notifications.
2. After the authoritative shell reducer accepts a snapshot, call `baseline` with its
   sequence, token, normalized `SidebarThreadSummary` rows, and current time. Baselines
   never emit historical notifications. Every replacement connection needs a baseline.
   For a resumed stream, seed the already accepted local shell at its accepted sequence
   before applying replayed events.
3. After accepting each live thread upsert, call `observe` with that event's sequence,
   token, normalized thread, and current time. Feed accepted thread removals to `remove`.
   Multiple distinct threads may share one accepted envelope sequence; observe each
   once. Duplicate rows at that sequence and older envelopes are ignored.
   Do not feed cached rows or optimistic client edits into this projector.
4. A non-null result is an immutable candidate with `ref`, `groupKey`, `kind`, `title`,
   `turnId`, and `id`. Group by `groupKey`; route to the exact environment and thread in
   `ref`. Revalidate with `isCurrent(candidate)` immediately before delivery, including
   after asynchronous permission or platform calls. A new connection, snapshot,
   resolved request, or removed thread invalidates queued candidates.
5. Call `clear(environmentId)` when forgetting an environment and `reset()` on logout.
   The projector retains only transition metadata, not message bodies or audio.

The projector shares the Inbox's activity and snooze classification. It emits approval,
input, ready-plan, completed-turn, and failed-turn transitions. Live background work
postpones completion. Repeated upserts, archived threads, stale generations, old sequences,
and threads first seen without a baseline do not generate alerts. Already known terminal
turns are not announced again after an approval resolves or a plan is dismissed.

This deliberately favors avoiding replay over offline catch-up: a completion that first
appears in a reconnect snapshot stays silent. OS delivery, delivery preferences, visible
thread suppression, durable notification history, and Live Activities remain adapter work.
The opaque generation token is local runtime metadata and must not be serialized into a
push payload. Titles are user data; platform adapters own lock-screen privacy preferences.
