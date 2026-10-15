# ryco-cli

Ryco is a minimal web GUI for coding agents. The CLI starts the Ryco server, serves the bundled web app, and connects it to local provider runtimes such as Codex, Claude, GitHub Copilot, OpenCode, and Cursor.

Ryco is early WIP. Expect bugs and breaking changes.

## Install

Run without installing:

```bash
npx ryco-cli
```

Or install globally:

```bash
npm install -g ryco-cli
ryco
```

### Run an unreleased build from a checkout

To run a node from source — for example a branch that is not on npm yet — clone the repository on
that machine and run, from its root:

```bash
bun run node:update
```

It pulls the current branch (`git pull --ff-only`), installs dependencies, builds the CLI with its
bundled web app, and points the background service at this checkout's build, restarting it. The
node's identity, Hub link, and saved settings live in the Ryco home (`~/.ryco`), not in the build, so
they carry over. Run the same command again after every pull you want to deploy.

- `bun run node:update -- --no-pull` builds what is checked out without pulling.
- `bun run node:update -- --install-service` also installs the service when none exists yet; without
  it, a machine with no service is only built, and you start it with
  `node --max-semi-space-size=16 apps/server/dist/bin.mjs serve` (see
  [Memory](#memory) for the flag).

The build compiles the native resource monitor, so it needs [rustup](https://rustup.rs); the script
installs the pinned Rust toolchain itself. Use the Bun version pinned in the root `package.json`.

## Provider Setup

Install and authenticate at least one provider before using Ryco:

- Codex: install the Codex CLI and run `codex login`
- Claude: install Claude Code and run `claude auth login`
- OpenCode: install OpenCode and run `opencode auth login`
- GitHub Copilot and Cursor: install/authenticate the provider CLI expected by the corresponding SDK/runtime, then verify live status in Settings

Ryco discovers available providers from the machine running the CLI. Provider binaries, custom homes, server URLs, per-instance environment variables, display names, and accent colors are configured in Settings.

## Usage

Start Ryco for the current directory:

```bash
ryco
```

Start Ryco for another workspace:

```bash
ryco /path/to/project
```

Run without opening a browser:

```bash
ryco --no-browser
```

Set this computer up for your other devices with an interactive guide — background service,
Ryco account, Tailscale, pairing — and come back to it later for status, logs, and settings:

```bash
npx ryco-cli setup
```

Run in headless mode and print pairing details for remote clients:

```bash
ryco serve --host 0.0.0.0 --port 3773
```

Keep it running in the background — started at login, restarted if it stops, awake on AC power:

```bash
ryco service install --tailscale-serve --hub ~/code
ryco service status
```

Link the node to your Ryco account so the apps reach it from anywhere through the Hub relay:

```bash
ryco hub login
```

Common options:

- `--host <host>`: host/interface to bind, for example `127.0.0.1` or `0.0.0.0`
- `--port <port>`: HTTP/WebSocket server port
- `--base-dir <path>`: Ryco state directory, equivalent to `RYCO_HOME`
- `--mode web|desktop`: runtime mode
- `--no-browser`: disable automatic browser opening
- `--auto-bootstrap-project-from-cwd`: create a project for the current working directory on startup when missing
- `--tailscale-serve`: expose this backend over HTTPS on the Tailnet through Tailscale Serve
- `--hub`: reach this node through the hosted Hub relay (`--hub-origin` selects another Hub)
- `--prevent-sleep`: keep the machine from idle-sleeping while the server runs
- `--log-websocket-events`: emit server-side WebSocket traffic logs for debugging

### Memory

The background service and Ryco Desktop run the server with V8's `--max-semi-space-size=16`, which
keeps the young generation from growing to its 128 MiB default during boot and staying there (about
50 MiB less idle memory on Node). A foreground `ryco`, `ryco serve` or `npx ryco-cli` cannot set it
for itself without restarting the process, so pass it to Node when you run a long-lived server by
hand, for example `node --max-semi-space-size=16 "$(command -v ryco)" serve`. Avoid
`NODE_OPTIONS` for this: provider CLIs and terminals started by the server would inherit it.

Useful commands:

```bash
ryco start [options] [cwd]
ryco serve [options] [cwd]

ryco project add <path> [--title <title>]
ryco project remove <project-id-or-path>
ryco project rename <project-id-or-path> <title>

ryco auth pairing create [--ttl 1h] [--base-url <url>]
ryco auth pairing list
ryco auth pairing revoke <id>

ryco auth session issue [--ttl 30d] [--role owner|client]
ryco auth session list
ryco auth session revoke <session-id>

ryco setup
ryco config [show | path | edit | set <key> <value> | unset <key>]

ryco service install [serve flags] [cwd]
ryco service status | logs [-f] | restart | stop | start | uninstall

ryco hub login | enroll | status | pending | cancel | resume | leave

ryco remote add <name> <pairing-url>
ryco remote list | remove <name>
ryco remote threads <name>
ryco remote send <name> <thread-id> <message>
```

See [REMOTE.md](../../REMOTE.md) for remote access setups.

Run `ryco --help` or `ryco <command> --help` for the full command reference.

## Testing

### `WsTestClient` (websocket integration tests)

`src/test/WsTestClient.ts` is a small harness for server-side websocket RPC
integration tests. It replaces ad-hoc per-test socket wiring (`RpcClient.make` +
protocol layer + cookie/origin parsing) with a single scoped `connect()` plus a
few combinators. Connections are bound to the surrounding `Scope` (e.g.
`Effect.scoped`).

```ts
import * as WsTestClient from "./test/WsTestClient.ts";

// `wsUrl` already carries auth (e.g. `?wsToken=...`), as produced by the test
// harness' `getWsServerUrl("/ws")`.
yield *
  Effect.scoped(
    Effect.gen(function* () {
      const ws = yield* WsTestClient.connect(wsUrl);

      // Request/response RPC:
      const config = yield* ws.rpc(WS_METHODS.serverGetConfig, {});

      // Wait for the lifecycle welcome event:
      const welcome = yield* ws.awaitWelcome();

      // Wait for the first push on a subscription matching a predicate:
      const ready = yield* ws.awaitPush(
        WS_METHODS.subscribeServerLifecycle,
        (event) => event.type === "ready",
      );

      // Record an ordered push sequence and await N events:
      const sequence = yield* ws.trackPushSequence(WS_METHODS.subscribeServerConfig);
      const [snapshot, update] = yield* sequence.waitForCount(2);
    }),
  );
```

`makeWsTestClientConnector(group)` builds the same surface for an arbitrary RPC
group, and `makeConnectedWsTestClient(client)` wraps an already-constructed RPC
client (used by `WsTestClient.test.ts` to unit-test the combinators without a
socket). See `src/test/WsTestClient.test.ts` and the migrated cases in
`src/server.test.ts` for examples.

## Links

- Repository: https://github.com/saka-gg/ryco
- Releases: https://github.com/saka-gg/ryco/releases
- Discord: https://discord.gg/jn4EGJjrvv

## License

MIT
