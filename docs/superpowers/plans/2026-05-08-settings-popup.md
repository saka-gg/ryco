# Settings Popup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the route-based `/settings/*` surface into a centered modal popup with a two-pane layout (left rail + content), driven by a Zustand store; delete the settings routes; migrate every entry point that used to call `navigate({ to: "/settings/..." })`.

**Architecture:** A new `useSettingsDialogStore` Zustand store owns `{ open, section }`. A new `SettingsDialog` component renders the existing per-section panel components (`GeneralSettingsPanel`, `ProvidersSettingsPanel`, `AppearanceSettingsPanel`, `SourceControlSettingsPanel`, `ConnectionsSettings`, `ArchivedThreadsPanel`) inside a Base UI `Dialog`. The dialog is mounted once at root via `AppSidebarLayout`. Seven existing call sites are repointed from `navigate(...)` to `openSettings(section?)`.

**Tech Stack:** React 19, Zustand, Base UI Dialog (`@base-ui/react/dialog`), TanStack Router (only for deletion of the route files; no new router work), Tailwind 4, Bun, TypeScript.

**Spec:** `docs/superpowers/specs/2026-05-08-settings-popup-design.md`

---

## File Structure

**Created:**

- `apps/web/src/settingsDialogStore.ts` — Zustand store: `useSettingsDialogStore`, `SettingsSectionId` type.
- `apps/web/src/components/settings/SettingsDialog.tsx` — the popup. Bound to the store. Renders rail + active panel.

**Modified:**

- `apps/web/src/components/AppSidebarLayout.tsx` — mount `<SettingsDialog />`; repoint Electron `open-settings` menu action.
- `apps/web/src/components/Sidebar.tsx` — repoint `SidebarChromeFooter` Settings button; remove `isOnSettings` branch and the `<SettingsSidebarNav />` swap; drop unused imports.
- `apps/web/src/components/CommandPalette.tsx` — two call sites (`openSourceControlSettings`, root "Open settings" action).
- `apps/web/src/components/ChatView.tsx` — "Connections" empty-state button.
- `apps/web/src/components/GitActionsControl.tsx` — `openSourceControlSettings`.
- `apps/web/src/routes/_chat.index.tsx` — replace `<a href="/settings/connections" />` with a button.

**Deleted:**

- `apps/web/src/routes/settings.tsx`
- `apps/web/src/routes/settings.general.tsx`
- `apps/web/src/routes/settings.providers.tsx`
- `apps/web/src/routes/settings.appearance.tsx`
- `apps/web/src/routes/settings.source-control.tsx`
- `apps/web/src/routes/settings.connections.tsx`
- `apps/web/src/routes/settings.archived.tsx`
- `apps/web/src/components/settings/SettingsSidebarNav.tsx`
- The settings entries in `apps/web/src/routeTree.gen.ts` (regenerated automatically by the TanStack Router Vite plugin).

---

## Per-Task Verification

Tests in this codebase are component- and logic-level (Vitest). The spec explicitly says no new automated tests are required for the dialog — it's a thin shell over already-tested panels. Each task uses **typecheck + manual smoke check** as the verification gate. Run from the repo root:

```bash
bun run typecheck
```

A passing typecheck after every task is mandatory. Manual smoke checks are listed per task where they apply.

---

### Task 1: Add the settings dialog store

**Files:**

- Create: `apps/web/src/settingsDialogStore.ts`

- [ ] **Step 1: Create the store file**

```ts
// apps/web/src/settingsDialogStore.ts
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

- [ ] **Step 2: Run typecheck**

```bash
bun run typecheck
```

Expected: PASS. The new file has no consumers yet, so this just confirms the file itself compiles.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/settingsDialogStore.ts
git commit -m "feat(web): add settings dialog Zustand store"
```

---

### Task 2: Create the SettingsDialog component

**Files:**

- Create: `apps/web/src/components/settings/SettingsDialog.tsx`

- [ ] **Step 1: Create the file with the full component**

