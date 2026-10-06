/* ============================================================
   Core — the shared engine every direction codes against.
   Loaded after icons.js + data.js, before pickers.js / dir-*.js.

   DOM
     $(sel, root?)  $$(sel, root?) → array   h(tag, cls?, html?) → el
     esc(str)   clamp(v, lo, hi)   wait(ms) → Promise
     EASE "cubic-bezier(.16,1,.3,1)"   GENTLE "cubic-bezier(.22,1,.36,1)"
     DIRS  — directions register DIRS.A = { title, thesis, notes, mount(host, api) }

   State (data.js): S, listeners, emit()   — see the header of data.js for shapes.

   Actions (mutate S, emit(), return what they created/changed; null when refused)
     act.save(def, { id?, expectedRevision?, deviceId?, projectId? }) → proposal
         def: a definition { execution, schedule, enabled } (flat drafts with
         title/prompt/modelSelection/schedule also work). With an existing id it
         proposes an edit (or pause/resume when only `enabled` flipped).
     act.approve(proposalId) → automation   act.reject(proposalId) → proposal
     act.approveRun(runId) → run  (approved → executing ~1.2s → completed ~6s, real time)
     act.rejectRun(runId) → run
     act.pause(id) / act.resume(id) / act.cancel(id) → proposal
     act.retryRun(runId) → new pending run | null   (see Lab.q.canRetry)
     act.markRead(runId, read = true) → run
     act.openThread(threadId) → thread  (lab: toasts "Opened …")

   Schedule math (all ms)
     sched.occurrences(schedule, fromMs?, toMs?, limit = 500) → ms[]
     sched.next(schedule, nowMs?) → first occurrence > now | null
     sched.first(schedule) / sched.last(schedule) → ms
     sched.count(schedule, fromMs?) → n
     sched.horizon(nowMs?) → now + 90 days
     sched.validate(draft, nowMs?, { id? }) → { ok, errors: { start?, end?, interval?,
         title?, prompt?, model?, limit? } }   (plain sentences, safe to show inline)
     sched.label(schedule, nowMs?) → "Every 2 h · until Oct 31" | "Once · today 16:00"
     sched.cadence(schedule, nowMs?) → "Every 2 h" | "Every 24 h from 03:00" |
         "Every 7 days from Fri 16:00" | "Hourly" | "Once"   (intervals are elapsed
         time: never "Daily at" / "Weekly, Fri" — the wall-clock time moves at DST)
     sched.phrase(schedule, nowMs?, { dst? }) → "every 24 hours from 03:00 until Oct 31"
         | "every 7 days from Fri, Oct 9 at 16:00 until Dec 11" (for sentences);
         { dst: true } adds "(02:00 from Oct 25)" when sched.dstShift() finds one —
         only where no separate DST note is shown
     sched.relative(ms, nowMs?) → "in 7m" | "in 3h 20m" | "tomorrow 09:00" | "Oct 9, 10:00"
                                  | "7m ago" | "yesterday 22:40" | "just now"
     sched.rollForward(schedule, nowMs?) → copy whose start is the next future occurrence
     sched.dstShift(schedule, fromMs?) → { at, from: "03:00", to: "02:00" } | null
     sched.blank(projectId, deviceId?) → a fresh draft definition (+ deviceId)
     sched.draftOf(automation | proposal, nowMs?) → editable draft: a copy of its
         definition (+ id, deviceId) whose past start is rolled forward to the next
         occurrence — the backend rejects a start in the past, even on edits.
     sched.clone(def) → deep copy
   Formatting
     fmt.time(ms) "09:00"   fmt.day(ms) "Wed, Oct 7"   fmt.date(ms) "Oct 7"
     fmt.dateTime(ms) "Wed, Oct 7 · 09:00"   fmt.weekday(ms, long?) "Wed"
     fmt.duration(ms) "3h 20m"   fmt.interval(ms) "2 h" | "30 min" | "1 day"
     fmt.countdown(ms, { exact? }) time left: "13m" | "1h 5m", m:ss only under 2 min
         ("1:42") so it never reads as a clock time; { exact: true } → old m:ss
     fmt.clock(ms) "12:04" (strict m:ss)   fmt.expiry(expiresAt) "Expires 10:55 · 13m"
     fmt.tz() "Europe/Berlin"
     fmt.model(modelSelection, { effort? }) "Sonnet 5.5" | "Sonnet 5.5 · High"
     fmt.runtimeMode(id) "Accept edits"   fmt.envMode(id) "A new worktree each run"

   Motion (all honour motionOn(): lab toggle, ?motion=0, prefers-reduced-motion)
     motionOn() → boolean
     morph.open(popupEl, originEl, { profile: "dialog"|"popover", onClosed, scrim,
         surface, hideOrigin }) → close(target?) → Promise
         popupEl must already be in the DOM at its final position. The surface
         grows out of originEl (ghost FLIP, spring), content fades in after it
         lands. close(target) folds into `target` (element, or a function
         returning one — resolved after the content fades, so a row rendered by
         act.save() can be the landing), else back into the origin. onClosed
         runs when the fold lands (remove/hide the popup there); without it the
         popup is removed. `scrim` (sibling or ancestor) fades with it.
         Closing mid-grow reverses from the frame on screen (content that
         had not been revealed stays hidden).
     plate(segEl) → { update(), destroy(), el }  sliding plate behind the child with
         aria-checked/aria-selected="true"; follows attribute changes + resizes.
     settle(el | el[], { delay, y, duration, stagger }) → one-shot rise-in
   UI
     popover(anchorEl, contentEl | html, { placement = "bottom-start" ("bottom"|"top"|
         "right"|"left" + "-start"|"-end"|""), onClose(reason), width, className,
         focus = true, initialFocus, container, gap = 6, role = "dialog",
         label, labelledby (id | element), boundary (element), trap })
         → { el, anchor, close(target?), reposition() }   (calling it again on the
         same anchor toggles it closed and returns null). Escape / outside click
         close it; focus returns to the anchor. Works inside dialogs: it stays
         inside the dialog/sheet it lives in when it fits (else the app window),
         flipping start ↔ end. Named by label/labelledby, else its own heading
         ([data-pop-label], h1–h6), else the anchor's name; the anchor gets
         aria-haspopup. Tab past the last item closes it and moves to what
         follows the anchor, Shift+Tab past the first returns to the anchor
         (trap: true cycles inside instead); focus leaving for the page closes it.
     toast(text, { action: { label, run }, tone: "ok"|"warn"|"err"|"info", duration })
         → { close() }   bottom-centre stack inside the app window.
     Tip — any [data-tip="…"] gets a tooltip.   Tip.hide()
     providerMark(instanceId) → html   deviceIcon(deviceId) → html
     statusTone(runStatus) → "wait"|"fg"|"err"|"zinc"|"faint"  (one hue: red, for
         failed only. Waiting is a neutral hollow ring, Dispatched a neutral
         filled dot — never green. "ok"|"warn"|"info" remain as chip/dot tones.)

   Extras (namespaced to avoid clashing with direction globals): Lab.*
     Lab.q            queries: project(id) device(id) provider(id) model(instanceId, slug)
                      thread(id) automation(id) run(id) proposal(id) projectDevices(pid)
                      runsFor(aid) pendingFor(aid) dueApprovals(pid?) activeRuns(aid?)
                      activeCount(pid) isActive(a) state(a) schedules({ projectId,
                      deviceId, includeCancelled }) → rows, canRetry(run) → { ok, reason },
                      unreadCount(pid?)
                      row: { id, automation|null, proposal|null (pending change),
                             def, title, projectId, deviceId, state, nextRunAt,
                             dueRun, activeRun, lastRun }
     Lab.LIMITS       { minIntervalMs, horizonMs, perProject, promptMax, titleMax,
                        approvalTtlMs, historyMax }
     Lab.RUN_STATUS   { [status]: { label, tone, active } }
     Lab.SCHEDULE_STATE { [state]: label }   Lab.RUNTIME_MODES  Lab.ENV_MODES
     Lab.statusDot(status) → html   Lab.statusLabel(status) → "Dispatched"
     Lab.layers.push({ el, close(reason), anchor?, dismissOnOutside? }) → off()
                      Escape closes the topmost layer only (register your dialogs)
     Lab.trapFocus(container) → release()
     Lab.flip(container, mutate, { selector = "[data-key]", duration }) — FLIP a list
     Lab.onEvent(fn(type, payload)) → off   types: run:new run:expired run:status
                      proposal:new proposal:decided
     Lab.units { MIN, HOUR, DAY, WEEK }
     Lab.tick(realMs = 1000)  Lab.advance(minutes)  Lab.startSim()  Lab.reset()
     Lab.setSpeed(1|60)  Lab.setPlaying(bool)  Lab.setMotion(bool)
   ============================================================ */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const h = (tag, cls, html) => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (html != null) el.innerHTML = html;
  return el;
};
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const EASE = "cubic-bezier(.16,1,.3,1)";
const GENTLE = "cubic-bezier(.22,1,.36,1)";
const DIRS = {};

