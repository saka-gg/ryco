// 1 · Smart button: the existing split button, grown up. One label that already knows the whole chain,
// chips that say what the click will do, and the ▾ menu for the other choices.
const v4css = document.createElement("style");
v4css.textContent = `
  .fly { width: 316px; overflow: visible; }
  .say { margin: -4px 0 12px; font-size: 12px; color: var(--isl-muted); }
  .say b { color: var(--isl-fg); font-weight: 500; }
  .sb { position: relative; display: flex; height: 36px; border-radius: 12px; overflow: visible; }
  .sb-main { flex: 1; min-width: 0; display: flex; align-items: center; justify-content: center; gap: 8px; border: 0; cursor: pointer;
    border-radius: 12px 0 0 12px; background: #f4f4f5; color: #0d0d0e; font: 600 13px var(--sans); transition: background .15s, transform .15s; }
  .sb-main:hover:not([disabled]) { background: #fff; }
  .sb-main:active:not([disabled]) { transform: scale(.985); }
  .sb-main[disabled] { cursor: default; }
  .sb-main[data-quiet="true"] { background: rgba(255,255,255,.08); color: var(--isl-fg); }
  .sb-main .ic { width: 15px; height: 15px; }
  .sb-more { width: 36px; display: grid; place-items: center; border: 0; border-left: 1px solid rgba(0,0,0,.18); cursor: pointer;
    border-radius: 0 12px 12px 0; background: #e4e4e7; color: #0d0d0e; transition: background .15s; }
  .sb-more:hover { background: #fff; }
  .sb[data-quiet="true"] .sb-more { background: rgba(255,255,255,.08); color: var(--isl-fg); border-left-color: rgba(255,255,255,.08); }
  .sb-more .ic { transition: transform .2s var(--ease-out); }
  .sb-more[aria-expanded="true"] .ic { transform: rotate(180deg); }
  .sb-fill { position: absolute; left: 0; bottom: 0; height: 2px; border-radius: 2px; background: var(--inf); transition: width .6s var(--ease-out); }
  .menu { position: absolute; top: calc(100% + 6px); right: 0; left: 0; z-index: 3; padding: 5px; border-radius: 14px; background: #18181b;
    border: 1px solid rgba(255,255,255,.1); box-shadow: 0 18px 40px -10px rgba(0,0,0,.7); animation: fly-in .2s var(--ease-out); }
  .mi { display: grid; grid-template-columns: 18px 1fr auto; align-items: center; column-gap: 8px; width: 100%; padding: 7px 8px; border: 0;
    border-radius: 9px; background: none; color: var(--isl-fg); text-align: left; cursor: pointer; }
  .mi:hover:not([disabled]) { background: rgba(255,255,255,.07); }
  .mi[disabled] { opacity: .38; cursor: default; }
  .mi .ic { color: var(--isl-muted); }
  .mi b { font-size: 12.5px; font-weight: 500; }
  .mi small { grid-column: 2; font-size: 11px; color: var(--isl-faint); }
  .mi kbd { grid-row: span 2; font: 600 9.5px var(--sans); padding: 2px 6px; border-radius: 6px; background: color-mix(in srgb, var(--inf) 20%, transparent); color: var(--inf-fg); }
  .msep { height: 1px; margin: 4px 6px; background: rgba(255,255,255,.07); }
  .mlab { padding: 6px 8px 3px; font-size: 10px; font-weight: 600; letter-spacing: .07em; text-transform: uppercase; color: var(--isl-faint); }
  .msg { display: flex; align-items: center; gap: 6px; margin-top: 10px; font-size: 11px; color: var(--isl-faint); }
  .msg button { border: 0; background: none; padding: 0; color: var(--inf-fg); font: inherit; cursor: pointer; }
  .msg .field { height: 28px; }
`;
document.head.append(v4css);

function sayStatus(s) {
  const st = stats(s);
  const bits = [];
  if (st.files) bits.push(`<b>${plural(st.files, "file")}</b> changed`);
  if (st.behind) bits.push(`<b>${st.behind} new</b> on origin`);
  if (st.ahead) bits.push(`<b>${plural(st.ahead, "commit")}</b> not pushed`);
  else if (!s.upstream) bits.push("branch not pushed");
  if (s.pr?.state === "open") bits.push(`PR <b>#${s.pr.number}</b> open`);
  else if (s.pr?.state === "merged") bits.push(`PR #${s.pr.number} merged`);
  else bits.push("no PR yet");
  return bits.join(" · ");
}

