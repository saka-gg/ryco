/* ============================================================
   Core: motion primitives, keyed list + FLIP, floating layers,
   actions. Directions only describe markup and choreography.
   ============================================================ */
const $ = (sel, root = document) => root.querySelector(sel);
const h = (tag, cls, html) => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (html != null) el.innerHTML = html;
  return el;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const EASE = "cubic-bezier(.16,1,.3,1)";
const GENTLE = "cubic-bezier(.22,1,.36,1)";
const SNAPPY = "cubic-bezier(.3,1.36,.44,1)";
let motion = !matchMedia("(prefers-reduced-motion: reduce)").matches;
const DIRS = {};

/* ------------------------------------------------------------ swap
   Replace a slot's content. Same key → patch in place (ticking
   timers). New key → old content leaves, new content enters. */
const SWAP = {
  fade: () => ({
    dur: 200,
    ease: "ease-out",
    in: [{ opacity: 0 }, { opacity: 1 }],
    out: [{ opacity: 1 }, { opacity: 0 }],
  }),
  roll: (d) => ({
    dur: 360,
    ease: GENTLE,
    in: [
      { opacity: 0, transform: `translateY(${9 * d}px)`, filter: "blur(2px)" },
      { opacity: 1, transform: "none", filter: "blur(0)" },
    ],
    out: [
      { opacity: 1, transform: "none", filter: "blur(0)" },
      { opacity: 0, transform: `translateY(${-9 * d}px)`, filter: "blur(2px)" },
    ],
  }),
  count: (d) => ({
    dur: 320,
    ease: SNAPPY,
    in: [
      { opacity: 0, transform: `translateY(${7 * d}px)` },
      { opacity: 1, transform: "none" },
    ],
    out: [
      { opacity: 1, transform: "none" },
      { opacity: 0, transform: `translateY(${-7 * d}px)` },
    ],
  }),
  morph: () => ({
    dur: 480,
    outDur: 200,
    ease: SNAPPY,
    in: [
      { opacity: 0, transform: "scale(.2) rotate(-90deg)" },
      { opacity: 1, transform: "none" },
    ],
    out: [
      { opacity: 1, transform: "none" },
      { opacity: 0, transform: "scale(.2) rotate(40deg)" },
    ],
  }),
};
function swap(slot, html, o = {}) {
  const key = o.key ?? html;
  if (slot._html === html && slot._key === key) return;
  const first = slot._key === undefined;
  const sameKey = slot._key === key;
  slot._html = html;
  slot._key = key;
  const current = [...slot.children].filter((c) => !c._leaving);
  if (sameKey && current.length === 1) {
    current[0].innerHTML = html;
    return;
  }
  const next = h("span", "sw", html);
  if (first || !motion || o.mode === "none") {
    slot.replaceChildren(next);
    return;
  }
  const K = SWAP[o.mode || "fade"](o.dir || 1);
  for (const c of current) {
    c._leaving = true;
    c.animate(K.out, {
      duration: K.outDur || K.dur * 0.75,
      easing: K.ease,
      fill: "forwards",
    }).onfinish = () => c.remove();
  }
  slot.append(next);
  next.animate(K.in, { duration: K.dur, easing: K.ease, fill: "backwards", delay: o.delay || 0 });
}
function swapCount(slot, n) {
  const prev = slot._n ?? n;
  slot._n = n;
  swap(slot, String(n), { mode: "count", dir: n >= prev ? 1 : -1 });
}

