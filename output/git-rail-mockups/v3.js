// C · Action dock: Branch + Push leave the rail; Commit / Pull / Push / PR become one docked capsule of live buttons.
const v3css = document.createElement("style");
v3css.textContent = `
  .cap { position: relative; z-index: 1; display: flex; flex-direction: column; align-items: center; gap: 2px; padding: 2px;
    border-radius: 18px; background: rgba(255,255,255,.045); box-shadow: inset 0 0 0 1px rgba(255,255,255,.06); }
  .cap .rb { width: 32px; height: 32px; }
  .cap-ab { display: flex; flex-direction: column; align-items: center; gap: 0; padding: 3px 0 1px; font: 600 8.5px/1.15 var(--mono);
    color: var(--isl-faint); letter-spacing: -.02em; }
  .cap-ab .ic { width: 11px; height: 11px; margin-bottom: 2px; }
  .rb[data-ready="true"] { color: var(--isl-fg); }
  .rb[data-k="push"][data-ready="true"], .rb[data-k="pull"][data-ready="true"] { color: var(--inf-fg); }
  .rb[data-blocked="true"] { color: var(--warn-fg); }
  .rb[data-idle="true"] { color: color-mix(in srgb, var(--isl-muted) 55%, transparent); }
  .rb[data-next="true"]::after { content: ""; grid-area: 1 / 1; width: 100%; height: 100%; border-radius: 50%;
    box-shadow: 0 0 0 1.5px color-mix(in srgb, var(--inf) 75%, transparent); animation: breathe 1.8s ease-in-out infinite; pointer-events: none; }
  @keyframes breathe { 50% { box-shadow: 0 0 0 4px color-mix(in srgb, var(--inf) 0%, transparent); } }
  .bh { display: flex; align-items: center; gap: 7px; padding: 0 10px 9px 0; margin-bottom: 10px; border-bottom: 1px solid rgba(255,255,255,.06);
    font-size: 11px; color: var(--isl-muted); min-width: 0; }
  .bh .ic { color: var(--isl-faint); }
  .bh .mono { color: var(--isl-fg); font-size: 11px; }
  .at { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
  .at b { font-size: 14px; font-weight: 600; letter-spacing: -.01em; }
  .at .meta { margin-left: auto; }
  .lead { font-size: 11.5px; color: var(--isl-muted); margin: -2px 0 6px; }
  .target { display: flex; align-items: center; gap: 6px; margin-top: 8px; padding: 6px 9px; border-radius: 10px; background: rgba(255,255,255,.035);
    font: 500 11px var(--mono); color: var(--isl-muted); }
  .target .ic { color: var(--isl-faint); }
  .chk { display: flex; align-items: center; gap: 7px; margin-top: 8px; font-size: 11.5px; color: var(--isl-muted); cursor: pointer; user-select: none; }
  .chk input { accent-color: #f4f4f5; margin: 0; }
  .split { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-top: 8px; }
  .kv { display: flex; gap: 10px; padding: 3px 2px; font-size: 12px; }
  .kv span:first-child { width: 64px; flex: none; color: var(--isl-muted); }
`;
document.head.append(v3css);

const GIT_KEYS = ["commit", "pull", "push", "prx"];

function head(s) {
  return `<div class="bh">${I("branch", "xs")}<span class="mono trunc">${BRANCH}</span><span class="meta">${abText(s)}</span></div>`;
}

