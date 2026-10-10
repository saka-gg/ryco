/* ============================================================
   Data: one person's projects as Ryco models them.
   project (logical, by repository)
     └ checkout (the project on one device: a folder)
         └ workspace (main checkout or a worktree: a branch on disk)
             └ thread (a conversation running in that workspace)
   Pull requests / issues / Jira items are where a worktree came from.
   The same branch can be checked out on two devices.
   ============================================================ */
Object.assign(IC, {
  folder:
    '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  folderMinus:
    '<path d="M9 13h6"/><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  minus: '<path d="M5 12h14"/>',
  fit: '<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  alert:
    '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  dot: '<circle cx="12" cy="12" r="4"/>',
  layers:
    '<path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/>',
  list: '<path d="M3 12h.01"/><path d="M3 18h.01"/><path d="M3 6h.01"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M8 6h13"/>',
  map: '<path d="M14.106 5.553a2 2 0 0 0 1.788 0l3.659-1.83A1 1 0 0 1 21 4.619v12.764a1 1 0 0 1-.553.894l-4.553 2.277a2 2 0 0 1-1.788 0l-4.212-2.106a2 2 0 0 0-1.788 0l-3.659 1.83A1 1 0 0 1 3 19.381V6.618a1 1 0 0 1 .553-.894l4.553-2.277a2 2 0 0 1 1.788 0z"/><path d="M15 5.764v15"/><path d="M9 3.236v15"/>',
  jira: '<path d="M11.53 2c0 2.4 1.97 4.35 4.35 4.35h1.78v1.7c0 2.4 1.94 4.34 4.34 4.35V2.84a.84.84 0 0 0-.84-.84z"/><path d="M6.77 6.8a4.36 4.36 0 0 0 4.34 4.34h1.8v1.72a4.36 4.36 0 0 0 4.34 4.34V7.63a.84.84 0 0 0-.83-.83z"/><path d="M2 11.6c0 2.4 1.95 4.34 4.35 4.34h1.78v1.72c.01 2.39 1.95 4.33 4.34 4.34v-9.57a.84.84 0 0 0-.84-.84z"/>',
  issue: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="1"/>',
  cloud: '<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/>',
  commit:
    '<circle cx="12" cy="12" r="3"/><line x1="3" x2="9" y1="12" y2="12"/><line x1="15" x2="21" y1="12" y2="12"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  clock2: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  zap: '<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>',
  calendar:
    '<path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/>',
  shield:
    '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>',
  pauseC:
    '<circle cx="12" cy="12" r="10"/><line x1="10" x2="10" y1="15" y2="9"/><line x1="14" x2="14" y1="15" y2="9"/>',
  hand: '<path d="M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2"/><path d="M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2"/><path d="M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/>',
});

/* Devices: where checkouts live. `self` is the device you are on. */
const DEVICES = {
  mac: {
    id: "mac",
    name: "MacBook Pro",
    icon: "laptop",
    self: true,
    os: "macOS 26",
    conn: "online",
  },
  studio: {
    id: "studio",
    name: "Studio",
    icon: "monitor",
    os: "Ubuntu 26.04",
    conn: "online",
    via: "Tailscale",
  },
  hub: {
    id: "hub",
    name: "hub-eu-1",
    icon: "cloud",
    os: "Linux · cloud node",
    conn: "connecting",
    via: "Ryco Hub relay",
  },
};

/* Thread status vocabulary (shared with the inbox lab). */
const STATUS = {
  working: { label: "Working", tone: "info" },
  input: { label: "Needs input", tone: "warn" },
  done: { label: "Done", tone: "ok" },
  error: { label: "Error", tone: "err" },
  idle: { label: "Idle", tone: "zinc" },
  archived: { label: "Archived", tone: "faint" },
};

const t = (id, title, status, provider, ago, by) => ({
  id,
  title,
  status,
  provider,
  ago,
  ...(by ? { by } : {}),
});

/* Automation run states, as the server names them (AgentControlAutomationRunStatus).
   Every due run waits for approval before it starts a thread. */
const RUN_STATUS = {
  "pending-approval": { label: "Waiting for approval", tone: "warn" },
  approved: { label: "Approved", tone: "info" },
  executing: { label: "Running", tone: "info" },
  completed: { label: "Completed", tone: "ok" },
  failed: { label: "Failed", tone: "err" },
  rejected: { label: "Rejected", tone: "zinc" },
  expired: { label: "Expired", tone: "zinc" },
};