/* Layered content with height animation (cards, dock, pane). */
function patchLive(box, html, key, dir = 1) {
  if (box._key === key) {
    const tmp = h("div", null, html);
    for (const n of tmp.querySelectorAll("[data-live]")) {
      const cur = box.querySelector(`.layer:not(.leaving) [data-live="${n.dataset.live}"]`);
      if (cur && cur.innerHTML !== n.innerHTML) cur.innerHTML = n.innerHTML;
    }
    return;
  }
  const first = box._key === undefined;
  box._key = key;
  const oldH = box.offsetHeight;
  const next = h("div", "layer", html);
  const olds = [...box.children].filter((c) => !c.classList.contains("leaving"));
  if (first || !motion) {
    box.replaceChildren(next);
    return;
  }
  for (const o of olds) {
    o.classList.add("leaving");
    Object.assign(o.style, { position: "absolute", left: 0, right: 0, top: 0 });
    o.animate(
      [
        { opacity: 1, transform: "none" },
        { opacity: 0, transform: `translateY(${-8 * dir}px)` },
      ],
      {
        duration: 170,
        easing: "ease-out",
        fill: "forwards",
      },
    ).onfinish = () => o.remove();
  }
  box.append(next);
  const newH = next.offsetHeight;
  next.animate(
    [
      { opacity: 0, transform: `translateY(${10 * dir}px)` },
      { opacity: 1, transform: "none" },
    ],
    {
      duration: 300,
      delay: 50,
      easing: GENTLE,
      fill: "backwards",
    },
  );
  if (Math.abs(oldH - newH) > 1)
    box.animate([{ height: oldH + "px" }, { height: newH + "px" }], {
      duration: 300,
      easing: GENTLE,
    });
}

/* ------------------------------------------------------------ list */
const INSTS = [];
let instSeq = 0;
const isSkipped = (n) => n._exiting || n.classList.contains("static");
function firstLive(list) {
  let n = list.firstElementChild;
  while (n && isSkipped(n)) n = n.nextElementSibling;
  return n;
}
function nextLive(node) {
  let n = node.nextElementSibling;
  while (n && isSkipped(n)) n = n.nextElementSibling;
  return n;
}
function collapseFrames(el) {
  const cs = getComputedStyle(el);
  return [
    {
      height: el.offsetHeight + "px",
      paddingTop: cs.paddingTop,
      paddingBottom: cs.paddingBottom,
      marginTop: cs.marginTop,
      marginBottom: cs.marginBottom,
      opacity: 1,
    },
    {
      height: "0px",
      paddingTop: "0px",
      paddingBottom: "0px",
      marginTop: "0px",
      marginBottom: "0px",
      opacity: 0,
    },
  ];
}
function enterEl(el, inst) {
  if (!motion) return;
  if (inst.first) {
    inst._stagger = (inst._stagger || 0) + 1;
    el.animate(
      [
        { opacity: 0, transform: "translateY(8px)" },
        { opacity: 1, transform: "none" },
      ],
      {
        duration: 460,
        delay: 40 + inst._stagger * 30,
        easing: EASE,
        fill: "backwards",
      },
    );
    return;
  }
  const [full, zero] = collapseFrames(el);
  el.style.overflow = "hidden";
  el.animate([zero, full], { duration: 360, easing: GENTLE }).onfinish = () =>
    (el.style.overflow = "");
  el.animate([{ transform: "translateY(-6px) scale(.98)" }, { transform: "none" }], {
    duration: 420,
    easing: EASE,
  });
}
function exitEl(el) {
  el._exiting = true;
  el.style.pointerEvents = "none";
  if (!motion || !el.isConnected) return el.remove();
  const [full, zero] = collapseFrames(el);
  el.style.overflow = "hidden";
  const to = el._exitTo || "none";
  el.animate(
    [
      { ...full, transform: "none" },
      { ...zero, transform: to },
    ],
    {
      duration: el._exitDur || 380,
      easing: GENTLE,
      fill: "forwards",
    },
  ).onfinish = () => el.remove();
}
function reconcile(inst, items) {
  const list = inst.list;
  const before = new Map();
  if (!inst.first) for (const [k, el] of inst.els) before.set(k, el.getBoundingClientRect().top);
  const keys = new Set(items.map((i) => i.key));
  for (const [k, el] of inst.els)
    if (!keys.has(k)) {
      inst.els.delete(k);
      exitEl(el);
    }
  let prev = null;
  const fresh = new Set();
  for (const it of items) {
    let el = inst.els.get(it.key);
    if (!el) {
      el = it.create();
      el.dataset.key = it.key;
      inst.els.set(it.key, el);
      fresh.add(el);
    }
    it.update(el);
    const want = prev ? nextLive(prev) : firstLive(list);
    if (want !== el) {
      if (prev) prev.after(el);
      else if (want) want.before(el);
      else list.append(el);
    }
    prev = el;
  }
  if (!inst.first && motion)
    for (const [k, el] of inst.els) {
      if (fresh.has(el) || !before.has(k)) continue;
      const dy = before.get(k) - el.getBoundingClientRect().top;
      if (Math.abs(dy) > 1)
        el.animate([{ transform: `translateY(${dy}px)` }, { transform: "translateY(0)" }], {
          duration: 520,
          easing: GENTLE,
        });
    }
  for (const el of fresh) enterEl(el, inst);
  inst.order = items.filter((i) => i.key.startsWith("r:")).map((i) => i.key.slice(2));
}
function render(inst) {
  reconcile(inst, inst.dir.items(inst));
  inst.dir.after?.(inst);
  inst.first = false;
}
function mount(host, dirId, opts = {}) {
  const dir = DIRS[dirId];
  const root = h("aside", `sb d${dirId}`);
  root.dataset.inst = String(++instSeq);
  root.innerHTML = `<div class="sb-head"><div class="search">${ic("search")}<span>Search tasks</span><kbd>⌘K</kbd></div></div><div class="sb-list"></div>${dir.dock ? '<div class="dock"><div class="live-box dock-box"></div></div>' : ""}`;
  host.append(root);
  const inst = {
    id: root.dataset.inst,
    dir,
    dirId,
    root,
    list: root.querySelector(".sb-list"),
    els: new Map(),
    first: true,
    hidden: !!opts.hidden,
    order: [],
  };
  dir.setup?.(inst);
  INSTS.push(inst);
  render(inst);
  root.addEventListener("pointerenter", () => (lastInst = inst));
  return inst;
}
function unmount(inst) {
  const i = INSTS.indexOf(inst);
  if (i >= 0) INSTS.splice(i, 1);
  inst.root.remove();
}
let lastInst = null;
const activeInst = () => {
  const visible = INSTS.filter((i) => !i.hidden);
  return visible.includes(lastInst) ? lastInst : visible[0];
};
const rowOf = (inst, id) => inst?.els.get("r:" + id);
const listeners = [];
function emit() {
  for (const inst of [...INSTS]) {
    try {
      render(inst);
    } catch (err) {
      console.error(err);
    }
  }
  Card.refresh();
  Pop.refresh();
  Tip.refresh();
  for (const fn of listeners) fn();
}

