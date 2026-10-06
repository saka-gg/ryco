/* ============================================================
   C · Dialog — no new page.

   One Automations dialog that grows out of whichever control reached it
   (the sidebar item, a project card on the map, the rail icon), scoped to
   one project with a switcher in its header. Inside: a compact list +
   detail. "Edit" / "New schedule" turn the detail into a sentence editor
   in place — the row's title travels into the editor's title field — and
   "Save for approval" folds the editor back into the row, which now says
   what is waiting.

   Owns dir-c.js + dir-c.css (all CSS under [data-dir="C"]).
   Optional URL: ?cproj=<projectId> (open scoped to a project),
                 ?cdlg=0 (start with the dialog closed).
   ============================================================ */
(() => {
  const { MIN, HOUR, DAY, WEEK } = Lab.units;
  const q = Lab.q;
  const L = Lab.LIMITS;
  const TTL = L.approvalTtlMs;
  const PK = () => window.Pickers;
  const params = new URLSearchParams(location.search);

  /* ============================================================ words */
  const dayNo = (ms) => {
    const d = new Date(ms);
    return Math.round(new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12).getTime() / DAY);
  };
  /* "today 16:00" · "tomorrow 09:00" · "yesterday 22:40", else the one absolute
     format this dialog uses everywhere: "Wed, Oct 7 · 12:40". */
  function when(ms, now = S.now) {
    const n = dayNo(ms) - dayNo(now);
    const t = fmt.time(ms);
    if (n === 0) return `today ${t}`;
    if (n === 1) return `tomorrow ${t}`;
    if (n === -1) return `yesterday ${t}`;
    return fmt.dateTime(ms);
  }
  /* Relative time, one style everywhere: "in 1 h 58 min" · "in 16 h" · "in 2 days". */
  const rel = (ms, now = S.now) => PK()?.fmt?.rel?.(ms, now) ?? sched.relative(ms, now);
  /* Approval deadlines: the engine's coarse countdown ("13m", m:ss only in the last 2 min). */
  const left = (ms) => fmt.countdown(ms);
  /* The clock change a fixed (≥ 1 day) interval drifts across: the transition date
     and the first run that lands at the new wall-clock time. */
  function clockChange(s, now = S.now) {
    if (!s || s.kind === "once" || !sched.dstShift(s, now)) return null;
    const occ = sched.occurrences(s, now, Infinity, 160);
    const i = occ.findIndex((t, k) => k > 0 && fmt.time(t) !== fmt.time(occ[k - 1]));
    if (i < 1) return null;
    const before = occ[i - 1];
    const run = occ[i];
    const off = (t) => new Date(t).getTimezoneOffset();
    let lo = before;
    let hi = run;
    while (hi - lo > MIN) {
      const mid = Math.floor((lo + hi) / 2);
      if (off(mid) === off(lo)) lo = mid;
      else hi = mid;
    }
    const iv = s.intervalMs;
    const ivWords =
      iv === DAY
        ? "24-hour"
        : iv % WEEK === 0
          ? `${iv / WEEK}-week`
          : iv % DAY === 0
            ? `${iv / DAY}-day`
            : fmt.interval(iv);
    return {
      change: hi,
      run,
      from: fmt.time(before),
      to: fmt.time(run),
      text: `Clocks go ${off(run) > off(before) ? "back" : "forward"} ${fmt.date(hi)} — ${dayNo(run) === dayNo(hi) ? "from then on" : `from ${fmt.day(run)}`} it runs at ${fmt.time(run)}, not ${fmt.time(before)} (fixed ${ivWords} interval).`,
    };
  }
  /* The interval as the word after "every". */
  function everyWords(ms) {
    if (ms === DAY) return "day";
    if (ms === WEEK) return "week";
    if (ms % WEEK === 0) return `${ms / WEEK} weeks`;
    if (ms % DAY === 0) return `${ms / DAY} days`;
    if (ms === HOUR) return "hour";
    if (ms % HOUR === 0) return `${ms / HOUR} hours`;
    const m = Math.round(ms / MIN);
    if (m < 60) return `${m} minutes`;
    return `${Math.floor(m / 60)} h ${m % 60} min`;
  }
  const addDays = (ms, n) => {
    const d = new Date(ms);
    d.setDate(d.getDate() + n);
    return d.getTime();
  };
  const ENDS = [
    [DAY, "1 day"],
    [WEEK, "1 week"],
    [2 * WEEK, "2 weeks"],
    [30 * DAY, "30 days"],
  ];
  /* "for 1 week" when the end is one of the until-picker's durations, else "until Oct 14". */
  function endWords(start, end) {
    for (const [d, label] of ENDS)
      if (Math.abs(end - start - d) < MIN || Math.abs(end - addDays(start, d / DAY)) < MIN)
        return { conn: "for", text: label, dur: true };
    return { conn: "until", text: fmt.date(end), dur: false };
  }
  /* Rows say the cadence; the next run is always relative, so it never repeats it. */
  const rowSummary = (s) => sched.cadence(s);
  const devName = (id) => q.device(id)?.name ?? id;
  const envWords = (m) => (m === "local" ? "the main checkout" : "a new worktree");
  const plural = (n, w, ws = `${w}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? w : ws}`;
  const ceilQuarter = (ms) => Math.ceil(ms / (15 * MIN)) * 15 * MIN;
  const floorMin = (ms) => Math.floor(ms / MIN) * MIN;
  /* "Waiting for approval" is reserved for runs; proposals are "proposed". */
  const PROPOSAL_TAG = {
    edit: "Change proposed",
    pause: "Pause proposed",
    resume: "Resume proposed",
    cancel: "Cancel proposed",
  };
  const LAPSED_TAG = {
    edit: "Change expired",
    pause: "Pause expired",
    resume: "Resume expired",
    cancel: "Cancel expired",
  };
  /* Why a finished run can't be retried, in a few words. */
  function retryBlock(x) {
    const why = q.canRetry(x);
    if (why.ok || !["rejected", "expired", "cancelled"].includes(x.status)) return null;
    const active = S.runs.find(
      (r) => r.automationId === x.automationId && Lab.RUN_STATUS[r.status]?.active,
    );
    if (active)
      return {
        active: true,
        short:
          active.status === "pending-approval"
            ? "Retry opens once the waiting run is decided."
            : "Retry opens once the current run is dispatched.",
        long: why.reason,
      };
    if (S.runs.some((r) => r.retryOfRunId === x.id)) return { short: "Retried", long: why.reason };
    if (/changed/.test(why.reason ?? ""))
      return { short: "Schedule changed since", long: why.reason };
    return null;
  }

  /* ============================================================ drafts */
  function draftFrom(def) {
    const ex = def.execution;
    const s = def.schedule;
    const p = q.project(ex.projectId);
    const start = s.kind === "once" ? s.runAt : s.startsAt;
    return {
      id: def.id ?? null,
      projectId: ex.projectId,
      deviceId: def.deviceId ?? p?.checkouts[0]?.deviceId ?? "mac",
      title: ex.title ?? "",
      prompt: ex.prompt ?? "",
      modelSelection: sched.clone(ex.modelSelection),
      runtimeMode: ex.runtimeMode ?? "auto-accept-edits",
      envMode: ex.envMode ?? "worktree",
      baseRef: ex.baseRef ?? p?.refs?.[0] ?? "main",
      kind: s.kind,
      start,
      intervalMs: s.intervalMs ?? DAY,
      endsAt: s.endsAt ?? addDays(start, 7),
      enabled: def.enabled !== false,
    };
  }
  const schedOf = (d) =>
    d.kind === "once"
      ? { kind: "once", runAt: d.start }
      : { kind: "fixed-interval", startsAt: d.start, intervalMs: d.intervalMs, endsAt: d.endsAt };
  function defFrom(d) {
    const execution = {
      projectId: d.projectId,
      title: d.title.trim(),
      prompt: d.prompt.trim(),
      modelSelection: sched.clone(d.modelSelection),
      runtimeMode: d.runtimeMode,
      envMode: d.envMode,
    };
    if (d.envMode === "worktree") execution.baseRef = d.baseRef;
    return { execution, schedule: schedOf(d), enabled: d.enabled };
  }
  const validateDraft = (d) => sched.validate({ ...defFrom(d), id: d.id }, S.now, { id: d.id });

  /* ============================================================ background page */
  const THREADS = {
    ryco: ["Automations dialog motion", "Relay reconnect after sleep", "Flaky pairing spec"],
    "ryco-hub": ["Staging certificate rotation", "Ticket TTL review"],
    scratch: [],
  };
  const AGES = ["2m", "1h", "3h", "1d", "2d"];
  const hue = (p) => `<span class="c-hue" style="--hue:${p.hue}" aria-hidden="true"></span>`;
  const CARD_POS = { ryco: [380, 40], "ryco-hub": [380, 286], scratch: [380, 470] };
  const DEV_POS = { mac: [40, 230], studio: [40, 110] };

  function pageHtml() {
    const sb = `
      <aside class="c-sb" aria-label="Sidebar">
        <div class="c-sb-nav">
          <span class="c-sb-item">${ic("plus")}<span>New thread</span><kbd>⌘N</kbd></span>
          <span class="c-sb-item">${ic("search")}<span>Search</span><kbd>⌘K</kbd></span>
          <button type="button" class="c-sb-item c-entry" data-entry="sidebar">${ic("calendarClock")}<span>Automations</span><span class="c-sb-badge tnum" hidden></span></button>
          <span class="c-sb-item">${ic("pr")}<span>Pull requests</span></span>
        </div>
        <div class="c-sb-sec">
          <div class="c-sb-label">Projects</div>
          ${S.projects
            .map(
              (p) => `<div class="c-sb-proj">
                <div class="c-sb-ph">${hue(p)}<span>${esc(p.name)}</span></div>
                ${(THREADS[p.id] ?? [])
                  .map(
                    (t, i) =>
                      `<div class="c-sb-thread${p.id === "ryco" && i === 0 ? " is-on" : ""}"><span class="trunc">${esc(t)}</span><span class="c-sb-age">${AGES[i]}</span></div>`,
                  )
                  .join("")}
                ${(THREADS[p.id] ?? []).length ? "" : `<div class="c-sb-thread is-none">No threads</div>`}
              </div>`,
            )
            .join("")}
        </div>
      </aside>`;
    const devices = S.devices
      .map((dv) => {
        const [x, y] = DEV_POS[dv.id] ?? [40, 360];
        return `<div class="c-node" data-dev="${dv.id}" style="left:${x}px;top:${y}px">${deviceIcon(dv.id)}<span class="c-node-n">${esc(dv.name)}</span><span class="c-node-st"><i></i>Online</span></div>`;
      })
      .join("");
    const cards = S.projects
      .map((p) => {
        const [x, y] = CARD_POS[p.id] ?? [380, 600];
        return `<article class="c-card" data-proj="${p.id}" style="left:${x}px;top:${y}px">
          <header class="c-card-h">${hue(p)}<b>${esc(p.name)}</b><span class="c-card-repo">${esc(p.repo ?? "local only")}</span></header>
          <ul class="c-card-co">${p.checkouts
            .map(
              (c) =>
                `<li data-co="${c.deviceId}">${deviceIcon(c.deviceId)}<span>${esc(devName(c.deviceId))}</span><span class="c-card-path">${esc(c.path)}</span><span class="c-card-br">${ic("branch")}${esc(c.branch)}</span></li>`,
            )
            .join("")}</ul>
          <button type="button" class="c-card-btn c-entry" data-entry="${p.id}">${ic("calendarClock")}<span class="c-card-n"></span><span class="c-card-due"></span>${ic("chevR", "c-card-go")}</button>
        </article>`;
      })
      .join("");
    return `
      <div class="c-page">
        ${sb}
        <main class="c-main">
          <header class="c-bar">
            <span class="c-bar-title">Projects</span>
            <span class="seg c-bar-seg" aria-hidden="true"><span class="seg-opt" aria-checked="true">Map</span><span class="seg-opt">Settings</span></span>
          </header>
          <div class="c-canvas">
            <div class="c-stage">
              <svg class="c-wires" aria-hidden="true"></svg>
              ${devices}
              ${cards}
            </div>
          </div>
        </main>
      </div>`;
  }

  /* ============================================================ ghosts */
  function fixedGhost(parent, cls) {
    const g = h("div", cls);
    g.setAttribute("aria-hidden", "true");
    Object.assign(g.style, {
      position: "fixed",
      left: "0px",
      top: "0px",
      margin: "0",
      pointerEvents: "none",
    });
    parent.append(g);
    const b = g.getBoundingClientRect();
    g._ox = b.left;
    g._oy = b.top;
    return g;
  }
  const boxKf = (g, r, radius, paint) => ({
    left: `${r.left - g._ox}px`,
    top: `${r.top - g._oy}px`,
    width: `${r.width}px`,
    height: `${r.height}px`,
    borderRadius: `${radius}px`,
    backgroundColor: paint.bg,
    boxShadow: paint.shadow,
  });
  function paintOf(el) {
    const c = getComputedStyle(el);
    const bg = c.backgroundColor;
    const border = parseFloat(c.borderTopWidth) > 0 ? c.borderTopColor : "transparent";
    return {
      bg: bg === "rgba(0, 0, 0, 0)" ? "rgba(127, 127, 127, 0.08)" : bg,
      shadow: `inset 0 0 0 1px ${border}`,
      radius: parseFloat(c.borderTopLeftRadius) || 8,
    };
  }
  /* A plate (the surface, never its text) travelling between two boxes: FLIP via
     a ghost. Text never scales — it stays put and cross-fades instead. */
  function flight(parent, o) {
    const g = fixedGhost(parent, "c-ghost");
    const anims = [
      g.animate(
        [
          boxKf(g, o.from, o.fromPaint.radius, o.fromPaint),
          boxKf(g, o.to, o.toPaint.radius, o.toPaint),
        ],
        {
          duration: o.duration,
          easing: o.easing,
          fill: "forwards",
        },
      ),
    ];
    if (o.fadeOut)
      anims.push(
        g.animate([{ opacity: 1 }, { opacity: 1, offset: o.fadeFrom ?? 0.6 }, { opacity: 0 }], {
          duration: o.duration,
          fill: "forwards",
        }),
      );
    return Promise.all(anims.map((a) => a.finished.catch(() => {}))).then(() => g.remove());
  }

  /* ============================================================ mount */
  function mount(host, api) {
    const root = h("div", "c-root");
    root.innerHTML = pageHtml();
    host.append(root);
    const page = $(".c-page", root);
    const sbEntry = $('[data-entry="sidebar"]', root);
    const GROW = morph.PROFILES?.dialog?.grow ?? { easing: EASE, durationMs: 380 };

    const st = {
      pid: q.project(params.get("cproj")) ? params.get("cproj") : "ryco",
      sel: {},
      ed: null,
      pop: null,
      popInst: null,
      popKind: null,
      histAll: {},
      promptAll: {},
      runFocus: {}, // schedule id → run id holding the history's roving tabindex
      lapsed: new Map(), // automationId → a proposal that expired undecided
      undo: null, // { snap, pid } after a discarded draft
    };
    /* A proposal that expires undecided must not vanish: keep it until the user
       proposes it again or dismisses it. (Harmless if the engine stops expiring.) */
    const offEvents = Lab.onEvent((type, p) => {
      if (type === "proposal:new") st.lapsed.delete(p.automationId);
      else if (type === "proposal:decided" && p.status === "expired")
        st.lapsed.set(p.automationId, p);
    });
    let D = null; // the open dialog's elements
    let lastMin = Math.floor(S.now / MIN);
    let pageSig = "";
    const timers = new Set();
    const later = (fn, ms) => {
      const t = setTimeout(() => {
        timers.delete(t);
        fn();
      }, ms);
      timers.add(t);
      return t;
    };

    /* ---- the rail: this direction has no Automations page, so the
       background page is Projects; the rail icon becomes one more entry. */
    const railAuto = $("#rail-auto");
    const railProj = $('.rail-item[data-rail="folder"]');
    const railHadOn = railAuto?.classList.contains("on");
    railAuto?.classList.remove("on");
    railProj?.classList.add("on");
    const onRail = () => openDialog(st.pid, railAuto);
    railAuto?.addEventListener("click", onRail);

    /* ---- entries */
    root.addEventListener("click", (e) => {
      const b = e.target.closest(".c-entry");
      if (!b || !page.contains(b)) return;
      const pid = b.dataset.entry === "sidebar" ? st.pid : b.dataset.entry;
      openDialog(pid, b);
    });

    /* ---- wires on the map */
    const stage = $(".c-stage", root);
    function paintWires() {
      const svg = $(".c-wires", stage);
      if (!svg || !stage.offsetWidth) return;
      const sr = stage.getBoundingClientRect();
      let d = "";
      for (const li of $$(".c-card-co li", stage)) {
        const node = $(`.c-node[data-dev="${li.dataset.co}"]`, stage);
        if (!node) continue;
        const a = node.getBoundingClientRect();
        const b = li.getBoundingClientRect();
        const card = li.closest(".c-card").getBoundingClientRect();
        const x1 = a.right - sr.left;
        const y1 = a.top + a.height / 2 - sr.top;
        const x2 = card.left - sr.left;
        const y2 = b.top + b.height / 2 - sr.top;
        const mx = (x1 + x2) / 2;
        d += `M${x1} ${y1} C${mx} ${y1} ${mx} ${y2} ${x2} ${y2} `;
      }
      svg.innerHTML = `<path d="${d}" />`;
    }
    const ro = new ResizeObserver(() => paintWires());
    ro.observe(stage);
    document.fonts?.ready.then(paintWires);

    function paintPage() {
      const due = q.dueApprovals();
      const parts = [due.length];
      for (const p of S.projects)
        parts.push(q.schedules({ projectId: p.id }).length, q.dueApprovals(p.id).length);
      const sig = parts.join("|");
      if (sig === pageSig) return;
      pageSig = sig;
      const badge = $(".c-sb-badge", root);
      badge.hidden = !due.length;
      badge.textContent = String(due.length);
      sbEntry.setAttribute(
        "aria-label",
        `Automations${due.length ? `, ${plural(due.length, "run")} waiting for approval` : ""}`,
      );
      for (const p of S.projects) {
        const btn = $(`.c-card-btn[data-entry="${p.id}"]`, root);
        const n = q.schedules({ projectId: p.id }).length;
        const w = q.dueApprovals(p.id).length;
        $(".c-card-n", btn).textContent = n ? plural(n, "schedule") : "No schedules";
        const dueEl = $(".c-card-due", btn);
        dueEl.innerHTML = w ? `<span class="dot" data-tone="warn"></span>${w} waiting` : "";
        btn.setAttribute(
          "aria-label",
          `Automations for ${p.name}: ${n ? plural(n, "schedule") : "none yet"}${w ? `, ${w} waiting for approval` : ""}`,
        );
      }
    }

    /* ============================================================ rows */
    function rowsFor(pid) {
      const rows = q.schedules({ projectId: pid });
      for (const r of rows) r.lapsed = r.proposal ? null : (st.lapsed.get(r.id) ?? null);
      // A proposed schedule whose approval request expired stays visible.
      for (const p of st.lapsed.values()) {
        if (p.kind !== "create" || p.projectId !== pid || rows.some((r) => r.id === p.automationId))
          continue;
        rows.push({
          id: p.automationId,
          automation: null,
          proposal: null,
          lapsed: p,
          def: p.after,
          title: p.after?.execution?.title ?? p.title,
          projectId: p.projectId,
          deviceId: p.deviceId,
          state: "lapsed",
          nextRunAt: null,
          dueRun: null,
          activeRun: null,
          lastRun: null,
        });
      }
      const isNew = (r) => (r.state === "pending-create" || r.state === "lapsed" ? 0 : 1);
      return rows.sort(
        (a, b) => isNew(a) - isNew(b) || (a.title || "").localeCompare(b.title || ""),
      );
    }
    const findRow = (id) => (id ? (rowsFor(st.pid).find((r) => r.id === id) ?? null) : null);
    function selectedId(rows = rowsFor(st.pid)) {
      const cur = st.sel[st.pid];
      if (cur && rows.some((r) => r.id === cur)) return cur;
      const due = q.dueApprovals(st.pid)[0];
      const pick = (due && rows.find((r) => r.id === due.automationId)) ?? rows[0];
      st.sel[st.pid] = pick?.id ?? null;
      return st.sel[st.pid];
    }
    const rowEl = (id) => (D ? $(`.c-row[data-key="${CSS.escape(id)}"]`, D.rows) : null);
    const atLimit = (pid = st.pid) => q.activeCount(pid) >= L.perProject;

    /* What one row says. Two fixed lines: title (+ a tag on the right), cadence
       (+ state or the relative next run on the right). */
    function rowModel(r) {
      let meta = "";
      let metaTone = "";
      let soonAt = null;
      switch (r.state) {
        case "awaiting-approval":
          meta = "Waiting for approval";
          metaTone = "fg";
          break;
        case "running":
          meta = Lab.statusLabel(r.activeRun?.status ?? "executing");
          metaTone = "fg";
          break;
        case "paused":
          meta = "Paused";
          break;
        case "finished":
          meta = "Finished";
          break;
        case "pending-create":
          meta = "Not active yet";
          break;
        case "lapsed":
          meta = "Proposal expired";
          metaTone = "fg";
          break;
        default:
          if (r.nextRunAt) soonAt = r.nextRunAt;
      }
      let tag = "";
      let tagTone = "";
      if (r.proposal && r.proposal.kind !== "create") {
        tag = PROPOSAL_TAG[r.proposal.kind] ?? "Change proposed";
        tagTone = "prop";
      } else if (r.lapsed && r.lapsed.kind !== "create") {
        tag = LAPSED_TAG[r.lapsed.kind] ?? "Change expired";
        tagTone = "lapsed";
      } else if (r.lastRun?.status === "failed") {
        tag = "Last run failed";
        tagTone = "err";
      }
      return {
        state: r.state,
        g: r.state,
        title: r.title || "Untitled schedule",
        sum: rowSummary(r.def.schedule),
        meta,
        metaTone,
        soonAt,
        tag,
        tagTone,
      };
    }

    function makeRow(key) {
      const el = h(
        "div",
        "c-row",
        `<span class="c-glyph" aria-hidden="true"></span><span class="c-row-title trunc"></span><span class="c-row-tag"></span><span class="c-row-sum trunc"></span><span class="c-row-meta tnum"></span>`,
      );
      el.setAttribute("role", "option");
      el.dataset.key = key;
      el.dataset.fk = `row:${key}`;
      return el;
    }
    function makeGroup(dv) {
      const el = h("div", "c-group", `${deviceIcon(dv.id)}<span>${esc(dv.name)}</span>`);
      el.setAttribute("role", "presentation");
      el.dataset.key = `g:${dv.id}`;
      return el;
    }
    /* Patch a row in place: never re-innerHTML a row (it may hold focus). */
    function patchRow(el, m, sel, editing) {
      const set = (k, v) => el.getAttribute(k) !== v && el.setAttribute(k, v);
      set("aria-selected", String(sel));
      set("tabindex", sel ? "0" : "-1");
      set("data-state", m.state);
      if (el.hasAttribute("data-editing") !== editing) el.toggleAttribute("data-editing", editing);
      const [glyph, title, tag, sum, meta] = el.children;
      if (glyph.dataset.g !== m.g) glyph.dataset.g = m.g;
      if (title.textContent !== m.title) title.textContent = m.title;
      if (tag.textContent !== m.tag) tag.textContent = m.tag;
      if ((tag.dataset.tone ?? "") !== m.tagTone) tag.dataset.tone = m.tagTone;
      if (sum.textContent !== m.sum) sum.textContent = m.sum;
      if (m.soonAt) {
        if (meta.dataset.soon !== String(m.soonAt)) {
          meta.dataset.soon = String(m.soonAt);
          meta.textContent = rel(m.soonAt);
        }
      } else {
        if (meta.dataset.soon) delete meta.dataset.soon;
        if (meta.textContent !== m.meta) meta.textContent = m.meta;
      }
      if ((meta.dataset.tone ?? "") !== m.metaTone) meta.dataset.tone = m.metaTone;
    }

    /* ---- the header's one-line queue: runs waiting (time-boxed) and changes
       waiting (no deadline). The selected schedule is left out — its detail
       owns that run or change. */
    function renderQueue() {
      if (!D) return;
      const selId = st.ed ? null : st.sel[st.pid];
      const runs = q.dueApprovals(st.pid).filter((r) => r.automationId !== selId);
      const props = S.proposals.filter(
        (p) => p.pending && p.projectId === st.pid && p.automationId !== selId,
      );
      const sig = `${runs.map((r) => r.id)}|${props.map((p) => p.id)}|${!!st.ed}`;
      if (sig === D.lastQueue) return;
      D.lastQueue = sig;
      const dis = st.ed ? ' aria-disabled="true"' : "";
      const parts = [];
      if (runs.length) {
        const r = runs[0];
        const name =
          runs.length === 1
            ? `${r.title}: run waiting for approval, expires ${fmt.time(r.expiresAt)}. Show it`
            : `${runs.length} runs waiting for approval, the first expires ${fmt.time(r.expiresAt)}. Show it`;
        parts.push(
          `<button type="button" class="c-q" data-act="q-run" data-id="${esc(r.automationId)}" data-fk="q-run" aria-label="${esc(name)}"${dis}><span class="c-glyph" data-g="awaiting-approval" aria-hidden="true"></span><span>${plural(runs.length, "run")} waiting</span><span class="c-q-sep" aria-hidden="true">·</span><span class="tnum c-q-left" data-left="${r.expiresAt}"></span></button>`,
        );
      }
      if (props.length) {
        const name = `${plural(props.length, "change")} waiting for your approval. Show ${props.length === 1 ? "it" : "the first"}`;
        parts.push(
          `<button type="button" class="c-q" data-act="q-prop" data-id="${esc(props[0].automationId)}" data-fk="q-prop" aria-label="${esc(name)}"${dis}><span class="c-glyph" data-g="pending-create" aria-hidden="true"></span><span>${plural(props.length, "change")} waiting</span></button>`,
        );
      }
      const html = parts.join(`<span class="c-q-div" aria-hidden="true"></span>`);
      keepFocus(
        D.queue,
        null,
        () => (D.queue.innerHTML = html),
        () => rowEl(st.sel[st.pid]),
      );
      D.queue.hidden = !html;
      paintTicks(D.queue);
    }

    /* ============================================================ detail */
    function diffRows(before, after) {
      const out = [];
      const bs = before.schedule;
      const as = after.schedule;
      if (bs.kind !== as.kind) out.push(["When", sched.label(bs), sched.label(as)]);
      else if (as.kind === "once") {
        if (bs.runAt !== as.runAt) out.push(["Runs at", when(bs.runAt), when(as.runAt)]);
      } else {
        if (bs.intervalMs !== as.intervalMs)
          out.push(["Every", everyWords(bs.intervalMs), everyWords(as.intervalMs)]);
        // A start rolled forward to the same next occurrence is not a change.
        const bn = sched.next(bs) ?? bs.startsAt;
        const samePhase =
          bs.intervalMs === as.intervalMs && (as.startsAt - bs.startsAt) % as.intervalMs === 0;
        if (!samePhase && bn !== as.startsAt) out.push(["Next run", when(bn), when(as.startsAt)]);
        if (bs.endsAt !== as.endsAt) out.push(["Ends", fmt.date(bs.endsAt), fmt.date(as.endsAt)]);
      }
      const be = before.execution;
      const ae = after.execution;
      if (be.title !== ae.title) out.push(["Title", be.title, ae.title]);
      if (be.prompt !== ae.prompt) {
        const add = ae.prompt.startsWith(be.prompt)
          ? ae.prompt.slice(be.prompt.length).trim()
          : null;
        out.push(["Prompt", null, add ? `+ “${add}”` : "Rewritten"]);
      }
      if (
        be.modelSelection.model !== ae.modelSelection.model ||
        be.modelSelection.instanceId !== ae.modelSelection.instanceId
      )
        out.push(["Model", fmt.model(be.modelSelection), fmt.model(ae.modelSelection)]);
      else if (
        fmt.model(be.modelSelection, { effort: true }) !==
        fmt.model(ae.modelSelection, { effort: true })
      )
        out.push([
          "Effort",
          fmt.model(be.modelSelection, { effort: true }),
          fmt.model(ae.modelSelection, { effort: true }),
        ]);
      if (be.runtimeMode !== ae.runtimeMode)
        out.push(["Permissions", fmt.runtimeMode(be.runtimeMode), fmt.runtimeMode(ae.runtimeMode)]);
      if (be.envMode !== ae.envMode)
        out.push(["Runs in", envWords(be.envMode), envWords(ae.envMode)]);
      else if (ae.envMode === "worktree" && (be.baseRef ?? "") !== (ae.baseRef ?? ""))
        out.push(["Branch", be.baseRef ?? "—", ae.baseRef ?? "—"]);
      return out;
    }

    /* A schedule change waiting for the user. Neutral: one hairline, no fill. */
    function proposalHtml(r) {
      const p = r.proposal;
      const a = r.automation;
      let body = "";
      let text = "";
      if (p.kind === "edit") {
        const rows = diffRows(p.before, p.after);
        body = rows.length
          ? `<dl class="c-diff">${rows
              .map(
                ([k, b, af]) =>
                  `<dt>${esc(k)}</dt><dd>${b != null ? `<s>${esc(b)}</s>${ic("chevR", "c-diff-arrow")}<span class="sr-only">changes to</span>` : ""}<span>${esc(af)}</span></dd>`,
              )
              .join("")}</dl>`
          : "";
        text = "The current schedule keeps running until you approve.";
      } else if (p.kind === "pause") {
        text = a?.nextRunAt ? `Still runs ${esc(when(a.nextRunAt))} unless you approve.` : "";
      } else if (p.kind === "resume") {
        const n = sched.next(p.after.schedule);
        text = n ? `Approving resumes it; the first run is ${esc(when(n))}.` : "";
      } else if (p.kind === "cancel") {
        text = "Cancelling is final. The run history stays.";
      }
      const head = {
        create: "New schedule waiting for your approval",
        edit: "Change waiting for your approval",
        pause: "Pause waiting for your approval",
        resume: "Resume waiting for your approval",
        cancel: "Cancel waiting for your approval",
      }[p.kind];
      const aside =
        Number.isFinite(p.expiresAt) && p.expiresAt > S.now
          ? `Expires ${fmt.time(p.expiresAt)}`
          : "";
      return `<section class="c-blk c-blk-prop" aria-label="${esc(head)}">
        <div class="c-blk-h"><span class="c-glyph" data-g="pending-create" aria-hidden="true"></span><b>${esc(head)}</b>${aside ? `<span class="c-blk-aside tnum">${aside}</span>` : ""}</div>
        ${body}
        ${text ? `<p class="c-blk-p">${text}</p>` : ""}
        <div class="c-blk-x">
          <button type="button" class="btn primary sm" data-act="approve-prop" data-p="${p.id}" data-fk="approve-prop">${p.kind === "cancel" ? "Approve cancel" : p.kind === "create" ? "Approve schedule" : "Approve change"}</button>
          <button type="button" class="btn ghost sm" data-act="reject-prop" data-p="${p.id}" data-fk="reject-prop">${p.kind === "create" ? "Withdraw" : "Reject"}</button>
        </div>
      </section>`;
    }

    /* A proposal that expired undecided: say so, offer to propose it again. */
    function lapsedHtml(r) {
      const p = r.lapsed;
      const what = {
        create: "This new schedule",
        edit: "Your change",
        pause: "Your pause",
        resume: "Your resume",
        cancel: "Your cancel",
      }[p.kind];
      const nothing = p.kind === "create" ? "Nothing was created." : "Nothing changed.";
      return `<section class="c-blk c-blk-lapsed" aria-label="Proposal expired">
        <div class="c-blk-h"><span class="c-glyph" data-g="lapsed" aria-hidden="true"></span><b>${what} expired undecided</b><span class="c-blk-aside tnum">${fmt.time(p.expiresAt)}</span></div>
        <p class="c-blk-p">${nothing} Propose it again to ask for approval.</p>
        <div class="c-blk-x">
          <button type="button" class="btn sm" data-act="repropose" data-fk="repropose">Propose again</button>
          <button type="button" class="btn ghost sm" data-act="dismiss-lapsed" data-fk="dismiss-lapsed">${p.kind === "create" ? "Remove" : "Dismiss"}</button>
        </div>
      </section>`;
    }

    /* The due run. The sentence above already says where it runs; this block
       owns the one countdown and the one Approve. Neutral until the last 2 min. */
    function dueHtml(r) {
      const due = r.dueRun;
      const body = due.coalescedOccurrences
        ? `<b>${plural(due.coalescedOccurrences, "missed run")}</b> → approving starts one run now.`
        : "Approving starts one thread now.";
      return `<section class="c-blk c-blk-due" aria-label="Run waiting for approval">
        <div class="c-blk-h"><span class="c-glyph" data-g="awaiting-approval" aria-hidden="true"></span><b>Run for ${esc(when(due.scheduledFor))}</b><span class="c-blk-aside tnum" role="timer" aria-label="Expires ${fmt.time(due.expiresAt)}">Expires ${fmt.time(due.expiresAt)} · <span class="c-blk-cd" data-left="${due.expiresAt}" aria-hidden="true"></span></span></div>
        <p class="c-blk-p">${body}</p>
        <div class="c-blk-x">
          <button type="button" class="btn primary sm" data-act="approve-run" data-run="${due.id}" data-fk="approve-run">Approve run</button>
          <button type="button" class="btn ghost sm" data-act="reject-run" data-run="${due.id}" data-fk="reject-run">Reject</button>
        </div>
        <i class="c-drain" data-drain="${due.expiresAt}" aria-hidden="true"></i>
      </section>`;
    }

    function runText(x) {
      const missed = x.coalescedOccurrences
        ? `<span class="c-run-co">${plural(x.coalescedOccurrences, "missed", "missed")} → 1 · </span>`
        : "";
      if (x.status === "completed") {
        const t = q.thread(x.threadIds?.[0]);
        return `<span class="c-run-t trunc">${missed}${x.retryOfRunId ? `<span class="muted">Retry · </span>` : ""}${esc(t?.title ?? "Thread started")}</span>`;
      }
      if (x.status === "failed")
        return `<span class="c-run-t c-tone-err">${missed}${esc(x.safeFailureDetail ?? "Couldn't start.")}</span>`;
      if (x.status === "expired")
        return `<span class="c-run-t">${missed}Not approved within 15 min</span>`;
      if (x.status === "rejected")
        return `<span class="c-run-t">${missed}Rejected before it started</span>`;
      if (x.status === "cancelled")
        return `<span class="c-run-t">${missed}${esc(x.safeFailureDetail ?? "Cancelled")}</span>`;
      return "";
    }
    function runAction(x, tab) {
      const ti = tab ? "" : ' tabindex="-1"';
      if (x.status === "completed" && x.threadIds?.length)
        return `<button type="button" class="btn ghost xs" data-act="open-thread" data-thread="${esc(x.threadIds[0])}" data-run="${x.id}" data-fk="open:${x.id}"${ti}>Open thread${ic("arrowUpRight")}</button>`;
      if (q.canRetry(x).ok)
        return `<button type="button" class="btn ghost xs" data-act="retry" data-run="${x.id}" data-fk="retry:${x.id}" data-tip="Asks for approval again"${ti}>${ic("retry")}Retry</button>`;
      const blocked = retryBlock(x);
      return blocked && !blocked.active
        ? `<span class="c-run-why" data-tip="${esc(blocked.long)}">${esc(blocked.short)}</span>`
        : "";
    }

    function detailHtml(r) {
      const now = S.now;
      const a = r.automation;
      const def = r.def;
      const ex = def.execution;
      const s = def.schedule;
      const v = sched.validate({ ...def, id: r.id }, now, { id: r.id });
      const paused = a && !a.cancelled && !a.enabled;
      // Resuming is a save with enabled flipped, so the save rules apply.
      const rv = paused
        ? sched.validate({ ...def, enabled: true, id: r.id }, now, { id: r.id })
        : null;
      const chip =
        r.state === "paused"
          ? `<span class="chip">${ic("pause")}Paused</span>`
          : r.state === "finished"
            ? `<span class="chip">Finished</span>`
            : "";
      let actions = "";
      // A paused schedule whose model is gone gets one edit action, not two.
      if (r.state !== "lapsed" && !rv?.errors.model)
        actions += `<button type="button" class="btn sm" data-act="edit" data-fk="edit" data-tip="Edit · E">${ic("edit")}Edit</button>`;
      if (a && !a.cancelled) {
        if (a.enabled && a.nextRunAt != null)
          actions += `<button type="button" class="btn sm" data-act="pause" data-fk="pause">${ic("pause")}Pause</button>`;
        else if (paused) {
          if (rv.errors.model)
            actions += `<button type="button" class="btn sm" data-act="edit" data-fk="resume-model" data-model>${ic("edit")}Edit model to resume</button>`;
          else if (rv.errors.limit)
            actions += `<button type="button" class="btn sm" data-act="resume" data-fk="resume" aria-disabled="true" aria-describedby="c-resume-why">${ic("play")}Resume</button>`;
          else
            actions += `<button type="button" class="btn sm" data-act="resume" data-fk="resume">${ic("play")}Resume</button>`;
        }
        actions += `<button type="button" class="btn sm icon ghost" data-act="more" data-fk="more" aria-label="More actions" aria-haspopup="menu">${ic("moreV")}</button>`;
      }
      const verb =
        r.state === "paused"
          ? "Would run"
          : r.state === "finished"
            ? "Ran"
            : r.state === "pending-create" || r.state === "lapsed"
              ? "Would run"
              : "Runs";
      const where = `in <b>${envWords(ex.envMode)}</b>${ex.envMode === "worktree" && ex.baseRef ? ` off <b class="c-ref">${esc(ex.baseRef)}</b>` : ""} on <b>${esc(devName(r.deviceId))}</b>`;
      const sentence = `${verb} <b>${esc(sched.phrase(s, now))}</b> ${where}.`;
      const modelLine = `${providerMark(ex.modelSelection.instanceId)}<span>${esc(fmt.model(ex.modelSelection, { effort: true }))}</span><span class="sep" aria-hidden="true">·</span><span>${esc(fmt.runtimeMode(ex.runtimeMode))}</span>`;
      let warn = "";
      if (v.errors.model)
        warn = `<p class="c-warnline">${ic("alertCircle")}<span>${esc(v.errors.model)}</span>${paused ? "" : `<button type="button" class="c-link" data-act="edit" data-fk="warn-edit" data-model>Edit model</button>`}</p>`;
      else if (rv?.errors.limit)
        warn = `<p class="c-warnline" id="c-resume-why">${ic("alertCircle")}<span>${esc(rv.errors.limit)}</span></p>`;

      const blocks = [];
      if (r.proposal) blocks.push(proposalHtml(r));
      if (r.lapsed) blocks.push(lapsedHtml(r));
      if (r.dueRun) blocks.push(dueHtml(r));
      if (r.activeRun) {
        const ar = r.activeRun;
        blocks.push(
          `<section class="c-blk c-blk-run"><span class="c-glyph" data-g="running" aria-hidden="true"></span><b>${esc(Lab.statusLabel(ar.status))}</b><span class="muted">${ar.status === "approved" ? "Handing the run to" : "Creating the thread on"} ${esc(devName(r.deviceId))}.</span></section>`,
        );
      }

      // when: relative words + the relative distance; one absolute format.
      let whenHtml;
      if (r.state === "pending-create" || r.state === "lapsed") {
        const n = sched.count(s);
        whenHtml = `First run <b>${esc(when(sched.first(s)))}</b>${s.kind !== "once" ? ` <span class="muted">· ${plural(n, "run")} until ${fmt.date(s.endsAt)}</span>` : ""}`;
      } else if (!a.enabled)
        whenHtml = `<span class="muted">No runs while paused. It ends ${fmt.date(sched.last(s))}.</span>`;
      else if (a.nextRunAt == null)
        whenHtml = `<span class="muted">No runs left. It ended ${fmt.date(sched.last(s))}.</span>`;
      else {
        const more = s.kind === "once" ? 0 : sched.count(s, a.nextRunAt + 1);
        whenHtml = `Next run <b>${esc(when(a.nextRunAt))}</b> <span class="muted tnum">· <span data-rel="${a.nextRunAt}"></span></span>${
          s.kind !== "once"
            ? `<span class="muted"> · ${more ? `${plural(more, "more run")} until ${fmt.date(s.endsAt)}` : "the last one"}</span>`
            : ""
        }`;
      }
      const dst = a?.enabled && a.nextRunAt ? clockChange(s, now) : null;
      const dstHtml = dst
        ? `<p class="c-note">${ic("clock")}<span>${esc(dst.text)}</span></p>`
        : "";

      // prompt
      const long = ex.prompt.length > 220;
      const open = !!st.promptAll[r.id];
      const prompt = `<section class="c-sec"><h4 class="c-sec-h">Prompt</h4><p class="c-prompt${long && !open ? " is-clamped" : ""}">${esc(ex.prompt)}</p>${
        long
          ? `<button type="button" class="c-link" data-act="toggle-prompt" data-fk="toggle-prompt">${open ? "Show less" : "Show all"}</button>`
          : ""
      }</section>`;

      // history: one roving tab stop; ↑/↓ move, Enter acts, U toggles unread
      let hist = "";
      if (a) {
        const runs = q.runsFor(a.id).filter((x) => !Lab.RUN_STATUS[x.status]?.active);
        const all = !!st.histAll[r.id];
        const shown = all ? runs : runs.slice(0, 6);
        const unread = runs.filter((x) => x.unread).length;
        const cur = shown.some((x) => x.id === st.runFocus[r.id])
          ? st.runFocus[r.id]
          : shown[0]?.id;
        const held = shown.map(retryBlock).find((b) => b?.active);
        hist = `<section class="c-sec c-hist"><h4 class="c-sec-h">Runs <span class="muted tnum">${runs.length}${unread ? ` · ${unread} unread` : ""}</span>${held ? `<span class="c-hist-why">${esc(held.short)}</span>` : ""}</h4>${
          runs.length
            ? `<ul class="c-runs" aria-label="Run history">${shown
                .map((x) => {
                  const tab = x.id === cur;
                  return `<li class="c-run" data-run="${x.id}" data-status="${x.status}"${x.unread ? " data-unread" : ""} tabindex="${tab ? 0 : -1}" data-fk="run:${x.id}" aria-label="${esc(`${Lab.statusLabel(x.status)}${x.unread ? ", unread" : ""}, ${when(x.scheduledFor)}`)}">
                    <span class="dot" data-tone="${statusTone(x.status)}" aria-hidden="true"></span>
                    <span class="c-run-l">${esc(Lab.statusLabel(x.status))}</span>
                    <span class="c-run-w tnum">${esc(when(x.scheduledFor))}</span>
                    ${runText(x)}
                    <span class="c-run-a">${runAction(x, tab)}</span>
                  </li>`;
                })
                .join("")}</ul>${
                runs.length > 6
                  ? `<button type="button" class="c-link" data-act="toggle-hist" data-fk="toggle-hist">${all ? "Show fewer" : `Show all ${runs.length}`}</button>`
                  : ""
              }`
            : `<p class="muted c-none">No runs yet.</p>`
        }</section>`;
      }

      return `<header class="c-dh">
          <div class="c-dh-t"><h3 class="c-dtitle">${esc(r.title || "Untitled schedule")}</h3>${chip}</div>
          <div class="c-dh-x">${actions}</div>
        </header>
        <p class="c-sentence-ro">${sentence}</p>
        <p class="c-meta">${modelLine}</p>
        ${warn}
        ${blocks.length ? `<div class="c-blks">${blocks.join("")}</div>` : ""}
        <section class="c-sec c-when"><h4 class="c-sec-h">When</h4><p class="c-when-p">${whenHtml}</p>${dstHtml}</section>
        ${prompt}
        ${hist}`;
    }

    function emptyHtml() {
      const p = q.project(st.pid);
      const co = p?.checkouts[0];
      return `<div class="c-empty">
        <span class="c-empty-ic" aria-hidden="true">${ic("calendarClock")}</span>
        <h3>No schedules in ${esc(p?.name ?? st.pid)}</h3>
        <p>A schedule runs a prompt in <span class="c-path">${esc(co?.path ?? "this checkout")}</span> at the times you pick. Every run waits for your approval before it starts a thread.</p>
        <button type="button" class="btn primary sm" data-act="new" data-fk="empty-new">${ic("plus")}New schedule</button>
      </div>`;
    }

    /* ============================================================ ticking text */
    function paintTicks(scope) {
      if (!scope) return;
      const now = S.now;
      for (const el of scope.querySelectorAll("[data-left]")) {
        const ms = +el.dataset.left - now;
        const t = left(ms);
        if (el.textContent !== t) el.textContent = t;
        const urgent = ms < 2 * MIN;
        if (el.hasAttribute("data-urgent") !== urgent) el.toggleAttribute("data-urgent", urgent);
      }
      for (const el of scope.querySelectorAll("[data-rel]")) {
        const t = rel(+el.dataset.rel, now);
        if (el.textContent !== t) el.textContent = t;
      }
      for (const el of scope.querySelectorAll("[data-soon]")) {
        const t = rel(+el.dataset.soon, now);
        if (el.textContent !== t) el.textContent = t;
      }
      for (const el of scope.querySelectorAll("[data-drain]")) {
        const f = clamp((+el.dataset.drain - now) / TTL, 0, 1);
        el.style.transform = `scaleX(${f.toFixed(4)})`;
      }
    }

    /* Re-render a region without losing focus or scroll. */
    function keepFocus(region, scroller, fn, fallback) {
      const a = document.activeElement;
      const fk = region.contains(a) ? a.closest("[data-fk]")?.dataset.fk : null;
      const top = scroller?.scrollTop ?? 0;
      fn();
      if (scroller) scroller.scrollTop = top;
      if (fk) {
        const el = region.querySelector(`[data-fk="${CSS.escape(fk)}"]`) ?? fallback?.();
        el?.focus({ preventScroll: true });
      }
    }

    /* ============================================================ dialog */
    function openDialog(pid, origin) {
      if (D) return;
      if (pid && q.project(pid)) st.pid = pid;
      const scrim = h("div", "scrim c-scrim");
      const layer = h("div", "c-layer");
      const dlg = h("div", "c-dialog surface");
      dlg.setAttribute("role", "dialog");
      dlg.setAttribute("aria-modal", "true");
      dlg.setAttribute("aria-labelledby", "c-dlg-title");
      dlg.dataset.layer = "";
      dlg.tabIndex = -1;
      dlg.innerHTML = `
        <header class="c-head">
          <h2 class="c-title" id="c-dlg-title">Automations</h2>
          <span class="c-slash" aria-hidden="true">/</span>
          <button type="button" class="c-switch" data-act="switch" data-fk="switch" aria-haspopup="menu"></button>
          <span class="c-cap tnum" hidden></span>
          <span class="c-sp"></span>
          <div class="c-queue" role="group" aria-label="Waiting for you" hidden></div>
          <span class="c-tz" data-tip="Times are local">${ic("clock")}${esc(S.tz)}</span>
          <button type="button" class="btn sm c-new" data-act="new" data-fk="new">${ic("plus")}New schedule</button>
          <button type="button" class="btn ghost sm icon" data-act="close" data-fk="close" aria-label="Close" data-tip="Close · Esc">${ic("x")}</button>
        </header>
        <div class="c-body">
          <div class="c-list"><div class="c-rows" role="listbox"></div></div>
          <div class="c-detail"></div>
        </div>`;
      layer.append(dlg);
      root.append(scrim, layer);
      page.inert = true;
      D = {
        scrim,
        layer,
        dlg,
        body: $(".c-body", dlg),
        list: $(".c-list", dlg),
        rows: $(".c-rows", dlg),
        detail: $(".c-detail", dlg),
        switchBtn: $(".c-switch", dlg),
        cap: $(".c-cap", dlg),
        queue: $(".c-queue", dlg),
        newBtn: $(".c-new", dlg),
        undoBar: null,
        pane: null,
        paneKey: null,
        lastDetail: null,
        lastHead: null,
        lastQueue: null,
        origin,
        closing: false,
      };
      renderHead();
      renderList();
      renderDetail("none");
      renderQueue();
      paintTicks(dlg);
      D.fold = morph.open(dlg, origin, {
        profile: "dialog",
        scrim,
        onClosed: () => {
          layer.remove();
          scrim.remove();
        },
      });
      D.offLayer = Lab.layers.push({ el: dlg, close: (reason) => closeDialog(reason) });
      D.release = Lab.trapFocus(dlg);
      dlg.addEventListener("click", onClick);
      dlg.addEventListener("keydown", onKey);
      scrim.addEventListener("click", () => closeDialog("outside"));
      requestAnimationFrame(() => focusDefault());
    }

    function focusDefault() {
      if (!D) return;
      const el =
        (D.list.offsetParent && $(".c-row[aria-selected=true]", D.rows)) ||
        $('.c-empty [data-act="new"]', D.dlg) ||
        (D.newBtn.offsetParent ? D.newBtn : D.dlg);
      el?.focus({ preventScroll: true });
    }

    function closeDialog(reason = "close") {
      if (!D || D.closing) return;
      // A dirty draft is never thrown away by one stray click or key.
      if (
        st.ed &&
        ["outside", "close"].includes(reason) &&
        editorDirty() &&
        st.ed.confirm !== "close"
      ) {
        editorConfirm("close");
        return;
      }
      const d = D;
      d.closing = true;
      const instant = ["tab", "reset", "destroy"].includes(reason);
      if (st.ed) closeEditor({ instant: true, quiet: true });
      st.undo = null;
      closePop(true);
      d.offLayer();
      d.release();
      page.inert = false;
      D = null;
      Tip.hide();
      if (instant) {
        d.layer.remove();
        d.scrim.remove();
        return;
      }
      const origin = d.origin;
      d.fold(origin).then(() => {
        if (origin?.isConnected && origin.tabIndex >= 0 && root.isConnected)
          origin.focus({ preventScroll: true });
      });
    }

    /* ---- header: switcher, the limit (said once, up top), New */
    function renderHead() {
      const p = q.project(st.pid);
      const editing = !!st.ed;
      const active = q.activeCount(st.pid);
      const full = active >= L.perProject;
      const sig = `${st.pid}|${editing}|${active}`;
      if (sig === D.lastHead) return;
      D.lastHead = sig;
      D.switchBtn.innerHTML = `${hue(p)}<span>${esc(p.name)}</span>${ic("chevsUD", "c-switch-ic")}`;
      D.switchBtn.setAttribute("aria-label", `Project: ${p.name}. Switch project`);
      D.switchBtn.setAttribute("aria-disabled", String(editing));
      if (editing) D.switchBtn.dataset.tip = "Save or discard the edit first";
      else delete D.switchBtn.dataset.tip;
      D.cap.hidden = active < L.perProject - 5;
      D.cap.textContent = `${active} of ${L.perProject} active`;
      D.cap.toggleAttribute("data-full", full);
      const why = full
        ? `${p.name} has ${L.perProject} active schedules, the most a project can have. Pause or cancel one to add another.`
        : "";
      const off = editing || full;
      D.newBtn.toggleAttribute("disabled", editing);
      if (full && !editing) D.newBtn.setAttribute("aria-disabled", "true");
      else D.newBtn.removeAttribute("aria-disabled");
      D.newBtn.dataset.tip = full ? "Pause or cancel one to add another" : "New schedule · N";
      if (why) D.newBtn.setAttribute("aria-description", why);
      else D.newBtn.removeAttribute("aria-description");
      D.newBtn.dataset.off = off ? "true" : "false";
    }

    /* ---- list: keyed rows patched in place (focus and selection survive ticks) */
    function renderList() {
      if (!D) return [];
      const pid = st.pid;
      const rows = rowsFor(pid);
      D.body.classList.toggle("is-empty", !rows.length);
      const box = D.rows;
      const name = `Schedules in ${q.project(pid)?.name ?? pid}`;
      if (box.getAttribute("aria-label") !== name) box.setAttribute("aria-label", name);
      const selId = rows.length ? selectedId(rows) : null;
      const devs = q.projectDevices(pid);
      const items = [];
      const seen = new Set();
      for (const dv of devs) {
        const group = rows.filter((r) => r.deviceId === dv.id);
        if (!group.length) continue;
        if (devs.length > 1) items.push({ key: `g:${dv.id}`, dv });
        for (const r of group) {
          seen.add(r.id);
          items.push({ key: r.id, r });
        }
      }
      for (const r of rows) if (!seen.has(r.id)) items.push({ key: r.id, r });

      const a = document.activeElement;
      const hadFocus = box.contains(a);
      const focusKey = hadFocus ? a.closest("[data-key]")?.dataset.key : null;
      const focusIdx = focusKey
        ? $$(".c-row", box).findIndex((el) => el.dataset.key === focusKey)
        : -1;
      const old = new Map([...box.children].map((el) => [el.dataset.key, el]));
      const fresh = [];
      const editId = st.ed?.d.id ?? null;
      items.forEach((it, i) => {
        let el = old.get(it.key);
        if (el) old.delete(it.key);
        else {
          el = it.dv ? makeGroup(it.dv) : makeRow(it.key);
          fresh.push(el);
        }
        if (it.r) patchRow(el, rowModel(it.r), it.r.id === selId, !!editId && editId === it.r.id);
        const at = box.children[i];
        if (at !== el) box.insertBefore(el, at ?? null);
      });
      for (const el of old.values()) el.remove();
      if (hadFocus && !box.contains(document.activeElement)) {
        const rowsNow = $$(".c-row", box);
        const next =
          (focusKey && rowEl(focusKey)) || rowsNow[clamp(focusIdx, 0, rowsNow.length - 1)];
        next?.focus({ preventScroll: true });
      }
      paintTicks(box);
      return fresh;
    }

    /* ---- detail: panes cross-fade (absolute, so old and new overlap) */
    function makePane(cls, html) {
      const pane = h("div", `c-pane ${cls}`);
      if (html != null) pane.innerHTML = html;
      return pane;
    }
    function swapPane(pane, key, how = "fade") {
      const old = D.pane;
      D.detail.insertBefore(pane, D.undoBar);
      D.pane = pane;
      D.paneKey = key;
      if (old) {
        if (how !== "none" && motionOn()) {
          old.classList.add("is-leaving");
          old.inert = true;
          old
            .animate([{ opacity: 1 }, { opacity: 0 }], { duration: 110, fill: "forwards" })
            .finished.then(
              () => old.remove(),
              () => old.remove(),
            );
        } else old.remove();
      }
      if (how === "fade" && motionOn())
        settle([...pane.children].slice(0, 6), { y: 4, duration: 260, stagger: 22, delay: 40 });
      else if (how === "fade") pane.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 110 });
    }
    function renderDetail(how = "none") {
      if (!D || st.ed) return;
      renderUndo();
      const rows = rowsFor(st.pid);
      if (!rows.length) {
        const html = emptyHtml();
        if (D.paneKey === "empty" && D.lastDetail === html) return;
        D.lastDetail = html;
        if (D.paneKey === "empty") keepFocus(D.pane, D.pane, () => (D.pane.innerHTML = html));
        else swapPane(makePane("c-pane-empty", html), "empty", how);
        return;
      }
      const r = rows.find((x) => x.id === selectedId(rows));
      const html = detailHtml(r);
      if (D.paneKey === r.id && how === "none") {
        if (html === D.lastDetail) {
          paintTicks(D.pane);
          return;
        }
        D.lastDetail = html;
        keepFocus(
          D.pane,
          D.pane,
          () => (D.pane.innerHTML = html),
          () => rowEl(r.id),
        );
      } else {
        D.lastDetail = html;
        const pane = makePane("c-pane-detail", html);
        const lost = D.pane?.contains(document.activeElement);
        swapPane(pane, r.id, how);
        if (lost) rowEl(r.id)?.focus({ preventScroll: true });
      }
      paintTicks(D.pane);
    }

    /* ---- after a discard: recovery lives inside the dialog, reachable by Tab
       (and ⌘Z), until the next edit starts or the dialog closes. */
    function renderUndo() {
      if (!D) return;
      const want = !!st.undo && st.undo.pid === st.pid && !st.ed;
      if (!want) {
        if (D.undoBar) {
          const bar = D.undoBar;
          D.undoBar = null;
          D.detail.classList.remove("has-undo");
          if (bar.contains(document.activeElement))
            (rowEl(st.sel[st.pid]) ?? D.newBtn)?.focus({ preventScroll: true });
          bar.remove();
        }
        return;
      }
      if (D.undoBar) return;
      const bar = h(
        "div",
        "c-undo",
        `<span>Draft discarded.</span><button type="button" class="c-link" data-act="restore" data-fk="restore">Restore</button><kbd aria-hidden="true">⌘Z</kbd><span class="c-sp"></span><button type="button" class="btn ghost xs icon" data-act="undo-dismiss" data-fk="undo-dismiss" aria-label="Dismiss">${ic("x")}</button>`,
      );
      bar.setAttribute("role", "status");
      D.detail.append(bar);
      D.detail.classList.add("has-undo");
      D.undoBar = bar;
      if (motionOn())
        bar.animate(
          [
            { opacity: 0, translate: "0 6px" },
            { opacity: 1, translate: "0 0" },
          ],
          { duration: 220, easing: EASE },
        );
    }
    function restoreDraft() {
      const u = st.undo;
      if (!D || st.ed || !u) return;
      if (u.snap.id && !findRow(u.snap.id)) {
        st.undo = null;
        renderUndo();
        return;
      }
      st.undo = null;
      renderUndo();
      openEditor(u.snap.id, D.newBtn, {
        draft: u.snap.draft,
        init: u.snap.init,
        isNew: u.snap.isNew,
      });
    }

    function select(id, o = {}) {
      if (!D || st.ed || !id) return;
      const changed = st.sel[st.pid] !== id;
      st.sel[st.pid] = id;
      renderList();
      renderQueue();
      if (changed) renderDetail(o.how ?? "fade");
      if (o.focus !== false) rowEl(id)?.focus({ preventScroll: true });
      rowEl(id)?.scrollIntoView({ block: "nearest" });
    }

    function switchProject(pid) {
      if (!D || st.ed || pid === st.pid) return;
      st.pid = pid;
      renderHead();
      for (const el of [...D.rows.children]) el.remove();
      const fresh = renderList();
      if (motionOn()) settle(fresh.slice(0, 8), { y: 5, duration: 300, stagger: 18 });
      renderQueue();
      renderDetail("fade");
      paintTicks(D.dlg);
    }

    /* ============================================================ popovers */
    function closePop(instant) {
      const p = st.pop;
      st.pop = null;
      if (p) p.close(null, instant ? "close" : "close");
    }

    /* Where a popover opened from the editor goes: under the whole sentence (so
       it stays readable while you pick), at the token's x, inside the dialog;
       above the sentence when the dialog has no room below. */
    const realRect = (el) => Element.prototype.getBoundingClientRect.call(el);
    function desiredSpot(anchor, pop, gap) {
      const dr = realRect(D.dlg);
      const a = realRect(anchor);
      const sentence = anchor.closest(".c-sentence");
      const ref = sentence ? realRect(sentence) : a;
      const w = pop.offsetWidth;
      const ht = pop.offsetHeight;
      const pad = 12;
      const left = clamp(a.left, dr.left + pad, Math.max(dr.left + pad, dr.right - pad - w));
      let top = ref.bottom + gap;
      if (top + ht > dr.bottom - pad) {
        const above = ref.top - gap - ht;
        top = above >= dr.top + pad ? above : Math.max(dr.top + pad, dr.bottom - pad - ht);
      }
      return { left, top };
    }
    /* core popover() places against the viewport; steer its first read of the
       anchor so it lands (and morphs) at our spot, then keep it there. */
    function steer(anchor, content, gap) {
      anchor.getBoundingClientRect = function () {
        delete anchor.getBoundingClientRect;
        const real = realRect(anchor);
        const pop = content.closest(".pop");
        if (!D || !pop) return real;
        const { left, top } = desiredSpot(anchor, pop, gap);
        return new DOMRect(left, top - gap - 1, real.width, 1);
      };
    }
    function pin(api, anchor, gap) {
      const pop = api.el;
      const go = () => {
        if (!D || !pop.isConnected) return;
        const cur = pop.getBoundingClientRect();
        const { left, top } = desiredSpot(anchor, pop, gap);
        if (Math.abs(cur.left - left) < 0.5 && Math.abs(cur.top - top) < 0.5) return;
        pop.style.left = `${(parseFloat(pop.style.left) || 0) + left - cur.left}px`;
        pop.style.top = `${(parseFloat(pop.style.top) || 0) + top - cur.top}px`;
      };
      window.addEventListener("resize", go);
      document.addEventListener("scroll", go, true);
      const ro = new ResizeObserver(go);
      ro.observe(pop);
      return () => {
        window.removeEventListener("resize", go);
        document.removeEventListener("scroll", go, true);
        ro.disconnect();
      };
    }
    function openPop(anchor, content, o) {
      const steered = !!(st.ed && D?.dlg.contains(anchor));
      const gap = o.gap ?? 6;
      if (steered) {
        content.style.maxWidth = `${Math.max(240, realRect(D.dlg).width - 48)}px`;
        steer(anchor, content, gap);
      }
      let unpin = () => {};
      const api = popover(anchor, content, {
        ...o,
        gap,
        placement: steered ? "bottom-start" : o.placement,
        onClose: (reason) => {
          unpin();
          o.onClose?.(reason);
        },
      });
      if (Object.hasOwn(anchor, "getBoundingClientRect")) delete anchor.getBoundingClientRect;
      if (api && steered) unpin = pin(api, anchor, gap);
      return api;
    }

    /* First-letter type-ahead for menus (cycles through matches). */
    function typeAhead(e, items) {
      if (e.key.length !== 1 || e.metaKey || e.ctrlKey || e.altKey || !/\S/.test(e.key))
        return false;
      const k = e.key.toLowerCase();
      const i = items.indexOf(document.activeElement);
      const order = [...items.slice(i + 1), ...items.slice(0, i + 1)];
      const hit = order.find((b) =>
        (b.dataset.label ?? b.textContent).trim().toLowerCase().startsWith(k),
      );
      if (hit) hit.focus();
      return true;
    }

    let menuSeq = 0;
    function menuPop(anchor, o) {
      const el = h("div", "menu c-menu");
      el.setAttribute("role", "menu");
      if (o.label) el.setAttribute("aria-label", o.label);
      let i = 0;
      for (const it of o.items) {
        if (it.group) {
          const lab = h("div", "menu-label", esc(it.group));
          lab.setAttribute("aria-hidden", "true");
          el.append(lab);
          continue;
        }
        if (it.sep) {
          el.append(h("div", "menu-sep"));
          continue;
        }
        const on = it.value === o.value;
        const hintId = it.hint ? `c-mh-${++menuSeq}` : "";
        const b = h(
          "button",
          `menu-item${it.hint ? " c-mi2" : ""}${it.destructive ? " destructive" : ""}`,
          `${it.icon ?? ""}<span class="c-mi-t"><span class="c-mi-l">${esc(it.label)}</span>${it.hint ? `<span class="c-mi-h" id="${hintId}">${esc(it.hint)}</span>` : ""}</span>${it.aside ? `<span class="c-mi-a" aria-hidden="true">${it.aside}</span>` : ""}${on ? ic("check", "c-mi-ck") : ""}`,
        );
        b.type = "button";
        b.dataset.label = it.label;
        b.setAttribute("aria-label", it.ariaLabel ?? it.label);
        if (hintId) b.setAttribute("aria-describedby", hintId);
        b.setAttribute("role", o.radio === false ? "menuitem" : "menuitemradio");
        if (o.radio !== false) b.setAttribute("aria-checked", String(on));
        b.dataset.i = String(i++);
        if (on) b.dataset.on = "";
        b.addEventListener("click", () => {
          api?.close();
          o.onPick(it);
        });
        el.append(b);
      }
      el.addEventListener("keydown", (e) => {
        const items = $$(".menu-item", el);
        const k = items.indexOf(document.activeElement);
        let n = -1;
        if (e.key === "ArrowDown") n = (k + 1) % items.length;
        else if (e.key === "ArrowUp") n = (k - 1 + items.length) % items.length;
        else if (e.key === "Home") n = 0;
        else if (e.key === "End") n = items.length - 1;
        else if (e.key === "Tab") {
          e.preventDefault();
          api?.close();
          return;
        } else if (typeAhead(e, items)) {
          e.preventDefault();
          return;
        }
        if (n < 0) return;
        e.preventDefault();
        items[n].focus();
      });
      const api = openPop(anchor, el, {
        placement: o.placement ?? "bottom-start",
        className: "c-pop",
        role: "presentation",
        width: o.width,
        initialFocus: $(".menu-item[data-on]", el) ?? $(".menu-item", el),
        onClose: () => {
          if (st.pop === api) st.pop = null;
        },
      });
      if (api) st.pop = api;
      return api;
    }

    /* The model picker with its effort dial in one popover (the app's model
       picker): picking a model closes it; turning the dial keeps it open. */
    function modelPop(anchor) {
      const ed = st.ed;
      if (!ed) return null;
      const d = ed.d;
      const wrap = h("div", "c-model");
      const menu = h("div", "menu c-menu");
      menu.setAttribute("role", "menu");
      menu.setAttribute("aria-label", "Model");
      for (const p of S.providers) {
        const lab = h("div", "menu-label", esc(p.name));
        lab.setAttribute("aria-hidden", "true");
        menu.append(lab);
        for (const m of p.models) {
          const on =
            p.instanceId === d.modelSelection.instanceId && m.slug === d.modelSelection.model;
          const b = h(
            "button",
            "menu-item",
            `${providerMark(p.instanceId)}<span class="c-mi-t"><span class="c-mi-l">${esc(m.name)}</span></span>${on ? ic("check", "c-mi-ck") : ""}`,
          );
          b.type = "button";
          b.setAttribute("role", "menuitemradio");
          b.setAttribute("aria-checked", String(on));
          b.setAttribute("aria-label", `${m.name}, ${p.name}`);
          b.dataset.label = m.name;
          b.tabIndex = on ? 0 : -1;
          if (on) b.dataset.on = "";
          b.addEventListener("click", () => {
            const prov = q.provider(p.instanceId);
            const same = p.instanceId === d.modelSelection.instanceId;
            const effort = prov.options?.find((x) => x.id === "effort");
            d.modelSelection = {
              instanceId: p.instanceId,
              model: m.slug,
              options: effort
                ? [
                    {
                      id: "effort",
                      value:
                        (same && d.modelSelection.options?.find((x) => x.id === "effort")?.value) ||
                        effort.default,
                    },
                  ]
                : [],
            };
            paintOpts();
            changed();
            api?.close();
          });
          menu.append(b);
        }
      }
      if (!$(".menu-item[data-on]", menu)) $(".menu-item", menu).tabIndex = 0;
      const dial = h("div", "c-dial");
      wrap.append(menu, dial);
      let dialPlate = null;
      function paintDial() {
        dialPlate?.destroy();
        dialPlate = null;
        const prov = q.provider(d.modelSelection.instanceId);
        const opt = prov?.options?.find((x) => x.id === "effort");
        dial.hidden = !opt;
        if (!opt) return;
        const cur = d.modelSelection.options?.find((x) => x.id === "effort")?.value ?? opt.default;
        dial.innerHTML = `<span class="c-dial-l" id="c-dial-l">${esc(opt.label)}</span><div class="seg c-dial-seg" role="radiogroup" aria-labelledby="c-dial-l">${opt.values
          .map(
            (x) =>
              `<button type="button" class="seg-opt" role="radio" data-v="${esc(x.id)}" aria-checked="${x.id === cur}" tabindex="${x.id === cur ? 0 : -1}">${esc(x.label)}</button>`,
          )
          .join("")}</div>`;
        dialPlate = plate($(".c-dial-seg", dial));
      }
      function setEffort(v, focus) {
        d.modelSelection.options = [{ id: "effort", value: v }];
        for (const b of $$("[data-v]", dial)) {
          const on = b.dataset.v === v;
          b.setAttribute("aria-checked", String(on));
          b.tabIndex = on ? 0 : -1;
          if (on && focus) b.focus();
        }
        paintOpts();
        changed();
      }
      paintDial();
      dial.addEventListener("click", (e) => {
        const b = e.target.closest("[data-v]");
        if (b) setEffort(b.dataset.v, true);
      });
      dial.addEventListener("keydown", (e) => {
        const bs = $$("[data-v]", dial);
        const k = bs.findIndex((b) => b.getAttribute("aria-checked") === "true");
        let n = -1;
        if (e.key === "ArrowRight" || e.key === "ArrowDown") n = Math.min(bs.length - 1, k + 1);
        else if (e.key === "ArrowLeft" || e.key === "ArrowUp") n = Math.max(0, k - 1);
        else if (e.key === "Home") n = 0;
        else if (e.key === "End") n = bs.length - 1;
        if (n < 0) return;
        e.preventDefault();
        setEffort(bs[n].dataset.v, true);
      });
      menu.addEventListener("keydown", (e) => {
        const items = $$(".menu-item", menu);
        const k = items.indexOf(document.activeElement);
        let n = -1;
        if (e.key === "ArrowDown") n = (k + 1) % items.length;
        else if (e.key === "ArrowUp") n = (k - 1 + items.length) % items.length;
        else if (e.key === "Home") n = 0;
        else if (e.key === "End") n = items.length - 1;
        else if (typeAhead(e, items)) {
          e.preventDefault();
          return;
        }
        if (n < 0) return;
        e.preventDefault();
        items[n].focus();
      });
      const api = openPop(anchor, wrap, {
        className: "c-pop",
        role: "dialog",
        initialFocus: $(".menu-item[data-on]", menu) ?? $(".menu-item", menu),
        onClose: () => {
          if (st.pop === api) st.pop = null;
          setTimeout(() => dialPlate?.destroy(), 320);
        },
      });
      if (!api) return null;
      api.el.setAttribute("aria-label", "Model and effort");
      api.el.addEventListener("focusout", (e) => {
        const to = e.relatedTarget;
        if (to && !api.el.contains(to) && st.pop === api) api.close(null, "blur");
      });
      st.pop = api;
      return api;
    }

    /* A Picker in a token popover. The content is built off-screen first so
       the popover grows to its real size. */
    let ppSeq = 0;
    function pickerPop(anchor, title, build, o = {}) {
      if (st.pop && st.pop.anchor === anchor) {
        closePop();
        return null;
      }
      closePop();
      const wrap = h("div", "c-pp");
      const hid = `c-pp-h-${++ppSeq}`;
      wrap.innerHTML = `<div class="c-pp-h" id="${hid}">${esc(title)}</div>`;
      const body = h("div", "c-pp-b");
      wrap.append(body);
      Object.assign(wrap.style, {
        position: "fixed",
        left: "-10000px",
        top: "0px",
        visibility: "hidden",
        maxWidth: `${Math.max(240, realRect(D.dlg).width - 48)}px`,
      });
      D.dlg.append(wrap);
      const inst = build(body);
      wrap.style.position = wrap.style.left = wrap.style.top = wrap.style.visibility = "";
      let closeSoon = false;
      const api = openPop(anchor, wrap, {
        className: "c-pop",
        gap: 8,
        initialFocus: o.initialFocus ? $(o.initialFocus, wrap) : undefined,
        onClose: () => {
          if (st.pop === api) {
            st.pop = null;
            st.popInst = null;
            st.popKind = null;
          }
          setTimeout(() => inst.destroy?.(), 320);
        },
      });
      if (!api) {
        inst.destroy?.();
        wrap.remove();
        return null;
      }
      api.el.setAttribute("aria-labelledby", hid);
      st.pop = api;
      st.popInst = inst;
      st.popKind = o.kind;
      api.closeSoon = () => {
        closeSoon = false;
        setTimeout(() => st.pop === api && api.close(), 170);
      };
      api.wantsClose = () => closeSoon;
      // Enter in the typed field / a suggestion click accepts and closes.
      wrap.addEventListener(
        "keydown",
        (e) => {
          if (e.key === "Enter" && e.target.matches?.(".pk-input")) closeSoon = true;
        },
        true,
      );
      wrap.addEventListener(
        "pointerdown",
        (e) => {
          if (e.target.closest?.(".pk-opt")) closeSoon = true;
        },
        true,
      );
      if (o.autoClose)
        wrap.addEventListener("click", (e) => {
          const b = e.target.closest(o.autoClose);
          if (b && b.getAttribute("aria-disabled") !== "true") api.closeSoon();
        });
      api.el.addEventListener("focusout", (e) => {
        const to = e.relatedTarget;
        if (to && !api.el.contains(to) && st.pop === api) api.close(null, "blur");
      });
      if (o.initialText != null) requestAnimationFrame(() => inst.setText?.(o.initialText));
      return api;
    }

    /* ============================================================ editor */
    function editorSkeleton(d, isNew) {
      const devs = q.projectDevices(d.projectId);
      const deviceTok =
        isNew && devs.length > 1
          ? `<button type="button" class="c-tok" data-tok="device" aria-haspopup="menu"></button>`
          : `<span class="c-tok is-static" data-tok-static="device" ${isNew ? "" : 'data-tip="A schedule stays on the device it was created on"'}></span>`;
      return `<div class="c-ed-scroll"><div class="c-ed-in">
          <header class="c-dh c-ed-h">
            <div class="c-dh-t"><input class="c-title-in" type="text" aria-label="Title" placeholder="Name this schedule" maxlength="${L.titleMax}" spellcheck="false" autocomplete="off"></div>
            <div class="c-dh-x">
              <div class="seg c-kind" role="radiogroup" aria-label="How often">
                <button type="button" class="seg-opt" role="radio" data-kind="fixed-interval">${ic("repeat")}Repeats</button>
                <button type="button" class="seg-opt" role="radio" data-kind="once">Once</button>
              </div>
            </div>
          </header>
          <fieldset class="c-sentence">
            <legend class="sr-only">When and where it runs</legend>
            <span class="c-pair" data-m="repeat"><span class="c-w">Every</span> <button type="button" class="c-tok" data-tok="interval" aria-haspopup="dialog"></button></span>
            <span class="c-pair"><span class="c-w c-startw"></span> <button type="button" class="c-tok" data-tok="start" aria-haspopup="dialog"></button></span>
            <span class="c-pair" data-m="repeat"><span class="c-w c-conn"></span> <button type="button" class="c-tok" data-tok="end" aria-haspopup="dialog"></button></span>
            <span class="c-pair"><span class="c-w">on</span> ${deviceTok}</span>
            <span class="c-pair"><span class="c-w">in</span> <button type="button" class="c-tok" data-tok="env" aria-haspopup="menu"></button></span>
            <span class="c-pair" data-m="worktree"><span class="c-w">off</span> <button type="button" class="c-tok c-tok-ref" data-tok="ref" aria-haspopup="menu"></button></span>
          </fieldset>
          <div class="c-msgs" aria-live="polite"></div>
          <div class="c-pv"></div>
          <div class="c-agent">
            <button type="button" class="c-pick" data-tok="model" aria-haspopup="dialog"></button>
            <button type="button" class="c-pick" data-tok="mode" aria-haspopup="menu"></button>
          </div>
          <p class="c-ferr" data-for="model"></p>
          <div class="c-fld">
            <div class="c-fld-h"><label class="label" for="c-prompt-in">Prompt</label><span class="c-count tnum"></span></div>
            <textarea class="field c-prompt-in" id="c-prompt-in" rows="5" placeholder="What should the agent do on each run?"></textarea>
            <p class="c-ferr" data-for="prompt"></p>
          </div>
        </div></div>
        <footer class="c-ed-foot">
          <p class="c-ed-hint" aria-live="polite"></p>
          <button type="button" class="btn ghost sm" data-act="discard">Discard</button>
          <button type="button" class="btn primary sm c-save" data-act="save">Save for approval<span class="c-kbd-in" aria-hidden="true">⌘↵</span></button>
        </footer>`;
    }

    const editorDirty = () => !!st.ed && JSON.stringify(defFrom(st.ed.d)) !== st.ed.init;

    function openEditor(id, origin, o = {}) {
      if (!D || st.ed) return;
      const r = id ? findRow(id) : null;
      if (!r && !o.draft && atLimit()) return;
      closePop(true);
      st.undo = null;
      let d;
      if (o.draft) d = { ...o.draft, modelSelection: sched.clone(o.draft.modelSelection) };
      else if (o.src) d = draftFrom(sched.draftOf(o.src));
      else if (r) {
        const src =
          r.proposal?.kind === "edit" || !r.automation ? (r.proposal ?? r.lapsed) : r.automation;
        d = draftFrom(sched.draftOf(src));
      } else d = draftFrom({ ...sched.blank(st.pid), id: null });
      const isNew = o.isNew ?? !r?.automation;
      const initial = o.init ?? JSON.stringify(defFrom(d));
      // Editing from the detail: the title is already where the editor's title
      // goes, so nothing travels. New: the plate grows out of its button.
      const fromDetail = !!r && D.paneKey === r.id && !o.draft;
      const src = origin ?? D.newBtn;
      const srcRect = !fromDetail && src?.isConnected ? src.getBoundingClientRect() : null;
      const srcPaint = srcRect ? paintOf(src) : null;

      const pane = makePane("c-ed", editorSkeleton(d, isNew));
      pane.setAttribute("role", "region");
      pane.setAttribute("aria-label", isNew ? "New schedule" : `Edit ${d.title}`);
      const els = {
        pane,
        head: $(".c-ed-h", pane),
        title: $(".c-title-in", pane),
        kind: $(".c-kind", pane),
        sentence: $(".c-sentence", pane),
        msgs: $(".c-msgs", pane),
        pvHost: $(".c-pv", pane),
        prompt: $(".c-prompt-in", pane),
        count: $(".c-count", pane),
        hint: $(".c-ed-hint", pane),
        save: $(".c-save", pane),
        discard: $('[data-act="discard"]', pane),
      };
      st.ed = {
        d,
        init: initial,
        isNew,
        originId: r?.id ?? null,
        origin: src,
        els,
        attempted: false,
        touched: {},
        confirm: null,
        lastHint: null,
        lastOpts: null,
      };

      els.title.value = d.title;
      els.prompt.value = d.prompt;
      els.title.addEventListener("input", () => {
        d.title = els.title.value;
        changed();
      });
      els.title.addEventListener("blur", () => {
        if (d.title.trim()) st.ed && (st.ed.touched.title = true);
        paintValidation();
      });
      els.title.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !(e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          $(`.c-tok[data-tok="${d.kind === "once" ? "start" : "interval"}"]`, pane)?.focus();
        }
      });
      els.prompt.addEventListener("input", () => {
        d.prompt = els.prompt.value;
        changed();
      });
      els.prompt.addEventListener("blur", () => {
        if (d.prompt.trim()) st.ed && (st.ed.touched.prompt = true);
        paintValidation();
      });
      // Repeats | Once
      els.kindPlate = plate(els.kind);
      els.kind.addEventListener("click", (e) => {
        const b = e.target.closest("[data-kind]");
        if (b) setKind(b.dataset.kind);
      });
      els.kind.addEventListener("keydown", (e) => {
        if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
        e.preventDefault();
        const next = d.kind === "once" ? "fixed-interval" : "once";
        setKind(next);
        $(`[data-kind="${next}"]`, els.kind).focus();
      });
      // tokens: Enter/Space click; ↓ opens; a printable key on "start" types into it
      pane.addEventListener("keydown", (e) => {
        const tok = e.target.closest?.("[data-tok]");
        if (!tok || e.metaKey || e.ctrlKey || e.altKey) return;
        if (e.key === "ArrowDown") {
          e.preventDefault();
          openToken(tok.dataset.tok, tok);
        } else if (tok.dataset.tok === "start" && e.key.length === 1 && e.key !== " ") {
          e.preventDefault();
          openToken("start", tok, e.key);
        }
      });

      els.pv = PK()?.preview(els.pvHost, {
        schedule: schedOf(d),
        nowMs: S.now,
        title: "Next runs",
      });

      paintSentence(true);
      paintOpts();
      paintValidation();

      // swap in place
      D.body.dataset.editing = "true";
      D.list.inert = true;
      renderHead();
      renderList();
      renderQueue();
      renderUndo();
      const prev = D.pane;
      D.detail.insertBefore(pane, D.undoBar);
      D.pane = pane;
      D.paneKey = "editor";
      st.ed.off = Lab.layers.push({ el: pane, close: (reason) => editorEscape(reason) });

      const motion = motionOn() && !o.instant;
      if (prev) {
        prev.inert = true;
        if (motion) {
          prev.classList.add("is-leaving");
          prev
            .animate([{ opacity: 1 }, { opacity: 0 }], { duration: 90, fill: "forwards" })
            .finished.then(
              () => prev.remove(),
              () => prev.remove(),
            );
        } else prev.remove();
      }
      const kids = [...$(".c-ed-in", pane).children];
      if (motion) {
        const flying = srcRect && srcRect.width > 0;
        const dur = Math.min(GROW.durationMs, 520);
        const reveal = flying ? dur * 0.36 : 40;
        kids.forEach((c, i) => {
          // From the detail, the header (title) stays exactly where it was.
          if (fromDetail && c === els.head) {
            $(".c-dh-x", c).animate([{ opacity: 0 }, { opacity: 1 }], {
              duration: 160,
              fill: "backwards",
            });
            return;
          }
          c.animate(
            [
              { opacity: 0, translate: "0 6px" },
              { opacity: 1, translate: "0 0" },
            ],
            { duration: 260, delay: reveal + Math.min(i, 6) * 36, easing: EASE, fill: "backwards" },
          );
        });
        $(".c-ed-foot", pane).animate([{ opacity: 0 }, { opacity: 1 }], {
          duration: 200,
          delay: reveal + 120,
          fill: "backwards",
        });
        if (flying) {
          const to = els.head.getBoundingClientRect();
          flight(D.dlg, {
            from: srcRect,
            to,
            fromPaint: srcPaint,
            toPaint: {
              bg: "rgba(127, 127, 127, 0.06)",
              shadow: "inset 0 0 0 1px transparent",
              radius: 8,
            },
            duration: dur,
            easing: GROW.easing,
            fadeOut: true,
            fadeFrom: 0.55,
          });
        }
      } else if (!o.instant) pane.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 120 });

      requestAnimationFrame(() => {
        if (!st.ed) return;
        if (o.focusModel) $('[data-tok="model"]', pane)?.focus({ preventScroll: true });
        else {
          els.title.focus({ preventScroll: true });
          const n = els.title.value.length;
          els.title.setSelectionRange(n, n);
        }
      });
    }

    /* Escape on the editor: a dirty draft asks once, in the footer. */
    function editorEscape(reason) {
      if (!st.ed) return;
      if (reason === "escape" && editorDirty() && !st.ed.confirm) {
        editorConfirm("escape");
        return;
      }
      closeEditor({ reason, discarded: true });
    }
    function editorConfirm(kind) {
      const ed = st.ed;
      if (!ed) return;
      ed.confirm = kind;
      closePop(true);
      paintHint();
      ed.els.discard.dataset.confirm = "";
    }
    function clearConfirm() {
      const ed = st.ed;
      if (!ed?.confirm) return;
      ed.confirm = null;
      delete ed.els.discard.dataset.confirm;
      paintHint();
    }

    function setKind(kind) {
      const ed = st.ed;
      if (!ed || ed.d.kind === kind) return;
      ed.d.kind = kind;
      closePop();
      paintSentence(false, true);
      changed();
    }

    function paintSentence(first, fade) {
      const ed = st.ed;
      if (!ed) return;
      const { d, els } = ed;
      const pane = els.pane;
      const now = S.now;
      for (const b of $$("[data-kind]", els.kind)) {
        b.setAttribute("aria-checked", String(b.dataset.kind === d.kind));
        b.tabIndex = b.dataset.kind === d.kind ? 0 : -1;
      }
      const show = [];
      for (const m of $$(".c-pair[data-m]", pane)) {
        const want = m.dataset.m === "repeat" ? d.kind !== "once" : d.envMode === "worktree";
        if (m.hidden === !want) continue;
        m.hidden = !want;
        if (want) show.push(m);
      }
      if (fade && !first) {
        for (const m of show)
          m.animate([{ opacity: 0 }, { opacity: 1 }], {
            duration: motionOn() ? 200 : 100,
            easing: "ease-out",
          });
        if (motionOn())
          els.sentence.animate([{ opacity: 0.6 }, { opacity: 1 }], {
            duration: 200,
            easing: "ease-out",
          });
      }
      const set = (sel, text, label) => {
        const el = $(sel, pane);
        if (!el) return;
        if (el.textContent !== text) el.textContent = text;
        if (label && el.getAttribute("aria-label") !== label) el.setAttribute("aria-label", label);
      };
      const iv = everyWords(d.intervalMs);
      set('[data-tok="interval"]', iv, `Repeat interval: every ${iv}`);
      set(".c-startw", d.kind === "once" ? "Once," : "from");
      const sw = when(d.start, now);
      const abs = sw === fmt.dateTime(d.start) ? "" : `, ${fmt.day(d.start)}`;
      set('[data-tok="start"]', sw, `${d.kind === "once" ? "Runs at" : "First run"}: ${sw}${abs}`);
      const ew = endWords(d.start, d.endsAt);
      set(".c-conn", ew.conn);
      set('[data-tok="end"]', ew.text, `Ends: ${ew.conn} ${ew.text}`);
      const dev = devName(d.deviceId);
      set('[data-tok="device"]', dev, `Device: ${dev}`);
      set('[data-tok-static="device"]', dev);
      set('[data-tok="env"]', envWords(d.envMode), `Runs in: ${envWords(d.envMode)}`);
      set('[data-tok="ref"]', d.baseRef, `Branch: ${d.baseRef}`);
    }

    function paintOpts() {
      const ed = st.ed;
      if (!ed) return;
      const { d, els } = ed;
      const sel = d.modelSelection;
      const chev = ic("chevsUD", "c-pick-ic");
      const html =
        `<span class="c-pick-l">Model</span>${providerMark(sel.instanceId)}<span>${esc(fmt.model(sel, { effort: true }))}</span>${chev}` +
        `\u0000<span class="c-pick-l">Permissions</span><span>${esc(fmt.runtimeMode(d.runtimeMode))}</span>${chev}`;
      if (html === ed.lastOpts) return;
      ed.lastOpts = html;
      const [m, p] = html.split("\u0000");
      $('[data-tok="model"]', els.pane).innerHTML = m;
      $('[data-tok="mode"]', els.pane).innerHTML = p;
    }

    function startFix(d) {
      const now = S.now;
      if (d.kind !== "once") {
        const rolled = sched.rollForward(schedOf(d), now);
        if (rolled.startsAt > now && rolled.startsAt <= now + L.horizonMs) return rolled.startsAt;
      }
      return ceilQuarter(now + MIN);
    }

    /* Inline validation. Messages are minute-stable words; the region is patched
       per message (keyed), so typing or a clock tick never re-announces it and a
       focused fix button is never destroyed. */
    function wantMsgs(ed, e, now) {
      const d = ed.d;
      const out = [];
      if (e.start) {
        const past = d.start <= now;
        const f = past ? startFix(d) : ceilQuarter(now + L.horizonMs - 15 * MIN);
        out.push({
          key: "start",
          text: past
            ? d.kind === "once"
              ? "That time has passed."
              : "Starts in the past."
            : "More than 90 days ahead.",
          fix: { label: `Use ${when(f, now)}`, v: f },
        });
      }
      if (e.interval)
        out.push({
          key: "interval",
          text: "Under the 15-minute minimum.",
          fix: { label: "Use 15 minutes", v: 15 * MIN },
        });
      if (e.end) {
        const horizon = floorMin(now + L.horizonMs);
        if (d.endsAt < d.start) {
          const f = Math.min(addDays(d.start, 7), horizon);
          out.push({
            key: "end",
            text: "Ends before the first run.",
            fix: f >= d.start ? { label: `End ${fmt.date(f)}`, v: f } : null,
          });
        } else
          out.push({
            key: "end",
            text: "Ends past the 90-day limit.",
            fix: { label: `End ${fmt.date(horizon)}`, v: horizon },
          });
      }
      if (e.title && (ed.attempted || ed.touched.title))
        out.push({ key: "title", text: e.title, fix: null });
      return out;
    }
    function patchMsgs(ed, want) {
      const box = ed.els.msgs;
      const pane = ed.els.pane;
      const active = document.activeElement;
      const have = new Map($$(".c-msg", box).map((p) => [p.dataset.for, p]));
      for (const [k, p] of have) {
        if (want.some((w) => w.key === k)) continue;
        if (p.contains(active))
          ($(`[data-tok="${k}"]`, pane) ?? ed.els.title)?.focus({ preventScroll: true });
        p.remove();
        have.delete(k);
      }
      want.forEach((w, i) => {
        let p = have.get(w.key);
        if (!p) {
          p = h("p", "c-msg", `${ic("alertCircle")}<span class="c-msg-t"></span>`);
          p.dataset.for = w.key;
          p.id = `c-msg-${w.key}`;
        }
        const t = $(".c-msg-t", p);
        if (t.textContent !== w.text) t.textContent = w.text;
        let b = $(".c-fix", p);
        if (w.fix) {
          if (!b) {
            b = h("button", "c-fix");
            b.type = "button";
            b.dataset.act = "fix";
            b.dataset.fix = w.key;
            p.append(b);
          }
          if (b.textContent !== w.fix.label) b.textContent = w.fix.label;
          if (b.dataset.v !== String(w.fix.v)) b.dataset.v = String(w.fix.v);
        } else if (b) {
          if (b === active)
            ($(`[data-tok="${w.key}"]`, pane) ?? ed.els.title)?.focus({ preventScroll: true });
          b.remove();
        }
        if (box.children[i] !== p) {
          const had = p.contains(document.activeElement) ? document.activeElement : null;
          box.insertBefore(p, box.children[i] ?? null);
          had?.focus({ preventScroll: true });
        }
      });
      // tokens point at their message
      for (const k of ["start", "interval", "end"]) {
        const tok = $(`[data-tok="${k}"]`, pane);
        if (!tok) continue;
        const on = want.some((w) => w.key === k);
        if (tok.hasAttribute("data-invalid") !== on) tok.toggleAttribute("data-invalid", on);
        if (on) tok.setAttribute("aria-describedby", `c-msg-${k}`);
        else tok.removeAttribute("aria-describedby");
      }
    }
    function paintHint() {
      const ed = st.ed;
      if (!ed) return;
      const e = ed.lastErrors ?? {};
      let hint;
      if (ed.confirm)
        hint = `<span>Unsaved changes. ${ed.confirm === "close" ? "Close again" : "Press Esc again"} to discard them, or</span><button type="button" class="c-link" data-act="keep-editing">keep editing</button>`;
      else if (e.limit) hint = `${ic("alertCircle")}<span>${esc(e.limit)}</span>`;
      else
        hint = `<span>${ed.isNew ? "Nothing runs" : "Nothing changes"} until you approve it.</span>`;
      if (hint === ed.lastHint) return;
      ed.lastHint = hint;
      const keep = ed.els.hint.contains(document.activeElement);
      ed.els.hint.innerHTML = hint;
      ed.els.hint.toggleAttribute("data-limit", !!e.limit && !ed.confirm);
      ed.els.hint.toggleAttribute("data-confirm", !!ed.confirm);
      if (keep) ($(".c-link", ed.els.hint) ?? ed.els.discard).focus({ preventScroll: true });
    }

    function paintValidation() {
      const ed = st.ed;
      if (!ed) return null;
      const { d, els } = ed;
      const v = validateDraft(d);
      const e = v.errors;
      const pane = els.pane;
      ed.lastErrors = e;
      patchMsgs(ed, wantMsgs(ed, e, S.now));
      els.title.toggleAttribute("data-invalid", !!(e.title && (ed.attempted || ed.touched.title)));
      els.title.setAttribute(
        "aria-invalid",
        String(!!(e.title && (ed.attempted || ed.touched.title))),
      );
      if (els.title.hasAttribute("data-invalid"))
        els.title.setAttribute("aria-describedby", "c-msg-title");
      else els.title.removeAttribute("aria-describedby");
      const pErr = ed.attempted || ed.touched.prompt ? (e.prompt ?? "") : "";
      const pEl = $('.c-ferr[data-for="prompt"]', pane);
      if (pEl.textContent !== pErr) pEl.textContent = pErr;
      els.prompt.setAttribute("aria-invalid", String(!!pErr));
      const mEl = $('.c-ferr[data-for="model"]', pane);
      const mErr = e.model ?? "";
      if (mEl.textContent !== mErr) mEl.textContent = mErr;
      $('[data-tok="model"]', pane).toggleAttribute("data-invalid", !!e.model);
      const len = d.prompt.length;
      const count =
        len > 0 ? `${len.toLocaleString("en-US")} / ${L.promptMax.toLocaleString("en-US")}` : "";
      if (els.count.textContent !== count) els.count.textContent = count;
      els.count.toggleAttribute("data-over", len > L.promptMax);
      paintHint();
      els.save.toggleAttribute("disabled", !!e.limit);
      return v;
    }

    function changed() {
      const ed = st.ed;
      if (!ed) return;
      clearConfirm();
      paintSentence();
      paintValidation();
      ed.els.pv?.update(schedOf(ed.d), S.now);
    }

    function setStart(ms) {
      const ed = st.ed;
      if (!ed) return;
      const d = ed.d;
      const ew = endWords(d.start, d.endsAt);
      if (ew.dur) d.endsAt = ms + (d.endsAt - d.start);
      d.start = ms;
      changed();
    }

    function openToken(kind, el, initialText) {
      const ed = st.ed;
      if (!ed || !el) return;
      const d = ed.d;
      const now = S.now;
      const P = PK();
      if (kind === "interval" && P)
        return pickerPop(
          el,
          "Repeat every",
          (host) =>
            P.interval(host, {
              valueMs: d.intervalMs,
              label: "Repeat every",
              onChange: (ms) => {
                d.intervalMs = ms;
                changed();
              },
            }),
          { kind, autoClose: "[data-ms]", initialFocus: '[role="radio"][aria-checked="true"]' },
        );
      if (kind === "start" && P)
        return pickerPop(
          el,
          d.kind === "once" ? "Runs at" : "First run",
          (host) =>
            P.dateTime(host, {
              variant: "type",
              value: d.start,
              min: now,
              max: now + L.horizonMs,
              label: d.kind === "once" ? "Runs at" : "First run",
              now: () => S.now,
              onChange: (ms) => {
                setStart(ms);
                if (st.pop?.wantsClose?.()) st.pop.closeSoon();
              },
            }),
          { kind, initialFocus: ".pk-input", initialText },
        );
      if (kind === "end" && P)
        return pickerPop(
          el,
          "Ends",
          (host) =>
            P.until(host, {
              startMs: d.start,
              valueMs: d.endsAt,
              nowMs: now,
              intervalMs: d.intervalMs,
              label: "Ends",
              onChange: (ms) => {
                d.endsAt = ms;
                changed();
              },
            }),
          {
            kind,
            autoClose: "[data-dur], [data-max]",
            initialFocus: '[role="radio"][aria-checked="true"]',
          },
        );
      if (kind === "device")
        return menuPop(el, {
          label: "Device",
          value: d.deviceId,
          items: q.projectDevices(d.projectId).map((dv) => ({
            value: dv.id,
            label: dv.name,
            icon: deviceIcon(dv.id),
            aside: `<span class="c-path">${esc(q.project(d.projectId)?.checkouts.find((c) => c.deviceId === dv.id)?.path ?? "")}</span>`,
          })),
          onPick: (it) => {
            d.deviceId = it.value;
            changed();
          },
        });
      if (kind === "env")
        return menuPop(el, {
          label: "Runs in",
          value: d.envMode,
          width: 300,
          items: [
            {
              value: "worktree",
              label: "a new worktree",
              hint: "Each run starts in a fresh worktree off a branch.",
              icon: ic("fork"),
            },
            {
              value: "local",
              label: "the main checkout",
              hint: "Runs edit your checkout directly.",
              icon: ic("folder"),
            },
          ],
          onPick: (it) => {
            d.envMode = it.value;
            paintSentence(false, true);
            changed();
          },
        });
      if (kind === "ref")
        return menuPop(el, {
          label: "Branch",
          value: d.baseRef,
          items: (q.project(d.projectId)?.refs ?? ["main"]).map((ref) => ({
            value: ref,
            label: ref,
            icon: ic("branch"),
          })),
          onPick: (it) => {
            d.baseRef = it.value;
            changed();
          },
        });
      if (kind === "model") return modelPop(el);
      if (kind === "mode")
        return menuPop(el, {
          label: "Permissions",
          value: d.runtimeMode,
          width: 300,
          items: Lab.RUNTIME_MODES.map((m) => ({ value: m.id, label: m.label, hint: m.hint })),
          onPick: (it) => {
            d.runtimeMode = it.value;
            paintOpts();
            changed();
          },
        });
      return null;
    }

    function save() {
      const ed = st.ed;
      if (!ed) return;
      const v = paintValidation();
      if (v.errors.limit) return;
      if (!v.ok) {
        ed.attempted = true;
        paintValidation();
        const first = ["title", "start", "interval", "end", "prompt", "model"].find(
          (k) => v.errors[k],
        );
        const target =
          first === "title"
            ? ed.els.title
            : first === "prompt"
              ? ed.els.prompt
              : first === "model"
                ? $('[data-tok="model"]', ed.els.pane)
                : ($(`.c-msg[data-for="${first}"] .c-fix`, ed.els.pane) ??
                  $(`[data-tok="${first}"]`, ed.els.pane));
        target?.focus();
        return;
      }
      if (!editorDirty() && !ed.isNew) {
        closeEditor({ reason: "unchanged" });
        api.notify("Nothing changed, so nothing was proposed.");
        return;
      }
      let proposal = null;
      closeEditor({
        reason: "save",
        before: () => {
          const a = ed.d.id ? q.automation(ed.d.id) : null;
          proposal = act.save(defFrom(ed.d), {
            id: ed.d.id ?? undefined,
            expectedRevision: a?.revision,
            deviceId: ed.d.deviceId,
            projectId: ed.d.projectId,
          });
          if (proposal) {
            st.sel[st.pid] = proposal.automationId;
            st.lapsed.delete(proposal.automationId);
          }
          return proposal?.automationId ?? null;
        },
      });
      if (!proposal) api.notify("That change couldn't be proposed.", { tone: "err" });
    }

    /* Back to the detail. The title input becomes the heading in the same spot;
       on save a plate folds from the header into the row that now shows what's
       waiting, the row pulses once and takes focus. */
    function closeEditor(o = {}) {
      const ed = st.ed;
      if (!ed || !D) return;
      closePop(true);
      const { els } = ed;
      const headRect = els.title.getBoundingClientRect();
      const dirty = editorDirty();
      const landId = o.before ? o.before() : ed.originId;

      ed.off?.();
      els.kindPlate?.destroy();
      els.pv?.destroy();
      st.ed = null;
      D.body.dataset.editing = "false";
      D.list.inert = false;
      if (landId) st.sel[st.pid] = landId;
      if (o.discarded && dirty && !o.quiet)
        st.undo = {
          pid: st.pid,
          snap: { draft: ed.d, init: ed.init, isNew: ed.isNew, id: ed.originId },
        };
      renderHead();
      renderList();
      renderQueue();

      const old = D.pane;
      D.pane = null;
      D.paneKey = null;
      D.lastDetail = null;
      renderDetail("none");
      if (old) {
        old.inert = true;
        old.classList.add("is-leaving");
        if (o.instant) old.remove();
        else
          old
            .animate([{ opacity: 1 }, { opacity: 0 }], {
              duration: motionOn() ? 120 : 100,
              fill: "forwards",
            })
            .finished.then(
              () => old.remove(),
              () => old.remove(),
            );
      }
      if (!o.instant && D.pane) {
        if (motionOn())
          [...D.pane.children].slice(0, 7).forEach((c, i) => {
            if (c.classList.contains("c-dh")) {
              $(".c-dh-x", c)?.animate([{ opacity: 0 }, { opacity: 1 }], {
                duration: 160,
                delay: 60,
                fill: "backwards",
              });
              return;
            }
            c.animate(
              [
                { opacity: 0, translate: "0 4px" },
                { opacity: 1, translate: "0 0" },
              ],
              { duration: 240, delay: 100 + i * 24, easing: EASE, fill: "backwards" },
            );
          });
        else D.pane.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 120 });
      }

      const row = landId ? rowEl(landId) : null;
      const target = row ?? (ed.isNew ? ($('.c-empty [data-act="new"]', D.dlg) ?? D.newBtn) : null);
      if (!o.quiet) target?.focus({ preventScroll: true });
      if (o.reason === "save" && !o.instant && motionOn() && row) {
        row.scrollIntoView({ block: "nearest" });
        const toRect = row.getBoundingClientRect();
        const toPaint = paintOf(row);
        flight(D.dlg, {
          from: headRect,
          to: toRect,
          fromPaint: {
            bg: "rgba(127, 127, 127, 0.1)",
            shadow: "inset 0 0 0 1px transparent",
            radius: 8,
          },
          toPaint,
          duration: 320,
          easing: EASE,
          fadeOut: true,
          fadeFrom: 0.7,
        }).then(() => {
          if (row.isConnected)
            row.animate(
              [
                { boxShadow: "inset 0 0 0 1px rgba(127, 127, 127, 0)" },
                { boxShadow: "inset 0 0 0 1px rgba(127, 127, 127, 0.5)", offset: 0.35 },
                { boxShadow: "inset 0 0 0 1px rgba(127, 127, 127, 0)" },
              ],
              { duration: 520, easing: "ease-out" },
            );
        });
      }
    }

    /* ============================================================ events */
    function onClick(e) {
      if (!D) return;
      const t = e.target.closest("[data-act]");
      if (t && D.dlg.contains(t) && !t.closest(".c-pop .pk, .pk-pop"))
        return act_(t.dataset.act, t, e);
      const tok = e.target.closest("[data-tok]");
      if (tok && st.ed && st.ed.els.pane.contains(tok)) return openToken(tok.dataset.tok, tok);
      const row = e.target.closest(".c-row");
      if (row && D.rows.contains(row)) return select(row.dataset.key, { how: "fade" });
      const run = e.target.closest(".c-run");
      if (run && D.pane?.contains(run)) {
        rove(run, false);
        if (run.hasAttribute("data-unread")) act.markRead(run.dataset.run, true);
      }
    }

    /* History: one roving tab stop; its buttons are reachable only from it. */
    function rove(run, focus = true) {
      const list = run.closest(".c-runs");
      if (!list) return;
      for (const x of $$(".c-run", list)) {
        const on = x === run;
        x.tabIndex = on ? 0 : -1;
        for (const b of $$(".c-run-a .btn", x)) b.tabIndex = on ? 0 : -1;
      }
      const id = st.sel[st.pid];
      if (id) st.runFocus[id] = run.dataset.run;
      if (focus) run.focus({ preventScroll: false });
      // keep the cached detail in step so the next tick doesn't re-render it
      const r = findRow(id);
      if (r && D.paneKey === r.id) D.lastDetail = detailHtml(r);
    }

    function act_(name, el) {
      const r = findRow(st.sel[st.pid]);
      if (el.getAttribute("aria-disabled") === "true" && name !== "switch") return;
      switch (name) {
        case "close":
          return closeDialog("close");
        case "switch": {
          if (st.ed) return;
          return menuPop(el, {
            label: "Project",
            value: st.pid,
            width: 260,
            items: S.projects.map((p) => {
              const n = q.schedules({ projectId: p.id }).length;
              const w = q.dueApprovals(p.id).length;
              return {
                value: p.id,
                label: p.name,
                ariaLabel: `${p.name}, ${n ? plural(n, "schedule") : "no schedules"}${w ? `, ${plural(w, "run")} waiting` : ""}`,
                icon: hue(p),
                aside: `${w ? `<span class="c-glyph" data-g="awaiting-approval"></span>` : ""}<span class="tnum">${n || "—"}</span>`,
              };
            }),
            onPick: (it) => switchProject(it.value),
          });
        }
        case "new":
          if (atLimit()) return;
          return openEditor(null, el);
        case "edit":
          return r && openEditor(r.id, null, { focusModel: el.hasAttribute("data-model") });
        case "select":
        case "q-run":
        case "q-prop":
          return select(el.dataset.id, { how: "fade" });
        case "pause": {
          if (!r) return;
          const p = act.pause(r.id);
          if (!p) api.notify("This schedule can't be paused right now.", { tone: "warn" });
          return;
        }
        case "resume": {
          if (!r) return;
          const p = act.resume(r.id);
          if (!p) api.notify("This schedule can't be resumed right now.", { tone: "warn" });
          return;
        }
        case "more":
          if (!r?.automation) return;
          return menuPop(el, {
            label: "More actions",
            placement: "bottom-end",
            radio: false,
            items: [
              {
                value: "cancel",
                label: "Cancel schedule",
                icon: ic("ban"),
                destructive: true,
                hint: "Proposes ending it for good. History stays.",
              },
            ],
            onPick: () => {
              const p = act.cancel(r.id);
              if (!p) api.notify("This schedule can't be cancelled.", { tone: "warn" });
            },
          });
        case "approve-run": {
          const run = act.approveRun(el.dataset.run);
          if (!run) api.notify("That approval expired before it went through.", { tone: "warn" });
          return;
        }
        case "reject-run":
          act.rejectRun(el.dataset.run);
          return;
        case "approve-prop": {
          const p = q.proposal(el.dataset.p);
          const a = act.approve(el.dataset.p);
          if (!a && p?.status === "failed")
            api.notify(p.detail ?? "The change couldn't be applied.", { tone: "err" });
          return;
        }
        case "reject-prop":
          act.reject(el.dataset.p);
          return;
        case "repropose": {
          const lp = r?.lapsed;
          if (!lp) return;
          if (lp.kind === "create" || lp.kind === "edit")
            return openEditor(r.id, el, { src: lp, init: "" });
          const p = act[lp.kind]?.(r.id);
          if (!p) api.notify("That can't be proposed right now.", { tone: "warn" });
          return;
        }
        case "dismiss-lapsed":
          if (!r) return;
          st.lapsed.delete(r.id);
          renderList();
          renderQueue();
          renderDetail("fade");
          if (!D.pane?.contains(document.activeElement))
            (rowEl(st.sel[st.pid]) ?? D.newBtn)?.focus({ preventScroll: true });
          return;
        case "retry": {
          const rr = act.retryRun(el.dataset.run);
          if (!rr)
            api.notify(q.canRetry(q.run(el.dataset.run)).reason ?? "Couldn't retry.", {
              tone: "warn",
            });
          return;
        }
        case "open-thread":
          act.markRead(el.dataset.run, true);
          act.openThread(el.dataset.thread);
          return;
        case "toggle-hist":
          if (!r) return;
          st.histAll[r.id] = !st.histAll[r.id];
          return renderDetail("none");
        case "toggle-prompt":
          if (!r) return;
          st.promptAll[r.id] = !st.promptAll[r.id];
          return renderDetail("none");
        case "restore":
          return restoreDraft();
        case "undo-dismiss":
          st.undo = null;
          return renderUndo();
        case "keep-editing":
          clearConfirm();
          st.ed?.els.title.focus({ preventScroll: true });
          return;
        case "discard":
          return closeEditor({ reason: "discard", discarded: true });
        case "save":
          return save();
        case "fix": {
          const ed = st.ed;
          if (!ed) return;
          const v = +el.dataset.v;
          const tok = $(`[data-tok="${el.dataset.fix}"]`, ed.els.pane);
          tok?.focus();
          if (el.dataset.fix === "start") setStart(v);
          else if (el.dataset.fix === "end") {
            ed.d.endsAt = v;
            changed();
          } else if (el.dataset.fix === "interval") {
            ed.d.intervalMs = v;
            changed();
          }
          return;
        }
      }
    }

    function onKey(e) {
      if (!D) return;
      const tgt = e.target;
      // Keys typed inside a menu or picker belong to it, never to the dialog.
      if (tgt.closest?.(".pop, [role=menu]")) return;
      const typing = tgt.matches?.("input, textarea, [contenteditable=true]");
      if (st.ed) {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          save();
        }
        return;
      }
      if (
        (e.metaKey || e.ctrlKey) &&
        !e.shiftKey &&
        (e.key === "z" || e.key === "Z") &&
        st.undo &&
        !typing
      ) {
        e.preventDefault();
        restoreDraft();
        return;
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      const row = tgt.closest?.(".c-row");
      if (row && ["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
        e.preventDefault();
        const rows = $$(".c-row", D.rows);
        const i = rows.indexOf(row);
        const j =
          e.key === "Home"
            ? 0
            : e.key === "End"
              ? rows.length - 1
              : clamp(i + (e.key === "ArrowDown" ? 1 : -1), 0, rows.length - 1);
        if (rows[j]) select(rows[j].dataset.key, { how: "none" });
        return;
      }
      if (row && (e.key === "Enter" || e.key === " ")) {
        e.preventDefault();
        $(".c-dh-x .btn:not([aria-disabled=true])", D.pane)?.focus();
        return;
      }
      const run = tgt.closest?.(".c-run");
      if (run && tgt === run) {
        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
          e.preventDefault();
          const runs = $$(".c-run", run.closest(".c-runs"));
          const i = runs.indexOf(run);
          const j =
            e.key === "Home"
              ? 0
              : e.key === "End"
                ? runs.length - 1
                : clamp(i + (e.key === "ArrowDown" ? 1 : -1), 0, runs.length - 1);
          rove(runs[j]);
          return;
        }
        if (e.key === "Enter") {
          e.preventDefault();
          $(".c-run-a .btn", run)?.click();
          return;
        }
      }
      if (run && (e.key === "u" || e.key === "U")) {
        e.preventDefault();
        act.markRead(run.dataset.run, run.hasAttribute("data-unread"));
        return;
      }
      if (e.key === "n" || e.key === "N") {
        e.preventDefault();
        if (!atLimit()) openEditor(null, D.newBtn);
      } else if (e.key === "e" || e.key === "E") {
        const r = findRow(st.sel[st.pid]);
        if (r && r.state !== "lapsed") {
          e.preventDefault();
          openEditor(r.id, null);
        }
      }
    }

    /* ============================================================ update */
    function update() {
      paintPage();
      if (!D) return;
      const m = Math.floor(S.now / MIN);
      const minuteChanged = m !== lastMin;
      lastMin = m;
      renderHead();
      renderList();
      renderQueue();
      if (st.ed) {
        if (minuteChanged) {
          paintSentence();
          paintValidation();
          st.ed.els.pv?.update(schedOf(st.ed.d), S.now);
          if (st.popKind === "start") st.popInst?.setRange?.(S.now, S.now + L.horizonMs);
          if (st.popKind === "end") st.popInst?.update?.({ nowMs: S.now });
        }
      } else renderDetail("none");
      paintTicks(D.dlg);
      // Never leave focus on <body> after something under it went away.
      if (!D.closing && (document.activeElement === document.body || !document.activeElement))
        focusDefault();
    }

    /* ---- go */
    paintPage();
    requestAnimationFrame(paintWires);
    if (params.get("cdlg") !== "0") later(() => openDialog(st.pid, sbEntry), motionOn() ? 260 : 0);

    return {
      update,
      destroy() {
        for (const t of timers) clearTimeout(t);
        closeDialog("destroy");
        offEvents();
        ro.disconnect();
        railAuto?.removeEventListener("click", onRail);
        if (railHadOn) railAuto?.classList.add("on");
        railProj?.classList.remove("on");
        root.remove();
      },
    };
  }

  DIRS.C = {
    title: "Dialog",
    thesis:
      "No new page. One Automations dialog grows out of whatever reached it — the sidebar, a project card, the rail — and the schedule is written as a sentence.",
    notes: [
      [
        "Why",
        [
          "Automations are a side task, so they open over the work instead of replacing it. The dialog is <b>scoped to one project</b>, with a switcher in its one header bar, and sized to the window (up to 1040 × 760).",
          "List and detail sit side by side with a hairline between them. Rows are two fixed lines: title (+ a tag such as <i>Change proposed</i>), cadence (+ state or the relative next run).",
          "What's waiting is one line in the header: <b>1 run waiting · 13m</b> · <b>2 changes waiting</b>. Each part selects that schedule. The selected schedule is left out, because its detail owns the one countdown and the one <b>Approve run</b>.",
          "Waiting is neutral: a static dot, a hairline block and a draining line. The countdown only turns warm in its last two minutes.",
          "The editor's header is the title itself; the sentence is when + where: <b>Every</b> [2 hours] <b>from</b> [today 12:40] <b>until</b> [Oct 20] <b>on</b> This Mac <b>in</b> [the main checkout]. Model (with its effort dial) and permissions sit on one quiet line above the prompt.",
          "Saving is honest. The row says <b>Change proposed</b> and the detail shows <b>Current → Proposed</b> until you approve it. A proposal that expires undecided stays as <b>Proposal expired · Propose again</b>.",
        ],
      ],
      [
        "Motion",
        [
          "The dialog grows out of its trigger and folds back into it. The trigger is the sidebar item, the card's schedule button or the rail icon.",
          "<b>Edit</b>: the detail's heading and the editor's title field are the same size in the same spot, so nothing travels; the rest cross-fades and rises in. <b>New</b>: a plate grows out of the button. Text never scales.",
          "<b>Save</b>: a plate folds from the header into the row that now shows the pending change; the row rings once and takes focus.",
          "Token popovers grow from their token but land under the whole sentence, inside the dialog, so you can read it while you pick. Reduced motion keeps the same states with crossfades of 120 ms or less. Nothing pulses forever.",
        ],
      ],
      [
        "Keyboard",
        [
          "<kbd>↑</kbd><kbd>↓</kbd> move through schedules; rows are patched in place, so focus and selection survive every tick. <kbd>E</kbd> edits, <kbd>N</kbd> starts a new schedule.",
          "Run history is one tab stop: <kbd>↑</kbd><kbd>↓</kbd> move, <kbd>↵</kbd> opens the thread or retries, <kbd>U</kbd> toggles unread.",
          "In the sentence, <kbd>Tab</kbd> moves between tokens and <kbd>↵</kbd> or <kbd>↓</kbd> opens one. Typing a letter on the time token opens the Type picker with that letter. Menus have first-letter type-ahead. <kbd>⌘↵</kbd> saves.",
          "<kbd>Esc</kbd> closes the top layer first. On a draft with changes, the first <kbd>Esc</kbd> only asks (in the footer); the second discards, and <b>Restore</b> (<kbd>⌘Z</kbd>) stays in the dialog until the next edit.",
        ],
      ],
      [
        "Where each state is",
        [
          "<b>ryco</b>: <i>Triage new issues</i> has the approval due. <i>Watch main CI</i> is starting. <i>Nightly e2e</i> is paused, its last run failed and its model is gone (so Resume becomes <b>Edit model to resume</b>). <i>Update the changelog</i> has a change proposed and the Oct 25 clock note.",
          "<b>ryco-hub</b> (switcher, or the card): <i>3 missed runs</i> → one approval, a pause proposed and a new schedule waiting. <b>scratch</b> is empty.",
          "Validation: open New, then type <b>dec 30 9</b> in the time token (the end goes past 90 days) or <b>yesterday 9</b> (in the past). Use Custom → − in the interval for the 15-minute floor, or Save with no title.",
        ],
      ],
      [
        "Trade-offs",
        [
          "Long histories and the editor scroll inside the detail; the editor keeps its footer pinned.",
          "The list goes inert while you edit. The switcher and New are disabled, so one draft exists at a time.",
          "You can't move a schedule to another device while editing it. The device token is plain text with a tooltip.",
          "Try <code>?full=ryco</code> for the 25-schedule limit (said once next to the switcher; New is disabled with the reason) and <code>?cproj=scratch</code> for the empty state. Lab-only: the rail's Projects icon is lit while C is open.",
        ],
      ],
    ],
    mount,
  };
})();
