// A · Ship panel: Branch + Push merge into one "Source control" item with a stat strip and a 2×2 action grid.
const v1css = document.createElement("style");
v1css.textContent = `
  .fly { width: 316px; }
  .tiles { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; margin: 2px 0 10px; }
  .tile { display: flex; flex-direction: column; gap: 1px; min-width: 0; padding: 8px 9px; border-radius: 12px;
    background: rgba(255,255,255,.035); box-shadow: inset 0 0 0 1px rgba(255,255,255,.05); }
  .tile .tl { font-size: 10px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--isl-faint); }
  .tile .tv { font-size: 13px; font-weight: 600; white-space: nowrap; }
  .tile .ts { display: flex; align-items: center; gap: 4px; font: 500 10.5px var(--mono); color: var(--isl-muted); white-space: nowrap; overflow: hidden; }
  .tile[data-tone="open"] .tv { color: var(--ok-fg); }
  .tile[data-tone="merged"] .tv { color: var(--merged); }
  .tile[data-tone="warn"] .tv { color: var(--warn-fg); }
  .tile[data-tone="info"] .tv { color: var(--inf-fg); }
  .upl { display: flex; gap: 4px; align-items: baseline; margin: -6px 0 10px 21px; font-size: 11px; min-width: 0; }
  .upl > * { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .agrid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
  .gb { display: grid; grid-template-columns: auto 1fr; grid-template-rows: auto auto; column-gap: 8px; align-items: center;
    text-align: left; padding: 8px 10px; border-radius: 14px; border: 1px solid rgba(255,255,255,.08); background: rgba(255,255,255,.05);
    color: var(--isl-fg); cursor: pointer; transition: background .15s, transform .15s, opacity .15s, box-shadow .2s; }
  .gb:hover:not([disabled]) { background: rgba(255,255,255,.1); }
  .gb:active:not([disabled]) { transform: scale(.98); }
  .gb .ic { grid-row: span 2; width: 16px; height: 16px; color: var(--isl-muted); }
  .gb b { font-size: 12.5px; font-weight: 600; white-space: nowrap; }
  .gb small { font: 500 10.5px var(--mono); color: var(--isl-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .gb[disabled] { opacity: .4; cursor: not-allowed; }
  .gb.primary { background: #f4f4f5; color: #0d0d0e; border-color: transparent; box-shadow: 0 6px 20px -8px rgba(255,255,255,.35); }
  .gb.primary .ic, .gb.primary small { color: #3f3f46; }
  .gb.primary:hover:not([disabled]) { background: #fff; }
  .gb:focus-visible { outline: 2px solid var(--inf-fg); outline-offset: 2px; }
  .crow { display: flex; gap: 6px; margin: 0 0 8px; animation: fly-in .25s var(--ease-out); }
  .crow .field { flex: 1; }
  .nextl { display: flex; align-items: center; gap: 6px; margin: 10px 2px 0; font-size: 11px; color: var(--isl-faint); }
  .nextl b { color: var(--isl-muted); font-weight: 500; }
  .nextl .ic { color: var(--ok-fg); }
  .icbtn { display: grid; place-items: center; width: 22px; height: 22px; border-radius: 50%; border: 0; background: transparent; color: var(--isl-faint); cursor: pointer; }
  .icbtn:hover { background: rgba(255,255,255,.08); color: var(--isl-fg); }
`;
document.head.append(v1css);

function gridButton(act, icon, label, sub, { primary, reason }) {
  const busy = S.busy && (S.busy === act || (act === "commit-open" && S.busy === "commit"));
  const disabled = reason || (S.busy && !busy);
  return `<button type="button" class="gb ${primary && !reason ? "primary" : ""}" data-act="${act}" ${disabled ? "disabled" : ""} title="${esc(reason ?? label)}">
    ${busy ? I("loader", "spin") : I(icon)}<b>${esc(busy ? `${ACTIONS[S.busy]?.verb ?? label}…` : label)}</b><small>${reason ? esc(reason) : sub}</small></button>`;
}

