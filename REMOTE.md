# Remote Access

Use this when you want to connect to a Ryco server from another device such as a phone, tablet, or separate desktop app.

## Recommended Setup

Use a trusted private network that meshes your devices together, such as a tailnet.

That gives you:

- a stable address to connect to
- transport security at the network layer
- less exposure than opening the server to the public internet

## Enabling Network Access

There are two ways to expose your server for remote connections: from the desktop app or from the CLI.

### Option 1: Desktop App

If you are already running the desktop app and want to make it reachable from other devices:

1. Open **Settings** → **Connections**.
2. Under **Manage Local Backend**, toggle **Network access** on. This will restart the app and run the backend on all network interfaces.
3. The settings panel will show the default reachable endpoint, with a `+N` control when more endpoints are available. Expand it to inspect alternatives such as loopback, LAN, private-network, or HTTPS endpoints.
4. Use **Create Link** to generate a pairing link you can share with another device.

The default endpoint controls the QR code and primary copy action for pairing links. You can change it from the expanded endpoint list. The preference is stored by endpoint type, so choosing the local LAN endpoint survives normal IP address changes when you move between networks.

When no user default is saved, the app uses the built-in LAN endpoint for pairing links when
available. You can set another endpoint as the default from the expanded endpoint list.

- HTTPS/WSS-compatible endpoints work from `https://app.ryco.space`, but are not made the default
  automatically.
- Non-loopback HTTP endpoints are useful for direct LAN pairing.
- Loopback-only endpoints are not useful for another device unless that device is the same machine.

If the copied link points directly at `http://192.168.x.y:3773`, open it from a client that can reach that LAN address. If it points at `https://app.ryco.space/pair?...`, the hosted web app will save the environment and connect directly to the backend URL in the link.

### Tailscale Endpoints

When the desktop app can detect Tailscale, it adds Tailnet endpoints to the reachable endpoint list.

Depending on your Tailscale setup, this may include:

- the machine's `100.x.y.z` Tailnet IP
- a MagicDNS name
- an HTTPS MagicDNS endpoint when Tailscale Serve is configured for this backend

The Tailscale HTTPS endpoint uses the clean MagicDNS URL, such as
`https://machine.tailnet.ts.net/`, and is disabled until the app verifies that the URL reaches this
backend. Use **Setup** on the Tailscale HTTPS row to opt in. The desktop app restarts the backend
with the same server-side behavior as `ryco serve --tailscale-serve`, then the server asks Tailscale
Serve to proxy HTTPS traffic to the local backend.

The Tailscale support is an endpoint provider add-on. The core remote model still works without Tailscale: LAN HTTP endpoints, custom HTTPS endpoints, future tunnels, and SSH-launched environments all use the same saved environment and pairing flow.

For `https://app.ryco.space`, prefer an HTTPS Tailnet or other HTTPS endpoint. A plain `http://100.x.y.z:3773` endpoint can still work from a desktop client or another browser page served over HTTP, but it will not work from the hosted HTTPS app because of browser mixed-content rules.

### Option 2: Headless Server (CLI)

Use this when you want to run the server without a GUI, for example on a second Mac or a remote
machine over SSH.

