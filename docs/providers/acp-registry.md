# ACP Registry

ACP Registry instances run third-party agents through the shared `effect-acp` runtime. Existing Codex, Claude, Copilot, Cursor, Grok, and OpenCode instances keep their existing drivers.

In Settings → Providers → Add instance, select **ACP Registry**, choose an agent, and explicitly install the displayed version. Installation occurs on the selected Ryco server, which may be a remote node. Save the instance after installation. The initial **Agent default** model starts a session without guessing a model identifier; models and commands advertised by the agent then populate the provider catalog.

## Installation and trust

Discovery reads the official ACP registry. It never executes an agent or invokes a package manager. Installation accepts only the selected registry agent ID and exact version; the client cannot supply a URL, executable, or shell command. Registry and archive requests use HTTPS with bounded downloads and an origin allowlist, including redirect checks.

The installer currently supports publisher-checksummed binary distributions (`tar.gz`, `tgz`, `zip`, or a raw executable). SHA-256 is checked before extraction. Archive paths, links, special files, duplicate entries, and extraction sizes are checked. Files are staged in a private directory and atomically published under the server state directory. Existing installations are not silently replaced. Starting an agent verifies the local manifest and installed files and never installs or updates anything. Registry changes do not change a saved version.

Package-runner-only (`npx`/`uvx`) distributions, missing publisher checksums, unsupported archive formats, and unsupported download origins remain visible with an explanation, but cannot be installed. There is no unchecked runner fallback. A selected version must still be published by the registry to install it; previously installed versions continue to resolve offline.

Installing an agent means trusting that publisher's code to run with the server user's operating-system permissions. Checksums establish artifact integrity, not a sandbox. Registry agents use ACP permission requests when they support them; Ryco does not claim to sandbox their native filesystem or process access.

## Authentication

On a saved instance, **Check authentication methods** explicitly starts the verified executable and reads its advertised methods. **Sign in** invokes only the selected, currently advertised method. Both actions require owner access, as does installation. Merely discovering registry metadata, saving settings, refreshing providers, or starting a session does not invoke authentication.

Authentication runs on the server and may require interaction on that host. Terminal-interactive methods show instructions for external setup; their commands are never executed by the authentication UI. Environment-variable methods list the required variable names without requesting or returning values; configure them through the existing sensitive provider environment settings. Ryco does not copy credentials into registry metadata or installation manifests, and authentication results return only completion status. Successful sessions update the provider authentication status.

## Capabilities and sessions

Capabilities come from the actual agent handshake and session, not from the ACP label. Registry instances project legacy and session-config model catalogs, advertised slash commands, session-load/resume support, prompt image support, and observed usage updates. Plans, assistant output, thoughts, tool calls, approvals, and usage use the shared ACP event pipeline.

The driver negotiates ACP protocol version 1 and rejects incompatible versions. Session startup has a 30-second deadline; failed startup releases its process scope. Session continuation uses the saved native session ID and the advertised load or resume method. An agent that does not support loading, or rejects loading that session, produces an error rather than silently creating an unrelated conversation. Provider-side rollback, native turn steering, background text generation, audio prompt encoding, client filesystem operations, and client terminal execution are not advertised as supported. Agents that require ACP client terminal/filesystem handlers are not yet compatible; native agent-owned tools continue to work. No registry-specific client runtime, hosted reconnect policy, or web phone tier has been introduced.