/* ------------------------------------------------------------ tooltip
   One tooltip element. First reveal waits; while "warm" it glides
   from trigger to trigger instead of popping again. */
const Tip = (() => {
  const el = h("div", "tip");
  const inner = h("div", "tip-in");
  el.append(inner);
  document.body.append(el);
  let cur = null;
  let showT = 0;
  let hideT = 0;
  let vis = false;
  let lastHide = 0;
  const content = (t) =>
    esc(t.dataset.tip) + (t.dataset.kbd ? `<kbd>${esc(t.dataset.kbd)}</kbd>` : "");
  function put(t, glide) {
    if (!t.isConnected) return;
    cur = t;
    inner.innerHTML = content(t);
    const r = t.getBoundingClientRect();
    const w = el.offsetWidth;
    const ht = el.offsetHeight;
    let x = Math.round(r.left + r.width / 2 - w / 2);
    x = Math.max(6, Math.min(innerWidth - w - 6, x));
    let y = Math.round(r.top - ht - 7);
    const below = y < 6;
    if (below) y = Math.round(r.bottom + 7);
    el.classList.toggle("below", below);
    if (!glide) el.style.transition = "none";
    el.style.transform = `translate(${x}px, ${y}px)`;
    if (!glide) {
      void el.offsetWidth;
      el.style.transition = "";
    }
    el.classList.add("on");
    vis = true;
  }
  function show(t) {
    clearTimeout(hideT);
    clearTimeout(showT);
    const warm = vis || performance.now() - lastHide < 500;
    showT = setTimeout(() => put(t, vis), warm ? 30 : 420);
  }
  function hide() {
    clearTimeout(showT);
    clearTimeout(hideT);
    hideT = setTimeout(() => {
      el.classList.remove("on");
      if (vis) lastHide = performance.now();
      vis = false;
      cur = null;
    }, 70);
  }
  function hideNow() {
    clearTimeout(showT);
    el.classList.remove("on");
    vis = false;
    cur = null;
  }
  document.addEventListener("pointerover", (e) => {
    const t = e.target.closest?.("[data-tip]");
    if (t) {
      if (t !== cur) show(t);
      else clearTimeout(hideT);
    } else hide();
  });
  document.addEventListener("pointerdown", hideNow, true);
  return {
    hideNow,
    refresh() {
      if (!cur) return;
      if (!cur.isConnected) return hideNow();
      const c = content(cur);
      if (inner.innerHTML !== c) inner.innerHTML = c;
    },
  };
})();

