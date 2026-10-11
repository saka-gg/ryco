# Building "C · Dialog" into apps/web — binding build spec

The user (2026-10-06): **"i would prefer C exactly like it is"**. So the real app gets the
lab's direction C — one Automations dialog, no new page — with the **type** date picker, plus
the interval / until pickers and the next-runs preview it uses. Fidelity to the lab is the
goal: same structure, wording, states, keyboard model and motion. Where the lab is a
simulation and the app has real data, map faithfully (below). Never add features C doesn't
have; never drop states C shows.

**Source of truth** (read before writing a line):

- `.docs/automations-lab/dir-c.js` + `dir-c.css` — the dialog (2.6k lines; read all of it).
- `.docs/automations-lab/pickers.js` + `pickers.css` — `dateTime({variant:"type"})` (and the
  calendar popover its calendar button opens), `interval`, `until`, `preview`, `parseWhen`,
  `fmt.rel`, `endFor`.
- `.docs/automations-lab/core.js` — `sched.*`, `fmt.*`, `Lab.q.*` (row states, merging
  proposals), `RUN_STATUS`, `LIMITS`, `morph`.
- `.docs/automations-lab/BRIEF.md` — product truth (schedules, approvals, proposals).
- Visual reference: run `python3 .docs/automations-lab/serve.py 5803` (may already be running)
  and open `http://127.0.0.1:5803/#C`, or `node .docs/automations-lab/shoot.mjs C <out.png>
  "paused=1"` (+ `SHOOT_STEPS`). Screenshots: `.docs/automations-lab/shots/final/C-*.png`.

Repo rules: AGENTS.md (Bun, `bun run test` never `bun test`, React Compiler lint rules,
Effect contracts schema-only, `@ryco/shared` subpath exports, `client-runtime` has no DOM).
Typecheck: `bun typecheck` (strip ANSI before grepping). Web unit tests use vitest's 5 s
timeout. Browser tests: `bun run --cwd apps/web test:browser <path>`; scratch screenshots via a
throwaway `*.browser.tsx` calling `page.screenshot({ path: "./__scratch-shots__/x.png" })`
(delete afterwards; `/tmp` paths are refused by vite fs).

## Mapping the lab onto real data

