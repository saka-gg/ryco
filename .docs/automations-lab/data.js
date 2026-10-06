/* ============================================================
   Seed state for the automations lab.

   Globals: S, listeners, emit()          (everything else is private)

   All times are numbers (local ms since epoch), never ISO strings.
   Field names mirror packages/contracts (AgentControlAutomation,
   AgentControlAutomationRun, AgentControlProposal) where they exist.

   S.now          sim clock (ms). Starts at Wed Oct 7 2026 10:42 local.
   S.tz           "Europe/Berlin" (from Intl)
   S.speed        1 | 60      sim seconds per real second
   S.playing      sim running
   S.devices      [{ id, name, icon, self, online }]
   S.projects     [{ id, name, repo, hue, checkouts: [{ deviceId, path, branch }], refs: [] }]
   S.providers    [{ instanceId, id, name, models: [{ slug, name, default? }],
                     options: [{ id, label, values: [{ id, label }], default }] }]
   S.threads      [{ id, title, projectId, deviceId, automationId, runId, createdAt }]
   S.automations  [{ id, automationId, projectId, deviceId, providerInstanceId,
                     definition: { execution, schedule, enabled }, revision,
                     enabled, cancelled, cancelledAt, nextRunAt, createdAt, updatedAt }]
                     + read-only getters: title, prompt, schedule, execution,
                       modelSelection, runtimeMode, envMode, baseRef
     execution:   { projectId, title, prompt, runtimeMode, envMode, baseRef?,
                    modelSelection: { instanceId, model, options: [{ id, value }] } }
     schedule:    { kind: "once", runAt } |
                  { kind: "fixed-interval", startsAt, intervalMs, endsAt }
   S.runs         [{ id, runId, automationId, automationRevision, projectId, deviceId,
                     providerInstanceId, execution, scheduledFor,
                     coalescedOccurrences,   // missed occurrences folded in (0 = on time)
                     status,                 // materializing | pending-approval | approved |
                                             // executing | completed | failed | rejected |
                                             // expired | cancelled
                     proposalId, safeFailureDetail, threadIds: [], unread, retryOfRunId,
                     createdAt, updatedAt, expiresAt (pending only), completedAt }]
                     + getter: title
   S.proposals    schedule changes only (run approvals live on the run):
                  [{ id, proposalId, kind: "create"|"edit"|"pause"|"resume"|"cancel",
                     plan: { kind: "createAutomation"|"updateAutomation"|"cancelAutomation" },
                     automationId, projectId, deviceId, before (definition|null),
                     after (definition|null), expectedRevision,
                     status: "pending-user-approval"|"approved"|"rejected"|"expired"|"failed"|"superseded",
                     detail, createdAt, updatedAt, expiresAt, decidedAt }]
                     + getters: pending (bool), title, def (after ?? before)

   Every array also answers by id: S.runs["r-triage-9"], S.devices.studio
   (non-enumerable, refreshed by emit()).
   S.reset() restores the seed in place (same S object).
   ============================================================ */
const S = {};
const listeners = [];

/* Notify every listener. Synchronous, so a caller can act.save() and find the
   new row in the DOM on the next line. A failing listener cannot starve the
   others; its error is re-thrown asynchronously so it still surfaces. */
function emit() {
  S._reindex();
  for (const fn of listeners.slice()) {
    try {
      fn(S);
    } catch (err) {
      setTimeout(() => {
        throw err;
      });
    }
  }
}