/* ------------------------------------------------------------ hover card
   Dwell on a row → card slides out of the sidebar edge. Moving to
   another row while open glides it there and rolls the content. */
const Card = (() => {
  const el = h("div", "hcard");
  const box = h("div", "hcard-box live-box");
  el.append(box);
  document.body.append(el);
  let openId = null;
  let pendingId = null;
  let pendingInst = null;
  let inst = null;
  let showT = 0;
  let hideT = 0;
  let isOpen = false;
  let lastIdx = 0;
  function position(row, instant) {
    const sb = inst.root.getBoundingClientRect();
    const r = row.getBoundingClientRect();
    const ht = box.lastElementChild?.offsetHeight || box.offsetHeight;
    const y = Math.max(10, Math.min(innerHeight - ht - 10, r.top - 8));
    if (instant) el.style.transition = "none";
    el.style.transform = `translate(${Math.round(sb.right + 10)}px, ${Math.round(y)}px)`;
    if (instant) {
      void el.offsetWidth;
      el.style.transition = "";
    }
  }
  function open(i, row) {
    const id = row.dataset.id;
    const t = T(id);
    pendingId = null;
    if (!t || !row.isConnected) return;
    inst = i;
    const idx = i.order.indexOf(id);
    const dir = idx >= lastIdx ? 1 : -1;
    lastIdx = idx;
    openId = id;
    Tip.hideNow();
    patchLive(box, i.dir.card(t), cardKey(t), dir);
    position(row, !isOpen);
    el.classList.add("on");
    isOpen = true;
  }
  function close() {
    clearTimeout(showT);
    el.classList.remove("on");
    isOpen = false;
    openId = null;
    pendingId = null;
  }
  el.addEventListener("pointerenter", () => clearTimeout(hideT));
  el.addEventListener("pointerleave", () => api.leave());
  const api = {
    isOpen: () => isOpen,
    request(i, row, delay) {
      clearTimeout(hideT);
      const id = row.dataset.id;
      if ((isOpen && openId === id && inst === i) || (pendingId === id && pendingInst === i))
        return;
      clearTimeout(showT);
      pendingId = id;
      pendingInst = i;
      showT = setTimeout(() => open(i, row), delay ?? (isOpen ? 120 : 560));
    },
    openNow(i, row) {
      clearTimeout(showT);
      open(i, row);
    },
    cancel() {
      clearTimeout(showT);
      pendingId = null;
    },
    leave() {
      clearTimeout(showT);
      pendingId = null;
      clearTimeout(hideT);
      hideT = setTimeout(close, 220);
    },
    close,
    refresh() {
      if (!isOpen) return;
      const t = T(openId);
      const row = rowOf(inst, openId);
      if (!t || !row || row._exiting || !INSTS.includes(inst)) return close();
      patchLive(box, inst.dir.card(t), cardKey(t));
      position(row, false);
    },
  };
  return api;
})();

