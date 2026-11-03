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
| Runtime (runner per namespace)     | `@ryco/client-runtime/state/settings/settingsSharingRuntime`          |
| Web runner targets                 | `apps/web/src/environments/settingsSharingTargets.ts`                 |
| Web runtime (runner, started idle) | `apps/web/src/settingsSharing/settingsSharingRuntime.ts`              |
| Settings rows and compare table    | `apps/web/src/components/settings/sharedSettings/`                    |
| Mobile runtime, bridge and edits   | `apps/mobile/src/features/settings/sharing/`                          |

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

## Paths

A node stores the worktree root and the chats folder the way it normalized them (`~/` expanded,
symlinks resolved), so one shared write of `~/w` reads `/Users/me/w` on a Mac and `/home/me/w` on
Linux. Copying one device's stored path to another would be wrong on another OS, so for these keys
(`WRITTEN_VALUE_SETTING_KEYS`) the sharing entry also keeps the value **as written**
(`SettingsSharingEntry.written`):

- The node records it itself (`recordWrittenSettingValues`, on the patch as received, before it
  normalizes anything), so `written` is always what the writer sent; clients build the same entry
  for their optimistic copy.
- Devices share the written value (`readWrittenShareableSettingValue`): the newest shared value,
  the catch-up writes, "Reset to shared" and the client's cache all carry `~/w`, and each node
  normalizes it for its own machine. A path invalid there fails that write ("Couldn't apply").
- `written` stands for the stored value: it is kept while the value stays (an override without a
  value keeps it) and dropped once the value changes without one (an unstamped edit), when the
  stored value speaks for itself again.
- Agreement compares written values; two devices on the same shared write whose entries predate
  `written` (no record) agree by their equal stamp, and their catch-up falls back to the stored
  value.

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
- The **runtime** (`createSettingsSharingRuntime`) is what each app makes once: it keeps one
  runner for the current namespace (made again when the account changes), counts starts (the
  last stop stops and forgets the runner), stamps a person's edit (`nextEditStamp`) and sends it
  (`runCommand`, each device written once, through its target as read at that moment). The web
  and the mobile app give it their own storage, namespace and device list.

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

Rows show and compare a path as written (see Paths): `~/w` on every device after one shared
write, though each stores its own expansion.

**All devices with the device bar's device unusable** (offline, or not this reader's to change):
shared rows still show and write, through any device this client may write now
(`pickSharedRowsDevice`: connected, a config, writable; this app's own first), and an offline
device catches up later. Rows stored on one device wait for it: in this mode (`SharedRowsOnly`
in `settingsLayout.tsx`) a row outside a shared row renders nothing, and sections and panels
without a shared row hide; one line under the device bar says why. With no writable device the
section waits as before. Stale hosted roles stay fail-closed: such a device is not writable, so it
neither shows the rows nor lends them.

The runner starts once the app shell is idle (`settingsSharingStart.ts`, a dynamic import), so an
offline device catches up when it reconnects with settings closed. In hosted mode its writes go
through each node session's current grant (see Hosted), and it restarts with its own client id,
clock and cache when the signed-in account changes.

A settings restore (Data & backup → Restore settings, `docs/device-settings.md`) writes the file's
shared settings through the same commands: to every device with `writeSharedSetting` (offline
devices queue, overrides stay), or to the devices a person picks with `setSettingOverride`, which
the dialog names as their own values.

## Mobile

The native app (`apps/mobile/src/features/settings/sharing/`) uses the same runtime:

- Its client id, clock and cache live in expo-sqlite's kv-store, read and written synchronously
  (`settingsSharingStorage.ts`), per namespace: the signed-in Hub account at its Hub, else the
  phone's own (direct) connections.
- `SettingsSharingBridge` (mounted with the unlocked workspace, loaded when idle) publishes the
  nodes as Home lists them, each as a write target (`homeNodeSettingsTargets`: owner, connected
  and synchronized to write), and runs the runtime only while the app is in the foreground
  (`runSettingsSharingInForeground`; `inactive` counts as foreground, as in `appLifecycle`). The
  phone never polls or writes in the background.
- Its node screens send the commands (`sharedSettingEdits.ts`): an edit on one node's panel
  (new-task defaults, auto-settle, the node's storage retention policy) is that node's own value,
  stamped (`editDeviceSetting`; the only node keeps following the shared value), and **Use on every
  node** is one shared write (`useSettingEverywhere`) whose result names the nodes that take it
  when they reconnect. The initial model and project overrides stay plain per-node writes.
- The settings home groups and names its rows from `@ryco/client-runtime/state/settings/settingsSections`,
  the same section model as the web's settings page.

Writes outside the rows: the settings page's "Restore this device's defaults", the desktop quit
dialog's "Continue after restart" (this computer's backend) and an agent's settings change on a
node stay plain per-device edits; on a key that already has a shared write they make that device
keep its own value. The one-time auto-settle hand-over writes only devices that keep no rule yet.
