# Device Tools drawer

Open **Tools** (the sliders button) in a device's toolbar once a booted simulator or emulator is
attached. The drawer sits under the toolbar and scrolls; the live screen stays above it.

Every control shows the value the device reports, read through the viewer-safe `device.read`
`detail` request (a WebSocket RPC, never an HTTP response, so nothing is cached). The drawer reads
on open, on **Refresh**, and after each change, so a control always shows the device's real value
rather than the choice that was sent. A value the device cannot report reads "Not reported"
instead of a guess. Changes go through the existing owner-only `device.app` RPC; without owner
access (or, on the Hub, before the machine is mutation-ready) the drawer only reads.

Only the controls a device supports are shown (the detail lists them):

| Group         | iOS Simulator                                                                                                                         | Android Emulator                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| App           | App in front (with name), Terminate, Relaunch, Open URL, Launch by bundle ID                                                          | Same, by package                                                                  |
| Device        | Appearance, Text size, Orientation, Liquid Glass (clear/tinted), Color filter                                                         | Appearance, Text size (font scale), Orientation, Color correction, Network on/off |
| Accessibility | Reduce Motion, Increase Contrast, Reduce Transparency, Show Borders (Button Shapes), VoiceOver                                        | Reduce Motion (animation scales), Increase Contrast (high-contrast text)          |
| Overlay       | Element frames from the accessibility tree, drawn over the live screen                                                                | Same                                                                              |
| Location      | Presets, coordinates, Clear                                                                                                           | Presets, coordinates                                                              |
| Permissions   | Grant, revoke, reset for the app in front or a named bundle; states read from the simulator's TCC database (location is not readable) | Grant, revoke, reset; states from `dumpsys package`                               |
| Push          | Alert text to the app in front, or a JSON payload (4,096 UTF-8 bytes, `aps` required)                                                 | —                                                                                 |
| Presets       | Dark, Large text, Dark + large, Standard                                                                                              | Same                                                                              |

How each value is read:

- iOS: `simctl ui` for appearance, content size and Increase Contrast; Ryco's own
  `ryco-sim-settings` for Reduce Motion, Reduce Transparency, Show Borders, VoiceOver, color
  filters and Liquid Glass; the frontmost app's process from the device helper's accessibility
  translation, named through `launchctl list`; the orientation Ryco turned the device to.
- Android: `cmd uimode night`, `settings get` (font scale, animation scales, Wi-Fi, high-contrast
  text, color correction), the built-in display's rotation from `dumpsys window displays`, the
  focused package from `dumpsys window`.
- Location: simulators do not report their simulated location, and an emulator reports one only
  once an app asks, so the drawer shows the last location Ryco set, labelled "last set by Ryco".

`ryco-sim-settings` (`apps/server/native/device-helper/Sources/SimSettings.c`) is built by the
helper's `build.sh` with the simulator SDK, beside the helper, from Ryco's own source; it runs
inside the simulator through `simctl spawn`. It calls the same libAccessibility and
MediaAccessibility setters the Settings app uses, so running apps update live. A runtime that lacks
a symbol reports that setting as unsupported. Nothing reads or writes these settings until the
drawer is used, and the drawer never builds or installs anything: it needs a device that was
already attached.

The overlay re-reads the tree every two seconds while it is on and outlines up to 400 distinct
element frames; the frames turn with the device.

The drawer replaces the earlier "Simulator testing" drawer. Agents' `device_configure` tool keeps
its existing actions; the new drawer actions (accessibility switches, Liquid Glass, color filter,
terminate) are not offered to agents.

## Agents

Agents apply the same settings with the `device_configure` tool and read an app's unified
log (os_log, Logger, NSLog) and recent crash reports with `device_logs`; both work on iOS
simulators attached to this node only. Crash reports are returned by file name, never by
path, and `print`/stdout is not captured. Agent inputs (tap, swipe, type, press a button,
scroll to an element, launch, open a URL) wait for the screen to settle and return a
settled flag, whether the screen changed, and a compact text snapshot of the screen;
`device_wait` waits for a labelled element or a still screen without sending input.

