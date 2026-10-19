// Shared mock engine: a simulated checkout, the crown island + rail, hover/pin flyouts.
const ICONS = {
  branch:
    '<line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
  fileDiff:
    '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M9 10h6"/><path d="M12 13V7"/><path d="M9 17h6"/>',
  sparkles:
    '<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/>',
  bot: '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>',
  pr: '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><line x1="6" x2="6" y1="9" y2="21"/>',
  merge: '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 0 0 9 9"/>',
  notes:
    '<path d="M13.4 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7.4"/><path d="M2 6h4"/><path d="M2 10h4"/><path d="M2 14h4"/><path d="M2 18h4"/><path d="M21.378 5.626a1 1 0 1 0-3.004-3.004l-5.01 5.012a2 2 0 0 0-.506.854l-.837 2.87a.5.5 0 0 0 .62.62l2.87-.837a2 2 0 0 0 .854-.506z"/>',
  cloudUp:
    '<path d="M12 13v8"/><path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"/><path d="m8 17 4-4 4 4"/>',
  cloudDown:
    '<path d="M12 13v8l-4-4"/><path d="m12 21 4-4"/><path d="M4.393 15.269A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.436 8.284"/>',
  commit:
    '<circle cx="12" cy="12" r="3"/><line x1="3" x2="9" y1="12" y2="12"/><line x1="15" x2="21" y1="12" y2="12"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  checkCircle: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  refresh:
    '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  loader: '<path d="M21 12a9 9 0 1 1-6.219-8.56"/>',
  alert:
    '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  ext: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h3"/>',
  arrowLeft: '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  rocket:
    '<path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/>',
  users:
    '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
};
const I = (name, cls = "") =>
  `<svg class="ic ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
const esc = (v) =>
  String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BRANCH = "feature/crown-git";
const FILES = [
  { p: "CrownRailNav.tsx", dir: "crown/", a: 28, d: 6, s: "M" },
  { p: "gitHub.logic.ts", dir: "crown/", a: 41, d: 0, s: "A" },
  { p: "rail.css", dir: "crown/styles/", a: 9, d: 3, s: "M" },
];
const INCOMING = [
  { h: "a41c09e", m: "Clamp flyouts on short panes", by: "mara", t: "12m" },
  { h: "7be2f13", m: "Bump effect to 3.21", by: "devon", t: "40m" },
  { h: "c03d8aa", m: "Rename overview tokens", by: "mara", t: "1h" },
];

/** Starting states for the scenario switcher. */
const SCENARIOS = {
  dirty: {
    label: "Uncommitted work",
    files: FILES,
    outgoing: [],
    incoming: [],
    upstream: true,
    branchCommits: 0,
    pr: null,
  },
  ahead: {
    label: "Never pushed",
    files: [],
    outgoing: [
      { h: "e1f02bc", m: "Group git actions in the crown rail" },
      { h: "9ad4410", m: "Show ahead/behind on the rail badge" },
    ],
    incoming: [],
    upstream: false,
    branchCommits: 2,
    pr: null,
  },
  behind: {
    label: "Behind remote",
    files: [FILES[2]],
    outgoing: [{ h: "e1f02bc", m: "Group git actions in the crown rail" }],
    incoming: INCOMING,
    upstream: true,
    branchCommits: 3,
    pr: { number: 752, title: "Group git actions in the crown rail", state: "open", checks: { pass: 5, fail: 0, running: 0 }, approved: 1, requested: 2 },
  },
  checks: {
    label: "PR checks running",
    files: [],
    outgoing: [],
    incoming: [],
    upstream: true,
    branchCommits: 3,
    pr: { number: 752, title: "Group git actions in the crown rail", state: "open", checks: { pass: 2, fail: 1, running: 3 }, approved: 0, requested: 2 },
  },
  synced: {
    label: "Shipped",
    files: [],
    outgoing: [],
    incoming: [],
    upstream: true,
    branchCommits: 3,
    pr: { number: 741, title: "Keep project icons visible", state: "merged", checks: { pass: 6, fail: 0, running: 0 }, approved: 2, requested: 2 },
  },
};

let S;
let V;
let openKey = null;
let pinned = false;
let closeTimer = 0;
let alertTimer = 0;
let hash = 0x3f2a1;
const nextHash = () => (hash = (hash * 2654435761 + 7) >>> 0).toString(16).slice(0, 7).padStart(7, "0");

// ── Derived state ───────────────────────────────────────────
function stats(s) {
  const ins = s.files.reduce((n, f) => n + f.a, 0);
  const del = s.files.reduce((n, f) => n + f.d, 0);
  return { files: s.files.length, ins, del, ahead: s.outgoing.length, behind: s.incoming.length };
}
function checksOf(s) {
  if (!s.pr) return null;
  const c = s.pr.checks;
  const total = c.pass + c.fail + c.running;
  const ci = c.running ? "running" : c.fail ? "fail" : "pass";
  return { ...c, total, ci };
}
/** Why an action is unavailable (null = available). */
function reasons(s) {
  const st = stats(s);
  return {
    commit: st.files ? null : "Nothing to commit",
    pull: !s.upstream ? "No upstream yet" : st.behind ? null : "Up to date",
    push: st.behind ? `Pull ${st.behind} first` : st.ahead ? null : "Nothing to push",
    pr: !s.pr && !s.branchCommits ? "No commits yet" : null,
  };
}
/** The one action that moves the branch forward. */
function nextStep(s) {
  const st = stats(s);
  if (st.files) return { act: "commit", label: `Commit ${plural(st.files, "file")}` };
  if (st.behind) return { act: "pull", label: `Pull ${plural(st.behind, "commit")}` };
  if (st.ahead && !s.pr) return { act: "pushpr", label: "Push & create PR" };
  if (st.ahead) return { act: "push", label: `Push ${plural(st.ahead, "commit")}` };
  if (!s.pr && s.branchCommits) return { act: "pr", label: "Create pull request" };
  if (s.pr && s.pr.state === "open") {
    const c = checksOf(s);
    if (c.running) return { act: "openpr", label: `Wait for ${plural(c.running, "check")}`, passive: true };
    if (c.fail) return { act: "openpr", label: `Fix ${plural(c.fail, "failing check")}` };
    return { act: "openpr", label: "Review & merge" };
  }
  return null;
}
function abText(s) {
  const st = stats(s);
  const parts = [];
  if (st.ahead) parts.push(`<span class="up">↑${st.ahead}</span>`);
  if (st.behind) parts.push(`<span class="down">↓${st.behind}</span>`);
  if (!parts.length) return s.upstream ? "in sync" : "local";
  return parts.join(" ");
}
function upstreamLine(s) {
  return s.upstream
    ? `<span class="muted">tracking</span> <span class="mono">origin/${BRANCH}</span>`
    : `<span class="down">Not pushed yet</span> <span class="faint">· creates origin/${BRANCH}</span>`;
}

// ── Actions ─────────────────────────────────────────────────
function newPr(s) {
  const title = (s.ui.prTitle || "").trim() || s.outgoing.at(-1)?.m || s.lastCommit || "Group git actions in the crown rail";
  return { number: 752, title, state: s.ui.draft ? "draft" : "open", checks: { pass: 0, fail: 0, running: 5 }, approved: 0, requested: 2 };
}
const ACTIONS = {
  commit: {
    verb: "Committing",
    run(s) {
      const n = s.files.length;
      const m = (s.ui.msg || "").trim() || "Refine crown rail git actions";
      s.outgoing.unshift({ h: nextHash(), m });
      s.lastCommit = m;
      s.files = [];
      s.branchCommits++;
      s.ui.msg = "";
      s.ui.commitOpen = false;
      return ["var(--ok)", "checkCircle", `Committed ${plural(n, "file")}`, m];
    },
  },
  pull: {
    verb: "Pulling",
    run(s) {
      const n = s.incoming.length;
      s.incoming = [];
      return ["var(--ok)", "cloudDown", `Pulled ${plural(n, "commit")}`, `from origin/${BRANCH}`];
    },
  },
  push: {
    verb: "Pushing",
    run(s) {
      const n = s.outgoing.length;
      const was = s.upstream;
      s.outgoing = [];
      s.upstream = true;
      if (s.pr && s.pr.state !== "merged") s.pr.checks = { pass: 0, fail: 0, running: 5 };
      return ["var(--inf)", "cloudUp", `Pushed ${plural(n, "commit")}`, was ? `to origin/${BRANCH}` : `published origin/${BRANCH}`];
    },
  },
  pr: {
    verb: "Opening pull request",
    run(s) {
      s.pr = newPr(s);
      return ["var(--ok)", "pr", `Opened PR #${s.pr.number}`, s.pr.title];
    },
  },
  pushpr: {
    verb: "Pushing & opening PR",
    run(s) {
      ACTIONS.push.run(s);
      s.pr = newPr(s);
      return ["var(--ok)", "pr", `Pushed · opened PR #${s.pr.number}`, s.pr.title];
    },
  },
  openpr: {
    verb: null,
    run(s) {
      return ["var(--isl-muted)", "ext", `PR #${s.pr.number}`, "Opened in the workspace panel"];
    },
  },
};

