# Sidebar Undo

Archive, Settle, Snooze, and Unpin offer an accessible **Undo** notice for five seconds.
The notice appears immediately, shows progress while the original command is pending, and
queues an early Undo behind its acknowledgment. An Undo submitted while valid shows progress
until its result arrives. Delete has no Undo.

Up to five notices can coexist. Actions on different nodes or threads stay independent;
a newer action on the same thread replaces its older notice. A failed original action removes
its notice. A failed Undo reports the error and keeps the authoritative state. There is no
automatic retry of a mutation whose delivery might be uncertain.

A bulk Settle or Snooze shows one notice for all its threads, which counts as one of the five. It
changes at most 100 threads, sending four commands at a time. Threads whose node is not ready, or
reconnects before their command goes out, are skipped and reported; nothing is sent for them. The
five seconds start once every command has finished. A notice still applying after 25 seconds closes
without Undo, so Undo stays within the node's receipts. Undo restores every thread whose node is
still on the same connection. A failed command, a newer action on one of the threads, or that
thread's node reconnecting takes only that thread out of the notice. A newer action on a thread
whose command has not gone out yet, a later bulk action's included, also means nothing is sent
for it: the newer action stands. A node keeps its 256 newest Undo receipts, so once the notices
cover more of one node's threads, the oldest notices give up their oldest threads and their counts
shrink. A partly failed Undo is reported once, with how many threads it could not restore. Move to
Active and Unsnooze have no Undo, in bulk or for one thread.

In the Inbox, Cmd-click (Ctrl-click off Mac) adds or removes a row and Shift-click selects the
displayed range, as in the project sidebar. The context or ... menu of a selected row offers
Settle, Move to Active, Snooze, Unsnooze, Mark unread and Delete for every selected row that
allows it, with the count in each item. Rows the list stops showing leave the selection. The
Recent header's Settle finished button, shown on hover or focus, settles every finished thread
there whose result you have seen, oldest first, folded delegated threads included; unseen
results stay. Bulk Settle and Snooze, Settle finished included, use the notice above; Delete
keeps its confirmation. The frozen web phone presentation offers neither selection nor Settle
finished.

Undo restores the prior settlement override, settlement time, snooze deadline and time, and
sorting timestamp. Existing manual positions, local pins, and priority rankings are preserved.
Unpin restores the local pin using the existing sorter. Archive Undo also reopens the thread
when Archive displaced it and the user has stayed on the resulting route. Manual navigation wins.

Web uses the existing stacked thread toast. On web and desktop, `mod+z` (the `thread.undo`
command) also undoes the newest notice. A new notice claims the key in the composer until you
press another key or edit text there, including a paste, cut or drop from a menu; after that the
key is the composer's own undo again. Other text fields, code editors, dialogs, the model picker
and the terminal always keep their own undo. Without a notice the key is left alone, so native
undo and the desktop Edit menu work as before. Holding the key undoes once.

Native uses a short-lived notice with a labeled Undo button and a screen-reader announcement.
Native exposes Undo where its existing surfaces expose the actions; it does not add a pinning
surface. The frozen web phone presentation is unchanged.

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