| lab                                                          | app                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| project (logical, several devices)                           | a `SidebarProjectSnapshot` (`useLogicalProjectSnapshots()`), its `memberProjects` = checkouts, one per environment (device). Device name/icon: `useEnvironmentPresence(environmentId)` (`label`, `isPrimary`) + `DeviceIcon`.                                                                                                                                                                                                                                                                                                                                           |
| `S.automations/runs/proposals`                               | per checkout: `useAutomationCentre(environmentId, projectId)` → `AutomationCentreSnapshot` (`automations`, `runs: AutomationCentreRun[]`, `proposals` = **active** proposals only), `providers`, `command(save/cancel/retry/read)`, `decide(proposalId, accept/reject)`, `busy`, `error`, `disabledReason`. Several checkouts → one source component per member (pattern: `components/projects/map/useProjectMapCheckouts.tsx`).                                                                                                                                        |
| run waiting for approval + 15-min expiry                     | a run with `status: "pending-approval"` and `proposalId`; its expiry is that active proposal's `expiresAt` (plan kind `automationRun`). Approve/Reject = `decide(run.proposalId, …)`.                                                                                                                                                                                                                                                                                                                                                                                   |
| schedule proposals (create / edit / pause / resume / cancel) | active proposals with plan kind `createAutomation` / `updateAutomation` (pause = only `enabled` false→ true flipped; resume = true; else edit) / `cancelAutomation`. Approve/Reject = `decide`. (`projects/map/projectMapModel.ts#pendingScheduleChanges` does a first version of this; replace it with the shared model.)                                                                                                                                                                                                                                              |
| lapsed proposal ("Proposal expired · Propose again")         | the snapshot drops expired proposals, but the global Agent Control queue (`useAgentControlStore`, `@ryco/client-runtime/state/agentControl`, fed by `startAgentControlProposalSync` per environment) keeps `recent` proposals with `status: "expired"`. Lapsed = newest schedule proposal for that automation is `expired` and no newer proposal exists; "Dismiss"/"Remove" is a session-local dismissed set. The dialog must make sure a proposal sync runs for every environment it shows (several syncs may coexist; see `agent-control/AgentControlApprovals.tsx`). |
| `act.save(def, {id, expectedRevision})`                      | `command({kind:"save", projectId, automationId, expectedRevision, definition})` — new ids: `AgentControlAutomationId.make(crypto.randomUUID())`.                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `act.pause/resume`                                           | `save` with `enabled` flipped (and the start rolled forward like the lab's `sched.draftOf`, since the server rejects a past start).                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `act.cancel`                                                 | `command({kind:"cancel", projectId, automationId, expectedRevision})`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `act.retryRun`                                               | `command({kind:"retry", projectId, runId})`; retry rules mirror `apps/server/src/agentControl/Layers/AutomationCentre.ts` (`command` → retry) — only rejected/expired/cancelled, original proposal rejected/expired with no affected threads, schedule not cancelled and revision unchanged; the lab's "Retry opens once the waiting run is decided." too.                                                                                                                                                                                                              |
| `act.markRead`                                               | `command({kind:"read", projectId, runId, expectedUpdatedAt: run.updatedAt, unread})`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| thread title of a dispatched run                             | the store's thread (by environment + thread id); "Open thread" closes the dialog and navigates to `/$environmentId/$threadId` (`buildThreadRouteParams(scopeThreadRef(...))`).                                                                                                                                                                                                                                                                                                                                                                                          |
| `S.providers` / model + effort                               | the centre's `providers` (`ServerProvider[]`). Reuse the app's real model picker `components/chat/ProviderModelPicker.tsx` (see a non-composer call site such as `components/settings/ProjectPreferenceSettings.tsx`) inside the editor's "Model" pick, with its tuning/effort UI if it can be driven from a plain `ModelSelection`; otherwise port the lab's model popover + effort dial. Model unavailable → the lab's "Edit model" warning.                                                                                                                          |
| `RUNTIME_MODES` labels                                       | the app's vocabulary `components/chat/sessionPolicyPresentation.ts#runtimeModeConfig` (label + description) — one vocabulary app-wide.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| refs for "off [main]"                                        | the project's branches via the existing ref search used by `components/pullRequests/create/BranchPicker.tsx` (typed filtering); default `HEAD`'s branch / `main`.                                                                                                                                                                                                                                                                                                                                                                                                       |
| `LIMITS`                                                     | `@ryco/contracts`: `AGENT_CONTROL_AUTOMATION_MIN_INTERVAL_MS`, `…_MAX_HORIZON_MS`, `…_MAX_ACTIVE_PER_PROJECT` (per **checkout**: environment + projectId), `…_PROMPT_MAX_CHARS`, `AGENT_CONTROL_TITLE_MAX_CHARS`, `…_PROPOSAL_TTL_MS`, `…_RUN_HISTORY_MAX`.                                                                                                                                                                                                                                                                                                             |
| run status words                                             | the lab's: Preparing · Waiting for approval · Approved · Starting · Dispatched · Failed · Rejected · Expired · Cancelled. Update `automationRunStatusLabel` (client-runtime) to these and fix its users/tests — one vocabulary app-wide.                                                                                                                                                                                                                                                                                                                                |
| `S.now` ticking                                              | `visibleSecondTicker` (`apps/web/src/lib/perf/ticker.ts`); never re-render focused elements per tick (the lab patches text in place; in React keep keys stable and only text changes).                                                                                                                                                                                                                                                                                                                                                                                  |
| `morph.open` dialog grow/fold                                | `DialogPopup` already grows out of the control that opened it (`morph="auto"`, `components/ui/surfaceMorph.ts`). For programmatic opens pass an explicit origin. In-dialog plates (`flight`: new → header, save → row) port as a small WAAPI ghost helper. Motion durations honour reduced motion (`readMotionDurationMs`, `prefers-reduced-motion`).                                                                                                                                                                                                                   |
| `popover()` token popovers                                   | Base UI `Popover` / `Menu` (`components/ui/popover.tsx`, `menu.tsx`) with morph; placement: under the whole sentence at the token's x, inside the dialog (the lab's `desiredSpot`).                                                                                                                                                                                                                                                                                                                                                                                     |
| `plate(seg)` sliding segment                                 | `components/ui/useActiveIndicator.ts` / `sliding-tabs.tsx` patterns.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `Lab.layers` Escape order                                    | Base UI layering: popover → editor (dirty-draft confirm in the footer) → dialog.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `api.notify`                                                 | `toastManager.add(...)`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `?full=` 25 limit                                            | `activeScheduleCount(checkout) >= AGENT_CONTROL_AUTOMATION_MAX_ACTIVE_PER_PROJECT`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

