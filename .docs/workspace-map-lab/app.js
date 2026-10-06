/* ============================================================
   Lab shell: the projects page frame (rail · project list · bar),
   direction tabs, notes, controls and the simulation clock.

   Direction contract (dir-*.js):
     DIRS.X = {
       title, thesis, notes: [[heading, [items…]], …],
       mount(host, api) → { update(S), destroy() }
     }
   host: the canvas area under the bar (position: relative, fills).
   api.select(sel | null)  → S.selected = { kind, id }, emits
   api.project()           → current project; index() gives flat lookups
   update(S) runs on every change: project switch, selection, sim tick.
   ============================================================ */
let tab = "A";
let inst = null;
let mapHost = null;

const api = {
  select(sel) {
    const same = sel && S.selected && sel.kind === S.selected.kind && sel.id === S.selected.id;
    S.selected = same ? null : sel;
    emit();
  },
  project,
  /* Report something the reader did (Approve, Check out…) in the bar. */
  notify(label) {
    lastEvent = label;
    paintEvent();
  },
};

function avatar(p) {
  return `<span class="pav" style="--hue:${p.hue}">${esc(p.name[0].toUpperCase())}</span>`;
}

function renderList() {
  const rows = $(".plist-rows");
  if (!rows) return;
  rows.innerHTML = S.projects
    .map((p) => {
      const devices = [...new Set(p.checkouts.map((c) => c.device))];
      return `<button class="prow" type="button" data-project="${p.id}" aria-current="${p.id === S.projectId}">
        ${avatar(p)}
        <span class="pname">${esc(p.name)}</span>
        <span class="pdev">${devices.map((d) => `<span data-tip="${esc(DEVICES[d].name)}">${deviceIcon(d)}</span>`).join("")}</span>
        <span class="psub trunc">${esc(p.repo ?? p.checkouts[0].path)}</span>
      </button>`;
    })
    .join("");
}

function renderBar() {
  const p = project();
  $(".dbar-title").textContent = p.name;
  $(".dbar-repo").textContent = p.repo ?? "Local folder";
}

function notesHtml(id) {
  const d = DIRS[id];
  if (!d) return "";
  return `<div class="notes notes-grid">
    <div><h2>${esc(d.title)}</h2><p class="thesis">${d.thesis}</p></div>
    ${(d.notes ?? []).map(([head, items]) => `<div><h3>${head}</h3><ul>${items.map((x) => `<li>${x}</li>`).join("")}</ul></div>`).join("")}
  </div>`;
}

function setTab(next) {
  tab = DIRS[next] ? next : "A";
  for (const b of $$("#tabs .seg-opt"))
    b.setAttribute("aria-selected", String(b.dataset.tab === tab));
  inst?.destroy?.();
  inst = null;
  S.selected = null;
  const stage = $("#stage");
  stage.innerHTML = `
    <div class="app">
      <nav class="rail" aria-hidden="true">
        <span class="logo">${R_LOGO}</span>
        <i>${ic("msg")}</i><i class="on">${ic("folder")}</i><i>${ic("pr")}</i><i>${ic("layers")}</i>
      </nav>
      <aside class="plist">
        <div class="plist-head"><div class="plist-filter">${ic("search")}Filter projects</div></div>
        <div class="plist-rows"></div>
      </aside>
      <section class="detail">
        <header class="dbar">
          <span class="dbar-title"></span><span class="dbar-repo"></span>
          <span class="dbar-sp"></span>
          <span class="event" id="event"></span>
        </header>
        <div class="map" data-dir="${tab}"></div>
      </section>
    </div>
    ${notesHtml(tab)}`;
  mapHost = $(".map", stage);
  renderList();
  renderBar();
  inst = DIRS[tab]?.mount(mapHost, api) ?? null;
  inst?.update(S);
  history.replaceState(null, "", location.search + "#" + tab);
}

document.addEventListener("click", (e) => {
  const row = e.target.closest("[data-project]");
  if (!row || row.dataset.project === S.projectId) return;
  S.projectId = row.dataset.project;
  S.selected = null;
  renderList();
  renderBar();
  emit();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && S.selected) {
    S.selected = null;
    emit();
  }
});
listeners.push(() => {
  renderList();
  inst?.update(S);
});

/* ------------------------------------------------------------ controls */
const liveBtn = $("#live-btn");
function paintLive() {
  liveBtn.setAttribute("aria-pressed", String(S.playing));
  liveBtn.innerHTML = `<span class="rec"></span>${S.playing ? "Live" : "Paused"}<span class="dim tnum">${S.simT % LOOP}s</span>`;
}
liveBtn.addEventListener("click", () => {
  S.playing = !S.playing;
  paintLive();
});
const resetBtn = $("#reset-btn");
resetBtn.innerHTML = ic("reset");
resetBtn.addEventListener("click", () => {
  resetData();
  S.simT = 0;
  lastEvent = null;
  setTab(tab);
  paintLive();
});
const themeBtn = $("#theme-btn");
const paintTheme = () =>
  (themeBtn.innerHTML = ic(document.documentElement.classList.contains("dark") ? "sun" : "moon"));
themeBtn.addEventListener("click", () => {
  document.documentElement.classList.toggle("dark");
  paintTheme();
  emit();
});
const motionBtn = $("#motion-btn");
function paintMotion() {
  document.documentElement.dataset.motion = motion ? "on" : "off";
  motionBtn.setAttribute("aria-pressed", String(motion));
  motionBtn.textContent = motion ? "Motion on" : "Motion off";
}
motionBtn.addEventListener("click", () => {
  motion = !motion;
  paintMotion();
});
for (const b of $$("#tabs .seg-opt")) b.addEventListener("click", () => setTab(b.dataset.tab));

function paintEvent() {
  const el = $("#event");
  if (!el) return;
  if (!lastEvent || lastEvent === "loop") {
    el.innerHTML = "";
    return;
  }
  el.innerHTML = `<span class="rec"></span>${esc(lastEvent)}`;
  if (motion)
    el.animate(
      [
        { opacity: 0, translate: "0 6px" },
        { opacity: 1, translate: "0 0" },
      ],
      { duration: 320, easing: EASE },
    );
}

/* ------------------------------------------------------------ boot
   ?theme=light  ?paused=1  ?t=N (advance N seconds)  ?project=id
   ?select=kind:id  #A..#D */
const params = new URLSearchParams(location.search);
if (params.get("theme") === "light") document.documentElement.classList.remove("dark");
if (params.get("paused") === "1") S.playing = false;
if (params.get("motion") === "off") motion = false;
if (params.get("project")) S.projectId = params.get("project");
for (let i = 0, n = Number(params.get("t") ?? 0); i < n; i++) tick();
paintTheme();
paintMotion();
paintLive();
setTab(location.hash.slice(1) || "A");
if (params.get("select")) {
  const [kind, id] = params.get("select").split(":");
  setTimeout(() => api.select({ kind, id }), 50);
}
setInterval(() => {
  if (!S.playing) return;
  const before = lastEvent;
  tick();
  emit();
  paintLive();
  if (lastEvent !== before || S.simT % LOOP === 0) paintEvent();
}, 1000);
