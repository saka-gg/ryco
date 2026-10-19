// B · Ship pipeline: one rail item whose ring shows Commit → Sync → PR → Checks; the flyout is a guided stepper.
const v2css = document.createElement("style");
v2css.textContent = `
  .fly { width: 316px; }
  .steps { list-style: none; margin: 4px 0 0; padding: 0; }
  .step { position: relative; display: grid; grid-template-columns: 22px minmax(0, 1fr); column-gap: 10px; padding-bottom: 4px; }
  .step > * { min-width: 0; }
  .step:not(:last-child)::before { content: ""; position: absolute; left: 10px; top: 24px; bottom: 0; width: 2px; border-radius: 1px;
    background: rgba(255,255,255,.08); }
  .step[data-state="done"]:not(:last-child)::before { background: color-mix(in srgb, var(--ok) 55%, transparent); }
  .node { position: relative; z-index: 1; width: 22px; height: 22px; border-radius: 50%; display: grid; place-items: center;
    border: 2px solid rgba(255,255,255,.14); background: var(--isl-bg); color: var(--isl-faint); font: 600 10px var(--mono);
    transition: background .3s, border-color .3s, color .3s; }
  .step[data-state="done"] .node { background: var(--ok); border-color: var(--ok); color: #04140a; }
  .step[data-state="current"] .node { border-color: var(--inf); color: var(--inf-fg); box-shadow: 0 0 0 4px color-mix(in srgb, var(--inf) 18%, transparent);
    animation: halo 1.8s ease-in-out infinite; }
  .step[data-state="blocked"] .node { border-color: var(--warn); color: var(--warn-fg); }
  .step[data-state="failed"] .node { background: var(--bad); border-color: var(--bad); color: #fff; }
  @keyframes halo { 50% { box-shadow: 0 0 0 7px color-mix(in srgb, var(--inf) 6%, transparent); } }
  .shead { display: flex; align-items: center; gap: 8px; min-height: 22px; width: 100%; padding: 0; border: 0; background: none;
    color: inherit; text-align: left; cursor: pointer; border-radius: 8px; }
  .shead b { font-size: 12.5px; font-weight: 600; }
  .step[data-state="pending"] .shead b { color: var(--isl-muted); }
  .shead .sd { margin-left: auto; font: 500 10.5px var(--mono); color: var(--isl-muted); display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; }
  .shead .chev { color: var(--isl-faint); transition: transform .25s var(--ease-out); }
  .step[data-open="true"] .shead .chev { transform: rotate(90deg); }
  .ssub { grid-column: 2; font-size: 11.5px; color: var(--isl-muted); margin-top: -1px; padding-bottom: 8px; }
  .sbody { grid-column: 2; margin: -2px 0 10px; padding: 9px; border-radius: 14px; background: rgba(255,255,255,.035);
    box-shadow: inset 0 0 0 1px rgba(255,255,255,.05); animation: fly-in .28s var(--ease-out); }
  .sbody .actions { margin-top: 8px; }
  .sbody .row { padding: 2px 2px; }
  .sbody .field { margin-top: 6px; }
  .bigring { display: flex; align-items: center; gap: 10px; padding: 2px; }
  .bigring .ring { width: 36px; height: 36px; }
  .prog { display: flex; align-items: center; gap: 8px; margin: -2px 0 12px; }
  .prog .track { flex: 1; height: 4px; border-radius: 2px; background: rgba(255,255,255,.08); overflow: hidden; }
  .prog .fill { height: 100%; border-radius: 2px; background: linear-gradient(90deg, var(--ok), color-mix(in srgb, var(--ok) 70%, var(--inf)));
    transition: width .6s var(--ease-out); }
  .prog span { font: 500 10.5px var(--mono); color: var(--isl-muted); }
  .rb .pipe-glyph { width: 12px; height: 12px; }
  .base { display: flex; align-items: center; gap: 6px; font: 500 11px var(--mono); color: var(--isl-muted); margin-top: 4px; }
`;
document.head.append(v2css);