async function run(act) {
  if (S.busy) return;
  const a = ACTIONS[act];
  if (a.verb) {
    S.busy = act;
    showIsland("var(--isl-muted)", "loader", `${a.verb}…`, BRANCH, true);
    renderAll();
    await sleep(act === "pushpr" ? 1300 : 900);
  }
  const [tone, icon, title, sub] = a.run(S);
  S.busy = null;
  renderAll();
  showIsland(tone, icon, title, sub);
}

// ── Shared render helpers for variants ──────────────────────
function badge(value, variant = "") {
  if (value === "" || value === 0 || value == null) return "";
  return `<span class="bd ${variant}">${value}</span>`;
}
/** A ring of arcs (`pathLength=100`), one per segment state. */
function ring(segs, { gap = 9, cls = "ring", r = 12.5, box = 32 } = {}) {
  const c = box / 2;
  let out = `<svg class="${cls}" viewBox="0 0 ${box} ${box}" aria-hidden="true"><circle class="tr" cx="${c}" cy="${c}" r="${r}" pathLength="100"/>`;
  if (segs.length) {
    const g = segs.length > 1 ? gap : 0;
    const len = 100 / segs.length - g;
    segs.forEach((state, i) => {
      out += `<circle class="sg" data-s="${state}" cx="${c}" cy="${c}" r="${r}" pathLength="100" stroke-dasharray="${len} ${100 - len}" stroke-dashoffset="${-(i * (100 / segs.length) + g / 2)}"/>`;
    });
  }
  return out + "</svg>";
}
function checkSegs(s) {
  const c = checksOf(s);
  if (!c) return [];
  return [...Array(c.pass).fill("pass"), ...Array(c.fail).fill("fail"), ...Array(c.running).fill("running")];
}
function miniChecks(s) {
  const c = checksOf(s);
  if (!c) return "";
  return `${ring(checkSegs(s), { cls: "ring mini-ring", gap: 12, r: 11, box: 28 })}<span class="mono">${c.pass}/${c.total}</span>`;
}
function prPill(pr) {
  return `<span class="pill ${pr.state}">${pr.state === "merged" ? I("merge", "xs") : I("pr", "xs")}${pr.state[0].toUpperCase() + pr.state.slice(1)}</span>`;
}
/** A pill button bound to an action; shows a spinner while that action runs. */
function btn(act, label, { icon, primary = false, reason = null, title = "", cls = "" } = {}) {
  const busy = S.busy === act;
  const disabled = reason !== null || (S.busy && !busy);
  return `<button type="button" class="btn ${primary ? "primary" : ""} ${cls}" data-act="${act}" ${disabled ? "disabled" : ""} title="${esc(reason ?? title)}">${busy ? I("loader", "sm spin") : icon ? I(icon, "sm") : ""}${esc(busy ? ACTIONS[act]?.verb ?? label : label)}</button>`;
}
function fileRows(files, max = 4) {
  return (
    files
      .slice(0, max)
      .map(
        (f) =>
          `<div class="row"><span class="st ${f.s}">${f.s}</span><span class="nm trunc">${esc(f.p)} <span class="faint">${esc(f.dir)}</span></span><span class="num"><em class="add">+${f.a}</em> <em class="del">−${f.d}</em></span></div>`,
      )
      .join("") + (files.length > max ? `<div class="row faint">+${files.length - max} more</div>` : "")
  );
}
function commitRows(list, { author = false, max = 3 } = {}) {
  return (
    list
      .slice(0, max)
      .map(
        (c) =>
          `<div class="row commit-row"><span class="hash">${c.h.slice(0, 7)}</span><span class="nm trunc">${esc(c.m)}</span>${author ? `<span class="num faint">${c.by} · ${c.t}</span>` : ""}</div>`,
      )
      .join("") + (list.length > max ? `<div class="row faint">+${list.length - max} more</div>` : "")
  );
}
function diffBar(s) {
  const st = stats(s);
  const total = st.ins + st.del || 1;
  return `<div class="bar-split"><i style="flex:${st.ins / total};background:var(--ok)"></i><i style="flex:${st.del / total};background:var(--bad)"></i></div>`;
}

