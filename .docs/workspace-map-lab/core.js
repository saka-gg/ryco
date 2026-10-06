/* ============================================================
   Core: canvas engine shared by every direction.
   - createViewport: pan / zoom / fit with an animated camera
   - syncNodes:      keyed DOM nodes with enter / exit / FLIP moves
   - syncEdges:      keyed SVG wires that draw in and follow nodes
   - createInspector, Tip, createMinimap
   Directions only describe layout, markup and choreography.
   ============================================================ */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const h = (tag, cls, html) => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (html != null) el.innerHTML = html;
  return el;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const EASE = "cubic-bezier(.16,1,.3,1)";
const GENTLE = "cubic-bezier(.22,1,.36,1)";
const SNAPPY = "cubic-bezier(.3,1.36,.44,1)";
const MOVE_MS = 560;
let motion = !matchMedia("(prefers-reduced-motion: reduce)").matches;
const DIRS = {};
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );

/* Easing for rAF tweens (matches EASE closely). */
const easeOutExpo = (x) => (x >= 1 ? 1 : 1 - Math.pow(2, -10 * x));

/* ------------------------------------------------------------ viewport */
function createViewport(host, opts = {}) {
  const minK = opts.minZoom ?? 0.35;
  const maxK = opts.maxZoom ?? 2.2;
  host.classList.add("vp");
  const grid = h("div", "vp-grid");
  const world = h("div", "vp-world");
  const edges = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  edges.classList.add("vp-edges");
  edges.setAttribute("overflow", "visible");
  const nodes = h("div", "vp-nodes");
  world.append(edges, nodes);
  host.append(grid, world);

  const cam = { x: 0, y: 0, k: 1 };
  const listeners = [];
  let tween = null;

  function apply() {
    world.style.transform = `translate(${cam.x}px, ${cam.y}px) scale(${cam.k})`;
    const s = 22 * cam.k;
    host.style.setProperty("--grid-s", `${s}px`);
    host.style.setProperty("--grid-x", `${cam.x % s}px`);
    host.style.setProperty("--grid-y", `${cam.y % s}px`);
    host.style.setProperty("--k", cam.k);
    host.dataset.zoom = cam.k < 0.6 ? "far" : cam.k > 1.35 ? "near" : "mid";
    for (const fn of listeners) fn(cam);
  }

  function setCamera(next, o = {}) {
    const target = {
      x: next.x ?? cam.x,
      y: next.y ?? cam.y,
      k: clamp(next.k ?? cam.k, minK, maxK),
    };
    if (tween) cancelAnimationFrame(tween.raf);
    if (!o.animate || !motion) {
      Object.assign(cam, target);
      apply();
      return Promise.resolve();
    }
    const from = { ...cam };
    const dur = o.duration ?? 720;
    const t0 = performance.now();
    return new Promise((resolve) => {
      const step = (now) => {
        const p = easeOutExpo(Math.min(1, (now - t0) / dur));
        cam.x = from.x + (target.x - from.x) * p;
        cam.y = from.y + (target.y - from.y) * p;
        cam.k = from.k + (target.k - from.k) * p;
        apply();
        if (p < 1) tween = { raf: requestAnimationFrame(step) };
        else {
          tween = null;
          resolve();
        }
      };
      tween = { raf: requestAnimationFrame(step) };
    });
  }

  /* Fit a world-space box into the host. */
  function fit(b, o = {}) {
    const pad = o.padding ?? 64;
    const W = host.clientWidth;
    const H = host.clientHeight;
    if (!b || !W || !H || b.w <= 0 || b.h <= 0) return Promise.resolve();
    const k = clamp(Math.min((W - pad * 2) / b.w, (H - pad * 2) / b.h), minK, o.maxK ?? 1.15);
    return setCamera(
      { k, x: W / 2 - (b.x + b.w / 2) * k, y: H / 2 - (b.y + b.h / 2) * k },
      { animate: o.animate, duration: o.duration },
    );
  }

  function zoomAt(clientX, clientY, factor, o = {}) {
    const r = host.getBoundingClientRect();
    const px = clientX - r.left;
    const py = clientY - r.top;
    const k = clamp(cam.k * factor, minK, maxK);
    const wx = (px - cam.x) / cam.k;
    const wy = (py - cam.y) / cam.k;
    return setCamera({ k, x: px - wx * k, y: py - wy * k }, o);
  }
  const zoomBy = (factor) => {
    const r = host.getBoundingClientRect();
    return zoomAt(r.left + r.width / 2, r.top + r.height / 2, factor, {
      animate: true,
      duration: 380,
    });
  };

  /* Pan: drag empty canvas. Wheel: trackpad pans, ⌘/ctrl + wheel (or pinch) zooms. */
  let drag = null;
  const onDown = (e) => {
    if (e.button !== 0 || e.target.closest("[data-no-pan], .node, .vp-ui, button, a, input"))
      return;
    drag = { x: e.clientX, y: e.clientY, cx: cam.x, cy: cam.y, moved: false };
    host.setPointerCapture(e.pointerId);
    host.classList.add("is-panning");
  };
  const onMove = (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    setCamera({ x: drag.cx + dx, y: drag.cy + dy });
  };
  const onUp = (e) => {
    if (!drag) return;
    host.classList.remove("is-panning");
    const moved = drag.moved;
    drag = null;
    if (!moved && opts.onBackgroundClick) opts.onBackgroundClick(e);
  };
  const onWheel = (e) => {
    // Overlays (inspector, minimap, controls) scroll themselves.
    if (e.target.closest?.(".vp-ui")) return;
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0045));
    else setCamera({ x: cam.x - e.deltaX, y: cam.y - e.deltaY });
  };
  const onDbl = (e) => {
    if (e.target.closest(".node, .vp-ui")) return;
    opts.onFit?.();
  };
  host.addEventListener("pointerdown", onDown);
  host.addEventListener("pointermove", onMove);
  host.addEventListener("pointerup", onUp);
  host.addEventListener("pointercancel", onUp);
  host.addEventListener("wheel", onWheel, { passive: false });
  host.addEventListener("dblclick", onDbl);

  /* Zoom controls, bottom right. */
  function controls() {
    const ui = h(
      "div",
      "vp-ui vp-zoom",
      `<button type="button" data-z="out" data-tip="Zoom out">${ic("minus")}</button>
       <span class="vp-pct tnum">100%</span>
       <button type="button" data-z="in" data-tip="Zoom in">${ic("plus")}</button>
       <span class="vp-div"></span>
       <button type="button" data-z="fit" data-tip="Fit (double-click canvas)">${ic("fit")}</button>`,
    );
    ui.addEventListener("click", (e) => {
      const b = e.target.closest("[data-z]");
      if (!b) return;
      if (b.dataset.z === "in") zoomBy(1.25);
      else if (b.dataset.z === "out") zoomBy(0.8);
      else opts.onFit?.();
    });
    const pct = $(".vp-pct", ui);
    listeners.push(() => (pct.textContent = `${Math.round(cam.k * 100)}%`));
    host.append(ui);
    return ui;
  }

  apply();
  return {
    host,
    world,
    edges,
    nodes,
    cam,
    setCamera,
    fit,
    zoomBy,
    zoomAt,
    controls,
    onChange: (fn) => listeners.push(fn),
    toWorld(clientX, clientY) {
      const r = host.getBoundingClientRect();
      return { x: (clientX - r.left - cam.x) / cam.k, y: (clientY - r.top - cam.y) / cam.k };
    },
    destroy() {
      if (tween) cancelAnimationFrame(tween.raf);
      host.removeEventListener("pointerdown", onDown);
      host.removeEventListener("pointermove", onMove);
      host.removeEventListener("pointerup", onUp);
      host.removeEventListener("pointercancel", onUp);
      host.removeEventListener("wheel", onWheel);
      host.removeEventListener("dblclick", onDbl);
    },
  };
}

