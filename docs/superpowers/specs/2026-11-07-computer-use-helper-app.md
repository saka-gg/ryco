# Computer Use: its own signed helper app (phase 4)

Goal: macOS lists Computer Use under Privacy & Security as **Ryco Computer Use** with the Ryco icon,
separate from Ryco, and its grants survive Ryco updates. This is what OpenAI ships (`Codex Computer
Use.app`, LSUIElement, its own bundle id) and what Cursor ships (`Cursor Computer Use.app`).

## How macOS attributes the grants

TCC checks the _responsible process_ of whoever asks for Accessibility, Screen Recording or Input
Monitoring. A process started with `posix_spawn` inherits its parent's responsible process, so today
every helper Ryco's main process starts (the Cua driver, the Swift AppSnap helper, the frame tap and
the Escape listener) is attributed to Ryco.app. An app that LaunchServices starts is its own
responsible process. So the helper app has to be started by LaunchServices, and everything that
needs a grant has to be its child.

Things that do not work:

- Disclaiming responsibility for the driver (`responsibility_spawnattrs_setdisclaim`) makes the bare
  `cua-driver` binary its own TCC identity: a path with no icon, not a bundle (upstream cua #5333,
  which also loses the WindowServer connection outside a GUI app).
- `exec`ing the driver from the helper's main executable: the process then has the driver's code
  identity, not the bundle's.
- Starting the driver from the helper and talking to it directly from Ryco: the embedded driver
  trusts host-only requests (`cancel_input`, input epochs, trusted sessions) only from its parent
  (`authenticate_embedded_host_connection` compares the peer pid with `getppid()`), and the driver
  patch belongs to phase 5. So the helper relays the driver socket (below).

## Process tree

```
Ryco.app (Electron main)                      Ryco Computer Use.app (LSUIElement, own bundle id)
 └ ComputerUseHelperBroker ── broker.sock ───── RycoComputerUse (Swift, started by `open -n -g`)
     ▲  per child: 0–3 stream sockets              ├ ryco-computer-ui-helper --check-permissions …
     │  (the child's stdin/stdout/stderr)          ├ ryco-computer-ui-helper --escape-monitor
     │                                             ├ ryco-computer-ui-helper --frame-tap …
     └─ driver-xxxx.sock ── relay (peer = Ryco) ───└ cua-driver serve --embedded --socket h-xxxx.sock
```

- Ryco listens on `broker.sock` in a fresh 0700 directory and writes a one-time token there (0600).
  It starts the helper with `open -n -g -j <bundle> --args --broker <dir>`. The helper reads and
  deletes the token and connects. Its first line is `hello` (protocol, token, pid, version, bundle
  path); Ryco answers `welcome` (Ryco's pid) or `reject`.
- The helper checks Ryco too: before saying hello it reads the listening peer's audit token
  (`LOCAL_PEERTOKEN`) and requires validly signed code (`SecCodeCheckValidity`) at Ryco's exact
  path: the app whose `Contents/Helpers` holds it, or, for unpackaged builds, the path its signed
  Info.plist names (`RycoComputerUseHostPath`, the dev launcher wrapper). `welcome.hostPid` must be
  that peer's pid. Without this, any process of the user could start the helper with its own
  broker directory and borrow its grants.
- `spawn {id, path, args, env, cwd, stdio, streamToken, proxySocket?}` starts one child. `DYLD_*`
  variables are dropped from its environment, so no library can be injected under the grants. For each
  piped stdio slot the helper opens one more connection to `broker.sock`, sends
  `{type:"stream", id, fd, token}` and hands that socket to the child as fd 0/1/2
  (`POSIX_SPAWN_CLOEXEC_DEFAULT`, so nothing else leaks in). The child reads and writes Ryco's
  sockets directly; the helper copies no stdio bytes. Ignored slots get `/dev/null`.
- The helper reports `spawned {pid}`, `spawn-failed {message}` and `exit {code, signal}` (it reaps the
  child). `kill {id, signal}` goes through the helper, which knows whether the pid was reaped.
- `proxySocket`: the argument equal to that path is replaced by a private path in the same directory.
  The helper listens on the original path (0600), accepts only connections whose peer pid is Ryco's
  (`LOCAL_PEERPID`), and relays each one to the driver with half-close. The driver sees its parent as
  the peer, so trusted host requests keep working unchanged.
- Spawn targets are allowlisted by the helper itself: only `ryco-computer-ui-helper` and
  `cua-driver/cua-driver` from Ryco's own resources (`Contents/Resources` beside `Contents/Helpers`;
  unpackaged builds name the directory in the signed Info.plist). A process that steals the token
  still cannot run other code under the helper's grants.

In the code, the broker exposes a `spawn` with the shape of Node's, returning a `ChildProcess`-like
object, so `DesktopAppSnapManager`, `EscapeKillSwitchMonitor`, `ComputerFrameTapPool` and
`CuaDriverHost` only receive a different `spawn`. Window capture into the composer uses the same
Swift helper and the same grants, so it goes through the broker too. Ryco.app itself then needs no
privacy grant. The legacy Rust controller (other platforms, legacy browser section) is unchanged.

## Lifecycle

- Started on demand: the first spawn (a permission check, the Escape listener, the driver, a capture)
  starts the helper. Nothing starts it at Ryco launch unless one of those runs then.
- Idle: 30 seconds after its last child exits, Ryco closes the control connection and the helper
  exits.