/** Flyouts every variant shares for the non-git rail items. */
const COMMON_FLY = {
  changes(s) {
    const st = stats(s);
    return `<div class="dh">${I("fileDiff", "sm")}<span>Changes</span><span class="meta"><em class="add">+${st.ins}</em><em class="del">−${st.del}</em></span></div>
      ${st.files ? `${diffBar(s)}<div class="grp"><span>Local</span><span>${st.files}</span></div>${fileRows(s.files)}` : `<div class="empty">Working tree clean</div>`}
      <div class="actions">${`<button class="btn" type="button">${I("fileDiff", "sm")}Open review</button>`}</div>`;
  },
  checks(s) {
    const c = checksOf(s);
    if (!c) return `<div class="dh">${I("checkCircle", "sm")}<span>Checks</span></div><div class="empty">No checks for this branch yet</div>`;
    const names = ["typecheck", "lint", "test (web)", "test (server)", "browser", "build"];
    const segs = checkSegs(s);
    return `<div class="dh">${I("checkCircle", "sm")}<span>Checks</span><span class="meta">${c.pass}/${c.total}</span></div>
      ${segs
        .map((st, i) => {
          const tone = st === "pass" ? "var(--ok)" : st === "fail" ? "var(--bad)" : "var(--warn)";
          return `<div class="row"><span class="dot" data-ci="${st}" style="background:${tone}"></span><span class="nm trunc">${names[i % names.length]}</span><span class="num faint">${st === "running" ? "running" : st === "fail" ? "failed" : "1m 12s"}</span></div>`;
        })
        .join("")}`;
  },
  pr(s) {
    if (!s.pr) return `<div class="dh">${I("pr", "sm")}<span>Pull request</span></div><div class="empty">No pull request for this branch</div>`;
    return `<div class="dh">${I("pr", "sm")}<span>PR #${s.pr.number}</span><span class="meta">${prPill(s.pr)}</span></div>
      <div class="row"><span class="nm trunc" style="font-weight:500">${esc(s.pr.title)}</span></div>
      <div class="row"><span class="muted">main ← ${BRANCH}</span></div>
      <div class="row">${miniChecks(s)}<span class="faint">· ${s.pr.approved}/${s.pr.requested} approved</span></div>`;
  },
  plan() {
    return `<div class="dh">${I("sparkles", "sm")}<span>Plan</span><span class="meta">3/5</span></div>
      <div class="row"><span class="add">✓</span><span class="nm">Audit rail sections</span></div>
      <div class="row"><span class="add">✓</span><span class="nm">Merge branch + push items</span></div>
      <div class="row"><span class="add">✓</span><span class="nm">Ship panel detail</span></div>
      <div class="row"><span class="faint">○</span><span class="nm muted">Alerts for git actions</span></div>
      <div class="row"><span class="faint">○</span><span class="nm muted">Browser tests</span></div>`;
  },
  agents() {
    return `<div class="dh">${I("bot", "sm")}<span>Subagents</span><span class="meta">idle</span></div><div class="empty">No subagents ran in this thread</div>`;
  },
  notes() {
    return `<div class="dh">${I("notes", "sm")}<span>Notes</span></div><div class="empty">Remember: keep the PR section for review detail.</div>`;
  },
};
/** Rail glyphs every variant shares. */
const COMMON_RAIL = {
  changes: (s) => ({ key: "changes", label: "Changes", group: "status", glyph: I("fileDiff") + badge(stats(s).files) }),
  checks: (s) => {
    const c = checksOf(s);
    return { key: "checks", label: "Checks", group: "status", glyph: ring(checkSegs(s)) + `<i class="dot" data-ci="${c?.ci ?? ""}"></i>` };
  },
  plan: () => ({
    key: "plan",
    label: "Plan",
    group: "status",
    glyph: `<svg class="ring" viewBox="0 0 32 32" aria-hidden="true"><circle class="tr" cx="16" cy="16" r="12.5" pathLength="100"/><circle class="sg" data-s="plan" cx="16" cy="16" r="12.5" pathLength="100" stroke-dasharray="60 40"/></svg><span style="color:var(--plan);display:grid">${I("sparkles", "xs")}</span>`,
  }),
  agents: () => ({ key: "agents", label: "Subagents", group: "status", glyph: I("bot") }),
  pr: (s) => ({ key: "pr", label: "Pull request", group: "status", glyph: I(s.pr?.state === "merged" ? "merge" : "pr"), attrs: `data-pr="${s.pr?.state ?? "none"}"` }),
  notes: () => ({ key: "notes", label: "Notes", group: "tools", glyph: I("notes") }),
};

