# Pull Requests page: final spec (v1)

**Base:** Direction A, kept for its list + reader skeleton, readiness rows, merge verdict with status lines, container-query folds and CSS-only motion.

**Grafted from C:** one 52px bar, an unboxed hairline facts rail, the masthead meta line, full-width Files, and a neutral primary button.

**Grafted from B:** stack spines in the list with a "can land" foot, the merge-through layer picker, and a lockstep push when switching layers.

Where the directions conflicted, the decision is marked **Resolved**.

The route, search parser, contracts, RPCs, hooks and `client-runtime/state/pull-request-review/*` logic already exist in the working tree. This spec covers the UI built on them.

## 0. Hard rules

- **Chrome:** one 52px bar. Inside panes, the only pinned elements are the list's search row (on the same 52px line) and the sticky file headers in the diff.
- **No cards and no tints:** separate with hairlines (`border-border/60`) and whitespace. Bordered boxes are allowed only for threads, composers, code and log blocks, pierre files, and popovers.
- **Rail facts:** on Conversation, facts live in the rail. On the other tabs the rail is absent, and its two essentials (next action and stack position) move into the bar. No fact is ever on screen twice.
- **Agents:** agent hand-offs are ghost buttons or menu items. Their output appears as rows in the rail's Agents section; no banners.
- **Primary button:** `Button variant="default"` (neutral fill), switching to `outline` when the next step belongs to someone else. No green merge button.

## 1. Layout

All rules are container queries (`@container/prs`, `@container/reader`). Widths below are the page minus the app sidebar: 1440 → 1192, 1180 → 932, 920 → 672.