```tsx
// apps/web/src/components/settings/SettingsDialog.tsx
import { useCallback, useState, type ComponentType } from "react";
import {
  ArchiveIcon,
  BlocksIcon,
  GitBranchIcon,
  Link2Icon,
  PaletteIcon,
  RotateCcwIcon,
  Settings2Icon,
} from "lucide-react";

import { type SettingsSectionId, useSettingsDialogStore } from "../../settingsDialogStore";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";
import { ScrollArea } from "../ui/scroll-area";
import { AppearanceSettingsPanel } from "./AppearanceSettings";
import { ConnectionsSettings } from "./ConnectionsSettings";
import { ProvidersSettingsPanel } from "./ProvidersSettingsPanel";
import { ArchivedThreadsPanel, GeneralSettingsPanel, useSettingsRestore } from "./SettingsPanels";
import { SourceControlSettingsPanel } from "./SourceControlSettings";

interface NavItem {
  id: SettingsSectionId;
  label: string;
  icon: ComponentType<{ className?: string }>;
}

const NAV_ITEMS: ReadonlyArray<NavItem> = [
  { id: "general", label: "General", icon: Settings2Icon },
  { id: "providers", label: "Providers", icon: BlocksIcon },
  { id: "appearance", label: "Appearance", icon: PaletteIcon },
  { id: "source-control", label: "Source Control", icon: GitBranchIcon },
  { id: "connections", label: "Connections", icon: Link2Icon },
  { id: "archived", label: "Archive", icon: ArchiveIcon },
];

const SECTIONS_WITH_RESTORE: ReadonlySet<SettingsSectionId> = new Set([
  "general",
  "providers",
  "appearance",
]);

function RestoreDefaultsButton({ onRestored }: { onRestored: () => void }) {
  const { changedSettingLabels, restoreDefaults } = useSettingsRestore(onRestored);
  return (
    <Button
      size="xs"
      variant="outline"
      disabled={changedSettingLabels.length === 0}
      onClick={() => void restoreDefaults()}
    >
      <RotateCcwIcon className="size-3.5" />
      Restore defaults
    </Button>
  );
}

function SectionPanel({ section }: { section: SettingsSectionId }) {
  switch (section) {
    case "general":
      return <GeneralSettingsPanel />;
    case "providers":
      return <ProvidersSettingsPanel />;
    case "appearance":
      return <AppearanceSettingsPanel />;
    case "source-control":
      return <SourceControlSettingsPanel />;
    case "connections":
      return <ConnectionsSettings />;
    case "archived":
      return <ArchivedThreadsPanel />;
  }
}

export function SettingsDialog() {
  const open = useSettingsDialogStore((s) => s.open);
  const section = useSettingsDialogStore((s) => s.section);
  const closeSettings = useSettingsDialogStore((s) => s.closeSettings);
  const setSection = useSettingsDialogStore((s) => s.setSection);

  const [restoreSignal, setRestoreSignal] = useState(0);
  const handleRestored = useCallback(() => {
    setRestoreSignal((v) => v + 1);
  }, []);

  const showRestore = SECTIONS_WITH_RESTORE.has(section);

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) closeSettings();
      }}
    >
      <DialogPopup
        className="h-[min(80vh,720px)] max-w-[960px] overflow-hidden p-0"
        bottomStickOnMobile={false}
        showCloseButton={true}
      >
        <header className="flex h-12 shrink-0 items-center justify-between border-b border-border px-5">
          <DialogTitle className="text-base font-semibold">Settings</DialogTitle>
          <div className="flex items-center gap-2 pr-9">
            {showRestore ? <RestoreDefaultsButton onRestored={handleRestored} /> : null}
          </div>
        </header>

        <div className="flex min-h-0 flex-1 flex-row">
          <nav className="flex w-12 shrink-0 flex-col gap-1 border-r border-border p-2 sm:w-48">
            {NAV_ITEMS.map((item) => {
              const Icon = item.icon;
              const isActive = section === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setSection(item.id)}
                  className={cn(
                    "flex items-center gap-2.5 rounded-md px-2 py-2 text-left text-[13px] outline-hidden ring-ring transition-colors focus-visible:ring-2",
                    isActive
                      ? "bg-accent font-medium text-foreground"
                      : "text-muted-foreground/70 hover:text-foreground/80",
                  )}
                  aria-label={item.label}
                  aria-current={isActive ? "page" : undefined}
                >
                  <Icon
                    className={cn(
                      "size-4 shrink-0",
                      isActive ? "text-foreground" : "text-muted-foreground/60",
                    )}
                  />
                  <span className="hidden truncate sm:inline">{item.label}</span>
                </button>
              );
            })}
          </nav>

          <ScrollArea className="min-h-0 flex-1 min-w-0">
            <div key={restoreSignal} className="flex flex-col">
              <SectionPanel section={section} />
            </div>
          </ScrollArea>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
```