function shipPanel(s) {
  const st = stats(s);
  const r = reasons(s);
  const nx = nextStep(s);
  const c = checksOf(s);
  const pr = s.pr;
  const isNext = (act) => nx !== null && !nx.passive && nx.act === act;

  const prTile = pr
    ? `<div class="tile" data-tone="${pr.state}"><span class="tl">PR</span><span class="tv">#${pr.number}</span><span class="ts">${pr.state === "merged" ? "merged" : miniChecks(s)}</span></div>`
    : `<div class="tile"><span class="tl">PR</span><span class="tv muted">None</span><span class="ts">${s.branchCommits ? "ready" : "—"}</span></div>`;

  const prButton = pr
    ? gridButton("openpr", pr.state === "merged" ? "merge" : "pr", `View #${pr.number}`, pr.state === "merged" ? "merged" : `${c.pass}/${c.total} checks`, { primary: isNext("openpr") })
    : st.ahead
      ? gridButton("pushpr", "pr", "Push & PR", "into main", { primary: isNext("pushpr"), reason: st.behind ? r.push : null })
      : gridButton("pr", "pr", "Create PR", "into main", { primary: isNext("pr"), reason: r.pr });

  return `
    <div class="dh">${I("branch", "sm")}<span class="mono trunc">${BRANCH}</span><span class="meta">${abText(s)}<button class="icbtn" type="button" title="Fetch">${I("refresh", "xs")}</button></span></div>
    <div class="upl">${upstreamLine(s)}</div>
    <div class="tiles">
      <div class="tile" data-tone="${st.files ? "warn" : ""}"><span class="tl">Changes</span><span class="tv">${st.files ? plural(st.files, "file") : "Clean"}</span><span class="ts">${st.files ? `<em class="add">+${st.ins}</em><em class="del">−${st.del}</em>` : `<em class="add">+0</em><em class="del">−0</em>`}</span></div>
      <div class="tile" data-tone="${st.behind ? "warn" : st.ahead ? "info" : ""}"><span class="tl">Sync</span><span class="tv mono">${st.ahead || st.behind ? abText(s) : "✓"}</span><span class="ts">${st.behind ? `${st.behind} incoming` : st.ahead ? `${st.ahead} to push` : s.upstream ? "in sync" : "local"}</span></div>
      ${prTile}
    </div>
    ${
      s.ui.commitOpen
        ? `<div class="crow"><input class="field" data-f="msg" data-submit="commit" placeholder="Message — empty generates one" value="${esc(s.ui.msg ?? "")}" autofocus />${btn("commit", "Commit", { primary: true, reason: r.commit })}</div>`
        : ""
    }
    <div class="agrid">
      ${gridButton("commit-open", "commit", "Commit", st.files ? `${plural(st.files, "file")}` : "", { primary: isNext("commit") && !s.ui.commitOpen, reason: r.commit })}
      ${gridButton("push", "cloudUp", "Push", st.ahead ? `↑${st.ahead} to origin` : "", { primary: isNext("push"), reason: r.push })}
      ${gridButton("pull", "cloudDown", "Pull", st.behind ? `↓${st.behind} incoming` : "", { primary: isNext("pull"), reason: r.pull })}
      ${prButton}
    </div>
    <div class="nextl">${nx ? `<span>Next</span><b>${esc(nx.label)}</b>` : `${I("checkCircle", "xs")}<b>Everything is shipped</b>`}</div>`;
}

boot({
  tag: "A · Ship panel",
  hint: "Hover the rail · click an icon to pin · actions are simulated. The PR icon keeps the review/checks detail.",
  primaryKey: "git",
  chat: "I merged <b>Branch</b> and <b>Push</b> into one <b>Source control</b> item. Its preview shows changes, sync and PR at a glance, and Commit · Push · Pull · PR sit in one grid with the next step filled in.",
  rail(s) {
    const st = stats(s);
    const b = st.behind ? badge(`↓${st.behind}`, "warn") : st.ahead ? badge(`↑${st.ahead}`, "info") : "";
    return [
      { key: "git", label: "Source control", group: "status", glyph: I("branch") + b, attrs: st.ahead && !st.behind ? 'style="color:var(--inf-fg)"' : "" },
      COMMON_RAIL.changes(s),
      COMMON_RAIL.checks(s),
      COMMON_RAIL.plan(s),
      COMMON_RAIL.agents(s),
      COMMON_RAIL.pr(s),
      COMMON_RAIL.notes(s),
    ];
  },
  fly: { git: shipPanel },
  ui(act, s) {
    if (act === "commit-open") {
      s.ui.commitOpen = !s.ui.commitOpen;
      requestAnimationFrame(() => fly.querySelector('[data-f="msg"]')?.focus());
      return true;
    }
    return false;
  },
});
