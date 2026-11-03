# Shared device settings

Node settings that make sense on every device (worktree defaults, git writing, retention, ...)
are **shared**: one edit writes every device, and devices that missed it catch up later. A device
can opt out of a setting with an **override** and keep its own value. Design:
`docs/superpowers/specs/2026-11-03-settings-redesign-design.md` ("Sharing model").

## Where things live

| Piece                              | Module                                                                |
| ---------------------------------- | --------------------------------------------------------------------- |
| Which keys are shareable           | `@ryco/shared/settingsSharing` (`SERVER_SETTING_SHARING`)             |
| Stamp and entry schemas            | `@ryco/contracts/settings` (`SettingsSharing*`)                       |
| Node rules for a sharing patch     | `@ryco/shared/settingsSharing`, applied by `applyServerSettingsPatch` |
| Capability (sharing version)       | `ExecutionEnvironmentCapabilities.settingsSharingVersion`             |
| Clock and client id                | `@ryco/client-runtime/state/settings/settingsSharingClock`            |
| Planner, row view model, commands  | `@ryco/client-runtime/state/settings/sharedDeviceSettings`            |
| Runner and command executor        | `@ryco/client-runtime/state/settings/sharedDeviceSettingsRunner`      |
| Web runner targets                 | `apps/web/src/environments/settingsSharingTargets.ts`                 |
| Web runtime (runner, started idle) | `apps/web/src/settingsSharing/settingsSharingRuntime.ts`              |
| Settings rows and compare table    | `apps/web/src/components/settings/sharedSettings/`                    |

## Model

Each device keeps, next to its settings, `settingsSharing`: per shareable key
`{ mode: "shared" | "override", stamp: { at, by } }`. A missing entry means shared with the zero
stamp. Devices are the source of truth; there is no Hub copy and no client-side queue.

- **Shareable** keys: worktree, branch and thread defaults, setup script, paths (`worktreeRoot`,
  `chatsRoot`, `addProjectBaseDirectory`), git writing style and instructions, pull request
  templates, response streaming, auto-settle, usage-limit recovery, provider update checks,
  automatic updates, retention, lifecycle suggestions, chat folder cleanup, agent token mode,
  model prices, Agent Control (on/off and delegation limits).
- **Device-only** keys: everything keyed by node-local ids (project maps, provider instances and
  the model selections that name them), the machine icon, agent CPU priority, provider binaries
  and secrets, CLIProxyAPI hubs, observability and event logs. A test fails when a
  `ServerSettings` key is not classified.

## Stamps

A stamp is a hybrid logical clock: `at` is the writer's clock in ms, never behind the wall clock,
any stamp it issued, or any stamp it has seen on a device; `by` is the writer's stable client id
(one per app install). Stamps order by `(at, by)`, ties of equal stamps by the lowest environment
id, so every client picks the same winner. Because a client observes every device's stamps before
it stamps an edit, a person's edit orders after everything their client showed, even when another
client's clock runs ahead. Concurrent edits from clients that had not seen each other resolve to
the higher stamp (last writer wins).

A value and its stamp travel in **one** `ServerSettingsPatch` and land in one atomic
`settings.json` write.

## Node rules