/* ------------------------------------------------------------ popover */
const Pop = (() => {
  let el = null;
  let anchor = null;
  let fn = null;
  let keyFn = null;
  let side = "right";
  function place() {
    const r = anchor.getBoundingClientRect();
    const w = el.offsetWidth;
    const ht = el.offsetHeight;
    let x;
    let y;
    if (side === "right") {
      x = r.right + 10;
      y = r.top - 8;
    } else {
      x = r.left - 4;
      y = r.bottom + 6;
    }
    x = Math.max(8, Math.min(innerWidth - w - 8, x));
    y = Math.max(8, Math.min(innerHeight - ht - 8, y));
    el.style.left = x + "px";
    el.style.top = y + "px";
    const ox = Math.max(0, Math.min(w, r.left + r.width / 2 - x));
    const oy = Math.max(0, Math.min(ht, r.top + r.height / 2 - y));
    el.style.transformOrigin = `${ox}px ${oy}px`;
  }
  function close() {
    if (!el) return;
    const dead = el;
    dead.classList.remove("on");
    dead.classList.add("off");
    setTimeout(() => dead.remove(), 140);
    anchor?.classList.remove("pop-open");
    el = null;
    anchor = null;
  }
  document.addEventListener(
    "pointerdown",
    (e) => {
      if (el && !el.contains(e.target) && !anchor?.contains(e.target)) close();
    },
    true,
  );
  return {
    isOpen: () => !!el,
    open(a, render, k, opts = {}) {
      if (el && anchor === a) return close();
      close();
      Card.close();
      anchor = a;
      fn = render;
      keyFn = k;
      side = opts.side || "right";
      el = h("div", "pop " + (opts.cls || ""));
      const box = h("div", "live-box");
      el.append(box);
      document.body.append(el);
      patchLive(box, fn(), keyFn());
      place();
      a.classList.add("pop-open");
      requestAnimationFrame(() => el?.classList.add("on"));
    },
    close,
    refresh() {
      if (!el) return;
      if (!anchor.isConnected) return close();
      const k = keyFn();
      if (k == null) return close();
      patchLive(el.firstElementChild, fn(), k);
    },
  };
})();

/* ------------------------------------------------------------ menu */
const Menu = (() => {
  let el = null;
  let items = [];
  let owner = null;
  function close() {
    if (!el) return;
    const dead = el;
    dead.classList.remove("on");
    dead.classList.add("off");
    setTimeout(() => dead.remove(), 120);
    owner?.classList.remove("menu-open");
    el = null;
    owner = null;
  }
  document.addEventListener(
    "pointerdown",
    (e) => {
      if (el && !el.contains(e.target)) close();
    },
    true,
  );
  document.addEventListener("keydown", (e) => {
    if (!el) return;
    const btns = [...el.querySelectorAll(".m-it:not([aria-disabled])")];
    const i = btns.indexOf(document.activeElement);
    if (e.key === "Escape") close();
    else if (e.key === "ArrowDown") btns[(i + 1) % btns.length]?.focus();
    else if (e.key === "ArrowUp") btns[(i - 1 + btns.length) % btns.length]?.focus();
    else return;
    e.preventDefault();
    e.stopImmediatePropagation();
  });
  return {
    isOpen: () => !!el,
    open(pos, list, ownerRow) {
      close();
      Card.close();
      items = list;
      owner = ownerRow;
      owner?.classList.add("menu-open");
      el = h(
        "div",
        "menu",
        list
          .map((it, i) =>
            it.sep
              ? '<div class="m-sep"></div>'
              : `<button class="m-it ${it.danger ? "danger" : ""}" data-i="${i}" ${it.disabled ? 'aria-disabled="true"' : ""} ${it.disabled && it.reason ? `data-tip="${esc(it.reason)}"` : ""}>${ic(it.icon)}<span>${esc(it.label)}</span>${it.kbd ? `<kbd>${it.kbd}</kbd>` : ""}</button>`,
          )
          .join(""),
      );
      document.body.append(el);
      const w = el.offsetWidth;
      const ht = el.offsetHeight;
      let x = pos.alignRight ? pos.x - w : pos.x;
      let y = pos.y;
      const flipX = x + w > innerWidth - 8;
      const flipY = y + ht > innerHeight - 8;
      if (flipX) x = pos.x - w;
      if (flipY) y = Math.max(8, pos.y - ht - (pos.h || 0));
      el.style.left = Math.max(8, x) + "px";
      el.style.top = y + "px";
      el.style.transformOrigin = `${pos.alignRight || flipX ? "right" : "left"} ${flipY ? "bottom" : "top"}`;
      el.addEventListener("click", (e) => {
        const b = e.target.closest(".m-it");
        if (!b || b.getAttribute("aria-disabled")) return;
        const it = items[+b.dataset.i];
        close();
        it.run();
      });
      requestAnimationFrame(() => el?.classList.add("on"));
    },
    close,
  };
})();

