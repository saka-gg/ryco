/* ============================================================
   Lab shell: controls, direction tabs, the app window, notes,
   and the simulation clock. Loaded last.

   Direction contract (dir-*.js):
     DIRS.X = { title, thesis, notes: [[heading, [items…]], …],
                mount(host, api) → { update(S), destroy() } }
   host: the area right of the app rail (#host, ≈1280×820, position: relative).
   api.notify(text, opts?) → toast in the app window.
   update(S) runs on every emit(): state changes and every sim tick.

   URL: #A..#D  ?theme=light|dark (light)  ?paused=1  ?t=<minutes>
        ?speed=60  ?motion=0  ?full=<projectId> (fills it to 25 schedules)
   ============================================================ */
(() => {
  const TABS = {
    A: {
      title: "Schedules",
      thesis: "A dedicated page: schedules grouped by project, a detail pane, approvals on top.",
    },
    B: {
      title: "Agenda",
      thesis: "The same page organised by time: a week of lanes with a live now-line.",
    },
    C: {
      title: "Dialog",
      thesis: "No new page: one Automations dialog that morphs out of wherever you are.",
    },
    D: {
      title: "Pickers",
      thesis: "The date, interval and end pickers side by side, on the same value.",
    },
  };
  const ORDER = ["A", "B", "C", "D"];
  const params = new URLSearchParams(location.search);
  const host = $("#host");
  let tab = "A";
  let inst = null;
  const logged = new Set();

  const api = {
    notify: (text, opts) => toast(text, opts),
  };

  /* Surface a direction's error once (shoot.mjs reports console errors). */
  function report(where, err) {
    const key = `${tab}:${where}:${err?.message ?? err}`;
    if (logged.has(key)) return;
    logged.add(key);
    console.error(`[${tab}] ${where}:`, err);
  }

  function placeholder(id, failed) {
    const t = TABS[id];
    host.innerHTML = `<div class="host-empty"><div><b>${esc(id)} · ${esc(t.title)}</b>${
      failed ? "This direction failed to mount — see the console." : "Not built yet."
    }</div></div>`;
  }

  function notesHtml(id) {
    const d = DIRS[id];
    const title = d?.title ?? TABS[id].title;
    const thesis = d?.thesis ?? TABS[id].thesis;
    const notes = d?.notes ?? [];
    return `<div class="notes-grid">
      <div><h2>${esc(id)} · ${esc(title)}</h2><p class="thesis">${thesis}</p></div>
      ${notes
        .map(
          ([head, items]) =>
            `<div><h3>${head}</h3><ul>${(items ?? []).map((x) => `<li>${x}</li>`).join("")}</ul></div>`,
        )
        .join("")}
    </div>`;
  }

  function setTab(next, o = {}) {
    tab = ORDER.includes(next) ? next : "A";
    for (const b of $$("#tabs .seg-opt")) {
      const on = b.dataset.tab === tab;
      b.setAttribute("aria-selected", String(on));
      b.tabIndex = on ? 0 : -1;
    }
    Lab.layers.closeAll("tab");
    Tip.hide();
    try {
      inst?.destroy?.();
    } catch (err) {
      report("destroy", err);
    }
    inst = null;
    host.innerHTML = "";
    host.dataset.dir = tab;
    host.setAttribute("aria-label", `${tab} · ${TABS[tab].title}`);
    const dir = DIRS[tab];
    if (dir?.mount) {
      try {
        inst = dir.mount(host, api) ?? null;
        inst?.update?.(S);
      } catch (err) {
        report("mount", err);
        inst = null;
        placeholder(tab, true);
      }
    } else placeholder(tab, false);
    $("#notes").innerHTML = notesHtml(tab);
    if (o.animate && motionOn())
      host.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220, easing: "ease-out" });
    history.replaceState(null, "", `${location.search}#${tab}`);
  }

  /* ------------------------------------------------------------ chrome */
  $(".rail .logo").innerHTML = R_LOGO;
  for (const el of $$(".rail-item[data-rail]"))
    el.insertAdjacentHTML("afterbegin", ic(el.dataset.rail));

  const liveBtn = $("#live-btn");
  liveBtn.innerHTML = `<span class="rec"></span><span class="lab-clock"></span>`;
  const clock = $(".lab-clock", liveBtn);
  function paintClock() {
    const d = new Date(S.now);
    const ss = String(d.getSeconds()).padStart(2, "0");
    clock.textContent = `${S.playing ? "Live" : "Paused"} · ${fmt.day(S.now)} · ${fmt.time(S.now)}:${ss}`;
    liveBtn.setAttribute("aria-pressed", String(S.playing));
    liveBtn.dataset.tip = S.playing ? "Pause the simulation" : "Resume the simulation";
    $("#rail-auto").dataset.due = String(S.runs.some((r) => r.status === "pending-approval"));
  }
  liveBtn.addEventListener("click", () => Lab.setPlaying(!S.playing));

  const speedSeg = $("#speed");
  function paintSpeed() {
    for (const b of $$(".seg-opt", speedSeg))
      b.setAttribute("aria-checked", String(Number(b.dataset.speed) === S.speed));
  }
  speedSeg.addEventListener("click", (e) => {
    const b = e.target.closest("[data-speed]");
    if (b) Lab.setSpeed(Number(b.dataset.speed));
  });

  const resetBtn = $("#reset-btn");
  resetBtn.innerHTML = ic("reset");
  resetBtn.addEventListener("click", () => {
    Lab.layers.closeAll("reset");
    Lab.reset();
    setTab(tab);
    toast("Simulation reset to Wed, Oct 7 · 10:42");
  });

  const themeBtn = $("#theme-btn");
  const isDark = () => document.documentElement.classList.contains("dark");
  const paintTheme = () => (themeBtn.innerHTML = ic(isDark() ? "sun" : "moon"));
  themeBtn.addEventListener("click", () => {
    document.documentElement.classList.toggle("dark");
    paintTheme();
    emit();
  });

  const motionBtn = $("#motion-btn");
  function paintMotion() {
    motionBtn.setAttribute("aria-pressed", String(motionOn()));
    motionBtn.textContent = motionOn() ? "Motion on" : "Motion off";
  }
  motionBtn.addEventListener("click", () => {
    Lab.setMotion(!motionOn());
    paintMotion();
  });

  /* Tabs: click, ←/→/Home/End (roving tabindex). */
  const tabs = $("#tabs");
  tabs.addEventListener("click", (e) => {
    const b = e.target.closest("[data-tab]");
    if (b && b.dataset.tab !== tab) setTab(b.dataset.tab, { animate: true });
  });
  tabs.addEventListener("keydown", (e) => {
    const i = ORDER.indexOf(tab);
    const n =
      e.key === "ArrowRight"
        ? (i + 1) % ORDER.length
        : e.key === "ArrowLeft"
          ? (i + ORDER.length - 1) % ORDER.length
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? ORDER.length - 1
              : -1;
    if (n < 0) return;
    e.preventDefault();
    setTab(ORDER[n], { animate: true });
    $(`#tabs [data-tab="${ORDER[n]}"]`).focus();
  });

  $("#tz-hint").innerHTML = `${ic("clock")}Times are local · ${esc(S.tz)}`;

  /* ------------------------------------------------------------ boot */
  if (params.get("theme") === "dark") document.documentElement.classList.add("dark");
  else document.documentElement.classList.remove("dark");
  const advanceBy = Number(params.get("t") ?? 0);
  if (advanceBy > 0) Lab.advance(Math.floor(advanceBy));

  listeners.push(() => {
    paintClock();
    paintSpeed();
    if (!inst?.update) return;
    try {
      inst.update(S);
    } catch (err) {
      report("update", err);
    }
  });

  paintTheme();
  paintMotion();
  paintClock();
  paintSpeed();
  setTab(location.hash.slice(1).toUpperCase() || "A");
  plate(tabs);
  plate(speedSeg);
  Lab.startSim();
  window.addEventListener("hashchange", () => {
    const next = location.hash.slice(1).toUpperCase();
    if (next && next !== tab) setTab(next, { animate: true });
  });
})();
