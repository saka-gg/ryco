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

## Export and import app preferences

**Settings → Data & backup → Settings file → Export / Import** (this app's own preferences, beside Restore defaults)
saves or reads one `ryco-client-settings.json` (`apps/web/src/settingsFile/clientSettingsFile.ts`):
the client settings that travel between machines (`CLIENT_SETTINGS_FILE_SCOPE`; a new client
setting fails typecheck until it is placed), every appearance setting, the color mode and theme,
and custom themes. It never carries anything that names a node, an account, a connection or a
credential, nor machine-local state (onboarding, dismissed notices, model favorites and provider
model order keyed by node-local instance ids, per-project grouping, the preferred editor).
Keybindings keep their own file in Settings → Keyboard.

An import is checked before anything is written: every value against its setting's schema, every
custom theme against the theme file rules. Unknown keys and refused values are listed and keep
the current value. The dialog lists each change as `key: old -> new`; nothing changes until
Apply. A custom theme whose id is taken by another theme arrives as a copy, and the theme choice
follows it. Client settings are saved last; if they cannot be saved, every other value the import
wrote goes back.
