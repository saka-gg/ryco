/* ============================================================
   Lab shell: tabs, stage, main pane, notes, controls, clock.
   ============================================================ */
const NOTES = {
  T: {
    title: "0 · Today",
    thesis: "The row as it ships in InboxSidebar.tsx, kept here as the baseline.",
    blocks: [
      [
        "At rest",
        [
          "4 lines: project · machine · time / title / ● status | branch | agent / PR badge.",
          "Status costs a word and a divider on every row, even “Idle”.",
          "Every fact is always visible, so nothing stands out.",
        ],
      ],
      [
        "Hover & popup",
        [
          "Row lifts 1px; Settle + ⋯ fade in over the time.",
          "Popup repeats the row as a list: project, machine, branch, agent, PR.",
        ],
      ],
    ],
  },
  A: {
    title: "A · Glyph",
    thesis:
      "Status shrinks to a 14px glyph with the project icon under it. The second line shows the one thing that matters for that state, and never tool calls or reasoning.",
    blocks: [
      [
        "At rest · 2 lines",
        [
          "<b>Line 1</b> glyph · title, using the full width",
          "<b>Line 2</b> project icon (under the glyph) · state line · #PR · time",
          "State line: <b>Needs input</b> shows the ask, <b>Error</b> the reason, <b>Done</b> the diff, and <b>Working</b> or <b>Idle</b> the branch. The spinner and ticking time already say it's running.",
          "<b>Settled</b> rows are one line: project icon · title · time. The header already says Settled, so there's no check.",
          "The machine is shown only when it isn't this Mac. The agent moves to the card and the project tooltip.",
          "Color means it's on you: amber needs input, green is done but unread, red is an error. Motion means it's running. Grey means nothing to do.",
        ],
      ],
      [
        "Hover · popover · tooltips",
        [
          "One shared highlight glides between rows. ✓ and ⋯ fade in with a stagger over the end of the title, which re-truncates to make room.",
          "Hold still for about half a second and a card slides out of the sidebar edge. Moving to another row glides the card with you, and the content rolls in the direction you moved.",
          "The card has the state, the actionable block (approval, question, error) or the final message, then project / branch, machine / model and PR + checks + diff. No step trail.",
          "You can Approve, Deny, Retry and Answer right in the card.",
          "Hovering a precise target (glyph, time, PR, agent) shows a tooltip, not the card. Tooltips glide between targets once one is open.",
        ],
      ],
      [
        "Settle",
        [
          "The glyph morphs into a check, the title strikes through, and the row slides out. Undo appears as a toast. With Settled expanded, the check turns into the project icon.",
        ],
      ],
    ],
  },
  B: {
    title: "B · Lanes",
    thesis: "The lane says the state, the row says the task, and the dock says the rest.",
    blocks: [
      [
        "At rest",
        [
          "Lanes: <b>Needs you</b> · <b>Running</b> · <b>Done</b> · <b>Idle</b>, with Snoozed and Settled folded. Rows never repeat their state.",
          "Resting rows are one line: project icon · title · time. Branch, agent, PR and checks live in the dock.",
          "Only live rows get a second line: the ask as a button, the error with Retry, or the current step with a progress sweep.",
        ],
      ],
      [
        "Hover · popover · tooltips",
        [
          "A notch in the lane's color grows in, and the actions wipe in from the right.",
          "The dock at the bottom rolls to the hovered task (project / branch, agent, machine, PR + checks). It returns to your selection when you leave.",
          "Clicking an ask drops the approval popover from the chip: Deny, Approve, or always allow.",
          "Lane glyphs and times have tooltips.",
        ],
      ],
      [
        "Motion",
        [
          "When a state changes, rows FLIP between lanes and the lane counts roll.",
          "Settle: a green wash sweeps across the row before it leaves.",
        ],
      ],
    ],
  },
  C: {
    title: "C · Avatars",
    thesis:
      "Status is a ring around the project avatar, and the agent is a badge on it. Order follows attention.",
    blocks: [
      [
        "At rest · 2 lines",
        [
          "Ring: <b>Working</b> sweeps, <b>Needs input</b> breathes amber, <b>Done</b> is green, <b>Error</b> is red, Idle has no ring.",
          "Line 2 is the state line, or the last message when resting. Unread shows as a bold title plus a dot.",
          "Order: needs input → error → done → working → idle. No state headers are needed.",
        ],
      ],
      [
        "Hover · popover · tooltips",
        [
          "The avatar lifts and line 2 rolls to branch · PR · machine. Actions fade in over the end of the title.",
          "Clicking the avatar springs out an agent card from it, with the full step timeline and quick actions.",
          "The ring and the agent badge have tooltips.",
        ],
      ],
      [
        "Settle",
        ["The ring closes and the avatar flies into the Settled stack, which fans out on hover."],
      ],
    ],
  },
};
const MOTION_SPEC = [
  "Travel: --ease (0.16, 1, 0.3, 1). Controls: --snappy (0.3, 1.36, 0.44, 1).",
  "Tooltip waits 420ms, then glides between targets in about 30ms. The card waits 560ms, then glides in 120ms.",
  "Reorder uses FLIP over 520ms. Enter and exit collapse height over 360ms.",
  "Everything animates transform and opacity only, and the Motion switch zeroes it.",
];

