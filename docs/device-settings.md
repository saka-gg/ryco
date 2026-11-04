# Device names and settings

Ryco identifies an execution device by its name in settings, the inbox, project selection, and conversation targets. A Hub owner's custom device name takes precedence over the machine's automatic name. Renaming changes display metadata only: environment IDs, projects, conversations, credentials, and connections stay in place. A desktop's direct connection and its Hub entry remain aliases of the same machine; renaming must not create another local workspace.

Owners can rename an enrolled device from its Hub details, desktop device settings, or the native mobile machine list. The Hub name is shared with every authorized client. A device does not need to be online for its Hub metadata to be renamed. Standalone devices use their existing machine name until enrolled; direct pairing labels remain client-local aliases.

Settings are one page with five groups: **You** (Appearance, Keyboard, Notifications, Account),
**Work** (Chat & composer, Inbox & threads, Projects & worktrees, Git & pull requests), **Agents**
(Providers & models, Usage & cost, Plugins & MCP, Agent Control), **Devices** (All devices, then one
item per device) and **System** (Updates, Data & backup, Diagnostics, About & help). Every row has
one home (`apps/web/src/components/settings/settingsRegistry.ts`).

- **Rows stored in this app** affect the app being used. Appearance, composer preferences, diff
  presentation, and similar interface options stay in that desktop app or browser. A section made
  only of such rows says **This app** under its title.
- **Rows stored on a device** carry a **Per device** chip. A section with such rows shows a device
  bar, "Values for", and its device rows read and write the device chosen there, through that
  device's authorized connection. Choosing another device never changes the current app's
  appearance. A device owner may manage supported remote settings; operators and viewers keep
  their existing access limits, and this app's own rows stay available to them.
- **Shared device settings** (worktree and thread defaults, Git writing, retention, prices, ...;
  `docs/shared-device-settings.md`) show every device at once. While the devices agree a row is
  one control, "Same on all N devices · Set per device", and a change writes every device; a
  device that is offline or read-only shows **queued** and takes the value when it is back. While
  they differ, or after "Set per device", the row lists each device with its status dot, its own
  control and its marks (**Own value** with "Reset to shared", queued, syncing, "Update to share
  settings", "Couldn't apply: …") and offers "Use “X” everywhere". An offline device shows its last
  known value, read only. The device bar's **All devices** pill (the default with two or more
  devices) shows this; a device pill shows that device's own values, with what the others hold, and
  a change there gives that device its own value. Rows that are not shared keep editing the chosen
  device and say which ("On <device>").
- **All devices** ends with **Compare settings**: every shared setting against every device,
  "Only differences" on by default; a row opens its setting where it lives, with its device list
  open. A device page's Overview starts with **Where this device differs**: its own values, queued
  and refused settings, each with Open.
- **A device's page** (its item under Devices) holds its identity, access (reach, pairing links and
  authorized clients, on this computer), security, computer use and power (keep awake, agent CPU
  priority).

Computer use and operating system permissions require the desktop app on the target device. Other
devices' pages explain where to enable them and never mount the current desktop's native
permission controls. Opening settings does not request system permissions; permission checks and
changes remain explicit actions.

Name lookup uses existing descriptor and directory state. It does not probe the operating system, open additional connections, poll permissions, or restart a device.

## Worktree branch prefix

Under **Projects & worktrees**, **Worktree branch prefix** sets the selected server's default namespace for automatically generated worktree branches. The default is `ryco`; `team/agent` produces branches such as `team/agent/deadbeef`. Leave it empty to generate branches without a namespace. Enter a valid Git namespace without a trailing slash (maximum 128 characters).

The setting applies to every client connected to that server, including native mobile and agent-created worktrees. Explicit branch names and source-specific issue naming keep their existing behavior. First-turn generated names retain the temporary branch's namespace. Changing the setting does not rename existing branches; reconciliation continues recognizing legacy `ryco/` branches. Internal checkpoint refs remain stable so existing checkpoints stay readable. There is no project override.

## Providers & models