/* ------------------------------------------------------------ keyed nodes
   items: [{ key, x, y, html, cls, data? }]   (x, y: world px, top-left)
   o.enter(el, item, i)  custom entrance; default rises + fades in
   o.stagger             ms between entrances on first paint (0 = none)
   Returns Map key → { el, x, y, w, h }. Size is measured after render. */
function syncNodes(layer, items, o = {}) {
  const store = (layer._nodes ??= new Map());
  const seen = new Set();
  const first = !layer._painted;
  layer._painted = true;
  items.forEach((item, i) => {
    seen.add(item.key);
    let rec = store.get(item.key);
    if (!rec) {
      const el = h("div", `node ${item.cls ?? ""}`);
      el.dataset.key = item.key;
      el.innerHTML = item.html;
      el.style.transform = `translate(${item.x}px, ${item.y}px)`;
      layer.append(el);
      rec = { el, x: item.x, y: item.y, html: item.html, cls: item.cls };
      store.set(item.key, rec);
      if (motion && !o.noEnter) {
        const delay = first ? (o.stagger ?? 0) * i : 0;
        if (o.enter) o.enter(el, item, i, delay);
        else
          el.animate(
            [
              { opacity: 0, translate: "0 10px" },
              { opacity: 1, translate: "0 0" },
            ],
            { duration: 460, delay, easing: EASE, fill: "backwards" },
          );
      }
    } else {
      if (rec.html !== item.html) {
        rec.el.innerHTML = item.html;
        rec.html = item.html;
      }
      if (rec.cls !== item.cls) {
        rec.el.className = `node ${item.cls ?? ""}`;
        rec.cls = item.cls;
      }
      if (rec.x !== item.x || rec.y !== item.y) {
        const from = `translate(${rec.x}px, ${rec.y}px)`;
        const to = `translate(${item.x}px, ${item.y}px)`;
        rec.el.style.transform = to;
        if (motion)
          rec.el.animate([{ transform: from }, { transform: to }], {
            duration: MOVE_MS,
            easing: GENTLE,
          });
        rec.x = item.x;
        rec.y = item.y;
      }
    }
    if (item.data) rec.el._data = item.data;
  });
  for (const [key, rec] of store) {
    if (seen.has(key)) continue;
    store.delete(key);
    if (!motion) {
      rec.el.remove();
      continue;
    }
    rec.el.style.pointerEvents = "none";
    const anim = o.exit
      ? o.exit(rec.el)
      : rec.el.animate(
          [
            { opacity: 1, translate: "0 0" },
            { opacity: 0, translate: "0 6px" },
          ],
          { duration: 240, easing: "ease-in", fill: "forwards" },
        );
    anim.finished.then(() => rec.el.remove()).catch(() => rec.el.remove());
  }
  for (const rec of store.values()) {
    rec.w = rec.el.offsetWidth;
    rec.h = rec.el.offsetHeight;
  }
  return store;
}