/* ------------------------------------------------------------ toast */
const Toast = (() => {
  const el = h("div", "toast");
  document.body.append(el);
  let timer = 0;
  let undoFn = null;
  el.addEventListener("click", (e) => {
    if (!e.target.closest("button") || !undoFn) return;
    undoFn();
    undoFn = null;
    el.classList.remove("on");
  });
  return {
    show(msg, undo) {
      undoFn = undo || null;
      el.innerHTML = `<span>${esc(msg)}</span>${undo ? `<button type="button">${ic("undo")}Undo</button>` : ""}`;
      el.classList.remove("on");
      void el.offsetWidth;
      el.classList.add("on");
      clearTimeout(timer);
      timer = setTimeout(() => el.classList.remove("on"), 3600);
    },
  };
})();

/* ------------------------------------------------------------ actions */
function restore(id, snap) {
  const i = S.threads.findIndex((t) => t.id === id);
  if (i >= 0) S.threads[i] = snap;
  else S.threads.push(snap);
  emit();
}
const ACT = {
  open(id) {
    const t = T(id);
    if (!t) return;
    S.selected = id;
    if (t.state === "done") {
      t.state = "idle";
      t.unread = false;
    }
    emit();
  },
  pin(id) {
    const t = T(id);
    t.pinned = !t.pinned;
    emit();
    Toast.show(t.pinned ? "Pinned" : "Unpinned");
  },
  snooze(id) {
    const t = T(id);
    const snap = clone(t);
    t.snoozed = !t.snoozed;
    emit();
    if (t.snoozed) Toast.show("Snoozed until tomorrow 09:00", () => restore(id, snap));
  },
  archive(id) {
    const t = T(id);
    const snap = clone(t);
    S.threads = S.threads.filter((x) => x.id !== id);
    emit();
    Toast.show(`Archived “${shortTitle(t.title, 26)}”`, () => restore(id, snap));
  },
  approve(id) {
    const t = T(id);
    if (!t?.after) return;
    Pop.close();
    startWork(t, t.after.steps, t.after.run, t.after.result);
    emit();
  },
  deny(id) {
    const t = T(id);
    Pop.close();
    t.state = "idle";
    t.input = null;
    t.at = S.now;
    t.last = "Command denied. Waiting for new instructions.";
    emit();
  },
  answer(id, i) {
    const t = T(id);
    if (!t?.after) return;
    Pop.close();
    const result = i === 0 ? t.after.result : { last: "Kept the 0.9 notes in CHANGELOG.md only." };
    startWork(t, t.after.steps, i === 0 ? t.after.run : 3, result);
    emit();
  },
  retry(id) {
    const t = T(id);
    if (!t?.after) return;
    Pop.close();
    startWork(t, t.after.steps, t.after.run + 2, t.after.result);
    t.state = "connecting";
    t.until = S.simT + 2;
    emit();
  },
};
function shake(el) {
  if (!el || !motion) return;
  el.animate(
    [
      { transform: "translateX(0)" },
      { transform: "translateX(-4px)" },
      { transform: "translateX(3px)" },
      { transform: "translateX(-2px)" },
      { transform: "translateX(0)" },
    ],
    { duration: 320, easing: "ease-out" },
  );
}
async function settleFlow(id, inst, row) {
  const t = T(id);
  if (!t) return;
  if (t.settled) {
    t.settled = false;
    t.at = S.now;
    emit();
    return;
  }
  row = row || rowOf(inst, id);
  if (!canSettle(t)) {
    shake(row);
    Toast.show(settleBlock(t));
    return;
  }
  if (row?._settling) return;
  const snap = clone(t);
  if (row) row._settling = true;
  if (row && motion && inst?.dir.settleFx) await inst.dir.settleFx(row, inst, t);
  if (row) row._settling = false;
  t.settled = true;
  t.unread = false;
  if (t.state === "done") t.state = "idle";
  t.at = S.now;
  emit();
  Toast.show(`Settled “${shortTitle(t.title, 26)}”`, () => restore(id, snap));
}
function menuFor(t, inst, row) {
  const items = [
    { icon: "open", label: "Open", kbd: "⏎", run: () => ACT.open(t.id) },
    { icon: "pin", label: t.pinned ? "Unpin" : "Pin", kbd: "P", run: () => ACT.pin(t.id) },
    { icon: "copy", label: "Copy branch name", run: () => Toast.show(`Copied ${t.branch}`) },
  ];
  if (t.pr)
    items.push({
      icon: "external",
      label: `Open PR #${t.pr.n}`,
      run: () => Toast.show(`Opening PR #${t.pr.n}`),
    });
  items.push(
    { sep: true },
    {
      icon: "clock",
      label: t.snoozed ? "Unsnooze" : "Snooze until tomorrow",
      run: () => ACT.snooze(t.id),
    },
    {
      icon: t.settled ? "undo" : "check",
      label: t.settled ? "Move to Active" : "Settle",
      kbd: "E",
      disabled: !t.settled && !canSettle(t),
      reason: settleBlock(t),
      run: () => settleFlow(t.id, inst, row),
    },
    { sep: true },
    { icon: "archive", label: "Archive", danger: true, run: () => ACT.archive(t.id) },
  );
  return items;
}

