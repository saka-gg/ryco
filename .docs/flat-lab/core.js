/* Flat surfaces lab — shared motion + layer primitives. */
(() => {
  const Lab = {
    speed: 1,
    reduced: false,
    get mult() {
      return this.reduced ? 0 : this.speed;
    },
  };

  const EASE = {
    out: "cubic-bezier(0.23, 1, 0.32, 1)",
    house: "cubic-bezier(0.16, 1, 0.3, 1)",
    inOut: "cubic-bezier(0.77, 0, 0.175, 1)",
  };

  const dur = (ms) => Math.max(0, ms * Lab.mult);

  /* WAAPI wrapper: durations follow the lab speed. `keep` holds the end state
     (for exits that are removed afterwards); otherwise the from-state is held
     through the delay only, so CSS owns the element again once it settles. */
  function anim(el, frames, { duration = 200, easing = EASE.out, delay = 0, keep = false } = {}) {
    return el.animate(frames, {
      duration: dur(duration),
      delay: dur(delay),
      easing,
      fill: keep ? "forwards" : "backwards",
    });
  }

  /* Damped spring sampled into a CSS linear() curve. */
  function spring({ stiffness = 320, damping = 30, mass = 1 } = {}) {
    const dt = 1 / 240;
    let x = 0;
    let v = 0;
    let t = 0;
    const pts = [0];
    while (t < 4) {
      const a = (-stiffness * (x - 1) - damping * v) / mass;
      v += a * dt;
      x += v * dt;
      t += dt;
      pts.push(x);
      if (Math.abs(1 - x) < 0.0008 && Math.abs(v) < 0.01) break;
    }
    const n = 56;
    const out = [];
    for (let i = 0; i < n; i += 1) {
      out.push(+pts[Math.round((i / (n - 1)) * (pts.length - 1))].toFixed(4));
    }
    out[n - 1] = 1;
    return { easing: `linear(${out.join(", ")})`, duration: Math.round(t * 1000) };
  }

  const SPR = {
    snappy: spring({ stiffness: 520, damping: 38 }),
    soft: spring({ stiffness: 260, damping: 26 }),
    morph: spring({ stiffness: 300, damping: 31 }),
    pop: spring({ stiffness: 620, damping: 26 }),
  };

  document.documentElement.style.setProperty("--spring-snappy", SPR.snappy.easing);
  document.documentElement.style.setProperty("--spring-soft", SPR.soft.easing);

  /* ───────── DOM helpers ───────── */

  function el(html) {
    const t = document.createElement("template");
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  }

  const esc = (s) =>
    String(s ?? "").replace(
      /[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
    );

  /* Rect relative to the app frame's padding box (where .layer lives). */
  function relRect(node, app) {
    const r = node.getBoundingClientRect();
    const a = app.getBoundingClientRect();
    return {
      left: r.left - a.left - app.clientLeft,
      top: r.top - a.top - app.clientTop,
      width: r.width,
      height: r.height,
    };
  }

  const radiusOf = (node, fallback = 8) =>
    parseFloat(getComputedStyle(node).borderTopLeftRadius) || fallback;

  /* ───────── Icons (lucide) ───────── */

  const P = {
    paperclip:
      '<path d="m16 6-8.414 8.586a2 2 0 0 0 2.829 2.829l8.414-8.586a4 4 0 1 0-5.657-5.657l-8.379 8.551a6 6 0 1 0 8.485 8.485l8.379-8.551"/>',
    "chevron-down": '<path d="m6 9 6 6 6-6"/>',
    "chevron-right": '<path d="m9 18 6-6-6-6"/>',
    laptop:
      '<path d="M18 5a2 2 0 0 1 2 2v8.526a2 2 0 0 0 .212.897l1.068 2.127a1 1 0 0 1-.9 1.45H3.62a1 1 0 0 1-.9-1.45l1.068-2.127A2 2 0 0 0 4 15.526V7a2 2 0 0 1 2-2z"/><path d="M20.054 15.987H3.946"/>',
    server:
      '<rect width="20" height="8" x="2" y="2" rx="2"/><rect width="20" height="8" x="2" y="14" rx="2"/><path d="M6 6h.01"/><path d="M6 18h.01"/>',
    "lock-open":
      '<rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/>',
    lock: '<rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    "arrow-up": '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
    plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
    play: '<path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z"/>',
    flask:
      '<path d="M14 2v6a2 2 0 0 0 .245.96l5.51 10.08A2 2 0 0 1 18 22H6a2 2 0 0 1-1.755-2.96l5.51-10.08A2 2 0 0 0 10 8V2"/><path d="M6.453 15h11.094"/><path d="M8.5 2h7"/>',
    "list-checks":
      '<path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/>',
    wrench:
      '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
    hammer:
      '<path d="m15 12-8.373 8.373a1 1 0 1 1-3-3L12 9"/><path d="m18 15 4-4"/><path d="m21.5 11.5-1.914-1.914A2 2 0 0 1 19 8.172V7l-2.26-2.26a6 6 0 0 0-4.202-1.756L9 2.96l.92.82A6.18 6.18 0 0 1 12 8.4V10l2 2h1.172a2 2 0 0 1 1.414.586L18.5 14.5"/>',
    bug: '<path d="m8 2 1.88 1.88"/><path d="M14.12 3.88 16 2"/><path d="M9 7.13v-1a3.003 3.003 0 1 1 6 0v1"/><path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6"/><path d="M12 20v-9"/><path d="M6.53 9C4.6 8.8 3 7.1 3 5"/><path d="M6 13H2"/><path d="M3 21c0-2.1 1.7-3.9 3.8-4"/><path d="M20.97 5c0 2.1-1.6 3.8-3.5 4"/><path d="M22 13h-4"/><path d="M17.2 17c2.1.1 3.8 1.9 3.8 4"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    sliders:
      '<path d="M20 7h-9"/><path d="M14 17H5"/><circle cx="17" cy="17" r="3"/><circle cx="7" cy="7" r="3"/>',
    "git-branch":
      '<line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
    terminal: '<polyline points="4 17 10 11 4 5"/><line x1="12" x2="20" y1="19" y2="19"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    "square-pen":
      '<path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z"/>',
    "panel-left": '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/>',
    chart:
      '<path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/>',
    image:
      '<rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>',
    file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
    moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
    trash:
      '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
    box: '<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
    "corner-down-left": '<polyline points="9 10 4 15 9 20"/><path d="M20 4v7a4 4 0 0 1-4 4H4"/>',
    undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11"/>',
  };

  const icon = (name, cls = "") =>
    `<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true">${P[name] ?? ""}</svg>`;

  function brand(name, cls = "") {
    const b = window.BRAND?.[name];
    if (!b) return "";
    if (name === "Ryco") {
      return `<svg class="${cls}" viewBox="${b.viewBox}" aria-hidden="true"><g transform="${b.transform}" fill="currentColor">${b.paths.map((d) => `<path d="${d}"/>`).join("")}</g></svg>`;
    }
    const kind = name === "OpenAI" ? "openai" : "claude";
    return `<svg class="brand ${kind} ${cls}" viewBox="${b.viewBox}" aria-hidden="true">${b.paths.map((d) => `<path d="${d}"/>`).join("")}</svg>`;
  }

  /* ───────── Motion helpers ───────── */

  /* FLIP every element in `nodes` across a DOM mutation. */
  function flip(nodes, mutate, { duration = 240, easing = EASE.out } = {}) {
    const first = new Map(nodes.map((n) => [n, n.getBoundingClientRect()]));
    mutate();
    for (const [n, r] of first) {
      if (!n.isConnected) continue;
      const now = n.getBoundingClientRect();
      const dx = r.left - now.left;
      const dy = r.top - now.top;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
      n.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], {
        duration: dur(duration),
        easing,
      });
    }
  }

  /* Animate a container's height across a mutation. */
  function heightTween(node, mutate, { duration = 220, easing = EASE.out } = {}) {
    const h0 = node.getBoundingClientRect().height;
    mutate();
    const h1 = node.getBoundingClientRect().height;
    if (Math.abs(h0 - h1) < 0.5) return Promise.resolve();
    return node
      .animate([{ height: `${h0}px` }, { height: `${h1}px` }], { duration: dur(duration), easing })
      .finished.catch(() => {});
  }

  function shake(node) {
    return anim(
      node,
      [
        { transform: "translateX(0)" },
        { transform: "translateX(-5px)" },
        { transform: "translateX(4px)" },
        { transform: "translateX(-2px)" },
        { transform: "translateX(0)" },
      ],
      { duration: 280, easing: "ease-out" },
    );
  }

  /* Old label rolls up and out, new one rolls in; width follows. */
  function rollText(roll, text, { easing = SPR.snappy.easing, duration = 280 } = {}) {
    const spans = [...roll.children];
    const old = spans.at(-1);
    if (old && old.textContent === text) return;
    spans.slice(0, -1).forEach((s) => s.remove());
    const w0 = roll.getBoundingClientRect().width;
    const next = document.createElement("span");
    next.textContent = text;
    roll.appendChild(next);
    const w1 = next.getBoundingClientRect().width;
    roll.animate([{ width: `${w0}px` }, { width: `${w1}px` }], { duration: dur(duration), easing });
    if (old) {
      anim(
        old,
        [
          { transform: "none", opacity: 1 },
          { transform: "translateY(-75%)", opacity: 0 },
        ],
        { duration: duration * 0.7, keep: true },
      ).finished.then(() => old.remove());
    }
    anim(
      next,
      [
        { transform: "translateY(75%)", opacity: 0 },
        { transform: "none", opacity: 1 },
      ],
      { duration, easing },
    );
  }

  /* Swap an element's markup with a scale/rotate hand-off. */
  function swapIcon(holder, html, { easing = SPR.snappy.easing, duration = 260 } = {}) {
    holder.innerHTML = html;
    const svg = holder.firstElementChild;
    if (svg)
      anim(
        svg,
        [
          { transform: "scale(.5) rotate(-25deg)", opacity: 0 },
          { transform: "none", opacity: 1 },
        ],
        { duration, easing },
      );
  }

  /* One highlight that glides between items instead of each item painting
     its own hover. Pointer and keyboard share it. */
  function glide(container, itemSelector, { className = "glide" } = {}) {
    const g = document.createElement("span");
    g.className = className;
    g.setAttribute("aria-hidden", "true");
    container.prepend(g);
    let current = null;
    function moveTo(item) {
      current = item;
      if (!item) {
        delete g.dataset.on;
        return;
      }
      const cr = container.getBoundingClientRect();
      const r = item.getBoundingClientRect();
      const x = r.left - cr.left + container.scrollLeft - container.clientLeft;
      const y = r.top - cr.top + container.scrollTop - container.clientTop;
      const set = () => {
        g.style.transform = `translate(${x}px, ${y}px)`;
        g.style.width = `${r.width}px`;
        g.style.height = `${r.height}px`;
      };
      if (!g.dataset.on) {
        g.style.transition = "none";
        set();
        void g.offsetWidth;
        g.style.transition = "";
      } else set();
      g.dataset.on = "";
    }
    container.addEventListener("pointerover", (e) => {
      const it = e.target.closest(itemSelector);
      if (it && container.contains(it)) moveTo(it);
    });
    container.addEventListener("pointerleave", () => moveTo(null));
    return {
      moveTo,
      el: g,
      get current() {
        return current;
      },
    };
  }

  /* Container transform: a childless ghost travels between two rects. */
  function morph({
    layer,
    ghostClass,
    from,
    to,
    fromRadius,
    toRadius,
    sp = SPR.morph,
    before = null,
  }) {
    const g = document.createElement("div");
    g.className = `morph-ghost ${ghostClass}`;
    layer.insertBefore(g, before);
    const kf = (r, rad) => ({
      left: `${r.left}px`,
      top: `${r.top}px`,
      width: `${r.width}px`,
      height: `${r.height}px`,
      borderRadius: `${rad}px`,
    });
    const a = g.animate([kf(from, fromRadius), kf(to, toRadius)], {
      duration: dur(sp.duration),
      easing: sp.easing,
      fill: "forwards",
    });
    return { ghost: g, anim: a, done: a.finished.then(() => g).catch(() => g) };
  }

  /* ───────── Layer stack: Escape and outside-press close the top layer only ───────── */

  const stack = [];
  const removeLayer = (h) => {
    const i = stack.indexOf(h);
    if (i >= 0) stack.splice(i, 1);
  };
  const topLayer = () => stack.at(-1);

  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Escape" || !stack.length) return;
      e.preventDefault();
      e.stopPropagation();
      topLayer().close("escape");
    },
    true,
  );

  document.addEventListener(
    "pointerdown",
    (e) => {
      const top = topLayer();
      if (!top || top.modal) return;
      if (top.el.contains(e.target) || top.trigger?.contains(e.target)) return;
      e.labDismissed = true;
      top.close("outside");
    },
    true,
  );

  /* ───────── Popover ───────── */

  const POP_ENTER = {
    scale(pop) {
      anim(
        pop,
        [
          { opacity: 0, transform: "scale(.96)" },
          { opacity: 1, transform: "none" },
        ],
        { duration: 170 },
      );
      return Promise.resolve();
    },
    slide(pop, ctx) {
      const y = ctx.side === "top" ? 6 : -6;
      anim(
        pop,
        [
          { opacity: 0, transform: `translateY(${y}px)` },
          { opacity: 1, transform: "none" },
        ],
        { duration: 130 },
      );
      return Promise.resolve();
    },
    morph(pop, ctx) {
      pop.classList.add("morphing");
      const content = pop.firstElementChild;
      const m = morph({
        layer: ctx.layer,
        ghostClass: "overlay",
        from: ctx.t,
        to: ctx.rect,
        fromRadius: radiusOf(ctx.trigger),
        toRadius: radiusOf(pop, 12),
        before: pop,
      });
      pop._ghost = m.ghost;
      anim(
        content,
        [
          { opacity: 0, transform: "translateY(4px)" },
          { opacity: 1, transform: "none" },
        ],
        { duration: 180, delay: SPR.morph.duration * 0.42 },
      );
      return m.done.then((g) => {
        if (pop._ghost === g) {
          pop.classList.remove("morphing");
          g.remove();
          pop._ghost = null;
        }
      });
    },
  };

  const POP_EXIT = {
    scale: (pop) =>
      anim(
        pop,
        [
          { opacity: 1, transform: "none" },
          { opacity: 0, transform: "scale(.98)" },
        ],
        { duration: 110, keep: true },
      ).finished,
    slide: (pop, ctx) =>
      anim(
        pop,
        [
          { opacity: 1, transform: "none" },
          { opacity: 0, transform: `translateY(${ctx.side === "top" ? 4 : -4}px)` },
        ],
        { duration: 90, keep: true },
      ).finished,
    morph(pop, ctx) {
      pop._ghost?.remove();
      pop._ghost = null;
      const from = relRect(pop, ctx.app);
      pop.classList.add("morphing");
      anim(pop.firstElementChild, [{ opacity: 1 }, { opacity: 0 }], { duration: 80, keep: true });
      const back = { duration: 260, easing: EASE.out };
      const m = morph({
        layer: ctx.layer,
        ghostClass: "overlay",
        from,
        to: relRect(ctx.trigger, ctx.app),
        fromRadius: radiusOf(pop, 12),
        toRadius: radiusOf(ctx.trigger),
        sp: back,
        before: pop,
      });
      anim(m.ghost, [{ opacity: 1 }, { opacity: 1, offset: 0.55 }, { opacity: 0 }], {
        duration: back.duration,
        easing: "linear",
        keep: true,
      });
      return m.done.then((g) => g.remove());
    },
  };

  function popover({
    trigger,
    content,
    side = "top",
    align = "start",
    offset = 8,
    enter = "scale",
    className = "",
    onClose,
    label = "",
  }) {
    const app = trigger.closest(".app");
    const layer = app.querySelector(".layer");
    const pop = document.createElement("div");
    pop.className = `pop overlay ${className}`;
    pop.tabIndex = -1;
    pop.setAttribute("role", "dialog");
    if (label) pop.setAttribute("aria-label", label);
    pop.appendChild(content);
    layer.appendChild(pop);

    const W = app.clientWidth;
    const H = app.clientHeight;
    const t = relRect(trigger, app);
    const pw = pop.offsetWidth;
    const ph = pop.offsetHeight;
    let left =
      align === "start"
        ? t.left
        : align === "end"
          ? t.left + t.width - pw
          : t.left + t.width / 2 - pw / 2;
    left = Math.max(8, Math.min(W - pw - 8, left));
    let top = side === "top" ? t.top - ph - offset : t.top + t.height + offset;
    top = Math.max(8, Math.min(H - ph - 8, top));
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
    pop.style.transformOrigin = `${t.left + t.width / 2 - left}px ${side === "top" ? ph + offset : -offset}px`;

    trigger.dataset.open = "";
    trigger.setAttribute("aria-expanded", "true");
    const ctx = { app, layer, trigger, side, t, rect: { left, top, width: pw, height: ph } };
    let closed = false;
    const handle = { el: pop, trigger, modal: false, close, ctx };
    stack.push(handle);
    POP_ENTER[enter](pop, ctx);

    function close(reason) {
      if (closed) return;
      closed = true;
      removeLayer(handle);
      delete trigger.dataset.open;
      trigger.setAttribute("aria-expanded", "false");
      onClose?.(reason);
      POP_EXIT[enter](pop, ctx).then(() => pop.remove());
      if (reason === "escape" || reason === "pick") trigger.focus({ preventScroll: true });
    }
    return handle;
  }

  const isOpenFor = (trigger) => stack.find((h) => h.trigger === trigger);

  /* ───────── Modal ───────── */

  function modal({ app, panel, wrapClass = "", enter, exit, trigger, onClose, initialFocus }) {
    const layer = app.querySelector(".layer");
    const covered = [...stack].reverse().find((h) => h.modal);
    const scrim = el(`<div class="scrim${covered ? " nested" : ""}"></div>`);
    const wrap = el(`<div class="modal-wrap ${wrapClass}"></div>`);
    wrap.appendChild(panel);
    layer.append(scrim, wrap);
    if (covered) covered.panel.toggleAttribute("data-covered", true);
    anim(scrim, [{ opacity: 0 }, { opacity: 1 }], { duration: 200 });

    let closed = false;
    const handle = { modal: true, el: wrap, panel, trigger, layer, app, scrim, wrap, close };
    stack.push(handle);

    const outside = (e) => {
      if (e.labDismissed) return;
      if (e.target === wrap || e.target === scrim) close("outside");
    };
    scrim.addEventListener("pointerdown", outside);
    wrap.addEventListener("pointerdown", outside);

    Promise.resolve(enter?.(panel, handle)).then(() => {});
    requestAnimationFrame(() => (initialFocus?.() ?? panel).focus?.({ preventScroll: true }));

    function close(reason, opts = {}) {
      if (closed) return Promise.resolve();
      closed = true;
      removeLayer(handle);
      if (covered) covered.panel.removeAttribute("data-covered");
      onClose?.(reason);
      anim(scrim, [{ opacity: 1 }, { opacity: 0 }], { duration: 170, keep: true });
      const run = opts.exit ?? exit;
      const done = run
        ? Promise.resolve(run(panel, handle, reason))
        : anim(
            panel,
            [
              { opacity: 1, transform: "none" },
              { opacity: 0, transform: "scale(.985)" },
            ],
            { duration: 130, keep: true },
          ).finished;
      return done.then(() => {
        scrim.remove();
        wrap.remove();
        if (reason !== "saved" && reason !== "deleted" && trigger?.isConnected)
          trigger.focus({ preventScroll: true });
      });
    }
    return handle;
  }

  /* ───────── Toast ───────── */

  const TOAST_ENTER = {
    a: (t) =>
      anim(
        t,
        [
          { opacity: 0, transform: "translateY(-6px)" },
          { opacity: 1, transform: "none" },
        ],
        { duration: 220 },
      ),
    b: (t) =>
      anim(
        t,
        [
          { opacity: 0, transform: "translateY(-16px) scale(.94)" },
          { opacity: 1, transform: "none" },
        ],
        { duration: SPR.soft.duration, easing: SPR.soft.easing },
      ),
    c: (t) =>
      anim(
        t,
        [
          { opacity: 0, transform: "translateX(14px)" },
          { opacity: 1, transform: "none" },
        ],
        { duration: 140 },
      ),
  };

  function toast(
    app,
    { title, sub = "", iconName = "check", action, variant = "a", timeout = 4200 },
  ) {
    const wrap = app.querySelector(".toasts");
    const t = el(`<div class="toast overlay" role="status">
      <span class="t-ico">${icon(iconName, "sm")}</span>
      <div class="t-body"><div class="t-title">${title}</div>${sub ? `<div class="t-sub">${sub}</div>` : ""}</div>
      ${action ? `<button class="t-act" type="button">${esc(action.label)}</button>` : ""}
    </div>`);
    const others = [...wrap.children];
    flip(others, () => wrap.prepend(t), { duration: 260 });
    TOAST_ENTER[variant](t);
    let timer = null;
    let left = timeout;
    let started = 0;
    const arm = () => {
      started = performance.now();
      timer = setTimeout(dismiss, left);
    };
    const pause = () => {
      clearTimeout(timer);
      left -= performance.now() - started;
    };
    t.addEventListener("pointerenter", pause);
    t.addEventListener("pointerleave", arm);
    arm();
    let gone = false;
    function dismiss() {
      if (gone) return;
      gone = true;
      clearTimeout(timer);
      anim(
        t,
        [
          { opacity: 1, transform: "none" },
          {
            opacity: 0,
            transform: variant === "c" ? "translateX(14px)" : "translateY(-4px) scale(.98)",
          },
        ],
        { duration: 140, keep: true },
      ).finished.then(() => {
        const rest = [...wrap.children].filter((c) => c !== t);
        flip(rest, () => t.remove(), { duration: 220 });
      });
    }
    t.querySelector(".t-act")?.addEventListener("click", () => {
      action.onClick();
      dismiss();
    });
    return { dismiss };
  }

  /* ───────── Shortcuts ───────── */

  const MOD_ORDER = ["ctrl", "alt", "shift", "meta"];
  const MOD_SYM = { ctrl: "⌃", alt: "⌥", shift: "⇧", meta: "⌘" };
  const KEY_MAP = {
    Enter: "↵",
    ArrowUp: "↑",
    ArrowDown: "↓",
    ArrowLeft: "←",
    ArrowRight: "→",
    Space: "Space",
    Comma: ",",
    Period: ".",
    Slash: "/",
    Semicolon: ";",
    Quote: "'",
    BracketLeft: "[",
    BracketRight: "]",
    Backslash: "\\",
    Minus: "-",
    Equal: "=",
    Backquote: "`",
  };

  function keyFromEvent(e) {
    if (/^Key[A-Z]$/.test(e.code)) return e.code.slice(3);
    if (/^Digit\d$/.test(e.code)) return e.code.slice(5);
    if (KEY_MAP[e.code]) return KEY_MAP[e.code];
    if (/^F\d{1,2}$/.test(e.key)) return e.key;
    return null;
  }

  const comboParts = (c) => [...MOD_ORDER.filter((m) => c[m]).map((m) => MOD_SYM[m]), c.key];
  const comboText = (c) => (c ? comboParts(c).join("") : "");
  const matchCombo = (e, c) =>
    !!c &&
    e.metaKey === !!c.meta &&
    e.ctrlKey === !!c.ctrl &&
    e.altKey === !!c.alt &&
    e.shiftKey === !!c.shift &&
    keyFromEvent(e) === c.key;

  const CAP_ENTER = {
    a: (k) =>
      anim(
        k,
        [
          { opacity: 0, transform: "translateY(2px)" },
          { opacity: 1, transform: "none" },
        ],
        { duration: 150 },
      ),
    b: (k, i) =>
      anim(
        k,
        [
          { opacity: 0, transform: "translateY(-8px) scale(.6)" },
          { opacity: 1, transform: "none" },
        ],
        { duration: SPR.pop.duration, easing: SPR.pop.easing, delay: i * 45 },
      ),
    c: (k, i) => anim(k, [{ opacity: 0 }, { opacity: 1 }], { duration: 90, delay: i * 20 }),
  };

  function keyCapture(field, { value = null, onChange, variant = "a" }) {
    let combo = value;
    let live = false;
    const ph = () => {
      field.innerHTML = '<span class="ph">Press a shortcut</span>';
    };
    function render(animate) {
      live = false;
      if (!combo) {
        ph();
        if (animate)
          anim(field.firstElementChild, [{ opacity: 0 }, { opacity: 1 }], { duration: 120 });
        return;
      }
      field.innerHTML = "";
      const caps = comboParts(combo).map((p) => {
        const k = document.createElement("span");
        k.className = "kc";
        k.textContent = p;
        field.appendChild(k);
        return k;
      });
      const clr = el(
        `<button type="button" class="icon-btn clear" aria-label="Clear shortcut">${icon("x", "xs")}</button>`,
      );
      clr.addEventListener("click", (e) => {
        e.stopPropagation();
        set(null);
        field.focus();
      });
      field.appendChild(clr);
      if (animate) caps.forEach((k, i) => CAP_ENTER[variant](k, i));
    }
    function renderLive(mods) {
      const held = MOD_ORDER.filter((m) => mods[m]);
      if (!held.length) {
        render(false);
        return;
      }
      live = true;
      field.innerHTML = held.map((m) => `<span class="kc" data-live>${MOD_SYM[m]}</span>`).join("");
    }
    function set(c) {
      combo = c;
      render(true);
      onChange?.(combo);
    }
    field.addEventListener("keydown", (e) => {
      if (e.key === "Tab" || e.key === "Escape") return;
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Backspace" || e.key === "Delete") {
        set(null);
        return;
      }
      const mods = { meta: e.metaKey, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey };
      if (["Meta", "Control", "Alt", "Shift"].includes(e.key)) {
        renderLive(mods);
        return;
      }
      const key = keyFromEvent(e);
      if (!key) return;
      if (!mods.meta && !mods.ctrl && !mods.alt && !/^F\d/.test(key)) {
        shake(field);
        return;
      }
      set({ ...mods, key });
    });
    field.addEventListener("keyup", (e) => {
      if (!live) return;
      renderLive({ meta: e.metaKey, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey });
    });
    field.addEventListener("blur", () => live && render(false));
    render(false);
    return {
      get: () => combo,
      set,
    };
  }

  window.Core = {
    Lab,
    EASE,
    SPR,
    dur,
    anim,
    spring,
    el,
    esc,
    relRect,
    radiusOf,
    icon,
    brand,
    flip,
    heightTween,
    shake,
    rollText,
    swapIcon,
    glide,
    morph,
    popover,
    isOpenFor,
    modal,
    toast,
    keyCapture,
    comboText,
    matchCombo,
    stack,
  };
})();