/* Ports on a node rect (world coords). */
const port = (r, side = "right", t = 0.5) =>
  side === "right"
    ? { x: r.x + r.w, y: r.y + r.h * t }
    : side === "left"
      ? { x: r.x, y: r.y + r.h * t }
      : side === "top"
        ? { x: r.x + r.w * t, y: r.y }
        : { x: r.x + r.w * t, y: r.y + r.h };

/* Smooth wire between two points. dir "h" (left→right) or "v" (top→bottom). */
function curve(a, b, dir = "h", bend = 0.5) {
  if (dir === "v") {
    const dy = Math.max(28, Math.abs(b.y - a.y) * bend);
    return `M ${a.x} ${a.y} C ${a.x} ${a.y + dy}, ${b.x} ${b.y - dy}, ${b.x} ${b.y}`;
  }
  const dx = Math.max(36, Math.abs(b.x - a.x) * bend);
  return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
}

/* ------------------------------------------------------------ keyed edges
   edges: [{ key, d, cls }]. New wires draw in; moved wires morph their
   path (CSS `d` transition, same curve as node moves); gone wires fade. */
function syncEdges(svg, edges, o = {}) {
  const store = (svg._edges ??= new Map());
  const seen = new Set();
  const first = !svg._painted;
  svg._painted = true;
  edges.forEach((edge, i) => {
    seen.add(edge.key);
    let rec = store.get(edge.key);
    if (!rec) {
      const el = document.createElementNS("http://www.w3.org/2000/svg", "path");
      el.setAttribute("class", `edge ${edge.cls ?? ""}`);
      el.style.d = `path("${edge.d}")`;
      svg.append(el);
      rec = { el, d: edge.d, cls: edge.cls };
      store.set(edge.key, rec);
      if (motion && !o.noEnter) {
        const delay = first ? (o.stagger ?? 0) * i + (o.delay ?? 0) : (o.delay ?? 140);
        const dashed = getComputedStyle(el).strokeDasharray !== "none";
        if (dashed) {
          // A dash-array draw would flatten the pattern; patterned wires fade in.
          el.animate([{ opacity: 0 }, { opacity: "" }], {
            duration: 420,
            delay,
            easing: "ease-out",
            fill: "backwards",
          });
        } else {
          const len = el.getTotalLength?.() || 200;
          el.animate(
            [
              { strokeDasharray: `${len}`, strokeDashoffset: `${len}` },
              { strokeDasharray: `${len}`, strokeDashoffset: "0" },
            ],
            { duration: 620, delay, easing: EASE, fill: "backwards" },
          );
        }
      }
    } else {
      if (rec.d !== edge.d) {
        rec.el.style.d = `path("${edge.d}")`;
        rec.d = edge.d;
      }
      if (rec.cls !== edge.cls) {
        rec.el.setAttribute("class", `edge ${edge.cls ?? ""}`);
        rec.cls = edge.cls;
      }
    }
  });
  for (const [key, rec] of store) {
    if (seen.has(key)) continue;
    store.delete(key);
    if (!motion) {
      rec.el.remove();
      continue;
    }
    rec.el
      .animate([{ opacity: 1 }, { opacity: 0 }], { duration: 220, fill: "forwards" })
      .finished.then(() => rec.el.remove())
      .catch(() => rec.el.remove());
  }
  return store;
}

