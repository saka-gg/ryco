# Settings as a Centered Popup

## Goal

Convert the Settings surface from a route-based view (`/settings/*`) to a
centered modal dialog that overlays the current page. The dialog has a
two-pane layout: a narrow rail on the left for section navigation and a
content area on the right that hosts the existing per-section panel
components.

## Non-goals

- **URL-addressable settings.** Settings is no longer a route. Bookmarks to
  `/settings/providers` will 404 after this change. We accept this — settings
  is a modal task, not a page worth sharing.
- **Cross-session persistence of dialog state.** The last-viewed section is
  remembered for the lifetime of the app session only. Closing and reopening
  Claude Code starts at "General".
- **Redesign of individual settings panels.** `ProvidersSettingsPanel`,
  `AppearanceSettings`, etc. keep their current structure and styling. They
  just render inside a dialog instead of inside a route `<Outlet />`.
- **Mobile-first sheet/drawer treatment.** The dialog stays a centered modal
  on small screens (rail collapses to icons-only). No bottom-sheet variant.

## Scope

In scope:

- New Zustand store `settingsDialogStore.ts` exposing `{ open, section,
  openSettings(section?), closeSettings(), setSection() }`.
- New component `SettingsDialog.tsx` that renders the dialog popup (header
  with title + Restore Defaults + close, two-pane body, no footer). Mounted
  once at the root layout via `AppSidebarLayout`.
- Migrate every `navigate({ to: "/settings/..." })` call site to
  `openSettings(section?)`.
- Replace the `<a href="/settings/connections">` link in
  `routes/_chat.index.tsx` with a button that calls
  `openSettings("connections")`.
- Delete all seven `routes/settings*.tsx` files.
- Delete `components/settings/SettingsSidebarNav.tsx` (the rail nav becomes
  inline in `SettingsDialog`).
- Revert the recent sidebar back-button work: remove `lastNonSettingsPathRef`,
  the `isOnSettings`-driven branch in `SidebarChromeHeader`, and the
  conditional `<SettingsSidebarNav />` swap in `Sidebar.tsx`. The sidebar
  always renders projects content; the header button always says "Settings".

Out of scope:

- Compatibility shim/redirect for old `/settings/*` URLs.
- Any change to the panel components' internal layouts.
- Persisting `open` or `section` to localStorage.

## Architecture

### Store

`apps/web/src/settingsDialogStore.ts`:

```ts
import { create } from "zustand";

export type SettingsSectionId =
  | "general"
  | "providers"
  | "appearance"
  | "source-control"
  | "connections"
  | "archived";

interface SettingsDialogStore {
  open: boolean;
  section: SettingsSectionId;
  openSettings: (section?: SettingsSectionId) => void;
  closeSettings: () => void;
  setSection: (section: SettingsSectionId) => void;
}

export const useSettingsDialogStore = create<SettingsDialogStore>((set) => ({
  open: false,
  section: "general",
  openSettings: (section) => set((state) => ({ open: true, section: section ?? state.section })),
  closeSettings: () => set({ open: false }),
  setSection: (section) => set({ section }),
}));
```

`openSettings()` without an argument keeps whatever section was last
selected (or "general" on first open). Passing a section overrides it.

### Dialog component

`apps/web/src/components/settings/SettingsDialog.tsx`:

- Uses the existing `Dialog` / `DialogPopup` / `DialogHeader` / `DialogTitle`
  primitives from `components/ui/dialog.tsx`.
- `open` and `onOpenChange` bound to the store.
- `DialogPopup` overrides: `className="max-w-[960px] h-[min(80vh,720px)]"`,
  `bottomStickOnMobile={false}`, `showCloseButton={true}`.