const {
  Lab,
  motionOn,
  fmt,
  sched,
  act,
  morph,
  plate,
  settle,
  popover,
  toast,
  Tip,
  providerMark,
  deviceIcon,
  statusTone,
} = (() => {
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;
  const WEEK = 7 * DAY;
  const LIMITS = {
    minIntervalMs: 15 * MIN,
    horizonMs: 90 * DAY,
    perProject: 25,
    promptMax: 12_000,
    titleMax: 200,
    approvalTtlMs: 15 * MIN,
    historyMax: 50,
  };
  const EASE_OUT = "cubic-bezier(.23,1,.32,1)";
  const params = new URLSearchParams(location.search);

  /* ======================================================== motion */
  const reduceQuery = matchMedia("(prefers-reduced-motion: reduce)");
  let motion = !reduceQuery.matches && !["0", "off"].includes(params.get("motion"));
  reduceQuery.addEventListener?.("change", (e) => setMotion(!e.matches));
  function motionOn() {
    return motion;
  }
  function setMotion(on) {
    motion = !!on;
    document.documentElement.dataset.motion = motion ? "on" : "off";
  }
  document.documentElement.dataset.motion = motion ? "on" : "off";

  /* ======================================================== events */
  const eventFns = [];
  function onEvent(fn) {
    eventFns.push(fn);
    return () => {
      const i = eventFns.indexOf(fn);
      if (i >= 0) eventFns.splice(i, 1);
    };
  }
  function fire(type, payload) {
    for (const fn of eventFns.slice()) {
      try {
        fn(type, payload);
      } catch (err) {
        setTimeout(() => {
          throw err;
        });
      }
    }
  }

  /* ======================================================== vocab
     One hue on the page, and only for what went wrong. Waiting is neutral
     (the deadline carries the urgency), Dispatched is a neutral filled
     mark (the outcome lives in the thread, never a success colour).
     Tones: "wait" hollow fg ring · "fg" filled neutral · "err" red ·
     "zinc" filled faint · "faint" hollow faint. The glyph differs too
     (filled / hollow / dash), so colour is never the only signal. */
  const RUN_STATUS = {
    materializing: { label: "Preparing", tone: "zinc", active: true },
    "pending-approval": { label: "Waiting for approval", tone: "wait", active: true },
    approved: { label: "Approved", tone: "fg", active: true },
    executing: { label: "Starting", tone: "fg", active: true },
    completed: { label: "Dispatched", tone: "fg", active: false },
    failed: { label: "Failed", tone: "err", active: false },
    rejected: { label: "Rejected", tone: "faint", active: false },
    expired: { label: "Expired", tone: "faint", active: false },
    cancelled: { label: "Cancelled", tone: "faint", active: false },
  };
  const SCHEDULE_STATE = {
    "pending-create": "Waiting for your approval",
    cancelled: "Cancelled",
    "awaiting-approval": "Waiting for approval",
    // A run was approved and its thread is being started — the backend's
    // lifecycle ends at Dispatched, so never claim the agent is "running".
    running: "Starting",
    paused: "Paused",
    finished: "Finished",
    scheduled: "Scheduled",
  };
  const RUNTIME_MODES = [
    {
      id: "approval-required",
      label: "Require approvals",
      hint: "The agent asks before every edit and command.",
    },
    {
      id: "auto-accept-edits",
      label: "Accept edits",
      hint: "File edits apply; commands still ask.",
    },
    { id: "auto", label: "Auto", hint: "Edits and safe commands run without asking." },
    { id: "full-access", label: "Full access", hint: "Everything runs without asking." },
  ];
  const ENV_MODES = [
    { id: "worktree", label: "A new worktree each run", short: "New worktree" },
    { id: "local", label: "The main checkout", short: "Main checkout" },
  ];
  const statusTone = (status) => RUN_STATUS[status]?.tone ?? "zinc";
  const statusLabel = (status) => RUN_STATUS[status]?.label ?? status;
  const statusDot = (status) =>
    `<span class="dot" data-status="${esc(status)}" data-tone="${statusTone(status)}" data-tip="${esc(statusLabel(status))}"></span>`;

  /* ======================================================== fmt */
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const WD_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const pad = (n) => String(n).padStart(2, "0");
  const D = (ms) => new Date(ms);
  const dayIndex = (ms) => {
    const d = D(ms);
    return Math.round(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / DAY);
  };
  const calDays = (ms, nowMs) => dayIndex(ms) - dayIndex(nowMs);

  const fmt = {
    time: (ms) => `${pad(D(ms).getHours())}:${pad(D(ms).getMinutes())}`,
    weekday: (ms, long = false) => (long ? WD_LONG : WD)[D(ms).getDay()],
    day: (ms) => `${WD[D(ms).getDay()]}, ${MON[D(ms).getMonth()]} ${D(ms).getDate()}`,
    date(ms, nowMs = S.now) {
      const d = D(ms);
      const base = `${MON[d.getMonth()]} ${d.getDate()}`;
      return d.getFullYear() === D(nowMs).getFullYear() ? base : `${base}, ${d.getFullYear()}`;
    },
    dateTime: (ms) => `${fmt.day(ms)} · ${fmt.time(ms)}`,
    duration(ms) {
      const a = Math.abs(ms);
      if (a < MIN) return `${Math.max(0, Math.floor(a / 1000))}s`;
      if (a < HOUR) return `${Math.floor(a / MIN)}m`;
      if (a < DAY) {
        const hh = Math.floor(a / HOUR);
        const mm = Math.floor((a % HOUR) / MIN);
        return mm ? `${hh}h ${mm}m` : `${hh}h`;
      }
      const dd = Math.floor(a / DAY);
      const hh = Math.floor((a % DAY) / HOUR);
      return hh ? `${dd}d ${hh}h` : `${dd}d`;
    },
    interval(ms) {
      if (!Number.isFinite(ms) || ms <= 0) return "—";
      if (ms % WEEK === 0) return ms === WEEK ? "1 week" : `${ms / WEEK} weeks`;
      if (ms % DAY === 0) return ms === DAY ? "1 day" : `${ms / DAY} days`;
      const hh = Math.floor(ms / HOUR);
      const mm = Math.round((ms % HOUR) / MIN);
      if (!hh) return `${mm} min`;
      return mm ? `${hh} h ${mm} min` : `${hh} h`;
    },
    /* A time left, never shaped like a clock time: coarse minutes ("13m",
       "1h 5m") until under 2 minutes, then m:ss ("1:42"). { exact: true }
       always gives the old m:ss / h:mm:ss form (fmt.clock). */
    countdown(ms, o = {}) {
      if (o.exact) return fmt.clock(ms);
      const left = Math.max(0, ms);
      if (left < 2 * MIN) return fmt.clock(left);
      if (left < HOUR) return `${Math.ceil(left / MIN)}m`;
      const m = Math.ceil(left / MIN);
      return m % 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m / 60}h`;
    },
    /* Strict m:ss (h:mm:ss over an hour). Only for the last two minutes. */
    clock(ms) {
      const t = Math.max(0, Math.ceil(ms / 1000));
      const hh = Math.floor(t / 3600);
      const mm = Math.floor((t % 3600) / 60);
      const ss = t % 60;
      return hh ? `${hh}:${pad(mm)}:${pad(ss)}` : `${mm}:${pad(ss)}`;
    },
    /* An approval deadline said both ways: "Expires 10:55 · 13m". */
    expiry(expiresAt, nowMs = S.now) {
      const left = expiresAt - nowMs;
      return left <= 0 ? "Expired" : `Expires ${fmt.time(expiresAt)} · ${fmt.countdown(left)}`;
    },
    tz: () => S.tz,
    model(sel, o = {}) {
      if (!sel) return "No model";
      const m = q.model(sel.instanceId, sel.model);
      const name = m?.name ?? sel.model;
      if (!o.effort) return name;
      const effort = sel.options?.find((x) => x.id === "effort")?.value;
      if (!effort) return name;
      return `${name} · ${effort[0].toUpperCase()}${effort.slice(1)}`;
    },
    runtimeMode: (id) => RUNTIME_MODES.find((m) => m.id === id)?.label ?? id,
    envMode: (id) => ENV_MODES.find((m) => m.id === id)?.label ?? id,
  };
  /* "today 16:00" / "tomorrow 09:00" / "yesterday 22:40" / "Oct 12, 09:00" */
  function dayTime(ms, nowMs = S.now, sep = " ") {
    const n = calDays(ms, nowMs);
    const t = fmt.time(ms);
    if (n === 0) return `today${sep}${t}`;
    if (n === 1) return `tomorrow${sep}${t}`;
    if (n === -1) return `yesterday${sep}${t}`;
    return `${fmt.date(ms, nowMs)}, ${t}`;
  }
  /* "today at 16:00" / "tomorrow at 09:00" / "Fri, Oct 9 at 16:00" */
  function anchorAt(ms, nowMs = S.now) {
    const n = calDays(ms, nowMs);
    const t = fmt.time(ms);
    if (n === 0) return `today at ${t}`;
    if (n === 1) return `tomorrow at ${t}`;
    if (n === -1) return `yesterday at ${t}`;
    const d = D(ms);
    const year = d.getFullYear() === D(nowMs).getFullYear() ? "" : `, ${d.getFullYear()}`;
    return `${fmt.day(ms)}${year} at ${t}`;
  }
  /* The slot an interval is anchored on: its first run while that is
     ahead, else the next run (whose wall-clock time is the one that holds
     now, after any DST change), else the first run. */
  function anchorOf(s, nowMs = S.now) {
    if (s.startsAt > nowMs) return s.startsAt;
    return sched.next(s, nowMs) ?? s.startsAt;
  }

  /* ======================================================== queries */
  const ACTIVE_RUN = ["materializing", "approved", "executing"];
  const q = {
    project: (id) => S.projects.find((p) => p.id === id) ?? null,
    device: (id) => S.devices.find((d) => d.id === id) ?? null,
    provider: (id) => S.providers.find((p) => p.instanceId === id) ?? null,
    model: (instanceId, slug) =>
      q.provider(instanceId)?.models.find((m) => m.slug === slug) ?? null,
    thread: (id) => S.threads.find((t) => t.id === id) ?? null,
    automation: (id) => S.automations.find((a) => a.id === id) ?? null,
    run: (id) => S.runs.find((r) => r.id === id) ?? null,
    proposal: (id) => S.proposals.find((p) => p.id === id) ?? null,
    projectDevices(projectId) {
      const p = q.project(projectId);
      return p ? p.checkouts.map((c) => q.device(c.deviceId)).filter(Boolean) : [];
    },
    runsFor: (aid) =>
      S.runs
        .filter((r) => r.automationId === aid)
        .sort((a, b) => b.createdAt - a.createdAt || b.scheduledFor - a.scheduledFor),
    pendingFor: (aid) => S.proposals.find((p) => p.automationId === aid && p.pending) ?? null,
    dueApprovals: (projectId) =>
      S.runs
        .filter((r) => r.status === "pending-approval" && (!projectId || r.projectId === projectId))
        .sort((a, b) => a.expiresAt - b.expiresAt),
    activeRuns: (aid) =>
      S.runs.filter((r) => ACTIVE_RUN.includes(r.status) && (!aid || r.automationId === aid)),
    isActive: (a) => !!a && a.enabled && !a.cancelled && a.nextRunAt != null,
    activeCount: (projectId) =>
      S.automations.filter((a) => a.projectId === projectId && q.isActive(a)).length,
    unreadCount: (projectId) =>
      S.runs.filter((r) => r.unread && (!projectId || r.projectId === projectId)).length,
    state(a) {
      if (!a) return "pending-create";
      if (a.automation !== undefined) a = a.automation; // a row
      if (!a) return "pending-create";
      if (a.cancelled) return "cancelled";
      if (S.runs.some((r) => r.automationId === a.id && r.status === "pending-approval"))
        return "awaiting-approval";
      if (S.runs.some((r) => r.automationId === a.id && ACTIVE_RUN.includes(r.status)))
        return "running";
      if (!a.enabled) return "paused";
      if (a.nextRunAt == null) return "finished";
      return "scheduled";
    },
    schedules(o = {}) {
      const match = (pid, did) =>
        (!o.projectId || pid === o.projectId) && (!o.deviceId || did === o.deviceId);
      const rows = [];
      for (const a of S.automations) {
        if (!match(a.projectId, a.deviceId)) continue;
        if (a.cancelled && !o.includeCancelled) continue;
        const runs = q.runsFor(a.id);
        rows.push({
          id: a.id,
          automation: a,
          proposal: q.pendingFor(a.id),
          def: a.definition,
          title: a.title,
          projectId: a.projectId,
          deviceId: a.deviceId,
          state: q.state(a),
          nextRunAt: a.nextRunAt,
          dueRun: runs.find((r) => r.status === "pending-approval") ?? null,
          activeRun: runs.find((r) => ACTIVE_RUN.includes(r.status)) ?? null,
          lastRun: runs.find((r) => !RUN_STATUS[r.status]?.active) ?? null,
        });
      }
      for (const p of S.proposals) {
        if (!p.pending || p.kind !== "create" || !match(p.projectId, p.deviceId)) continue;
        if (S.automations.some((a) => a.id === p.automationId)) continue;
        rows.push({
          id: p.automationId,
          automation: null,
          proposal: p,
          def: p.after,
          title: p.title,
          projectId: p.projectId,
          deviceId: p.deviceId,
          state: "pending-create",
          nextRunAt: sched.first(p.after.schedule),
          dueRun: null,
          activeRun: null,
          lastRun: null,
        });
      }
      return rows;
    },
    canRetry(run) {
      if (!run) return { ok: false, reason: "This run is no longer available." };
      if (run.status === "failed")
        return {
          ok: false,
          reason:
            "Delivery is uncertain for a failed dispatch. Open its thread or check the device before scheduling new work.",
        };
      if (!["rejected", "expired", "cancelled"].includes(run.status))
        return { ok: false, reason: "Only rejected, expired or cancelled runs can be retried." };
      if (S.runs.some((r) => r.retryOfRunId === run.id))
        return { ok: false, reason: "This run was already retried." };
      const a = q.automation(run.automationId);
      if (!a || a.cancelled) return { ok: false, reason: "The schedule was cancelled." };
      if (a.revision !== run.automationRevision)
        return {
          ok: false,
          reason: "The schedule changed since this run. Review it before running again.",
        };
      if (S.runs.some((r) => r.automationId === a.id && RUN_STATUS[r.status]?.active))
        return { ok: false, reason: "Another run of this schedule is already waiting or running." };
      return { ok: true, reason: null };
    },
  };

  /* ======================================================== schedule math */
  const plainSchedule = (s) =>
    !s
      ? null
      : s.kind === "once"
        ? { kind: "once", runAt: +s.runAt }
        : {
            kind: "fixed-interval",
            startsAt: +s.startsAt,
            intervalMs: +s.intervalMs,
            endsAt: +s.endsAt,
          };

  const sched = {
    first: (s) => (s.kind === "once" ? s.runAt : s.startsAt),
    last(s) {
      if (s.kind === "once") return s.runAt;
      if (!(s.intervalMs > 0) || s.endsAt < s.startsAt) return s.startsAt;
      return s.startsAt + Math.floor((s.endsAt - s.startsAt) / s.intervalMs) * s.intervalMs;
    },
    occurrences(s, fromMs = -Infinity, toMs = Infinity, limit = 500) {
      if (!s) return [];
      if (s.kind === "once")
        return s.runAt >= fromMs && s.runAt <= toMs && limit > 0 ? [s.runAt] : [];
      const { startsAt, intervalMs, endsAt } = s;
      if (!(intervalMs > 0) || !Number.isFinite(startsAt) || !Number.isFinite(endsAt)) return [];
      const out = [];
      const k0 = fromMs > startsAt ? Math.ceil((fromMs - startsAt) / intervalMs) : 0;
      const end = Math.min(endsAt, toMs);
      for (let t = startsAt + k0 * intervalMs; t <= end && out.length < limit; t += intervalMs)
        out.push(t);
      return out;
    },
    next(s, nowMs = S.now) {
      if (!s) return null;
      if (s.kind === "once") return s.runAt > nowMs ? s.runAt : null;
      return sched.occurrences(s, nowMs + 1, Infinity, 1)[0] ?? null;
    },
    count(s, fromMs = -Infinity) {
      if (!s) return 0;
      if (s.kind === "once") return s.runAt >= fromMs ? 1 : 0;
      if (!(s.intervalMs > 0) || s.endsAt < s.startsAt) return 0;
      const k0 = fromMs > s.startsAt ? Math.ceil((fromMs - s.startsAt) / s.intervalMs) : 0;
      const kN = Math.floor((s.endsAt - s.startsAt) / s.intervalMs);
      return Math.max(0, kN - k0 + 1);
    },
    horizon: (nowMs = S.now) => nowMs + LIMITS.horizonMs,
    rollForward(s, nowMs = S.now) {
      const c = plainSchedule(s);
      if (c.kind === "once" || c.startsAt > nowMs) return c;
      const n = sched.next(c, nowMs);
      if (n != null) c.startsAt = n;
      return c;
    },
    dstShift(s, fromMs = S.now) {
      if (!s || s.kind === "once" || s.intervalMs % HOUR !== 0 || s.intervalMs < DAY) return null;
      const occ = sched.occurrences(s, fromMs, Infinity, 120);
      for (let i = 1; i < occ.length; i++) {
        const a = fmt.time(occ[i - 1]);
        const b = fmt.time(occ[i]);
        if (a !== b) return { at: occ[i], from: a, to: b };
      }
      return null;
    },
    /* Intervals are elapsed time, not calendar rules: a 7-day interval is
       "every 7 days from Fri 16:00", never "every Friday at 16:00", and a
       24 h one is "every 24 h from 03:00", never "daily at 03:00" — after
       a DST change the wall-clock time moves (see dstShift). The anchor is
       the first run while it is ahead, else the next run's slot. */
    cadence(s, nowMs = S.now) {
      if (!s) return "";
      if (s.kind === "once") return "Once";
      const i = s.intervalMs;
      if (i % DAY === 0) {
        const ref = anchorOf(s, nowMs);
        const at = i === DAY ? fmt.time(ref) : `${fmt.weekday(ref)} ${fmt.time(ref)}`;
        return `Every ${i === DAY ? "24 h" : `${i / DAY} days`} from ${at}`;
      }
      if (i === HOUR) return "Hourly";
      return `Every ${fmt.interval(i)}`;
    },
    label(s, nowMs = S.now) {
      if (!s) return "";
      if (s.kind === "once") return `Once · ${dayTime(s.runAt, nowMs)}`;
      return `${sched.cadence(s, nowMs)} · until ${fmt.date(s.endsAt, nowMs)}`;
    },
    /* For sentences: "every 7 days from Fri, Oct 9 at 16:00 until Dec 11",
       "every 24 hours from 03:00 until Oct 31", "every 2 hours until Oct 20".
       { dst: true } folds a DST shift into the same sentence:
       "every 24 hours from 03:00 (02:00 from Oct 25) until Oct 31" — use it
       only where no separate DST note is shown (say it once). */
    phrase(s, nowMs = S.now, o = {}) {
      if (!s) return "";
      if (s.kind === "once") {
        const n = calDays(s.runAt, nowMs);
        const t = fmt.time(s.runAt);
        if (n === 0) return `once, today at ${t}`;
        if (n === 1) return `once, tomorrow at ${t}`;
        return `once, on ${fmt.day(s.runAt)} at ${t}`;
      }
      const i = s.intervalMs;
      const ahead = s.startsAt > nowMs;
      const shift = o.dst ? sched.dstShift(s, nowMs) : null;
      const dst = shift ? ` (${shift.to} from ${fmt.date(shift.at, nowMs)})` : "";
      let core;
      if (i % DAY === 0) {
        const every = i === DAY ? "every 24 hours" : `every ${i / DAY} days`;
        const ref = anchorOf(s, nowMs);
        const at = ahead
          ? anchorAt(ref, nowMs)
          : i === DAY
            ? fmt.time(ref)
            : `${fmt.weekday(ref)} ${fmt.time(ref)}`;
        core = `${every} from ${at}${dst}`;
      } else {
        const every =
          i === HOUR
            ? "every hour"
            : i % HOUR === 0
              ? `every ${i / HOUR} hours`
              : `every ${Math.round(i / MIN)} minutes`;
        core = ahead ? `${every} from ${anchorAt(s.startsAt, nowMs)}${dst}` : `${every}${dst}`;
      }
      return `${core} until ${fmt.date(s.endsAt, nowMs)}`;
    },
    relative(ms, nowMs = S.now) {
      if (ms == null) return "";
      const diff = ms - nowMs;
      const a = Math.abs(diff);
      if (a < MIN) return diff >= 0 ? "in <1m" : "just now";
      if (a < 12 * HOUR) {
        const hh = Math.floor(a / HOUR);
        const mm = Math.floor((a % HOUR) / MIN);
        const s = hh ? (mm ? `${hh}h ${mm}m` : `${hh}h`) : `${mm}m`;
        return diff > 0 ? `in ${s}` : `${s} ago`;
      }
      return dayTime(ms, nowMs);
    },
    validate(draft, nowMs = S.now, o = {}) {
      const errors = {};
      const d = readDraft(draft);
      const id = o.id ?? d.id;
      // title
      if (!d.title?.trim()) errors.title = "Give it a short title.";
      else if (d.title.trim().length > LIMITS.titleMax)
        errors.title = `Keep the title under ${LIMITS.titleMax} characters.`;
      // prompt
      if (!d.prompt?.trim()) errors.prompt = "Tell the agent what to do on each run.";
      else if (d.prompt.length > LIMITS.promptMax)
        errors.prompt = `The prompt is ${d.prompt.length.toLocaleString("en-US")} characters; the limit is ${LIMITS.promptMax.toLocaleString("en-US")}.`;
      // model
      const sel = d.modelSelection;
      if (!sel?.instanceId || !sel?.model) errors.model = "Pick a model.";
      else {
        const prov = q.provider(sel.instanceId);
        if (!prov) errors.model = `${sel.instanceId} isn't set up on this device.`;
        else if (!q.model(sel.instanceId, sel.model))
          errors.model = `${sel.model} isn't available on ${prov.name} any more. Pick another model.`;
      }
      // schedule
      const s = d.schedule;
      const horizon = nowMs + LIMITS.horizonMs;
      if (!s) errors.start = "Pick when it runs.";
      else if (s.kind === "once") {
        if (!Number.isFinite(+s.runAt)) errors.start = "Pick a date and time.";
        else if (+s.runAt <= nowMs)
          errors.start = `That time has passed. Pick a time after ${dayTime(nowMs, nowMs)}.`;
        else if (+s.runAt > horizon)
          errors.start = `Schedules reach at most 90 days ahead — ${fmt.date(horizon, nowMs)} at the latest.`;
      } else {
        if (!Number.isFinite(+s.startsAt)) errors.start = "Pick when the first run happens.";
        else if (+s.startsAt <= nowMs)
          errors.start = `The first run has to be in the future — after ${dayTime(nowMs, nowMs)}.`;
        if (!Number.isFinite(+s.intervalMs) || +s.intervalMs <= 0)
          errors.interval = "Pick how often it runs.";
        else if (+s.intervalMs < LIMITS.minIntervalMs)
          errors.interval = "Runs can be at most every 15 minutes.";
        if (!Number.isFinite(+s.endsAt)) errors.end = "Recurring schedules need an end.";
        else if (Number.isFinite(+s.startsAt) && +s.endsAt < +s.startsAt)
          errors.end = "It ends before the first run.";
        else if (+s.endsAt > horizon)
          errors.end = `Recurring schedules end within 90 days — ${fmt.date(horizon, nowMs)} at the latest.`;
      }
      // the 25-per-project limit (create, or re-enabling a stopped schedule)
      const existing = id ? q.automation(id) : null;
      const projectId = d.projectId ?? existing?.projectId;
      if (projectId && d.enabled !== false && !q.isActive(existing)) {
        if (q.activeCount(projectId) >= LIMITS.perProject) {
          const name = q.project(projectId)?.name ?? projectId;
          errors.limit = `${name} already has ${LIMITS.perProject} active schedules, the most a project can have. Pause or cancel one first.`;
        }
      }
      return { ok: Object.keys(errors).length === 0, errors };
    },
    blank(projectId, deviceId) {
      const now = S.now;
      const tomorrow9 = new Date(now);
      tomorrow9.setDate(tomorrow9.getDate() + 1);
      tomorrow9.setHours(9, 0, 0, 0);
      const startsAt = tomorrow9.getTime();
      const p = q.project(projectId);
      return {
        deviceId: deviceId ?? p?.checkouts[0]?.deviceId ?? "mac",
        execution: {
          projectId,
          title: "",
          prompt: "",
          modelSelection: {
            instanceId: "claude",
            model: "claude-sonnet-5-5",
            options: [{ id: "effort", value: "medium" }],
          },
          runtimeMode: "auto-accept-edits",
          envMode: "worktree",
          baseRef: p?.refs?.[0] ?? "main",
        },
        schedule: {
          kind: "fixed-interval",
          startsAt,
          intervalMs: DAY,
          endsAt: startsAt + 30 * DAY,
        },
        enabled: true,
      };
    },
    clone: (def) => (def == null ? def : JSON.parse(JSON.stringify(def))),
    draftOf(x, nowMs = S.now) {
      if (!x) return null;
      const def = sched.clone(x.definition ?? x.after ?? x.before ?? x);
      def.schedule = sched.rollForward(def.schedule, nowMs);
      def.id = x.automationId ?? x.id ?? null;
      def.deviceId = x.deviceId ?? q.project(def.execution.projectId)?.checkouts[0]?.deviceId;
      return def;
    },
  };

  function readDraft(d) {
    if (!d) return {};
    if (d.definition) d = { ...d.definition, id: d.id };
    const ex = d.execution ?? d;
    let sel = ex.modelSelection ?? d.modelSelection ?? null;
    if (!sel && d.model)
      sel = { instanceId: d.instanceId ?? d.provider, model: d.model, options: [] };
    return {
      id: d.id ?? d.automationId ?? null,
      projectId: ex.projectId ?? d.projectId ?? null,
      title: ex.title ?? "",
      prompt: ex.prompt ?? "",
      modelSelection: sel,
      schedule: d.schedule ?? null,
      enabled: d.enabled ?? true,
    };
  }

  /* Normalise anything save() is handed into a contract-shaped definition. */
  function toDefinition(def, fallbackProjectId) {
    const d = readDraft(def);
    const ex = (def.definition ?? def).execution ?? def;
    const execution = {
      projectId: d.projectId ?? fallbackProjectId,
      title: (d.title ?? "").trim(),
      prompt: (d.prompt ?? "").trim(),
      modelSelection: sched.clone(
        d.modelSelection ?? { instanceId: "claude", model: "claude-sonnet-5-5", options: [] },
      ),
      runtimeMode: ex.runtimeMode ?? "auto-accept-edits",
      envMode: ex.envMode ?? "worktree",
    };
    if (!execution.modelSelection.options) execution.modelSelection.options = [];
    if (ex.baseRef && execution.envMode === "worktree") execution.baseRef = ex.baseRef;
    return { execution, schedule: plainSchedule(d.schedule), enabled: d.enabled !== false };
  }

  /* ======================================================== records */
  const newId = (prefix) => `${prefix}-${++S.seq}`;
  function makeRun(fields) {
    return Object.assign(Object.create(S._proto.run), fields);
  }
  function makeProposal(fields) {
    return Object.assign(Object.create(S._proto.proposal), fields);
  }
  function makeAutomation(fields) {
    return Object.assign(Object.create(S._proto.automation), fields);
  }
  function trimHistory(aid) {
    const runs = q.runsFor(aid);
    if (runs.length <= LIMITS.historyMax) return;
    const drop = new Set(
      runs
        .filter((r) => !RUN_STATUS[r.status]?.active)
        .slice(LIMITS.historyMax - runs.length)
        .map((r) => r.id),
    );
    S.runs = S.runs.filter((r) => !drop.has(r.id));
  }
  function cancelPending(a, detail) {
    for (const r of S.runs) {
      if (r.automationId !== a.id) continue;
      if (r.status !== "pending-approval" && r.status !== "materializing") continue;
      r.status = "cancelled";
      r.safeFailureDetail = detail;
      r.updatedAt = S.now;
      r.completedAt = S.now;
      fire("run:status", r);
    }
  }

  /* ======================================================== jobs
     Run progression after an approval happens in real time (it is an
     outcome, not the passage of schedule time), so it plays out even while
     the clock is paused. `sim` jobs only count time while the sim plays. */
  let jobs = [];
  let lastJobTick = performance.now();
  function job(ms, fn, kind = "real") {
    jobs.push({ left: ms, fn, kind });
  }
  setInterval(() => {
    const now = performance.now();
    const dt = now - lastJobTick;
    lastJobTick = now;
    const due = [];
    for (const j of jobs) {
      if (j.kind === "sim" && !S.playing) continue;
      j.left -= j.kind === "sim" ? dt * Math.min(S.speed, 4) : dt;
      if (j.left <= 0) due.push(j);
    }
    if (!due.length) return;
    jobs = jobs.filter((j) => !due.includes(j));
    for (const j of due) j.fn();
    emit();
  }, 100);

  let approvals = 0;
  const FAILURES = {
    studio: "Studio went offline before the thread started.",
    codex: "Codex app-server exited before the thread started (exit code 1).",
    claude: "Claude was rate limited, so the thread did not start.",
  };
  function finishRun(r) {
    if (r.status !== "executing") return;
    approvals++;
    r.updatedAt = S.now;
    r.completedAt = S.now;
    r.unread = true;
    if (approvals % 5 === 3) {
      r.status = "failed";
      r.safeFailureDetail =
        r.deviceId === "studio"
          ? FAILURES.studio
          : (FAILURES[r.providerInstanceId] ?? FAILURES.codex);
    } else {
      const t = {
        id: newId("t"),
        title: r.execution?.title ?? "Scheduled run",
        projectId: r.projectId,
        deviceId: r.deviceId,
        automationId: r.automationId,
        runId: r.id,
        createdAt: S.now,
      };
      S.threads.push(t);
      r.threadIds = [t.id];
      r.status = "completed";
    }
    fire("run:status", r);
  }
  function progressRun(r) {
    job(1200, () => {
      if (r.status !== "approved") return;
      r.status = "executing";
      r.updatedAt = S.now;
      fire("run:status", r);
    });
    job(6000, () => finishRun(r));
  }

  /* ======================================================== actions */
  function supersede(automationId) {
    for (const p of S.proposals) {
      if (p.automationId !== automationId || !p.pending) continue;
      p.status = "superseded";
      p.updatedAt = S.now;
      p.decidedAt = S.now;
    }
  }
  function propose(fields) {
    const now = S.now;
    const id = newId("p");
    const p = makeProposal({
      id,
      proposalId: id,
      plan: {
        kind:
          fields.kind === "create"
            ? "createAutomation"
            : fields.kind === "cancel"
              ? "cancelAutomation"
              : "updateAutomation",
      },
      status: "pending-user-approval",
      detail: null,
      createdAt: now,
      updatedAt: now,
      expiresAt: now + LIMITS.approvalTtlMs,
      decidedAt: null,
      ...fields,
    });
    supersede(p.automationId);
    S.proposals.push(p);
    fire("proposal:new", p);
    emit();
    return p;
  }
  const sameExceptEnabled = (a, b) =>
    JSON.stringify({ ...a, enabled: true }) === JSON.stringify({ ...b, enabled: true });

  const act = {
    save(def, o = {}) {
      if (!def) return null;
      const id = o.id ?? def.automationId ?? def.id ?? null;
      const a = id ? q.automation(id) : null;
      if (a?.cancelled) return null;
      const d = toDefinition(def, a?.projectId ?? o.projectId);
      if (!d.execution.projectId) return null;
      const project = q.project(d.execution.projectId);
      const deviceId =
        o.deviceId ?? def.deviceId ?? a?.deviceId ?? project?.checkouts[0]?.deviceId ?? "mac";
      let kind = o.kind;
      if (!kind) {
        if (!a) kind = "create";
        else if (a.enabled !== d.enabled && sameExceptEnabled(a.definition, d))
          kind = d.enabled ? "resume" : "pause";
        else kind = "edit";
      }
      return propose({
        kind,
        automationId: a?.id ?? id ?? newId("a"),
        projectId: d.execution.projectId,
        deviceId,
        before: a ? sched.clone(a.definition) : null,
        after: d,
        expectedRevision: o.expectedRevision ?? a?.revision ?? null,
      });
    },

    approve(proposalId) {
      const p = q.proposal(proposalId);
      if (!p || !p.pending) return null;
      const now = S.now;
      const fail = (detail) => {
        p.status = "failed";
        p.detail = detail;
        p.updatedAt = now;
        p.decidedAt = now;
        fire("proposal:decided", p);
        emit();
        return null;
      };
      const limitMsg = () =>
        `${q.project(p.projectId)?.name ?? p.projectId} already has ${LIMITS.perProject} active schedules.`;
      let a;
      if (p.kind === "create") {
        if (q.automation(p.automationId)) return fail("A schedule with this id already exists.");
        if (sched.first(p.after.schedule) <= now)
          return fail("The first run time passed before approval. Edit the start and save again.");
        if (p.after.enabled && q.activeCount(p.projectId) >= LIMITS.perProject)
          return fail(limitMsg());
        a = makeAutomation({
          id: p.automationId,
          automationId: p.automationId,
          projectId: p.projectId,
          deviceId: p.deviceId,
          providerInstanceId: p.after.execution.modelSelection.instanceId,
          definition: sched.clone(p.after),
          revision: 1,
          enabled: p.after.enabled,
          cancelled: false,
          cancelledAt: null,
          nextRunAt: p.after.enabled ? sched.next(p.after.schedule, now) : null,
          createdAt: now,
          updatedAt: now,
        });
        S.automations.push(a);
      } else {
        a = q.automation(p.automationId);
        if (!a) return fail("This schedule no longer exists.");
        if (a.cancelled) return fail("Cancelled schedules can't be changed.");
        if (p.expectedRevision != null && a.revision !== p.expectedRevision)
          return fail("The schedule changed since this was proposed. Review it again.");
        if (p.kind === "cancel") {
          a.cancelled = true;
          a.cancelledAt = now;
          a.nextRunAt = null;
        } else {
          if (sched.first(p.after.schedule) <= now)
            return fail(
              "The first run time passed before approval. Edit the start and save again.",
            );
          if (p.after.enabled && !q.isActive(a) && q.activeCount(a.projectId) >= LIMITS.perProject)
            return fail(limitMsg());
          a.definition = sched.clone(p.after);
          a.enabled = p.after.enabled;
          a.providerInstanceId = p.after.execution.modelSelection.instanceId;
          if (p.deviceId) a.deviceId = p.deviceId;
          a.nextRunAt = a.enabled ? sched.next(a.definition.schedule, now) : null;
        }
        a.revision += 1;
        a.updatedAt = now;
        cancelPending(a, "Schedule changed before run approval.");
      }
      p.status = "approved";
      p.updatedAt = now;
      p.decidedAt = now;
      fire("proposal:decided", p);
      emit();
      return a;
    },

    reject(proposalId) {
      const p = q.proposal(proposalId);
      if (!p || !p.pending) return null;
      p.status = "rejected";
      p.updatedAt = S.now;
      p.decidedAt = S.now;
      fire("proposal:decided", p);
      emit();
      return p;
    },

    approveRun(runId) {
      const r = q.run(runId);
      if (!r || r.status !== "pending-approval") return null;
      r.status = "approved";
      r.updatedAt = S.now;
      r.unread = false;
      progressRun(r);
      fire("run:status", r);
      emit();
      return r;
    },

    rejectRun(runId) {
      const r = q.run(runId);
      if (!r || r.status !== "pending-approval") return null;
      r.status = "rejected";
      r.updatedAt = S.now;
      r.completedAt = S.now;
      r.unread = false;
      fire("run:status", r);
      emit();
      return r;
    },

    pause(id) {
      const a = q.automation(id);
      if (!a || a.cancelled || !a.enabled) return null;
      const def = sched.clone(a.definition);
      def.enabled = false;
      def.schedule = sched.rollForward(def.schedule, S.now);
      return act.save(def, { id, kind: "pause" });
    },

    resume(id) {
      const a = q.automation(id);
      if (!a || a.cancelled || a.enabled) return null;
      const def = sched.clone(a.definition);
      def.enabled = true;
      def.schedule = sched.rollForward(def.schedule, S.now);
      return act.save(def, { id, kind: "resume" });
    },

    cancel(id) {
      const a = q.automation(id);
      if (!a) {
        // Withdrawing a schedule that only exists as a pending create.
        const p = S.proposals.find((x) => x.automationId === id && x.pending);
        return p ? act.reject(p.id) : null;
      }
      if (a.cancelled) return null;
      return propose({
        kind: "cancel",
        automationId: a.id,
        projectId: a.projectId,
        deviceId: a.deviceId,
        before: sched.clone(a.definition),
        after: null,
        expectedRevision: a.revision,
      });
    },

    retryRun(runId) {
      const src = q.run(runId);
      if (!q.canRetry(src).ok) return null;
      const a = q.automation(src.automationId);
      const id = newId("r");
      const r = makeRun({
        id,
        runId: id,
        automationId: a.id,
        automationRevision: a.revision,
        projectId: a.projectId,
        deviceId: a.deviceId,
        providerInstanceId: a.providerInstanceId,
        execution: sched.clone(a.definition.execution),
        scheduledFor: src.scheduledFor,
        coalescedOccurrences: src.coalescedOccurrences,
        status: "pending-approval",
        proposalId: `rp-${id}`,
        safeFailureDetail: null,
        threadIds: [],
        unread: true,
        retryOfRunId: src.id,
        createdAt: S.now,
        updatedAt: S.now,
        expiresAt: S.now + LIMITS.approvalTtlMs,
        completedAt: null,
      });
      S.runs.push(r);
      trimHistory(a.id);
      fire("run:new", r);
      emit();
      return r;
    },

    markRead(runId, read = true) {
      const r = q.run(runId);
      if (!r) return null;
      r.unread = !read;
      emit();
      return r;
    },

    openThread(threadId) {
      const t = q.thread(threadId);
      if (t) toast(`Opened “${t.title}”`);
      return t;
    },
  };

  /* ======================================================== sim */
  function materialize(a) {
    const s = a.definition.schedule;
    const due = a.nextRunAt;
    let coalesced = 0;
    let next = null;
    if (s.kind === "fixed-interval") {
      coalesced = Math.max(0, Math.floor((Math.min(S.now, s.endsAt) - due) / s.intervalMs));
      const cand = due + (coalesced + 1) * s.intervalMs;
      next = cand <= s.endsAt ? cand : null;
    }
    const id = newId("r");
    const r = makeRun({
      id,
      runId: id,
      automationId: a.id,
      automationRevision: a.revision,
      projectId: a.projectId,
      deviceId: a.deviceId,
      providerInstanceId: a.providerInstanceId,
      execution: sched.clone(a.definition.execution),
      scheduledFor: due,
      coalescedOccurrences: coalesced,
      status: "pending-approval",
      proposalId: `rp-${id}`,
      safeFailureDetail: null,
      threadIds: [],
      unread: true,
      retryOfRunId: null,
      createdAt: S.now,
      updatedAt: S.now,
      expiresAt: S.now + LIMITS.approvalTtlMs,
      completedAt: null,
    });
    S.runs.push(r);
    a.nextRunAt = next;
    trimHistory(a.id);
    fire("run:new", r);
  }
  function step(dtMs) {
    S.now += dtMs;
    for (const a of S.automations)
      if (a.enabled && !a.cancelled && a.nextRunAt != null && a.nextRunAt <= S.now) materialize(a);
    for (const r of S.runs) {
      if (r.status === "pending-approval" && r.expiresAt <= S.now) {
        r.status = "expired";
        r.updatedAt = r.expiresAt;
        r.completedAt = r.expiresAt;
        fire("run:expired", r);
      }
    }
    for (const p of S.proposals) {
      if (p.pending && p.expiresAt <= S.now) {
        p.status = "expired";
        p.updatedAt = p.expiresAt;
        p.decidedAt = p.expiresAt;
        fire("proposal:decided", p);
      }
    }
  }
  function tick(realMs = 1000) {
    step(realMs * (S.speed || 1));
    emit();
  }
  function advance(minutes) {
    for (let i = 0; i < minutes; i++) step(MIN);
    emit();
  }
  let simTimer = 0;
  function startSim() {
    clearInterval(simTimer);
    simTimer = setInterval(() => {
      if (S.playing) tick(1000);
    }, 1000);
  }
  function registerSeedJobs() {
    // The seeded "Starting" run finishes after ~45 s of playing time.
    const r = q.run("r-ci-4");
    if (r && r.status === "executing") job(45_000, () => finishRun(r), "sim");
  }
  registerSeedJobs();
  function reset() {
    jobs = [];
    approvals = 0;
    S.reset();
    registerSeedJobs();
    emit();
  }

  /* ======================================================== morph */
  function springCurve(stiffness, damping, samples = 48) {
    const step = 1 / 240;
    let p = 0;
    let v = 0;
    let t = 0;
    const trace = [0];
    while (t < 4) {
      v += (-stiffness * (p - 1) - damping * v) * step;
      p += v * step;
      t += step;
      trace.push(p);
      if (Math.abs(1 - p) < 0.0008 && Math.abs(v) < 0.01) break;
    }
    const pts = [];
    for (let i = 0; i < samples; i++)
      pts.push(
        i === samples - 1
          ? 1
          : Math.round((trace[Math.round((i / (samples - 1)) * (trace.length - 1))] ?? 1) * 1e4) /
              1e4,
      );
    return { easing: `linear(${pts.join(", ")})`, durationMs: Math.round(t * 1000) };
  }
  const PROFILES = {
    // ~380 ms grow with a hair of settle; ~300 ms fold.
    dialog: {
      grow: springCurve(420, 37),
      fold: { easing: EASE, durationMs: 300 },
      fadeOut: 90,
      fadeIn: 160,
      riseMs: 260,
      risePx: 6,
      stagger: 36,
      revealAt: 0.4,
      foldFadeFrom: 0.6,
      hideOrigin: true,
      pulse: true,
    },
    popover: {
      grow: springCurve(760, 52),
      fold: { easing: EASE, durationMs: 220 },
      fadeOut: 70,
      fadeIn: 120,
      riseMs: 200,
      risePx: 4,
      stagger: 24,
      revealAt: 0.32,
      foldFadeFrom: 0.5,
      hideOrigin: false,
      pulse: false,
    },
  };
  const isMorphable = (el) => {
    if (!(el instanceof Element) || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const radiusOf = (el, fb) => {
    const r = parseFloat(getComputedStyle(el).borderTopLeftRadius);
    return Number.isFinite(r) ? r : fb;
  };
  const rectOf = (el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  };
  function readPaint(el) {
    const c = getComputedStyle(el);
    return {
      backgroundColor: c.backgroundColor,
      boxShadow: c.boxShadow,
      borderStyle: c.borderTopStyle,
      borderWidth: c.borderTopWidth,
      borderColor: c.borderTopColor,
    };
  }
  /* A childless copy of the surface's paint that travels between rects.
     position: fixed, corrected for any containing block it lands in. */
  function makeGhost(paint, rect, radius, parent, before, zIndex) {
    const g = document.createElement("div");
    g.setAttribute("aria-hidden", "true");
    g.dataset.morphGhost = "";
    Object.assign(g.style, {
      position: "fixed",
      margin: "0",
      pointerEvents: "none",
      contain: "strict",
      boxSizing: "border-box",
      left: "0px",
      top: "0px",
      width: "0px",
      height: "0px",
      ...paint,
    });
    if (zIndex && zIndex !== "auto") g.style.zIndex = zIndex;
    parent.insertBefore(g, before ?? null);
    const base = g.getBoundingClientRect();
    g._ox = base.left;
    g._oy = base.top;
    Object.assign(g.style, frame(g, rect, radius));
    return g;
  }
  const frame = (g, r, radius) => ({
    left: `${r.left - g._ox}px`,
    top: `${r.top - g._oy}px`,
    width: `${r.width}px`,
    height: `${r.height}px`,
    borderRadius: `${radius}px`,
  });
  function travel(g, from, to, fromR, toR, curve, fadeFrom) {
    const anims = [
      g.animate([frame(g, from, fromR), frame(g, to, toR)], {
        duration: curve.durationMs,
        easing: curve.easing,
        fill: "forwards",
      }),
    ];
    if (fadeFrom != null)
      anims.push(
        g.animate([{ opacity: 1 }, { opacity: 1, offset: fadeFrom }, { opacity: 0 }], {
          duration: curve.durationMs,
          fill: "forwards",
        }),
      );
    return {
      finished: Promise.all(anims.map((a) => a.finished)).then(
        () => {},
        () => {},
      ),
      cancel: () => anims.forEach((a) => a.cancel()),
    };
  }
  function fadeScrim(scrim, popup, show, ms) {
    if (!scrim) return null;
    const contains = scrim.contains(popup);
    if (contains) {
      const bg = getComputedStyle(scrim).backgroundColor;
      const kf = [{ backgroundColor: "rgba(0,0,0,0)" }, { backgroundColor: bg }];
      return scrim.animate(show ? kf : kf.reverse(), {
        duration: ms,
        easing: "linear",
        fill: show ? "backwards" : "forwards",
      });
    }
    return scrim.animate([{ opacity: show ? 0 : 1 }, { opacity: show ? 1 : 0 }], {
      duration: ms,
      easing: "linear",
      fill: show ? "backwards" : "forwards",
    });
  }

  const morph = {
    PROFILES,
    open(popup, origin, o = {}) {
      const prof = PROFILES[o.profile] ?? PROFILES.dialog;
      const surface = o.surface ?? popup;
      const hideOrigin = o.hideOrigin ?? prof.hideOrigin;
      const scrim = o.scrim ?? null;
      const host = popup.parentNode;
      const zIndex = getComputedStyle(popup).zIndex;
      const surfaceR = radiusOf(surface, 14);
      let content = [];
      let growGhost = null;
      let grow = null;
      let growFrom = null;
      let growTo = null;
      let openPaint = null;
      let originHidden = null;
      let closing = null;

      if (scrim) fadeScrim(scrim, popup, true, motionOn() ? 220 : 120);
      if (!motionOn()) {
        content.push(popup.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 120 }));
      } else if (isMorphable(origin) && surface.getBoundingClientRect().width > 0 && host) {
        const paint = readPaint(surface);
        openPaint = paint;
        const start = rectOf(origin);
        const end = rectOf(surface);
        growFrom = start;
        growTo = end;
        const originR = radiusOf(origin, 8);
        growGhost = makeGhost(paint, start, originR, host, popup, zIndex);
        surface.setAttribute("data-morphing", "");
        grow = travel(growGhost, start, end, originR, surfaceR, prof.grow);
        const g = growGhost;
        grow.finished.then(() => {
          if (growGhost !== g) return;
          surface.removeAttribute("data-morphing");
          g.remove();
          growGhost = null;
        });
        if (hideOrigin)
          originHidden = origin.animate([{ opacity: 1 }, { opacity: 0 }], {
            duration: prof.fadeOut,
            fill: "forwards",
          });
        const reveal = prof.grow.durationMs * prof.revealAt;
        content.push(
          popup.animate([{ opacity: 0 }, { opacity: 1 }], {
            duration: prof.fadeIn,
            delay: reveal,
            fill: "backwards",
          }),
        );
        [...surface.children].forEach((child, i) => {
          content.push(
            child.animate(
              [
                { opacity: 0, translate: `0 ${prof.risePx}px` },
                { opacity: 1, translate: "0 0" },
              ],
              {
                duration: prof.riseMs,
                delay: reveal + Math.min(i, 6) * prof.stagger,
                easing: EASE_OUT,
                fill: "backwards",
              },
            ),
          );
        });
      } else {
        content.push(
          popup.animate(
            [
              { opacity: 0, scale: "0.97" },
              { opacity: 1, scale: "1" },
            ],
            { duration: 200, easing: EASE_OUT },
          ),
        );
      }

      const revealOrigin = (delay) => {
        if (!originHidden) return;
        originHidden.cancel();
        originHidden = null;
        if (origin?.isConnected && motionOn())
          origin.animate([{ opacity: 0 }, { opacity: 1 }], {
            duration: 160,
            delay,
            fill: "backwards",
          });
      };
      const stopGrow = () => {
        const g = growGhost;
        growGhost = null;
        grow?.cancel();
        g?.remove();
      };
      const resolve = (t) => (typeof t === "function" ? t(origin) : t);

      function close(target) {
        if (closing) return closing;
        closing = (async () => {
          /* Read the frame on screen before anything is cancelled: a close
             mid-grow reverses from where the ghost is now (not the final
             rect), and content that has not been revealed stays hidden. */
          const live = growGhost?.isConnected ? growGhost : null;
          const midGrow = live ? { rect: rectOf(live), radius: radiusOf(live, surfaceR) } : null;
          const shown = popup.isConnected ? parseFloat(getComputedStyle(popup).opacity) : 0;
          const opacityNow = Number.isFinite(shown) ? clamp(shown, 0, 1) : 1;
          // Hold every content animation on its current frame (cancelling
          // would snap unrevealed content to full opacity for a frame).
          content.forEach((a) => {
            try {
              a.pause();
            } catch {}
          });
          const held = content;
          content = [];
          const finish = () => {
            held.forEach((a) => a.cancel());
            surface.removeAttribute("data-morphing");
            if (o.onClosed) {
              o.onClosed();
              popup.getAnimations().forEach((a) => a.cancel());
            } else popup.remove();
          };
          if (!motionOn()) {
            stopGrow();
            if (scrim) fadeScrim(scrim, popup, false, 100);
            await popup
              .animate([{ opacity: opacityNow }, { opacity: 0 }], {
                duration: 100,
                fill: "forwards",
              })
              .finished.catch(() => {});
            revealOrigin(0);
            finish();
            return;
          }
          const from = midGrow?.rect ?? rectOf(surface);
          if (!from.width || !popup.isConnected) {
            stopGrow();
            revealOrigin(0);
            finish();
            return;
          }
          // Mid-grow the content may not be up yet: fade only what shows,
          // and start folding as soon as it is gone.
          const fadeOut = midGrow ? Math.round(prof.fadeOut * opacityNow) : prof.fadeOut;
          // A partial grow folds back over a proportionally shorter time.
          let foldCurve = prof.fold;
          if (midGrow && growFrom && growTo) {
            const span = Math.max(
              1,
              Math.abs(growTo.width - growFrom.width) + Math.abs(growTo.height - growFrom.height),
            );
            const done = clamp(
              (Math.abs(from.width - growFrom.width) + Math.abs(from.height - growFrom.height)) /
                span,
              0,
              1,
            );
            foldCurve = {
              ...prof.fold,
              durationMs: Math.round(prof.fold.durationMs * (0.45 + 0.55 * done)),
            };
          }
          const total = fadeOut + foldCurve.durationMs;
          if (scrim) fadeScrim(scrim, popup, false, total);
          popup.animate(
            [{ opacity: opacityNow }, { opacity: 0, offset: fadeOut / total }, { opacity: 0 }],
            { duration: total, fill: "forwards" },
          );
          // While the grow ghost carries the paint, the surface is transparent
          // ([data-morphing]); reuse the paint captured when it opened.
          const paint =
            surface.hasAttribute("data-morphing") && openPaint ? openPaint : readPaint(surface);
          const fromR = midGrow?.radius ?? surfaceR;
          const g = makeGhost(paint, from, fromR, popup.parentNode, popup, zIndex);
          stopGrow(); // the fold ghost already sits on the same frame
          surface.setAttribute("data-morphing", "");
          if (fadeOut > 0) await wait(fadeOut);
          const resolved = resolve(target) ?? origin;
          const landing = isMorphable(resolved) ? resolved : isMorphable(origin) ? origin : null;
          if (!landing) {
            await g
              .animate(
                [
                  { opacity: 1, scale: "1" },
                  { opacity: 0, scale: "0.98" },
                ],
                { duration: 180, easing: EASE_OUT, fill: "forwards" },
              )
              .finished.catch(() => {});
            g.remove();
            revealOrigin(0);
            finish();
            return;
          }
          const lr = rectOf(landing);
          const t = travel(g, from, lr, fromR, radiusOf(landing, 8), foldCurve, prof.foldFadeFrom);
          revealOrigin(foldCurve.durationMs * prof.foldFadeFrom);
          if (prof.pulse) {
            const amount = lr.width > 240 ? 1.012 : 1.06;
            landing.animate([{ scale: "1" }, { scale: String(amount) }, { scale: "1" }], {
              duration: 280,
              delay: foldCurve.durationMs * 0.78,
              easing: EASE_OUT,
            });
          }
          await t.finished;
          g.remove();
          finish();
        })();
        return closing;
      }
      close.popup = popup;
      return close;
    },
  };

  /* ======================================================== plate */
  function plate(seg, o = {}) {
    if (!seg) return { update() {}, destroy() {}, el: null };
    seg.classList.add("has-plate");
    if (getComputedStyle(seg).position === "static") seg.style.position = "relative";
    const el = h("span", `seg-plate ${o.className ?? ""}`);
    el.setAttribute("aria-hidden", "true");
    seg.prepend(el);
    let placed = false;
    const selected = () =>
      $$('[aria-checked="true"], [aria-selected="true"]', seg).find(
        (x) => x !== el && x.offsetParent,
      );
    function offsetIn(node) {
      let x = 0;
      let y = 0;
      let n = node;
      while (n && n !== seg) {
        x += n.offsetLeft;
        y += n.offsetTop;
        const parent = n.offsetParent;
        if (!parent || (!seg.contains(parent) && parent !== seg)) break;
        n = parent;
      }
      return { x, y };
    }
    function update() {
      const target = selected();
      if (!target || !seg.offsetWidth) {
        el.style.opacity = "0";
        return;
      }
      const { x, y } = offsetIn(target);
      const animate = placed && motionOn();
      el.style.transition = animate
        ? `transform 320ms ${EASE}, width 320ms ${EASE}, height 320ms ${EASE}, opacity 160ms`
        : "none";
      el.style.transform = `translate(${x}px, ${y}px)`;
      el.style.width = `${target.offsetWidth}px`;
      el.style.height = `${target.offsetHeight}px`;
      el.style.opacity = "1";
      if (!placed) {
        el.getBoundingClientRect();
        placed = true;
      }
    }
    const mo = new MutationObserver(() => update());
    mo.observe(seg, {
      subtree: true,
      attributes: true,
      attributeFilter: ["aria-checked", "aria-selected", "hidden", "class"],
      childList: true,
    });
    const ro = new ResizeObserver(() => {
      const was = placed;
      placed = false; // follow resizes without sliding
      update();
      placed = was || placed;
    });
    ro.observe(seg);
    for (const c of seg.children) if (c !== el) ro.observe(c);
    document.fonts?.ready.then(() => {
      placed = false;
      update();
    });
    update();
    return {
      el,
      update,
      destroy() {
        mo.disconnect();
        ro.disconnect();
        el.remove();
        seg.classList.remove("has-plate");
      },
    };
  }

  /* ======================================================== settle / flip */
  function settle(el, o = {}) {
    const list = el instanceof Element ? [el] : [...(el ?? [])];
    if (!motionOn()) return [];
    return list.map((node, i) =>
      node.animate(
        [
          { opacity: 0, translate: `0 ${o.y ?? 6}px` },
          { opacity: 1, translate: "0 0" },
        ],
        {
          duration: o.duration ?? 320,
          delay: (o.delay ?? 0) + i * (o.stagger ?? 0),
          easing: EASE,
          fill: "backwards",
        },
      ),
    );
  }
  function flip(container, mutate, o = {}) {
    const sel = o.selector ?? "[data-key]";
    const before = new Map();
    for (const el of $$(sel, container)) before.set(el.dataset.key, el.getBoundingClientRect());
    mutate?.();
    if (!motionOn()) return;
    for (const el of $$(sel, container)) {
      const b = before.get(el.dataset.key);
      if (!b) {
        settle(el, { duration: o.duration ?? 360 });
        continue;
      }
      const r = el.getBoundingClientRect();
      const dx = b.left - r.left;
      const dy = b.top - r.top;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
      el.animate([{ translate: `${dx}px ${dy}px` }, { translate: "0 0" }], {
        duration: o.duration ?? 380,
        easing: GENTLE,
      });
    }
  }

  /* ======================================================== layers */
  const stack = [];
  const layers = {
    push(layer) {
      const L = { dismissOnOutside: false, ...layer };
      stack.push(L);
      return () => {
        const i = stack.indexOf(L);
        if (i >= 0) stack.splice(i, 1);
      };
    },
    top: () => stack[stack.length - 1] ?? null,
    get size() {
      return stack.length;
    },
    closeAll(reason = "reset") {
      for (const L of stack.slice().reverse()) L.close?.(reason);
    },
  };
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Escape" || !stack.length) return;
      const top = stack[stack.length - 1];
      e.preventDefault();
      e.stopImmediatePropagation();
      Tip.hide();
      top.close?.("escape");
    },
    true,
  );
  document.addEventListener(
    "pointerdown",
    (e) => {
      for (let i = stack.length - 1; i >= 0; i--) {
        const L = stack[i];
        if (L.el?.contains(e.target) || L.anchor?.contains(e.target)) break;
        if (!L.dismissOnOutside) break;
        L.close?.("outside");
      }
    },
    true,
  );
  const FOCUSABLE =
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';
  const focusables = (root) =>
    $$(FOCUSABLE, root).filter((el) => el.offsetParent !== null || el === document.activeElement);
  function trapFocus(container) {
    const onKey = (e) => {
      if (e.key !== "Tab") return;
      const top = stack[stack.length - 1];
      if (top && top.el !== container && !container.contains(top.el)) return;
      const els = focusables(container);
      if (!els.length) {
        e.preventDefault();
        container.focus();
        return;
      }
      const first = els[0];
      const last = els[els.length - 1];
      if (
        e.shiftKey &&
        (document.activeElement === first || !container.contains(document.activeElement))
      ) {
        e.preventDefault();
        last.focus();
      } else if (
        !e.shiftKey &&
        (document.activeElement === last || !container.contains(document.activeElement))
      ) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }

  /* ======================================================== popover */
  const openPopovers = new Map();
  const HASPOPUP = ["dialog", "menu", "listbox", "tree", "grid"];
  const viewportBox = () => ({ l: 0, t: 0, r: innerWidth, b: innerHeight });
  const boxOf = (el) => {
    const r = el.getBoundingClientRect();
    return { l: r.left, t: r.top, r: r.right, b: r.bottom };
  };
  const inset = (B, n) => ({ l: B.l + n, t: B.t + n, r: B.r - n, b: B.b - n });
  const meet = (A, B) => ({
    l: Math.max(A.l, B.l),
    t: Math.max(A.t, B.t),
    r: Math.min(A.r, B.r),
    b: Math.min(A.b, B.b),
  });
  let layerSeq = 0;
  const labelOf = (el) =>
    (el.getAttribute("aria-label") ?? el.textContent ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120);
  /* Give a dialog-ish layer an accessible name: o.labelledby (id or element),
     o.label, else its own heading ([data-pop-label], h1–h6, [role=heading]),
     else the anchor's name. */
  function nameLayer(el, anchor, o = {}) {
    if (
      !["dialog", "alertdialog", "menu", "listbox", "grid", "tree"].includes(
        el.getAttribute("role"),
      )
    )
      return;
    if (o.labelledby) {
      const t =
        typeof o.labelledby === "string" ? document.getElementById(o.labelledby) : o.labelledby;
      if (t) {
        if (!t.id) t.id = `lab-layer-h${++layerSeq}`;
        el.setAttribute("aria-labelledby", t.id);
        return;
      }
    }
    if (o.label) {
      el.setAttribute("aria-label", o.label);
      return;
    }
    if (el.hasAttribute("aria-label") || el.hasAttribute("aria-labelledby")) return;
    const head = el.querySelector("[data-pop-label], h1, h2, h3, h4, h5, h6, [role='heading']");
    if (head && labelOf(head)) {
      if (!head.id) head.id = `lab-layer-h${++layerSeq}`;
      el.setAttribute("aria-labelledby", head.id);
      return;
    }
    const inner = el.firstElementChild;
    const innerName = inner?.getAttribute("aria-label");
    if (innerName) {
      el.setAttribute("aria-label", innerName);
      return;
    }
    const name = anchor ? labelOf(anchor) : "";
    if (name) el.setAttribute("aria-label", name);
  }
  /* The next tabbable element after `ref` in document order inside `scope`
     (skipping `skip`), or null. */
  function nextTabbable(ref, scope, skip) {
    const els = focusables(scope).filter((x) => !skip?.contains(x));
    return (
      els.find(
        (x) =>
          ref.compareDocumentPosition(x) & Node.DOCUMENT_POSITION_FOLLOWING && !ref.contains(x),
      ) ?? null
    );
  }
  function popover(anchor, content, o = {}) {
    const existing = openPopovers.get(anchor);
    if (existing) {
      existing.close();
      return null;
    }
    const wrap = h("div", `surface pop ${o.className ?? ""}`);
    const role = o.role ?? "dialog";
    wrap.setAttribute("role", role);
    wrap.tabIndex = -1;
    if (typeof content === "string") wrap.innerHTML = content;
    else if (content) wrap.append(content);
    if (o.width) wrap.style.width = typeof o.width === "number" ? `${o.width}px` : o.width;
    const container =
      o.container ??
      anchor.closest("[data-layer], [role='dialog'], dialog") ??
      $("#app-window") ??
      document.body;
    Object.assign(wrap.style, { position: "fixed", left: "0px", top: "0px", zIndex: "1000" });
    container.append(wrap);
    nameLayer(wrap, anchor, o);
    const base = wrap.getBoundingClientRect();
    const ox = base.left;
    const oy = base.top;
    let api = null;
    let off = () => {};
    /* Keep the popover inside what actually shows it: the dialog/sheet it
       lives in when it fits there, else the app window (which clips), else
       the viewport — each inset 8px. */
    const appWin = anchor.closest("#app-window") ?? container.closest?.("#app-window") ?? null;
    const boxEl =
      o.boundary ??
      (container !== document.body && container !== appWin && container.isConnected
        ? container
        : null);
    function place() {
      if (!anchor.isConnected) {
        api?.close(null, "detached");
        return;
      }
      const a = anchor.getBoundingClientRect();
      const w = wrap.offsetWidth;
      const ht = wrap.offsetHeight;
      const [want, align = "start"] = (o.placement ?? "bottom-start").split("-");
      const gap = o.gap ?? 6;
      const win = inset(meet(viewportBox(), appWin ? boxOf(appWin) : viewportBox()), 8);
      const box = boxEl ? meet(win, inset(boxOf(boxEl), 8)) : win;
      let side = want;
      let left;
      let top;
      if (side === "bottom" || side === "top") {
        // x: the box when the popover fits its width, else the window;
        // flip start ↔ end before clamping so it stays on the anchor's edge.
        const X = w <= box.r - box.l ? box : win;
        left =
          align === "end" ? a.right - w : align === "start" ? a.left : a.left + a.width / 2 - w / 2;
        if (align === "start" && left + w > X.r && a.right - w >= X.l) left = a.right - w;
        else if (align === "end" && left < X.l && a.left + w <= X.r) left = a.left;
        left = clamp(left, X.l, Math.max(X.l, X.r - w));
        // y: the box when either side has room in it, else the window.
        const room = (B) => ({ below: B.b - a.bottom - gap, above: a.top - gap - B.t });
        let Y = box;
        let r = room(box);
        if (ht > r.below && ht > r.above) {
          Y = win;
          r = room(win);
        }
        if (side === "bottom" && ht > r.below && r.above > r.below) side = "top";
        else if (side === "top" && ht > r.above && r.below > r.above) side = "bottom";
        top = side === "bottom" ? a.bottom + gap : a.top - gap - ht;
        top = clamp(top, Y.t, Math.max(Y.t, Y.b - ht));
      } else {
        const Y = ht <= box.b - box.t ? box : win;
        top =
          align === "end"
            ? a.bottom - ht
            : align === "start"
              ? a.top
              : a.top + a.height / 2 - ht / 2;
        if (align === "start" && top + ht > Y.b && a.bottom - ht >= Y.t) top = a.bottom - ht;
        else if (align === "end" && top < Y.t && a.top + ht <= Y.b) top = a.top;
        top = clamp(top, Y.t, Math.max(Y.t, Y.b - ht));
        const room = (B) => ({ right: B.r - a.right - gap, left: a.left - gap - B.l });
        let X = box;
        let r = room(box);
        if (w > r.right && w > r.left) {
          X = win;
          r = room(win);
        }
        if (side === "right" && w > r.right && r.left > r.right) side = "left";
        else if (side === "left" && w > r.left && r.right > r.left) side = "right";
        left = side === "right" ? a.right + gap : a.left - gap - w;
        left = clamp(left, X.l, Math.max(X.l, X.r - w));
      }
      wrap.style.left = `${left - ox}px`;
      wrap.style.top = `${top - oy}px`;
      wrap.dataset.side = side;
    }
    place();
    anchor.setAttribute("aria-expanded", "true");
    if (!anchor.hasAttribute("aria-haspopup") && HASPOPUP.includes(role))
      anchor.setAttribute("aria-haspopup", role);
    const fold = morph.open(wrap, anchor, { profile: "popover", onClosed: () => wrap.remove() });
    let closed = false;
    const onScroll = () => place();
    window.addEventListener("resize", onScroll);
    document.addEventListener("scroll", onScroll, true);
    api = {
      el: wrap,
      anchor,
      reposition: place,
      close(target, reason = "close") {
        if (closed) return Promise.resolve();
        closed = true;
        openPopovers.delete(anchor);
        off();
        window.removeEventListener("resize", onScroll);
        document.removeEventListener("scroll", onScroll, true);
        anchor.setAttribute("aria-expanded", "false");
        window.removeEventListener("keydown", onTab, true);
        wrap.removeEventListener("focusout", onFocusOut);
        const active = document.activeElement;
        if (o.returnFocus !== false && (wrap.contains(active) || active === document.body))
          anchor.focus({ preventScroll: true });
        o.onClose?.(reason);
        return fold(target);
      },
    };
    const layer = {
      el: wrap,
      anchor,
      dismissOnOutside: true,
      close: (reason) => api.close(null, reason),
    };
    off = layers.push(layer);
    openPopovers.set(anchor, api);
    /* Keyboard: Tab never walks out of an open popover into the page
       behind. Tab past the last item closes it and moves on to whatever
       follows the anchor; Shift+Tab past the first returns to the anchor.
       { trap: true } cycles inside instead (modal pickers). */
    function onTab(e) {
      if (e.key !== "Tab" || e.defaultPrevented || closed) return;
      if (layers.top()?.el !== wrap) return;
      const active = document.activeElement;
      if (!wrap.contains(active)) return;
      const els = focusables(wrap);
      const first = els[0];
      const last = els[els.length - 1];
      const out = e.shiftKey
        ? !els.length || active === first || active === wrap
        : !els.length || active === last;
      if (!out) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (o.trap && els.length) {
        (e.shiftKey ? last : first).focus();
        return;
      }
      const scope =
        anchor.parentElement?.closest(
          "[role='dialog'], [role='alertdialog'], dialog, [data-layer]",
        ) ?? document.body;
      const next = e.shiftKey ? null : nextTabbable(anchor, scope, wrap);
      api.close(null, "tab");
      (next ?? anchor).focus({ preventScroll: false });
    }
    /* Focus that leaves for the page (not the anchor, not a layer opened
       from inside) closes it, without pulling focus back. */
    function onFocusOut(e) {
      if (closed || !e.relatedTarget) return;
      requestAnimationFrame(() => {
        if (closed) return;
        const to = document.activeElement;
        if (!to || to === document.body || wrap.contains(to) || anchor.contains(to)) return;
        const i = stack.findIndex((L) => L.el === wrap);
        if (i >= 0 && stack.slice(i + 1).some((L) => L.el?.contains(to))) return;
        api.close(null, "blur");
      });
    }
    window.addEventListener("keydown", onTab, true);
    wrap.addEventListener("focusout", onFocusOut);
    if (o.focus !== false)
      requestAnimationFrame(() => {
        const target =
          (typeof o.initialFocus === "string" ? $(o.initialFocus, wrap) : o.initialFocus) ??
          focusables(wrap)[0] ??
          wrap;
        target.focus({ preventScroll: true });
      });
    return api;
  }

  /* ======================================================== toast */
  function toastHost() {
    const win = $("#app-window");
    let el = win ? $(":scope > .toasts", win) : $("body > .toasts");
    if (!el) {
      el = h("div", "toasts");
      el.setAttribute("role", "status");
      el.setAttribute("aria-live", "polite");
      (win ?? document.body).append(el);
    }
    return el;
  }
  function toast(text, o = {}) {
    const host = toastHost();
    const el = h(
      "div",
      "toast surface",
      `${o.tone ? `<span class="dot" data-tone="${esc(o.tone)}"></span>` : ""}<span class="toast-text">${esc(text)}</span>`,
    );
    if (o.action) {
      const b = h("button", "btn ghost xs", esc(o.action.label));
      b.type = "button";
      b.addEventListener("click", () => {
        o.action.run?.();
        close();
      });
      el.append(b);
    }
    host.append(el);
    const items = $$(":scope > .toast:not(.leaving)", host);
    for (const old of items.slice(0, Math.max(0, items.length - 3))) old._close?.();
    if (motionOn())
      el.animate(
        [
          { opacity: 0, translate: "0 10px", scale: "0.98" },
          { opacity: 1, translate: "0 0", scale: "1" },
        ],
        { duration: 340, easing: EASE },
      );
    let timer = 0;
    const arm = () => (timer = setTimeout(close, o.duration ?? 4200));
    el.addEventListener("pointerenter", () => clearTimeout(timer));
    el.addEventListener("pointerleave", arm);
    arm();
    let closing = false;
    function close() {
      if (closing) return;
      closing = true;
      clearTimeout(timer);
      el.classList.add("leaving");
      if (!motionOn()) return el.remove();
      el.animate(
        [
          { opacity: 1, translate: "0 0" },
          { opacity: 0, translate: "0 6px" },
        ],
        { duration: 200, easing: "ease-in", fill: "forwards" },
      ).finished.then(
        () => el.remove(),
        () => el.remove(),
      );
    }
    el._close = close;
    return { close, el };
  }

  /* ======================================================== tooltips */
  const Tip = (() => {
    const el = h("div", "tip");
    el.setAttribute("role", "tooltip");
    const mount = () => document.body.append(el);
    if (document.body) mount();
    else document.addEventListener("DOMContentLoaded", mount);
    let target = null;
    let timer = 0;
    const place = (t) => {
      const r = t.getBoundingClientRect();
      el.textContent = t.dataset.tip;
      const w = el.offsetWidth;
      const ht = el.offsetHeight;
      el.style.left = `${clamp(r.left + r.width / 2 - w / 2, 6, innerWidth - w - 6)}px`;
      el.style.top = `${r.top - ht - 8 < 6 ? r.bottom + 8 : r.top - ht - 8}px`;
    };
    const show = (t, delay) => {
      target = t;
      clearTimeout(timer);
      if (!t || !t.dataset.tip) return el.classList.remove("on");
      timer = setTimeout(() => {
        if (!t.isConnected) return;
        place(t);
        el.classList.add("on");
      }, delay);
    };
    document.addEventListener("pointerover", (e) => {
      const t = e.target.closest?.("[data-tip]");
      if (t === target) return;
      show(t, el.classList.contains("on") ? 0 : 380);
    });
    document.addEventListener("focusin", (e) => {
      const t = e.target.closest?.("[data-tip]");
      if (t && e.target.matches(":focus-visible")) show(t, 380);
      else if (target) show(null, 0);
    });
    document.addEventListener("pointerdown", () => {
      clearTimeout(timer);
      el.classList.remove("on");
    });
    return {
      hide: () => {
        clearTimeout(timer);
        el.classList.remove("on");
        target = null;
      },
    };
  })();

  /* ======================================================== marks */
  function providerMark(instanceId) {
    const p = q.provider(instanceId);
    const driver = p?.driver ?? instanceId;
    return `<span class="prov" data-tip="${esc(p?.name ?? instanceId)}">${PROV_SVG[driver] ?? ""}</span>`;
  }
  const deviceIcon = (id) => ic(q.device(id)?.icon ?? "laptop");

  const Lab = {
    q,
    LIMITS,
    RUN_STATUS,
    SCHEDULE_STATE,
    RUNTIME_MODES,
    ENV_MODES,
    statusDot,
    statusLabel,
    layers,
    trapFocus,
    flip,
    onEvent,
    units: { MIN, HOUR, DAY, WEEK },
    tick,
    advance,
    startSim,
    reset,
    setMotion,
    setSpeed(n) {
      S.speed = n === 60 ? 60 : 1;
      emit();
    },
    setPlaying(on) {
      S.playing = !!on;
      emit();
    },
  };

  return {
    Lab,
    motionOn,
    fmt,
    sched,
    act,
    morph,
    plate,
    settle,
    popover,
    toast,
    Tip,
    providerMark,
    deviceIcon,
    statusTone,
  };
})();