- [ ] **Step 2: Run typecheck**

```bash
bun run typecheck
```

Expected: PASS. All panel imports resolve to existing exports (verified during planning).

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/settings/SettingsDialog.tsx
git commit -m "feat(web): add SettingsDialog popup component"
```

---

### Task 3: Mount the dialog and migrate the Electron menu handler

**Files:**

- Modify: `apps/web/src/components/AppSidebarLayout.tsx`

- [ ] **Step 1: Add the import for the store**

In `apps/web/src/components/AppSidebarLayout.tsx`, add a new import alongside the existing imports near the top of the file:

```ts
import { SettingsDialog } from "./settings/SettingsDialog";
import { useSettingsDialogStore } from "../settingsDialogStore";
```

- [ ] **Step 2: Replace the Electron menu handler**

Replace the existing `useEffect` that listens for `open-settings` (currently around line 39–54). Find:

```tsx
const navigate = useNavigate();

useEffect(() => {
  const onMenuAction = window.desktopBridge?.onMenuAction;
  if (typeof onMenuAction !== "function") {
    return;
  }

  const unsubscribe = onMenuAction((action) => {
    if (action === "open-settings") {
      void navigate({ to: "/settings" });
    }
  });

  return () => {
    unsubscribe?.();
  };
}, [navigate]);
```

Replace with:

```tsx
const openSettings = useSettingsDialogStore((s) => s.openSettings);