Run the server with `ryco serve`. The CLI is published as `ryco-cli`; install it globally when the
server should keep running (see [Keep a node running](#keep-a-node-running)).

```bash
npm install -g ryco-cli
ryco serve --host "$(tailscale ip -4)"
```

`ryco serve` starts the server without opening a browser and prints:

- a connection string for its primary address — the LAN address when it listens on every
  interface, or the Tailscale HTTPS URL for a loopback server behind Tailscale Serve
- a one-time pairing token and how long it stays valid
- a pairing URL, plus pairing links for its other addresses (Tailscale IP, Tailscale HTTPS, and a
  hosted-app link for HTTPS endpoints)
- a QR code for the primary pairing URL

From there, connect from another device in either of these ways:

- scan the QR code on your phone
- in the desktop app, enter the full pairing URL
- in the desktop app, enter the host and token separately
- in the hosted web app, open a hosted pairing URL when the backend is reachable over HTTPS

Use `ryco serve --help` for the full flag reference. It supports the same general startup options as the normal server command, including an optional `cwd` argument.

For hosted web pairing over Tailscale HTTPS, opt in to Tailscale Serve:

```bash
ryco serve --tailscale-serve
```

By default this configures Tailscale Serve on HTTPS port 443 and advertises
`https://machine.tailnet.ts.net/`. Advanced users can choose a different HTTPS port:

```bash
ryco serve --tailscale-serve --tailscale-serve-port 8443
```

The one-time token `ryco serve` prints expires after five minutes. Mint another whenever you pair a
new device:

```bash
ryco auth pairing create --ttl 1h --base-url https://machine.tailnet.ts.net
```

### Keep a node running

`ryco service install` runs `ryco serve` in the background as a per-user LaunchAgent on macOS or a
systemd user unit on Linux. It starts at login, restarts the server if it stops, and — unless you
pass `--no-prevent-sleep` — keeps the machine from idle-sleeping while on AC power. It takes the same
network and Hub flags as `ryco serve`:

```bash
npm install -g ryco-cli            # a service cannot rely on an npx cache
ryco service install --tailscale-serve --hub ~/code
ryco service status
ryco service logs -f
```

`ryco service restart` picks up an upgraded `ryco-cli`; `ryco service uninstall` removes the service
and keeps the node's state and pairings. A background service does not print pairing tokens into
its log; use `ryco auth pairing create` to pair devices. On Linux, run
`sudo loginctl enable-linger $USER` so the unit also runs at boot without a login.

`ryco serve --prevent-sleep` holds the same sleep assertion for a foreground server.

### Reach a node through your Ryco account

A node can also be reached from anywhere through the hosted Hub relay, without Tailscale or an open
port. Start it with `--hub` (the hosted Hub at `https://app.ryco.space` is the default origin) and
link it to your account:

```bash
ryco serve --hub                   # or: ryco service install --hub
ryco hub login                     # sign in with your password and second factor
```

`ryco hub login` approves this node's own enrollment after checking that the Hub's enrollment key
matches the node's, then signs out; no account credential stays on the machine. Accounts that sign
in only with a passkey or GitHub use `ryco hub enroll` and approve the printed code in the Ryco web
app instead. See [Outbound Hub connector](./docs/hub-connector.md).

### Use the CLI as a client

`ryco remote` pairs this machine's CLI with another node and talks to it over the same WebSocket
RPC the apps use:

```bash
ryco remote add mini "https://mini.tailnet.ts.net/pair#token=…"
ryco remote threads mini
ryco remote send mini <thread-id> "Run the tests and fix what fails"
```

`send` continues a thread with its own model and prints the reply as it streams (`--no-wait` returns
at once). The session is stored in `~/.ryco/userdata/cli-remotes.json`, readable only by you;
`ryco remote remove mini` forgets it.

### Option 3: Desktop-Managed SSH Launch

Use this when you want the desktop app to start or reuse Ryco on another machine over SSH.

1. Open **Settings** → **Connections**.
2. Under **Remote Environments**, choose **Add environment**.
3. Select the SSH launch flow.
4. Enter the SSH target, such as `user@example.com`.
5. Confirm the launch. The desktop app probes the host, starts or reuses a remote Ryco server, opens a local port forward, and saves the environment.

The remote host needs Node.js on the non-interactive SSH `PATH`. The launcher uses an installed
`ryco` when it finds one and otherwise runs `ryco-cli` through `npx`. If the tunnel drops — after
sleep or a network change — the next reconnect attempt rebuilds it, relaunching the remote server
if needed.

After setup, the renderer connects to a local forwarded HTTP/WebSocket endpoint. The remote host still owns the actual Ryco server, projects, files, git state, terminals, and provider sessions.

SSH launch is a desktop feature because it needs local process and SSH access. Once the environment is paired and saved, it uses the same environment list and connection model as direct LAN, Tailscale, HTTPS, or future tunnel-backed environments.

## How Pairing Works

The remote device does not need a long-lived secret up front.

Instead:

1. `ryco serve` issues a one-time owner pairing token.
2. The remote device exchanges that token with the server.
3. The server creates an authenticated session for that device.

After pairing, future access is session-based. You do not need to keep reusing the original token unless you are pairing a new device.

## Staying Connected

A saved remote environment reconnects on its own after sleep, a network change, or a restart of the
remote server: it keeps retrying on a backoff capped at one minute, and retries at once when the
device wakes or regains the network. An environment that was unreachable when the app started is
retried the same way. On reconnect the app resumes from what it already has — only the events it
missed are sent — rather than downloading every thread again.

## Hosted Web App Pairing

The hosted web app at `https://app.ryco.space` can save a remote backend in browser local storage from a URL like:

```text
https://app.ryco.space/pair?host=https://backend.example.com:3773#token=PAIRCODE
```

Use hosted pairing when the backend is reachable from the browser over HTTPS/WSS. This includes a backend behind a trusted HTTPS tunnel or another HTTPS endpoint you operate.

Do not use hosted pairing for plain HTTP LAN URLs such as `http://192.168.x.y:3773`. Browsers block an HTTPS page from connecting to an insecure HTTP or WS backend. For those endpoints, use the direct pairing URL shown by the desktop app or CLI from a client that can open that HTTP URL directly.

Hosted pairing does not proxy traffic through Ryco. The browser still connects directly to the backend URL in the pairing link.

## Managing Access Later

Use `ryco auth` to manage access after the initial pairing flow.

Typical uses:

- issue additional pairing credentials
- inspect active sessions
- revoke old pairing links or sessions

Use `ryco auth --help` and the nested subcommand help pages for the full reference.

## Security Notes

- Treat pairing URLs and pairing tokens like passwords.
- Prefer binding `--host` to a trusted private address, such as a Tailnet IP, instead of exposing the server broadly.
- Anyone with a valid pairing credential can create a session until that credential expires or is revoked.
- Hosted pairing links keep the credential in the URL hash so it is not sent to the hosted app server, but it can still be exposed through browser history, screenshots, logs, or copy/paste.
- Use `ryco auth` to revoke credentials or sessions you no longer trust.
