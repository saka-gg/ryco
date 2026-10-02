/* ============================================================
   Shared: today's section model (Pinned / Needs input / Active
   now / Recent / Snoozed / Settled) used by Today and A.
   ============================================================ */
const byAt = (a, b) => b.at - a.at;
const ACTIVE_PRI = { error: 1, working: 2, connecting: 3 };
function modelSections() {
  const live = S.threads.filter((t) => !t.settled && !t.snoozed);
  const rest = live.filter((t) => !t.pinned);
  return [
    { key: "pinned", title: "Pinned", rows: live.filter((t) => t.pinned).sort(byAt) },
    {
      key: "needs",
      title: "Needs input",
      rows: rest.filter((t) => t.state === "input").sort(byAt),
    },
    {
      key: "active",
      title: "Active now",
      rows: rest
        .filter((t) => ACTIVE_PRI[t.state])
        .sort((a, b) => ACTIVE_PRI[a.state] - ACTIVE_PRI[b.state] || byAt(a, b)),
    },
    {
      key: "recent",
      title: "Recent",
      rows: rest.filter((t) => t.state === "done" || t.state === "idle").sort(byAt),
    },
    {
      key: "snoozed",
      title: "Snoozed",
      rows: S.threads.filter((t) => t.snoozed && !t.settled).sort(byAt),
      fold: true,
    },
    {
      key: "settled",
      title: "Settled",
      rows: S.threads.filter((t) => t.settled).sort(byAt),
      fold: true,
    },
  ].filter((x) => x.rows.length);
}
const foldOpen = (sec) => !sec.fold || (sec.key === "settled" ? S.settledOpen : S.snoozedOpen);
function secHeader() {
  return h(
    "div",
    "sec-h",
    `${ic("chevR", "chev")}<span class="slot sec-t"></span><span class="slot cnt"></span>`,
  );
}
function updSecHeader(el, sec) {
  el.classList.toggle("collapsible", !!sec.fold);
  el.classList.toggle("open", foldOpen(sec));
  if (sec.fold) el.dataset.act = sec.key === "settled" ? "toggleSettled" : "toggleSnoozed";
  else delete el.dataset.act;
  swap(el.querySelector(".sec-t"), sec.title);
  swapCount(el.querySelector(".cnt"), sec.rows.length);
}
function sectionItems(createRow, updateRow) {
  const out = [];
  for (const sec of modelSections()) {
    out.push({ key: "h:" + sec.key, create: secHeader, update: (el) => updSecHeader(el, sec) });
    if (foldOpen(sec))
      for (const t of sec.rows)
        out.push({ key: "r:" + t.id, create: createRow, update: (el) => updateRow(el, t) });
  }
  return out;
}
const mark = (el, t) => {
  el.dataset.id = t.id;
  el.setAttribute("aria-current", S.selected === t.id ? "page" : "false");
};

/* ============================================================
   0 · Today — faithful to InboxSidebar.tsx as it ships.
   ============================================================ */
const TODAY_TONE = { input: "warn", error: "err", working: "ok", connecting: "info" };
const todayCardState = (t) => (t.state === "done" ? "idle" : t.state);
function todayStatus(t) {
  if (t.snoozed) return `${ic("clock")}Until Fri 09:00`;
  // Today has no "done": an unseen completion still reads Idle.
  const label = t.state === "input" ? "Needs input" : t.state === "done" ? "Idle" : stateLabel(t);
  return `<i class="dot"></i>${label}`;
}
function plainCard(t) {
  const m = MACHINES[t.machine];
  const showStatus = todayCardState(t) !== "idle";
  return `<div class="pc-h"><span class="pc-t">${esc(t.title)}</span><span class="pc-s tone-${TODAY_TONE[t.state] || "mut"}" data-live="s">${
    showStatus
      ? `<i class="dot"></i>${t.state === "input" ? "Needs input" : stateLabel(t)}`
      : ago(t.at) + " ago"
  }</span></div>
  <div class="pc-l">${fav(t.project)}<span>${esc(PROJECTS[t.project].name)}</span></div>
  <div class="pc-l">${ic(m.icon)}<span>${esc(m.label)}</span></div>
  <div class="pc-l">${ic(t.worktree ? "fork" : "branch")}<span class="trunc">${esc(t.branch)}</span></div>
  <div class="pc-l">${pv(t.provider)}<span>${esc(PROVIDERS[t.provider].name)} · ${esc(t.model)}</span></div>
  ${t.pr ? `<div class="pc-l">${prChip(t.pr, true)}</div>` : ""}`;
}
DIRS.T = {
  name: "Today",
  items: () => sectionItems(DIRS.T.create, DIRS.T.update),
  create() {
    const el = h(
      "div",
      "row",
      `<div class="l1"><span class="slot fav-slot"></span><span class="pn"></span><span class="sep">·</span><span class="slot mach-slot"></span><span class="slot time-slot"></span></div>
       <div class="l2"><span class="slot pin-slot"></span><span class="slot t-slot"></span></div>
       <div class="l3"><span class="slot st-slot"></span><span class="vr"></span><span class="slot ws-slot"></span><span class="slot pv-slot"></span></div>
       <div class="slot l4"></div>
       <div class="ovl"><button class="settle-pill" data-act="settle"></button><button class="ib" data-act="menu" aria-label="More">${ic("more")}</button></div>`,
    );
    el.dataset.act = "open";
    return el;
  },
  update(el, t) {
    mark(el, t);
    const m = MACHINES[t.machine];
    el.classList.toggle("compact", !!(t.settled || t.snoozed));
    swap(el.querySelector(".fav-slot"), fav(t.project));
    el.querySelector(".pn").textContent = PROJECTS[t.project].name;
    swap(el.querySelector(".mach-slot"), `${ic(m.icon)}<span>${esc(m.label)}</span>`);
    swap(el.querySelector(".time-slot"), ago(t.at), { key: "t" });
    swap(el.querySelector(".pin-slot"), t.pinned ? ic("pin") : "");
    swap(el.querySelector(".t-slot"), esc(t.title));
    const st = el.querySelector(".st-slot");
    st.className = `slot st-slot tone-${TODAY_TONE[t.state] || "mut"}`;
    swap(st, todayStatus(t));
    swap(
      el.querySelector(".ws-slot"),
      `${ic(t.worktree ? "fork" : "branch")}<span class="trunc">${esc(t.branch)}</span>`,
    );
    swap(el.querySelector(".pv-slot"), pv(t.provider));
    swap(el.querySelector(".l4"), t.pr ? prChip(t.pr, true) : "");
    const pill = el.querySelector(".settle-pill");
    pill.dataset.id = t.id;
    pill.innerHTML = t.settled ? `${ic("undo")}Move to Active` : `${ic("check")}Settle`;
    pill.setAttribute("aria-disabled", String(!t.settled && !canSettle(t)));
    if (!t.settled && !canSettle(t)) pill.dataset.tip = settleBlock(t);
    else delete pill.dataset.tip;
    el.querySelector('[data-act="menu"]').dataset.id = t.id;
  },
  setup(inst) {
    inst.list.addEventListener("pointermove", (e) => {
      const row = e.target.closest(".row");
      if (!row || e.target.closest(".ovl")) return Card.leave();
      Card.request(inst, row, Card.isOpen() ? 80 : 160);
    });
    inst.list.addEventListener("pointerleave", () => Card.leave());
  },
  card: (t) => `<div class="pcard">${plainCard(t)}</div>`,
  peek(inst, id) {
    const row = rowOf(inst, id);
    if (row) Card.openNow(inst, row);
  },
};
