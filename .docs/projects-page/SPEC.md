# Projects page: spec

## v5: an interactive map, Delete workspace, and the review dialog (2026-10-05)

The user reported that **Remove checkout** stayed disabled for agent-control worktrees. The blockers were uncommitted changes and unmerged commits. They were fine deleting everything such a workspace holds. They also asked for two things:

- Menu actions should open a small dialog instead of jumping to the map.
- Every entity on the map should be actionable in its card, with the project's settings right in the project card.

**Delete workspace** is `remove-checkout` with `discard: true`. It lives in the contract, the server lifecycle service and client-runtime's `workspaceActionRequest`.

- The checkout is removed with `git worktree remove --force`, so changed, untracked and ignored files are lost.
- The branch is deleted by default. This also works when it is unmerged, and only while the branch still points at the reviewed commit.
- Conversations move to **Trash**, where they can be restored; they are not archived. Removing the checkout archives the record.
- It also finishes a workspace whose checkout was already removed.
- Some things still block it: active work, a foreign or unregistered directory, a stale Git registration, and an inspection that fails.
- Revalidation compares the full status, so a new file written after the review cancels the delete.
- The summary carries `discardBlockers`, and menus always list **Delete workspace…**.
- A blocked removal review offers "Delete workspace instead…".
- When work would be lost, Confirm needs an explicit acknowledgement of that exact preview fingerprint.
- Agent Control never discards: its plans don't set `discard`.

**Review dialog.** Menus (sidebar worktree menu, Inbox Workspace submenu, toast Retry) open `WorkspaceReviewDialog`, which the app shell mounts once and `openWorkspaceReviewDialog` drives. It hosts the same `WorkspaceReview`. "Manage workspaces…" still navigates to the map.

**Interactive cards.**

- **Project card** (408px wide):
  - The image and name are edited in place (`ProjectImage` and `ProjectNameField` compact, built on `InlineNameField`).
  - It has New thread and Pull requests buttons.
  - It shows the real settings sections from `PROJECT_SECTION_COMPONENTS` (Location, Repository, New threads, Actions, Instructions, Jira & Bitbucket, Danger zone) for one checkout, with a device switch.
  - `SettingsRow` and these sections now lay out by container width (`@container/settings-row` and `@container/detail`), not by viewport.
- **Device card:** New worktree, New schedule (an inline `AutomationEditor`), Settings (opens the project card for that checkout), Open in editor, copy the path, and pending "New schedule" approvals.
- **Automation card:** Pause/Resume, inline Edit and Cancel schedule. Each becomes a proposal, and pending changes are approved or rejected in place (`pendingScheduleChanges`). It also offers approval of a due run and Open last run.
- **Thread card:** the title is edited in place (`renameThread` in `threadMutations.ts`). It has Open plus the shared lifecycle actions (interrupt or stop, archive or unarchive, Move to Trash).
- **Workspace card:** the lifecycle actions, now including Delete workspace, reviewed inline.

## v4: the Map view (2026-10-05)

In the workspace-map lab (`.docs/workspace-map-lab/`) the user picked **A · Flow**. They chose to have it as a view in the page bar.

**The switch.** The 52px bar has a **Map / Settings** switch (`?view=map|settings`), and the plate slides between the two.

- With no view or section in the URL the page opens on the map; a `section` opens settings.
- The sidebar's "Project overview" opens the map and "Project settings" opens settings.
- Switching projects or checkouts keeps the current view.

**Map** (`components/projects/map/`) is one canvas for the whole logical project, across every device.

- The project sits on top and every checkout (device) is a column. Workspaces, then that device's automations, hang off the device's trunk, and a workspace's threads fan out from its tally.
- Wires mean "lives in". A slow dash runs along wires that lead to running work. A violet arc links the same branch on two devices, and a teal dotted arc runs from an automation to the threads its runs started.
- Thread status uses the inbox's glyphs (`resolveInboxThreadStatus` → `resolveInboxGlyph`).
- Automation nodes have a countdown ring (`visibleSecondTicker`). A due run shows **Approve run**, decided through the same path as the Automation Centre.

How it is built:

- Data comes from one `CheckoutSource` per member checkout, combining the sidebar tree, the lifecycle inspection and `useAutomationCentre`, the hook extracted from `AutomationCentre`.
- The layout is pure: `projectMap.logic.ts` with fixed node sizes.
- The camera is imperative (`useMapCamera`), so dragging and zooming never re-render React.

**Motion.**

- Nodes are positioned by transform, so moves glide, and wires follow because their `d` transitions.
- Nodes fade in on entry, and removed nodes are kept briefly so they can fade out.
- The inspector slides in, and a new subject settles in.
- There is a full reduced-motion block in `styles/map.css`.

**Interaction.**