// ── DOM ─────────────────────────────────────────────────────
let stage, crown, island, rail, list, hl, fly;

function showIsland(tone, icon, title, sub, sticky = false) {
  clearTimeout(alertTimer);
  island.style.setProperty("--tone", tone);
  island.querySelector(".al").innerHTML = `<span class="al-ic">${I(icon, icon === "loader" ? "spin" : "")}</span><div class="trunc"><b class="trunc">${esc(title)}</b><small class="trunc">${esc(sub)}</small></div>`;
  island.dataset.mode = "alert";
  if (!sticky) alertTimer = setTimeout(() => (island.dataset.mode = "dot"), 2600);
}

function renderRail() {
  const items = V.rail(S);
  let html = "";
  items.forEach((it, i) => {
    if (it.html) {
      html += it.html;
      return;
    }
    const prev = items[i - 1];
    if (prev && prev.group !== it.group) html += '<span class="sep" aria-hidden="true"></span>';
    html += `<button type="button" class="rb" data-key="${it.key}" aria-label="${esc(it.label)}" title="${esc(it.label)}" ${it.attrs ?? ""}>${it.glyph}</button>`;
  });
  list.innerHTML = '<span class="hl" aria-hidden="true"></span>' + html;
  hl = list.querySelector(".hl");
  syncHighlight(false);
}
function syncHighlight(animate = true) {
  list.querySelectorAll(".rb").forEach((b) => (b.dataset.active = b.dataset.key === openKey ? "true" : "false"));
  const b = openKey && list.querySelector(`[data-key="${openKey}"]`);
  if (!animate) hl.style.transition = "none";
  if (b) {
    const lr = list.getBoundingClientRect();
    const br = b.getBoundingClientRect();
    hl.style.width = `${br.width}px`;
    hl.style.height = `${br.height}px`;
    hl.style.transform = `translate(${br.left - lr.left}px, ${br.top - lr.top}px)`;
    hl.style.opacity = "1";
  } else hl.style.opacity = "0";
  if (!animate) requestAnimationFrame(() => (hl.style.transition = ""));
}
function captureFocus() {
  const a = document.activeElement;
  if (!a || !fly.contains(a) || !a.dataset.f) return null;
  return { f: a.dataset.f, s: a.selectionStart, e: a.selectionEnd };
}
function restoreFocus(c) {
  if (!c) return;
  const el = fly.querySelector(`[data-f="${c.f}"]`);
  if (!el) return;
  el.focus({ preventScroll: true });
  try {
    el.setSelectionRange(c.s, c.e);
  } catch {}
}
function renderFly(animate = false) {
  if (!openKey) {
    fly.hidden = true;
    return;
  }
  const focus = captureFocus();
  fly.innerHTML = V.fly[openKey]?.(S) ?? COMMON_FLY[openKey]?.(S) ?? "";
  fly.hidden = false;
  fly.classList.toggle("pinned", pinned);
  if (animate) {
    fly.classList.remove("enter");
    void fly.offsetWidth;
    fly.classList.add("enter");
    fly.style.transition = "none";
  }
  positionFly();
  if (animate) requestAnimationFrame(() => (fly.style.transition = ""));
  restoreFocus(focus);
}
function positionFly() {
  const b = list.querySelector(`[data-key="${openKey}"]`);
  if (!b) return;
  const cr = crown.getBoundingClientRect();
  const br = b.getBoundingClientRect();
  const center = br.top - cr.top + br.height / 2;
  const max = stage.clientHeight - 28 - fly.offsetHeight;
  fly.style.maxHeight = `${stage.clientHeight - 28}px`;
  fly.style.top = `${Math.max(-2, Math.min(center - 30, max))}px`;
}
function renderAll() {
  renderRail();
  renderFly();
  document.querySelectorAll(".seg[data-scn]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.scn === S.key)));
}
function open(key, { pin = false } = {}) {
  clearTimeout(closeTimer);
  const changed = key !== openKey;
  openKey = key;
  pinned = pin;
  syncHighlight();
  renderFly(changed);
}
function close() {
  openKey = null;
  pinned = false;
  syncHighlight();
  renderFly();
}
function scheduleClose() {
  if (pinned) return;
  clearTimeout(closeTimer);
  closeTimer = setTimeout(close, 240);
}
function load(key) {
  S = JSON.parse(JSON.stringify(SCENARIOS[key]));
  S.key = key;
  S.busy = null;
  S.ui = {};
  island.dataset.mode = "dot";
  renderAll();
  open(V.primaryKey, { pin: true });
}

function boot(variant) {
  V = variant;
  const root = document.getElementById("root");
  root.innerHTML = `
    <div class="wrap">
      <div class="bar"><span class="tag">${esc(V.tag)}</span>${Object.entries(SCENARIOS)
        .map(([k, s]) => `<button type="button" class="seg" data-scn="${k}">${s.label}</button>`)
        .join("")}</div>
      <div class="stage">
        <div class="chat">
          <div class="u">Group Commit, Push, Create PR and Pull in the crown rail.</div>
          <div class="tool">${I("fileDiff", "xs")} edited 3 files in crown/</div>
          <div class="a">${V.chat}</div>
          <div class="composer">Ask for follow-up changes…</div>
        </div>
        <div class="crown">
          <div class="island" data-mode="dot"><div class="face"><span class="logo">c</span></div><div class="al"></div></div>
          <nav class="rail" aria-label="Overview"><div class="rail-list"></div></nav>
          <div class="fly" hidden></div>
        </div>
      </div>
      <div class="hint">${esc(V.hint)}</div>
    </div>`;
  stage = root.querySelector(".stage");
  crown = root.querySelector(".crown");
  island = root.querySelector(".island");
  rail = root.querySelector(".rail");
  list = root.querySelector(".rail-list");
  fly = root.querySelector(".fly");

  root.querySelector(".bar").addEventListener("click", (e) => {
    const b = e.target.closest("[data-scn]");
    if (b) load(b.dataset.scn);
  });
  list.addEventListener("pointerover", (e) => {
    const b = e.target.closest("[data-key]");
    if (!b || pinned) return;
    open(b.dataset.key);
  });
  rail.addEventListener("pointerleave", scheduleClose);
  fly.addEventListener("pointerenter", () => clearTimeout(closeTimer));
  fly.addEventListener("pointerleave", scheduleClose);
  list.addEventListener("click", (e) => {
    const b = e.target.closest("[data-key]");
    if (!b) return;
    if (V.onRailClick?.(b.dataset.key)) return;
    if (pinned && openKey === b.dataset.key) close();
    else open(b.dataset.key, { pin: true });
  });
  fly.addEventListener("click", (e) => {
    const t = e.target.closest("[data-act]");
    if (!t || t.disabled) return;
    const act = t.dataset.act;
    if (V.ui?.(act, S, t)) renderAll();
    else if (ACTIONS[act]) run(act);
  });
  fly.addEventListener("input", (e) => {
    if (e.target.dataset.f) S.ui[e.target.dataset.f] = e.target.type === "checkbox" ? e.target.checked : e.target.value;
  });
  fly.addEventListener("change", (e) => {
    if (e.target.type === "checkbox") renderFly();
  });
  fly.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.dataset.submit) {
      e.preventDefault();
      const target = fly.querySelector(`button[data-act="${e.target.dataset.submit}"]`);
      if (target && !target.disabled) target.click();
    }
  });
  document.addEventListener("pointerdown", (e) => {
    if (pinned && !crown.contains(e.target) && !e.target.closest(".bar")) close();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });
  // CI progresses on its own: one running check settles every 1.2s.
  setInterval(() => {
    const c = S.pr?.checks;
    if (!c?.running || S.busy) return;
    c.running--;
    c.pass++;
    renderAll();
    if (!c.running) showIsland(c.fail ? "var(--bad)" : "var(--ok)", c.fail ? "x" : "checkCircle", c.fail ? `${plural(c.fail, "check")} failed` : "All checks passed", `PR #${S.pr.number}`);
  }, 1200);
  load(Object.keys(SCENARIOS)[0]);
}