## Boundaries

From the drawer, `DeviceTestingInput` travels through the existing owner-only `device.app`
RPC and the shared client-runtime device facade. The same input has a second path: an
agent's `device_configure` call on the provider device gateway (loopback-only, bound to
one thread and accepted only during its active turn). That path is not owner-only. With
Agent Control off, Ryco adds no approval of its own there; the provider's native tool
approvals apply (Claude asks before every MCP call except in full-access mode, and auto mode
uses Claude's own classifier).
While Agent Control holds the thread, the gateway hides the tool. A gateway call also
attaches the device to the agent's thread and opens the pane, like the gateway's other
device tools.

Both paths share the backend, which validates before spawning commands, requires an
explicit booted target, and keeps the selected Xcode environment. The testing action
itself never boots a simulator, changes boot ownership, starts a helper, or modifies
hosted authorization/reconnect policy. Screenshot, recording and accessibility paths
remain independent. No Android, multi-host or web phone-tier changes are included.

The existing app request/response unions, IPC device interface, shared device client,
backend interface and simulator panel are integration points shared with other device
work. Integrators should retain both sets of new union members/methods and update any
external fake clients/backends implementing these interfaces. Deploy matching client and
server versions; an older server will not recognize the new `testing` envelope member.

## Upstream verification

References were inspected on September 12, 2026:

- [v0.0.37 release](https://github.com/pingdotgg/t3code/releases/tag/v0.0.37): its release
  notes contain no simulator/device feature entry; it is the requested release baseline.
- [v0.0.41 nightly 1520](https://github.com/pingdotgg/t3code/releases/tag/v0.0.41-nightly.20260911.1520)
  lists simulator/emulator support and separate host/session work.
- [DeviceActions.ts, nightly 1551](https://github.com/pingdotgg/t3code/blob/v0.0.41-nightly.20260911.1551/apps/server/src/device/DeviceActions.ts)
  uses `simctl ui`, `location`, `privacy` and stdin-based `push` for these actions.
  The same file in [nightly 1576](https://github.com/pingdotgg/t3code/blob/v0.0.41-nightly.20260912.1576/apps/server/src/device/DeviceActions.ts)
  was byte-identical when checked.
- The referenced tag's [MIT license](https://github.com/pingdotgg/t3code/blob/v0.0.41-nightly.20260911.1551/LICENSE)
  was inspected before implementation. No upstream source was copied. This implementation
  uses Ryco's existing contracts, backend, process runner and authorization envelope.

Installed Xcode's `xcrun simctl help ui`, `privacy`, `location` and `push` independently
confirmed command order, supported text sizes/services and the push byte limit. Unlike
upstream's additional helper-based notification permission support, this drawer uses
only those public simctl commands.

## Readiness and lifecycle review fixes

The drawer requires the shared device connection store's `connected` status, in addition
to an attached, booted device. Retained device/thread snapshots during `connecting` or
`error` do not enable testing. Hosted sessions also use the existing
`useHostedRpcCapability(device.app)` binding to client-runtime authorization and the
selected machine's existing `canMutate` projection. This preserves the current-shell
readiness requirement without introducing another authorization or reconnect policy.
The server's existing owner-only RPC boundary remains unchanged.

Testing attempts now capture a per-device lifecycle generation. Backend boot/shutdown
entry invalidates existing attempts and suspends new ones until lifecycle completion;
backend disposal invalidates them through its existing disposed flag. The guard runs
before discovery, between preset commands, after each command, and after asynchronous
Xcode toolchain resolution immediately before spawning a command.

Manager shutdown has earlier awaits for recording/stream cleanup, so a backend-only
entry guard was insufficient. `DeviceManager.shutdown` acquires a testing suspension
before those awaits, and releases it after shutdown or failure. Manager disposal holds
an all-device suspension from its entry through cleanup. Both reuse the backend's
nested suspension mechanism; ownership, boot limits, cleanup order and other device
operations are unchanged. Tests hold stream cleanup open to verify that pending presets
cannot advance and new testing attempts cannot start during this interval.

An already-spawned command is not rolled back or forcibly cancelled. It may finish
while a lifecycle operation starts; the guard prevents subsequent steps and prevents
reporting that stale attempt as successful. Changes made externally by Simulator.app,
another Ryco process, or `xcrun simctl` do not participate in these in-process generations.
The initial boot-state check cannot make an external shutdown/reboot atomic with later
commands. A command can fail on shutdown, or a later step can reach a newly booted
instance with the same UDID. This external race remains a limitation; no claim of an
OS-wide lifecycle lock is made.

Integration note: backends now implement `suspendTesting(udid?)`, returning a release
callback. A platform router must forward target suspensions to the appropriate backend
and all-device suspensions to every backend; it must preserve these manager-entry
fences when combining this change with Android work.

## Exact follow-up validation — September 12, 2026

- `bun --version`: **1.4.0**, matching `packageManager`.
- `bun install --frozen-lockfile`: **passed**, 1,419 installs checked across 1,620 packages,
  no dependency changes. The sandbox denied temporary-file access; the approved
  unsandboxed retry succeeded.
- `bun run --cwd apps/server test src/device/iosTestingActions.test.ts`: **14 passed**.
  Includes deferred discovery/toolchain/command cases, backend shutdown/dispose/boot/reboot,
  and manager shutdown/disposal with pending stream cleanup.
- `bun run --cwd apps/server test src/device/DeviceManager.test.ts src/device/DeviceManager.coldBoot.test.ts src/device/IosSimulatorBackend.test.ts src/device/IosSimulatorBackend.reboot.test.ts src/device/IosSimulatorBackend.betaToolchain.test.ts src/device/IosSimulatorBackend.capabilities.test.ts src/ws/deviceRpc.test.ts`:
  **128 passed across 7 files**.
- `bun run --cwd apps/web test:browser src/components/device/SimulatorPanel.browser.tsx`:
  **2 passed in Chromium**, using the real shared device store and hosted capability policy.
- `SimulatorTestingDrawer.browser.tsx`: **3 passed in Chromium** in the combined browser
  invocation. The new panel fixture initially failed import because unrelated composer
  dependencies consumed the mocked environment module. Isolating those dependencies
  fixed the fixture; the separate panel rerun above passed. Browser execution required
  an approved unsandboxed run because the sandbox denied the local listening port.
- `bun run --cwd apps/server typecheck` and `bun run --cwd apps/web typecheck`: **passed**.
- Focused lint on the seven changed implementation/test files: **exit 0**, with one
  pre-existing `react(set-state-in-effect)` warning in `SimulatorPanel`'s pending-device
  effect. No new lint warnings.
- Focused `bun run fmt:check -- ...` on the eight follow-up files: **passed**.
  `git diff --check`: **passed**.

Follow-up tests total **147 passing tests**. No full repository suite/build or live
simulator lifecycle mutations were run for this bounded change. The original documented
limitations on real app push delivery remain. No commit, push or PR was created.

## Xcode 27 input

Simulator input (pane taps, hardware buttons, agent device tools) travels one of two ways,
chosen by the Mac's CoreSimulator version, not by the selected Xcode. CoreSimulator
1155.4 and later (installed by Xcode 27, even when an older Xcode is selected) delivers
input through the guest's `dtuhidd` service. Older CoreSimulators keep SimulatorKit's
legacy Indigo messages. There is no fallback from `dtuhidd` to Indigo: on Xcode 27.0 the
guest dropped Indigo button and key events while the send still reported success (Synara's
finding; the Xcode 27.1 qualification in the helper's HEADER.md did not reproduce it), and an
Indigo send cannot confirm delivery. Keystrokes are HID key positions, read with the simulator's own
keyboard layout: text the helper types (agent `type_text`) assumes US positions, so on a
German simulator "z" types "y". The pane sends the person's own key positions instead (see
"Pane input, paste and rotation"). The server
logs the transport once (`[device] iOS Simulator input goes through dtuhid on this Xcode`).

`dtuhidd` starts on demand, so the first input after a boot can wait up to 9 seconds. When
input is not delivered, the error tells agents and the pane how much went out:

- `... not delivered to the simulator: nothing was sent: ...` (for example "the simulator's
  input service (dtuhidd) is still starting"): no event of that call left the helper. The
  server has already retried it once; a caller may retry it too.
- `... not delivered to the simulator: input may have been partially delivered; do not
  replay: ...`: part of it went out. The server never replays it; look at the screen
  before sending more input.
- `... nothing was sent: ... cannot finish inside the input deadline`: the gesture or hold
  is longer than the helper's 13-second budget per input. Send a shorter one. A gesture
  that fits but was left too little time by dtuhidd's warm-up is reported as still
  starting instead, and retried.

Long text is typed in chunks of 120 characters, in order, with no other input to the
device in between. A failure stops at the chunk that failed; the chunks before it were
delivered. If that was not the first chunk, the error starts with "Typed the first N of M
characters" and says not to replay the text whole: send only the part that is missing.

## Pane input, paste and rotation

The pane streams input over its frame socket (`/ws/device-frames`) instead of one RPC per
event (`@ryco/shared/deviceLiveInput`, `apps/server/src/device/deviceInputSession.ts`):

- A finger is sent as touch down, moves and up while the pointer moves, so drags scroll
  live and a held press is a long press. Moves are coalesced to one per display frame in the
  browser, and a move still waiting behind a slower injection on the server is replaced by
  the newer one. Leaving the screen, losing pointer capture, the window losing focus or the
  socket closing lifts the finger where it was.
- Keys go out by physical position (`KeyboardEvent.code`), modifiers included, as a
  hardware keyboard and Simulator.app send them, so the simulator's own layout decides the
  character: a German simulator types "z" and "@" where a German keyboard does. Command
  chords stay with the host.
- Paste puts the text on the simulator's pasteboard and presses Command-V. Any Unicode lands
  exactly, whatever the layout, and iOS asks "Allow Paste" as it does for Simulator.app's
  own paste.
- Only owner sessions may send input on the socket, as with the input RPC. The server says
  so when the socket opens; a client that hears nothing (an older server) keeps using the
  tap, swipe and key RPCs. A gesture is fenced to the boot it started on, and a failed phase
  is reported once and never replayed.

Rotation sends the GraphicsServices orientation event Simulator.app sends, to the guest's
`PurpleWorkspacePort`; it works on a headless boot (adapted from serve-sim). The framebuffer
stays portrait and the guest turns its interface inside it, so video, touch coordinates and
the accessibility tree stay in portrait device space and the pane turns the whole chassis.
An app or iPhone that does not support an orientation keeps its interface where it was, as
on a real device. The orientation is published on the device descriptor and forgotten when
the device boots or shuts down. The agents' `rotate` button turns the device a quarter turn
counterclockwise.

To qualify a new Xcode or runtime, build and probe the helper, then run the smoke against a
simulator created for the run. `--probe` must report `"hid": "ok"` and the expected
`inputTransport`. The smoke checks that the home button, a tap and keystrokes reach the
guest:

```sh
bun scripts/device-helper-smoke.ts --probe-only --cache-dir /tmp/helper-cache
bun scripts/device-helper-smoke.ts --udid <udid of a shut-down simulator> --cache-dir /tmp/helper-cache
```

Details are in `apps/server/native/device-helper/HEADER.md` ("Input transports").
