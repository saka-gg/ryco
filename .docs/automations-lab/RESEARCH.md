# Automations lab — research brief (for builders A, B, C)

Opinionated. BRIEF.md wins any conflict. Every idea is checked against our limits: **once** | **fixed interval
≥ 15 min, required end ≤ now + 90 d** · every run needs **approval within 15 min** · missed runs **coalesce** ·
schedule changes are **proposals** · times are local, with the timezone said once. **Dates:** sim "now" is Mon
Oct 5, 2026, so Oct 6 = Tue and Oct 7 = **Wed**. BRIEF's "Tue, Oct 7" and "Fri, Oct 10" are wrong for 2026.
Always compute weekdays. Through-line: a schedule is a sentence, the next run is a time, waiting is neutral,
lifecycle ≠ outcome, and keyboard/high-frequency actions never animate.

## 1. Products worth stealing from

- **Apple Shortcuts personal automations** (closest analogue).
  - Default "Run After Confirmation"; "Run Immediately" is opt-in
    (matthewcassinelli.com/automations-run-immediately-shortcuts-notifications). Device-bound, no sync
    (support.apple.com/guide/shortcuts/apd602971e63).
  - _Steal:_ rows read as trigger sentences ("At 7:00 AM, daily"); confirmation is the calm default, not an
    alarm. Name the device once per group header ("on Studio").
- **Linear recurring issues + cycles.**
  - "Make recurring…" sits in the composer's … menu, with one list in team settings
    (linear.app/docs/creating-issues). Cycles pre-generate visible upcoming instances (linear.app/docs/use-cycles).
  - _Steal:_ (C) Once ↔ Repeat is one segmented switch in the same composer. (A/B) Show the finite set: "12 runs ·
    last Wed Oct 14".
- **Things 3 When popover + repeats.**
  - Typed dates ("tues 8am") resolve to a concrete date in the same popover as the grid
    (culturedcode.com/things/support/articles/9780167). Since 3.23, moving a repeat asks "Make Exception" or
    "Update Rule" (culturedcode.com/things/blog/2026/08/repeating-to-dos-refined).
  - _Steal:_ text and grid in one popover. _Constraint:_ we have **no exceptions**. Never offer "only this run",
    and never make a single occurrence draggable in B: a time change edits the rule, which makes it a proposal.
- **Raycast Command Scheduler.**
  - One-time or interval (15 m / 30 m / hourly…), a toggle, logs. A missed run fires within a minute of restart
    (raycast.com/cps/scheduler).
  - _Steal:_ presets start at 15 min, our floor. Say our better missed-run story: "3 missed runs → 1 approval".
  - _Skip:_ "Custom cron".
- **Notion Calendar (Cron) + Fantastical.**
  - Cron: keyboard-first (C creates), a right context panel with times in your zone, and a thin line where a
    creation lands (cron.com/changelog). Fantastical: the preview builds as you type, and dragging it rewrites
    the text (flexibits.com/fantastical/help/adding-events-and-tasks).
  - _Steal:_ (B) the sheet _is_ the context panel, with a hairline "lands at 14:15" marker on the lane. (C)
    Two-way binding: typing updates tokens, picks update the read-back, no "Apply".
- **Zapier Schedule.**
  - Every Hour / Day / Week / Month, then one detail, plus a timezone override
    (help.zapier.com/hc/en-us/articles/8496288648461).
  - _Steal:_ presets first, one detail second. _Skip:_ "weekends?" and day-of-week, which we can't do.
- **Trigger.dev / Inngest.**
  - Trigger.dev returns description + timezone + nextRun + the next 5 runs (trigger.dev/docs/tasks/scheduled).
  - Inngest draws waits gray, with status color only for real execution (inngest.com/docs/platform/monitor/traces).
  - _Steal:_ "Next: Tue 09:00 · in 3h 20m" plus five upcoming runs. Waits are gray.
- **GitHub Actions / Vercel cron: what NOT to do.**
  - Raw cron, UTC only (vercel.com/docs/cron-jobs). Runs are delayed and, under load, **silently dropped with no
    failure signal** (github.com/orgs/community/discussions/207346).
  - _Lesson:_ an expression is never the label, and no occurrence vanishes. Expired and coalesced runs stay in
    history with their reason.
- **GitHub deployment reviews + check runs.**
  - A gated job shows "Waiting", and "Approve and deploy" names the consequence; jobs fail after 30 days
    (docs.github.com/actions/managing-workflow-runs/reviewing-deployments). Checks keep `status` separate from
    `conclusion` (docs.github.com/en/pull-requests/reference/status-checks).
  - _Steal:_ "Approve run" + a line saying what happens ("Starts a thread in a new worktree off main on Studio").
    "Dispatched" ends _our_ lifecycle; the outcome lives in the thread.