let tab = "A";
let mounted = [];
let measureInst = null;

function renderPane(paneEl) {
  const t = T(S.selected);
  const box = paneEl.querySelector(".pane-live");
  if (!t) {
    patchLive(box, `<p class="dim">Select a task.</p>`, "none");
    return;
  }
  const block =
    ["input", "error", "working", "connecting"].includes(t.state) && !t.settled
      ? stateBlock(t, { full: true })
      : "";
  patchLive(
    box,
    `<div class="p-crumb">${fav(t.project)}<span>${esc(PROJECTS[t.project].name)}</span><span class="sep">/</span>${ic(t.worktree ? "fork" : "branch")}<span class="mono">${esc(t.branch)}</span></div>
     <h2 class="p-title">${esc(t.title)}</h2>
     <div class="p-state st-${gstate(t)}">${glyph(t)}<span>${stateLabel(t)}</span><span class="sep">·</span><span class="dim" data-live="t">${timeTip(t)}</span></div>
     <div class="p-msg"><span class="p-av">${PROV_SVG[t.provider]}</span><p>${esc(t.last)}</p></div>
     ${block ? `<div class="p-block">${block}</div>` : ""}`,
    t.id + "|" + cardKey(t),
  );
}
function notesHtml(id) {
  const n = NOTES[id];
  return `<h2>${n.title}</h2><p class="thesis">${n.thesis}</p>
    <div class="metric" id="metric"></div>
    ${n.blocks.map(([head, items]) => `<h3>${head}</h3><ul>${items.map((x) => `<li>${x}</li>`).join("")}</ul>`).join("")}
    <h3>Motion</h3><ul>${MOTION_SPEC.map((x) => `<li>${x}</li>`).join("")}</ul>`;
}
function rowHeights(inst) {
  const hs = [];
  for (const [k, el] of inst.els)
    if (k.startsWith("r:") && !el._exiting && !el.classList.contains("compact"))
      hs.push(el.offsetHeight);
  return hs;
}
function updateMetric() {
  const m = document.getElementById("metric");
  if (!m || !mounted[0] || !measureInst) return;
  const a = rowHeights(mounted[0]);
  const b = rowHeights(measureInst);
  if (!a.length || !b.length) return;
  const sum = (x) => x.reduce((p, c) => p + c, 0);
  const avg = Math.round(sum(a) / a.length);
  const avgT = Math.round(sum(b) / b.length);
  const delta = Math.round((1 - sum(a) / sum(b)) * 100);
  const html =
    mounted[0].dirId === "T"
      ? `<div><strong>${avg}px</strong><span>avg row</span></div><div><strong>${sum(a)}px</strong><span>${a.length} open tasks</span></div>`
      : `<div><strong>${avg}px</strong><span>avg row · today ${avgT}px</span></div><div><strong class="${delta > 0 ? "good" : ""}">${delta > 0 ? "−" : "+"}${Math.abs(delta)}%</strong><span>list height vs today</span></div>`;
  if (m.innerHTML !== html) m.innerHTML = html;
}

