// 3 · "Ship to" select: pick how far a click goes (Commit · Push · PR) once; it is remembered.
// The single button then does every step up to there, skipping what is already done.
const v6css = document.createElement("style");
v6css.textContent = `
  .fly { width: 308px; }
  .goal-l { display: flex; align-items: baseline; justify-content: space-between; margin: 0 2px 6px; font-size: 10px; font-weight: 600;
    letter-spacing: .07em; text-transform: uppercase; color: var(--isl-faint); }
  .goal-l small { font: 500 10px var(--sans); letter-spacing: 0; text-transform: none; }
  .seg3 { position: relative; display: grid; grid-template-columns: repeat(3, 1fr); padding: 3px; border-radius: 12px; background: rgba(255,255,255,.05);
    box-shadow: inset 0 0 0 1px rgba(255,255,255,.06); }
  .seg3 .thumb { position: absolute; top: 3px; bottom: 3px; left: 3px; width: calc((100% - 6px) / 3); border-radius: 9px; background: rgba(255,255,255,.12);
    box-shadow: 0 1px 2px rgba(0,0,0,.4); transition: transform .38s var(--ease-spring); }
  .seg3 button { position: relative; z-index: 1; display: flex; align-items: center; justify-content: center; gap: 6px; height: 30px; border: 0; background: none;
    color: var(--isl-muted); font: 500 12px var(--sans); cursor: pointer; transition: color .2s; }
  .seg3 button[aria-pressed="true"] { color: var(--isl-fg); }
  .seg3 button .ic { width: 13px; height: 13px; }
  .track { list-style: none; margin: 12px 0 0; padding: 0; }
  .tr-row { position: relative; display: grid; grid-template-columns: 20px 1fr auto; align-items: center; column-gap: 9px; padding: 5px 2px; }
  .tr-row:not(:last-child)::after { content: ""; position: absolute; left: 11px; top: 25px; height: 12px; width: 2px; border-radius: 1px; background: rgba(255,255,255,.08); }
  .tr-dot { width: 20px; height: 20px; border-radius: 50%; display: grid; place-items: center; border: 1.5px solid rgba(255,255,255,.14); color: var(--isl-faint); }
  .tr-dot .ic { width: 11px; height: 11px; }
  .tr-row b { font-size: 12.5px; font-weight: 500; }
  .tr-row small { font: 500 10.5px var(--mono); color: var(--isl-faint); white-space: nowrap; }
  .tr-row[data-s="run"] .tr-dot { border-color: var(--inf); color: var(--inf-fg); }
  .tr-row[data-s="now"] .tr-dot { border-color: var(--inf); background: color-mix(in srgb, var(--inf) 20%, transparent); color: var(--inf-fg); }
  .tr-row[data-s="did"] .tr-dot, .tr-row[data-s="done"] .tr-dot { border-color: var(--ok); background: var(--ok); color: #04140a; }
  .tr-row[data-s="done"] b { color: var(--isl-muted); }
  .tr-row[data-s="later"] { opacity: .4; }
  .tr-row[data-s="later"] b { text-decoration: line-through; text-decoration-color: rgba(255,255,255,.25); }
  .tr-row[data-s="skip"] b { color: var(--isl-muted); }
  .go { width: 100%; height: 36px; margin-top: 12px; display: flex; align-items: center; justify-content: center; gap: 8px; border: 0; border-radius: 12px;
    background: #f4f4f5; color: #0d0d0e; font: 600 13px var(--sans); cursor: pointer; transition: background .15s, transform .15s, opacity .15s; }
  .go:hover:not([disabled]) { background: #fff; }
  .go:active:not([disabled]) { transform: scale(.985); }
  .go[disabled] { opacity: .5; cursor: default; }
  .go[data-quiet="true"] { background: rgba(255,255,255,.08); color: var(--isl-fg); }
  .go .ic { width: 15px; height: 15px; }
  .opts { display: flex; align-items: center; gap: 12px; margin-top: 9px; font-size: 11px; color: var(--isl-faint); }
  .opts label { display: flex; align-items: center; gap: 5px; cursor: pointer; }
  .opts input { accent-color: #f4f4f5; margin: 0; }
  .opts button { margin-left: auto; border: 0; background: none; padding: 0; color: var(--isl-muted); font: inherit; cursor: pointer; display: inline-flex; gap: 4px; align-items: center; }
  .opts button:hover { color: var(--isl-fg); }
`;
document.head.append(v6css);

