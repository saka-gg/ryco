# ryco-device-helper

The native side of Ryco's Device Pane: a macOS program that mirrors and drives
a booted iOS Simulator without `Simulator.app`, using CoreSimulator and
SimulatorKit private APIs.

Source ships in-repo and is compiled on the user's machine with their own Xcode
(`build.sh`), because the private API surface moves with the toolchain. The
binary is cached under `~/Library/Caches/ryco/device-helper/<key>/`, where the
key (`deviceHelperCacheKey` in `@ryco/shared/deviceHelperCache`) combines the
Xcode version and build with a digest of `Sources/` and `build.sh`. The server
and `scripts/device-helper-smoke.ts` share that derivation, and any source
change produces a new key, so a stale binary is never reused.

## Design choices

**Long-running JSON-RPC server, not subcommands.** Attaching to CoreSimulator,
creating the HID client and priming the accessibility translator each cost real
time and are all per-process state. A subcommand design would repay that on
every tap. `--probe` is the one exception: a one-shot preflight for the build and
for the pane's setup checklist.

**Frames leave over a Unix socket, not stdout.** Video and RPC never share a
pipe, so a burst of frames cannot delay a command response. This is the core of
the "must never starve RPC" requirement.

**Private frameworks are `dlopen`'d at runtime**, resolved from `xcode-select -p`
(or `DEVELOPER_DIR`). Nothing is linked at build time, so the binary is
relocatable and a moved/upgraded Xcode produces a diagnosable error rather than a
dyld crash. CoreSimulator is system-wide
(`/Library/Developer/PrivateFrameworks`). SimulatorKit lives in the Xcode
bundle, and Xcode 27 moved it: Xcode 26 and earlier ship it under
`Contents/Developer/Library/PrivateFrameworks`, Xcode 27 under
`Contents/SharedFrameworks`. `build.sh` and `simulatorKitCandidatePaths`
(`CoreSimulatorBridge.swift`) try both, in that order, and a failure names every
location tried. Swift resolves the path once and hands it to the HID bridge
(`RycoHIDBridge.simulatorKitPath`), so the bridge opens exactly the image that
was loaded instead of keeping its own copy of the lookup.

**The Objective-C bridges must be compiled with ARC.** `swiftc` hands `.m` files
to clang _without_ `-fobjc-arc`; under manual retain/release the accessibility
translator's response is released underneath it and `describe-ui` segfaults in
`objc_retain`. `build.sh` compiles them separately with `-fobjc-arc` and links
the objects.

## Protocol

Newline-delimited JSON-RPC 2.0 on stdio: one object per line, requests on stdin,
responses and notifications on stdout. Diagnostics go to stderr and never mix
into the protocol stream.

On start the helper emits `{"jsonrpc":"2.0","method":"ready","params":{"protocolVersion":1,...}}`.

### Methods

| Method           | Params                                                  | Result                                                                    |
| ---------------- | ------------------------------------------------------- | ------------------------------------------------------------------------- |
| `ping`           | –                                                       | `{ok, pid}`                                                               |
| `list`           | –                                                       | `{devices: [{udid, name, state, booted, runtime, deviceType}]}`           |
| `attach`         | `udid`                                                  | display geometry + `capabilities` (below)                                 |
| `stream.start`   | `socketPath`, `keyframeIntervalSeconds?` (2.0)          | `{pixelWidth, pixelHeight, codec, socketPath}`                            |
| `stream.stop`    | –                                                       | `{running: false, emittedFrames, droppedBusyFrames, droppedSocketFrames}` |
| `stream.stats`   | –                                                       | as above, plus `running: true` while streaming                            |
| `tap`            | `x`, `y`, `holdMs?` (80)                                | `{ok}`                                                                    |
| `touch`          | `phase` (`down`\|`move`\|`up`), `x`, `y`                | `{ok}`                                                                    |
| `swipe` / `drag` | `startX`, `startY`, `endX`, `endY`, `durationMs?` (250) | `{ok}`                                                                    |
| `key`            | `usage` (USB HID), `phase?` (`down`\|`up`; omit to tap) | `{ok}`                                                                    |
| `text`           | `text`                                                  | `{ok, characters, skipped}`                                               |
| `button`         | `name`, `phase?`                                        | `{ok}`                                                                    |
| `screenshot`     | `path?`                                                 | `{path, bytes}` or `{base64, bytes}`                                      |
| `describe-ui`    | `maxDepth?` (40)                                        | `{tree}`                                                                  |

All coordinates are **normalized 0..1** with the origin at the top-left.
Out-of-range values are rejected rather than clamped, because they nearly always
mean the caller sent pixels by mistake.