// ── One-click chains ────────────────────────────────────────
const STEP = {
  pull: { verb: "Pulling", done: "Pulled", icon: "cloudDown" },
  commit: { verb: "Committing", done: "Committed", icon: "commit" },
  push: { verb: "Pushing", done: "Pushed", icon: "cloudUp" },
  pr: { verb: "Opening PR", done: "PR opened", icon: "pr" },
};
const GOALS = ["commit", "push", "pr"];
/** How far a click goes when nobody picked: like the current quick action. */
function defaultGoal(s) {
  return s.pr && s.pr.state === "open" ? "push" : "pr";
}
/** The steps a click runs to reach `goal`, skipping what is already done. */
function planChain(s, goal = defaultGoal(s)) {
  const st = stats(s);
  const g = GOALS.indexOf(goal);
  const steps = [];
  if (st.files) steps.push("commit");
  if (g >= 1) {
    if (st.behind) steps.push("pull");
    if (st.ahead || st.files) steps.push("push");
  }
  if (g >= 2 && !(s.pr && s.pr.state === "open")) {
    const fresh = s.pr?.state === "merged" ? st.ahead || st.files : s.branchCommits || st.files;
    if (fresh) steps.push("pr");
  }
  return steps;
}
const STEP_WORD = { commit: "commit", pull: "pull", push: "push", pr: "create PR" };
function chainLabel(steps, s) {
  if (!steps.length) return s.pr && s.pr.state === "open" ? `View PR #${s.pr.number}` : "Up to date";
  const words = steps.map((x) => STEP_WORD[x]);
  const text = words.length === 1 ? words[0] : `${words.slice(0, -1).join(", ")} & ${words.at(-1)}`;
  return text[0].toUpperCase() + text.slice(1);
}
function stepDetail(step, s) {
  const st = stats(s);
  switch (step) {
    case "commit":
      return plural(st.files, "file");
    case "pull":
      return `${st.behind} incoming`;
    case "push":
      return s.upstream ? `to origin` : "new branch";
    case "pr":
      return "into main";
  }
}
let chainCancel = false;
/** Runs the steps one after another; the island and the caller's UI show progress. */
async function runChain(steps, { delay = 0 } = {}) {
  if (S.busy || !steps.length) {
    if (!steps.length && S.pr?.state === "open") run("openpr");
    return;
  }
  chainCancel = false;
  S.busy = "chain";
  // Step details are frozen at the click, so "3 files" stays "3 files" while it runs.
  S.chain = { steps, i: -1, total: steps.length, details: steps.map((x) => stepDetail(x, S)) };
  if (delay) {
    S.chain.counting = true;
    showIsland("var(--inf)", "loader", `Shipping in a moment…`, `${chainLabel(steps, S)} · Esc to cancel`, true);
    renderAll();
    await sleep(delay);
    S.chain.counting = false;
    if (chainCancel) {
      S.busy = null;
      S.chain = null;
      renderAll();
      showIsland("var(--isl-muted)", "x", "Cancelled", "Nothing was changed");
      return;
    }
  }
  let prNumber = null;
  for (let i = 0; i < steps.length; i++) {
    S.chain.i = i;
    const step = steps[i];
    showIsland("var(--isl-muted)", "loader", `${STEP[step].verb}… ${i + 1}/${steps.length}`, stepDetail(step, S), true);
    renderAll();
    await sleep(step === "pr" ? 1000 : 800);
    if (step === "pr") {
      S.pr = newPr(S);
      prNumber = S.pr.number;
    } else ACTIONS[step].run(S);
  }
  S.chain = null;
  S.busy = null;
  renderAll();
  const last = steps.at(-1);
  showIsland("var(--ok)", "checkCircle", prNumber ? `Shipped · PR #${prNumber} opened` : `${STEP[last].done}`, chainLabel(steps, { pr: null }) + " · done");
}
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && S?.chain?.counting) chainCancel = true;
});
/** Step chips: what one click will do, and live progress while it runs. */
function stepChips(steps, s, { vertical = false } = {}) {
  if (!steps.length) return "";
  const running = s.chain;
  return `<ol class="chips ${vertical ? "vert" : ""}">${steps
    .map((step, i) => {
      const state = !running ? "todo" : i < running.i ? "done" : i === running.i ? "now" : "todo";
      const icon = state === "done" ? I("check", "xs") : state === "now" ? I("loader", "xs spin") : I(STEP[step].icon, "xs");
      return `<li class="chip" data-state="${state}">${icon}<span>${STEP_WORD[step][0].toUpperCase() + STEP_WORD[step].slice(1)}</span><small>${running?.details?.[i] ?? stepDetail(step, s)}</small></li>`;
    })
    .join(vertical ? "" : '<li class="arrow" aria-hidden="true">›</li>')}</ol>`;
}
