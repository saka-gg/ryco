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

`attach` reports `capabilities: {input, accessibility}` and `degraded: {hid}`. A
simulator whose HID client fails still streams and reads: input is degraded, not
fatal.

Buttons: `home`, `lock`, `side`, `siri`, `volume-up`, `volume-down`.

**Rotation is not a HID button.** The simulator exposes no rotation button over
Indigo, so orientation changes are not part of this protocol; drive them at the
UI level (`xcrun simctl` / the device's own controls). Documented here because
the absence is a deliberate choice, not an oversight.

### Input on Xcode 27

From CoreSimulator 1155.4 (installed by Xcode 27) the guest drops legacy Indigo
button and keyboard events and delivers Indigo touches unreliably, while the
host-side send still succeeds. Input there goes through the guest's `dtuhidd`
service, which this helper does not speak yet. Rather than ack input that never
arrives, the helper reports it as unavailable: `--probe` fails the `hid`
capability with the reason, `attach` answers `capabilities.input: false` with
`degraded.hid` set, and every input call fails with "HID input is unavailable
for this simulator: <reason>". Streaming, screenshots and `describe-ui` keep
working.

The gate is the host's CoreSimulator version (`CoreSimulatorVersion.h`, also
reported as `toolchain.coreSimulatorVersion` by `--probe`), not the selected
Xcode: CoreSimulator is system-wide and installed by the newest Xcode on the
machine, so a Mac with Xcode 26 selected but Xcode 27 installed is affected too,
for every simulator runtime.

### Errors

Standard JSON-RPC codes, plus `-32000` (not attached) and `-32001` (simulator
failure).

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
broken capability fails the run, so on CoreSimulator 1155.4+ it stops at "helper
capabilities unavailable: hid" until the helper speaks `dtuhidd`.

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

Without `--udid` the smoke prefers whatever simulator is already booted, which
suits a developer's own machine. On a shared machine (or from an agent), always
pass `--udid` with a simulator created for the run.

`apps/server/src/device/helperBuildScript.test.ts` runs the real `build.sh`
against fake Xcode 26 and Xcode 27 layouts with a stub `xcrun`, so the
SimulatorKit lookup and the source list are covered in CI without a compiler.
