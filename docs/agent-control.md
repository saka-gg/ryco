# Agent Control

Agent Control lets coding agents inspect Ryco and operate threads. Private Ryco sessions execute
routine actions through the durable operation queue. Archiving, runtime permission changes,
project linking/unlinking or workspace changes, executable project scripts, system prompts, and
device lifecycle changes still require user approval. Standalone integrations remain approval-only.

Private tools are advertised when the provider initializes, including before its first turn. Discovery
is scoped to the session's capabilities; mutations still require exact active-turn authority when
called. This matters for clients such as Codex that cache the initial MCP catalog.

## Private-session tools

- `ryco_capabilities`: provider instance IDs, model slugs, grants, and the complete available catalog.
- `ryco_create_threads`: a bounded batch of local or isolated-worktree threads, with an optional base
  ref. The caller's project, runtime permission and worktree-isolation restrictions still apply.
- `ryco_send_message`, `ryco_interrupt_thread`, `ryco_update_thread`: queue/steer work, interrupt a
  turn, rename/archive/restore, select models and options, set runtime/interaction/token modes,
  and set or clear a persistent goal.
- `ryco_read_thread`, `ryco_search_threads`, `ryco_wait_threads`: paginated messages, content search,
  and bounded waiting for completion or user attention. Background agents count as active work.
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

Mutation calls return a durable receipt. Reuse `requestId` when retrying the same action, then use
`ryco_wait_for_control_request` with `waitFor: "terminal"` to get dispatch results and created thread
IDs. Use `ryco_wait_threads` to follow the actual provider work; successful dispatch is not task
completion. An agent must never approve its own pending requests.

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
per minute, and has no expiry. Every requested Ryco mutation still needs approval.

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

Standalone integrations retain their existing task-oriented grants and catalog; they do
not advertise or accept workspace lifecycle tools. This does not expand their authority to
other Ryco sessions or workspace histories. The private catalog is shared across supported
provider injection paths. No hosted, mobile authorization, or service-worker policy changes
are involved.