const DOCK_FLY = {
  commit(s) {
    const st = stats(s);
    const r = reasons(s);
    const nx = nextStep(s);
    if (!st.files)
      return `${head(s)}<div class="at"><b>Commit</b></div><div class="empty">Working tree clean — nothing to commit.</div>
        ${s.outgoing.length ? `<div class="grp"><span>Last commits</span><span>${s.outgoing.length}</span></div>${commitRows(s.outgoing, { max: 2 })}` : ""}`;
    return `${head(s)}
      <div class="at"><b>Commit</b><span class="meta">${plural(st.files, "file")} · <em class="add">+${st.ins}</em><em class="del">−${st.del}</em></span></div>
      ${diffBar(s)}${fileRows(s.files, 4)}
      <input class="field" style="margin-top:8px" data-f="msg" data-submit="${s.ui.andPush && s.upstream ? "commitpush" : "commit"}" placeholder="Message — empty generates one" value="${esc(s.ui.msg ?? "")}" />
      <label class="chk"><input type="checkbox" data-f="andPush" ${s.ui.andPush ? "checked" : ""} ${st.behind ? "disabled" : ""}/> Push after committing${st.behind ? ` <span class="down">(pull ${st.behind} first)</span>` : ""}</label>
      <div class="actions">${s.ui.andPush && !st.behind ? btn("commitpush", "Commit & push", { icon: "cloudUp", primary: nx?.act === "commit" }) : btn("commit", "Commit", { icon: "commit", primary: nx?.act === "commit", reason: r.commit })}</div>`;
  },
  pull(s) {
    const st = stats(s);
    const r = reasons(s);
    if (!st.behind)
      return `${head(s)}<div class="at"><b>Pull</b></div><div class="empty">${s.upstream ? `Up to date with origin/${BRANCH}.` : "This branch has no upstream yet."}</div><div class="actions">${btn("pull", "Pull", { icon: "cloudDown", reason: r.pull })}</div>`;
    return `${head(s)}
      <div class="at"><b>Pull</b><span class="meta"><span class="down">↓${st.behind}</span> incoming</span></div>
      ${commitRows(s.incoming, { author: true })}
      ${st.files ? `<div class="note">${I("alert", "xs")}<span>${plural(st.files, "local change")} will be stashed and re-applied.</span></div>` : ""}
      <div class="actions">${btn("pull", `Pull ${plural(st.behind, "commit")}`, { icon: "cloudDown", primary: nextStep(s)?.act === "pull" })}</div>`;
  },
  push(s) {
    const st = stats(s);
    const r = reasons(s);
    const nx = nextStep(s);
    if (!st.ahead)
      return `${head(s)}<div class="at"><b>Push</b></div><div class="empty">${st.files ? `Nothing committed yet — ${plural(st.files, "file")} still local.` : "Nothing to push."}</div><div class="actions">${btn("push", "Push", { icon: "cloudUp", reason: r.push })}</div>`;
    return `${head(s)}
      <div class="at"><b>Push</b><span class="meta"><span class="up">↑${st.ahead}</span> outgoing</span></div>
      ${commitRows(s.outgoing)}
      <div class="target">${I("cloudUp", "xs")}<span class="trunc">${s.upstream ? `origin/${BRANCH}` : `new branch origin/${BRANCH}`}</span></div>
      ${st.behind ? `<div class="note">${I("alert", "xs")}<span>origin has ${plural(st.behind, "new commit")}. Pull first.</span></div><div class="actions">${btn("pull", `Pull ↓${st.behind}`, { icon: "cloudDown", primary: true })}</div>` : ""}
      ${st.behind ? "" : `<div class="split">${btn("push", s.upstream ? "Push" : "Publish", { icon: "cloudUp", primary: nx?.act === "push" })}${s.pr ? btn("openpr", `PR #${s.pr.number}`, { icon: "pr" }) : btn("pushpr", "Push & PR", { icon: "pr", primary: nx?.act === "pushpr" })}</div>`}`;
  },
  prx(s) {
    const st = stats(s);
    const r = reasons(s);
    const nx = nextStep(s);
    if (s.pr) {
      const c = checksOf(s);
      return `${head(s)}
        <div class="at"><b>PR #${s.pr.number}</b><span class="meta">${prPill(s.pr)}</span></div>
        <div class="lead trunc" style="color:var(--isl-fg);font-weight:500">${esc(s.pr.title)}</div>
        <div class="kv"><span>Checks</span><span style="display:inline-flex;gap:5px;align-items:center">${miniChecks(s)}${c.running ? `<span class="faint">· ${c.running} running</span>` : c.fail ? `<span class="del">· ${c.fail} failed</span>` : ""}</span></div>
        <div class="kv"><span>Reviews</span><span>${s.pr.approved}/${s.pr.requested} approved</span></div>
        <div class="kv"><span>Base</span><span class="mono" style="font-size:11px">main ← ${BRANCH}</span></div>
        ${st.ahead ? `<div class="note">${I("alert", "xs")}<span>${plural(st.ahead, "local commit")} not on the PR yet.</span></div>` : ""}
        <div class="split">${btn("openpr", "Open PR", { icon: "ext", primary: nx?.act === "openpr" && !nx.passive })}${st.ahead ? btn("push", `Push ↑${st.ahead}`, { icon: "cloudUp", reason: r.push }) : btn("openpr", "Checks", { icon: "checkCircle" })}</div>`;
    }
    const act = st.ahead ? "pushpr" : "pr";
    return `${head(s)}
      <div class="at"><b>Create pull request</b></div>
      <input class="field" data-f="prTitle" data-submit="${act}" placeholder="${esc(s.outgoing.at(-1)?.m ?? s.lastCommit ?? "Title")}" value="${esc(s.ui.prTitle ?? "")}" />
      <div class="target">${I("arrowLeft", "xs")}<span class="trunc">main ← ${BRANCH}</span><span class="faint" style="margin-left:auto">${plural(s.branchCommits, "commit")}</span></div>
      <label class="chk"><input type="checkbox" data-f="draft" ${s.ui.draft ? "checked" : ""}/> Open as draft</label>
      <div class="actions">${btn(act, st.ahead ? "Push & create PR" : "Create PR", { icon: "pr", primary: nx?.act === act, reason: st.ahead && st.behind ? r.push : r.pr })}</div>`;
  },
};

