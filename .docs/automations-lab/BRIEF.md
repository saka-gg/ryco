# Automations lab — binding brief

The user (2026-10-05) on today's automations UI:

> "i feel you still should improve the motion design ui / ux of the automations/schedules...
> either make it also another page or make it at least a nice dialog and also a nice date
> component not the current shit default one"

This lab lets them **pick**: three surface directions (page, time-first page, dialog only) and
three date/time pickers, all interactive, on the same simulated data. Whatever they pick gets
built into `apps/web`. So everything here must be buildable in the real app (React, Base UI,
Tailwind, the app's tokens) and must respect the real product rules below — never show an
option the backend cannot do.

## What exists today (the thing to beat)

`apps/web/src/components/automations/AutomationEditor.tsx` + `AutomationCentreView.tsx`: a
plain stacked form inside a settings section — native `<select>`s for provider/model/mode,
`<input type="datetime-local">` for start and end, a number field "Every (minutes)", a checkbox
"Enable after schedule approval", buttons "Review schedule" / "Discard edit". The list is a
`divide-y` of titles with "Every 60 minutes · Next 10/5/2026, 14:00:00". Runs tab with
Unread/Failed/All filters. Proposal cards stacked under everything. No motion. It is
surfaced in: project settings → Automations section, the project map's automation/device
cards (an inline editor), and the legacy project settings dialog.

## Product truth (do not invent features)

A **schedule** (automation) belongs to one project checkout on one device (environment).
Its definition:

- `execution`: `title` (short), `prompt` (≤ 12,000 chars), model selection (provider
  instance + model + model options such as effort), `runtimeMode` —
  `approval-required` "Require approvals" | `auto-accept-edits` "Accept edits" | `auto` "Auto"
  | `full-access` "Full access"; `envMode` — `worktree` "A new worktree each run" | `local`
  "The main checkout"; optional `baseRef` (branch/ref a worktree starts from).
- `schedule`, exactly one of:
  - `once` — `runAt` (must be in the future);
  - `fixed-interval` — `startsAt` (future), `intervalMs` (**≥ 15 minutes**, elapsed time, so a
    "daily" interval drifts across DST), `endsAt` (**required**, ≥ start, **≤ now + 90 days**).
  - There is **no** cron, no weekdays-only, no "every Monday at 9", no "until I stop it".
    Recurring schedules always end. Do not show those options. (A preset like "Daily" is just
    an interval of 24h starting at the chosen time.)
- `enabled` (paused when false), `cancelled` (terminal), `revision`, `nextRunAt`.
- At most **25 active schedules per project**.

**Approvals are the core loop.** Every occurrence materializes a **run** that waits for the
user's approval ("pending-approval"); an approval request **expires after 15 minutes**.
Missed occurrences while the device was off **coalesce into one approval** (the run carries
`coalescedOccurrences`, e.g. "3 missed runs → 1"). Run statuses: `materializing`,
`pending-approval` ("Waiting for approval"), `approved`, `executing` ("Starting"), `completed`
— shown as **"Dispatched"** (the thread was started; it does NOT mean the agent finished or
succeeded), `failed` (with a short safe failure detail), `rejected`, `expired`, `cancelled`.
A run links to the thread(s) it started. Expired/rejected runs can be **retried with approval**.
Runs can be marked read/unread. History keeps ≤ 50 runs per schedule.

**Changing a schedule is itself a proposal.** Create, edit, pause/resume (a save with
`enabled` flipped) and cancel each create a proposal the user approves (Approve / Reject)
before it takes effect. Show that honestly: after "Save", the change sits as "Waiting for
your approval" until approved — never pretend it applied instantly. (In the real app a human
approving their own change is one click; the lab can approve with one click too.)

Times are local; always say the timezone once (e.g. "Europe/Berlin").

## Who the user is (design rules — from their feedback history)

- Restrained, high-craft, awwwards-quality. Low saturation, high contrast, light and dark.
  Reference they like: t3.codes. **No** purple/aurora gradients, neon, hacker-terminal green,
  glassy blobs, bento/card-grid soup, emoji, "AI ✨" banners.
