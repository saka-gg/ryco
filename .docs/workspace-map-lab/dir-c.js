/* ============================================================
   C · Branches — a transit map of the repository.
   main is the trunk line. Every branch leaves it as its own
   coloured line (colour = identity) and runs to STATIONS: one
   per device that has it checked out. Columns are devices, so
   "what" reads down a line and "where" reads across columns.
   Schedules are clocks above main in their device's column:
   local runs merge into main, worktree runs drop through it
   and the line their run created leaves from that point.
   ============================================================ */
(() => {
  /* ---------------------------------------------------------- metrics (world px) */
  const COL_W = 284; // one device column
  const GUT = 24; // gap between columns (merged lines rejoin here)
  const PITCH = COL_W + GUT;
  const SLOT = 9; // spacing of parallel forks in a fan
  const R = 12; // corner radius of every bend
  const PAD_L = 16; // leftmost fork inside a column
  const PILL_H = 26;
  const LABEL_H = 18;
  const FACT_H = 17;
  const TH_H = 24;
  const TH_GAP = 3;
  const ROW_GAP = 30;
  const CLK_H = 36;
  const A0 = 50; // first schedule row above main
  const A_P = 46; // schedule row pitch
  const MAIN_X0 = -46; // where main starts (project bullet)
  const HEAD_H = 40; // pinned device header (screen px)
  const FOOT_H = 48; // toolbar row (screen px)
  const N_COLORS = 8;
  const LIVE = ["pending-approval", "approved", "executing"];
  const PREFIX = { project: "pj", device: "dv", ws: "w", auto: "a", thread: "t" };

  /* ---------------------------------------------------------- small vocab */
  const shortEvery = (a) => {
    if (a.schedule.kind === "once") return `once · ${a.schedule.at}`;
    const m = a.schedule.every;
    if (m % 10080 === 0) return m === 10080 ? "weekly" : `every ${m / 10080} wk`;
    if (m % 1440 === 0) return m === 1440 ? "daily" : `every ${m / 1440} d`;
    if (m % 60 === 0) return m === 60 ? "hourly" : `every ${m / 60} h`;
    return `every ${m} min`;
  };
  const clockState = (a) => {
    const run = activeRun(a);
    if (!a.enabled) return "paused";
    if (run?.status === "pending-approval") return "due";
    if (run) return "running";
    return "idle";
  };
  /* Facts a station must say, stated once and short. */
  function factsOf(w) {
    const out = [];
    if (w.checkoutRemoved)
      out.push({
        t: "Checkout removed",
        tone: "muted",
        tip: "The folder is gone; the record and threads are kept",
      });
    else if (w.missing)
      out.push({
        t: "Checkout missing",
        tone: "warn",
        tip: "The folder is not on this device any more",
      });
    if (w.changes && !w.checkoutRemoved) {
      const n = (w.changes.modified ?? 0) + (w.changes.untracked ?? 0);
      const tip = [
        w.changes.modified ? `${w.changes.modified} modified` : "",
        w.changes.untracked ? `${w.changes.untracked} untracked` : "",
      ]
        .filter(Boolean)
        .join(", ");
      if (n) out.push({ t: `${n} uncommitted`, tone: "warn", tip });
    }
    if (w.unmerged)
      out.push({ t: "unmerged", tone: "warn", tip: "Commits that are not on main yet" });
    if (w.behind)
      out.push({
        t: `${w.behind} behind`,
        tone: "muted",
        tip: `${w.behind} commits behind origin/${w.branch}`,
      });
    return out;
  }
  /* Threads hang open by default (a departure board under each station);
     the toolbar folds them all, a station's count folds just that one. */
  const shownThreads = (st, w) =>
    st.showArchived ? w.threads : w.threads.filter((x) => x.status !== "archived");
  const isOpen = (st, w) =>
    shownThreads(st, w).length > 0 && st.threadsOpen !== st.toggled.has(w.id);
  const connLabel = (d) =>
    d.self
      ? "This device"
      : d.conn === "online"
        ? "Online"
        : d.conn === "connecting"
          ? "Connecting"
          : "Offline";

  /* ---------------------------------------------------------- model
     Lines (branches) get rows. A line on one device takes the next row
     in its column; a line that spans columns runs below every column it
     crosses, so forks never cross another line. Forks in a column nest:
     the deeper the row, the further left it leaves main. */
  function colorFor(st, pid, branch) {
    const key = `${pid}\u0000${branch}`;
    if (!st.colors.has(key)) {
      const used = new Set();
      for (const [k, v] of st.colors) if (k.startsWith(`${pid}\u0000`)) used.add(v);
      let i = 0;
      while (used.has(i) && i < N_COLORS) i++;
      st.colors.set(key, i % N_COLORS);
    }
    return st.colors.get(key);
  }

  function build(ix, st) {
    const p = ix.p;
    const git = ix.devices.some((d) => d.checkout.git !== false);
    const cols = ix.devices.map((d, i) => ({
      d,
      i,
      x: i * PITCH,
      cid: d.checkout.id,
      main: ix.workspaces.find((w) => w.checkoutId === d.checkout.id && w.main) ?? null,
      autos: st.showAutos ? ix.automations.filter((a) => a.checkoutId === d.checkout.id) : [],
    }));
    const colOf = new Map(cols.map((c) => [c.cid, c]));
    const autoById = new Map(ix.automations.map((a) => [a.id, a]));

    const lmap = new Map();
    for (const w of ix.workspaces) {
      if (w.main || !w.branch) continue;
      if (w.archived && !st.showArchived) continue;
      if (!lmap.has(w.branch)) lmap.set(w.branch, { branch: w.branch, ws: [], order: lmap.size });
      lmap.get(w.branch).ws.push(w);
    }
    const lines = [...lmap.values()];
    for (const L of lines) {
      L.ws.sort((a, b) => colOf.get(a.checkoutId).i - colOf.get(b.checkoutId).i);
      L.start = colOf.get(L.ws[0].checkoutId).i;
      L.end = colOf.get(L.ws.at(-1).checkoutId).i;
      L.originWs = L.ws.find((w) => w.origin) ?? null;
      L.pr = L.originWs?.origin.kind === "pr" ? p.prs[L.originWs.origin.ref] : null;
      L.merged = L.pr?.state === "merged";
      L.archived = L.ws.every((w) => w.archived);
      L.byAuto = null;
      for (const w of L.ws)
        for (const th of w.threads) {
          const a = th.by ? autoById.get(th.by) : null;
          if (a && st.showAutos && a.envMode === "worktree" && a.checkoutId === w.checkoutId)
            L.byAuto = a.id;
        }
      L.color = colorFor(st, p.id, L.branch);
    }

    /* rows */
    const depth = cols.map(() => 0);
    for (const c of cols) {
      lines
        .filter((L) => L.start === c.i && L.end === c.i)
        .sort(
          (a, b) =>
            Number(!!b.byAuto) - Number(!!a.byAuto) ||
            Number(a.archived) - Number(b.archived) ||
            a.order - b.order,
        )
        .forEach((L, j) => (L.row = j + 1));
      depth[c.i] = lines.filter((L) => L.start === c.i && L.end === c.i).length;
    }
    for (const L of lines
      .filter((x) => x.start !== x.end)
      .sort((a, b) => b.start - a.start || a.end - b.end || a.order - b.order)) {
      let r = 0;
      for (let i = L.start; i <= L.end; i++) r = Math.max(r, depth[i]);
      L.row = r + 1;
      for (let i = L.start; i <= L.end; i++) depth[i] = L.row;
    }
    const maxRow = Math.max(0, ...depth);

    /* fork slots: shallow lines nearest the station, schedules further left
       (a worktree schedule shares the slot of the line its run created) */
    for (const c of cols) {
      const starting = lines.filter((L) => L.start === c.i).sort((a, b) => a.row - b.row);
      starting.forEach((L, j) => (L.slot = j));
      let n = starting.length;
      for (const a of c.autos) {
        const paired = starting.find((L) => L.byAuto === a.id) ?? null;
        a.slot = paired ? paired.slot : n++;
        a.paired = paired;
        a.col = c;
      }
      c.slots = n;
      [...c.autos].sort((x, y) => x.slot - y.slot).forEach((a, r) => (a.rank = r + 1));
    }
    const maxSlots = Math.max(1, ...cols.map((c) => c.slots));
    const FAN_R = PAD_L + (maxSlots - 1) * SLOT;
    const STX = FAN_R + R + 14;
    const MW = COL_W - STX - 4;
    /* A line label may run to its zone edge, unless a merged line climbs
       back to main in that gutter. */
    const LW = COL_W + 4 - STX;
    const lwFor = (i) =>
      lines.some((L) => L.merged && L.end === i) ? LW : COL_W + GUT / 2 - 1 - STX;
    const TW = COL_W - STX - 22; // thread rows stop clear of a merged line's climb
    const sx = (c, j) => c.x + FAN_R - j * SLOT;

    const nAbove = Math.max(0, ...cols.map((c) => c.autos.length));
    const mainY = nAbove
      ? A0 + (nAbove - 1) * A_P + CLK_H / 2
      : git
        ? PILL_H / 2
        : LABEL_H + 3 + PILL_H / 2;
    for (const c of cols) for (const a of c.autos) a.y = mainY - A0 - (a.rank - 1) * A_P;

    const extra = (w) =>
      (factsOf(w).length ? FACT_H : 0) +
      (isOpen(st, w) ? 8 + shownThreads(st, w).length * (TH_H + TH_GAP) - TH_GAP : 0);
    let bottom = mainY + PILL_H / 2 + Math.max(0, ...cols.map((c) => (c.main ? extra(c.main) : 0)));
    const rowY = [];
    for (let r = 1; r <= maxRow; r++) {
      const y = bottom + ROW_GAP + LABEL_H + 3 + PILL_H / 2;
      rowY[r] = y;
      bottom =
        y +
        PILL_H / 2 +
        Math.max(0, ...lines.filter((L) => L.row === r).flatMap((L) => L.ws.map(extra)));
    }
    const last = cols.at(-1);
    /* main runs on past the last column only as far as a merged line needs */
    const mainEnd =
      last.x + COL_W + (lines.some((L) => L.merged && L.end === last.i) ? GUT + 22 : 10);
    return {
      p,
      ix,
      git,
      cols,
      colOf,
      lines,
      autoById,
      rowY,
      mainY,
      STX,
      MW,
      LW,
      lwFor,
      TW,
      sx,
      mainEnd,
      bottom,
    };
  }

  /* ---------------------------------------------------------- paths */
  function linePath(L, M) {
    const c0 = M.cols[L.start];
    const x = M.sx(c0, L.slot);
    const y = M.rowY[L.row];
    const my = M.mainY;
    const ce = M.cols[L.end];
    /* A worktree a schedule created drops straight through main;
       every other branch leaves main on a smooth bend. */
    let d = L.byAuto
      ? `M ${x} ${my} L ${x} ${my + R} L ${x} ${y - R} Q ${x} ${y} ${x + R} ${y}`
      : `M ${x - R} ${my} Q ${x} ${my} ${x} ${my + R} L ${x} ${y - R} Q ${x} ${y} ${x + R} ${y}`;
    if (L.merged) {
      const gx = ce.x + COL_W + 14;
      d += ` L ${gx - R} ${y} Q ${gx} ${y} ${gx} ${y - R} L ${gx} ${my + R} Q ${gx} ${my} ${gx + R} ${my}`;
    } else d += ` L ${ce.x + M.STX + 14} ${y}`;
    return d;
  }
  function spurPath(a, M) {
    const x = M.sx(a.col, a.slot);
    const my = M.mainY;
    const cx = a.col.x + M.STX;
    return `M ${x} ${my} L ${x} ${a.y + R} Q ${x} ${a.y} ${x + R} ${a.y} L ${cx} ${a.y}`;
  }

  /* ---------------------------------------------------------- markup */
  function ringSvg() {
    const r = 9;
    const c = 2 * Math.PI * r;
    return `<svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="${r}" class="track"/>
      <circle cx="12" cy="12" r="${r}" class="prog" style="stroke-dasharray:${c.toFixed(2)};stroke-dashoffset:${c.toFixed(2)}"/>
      <path d="M12 8v4l2.6 1.6" class="hand"/></svg>`;
  }

  function clockHtml(a, M) {
    const s = clockState(a);
    const last = a.runs.find((r) => !LIVE.includes(r.status));
    const failed = (s === "idle" || s === "paused") && last?.status === "failed";
    const target =
      a.envMode === "worktree"
        ? `Each run opens a new worktree off ${a.baseRef ?? "main"}`
        : "Each run starts a thread in the main checkout";
    const sub =
      s === "due"
        ? `<button type="button" class="cs-approve" data-approve="${a.id}">Approve run</button><span class="cs-due">due now</span>`
        : s === "running"
          ? `<span class="cs-running"><span class="sdot s-working"></span>Running</span><span class="cs-sep">·</span><span>${esc(shortEvery(a))}</span>`
          : s === "paused"
            ? `<span>Paused</span><span class="cs-sep">·</span><span>${esc(shortEvery(a))}</span>`
            : `<span class="cs-next tnum"></span><span class="cs-sep">·</span><span>${esc(shortEvery(a))}</span>`;
    return `<div class="cs-clk s-${s}" data-sel="auto:${a.id}" data-focus="auto:${a.id}" style="--mw:${M.MW}px">
      <span class="cs-ring" data-tip="${esc(target)}">${ringSvg()}${failed ? `<i class="cs-fail" data-tip="Last run failed${last.detail ? `: ${esc(last.detail)}` : ""}"></i>` : ""}</span>
      <span class="cs-ctext"><span class="cs-ctitle">${esc(a.title)}</span><span class="cs-csub">${sub}</span></span>
    </div>`;
  }

  /* The pill selects the station; only the chevron folds its threads. Open and
     folded share one markup (the node's `is-open` class picks count or dots),
     so folding morphs the chevron in place instead of re-rendering the pill. */
  function stationHtml(w, c, M, st, focus) {
    const d = c.d;
    const name = w.main ? (w.branch ? "Main checkout" : "Folder") : w.branch;
    const th = shownThreads(st, w);
    const dots = th
      .slice(0, 6)
      .map((x) => `<span class="sdot" data-th="${x.id}"></span>`)
      .join("");
    const more = th.length > 6 ? `<span class="cs-more tnum">+${th.length - 6}</span>` : "";
    const tally = th.length
      ? `<span class="cs-count tnum">${th.length}</span><span class="cs-dots">${dots}${more}</span><button type="button" class="cs-fold" data-expand="${w.id}">${ic("chevR")}</button>`
      : "";
    const facts = factsOf(w);
    return `<div class="cs-st" data-sel="ws:${w.id}" data-focus="${focus}">
      <span class="cs-pill" data-tip="${esc(name)} · ${esc(d.name)}"><span class="cs-dev">${ic(d.icon)}</span>${tally}</span>
      ${facts.length ? `<span class="cs-facts" style="max-width:${M.MW}px">${facts.map((f) => `<span class="cs-fact f-${f.tone}" ${f.tip ? `data-tip="${esc(f.tip)}"` : ""}>${esc(f.t)}</span>`).join("")}</span>` : ""}
    </div>`;
  }

  function labelHtml(L, M, focus) {
    const p = M.p;
    const pr = L.pr ? ` · ${L.pr.state === "merged" ? "merged" : L.pr.state}` : "";
    return `<div class="cs-lbl ${L.archived ? "is-arch" : ""}" data-sel="ws:${L.ws[0].id}" data-focus="${focus}" style="max-width:${M.lwFor(L.start)}px">
      <span class="cs-bname" data-tip="${esc(L.branch)}${esc(pr)}${L.archived ? " · archived" : ""}">${esc(L.branch)}</span>${L.originWs ? originMark(p, L.originWs) : ""}
    </div>`;
  }

  function threadHtml(th, focus, M) {
    return `<div class="cs-th" data-sel="thread:${th.id}" data-focus="${focus}" style="width:${M.TW}px">
      <span class="sdot" data-th="${th.id}"></span><span class="cs-ttl" data-tip="${esc(th.title)} · ${esc(PROVIDERS[th.provider]?.name ?? th.provider)}">${esc(th.title)}</span>${th.by ? `<span class="cs-by" data-tip="Started by a schedule">${ic("clock2")}</span>` : ""}<span class="cs-ago tnum">${agoLabel(th.ago)}</span>
    </div>`;
  }

  /* ---------------------------------------------------------- inspector */
  /* When a schedule fires next, or what its current run is doing. */
  function nextHtml(a) {
    const s = clockState(a);
    if (s === "due") return '<span class="ci-next is-due">Waiting for approval</span>';
    if (s === "running") return '<span class="ci-next is-running">Running</span>';
    if (s === "paused") return '<span class="ci-next">Paused</span>';
    return `<span class="ci-next tnum">${esc(inLabel(a.nextIn))}</span>`;
  }
  /* A device's stations top to bottom, as the map shows them. */
  function stationsInMapOrder(d, M) {
    const row = (w) => (w.main ? 0 : (M.lines.find((L) => L.branch === w.branch)?.row ?? 99));
    return [...d.checkout.workspaces].sort((a, b) => row(a) - row(b));
  }
  function inspectorHtml(sel, M) {
    const ix = M.ix;
    const p = ix.p;
    const swatch = (w) => {
      const L = M.lines.find((x) => x.branch === w.branch);
      return w.main
        ? '<i class="ci-sw cs-cm"></i>'
        : L
          ? `<i class="ci-sw cs-c${L.color}"></i>`
          : "";
    };
    if (sel.kind === "project") {
      /* Each device once, with the schedules its server runs beneath it. */
      const autoRow = (a) =>
        `<div class="ci-row ci-sub-row" data-select="auto:${a.id}">${ic("clock2")}<span class="trunc">${esc(a.title)}</span>${nextHtml(a)}</div>`;
      return `<div class="ci-kind">${ic("folder")}Project</div>
        <div class="ci-title">${esc(p.name)}</div><div class="ci-sub mono">${esc(p.repo ?? "Local folder")}</div>
        <dl class="ci-rows"><dt>Branches</dt><dd>${M.git ? (M.lines.length ? `${M.lines.length} besides main` : "Only main") : "Not a git repository"}</dd>
          <dt>Threads</dt><dd>${ix.threads.length}</dd></dl>
        <div class="ci-sec"><h4>On ${ix.devices.length} device${ix.devices.length === 1 ? "" : "s"}${ix.automations.length ? ", with the schedules each one runs" : ""}</h4>
          ${ix.devices
            .map(
              (d) =>
                `<div class="ci-row" data-select="device:${d.checkout.id}">${ic(d.icon)}<span class="trunc">${esc(d.name)}</span><span class="dim mono">${esc(d.checkout.path)}</span></div>${ix.automations
                  .filter((a) => a.checkoutId === d.checkout.id)
                  .map(autoRow)
                  .join("")}`,
            )
            .join("")}</div>
        <div class="ci-actions"><button class="ci-btn primary">${ic("plus")}New thread</button><button class="ci-btn">${ic("pr")}Pull requests</button></div>`;
    }
    if (sel.kind === "device") {
      const d = ix.devices.find((x) => x.checkout.id === sel.id);
      if (!d) return null;
      return `<div class="ci-kind">${ic(d.icon)}Device · checkout</div>
        <div class="ci-title">${esc(d.name)}</div><div class="ci-sub">${d.self ? "This device" : esc(d.via ?? "")}</div>
        <dl class="ci-rows"><dt>Folder</dt><dd class="mono">${esc(d.checkout.path)}</dd><dt>System</dt><dd>${esc(d.os)}</dd>
          <dt>Connection</dt><dd><span class="cs-conn c-${d.self ? "self" : d.conn}"><i></i>${connLabel(d)}</span></dd></dl>
        <div class="ci-sec"><h4>Stations</h4>
          ${stationsInMapOrder(d, M)
            .map(
              (w) =>
                `<div class="ci-row" data-select="ws:${w.id}">${swatch(w)}<span class="trunc ${w.main ? "" : "mono"}">${esc(w.main ? (w.branch ? "Main checkout" : "Folder") : w.branch)}</span>${originMark(p, w)}</div>`,
            )
            .join("")}</div>
        ${
          d.checkout.automations?.length
            ? `<div class="ci-sec"><h4>Schedules this device runs</h4>${ix.automations
                .filter((a) => a.checkoutId === d.checkout.id)
                .map(
                  (a) =>
                    `<div class="ci-row" data-select="auto:${a.id}">${ic("clock2")}<span class="trunc">${esc(a.title)}</span>${nextHtml(a)}</div>`,
                )
                .join("")}</div>`
            : ""
        }
        <div class="ci-actions"><button class="ci-btn">${ic("branch")}New worktree</button><button class="ci-btn">${ic("clock2")}New schedule</button></div>`;
    }
    if (sel.kind === "ws") {
      const w = ix.workspaces.find((x) => x.id === sel.id);
      if (!w) return null;
      const d = DEVICES[w.device];
      const pr = w.origin?.kind === "pr" ? p.prs[w.origin.ref] : null;
      const twins = w.main ? [] : (ix.byBranch[w.branch] ?? []).filter((x) => x.id !== w.id);
      const creator = w.threads
        .map((th) => th.by && ix.automations.find((a) => a.id === th.by))
        .find((a) => a && a.envMode === "worktree" && !w.main);
      const facts = factsOf(w);
      return `<div class="ci-kind">${swatch(w)}${w.main ? (w.branch ? "Main checkout" : "Folder") : "Worktree"}${w.archived ? " · archived" : ""}</div>
        <div class="ci-title ${w.main && w.branch ? "" : "mono"}">${esc(w.branch ?? w.path)}</div>
        <div class="ci-sub">${!w.branch ? "Not a git repository, so no branches or worktrees" : facts.length ? facts.map((f) => `<span class="cs-fact f-${f.tone}">${esc(f.tip && f.tone === "warn" && /uncommitted/.test(f.t) ? f.tip : f.t)}</span>`).join("") : "Clean and up to date"}</div>
        <dl class="ci-rows">
          <dt>Device</dt><dd><span class="ci-link" data-select="device:${w.checkoutId}">${esc(d.name)}</span></dd>
          ${w.branch ? `<dt>Path</dt><dd class="mono">${esc(w.path)}</dd>` : ""}
          ${pr ? `<dt>From</dt><dd>${originMark(p, w)} ${esc(pr.title)} · <span class="dim">${pr.state}, checks ${pr.checks}</span></dd>` : w.origin ? `<dt>From</dt><dd>${originMark(p, w)}</dd>` : ""}
          ${creator ? `<dt>Created by</dt><dd><span class="ci-link" data-select="auto:${creator.id}">${esc(creator.title)}</span></dd>` : ""}
          ${twins.length ? `<dt>Also on</dt><dd>${twins.map((x) => `<span class="ci-link" data-select="ws:${x.id}">${esc(DEVICES[x.device].name)}</span>`).join(", ")}</dd>` : ""}
        </dl>
        <div class="ci-sec"><h4>Threads</h4>
          ${w.threads.length ? w.threads.map((th) => `<div class="ci-row" data-select="thread:${th.id}">${statusDot(th.status)}<span class="trunc">${esc(th.title)}</span><span class="dim tnum">${agoLabel(th.ago)}</span></div>`).join("") : '<div class="dim">No threads yet.</div>'}</div>
        <div class="ci-actions">
          ${w.checkoutRemoved ? `<button class="ci-btn">${ic("folderMinus")}Recreate checkout…</button>` : `<button class="ci-btn primary">${ic("plus")}New thread</button>`}
          ${w.main ? "" : w.archived ? `<button class="ci-btn">${ic("archive")}Restore</button>` : `<button class="ci-btn">${ic("archive")}Archive</button>`}
          ${w.main || w.checkoutRemoved ? "" : `<button class="ci-btn danger">${ic("folderMinus")}Remove checkout…</button>`}
        </div>`;
    }
    if (sel.kind === "auto") {
      const a = ix.automations.find((x) => x.id === sel.id);
      if (!a) return null;
      const run = activeRun(a);
      const made = ix.workspaces.filter((w) => !w.main && w.threads.some((th) => th.by === a.id));
      return `<div class="ci-kind">${ic("clock2")}Schedule${a.enabled ? "" : " · paused"}</div>
        <div class="ci-title">${esc(a.title)}</div>
        <div class="ci-sub">${esc(scheduleLabel(a))}</div>
        ${run?.status === "pending-approval" ? `<div class="ci-due"><div class="ci-due-msg">${ic("shield")}<span>A run is due and waits for your approval. Approving starts ${a.envMode === "worktree" ? "a new worktree" : "a thread in the main checkout"} on ${esc(DEVICES[a.device].name)}.</span></div><div class="ci-due-act"><button class="ci-btn primary" data-approve-id="${a.id}">Approve</button><button class="ci-btn">Reject</button></div></div>` : ""}
        <dl class="ci-rows">
          <dt>Runs on</dt><dd><span class="ci-link" data-select="device:${a.checkoutId}">${esc(DEVICES[a.device].name)}</span></dd>
          <dt>Next run</dt><dd>${a.enabled ? esc(inLabel(a.nextIn)) : "Paused"}</dd>
          <dt>Starts</dt><dd>${a.envMode === "worktree" ? `A new worktree off <span class="mono">${esc(a.baseRef ?? "main")}</span> each run${made.length ? ` · last: ${made.map((w) => `<span class="ci-link mono" data-select="ws:${w.id}">${esc(w.branch)}</span>`).join(", ")}` : ""}` : "A thread in the main checkout"}</dd>
          <dt>Agent</dt><dd>${providerMark(a.provider)} ${PROVIDERS[a.provider]?.name ?? a.provider}</dd>
        </dl>
        <div class="ci-sec"><h4>Recent runs</h4>
          ${a.runs.length ? a.runs.map((r) => `<div class="ci-row" ${r.threads[0] ? `data-select="thread:${r.threads[0]}"` : ""}><span class="ci-run r-${r.status}"></span><span class="trunc">${RUN_STATUS[r.status]?.label ?? r.status}${r.detail ? ` · <span class="dim">${esc(r.detail)}</span>` : ""}</span><span class="dim tnum">${agoLabel(r.ago)}</span></div>`).join("") : '<div class="dim">No runs yet.</div>'}</div>
        <div class="ci-actions"><button class="ci-btn">${ic("play")}Run now</button><button class="ci-btn">${a.enabled ? ic("pause") + "Pause" : ic("play") + "Resume"}</button><button class="ci-btn">${ic("edit")}Edit</button></div>`;
    }
    if (sel.kind === "thread") {
      const th = ix.threads.find((x) => x.id === sel.id);
      if (!th) return null;
      const w = ix.workspaces.find((x) => x.id === th.workspaceId);
      return `<div class="ci-kind">${statusDot(th.status)}Thread · ${STATUS[th.status].label}</div>
        <div class="ci-title">${esc(th.title)}</div>
        <dl class="ci-rows">
          <dt>Agent</dt><dd>${providerMark(th.provider)} ${PROVIDERS[th.provider]?.name ?? th.provider}</dd>
          <dt>Station</dt><dd>${swatch(w)}<span class="ci-link ${w.main ? "" : "mono"}" data-select="ws:${w.id}">${esc(w.main ? "Main checkout" : w.branch)}</span></dd>
          <dt>Device</dt><dd><span class="ci-link" data-select="device:${w.checkoutId}">${esc(DEVICES[th.device].name)}</span></dd>
          <dt>Activity</dt><dd>${th.ago < 1 ? "Just now" : `${agoLabel(th.ago)} ago`}</dd>
          ${th.by ? `<dt>Started by</dt><dd><span class="ci-link" data-select="auto:${th.by}">${esc(ix.automations.find((a) => a.id === th.by)?.title ?? "a schedule")}</span></dd>` : ""}
        </dl>
        <div class="ci-actions"><button class="ci-btn primary">${ic("open")}Open thread</button></div>`;
    }
    return null;
  }

  /* ---------------------------------------------------------- mount */
  function mount(host, apiRef) {
    const st = {
      projectId: null,
      threadsOpen: true,
      toggled: new Set(),
      showAutos: true,
      showArchived: true,
      hover: null,
      colors: new Map(),
      status: new Map(), // thread id → last painted status
      clock: new Map(), // automation id → last painted state
      edgeKeys: new Set(),
      model: null,
      bounds: null,
      /* Camera follow: until you pan or zoom, the map keeps itself framed as
         lines appear, threads arrive and the loop resets. */
      camAuto: true,
      fitBounds: null,
      fitInspW: 0,
      followRaf: 0,
      selKey: null,
    };
    const vp = createViewport(host, {
      onFit: () => fitAll(true),
      onBackgroundClick: () => S.selected && apiRef.select(null),
      minZoom: 0.3,
      maxZoom: 2.4,
    });
    /* Device zones live in screen space behind the world, so they span the
       whole canvas without giving the host anything to scroll. */
    const zones = h("div", "cs-zones");
    host.insertBefore(zones, vp.world);
    host.addEventListener("scroll", () => {
      host.scrollTop = 0;
      host.scrollLeft = 0;
    });
    vp.controls();
    const insp = createInspector(host, { onClose: () => apiRef.select(null) });
    /* The viewport's wheel handler sits on the host and would pan the map
       (and block scrolling) under a long inspector; keep the wheel there. */
    insp.panel.addEventListener("wheel", (e) => e.stopPropagation());
    const head = h("div", "vp-ui cs-head");
    host.append(head);
    const foot = h("div", "vp-ui cs-foot");
    host.append(foot);
    const headCells = new Map();
    const zoneEls = new Map();

    /* ------------------------------------------------ toolbar + key */
    /* A schedule's dotted spur and the mark it leaves on main. */
    const keySpur = (wt) =>
      `<svg width="24" height="10" aria-hidden="true"><path d="M1.5 5h12" stroke="var(--teal)" stroke-width="1.8" stroke-dasharray="0.5 4" stroke-linecap="round" fill="none"/>${
        wt
          ? '<circle cx="19" cy="5" r="3.6" fill="none" stroke="var(--teal)" stroke-width="1.8"/>'
          : '<circle cx="19" cy="5" r="3.6" fill="var(--teal)"/>'
      }</svg>`;
    function paintFoot() {
      const html = `<div class="cs-bar">
          <button type="button" class="cs-chip" data-t="threads" aria-pressed="${st.threadsOpen}">${ic("msg")}Threads</button>
          <button type="button" class="cs-chip" data-t="autos" aria-pressed="${st.showAutos}">${ic("clock2")}Schedules</button>
          <button type="button" class="cs-chip" data-t="archived" aria-pressed="${st.showArchived}">${ic("archive")}Archived</button>
        </div>
        <div class="cs-key">
          <span class="cs-k-basic"><svg width="22" height="8"><path d="M2 4h18" stroke="oklch(var(--cs-l) var(--cs-c) 255)" stroke-width="3.5" stroke-linecap="round"/></svg>Branch</span>
          <span class="cs-k-basic"><i class="cs-key-pill"></i>Checkout</span>
          <span data-tip="A schedule whose runs start a thread in the main checkout">${keySpur(false)}On main</span>
          <span data-tip="A schedule whose every run opens a new worktree; that line leaves main from the ring">${keySpur(true)}New worktree</span>
        </div>`;
      if (foot._html !== html) {
        foot.innerHTML = html;
        foot._html = html;
      }
    }
    foot.addEventListener("click", (e) => {
      const b = e.target.closest("[data-t]");
      if (!b) return;
      if (b.dataset.t === "threads") {
        st.threadsOpen = !st.threadsOpen;
        st.toggled.clear();
      } else if (b.dataset.t === "autos") st.showAutos = !st.showAutos;
      else if (b.dataset.t === "archived") st.showArchived = !st.showArchived;
      render();
      requestAnimationFrame(() => fitAll(true));
    });

    /* ------------------------------------------------ pinned device header */
    function paintHead(M, focus) {
      const want = new Set();
      for (const c of M.cols) {
        const d = c.d;
        want.add(d.id);
        let cell = headCells.get(d.id);
        if (!cell) {
          cell = h("button", "cs-hcell");
          cell.type = "button";
          cell.dataset.dev = d.id;
          head.append(cell);
          headCells.set(d.id, cell);
          if (motion)
            cell.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 360, easing: EASE });
        }
        cell.dataset.cid = c.cid;
        cell.dataset.tip = `${d.name} · ${d.checkout.path}${d.os ? ` · ${d.os}` : ""}`;
        cell._x = c.x - GUT / 2;
        cell._w = PITCH;
        const html = `<span class="cs-hic">${ic(d.icon)}</span><span class="cs-hname">${esc(d.name)}</span><span class="cs-conn"><i></i><b></b></span><span class="cs-hpath mono">${esc(d.checkout.path)}</span>`;
        if (cell._html !== html) {
          cell.innerHTML = html;
          cell._html = html;
        }
        const conn = $(".cs-conn", cell);
        conn.className = `cs-conn c-${d.self ? "self" : d.conn}`;
        $("b", conn).textContent = connLabel(d);
        cell.classList.toggle("on", focus === `dev:${d.id}`);
        cell.classList.toggle(
          "off",
          !!focus && focus.startsWith("dev:") && focus !== `dev:${d.id}`,
        );
      }
      for (const [id, cell] of headCells)
        if (!want.has(id)) {
          headCells.delete(id);
          if (motion)
            cell
              .animate([{ opacity: 1 }, { opacity: 0 }], { duration: 220, fill: "forwards" })
              .finished.then(() => cell.remove());
          else cell.remove();
        }
      placeHead();
    }
    function placeHead() {
      const k = vp.cam.k;
      for (const z of zoneEls.values()) {
        z.style.transform = `translateX(${vp.cam.x + z._x * k}px)`;
        z.style.width = `${z._w * k}px`;
      }
      for (const cell of headCells.values()) {
        cell.style.transform = `translateX(${vp.cam.x + cell._x * k}px)`;
        cell.style.width = `${cell._w * k}px`;
      }
    }
    vp.onChange(placeHead);
    head.addEventListener("pointerover", (e) => {
      const cell = e.target.closest(".cs-hcell");
      const f = cell ? `dev:${cell.dataset.dev}` : null;
      if (f === st.hover) return;
      st.hover = f;
      render({ noEnter: true });
    });
    head.addEventListener("pointerleave", () => {
      if (!st.hover) return;
      st.hover = null;
      render({ noEnter: true });
    });
    head.addEventListener("click", (e) => {
      const cell = e.target.closest(".cs-hcell");
      if (cell) apiRef.select({ kind: "device", id: cell.dataset.cid });
    });

    function paintZones(M, focus) {
      const want = new Set();
      M.cols.forEach((c) => {
        want.add(c.d.id);
        let z = zoneEls.get(c.d.id);
        if (!z) {
          z = h("div", "cs-zone");
          zones.append(z);
          zoneEls.set(c.d.id, z);
        }
        z._x = c.x - GUT / 2;
        z._w = PITCH;
        z.classList.toggle("first", c.i === 0);
        z.classList.toggle("on", focus === `dev:${c.d.id}`);
      });
      for (const [id, z] of zoneEls)
        if (!want.has(id)) {
          z.remove();
          zoneEls.delete(id);
        }
      placeHead();
    }

    /* ------------------------------------------------ focus */
    function selectionFocus(M) {
      const sel = S.selected;
      if (!sel) return null;
      const ix = M.ix;
      const wsFocus = (w) => (w ? (w.main ? "line:main" : `line:${w.branch}`) : null);
      if (sel.kind === "ws") return wsFocus(ix.workspaces.find((x) => x.id === sel.id));
      if (sel.kind === "thread") {
        const th = ix.threads.find((x) => x.id === sel.id);
        return th ? wsFocus(ix.workspaces.find((w) => w.id === th.workspaceId)) : null;
      }
      if (sel.kind === "auto") return `auto:${sel.id}`;
      if (sel.kind === "device") {
        const d = ix.devices.find((x) => x.checkout.id === sel.id);
        return d ? `dev:${d.id}` : null;
      }
      return null;
    }

    /* ------------------------------------------------ render */
    let firstPaint = true;
    function render(opts = {}) {
      const ix = index();
      const projectChanged = st.projectId !== ix.p.id;
      if (projectChanged) {
        st.projectId = ix.p.id;
        st.toggled.clear();
        st.status.clear();
        st.clock.clear();
      }
      const M = build(ix, st);
      st.model = M;
      const fresh = projectChanged || firstPaint;
      const hoverFocus = st.hover;
      const focus = hoverFocus ?? selectionFocus(M);
      if (focus) host.dataset.csFocus = hoverFocus ? "hover" : "sel";
      else delete host.dataset.csFocus;
      const sel = S.selected;
      const selKey = sel ? `${PREFIX[sel.kind] ?? "pj"}:${sel.id}` : null;
      const my = M.mainY;
      const span = Math.max(1, M.mainEnd - MAIN_X0);
      const sweep = (x) => (x - MAIN_X0) / span; // 0..1 along main, for the first draw
      const nodeCls = (tags) => (!focus ? "" : tags.includes(focus) ? "cs-lit" : "cs-dim");
      const edgeCls = (tags) => (!focus ? "" : tags.includes(focus) ? "cs-on" : "cs-off");
      const autoTags = (w) => [
        ...new Set(w.threads.filter((x) => x.by).map((x) => `auto:${x.by}`)),
      ];
      const items = [];
      const edges = [];
      const conn = (c) => (c.d.self || c.d.conn === "online" ? "" : "is-conn");

      /* main: the trunk line, its bullet and stations */
      if (M.git) {
        const tags = ["line:main", ...M.cols.map((c) => `dev:${c.d.id}`)];
        edges.push({
          key: "main",
          d: `M ${MAIN_X0} ${my} L ${M.mainEnd} ${my}`,
          cls: `cs-line cs-main cs-cm ${edgeCls(tags)}`,
          draw: fresh ? { delay: 0, dur: 820 } : null,
        });
        edges.push({
          key: "hit:main",
          d: `M ${MAIN_X0} ${my} L ${M.mainEnd} ${my}`,
          cls: "cs-hit",
          hit: "line:main",
          sel: `project:${M.p.id}`,
        });
        items.push({
          key: "pj",
          x: MAIN_X0 - 14,
          y: my - 14,
          html: `<div class="cs-pj" data-sel="project:${M.p.id}" data-focus="line:main" data-tip="${esc(M.p.repo ?? M.p.name)}"><span class="pav" style="--hue:${M.p.hue}">${esc(M.p.name[0].toUpperCase())}</span></div>`,
          cls: `${nodeCls(["line:main"])} ${selKey === `pj:${M.p.id}` ? "is-selected" : ""}`,
          anim: "pop",
          delay: 0,
        });
        items.push({
          key: "lb:main",
          x: MAIN_X0 + 18,
          y: my - PILL_H / 2 - 3 - LABEL_H,
          html: `<div class="cs-lbl cs-lbl-main" data-sel="project:${M.p.id}" data-focus="line:main"><span class="cs-bname">main</span></div>`,
          cls: nodeCls(["line:main"]),
          anim: "fade",
          delay: fresh ? 120 : 0,
        });
      }
      for (const c of M.cols) {
        const w = c.main;
        if (!w) continue;
        const f = "line:main";
        const tags = [f, `dev:${c.d.id}`, ...autoTags(w)];
        if (!M.git)
          items.push({
            key: `lb:folder:${w.id}`,
            x: c.x + M.STX,
            y: my - PILL_H / 2 - 3 - LABEL_H,
            html: `<div class="cs-lbl" data-sel="ws:${w.id}" data-focus="${f}"><span class="cs-bname cs-sans">Folder</span><span class="cs-note">not a git repository · no branches</span></div>`,
            cls: nodeCls(tags),
            anim: "fade",
            delay: 160,
          });
        items.push({
          key: `w:${w.id}`,
          x: c.x + M.STX,
          y: my - PILL_H / 2,
          html: stationHtml(w, c, M, st, f),
          cls: `cs-n-st cs-cm ${isOpen(st, w) ? "is-open" : ""} ${conn(c)} ${w.checkoutRemoved ? "is-removed" : ""} ${w.missing ? "is-missing" : ""} ${nodeCls(tags)} ${selKey === `w:${w.id}` ? "is-selected" : ""}`,
          anim: "pop",
          delay: fresh ? 180 + sweep(c.x + M.STX) * 640 : 120,
          ws: w,
          isNew: !vp.nodes._nodes?.has(`w:${w.id}`),
        });
      }

      /* branches */
      for (const L of M.lines) {
        const f = `line:${L.branch}`;
        const devs = L.ws.map((w) => `dev:${w.device}`);
        const tags = [f, ...devs, ...(L.byAuto ? [`auto:${L.byAuto}`] : [])];
        const c0 = M.cols[L.start];
        const fx = M.sx(c0, L.slot);
        const ld = fresh ? 300 + sweep(fx) * 640 + L.row * 40 : 60;
        const d = linePath(L, M);
        edges.push({
          key: `ln:${L.branch}`,
          d,
          cls: `cs-line cs-c${L.color} ${L.archived ? "cs-arch" : ""} ${edgeCls(tags)}`,
          draw: { delay: ld, dur: fresh ? 640 : 980, ease: fresh ? EASE : GENTLE },
        });
        edges.push({ key: `hit:${L.branch}`, d, cls: "cs-hit", hit: f, sel: `ws:${L.ws[0].id}` });
        items.push({
          key: `lb:${L.branch}`,
          x: c0.x + M.STX,
          y: M.rowY[L.row] - PILL_H / 2 - 3 - LABEL_H,
          html: labelHtml(L, M, f),
          cls: nodeCls(tags),
          anim: "slide",
          delay: ld + (fresh ? 260 : 360),
        });
        for (const w of L.ws) {
          const c = M.colOf.get(w.checkoutId);
          const wt = [f, `dev:${c.d.id}`, ...autoTags(w)];
          items.push({
            key: `w:${w.id}`,
            x: c.x + M.STX,
            y: M.rowY[L.row] - PILL_H / 2,
            html: stationHtml(w, c, M, st, f),
            cls: `cs-n-st cs-c${L.color} ${isOpen(st, w) ? "is-open" : ""} ${conn(c)} ${w.checkoutRemoved ? "is-removed" : ""} ${w.missing ? "is-missing" : ""} ${w.archived ? "is-arch" : ""} ${nodeCls(wt)} ${selKey === `w:${w.id}` ? "is-selected" : ""}`,
            anim: "pop",
            delay: ld + (fresh ? 320 : 520) + (c.i - L.start) * 200,
            ws: w,
            fresh: !fresh,
            isNew: !vp.nodes._nodes?.has(`w:${w.id}`),
          });
        }
      }

      /* threads hanging off expanded stations */
      for (const it of items.filter((x) => x.ws)) {
        const w = it.ws;
        if (!isOpen(st, w)) continue;
        const L = w.main ? null : M.lines.find((x) => x.branch === w.branch);
        const f = w.main ? "line:main" : `line:${w.branch}`;
        const top = it.y + PILL_H + (factsOf(w).length ? FACT_H : 0) + 8;
        const px = it.x + 12;
        shownThreads(st, w).forEach((th, i) => {
          const ty = top + i * (TH_H + TH_GAP) + TH_H / 2;
          const tags = [f, `dev:${w.device}`, ...(th.by ? [`auto:${th.by}`] : [])];
          edges.push({
            key: `tc:${th.id}`,
            d: `M ${px} ${it.y + PILL_H + (factsOf(w).length ? FACT_H - 2 : 1)} L ${px} ${ty - 6} Q ${px} ${ty} ${px + 6} ${ty} L ${px + 9} ${ty}`,
            cls: `cs-tc ${edgeCls(tags)}`,
            draw: { delay: (fresh || it.isNew ? (it.delay ?? 0) + 140 : 0) + i * 40, dur: 420 },
          });
          items.push({
            key: `t:${th.id}`,
            x: px + 8,
            y: ty - TH_H / 2,
            html: threadHtml(th, f, M),
            cls: `${nodeCls(tags)} ${selKey === `t:${th.id}` ? "is-selected" : ""} ${L ? `cs-c${L.color}` : "cs-cm"}`,
            anim: "drop",
            delay: (fresh || it.isNew ? (it.delay ?? 0) + 200 : 60) + i * 45,
          });
        });
      }

      /* schedules: clocks above main, spurs into it */
      for (const c of M.cols)
        for (const a of c.autos) {
          const s = clockState(a);
          const tags = [
            `auto:${a.id}`,
            `dev:${c.d.id}`,
            ...(a.paired ? [`line:${a.paired.branch}`] : []),
          ];
          const x = M.sx(c, a.slot);
          const sd = fresh ? 340 + sweep(x) * 640 : 80;
          edges.push({
            key: `sp:${a.id}`,
            d: spurPath(a, M),
            cls: `cs-spur is-${s} ${a.envMode === "worktree" ? "is-wt" : ""} ${edgeCls(tags)}`,
            draw: { delay: sd, dur: 520, fade: true },
          });
          /* where the schedule meets main: a hollow ring where its worktrees
             branch off, a solid dot where it rides main into the main checkout */
          const wt = a.envMode === "worktree";
          items.push({
            key: `j:${a.id}`,
            x: x - 5,
            y: my - 5,
            html: `<i class="cs-jn is-${s} ${wt ? "is-wt" : "is-local"}" data-sel="auto:${a.id}" data-focus="auto:${a.id}" data-tip="${wt ? `New worktrees for “${esc(a.title)}” leave main here` : `“${esc(a.title)}” runs in the main checkout`}"></i>`,
            cls: nodeCls(tags),
            anim: "pop",
            delay: sd + 120,
          });
          if (s === "running" && !wt)
            edges.push({
              key: `rn:${a.id}`,
              d: `M ${x + 6} ${my} L ${c.x + M.STX + 4} ${my}`,
              cls: `cs-runpath ${edgeCls(tags)}`,
              draw: { delay: 0, dur: 420, fade: true },
            });
          items.push({
            key: `a:${a.id}`,
            x: c.x + M.STX,
            y: a.y - CLK_H / 2,
            html: clockHtml(a, M),
            cls: `cs-n-clk ${conn(c)} ${nodeCls(tags)} ${selKey === `a:${a.id}` ? "is-selected" : ""}`,
            anim: "pop",
            delay: sd + 260,
            auto: a,
          });
        }

      /* ---- sync */
      const store = syncNodes(vp.nodes, items, {
        noEnter: opts.noEnter,
        enter: (el, item) => enterNode(el, item),
        exit: (el) => exitNode(el),
      });
      const prevKeys = st.edgeKeys;
      const estore = syncEdges(vp.edges, edges, { noEnter: true });
      st.edgeKeys = new Set(edges.map((e) => e.key));
      for (const e of edges) {
        const rec = estore.get(e.key);
        if (!rec) continue;
        /* hit paths outlive a project switch ("hit:main"), so keep their
           targets current rather than set once */
        if (e.hit && (rec.el.dataset.focus !== e.hit || rec.el.dataset.sel !== e.sel)) {
          rec.el.dataset.focus = e.hit;
          rec.el.dataset.sel = e.sel;
          rec.el.setAttribute("data-no-pan", "");
        }
        if (!prevKeys.has(e.key) && motion && !opts.noEnter && e.draw) drawEdge(rec.el, e.draw);
      }

      /* ---- in-place patches (no re-render, so colours glide) */
      const thById = new Map(ix.threads.map((x) => [x.id, x]));
      for (const it of items) {
        const rec = store.get(it.key);
        if (!rec) continue;
        for (const dot of rec.el.querySelectorAll("[data-th]")) {
          const th = thById.get(dot.dataset.th);
          if (!th) continue;
          const cls = `sdot s-${th.status}`;
          if (dot.getAttribute("class") !== cls) dot.setAttribute("class", cls);
          dot.dataset.tip = `${th.title} · ${STATUS[th.status].label}`;
          const prev = st.status.get(th.id);
          if (prev && prev !== th.status && motion && !fresh) bump(dot);
          else if (!prev && !fresh && motion && !it.key.startsWith("t:")) bump(dot);
        }
        if (it.auto) patchClock(rec.el, it.auto, fresh);
        const fold = it.ws && rec.el.querySelector(".cs-fold");
        if (fold) {
          const open = isOpen(st, it.ws);
          const n = shownThreads(st, it.ws).length;
          fold.setAttribute("aria-expanded", String(open));
          fold.dataset.tip = open ? "Fold threads" : `Show ${n} thread${n === 1 ? "" : "s"}`;
        }
      }
      for (const th of ix.threads) st.status.set(th.id, th.status);

      paintHead(M, focus);
      paintZones(M, focus);
      paintFoot();

      /* bounds: nodes plus the full length of main */
      const b = boundsOf(store);
      if (b) {
        const x1 = Math.max(b.x + b.w, M.git ? M.mainEnd : -Infinity);
        st.bounds = { x: b.x, y: b.y, w: x1 - b.x, h: Math.max(b.h, M.bottom - b.y) };
      }

      /* inspector */
      if (sel) {
        const html = inspectorHtml(sel, M);
        if (html) insp.show(`${sel.kind}:${sel.id}`, html);
        else insp.hide();
      } else insp.hide();

      /* camera: refit on project switch; otherwise keep the selection clear of
         the inspector and, while the camera is ours, keep everything framed */
      const prevSel = st.selKey;
      st.selKey = selKey;
      if (projectChanged && !firstPaint) requestAnimationFrame(() => fitAll(true));
      else if (!firstPaint) {
        const grew = st.camAuto && boundsMoved(st.bounds, st.fitBounds);
        if (grew || (selKey !== prevSel && !selKey && st.camAuto)) scheduleFollow();
        else if (selKey && selKey !== prevSel) requestAnimationFrame(() => reveal(selKey));
      }
    }
    const boundsMoved = (a, b) =>
      !!a &&
      (!b ||
        Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.w - b.w) + Math.abs(a.h - b.h) > 2);
    function scheduleFollow() {
      if (st.followRaf) return;
      st.followRaf = requestAnimationFrame(() => {
        st.followRaf = 0;
        follow();
      });
    }

    /* ------------------------------------------------ motion helpers */
    function enterNode(el, item) {
      const inner = el.firstElementChild;
      const delay = item.delay ?? 0;
      if (!inner) return;
      if (item.anim === "pop") {
        inner.animate(
          [
            { opacity: 0, scale: "0.55" },
            { opacity: 1, scale: "1" },
          ],
          { duration: 560, delay, easing: SNAPPY, fill: "backwards" },
        );
        if (item.fresh)
          inner
            .querySelector(".cs-pill")
            ?.animate(
              [
                { boxShadow: "0 0 0 0 color-mix(in srgb, var(--lc) 55%, transparent)" },
                { boxShadow: "0 0 0 10px transparent" },
              ],
              { duration: 1200, delay: delay + 300, easing: "ease-out" },
            );
      } else if (item.anim === "slide")
        inner.animate(
          [
            { opacity: 0, translate: "-10px 0" },
            { opacity: 1, translate: "0 0" },
          ],
          { duration: 480, delay, easing: EASE, fill: "backwards" },
        );
      else if (item.anim === "drop")
        inner.animate(
          [
            { opacity: 0, translate: "0 -8px" },
            { opacity: 1, translate: "0 0" },
          ],
          { duration: 420, delay, easing: EASE, fill: "backwards" },
        );
      else
        inner.animate([{ opacity: 0 }, { opacity: 1 }], {
          duration: 420,
          delay,
          easing: EASE,
          fill: "backwards",
        });
    }
    function exitNode(el) {
      el.firstElementChild?.animate([{ scale: "1" }, { scale: "0.8" }], {
        duration: 240,
        easing: "ease-in",
        fill: "forwards",
      });
      return el.animate([{ opacity: 1 }, { opacity: 0 }], {
        duration: 240,
        easing: "ease-in",
        fill: "forwards",
      });
    }
    function drawEdge(el, o) {
      for (const an of el.getAnimations()) an.cancel();
      if (o.fade) {
        el.animate([{ opacity: 0 }, { opacity: 1 }], {
          duration: o.dur,
          delay: o.delay,
          easing: EASE,
          fill: "backwards",
        });
        return;
      }
      const len = el.getTotalLength?.() || 400;
      el.animate(
        [
          { strokeDasharray: `${len} ${len}`, strokeDashoffset: `${len}` },
          { strokeDasharray: `${len} ${len}`, strokeDashoffset: "0" },
        ],
        { duration: o.dur, delay: o.delay, easing: o.ease ?? EASE, fill: "backwards" },
      );
    }
    function bump(dot) {
      dot.animate(
        [
          { scale: "1.9", boxShadow: "0 0 0 0 color-mix(in srgb, currentColor 0%, transparent)" },
          { scale: "1", boxShadow: "0 0 0 5px transparent" },
        ],
        { duration: 620, easing: SNAPPY },
      );
    }
    function patchClock(el, a, fresh) {
      const s = clockState(a);
      const prog = $(".prog", el);
      if (prog) {
        const c = 2 * Math.PI * 9;
        const done = s === "idle" ? cycle(a) : s === "paused" ? 0 : 1;
        prog.style.strokeDashoffset = `${(c * (1 - Math.max(0, Math.min(1, done)))).toFixed(2)}`;
      }
      const next = $(".cs-next", el);
      const label = inLabel(a.nextIn);
      if (next && next.textContent !== label) next.textContent = label;
      const prev = st.clock.get(a.id);
      if (prev && prev !== s && motion && !fresh) {
        $(".cs-ring", el)?.animate([{ scale: "1.35" }, { scale: "1" }], {
          duration: 640,
          easing: SNAPPY,
        });
        $(".cs-csub", el)?.animate(
          [
            { opacity: 0, translate: "0 4px" },
            { opacity: 1, translate: "0 0" },
          ],
          { duration: 380, easing: EASE },
        );
      }
      st.clock.set(a.id, s);
    }

    /* ------------------------------------------------ camera */
    const inspOpen = () => insp.panel.classList.contains("open");
    function fitTarget(inspW) {
      const b = st.bounds;
      if (!b) return null;
      const W = host.clientWidth;
      const H = host.clientHeight;
      const availW = W - inspW - 2 * 24;
      const availH = H - HEAD_H - FOOT_H - 2 * 18;
      const k = clamp(Math.min(availW / b.w, availH / b.h), 0.3, 1.1);
      return {
        k,
        x: (W - inspW) / 2 - (b.x + b.w / 2) * k,
        y: HEAD_H + (H - HEAD_H - FOOT_H) / 2 - (b.y + b.h / 2) * k,
      };
    }
    /* Explicit fit (mount, project switch, double-click, toolbar): frames
       everything in the space the inspector leaves, and hands the camera back
       to the map. */
    function fitAll(animate) {
      st.fitInspW = inspOpen() ? 340 : 0;
      const c = fitTarget(st.fitInspW);
      if (!c) return;
      st.camAuto = true;
      st.fitBounds = st.bounds;
      vp.setCamera(c, { animate, duration: 760 });
    }
    /* Automatic refit while the camera is ours: same framing as the last fit,
       then nudged so an open inspector never covers the selection. */
    function follow() {
      const c = fitTarget(inspOpen() ? st.fitInspW : 0);
      if (!c) return;
      st.fitBounds = st.bounds;
      if (st.selKey && inspOpen()) {
        const d = revealDelta(c, st.selKey);
        c.x += d.dx;
        c.y += d.dy;
      }
      vp.setCamera(c, { animate: true, duration: 820 });
    }
    /* What must stay visible for a selection: the node, plus a station's
       name when it sits directly above it (folder notes, line labels). */
    function revealRect(key) {
      const store = vp.nodes._nodes;
      const r = store?.get(key);
      if (!r || !key.startsWith("w:")) return r;
      const above = [...store.entries()].find(
        ([k, x]) =>
          k.startsWith("lb:") && Math.abs(x.x - r.x) < 1 && r.y - (x.y + x.h) < 8 && r.y > x.y,
      );
      if (!above) return r;
      const a = above[1];
      const x0 = Math.min(r.x, a.x);
      const y0 = Math.min(r.y, a.y);
      return {
        x: x0,
        y: y0,
        w: Math.max(r.x + r.w, a.x + a.w) - x0,
        h: Math.max(r.y + r.h, a.y + a.h) - y0,
      };
    }
    function revealDelta(cam, key) {
      const r = revealRect(key);
      if (!r) return { dx: 0, dy: 0 };
      const k = cam.k;
      const sx0 = r.x * k + cam.x;
      const sy0 = r.y * k + cam.y;
      const right = host.clientWidth - 350;
      let dx = 0;
      let dy = 0;
      if (sx0 + r.w * k > right) dx = right - (sx0 + r.w * k) - 24;
      if (sx0 + dx < 24) dx = 24 - sx0;
      if (sy0 < HEAD_H + 16) dy = HEAD_H + 16 - sy0;
      if (sy0 + r.h * k > host.clientHeight - FOOT_H - 12)
        dy = host.clientHeight - FOOT_H - 12 - (sy0 + r.h * k);
      return { dx, dy };
    }
    function reveal(key) {
      const { dx, dy } = revealDelta(vp.cam, key);
      if (dx || dy)
        vp.setCamera({ x: vp.cam.x + dx, y: vp.cam.y + dy }, { animate: true, duration: 620 });
    }
    /* Panning or zooming yourself takes the camera; fit hands it back. */
    let press = null;
    host.addEventListener(
      "wheel",
      (e) => {
        if (!e.target.closest(".vp-ui")) st.camAuto = false;
      },
      { passive: true },
    );
    host.addEventListener("pointerdown", (e) => {
      press = e.target.closest("[data-no-pan], .node, .vp-ui, button")
        ? null
        : { x: e.clientX, y: e.clientY };
    });
    host.addEventListener("pointermove", (e) => {
      if (press && Math.abs(e.clientX - press.x) + Math.abs(e.clientY - press.y) > 3) {
        st.camAuto = false;
        press = null;
      }
    });
    host.addEventListener("pointerup", () => (press = null));
    host.addEventListener("click", (e) => {
      const z = e.target.closest(".vp-zoom [data-z]");
      if (z && z.dataset.z !== "fit") st.camAuto = false;
    });

    /* ------------------------------------------------ interaction */
    const setHover = (f) => {
      if (f === st.hover) return;
      st.hover = f;
      render({ noEnter: true });
    };
    vp.nodes.addEventListener("pointerover", (e) =>
      setHover(e.target.closest("[data-focus]")?.dataset.focus ?? null),
    );
    vp.nodes.addEventListener("pointerleave", () => setHover(null));
    vp.edges.addEventListener("pointerover", (e) =>
      setHover(e.target.closest?.("[data-focus]")?.dataset.focus ?? null),
    );
    vp.edges.addEventListener("pointerout", (e) => {
      if (!e.relatedTarget?.closest?.("[data-focus]")) setHover(null);
    });

    function selectFrom(spec) {
      const i = spec.indexOf(":");
      const kind = spec.slice(0, i);
      const id = spec.slice(i + 1);
      apiRef.select({ kind, id }); // render() reveals the new selection
    }
    vp.nodes.addEventListener("click", (e) => {
      const ap = e.target.closest("[data-approve]");
      if (ap) {
        approve(ap.dataset.approve);
        return;
      }
      const ex = e.target.closest("[data-expand]");
      if (ex) {
        const id = ex.dataset.expand;
        st.toggled.has(id) ? st.toggled.delete(id) : st.toggled.add(id);
        render(); // follows the new bounds while the camera is ours
        if (!st.camAuto) requestAnimationFrame(() => reveal(`w:${id}`));
        return;
      }
      const s = e.target.closest("[data-sel]");
      if (s) selectFrom(s.dataset.sel);
    });
    vp.edges.addEventListener("click", (e) => {
      const s = e.target.closest?.("[data-sel]");
      if (s) selectFrom(s.dataset.sel);
    });
    insp.panel.addEventListener("click", (e) => {
      const ap = e.target.closest("[data-approve-id]");
      if (ap) {
        approve(ap.dataset.approveId);
        return;
      }
      const t2 = e.target.closest("[data-select]");
      if (t2) selectFrom(t2.dataset.select);
    });

    /* Approving a due run starts it now (the lab advances it in place). */
    function approve(aid) {
      for (const p of S.projects)
        for (const c of p.checkouts)
          for (const a of c.automations ?? []) {
            const run = a.id === aid && activeRun(a);
            if (!run || run.status !== "pending-approval") continue;
            const ws = c.workspaces.find((w) => w.main);
            const thread = t(
              `t-${run.id}`,
              `${a.title}: run ${a.runs.length}`,
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

    return {
      update() {
        render();
        if (firstPaint) {
          firstPaint = false;
          requestAnimationFrame(() => {
            fitAll(false);
            if (st.selKey) reveal(st.selKey);
          });
        }
      },
      destroy() {
        vp.destroy();
      },
    };
  }

  DIRS.C = {
    title: "C · Branches",
    thesis:
      "A transit map of the repository. <b>main</b> is the trunk; every branch leaves it as its own line and runs to <b>stations</b>, one per device where it is checked out, with that station's threads listed beneath it. Columns are devices, so <b>what</b> reads along a line and <b>where</b> reads across columns: a line that crosses two columns is the same branch on two machines. Schedules are clocks above main, in the column of the device that runs them, and the mark their spur leaves on main says what a run starts.",
    notes: [
      [
        "Reading it",
        [
          "<b>Columns are devices.</b> The header stays pinned while you pan and shows connection state (a device that is still connecting fades its stations until it is live). Hover a device to light everything it holds; click it for its folder, stations and the schedules it runs.",
          "<b>Lines are branches.</b> Colour is identity only and never status. The name sits on the line once, with where it came from (PR, issue, Jira). A merged PR's line bends back into main; an archived one is dashed.",
          "<b>Stations are checkouts:</b> a pill on the line with the device and its thread count. Facts appear under it only when they need care (uncommitted, unmerged, behind, missing). A hollow, dashed pill is a removed checkout that keeps its record.",
        ],
      ],
      [
        "Schedules",
        [
          "A clock sits above main in the column of the device whose server runs it, so “which automations live where” reads straight down the header. The ring fills as the next run approaches; a red dot on it means the last run failed; a paused one is grey and dashed.",
          "Where its dotted spur meets main says what a run starts: a <b>solid dot</b> runs in the main checkout, a <b>hollow ring</b> opens a new worktree each run, and the line that run created leaves main from that ring (Linux build smoke test → auto/linux-smoke-1005). The key at the bottom repeats both marks.",
          "A due run turns the clock amber and asks for approval right on the map (Approve / Reject in the inspector). While it runs the ring spins, a dotted pulse rides main into the station and its thread appears there, marked with a small clock.",
        ],
      ],
      [
        "Moving around · live",
        [
          "Hover a line to lift it and step the rest back; hover a clock to light the threads its runs started. Click anything to inspect: the camera nudges the selection clear of the inspector, Esc or the close button puts it back.",
          "A pill selects its station; its chevron folds or opens just those threads. <b>Threads</b> folds every station into status dots; <b>Schedules</b> and <b>Archived</b> take their layers off the map.",
          "Until you pan or zoom, the camera is the map's: it glides to keep everything framed as lines and threads arrive (double-click or Fit hands it back). At 0:07 a new line draws out of main on the Studio (#671, merged, so it loops back), its station pops in, projects-page glides down to make room and “Triage new issues” comes due. Statuses recolour in place.",
        ],
      ],
    ],
    mount,
  };
})();