ACTIONS.commitpush = {
  verb: "Committing & pushing",
  run(s) {
    ACTIONS.commit.run(s);
    const res = ACTIONS.push.run(s);
    s.ui.andPush = false;
    return [res[0], res[1], `Committed & pushed`, res[3]];
  },
};

function dockButton(k, s) {
  const st = stats(s);
  const r = reasons(s);
  const nx = nextStep(s);
  const nextKey = !nx || nx.passive ? null : { commit: "commit", pull: "pull", push: "push", pushpr: "push", pr: "prx", openpr: "prx" }[nx.act];
  const common = (label, glyph, { ready, blocked = false } = {}) =>
    `<button type="button" class="rb" data-key="${k}" data-k="${k}" aria-label="${esc(label)}" title="${esc(label)}" data-ready="${ready}" data-idle="${!ready && !blocked}" data-blocked="${blocked}" data-next="${nextKey === k}">${glyph}</button>`;
  switch (k) {
    case "commit":
      return common(st.files ? `Commit ${plural(st.files, "file")}` : "Commit — nothing to commit", I("commit") + badge(st.files), { ready: !r.commit });
    case "pull":
      return common(st.behind ? `Pull ${st.behind}` : "Pull — up to date", I("cloudDown") + badge(st.behind ? `↓${st.behind}` : "", "warn"), { ready: !r.pull });
    case "push":
      return common(st.behind && st.ahead ? "Push — pull first" : st.ahead ? `Push ${st.ahead}` : "Push — nothing to push", I("cloudUp") + badge(st.ahead ? `↑${st.ahead}` : "", st.behind ? "warn" : "info"), { ready: !r.push, blocked: st.ahead > 0 && st.behind > 0 });
    case "prx": {
      const pr = s.pr;
      const c = checksOf(s);
      const glyph = I(pr?.state === "merged" ? "merge" : "pr") + (pr ? (pr.state === "merged" ? "" : badge(c.running ? "…" : c.fail ? "!" : "✓", c.fail ? "warn" : c.running ? "" : "ok")) : badge(s.branchCommits ? "+" : ""));
      return `<button type="button" class="rb" data-key="prx" data-k="prx" aria-label="Pull request" title="${pr ? `PR #${pr.number}` : "Create pull request"}" data-pr="${pr?.state ?? "none"}" data-idle="${!pr && !s.branchCommits}" data-next="${nextKey === "prx"}">${glyph}</button>`;
    }
  }
}

boot({
  tag: "C · Action dock",
  hint: "Hover or click a dock button · branch + sync head every action preview · actions are simulated.",
  primaryKey: "commit",
  chat: "I took <b>Branch</b> and <b>Push</b> out of the rail and docked <b>Commit · Pull · Push · PR</b> as one capsule. Badges show files, ↓incoming, ↑outgoing and PR state, and the next step breathes.",
  rail(s) {
    return [
      COMMON_RAIL.changes(s),
      COMMON_RAIL.checks(s),
      COMMON_RAIL.plan(s),
      COMMON_RAIL.agents(s),
      { group: "dock", html: `<span class="sep" aria-hidden="true"></span><div class="cap" role="group" aria-label="Source control">${GIT_KEYS.map((k) => dockButton(k, s)).join("")}</div>` },
      COMMON_RAIL.notes(s),
    ];
  },
  fly: DOCK_FLY,
});
// Each scenario opens on the dock button that matters.
const v3load = load;
load = (key) => {
  v3load(key);
  const nx = nextStep(S);
  const k = !nx ? "prx" : { commit: "commit", pull: "pull", push: "push", pushpr: "push", pr: "prx", openpr: "prx" }[nx.act];
  open(k, { pin: true });
};
load("dirty");