## Architecture and file ownership

Phase 1 (parallel)

- **model** owns
  - `packages/shared/src/automationSchedule.ts` (+ `.test.ts`) — pure, TZ-correct local-time
    math and words ported from `core.js` `sched.*` / `fmt.*` and the lab's `pickers.js`:
    units; `occurrences/next/first/last/count/rollForward/dstShift/clockChange`;
    `validateScheduleDefinition(def, nowMs, {activeCount?, editingId?})` mirroring the
    server exactly plus the lab's draft errors (`start | end | interval | title | prompt |
    model | limit`, same wording as the lab); words: `everyWords`, `endWords`, `cadence`,
    `phrase`, `when`, `rel`, `countdown`, `time/day/date/dateTime`; `UNTIL_PRESETS`,
    `endFor(start, preset)`; `ceilQuarter`.
  - `packages/shared/src/automationWhenParser.ts` (+ `.test.ts`) — the lab's `parseWhen`
    with all 56 lab cases as tests (fixed `nowMs`, `process.env.TZ = "Europe/Berlin"` set at
    the top of the test file) and its suggestions.
  - subpath exports in `packages/shared/package.json` (`./automationSchedule`,
    `./automationWhenParser`).
  - `packages/client-runtime/src/state/agentControl/automationSchedules.ts` (+ test), exported
    from that domain's `index.ts`: `deriveScheduleRows({ snapshot, queueProposals,
    dismissedLapsed, nowMs })` → rows exactly like `Lab.q.schedules` + dir-c `rowsFor`
    (`state: "awaiting-approval" | "running" | "paused" | "finished" | "pending-create" |
    "lapsed" | "scheduled"`, `proposal {kind, id, before, after, expiresAt}`, `lapsed`,
    `dueRun {run, proposalId, expiresAt, coalescedOccurrences}`, `activeRun`, `lastRun`,
    `nextRunAt`, `def`, `title`), sorted like the lab; `pendingScheduleProposals`,
    `lapsedScheduleProposals`, `scheduleRetryState(run, rows)` (ok / short / long reason),
    `diffScheduleDefinitions(before, after)` (the lab's `diffRows`), `activeScheduleCount`,
    drafts (`draftFromDefinition`, `definitionFromDraft`, `blankScheduleDraft`,
    `draftOfLatest(automation|proposal, nowMs)` rolling the start forward), and the run-status
    presentation (`AUTOMATION_RUN_STATUS {label, tone, active}`; `automationRunStatusLabel`
    derived from it).
- **data** owns `apps/web/src/components/automations/data/*` and
  `apps/web/src/components/automations/automationsDialogStore.ts`:
  - `useProjectAutomations(snapshot)` → per member checkout `{ member, environmentId,
    projectId, deviceLabel, isPrimary, presence, snapshot, providers, error, busy,
    disabledReason, command, decide, refresh }` (source-component pattern; stable identities;
    holds the desktop interactive scope for non-primary devices like the map does).
  - `useAutomationProposalSync(environmentIds)` (extracted from `AgentControlApprovals.tsx`,
    which then uses it) and `useLapsedScheduleProposals(...)` (queue store + dismissed set).
  - `automationsDialogStore`: `openAutomationsDialog({ projectKey | {environmentId, projectId},
    automationId?, mode?: "view" | "edit" | "new", environmentId? (device for new), origin?:
    HTMLElement | null })`, `closeAutomationsDialog()`, remembers the last project.
  - `useAutomationProjectCounts(snapshots)` for the switcher's counts: fetch each project's
    snapshot once when asked (not a live subscription), cache, expose `{schedules, waiting}`.

Phase 2 (parallel, after phase 1)

- **pickers** owns `apps/web/src/components/automations/pickers/*` and
  `apps/web/src/components/automations/styles/pickers.css`: `WhenField` (the lab's `type`
  variant: input, live parse chip with crossfade, 3–5 suggestions with ↑/↓/↵, inline
  past/out-of-range explanations with one-click fixes, a calendar button opening
  `CalendarGrid` with the 15-minute time column and quick picks), `CalendarGrid` (WAI-ARIA
  date grid), `IntervalPicker`, `UntilPicker`, `RunPreview` — same props the lab passes
  (`value/min/max/now/onChange/onCommit` …). Browser tests for keyboard + parsing paths.
- **dialog** owns `apps/web/src/components/automations/dialog/*` (except the editor files
  below) and `apps/web/src/components/automations/styles/dialog.css`: the host
  `AutomationsDialog` (mounted once; reads the store), header (title / project switcher menu
  with counts / limit cap / queue line / timezone / New / close), list (device groups, rows
  patched in place, keyboard ↑↓ Home End E N), detail (sentence, model line, warnings,
  blocks: proposal diff, lapsed, due run with drain line, active run; When; Prompt clamp;
  run history with roving tab stop, U unread, Show all), empty state, undo bar, motion
  (pane cross-fade, settle), and an `EditorSlot` seam the editor plugs into.

Phase 3

- **editor + integration** owns `apps/web/src/components/automations/dialog/editor/*` and the
  wiring: the sentence editor (title-as-header, Repeats | Once, sentence tokens, token
  popovers placed under the sentence, model + permissions picks, prompt + counter, inline
  messages with fixes, footer hint / dirty-draft confirm / ⌘↵ save, flights new→header and
  save→row with the row ring), then the entry points and cleanup:
  - mount the host in `components/RootAppShell.tsx`;
  - sidebar: an "Automations" entry in `components/sidebar/SidebarPrimaryActions.tsx` with
    the waiting badge (runs waiting across connected environments), opening the dialog for
    the last-used project;
  - command palette: "Automations…" for the current project;
  - project map (`components/projects/map/ProjectMapInspector.tsx`): device card "New
    schedule" → dialog new for that device; automation card "Edit" → dialog editor for that
    schedule; project card gets the lab's "N schedules · M waiting ›" entry;
  - projects settings `sections/ProjectAutomationsSection.tsx` and the legacy
    `sidebar/ProjectSettingsDialog.tsx`: replace the embedded centre with a one-line summary
    - "Open automations" (morphs the dialog);
  - delete `AutomationEditor.tsx`, `AutomationCentreView.tsx`, `AutomationCentre.tsx`
    (+ `.browser.tsx`) once nothing uses them; switch `projectMapModel` to the shared model;
  - browser tests for the dialog (open, select, approve run, approve change, new → save →
    pending row, validation fixes, dirty-draft Escape, lapsed proposal, empty project,
    limit) using `components/projects/testing/automationFixtures.ts`-style mocks.

## Non-negotiables

- Looks like the lab's C in the app's tokens (DM Sans, flat solid surfaces, one hairline,
  no card-in-card, every fact once). Check side by side with the lab shots.
- Honest copy: "Save for approval", "Nothing runs until you approve it.", "Dispatched" never
  means done, proposals are "proposed", runs are "waiting for approval".
- Only backend-supported options: once | fixed interval ≥ 15 min ending ≤ now + 90 days.
- Keyboard complete; Escape topmost-first; focus returns; no focus loss on ticks.
- Reduced motion keeps every state change visible.
- No `any` escapes, no lint disables, no duplicated schedule math in the web app.