## 2. Timeline / agenda craft (B)

- **Geometry.** ≈1040 px of plot after a ≈200 px sticky label column. Week zoom ≈ 6 px/h, so 15-min ticks sit
  1.5 px apart; day zoom ≈ 43 px/h. Density must change the representation, not just shrink.
- **Lanes.**
  - Rows 32 px (week) / 40 px (day). Marks fill ≈55 % of the row; Grafana's 0.9 is too tight
    (grafana.com/docs/grafana/latest/visualizations/panels-visualizations/visualizations/state-timeline/).
  - A device group is an 11 px label on a hairline. The label column shows the title + `sched.label()`;
    "Paused" appears only there.
- **Ticks, not blocks.** An occurrence is an instant (the agent's runtime isn't a schedule fact): a 2×12 px tick,
  hollow and muted in the future, filled by outcome in the past. The only honest block is the 15-min approval
  window.
- **Density.** When spacing drops below 6 px, draw a continuous band with a count ("every 15 min · 96/day"), as
  in Grafana's "merge equal consecutive values". Day zoom splits it back into ticks. Past failures stay discrete.
- **Labels.**
  - Never label ticks. Label the lane, plus one "next 14:00" per lane, hidden when it collides with the now flag.
  - Two-level axis: day names centred in their unit, hour ticks minor on the boundaries
    (ag-grid.com/charts/javascript/axes-time). At day zoom, pin the current day left. "Europe/Berlin" goes once,
    in the axis corner.
- **Now line.**
  - 1 px `--foreground` at ≈70 % with a tabular-nums "14:03" flag. Never red: red means _failed_.
  - Move it by `translateX` per tick with no transition (`?speed` would make a transition lag). The past gets a
    2–3 % wash and lower-contrast marks.
- **End caps.** A terminal cap at `endsAt` ("ends Oct 31"); beyond 7 days, fade with "+N runs after Oct 12". A lane
  never runs to infinity.
- **Awaiting approval.** A neutral block whose fill drains (the geometry _is_ the countdown), with "12m" beside it.
  One 2 s opacity ring at now; under reduced motion it's static.
- **Expired / coalesced.**
  - Expired: the block closes into a hollow ring, and the popover offers "Retry with approval". Never fade it out.
  - Coalesced: one "×3" mark with a faint bracket over the missed times.
- **Pending change.**
  - A ghost sub-lane under the real one, with dashed ticks + "Waiting for your approval". The real lane stays
    solid because it's still the live rule.
  - The sheet's draft uses the same ghost. Ticks transition 160 ms only on discrete picks; held arrows and typed
    digits reposition instantly.
- **Zoom day ↔ week.** Anchor on now or the focused mark. Interpolate px/ms over ≈320 ms `cubic-bezier(.16,1,.3,1)`,
  recomputing x each frame. **Never `scaleX`.** Crossfade axis labels over 120 ms
  (emergentmind.com/topics/semantic-zoom). Keys: `D` / `W`.
- **DST is in our window.** EU clocks go back **Sun Oct 25, 2026**, so a daily (24 h elapsed) 03:00 run lands at
  **02:00** after that. Draw it truthfully, with one note: "Clocks change Oct 25 — runs shift to 02:00 (fixed 24 h
  interval)."

## 3. Shared-element / morph motion

- **Technique.**
  - FLIP: First, Last, Invert, Play. Animate only transform and opacity (aerotwist.com/blog/flip-your-animations).
    The app ghost-FLIPs (`surfaceMorph.ts`), so use core `morph` for every dialog and popover.
  - View transitions (Baseline since Oct 2025) are fine as an enhancement for C's row → header
    (developer.chrome.com/docs/web-platform/view-transitions/same-document). Duplicate names skip the transition;
    dialogs need a close intercept (medienbaecker.com/articles/dialog-view-transitions).
- **House numbers.** Use these; don't invent.
  - Dialog: spring grow (stiffness 300 / damping 31, no visible bounce), fold 340 ms `cubic-bezier(.16,1,.3,1)`;
    content fades in 160 ms from 40 % of travel, rising 6 px, staggered 36 ms. The origin hides; the landing
    pulses.
  - Popover: spring 460/40, fold 240 ms, rise 4 px, stagger 24 ms; the trigger stays visible, with no pulse.
  - Tokens: sheet 200, stack 260, chip 120, pop 200, pane 360 ms.
  - Cross-check: NN/g 100–500 ms, shorter as frequency rises (nngroup.com/articles/animation-duration). Emil:
    routine motion under 300 ms, ease-out, never ease-in (emilkowal.ski/ui/great-animations). Material's
    300–500 ms is too slow for a dev tool.