| Region              | Rule                                                                                                                                                              |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| List                | Docked when the page is ≥ 900, resizable 264–440, default 304. Below that it becomes a `ui/sheet` drawer. With no PR selected below 900, the list fills the page. |
| Rail (Conversation) | A 264px column when the reader is ≥ 800. Below that it folds into an untinted **fact band** under the masthead.                                                   |
| Files               | List hidden (`\` opens the drawer) and no rail. The tree is docked at 248 when the reader is ≥ 720, otherwise an overlay.                                         |
| Bar                 | Below a 640 reader: tab counts drop, the title truncates to a minimum of 8rem, and Files tools fold into a "View" menu.                                           |

**Wide (1440), Conversation**

```
┌ list 304 ─────────────────────┬ reader ──────────────────────────────────────────────────────┐
│[ryco▾│⌕ Search or paste a link /][⚲]│ Conversation 11 Files 12 Checks Commits 8 ‹title› Review·1 ✧ ↗ ⋯│52
│ Needs your review 6          ▾│─────────────────────────────────────────┬────────────────────│
│ ◷ Virtualize the PR diff… 18m │ Web: stack layers rail and              │ ✕ Blocked · on you │
│ ✓ (MV) +228 −19 · 10 files    │ merge-through-layer                     │ ✕ Test · web   8/9 │
│ Yours 5                      ▾│ ◷ Open · #703 · sak0a opened Sep 29     │ ✕ Changes · mvogt  │
│┬◷ Web: stack keyboard…     1h │   stack-3-web-rail → stack-2 · +333 −7  │ ! 2 unresolved     │
│││ #704 Mark ready             │ Description (14px/1.6, ≤68ch)           │ ✓ Up to date       │
│┼✕ Web: stack layers rail… ▐7m │ │                                       │[View failing check▾]│
│││ #703 Check failing          │ ⌁ sak0a pushed 2 commits ›         3d   │────────────────────│
│┼◷ Server: read stacks…    25m │ ◎ mvogt requested changes         52m   │ Stack #14 · 3 of 4 │
│┼✓ Contracts: stack…        3h │ │ ┌ path:135 · excerpt · comments ┐     │  #701 can land   › │
│┴ main · #701 can land         │ │ └ Reply…     Ask agent · Resolve ┘     │ Reviewers (MV)✕    │
│ Others 6                     ▾│ [Add a comment…]                        │ Assignees · Labels │
│                               │                                         │ Agents ◌ Fix… 6m   │
└───────────────────────────────┴─────────────────────────────────────────┴────────────────────┘
```

**1180 (page 932, reader 628).** The list stays docked and the rail folds into a band. **920 (page 672).** Same reader, but the list becomes a drawer behind `☰`.

```
│ ☰ Conversation 11 Files 12 Checks Commits 8          Review·1 ✧ ↗ ⋯ │   (☰ only at 920)
│ Web: stack layers rail and merge-through-layer                       │
│ ◷ Open · #703 · sak0a · Sep 29 · stack-3 → stack-2 · +333 −7         │
│ ──────────────────────────────────────────────────────────────────── │
│ ✕ Blocked · on you                            [View failing check ▾] │
│ ✕ Test · web 8/9   ✕ Changes requested   ! 2 unresolved   ✓ Up to date│
│ Stack #14 · 3 of 4 · #701 can land ›   Reviewers (MV)(EM)   Labels ●● │
│ ──────────────────────────────────────────────────────────────────── │
│ Description…                                                         │
```

**Files (wide).** Rail facts move into the bar:

```
│ ☰ Conversation Files 12 Checks Commits  #703 Web: stack…  ≋3/4 All commits▾ ▤▥ ⊟ │ Review·1 [View failing check▾] ✧ ↗ ⋯ │
├ tree 248 ────────────────┬ diff ───────────────────────────────────────────────────────────┤
│ ⌕ Filter files           │ ▾ M apps/web/…/PullRequestStackRail.tsx  ▢1 +80 −0  ☐ Viewed  ⋯ │ sticky
│ 3 of 12 viewed ▔▔▔────── │   ┌ (MV) mvogt · 2h  Draft layers should block…            ┐   │
│   M MergeBox.tsx      ☐  │   └ Reply…                          Ask agent · Resolve    ┘   │
│   A StackRail.tsx ▢1  ☐  │ + gutter → [Suggest] [Comment now] [Start a review ⌘↵]          │
```

## 2. Route and URL state

The page is the `/pull-requests` route, which already exists. Because it is a single path segment, it does not collide with hosted `RESERVED_TOP_SEGMENTS`. On phones it redirects to `/`. Extend `pullRequestsSearch.ts` with these parameters (defaults, marked \*, are omitted from the URL):

| Param                  | Values                                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `env`, `project`       | Repository context. Default: the last one used (localStorage), else the active environment's first representative. |
| `pr`                   | int. Changing it clears every param below `sort`.                                                                  |
| `tab`                  | `conversation`\* · `files` · `checks` · `commits`                                                                  |
| `state`                | `open`\* · `closed` · `merged` · `all`                                                                             |
| `q`                    | Search text, debounced 150ms                                                                                       |
| `only`                 | `review` · `failing` · `mine`                                                                                      |
| `label`                | string[]                                                                                                           |
| `sort`                 | `readiness`\* · `updated`                                                                                          |
| `commit`               | sha. Scopes Files to that commit (`getChangeRequestDiff{commitSha}`).                                              |
| `file`, `line`, `side` | Reveal a diff line                                                                                                 |
| `thread`               | Reveal a thread: in Files if it has a path, otherwise in Conversation                                              |
| `job`                  | Checks: expand the job and show its log tail                                                                       |

**Not in the URL:** popovers, list width and visibility, tree visibility, scroll, disclosures, diff style (reuse DiffPanel's preference) and drafts (`reviewDraftStore`). Layout preferences go in a persisted `usePullRequestsLayoutPrefs`.

**History:** a click, paste or incoming link **pushes**. J/K, `[`/`]`, tabs, filters, `file`/`line`/`thread`/`job` **replace**.

**Paste:** `parsePullRequestReference`. A known project's URL switches `env`/`project` and opens the PR; an unknown repository's URL gets a toast with "Open on GitHub"; `#123` plus Enter opens that number here.

**Entry points:** the existing sidebar link; palette `action:pull-requests` with a per-repository submenu; command `pullRequests.open` (no default key); inbox PR badges and the overview-rail PR link navigate in-app (⌘-click still opens externally); `ProjectExplorerDialog`'s PR tab deep-links here (its detail view is deleted in a follow-up).

## 3. Component tree

Components live in `components/pullRequests/`. ♻ marks reused existing code.

**`PullRequestsPage`** is a `SidebarInset`. It owns the container-query root and also:

- mounts ♻`DiffWorkerPoolProvider`
- resolves the repository via ♻`pullRequestRepositories.logic`
- registers `usePullRequestsShortcuts`

**`PullRequestListPane`** is the docked column or a ♻`ui/sheet` drawer.

- `ListHeader`:
  - `RepositorySwitcher` (♻`ui/combobox`), shown as the leading segment of the search field and only when there is more than one repository.
  - `SearchField`.
  - `FilterMenu` (♻`ui/menu`).
  - `ActiveFilterChips`, shown only when a filter is not at its default.
- `PullRequestInbox` ranks with ♻`rankChangeRequests`, animates with ♻`useInboxListMotion` (FLIP plus the selection plate), and uses `GroupHeader` (♻`DisclosureRegion`).
  - `PullRequestRow`: `ChangeRequestGlyph` (♻`stateBadgeVariants` tones, ♻`InboxStatusGlyph` pop and draw) above `CheckGlyph` (♻`prCheckStatus`).
  - `StackSpine` and `StackFoot`.
- `ListResizeHandle` (`role="separator"`).

**`PullRequestReader`** is keyed by `repoKey:pr`. `ReaderTransition` runs the settle and push motions.

- `PullRequestBar`, which on Electron is a drag region with the ♻ collapsed-sidebar inset. It contains:
  - `ListToggle`.
  - `SlidingTabs`: extracted from ♻`ContextPickerTabs` into `ui/sliding-tabs.tsx` and switched to tokens.
  - `CondensedTitle`.
  - `BarFacts` (`StackChip`, `NextActionButton size="sm"`), shown only when the rail is off-screen.
  - `FilesTools`: `CommitScopeMenu`, `DiffStyleToggle` (♻`ui/toggle-group`), `TreeToggle`.
  - `ReviewButton`, `AskButton`, `OpenExternalButton`.
  - `OverflowMenu`: copy link and branch, check out in a worktree (♻ `PullRequestThreadDialog` flow), edit title, draft or ready, close or reopen, shortcuts.
- `ConversationTab`:
  - `Masthead` (`EditableTitle`, `MetaLine`).
  - `DescriptionBlock` (♻`MarkdownView`).
  - `PullRequestTimeline` (♻`groupChangeRequestTimeline`). Its entries are `CommentEntry` (♻`CommentItem`), `ReviewEntry`, `CommitRunEntry`, `ForcePushEntry`, `MinorEventEntry` and `ReviewThread`, plus `TimelineComposer` (♻`CommentComposer`).
  - `FactsRail` / `FactBand` (same children, two layouts):
    - `MergeSection`: `MergeVerdict`, `MergeStatusLines`, `NextActionButton` (♻`RollingText`).
    - `StackSection`: `StackLayerList`, shared with `StackPopover`.
    - `PeopleSection`: `ReviewersField`, `AssigneesField`, `LabelsField`, each opening a `PickerPopover`. Uses ♻`LabelChip` and ♻`CommentAvatar`; delete `UserAvatar`.
    - `AgentsSection`.
- `FilesTab`:
  - `FileTreePane`: ♻`ChangedFilesTree` with a new `renderTrailing` slot, ♻`usePullRequestFilesViewed`, ♻`useDiffFileNavigation`.
  - `PullRequestDiffStream`: ♻`Virtualizer` + ♻`FileDiff`. Move DiffPanel's unsafe CSS, header and render key into a shared `components/diff/`. Uses ♻`reviewThreadLineAnnotations` and ♻`createChangeRequestDiffFilesLoader` for hunk expansion.
  - `FileHeaderMeta`, `LineComposer`, `SelectionChip`, `OutdatedThreads`.
- `ChecksTab`:
  - `ChecksSummaryLine` (♻`summarizeChangeRequestChecks`).
  - `WorkflowRunList`, `JobRow`, `StepRow`, `JobLog`: ♻`WorkflowRunsSection` refactored without its own header.
  - `StatusContextList`.
- `CommitsTab`: `CommitDayGroup`, `CommitRow`, `ForcePushMarker`.

**Overlays:** `ReviewSubmitPopover`, `MergeThroughPopover`, `StackPopover`, `PickerPopover`, `PullRequestShortcutsDialog`, `EmptyReader`.

**State:**

- `usePullRequestReaderStore` (zustand) keeps visited tabs mounted (`hidden` + `inert`), and stores per-`(pr, tab)` scroll and expanded jobs. This fixes today's state loss on tab switch.
- Drafts live in ♻`reviewDraftStore`.
- Drop `diffLines.ts` and `unifiedDiffSplit.ts` from the PR path.

## 4. Motion

**Easings:** `ease`, `snappy` and `gentle` are the `--app-motion-*` tokens. **Durations:** chip 120, pop 200, stack 260, pane 360. Everything reads these tokens, so reduced motion (which zeroes them) comes for free; JS paths check `readMotionDurationMs() === 0`.

| #   | Trigger                                                                                                | Properties                                                                                                                                                                                                                                                                                                           | Token                              | Reduced          |
| --- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | ---------------- |
| 1   | Selection change                                                                                       | One plate animates `translateY` and `height`                                                                                                                                                                                                                                                                         | stack/gentle (pane/ease during #3) | instant          |
| 2   | **PR settle** (J/K, click)                                                                             | The old reader unmounts in the same frame. The new reader root animates `translateY(8px·dir)`→0 and `opacity .4`→1, never starting at 0, so no frame is blank. Bar, body and rail move as one unit; `dir` follows list order.                                                                                        | pop/ease                           | none             |
| 3   | **Layer push** (`[` `]`, stack or spine row; **Resolved**: B's push, made vertical to match the spine) | The outgoing reader becomes an inert ghost (♻ ChatPanes "stage, then push"). Both readers translate by exactly the body height, clipped; moving up the stack enters from the top. The bar title rolls (♻`RollingText`), and the list and rail plates glide in lockstep. Files falls back to #2, with no diff ghosts. | pane/ease                          | swap             |
| 4   | Tab change                                                                                             | The underline animates `translateX` and `width`. The incoming pane animates `translateX(6px·dir)`→0 and `opacity .4`→1; the old pane hides in the same frame.                                                                                                                                                        | stack/gentle; pop/ease             | instant          |
| 5   | Masthead scrolls out                                                                                   | Bar title animates `opacity` and `translateY(6px)`→0                                                                                                                                                                                                                                                                 | pop/ease                           | instant          |
| 6   | Disclosures (groups, commit runs, jobs, steps, threads, stack, viewed files)                           | `grid-template-rows` 0fr↔1fr plus `opacity`; chevron `rotate`. Port ♻`disclosureMotion` to tokens.                                                                                                                                                                                                                   | stack/gentle; chip/snappy          | instant          |
| 7   | Composer or reply opens                                                                                | grid-rows 0fr→1fr; focus on `transitionend`                                                                                                                                                                                                                                                                          | stack/gentle                       | instant          |
| 8   | `nextAction.kind` changes                                                                              | Label rolls (old out upward, new in from below); `width` animates to the measured width; fill and outline colours transition                                                                                                                                                                                         | stack/ease; stack/gentle; chip     | text swap        |
| 9   | Status lines change                                                                                    | Rows reorder with FLIP; glyph remount pop (`scale .3 rotate −90°`→none), then the check draws                                                                                                                                                                                                                        | pane/snappy; pop/gentle            | static           |
| 10  | Merge lands                                                                                            | Layer glyphs pop to violet bottom-up, staggered `--i·90ms`; the spine recolours; rows leave via the ♻ inbox settle collapse                                                                                                                                                                                          | pane/snappy                        | no stagger       |
| 11  | Viewed toggled                                                                                         | Check `stroke-dashoffset` 1→0, file collapses (#6), progress bar animates `scaleX`                                                                                                                                                                                                                                   | pop/gentle; pane/gentle            | instant          |
| 12  | Drawer opens or closes                                                                                 | Panel animates `translateX(-100%)`→0; scrim animates `opacity`                                                                                                                                                                                                                                                       | pane/ease; pop/ease                | instant          |
| 13  | Docked list hidden or shown (`\`, Files)                                                               | Layout snaps first, then the list ghost slides to `translateX(-100%)` while the reader FLIPs from `+listWidth` to 0. Transforms only.                                                                                                                                                                                | pane/ease                          | instant          |
| 14  | Popover or menu opens                                                                                  | ♻ base-ui `data-starting-style`: `opacity` and `scale .96`                                                                                                                                                                                                                                                           | pop/snappy                         | instant          |
| 15  | Filter or search results change                                                                        | ♻ FLIP; new rows enter with `translateY(-4px)` and `opacity`                                                                                                                                                                                                                                                         | stack/gentle                       | none             |
| 16  | Landing on a `thread`, `line` or log link                                                              | ♻`overview-jump-flash`                                                                                                                                                                                                                                                                                               | 1.6s/ease                          | static ring      |
| 17  | Rerun / pending count changes                                                                          | ♻`inbox-glyph-spin`, then #9 / the number rolls                                                                                                                                                                                                                                                                      | chip/snappy                        | paused / instant |

**Banned:** first-view stagger, donut drawing, hover-peek list, `width`/`left` animation, any frame where old and new text overlap, new ad-hoc `element.animate` calls.

## 5. Keyboard

Shortcuts are page-scoped and ignored inside inputs, dialogs and menus (♻`shouldIgnoreGlobalNavigationShortcut`). Each tooltip shows its key.

| Key       | Action                                                                                                          |
| --------- | --------------------------------------------------------------------------------------------------------------- |
| `J`/`K`   | Move in the visible primary list: PRs, or files when on Files. **Resolved:** this unifies A's and C's meanings. |
| `⇧J`/`⇧K` | Next or previous PR, from any tab                                                                               |
| `[` `]`   | Layer below / above                                                                                             |
| `1`–`4`   | Tabs                                                                                                            |
| `/`       | Search                                                                                                          |
| `\`       | List                                                                                                            |
| `S`       | Stack section or popover                                                                                        |
| `M`       | Next-action menu                                                                                                |
| `R`       | Review popover                                                                                                  |
| `N`/`P`   | Next / previous unresolved thread                                                                               |
| `V`       | Toggle viewed and move to the next file                                                                         |
| `F`       | Tree                                                                                                            |
| `U`       | Unified / split                                                                                                 |
| `C`       | Commit scope                                                                                                    |
| `A`       | Ask agent (about the selection, if any)                                                                         |
| `E`       | Edit title                                                                                                      |
| `O`       | Open on GitHub                                                                                                  |
| `?`       | Shortcuts                                                                                                       |
| `⌘↵`      | Submit                                                                                                          |
| `Esc`     | Close the top layer, then cancel the composer, then clear the selection. It never leaves the page.              |

The resize handle responds to `←` `→` `Home` `End`.

## 6. Feature interactions

### List and triage

- **Groups:** Needs your review, Yours, and Others. Headers are sticky, sentence case, show a count, and can be folded (fold state persists). Rows are ranked by readiness tier, then `updatedAt`.
- **Row line 1:** the glyph column, the title, and the time.
- **Row line 2:** `#n` and the readiness label from `deriveChangeRequestNextAction`, coloured by tone. Rows in "Needs your review" show the author avatar, diffstat and file count instead; never "Your review".
- **Stacks:** one unit, placed in the most urgent group any open layer qualifies for, with the top layer first.
  - `StackSpine` is drawn per row with `data-stack-edge="top|mid|bottom"`, so virtualization stays safe.
  - The foot reads "main · #701 can land", "blocked at #702" or "2 merged".
  - The landable stretch is `success/50`; merged layers are violet. Rows carry no `k/n` chip.
- **Row menu:** Copy link, Open on GitHub, Check out in worktree.
- **Search:** filters locally first. With no local hits and a query of at least 2 characters, it falls back to server search.
- **Polling:** only while a visible PR has running checks.

### Conversation and timeline

- **Masthead:** Conversation tab only (**Resolved**).
  - Title: `text-xl font-semibold`, at most 2 lines.
  - Meta line: state · `#n` (click copies the link) · author, opened date · `head → base` (mono, copyable) · `+a −d`.
- **Description:** has no header. Hovering shows ✎ to edit it inline. Task checkboxes toggle optimistically (♻`activityPatches`).
- **Timeline:** a vertical rail with 14px nodes.
  - Comments: reactions, plus a ⋯ menu (quote, edit or delete, copy link).
  - Reviews: a verdict node, the review body, then its threads as excerpts (`path:line`, a 4-line `diffHunk`, the comments). A review with no body takes one line.
  - Commits: consecutive commits collapse into "pushed n commits ›". Each commit shows its sha, message and check glyph, from one runs query keyed by sha. Clicking a commit scopes Files to it.
  - Force-pushes: "force-pushed a1b2 → c3d4".
  - Minor events: muted 12px lines, merged when within 10 minutes of each other.
- **Truncated timeline (`timelineTruncated`):** the top line reads "Earlier activity on GitHub ↗".
- **Composer:** at the end, with "Comment and close".

### Review threads and the pending review

- **`ReviewThread`** is the same component in the timeline and in the diff.
  - Actions: "Reply…" expands (#7), Resolve/Unresolve (optimistic), and a ghost "Ask agent".
  - Resolved threads collapse to one line. Outdated threads are grouped at the end of the file.
- **Suggestions:** shown as a small diff, with Copy and "Apply with agent".
- **Starting a comment:** gutter `+` (drag to cover a range), or select lines to get `SelectionChip`.
- **`LineComposer`:** Suggest (prefills a ` ```suggestion ` block), "Comment now" (a single-comment review), and the primary "Start a review" / "Add to review" (⌘↵).
  - Drafts go to ♻`reviewDraftStore` and show inline as "Pending".
  - Commenting is disabled while a commit scope is active.
- **`ReviewSubmitPopover`** (bar Review button or `R`):
  - A summary field, then Comment, Approve or Request changes. On your own PR, the last two are disabled with the reason shown.
  - Lists pending comments with jump links, notes any host `pendingReview` comments, and offers Remove on drafts made outdated by a new head.
  - Discard (with confirm) or Submit (♻`buildSubmitReviewInput`). After submitting, drafts clear, activity refetches, and the next action morphs (#8).

### Diff viewer

- **Rendering:** one pierre `Virtualizer`, highlighted in the worker pool. Files are ordered by ♻`orderChangeRequestFiles`; generated files start collapsed.
- **Sticky file header:** chevron, status, path (middle-truncated, filename always visible), thread count, `+/−`, Viewed, and ⋯ (copy path, view at head ↗).
- **Viewed:** stored on the host. An amber dot marks files that changed since you viewed them. Marking a file viewed collapses it.
- **Tree:** compacted directories, status letters, thread badges and checkboxes. It has a scroll-spy plate, a filter field, and "3 of 12 viewed" with a 1px progress line.
- **Hunk expansion:** turned off when file contents are truncated.
- **Oversized diffs:** "Diff too large to show", with an "Open on GitHub" link.
- **Deep links:** scroll the Virtualizer to the target line, then flash it (#16).

### Checks

- **Summary line:** "1 failing · 8 passed · 1 running · 4 required", plus a ghost "Re-run failed". It counts the rollup plus Actions runs, so the totals match the list below.
- **Order:** attention, running, completed, then skipped. Each entry nests workflow → job (Required tag, duration) → step → log.
- **Failing jobs:** auto-expand, with the failing step's log open at its tail (last 200 lines, plus "Show full log"). A `path:line` in the log is a link into Files.
- **Job menu:** Re-run job and Open on GitHub. Failing jobs also show a hover-only "Fix with agent".
- **Non-Actions statuses:** shown as links only.

### Merge box and next action

The verdict reads as glyph · verdict · a muted "on you" or "on @x". Under it are up to four status lines, each a button with a hover ghost "Fix" or "Update":

- **Checks:** `n/m` and the worst job. Clicking opens Checks with that `job`.
- **Reviews:** the decision and who.
- **Conversations:** the unresolved count. Clicking goes to the next thread.
- **Branch:** up to date, behind, conflicts, or draft.

| `kind`             | Verdict              | Button                                | Does                                         | Style    |
| ------------------ | -------------------- | ------------------------------------- | -------------------------------------------- | -------- |
| resolve-conflicts  | Conflicts            | Check out to resolve                  | worktree checkout (menu: Resolve with agent) | filled\* |
| update-branch      | Behind base          | Update branch                         | merge (menu: rebase)                         | filled\* |
| mark-ready         | Draft                | Mark ready for review                 | `set-draft false`                            | filled\* |
| fix-checks         | Checks failing       | View failing check                    | Checks, on the failing job                   | filled   |
| checks-running     | Waiting on checks    | Merge when ready                      | enable auto-merge                            | outline  |
| changes-requested  | Changes requested    | View requested changes / Review again | jump to the thread / Files                   | by role  |
| awaiting-review    | Waiting on @a / you  | Start review / Request review         | Files / reviewer picker                      | by role  |
| auto-merge-pending | Merges when green    | Cancel auto-merge                     | disable it                                   | outline  |
| merge              | Ready to merge       | Squash and merge                      | two-step confirm                             | filled   |
| merge-stack        | Lands 3 layers       | Merge stack (3)                       | `MergeThroughPopover`                        | filled   |
| merged / closed    | Merged by x / Closed | Delete branch / Reopen                | the action                                   | outline  |

\* Outline when `viewerCanAct` is false.

- **Menu (Resolved: it never repeats the button's action):**
  - Merge method as a radio, with reasons on disabled methods.
  - A "Delete branch after merge" checkbox, defaulting to the repository setting.
  - Merge when ready.
  - Update branch (merge or rebase).
  - Merge stack through….
  - Draft ↔ ready.
  - Close, which opens an AlertDialog.
- **Merging:** the first click rolls the label to "Confirm squash and merge" for 4s.
  - It sends `expectedHeadSha`. If the head has moved, a toast reads "New commits were pushed" and the box re-derives.
  - A queued merge shows "Queued to merge".

### Stacks

- **Scope:** GitHub-native stacks only. With `stackMetadataIncomplete`, show "Stack details unavailable" and no merge-through.
- **One place in the reader:** `StackSection` on Conversation; `StackChip` → `StackPopover` on other tabs. **Resolved:** this removes A's three "3/4" mentions.
- **`StackSection` collapsed:** "Stack #14 · 3 of 4 · #701 can land".
- **`StackSection` expanded:** layers top first, down to the base. Each row is glyph · `#n` · title · state word; the current layer gets the plate instead of a word.
  - Clicking a row pushes to that layer (#3).
  - Hovering a landable row reveals a ghost "Merge through". **Resolved:** this replaces A's green pill.
- **`MergeThroughPopover`** (B):
  - "Merge into main", then a layer radio. Picking a layer highlights the spine from the base up to it. Layers that cannot land are disabled with a reason.
  - Method, "Delete merged branches", and "Merge 3 pull requests" with ♻`pullRequestMergeConfirmation` copy.
  - Success runs #10 and invalidates every layer.

### Reviewers, labels and assignees

- **Rows:** avatar, login, state glyph, and a muted CODEOWNERS tag.
- **Picker:** ✎ or clicking the label opens `PickerPopover`, a multi-select ♻`ui/combobox`.
  - It includes teams, and shows a re-request icon on people who already reviewed.
  - On close it applies one optimistic `updateChangeRequest {reviewers|labels|assignees, add, remove}`, rolling back with a toast on failure.
- **Empty assignees:** "Assign yourself".
- **Permissions:** read-only without `viewer.canUpdate`.

### Agent hand-offs

- **Entry points:**
  - the ✧ menu (Ask about this PR, Summarize, Review with agent)
  - `SelectionChip`
  - "Ask agent" on threads
  - "Fix with agent" on failing jobs
  - "Fix" on status lines
  - the conflicts menu
  - "Apply with agent" on suggestions
- **Behaviour:** each one creates a thread on the PR's head worktree (♻`gitPreparePullRequestThread`) with the PR context attached, and shows a toast "Started · Open" instead of a modal.
- **Results:** rows in `AgentsSection` (♻`InboxStatusGlyph`), which open the thread.

## 7. Density audit

**Nesting:**

- **Level 0:** the pane.
- **Level 1:** threads, composers, code and log blocks, pierre files, popovers.
- **Level 2:** only a suggestion inside a thread, drawn with a hairline.

There are no cards and no tinted bands.

| Fact                                   | Single home                                                                         | Duplicate removed                          |
| -------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------ |
| Title                                  | Masthead. In the bar only off Conversation, or once the masthead has scrolled away. | B strip-only title, C title on every tab   |
| `#n`, state, author, date, branches, ± | Meta line                                                                           | A's description header, commit count       |
| Verdict and blockers                   | `MergeSection`, or the next-action label off Conversation                           | B red status button and strip dot          |
| Checks, decision, unresolved           | Rail status lines; the Checks summary on its own tab                                | C donut beside the checks list, tab badges |
| Stack position                         | `StackSection` or `StackChip`                                                       | A bar chip, "Here", `3/4` on spine rows    |
| People, labels                         | Rail (the timeline keeps history only)                                              | B uppercase metadata band                  |
| Pending comments                       | Review button badge                                                                 | C floating review bar                      |
| Viewed progress                        | Tree header                                                                         | —                                          |
| Agent work                             | `AgentsSection`                                                                     | banners                                    |

Tab counts show quantities only (comments, files, commits). Checks has no count.

## 8. Non-goals (v1)

- Web phone tier.
- A cross-repository inbox.
- Mutations for providers that don't implement them (those controls are hidden).
- Committing suggestions.
- Stack rebase or creation, and stacks that aren't GitHub-native.
- Compare ranges ("since your last review").
- Creating PRs here.
- Merge-queue management.
- Bypassing branch protection.
- Re-running individual steps, and live log streaming.
- Editing host-side pending comments, and file-level comments.
- Unread state.
- Deployments.

**Validation:**

- Unit tests on the existing `client-runtime` modules.
- Real-pierre browser tests for annotations, the gutter composer and line reveal.
- Browser tests for list keyboard/FLIP, the layer push under reduced motion, and the 900/800/720 folds.