/* Bounds of a node map (world coords). */
function boundsOf(store, keys) {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const [key, r] of store) {
    if (keys && !keys.includes(key)) continue;
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + (r.w || 0));
    y1 = Math.max(y1, r.y + (r.h || 0));
  }
  return x0 === Infinity ? null : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/* ------------------------------------------------------------ inspector
   A panel that slides in from the canvas's right edge. Content swaps
   roll in the direction of travel. */
function createInspector(host, o = {}) {
  const panel = h(
    "aside",
    "insp vp-ui",
    `<button class="insp-x" type="button" data-tip="Close (Esc)">${ic("x")}</button><div class="insp-body"></div>`,
  );
  host.append(panel);
  const body = $(".insp-body", panel);
  let openKey = null;
  $(".insp-x", panel).addEventListener("click", () => {
    hide();
    o.onClose?.();
  });
  let openHtml = null;
  function show(key, html) {
    const wasOpen = panel.classList.contains("open");
    if (openKey === key && wasOpen) {
      // Called on every tick: only touch the DOM when the content changed,
      // so hover state, tooltips and scroll survive.
      if (html !== openHtml) {
        body.innerHTML = html;
        openHtml = html;
      }
      return;
    }
    openHtml = html;
    openKey = key;
    if (wasOpen && motion) {
      const old = body.cloneNode(true);
      old.classList.add("insp-old");
      panel.append(old);
      old
        .animate(
          [
            { opacity: 1, translate: "0 0" },
            { opacity: 0, translate: "0 -8px" },
          ],
          { duration: 180, fill: "forwards" },
        )
        .finished.then(() => old.remove());
      body.innerHTML = html;
      body.animate(
        [
          { opacity: 0, translate: "0 10px" },
          { opacity: 1, translate: "0 0" },
        ],
        { duration: 340, easing: EASE },
      );
    } else body.innerHTML = html;
    panel.classList.add("open");
  }
  function hide() {
    openKey = null;
    panel.classList.remove("open");
  }
  return {
    panel,
    body,
    show,
    hide,
    get key() {
      return openKey;
    },
  };
}

/* ------------------------------------------------------------ tooltips
   Any [data-tip] in the document. One bubble that glides between targets. */
const Tip = (() => {
  const el = h("div", "tip");
  document.addEventListener("DOMContentLoaded", () => document.body.append(el));
  let target = null;
  let timer = 0;
  const place = (t) => {
    const r = t.getBoundingClientRect();
    el.textContent = t.dataset.tip;
    const w = el.offsetWidth;
    el.style.left = `${clamp(r.left + r.width / 2 - w / 2, 6, innerWidth - w - 6)}px`;
    el.style.top = `${r.top - el.offsetHeight - 8}px`;
  };
  document.addEventListener("pointerover", (e) => {
    const t = e.target.closest?.("[data-tip]");
    if (t === target) return;
    target = t;
    clearTimeout(timer);
    if (!t) {
      el.classList.remove("on");
      return;
    }
    const open = el.classList.contains("on");
    timer = setTimeout(
      () => {
        place(t);
        el.classList.add("on");
      },
      open ? 0 : 380,
    );
  });
  document.addEventListener("pointerdown", () => {
    clearTimeout(timer);
    el.classList.remove("on");
  });
  return { hide: () => el.classList.remove("on") };
})();

