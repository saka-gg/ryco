/* ============================================================
   A · Glyph — status collapses into a 14px glyph; the project icon
   sits under it, and the second line carries the one thing that
   matters for that state. No tool calls or reasoning anywhere.
   ============================================================ */
const branchLine = (t) => ({
  key: "b",
  html: `${ic(t.worktree ? "fork" : "branch")}<span class="trunc">${esc(t.branch)}</span>`,
});
function liveLineA(t) {
  if (t.settled || t.snoozed) return { key: "rest", html: "" };
  switch (t.state) {
    case "working":
      return branchLine(t);
    case "connecting":
      return {
        key: "c",
        html: `<span class="trunc">Reconnecting to ${esc(MACHINES[t.machine].label)}…</span>`,
      };
    case "input":
      return t.input.kind === "approval"
        ? {
            key: "ia",
            html: `<span class="ask trunc"><b>Approve</b> <code>${esc(t.input.cmd)}</code></span>`,
          }
        : { key: "iq", html: `<span class="ask trunc"><b>Asks</b> ${esc(t.input.q)}</span>` };
    case "error":
      return { key: "e", html: `<span class="err trunc">${esc(t.error)}</span>` };
    case "done":
      return {
        key: "d",
        html: `${diffstat(t.diff)}${t.diff ? `<span class="dim trunc">${t.diff.files} files</span>` : `<span class="dim trunc">Finished</span>`}`,
      };
    default:
      return branchLine(t);
  }
}
function placeHl(inst) {
  const hl = inst.hl;
  const row = inst.hoverRow;
  if (!row || row._exiting || !row.isConnected) {
    hl.classList.remove("on");
    return;
  }
  const wasOn = hl.classList.contains("on");
  if (!wasOn) hl.style.transition = "none";
  hl.style.transform = `translateY(${row.offsetTop}px)`;
  hl.style.height = row.offsetHeight + "px";
  if (!wasOn) {
    void hl.offsetWidth;
    hl.style.transition = "";
  }
  hl.classList.add("on");
}
DIRS.A = {
  name: "Glyph",
  items: () => sectionItems(DIRS.A.create, DIRS.A.update),
  create() {
    const el = h(
      "div",
      "row",
      `<span class="slot g-slot"></span>
       <span class="title"><span class="slot t-slot"></span></span>
       <span class="slot ct-slot"></span>
       <span class="acts"><button class="ib settle" data-act="settle" data-kbd="E">${ic("check")}</button><button class="ib" data-act="menu" data-tip="More">${ic("more")}</button></span>
       <span class="sub-wrap"><span class="sub">
         <span class="slot fav-slot"></span>
         <span class="sub-line"><span class="slot mach-slot"></span><span class="slot sub-slot"></span><span class="slot pr-slot"></span><span class="slot time-slot"></span></span>
       </span></span>`,
    );
    el.dataset.act = "open";
    return el;
  },
  update(el, t) {
    mark(el, t);
    el.classList.toggle("unread", t.state === "done" && !t.settled);
    el.classList.toggle("compact", !!(t.settled || t.snoozed));
    el.classList.remove("settling");
    el._exitTo = null;
    // Settled and snoozed rows trade the (identical) check for the project
    // icon, so they stay tellable apart; the section header says "Settled".
    const resting = !!(t.settled || t.snoozed);
    const projectTip = `${PROJECTS[t.project].name} · ${provTip(t)}`;
    const g = el.querySelector(".g-slot");
    swap(g, resting ? fav(t.project) : glyph(t), {
      mode: "morph",
      key: resting ? "fav" : gstate(t),
    });
    g.dataset.tip = resting ? `${projectTip} · ${stateLabel(t)} ${ago(t.at)} ago` : glyphTip(t);
    swap(el.querySelector(".t-slot"), esc(t.title));
    const time = el.querySelector(".time-slot");
    swap(time, timeFor(t), { key: isLive(t) ? "live" : "ago" });
    time.dataset.tip = timeTip(t);
    const ct = el.querySelector(".ct-slot");
    swap(ct, resting ? ago(t.at) : "", { key: resting ? "ago" : "none" });
    ct.dataset.tip = timeTip(t);
    const fs = el.querySelector(".fav-slot");
    swap(fs, fav(t.project));
    fs.dataset.tip = projectTip;
    swap(el.querySelector(".mach-slot"), machineMark(t));
    const line = liveLineA(t);
    swap(el.querySelector(".sub-slot"), line.html, { mode: "roll", key: line.key });
    swap(el.querySelector(".pr-slot"), t.pr ? prChip(t.pr) : "");
    const st = el.querySelector(".settle");
    st.dataset.id = t.id;
    const blocked = !t.settled && !canSettle(t);
    st.setAttribute("aria-disabled", String(blocked));
    st.dataset.tip = t.settled ? "Move to Active" : blocked ? settleBlock(t) : "Settle";
    st.innerHTML = ic(t.settled ? "undo" : "check");
    el.querySelector('[data-act="menu"]').dataset.id = t.id;
  },
  setup(inst) {
    inst.hl = h("div", "hl static");
    inst.list.prepend(inst.hl);
    inst.list.addEventListener("pointermove", (e) => {
      const row = e.target.closest(".row");
      if (row !== inst.hoverRow) {
        inst.hoverRow = row;
        placeHl(inst);
      }
      if (!row) return Card.leave();
      const precise = e.target.closest("[data-tip], .acts");
      if (precise && !Card.isOpen()) Card.cancel();
      else Card.request(inst, row);
    });
    inst.list.addEventListener("pointerleave", () => {
      inst.hoverRow = null;
      placeHl(inst);
      Card.leave();
    });
    inst.list.addEventListener("scroll", () => placeHl(inst), { passive: true });
  },
  after(inst) {
    placeHl(inst);
  },
  card: (t) => richCard(t),
  peek(inst, id) {
    const row = rowOf(inst, id);
    if (row) Card.openNow(inst, row);
  },
  async settleFx(row) {
    Card.close();
    row.classList.add("settling");
    swap(row.querySelector(".g-slot"), glyph(null, "done"), { mode: "morph", key: "fx" });
    await wait(420);
    row._exitTo = "translateX(-14px)";
  },
};
