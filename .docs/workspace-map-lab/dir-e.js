/* ============================================================
   E · Schedule — the time view for automations.
   x is time with a live Now line; rows are automations grouped
   under the device whose server runs them. Past runs are solid
   marks coloured by outcome, the run happening now sits on the
   Now line (amber while it waits for approval, blue while its
   thread works), upcoming runs repeat as hollow ticks until the
   schedule ends. Zooming changes the time scale, never the text.
   ============================================================ */
(() => {
  const G = 264; // label gutter
  const RH = { dev: 40, proj: 28, auto: 56, empty: 44, gap: 10 };
  const INSET = 344; // inspector width + margins
  const TICK_MIN = 11; // px between runs before they merge into a cadence band
  const TICK_DENSE = 18; // below this spacing, upcoming ticks shrink
  const SEP = 12; // px a past mark keeps from the mark to its right
  const PAD = 48; // px drawn beyond the visible window
  const PRESETS = [
    { id: "day", label: "Day", past: 6 * 60, span: 24 * 60 },
    { id: "week", label: "Week", past: 24 * 60, span: 8 * 1440 },
    { id: "month", label: "Month", past: 3 * 1440, span: 33 * 1440 },
  ];
  const SPAN_MIN = 90;
  const SPAN_MAX = 240 * 1440;
  const ACTIVE = ["pending-approval", "approved", "executing"];
  const RING_C = 2 * Math.PI * 9;

  /* ---------------------------------------------------------- time
     Sim minute 0 is Mon Oct 5, 12:00 (the "Once · Oct 9 · 10:00"
     automation is due in 3 d 22 h at t = 0). */
  const T0 = new Date(2026, 9, 5, 12, 0).getTime();
  const at = (m) => new Date(T0 + m * 60000);
  const mOf = (d) => Math.round((d.getTime() - T0) / 60000);
  const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const p2 = (n) => String(n).padStart(2, "0");
  const clock = (m) => {
    const d = at(m);
    return `${p2(d.getHours())}:${p2(d.getMinutes())}`;
  };
  const dayStart = (m) => {
    const d = at(m);
    d.setHours(0, 0, 0, 0);
    return mOf(d);
  };
  const addDays = (m, n) => {
    const d = at(m);
    d.setDate(d.getDate() + n);
    return mOf(d);
  };
  const withHour = (m, hh) => {
    const d = at(m);
    d.setHours(hh, 0, 0, 0);
    return mOf(d);
  };
  const dayShort = (m) => `${DOW[at(m).getDay()]} ${at(m).getDate()}`;
  const dayLong = (m) => `${DOW[at(m).getDay()]}, ${MON[at(m).getMonth()]} ${at(m).getDate()}`;
  const dateShort = (m) => `${MON[at(m).getMonth()]} ${at(m).getDate()}`;
  const dayDiff = (m, now) => Math.round((dayStart(m) - dayStart(now)) / 1440);
  function when(m, now) {
    const dd = dayDiff(m, now);
    const c = clock(m);
    if (dd === 0) return `Today ${c}`;
    if (dd === 1) return `Tomorrow ${c}`;
    if (dd === -1) return `Yesterday ${c}`;
    if (Math.abs(dd) < 7) return `${DOW[at(m).getDay()]} ${c}`;
    return `${dateShort(m)} · ${c}`;
  }
  const untilCache = new Map();
  function untilMin(label) {
    if (untilCache.has(label)) return untilCache.get(label);
    const [mon, day] = label.split(" ");
    const mi = MON.indexOf(mon);
    const base = at(0);
    const y = base.getFullYear() + (mi < base.getMonth() ? 1 : 0);
    const m = mOf(new Date(y, mi, Number(day), 23, 59));
    untilCache.set(label, m);
    return m;
  }
  const ago = (min) => (min < 1 ? "just now" : `${agoLabel(min)} ago`);

  /* ---------------------------------------------------------- schedule model */
  function sched(a, now) {
    const once = a.schedule.kind === "once";
    const next = a.enabled && a.nextIn != null ? now + a.nextIn : null;
    const end = once ? next : untilMin(a.schedule.until);
    return { once, next, end, every: once ? 0 : a.schedule.every };
  }
  const cadence = (a) =>
    a.schedule.kind === "once" ? "Once" : scheduleLabel(a).split(" · until")[0];
  const modeLabel = (a, c) =>
    c?.git === false
      ? "In the folder"
      : a.envMode === "worktree"
        ? "New worktree"
        : "Main checkout";
  function runsWithin(a, now, mins) {
    const s = sched(a, now);
    if (s.next == null) return 0;
    const lim = Math.min(now + mins, s.end ?? Infinity);
    if (s.next > lim) return 0;
    return s.once ? 1 : Math.floor((lim - s.next) / s.every) + 1;
  }
  const RUN_ST = {
    "pending-approval": "pending",
    approved: "running",
    executing: "running",
    completed: "done",
    failed: "failed",
    rejected: "rejected",
    expired: "rejected",
  };

  /* ---------------------------------------------------------- global lookups
     "All projects" mixes projects, so the inspector resolves ids anywhere. */
  function findAuto(id) {
    for (const p of S.projects)
      for (const c of p.checkouts)
        for (const a of c.automations ?? [])
          if (a.id === id) return { a: { ...a, device: c.device, checkoutId: c.id }, p, c };
    return null;
  }
  function findThread(id) {
    for (const p of S.projects)
      for (const c of p.checkouts)
        for (const w of c.workspaces)
          for (const th of w.threads)
            if (th.id === id)
              return {
                th: { ...th, workspaceId: w.id, device: c.device },
                w: { ...w, device: c.device },
                p,
                c,
              };
    return null;
  }
  function findWs(id) {
    for (const p of S.projects)
      for (const c of p.checkouts)
        for (const w of c.workspaces)
          if (w.id === id) return { w: { ...w, device: c.device }, p, c };
    return null;
  }
  function findCheckout(id) {
    for (const p of S.projects) for (const c of p.checkouts) if (c.id === id) return { c, p };
    return null;
  }
  const threadTitle = (id) => findThread(id)?.th.title ?? null;
  const wsName = (w) => (w.main ? (w.branch ? "the main checkout" : "the folder") : w.branch);

  /* ---------------------------------------------------------- rows
     Device groups; under "All projects" each device lists its
     projects, each with its automations. */
  function rowsModel(all) {
    const cur = project();
    const none = !all && !cur.checkouts.some((c) => c.automations?.length);
    const projects = all ? [cur, ...S.projects.filter((p) => p !== cur)] : [cur];
    const byDev = new Map();
    for (const p of projects)
      for (const c of p.checkouts) {
        if (!byDev.has(c.device)) byDev.set(c.device, []);
        byDev.get(c.device).push({ p, c });
      }
    const devIds = all
      ? Object.keys(DEVICES).filter((id) => byDev.has(id))
      : cur.checkouts.map((c) => c.device);
    const rows = [];
    const groups = [];
    let y = 0;
    for (const id of devIds) {
      const entries = byDev.get(id);
      const withAutos = entries.filter(({ c }) => c.automations?.length);
      const g = {
        id,
        key: `dev:${id}`,
        y0: y,
        entries,
        autos: withAutos.flatMap(({ p, c }) => c.automations.map((a) => ({ a, p, c }))),
      };
      rows.push({ key: g.key, kind: "dev", id, y, h: RH.dev, g });
      y += RH.dev;
      if (!withAutos.length && !none) {
        rows.push({ key: `empty:${id}`, kind: "empty", id, y, h: RH.empty, g });
        y += RH.empty;
      }
      for (const { p, c } of withAutos) {
        if (all) {
          rows.push({ key: `proj:${id}:${p.id}`, kind: "proj", id, p, c, y, h: RH.proj });
          y += RH.proj;
        }
        for (const a of c.automations) {
          rows.push({ key: `auto:${a.id}`, kind: "auto", id, a, p, c, y, h: RH.auto });
          y += RH.auto;
        }
      }
      g.y1 = y;
      groups.push(g);
      y += RH.gap;
    }
    return { rows, groups, height: y, count: rows.filter((r) => r.kind === "auto").length };
  }

  function ringSvg() {
    return `<svg class="ee-ring" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" class="track"/><circle cx="12" cy="12" r="9" class="prog" style="stroke-dasharray:${RING_C};stroke-dashoffset:${RING_C}"/><path d="M12 8v4l2.5 1.5" class="hand"/></svg>`;
  }

  /* Row markup holds only what does not change while time passes;
     countdowns, rings and marks are patched in place so they can
     transition instead of being re-rendered. */
  function rowHtml(r) {
    if (r.kind === "dev") {
      const d = DEVICES[r.id];
      return `<div class="ee-row ee-dev" style="--h:${r.h}px"><div class="ee-cell"><span class="ee-dic">${ic(d.icon)}</span><span class="ee-dname">${esc(d.name)}</span><span class="ee-conn"></span><span class="ee-sp"></span><span class="ee-load tnum"></span></div></div>`;
    }
    if (r.kind === "proj")
      return `<div class="ee-row ee-proj" style="--h:${r.h}px"><div class="ee-cell"><span class="pav" style="--hue:${r.p.hue}">${esc(r.p.name[0].toUpperCase())}</span><span class="ee-pname">${esc(r.p.name)}</span><span class="ee-ppath mono">${esc(r.c.path)}</span></div></div>`;
    if (r.kind === "empty")
      return `<div class="ee-row ee-none" style="--h:${r.h}px"><div class="ee-cell"><span class="ee-none-tx">No automations on this device</span></div><div class="ee-lane"><span class="ee-none-cta">${ic("plus")}New automation</span></div></div>`;
    const a = r.a;
    return `<div class="ee-row ee-auto" style="--h:${r.h}px"><div class="ee-cell"><div class="ee-txt"><div class="ee-l1">${ringSvg()}<span class="ee-title">${esc(a.title)}</span></div><div class="ee-sub"><span class="ee-cad">${esc(cadence(a))}<i>·</i>${esc(modeLabel(a, r.c))}</span><span class="ee-next tnum"></span></div></div></div><div class="ee-lane"><div class="ee-lane-in"></div><span class="ee-edge"></span></div></div>`;
  }

  const setText = (el, s) => {
    if (el && el.textContent !== s) el.textContent = s;
  };

  /* Minimal DOM patch: same-shaped trees keep their nodes and only take
     new text and attributes; anything that changed shape is replaced. */
  function morphInto(target, html) {
    const tpl = document.createElement("template");
    tpl.innerHTML = html;
    syncChildren(target, tpl.content);
  }
  function syncChildren(a, b) {
    const an = [...a.childNodes];
    const bn = [...b.childNodes];
    const fresh = (n) => {
      if (motion && n.nodeType === 1)
        n.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 260, easing: EASE });
      return n;
    };
    bn.forEach((y, i) => {
      const x = an[i];
      if (!x) a.append(fresh(y.cloneNode(true)));
      else if (x.nodeType !== y.nodeType || x.nodeName !== y.nodeName)
        a.replaceChild(fresh(y.cloneNode(true)), x);
      else if (x.nodeType === 3) {
        if (x.data !== y.data) x.data = y.data;
      } else if (x.nodeType === 1) {
        for (const { name } of [...x.attributes])
          if (!y.hasAttribute(name)) x.removeAttribute(name);
        for (const { name, value } of [...y.attributes])
          if (x.getAttribute(name) !== value) x.setAttribute(name, value);
        syncChildren(x, y);
      }
    });
    for (let i = an.length - 1; i >= bn.length; i--) an[i].remove();
  }

  /* ---------------------------------------------------------- inspector */
  function runRow(r, now) {
    const tid = r.threads[0];
    const title = tid ? threadTitle(tid) : null;
    return `<div class="ei-item" ${tid ? `data-select="thread:${tid}"` : ""}><span class="ei-run r-${r.status}"></span><span class="trunc">${RUN_STATUS[r.status]?.label ?? r.status}${r.detail ? ` · <span class="dim">${esc(r.detail)}</span>` : title ? ` · <span class="dim">${esc(title)}</span>` : ""}</span><span class="dim tnum">${esc(when(now - r.ago, now))}</span></div>`;
  }

  /* Each fact once: the subtitle is the cadence, "Ends" carries the
     end date, "Coming up" carries the next run, and the run happening
     now lives in its banner rather than again under recent runs. */
  function autoInsp(ref, now, all) {
    const { a, p, c } = ref;
    const s = sched(a, now);
    const d = DEVICES[a.device];
    const run = activeRun(a);
    const upcoming = [];
    if (s.next != null)
      for (let k = 0; upcoming.length < 4 && (s.once ? k < 1 : s.next + k * s.every <= s.end); k++)
        upcoming.push(s.next + k * (s.every || 0));
    const daysLeft = s.end != null ? Math.max(0, Math.round((s.end - now) / 1440)) : 0;
    const runThread = run?.threads[0] ? findThread(run.threads[0]) : null;
    const worktree = a.envMode === "worktree" && c.git !== false;
    const past = a.runs.filter((r) => r !== run);
    return `<div class="ei-kind">${ic("clock2")}Automation${a.enabled ? "" : " · paused"}</div>
      <div class="ei-title">${esc(a.title)}</div>
      <div class="ei-sub">${esc(cadence(a))}</div>
      ${run?.status === "pending-approval" ? `<div class="ei-due"><div class="ei-due-h">${ic("shield")}<span>Due ${esc(clock(now - run.ago))}. It starts a thread ${worktree ? "in a new worktree" : c.git === false ? "in the folder" : "in the main checkout"} once you approve it.</span></div><div class="ei-due-a"><button class="ei-btn primary" data-approve="${a.id}">Approve run</button><button class="ei-btn" data-reject="${a.id}">Reject</button></div></div>` : ""}
      ${run && run.status !== "pending-approval" ? `<div class="ei-live">${statusDot("working")}<span>Running since ${clock(now - run.ago)}${runThread ? ` in ${esc(wsName(runThread.w))}` : ""}</span>${runThread ? `<span class="ei-link" data-select="thread:${runThread.th.id}">Open thread</span>` : ""}</div>` : ""}
      <dl class="ei-rows">
        <dt>Runs on</dt><dd><span class="ei-link" data-select="device:${c.id}">${esc(d.name)}</span>${d.self ? ' <span class="dim">· this device</span>' : ""}</dd>
        ${all || p.id !== S.projectId ? `<dt>Project</dt><dd>${esc(p.name)}</dd>` : ""}
        <dt>Ends</dt><dd>${s.once ? "After its one run" : `${esc(dateShort(s.end))} <span class="dim">· ${daysLeft} days left</span>`}</dd>
        <dt>Where</dt><dd>${worktree ? `A new worktree off <span class="mono">${esc(a.baseRef ?? "main")}</span> each run` : `${c.git === false ? "The folder" : "The main checkout"}<div class="dim mono ei-path">${esc(c.path)}</div>`}</dd>
        <dt>Agent</dt><dd>${providerMark(a.provider)} ${PROVIDERS[a.provider]?.name ?? a.provider}</dd>
      </dl>
      <div class="ei-sec"><h4>Coming up</h4>${
        upcoming.length
          ? upcoming
              .map(
                (m, i) =>
                  `<div class="ei-item static ${i ? "" : "first"}"><span class="ei-tick ${s.once ? "once" : ""}"></span><span class="trunc">${esc(when(m, now))}</span><span class="dim tnum">${esc(inLabel(m - now))}</span></div>`,
              )
              .join("")
          : `<div class="dim ei-empty">${a.enabled ? "Nothing left: the schedule has ended." : "Paused. No runs until you resume it."}</div>`
      }</div>
      <div class="ei-sec"><h4>Recent runs</h4>
        ${past.length ? past.map((r) => runRow(r, now)).join("") : '<div class="dim ei-empty">No finished runs yet.</div>'}</div>
      <div class="ei-actions"><button class="ei-btn">${ic("play")}Run now</button><button class="ei-btn">${a.enabled ? ic("pause") + "Pause" : ic("play") + "Resume"}</button><button class="ei-btn">${ic("edit")}Edit</button></div>`;
  }

  function deviceInsp(cid, now, all) {
    const ref = findCheckout(cid);
    if (!ref) return null;
    const d = DEVICES[ref.c.device];
    const pairs = all
      ? S.projects.flatMap((p) =>
          p.checkouts.filter((c) => c.device === d.id).map((c) => ({ p, c })),
        )
      : [ref];
    const autos = pairs.flatMap(({ p, c }) => (c.automations ?? []).map((a) => ({ a, p, c })));
    const n = autos.reduce((sum, x) => sum + runsWithin(x.a, now, 1440), 0);
    const conn = d.self
      ? "This device"
      : d.conn === "online"
        ? `Online · ${esc(d.via ?? "")}`
        : d.conn === "connecting"
          ? `Connecting · ${esc(d.via ?? "")}`
          : "Offline";
    const multi = pairs.length > 1;
    /* Where runs land: the checkout's workspaces (worktree runs add one). */
    const wsItem = (p, c, w) =>
      `<div class="ei-item" data-select="ws:${w.id}">${ic(w.main ? "folder" : "branch")}<span class="trunc ${w.main ? "" : "mono"}">${esc(w.main ? (c.git === false ? "Folder" : "Main checkout") : w.branch)}</span>${originMark(p, w)}${w.checkoutRemoved ? '<span class="dim">removed</span>' : w.archived ? '<span class="dim">archived</span>' : ""}</div>`;
    return `<div class="ei-kind">${ic(d.icon)}Device</div>
      <div class="ei-title">${esc(d.name)}</div><div class="ei-sub">${esc(d.os)}</div>
      <dl class="ei-rows">
        <dt>Connection</dt><dd>${conn}</dd>
        ${pairs.map(({ p, c }) => `<dt>${multi ? esc(p.name) : "Checkout"}</dt><dd class="mono">${esc(c.path)}</dd>`).join("")}
        <dt>Next 24 h</dt><dd>${n ? `${n} run${n === 1 ? "" : "s"}` : "Nothing scheduled"}</dd>
      </dl>
      <div class="ei-sec"><h4>Automations on this device</h4>
        ${autos.length ? autos.map(({ a, p }) => `<div class="ei-item" data-select="auto:${a.id}">${ic("clock2")}<span class="trunc">${esc(a.title)}${multi ? ` <span class="dim">· ${esc(p.name)}</span>` : ""}</span><span class="dim tnum">${a.enabled ? esc(inLabel(a.nextIn)) : "Paused"}</span></div>`).join("") : '<div class="dim ei-empty">None yet. Automations run on this device’s server, so they keep their schedule while you are away.</div>'}</div>
      ${pairs.map(({ p, c }) => `<div class="ei-sec"><h4>${multi ? `${esc(p.name)} · workspaces` : "Workspaces"}</h4>${c.workspaces.map((w) => wsItem(p, c, w)).join("")}</div>`).join("")}
      <div class="ei-actions"><button class="ei-btn primary">${ic("plus")}New automation</button>${autos.some((x) => x.a.enabled) ? `<button class="ei-btn">${ic("pause")}Pause all</button>` : ""}</div>`;
  }

  function threadInsp(id, now) {
    const ref = findThread(id);
    if (!ref) return null;
    const { th, w } = ref;
    const by = th.by ? findAuto(th.by) : null;
    const run = by?.a.runs.find((r) => r.threads.includes(th.id));
    return `<div class="ei-kind">${statusDot(th.status)}Thread · ${STATUS[th.status].label}</div>
      <div class="ei-title">${esc(th.title)}</div>
      <dl class="ei-rows">
        <dt>Agent</dt><dd>${providerMark(th.provider)} ${PROVIDERS[th.provider]?.name ?? th.provider}</dd>
        <dt>Workspace</dt><dd><span class="ei-link ${w.main ? "" : "mono"}" data-select="ws:${w.id}">${esc(w.main ? "Main checkout" : w.branch)}</span></dd>
        <dt>Device</dt><dd>${esc(DEVICES[th.device].name)}</dd>
        <dt>Activity</dt><dd>${esc(ago(th.ago))}</dd>
        ${by ? `<dt>Started by</dt><dd><span class="ei-link" data-select="auto:${by.a.id}">${esc(by.a.title)}</span>${run ? ` <span class="dim">· run at ${esc(when(now - run.ago, now))}</span>` : ""}</dd>` : ""}
      </dl>
      <div class="ei-actions"><button class="ei-btn primary">${ic("open")}Open thread</button></div>`;
  }

  function wsInsp(id) {
    const ref = findWs(id);
    if (!ref) return null;
    const { w, p } = ref;
    const d = DEVICES[w.device];
    const pr = w.origin?.kind === "pr" ? p.prs[w.origin.ref] : null;
    const ix = index(p);
    const twins = w.main ? [] : (ix.byBranch[w.branch] ?? []).filter((x) => x.id !== w.id);
    return `<div class="ei-kind">${ic(w.main ? "folder" : "branch")}${w.main ? "Main checkout" : "Worktree"}</div>
      <div class="ei-title ${w.main ? "" : "mono"}">${esc(w.main ? (w.branch ?? "Folder") : w.branch)}</div>
      <div class="ei-sub">${factsHtml(w) || "Clean and up to date"}</div>
      <dl class="ei-rows">
        <dt>Device</dt><dd>${esc(d.name)}</dd>
        <dt>Path</dt><dd class="mono">${esc(w.path)}</dd>
        ${pr ? `<dt>From</dt><dd>${originMark(p, w)} ${esc(pr.title)} · <span class="dim">${pr.state}, checks ${pr.checks}</span></dd>` : w.origin ? `<dt>From</dt><dd>${originMark(p, w)}</dd>` : ""}
        ${twins.length ? `<dt>Also on</dt><dd>${twins.map((x) => `<span class="ei-link" data-select="ws:${x.id}">${esc(DEVICES[x.device].name)}</span>`).join(", ")}</dd>` : ""}
      </dl>
      <div class="ei-sec"><h4>Threads</h4>
        ${w.threads.length ? w.threads.map((th) => `<div class="ei-item" data-select="thread:${th.id}">${statusDot(th.status)}<span class="trunc">${esc(th.title)}</span><span class="dim tnum">${agoLabel(th.ago)}</span></div>`).join("") : '<div class="dim ei-empty">No threads yet.</div>'}</div>
      <div class="ei-actions">
        ${w.checkoutRemoved ? `<button class="ei-btn">${ic("folderMinus")}Recreate checkout…</button>` : `<button class="ei-btn primary">${ic("plus")}New thread</button>`}
        ${w.main ? "" : w.archived ? `<button class="ei-btn">${ic("archive")}Restore</button>` : `<button class="ei-btn">${ic("archive")}Archive</button>`}
        ${w.main || w.checkoutRemoved ? "" : `<button class="ei-btn danger">${ic("folderMinus")}Remove checkout…</button>`}
      </div>`;
  }

  function projectInsp(id, now) {
    const p = S.projects.find((x) => x.id === id);
    if (!p) return null;
    const autos = p.checkouts.flatMap((c) => (c.automations ?? []).map((a) => ({ a, c })));
    return `<div class="ei-kind">${ic("folder")}Project</div>
      <div class="ei-title">${esc(p.name)}</div><div class="ei-sub mono">${esc(p.repo ?? "Local folder")}</div>
      <div class="ei-sec"><h4>Automations</h4>
        ${autos.map(({ a, c }) => `<div class="ei-item" data-select="auto:${a.id}">${ic("clock2")}<span class="trunc">${esc(a.title)} <span class="dim">· ${esc(DEVICES[c.device].name)}</span></span><span class="dim tnum">${a.enabled ? esc(inLabel(a.nextIn)) : "Paused"}</span></div>`).join("") || '<div class="dim ei-empty">No automations.</div>'}</div>
      <div class="ei-actions"><button class="ei-btn primary">${ic("plus")}New automation</button></div>`;
  }

  /* ---------------------------------------------------------- actions
     Approving a due run starts its thread now: in the main checkout,
     or in a fresh worktree off baseRef. Rejecting closes the run. */
  function approve(aid) {
    for (const p of S.projects)
      for (const c of p.checkouts)
        for (const a of c.automations ?? []) {
          const run = a.id === aid && activeRun(a);
          if (!run || run.status !== "pending-approval") continue;
          let ws = c.workspaces.find((w) => w.main);
          if (a.envMode === "worktree" && c.git !== false) {
            const slug = a.title
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, "-")
              .slice(0, 24);
            ws = c.workspaces.find((w) => w.id === `w-${run.id}`);
            if (!ws) {
              ws = {
                id: `w-${run.id}`,
                branch: `auto/${slug}-${run.id}`,
                path: `~/.ryco/worktrees/${p.name}/${slug}-${run.id}`,
                fresh: true,
                threads: [],
              };
              c.workspaces.push(ws);
            }
          }
          /* The scripted triage run keeps the thread id the loop gives it at
             0:09, so approving early does not leave a second thread behind. */
          const id = run.id === "r6" ? "t18" : `t-${run.id}`;
          const thread = t(
            id,
            run.id === "r6" ? "Triage: 2 new issues" : `${a.title}: run ${a.runs.length}`,
            "working",
            a.provider,
            0,
            a.id,
          );
          run.status = "executing";
          run.threads = [thread.id];
          if (ws && !ws.threads.some((x) => x.id === thread.id)) ws.threads.unshift(thread);
          lastEvent = `Run approved: ${a.title}`;
        }
    emit();
  }
  function reject(aid) {
    for (const p of S.projects)
      for (const c of p.checkouts)
        for (const a of c.automations ?? []) {
          const run = a.id === aid && activeRun(a);
          if (!run || run.status !== "pending-approval") continue;
          run.status = "rejected";
          /* The loop's script approves and completes run r6 by id; renaming
             the rejected run keeps it rejected (data.js does not check). */
          run.id = `${run.id}-rejected`;
          lastEvent = `Run rejected: ${a.title}`;
        }
    emit();
  }

  /* ---------------------------------------------------------- mount */
  function mount(host, apiRef) {
    const root = h("div", "ee");
    root.style.setProperty("--g", `${G}px`);
    root.innerHTML = `
      <div class="ee-grid"><div class="ee-past"></div><div class="ee-glines"></div><div class="ee-nowline"></div></div>
      <div class="ee-axis"><div class="ee-alabels"></div><div class="ee-nowpill tnum"></div></div>
      <div class="ee-axisline"></div>
      <div class="ee-gutline"></div>
      <div class="ee-corner"><div class="seg ee-scope" role="radiogroup" aria-label="Automations of">
        <button type="button" class="seg-opt" role="radio" data-scope="project">This project</button>
        <button type="button" class="seg-opt" role="radio" data-scope="all">All projects</button>
      </div></div>
      <div class="ee-body"><div class="ee-rows"></div><div class="ee-empty"></div></div>`;
    host.append(root);
    const q = (s) => root.querySelector(s);
    const glines = q(".ee-glines");
    const alabels = q(".ee-alabels");
    const nowPill = q(".ee-nowpill");
    const body = q(".ee-body");
    const rowsLayer = q(".ee-rows");
    const emptyEl = q(".ee-empty");
    const scopeEl = q(".ee-scope");

    const insp = createInspector(host, { onClose: () => apiRef.select(null) });
    const zoomUi = h(
      "div",
      "vp-ui vp-zoom ee-zoom",
      `<button type="button" data-z="out" data-tip="Zoom out (⌘-scroll)">${ic("minus")}</button>
       <div class="ee-presets">${PRESETS.map((p) => `<button type="button" class="ee-preset" data-preset="${p.id}">${p.label}</button>`).join("")}</div>
       <button type="button" data-z="in" data-tip="Zoom in (⌘-scroll)">${ic("plus")}</button>
       <span class="vp-div"></span>
       <button type="button" data-z="fit" data-tip="Back to now (double-click)">${ic("fit")}</button>`,
    );
    const legend = h(
      "div",
      "vp-ui ee-legend",
      `<span><i class="ee-lg done"></i>Completed</span><span><i class="ee-lg failed"></i>Failed</span><span><i class="ee-lg rejected"></i>Rejected</span><span class="ee-lg-sep"></span><span><i class="ee-lg next"></i>Upcoming</span><span data-tip="Runs too close together to draw apart. Zoom in to separate them."><i class="ee-lg band"></i>Frequent</span><span><i class="ee-lg once"></i>Once</span>`,
    );
    host.append(zoomUi, legend);

    const st = {
      all: false,
      projectId: null,
      scroll: 0,
      model: null,
      inspOpen: false,
      first: true,
      preset: "week",
    };
    const view = { v0: -24 * 60, ppm: 0.05, W: 0 };
    let raf = 0;
    let tw = 0;

    const visW = () => Math.max(120, view.W - (st.inspOpen ? INSET : 0));
    const xOf = (m) => (m - view.v0) * view.ppm;

    /* ---------------- time scale: two CSS variables move every mark */
    function setView(v0, ppm, sync) {
      const w = visW();
      ppm = clamp(ppm, w / SPAN_MAX, w / SPAN_MIN);
      view.v0 = v0;
      view.ppm = ppm;
      root.style.setProperty("--v0", v0.toFixed(3));
      root.style.setProperty("--ppm", ppm.toPrecision(7));
      root.style.setProperty("--v1", (v0 + view.W / ppm).toFixed(3));
      if (sync) paintView();
      else if (!raf)
        raf = requestAnimationFrame(() => {
          raf = 0;
          paintView();
        });
    }
    const easeOut = (x) => 1 - Math.pow(1 - x, 4);
    /* Glide to a new scale: the anchor time slides linearly on screen
       while the scale changes geometrically, so Day ↔ Month feels even. */
    function animateTo(v0t, ppmt, dur = 720, anchor = S.simT) {
      cancelAnimationFrame(tw);
      if (!motion) {
        setView(v0t, ppmt, true);
        return;
      }
      const x0 = (anchor - view.v0) * view.ppm;
      const x1 = (anchor - v0t) * ppmt;
      const l0 = Math.log(view.ppm);
      const l1 = Math.log(ppmt);
      const s0 = performance.now();
      const step = (ts) => {
        const k = easeOut(Math.min(1, (ts - s0) / dur));
        const ppm = Math.exp(l0 + (l1 - l0) * k);
        setView(anchor - (x0 + (x1 - x0) * k) / ppm, ppm, true);
        if (k < 1) tw = requestAnimationFrame(step);
      };
      tw = requestAnimationFrame(step);
    }
    function fit(animate, presetId = st.preset ?? "week") {
      const pr = PRESETS.find((x) => x.id === presetId);
      st.restore = st.revealed = null;
      st.preset = presetId;
      const ppm = visW() / pr.span;
      const v0 = S.simT - pr.past;
      if (animate) animateTo(v0, ppm);
      else setView(v0, ppm, true);
      paintPresets();
      setScroll(0, animate);
    }
    function zoomBy(f, anchorX) {
      const w = visW();
      const ax = anchorX ?? (xOf(S.simT) > 0 && xOf(S.simT) < w ? xOf(S.simT) : w / 2);
      const anchor = view.v0 + ax / view.ppm;
      const ppm = clamp(view.ppm * f, w / SPAN_MAX, w / SPAN_MIN);
      st.preset = null;
      paintPresets();
      animateTo(anchor - ax / ppm, ppm, 380, anchor);
    }
    function paintPresets() {
      for (const b of zoomUi.querySelectorAll("[data-preset]"))
        b.setAttribute("aria-pressed", String(b.dataset.preset === st.preset));
    }

    /* ---------------- vertical scroll + sticky device headers */
    const maxScroll = () => Math.max(0, (st.model?.height ?? 0) + 76 - body.clientHeight);
    function setScroll(v, animate) {
      const next = clamp(v, 0, maxScroll());
      if (animate && motion && Math.abs(next - st.scroll) > 2)
        rowsLayer.animate([{ translate: `0 ${-st.scroll}px` }, { translate: `0 ${-next}px` }], {
          duration: 420,
          easing: EASE,
        });
      st.scroll = next;
      rowsLayer.style.translate = `0 ${-next}px`;
      applySticky();
    }
    function applySticky() {
      const store = rowsLayer._nodes;
      if (!store || !st.model) return;
      for (const g of st.model.groups) {
        const rec = store.get(g.key);
        if (!rec) continue;
        const off = clamp(st.scroll - g.y0 - 6, 0, Math.max(0, g.y1 - g.y0 - RH.dev));
        rec.el.firstElementChild.style.translate = off ? `0 ${off}px` : "";
        rec.el.classList.toggle("stuck", off > 0);
      }
    }

    /* ---------------- axis + grid (regenerated per view change) */
    function axisModel() {
      const v0 = view.v0;
      const v1 = view.v0 + view.W / view.ppm;
      const ppd = view.ppm * 1440;
      const labels = [];
      const lines = [];
      const today = dayStart(S.simT);
      if (ppd >= 44) {
        const stepH = [1, 2, 3, 4, 6, 12].find((s) => s * 60 * view.ppm >= 54);
        for (let d = dayStart(v0); d <= v1; d = addDays(d, 1)) {
          labels.push({
            key: `d${d}`,
            tier: 1,
            t: d,
            end: addDays(d, 1),
            text: ppd >= 300 ? dayLong(d) : dayShort(d),
            today: d === today,
          });
          lines.push({ key: `l${d}`, t: d, major: true });
          if (stepH)
            for (let hh = stepH; hh < 24; hh += stepH) {
              const tm = withHour(d, hh);
              labels.push({ key: `h${tm}`, tier: 2, t: tm, text: `${p2(hh)}:00` });
              if (stepH * 60 * view.ppm >= 40) lines.push({ key: `l${tm}`, t: tm, major: false });
            }
        }
      } else {
        let d = dayStart(v0);
        while (at(d).getDay() !== 1) d = addDays(d, -1);
        for (; d <= v1; d = addDays(d, 1)) {
          if (at(d).getDay() === 1) {
            labels.push({
              key: `w${d}`,
              tier: 1,
              t: d,
              end: addDays(d, 7),
              text: `${dateShort(d)}`,
              today: today >= d && today < addDays(d, 7),
            });
            lines.push({ key: `l${d}`, t: d, major: true });
          } else if (ppd >= 24) lines.push({ key: `l${d}`, t: d, major: false });
        }
      }
      return { labels, lines };
    }
    function paintAxis() {
      const { labels, lines } = axisModel();
      const W = view.W;
      /* grid lines */
      const gstore = (glines._m ??= new Map());
      const gseen = new Set();
      for (const l of lines) {
        const x = xOf(l.t);
        if (x < -2 || x > W + 2) continue;
        gseen.add(l.key);
        let el = gstore.get(l.key);
        if (!el) {
          el = h("i", `ee-gl ${l.major ? "major" : ""}`);
          glines.append(el);
          gstore.set(l.key, el);
          if (motion && !st.first) el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 260 });
        }
        el.style.translate = `${Math.round(x)}px 0`;
      }
      for (const [k, el] of gstore) if (!gseen.has(k)) (el.remove(), gstore.delete(k));
      /* labels: tier 1 sticks to the left edge while its span is visible */
      const lstore = (alabels._m ??= new Map());
      const lseen = new Set();
      const xNow = xOf(S.simT);
      const vw = visW();
      for (const l of labels) {
        const x = xOf(l.t);
        const xEnd = l.end != null ? xOf(l.end) : x;
        if (l.tier === 1 ? xEnd < 0 || x > W : x < -40 || x > W + 40) continue;
        lseen.add(l.key);
        let el = lstore.get(l.key);
        if (!el) {
          el = h("span", `ee-al t${l.tier}`, esc(l.text));
          alabels.append(el);
          lstore.set(l.key, el);
          el._w = el.offsetWidth;
          if (motion && !st.first) el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 260 });
        }
        if (el.textContent !== l.text) {
          el.textContent = l.text;
          el._w = el.offsetWidth;
        }
        el.classList.toggle("today", !!l.today);
        if (l.tier === 1) {
          const px = Math.min(Math.max(x + 8, 8), xEnd - el._w - 8);
          el.style.translate = `${Math.round(px)}px 0`;
          el.classList.toggle("hide", px < 2 || px + el._w > vw - 4);
        } else {
          el.style.translate = `${Math.round(x)}px 0`;
          el.classList.toggle("hide", Math.abs(x - xNow) < 44 || x < 22 || x > vw - 22);
        }
      }
      for (const [k, el] of lstore) if (!lseen.has(k)) (el.remove(), lstore.delete(k));
      setText(nowPill, clock(S.simT));
    }

    /* ---------------- lanes */
    function laneItems(r, now, sel) {
      const a = r.a;
      const s = sched(a, now);
      const vs = view.v0;
      const ve = view.v0 + view.W / view.ppm;
      const pad = PAD / view.ppm;
      const out = [];
      if (s.end != null && s.end > now)
        out.push({
          key: "rail",
          type: "rail",
          cls: a.enabled ? (s.once ? "once" : "") : "paused",
          vars: { "--r1": s.end },
        });
      const spacing = s.every * view.ppm;
      if (a.enabled && s.next != null && !s.once) {
        if (spacing >= TICK_MIN) {
          const k0 = Math.max(1, Math.ceil((vs - pad - s.next) / s.every));
          const lim = Math.min(ve + pad, s.end);
          for (let k = k0, n = 0; s.next + k * s.every <= lim && n < 240; k++, n++) {
            const T = s.next + k * s.every;
            out.push({
              key: `o:${T}`,
              type: "mk",
              st: "tick",
              t: T,
              tip: `${when(T, now)} · ${inLabel(T - now)}`,
            });
          }
        } else if (s.next + s.every <= s.end) {
          const perDay = Math.round(1440 / s.every);
          out.push({
            key: "band",
            type: "band",
            cls: spacing < 2.6 ? "solid" : "",
            vars: { "--b0": s.next + s.every, "--r1": s.end, "--ev": s.every },
            tip: `${cadence(a)} · ${perDay} runs a day until ${dateShort(s.end)} · zoom in to see each run`,
          });
        }
      }
      if (!s.once && s.end >= vs - pad && s.end <= ve + pad)
        out.push({
          key: "cap",
          type: "cap",
          t: s.end,
          text: `ends ${dateShort(s.end)}`,
          cls: `${a.enabled ? "" : "paused"} ${(s.end - vs) * view.ppm > visW() - 76 ? "flip" : ""}`,
        });
      if (s.next != null && s.next >= vs - pad && s.next <= ve + pad)
        out.push({
          key: `o:${s.next}`,
          type: "mk",
          st: s.once ? "once" : "next",
          t: s.next,
          tx: s.once ? `${dayShort(s.next)} · ${clock(s.next)}` : "",
          tip: `${s.once ? "Runs once" : "Next run"} · ${when(s.next, now)} · ${inLabel(s.next - now)}`,
        });
      for (const run of a.runs) {
        const T = now - run.ago;
        const state = RUN_ST[run.status] ?? "done";
        const active = state === "pending" || state === "running";
        if (!active && (T < vs - pad || T > ve + pad)) continue;
        const tid = run.threads[0];
        const tref = tid ? findThread(tid) : null;
        const where = tref ? (tref.w.main ? " in the main checkout" : ` in ${tref.w.branch}`) : "";
        const named = tref && tref.th.title !== a.title ? `“${tref.th.title}”` : "a thread";
        const tip =
          state === "pending"
            ? `Due ${when(T, now)} · waiting for your approval`
            : state === "running"
              ? `Running since ${clock(T)}${where}`
              : `${RUN_STATUS[run.status]?.label ?? run.status} · ${when(T, now)}${run.detail ? ` · ${run.detail}` : ""}${tref ? ` · started ${named}${where}` : state === "rejected" ? " · no thread started" : ""}`;
        out.push({
          key: `o:${T}`,
          type: "mk",
          st: state,
          t: T,
          tip,
          /* A running pill names the thread it started. */
          label:
            state === "pending"
              ? "Approve"
              : state === "running"
                ? run.status === "approved"
                  ? "Starting…"
                  : (tref?.th.title ?? "Running")
                : null,
          tx: "",
          approve: state === "pending" ? a.id : null,
          thread: tref ? tid : null,
          sel: sel?.kind === "thread" && run.threads.includes(sel.id),
        });
      }
      return { items: out, s, dense: !s.once && spacing < TICK_DENSE };
    }

    function makeMark(it) {
      if (it.type === "mk")
        return h(
          "span",
          "ee-mk",
          `<i class="ee-dot"><i></i></i><span class="ee-pill"><b></b></span><span class="ee-tx"></span>`,
        );
      if (it.type === "cap") return h("span", "ee-cap", "<span></span>");
      return h("span", `ee-${it.type}`);
    }
    function patchMark(rec, it) {
      rec.t = it.t;
      rec.type = it.type;
      const sig = `${it.cls}|${it.st}|${it.t}|${it.tip}|${it.label}|${it.tx}|${it.text}|${it.approve}|${it.thread}|${it.sel}|${JSON.stringify(it.vars ?? "")}`;
      if (rec.sig === sig) return;
      rec.sig = sig;
      const el = rec.el;
      if (it.type === "mk") {
        el.dataset.st = it.st;
        el.style.setProperty("--tt", it.t);
        el.dataset.tip = it.tip;
        el.classList.toggle("is-sel", !!it.sel);
        if (it.thread) el.dataset.thread = it.thread;
        else delete el.dataset.thread;
        if (it.approve) {
          el.dataset.approve = it.approve;
          el.setAttribute("role", "button");
        } else {
          delete el.dataset.approve;
          el.removeAttribute("role");
        }
        /* Keep the old pill text while the pill folds away. */
        if (it.label) setText(el.querySelector(".ee-pill b"), it.label);
        setText(el.querySelector(".ee-tx"), it.tx ?? "");
        return;
      }
      el.className = `ee-${it.type} ${it.cls ?? ""}`;
      for (const [k, v] of Object.entries(it.vars ?? {})) el.style.setProperty(k, v);
      if (it.type === "cap") {
        el.style.setProperty("--tt", it.t);
        setText(el.firstChild, it.text);
      }
      if (it.tip) el.dataset.tip = it.tip;
    }
    /* State changes morph in place: hollow → amber → running → solid. */
    function morph(el, from, to, w0) {
      const dot = el.querySelector(".ee-dot > i");
      if (to === "pending" || (to === "running" && from !== "pending"))
        dot.animate([{ scale: "1" }, { scale: "1.7" }, { scale: "1" }], {
          duration: 560,
          easing: GENTLE,
        });
      if (from === "pending" && to === "running") {
        /* Approved: the amber fill wipes off to the right, uncovering the
           running pill underneath (no amber→blue blend through brown),
           while the pill stretches to fit the thread's name. */
        el.style.transition = "none";
        const w1 = el.offsetWidth;
        el.style.transition = "";
        el.animate(
          [{ clipPath: "inset(0 0 0 0 round 11px)" }, { clipPath: "inset(0 0 0 100% round 11px)" }],
          { duration: 560, easing: EASE, pseudoElement: "::before" },
        );
        if (w0 && w0 !== w1)
          el.animate([{ width: `${w0}px` }, { width: `${w1}px` }], { duration: 520, easing: EASE });
        el.querySelector(".ee-pill b").animate(
          [
            { opacity: 0, translate: "6px 0" },
            { opacity: 1, translate: "0 0" },
          ],
          { duration: 420, delay: 140, easing: EASE, fill: "backwards" },
        );
        dot.animate([{ scale: "1" }, { scale: "1.5" }, { scale: "1" }], {
          duration: 520,
          easing: GENTLE,
        });
      }
      if (from === "running" && to !== "running") {
        el.animate([{ minWidth: `${el.offsetWidth}px` }, { minWidth: "22px" }], {
          duration: 640,
          easing: EASE,
        });
        dot.animate([{ scale: "1" }, { scale: "1.6" }, { scale: "1" }], {
          duration: 560,
          delay: 300,
          easing: GENTLE,
        });
      }
      if (from === "pending" && to === "rejected")
        el.animate([{ minWidth: `${el.offsetWidth}px` }, { minWidth: "22px" }], {
          duration: 520,
          easing: EASE,
        });
    }
    function syncMarks(lane, items, o) {
      const fresh = !lane._m;
      const store = (lane._m ??= new Map());
      const seen = new Set();
      const now = S.simT;
      items.forEach((it) => {
        seen.add(it.key);
        let rec = store.get(it.key);
        if (!rec) {
          const el = makeMark(it);
          lane.append(el);
          rec = { el, st: it.st, sig: "" };
          store.set(it.key, rec);
          patchMark(rec, it);
          if (!motion) return;
          if (o.animate === "fade")
            el.animate([{ opacity: 0 }, { opacity: 1 }], {
              duration: 320,
              delay: 120,
              easing: "ease-out",
              fill: "backwards",
            });
          else if (fresh && o.animate) {
            /* The schedule unfolds out of the Now line. */
            if (it.type === "rail" || it.type === "band")
              el.animate(
                [
                  { scale: "0 1", opacity: 0 },
                  { scale: "1 1", opacity: 1 },
                ],
                { duration: 900, delay: o.delay + 120, easing: EASE, fill: "backwards" },
              );
            else {
              const dist = Math.abs((it.t - now) * view.ppm);
              el.animate(
                [
                  { opacity: 0, scale: "0.2" },
                  { opacity: 1, scale: "1" },
                ],
                {
                  duration: 440,
                  delay: o.delay + 180 + Math.min(620, dist * 0.9),
                  easing: SNAPPY,
                  fill: "backwards",
                },
              );
            }
          } else if (o.animate)
            el.animate(
              [
                { opacity: 0, scale: "0.3" },
                { opacity: 1, scale: "1" },
              ],
              { duration: 420, easing: SNAPPY },
            );
          else el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 180 });
          return;
        }
        const prev = rec.st;
        const changing = prev !== it.st && motion && o.animate === true;
        const w0 = changing ? rec.el.offsetWidth : 0;
        patchMark(rec, it);
        if (changing) morph(rec.el, prev, it.st, w0);
        rec.st = it.st;
      });
      for (const [k, rec] of store) {
        if (seen.has(k)) continue;
        store.delete(k);
        if (!motion || !o.animate) {
          rec.el.remove();
          continue;
        }
        rec.el.style.pointerEvents = "none";
        rec.el
          .animate(
            o.animate === "fade"
              ? [{ opacity: 1 }, { opacity: 0 }]
              : [{ opacity: 1 }, { opacity: 0, scale: "0.6" }],
            { duration: 220, easing: "ease-in", fill: "forwards" },
          )
          .finished.then(() => rec.el.remove())
          .catch(() => rec.el.remove());
      }
    }
    /* At coarse scales a finished run can land on the next run or on the
       pill of the run happening now (a 30-min schedule at Week is 1.5 px
       apart). Finished runs give way to the left, keeping their order and
       SEP px apart; zoom in and they settle back on their exact minute. */
    const FIXED = new Set(["tick", "next", "once", "pending", "running"]);
    function dodge(lane) {
      const store = lane._m;
      if (!store) return;
      let edge = Infinity;
      const past = [];
      for (const rec of store.values()) {
        if (rec.type !== "mk") continue;
        /* Pills reach 11 px left of their minute; dots and rings ~5 px. */
        if (FIXED.has(rec.st))
          edge = Math.min(
            edge,
            xOf(rec.t) - (rec.st === "pending" || rec.st === "running" ? 6 : 0),
          );
        else past.push(rec);
      }
      past.sort((a, b) => b.t - a.t);
      for (const rec of past) {
        const x = xOf(rec.t);
        const nx = Math.min(x, edge - SEP);
        const dx = Math.round((nx - x) * 4) / 4;
        if (rec.dx !== dx) {
          rec.dx = dx;
          rec.el.style.setProperty("--dx", `${dx}px`);
        }
        edge = nx;
      }
    }
    function paintLanes(animate, delays) {
      const store = rowsLayer._nodes;
      if (!store || !st.model) return;
      const now = S.simT;
      const sel = S.selected;
      const v1v = view.v0 + visW() / view.ppm;
      for (const r of st.model.rows) {
        if (r.kind !== "auto") continue;
        const rec = store.get(r.key);
        if (!rec) continue;
        const lane = rec.el.querySelector(".ee-lane-in");
        const { items, s, dense } = laneItems(r, now, sel);
        syncMarks(lane, items, { animate, delay: delays?.get(r.key) ?? 0 });
        dodge(lane);
        if (lane._dense !== dense) {
          lane._dense = dense;
          lane.classList.toggle("dense", dense);
        }
        /* Where the schedule goes past the right edge, say so there. */
        const edge = st.inspOpen
          ? ""
          : s.next != null && s.next > v1v
            ? `next ${when(s.next, now)} →`
            : !s.once && s.end > v1v && (s.next == null || s.next < v1v)
              ? `until ${dateShort(s.end)} →`
              : "";
        const laneEl = lane.parentElement;
        laneEl.classList.toggle("has-edge", !!edge);
        if (edge) setText(laneEl.querySelector(".ee-edge"), edge);
      }
    }

    function paintView() {
      paintAxis();
      paintLanes(false);
    }

    /* ---------------- rows */
    function rowCls(r, sel) {
      const c = [`k-${r.kind}`];
      if (r.kind === "auto") {
        if (!r.a.enabled) c.push("paused");
        if (activeRun(r.a)?.status === "pending-approval") c.push("due");
        if (sel?.kind === "auto" && sel.id === r.a.id) c.push("is-sel");
        if (sel?.kind === "thread" && r.a.runs.some((x) => x.threads.includes(sel.id)))
          c.push("is-sel");
      }
      if (
        (r.kind === "dev" || r.kind === "empty") &&
        sel?.kind === "device" &&
        findCheckout(sel.id)?.c.device === r.id
      )
        c.push("is-sel");
      if (r.kind === "proj" && sel?.kind === "project" && sel.id === r.p.id) c.push("is-sel");
      return c.join(" ");
    }
    function patchRow(el, r, now) {
      if (r.kind === "dev") {
        const d = DEVICES[r.id];
        const conn = el.querySelector(".ee-conn");
        const key = d.self ? "self" : d.conn;
        if (conn._k !== key) {
          conn._k = key;
          conn.className = `ee-conn c-${key}`;
          conn.innerHTML = d.self
            ? "This device"
            : `<i></i>${d.conn === "online" ? "Online" : d.conn === "connecting" ? "Connecting" : "Offline"}`;
          conn.dataset.tip = d.self
            ? "Automations here run on this Mac"
            : `${d.conn === "online" ? "Online" : d.conn === "connecting" ? "Connecting" : "Offline"} · ${d.via ?? ""}`;
        }
        const n = r.g.autos.reduce((sum, x) => sum + runsWithin(x.a, now, 1440), 0);
        const load = el.querySelector(".ee-load");
        const html = n ? `${n} in 24 h` : r.g.autos.length ? "None in 24 h" : "";
        if (load._h !== html) {
          load._h = html;
          load.innerHTML = html;
          load.dataset.tip = n
            ? `${n} run${n === 1 ? "" : "s"} scheduled on ${d.name} in the next 24 hours`
            : "";
        }
        return;
      }
      if (r.kind !== "auto") return;
      const a = r.a;
      const prog = el.querySelector(".ee-ring .prog");
      const run = activeRun(a);
      /* A run waiting for approval holds the ring full (in amber): the
         countdown reached zero and the next step is yours. */
      const done = run?.status === "pending-approval" ? 1 : a.enabled ? cycle(a) : 0;
      const off = (RING_C * (1 - clamp(done, 0, 1))).toFixed(2);
      if (prog.style.strokeDashoffset !== `${off}px` && prog.style.strokeDashoffset !== off)
        prog.style.strokeDashoffset = off;
      const next = el.querySelector(".ee-next");
      setText(next, a.enabled ? inLabel(a.nextIn) : "Paused");
      next.dataset.tip =
        a.enabled && a.nextIn != null
          ? `Next run ${when(S.simT + a.nextIn, now)}`
          : "Paused: no runs until you resume it";
      el.querySelector(".ee-ring").dataset.tip =
        run?.status === "pending-approval"
          ? "A run is waiting for approval"
          : a.enabled
            ? "Fills as the next run approaches"
            : "Paused";
    }

    function render() {
      const sel = S.selected;
      const now = S.simT;
      const projectChanged = st.projectId !== S.projectId;
      st.projectId = S.projectId;
      if (projectChanged && !st.first) st.enterBase = 150;
      const model = rowsModel(st.all);
      st.model = model;
      root.style.setProperty("--ee-now", now);
      for (const b of scopeEl.querySelectorAll("[data-scope]"))
        b.setAttribute("aria-checked", String((b.dataset.scope === "all") === st.all));

      const delays = new Map();
      let fresh = 0;
      const items = model.rows.map((r) => ({
        key: r.key,
        x: 0,
        y: r.y,
        html: rowHtml(r),
        cls: rowCls(r, sel),
        data: r,
      }));
      const store = syncNodes(rowsLayer, items, {
        enter: (el, item) => {
          /* Incoming rows wait for outgoing ones (project switch) or for
             neighbours to glide aside (scope change) before they arrive. */
          const delay = (st.first ? 60 : (st.enterBase ?? 40)) + fresh++ * 34;
          delays.set(item.key, delay);
          el.animate(
            [
              { opacity: 0, translate: "0 -6px" },
              { opacity: 1, translate: "0 0" },
            ],
            { duration: 440, delay, easing: EASE, fill: "backwards" },
          );
        },
        exit: (el) =>
          el.animate([{ opacity: 1 }, { opacity: 0, translate: "0 -4px" }], {
            duration: 150,
            easing: "ease-in",
            fill: "forwards",
          }),
      });
      st.enterBase = null;
      for (const r of model.rows) {
        const rec = store.get(r.key);
        if (rec) patchRow(rec.el, r, now);
      }
      /* The lab's loop swaps in fresh data (every run "moves"); a quiet
         crossfade suits that better than every mark springing in again. */
      const reset = st.data && st.data !== S.projects;
      st.data = S.projects;
      paintLanes(reset ? "fade" : true, delays);
      applySticky();

      /* Empty project: say what an automation is and offer the next step. */
      if (!model.count && !st.all) {
        const p = project();
        const html = `<div class="ee-empty-in"><div class="ee-empty-h">Nothing scheduled in ${esc(p.name)}</div>
          <p>An automation runs an agent on a schedule, on one device. Every run waits for your approval before it starts a thread${p.repo ? ", in the main checkout or a fresh worktree" : " in the folder"}.</p>
          <div class="ee-empty-a"><button type="button" class="ei-btn primary">${ic("plus")}New automation</button><button type="button" class="ei-btn" data-scope-all="1">See all projects</button></div></div>`;
        /* Only on change: rewriting it every tick would replay its entrance. */
        if (emptyEl._h !== html) {
          emptyEl._h = html;
          emptyEl.innerHTML = html;
        }
        emptyEl.style.top = `${model.height + 40}px`;
        emptyEl.classList.add("on");
      } else emptyEl.classList.remove("on");
      /* Nothing on the track, nothing for the legend to explain. */
      legend.classList.toggle("off", !model.count);

      /* Inspector + the lanes making room for it */
      const html = sel ? inspectorHtml(sel, now) : null;
      const ikey = sel ? `${sel.kind}:${sel.id}` : null;
      if (!html) {
        insp.hide();
        st.inspHtml = null;
      } else if (insp.key === ikey && insp.panel.classList.contains("open")) {
        /* Same subject, new numbers: patch text in place so countdowns
           tick without restarting the pulses or losing hover. */
        if (st.inspHtml !== html) morphInto(insp.body, html);
        st.inspHtml = html;
      } else {
        insp.show(ikey, html);
        st.inspHtml = html;
      }
      const open = !!html;
      if (open !== st.inspOpen) {
        st.inspOpen = open;
        root.style.setProperty("--r", open ? `${INSET}px` : "0px");
        paintLanes(false);
      }
      if (projectChanged && !st.first) fit(true);
      else if (ikey !== st.selKey) followSelection(sel);
      st.selKey = ikey;
      paintAxis();
      st.first = false;
    }

    /* The inspector leaves ~2 days of track at Week. Selecting an
       automation whose next run is out of view glides the scale until it
       is in; closing the inspector glides back, unless you moved the view
       yourself in the meantime. */
    function followSelection(sel) {
      if (sel?.kind === "auto") {
        const ref = findAuto(sel.id);
        const s = ref && sched(ref.a, S.simT);
        if (!s || s.next == null) return;
        const w = visW();
        const room = (s.once ? 110 : 40) / view.ppm; // the diamond carries its date
        if (s.next >= view.v0 && s.next + room <= view.v0 + w / view.ppm) return;
        const v0 = Math.min(view.v0, S.simT - 60);
        const ppm = clamp((w - (s.once ? 120 : 48)) / (s.next - v0), w / SPAN_MAX, view.ppm);
        if (!st.restore) st.restore = { v0: view.v0, ppm: view.ppm, preset: st.preset };
        st.preset = null;
        paintPresets();
        st.revealed = { v0, ppm };
        animateTo(v0, ppm, 640, S.simT);
        return;
      }
      if (!sel && st.restore) {
        const r = st.restore;
        const moved =
          !st.revealed ||
          Math.abs(view.v0 - st.revealed.v0) > 1 ||
          Math.abs(view.ppm / st.revealed.ppm - 1) > 0.01;
        st.restore = st.revealed = null;
        if (moved) return;
        st.preset = r.preset;
        paintPresets();
        animateTo(r.v0, r.ppm, 640, S.simT);
      }
    }

    function inspectorHtml(sel, now) {
      if (sel.kind === "auto") {
        const ref = findAuto(sel.id);
        return ref ? autoInsp(ref, now, st.all) : null;
      }
      if (sel.kind === "device") return deviceInsp(sel.id, now, st.all);
      if (sel.kind === "thread") return threadInsp(sel.id, now);
      if (sel.kind === "ws") return wsInsp(sel.id);
      if (sel.kind === "project") return projectInsp(sel.id, now);
      return null;
    }

    /* ---------------- input */
    function selectRow(node, toggle = true) {
      const r = node._data;
      if (!r) return;
      let sel = null;
      if (r.kind === "auto") sel = { kind: "auto", id: r.a.id };
      else if (r.kind === "dev" || r.kind === "empty") {
        const c = r.g.entries.find((x) => x.p.id === S.projectId)?.c ?? r.g.entries[0].c;
        sel = { kind: "device", id: c.id };
      } else if (r.kind === "proj") sel = { kind: "project", id: r.p.id };
      if (!sel) return;
      const same = S.selected && S.selected.kind === sel.kind && S.selected.id === sel.id;
      if (same && !toggle) return;
      apiRef.select(sel);
    }
    function onClick(target) {
      const ap = target.closest("[data-approve]");
      if (ap) return approve(ap.dataset.approve);
      /* A run mark opens the thread that run started. */
      const tm = target.closest(".ee-mk[data-thread]");
      if (tm) {
        const id = tm.dataset.thread;
        if (!(S.selected?.kind === "thread" && S.selected.id === id))
          apiRef.select({ kind: "thread", id });
        return;
      }
      const node = target.closest(".ee-rows > .node");
      if (node) return selectRow(node, !target.closest(".ee-mk"));
      if (S.selected) apiRef.select(null);
    }
    let drag = null;
    root.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || e.target.closest(".ee-corner, .ee-empty-in")) return;
      const r = root.getBoundingClientRect();
      drag = {
        x: e.clientX,
        y: e.clientY,
        v0: view.v0,
        sy: st.scroll,
        moved: false,
        target: e.target,
        gutter: e.clientX - r.left < G,
      };
      root.setPointerCapture(e.pointerId);
    });
    root.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
      if (!drag.moved) {
        drag.moved = true;
        root.classList.add("is-panning");
        cancelAnimationFrame(tw);
        Tip.hide();
      }
      if (!drag.gutter && dx) setView(drag.v0 - dx / view.ppm, view.ppm);
      if (maxScroll() > 0) setScroll(drag.sy - dy);
    });
    const endDrag = () => {
      const d = drag;
      drag = null;
      root.classList.remove("is-panning");
      if (d && !d.moved) onClick(d.target);
    };
    root.addEventListener("pointerup", endDrag);
    root.addEventListener("pointercancel", () => {
      drag = null;
      root.classList.remove("is-panning");
    });
    root.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const r = root.getBoundingClientRect();
        if (e.ctrlKey || e.metaKey) {
          cancelAnimationFrame(tw);
          const px = e.clientX - r.left - G;
          const xNow = xOf(S.simT);
          /* Over the labels, zoom around Now; over the track, around the pointer. */
          const ax = px < 0 && xNow >= 0 && xNow <= visW() ? xNow : clamp(px, 0, visW());
          const anchor = view.v0 + ax / view.ppm;
          const w = visW();
          const ppm = clamp(view.ppm * Math.exp(-e.deltaY * 0.0045), w / SPAN_MAX, w / SPAN_MIN);
          st.preset = null;
          paintPresets();
          setView(anchor - ax / ppm, ppm);
          return;
        }
        let dx = e.deltaX;
        let dy = e.deltaY;
        if (e.shiftKey && !dx) [dx, dy] = [dy, 0];
        if (maxScroll() <= 0 && Math.abs(dy) > Math.abs(dx)) [dx, dy] = [dy, 0];
        if (dx) {
          cancelAnimationFrame(tw);
          setView(view.v0 + dx / view.ppm, view.ppm);
        }
        if (dy) setScroll(st.scroll + dy);
      },
      { passive: false },
    );
    root.addEventListener("dblclick", (e) => {
      if (e.target.closest(".ee-corner, .ee-mk, .ee-cell")) return;
      fit(true);
    });
    scopeEl.addEventListener("click", (e) => {
      const b = e.target.closest("[data-scope]");
      if (!b) return;
      setScope(b.dataset.scope === "all");
    });
    emptyEl.addEventListener("click", (e) => {
      if (e.target.closest("[data-scope-all]")) setScope(true);
    });
    function setScope(all) {
      if (st.all === all) return;
      st.all = all;
      st.enterBase = 220;
      render();
      setScroll(st.scroll, true);
    }
    zoomUi.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      if (b.dataset.preset) fit(true, b.dataset.preset);
      else if (b.dataset.z === "in") zoomBy(1.6);
      else if (b.dataset.z === "out") zoomBy(1 / 1.6);
      else fit(true);
    });
    insp.panel.addEventListener("click", (e) => {
      const ap = e.target.closest("[data-approve]");
      if (ap) return approve(ap.dataset.approve);
      const rj = e.target.closest("[data-reject]");
      if (rj) return reject(rj.dataset.reject);
      const link = e.target.closest("[data-select]");
      if (!link) return;
      const [kind, id] = link.dataset.select.split(":");
      if (!(S.selected?.kind === kind && S.selected?.id === id)) apiRef.select({ kind, id });
    });

    const ro = new ResizeObserver(() => {
      const W = Math.max(0, root.clientWidth - G);
      const firstSize = !view.W && W;
      view.W = W;
      if (firstSize) fit(false);
      else if (W && st.preset && !st.restore) {
        /* A preset names a span ("Week"), so it keeps that span on resize. */
        const pr = PRESETS.find((x) => x.id === st.preset);
        setView(S.simT - pr.past, visW() / pr.span, true);
      } else if (W) setView(view.v0, view.ppm, true);
      setScroll(st.scroll);
    });
    ro.observe(root);
    view.W = Math.max(0, root.clientWidth - G);
    if (view.W) fit(false);

    return {
      update() {
        render();
      },
      destroy() {
        ro.disconnect();
        cancelAnimationFrame(raf);
        cancelAnimationFrame(tw);
      },
    };
  }

  DIRS.E = {
    title: "E · Schedule",
    thesis:
      "A schedule you read like a calendar: <b>time runs left to right</b>, a live <b>Now</b> line splits what happened from what will, and every automation is a row under the device whose server runs it. Solid marks are past runs coloured by outcome; hollow ticks are the runs still to come, repeating at their interval until the schedule ends. The one run happening now sits on the Now line: amber while it waits for your approval, blue while its thread works.",
    notes: [
      [
        "Reading it",
        [
          "<b>Rows are automations, grouped by device.</b> The device header says whether it is reachable and how many runs it has in the next 24 hours, which is its load at a glance.",
          "The row label carries a ring that fills as the next run approaches (held full in amber while a run waits for you), the cadence, where each run starts (the main checkout or a new worktree) and the countdown.",
          "<b>Marks:</b> green completed, red failed, struck-through rejected; hollow ticks are upcoming runs and a diamond runs once. Runs too close together to draw apart merge into a textured <b>Frequent</b> band; zoom in and it splits into ticks. At coarse scales a finished run that would sit on the next one steps a few pixels left, so nothing hides behind anything.",
          "The rail ends where the schedule ends: it fades into a cap with the date, or says “until Oct 31 →” at the edge when the end is further out. Paused automations keep a dashed rail and say Paused instead of a countdown.",
        ],
      ],
      [
        "Moving around",
        [
          "Drag or scroll sideways to move through time; ⌘-scroll or pinch zooms the time scale, never the text. <b>Day / Week / Month</b> glide between scales; double-click comes back to now.",
          "<b>All projects</b> lists every project’s automations under each device, so a busy device is obvious. Rows glide to their new places.",
          "Hover a mark for its time, outcome and the thread it started; click it to open that thread. Click a row for the inspector: what is coming up, recent runs, the workspaces runs land in.",
          "The lanes make room for the inspector instead of hiding under it. If the selected automation’s next run falls outside the narrower track, the scale glides out until it shows, and glides back when you close the inspector (unless you moved the view yourself).",
        ],
      ],
      [
        "Live",
        [
          "The Now line glides one minute per second and countdown rings fill.",
          "At 0:07 “Triage new issues” comes due: its hollow tick unfolds into an amber <b>Approve</b> pill on the Now line. Approve it (on the pill or in the inspector, or wait until 0:09) and the amber wipes away to a blue pill named after the thread it started, growing with Now while it runs (zoom to Day to watch); at 0:15 it folds into a solid green mark while the next tick counts down. Reject it and it stays a struck-through mark.",
          "At 0:05 hub-eu-1 finishes connecting; its header recolours in place.",
        ],
      ],
    ],
    mount,
  };
})();