/* An automation lives on one device (its server runs the schedule) for one
   project. Schedules are "once" or a fixed interval with a required end.
   envMode: "worktree" runs each occurrence in a fresh worktree off baseRef;
   "local" runs in the main checkout. nextIn / every are minutes. */
const auto = (id, o) => ({ id, enabled: true, runs: [], ...o });

/* Minutes-ago timestamps keep the data stable in screenshots. */
function INIT_PROJECTS() {
  return [
    {
      id: "ryco",
      name: "ryco",
      repo: "sak0a/ryco",
      hue: 258,
      prs: {
        663: { number: 663, title: "Add a projects page", state: "open", checks: "running" },
        671: {
          number: 671,
          title: "Show Claude prompt cache usage",
          state: "merged",
          checks: "passed",
        },
        674: {
          number: 674,
          title: "Recover saved thread bodies after connection loss",
          state: "open",
          checks: "failed",
        },
      },
      checkouts: [
        {
          id: "ryco@mac",
          device: "mac",
          path: "~/Code/ryco",
          automations: [
            auto("a1", {
              title: "Nightly dependency check",
              provider: "codex",
              schedule: { kind: "interval", every: 60 * 24, until: "Dec 31" },
              envMode: "worktree",
              baseRef: "main",
              nextIn: 60 * 9 + 12,
              runs: [{ id: "r1", status: "completed", ago: 60 * 15, threads: ["t2"] }],
            }),
            auto("a2", {
              title: "Triage new issues",
              provider: "claude",
              schedule: { kind: "interval", every: 30, until: "Oct 31" },
              envMode: "local",
              nextIn: 7,
              runs: [{ id: "r2", status: "completed", ago: 23, threads: ["t16"] }],
            }),
          ],
          workspaces: [
            {
              id: "w-ryco-main",
              main: true,
              branch: "main",
              path: "~/Code/ryco",
              ahead: 0,
              behind: 3,
              threads: [
                t("t1", "Fix the relay reconnect", "working", "claude", 2),
                t("t2", "Bump Effect to beta.31", "done", "codex", 54, "a1"),
                t("t16", "Triage: 3 new issues", "done", "claude", 23, "a2"),
              ],
            },
            {
              id: "w-ryco-projects",
              branch: "projects-page",
              origin: { kind: "pr", ref: 663 },
              path: "~/.ryco/worktrees/ryco/projects-page",
              changes: { modified: 2, untracked: 1 },
              unmerged: true,
              threads: [
                t("t3", "Add a projects page", "input", "claude", 6),
                t("t4", "Projects page motion polish", "idle", "claude", 180),
              ],
            },
            {
              id: "w-ryco-relay",
              branch: "fix/relay-reconnect",
              origin: { kind: "issue", ref: 412 },
              path: "~/.ryco/worktrees/ryco/relay-reconnect",
              threads: [t("t5", "Repro the reconnect storm", "error", "codex", 25)],
            },
            {
              id: "w-ryco-old",
              branch: "old-experiment",
              path: "~/.ryco/worktrees/ryco/old-experiment",
              archived: true,
              checkoutRemoved: true,
              threads: [t("t6", "Try a WebGPU transcript", "archived", "cursor", 60 * 24 * 30)],
            },
          ],
        },
        {
          id: "ryco@studio",
          device: "studio",
          path: "~/src/ryco",
          automations: [
            auto("a3", {
              title: "Linux build smoke test",
              provider: "codex",
              schedule: { kind: "interval", every: 120, until: "Nov 15" },
              envMode: "worktree",
              baseRef: "main",
              nextIn: 48,
              runs: [
                {
                  id: "r3",
                  status: "failed",
                  ago: 72,
                  threads: ["t17"],
                  detail: "bun install timed out after 10 min",
                },
              ],
            }),
          ],
          workspaces: [
            {
              id: "w-ryco-studio-main",
              main: true,
              branch: "main",
              path: "~/src/ryco",
              behind: 0,
              threads: [t("t7", "Profile the Linux build", "done", "codex", 300)],
            },
            {
              id: "w-ryco-studio-smoke",
              branch: "auto/linux-smoke-1005",
              path: "~/.ryco/worktrees/ryco/linux-smoke-1005",
              threads: [t("t17", "Linux build smoke test", "error", "codex", 72, "a3")],
            },
            {
              id: "w-ryco-studio-projects",
              branch: "projects-page",
              origin: { kind: "pr", ref: 663 },
              path: "~/.ryco/worktrees/ryco/projects-page",
              threads: [t("t8", "Check the page on Wayland", "idle", "opencode", 95)],
            },
            {
              id: "w-ryco-studio-linux",
              branch: "RYCO-88-linux-tray",
              origin: { kind: "jira", ref: "RYCO-88" },
              path: "~/.ryco/worktrees/ryco/linux-tray",
              changes: { modified: 5, untracked: 0 },
              threads: [t("t9", "Linux tray icon", "working", "codex", 1)],
            },
          ],
        },
        {
          id: "ryco@hub",
          device: "hub",
          path: "/srv/ryco",
          automations: [
            auto("a4", {
              title: "Weekly release notes",
              provider: "claude",
              schedule: { kind: "interval", every: 60 * 24 * 7, until: "Mar 1" },
              envMode: "worktree",
              baseRef: "main",
              nextIn: 60 * 24 * 3 + 60 * 4,
            }),
            auto("a5", {
              title: "Summarise relay logs",
              provider: "codex",
              schedule: { kind: "interval", every: 60 * 6, until: "Oct 20" },
              envMode: "local",
              enabled: false,
              nextIn: null,
              runs: [{ id: "r5", status: "rejected", ago: 60 * 30, threads: [] }],
            }),
          ],
          workspaces: [
            {
              id: "w-ryco-hub-main",
              main: true,
              branch: "main",
              path: "/srv/ryco",
              threads: [],
            },
            {
              id: "w-ryco-hub-674",
              branch: "fix/saved-thread-bodies",
              origin: { kind: "pr", ref: 674 },
              path: "/srv/ryco/.worktrees/saved-thread-bodies",
              missing: true,
              threads: [t("t10", "Recover saved thread bodies", "idle", "claude", 60 * 8)],
            },
          ],
        },
      ],
    },
    {
      id: "ryco-hub",
      name: "ryco-hub",
      repo: "sak0a/ryco-hub",
      hue: 160,
      prs: {
        155: { number: 155, title: "Pin node to eef0eb858", state: "merged", checks: "passed" },
      },
      checkouts: [
        {
          id: "hub@mac",
          device: "mac",
          path: "~/Code/ryco-hub",
          workspaces: [
            {
              id: "w-hub-main",
              main: true,
              branch: "main",
              path: "~/Code/ryco-hub",
              threads: [t("t11", "Rotate relay keys", "idle", "claude", 60 * 26)],
            },
            {
              id: "w-hub-pin",
              branch: "pin-node-eef0eb8",
              origin: { kind: "pr", ref: 155 },
              path: "~/.ryco/worktrees/ryco-hub/pin-node",
              threads: [t("t12", "Bump the node pin", "archived", "codex", 60 * 24 * 2)],
              allArchivedDays: 2,
            },
          ],
        },
        {
          id: "hub@hub",
          device: "hub",
          path: "/srv/ryco-hub",
          automations: [
            auto("a6", {
              title: "Rotate relay keys",
              provider: "claude",
              schedule: { kind: "once", at: "Oct 9 · 10:00" },
              envMode: "local",
              nextIn: 60 * 24 * 4 - 60 * 2,
            }),
          ],
          workspaces: [
            {
              id: "w-hubhub-main",
              main: true,
              branch: "main",
              path: "/srv/ryco-hub",
              threads: [t("t13", "Tail relay logs", "working", "codex", 4)],
            },
          ],
        },
      ],
    },
    {
      id: "scratch",
      name: "scratch",
      repo: null,
      hue: 30,
      prs: {},
      checkouts: [
        {
          id: "scratch@mac",
          device: "mac",
          path: "~/tmp/scratch",
          git: false,
          workspaces: [
            {
              id: "w-scratch",
              main: true,
              branch: null,
              path: "~/tmp/scratch",
              threads: [t("t14", "Sketch a CSV importer", "done", "claude", 60 * 50)],
            },
          ],
        },
      ],
    },
  ];
}

