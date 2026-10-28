# Agent Control

Agent Control lets coding agents inspect Ryco and operate threads. Private Ryco sessions execute
routine actions through the durable operation queue. Archiving, runtime permission changes,
project linking/unlinking or workspace changes, executable project scripts, system prompts, and
device lifecycle changes still require user approval. Standalone integrations remain approval-only.

Agent Control also gives agents visual replies: with it on, they can answer with inline HTML pages
such as charts, tables, diagrams and mockups, shown in the thread above their written reply (see
[HTML renders](./user/html-renders.md)).

Private tools are advertised when the provider initializes, including before its first turn. Discovery
is scoped to the session's capabilities; mutations still require exact active-turn authority when
called. This matters for clients such as Codex that cache the initial MCP catalog.

## Private-session tools

- `ryco_capabilities`: provider instance IDs, model slugs, grants, and the complete available catalog.
- `ryco_create_threads`: a bounded batch of local or isolated-worktree threads, with an optional base
  ref. The caller's project, runtime permission and worktree-isolation restrictions still apply.
  An entry's `artifacts` hands over up to 8 of the caller's own artifacts (see
  [Handing over artifacts](#handing-over-artifacts)).
- `ryco_list_artifacts`: the caller's own thread's artifacts, newest first, with the ids a
  handover takes. Needs the `read` grant.
- `ryco_send_message`, `ryco_interrupt_thread`, `ryco_update_thread`: queue/steer work, interrupt a
  turn, rename/archive/restore, select models and options, set runtime/interaction/token modes,
  and set or clear a persistent goal.
- `ryco_read_thread`, `ryco_search_threads`, `ryco_wait_threads`: paginated messages, content search,
  and bounded waiting for completion or user attention. Background agents count as active work. A
  wait returns as soon as a waited thread settles or asks for attention: it wakes on the thread's
  session, turn, pending-request and background-work events instead of polling, and re-checks at
  least every 5 seconds.
- `ryco_inspect_thread`: model/goal/status details, native subagents and their messages, activities,
  plans, review checkpoints, and retained terminal output. History cursors expose older pages;
  partial subagent coverage is reported explicitly.
- `ryco_read_thread_diff`, `ryco_read_thread_file`: checkpoint patches and authorized workspace or
  worktree text files through the same services used by the right panel.
- `ryco_read_project`, `ryco_propose_project_update`: project preferences and revision-checked
  updates, including default model, system prompt, scripts, and preferred remote.
- `ryco_settings_summary`, `ryco_propose_settings_change`: the closed non-secret boolean preference
  allowlist. Provider credentials, connection settings and Agent Control policy are excluded.
- `ryco_browser`, `ryco_computer`: browser tabs and native app interaction when the desktop bridge
  and the corresponding user permissions are available. Browser `open` accepts `visible: true`.
- `ryco_task_status`, `ryco_task_cancel`: status, results and cancel for tasks this chat delegated
  with `returnToOrigin` (see [Delegated tasks](#delegated-tasks)).
- `ryco_list_local_tasks`, `ryco_read_local_task`, `ryco_create_local_task`,
  `ryco_update_local_task`, `ryco_add_local_task_file`, `ryco_remove_local_task_file`,
  `ryco_start_local_task_chat`, `ryco_propose_local_task_delete`: the user's Tasks page (see
  [Tasks](#tasks)).
- `ryco_html_preview`, `ryco_html_render`: check a self-contained HTML page in Ryco's headless
  browser, then show it inline above the reply as a sandboxed page that follows the user's theme,
  with a card at the end of the reply (see [HTML renders](./user/html-renders.md)). Both need the
  `html.render` grant and exact active-turn authority; a render counts toward the turn's attachment
  budget. Its result, like `ryco_attach_file`'s, names the stored artifact's id.

Mutation calls return a durable receipt. Reuse `requestId` when retrying the same action, then use
`ryco_wait_for_control_request` with `waitFor: "terminal"` to get dispatch results and created thread
IDs. Successful dispatch is not task completion: for delegated work, end the turn and let Ryco
wake the chat (below); use `ryco_wait_threads` only to follow other threads. An agent must never
approve its own pending requests.

## Delegated tasks

An agent delegates by calling `ryco_create_threads` with `returnToOrigin: true` on each entry,
confirms the request with `ryco_wait_for_control_request` (`waitFor: "terminal"`), and ends its
turn. It does not poll. When a delegated task reaches a terminal state, Ryco wakes the delegating
chat with one automatic message, a normal queued turn that starts or resumes its session.

- **Batching.** Tasks that finish while the chat is busy, or together, arrive in one message with
  one section per task (at most 10 sections and 100,000 characters; the rest follow in the next
  message). Each section links the child and the originating chat.
- **Results and notices.** A finished task returns its final answer as JSON-escaped, untrusted
  reference data (8,000 characters at most), never as instructions or approval. A task that was
  interrupted, stopped (for example by a restart; it is not resumed), failed to start, received
  someone else's follow-up, was archived or deleted, whose request failed, or that did not finish
  within 24 hours returns a server-written notice instead, with no child text. A task that itself
  delegated returns its output after its own delegated work came back; if that follow-up run fails
  to start, or a restart cuts it off and none of its own delegated work is left to wake it again,
  it returns a stopped notice.
- **When it is delivered.** The chat must be idle: no running or starting session, no pending
  approval or question, no working background agents (a watcher-only "monitoring" state does not
  count) and no turn start waiting to bind. It does not matter whether the chat moved on to other
  work, its session was stopped by the idle reaper, or the server restarted. Starting a cold session
  for a wake is limited to one at a time.
- **Scope.** A wake never runs with more privilege or in a different checkout than the delegation
  had: if the chat's runtime mode was raised or its worktree changed, delivery waits. It also waits
  while Agent Control is disabled. A captured return that cannot be delivered within 24 hours fails
  without a message; open the child instead.
- **Stopping.** If you stop the chat while it is delegating or processing a delegation message,
  the remaining results are not sent automatically. Interrupts from agents, startup reconciliation
  and the server do not count. Deleting or archiving the chat, or archiving its worktree, cancels
  its returns too.
- **Task tools.** `ryco_task_status` lists up to 20 of this chat's returnToOrigin tasks (or one by
  `taskId`) with the run state, the return status and the redacted, untrusted result, or the
  notice for a task that ended without one. Pending questions are reported only as a flag. Reading
  one finished task by `taskId` during the chat's own turn acknowledges it, so no separate
  automatic message is sent for it; a list never acknowledges, because a long list may not reach
  the agent in full. `ryco_task_cancel` stops the automatic return first and then interrupts the
  task's running turn through the normal routine interrupt request. If the return is changing at
  that moment, it does not interrupt and asks for a retry.
- **Scope of the tools.** They cover only tasks created with `returnToOrigin` by this chat. Local
  Tasks and the standalone integrations' `ryco_read_task` / `ryco_wait_for_task` are separate.
  Return progress is also visible as `completionReturns` on the delegation request
  (`ryco_read_control_request`) and on its proposal card.
- **Returned artifacts.** A finished task's result brings back copies of the pages and files it
  published during its run (the newest 8; never ones that were handed over to it). They are
  attached to the automatic message, so the delegating agent receives them like an upload and they
  show in the chat's Artifacts tab, marked with the task they came from. A batch carries at most 8
  and 50 MiB in all; the message says how many stayed in their tasks. A returned artifact that is
  gone (its task was reverted) is left out.

## Tasks

The Tasks page is the user's to-do list on the node (problems, ideas, follow-ups), each task with
notes, a due day, a project, links (pull requests, issues, Jira items, branches, chats, pages) and
up to 8 files. Agents use it with the `ryco_*_local_task` tools. They are a different thing from
the runs a chat delegates (`ryco_task_status`).

- **Reading** needs the `local-tasks.read` grant: `ryco_list_local_tasks` (open, done or all tasks,
  by project or text, newest change first, with a notes preview; `offset` pages past the first
  answer's `nextOffset`) and `ryco_read_local_task` (one
  task whole, with its files and the chats started from it).
- **Changing** needs `local-tasks.manage` and exact active-turn authority, and runs at once.
  `ryco_create_local_task` takes a `requestId` that names the task, so a retry answers with the
  same one. `ryco_update_local_task` edits the title, notes, priority, due day, project or links
  (the whole list), and completes (`state: done`) or reopens a task; it passes the revision last
  read, and a task changed since fails until it is read again. `ryco_add_local_task_file` adds a
  regular file of the caller's workspace (a relative path, the same rules as `ryco_attach_file`);
  adding the same file again adds nothing. `ryco_remove_local_task_file` removes one.
- **Starting a chat**, `ryco_start_local_task_chat`, also needs `threads.create`. It submits a
  `ryco_create_threads` request with the entry's `localTaskId`, so the chat runs under that tool's
  project, runtime-mode and worktree rules, and `returnToOrigin` works as there. The first message
  is the task's title, notes and links unless a `prompt` is given. The chat is recorded under the
  task before it is dispatched and gets copies of the task's files; a task without a project joins
  the caller's, and one in another project can't be started from here. A completed task starts
  nothing. Starting a task's chat through `ryco_create_threads` needs `local-tasks.manage` too. A `ryco_create_threads` entry can carry
  `localTaskId` itself, but not together with `artifacts`.
- **Deleting** is never immediate: `ryco_propose_local_task_delete` asks the user, with the task's
  revision. The approved delete removes the task, its links and its files (its chats are kept), and
  fails if the task changed after it was requested.

Tasks are the node's own list, not one project's: these tools read and edit tasks of every
project. Only starting a chat is bound to the caller's project. Changes reach the Tasks page as
they happen. Standalone integrations have no task tools and cannot start a task's chat.

## Handing over artifacts

A thread's artifacts are the pages it published with `ryco_html_render`, the files it attached with
`ryco_attach_file`, and the ones handed over to it. The user's own uploads are not artifacts.
`ryco_list_artifacts` lists them with ids of the form `messageId:attachmentId`.

A `ryco_create_threads` entry's `artifacts` takes up to 8 of those ids (50 MiB in all). Each must be
one of the calling thread's own artifacts, checked when the request is submitted and again before
it runs, since a revert in between can drop one. Standalone integrations cannot hand over
artifacts. The new thread gets a copy of each, attached to its first message, so its agent receives
them like files the user uploaded (a page as its `.html` source) and they show in its Artifacts tab,
marked with the thread they came from. A copy never shares the source's file: deleting or reverting
either thread leaves the other's copy alone. A handed-over artifact is the receiving thread's own,
so it can hand it on to a thread it delegates in turn. The handover is provenance only: it grants
no access to the thread it came from.

## Ryco sessions versus standalone clients

There are two connection paths.

### Ryco-managed sessions

When Agent Control is enabled, supported provider sessions started by Ryco receive it automatically.
There is nothing to install in the provider's persistent MCP configuration. Access is private,
runtime-scoped, and revoked with the session or turn that received it.

The Integrations page reports this under **Ryco sessions**. Its purpose is to show which configured
providers support automatic access and which do not.

### Standalone provider clients

A Codex, Claude Code, Copilot, Cursor, Grok, or supported OpenCode client started outside Ryco needs
a durable external connection. Under **Standalone provider clients**, choose a detected provider
profile and select **Connect**. Ryco will:

1. create a separately scoped external integration;
2. store its credential in Ryco's private owner-readable runtime directory;
3. add a credential-free stdio bridge entry through that provider's native MCP authority;
4. re-read the native entry; and
5. launch the installed command, negotiate MCP, and verify the Agent Control tool catalog.

The installation is shown as connected only after all five steps succeed. The browser, provider
configuration, logs, and child-process environment never receive the raw credential.

The default connection can list allowed projects, request one task at a time, and read or wait for
tasks created by that integration. It covers current and future projects, allows 60 control calls
per minute, and has no expiry. Every requested Ryco mutation still needs approval. `ryco_wait_for_task`
returns as soon as the task's request is decided or finished. It re-checks the integration whenever
it changes and at least every 5 seconds, so revoking the integration ends a wait in progress at
once, and an expired integration or disabled Agent Control ends it within 5 seconds.

### Standalone read grants

Read access beyond the integration's own tasks is opt-in. Each grant is off by default, is set per
integration on the Integrations page, and only reaches projects inside the integration's project
scope. A thread, project, or workspace outside that scope reads exactly like one that does not
exist.

| Grant                      | Tools                                                                                                      |
| -------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `external.threads.read`    | `ryco_list_threads`, `ryco_read_thread`, `ryco_search_threads`, `ryco_wait_threads`, `ryco_inspect_thread` |
| `external.reviews.read`    | `ryco_read_thread_diff` and the `review` section of `ryco_inspect_thread`                                  |
| `external.files.read`      | `ryco_read_thread_file`                                                                                    |
| `external.workspaces.read` | `ryco_read_project`, `ryco_list_workspaces`, `ryco_read_workspace`                                         |

These tools return the same bounded, redacted results as the private-session tools, with two
differences. Standalone inspection never returns terminal output, because that is where secrets
most often appear. Workspace reads have no calling thread, so no workspace is reported as
`current`. `ryco_wait_threads` re-checks the integration whenever it changes and at least every 5
seconds, so revoking a grant or narrowing the scope ends a wait in progress at once, and disabling
Agent Control ends it within 5 seconds. Workspace files can include local
configuration such as `.env`, so grant `external.files.read` only to clients you would also let
read the checkout directly.

Integrations that can request tasks or automations also get `ryco_read_control_request` and
`ryco_wait_for_control_request`. They return receipts only for requests that integration created,
for example an automation proposal awaiting approval.

### Standalone control requests

Two more opt-in grants let a standalone client request changes. Every such request waits for a
Ryco user's approval, regardless of runtime mode; standalone requests never execute as routine
actions. Retrying with the same `requestId` and plan returns the original receipt, even after the
target changed; reusing a `requestId` with a different plan is refused.

| Grant                        | Tools                                                               |
| ---------------------------- | ------------------------------------------------------------------- |
| `external.threads.control`   | `ryco_send_message`, `ryco_interrupt_thread`, `ryco_update_thread`  |
| `external.workspaces.manage` | `ryco_plan_workspace_lifecycle`, `ryco_propose_workspace_lifecycle` |

A standalone client has no thread of its own, so its authority over a thread is the same ceiling
that bounds the tasks it can create. Without `external.runtime.full-access` it can only target
threads in `approval-required` mode and cannot raise a thread's runtime mode. Without
`external.checkout.shared` it can only target threads in an isolated worktree. A target outside
the project scope is reported exactly like a missing thread. The request captures the target's
state, and approval is refused at execution if that state changed (for example, the turn it meant
to interrupt already finished) or if the integration lost the grant.

Workspace lifecycle requests follow the [governed workspace lifecycle](#governed-workspace-lifecycle)
rules unchanged. A standalone client has no current workspace, so none is protected as current;
main, active, and unverifiable workspaces stay blocked.

Standalone integrations cannot create or remove projects, change settings, or use devices, the
computer, or the browser.

## Repair and disconnect

Use **Repair** after an interrupted install, a missing credential file, or a failed protocol check.
Ryco revalidates durable state and replaces only missing material or configuration it still owns.
Incomplete installations are also reconciled after a server restart.

Use **Disconnect** to revoke the external integration and remove its private credential. Ryco removes
the provider entry only when its current fingerprint still matches the installed version. If you
edited that entry, Ryco preserves it and reports that manual cleanup remains.

If both `ryco` and `ryco-agent-control` already name unrelated MCP servers, Ryco reports a conflict
instead of overwriting them. Rename one of those entries in the provider's native configuration and
retry.

## Manual setup

Advanced manual pairing remains available for unsupported clients or configuration environments
Ryco cannot mutate safely. It creates the same external security principal but requires you to run
the displayed pairing command and copy the generated MCP entry yourself. Pairing codes are
short-lived; do not place them or the resulting credential in provider configuration.

Provider-specific MCP behavior is documented in [Provider MCP management](./providers/mcp.md).

## Governed workspace lifecycle

Private Ryco sessions expose these project-scoped tools:

- `ryco_list_workspaces({ projectId, after?, limit? })`: pages of up to 50 workspace
  records and synthetic session groups, including archived and missing checkouts. Pass
  `nextCursor` as `after`. IDs are stable within the project. `origin: "manual"` does
  not imply a synthetic group: check `registration` and `worktreeId`.
- `ryco_read_workspace({ projectId, workspaceId })`: bounded session membership,
  archive/current/main protection, checkout existence, Git registration, commit IDs,
  dirty/unmerged state, and inspection blockers. No file contents or Git stderr are returned.
- `ryco_plan_workspace_lifecycle({ projectId, workspaceId, action, checkoutMode,
  sessions, deleteBranch })`: read-only preflight returning `{ plan, planDigest, blockers }`.
- `ryco_propose_workspace_lifecycle({ requestId, plan })`: submit the exact returned plan.
  Requires the `workspaces.manage` grant and exact active-turn authority. Every lifecycle
  action requires human approval, including in Full Access. Do not approve your own request.

Supported combinations:

| Action    | Checkout mode                      | Sessions                        | Branch                                                          |
| --------- | ---------------------------------- | ------------------------------- | --------------------------------------------------------------- |
| `archive` | `remove-checkout` or `record-only` | `preserve`                      | Retain by default; explicit deletion only with checkout removal |
| `delete`  | `remove-checkout` or `record-only` | Explicit `preserve` or `delete` | Same                                                            |
| `restore` | `restore-checkout`                 | `preserve`                      | Must still exist; `deleteBranch: false`                         |

`record-only` requires both the exact path and its Git registration to be absent. It
never removes files, prunes Git registrations, or deletes a branch. This is the supported
cleanup for a retained registered **Manual** entry after external Git worktree removal.
Archiving a thread alone does not remove this workspace record. Synthetic groups have
no record to archive/delete; the tool reports that limitation without deleting history.

Checkout removal never uses force. It requires a registered checkout with no tracked,
untracked, or ignored changes and a branch merged into the project's current HEAD.
Branch deletion uses the approved commit as an atomic compare-and-delete guard. Main,
current, overlapping, locked, active, or unverifiable workspaces are blocked. Restore
requires an archived record, an absent checkout/registration, and a retained branch.

Deleting with `sessions: "preserve"` atomically moves the exact associated sessions to
an existing registered main workspace and clears their removed checkout paths; history
and archive state survive. `sessions: "delete"` explicitly authorizes deletion of the
listed session histories. The authoritative orchestration command checks workspace and
project revisions, path, branch and session membership again before changing records.
No batch cleanup, rename, broad reconciliation, force option, or arbitrary command tool
is exposed by this workflow.

The normal immutable plan digest, request ID, approval and durable receipt protocol applies.
Retry an identical request ID/plan to recover its original receipt. A changed plan needs a
new request ID and approval. Read/wait for the receipt's terminal result. On failure,
`execution.workspaceLifecycle.completedSteps` records intent and completion checkpoints:
a `*-started` step without its `*-completed` counterpart has an **unknown outcome**.
Filesystem and record changes cannot share a transaction. A later failure can therefore
leave the checkout removed while its Ryco record remains. Recovery never repeats deletion
or recreates user files; inspect current state and prepare a new approved plan for any
remaining work. A failed receipt is not a claim that nothing changed.

Standalone integrations with `external.workspaces.read` can list and read workspaces in
allowed projects. Only `external.workspaces.manage` adds the plan and propose lifecycle tools,
and those requests always need approval (see
[Standalone control requests](#standalone-control-requests)). The private catalog is shared across supported
provider injection paths. No hosted, mobile authorization, or service-worker policy changes
are involved.
