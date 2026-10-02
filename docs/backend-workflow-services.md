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
opens a fresh app-server probe and requests `skills/list` for the probe's working directory;
it is not a new per-thread, arbitrary-directory discovery API. A refresh updates discovery
snapshots; it does not restart an already running agent. Ryco has no additional `fresh`
flag or per-turn MCP reload barrier in this change.

## Local voice transcription

The existing [local voice PR #606](https://github.com/saka-gg/ryco/pull/606) owns speech
contracts, local inference, model management, and the shared voice controller. This change
adds no competing speech RPC or backend. That PR remains a separate integration pending
its capture and lifecycle qualification; follow its implementation and validation status
before connecting a new client surface.

## Local task backlog

Tasks belong to the selected node. All methods are owner-only:
`server.listLocalTasks`, `getLocalTask`, `createLocalTask`, `updateLocalTask`,
`deleteLocalTask`, and `delegateLocalTask`. There is no external task service or task push
subscription in this implementation; reread the task after mutations or relevant thread events.

Create supplies `taskId`, `title`, `notes`, `priority`, `dueAt`, and nullable `projectId`.
Priorities are `low`, `normal`, `high`, and `urgent`; `dueAt` is an ISO instant or null.
Listing accepts `limit` (up to 100) and `afterId`; use returned `nextCursor` to paginate.
Updates and deletion require `expectedRevision`, preventing stale writes. Refresh and
resolve a revision conflict instead of blindly repeating an outdated mutation.

Delegation supplies `taskId`, `expectedRevision`, and an ordinary
`ClientThreadTurnStartCommand` targeting an existing thread. The initial delegation API
rejects bootstrap commands: create a new thread through normal orchestration first, then
delegate to that thread. Delegation requires a fresh user message and respects project
identity and the existing orchestration authorization path. The persisted command identity protects exact retries;
do not generate a different command ID to retry an ambiguous delegation.

The stored task `state` is `todo` or `done`; `status` additionally reflects the exact
delegated message's turn (`starting`, `running`, `needs-you`, `review`, `failed`, or
`unavailable`). A successfully completed agent turn means **Review**, never automatic
**Done**. The user explicitly marks the task done with a revision-checked update. Reusing
the thread for later work does not change which turn belongs to the delegated task.

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
