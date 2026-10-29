# iOS Simulator Workspace Pane Design

Status: approved design
Date: 2026-08-17
Reference: [Synara v0.7.2](https://github.com/Emanuele-web04/synara/tree/v0.7.2), especially feature commit `467d2f21` (`feat(device): iOS Simulator pane (#529)`)

## Summary

Ryco will add a fully interactive iOS Simulator workspace tab with functional parity to Synara
0.7.2. A user can discover and boot simulators, watch a live low-latency screen, interact with mouse
and keyboard, use hardware controls, install and launch applications, save screenshots, and record
video. Every built-in Ryco provider receives the same provider-neutral device tools so an active
agent can inspect and operate the attached simulator with the existing approval model.

The implementation will reuse and adapt Synara's MIT-licensed native helper and proven device
lifecycle logic. It will not port Synara's client transport or right-dock architecture. Ryco's server
will remain the authoritative simulator owner, `packages/client-runtime` will own client connection
and device state, and `apps/web` will present the feature as another tab in the existing route-backed
workspace panel.

## Goals

- Match the user-visible and agent-visible iOS Simulator capabilities in Synara 0.7.2.
- Keep simulator lifecycle, helper processes, recording, and ownership on the macOS Ryco node.
- Support non-phone web and desktop clients connected to a capable macOS node, including remote and
  hosted connections without bypassing their existing authorization or lifecycle owner.
- Bind one device-tool catalogue to Codex, Claude, GitHub Copilot, OpenCode, Cursor, and Grok.
- Preserve Ryco's performance and reliability priorities with bounded queues, explicit ownership,
  generation fencing, and deterministic cleanup.
- Keep contracts provider-neutral so a future Android backend can implement the same boundary.

## Non-goals

- Android emulators or physical Apple devices.
- Extending the frozen `apps/web` phone presentation tier or adding this surface to `apps/mobile`.
- Building user applications. Agents continue to use their normal shell commands, Xcode, Tuist, or
  other project tooling; device install and launch are the integration points.
- Embedding or automating the visible Simulator.app window.
- Simulator rotation. Headless CoreSimulator does not provide a reliable rotation path through
  simctl, CoreSimulator, or SimulatorKit, and rotating only the rendered canvas would misrepresent
  the guest orientation.
- User-configurable stream quality, frame rate, resolution, or encoder settings in the first release.

## Product behavior

### Availability

The server publishes a typed device capability and setup state. The Simulator tab is offered only to
non-phone web presentation tiers connected to a macOS node. A Mac with missing Xcode, an unaccepted
licence, no installed iOS runtime, or an unbuilt helper still exposes the tab so the user can follow
the setup checklist. Non-Mac nodes and `apps/mobile` do not expose the tab or its shortcut.

The capability is derived from the connected node, not the browser's operating system. A Windows or
Linux desktop browser may therefore use the simulator when it is connected to a macOS Ryco node.

### Workspace integration

`simulator` becomes a `RightPanelMode` and a `workspaceTab` route value alongside Review, Files,
Terminal, and Agents. It uses the existing resizable inline sidebar, sheet behavior where already
supported, tab-close behavior, remembered per-thread state, and maximize affordance. Ryco does not
adopt Synara's independent right-dock store or add a second permanent lane.

The tab can be opened from the workspace tab menu and with a configurable
`workspace.simulator` keybinding command. An agent device interaction requests that the tab open for
the owning thread. If that thread is active, the route changes to the Simulator tab. If it is
inactive, Ryco records the pending open request and applies it when the thread becomes active; it
never navigates the user away from a different thread.

### Visible states

The panel renders these explicit states:

1. **Checking:** the node capability and thread snapshot have not arrived.
2. **Setup:** an actionable checklist for Xcode selection, licence acceptance, iOS runtime
   installation, and helper compilation. Setup is polled only while this state is visible.
3. **No selection:** a device picker lists model, runtime, boot state, and current attachment.
4. **Booting and attaching:** the selected device appears immediately while booting, helper
   connection, and first-frame readiness have distinct progress labels.
5. **Live:** the screen, device status, direct input surface, and control rail are available.
6. **Agent active:** a bounded badge indicates that an agent device tool is executing.
7. **Recovering:** the last valid frame stays visible while the frame channel reconnects.
8. **Failed:** an actionable, typed error explains the failed stage and the safe retry or setup
   action.

### Direct controls

- Click maps to tap; pointer drag maps to swipe; keyboard input is forwarded while the device frame
  owns focus.
- Hardware controls cover Home, lock, volume up, and volume down.
- The action rail supports saving a screenshot, starting/stopping a recording, detaching, and
  shutting down the selected device.
- Screenshot and recording results use server-selected paths and report those paths to the user.
- The frame scales within the panel while retaining the device's source aspect ratio and coordinate
  mapping. Maximizing uses the existing workspace-panel control.
- There is no rotate control.

### Prompt screenshot context

When a prompt clearly asks Ryco to inspect the simulator screen, the composer attempts to attach one
current screenshot before sending. Matching requires both a device scope phrase, such as “on the
simulator” or “device screen,” and an inspection action, such as “look,” “read,” “describe,”
“screenshot,” or “check.” This avoids attaching an image for unrelated build requests that merely
mention a simulator.

The feature runs only when the thread has a booted attachment. Screenshot capture, decoding, or
attachment preparation failure never blocks the user's message. The ordinary attachment size and
count limits remain authoritative.

## Architecture

### Boundaries

- `packages/contracts` contains schemas and types only: device identifiers, descriptors,
  availability, thread attachment state, operations, events, frame metadata, tool inputs/outputs,
  and RPC errors.
- `packages/shared` contains runtime utilities that are platform-independent, including binary frame
  envelope encoding/decoding and helper cache-key calculation. These use explicit subpath exports.
- `apps/server` owns `DeviceService`, `DeviceBackend`, the iOS backend, helper compilation and
  processes, device tools, recording, persistence, RPC handlers, authorization, and cleanup.
- `packages/client-runtime` owns typed device RPC methods, connection-aware device state, event
  application, reconnect snapshots, and the supervised low-priority frame channel. It contains no
  DOM, Electron, or React Native imports.
- `apps/web` owns the workspace-tab presentation, WebCodecs decoding, canvas rendering, pointer and
  keyboard mapping, toolbar controls, prompt screenshot preparation, and route/open-request glue.
- `apps/desktop` owns no simulator lifecycle. Its only simulator-specific work is ensuring the native
  helper sources and Seatbelt profile are included in development and packaged server resources.

### Server device service

`DeviceService` is a memoized Effect service provided on every platform. On macOS it constructs an
`IosSimulatorBackend`; elsewhere it returns an explicit unsupported availability state. This keeps
RPC and provider layers platform-neutral and avoids conditional dependency graphs.

The service owns:

- device discovery and normalized capability reporting;
- one selected device per thread and versioned `ThreadDeviceState` snapshots;
- Ryco boot ownership and the global owned-device limit;
- helper attach/retry state and viewer-facing errors;
- lazy frame capture and bounded subscriber fan-out;
- screenshot and recording state;
- agent-activity counts and pane-open requests;
- thread removal, server shutdown, idle cleanup, and crash recovery.

All device operations go through a `DeviceBackend` interface. Unit tests use a `FakeDeviceBackend`;
no test of manager policy shells out to simctl or Xcode.

### iOS backend and native helper

`IosSimulatorBackend` uses `xcrun simctl` for inventory, boot, shutdown, install, launch, URL, and
recording operations. A source-shipped Swift/Objective-C helper uses CoreSimulator and SimulatorKit
private APIs for the display surface, HID input, hardware buttons, accessibility data, screenshots,
and hardware H.264 encoding through VideoToolbox.

The helper is compiled on first attach with the user's selected Xcode. The cache key includes the
Xcode build identity, host architecture, and a digest of every helper source/build input. Any input
change invalidates the cache. The packaged product ships source and build metadata, not a helper
binary compiled against one Xcode release.

The helper runs under a deny-by-default Seatbelt profile that grants only the required Xcode,
CoreSimulator, helper-cache, log, and temporary paths and grants no network access. A clearly named
diagnostic opt-out may run it unconfined to isolate sandbox regressions; the panel and logs must state
when confinement is disabled.

Helper commands use request identifiers, bounded payloads, deadlines, and acknowledgements. A stale
boot or missing HID acknowledgement cannot be reported as a successful input. Capability probes
fail with a typed setup/helper error rather than crashing the server.

### State and control transport

Device control uses Effect RPC methods and versioned device-event subscriptions in the existing
authenticated connection. The client requests a fresh thread snapshot on mount and whenever its
supervised connection generation becomes open. Events older than the current thread-state version or
connection generation are ignored.

Frames use a dedicated low-priority logical channel owned by `client-runtime`:

- direct and saved connections may use a second authenticated binary WebSocket;
- hosted connections use a dedicated encrypted virtual relay channel under the existing hosted
  lifecycle owner;
- neither path may create an alternate readiness, authorization, or reconnect owner;
- the production service worker never caches frame traffic, device RPC, screenshots, recordings,
  request bodies, or helper content.

The server retains only the current codec configuration and most recent keyframe for late
subscribers. Each subscriber queue is limited to eight frames, and a transport backlog above 2 MiB
causes frames to be dropped. After any dependent-frame drop, delivery waits for the next keyframe.
Codec configuration is never intentionally dropped. Encoding starts on the first visible subscriber
and stops after the last subscriber leaves, even when the thread attachment remains.

The web decoder derives its AVC codec string from the received SPS, prepends cached parameter sets to
the next keyframe, closes every `VideoFrame`, and requests a resync after decode failure. Frame
reconnect starts at 500 ms and uses exponential backoff capped at five seconds.

## Lifecycle and ownership

One thread selects at most one simulator. Multiple threads may attach to the same simulator. An
agent never replaces a different device explicitly selected for its thread; it only attaches its
target when the thread has no device or already uses that device.

Ryco distinguishes two boot sources:

- **External:** already booted by the user, Simulator.app, or another process. Ryco never
  auto-shuts it down.
- **Ryco-owned:** booted through the pane or a device tool. Ryco may clean it up under the following
  rules.

At most three Ryco-owned simulators may be booted globally. A fourth boot returns a structured
`boot-limit-reached` result with safe shutdown candidates; it is not a generic failure. Switching a
thread away from an otherwise unused Ryco-owned device shuts that device down immediately; the old
device's frame socket, which the switching pane closes only after the switch, does not count.

Otherwise a Ryco-owned device stays up while anything still uses it: a boot in flight, a recording,
an in-flight device call (pane input, an agent tool, an Agent Control action), a frame viewer, a
thread a person attached, or an agent's hold for the provider turn that is still its thread's
running turn (as the orchestration projection's `thread.session-set` reports it). An agent's
attachment is metadata and does not count. When the last of these settles, a ten-minute idle grace
starts; it is rechecked when it fires and again after the stream is torn down, and the shutdown is
abandoned if anything arrived meanwhile; a refused simctl shutdown starts the grace over. Thread
archive, trash and deletion end that thread's attachment and holds; unlike a detach, they leave a
recording running while a person on another thread still watches the device. Input, attaches,
viewers and recordings that arrive while an idle shutdown is already with simctl wait for it and
then boot the device again, within the cap; an explicit shutdown waits for it instead of issuing a
second one. An approved Agent Control action holds the device only for the turn running when it
starts. Server disposal finalizes recordings, stops streams, and shuts down every Ryco-owned
device.

Owned UDIDs are written atomically with the owning server PID. On startup, Ryco reclaims only a
still-booted UDID recorded by a process that is no longer alive. Missing, corrupt, ambiguous, or
live-sibling ownership data means “own nothing.” Recovery never broadens ownership and never runs
`simctl shutdown all`.

A cold boot may report `booted` before its display exists. Attach retries transient display failures
every 750 ms for at most 60 seconds. Non-transient helper, capability, or device errors fail
immediately. Detach, shutdown, or a newer attach increments an attempt token so an older retry loop
cannot publish state.

## Provider device tools

The server owns one `DeviceToolCatalogue` with these names and behaviors:

- `device_list`
- `device_boot`
- `device_install`
- `device_launch`
- `device_open_url`
- `device_tap`
- `device_swipe`
- `device_type`
- `device_press_button`
- `device_screenshot`
- `device_describe_ui`
- `device_scroll_to_element`

The catalogue is served through a scoped built-in tool gateway. A binding is tied to the thread,
runtime session, provider instance, runtime mode, and active turn. It is revoked when the session is
replaced or stopped, and handlers reject calls without a live matching turn. Simulator logic is not
duplicated inside provider adapters.

Provider-specific binding is limited to transport configuration:

- Codex receives the gateway through its session MCP configuration.
- Claude receives it through Claude Agent SDK MCP support.
- GitHub Copilot and OpenCode receive it through their native session MCP configuration.
- Cursor and Grok receive a non-empty ACP `mcpServers` binding.

Bindings are ephemeral and do not modify user-level provider or MCP configuration files. A
capability audit enumerates `BUILT_IN_DRIVERS`; every enabled built-in driver must have a tested
binding strategy. A pane-only fallback does not satisfy this feature's completion criteria.

Successful install, launch, or interaction tools attach the device when allowed and publish an open
request for the owning thread. All tool calls mark the thread agent-active for the exact duration of
the operation. Expected navigation misses, such as a label not found or scrolling reaching the end,
remain tool feedback; infrastructure and viewer-actionable failures also update the panel error.

## Authorization and approval

Device RPC uses the existing authenticated `RpcPrincipal` and access policy:

- an authenticated viewer may read capability, thread state, device inventory, accessibility data,
  screenshots, and live frames for content the principal may already view;
- only a node owner may boot, install, launch, open URLs, inject input, control hardware, record,
  detach, or shut down a device;
- direct panel interactions are explicit owner gestures and require no second confirmation;
- provider calls are additionally scoped to their live thread/session/turn binding.

Agent list, screenshot, and accessibility-tree operations are read-only. Agent boot, install,
launch, URL, tap, swipe, scroll, type, and hardware-button operations require the provider's normal
approval gate. The gateway refuses a mutating call before any effect when the provider/runtime cannot
offer that gate. `device_open_url` always remains in the approval-required class because arbitrary
URLs can exfiltrate data.

Install inputs resolve against the session workspace and cannot escape it. URLs, text, coordinates,
durations, swipe counts, attachment bytes, frame envelopes, and recording operations have schema and
runtime bounds. Logs never contain frame payloads, screenshots, typed text, URLs, credentials, or
application screen contents.

## Error model and recovery

Contracts expose structured device errors for unsupported platform, setup incomplete, unavailable
device, boot limit, helper build failure, helper protocol/capability failure, attach timeout, stale
session, authorization denial, invalid input, stream loss, screenshot failure, and recording failure.
The panel maps each code to a stable title, detail, retryability, and one safe action.

The following recovery behavior is mandatory:

- reconnect obtains a fresh authoritative snapshot before accepting later events;
- an old connection generation cannot publish state, readiness, frames, or input success;
- stream failure preserves the last valid frame and reconnects with bounded backoff;
- decoder failure resets to codec configuration plus a new keyframe;
- helper input is successful only after acknowledgement;
- helper/process loss finalizes active recording state and publishes an actionable error;
- recording stop is idempotent and returns stable completion metadata;
- recoverable agent navigation failures do not replace a healthy panel with a fatal state.

Diagnostics may report availability, helper/Xcode build identity, lifecycle phase, queue/drop counts,
reconnect attempts, and sanitized error codes. They must not include simulator content or user data.

## Packaging and attribution

Desktop development and packaging include the helper source tree, build script, symbol/capability
manifest, and Seatbelt profile in the server resources. Packaging verification asserts that every
required input is present and that the cache digest includes it.

The adapted Synara portions remain covered by the upstream MIT licence. Ryco will add a Synara entry
to `THIRD_PARTY_NOTICES.md` naming `Emanuele-web04/synara`, tag `v0.7.2`, feature commit `467d2f21`,
Copyright (c) 2026 T3 Tools Inc., and Copyright (c) 2026 Emanuele Di Pietro, followed by the complete
upstream MIT notice. File headers may describe adaptation provenance, but the repository notice is
the authoritative attribution location.

## Testing strategy

### Normal CI

- Contract decode/encode tests cover IDs, states, bounds, events, RPC methods, and error variants.
- Shared tests cover frame envelope framing, malformed input, codec/keyframe flags, and helper cache
  digests.
- `FakeDeviceBackend` tests cover boot ownership, the three-device cap, multiple attachments, switch
  and detach cleanup, crash recovery, attach races, attempt tokens, idle timers, stream subscriber
  lifecycle, recording finalization, agent activity, and open requests.
- iOS backend tests mock process execution and cover simctl parsing, Xcode selection, beta toolchains,
  helper compilation, cache invalidation, capability probes, protocol acknowledgements, sandbox
  command construction, and reboot behavior.
- Transport tests cover the eight-frame queue, 2 MiB socket budget, drop-until-keyframe behavior,
  late-subscriber priming, reconnect generations, hosted relay channel ownership, and stale-frame
  rejection.
- RPC tests cover viewer reads, owner-only mutation, validation, subscriptions, reconnect snapshots,
  and thread removal.
- Provider tests cover every built-in binding, live-turn scoping, approval-required annotations,
  refusal without an approval gate, tool result mapping, and pane-open behavior.
- Client-runtime tests cover device state reduction, environment isolation, connection generation
  changes, and supervised frame subscriptions.
- Web unit/browser tests cover route parsing, tab registration, setup polling, device selection,
  progress states, screen coordinate mapping, keyboard and hardware controls, screenshots,
  recordings, auto-open, prompt screenshot matching, reconnect UI, maximize, and exclusion from
  phone/native-mobile surfaces.

### macOS qualification

A `bun run test:device` smoke CLI compiles the helper with the selected Xcode, lists and boots a test
simulator, captures enough frames to decode a keyframe, injects and acknowledges a tap, reads the
accessibility tree, takes a screenshot, and shuts down only the simulator it booted. A helper build
matrix compiles against supported stable and beta Xcode toolchains where available. Real-device
qualification is documented and remains separate from ordinary cross-platform unit CI.

### Repository validation

This feature is large and crosses major runtime boundaries, so implementation completion requires:

```sh
bun install --frozen-lockfile
bun fmt
bun run fmt:check
bun lint
bun typecheck
bun run test
bun run build
bun run build:desktop
bun run --cwd apps/web test:browser:install # only when the pinned browser is absent
bun run --cwd apps/web test:browser
```

Focused checks should run during development; the full backstop runs once after integration. The
native smoke CLI runs when the local Mac has a supported Xcode and simulator runtime.

## Acceptance criteria

The feature is complete when all of the following are true:

1. A non-phone web or desktop client connected to a macOS Ryco node can open the Simulator workspace
   tab, complete setup, select a device, and receive a live screen.
2. User tap, swipe, typing, Home, lock, volume, screenshot, recording, detach, and shutdown actions
   behave predictably and report acknowledgement or a typed failure.
3. Codex, Claude, Copilot, OpenCode, Cursor, and Grok can use every applicable `device_*` tool through
   a scoped session binding, with the approved read/mutation policy.
4. Agent interaction opens or remembers the Simulator tab for the correct thread without stealing a
   deliberate device attachment or navigating away from another active thread.
5. Direct, saved, desktop, and hosted connections use shared `client-runtime` state and authorization;
   stale generations cannot publish readiness, frames, or mutation success.
6. Slow or disconnected clients cannot build an unbounded frame backlog or starve control RPC.
7. Ryco never auto-shuts down a simulator it cannot prove it booted, including after a crash.
8. Missing Xcode/runtime/helper capability produces the setup experience rather than a crash.
9. The native mobile app, the frozen web phone tier, and non-Mac nodes do not expose the feature.
10. Packaged desktop/server artifacts contain the helper sources, build inputs, sandbox profile, and
    required third-party attribution.
