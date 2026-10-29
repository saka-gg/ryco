# Provider MCP management

Open **Settings → MCP** to inspect the MCP profiles detected from enabled Ryco provider
instances. Profiles are grouped by their effective native configuration authority, so two provider
instances that share a home or config file do not present duplicate sources of truth.

Ryco uses each provider's native CLI or documented config file. Literal environment values and HTTP
headers are not returned to the app. Editing a server can retain, replace, or clear each stored
secret.

Controls appear only when the selected profile supports the operation. A missing health or inventory
control means the provider cannot report it reliably; it does not mean the server is healthy.

## Support matrix

| Provider       | Source of truth                                                                          | Ryco management                                                                                                                                                                              | Agent Control                                                                                               |
| -------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Codex          | Codex app-server config/status APIs for the effective `CODEX_HOME`                       | Add, edit, remove, enable, reload, health, inventory, and OAuth where Codex exposes them                                                                                                     | Automatic in Ryco sessions; one-click external install                                                      |
| Claude Code    | Configured `claude` binary and resolved Claude `HOME`; user-scoped `claude mcp` commands | List, add/update, and remove. Health and OAuth remain unknown; inventory is unavailable                                                                                                      | Automatic in Ryco sessions; one-click external install                                                      |
| GitHub Copilot | Configured Copilot CLI and its user MCP registry                                         | List, add/update, and remove user entries. Project/managed entries shown in that registry are read-only                                                                                      | Automatic in Ryco sessions; one-click external install                                                      |
| Cursor         | Global `~/.cursor/mcp.json` or project `.cursor/mcp.json`                                | Guarded atomic add/update/remove while preserving unrelated JSON fields                                                                                                                      | Automatic in Ryco sessions; one-click install for the global profile                                        |
| Grok           | Configured `grok mcp` CLI                                                                | List, add/update, remove, enable/disable, and native diagnostics                                                                                                                             | One-click external install; automatic Ryco-session injection is disabled pending a separate isolation audit |
| OpenCode       | 1.x `mcp` or 2.x `mcp.servers` in the resolved global/project config                     | Guarded atomic JSON management in the instance's OpenCode generation. A file read by a 1.x and by a 2.x instance is not edited. JSONC is visible but read-only; unknown versions fail closed | One-click install for a recognized writable global profile; automatic Ryco-session injection is disabled    |

Cursor file locations follow its [MCP documentation](https://cursor.com/docs/mcp).
OpenCode generations and config precedence follow its
[MCP server documentation](https://opencode.ai/docs/mcp-servers) and
[configuration documentation](https://opencode.ai/docs/config).

## OpenCode 1.x and 2.x

Both OpenCode generations read the same `opencode.json` files, in different formats. Ryco finds
the generation from the instance's `opencode --version` and edits the file in that generation's
format. It edits nothing for an OpenCode 2 release that Ryco does not run (older than v2.2.0), and
shows the same upgrade message as the provider's card.

- **OpenCode 1.x** lists servers directly under `mcp`, with `enabled` and one `timeout` in
  milliseconds. **Tool timeout** sets that timeout.
- **OpenCode 2** lists them under `mcp.servers`, with `disabled` and a timeout per phase
  (`startup`, `catalog`, `execution`). **Startup timeout** sets `startup` and **Tool timeout** sets
  `execution`; Ryco keeps `catalog` as it is.

The global profile is `opencode.json` in `~/.config/opencode` (or `$XDG_CONFIG_HOME/opencode`).
OpenCode 2 reads it from `OPENCODE_CONFIG_DIR` instead when the instance's environment sets that
variable, and so does Ryco; 1.x reads `OPENCODE_CONFIG_DIR` on top of its own profile.

OpenCode 2 still runs 1.x entries left directly under `mcp`, so a 2.x profile shows them too. When
the same name is in both places, OpenCode 2 uses its `mcp.servers` entry, and so does Ryco. Editing,
enabling or disabling a 1.x entry moves it to `mcp.servers` in the 2.x format, and removing it
removes it from both places. 1.x entries you don't touch stay where they are.

OpenCode 1.x cannot read `mcp.servers`. So Ryco edits no file that both a 1.x and a 2.x provider
instance read, and lists each such file as an issue; an instance whose global file it is shows as
unsupported. Each generation reads its global profile, the project's `opencode.json` and the
`OPENCODE_CONFIG` file, whichever of them Ryco edits for it, and 1.x also the files in
`OPENCODE_CONFIG_DIR`. So the project's file is always shared, and the 2.x global profile is shared
when the 1.x instance reads the same directory, as its own profile (the same `HOME` or
`XDG_CONFIG_HOME`) or through `OPENCODE_CONFIG_DIR`. Give them separate homes, or move both to the
same generation. See [OpenCode](./opencode.md) for running the two generations side by side.

## Scope and ownership

User-profile controls write only user-owned entries. Project entries are editable only from a
dedicated writable project profile. System, organization-managed, mixed-origin, malformed, and
unknown-origin entries remain visible where the provider reports them but are not offered as write
targets.

JSON-backed providers reject symbolic-link targets, malformed documents, ambiguous JSON/JSONC
authorities, and a file that changes between read and atomic replacement. File mode, newline style,
indentation, unrelated servers, and unknown fields are preserved.

CLI-backed providers use the configured binary, provider environment, home, bounded timeouts, and
bounded output. Ryco re-reads the provider after a mutation and reports failure if the requested
state was not preserved.

## Recovery

Refresh the profile before retrying a failed edit. If Ryco reports an ownership or concurrent-edit
conflict, inspect the provider's native configuration, keep the version you want, and retry from the
new snapshot. Ryco does not overwrite an unrelated Agent Control entry and does not delete an entry
that changed after installation.

See [Agent Control](../agent-control.md) for the difference between automatic Ryco-session access,
one-click standalone installation, repair, disconnect, and manual pairing.