`applyServerSettingsPatch` (node and the web's optimistic update alike):

- Entries for keys that are not shareable are refused; a `shared` entry must carry its value.
- A **catch-up** entry (`onlyIfOlderShared: true`) applies only while the device is in `shared`
  mode with an older stamp; otherwise the node drops the entry and the key's value and applies the
  rest of the patch. Sending the same catch-up twice, from one client or two, changes nothing.
- `null` removes an entry (back to shared with the zero stamp).
- An unstamped change to a shared key that already has a non-zero stamp (an older client, an
  agent, a one-device edit) turns that key into an **override** on that device, keeping its stamp.
  Such an edit is never carried to other devices; an agent on one node cannot change another.
- A value the device rejects (a path invalid on that OS) fails the whole write with the node's
  message; neither the value nor the stamp is kept. The runner then resends the batch one key at a
  time, so it can report **Couldn't apply** for that key alone while the others land.

## Client

- The **planner** (`planSettingsSharingCatchUp`) takes, per key, the newest non-zero `shared` stamp
  across all known devices (and the cache) and writes it, guarded as a catch-up, to every
  connected, writable device in `shared` mode holding an older stamp: one patch per device. It
  never writes an override, an unsupported device, or a zero-stamp value.
- **Commands** build per-device patches for a person's edit, each with a fresh stamp from
  `nextSettingsSharingStamp`: `writeSharedSetting` (shared devices only, guarded),
  `setSettingOverride`, `resetSettingToShared` (adopts the newest shared value and stamp),
  `useSettingEverywhere` (clears overrides on devices it can write now). Send them with
  `executeSettingsSharingCommand` and hand the result to the runner's `noteCommand`.
- The **runner** subscribes to device config pushes, debounces, runs one pass at a time, reads each
  device again right before writing it, and retries a refused key with exponential backoff
  (2 s doubling to 10 min). A sent catch-up waits up to 30 s for the device's push before it is sent
  again.
- The **cache** of the newest shared value per key is persisted by the client and is a hint only:
  an entry is used only while the device it was learned from is still among the known devices,
  and any device holding a newer stamp wins. It lets an offline device catch up when every newer
  device is offline too.
- **Per namespace**: the client id, the clock's last stamp and the cache are stored per namespace
  (`createScopedSettingsSharingPersistence`): `local` for this app's own connections, or one per
  Hub origin and account. Another account in the same browser never sees this one's id or values.

Row states (`readSharedSettingView`): `shared`, `override`, `syncing`, `queued` (offline or not
writable, holding an older stamp), `unsupported`, `unknown` (no config yet), `couldNotApply`.

## Migration

No writes happen at rollout. Without stamps, keys where all devices agree read as shared
(`agreement: same`); keys that differ show **Differs** and stay untouched until a person picks a
value. Nothing is unified on its own.

## Older nodes

A node on an older Ryco decodes `settingsSharing` to the empty default, so the settings cannot tell
it apart. Clients read the **`settingsSharingVersion` capability** instead: one small integer, so
the pre-auth descriptor (and the Hub enrollment metadata that embeds it) names no settings. Each
key has the version that made it shareable (`SHAREABLE_SETTING_SINCE_VERSION`); a key added later
gets the next version, and keys never leave the set. A key shares only when the node's version
covers it and the client knows it, so newer nodes and newer clients both keep working. A device
without the capability shows **Update to share settings**, gets only explicit per-device edits
(without `settingsSharing`), and is never counted as queued.

## Hosted

Only a client that may change the node's settings now writes or catches up: the owner, or a
hosted session whose own environment session currently grants `server.updateSettings`. The
runner never keeps that answer: it reads every target again right before each write, so a
superseded session generation or a lost grant never inherits a planned write. Viewers see values
read-only.

## Settings UI

Every row of a shareable key on the settings page is one `SharedSettingRow`
(`apps/web/src/components/settings/sharedSettings/`): it takes the key and a
`render({ value, onChange, disabled, deviceLabel, ... })` for the row's existing control, and
sends every edit through the commands above, so a shared key never turns into an override by
accident:

| Edit                                                                  | Command                                               |
| --------------------------------------------------------------------- | ----------------------------------------------------- |
| The one control ("Same on all N devices")                             | `writeSharedSetting`                                  |
| A device's control in the list, or one device shown by the device bar | `setSettingOverride` (plain edit on an older node)    |
| The only device                                                       | `writeSharedSetting`, or its override when it has one |
| "Reset to shared"                                                     | `resetSettingToShared`                                |
| "Use “X” everywhere"                                                  | `useSettingEverywhere`                                |

Layouts: `inline` (a control beside the title), `block` (a text area under it), `editor` (a whole
form with its own Save, such as model prices: drawn once, for every device while they agree or for
the device shown; while they differ the row lists each device's value with an Edit). A row that
edits one field of a larger value (Agent Control's limits, the two cleanup suggestions) compares
only that field (`compareBy`). Policy editors inside bigger sections (the storage retention policy)
use `useSharedSettingWriter`. The display catalog (`sharedSettingsCatalog.ts`) gives each key its
section, title and value format, for the rows, the compare table and "Where this device differs".

Agreement treats devices on the same shared write as agreeing even when their stored values
differ: a device stores a path the way it normalized it (`~/` expanded, symlinks resolved), so
`~/w` reads `/Users/me/w` on a Mac and `/home/me/w` on Linux after one shared write.

The runner starts once the app shell is idle (`settingsSharingStart.ts`, a dynamic import), so an
offline device catches up when it reconnects with settings closed. In hosted mode its writes go
through each node session's current grant (see Hosted), and it restarts with its own client id,
clock and cache when the signed-in account changes.

Writes outside the rows: the settings page's "Restore defaults" (this device's), the desktop quit
dialog's "Continue after restart" (this computer's backend) and an agent's settings change on a
node stay plain per-device edits; on a key that already has a shared write they make that device
keep its own value. The one-time auto-settle hand-over writes only devices that keep no rule yet.