function menuItem(goalOrAct, icon, title, sub, steps, s) {
  const disabled = !steps.length || s.busy;
  const isDefault = goalOrAct === (s.ui.goal ?? defaultGoal(s));
  return `<button type="button" class="mi" data-act="go:${goalOrAct}" ${disabled ? "disabled" : ""}>${I(icon, "sm")}<b>${title}</b>${isDefault && steps.length ? "<kbd>default</kbd>" : "<span></span>"}<small>${steps.length ? sub : "nothing to do"}</small></button>`;
}

function smartFly(s) {
  const goal = s.ui.goal ?? defaultGoal(s);
  const steps = s.chain ? s.chain.steps : planChain(s, goal);
  const running = !!s.chain;
  const quiet = !steps.length;
  const label = running ? `${STEP[steps[s.chain.i]]?.verb ?? "Starting"}… ${s.chain.i + 1}/${steps.length}` : chainLabel(steps, s);
  const icon = running ? I("loader", "spin") : quiet ? I(s.pr?.state === "open" ? "ext" : "checkCircle") : I(STEP[steps.at(-1)].icon);
  const fill = running ? ((s.chain.i + 0.5) / steps.length) * 100 : 0;
  const st = stats(s);
  return `
    <div class="dh">${I("branch", "sm")}<span class="mono trunc">${BRANCH}</span><span class="meta">${abText(s)}</span></div>
    <div class="say">${sayStatus(s)}</div>
    <div class="sb" data-quiet="${quiet && !running}">
      <button type="button" class="sb-main" data-act="ship" data-quiet="${quiet && !running}" ${running || (quiet && !s.pr) ? "disabled" : ""}>${icon}<span class="trunc">${label}</span></button>
      <button type="button" class="sb-more" data-act="menu" aria-label="More git actions" aria-expanded="${!!s.ui.menu}" ${running ? "disabled" : ""}>${I("chevronDown", "sm")}</button>
      ${running ? `<span class="sb-fill" style="width:${fill}%"></span>` : ""}
      ${
        s.ui.menu
          ? `<div class="menu">
            <div class="mlab">Do it in one click</div>
            ${menuItem("commit", "commit", "Commit only", plural(st.files, "file"), planChain(s, "commit"), s)}
            ${menuItem("push", "cloudUp", chainLabel(planChain(s, "push"), s).replace(/^Up to date$/, "Commit & push"), "to origin/" + BRANCH, planChain(s, "push"), s)}
            ${menuItem("pr", "pr", chainLabel(planChain(s, "pr"), s).replace(/^(Up to date|View PR #\d+)$/, "Commit, push & create PR"), "into main", planChain(s, "pr"), s)}
            <div class="msep"></div>
            <button type="button" class="mi" data-act="go:pull" ${st.behind ? "" : "disabled"}>${I("cloudDown", "sm")}<b>Pull</b><span></span><small>${st.behind ? `${st.behind} incoming` : "up to date"}</small></button>
            ${s.pr ? `<button type="button" class="mi" data-act="openpr">${I("ext", "sm")}<b>View PR #${s.pr.number}</b><span></span><small>${s.pr.state}</small></button>` : ""}
          </div>`
          : ""
      }
    </div>
    ${steps.length ? stepChips(steps, s) : ""}
    ${
      steps.includes("commit") && !running
        ? s.ui.editMsg
          ? `<div class="msg"><input class="field" data-f="msg" data-submit="ship" placeholder="Commit message" value="${esc(s.ui.msg ?? "")}" /></div>`
          : `<div class="msg">${I("sparkles", "xs")}<span>Message is written for you</span><button type="button" data-act="editmsg">Edit</button></div>`
        : ""
    }`;
}

boot({
  tag: "1 · Smart button",
  hint: "Hover the rail · the button picks the whole chain for you · ▾ shows the other one-click options · actions are simulated.",
  primaryKey: "git",
  chat: "One <b>Source control</b> item replaces Branch and Push. Its button already knows the full chain, so one click commits, pushes and opens the PR. The chips show what will happen and fill in as it runs.",
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
  fly: { git: smartFly },
  ui(act, s) {
    if (act === "menu") {
      s.ui.menu = !s.ui.menu;
      return true;
    }
    if (act === "editmsg") {
      s.ui.editMsg = true;
      requestAnimationFrame(() => fly.querySelector('[data-f="msg"]')?.focus());
      return true;
    }
    if (act === "ship") {
      runChain(planChain(s, s.ui.goal ?? defaultGoal(s)));
      return false;
    }
    if (act.startsWith("go:")) {
      const goal = act.slice(3);
      s.ui.menu = false;
      runChain(goal === "pull" ? ["pull"] : planChain(s, goal));
      return false;
    }
    return false;
  },
});
