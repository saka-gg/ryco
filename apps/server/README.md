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

On Linux, installing compiles the terminal backend (`node-pty` ships no Linux prebuild), so the
machine needs a C/C++ toolchain and Python first (Debian/Ubuntu: `sudo apt install build-essential
python3`). A node whose `node-pty` could not be built still starts; it logs why and its terminals
stay unavailable.

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
installs the pinned Rust toolchain itself. Use the Bun version pinned in the root `package.json`, and
the Node.js version in its `engines` range (24). On Linux, `bun install` also needs
the C/C++ toolchain and Python above for `node-pty`.

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

For scripts and health checks, `ryco service status --ready` asks the node this home runs (as a
service or under `ryco serve`) for its identity, within 3 seconds, and exits 1 unless it answers as
this home's node. `--json` prints `{ "ready", "reason", "origin" }`.

A node that runs as a service updates itself from the apps. It checks the new release against a
copy of its database before it restarts into it, and rolls back a release that fails to start,
database included. See [node-updates.md](../../docs/node-updates.md).

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
- `--no-keep-awake-while-working`: let the machine idle-sleep while agents work. By default a
  server keeps it awake while a turn or background work runs and for 2 minutes after, on AC power
  only; the display may still sleep (`RYCO_KEEP_AWAKE_WHILE_WORKING`,
  `ryco config set keep-awake-while-working false`). `--prevent-sleep` holds it for the whole run
  instead, and Ryco Desktop manages this itself.
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
ryco service status [--ready] | logs [-f] | restart | stop | start | uninstall

ryco hub login | enroll | status | pending | cancel | resume | leave

ryco remote add <name> <pairing-url>
ryco remote list | remove <name>
ryco remote threads <name>
ryco remote send <name> <thread-id> <message>

ryco thread start --project <id|path> [--title] [--model <instance/model>] [--runtime-mode] [--wait] [--json] <prompt|->
ryco thread send <thread-id> [--wait] [--json] <prompt|->
ryco thread wait <thread-id> [--turn <turn-id>] [--timeout 30m] [--json]
ryco thread read <thread-id> [--limit 20] [--json] [--full]
```

### Threads from scripts

`ryco thread` drives agent threads on this machine's running node, or on a paired remote with
`--remote <name>`. On this machine it signs in with a short-lived owner session that it revokes
when the command ends (Ctrl-C included); no token is printed or written to disk.

- `start` creates a thread in a project and starts its first turn, with the project's default
  model and checkout (a new worktree when the project's threads start in one). `--runtime-mode`
  may not be above the default the apps start a thread with.
- `send` queues the message behind a running turn, with the thread's own model and modes. It
  never steers the running turn. A node that keeps follow-up queues takes it at the end of the
  thread's queue, as the apps queue a message sent while the thread is busy, so it goes after
  the follow-ups queued before it and shows in the apps' queue; an older node gets it as the
  next turn once the thread is idle.
- `wait` waits for the turn `send` printed (`--turn`), else the running or latest turn.
- `read` prints the thread's latest messages, each in full, and its queued follow-ups. `--json`
  prints the page `ryco_read_thread` returns (a long message cut, with its continuation);
  `--json --full` prints every message whole.

`start` prints the thread id and `send` the turn id once the turn has started. With `--wait`
(and always for `wait`) the command waits for exactly that turn and prints its final reply on
stdout; diagnostics go to stderr. `--json` prints one line: `{ threadId, turnId, state, reply,
error }`. Exit codes: 0 replied (or started), 1 failed or stopped, 2 needs an approval or an
answer, or (`send`, state `held`) the thread's follow-up queue is held after a Stop, a failure,
a usage limit or Pause, or waits for a Retry, 3 a node restart cut the turn off, 4 timed out
(`--timeout`), 5 the turn ended but a later turn replaced it before the command saw how (`wait
--turn` on an old turn). A message `send` queued on the node stays queued when the command exits
2 or 4, and goes out once the queue is resumed or the thread is free.

```bash
thread=$(ryco thread start --project . "Fix the failing tests")
ryco thread wait "$thread" --timeout 1h
turn=$(ryco thread send "$thread" "Now update the changelog")
ryco thread wait "$thread" --turn "$turn" --json
```

`--project` is a path when it is written as one (`.`, `..`, `/…`, `./…`, `~/…`) or exists;
anything else is a project id. `ryco remote send <name> …` is
`ryco thread send --remote <name> --wait`, except that its message is never read from stdin.

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