- Header: `DialogTitle` "Settings" + `RestoreDefaultsButton` (only when
  section is `general`, `providers`, or `appearance` — same condition as
  today's `settings.tsx` route).
- Body: `flex flex-row` with a `w-48 border-r` rail and a `flex-1 min-w-0`
  content area. The content area uses `ScrollArea` (already wrapped by
  `DialogPanel`-equivalent styling, but we'll inline the scroll because
  panels already manage their own scroll behavior).
- Rail: a fixed-width `w-48` (sm and up) / `w-12` (`<sm`) sidebar containing
  the 6 nav buttons. The width transition is driven by a Tailwind responsive
  utility on the rail container; labels are hidden via `hidden sm:inline`
  when the rail is in icon-only mode.
- Section switching: `setSection` from the store. Active panel resolved via
  a switch over the section id:

  | Section id       | Component                    | Imported from                                |
  | ---------------- | ---------------------------- | -------------------------------------------- |
  | `general`        | `GeneralSettingsPanel`       | `components/settings/SettingsPanels`         |
  | `providers`      | `ProvidersSettingsPanel`     | `components/settings/ProvidersSettingsPanel` |
  | `appearance`     | `AppearanceSettingsPanel`    | `components/settings/AppearanceSettings`     |
  | `source-control` | `SourceControlSettingsPanel` | `components/settings/SourceControlSettings`  |
  | `connections`    | `ConnectionsSettings`        | `components/settings/ConnectionsSettings`    |
  | `archived`       | `ArchivedThreadsPanel`       | `components/settings/SettingsPanels`         |

- Nav items constant: the `SETTINGS_NAV_ITEMS` array currently exported by
  `SettingsSidebarNav.tsx` (label, section id, lucide icon) moves into
  `SettingsDialog.tsx` as a local constant. The exported `SettingsSectionPath`
  type is replaced by the `SettingsSectionId` union from the store.

### Restore-defaults reuse

The current `RestoreDefaultsButton` component lives inline in
`routes/settings.tsx`. It's a thin wrapper over `useSettingsRestore` from
`components/settings/SettingsPanels.tsx`. We extract it into a reusable
component (`SettingsDialog.tsx` co-locates it, or a small standalone file —
implementer's choice) and use it in the dialog header. The
`restoreSignal`-based remount pattern (`<div key={restoreSignal}>`) is
preserved so panels reset properly after a restore.

### Mounting

`SettingsDialog` is rendered once at the root, alongside `<Outlet />` and
the existing `<CommandPalette />`. The natural home is
`AppSidebarLayout.tsx`. Base UI's Dialog uses a portal, so its DOM position
in the tree doesn't affect overlay z-index or positioning.

### Call-site migration

| File                                                                    | Current                                                | New                                                    |
| ----------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------ |
| `Sidebar.tsx` (`SidebarChromeFooter` Settings button, around line 2449) | `navigate({ to: "/settings" })`                        | `openSettings()`                                       |
| `AppSidebarLayout.tsx:47` (Electron menu)                               | `navigate({ to: "/settings" })`                        | `openSettings()`                                       |
| `CommandPalette.tsx:787`                                                | `navigate({ to: "/settings/source-control" })`         | `openSettings("source-control")`                       |
| `CommandPalette.tsx:1065`                                               | `navigate({ to: "/settings" })`                        | `openSettings()`                                       |
| `ChatView.tsx:1233`                                                     | `navigate({ to: "/settings/connections" })`            | `openSettings("connections")`                          |
| `GitActionsControl.tsx:522`                                             | `navigate({ to: "/settings/source-control" })`         | `openSettings("source-control")`                       |
| `routes/_chat.index.tsx:55`                                             | `<Button render={<a href="/settings/connections" />}>` | `<Button onClick={() => openSettings("connections")}>` |

### Sidebar settings-route cleanup

The current `Sidebar.tsx` has an `isOnSettings`-conditional that swaps the
projects panel for `<SettingsSidebarNav />` when the user is on a settings
route. With routes gone, this branch goes too:

- `Sidebar.tsx`: drop the `isOnSettings`-conditional rendering of
  `<SettingsSidebarNav />`. The sidebar always renders
  `<SidebarProjectsContent />` plus the chrome footer.
- Drop the `pathname` and `isOnSettings` derivations and the
  `useLocation` import if they're not used elsewhere in the file.
- Drop the `import { SettingsSidebarNav }` line.

### Route deletions

Delete:

- `apps/web/src/routes/settings.tsx`
- `apps/web/src/routes/settings.general.tsx`
- `apps/web/src/routes/settings.providers.tsx`
- `apps/web/src/routes/settings.appearance.tsx`
- `apps/web/src/routes/settings.source-control.tsx`
- `apps/web/src/routes/settings.connections.tsx`
- `apps/web/src/routes/settings.archived.tsx`

`routeTree.gen.ts` regenerates automatically via the TanStack Router Vite
plugin.

## Behavior

### Opening

- Sidebar header Settings button → `openSettings()` → opens at last-viewed
  section (or "general" first time).
- Command Palette "Settings" → `openSettings()`.
- Command Palette "Source Control settings" → `openSettings("source-control")`.
- ChatView "Connections" empty-state button → `openSettings("connections")`.
- Source Control panel "Open settings" button → `openSettings("source-control")`.
- Electron app-menu "Open Settings" → `openSettings()`.

### Closing

- Escape key (Dialog default).
- Backdrop click (Dialog default).
- X button in the header (Dialog default).
- All three call `closeSettings()`. The active section is preserved on
  close so reopening returns to the same place.

### Switching sections

- Click a rail button → `setSection(id)`. Right pane swaps immediately, no
  transition. Same UX as today's tabbed sidebar nav.

### Nested dialogs

The Providers panel opens `AddProviderInstanceDialog`; theme editor and
connection flows have their own dialogs. All use the same Base UI primitive,
which has built-in nested-dialog support (the `--nested-dialogs` CSS var
scales/translates the parent). No code change required; manually verify
nested-dialog appearance after the migration.

## Testing

Manual verification:

- Open settings from each of the seven entry points listed above. Confirm
  correct starting section and that the popup is centered.
- Switch sections via the rail. Confirm right pane updates and Restore
  Defaults visibility is correct (shown on general/providers/appearance,
  hidden on the others).
- Open Add-Provider dialog from Providers section. Confirm nested dialog
  appears correctly above the settings popup with the expected scale/offset.
- Close via Escape, backdrop, X button. Confirm app returns to the previous
  page with no visible state change.
- Resize the browser to `<sm` width. Confirm rail collapses to icon-only and
  popup remains centered (no bottom-sheet treatment).
- Trigger Restore Defaults. Confirm panels reset (the existing
  `restoreSignal` remount mechanism still works inside the dialog).

Existing automated tests:

- `SettingsPanels.editor.test.ts`, `SettingsPanels.logic.test.ts`,
  `ProviderInstanceCard.test.ts`, `ProviderSettingsForm.test.ts`,
  `ThemeEditor.test.ts`, `codexUsageLimits.test.ts`,
  `pairingUrls.test.ts` — none of these import the deleted routes; they
  should keep passing without changes.
- `Sidebar.logic.test.ts` — no settings-route assertions; should keep passing.

No new automated tests required. The dialog is a thin shell over existing,
already-tested panel components.

## Migration / cleanup

After this change ships:

- Any external bookmarks to `/settings/*` will land on the app's not-found
  page. Acceptable — see Non-goals.
- `routeTree.gen.ts` will be regenerated; do not hand-edit.
