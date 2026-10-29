# ACP Registry

ACP Registry instances run third-party agents through the shared `effect-acp` runtime. Existing Codex, Claude, Copilot, Cursor, Grok, and OpenCode instances keep their existing drivers.

In Settings → Providers → Add instance, select **ACP Registry**, choose an agent, and explicitly install the displayed version. Installation occurs on the selected Ryco server, which may be a remote node. Save the instance after installation. The initial **Agent default** model starts a session without guessing a model identifier; models and commands advertised by the agent then populate the provider catalog.

To run an ACP agent that is already installed on the node instead, choose **Local command** in the same step (see [Local ACP command](#local-acp-command)). The source is fixed once the instance exists.

## Local ACP command

A local command instance starts an executable that is already on the selected node, for example an agent CLI you installed yourself, such as `gemini` with the argument `--acp`. Ryco installs, downloads, and updates nothing for it.

- **Executable:** an absolute path or a command name looked up on the node's `PATH`, including `PATH` from the instance's environment variables. A leading `~` is expanded. Relative paths such as `./agent` or `bin/agent` are rejected, and `PATH` entries that are not absolute are not used, because sessions run in the project directory and a repository could otherwise supply the agent. The command is looked up again before every session start and authentication check.
- **Arguments:** one literal argument per row, passed exactly as entered, including spaces and empty arguments. No shell runs, so there is no variable expansion, globbing, quoting, or command substitution. At most 64 arguments.
- **Windows:** batch wrappers (`.cmd`, `.bat`) are not supported because they need a shell. Configure the underlying executable (for example `node.exe`) and pass the script path as an argument.
- **Visibility:** the executable and arguments are part of the provider settings, which every client that can view settings can read. Keep credentials out of arguments; put them in the instance's Environment variables and mark them Sensitive.

The provider card shows whether the command was found on the node. **Check authentication methods** and **Sign in** start the configured command exactly as a session does. The agent's version comes from its own ACP handshake once a session starts. Startup deadlines, protocol version 1, and the limits under [Capabilities and sessions](#capabilities-and-sessions) apply as for registry agents.

## Installation and trust

Discovery reads the official ACP registry. It never executes an agent or invokes a package manager. Installation accepts only the selected registry agent ID and exact version; the client cannot supply a URL, executable, or shell command. Registry and archive requests use HTTPS with bounded downloads and an origin allowlist, including redirect checks.

The installer currently supports publisher-checksummed binary distributions (`tar.gz`, `tgz`, `zip`, or a raw executable). SHA-256 is checked before extraction. Archive paths, links, special files, duplicate entries, and extraction sizes are checked. Files are staged in a private directory and atomically published under the server state directory. Existing installations are not silently replaced. Starting an agent verifies the local manifest and installed files and never installs or updates anything. Registry changes do not change a saved version.

Package-runner-only (`npx`/`uvx`) distributions, missing publisher checksums, unsupported archive formats, and unsupported download origins remain visible with an explanation, but cannot be installed. There is no unchecked runner fallback. A selected version must still be published by the registry to install it; previously installed versions continue to resolve offline.

Installing an agent means trusting that publisher's code to run with the server user's operating-system permissions. Checksums establish artifact integrity, not a sandbox. Registry agents use ACP permission requests when they support them; Ryco does not claim to sandbox their native filesystem or process access.

## Authentication

On a saved instance, **Check authentication methods** explicitly starts the verified registry executable, or the configured local command, and reads its advertised methods. **Sign in** invokes only the selected, currently advertised method. Both actions require owner access, as does installation. Merely discovering registry metadata, saving settings, refreshing providers, or starting a session does not invoke authentication.

Authentication runs on the server and may require interaction on that host. Terminal-interactive methods show instructions for external setup; their commands are never executed by the authentication UI. Environment-variable methods list the required variable names without requesting or returning values; configure them through the existing sensitive provider environment settings. Ryco does not copy credentials into registry metadata or installation manifests, and authentication results return only completion status. Successful sessions update the provider authentication status.

## Capabilities and sessions

Capabilities come from the actual agent handshake and session, not from the ACP label. Registry instances project legacy and session-config model catalogs, advertised slash commands, session-load/resume support, prompt image support, and observed usage updates. Plans, assistant output, thoughts, tool calls, approvals, and usage use the shared ACP event pipeline. The composer's `/` menu also lists the commands a session advertised in the thread's project directory; Ryco remembers the newest list per directory after the session ends, because ACP agents list commands only inside a session.

Both sources, pinned registry installs and local commands, share this runtime. The driver negotiates ACP protocol version 1 and rejects incompatible versions. Session startup has a 30-second deadline; failed startup releases its process scope. Session continuation uses the saved native session ID and the advertised load or resume method. An agent that does not support loading, or rejects loading that session, produces an error rather than silently creating an unrelated conversation. Provider-side rollback, native turn steering, background text generation, audio prompt encoding, client filesystem operations, and client terminal execution are not advertised as supported. Agents that require ACP client terminal/filesystem handlers are not yet compatible; native agent-owned tools continue to work. No registry-specific client runtime, hosted reconnect policy, or web phone tier has been introduced.

Side chat is unavailable for ACP Registry instances because the generic protocol does not guarantee a tool-free request. Select Codex, Claude, or GitHub Copilot as the side-chat provider; the main ACP session remains unchanged.
