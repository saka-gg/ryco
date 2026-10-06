/* ============================================================
   B · Lanes — "where is what" as a matrix.
   Rows are devices (swimlanes), columns are branches, so the same
   branch on two devices lines up in ONE column. A cell is that
   device's workspace for the branch, or a faint slot where it is not
   checked out. Every lane opens with the automations its device
   runs. The device column and the branch header row stay pinned
   while you pan, like a spreadsheet's frozen panes.
   ============================================================ */
(() => {
  /* World geometry (px at 100%). */
  const G = {
    laneW: 140, // device header column
    autoW: 180, // automations column
    colW: 190, // one branch column
    gx: 10, // gap between branch columns
    gxA: 20, // gap before main (automation wires turn here)
    headH: 60, // branch header row
    padT: 12, // lane top padding
    padB: 18, // lane bottom padding (automation wires travel here)
    slotH: 40,
    laneMin: 70,
    chipGap: 8,
  };
  const CARD = { padT: 6, padB: 6, fact: 20, row: 26, sep: 8 };
  /* Automation chip: a one-line title is 94px tall, each extra title
     line adds LINE. The title wraps (max two lines) instead of
     truncating, so which automation runs where reads in full. */
  const CHIP = { base: 94, line: 17, titleW: 180 - 2 - 22 - 17 - 8 }; // width − border − padding − ring − gap
  const KMIN = 0.71; // the default fit never goes below this: text stays legible
  const KPAGE = 0.86; // and when it pages sideways, it never zooms past this
  const FIT = { top: 56, left: 14, right: 10, bottom: 58 };
  const STICK_TOP = 50; // branch headers pin just under the toolbar
  const INSP_W = 344;
  const LABEL_H = 78; // a lane header's own content (name, status, path)
  const RANK = { working: 0, input: 1, error: 2, done: 3, idle: 4, archived: 5 };
  const ACTIVE = ["pending-approval", "approved", "executing"];

  /* ---------------------------------------------------------- morph
     syncNodes swaps innerHTML when markup changes, which would cut
     every CSS transition. Nodes here get an empty shell from
     syncNodes and their content is morphed in place instead: keyed
     children ([data-k]) enter/exit, attributes change on the same
     element, so dots recolour, rows glide and rings tick smoothly. */
  const keyOf = (n) => (n.nodeType === 1 ? n.getAttribute("data-k") : null);
  const exiting = (n) => n.nodeType === 1 && n.hasAttribute("data-exiting");
  function morph(el, html, hooks) {
    const tpl = document.createElement("template");
    tpl.innerHTML = html.replace(/>\s+</g, "><").trim();
    syncKids(el, tpl.content, hooks);
  }
  function syncKids(parent, src, hooks) {
    const olds = [...parent.childNodes].filter((n) => !exiting(n));
    const keyed = new Map();
    const loose = [];
    for (const n of olds) {
      const k = keyOf(n);
      if (k != null) keyed.set(k, n);
      else loose.push(n);
    }
    const used = new Set();
    let li = 0;
    let prev = null;
    for (const nn of [...src.childNodes]) {
      const k = keyOf(nn);
      let m = null;
      if (k != null) {
        const c = keyed.get(k);
        if (c && c.nodeName === nn.nodeName && !used.has(c)) m = c;
      } else
        while (li < loose.length) {
          const c = loose[li++];
          if (c.nodeName === nn.nodeName) {
            m = c;
            break;
          }
        }
      let ref = prev ? prev.nextSibling : parent.firstChild;
      while (ref && exiting(ref)) ref = ref.nextSibling;
      if (m) {
        used.add(m);
        patch(m, nn, hooks);
        if (m !== ref) parent.insertBefore(m, ref);
      } else {
        parent.insertBefore(nn, ref);
        m = nn;
        if (hooks && k != null) hooks.enter?.(nn);
      }
      prev = m;
    }
    for (const n of olds) {
      if (used.has(n)) continue;
      if (hooks?.exit && keyOf(n) != null) {
        n.setAttribute("data-exiting", "");
        hooks
          .exit(n)
          .finished.then(() => n.remove())
          .catch(() => n.remove());
      } else n.remove();
    }
  }
  function patch(a, b, hooks) {
    if (a.nodeType !== 1) {
      if (a.nodeValue !== b.nodeValue) a.nodeValue = b.nodeValue;
      return;
    }
    for (const { name } of [...a.attributes]) if (!b.hasAttribute(name)) a.removeAttribute(name);
    for (const { name, value } of [...b.attributes]) {
      const before = a.getAttribute(name);
      if (before !== value) {
        a.setAttribute(name, value);
        hooks?.attr?.(a, name, before, value);
      }
    }
    syncKids(a, b, hooks);
  }
  const HOOKS = {
    enter: (el) =>
      el.animate(
        [
          { opacity: 0, translate: "0 -5px" },
          { opacity: 1, translate: "0 0" },
        ],
        { duration: 420, delay: 160, easing: EASE, fill: "backwards" },
      ),
    exit: (el) =>
      el.animate([{ opacity: 1 }, { opacity: 0 }], {
        duration: 200,
        easing: "ease-in",
        fill: "forwards",
      }),
    /* A status change pops the dot as it recolours. */
    attr(el, name, before, after) {
      if (name === "class" && el.classList.contains("sdot") && before !== after)
        el.animate([{ scale: "2" }, { scale: "1" }], { duration: 620, easing: SNAPPY });
    },
  };

  /* ---------------------------------------------------------- model */
  const recency = (list) => {
    let m = Infinity;
    for (const w of list)
      for (const th of w.threads) if (th.status !== "archived") m = Math.min(m, th.ago);
    return m;
  };
  const isShared = (list) => list.filter((w) => !w.archived).length > 1;
  const allArchived = (list) => list.every((w) => w.archived);

  /* Columns: main first, then branches on more than one device, then
     the rest by recent activity; archived branches last. The order is
     remembered, so columns never reshuffle while you watch; a new
     worktree slots in right after main and the shared branches. */
  function columnsOf(ix, st) {
    const groups = new Map();
    for (const w of ix.workspaces) {
      const key = w.main ? "@main" : w.branch;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(w);
    }
    const keys = [...groups.keys()];
    if (!st.order.length) {
      const rank = (k) =>
        k === "@main" ? 0 : allArchived(groups.get(k)) ? 3 : isShared(groups.get(k)) ? 1 : 2;
      st.order = keys.slice().sort((a, b) => {
        const r = rank(a) - rank(b);
        if (r) return r;
        const ra = recency(groups.get(a));
        const rb = recency(groups.get(b));
        return ra === rb ? 0 : ra < rb ? -1 : 1;
      });
    } else {
      st.order = st.order.filter((k) => groups.has(k));
      let at = 0;
      while (
        at < st.order.length &&
        (st.order[at] === "@main" || isShared(groups.get(st.order[at])))
      )
        at++;
      for (const k of keys) if (!st.order.includes(k)) st.order.splice(at++, 0, k);
    }
    const ordered = [
      ...st.order.filter((k) => !allArchived(groups.get(k))),
      ...st.order.filter((k) => allArchived(groups.get(k))),
    ];
    const cols = [];
    for (const key of ordered) {
      const all = groups.get(key);
      const list = st.showArchived ? all : all.filter((w) => !w.archived);
      if (!list.length) continue;
      const main = key === "@main";
      /* A branch no PR / issue / Jira item asked for, whose threads were
         all started by one automation: the automation made it. */
      let born = null;
      if (!main && !all[0].origin) {
        const ths = all.flatMap((w) => w.threads);
        if (ths.length && ths.every((x) => x.by && x.by === ths[0].by))
          born = ix.automations.find((a) => a.id === ths[0].by) ?? null;
      }
      cols.push({
        key,
        all,
        list,
        main,
        archived: allArchived(all),
        shared: !main && isShared(all),
        born,
      });
    }
    return cols;
  }

  function factIcon(label) {
    if (/removed/i.test(label)) return "folderMinus";
    if (/missing/i.test(label)) return "alert";
    if (/modified|untracked/i.test(label)) return "edit";
    if (/unmerged/i.test(label)) return "merge";
    return "commit";
  }

  /* A card is laid out here, not measured: every row has a fixed
     height, so lanes can be sized before anything is in the DOM and
     rows can glide (top transitions) when a thread arrives. */
  function cardModel(ix, w, st, o) {
    const facts = workspaceFacts(w);
    const threads = st.showArchived ? w.threads : w.threads.filter((x) => x.status !== "archived");
    const parts = [];
    const rows = {};
    let y = CARD.padT;
    facts.forEach((f, i) => {
      parts.push(
        `<div class="fb-fact f-${f.tone}" data-k="f${i}" style="top:${y}px">${ic(factIcon(f.label))}<span class="trunc">${esc(f.label)}</span></div>`,
      );
      y += CARD.fact;
    });
    if (facts.length) {
      parts.push(`<i class="fb-sep" data-k="sep" style="top:${y + 3}px"></i>`);
      y += CARD.sep;
    }
    const sel = S.selected;
    if (!threads.length) {
      parts.push(
        `<div class="fb-row fb-empty" data-k="empty" style="top:${y}px"><span class="trunc">No threads</span>${w.checkoutRemoved ? "" : `<span class="fb-new">${ic("plus")}New thread</span>`}</div>`,
      );
      y += CARD.row;
    } else if (!st.threads) {
      for (const th of threads) rows[th.id] = y;
      const dots = threads
        .slice()
        .sort((a, b) => RANK[a.status] - RANK[b.status])
        .slice(0, 6)
        .map((x) => statusDot(x.status))
        .join("");
      parts.push(
        `<div class="fb-row fb-tally" data-k="tally" style="top:${y}px"><span class="fb-dots">${dots}</span><span class="fb-count tnum">${threads.length} thread${threads.length === 1 ? "" : "s"}</span></div>`,
      );
      y += CARD.row;
    } else {
      for (const th of threads) {
        rows[th.id] = y;
        const by = th.by ? ix.automations.find((a) => a.id === th.by) : null;
        const isSel = sel?.kind === "thread" && sel.id === th.id;
        parts.push(
          `<div class="fb-row s-${th.status}${isSel ? " sel" : ""}" data-k="t:${th.id}" data-thread="${th.id}" data-select="thread:${th.id}" style="top:${y}px">${statusDot(th.status)}<span class="fb-rt trunc"${th.title.length > 19 ? ` data-tip="${esc(th.title)}"` : ""}>${esc(th.title)}</span>${by ? `<span class="fb-by" data-tip="Started by “${esc(by.title)}”">${ic("clock2")}</span>` : ""}<span class="fb-ago tnum">${agoLabel(th.ago)}</span></div>`,
        );
        y += CARD.row;
      }
    }
    const ht = y + CARD.padB;
    const cls = [
      "fb-card",
      w.main ? "main" : "",
      w.archived || w.checkoutRemoved ? "archived" : "",
      w.missing ? "missing" : "",
      o.dim ? "dim" : "",
      sel?.kind === "ws" && sel.id === w.id ? "is-sel" : "",
    ]
      .filter(Boolean)
      .join(" ");
    return {
      h: ht,
      rows,
      html: `<div class="${cls}" data-select="ws:${w.id}" style="height:${ht}px">${parts.join("")}</div>`,
    };
  }

  /* Countdown ring: how much of the interval has passed. */
  function ring(a, due) {
    if (a.schedule.kind === "once")
      return `<span class="fb-once" data-tip="Runs once">${ic("calendar")}</span>`;
    const r = 9;
    const c = 2 * Math.PI * r;
    const done = due ? 1 : a.enabled ? cycle(a) : 0;
    return `<svg class="fb-ring" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="${r}" class="track"/><circle cx="12" cy="12" r="${r}" class="prog" style="stroke-dasharray:${c.toFixed(2)};stroke-dashoffset:${(c * (1 - done)).toFixed(2)}"/></svg>`;
  }

  function chipHtml(a, o) {
    const run = activeRun(a);
    const due = run?.status === "pending-approval";
    const running = !!run && !due;
    const last = a.runs.find((r) => !ACTIVE.includes(r.status));
    let l2;
    if (!a.enabled)
      l2 = `<div class="fb-l2v" data-k="paused"><span class="fb-paused">${ic("pauseC")}Paused</span></div>`;
    else if (due)
      l2 = `<div class="fb-l2v" data-k="due"><button type="button" class="fb-approve" data-approve="${a.id}">Approve run</button><span class="fb-l2-dim">due now</span></div>`;
    else if (running)
      l2 = `<div class="fb-l2v" data-k="run">${statusDot("working")}<span class="fb-running">Running</span><span class="fb-l2-sp"></span><span class="fb-l2-dim tnum">${agoLabel(run.ago)}</span></div>`;
    else
      l2 = `<div class="fb-l2v" data-k="next"><span class="fb-l2-dim">Next</span><span class="fb-next tnum">${esc(inLabel(a.nextIn))}</span>${last?.status === "failed" ? `<span class="fb-l2-sp"></span><span class="fb-fail" data-tip="${esc(last.detail ?? "Last run failed")}">Last run failed</span>` : ""}</div>`;
    const where =
      a.envMode === "worktree"
        ? `${ic("branch")}<span class="trunc">New worktree off <span class="mono">${esc(a.baseRef ?? "main")}</span></span>`
        : `${ic("folder")}<span class="trunc">In the main checkout</span>`;
    const cls = [
      "fb-chip",
      a.enabled ? "" : "paused",
      due ? "due" : "",
      running ? "running" : "",
      o.sel ? "is-sel" : "",
      o.dim ? "dim" : "",
    ]
      .filter(Boolean)
      .join(" ");
    return `<div class="${cls}" data-select="auto:${a.id}" style="height:${o.h}px">
      <div class="fb-c1">${ring(a, due)}<span class="fb-ct"${o.tip ? ` data-tip="${esc(a.title)}"` : ""}>${esc(a.title)}</span></div>
      <div class="fb-l2">${l2}</div>
      <div class="fb-c3 trunc">${esc(scheduleLabel(a))}</div>
      <div class="fb-c4">${where}</div>
    </div>`;
  }

  function laneHtml(ln, o) {
    const d = ln.d;
    const conn = d.self ? "self" : (d.conn ?? "online");
    const status = d.self
      ? `<span class="fb-self">This device</span>`
      : `<span class="fb-conn c-${conn}"${d.via ? ` data-tip="via ${esc(d.via)}"` : ""}><i></i>${conn === "online" ? "Online" : conn === "connecting" ? "Connecting…" : "Offline"}</span>`;
    return `<div class="fb-laneh c-${conn}${o.sel ? " is-sel" : ""}" data-select="device:${ln.id}" style="height:${ln.h}px">
      <div class="fb-lh1">${ic(d.icon)}<span class="trunc">${esc(d.name)}</span></div>
      <div class="fb-lh2">${status}</div>
      <div class="fb-lh3 mono trunc" data-tip="Checkout folder">${esc(d.checkout.path)}</div>
    </div>`;
  }

  function colHtml(p, c, o) {
    const sel = o.sel ? " is-sel" : "";
    if (c.main) {
      const name = c.all[0].branch;
      return `<div class="fb-colh main${sel}" data-select="branch:@main">
        <div class="fb-ch1">${ic("folder")}<span class="trunc ${name ? "mono" : ""}">${esc(name ?? "Folder")}</span></div>
        <div class="fb-ch2"><span class="fb-plain">${name ? "Main checkouts" : "Not a git repository"}</span></div></div>`;
    }
    const w0 = c.all.find((w) => w.origin) ?? c.all[0];
    const bits = [
      originMark(p, w0),
      c.born
        ? `<span class="fb-born" data-tip="Made by an automation run">${ic("clock2")}<span class="trunc">${esc(c.born.title)}</span></span>`
        : "",
      c.shared
        ? `<span class="fb-shared" data-tip="Checked out on ${c.all.filter((w) => !w.archived).length} devices">${ic("layers")}on ${c.all.filter((w) => !w.archived).length} devices</span>`
        : "",
      c.archived ? `<span class="fb-arch">${ic("archive")}Archived</span>` : "",
    ].filter(Boolean);
    return `<div class="fb-colh${c.archived ? " archived" : ""}${sel}" data-select="branch:${esc(c.key)}">
      <div class="fb-ch1">${ic("branch")}<span class="trunc mono" data-tip="${esc(c.key)}">${esc(c.key)}</span></div>
      <div class="fb-ch2">${bits.join("") || '<span class="fb-plain">Branch</span>'}</div></div>`;
  }

  /* ---------------------------------------------------------- layout */
  function layout(ix, st) {
    const cols = columnsOf(ix, st);
    const X = { auto: G.laneW + G.gx, col0: G.laneW + G.gx + G.autoW + G.gxA };
    cols.forEach((c, i) => {
      c.i = i;
      c.x = X.col0 + i * (G.colW + G.gx);
    });
    const totalW = cols.length ? cols[cols.length - 1].x + G.colW : X.col0;
    const lanes = [];
    const rows = new Map();
    let y = G.headH;
    ix.devices.forEach((d, li) => {
      const ln = {
        d,
        id: d.checkout.id,
        i: li,
        top: y,
        cells: new Map(),
        chips: [],
        dim: !d.self && d.conn !== "online",
      };
      const cy = y + G.padT;
      let ay = cy;
      for (const raw of d.checkout.automations ?? []) {
        const a = ix.automations.find((x) => x.id === raw.id) ?? raw;
        const ch = CHIP.base + (st.lines(a.title) - 1) * CHIP.line;
        ln.chips.push({ a, x: X.auto, y: ay, w: G.autoW, h: ch });
        ay += ch + G.chipGap;
      }
      let content = Math.max(G.laneMin, ln.chips.length ? ay - G.chipGap - cy : G.slotH);
      for (const c of cols) {
        const w = c.list.find((x) => x.checkoutId === ln.id);
        if (!w) continue;
        const m = cardModel(ix, w, st, { dim: ln.dim });
        ln.cells.set(c.key, { w, m, x: c.x, y: cy, col: c });
        content = Math.max(content, m.h);
        for (const [tid, ry] of Object.entries(m.rows))
          rows.set(tid, { x: c.x, y: cy + ry, w: G.colW, h: CARD.row, col: c, lane: ln });
      }
      ln.h = G.padT + content + G.padB;
      y += ln.h;
      lanes.push(ln);
    });
    return { ix, cols, lanes, rows, X, totalW, totalH: y };
  }

  /* Orthogonal wire with rounded corners (metro style: it follows the
     grid's gutters instead of cutting across cards). */
  function ortho(pts, r = 7) {
    const P = pts.filter(
      (p, i) => i === 0 || Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y) > 0.5,
    );
    const f = (n) => Math.round(n * 10) / 10;
    let d = `M ${f(P[0].x)} ${f(P[0].y)}`;
    for (let i = 1; i < P.length - 1; i++) {
      const a = P[i - 1];
      const p = P[i];
      const b = P[i + 1];
      const d0 = Math.hypot(p.x - a.x, p.y - a.y);
      const d1 = Math.hypot(b.x - p.x, b.y - p.y);
      const rr = Math.min(r, d0 / 2, d1 / 2);
      d += ` L ${f(p.x + ((a.x - p.x) / d0) * rr)} ${f(p.y + ((a.y - p.y) / d0) * rr)} Q ${f(p.x)} ${f(p.y)} ${f(p.x + ((b.x - p.x) / d1) * rr)} ${f(p.y + ((b.y - p.y) / d1) * rr)}`;
    }
    const z = P[P.length - 1];
    return `${d} L ${f(z.x)} ${f(z.y)}`;
  }

  /* From an automation chip to a thread row in its own lane: out to the
     gutter before main, down to the lane's floor, along it, and up the
     gutter left of the target column. */
  function route(L, ln, ch, j, r) {
    const spread = (j - (ln.chips.length - 1) / 2) * 4;
    const sx = ch.x + ch.w;
    const sy = ch.y + 18;
    const gx1 = L.X.col0 - G.gxA / 2 + spread;
    const ty = r.y + r.h / 2;
    if (r.col.i === 0)
      return ortho([
        { x: sx, y: sy },
        { x: gx1, y: sy },
        { x: gx1, y: ty },
        { x: r.x, y: ty },
      ]);
    const gy = ln.top + ln.h - G.padB / 2 + spread * 0.75;
    const gx2 = r.x - G.gx / 2;
    return ortho([
      { x: sx, y: sy },
      { x: gx1, y: sy },
      { x: gx1, y: gy },
      { x: gx2, y: gy },
      { x: gx2, y: ty },
      { x: r.x, y: ty },
    ]);
  }

  /* Same path with every point on the first one (same commands, so it
     interpolates to the real path). */
  function collapse(d) {
    const nums = d.match(/-?\d+(?:\.\d+)?/g) ?? ["0", "0"];
    let i = 0;
    return d.replace(/-?\d+(?:\.\d+)?/g, () => (i++ % 2 ? nums[1] : nums[0]));
  }

  /* ---------------------------------------------------------- inspector */
  const rowItem = (attrs, inner) => `<div class="fbi-item" ${attrs}>${inner}</div>`;
  /* Per-device facts, one per line (they are compared down a list). */
  const factLines = (w) => {
    const f = workspaceFacts(w);
    return f.length
      ? f.map((x) => `<span class="fbi-fact f-${x.tone}">${esc(x.label)}</span>`).join("")
      : '<span class="fbi-fact">Clean</span>';
  };
  function inspectorHtml(sel, L) {
    const ix = L.ix;
    const p = ix.p;
    if (sel.kind === "device") {
      const d = ix.devices.find((x) => x.checkout.id === sel.id);
      if (!d) return null;
      const autos = ix.automations.filter((a) => a.checkoutId === d.checkout.id);
      return `<div class="fbi-kind">${ic(d.icon)}Device · checkout</div>
        <div class="fbi-title">${esc(d.name)}</div><div class="fbi-sub">${d.self ? "This device" : `${esc(d.conn === "online" ? "Online" : d.conn === "connecting" ? "Connecting" : "Offline")}${d.via ? ` · via ${esc(d.via)}` : ""}`}</div>
        <dl class="fbi-rows"><dt>Folder</dt><dd class="mono">${esc(d.checkout.path)}</dd><dt>System</dt><dd>${esc(d.os)}</dd></dl>
        <div class="fbi-sec"><h4>Automations on this device</h4>
          ${
            autos.length
              ? autos
                  .map((a) => {
                    const run = activeRun(a);
                    return rowItem(
                      `data-select="auto:${a.id}"`,
                      `${ic("clock2")}<span class="trunc">${esc(a.title)}</span><span class="dim tnum">${!a.enabled ? "Paused" : run?.status === "pending-approval" ? '<span class="fbi-warn">Due</span>' : run ? "Running" : esc(inLabel(a.nextIn))}</span>`,
                    );
                  })
                  .join("")
              : '<div class="dim">None. Schedules run on the device that owns them.</div>'
          }</div>
        <div class="fbi-sec"><h4>Workspaces</h4>
          ${d.checkout.workspaces.map((w) => rowItem(`data-select="ws:${w.id}"`, `${ic(w.main ? "folder" : "branch")}<span class="trunc ${w.main ? "" : "mono"}">${esc(w.main ? "Main checkout" : w.branch)}</span>${originMark(p, w)}`)).join("")}</div>
        <div class="fbi-actions"><button class="fbi-btn">${ic("branch")}New worktree</button><button class="fbi-btn">${ic("clock2")}New automation</button></div>`;
    }
    if (sel.kind === "branch") {
      const main = sel.id === "@main";
      const list = main ? ix.workspaces.filter((w) => w.main) : (ix.byBranch[sel.id] ?? []);
      if (!list.length) return null;
      const w0 = list.find((w) => w.origin) ?? list[0];
      const pr = w0.origin?.kind === "pr" ? p.prs[w0.origin.ref] : null;
      const off = main
        ? []
        : ix.devices.filter((d) => !list.some((w) => w.checkoutId === d.checkout.id));
      const name = main ? (w0.branch ?? "Folder") : sel.id;
      return `<div class="fbi-kind">${ic(main ? "folder" : "branch")}${main ? "Main branch" : "Branch"}</div>
        <div class="fbi-title ${w0.branch ? "mono" : ""}">${esc(name)}</div>
        <div class="fbi-sub">${pr ? `${originMark(p, w0)}<span>${esc(pr.title)}</span>` : w0.origin ? originMark(p, w0) : main ? (w0.branch ? "Every checkout's main branch" : "A plain folder, no git") : "A plain branch"}</div>
        ${pr ? `<dl class="fbi-rows"><dt>Pull request</dt><dd>${esc(pr.state)}</dd><dt>Checks</dt><dd class="${pr.checks === "failed" ? "fbi-err" : ""}">${esc(pr.checks)}</dd></dl>` : ""}
        <div class="fbi-sec"><h4>Checked out on ${list.length} device${list.length === 1 ? "" : "s"}</h4>
          ${list
            .map((w) =>
              rowItem(
                `data-select="ws:${w.id}"`,
                `${deviceIcon(w.device)}<span class="fbi-dev">${esc(DEVICES[w.device].name)}</span><span class="fbi-facts">${factLines(w)}</span><span class="fbi-dots" data-tip="${w.threads.length} thread${w.threads.length === 1 ? "" : "s"}">${w.threads
                  .slice()
                  .sort((a, b) => RANK[a.status] - RANK[b.status])
                  .slice(0, 5)
                  .map((x) => statusDot(x.status))
                  .join("")}</span>`,
              ),
            )
            .join("")}</div>
        ${off.length ? `<div class="fbi-sec"><h4>Not checked out on</h4>${off.map((d) => rowItem("", `${ic(d.icon)}<span class="fbi-dev">${esc(d.name)}</span><span class="fbi-facts"></span><button class="fbi-btn sm" type="button" data-checkout="${d.checkout.id}" data-branch="${esc(sel.id)}" ${d.self || d.conn === "online" ? "" : 'disabled data-tip="Waiting for the device to connect"'}>Check out here</button>`)).join("")}</div>` : ""}
        <div class="fbi-actions">${pr ? `<button class="fbi-btn">${ic("pr")}Open #${pr.number}</button>` : ""}<button class="fbi-btn">${ic("plus")}New thread…</button></div>`;
    }
    if (sel.kind === "ws") {
      const w = ix.workspaces.find((x) => x.id === sel.id);
      if (!w) return null;
      const d = DEVICES[w.device];
      const pr = w.origin?.kind === "pr" ? p.prs[w.origin.ref] : null;
      const twins = w.main ? [] : (ix.byBranch[w.branch] ?? []).filter((x) => x.id !== w.id);
      return `<div class="fbi-kind">${ic(w.main ? "folder" : "branch")}${w.main ? "Main checkout" : "Worktree"} · ${esc(d.name)}</div>
        <div class="fbi-title ${w.branch ? "mono" : ""}">${esc(w.branch ?? "Folder")}</div>
        <div class="fbi-sub">${factsHtml(w) || "Clean and up to date"}</div>
        <dl class="fbi-rows">
          <dt>Path</dt><dd class="mono">${esc(w.path)}</dd>
          ${pr ? `<dt>From</dt><dd>${originMark(p, w)} ${esc(pr.title)} · <span class="dim">${pr.state}, checks ${pr.checks}</span></dd>` : w.origin ? `<dt>From</dt><dd>${originMark(p, w)}</dd>` : ""}
          ${twins.length ? `<dt>Also on</dt><dd>${twins.map((x) => `<span class="fbi-link" data-select="ws:${x.id}">${esc(DEVICES[x.device].name)}</span>`).join(", ")}</dd>` : ""}
        </dl>
        <div class="fbi-sec"><h4>Threads</h4>
          ${w.threads.length ? w.threads.map((th) => rowItem(`data-select="thread:${th.id}"`, `${statusDot(th.status)}<span class="trunc">${esc(th.title)}</span><span class="dim tnum">${agoLabel(th.ago)}</span>`)).join("") : '<div class="dim">No threads yet.</div>'}</div>
        <div class="fbi-actions">
          ${w.checkoutRemoved ? `<button class="fbi-btn">${ic("folderMinus")}Recreate checkout…</button>` : `<button class="fbi-btn primary">${ic("plus")}New thread</button>`}
          ${w.main ? "" : w.archived ? `<button class="fbi-btn">${ic("archive")}Restore</button>` : `<button class="fbi-btn">${ic("archive")}Archive</button>`}
          ${w.main || w.checkoutRemoved ? "" : `<button class="fbi-btn danger">${ic("folderMinus")}Remove checkout…</button>`}
        </div>`;
    }
    if (sel.kind === "auto") {
      const a = ix.automations.find((x) => x.id === sel.id);
      if (!a) return null;
      const run = activeRun(a);
      return `<div class="fbi-kind">${ic("clock2")}Automation${a.enabled ? "" : " · paused"}</div>
        <div class="fbi-title">${esc(a.title)}</div>
        <div class="fbi-sub">${esc(scheduleLabel(a))}</div>
        ${run?.status === "pending-approval" ? `<div class="fbi-due"><div class="fbi-due-t">${ic("shield")}<span>A run is due and waits for your approval. Approving starts ${a.envMode === "worktree" ? "a thread in a new worktree" : "a thread in the main checkout"} on ${esc(DEVICES[a.device].name)}.</span></div><div class="fbi-due-a"><button class="fbi-btn primary" type="button" data-approve-id="${a.id}">Approve run</button><button class="fbi-btn" type="button" data-reject-id="${a.id}">Reject</button></div></div>` : ""}
        <dl class="fbi-rows">
          <dt>Runs on</dt><dd><span class="fbi-link" data-select="device:${a.checkoutId}">${esc(DEVICES[a.device].name)}</span></dd>
          <dt>Next run</dt><dd>${a.enabled ? esc(inLabel(a.nextIn)) : "Paused"}</dd>
          <dt>Starts</dt><dd>${a.envMode === "worktree" ? `A thread in a new worktree off <span class="mono">${esc(a.baseRef ?? "main")}</span>` : "A thread in the main checkout"}</dd>
          <dt>Agent</dt><dd>${providerMark(a.provider)} ${PROVIDERS[a.provider]?.name ?? a.provider}</dd>
          <dt>Approval</dt><dd>Every run</dd>
        </dl>
        <div class="fbi-sec"><h4>Recent runs</h4>
          ${a.runs.length ? a.runs.map((r) => rowItem(r.threads[0] ? `data-select="thread:${r.threads[0]}"` : "", `<span class="fbi-run r-${r.status}"></span><span class="trunc">${RUN_STATUS[r.status]?.label ?? r.status}${r.detail ? ` · <span class="dim">${esc(r.detail)}</span>` : ""}</span><span class="dim tnum">${agoLabel(r.ago)}</span>`)).join("") : '<div class="dim">No runs yet.</div>'}</div>
        <div class="fbi-actions"><button class="fbi-btn">${ic("play")}Run now</button><button class="fbi-btn">${a.enabled ? ic("pause") + "Pause" : ic("play") + "Resume"}</button><button class="fbi-btn">${ic("edit")}Edit</button></div>`;
    }
    if (sel.kind === "thread") {
      const th = ix.threads.find((x) => x.id === sel.id);
      if (!th) return null;
      const w = ix.workspaces.find((x) => x.id === th.workspaceId);
      return `<div class="fbi-kind">${statusDot(th.status)}Thread · ${STATUS[th.status].label}</div>
        <div class="fbi-title">${esc(th.title)}</div>
        <dl class="fbi-rows">
          <dt>Agent</dt><dd>${providerMark(th.provider)} ${PROVIDERS[th.provider]?.name ?? th.provider}</dd>
          <dt>Workspace</dt><dd><span class="fbi-link ${w.branch ? "mono" : ""}" data-select="ws:${w.id}">${esc(w.main ? "Main checkout" : w.branch)}</span></dd>
          <dt>Device</dt><dd>${esc(DEVICES[th.device].name)}</dd>
          <dt>Activity</dt><dd>${th.ago < 1 ? "Just now" : `${agoLabel(th.ago)} ago`}</dd>
          ${th.by ? `<dt>Started by</dt><dd><span class="fbi-link" data-select="auto:${th.by}">${esc(ix.automations.find((a) => a.id === th.by)?.title ?? "an automation")}</span></dd>` : ""}
        </dl>
        <div class="fbi-actions"><button class="fbi-btn primary">${ic("open")}Open thread</button></div>`;
    }
    return null;
  }

  /* ---------------------------------------------------------- lab actions
     They mutate the shared data the way the server would, then emit. */
  function approve(aid) {
    for (const p of S.projects)
      for (const c of p.checkouts)
        for (const a of c.automations ?? []) {
          const run = a.id === aid && activeRun(a);
          if (!run || run.status !== "pending-approval") continue;
          /* The scripted triage run keeps its scripted thread id, so the
             loop does not add it twice when it reaches 0:09. */
          const id = run.id === "r6" ? "t18" : `t-${run.id}`;
          const title =
            run.id === "r6" ? "Triage: 2 new issues" : `${a.title}: run ${a.runs.length}`;
          const thread = t(id, title, "working", a.provider, 0, a.id);
          run.status = "executing";
          run.threads = [id];
          if (a.envMode === "worktree") {
            const slug = `${a.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${run.id}`;
            if (!c.workspaces.some((w) => w.id === `w-${run.id}`))
              c.workspaces.push({
                id: `w-${run.id}`,
                branch: `auto/${slug}`,
                path: `~/.ryco/worktrees/${p.id}/${slug}`,
                fresh: true,
                threads: [thread],
              });
          } else {
            const ws = c.workspaces.find((w) => w.main);
            if (ws && !ws.threads.some((x) => x.id === id)) ws.threads.unshift(thread);
          }
          lastEvent = `Run approved: ${a.title}`;
        }
    emit();
    notify();
  }
  function reject(aid) {
    for (const p of S.projects)
      for (const c of p.checkouts)
        for (const a of c.automations ?? []) {
          const run = a.id === aid && activeRun(a);
          if (run?.status === "pending-approval") {
            run.status = "rejected";
            lastEvent = `Run rejected: ${a.title}`;
          }
        }
    emit();
    notify();
  }
  function checkOut(checkoutId, key) {
    const p = project();
    const c = p.checkouts.find((x) => x.id === checkoutId);
    const src = index().workspaces.find((w) => !w.main && w.branch === key);
    if (!c || !src || c.workspaces.some((w) => w.branch === key)) return;
    const slug = key.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const path =
      c.device === "hub" ? `${c.path}/.worktrees/${slug}` : `~/.ryco/worktrees/${p.id}/${slug}`;
    c.workspaces.push({
      id: `w-${c.id.replace(/@/g, "-")}-${slug}`,
      branch: key,
      origin: src.origin,
      path,
      fresh: true,
      threads: [],
    });
    lastEvent = `Checked out ${key} on ${DEVICES[c.device].name}`;
    emit();
    notify();
  }
  /* The shell repaints its event line only when a sim tick changes it;
     paint it for the user's own actions too. */
  const notify = () => typeof paintEvent === "function" && paintEvent();

  /* ---------------------------------------------------------- mount */
  function mount(host, apiRef) {
    const st = {
      showArchived: true,
      threads: true,
      order: [],
      projectId: null,
      hLane: null,
      hCol: null,
      hAuto: null,
      hThread: null,
      selKey: null,
    };
    let geo = null;
    let firstPaint = true;
    let destroyed = false;
    let wireDelay = 0; // wires born from a data change wait for their row
    const vp = createViewport(host, {
      onFit: () => fit(true),
      onBackgroundClick: () => S.selected && apiRef.select(null),
      minZoom: 0.3,
      maxZoom: 2,
    });
    vp.controls();
    for (const [k, v] of Object.entries({
      "--fb-lane": G.laneW,
      "--fb-auto": G.autoW,
      "--fb-col": G.colW,
      "--fb-gx": G.gx,
      "--fb-gxa": G.gxA,
      "--fb-head": G.headH,
      "--fb-slot": G.slotH,
      "--fb-row": CARD.row,
      "--fb-ctw": CHIP.titleW,
    }))
      host.style.setProperty(k, `${v}px`);
    /* Automation titles wrap; a hidden probe tells the layout how many
       lines each takes (max two), so lanes are sized before paint. */
    const probe = h("div", "fb-ct fb-probe");
    host.append(probe);
    const lineCache = new Map();
    st.lines = (text) => {
      if (!lineCache.has(text)) {
        probe.textContent = text;
        lineCache.set(text, Math.max(1, Math.round(probe.scrollHeight / CHIP.line)));
      }
      return Math.min(2, lineCache.get(text));
    };
    /* Longer than two lines: the clamped title gets a tooltip. */
    st.clipped = (text) => (lineCache.get(text) ?? 1) > 2;
    /* Web fonts can land after the first paint: re-measure once. */
    document.fonts?.ready.then(() => {
      if (destroyed) return;
      const before = [...lineCache.entries()].join();
      lineCache.clear();
      if (geo) for (const a of geo.ix.automations) st.lines(a.title);
      if ([...lineCache.entries()].join() !== before) render();
    });
    /* Bands (lane rows, column highlights) sit under wires and cards. */
    const bg = h("div", "fb-bg");
    vp.world.prepend(bg);
    const insp = createInspector(host, { onClose: () => apiRef.select(null) });

    const tools = h(
      "div",
      "vp-ui fb-tools",
      `<button type="button" class="fb-tool" data-t="threads">${ic("msg")}Threads</button><button type="button" class="fb-tool" data-t="archived">${ic("archive")}Archived</button>`,
    );
    const pager = h(
      "div",
      "vp-ui fb-pager",
      `<button type="button" data-pg="-1" data-tip="Previous branch">${ic("chevR", "flip")}</button><span class="fb-pg-l tnum"></span><button type="button" data-pg="1" data-tip="Next branch">${ic("chevR")}</button>`,
    );
    const fade = h("div", "vp-ui fb-fade");
    const legend = h(
      "div",
      "vp-ui legend fb-legend",
      `<span data-lg="same"><svg width="10" height="14" aria-hidden="true"><path d="M5 1v12" stroke="var(--violet)" stroke-dasharray="2 3" stroke-width="1.5" stroke-linecap="round"/></svg>Same branch</span><span data-lg="run"><span class="fb-lg-run">${ic("clock2")}<svg width="18" height="6" aria-hidden="true"><path d="M1 3h16" stroke="var(--teal)" stroke-dasharray="1 4" stroke-linecap="round" stroke-width="2"/></svg></span>Started by an automation</span><span data-lg="slot"><i class="fb-lg-slot"></i>Not checked out here</span>`,
    );
    host.append(tools, pager, legend);
    /* The fade sits under every overlay (zoom, inspector, pager). */
    vp.world.after(fade);

    function paintTools() {
      for (const b of $$("[data-t]", tools)) {
        const on = b.dataset.t === "threads" ? st.threads : st.showArchived;
        b.setAttribute("aria-pressed", String(on));
        b.dataset.tip =
          b.dataset.t === "threads"
            ? on
              ? "Fold thread stacks into tallies"
              : "Show thread stacks"
            : on
              ? "Hide archived branches and threads"
              : "Show archived";
      }
    }
    tools.addEventListener("click", (e) => {
      const b = e.target.closest("[data-t]");
      if (!b) return;
      if (b.dataset.t === "threads") st.threads = !st.threads;
      else st.showArchived = !st.showArchived;
      paintTools();
      render();
    });
    pager.addEventListener("click", (e) => {
      const b = e.target.closest("[data-pg]");
      if (b && !b.disabled) page(Number(b.dataset.pg));
    });
    paintTools();

    /* Entrances: on first paint and project switch the matrix fills in
       as a diagonal wave from the top-left corner; live, a new card
       grows into its cell after its neighbours have glided aside. */
    let wave = false;
    function enterNode(el, d) {
      if (wave)
        return el.animate(
          [
            { opacity: 0, translate: "0 10px" },
            { opacity: 1, translate: "0 0" },
          ],
          { duration: 520, delay: d.wave ?? 0, easing: EASE, fill: "backwards" },
        );
      if (d.kind === "card") {
        /* A worktree that just appeared gets a short info ring once
           its content is in (see place()). */
        el._fresh = d.fresh;
        el.style.transformOrigin = "50% 0";
        return el.animate(
          [
            { opacity: 0, scale: "0.92", clipPath: "inset(0 0 100% 0 round 10px)" },
            { opacity: 1, scale: "1", clipPath: "inset(0 0 0% 0 round 10px)" },
          ],
          { duration: 680, delay: 260, easing: EASE, fill: "backwards" },
        );
      }
      return el.animate([{ opacity: 0 }, { opacity: 1 }], {
        duration: 420,
        delay: d.kind === "band" ? 0 : 220,
        easing: EASE,
        fill: "backwards",
      });
    }
    function place(layer, list) {
      const had = new Set(layer._nodes?.keys() ?? []);
      const store = syncNodes(
        layer,
        list.map((it) => ({ key: it.key, x: it.x, y: it.y, html: "", cls: it.cls, data: it })),
        {
          enter: (el, item) => enterNode(el, item.data),
          exit: (el) =>
            el.animate(
              [
                { opacity: 1, scale: "1" },
                { opacity: 0, scale: "0.97" },
              ],
              { duration: 240, easing: "ease-in", fill: "forwards" },
            ),
        },
      );
      for (const it of list) {
        const rec = store.get(it.key);
        morph(rec.el, it.html, had.has(it.key) && motion ? HOOKS : null);
        rec.w = it.w;
        rec.h = it.h;
        if (rec.el._fresh) {
          rec.el._fresh = false;
          const info = getComputedStyle(host).getPropertyValue("--info").trim() || "#3b82f6";
          const mix = (p) => `color-mix(in srgb, ${info} ${p}%, transparent)`;
          rec.el.firstElementChild?.animate(
            [
              { borderColor: mix(70), boxShadow: `0 0 0 3px ${mix(22)}` },
              { offset: 0.35, borderColor: mix(55), boxShadow: `0 0 0 3px ${mix(16)}` },
              {},
            ],
            { duration: 2400, delay: 700, easing: "ease-out", fill: "backwards" },
          );
        }
      }
      return store;
    }

    function render() {
      const ix = index();
      const projectChanged = st.projectId !== ix.p.id;
      if (projectChanged) {
        st.projectId = ix.p.id;
        st.order = [];
        st.hLane = st.hCol = st.hAuto = st.hThread = null;
      }
      wave = projectChanged;
      const L = layout(ix, st);
      geo = L;
      const pid = ix.p.id;
      const sel = S.selected;
      const isSel = (kind, id) => sel?.kind === kind && sel.id === id;
      const wd = (li, ci) => 40 + (li + ci) * 34;

      /* Nodes */
      const items = [];
      items.push({
        key: `${pid}:corner`,
        x: 0,
        y: 0,
        w: G.laneW,
        h: G.headH,
        cls: "fb-n-corner fb-stick-x fb-stick-y",
        wave: wd(0, 0),
        html: `<div class="fb-corner"><div class="fb-ch1"><span>Devices</span></div><div class="fb-ch2"><span class="fb-plain">${ix.devices.length} checkout${ix.devices.length === 1 ? "" : "s"}</span></div></div>`,
      });
      items.push({
        key: `${pid}:autoh`,
        x: L.X.auto,
        y: 0,
        w: G.autoW,
        h: G.headH,
        col: "@auto",
        cls: "fb-n-colh fb-stick-y",
        wave: wd(0, 1),
        html: `<div class="fb-colh fb-autoh"><div class="fb-ch1">${ic("clock2")}<span>Automations</span></div><div class="fb-ch2"><span class="fb-plain">${ic("shield")}Each run needs approval</span></div></div>`,
      });
      for (const c of L.cols)
        items.push({
          key: `${pid}:col:${c.key}`,
          x: c.x,
          y: 0,
          w: G.colW,
          h: G.headH,
          col: c.key,
          cls: "fb-n-colh fb-stick-y",
          wave: wd(0, c.i + 2),
          html: colHtml(ix.p, c, { sel: isSel("branch", c.key) }),
        });
      for (const ln of L.lanes) {
        items.push({
          key: `lane:${ln.id}`,
          x: 0,
          y: ln.top,
          w: G.laneW,
          h: ln.h,
          lane: ln.id,
          cls: "fb-n-laneh fb-stick-x",
          wave: wd(ln.i + 1, 0),
          html: laneHtml(ln, { sel: isSel("device", ln.id) }),
        });
        if (ln.chips.length)
          ln.chips.forEach((ch, j) =>
            items.push({
              key: `a:${ch.a.id}`,
              x: ch.x,
              y: ch.y,
              w: ch.w,
              h: ch.h,
              lane: ln.id,
              col: "@auto",
              auto: ch.a.id,
              kind: "chip",
              wave: wd(ln.i + 1, 1) + j * 24,
              html: chipHtml(ch.a, {
                sel: isSel("auto", ch.a.id),
                dim: ln.dim,
                h: ch.h,
                tip: st.clipped(ch.a.title),
              }),
            }),
          );
        else
          items.push({
            key: `aslot:${ln.id}`,
            x: L.X.auto,
            y: ln.top + G.padT,
            w: G.autoW,
            h: G.slotH,
            lane: ln.id,
            col: "@auto",
            kind: "slot",
            wave: wd(ln.i + 1, 1),
            html: `<div class="fb-slot fb-aslot" data-lane="${ln.id}" data-tip="Schedules run on the device that owns them"><span class="fb-none">No automations</span><span class="fb-add">${ic("plus")}Schedule one</span></div>`,
          });
        for (const c of L.cols) {
          const cell = ln.cells.get(c.key);
          if (cell)
            items.push({
              key: `w:${cell.w.id}`,
              x: cell.x,
              y: cell.y,
              w: G.colW,
              h: cell.m.h,
              lane: ln.id,
              col: c.key,
              kind: "card",
              fresh: !!cell.w.fresh,
              wave: wd(ln.i + 1, c.i + 2),
              html: cell.m.html,
            });
          else if (!c.archived && !c.main) {
            const off = ln.dim;
            items.push({
              key: `slot:${ln.id}|${c.key}`,
              x: c.x,
              y: ln.top + G.padT,
              w: G.colW,
              h: G.slotH,
              lane: ln.id,
              col: c.key,
              kind: "slot",
              wave: wd(ln.i + 1, c.i + 2),
              html: `<div class="fb-slot${off ? " off" : ""}" data-checkout="${ln.id}" data-branch="${esc(c.key)}" data-tip="${off ? `${esc(ln.d.name)} is not connected yet` : `Check out ${esc(c.key)} on ${esc(ln.d.name)}`}">${ic("plus")}<span>Check out here</span></div>`,
            });
          }
        }
      }
      wireDelay = projectChanged ? 520 : 240;
      place(vp.nodes, items);
      /* The legend names only what is on this map. */
      const shown = {
        same: L.cols.some((c) => c.shared),
        run: ix.automations.some((a) => a.runs.some((r) => r.threads.length)),
        slot: items.some((it) => it.key.startsWith("slot:")),
      };
      for (const el of $$("[data-lg]", legend)) el.hidden = !shown[el.dataset.lg];
      legend.hidden = !Object.values(shown).some(Boolean);

      /* Bands: the header row, one per lane, one per column. */
      const bands = [
        {
          key: `${pid}:hb`,
          x: 0,
          y: 0,
          w: L.totalW,
          h: G.headH,
          kind: "band",
          html: `<div class="fb-band fb-hband" style="width:${L.totalW}px;height:${G.headH}px"></div>`,
        },
      ];
      bands.push({
        key: `${pid}:div`,
        x: L.X.col0 - G.gxA / 2,
        y: G.headH,
        w: 1,
        h: L.totalH - G.headH,
        kind: "band",
        html: `<div class="fb-band fb-vdiv" style="height:${L.totalH - G.headH}px"></div>`,
      });
      for (const ln of L.lanes)
        bands.push({
          key: `lb:${ln.id}`,
          x: 0,
          y: ln.top,
          w: L.totalW,
          h: ln.h,
          lane: ln.id,
          kind: "band",
          html: `<div class="fb-band fb-lband" style="width:${L.totalW}px;height:${ln.h}px"></div>`,
        });
      const colBand = (key, x, w) => ({
        key: `cb:${pid}:${key}`,
        x: x - 6,
        y: 4,
        w: w + 12,
        h: L.totalH - 4,
        col: key,
        kind: "band",
        html: `<div class="fb-band fb-cband" style="width:${w + 12}px;height:${L.totalH - 4}px"></div>`,
      });
      bands.push(colBand("@auto", L.X.auto, G.autoW));
      for (const c of L.cols) bands.push(colBand(c.key, c.x, G.colW));
      place(bg, bands);

      /* Inspector */
      if (sel) {
        const html = inspectorHtml(sel, L);
        if (html) insp.show(`${sel.kind}:${sel.id}`, html);
        else {
          /* The selected thing is gone (the loop reset, a run ended): drop it. */
          insp.hide();
          setTimeout(() => S.selected === sel && apiRef.select(null));
        }
      } else insp.hide();

      paintFocus();
      stick();
      nav();
      const sk = sel ? `${sel.kind}:${sel.id}` : null;
      if (sk && sk !== st.selKey) requestAnimationFrame(() => reveal(sel));
      if (!sk && st.selKey) setTimeout(nav, 520);
      st.selKey = sk;
      if (projectChanged && !firstPaint) requestAnimationFrame(() => fit(true));
    }

    /* ---------------------------------------------------------- focus
       Hover and selection only touch classes and wires, never layout. */
    function paintFocus() {
      const L = geo;
      if (!L) return;
      const sel = S.selected;
      for (const rec of (bg._nodes ?? new Map()).values()) {
        const d = rec.el._data;
        const band = rec.el.firstElementChild;
        if (!d || !band) continue;
        band.classList.toggle(
          "hov",
          (d.lane != null && d.lane === st.hLane) || (d.col != null && d.col === st.hCol),
        );
        band.classList.toggle(
          "sel",
          (d.lane != null && sel?.kind === "device" && sel.id === d.lane) ||
            (d.col != null && sel?.kind === "branch" && sel.id === d.col),
        );
      }
      for (const rec of (vp.nodes._nodes ?? new Map()).values()) {
        const d = rec.el._data;
        if (d?.kind !== "slot") continue;
        rec.el.classList.toggle("near", d.lane === st.hLane || d.col === st.hCol);
      }
      const focusA = new Set([st.hAuto, sel?.kind === "auto" ? sel.id : null].filter(Boolean));
      const focusT = new Set([st.hThread, sel?.kind === "thread" ? sel.id : null].filter(Boolean));
      const lit = new Set();
      const litA = new Set();
      const edges = [];
      /* Same branch on two devices: a violet tick down the column. */
      for (const c of L.cols) {
        if (!c.shared) continue;
        const cells = L.lanes.map((ln) => ln.cells.get(c.key)).filter((x) => x && !x.w.archived);
        for (let i = 1; i < cells.length; i++) {
          const x = c.x + G.colW / 2;
          edges.push({
            key: `same:${c.key}:${i}`,
            d: `M ${x} ${cells[i - 1].y + cells[i - 1].m.h + 5} L ${x} ${cells[i].y - 5}`,
            cls: "fb-same",
          });
        }
      }
      /* Started by an automation: a teal wire along the lane while the
         run executes, or while the automation / thread is in focus. */
      for (const ln of L.lanes)
        ln.chips.forEach((ch, j) => {
          for (const run of ch.a.runs)
            for (const tid of run.threads) {
              const r = L.rows.get(tid);
              if (!r || r.lane !== ln) continue;
              const hot = focusA.has(ch.a.id) || focusT.has(tid);
              if (!hot && run.status !== "executing") continue;
              if (hot) {
                lit.add(tid);
                litA.add(ch.a.id);
              }
              edges.push({
                key: `run:${ch.a.id}:${tid}`,
                d: route(L, ln, ch, j, r),
                cls: `fb-run${run.status === "executing" ? " flow" : ""}${hot ? " hot" : ""}`,
              });
            }
        });
      /* The engine's draw-in borrows stroke-dasharray, which would turn
         these dotted wires solid until it ends. Instead a new wire grows
         out of its source: every point starts collapsed onto the first
         one and glides to its place, so the dots stay dots. */
      const had = new Set(vp.edges._edges?.keys() ?? []);
      const store = syncEdges(vp.edges, edges, { noEnter: true });
      if (motion)
        for (const e of edges) {
          if (had.has(e.key)) continue;
          store
            .get(e.key)
            ?.el.animate([{ d: `path("${collapse(e.d)}")` }, { d: `path("${e.d}")` }], {
              duration: e.key.startsWith("same:") ? 560 : 460,
              delay: e.key.startsWith("same:") ? 380 : wireDelay,
              easing: EASE,
              fill: "backwards",
            });
        }
      wireDelay = 0;
      for (const el of $$(".fb-row[data-thread]", vp.nodes))
        el.classList.toggle("fb-lit", lit.has(el.dataset.thread));
      for (const rec of (vp.nodes._nodes ?? new Map()).values())
        if (rec.el._data?.kind === "chip")
          rec.el.classList.toggle("lit", litA.has(rec.el._data.auto));
    }

    /* ---------------------------------------------------------- frozen panes
       The device column pins to the left edge and the header row pins
       under the toolbar, so any cell still says which device and which
       branch it is. */
    function stick() {
      const k = vp.cam.k;
      const dx = Math.max(0, -vp.cam.x / k);
      const dy = Math.max(0, (STICK_TOP - vp.cam.y) / k);
      /* The first lane row visible under the pinned header row. */
      const top = dy + G.headH;
      for (const rec of (vp.nodes._nodes ?? new Map()).values()) {
        const cl = rec.el.classList;
        const sx = cl.contains("fb-stick-x");
        const sy = cl.contains("fb-stick-y");
        if (!sx && !sy) continue;
        const ox = sx ? dx : 0;
        const oy = sy ? dy : 0;
        rec.el.style.translate = ox || oy ? `${ox}px ${oy}px` : "";
        cl.toggle("stuck-x", ox > 0.5);
        cl.toggle("stuck-y", oy > 0.5);
        /* A lane's device label rides down its lane while the lane's top
           is scrolled under the header row, so a tall lane never loses
           its name. */
        if (rec.el._data?.lane != null && sx) {
          const ly = clamp(top - rec.y, 0, Math.max(0, rec.h - LABEL_H));
          rec.el.style.setProperty("--fb-ly", `${ly}px`);
        }
      }
    }

    /* ---------------------------------------------------------- camera */
    const visW = () => host.clientWidth - (insp.panel.classList.contains("open") ? INSP_W : 0);
    function fit(animate) {
      const L = geo;
      if (!L) return;
      const W = visW();
      const H = host.clientHeight;
      const aw = W - FIT.left - FIT.right;
      const ah = H - FIT.top - FIT.bottom;
      /* One card size across projects: small projects do not balloon. */
      let k = Math.min(KPAGE, aw / L.totalW, ah / L.totalH);
      if (k < KMIN) {
        /* Too wide to read whole: keep text legible and page sideways,
           showing as many WHOLE columns as fit (no card cut in half at
           the edge; the fade and the pager say there is more). */
        const span = (n) => L.X.col0 + n * (G.colW + G.gx) - G.gx;
        let n = L.cols.length;
        while (n > 1 && aw / span(n) < KMIN) n--;
        k = Math.min(KPAGE, aw / span(n), ah / L.totalH);
      }
      /* A table reads from its top-left corner, so every project anchors
         there: switching projects keeps the header row and the device
         column in place and only the cells change. */
      vp.setCamera({ k, x: FIT.left, y: FIT.top + 6 }, { animate, duration: 720 });
    }
    /* Horizontal stops: unscrolled, then each branch column flush with
       the frozen device column, until the last column is in view. Paging and
       reveals land on these, so no column is ever left half under the
       frozen pane. */
    function stops() {
      const L = geo;
      const k = vp.cam.k;
      const minX = Math.min(FIT.left, visW() - FIT.right - L.totalW * k);
      const out = [FIT.left];
      for (const c of L.cols) {
        const x = (G.laneW + G.gx - c.x) * k;
        out.push(x);
        if (x <= minX + 1) break; // the last column is in view from here
      }
      return [...new Set(out.map((v) => Math.round(v)))].sort((a, b) => b - a);
    }
    function page(dir) {
      if (!geo) return;
      const s = stops();
      const x0 = vp.cam.x;
      const x =
        dir > 0
          ? s.find((v) => v < x0 - 1)
          : s
              .slice()
              .reverse()
              .find((v) => v > x0 + 1);
      if (x != null) vp.setCamera({ x }, { animate: true, duration: 560 });
    }
    function visibleCols() {
      const L = geo;
      const k = vp.cam.k;
      const left = vp.cam.x < 0 ? -vp.cam.x / k + G.laneW : -vp.cam.x / k;
      const right = (visW() - vp.cam.x) / k;
      return L.cols.filter((c) => c.x >= left - 2 && c.x + G.colW <= right + 2);
    }
    function nav() {
      const L = geo;
      if (!L) return;
      const n = L.cols.length;
      const vis = visibleCols();
      const k = vp.cam.k;
      const right = (visW() - vp.cam.x) / k;
      const moreRight = L.totalW > right + 2;
      const all = vis.length === n && vp.cam.x >= 0;
      pager.classList.toggle("on", !all && n > 1);
      /* Fade only where a column is actually cut by the edge. With the
         inspector open the fade runs on under it, so nothing peeks out
         in the margin beside the panel. */
      const cut = L.cols.some((c) => c.x < right - 4 && c.x + G.colW > right + 2);
      const ins = host.clientWidth - visW();
      const under = ins > 0 && moreRight;
      fade.classList.toggle("on", cut || under);
      if (cut || under) {
        /* (when it switches off it keeps its shape and only fades) */
        fade.style.setProperty("--fb-fade", cut ? "56px" : "0px");
        fade.style.width = `${(cut ? 56 : 0) + (under ? ins : 0)}px`;
      }
      if (all) return;
      const a = vis[0]?.i + 1;
      const b = vis.at(-1)?.i + 1;
      const label = !vis.length
        ? `${n} branches`
        : a === b
          ? `${a} of ${n} branches`
          : `${a}–${b} of ${n} branches`;
      const pl = $(".fb-pg-l", pager);
      if (pl.textContent !== label) pl.textContent = label;
      $('[data-pg="-1"]', pager).disabled = vp.cam.x >= FIT.left - 1;
      $('[data-pg="1"]', pager).disabled = !moreRight;
    }
    vp.onChange(() => {
      stick();
      nav();
    });

    function rectOf(sel) {
      const L = geo;
      if (!L) return null;
      if (sel.kind === "thread") return L.rows.get(sel.id) ?? null;
      for (const ln of L.lanes) {
        /* A device brings its automations column into view: they are
           what the device runs. */
        if (sel.kind === "device" && ln.id === sel.id)
          return { x: L.X.auto, y: ln.top, w: G.autoW, h: ln.h };
        for (const ch of ln.chips) if (sel.kind === "auto" && ch.a.id === sel.id) return ch;
        for (const cell of ln.cells.values())
          if (sel.kind === "ws" && cell.w.id === sel.id)
            return { x: cell.x, y: cell.y, w: G.colW, h: cell.m.h };
      }
      if (sel.kind === "branch") {
        const c = L.cols.find((x) => x.key === sel.id);
        return c ? { x: c.x, y: 0, w: G.colW, h: G.headH } : null;
      }
      return null;
    }
    /* Keep the selection clear of the inspector and the frozen column. */
    function reveal(sel) {
      const r = rectOf(sel);
      if (!r) return;
      const k = vp.cam.k;
      const W = visW();
      const H = host.clientHeight;
      let x = vp.cam.x;
      let y = vp.cam.y;
      /* Land on the nearest horizontal stop that shows the target whole,
         clear of the frozen device column and of the inspector. */
      const shows = (v) =>
        r.x * k + v >= (v < 0 ? G.laneW * k : 0) - 1 && (r.x + r.w) * k + v <= W - 2;
      if (!shows(x)) {
        const good = stops().filter(shows);
        if (good.length)
          x = good.reduce((b, v) => (Math.abs(v - vp.cam.x) < Math.abs(b - vp.cam.x) ? v : b));
        else {
          const right = (r.x + r.w) * k + x;
          if (right > W - 16) x -= right - (W - 16);
          const frozen = x < 0 ? G.laneW * k : 0;
          if (r.x * k + x < frozen + 12) x = Math.min(FIT.left, frozen + 12 - r.x * k);
        }
      }
      const top = r.y * k + y;
      const bottom = (r.y + r.h) * k + y;
      if (bottom > H - FIT.bottom) y -= bottom - (H - FIT.bottom);
      if (top + (y - vp.cam.y) < FIT.top) y = FIT.top - r.y * k;
      if (Math.abs(x - vp.cam.x) > 1 || Math.abs(y - vp.cam.y) > 1)
        vp.setCamera({ x, y }, { animate: true, duration: 620 });
      else nav();
    }

    /* ---------------------------------------------------------- pointer
       Drag anywhere (cards too) to pan; a click without movement acts. */
    let drag = null;
    vp.nodes.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      const n = e.target.closest(".node");
      if (!n) return;
      drag = {
        sx: e.clientX,
        sy: e.clientY,
        cx: vp.cam.x,
        cy: vp.cam.y,
        moved: false,
        target: e.target,
      };
      n.setPointerCapture(e.pointerId);
    });
    vp.nodes.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.sx;
      const dy = e.clientY - drag.sy;
      if (!drag.moved && Math.hypot(dx, dy) < 4) return;
      drag.moved = true;
      host.classList.add("is-panning");
      vp.setCamera({ x: drag.cx + dx, y: drag.cy + dy });
    });
    vp.nodes.addEventListener("pointerup", () => {
      const d = drag;
      drag = null;
      host.classList.remove("is-panning");
      if (d && !d.moved) activate(d.target);
    });
    vp.nodes.addEventListener("pointercancel", () => {
      drag = null;
      host.classList.remove("is-panning");
    });
    function activate(target) {
      const ap = target.closest("[data-approve]");
      if (ap) return approve(ap.dataset.approve);
      const slot = target.closest(".fb-slot");
      if (slot) {
        if (slot.dataset.lane) apiRef.select({ kind: "device", id: slot.dataset.lane });
        else if (!slot.classList.contains("off"))
          checkOut(slot.dataset.checkout, slot.dataset.branch);
        return;
      }
      const s = target.closest("[data-select]");
      if (!s) return;
      const i = s.dataset.select.indexOf(":");
      apiRef.select({ kind: s.dataset.select.slice(0, i), id: s.dataset.select.slice(i + 1) });
    }

    /* Hover: cross-light the lane and the column under the pointer (from
       the node under it, or from geometry over empty canvas). */
    host.addEventListener("pointermove", (e) => {
      if (drag || !geo) return;
      const node = e.target.closest?.(".vp-nodes .node");
      let lane = null;
      let col = null;
      let auto = null;
      const d = node?._data;
      if (d) {
        lane = d.lane ?? null;
        col = d.col ?? null;
        auto = d.auto ?? null;
      } else if (!e.target.closest?.(".vp-ui")) {
        const p = vp.toWorld(e.clientX, e.clientY);
        const ln = p.y > G.headH ? geo.lanes.find((x) => p.y >= x.top && p.y < x.top + x.h) : null;
        lane = ln?.id ?? null;
        if (p.y >= 0 && p.y < geo.totalH) {
          if (p.x >= geo.X.auto - 6 && p.x < geo.X.auto + G.autoW + 6) col = "@auto";
          else
            col =
              geo.cols.find((c) => p.x >= c.x - G.gx / 2 && p.x < c.x + G.colW + G.gx / 2)?.key ??
              null;
        }
      }
      const thread = e.target.closest?.(".fb-row[data-thread]")?.dataset.thread ?? null;
      if (lane === st.hLane && col === st.hCol && auto === st.hAuto && thread === st.hThread)
        return;
      Object.assign(st, { hLane: lane, hCol: col, hAuto: auto, hThread: thread });
      paintFocus();
    });
    host.addEventListener("pointerleave", () => {
      Object.assign(st, { hLane: null, hCol: null, hAuto: null, hThread: null });
      paintFocus();
    });

    /* The canvas turns every wheel into a pan; let a long inspector
       scroll itself instead. */
    insp.panel.addEventListener("wheel", (e) => e.ctrlKey || e.metaKey || e.stopPropagation(), {
      passive: true,
    });
    insp.panel.addEventListener("click", (e) => {
      const ap = e.target.closest("[data-approve-id]");
      if (ap) return approve(ap.dataset.approveId);
      const rj = e.target.closest("[data-reject-id]");
      if (rj) return reject(rj.dataset.rejectId);
      const co = e.target.closest("[data-checkout]");
      if (co) {
        if (!co.disabled) checkOut(co.dataset.checkout, co.dataset.branch);
        return;
      }
      const s = e.target.closest("[data-select]");
      if (!s) return;
      const i = s.dataset.select.indexOf(":");
      apiRef.select({ kind: s.dataset.select.slice(0, i), id: s.dataset.select.slice(i + 1) });
    });

    return {
      update() {
        render();
        if (firstPaint) {
          firstPaint = false;
          fit(false);
          stick();
          nav();
        }
      },
      destroy() {
        destroyed = true;
        vp.destroy();
      },
    };
  }

  DIRS.B = {
    title: "B · Lanes",
    thesis:
      "A matrix that answers <b>where is what</b> in one look. Every device is a swimlane (its checkout folder and connection on the left), every branch is a column, so the same branch on two devices sits in <b>one column across two lanes</b>. A cell is that device's workspace for the branch, or a faint slot where it isn't checked out. Each lane opens with the automations its device runs, so which machine fires which schedule, when it fires next, what it starts and whether a run waits for approval is read in the same glance.",
    notes: [
      [
        "Reading it",
        [
          "<b>Rows are devices, columns are branches.</b> main comes first, then branches on more than one device (projects-page: one column, two cards, joined by a violet tick), then the rest by recent activity. Archived branches sit at the far end.",
          "<b>The column header owns the branch</b>: its name, the PR, issue or Jira item it came from, “on 2 devices”, or the automation that made it. A card only says what is true on that device: uncommitted or unmerged work, a missing or removed checkout, and its threads.",
          "<b>A dashed slot</b> means the branch is not on that device. Hover it and it offers to check the branch out there; click and it does (not while the device is still connecting).",
          "<b>Automations</b> open the lane of the device that runs them, titles in full. The ring fills as the next run nears; a due run turns amber with an Approve pill; a running one says so. A teal clock marks every thread an automation started; hover or select either end and a teal wire follows the lane's gutters between them.",
        ],
      ],
      [
        "Moving around",
        [
          "Drag anywhere to pan, ⌘-scroll to zoom, double-click to fit. The device column and the branch headers stay pinned like a spreadsheet's frozen panes, and a device's name rides down its lane, so a far-off cell still says which device and branch it is.",
          "The fit never drops below about 71% so text stays legible; a project with many branches pages sideways instead. The pager (top right) says which branches are in view and steps one whole column at a time.",
          "Hovering cross-lights a cell's lane and column. Click a branch header to compare that branch across devices; click a lane header for the device and its schedules (its automations column slides back into view). Selections stay clear of the inspector.",
          "<b>Threads</b> folds every stack into a tally and the lanes glide shut; <b>Archived</b> hides archived branches and threads.",
        ],
      ],
      [
        "Live",
        [
          "At 0:07 the Studio opens #671 in a worktree: a column is inserted after the shared ones, its neighbours glide aside and the card grows into its cell with a short blue ring.",
          "At the same moment “Triage new issues” comes due. Approve it on the chip or in its inspector (or wait for 0:09): its thread slides in at the top of the MacBook's main checkout, and a flowing teal wire joins them until the run completes.",
          "Dots recolour in place; when hub-eu-1 connects, its lane comes up to full strength; a removed checkout keeps its card and its edge turns dashed.",
        ],
      ],
    ],
    mount,
  };
})();