/* ------------------------------------------------------------ minimap
   Node rects plus the visible window; click or drag to move the camera. */
function createMinimap(vp, getStore, o = {}) {
  const W = o.width ?? 168;
  const H = o.height ?? 104;
  const box = h("div", "vp-ui minimap", `<canvas width="${W * 2}" height="${H * 2}"></canvas>`);
  vp.host.append(box);
  const cv = $("canvas", box);
  const ctx = cv.getContext("2d");
  let scale = 1,
    ox = 0,
    oy = 0;
  function draw() {
    const store = getStore();
    const b = boundsOf(store);
    ctx.clearRect(0, 0, cv.width, cv.height);
    if (!b) return;
    const pad = 80;
    scale = Math.min((W * 2) / (b.w + pad * 2), (H * 2) / (b.h + pad * 2));
    ox = -(b.x - pad) * scale + (W * 2 - (b.w + pad * 2) * scale) / 2;
    oy = -(b.y - pad) * scale + (H * 2 - (b.h + pad * 2) * scale) / 2;
    const css = getComputedStyle(vp.host);
    ctx.fillStyle = css.getPropertyValue("--mm-node").trim() || "#888";
    for (const r of store.values()) {
      ctx.globalAlpha = r.el?.classList.contains("dim") ? 0.35 : 1;
      ctx.beginPath();
      ctx.roundRect(
        r.x * scale + ox,
        r.y * scale + oy,
        Math.max(2, r.w * scale),
        Math.max(2, r.h * scale),
        3,
      );
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    const k = vp.cam.k;
    const vx = (-vp.cam.x / k) * scale + ox;
    const vy = (-vp.cam.y / k) * scale + oy;
    ctx.strokeStyle = css.getPropertyValue("--mm-view").trim() || "#aaa";
    ctx.lineWidth = 2;
    ctx.strokeRect(vx, vy, (vp.host.clientWidth / k) * scale, (vp.host.clientHeight / k) * scale);
  }
  const jump = (e) => {
    const r = cv.getBoundingClientRect();
    const mx = ((e.clientX - r.left) * 2 - ox) / scale;
    const my = ((e.clientY - r.top) * 2 - oy) / scale;
    vp.setCamera(
      { x: vp.host.clientWidth / 2 - mx * vp.cam.k, y: vp.host.clientHeight / 2 - my * vp.cam.k },
      { animate: e.type === "pointerdown", duration: 420 },
    );
  };
  let dragging = false;
  box.addEventListener("pointerdown", (e) => {
    dragging = true;
    box.setPointerCapture(e.pointerId);
    jump(e);
  });
  box.addEventListener("pointermove", (e) => dragging && jump(e));
  box.addEventListener("pointerup", () => (dragging = false));
  vp.onChange(draw);
  return { draw, el: box };
}

/* ------------------------------------------------------------ shared markup */
const deviceIcon = (id) => ic(DEVICES[id]?.icon ?? "laptop");
function statusDot(status) {
  return `<span class="sdot s-${status}" data-tip="${STATUS[status]?.label ?? status}"></span>`;
}
function providerMark(id) {
  return `<span class="prov" data-tip="${PROVIDERS[id]?.name ?? id}">${PROV_SVG[id] ?? ""}</span>`;
}
function originMark(p, w) {
  if (!w.origin) return "";
  if (w.origin.kind === "pr") {
    const pr = p.prs[w.origin.ref];
    const icon = pr?.state === "merged" ? "merge" : pr?.state === "closed" ? "prClosed" : "pr";
    return `<span class="origin o-pr o-${pr?.state ?? "open"}" data-tip="${esc(pr?.title ?? "")}">${ic(icon)}#${w.origin.ref}</span>`;
  }
  if (w.origin.kind === "issue")
    return `<span class="origin o-issue">${ic("issue")}#${w.origin.ref}</span>`;
  return `<span class="origin o-jira">${ic("jira")}${esc(w.origin.ref)}</span>`;
}
function factsHtml(w) {
  return workspaceFacts(w)
    .map((f) => `<span class="fact f-${f.tone}">${esc(f.label)}</span>`)
    .join("");
}
