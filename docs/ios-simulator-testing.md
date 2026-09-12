# iOS simulator testing drawer

Open **Simulator testing** under the simulator picker after attaching a booted iOS
simulator. The drawer is scrollable and leaves room for the live screen and existing
capture, recording, hardware-button, detach and shutdown controls.

- Apply light/dark appearance or any of the standard and accessibility Dynamic Type sizes.
- Reapply **Dark mode**, **Large text**, **Dark + large text**, or **Light + default text**
  on any selected simulator. Large text means `accessibility-large`; default means `large`.
  These built-in presets change only the named appearance/text settings. They do not save
  or restore previous device settings, and a failed multi-step preset can partially apply.
- Set latitude/longitude (including zero) or clear simulated location.
- Grant, revoke or reset one supported permission for an explicit app bundle ID.
  Reset prompts on the app's next access; permission changes can terminate the app.
- Send a JSON push payload containing an `aps` object to an explicit bundle ID.
  Payloads are limited to 4,096 UTF-8 bytes and sent through stdin, with no temporary files.
  This tests local app notification handling, not APNs registration or network delivery.

Controls show choices to apply, not live device settings. Nothing is applied on drawer
open or reconnect. Notification permission must be requested/allowed in the app; camera
and notification permission overrides are not offered by this drawer. Runtime-specific
failures are displayed and can be retried. The drawer does not retain bundle IDs, locations
or push payloads across target/thread/connection-generation changes.

## Boundaries

`DeviceTestingInput` travels through the existing owner-only `device.app` RPC and the
shared client-runtime device facade. The backend validates before spawning commands,
requires an explicit booted target, and keeps the selected Xcode environment. It never
boots or attaches a simulator, changes boot ownership, starts a helper, or modifies
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