- Hovering lights a node's lineage, including an automation and its threads.
- Clicking opens the inspector, and the camera moves the node out from under it.
- You can drag nodes; **Tidy** puts them back.
- The toolbar has chips for each device, plus Threads, Automations and Archived.
- Double-click fits; there are zoom controls and a legend.

**Inspector actions** (all real):

- Open a thread, or start a new one in a live workspace.
- Archive or restore a workspace directly.
- Remove or recreate a checkout through `WorkspaceReview` inside the inspector, which applies the reviewed fingerprint.
- Approve or reject a due automation run; open a device's or automation's settings.
- Menu deep links (`buildWorkspaceLocation`) now open the map with the workspace selected and its review in the inspector.

**Settings → Workspaces** is now a summary (worktree, archived and needs-care counts) with **Open map**. It keeps the approval-only cleanup suggestions ("Review removal" opens the map's inspector), New worktree, and the per-project cleanup timing.

---

## v3: workspaces live on the project page (2026-10-05)

The separate `/workspaces` page and the workspace review dialog are gone. The **Workspaces** section (formerly Worktrees, `section=workspaces`) is the one place to manage a checkout's workspaces.

- **Rows** come from the sidebar's tree (instant, reactive). They are enriched by the server lifecycle inspection (`lifecycle.listWorkspaces`), which is matched by id; the main checkout is matched to the inspected main record. Each fact is stated once in the meta line, quiet unless it needs care: checkout removed/missing/not verifiable, `N modified, N untracked`, ignored non-cache files, unmerged commits, in use. Registered workspaces the tree lacks are still listed.
- **Inspection** runs Git, so it only re-runs when:
  - the checkout's set of workspaces changes (`workspaceInspectionSignature`);
  - any lifecycle action runs (`useWorkspaceLifecycleChanges`);
  - or the reader presses ↻.

  Earlier results stay on screen meanwhile.

- **Row menu**:
  - Open, Open in editor, Copy path.
  - The lifecycle actions the inspection allows (`availableWorkspaceActions`).
  - Archive and Restore run directly, with a toast and a Retry.
  - Recreate checkout, Remove stale record and Remove checkout open a review.
- **Review, inline under the row** (`WorkspaceReview`):
  - The URL is `workspace=<worktreeId>&review=<action>`.
  - It shows the server preview's exact summary, details and blockers ("Nothing will change:"), plus the removal options (archive conversations is on; delete the merged branch is off).
  - Confirm applies that preview's fingerprint, so a workspace that changed in between is refused.
  - A completed run closes the review with a toast. A partial or failed run stays inline with what happened and a Retry that previews again.
  - A review for a workspace the checkout no longer has shows a dismissible note.
- **Entry points**:
  - The Inbox Workspace submenu: checkout changes and "Manage workspaces…".
  - The sidebar worktree menu.
  - Toasts.

  All of them navigate with `buildWorkspaceLocation`. A workspace reached that way scrolls into view, tints once (`projects-row-landed`), and opens the Archived fold if it is archived.

- **Suggestions** (approval-only) show at the top of the card for this project only, excluding pinned threads. "Review removal" opens the inline review.
- **Cleanup suggestions** (owner only) is a fold at the end of the card. It holds the project's override of the device policy, which is the whole policy; "Use device setting" drops it. Settings → Archive keeps only the device default, via the shared `lifecycleSuggestionPolicy.ts`.

---

## v2: one editor, no tabs (2026-10-04, supersedes §4–§8, §10, §11; Worktrees became Workspaces in v3)

v1's tabbed detail (Overview with recent threads, CI, Issues, Jira lists) read as a second project explorer. The pull requests page already lists PRs with their checks, so the projects page is now only the place to **edit** a project. The list pane (§3), URL identity (§1), layout breakpoints (§2) and entry points (§9) are unchanged.

- **URL**: `?env&project&section`. `section` is one of `PROJECT_SECTIONS` (`projectsSearch.ts`). There is no `tab`; old links drop it.
- **Detail** (`detail/`): a 52px bar (list toggle, project title once the hero scrolls away, checkout scope switcher, ⋯ menu), then a single scroll:
  - **Hero** (`ProjectHero`): an image menu (upload, replace, use detected); the name, edited in place (Enter or blur saves, Escape reverts, shown optimistically); path with copy; repository; branch with ahead/behind; New thread, Open in editor (primary device only), Pull requests ↗.
  - One access notice, at most: the read-only reason or the node-owner reason.
  - **Sections**, in `PROJECT_SECTION_GROUPS` order:
    - Project: Devices (checkout rows switch the edited checkout; "Not on …"; sidebar grouping), Location (root, worktree root, submodules), Repository (primary remote radio group, git init), Worktrees (card list, archived disclosure, New worktree).
    - Agents: New threads, Actions, Agent instructions, Automations.
    - Integrations: Jira & Bitbucket, with templates and switches behind a disclosure.
    - Danger zone.
  - New threads and Jira & Bitbucket need the device owner; others never see them (`visibleProjectSections`).
- **Section navigation** (`ProjectSectionNav`): sticky and grouped, shown when the detail is at least 960px wide. One plate (`useActiveIndicator`) travels with the scroll spy (`useProjectSectionSpy`). A click pins its section until the reader scrolls. Anchors are real `#project-section-*` links.
- **Reveal**: deep links land instantly, later URL changes smoothly. Nav clicks and the ⋯ "Remove from …" item scroll, ring the card once (`projects-section-landed`), focus the heading and record `section` with a replace.
- **Motion**:
  - Project change: the detail settles from the direction of travel.
  - Checkout change: the content re-keys with a tone settle; scroll position is kept and drafts are never carried across.
  - Saves that apply immediately get a CSS-only "Saved" tick (`useSavedFlash`/`SavedTick`).
  - Disclosures use `disclosureMotion`; actions and worktrees use FLIP rows; the script dialog morphs from its row.
  - Every keyframe is listed in a reduced-motion block.
- **Files**:
  - `sections/ProjectSection.tsx` is the one section primitive: the settings heading and card plus anchor, saved tick and danger tone.
  - `sections/projectSectionTypes.ts` holds the labels, groups and visibility.
  - `ProjectGeneralSection` and the overview, explore and worktrees directories are gone.
- **Sidebar**: the thread menu is back to a single "Project settings" item. The dialog owner's `openOverview` and `openSettings` both open the page.

---

## v1 spec (historical)

A dedicated `/projects` route. It is a top-level sibling of `/pull-requests` and `/statistics`, and it replaces the sidebar's "Project overview" dialog (`ProjectExplorerDialog`) and "Project settings" dialog (`ProjectSettingsDialog`) on desktop. The frozen web phone tier keeps both dialogs and redirects `/projects` to `/`.

Reference implementations:

- `/pull-requests`: `components/pullRequests/` and `.docs/pr-lab/SPEC.md`. Its shell, bar, settle motion and test-provider pattern are the template.
- The settings page: `components/settings/settingsLayout.tsx` primitives.

Neither t3code nor Synara has a dedicated page that is worth copying. t3code folded its page back into Settings and shows no overview at all; Synara has none. We borrow:

- t3code: name saves on blur/Enter; the Actions (scripts) list; a precise danger zone; "where does this value come from" inheritance.
- Synara: a live running dot; collapsible counts.

## 0. Hard rules (inherited, binding)

- **One 52px bar per region.** The list pane has its own 52px header. The detail has one 52px bar. Nothing else is pinned, apart from the settings TOC, which is `sticky`.
- **No cards and no tints at page level.** Separate with hairlines (`border-border/60`; bars and columns use `/70`) and whitespace. The only sanctioned boxes are `settingsLayout` cards inside the Settings tab (one solid card per group, rows divided by hairlines), code/command blocks, and popovers.
- **One fact, one place.** Each fact is shown once per screen:
  - The device list lives in Overview → Available on.
  - The bar shows only the _scope_ (which checkout you are editing), and only when the project has more than one checkout.
- **Neutral primary.** Use `Button variant="default"` for the one primary action per view. Everything else is `outline` or `ghost`.
- **Typography:**
  - bar title: `text-sm font-semibold tracking-tight`
  - masthead: `text-xl font-semibold tracking-[-0.015em]`
  - section labels: `text-[13px] font-semibold`
  - meta: `text-xs` / `text-[11px] text-muted-foreground`
  - paths and ids: `font-mono text-xs`
  - counts: `tabular-nums`
  - no uppercase eyebrows
- **Radius caps:** `rounded-[min(var(--radius-lg),0.625rem)]` for plates and rows, and `SETTINGS_CARD_RADIUS_CLASS` for cards.
- **Motion:** use `--app-motion-*` tokens only.
  - Every keyframe gets a `prefers-reduced-motion: reduce { animation: none }` block.
  - JS-driven motion checks `readMotionDurationMs(...) > 0`.
  - Banned: first-view stagger, animating `width` or `left`, and ad-hoc `element.animate` beyond the existing shared hooks (`useInboxListMotion`, `useInboxEnterAnimation`).
- **Hosted gating:**
  - The nav entry is gated on `WS_METHODS.projectsList` (viewer).
  - Orchestration writes (`project.meta.update`, `project.avatar.set`, `project.delete`) are gated on `useHostedRpcCapability(ORCHESTRATION_WS_METHODS.dispatchCommand)`.
  - Node settings writes go through a `SettingsTargetProvider` built by `useEnvironmentSettingsTarget(environmentId)` (owner).
  - When something is disabled, show the reason once (a `SettingsNotice` at the top of Settings), not on every control.
- **Phone:** the route redirects phone to `/`. The palette and keybinding handler skip phone. `PhoneHome` keeps the dialogs. Do not extend or delete the phone tier.

## 1. Identity and URL

- A **project** in the list is a logical project: a `SidebarProjectSnapshot` from `useLogicalProjectSnapshots()`. It groups checkouts across devices exactly as the sidebar does.
- A **checkout** is a physical member: a `SidebarProjectGroupMember`, identified by environmentId and projectId.
- The URL names a checkout. All per-checkout tabs (Worktrees, Issues, CI, Jira, Settings) read and write through it.

`/projects` search (`components/projects/projectsSearch.ts`). Defaults are omitted from the URL.

| Param     | Values                                                                                                                                            | Default                           |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `env`     | environment id of the checkout                                                                                                                    | —                                 |
| `project` | project id of the checkout                                                                                                                        | —                                 |
| `tab`     | `overview` \| `worktrees` \| `issues` \| `ci` \| `jira` \| `settings`                                                                             | `overview`                        |
| `section` | settings anchor: `general` \| `repository` \| `location` \| `defaults` \| `actions` \| `instructions` \| `atlassian` \| `automations` \| `danger` | — (only read when `tab=settings`) |

**Resolution.** Uses the shared `resolveProjectCheckout` (moved out of `pullRequestRepositories.logic.ts` into `apps/web/src/projectCheckouts.logic.ts`; the PR page imports it from there).

1. If the URL names a checkout, use it.
2. Otherwise use the last chosen checkout (persisted).
3. Otherwise use the representative checkout of the first project.
4. If the URL names a checkout that is not listed, show **waiting** while its environment syncs, or **unavailable** if it never appears. Never silently substitute another checkout.

Location builder: `apps/web/src/projectsRoute.ts`

- `PROJECTS_ROUTE_PATH = "/projects"`
- `buildProjectsPageLocation(input?: { environmentId, projectId, tab?, section? })` → `{ to, search }`

Every entry point navigates through it.

## 2. Layout

```
┌ list 288 ─────────────────────┬ detail ───────────────────────────────────────────────────┐
│ [⌕ Filter projects   /]  [+]  │ Overview  Worktrees 3  Issues  CI  Jira  Settings   ryco ·[▣ MacBook ▾][⋯]│ 52
│ ◰ ryco                 ● 2h   │───────────────────────────────────────────────────────────│
│   sak0a/ryco      ▣▣          │ ◰  ryco                                                   │
│ ◰ ryco-hub               3d   │    ⎔ sak0a/ryco · main · ~/Code/ryco ⧉                    │
│   sak0a/ryco-hub              │    [New thread] [New worktree] [Pull requests ↗] [⋯]       │
│ ◰ scratch               —     │───────────────────────────────────────┬───────────────────│
│   ~/tmp/scratch               │ Recent threads                        │ Available on      │
│                               │ ● Fix the relay reconnect …   2h      │ ▣ MacBook Pro  ●  │
│                               │ ✓ Add projects page            1d     │   ~/Code/ryco     │
│                               │ Pull requests            View all ↗   │ ▣ Studio       ○  │
│                               │ ◷ #662 Add a dedicated …       3h     │   ~/src/ryco      │
│                               │ Issues · CI · Jira …                  │ Activity          │
│                               │                                       │ Repository        │
└───────────────────────────────┴───────────────────────────────────────┴───────────────────┘
```

All widths below are measured on the page, i.e. the window minus the app sidebar, using a `ResizeObserver` on the page root (`@container/projects`).

| Region        | Rule                                                                                                                                                                                             |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| List          | Docked at 288px when the page is ≥ 900px wide. Below 900px it becomes a left `Sheet` drawer, opened from a ☰ button in the bar. Below 900px with no checkout resolved, the list fills the page. |
| Overview rail | A 264px column when the detail is ≥ 820px wide. Below that it folds under the masthead as plain hairline sections (no box).                                                                      |
| Settings TOC  | A sticky 176px column on the right when the detail is ≥ 960px wide. Otherwise it is hidden, and the sections stay in one scroll.                                                                 |
| Bar           | Below a 640px detail, inactive tabs show their icon only (the PR bar's container-query trick via `[data-slot="tab-icon"]`), and the bar title hides.                                             |

**Chrome:**

- Bar class: `flex shrink-0 items-center gap-2 border-b border-border/70` plus `drag-region h-[52px] wco:h-[env(titlebar-area-height)]` on Electron, or `h-[52px]` on web.
- The bar that owns the top-left corner gets the collapsed-sidebar inset, following `usePullRequestsLeadingInsetClass`: that is the list header when the list is docked, otherwise the detail bar.
- The detail bar owns the top-right corner and adds `wco:pr-[calc(100vw-env(titlebar-area-width)-env(titlebar-area-x)+0.75rem)]`.
- Clickable non-button wrappers in a bar need `[-webkit-app-region:no-drag]`.

## 3. List pane (`components/projects/list/*`)

**Header (52px):**

- A filter field: placeholder "Filter projects", key hint `/`. It matches name, repository `owner/name`, path and device label.
- An icon button "Add project" (`FolderPlusIcon`), which opens the command palette's add-project flow (`useCommandPaletteStore` / the existing add-project entry; reuse it, do not fork it).

**Rows** (`button[data-project-row]`, two lines, ~52px):

```
[favicon 20]  Name                                ● 2h
              owner/repo  (or ~/path tail)     ▣▣
```

- Line 1: `ProjectFavicon` (size-5, `rounded-[min(var(--radius-md),0.375rem)]`), then the display name (`text-[13px] font-medium`, truncate). Trailing on the same line:
  - a live dot (`status-activity-signal`) when any thread in the project is working;
  - otherwise the relative last-activity time (`text-[11px] tabular-nums text-muted-foreground`), or "—" when there are no threads.
- Line 2: the repository `owner/name` when there is a remote, otherwise the path tail with `~` for the home directory (`text-[11px] text-muted-foreground truncate`). Trailing on the same line: device presence, as up to 3 `DeviceIcon`s (size-3) when the project has more than one checkout. Nothing is shown for a single checkout.
- Order follows the sidebar (`useLogicalProjectSnapshots().snapshots`).

**Selection and keyboard:**

- Selection is one plate (`.projects-list-plate`, `bg-accent`) that glides with transform and height (stack/gentle).
- Rows use `useInboxListMotion` (FLIP plus enter for projects added or reordered; the first paint is still).
- Hover highlight comes from the same hook.
- Roving tabindex, ↑/↓ and Home/End within the list.
- `j`/`k` move between projects page-wide (single-key, ignored in editable targets and dialogs).
- A click navigates with push. Keyboard navigation uses replace.

**Empty states:**

- No projects at all: "No projects yet", the description "Add a folder to start threads in it.", and a primary "Add project" button.
- No filter match: "No projects match “q”".

## 4. Detail (`components/projects/detail/*`)

**Bar, left to right:**

1. ☰ (drawer mode only).
2. `SlidingTabs variant="underline"` with these tabs and their icons:
   - Overview (`LayoutGridIcon` or similar)
   - Worktrees (`GitBranchIcon`), with a count of active worktrees
   - Issues (`CircleDotIcon`)
   - CI (`CirclePlayIcon` or `ActivityIcon`)
   - Jira (the Jira icon from `Icons.tsx` if present, otherwise `TicketIcon`)
   - Settings (`Settings2Icon`)

   Visibility:
   - Issues and CI are hidden when the checkout has no remote (`repositoryIdentity` is null).
   - Jira is hidden unless the checkout's environment has a connected Jira connection or the project is already linked.

3. Spacer.
4. Bar title: the favicon (size-4) plus the display name. On Overview it is visible only once the masthead scrolls out (`.projects-bar-title[data-visible]`, opacity plus translateY 6px, pop/ease). On every other tab it is always visible.
5. The scope switcher, shown only when there is more than one checkout. It is a ghost button (`DeviceIcon` plus device label, the label rendered with `RollingText`) opening a menu of checkouts (device label, path, and a ✓ for the current one). Choosing one replaces `env` and `project` and keeps the tab.
6. ⋯ menu:
   - Open remote (when present)
   - Copy path
   - Open in pull requests
   - View usage (`/statistics` filtered to the project)
   - separator
   - Remove from <device>… (destructive; it runs the same flow as the danger zone)

**Body:**

- The body is keyed by the logical project. When the project changes, it remounts with `.projects-detail-settle` (translateY(dir·8px), opacity .4→1, pop/ease, where `--projects-motion-dir` is ±1 from the list order).
- A tab change drifts the incoming panel in with `.projects-tab-enter` (translateX(dir·6px), opacity .4→1). Visited tabs stay mounted with `hidden` plus `inert`, so scroll positions and forms survive.
- A scope change (switching checkout) re-keys the per-checkout panels with `.projects-scope-settle` (opacity .6→1, chip duration).

**Waiting and unavailable** (the URL names an unknown checkout): the empty reader shows "Waiting for <device>…" (with a spinner after 8s held) or "<project> isn't available on <device>". Mirror `RepositoryStatusMessage`.

## 5. Overview tab (`components/projects/overview/*`)

**Masthead** (no box), with a sentinel at the bottom for the bar title:

- A 48px favicon tile (`rounded-xl`, `ProjectFavicon fillContainer`).
- The name (`text-xl`).
- A meta line (`text-xs text-muted-foreground`, items separated by `·`):
  - provider icon + `owner/name`, as a link that opens the remote;
  - the current branch from `useGitStatus` for the scoped checkout (with ahead/behind when non-zero);
  - "Added <date>".
- A path line (`font-mono text-xs`) with a copy button (it turns into a check via `app-icon-swap` for 1.2s).
- Actions:
  - `[New thread]` (default): a new draft in the scoped checkout, same as the sidebar's new-thread action.
  - `[New worktree]` (outline): `NewWorktreeDialog`.
  - `[Pull requests ↗]` (ghost): `buildPullRequestsPageLocation` for the scoped checkout, shown only when there is a remote.

**Main column** (hairline-separated sections, each with a `text-[13px] font-semibold` label and an optional trailing "View all"):

1. **Recent threads** across all checkouts, top 8 by latest activity, excluding archived threads.
   - Each row has a status glyph (the shared sidebar/inbox status presentation), the title, a device label (only when there is more than one checkout) and a relative time.
   - Clicking a row navigates to the thread.
   - Empty: "No threads yet" plus a New thread button.
2. **Pull requests**: the top 5 open (`useSourceControlChangeRequestList({state:"open", limit: 20})` for the scoped checkout).
   - Clicking a row opens `buildPullRequestLocation`. The header has "View all ↗" pointing at the PR page.
   - Hidden when there is no remote.
3. **Issues**: the top 5 open. Clicking switches to the Issues tab with that issue selected. Hidden when there is no remote.
4. **CI**: the latest 5 workflow runs. Clicking switches to the CI tab. Hidden when there is no remote.
5. **Jira**: the top 5 open work items when linked. Clicking switches to the Jira tab.

Loading uses `Skeleton` rows. Errors are one muted line ("Couldn't load pull requests · Retry").

**Rail** (unboxed facts; `*:not-first:border-t *:not-first:border-border/60 *:py-4`):

- **Available on**: one row per checkout.
  - Each row has a `DeviceIcon`, the device label (or "This device" for the primary), a status dot, the path in mono (truncated, with `title`), the thread count and the last activity.
  - Status dot: online is `bg-success`; connecting is pulsing `animate-status-pulse`; offline or cached is hollow, with a "cached" or "offline" label.
  - The scoped checkout gets the accent plate. Clicking a row changes scope.
  - Below the rows, connected environments that lack the project get one muted line: "Not on: Studio, Linux box".
- **Activity**: active threads, settled, archived, worktrees, and last active. Numbers only.
- **Repository**: each remote with provider icon, name and `owner/repo`; the preferred remote is marked "primary". "Manage" jumps to Settings → Repository.
- **Usage**: a link "View usage statistics ↗" to `/statistics` scoped to the environment and project.

## 6. Worktrees tab (`components/projects/worktrees/*`)

This tab covers the scoped checkout.

- Header row: "Worktrees" with a count, plus `[New worktree]` (default), which opens `NewWorktreeDialog`.
- List, using the same data as `SidebarWorktreeList` / `useSidebarTree`:
  - A main checkout row first (branch, path).
  - Then active worktrees. Each row has:
    - the branch (mono, truncate)
    - the title, when set
    - an origin chip (PR #n with state, issue #n, Jira key, manual)
    - the thread count
    - relative created time
    - path on hover via `title`
  - Row actions, on a hover-revealed ghost cluster plus a ⋯ menu:
    - Open (the latest thread, or a new draft in the worktree)
    - New thread here
    - Copy path
    - Archive
    - Delete… (confirm; option to delete the branch)
  - Use `useSidebarWorktreeActions` and do not fork its logic.
- An "Archived (n)" disclosure (token-driven grid rows) with Restore and Delete actions.
- Rows use `useInboxListMotion` (FLIP plus enter), with the `data-settling` strike-through on remove.
- Empty: "No worktrees" plus a one-line explanation and New worktree.

## 7. Issues, CI and Jira tabs (`components/projects/explore/*`)

These reuse `components/projectExplorer/*` unchanged, with list/detail state local to the tab (plus selection seeded from Overview clicks):

- Issues: `IssuesTab`, plus `IssueDetail` on select (Back returns to the list). A linked change request navigates to the PR page.
- CI: `ActionsTab`.
- Jira: `WorkItemsTab`, plus `WorkItemDetail`. A linked change request navigates to the PR page.

The tab body uses the same horizontal gutter as the other tabs (`px-6 @[48rem]/detail:px-8`).

## 8. Settings tab (`components/projects/settings/*`)

The tab is one scroll. Content is `max-w-[46rem]`, with a sticky TOC on the right at ≥ 960. The TOC's travelling plate reuses the settings nav indicator, extracted to a shared hook `useActiveIndicator`; scroll-spy marks the active section.

If writes are not allowed, the top of the tab shows a `SettingsNotice` with the reason. The reason is one of: the hosted capability; the checkout's environment being offline or cached; or viewer role.

Sections (`SettingsSection` + `SettingsCard` + `SettingsRow`), with `id="project-settings-<section>"` and `data-project-section`:

1. **General**
   - Name: `DraftInput`, which commits on blur or Enter via `project.meta.update {title}`. Empty input reverts and shows a warning toast.
   - Project image: preview, Upload and Remove; applies immediately. Upload is disabled in hosted mode, with the reason as the row description.
   - Sidebar grouping: a `SettingsSelect` with inherit / repository / repository_path / separate. This is a client setting `sidebarProjectGroupingOverrides[physicalKey]`, the same logic as `useSidebarProjectGroupingDialog`.
2. **Repository**: each remote has a radio for primary (auto-detect first), provider icon, name, `owner/repo` and an Open button. The preferred remote applies immediately via `project.meta.update {preferredRemoteName}`. When there is no remote: "Not a git repository with a remote", plus "Initialize git" when the checkout is not a repository (`projects.initializeGit`).
3. **Location**
   - Project root: an input with Browse (only on the primary environment with the desktop bridge) and a "Move" button that is enabled when the value changed. Enter submits. Confirm before saving.
   - Worktree root: `WorktreeRootSettings projectId`.
   - Worktree submodules: `WorktreeSubmoduleSettings projectId`.
   - The hard-coded `~/.ryco/worktrees/<id>` line is removed.
4. **New threads** (`defaults`): `ProjectPreferenceSettings projectId` (model and effort, local/worktree, branch prefix, setup script). It is wrapped in the checkout's `SettingsTargetProvider` and gated on `capabilities.projectPreferences`. Footer row: "Device defaults live in Settings → General" with an "Open" button (`openSettings("general", environmentId)`).
5. **Actions** (`actions`): the project scripts.
   - Each row shows the icon tile, name, command (mono, truncated), a "setup" chip when `runOnWorktreeCreate`, the shortcut, and an edit button.
   - "Add action" opens the extracted `ProjectScriptDialog`. That dialog is shared with `ProjectScriptsControl`; it morphs, and folds into the saved row (`[data-project-script-id]`).
   - Persistence goes through the extracted `useProjectScriptMutations(environmentId, project)`, shared with `useChatProjectScripts`.
6. **Agent instructions** (`instructions`): the custom system prompt `Textarea` with a counter (amber at 90%, red at the limit). Save and Revert appear only when it is dirty.
7. **Atlassian**: the moved `ProjectAtlassianSettingsSection`, restyled onto settings primitives, with props `{environmentId, projectId, repositoryIdentity}`. It keeps its own save, unlink and validation unchanged.
8. **Automations**: `AutomationCentre environmentId projectId`.
9. **Danger zone** (`danger`): "Remove from <device>". It explains that threads are deleted with the project, that files on disk are not touched, and the thread count. It runs the shared `useRemoveProject` flow, extracted from `useSidebarProjectActions`, with the same toasts and confirms. After removal it navigates to the next checkout of the project, or to `/projects`.

**Deep link:** `section=` scrolls the section into view on mount or scope change and flashes it with `overview-jump-flash`.

## 9. Entry points

| Surface                                                                                                    | Before                              | After (desktop)                                                                                                                             |
| ---------------------------------------------------------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Sidebar primary actions                                                                                    | New thread · Search · Pull requests | plus **Projects** (`FoldersIcon`, `data-testid="sidebar-projects-link"`, gated `projectsList`), placed directly after Pull requests         |
| Sidebar project header "Project overview" button, kebab "Project overview", right-click "Project overview" | `ProjectExplorerDialog`             | `/projects?env&project` (Overview) for the representative checkout                                                                          |
| Kebab / right-click "Project settings" (per member)                                                        | `ProjectSettingsDialog`             | `/projects?env&project&tab=settings`                                                                                                        |
| Inbox thread menu "Project settings"                                                                       | dialog                              | the page (`tab=settings`); also adds "Project overview"                                                                                     |
| Projects-mode thread menu                                                                                  | (none)                              | "Project overview" plus "Project settings"                                                                                                  |
| Command palette                                                                                            | —                                   | "Open projects page" (`projects.open`, no default key); "Project settings for <current project>"; submenu "Open project…" listing checkouts |
| Settings → General → Project defaults                                                                      | device plus per-project picker      | device defaults only, plus a row "Per-project overrides" → "Open Projects"                                                                  |
| Keybindings                                                                                                | —                                   | `projects.open` in contracts, plus a `projects` category and meta                                                                           |

`SidebarProjectDialogProvider` no longer mounts `ProjectExplorerDialog` or `ProjectSettingsDialog`. Its `openExplorer` and `openSettings` navigate instead, and `openNewWorktree`, `openRename` and `openGrouping` stay. `PhoneHome` keeps mounting both dialogs. `ProjectSettingsDialog` composes the same extracted section components as the page.

## 10. Motion summary

| #   | What               | How                                                                                                         |
| --- | ------------------ | ----------------------------------------------------------------------------------------------------------- |
| 1   | List selection     | `.projects-list-plate` transform + height, stack/gentle; instant when it first appears                      |
| 2   | List reorder / add | `useInboxListMotion` FLIP + enter (first paint still)                                                       |
| 3   | Project change     | detail body remount `.projects-detail-settle` (dir ±1, from 0.4 opacity, pop/ease)                          |
| 4   | Tab change         | `SlidingTabs` underline, plus panel `.projects-tab-enter` drift by direction                                |
| 5   | Scope change       | `RollingText` device label, plus `.projects-scope-settle`                                                   |
| 6   | Bar title          | `.projects-bar-title[data-visible]` when the masthead leaves view (IntersectionObserver)                    |
| 7   | Settings TOC       | travelling plate (shared `useActiveIndicator`); deep-link flash `overview-jump-flash`                       |
| 8   | Dialogs            | `DialogPopup` default `morph="auto"`; the script dialog folds into its row; confirms grow from their button |
| 9   | Live status        | `status-activity-signal` running dot; `animate-status-pulse` connecting device                              |
| 10  | Worktree remove    | `data-settling` strike, then FLIP survivors                                                                 |

## 11. Files and ownership

```
apps/web/src/projectsRoute.ts
apps/web/src/projectCheckouts.logic.ts (+ .test.ts)           shared with the PR page
apps/web/src/routes/projects.tsx
apps/web/src/components/projects/
  ProjectsPage.tsx                 router + data wiring, context value
  ProjectsPageBody.tsx             list / drawer / detail shell
  ProjectsPageContext.tsx          context types + useProjectsPage()
  projectsSearch.ts (+ test)
  projectsModel.logic.ts (+ test)  pure derivations (rows, filter, tabs, presence, motion dir)
  projectsLayoutStore.ts           persisted last checkout + drawer state
  projects.css → styles/{shell,list,overview,settings,worktrees}.css
  list/ProjectListPane.tsx, ProjectListRow.tsx
  detail/ProjectDetail.tsx, ProjectBar.tsx, ProjectScopeMenu.tsx, ProjectDetailStatus.tsx
  overview/*        settings/*        worktrees/*        explore/*
  testing/ProjectsTestProvider.tsx, projectFixtures.ts
```

Shared extractions:

- `useEnvironmentSettingsTarget` (from `SettingsPage`)
- `useActiveIndicator` (from `SettingsPage`)
- `useRemoveProject` (from `useSidebarProjectActions`)
- `useProjectAvatarActions` and `openProjectRemote` (from `useSidebarProjectSettingsDialog`)
- `ProjectScriptDialog` (from `ProjectScriptsControl`)
- `useProjectScriptMutations` (from `useChatProjectScripts`)
- `ProjectAtlassianSettingsSection` (from `ProjectSettingsDialog`)

## 12. As built (deltas from the plan above)

- **A default checkout is pinned into the URL.** With no checkout in the URL, the page resolves one in this order: last chosen, most recent activity, first. It then writes that choice into the URL with replace. This stops re-ranked thread activity from swapping the project under the reader. Only checkouts the user chose become `lastCheckoutKey`.
- **List data has its own context.** `rows` and `filter` live in `ProjectsListContext`, so thread activity re-renders only the list. The selection carries the logical project, the member and its index, but not the list row.
- **One access answer per checkout.** `useProjectEditAccess` combines four checks: the hosted capability, the role on the device (`SettingsTarget.canMutate`), live presence, and owner-only node settings (`canManage`).
  - The Settings tab states the read-only or owner-only reason once.
  - Sections that consist only of owner settings (New threads, Atlassian) are omitted rather than shown disabled.
  - The masthead and Worktrees writes follow the same answer.
- **Remote desktop Hub checkouts are held connected while on screen.** The page uses `retainDesktopWorkspaceInteractiveScope`.
- **Removal plans its destination before the delete.** `nav.planCheckoutRemoval()` resolves the destination first, so the delete's shell event cannot change where the page goes.
- **Focus survives `j`/`k`.** It uses the shared `hooks/usePageFocusHandoff`, which is also used by the pull requests page.
- **No section commit button is a filled primary.** The Settings tab has no always-on filled button. The embedded Automation Centre uses outline.