- Ryco quits or crashes: the control socket closes (the kernel closes it on SIGKILL too). The helper
  sends SIGTERM to its children, SIGKILL after one second, and exits. The driver also watches Ryco's
  pid (`CUA_DRIVER_EMBEDDED_HOST_PID`) and its stdin, which is Ryco's socket.
- Helper crash: Ryco SIGKILLs every child pid it was told about (a reparented driver would otherwise
  keep running), reports them exited, and the existing owners restart as they do today (the Escape
  listener with its backoff, the driver on the next request). Launches back off 1 s, 2 s, 4 s … up to
  30 s after unexpected exits; a successful session resets it.
- Version handshake: `hello.protocol` must match, `hello.version` must equal the version in the
  bundle's Info.plist on disk, and `hello.bundlePath` must be the bundle Ryco launched. Anything else
  is rejected and the helper exits. Every Ryco session launches a fresh instance (`open -n`), so a
  helper left from before an update can never serve the new Ryco.
- Stop all keeps working: it acts on the driver and the tasks, not on the helper.
- No login item: nothing registers with `SMAppService` or launchd; the bundle sits in
  `Contents/Helpers`, not `Contents/Library/LoginItems`.

## Identity and signing

| Build                        | Name                      | Bundle id                                   |
| ---------------------------- | ------------------------- | ------------------------------------------- |
| Ryco                         | Ryco Computer Use         | `com.laurinfrank.ryco.computer-use`         |
| Ryco Nightly                 | Ryco Nightly Computer Use | `com.laurinfrank.ryco.nightly.computer-use` |
| Dev launcher (`dev:desktop`) | Ryco Computer Use (Dev)   | `com.sak0a.ryco.dev.computer-use`           |
| Unpackaged `start`           | Ryco Computer Use         | `com.sak0a.ryco.computer-use`               |

- Info.plist: `LSUIElement`, `LSMinimumSystemVersion` 13.0, the Ryco icon (the same `.icns` the
  build stages for Ryco.app, flavor-aware), `NSAccessibilityUsageDescription`,
  `NSScreenCaptureUsageDescription`, and `NSInputMonitoringUsageDescription` for the optional Escape
  stop (macOS has no documented key for Input Monitoring; the key is harmless and documents intent,
  and GrantCoach explains the pane), `CFBundleShortVersionString` = Ryco's version, `RycoComputerUseProtocol`.
- Packaging: `build-desktop-artifact.ts` assembles the flavor's bundle in the stage and ships it with
  `extraFiles` to `Contents/Helpers/<name>.app`. `@electron/osx-sign` signs every nested `.app`
  inside out, so releases sign it with the same Developer ID, hardened runtime and timestamp, and
  notarization covers it. Ad-hoc and local-identity builds sign it the same way as Ryco.app.
- Grants survive updates because the designated requirement (bundle id + Developer ID team) stays the
  same. Ad-hoc builds keep the current caveat: macOS ties their grants to one exact build.
- Dev: `build:native:dev` builds the Swift executable; the dev launcher (`electron-launcher.mjs`)
  assembles the helper bundle beside its `Ryco (Dev).app` wrapper in
  `~/Library/Application Support/Ryco Desktop Launchers/<bundle id>/`, signs it with the local
  development identity (or ad hoc), and registers it with LaunchServices. One stable copy per bundle
  id keeps LaunchServices from finding a second copy in another worktree.
- When no helper bundle is found (an old dev wrapper, a broken build), Computer Use keeps working
  exactly as before, under Ryco.app, and the log says why.

## Permissions and migration

- `permissionTarget.ts` returns two things: the grant target (the helper: path, bundle id, name) and
  the host bundle id (Ryco: its windows stay excluded from capture). GrantCoach, the deep links and
  the drag chip use the grant target; the permission badges come from checks that run as the
  helper's children, so they read the helper's grants. `CUA_DRIVER_HOST_BUNDLE_ID` (advisory, shown
  by the driver's permission check) is the grant target.
- `computer-setup.json` now records the bundle id that had every grant. When a required grant is
  missing and the last full grant belonged to another bundle id (Ryco.app, or a file from before this
  change), setup reports `movedToHelper`. Settings then says once, above the permission list:
  "Computer Use now runs as its own app, Ryco Computer Use. Allow it in System Settings once; you can
  remove Ryco from those lists." with the Turn on button. The old stale-build hint is used only when
  the bundle id is unchanged. Nothing is ever dropped silently: `/computer-use` still reports
  "Complete Computer Use setup" and opens setup.

## Failure modes

| Failure                                | Result                                                                  |
| -------------------------------------- | ----------------------------------------------------------------------- |
| Helper bundle missing                  | Fallback to direct spawn under Ryco.app (as before), logged once.       |
| `open` fails / no hello within 10 s    | Pending spawns fail with "Ryco Computer Use did not start"; backoff.    |
| Wrong token, protocol, version or path | Rejected, helper exits, spawns fail with a reinstall hint.              |
| Target not allowlisted                 | `spawn-failed`; the owner reports its usual error.                      |
| Helper crashes                         | Children SIGKILLed by Ryco, owners restart them, relaunch with backoff. |
| Ryco crashes                           | Helper sees EOF, kills children, exits; driver also sees host pid gone. |
| Driver dies                            | Proxy listener removed, host sees connection failures and respawns.     |

Dev caveat: there is one dev helper per launcher bundle id, and it names one checkout's
resources. Two worktrees running `dev:desktop` at once (the single-instance lock normally
prevents this) would reassemble it in turn.

## Not covered

Live TCC behavior is not provable by unit tests. The PR lists what was checked by hand. Locked-Mac
use and the Cua upgrade (phase 5) are separate.