/* ------------------------------------------------------------ store */
const S = {
  projects: INIT_PROJECTS(),
  projectId: "ryco",
  selected: null, // { kind, id }
  showArchived: true,
  playing: true,
  simT: 0,
};
const listeners = [];
const emit = () => listeners.forEach((fn) => fn(S));
const project = () => S.projects.find((p) => p.id === S.projectId);

/* Flat lookups the directions use. */
function index(p = project()) {
  const devices = [];
  const workspaces = [];
  const threads = [];
  const automations = [];
  for (const checkout of p.checkouts) {
    devices.push({ ...DEVICES[checkout.device], checkout });
    for (const a of checkout.automations ?? [])
      automations.push({ ...a, device: checkout.device, checkoutId: checkout.id });
    for (const w of checkout.workspaces) {
      workspaces.push({ ...w, device: checkout.device, checkoutId: checkout.id });
      for (const th of w.threads)
        threads.push({ ...th, workspaceId: w.id, device: checkout.device });
    }
  }
  /* Branches checked out on more than one device. */
  const byBranch = {};
  for (const w of workspaces) if (w.branch) (byBranch[w.branch] ??= []).push(w);
  const shared = Object.fromEntries(
    Object.entries(byBranch).filter(([, ws]) => ws.length > 1 && !ws[0].main),
  );
  return { p, devices, workspaces, threads, automations, byBranch, shared };
}