- **Density rules**: no container-in-container (page → card → card); separation by hairlines
  and whitespace; every fact stated **once** at the right altitude; chrome collapsed into as
  few bars as possible (the app's pages use one 52px bar); content owns the scroll.
- Motion they liked: **"B · Morph"** — dialogs and popovers _grow out of the control that
  opened them_ and fold back into it (or into the item they created); sliding pill/plate
  behind the selected segment; lists that settle in place; precise, quick (180–420ms),
  spring-ish ease `cubic-bezier(.16,1,.3,1)`; nothing bouncy or slow. Full
  `prefers-reduced-motion` fallback (and the lab's Motion toggle).
- Surfaces are flat: solid popover at ~88–100% opacity, one hairline, one soft shadow. No
  frosted glass.
- Type: DM Sans; 13px base in-app, 11–12px meta, mono for paths/branches/times only when it
  helps alignment (tabular-nums for countdowns).
- Real app vocabulary: "Approve run", "Waiting for approval", "Dispatched", "Paused",
  "New schedule", "Edit", "Pause", "Resume", "Cancel schedule", "Open thread".

## Lab architecture (vanilla JS, no build; served by `serve.py`)

Files and **owners** (never edit a file you do not own; ask via notes instead):

| file                                                                    | owner       | what                                                                            |
| ----------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------- |
| `base.css`, `icons.js`, `serve.py`                                      | foundation  | tokens (copied from the map lab), icon set (`ic(name)`), server                 |
| `index.html`, `styles.css`, `app.js`, `data.js`, `core.js`, `shoot.mjs` | foundation  | shell, tabs, sim data + clock, shared engine                                    |
| `pickers.js`, `pickers.css`, `dir-d.js`, `dir-d.css`                    | pickers     | the three date/time pickers + interval/end pickers + run preview; tab D gallery |
| `dir-a.js`, `dir-a.css`                                                 | direction A |                                                                                 |
| `dir-b.js`, `dir-b.css`                                                 | direction B |                                                                                 |
| `dir-c.js`, `dir-c.css`                                                 | direction C |                                                                                 |

Scope all direction CSS under `[data-dir="A"]` etc. Pickers CSS under `.pk-*` classes.

### Direction contract (`dir-*.js`)

```js
DIRS.A = {
  title: "Schedules",
  thesis: "one-line idea",
  notes: [
    ["Why", ["…"]],
    ["Motion", ["…"]],
  ],
  mount(host, api) {
    /* build into host */ return { update(S) {}, destroy() {} };
  },
};
```

`host` is the stage under the lab tabs, laid out like the real app window: the app's left
rail (icons) is drawn by the shell; `host` is the area right of it (≈1280×820 at the default
shot size). Direction A/B draw a full page (its own 52px bar); direction C draws a plausible
app page behind (e.g. a dimmed chat view or the projects map) and the dialog over it.

`update(S)` runs on every state change and every sim tick (1s). Re-render only what changed —
never re-`innerHTML` an element that holds focus or a running animation.

### Shared engine (`core.js`, foundation) — the API builders may rely on

- DOM: `$`, `$$`, `h(tag, cls, html)`, `esc`, `clamp`, `wait(ms)`, `EASE`, `GENTLE`.
- State `S` (see `data.js`): `S.now` (sim ms), `S.projects`, `S.devices`, `S.automations`,
  `S.runs`, `S.proposals`, `S.providers`, `S.tz`; `emit()` notifies listeners; `listeners`.
- Actions (mutate `S`, then `emit()`; each returns what it created): `act.save(def, {id?,
  expectedRevision?})` → proposal; `act.approve(proposalId)` / `act.reject(proposalId)`;
  `act.approveRun(runId)` / `act.rejectRun(runId)`; `act.pause(id)` / `act.resume(id)` →
  proposal; `act.cancel(id)` → proposal; `act.retryRun(runId)`; `act.markRead(runId, read)`.
- Schedule math: `sched.occurrences(schedule, fromMs, toMs, limit)` → ms[];
  `sched.validate(draft, nowMs)` → `{ ok, errors: {start?, end?, interval?, title?, prompt?,
  model?} }` with the exact rules above; `sched.label(schedule)` → "Every 2 h · until Oct 31";
  `sched.relative(ms, nowMs)` → "in 7m" / "in 3h 20m" / "tomorrow 09:00" / "Oct 9, 10:00";
  `fmt.time(ms)`, `fmt.day(ms)`, `fmt.date(ms)`, `fmt.duration(ms)`.
- Motion: `morph.open(popupEl, originEl, {onClosed})` → grows a popup out of an origin
  rect (FLIP via a ghost) and returns `close(targetEl?)` which folds it back into the origin
  or into `targetEl`; `plate(segEl)` → sliding plate behind `[aria-checked=true]`/
  `[aria-selected=true]` children; `settle(el)` → one-shot enter animation; all honour
  `motionOn()` (lab toggle + reduced-motion).
- UI bits: `popover(anchorEl, contentEl, {placement, onClose})` (flat surface, outside-click
  and Escape close, focus return), `toast(text, {action})`, `Tip` (data-tip tooltips),
  `providerMark(instanceId)`, `deviceIcon(id)`, `statusTone(runStatus)`.
- The sim: a clock that ticks 1s (accelerated by `?speed=`), fires occurrences → new
  `pending-approval` runs, expires them after 15 sim-minutes, moves approved runs
  `approved → executing → completed` over a few seconds, occasionally fails one.
  `?paused=1` freezes it (for screenshots), `?t=<minutes>` advances the start.

### Pickers API (`pickers.js`, pickers owner)

```js
Pickers.dateTime(host, { variant: "calendar" | "type" | "segments", value: ms,
  min: ms, max: ms, label, onChange(ms) }) → { set(ms), focus(), destroy() }
Pickers.interval(host, { valueMs, onChange(ms) }) → { … }   // presets + custom, ≥ 15 min
Pickers.until(host, { startMs, valueMs, nowMs, onChange(ms) }) → { … }  // "1 week", "30 days",
                                                                         // "90 days (max)", date
Pickers.preview(host, { schedule, nowMs }) → { update(schedule) }  // next runs + count + horizon
```

- `calendar`: a trigger showing "Tue, Oct 7 · 09:00" that morphs open a popover with a
  month grid (WAI-ARIA date grid keyboard: arrows, PageUp/PageDown month, Home/End week,
  Enter picks, Escape closes; dates outside [min, max] disabled; the 90-day horizon visible),
  a time rail/column (15-min steps, typed time accepted), and quick picks
  ("In 1 hour", "Tonight 21:00", "Tomorrow 09:00", "Monday 09:00").
- `type`: a single text field that understands "in 2h", "tomorrow 9", "fri 17:30", "oct 12
  14:00", "tonight", "next monday 9am" — parsed live into a confirming chip
  ("Fri, Oct 10 · 17:30 · in 4 days") with 3–5 suggestions under it; Enter accepts; invalid
  or past input explains why; a calendar affordance is still one click away.
- `segments`: an inline segmented field `Tue · 07 · Oct · 2026 — 09 : 00` where each segment
  is focusable, ↑/↓ steps it, typing digits fills it, ←/→ moves between segments (react-aria
  DateField style), plus a small calendar button opening a compact grid.

The same picker must work inside a dialog, a sheet and a popover (no viewport assumptions).

## The directions

- **A · Schedules (a page).** A dedicated `/automations` page in the style of the app's Pull
  Requests page: one 52px bar (title, project/device filter, "New schedule"), a list of
  schedules grouped by project (and device when a project lives on several) with a live
  next-run countdown and state (paused / waiting for approval / running), and a detail pane:
  the schedule as one plain sentence ("Runs _Nightly dependency check_ every day at 03:00
  until Oct 31 in a new worktree off main, on Studio"), what's next (upcoming occurrences),
  and its run history (status, when, thread link, retry). Approvals due anywhere surface at
  the top of the list (one quiet strip, not a banner). The editor is a **dialog that morphs
  out of "New schedule" / "Edit"** and, on save, folds into the schedule's row where the
  pending change shows. Uses the `calendar` picker.
- **B · Agenda (a time-first page).** Same route, but organised by **time**: a horizontal
  timeline of the next 7 days (hours on the x-axis, one lane per schedule, grouped by
  device), occurrences as ticks/blocks, a live "now" line, past runs coloured by outcome,
  the due approval pulsing at "now". Zoom day ↔ week. Selecting an occurrence opens a small
  popover (approve / open thread / edit schedule). Editing happens in a right **sheet** whose
  draft is drawn live as a ghost lane on the timeline (change the interval → ticks move).
  Uses the `segments` picker.
- **C · Dialog (no new page).** A single, beautiful **Automations dialog** that opens (morph)
  from wherever automations are reached today (sidebar/projects entry, project map card),
  scoped to the current project with a project switcher. Inside: a compact list + detail
  that swaps to the editor _in place_ (shared-element transition: the row grows into the
  editor header). Creating starts from a sentence-like composer ("Every **2 hours** from
  **tomorrow 09:00** for **1 week**", each bold part a picker). Uses the `type` picker.
- **D · Pickers.** A gallery: the three date/time pickers side by side (same value), plus the
  interval and "until" pickers and the run preview, each with a short caption — so the user
  can pick the date component independently of the surface.

Each direction must demonstrate, with the shared data: a due approval (with its 15-min expiry
countdown), a running run, a failed run with its detail, a paused schedule, a pending
schedule change ("Waiting for your approval"), a coalesced approval ("3 missed runs"), an
empty state (scratch project has none), validation (past start, end beyond 90 days, interval
under 15 minutes — explain inline, never a red wall), and the 25-per-project limit message.

## Quality bar (reviewers will check)

- Looks like Ryco (tokens from `base.css`, DM Sans, flat surfaces, hairlines), not a template.
- Keyboard: everything reachable; visible focus; Escape closes the topmost layer; the date
  grid keyboard pattern works; dialogs trap focus and return it.
- No layout jumps while the sim ticks; countdowns use tabular numbers.
- No console errors (`node shoot.mjs` reports page errors).
- Reduced motion: state changes still visible, just without movement.

## Tooling

- Serve: `python3 .docs/automations-lab/serve.py 5803` → http://127.0.0.1:5803/#A
- Screenshot: `node .docs/automations-lab/shoot.mjs A shots/a.png "paused=1&theme=light"`;
  interaction steps via env `SHOOT_STEPS='[{"click":"[data-new]"},{"wait":600},
  {"type":"tomorrow 9"},{"press":"Enter"}]'`. Read the PNG to check your work. Fix every
  page error it prints.