/* ------------------------------------------------------------ global input */
const instOf = (el) => {
  const root = el.closest("[data-inst]");
  return root ? INSTS.find((i) => i.id === root.dataset.inst) : null;
};
document.addEventListener("click", (e) => {
  const a = e.target.closest("[data-act]");
  if (!a) return;
  const id = a.dataset.id || a.closest("[data-id]")?.dataset.id;
  const inst = instOf(a);
  const row = a.closest(".row");
  switch (a.dataset.act) {
    case "open":
      ACT.open(id);
      break;
    case "settle":
      settleFlow(id, inst, row);
      break;
    case "menu": {
      const r = a.getBoundingClientRect();
      Menu.open(
        { x: r.right, y: r.bottom + 4, h: r.height + 8, alignRight: true },
        menuFor(T(id), inst, row),
        row,
      );
      break;
    }
    case "approve":
      ACT.approve(id);
      break;
    case "deny":
      ACT.deny(id);
      break;
    case "answer":
      ACT.answer(id, +a.dataset.i);
      break;
    case "retry":
      ACT.retry(id);
      break;
    case "toggleSettled":
      S.settledOpen = !S.settledOpen;
      emit();
      break;
    case "toggleSnoozed":
      S.snoozedOpen = !S.snoozedOpen;
      emit();
      break;
    default:
      inst?.dir.onAct?.(a.dataset.act, id, a, inst);
  }
});
document.addEventListener("contextmenu", (e) => {
  const row = e.target.closest(".sb .row");
  if (!row) return;
  e.preventDefault();
  Menu.open({ x: e.clientX, y: e.clientY }, menuFor(T(row.dataset.id), instOf(row), row), row);
});
document.addEventListener("keydown", (e) => {
  if (e.target.closest?.("input, textarea") || e.metaKey || e.ctrlKey || e.altKey) return;
  if (Menu.isOpen()) return;
  if (e.key === "Escape") {
    Pop.close();
    Card.close();
    return;
  }
  const inst = activeInst();
  if (!inst) return;
  const order = inst.order;
  const idx = order.indexOf(S.selected);
  const moveTo = (i) => {
    const id = order[Math.max(0, Math.min(order.length - 1, i))];
    if (!id) return;
    ACT.open(id);
    rowOf(inst, id)?.scrollIntoView({ block: "nearest", behavior: motion ? "smooth" : "auto" });
    if (Card.isOpen()) Card.openNow(inst, rowOf(inst, id));
  };
  const t = T(S.selected);
  if (e.key === "ArrowDown" || e.key === "j") moveTo(idx + 1);
  else if (e.key === "ArrowUp" || e.key === "k") moveTo(idx - 1);
  else if (e.key === "e" && t) settleFlow(t.id, inst, rowOf(inst, t.id));
  else if (e.key === "p" && t) ACT.pin(t.id);
  else if (e.key === "Enter" && t) {
    if (t.state === "input" && t.input.kind === "approval") ACT.approve(t.id);
    else ACT.open(t.id);
  } else if (e.key === " " && t) inst.dir.peek?.(inst, t.id);
  else return;
  e.preventDefault();
});