const GOAL_META = {
  commit: { label: "Commit", icon: "commit" },
  push: { label: "Push", icon: "cloudUp" },
  pr: { label: "PR", icon: "pr" },
};
/** Every step the track lists, in order, with why it will or won't run. */
function trackRows(s, goal) {
  const steps = s.chain ? s.chain.steps : planChain(s, goal);
  const g = GOALS.indexOf(goal);
  const st = stats(s);
  const rows = [
    { id: "commit", title: "Commit", tier: 0, idle: "nothing to commit" },
    { id: "pull", title: "Pull first", tier: 1, idle: "origin has nothing new", hideIdle: true },
    { id: "push", title: "Push", tier: 1, idle: s.upstream ? "already on origin" : "nothing to push" },
    { id: "pr", title: s.pr?.state === "open" ? `PR #${s.pr.number}` : "Open pull request", tier: 2, idle: s.pr?.state === "open" ? "already open" : "nothing new to propose" },
  ];
  return rows
    .map((r) => {
      const idx = steps.indexOf(r.id);
      let state;
      let detail;
      if (idx >= 0) {
        state = !s.chain ? "run" : idx < s.chain.i ? "did" : idx === s.chain.i ? "now" : "run";
        detail = s.chain?.details?.[idx] ?? stepDetail(r.id, s);
      } else if (r.tier > g) {
        state = "later";
        detail = "not this time";
      } else {
        state = r.id === "pr" && s.pr?.state === "open" ? "done" : r.id === "push" && s.upstream && !st.ahead ? "done" : "skip";
        detail = r.idle;
        if (r.hideIdle) return "";
      }
      const icon = state === "did" || state === "done" ? I("check") : state === "now" ? I("loader", "spin") : I(STEP[r.id].icon);
      return `<li class="tr-row" data-s="${state}"><span class="tr-dot">${icon}</span><b>${r.title}</b><small>${detail}</small></li>`;
    })
    .join("");
}

function shipToFly(s) {
  const goal = s.ui.goal ?? defaultGoal(s);
  const steps = s.chain ? s.chain.steps : planChain(s, goal);
  const running = !!s.chain;
  const gi = GOALS.indexOf(goal);
  const quiet = !steps.length;
  const label = running
    ? `${STEP[steps[s.chain.i]]?.verb ?? "Starting"}… ${s.chain.i + 1}/${steps.length}`
    : quiet
      ? s.pr?.state === "open"
        ? `View PR #${s.pr.number}`
        : `Already at ${GOAL_META[goal].label}`
      : chainLabel(steps, s);
  return `
    <div class="dh">${I("branch", "sm")}<span class="mono trunc">${BRANCH}</span><span class="meta">${abText(s)}</span></div>
    <div class="goal-l"><span>Ship to</span><small>${s.ui.goal ? "remembered for this project" : "suggested"}</small></div>
    <div class="seg3" role="radiogroup" aria-label="Ship to">
      <span class="thumb" style="transform:translateX(${gi * 100}%)"></span>
      ${GOALS.map((g) => `<button type="button" role="radio" data-act="goal:${g}" aria-pressed="${g === goal}" ${running ? "disabled" : ""}>${I(GOAL_META[g].icon)}${GOAL_META[g].label}</button>`).join("")}
    </div>
    <ol class="track">${trackRows(s, goal)}</ol>
    <button type="button" class="go" data-act="ship" data-quiet="${quiet && !running}" ${running || (quiet && s.pr?.state !== "open") ? "disabled" : ""}>
      ${running ? I("loader", "spin") : quiet ? I(s.pr?.state === "open" ? "ext" : "checkCircle") : I("rocket")}<span class="trunc">${label}</span>
    </button>
    <div class="opts">
      ${goal === "pr" ? `<label><input type="checkbox" data-f="draft" ${s.ui.draft ? "checked" : ""}/>Draft PR</label>` : ""}
      ${steps.includes("commit") ? `<span>${I("sparkles", "xs")} message written for you</span>` : ""}
    </div>`;
}

boot({
  tag: "3 · Ship to…",
  hint: "Pick how far a click goes, then press the one button · the list shows what runs, what's done and what's skipped · actions are simulated.",
  primaryKey: "git",
  chat: "One <b>Source control</b> item replaces Branch and Push. You choose once how far a click goes (<b>Commit</b>, <b>Push</b> or <b>PR</b>), and the single button then does every step up to there.",
  rail(s) {
    const st = stats(s);
    const glyph = s.chain
      ? ring(s.chain.steps.map((_, i) => (i < s.chain.i ? "done" : i === s.chain.i ? "current" : "q")), { gap: 10 }) + `<span style="display:grid">${I("branch", "xs")}</span>`
      : I("branch") + (st.files ? badge(st.files) : st.ahead ? badge(`↑${st.ahead}`, "info") : st.behind ? badge(`↓${st.behind}`, "warn") : "");
    return [
      { key: "git", label: "Source control", group: "status", glyph },
      COMMON_RAIL.changes(s),
      COMMON_RAIL.checks(s),
      COMMON_RAIL.plan(s),
      COMMON_RAIL.agents(s),
      COMMON_RAIL.pr(s),
      COMMON_RAIL.notes(s),
    ];
  },
  fly: { git: shipToFly },
  ui(act, s) {
    if (act.startsWith("goal:")) {
      s.ui.goal = act.slice(5);
      return true;
    }
    if (act === "ship") {
      const steps = planChain(s, s.ui.goal ?? defaultGoal(s));
      if (steps.length) runChain(steps);
      else if (s.pr?.state === "open") run("openpr");
      return false;
    }
    return false;
  },
});
// The chosen goal outlives a scenario switch, the way a per-project preference would.
let savedGoal = null;
const v6ui = V.ui;
V.ui = (act, s) => {
  if (act.startsWith("goal:")) savedGoal = act.slice(5);
  return v6ui(act, s);
};
const v6load = load;
load = (key) => {
  v6load(key);
  if (savedGoal) {
    S.ui.goal = savedGoal;
    renderAll();
  }
};
