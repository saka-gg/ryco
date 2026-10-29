# Grok

Ryco supports Grok Build through the Grok CLI's native Agent Client Protocol (ACP) server. Ryco
starts `grok agent stdio` for each active Grok session; it does not call the xAI API directly.

Grok support is currently marked Early Access.

Ryco can also manage user MCP servers through the configured `grok mcp` CLI and install the external
Agent Control bridge for standalone Grok clients. Automatic Agent Control injection into
Ryco-managed Grok ACP sessions remains disabled pending a separate isolation audit. See
[Provider MCP management](./mcp.md) and [Agent Control](../agent-control.md).

## Install and authenticate

Install the Grok CLI on the machine running the Ryco server:

```bash
curl -fsSL https://x.ai/cli/install.sh | bash
```

Then authenticate interactively:

```bash
grok login
```

For a remote or headless server, use device authentication:

```bash
grok login --device-auth
```

You can also sign in from Ryco, on any node you own: when Grok cannot start on a node, its instance
shows **Account sign-in** in **Settings → Providers**. **Sign in** runs `grok login --device-auth`
on that node, with the instance's environment variables, in a terminal shown in Settings; open its
sign-in link on the device you use and follow the steps there, so a remote or headless node needs no
browser of its own. The login keeps running if you close Settings, and ends when it exits, after 15
minutes, with **Cancel**, or when the node restarts. One sign-in runs per Grok store (`GROK_HOME`, by
default `~/.grok`) at a time. Grok does not report which account it uses, so once the login finishes
and Grok starts, Settings shows it as signed in.

You can instead add `XAI_API_KEY` in the Grok provider instance's **Environment variables** section
under **Settings → Providers**. Mark it sensitive so Ryco stores it as a server secret and does not
send the value back to clients after saving.

## Configure Ryco

The built-in Grok instance is enabled by default and expects the binary to be named `grok`. Open
**Settings → Providers → Grok** to set a different binary path or add another named Grok instance
with its own environment and accent color.

Ryco discovers Grok's available models during the provider health check. If discovery returns no
catalog, the model picker falls back to `grok-build`. Changing the model on an active Grok thread
applies the new model to the same Grok session on the next message; the conversation is kept.

## What is supported

- New and resumed ACP sessions
- Streamed assistant text, plans, tool calls, and token usage
- Tool approval requests and Grok user questions
- Image attachments
- Turn cancellation
- Grok's own slash commands in the composer's `/` menu: the built-in ones Grok lists when Ryco
  checks the CLI, and a project's own once a Grok session has started there. `/always-approve` and
  `/context` are not offered, and Ryco refuses to send `/always-approve`: change permissions with
  the access selector instead.
- Commit messages, pull-request content, branch names, issue content, and thread titles
- Multiple named Grok provider instances

## Troubleshooting

If Grok is unavailable in Ryco:

1. Run `grok --version` on the same machine and as the same user that runs Ryco.
2. Run `grok` once to confirm authentication, or check that the provider instance receives
   `XAI_API_KEY`.
3. Run `grok agent stdio` to verify the installed CLI exposes its ACP server. Press `Ctrl+C` after it
   starts; the command waits for JSON-RPC messages on standard input.
4. If Ryco uses a custom binary path, confirm it points to the Grok executable rather than its
   containing directory.
5. Refresh the Grok provider in **Settings → Providers** after correcting the installation or
   credentials.

The current CLI reference is available in the
[xAI Grok Build documentation](https://docs.x.ai/build/cli/reference).