function setTab(next) {
  tab = next;
  Card.close();
  Pop.close();
  Menu.close();
  for (const inst of mounted) unmount(inst);
  mounted = [];
  for (const b of document.querySelectorAll("#tabs .seg-opt"))
    b.setAttribute("aria-selected", String(b.dataset.tab === tab));
  const stage = document.getElementById("stage");
  stage.innerHTML = "";
  if (tab === "compare") {
    stage.className = "stage-compare";
    for (const id of ["T", "A", "B", "C"]) {
      const col = h("div", "cmp-col", `<div class="cmp-cap"><b>${NOTES[id].title}</b></div>`);
      const frame = h("div", "frame");
      col.append(frame);
      stage.append(col);
      mounted.push(mount(frame, id));
    }
  } else {
    stage.className = "stage-single";
    const frame = h("div", "frame");
    const pane = h(
      "section",
      "pane",
      `<div class="pane-scroll"><div class="live-box pane-live"></div></div>`,
    );
    const notes = h("aside", "notes", notesHtml(tab));
    stage.append(frame, notes);
    mounted.push(mount(frame, tab));
    frame.append(pane);
    renderPane(pane);
  }
  lastInst = mounted[0];
  requestAnimationFrame(updateMetric);
  history.replaceState(null, "", "#" + tab);
}
listeners.push(() => {
  const pane = document.querySelector(".pane");
  if (pane) renderPane(pane);
  updateMetric();
});

/* ------------------------------------------------------------ controls */
const liveBtn = document.getElementById("live-btn");
function paintLive() {
  liveBtn.setAttribute("aria-pressed", String(S.playing));
  liveBtn.innerHTML = `<span class="rec"></span>${S.playing ? "Live" : "Paused"}<span class="dim tnum" id="simt">${S.simT}s</span>`;
}
liveBtn.addEventListener("click", () => {
  S.playing = !S.playing;
  paintLive();
});
const resetBtn = document.getElementById("reset-btn");
resetBtn.innerHTML = ic("reset");
resetBtn.addEventListener("click", () => {
  S.threads = INIT();
  S.selected = "t1";
  S.now = NOW0;
  S.simT = 0;
  S.settledOpen = false;
  S.snoozedOpen = false;
  setTab(tab);
  paintLive();
});
const themeBtn = document.getElementById("theme-btn");
const paintTheme = () =>
  (themeBtn.innerHTML = ic(document.documentElement.classList.contains("dark") ? "sun" : "moon"));
themeBtn.addEventListener("click", () => {
  document.documentElement.classList.toggle("dark");
  paintTheme();
});
const motionBtn = document.getElementById("motion-btn");
function paintMotion() {
  document.documentElement.dataset.motion = motion ? "on" : "off";
  motionBtn.setAttribute("aria-pressed", String(motion));
  motionBtn.textContent = motion ? "Motion on" : "Motion off";
}
motionBtn.addEventListener("click", () => {
  motion = !motion;
  paintMotion();
});
for (const b of document.querySelectorAll("#width-seg .seg-opt"))
  b.addEventListener("click", () => {
    for (const x of document.querySelectorAll("#width-seg .seg-opt"))
      x.setAttribute("aria-checked", String(x === b));
    document.documentElement.style.setProperty("--sbw", b.dataset.w + "px");
    emit();
  });
for (const b of document.querySelectorAll("#tabs .seg-opt"))
  b.addEventListener("click", () => setTab(b.dataset.tab));

/* ------------------------------------------------------------ boot */
const params = new URLSearchParams(location.search);
if (params.get("theme") === "light") document.documentElement.classList.remove("dark");
if (params.get("paused") === "1") S.playing = false;
paintTheme();
paintMotion();
paintLive();
measureInst = mount(document.getElementById("measure"), "T", { hidden: true });
const initial = location.hash.slice(1);
setTab(["T", "A", "B", "C", "compare"].includes(initial) ? initial : "A");
setInterval(() => {
  if (!S.playing) return;
  tick();
  emit();
  const el = document.getElementById("simt");
  if (el) el.textContent = S.simT + "s";
}, 1000);