/* What a workspace needs the reader to know, stated once. */
function workspaceFacts(w) {
  const facts = [];
  if (w.checkoutRemoved) facts.push({ label: "Checkout removed", tone: "muted" });
  else if (w.missing) facts.push({ label: "Checkout missing", tone: "warn" });
  if (w.changes && !w.checkoutRemoved) {
    const parts = [
      w.changes.modified ? `${w.changes.modified} modified` : null,
      w.changes.untracked ? `${w.changes.untracked} untracked` : null,
    ].filter(Boolean);
    if (parts.length) facts.push({ label: parts.join(", "), tone: "warn" });
  }
  if (w.unmerged) facts.push({ label: "Unmerged commits", tone: "warn" });
  if (w.behind) facts.push({ label: `${w.behind} behind`, tone: "muted" });
  return facts;
}

/* Thread tally for compact chips. */
function tally(threads) {
  const out = { working: 0, input: 0, done: 0, error: 0, idle: 0, archived: 0 };
  for (const th of threads) out[th.status] += 1;
  return out;
}

function originLabel(p, w) {
  if (!w.origin) return w.main ? "Main checkout" : "Branch";
  if (w.origin.kind === "pr") return `#${w.origin.ref}`;
  if (w.origin.kind === "issue") return `issue #${w.origin.ref}`;
  return w.origin.ref;
}

/* "Every 30 min · until Oct 31", "Daily", "Once · Oct 9 · 10:00" */
function scheduleLabel(a) {
  if (a.schedule.kind === "once") return `Once · ${a.schedule.at}`;
  const m = a.schedule.every;
  const every =
    m % (60 * 24 * 7) === 0
      ? m === 60 * 24 * 7
        ? "Weekly"
        : `Every ${m / (60 * 24 * 7)} weeks`
      : m % (60 * 24) === 0
        ? m === 60 * 24
          ? "Daily"
          : `Every ${m / (60 * 24)} days`
        : m % 60 === 0
          ? m === 60
            ? "Hourly"
            : `Every ${m / 60} h`
          : `Every ${m} min`;
  return `${every} · until ${a.schedule.until}`;
}
const inLabel = (min) =>
  min == null
    ? "Paused"
    : min <= 0
      ? "now"
      : min < 60
        ? `in ${min}m`
        : min < 60 * 24
          ? `in ${Math.floor(min / 60)}h ${min % 60 ? `${min % 60}m` : ""}`.trim()
          : `in ${Math.round(min / 60 / 24)}d`;
/* Share of the interval already elapsed (for countdown rings). */
const cycle = (a) =>
  a.nextIn == null || a.schedule.kind === "once" ? 0 : 1 - a.nextIn / a.schedule.every;
/* The run that is happening now, if any. */
const activeRun = (a) =>
  a.runs.find((r) => ["pending-approval", "approved", "executing"].includes(r.status)) ?? null;

const agoLabel = (min) =>
  min < 1
    ? "now"
    : min < 60
      ? `${min}m`
      : min < 60 * 24
        ? `${Math.round(min / 60)}h`
        : `${Math.round(min / 60 / 24)}d`;

/* ------------------------------------------------------------ live simulation
   A short loop of real lifecycle moments so motion has something to show:
   a turn finishes, a question arrives, a worktree is created on another
   device, a finished checkout is removed (record kept), a device connects. */