useEffect(() => {
  const onMenuAction = window.desktopBridge?.onMenuAction;
  if (typeof onMenuAction !== "function") {
    return;
  }

  const unsubscribe = onMenuAction((action) => {
    if (action === "open-settings") {
      openSettings();
    }
  });

  return () => {
    unsubscribe?.();
  };
}, [openSettings]);
```

Also remove the now-unused `useNavigate` import line at the top of the file:

```ts
import { useNavigate } from "@tanstack/react-router";
```

- [ ] **Step 3: Mount `<SettingsDialog />` inside the provider**

Inside the `return` of `AppSidebarLayout`, add `<SettingsDialog />` as the last child of `<SidebarProvider>` (after `{children}`):

```tsx
return (
  <SidebarProvider className="h-dvh! min-h-0!" defaultOpen>
    <Sidebar
      side="left"
      collapsible="offcanvas"
      className="border-r border-border bg-card text-foreground"
      resizable={{
        minWidth: THREAD_SIDEBAR_MIN_WIDTH,
        shouldAcceptWidth: ({ nextWidth, wrapper }) =>
          wrapper.clientWidth - nextWidth >= THREAD_MAIN_CONTENT_MIN_WIDTH,
        storageKey: THREAD_SIDEBAR_WIDTH_STORAGE_KEY,
      }}
    >
      <ThreadSidebar />
      <SidebarRail />
    </Sidebar>
    {children}
    <SettingsDialog />
  </SidebarProvider>
);
```

- [ ] **Step 4: Run typecheck**

```bash
bun run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/AppSidebarLayout.tsx
git commit -m "feat(web): mount SettingsDialog and migrate Electron menu"
```

At this point, opening settings via the Electron menu (or any other entry once migrated) will display the popup, but the existing route-based settings still works as a fallback for the un-migrated entry points.

---

### Task 4: Migrate sidebar Settings button and remove SettingsSidebarNav usage

**Files:**

- Modify: `apps/web/src/components/Sidebar.tsx`

- [ ] **Step 1: Add the store import**

Near the top of `apps/web/src/components/Sidebar.tsx`, add:

```ts
import { useSettingsDialogStore } from "../settingsDialogStore";
```

- [ ] **Step 2: Repoint `SidebarChromeFooter`'s Settings button**

Find the `SidebarChromeFooter` definition (currently around line 2442–2469). Replace its body:

```tsx
const SidebarChromeFooter = memo(function SidebarChromeFooter() {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const handleSettingsClick = useCallback(() => {
    if (isMobile) {
      setOpenMobile(false);
    }
    void navigate({ to: "/settings" });
  }, [isMobile, navigate, setOpenMobile]);

  return (
    <SidebarFooter className="p-2">
      <SidebarUpdatePill />
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton
            size="sm"
            className="gap-2 px-2 py-1.5 text-muted-foreground/70 hover:bg-accent hover:text-foreground"
            onClick={handleSettingsClick}
          >
            <SettingsIcon className="size-3.5" />
            <span className="text-xs">Settings</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarFooter>
  );
});
```

with:

```tsx
const SidebarChromeFooter = memo(function SidebarChromeFooter() {
  const { isMobile, setOpenMobile } = useSidebar();
  const openSettings = useSettingsDialogStore((s) => s.openSettings);
  const handleSettingsClick = useCallback(() => {
    if (isMobile) {
      setOpenMobile(false);
    }
    openSettings();
  }, [isMobile, openSettings, setOpenMobile]);

  return (
    <SidebarFooter className="p-2">
      <SidebarUpdatePill />
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton
            size="sm"
            className="gap-2 px-2 py-1.5 text-muted-foreground/70 hover:bg-accent hover:text-foreground"
            onClick={handleSettingsClick}
          >
            <SettingsIcon className="size-3.5" />
            <span className="text-xs">Settings</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarFooter>
  );
});
```

- [ ] **Step 3: Remove the `isOnSettings` branch from the parent component**

Find the JSX block (currently around line 3360–3408) that renders `<SettingsSidebarNav />` conditionally. The current shape is:

```tsx
    <>
      <SidebarChromeHeader isElectron={isElectron} />

      {isOnSettings ? (
        <SettingsSidebarNav pathname={pathname} />
      ) : (
        <>
          <SidebarProjectsContent ... />

          <SidebarSeparator />
          <SidebarChromeFooter />
        </>
      )}
    </>
```

Replace with:

```tsx
    <>
      <SidebarChromeHeader isElectron={isElectron} />

      <SidebarProjectsContent ... />

      <SidebarSeparator />
      <SidebarChromeFooter />
    </>
```

(Keep all the existing props on `<SidebarProjectsContent />` — the only change is removing the conditional wrapper.)

- [ ] **Step 4: Remove the `pathname` and `isOnSettings` derivations**

Inside the parent component (the default-exported `Sidebar`), find and delete these two lines (currently around 2738–2739):

```tsx
const pathname = useLocation({ select: (loc) => loc.pathname });
const isOnSettings = pathname.startsWith("/settings");
```

If `useLocation` has no other usage in this file (verify with a search), also remove it from the import line near the top of the file. Currently:

```ts
import { Link, useLocation, useNavigate, useParams, useRouter } from "@tanstack/react-router";
```

becomes:

```ts
import { Link, useNavigate, useParams, useRouter } from "@tanstack/react-router";
```

Run a quick search to confirm before removing:

```bash
grep -n "useLocation" apps/web/src/components/Sidebar.tsx
```

Expected: only the import line. If anything else uses it, leave the import alone.

- [ ] **Step 5: Remove the `SettingsSidebarNav` import**

Find and delete the line:

```ts
import { SettingsSidebarNav } from "./settings/SettingsSidebarNav";
```

- [ ] **Step 6: Run typecheck**

```bash
bun run typecheck
```

Expected: PASS. If TypeScript flags an unused `pathname` or `isOnSettings`, double-check Step 4 was applied to the same component scope.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/Sidebar.tsx
git commit -m "feat(web): repoint sidebar Settings button to dialog and drop settings-route branch"
```

