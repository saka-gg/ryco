# Backend workflow services

These APIs and shared controllers support future web, desktop, and native integrations.
They do not add screens, composer controls, recording, OS notification delivery, or remote
push infrastructure. Resolve every operation through its explicit environment connection.
Optional methods on `EnvironmentApi.server` and `LocalApi.server` allow older adapters to
remain compatible; a method's presence does not guarantee an older server supports its RPC.

## Provider maintenance

Import `createProviderMaintenanceController` from `@ryco/client-runtime/connection`.
Supply `readEnvironment(environmentId)` with the current RPC client, provider snapshots,
active provider instance IDs, and `NodeMutationReadiness` from the existing lifecycle owner.
Do not infer owner authority from an open socket or invent a separate hosted readiness rule.

Call `preview(environmentIds)` to capture eligible environment/instance/driver identities
and versions, then pass that same preview to `execute(preview, signal?)` after the user's
update action. Preview excludes disabled, unavailable, uninstalled, current, manually
updated, active-session, and already-updating providers. Dispatch revalidates eligibility,
client identity, owner authority, and generations. The node's existing `server.updateProvider`
RPC remains responsible for installation and server-side authorization.

Execution defaults to three concurrent requests, returns immutable outcomes in preview
order, and runs each preview at most once. Cancelling skips requests not yet dispatched;
it does not claim to stop an installer already running. `unknown` means the response was
lost, rejected, nonterminal, or belonged to obsolete connection authority. Check the node's
current status before explicitly previewing again. The controller never retries ambiguous
updates or publishes returned provider snapshots; authoritative push streams own that state.

## Refreshing an agent session

Existing orchestration already accepts `thread.session.stop` through
`api.orchestration.dispatchCommand`, with `commandId`, `threadId`, and `createdAt`. Stopping
retains conversation history and persisted provider continuation information. After the
stopped state is observed, the next ordinary turn recreates the provider runtime and uses
its compatible resume path when supported.

Use the owner-only `api.server.refreshProviders({ instanceId })` to force discovery for
one instance, or omit the argument to refresh all configured instances. Codex discovery
reads through the instance's shared app-server process, starting one only when none is
running or when the binary or login changed since it started, and requests `skills/list`
for the probe's working directory; it is not a new per-thread, arbitrary-directory
discovery API. A refresh updates discovery snapshots; it does not restart an already
running agent. Ryco has no additional `fresh` flag or per-turn MCP reload barrier in this
change.

## Local voice transcription