const SCRIPT = [
  [3, "t1 finishes", (P) => setThread(P, "t1", "done")],
  [5, "hub connects", () => (DEVICES.hub.conn = "online")],
  [
    7,
    "studio opens PR #671 in a worktree",
    (P) =>
      addWorkspace(P, "ryco@studio", {
        id: "w-ryco-studio-671",
        branch: "claude-cache-usage",
        origin: { kind: "pr", ref: 671 },
        path: "~/.ryco/worktrees/ryco/claude-cache-usage",
        fresh: true,
        threads: [t("t15", "Review the cache meter", "working", "claude", 0)],
      }),
  ],
  [7, "“Triage new issues” is due: waiting for approval", (P) => startRun(P, "a2", "r6")],
  [
    9,
    "Run approved: triage starts on the MacBook",
    (P) =>
      approveRun(
        P,
        "a2",
        "r6",
        "w-ryco-main",
        t("t18", "Triage: 2 new issues", "working", "claude", 0, "a2"),
      ),
  ],
  [10, "t9 asks a question", (P) => setThread(P, "t9", "input")],
  [
    13,
    "hub-pin checkout removed",
    (P) => patchWorkspace(P, "w-hub-pin", { checkoutRemoved: true, archived: true }),
  ],
  [16, "t15 finishes", (P) => setThread(P, "t15", "done")],
  [15, "Triage run completed", (P) => finishRun(P, "a2", "r6")],
  [19, "t3 answered, working again", (P) => setThread(P, "t3", "working")],
];
const LOOP = 24;

function setThread(P, id, status) {
  for (const p of P)
    for (const c of p.checkouts)
      for (const w of c.workspaces)
        for (const th of w.threads)
          if (th.id === id) {
            th.status = status;
            th.ago = 0;
          }
}
function addWorkspace(P, checkoutId, w) {
  for (const p of P)
    for (const c of p.checkouts)
      if (c.id === checkoutId && !c.workspaces.some((x) => x.id === w.id)) c.workspaces.push(w);
}
function patchWorkspace(P, id, patch) {
  for (const p of P)
    for (const c of p.checkouts)
      for (const w of c.workspaces) if (w.id === id) Object.assign(w, patch);
}

function eachAutomation(P, fn) {
  for (const p of P) for (const c of p.checkouts) for (const a of c.automations ?? []) fn(a, c);
}
function startRun(P, aid, rid) {
  eachAutomation(P, (a) => {
    if (a.id !== aid || a.runs.some((r) => r.id === rid)) return;
    a.runs.unshift({ id: rid, status: "pending-approval", ago: 0, threads: [] });
    a.nextIn = a.schedule.every;
  });
}
/* Scripted steps only advance a run that is still where the script left it:
   a run the user approved or rejected by hand keeps the user's outcome. */
function approveRun(P, aid, rid, wsId, thread) {
  let approved = false;
  eachAutomation(P, (a) => {
    const run = a.id === aid && a.runs.find((r) => r.id === rid);
    if (!run || run.status !== "pending-approval") return;
    run.status = "executing";
    run.threads = [thread.id];
    approved = true;
  });
  if (!approved) return;
  for (const p of P)
    for (const c of p.checkouts)
      for (const w of c.workspaces)
        if (w.id === wsId && !w.threads.some((x) => x.id === thread.id)) w.threads.unshift(thread);
}
function finishRun(P, aid, rid) {
  eachAutomation(P, (a) => {
    const run = a.id === aid && a.runs.find((r) => r.id === rid);
    if (!run || run.status !== "executing") return;
    run.status = "completed";
    for (const id of run.threads) setThread(P, id, "done");
  });
}

let lastEvent = null;
function tick() {
  S.simT += 1;
  /* One simulated second is one minute on the schedule clock. */
  eachAutomation(S.projects, (a) => {
    if (a.enabled && a.nextIn != null && a.nextIn > 0 && a.id !== "a2") a.nextIn -= 1;
    else if (a.id === "a2" && a.nextIn > 0) a.nextIn -= 1;
    for (const r of a.runs) r.ago += 1;
  });
  const at = S.simT % LOOP;
  if (at === 0) {
    resetData();
    lastEvent = "loop";
    return;
  }
  for (const [when, label, run] of SCRIPT)
    if (when === at) {
      run(S.projects);
      lastEvent = label;
    }
}
function resetData() {
  S.projects = INIT_PROJECTS();
  DEVICES.hub.conn = "connecting";
}
