# Settings redesign: one page, every device

Status: design, approved direction (2026-11-03). Not implemented.

## Decisions (user, 2026-11-03)

1. Per-device settings are **shared, with per-device overrides**. One control writes every device;
   a device can opt out of a setting and keep its own value.
2. A change to a shared setting while a device is offline is **queued and applied on reconnect**.
3. A device's own pages (Access, Security, Computer use, Power) are **items under Devices in the
   nav**, not a switcher at the top.
4. **Full regroup**: five groups, General retired, renames applied.

## Problems today

- Two parallel navs, "This app" and "Device settings", with the same section names (General,
  Source control, Diagnostics, Integrations) holding different rows. You must know where a value is
  stored before you can find it, and pick a device before you can see its value.
- General holds 30+ unrelated rows (worktree paths, model prices, quit shortcut, streaming, device
  name, welcome tour).
- Related rows are split: diff layout in Appearance, diff wrapping and whitespace in Source control;
  Test notification in Diagnostics; Keep awake in Connections; Connections and Security overlap.
- Per-device values must be set one device at a time. "Apply to all nodes"
  (`ApplyToAllNodes.tsx`, `nodeSettingsFanOut.ts`) is a one-time bulk write; nothing keeps devices
  in line afterwards, and an offline device is skipped.
- Two auto-settle settings exist (client `sidebarAutoSettleAfterDays`, node
  `threadAutoSettleAfterDays`, migrated in `packages/shared/src/serverSettings.ts`).

## Information architecture

One nav, five groups. Every row has one home. Rows whose value lives in this app carry no chip;
rows stored on devices carry **Per device**; Hub rows carry **Account**. "Desktop only" marks rows
that need the desktop app.

| Group | Section | Rows (storage) | Comes from |
| --- | --- | --- | --- |
| You | Appearance | color mode, theme, accent, contrast, fonts, text size, translucency, chat width (app); time format (app) | Appearance; General |
| You | Keyboard | send shortcut, quit shortcut (app); shortcut editor (app) | Keybindings (renamed); General |
| You | Notifications | thread alerts, sound, in-app toasts (app); test notification | General; Diagnostics |
| You | Account | Hub identity, encryption keys (account). Hosted only, opens the Hub as today | Account |
| Work | Chat & composer | follow-up behavior, Claude resume review, build mode, composer labels, open chat tabs, window capture (app); response streaming (device) | General; Appearance |
| Work | Inbox & threads | auto-settle (device), archive/delete/unpin confirmations (app), archived threads (device) | Inbox; General; Archive |
| Work | Projects & worktrees | default thread mode, add-project folder, worktree root, branch prefix, change-type names, submodules, continue after restart, setup script, project overrides (device); default editor, terminal command (app) | General |
| Work | Git & pull requests | writing style, commit/PR instructions, PR templates, text-generation model (device); remote status, refresh mode, PR link target, diff layout/wrap/whitespace (app); hosting accounts (device) | Source control (renamed); Appearance |
| Agents | Providers & models | provider instances as a provider × device table, CLIProxyAPI hubs, default model (device) | Providers (renamed) |
| Agents | Usage & cost | limits display, model prices (device), statistics link | General; Statistics |
| Agents | Plugins & MCP | Ryco plugins, MCP servers (device) | Plugins + MCP (merged) |
| Agents | Agent Control | enable, delegation limits, paired clients (device) | Integrations (node part) |
| Devices | All devices | device cards, add a device, compare table | Connections (reach part) |
| Devices | *one item per device* | tabs: Overview (name, icon, what differs), Access (network, Tailscale, pairing, authorized clients), Security (fingerprint, session code, keys, admission policy), Computer use (desktop app only), Power (keep awake, agent CPU priority) | Connections, Security, Integrations (app part), General |
| System | Updates | update everything, update track, automatic updates, provider update checks (device) | Updates; General |
| System | Data & backup | import sessions, chats folder, storage retention, lifecycle suggestions (device); settings file export/import (app) | General; Storage |
| System | Diagnostics | logs, traces, resources (device, device picked in-panel); app performance (app) | Diagnostics |
| System | About & help | version, release notes, welcome tour | General |

The final row inventory is generated from `settingsSearchIndex.ts` plus `ClientSettingsSchema`
and `ServerSettings`; a test fails when a field or index entry has no home (extends the existing
"new client setting fails typecheck until placed" rule of the settings file).

