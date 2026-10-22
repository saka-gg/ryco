// 2 · One-click rail button: the Push button becomes "Ship". Clicking the rail icon itself runs the
// whole chain (with a short Esc-to-cancel grace); hovering explains what the click will do.
const v5css = document.createElement("style");
v5css.textContent = `
  .fly { width: 292px; }
  .rb[data-k="ship"][data-ready="true"] { color: var(--inf-fg); }
  .rb[data-k="ship"][data-ready="true"]::after { content: ""; grid-area: 1 / 1; width: 100%; height: 100%; border-radius: 50%;
    box-shadow: 0 0 0 1.5px color-mix(in srgb, var(--inf) 70%, transparent); animation: breathe 1.8s ease-in-out infinite; pointer-events: none; }
  @keyframes breathe { 50% { box-shadow: 0 0 0 4px color-mix(in srgb, var(--inf) 0%, transparent); } }
  .rb[data-k="ship"] .ring { width: 32px; height: 32px; }
  .lead2 { margin: -4px 0 4px; font: 500 11px var(--mono); color: var(--isl-muted); }
  .click { display: flex; align-items: center; gap: 8px; margin: 12px 0 0; padding: 9px 10px; border-radius: 12px;
    background: color-mix(in srgb, var(--inf) 12%, transparent); color: #c7dcff; font-size: 11.5px; }
  .click .ic { color: var(--inf-fg); }
  .click kbd { margin-left: auto; font: 600 10px var(--sans); padding: 2px 6px; border-radius: 6px; background: rgba(255,255,255,.08); color: var(--isl-muted); }
  .others { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 10px; }
  .others .btn { height: 24px; padding: 0 9px; font-size: 11px; flex: none; }
  .others .btn .ic { width: 12px; height: 12px; }
  .msg { display: flex; align-items: center; gap: 6px; margin-top: 8px; font-size: 11px; color: var(--isl-faint); }
  .msg button { border: 0; background: none; padding: 0; color: var(--inf-fg); font: inherit; cursor: pointer; }
  .msg .field { height: 28px; }
  .done-big { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 14px 0 6px; color: var(--isl-muted); font-size: 12px; text-align: center; }
  .done-big .ic { width: 22px; height: 22px; color: var(--ok-fg); }
`;
document.head.append(v5css);

function shipFly(s) {
  const steps = s.chain ? s.chain.steps : planChain(s);
  const st = stats(s);
  const head = `<div class="dh">${I("rocket", "sm")}<span>Ship</span><span class="meta">${abText(s)}</span></div>
    <div class="lead2 trunc">${BRANCH}</div>`;
  const others = `<div class="others">
      ${btn("go:commit", "Commit only", { icon: "commit", reason: st.files ? null : "Nothing to commit" })}
      ${st.behind ? btn("go:pull", `Pull ↓${st.behind}`, { icon: "cloudDown" }) : ""}
      ${s.pr ? btn("openpr", `PR #${s.pr.number}`, { icon: "ext" }) : ""}
    </div>`;
  if (!steps.length)
    return `${head}<div class="done-big">${I("checkCircle")}<span>Nothing to ship. Everything is on origin${s.pr?.state === "open" ? ` and in PR #${s.pr.number}` : ""}.</span></div>${others}`;
  const counting = s.chain?.counting;
  return `${head}
    <div class="grp"><span>${s.chain ? (counting ? "Starting…" : "Shipping") : "One click will"}</span><span>${steps.length} steps</span></div>
    ${stepChips(steps, s, { vertical: true })}
    ${
      steps.includes("commit") && !s.chain
        ? s.ui.editMsg
          ? `<div class="msg"><input class="field" data-f="msg" placeholder="Commit message" value="${esc(s.ui.msg ?? "")}" /></div>`
          : `<div class="msg">${I("sparkles", "xs")}<span>Commit message is written for you</span><button type="button" data-act="editmsg">Edit</button></div>`
        : ""
    }
    ${
      counting
        ? `<div class="click">${I("loader", "sm spin")}<span>Starting in a moment</span><kbd>Esc cancels</kbd></div>`
        : s.chain
          ? ""
          : `<div class="click">${I("rocket", "sm")}<span>Click the rocket in the rail to ship</span><kbd>1 click</kbd></div>`
    }
    ${s.chain ? "" : others}`;
}

boot({
  tag: "2 · One-click rail button",
  hint: "Click the rocket in the rail to ship (Esc cancels during the short grace) · hover it to see the plan · actions are simulated.",
  primaryKey: "ship",
  chat: "Branch and Push are gone from the rail. The rail ends in one <b>Ship</b> rocket instead. Clicking it runs every step that is left, and hovering it shows exactly which steps those are.",
  rail(s) {
    const steps = planChain(s);
    const glyph = s.chain
      ? ring(s.chain.steps.map((_, i) => (i < s.chain.i ? "done" : i === s.chain.i && !s.chain.counting ? "current" : "q")), { gap: 10 }) + `<span style="display:grid">${I("rocket", "xs")}</span>`
      : steps.length
        ? I("rocket") + badge(steps.length, "info")
        : I("checkCircle");
    return [
      COMMON_RAIL.changes(s),
      COMMON_RAIL.checks(s),
      COMMON_RAIL.plan(s),
      COMMON_RAIL.agents(s),
      COMMON_RAIL.pr(s),
      COMMON_RAIL.notes(s),
      { key: "ship", label: steps.length ? `Ship: ${chainLabel(steps, s)}` : "Nothing to ship", group: "tools", glyph, attrs: `data-k="ship" data-ready="${steps.length > 0 && !s.chain}"` },
    ];
  },
  fly: { ship: shipFly },
  onRailClick(key) {
    if (key !== "ship") return false;
    if (S.chain?.counting) {
      chainCancel = true;
      return true;
    }
    open("ship");
    runChain(planChain(S), { delay: 1500 });
    return true;
  },
  ui(act, s) {
    if (act === "editmsg") {
      s.ui.editMsg = true;
      requestAnimationFrame(() => fly.querySelector('[data-f="msg"]')?.focus());
      return true;
    }
    if (act === "go:commit") {
      runChain(["commit"]);
      return false;
    }
    if (act === "go:pull") {
      runChain(["pull"]);
      return false;
    }
    return false;
  },
});