(() => {
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;
  const WEEK = 7 * DAY;
  const REF_NOW = new Date("2026-10-07T10:42:00").getTime();
  const TTL = 15 * MIN;
  const at = (mo, d, hh = 0, mm = 0) => new Date(2026, mo - 1, d, hh, mm).getTime();

  /* ---------------------------------------------------------- prototypes */
  const AutomationProto = {
    get title() {
      return this.definition.execution.title;
    },
    get prompt() {
      return this.definition.execution.prompt;
    },
    get execution() {
      return this.definition.execution;
    },
    get schedule() {
      return this.definition.schedule;
    },
    get modelSelection() {
      return this.definition.execution.modelSelection;
    },
    get runtimeMode() {
      return this.definition.execution.runtimeMode;
    },
    get envMode() {
      return this.definition.execution.envMode;
    },
    get baseRef() {
      return this.definition.execution.baseRef ?? null;
    },
  };
  const RunProto = {
    get title() {
      return this.execution?.title ?? "";
    },
  };
  const ProposalProto = {
    get pending() {
      return this.status === "pending-user-approval";
    },
    get def() {
      return this.after ?? this.before;
    },
    get title() {
      return (this.after ?? this.before)?.execution.title ?? "";
    },
  };
  /* Exposed so core.js builds records with the same getters. */
  Object.defineProperty(S, "_proto", {
    value: { automation: AutomationProto, run: RunProto, proposal: ProposalProto },
  });

  /* ---------------------------------------------------------- reference data */
  const devices = () => [
    { id: "mac", name: "This Mac", icon: "laptop", self: true, online: true },
    { id: "studio", name: "Studio", icon: "server", self: false, online: true },
  ];
  const projects = () => [
    {
      id: "ryco",
      name: "ryco",
      repo: "sak0a/ryco",
      hue: 255,
      checkouts: [
        { deviceId: "mac", path: "~/Code/ryco", branch: "main" },
        { deviceId: "studio", path: "~/code/ryco", branch: "main" },
      ],
      refs: ["main", "release/0.14", "ryco/automations-page", "ryco/remote-connect"],
    },
    {
      id: "ryco-hub",
      name: "ryco-hub",
      repo: "sak0a/ryco-hub",
      hue: 160,
      checkouts: [{ deviceId: "mac", path: "~/Code/ryco-hub", branch: "main" }],
      refs: ["main", "staging"],
    },
    {
      id: "scratch",
      name: "scratch",
      repo: null,
      hue: 40,
      checkouts: [{ deviceId: "mac", path: "~/scratch", branch: "main" }],
      refs: ["main"],
    },
  ];
  const providers = () => [
    {
      instanceId: "claude",
      id: "claude",
      driver: "claude",
      name: "Claude",
      models: [
        { slug: "claude-sonnet-5-5", name: "Sonnet 5.5", default: true },
        { slug: "claude-opus-5-5", name: "Opus 5.5" },
        { slug: "claude-fable-5-1", name: "Fable 5.1" },
      ],
      options: [
        {
          id: "effort",
          label: "Effort",
          values: [
            { id: "low", label: "Low" },
            { id: "medium", label: "Medium" },
            { id: "high", label: "High" },
          ],
          default: "medium",
        },
      ],
    },
    {
      instanceId: "codex",
      id: "codex",
      driver: "codex",
      name: "Codex",
      models: [
        { slug: "gpt-5.5", name: "GPT-5.5", default: true },
        { slug: "gpt-5.5-mini", name: "GPT-5.5 mini" },
      ],
      options: [],
    },
  ];

  /* ---------------------------------------------------------- schedules */
  const claude = (model, effort) => ({
    instanceId: "claude",
    model,
    options: [{ id: "effort", value: effort }],
  });
  const codex = (model) => ({ instanceId: "codex", model, options: [] });
  const every = (startsAt, intervalMs, endsAt) => ({
    kind: "fixed-interval",
    startsAt,
    intervalMs,
    endsAt,
  });

  /* First occurrence strictly after `now` (null when the schedule has ended). */
  function nextAfter(schedule, now) {
    if (schedule.kind === "once") return schedule.runAt > now ? schedule.runAt : null;
    const { startsAt, intervalMs, endsAt } = schedule;
    const k = startsAt > now ? 0 : Math.floor((now - startsAt) / intervalMs) + 1;
    const t = startsAt + k * intervalMs;
    return t <= endsAt ? t : null;
  }

  const DEFS = [
    {
      id: "a-deps",
      projectId: "ryco",
      deviceId: "studio",
      revision: 2,
      createdAt: at(9, 23, 18, 5),
      updatedAt: at(10, 1, 9, 12),
      execution: {
        title: "Nightly dependency check",
        prompt:
          "Run `bun outdated` across the workspace. Bump patch and minor updates whose upstream CI is green in one branch, then run `bun typecheck` and `bun run test`. Open a draft PR that lists what changed and why. List major updates separately and leave them alone.",
        modelSelection: claude("claude-sonnet-5-5", "medium"),
        runtimeMode: "auto-accept-edits",
        envMode: "worktree",
        baseRef: "main",
      },
      schedule: every(at(9, 24, 3, 0), DAY, at(10, 31, 3, 0)),
    },
    {
      id: "a-triage",
      projectId: "ryco",
      deviceId: "mac",
      revision: 1,
      createdAt: at(10, 6, 8, 31),
      updatedAt: at(10, 6, 8, 31),
      execution: {
        title: "Triage new issues",
        prompt:
          "Look at GitHub issues opened since the last run. Label each one bug, feature or question, link duplicates, and ask for a reproduction where one is missing. Don't close anything. End with a one-paragraph summary.",
        modelSelection: codex("gpt-5.5"),
        runtimeMode: "approval-required",
        envMode: "local",
      },
      schedule: every(at(10, 6, 8, 40), 2 * HOUR, at(10, 20, 18, 40)),
    },
    {
      id: "a-relay",
      projectId: "ryco-hub",
      deviceId: "mac",
      revision: 1,
      createdAt: at(10, 5, 9, 2),
      updatedAt: at(10, 5, 9, 2),
      execution: {
        title: "Summarise relay logs",
        prompt:
          "Read the last hour of relay logs in logs/relay/*.ndjson. Summarise reconnect storms, ticket failures and p95 handshake latency against the previous hour. Flag anything that looks like a regression. Don't change code.",
        modelSelection: claude("claude-opus-5-5", "high"),
        runtimeMode: "approval-required",
        envMode: "local",
      },
      schedule: every(at(10, 5, 9, 15), HOUR, at(10, 12, 9, 15)),
      // The Mac slept 07:00–10:36: four occurrences came due, one approval.
      nextRunAt: at(10, 7, 11, 15),
    },
    {
      id: "a-ci",
      projectId: "ryco",
      deviceId: "studio",
      revision: 1,
      createdAt: at(10, 7, 8, 50),
      updatedAt: at(10, 7, 8, 50),
      execution: {
        title: "Watch main CI for flakes",
        prompt:
          "Check the latest GitHub Actions runs on main. If a job failed and passes on re-run, record it in .docs/flakes.md with the job, the test and a link, and open one issue per new flake. Do nothing when main is green.",
        modelSelection: codex("gpt-5.5-mini"),
        runtimeMode: "auto",
        envMode: "worktree",
        baseRef: "main",
      },
      schedule: every(at(10, 7, 9, 0), 30 * MIN, at(10, 9, 18, 0)),
    },
    {
      id: "a-changelog",
      projectId: "ryco",
      deviceId: "mac",
      revision: 1,
      createdAt: at(9, 17, 11, 20),
      updatedAt: at(9, 17, 11, 20),
      execution: {
        title: "Update the changelog",
        prompt:
          "Collect the PRs merged to main since the last release tag. Group them under Added, Changed and Fixed in CHANGELOG.md using the PR titles, with links. One line per entry; don't invent detail. Open a draft PR.",
        modelSelection: claude("claude-sonnet-5-5", "low"),
        runtimeMode: "auto-accept-edits",
        envMode: "worktree",
        baseRef: "main",
      },
      schedule: every(at(9, 18, 16, 0), WEEK, at(12, 11, 16, 0)),
    },
    {
      id: "a-e2e",
      projectId: "ryco",
      deviceId: "studio",
      revision: 3,
      enabled: false,
      createdAt: at(9, 29, 22, 10),
      updatedAt: at(10, 4, 9, 20),
      execution: {
        title: "Nightly e2e suite",
        prompt:
          "Build the web app and run `bun run --cwd apps/web test:browser`. Re-run a failing spec once; write up the failures that remain (spec, assertion, screenshot path). Don't change tests.",
        modelSelection: codex("gpt-5.4"),
        runtimeMode: "auto",
        envMode: "worktree",
        baseRef: "main",
      },
      schedule: every(at(9, 30, 1, 30), DAY, at(10, 28, 1, 30)),
    },
    {
      id: "a-certs",
      projectId: "ryco-hub",
      deviceId: "mac",
      revision: 1,
      createdAt: at(10, 2, 17, 45),
      updatedAt: at(10, 2, 17, 45),
      execution: {
        title: "Check staging certificates",
        prompt:
          "Check TLS certificate expiry for the staging relay, hub and pairing endpoints. Report anything that expires within 30 days with the exact date and the renewal steps from docs/ops/certs.md. Don't renew anything yourself.",
        modelSelection: codex("gpt-5.5"),
        runtimeMode: "approval-required",
        envMode: "local",
      },
      schedule: every(at(10, 3, 9, 0), 12 * HOUR, at(11, 2, 9, 0)),
    },
    {
      id: "a-release",
      projectId: "ryco",
      deviceId: "mac",
      revision: 1,
      createdAt: at(10, 7, 9, 48),
      updatedAt: at(10, 7, 9, 48),
      execution: {
        title: "Draft 0.14 release notes",
        prompt:
          "Draft release notes for 0.14 from the PRs merged to release/0.14: three short sections (Highlights, Fixes, Under the hood) in docs/releases/0.14.md. Plain language, no marketing tone. Open a draft PR.",
        modelSelection: claude("claude-opus-5-5", "high"),
        runtimeMode: "auto-accept-edits",
        envMode: "worktree",
        baseRef: "release/0.14",
      },
      schedule: { kind: "once", runAt: at(10, 7, 16, 0) },
    },
    {
      id: "a-sentry",
      projectId: "ryco",
      deviceId: "mac",
      revision: 2,
      cancelled: true,
      cancelledAt: at(10, 2, 16, 5),
      createdAt: at(9, 30, 19, 40),
      updatedAt: at(10, 2, 16, 5),
      execution: {
        title: "Summarise Sentry errors",
        prompt:
          "Summarise new Sentry issues for the web and desktop apps since the last run. Group by release, call out regressions, and link each issue. Don't create tickets.",
        modelSelection: claude("claude-sonnet-5-5", "medium"),
        runtimeMode: "approval-required",
        envMode: "local",
      },
      schedule: every(at(10, 1, 8, 0), 4 * HOUR, at(10, 31, 8, 0)),
    },
  ];

  function automation(d) {
    const enabled = d.enabled ?? true;
    const cancelled = d.cancelled ?? false;
    const a = Object.create(AutomationProto);
    Object.assign(a, {
      id: d.id,
      automationId: d.id,
      projectId: d.projectId,
      deviceId: d.deviceId,
      providerInstanceId: d.execution.modelSelection.instanceId,
      definition: {
        execution: { projectId: d.projectId, ...d.execution },
        schedule: d.schedule,
        enabled,
      },
      revision: d.revision,
      enabled,
      cancelled,
      cancelledAt: d.cancelledAt ?? null,
      nextRunAt:
        enabled && !cancelled
          ? d.nextRunAt !== undefined
            ? d.nextRunAt
            : nextAfter(d.schedule, REF_NOW)
          : null,
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
    });
    return a;
  }

  /* ---------------------------------------------------------- runs + threads */
  // [runId, automationId, scheduledFor, status, extra]
  const RUNS = [
    // Nightly dependency check — 03:00 approvals mostly expire unless retried.
    [
      "r-deps-11",
      "a-deps",
      at(10, 7, 3),
      "completed",
      {
        createdAt: at(10, 7, 8, 12),
        done: at(10, 7, 8, 13),
        thread: ["t-deps-1007", "Dependency check: 4 patch bumps, 1 major held back"],
        unread: true,
        retryOf: "r-deps-10",
      },
    ],
    ["r-deps-10", "a-deps", at(10, 7, 3), "expired", {}],
    [
      "r-deps-9",
      "a-deps",
      at(10, 6, 3),
      "completed",
      { done: at(10, 6, 3, 5), thread: ["t-deps-1006", "Dependency check: nothing to update"] },
    ],
    [
      "r-deps-8",
      "a-deps",
      at(10, 5, 3),
      "failed",
      { done: at(10, 5, 3, 6), detail: "Claude was rate limited, so the thread did not start." },
    ],
    ["r-deps-7", "a-deps", at(10, 4, 3), "expired", {}],
    [
      "r-deps-6",
      "a-deps",
      at(10, 3, 3),
      "completed",
      { done: at(10, 3, 3, 4), thread: ["t-deps-1003", "Dependency check: bump effect to 4.0.3"] },
    ],
    ["r-deps-5", "a-deps", at(10, 2, 3), "rejected", { done: at(10, 2, 3, 2) }],
    [
      "r-deps-4",
      "a-deps",
      at(10, 1, 3),
      "completed",
      { rev: 1, done: at(10, 1, 3, 7), thread: ["t-deps-1001", "Dependency check: 2 patch bumps"] },
    ],

    // Triage new issues — the approval due right now.
    ["r-triage-9", "a-triage", at(10, 7, 10, 40), "pending-approval", { unread: true }],
    [
      "r-triage-8",
      "a-triage",
      at(10, 7, 8, 40),
      "completed",
      {
        done: at(10, 7, 8, 44),
        thread: ["t-triage-0840", "Triage: 3 new issues, 1 duplicate of #412"],
        unread: true,
      },
    ],
    [
      "r-triage-7",
      "a-triage",
      at(10, 6, 22, 40),
      "expired",
      { coalesced: 4, createdAt: at(10, 7, 6, 58) },
    ],
    [
      "r-triage-6",
      "a-triage",
      at(10, 6, 20, 40),
      "completed",
      {
        done: at(10, 6, 20, 42),
        thread: ["t-triage-2040", "Triage: relay reconnect loop reported twice"],
      },
    ],
    ["r-triage-5", "a-triage", at(10, 6, 18, 40), "rejected", { done: at(10, 6, 18, 41) }],
    [
      "r-triage-4",
      "a-triage",
      at(10, 6, 16, 40),
      "failed",
      {
        done: at(10, 6, 16, 43),
        detail: "Codex app-server exited before the thread started (exit code 1).",
      },
    ],
    [
      "r-triage-3",
      "a-triage",
      at(10, 6, 14, 40),
      "completed",
      {
        done: at(10, 6, 14, 46),
        thread: ["t-triage-1440", "Triage: 5 new issues, asked for 2 repros"],
      },
    ],
    [
      "r-triage-2",
      "a-triage",
      at(10, 6, 12, 40),
      "completed",
      { done: at(10, 6, 12, 41), thread: ["t-triage-1240", "Triage: 2 new issues"] },
    ],
    [
      "r-triage-1",
      "a-triage",
      at(10, 6, 10, 40),
      "completed",
      { done: at(10, 6, 10, 44), thread: ["t-triage-1040", "Triage: backlog sweep, 11 labelled"] },
    ],
    ["r-triage-0", "a-triage", at(10, 6, 8, 40), "expired", {}],

    // Summarise relay logs — the Mac slept, three missed runs fold into one approval.
    [
      "r-relay-9",
      "a-relay",
      at(10, 7, 7, 15),
      "pending-approval",
      { coalesced: 3, createdAt: at(10, 7, 10, 36), unread: true },
    ],
    [
      "r-relay-8",
      "a-relay",
      at(10, 6, 19, 15),
      "expired",
      { coalesced: 11, createdAt: at(10, 7, 6, 40) },
    ],
    [
      "r-relay-7",
      "a-relay",
      at(10, 6, 18, 15),
      "completed",
      {
        done: at(10, 6, 18, 17),
        thread: ["t-relay-1815", "Relay: quiet hour, p95 handshake 182 ms"],
      },
    ],
    [
      "r-relay-6",
      "a-relay",
      at(10, 6, 17, 15),
      "completed",
      {
        done: at(10, 6, 17, 19),
        thread: ["t-relay-1715", "Relay: reconnect storm after the 17:02 deploy"],
      },
    ],
    ["r-relay-5", "a-relay", at(10, 6, 16, 15), "rejected", { done: at(10, 6, 16, 16) }],
    [
      "r-relay-4",
      "a-relay",
      at(10, 6, 15, 15),
      "completed",
      {
        done: at(10, 6, 15, 18),
        thread: ["t-relay-1515", "Relay: 3 ticket failures from one node"],
      },
    ],
    ["r-relay-3", "a-relay", at(10, 6, 14, 15), "expired", {}],
    [
      "r-relay-2",
      "a-relay",
      at(10, 6, 13, 15),
      "completed",
      {
        done: at(10, 6, 13, 16),
        thread: ["t-relay-1315", "Relay: p95 up 40 ms on the previous hour"],
      },
    ],

    // Watch main CI — one run starting now.
    ["r-ci-4", "a-ci", at(10, 7, 10, 30), "executing", { updatedAt: at(10, 7, 10, 41) }],
    [
      "r-ci-3",
      "a-ci",
      at(10, 7, 10, 0),
      "completed",
      {
        done: at(10, 7, 10, 2),
        thread: ["t-ci-1000", "CI: main is green, nothing to record"],
        unread: true,
      },
    ],
    [
      "r-ci-2",
      "a-ci",
      at(10, 7, 9, 30),
      "completed",
      { done: at(10, 7, 9, 31), thread: ["t-ci-0930", "CI: new flake in relay-reconnect.spec"] },
    ],
    ["r-ci-1", "a-ci", at(10, 7, 9, 0), "rejected", { done: at(10, 7, 9, 1) }],

    // Update the changelog
    [
      "r-chg-3",
      "a-changelog",
      at(10, 2, 16),
      "completed",
      { done: at(10, 2, 16, 4), thread: ["t-chg-1002", "Changelog: 14 PRs since v0.13.2"] },
    ],
    [
      "r-chg-2",
      "a-changelog",
      at(9, 25, 16),
      "completed",
      { done: at(9, 25, 16, 3), thread: ["t-chg-0925", "Changelog: 9 PRs"] },
    ],
    [
      "r-chg-1",
      "a-changelog",
      at(9, 18, 16),
      "completed",
      { done: at(9, 18, 16, 9), thread: ["t-chg-0918", "Changelog: first pass for 0.13"] },
    ],

    // Nightly e2e — paused after the model went away.
    [
      "r-e2e-5",
      "a-e2e",
      at(10, 4, 1, 30),
      "failed",
      {
        rev: 2,
        done: at(10, 4, 1, 33),
        detail: "Codex rejected the model: gpt-5.4 is unavailable",
        unread: true,
      },
    ],
    [
      "r-e2e-4",
      "a-e2e",
      at(10, 3, 1, 30),
      "failed",
      {
        rev: 2,
        done: at(10, 3, 1, 34),
        detail: "Codex rejected the model: gpt-5.4 is unavailable",
      },
    ],
    [
      "r-e2e-3",
      "a-e2e",
      at(10, 2, 1, 30),
      "completed",
      {
        rev: 2,
        done: at(10, 2, 1, 36),
        thread: ["t-e2e-1002", "E2E: 212 passed, pairing.spec flaky once"],
      },
    ],
    ["r-e2e-2", "a-e2e", at(10, 1, 1, 30), "expired", { rev: 1 }],
    [
      "r-e2e-1",
      "a-e2e",
      at(9, 30, 1, 30),
      "completed",
      { rev: 1, done: at(9, 30, 1, 41), thread: ["t-e2e-0930", "E2E: 211 passed"] },
    ],

    // Check staging certificates
    [
      "r-certs-7",
      "a-certs",
      at(10, 7, 9),
      "completed",
      {
        done: at(10, 7, 9, 6),
        thread: ["t-certs-1007", "Certificates: staging relay expires in 41 days"],
      },
    ],
    ["r-certs-6", "a-certs", at(10, 6, 21), "expired", {}],
    [
      "r-certs-5",
      "a-certs",
      at(10, 6, 9),
      "completed",
      {
        done: at(10, 6, 9, 3),
        thread: ["t-certs-1006", "Certificates: everything beyond 30 days"],
      },
    ],
    ["r-certs-4", "a-certs", at(10, 5, 21), "expired", {}],
    [
      "r-certs-3",
      "a-certs",
      at(10, 5, 9),
      "completed",
      {
        done: at(10, 5, 9, 12),
        thread: ["t-certs-1005", "Certificates: everything beyond 30 days"],
      },
    ],
    ["r-certs-2", "a-certs", at(10, 4, 21), "rejected", { done: at(10, 4, 21, 2) }],

    // Summarise Sentry errors — cancelled while a run waited.
    [
      "r-sentry-4",
      "a-sentry",
      at(10, 2, 16),
      "cancelled",
      { done: at(10, 2, 16, 5), detail: "Schedule changed before run approval." },
    ],
    [
      "r-sentry-3",
      "a-sentry",
      at(10, 2, 12),
      "completed",
      {
        done: at(10, 2, 12, 3),
        thread: ["t-sentry-1002", "Sentry: 3 new issues, 1 regression in relay"],
      },
    ],
    ["r-sentry-2", "a-sentry", at(10, 2, 8), "rejected", { done: at(10, 2, 8, 1) }],
    [
      "r-sentry-1",
      "a-sentry",
      at(10, 1, 20),
      "completed",
      { rev: 1, done: at(10, 1, 20, 4), thread: ["t-sentry-1001", "Sentry: quiet day"] },
    ],
  ];

  function buildRuns(autos, threads) {
    const byId = Object.fromEntries(autos.map((a) => [a.id, a]));
    return RUNS.map(([id, automationId, scheduledFor, status, x]) => {
      const a = byId[automationId];
      const createdAt = x.createdAt ?? scheduledFor;
      const pending = status === "pending-approval";
      const done = x.done ?? (status === "expired" ? createdAt + TTL : null);
      const threadIds = [];
      if (x.thread) {
        const [tid, title] = x.thread;
        threads.push({
          id: tid,
          title,
          projectId: a.projectId,
          deviceId: a.deviceId,
          automationId,
          runId: id,
          createdAt: done ?? createdAt,
        });
        threadIds.push(tid);
      }
      const r = Object.create(RunProto);
      Object.assign(r, {
        id,
        runId: id,
        automationId,
        automationRevision: x.rev ?? a.revision,
        projectId: a.projectId,
        deviceId: a.deviceId,
        providerInstanceId: a.providerInstanceId,
        execution: structuredClone(a.definition.execution),
        scheduledFor,
        coalescedOccurrences: x.coalesced ?? 0,
        status,
        proposalId: `rp-${id}`,
        safeFailureDetail: x.detail ?? null,
        threadIds,
        unread: x.unread ?? false,
        retryOfRunId: x.retryOf ?? null,
        createdAt,
        updatedAt: x.updatedAt ?? done ?? createdAt,
        expiresAt: pending ? createdAt + TTL : status === "expired" ? createdAt + TTL : null,
        completedAt: done,
      });
      return r;
    });
  }

  /* ---------------------------------------------------------- proposals */
  function proposal(p) {
    const o = Object.create(ProposalProto);
    Object.assign(o, {
      id: p.id,
      proposalId: p.id,
      kind: p.kind,
      plan: {
        kind:
          p.kind === "create"
            ? "createAutomation"
            : p.kind === "cancel"
              ? "cancelAutomation"
              : "updateAutomation",
      },
      automationId: p.automationId,
      projectId: p.projectId,
      deviceId: p.deviceId,
      before: p.before ?? null,
      after: p.after ?? null,
      expectedRevision: p.expectedRevision ?? null,
      status: "pending-user-approval",
      detail: null,
      createdAt: p.createdAt,
      updatedAt: p.createdAt,
      expiresAt: p.createdAt + TTL,
      decidedAt: null,
    });
    return o;
  }

  function buildProposals(autos) {
    const byId = Object.fromEntries(autos.map((a) => [a.id, a]));
    const chg = byId["a-changelog"];
    const certs = byId["a-certs"];
    const chgAfter = structuredClone(chg.definition);
    chgAfter.schedule.startsAt = at(10, 9, 17, 30);
    chgAfter.execution.prompt += " Skip PRs labelled `internal` or `chore`.";
    const certsAfter = structuredClone(certs.definition);
    certsAfter.enabled = false;
    certsAfter.schedule.startsAt = nextAfter(certs.definition.schedule, REF_NOW);
    return [
      proposal({
        id: "p-changelog-edit",
        kind: "edit",
        automationId: chg.id,
        projectId: chg.projectId,
        deviceId: chg.deviceId,
        before: structuredClone(chg.definition),
        after: chgAfter,
        expectedRevision: chg.revision,
        createdAt: at(10, 7, 10, 36),
      }),
      proposal({
        id: "p-certs-pause",
        kind: "pause",
        automationId: certs.id,
        projectId: certs.projectId,
        deviceId: certs.deviceId,
        before: structuredClone(certs.definition),
        after: certsAfter,
        expectedRevision: certs.revision,
        createdAt: at(10, 7, 10, 38),
      }),
      proposal({
        id: "p-keys-create",
        kind: "create",
        automationId: "a-keys",
        projectId: "ryco-hub",
        deviceId: "mac",
        after: {
          execution: {
            projectId: "ryco-hub",
            title: "Rotate staging relay keys",
            prompt:
              "Rotate the staging relay signing keys with `bun run keys:rotate --env staging`, update the sealed secret, and confirm the relay accepts newly issued tickets. Stop and report if any step fails.",
            modelSelection: codex("gpt-5.5"),
            runtimeMode: "approval-required",
            envMode: "local",
          },
          schedule: every(at(10, 12, 9, 0), WEEK, at(12, 28, 9, 0)),
          enabled: true,
        },
        createdAt: at(10, 7, 10, 40),
      }),
    ];
  }

  /* Filler for the 25-per-project limit demo: ?full=<projectId>. */
  const FILLER = [
    "Check bundle size",
    "Sweep stale TODOs",
    "Refresh test fixtures",
    "Audit feature flags",
    "Prune merged branches",
    "Check broken doc links",
    "Review open draft PRs",
    "Summarise flaky tests",
    "Check licence headers",
    "Scan for unused exports",
    "Compare Lighthouse scores",
    "Check translation keys",
    "Audit error copy",
    "Check migration order",
    "Verify release checklist",
    "Check API rate limits",
    "Review dependency licences",
    "Check Sentry quota",
    "Summarise PR review time",
    "Check icon sizes",
    "Audit keyboard shortcuts",
    "Check log volume",
    "Check dead feature code",
    "Check CI minutes",
    "Check storage growth",
  ];
  function fillProject(autos, projectId) {
    const p = projects().find((x) => x.id === projectId);
    if (!p) return;
    const active = () =>
      autos.filter((a) => a.projectId === projectId && a.enabled && !a.cancelled && a.nextRunAt)
        .length;
    let i = 0;
    while (active() < 25 && i < FILLER.length) {
      const startsAt = at(10, 7, 12, 0) + i * 20 * MIN;
      autos.push(
        automation({
          id: `a-fill-${i + 1}`,
          projectId,
          deviceId: p.checkouts[0].deviceId,
          revision: 1,
          createdAt: at(10, 1, 9, 0),
          updatedAt: at(10, 1, 9, 0),
          execution: {
            title: FILLER[i],
            prompt: `${FILLER[i]} and report anything unusual in the thread.`,
            modelSelection: codex("gpt-5.5-mini"),
            runtimeMode: "approval-required",
            envMode: "local",
          },
          schedule: every(startsAt, DAY, startsAt + 30 * DAY),
        }),
      );
      i++;
    }
  }

  /* ---------------------------------------------------------- id lookups */
  const ARRAYS = [
    "devices",
    "projects",
    "providers",
    "threads",
    "automations",
    "runs",
    "proposals",
  ];
  function keyArray(arr) {
    const prev = arr._keys ?? new Set();
    const next = new Set();
    for (const item of arr) {
      const key = item.id ?? item.instanceId;
      if (key == null || /^\d+$/.test(key)) continue;
      next.add(key);
      Object.defineProperty(arr, key, { value: item, configurable: true, enumerable: false });
    }
    for (const key of prev) if (!next.has(key)) delete arr[key];
    Object.defineProperty(arr, "_keys", { value: next, configurable: true, enumerable: false });
  }
  Object.defineProperty(S, "_reindex", {
    value() {
      for (const k of ARRAYS) if (Array.isArray(S[k])) keyArray(S[k]);
    },
  });

  /* ---------------------------------------------------------- reset */
  Object.defineProperty(S, "reset", {
    value() {
      const params = new URLSearchParams(location.search);
      const autos = DEFS.map(automation);
      if (params.get("full")) fillProject(autos, params.get("full"));
      const threads = [];
      const runs = buildRuns(autos, threads);
      Object.assign(S, {
        now: REF_NOW,
        startedAt: REF_NOW,
        tz: (() => {
          try {
            return Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/Berlin";
          } catch {
            return "Europe/Berlin";
          }
        })(),
        speed: S.speed ?? (Number(params.get("speed")) === 60 ? 60 : 1),
        playing: S.playing ?? params.get("paused") !== "1",
        devices: devices(),
        projects: projects(),
        providers: providers(),
        threads,
        automations: autos,
        runs,
        proposals: buildProposals(autos),
        seq: 100,
      });
      S._reindex();
    },
  });
  S.reset();
})();