---

### Task 5: Migrate CommandPalette call sites

**Files:**

- Modify: `apps/web/src/components/CommandPalette.tsx`

- [ ] **Step 1: Add the store import**

Near the top of `apps/web/src/components/CommandPalette.tsx`, add:

```ts
import { useSettingsDialogStore } from "../settingsDialogStore";
```

- [ ] **Step 2: Replace the source-control settings handler**

Find (around line 785–788):

```tsx
const openSourceControlSettings = useCallback(() => {
  setOpen(false);
  void navigate({ to: "/settings/source-control" });
}, [navigate, setOpen]);
```

Replace with:

```tsx
const openSettings = useSettingsDialogStore((s) => s.openSettings);
const openSourceControlSettings = useCallback(() => {
  setOpen(false);
  openSettings("source-control");
}, [openSettings, setOpen]);
```

(`openSettings` is then reused by Step 3, so declare it once near `openSourceControlSettings`.)

- [ ] **Step 3: Replace the root "Open settings" action**

Find (around line 1058–1067):

```tsx
actionItems.push({
  kind: "action",
  value: "action:settings",
  searchTerms: ["settings", "preferences", "configuration", "keybindings"],
  title: "Open settings",
  icon: <SettingsIcon className={ITEM_ICON_CLASS} />,
  run: async () => {
    await navigate({ to: "/settings" });
  },
});
```

Replace with:

```tsx
actionItems.push({
  kind: "action",
  value: "action:settings",
  searchTerms: ["settings", "preferences", "configuration", "keybindings"],
  title: "Open settings",
  icon: <SettingsIcon className={ITEM_ICON_CLASS} />,
  run: () => {
    setOpen(false);
    openSettings();
  },
});
```

Note the change from `async`/`await navigate(...)` to a synchronous handler — `openSettings()` is synchronous and there is no async work to await. Closing the palette before opening settings keeps the focus order consistent with the source-control variant.

- [ ] **Step 4: If `navigate` becomes unused, drop it**

Search the file for remaining `navigate(` calls:

```bash
grep -n "navigate(" apps/web/src/components/CommandPalette.tsx
```

If there are any other usages, leave the `useNavigate` declaration and import alone. (Manual check expected: CommandPalette navigates to threads as well, so `navigate` is almost certainly still in use. Do not assume.)

- [ ] **Step 5: Run typecheck**

```bash
bun run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/CommandPalette.tsx
git commit -m "feat(web): migrate command palette to settings dialog store"
```

---

### Task 6: Migrate ChatView Connections button

**Files:**

- Modify: `apps/web/src/components/ChatView.tsx`

- [ ] **Step 1: Add the store import**

Near the top of `apps/web/src/components/ChatView.tsx`, add:

```ts
import { useSettingsDialogStore } from "../settingsDialogStore";
```

- [ ] **Step 2: Use the store in the Connections button**

Find the button (currently around line 1230–1236):

```tsx
<Button size="xs" variant="outline" onClick={() => void navigate({ to: "/settings/connections" })}>
  Connections
</Button>
```

Add a hook call near where other hooks are declared in the same component (look for `const navigate = useNavigate();`):

```tsx
const openSettings = useSettingsDialogStore((s) => s.openSettings);
```

Then update the button:

```tsx
<Button size="xs" variant="outline" onClick={() => openSettings("connections")}>
  Connections
</Button>
```

- [ ] **Step 3: Run typecheck**

```bash
bun run typecheck
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/ChatView.tsx
git commit -m "feat(web): migrate ChatView Connections button to settings dialog"
```