- **C list ↔ editor.**
  - Only the title, provider mark and state chip travel, becoming the editor header; the rest crossfades.
  - Keep the font-size identical so the title only translates; never scale text. The list recedes (opacity,
    ≤ 8 px, 200 ms). Back reverses into the same row, and focus lands there.
- **Save folds into its result (A, C).** The dialog folds into the row now showing "Waiting for your approval".
  That row pulses and takes focus: focus follows motion.
- **Settle and interrupt.** FLIP neighbours 260 ms on insert; stagger ≤ 6 items (≤ 150 ms). Never on a tick.
  Escape mid-grow reverses from the current frame.
- **When motion hurts.** Keyboard navigation of grid, segments or list. The 1 s tick (text only, tabular-nums,
  zero layout shift). Bursts of run updates (change state, animate nothing).
- **Reduced motion ≠ no motion.** Drop translate, scale and springs; keep opacity crossfades ≤ 120 ms; pulses
  become static.

## 4. Sentence composer (C; A's sentence is read-only)

- **Evidence is weak, so craft decides.**
  - "Mad Libs +25–40 %" (lukew.com/ff/entry.asp?1007) changed many things at once, and later tests went both ways.
  - Roselli found that sentence forms hurt screen-reader, magnifier and cognitive users unless carefully built
    (adrianroselli.com/2021/08/sentence-forms-not-mad-libs.html).
  - So the sentence covers **"when" only** and stays short.
- **Shape.**
  - `Every [2 hours] from [tomorrow 09:00] for [1 week]` or `Once, [tomorrow 09:00]`, led by a Once | Repeat
    switch with a plate.
  - Title, prompt, model, mode and worktree are plain labelled fields below.
- **Tokens.**
  - Each is a `<button aria-haspopup="dialog">` showing its value; it opens its picker as a popover morph.
  - `white-space: nowrap` per token. Wrap only between tokens; ≈56ch max.
- **Names stand alone.** "Repeat interval: every 2 hours", "First run: tomorrow 09:00", "Ends: after 1 week",
  inside `<fieldset><legend>Schedule</legend>`.
- **Keyboard.**
  - Tab between tokens. Enter, Space or ↓ opens.
  - Escape returns focus to the token, whose name now carries the new value.
  - A printable key on a focused token opens the `type` picker pre-filled with it.
- **The end is required.** Offer 1 day · 1 week · 30 days · 90 days (max) · pick a date, never "never". The
  connective switches between "for 1 week" and "until Oct 14".
- **Read-back line, always visible.**
  - "Daily from tomorrow 09:00 for 1 week" → "8 runs · Tue Oct 6 09:00 → Tue Oct 13 09:00 · Europe/Berlin".
  - The count comes from `sched.occurrences` (8 assumes an inclusive end); never compute it by hand.
  - One polite live region announces it, debounced ≈500 ms.
- **Validation.** Mark the token with a dotted warning underline, plus one sentence with a fix:
  - "Starts in the past — earliest is 14:15. [Use 14:15]"
  - "Ends after the 90-day limit (Jan 3). [Use Jan 3]"
  - "Every 10 minutes is under the 15-minute minimum. [Use 15 min]"
  - On submit, focus goes to the first message. Never a red wall. Token hit areas are ≥ 32 px tall, via padding.

## 5. Approval UX without nagging

- **Two queues, one strip.**
  - Runs waiting are time-boxed (15 min); changes waiting have no expiry.
  - One quiet strip at the top of A's list or C's dialog: "2 runs waiting · next expires in 11m · 1 change
    waiting". Each part filters.
  - In B, the now column is the strip. No banners, no modals, no per-run toasts.
- **Counts.**
  - One rail badge, for runs only (Linear-style unread count: linear.app/docs/inbox).
  - Expiry is stated two ways: "Expires 14:27 · 12m". Coarse minutes until under 2 min, then mm:ss. Sort by
    soonest expiry.
- **Name the consequence.**
  - "Approve run" with "Starts a thread · new worktree off main · Studio" under it; "Reject" is secondary.
  - Coalesced: "3 missed runs → approving starts **one** run now."
- **Vocabulary.**
  - Waiting for approval (neutral + deadline) · Starting (a text change, no spinner) · **Dispatched** + "Open
    thread →", never a green check.
  - Couldn't start: <safe detail> · Rejected · Expired · Retry with approval · Cancelled.
