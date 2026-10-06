/* ============================================================
   B · Agenda — the automations page organised by time.

   One 52px bar (zoom, pager, project filter, New schedule), one quiet
   always-mounted approvals line, then a timeline: x = time, one lane
   per schedule grouped by device. Occurrences are instants (ticks);
   shape says what happened, colour only what went wrong. The due
   approval sits on the live now-line as a neutral ring that drains
   (amber only in its last two minutes). Editing happens in a right
   sheet whose column is committed at once while the marks FLIP; the
   draft is drawn live as a ghost lane, and Save turns that ghost into
   the proposal sub-row.

   Geometry: every positioned thing reads two registered custom
   properties on the root, --ag-t0 / --ag-span (hours), plus its own
   --t / --a / --b (hours since BASE). Zoom and paging interpolate the
   two root numbers per frame (never scaleX); the now-line and the
   due marks read --ag-now, so the sim tick moves them with no JS
   layout work.
   ============================================================ */
(() => {
  const { MIN, HOUR, DAY } = Lab.units;
  const q = Lab.q;
  const BASE = new Date(2026, 8, 1).getTime();
  const H = (ms) => Math.round(((ms - BASE) / HOUR) * 1e4) / 1e4;
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const MONL = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];
  const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const WDL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const pad = (n) => String(n).padStart(2, "0");
  const midnight = (ms) => {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };
  const addDays = (ms, n) => {
    const d = new Date(ms);
    d.setDate(d.getDate() + n);
    return d.getTime();
  };
  const SHEET_W = 468;
  const ZOOM_MS = 360;
  const DENSE_PX = 6;

  /* Register the animated geometry so calc() can divide by it. */
  for (const [name, init] of [
    ["--ag-t0", "0"],
    ["--ag-span", "192"],
  ]) {
    try {
      CSS.registerProperty({ name, syntax: "<number>", inherits: true, initialValue: init });
    } catch {}
  }

  /* cubic-bezier(.16,1,.3,1) for the per-frame zoom interpolation. */
  function bezier(x1, y1, x2, y2) {
    const cx = 3 * x1;
    const bx = 3 * (x2 - x1) - cx;
    const ax = 1 - cx - bx;
    const cy = 3 * y1;
    const by = 3 * (y2 - y1) - cy;
    const ay = 1 - cy - by;
    const sx = (t) => ((ax * t + bx) * t + cx) * t;
    const sy = (t) => ((ay * t + by) * t + cy) * t;
    const dsx = (t) => (3 * ax * t + 2 * bx) * t + cx;
    return (x) => {
      let t = x;
      for (let i = 0; i < 8; i++) {
        const d = sx(t) - x;
        if (Math.abs(d) < 1e-5) break;
        const dd = dsx(t);
        if (Math.abs(dd) < 1e-6) break;
        t -= d / dd;
      }
      return sy(clamp(t, 0, 1));
    };
  }
  const easeOut = bezier(0.16, 1, 0.3, 1);

  const ringSvg = (cls = "") =>
    `<svg class="ag-ring ${cls}" viewBox="0 0 20 20" aria-hidden="true"><circle class="ag-ring-track" cx="10" cy="10" r="7" pathLength="100"/><circle class="ag-ring-arc" cx="10" cy="10" r="7" pathLength="100"/></svg>`;
  /* Waiting is neutral; only the last two minutes (the m:ss phase) turn amber. */
  const URGENT_MS = 2 * MIN;
  const leftText = (ms) => (ms >= URGENT_MS ? `${Math.ceil(ms / MIN)}m` : fmt.countdown(ms));
  const leftWords = (ms) => {
    const m = Math.ceil(ms / MIN);
    return m <= 1 ? "less than a minute" : `${m} minutes`;
  };
  /* "10:51" today, "tomorrow 03:00", else "Wed 03:00" — short, for one-line summaries. */
  const whenShort = (ms) => {
    const n = Math.round((midnight(ms) - midnight(S.now)) / DAY);
    const t = `${pad(new Date(ms).getHours())}:${pad(new Date(ms).getMinutes())}`;
    if (n === 0) return t;
    if (n === 1) return `tomorrow ${t}`;
    if (n > 1 && n < 7) return `${WD[new Date(ms).getDay()]} ${t}`;
    return `${MON[new Date(ms).getMonth()]} ${new Date(ms).getDate()}, ${t}`;
  };
  /* A run sits where it materialized: on time it is its occurrence; a
     retry or a coalesced run asked later. Timeline, tooltip and popover
     all use this one time. */
  const askedAt = (run) => Math.max(run.scheduledFor, run.createdAt ?? run.scheduledFor);
  const projName = (id) => q.project(id)?.name ?? id;
  const devName = (id) => q.device(id)?.name ?? id;
  const isTyping = (el) =>
    !!el &&
    (el.matches?.("input, textarea, select, [contenteditable='true'], [role='spinbutton']") ??
      false);
  const KIND_NAME = {
    create: "New schedule",
    edit: "Edit",
    pause: "Pause",
    resume: "Resume",
    cancel: "Cancel schedule",
  };

  function consequence(execution, deviceId) {
    const where =
      execution.envMode === "worktree"
        ? `new worktree off ${execution.baseRef ?? "main"}`
        : "main checkout";
    return `Starts a thread · ${where} · ${devName(deviceId)}`;
  }

  /* Where a rule goes, without the words both share:
     "Every 7 days from Fri 16:00" → "…Fri 17:30" = "17:30";
     "Every 1 h" → "Every 2 h" = "every 2 h". */
  function cadenceTo(cb, ca) {
    const wa = ca.split(" ");
    const wb = cb.split(" ");
    let i = 0;
    while (i < wa.length - 1 && wa[i] === wb[i]) i++;
    const rest = wa.slice(i).join(" ");
    return i === 0 ? ca : i === 1 && wa[0] === "Every" ? `every ${rest}` : rest;
  }

  /* "Every 7 days from Fri 16:00 → 17:30 · prompt edited" — changed fields only. */
  function diffText(p) {
    const a = p.after;
    const b = p.before;
    if (p.kind === "create") return "a new schedule";
    if (p.kind === "cancel") return "no runs after you approve";
    if (p.kind === "pause") {
      const n = q.automation(p.automationId)?.nextRunAt;
      return n ? `still runs ${sched.relative(n)} unless approved` : "stops future runs";
    }
    if (p.kind === "resume") return `${sched.label(a.schedule)} from approval`;
    const out = [];
    const ea = a.execution;
    const eb = b?.execution ?? {};
    if (ea.title !== eb.title) out.push(`renamed “${ea.title}”`);
    const ca = sched.cadence(a.schedule);
    const cb = b ? sched.cadence(b.schedule) : "";
    if (ca !== cb) out.push(cb ? `${cb} → ${cadenceTo(cb, ca)}` : ca);
    if (
      a.schedule.kind !== "once" &&
      b?.schedule.kind !== "once" &&
      a.schedule.endsAt !== b?.schedule.endsAt
    )
      out.push(`until ${fmt.date(a.schedule.endsAt)}`);
    if (ea.prompt !== eb.prompt) out.push("prompt edited");
    if (
      fmt.model(ea.modelSelection, { effort: true }) !==
      fmt.model(eb.modelSelection, { effort: true })
    )
      out.push(fmt.model(ea.modelSelection, { effort: true }));
    if (ea.runtimeMode !== eb.runtimeMode) out.push(fmt.runtimeMode(ea.runtimeMode));
    if (ea.envMode !== eb.envMode || (ea.baseRef ?? null) !== (eb.baseRef ?? null))
      out.push(
        ea.envMode === "worktree" ? `worktree off ${ea.baseRef ?? "main"}` : "main checkout",
      );
    return out.join(" · ") || "no visible changes";
  }

  /* The sub-row's compact diff: the lane's meta line already states the
     current rule, so the row only says where it goes ("→ Fri 17:30"). */
  function shortDiff(p) {
    if (p.kind === "create") return "";
    if (p.kind === "cancel") return "no runs after approval";
    if (p.kind === "pause") {
      const n = q.automation(p.automationId)?.nextRunAt;
      return n ? `still runs ${whenShort(n)}` : "stops future runs";
    }
    if (p.kind === "resume") return sched.cadence(p.after.schedule);
    const a = p.after;
    const b = p.before;
    const ea = a.execution;
    const eb = b?.execution ?? {};
    const out = [];
    const ca = sched.cadence(a.schedule);
    const cb = b ? sched.cadence(b.schedule) : "";
    if (ca !== cb) out.push(`→ ${cb ? cadenceTo(cb, ca) : ca}`);
    if (
      a.schedule.kind !== "once" &&
      b?.schedule.kind !== "once" &&
      a.schedule.endsAt !== b?.schedule.endsAt
    )
      out.push(`until ${fmt.date(a.schedule.endsAt)}`);
    if (ea.title !== eb.title) out.push("renamed");
    if (ea.prompt !== eb.prompt) out.push("prompt");
    if (
      fmt.model(ea.modelSelection, { effort: true }) !==
      fmt.model(eb.modelSelection, { effort: true })
    )
      out.push(fmt.model(ea.modelSelection, { effort: true }));
    if (ea.runtimeMode !== eb.runtimeMode) out.push(fmt.runtimeMode(ea.runtimeMode));
    if (ea.envMode !== eb.envMode || (ea.baseRef ?? null) !== (eb.baseRef ?? null))
      out.push(ea.envMode === "worktree" ? `off ${ea.baseRef ?? "main"}` : "main checkout");
    return out.join(" · ");
  }

  DIRS.B = {
    title: "Agenda",
    thesis:
      "The automations page organised by time: a week of lanes, one per schedule, with a live now-line, the due approval pulsing on it, and an editor sheet whose draft is drawn on the timeline as you type.",
    notes: [
      [
        "Why",
        [
          "Schedules are about <b>when</b>. Lanes make the shape of a week legible at a glance: what ran, what failed, what is about to ask you, where the gaps are.",
          "Ticks are instants, not blocks: an agent's runtime is not a schedule fact. Shape carries meaning — filled = dispatched (quiet grey: the outcome lives in the thread), × = failed (the only red), hollow ring = expired/rejected, outline = proposed. Waiting is a neutral ring on the now-line that drains; it turns amber only in the last two minutes.",
          "The now column is where approvals live; the strip above is one line that never moves the page: “2 runs waiting · next expires 10:51 · 9m”. It opens the soonest one, and <kbd>J</kbd> steps through the rest — Approve run always sits next to what it will start.",
          "Dense intervals (every 30 min, hourly at week zoom) become one dotted band with a count instead of hundreds of overlapping ticks. Day zoom splits them back out.",
          "Every proposal is a 28px sub-row under its schedule: the change and its Approve sit together (“Edit → 17:30 · prompt · 9m”), the proposed ticks are outlined at their real times, and the live rule stays solid. Nothing pretends to have applied.",
        ],
      ],
      [
        "Motion",
        [
          "Day ↔ week interpolates the time axis per frame (360 ms, .16,1,.3,1); marks re-position, labels cross-fade. Paging slides the same way.",
          "The sheet takes its column in one layout; the marks FLIP to their new x (transform only) while the panel slides in over it, so the timeline is compressed, never covered. Changing the interval or start slides the ghost ticks; held keys reposition instantly.",
          "Save turns the ghost lane into the proposal sub-row in place and focuses its Approve. Popovers grow out of the tick and fold back into it; a run keeps one node for its whole life, so approve / expiry change the popover in place and focus never falls to the page.",
          "The sim tick only moves the now-line and countdown text — no layout shifts, no re-inserted nodes, no restarted pulses. Reduced motion keeps every state, without movement.",
        ],
      ],
      [
        "Keyboard",
        [
          "<kbd>D</kbd> / <kbd>W</kbd> zoom · <kbd>[</kbd> <kbd>]</kbd> page · <kbd>T</kbd> today · <kbd>N</kbd> new schedule · <kbd>J</kbd> next waiting run (<kbd>K</kbd> back, inside its popover).",
          "The timeline is one tab stop: <kbd>←</kbd><kbd>→</kbd> between marks in a lane, <kbd>↑</kbd><kbd>↓</kbd> between lanes, <kbd>Home</kbd>/<kbd>End</kbd>, <kbd>↵</kbd> opens, <kbd>E</kbd> edits the lane, <kbd>U</kbd> toggles unread.",
          "<kbd>esc</kbd> closes the topmost layer (picker → popover → sheet); focus returns to what opened it.",
        ],
      ],
      [
        "Trade-offs",
        [
          "A timeline is weaker at reading a schedule's full definition — the sheet is where the sentence lives. Long prompts never appear on the page; the mark key is one popover (Key, by the timezone) instead of a footer band.",
          "At week zoom (~6 px/h) marks within a few minutes of now still sit close together; real runs draw above future ticks so the one you see is the one you hit, and day zoom pulls them apart.",
          "Past occurrences without a run (before a schedule existed) are not drawn; only real runs have a past.",
          "The week view shows yesterday for context, so paging steps 7 days over an 8-day window.",
        ],
      ],
    ],

    mount(host, api) {
      /* ======================================================== state */
      const st = {
        zoom: "week",
        page: { week: 0, day: 0 },
        projectId: null,
        view: null, // { a, b } applied target window
        range: null, // { a, b } window marks are rendered for
        spans: [192, 192], // [from, to] span hours of the running transition
        anim: 0,
        pw: 1000,
        sheet: null,
        pop: null,
        rove: null,
        adopt: null,
        today: 0,
        axisKey: "",
        laneSig: new Map(),
        defSig: new Map(),
        structure: "",
        first: true,
        lastMinute: -1,
      };
      const offs = [];

      /* ======================================================== skeleton */
      const root = h("div", "ag");
      root.dataset.zoom = st.zoom;
      root.innerHTML = `
        <header class="ag-bar">
          <h2 class="ag-h">Automations</h2>
          <div class="seg ag-zoom" role="radiogroup" aria-label="Zoom">
            <button class="seg-opt" type="button" role="radio" data-zoom="day" data-tip="Day · D">Day</button>
            <button class="seg-opt" type="button" role="radio" data-zoom="week" data-tip="Week · W">Week</button>
          </div>
          <div class="ag-pager">
            <button class="btn ghost sm icon" type="button" data-page="-1" aria-label="Earlier" data-tip="Earlier · [">${ic("chevL")}</button>
            <button class="btn ghost sm" type="button" data-today data-tip="Back to now · T">Today</button>
            <button class="btn ghost sm icon" type="button" data-page="1" aria-label="Later" data-tip="Later · ]">${ic("chevR")}</button>
          </div>
          <span class="ag-range tnum" aria-live="polite"></span>
          <span class="ag-sp"></span>
          <span class="ag-cap tnum" hidden></span>
          <button class="btn ghost sm ag-filter" type="button" aria-haspopup="listbox"></button>
          <button class="btn primary sm ag-new" type="button" data-new data-tip="New schedule · N">${ic("plus")}New schedule</button>
        </header>
        <div class="ag-body">
          <div class="ag-main">
            <div class="ag-due" role="region" aria-label="Approvals">
              <button class="ag-due-sum" type="button">${ringSvg("sm")}<span class="ag-due-t"></span></button>
              <span class="ag-sp"></span>
              <button class="ag-due-chg" type="button" hidden></button>
            </div>
            <div class="ag-scroll">
              <div class="ag-axis">
                <div class="ag-corner"><span class="ag-tz">${ic("clock")}${esc(fmt.tz())}</span><button class="btn ghost xs ag-key" type="button" aria-haspopup="dialog" data-tip="What the marks mean">Key</button></div>
                <div class="ag-axplot" aria-hidden="true">
                  <div class="ag-days"></div>
                  <div class="ag-hours"></div>
                  <div class="ag-dstms"></div>
                  <div class="ag-nowflag tnum"></div>
                </div>
              </div>
              <div class="ag-canvas">
                <div class="ag-under" aria-hidden="true">
                  <div class="ag-grid"></div>
                  <div class="ag-past"></div>
                  <div class="ag-nowline"></div>
                </div>
                <div class="ag-rows" role="group" aria-label="Schedules on the timeline"></div>
                <div class="ag-empty" hidden></div>
              </div>
            </div>
          </div>
          <aside class="ag-sheet" aria-label="Schedule editor" inert><div class="ag-sheet-in"></div></aside>
        </div>
        <div class="sr-only" aria-live="polite" data-say></div>`;
      host.append(root);
      const $r = (sel) => root.querySelector(sel);
      const el = {
        zoom: $r(".ag-zoom"),
        range: $r(".ag-range"),
        filter: $r(".ag-filter"),
        cap: $r(".ag-cap"),
        newBtn: $r(".ag-new"),
        due: $r(".ag-due"),
        dueSum: $r(".ag-due-sum"),
        dueT: $r(".ag-due-t"),
        dueChg: $r(".ag-due-chg"),
        key: $r(".ag-key"),
        say: $r("[data-say]"),
        scroll: $r(".ag-scroll"),
        axplot: $r(".ag-axplot"),
        days: $r(".ag-days"),
        hours: $r(".ag-hours"),
        dsts: $r(".ag-dstms"),
        nowflag: $r(".ag-nowflag"),
        grid: $r(".ag-grid"),
        rows: $r(".ag-rows"),
        empty: $r(".ag-empty"),
        body: $r(".ag-body"),
        sheet: $r(".ag-sheet"),
        sheetIn: $r(".ag-sheet-in"),
      };
      const zoomPlate = plate(el.zoom);

      /* ======================================================== view */
      function windowOf(zoom, page) {
        const today = midnight(S.now);
        if (zoom === "day") {
          const a = addDays(today, page);
          return { a, b: addDays(a, 1) };
        }
        const a = addDays(today, -1 + 7 * page);
        return { a, b: addDays(a, 8) };
      }
      const spanH = (w) => (w.b - w.a) / HOUR;
      function applyVars(a, span) {
        root.style.setProperty("--ag-t0", String(H(a)));
        root.style.setProperty("--ag-span", String(Math.round(span * 1e4) / 1e4));
      }
      function setView(next, o = {}) {
        const from = st.view;
        st.view = next;
        cancelAnimationFrame(st.anim);
        st.anim = 0;
        const animate = o.animate && from && motionOn();
        st.spans = [from ? spanH(from) : spanH(next), spanH(next)];
        st.range = animate
          ? { a: Math.min(from.a, next.a), b: Math.max(from.b, next.b) }
          : { a: next.a, b: next.b };
        // A tooltip pinned to a mark's old x would float over another lane.
        Tip.hide();
        paintRange();
        paintHourStep();
        renderAxis();
        render({ force: true });
        if (!animate) {
          applyVars(next.a, spanH(next));
          paintNear();
          st.pop?.api.reposition();
          return;
        }
        const t0 = performance.now();
        const fa = from.a;
        const fb = from.b;
        const step = (now) => {
          const p = clamp((now - t0) / ZOOM_MS, 0, 1);
          const e = easeOut(p);
          const a = fa + (next.a - fa) * e;
          const b = fb + (next.b - fb) * e;
          applyVars(a, (b - a) / HOUR);
          if (p < 1) st.anim = requestAnimationFrame(step);
          else {
            st.anim = 0;
            st.spans = [spanH(next), spanH(next)];
            st.range = { a: next.a, b: next.b };
            renderAxis();
            render({ force: true });
            paintNear();
            st.pop?.api.reposition();
          }
        };
        st.anim = requestAnimationFrame(step);
      }
      function paintRange() {
        const { a, b } = st.view;
        if (st.zoom === "day") {
          const d = new Date(a);
          const rel = dayRel(a);
          el.range.textContent = `${WD[d.getDay()]}, ${MON[d.getMonth()]} ${d.getDate()}${rel ? ` · ${rel}` : ""}`;
        } else {
          const da = new Date(a);
          const db = new Date(b - 1);
          el.range.textContent =
            da.getMonth() === db.getMonth()
              ? `${MON[da.getMonth()]} ${da.getDate()} – ${db.getDate()}`
              : `${MON[da.getMonth()]} ${da.getDate()} – ${MON[db.getMonth()]} ${db.getDate()}`;
        }
      }
      function dayRel(d) {
        const n = Math.round((midnight(d) - midnight(S.now)) / DAY);
        return n === 0 ? "Today" : n === 1 ? "Tomorrow" : n === -1 ? "Yesterday" : "";
      }
      function setZoom(z, o = {}) {
        if (z === st.zoom) return;
        const prev = st.zoom;
        // Keep the same stretch of time in view: week→day lands on the
        // focused mark's day, else today (or the first day of the page).
        if (z === "day") {
          const focusT = document.activeElement?.closest?.(".ag-plot")
            ? document.activeElement._t
            : null;
          let anchor = Number.isFinite(focusT) ? focusT : null;
          if (anchor == null) {
            const w = windowOf("week", st.page.week);
            anchor = S.now >= w.a && S.now < w.b ? S.now : addDays(w.a, 1);
          }
          st.page.day = Math.round((midnight(anchor) - midnight(S.now)) / DAY);
        } else {
          st.page.week = Math.floor((st.page.day + 1) / 7);
        }
        st.zoom = z;
        root.dataset.zoom = z;
        for (const b of el.zoom.querySelectorAll("[data-zoom]")) {
          const on = b.dataset.zoom === z;
          b.setAttribute("aria-checked", String(on));
          b.tabIndex = on ? 0 : -1;
        }
        setView(windowOf(z, st.page[z]), { animate: o.animate !== false && prev !== z });
      }
      function page(d) {
        st.page[st.zoom] += d;
        setView(windowOf(st.zoom, st.page[st.zoom]), { animate: true });
      }
      function toToday() {
        if (st.page[st.zoom] === 0) return;
        st.page[st.zoom] = 0;
        setView(windowOf(st.zoom, 0), { animate: true });
      }

      el.zoom.addEventListener("click", (e) => {
        const b = e.target.closest("[data-zoom]");
        if (b) setZoom(b.dataset.zoom);
      });
      el.zoom.addEventListener("keydown", (e) => {
        if (!["ArrowLeft", "ArrowRight"].includes(e.key)) return;
        e.preventDefault();
        setZoom(st.zoom === "day" ? "week" : "day");
        el.zoom.querySelector(`[data-zoom="${st.zoom}"]`).focus();
      });
      $r(".ag-pager").addEventListener("click", (e) => {
        const b = e.target.closest("button");
        if (!b) return;
        if (b.hasAttribute("data-today")) toToday();
        else page(Number(b.dataset.page));
      });

      /* Plot width drives band density and hour-label step. */
      const ro = new ResizeObserver(() => {
        const w = el.axplot.clientWidth;
        if (!w || Math.abs(w - st.pw) < 1) return;
        st.pw = w;
        paintHourStep();
        render();
        paintNear();
      });
      ro.observe(el.axplot);
      const pph = (spanHours) => st.pw / spanHours;
      function paintHourStep() {
        const p = pph(spanH(st.view));
        const step =
          st.zoom === "week" ? (p * 6 >= 30 ? 6 : 12) : p >= 34 ? 1 : p >= 17 ? 2 : p >= 12 ? 3 : 6;
        root.dataset.hstep = String(step);
      }

      /* ======================================================== axis */
      function renderAxis() {
        const { a, b } = st.range;
        const key = `${a}|${b}|${midnight(S.now)}`;
        if (key === st.axisKey) return;
        st.axisKey = key;
        const days = [];
        for (let d = midnight(a); d < b; d = addDays(d, 1)) days.push(d);
        syncKeyed(
          el.days,
          days.map((d) => ({ key: String(d), d })),
          () => h("span", "ag-day", '<span class="ag-day-w"></span>'),
          (node, { d }) => {
            const e = addDays(d, 1);
            node.style.setProperty("--a", H(d));
            node.style.setProperty("--b", H(e));
            const dt = new Date(d);
            const rel = dayRel(d);
            node.dataset.today = String(rel === "Today");
            node.firstChild.textContent =
              rel === "Today" ? "Today" : `${WD[dt.getDay()]} ${dt.getDate()}`;
          },
        );
        const hours = [];
        const dsts = [];
        let prevOff = new Date(midnight(a)).getTimezoneOffset();
        for (let t = midnight(a); t < b; t += HOUR) {
          const off = new Date(t).getTimezoneOffset();
          if (off !== prevOff) dsts.push({ key: String(t), t, back: off > prevOff });
          prevOff = off;
          hours.push({ key: String(t), t, hr: new Date(t).getHours() });
        }
        const hourCls = (hr) =>
          `${hr === 0 ? "is-day " : ""}${hr % 2 ? "" : "d2 "}${hr % 3 ? "" : "d3 "}${hr % 6 ? "" : "d6 "}${hr % 12 ? "" : "d12"}`;
        syncKeyed(
          el.hours,
          hours,
          () => h("span", "ag-hr"),
          (node, { t, hr }) => {
            node.className = `ag-hr ${hourCls(hr)}`;
            node.style.setProperty("--t", H(t));
            node.textContent = pad(hr);
          },
        );
        syncKeyed(
          el.grid,
          hours,
          () => h("i", "ag-gl"),
          (node, { t, hr }) => {
            node.className = `ag-gl ${hr === 0 ? "is-day" : hr % 6 === 0 ? "is-6" : "is-h"}`;
            node.style.setProperty("--t", H(t));
          },
        );
        syncKeyed(
          el.dsts,
          dsts,
          () => h("span", "ag-dstm"),
          (node, { t, back }) => {
            node.style.setProperty("--t", H(t));
            node.textContent = back ? "Clocks go back" : "Clocks go forward";
            node.dataset.tip = back
              ? `Clocks go back an hour on ${fmt.day(t)}. Intervals are elapsed time, so a daily 03:00 run lands at 02:00 from then on.`
              : `Clocks go forward an hour on ${fmt.day(t)}. Intervals are elapsed time, so a daily 03:00 run lands at 04:00 from then on.`;
          },
        );
      }

      /* Keyed reconciliation: reuse nodes by data-k, add, patch, order, exit. */
      function syncKeyed(parent, items, make, patch, o = {}) {
        const existing = new Map();
        for (const node of parent.children)
          if (node.dataset.k != null && !node.classList.contains("is-leaving"))
            existing.set(node.dataset.k, node);
        const keep = new Set();
        const created = [];
        let prev = null;
        for (const it of items) {
          let node = existing.get(it.key);
          if (node && o.compatible && !o.compatible(node, it)) {
            existing.delete(it.key);
            if (o.exit) o.exit(node);
            else node.remove();
            node = null;
          }
          if (!node) {
            node = make(it);
            node.dataset.k = it.key;
            created.push(node);
          }
          patch(node, it);
          keep.add(it.key);
          if (o.ordered) {
            // Leaving siblings are still in the DOM while they animate out;
            // skip them, or every kept node after one gets re-inserted —
            // which blurs focus and restarts its CSS animations.
            let want = prev ? prev.nextElementSibling : parent.firstElementChild;
            while (want && want !== node && want.classList.contains("is-leaving"))
              want = want.nextElementSibling;
            if (node !== want) moveNode(parent, node, want);
          } else if (!node.parentNode) parent.append(node);
          prev = node;
        }
        for (const [k, node] of existing) {
          if (keep.has(k)) continue;
          if (o.exit) o.exit(node);
          else node.remove();
        }
        return created;
      }
      /* A real reorder keeps focus and animation state where the platform
         allows it (moveBefore); a new node is a plain insert. */
      function moveNode(parent, node, before) {
        if (node.parentNode === parent && typeof parent.moveBefore === "function") {
          try {
            parent.moveBefore(node, before);
            return;
          } catch {}
        }
        parent.insertBefore(node, before);
      }

      /* ======================================================== model */
      function lanesModel() {
        const rows = q.schedules({ projectId: st.projectId ?? undefined });
        rows.sort(
          (x, y) =>
            projName(x.projectId).localeCompare(projName(y.projectId)) ||
            x.title.localeCompare(y.title),
        );
        const sh = st.sheet;
        const out = [];
        for (const dev of S.devices) {
          const lanes = rows.filter((r) => r.deviceId === dev.id);
          const draftHere =
            sh &&
            !sh.id &&
            sh.deviceId === dev.id &&
            (!st.projectId || st.projectId === sh.projectId);
          if (!lanes.length && !draftHere) continue;
          out.push({ kind: "group", key: `g:${dev.id}`, dev, count: lanes.length });
          if (draftHere) out.push({ kind: "draft", key: "draft", dev });
          for (const r of lanes) {
            out.push({ kind: "lane", key: r.id, row: r, dev });
            if (sh && sh.id === r.id) out.push({ kind: "draftsub", key: `${r.id}:draft`, row: r });
            else if (r.proposal)
              out.push({ kind: "sub", key: `${r.id}:sub`, row: r, p: r.proposal });
          }
        }
        return out;
      }

      const isDense = (iv) => {
        const best = Math.max(pph(st.spans[0]), pph(st.spans[1]));
        return (iv / HOUR) * best < DENSE_PX;
      };

      /* Future/proposed/draft occurrences in range → ticks, or one band. */
      function occurrenceMarks(s, from, type, out, o = {}) {
        if (!s) return;
        const { a, b } = st.range;
        const occ = sched.occurrences(s, Math.max(from, a - HOUR), b + HOUR, 900);
        if (!occ.length) return;
        const dense = s.kind === "fixed-interval" && (isDense(s.intervalMs) || occ.length > 600);
        if (dense && occ.length > 2) {
          let i0 = 0;
          if (o.nextAt != null && occ[0] === o.nextAt) {
            out.push({ key: `f:${occ[0]}`, type, t: occ[0], s: "next", nav: type === "f" });
            i0 = 1;
          }
          out.push({
            key: `band:${type}`,
            type: "band",
            sub: type,
            a: occ[i0],
            b: occ[occ.length - 1],
            n: occ.length - i0,
            iv: s.intervalMs,
            nav: type !== "d",
          });
          return;
        }
        for (const t of occ)
          out.push({
            key: `f:${t}`,
            type,
            t,
            s: type === "f" && t === o.nextAt ? "next" : type,
            nav: type !== "d",
          });
      }

      function laneMarks(item) {
        const out = [];
        const { a, b } = st.range;
        if (item.kind === "lane") {
          const r = item.row;
          const A = r.automation;
          const s = r.def.schedule;
          if (A) {
            for (const run of q.runsFor(A.id)) {
              const c = run.coalescedOccurrences || 0;
              const iv = s.kind === "fixed-interval" ? s.intervalMs : 0;
              // One node per run for its whole life (key run:<id>): the due
              // ring on the now-line becomes the settled mark in place, so
              // focus and an open popover survive approve / reject / expiry.
              if (run.status === "pending-approval") {
                if (c > 0)
                  out.push({
                    key: `br:${run.id}`,
                    type: "br",
                    a: run.scheduledFor,
                    live: true,
                    n: c,
                    run,
                  });
                out.push({ key: `run:${run.id}`, type: "due", t: S.now, run, nav: true });
                continue;
              }
              const at = askedAt(run);
              if (at < a - HOUR || run.scheduledFor > b + HOUR) continue;
              if (c > 0 && iv && at > run.scheduledFor)
                out.push({
                  key: `br:${run.id}`,
                  type: "br",
                  a: run.scheduledFor,
                  b: at,
                  n: c,
                  run,
                });
              out.push({ key: `run:${run.id}`, type: "run", t: at, s: run.status, run, nav: true });
            }
            if (A.enabled && !A.cancelled && A.nextRunAt != null)
              occurrenceMarks(s, A.nextRunAt, "f", out, { nextAt: A.nextRunAt });
            if (!A.enabled && !A.cancelled) {
              const end = sched.last(s);
              if (end > S.now) out.push({ key: "hatch", type: "hatch", b: Math.min(end, b) });
            }
          } else occurrenceMarks(s, sched.first(s), "p", out);
          if (s.kind === "fixed-interval" && s.endsAt >= a && s.endsAt <= b && !(A && !A.enabled))
            out.push({ key: "end", type: "end", t: s.endsAt });
        } else if (item.kind === "sub") {
          const p = item.p;
          if ((p.kind === "edit" || p.kind === "resume") && p.after) {
            const s = p.after.schedule;
            occurrenceMarks(s, Math.max(sched.first(s), S.now), "p", out);
          }
        } else if (item.kind === "draft" || item.kind === "draftsub") {
          const s = sheetSchedule();
          if (s) {
            occurrenceMarks(s, Math.max(sched.first(s), S.now + 1), "d", out);
            // Nothing lands in this window: point at where the runs went.
            const inWin = out.some((m) => (m.t ?? m.a) >= st.view.a && (m.t ?? m.b) < st.view.b);
            if (!inWin) {
              const first = sched.occurrences(s, S.now + 1, Infinity, 1)[0];
              if (first != null && first >= st.view.b)
                out.push({ key: "edge", type: "edge", side: "r", t: first, nav: false });
              else if (first != null && sched.last(s) < st.view.a)
                out.push({ key: "edge", type: "edge", side: "l", t: first, nav: false });
            }
          }
        }
        return out;
      }

      /* ======================================================== lanes */
      function makeLane(it) {
        const lane = h("div", "ag-lane");
        lane.dataset.lane = "";
        lane.dataset.key = it.key;
        lane.dataset.kind = it.kind;
        if (it.kind === "group") {
          lane.className = "ag-group";
          lane.innerHTML = `<span class="ag-g-ic"></span><span class="ag-g-name"></span><span class="ag-g-n tnum"></span>`;
          return lane;
        }
        lane.setAttribute("role", "group");
        lane.innerHTML = `<div class="ag-lab"></div><div class="ag-plot"></div>`;
        const lab = lane.firstElementChild;
        if (it.kind === "lane" || it.kind === "draft") {
          lab.innerHTML = `<button class="ag-title" type="button" data-edit><span class="trunc"></span></button><span class="ag-side"></span><span class="ag-meta"></span>`;
        } else {
          lab.innerHTML = `<span class="ag-sub-k"></span><span class="ag-sub-d"></span><span class="ag-sub-left tnum"></span><span class="ag-sub-act"></span>`;
        }
        return lane;
      }

      /* Line 1: what + where ("Paused", the project when all are shown).
         Line 2: when — the rule, then its end, which never truncates
         (recurring schedules always end; that's the fact to keep). */
      function metaHtml(schedule) {
        const [rule, ...rest] = sched.label(schedule).split(" · ");
        return `<span class="ag-mr">${esc(rule)}</span>${rest.length ? `<span class="sep"> · </span><span class="ag-mu">${esc(rest.join(" · "))}</span>` : ""}`;
      }
      const sideHtml = (chip, projectId) =>
        `${chip ? `<span class="ag-chip">${chip}</span>` : ""}${!st.projectId && projectId ? `<span class="ag-proj">${esc(projName(projectId))}</span>` : ""}`;

      function patchLane(lane, it) {
        lane.dataset.kind = it.kind;
        if (it.kind === "group") {
          lane.querySelector(".ag-g-ic").innerHTML = deviceIcon(it.dev.id);
          lane.querySelector(".ag-g-name").textContent = it.dev.name;
          lane.querySelector(".ag-g-n").textContent = it.count ? String(it.count) : "";
          return;
        }
        const plot = lane.querySelector(".ag-plot");
        if (it.kind === "lane") {
          const r = it.row;
          const A = r.automation;
          lane.dataset.state = r.state;
          lane.toggleAttribute("data-pending", !A);
          const next =
            A && A.enabled && !A.cancelled && A.nextRunAt
              ? `, next run ${fmt.dateTime(A.nextRunAt)}`
              : "";
          lane.setAttribute(
            "aria-label",
            `${r.title}, ${sched.label(r.def.schedule)}${r.state === "paused" ? ", paused" : ""}${next}`,
          );
          setText(lane.querySelector(".ag-title .trunc"), r.title);
          lane.querySelector(".ag-title").setAttribute("aria-label", `Edit ${r.title}`);
          lane.querySelector(".ag-title").removeAttribute("data-empty");
          setHtml(
            lane.querySelector(".ag-side"),
            sideHtml(
              r.state === "paused" ? "Paused" : r.state === "finished" ? "Ended" : "",
              r.projectId,
            ),
          );
          setHtml(lane.querySelector(".ag-meta"), metaHtml(r.def.schedule));
        } else if (it.kind === "draft") {
          const sh = st.sheet;
          lane.dataset.state = "draft";
          const t = sh?.exec.title?.trim();
          setText(lane.querySelector(".ag-title .trunc"), t || "Untitled schedule");
          lane.querySelector(".ag-title").toggleAttribute("data-empty", !t);
          lane.querySelector(".ag-title").setAttribute("aria-label", "Back to the editor");
          setHtml(lane.querySelector(".ag-side"), sideHtml("Draft", sh?.projectId));
          const s = sheetSchedule();
          setHtml(
            lane.querySelector(".ag-meta"),
            s
              ? sh?.startInvalid
                ? '<span class="ag-mr">Showing the last valid start</span>'
                : metaHtml(s)
              : "",
          );
          lane.setAttribute("aria-label", "Draft schedule, not saved");
        } else if (it.kind === "sub") {
          const p = it.p;
          lane.dataset.state = "proposal";
          lane.dataset.p = p.id;
          const kind = KIND_NAME[p.kind] ?? "Change";
          setText(lane.querySelector(".ag-sub-k"), kind);
          const d = lane.querySelector(".ag-sub-d");
          setText(d, shortDiff(p));
          const full = p.kind === "create" ? sched.label(p.after.schedule) : diffText(p);
          d.dataset.tip = `Waiting for your approval · ${full}`;
          const act2 = lane.querySelector(".ag-sub-act");
          if (!act2.firstChild)
            act2.innerHTML = `<button class="btn xs" type="button" data-approve-p>Approve</button><button class="btn xs ghost icon" type="button" data-reject-p>${ic("x")}</button>`;
          const what = kind.toLowerCase();
          act2.firstChild.setAttribute("aria-label", `Approve ${what}: ${p.title}`);
          act2.lastChild.setAttribute("aria-label", `Reject ${what}: ${p.title}`);
          act2.lastChild.dataset.tip = `Reject ${what}`;
          lane.setAttribute(
            "aria-label",
            `${kind} of ${p.title}, waiting for your approval: ${full}`,
          );
          paintSubLive(lane, p);
        } else if (it.kind === "draftsub") {
          lane.dataset.state = "draft";
          setText(lane.querySelector(".ag-sub-k"), "Draft");
          setText(
            lane.querySelector(".ag-sub-d"),
            st.sheet?.startInvalid ? "not saved · last valid start" : "not saved",
          );
          delete lane.querySelector(".ag-sub-d").dataset.tip;
          setText(lane.querySelector(".ag-sub-left"), "");
          setHtml(lane.querySelector(".ag-sub-act"), "");
          lane.setAttribute("aria-label", "Draft of the edited schedule, not saved");
        }
        plot.dataset.lane = it.key;
      }
      /* A proposal's 15 minutes: coarse minutes, amber only in the m:ss phase. */
      function paintSubLive(lane, p) {
        const left = p.expiresAt - S.now;
        const n = lane.querySelector(".ag-sub-left");
        setText(n, left > 0 ? leftText(left) : "expired");
        n.toggleAttribute("data-urgent", left > 0 && left < URGENT_MS);
        n.dataset.tip = left > 0 ? `Expires ${fmt.time(p.expiresAt)} unless approved` : "Expired";
      }
      const setText = (node, t) => {
        if (node && node.textContent !== t) node.textContent = t;
      };
      const setHtml = (node, html) => {
        if (node && node._html !== html) {
          node._html = html;
          node.innerHTML = html;
        }
      };

      /* ---------- marks */
      function makeMark(m) {
        let node;
        if (m.type === "band") {
          node = h("button", "ag-band", '<span class="ag-band-n tnum"></span>');
          node.type = "button";
        } else if (m.type === "win") node = h("span", "ag-win");
        else if (m.type === "br") node = h("span", "ag-br", '<span class="ag-br-l"></span>');
        else if (m.type === "end") node = h("span", "ag-end", "<span></span>");
        else if (m.type === "hatch") node = h("span", "ag-hatch");
        else if (m.type === "d") node = h("span", "ag-m");
        else if (m.type === "edge") {
          node = h("button", "ag-edge");
          node.type = "button";
        } else {
          node = h("button", "ag-m");
          node.type = "button";
        }
        if (node.tagName === "BUTTON") node.tabIndex = -1;
        return node;
      }
      /* due ↔ run share a family: the same node changes shape in place. */
      const markFamily = (t) =>
        t === "d"
          ? "span-tick"
          : t === "due" || t === "run"
            ? "run"
            : t === "f" || t === "p"
              ? "btn-tick"
              : t;
      const isStarting = (s) => s === "approved" || s === "executing" || s === "materializing";
      function markLabel(m, laneTitle) {
        if (m.type === "due") {
          const left = m.run.expiresAt - S.now;
          return `${laneTitle}, waiting for approval, expires ${fmt.time(m.run.expiresAt)}, in ${leftWords(left)}${m.run.coalescedOccurrences ? `, ${m.run.coalescedOccurrences} missed runs → 1` : ""}`;
        }
        if (m.type === "band")
          return `${laneTitle}, every ${fmt.interval(m.iv)}, ${m.n} runs from ${fmt.dateTime(m.a)} to ${fmt.dateTime(m.b)}`;
        if (m.type === "run") {
          const c = m.run.coalescedOccurrences;
          return `${laneTitle}, ${fmt.dateTime(m.t)}, ${Lab.statusLabel(m.s)}${c ? `, covered ${c} missed runs` : ""}${m.run.unread ? ", unread" : ""}`;
        }
        if (m.type === "p") return `${laneTitle}, proposed run ${fmt.dateTime(m.t)}`;
        if (m.type === "edge") return `No runs in view. First run ${fmt.dateTime(m.t)}. Show it`;
        return `${laneTitle}, ${m.s === "next" ? "next run" : "scheduled"} ${fmt.dateTime(m.t)}`;
      }
      function patchMark(node, m, laneTitle) {
        node._m = m;
        node._title = laneTitle;
        node._t = m.type === "due" ? S.now : (m.t ?? m.a);
        node.dataset.type = m.type;
        if (m.s) node.dataset.s = m.s;
        else delete node.dataset.s;
        if (m.nav) node.dataset.nav = "";
        else delete node.dataset.nav;
        if (m.type === "due" || m.type === "run") {
          const shape = m.type === "due" ? "due" : isStarting(m.s) ? "start" : "tick";
          if (node._shape !== shape) {
            node._shape = shape;
            node.classList.toggle("ag-dm", shape === "due");
            node.innerHTML =
              shape === "due"
                ? `${ringSvg()}<span class="ag-dm-t tnum" aria-hidden="true"></span>`
                : shape === "start"
                  ? '<span class="ag-m-lab" aria-hidden="true">Starting</span>'
                  : "";
          }
        }
        if (m.t != null && m.type !== "due") node.style.setProperty("--t", H(m.t));
        if (m.type === "due") {
          node.style.setProperty("--t", "var(--ag-now)");
          paintDueMark(node);
        }
        if (m.type === "win") {
          node.style.setProperty("--a", H(m.a));
          node.style.setProperty("--b", H(m.b));
        }
        if (m.type === "br") {
          node.style.setProperty("--a", H(m.a));
          node.style.setProperty("--b", m.live ? "var(--ag-now)" : H(m.b));
          node.toggleAttribute("data-live", !!m.live);
          setText(node.firstChild, m.live ? `${m.n} missed → 1` : `${m.n} missed`);
        }
        if (m.type === "hatch") {
          node.style.setProperty("--a", "var(--ag-now)");
          node.style.setProperty("--b", H(m.b));
        }
        if (m.type === "band") {
          node.dataset.sub = m.sub;
          node.style.setProperty("--a", H(m.a));
          node.style.setProperty("--b", H(m.b));
          setText(node.firstChild, `${m.n} runs`);
        }
        if (m.type === "end") setText(node.firstChild, `ends ${fmt.date(m.t)}`);
        if (m.type === "edge") {
          node.dataset.side = m.side;
          setHtml(
            node,
            m.side === "r"
              ? `starts ${esc(fmt.weekday(m.t))} ${esc(fmt.date(m.t))}${ic("chevR")}`
              : `${ic("chevL")}starts ${esc(fmt.weekday(m.t))} ${esc(fmt.date(m.t))}`,
          );
        }
        node.toggleAttribute("data-unread", m.type === "run" && !!m.run.unread);
        if (node.tagName === "BUTTON") {
          node.setAttribute("aria-label", markLabel(m, laneTitle));
          node.dataset.tip =
            m.type === "due"
              ? `Waiting for approval · expires ${fmt.time(m.run.expiresAt)}`
              : m.type === "edge"
                ? `First run ${fmt.dateTime(m.t)} — show it`
                : tipFor(m, laneTitle);
        }
      }
      /* Per tick: drain the ring, count down, keep the name true to the minute. */
      function paintDueMark(n) {
        const r = n._m?.run;
        if (!r || n._m.type !== "due") return;
        n._t = S.now;
        const left = r.expiresAt - S.now;
        n.style.setProperty("--f", String(clamp(left / Lab.LIMITS.approvalTtlMs, 0, 1)));
        n.toggleAttribute("data-urgent", left < URGENT_MS);
        setText(n.querySelector(".ag-dm-t"), leftText(left));
        const label = markLabel(n._m, n._title ?? "");
        if (n.getAttribute("aria-label") !== label) n.setAttribute("aria-label", label);
      }
      function tipFor(m, title) {
        if (m.type === "band") return `${title} · every ${fmt.interval(m.iv)} · ${m.n} runs`;
        if (m.type === "run") {
          const c = m.run.coalescedOccurrences;
          return `${title} · ${fmt.dateTime(m.t)} · ${Lab.statusLabel(m.s)}${c ? ` · covered ${c} missed runs` : ""}`;
        }
        if (m.type === "p") return `${title} · proposed · ${fmt.dateTime(m.t)}`;
        return `${title} · ${m.s === "next" ? "next" : "scheduled"} · ${fmt.dateTime(m.t)}`;
      }

      function syncMarks(plot, marks, title, o = {}) {
        // A definition change slides the future ticks from their old
        // positions to the new ones (reuse nodes by order, re-key them).
        if (o.slide && motionOn()) {
          const isF = (k) => k.startsWith("f:");
          const olds = [...plot.children]
            .filter((n) => n.dataset.k && isF(n.dataset.k) && !n.classList.contains("is-leaving"))
            .sort((x, y) => x._t - y._t);
          const news = marks.filter((m) => isF(m.key)).sort((x, y) => x.t - y.t);
          const newKeys = new Set(news.map((m) => m.key));
          const taken = new Set();
          let j = 0;
          for (const n of olds) {
            if (newKeys.has(n.dataset.k)) {
              taken.add(n.dataset.k);
              continue;
            }
            while (
              j < news.length &&
              (taken.has(news[j].key) || olds.some((x) => x.dataset.k === news[j].key))
            )
              j++;
            if (j >= news.length) break;
            n.dataset.k = news[j].key;
            taken.add(news[j].key);
            j++;
          }
          plot.classList.add("is-sliding");
          clearTimeout(plot._slideT);
          plot._slideT = setTimeout(() => plot.classList.remove("is-sliding"), 240);
        }
        let refocusT = null;
        const created = syncKeyed(plot, marks, makeMark, (n, m) => patchMark(n, m, title), {
          compatible: (n, m) => markFamily(n._m?.type) === markFamily(m.type),
          exit: (n) => {
            if (n.contains(document.activeElement)) refocusT = n._t;
            if (!motionOn() || !o.fade) return n.remove();
            n.classList.add("is-leaving");
            n.animate([{ opacity: 1 }, { opacity: 0 }], {
              duration: 140,
              fill: "forwards",
            }).finished.then(
              () => n.remove(),
              () => n.remove(),
            );
          },
        });
        // The focused mark went away (a band split, a run left the window):
        // focus lands on the nearest mark of the same lane, never on <body>.
        if (refocusT != null) {
          const list = navMarks(plot);
          const to = list.length
            ? list.reduce(
                (best, n) => (Math.abs(n._t - refocusT) < Math.abs(best._t - refocusT) ? n : best),
                list[0],
              )
            : null;
          if (to) {
            setRove(to);
            to.focus({ preventScroll: true });
          } else
            plot
              .closest(".ag-lane")
              ?.querySelector(".ag-title, [data-approve-p]")
              ?.focus({ preventScroll: true });
        }
        if (o.fade && motionOn() && created.length && created.length < 60)
          for (const n of created)
            n.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 180, easing: "ease-out" });
      }

      /* ---------- render */
      function render(o = {}) {
        const model = lanesModel();
        const structure = model.map((m) => m.key).join(",");
        const structural = structure !== st.structure;
        const mutate = () => {
          syncKeyed(el.rows, model, makeLane, patchLane, {
            ordered: true,
            exit: exitLane,
            compatible: (n, it) => laneFamily(n.dataset.kind) === laneFamily(it.kind),
          });
        };
        if (st.adopt?.from) {
          // Save: the draft lane's node becomes the new proposal lane.
          const node = el.rows.querySelector(`[data-lane][data-k="${CSS.escape(st.adopt.from)}"]`);
          const to =
            st.adopt.to ??
            model.find(
              (m) =>
                !el.rows.querySelector(`[data-lane][data-k="${CSS.escape(m.key)}"]`) &&
                m.kind === "lane",
            )?.key;
          if (node && to) {
            node.dataset.k = to;
            node.dataset.key = to;
            st.adopt.landed = to;
          }
          st.adopt.from = null;
        }
        if (structural && !st.first)
          Lab.flip(el.rows, mutate, { selector: "[data-lane]", duration: 320 });
        else mutate();
        st.structure = structure;

        let navCount = 0;
        for (const it of model) {
          if (it.kind === "group") continue;
          const lane = el.rows.querySelector(`[data-lane][data-k="${CSS.escape(it.key)}"]`);
          if (!lane) continue;
          const plot = lane.querySelector(".ag-plot");
          const marks = laneMarks(it);
          navCount += marks.filter((m) => m.nav).length;
          const title =
            it.kind === "draft" || it.kind === "draftsub"
              ? "Draft"
              : (it.row?.title ?? it.p?.title ?? "");
          const sig = marks
            .map(
              (m) =>
                `${m.key}~${m.type}~${m.s ?? ""}~${m.type === "due" ? "" : (m.t ?? "")}~${m.a ?? ""}~${m.b ?? ""}~${m.n ?? ""}~${m.run?.unread ? 1 : 0}~${m.side ?? ""}`,
            )
            .join("|");
          const defSig =
            it.kind === "lane"
              ? `${it.row.automation?.revision ?? "p"}|${it.row.automation?.enabled}`
              : it.kind === "sub"
                ? it.p.id
                : `draft:${st.sheet?.rev ?? 0}`;
          const prevDef = st.defSig.get(it.key);
          const slide = !st.first && prevDef != null && prevDef !== defSig && !o.noSlide;
          st.defSig.set(it.key, defSig);
          if (!o.force && st.laneSig.get(it.key) === sig && !slide) continue;
          st.laneSig.set(it.key, sig);
          syncMarks(plot, marks, title, {
            slide:
              slide && (it.kind !== "draft" && it.kind !== "draftsub" ? true : st.sheet?.slide),
            fade: !st.first,
          });
        }
        for (const k of [...st.laneSig.keys()])
          if (!model.some((m) => m.key === k)) st.laneSig.delete(k);
        const lanes = model.filter((m) => m.kind !== "group");
        el.empty.hidden = lanes.length > 0;
        el.key.hidden = lanes.length === 0;
        if (!lanes.length) paintEmpty();
        ensureRove();
        if (st.first) {
          st.first = false;
          settle($$(".ag-lane, .ag-group", el.rows), { stagger: 18, y: 4, duration: 300 });
        }
        if (st.adopt?.landed) {
          const node = el.rows.querySelector(
            `[data-lane][data-k="${CSS.escape(st.adopt.landed)}"]`,
          );
          st.adopt = null;
          if (node) landPulse(node);
        }
        return navCount;
      }
      const laneFamily = (k) =>
        k === "group" ? "g" : k === "sub" || k === "draftsub" ? "sub" : "lane";
      function exitLane(node) {
        // Focus inside a lane that goes away (a proposal approved or expired)
        // lands on its schedule's title, else the next lane's, never <body>.
        if (node.contains(document.activeElement)) {
          node.classList.add("is-leaving");
          const k = node.dataset.k ?? "";
          const parentKey = k.replace(/:(sub|draft)$/, "");
          let to =
            parentKey !== k
              ? el.rows.querySelector(
                  `.ag-lane[data-k="${CSS.escape(parentKey)}"]:not(.is-leaving) .ag-title`,
                )
              : null;
          for (let sib = node.nextElementSibling; !to && sib; sib = sib.nextElementSibling)
            if (!sib.classList.contains("is-leaving"))
              to = sib.querySelector(".ag-title, [data-approve-p]");
          (to ?? el.newBtn).focus({ preventScroll: true });
        }
        if (!motionOn()) return node.remove();
        node.classList.add("is-leaving");
        const hgt = node.offsetHeight;
        node.style.overflow = "hidden";
        node
          .animate(
            [
              { height: `${hgt}px`, opacity: 1 },
              { height: "0px", opacity: 0 },
            ],
            { duration: 260, easing: EASE, fill: "forwards" },
          )
          .finished.then(
            () => node.remove(),
            () => node.remove(),
          );
      }
      function landPulse(node, o = {}) {
        if (o.focus !== false)
          node.querySelector(".ag-title, [data-approve-p]")?.focus({ preventScroll: true });
        node.scrollIntoView({ block: "nearest", behavior: motionOn() ? "smooth" : "auto" });
        if (!motionOn()) return;
        node.animate(
          [
            { backgroundColor: "color-mix(in srgb, var(--fg) 7%, transparent)" },
            { backgroundColor: "transparent" },
          ],
          { duration: 900, easing: "ease-out" },
        );
      }

      function paintEmpty() {
        const p = st.projectId ? q.project(st.projectId) : null;
        const html = `<div class="ag-empty-in">
            <p class="ag-empty-t">${p ? `No schedules in ${esc(p.name)} yet` : "No schedules yet"}</p>
            <p class="ag-empty-s">A schedule runs a prompt in this project at set times, on one device. Every run waits for your approval before it starts a thread.</p>
            <button class="btn sm" type="button" data-new-empty>${ic("plus")}New schedule</button>
          </div>`;
        if (el.empty._html !== html) {
          el.empty._html = html;
          el.empty.innerHTML = html;
          settle(el.empty.firstElementChild, { y: 4 });
        }
      }
      el.empty.addEventListener("click", (e) => {
        const b = e.target.closest("[data-new-empty]");
        if (b) openNew(b);
      });

      /* ======================================================== approvals strip
         One line, always mounted (the timeline never moves on a tick), that
         can't overflow: "2 runs waiting · next expires 10:51 · 9m". It opens
         the soonest due mark's popover, where Approve run names its
         consequence; J steps through the waiting runs. */
      const dueRuns = () => q.dueApprovals(st.projectId ?? undefined);
      const pendingChanges = () =>
        S.proposals
          .filter((p) => p.pending && (!st.projectId || p.projectId === st.projectId))
          .sort((a, b) => a.expiresAt - b.expiresAt);
      function nextAsk() {
        let best = null;
        for (const a of S.automations)
          if (
            (!st.projectId || a.projectId === st.projectId) &&
            q.isActive(a) &&
            (!best || a.nextRunAt < best.nextRunAt)
          )
            best = a;
        return best;
      }
      function renderDue() {
        const runs = dueRuns();
        const changes = pendingChanges();
        const n = runs.length;
        const sep = '<span class="sep">·</span>';
        el.due.dataset.state = n ? "waiting" : "idle";
        let label;
        if (n) {
          const r = runs[0];
          const left = r.expiresAt - S.now;
          el.dueSum.style.setProperty("--f", String(clamp(left / Lab.LIMITS.approvalTtlMs, 0, 1)));
          el.dueSum.toggleAttribute("data-urgent", left < URGENT_MS);
          setHtml(
            el.dueT,
            `<b>${n} ${n === 1 ? "run" : "runs"} waiting</b>${sep}${n === 1 ? `<span class="trunc">${esc(r.title)}</span>${sep}expires` : "next expires"} ${fmt.time(r.expiresAt)}${sep}<span class="ag-due-left tnum">${leftText(left)}</span>`,
          );
          label = `${n} ${n === 1 ? "run" : "runs"} waiting for approval. ${r.title} expires at ${fmt.time(r.expiresAt)}, in ${leftWords(left)}. Review`;
          el.dueSum.dataset.tip = "Review · J";
          el.dueSum.removeAttribute("aria-disabled");
        } else {
          const a = nextAsk();
          el.dueSum.style.setProperty("--f", "0");
          el.dueSum.removeAttribute("data-urgent");
          setHtml(
            el.dueT,
            `<span>Nothing waiting</span>${a ? `${sep}next asks ${esc(whenShort(a.nextRunAt))}${sep}<span class="trunc">${esc(a.title)}</span>` : ""}`,
          );
          label = a
            ? `Nothing waiting for approval. Next run asks at ${fmt.dateTime(a.nextRunAt)}: ${a.title}. Show it`
            : "Nothing waiting for approval";
          if (a) {
            el.dueSum.dataset.tip = "Show the next run";
            el.dueSum.removeAttribute("aria-disabled");
          } else {
            delete el.dueSum.dataset.tip;
            el.dueSum.setAttribute("aria-disabled", "true");
          }
        }
        if (el.dueSum.getAttribute("aria-label") !== label)
          el.dueSum.setAttribute("aria-label", label);
        el.dueChg.hidden = !changes.length;
        setHtml(
          el.dueChg,
          `${changes.length} ${changes.length === 1 ? "change" : "changes"} waiting`,
        );
        el.dueChg.dataset.tip = "Show the soonest to expire";
      }
      el.dueSum.addEventListener("click", () => {
        if (el.dueSum.getAttribute("aria-disabled") === "true") return;
        if (dueRuns().length) return openDue(0);
        const a = nextAsk();
        if (!a) return;
        const show = () => {
          const m = el.rows.querySelector(
            `.ag-lane[data-k="${CSS.escape(a.id)}"] .ag-m[data-s="next"], .ag-lane[data-k="${CSS.escape(a.id)}"] .ag-band[data-nav]`,
          );
          if (!m) return;
          setRove(m);
          m.focus({ preventScroll: true });
          m.scrollIntoView({ block: "nearest" });
          openMark(m);
        };
        if (!inView(a.nextRunAt)) {
          jumpTo(a.nextRunAt);
          requestAnimationFrame(show);
        } else show();
      });
      el.dueChg.addEventListener("click", () => {
        const p = pendingChanges()[0];
        const b =
          p && el.rows.querySelector(`.ag-lane[data-p="${CSS.escape(p.id)}"] [data-approve-p]`);
        if (!b) return;
        b.scrollIntoView({ block: "nearest", behavior: motionOn() ? "smooth" : "auto" });
        b.focus({ preventScroll: true });
        landPulse(b.closest(".ag-lane"), { focus: false });
      });
      const inView = (t) => st.view && t >= st.view.a && t < st.view.b;
      /* Page (and zoom stays) so a time is in view. */
      function jumpTo(t) {
        const d = Math.round((midnight(t) - midnight(S.now)) / DAY);
        const pg = st.zoom === "day" ? d : Math.floor((d + 1) / 7);
        if (pg === st.page[st.zoom]) return;
        st.page[st.zoom] = pg;
        setView(windowOf(st.zoom, pg), { animate: true });
      }

      /* Open the soonest waiting run (step 0) or the next/previous one
         after the one whose popover is open. */
      function openDue(step = 0) {
        const runs = dueRuns();
        if (!runs.length) return;
        let i = 0;
        const cur = st.pop?.mark?._m?.type === "due" ? st.pop.mark._m.run.id : null;
        if (step && cur) {
          const j = runs.findIndex((r) => r.id === cur);
          i = (j + step + runs.length) % runs.length;
        }
        if (!inView(S.now)) toToday();
        const m = el.rows.querySelector(`.ag-m[data-k="run:${CSS.escape(runs[i].id)}"]`);
        if (!m || (st.pop && st.pop.mark === m)) return;
        setRove(m);
        m.focus({ preventScroll: true });
        m.scrollIntoView({ block: "nearest" });
        openMark(m);
      }

      /* ======================================================== announcements
         One polite region: a run comes due, 5 and 1 minutes left, expired.
         Never per second; bursts are merged. */
      const said = new Map();
      let sayQueue = [];
      let sayT = 0;
      function say(text) {
        sayQueue.push(text);
        clearTimeout(sayT);
        sayT = setTimeout(() => {
          el.say.textContent = sayQueue.slice(-3).join(". ");
          sayQueue = [];
        }, 500);
      }
      const inFilter = (r) => !st.projectId || r.projectId === st.projectId;
      function announceMinutes() {
        for (const r of dueRuns()) {
          const m = Math.ceil((r.expiresAt - S.now) / MIN);
          const mark = m <= 1 ? 1 : m <= 5 ? 5 : 15;
          const last = said.get(r.id) ?? 15;
          if (mark < last) {
            said.set(r.id, mark);
            say(`${mark === 1 ? "1 minute" : "5 minutes"} left to approve ${r.title}`);
          }
        }
      }

      /* ======================================================== live paint (every tick) */
      function paintLive() {
        const nowH = H(S.now);
        root.style.setProperty("--ag-now", String(nowH));
        setText(el.nowflag, fmt.time(S.now));
        el.nowflag.hidden = !inView(S.now);
        paintNear();
        for (const n of el.rows.querySelectorAll(".ag-dm")) paintDueMark(n);
        for (const n of el.rows.querySelectorAll(".ag-win")) {
          const r = n._m?.run;
          if (!r) continue;
          n.style.setProperty(
            "--p",
            String(clamp((S.now - r.createdAt) / (r.expiresAt - r.createdAt), 0, 1)),
          );
        }
        for (const lane of el.rows.querySelectorAll(".ag-lane[data-kind='sub']")) {
          const p = q.proposal(lane.dataset.p);
          if (p) paintSubLive(lane, p);
        }
        announceMinutes();
      }
      /* Hour labels the now flag would sit on: pixel overlap, not a guess
         in hours (day zoom is 7× wider than week). */
      function paintNear() {
        if (!st.view) return;
        const span = spanH(st.view);
        const px = st.pw / span;
        // The flag's text is tabular "HH:MM": measure once it has text.
        if (!st.flagW && el.nowflag.textContent) st.flagW = el.nowflag.offsetWidth;
        const fw = st.flagW || 40;
        const hrW = root.dataset.zoom === "day" ? 14 : 13;
        const fx = (H(S.now) - H(st.view.a)) * px;
        const lo = fx - fw / 2 - 4;
        const hi = fx + fw / 2 + 4;
        for (const n of el.hours.children) {
          const x = (H(Number(n.dataset.k)) - H(st.view.a)) * px + 4;
          n.classList.toggle("is-near", x + hrW > lo && x < hi);
        }
      }

      /* ======================================================== roving focus */
      const navMarks = (plot) =>
        [...plot.querySelectorAll(".ag-m[data-nav], .ag-band[data-nav], .ag-edge")]
          .filter(
            (n) =>
              !n.classList.contains("is-leaving") &&
              (n.classList.contains("ag-edge") ||
                (st.view && n._t >= st.view.a - HOUR && n._t <= st.view.b)),
          )
          .sort((x, y) => x._t - y._t);
      function setRove(node) {
        if (st.rove && st.rove !== node && st.rove.isConnected) st.rove.tabIndex = -1;
        st.rove = node;
        node.tabIndex = 0;
      }
      function ensureRove() {
        if (st.rove?.isConnected && !st.rove.classList.contains("is-leaving")) {
          st.rove.tabIndex = 0;
          return;
        }
        const pick =
          el.rows.querySelector(".ag-dm") ??
          el.rows.querySelector('.ag-m[data-s="next"]') ??
          el.rows.querySelector(".ag-m[data-nav], .ag-band[data-nav]");
        if (pick) setRove(pick);
      }
      el.rows.addEventListener("focusin", (e) => {
        const m = e.target.closest(".ag-m[data-nav], .ag-band[data-nav], .ag-edge");
        if (m) setRove(m);
      });
      el.rows.addEventListener("keydown", (e) => {
        const m = e.target.closest(".ag-m, .ag-band, .ag-edge");
        if (!m || e.metaKey || e.ctrlKey || e.altKey) return;
        const plot = m.closest(".ag-plot");
        const list = navMarks(plot);
        const i = list.indexOf(m);
        let to = null;
        if (e.key === "ArrowRight") to = list[i + 1];
        else if (e.key === "ArrowLeft") to = list[i - 1];
        else if (e.key === "Home") to = list[0];
        else if (e.key === "End") to = list[list.length - 1];
        else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          const plots = [...el.rows.querySelectorAll(".ag-lane:not(.is-leaving) .ag-plot")];
          let j = plots.indexOf(plot);
          const dir = e.key === "ArrowDown" ? 1 : -1;
          for (j += dir; j >= 0 && j < plots.length; j += dir) {
            const l = navMarks(plots[j]);
            if (!l.length) continue;
            to = l.reduce(
              (best, n) => (Math.abs(n._t - m._t) < Math.abs(best._t - m._t) ? n : best),
              l[0],
            );
            break;
          }
          if (!to) {
            e.preventDefault();
            return;
          }
        } else if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          if (m.classList.contains("ag-edge")) jumpTo(m._m.t);
          else openMark(m);
          return;
        } else if (e.key.toLowerCase() === "u" && m._m?.run) {
          e.preventDefault();
          act.markRead(m._m.run.id, !!m._m.run.unread);
          return;
        } else if (e.key.toLowerCase() === "e") {
          e.preventDefault();
          editLane(plot.dataset.lane, m);
          return;
        } else return;
        e.preventDefault();
        if (!to) return;
        setRove(to);
        to.focus({ preventScroll: true });
        to.scrollIntoView({ block: "nearest" });
      });
      el.rows.addEventListener("click", (e) => {
        const edge = e.target.closest(".ag-edge");
        if (edge) return jumpTo(edge._m.t);
        const mark = e.target.closest(".ag-m[data-nav], .ag-band[data-nav]");
        if (mark) {
          setRove(mark);
          openMark(mark);
          return;
        }
        const edit = e.target.closest("[data-edit]");
        if (edit) {
          const lane = edit.closest(".ag-lane");
          if (lane.dataset.kind === "draft") return focusSheet();
          editLane(lane.dataset.k, edit);
          return;
        }
        const ap = e.target.closest("[data-approve-p]");
        if (ap) return decideProposal(ap.closest(".ag-lane").dataset.p, true);
        const rj = e.target.closest("[data-reject-p]");
        if (rj) return decideProposal(rj.closest(".ag-lane").dataset.p, false);
      });

      function decideProposal(pid, approve) {
        const p = q.proposal(pid);
        if (!p) return;
        const laneKey = p.automationId;
        if (!approve) {
          act.reject(pid);
          focusLaneTitle(laneKey);
          return;
        }
        const a = act.approve(pid);
        const after = q.proposal(pid);
        if (!a) {
          api.notify(after?.detail ?? "That change couldn't be applied.", { tone: "warn" });
          focusLaneTitle(laneKey);
          return;
        }
        if (p.kind === "cancel") {
          api.notify(`“${p.title}” cancelled`, { tone: "info" });
          el.newBtn.focus();
          return;
        }
        focusLaneTitle(laneKey);
      }
      function focusLaneTitle(key) {
        const lane = el.rows.querySelector(`.ag-lane[data-k="${CSS.escape(key)}"]`);
        lane?.querySelector(".ag-title")?.focus({ preventScroll: true });
      }

      /* ======================================================== mark popover
         Rendered once per run status; ticks patch only the countdown text.
         Its anchor is the run's one node, so approve / reject / expiry
         change the popover in place, and focus moves to the new primary
         action instead of falling to <body>. */
      const PRIMARY =
        "[data-act='approve'], [data-act='retry'], [data-act='open'], [data-act='approve-p'], [data-act='edit'], [data-act='day']";
      function openMark(mark) {
        const m0 = mark._m;
        if (!m0) return;
        if (st.pop?.mark === mark) {
          st.pop.api.close();
          return;
        }
        st.pop?.api.close();
        const pop = {
          mark,
          box: h("div", "ag-pop"),
          laneKey: mark.closest(".ag-plot")?.dataset.lane,
          api: null,
        };
        pop.paint = () => paintPop(pop);
        paintPop(pop, { first: true });
        const papi = popover(mark, pop.box, {
          placement: "bottom",
          width: 304,
          container: host,
          className: "ag-popwrap",
          initialFocus: PRIMARY,
          onClose: () => {
            if (st.pop === pop) st.pop = null;
          },
        });
        if (!papi) return;
        pop.api = papi;
        st.pop = pop;
        if (m0.run && m0.run.unread && m0.type === "run") act.markRead(m0.run.id, true);
        pop.box.addEventListener("keydown", (e) => {
          if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
          const k = e.key.toLowerCase();
          if ((k === "j" || k === "k") && pop.mark._m?.type === "due") {
            e.preventDefault();
            openDue(k === "j" ? 1 : -1);
          }
        });
        pop.box.addEventListener("click", (e) => {
          const b = e.target.closest("[data-act]");
          if (!b) return;
          const a = b.dataset.act;
          const m = pop.mark._m;
          const run = m.run ? q.run(m.run.id) : null;
          const backToMark = () => {
            if (!pop.mark.isConnected) return;
            setRove(pop.mark);
            pop.mark.focus({ preventScroll: true });
          };
          if (a === "approve" && run) {
            act.approveRun(run.id);
            papi.close();
            backToMark();
          } else if (a === "reject" && run) {
            act.rejectRun(run.id);
            papi.close();
            backToMark();
          } else if (a === "open" && run?.threadIds?.[0]) {
            act.openThread(run.threadIds[0]);
            papi.close();
          } else if (a === "retry" && run) {
            const nr = act.retryRun(run.id);
            const find = () =>
              nr ? el.rows.querySelector(`[data-k="run:${CSS.escape(nr.id)}"]`) : null;
            papi.close(find).then(() => {
              const n = find();
              if (!n) return;
              setRove(n);
              n.focus({ preventScroll: true });
            });
          } else if (a === "edit") {
            papi.close();
            editLane(pop.laneKey, pop.mark);
          } else if (a === "day") {
            papi.close();
            setZoom("day");
          } else if (a === "next-due") {
            openDue(1);
          } else if (a === "approve-p" || a === "reject-p") {
            const lane = el.rows.querySelector(`.ag-lane[data-k="${CSS.escape(pop.laneKey)}"]`);
            papi.close();
            if (lane?.dataset.p) decideProposal(lane.dataset.p, a === "approve-p");
          }
        });
      }

      function paintPop(pop, o = {}) {
        const m = pop.mark._m;
        if (!m) return;
        const html = popHtml(m, pop.laneKey);
        if (html !== pop.box._html) {
          const active = document.activeElement;
          const had = !o.first && pop.box.contains(active) ? (active.dataset.act ?? "") : null;
          pop.box._html = html;
          pop.box.innerHTML = html;
          if (had != null) {
            const t =
              (had && pop.box.querySelector(`[data-act="${had}"]`)) ??
              pop.box.querySelector(PRIMARY) ??
              pop.api?.el;
            t?.focus({ preventScroll: true });
          }
          if (!o.first) pop.api?.reposition();
        }
        patchPopLive(pop);
      }
      function patchPopLive(pop) {
        const m = pop.mark._m;
        const left = pop.box.querySelector(".ag-pop-left");
        if (left && m.run) {
          const r = q.run(m.run.id) ?? m.run;
          const l = r.expiresAt - S.now;
          setText(left, l > 0 ? ` · ${leftText(l)} left` : "");
          const exp = left.closest(".ag-pop-exp");
          exp.style.setProperty("--f", String(clamp(l / Lab.LIMITS.approvalTtlMs, 0, 1)));
          exp.toggleAttribute("data-urgent", l > 0 && l < URGENT_MS);
        }
        const rel = pop.box.querySelector(".ag-pop-rel");
        if (rel) setText(rel, ` · ${sched.relative(Number(rel.dataset.t))}`);
      }

      const glyph = (s) =>
        `<i class="lg${s === "due" ? " lg-due" : ""}" data-s="${esc(s)}" aria-hidden="true"></i>`;
      function popHtml(m, laneKey) {
        const head = (g, when, extra = "") =>
          `<div class="ag-pop-h">${g ? glyph(g) : ""}<b>${esc(statusText(m))}</b><span class="faint tnum">${when}</span>${extra}</div>`;
        const edit = `<button class="btn sm ghost" type="button" data-act="edit">${ic("edit")}Edit schedule</button>`;
        if (m.type === "band") {
          return `${head("band", "")}
            <p class="ag-pop-title">${esc(laneTitle(laneKey))}</p>
            <p class="ag-pop-p tnum">${m.n} runs, ${esc(fmt.dateTime(m.a))} → ${esc(fmt.dateTime(m.b))}. Each one waits for your approval when it comes due.</p>
            <div class="ag-pop-a">${st.zoom === "week" ? `<button class="btn sm" type="button" data-act="day">${ic("search")}Day view</button>` : ""}<span class="ag-sp"></span>${m.sub === "f" ? edit : ""}</div>`;
        }
        if (m.type === "p") {
          return `${head("prop", esc(fmt.dateTime(m.t)))}
            <p class="ag-pop-title">${esc(laneTitle(laneKey))}</p>
            <p class="ag-pop-p">Runs here once you approve the change. Until then the current schedule stays in effect.</p>
            <div class="ag-pop-a"><button class="btn sm primary" type="button" data-act="approve-p">Approve change</button><button class="btn sm ghost" type="button" data-act="reject-p">Reject</button></div>`;
        }
        if (m.type === "f") {
          const A = q.automation(laneKey);
          return `${head(m.s === "next" ? "next" : "future", `${esc(fmt.dateTime(m.t))}<span class="ag-pop-rel" data-t="${m.t}"></span>`)}
            <p class="ag-pop-title">${esc(laneTitle(laneKey))}</p>
            <p class="ag-pop-p">Asks for your approval when it comes due; you have 15 minutes to approve.</p>
            ${A ? `<p class="ag-pop-c">${esc(consequence(A.execution, A.deviceId))}</p>` : ""}
            <div class="ag-pop-a"><span class="ag-sp"></span>${edit}</div>`;
        }
        const r = q.run(m.run.id) ?? m.run;
        // The same time as the mark on the timeline: when it asked.
        const asked = askedAt(r);
        const when = esc(whenShort(asked));
        const c = r.coalescedOccurrences;
        const late = asked > r.scheduledFor + MIN;
        const origin = c
          ? `<p class="ag-pop-s">Covered ${c} missed runs from ${esc(fmt.dateTime(r.scheduledFor))}.</p>`
          : late && r.retryOfRunId
            ? `<p class="ag-pop-s">A retry of the run scheduled for ${esc(fmt.dateTime(r.scheduledFor))}.</p>`
            : "";
        if (r.status === "pending-approval") {
          const due = dueRuns();
          const i = due.findIndex((x) => x.id === r.id);
          const pager =
            due.length > 1 && i >= 0
              ? `<span class="ag-pop-n tnum">${i + 1} of ${due.length}</span><button class="btn ghost xs icon ag-pop-next" type="button" data-act="next-due" aria-label="Next waiting run" data-tip="Next waiting · J">${ic("chevR")}</button>`
              : "";
          return `${head("due", when, pager)}
            <p class="ag-pop-title">${esc(r.title)}</p>
            <p class="ag-pop-exp tnum" role="timer" aria-live="off">${ringSvg("sm")}<span>Expires ${fmt.time(r.expiresAt)}</span><span class="ag-pop-left"></span></p>
            ${c ? `<p class="ag-pop-p"><b>${c} missed runs → 1.</b> The device was asleep; approving starts one run now.</p>` : ""}
            <p class="ag-pop-c">${esc(consequence(r.execution, r.deviceId))}</p>
            <div class="ag-pop-a"><button class="btn sm primary" type="button" data-act="approve">Approve run</button><button class="btn sm ghost" type="button" data-act="reject">Reject</button><span class="ag-sp"></span>${edit}</div>`;
        }
        let body = "";
        let actions = "";
        if (r.status === "completed") {
          const t = q.thread(r.threadIds?.[0]);
          body = `<p class="ag-pop-p">The thread started${r.completedAt ? ` at ${fmt.time(r.completedAt)}` : ""}. How it went lives in the thread.</p>${t ? `<p class="ag-pop-thread">${ic("msg")}<span class="trunc">${esc(t.title)}</span></p>` : ""}${origin}`;
          if (t)
            actions = `<button class="btn sm primary" type="button" data-act="open">${ic("arrowUpRight")}Open thread</button>`;
        } else if (isStarting(r.status)) {
          body = `<p class="ag-pop-p">Approved. ${esc(consequence(r.execution, r.deviceId).replace("Starts", "Starting"))}.</p>${origin}`;
        } else if (r.status === "failed") {
          body = `<p class="ag-pop-fail">${ic("alertCircle")}<span>${esc(r.safeFailureDetail ?? "The thread did not start.")}</span></p>
            <p class="ag-pop-s">Not retried automatically — delivery is uncertain. Check the device before running it again.</p>`;
        } else {
          const why =
            r.status === "expired"
              ? "Nobody approved it within 15 minutes."
              : r.status === "rejected"
                ? "You rejected this run."
                : (r.safeFailureDetail ?? "Cancelled.");
          body = `<p class="ag-pop-p">${esc(why)}</p>${origin}`;
          const can = q.canRetry(r);
          if (can.ok)
            actions = `<button class="btn sm" type="button" data-act="retry">${ic("retry")}Retry with approval</button>`;
          else body += `<p class="ag-pop-s">${esc(can.reason)}</p>`;
        }
        return `${head(r.status, when)}
          <p class="ag-pop-title">${esc(r.title)}</p>
          ${body}
          <div class="ag-pop-a">${actions}<span class="ag-sp"></span>${q.automation(r.automationId)?.cancelled ? "" : edit}</div>`;
      }
      function statusText(m) {
        if (m.type === "band") return `Every ${fmt.interval(m.iv)}`;
        if (m.type === "p") return "Proposed run";
        if (m.type === "f") return m.s === "next" ? "Next run" : "Scheduled";
        const r = q.run(m.run.id) ?? m.run;
        return Lab.statusLabel(r.status);
      }
      function laneTitle(key) {
        return (
          q.automation(key)?.title ?? S.proposals.find((p) => p.automationId === key)?.title ?? ""
        );
      }

      /* ======================================================== key */
      el.key.addEventListener("click", () => {
        const rows = [
          ["completed", "Dispatched", "the thread started"],
          ["failed", "Failed", "the thread didn't start"],
          ["expired", "Expired or rejected", "can be retried"],
          ["executing", "Starting", ""],
          ["due", "Waiting for approval", "drains over 15 min"],
          ["next", "Next run", ""],
          ["future", "Scheduled", ""],
          ["band", "Many runs", "zoom in to split them"],
          ["prop", "Proposed", "once you approve it"],
        ];
        const box = h(
          "div",
          "ag-keypop",
          `<p class="ag-key-h">What the marks mean</p><ul>${rows
            .map(
              ([s, l, hint]) =>
                `<li>${glyph(s)}<span><b>${esc(l)}</b>${hint ? `<span class="faint"> · ${esc(hint)}</span>` : ""}</span></li>`,
            )
            .join("")}</ul>`,
        );
        popover(el.key, box, {
          placement: "bottom-start",
          width: 300,
          container: host,
          className: "ag-popwrap",
        });
      });

      /* ======================================================== menus */
      function menu(anchor, { options, value, onPick, width, label }) {
        const list = h("div", "menu ag-menu");
        list.setAttribute("role", "listbox");
        if (label) list.setAttribute("aria-label", label);
        let group = null;
        for (const o of options) {
          if (o.group && o.group !== group) {
            group = o.group;
            list.append(h("div", "menu-label", esc(group)));
          }
          const b = h(
            "button",
            "menu-item ag-mi",
            `${o.icon ?? ""}<span class="ag-mi-t"><span class="ag-mi-l">${esc(o.label)}</span>${o.hint ? `<span class="ag-mi-h">${esc(o.hint)}</span>` : ""}</span>${o.meta != null ? `<span class="ag-mi-m tnum" aria-hidden="true">${esc(o.meta)}</span>` : ""}<span class="ag-mi-c">${o.value === value ? ic("check") : ""}</span>`,
          );
          b.type = "button";
          b.setAttribute("role", "option");
          if (o.aria) b.setAttribute("aria-label", o.aria);
          b.setAttribute("aria-selected", String(o.value === value));
          if (o.disabled) b.setAttribute("aria-disabled", "true");
          b.dataset.v = String(o.value ?? "");
          b._v = o.value;
          list.append(b);
        }
        const items = () => $$(".ag-mi:not([aria-disabled='true'])", list);
        const pop = popover(anchor, list, {
          placement: "bottom-start",
          width: width ?? Math.max(anchor.offsetWidth, 220),
          container: host,
          className: "ag-popwrap",
          initialFocus: list.querySelector('[aria-selected="true"]') ?? undefined,
        });
        if (!pop) return null;
        list.addEventListener("keydown", (e) => {
          const all = items();
          const i = all.indexOf(document.activeElement);
          let n = null;
          if (e.key === "ArrowDown") n = all[(i + 1) % all.length];
          else if (e.key === "ArrowUp") n = all[(i - 1 + all.length) % all.length];
          else if (e.key === "Home") n = all[0];
          else if (e.key === "End") n = all[all.length - 1];
          else if (e.key === "Tab") {
            e.preventDefault();
            pop.close();
            return;
          } else return;
          e.preventDefault();
          n?.focus();
        });
        list.addEventListener("click", (e) => {
          const b = e.target.closest(".ag-mi");
          if (!b || b.getAttribute("aria-disabled") === "true") return;
          pop.close();
          onPick(b._v);
        });
        return pop;
      }

      function selectButton(o) {
        const b = h("button", "field ag-sel");
        b.type = "button";
        b.setAttribute("aria-haspopup", "listbox");
        let value = o.value;
        const paint = () => {
          const opt = o.options().find((x) => x.value === value);
          b.innerHTML = `${opt?.icon ?? ""}<span class="trunc">${esc(opt?.short ?? opt?.label ?? o.placeholder ?? "")}</span>${ic("chevsUD", "ag-sel-chev")}`;
          b.setAttribute("aria-label", `${o.label}: ${opt?.label ?? "none"}`);
        };
        const open = () =>
          menu(b, {
            options: o.options(),
            value,
            label: o.label,
            width: o.width,
            onPick: (v) => {
              if (v === value) return;
              value = v;
              paint();
              o.onChange(v);
            },
          });
        b.addEventListener("click", open);
        b.addEventListener("keydown", (e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            open();
          }
        });
        paint();
        return {
          el: b,
          set(v) {
            value = v;
            paint();
          },
          refresh: paint,
        };
      }

      /* Project filter */
      function paintFilter() {
        const p = st.projectId ? q.project(st.projectId) : null;
        const name = p ? p.name : "All projects";
        setHtml(el.filter, `${ic("folder")}<span>${esc(name)}</span>${ic("chevD", "ag-sel-chev")}`);
        el.filter.setAttribute("aria-label", `Project filter: ${name}`);
        // The 25-per-project limit, said where it applies, before New schedule.
        const full = p && q.activeCount(p.id) >= Lab.LIMITS.perProject;
        el.cap.hidden = !full;
        if (full) {
          setText(el.cap, `${q.activeCount(p.id)} of ${Lab.LIMITS.perProject} active`);
          el.cap.dataset.tip = `${p.name} is at the ${Lab.LIMITS.perProject}-schedule limit. Pause or cancel one to add another.`;
        }
      }
      const isFull = (pid) => q.activeCount(pid) >= Lab.LIMITS.perProject;
      el.filter.addEventListener("click", () => {
        const count = (pid) => q.schedules({ projectId: pid }).length;
        const n = (k) => `${k} ${k === 1 ? "schedule" : "schedules"}`;
        menu(el.filter, {
          label: "Show schedules for",
          width: 220,
          value: st.projectId,
          options: [
            {
              value: null,
              label: "All projects",
              meta: String(q.schedules({}).length),
              aria: `All projects, ${n(q.schedules({}).length)}`,
            },
            ...S.projects.map((p) => ({
              value: p.id,
              label: p.name,
              meta: String(count(p.id)),
              aria: `${p.name}, ${n(count(p.id))}${isFull(p.id) ? ", at the limit" : ""}`,
            })),
          ],
          onPick: (v) => {
            st.projectId = v;
            paintFilter();
            renderDue();
            render({ force: true });
          },
        });
      });

      /* ======================================================== sheet editor */
      function sheetSchedule(sh = st.sheet) {
        if (!sh) return null;
        if (sh.kind === "once") return { kind: "once", runAt: sh.start };
        return { kind: "fixed-interval", startsAt: sh.start, intervalMs: sh.iv, endsAt: sh.end };
      }
      function sheetDef(sh = st.sheet) {
        return {
          execution: { ...sched.clone(sh.exec), projectId: sh.projectId },
          schedule: sheetSchedule(sh),
          enabled: sh.enabled,
        };
      }

      function openNew(origin) {
        // Never start a draft in a full project when another one has room.
        let pid = st.projectId ?? "ryco";
        if (!st.projectId && isFull(pid)) pid = S.projects.find((p) => !isFull(p.id))?.id ?? pid;
        const d = sched.blank(pid);
        openSheet({
          id: null,
          mode: "new",
          def: d,
          deviceId: d.deviceId,
          projectId: pid,
          origin: origin ?? el.newBtn,
        });
      }
      function editLane(key, origin) {
        if (!key) return;
        const k = key.replace(/:(sub|draft)$/, "");
        if (k === "draft") return focusSheet();
        if (st.sheet && st.sheet.id === k) return focusSheet();
        const row = q.schedules({}).find((r) => r.id === k);
        if (!row) return;
        let def;
        let mode;
        if (row.automation) {
          const base = row.proposal && row.proposal.kind === "edit" ? row.proposal : row.automation;
          def = sched.draftOf(base);
          mode = "edit";
        } else {
          def = sched.draftOf(row.proposal);
          mode = "edit-create";
        }
        openSheet({
          id: k,
          mode,
          def,
          deviceId: row.deviceId,
          projectId: row.projectId,
          origin,
          fromProposal: !!(row.automation && row.proposal?.kind === "edit"),
        });
      }
      function focusSheet() {
        const els = st.sheet?.els;
        // preventScroll: the sheet clips (overflow hidden) and would scroll
        // to a field that is still sliding in, skipping the slide.
        (els?.title?.closest("[inert]") ? els.project : els?.title)?.focus({ preventScroll: true });
      }
      const isDirty = (sh = st.sheet) => !!sh && JSON.stringify(sheetDef(sh)) !== sh.initial;
      /* An unsaved draft is never dropped silently: whatever replaces or
         closes it offers it back. */
      function discardedToast(snap) {
        api.notify(snap.mode === "new" ? "Draft discarded" : "Edit discarded", {
          action: { label: "Restore", run: () => restoreSheet(snap) },
        });
      }

      /* The sheet takes its column at once; the timeline's marks FLIP from
         their old x to the new one (transform only, one layout), and the
         panel slides in over the reserved column. */
      function flipTimeline(mutate) {
        const w0 = el.axplot.clientWidth;
        const v = st.view;
        mutate();
        if (!motionOn() || !v) return;
        const w1 = el.axplot.clientWidth;
        if (!w0 || !w1 || Math.abs(w0 - w1) < 1) return;
        const t0 = H(v.a);
        const span = spanH(v);
        const dxOf = (ms) => ((H(ms) - t0) / span) * (w0 - w1);
        const pts = [];
        for (const n of root.querySelectorAll(
          ".ag-plot > .ag-m, .ag-plot > .ag-end, .ag-plot > .ag-edge",
        )) {
          if (Number.isFinite(n._t)) pts.push([n, dxOf(n._t)]);
        }
        for (const n of root.querySelectorAll(
          ".ag-hours > .ag-hr, .ag-grid > .ag-gl, .ag-dstms > .ag-dstm",
        ))
          pts.push([n, dxOf(Number(n.dataset.k))]);
        for (const n of [root.querySelector(".ag-nowline"), el.nowflag]) pts.push([n, dxOf(S.now)]);
        if (pts.length > 1200) return;
        const o = { duration: 280, easing: EASE };
        for (const [n, dx] of pts)
          if (Math.abs(dx) >= 0.5)
            n.animate([{ transform: `translateX(${dx}px)` }, { transform: "none" }], o);
        // Spans (bands, brackets, day labels) carry text that must not
        // stretch: they settle in place with a quick fade instead.
        for (const n of root.querySelectorAll(
          ".ag-plot > .ag-band, .ag-plot > .ag-br, .ag-plot > .ag-hatch, .ag-plot > .ag-win, .ag-days > .ag-day, .ag-past",
        ))
          n.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220, easing: "ease-out" });
      }
      function slideSheet(dir) {
        el.sheet._slide?.cancel();
        el.sheet.toggleAttribute("data-exiting", dir === "out");
        if (!motionOn()) {
          el.sheet.removeAttribute("data-exiting");
          return;
        }
        const a = el.sheetIn.animate(
          dir === "in"
            ? [{ transform: "translateX(100%)" }, { transform: "none" }]
            : [{ transform: "none" }, { transform: "translateX(100%)" }],
          {
            duration: dir === "in" ? 280 : 220,
            easing: dir === "in" ? EASE : "cubic-bezier(.3,0,.8,.15)",
          },
        );
        el.sheet._slide = a;
        a.finished.then(
          () => {
            if (dir === "out") el.sheet.removeAttribute("data-exiting");
          },
          () => {},
        );
      }

      function openSheet(cfg) {
        const prev = st.sheet;
        const wasOpen = !!prev;
        // Replacing a dirty draft (another lane's Edit, N, a Restore) offers it back.
        const lost = prev && isDirty(prev) ? { ...prev } : null;
        if (prev) teardownSheet();
        const s = cfg.def.schedule;
        const start = s.kind === "once" ? s.runAt : s.startsAt;
        const sh = (st.sheet = {
          id: cfg.id,
          mode: cfg.mode,
          origin: cfg.origin,
          projectId: cfg.projectId,
          deviceId: cfg.deviceId,
          exec: sched.clone(cfg.def.execution),
          enabled: cfg.def.enabled !== false,
          kind: s.kind,
          start,
          iv: s.kind === "once" ? DAY : s.intervalMs,
          end: s.kind === "once" ? addDays(start, 30) : s.endsAt,
          startInvalid: null,
          tried: false,
          touched: new Set(),
          rev: 0,
          slide: false,
          lastChange: 0,
          fromProposal: cfg.fromProposal,
          parts: [],
          els: {},
        });
        if (st.projectId && st.projectId !== sh.projectId) {
          st.projectId = sh.projectId;
          paintFilter();
          renderDue();
        }
        buildSheet(sh);
        // "No changes" compares against what the sheet shows. The pickers
        // normalise once after mounting (default effort now; an elapsed
        // "30 days" end → wall-clock in a microtask), so baseline again
        // after theirs — before any input can arrive.
        st.lastMinute = Math.floor(S.now / MIN);
        sh.initial = cfg.initial ?? JSON.stringify(sheetDef(sh));
        if (!cfg.initial)
          queueMicrotask(() => {
            if (st.sheet !== sh) return;
            sh.initial = JSON.stringify(sheetDef(sh));
            paintSheet();
          });
        el.sheet.inert = false;
        if (!wasOpen) {
          flipTimeline(() => {
            root.dataset.sheet = "open";
          });
          slideSheet("in");
        } else if (motionOn())
          el.sheetIn.animate([{ opacity: 0.4 }, { opacity: 1 }], {
            duration: 180,
            easing: "ease-out",
          });
        sh.offLayer = Lab.layers.push({
          el: el.sheet,
          anchor: null,
          dismissOnOutside: false,
          close: (reason) => closeSheet({ reason }),
        });
        render({ force: true });
        paintSheet();
        const lane = el.rows.querySelector(
          `.ag-lane[data-k="${CSS.escape(sh.id ? `${sh.id}:draft` : "draft")}"]`,
        );
        lane?.scrollIntoView({ block: "nearest", behavior: motionOn() ? "smooth" : "auto" });
        requestAnimationFrame(() => {
          if (st.sheet === sh) focusSheet();
        });
        if (lost) discardedToast(lost);
      }

      function teardownSheet() {
        const sh = st.sheet;
        if (!sh) return;
        sh.offLayer?.();
        for (const p of sh.parts) p.destroy?.();
        sh.parts = [];
      }

      function closeSheet(o = {}) {
        const sh = st.sheet;
        if (!sh) return;
        const dirty = isDirty(sh);
        teardownSheet();
        st.sheet = null;
        el.sheet.inert = true;
        flipTimeline(() => {
          root.dataset.sheet = "";
        });
        slideSheet("out");
        const snapshot = dirty && !o.saved ? { ...sh } : null;
        render({ force: true });
        if (!o.saved) {
          const back = sh.origin?.isConnected ? sh.origin : sh.id ? null : el.newBtn;
          if (back) back.focus({ preventScroll: true });
          else if (sh.id) focusLaneTitle(sh.id);
        }
        if (snapshot && o.reason !== "tab" && o.reason !== "reset") discardedToast(snapshot);
      }
      function restoreSheet(snap) {
        openSheet({
          id: snap.id,
          mode: snap.mode,
          def: {
            execution: snap.exec,
            schedule:
              snap.kind === "once"
                ? { kind: "once", runAt: snap.start }
                : {
                    kind: "fixed-interval",
                    startsAt: snap.start,
                    intervalMs: snap.iv,
                    endsAt: snap.end,
                  },
            enabled: snap.enabled,
          },
          deviceId: snap.deviceId,
          projectId: snap.projectId,
          origin: snap.origin,
          fromProposal: snap.fromProposal,
          // Still the same edit: it stays dirty against what it started from.
          initial: snap.initial,
        });
      }

      /* Any change to the draft: redraw the ghost lane (ticks slide on
         discrete picks; rapid repeats — held keys, typing — reposition). */
      function changed(o = {}) {
        const sh = st.sheet;
        if (!sh) return;
        const t = performance.now();
        sh.slide = o.slide !== false && t - sh.lastChange > 240;
        sh.lastChange = t;
        sh.rev++;
        render();
        paintSheet();
      }

      function buildSheet(sh) {
        const isNew = sh.mode === "new";
        const A = sh.id ? q.automation(sh.id) : null;
        const project = q.project(sh.projectId);
        el.sheetIn.innerHTML = `
          <header class="ag-sh-head">
            <div class="ag-sh-tt">
              <h3 class="ag-sh-title">${isNew ? "New schedule" : sh.mode === "edit-create" ? "Edit proposed schedule" : "Edit schedule"}</h3>
              <span class="ag-sh-sub">${isNew ? "" : `${esc(project?.name)} · ${esc(devName(sh.deviceId))}`}</span>
            </div>
            <div class="ag-sh-acts">
              ${A && !A.cancelled ? `<button class="btn sm" type="button" data-sh="${A.enabled ? "pause" : "resume"}">${ic(A.enabled ? "pause" : "play")}${A.enabled ? "Pause" : "Resume"}</button>` : ""}
              <button class="btn ghost sm icon" type="button" data-sh="close" aria-label="Close editor" data-tip="Close · esc">${ic("x")}</button>
            </div>
          </header>
          <div class="ag-sh-body">
            <p class="ag-limit" data-note tabindex="-1" hidden></p>
            ${sh.fromProposal ? `<p class="ag-sh-from">${ic("info")}Starts from your change that's waiting for approval; saving replaces it.</p>` : ""}
            ${isNew ? `<div class="ag-f ag-two"><div><span class="label">Project</span><div data-slot="project"></div></div><div><span class="label">Device</span><div data-slot="device"></div></div></div>` : ""}
            <div class="ag-sh-fields" data-fields>
            <div class="ag-f" data-f="title">
              <label class="label" for="ag-title-in">Title</label>
              <input class="field" id="ag-title-in" autocomplete="off" maxlength="${Lab.LIMITS.titleMax + 20}" placeholder="Nightly dependency check">
              <p class="ag-err" data-err="title"></p>
            </div>
            <section class="ag-sec" aria-labelledby="ag-sec-when">
              <div class="ag-sec-h"><h4 id="ag-sec-when">When</h4><div data-slot="kind"></div></div>
              <div class="ag-f" data-f="start">
                <span class="label" data-start-label>First run</span>
                <div data-slot="start"></div>
                <p class="ag-err" data-err="start"></p>
              </div>
              <div class="ag-collapse" data-repeat><div class="ag-collapse-in">
                <div class="ag-f" data-f="interval">
                  <span class="label">Repeat every</span>
                  <div data-slot="interval"></div>
                  <p class="ag-err" data-err="interval"></p>
                </div>
                <div class="ag-f" data-f="end">
                  <span class="label">Ends</span>
                  <div data-slot="until"></div>
                  <p class="ag-err" data-err="end"></p>
                </div>
              </div></div>
              <p class="ag-dst" hidden></p>
              <p class="ag-sh-once" hidden>Runs once. Like every run, it waits for your approval when it comes due.</p>
            </section>
            <section class="ag-sec" aria-labelledby="ag-sec-what">
              <div class="ag-sec-h"><h4 id="ag-sec-what">What runs</h4></div>
              <div class="ag-f" data-f="prompt">
                <div class="ag-lrow"><label class="label" for="ag-prompt-in">Prompt</label><span class="ag-count tnum" hidden></span></div>
                <textarea class="field" id="ag-prompt-in" rows="4" placeholder="What should the agent do on each run?"></textarea>
                <p class="ag-err" data-err="prompt"></p>
              </div>
              <div class="ag-f" data-f="model">
                <span class="label">Model</span>
                <div class="ag-modelrow"><div data-slot="model"></div><div data-slot="effort"></div></div>
                <p class="ag-err" data-err="model"></p>
              </div>
              <div class="ag-f">
                <span class="label">Permissions</span>
                <div data-slot="mode"></div>
                <p class="ag-hint" data-mode-hint></p>
              </div>
              <div class="ag-f">
                <span class="label">Runs in</span>
                <div class="ag-whererow"><div data-slot="env"></div><span class="ag-off" data-off>off</span><div data-slot="ref"></div></div>
              </div>
            </section>
            </div>
          </div>
          <footer class="ag-sh-foot">
            <p class="ag-sh-hint">${ic("shield")}Saving proposes the change — it applies once you approve it.</p>
            <div class="ag-sh-btns">
              ${A && !A.cancelled ? `<button class="btn sm ghost destructive" type="button" data-sh="cancel">Cancel schedule</button>` : sh.mode === "edit-create" ? `<button class="btn sm ghost destructive" type="button" data-sh="withdraw">Withdraw</button>` : ""}
              <span class="ag-sp"></span>
              <button class="btn sm ghost" type="button" data-sh="discard">${isNew ? "Discard" : "Discard edit"}</button>
              <button class="btn sm primary" type="button" data-sh="save">Save</button>
            </div>
          </footer>`;
        const $s = (sel) => el.sheetIn.querySelector(sel);
        const slot = (n) => $s(`[data-slot="${n}"]`);
        const P = window.Pickers;
        const els = (sh.els = {
          title: $s("#ag-title-in"),
          prompt: $s("#ag-prompt-in"),
          count: $s(".ag-count"),
          note: $s("[data-note]"),
          repeat: $s("[data-repeat]"),
          dst: $s(".ag-dst"),
          once: $s(".ag-sh-once"),
          startLabel: $s("[data-start-label]"),
          modeHint: $s("[data-mode-hint]"),
          off: $s("[data-off]"),
          refSlot: slot("ref"),
          effortSlot: slot("effort"),
          until: slot("until"),
          fields: $s("[data-fields]"),
          save: $s('[data-sh="save"]'),
          lifecycle: [
            ...el.sheetIn.querySelectorAll(
              '[data-sh="pause"], [data-sh="resume"], [data-sh="cancel"]',
            ),
          ],
        });
        els.title.value = sh.exec.title ?? "";
        els.prompt.value = sh.exec.prompt ?? "";
        els.title.addEventListener("input", () => {
          sh.exec.title = els.title.value;
          changed({ slide: false });
        });
        els.prompt.addEventListener("input", () => {
          sh.exec.prompt = els.prompt.value;
          paintSheet();
        });
        for (const [k, node] of [
          ["title", els.title],
          ["prompt", els.prompt],
        ])
          node.addEventListener("blur", () => {
            if (!node.value.trim() && !sh.touched.has(k)) return;
            sh.touched.add(k);
            paintSheet();
          });

        if (isNew) {
          const projSel = selectButton({
            label: "Project",
            value: sh.projectId,
            // A full project can't take another schedule: say so where it's picked.
            options: () =>
              S.projects.map((p) => ({
                value: p.id,
                label: p.name,
                meta: isFull(p.id)
                  ? `${Lab.LIMITS.perProject} of ${Lab.LIMITS.perProject} · full`
                  : `${q.activeCount(p.id)} active`,
                aria: isFull(p.id)
                  ? `${p.name}, full: ${Lab.LIMITS.perProject} active schedules`
                  : `${p.name}, ${q.activeCount(p.id)} active`,
                disabled: isFull(p.id) && p.id !== sh.projectId,
              })),
            onChange: (v) => {
              sh.projectId = v;
              const p = q.project(v);
              sh.deviceId = p.checkouts[0].deviceId;
              sh.exec.projectId = v;
              sh.exec.baseRef = p.refs[0] ?? "main";
              devSel.set(sh.deviceId);
              devSel.refresh();
              refSel?.set(sh.exec.baseRef);
              if (st.projectId && st.projectId !== v) {
                st.projectId = v;
                paintFilter();
                renderDue();
              }
              changed({ slide: false });
            },
          });
          const devSel = selectButton({
            label: "Device",
            value: sh.deviceId,
            options: () =>
              q.project(sh.projectId).checkouts.map((c) => ({
                value: c.deviceId,
                label: devName(c.deviceId),
                hint: c.path,
                icon: deviceIcon(c.deviceId),
              })),
            onChange: (v) => {
              sh.deviceId = v;
              changed({ slide: false });
            },
          });
          slot("project").append(projSel.el);
          slot("device").append(devSel.el);
          els.project = projSel.el;
        }

        const kindSeg = P.segmented(slot("kind"), {
          label: "Schedule kind",
          value: sh.kind,
          options: [
            { value: "once", label: "Once" },
            { value: "fixed-interval", label: "Repeats" },
          ],
          onChange: (v) => {
            sh.kind = v;
            changed();
          },
        });
        const range = () => [S.now, S.now + Lab.LIMITS.horizonMs];
        const dt = P.dateTime(slot("start"), {
          variant: "segments",
          value: sh.start,
          min: range()[0],
          max: range()[1],
          label: "First run",
          now: () => S.now,
          onChange: (ms) => {
            sh.start = ms;
            untilP.update({ startMs: ms });
            changed();
          },
          onInvalid: (why) => {
            if ((sh.startInvalid ?? null) === (why ?? null)) return;
            sh.startInvalid = why;
            render();
            paintSheet();
          },
        });
        const ivP = P.interval(slot("interval"), {
          valueMs: sh.iv,
          label: "Repeat every",
          onChange: (ms) => {
            sh.iv = ms;
            untilP.update({ intervalMs: ms });
            changed();
          },
        });
        const untilP = P.until(slot("until"), {
          startMs: sh.start,
          valueMs: sh.end,
          nowMs: S.now,
          intervalMs: sh.iv,
          label: "Ends",
          onChange: (ms) => {
            sh.end = ms;
            changed();
          },
        });
        sh.pk = { dt, ivP, untilP };

        const modelOpts = () => {
          const out = [];
          for (const p of S.providers)
            for (const m of p.models)
              out.push({
                value: `${p.instanceId}|${m.slug}`,
                label: m.name,
                group: p.name,
                icon: providerMark(p.instanceId),
              });
          const cur = `${sh.exec.modelSelection.instanceId}|${sh.exec.modelSelection.model}`;
          if (!out.some((o) => o.value === cur))
            out.push({
              value: cur,
              label: `${sh.exec.modelSelection.model} (unavailable)`,
              short: `${sh.exec.modelSelection.model} — unavailable`,
              group:
                q.provider(sh.exec.modelSelection.instanceId)?.name ??
                sh.exec.modelSelection.instanceId,
              icon: providerMark(sh.exec.modelSelection.instanceId),
              disabled: true,
            });
          return out;
        };
        let effortSeg = null;
        const paintEffort = () => {
          effortSeg?.destroy();
          effortSeg = null;
          const prov = q.provider(sh.exec.modelSelection.instanceId);
          const opt = prov?.options.find((o) => o.id === "effort");
          els.effortSlot.hidden = !opt;
          if (!opt) {
            sh.exec.modelSelection.options = [];
            return;
          }
          let cur = sh.exec.modelSelection.options?.find((o) => o.id === "effort")?.value;
          if (!cur) {
            cur = opt.default;
            sh.exec.modelSelection.options = [{ id: "effort", value: cur }];
          }
          effortSeg = P.segmented(els.effortSlot, {
            label: "Effort",
            value: cur,
            options: opt.values.map((v) => ({ value: v.id, label: v.label })),
            onChange: (v) => {
              sh.exec.modelSelection.options = [{ id: "effort", value: v }];
              paintSheet();
            },
          });
        };
        const modelSel = selectButton({
          label: "Model",
          value: `${sh.exec.modelSelection.instanceId}|${sh.exec.modelSelection.model}`,
          width: 240,
          options: modelOpts,
          onChange: (v) => {
            const [instanceId, model] = v.split("|");
            const changedProvider = instanceId !== sh.exec.modelSelection.instanceId;
            sh.exec.modelSelection = {
              instanceId,
              model,
              options: changedProvider ? [] : sh.exec.modelSelection.options,
            };
            if (changedProvider) paintEffort();
            sh.touched.add("model");
            paintSheet();
          },
        });
        slot("model").append(modelSel.el);
        paintEffort();

        const modeSel = selectButton({
          label: "Permissions",
          value: sh.exec.runtimeMode,
          width: 300,
          options: () =>
            Lab.RUNTIME_MODES.map((m) => ({ value: m.id, label: m.label, hint: m.hint })),
          onChange: (v) => {
            sh.exec.runtimeMode = v;
            paintSheet();
          },
        });
        slot("mode").append(modeSel.el);
        const envSeg = P.segmented(slot("env"), {
          label: "Runs in",
          value: sh.exec.envMode,
          options: Lab.ENV_MODES.map((m) => ({ value: m.id, label: m.short })),
          onChange: (v) => {
            sh.exec.envMode = v;
            if (v === "worktree" && !sh.exec.baseRef)
              sh.exec.baseRef = q.project(sh.projectId)?.refs[0] ?? "main";
            paintSheet();
          },
        });
        const refSel = selectButton({
          label: "Base branch",
          value: sh.exec.baseRef ?? q.project(sh.projectId)?.refs[0] ?? "main",
          width: 220,
          options: () =>
            (q.project(sh.projectId)?.refs ?? ["main"]).map((r) => ({
              value: r,
              label: r,
              icon: ic("branch"),
            })),
          onChange: (v) => {
            sh.exec.baseRef = v;
            paintSheet();
          },
        });
        refSel.el.classList.add("is-ref");
        els.refSlot.append(refSel.el);
        sh.parts.push(kindSeg, dt, ivP, untilP, envSeg, { destroy: () => effortSeg?.destroy() });

        el.sheetIn.querySelector(".ag-sh-head").addEventListener("click", sheetAction);
        el.sheetIn.querySelector(".ag-sh-foot").addEventListener("click", sheetAction);
        els.title.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            save();
          }
        });
        el.sheetIn.addEventListener("keydown", (e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            save();
          }
        });
      }

      function sheetAction(e) {
        const b = e.target.closest("[data-sh]");
        const sh = st.sheet;
        if (!b || !sh) return;
        const a = b.dataset.sh;
        // Pause / Resume / Cancel with unsaved edits would drop them: they
        // wait until the edit is saved or discarded (the tip says so).
        if (b.getAttribute("aria-disabled") === "true" && a !== "save") return;
        if (a === "close" || a === "discard") closeSheet({ reason: a });
        else if (a === "save") save();
        else if (a === "pause" || a === "resume" || a === "cancel" || a === "withdraw") {
          const id = sh.id;
          const p =
            a === "pause" ? act.pause(id) : a === "resume" ? act.resume(id) : act.cancel(id);
          closeSheet({ saved: true, discarded: false });
          if (!p) {
            api.notify("That change couldn't be proposed.", { tone: "warn" });
            return;
          }
          if (a === "withdraw") {
            api.notify("Proposed schedule withdrawn");
            el.newBtn.focus();
            return;
          }
          const sub = el.rows.querySelector(`.ag-lane[data-k="${CSS.escape(`${id}:sub`)}"]`);
          if (sub) landPulse(sub);
        }
      }

      function errorsNow() {
        const sh = st.sheet;
        const v = sched.validate({ ...sheetDef(), id: sh.id }, S.now, { id: sh.id ?? undefined });
        return v.errors;
      }

      function save() {
        const sh = st.sheet;
        if (!sh) return;
        // Nothing changed: never propose an invisible diff.
        if (sh.mode !== "new" && !isDirty(sh)) return;
        const errs = errorsNow();
        if (sh.startInvalid) errs.start = sh.startInvalid;
        if (Object.keys(errs).length) {
          sh.tried = true;
          paintSheet();
          const order = ["limit", "title", "start", "interval", "end", "prompt", "model"];
          const first = order.find((k) => errs[k]);
          const target =
            first === "title"
              ? sh.els.title
              : first === "prompt"
                ? sh.els.prompt
                : first === "limit"
                  ? sh.els.note
                  : el.sheetIn.querySelector(
                      `[data-f="${first}"] button, [data-f="${first}"] [tabindex="0"], [data-f="${first}"] input`,
                    );
          target?.focus?.();
          target?.scrollIntoView({ block: "nearest", behavior: motionOn() ? "smooth" : "auto" });
          return;
        }
        const def = sheetDef();
        const A = sh.id ? q.automation(sh.id) : null;
        // Hand the draft lane to the lane the proposal will render as.
        st.adopt = { from: sh.id ? `${sh.id}:draft` : "draft", to: sh.id ? `${sh.id}:sub` : null };
        teardownSheet();
        st.sheet = null;
        el.sheet.inert = true;
        flipTimeline(() => {
          root.dataset.sheet = "";
        });
        slideSheet("out");
        const p = act.save(def, {
          id: sh.id ?? undefined,
          expectedRevision: A?.revision,
          deviceId: sh.deviceId,
          projectId: sh.projectId,
        });
        if (!p) {
          st.adopt = null;
          render({ force: true });
          api.notify("That change couldn't be proposed.", { tone: "warn" });
          return;
        }
        api.notify(
          sh.mode === "new"
            ? "Schedule proposed — waiting for your approval"
            : "Change proposed — waiting for your approval",
        );
      }

      function paintSheet() {
        const sh = st.sheet;
        if (!sh?.els?.title) return;
        const els = sh.els;
        const errs = errorsNow();
        const show = (k) => sh.tried || sh.touched.has(k);
        const setErr = (k, msg) => {
          const n = el.sheetIn.querySelector(`[data-err="${k}"]`);
          if (!n) return;
          const html = msg ? `${ic("alert")}<span>${esc(msg)}</span>` : "";
          if (n._html !== html) {
            n._html = html;
            n.innerHTML = html;
          }
          n.toggleAttribute("data-on", !!msg);
          const f = n.closest(".ag-f");
          f?.toggleAttribute("data-invalid", !!msg);
        };
        setErr("title", show("title") ? errs.title : null);
        setErr("prompt", show("prompt") ? errs.prompt : null);
        setErr("model", errs.model ?? null);
        setErr("start", sh.startInvalid ? null : (errs.start ?? null));
        setErr("interval", sh.kind === "once" ? null : (errs.interval ?? null));
        setErr("end", sh.kind === "once" ? null : (errs.end ?? null));
        els.title.setAttribute("aria-invalid", String(!!(show("title") && errs.title)));
        els.prompt.setAttribute("aria-invalid", String(!!(show("prompt") && errs.prompt)));
        // The 25-per-project limit: the first line, plain text; the form
        // below it waits (inert) instead of letting you fill it in for nothing.
        const limit = errs.limit;
        els.note.hidden = !limit;
        if (limit) {
          const other =
            sh.mode === "new" && S.projects.some((p) => p.id !== sh.projectId && !isFull(p.id));
          setText(els.note, `${limit}${other ? " Or choose another project." : ""}`);
        }
        els.fields.inert = !!limit;
        els.fields.toggleAttribute("data-inert", !!limit);
        const dirty = isDirty(sh);
        const unchanged = sh.mode !== "new" && !dirty;
        els.save.setAttribute("aria-disabled", String(!!limit || unchanged));
        els.save.dataset.tip = limit
          ? "Pause or cancel a schedule in this project first"
          : unchanged
            ? "No changes yet"
            : "Save · ⌘↵";
        for (const b of els.lifecycle) {
          b.setAttribute("aria-disabled", String(dirty));
          if (dirty) b.dataset.tip = "Save or discard your edit first";
          else delete b.dataset.tip;
        }
        // Once vs repeats
        const once = sh.kind === "once";
        els.repeat.toggleAttribute("data-open", !once);
        els.repeat.inert = once;
        els.once.hidden = !once;
        setText(els.startLabel, once ? "Runs at" : "First run");
        // A typed start that isn't valid yet: what's shown below describes
        // the last valid one, so it steps back rather than state it as fact.
        els.until.toggleAttribute("data-stale", !!sh.startInvalid);
        const dst = !once && !sh.startInvalid ? sched.dstShift(sheetSchedule()) : null;
        els.dst.hidden = !dst;
        if (dst)
          setHtml(
            els.dst,
            `${ic("clock")}<span>The clocks change before ${esc(fmt.day(dst.at))}, so from then on runs land at ${dst.to} instead of ${dst.from} — the interval is elapsed time.</span>`,
          );
        // Prompt counter near the limit
        const len = els.prompt.value.length;
        els.count.hidden = len < Lab.LIMITS.promptMax * 0.85;
        setText(
          els.count,
          `${len.toLocaleString("en-US")} / ${Lab.LIMITS.promptMax.toLocaleString("en-US")}`,
        );
        els.count.toggleAttribute("data-over", len > Lab.LIMITS.promptMax);
        // Mode hint + base ref
        setText(
          els.modeHint,
          Lab.RUNTIME_MODES.find((m) => m.id === sh.exec.runtimeMode)?.hint ?? "",
        );
        const wt = sh.exec.envMode === "worktree";
        els.off.hidden = !wt;
        els.refSlot.hidden = !wt;
      }

      /* ======================================================== keyboard shortcuts */
      const onKey = (e) => {
        if (!root.isConnected || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
        if (isTyping(e.target) || e.target.closest?.(".pk, .pk-pop")) return;
        const top = Lab.layers.top();
        if (top && top.el !== el.sheet) return;
        const k = e.key;
        if (k === "d" || k === "D") setZoom("day");
        else if (k === "w" || k === "W") setZoom("week");
        else if (k === "[") page(-1);
        else if (k === "]") page(1);
        else if (k === "t" || k === "T") toToday();
        else if ((k === "n" || k === "N") && !st.sheet) openNew(el.newBtn);
        else if ((k === "j" || k === "J") && dueRuns().length) openDue(0);
        else return;
        e.preventDefault();
      };
      document.addEventListener("keydown", onKey);
      el.newBtn.addEventListener("click", () => openNew(el.newBtn));

      /* ======================================================== boot */
      for (const b of el.zoom.querySelectorAll("[data-zoom]")) {
        const on = b.dataset.zoom === st.zoom;
        b.setAttribute("aria-checked", String(on));
        b.tabIndex = on ? 0 : -1;
      }
      paintFilter();
      st.pw = el.axplot.clientWidth || st.pw;
      st.today = midnight(S.now);
      setView(windowOf(st.zoom, 0));
      paintHourStep();
      paintLive();
      renderDue();
      for (const r of dueRuns()) {
        const m = Math.ceil((r.expiresAt - S.now) / MIN);
        said.set(r.id, m <= 1 ? 1 : m <= 5 ? 5 : 15);
      }
      offs.push(
        Lab.onEvent((type, r) => {
          if (!r || !inFilter(r)) return;
          if (type === "run:new" && r.status === "pending-approval") {
            said.set(r.id, 15);
            say(`${r.title} is waiting for approval, expires ${fmt.time(r.expiresAt)}`);
          } else if (type === "run:expired") {
            said.delete(r.id);
            say(`${r.title} expired without approval`);
          }
        }),
      );

      return {
        update() {
          if (!root.isConnected) return;
          // Midnight passed: the page-0 window follows today.
          const today = midnight(S.now);
          if (today !== st.today) {
            st.today = today;
            setView(windowOf(st.zoom, st.page[st.zoom]));
          }
          paintLive();
          renderDue();
          paintFilter();
          render();
          if (st.pop) {
            if (!st.pop.mark.isConnected) st.pop.api.close();
            else st.pop.paint();
          }
          const sh = st.sheet;
          const minute = Math.floor(S.now / MIN);
          if (sh?.pk && minute !== st.lastMinute) {
            st.lastMinute = minute;
            sh.pk.dt.setRange(S.now, S.now + Lab.LIMITS.horizonMs);
            sh.pk.untilP.update({ nowMs: S.now });
            paintSheet();
          } else if (sh) paintSheet();
        },
        destroy() {
          cancelAnimationFrame(st.anim);
          document.removeEventListener("keydown", onKey);
          ro.disconnect();
          zoomPlate.destroy();
          for (const off of offs) off();
          st.pop?.api.close();
          teardownSheet();
          root.remove();
        },
      };
    },
  };
})();