**Where each provider runs** opens the section: one row per provider, one column per device (all
of them with **All devices** in the device bar, else the device chosen). Rows group each device's
provider instances by instance id; an instance whose id no other device holds joins a row of the
same driver and the same given name, and the row says "matched by name". A cell is that device's
state from its last known config: Ready, Needs sign-in, Needs attention, Not installed, Off,
Checking, or empty when it has no such instance. An offline device shows its last known state,
read only. **Add** (an empty cell of a provider someone added) opens the add-provider dialog for
that device with the driver, name and id filled in, so the new instance joins the row; **Edit**
opens the device's instance editor below. Both are offered only where this client may change
the device's settings. Below the table, the instance list and editor, CLIProxyAPI hubs and the
text-generation model are the device's own (the one the bar shows). Nothing here polls or asks a
device for anything new.

## Back up and restore settings

**Settings → Data & backup → Settings file** has **Back up settings** and **Restore settings**
(beside Restore this app's defaults). One file (`apps/web/src/settingsFile/clientSettingsFile.ts`) holds this
app's preferences, the shared device settings, or both:

- **This app's settings**: the client settings that travel between machines
  (`CLIENT_SETTINGS_FILE_SCOPE`; a new client setting fails typecheck until it is placed), every
  appearance setting, the color mode and theme, and custom themes.
- **Shared device settings** (`deviceSettings`, `apps/web/src/settingsFile/deviceSettingsFile.ts`):
  the shareable device settings (`docs/shared-device-settings.md`) as the devices hold them: per
  setting the newest shared value, else the value they agree on, else the value of the device the
  settings show. `DEVICE_SETTINGS_FILE_SCOPE`
  places every shareable key (a new one fails typecheck until placed); paths stay out. Device-only
  settings (provider instances, CLIProxyAPI hubs, the default and text-generation models, ...)
  never travel.

The file never carries anything that names a node, an account, a connection or a credential, nor
machine-local state (onboarding, dismissed notices, model favorites and provider model order keyed
by node-local instance ids, per-project grouping, the preferred editor). Keybindings keep their
own file in Settings → Keyboard. A file with this app's settings only is version 1; a file with
device settings is version 2, because a Ryco that reads version 1 only would drop the device part
without a word (and read a file with device settings only as "nothing to change"): it asks for an
update instead. This Ryco reads both, and files from before the device part read as before.

A restore is checked before anything is written: every value against its setting's schema, every
custom theme against the theme file rules. Unknown keys and refused values are listed and keep
the current value. The dialog lists each change as `key: old -> new` (for device settings, per
device, with each setting's name and its values as its row shows them); nothing changes until
Apply. Each part can be left out.

- This app's part is all or nothing: a custom theme whose id is taken arrives as a copy (the
  theme choice follows it), client settings are saved last, and if they cannot be saved every
  other value the restore wrote goes back and no device is written. Once it is restored, Apply
  again (after the device part could not be written) retries only the device part.
- The device part goes to **Every device** (default): one shared write per setting
  (`writeSharedSetting`); an offline device that follows the shared value takes it when it is
  back (queued), a device that keeps its own value for a setting keeps it (listed), and a device
  on an older Ryco gets a plain edit while it is online. Or to **Only these devices** (online
  devices this client may change): each gets the change as a one-device edit
  (`editDeviceSetting`), its own value, except that the only known device keeps following the
  shared value, as when it is edited alone; the dialog says which become their own. A picked
  device that goes offline or loses write access drops out of the plan.
- Only a device that will really take the value later is called queued. A device this client
  may not change, an offline override, an offline device on an older Ryco, and a picked device
  that disconnects during the write are reported as not applied, with why. Apply stays off while
  no target changes now or later.
- Results are reported per device: applied, queued until online, kept its own value (or needs
  an update), not applied, or couldn't apply with the device's reason.

## Hosted devices

A hosted device's **Access** tab says where network access and pairing are set (on the device
itself) and links to the device on the Hub (**Open on Hub**), which opens the Hub's node list with
that device's details. The address names no node; the request is kept in memory.