/** The four stages and their state, in order. */
function pipeline(s) {
  const st = stats(s);
  const c = checksOf(s);
  const steps = [
    {
      id: "commit",
      title: "Commit",
      done: st.files === 0,
      meta: st.files ? `<em class="add">+${st.ins}</em><em class="del">−${st.del}</em>` : "",
      sub: st.files ? `${plural(st.files, "file")} changed locally` : "Working tree clean",
    },
    {
      id: "sync",
      title: "Sync",
      done: s.upstream && !st.ahead && !st.behind,
      meta: st.ahead || st.behind ? abText(s) : "",
      sub: st.behind
        ? `${st.behind} incoming${st.ahead ? ` · ${st.ahead} to push` : ""}`
        : st.ahead
          ? s.upstream
            ? `${plural(st.ahead, "commit")} to push`
            : `${plural(st.ahead, "commit")} · branch not on origin yet`
          : s.upstream
            ? "In sync with origin"
            : "Nothing to publish",
      blocked: st.behind > 0 && st.ahead > 0,
    },
    {
      id: "pr",
      title: "Pull request",
      done: !!s.pr,
      meta: s.pr ? prPill(s.pr) : "",
      sub: s.pr ? `#${s.pr.number} · ${s.pr.approved}/${s.pr.requested} approved` : s.branchCommits ? "Ready to open" : "Needs a commit first",
    },
    {
      id: "checks",
      title: "Checks",
      done: !!c && !c.running && !c.fail,
      failed: !!c && !c.running && c.fail > 0,
      meta: c ? miniChecks(s) : "",
      sub: !c ? "Run after the PR opens" : c.running ? `${c.pass} passed · ${c.running} running${c.fail ? ` · ${c.fail} failed` : ""}` : c.fail ? `${plural(c.fail, "check")} failed` : `All ${c.total} passed`,
    },
  ];
  const current = steps.findIndex((x) => !x.done);
  steps.forEach((x, i) => {
    x.state = x.done ? "done" : x.failed ? "failed" : i === current ? (x.blocked ? "blocked" : "current") : "pending";
  });
  return { steps, current };
}

function stepBody(id, s) {
  const st = stats(s);
  const r = reasons(s);
  const nx = nextStep(s);
  const prim = (act) => nx?.act === act;
  switch (id) {
    case "commit":
      if (!st.files) return `<div class="empty">Nothing to commit.</div>`;
      return `${fileRows(s.files, 3)}
        <input class="field" data-f="msg" data-submit="commit" placeholder="Message — empty generates one" value="${esc(s.ui.msg ?? "")}" />
        <div class="actions">${btn("commit", "Commit", { icon: "commit", primary: prim("commit"), reason: r.commit })}</div>`;
    case "sync":
      return `${st.behind ? `<div class="grp"><span>Incoming</span><span>${st.behind}</span></div>${commitRows(s.incoming, { author: true, max: 2 })}` : ""}
        ${st.ahead ? `<div class="grp"><span>Outgoing</span><span>${st.ahead}</span></div>${commitRows(s.outgoing, { max: 2 })}` : ""}
        ${!st.ahead && !st.behind ? `<div class="empty">${s.upstream ? `Up to date with origin/${BRANCH}` : "No commits to publish"}</div>` : ""}
        ${st.behind && st.ahead ? `<div class="note">${I("alert", "xs")}<span>Pull first — origin moved ahead.</span></div>` : ""}
        <div class="actions">${btn("pull", st.behind ? `Pull ↓${st.behind}` : "Pull", { icon: "cloudDown", primary: prim("pull"), reason: r.pull })}${btn("push", s.upstream ? (st.ahead ? `Push ↑${st.ahead}` : "Push") : "Publish", { icon: "cloudUp", primary: prim("push") || prim("pushpr"), reason: r.push })}</div>`;
    case "pr":
      if (s.pr)
        return `<div class="row"><span class="nm trunc" style="font-weight:500">${esc(s.pr.title)}</span></div>
          <div class="base">${I("arrowLeft", "xs")} main ← ${BRANCH}</div>
          <div class="actions">${btn("openpr", `Open #${s.pr.number}`, { icon: "ext", primary: prim("openpr") && !nextStep(s).passive })}</div>`;
      return `<input class="field" data-f="prTitle" data-submit="${st.ahead ? "pushpr" : "pr"}" placeholder="${esc(s.outgoing.at(-1)?.m ?? s.lastCommit ?? "Pull request title")}" value="${esc(s.ui.prTitle ?? "")}" style="margin-top:0" />
        <div class="base">${I("arrowLeft", "xs")} main ← ${BRANCH}</div>
        <div class="actions">${st.ahead ? btn("pushpr", "Push & create PR", { icon: "pr", primary: prim("pushpr"), reason: st.behind ? r.push : null }) : btn("pr", "Create PR", { icon: "pr", primary: prim("pr"), reason: r.pr })}</div>`;
    case "checks": {
      const c = checksOf(s);
      if (!c) return `<div class="empty">Checks start once the pull request is open.</div>`;
      return `<div class="bigring">${ring(checkSegs(s), { gap: 6 })}<div><b style="font-size:13px">${c.pass}/${c.total} passed</b><div class="muted" style="font-size:11px">${c.running ? `${c.running} running · ~2 min left` : c.fail ? `${c.fail} failed · typecheck` : "Ready to merge"}</div></div></div>
        <div class="actions">${btn("openpr", c.fail ? "View failure" : "View checks", { icon: "ext" })}</div>`;
    }
  }
  return "";
}

