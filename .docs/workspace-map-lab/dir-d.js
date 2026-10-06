/* ============================================================
   D · Zoom — one spatial canvas that holds every project, read
   by semantic zoom like a map.
     far   all projects: regions with live counts, devices as
           labelled islands, workspaces and schedules as named
           blocks tinted by status, threads as silhouettes
     mid   one project (the default): every card reads: thread
           titles, facts, schedules and where each run lands
     near  one device: agents, ages and folder paths join in
   Geometry never changes with zoom; only detail crossfades, so
   nothing jumps while you zoom. Clicking flies the camera; a
   breadcrumb mirrors (and drives) the zoom path.
   ============================================================ */
(() => {
  /* ---------------------------------------------------------- geometry (world px) */
  const G = {
    tileW: 248,
    islPad: 12,
    islHead: 46,
    islGap: 14,
    regPad: 16,
    regHead: 58,
    regGapX: 96,
    regGapY: 112,
    chipH: 52,
    chipGap: 6,
    stripAfter: 13,
    tileGap: 8,
    tilePadT: 10,
    tileHead: 20,
    factLine: 16,
    factsPad: 3,
    rowsGap: 6,
    rowH: 22,
    tilePadB: 9,
  };
  G.islW = G.tileW + G.islPad * 2;

  /* Zoom thresholds, three bands that crossfade:
       far   1 below farFull, 0 above farNone: blocks tinted by status,
             labels counter-scaled like place names
       mid   0 below midNone, 1 above midFull: thread titles, facts and
             schedules resolve (the project view, the default, reads)
       near  0 below nearNone, 1 above nearFull: metadata (agent, age,
             folder path) joins in at device zoom
     The far/mid bands are re-derived from the overview's zoom, so "All
     projects" is always the far level whatever the window size. */
  const LOD = {
    farFull: 0.5,
    farNone: 0.64,
    midNone: 0.53,
    midFull: 0.67,
    nearNone: 0.94,
    nearFull: 1.04,
    project: 0.57,
    device: 0.98,
  };
  function tuneFar(allK) {
    LOD.farFull = clamp(allK * 1.05, 0.34, 0.66);
    LOD.farNone = LOD.farFull + 0.14;
    LOD.midNone = LOD.farFull + 0.04;
    LOD.midFull = LOD.farNone + 0.04;
    LOD.project = (LOD.farFull + LOD.farNone) / 2;
  }
  const TOP = 46; // breadcrumb clearance
  const INSP_W = 344;

  const PREFIX = { project: "r", device: "i", ws: "w", auto: "a", thread: "t" };
  const KIND = { r: "project", i: "device", w: "ws", a: "auto", t: "thread" };
  const statusOrder = { working: 0, input: 1, error: 2, done: 3, idle: 4, archived: 5 };
  const smooth = (a, b, x) => {
    const t = clamp((x - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  };
  const easeInOutCubic = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
  const easeOutQuart = (x) => 1 - Math.pow(1 - x, 4);
  const RING_R = 7.5;
  const RING_C = 2 * Math.PI * RING_R;
  const greekW = (s, px = 5.6, max = 150) => Math.round(Math.min(max, 10 + String(s).length * px));
  /* Facts wrap onto as many 16px lines as they need (estimated widths). */
  const FACT_W = G.tileW - 22 - 21;
  function packFacts(facts) {
    const lines = [];
    let line = [];
    let used = 0;
    for (const f of facts) {
      const w = f.label.length * 5.7 + (line.length ? 13 : 0);
      if (line.length && used + w > FACT_W) {
        lines.push(line);
        line = [];
        used = 0;
      }
      line.push(f);
      used += line.length > 1 ? w : f.label.length * 5.7;
    }
    if (line.length) lines.push(line);
    return lines;
  }

  /* ---------------------------------------------------------- facts */
  function tileFacts(w, twins) {
    const out = workspaceFacts(w).map((f) => ({ ...f }));
    if (w.main && w.branch === null) out.push({ label: "Not a git repository", tone: "muted" });
    if (twins.length)
      out.push({
        label: `Also on ${twins.map((x) => DEVICES[x.device].name).join(", ")}`,
        tone: "violet",
      });
    if (!w.threads.length && !w.checkoutRemoved)
      out.push({ label: "No threads yet", tone: "muted" });
    return out;
  }
  function tileTone(w) {
    if (w.archived || w.checkoutRemoved) return "archived";
    const s = new Set(w.threads.map((x) => x.status));
    return s.has("working")
      ? "working"
      : s.has("input")
        ? "input"
        : s.has("error")
          ? "error"
          : "quiet";
  }
  function chipState(a) {
    const run = activeRun(a);
    if (!a.enabled) return "paused";
    if (run?.status === "pending-approval") return "due";
    if (run) return "running";
    return "idle";
  }
  const lastDone = (a) =>
    a.runs.find((r) => !["pending-approval", "approved", "executing"].includes(r.status));

  /* ---------------------------------------------------------- layout
     First project across the top, the rest in a row beneath it.
     Each project is a region of device islands; an island holds its
     automation strip, then its workspace tiles, then thread rows. */
  function layout(all) {
    const regions = [];
    const rects = new Map();
    const parent = {};
    for (const ix of all) {
      const islands = [];
      let maxH = 0;
      ix.devices.forEach((d, i) => {
        const c = d.checkout;
        const isl = {
          key: `i:${c.id}`,
          d,
          c,
          ix,
          x: G.regPad + i * (G.islW + G.islGap),
          y: G.regHead,
          chips: [],
          tiles: [],
          rows: [],
        };
        let y = G.islHead;
        for (const a of c.automations ?? []) {
          isl.chips.push({
            key: `a:${a.id}`,
            a: ix.automations.find((x) => x.id === a.id),
            dx: G.islPad,
            dy: y,
          });
          y += G.chipH + G.chipGap;
        }
        isl.ruleY = c.automations?.length ? y - G.chipGap + G.stripAfter / 2 + 0.5 : null;
        if (c.automations?.length) y += G.stripAfter - G.chipGap;
        for (const w0 of c.workspaces) {
          const w = ix.workspaces.find((x) => x.id === w0.id);
          const twins =
            w.branch && !w.main ? (ix.byBranch[w.branch] ?? []).filter((x) => x.id !== w.id) : [];
          const facts = tileFacts(w, twins);
          const lines = packFacts(facts);
          let th =
            G.tilePadT + G.tileHead + (lines.length ? lines.length * G.factLine + G.factsPad : 0);
          const rowsTop = th + G.rowsGap;
          if (w.threads.length) th += G.rowsGap + w.threads.length * G.rowH;
          th += G.tilePadB;
          const tile = { key: `w:${w.id}`, w, facts, lines, twins, dx: G.islPad, dy: y, h: th };
          isl.tiles.push(tile);
          w.threads.forEach((t0, j) => {
            const thr = ix.threads.find((x) => x.id === t0.id);
            isl.rows.push({
              key: `t:${thr.id}`,
              th: thr,
              w,
              dx: G.islPad + 5,
              dy: y + rowsTop + j * G.rowH,
              tileKey: tile.key,
            });
          });
          y += th + G.tileGap;
        }
        y += G.islPad - G.tileGap;
        isl.h = Math.max(y, G.islHead + 20);
        isl.w = G.islW;
        maxH = Math.max(maxH, isl.h);
        islands.push(isl);
      });
      const w = Math.max(
        G.regPad * 2 + islands.length * G.islW + (islands.length - 1) * G.islGap,
        300,
      );
      regions.push({
        key: `r:${ix.p.id}`,
        ix,
        p: ix.p,
        w,
        h: G.regHead + maxH + G.regPad,
        islands,
      });
    }
    /* Place regions: the first across the top, the others side by side
       beneath it (a squarer map fits the canvas at a larger zoom). */
    const [first, ...rest] = regions;
    if (first) {
      first.x = 0;
      first.y = 0;
      let x = 0;
      for (const r of rest) {
        r.x = x;
        r.y = first.h + G.regGapY;
        x += r.w + G.regGapX;
      }
    }
    for (const r of regions) {
      rects.set(r.key, { x: r.x, y: r.y, w: r.w, h: r.h });
      for (const isl of r.islands) {
        isl.x += r.x;
        isl.y += r.y;
        rects.set(isl.key, { x: isl.x, y: isl.y, w: isl.w, h: isl.h });
        parent[isl.key] = r.key;
        for (const c of isl.chips) {
          c.x = isl.x + c.dx;
          c.y = isl.y + c.dy;
          rects.set(c.key, { x: c.x, y: c.y, w: G.tileW, h: G.chipH });
          parent[c.key] = isl.key;
        }
        for (const t of isl.tiles) {
          t.x = isl.x + t.dx;
          t.y = isl.y + t.dy;
          rects.set(t.key, { x: t.x, y: t.y, w: G.tileW, h: t.h });
          parent[t.key] = isl.key;
        }
        for (const row of isl.rows) {
          row.x = isl.x + row.dx;
          row.y = isl.y + row.dy;
          rects.set(row.key, { x: row.x, y: row.y, w: G.tileW - 10, h: G.rowH });
          parent[row.key] = row.tileKey;
        }
      }
    }
    return { all, regions, rects, parent };
  }

  /* ---------------------------------------------------------- markup */
  const near = (html, cls = "") => `<span class="dz-near ${cls}">${html}</span>`;
  const mid = (html, cls = "") => `<span class="dz-mid ${cls}">${html}</span>`;
  const greek = (w, tone = "") =>
    `<i class="dz-greek ${tone ? `g-${tone}` : ""}" style="width:${w}px"></i>`;

  function regionHtml(r) {
    const p = r.p;
    return `<div class="dz-reg">
      <div class="dz-band" data-nav="project">
        <div class="dz-band-in">
          <span class="pav" style="--hue:${p.hue}">${esc(p.name[0].toUpperCase())}</span>
          <span class="dz-band-name">${esc(p.name)}</span>
          <span class="dz-band-repo trunc ${p.repo ? "mono" : ""}">${esc(p.repo ?? "Local folder")}</span>
          <span class="dz-sp"></span>
          <span class="dz-sum"></span>
        </div>
      </div>
    </div>`;
  }

  function summaryHtml(ix) {
    const tl = tally(ix.threads);
    const due = ix.automations.filter((a) => chipState(a) === "due").length;
    const parts = [];
    if (tl.working)
      parts.push(
        `<span class="dz-sum-i s-working"><i class="dz-dot"></i>${tl.working} working</span>`,
      );
    if (tl.input)
      parts.push(
        `<span class="dz-sum-i s-input"><i class="dz-dot"></i>${tl.input} needs input</span>`,
      );
    if (tl.error)
      parts.push(`<span class="dz-sum-i s-error"><i class="dz-dot"></i>${tl.error} failed</span>`);
    if (due)
      parts.push(
        `<span class="dz-sum-due">${ic("shield")}${due} ${due === 1 ? "run" : "runs"} to approve</span>`,
      );
    else {
      const next = ix.automations
        .filter((a) => a.enabled && a.nextIn != null && chipState(a) === "idle")
        .sort((x, y) => x.nextIn - y.nextIn)[0];
      /* The countdown text is patched in place (see render), so a tick
         never rebuilds the summary. */
      if (next)
        parts.push(
          `<span class="dz-sum-next" data-next="${next.id}" data-tip="${esc(next.title)} · ${esc(DEVICES[next.device].name)}">${ic("clock2")}<span class="dz-sum-in"></span></span>`,
        );
    }
    if (!parts.length) parts.push(`<span class="dz-sum-i">Quiet</span>`);
    return parts.join("");
  }

  function islandHtml(isl) {
    const d = isl.d;
    return `<div class="dz-isl">
      <div class="dz-isl-h" data-nav="device">
        <div class="dz-isl-in">
          ${ic(d.icon)}<span class="dz-isl-name">${esc(d.name)}</span>
          ${d.self ? '<span class="dz-self"><span>This device</span></span>' : '<span class="dz-conn"><i></i><span class="dz-conn-l"></span></span>'}
          <span class="dz-sp"></span>
          <span class="dz-isl-path mono trunc" data-tip="Checkout folder">${esc(isl.c.path)}</span>
        </div>
      </div>
      ${isl.ruleY != null ? `<i class="dz-isl-rule" style="top:${isl.ruleY}px"></i>` : ""}
    </div>`;
  }

  function ringHtml() {
    return `<svg class="dz-ring" viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="10" cy="10" r="${RING_R}" class="trk"/>
      <circle cx="10" cy="10" r="${RING_R}" class="prg" style="stroke-dasharray:${RING_C.toFixed(2)};stroke-dashoffset:${RING_C.toFixed(2)}"/>
      <path d="M10 6.6V10l2.2 1.3" class="hand"/></svg>`;
  }

  function chipHtml(a, st) {
    const last = lastDone(a);
    const failed = st === "idle" && last?.status === "failed";
    const right =
      st === "due"
        ? `<button type="button" class="dz-approve" data-approve="${a.id}">Approve</button>`
        : st === "running"
          ? `<span class="dz-chip-s run"><i class="dz-dot"></i>Running</span>`
          : st === "paused"
            ? `<span class="dz-chip-s">Paused</span>`
            : `${failed ? `<span class="dz-failed" data-tip="Last run failed${last.detail ? ` · ${esc(last.detail)}` : ""}"></span>` : ""}<span class="dz-chip-s dz-next tnum"></span>`;
    const sched = scheduleLabel(a);
    const target = a.envMode === "worktree" ? "worktree" : "main";
    const targetTip =
      a.envMode === "worktree"
        ? `Each run starts a thread in a new worktree off ${a.baseRef ?? "main"}`
        : "Each run starts a thread in the main checkout";
    return `<div class="dz-chip">
      <div class="dz-chip-h">${ringHtml()}<span class="dz-chip-t trunc">${esc(a.title)}</span><span class="dz-sp"></span>${right}</div>
      <div class="dz-chip-sub">
        <span class="dz-slot">${mid(esc(sched), "dz-sched trunc")}${greek(greekW(sched, 5.1, 130))}</span>
        <span class="dz-sp"></span>
        <span class="dz-slot dz-slot-to" data-tip="${esc(targetTip)}">${mid(`${ic(a.envMode === "worktree" ? "branch" : "folder")}${target}`, "dz-to")}${greek(greekW(target, 5.4, 70) + 12, "r")}</span>
      </div>
    </div>`;
  }

  function tileHtml(p, t) {
    const w = t.w;
    const title = w.main ? (w.branch ? "Main checkout" : "Folder") : w.branch;
    const right = w.origin
      ? originMark(p, w)
      : w.main && w.branch
        ? `<span class="dz-branch mono">${esc(w.branch)}</span>`
        : "";
    const factLine = (line) => {
      let gx = 0;
      const bars = line
        .map((f, i) => {
          const bw = greekW(f.label, 5.2, 150);
          const out = `<i class="dz-greek g-${f.tone}" style="width:${bw}px;left:${gx}px"></i>`;
          gx += bw + 7;
          return out;
        })
        .join("");
      return `<div class="dz-tile-f"><span class="dz-mid dz-facts">${line.map((f) => `<span class="fact f-${f.tone}">${esc(f.label)}</span>`).join("")}</span><span class="dz-bars">${bars}</span></div>`;
    };
    return `<div class="dz-tile">
      <div class="dz-tile-h">${ic(w.main ? "folder" : "branch")}<span class="dz-tile-t trunc ${w.main ? "" : "mono"}">${esc(title)}</span><span class="dz-sp"></span><span class="dz-tile-o">${right}</span></div>
      ${t.lines.length ? `<div class="dz-tile-fs">${t.lines.map(factLine).join("")}</div>` : ""}
    </div>`;
  }

  function rowHtml(row, ix) {
    const th = row.th;
    const by = th.by ? ix.automations.find((a) => a.id === th.by) : null;
    return `<div class="dz-row">
      <span class="dz-dot" data-tip=""></span>
      <span class="dz-row-t dz-mid trunc">${esc(th.title)}</span>${greek(greekW(th.title, 5.3, 140))}
      <span class="dz-sp"></span>
      ${by ? mid(ic("clock2"), "dz-by") : ""}
      <span class="dz-row-meta">${providerMark(th.provider)}<span class="dz-ago tnum"></span></span>
    </div>`;
  }

  /* ---------------------------------------------------------- inspector */
  function inspectorHtml(sel, L) {
    const all = L.all;
    if (sel.kind === "project") {
      const ix = all.find((x) => x.p.id === sel.id);
      if (!ix) return null;
      const p = ix.p;
      const active = ix.workspaces.filter((w) => !w.archived).length;
      return `<div class="dz-i-kind">${ic("folder")}Project</div>
        <div class="dz-i-title">${esc(p.name)}</div><div class="dz-i-sub ${p.repo ? "mono" : ""}">${esc(p.repo ?? "Local folder")}</div>
        <div class="dz-i-stats"><div><b>${ix.devices.length}</b><span>devices</span></div><div><b>${active}</b><span>workspaces</span></div><div><b>${ix.threads.filter((x) => x.status !== "archived").length}</b><span>threads</span></div></div>
        <div class="dz-i-sec"><h4>Checked out on</h4>
          ${ix.devices.map((d) => `<div class="dz-i-item" data-select="device:${d.checkout.id}">${ic(d.icon)}<span class="trunc">${esc(d.name)}</span><span class="dim mono trunc dz-i-r">${esc(d.checkout.path)}</span></div>`).join("")}</div>
        ${
          ix.automations.length
            ? `<div class="dz-i-sec"><h4>Automations</h4>${ix.automations
                .map(
                  (a) =>
                    `<div class="dz-i-item" data-select="auto:${a.id}">${ic("clock2")}<span class="trunc">${esc(a.title)}</span><span class="dim dz-i-r">${esc(DEVICES[a.device].name)} · ${chipState(a) === "due" ? '<span class="dz-i-warn">due</span>' : a.enabled ? esc(inLabel(a.nextIn)) : "paused"}</span></div>`,
                )
                .join("")}</div>`
            : ""
        }
        <div class="dz-i-actions"><button class="dz-i-btn primary">${ic("plus")}New thread</button>${p.repo ? `<button class="dz-i-btn">${ic("pr")}Pull requests</button>` : ""}</div>`;
    }
    if (sel.kind === "device") {
      const ix = all.find((x) => x.devices.some((d) => d.checkout.id === sel.id));
      const d = ix?.devices.find((x) => x.checkout.id === sel.id);
      if (!d) return null;
      const conn = d.self
        ? "This device"
        : d.conn === "online"
          ? "Online"
          : d.conn === "connecting"
            ? "Connecting…"
            : "Offline";
      return `<div class="dz-i-kind">${ic(d.icon)}Device · ${esc(ix.p.name)} checkout</div>
        <div class="dz-i-title">${esc(d.name)}</div><div class="dz-i-sub"><span class="dz-i-conn c-${d.self ? "self" : d.conn}"><i></i>${conn}</span>${d.via ? ` · via ${esc(d.via)}` : ""}</div>
        <dl class="dz-i-rows"><dt>Folder</dt><dd class="mono">${esc(d.checkout.path)}</dd><dt>System</dt><dd>${esc(d.os)}</dd>
          <dt>Git</dt><dd>${d.checkout.git === false ? "Not a repository" : `${d.checkout.workspaces.length - 1} worktree${d.checkout.workspaces.length === 2 ? "" : "s"} + main checkout`}</dd></dl>
        ${
          d.checkout.automations?.length
            ? `<div class="dz-i-sec"><h4>Runs these automations</h4>${d.checkout.automations
                .map(
                  (a) =>
                    `<div class="dz-i-item" data-select="auto:${a.id}">${ic("clock2")}<span class="trunc">${esc(a.title)}</span><span class="dim tnum dz-i-r">${chipState(a) === "due" ? '<span class="dz-i-warn">due</span>' : a.enabled ? esc(inLabel(a.nextIn)) : "Paused"}</span></div>`,
                )
                .join("")}</div>`
            : ""
        }
        <div class="dz-i-sec"><h4>Workspaces</h4>
          ${d.checkout.workspaces.map((w) => `<div class="dz-i-item" data-select="ws:${w.id}">${ic(w.main ? "folder" : "branch")}<span class="trunc ${w.main ? "" : "mono"}">${esc(w.main ? (w.branch ? "Main checkout" : "Folder") : w.branch)}</span>${originMark(ix.p, w)}</div>`).join("")}</div>
        <div class="dz-i-actions">${d.checkout.git === false ? "" : `<button class="dz-i-btn">${ic("branch")}New worktree</button>`}<button class="dz-i-btn">${ic("clock2")}New automation</button></div>`;
    }
    if (sel.kind === "ws") {
      const ix = all.find((x) => x.workspaces.some((w) => w.id === sel.id));
      const w = ix?.workspaces.find((x) => x.id === sel.id);
      if (!w) return null;
      const p = ix.p;
      const d = DEVICES[w.device];
      const pr = w.origin?.kind === "pr" ? p.prs[w.origin.ref] : null;
      const twins =
        w.branch && !w.main ? (ix.byBranch[w.branch] ?? []).filter((x) => x.id !== w.id) : [];
      return `<div class="dz-i-kind">${ic(w.main ? "folder" : "branch")}${w.main ? "Main checkout" : "Worktree"}${w.archived ? " · archived" : ""}</div>
        <div class="dz-i-title ${w.main ? "" : "mono"}">${esc(w.main ? (w.branch ?? "Folder") : w.branch)}</div>
        <div class="dz-i-sub">${factsHtml(w) || "Clean and up to date"}</div>
        <dl class="dz-i-rows">
          <dt>Device</dt><dd><span class="dz-i-link" data-select="device:${w.checkoutId}">${esc(d.name)}</span></dd>
          <dt>Path</dt><dd class="mono">${esc(w.path)}</dd>
          ${pr ? `<dt>From</dt><dd>${originMark(p, w)} ${esc(pr.title)} · <span class="dim">${pr.state}, checks ${pr.checks}</span></dd>` : w.origin ? `<dt>From</dt><dd>${originMark(p, w)}</dd>` : ""}
          ${twins.length ? `<dt>Also on</dt><dd>${twins.map((x) => `<span class="dz-i-link" data-select="ws:${x.id}">${esc(DEVICES[x.device].name)}</span>`).join(", ")}</dd>` : ""}
        </dl>
        <div class="dz-i-sec"><h4>Threads</h4>
          ${w.threads.length ? w.threads.map((th) => `<div class="dz-i-item" data-select="thread:${th.id}">${statusDot(th.status)}<span class="trunc">${esc(th.title)}</span><span class="dim tnum dz-i-r">${agoLabel(th.ago)}</span></div>`).join("") : '<div class="dim">No threads yet.</div>'}</div>
        <div class="dz-i-actions">
          ${w.checkoutRemoved ? `<button class="dz-i-btn">${ic("folderMinus")}Recreate checkout…</button>` : `<button class="dz-i-btn primary">${ic("plus")}New thread</button>`}
          ${w.main ? "" : w.archived ? `<button class="dz-i-btn">${ic("archive")}Restore</button>` : `<button class="dz-i-btn">${ic("archive")}Archive</button>`}
          ${w.main || w.checkoutRemoved ? "" : `<button class="dz-i-btn danger">${ic("folderMinus")}Remove checkout…</button>`}
        </div>`;
    }
    if (sel.kind === "auto") {
      const ix = all.find((x) => x.automations.some((a) => a.id === sel.id));
      const a = ix?.automations.find((x) => x.id === sel.id);
      if (!a) return null;
      const st = chipState(a);
      return `<div class="dz-i-kind">${ic("clock2")}Automation${a.enabled ? "" : " · paused"}</div>
        <div class="dz-i-title">${esc(a.title)}</div>
        <div class="dz-i-sub">${esc(scheduleLabel(a))}</div>
        ${st === "due" ? `<div class="dz-i-due">${ic("shield")}<span>A run is due and waits for your approval.</span><button class="dz-i-btn primary" data-approve-id="${a.id}">Approve</button><button class="dz-i-btn">Reject</button></div>` : ""}
        <dl class="dz-i-rows">
          <dt>Runs on</dt><dd><span class="dz-i-link" data-select="device:${a.checkoutId}">${esc(DEVICES[a.device].name)}</span> <span class="dim">· ${esc(ix.p.name)}</span></dd>
          <dt>Next run</dt><dd>${st === "due" ? "Now, after approval" : st === "running" ? "Running now" : a.enabled ? esc(inLabel(a.nextIn)) : "Paused"}</dd>
          <dt>Starts</dt><dd>${a.envMode === "worktree" ? `A thread in a new worktree off <span class="mono">${esc(a.baseRef ?? "main")}</span>` : "A thread in the main checkout"}</dd>
          <dt>Agent</dt><dd>${providerMark(a.provider)} ${PROVIDERS[a.provider]?.name ?? a.provider}</dd>
        </dl>
        <div class="dz-i-sec"><h4>Recent runs</h4>
          ${a.runs.length ? a.runs.map((r) => `<div class="dz-i-item" ${r.threads[0] ? `data-select="thread:${r.threads[0]}"` : ""}><span class="dz-i-run r-${r.status}"></span><span class="trunc">${RUN_STATUS[r.status]?.label ?? r.status}${r.detail ? ` · <span class="dim">${esc(r.detail)}</span>` : ""}</span><span class="dim tnum dz-i-r">${agoLabel(r.ago)}</span></div>`).join("") : '<div class="dim">No runs yet.</div>'}</div>
        <div class="dz-i-actions"><button class="dz-i-btn">${ic("play")}Run now</button><button class="dz-i-btn">${a.enabled ? ic("pause") + "Pause" : ic("play") + "Resume"}</button><button class="dz-i-btn">${ic("edit")}Edit</button></div>`;
    }
    if (sel.kind === "thread") {
      const ix = all.find((x) => x.threads.some((t) => t.id === sel.id));
      const th = ix?.threads.find((x) => x.id === sel.id);
      if (!th) return null;
      const w = ix.workspaces.find((x) => x.id === th.workspaceId);
      return `<div class="dz-i-kind">${statusDot(th.status)}Thread · ${STATUS[th.status].label}</div>
        <div class="dz-i-title">${esc(th.title)}</div>
        <dl class="dz-i-rows">
          <dt>Agent</dt><dd>${providerMark(th.provider)} ${PROVIDERS[th.provider]?.name ?? th.provider}</dd>
          <dt>Workspace</dt><dd><span class="dz-i-link ${w.main ? "" : "mono"}" data-select="ws:${w.id}">${esc(w.main ? "Main checkout" : w.branch)}</span></dd>
          <dt>Device</dt><dd><span class="dz-i-link" data-select="device:${w.checkoutId}">${esc(DEVICES[th.device].name)}</span></dd>
          <dt>Activity</dt><dd>${th.ago < 1 ? "Just now" : `${agoLabel(th.ago)} ago`}</dd>
          ${th.by ? `<dt>Started by</dt><dd><span class="dz-i-link" data-select="auto:${th.by}">${esc(ix.automations.find((a) => a.id === th.by)?.title ?? "an automation")}</span></dd>` : ""}
        </dl>
        <div class="dz-i-actions"><button class="dz-i-btn primary">${ic("open")}Open thread</button></div>`;
    }
    return null;
  }

  /* ---------------------------------------------------------- mount */
  function mount(host, apiRef) {
    const params = new URLSearchParams(location.search);
    const state = {
      L: null,
      hover: null,
      projectId: S.projectId,
      selKey: null,
      sigs: new Map(),
      sizes: new Map(),
      first: true,
      path: null,
      crumbKeys: [],
      mm: new Map(),
    };
    host.classList.add("dz");
    const vp = createViewport(host, {
      minZoom: 0.3,
      maxZoom: 2.4,
      onFit: () => go({ level: "all" }),
      onBackgroundClick: (e) => groundClick(e),
    });
    vp.controls();

    /* Layers, back to front: regions, islands, wires, tiles + chips, thread rows. */
    const layer = (cls) => {
      const el = h("div", `dz-layer ${cls}`);
      vp.nodes.append(el);
      return el;
    };
    const Lreg = layer("dz-l-reg");
    const Lisl = layer("dz-l-isl");
    const wires = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    wires.setAttribute("class", "vp-edges dz-wires");
    wires.setAttribute("overflow", "visible");
    vp.nodes.append(wires);
    const Ltile = layer("dz-l-tile");
    const Lrow = layer("dz-l-row");

    const minimap = createMinimap(vp, () => state.mm, { width: 150, height: 96 });
    minimap.el.classList.add("dz-mm");
    const insp = createInspector(host, { onClose: () => apiRef.select(null) });
    const crumbs = h("nav", "vp-ui dz-crumbs");
    crumbs.setAttribute("aria-label", "Zoom path");
    host.append(crumbs);
    const legend = h(
      "div",
      "vp-ui legend dz-legend",
      `<span><svg width="22" height="6"><path d="M1 3h20" stroke="var(--violet)" stroke-dasharray="3 4" stroke-width="1.5"/></svg>Same branch</span><span><svg width="22" height="6"><path d="M1 3h20" stroke="var(--teal)" stroke-dasharray="1 4" stroke-linecap="round" stroke-width="2"/></svg>Started by automation</span>`,
    );
    host.append(legend);

    /* ------------------------------------------------ zoom → detail */
    function onCam(cam) {
      const far = 1 - smooth(LOD.farFull, LOD.farNone, cam.k);
      const md = smooth(LOD.midNone, LOD.midFull, cam.k);
      const nr = smooth(LOD.nearNone, LOD.nearFull, cam.k);
      host.style.setProperty("--dz-far", far.toFixed(3));
      host.style.setProperty("--dz-mid", md.toFixed(3));
      host.style.setProperty("--dz-near", nr.toFixed(3));
      host.style.setProperty("--dz-up", clamp(LOD.farNone / cam.k, 1, 2.6).toFixed(3));
      const lod = far > 0.5 ? "far" : nr > 0.5 ? "near" : "mid";
      if (host.dataset.lod !== lod) {
        host.dataset.lod = lod;
        lodTips();
      }
      schedulePath();
    }
    /* Before the text resolves (far), hovering a silhouette peeks at it. */
    function lodTips() {
      const peek = host.dataset.lod === "far";
      for (const layerEl of [Ltile, Lrow])
        for (const rec of layerEl._nodes?.values() ?? []) {
          const card = rec.el.firstElementChild;
          const tip = rec.el._data?.peek;
          if (!card || !tip) continue;
          if (peek && card.dataset.tip !== tip) card.dataset.tip = tip;
          else if (!peek && card.dataset.tip) delete card.dataset.tip;
        }
    }
    /* The canvas host clips (overflow: hidden) but can still be scrolled by
       focus or scrollIntoView, which would offset the whole camera. */
    const unscroll = () => {
      if (host.scrollTop || host.scrollLeft) host.scrollTop = host.scrollLeft = 0;
    };
    host.addEventListener("scroll", unscroll);
    vp.onChange(onCam);

    /* ------------------------------------------------ camera */
    let flight = null;
    function cancelFlight() {
      if (!flight) return;
      cancelAnimationFrame(flight.raf);
      flight = null;
    }
    const inspOpen = () => !!S.selected;
    function view(withInsp) {
      const W = host.clientWidth;
      const H = host.clientHeight;
      return { x: 0, y: TOP, w: W - (withInsp ? INSP_W : 0), h: H - TOP - 6 };
    }
    /* Camera that fits world box b into the visible area (left of the inspector). */
    function cameraFor(b, o = {}) {
      const v = view(o.insp ?? inspOpen());
      const pad = o.pad ?? 40;
      const aw = Math.max(80, v.w - pad * 2);
      const ah = Math.max(80, v.h - pad * 2);
      const k = clamp(Math.min(aw / b.w, ah / b.h), o.minK ?? 0.3, o.maxK ?? 1);
      const sx = v.x + v.w / 2;
      const sy = v.y + v.h / 2;
      let cx = b.x + b.w / 2;
      let cy = b.y + b.h / 2;
      if (b.w * k > aw + 1) cx = b.x + aw / 2 / k; // too wide: align its left edge
      if (b.h * k > ah + 1) cy = b.y + (ah / 2 - 4) / k; // too tall: align its top
      return { k, x: sx - cx * k, y: sy - cy * k };
    }
    /* Fly: the point under the view centre glides while zoom eases in log space;
       long hops dip out a little first (map-style), short ones just settle. */
    function fly(target, o = {}) {
      cancelFlight();
      if (!motion || o.instant) {
        vp.setCamera(target);
        o.done?.();
        return;
      }
      const W = host.clientWidth;
      const H = host.clientHeight;
      const ax = W / 2;
      const ay = H / 2;
      const c = vp.cam;
      const k0 = c.k;
      const k1 = target.k;
      const w0 = { x: (ax - c.x) / k0, y: (ay - c.y) / k0 };
      const w1 = { x: (ax - target.x) / k1, y: (ay - target.y) / k1 };
      const dist = (Math.hypot(w1.x - w0.x, w1.y - w0.y) * Math.min(k0, k1)) / W;
      const dip = dist > 0.55 ? Math.min(0.75, Math.log(1 + dist) * 0.6) : 0;
      const span = Math.abs(Math.log(k1 / k0));
      const dur =
        o.duration ?? clamp(520 + 300 * (span + Math.min(dist, 2) * 0.6 + dip), 560, 1180);
      const ease = dip > 0 ? easeInOutCubic : easeOutQuart;
      const t0 = performance.now();
      const l0 = Math.log(k0);
      const l1 = Math.log(k1);
      const step = (now) => {
        const p = Math.min(1, (now - t0) / dur);
        const e = ease(p);
        const k = Math.exp(l0 + (l1 - l0) * e - dip * 4 * e * (1 - e));
        const wx = w0.x + (w1.x - w0.x) * e;
        const wy = w0.y + (w1.y - w0.y) * e;
        vp.setCamera({ k, x: ax - wx * k, y: ay - wy * k });
        if (p < 1) flight = { raf: requestAnimationFrame(step) };
        else {
          flight = null;
          o.done?.();
        }
      };
      flight = { raf: requestAnimationFrame(step) };
    }
    host.addEventListener("pointerdown", cancelFlight, true);
    host.addEventListener("wheel", cancelFlight, { capture: true, passive: true });

    function allBounds() {
      const rs = state.L.regions;
      const x0 = Math.min(...rs.map((r) => r.x));
      const y0 = Math.min(...rs.map((r) => r.y));
      const x1 = Math.max(...rs.map((r) => r.x + r.w));
      const y1 = Math.max(...rs.map((r) => r.y + r.h));
      return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    }
    /* The bands are tuned on the inspector-free overview, so opening the
       inspector never shifts what "far" means. */
    function overviewCam() {
      const base = cameraFor(allBounds(), { pad: 40, maxK: 0.66, insp: false });
      tuneFar(base.k);
      return inspOpen() ? cameraFor(allBounds(), { pad: 40, maxK: 0.66 }) : base;
    }
    /* Navigate to a zoom level: { level: all | project | device | item, id }.
       A project never drops below the zoom where its text reads; if it is
       wider than the space left of the inspector it aligns left instead. */
    function go(path, o = {}) {
      const R = state.L.rects;
      let cam;
      if (path.level === "all") cam = overviewCam();
      else if (path.level === "project")
        cam = cameraFor(R.get(`r:${path.id}`), {
          pad: 30,
          minK: Math.min(0.9, LOD.midFull + 0.04),
          maxK: 0.9,
        });
      else if (path.level === "device")
        cam = cameraFor(R.get(`i:${path.id}`), { pad: 24, minK: 1.05, maxK: 1.35 });
      else if (path.level === "item")
        cam = cameraFor(R.get(path.key), { pad: 64, minK: 1.1, maxK: 1.3 });
      if (!cam) return;
      fly(cam, o);
    }

    /* Keep an item in view (left of the inspector, below the crumbs). Where
       its text already reads this only pans; from far away it flies close. */
    function reveal(key) {
      const r = state.L.rects.get(key);
      if (!r) return;
      const k = vp.cam.k;
      if (k < LOD.midFull && !key.startsWith("r:") && !key.startsWith("i:")) {
        go({ level: "item", key });
        return;
      }
      const v = view(true);
      const sx = r.x * k + vp.cam.x;
      const sy = r.y * k + vp.cam.y;
      let dx = 0;
      let dy = 0;
      const right = v.w - 24;
      if (sx + r.w * k > right) dx = right - (sx + r.w * k);
      if (sx + dx < 24) dx = 24 - sx;
      if (sy < TOP + 16) dy = TOP + 16 - sy;
      if (sy + r.h * k > v.y + v.h - 60) dy = v.y + v.h - 60 - (sy + r.h * k);
      if (dx || dy) fly({ k, x: vp.cam.x + dx, y: vp.cam.y + dy });
    }

    /* ------------------------------------------------ zoom path (breadcrumb) */
    function pathFromCamera() {
      const L = state.L;
      if (!L) return null;
      const k = vp.cam.k;
      if (k < LOD.project) return { level: "all" };
      const v = view(inspOpen());
      const c = vp.toWorld(
        host.getBoundingClientRect().left + v.x + v.w / 2,
        host.getBoundingClientRect().top + v.y + v.h / 2,
      );
      const near = (list) => {
        let best = null;
        let bd = Infinity;
        for (const r of list) {
          const dx = Math.max(r.x - c.x, 0, c.x - (r.x + r.w));
          const dy = Math.max(r.y - c.y, 0, c.y - (r.y + r.h));
          const dd = dx * dx + dy * dy;
          if (dd < bd) {
            bd = dd;
            best = r;
          }
        }
        return best;
      };
      const reg = near(L.regions);
      if (!reg) return { level: "all" };
      if (k < LOD.device) return { level: "project", id: reg.p.id, reg };
      const isl = near(reg.islands);
      return isl
        ? { level: "device", id: isl.c.id, reg, isl }
        : { level: "project", id: reg.p.id, reg };
    }
    let pathRaf = 0;
    let settleTimer = 0;
    function schedulePath() {
      if (pathRaf) return;
      pathRaf = requestAnimationFrame(() => {
        pathRaf = 0;
        const path = pathFromCamera();
        if (!path) return;
        const sig = `${path.level}:${path.id ?? ""}`;
        if (sig !== state.pathSig) {
          state.path = path;
          state.pathSig = sig;
          paintCrumbs();
        }
        clearTimeout(settleTimer);
        settleTimer = setTimeout(settle, 380);
      });
    }
    /* Once the camera rests inside another project, the app follows it. */
    function settle() {
      if (flight) return;
      const p = state.path;
      if (!p || p.level === "all" || p.reg.p.id === S.projectId) return;
      S.projectId = p.reg.p.id;
      state.projectId = S.projectId;
      if (typeof renderBar === "function") renderBar();
      emit();
    }

    function paintCrumbs() {
      const p = state.path ?? { level: "all" };
      const items = [{ key: "all", html: `${ic("map")}<span>All projects</span>`, nav: "all" }];
      if (p.level !== "all")
        items.push({
          key: `p:${p.reg.p.id}`,
          html: `<span class="pav" style="--hue:${p.reg.p.hue}">${esc(p.reg.p.name[0].toUpperCase())}</span><span>${esc(p.reg.p.name)}</span>`,
          nav: `project:${p.reg.p.id}`,
        });
      if (p.level === "device")
        items.push({
          key: `d:${p.isl.c.id}`,
          html: `${ic(p.isl.d.icon)}<span>${esc(p.isl.d.name)}</span>`,
          nav: `device:${p.isl.c.id}`,
        });
      const hint =
        p.level === "all"
          ? "Click a project to fly in"
          : p.level === "project"
            ? "Click a device to zoom in"
            : "";
      const prev = new Set(state.crumbKeys);
      crumbs.innerHTML = `<div class="dz-cb">${items
        .map(
          (it, i) =>
            `${i ? '<span class="dz-crumb-sep">' + ic("chevR") + "</span>" : ""}<button type="button" class="dz-crumb ${i === items.length - 1 ? "is-current" : ""}" data-crumb="${it.nav}" data-k="${it.key}">${it.html}</button>`,
        )
        .join("")}${hint ? `<span class="dz-hint">${hint}</span>` : ""}</div>`;
      if (motion && !state.first)
        for (const b of $$(".dz-crumb", crumbs))
          if (!prev.has(b.dataset.k)) {
            const sep = b.previousElementSibling;
            for (const el of [sep, b].filter(Boolean))
              el.animate(
                [
                  { opacity: 0, translate: "-8px 0" },
                  { opacity: 1, translate: "0 0" },
                ],
                { duration: 380, easing: EASE },
              );
          }
      const hintEl = $(".dz-hint", crumbs);
      if (hintEl && motion)
        hintEl.animate([{ opacity: 0 }, { opacity: 1 }], {
          duration: 500,
          delay: 200,
          easing: EASE,
          fill: "backwards",
        });
      state.crumbKeys = items.map((x) => x.key);
    }
    crumbs.addEventListener("click", (e) => {
      const b = e.target.closest("[data-crumb]");
      if (!b) return;
      const [level, id] = b.dataset.crumb.split(":");
      if (level === "project") {
        followProject(id);
      }
      go({ level, id });
    });

    function followProject(id) {
      if (S.projectId === id) return;
      S.projectId = id;
      state.projectId = id;
      if (typeof renderBar === "function") renderBar();
      emit();
    }

    /* ------------------------------------------------ hit testing + clicks */
    const pathLevelOf = (key) => {
      const p = state.path;
      if (!p) return false;
      if (key.startsWith("r:")) return p.level === "project" && `r:${p.id}` === key;
      if (key.startsWith("i:")) return p.level === "device" && `i:${p.id}` === key;
      return false;
    };
    function hitGround(clientX, clientY) {
      const L = state.L;
      if (!L) return null;
      const pt = vp.toWorld(clientX, clientY);
      const inside = (r) => pt.x >= r.x && pt.x <= r.x + r.w && pt.y >= r.y && pt.y <= r.y + r.h;
      for (const reg of L.regions) {
        if (!inside(reg)) continue;
        const isl = reg.islands.find(inside);
        return isl ? { key: isl.key, reg, isl } : { key: reg.key, reg };
      }
      return null;
    }
    /* Ground (regions and islands) is click-through for panning; clicks
       resolve here: first click flies there, a click on the level you are
       already at inspects it. */
    function groundClick(e) {
      const hit = hitGround(e.clientX, e.clientY);
      if (!hit) {
        if (S.selected) apiRef.select(null);
        return;
      }
      activate(hit.key);
    }
    /* Selections made on the canvas move the camera themselves. */
    function selectHere(sel) {
      state.localSel = true;
      try {
        apiRef.select(sel);
      } finally {
        state.localSel = false;
      }
    }
    function activate(key) {
      if (key.startsWith("r:")) {
        const id = key.slice(2);
        if (pathLevelOf(key)) {
          selectHere({ kind: "project", id });
          return;
        }
        if (S.selected) selectHere(null);
        followProject(id);
        go({ level: "project", id });
        return;
      }
      if (key.startsWith("i:")) {
        const id = key.slice(2);
        if (pathLevelOf(key)) {
          if (!(S.selected?.kind === "device" && S.selected.id === id))
            selectHere({ kind: "device", id });
          return;
        }
        if (S.selected && S.selected.kind !== "device") selectHere(null);
        const reg = state.L.regions.find((r) => r.islands.some((i) => i.key === key));
        if (reg) followProject(reg.p.id);
        go({ level: "device", id });
        return;
      }
      const kind = KIND[key[0]];
      const id = key.slice(2);
      const same = S.selected?.kind === kind && S.selected.id === id;
      selectHere({ kind, id });
      if (same) return;
      const reg = state.L.regions.find((r) =>
        r.islands.some(
          (i) => state.L.parent[key] === i.key || state.L.parent[state.L.parent[key]] === i.key,
        ),
      );
      if (reg) followProject(reg.p.id);
      if (kind === "ws") go({ level: "item", key });
      else requestAnimationFrame(() => reveal(key));
    }

    /* Press on any card: drag pans (maps feel), a still press is a click. */
    let press = null;
    vp.nodes.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      const n = e.target.closest(".node");
      if (!n) return;
      e.stopPropagation();
      press = {
        x: e.clientX,
        y: e.clientY,
        cx: vp.cam.x,
        cy: vp.cam.y,
        moved: false,
        target: e.target,
        key: n.dataset.key,
        id: e.pointerId,
      };
    });
    const onMove = (e) => {
      if (!press) {
        hoverGround(e);
        return;
      }
      const dx = e.clientX - press.x;
      const dy = e.clientY - press.y;
      if (!press.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
      if (!press.moved) {
        press.moved = true;
        host.classList.add("is-panning");
        Tip.hide();
      }
      vp.setCamera({ x: press.cx + dx, y: press.cy + dy });
    };
    const onUp = () => {
      const p = press;
      press = null;
      host.classList.remove("is-panning");
      if (!p || p.moved) return;
      const ap = p.target.closest?.("[data-approve]");
      if (ap) {
        approve(ap.dataset.approve);
        return;
      }
      activate(p.key);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);

    /* Ground hover: the island / region under the pointer lights up. */
    let groundHover = null;
    function hoverGround(e) {
      if (!host.contains(e.target) || e.target.closest(".vp-ui")) return setGroundHover(null);
      const onCard = e.target.closest(".dz-l-tile .node, .dz-l-row .node");
      const hit = onCard ? null : hitGround(e.clientX, e.clientY);
      setGroundHover(
        hit && !pathLevelOf(hit.key) ? hit.key : hit && hit.key.startsWith("i:") ? hit.key : null,
      );
    }
    function setGroundHover(key) {
      if (key === groundHover) return;
      const store = (k) => (k?.startsWith("r:") ? Lreg._nodes : Lisl._nodes)?.get(k)?.el;
      store(groundHover)?.classList.remove("is-hover");
      groundHover = key;
      store(key)?.classList.add("is-hover");
      host.classList.toggle("dz-ground-hover", !!key);
    }

    /* Card hover lights relations (automation ↔ its threads, branch twins). */
    vp.nodes.addEventListener("pointerover", (e) => {
      const n = e.target.closest(".dz-l-tile .node, .dz-l-row .node");
      const key = n?.dataset.key ?? null;
      if (key === state.hover || press?.moved) return;
      state.hover = key;
      render({ light: true });
    });
    vp.nodes.addEventListener("pointerleave", () => {
      if (!state.hover) return;
      state.hover = null;
      render({ light: true });
    });

    /* Approving a due run starts it now (the lab advances it in place). The
       simulation's own approval of run r6 (0:09) adds thread t18; starting
       that same thread here means the script finds it already there and
       later completes it, instead of leaving a second, orphaned thread. */
    const SCRIPTED_RUN_THREAD = { r6: ["t18", "Triage: 2 new issues"] };
    function approve(aid) {
      for (const p of S.projects)
        for (const c of p.checkouts)
          for (const a of c.automations ?? []) {
            const run = a.id === aid && activeRun(a);
            if (!run || run.status !== "pending-approval") continue;
            const ws = c.workspaces.find((w) => w.main);
            const [tid, title] = SCRIPTED_RUN_THREAD[run.id] ?? [
              `t-${run.id}`,
              `${a.title}: run ${a.runs.length}`,
            ];
            const thread = t(tid, title, "working", a.provider, 0, a.id);
            run.status = "executing";
            run.threads = [thread.id];
            if (ws && !ws.threads.some((x) => x.id === thread.id)) ws.threads.unshift(thread);
            lastEvent = `Run approved: ${a.title}`;
          }
      emit();
    }

    insp.panel.addEventListener("click", (e) => {
      const ap = e.target.closest("[data-approve-id]");
      if (ap) {
        approve(ap.dataset.approveId);
        return;
      }
      const tg = e.target.closest("[data-select]");
      if (!tg) return;
      const [kind, id] = tg.dataset.select.split(":");
      const key = `${PREFIX[kind]}:${id}`;
      selectHere({ kind, id });
      if (kind === "device") go({ level: "device", id });
      else if (kind === "ws") go({ level: "item", key });
      else requestAnimationFrame(() => reveal(key));
    });

    /* Escape with nothing selected climbs one zoom level. Capture phase, so
       it runs before the app clears a selection. */
    const onKey = (e) => {
      if (e.key !== "Escape" || S.selected) return;
      const p = state.path;
      if (!p || p.level === "all") return;
      if (p.level === "device") go({ level: "project", id: p.reg.p.id });
      else go({ level: "all" });
    };
    document.addEventListener("keydown", onKey, true);

    /* ------------------------------------------------ render */
    function related(key, L) {
      const lit = new Set();
      if (!key) return lit;
      lit.add(key);
      for (const ix of L.all)
        for (const a of ix.automations)
          for (const run of a.runs)
            for (const tid of run.threads) {
              if (key === `a:${a.id}`) {
                lit.add(`t:${tid}`);
                const th = ix.threads.find((x) => x.id === tid);
                if (th) lit.add(`w:${th.workspaceId}`);
              }
              if (key === `t:${tid}`) lit.add(`a:${a.id}`);
            }
      if (key.startsWith("w:"))
        for (const reg of L.regions)
          for (const isl of reg.islands)
            for (const tl of isl.tiles)
              if (tl.key === key) for (const tw of tl.twins) lit.add(`w:${tw.id}`);
      return lit;
    }

    function ping(el, tone) {
      if (!motion || !el) return;
      const card = el.firstElementChild;
      if (!card) return;
      card.style.setProperty("--ping", `var(--${tone})`);
      card.classList.remove("dz-ping");
      void card.offsetWidth;
      card.classList.add("dz-ping");
    }
    const toneVar = (s) =>
      ({
        working: "info",
        input: "warn-fill",
        error: "err-fill",
        done: "ok-fill",
        due: "warn-fill",
        running: "info",
        archived: "faint-fg",
        online: "ok-fill",
        connecting: "warn-fill",
      })[s] ?? "faint-fg";

    function sizeTo(store, key, w, hgt) {
      const rec = store.get(key);
      if (!rec) return;
      const prev = state.sizes.get(key);
      if (prev && prev.w === w && prev.h === hgt) return;
      rec.el.style.width = `${w}px`;
      rec.el.style.height = `${hgt}px`;
      state.sizes.set(key, { w, h: hgt });
    }
    const setText = (root, sel, text) => {
      const el = root.querySelector(sel);
      if (el && el.textContent !== text) el.textContent = text;
    };

    function render(o = {}) {
      const all = S.projects.map((p) => index(p));
      const L = layout(all);
      state.L = L;
      const sel = S.selected;
      const selKey = sel ? `${PREFIX[sel.kind]}:${sel.id}` : null;
      const lit = related(state.hover ?? selKey, L);
      const first = state.first;
      const noEnter = !!o.light;
      const sigs = new Map();
      const pings = [];
      const mark = (key, sig, tone) => {
        sigs.set(key, sig);
        const prev = state.sigs.get(key);
        if (!first && prev !== undefined && prev !== sig) pings.push([key, tone]);
      };

      /* Regions */
      const regItems = L.regions.map((r, i) => ({
        key: r.key,
        x: r.x,
        y: r.y,
        html: regionHtml(r),
        cls: `dz-n-reg ${r.key === selKey ? "is-selected" : ""} ${groundHover === r.key ? "is-hover" : ""}`,
      }));
      const regStore = syncNodes(Lreg, regItems, {
        noEnter,
        enter: (el, item, i) =>
          el.animate(
            [
              { opacity: 0, scale: "0.985" },
              { opacity: 1, scale: "1" },
            ],
            { duration: 620, delay: i * 70, easing: EASE, fill: "backwards" },
          ),
      });
      for (const r of L.regions) {
        sizeTo(regStore, r.key, r.w, r.h);
        const el = regStore.get(r.key)?.el;
        if (!el) continue;
        el.style.setProperty("--hue", r.p.hue);
        const sum = el.querySelector(".dz-sum");
        const html = summaryHtml(r.ix);
        if (sum && sum._html !== html) {
          sum.innerHTML = html;
          sum._html = html;
        }
        const nx = sum?.querySelector("[data-next]");
        if (nx)
          setText(
            nx,
            ".dz-sum-in",
            `Next run ${inLabel(r.ix.automations.find((a) => a.id === nx.dataset.next)?.nextIn)}`,
          );
      }

      /* Islands */
      const islItems = [];
      for (const r of L.regions)
        r.islands.forEach((isl, i) => {
          const conn = isl.d.self ? "self" : isl.d.conn;
          islItems.push({
            key: isl.key,
            x: isl.x,
            y: isl.y,
            html: islandHtml(isl),
            cls: `dz-n-isl c-${conn} ${isl.key === selKey ? "is-selected" : ""} ${groundHover === isl.key ? "is-hover" : ""}`,
          });
          mark(isl.key, conn, toneVar(conn));
        });
      const islStore = syncNodes(Lisl, islItems, {
        noEnter,
        enter: (el, item, i, delay) =>
          el.animate(
            [
              { opacity: 0, translate: "0 8px" },
              { opacity: 1, translate: "0 0" },
            ],
            { duration: 560, delay: first ? 120 + i * 45 : 60, easing: EASE, fill: "backwards" },
          ),
      });
      for (const r of L.regions)
        for (const isl of r.islands) {
          sizeTo(islStore, isl.key, isl.w, isl.h);
          const el = islStore.get(isl.key)?.el;
          if (el && !isl.d.self)
            setText(
              el,
              ".dz-conn-l",
              isl.d.conn === "online"
                ? "Online"
                : isl.d.conn === "connecting"
                  ? "Connecting"
                  : "Offline",
            );
        }

      /* Tiles + automation chips */
      const tileItems = [];
      let ti = 0;
      for (const r of L.regions)
        for (const isl of r.islands) {
          for (const c of isl.chips) {
            const st = chipState(c.a);
            tileItems.push({
              key: c.key,
              x: c.x,
              y: c.y,
              data: {
                peek: `${scheduleLabel(c.a)} · ${c.a.envMode === "worktree" ? "new worktree each run" : "runs in the main checkout"}`,
              },
              html: chipHtml(c.a, st),
              cls: `dz-n-chip st-${st} ${c.a.schedule.kind === "once" ? "once" : ""} ${c.key === selKey ? "is-selected" : ""} ${lit.has(c.key) ? "lit" : ""}`,
              i: ti++,
            });
            mark(c.key, st, toneVar(st));
          }
          for (const tl of isl.tiles) {
            const tone = tileTone(tl.w);
            tileItems.push({
              key: tl.key,
              x: tl.x,
              y: tl.y,
              html: tileHtml(r.p, tl),
              cls: `dz-n-tile tone-${tone} ${tl.w.main ? "main" : ""} ${tl.w.archived ? "archived" : ""} ${tl.w.fresh ? "fresh" : ""} ${tl.key === selKey ? "is-selected" : ""} ${lit.has(tl.key) && tl.key !== (state.hover ?? selKey) ? "lit" : ""}`,
              i: ti++,
            });
            mark(
              tl.key,
              `${tone}|${tl.facts.map((f) => f.label).join(",")}|${tl.w.archived}`,
              toneVar(tone === "quiet" ? "done" : tone),
            );
          }
        }
      const tileStore = syncNodes(Ltile, tileItems, {
        noEnter,
        enter: (el, item, i, delay) => {
          if (first)
            el.animate(
              [
                { opacity: 0, translate: "0 6px" },
                { opacity: 1, translate: "0 0" },
              ],
              { duration: 520, delay: 200 + item.i * 14, easing: EASE, fill: "backwards" },
            );
          /* Live: a new worktree unfolds out of its island. */ else
            el.animate(
              [
                { opacity: 0, clipPath: "inset(0 0 100% 0 round 11px)", translate: "0 -6px" },
                { opacity: 1, clipPath: "inset(0 0 0% 0 round 11px)", translate: "0 0" },
              ],
              { duration: 640, delay: 180, easing: EASE, fill: "backwards" },
            );
        },
      });
      for (const it of tileItems) {
        const r = L.rects.get(it.key);
        sizeTo(tileStore, it.key, r.w, r.h);
        if (!it.key.startsWith("a:")) continue;
        const rec = tileStore.get(it.key);
        const a = L.all.flatMap((x) => x.automations).find((x) => `a:${x.id}` === it.key);
        if (!rec || !a) continue;
        setText(rec.el, ".dz-next", a.enabled ? inLabel(a.nextIn) : "Paused");
        const prg = rec.el.querySelector(".prg");
        const st = chipState(a);
        const done = st === "due" || st === "running" ? 1 : a.enabled ? cycle(a) : 0;
        const off = (RING_C * (1 - done)).toFixed(2);
        if (prg && prg.style.strokeDashoffset !== off) prg.style.strokeDashoffset = off;
      }

      /* Thread rows */
      const rowItems = [];
      for (const r of L.regions)
        for (const isl of r.islands)
          for (const row of isl.rows) {
            rowItems.push({
              key: row.key,
              x: row.x,
              y: row.y,
              data: { peek: `${row.th.title} · ${STATUS[row.th.status]?.label ?? row.th.status}` },
              html: rowHtml(row, r.ix),
              cls: `dz-n-row s-${row.th.status} ${row.key === selKey ? "is-selected" : ""} ${lit.has(row.key) && row.key !== (state.hover ?? selKey) ? "lit" : ""}`,
              i: rowItems.length,
            });
            mark(row.key, row.th.status, toneVar(row.th.status));
          }
      const rowStore = syncNodes(Lrow, rowItems, {
        noEnter,
        enter: (el, item) => {
          if (first)
            el.animate([{ opacity: 0 }, { opacity: 1 }], {
              duration: 480,
              delay: 320 + item.i * 10,
              easing: EASE,
              fill: "backwards",
            });
          /* Live: a new thread wipes in from its dot. */ else
            el.animate(
              [
                { opacity: 0, clipPath: "inset(0 100% 0 0 round 7px)" },
                { opacity: 1, clipPath: "inset(0 0% 0 0 round 7px)" },
              ],
              { duration: 620, delay: 200, easing: EASE, fill: "backwards" },
            );
        },
      });
      for (const it of rowItems) {
        const rec = rowStore.get(it.key);
        const th = L.all.flatMap((x) => x.threads).find((x) => `t:${x.id}` === it.key);
        if (!rec || !th) continue;
        sizeTo(rowStore, it.key, G.tileW - 10, G.rowH);
        setText(rec.el, ".dz-ago", agoLabel(th.ago));
        const dot = rec.el.querySelector(".dz-dot");
        const tip = STATUS[th.status]?.label ?? th.status;
        if (dot && dot.dataset.tip !== tip) dot.dataset.tip = tip;
        const by = rec.el.querySelector(".dz-by");
        if (by && th.by)
          by.dataset.tip = `Started by ${L.all.flatMap((x) => x.automations).find((a) => a.id === th.by)?.title ?? "an automation"}`;
      }

      /* Wires: same branch on two devices (always, faint); automation → the
         threads its runs started (while running, or when either end is lit). */
      const R = L.rects;
      const edges = [];
      for (const reg of L.regions)
        for (const [branch, list] of Object.entries(reg.ix.shared)) {
          const sorted = list
            .map((w) => R.get(`w:${w.id}`))
            .filter(Boolean)
            .sort((a, b) => a.x - b.x);
          for (let i = 1; i < sorted.length; i++) {
            const a = sorted[i - 1];
            const b = sorted[i];
            const keys = list.map((w) => `w:${w.id}`);
            const hot = keys.some((k) => k === state.hover || k === selKey);
            edges.push({
              key: `same:${reg.p.id}:${branch}:${i}`,
              d: curve({ x: a.x + a.w, y: a.y + 20 }, { x: b.x, y: b.y + 20 }, "h", 0.6),
              cls: `dz-same ${hot ? "hot" : ""}`,
            });
          }
        }
      for (const reg of L.regions)
        for (const isl of reg.islands)
          for (const c of isl.chips)
            for (const run of c.a.runs)
              for (const tid of run.threads) {
                const tr = R.get(`t:${tid}`);
                const tileKey = L.parent[`t:${tid}`];
                const tile = R.get(tileKey);
                const cr = R.get(c.key);
                if (!tr || !tile || !cr) continue;
                const executing = run.status === "executing";
                const on = lit.has(c.key) && lit.has(`t:${tid}`);
                if (!executing && !on) continue;
                const gx = isl.x + 6;
                const y0 = cr.y + G.chipH / 2;
                const y1 = tr.y + G.rowH / 2;
                const rr = 6;
                const d = `M ${cr.x} ${y0} L ${gx + rr} ${y0} Q ${gx} ${y0} ${gx} ${y0 + rr} L ${gx} ${y1 - rr} Q ${gx} ${y1} ${gx + rr} ${y1} L ${tile.x} ${y1}`;
                edges.push({
                  key: `run:${c.a.id}>${tid}`,
                  d,
                  cls: `dz-run ${executing ? "flow" : ""} ${on ? "hot" : ""}`,
                });
              }
      /* Dotted wires draw in with a wipe along their direction (the core's
         dash-length draw-in would flatten the dots while it runs). */
      const before = new Set(wires._edges?.keys() ?? []);
      const wstore = syncEdges(wires, edges, { noEnter: true });
      if (motion && !first)
        for (const e of edges) {
          if (before.has(e.key)) continue;
          const el = wstore.get(e.key)?.el;
          const from = e.key.startsWith("run:") ? "inset(0 0 100% 0)" : "inset(0 100% 0 0)";
          el?.animate(
            [
              { clipPath: from, opacity: 0.4 },
              { clipPath: "inset(0 0 0% 0)", opacity: 1 },
            ],
            { duration: 560, delay: 60, easing: EASE, fill: "backwards" },
          );
        }

      /* Live changes ping in place, at any zoom. */
      for (const [key, tone] of pings) {
        const store = key.startsWith("i:") ? islStore : key.startsWith("t:") ? rowStore : tileStore;
        ping(store.get(key)?.el, tone);
      }
      state.sigs = sigs;

      /* Minimap: islands and cards. */
      const mm = new Map();
      for (const [k, rec] of islStore) mm.set(k, { ...L.rects.get(k), el: rec.el });
      for (const [k, rec] of tileStore)
        if (L.rects.get(k)) mm.set(k, { ...L.rects.get(k), el: rec.el });
      state.mm = mm;
      minimap.draw();
      lodTips();

      /* Inspector: only touch its DOM when the content really changed, so a
         tick never resets its hover, tooltips or scroll position. */
      const ihtml = sel ? inspectorHtml(sel, L) : null;
      const ikey = ihtml ? `${sel.kind}:${sel.id}` : null;
      if (!ihtml) {
        if (state.inspKey) insp.hide();
        state.inspKey = state.inspHtml = null;
      } else if (ikey !== state.inspKey || ihtml !== state.inspHtml) {
        insp.show(ikey, ihtml);
        state.inspKey = ikey;
        state.inspHtml = ihtml;
      }
      host.classList.toggle("dz-insp", !!ihtml);
    }

    /* ------------------------------------------------ boot */
    function initialPath() {
      const z = params.get("zoom");
      if (z === "all") return { level: "all" };
      if (z?.startsWith("device:")) return { level: "device", id: z.slice(7) };
      if (z?.startsWith("ws:")) return { level: "item", key: `w:${z.slice(3)}` };
      return { level: "project", id: S.projectId };
    }
    let introTimer = 0;
    function boot() {
      render();
      state.first = false;
      overviewCam();
      const target = initialPath();
      if (target.level === "all" || !motion) {
        go(target, { instant: true });
        onCam(vp.cam);
        return;
      }
      /* Establishing shot: open on every project, then fly into this one. */
      go({ level: "all" }, { instant: true });
      onCam(vp.cam);
      introTimer = setTimeout(() => go(target), 260);
    }

    let booted = false;
    return {
      update() {
        if (!booted) {
          booted = true;
          boot();
          state.selKey = S.selected ? `${S.selected.kind}:${S.selected.id}` : null;
          return;
        }
        render();
        /* The list chose another project: fly there instead of swapping scenes. */
        if (S.projectId !== state.projectId) {
          state.projectId = S.projectId;
          clearTimeout(introTimer);
          go({ level: "project", id: S.projectId });
        }
        /* Selection made elsewhere (URL, inspector): bring it into view. */
        const sk = S.selected ? `${S.selected.kind}:${S.selected.id}` : null;
        if (sk !== state.selKey) {
          const was = state.selKey;
          state.selKey = sk;
          if (sk && !state.localSel && S.selected.kind !== "project") {
            clearTimeout(introTimer);
            const sel = S.selected;
            const key = `${PREFIX[sel.kind]}:${sel.id}`;
            requestAnimationFrame(() => {
              if (flight || state.selKey !== sk) return;
              if (sel.kind === "device") go({ level: "device", id: sel.id });
              else if (sel.kind === "ws") go({ level: "item", key });
              else reveal(key);
            });
          }
        }
      },
      destroy() {
        clearTimeout(introTimer);
        clearTimeout(settleTimer);
        cancelFlight();
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        document.removeEventListener("keydown", onKey, true);
        vp.destroy();
      },
    };
  }

  DIRS.D = {
    title: "D · Zoom",
    thesis:
      "Every project on one canvas, read like a map. All the way out, <b>projects are regions</b> with live counts and each <b>device is an island</b> whose workspaces and schedules are named blocks tinted by what their threads are doing. At project zoom (where it opens) every card reads: threads, facts, schedules and where each run lands. Zoom into a device and agents, ages and folders join in. Geometry never changes with zoom, only detail resolves, so you always know where you are and nothing jumps.",
    notes: [
      [
        "Reading it",
        [
          "<b>Regions are projects</b>, <b>islands are devices</b> (the project's folder on that machine, with its connection), <b>cards are workspaces</b> (main checkout and worktrees, with the PR, issue or Jira item they came from), rows are threads.",
          "<b>Automations sit at the top of the island whose server runs them</b>, so “what runs where” is the first thing in each device. The ring fills toward the next run; a due run turns amber with an Approve pill; a running one spins and wires its new thread with a teal trail. <i>main</i> or <i>worktree</i> on the chip says whether a run lands in the main checkout or a new worktree.",
          "Far away, cards keep their names (scaled up like street names) and take the tint of their threads: blue working, amber needs input, red failed. Thread rows become silhouettes; hover one to peek at it.",
          "A dashed violet arc joins the same branch on two devices (the card says “Also on Studio” once). Dashed cards are archived, and a removed checkout keeps its card, marked “Checkout removed”. A dashed island is a device that is still connecting.",
        ],
      ],
      [
        "Moving around",
        [
          "Click a region or island to fly there, then click it again to inspect it. Cards inspect on the first click (a workspace also flies close); long hops ease out and back in like a map.",
          "The breadcrumb (All projects › ryco › Studio) follows the camera and takes you back up. <kbd>Esc</kbd> closes the inspector, then climbs one level. Picking a project in the list flies to its region, and resting the camera in another project selects it in the list.",
          "Drag anywhere to pan (cards too), ⌘-scroll or pinch to zoom, double-click empty canvas for the whole map. Inside a device a minimap shows where you are (it steps aside while you inspect).",
        ],
      ],
      [
        "Live",
        [
          "Changes ripple a hairline ring where they happen, sized to read at any zoom: from the overview, watch ryco-hub's pin-node card go dashed at 0:13.",
          "At 0:07 a worktree for #671 unfolds out of the Studio island while its neighbours glide down, and “Triage new issues” comes due. Approve it on the chip (or wait for 0:09) and its thread wipes into the main checkout, wired back to the schedule; it completes at 0:15.",
        ],
      ],
    ],
    mount,
  };
})();
