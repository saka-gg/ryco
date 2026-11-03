# OpenCode

Ryco runs OpenCode through its HTTP server (`opencode serve`): one it starts itself, or one you
already run. It works with OpenCode 1.x and OpenCode 2 and finds out which one it talks to on its
own, so the same provider settings work for both.

| Generation | Package                                                  | Ryco requires     |
| ---------- | -------------------------------------------------------- | ----------------- |
| 1.x        | npm `opencode-ai`, Homebrew `anomalyco/tap/opencode`     | v1.14.19 or newer |
| 2.x        | npm `@opencode/cli`, Homebrew `opencode` (homebrew-core) | v2.2.0 or newer   |
| 3.x        | —                                                        | not supported     |

Ryco checks the version before it starts a server or sends a server anything that could change
it. An older or unknown version shows on the provider's card in **Settings → Providers** with the
version you need.

## OpenCode 2 and your data

OpenCode 2 is a separate package that installs the same `opencode` command. The first time it runs,
it converts the shared OpenCode database (`~/.local/share/opencode`, or `$XDG_DATA_HOME/opencode`) to
its own format. When **Binary path** points at an OpenCode 2 install, Ryco starts it just as
running `opencode` would, so the first provider check after you switch converts that data. The
provider's card says so while Ryco runs a local OpenCode 2.

- Don't run OpenCode 1.x and 2.x side by side on the same data, for example as two provider
  instances that share a home. Ryco does not block it, but it stops editing MCP servers in any
  config file both instances read (see [Provider MCP management](./mcp.md#opencode-1x-and-2x)).
- A thread you started on 1.x continues on 2.x in the same OpenCode session when OpenCode kept it.
  When OpenCode no longer has the session, Ryco reports it as missing and the conversation carries
  over to a new one (see [Context handoffs](../context-handoffs.md)).
- Ryco never switches an install between 1.x and 2.x. To move to OpenCode 2, install it yourself,
  for example `npm install -g @opencode/cli`, then refresh the provider.

## Local or external server

Leave **Server URL** empty to let Ryco start OpenCode on `127.0.0.1`. One server is shared by the
instance's threads and its text generation, and stops 30 seconds after the last of them.

- **OpenCode 1.x** uses **Server password** when you set one, otherwise `OPENCODE_SERVER_PASSWORD`
  from the instance's environment.
- **OpenCode 2** always requires a password. Ryco uses **Server password** when you set one,
  otherwise a random password it generates for each server it starts and keeps in memory only. It
  passes the password as `OPENCODE_PASSWORD` and does not pass an inherited
  `OPENCODE_SERVER_PASSWORD` to OpenCode 2.

Set **Server URL** and **Server password** to use a server you run yourself. Ryco sends that
server only the configured password, never a local `OPENCODE_SERVER_PASSWORD`.

Before it creates a client, Ryco asks the server which API it speaks, with read-only requests:
`/global/health` for 1.x and `/api/info` for 2.x. A server answers the other generation's path from
its web app, which can forward the request with its password header to `app.opencode.ai`. So Ryco
asks a server it started only on that server's own path, even when that request fails, and an
external server first on the path that answered at that URL before.

## Updates

Ryco updates OpenCode 1.x installs from npm `opencode-ai`, the `anomalyco/tap` formula or the
native installer. Updating OpenCode 2 is manual for now: `npm install -g @opencode/cli@latest` or
`brew upgrade opencode`, then refresh the provider.

## Troubleshooting

- **"... is too old. Upgrade OpenCode 2 to v2.2.0 or newer."** Update OpenCode 2, then refresh.
- **"The OpenCode server reports v2.x but did not identify itself as OpenCode 2."** The server's
  health path reports 2.x, but `/api/info` did not answer as OpenCode 2, for example behind a proxy
  that passes only some paths. Ryco sends it nothing else. Point **Server URL** at the OpenCode
  server itself.
- **"The OpenCode server Ryco started is not the OpenCode 2 its binary reported."** The binary at
  **Binary path** changed while Ryco started it, for example during an upgrade. Try again.
- **"The OpenCode server returned a web page instead of a health response."** A proxy or sign-in
  page is in front of a 1.x server, or the URL is not an OpenCode server.

MCP servers configured in OpenCode, in the 1.x `mcp` and the 2.x `mcp.servers` format, are covered
in [Provider MCP management](./mcp.md#opencode-1x-and-2x).
