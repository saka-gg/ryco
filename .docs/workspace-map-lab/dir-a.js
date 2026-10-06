/* ============================================================
   A · Flow — an n8n-style node canvas. The project sits on top;
   each device is a column, its workspaces and automations hang off
   one trunk, and a workspace's threads fan out under it on demand.
   Wires carry a slow dash where a turn is running, so "where is
   work happening" is visible from across the room. Hover lights a
   lineage; click inspects; drag rearranges; Tidy snaps back.
   ============================================================ */
(() => {
  const IND = 34; // child indent from its parent's trunk
  const TRUNK = 18; // trunk x inside a parent
  const W = { project: 300, device: 302, ws: 268, auto: 268, thread: 234 };
  const H = { ws: 66, auto: 66, thread: 34, label: 24 };
  const COL = 384; // column pitch (one device per column)
  const Y = { device: 176, items: 290 };
  const GAP = { item: 10, thread: 6, section: 16 };

  const KIND_PREFIX = { project: "p", device: "d", ws: "w", auto: "a", thread: "t" };
  const statusOrder = { working: 0, input: 1, error: 2, done: 3, idle: 4, archived: 5 };

  /* ports: where wires plug in — "top", "left", "right", "bottom", "trunk" (bottom, at the trunk). */
  function nodeHtml(kind, body, opts = {}) {
    return `<div class="fa-node fa-${kind} ${opts.cls ?? ""}" style="--w:${W[kind]}px">
      ${(opts.ports ?? []).map((p) => `<i class="fa-port p-${p}"></i>`).join("")}
      ${body}
    </div>`;
  }

  function projectNode(p, ix) {
    const active = ix.workspaces.filter((w) => !w.archived).length;
    const live = ix.threads.filter((x) => x.status !== "archived").length;
    return nodeHtml(
      "project",
      `<div class="fa-h"><span class="pav" style="--hue:${p.hue}">${esc(p.name[0].toUpperCase())}</span>
         <span class="fa-title">${esc(p.name)}</span></div>
       <div class="fa-meta"><span class="mono">${esc(p.repo ?? "Local folder")}</span></div>
       <div class="fa-stats">
         <div><b>${ix.devices.length}</b><span>devices</span></div>
         <div><b>${active}</b><span>workspaces</span></div>
         <div><b>${live}</b><span>threads</span></div>
       </div>`,
      { ports: ["bottom"] },
    );
  }

  function deviceNode(d) {
    const conn = d.conn ?? "online";
    return nodeHtml(
      "device",
      `<div class="fa-h">${ic(d.icon)}<span class="fa-title">${esc(d.name)}</span><span class="fa-sp"></span>
         ${d.self ? '<span class="fa-self">This device</span>' : `<span class="fa-conn c-${conn}"><i></i>${conn === "online" ? "Online" : conn === "connecting" ? "Connecting" : "Offline"}</span>`}</div>
       <div class="fa-meta"><span class="mono" data-tip="Checkout folder">${esc(d.checkout.path)}</span></div>`,
      { ports: ["top", "trunk"] },
    );
  }

  function wsNode(p, w, expanded) {
    const title = w.main ? (w.branch ? "Main checkout" : "Folder") : w.branch;
    /* Threads fold into a tally; the tally is the toggle that fans them out. */
    const tallyHtml = w.threads.length
      ? `<button type="button" class="fa-tally" data-expand="${w.id}" aria-expanded="${expanded}" data-tip="${expanded ? "Fold threads" : "Show threads"}">${w.threads
          .slice()
          .sort((a, b) => statusOrder[a.status] - statusOrder[b.status])
          .slice(0, 5)
          .map((x) => statusDot(x.status))
          .join(
            "",
          )}<span class="fa-count">${w.threads.length}</span>${ic("chevR", "fa-chev")}</button>`
      : "";
    const facts = factsHtml(w);
    /* The tally already says how many threads; text only says "none". */
    const meta = [
      w.main && w.branch ? `<span class="fact mono">${esc(w.branch)}</span>` : "",
      !w.main && !facts && !w.threads.length ? '<span class="fact">No threads</span>' : "",
      facts,
    ]
      .filter(Boolean)
      .join("");
    return nodeHtml(
      "ws",
      `<div class="fa-h">${ic(w.main ? "folder" : "branch")}<span class="fa-title">${esc(title)}</span><span class="fa-sp"></span>${originMark(p, w)}</div>
       <div class="fa-meta"><span class="fa-facts">${meta || '<span class="fact">Clean</span>'}</span>${tallyHtml}</div>`,
      {
        ports: expanded && w.threads.length ? ["left", "trunk"] : ["left"],
        cls: `${w.main ? "main" : ""} ${w.archived ? "archived" : ""} ${w.fresh ? "fresh" : ""}`,
      },
    );
  }

  function threadNode(th) {
    return `<div class="fa-node fa-thread s-${th.status}" style="--w:${W.thread}px"><i class="fa-port p-left"></i>
      ${statusDot(th.status)}<span class="fa-title">${esc(th.title)}</span>${providerMark(th.provider)}<span class="ago">${agoLabel(th.ago)}</span></div>`;
  }

  /* Countdown ring: how much of the interval has passed. */
  function ring(a) {
    const r = 9;
    const c = 2 * Math.PI * r;
    const done = a.enabled ? cycle(a) : 0;
    return `<svg class="fa-ring" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="${r}" class="track"/>
      <circle cx="12" cy="12" r="${r}" class="prog" style="stroke-dasharray:${c};stroke-dashoffset:${c * (1 - done)}"/>
      <path d="M12 8v4l2.5 1.5" class="hand"/></svg>`;
  }

  function autoNode(a) {
    const run = activeRun(a);
    const last = a.runs.find(
      (r) => !["pending-approval", "approved", "executing"].includes(r.status),
    );
    const state = !a.enabled
      ? '<span class="fact">Paused</span>'
      : run?.status === "pending-approval"
        ? '<button type="button" class="fa-approve" data-approve="1">Approve run</button>'
        : run
          ? `<span class="fa-running">${statusDot("working")}Running</span>`
          : `<span class="fa-next tnum">${inLabel(a.nextIn)}</span>`;
    const lastFact =
      !run && last?.status === "failed" ? '<span class="fact f-warn">Last run failed</span>' : "";
    return nodeHtml(
      "auto",
      `<div class="fa-h">${ring(a)}<span class="fa-title">${esc(a.title)}</span><span class="fa-sp"></span>${state}</div>
       <div class="fa-meta"><span class="fact">${esc(scheduleLabel(a))}</span><span class="fact">${a.envMode === "worktree" ? "New worktree each run" : "Main checkout"}</span>${lastFact}</div>`,
      {
        ports: a.runs.some((r) => r.threads.length) ? ["left", "right"] : ["left"],
        cls: `${a.enabled ? "" : "paused"} ${run?.status === "pending-approval" ? "due" : ""}`,
      },
    );
  }

  /* ---------------------------------------------------------- layout
     Project on top, one column per device. Under each device a trunk
     carries its workspaces, then its automations; an expanded
     workspace carries its threads on a trunk of its own. */
  function layout(ix, o) {
    const nodes = [];
    const parent = {};
    const labels = [];
    const devs = ix.devices.filter((d) => !o.hidden.has(d.id));
    const width = devs.length ? (devs.length - 1) * COL + W.device : W.project;
    const pKey = `p:${ix.p.id}`;
    nodes.push({ key: pKey, kind: "project", ref: ix.p, x: width / 2 - W.project / 2, y: 0 });
    devs.forEach((d, i) => {
      const cx = i * COL;
      const dKey = `d:${d.checkout.id}`;
      nodes.push({ key: dKey, kind: "device", ref: d, x: cx, y: Y.device });
      parent[dKey] = pKey;
      let y = Y.items;
      for (const w of d.checkout.workspaces.filter((x) => o.showArchived || !x.archived)) {
        const wKey = `w:${w.id}`;
        nodes.push({ key: wKey, kind: "ws", ref: w, x: cx + IND, y });
        parent[wKey] = dKey;
        y += H.ws;
        const threads = o.expanded.has(w.id)
          ? w.threads.filter((x) => o.showArchived || x.status !== "archived")
          : [];
        if (threads.length) y += GAP.thread + 2;
        for (const th of threads) {
          const tKey = `t:${th.id}`;
          nodes.push({ key: tKey, kind: "thread", ref: th, ws: w, x: cx + IND * 2, y });
          parent[tKey] = wKey;
          y += H.thread + GAP.thread;
        }
        y += GAP.item;
      }
      const autos = o.showAutomations ? (d.checkout.automations ?? []) : [];
      if (autos.length) {
        y += GAP.section - GAP.item;
        labels.push({
          key: `lbl:auto:${d.checkout.id}`,
          x: cx + IND,
          y,
          html: `<span class="fa-section">${ic("clock2")}Automations</span>`,
        });
        y += H.label;
        for (const a of autos) {
          const aKey = `a:${a.id}`;
          nodes.push({ key: aKey, kind: "auto", ref: a, x: cx + IND, y });
          parent[aKey] = dKey;
          y += H.auto + GAP.item;
        }
      }
    });
    for (const n of nodes) {
      const off = o.offsets.get(n.key);
      if (off) {
        n.x += off.dx;
        n.y += off.dy;
      }
      n.x = Math.round(n.x);
      n.y = Math.round(n.y);
    }
    return { nodes, parent, labels };
  }

  /* Wire from a parent's trunk down to a child's left side: a vertical
     line that turns into the child with a small radius (file-tree style). */
  function trunk(parentRect, childRect) {
    const tx = parentRect.x + TRUNK;
    const sy = parentRect.y + parentRect.h;
    const iy = childRect.y + childRect.h / 2;
    const ix = childRect.x;
    const r = Math.min(12, Math.max(0, iy - sy));
    return `M ${tx} ${sy} L ${tx} ${iy - r} Q ${tx} ${iy} ${tx + r} ${iy} L ${ix} ${iy}`;
  }

  function lineage(key, parent) {
    const lit = new Set([key]);
    for (let k = parent[key]; k; k = parent[k]) lit.add(k);
    let grew = true;
    while (grew) {
      grew = false;
      for (const [child, par] of Object.entries(parent))
        if (lit.has(par) && !lit.has(child) && !isAncestor(child, key, parent)) {
          if (descends(child, key, parent)) {
            lit.add(child);
            grew = true;
          }
        }
    }
    return lit;
  }
  const isAncestor = (maybe, key, parent) => {
    for (let k = parent[key]; k; k = parent[k]) if (k === maybe) return true;
    return false;
  };
  const descends = (child, key, parent) => {
    for (let k = child; k; k = parent[k]) if (k === key) return true;
    return false;
  };

  /* ---------------------------------------------------------- inspector */
  function inspectorHtml(sel, ix) {
    const p = ix.p;
    if (sel.kind === "project") {
      return `<div class="fi-kind">${ic("folder")}Project</div>
        <div class="fi-title">${esc(p.name)}</div><div class="fi-sub mono">${esc(p.repo ?? "Local folder")}</div>
        <div class="fi-sec"><h4>On ${ix.devices.length} device${ix.devices.length === 1 ? "" : "s"}</h4>
          ${ix.devices.map((d) => `<div class="fi-thread" data-select="device:${d.checkout.id}">${ic(d.icon)}<span class="trunc">${esc(d.name)}</span><span class="dim mono">${esc(d.checkout.path)}</span></div>`).join("")}</div>
        <div class="fi-actions"><button class="fi-btn primary">${ic("plus")}New thread</button><button class="fi-btn">${ic("pr")}Pull requests</button></div>`;
    }
    if (sel.kind === "device") {
      const d = ix.devices.find((x) => x.checkout.id === sel.id);
      if (!d) return null;
      return `<div class="fi-kind">${ic(d.icon)}Device · checkout</div>
        <div class="fi-title">${esc(d.name)}</div><div class="fi-sub">${d.self ? "This device" : esc(d.via ?? "")}</div>
        <dl class="fi-rows"><dt>Folder</dt><dd class="mono">${esc(d.checkout.path)}</dd><dt>System</dt><dd>${esc(d.os)}</dd>
          <dt>Connection</dt><dd>${d.self ? "Local" : esc(d.conn)}</dd></dl>
        <div class="fi-sec"><h4>Workspaces</h4>
          ${d.checkout.workspaces.map((w) => `<div class="fi-thread" data-select="ws:${w.id}">${ic(w.main ? "folder" : "branch")}<span class="trunc ${w.main ? "" : "mono"}">${esc(w.main ? "Main checkout" : w.branch)}</span>${originMark(p, w)}</div>`).join("")}</div>
        ${d.checkout.automations?.length ? `<div class="fi-sec"><h4>Automations</h4>${d.checkout.automations.map((a) => `<div class="fi-thread" data-select="auto:${a.id}">${ic("clock2")}<span class="trunc">${esc(a.title)}</span><span class="dim tnum">${a.enabled ? esc(inLabel(a.nextIn)) : "Paused"}</span></div>`).join("")}</div>` : ""}
        <div class="fi-actions"><button class="fi-btn">${ic("branch")}New worktree</button><button class="fi-btn">${ic("clock2")}New automation</button></div>`;
    }
    if (sel.kind === "ws") {
      const w = ix.workspaces.find((x) => x.id === sel.id);
      if (!w) return null;
      const d = DEVICES[w.device];
      const pr = w.origin?.kind === "pr" ? p.prs[w.origin.ref] : null;
      const twins = (ix.byBranch[w.branch] ?? []).filter((x) => x.id !== w.id && !w.main);
      return `<div class="fi-kind">${ic(w.main ? "folder" : "branch")}${w.main ? "Main checkout" : "Worktree"}</div>
        <div class="fi-title ${w.main ? "" : "mono"}">${esc(w.main ? (w.branch ?? "Folder") : w.branch)}</div>
        <div class="fi-sub">${factsHtml(w) || "Clean and up to date"}</div>
        <dl class="fi-rows">
          <dt>Device</dt><dd>${esc(d.name)}</dd>
          <dt>Path</dt><dd class="mono">${esc(w.path)}</dd>
          ${pr ? `<dt>From</dt><dd>${originMark(p, w)} ${esc(pr.title)} · <span class="dim">${pr.state}, checks ${pr.checks}</span></dd>` : w.origin ? `<dt>From</dt><dd>${originMark(p, w)}</dd>` : ""}
          ${twins.length ? `<dt>Also on</dt><dd>${twins.map((x) => `<span class="fi-link" data-select="ws:${x.id}">${esc(DEVICES[x.device].name)}</span>`).join(", ")}</dd>` : ""}
        </dl>
        <div class="fi-sec"><h4>Threads</h4>
          ${w.threads.length ? w.threads.map((th) => `<div class="fi-thread" data-select="thread:${th.id}">${statusDot(th.status)}<span class="trunc">${esc(th.title)}</span><span class="dim tnum">${agoLabel(th.ago)}</span></div>`).join("") : '<div class="dim">No threads yet.</div>'}</div>
        <div class="fi-actions">
          ${w.checkoutRemoved ? `<button class="fi-btn">${ic("folderMinus")}Recreate checkout…</button>` : `<button class="fi-btn primary">${ic("plus")}New thread</button>`}
          ${w.main ? "" : w.archived ? `<button class="fi-btn">${ic("archive")}Restore</button>` : `<button class="fi-btn">${ic("archive")}Archive</button>`}
          ${w.main || w.checkoutRemoved ? "" : `<button class="fi-btn danger">${ic("folderMinus")}Remove checkout…</button>`}
        </div>`;
    }
    if (sel.kind === "auto") {
      const a = ix.automations.find((x) => x.id === sel.id);
      if (!a) return null;
      const run = activeRun(a);
      return `<div class="fi-kind">${ic("clock2")}Automation${a.enabled ? "" : " · paused"}</div>
        <div class="fi-title">${esc(a.title)}</div>
        <div class="fi-sub">${esc(scheduleLabel(a))}</div>
        ${run?.status === "pending-approval" ? `<div class="fi-due">${ic("shield")}<span>A run is due and waits for your approval.</span><button class="fi-btn primary" data-approve-id="${a.id}">Approve</button><button class="fi-btn">Reject</button></div>` : ""}
        <dl class="fi-rows">
          <dt>Runs on</dt><dd>${esc(DEVICES[a.device].name)}</dd>
          <dt>Next run</dt><dd>${a.enabled ? esc(inLabel(a.nextIn)) : "Paused"}</dd>
          <dt>Where</dt><dd>${a.envMode === "worktree" ? `A new worktree off <span class="mono">${esc(a.baseRef ?? "main")}</span> each run` : "The main checkout"}</dd>
          <dt>Agent</dt><dd>${providerMark(a.provider)} ${PROVIDERS[a.provider]?.name ?? a.provider}</dd>
        </dl>
        <div class="fi-sec"><h4>Recent runs</h4>
          ${a.runs.length ? a.runs.map((r) => `<div class="fi-thread" ${r.threads[0] ? `data-select="thread:${r.threads[0]}"` : ""}><span class="fi-run r-${r.status}"></span><span class="trunc">${RUN_STATUS[r.status]?.label ?? r.status}${r.detail ? ` · <span class="dim">${esc(r.detail)}</span>` : ""}</span><span class="dim tnum">${agoLabel(r.ago)}</span></div>`).join("") : '<div class="dim">No runs yet.</div>'}</div>
        <div class="fi-actions"><button class="fi-btn">${ic("play")}Run now</button><button class="fi-btn">${a.enabled ? ic("pause") + "Pause" : ic("play") + "Resume"}</button><button class="fi-btn">${ic("edit")}Edit</button></div>`;
    }
    if (sel.kind === "thread") {
      const th = ix.threads.find((x) => x.id === sel.id);
      if (!th) return null;
      const w = ix.workspaces.find((x) => x.id === th.workspaceId);
      return `<div class="fi-kind">${statusDot(th.status)}Thread · ${STATUS[th.status].label}</div>
        <div class="fi-title">${esc(th.title)}</div>
        <dl class="fi-rows">
          <dt>Agent</dt><dd>${providerMark(th.provider)} ${PROVIDERS[th.provider]?.name ?? th.provider}</dd>
          <dt>Workspace</dt><dd><span class="fi-link mono" data-select="ws:${w.id}">${esc(w.main ? "Main checkout" : w.branch)}</span></dd>
          <dt>Device</dt><dd>${esc(DEVICES[th.device].name)}</dd>
          <dt>Activity</dt><dd>${agoLabel(th.ago)} ago</dd>
          ${th.by ? `<dt>Started by</dt><dd><span class="fi-link" data-select="auto:${th.by}">${esc(ix.automations.find((a) => a.id === th.by)?.title ?? "an automation")}</span></dd>` : ""}
        </dl>
        <div class="fi-actions"><button class="fi-btn primary">${ic("open")}Open thread</button></div>`;
    }
    return null;
  }

  /* ---------------------------------------------------------- mount */
  function mount(host, apiRef) {
    const state = {
      hidden: new Set(),
      collapsed: false,
      showArchived: true,
      showAutomations: true,
      expanded: new Set(),
      offsets: new Map(),
      hover: null,
      projectId: null,
      parent: {},
      drag: null,
    };
    const vp = createViewport(host, {
      onFit: () => fitAll(true),
      onBackgroundClick: () => S.selected && apiRef.select(null),
    });
    vp.controls();
    const minimap = createMinimap(vp, () => vp.nodes._nodes ?? new Map());
    const insp = createInspector(host, { onClose: () => apiRef.select(null) });
    const tools = h("div", "vp-ui fa-tools");
    host.append(tools);
    /* Statuses explain themselves (tooltips on every dot); the legend only
       names the three kinds of wire. */
    const legend = h(
      "div",
      "vp-ui legend",
      `<span><svg width="22" height="6"><path d="M1 3h20" stroke="var(--info)" stroke-dasharray="2 5" stroke-linecap="round" stroke-width="1.6"/></svg>Running</span><span><svg width="22" height="6"><path d="M1 3h20" stroke="var(--violet)" stroke-dasharray="3 4" stroke-width="1.5"/></svg>Same branch</span><span><svg width="22" height="6"><path d="M1 3h20" stroke="var(--teal)" stroke-dasharray="1 4" stroke-linecap="round" stroke-width="2"/></svg>Started by automation</span>`,
    );
    host.append(legend);

    function paintTools(ix) {
      tools.innerHTML = `${ix.devices
        .map(
          (d) =>
            `<button type="button" class="fa-chip" data-dev="${d.id}" aria-pressed="${!state.hidden.has(d.id)}">${ic(d.icon)}${esc(d.name)}</button>`,
        )
        .join("")}<span class="fa-sep"></span>
        <button type="button" class="fa-chip" data-t="threads" aria-pressed="${state.expanded.size > 0}">${ic("msg")}Threads</button>
        <button type="button" class="fa-chip" data-t="automations" aria-pressed="${state.showAutomations}">${ic("clock2")}Automations</button>
        <button type="button" class="fa-chip" data-t="archived" aria-pressed="${state.showArchived}">${ic("archive")}Archived</button>
        <button type="button" class="fa-chip" data-t="tidy" data-tip="Undo manual moves">${ic("layers")}Tidy</button>`;
    }
    tools.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      if (b.dataset.dev) {
        const id = b.dataset.dev;
        state.hidden.has(id) ? state.hidden.delete(id) : state.hidden.add(id);
      } else if (b.dataset.t === "threads") {
        const all = index().workspaces.filter((w) => w.threads.length);
        const open = all.every((w) => state.expanded.has(w.id));
        state.expanded = open ? new Set() : new Set(all.map((w) => w.id));
      } else if (b.dataset.t === "archived") state.showArchived = !state.showArchived;
      else if (b.dataset.t === "automations") state.showAutomations = !state.showAutomations;
      else if (b.dataset.t === "tidy") state.offsets.clear();
      render();
      if (b.dataset.t !== "archived") fitAll(true);
    });

    let last = null;
    function render(opts = {}) {
      const ix = index();
      const projectChanged = state.projectId !== ix.p.id;
      if (projectChanged) {
        state.projectId = ix.p.id;
        state.hidden.clear();
        state.offsets.clear();
        state.expanded.clear();
      }
      paintTools(ix);
      const { nodes, parent, labels: sectionLabels } = layout(ix, state);
      state.parent = parent;
      const sel = S.selected;
      const selKey = sel ? `${KIND_PREFIX[sel.kind] ?? "p"}:${sel.id}` : null;
      const focusKey = state.hover ?? selKey;
      const lit =
        (focusKey && parent[focusKey] !== undefined) || focusKey?.startsWith("p:")
          ? lineage(focusKey, parent)
          : null;
      /* An automation and the threads it started light together. */
      if (lit)
        for (const a of ix.automations)
          for (const run of a.runs)
            for (const tid of run.threads) {
              if (focusKey === `a:${a.id}`) {
                lit.add(`t:${tid}`);
                const th = ix.threads.find((x) => x.id === tid);
                if (th) lit.add(`w:${th.workspaceId}`);
              }
              if (focusKey === `t:${tid}`) lit.add(`a:${a.id}`);
            }
      if (lit) host.dataset.focus = focusKey;
      else delete host.dataset.focus;

      const items = nodes.map((n) => ({
        key: n.key,
        x: n.x,
        y: n.y,
        cls: `${lit?.has(n.key) ? "lit" : ""} ${n.key === selKey ? "is-selected" : ""} ${state.drag?.key === n.key ? "is-dragging" : ""}`,
        html:
          n.kind === "project"
            ? projectNode(n.ref, ix)
            : n.kind === "device"
              ? deviceNode(n.ref)
              : n.kind === "ws"
                ? wsNode(ix.p, n.ref, state.expanded.has(n.ref.id))
                : n.kind === "auto"
                  ? autoNode(n.ref)
                  : threadNode(n.ref),
      }));
      const store = syncNodes(vp.nodes, items, {
        stagger: 28,
        noEnter: opts.noEnter,
        enter: (el, item, i, delay) =>
          el.animate(
            [
              { opacity: 0, translate: "0 -10px" },
              { opacity: 1, translate: "0 0" },
            ],
            {
              duration: 520,
              delay: projectChanged ? i * 22 : 120,
              easing: EASE,
              fill: "backwards",
            },
          ),
      });

      /* Wires */
      const rect = (k) => store.get(k);
      const edges = [];
      const working = (key) => {
        const n = nodes.find((x) => x.key === key);
        if (!n) return false;
        if (n.kind === "thread") return n.ref.status === "working";
        if (n.kind === "ws") return n.ref.threads.some((x) => x.status === "working");
        if (n.kind === "auto") return activeRun(n.ref)?.status === "executing";
        if (n.kind === "device")
          return n.ref.checkout.workspaces.some((w) =>
            w.threads.some((x) => x.status === "working"),
          );
        return false;
      };
      for (const [child, par] of Object.entries(parent)) {
        const a = rect(par);
        const b = rect(child);
        if (!a || !b) continue;
        const childNode = nodes.find((x) => x.key === child);
        const archived =
          (childNode?.kind === "ws" && childNode.ref.archived) ||
          (childNode?.kind === "thread" && childNode.ref.status === "archived") ||
          (childNode?.kind === "auto" && !childNode.ref.enabled);
        const hot = lit && lit.has(child) && lit.has(par);
        edges.push({
          key: `${par}>${child}`,
          d:
            childNode?.kind === "device"
              ? curve(port(a, "bottom"), port(b, "top"), "v")
              : trunk(a, b),
          cls: [
            working(child) && !archived ? "flow" : "",
            archived ? "dashed" : "",
            childNode?.kind === "auto" ? "fa-auto-wire" : "",
            hot ? "hot" : lit ? "dim" : "",
          ].join(" "),
        });
      }
      /* Same branch on two devices: a violet arc from one column to the next. */
      const linkLabels = [];
      for (const [branch, list] of Object.entries(ix.shared)) {
        const shown = list
          .filter((w) => store.has(`w:${w.id}`))
          .sort((x, y) => rect(`w:${x.id}`).x - rect(`w:${y.id}`).x);
        for (let i = 1; i < shown.length; i++) {
          const a = rect(`w:${shown[i - 1].id}`);
          const b = rect(`w:${shown[i].id}`);
          const pa = port(a, "right");
          const pb = { x: b.x - 6, y: b.y + b.h / 2 };
          edges.push({
            key: `same:${branch}:${i}`,
            d: curve(pa, pb, "h", 0.55),
            cls: `fa-same ${lit && !(lit.has(`w:${shown[i - 1].id}`) || lit.has(`w:${shown[i].id}`)) ? "dim" : ""}`,
          });
          linkLabels.push({
            key: `lbl:${branch}:${i}`,
            x: Math.round((pa.x + pb.x) / 2),
            y: Math.round((pa.y + pb.y) / 2),
            html: `<span class="fa-link" data-tip="${esc(branch)} is checked out on both devices">same branch</span>`,
          });
        }
      }
      /* Started by an automation: a teal dotted arc on the column's right,
         from the automation to each thread its runs created (to the thread's
         workspace while its threads are folded). */
      for (const n of nodes) {
        if (n.kind !== "auto") continue;
        const a = rect(n.key);
        for (const run of n.ref.runs)
          for (const tid of run.threads) {
            const th = ix.threads.find((x) => x.id === tid);
            if (!th) continue;
            const targetKey = store.has(`t:${tid}`) ? `t:${tid}` : `w:${th.workspaceId}`;
            const b = rect(targetKey);
            if (!a || !b) continue;
            const pa = port(a, "right");
            const pb = port(b, "right");
            const bulge = 34 + Math.min(70, Math.abs(pa.y - pb.y) * 0.12);
            const hot = lit && (lit.has(n.key) || lit.has(`t:${tid}`));
            edges.push({
              key: `run:${n.ref.id}>${tid}`,
              d: `M ${pa.x} ${pa.y} C ${pa.x + bulge} ${pa.y}, ${pb.x + bulge} ${pb.y}, ${pb.x} ${pb.y}`,
              cls: `fa-run ${run.status === "executing" ? "flow" : ""} ${hot ? "hot" : lit ? "dim" : ""}`,
            });
          }
      }
      syncEdges(vp.edges, edges, {
        stagger: projectChanged ? 14 : 0,
        delay: projectChanged ? 160 : 160,
        noEnter: opts.noEnter,
      });
      syncLabels([
        ...sectionLabels.map((l) => ({ ...l, cls: lit ? "dim" : "" })),
        ...linkLabels.map((l) => ({ ...l, cls: "" })),
      ]);

      /* Inspector */
      if (sel) {
        const html = inspectorHtml(sel, ix);
        if (html) insp.show(`${sel.kind}:${sel.id}`, html);
        else insp.hide();
      } else insp.hide();

      minimap.draw();
      last = { ix, store };
      if (projectChanged) requestAnimationFrame(() => fitAll(!opts.first));
    }

    const labels = h("div", "fa-labels");
    vp.world.append(labels);
    function syncLabels(items) {
      syncNodes(labels, items, { noEnter: false });
    }

    function fitAll(animate) {
      const b = boundsOf(vp.nodes._nodes ?? new Map());
      if (!b) return;
      const inspOpen = insp.panel.classList.contains("open");
      vp.fit({ ...b, w: b.w + (inspOpen ? 340 / vp.cam.k : 0) }, { padding: 72, animate, maxK: 1 });
    }

    /* Bring a selected node into view when the inspector would cover it. */
    function reveal(key, withChildren) {
      const store = vp.nodes._nodes;
      let r = store?.get(key);
      if (!r) return;
      if (withChildren) {
        const kids = [...store.keys()].filter((k) => state.parent[k] === key);
        const b = boundsOf(store, [key, ...kids]);
        if (b) r = b;
      }
      const k = vp.cam.k;
      const sx = r.x * k + vp.cam.x;
      const sy = r.y * k + vp.cam.y;
      const right = host.clientWidth - 350;
      let dx = 0;
      let dy = 0;
      if (sx + r.w * k > right) dx = right - (sx + r.w * k) - 24;
      if (sx < 24) dx = 24 - sx;
      if (sy < 60) dy = 60 - sy;
      if (sy + r.h * k > host.clientHeight - 70) dy = host.clientHeight - 70 - (sy + r.h * k);
      if (dx || dy)
        vp.setCamera({ x: vp.cam.x + dx, y: vp.cam.y + dy }, { animate: true, duration: 620 });
    }

    /* Hover lineage */
    vp.nodes.addEventListener("pointerover", (e) => {
      const n = e.target.closest(".node");
      const key = n?.dataset.key ?? null;
      if (key === state.hover || state.drag) return;
      state.hover = key;
      render({ noEnter: true });
    });
    vp.nodes.addEventListener("pointerleave", () => {
      if (!state.hover) return;
      state.hover = null;
      render({ noEnter: true });
    });

    /* Click to select, drag to move */
    vp.nodes.addEventListener("pointerdown", (e) => {
      const n = e.target.closest(".node");
      if (!n || e.button !== 0) return;
      e.stopPropagation();
      if (e.target.closest("[data-approve]")) {
        approve(n.dataset.key.slice(2));
        return;
      }
      const toggle = e.target.closest("[data-expand]");
      if (toggle) {
        const id = toggle.dataset.expand;
        state.expanded.has(id) ? state.expanded.delete(id) : state.expanded.add(id);
        render();
        requestAnimationFrame(() => reveal(`w:${id}`, true));
        return;
      }
      const key = n.dataset.key;
      const rec = vp.nodes._nodes.get(key);
      state.drag = {
        key,
        sx: e.clientX,
        sy: e.clientY,
        x0: rec.x,
        y0: rec.y,
        moved: false,
        base: state.offsets.get(key) ?? { dx: 0, dy: 0 },
      };
      n.setPointerCapture(e.pointerId);
    });
    vp.nodes.addEventListener("pointermove", (e) => {
      const d = state.drag;
      if (!d) return;
      const dx = (e.clientX - d.sx) / vp.cam.k;
      const dy = (e.clientY - d.sy) / vp.cam.k;
      if (!d.moved && Math.hypot(dx, dy) < 4) return;
      d.moved = true;
      host.classList.add("fa-dragging");
      state.offsets.set(d.key, { dx: d.base.dx + dx, dy: d.base.dy + dy });
      const was = motion;
      motion = false;
      render({ noEnter: true });
      motion = was;
    });
    vp.nodes.addEventListener("pointerup", () => {
      const d = state.drag;
      state.drag = null;
      host.classList.remove("fa-dragging");
      if (!d) return;
      if (d.moved) {
        render({ noEnter: true });
        return;
      }
      const [k, id] = [d.key[0], d.key.slice(2)];
      const kind = { p: "project", d: "device", w: "ws", a: "auto", t: "thread" }[k];
      apiRef.select({ kind, id });
      requestAnimationFrame(() => reveal(d.key));
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

    /* Inspector links */
    insp.panel.addEventListener("click", (e) => {
      const ap = e.target.closest("[data-approve-id]");
      if (ap) {
        approve(ap.dataset.approveId);
        return;
      }
      const t = e.target.closest("[data-select]");
      if (!t) return;
      const [kind, id] = t.dataset.select.split(":");
      apiRef.select({ kind, id });
      const key = `${KIND_PREFIX[kind] ?? "p"}:${id}`;
      requestAnimationFrame(() => reveal(key));
    });

    let firstPaint = true;
    return {
      update() {
        render({ first: firstPaint });
        if (firstPaint) {
          firstPaint = false;
          requestAnimationFrame(() => fitAll(false));
        }
      },
      destroy() {
        vp.destroy();
      },
    };
  }

  DIRS.A = {
    title: "A · Flow",
    thesis:
      "A node canvas in the spirit of n8n. The project sits on top, and <b>every device is a column</b>: its checkout, then its workspaces, then the automations it runs, all on one trunk. Every box is one thing and every wire means “lives in”. Running work moves as a slow dash along its wires, so you can see where things are happening before you read a word.",
    notes: [
      [
        "Reading it",
        [
          "<b>Columns are devices.</b> Whatever is under the MacBook is on the MacBook. Studio and the cloud node sit beside it, each with its own folder and connection state.",
          "<b>Workspaces</b> are the main checkout and the worktrees, showing where each came from (#663, issue #412, RYCO-88). Facts appear only when they need care: uncommitted work, unmerged commits, a removed or missing checkout.",
          "<b>Threads</b> fold into a tally of status dots; click the tally and they fan out under their workspace on their own trunk.",
          "<b>Automations</b> sit below the device's workspaces. Their ring fills as the next run approaches. A due run turns amber and asks for approval right on the node, and a teal dotted arc leads to every thread a run started.",
          "<b>A violet arc</b> joins the same branch checked out on two devices. Dashed boxes are archived or paused.",
        ],
      ],
      [
        "Moving around",
        [
          "Hover any box to light its lineage (parents, children, and an automation's threads); the rest steps back.",
          "Click to inspect: the panel slides in, and the canvas pans so the box is never hidden under it.",
          "Drag boxes to rearrange; <b>Tidy</b> glides them back. Device chips hide a column; Threads, Automations and Archived fold those layers away.",
          "Drag to pan, ⌘-scroll or pinch to zoom, double-click empty canvas to fit. The minimap jumps.",
        ],
      ],
      [
        "Live",
        [
          "At 0:07 “Triage new issues” comes due. Approve it on the node (or wait); its thread appears on the main checkout, wired back to the automation, with the wire flowing while it runs.",
          "Studio opens PR #671 in a new worktree: it grows into its column and everything below glides down. The cloud node goes from Connecting to Online.",
        ],
      ],
    ],
    mount,
  };
})();