`attach` reports `capabilities: {input, accessibility}`, `degraded: {hid}`, and
`inputTransport` (`dtuhid` or `indigo`, below; `null` without an input client).
A simulator whose HID client fails still streams and reads: input is degraded,
not fatal. `--probe` reports the transport `attach` will use as a top-level
`inputTransport`, next to `toolchain.coreSimulatorVersion`.

Buttons: `home`, `lock`, `side`, `siri`, `volume-up`, `volume-down`.

**Rotation is not a HID button.** The simulator exposes no rotation button over
Indigo, so orientation changes are not part of this protocol; drive them at the
UI level (`xcrun simctl` / the device's own controls). Documented here because
the absence is a deliberate choice, not an oversight.

### Input transports

Synara found that from CoreSimulator 1155.4 (installed by Xcode 27.0) the guest
drops legacy Indigo button and keyboard events and delivers Indigo touches
unreliably, while the host-side send still reports success. (The Xcode 27.1
qualification below did not reproduce that drop.) On those hosts input goes to
the guest's `dtuhidd` daemon instead (`DTUHIDTransport.m`): plain XPC
dictionaries to the `com.apple.coredevice.feature.remote.hid.digitizer` service,
reached through `-[SimDevice lookup:error:]` and the private
`xpc_endpoint_create_mach_port_4sim` / `xpc_connection_enable_sim2host_4sim`
symbols. The service lookup succeeds
even when the daemon cannot run, so the connection is only used after a
liveness barrier is answered; it warms up at `attach` and the first event of
every input waits for it (up to 9 s), reporting "nothing was sent" rather than
acking a black hole. Once an input has sent an event it never waits or
reconnects again: the rest would go to a daemon that never saw its start, so a
connection lost part-way reports a partial delivery instead. When a whole
warm-up (5 attempts) fails, later inputs try once each, at most every 5 s, and
otherwise fail at once with the cause, rather than each holding the helper for
another round under "still starting".
There is no fallback to Indigo on these hosts. Earlier CoreSimulators keep the
Indigo path. The dtuhidd wire format was learned from facebook/idb's
MIT-licensed `FBSimulatorControl/HID` sources; the transport, the delivery
accounting below and the server's replay rules are adapted from Synara
(Emanuele-web04/synara#1924).

The choice is the host's CoreSimulator version (`RycoPreferredInputTransport`
in `CoreSimulatorVersion.h`), not the selected Xcode: CoreSimulator is
system-wide and installed by the newest Xcode on the machine, so a Mac with
Xcode 26 selected but Xcode 27 installed uses `dtuhid` too, for every simulator
runtime. The probe checks only the symbols of the chosen transport
(`SymbolManifest.swift` tags them), because the Indigo builders still resolve on
Xcode 27. `RYCO_DEVICE_HELPER_INPUT_TRANSPORT=indigo|dtuhid` in the helper's
environment overrides the choice for diagnosis only, for example to check
whether an older runtime still takes Indigo input; any other value is ignored.
It is not a fallback: an Indigo send cannot confirm that anything arrived, and
on Xcode 27.0 Synara saw it acked and dropped.

Every input RPC gets a 13 s budget, two seconds inside the server's 15 s request
deadline. A tap hold or a drag that cannot finish inside it is refused before
its first contact, and before waiting for dtuhidd ("cannot finish inside the
input deadline"). One that fits but is left too little time by the warm-up wait
is refused as dtuhidd "still starting" instead, which the server retries. When
input is not delivered, the error says how much went out:

- "... not delivered to the simulator: nothing was sent: <why>" means no event
  of the operation left the helper (dtuhidd still starting, the budget refused
  it). It is safe to retry that RPC. The server retries it once, except a
  deadline refusal: on the same attachment for dtuhidd, after a forced
  re-attach for Indigo (`inputRetryFor` in
  `apps/server/src/device/helperInputErrors.ts`).
- "... not delivered to the simulator: input may have been partially
  delivered; do not replay: <why>" means part of it went out (the first keys
  of a `text`, the start of a drag). The server never replays it, so text is
  never typed twice; the caller should look at the screen first.

`text` stops at the first key that is not delivered and then releases a held
key and Shift, spending at most one more second. A key or button press that
was not delivered sends no release. The server sends long text in chunks of
120 characters, so each chunk fits the budget, and lets no other input to the
device in between. When a chunk after the first fails, the server's error says
how many characters were typed and not to replay the text whole, and no longer
says "nothing was sent".

### Errors

Standard JSON-RPC codes, plus `-32000` (not attached), `-32001` (simulator
failure) and `-32002` (input accepted but not delivered; see above).

## Frame wire format

Frames are written to the Unix socket given to `stream.start`, each as:

```
u32 little-endian length, then that many bytes of envelope
```

The envelope is the contract defined in `packages/contracts/src/device.ts` and
decoded by `packages/shared/src/deviceFrame.ts`. Little-endian throughout:

```
0   u16  magic     0x5346
2   u8   version   1
3   u8   flags     bit 0 = keyframe, bit 1 = codec config (SPS/PPS)
4   u32  sequence  per device, wraps at 2^32; gaps mean dropped frames
8   f64  timestampMs  helper capture clock
16  u8   deviceId byte length
17  ..   deviceId (UTF-8)
..       payload
```

Payload is H.264 in **Annex B** (4-byte start codes) — VideoToolbox emits AVCC
and the helper rewrites the length prefixes, because `VideoDecoder` in the
browser wants Annex B. Parameter sets are sent as their own `codecConfig`
message immediately before each keyframe, so a keyframe is always decodable
alongside the SPS/PPS that precede it.

Encoding is H.264 Baseline, realtime, no frame reordering, with a forced
keyframe roughly every `keyframeIntervalSeconds`.

### Backpressure

Two independent drop points, both deliberate:

- **Encoder**: a new frame arriving while an encode is in flight is dropped
  (`droppedBusyFrames`). Only the newest frame matters for a live mirror.
- **Socket writer**: above a ~4 MB backlog frames are shed rather than queued
  (`droppedSocketFrames`). A consumer that is not draining gets stale frames
  dropped instead of unbounded memory growth.

Frames only arrive when the display changes: the simulator posts a damage
callback, so an idle screen legitimately produces no frames. Anything driving
the stream (including the smoke test) must cause on-screen motion.

## Fidelity notes

`describe-ui` is the **full** accessibility tree via `AXPTranslator` and
`SimDevice.sendAccessibilityRequestAsync` — the same path idb uses — not a
reduced SimulatorKit dump. Each node carries `role` (AX-prefix stripped),
`label`, `value`, `identifier`, `title`, `frame` (x/y/width/height in points),
`enabled` and `children`. Depth is capped (`maxDepth`, default 40) and a capped
node is marked `truncated: true`, so a pathological hierarchy still returns.

A node whose frame is NaN or infinite (off-screen SwiftUI content) omits
`frame`, a non-finite activation point is omitted, and a numeric value that is
not finite is sent as its description. Every message is also validated before
it is written: `NSJSONSerialization` raises an Objective-C exception on NaN,
which used to kill the helper and its stream; a result that is still not valid
JSON is answered with an `internalError` instead.

`text` maps printable ASCII to HID usages with shift. Characters with no mapping
(emoji, most non-ASCII) are skipped and counted in `skipped` rather than failing
the call.

## Testing

`bun run test:device` (`scripts/device-helper-smoke.ts`) compiles the helper,
boots or reuses a simulator, streams ≥30 frames asserting keyframe and Annex B
NAL structure, injects a tap, dumps the accessibility tree, verifies PNG magic on
a screenshot, and shuts down only a simulator it booted itself. It does so on
failure too, and on SIGINT/SIGTERM, including a Ctrl-C that kills `simctl boot`
mid-boot; only SIGKILL can leave that simulator running. The probe verdict uses
the server's parser (`parseHelperProbe`) but is stricter than the pane: any
broken capability fails the run. After `attach` it checks that the attachment
uses the transport the probe reported.

It then checks that input really reaches the guest, which an acked-but-dropped
transport would pass everywhere else: the home button must take Settings out of
the front (another app or the home screen, whose root label is blank, showing
labelled elements of its own), and after Settings is quit and launched fresh, a
tap on its search field followed by `text` with a random token must show the
token in the accessibility tree. The token uses only letters that US, German
and French keyboard layouts put on the same key, because the guest maps key
usages through its own layout. The tree is read with the server's
normalization and the tap goes to the server's tap point for the field; a read
that finds no frontmost application (SpringBoard still starting, an app
launching) is repeated. The screenshot is taken in that state, and the run
presses home at the end. Every input is retried once exactly when the server
would retry it on the same attachment, so dtuhidd still starting on a freshly
created device does not fail the run.

Flags (after `bun scripts/device-helper-smoke.ts`; `--flag value` and
`--flag=value` both work, and any other argument fails the run rather than
being ignored):

- `--probe-only` builds and preflights the helper and never boots a simulator
  (`bun run test:device:probe`).
- `--cache-dir <dir>` builds into `<dir>/<cache key>` instead of
  `~/Library/Caches/ryco/device-helper/<cache key>`.
- `--udid <udid>` drives exactly that iOS simulator. It must be shut down: the
  run boots it and shuts it down at the end. A booted simulator, or one that is
  booting or shutting down, is refused.
- `--allow-booted` (only with `--udid`) reuses that simulator when it is already
  booted, and leaves it running.
- `--screenshot-out <path>` copies the run's screenshot there.
- `--skip-input-check` skips the input check, for a home screen or Settings
  layout its selectors do not know.

Without `--udid` the smoke prefers whatever simulator is already booted, which
suits a developer's own machine. On a shared machine (or from an agent), always
pass `--udid` with a simulator created for the run.

`apps/server/src/device/helperBuildScript.test.ts` runs the real `build.sh`
against fake Xcode 26 and Xcode 27 layouts with a stub `xcrun`, so the
SimulatorKit lookup and the source list are covered in CI without a compiler.

### Offline input-delivery regression

`Tests/InputDeliveryTests.m` drives the HID bridge with a stub dtuhidd
transport, and the transport with a stub device, so no simulator or private
framework is loaded. It checks that input stops when the connection drops, that
a partial delivery is reported as "partially delivered" and never as "nothing
was sent", that a wholly refused operation starts with "nothing was sent:",
that an over-budget hold or drag sends nothing and does not wait for dtuhidd,
that a drag the warm-up left too little time is reported as still starting,
that Shift and the held key are released after a failure in the middle of
`text`, that a tap never sends its touch-up on a reconnected daemon, that a key
or button press that was not delivered sends no release, and that inputs after
a failed warm-up fail at once instead of starting another round. `apps/server/src/device/nativeInputDelivery.test.ts`
compiles and runs it on macOS (CI's test legs are Linux, so it runs locally):

```sh
cd apps/server/native/device-helper
xcrun clang -fobjc-arc -fmodules -framework Foundation -framework CoreGraphics \
  Sources/CoreSimulatorVersion.m Sources/DTUHIDTransport.m Sources/HIDBridge.m \
  Tests/InputDeliveryTests.m -o /tmp/ryco-input-delivery-tests
/tmp/ryco-input-delivery-tests
```

### Xcode 27 qualification

Run on 2026-10-24 with Xcode 27.1 (27A9275), CoreSimulator 1174.9.2 and macOS
27.2 (26B5091g) on Apple silicon, against two simulators created for the run
and deleted afterwards: an iPhone 17 on iOS 27.0 (24A434) and an iPhone 17e on
iOS 26.5 (23F77), both in the host's German locale. The helper ran sandboxed
(the smoke's default); `RYCO_DEVICE_HELPER_NO_SANDBOX` was never needed. Other
test runs kept the machine at a load average of 60-270 on 18 cores.

- `scripts/device-helper-smoke.ts --udid <udid>` passed on both runtimes, on a
  first boot after `simctl erase` and on a warm boot: `--probe` and `attach`
  report `dtuhid`, 69-167 frames with SPS and IDR, the home button takes
  Settings out of the front, a tap focuses Settings' search field and `text`
  types into it, and the screenshot is a PNG. iOS 26.5 vends dtuhidd on
  CoreSimulator 1174 as well, so the host-wide version gate holds for it.
  dtuhidd answered inside the 9 s readiness wait every time; no input needed
  the "still starting" retry. On the iOS 26.5 first boot one `describe-ui`
  reported "no frontmost application" while SpringBoard started, and the
  smoke's second read succeeded.
- Text through dtuhidd: one `text` call with 120 lowercase characters took
  5.0 s, and one with 120 mixed-case characters and spaces 4.8 s. Every
  character landed and no Shift stayed held, so a 120-character chunk fits the
  13 s budget with room. When the keyboard's one-time slide-to-type tip came
  up mid-text, dtuhidd stalled for more than 2 s after 23 characters and the
  call failed with "input may have been partially delivered; do not replay:
  dtuhidd did not take the events in time".
- Keystrokes are HID usages that the guest maps through its own layout: on the
  German simulator "z" types "y" (both transports). Text with letters a
  non-US layout moves will not come out as sent.
- With `RYCO_DEVICE_HELPER_INPUT_TRANSPORT=indigo` on iOS 27.0, the home
  button, a tap and keystrokes reached the guest too (one full smoke run and one
  manual check). Xcode 27.1 does not reproduce the Indigo drop Synara saw on
  Xcode 27.0. `dtuhid` stays the default on 1155.4+ because its liveness probe
  and barrier tell delivered input from lost input, which an Indigo send
  cannot.
