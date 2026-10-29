# Provider instance enablement

Each provider instance is enabled or disabled on its own, and the node enforces it. One rule
decides, shared by the provider registry and the settings resolution below
(`@ryco/shared/providerInstanceEnablement`): an explicit `providerInstances` entry uses its own
`enabled` flag, else the flag in its config, else the driver's default (Cursor starts disabled,
the other built-in drivers enabled). A default instance without an explicit entry follows its
legacy `providers.<driver>.enabled` slot.

## What disabling stops

Disabling an instance closes and rebuilds its runtime scope, which ends its sessions and its
status, model and limit probes. The node refuses to start a session on it and skips it when
prewarming. It also refuses to resume a stopped session, which the next turn or a checkpoint
revert would otherwise do; a revert then fails before the provider is touched, so files,
history and the agent's conversation stay as they were. A runtime that is still live during the
switch keeps serving until the rebuild stops it. Agent Control, automations and session import
accept only enabled instances.

Every text generation (titles, branch names, commit messages, pull request and issue text,
workspace summaries and side chat) refuses a disabled instance before the provider runs:
"Provider instance '<id>' is disabled in Ryco settings." Side chat, which asks the thread's own
model, shows the message. A generation already running when the instance is
disabled is not cancelled; its own timeout bounds it.

## What falls back

The text generation model (titles, branch names, commit messages, pull request and issue text,
workspace summaries) is resolved whenever settings are read. A text model on a disabled or
removed instance falls back to the first enabled instance with a default text model: the default
instances in driver order, then the other instances in the order they were added. When no
instance qualifies, the selection stays as it is.

The preference stays saved; enabling the instance again restores it. The resolution cannot
see whether a fallback instance is installed, so a fallback to an enabled but missing provider
fails like any unavailable provider.

## What still reads disabled instances

- Usage history reads the local files of disabled accounts ([usage history](usage-history.md)).
- MCP server listings still use their own enabled check.
