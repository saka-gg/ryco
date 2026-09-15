# Agent Control automation and diagnostics boundary

Agent Control automations are server-owned, project-scoped schedule definitions. Approving a
create or update proposal authorizes only that definition. It never creates a thread or starts a
provider turn. When an occurrence is due, the scheduler materializes a new immutable
`automationRun` proposal containing the exact project, provider instance, runtime/worktree
options, title, and bounded prompt. A user must approve that run before the existing thread-action
executor can create the thread and start work.

The schedule language is deliberately finite:

- one future `runAt`, or a fixed interval of at least 15 minutes;
- a required end within 90 days for recurring schedules;
- at most 25 active definitions per project;
- at most one pending or executing run per automation;
- at most 50 retained run outcomes per automation;
- missed intervals coalesce into one occurrence, never a catch-up batch;
- each run proposal expires after 15 minutes.

SQLite uniqueness constraints make occurrence claims and active-run creation idempotent across
concurrent ticks and restart recovery. A revision change or cancellation before proposal
materialization invalidates the claimed occurrence. Cancellation prevents future proposals and
cancels only a pending, unaccepted run; it does not delete project/thread data or interrupt a run
that was already accepted or is executing.

The operational MCP reads clamp each page to 50 items, each requested time range to 24 hours, and
the retention boundary to seven days. Orchestration scans inspect at most 500 newest events.
Provider runtime summaries come from a 500-entry in-memory metadata ring. Responses contain only
typed IDs, event types, timestamps, statuses, and numeric health counts. They omit credentials,
environment values, paths, files, commands, terminals, transcripts, request/MCP bodies, raw
payloads, traces, logs, relay/hosted data, and other project/provider-session state.

Internal MCP reads remain bound to the exact provider session's project and provider instance;
mutation tools additionally require exact active-turn authority. External integrations receive no
new default privilege. Automation, activity, and diagnostics capabilities must be granted
explicitly and continue to enforce integration expiry/revocation, project scope, rate limits, and
the existing shared-checkout/full-access restrictions.

The governed iOS Simulator extension uses Ryco's existing thread-scoped `DeviceService`; it does
not add a transport or a device-specific approval queue. Inventory and lifecycle metadata are
available only to the exact internal provider session. Screenshots and accessibility trees are
ephemeral MCP content for the exact current thread attachment: they are never copied into
structured results, proposals, audit rows, diagnostics, or server logs. External integrations
receive neither device metadata nor device content.

Every device mutation is a separate immutable proposal and only the shared accepted-proposal
executor can invoke `DeviceService`. Audit and diagnostic records retain safe identifiers, action
kind, lifecycle expectations, decisions, outcomes, and typed error codes; they omit screenshots,
frames, UI-tree contents, raw URLs, artifact paths, recording paths, helper payloads, and typed
text. Legacy direct device mutation/content tools are suppressed while an Agent Control provider
lease exists, preventing selection of the older gateway as an approval bypass.
Coordinate taps, swipes, and hardware buttons are proposal-safe. Text typing, label-targeted taps,
and scroll-to-element remain unavailable because their exact inputs can contain accessibility or
user content that the durable proposal model must not persist. Launch arguments are unavailable
for the same reason.

Automation templates still contain no browser, device, shell, command, RPC, URL, webhook, script,
or callback field. Browser/CDP/web-page control remains out of scope.

## Automation centre

On desktop/web, open **Project settings → Automations** to review schedules and recent runs.
The editor uses the existing once/fixed-interval schedule language and an explicit provider
instance, model and supported options. Saving and cancelling create owner-authored immutable
proposals; the normal approval executor applies them. Every occurrence still needs separate
approval. The `automation-owner` principal is constructed only behind owner-authorized RPC and
may authorize automation plans only. Private-session and external-integration MCP authority is
unchanged.

Run identity, original execution selection and thread links come from durable runs and their
immutable proposals. **Dispatched** means the thread-start operation completed, not that the
provider task finished or succeeded. Open the linked thread to review progress or interrupt work.
The existing scheduler's active-occurrence constraint covers approval and dispatch, not the
entire lifetime of provider work. No result-based completion or quiet-monitor policy is inferred
from absent output, prose or file-change counts.

Read/unread state is persisted against the run's last update. Refresh or refocus the centre to
see changes made on another client; proposal events also refresh the view. The centre shows up
to 50 recent project runs, with at most 50 outcomes retained per schedule. Marking a result unread
does not exempt it from retention.

Manual retry requests retain their identity and create a fresh occurrence through the same
scheduler/recovery path. Rejected/expired occurrences and cancellations before a proposal exists
can be retried while the definition revision is unchanged and no occurrence is active. Failed
dispatches and cancellations that may have executed require inspection; missing thread IDs do
not prove nondelivery. Schedule cancellation never interrupts already accepted work.

Damaged definitions, runs and active proposals are decoded individually and quarantined from
bounded centre/scheduler batches. Original rows remain intact for repair; the centre reports
unavailable records without returning raw decode errors. A quarantined active run keeps its
schedule's reservation, preventing accidental replacement work. Other schedules remain usable.