---

### Task 7: Migrate GitActionsControl

**Files:**

- Modify: `apps/web/src/components/GitActionsControl.tsx`

- [ ] **Step 1: Add the store import**

```ts
import { useSettingsDialogStore } from "../settingsDialogStore";
```

- [ ] **Step 2: Replace the source-control settings handler**

Find (around line 520–523):

```tsx
const openSourceControlSettings = useCallback(() => {
  handleOpenChange(false);
  void navigate({ to: "/settings/source-control" });
}, [handleOpenChange, navigate]);
```

Replace with:

```tsx
const openSettings = useSettingsDialogStore((s) => s.openSettings);
const openSourceControlSettings = useCallback(() => {
  handleOpenChange(false);
  openSettings("source-control");
}, [handleOpenChange, openSettings]);
```

- [ ] **Step 3: If `navigate` becomes unused, drop it**

```bash
grep -n "navigate(" apps/web/src/components/GitActionsControl.tsx
```

If no other usages remain, remove the `const navigate = useNavigate();` line and the `useNavigate` import. Otherwise leave them.

- [ ] **Step 4: Run typecheck**

```bash
bun run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/GitActionsControl.tsx
git commit -m "feat(web): migrate GitActionsControl source-control button to settings dialog"
```

---

### Task 8: Migrate `_chat.index.tsx` Connections link

**Files:**

- Modify: `apps/web/src/routes/_chat.index.tsx`

- [ ] **Step 1: Add the store import**

```ts
import { useSettingsDialogStore } from "../settingsDialogStore";
```

- [ ] **Step 2: Replace the anchor with a button handler**

Find (around line 50–60):

```tsx
<div className="mt-6 flex justify-center">
  <Button render={<a href="/settings/connections" />} size="sm">
    <PlusIcon className="size-4" />
    Add environment
  </Button>
</div>
```

Replace with:

```tsx
<div className="mt-6 flex justify-center">
  <Button size="sm" onClick={() => openSettings("connections")}>
    <PlusIcon className="size-4" />
    Add environment
  </Button>
</div>
```

Then add the hook call inside the component (look for the function body, near the top of the function that owns this JSX):

```tsx
const openSettings = useSettingsDialogStore((s) => s.openSettings);
```

- [ ] **Step 3: Run typecheck**

```bash
bun run typecheck
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/routes/_chat.index.tsx
git commit -m "feat(web): replace settings/connections anchor with dialog button"
```

---

### Task 9: Delete settings routes and `SettingsSidebarNav.tsx`, regenerate route tree

**Files:**

- Delete: seven settings route files + `SettingsSidebarNav.tsx`
- Modify (auto): `apps/web/src/routeTree.gen.ts`

- [ ] **Step 1: Confirm nothing imports the route files or the nav component**

```bash
grep -rn "from.*routes/settings" apps/web/src --include="*.ts" --include="*.tsx"
grep -rn "SettingsSidebarNav" apps/web/src --include="*.ts" --include="*.tsx"
```

Expected: only `apps/web/src/routeTree.gen.ts` matches the first command (it'll be regenerated). The second should produce no matches at all (Sidebar's import was removed in Task 4).

If anything else still imports them, return to the corresponding migration task and finish it.

- [ ] **Step 2: Delete the route files**

```bash
rm apps/web/src/routes/settings.tsx
rm apps/web/src/routes/settings.general.tsx
rm apps/web/src/routes/settings.providers.tsx
rm apps/web/src/routes/settings.appearance.tsx
rm apps/web/src/routes/settings.source-control.tsx
rm apps/web/src/routes/settings.connections.tsx
rm apps/web/src/routes/settings.archived.tsx
```

- [ ] **Step 3: Delete `SettingsSidebarNav.tsx`**

```bash
rm apps/web/src/components/settings/SettingsSidebarNav.tsx
```

- [ ] **Step 4: Regenerate the route tree**

The TanStack Router Vite plugin regenerates `routeTree.gen.ts` on file changes during `vite dev` and on `vite build`. The fastest deterministic option is a one-shot build of the web app:

```bash
cd apps/web && bun run build
```

This is slow (~30–60s). For a quicker option, run `bun run dev` in a separate terminal, wait until the dev server logs `routeTree.gen.ts` regeneration (a few seconds after settings files are deleted), then `git diff apps/web/src/routeTree.gen.ts` to confirm the settings entries are gone, then stop the dev server.

After regeneration, verify the file:

```bash
grep -n "settings" apps/web/src/routeTree.gen.ts
```

Expected: no matches.

- [ ] **Step 5: Run typecheck**

```bash
bun run typecheck
```

Expected: PASS. If anything still references the deleted routes or component, fix and re-run.

- [ ] **Step 6: Commit**

```bash
git add -A apps/web/src/routes apps/web/src/routeTree.gen.ts apps/web/src/components/settings/SettingsSidebarNav.tsx
git commit -m "feat(web): delete settings routes and SettingsSidebarNav"
```

(Use `git add -A` on these specific paths so the deletions are staged.)

---

### Task 10: Manual verification

This step has no commit. It's a smoke test before declaring the work done.

- [ ] **Step 1: Start the dev server**

```bash
cd apps/web && bun run dev
```

- [ ] **Step 2: Walk through every entry point**

Open the app in the browser. For each entry point, confirm the popup opens at the expected starting section, sections switch correctly, and Restore Defaults appears only on `general` / `providers` / `appearance`:

1. Sidebar bottom-left **Settings** button → opens at last-viewed section (`general` first time).
2. Command Palette → search "settings" → "Open settings" → opens at last-viewed.
3. Command Palette → search "source control" → "Open Source Control settings" → opens at `source-control`.
4. ChatView empty state → click **Connections** → opens at `connections`.
5. GitActionsControl menu → "Open Source Control settings" → opens at `source-control`.
6. `_chat.index.tsx` empty state (no environments) → click **Add environment** → opens at `connections`.
7. Electron app menu → **Open Settings** (only verifiable in the desktop app build, optional for web-only smoke).

- [ ] **Step 3: Confirm closing behavior**

For each: Escape key, backdrop click, X button. All three should close the popup, and the underlying page should be unchanged.

- [ ] **Step 4: Confirm nested dialogs work**

Open settings → Providers → click **Add provider** (or whichever button opens `AddProviderInstanceDialog`). The nested dialog should appear above the settings popup with the expected scale/translate effect (driven by the `--nested-dialogs` CSS var). Both close cleanly.

- [ ] **Step 5: Confirm `<sm>` viewport behavior**

Resize the browser to ~500px wide. The rail should collapse to icon-only (no labels). The popup remains centered (no bottom-sheet treatment).

- [ ] **Step 6: Confirm Restore Defaults works**

In `general`: change a setting, then click **Restore defaults**. The panel should reset (the `restoreSignal` remount mechanism kicks in inside the dialog).

- [ ] **Step 7: Confirm the old URLs no longer route**

Navigate the browser address bar to `/settings/providers` and reload. The app should land on the not-found / fallback page (acceptable per the spec). This is the "we dropped URLs" trade-off.

If any of the above fails, fix and re-run typecheck before declaring done.

---

## Self-Review Notes

- **Spec coverage:** every line item in the spec maps to a task here:
  - Store → Task 1.
  - Dialog component → Task 2.
  - Mounting → Task 3.
  - All seven call-site migrations → Tasks 3–8.
  - Sidebar settings-route cleanup → Task 4.
  - Route deletion + nav-component deletion → Task 9.
- **No placeholders:** every code change has the actual code; every command has the actual command.
- **Type consistency:** `SettingsSectionId` is defined once (Task 1) and reused everywhere; `useSettingsDialogStore` is the only export of the store and is used identically across Tasks 3–8.
- **No new tests required:** the spec explicitly excludes them ("the dialog is a thin shell over existing, already-tested panel components"). Verification is typecheck + manual smoke (Task 10).
