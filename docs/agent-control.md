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
