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

| Provider       | Source of truth                                                                          | Ryco management                                                                                                           | Agent Control                                                                                               |
| -------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Codex          | Codex app-server config/status APIs for the effective `CODEX_HOME`                       | Add, edit, remove, enable, reload, health, inventory, and OAuth where Codex exposes them                                  | Automatic in Ryco sessions; one-click external install                                                      |
| Claude Code    | Configured `claude` binary and resolved Claude `HOME`; user-scoped `claude mcp` commands | List, add/update, and remove. Health and OAuth remain unknown; inventory is unavailable                                   | Automatic in Ryco sessions; one-click external install                                                      |
| GitHub Copilot | Configured Copilot CLI and its user MCP registry                                         | List, add/update, and remove user entries. Project/managed entries shown in that registry are read-only                   | Automatic in Ryco sessions; one-click external install                                                      |
| Cursor         | Global `~/.cursor/mcp.json` or project `.cursor/mcp.json`                                | Guarded atomic add/update/remove while preserving unrelated JSON fields                                                   | Automatic in Ryco sessions; one-click install for the global profile                                        |
| Grok           | Configured `grok mcp` CLI                                                                | List, add/update, remove, enable/disable, and native diagnostics                                                          | One-click external install; automatic Ryco-session injection is disabled pending a separate isolation audit |
| OpenCode       | V1 `mcp` or V2 `mcp.servers` in the resolved global/project config                       | Guarded atomic JSON management for recognized V1/V2 formats. JSONC is visible but read-only; unknown versions fail closed | One-click install for a recognized writable global profile; automatic Ryco-session injection is disabled    |

Cursor file locations follow its [MCP documentation](https://cursor.com/docs/mcp).
OpenCode generations and config precedence follow its
[MCP server documentation](https://opencode.ai/docs/mcp-servers) and
[configuration documentation](https://opencode.ai/docs/config).

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