- **Honest proposals.**
  - After Save, say "Change proposed", never "Saved".
  - The row shows Current → Proposed for the changed fields only ("Every 1 h → every 2 h"). The current rule
    keeps running and keeps showing its next run.
  - "Pause proposed — still runs at 14:00 unless approved."
- **Read/unread.** An unread dot on runs; `U` toggles it on the focused run. There is no snooze; don't invent one.

## 6. Accessibility essentials (APG and friends)

1. **Date grid.**
   - `role="grid"` with one roving `tabindex="0"` cell.
   - Keys: ←/→ day, ↑/↓ week, Home/End week bounds, PgUp/PgDn month, Shift+PgUp/PgDn year, Enter/Space select.
   - `abbr` on headers, `aria-selected` on the chosen cell only, and the month heading `aria-live="polite"`
     (w3.org/WAI/ARIA/apg/patterns/dialog-modal/examples/datepicker-dialog).
2. **Out-of-range days.** `aria-disabled="true"` but still focusable, so arrows never skip. The name adds
   "unavailable, beyond the 90-day limit". Today gets `aria-current="date"`.
3. **Picker focus.** It opens on the selected day (or today). Every close path returns focus to the trigger,
   which is now named "Change first run, Tue Oct 6, 09:00".
4. **Spinbutton segments.**
   - `aria-valuenow/min/max`, `aria-valuetext` ("October", "9 AM"), and a label ("Hour").
   - ↑/↓ step; PgUp/PgDn big step (minutes: 15); Home/End bounds; digits auto-advance
     (w3.org/WAI/ARIA/apg/patterns/spinbutton).
   - Wrap them in `role="group"` labelled by the field (react-aria.adobe.com/DateField).
5. **Modal dialog.**
   - `role="dialog" aria-modal="true"` + `aria-labelledby`; the background is `inert`; Tab is trapped.
   - Escape closes only the topmost layer. Focus returns to the invoker, or to the row the dialog folded into.
6. **Countdowns.**
   - `role="timer"`, which is silent by default. Visible digits are `aria-hidden`, with an sr-only sentence.
   - Announce only at 5 min, 1 min and expired, via one polite region (WCAG 4.1.3;
     bati-itao.github.io/learning/esdc-self-paced-web-accessibility-course/module11/aria-live.html).
7. **The B timeline is navigable, not a picture.**
   - Lanes are rows: ←/→ moves between marks, ↑/↓ between lanes, Enter opens.
   - A mark is named like "Nightly dependency check, Wed Oct 7 03:00, waiting for approval, expires in 12
     minutes".
8. **Never color alone** (WCAG 1.4.1).
   - Filled = dispatched, × = couldn't start, hollow ring = expired or rejected, dash = cancelled, draining block
     = waiting.
   - Marks and hairline controls need ≥ 3:1 contrast (1.4.11).
9. **Sentence tokens** have standalone names inside a fieldset and legend. Errors name their token, and focus
   moves to the first error on submit.
10. **Focus and targets.** A visible 2 px offset ring in light and dark. Targets ≥ 24 px (WCAG 2.5.8). Every
    state change stays perceivable under reduced motion.

## Do

- Say each fact once: `sched.label()` in rows, the full sentence in detail, the timezone once per view.
- Make "always ends" visible: a finite run count, an end cap, the last-run date.
- Draw waiting as neutral with a draining deadline. Color only what actually happened.
- "Dispatched" + "Open thread →". "Change proposed" after Save, with a Current → Proposed diff.
- Use core `morph` with the house profiles. Fold Save into the changed row and focus that row.
- Presets first: 15 m · 30 m · 1 h · 2 h · 6 h · Daily (= 24 h); custom second. Show the Oct 25 DST shift.
- Put a one-click fix inside every validation message.

## Don't

- Don't offer cron, weekdays, "every Monday", "weekends?", "never ends", snooze or "only this run".
- Don't make single occurrences draggable in B. Time changes go through the sheet, as proposals.
- Don't animate on sim ticks, keyboard stepping or j/k. Don't `scaleX` the timeline or scale text.
- Don't put a green check on Dispatched, red on waiting, or use a red now line.
- Don't use per-run toasts, banners or modals. One strip, one count.
- Don't let expired or coalesced runs vanish. Don't nest a proposal card inside a row card.
- Don't announce countdowns every second. Don't put radios or checkboxes in the sentence.
- Don't go over ≈420 ms, don't bounce, and never use ease-in.
