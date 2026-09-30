# Sidebar Undo

Archive, Settle, Snooze, and Unpin offer an accessible **Undo** notice for five seconds.
The notice appears immediately, shows progress while the original command is pending, and
queues an early Undo behind its acknowledgment. An Undo submitted while valid shows progress
until its result arrives. Delete has no Undo.

Up to five notices can coexist. Actions on different nodes or threads stay independent;
a newer action on the same thread replaces its older notice. A failed original action removes
its notice. A failed Undo reports the error and keeps the authoritative state. There is no
automatic retry of a mutation whose delivery might be uncertain.

Undo restores the prior settlement override, settlement time, snooze deadline and time, and
sorting timestamp. Existing manual positions, local pins, and priority rankings are preserved.
Unpin restores the local pin using the existing sorter. Archive Undo also reopens the thread
when Archive displaced it and the user has stayed on the resulting route. Manual navigation wins.

Web uses the existing stacked thread toast. Native uses a short-lived notice with a labeled
Undo button and a screen-reader announcement. Native exposes Undo where its existing surfaces
expose the actions; it does not add a pinning surface. The frozen web phone presentation is unchanged.

## Safety and compatibility

Server Undo requires the owning node's accepted shell attempt and its normal
mutation readiness. Disconnects, replacement shell attempts, lost authorization, and thread or
project removal invalidate server notices. Pin and Unpin remain local and available offline
and to viewers. Local Unpin Undo uses the cached thread/project and local pin state, without
requiring server mutation authority. It is offered only when that cached state is present;
its removal or revision change, including a change back to the same values, invalidates Undo.
Local pin changes also invalidate Undo, including changes back to the same value.

Servers advertise `threadSidebarUndo`. Older servers still accept their existing lifecycle
commands, but clients do not offer server Undo for them. Local Unpin Undo is independent of
the connection and server capability.

The serialized orchestration engine retains at most 256 server-owned receipts for 30 seconds,
allowing an in-flight Undo to reach the server after the notice closes. Receipts capture only
sidebar restoration fields and weakly reference the resulting thread projection. Subsequent client actions or lifecycle changes invalidate the receipt, including changes back
to the same values within the same millisecond. Safe provider progress advances the conditional
revision and retains its newer timestamp, so response streaming does not make Undo unusable.
Parent project/worktree revisions invalidate receipts. Checkout cleanup also refuses Undo.
Restoring a prior settled or snoozed state rechecks current requests, queued turns and goal
synchronization, so provider progress cannot hide newly pending work. Unrelated thread changes do not.
A restart discards receipts. Clients cannot supply restoration values.

The server reverses through the existing Unarchive, Unsettle, and Unsnooze event paths.
Optional restoration fields on the latter two events retain exact prior state in both durable
and client projections. No new persistent history, provider interaction, or mobile authorization
policy is introduced.

The five-second notice and position restoration follow the behavioral reference in
[T3 Code's thread sidebar guide](https://github.com/pingdotgg/t3code/blob/main/docs/user/thread-sidebar.md).
