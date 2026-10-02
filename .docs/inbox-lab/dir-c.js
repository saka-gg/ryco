/* ============================================================
   C · Avatars — status is a ring around the project avatar, the
   agent is a badge on it, order is by attention.
   ============================================================ */
const ATTN = { input: 0, error: 1, done: 2, working: 3, connecting: 3, idle: 4 };
const byAttn = (a, b) => ATTN[a.state] - ATTN[b.state] || byAt(a, b);
function liveLineC(t) {
  if (t.settled || t.snoozed)
    return { key: "rest", html: `<span class="trunc">${esc(t.last)}</span>` };
  switch (t.state) {
    case "working":
      return {
        key: "w" + t.stepIdx,
        html: `<span class="shim trunc">${esc(curStep(t)?.now)}</span>`,
      };
    case "connecting":
      return { key: "c", html: `<span class="trunc">Reconnecting…</span>` };
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
      return { key: "d", html: `<span class="trunc">${esc(t.last)}</span>` };
    default:
      return { key: "i", html: `<span class="trunc">${esc(t.last)}</span>` };
  }
}
function peekLineC(t) {
  const m = MACHINES[t.machine];
  return `${ic(t.worktree ? "fork" : "branch")}<span class="mono trunc">${esc(t.branch)}</span>${t.pr ? prChip(t.pr) : ""}${
    m.local ? "" : `<span class="pm">${ic(m.icon)}${esc(m.label)}</span>`
  }`;
}
function trayItem() {
  return {
    key: "tray",
    create: () => {
      const b = h(
        "button",
        "tray",
        `<span class="stack"></span><span class="tray-l">Settled</span><span class="slot cnt"></span>${ic("chevR", "chev")}`,
      );
      b._fresh = true;
      return b;
    },
    update(el) {
      const settled = S.threads.filter((t) => t.settled).sort(byAt);
      el.dataset.act = "toggleSettled";
      el.classList.toggle("open", S.settledOpen);
      const stack = el.querySelector(".stack");
      const ids = settled.slice(0, 4).map((t) => t.id);
      const prev = stack._ids || [];
      if (ids.join() !== prev.join()) {
        stack.innerHTML = settled
          .slice(0, 4)
          .map((t) => `<span class="mini" data-mid="${t.id}">${fav(t.project)}</span>`)
          .join("");
        if (!el._fresh && motion)
          for (const id of ids)
            if (!prev.includes(id))
              stack
                .querySelector(`[data-mid="${id}"]`)
                ?.animate(
                  [
                    { transform: "scale(.2)", opacity: 0 },
                    { transform: "scale(1.15)", opacity: 1, offset: 0.6 },
                    { transform: "none" },
                  ],
                  {
                    duration: 460,
                    delay: 380,
                    easing: EASE,
                    fill: "backwards",
                  },
                );
        stack._ids = ids;
      }
      el._fresh = false;
      swapCount(el.querySelector(".cnt"), settled.length);
    },
  };
}
DIRS.C = {
  name: "Avatars",
  items() {
    const live = S.threads.filter((t) => !t.settled && !t.snoozed);
    const pinned = live.filter((t) => t.pinned).sort(byAttn);
    const rest = live.filter((t) => !t.pinned).sort(byAttn);
    const snoozed = S.threads.filter((t) => t.snoozed && !t.settled);
    const settled = S.threads.filter((t) => t.settled).sort(byAt);
    const out = [];
    const row = (t) => ({
      key: "r:" + t.id,
      create: DIRS.C.create,
      update: (el) => DIRS.C.update(el, t),
    });
    const head = (key, title, n, fold) => ({
      key: "h:" + key,
      create: secHeader,
      update: (el) => updSecHeader(el, { key, title, rows: { length: n }, fold }),
    });
    if (pinned.length) out.push(head("pinned", "Pinned", pinned.length), ...pinned.map(row));
    if (rest.length) out.push(head("inbox", "Inbox", rest.length), ...rest.map(row));
    if (snoozed.length) {
      out.push(head("snoozed", "Snoozed", snoozed.length, true));
      if (S.snoozedOpen) out.push(...snoozed.map(row));
    }
    if (settled.length) {
      const tray = trayItem();
      out.push(tray);
      if (S.settledOpen) out.push(...settled.map(row));
    }
    return out;
  },
  create() {
    const el = h(
      "div",
      "row",
      `<button class="av" data-act="agent"><span class="ring"></span><svg class="ring-close" viewBox="0 0 36 36"><circle cx="18" cy="18" r="16.6" pathLength="1"/></svg><span class="slot fav-slot"></span><span class="slot pb"></span></button>
       <span class="title"><span class="slot t-slot"></span></span>
       <span class="sub"><span class="roll"><span class="rest"><span class="slot sub-slot"></span></span><span class="peek"></span></span><span class="meta"><i class="ud"></i><span class="slot time-slot"></span></span></span>
       <span class="acts"><button class="ib settle" data-act="settle" data-kbd="E">${ic("check")}</button><button class="ib" data-act="menu" data-tip="More">${ic("more")}</button></span>`,
    );
    el.dataset.act = "open";
    return el;
  },
  update(el, t) {
    mark(el, t);
    el._exitTo = null;
    const st = gstate(t);
    el.classList.toggle("unread", t.state === "done" && !t.settled);
    el.classList.toggle("compact", !!(t.settled || t.snoozed));
    const av = el.querySelector(".av");
    av.className = `av av-${st}`;
    av.style.opacity = "";
    av.dataset.id = t.id;
    av.dataset.tip = glyphTip(t);
    swap(el.querySelector(".fav-slot"), fav(t.project));
    const pb = el.querySelector(".pb");
    swap(pb, pv(t.provider));
    pb.dataset.tip = provTip(t);
    swap(el.querySelector(".t-slot"), esc(t.title));
    const line = liveLineC(t);
    swap(el.querySelector(".sub-slot"), line.html, { mode: "roll", key: line.key });
    const peek = el.querySelector(".peek");
    const ph = peekLineC(t);
    if (peek._h !== ph) peek.innerHTML = peek._h = ph;
    const time = el.querySelector(".time-slot");
    swap(time, timeFor(t), { key: isLive(t) ? "live" : "ago" });
    time.dataset.tip = timeTip(t);
    const s = el.querySelector(".settle");
    s.dataset.id = t.id;
    const blocked = !t.settled && !canSettle(t);
    s.setAttribute("aria-disabled", String(blocked));
    s.dataset.tip = t.settled ? "Move to Active" : blocked ? settleBlock(t) : "Settle";
    s.innerHTML = ic(t.settled ? "undo" : "check");
    el.querySelector('[data-act="menu"]').dataset.id = t.id;
  },
  onAct(act, id, a) {
    if (act !== "agent") return;
    Pop.open(
      a,
      () => `<div class="agent-card">${richCard(T(id), { full: true })}</div>`,
      () => (T(id) ? cardKey(T(id)) : null),
      { side: "right", cls: "pop-agent" },
    );
  },
  peek(inst, id) {
    rowOf(inst, id)?.querySelector(".av")?.click();
  },
  async settleFx(row, inst) {
    Pop.close();
    const av = row.querySelector(".av");
    av.classList.add("closing");
    await wait(300);
    const target = inst.root.querySelector(".tray .stack") || inst.root.querySelector(".sb-list");
    const from = av.getBoundingClientRect();
    const to = target.getBoundingClientRect();
    const ghost = av.cloneNode(true);
    ghost.classList.add("ghost");
    Object.assign(ghost.style, {
      position: "fixed",
      left: from.left + "px",
      top: from.top + "px",
      margin: 0,
      zIndex: 80,
    });
    document.body.append(ghost);
    const dx = to.left - from.left;
    const dy = to.top + to.height / 2 - (from.top + from.height / 2);
    ghost.animate(
      [
        { transform: "translate(0,0) scale(1)", opacity: 1 },
        {
          transform: `translate(${dx * 0.45}px, ${dy * 0.45 - 28}px) scale(.85)`,
          opacity: 1,
          offset: 0.5,
        },
        { transform: `translate(${dx}px, ${dy}px) scale(.55)`, opacity: 0.2 },
      ],
      { duration: 640, easing: "cubic-bezier(.45,0,.2,1)", fill: "forwards" },
    ).onfinish = () => ghost.remove();
    av.style.opacity = "0";
    row._exitTo = "scale(.98)";
  },
};