Old section ids keep working as redirects (`settingsDialogStore`, command palette, the
`HostedE2eeVerification` pointer to "Settings → Security", which becomes "Settings → <device> →
Security"). `SETTINGS_SECTION_LABELS` stays the single source the copy tests read.

The frozen web phone tier keeps today's inventory (AGENTS.md: do not extend it). `apps/mobile`
adopts the same section model later through `packages/client-runtime`.

## Sharing model

### Which settings can be shared

A catalog in `packages/shared` (runtime, not contracts) lists each node setting key with a
sharing class:

- **shareable**: worktree/branch/thread defaults, git writing, PR templates, response streaming,
  auto-settle, provider update checks, automatic updates, retention, lifecycle suggestions, model
  prices, Ryco plugin installs, Agent Control on/off. Paths (`worktreeRoot`, `chatsRoot`,
  `addProjectBaseDirectory`) are shareable but are the usual overrides.
- **device-only**: name, icon, network/Tailscale/pairing, security policy, keep awake, agent CPU
  priority, provider instances (handled by the provider × device table), CLIProxyAPI hubs,
  observability, anything holding a secret.

Project-scoped maps (`projectWorktreeRoots`, `projectGitWritingStyle`, ...) stay device-only in
v1: project ids are node-local.

### Where the shared state lives

On each device, next to the value. `ServerSettings` gains

```ts
settingsSharing: Record<ShareableKey, {
  mode: "shared" | "override";
  stamp: { at: number; by: string }; // writer's hybrid clock ms + client id
}>
```

No Hub storage (local-only setups have no Hub) and no client-local queue (desktop, web and phone
would each hold a different queue and fight). Devices are the source of truth; any client that
sees two devices can converge them.

### Writes

- **Change a shared row**: the client writes value + new stamp to every device in `shared` mode
  it can write to now. Offline devices are not written; they are "queued" (below).
- **Set per device**: writes the value with `mode: "override"` to that device only.
- **Reset to shared**: sets `mode: "shared"` on that device and adopts the newest shared stamp seen
  on any other device.
- **Use X everywhere**: one shared write; overrides on the other devices are cleared.

### Convergence ("queue")

A reconciler in `packages/client-runtime/src/state/settings/` runs on config pushes for connected
devices. For each shareable key it takes the newest `shared` stamp across all known devices and
writes it to any connected, writable, `shared`-mode device holding an older stamp. Ordering is
`(at, by)`, so two clients always pick the same winner. It never touches `override` devices, never
writes without the hosted mutation capability (`canWrite` from `nodeSettingsTargets`), batches one
patch per device, and backs off on failure.

An offline device shows **queued** while its stamp is older than the newest known one. It catches
up the next time any client sees it next to a newer device. The client also caches the newest
stamp per key so the catch-up works when the newer devices are themselves offline; the cache is a
hint only, devices stay authoritative.

A device that rejects a value (a path invalid on that OS, validation in `serverSettings.ts`)
reports it; the row shows **Couldn't apply on build: <reason>** and offers "Set per device".

### Rollout and migration

- No stamps exist on first run. Keys where all devices agree become shared with a zero stamp.
  Keys that differ stay as they are and show **Differs**; nothing is overwritten until you choose a
  value. No silent clobbering.
- A device on an older Ryco has no `settingsSharing`: it shows **Update to share settings**, is
  written only by explicit per-device edits, and is never counted as queued.
- Hosted: only clients with the owner/mutation capability write or reconcile; viewers see values
  read-only.

## UI behavior

- **Shared row, all equal**: one control, "Same on all 3 devices · Set per device".
- **Shared row, differing**: inline device list with each device's control, status dot, queued /
  couldn't-apply / override marks, and "Use X everywhere".
- **Device filter** on sections with device rows: All devices or one device; one-device mode shows
  that device's value and what the others hold.
- **All devices**: cards (status, version, update ready, providers, projects), add device, and a
  compare table of shareable keys with "Only differences"; a row jumps to the setting.
- **Device page Overview**: "Where this device differs" lists its overrides and queued keys.
- **Search** returns live, editable rows from every section and device page.
- **Providers & models**: provider × device table; add to a device from its column.

## Delivery phases

Each phase ships on its own and leaves settings usable.

1. **Regroup (web only)**: new nav groups, sections, renames, moves, redirects for old ids, search
   index and palette, devices as nav items reusing today's per-device panels. Behavior unchanged:
   device rows still edit one device.
2. **Devices**: All devices page with cards and a read-only compare table (`readNodeSettingsAgreement`),
   device pages with Overview/Access/Security/Computer use/Power tabs.
3. **Inline device values**: per-device rows show every device's value and edit any of them;
   "Use X everywhere" via the existing fan-out. Still no stamps.
4. **Shared with overrides**: catalog, `settingsSharing` in contracts and server persistence,
   reconciler in client-runtime, queued / couldn't-apply / update-to-share states, migration rule.
5. **Providers table and settings file**: provider × device table; settings restore that picks
   target devices; mobile adopts the section model.

## Testing

- Unit: catalog covers every `ServerSettings` key; every row has one home; reconciler ordering,
  idempotence, override safety, no write without capability, backoff; migration (agree → shared,
  differ → untouched); old-node handling.
- Server: `settingsSharing` round-trips, redaction untouched, rejected values reported.
- Browser: nav, redirects, search reveal, matrix states, offline device queued then applied after
  reconnect, two clients converging to the same value.
- Bundle: the settings route stays behind its dynamic import; reconciler code is not pulled into
  the app entry except the minimal client-runtime piece (boot budget check).

## Defaults I chose (change if wanted)

- Shared state on devices with clock stamps, not on the Hub or in the client.
- Differing values at rollout are left alone, not unified.
- Project-scoped overrides stay per device in v1.
- The frozen web phone tier is not migrated.
