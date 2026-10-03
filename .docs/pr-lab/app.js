/* ============================================================
   PR lab · shell: app sidebar, lab switcher, hash state, direction
   mounting. Directions never touch this file; they get `labApi`.

   Hash convention (README.md):  #<dir>?key=value&…
     dir     a | b | c                      (path segment before "?")
     pr      PR number → detail open        (absent → list / inbox)
     tab     conversation | files | checks | commits
     stack   open → stack panel/popover open
     merge   open → merge box / menu open
     review  open → pending-review composer open
     file, thread, commit, view (unified|split), job, q, group, filter
     theme   light | dark          (always written)
     width   1440 | 1180 | 920 …   (always written; any px value works)
     motion  reduced               (only when on)
     sb      0 → app sidebar collapsed
     lab     0 → lab switcher hidden (clean screenshots)
   ============================================================ */
(function () {
  "use strict";
  const L = window.PR_LAB;
  const { $, $$, esc, icon, h } = L;
  const DATA = window.PR_LAB_DATA;
  const root = document.documentElement;
  const win = $("#win");
  const page = $("#page");
  const STORE_KEY = "pr-lab:v1";
  const WIDTHS = [1440, 1180, 920];
  const APP_KEYS = new Set(["theme", "width", "motion", "sb", "lab"]);
  const FLAG_KEYS = new Set(["stack", "merge", "review"]);
  const KEY_ORDER = [
    "pr",
    "tab",
    "stack",
    "merge",
    "review",
    "file",
    "thread",
    "commit",
    "view",
    "job",
    "q",
    "group",
    "filter",
  ];
  const TAIL_ORDER = ["theme", "width", "motion", "sb", "lab"];

  /* ---------------------------------------------------------- persistence */
  const stored = (() => {
    try {
      return JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
    } catch {
      return {};
    }
  })();
  function persist() {
    try {
      localStorage.setItem(
        STORE_KEY,
        JSON.stringify({
          dir: app.dir,
          theme: app.theme,
          width: app.width,
          motion: app.motion,
          sb: app.sb,
        }),
      );
    } catch {}
  }

  /* ---------------------------------------------------------- hash */
  function readHash(hash = location.hash) {
    const s = hash.replace(/^#/, "");
    const qi = s.indexOf("?");
    const dir = (qi < 0 ? s : s.slice(0, qi)).trim().toLowerCase();
    const params = Object.fromEntries(new URLSearchParams(qi < 0 ? "" : s.slice(qi + 1)));
    return { dir, params };
  }
  function writeHash(dir, params) {
    const keys = Object.keys(params).filter((k) => params[k] != null && params[k] !== "");
    const order = (k) => {
      const a = KEY_ORDER.indexOf(k);
      const t = TAIL_ORDER.indexOf(k);
      return a >= 0 ? a : t >= 0 ? 1000 + t : 500;
    };
    keys.sort((a, b) => order(a) - order(b) || a.localeCompare(b));
    const q = keys
      .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
      .join("&");
    return `#${dir}${q ? "?" + q : ""}`;
  }
  /** Normalized view of the hash for directions. Unknown keys pass through as strings. */
  function stateOf(dir, params) {
    const pr = params.pr != null && params.pr !== "" ? Number(params.pr) : null;
    return {
      ...params,
      dir,
      pr: Number.isFinite(pr) ? pr : null,
      tab: params.tab || null,
      stack: params.stack === "open" || params.stack === "1",
      merge: params.merge === "open" || params.merge === "1",
      review: params.review === "open" || params.review === "1",
      theme: app.theme,
      width: app.width,
      motion: app.motion ? "reduced" : null,
      sb: app.sb,
      lab: app.lab,
      params: { ...params },
    };
  }
  /** Patch values → hash strings: null/false/"" delete; true → "open" for flags, "1" otherwise. */
  function toParam(k, v) {
    if (v == null || v === false || v === "") return null;
    if (v === true) return FLAG_KEYS.has(k) ? "open" : "1";
    return String(v);
  }

  /* ---------------------------------------------------------- app state */
  const prefersReduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const app = {
    dir: "a",
    theme: stored.theme || "dark",
    width: stored.width || 1440,
    motion: stored.motion ?? prefersReduced,
    sb: stored.sb ?? true,
    lab: true,
    params: {},
    lastHash: "",
  };
  function applyAppKeys(params) {
    if (params.theme === "light" || params.theme === "dark") app.theme = params.theme;
    if (params.width && Number(params.width) > 400) app.width = Number(params.width);
    if ("motion" in params) app.motion = params.motion === "reduced" || params.motion === "1";
    if ("sb" in params) app.sb = params.sb !== "0";
    if ("lab" in params) app.lab = params.lab !== "0";
  }
  /** Direction params (no app keys) + app keys reflected from app state. */
  function fullParams() {
    const p = { ...app.params, theme: app.theme, width: String(app.width) };
    if (app.motion) p.motion = "reduced";
    if (!app.sb) p.sb = "0";
    if (!app.lab) p.lab = "0";
    return p;
  }
  function syncHash(push) {
    const next = writeHash(app.dir, fullParams());
    if (next === location.hash) {
      app.lastHash = next;
      return;
    }
    history[push ? "pushState" : "replaceState"](null, "", next);
    app.lastHash = next;
  }
  function paintApp(prev = {}) {
    root.classList.toggle("dark", app.theme === "dark");
    root.classList.toggle("reduce-motion", !!app.motion);
    root.classList.toggle("lab-hidden", !app.lab);
    win.classList.toggle("sb-collapsed", !app.sb);
    win.style.setProperty("--win-w", app.width + "px");
    if (prev.theme !== undefined && prev.theme !== app.theme) emitScoped("theme", app.theme);
    if (prev.width !== undefined && prev.width !== app.width) emitScoped("width", app.width);
    if (prev.motion !== undefined && prev.motion !== app.motion) emitScoped("motion", !!app.motion);
    if (prev.sb !== undefined && prev.sb !== app.sb) emitScoped("sidebar", app.sb);
    paintSwitcher();
    persist();
  }
  const snapshot = () => ({
    theme: app.theme,
    width: app.width,
    motion: app.motion,
    sb: app.sb,
    lab: app.lab,
  });
  function setApp(patch) {
    const prev = snapshot();
    Object.assign(app, patch);
    paintApp(prev);
    syncHash(false);
  }

  /* ---------------------------------------------------------- direction mounting */
  let current = null;
  function emitScoped(evt, payload) {
    if (!current) return;
    for (const fn of [...(current.scope.events.get(evt) || [])]) {
      try {
        fn(payload);
      } catch (err) {
        console.error(err);
      }
    }
  }
  function notifyHash(prevState) {
    if (!current) return;
    const state = stateOf(app.dir, app.params);
    const changed = new Set(
      [...new Set([...Object.keys(prevState.params || {}), ...Object.keys(state.params)])].filter(
        (k) => (prevState.params || {})[k] !== state.params[k],
      ),
    );
    for (const k of ["theme", "width", "motion", "sb", "lab"])
      if (prevState[k] !== state[k]) changed.add(k);
    if (!changed.size) return;
    for (const fn of [...current.scope.hash]) {
      try {
        fn(state, { prev: prevState, changed });
      } catch (err) {
        console.error(err);
      }
    }
  }
  function makeApi(def, rootEl, scope) {
    return {
      dir: def.id,
      data: DATA,
      root: rootEl,
      page,
      /** Current hash state (normalized; unknown keys are strings). */
      getHashState: () => stateOf(app.dir, app.params),
      /**
       * Merge a patch into the hash (null/false/"" delete a key; true → "open" for
       * stack/merge/review). Uses replaceState unless { push: true }. Does NOT call
       * your own onHashChange listeners. Patching dir switches direction; patching
       * theme/width/motion/sb/lab applies them.
       */
      setHashState(patch = {}, opts = {}) {
        const prev = snapshot();
        let dirChange = null;
        for (const [k, v] of Object.entries(patch)) {
          if (k === "dir") {
            if (v && v !== app.dir) dirChange = v;
            continue;
          }
          if (APP_KEYS.has(k)) {
            if (k === "sb" || k === "lab")
              applyAppKeys({ [k]: v === false || v === 0 || v === "0" ? "0" : "1" });
            else if (k === "motion")
              applyAppKeys({
                motion: v === true || v === "reduced" || v === "1" ? "reduced" : "0",
              });
            else if (v != null) applyAppKeys({ [k]: String(v) });
            continue;
          }
          const p = toParam(k, v);
          if (p == null) delete app.params[k];
          else app.params[k] = p;
        }
        paintApp(prev);
        if (dirChange) return switchDir(dirChange, { push: opts.push });
        syncHash(!!opts.push);
      },
      /** cb(state, { prev, changed:Set<key> }) on back/forward, manual URL edits, sidebar/app navigation. → off() */
      onHashChange(cb) {
        scope.hash.add(cb);
        return () => scope.hash.delete(cb);
      },
      /** on("theme"|"width"|"motion"|"sidebar"|"resize", cb) → off(). resize payload: { width, height } of #page */
      on(evt, cb) {
        if (!scope.events.has(evt)) scope.events.set(evt, new Set());
        scope.events.get(evt).add(cb);
        return () => scope.events.get(evt)?.delete(cb);
      },
      theme: () => app.theme,
      width: () => app.width,
      pageWidth: () => page.clientWidth,
      reducedMotion: () => !!app.motion,
      sidebarOpen: () => app.sb,
      setSidebar: (open) => setApp({ sb: !!open }),
      toast: L.toast,
    };
  }
  function unmountCurrent() {
    if (!current) return;
    try {
      current.unmount?.();
    } catch (err) {
      console.error(err);
    }
    current.scope.hash.clear();
    current.scope.events.clear();
    L.closeLayers();
    current.root.remove();
    current = null;
  }
  function mountDir(id) {
    unmountCurrent();
    const def = L.directions.find((d) => d.id === id) || L.directions[0];
    if (!def) {
      page.innerHTML = '<pre class="dir-error">No directions registered.</pre>';
      return;
    }
    app.dir = def.id;
    const rootEl = h("div", { class: `dir-root dir-${def.id}` });
    if (!app.motion) {
      rootEl.classList.add("entering");
      rootEl.addEventListener("animationend", () => rootEl.classList.remove("entering"), {
        once: true,
      });
    }
    page.append(rootEl);
    const scope = { hash: new Set(), events: new Map() };
    current = { def, root: rootEl, scope, unmount: null };
    root.dataset.dir = def.id;
    document.title = `Ryco · PR lab · ${def.id.toUpperCase()} ${def.name || ""}`.trim();
    try {
      const un = def.mount(rootEl, DATA, makeApi(def, rootEl, scope));
      current.unmount = typeof un === "function" ? un : null;
    } catch (err) {
      console.error(err);
      rootEl.innerHTML = `<pre class="dir-error">Direction ${esc(def.id)} failed to mount\n\n${esc(err?.stack || err)}</pre>`;
    }
    paintSwitcher();
    persist();
  }
  function switchDir(id, opts = {}) {
    if (!L.directions.some((d) => d.id === id)) return;
    app.dir = id;
    syncHash(!!opts.push);
    mountDir(id);
  }
  new ResizeObserver(() =>
    emitScoped("resize", { width: page.clientWidth, height: page.clientHeight }),
  ).observe(page);

  /** Navigation from outside the direction (sidebar, app): updates hash and notifies the direction. */
  function navigate(patch) {
    const prevState = stateOf(app.dir, app.params);
    for (const [k, v] of Object.entries(patch)) {
      const p = toParam(k, v);
      if (p == null) delete app.params[k];
      else app.params[k] = p;
    }
    syncHash(true);
    notifyHash(prevState);
  }
  function onExternalHash() {
    if (location.hash === app.lastHash) return;
    const prevState = stateOf(app.dir, app.params);
    const prevApp = snapshot();
    const { dir, params } = readHash();
    applyAppKeys({ motion: "0", sb: "1", lab: "1", ...params });
    app.params = Object.fromEntries(Object.entries(params).filter(([k]) => !APP_KEYS.has(k)));
    paintApp(prevApp);
    app.lastHash = location.hash;
    if (dir && dir !== app.dir && L.directions.some((d) => d.id === dir)) {
      app.dir = dir;
      mountDir(dir);
      syncHash(false);
      return;
    }
    syncHash(false);
    notifyHash(prevState);
  }
  addEventListener("hashchange", onExternalHash);
  addEventListener("popstate", onExternalHash);

  /* ---------------------------------------------------------- app sidebar */
  for (const slot of $$("[data-icon]")) slot.replaceWith(L.frag(String(icon(slot.dataset.icon))));
  const DONE_SVG = `<svg viewBox="0 0 14 14"><circle cx="7" cy="7" r="6.2" fill="var(--ok-fill)"/><path d="M4.3 7.3l1.8 1.8 3.7-3.9" fill="none" stroke="var(--check-ink)" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  function threadRow(t) {
    const glyph =
      t.state === "done"
        ? `<span class="g g-done" data-tip="Done · not opened yet">${DONE_SVG}</span>`
        : `<span class="g g-${t.state}" data-tip="${t.state === "working" ? "Working" : t.state === "input" ? "Needs approval" : "Idle"}"></span>`;
    const sub =
      t.state === "input"
        ? `<span class="ask trunc"><b>Approve</b> <code>${esc(t.ask)}</code></span>`
        : t.state === "done" && t.diff
          ? `${L.diffStat(t.diff.add, t.diff.del)}<span class="dim trunc">${t.diff.files} files</span>`
          : `${icon("branch")}<span class="trunc">${esc(t.branch)}</span>`;
    const pr = t.pr ? L.model.pr(t.pr) : null;
    const prRef = t.pr
      ? `<span class="pr-ref" style="color:var(--pr-${pr ? L.prState(pr) : "closed"})" data-tip="${esc(pr ? `#${pr.number} · ${pr.title}` : `#${t.pr}`)}">${icon(pr ? `pr-${L.prState(pr) === "draft" ? "draft" : L.prState(pr) === "merged" ? "merged" : L.prState(pr) === "closed" ? "closed" : "open"}` : "pr-closed")}#${t.pr}</span>`
      : "";
    return `<div class="asb-row ${t.unread ? "unread" : ""}" data-thread="${esc(t.id)}" ${t.pr && pr ? `data-pr="${t.pr}"` : ""}>${glyph}<span class="t">${esc(t.title)}</span><span class="f">${L.fav(14)}</span><span class="s">${sub}</span><span class="m">${prRef}<span>${L.ago(t.at)}</span></span></div>`;
  }
  function paintSidebar() {
    const threads = DATA.sidebar.threads;
    const needs = threads.filter((t) => t.state === "input" || (t.state === "done" && t.unread));
    const rest = threads.filter((t) => !needs.includes(t));
    $("#asb-list").innerHTML =
      `<div class="asb-sec">Needs you <span class="cnt">${needs.length}</span></div>${needs.map(threadRow).join("")}` +
      `<div class="asb-sec">Active <span class="cnt">${rest.length}</span></div>${rest.map(threadRow).join("")}`;
    const review = DATA.pullRequests.filter(
      (p) => p.state === "open" && L.model.group(p) === "review",
    ).length;
    $("#asb-pr-count").textContent = review ? String(review) : "";
  }
  paintSidebar();
  $("#asb-list").addEventListener("click", (e) => {
    const row = e.target.closest(".asb-row[data-pr]");
    if (row)
      navigate({
        pr: Number(row.dataset.pr),
        tab: null,
        file: null,
        thread: null,
        commit: null,
        job: null,
      });
  });
  $("#asb-prs").addEventListener("click", () =>
    navigate({
      pr: null,
      tab: null,
      file: null,
      thread: null,
      commit: null,
      job: null,
      stack: null,
      merge: null,
      review: null,
    }),
  );
  $("#asb-collapse").addEventListener("click", () => setApp({ sb: false }));

  /* ---------------------------------------------------------- lab switcher */
  const sw = $("#labsw");
  function buildSwitcher() {
    const dirs = L.directions
      .map(
        (d) =>
          `<button class="seg-opt" type="button" role="radio" data-dir="${esc(d.id)}" data-tip="${esc(`${d.id.toUpperCase()} · ${d.name}${d.tagline ? " — " + d.tagline : ""}`)}" data-kbd="⌥${L.directions.indexOf(d) + 1}">${esc(d.id.toUpperCase())}</button>`,
      )
      .join("");
    const widths = WIDTHS.map(
      (w) =>
        `<button class="seg-opt tnum" type="button" role="radio" data-w="${w}" data-tip="Window ${w}px" data-kbd="⌥W">${w}</button>`,
    ).join("");
    sw.innerHTML = `<div class="seg seg-dir" role="radiogroup" aria-label="Direction"><i class="seg-ind"></i>${dirs}</div>
      <span class="labsw-sep"></span>
      <button class="ib" type="button" data-act="theme" data-tip="Light / dark" data-kbd="⌥T"></button>
      <button class="ib" type="button" data-act="motion" data-tip="Reduced motion" data-kbd="⌥M">${icon("motion")}</button>
      <button class="ib" type="button" data-act="sidebar" data-tip="Show sidebar" data-kbd="⌥B">${icon("sidebar")}</button>
      <span class="labsw-sep"></span>
      <div class="seg seg-w" role="radiogroup" aria-label="Window width"><i class="seg-ind"></i>${widths}</div>`;
    L.indicator($(".seg-dir", sw));
    L.indicator($(".seg-w", sw));
  }
  function paintSwitcher() {
    if (!sw.firstElementChild) return;
    for (const b of $$("[data-dir]", sw))
      b.setAttribute("aria-checked", String(b.dataset.dir === app.dir));
    for (const b of $$("[data-w]", sw))
      b.setAttribute("aria-checked", String(Number(b.dataset.w) === app.width));
    $('[data-act="theme"]', sw).innerHTML = String(icon(app.theme === "dark" ? "sun" : "moon"));
    $('[data-act="motion"]', sw).setAttribute("aria-pressed", String(!!app.motion));
    $('[data-act="sidebar"]', sw).hidden = app.sb;
    const pw = page.clientWidth;
    $(".seg-w", sw).dataset.tip = `Page area ${pw}px`;
  }
  sw.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.dir) switchDir(b.dataset.dir, { push: true });
    else if (b.dataset.w) setApp({ width: Number(b.dataset.w) });
    else if (b.dataset.act === "theme") setApp({ theme: app.theme === "dark" ? "light" : "dark" });
    else if (b.dataset.act === "motion") setApp({ motion: !app.motion });
    else if (b.dataset.act === "sidebar") setApp({ sb: true });
  });
  addEventListener("keydown", (e) => {
    if (!e.altKey || e.metaKey || e.ctrlKey) return;
    const n = /^Digit([1-9])$/.exec(e.code);
    if (n && L.directions[+n[1] - 1]) switchDir(L.directions[+n[1] - 1].id, { push: true });
    else if (e.code === "KeyT") setApp({ theme: app.theme === "dark" ? "light" : "dark" });
    else if (e.code === "KeyM") setApp({ motion: !app.motion });
    else if (e.code === "KeyB") setApp({ sb: !app.sb });
    else if (e.code === "KeyL") setApp({ lab: !app.lab });
    else if (e.code === "KeyW")
      setApp({ width: WIDTHS[(WIDTHS.indexOf(app.width) + 1) % WIDTHS.length] });
    else return;
    e.preventDefault();
  });

  /* ---------------------------------------------------------- boot */
  const initial = readHash();
  applyAppKeys(initial.params);
  app.params = Object.fromEntries(Object.entries(initial.params).filter(([k]) => !APP_KEYS.has(k)));
  const wanted = initial.dir || stored.dir || "a";
  app.dir = L.directions.some((d) => d.id === wanted) ? wanted : L.directions[0]?.id || "a";
  buildSwitcher();
  paintApp();
  syncHash(false);
  mountDir(app.dir);
  // Directions registered late (e.g. re-registered while iterating) refresh the switcher.
  L.bus.on("direction:registered", () => {
    buildSwitcher();
    paintSwitcher();
  });
  new ResizeObserver(() => paintSwitcher()).observe(page);
})();
