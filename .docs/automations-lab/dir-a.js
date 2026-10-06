/* ============================================================
   A · Schedules — a dedicated /automations page.

   One 52px bar: title · one scope menu (all projects / a project / a
   device of a multi-device project) · time zone · "New schedule".
   Left: a fixed 44px strip for runs due anywhere (idle when none), then
   schedules grouped by project (and device), two lines each — title and
   next-run countdown, cadence plus at most one muted state word, and a
   12px state glyph. No pills; rows are built once and patched in place.
   Right: the schedule as one sentence, its facts stacked once, what's
   next (one counting header) and its run history (one Retry per
   schedule; why-not reasons for the rest).

   The editor is a dialog that grows out of "New schedule" / "Edit" and,
   on "Save for approval", folds into the schedule's row, which then says
   "Change pending" until it is approved in the detail. While a change
   waits, Pause / Cancel say why they can't act; a change that expires or
   fails leaves a quiet "Propose again" line instead of vanishing.
   ============================================================ */
(() => {
  const Q = Lab.q;
  const { MIN, HOUR, DAY } = Lab.units;
  const TTL = Lab.LIMITS.approvalTtlMs;
  const HORIZON = Lab.LIMITS.horizonMs;
  const PER_PROJECT = Lab.LIMITS.perProject;

  /* The row's one muted state word per pending-proposal kind. */
  const PEND_WORD = {
    create: "New, pending",
    edit: "Change pending",
    pause: "Pause pending",
    resume: "Resume pending",
    cancel: "Cancel pending",
  };
  /* "Replaces the edit proposed at 10:36" / "Your pause expired …" */
  const KIND_NOUN = {
    create: "schedule",
    edit: "edit",
    pause: "pause",
    resume: "resume",
    cancel: "cancel",
  };
  const PEND_LOCK = "Approve or reject the pending change first";
  const PEND_VERB = {
    create: "New schedule proposed",
    edit: "Edit proposed",
    pause: "Pause proposed",
    resume: "Resume proposed",
    cancel: "Cancel proposed",
  };
  /* Display order of a group's rows: what needs you, then by next run. */
  const RANK = {
    "awaiting-approval": 0,
    running: 1,
    "pending-create": 2,
    scheduled: 3,
    paused: 4,
    finished: 5,
    cancelled: 6,
  };

  /* ------------------------------------------------------------ helpers */
  const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : "");
  const isTyping = (t) => !!t?.closest?.("input, textarea, select, [contenteditable='true']");
  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

  /* "in 1:42" under two minutes, else the shared relative phrase. */
  function untilText(ms, now = S.now) {
    if (ms == null) return "";
    const d = ms - now;
    if (d <= 0) return "due now";
    if (d < 2 * MIN) return `in ${fmt.countdown(d)}`;
    return sched.relative(ms, now);
  }
  /* Approval expiry: coarse minutes, mm:ss under two minutes. */
  function expiryShort(run, now = S.now) {
    const left = Math.max(0, run.expiresAt - now);
    return left < 2 * MIN ? fmt.countdown(left) : `${Math.ceil(left / MIN)}m`;
  }
  const expiryFrac = (run, now = S.now) => clamp((run.expiresAt - now) / TTL, 0, 1);
  function ringSvg(frac) {
    const off = (100 - frac * 100).toFixed(2);
    return `<svg class="da-ring" viewBox="0 0 16 16" aria-hidden="true"><circle class="da-ring-track" cx="8" cy="8" r="6"/><circle class="da-ring-arc" cx="8" cy="8" r="6" pathLength="100" stroke-dasharray="100" stroke-dashoffset="${off}" transform="rotate(-90 8 8)"/></svg>`;
  }
  /* A proposal can't apply once its first run has passed, so the real
     deadline is the earlier of its expiry and that first run. */
  function proposalDeadline(p) {
    const first = p.kind !== "cancel" && p.after ? sched.first(p.after.schedule) : Infinity;
    return first < p.expiresAt
      ? { at: first, byFirstRun: true }
      : { at: p.expiresAt, byFirstRun: false };
  }
  /* "in 9m" style tail for a deadline: coarse minutes, m:ss under two. */
  function leftShort(ms, now = S.now) {
    const left = Math.max(0, ms - now);
    return left < 2 * MIN ? fmt.countdown(left) : `${Math.ceil(left / MIN)}m`;
  }
  /* "Every 7 days from Fri 16:00" → "… from Fri 17:30" reads as
     "Fri 16:00 → Fri 17:30": drop the shared lead up to a "from" / "at" /
     comma boundary, never mid-phrase. */
  function trimCommon(a, b) {
    const x = a.split(" ");
    const y = b.split(" ");
    let cut = 0;
    for (let i = 0; i < Math.min(x.length, y.length) - 1 && x[i] === y[i]; i++)
      if (x[i] === "from" || x[i] === "at" || x[i].endsWith(",")) cut = i + 1;
    return [x.slice(cut).join(" "), y.slice(cut).join(" ")];
  }
  function patchRing(el, frac) {
    const arc = el?.querySelector?.(".da-ring-arc");
    if (!arc) return;
    const off = (100 - frac * 100).toFixed(2);
    if (arc.getAttribute("stroke-dashoffset") !== off) arc.setAttribute("stroke-dashoffset", off);
    el.querySelector(".da-ring").toggleAttribute("data-low", frac < 2 / 15);
  }
  function setText(el, text) {
    if (el && el.textContent !== text) el.textContent = text;
  }
  const whereShort = (ex) =>
    ex.envMode === "worktree" ? `a new worktree off ${ex.baseRef ?? "main"}` : "the main checkout";
  /* What approving a run does, said plainly. */
  const consequence = (run) => {
    const ex = run.execution ?? Q.automation(run.automationId)?.execution;
    return `Starts a thread in ${ex ? whereShort(ex) : "its checkout"} on ${Q.device(run.deviceId)?.name ?? run.deviceId}.`;
  };
  const coalescedHtml = (n) =>
    n > 0
      ? `<span class="da-coal" data-tip="${esc(`${plural(n, "run")} came due while the device was off. Approving starts one run now.`)}">${n} missed ${n === 1 ? "run" : "runs"} → 1</span>`
      : "";

  /* The schedule as one sentence; the variable parts carry the weight. */
  function sentenceHtml(def, now = S.now) {
    const s = def.schedule;
    const ex = def.execution;
    let when;
    if (s.kind === "once") {
      const rest = sched.phrase(s, now).replace(/^once,\s*/, "");
      when = `<b>once</b>, <b>${esc(rest)}</b>,`;
    } else {
      const ph = sched.phrase(s, now);
      const i = ph.lastIndexOf(" until ");
      when =
        i > 0
          ? `<b>${esc(ph.slice(0, i))}</b> until <b>${esc(ph.slice(i + 7))}</b>`
          : `<b>${esc(ph)}</b>`;
    }
    const where =
      ex.envMode === "worktree"
        ? `in <b>a new worktree</b> off <b class="da-ref">${esc(ex.baseRef ?? "main")}</b>`
        : "in <b>the main checkout</b>";
    return `Runs ${when} ${where}.`;
  }

  function modelHtml(sel) {
    const m = sel ? Q.model(sel.instanceId, sel.model) : null;
    const effort = sel?.options?.find((o) => o.id === "effort")?.value;
    return `${providerMark(sel?.instanceId)}<span class="da-m-name">${esc(m?.name ?? sel?.model ?? "Pick a model")}</span>${
      effort && m ? `<span class="da-m-eff">${esc(cap(effort))}</span>` : ""
    }`;
  }

  /* A start rolled forward onto one of the rule's own occurrences is the
     same rule (editors must start in the future), not a change. */
  function sameRule(b, a) {
    if (b.kind !== a.kind) return false;
    if (b.kind === "once") return b.runAt === a.runAt;
    return (
      b.intervalMs === a.intervalMs &&
      b.endsAt === a.endsAt &&
      (a.startsAt - b.startsAt) % b.intervalMs === 0
    );
  }
  /* Diff of a pending change: changed fields only, current → proposed. */
  function diffRows(p) {
    const b = p.before;
    const a = p.after;
    if (!b || !a) return [];
    const rows = [];
    const bx = b.execution;
    const ax = a.execution;
    if (bx.title !== ax.title) rows.push(["Name", esc(bx.title), esc(ax.title)]);
    // Only the part of the rule that changes: "Fri 16:00 → Fri 17:30", the end
    // date only when it moves (the sentence above already states the rest).
    const bs = b.schedule;
    const as = a.schedule;
    if (p.kind === "edit" && !sameRule(bs, as)) {
      if (bs.kind !== as.kind) rows.push(["When", esc(sched.label(bs)), esc(sched.label(as))]);
      else if (bs.kind === "once")
        rows.push(["Runs at", esc(fmt.dateTime(bs.runAt)), esc(fmt.dateTime(as.runAt))]);
      else {
        const cb = sched.cadence(bs);
        const ca = sched.cadence(as);
        if (cb !== ca) {
          const [x, y] = trimCommon(cb, ca);
          rows.push(["When", esc(x), esc(y)]);
        } else if (
          bs.intervalMs !== as.intervalMs ||
          (as.startsAt - bs.startsAt) % bs.intervalMs !== 0
        )
          rows.push([
            "First run",
            esc(fmt.dateTime(sched.first(bs))),
            esc(fmt.dateTime(sched.first(as))),
          ]);
        if (bs.endsAt !== as.endsAt) {
          const sameDate = fmt.date(bs.endsAt) === fmt.date(as.endsAt);
          rows.push([
            "Until",
            esc(sameDate ? fmt.dateTime(bs.endsAt) : fmt.date(bs.endsAt)),
            esc(sameDate ? fmt.dateTime(as.endsAt) : fmt.date(as.endsAt)),
          ]);
        }
      }
    }
    if (bx.prompt !== ax.prompt) {
      if (ax.prompt.startsWith(bx.prompt))
        rows.push([
          "Prompt",
          null,
          `<span class="da-add">+ ${esc(ax.prompt.slice(bx.prompt.length).trim())}</span>`,
        ]);
      else
        rows.push([
          "Prompt",
          null,
          `<span class="da-q">${esc(ax.prompt.slice(0, 140))}${ax.prompt.length > 140 ? "…" : ""}</span>`,
        ]);
    }
    const mb = fmt.model(bx.modelSelection, { effort: true });
    const ma = fmt.model(ax.modelSelection, { effort: true });
    if (mb !== ma || bx.modelSelection.instanceId !== ax.modelSelection.instanceId)
      rows.push(["Model", esc(mb), esc(ma)]);
    if (bx.runtimeMode !== ax.runtimeMode)
      rows.push([
        "Permissions",
        esc(fmt.runtimeMode(bx.runtimeMode)),
        esc(fmt.runtimeMode(ax.runtimeMode)),
      ]);
    if (bx.envMode !== ax.envMode || (bx.baseRef ?? "") !== (ax.baseRef ?? ""))
      rows.push(["Where", esc(cap(whereShort(bx))), esc(cap(whereShort(ax)))]);
    return rows;
  }

  /* ------------------------------------------------------------ keyed lists
     Reuses children by data-key, re-renders one only when its signature
     changes, moves nodes only when the order changed, and puts focus back
     where it was (same data-fid, else the same row). Returns true when the
     structure (membership or order) changed. */
  function reconcile(container, items, render, o = {}) {
    const old = new Map();
    for (const el of container.children) if (!el.dataset.leaving) old.set(el.dataset.key, el);
    const active = document.activeElement;
    const inside = container.contains(active) && active !== container;
    const fid = inside ? (active.dataset.fid ?? null) : null;
    const fkey = inside ? (active.closest("[data-key]")?.dataset.key ?? null) : null;
    let structural = false;
    const order = [];
    for (const it of items) {
      let el = old.get(it.key);
      if (el) old.delete(it.key);
      else {
        el = document.createElement(it.tag ?? "div");
        el.dataset.key = it.key;
        el._fresh = true;
        structural = true;
      }
      if (el._sig !== it.sig) {
        render(el, it);
        el._sig = it.sig;
      }
      order.push(el);
    }
    for (const el of old.values()) {
      structural = true;
      if (o.exit && motionOn()) {
        el.dataset.leaving = "1";
        o.exit(el).then(() => el.remove());
      } else el.remove();
    }
    let prev = null;
    for (const el of order) {
      let want = prev ? prev.nextElementSibling : container.firstElementChild;
      while (want && want.dataset.leaving) want = want.nextElementSibling;
      if (want !== el) {
        container.insertBefore(el, want);
        if (!el._fresh) structural = true;
      }
      el._fresh = false;
      prev = el;
    }
    if (inside && !container.contains(document.activeElement)) {
      const byFid = fid ? container.querySelector(`[data-fid="${CSS.escape(fid)}"]`) : null;
      const byKey = fkey ? container.querySelector(`[data-key="${CSS.escape(fkey)}"]`) : null;
      const target =
        byFid ?? (byKey?.matches("[tabindex]") ? byKey : byKey?.querySelector("button"));
      target?.focus({ preventScroll: true });
    }
    return structural;
  }
  /* Re-render a fixed slot only when its signature changes; keep focus. */
  function patchSlot(el, sig, render) {
    if (el._sig === sig) return false;
    const active = document.activeElement;
    const fid = el.contains(active) ? active.dataset.fid : null;
    render();
    el._sig = sig;
    if (fid && !el.contains(document.activeElement))
      el.querySelector(`[data-fid="${CSS.escape(fid)}"]`)?.focus({ preventScroll: true });
    return true;
  }
  /* Collapse a leaving row (height + fade), then resolve. */
  function collapseOut(el) {
    const hgt = el.offsetHeight;
    el.style.overflow = "hidden";
    return el
      .animate(
        [
          { height: `${hgt}px`, opacity: 1 },
          {
            height: "0px",
            opacity: 0,
            paddingTop: "0px",
            paddingBottom: "0px",
            marginTop: "0px",
            marginBottom: "0px",
          },
        ],
        { duration: 260, easing: EASE, fill: "forwards" },
      )
      .finished.catch(() => {});
  }

  /* ------------------------------------------------------------ segmented
     A radiogroup on the shared .seg look with core's sliding plate.
     ←/→ (↑/↓) move and select, Home/End jump; roving tabindex. */
  function segControl(host, { options, value, label, onChange, className = "" }) {
    const el = h("div", `seg da-seg ${className}`);
    el.setAttribute("role", "radiogroup");
    el.setAttribute("aria-label", label);
    el.innerHTML = options
      .map(
        (o) =>
          `<button type="button" class="seg-opt" role="radio" data-v="${esc(o.value)}" aria-checked="false" tabindex="-1"${
            o.tip ? ` data-tip="${esc(o.tip)}"` : ""
          }>${o.html ?? esc(o.label)}</button>`,
      )
      .join("");
    host.append(el);
    let v = String(value);
    const btns = () => $$(".seg-opt", el);
    function paint() {
      for (const b of btns()) {
        const on = b.dataset.v === v;
        b.setAttribute("aria-checked", String(on));
        b.tabIndex = on ? 0 : -1;
      }
    }
    paint();
    const pl = plate(el);
    function choose(nv, focus) {
      if (focus) el.querySelector(`[data-v="${CSS.escape(nv)}"]`)?.focus();
      if (nv === v) return;
      v = nv;
      paint();
      onChange?.(v);
    }
    el.addEventListener("click", (e) => {
      const b = e.target.closest(".seg-opt");
      if (b) choose(b.dataset.v, false);
    });
    el.addEventListener("keydown", (e) => {
      const list = btns();
      const i = list.findIndex((b) => b.dataset.v === v);
      const n =
        e.key === "ArrowRight" || e.key === "ArrowDown"
          ? (i + 1) % list.length
          : e.key === "ArrowLeft" || e.key === "ArrowUp"
            ? (i - 1 + list.length) % list.length
            : e.key === "Home"
              ? 0
              : e.key === "End"
                ? list.length - 1
                : -1;
      if (n < 0) return;
      e.preventDefault();
      choose(list[n].dataset.v, true);
    });
    return {
      el,
      value: () => v,
      set(nv) {
        v = String(nv);
        paint();
      },
      destroy() {
        pl.destroy();
        el.remove();
      },
    };
  }

  /* Arrow-key roving between menu items inside a popover. */
  function menuKeys(container) {
    container.addEventListener("keydown", (e) => {
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
      const items = $$(".menu-item:not([aria-disabled='true'])", container);
      if (!items.length) return;
      const i = items.indexOf(document.activeElement);
      const n =
        e.key === "Home"
          ? 0
          : e.key === "End"
            ? items.length - 1
            : e.key === "ArrowDown"
              ? (i + 1) % items.length
              : (i - 1 + items.length) % items.length;
      e.preventDefault();
      items[n].focus();
    });
  }

  /* ============================================================ direction */
  DIRS.A = {
    title: "Schedules",
    thesis:
      "A page of its own: schedules grouped by project with live countdowns, one quiet strip for runs that need you, and a detail pane that reads the schedule back as a sentence. Editing happens in a dialog that grows out of its button and folds into the row it changed.",
    notes: [
      [
        "Why",
        [
          "Automations get a home like Pull requests: one 52px bar (title · scope · time zone · New schedule), a list, a reader. Nothing is nested in a card; hairlines and whitespace do the separating.",
          "Every fact sits at one altitude: the cadence in the row, the full sentence in the detail, model / permissions / device once in the facts, the time zone once in the bar.",
          "Rows carry no pills: a 12px glyph (approval ring, pending hourglass, starting dot, pause) and at most one muted word. Approve a run in the strip or its history row; approve a change only in the detail.",
          "Changes are honest: <b>Save for approval</b> folds into the row, which says <b>Change pending</b>. While it waits, Pause / Cancel explain why they can't act instead of silently replacing it. If it expires, a quiet line offers <b>Propose again</b>.",
        ],
      ],
      [
        "Motion",
        [
          "The editor grows out of <b>New schedule</b> / <b>Edit</b> (core morph, dialog profile) and folds into the row it changed.",
          "<b>Cancel schedule</b> asks in a popover that grows from the button and, when confirmed, folds into the row's pending glyph.",
          "Clicking a row slides the selection plate to it; keyboard stepping (J/K, ↑/↓) moves it at once and never replays entrance motion.",
          "Sim ticks only change text and the expiry rings (tabular numbers); the approval strip keeps its 44px slot even when nothing waits, so the list never jumps.",
        ],
      ],
      [
        "Keyboard",
        [
          "<b>N</b> new schedule · <b>E</b> edit · <b>J</b>/<b>K</b> or ↑/↓ in the list move the selection · the scope menu takes ↑/↓ and Enter.",
          "In the editor: Tab is trapped, <b>⌘↵</b> saves, <b>Esc</b> closes the topmost layer only (picker, menu, then the dialog) and focus returns to where it came from.",
        ],
      ],
      [
        "Try",
        [
          "Expand the strip: <b>Summarise relay logs</b> folds 3 missed runs into 1; Approve run walks Approved → Starting → Dispatched.",
          "<b>Nightly e2e suite</b> is paused with failed runs; Edit it to see an unavailable model explained inline, and that saving keeps it paused.",
          "<b>Update the changelog</b> has a pending edit: the diff shows only <i>Fri 16:00 → Fri 17:30</i>. Let it expire (sim) to see <b>Propose again</b>.",
          "In the editor: Custom interval below 15 min, a start late in December (the end shortens to the 90-day limit), a first run within 15 minutes.",
          "<b>scratch</b> is the empty state; <code>?full=ryco</code> shows the 25-schedule limit with <b>Switch project</b> / <b>Save it paused</b>.",
        ],
      ],
      [
        "Trade-offs",
        [
          "Two panes need ~1100px; under that the detail would become a pushed page (not built here).",
          "The strip is for runs only (they expire); pending changes live on their rows so the strip never turns into an inbox.",
          'Device filtering is nested under the projects that live on several devices; there is no "all projects on Studio" view.',
        ],
      ],
    ],

    mount(host, api) {
      const ui = {
        project: "all",
        device: "all",
        selected: null,
        stripOpen: false,
        showCancelled: false,
        lastMinute: -1,
        detailFor: null,
        announced: new Map(),
        dismissed: new Set(),
      };
      const root = h("div", "da");
      root.innerHTML = `
        <div class="da-page">
          <header class="da-bar">
            <h1 class="da-title">Automations</h1>
            <button type="button" class="btn ghost sm da-scope" data-fid="scope" aria-haspopup="menu" aria-expanded="false"></button>
            <span class="da-sp"></span>
            <span class="da-tz" data-tip="Every time on this page is local">${ic("clock")}<span>${esc(fmt.tz())}</span></span>
            <button type="button" class="btn primary sm da-new" data-new>${ic("plus")}<span>New schedule</span><kbd class="da-kbd">N</kbd></button>
          </header>
          <div class="da-body">
            <aside class="da-side" aria-label="Schedules">
              <div class="da-strip-host"></div>
              <div class="da-scroll">
                <div class="da-hl" aria-hidden="true"></div>
                <div class="da-list" role="list"></div>
                <p class="da-list-none" hidden></p>
                <div class="da-list-foot"></div>
              </div>
            </aside>
            <section class="da-detail" aria-label="Schedule detail" tabindex="-1"></section>
            <section class="da-empty" hidden></section>
          </div>
        </div>
        <div class="da-live sr-only" aria-live="polite"></div>`;
      host.append(root);

      const page = $(".da-page", root);
      const side = $(".da-side", root);
      const scroll = $(".da-scroll", root);
      const list = $(".da-list", root);
      const listFoot = $(".da-list-foot", root);
      const hl = $(".da-hl", root);
      const detail = $(".da-detail", root);
      const empty = $(".da-empty", root);
      const scopeBtn = $(".da-scope", root);
      const newBtn = $(".da-new", root);
      const live = $(".da-live", root);
      const stripHost = $(".da-strip-host", root);

      /* One polite region; messages from the same tick are joined, not
         overwritten (a sim step can expire a run and a change at once). */
      let liveQueue = [];
      const announce = (text) => {
        liveQueue.push(text);
        if (liveQueue.length > 1) return;
        live.textContent = "";
        requestAnimationFrame(() => {
          live.textContent = liveQueue.join(" ");
          liveQueue = [];
        });
      };

      /* ---------------------------------------------------------- scope */
      const scopeRows = (o = {}) =>
        Q.schedules({
          projectId: (o.project ?? ui.project) === "all" ? undefined : (o.project ?? ui.project),
          deviceId: (o.device ?? ui.device) === "all" ? undefined : (o.device ?? ui.device),
          includeCancelled: o.cancelled ?? ui.showCancelled,
        });
      const rowById = (id) => scopeRows({ cancelled: true }).find((r) => r.id === id) ?? null;
      const rowEl = (id) =>
        id ? list.querySelector(`.da-row[data-id="${CSS.escape(id)}"]`) : null;

      function sortRows(rows) {
        const rank = (r) => (r.automation?.cancelled ? RANK.cancelled : (RANK[r.state] ?? 3));
        const next = (r) => r.nextRunAt ?? Infinity;
        return rows.slice().sort((a, b) => {
          const ca = a.automation?.cancelled ? 1 : 0;
          const cb = b.automation?.cancelled ? 1 : 0;
          if (ca !== cb) return ca - cb;
          const pa = rank(a) >= RANK.paused ? 1 : 0;
          const pb = rank(b) >= RANK.paused ? 1 : 0;
          if (pa !== pb) return pa - pb;
          return next(a) - next(b) || a.title.localeCompare(b.title);
        });
      }

      /* ---------------------------------------------------------- bar
         One scope menu: all projects, a project, or one device of a
         project that lives on several (nested under it). The bar always
         holds title · scope · time zone · New schedule, however many
         projects there are. */
      const avHtml = (p) =>
        `<span class="da-av sm" style="--hue:${p?.hue ?? 0}">${esc(p?.name?.[0]?.toUpperCase() ?? "")}</span>`;
      /* Schedules shown for a scope; near the 25 limit, the active count
         instead (the same figure the group header shows). */
      function scopeCount(project, device) {
        const n = scopeRows({ project, device, cancelled: false }).length;
        if (project === "all" || device !== "all") return { text: String(n), full: false };
        const active = Q.activeCount(project);
        if (active < PER_PROJECT - 5) return { text: String(n), full: false };
        return { text: `${active} of ${PER_PROJECT} active`, full: active >= PER_PROJECT };
      }
      function paintBar() {
        const p = ui.project === "all" ? null : Q.project(ui.project);
        const d = ui.device === "all" ? null : Q.device(ui.device);
        const html = `${p ? avHtml(p) : ic("layers")}<span class="trunc">${esc(p?.name ?? "All projects")}</span>${
          d
            ? `<span class="da-scope-sep" aria-hidden="true">·</span>${deviceIcon(d.id)}<span class="trunc">${esc(d.name)}</span>`
            : ""
        }${ic("chevD", "da-chev")}`;
        if (scopeBtn._html !== html) {
          scopeBtn.innerHTML = html;
          scopeBtn._html = html;
          scopeBtn.setAttribute(
            "aria-label",
            `Showing ${p ? p.name : "all projects"}${d ? ` on ${d.name}` : ""}`,
          );
        }
      }
      scopeBtn.addEventListener("click", () => {
        const menu = h("div", "menu da-menu da-scope-menu");
        menu.setAttribute("role", "menu");
        menu.setAttribute("aria-label", "Show schedules from");
        const item = (o) => {
          const c = scopeCount(o.p, o.d);
          const on = ui.project === o.p && ui.device === o.d;
          return `<button type="button" class="menu-item${o.sub ? " da-menu-sub" : ""}" role="menuitemradio" aria-checked="${on}" data-p="${esc(o.p)}" data-d="${esc(o.d)}">${o.icon}<span class="trunc">${esc(o.name)}</span><span class="da-menu-n tnum"${c.full ? " data-full" : ""}>${esc(c.text)}</span>${ic("check", "da-menu-check")}</button>`;
        };
        const rows = [item({ p: "all", d: "all", icon: ic("layers"), name: "All projects" })];
        rows.push('<div class="menu-sep"></div>');
        for (const p of S.projects) {
          rows.push(item({ p: p.id, d: "all", icon: avHtml(p), name: p.name }));
          if (p.checkouts.length > 1)
            for (const c of p.checkouts)
              rows.push(
                item({
                  p: p.id,
                  d: c.deviceId,
                  icon: deviceIcon(c.deviceId),
                  name: Q.device(c.deviceId)?.name ?? c.deviceId,
                  sub: true,
                }),
              );
        }
        menu.innerHTML = rows.join("");
        menuKeys(menu);
        const pop = popover(scopeBtn, menu, {
          placement: "bottom-start",
          container: root,
          width: 248,
          initialFocus: '[aria-checked="true"]',
        });
        menu.addEventListener("click", (e) => {
          const b = e.target.closest("[data-p]");
          if (!b) return;
          pop?.close();
          setScope({ project: b.dataset.p, device: b.dataset.d });
        });
      });

      function setScope(o) {
        const same = o.project === ui.project && o.device === ui.device;
        ui.project = o.project;
        ui.device = o.device;
        if (!same) render({ settleList: true });
      }

      /* ---------------------------------------------------------- strip */
      const strip = h("div", "da-strip");
      // The slot is always 44px: when nothing waits it says so quietly, so
      // a run coming due (or expiring) on a sim tick never moves the list.
      strip.innerHTML = `
        <button type="button" class="da-strip-sum" aria-expanded="false" aria-controls="da-strip-body" data-fid="strip">
          <span class="da-strip-ring"></span>
          <span class="da-strip-text"></span>
          <span class="da-strip-next tnum"></span>
          ${ic("chevD", "da-chev")}
        </button>
        <div class="da-strip-idle" hidden><span>Nothing waiting for approval</span><span class="da-strip-next tnum"></span></div>
        <div class="da-strip-body" id="da-strip-body"><div class="da-strip-in"><div class="da-strip-list" role="list" aria-label="Runs waiting for approval"></div></div></div>`;
      stripHost.append(strip);
      const stripSum = $(".da-strip-sum", strip);
      const stripList = $(".da-strip-list", strip);
      stripSum.addEventListener("click", () => {
        ui.stripOpen = !ui.stripOpen;
        paintStrip();
        if (ui.stripOpen) settle($$(".da-ap", stripList), { stagger: 30, y: 4, duration: 280 });
      });

      function renderAp(el, it) {
        const r = it.r;
        el.className = "da-ap";
        el.setAttribute("role", "listitem");
        el.dataset.run = r.id;
        const proj = Q.project(r.projectId)?.name ?? r.projectId;
        el.innerHTML = `
          <span class="da-ap-timer" role="img" aria-label="Expires at ${esc(fmt.time(r.expiresAt))}">${ringSvg(expiryFrac(r))}</span>
          <div class="da-ap-txt">
            <button type="button" class="da-ap-title trunc" data-select="${esc(r.automationId)}" data-fid="ap-title:${esc(r.id)}">${esc(r.title)}</button>
            <span class="da-ap-sub trunc">${coalescedHtml(r.coalescedOccurrences)}<span>${esc(proj)} · due ${esc(fmt.time(r.scheduledFor))}</span></span>
          </div>
          <span class="da-ap-cd tnum" aria-hidden="true"></span>
          <div class="da-ap-act">
            <button type="button" class="btn xs primary" data-approve-run="${esc(r.id)}" data-fid="ap-ok:${esc(r.id)}" data-tip="${esc(consequence(r))}" aria-label="Approve run: ${esc(r.title)}">Approve run</button>
            <button type="button" class="btn ghost xs" data-reject-run="${esc(r.id)}" data-fid="ap-rej:${esc(r.id)}" aria-label="Reject run: ${esc(r.title)}">Reject</button>
          </div>`;
      }
      const stripIdle = $(".da-strip-idle", strip);
      function paintStrip() {
        const due = Q.dueApprovals();
        const idle = !due.length;
        if (idle && !stripSum.hidden && stripSum === document.activeElement)
          requestAnimationFrame(() =>
            (rowEl(ui.selected)?.querySelector(".da-row-main") ?? newBtn).focus({
              preventScroll: true,
            }),
          );
        stripSum.hidden = idle;
        stripIdle.hidden = !idle;
        if (idle) {
          ui.stripOpen = false;
          strip.removeAttribute("data-open");
          stripSum.setAttribute("aria-expanded", "false");
          reconcile(stripList, [], renderAp);
          $(".da-strip-body", strip).inert = true;
          // When the next run anywhere will ask.
          let next = Infinity;
          for (const a of S.automations)
            if (Q.isActive(a) && a.nextRunAt < next) next = a.nextRunAt;
          setText(
            $(".da-strip-next", stripIdle),
            Number.isFinite(next) ? `next asks ${sched.relative(next)}` : "",
          );
          return;
        }
        const first = due[0];
        const sumRing = $(".da-strip-ring", strip);
        if (!sumRing.firstChild) sumRing.innerHTML = ringSvg(expiryFrac(first));
        patchRing(sumRing, expiryFrac(first));
        setText(
          $(".da-strip-text", strip),
          `${plural(due.length, "run")} ${due.length === 1 ? "waits" : "wait"} for approval`,
        );
        setText($(".da-strip-next", stripSum), `next expires in ${expiryShort(first)}`);
        stripSum.setAttribute("aria-expanded", String(ui.stripOpen));
        strip.toggleAttribute("data-open", ui.stripOpen);
        const before = new Set($$(".da-ap", stripList).map((e) => e.dataset.key));
        reconcile(
          stripList,
          due.map((r) => ({
            key: `ap:${r.id}`,
            sig: JSON.stringify([r.id, r.title, r.coalescedOccurrences, r.projectId, r.expiresAt]),
            r,
          })),
          renderAp,
          { exit: collapseOut },
        );
        for (const el of $$(".da-ap:not([data-leaving])", stripList)) {
          const r = Q.run(el.dataset.run);
          if (!r) continue;
          patchRing(el, expiryFrac(r));
          setText($(".da-ap-cd", el), expiryShort(r));
          if (ui.stripOpen && !before.has(el.dataset.key) && before.size) settle(el, { y: 4 });
        }
        $(".da-strip-body", strip).inert = !ui.stripOpen;
      }
      strip.addEventListener("click", (e) => {
        const ok = e.target.closest("[data-approve-run]");
        const no = e.target.closest("[data-reject-run]");
        const sel = e.target.closest("[data-select]");
        if (ok || no) {
          const rid = (ok ?? no).dataset[ok ? "approveRun" : "rejectRun"];
          const next = stripFocusAfter(rid);
          if (ok) act.approveRun(rid);
          else act.rejectRun(rid);
          announce(ok ? "Run approved" : "Run rejected");
          const a = document.activeElement;
          if (!strip.contains(a) || a.closest("[data-leaving]"))
            (
              next?.() ??
              (stripSum.hidden
                ? (rowEl(ui.selected)?.querySelector(".da-row-main") ?? newBtn)
                : stripSum)
            ).focus({
              preventScroll: true,
            });
          return;
        }
        if (sel) selectSchedule(sel.dataset.select, { reveal: true, focusRow: false });
      });
      function stripFocusAfter(rid) {
        const rows = $$(".da-ap:not([data-leaving])", stripList);
        const i = rows.findIndex((x) => x.dataset.run === rid);
        const n = rows[i + 1] ?? rows[i - 1];
        return n ? () => n.querySelector("[data-approve-run]") : null;
      }

      /* ---------------------------------------------------------- list */
      /* Row state, said once: a 12px glyph in the right column (ring for a
         due run, hourglass for a pending change, a dot while a run starts,
         pause) plus at most one muted word on the meta line. The approval
         itself lives in the strip / history (runs) and the detail (changes). */
      function rowState(r) {
        const a = r.automation;
        const p = r.proposal;
        let glyph = "";
        let tip = "";
        let word = "";
        if (a?.cancelled) word = "Cancelled";
        else if (r.state === "finished") word = "Finished";
        else if (r.state === "paused") word = "Paused";
        else if (r.state === "running") word = Lab.statusLabel(r.activeRun?.status ?? "executing");
        if (p && p.kind !== "create") word = PEND_WORD[p.kind] ?? "Change pending";
        if (r.dueRun) {
          glyph = "due";
          tip = `Waiting for approval · expires ${fmt.time(r.dueRun.expiresAt)}`;
        } else if (p) {
          glyph = "pend";
          const dl = proposalDeadline(p);
          tip = `Waiting for your approval · ${dl.byFirstRun ? "approve by" : "expires"} ${fmt.time(dl.at)}`;
        } else if (r.state === "running") {
          // The shared status dot, so the row and its history agree.
          glyph = `run:${r.activeRun?.status ?? "executing"}`;
          tip = word;
        } else if (r.state === "paused" && !a?.cancelled) {
          glyph = "paused";
          tip = "Paused";
        }
        return { glyph, tip, word };
      }
      /* The cadence; a schedule that only exists as a proposal says when it
         would start instead of counting down to a run nobody approved. */
      /* [cadence, until]: the until part gives way first when space is short. */
      function rowLabel(r) {
        const s = r.def.schedule;
        if (r.state === "pending-create")
          return [
            `${s.kind === "once" ? "Runs" : "Starts"} ${sched.relative(sched.first(s))} if approved`,
            "",
          ];
        if (s.kind === "once") return [sched.label(s), ""];
        return [sched.cadence(s), `until ${fmt.date(s.endsAt)}`];
      }
      function rowWhen(r) {
        if (
          r.automation?.cancelled ||
          r.state === "paused" ||
          r.state === "finished" ||
          r.state === "pending-create"
        )
          return "";
        return untilText(r.nextRunAt);
      }
      const GLYPH = {
        due: () => ringSvg(1),
        pend: () => ic("hourglass"),
        run: (status) => Lab.statusDot(status).replace(/ data-tip="[^"]*"/, ""),
        paused: () => ic("pause"),
      };
      /* Patch a row in place: built once, then only text, attributes and the
         glyph change, so a sim tick never replaces a focused row. */
      function patchRow(el, r) {
        const st = rowState(r);
        el.dataset.state = r.automation?.cancelled ? "cancelled" : r.state;
        setText($(".da-row-title", el), r.title);
        const [cad, till] = rowLabel(r);
        const label = till ? `${cad} · ${till}` : cad;
        setText($(".da-row-cad", el), cad);
        setText($(".da-row-until", el), till);
        setText($(".da-row-word", el), st.word);
        const when = rowWhen(r);
        setText($(".da-row-when", el), when);
        const g = $(".da-row-glyph", el);
        if (g.dataset.g !== st.glyph) {
          g.dataset.g = st.glyph;
          const [kind, arg] = st.glyph.split(":");
          g.innerHTML = kind ? GLYPH[kind](arg) : "";
        }
        if (st.glyph === "due") patchRing(g, expiryFrac(r.dueRun));
        if (st.tip) g.dataset.tip = st.tip;
        else delete g.dataset.tip;
        const main = $(".da-row-main", el);
        const name = [
          r.title,
          st.glyph === "due" ? "waiting for approval" : "",
          st.word,
          label,
          when ? `next run ${when}` : "",
        ]
          .filter(Boolean)
          .join(", ");
        if (main.getAttribute("aria-label") !== name) main.setAttribute("aria-label", name);
      }
      function renderListItem(el, it) {
        if (it.kind === "group") {
          const p = it.p;
          const atLimit = it.active >= PER_PROJECT;
          el.className = "da-group";
          el.setAttribute("role", "presentation");
          el.innerHTML = `<span class="da-av" style="--hue:${p.hue}">${esc(p.name[0].toUpperCase())}</span><span class="da-group-name">${esc(p.name)}</span>${
            it.active >= PER_PROJECT - 5
              ? `<span class="da-group-meta tnum" ${atLimit ? 'data-full data-tip="The most a project can have. Pause or cancel one to add another."' : ""}>${it.active} of ${PER_PROJECT} active</span>`
              : ""
          }`;
          return;
        }
        if (it.kind === "device") {
          el.className = "da-devh";
          el.setAttribute("role", "presentation");
          el.innerHTML = `${deviceIcon(it.d)}<span>${esc(Q.device(it.d)?.name ?? it.d)}</span>`;
          return;
        }
        const r = it.r;
        if (el._built) return;
        el._built = true;
        el.className = "da-row";
        el.setAttribute("role", "listitem");
        el.dataset.id = r.id;
        el.innerHTML = `
          <button type="button" class="da-row-main" data-fid="row:${esc(r.id)}">
            <span class="da-row-title trunc"></span><span class="da-row-when tnum" aria-hidden="true"></span>
            <span class="da-row-meta" aria-hidden="true"><span class="da-row-cad trunc"></span><span class="da-row-until trunc"></span><span class="da-row-word"></span></span><span class="da-row-glyph" aria-hidden="true"></span>
          </button>`;
      }
      function listItems(rows) {
        const items = [];
        for (const p of S.projects) {
          const pr = rows.filter((r) => r.projectId === p.id);
          if (!pr.length) continue;
          const active = Q.activeCount(p.id);
          items.push({ key: `g:${p.id}`, kind: "group", p, active, sig: `g|${p.name}|${active}` });
          const split = ui.device === "all" && p.checkouts.length > 1;
          const groups = split ? p.checkouts.map((c) => c.deviceId) : [null];
          for (const d of groups) {
            const dr = sortRows(d ? pr.filter((r) => r.deviceId === d) : pr);
            if (!dr.length) continue;
            if (d) items.push({ key: `d:${p.id}:${d}`, kind: "device", d, sig: `d|${d}` });
            for (const r of dr)
              items.push({
                key: `r:${r.id}`,
                kind: "row",
                r,
                sig: "row",
              });
          }
        }
        return items;
      }
      let lastOrder = "";
      function paintList(rows, o = {}) {
        const items = listItems(rows);
        const order = items.map((i) => i.key).join(",");
        const structural = order !== lastOrder;
        const first = !lastOrder;
        lastOrder = order;
        const run = () => reconcile(list, items, renderListItem);
        if (structural && !first && !o.settleList)
          Lab.flip(list, run, { selector: ".da-row, .da-group, .da-devh" });
        else run();
        if (o.settleList || first)
          settle($$(".da-row, .da-group, .da-devh", list).slice(0, 12), {
            stagger: 18,
            y: 4,
            duration: 300,
          });
        for (const el of $$(".da-row", list)) {
          const r = rows.find((x) => x.id === el.dataset.id);
          if (r) patchRow(el, r);
          const sel = el.dataset.id === ui.selected;
          el.toggleAttribute("data-selected", sel);
          $(".da-row-main", el).setAttribute("aria-current", sel ? "true" : "false");
        }
        // Cancelled schedules stay out of the way, one quiet line at the end.
        const nCancelled = scopeRows({ cancelled: true }).filter(
          (r) => r.automation?.cancelled,
        ).length;
        patchSlot(listFoot, `${nCancelled}|${ui.showCancelled}`, () => {
          listFoot.innerHTML = nCancelled
            ? `<button type="button" class="da-foot-btn" data-fid="cancelled-toggle" aria-expanded="${ui.showCancelled}">${ui.showCancelled ? "Hide" : "Show"} ${plural(nCancelled, "cancelled schedule")}</button>`
            : "";
        });
        // Pointer selection slides the plate; keyboard stepping moves it at once.
        placeHighlight((structural && !first) || (o.selection && !o.fromKey));
      }
      listFoot.addEventListener("click", (e) => {
        if (!e.target.closest(".da-foot-btn")) return;
        ui.showCancelled = !ui.showCancelled;
        render();
      });

      let hlPlaced = false;
      function placeHighlight(animate) {
        const el = rowEl(ui.selected);
        if (!el) {
          hl.style.opacity = "0";
          hlPlaced = false;
          hl._y = null;
          return;
        }
        const y = el.offsetTop;
        const ht = el.offsetHeight;
        if (hlPlaced && hl._y === y && hl._h === ht) return;
        hl._y = y;
        hl._h = ht;
        const move = animate && hlPlaced && motionOn();
        hl.style.transition = move
          ? `transform 340ms ${EASE}, height 340ms ${EASE}, opacity 120ms`
          : "opacity 120ms";
        hl.style.transform = `translateY(${y}px)`;
        hl.style.height = `${ht}px`;
        hl.style.opacity = "1";
        hlPlaced = true;
      }
      new ResizeObserver(() => placeHighlight(false)).observe(list);

      list.addEventListener("click", (e) => {
        const main = e.target.closest(".da-row-main");
        if (main) selectSchedule(main.closest(".da-row").dataset.id);
      });
      list.addEventListener("keydown", (e) => {
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
        if (!e.target.closest(".da-row-main")) return;
        e.preventDefault();
        moveSelection(
          e.key === "ArrowDown"
            ? 1
            : e.key === "ArrowUp"
              ? -1
              : e.key === "Home"
                ? -Infinity
                : Infinity,
        );
      });
      function moveSelection(d) {
        const ids = $$(".da-row", list).map((x) => x.dataset.id);
        if (!ids.length) return;
        const i = ids.indexOf(ui.selected);
        const n =
          d === -Infinity
            ? 0
            : d === Infinity
              ? ids.length - 1
              : clamp((i < 0 ? 0 : i) + d, 0, ids.length - 1);
        selectSchedule(ids[n], { focusRow: true, fromKey: true });
      }
      function selectSchedule(id, o = {}) {
        if (o.reveal && !scopeRows({ cancelled: true }).some((r) => r.id === id)) {
          ui.project = "all";
          ui.device = "all";
        }
        const changed = ui.selected !== id;
        ui.selected = id;
        render({ selection: changed, fromKey: !!o.fromKey });
        const el = rowEl(id);
        el?.scrollIntoView({ block: "nearest" });
        if (o.focusRow) el?.querySelector(".da-row-main")?.focus({ preventScroll: true });
      }

      function approveProposal(pid, aid) {
        const p = Q.proposal(pid);
        if (!p) return;
        const res = act.approve(pid);
        if (!res) {
          const after = Q.proposal(pid);
          const again = after?.after && (after.kind === "create" || after.kind === "edit");
          api.notify(after?.detail ?? "That change couldn't be applied.", {
            tone: "err",
            duration: 8000,
            action: again ? { label: "Propose again", run: () => proposeAgain(after) } : undefined,
          });
          return;
        }
        announce(`${PEND_VERB[p.kind] ?? "Change"} approved for ${res.title}`);
        const el = rowEl(aid ?? res.id);
        if (el) settle(el, { y: 0, duration: 260 });
      }

      /* ---------------------------------------------------------- detail */
      const D = {
        el: null,
        pv: null,
        pvSig: "",
      };
      function buildDetail(id) {
        D.pv?.destroy();
        D.pv = null;
        D.pvSig = "";
        detail.innerHTML = "";
        const wrap = h("div", "da-d");
        wrap.dataset.id = id;
        wrap.innerHTML = `
          <header class="da-dh">
            <h2 class="da-dh-title" tabindex="-1"></h2>
            <div class="da-dh-act"></div>
          </header>
          <div class="da-pend"></div>
          <div class="da-dg">
            <div class="da-dg-main">
              <p class="da-sentence"></p>
              <div class="da-prompt"></div>
              <dl class="da-facts"></dl>
            </div>
            <aside class="da-next" aria-label="Next runs">
              <header class="da-pv-h"><span class="da-pv-t"></span><span class="da-pv-n tnum"></span></header>
              <div class="da-next-body"></div>
            </aside>
          </div>
          <section class="da-hist" aria-label="Run history">
            <header class="da-hist-h"><h3>History</h3><span class="da-hist-meta tnum"></span></header>
            <div class="da-hist-list" role="list"></div>
          </section>`;
        detail.append(wrap);
        D.el = wrap;
        ui.detailFor = id;
        return wrap;
      }

      /* While a change waits for approval, a second change would silently
         replace it: Pause / Resume / Cancel stay put but say why they can't
         act. Edit stays live — it edits the proposed change, and says so. */
      function renderActions(r) {
        const a = r.automation;
        const p = r.proposal;
        if (a?.cancelled) return "";
        const lock = p ? ` aria-disabled="true" data-tip="${PEND_LOCK}"` : "";
        const out = [
          `<button type="button" class="btn sm" data-act="edit" data-fid="act:edit" data-tip="${p ? "Edit the proposed change · E" : "Edit · E"}">${ic("edit")}Edit</button>`,
        ];
        if (a) {
          out.push(
            a.enabled
              ? `<button type="button" class="btn sm" data-act="pause" data-fid="act:pause"${lock}>${ic("pause")}Pause</button>`
              : `<button type="button" class="btn sm" data-act="resume" data-fid="act:resume"${lock}>${ic("play")}Resume</button>`,
          );
          out.push(
            `<button type="button" class="btn sm ghost da-danger" data-act="cancel" data-fid="act:cancel" aria-haspopup="dialog" aria-expanded="false"${lock}>Cancel schedule</button>`,
          );
        }
        return out.join("");
      }

      /* "expires 10:51 · 9m", or "approve by 10:45 · 3m" when the change's
         first run comes before its 15-minute expiry. */
      function deadlineText(p) {
        const dl = proposalDeadline(p);
        return `${dl.byFirstRun ? "approve by" : "expires"} ${fmt.time(dl.at)} · ${leftShort(dl.at)}`;
      }
      /* What happens meanwhile. The next run is only named when it comes
         before this change can lapse — otherwise the rail already says it. */
      function pendLead(r) {
        const p = r.proposal;
        const next = r.automation?.nextRunAt;
        const soon = next != null && next < p.expiresAt ? sched.relative(next) : null;
        switch (p.kind) {
          case "create":
            return "Nothing runs until you approve it.";
          case "edit":
            return soon
              ? `The current rule still runs ${soon} unless you approve first.`
              : "The current rule keeps running until you approve.";
          case "pause":
            return soon
              ? `It still runs ${soon} unless you approve first.`
              : "It keeps running until you approve.";
          case "resume":
            return p.after
              ? `Resumes from ${fmt.dateTime(sched.first(p.after.schedule))} once approved.`
              : "Resumes once approved.";
          case "cancel":
            return soon
              ? `It still runs ${soon} unless you approve first. History stays.`
              : "It keeps running until you approve. History stays.";
          default:
            return "";
        }
      }
      function pendHtml(r) {
        const p = r.proposal;
        if (!p) return "";
        const dl = proposalDeadline(p);
        const rows = diffRows(p);
        return `
          <div class="da-pend-in" role="group" aria-label="Pending change">
            <div class="da-pend-h">
              ${ic("hourglass", "da-pend-ic")}
              <div class="da-pend-t"><b>Waiting for your approval</b><span class="da-pend-sub">${esc(PEND_VERB[p.kind])} at ${esc(fmt.time(p.createdAt))} · <span class="da-pend-lead"></span></span></div>
              <span class="da-pend-exp tnum" data-pexp="${esc(p.id)}"${
                dl.byFirstRun
                  ? ` data-tip="${esc(`Its first run is at ${fmt.time(dl.at)}; after that this change can't apply.`)}"`
                  : ""
              }></span>
              <div class="da-pend-act">
                <button type="button" class="btn sm ghost" data-reject-proposal="${esc(p.id)}" data-fid="pend-rej">Reject</button>
                <button type="button" class="btn sm primary" data-approve-proposal="${esc(p.id)}" data-fid="pend-ok">${ic("check")}Approve</button>
              </div>
            </div>
            ${
              rows.length
                ? `<dl class="da-diff">${rows
                    .map(
                      ([k, b, a2]) =>
                        `<div class="da-diff-r"><dt>${k}</dt><dd>${b != null ? `<span class="da-was">${b}</span><span class="da-arrow" aria-label="to">→</span>` : ""}<span class="da-now">${a2}</span></dd></div>`,
                    )
                    .join("")}</dl>`
                : ""
            }
          </div>`;
      }

      /* A change that ended without being applied (expired, or failed on
         approval) leaves one quiet line instead of vanishing. */
      function lostProposal(r) {
        if (!r.automation || r.proposal) return null;
        let last = null;
        for (const p of S.proposals)
          if (p.automationId === r.id && !p.pending && (!last || p.decidedAt >= last.decidedAt))
            last = p;
        if (!last || !["expired", "failed"].includes(last.status) || ui.dismissed.has(last.id))
          return null;
        return last;
      }
      function lostHtml(p) {
        const noun = KIND_NOUN[p.kind] ?? "change";
        const text =
          p.status === "expired"
            ? `Your ${noun} expired unapproved at ${fmt.time(p.decidedAt)}.`
            : `Your ${noun} couldn't be applied: ${p.detail ?? "it failed on approval."}`;
        return `<div class="da-lost" role="status">${ic("hourglass", "da-lost-ic")}<span class="da-lost-t">${esc(text)}</span><button type="button" class="btn ghost xs" data-repropose="${esc(p.id)}" data-fid="lost-again">Propose again</button><button type="button" class="btn ghost icon xs" data-dismiss-lost="${esc(p.id)}" aria-label="Dismiss" data-tip="Dismiss">${ic("x")}</button></div>`;
      }

      /* Model, permissions and device: stacked label / value, one per row,
         ellipsized, so long names never run into each other. Where it runs
         (worktree / checkout) is already in the sentence. */
      function factsHtml(def, deviceId) {
        const sel = def.execution.modelSelection;
        const m = Q.model(sel.instanceId, sel.model);
        const effort = sel.options?.find((o) => o.id === "effort")?.value;
        return `
          <div class="da-fact"><dt>Model</dt><dd>${providerMark(sel.instanceId)}<span class="trunc">${esc(m?.name ?? sel.model)}${
            effort && m ? `<span class="da-fact-dim"> · ${esc(cap(effort))} effort</span>` : ""
          }</span>${m ? "" : `<span class="da-warn-t" data-tip="${esc(`${sel.model} isn't available on ${Q.provider(sel.instanceId)?.name ?? sel.instanceId} any more`)}">${ic("alert")}Unavailable</span>`}</dd></div>
          <div class="da-fact"><dt>Permissions</dt><dd><span class="trunc" data-tip="${esc(Lab.RUNTIME_MODES.find((x) => x.id === def.execution.runtimeMode)?.hint ?? "")}">${esc(fmt.runtimeMode(def.execution.runtimeMode))}</span></dd></div>
          <div class="da-fact"><dt>Device</dt><dd>${deviceIcon(deviceId)}<span class="trunc">${esc(Q.device(deviceId)?.name ?? deviceId)}</span></dd></div>`;
      }

      function nextHtmlFor(r) {
        const a = r.automation;
        if (a?.cancelled)
          return `<p class="da-next-empty">Cancelled ${esc(sched.relative(a.cancelledAt))}. Nothing runs again; its history stays below.</p>`;
        if (r.state === "paused")
          return `<p class="da-next-empty"><b>Paused.</b> Nothing runs until you resume it — and resuming waits for your approval too.</p>`;
        if (r.state === "finished")
          return `<p class="da-next-empty">It ended ${esc(sched.relative(sched.last(r.def.schedule)))}. No more runs.</p>`;
        return null;
      }
      /* The preview's own header and horizon strip are replaced by one
         header that only counts (the sentence already says until when). */
      function pvCount(s) {
        if (!s) return "";
        if (s.kind === "once") return "";
        const n = sched.count(s, S.now);
        return n ? plural(n, "run") : "";
      }

      /* History: grouped by day, newest first. */
      function dayLabel(ms) {
        const n = Math.round(
          (new Date(ms).setHours(0, 0, 0, 0) - new Date(S.now).setHours(0, 0, 0, 0)) / DAY,
        );
        if (n === 0) return "Today";
        if (n === -1) return "Yesterday";
        return fmt.day(ms);
      }
      /* Several runs a day: group under day headings. Daily or slower: one
         run per day, so the date moves into the time column instead of
         repeating a heading over every row. */
      function histFlat(row) {
        const s = row?.def?.schedule;
        return !s || s.kind === "once" || s.intervalMs >= DAY;
      }
      function histItems(id, flat) {
        const runs = Q.runsFor(id).sort(
          (a, b) => b.scheduledFor - a.scheduledFor || b.createdAt - a.createdAt,
        );
        const items = [];
        let day = null;
        let offered = false;
        for (const r of runs) {
          const dl = dayLabel(r.scheduledFor);
          if (!flat && dl !== day) {
            day = dl;
            items.push({ key: `day:${dl}`, kind: "day", label: dl, sig: dl });
          }
          // One Retry per schedule: on its newest retryable run.
          let retry = Q.canRetry(r);
          if (retry.ok) {
            if (offered) retry = { ok: false, reason: "A newer run can be retried instead." };
            offered = true;
          }
          items.push({
            key: `run:${r.id}`,
            kind: "run",
            r,
            flat,
            retry,
            sig: JSON.stringify([
              flat ? dl : "",
              r.status,
              r.unread,
              r.threadIds,
              r.safeFailureDetail,
              r.coalescedOccurrences,
              retry.ok,
              retry.reason,
              r.retryOfRunId,
              r.expiresAt,
            ]),
          });
        }
        return items;
      }
      const infoHtml = (reason, id) =>
        reason
          ? `<span class="da-run-info" tabindex="0" role="img" data-tip="${esc(reason)}" aria-label="${esc(reason)}" data-fid="h-info:${esc(id)}">${ic("info")}</span>`
          : "";
      function renderHist(el, it) {
        if (it.kind === "day") {
          el.className = "da-day";
          el.setAttribute("role", "presentation");
          el.textContent = it.label;
          return;
        }
        const r = it.r;
        el.className = "da-run";
        el.setAttribute("role", "listitem");
        el.tabIndex = -1;
        el.dataset.status = r.status;
        el.dataset.run = r.id;
        el.toggleAttribute("data-unread", !!r.unread);
        const label = Lab.statusLabel(r.status);
        let bodyHtml = "";
        let actHtml = "";
        const retry = it.retry;
        switch (r.status) {
          case "pending-approval":
            bodyHtml = `<span class="da-run-exp">${ringSvg(expiryFrac(r))}<span>Expires ${esc(fmt.time(r.expiresAt))} · <span class="tnum da-run-cd"></span></span></span><span class="da-run-why trunc">${esc(consequence(r))}</span>`;
            actHtml = `<button type="button" class="btn ghost xs" data-reject-run="${esc(r.id)}" data-fid="h-rej:${esc(r.id)}" aria-label="Reject run due ${esc(fmt.time(r.scheduledFor))}">Reject</button><button type="button" class="btn xs primary" data-approve-run="${esc(r.id)}" data-fid="h-ok:${esc(r.id)}" aria-label="Approve run due ${esc(fmt.time(r.scheduledFor))}">Approve run</button>`;
            break;
          case "approved":
            bodyHtml = `<span class="da-run-note">Approved — the thread starts in a moment.</span>`;
            break;
          case "executing":
            bodyHtml = `<span class="da-run-note">Starting the thread on ${esc(Q.device(r.deviceId)?.name ?? r.deviceId)}…</span>`;
            break;
          case "completed": {
            const t = Q.thread(r.threadIds?.[0]);
            bodyHtml = `<span class="da-run-thread trunc">${esc(t?.title ?? "Thread started")}</span>`;
            if (t)
              actHtml = `<button type="button" class="btn ghost xs da-open" data-open-thread="${esc(t.id)}" data-run="${esc(r.id)}" data-fid="h-open:${esc(r.id)}" aria-label="Open thread ${esc(t.title)}">Open thread${ic("arrowUpRight")}</button>`;
            break;
          }
          case "failed":
            bodyHtml = `<span class="da-run-fail">${esc(r.safeFailureDetail ?? "The thread did not start.")}</span>`;
            actHtml = infoHtml(retry.reason, r.id);
            break;
          case "rejected":
            bodyHtml = `<span class="da-run-note">You rejected this run.</span>`;
            break;
          case "expired":
            bodyHtml = `<span class="da-run-note">Not approved within 15 minutes.</span>`;
            break;
          case "cancelled":
            bodyHtml = `<span class="da-run-note">${esc(r.safeFailureDetail ?? "Cancelled.")}</span>`;
            break;
          default:
            bodyHtml = `<span class="da-run-note">${esc(label)}</span>`;
        }
        // Runs that could be retried but can't say why not, quietly.
        if (["expired", "rejected", "cancelled"].includes(r.status) && !retry.ok)
          actHtml = infoHtml(retry.reason, r.id);
        if (retry.ok)
          actHtml = `<button type="button" class="btn ghost xs" data-retry-run="${esc(r.id)}" data-fid="h-retry:${esc(r.id)}" data-tip="Asks for approval again — 15 minutes to approve">${ic("retry")}Retry with approval</button>`;
        el.innerHTML = `
          <span class="da-run-time tnum">${it.flat ? `<span class="da-run-day">${esc(dayLabel(r.scheduledFor))}</span>` : ""}${esc(fmt.time(r.scheduledFor))}</span>
          <span class="da-run-st">${Lab.statusDot(r.status)}<span>${esc(label)}</span></span>
          <span class="da-run-body">${coalescedHtml(r.coalescedOccurrences)}${r.retryOfRunId ? `<span class="da-tag" data-tip="Retried after the first request ${esc(Q.run(r.retryOfRunId)?.status === "expired" ? "expired" : "ended")}">Retry</span>` : ""}${bodyHtml}</span>
          <span class="da-run-act">${actHtml}</span>`;
      }

      function paintDetail(rows, o = {}) {
        const r = rowById(ui.selected);
        if (!r) {
          detail.innerHTML = "";
          D.el = null;
          ui.detailFor = null;
          return;
        }
        const fresh = ui.detailFor !== r.id || !D.el;
        const el = fresh ? buildDetail(r.id) : D.el;
        const a = r.automation;

        patchSlot($(".da-dh-title", el), r.title, () => setText($(".da-dh-title", el), r.title));
        const act = $(".da-dh-act", el);
        // Markup doesn't depend on the run state, so ticks never rebuild it.
        patchSlot(
          act,
          JSON.stringify([a?.enabled, a?.cancelled, !!a, !!r.proposal]),
          () => (act.innerHTML = renderActions(r)),
        );

        const pend = $(".da-pend", el);
        const lost = lostProposal(r);
        const pSig = r.proposal
          ? `p|${r.proposal.id}|${r.proposal.kind}`
          : lost
            ? `lost|${lost.id}`
            : "";
        const pendChanged = patchSlot(pend, pSig, () => {
          pend.innerHTML = r.proposal ? pendHtml(r) : lost ? lostHtml(lost) : "";
          pend.hidden = !r.proposal && !lost;
        });
        if (pendChanged && !fresh && pSig) settle(pend, { y: 4 });
        if (r.proposal) {
          setText($("[data-pexp]", pend), deadlineText(r.proposal));
          setText($(".da-pend-lead", pend), pendLead(r));
        }

        const sent = $(".da-sentence", el);
        const minute = Math.floor(S.now / MIN);
        patchSlot(
          sent,
          JSON.stringify([
            r.def.schedule,
            r.def.execution.envMode,
            r.def.execution.baseRef,
            Math.floor(S.now / DAY),
          ]),
          () => {
            sent.innerHTML = sentenceHtml(r.def);
          },
        );
        const pr = $(".da-prompt", el);
        patchSlot(pr, r.def.execution.prompt, () => {
          pr.innerHTML = `<span class="da-k">Prompt</span><p>${esc(r.def.execution.prompt)}</p>`;
        });
        const facts = $(".da-facts", el);
        patchSlot(
          facts,
          JSON.stringify([r.def.execution.modelSelection, r.def.execution.runtimeMode, r.deviceId]),
          () => {
            facts.innerHTML = factsHtml(r.def, r.deviceId);
          },
        );

        // Next runs: the shared preview under one counting header, or a plain
        // sentence when nothing is coming.
        const next = $(".da-next-body", el);
        const emptyNext = nextHtmlFor(r);
        setText(
          $(".da-pv-t", el),
          r.state === "pending-create" ? "Next runs if approved" : "Next runs",
        );
        setText($(".da-pv-n", el), emptyNext ? "" : pvCount(r.def.schedule));
        if (emptyNext) {
          D.pv?.destroy();
          D.pv = null;
          patchSlot(next, `empty|${emptyNext}`, () => (next.innerHTML = emptyNext));
        } else {
          const sSig = JSON.stringify(r.def.schedule);
          if (!D.pv) {
            next.innerHTML = "";
            next._sig = "pv";
            D.pv = Pickers.preview(next, {
              schedule: r.def.schedule,
              nowMs: S.now,
              title: "Next runs",
            });
            D.pvSig = `${sSig}|${minute}`;
          } else if (D.pvSig !== `${sSig}|${minute}`) {
            D.pv.update(r.def.schedule, S.now);
            D.pvSig = `${sSig}|${minute}`;
          }
        }

        // History
        const hist = $(".da-hist-list", el);
        const flat = histFlat(r);
        hist.toggleAttribute("data-flat", flat);
        const items = histItems(r.id, flat);
        const nRuns = items.filter((x) => x.kind === "run").length;
        setText(
          $(".da-hist-meta", el),
          nRuns ? `${plural(nRuns, "run")} · the last ${Lab.LIMITS.historyMax} are kept` : "",
        );
        if (!nRuns) {
          const firstAsk =
            a && a.enabled && r.nextRunAt
              ? ` The first one asks for your approval ${sched.relative(r.nextRunAt)}.`
              : "";
          patchSlot(hist, `none|${r.id}|${firstAsk}`, () => {
            hist.innerHTML = `<p class="da-hist-empty">No runs yet.${esc(firstAsk)}</p>`;
          });
        } else {
          if (hist._sig?.startsWith?.("none|")) {
            hist.innerHTML = "";
            hist._sig = null;
          }
          const before = hist.children.length;
          const structural = reconcile(hist, items, renderHist);
          if (structural && before && !fresh)
            for (const x of $$(".da-run", hist))
              if (x._settle !== false && !x._seen) settle(x, { y: 4 });
          for (const x of $$(".da-run", hist)) x._seen = true;
        }
        for (const x of $$('.da-run[data-status="pending-approval"]', hist)) {
          const run = Q.run(x.dataset.run);
          if (!run) continue;
          patchRing(x, expiryFrac(run));
          setText($(".da-run-cd", x), expiryShort(run));
        }

        // Pointer selection eases the new detail in; keyboard stepping never
        // replays entrance motion.
        if (fresh && o.selection && !o.fromKey)
          settle([...el.children], { stagger: 34, y: 5, duration: 300 });
      }

      detail.addEventListener("click", (e) => {
        const t = e.target;
        const actBtn = t.closest("[data-act]");
        const r = rowById(ui.selected);
        if (actBtn && r) {
          if (actBtn.getAttribute("aria-disabled") === "true") return;
          const k = actBtn.dataset.act;
          if (k === "edit") openEditor(actBtn, r);
          else if (k === "pause") {
            act.pause(r.id);
            announce(`Pause proposed for ${r.title}`);
            flashRow(r.id);
          } else if (k === "resume") {
            act.resume(r.id);
            announce(`Resume proposed for ${r.title}`);
            flashRow(r.id);
          } else if (k === "cancel") confirmCancel(actBtn, r);
          return;
        }
        const okP = t.closest("[data-approve-proposal]");
        if (okP) return approveProposal(okP.dataset.approveProposal, ui.selected);
        const noP = t.closest("[data-reject-proposal]");
        if (noP) {
          act.reject(noP.dataset.rejectProposal);
          announce("Change rejected");
          return;
        }
        const again = t.closest("[data-repropose]");
        if (again) {
          const p = Q.proposal(again.dataset.repropose);
          if (p) {
            ui.dismissed.add(p.id);
            proposeAgain(p, again);
          }
          return;
        }
        const dismiss = t.closest("[data-dismiss-lost]");
        if (dismiss) {
          ui.dismissed.add(dismiss.dataset.dismissLost);
          render();
          $("[data-act='edit']", detail)?.focus({ preventScroll: true });
          return;
        }
        const okR = t.closest("[data-approve-run]");
        if (okR) {
          act.approveRun(okR.dataset.approveRun);
          announce("Run approved");
          return;
        }
        const noR = t.closest("[data-reject-run]");
        if (noR) {
          act.rejectRun(noR.dataset.rejectRun);
          announce("Run rejected");
          return;
        }
        const retry = t.closest("[data-retry-run]");
        if (retry) {
          const nr = act.retryRun(retry.dataset.retryRun);
          if (nr) {
            announce(`${nr.title} waits for approval again`);
            requestAnimationFrame(() =>
              $(`[data-key="run:${CSS.escape(nr.id)}"] [data-approve-run]`, detail)?.focus({
                preventScroll: true,
              }),
            );
          } else
            api.notify(
              Q.canRetry(Q.run(retry.dataset.retryRun)).reason ?? "Can't retry this run.",
              { tone: "warn" },
            );
          return;
        }
        const open = t.closest("[data-open-thread]");
        if (open) {
          act.markRead(open.dataset.run, true);
          act.openThread(open.dataset.openThread);
        }
      });

      /* Re-propose a change that expired or failed: edits and new schedules
         reopen the editor with what was proposed; pause / resume / cancel
         are proposed again directly (cancel asks first, as before). */
      function proposeAgain(p, origin) {
        const r = rowById(p.automationId);
        if (p.kind === "create")
          return openEditor(origin?.isConnected ? origin : newBtn, null, { source: p });
        if (!r?.automation) return;
        if (p.kind === "edit")
          return openEditor(
            origin?.isConnected ? origin : ($("[data-act='edit']", detail) ?? newBtn),
            r,
            { source: p },
          );
        if (p.kind === "cancel")
          return confirmCancel($("[data-act='cancel']", detail) ?? origin, r);
        const np = p.kind === "pause" ? act.pause(r.id) : act.resume(r.id);
        if (np) {
          announce(`${PEND_VERB[np.kind]} again for ${r.title}`);
          flashRow(r.id);
          requestAnimationFrame(() =>
            $("[data-fid='pend-ok']", detail)?.focus({ preventScroll: true }),
          );
        }
      }

      function flashRow(id) {
        const el = rowEl(id);
        if (!el || !motionOn()) return;
        el.animate([{ scale: "1" }, { scale: "1.012" }, { scale: "1" }], {
          duration: 280,
          easing: EASE,
        });
      }

      /* Cancel: a confirm that grows from its button; on confirm the
         popover folds into the row's pending glyph. */
      function confirmCancel(btn, r) {
        if (!btn) return;
        const box = h("div", "da-confirm");
        box.innerHTML = `
          <p class="da-confirm-t" id="da-confirm-t">Cancel “${esc(r.title)}”?</p>
          <p class="da-confirm-d" id="da-confirm-d">Future runs stop for good and it can't be resumed. Its history stays. Like any change, this waits for your approval.</p>
          <div class="da-confirm-act">
            <button type="button" class="btn sm ghost" data-keep>Keep schedule</button>
            <button type="button" class="btn sm destructive solid" data-confirm>Cancel schedule</button>
          </div>`;
        const pop = popover(btn, box, {
          placement: "bottom-end",
          container: root,
          width: 300,
          initialFocus: "[data-keep]",
        });
        if (!pop) return;
        pop.el.setAttribute("aria-labelledby", "da-confirm-t");
        pop.el.setAttribute("aria-describedby", "da-confirm-d");
        // Tab / focus leaving is handled by core's popover (closes, moves on).
        box.addEventListener("click", (e) => {
          if (e.target.closest("[data-keep]")) pop.close();
          else if (e.target.closest("[data-confirm]")) {
            act.cancel(r.id);
            announce(`Cancel proposed for ${r.title}`);
            const target = () => rowEl(r.id)?.querySelector(".da-row-glyph") ?? rowEl(r.id);
            pop.close(target);
          }
        });
      }

      /* ---------------------------------------------------------- empty
         The list already says "Nothing scheduled in scratch."; the reader
         adds a hint, never a second call to action. */
      function paintEmpty() {
        patchSlot(empty, "hint", () => {
          empty.innerHTML = `
            <div class="da-empty-in">
              ${ic("calendarClock", "da-empty-ic")}
              <p>A schedule runs a prompt at set times; each run asks you first.</p>
              <p class="da-empty-keys"><kbd class="kbd">N</kbd>new schedule</p>
            </div>`;
        });
      }

      /* ---------------------------------------------------------- render */
      function render(o = {}) {
        const rows = scopeRows();
        if (!rows.some((r) => r.id === ui.selected)) {
          const sorted = listItems(rows)
            .filter((x) => x.kind === "row")
            .map((x) => x.r);
          ui.selected =
            (sorted.find((r) => r.state === "awaiting-approval") ?? sorted[0])?.id ?? null;
          o.selection = true;
        }
        paintBar();
        paintStrip();
        // The page keeps its two panes when a filter comes up empty, so
        // switching projects never reflows the bar, the strip or the list.
        const isEmpty = rows.length === 0;
        detail.hidden = isEmpty;
        empty.hidden = !isEmpty;
        const none = $(".da-list-none", root);
        none.hidden = !isEmpty;
        if (isEmpty) {
          const p = ui.project === "all" ? null : Q.project(ui.project);
          setText(
            none,
            `Nothing scheduled${p ? ` in ${p.name}` : ""}${ui.device !== "all" ? ` on ${Q.device(ui.device)?.name ?? ""}` : ""}.`,
          );
          paintList([], o);
          paintEmpty();
          return;
        }
        empty._sig = null;
        paintList(rows, o);
        paintDetail(rows, o);
      }

      /* ---------------------------------------------------------- editor */
      const ED = { open: false };

      /* o.source: a proposal to start from ("Propose again"). */
      function openEditor(origin, r, o = {}) {
        if (ED.open) return;
        Tip.hide();
        const editing = !!r;
        const a = r?.automation ?? null;
        const p = r?.proposal ?? null;
        // The change this save would supersede, said in the editor.
        const replaces = p && p.pending ? p : null;
        const src = o.source ?? (p && p.pending && p.after && p.kind !== "cancel" ? p : (a ?? p));
        const projectId =
          r?.projectId ??
          o.source?.projectId ??
          (ui.project !== "all"
            ? ui.project
            : (rowById(ui.selected)?.projectId ?? S.projects[0].id));
        const deviceId =
          r?.deviceId ??
          o.source?.deviceId ??
          (ui.device !== "all" &&
          Q.project(projectId)?.checkouts.some((c) => c.deviceId === ui.device)
            ? ui.device
            : undefined);
        const draft = editing || o.source ? sched.draftOf(src) : sched.blank(projectId, deviceId);
        if (editing) draft.deviceId = r.deviceId;
        else if (o.source) draft.deviceId = deviceId;
        draft.execution.projectId = draft.execution.projectId ?? projectId;
        if (draft.enabled == null) draft.enabled = true;
        const memo = {
          intervalMs: draft.schedule.kind === "fixed-interval" ? draft.schedule.intervalMs : DAY,
          endsAt: draft.schedule.kind === "fixed-interval" ? draft.schedule.endsAt : null,
        };
        Object.assign(ED, {
          open: true,
          id: editing ? r.id : null,
          editingPending: !!(editing && !a),
          replaces,
          revision: a?.revision ?? null,
          origin,
          draft,
          memo,
          tried: false,
          touched: new Set(),
          startInvalid: null,
          parts: [],
        });

        const scrim = h("div", "scrim da-scrim");
        const dlg = h("div", "da-dlg surface");
        dlg.setAttribute("role", "dialog");
        dlg.setAttribute("aria-modal", "true");
        dlg.setAttribute("aria-label", editing ? `Edit ${r.title}` : "New schedule");
        dlg.innerHTML = `
          <header class="da-dlg-h">
            <div class="da-dlg-ctx"></div>
            <div class="da-limit" role="alert" tabindex="-1" hidden></div>
            <input class="da-dlg-title" type="text" maxlength="${Lab.LIMITS.titleMax}" placeholder="Name this schedule" aria-label="Schedule name" autocomplete="off" spellcheck="false">
            <div class="da-err" data-err="title" aria-live="polite"></div>
            <button type="button" class="btn ghost icon sm da-dlg-x" aria-label="Close" data-tip="Close · Esc">${ic("x")}</button>
          </header>
          <div class="da-dlg-b">
            <div class="da-form"><div class="da-form-in">
              <div class="da-fr">
                <label class="da-fl" for="da-prompt">Prompt</label>
                <div class="da-fc">
                  <textarea id="da-prompt" class="field da-prompt-in" rows="3" placeholder="What should the agent do on each run?"></textarea>
                  <div class="da-fc-foot"><div class="da-err" data-err="prompt" aria-live="polite"></div><span class="da-count tnum"></span></div>
                </div>
              </div>
              <div class="da-fr">
                <span class="da-fl" id="da-model-l">Model</span>
                <div class="da-fc">
                  <button type="button" class="da-pick da-model-btn" aria-haspopup="dialog" aria-expanded="false" aria-labelledby="da-model-l da-model-v"><span id="da-model-v" class="da-pick-v"></span>${ic("chevsUD", "da-pick-chev")}</button>
                  <div class="da-err" data-err="model" aria-live="polite"></div>
                </div>
              </div>
              <div class="da-fr">
                <span class="da-fl">Permissions</span>
                <div class="da-fc"><div class="da-mode-slot"></div><p class="da-hint da-mode-hint"></p></div>
              </div>
              <hr class="hair da-sep">
              <div class="da-fr">
                <span class="da-fl">Schedule</span>
                <div class="da-fc da-kind-slot"></div>
              </div>
              <div class="da-fr">
                <span class="da-fl da-start-l">First run</span>
                <div class="da-fc"><div class="da-start-slot"></div><div class="da-err" data-err="start" aria-live="polite"></div><div class="da-soon" hidden></div></div>
              </div>
              <div class="da-rev" data-rep>
                <div class="da-rev-in">
                  <div class="da-fr">
                    <span class="da-fl">Every</span>
                    <div class="da-fc"><div class="da-iv-slot"></div><div class="da-err" data-err="interval" aria-live="polite"></div></div>
                  </div>
                  <div class="da-fr">
                    <span class="da-fl">Ends</span>
                    <div class="da-fc"><div class="da-until-slot"></div><div class="da-err" data-err="end" aria-live="polite"></div></div>
                  </div>
                </div>
              </div>
              <hr class="hair da-sep">
              <div class="da-fr">
                <span class="da-fl">Where</span>
                <div class="da-fc">
                  <div class="da-where"><div class="da-env-slot"></div><span class="da-off"><span class="da-off-l">off</span><button type="button" class="da-pick da-ref-btn mono" aria-haspopup="dialog" aria-expanded="false" aria-label="Base branch"></button></span></div>
                  <p class="da-hint da-env-hint"></p>
                </div>
              </div>
            </div></div>
            <aside class="da-dlg-aside" aria-label="Preview">
              <span class="da-k">Reads as</span>
              <p class="da-sentence da-dlg-sent"></p>
              <header class="da-pv-h"><span class="da-pv-t"></span><span class="da-pv-n tnum"></span></header>
              <div class="da-dlg-pv"></div>
              <p class="da-dlg-note"></p>
              <div class="da-dlg-live sr-only" aria-live="polite"></div>
            </aside>
          </div>
          <footer class="da-dlg-f">
            <p class="da-dlg-fnote"></p>
            <button type="button" class="btn ghost sm" data-close>Cancel</button>
            <button type="button" class="btn primary sm da-save" data-save>Save for approval<kbd class="da-kbd">⌘↵</kbd></button>
          </footer>`;
        root.append(scrim, dlg);
        ED.dlg = dlg;
        ED.scrim = scrim;
        page.inert = true;

        const titleIn = $(".da-dlg-title", dlg);
        const promptIn = $(".da-prompt-in", dlg);
        const modelBtn = $(".da-model-btn", dlg);
        const refBtn = $(".da-ref-btn", dlg);
        const rev = $(".da-rev", dlg);
        titleIn.value = draft.execution.title;
        promptIn.value = draft.execution.prompt;

        /* context line: where this schedule lives */
        const ctx = $(".da-dlg-ctx", dlg);
        function paintCtx() {
          const pj = Q.project(draft.execution.projectId);
          const dv = Q.device(draft.deviceId);
          if (editing) {
            const what = replaces
              ? replaces.kind === "create"
                ? "Edit proposed schedule"
                : "Edit proposed change"
              : "Edit schedule";
            ctx.innerHTML = `<span>${what}</span><span class="sep">·</span><span class="da-av sm" style="--hue:${pj?.hue ?? 0}">${esc(pj?.name?.[0]?.toUpperCase() ?? "")}</span><span>${esc(pj?.name ?? "")}</span><span class="sep">·</span>${deviceIcon(draft.deviceId)}<span>${esc(dv?.name ?? "")}</span>`;
            return;
          }
          const multi = (pj?.checkouts.length ?? 0) > 1;
          ctx.innerHTML = `<span>New schedule in</span>
            <button type="button" class="da-ctx-btn" data-ctx="project" aria-haspopup="menu" aria-expanded="false"><span class="da-av sm" style="--hue:${pj?.hue ?? 0}">${esc(pj?.name?.[0]?.toUpperCase() ?? "")}</span>${esc(pj?.name ?? "")}${ic("chevD", "da-chev")}</button>
            <span>on</span>
            ${
              multi
                ? `<button type="button" class="da-ctx-btn" data-ctx="device" aria-haspopup="menu" aria-expanded="false">${deviceIcon(draft.deviceId)}${esc(dv?.name ?? "")}${ic("chevD", "da-chev")}</button>`
                : `<span class="da-ctx-static">${deviceIcon(draft.deviceId)}${esc(dv?.name ?? "")}</span>`
            }`;
        }
        ctx.addEventListener("click", (e) => {
          const b = e.target.closest("[data-ctx]");
          if (!b) return;
          const isProj = b.dataset.ctx === "project";
          const menu = h("div", "menu da-menu");
          menu.setAttribute("role", "menu");
          const pj = Q.project(draft.execution.projectId);
          const opts = isProj
            ? S.projects.map((x) => ({
                id: x.id,
                html: `<span class="da-av sm" style="--hue:${x.hue}">${esc(x.name[0].toUpperCase())}</span><span>${esc(x.name)}</span><span class="da-menu-n tnum"${Q.activeCount(x.id) >= PER_PROJECT ? " data-full" : ""}>${Q.activeCount(x.id)} of ${PER_PROJECT}${Q.activeCount(x.id) >= PER_PROJECT ? " · full" : ""}</span>`,
                on: x.id === draft.execution.projectId,
              }))
            : pj.checkouts.map((c) => ({
                id: c.deviceId,
                html: `${deviceIcon(c.deviceId)}<span>${esc(Q.device(c.deviceId)?.name ?? c.deviceId)}</span><span class="da-menu-n mono">${esc(c.path)}</span>`,
                on: c.deviceId === draft.deviceId,
              }));
          menu.innerHTML = opts
            .map(
              (o) =>
                `<button type="button" class="menu-item" role="menuitemradio" aria-checked="${o.on}" data-v="${esc(o.id)}">${o.html}${ic("check", "da-menu-check")}</button>`,
            )
            .join("");
          menuKeys(menu);
          const pop = popover(b, menu, {
            placement: "bottom-start",
            initialFocus: '[aria-checked="true"]',
          });
          menu.addEventListener("click", (ev) => {
            const it = ev.target.closest("[data-v]");
            if (!it) return;
            if (isProj) {
              if (ED.pausedForLimit) {
                draft.enabled = true;
                ED.pausedForLimit = false;
              }
              const np = Q.project(it.dataset.v);
              draft.execution.projectId = np.id;
              draft.deviceId = np.checkouts[0].deviceId;
              draft.execution.baseRef = np.refs[0] ?? "main";
            } else draft.deviceId = it.dataset.v;
            pop?.close();
            paintCtx();
            paintWhere();
            refresh();
            requestAnimationFrame(() =>
              $(`[data-ctx="${isProj ? "project" : "device"}"]`, ctx)?.focus(),
            );
          });
        });
        paintCtx();

        /* prompt: grows with its text */
        function growPrompt() {
          promptIn.style.height = "auto";
          promptIn.style.height = `${Math.min(280, Math.max(84, promptIn.scrollHeight + 2))}px`;
        }
        titleIn.addEventListener("input", () => {
          draft.execution.title = titleIn.value;
          ED.touched.add("title");
          refresh();
        });
        promptIn.addEventListener("input", () => {
          draft.execution.prompt = promptIn.value;
          ED.touched.add("prompt");
          growPrompt();
          refresh();
        });

        /* model */
        function paintModel() {
          const v = $("#da-model-v", dlg);
          const html = modelHtml(draft.execution.modelSelection);
          if (v._html !== html) {
            v.innerHTML = html;
            v._html = html;
          }
        }
        modelBtn.addEventListener("click", () => openModelPicker(modelBtn));
        function openModelPicker(btn) {
          const box = h("div", "da-mp");
          box.innerHTML = `<div class="da-mp-list" role="menu" aria-label="Model"></div><div class="da-mp-effort"><span class="da-mp-el">Effort</span><div class="da-mp-seg"></div></div>`;
          const listEl = $(".da-mp-list", box);
          const effortEl = $(".da-mp-effort", box);
          let effortSeg = null;
          function paint() {
            const sel = draft.execution.modelSelection;
            listEl.innerHTML = S.providers
              .map(
                (pv, i) =>
                  `${i ? '<div class="menu-sep"></div>' : ""}<div class="menu-label da-mp-prov">${providerMark(pv.instanceId)}<span>${esc(pv.name)}</span></div>${pv.models
                    .map(
                      (m) =>
                        `<button type="button" class="menu-item" role="menuitemradio" aria-checked="${sel.instanceId === pv.instanceId && sel.model === m.slug}" data-inst="${esc(pv.instanceId)}" data-model="${esc(m.slug)}" data-fid="m:${esc(pv.instanceId)}:${esc(m.slug)}"><span>${esc(m.name)}</span>${ic("check", "da-menu-check")}</button>`,
                    )
                    .join("")}`,
              )
              .join("");
            const prov = Q.provider(sel.instanceId);
            const eff = prov?.options?.find((x) => x.id === "effort");
            effortEl.hidden = !eff || !Q.model(sel.instanceId, sel.model);
            if (eff && !effortSeg) {
              effortSeg = segControl($(".da-mp-seg", box), {
                label: "Effort",
                value: sel.options?.find((x) => x.id === "effort")?.value ?? eff.default,
                options: eff.values.map((x) => ({ value: x.id, label: x.label })),
                onChange: (val) => {
                  const s2 = draft.execution.modelSelection;
                  s2.options = (s2.options ?? [])
                    .filter((x) => x.id !== "effort")
                    .concat([{ id: "effort", value: val }]);
                  paintModel();
                  refresh();
                },
              });
            } else if (eff && effortSeg)
              effortSeg.set(sel.options?.find((x) => x.id === "effort")?.value ?? eff.default);
          }
          paint();
          menuKeys(listEl);
          const pop = popover(btn, box, {
            placement: "bottom-start",
            width: 264,
            initialFocus: '[aria-checked="true"]',
          });
          listEl.addEventListener("click", (e) => {
            const it = e.target.closest("[data-model]");
            if (!it) return;
            const pv = Q.provider(it.dataset.inst);
            const prev = draft.execution.modelSelection;
            draft.execution.modelSelection = {
              instanceId: pv.instanceId,
              model: it.dataset.model,
              options: (pv.options ?? []).map((x) => ({
                id: x.id,
                value:
                  prev.instanceId === pv.instanceId
                    ? (prev.options?.find((y) => y.id === x.id)?.value ?? x.default)
                    : x.default,
              })),
            };
            ED.touched.add("model");
            const fid = it.dataset.fid;
            paint();
            listEl.querySelector(`[data-fid="${CSS.escape(fid)}"]`)?.focus({ preventScroll: true });
            paintModel();
            refresh();
            pop?.reposition();
          });
          void pop;
        }

        /* schedule kind + pickers */
        const kindSeg = segControl($(".da-kind-slot", dlg), {
          label: "Schedule",
          value: draft.schedule.kind,
          options: [
            { value: "once", label: "Once" },
            { value: "fixed-interval", label: "Repeats" },
          ],
          onChange: (k) => setKind(k),
        });
        ED.parts.push(kindSeg);
        const startVal = () =>
          draft.schedule.kind === "once" ? draft.schedule.runAt : draft.schedule.startsAt;
        const start = Pickers.dateTime($(".da-start-slot", dlg), {
          variant: "calendar",
          value: startVal(),
          min: S.now,
          max: S.now + HORIZON,
          label: "First run",
          now: () => S.now,
          onChange: (ms) => {
            if (draft.schedule.kind === "once") draft.schedule.runAt = ms;
            else draft.schedule.startsAt = ms;
            ED.startInvalid = null;
            ED.touched.add("start");
            until.update({ startMs: ms });
            refresh();
          },
          onInvalid: (why) => {
            ED.startInvalid = why;
            refresh();
          },
        });
        const iv = Pickers.interval($(".da-iv-slot", dlg), {
          valueMs: memo.intervalMs,
          label: "Repeat every",
          onChange: (ms) => {
            memo.intervalMs = ms;
            if (draft.schedule.kind === "fixed-interval") draft.schedule.intervalMs = ms;
            until.update({ intervalMs: ms });
            refresh();
          },
        });
        const initEnd = memo.endsAt ?? Math.min(startVal() + 30 * DAY, S.now + HORIZON);
        const until = Pickers.until($(".da-until-slot", dlg), {
          startMs: startVal(),
          valueMs: initEnd,
          nowMs: S.now,
          intervalMs: memo.intervalMs,
          label: "Ends",
          onChange: (ms) => {
            memo.endsAt = ms;
            if (draft.schedule.kind === "fixed-interval") draft.schedule.endsAt = ms;
            refresh();
          },
        });
        memo.endsAt = until.value();
        const pv = Pickers.preview($(".da-dlg-pv", dlg), {
          schedule: draft.schedule,
          nowMs: S.now,
          title: "Next runs",
        });
        ED.parts.push(start, iv, until, pv);
        ED.pickers = { start, iv, until, pv };

        function setKind(k) {
          const s = draft.schedule;
          const t = s.kind === "once" ? s.runAt : s.startsAt;
          if (k === "once") draft.schedule = { kind: "once", runAt: t };
          else {
            const end =
              memo.endsAt && memo.endsAt >= t
                ? memo.endsAt
                : Math.min(t + 30 * DAY, S.now + HORIZON);
            draft.schedule = {
              kind: "fixed-interval",
              startsAt: t,
              intervalMs: memo.intervalMs,
              endsAt: end,
            };
            until.update({ startMs: t, intervalMs: memo.intervalMs });
            if (until.value() !== end) until.set(end);
            draft.schedule.endsAt = until.value();
            memo.endsAt = until.value();
            iv.set(memo.intervalMs);
          }
          paintKind(true);
          refresh();
        }
        function paintKind(animate) {
          const once = draft.schedule.kind === "once";
          rev.toggleAttribute("data-open", !once);
          rev.inert = once;
          if (!animate || !motionOn()) {
            rev.style.transition = "none";
            void rev.offsetHeight;
            rev.style.transition = "";
          }
          setText($(".da-start-l", dlg), once ? "Runs at" : "First run");
        }
        paintKind(false);

        /* where + permissions */
        const envSeg = segControl($(".da-env-slot", dlg), {
          label: "Where each run happens",
          value: draft.execution.envMode,
          options: Lab.ENV_MODES.map((m) => ({ value: m.id, label: m.short })),
          onChange: (v) => {
            draft.execution.envMode = v;
            if (v === "worktree" && !draft.execution.baseRef)
              draft.execution.baseRef = Q.project(draft.execution.projectId)?.refs[0] ?? "main";
            paintWhere();
            refresh();
          },
        });
        ED.parts.push(envSeg);
        function paintWhere() {
          const ex = draft.execution;
          const co = Q.project(ex.projectId)?.checkouts.find((c) => c.deviceId === draft.deviceId);
          const wt = ex.envMode === "worktree";
          const off = $(".da-off", dlg);
          off.toggleAttribute("data-on", wt);
          off.inert = !wt;
          refBtn.innerHTML = `${ic("branch")}<span>${esc(ex.baseRef ?? "main")}</span>${ic("chevD", "da-chev")}`;
          $(".da-env-hint", dlg).innerHTML = wt
            ? `Each run starts from a fresh worktree off <span class="mono">${esc(ex.baseRef ?? "main")}</span>, so your checkout stays untouched.`
            : `Runs in <span class="mono">${esc(co?.path ?? "")}</span> on ${esc(Q.device(draft.deviceId)?.name ?? "")}, alongside whatever is checked out there.`;
        }
        refBtn.addEventListener("click", () => {
          const refs = Q.project(draft.execution.projectId)?.refs ?? ["main"];
          const menu = h("div", "menu da-menu");
          menu.setAttribute("role", "menu");
          menu.setAttribute("aria-label", "Base branch");
          menu.innerHTML = `<div class="menu-label">Start each worktree from</div>${refs
            .map(
              (x) =>
                `<button type="button" class="menu-item mono" role="menuitemradio" aria-checked="${x === draft.execution.baseRef}" data-ref="${esc(x)}">${ic("branch")}<span>${esc(x)}</span>${ic("check", "da-menu-check")}</button>`,
            )
            .join("")}`;
          menuKeys(menu);
          const pop = popover(refBtn, menu, {
            placement: "bottom-start",
            initialFocus: '[aria-checked="true"]',
          });
          menu.addEventListener("click", (e) => {
            const it = e.target.closest("[data-ref]");
            if (!it) return;
            draft.execution.baseRef = it.dataset.ref;
            pop?.close();
            paintWhere();
            refresh();
          });
        });
        paintWhere();

        const modeSeg = segControl($(".da-mode-slot", dlg), {
          label: "Permissions",
          value: draft.execution.runtimeMode,
          options: Lab.RUNTIME_MODES.map((m) => ({ value: m.id, label: m.label })),
          onChange: (v) => {
            draft.execution.runtimeMode = v;
            paintMode();
            refresh();
          },
        });
        ED.parts.push(modeSeg);
        function paintMode() {
          const m = Lab.RUNTIME_MODES.find((x) => x.id === draft.execution.runtimeMode);
          $(".da-mode-hint", dlg).textContent = m?.hint ?? "";
        }
        paintMode();

        /* validation + read-back */
        const errSlot = (k) => $(`[data-err="${k}"]`, dlg);
        function setErr(k, text, fix) {
          const el = errSlot(k);
          if (!el) return;
          const key = text ? `${text}|${fix?.label ?? ""}` : "";
          if (el._key === key) return;
          el._key = key;
          el.toggleAttribute("data-on", !!text);
          el.innerHTML = text
            ? `<span class="da-err-in">${ic("alert")}<span>${esc(text)}</span>${fix ? `<button type="button" class="da-fix">${esc(fix.label)}</button>` : ""}</span>`
            : "";
          if (fix) $(".da-fix", el).addEventListener("click", fix.run);
          const ctl = { title: titleIn, prompt: promptIn, model: modelBtn }[k];
          if (ctl) ctl.setAttribute("aria-invalid", text ? "true" : "false");
        }
        function validation() {
          return sched.validate(
            { ...draft, id: ED.id, projectId: draft.execution.projectId },
            S.now,
            { id: ED.id && !ED.editingPending ? ED.id : null },
          );
        }
        function refresh() {
          const v = validation();
          const show = (k) => ED.tried || ED.touched.has(k);
          setErr("title", show("title") ? v.errors.title : null);
          setErr("prompt", show("prompt") ? v.errors.prompt : null);
          // A model that went away is a fact about the schedule, not a typo: say it at once.
          const sel = draft.execution.modelSelection;
          const firstModel = (
            S.providers.find((x) => x.instanceId === sel.instanceId) ?? S.providers[0]
          ).models[0];
          setErr(
            "model",
            v.errors.model ?? null,
            v.errors.model && firstModel
              ? {
                  label: `Use ${firstModel.name}`,
                  run: () => {
                    const pv2 = S.providers.find((x) => x.models.includes(firstModel));
                    draft.execution.modelSelection = {
                      instanceId: pv2.instanceId,
                      model: firstModel.slug,
                      options: (pv2.options ?? []).map((x) => ({ id: x.id, value: x.default })),
                    };
                    paintModel();
                    refresh();
                    modelBtn.focus();
                  },
                }
              : null,
          );
          // The pickers explain their own range problems inline; only add what they don't.
          setErr("start", ED.tried && !ED.startInvalid ? v.errors.start : null);
          setErr(
            "interval",
            draft.schedule.kind === "fixed-interval" && ED.tried ? v.errors.interval : null,
          );
          setErr("end", draft.schedule.kind === "fixed-interval" && ED.tried ? v.errors.end : null);
          paintLimit(v);
          paintSoon(v);
          const save = $(".da-save", dlg);
          const blocked = !!v.errors.limit;
          save.setAttribute("aria-disabled", String(blocked));
          if (blocked) save.dataset.tip = "This project is at its limit";
          else delete save.dataset.tip;

          const count = $(".da-count", dlg);
          const n = draft.execution.prompt.length;
          setText(
            count,
            n
              ? `${n.toLocaleString("en-US")} / ${Lab.LIMITS.promptMax.toLocaleString("en-US")}`
              : "",
          );
          count.toggleAttribute("data-over", n > Lab.LIMITS.promptMax);

          // the read-back + preview: the aside is the only read-back
          const sent = $(".da-dlg-sent", dlg);
          const html = sentenceHtml(draft);
          if (sent._html !== html) {
            const firstPaint = sent._html == null;
            sent.innerHTML = html;
            sent._html = html;
            if (!firstPaint) announceReadBack(sent.textContent);
          }
          const paused = draft.enabled === false;
          setText($(".da-pv-t", dlg), paused ? "Would run if resumed" : "Next runs");
          setText($(".da-pv-n", dlg), pvCount(draft.schedule));
          pv.update(draft.schedule, S.now);
          setText(
            $(".da-dlg-note", dlg),
            `Each run waits up to 15 minutes for your approval. Runs missed while ${Q.device(draft.deviceId)?.name ?? "the device"} is off fold into one.`,
          );
          setText($(".da-dlg-fnote", dlg), footNote());
          return v;
        }
        /* Say what saving does, for this exact case. */
        function footNote() {
          const parts = [];
          if (replaces)
            parts.push(
              `Replaces the ${KIND_NOUN[replaces.kind]} proposed at ${fmt.time(replaces.createdAt)}.`,
            );
          const wantOn = draft.enabled !== false;
          if (!a)
            parts.push(
              wantOn
                ? "Nothing runs until you approve it."
                : "Nothing runs until you approve it, and then it stays paused.",
            );
          else if (a.enabled && wantOn)
            parts.push("The current schedule keeps running until you approve the change.");
          else if (a.enabled) parts.push("It keeps running until you approve; then it pauses.");
          else if (wantOn) parts.push("It stays paused until you approve; then it resumes.");
          else parts.push("It stays paused — saving doesn't resume it.");
          return parts.join(" ");
        }
        /* One polite, debounced read-back instead of a live region per field. */
        const dlgLive = $(".da-dlg-live", dlg);
        let liveTimer = 0;
        function announceReadBack(text) {
          clearTimeout(liveTimer);
          liveTimer = setTimeout(() => {
            if (!ED.open) return;
            dlgLive.textContent = text;
          }, 550);
        }
        ED.parts.push({ destroy: () => clearTimeout(liveTimer) });

        /* The 25-per-project limit: one line under the context row, with the
           two ways out — another project, or saving it paused. */
        const lim = $(".da-limit", dlg);
        function paintLimit(v) {
          const pj = Q.project(draft.execution.projectId);
          let key = "";
          let html = "";
          if (v.errors.limit) {
            key = `full|${pj?.id}`;
            html = `${ic("alert")}<span>${esc(pj?.name ?? "This project")} already has ${PER_PROJECT} active schedules, the most a project can hold.</span>${
              editing
                ? ""
                : `<button type="button" class="da-lim-btn" data-lim="switch">Switch project</button><span>or</span>`
            }<button type="button" class="da-lim-btn" data-lim="paused">${editing ? "Keep it paused" : "Save it paused"}</button>`;
          } else if (ED.pausedForLimit && draft.enabled === false) {
            key = `paused|${pj?.id}`;
            html = `${ic("pause")}<span>Saves paused. Resume it once ${esc(pj?.name ?? "the project")} has room.</span><button type="button" class="da-lim-btn" data-lim="undo">Undo</button>`;
          }
          lim.hidden = !key;
          if (lim._key !== key) {
            lim._key = key;
            lim.innerHTML = html;
            lim.dataset.kind = key.split("|")[0];
          }
        }
        lim.addEventListener("click", (e) => {
          const b = e.target.closest("[data-lim]");
          if (!b) return;
          const k = b.dataset.lim;
          if (k === "switch") $('[data-ctx="project"]', ctx)?.click();
          else if (k === "paused") {
            draft.enabled = false;
            ED.pausedForLimit = true;
            refresh();
            requestAnimationFrame(() =>
              $("[data-lim='undo']", lim)?.focus({ preventScroll: true }),
            );
          } else if (k === "undo") {
            draft.enabled = true;
            ED.pausedForLimit = false;
            refresh();
            requestAnimationFrame(() =>
              ($("[data-lim]", lim) ?? titleIn).focus({ preventScroll: true }),
            );
          }
        });

        /* A first run inside the 15-minute approval window can lapse before
           anyone approves the change: say so, and offer a safe start. */
        const soonEl = $(".da-soon", dlg);
        function safeStart() {
          const s = draft.schedule;
          const floor = S.now + TTL + MIN;
          if (s.kind === "once") return Math.ceil(floor / (15 * MIN)) * 15 * MIN;
          const k = Math.ceil((floor - s.startsAt) / s.intervalMs);
          const t = s.startsAt + Math.max(0, k) * s.intervalMs;
          return t <= s.endsAt ? t : null;
        }
        function paintSoon(v) {
          const first = sched.first(draft.schedule);
          const soon =
            Number.isFinite(first) &&
            first > S.now &&
            first < S.now + TTL &&
            !v.errors.start &&
            !ED.startInvalid;
          let key = "";
          let html = "";
          if (soon) {
            const safe = safeStart();
            const sameDay =
              safe != null && new Date(safe).toDateString() === new Date(S.now).toDateString();
            key = `${first}|${safe}`;
            html = `${ic("clock")}<span>Approve ${editing ? "the change" : "it"} before ${esc(fmt.time(first))} or it can't start.</span>${
              safe != null
                ? `<button type="button" class="da-fix" data-soon-fix="${safe}">Use ${esc(sameDay ? fmt.time(safe) : fmt.dateTime(safe))}</button>`
                : ""
            }`;
          }
          soonEl.hidden = !key;
          if (soonEl._key !== key) {
            soonEl._key = key;
            soonEl.innerHTML = html;
          }
        }
        soonEl.addEventListener("click", (e) => {
          const b = e.target.closest("[data-soon-fix]");
          if (!b) return;
          const ms = +b.dataset.soonFix;
          if (draft.schedule.kind === "once") draft.schedule.runAt = ms;
          else draft.schedule.startsAt = ms;
          ED.startInvalid = null;
          start.set(ms);
          until.update({ startMs: ms });
          refresh();
          $(".pk-trigger", dlg)?.focus({ preventScroll: true });
        });

        /* The form scrolls under a soft bottom edge while more is below. */
        const form = $(".da-form", dlg);
        const formEdges = () =>
          form.toggleAttribute(
            "data-more",
            form.scrollTop + form.clientHeight < form.scrollHeight - 2,
          );
        form.addEventListener("scroll", formEdges, { passive: true });
        const formRo = new ResizeObserver(formEdges);
        formRo.observe(form);
        formRo.observe($(".da-form-in", dlg));
        ED.parts.push({ destroy: () => formRo.disconnect() });
        paintModel();
        growPrompt();
        refresh();

        /* save: fold into the row that now shows the pending change */
        async function save() {
          ED.tried = true;
          const v = refresh();
          if (v.errors.limit) {
            // Blocked: focus the line that says why and how out of it.
            lim.focus({ preventScroll: true });
            if (motionOn()) lim.animate([{ opacity: 0.4 }, { opacity: 1 }], { duration: 240 });
            return;
          }
          if (!v.ok || ED.startInvalid) {
            const first =
              (v.errors.title && titleIn) ||
              (v.errors.prompt && promptIn) ||
              (v.errors.model && modelBtn) ||
              ((v.errors.start || ED.startInvalid) && $(".pk-trigger", dlg)) ||
              (v.errors.interval && $(".da-iv-slot [aria-checked='true']", dlg)) ||
              (v.errors.end && $(".da-until-slot [aria-checked='true']", dlg));
            first?.focus();
            first?.scrollIntoView?.({ block: "nearest" });
            return;
          }
          const p2 = act.save(
            { ...sched.clone(draft), id: ED.id },
            {
              id: ED.id ?? undefined,
              expectedRevision: ED.revision ?? undefined,
              deviceId: draft.deviceId,
              projectId: draft.execution.projectId,
            },
          );
          if (!p2) {
            api.notify("That change couldn't be proposed.", { tone: "err" });
            return;
          }
          if (ui.project !== "all" && ui.project !== p2.projectId) {
            ui.project = p2.projectId;
          }
          if (ui.device !== "all" && ui.device !== p2.deviceId) ui.device = "all";
          ui.selected = p2.automationId;
          render({ selection: true });
          const row = rowEl(p2.automationId);
          row?.scrollIntoView({ block: "nearest" });
          announce(
            `${PEND_VERB[p2.kind] ?? "Change proposed"}: ${p2.title}. Waiting for your approval.`,
          );
          await closeEditor(() => rowEl(p2.automationId) ?? null, true);
          rowEl(p2.automationId)?.querySelector(".da-row-main")?.focus({ preventScroll: true });
        }
        dlg.addEventListener("click", (e) => {
          if (e.target.closest("[data-save]")) save();
          else if (e.target.closest("[data-close], .da-dlg-x")) closeEditor();
        });
        dlg.addEventListener("keydown", (e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            save();
          } else if (e.key === "Enter" && e.target === titleIn) {
            e.preventDefault();
            promptIn.focus();
          }
        });

        ED.offLayer = Lab.layers.push({ el: dlg, close: () => closeEditor() });
        ED.release = Lab.trapFocus(dlg);
        ED.close = morph.open(dlg, origin, {
          profile: "dialog",
          scrim,
          onClosed: () => {
            dlg.remove();
            scrim.remove();
          },
        });
        // A full project needs a decision first, so focus lands on its switcher.
        const fullAtOpen = !editing && !!validation().errors.limit;
        requestAnimationFrame(() =>
          (fullAtOpen
            ? ($('[data-ctx="project"]', ctx) ?? lim)
            : editing
              ? promptIn
              : titleIn
          ).focus({ preventScroll: true }),
        );
        if (editing && !fullAtOpen) requestAnimationFrame(() => promptIn.setSelectionRange(0, 0));
      }

      async function closeEditor(target, saved = false) {
        if (!ED.open) return;
        ED.open = false;
        ED.offLayer?.();
        ED.release?.();
        page.inert = false;
        const origin = ED.origin;
        const fold = ED.close;
        const parts = ED.parts;
        const fallback = () => {
          if (origin?.isConnected) return origin;
          if (origin?.matches?.("[data-act='edit']")) return $("[data-act='edit']", detail);
          return newBtn;
        };
        const p = fold(target ?? fallback);
        if (!saved) {
          const back = fallback();
          requestAnimationFrame(() => back?.focus({ preventScroll: true }));
        }
        await p;
        for (const x of parts) x.destroy?.();
      }

      /* ---------------------------------------------------------- keys */
      function onKey(e) {
        if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
        if (Lab.layers.size || ED.open) return;
        if (isTyping(e.target)) return;
        if (!root.isConnected) return;
        const k = e.key.toLowerCase();
        if (k === "n") {
          e.preventDefault();
          openEditor(empty.hidden ? newBtn : ($("[data-new]", empty) ?? newBtn), null);
        } else if (k === "e") {
          const r = rowById(ui.selected);
          const b = $("[data-act='edit']", detail);
          if (r && b) {
            e.preventDefault();
            openEditor(b, r);
          }
        } else if (k === "j" || k === "k") {
          e.preventDefault();
          moveSelection(k === "j" ? 1 : -1);
        }
      }
      document.addEventListener("keydown", onKey);
      newBtn.addEventListener("click", () => openEditor(newBtn, null));

      /* ---------------------------------------------------------- live */
      const offEvents = Lab.onEvent((type, x) => {
        if (type === "run:new") announce(`${x.title} waits for your approval.`);
        else if (type === "run:expired") announce(`${x.title}: the approval request expired.`);
        else if (type === "proposal:decided" && x.status === "expired") {
          // A proposed schedule that expires leaves no row behind, so it
          // gets a toast with the way back; a change to an existing one
          // leaves a quiet line in its detail.
          if (x.kind === "create")
            api.notify(`“${x.title}” expired unapproved — nothing was created.`, {
              tone: "warn",
              duration: 9000,
              action: { label: "Propose again", run: () => proposeAgain(x) },
            });
          else announce(`${x.title}: your ${KIND_NOUN[x.kind] ?? "change"} expired unapproved.`);
        }
      });
      function announceThresholds() {
        for (const r of Q.dueApprovals()) {
          const left = r.expiresAt - S.now;
          const mark = left <= MIN ? 1 : left <= 5 * MIN ? 5 : 0;
          if (mark && ui.announced.get(r.id) !== mark) {
            ui.announced.set(r.id, mark);
            announce(`${r.title}: approval expires in ${mark === 1 ? "1 minute" : "5 minutes"}.`);
          }
        }
      }

      render({ selection: true, settleList: false });

      return {
        update() {
          render();
          announceThresholds();
          if (ED.open) {
            const m = Math.floor(S.now / MIN);
            if (m !== ED.minute) {
              ED.minute = m;
              ED.pickers.start.setRange(S.now, S.now + HORIZON);
              ED.pickers.until.update({ nowMs: S.now });
              ED.pickers.pv.update(ED.draft.schedule, S.now);
            }
          }
        },
        destroy() {
          document.removeEventListener("keydown", onKey);
          offEvents();
          if (ED.open) {
            ED.offLayer?.();
            ED.release?.();
            for (const x of ED.parts) x.destroy?.();
            ED.open = false;
          }
          D.pv?.destroy();
          root.remove();
        },
      };
    },
  };
})();