function pipelineFly(s) {
  const { steps, current } = pipeline(s);
  const open = s.ui.step ?? (current >= 0 ? steps[current].id : null);
  const done = steps.filter((x) => x.done).length;
  return `
    <div class="dh">${I("branch", "sm")}<span class="mono trunc">${BRANCH}</span><span class="meta">${abText(s)}</span></div>
    <div class="prog"><div class="track"><div class="fill" style="width:${(done / 4) * 100}%"></div></div><span>${done === 4 ? "shipped" : `${done}/4`}</span></div>
    <ol class="steps">
      ${steps
        .map(
          (x, i) => `<li class="step" data-state="${x.state}" data-open="${open === x.id}">
            <span class="node">${x.state === "done" ? I("check", "xs") : x.state === "failed" ? I("x", "xs") : x.state === "blocked" ? "!" : i + 1}</span>
            <button type="button" class="shead" data-act="step:${x.id}" aria-expanded="${open === x.id}"><b>${x.title}</b><span class="sd">${x.meta}</span>${I("chevron", "xs chev")}</button>
            ${open === x.id ? `<div class="sbody">${stepBody(x.id, s)}</div>` : `<div class="ssub">${x.sub}</div>`}
          </li>`,
        )
        .join("")}
    </ol>`;
}

boot({
  tag: "B · Ship pipeline",
  hint: "Hover the rail · click to pin · click any step to open it · actions are simulated.",
  primaryKey: "ship",
  chat: "I replaced <b>Branch</b> and <b>Push</b> with one <b>Ship</b> item. Its ring fills as the branch moves Commit → Sync → PR → Checks, and the preview walks you through the current step.",
  rail(s) {
    const { steps } = pipeline(s);
    const segs = steps.map((x) => (x.state === "done" ? "done" : x.state === "current" ? "current" : x.state === "blocked" ? "blocked" : x.state === "failed" ? "fail" : "q"));
    return [
      { key: "ship", label: "Ship", group: "status", glyph: ring(segs, { gap: 8 }) + `<span style="display:grid">${I("branch", "xs pipe-glyph")}</span>` },
      COMMON_RAIL.changes(s),
      COMMON_RAIL.checks(s),
      COMMON_RAIL.plan(s),
      COMMON_RAIL.agents(s),
      COMMON_RAIL.pr(s),
      COMMON_RAIL.notes(s),
    ];
  },
  fly: { ship: pipelineFly },
  ui(act, s) {
    if (!act.startsWith("step:")) return false;
    const id = act.slice(5);
    const { steps, current } = pipeline(s);
    const openNow = s.ui.step ?? steps[current]?.id ?? null;
    s.ui.step = openNow === id ? "" : id;
    return true;
  },
});

// A finished action hands focus back to the pipeline's next step.
const v2run = run;
run = async (act) => {
  await v2run(act);
  S.ui.step = undefined;
  renderAll();
};
