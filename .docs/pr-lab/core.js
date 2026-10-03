/* ============================================================
   PR lab · core helpers → window.PR_LAB
   Loaded after data.js and before the dir-*.js files. Everything a
   direction needs that is not a design decision lives here:
   templating, icons + glyphs, time, markdown, syntax, diff parse +
   render (unified/split + inline annotations), motion helpers,
   floating layers, a tiny bus/store, and the PR model (groups,
   readiness, stacks, merge plans). See README.md for the API list.
   ============================================================ */
(function () {
  "use strict";
  const LAB = (window.PR_LAB = window.PR_LAB || {});
  const DATA = () => window.PR_LAB_DATA;

  /* ============================================================
     Templating
     ============================================================ */
  /** Marks a string as trusted HTML so html`` does not escape it. */
  class Raw {
    constructor(s) {
      this.__html = String(s ?? "");
    }
    toString() {
      return this.__html;
    }
  }
  const raw = (s) => (s instanceof Raw ? s : new Raw(s));
  const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ESC[c]);
  function interp(v) {
    if (v == null || v === false || v === true) return "";
    if (v instanceof Raw) return v.__html;
    if (Array.isArray(v)) return v.map(interp).join("");
    return esc(v);
  }
  /** Tagged template: interpolations are escaped unless Raw; arrays are joined; null/false vanish. */
  function html(strings, ...vals) {
    let out = strings[0];
    for (let i = 0; i < vals.length; i++) out += interp(vals[i]) + strings[i + 1];
    return new Raw(out);
  }
  /**
   * h(tag, props?, ...children) → Element
   * props: class (string|array), style (string|object, supports --vars), dataset,
   *        html (innerHTML), on<Event> handlers, any attribute (true → "").
   * A string as 2nd arg is the className. Children: Node | string (text) | Raw (HTML) | arrays.
   */
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    if (typeof props === "string") props = { class: props };
    else if (props instanceof Node || props instanceof Raw || Array.isArray(props)) {
      kids.unshift(props);
      props = null;
    }
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === "class" || k === "className")
        el.className = Array.isArray(v) ? v.filter(Boolean).join(" ") : v;
      else if (k === "style") {
        if (typeof v === "string") el.style.cssText = v;
        else
          for (const [p, val] of Object.entries(v))
            el.style.setProperty(
              p.startsWith("--") ? p : p.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase()),
              val,
            );
      } else if (k === "dataset") Object.assign(el.dataset, v);
      else if (k === "html") el.innerHTML = String(v);
      else if (k.startsWith("on") && typeof v === "function")
        el.addEventListener(k.slice(2).toLowerCase(), v);
      else el.setAttribute(k, v === true ? "" : v);
    }
    append(el, kids);
    return el;
  }
  function append(el, kids) {
    for (const k of [kids].flat(Infinity)) {
      if (k == null || k === false || k === true) continue;
      if (k instanceof Node) el.append(k);
      else if (k instanceof Raw) el.insertAdjacentHTML("beforeend", k.__html);
      else el.append(String(k));
    }
    return el;
  }
  /** HTML string/Raw → DocumentFragment */
  function frag(markup) {
    const t = document.createElement("template");
    t.innerHTML = String(markup);
    return t.content;
  }
  /** HTML string/Raw → its first element */
  const el = (markup) => frag(markup).firstElementChild;
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  /** Delegated listener: on(root, "click", "[data-act]", (e, match) => …) → off() */
  function on(root, type, selector, fn, opts) {
    const handler = (e) => {
      const match = e.target.closest?.(selector);
      if (match && root.contains(match)) fn(e, match);
    };
    root.addEventListener(type, handler, opts);
    return () => root.removeEventListener(type, handler, opts);
  }
  let uidSeq = 0;
  const uid = (prefix = "u") => `${prefix}${++uidSeq}`;
  const plural = (n, word, many) => `${n} ${n === 1 ? word : many || word + "s"}`;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  /* ============================================================
     Icons (lucide geometry, 24×24, stroke = currentColor)
     ============================================================ */
  const ICONS = {
    "pr-open":
      '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><line x1="6" x2="6" y1="9" y2="21"/>',
    "pr-draft":
      '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M18 6V5"/><path d="M18 11v-1"/><line x1="6" x2="6" y1="9" y2="21"/>',
    "pr-merged":
      '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 0 0 9 9"/>',
    "pr-closed":
      '<circle cx="6" cy="6" r="3"/><path d="M6 9v12"/><path d="m21 3-6 6"/><path d="m21 9-6-6"/><path d="M18 11.5V15"/><circle cx="18" cy="18" r="3"/>',
    "check-pass": '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
    "check-fail": '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>',
    "check-running": '<path d="M21 12a9 9 0 1 1-6.219-8.56"/>',
    "check-skip": '<circle cx="12" cy="12" r="10"/><path d="m8.5 15.5 7-7"/>',
    comment: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    "review-approve": '<path d="M20 6 9 17l-5-5"/>',
    "review-changes":
      '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M9 10h6"/><path d="M12 7v6"/><path d="M9 17h6"/>',
    stack:
      '<path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/>',
    branch:
      '<line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
    commit: '<path d="M12 3v6"/><circle cx="12" cy="12" r="3"/><path d="M12 15v6"/>',
    "commit-h":
      '<circle cx="12" cy="12" r="3"/><line x1="3" x2="9" y1="12" y2="12"/><line x1="15" x2="21" y1="12" y2="12"/>',
    file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
    "file-diff":
      '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M9 10h6"/><path d="M12 7v6"/><path d="M9 17h6"/>',
    folder:
      '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
    "folder-open":
      '<path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/>',
    chevron: '<path d="m9 18 6-6-6-6"/>',
    "chevron-down": '<path d="m6 9 6 6 6-6"/>',
    "chevron-up": '<path d="m18 15-6-6-6 6"/>',
    "chevron-left": '<path d="m15 18-6-6 6-6"/>',
    "chevrons-up-down": '<path d="m7 15 5 5 5-5"/><path d="m7 9 5-5 5 5"/>',
    fold: '<path d="m7 20 5-5 5 5"/><path d="m7 4 5 5 5-5"/>',
    more: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    filter: '<path d="M3 6h18"/><path d="M7 12h10"/><path d="M10 18h4"/>',
    external:
      '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
    sparkle:
      '<path d="M9.94 15.5A2 2 0 0 0 8.5 14.06l-6.13-1.58a.5.5 0 0 1 0-.96L8.5 9.94A2 2 0 0 0 9.94 8.5l1.58-6.14a.5.5 0 0 1 .96 0L14.06 8.5a2 2 0 0 0 1.44 1.44l6.14 1.58a.5.5 0 0 1 0 .96L15.5 14.06a2 2 0 0 0-1.44 1.44l-1.58 6.14a.5.5 0 0 1-.96 0z"/>',
    eye: '<path d="M2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-19.88 0"/><circle cx="12" cy="12" r="3"/>',
    "eye-off":
      '<path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.53 13.53 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" x2="22" y1="2" y2="22"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/>',
    resolve: '<path d="M18 6 7 17l-5-5"/><path d="m22 10-7.5 7.5L13 16"/>',
    reply: '<polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/>',
    clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
    minus: '<path d="M5 12h14"/>',
    copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
    rerun:
      '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
    "update-branch":
      '<path d="M12 3v12"/><path d="m8 11 4 4 4-4"/><path d="M8 5H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-4"/>',
    tag: '<path d="M12.59 2.59A2 2 0 0 0 11.17 2H4a2 2 0 0 0-2 2v7.17a2 2 0 0 0 .59 1.42l8.7 8.7a2.43 2.43 0 0 0 3.42 0l6.58-6.58a2.43 2.43 0 0 0 0-3.42z"/><circle cx="7.5" cy="7.5" r=".5" fill="currentColor"/>',
    user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    users:
      '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    bot: '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>',
    lock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    alert:
      '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
    "arrow-up": '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
    "arrow-down": '<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>',
    "arrow-right": '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
    "arrow-left": '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
    "corner-down-right":
      '<polyline points="15 10 20 15 15 20"/><path d="M4 4v7a4 4 0 0 0 4 4h12"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
    edit: '<path d="M21.17 6.81a1 1 0 0 0-3.99-3.99L3.84 16.17a2 2 0 0 0-.5.83l-1.32 4.35a.5.5 0 0 0 .62.62l4.35-1.32a2 2 0 0 0 .83-.5z"/>',
    trash:
      '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
    smile:
      '<circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" x2="9.01" y1="9" y2="9"/><line x1="15" x2="15.01" y1="9" y2="9"/>',
    terminal: '<polyline points="4 17 10 11 4 5"/><line x1="12" x2="20" y1="19" y2="19"/>',
    split: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M12 3v18"/>',
    unified: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 12h18"/>',
    sidebar: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/>',
    inbox:
      '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
    pen: '<path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.38 2.63a1 1 0 0 1 3 3l-9.02 9.01a2 2 0 0 1-.85.51l-2.87.84a.5.5 0 0 1-.62-.62l.84-2.87a2 2 0 0 1 .51-.85z"/>',
    stats:
      '<line x1="12" x2="12" y1="20" y2="10"/><line x1="18" x2="18" y1="20" y2="4"/><line x1="6" x2="6" y1="20" y2="16"/>',
    settings:
      '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
    moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
    motion:
      '<path d="M2 12h4"/><path d="M5 7h5"/><path d="M5 17h5"/><circle cx="16" cy="12" r="6"/>',
    pin: '<path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>',
    dot: '<circle cx="12" cy="12" r="3" fill="currentColor" stroke="none"/>',
    "issue-open":
      '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="1" fill="currentColor"/>',
    rocket:
      '<path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/>',
    undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11"/>',
    keyboard:
      '<path d="M10 8h.01"/><path d="M12 12h.01"/><path d="M14 8h.01"/><path d="M16 12h.01"/><path d="M18 8h.01"/><path d="M6 8h.01"/><path d="M7 16h10"/><path d="M8 12h.01"/><rect width="20" height="16" x="2" y="4" rx="2"/>',
  };
  const ICON_ALIAS = {
    agent: "sparkle",
    viewed: "eye",
    pr: "pr-open",
    merge: "pr-merged",
    "chevron-right": "chevron",
    "check-running": "check-running",
    conflict: "alert",
    label: "tag",
    reviewers: "users",
    refresh: "rerun",
  };
  const warned = new Set();
  /** icon(name, { size, cls, sw }) → Raw <svg class="ic ic-name"> */
  function icon(name, opts = {}) {
    const key = ICON_ALIAS[name] || name;
    const body = ICONS[key];
    if (body == null && !warned.has(name)) {
      warned.add(name);
      console.warn("[pr-lab] unknown icon", name);
    }
    const size = opts.size ? ` style="width:${opts.size}px;height:${opts.size}px"` : "";
    return raw(
      `<svg class="ic ic-${key} ${opts.cls || ""}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${opts.sw || 2}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"${size}>${body || ""}</svg>`,
    );
  }

  /* Ryco "R" mark (project favicon) */
  const R_PATH =
    "M6035,9744C5514,9700 5112,9433 4886,8982C4838,8886 4786,8729 4764,8610L4746,8515L4742,7231L4739,5947L4758,5928L4796,5962C4818,5981 4975,6121 5147,6273L5459,6550L5462,7502L5465,8455L5491,8532C5576,8779 5754,8952 6002,9028L6055,9044L6605,9048C6908,9050 7178,9049 7206,9045L7258,9039L7364,8975L7392,8930C7407,8905 7424,8863 7429,8835L7438,8786L7429,8725C7424,8692 7406,8636 7389,8601L7358,8538L7295,8474L7233,8411L7161,8376L7088,8341L7032,8335C6708,8298 6509,8207 6296,7996C6187,7889 6155,7846 5901,7472L5708,7188L5714,7167C5717,7155 5741,7123 5768,7095C5794,7068 5840,7016 5870,6980C5919,6922 6037,6786 6370,6405C6428,6340 6528,6225 6594,6150C6659,6076 6732,5994 6757,5968L6801,5920L7710,5920L7710,5933C7710,5939 7666,5997 7612,6061C7503,6191 7498,6197 7009,6774C6599,7259 6590,7270 6590,7283C6590,7305 6683,7421 6753,7486L6827,7555L6975,7629L7040,7640C7076,7646 7148,7659 7200,7670C7628,7751 8003,8123 8102,8563L8123,8655L8122,8795L8122,8935L8097,9030C8048,9217 7971,9350 7832,9482C7695,9612 7569,9680 7385,9723L7295,9743L6685,9745C6350,9746 6057,9746 6035,9744Z";
  const R_LOGO = `<svg viewBox="227 227 800 800" aria-hidden="true"><g transform="matrix(0.125617,0,0,-0.125617,-180.839814,1610.932617)"><path fill="currentColor" d="${R_PATH}"/></g></svg>`;
  const fav = (size = 14) => raw(`<span class="fav" style="--s:${size}px">${R_LOGO}</span>`);

  /* ============================================================
     Glyphs: PR state, checks, review state, labels, stats, avatars
     ============================================================ */
  const PR_STATE = {
    open: { icon: "pr-open", label: "Open" },
    draft: { icon: "pr-draft", label: "Draft" },
    merged: { icon: "pr-merged", label: "Merged" },
    closed: { icon: "pr-closed", label: "Closed" },
  };
  /** "open" | "draft" | "merged" | "closed" from a PR summary (or a state string). */
  const prState = (pr) =>
    typeof pr === "string" ? pr : pr.state === "open" && pr.isDraft ? "draft" : pr.state;
  /** stateGlyph(pr | state, { size=16, tip=true }) */
  function stateGlyph(pr, opts = {}) {
    const st = prState(pr);
    const m = PR_STATE[st] || PR_STATE.open;
    const tip = opts.tip === false ? "" : ` data-tip="${esc(opts.tip || m.label)}"`;
    return raw(
      `<span class="sg sg-${st}" style="--s:${opts.size || 16}px"${tip}>${icon(m.icon)}</span>`,
    );
  }
  const CHECK_NORM = {
    pass: "pass",
    passing: "pass",
    success: "pass",
    neutral: "pass",
    fail: "fail",
    failing: "fail",
    failure: "fail",
    error: "fail",
    timed_out: "fail",
    action_required: "fail",
    startup_failure: "fail",
    running: "run",
    in_progress: "run",
    run: "run",
    queued: "queued",
    pending: "queued",
    waiting: "queued",
    requested: "queued",
    skip: "skip",
    skipped: "skip",
    cancelled: "skip",
    stale: "skip",
    none: "none",
  };
  const CHECK_LABEL = {
    pass: "Passed",
    fail: "Failed",
    run: "Running",
    queued: "Queued",
    skip: "Skipped",
    none: "No checks",
  };
  /** Normalizes check/job/step status words → pass | fail | run | queued | skip | none */
  const checkKind = (status) => CHECK_NORM[String(status || "none").toLowerCase()] || "none";
  /** Status of a job/step object ({status, conclusion}) → pass|fail|run|queued|skip */
  const runKind = (o) =>
    !o
      ? "none"
      : o.status && o.status !== "completed"
        ? checkKind(o.status)
        : checkKind(o.conclusion || o.state);
  /**
   * checkGlyph(status | {status, conclusion}, { size=14, tip, animate=false })
   * pass: green disc + check (drawn when animate) · fail: red disc + × ·
   * run: amber spinner · queued: dashed ring · skip: slashed ring · none: dot
   */
  function checkGlyph(status, opts = {}) {
    const k = typeof status === "object" ? runKind(status) : checkKind(status);
    const size = opts.size || 14;
    const tip = opts.tip === false ? "" : ` data-tip="${esc(opts.tip || CHECK_LABEL[k])}"`;
    let svg = "";
    if (k === "pass")
      svg = `<svg viewBox="0 0 14 14"><circle cx="7" cy="7" r="6.2" fill="var(--ok-fill)"/><path class="draw" pathLength="1" d="M4.3 7.3l1.8 1.8 3.7-3.9" fill="none" stroke="var(--check-ink)" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    else if (k === "fail")
      svg = `<svg viewBox="0 0 14 14"><circle cx="7" cy="7" r="6.2" fill="var(--err-fill)"/><path d="M5 5l4 4M9 5l-4 4" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/></svg>`;
    else if (k === "skip")
      svg = `<svg viewBox="0 0 14 14"><circle cx="7" cy="7" r="5.5" fill="none" stroke="var(--faint-fg)" stroke-width="1.4"/><path d="M4.8 9.2l4.4-4.4" stroke="var(--faint-fg)" stroke-width="1.4" stroke-linecap="round"/></svg>`;
    return raw(
      `<span class="cg cg-${k} ${opts.animate ? "" : "static"}" style="--s:${size}px"${tip}>${svg}</span>`,
    );
  }
  const REVIEW = {
    approved: { icon: "review-approve", label: "Approved" },
    changes_requested: { icon: "review-changes", label: "Requested changes" },
    commented: { icon: "comment", label: "Commented" },
    pending: { icon: "dot", label: "Review pending" },
    dismissed: { icon: "x", label: "Dismissed" },
  };
  /** reviewGlyph("approved" | "changes_requested" | "commented" | "pending" | "dismissed", { size, tip }) */
  function reviewGlyph(state, opts = {}) {
    const m = REVIEW[state] || REVIEW.pending;
    const tip = opts.tip === false ? "" : ` data-tip="${esc(opts.tip || m.label)}"`;
    return raw(
      `<span class="rg rg-${state}" style="--s:${opts.size || 14}px"${tip}>${icon(m.icon)}</span>`,
    );
  }
  /** labelChip(name | {name, color, description}) → dot + name */
  function labelChip(l) {
    const lab = typeof l === "string" ? DATA()?.labels?.[l] || { name: l } : l;
    const color = lab.color ? `#${String(lab.color).replace(/^#/, "")}` : "";
    return raw(
      `<span class="lbl" ${color ? `style="--lc:${color}"` : ""} ${lab.description ? `data-tip="${esc(lab.description)}"` : ""}>${esc(lab.name)}</span>`,
    );
  }
  /** diffStat(add, del) → "+12 −3" */
  const diffStat = (add, del) =>
    raw(
      `<span class="ds"><span class="a">+${add ?? 0}</span><span class="d">\u2212${del ?? 0}</span></span>`,
    );
  /** diffBar(add, del, blocks=5) → GitHub-style ■■■■□ */
  function diffBar(add, del, blocks = 5) {
    const total = (add || 0) + (del || 0);
    let a = total ? Math.round((add / total) * blocks) : 0;
    let d = total ? Math.round((del / total) * blocks) : 0;
    if (a + d > blocks) d = blocks - a;
    const cells = [];
    for (let i = 0; i < blocks; i++)
      cells.push(i < a ? '<i class="a"></i>' : i < a + d ? '<i class="d"></i>' : "<i></i>");
    return raw(`<span class="dsbar">${cells.join("")}</span>`);
  }

  /** Stable hue 0–359 from a login. */
  function avatarHue(login) {
    let h = 2166136261;
    for (const c of String(login)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
    return Math.abs(h) % 360;
  }
  /** avatarColor(login) → { hue, bg, fg } (CSS colours; theme-aware via vars) */
  const avatarColor = (login) => {
    const hue = avatarHue(login);
    return { hue, bg: `oklch(var(--av-l) var(--av-c) ${hue})`, fg: `oklch(0.97 0.01 ${hue})` };
  };
  function initials(u) {
    const name = u?.name || u?.login || "?";
    const parts = name.split(/[\s-]+/).filter(Boolean);
    return (
      parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : name.slice(0, 2)
    ).toUpperCase();
  }
  /** avatar(login, { size=20, tip=true }) — bots get a square bot glyph, teams a square users glyph */
  function avatar(login, opts = {}) {
    const size = opts.size || 20;
    const u = model.user(login);
    const tip =
      opts.tip === false
        ? ""
        : ` data-tip="${esc(u.team ? "@" + u.login : u.name ? `${u.name} · @${u.login}` : "@" + u.login)}"`;
    if (u.bot) return raw(`<span class="av bot" style="--s:${size}px"${tip}>${icon("bot")}</span>`);
    if (u.team)
      return raw(
        `<span class="av team" style="--s:${size}px;--h:${avatarHue(login)}"${tip}>${icon("users", { size: Math.round(size * 0.55) })}</span>`,
      );
    return raw(
      `<span class="av" style="--s:${size}px;--h:${avatarHue(login)}"${tip}>${esc(initials(u))}</span>`,
    );
  }
  /** avatarStack(logins, { size=20, max=3 }) */
  function avatarStack(logins, opts = {}) {
    const max = opts.max || 3;
    const list = [...new Set(logins)];
    const shown = list.slice(0, max).map((l) => avatar(l, { size: opts.size }));
    const more = list.length > max ? `<span class="av-more">+${list.length - max}</span>` : "";
    return raw(
      `<span class="av-stack" style="--s:${opts.size || 20}px">${shown.join("")}${more}</span>`,
    );
  }

  /* ============================================================
     Time (relative to PR_LAB_DATA.now so screenshots are stable)
     ============================================================ */
  const now = () => Date.parse(DATA()?.now || new Date().toISOString());
  const toMs = (t) => (typeof t === "number" ? t : Date.parse(t));
  const MONTHS = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  /** ago(iso) → "now" | "4m" | "3h" | "2d" | "Sep 12" */
  function ago(t) {
    const sec = Math.max(0, Math.round((now() - toMs(t)) / 1000));
    if (sec < 45) return "now";
    const m = Math.round(sec / 60);
    if (m < 60) return m + "m";
    const hr = Math.round(m / 60);
    if (hr < 24) return hr + "h";
    const d = Math.round(hr / 24);
    if (d < 30) return d + "d";
    const dt = new Date(toMs(t));
    return `${MONTHS[dt.getMonth()]} ${dt.getDate()}`;
  }
  /** agoLong(iso) → "just now" | "4 minutes ago" | "yesterday" | "3 days ago" | "on Sep 12" */
  function agoLong(t) {
    const sec = Math.max(0, Math.round((now() - toMs(t)) / 1000));
    if (sec < 45) return "just now";
    const m = Math.round(sec / 60);
    if (m < 60) return plural(m, "minute") + " ago";
    const hr = Math.round(m / 60);
    if (hr < 24) return plural(hr, "hour") + " ago";
    const d = Math.round(hr / 24);
    if (d === 1) return "yesterday";
    if (d < 30) return d + " days ago";
    const dt = new Date(toMs(t));
    return `on ${MONTHS[dt.getMonth()]} ${dt.getDate()}`;
  }
  /** fmtDate(iso, { time=true }) → "Oct 2, 14:32" (local time) */
  function fmtDate(t, opts = {}) {
    const dt = new Date(toMs(t));
    const day = `${MONTHS[dt.getMonth()]} ${dt.getDate()}`;
    if (opts.time === false) return day;
    return `${day}, ${String(dt.getHours()).padStart(2, "0")}:${String(dt.getMinutes()).padStart(2, "0")}`;
  }
  /** dur(seconds) → "48s" | "2m 11s" | "1h 4m" */
  function dur(sec) {
    if (sec == null) return "";
    sec = Math.round(sec);
    if (sec < 60) return sec + "s";
    const m = Math.floor(sec / 60);
    if (m < 60) return `${m}m ${sec % 60}s`;
    return `${Math.floor(m / 60)}h ${m % 60}m`;
  }

  /* ============================================================
     Syntax highlighting (line-oriented, muted palette)
     ============================================================ */
  const KW = new Set(
    "import from export default const let var function return if else for while do of in new class extends implements interface type enum as async await yield try catch finally throw switch case break continue readonly public private protected static typeof keyof satisfies void null undefined true false this declare namespace abstract super get set".split(
      " ",
    ),
  );
  const LANGS = {
    ts: [
      ["c", /\/\/.*$|\/\*.*?(?:\*\/|$)/],
      ["s", /`(?:\\.|[^`\\])*`?|"(?:\\.|[^"\\])*"?|'(?:\\.|[^'\\])*'?/],
      ["n", /\b(?:0x[\da-fA-F_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?n?)\b/],
      ["t", /<\/?[A-Za-z][\w.]*/],
      ["id", /[A-Za-z_$][\w$]*/],
      ["p", /=>|[{}()[\];,.:?!=<>+\-*/%&|^~]+/],
    ],
    json: [
      ["a", /"(?:\\.|[^"\\])*"(?=\s*:)/],
      ["s", /"(?:\\.|[^"\\])*"?/],
      ["n", /-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/],
      ["k", /\b(?:true|false|null)\b/],
      ["p", /[{}[\],:]/],
    ],
    yaml: [
      ["c", /#.*$/],
      ["k", /\$\{\{.*?\}\}/],
      ["a", /^\s*-?\s*[\w./-]+(?=\s*:)/],
      ["s", /"(?:\\.|[^"\\])*"?|'(?:[^'])*'?/],
      ["n", /\b\d+(?:\.\d+)?\b/],
      ["p", /[|>:-]/],
    ],
    css: [
      ["c", /\/\*.*?(?:\*\/|$)/],
      ["k", /@[\w-]+/],
      ["a", /[\w-]+(?=\s*:(?!:))/],
      ["s", /"(?:\\.|[^"\\])*"?|'(?:\\.|[^'\\])*'?/],
      ["y", /--[\w-]+/],
      ["n", /-?\b\d+(?:\.\d+)?(?:px|ms|s|%|rem|em|fr|deg|vh|vw)?\b/],
      ["f", /[\w-]+(?=\()/],
      ["p", /[{}();:,]/],
    ],
    sh: [
      ["c", /(?:^|\s)#.*$/],
      ["s", /"(?:\\.|[^"\\])*"?|'(?:[^'])*'?/],
      ["y", /\$\{?[\w]+\}?/],
      ["f", /^\s*[\w./-]+/],
      ["a", /\s--?[\w-]+/],
    ],
    md: [
      ["k", /^#{1,6}\s.*$/],
      ["s", /`[^`]*`/],
      ["a", /\*\*[^*]+\*\*/],
      ["p", /^\s*(?:[-*+]|\d+\.)\s/],
    ],
  };
  for (const spec of Object.values(LANGS))
    spec.re = new RegExp(spec.map(([, r]) => "(" + r.source + ")").join("|"), "g");
  const EXT_LANG = {
    ts: "ts",
    tsx: "ts",
    js: "ts",
    jsx: "ts",
    mjs: "ts",
    cjs: "ts",
    mts: "ts",
    json: "json",
    lock: "json",
    jsonc: "json",
    yml: "yaml",
    yaml: "yaml",
    css: "css",
    scss: "css",
    sh: "sh",
    bash: "sh",
    zsh: "sh",
    md: "md",
    mdx: "md",
  };
  /** langOf("apps/web/src/x.tsx") → "ts" | "json" | "yaml" | "css" | "sh" | "md" | "text" */
  function langOf(path) {
    if (!path) return "text";
    const base = String(path).split("/").pop();
    if (base === "bun.lock") return "json";
    const ext = base.includes(".") ? base.split(".").pop().toLowerCase() : "";
    return EXT_LANG[ext] || (LANGS[ext] ? ext : "text");
  }
  function classifyId(word, line, end) {
    if (KW.has(word)) return "k";
    const rest = line.slice(end);
    if (/^\s*(?:<[^<>()]*>)?\s*\(/.test(rest)) return "f";
    if (/^[A-Z]/.test(word)) return "y";
    return null;
  }
  /** tokenize(line, lang) → [{ t: text, c: "k"|"s"|"n"|"c"|"y"|"f"|"t"|"a"|"p"|null }] */
  function tokenize(line, lang) {
    const spec = LANGS[lang === "tsx" || lang === "js" ? "ts" : lang];
    if (!spec || !line) return [{ t: line || "", c: null }];
    const re = spec.re;
    re.lastIndex = 0;
    const out = [];
    let last = 0;
    let m;
    while ((m = re.exec(line))) {
      if (m[0] === "") {
        re.lastIndex++;
        continue;
      }
      if (m.index > last) out.push({ t: line.slice(last, m.index), c: null });
      let gi = 1;
      while (m[gi] === undefined) gi++;
      let c = spec[gi - 1][0];
      if (c === "id") c = classifyId(m[0], line, re.lastIndex);
      out.push({ t: m[0], c });
      last = re.lastIndex;
    }
    if (last < line.length) out.push({ t: line.slice(last), c: null });
    return out;
  }
  /** Tokens → HTML, optionally wrapping [start, end) in <mark class="dw"> (word diff). */
  function renderTokens(tokens, range) {
    const hasRange = range && range[1] > range[0];
    let out = "";
    let pos = 0;
    let open = false;
    const wrap = (t, c) => (c ? `<span class="tk-${c}">${esc(t)}</span>` : esc(t));
    for (const { t, c } of tokens) {
      const s = pos;
      const e = pos + t.length;
      pos = e;
      if (!hasRange || e <= range[0] || s >= range[1]) {
        if (open) {
          out += "</mark>";
          open = false;
        }
        out += wrap(t, c);
        continue;
      }
      const a = Math.max(range[0], s) - s;
      const b = Math.min(range[1], e) - s;
      if (a > 0) out += wrap(t.slice(0, a), c);
      if (!open) {
        out += '<mark class="dw">';
        open = true;
      }
      out += wrap(t.slice(a, b), c);
      if (b < t.length) {
        out += "</mark>";
        open = false;
        out += wrap(t.slice(b), c);
      }
    }
    if (open) out += "</mark>";
    return out;
  }
  /** highlight(code, lang) → Raw HTML (multi-line) */
  const highlight = (code, lang) =>
    raw(
      String(code ?? "")
        .split("\n")
        .map((l) =>
          renderTokens(tokenize(l, langOf("x." + lang) === "text" ? lang : langOf("x." + lang))),
        )
        .join("\n"),
    );

  /* ============================================================
     Markdown (GitHub-flavoured subset)
     headings, paragraphs, ul/ol (nested), task lists, blockquote,
     fenced code (+ ```suggestion), tables, <details>, hr, inline
     code, bold/italic/strike, links, autolinks, @mentions, #refs, shas
     ============================================================ */
  const EMOJI = {
    tada: "🎉",
    rocket: "🚀",
    eyes: "👀",
    "+1": "👍",
    "-1": "👎",
    heart: "❤️",
    warning: "⚠️",
    white_check_mark: "✅",
    x: "❌",
  };
  const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
  const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
  const FENCE_RE = /^\s*(`{3,}|~{3,})\s*([\w+-]*)\s*$/;
  function inline(src) {
    const codes = [];
    let s = String(src).replace(/`([^`]+)`/g, (_, c) => {
      codes.push(c);
      return `\u0000${codes.length - 1}\u0000`;
    });
    s = esc(s);
    s = s
      .replace(/&lt;(\/?)(sub|sup|kbd|b|i|em|strong|code)&gt;/g, "<$1$2>")
      .replace(/&lt;br\s*\/?&gt;/g, "<br>");
    s = s.replace(
      /!\[([^\]]*)\]\(([^)\s]+)\)/g,
      (_, alt, url) => `<a href="${url}" target="_blank" rel="noreferrer">${alt || "image"}</a>`,
    );
    s = s.replace(
      /\[([^\]]+)\]\(([^)\s]+)\)/g,
      (_, t, url) => `<a href="${url}" target="_blank" rel="noreferrer">${t}</a>`,
    );
    s = s.replace(
      /(^|[\s(])(https?:\/\/[^\s<)]+)/g,
      (_, p, url) =>
        `${p}<a href="${url}" target="_blank" rel="noreferrer">${url.replace(/^https?:\/\//, "")}</a>`,
    );
    s = s
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^\w*])\*([^*\s][^*]*?)\*(?![\w*])/g, "$1<em>$2</em>")
      .replace(/(^|[^\w])_([^_\s][^_]*?)_(?!\w)/g, "$1<em>$2</em>")
      .replace(/~~([^~]+)~~/g, "<del>$1</del>");
    s = s.replace(
      /(^|[^\w/`="])@([a-zA-Z0-9-]+(?:\/[a-zA-Z0-9-]+)?)/g,
      '$1<span class="md-mention">@$2</span>',
    );
    s = s.replace(/(^|[^\w&/#"])#(\d{1,6})\b/g, '$1<a class="md-ref" data-pr="$2">#$2</a>');
    s = s.replace(/(^|[\s(])([0-9a-f]{7,12})(?=[\s).,:;]|$)/g, (m0, p, hx) =>
      /\d/.test(hx) && /[a-f]/.test(hx) ? `${p}<code class="md-sha">${hx}</code>` : m0,
    );
    s = s.replace(/:([a-z0-9_+-]+):/g, (m0, n) => EMOJI[n] || m0);
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[+i])}</code>`);
  }
  const isBlockStart = (lines, i) => {
    const l = lines[i];
    return (
      FENCE_RE.test(l) ||
      /^#{1,6}\s/.test(l) ||
      /^\s*>/.test(l) ||
      LIST_RE.test(l) ||
      /^\s*<details\b/i.test(l) ||
      /^\s*([-*_])(\s*\1){2,}\s*$/.test(l) ||
      (l.includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]))
    );
  };
  function suggestionBlock(body, opts) {
    const rows = [];
    let o = opts.suggestionLine || 1;
    let n = o;
    if (opts.suggestionBase != null)
      for (const t of String(opts.suggestionBase).split("\n"))
        rows.push({ kind: "del", text: t, old: o++, new: null });
    for (const t of body) rows.push({ kind: "add", text: t, old: null, new: n++ });
    return `<div class="md-suggestion"><div class="md-suggestion-head">${icon("file-diff")}<span>Suggested change</span></div>${renderDiff(rows, { lang: opts.lang || "ts" })}</div>`;
  }
  function renderList(lines, i, ctx) {
    const first = lines[i].match(LIST_RE);
    const base = first[1].length;
    const ordered = /\d/.test(first[2]);
    const items = [];
    while (i < lines.length) {
      const line = lines[i];
      const m = line.match(LIST_RE);
      if (m && m[1].length === base) {
        items.push({ text: m[3], kids: [] });
        i++;
        continue;
      }
      if (!line.trim()) {
        // A blank line continues the list only if the next content is another
        // item at this level or an indented continuation of the current item.
        let j = i + 1;
        while (j < lines.length && !lines[j].trim()) j++;
        const nx = lines[j];
        if (nx == null) break;
        const nm = nx.match(LIST_RE);
        const lead = nx.match(/^\s*/)[0].length;
        if (nm && nm[1].length === base) {
          i = j;
          continue;
        }
        if (lead > base && items.length) {
          items[items.length - 1].kids.push("");
          i = j;
          continue;
        }
        break;
      }
      const lead = line.match(/^\s*/)[0].length;
      if (lead > base && items.length) {
        items[items.length - 1].kids.push(line.slice(Math.min(lead, base + 2)));
        i++;
        continue;
      }
      if (!m && items.length && !isBlockStart(lines, i)) {
        items[items.length - 1].text += " " + line.trim();
        i++;
        continue;
      }
      break;
    }
    const tag = ordered ? "ol" : "ul";
    const lis = items.map((it) => {
      const task = it.text.match(/^\[( |x|X)\]\s+(.*)$/);
      const kids = it.kids.length ? blocks(it.kids, ctx) : "";
      if (!task) return `<li>${inline(it.text)}${kids}</li>`;
      const done = task[1] !== " ";
      const idx = ctx.task++;
      return `<li class="task ${done ? "done" : ""}"><span class="md-check" role="checkbox" aria-checked="${done}" data-task="${idx}">${icon("check", { sw: 3 })}</span><span class="md-task-text">${inline(task[2])}${kids}</span></li>`;
    });
    return [`<${tag}>${lis.join("")}</${tag}>`, i];
  }
  function renderTable(lines, i) {
    const cells = (row) =>
      row
        .trim()
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((c) => c.trim());
    const head = cells(lines[i]);
    const aligns = cells(lines[i + 1]).map((c) =>
      c.endsWith(":") ? (c.startsWith(":") ? "center" : "right") : null,
    );
    i += 2;
    const body = [];
    while (i < lines.length && lines[i].includes("|") && lines[i].trim())
      body.push(cells(lines[i++]));
    const al = (k) => (aligns[k] ? ` align="${aligns[k]}"` : "");
    return [
      `<table><thead><tr>${head.map((c, k) => `<th${al(k)}>${inline(c)}</th>`).join("")}</tr></thead><tbody>${body
        .map((r) => `<tr>${r.map((c, k) => `<td${al(k)}>${inline(c)}</td>`).join("")}</tr>`)
        .join("")}</tbody></table>`,
      i,
    ];
  }
  function blocks(lines, ctx) {
    let out = "";
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) {
        i++;
        continue;
      }
      let m = line.match(FENCE_RE);
      if (m) {
        const fence = m[1];
        const lang = m[2];
        const body = [];
        i++;
        while (i < lines.length && !lines[i].trim().startsWith(fence)) body.push(lines[i++]);
        i++;
        out +=
          lang === "suggestion"
            ? suggestionBlock(body, ctx.opts)
            : `<pre><code class="lang-${esc(lang || "text")}">${highlight(body.join("\n"), lang || "text")}</code></pre>`;
        continue;
      }
      if (/^\s*<details\b/i.test(line)) {
        const inner = [];
        i++;
        let depth = 1;
        while (i < lines.length) {
          if (/<details\b/i.test(lines[i])) depth++;
          if (/<\/details>/i.test(lines[i]) && --depth === 0) break;
          inner.push(lines[i++]);
        }
        i++;
        let summary = "Details";
        const si = inner.findIndex((l) => /<summary>/i.test(l));
        if (si >= 0) {
          summary = inner[si].replace(/.*<summary>(.*?)<\/summary>.*/i, "$1");
          inner.splice(si, 1);
        }
        out += `<details><summary>${inline(summary)}</summary>${blocks(inner, ctx)}</details>`;
        continue;
      }
      m = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
      if (m) {
        out += `<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`;
        i++;
        continue;
      }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
        out += "<hr>";
        i++;
        continue;
      }
      if (/^\s*>/.test(line)) {
        const q = [];
        while (i < lines.length && /^\s*>/.test(lines[i]))
          q.push(lines[i++].replace(/^\s*> ?/, ""));
        out += `<blockquote>${blocks(q, ctx)}</blockquote>`;
        continue;
      }
      if (line.includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
        const [t, next] = renderTable(lines, i);
        out += t;
        i = next;
        continue;
      }
      if (LIST_RE.test(line)) {
        const [l, next] = renderList(lines, i, ctx);
        out += l;
        i = next;
        continue;
      }
      if (/^\s*<sub>.*<\/sub>\s*$/i.test(line)) {
        out += `<p>${inline(line.trim())}</p>`;
        i++;
        continue;
      }
      const para = [];
      while (i < lines.length && lines[i].trim() && (para.length === 0 || !isBlockStart(lines, i)))
        para.push(lines[i++]);
      out += `<p>${para.map(inline).join(ctx.opts.breaks ? "<br>" : "\n")}</p>`;
    }
    return out;
  }
  /**
   * markdown(src, { breaks=false, suggestionBase, suggestionLine, lang }) → Raw HTML
   * Wrap the result in an element with class "md". Task checkboxes render as
   * <span class="md-check" role="checkbox" aria-checked data-task="i">.
   * ```suggestion blocks render as a mini diff; pass suggestionBase (the
   * anchored line text, e.g. thread.lineText) to show the removed line too.
   */
  function markdown(src, opts = {}) {
    const lines = String(src ?? "")
      .replace(/\r\n?/g, "\n")
      .replace(/<!--[\s\S]*?-->/g, "")
      .split("\n");
    return raw(blocks(lines, { opts, task: 0 }));
  }

  /* ============================================================
     Diff: parse + render
     ============================================================ */
  /**
   * parsePatch(patchText) → rows
   *   { kind:"hunk", text, header, section, oldStart, oldLines, newStart, newLines, hunk }
   *   { kind:"ctx"|"add"|"del", text, old:number|null, new:number|null, hunk }
   *   { kind:"meta", text }   ("\ No newline at end of file")
   * Accepts a GitHub-style per-file patch (starts at @@); file headers are skipped.
   */
  function parsePatch(text) {
    const rows = [];
    let o = 0;
    let n = 0;
    let hunk = -1;
    const lines = String(text ?? "").split("\n");
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    for (const line of lines) {
      if (line.startsWith("@@")) {
        const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/);
        if (!m) continue;
        o = +m[1];
        n = +m[3];
        hunk++;
        rows.push({
          kind: "hunk",
          text: line,
          header: line.match(/^@@[^@]*@@/)[0],
          section: m[5] || "",
          oldStart: o,
          oldLines: m[2] == null ? 1 : +m[2],
          newStart: n,
          newLines: m[4] == null ? 1 : +m[4],
          hunk,
        });
      } else if (hunk < 0) continue;
      else if (line[0] === "\\") rows.push({ kind: "meta", text: line.slice(2), hunk });
      else if (line[0] === "+")
        rows.push({ kind: "add", text: line.slice(1), old: null, new: n++, hunk });
      else if (line[0] === "-")
        rows.push({ kind: "del", text: line.slice(1), old: o++, new: null, hunk });
      else rows.push({ kind: "ctx", text: line.slice(1), old: o++, new: n++, hunk });
    }
    return rows;
  }
  /**
   * parseDiff(text) → [{ path, oldPath, status, binary, rows, additions, deletions }]
   * Handles a multi-file `git diff` (diff --git …) or a bare single-file patch.
   */
  function parseDiff(text) {
    const src = String(text ?? "");
    const count = (rows, k) => rows.filter((r) => r.kind === k).length;
    if (!/^diff --git /m.test(src)) {
      const rows = parsePatch(src);
      return [
        {
          path: null,
          oldPath: null,
          status: "modified",
          binary: false,
          rows,
          additions: count(rows, "add"),
          deletions: count(rows, "del"),
        },
      ];
    }
    const files = [];
    let cur = null;
    for (const line of src.split("\n")) {
      if (line.startsWith("diff --git ")) {
        const m = line.match(/^diff --git a\/(.+) b\/(.+)$/);
        cur = {
          path: m?.[2] ?? null,
          oldPath: m?.[1] ?? null,
          status: "modified",
          binary: false,
          lines: [],
          inHunk: false,
        };
        files.push(cur);
        continue;
      }
      if (!cur) continue;
      if (line.startsWith("@@")) cur.inHunk = true;
      if (!cur.inHunk) {
        if (line.startsWith("new file mode")) cur.status = "added";
        else if (line.startsWith("deleted file mode")) cur.status = "removed";
        else if (line.startsWith("rename from ")) {
          cur.status = "renamed";
          cur.oldPath = line.slice(12);
        } else if (line.startsWith("rename to ")) cur.path = line.slice(10);
        else if (line.startsWith("Binary files")) cur.binary = true;
        continue;
      }
      cur.lines.push(line);
    }
    return files.map(({ lines, inHunk, ...f }) => {
      const rows = parsePatch(lines.join("\n"));
      return { ...f, rows, additions: count(rows, "add"), deletions: count(rows, "del") };
    });
  }
  /** toSplit(rows) → [{ kind:"hunk"|"meta", row } | { kind:"pair", left:row|null, right:row|null }] */
  function toSplit(rows) {
    const out = [];
    let i = 0;
    while (i < rows.length) {
      const r = rows[i];
      if (r.kind === "hunk" || r.kind === "meta") {
        out.push({ kind: r.kind, row: r });
        i++;
        continue;
      }
      if (r.kind === "ctx") {
        out.push({ kind: "pair", left: r, right: r });
        i++;
        continue;
      }
      const dels = [];
      const adds = [];
      while (i < rows.length && rows[i].kind === "del") dels.push(rows[i++]);
      while (i < rows.length && rows[i].kind === "add") adds.push(rows[i++]);
      for (let k = 0; k < Math.max(dels.length, adds.length); k++)
        out.push({ kind: "pair", left: dels[k] || null, right: adds[k] || null });
    }
    return out;
  }
  const isWordCh = (c) => c != null && /[\w$]/.test(c);
  /** Changed span between two similar lines → [[aStart,aEnd],[bStart,bEnd]] or null */
  function wordRange(a, b) {
    const max = Math.min(a.length, b.length);
    let p = 0;
    while (p < max && a[p] === b[p]) p++;
    let s = 0;
    while (s < max - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
    while (p > 0 && isWordCh(a[p - 1]) && (isWordCh(a[p]) || isWordCh(b[p]))) p--;
    while (
      s > 0 &&
      isWordCh(a[a.length - s]) &&
      (isWordCh(a[a.length - s - 1]) || isWordCh(b[b.length - s - 1]))
    )
      s--;
    const ra = [p, a.length - s];
    const rb = [p, b.length - s];
    const changed = Math.max(ra[1] - ra[0], rb[1] - rb[0]);
    const longest = Math.max(a.trim().length, b.trim().length, 1);
    if (changed === 0 || changed > 0.66 * longest) return null;
    return [ra, rb];
  }
  function wordPairs(rows) {
    const map = new Map();
    let i = 0;
    while (i < rows.length) {
      if (rows[i].kind !== "del") {
        i++;
        continue;
      }
      const dels = [];
      const adds = [];
      while (i < rows.length && rows[i].kind === "del") dels.push(rows[i++]);
      while (i < rows.length && rows[i].kind === "add") adds.push(rows[i++]);
      for (let k = 0; k < Math.min(dels.length, adds.length); k++) {
        const r = wordRange(dels[k].text, adds[k].text);
        if (r) {
          map.set(dels[k], r[0]);
          map.set(adds[k], r[1]);
        }
      }
    }
    return map;
  }
  const SIGN = { add: "+", del: "-", ctx: "" };
  /**
   * renderDiff(rows, opts) → Raw <table class="diff">
   * opts:
   *   mode: "unified" (default) | "split"
   *   path: file path (sets data-path + language), lang: override language
   *   highlight=true, wordDiff=true, wrap=false
   *   commentable=false → hover "+" button: <button class="d-cbtn" data-act="diff-comment"
   *                        data-side data-line data-path>
   *   annotate(ref) → html | Raw | null — inserted as a full-width row after the line.
   *        ref = { side:"RIGHT"|"LEFT", line, row, path }. Called with RIGHT for add/ctx
   *        lines and LEFT for del/ctx lines (match threads on side + line).
   *   lineClass(ref) → extra classes for the line ("sel", "has-thread", …)
   *   hunkHeader(row) → html | Raw for hunk rows (e.g. expand controls)
   * Line rows carry data-side / data-line (unified: on <tr>; split: on each half's cells).
   */
  function renderDiff(rows, opts = {}) {
    const mode = opts.mode === "split" ? "split" : "unified";
    const lang = opts.lang || langOf(opts.path);
    const hl = opts.highlight !== false;
    const pairs = opts.wordDiff === false ? new Map() : wordPairs(rows);
    const path = opts.path || "";
    let maxLn = 0;
    for (const r of rows) maxLn = Math.max(maxLn, r.old || 0, r.new || 0);
    const lnW = opts.lnWidth === 0 ? 0 : String(maxLn).length * 7 + 18;
    const code = (r) =>
      renderTokens(hl ? tokenize(r.text, lang) : [{ t: r.text, c: null }], pairs.get(r));
    const refOf = (r, side) => ({ side, line: side === "LEFT" ? r.old : r.new, row: r, path });
    const cls = (ref) => (opts.lineClass ? opts.lineClass(ref) || "" : "");
    const cbtn = (ref) =>
      opts.commentable
        ? `<button class="d-cbtn" type="button" data-act="diff-comment" data-side="${ref.side}" data-line="${ref.line}" data-path="${esc(path)}" aria-label="Comment on line ${ref.line}">${icon("plus", { sw: 3 })}</button>`
        : "";
    const annos = (refs) => {
      if (!opts.annotate) return "";
      return refs
        .map((ref) => (ref ? opts.annotate(ref) : null))
        .filter(Boolean)
        .map(String)
        .join("");
    };
    const hunkCell = (r, span) =>
      `<tr class="d-hunk" data-hunk="${r.hunk}"><td colspan="${span}">${
        opts.hunkHeader
          ? String(opts.hunkHeader(r))
          : `<div class="d-hunk-h">${esc(r.header)}<span class="d-hunk-s">${esc(r.section)}</span></div>`
      }</td></tr>`;
    const metaCell = (r, span) =>
      `<tr class="d-meta"><td colspan="${span}">${esc(r.text)}</td></tr>`;
    let body = "";
    if (mode === "unified") {
      for (const r of rows) {
        if (r.kind === "hunk") {
          body += hunkCell(r, 3);
          continue;
        }
        if (r.kind === "meta") {
          body += metaCell(r, 3);
          continue;
        }
        const main = refOf(r, r.kind === "del" ? "LEFT" : "RIGHT");
        const extra = r.kind === "ctx" ? refOf(r, "LEFT") : null;
        const k = `k-${r.kind}`;
        body += `<tr class="d-row d-${r.kind} ${cls(main)}" data-side="${main.side}" data-line="${main.line}" data-old="${r.old ?? ""}" data-new="${r.new ?? ""}"><td class="d-ln ${k}" data-n="${r.old ?? ""}"></td><td class="d-ln ${k}" data-n="${r.new ?? ""}"></td><td class="d-code ${k}" data-sign="${SIGN[r.kind]}">${cbtn(main)}${code(r)}</td></tr>`;
        const a = annos([main, extra]);
        if (a)
          body += `<tr class="d-anno" data-side="${main.side}" data-line="${main.line}"><td colspan="3"><div class="d-anno-in">${a}</div></td></tr>`;
      }
    } else {
      for (const p of toSplit(rows)) {
        if (p.kind === "hunk") {
          body += hunkCell(p.row, 4);
          continue;
        }
        if (p.kind === "meta") {
          body += metaCell(p.row, 4);
          continue;
        }
        const half = (r, side) => {
          if (!r)
            return `<td class="d-ln k-empty d-empty"></td><td class="d-code k-empty d-empty ${side === "LEFT" ? "d-l-code" : "d-r-code"}"></td>`;
          const ref = refOf(r, side);
          const k = `k-${r.kind}`;
          const c = cls(ref);
          return `<td class="d-ln ${k} ${c}" data-n="${ref.line ?? ""}" data-side="${side}" data-line="${ref.line}"></td><td class="d-code ${k} ${c} ${side === "LEFT" ? "d-l-code" : "d-r-code"}" data-sign="${SIGN[r.kind]}" data-side="${side}" data-line="${ref.line}">${cbtn(ref)}${code(r)}</td>`;
        };
        const kind = p.left && p.right && p.left === p.right ? "ctx" : p.right ? "add" : "del";
        body += `<tr class="d-row d-pair d-${kind}">${half(p.left, "LEFT")}${half(p.right, "RIGHT")}</tr>`;
        if (opts.annotate) {
          const l = p.left ? annos([refOf(p.left, "LEFT")]) : "";
          const r = p.right ? annos([refOf(p.right, "RIGHT")]) : "";
          if (l || r)
            body += `<tr class="d-anno"><td colspan="2">${l ? `<div class="d-anno-in">${l}</div>` : ""}</td><td colspan="2">${r ? `<div class="d-anno-in">${r}</div>` : ""}</td></tr>`;
        }
      }
    }
    const cols =
      mode === "unified"
        ? `<col class="c-ln"><col class="c-ln"><col>`
        : `<col class="c-ln"><col><col class="c-ln"><col>`;
    return raw(
      `<table class="diff ${mode} ${opts.wrap ? "wrap" : ""} ${opts.commentable ? "commentable" : ""}" data-path="${esc(path)}" style="--ln-w:${lnW}px"><colgroup>${cols}</colgroup><tbody>${body}</tbody></table>`,
    );
  }
  /**
   * buildFileTree(files) → nodes [{ kind:"dir", name, path, children } | { kind:"file", name, path, file }]
   * Single-child folders are compacted ("apps/web/src/components/pullRequests").
   * Folders sort before files, both alphabetically.
   */
  function buildFileTree(files) {
    const root = { kind: "dir", name: "", path: "", children: [] };
    for (const f of files) {
      const parts = f.path.split("/");
      let node = root;
      parts.forEach((part, i) => {
        const p = parts.slice(0, i + 1).join("/");
        if (i === parts.length - 1)
          node.children.push({ kind: "file", name: part, path: p, file: f });
        else {
          let next = node.children.find((c) => c.kind === "dir" && c.name === part);
          if (!next) {
            next = { kind: "dir", name: part, path: p, children: [] };
            node.children.push(next);
          }
          node = next;
        }
      });
    }
    const compact = (n) => {
      if (n.kind !== "dir") return n;
      n.children = n.children.map(compact);
      while (n.name && n.children.length === 1 && n.children[0].kind === "dir") {
        const only = n.children[0];
        n.name = `${n.name}/${only.name}`;
        n.path = only.path;
        n.children = only.children;
      }
      n.children.sort((a, b) =>
        a.kind !== b.kind ? (a.kind === "dir" ? -1 : 1) : a.name.localeCompare(b.name),
      );
      return n;
    };
    return compact(root).children;
  }

  /* ============================================================
     Bus + store
     ============================================================ */
  /** createBus() → { on(evt, fn) → off, once, emit(evt, payload) } */
  function createBus() {
    const map = new Map();
    const api = {
      on(evt, fn) {
        if (!map.has(evt)) map.set(evt, new Set());
        map.get(evt).add(fn);
        return () => map.get(evt)?.delete(fn);
      },
      once(evt, fn) {
        const off = api.on(evt, (p) => {
          off();
          fn(p);
        });
        return off;
      },
      emit(evt, payload) {
        for (const fn of [...(map.get(evt) || [])]) {
          try {
            fn(payload);
          } catch (err) {
            console.error(err);
          }
        }
      },
    };
    return api;
  }
  /** createStore(initial) → { get(), set(patch | prev => next), subscribe(fn(next, prev)) → off } */
  function createStore(initial) {
    let state = initial;
    const subs = new Set();
    return {
      get: () => state,
      set(patch) {
        const prev = state;
        state = typeof patch === "function" ? patch(prev) : { ...prev, ...patch };
        if (state !== prev) for (const fn of [...subs]) fn(state, prev);
        return state;
      },
      subscribe(fn) {
        subs.add(fn);
        return () => subs.delete(fn);
      },
    };
  }
  const bus = createBus();

  /* ============================================================
     Motion
     ============================================================ */
  const EASINGS = {
    ease: "cubic-bezier(0.16, 1, 0.3, 1)",
    gentle: "cubic-bezier(0.22, 1, 0.36, 1)",
    snappy: "cubic-bezier(0.3, 1.36, 0.44, 1)",
    linear: "linear",
  };
  const DURS = { chip: 120, pop: 200, sheet: 200, stack: 260, pane: 360 };
  const reducedMotion = () => document.documentElement.classList.contains("reduce-motion");
  /** ms("pane") → 360 (0 under reduced motion); numbers pass through (also zeroed). */
  const ms = (d) => (reducedMotion() ? 0 : typeof d === "number" ? d : (DURS[d] ?? 0));
  const easing = (e) => EASINGS[e] || e || EASINGS.ease;
  /** animate(el, keyframes, { duration:"pane"|ms, easing:"ease"|"gentle"|"snappy"|css, delay, fill }) → Animation | null */
  function animate(node, frames, opts = {}) {
    const duration = ms(opts.duration ?? "pane");
    if (!node || !duration) return null;
    return node.animate(frames, {
      duration,
      easing: easing(opts.easing),
      delay: opts.delay ? ms(opts.delay) : 0,
      fill: opts.fill || "none",
    });
  }
  /**
   * flip(targets, mutate, { duration:"stack", easing:"gentle", enter:true })
   * targets: container element (its children) | array | () => elements.
   * Records positions, runs mutate(), animates every element from its old
   * position; new elements rise in. Returns a Promise resolving when done.
   */
  function flip(targets, mutate, opts = {}) {
    const list = () =>
      typeof targets === "function"
        ? [...targets()]
        : targets instanceof Element
          ? [...targets.children]
          : [...targets];
    const before = new Map(list().map((n) => [n, n.getBoundingClientRect()]));
    mutate();
    if (reducedMotion()) return Promise.resolve();
    const anims = [];
    for (const n of list()) {
      const r0 = before.get(n);
      if (!r0) {
        if (opts.enter !== false)
          anims.push(
            animate(
              n,
              [
                { opacity: 0, transform: "translateY(6px)" },
                { opacity: 1, transform: "none" },
              ],
              { duration: opts.duration || "stack", easing: "ease" },
            ),
          );
        continue;
      }
      const r1 = n.getBoundingClientRect();
      const dx = r0.left - r1.left;
      const dy = r0.top - r1.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      anims.push(
        animate(n, [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], {
          duration: opts.duration || "stack",
          easing: opts.easing || "gentle",
        }),
      );
    }
    return Promise.all(anims.filter(Boolean).map((a) => a.finished.catch(() => {})));
  }
  /**
   * push(container, next, { dir: 1 | -1, axis: "x" | "y", duration: "pane", easing: "ease" })
   * House idiom "push, not fade": the old content and the new one travel in
   * lockstep by the container's size (no cross-fade, text never overlaps).
   * `next` is a Node or HTML string. Resolves when the old content is removed.
   */
  function push(container, next, opts = {}) {
    const node = next instanceof Node ? next : frag(next);
    const olds = [...container.childNodes];
    if (reducedMotion() || !olds.length || !container.isConnected) {
      container.replaceChildren(node);
      return Promise.resolve();
    }
    const dir = opts.dir || 1;
    const axis = opts.axis === "y" ? "Y" : "X";
    const box = container.getBoundingClientRect();
    const dist = opts.distance ?? (axis === "X" ? box.width : box.height);
    const prevOverflow = container.style.overflow;
    const prevPos = getComputedStyle(container).position;
    container.style.overflow = "hidden";
    if (prevPos === "static") container.style.position = "relative";
    const outWrap = h("div", { style: "position:absolute;inset:0;pointer-events:none" });
    outWrap.append(...olds);
    const inWrap = h("div", { style: "position:relative" }, node);
    container.append(outWrap, inWrap);
    const o = { duration: opts.duration || "pane", easing: opts.easing || "ease", fill: "both" };
    const a1 = animate(
      outWrap,
      [{ transform: "none" }, { transform: `translate${axis}(${-dir * dist}px)` }],
      o,
    );
    const a2 = animate(
      inWrap,
      [{ transform: `translate${axis}(${dir * dist}px)` }, { transform: "none" }],
      o,
    );
    return Promise.all(
      [a1?.finished, a2?.finished].filter(Boolean).map((p) => p.catch(() => {})),
    ).then(() => {
      outWrap.remove();
      inWrap.replaceWith(...inWrap.childNodes);
      container.style.overflow = prevOverflow;
      if (prevPos === "static") container.style.position = "";
    });
  }
  /**
   * syncIndicator(container, { instant=false })
   * Moves .seg-ind / .tab-ind inside `container` under the selected child
   * ([aria-selected=true] | [aria-checked=true] | [aria-current] | .active).
   */
  function syncIndicator(container, opts = {}) {
    const ind = container.querySelector(":scope > .seg-ind, :scope > .tab-ind");
    if (!ind) return;
    const sel = container.querySelector(
      ':scope > [aria-selected="true"], :scope > [aria-checked="true"], :scope > [aria-current="page"], :scope > [aria-current="true"], :scope > .active',
    );
    if (!sel) {
      ind.style.opacity = "0";
      return;
    }
    const instant = opts.instant || !ind.dataset.ready;
    if (instant) ind.style.transition = "none";
    ind.style.opacity = "1";
    ind.style.width = sel.offsetWidth + "px";
    ind.style.transform = `translateX(${sel.offsetLeft}px)`;
    if (instant) {
      void ind.offsetWidth;
      ind.style.transition = "";
      ind.dataset.ready = "1";
    }
  }
  /** indicator(container) → keeps the indicator synced on selection/resize; returns disconnect() */
  function indicator(container) {
    const mo = new MutationObserver(() => syncIndicator(container));
    mo.observe(container, {
      attributes: true,
      subtree: true,
      attributeFilter: ["aria-selected", "aria-checked", "aria-current", "class"],
    });
    const ro = new ResizeObserver(() => syncIndicator(container, { instant: true }));
    ro.observe(container);
    syncIndicator(container, { instant: true });
    return () => {
      mo.disconnect();
      ro.disconnect();
    };
  }

  /* ============================================================
     Floating layers
     ============================================================ */
  /** Tooltips: any element with data-tip (optional data-kbd, data-tip-side="bottom"). */
  const tip = (() => {
    const node = h("div", "tip");
    const inner = h("div", "tip-in");
    node.append(inner);
    document.body.append(node);
    let cur = null;
    let showT = 0;
    let hideT = 0;
    let vis = false;
    let lastHide = 0;
    const content = (t) =>
      esc(t.dataset.tip) + (t.dataset.kbd ? `<kbd>${esc(t.dataset.kbd)}</kbd>` : "");
    function put(t, glide) {
      if (!t.isConnected || !t.dataset.tip) return;
      cur = t;
      inner.innerHTML = content(t);
      const r = t.getBoundingClientRect();
      const w = node.offsetWidth;
      const ht = node.offsetHeight;
      const x = clamp(Math.round(r.left + r.width / 2 - w / 2), 6, innerWidth - w - 6);
      let y = Math.round(r.top - ht - 7);
      const below = t.dataset.tipSide === "bottom" || y < 6;
      if (below) y = Math.round(r.bottom + 7);
      node.classList.toggle("below", below);
      if (!glide) node.style.transition = "none";
      node.style.transform = `translate(${x}px, ${y}px)`;
      if (!glide) {
        void node.offsetWidth;
        node.style.transition = "";
      }
      node.classList.add("on");
      vis = true;
    }
    function show(t) {
      clearTimeout(hideT);
      clearTimeout(showT);
      const warm = vis || performance.now() - lastHide < 500;
      showT = setTimeout(() => put(t, vis), warm ? 30 : 450);
    }
    function hide() {
      clearTimeout(showT);
      clearTimeout(hideT);
      hideT = setTimeout(() => {
        node.classList.remove("on");
        if (vis) lastHide = performance.now();
        vis = false;
        cur = null;
      }, 70);
    }
    function hideNow() {
      clearTimeout(showT);
      node.classList.remove("on");
      vis = false;
      cur = null;
    }
    document.addEventListener("pointerover", (e) => {
      const t = e.target.closest?.("[data-tip]");
      if (t && t.dataset.tip) {
        if (t !== cur) show(t);
        else clearTimeout(hideT);
      } else hide();
    });
    document.addEventListener("pointerdown", hideNow, true);
    document.addEventListener("scroll", hideNow, true);
    return {
      hide: hideNow,
      refresh: () => cur && (cur.isConnected ? (inner.innerHTML = content(cur)) : hideNow()),
    };
  })();

  function placeNear(node, anchor, opts) {
    const r =
      anchor instanceof Element
        ? anchor.getBoundingClientRect()
        : { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y, width: 0, height: 0 };
    const w = node.offsetWidth;
    const ht = node.offsetHeight;
    const off = opts.offset ?? 6;
    let side = opts.side || "bottom";
    const align = opts.align || "start";
    const fits = {
      bottom: r.bottom + off + ht <= innerHeight - 8,
      top: r.top - off - ht >= 8,
      right: r.right + off + w <= innerWidth - 8,
      left: r.left - off - w >= 8,
    };
    const flipTo = { bottom: "top", top: "bottom", right: "left", left: "right" };
    if (!fits[side] && fits[flipTo[side]]) side = flipTo[side];
    let x;
    let y;
    if (side === "bottom" || side === "top") {
      y = side === "bottom" ? r.bottom + off : r.top - off - ht;
      x =
        align === "end" ? r.right - w : align === "center" ? r.left + r.width / 2 - w / 2 : r.left;
    } else {
      x = side === "right" ? r.right + off : r.left - off - w;
      y =
        align === "end"
          ? r.bottom - ht
          : align === "center"
            ? r.top + r.height / 2 - ht / 2
            : r.top;
    }
    x = clamp(x, 8, innerWidth - w - 8);
    y = clamp(y, 8, innerHeight - ht - 8);
    node.style.left = Math.round(x) + "px";
    node.style.top = Math.round(y) + "px";
    const ox = clamp(r.left + r.width / 2 - x, 0, w);
    const oy = clamp(r.top + r.height / 2 - y, 0, ht);
    node.style.transformOrigin = `${ox}px ${oy}px`;
    return side;
  }

  /**
   * menu(anchor | {x, y}, items, { side:"bottom", align:"start"|"end", onClose, minWidth }) → { close }
   * items: { label, sub, icon, kbd, checked, danger, disabled, reason, run } | { sep:true } | { head:"Title" }
   */
  const menu = (() => {
    let node = null;
    let owner = null;
    let onClose = null;
    function close() {
      if (!node) return;
      const dead = node;
      dead.classList.remove("on");
      dead.classList.add("off");
      setTimeout(() => dead.remove(), 120);
      owner?.classList.remove("menu-open");
      owner?.setAttribute?.("aria-expanded", "false");
      node = null;
      owner = null;
      const cb = onClose;
      onClose = null;
      cb?.();
    }
    document.addEventListener(
      "pointerdown",
      (e) => node && !node.contains(e.target) && !owner?.contains?.(e.target) && close(),
      true,
    );
    document.addEventListener(
      "keydown",
      (e) => {
        if (!node) return;
        const btns = $$(".m-it:not([aria-disabled])", node);
        const i = btns.indexOf(document.activeElement);
        if (e.key === "Escape") close();
        else if (e.key === "ArrowDown") btns[(i + 1) % btns.length]?.focus();
        else if (e.key === "ArrowUp") btns[(i - 1 + btns.length) % btns.length]?.focus();
        else return;
        e.preventDefault();
        e.stopImmediatePropagation();
      },
      true,
    );
    function open(anchor, items, opts = {}) {
      if (node && owner && owner === anchor) return close();
      close();
      if (!(anchor instanceof Element && anchor.closest(".pop"))) popover.close();
      tip.hide();
      owner = anchor instanceof Element ? anchor : null;
      onClose = opts.onClose || null;
      owner?.classList.add("menu-open");
      owner?.setAttribute?.("aria-expanded", "true");
      node = h(
        "div",
        { class: "menu", role: "menu", style: opts.minWidth ? `min-width:${opts.minWidth}px` : "" },
        raw(
          items
            .map((it, i) => {
              if (it.sep) return '<div class="m-sep"></div>';
              if (it.head) return `<div class="m-head">${esc(it.head)}</div>`;
              return `<button class="m-it ${it.danger ? "danger" : ""}" role="menuitem" data-i="${i}" ${it.disabled ? 'aria-disabled="true"' : ""} ${it.disabled && it.reason ? `data-tip="${esc(it.reason)}"` : ""}>${it.icon ? icon(it.icon) : ""}<span class="m-txt"><span>${esc(it.label)}</span>${it.sub ? `<span class="m-sub">${esc(it.sub)}</span>` : ""}</span>${it.checked ? icon("check", { cls: "m-check" }) : ""}${it.kbd ? `<kbd>${esc(it.kbd)}</kbd>` : ""}</button>`;
            })
            .join(""),
        ),
      );
      document.body.append(node);
      placeNear(node, anchor, {
        side: opts.side || "bottom",
        align: opts.align || "start",
        offset: 4,
      });
      node.addEventListener("click", (e) => {
        const b = e.target.closest(".m-it");
        if (!b || b.getAttribute("aria-disabled")) return;
        const it = items[+b.dataset.i];
        close();
        it.run?.();
      });
      requestAnimationFrame(() => node?.classList.add("on"));
      return { close };
    }
    return { open, close, isOpen: () => !!node };
  })();

  /**
   * popover(anchor, content, { side:"bottom", align:"start", offset:6, cls, width, onClose }) → { el, close, update, reposition }
   * content: string | Raw | Node | (api) => string | Raw | Node. One popover at a time;
   * opening on the same anchor toggles it closed. Escape / outside click closes.
   */
  const popover = (() => {
    let cur = null;
    function close() {
      if (!cur) return;
      const { node, anchor, onClose } = cur;
      node.classList.remove("on");
      node.classList.add("off");
      setTimeout(() => node.remove(), 130);
      anchor?.classList?.remove("pop-open");
      anchor?.setAttribute?.("aria-expanded", "false");
      cur = null;
      onClose?.();
    }
    document.addEventListener(
      "pointerdown",
      (e) => {
        if (
          cur &&
          !cur.node.contains(e.target) &&
          !cur.anchor?.contains?.(e.target) &&
          !e.target.closest?.(".menu, .scrim")
        )
          close();
      },
      true,
    );
    document.addEventListener("keydown", (e) => {
      if (cur && e.key === "Escape" && !menu.isOpen()) {
        close();
        e.stopPropagation();
      }
    });
    function fill(node, content, api) {
      const c = typeof content === "function" ? content(api) : content;
      node.replaceChildren();
      if (c instanceof Node) node.append(c);
      else node.innerHTML = String(c ?? "");
    }
    function open(anchor, content, opts = {}) {
      if (cur && cur.anchor === anchor) {
        close();
        return null;
      }
      close();
      menu.close();
      tip.hide();
      const node = h("div", {
        class: `pop ${opts.cls || ""}`,
        style: opts.width ? `width:${opts.width}px` : "",
      });
      const api = {
        el: node,
        close,
        update: (c) => {
          fill(node, c, api);
          api.reposition();
        },
        reposition: () => placeNear(node, anchor, opts),
      };
      cur = { node, anchor, onClose: opts.onClose };
      fill(node, content, api);
      document.body.append(node);
      api.reposition();
      anchor?.classList?.add("pop-open");
      anchor?.setAttribute?.("aria-expanded", "true");
      requestAnimationFrame(() => node.classList.add("on"));
      return api;
    }
    return { open, close, isOpen: () => !!cur };
  })();

  /** toast(message, { tone:"ok"|"err", icon, action:{ label, run }, duration=3200 }) */
  const toast = (() => {
    const node = h("div", { class: "toast", role: "status" });
    document.body.append(node);
    let timer = 0;
    let action = null;
    node.addEventListener("click", (e) => {
      if (!e.target.closest("button") || !action) return;
      const run = action.run;
      action = null;
      node.classList.remove("on");
      run?.();
    });
    return (msg, opts = {}) => {
      action = opts.action || null;
      const ic = opts.icon || (opts.tone === "ok" ? "check" : opts.tone === "err" ? "alert" : null);
      node.innerHTML = `${ic ? `<span class="t-${opts.tone || ""}">${icon(ic)}</span>` : ""}<span>${esc(msg)}</span>${action ? `<button type="button">${esc(action.label)}</button>` : ""}`;
      node.classList.remove("on");
      void node.offsetWidth;
      node.classList.add("on");
      clearTimeout(timer);
      timer = setTimeout(() => node.classList.remove("on"), opts.duration || 3200);
    };
  })();

  /**
   * confirm({ title, body (string|Raw), confirmLabel="Confirm", cancelLabel="Cancel", tone:"pri"|"ok"|"danger" }) → Promise<boolean>
   * Enter confirms, Escape cancels.
   */
  let closeConfirm = null;
  function confirm(o = {}) {
    closeConfirm?.(false);
    return new Promise((resolve) => {
      const tone = o.tone === "danger" ? "danger" : o.tone === "ok" ? "ok" : "pri";
      const scrim = h(
        "div",
        { class: "scrim" },
        raw(
          `<div class="dialog" role="alertdialog" aria-modal="true"><h3>${esc(o.title || "Are you sure?")}</h3><div class="dialog-body">${o.body instanceof Raw ? o.body : esc(o.body || "")}</div><div class="dialog-acts"><button class="btn ghost" data-r="0">${esc(o.cancelLabel || "Cancel")}</button><button class="btn ${tone}" data-r="1">${esc(o.confirmLabel || "Confirm")}</button></div></div>`,
        ),
      );
      const done = (v) => {
        if (!scrim.isConnected) return;
        document.removeEventListener("keydown", onKey, true);
        scrim.classList.remove("on");
        setTimeout(() => scrim.remove(), ms("pop"));
        closeConfirm = null;
        resolve(v);
      };
      const onKey = (e) => {
        if (e.key === "Escape") done(false);
        else if (e.key === "Enter") done(true);
        else return;
        e.preventDefault();
        e.stopImmediatePropagation();
      };
      scrim.addEventListener("click", (e) => {
        const b = e.target.closest("[data-r]");
        if (b) done(b.dataset.r === "1");
        else if (e.target === scrim) done(false);
      });
      document.addEventListener("keydown", onKey, true);
      document.body.append(scrim);
      closeConfirm = done;
      requestAnimationFrame(() => {
        scrim.classList.add("on");
        scrim.querySelector('[data-r="1"]').focus();
      });
    });
  }
  /** Closes every floating layer (menu, popover, tooltip, confirm). */
  function closeLayers() {
    menu.close();
    popover.close();
    tip.hide();
    closeConfirm?.(false);
  }
  /** copy(text, label?) → clipboard + toast */
  function copy(text, label) {
    navigator.clipboard?.writeText(text).catch(() => {});
    toast(label ? `Copied ${label}` : "Copied", { tone: "ok" });
  }

  /* ============================================================
     Model: groups, readiness, stacks, merge plans, checks
     ============================================================ */
  const ACTION_ORDER = {
    review: 0,
    merge: 1,
    "merge-stack": 1,
    "update-branch": 2,
    "fix-checks": 3,
    "resolve-conflicts": 3,
    "address-review": 3,
    "mark-ready": 4,
    "auto-merge": 5,
    "wait-checks": 6,
    "blocked-by-stack": 7,
    "await-review": 8,
    draft: 9,
    merged: 20,
    closed: 21,
  };
  const GROUPS = [
    { key: "review", label: "Needs your review" },
    { key: "mine", label: "Yours" },
    { key: "others", label: "Others" },
  ];
  const model = {
    data: DATA,
    viewer: () => DATA().viewer,
    /** user(login) → { login, name, bot?, team? } (teams are "org/slug") */
    user(login) {
      const d = DATA();
      if (d.users[login]) return d.users[login];
      if (d.teams?.[login]) return { login, name: d.teams[login].name, team: true };
      return { login, name: null, bot: /\[bot\]$/.test(login) };
    },
    label: (name) => DATA().labels[name] || { name },
    pr: (n) => DATA().pullRequests.find((p) => p.number === +n) || null,
    /** "open" | "draft" | "merged" | "closed" */
    state: prState,
    /** group(pr) → "review" | "mine" | "others" */
    group(pr) {
      if (pr.involvement === "review-requested") return "review";
      if (pr.author === DATA().viewer.login) return "mine";
      return "others";
    },
    /**
     * nextAction(pr) → { key, label, tone, owner, blockers }
     *   key: review | merge | merge-stack | update-branch | fix-checks | resolve-conflicts |
     *        address-review | mark-ready | auto-merge | wait-checks | blocked-by-stack |
     *        await-review | draft | merged | closed
     *   tone: ok | warn | err | run | info | neutral | merged | closed
     *   owner: who has to move: "you" | "author" | "reviewers" | "ci" | null
     *   blockers: [{ key, label }] — every reason merge is blocked (for the merge box)
     */
    nextAction(pr) {
      const viewer = DATA().viewer.login;
      const mine = pr.author === viewer;
      const A = (key, label, tone, owner) => ({
        key,
        label,
        tone,
        owner,
        blockers: model.blockers(pr),
      });
      if (pr.state === "merged") return A("merged", "Merged", "merged", null);
      if (pr.state === "closed") return A("closed", "Closed", "closed", null);
      if (pr.involvement === "review-requested") return A("review", "Your review", "warn", "you");
      if (pr.isDraft)
        return mine
          ? A("mark-ready", "Mark ready for review", "neutral", "you")
          : A("draft", "Draft", "neutral", "author");
      const owner = mine ? "you" : "author";
      if (pr.mergeable === "conflicting")
        return A("resolve-conflicts", "Resolve conflicts", "err", owner);
      if (pr.checks.state === "failing")
        return A(
          "fix-checks",
          pr.checks.failed > 1 ? `${pr.checks.failed} checks failing` : "Check failing",
          "err",
          owner,
        );
      if (pr.reviewDecision === "changes_requested")
        return A(
          "address-review",
          pr.unresolvedThreads
            ? `${plural(pr.unresolvedThreads, "thread")} to address`
            : "Changes requested",
          "warn",
          owner,
        );
      if (pr.checks.state === "running") return A("wait-checks", "Checks running", "run", "ci");
      if (pr.reviewDecision === "review_required")
        return A("await-review", "Awaiting review", "neutral", "reviewers");
      if (pr.stack && pr.stack.position > 1) {
        const plan = model.mergePlan(pr.number);
        if (plan?.blockedBy && plan.blockedBy.pr.number !== pr.number)
          return A(
            "blocked-by-stack",
            `Waiting on #${plan.blockedBy.pr.number}`,
            "neutral",
            plan.blockedBy.pr.author === viewer ? "you" : "author",
          );
      }
      if (pr.mergeStateStatus === "BEHIND")
        return A("update-branch", "Update branch", "warn", owner);
      if (pr.autoMerge) return A("auto-merge", "Auto-merge on", "ok", "ci");
      if (pr.stack && pr.stack.position > 1)
        return A("merge-stack", model.mergePlan(pr.number).label, "ok", owner);
      return A("merge", "Ready to merge", "ok", owner);
    },
    /** blockers(pr) → [{ key, label }] in the order the merge box should list them */
    blockers(pr) {
      if (pr.state !== "open") return [];
      const out = [];
      const prot = DATA().repo.protection;
      if (pr.isDraft) out.push({ key: "draft", label: "Still a draft" });
      if (pr.mergeable === "conflicting")
        out.push({ key: "conflicts", label: "Merge conflicts with " + pr.baseRefName });
      if (pr.checks.failed)
        out.push({ key: "checks-failing", label: `${plural(pr.checks.failed, "check")} failing` });
      if (pr.checks.running)
        out.push({ key: "checks-running", label: `${plural(pr.checks.running, "check")} running` });
      if (pr.reviewDecision === "changes_requested")
        out.push({ key: "changes-requested", label: "Changes requested" });
      else if (pr.reviewDecision === "review_required" || pr.reviewDecision == null)
        out.push({
          key: "review-required",
          label: `${plural(prot.requiredApprovals, "approval")} required`,
        });
      if (prot.requireConversationResolution && pr.unresolvedThreads)
        out.push({ key: "threads", label: `${plural(pr.unresolvedThreads, "unresolved thread")}` });
      if (pr.mergeStateStatus === "BEHIND")
        out.push({
          key: "behind",
          label: `${pr.behindBy || "Some"} commits behind ${pr.baseRefName}`,
        });
      return out;
    },
    /** rank(pr) → number; lower sorts first (readiness, then recency) */
    rank(pr) {
      const a = model.nextAction(pr).key;
      return (ACTION_ORDER[a] ?? 10) * 1e13 - Date.parse(pr.updatedAt);
    },
    /**
     * groups(prs = all, { state: "open"|"draft"|"merged"|"closed"|"all" = "open", keepStacks = true })
     * → [{ key, label, prs }] — prs sorted by rank; stack layers stay adjacent (top layer first),
     * placed at the best-ranked layer's position.
     */
    groups(prs, opts = {}) {
      const state = opts.state || "open";
      const list = (prs || DATA().pullRequests).filter(
        (p) =>
          state === "all" ||
          (state === "draft" ? p.state === "open" && p.isDraft : p.state === state),
      );
      return GROUPS.map((g) => {
        const items = list
          .filter((p) => model.group(p) === g.key)
          .sort((a, b) => model.rank(a) - model.rank(b));
        if (opts.keepStacks === false) return { ...g, prs: items };
        const out = [];
        const seen = new Set();
        for (const p of items) {
          if (seen.has(p.number)) continue;
          if (!p.stack) {
            out.push(p);
            seen.add(p.number);
            continue;
          }
          const layers = items
            .filter((q) => q.stack?.id === p.stack.id)
            .sort((a, b) => b.stack.position - a.stack.position);
          for (const q of layers) {
            out.push(q);
            seen.add(q.number);
          }
        }
        return { ...g, prs: out };
      });
    },
    /**
     * stackOf(n | pr) → { id, number, baseRefName, size, position, entries:[pr bottom→top], current, assessment } | null
     * assessment: { state:"ready"|"blocked"|"pending"|"merged", label, layer }
     */
    stackOf(x) {
      const pr = typeof x === "object" ? x : model.pr(x);
      if (!pr?.stack) return null;
      const s = DATA().stacks.find((st) => st.id === pr.stack.id);
      const entries = s.entries.map((n) => model.pr(n));
      const open = entries.filter((e) => e.state === "open");
      let assessment;
      if (!open.length) assessment = { state: "merged", label: "Stack merged", layer: null };
      else {
        const plan = model.mergePlan(open[open.length - 1].number);
        assessment = plan.blockedBy
          ? {
              state: plan.blockedBy.pending ? "pending" : "blocked",
              label: `#${plan.blockedBy.pr.number}: ${plan.blockedBy.reason}`,
              layer: plan.blockedBy.pr.number,
            }
          : { state: "ready", label: "Ready to merge", layer: null };
      }
      return {
        id: s.id,
        number: s.number,
        baseRefName: s.baseRefName,
        size: entries.length,
        position: pr.stack.position,
        entries,
        current: pr,
        assessment,
      };
    },
    /**
     * mergePlan(n, through = n's position) → { through, layers:[pr], blockedBy:{ pr, reason, pending } | null, label, base }
     * "Merge through layer k" lands every open layer at or below k (GitHub merge-async on a stack).
     * Without a stack: a plan of one.
     */
    mergePlan(n, through) {
      const pr = model.pr(n);
      if (!pr) return null;
      const s = pr.stack ? DATA().stacks.find((st) => st.id === pr.stack.id) : null;
      const pos = through ?? pr.stack?.position ?? 1;
      const layers = s
        ? s.entries
            .map((x) => model.pr(x))
            .filter((p) => p.stack.position <= pos && p.state !== "merged")
        : [pr];
      let blockedBy = null;
      for (const p of layers) {
        const why =
          p.state === "closed"
            ? ["Closed without merging", false]
            : p.isDraft
              ? ["Still a draft", false]
              : p.mergeable === "conflicting"
                ? ["Has merge conflicts", false]
                : p.checks.state === "failing"
                  ? ["Checks failing", false]
                  : p.reviewDecision === "changes_requested"
                    ? ["Changes requested", false]
                    : p.checks.state === "running"
                      ? ["Checks running", true]
                      : p.reviewDecision === "review_required"
                        ? ["Needs review", true]
                        : null;
        if (why) {
          blockedBy = { pr: p, reason: why[0], pending: why[1] };
          break;
        }
      }
      return {
        through: pos,
        layers,
        blockedBy,
        label: layers.length > 1 ? `Merge stack (${layers.length})` : "Merge",
        base: s ? s.baseRefName : pr.baseRefName,
      };
    },
    /** detail(n) → full detail, or a synthesized light one ({ synthetic:true }) for PRs not mocked in depth */
    detail(n) {
      const d = DATA().details[n];
      if (d) return d;
      const pr = model.pr(n);
      if (!pr) return null;
      const cache = (model._synth ||= {});
      if (cache[n]) return cache[n];
      const at = pr.createdAt;
      cache[n] = {
        number: pr.number,
        synthetic: true,
        headSha: pr.headSha,
        body: `${pr.title}.\n\n_This pull request is only mocked at summary level in the lab._`,
        participants: [pr.author, ...pr.reviewers.map((r) => r.login)],
        reviewers: pr.reviewers.map((r) => ({ ...r, requested: r.state === "pending" })),
        linkedIssues: [],
        linkedThreads: [],
        behindBy: pr.behindBy || 0,
        commits: [],
        files: [],
        threads: [],
        timeline: [
          { id: `${n}-s1`, kind: "opened", actor: pr.author, at, isDraft: pr.isDraft },
          ...pr.labels.map((l, i) => ({
            id: `${n}-l${i}`,
            kind: "labeled",
            actor: pr.author,
            at,
            label: l,
          })),
          ...pr.reviewers.map((r, i) => ({
            id: `${n}-r${i}`,
            kind: "review_requested",
            actor: pr.author,
            at,
            reviewer: r.login,
          })),
          ...(pr.mergedAt
            ? [
                {
                  id: `${n}-m`,
                  kind: "merged",
                  actor: pr.mergedBy,
                  at: pr.mergedAt,
                  commit: pr.headSha,
                },
              ]
            : []),
          ...(pr.closedAt
            ? [{ id: `${n}-c`, kind: "closed", actor: pr.author, at: pr.closedAt }]
            : []),
        ],
        pendingReview: null,
        checks: {
          workflows: [],
          statuses: [],
          note: "Checks are not mocked for this pull request.",
        },
      };
      return cache[n];
    },
    /** checks(detail) → { workflows, jobs:[job + workflow], failing, running, summary } */
    checks(detail) {
      const wf = detail?.checks?.workflows || [];
      const jobs = wf.flatMap((w) => w.jobs.map((j) => ({ ...j, workflow: w })));
      return {
        workflows: wf,
        statuses: detail?.checks?.statuses || [],
        jobs,
        failing: jobs.filter((j) => j.conclusion === "failure"),
        running: jobs.filter((j) => j.status !== "completed"),
        note: detail?.checks?.note || null,
        summary: model.pr(detail?.number)?.checks || null,
      };
    },
    /**
     * threadsFor(detail, path?) → review threads (optionally for one file), with the viewer's
     * pending-review comments appended as { pending:true, comments:[{ author, body, pending:true }] }.
     */
    threadsFor(detail, path) {
      const viewer = DATA().viewer.login;
      const list = [...(detail?.threads || [])];
      for (const c of detail?.pendingReview?.comments || [])
        list.push({
          id: c.id,
          path: c.path,
          side: c.side,
          line: c.line,
          lineText: c.lineText,
          diffHunk: c.diffHunk,
          isResolved: false,
          isOutdated: false,
          pending: true,
          comments: [
            {
              id: c.id + "-c",
              author: viewer,
              body: c.body,
              createdAt: detail.pendingReview.startedAt,
              pending: true,
              reactions: [],
            },
          ],
        });
      return path ? list.filter((t) => t.path === path) : list;
    },
    unresolved: (detail) => (detail?.threads || []).filter((t) => !t.isResolved).length,
    /** reviewSummary(pr | detail) → { approved:[login], changes:[login], commented:[login], pending:[login] } */
    reviewSummary(x) {
      const list = x.reviewers || [];
      const by = (s) => list.filter((r) => r.state === s).map((r) => r.login);
      return {
        approved: by("approved"),
        changes: by("changes_requested"),
        commented: by("commented"),
        pending: by("pending"),
      };
    },
    /** parse a pasted reference: "https://github.com/ryco-labs/ryco/pull/703", "#703", "703" → 703 | null */
    parseRef(text) {
      const m = String(text || "")
        .trim()
        .match(/(?:\/pull\/|#|^)(\d{1,6})(?:\b|$)/);
      return m ? +m[1] : null;
    },
  };

  /* ============================================================
     Direction registry
     ============================================================ */
  const directions = [];
  /**
   * registerDirection({ id:"a"|"b"|"c", name, tagline, mount(rootEl, data, labApi) => unmountFn })
   * Re-registering an id replaces it.
   */
  function registerDirection(def) {
    if (!def || !def.id || typeof def.mount !== "function")
      throw new Error("registerDirection needs { id, mount }");
    const i = directions.findIndex((d) => d.id === def.id);
    if (i >= 0) directions[i] = def;
    else directions.push(def);
    bus.emit("direction:registered", def);
  }

  Object.assign(LAB, {
    // templating
    Raw,
    raw,
    esc,
    html,
    h,
    append,
    frag,
    el,
    $,
    $$,
    on,
    uid,
    plural,
    clamp,
    // icons + glyphs
    ICONS,
    icon,
    fav,
    R_LOGO,
    stateGlyph,
    prState,
    checkGlyph,
    checkKind,
    runKind,
    reviewGlyph,
    labelChip,
    diffStat,
    diffBar,
    avatar,
    avatarStack,
    avatarColor,
    avatarHue,
    // time
    now,
    ago,
    agoLong,
    fmtDate,
    dur,
    // markdown + code
    markdown,
    inline,
    highlight,
    tokenize,
    renderTokens,
    langOf,
    // diff
    parsePatch,
    parseDiff,
    toSplit,
    wordRange,
    renderDiff,
    buildFileTree,
    // state
    createBus,
    createStore,
    bus,
    // motion
    reducedMotion,
    ms,
    easing,
    animate,
    flip,
    push,
    syncIndicator,
    indicator,
    // layers
    tip,
    menu,
    popover,
    toast,
    confirm,
    closeLayers,
    copy,
    // model
    model,
    // registry
    directions,
    registerDirection,
  });
})();