The existing [local voice PR #606](https://github.com/saka-gg/ryco/pull/606) owns speech
contracts, local inference, model management, and the shared voice controller. This change
adds no competing speech RPC or backend. That PR remains a separate integration pending
its capture and lifecycle qualification; follow its implementation and validation status
before connecting a new client surface.

## Local task backlog

Tasks belong to the selected node; a node that supports what follows advertises the
`localTasks` capability. All methods are owner-only: `server.listLocalTasks`,
`getLocalTask`, `createLocalTask`, `updateLocalTask`, `deleteLocalTask`,
`delegateLocalTask`, `createLocalTaskFileUpload`, `addLocalTaskFile`, `removeLocalTaskFile`,
and the stream `server.subscribeLocalTaskChanges`, which sends `{ taskId }` for each task a
change touches from then on (created, edited, a file, a chat start; `{ taskId, deleted: true }`
for a deleted one), whoever made it: another client or an agent through Agent Control (see
[Agent Control](./agent-control.md#tasks)). Read the task on a change, or drop it when deleted;
the stream carries no task content. Changes a subscriber hasn't read yet merge per task, and one
that falls far behind (a stalled connection) gets `{}` in their place. Each subscription also
starts with `{}` once it listens (again after a reconnect): read the list on `{}`, which covers
whatever changed before it was heard. There is no
external task service; status changes of a task's chats arrive with the chats themselves.

Create supplies `taskId`, `title`, `notes`, `priority`, `dueAt`, and nullable `projectId`.
Priorities are `low`, `normal`, `high`, and `urgent`; `dueAt` is an ISO instant or null.
Listing accepts `limit` (up to 100) and `afterId`; use returned `nextCursor` to paginate.
Updates, deletion and file changes require `expectedRevision`, preventing stale writes.
Refresh and resolve a revision conflict instead of blindly repeating an outdated mutation.

### Links and files

`updateLocalTask` accepts `links`, which replaces the task's whole list (at most 20). A link
is a pull request (`pr`, number and optional URL), an issue (`issue`), a Jira work item
(`workItem`, key such as `ABC-123`), a `branch`, an existing chat (`thread`), or a `url`
with an optional label. A pull request, issue or work item may keep the `title` it had when it
was linked (up to 300 characters). Because the list is replaced, a client that retries a link edit after
a revision conflict should apply its own additions and removals to the reloaded list rather
than resend the list it built before.

A task keeps at most 8 files of at most 50 MiB together: the budget of one chat message,
because every chat started from the task carries all of them. Files live in the node's
task-file store, outside every chat and outside the chat attachment routes. To add one,
either mint a token with `createLocalTaskFileUpload({ taskId, name, mimeType, sizeBytes })`,
stream the bytes to the node's `/attachments/upload?token=` route as for chat files, and call
`addLocalTaskFile` with that `uploadToken`; or send the file inline as a `dataUrl`
(the hosted relay case). Exactly one of the two is required. A task upload can only be added
to its own task, never to a chat message, and repeating an add with the same token returns
the task unchanged; an add the task refuses hands the upload back, so the same token can be
added again, and an upload never added is deleted when its token expires. Inline files must
fit one RPC message, which the hosted relay caps at 4 MiB.
`removeLocalTaskFile({ taskId, expectedRevision, fileId })` deletes a file. Images within the
provider image limit reach the chat as images, everything else as files. Each chat gets its
own private copy of every file (a copy-on-write clone where the filesystem supports one), so
an agent editing its attachment never changes the task's original.

### Starting chats

`delegateLocalTask` supplies `taskId`, an optional `expectedRevision`, and an ordinary
`ClientThreadTurnStartCommand`. Each call starts one more chat; a task keeps every chat it
started, numbered by `sequence`. The command may target an existing thread, or create its
thread (and worktree) with `bootstrap.createThread` (plus `prepareWorktree`); a
`bootstrap.createChatProject` start is refused, because a task's chats run in a project. The
node adds every task file to the first message, and that message must be new.

Starting a chat never changes the task's revision, so typing notes never conflicts with a
start; `expectedRevision` is checked only when sent. The one exception is a task without a
project: its first chat's project becomes the task's project, which bumps the revision. While
a start may have a chat in the project (its thread exists, or it was not sent yet and has not
failed), the task's project can no longer change; a start that failed before its chat existed,
or whose chat was deleted, no longer holds it.

The node records each start before dispatching it through normal orchestration and keys it by
the command id. Retry an ambiguous start with the same command id: a concurrent or later
retry joins the running start or answers with the task once the start reached its chat, and
never dispatches twice. A command id names one start, for one thread and message; the resend
may differ otherwise (a client restamps the message's time), and a resend of a start that has
not reached orchestration yet is what runs. The same command id for another thread or message
is a conflict. A start that fails before orchestration takes its command (its worktree setup
failed, say) is kept as `failed` with its `error`, and its file copies are deleted. Resending
that command id starts it again: the resent command replaces the failed start and is checked
like a new one, the way a draft resends a failed worktree launch. Its bootstrap may create a
thread id the failed attempt created and deleted again, as orchestration allows for any
permanently deleted (not trashed) thread. A start whose command orchestration refused fails
again with the same error (reason `conflict`): start again with a new command, message and,
for a new thread, thread id. When the node
restarts, an unsent start whose command orchestration had accepted counts as dispatched, and
any other unsent start fails with "The chat start was interrupted by a restart." Files in the
task-file store that no task references are removed after a restart once they are an hour
old.

### Status

The stored task `state` is `todo` or `done`. Each chat in `delegations` reports its own
`status`, judged by the exact first message it was started with: `starting`, `running`,
`needs-you`, `review` (its first turn ran and ended, whether it completed, was stopped or
broke), `failed` (it never got going: its start failed or was refused, or a Stop cancelled it
before any turn), or `unavailable` (the chat is gone).
The task's `status` is `done` for a done task, `unavailable` when its project is gone, and
otherwise its most urgent chat: `needs-you`, then `starting`, `running`, `failed`, `review`;
`todo` when it has no chat that still exists. `@ryco/shared/localTasks`
(`aggregateLocalTaskStatus`) holds that order for clients. A completed agent turn means
**Review**, never automatic **Done**: the user marks the task done with a revision-checked
update. A done task's chats are not read again; they report `review` (or `failed`). Reusing a
chat for later work does not change which turn belongs to the task.

Deleting a task deletes its starts and its files; the copies inside its chats belong to those
chats and stay.

Agents work with the same tasks through the private Agent Control tools (see
[Agent Control](./agent-control.md#tasks)): their edits are these calls, a chat they start is a
start like any other (recorded before it is dispatched, with the task's files), and a delete they
ask for runs only once the user approves it.

## Daily recap

Call the owner-only `server.getDailyRecap({ date, timeZone, limit? })` on the chosen node.
`date` is a local calendar date (`YYYY-MM-DD`); `timeZone` is an IANA zone such as
`Europe/Berlin`. The response includes the exact UTC interval `[from, to)` for that day.
The two local midnights are resolved separately, so daylight-saving days can be shorter
or longer than 24 hours. Invalid dates, invalid zones, and nonexistent local days fail.

Completed commentary still associated with an active session turn is excluded until that
turn settles. Turn counts include completed, failed, and interrupted turns whose completion timestamp
falls within that interval. Deleted threads/projects are excluded. Completed and failed
sections list distinct threads independently, so one thread may occur in both. The limit
is per section (default 20, maximum 50); `totalThreads` and `truncated` describe omitted rows.

`needsAttention` represents current outstanding approvals, input, plans, and session
errors across all dates, excluding archived threads. It is intentionally not a historical
snapshot of attention on the selected day. This is a deterministic read of Ryco state,
not a model-generated summary, usage report, or scheduled notification.

## Notification candidates

The shared projector emits grouped thread attention/completion/failure candidates without
platform side effects. See [Thread notification events](thread-notification-events.md) for
baseline, sequence, generation, and delivery-time validation requirements. Notification
permissions, platform delivery, device registration, and Live Activities remain separate
integration work.
