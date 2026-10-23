# Shared thread notification events

`createThreadNotificationProjector` is exported by `@ryco/client-runtime/state/threads`.
It converts accepted shell state transitions into notification candidates for web,
desktop, and native adapters. It does not request permission, display notifications,
register device tokens, send remote push messages, or provide background delivery.

`startThreadNotificationFeed`, from the same module, wires the projector to the
connection supervisor. Every client runs one feed and owns only delivery:

- The web app, in the browser and in the desktop window, turns candidates into in-app
  toasts, browser or desktop notifications, sound and a badge. A tiny shell component
  loads the alerts once the shell is idle; they wait for client settings to load, run the
  feed while any alert is on, and stay off on the frozen phone tier.
- The desktop main process shows the OS notification and the dock or taskbar badge for
  the renderer.
- The native app schedules local notifications while it runs.

## Integration

1. The supervisor reports what the shell stream committed through
   `subscribeShellAcceptance`: each snapshot it applied, and each batch's accepted events
   in order, after the store commit and its after-hooks. A listener can run inside a store
   mutation barrier, so the feed only projects there and delivers candidates in a
   microtask, after revalidating each with `isCurrent`.
2. `readGeneration(environmentId)` is the connection's `shellSnapshotReadiness` token, the
   per-socket-attempt evidence that sending already relies on. It is `null` while
   disconnected, resubscribing, or before the attempt's snapshot or resume. Hosted items of
   a stale lifecycle generation are fenced before they reach the supervisor, so nothing
   from them is ever accepted or observed; the attempt token needs no second check.
3. The feed baselines silently, from the store at the sequence `readShellProjectionSequence`
   returns (which applies buffered shell items first), when a connection publishes a new
   token (a new attempt's snapshot, or a resume), when the stream applies a snapshot
   within the same attempt, when a connection registers, and when the feed starts. A
   resumed stream is baselined on the shell it holds, so replayed events are observed.
4. Each accepted `thread-upserted` event is observed with its own sequence and the
   summary the store writes for it (`mapThreadShellSummary`), not the batch's final row,
   so a thread created and asking for approval within one batch still alerts. Accepted
   removals go to `remove`. Several threads may share one envelope sequence; duplicate
   rows at that sequence and older envelopes are ignored. Cached rows (cache hydration,
   the Hub read cache) and optimistic client edits never reach the supervisor, so they
   never reach the projector.
5. A candidate carries `ref`, `groupKey`, `kind`, `title`, `turnId`, and `id`, and the feed
   adds whether the thread was delegated. Group by `groupKey`; route to the exact
   environment and thread in `ref`. Revalidate with `isCurrent(candidate)` after every
   asynchronous step (permission prompts, platform calls). A new connection, snapshot,
   resolved request, or removed thread invalidates queued candidates.
6. The feed clears an environment whose connection is removed or replaced, and `stop()`
   resets the projector. It retains only transition metadata, not message bodies or audio.

The projector shares the Inbox's activity and snooze classification. The caller passes
the snooze rule (`isThreadSnoozed` from `@ryco/shared/threadSnooze`), so a client that
loads its alerts lazily shares the copy its shell already loaded. It emits approval,
input, ready-plan, completed-turn, and failed-turn transitions. Live background work
postpones completion. Repeated upserts, archived threads, stale generations, old sequences,
and threads first seen without a baseline do not generate alerts. Already known terminal
turns are not announced again after an approval resolves or a plan is dismissed.

This deliberately favors avoiding replay over offline catch-up: a completion that first
appears in a reconnect snapshot stays silent, and one still buffered when the connection
dropped can be too. Only connected environments alert. A hosted browser tab that has
been hidden for a while releases the connections no open view holds and takes fresh
snapshots when it returns, so while it is hidden it alerts only for the nodes it keeps
connected. Delivery preferences, visible thread suppression, durable notification history,
and Live Activities remain adapter work.
The opaque generation token is local runtime metadata and must not be serialized into a
push payload. Titles are user data; platform adapters own lock-screen privacy preferences.
