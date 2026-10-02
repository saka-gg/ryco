/* ============================================================
   B · Lanes — the lane says the state, the row says the task,
   the dock says the rest.
   ============================================================ */
const LANES = [
  {
    key: "needs",
    title: "Needs you",
    glyph: "input",
    has: (t) => t.state === "input" || t.state === "error",
  },
  { key: "running", title: "Running", glyph: "working", has: (t) => isLive(t) },
  { key: "done", title: "Done", glyph: "done", has: (t) => t.state === "done" },
  { key: "idle", title: "Idle", glyph: "idle", has: (t) => t.state === "idle" },
];
const LANE_TIP = {
  needs: (n) => `${n} waiting on you`,
  running: (n) => `${n} agent${n === 1 ? "" : "s"} working`,
  done: (n) => `${n} finished, not opened yet`,
  idle: () => "Nothing running",
  snoozed: (n) => `${n} snoozed`,
  settled: (n) => `${n} settled`,
};
const pinFirst = (a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || byAt(a, b);
function lanes() {
  const live = S.threads.filter((t) => !t.settled && !t.snoozed);
  const out = LANES.map((l) => ({ ...l, rows: live.filter(l.has).sort(pinFirst) }));
  out.push({
    key: "snoozed",
    title: "Snoozed",
    glyph: "snoozed",
    fold: true,
    rows: S.threads.filter((t) => t.snoozed && !t.settled).sort(byAt),
  });
  out.push({
    key: "settled",
    title: "Settled",
    glyph: "settled",
    fold: true,
    rows: S.threads.filter((t) => t.settled).sort(byAt),
  });
  return out.filter((l) => l.rows.length);
}
function liveLineB(t) {
  if (t.settled || t.snoozed) return null;
  if (t.state === "input")
    return {
      key: "i" + t.input.kind,
      html:
        t.input.kind === "approval"
          ? `<button class="ask-chip" data-act="ask" data-id="${t.id}">${ic("terminal")}<code class="trunc">${esc(t.input.cmd)}</code><span class="go">Review</span></button>`
          : `<button class="ask-chip" data-act="ask" data-id="${t.id}">${ic("msg")}<span class="trunc">${esc(t.input.q)}</span><span class="go">Answer</span></button>`,
    };
  if (t.state === "error")
    return {
      key: "e",
      html: `<span class="err trunc">${esc(t.error)}</span><button class="link" data-act="retry" data-id="${t.id}">Retry</button>`,
    };
  if (t.state === "working")
    return {
      key: "w" + t.stepIdx,
      html: `<span class="shim trunc">${esc(curStep(t)?.now)}</span>`,
    };
  if (t.state === "connecting")
    return {
      key: "c",
      html: `<span class="trunc">Reconnecting to ${esc(MACHINES[t.machine].label)}…</span>`,
    };
  return null;
}
function dockHtml(t) {
  const m = MACHINES[t.machine];
  return `<div class="dk-l1">${fav(t.project)}<span class="strong">${esc(PROJECTS[t.project].name)}</span><span class="sep">/</span>${ic(t.worktree ? "fork" : "branch")}<span class="mono trunc">${esc(t.branch)}</span></div>
  <div class="dk-l2">${pv(t.provider)}<span class="trunc">${esc(t.model)}</span>${m.local ? "" : `<span class="sep">·</span>${ic(m.icon)}<span class="trunc">${esc(m.label)}</span>`}${
    t.pr
      ? `<span class="sep">·</span>${prChip(t.pr)}${dots(t.pr.checks)}`
      : t.diff
        ? `<span class="sep">·</span>${diffstat(t.diff)}`
        : ""
  }</div>`;
}
function updateDock(inst) {
  const box = inst.root.querySelector(".dock-box");
  const id = inst.hoverId || S.selected;
  const t = T(id);
  const idx = inst.order.indexOf(id);
  const dir = idx >= (inst.dockIdx ?? idx) ? 1 : -1;
  inst.dockIdx = idx;
  if (!t) {
    const live = S.threads.filter((x) => !x.settled && !x.snoozed);
    const n = (f) => live.filter(f).length;
    patchLive(
      box,
      `<div class="dk-l1"><span class="strong">Inbox</span></div><div class="dk-l2"><span>${n((x) => x.state === "input" || x.state === "error")} need you · ${n(isLive)} running · ${n((x) => x.state === "done")} done</span></div>`,
      "summary",
    );
    return;
  }
  patchLive(box, dockHtml(t), cardKey(t), dir);
}
DIRS.B = {
  name: "Lanes",
  dock: true,
  items() {
    const out = [];
    for (const lane of lanes()) {
      const open = !lane.fold || (lane.key === "settled" ? S.settledOpen : S.snoozedOpen);
      out.push({
        key: "h:" + lane.key,
        create: DIRS.B.header,
        update: (el) => DIRS.B.updHeader(el, lane, open),
      });
      if (open)
        for (const t of lane.rows)
          out.push({
            key: "r:" + t.id,
            create: DIRS.B.create,
            update: (el) => DIRS.B.update(el, t, lane),
          });
    }
    return out;
  },
  header() {
    return h(
      "div",
      "lane-h",
      `<span class="slot lg"></span><span class="ln"></span><span class="slot cnt"></span><span class="rule"></span>${ic("chevR", "chev")}`,
    );
  },
  updHeader(el, lane, open) {
    el.className = `lane-h lane-${lane.key} ${lane.fold ? "collapsible" : ""} ${open ? "open" : ""}`;
    if (lane.fold) el.dataset.act = lane.key === "settled" ? "toggleSettled" : "toggleSnoozed";
    else delete el.dataset.act;
    const lg = el.querySelector(".lg");
    swap(lg, glyph(null, lane.glyph), { key: lane.glyph });
    lg.dataset.tip = LANE_TIP[lane.key](lane.rows.length);
    el.querySelector(".ln").textContent = lane.title;
    swapCount(el.querySelector(".cnt"), lane.rows.length);
  },
  create() {
    const el = h(
      "div",
      "row",
      `<span class="slot fav-slot"></span>
       <span class="title"><span class="slot t-slot"></span></span>
       <span class="slot time-slot"></span>
       <span class="acts"><button class="ib settle" data-act="settle" data-kbd="E">${ic("check")}</button><button class="ib" data-act="menu" data-tip="More">${ic("more")}</button></span>
       <span class="live-wrap"><span class="live"><span class="slot live-slot"></span></span></span>
       <span class="track"><i></i></span>`,
    );
    el.dataset.act = "open";
    return el;
  },
  update(el, t, lane) {
    mark(el, t);
    el._exitTo = null;
    el.classList.remove("settling");
    el.className = el.className.replace(/\blane-\S+/g, "").trim() + " lane-" + lane.key;
    el.classList.toggle("unread", t.state === "done");
    el.classList.toggle("is-working", t.state === "working");
    swap(el.querySelector(".fav-slot"), fav(t.project));
    swap(el.querySelector(".t-slot"), (t.pinned ? `${ic("pin", "pinmark")}` : "") + esc(t.title));
    const time = el.querySelector(".time-slot");
    swap(time, timeFor(t), { key: isLive(t) ? "live" : "ago" });
    time.dataset.tip = timeTip(t);
    const line = liveLineB(t);
    el.classList.toggle("has-live", !!line);
    if (line) swap(el.querySelector(".live-slot"), line.html, { mode: "roll", key: line.key });
    const st = el.querySelector(".settle");
    st.dataset.id = t.id;
    const blocked = !t.settled && !canSettle(t);
    st.setAttribute("aria-disabled", String(blocked));
    st.dataset.tip = t.settled ? "Move to Active" : blocked ? settleBlock(t) : "Settle";
    st.innerHTML = ic(t.settled ? "undo" : "check");
    el.querySelector('[data-act="menu"]').dataset.id = t.id;
  },
  setup(inst) {
    inst.list.addEventListener("pointerover", (e) => {
      const id = e.target.closest(".row")?.dataset.id || null;
      if (id !== inst.hoverId) {
        inst.hoverId = id;
        updateDock(inst);
      }
    });
    inst.list.addEventListener("pointerleave", () => {
      inst.hoverId = null;
      updateDock(inst);
    });
  },
  after(inst) {
    updateDock(inst);
  },
  onAct(act, id, a) {
    if (act !== "ask") return;
    Pop.open(
      a,
      () => {
        const t = T(id);
        return `<div class="ask-pop"><div class="hc-title">${esc(t.title)}</div>${stateBlock(t)}<label class="always"><input type="checkbox" /> Always allow in ${esc(PROJECTS[t.project].name)}</label></div>`;
      },
      () => {
        const t = T(id);
        return t && t.state === "input" ? cardKey(t) : null;
      },
      { side: "bottom", cls: "pop-ask" },
    );
  },
  peek(inst, id) {
    const row = rowOf(inst, id);
    const chip = row?.querySelector(".ask-chip");
    if (chip) chip.click();
  },
  async settleFx(row) {
    row.classList.add("settling");
    await wait(380);
    row._exitTo = "translateX(28px)";
  },
};
