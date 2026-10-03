/* ============================================================
   PR lab mock data → window.PR_LAB_DATA
   One repo (ryco-labs/ryco), one viewer (sak0a), 22 PRs, two
   GitHub-native stacks, and full detail for #703 #712 #701 #688
   (medium detail for #702 #704). Times are relative to `now`.
   Shape is documented in README.md.
   ============================================================ */
(function () {
  "use strict";

  /* ---------------------------------------------------------- time */
  const NOW = Date.parse("2026-10-03T08:24:00Z");
  const iso = (ms) => new Date(ms).toISOString();
  /** minutes / hours / days before `now` → ISO string */
  const m = (n) => iso(NOW - n * 60e3);
  const hr = (n) => m(n * 60);
  const d = (n) => m(n * 1440);

  /* ---------------------------------------------------------- shas */
  function hex40(seed) {
    let out = "";
    let h = 0x811c9dc5;
    for (let round = 0; out.length < 40; round++) {
      for (const ch of seed + ":" + round) {
        h ^= ch.charCodeAt(0);
        h = Math.imul(h, 16777619) >>> 0;
      }
      out += h.toString(16).padStart(8, "0");
    }
    return out.slice(0, 40);
  }
  /** Full sha that starts with the given 7-char short sha. */
  const sha = (short) => (short + hex40(short)).slice(0, 40);

  /* ---------------------------------------------------------- patches
     Write hunks as "@@ -A +B @@ section" followed by ' ', '+', '-'
     lines; the counts are filled in here so they are always right. */
  function patch(text) {
    const lines = text
      .replace(/^\n/, "")
      .replace(/\n\s*$/, "")
      .split("\n");
    const out = [];
    let header = null;
    let body = [];
    const flush = () => {
      if (!header) return;
      let oldN = 0;
      let newN = 0;
      for (const l of body) {
        if (l[0] === "+") newN++;
        else if (l[0] === "-") oldN++;
        else if (l[0] !== "\\") {
          oldN++;
          newN++;
        }
      }
      const [, a, b, section] = header.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/);
      out.push(`@@ -${a},${oldN} +${b},${newN} @@${section ? " " + section : ""}`, ...body);
      header = null;
      body = [];
    };
    for (const raw of lines) {
      if (raw.startsWith("@@")) {
        flush();
        header = raw;
      } else body.push(raw === "" ? " " : raw);
    }
    flush();
    return out.join("\n");
  }

  /* ---------------------------------------------------------- people */
  const users = {
    sak0a: { login: "sak0a", name: "Laurin Frank" },
    mvogt: { login: "mvogt", name: "Mara Vogt" },
    tkessler: { login: "tkessler", name: "Tom Kessler" },
    "anouk-d": { login: "anouk-d", name: "Anouk de Vries" },
    priyar: { login: "priyar", name: "Priya Raman" },
    jonasw: { login: "jonasw", name: "Jonas Weber" },
    eliotm: { login: "eliotm", name: "Eliot Marsh" },
    "renovate[bot]": { login: "renovate[bot]", name: "Renovate", bot: true },
    "github-actions[bot]": { login: "github-actions[bot]", name: "GitHub Actions", bot: true },
    "ryco-ci[bot]": { login: "ryco-ci[bot]", name: "Ryco CI", bot: true },
    "vercel[bot]": { login: "vercel[bot]", name: "Vercel", bot: true },
  };
  const teams = {
    "ryco-labs/web": { slug: "ryco-labs/web", name: "web", members: ["mvogt", "priyar", "sak0a"] },
    "ryco-labs/runtime": {
      slug: "ryco-labs/runtime",
      name: "runtime",
      members: ["tkessler", "eliotm", "anouk-d"],
    },
  };

  /* ---------------------------------------------------------- labels
     GitHub hex colours as returned by the API; render with restraint. */
  const labels = {
    "area:web": { name: "area:web", color: "1f6feb", description: "apps/web" },
    "area:server": { name: "area:server", color: "8250df", description: "apps/server" },
    "area:hub": { name: "area:hub", color: "1a7f37", description: "Hosted Hub + relay" },
    "area:desktop": { name: "area:desktop", color: "6e7781", description: "Electron shell" },
    "area:mobile": { name: "area:mobile", color: "0969da", description: "apps/mobile" },
    contracts: { name: "contracts", color: "bf8700", description: "packages/contracts" },
    stacks: { name: "stacks", color: "d4a72c", description: "Stacked PR support" },
    perf: { name: "perf", color: "fb8f44", description: "Performance" },
    bug: { name: "bug", color: "d73a4a", description: "Something isn't working" },
    feature: { name: "feature", color: "a2eeef", description: "New capability" },
    security: { name: "security", color: "b60205", description: "Security-sensitive" },
    dependencies: { name: "dependencies", color: "0366d6", description: "Dependency updates" },
    docs: { name: "docs", color: "0075ca", description: "Documentation" },
    release: { name: "release", color: "5319e7", description: "Release pipeline" },
    "needs-design": { name: "needs-design", color: "e99695", description: "Waiting on design" },
  };

  /* ---------------------------------------------------------- repo */
  const repo = {
    owner: "ryco-labs",
    name: "ryco",
    nameWithOwner: "ryco-labs/ryco",
    url: "https://github.com/ryco-labs/ryco",
    defaultBranch: "main",
    viewerPermission: "admin",
    mergeMethods: { merge: false, squash: true, rebase: true },
    defaultMergeMethod: "squash",
    autoMergeAllowed: true,
    deleteBranchOnMerge: true,
    protection: {
      branch: "main",
      requiredApprovals: 1,
      requiredChecks: ["Typecheck", "Test · web", "Test · server", "Build"],
      requireUpToDate: true,
      requireConversationResolution: true,
      requireLinearHistory: true,
    },
  };

  /* ---------------------------------------------------------- PR summaries
     involvement: how the viewer relates to the PR
       "review-requested" → group "review" (needs your review)
       "authored"         → group "mine"
       "none" | "mentioned" | "reviewed" → group "others"
     checks.state: passing | failing | running | none
     reviewDecision: approved | changes_requested | review_required | null
     mergeable: mergeable | conflicting | unknown
     mergeStateStatus: CLEAN | BLOCKED | BEHIND | DIRTY | UNSTABLE | DRAFT | UNKNOWN */
  const ck = (state, total = 0, failed = 0, running = 0, skipped = 0) => ({
    state,
    total,
    passed: total - failed - running - skipped,
    failed,
    running,
    skipped,
  });
  const rv = (login, state, at) => ({ login, state, submittedAt: at ?? null });

  const pullRequests = [
    /* ------------------------------------------- needs your review */
    {
      number: 712,
      title: "Virtualize the pull request diff with LegendList",
      author: "mvogt",
      involvement: "review-requested",
      state: "open",
      isDraft: false,
      headRefName: "mvogt/pr-diff-virtualization",
      baseRefName: "main",
      createdAt: d(2),
      updatedAt: m(18),
      reviewDecision: "review_required",
      reviewers: [
        rv("sak0a", "pending"),
        rv("eliotm", "commented", hr(20)),
        rv("ryco-labs/web", "pending"),
      ],
      assignees: ["mvogt"],
      labels: ["area:web", "perf"],
      checks: ck("passing", 9),
      mergeable: "mergeable",
      mergeStateStatus: "BLOCKED",
      comments: 6,
      unresolvedThreads: 1,
      additions: 412,
      deletions: 138,
      changedFiles: 10,
      unread: true,
    },
    {
      number: 713,
      title: "Fix: split diff loses scroll position on window resize",
      author: "mvogt",
      involvement: "review-requested",
      state: "open",
      isDraft: false,
      headRefName: "mvogt/split-diff-scroll-anchor",
      baseRefName: "main",
      createdAt: hr(3),
      updatedAt: m(40),
      reviewDecision: "review_required",
      reviewers: [rv("sak0a", "pending")],
      assignees: [],
      labels: ["area:web", "bug"],
      checks: ck("running", 9, 0, 3),
      mergeable: "mergeable",
      mergeStateStatus: "BLOCKED",
      comments: 0,
      unresolvedThreads: 0,
      additions: 18,
      deletions: 6,
      changedFiles: 2,
      unread: true,
    },
    {
      number: 709,
      title: "Add reviewer and label pickers to the PR sidebar",
      author: "priyar",
      involvement: "review-requested",
      state: "open",
      isDraft: false,
      headRefName: "priyar/pr-sidebar-pickers",
      baseRefName: "main",
      createdAt: d(1),
      updatedAt: hr(2),
      reviewDecision: "review_required",
      reviewers: [rv("sak0a", "pending"), rv("mvogt", "pending")],
      assignees: ["priyar"],
      labels: ["area:web", "feature"],
      checks: ck("running", 9, 0, 2),
      mergeable: "mergeable",
      mergeStateStatus: "BLOCKED",
      comments: 2,
      unresolvedThreads: 0,
      additions: 286,
      deletions: 41,
      changedFiles: 7,
    },
    {
      number: 706,
      title: "Decode reviewThreads from GraphQL into contracts",
      author: "tkessler",
      involvement: "review-requested",
      state: "open",
      isDraft: false,
      headRefName: "tkessler/review-threads-contract",
      baseRefName: "main",
      createdAt: d(3),
      updatedAt: hr(5),
      reviewDecision: "changes_requested",
      reviewers: [rv("sak0a", "pending"), rv("eliotm", "changes_requested", hr(7))],
      assignees: ["tkessler"],
      labels: ["area:server", "contracts"],
      checks: ck("failing", 9, 1),
      mergeable: "mergeable",
      mergeStateStatus: "BLOCKED",
      comments: 9,
      unresolvedThreads: 3,
      additions: 534,
      deletions: 72,
      changedFiles: 11,
    },
    {
      number: 698,
      title: "Fix relay reconnect when the hub rotates tickets",
      author: "anouk-d",
      involvement: "review-requested",
      state: "open",
      isDraft: false,
      headRefName: "anouk-d/relay-ticket-rotation",
      baseRefName: "main",
      createdAt: d(4),
      updatedAt: d(1),
      reviewDecision: "approved",
      reviewers: [rv("sak0a", "pending"), rv("tkessler", "approved", d(1))],
      assignees: ["anouk-d"],
      labels: ["area:hub", "bug"],
      checks: ck("passing", 9),
      mergeable: "mergeable",
      mergeStateStatus: "CLEAN",
      comments: 4,
      unresolvedThreads: 0,
      additions: 97,
      deletions: 31,
      changedFiles: 4,
    },
    {
      number: 694,
      title: "Hosted: revalidate the session before accepting a shell snapshot",
      author: "jonasw",
      involvement: "review-requested",
      state: "open",
      isDraft: false,
      headRefName: "jonasw/hosted-snapshot-revalidate",
      baseRefName: "main",
      createdAt: d(9),
      updatedAt: d(3),
      reviewDecision: "review_required",
      reviewers: [rv("sak0a", "pending"), rv("anouk-d", "commented", d(5))],
      assignees: ["jonasw"],
      labels: ["area:hub", "security"],
      checks: ck("passing", 9),
      mergeable: "conflicting",
      mergeStateStatus: "DIRTY",
      comments: 7,
      unresolvedThreads: 1,
      additions: 221,
      deletions: 88,
      changedFiles: 6,
    },

    /* ------------------------------------------- yours (stack #14) */
    {
      number: 701,
      title: "Contracts: stack entries carry mergeStateStatus",
      author: "sak0a",
      involvement: "authored",
      state: "open",
      isDraft: false,
      headRefName: "ryco/stack-1-contracts",
      baseRefName: "main",
      createdAt: d(5),
      updatedAt: hr(3),
      reviewDecision: "approved",
      reviewers: [rv("mvogt", "approved", hr(4)), rv("tkessler", "approved", hr(3))],
      assignees: ["sak0a"],
      labels: ["contracts", "stacks"],
      checks: ck("passing", 9),
      mergeable: "mergeable",
      mergeStateStatus: "CLEAN",
      comments: 3,
      unresolvedThreads: 0,
      additions: 168,
      deletions: 24,
      changedFiles: 8,
    },
    {
      number: 702,
      title: "Server: read GitHub-native stacks with paged GraphQL",
      author: "sak0a",
      involvement: "authored",
      state: "open",
      isDraft: false,
      headRefName: "ryco/stack-2-server",
      baseRefName: "ryco/stack-1-contracts",
      createdAt: d(5),
      updatedAt: m(25),
      reviewDecision: "review_required",
      reviewers: [rv("tkessler", "pending"), rv("eliotm", "commented", hr(26))],
      assignees: ["sak0a"],
      labels: ["area:server", "stacks"],
      checks: ck("running", 9, 0, 3, 0),
      mergeable: "mergeable",
      mergeStateStatus: "BLOCKED",
      comments: 2,
      unresolvedThreads: 0,
      additions: 241,
      deletions: 57,
      changedFiles: 4,
    },
    {
      number: 703,
      title: "Web: stack layers rail and merge-through-layer",
      author: "sak0a",
      involvement: "authored",
      state: "open",
      isDraft: false,
      headRefName: "ryco/stack-3-web-rail",
      baseRefName: "ryco/stack-2-server",
      createdAt: d(4),
      updatedAt: m(7),
      reviewDecision: "changes_requested",
      reviewers: [rv("mvogt", "changes_requested", m(52)), rv("eliotm", "commented", hr(3))],
      assignees: ["sak0a"],
      labels: ["area:web", "stacks"],
      checks: ck("failing", 9, 1),
      mergeable: "mergeable",
      mergeStateStatus: "BLOCKED",
      comments: 11,
      unresolvedThreads: 2,
      additions: 389,
      deletions: 46,
      changedFiles: 12,
      unread: true,
    },
    {
      number: 704,
      title: "Web: stack keyboard navigation (J/K between layers, S for the rail)",
      author: "sak0a",
      involvement: "authored",
      state: "open",
      isDraft: true,
      headRefName: "ryco/stack-4-keyboard",
      baseRefName: "ryco/stack-3-web-rail",
      createdAt: d(2),
      updatedAt: hr(1),
      reviewDecision: null,
      reviewers: [],
      assignees: ["sak0a"],
      labels: ["area:web", "stacks"],
      checks: ck("none"),
      mergeable: "mergeable",
      mergeStateStatus: "DRAFT",
      comments: 0,
      unresolvedThreads: 0,
      additions: 74,
      deletions: 9,
      changedFiles: 3,
    },
    /* ------------------------------------------- yours (standalone) */
    {
      number: 697,
      title: "Overview rail: pinned state survives reloads",
      author: "sak0a",
      involvement: "authored",
      state: "open",
      isDraft: false,
      headRefName: "ryco/overview-rail-pin-persist",
      baseRefName: "main",
      createdAt: d(2),
      updatedAt: hr(6),
      reviewDecision: "approved",
      reviewers: [rv("priyar", "approved", hr(7))],
      assignees: ["sak0a"],
      labels: ["area:web"],
      checks: ck("passing", 9),
      mergeable: "mergeable",
      mergeStateStatus: "BEHIND",
      behindBy: 4,
      comments: 1,
      unresolvedThreads: 0,
      additions: 52,
      deletions: 14,
      changedFiles: 3,
    },
    {
      number: 690,
      title: "Inbox: settle animation respects reduced motion",
      author: "sak0a",
      involvement: "authored",
      state: "merged",
      isDraft: false,
      headRefName: "ryco/inbox-settle-reduced-motion",
      baseRefName: "main",
      createdAt: d(3),
      updatedAt: d(1),
      mergedAt: d(1),
      mergedBy: "sak0a",
      reviewDecision: "approved",
      reviewers: [rv("mvogt", "approved", d(1))],
      assignees: ["sak0a"],
      labels: ["area:web"],
      checks: ck("passing", 9),
      mergeable: "unknown",
      mergeStateStatus: "UNKNOWN",
      comments: 2,
      unresolvedThreads: 0,
      additions: 23,
      deletions: 11,
      changedFiles: 2,
    },
    {
      number: 683,
      title: "Try framer-motion for split panes",
      author: "sak0a",
      involvement: "authored",
      state: "closed",
      isDraft: false,
      headRefName: "ryco/split-pane-framer",
      baseRefName: "main",
      createdAt: d(11),
      updatedAt: d(6),
      closedAt: d(6),
      reviewDecision: "review_required",
      reviewers: [],
      assignees: ["sak0a"],
      labels: ["area:web", "needs-design"],
      checks: ck("none"),
      mergeable: "unknown",
      mergeStateStatus: "UNKNOWN",
      comments: 3,
      unresolvedThreads: 0,
      additions: 310,
      deletions: 122,
      changedFiles: 9,
    },

    /* ------------------------------------------- others (stack #15) */
    {
      number: 715,
      title: "Settings: extract settingsLayout primitives",
      author: "priyar",
      involvement: "none",
      state: "open",
      isDraft: false,
      headRefName: "priyar/settings-layout-primitives",
      baseRefName: "main",
      createdAt: d(1),
      updatedAt: hr(4),
      reviewDecision: "approved",
      reviewers: [rv("mvogt", "approved", hr(5))],
      assignees: ["priyar"],
      labels: ["area:web"],
      checks: ck("passing", 9),
      mergeable: "mergeable",
      mergeStateStatus: "CLEAN",
      comments: 1,
      unresolvedThreads: 0,
      additions: 204,
      deletions: 167,
      changedFiles: 8,
    },
    {
      number: 716,
      title: "Settings: move provider instances onto the settings page",
      author: "priyar",
      involvement: "none",
      state: "open",
      isDraft: false,
      headRefName: "priyar/settings-provider-instances",
      baseRefName: "priyar/settings-layout-primitives",
      createdAt: d(1),
      updatedAt: hr(4),
      reviewDecision: "review_required",
      reviewers: [rv("mvogt", "pending"), rv("ryco-labs/web", "pending")],
      assignees: ["priyar"],
      labels: ["area:web", "feature"],
      checks: ck("passing", 9),
      mergeable: "mergeable",
      mergeStateStatus: "BLOCKED",
      comments: 0,
      unresolvedThreads: 0,
      additions: 318,
      deletions: 96,
      changedFiles: 10,
    },
    /* ------------------------------------------- others */
    {
      number: 688,
      title: "Release: sign and notarize the desktop DMG in CI",
      author: "jonasw",
      involvement: "none",
      state: "open",
      isDraft: false,
      headRefName: "jonasw/desktop-notarize",
      baseRefName: "main",
      createdAt: d(2),
      updatedAt: m(52),
      reviewDecision: "review_required",
      reviewers: [rv("anouk-d", "commented", hr(20)), rv("tkessler", "pending")],
      assignees: ["jonasw"],
      labels: ["area:desktop", "release"],
      checks: ck("failing", 11, 1),
      mergeable: "mergeable",
      mergeStateStatus: "BLOCKED",
      comments: 5,
      unresolvedThreads: 1,
      additions: 236,
      deletions: 19,
      changedFiles: 8,
    },
    {
      number: 711,
      title: "chore(deps): update effect to 3.19 and @effect/tsgo to 0.9",
      author: "renovate[bot]",
      involvement: "none",
      state: "open",
      isDraft: false,
      headRefName: "renovate/effect-monorepo",
      baseRefName: "main",
      createdAt: hr(9),
      updatedAt: hr(9),
      reviewDecision: "review_required",
      reviewers: [rv("ryco-labs/runtime", "pending")],
      assignees: [],
      labels: ["dependencies"],
      checks: ck("passing", 9),
      mergeable: "mergeable",
      mergeStateStatus: "BLOCKED",
      comments: 1,
      unresolvedThreads: 0,
      additions: 41,
      deletions: 41,
      changedFiles: 3,
    },
    {
      number: 705,
      title: "Mobile: native pull request list (read-only)",
      author: "eliotm",
      involvement: "none",
      state: "open",
      isDraft: true,
      headRefName: "eliotm/mobile-pr-list",
      baseRefName: "main",
      createdAt: d(6),
      updatedAt: d(1),
      reviewDecision: null,
      reviewers: [],
      assignees: ["eliotm"],
      labels: ["area:mobile", "feature"],
      checks: ck("none"),
      mergeable: "mergeable",
      mergeStateStatus: "DRAFT",
      comments: 2,
      unresolvedThreads: 0,
      additions: 612,
      deletions: 8,
      changedFiles: 14,
    },
    {
      number: 692,
      title: "Terminal drawer: keep scrollback across reconnects",
      author: "tkessler",
      involvement: "mentioned",
      state: "open",
      isDraft: false,
      headRefName: "tkessler/terminal-scrollback",
      baseRefName: "main",
      createdAt: d(3),
      updatedAt: hr(3),
      reviewDecision: "approved",
      reviewers: [rv("anouk-d", "approved", hr(4))],
      assignees: ["tkessler"],
      labels: ["area:web", "bug"],
      checks: ck("passing", 9),
      mergeable: "mergeable",
      mergeStateStatus: "CLEAN",
      autoMerge: { method: "squash", enabledBy: "tkessler", enabledAt: hr(3) },
      comments: 3,
      unresolvedThreads: 0,
      additions: 64,
      deletions: 22,
      changedFiles: 3,
    },
    {
      number: 700,
      title: "Docs: provider guide for OpenCode",
      author: "anouk-d",
      involvement: "none",
      state: "merged",
      isDraft: false,
      headRefName: "anouk-d/docs-opencode",
      baseRefName: "main",
      createdAt: d(4),
      updatedAt: d(2),
      mergedAt: d(2),
      mergedBy: "mvogt",
      reviewDecision: "approved",
      reviewers: [rv("mvogt", "approved", d(2))],
      assignees: [],
      labels: ["docs"],
      checks: ck("passing", 4),
      mergeable: "unknown",
      mergeStateStatus: "UNKNOWN",
      comments: 1,
      unresolvedThreads: 0,
      additions: 141,
      deletions: 3,
      changedFiles: 2,
    },
    {
      number: 687,
      title: "Server: cache gh pr view for 5s per cwd",
      author: "eliotm",
      involvement: "reviewed",
      state: "closed",
      isDraft: false,
      headRefName: "eliotm/gh-pr-view-cache",
      baseRefName: "main",
      createdAt: d(14),
      updatedAt: d(12),
      closedAt: d(12),
      reviewDecision: "changes_requested",
      reviewers: [rv("sak0a", "changes_requested", d(13))],
      assignees: ["eliotm"],
      labels: ["area:server", "perf"],
      checks: ck("passing", 9),
      mergeable: "unknown",
      mergeStateStatus: "UNKNOWN",
      comments: 4,
      unresolvedThreads: 0,
      additions: 88,
      deletions: 12,
      changedFiles: 3,
    },
    {
      number: 679,
      title: "Composer: pasting a PR URL attaches it as context",
      author: "priyar",
      involvement: "reviewed",
      state: "merged",
      isDraft: false,
      headRefName: "priyar/composer-pr-url-context",
      baseRefName: "main",
      createdAt: d(8),
      updatedAt: d(4),
      mergedAt: d(4),
      mergedBy: "priyar",
      reviewDecision: "approved",
      reviewers: [rv("sak0a", "approved", d(5))],
      assignees: ["priyar"],
      labels: ["area:web", "feature"],
      checks: ck("passing", 9),
      mergeable: "unknown",
      mergeStateStatus: "UNKNOWN",
      comments: 2,
      unresolvedThreads: 0,
      additions: 133,
      deletions: 17,
      changedFiles: 5,
    },
  ];

  /* ---------------------------------------------------------- stacks
     GitHub-native stacks. entries are PR numbers, bottom → top. */
  const stacks = [
    { id: "s14", number: 14, baseRefName: "main", entries: [701, 702, 703, 704] },
    { id: "s15", number: 15, baseRefName: "main", entries: [715, 716] },
  ];

  /* ---------------------------------------------------------- checks
     Two workflows (CI, Release dry run) built from a job table so the
     steps look like the real .github/workflows/*.yml. */
  const PRE = ["Set up job", "Checkout", "Setup Bun 1.3.2", "bun install --frozen-lockfile"];
  const POST = ["Post Setup Bun", "Complete job"];
  const JOBS = {
    lint: { name: "Format & lint", steps: ["bun run fmt:check", "bun lint"], sec: 48 },
    typecheck: { name: "Typecheck", steps: ["bun typecheck"], sec: 131 },
    "test-web": { name: "Test · web", steps: ["bun run test --filter=@ryco/web"], sec: 182 },
    "test-server": { name: "Test · server", steps: ["bun run test --filter=ryco-cli"], sec: 160 },
    browser: {
      name: "Browser · web",
      steps: ["Install Playwright Chromium", "bun run --cwd apps/web test:browser"],
      sec: 258,
    },
    build: { name: "Build", steps: ["bun run build"], sec: 175 },
    "desktop-mac": {
      name: "Desktop · macOS arm64",
      steps: ["bun run build:desktop", "Package DMG", "Notarize (dry run)"],
      sec: 462,
    },
    cli: {
      name: "CLI bundle",
      steps: ["bun run --filter ryco-cli build:bundle", "Smoke test dist/bin.mjs"],
      sec: 96,
    },
    smoke: { name: "Release smoke", steps: ["bun run release:smoke"], sec: 71 },
  };
  const OK_LOGS = {
    lint: [
      "$ bun run fmt:check",
      "Checked 1,284 files in 412ms. No fixes applied.",
      "$ bun lint",
      "Found 0 warnings and 0 errors.",
      "Finished in 3.1s on 1,102 files with 214 rules using 8 threads.",
    ],
    typecheck: [
      "$ bun typecheck",
      "• Packages in scope: @ryco/client-runtime, @ryco/contracts, @ryco/desktop, @ryco/mobile, @ryco/shared, @ryco/web, ryco-cli, …",
      "• Running typecheck in 11 packages",
      "@ryco/contracts:typecheck: cache hit, replaying logs 4f2a91c0d3e1b7aa",
      "@ryco/web:typecheck: $ tsgo --noEmit -p tsconfig.json",
      "",
      " Tasks:    11 successful, 11 total",
      "Cached:    6 cached, 11 total",
      "  Time:    2m4.318s",
    ],
    "test-web": [
      "$ bun run test --filter=@ryco/web",
      " ✓ src/components/pullRequests/PullRequestMergeBox.logic.test.ts (14 tests) 21ms",
      " ✓ src/lib/diffLines.test.ts (31 tests) 9ms",
      " ✓ src/components/inboxSidebar/inboxSidebarModel.test.ts (48 tests) 33ms",
      "",
      " Test Files  212 passed (212)",
      "      Tests  1846 passed (1846)",
      "   Duration  58.21s (transform 9.12s, setup 4.40s, collect 31.7s, tests 22.9s)",
    ],
    "test-server": [
      "$ bun run test --filter=ryco-cli",
      " ✓ src/sourceControl/gitHubPullRequestStacks.test.ts (22 tests) 41ms",
      " ✓ src/orchestration/OrchestrationEngine.test.ts (64 tests) 2.31s",
      "",
      " Test Files  148 passed (148)",
      "      Tests  1210 passed (1210)",
      "   Duration  41.06s",
    ],
    browser: [
      "$ bun run --cwd apps/web test:browser",
      "Running 148 tests using 4 workers",
      "  148 passed (3.9m)",
    ],
    build: [
      "$ bun run build",
      "@ryco/web:build: vite v7.1.3 building for production...",
      "@ryco/web:build: ✓ 3412 modules transformed.",
      "@ryco/web:build: dist/assets/index-Bq3k9xYz.js   1,208.44 kB │ gzip: 361.02 kB",
      "ryco-cli:build: Bundled 2184 modules in 1.9s",
      " Tasks:    7 successful, 7 total",
    ],
    "desktop-mac": [
      "$ bun run build:desktop",
      "  • electron-builder  version=26.0.12 os=24.6.0",
      "  • packaging       platform=darwin arch=arm64 electron=38.2.1 appOutDir=release/mac-arm64",
      "  • building        target=DMG arch=arm64 file=release/Ryco-0.9.0-arm64.dmg",
      "  • skipped notarization  reason=dry run",
    ],
    cli: ["$ node dist/bin.mjs --version", "ryco 0.9.0", "smoke: serve --help exited 0"],
    smoke: ["$ bun run release:smoke", "release:smoke ✓ manifest, checksums, CLI bundle (3/3)"],
  };

  function buildJob(prN, key, o, startedAt) {
    const def = JOBS[key];
    const names = [...PRE, ...def.steps, ...POST];
    const outcome = o.outcomes?.[key] || "success";
    const failStep = o.failStep?.[key] ?? def.steps[def.steps.length - 1];
    const runIdx = PRE.length + Math.max(0, def.steps.length - 1);
    const per = Math.max(2, Math.round(def.sec / names.length));
    let failed = false;
    const steps = names.map((name, i) => {
      const s = { n: i + 1, name, status: "completed", conclusion: "success", durationSec: per };
      if (outcome === "queued")
        Object.assign(s, { status: "queued", conclusion: null, durationSec: null });
      else if (outcome === "running") {
        if (i === runIdx)
          Object.assign(s, { status: "in_progress", conclusion: null, durationSec: null });
        else if (i > runIdx)
          Object.assign(s, { status: "queued", conclusion: null, durationSec: null });
      } else if (outcome === "skipped") Object.assign(s, { conclusion: "skipped", durationSec: 0 });
      else if (outcome === "failure") {
        if (name === failStep) {
          s.conclusion = "failure";
          failed = true;
        } else if (failed && !POST.includes(name))
          Object.assign(s, { conclusion: "skipped", durationSec: 0 });
      }
      return s;
    });
    const done = outcome !== "running" && outcome !== "queued";
    const dur = done ? (outcome === "skipped" ? 0 : def.sec) : null;
    return {
      id: `${prN}-${key}`,
      key,
      name: def.name,
      status: done ? "completed" : outcome === "running" ? "in_progress" : "queued",
      conclusion: done ? outcome : null,
      startedAt: outcome === "queued" ? null : startedAt,
      durationSec: dur,
      required: repo.protection.requiredChecks.includes(def.name),
      steps,
      log:
        o.logs?.[key] ||
        (outcome === "success"
          ? OK_LOGS[key]
          : outcome === "running"
            ? (OK_LOGS[key] || []).slice(0, 2)
            : null),
      url: `${repo.url}/actions/runs/${o.runId}/job/${o.runId * 10 + Object.keys(JOBS).indexOf(key)}`,
    };
  }
  /** opts: { runId, runNumber, attempt, headSha, startedMin, outcomes, failStep, logs } */
  function workflow(prN, kind, opts) {
    const keys =
      kind === "ci"
        ? ["lint", "typecheck", "test-web", "test-server", "browser", "build"]
        : ["desktop-mac", "cli", ...(opts.withSmoke ? ["smoke"] : [])];
    const startedAt = m(opts.startedMin ?? 30);
    const jobs = keys.map((k) => buildJob(prN, k, opts, startedAt));
    const live = jobs.some((j) => j.status !== "completed");
    const failedJob = jobs.some((j) => j.conclusion === "failure");
    return {
      id: `${prN}-${kind}`,
      name: kind === "ci" ? "CI" : "Release dry run",
      file: kind === "ci" ? ".github/workflows/ci.yml" : ".github/workflows/release-dry-run.yml",
      event: "pull_request",
      runId: opts.runId,
      runNumber: opts.runNumber,
      attempt: opts.attempt ?? 1,
      headSha: opts.headSha,
      status: live ? "in_progress" : "completed",
      conclusion: live ? null : failedJob ? "failure" : "success",
      startedAt,
      durationSec: live ? null : Math.max(...jobs.map((j) => j.durationSec || 0)) + 14,
      url: `${repo.url}/actions/runs/${opts.runId}`,
      jobs,
    };
  }

  /* ============================================================
     DETAIL #703 · stack layer 3 · changes requested, CI failing
     ============================================================ */
  const C703 = [
    ["a41c9e2", "Add stack layer assessment and merge planning", d(4), "passing"],
    ["7d02f5b", "Render the stack rail next to the PR header", d(4), "passing"],
    ["c3e81a0", "Wire merge-through-layer into the merge box", d(3), "passing"],
    ["19be4f7", "Browser test for rail keyboard focus", d(3), "passing"],
    ["4e1d0b2", "Cover a closed layer in the middle of the stack", d(1), "passing"],
    ["0b9d3a8", "Use stack position in rail aria labels", hr(20), "passing"],
    ["f2c7a19", "Name the base branch in the stack merge confirmation", hr(3), "passing"],
    ["8e5d1c6", "client-runtime: depend on @ryco/shared for stack helpers", m(9), "failing"],
  ].map(([short, message, committedAt, checks]) => ({
    sha: sha(short),
    short,
    message,
    author: "sak0a",
    committedAt,
    checks,
  }));

  const F703 = [
    {
      path: "apps/web/src/components/pullRequests/stackLayers.logic.ts",
      status: "added",
      viewed: "viewed",
      commits: ["a41c9e2", "c3e81a0", "f2c7a19"],
      patch: patch(`
@@ -0,0 +1 @@
+import type {
+  SourceControlChangeRequestStack,
+  SourceControlChangeRequestStackEntry,
+} from "@ryco/contracts";
+
+export type StackLayerTone = "merged" | "ready" | "pending" | "blocked" | "draft";
+
+export interface StackLayer {
+  readonly entry: SourceControlChangeRequestStackEntry;
+  readonly tone: StackLayerTone;
+  /** Why the layer cannot merge yet, phrased for the merge box. */
+  readonly reason: string | null;
+}
+
+export interface StackMergePlan {
+  readonly through: number;
+  readonly layers: ReadonlyArray<StackLayer>;
+  readonly blockedBy: StackLayer | null;
+}
+
+/** Bottom → top: the order GitHub reports and the order a merge walks. */
+export function stackLayers(stack: SourceControlChangeRequestStack): ReadonlyArray<StackLayer> {
+  return stack.entries.map((entry) => ({ entry, ...assessLayer(entry) }));
+}
+
+function assessLayer(entry: SourceControlChangeRequestStackEntry) {
+  if (entry.state === "merged") return { tone: "merged" as const, reason: null };
+  if (entry.state === "closed") {
+    return { tone: "blocked" as const, reason: "Closed without merging" };
+  }
+  if (entry.isDraft) return { tone: "draft" as const, reason: "Still a draft" };
+  if (entry.mergeability === "conflicting") {
+    return { tone: "blocked" as const, reason: "Has merge conflicts" };
+  }
+  if (entry.mergeStateStatus === "BLOCKED" || entry.mergeStateStatus === "UNSTABLE") {
+    return { tone: "pending" as const, reason: "Waiting on reviews or checks" };
+  }
+  return { tone: "ready" as const, reason: null };
+}
+
+/** Merging "through" a layer lands every open layer at or below it, atomically. */
+export function planStackMerge(
+  stack: SourceControlChangeRequestStack,
+  through: number,
+): StackMergePlan {
+  const layers = stackLayers(stack).filter(
+    (layer) => layer.entry.position <= through && layer.tone !== "merged",
+  );
+  const target = layers.at(-1);
+  if (target?.entry.isDraft) return { through, layers, blockedBy: target };
+  const blockedBy =
+    layers.find((layer) => layer.tone === "blocked" || layer.tone === "pending") ?? null;
+  return { through, layers, blockedBy };
+}
+
+export function stackMergeLabel(plan: StackMergePlan): string {
+  return plan.layers.length > 1 ? "Merge stack (" + plan.layers.length + ")" : "Merge";
+}
`),
    },
    {
      path: "apps/web/src/components/pullRequests/PullRequestStackRail.tsx",
      status: "added",
      viewed: "unviewed",
      commits: ["7d02f5b", "0b9d3a8"],
      patch: patch(`
@@ -0,0 +1 @@
+import { Link } from "@tanstack/react-router";
+import { GitMergeIcon, GitPullRequestDraftIcon, GitPullRequestIcon } from "lucide-react";
+import { memo, useCallback, useRef, type KeyboardEvent } from "react";
+
+import type { SourceControlChangeRequestStack } from "@ryco/contracts";
+import { cn } from "../../lib/utils";
+import { stackLayers, type StackLayerTone } from "./stackLayers.logic";
+
+const TONE_CLASS: Record<StackLayerTone, string> = {
+  merged: "text-violet-500",
+  ready: "text-emerald-500",
+  pending: "text-muted-foreground",
+  blocked: "text-rose-500",
+  draft: "text-muted-foreground/60",
+};
+
+export interface PullRequestStackRailProps {
+  readonly stack: SourceControlChangeRequestStack;
+  readonly current: number;
+  readonly onMergeThrough: (position: number) => void;
+}
+
+/** Top layer first, like the branches read in \`gh stack view\`. */
+export const PullRequestStackRail = memo(function PullRequestStackRail({
+  stack,
+  current,
+  onMergeThrough,
+}: PullRequestStackRailProps) {
+  const listRef = useRef<HTMLOListElement>(null);
+  const layers = stackLayers(stack).toReversed();
+  const onKeyDown = useCallback((event: KeyboardEvent<HTMLOListElement>) => {
+    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
+    const links = [...(listRef.current?.querySelectorAll("a") ?? [])];
+    const index = links.indexOf(document.activeElement as HTMLAnchorElement);
+    links[index + (event.key === "ArrowDown" ? 1 : -1)]?.focus();
+    event.preventDefault();
+  }, []);
+
+  return (
+    <ol ref={listRef} aria-label={"Stack " + stack.number} onKeyDown={onKeyDown}>
+      {layers.map(({ entry, tone, reason }) => {
+        const selected = entry.number === current;
+        const Icon =
+          entry.state === "merged"
+            ? GitMergeIcon
+            : entry.isDraft
+              ? GitPullRequestDraftIcon
+              : GitPullRequestIcon;
+        return (
+          <li key={entry.number} className="group/layer relative">
+            <Link
+              to="/pull-requests/$number"
+              params={{ number: String(entry.number) }}
+              aria-selected={selected}
+              aria-label={"Layer " + entry.position + " of " + stack.size + ": " + entry.title}
+              title={reason ?? undefined}
+              className={cn(
+                "flex h-7 items-center gap-2 rounded-md px-2 text-xs transition-colors",
+                selected ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
+              )}
+            >
+              <Icon className={cn("size-3.5 shrink-0", TONE_CLASS[tone])} />
+              <span className="tabular-nums">#{entry.number}</span>
+              <span className="min-w-0 flex-1 truncate">{entry.title}</span>
+            </Link>
+            {selected && entry.position > 1 ? (
+              <button
+                type="button"
+                onClick={() => onMergeThrough(entry.position)}
+                className="absolute top-1 right-1 hidden rounded px-1.5 text-[11px] group-hover/layer:block"
+              >
+                Merge through here
+              </button>
+            ) : null}
+          </li>
+        );
+      })}
+    </ol>
+  );
+});
`),
    },
    {
      path: "apps/web/src/components/pullRequests/PullRequestMergeBox.tsx",
      status: "modified",
      viewed: "unviewed",
      commits: ["c3e81a0", "f2c7a19"],
      patch: patch(`
@@ -1 +1 @@
 import { ChevronDownIcon, GitMergeIcon } from "lucide-react";
 import { useState } from "react";

+import type { SourceControlChangeRequestStack } from "@ryco/contracts";
 import { Button } from "../ui/button";
 import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
+import { ConfirmStackMerge } from "./ConfirmStackMerge";
 import { pullRequestMergeBlocker } from "./pullRequestStack.logic";
+import { planStackMerge, stackMergeLabel } from "./stackLayers.logic";

 export interface PullRequestMergeBoxProps {
   readonly detail: PullRequestDetailView;
   readonly capabilities: MergeCapabilitiesView;
   readonly onMerge: (method: MergeMethod) => void;
+  readonly stack?: SourceControlChangeRequestStack | undefined;
+  /** Layer position to merge through; defaults to the open pull request. */
+  readonly mergeThrough?: number | undefined;
 }
@@ -38 +44 @@ export function PullRequestMergeBox({
   detail,
   capabilities,
   onMerge,
+  stack,
+  mergeThrough,
 }: PullRequestMergeBoxProps) {
   const [method, setMethod] = useState(capabilities.defaultMethod);
-  const blocker = pullRequestMergeBlocker(detail);
+  const [confirming, setConfirming] = useState(false);
+  const plan = stack ? planStackMerge(stack, mergeThrough ?? detail.stackPosition) : null;
+  const blocker = plan?.blockedBy?.reason ?? pullRequestMergeBlocker(detail);
+  const label = plan ? stackMergeLabel(plan) : "Merge";

   return (
     <div className="flex items-center gap-2">
       <Button
         size="sm"
         disabled={blocker !== null}
-        onClick={() => onMerge(method)}
+        onClick={() => (plan && plan.layers.length > 1 ? setConfirming(true) : onMerge(method))}
       >
         <GitMergeIcon className="size-3.5" />
-        Merge
+        {label}
       </Button>
       <Menu>
         <MenuTrigger render={<Button size="icon-sm" variant="ghost" />}>
           <ChevronDownIcon className="size-3.5" />
         </MenuTrigger>
@@ -71 +82 @@ export function PullRequestMergeBox({
           ))}
         </MenuPopup>
       </Menu>
+      {plan && stack && confirming ? (
+        <ConfirmStackMerge
+          title={"Merge " + plan.layers.length + " pull requests into " + stack.baseRefName}
+          layers={plan.layers}
+          method={method}
+          onCancel={() => setConfirming(false)}
+          onConfirm={() => {
+            setConfirming(false);
+            onMerge(method);
+          }}
+        />
+      ) : null}
     </div>
   );
 }
`),
    },
    {
      path: "apps/web/src/components/pullRequests/PullRequestPage.tsx",
      status: "modified",
      viewed: "unviewed",
      commits: ["7d02f5b", "c3e81a0"],
      patch: patch(`
@@ -14 +14 @@ import { PullRequestHeader } from "./PullRequestHeader";
 import { PullRequestMergeBox } from "./PullRequestMergeBox";
+import { PullRequestStackRail } from "./PullRequestStackRail";
 import { usePullRequestDetail } from "./usePullRequestDetail";

 export function PullRequestPage({ number }: { readonly number: number }) {
   const { detail, stack, merge } = usePullRequestDetail(number);
+  const [mergeThrough, setMergeThrough] = useState<number | undefined>(undefined);
   if (!detail) return <PullRequestDetailLoadingState />;

   return (
     <div className="flex h-full min-h-0 flex-col">
       <PullRequestHeader detail={detail} />
-      <div className="min-h-0 flex-1 overflow-y-auto">
-        <PullRequestTabs detail={detail} />
+      <div className="flex min-h-0 flex-1">
+        {stack ? (
+          <aside className="w-60 shrink-0 overflow-y-auto border-r border-border/70 p-2">
+            <PullRequestStackRail
+              stack={stack}
+              current={detail.number}
+              onMergeThrough={setMergeThrough}
+            />
+          </aside>
+        ) : null}
+        <div className="min-h-0 flex-1 overflow-y-auto">
+          <PullRequestTabs detail={detail} />
+        </div>
       </div>
-      <PullRequestMergeBox detail={detail} capabilities={detail.mergeCapabilities} onMerge={merge} />
+      <PullRequestMergeBox
+        detail={detail}
+        capabilities={detail.mergeCapabilities}
+        stack={stack}
+        mergeThrough={mergeThrough}
+        onMerge={merge}
+      />
     </div>
   );
 }
`),
    },
    {
      path: "apps/web/src/routes/_chat.pull-requests.$number.tsx",
      status: "modified",
      viewed: "viewed",
      commits: ["7d02f5b"],
      patch: patch(`
@@ -1 +1 @@
 import { createFileRoute } from "@tanstack/react-router";
+import { Schema } from "effect";

 import { PullRequestPage } from "../components/pullRequests/PullRequestPage";

+const PullRequestSearch = Schema.Struct({
+  tab: Schema.optional(Schema.Literals(["conversation", "files", "checks", "commits"])),
+  layer: Schema.optional(Schema.NumberFromString),
+});
+
 export const Route = createFileRoute("/_chat/pull-requests/$number")({
+  validateSearch: Schema.standardSchemaV1(PullRequestSearch),
   component: function PullRequestRoute() {
     const { number } = Route.useParams();
     return <PullRequestPage number={Number(number)} />;
   },
 });
`),
    },
    {
      path: "apps/web/src/rpc/sourceControlAtoms.ts",
      status: "modified",
      viewed: "unviewed",
      commits: ["c3e81a0"],
      patch: patch(`
@@ -417 +417 @@ export const changeRequestDetailBinding = defineQuery({
   staleTimeMs: 5 * 60_000,
   key: (input: ChangeRequestDetailInput) =>
     [input.environmentId, input.cwd, input.reference, input.fullContent ? "full" : "lite"].join("|"),
 });

+/**
+ * The whole stack moves together: merging through a layer retargets every PR
+ * above it, so a stack merge invalidates each layer's detail, not only the target.
+ */
+export function invalidateStackLayers(input: {
+  readonly environmentId: EnvironmentId;
+  readonly cwd: string;
+  readonly numbers: ReadonlyArray<number>;
+}) {
+  for (const number of input.numbers) {
+    changeRequestDetailBinding.refresh({
+      environmentId: input.environmentId,
+      cwd: input.cwd,
+      reference: String(number),
+      fullContent: true,
+    });
+  }
+}
+
 export const changeRequestDiffBinding = defineQuery({
`),
    },
    {
      path: "packages/client-runtime/src/state/pull-request-stack.ts",
      status: "modified",
      viewed: "unviewed",
      commits: ["c3e81a0", "8e5d1c6"],
      patch: patch(`
@@ -1 +1 @@
 import type { SourceControlChangeRequestStack } from "@ryco/contracts";
+import { pluralize } from "@ryco/shared/text";

 export interface PullRequestStackSnapshot {
   readonly stack: SourceControlChangeRequestStack | null;
   readonly incomplete: boolean;
+  /** Head SHA per layer when the user looked; a merge refuses if any moved. */
+  readonly expectedHeads: ReadonlyMap<number, string>;
 }
@@ -24 +27 @@ export function stackSnapshot(
-  return { stack, incomplete };
+  const expectedHeads = new Map(stack?.entries.map((entry) => [entry.number, entry.headSha]));
+  return { stack, incomplete, expectedHeads };
 }
+
+export function stackSummaryLabel(stack: SourceControlChangeRequestStack): string {
+  return "Stack " + stack.number + " · " + pluralize(stack.size, "layer");
+}
`),
    },
    {
      path: "packages/client-runtime/package.json",
      status: "modified",
      viewed: "viewed",
      commits: ["8e5d1c6"],
      patch: patch(`
@@ -18 +18 @@
   "dependencies": {
     "@ryco/contracts": "workspace:*",
+    "@ryco/shared": "workspace:*",
     "effect": "catalog:"
   },
`),
    },
    {
      path: "bun.lock",
      status: "modified",
      viewed: "unviewed",
      generated: true,
      commits: ["8e5d1c6"],
      patch: patch(`
@@ -74 +74 @@
     "packages/client-runtime": {
       "name": "@ryco/client-runtime",
       "version": "0.9.0",
       "dependencies": {
         "@ryco/contracts": "workspace:*",
+        "@ryco/shared": "workspace:*",
         "effect": "catalog:",
       },
       "devDependencies": {
         "@effect/vitest": "catalog:",
         "vitest": "catalog:",
       },
     },
`),
    },
    {
      path: "apps/web/src/components/pullRequests/stackLayers.logic.test.ts",
      status: "added",
      viewed: "unviewed",
      commits: ["a41c9e2", "4e1d0b2"],
      patch: patch(`
@@ -0,0 +1 @@
+import { describe, expect, it } from "vitest";
+import type { SourceControlChangeRequestStackEntry } from "@ryco/contracts";
+
+import { planStackMerge, stackLayers, stackMergeLabel } from "./stackLayers.logic";
+
+const entry = (
+  position: number,
+  patch: Partial<SourceControlChangeRequestStackEntry> = {},
+): SourceControlChangeRequestStackEntry => ({
+  position,
+  number: 700 + position,
+  title: "Layer " + position,
+  url: "https://github.com/ryco-labs/ryco/pull/" + (700 + position),
+  headRefName: "ryco/stack-" + position,
+  baseRefName: position === 1 ? "main" : "ryco/stack-" + (position - 1),
+  state: "open",
+  isDraft: false,
+  mergeability: "mergeable",
+  mergeStateStatus: "CLEAN",
+  ...patch,
+});
+const open = (position: number) => entry(position);
+const draft = (position: number) => entry(position, { isDraft: true, mergeStateStatus: "DRAFT" });
+const closed = (position: number) => entry(position, { state: "closed" });
+const stackOf = (entries: SourceControlChangeRequestStackEntry[]) => ({
+  number: 14,
+  size: entries.length,
+  position: 1,
+  baseRefName: "main",
+  entries,
+});
+
+describe("planStackMerge", () => {
+  it("merges through a ready layer", () => {
+    expect(planStackMerge(stackOf([open(1), open(2)]), 2).blockedBy).toBeNull();
+  });
+
+  it("refuses to merge through a draft layer below the target", () => {
+    const plan = planStackMerge(stackOf([open(1), draft(2), open(3)]), 3);
+    expect(plan.blockedBy?.entry.position).toBe(2);
+  });
+
+  it("refuses to merge through a closed layer in the middle", () => {
+    const plan = planStackMerge(stackOf([open(1), closed(2), open(3)]), 3);
+    expect(plan.blockedBy?.reason).toBe("Closed without merging");
+  });
+
+  it("labels a multi-layer merge with its size", () => {
+    expect(stackMergeLabel(planStackMerge(stackOf([open(1), open(2), open(3)]), 3))).toBe(
+      "Merge stack (3)",
+    );
+  });
+});
+
+describe("stackLayers", () => {
+  it("keeps GitHub's bottom → top order", () => {
+    const layers = stackLayers(stackOf([open(1), open(2), open(3)]));
+    expect(layers.map((layer) => layer.entry.position)).toEqual([1, 2, 3]);
+  });
+});
`),
    },
    {
      path: "apps/web/src/components/pullRequests/PullRequestStackRail.browser.tsx",
      status: "added",
      viewed: "unviewed",
      commits: ["19be4f7", "0b9d3a8"],
      patch: patch(`
@@ -0,0 +1 @@
+import { page, userEvent } from "@vitest/browser/context";
+import { describe, expect, it, vi } from "vitest";
+
+import { renderWithRouter } from "../../test/renderWithRouter";
+import { PullRequestStackRail } from "./PullRequestStackRail";
+import { stackFixture } from "./__fixtures__/stack";
+
+describe("PullRequestStackRail", () => {
+  it("lists layers top-first and marks the open one", async () => {
+    await renderWithRouter(
+      <PullRequestStackRail stack={stackFixture} current={703} onMergeThrough={vi.fn()} />,
+    );
+    const links = page.getByRole("link").all();
+    expect(links.map((link) => link.element().textContent)).toEqual([
+      expect.stringContaining("#704"),
+      expect.stringContaining("#703"),
+      expect.stringContaining("#702"),
+      expect.stringContaining("#701"),
+    ]);
+    await expect.element(page.getByLabelText("Layer 3 of 4", { exact: false })).toHaveAttribute(
+      "aria-selected",
+      "true",
+    );
+  });
+
+  it("moves focus between layers with the arrow keys", async () => {
+    await renderWithRouter(
+      <PullRequestStackRail stack={stackFixture} current={703} onMergeThrough={vi.fn()} />,
+    );
+    await userEvent.click(page.getByText("#703"));
+    await userEvent.keyboard("{ArrowDown}");
+    await expect.element(page.getByLabelText("Layer 2 of 4", { exact: false })).toHaveFocus();
+  });
+});
`),
    },
    {
      path: "apps/web/src/index.css",
      status: "modified",
      viewed: "unviewed",
      commits: ["7d02f5b"],
      patch: patch(`
@@ -1412 +1412 @@
   .chat-pane-header-out {
     animation: chat-pane-header-out var(--app-motion-duration-pane) var(--app-motion-ease) both;
   }
+
+  /* Stack rail: the layer you open slides its highlight, it never fades. */
+  .stack-rail-highlight {
+    transition:
+      translate var(--app-motion-duration-stack) var(--app-motion-spring-gentle),
+      height var(--app-motion-duration-stack) var(--app-motion-spring-gentle);
+  }
+
+  @keyframes stack-layer-merged {
+    from {
+      clip-path: inset(0 100% 0 0);
+    }
+    to {
+      clip-path: inset(0 0 0 0);
+    }
+  }
 }
`),
    },
  ];

  const T703 = [
    {
      id: "703-t1",
      path: "apps/web/src/components/pullRequests/stackLayers.logic.ts",
      side: "RIGHT",
      match: "if (target?.entry.isDraft) return",
      isResolved: false,
      isOutdated: false,
      comments: [
        {
          id: "703-c1",
          author: "mvogt",
          createdAt: m(52),
          body: "This only refuses when the *target* is a draft. A draft further down (say #702 flips back to draft while you're looking at this one) slips through, because `draft` isn't in the `blockedBy` filter below — and then `merge-async` 422s halfway up the stack.",
          reactions: [{ emoji: "👍", count: 1, viewerReacted: false }],
        },
        {
          id: "703-c2",
          author: "sak0a",
          createdAt: m(31),
          body: "Right, the walk should treat every unmerged layer under the target the same way. The new test in `stackLayers.logic.test.ts` already catches it (that's the red CI run). Fixing.",
          reactions: [],
        },
      ],
    },
    {
      id: "703-t2",
      path: "apps/web/src/components/pullRequests/PullRequestStackRail.tsx",
      side: "RIGHT",
      match: "aria-selected={selected}",
      isResolved: false,
      isOutdated: false,
      comments: [
        {
          id: "703-c3",
          author: "eliotm",
          createdAt: hr(3),
          body: '`aria-selected` only means something inside a listbox or tablist. Each layer is a link to its PR, so `aria-current` is the attribute screen readers announce here:\n\n```suggestion\n              aria-current={selected ? "page" : undefined}\n```',
          reactions: [],
        },
      ],
    },
    {
      id: "703-t3",
      path: "apps/web/src/components/pullRequests/PullRequestMergeBox.tsx",
      side: "RIGHT",
      match: "pull requests into",
      isResolved: true,
      resolvedBy: "sak0a",
      isOutdated: false,
      comments: [
        {
          id: "703-c4",
          author: "mvogt",
          createdAt: d(1) /* + review below */,
          body: 'nit: can the confirmation name the base branch? "Merge 3 pull requests into main" says what\'s about to happen; "Merge 3 PRs" makes me count.',
          reactions: [],
        },
        {
          id: "703-c5",
          author: "sak0a",
          createdAt: hr(3),
          body: "Done in f2c7a19.",
          reactions: [{ emoji: "🎉", count: 1, viewerReacted: false }],
        },
      ],
    },
    {
      id: "703-t4",
      path: "apps/web/src/components/pullRequests/stackLayers.logic.ts",
      side: "RIGHT",
      line: null,
      originalLine: 23,
      isResolved: true,
      resolvedBy: "sak0a",
      isOutdated: true,
      diffHunk:
        "@@ -0,0 +21,3 @@\n+/** Bottom → top: the order GitHub reports and the order a merge walks. */\n+export function stackLayers(stack: SourceControlChangeRequestStack): ReadonlyArray<StackLayer> {\n+  const ordered = stack.entries.sort((a, b) => a.position - b.position);",
      comments: [
        {
          id: "703-c6",
          author: "eliotm",
          createdAt: m(3 * 1440 + 30),
          body: "`entries.sort` sorts in place, so this mutates the array cached in the detail atom and every render re-sorts the shared copy.",
          reactions: [],
        },
        {
          id: "703-c7",
          author: "sak0a",
          createdAt: m(2 * 1440 - 5),
          body: "Good catch. I dropped the sort entirely: GitHub already returns bottom → top and the contract documents it.",
          reactions: [{ emoji: "👍", count: 1, viewerReacted: false }],
        },
      ],
    },
    {
      id: "703-t5",
      path: "apps/web/src/components/pullRequests/stackLayers.logic.test.ts",
      side: "RIGHT",
      match: 'describe("planStackMerge"',
      isResolved: true,
      resolvedBy: "sak0a",
      isOutdated: false,
      comments: [
        {
          id: "703-c8",
          author: "mvogt",
          createdAt: m(1440 + 200),
          body: "Can we get a case for a *closed* layer in the middle? That's the one that bit us on the sandbox repo.",
          reactions: [],
        },
        {
          id: "703-c9",
          author: "sak0a",
          createdAt: d(1),
          body: "Added in 4e1d0b2.",
          reactions: [],
        },
      ],
    },
  ];
  // the nit thread was part of mvogt's first review
  T703[2].comments[0].createdAt = m(1440 + 200);

  const BODY703 = `Third layer of the stacked-PR work. It puts the stack **next to** the pull request instead of behind a chip, and lets you merge *through* any layer.

Builds on #702 (stack reads) and #701 (\`mergeStateStatus\` on entries). Closes #655.

### What changes

- New \`PullRequestStackRail\`: every layer, top first, with its state glyph. Click to jump to a layer, ↑/↓ to move focus.
- \`planStackMerge(stack, through)\` decides what a merge through a layer would land and what blocks it.
- The merge box says **Merge stack (n)** when more than one layer would land, and confirms with the base branch named.
- Stack merges invalidate every layer's detail, because GitHub retargets the PRs above.

### Screens

| State | Before | After |
| --- | --- | --- |
| Layer 3 of 4 | chip only | rail + merge-through |
| Draft on top | merge enabled | blocked with reason |

### Checklist

- [x] Logic tests for merge planning
- [x] Browser test for rail keyboard focus
- [ ] Draft layers below the target block the merge (review feedback)
- [ ] Screenshot pass in light and dark

\`\`\`ts
const plan = planStackMerge(stack, 3);
// → { through: 3, layers: [#701, #702, #703], blockedBy: #702 "Waiting on reviews or checks" }
\`\`\`

> The head-SHA guard (\`expectedHeads\`) lands in #704; this PR only records them.`;

  const TL703 = [
    { id: "703-e1", kind: "opened", actor: "sak0a", at: d(4), isDraft: true },
    { id: "703-e2", kind: "labeled", actor: "sak0a", at: d(4), label: "area:web" },
    { id: "703-e3", kind: "labeled", actor: "sak0a", at: d(4), label: "stacks" },
    {
      id: "703-e4",
      kind: "commits",
      actor: "sak0a",
      at: d(4),
      commits: [
        { short: "5c1f0aa", message: "Add stack layer assessment and merge planning" },
        { short: "b7c40d1", message: "Render the stack rail next to the PR header" },
      ],
    },
    {
      id: "703-e5",
      kind: "commits",
      actor: "sak0a",
      at: m(3 * 1440 + 120),
      commits: [
        { short: "d90e3b4", message: "Wire merge-through-layer into the merge box" },
        { short: "e8d2c47", message: "Browser test for rail keyboard focus" },
      ],
    },
    {
      id: "703-e6",
      kind: "renamed",
      actor: "sak0a",
      at: m(3 * 1440 + 110),
      from: "Web: stack rail",
      to: "Web: stack layers rail and merge-through-layer",
    },
    { id: "703-e7", kind: "ready_for_review", actor: "sak0a", at: m(3 * 1440 + 105) },
    {
      id: "703-e8",
      kind: "review_requested",
      actor: "sak0a",
      at: m(3 * 1440 + 104),
      reviewer: "mvogt",
    },
    {
      id: "703-e9",
      kind: "review_requested",
      actor: "sak0a",
      at: m(3 * 1440 + 104),
      reviewer: "eliotm",
    },
    {
      id: "703-e10",
      kind: "review",
      actor: "eliotm",
      at: m(3 * 1440 + 30),
      state: "commented",
      body: "Left one note on the layer walk.",
      threadIds: ["703-t4"],
    },
    {
      id: "703-e11",
      kind: "force_pushed",
      actor: "sak0a",
      at: d(2),
      ref: "ryco/stack-3-web-rail",
      before: sha("e8d2c47"),
      after: sha("19be4f7"),
      note: "Rebased onto ryco/stack-2-server",
    },
    {
      id: "703-e12",
      kind: "comment",
      actor: "ryco-ci[bot]",
      at: m(2 * 1440 - 20),
      editedAt: m(9),
      body: `### Bundle size

| Entry | main | #703 | Δ |
| --- | ---: | ---: | ---: |
| \`web/index\` | 1,201.9 kB | 1,208.4 kB | +6.5 kB (+0.5%) |
| \`web/pull-requests\` | 38.2 kB | 44.7 kB | +6.5 kB (+17.0%) |
| \`desktop/main\` | 412.0 kB | 412.0 kB | 0 |

<details>
<summary>Largest changed modules</summary>

- \`components/pullRequests/PullRequestStackRail.tsx\` +3.1 kB
- \`components/pullRequests/stackLayers.logic.ts\` +1.4 kB
- \`components/pullRequests/PullRequestMergeBox.tsx\` +1.2 kB

</details>

<sub>Updated for 8e5d1c6 · [details](https://github.com/ryco-labs/ryco/actions/runs/18214433871)</sub>`,
      reactions: [],
    },
    {
      id: "703-e13",
      kind: "review",
      actor: "mvogt",
      at: m(1440 + 200),
      state: "commented",
      body: "",
      threadIds: ["703-t3", "703-t5"],
    },
    {
      id: "703-e14",
      kind: "commits",
      actor: "sak0a",
      at: d(1),
      commits: [{ short: "4e1d0b2", message: "Cover a closed layer in the middle of the stack" }],
    },
    {
      id: "703-e15",
      kind: "comment",
      actor: "tkessler",
      at: m(1440 - 60),
      body: "Tried this against the sandbox repo with a 4-layer stack: merging through #2 landed both and GitHub retargeted #3 onto `main` within a couple of seconds. The rail updated on the next poll 🎉",
      reactions: [
        { emoji: "👍", count: 2, viewerReacted: false },
        { emoji: "🎉", count: 1, viewerReacted: true },
      ],
    },
    {
      id: "703-e16",
      kind: "commits",
      actor: "sak0a",
      at: hr(20),
      commits: [{ short: "0b9d3a8", message: "Use stack position in rail aria labels" }],
    },
    {
      id: "703-e17",
      kind: "review",
      actor: "eliotm",
      at: m(3 * 60 + 10),
      state: "commented",
      body: "One a11y suggestion inline, otherwise this reads well.",
      threadIds: ["703-t2"],
    },
    {
      id: "703-e18",
      kind: "commits",
      actor: "sak0a",
      at: hr(3),
      commits: [
        { short: "f2c7a19", message: "Name the base branch in the stack merge confirmation" },
      ],
    },
    {
      id: "703-e19",
      kind: "review",
      actor: "mvogt",
      at: m(52),
      state: "changes_requested",
      body: "The rail reads really well, and merge-through is exactly what I wanted from stacks. Two things before this goes in:\n\n1. the draft walk (inline), which is also why CI is red;\n2. J/K shouldn't move between layers while focus is inside a file in the diff. That probably belongs in #704, just flagging it.",
      threadIds: ["703-t1"],
    },
    {
      id: "703-e20",
      kind: "commits",
      actor: "sak0a",
      at: m(9),
      commits: [
        { short: "8e5d1c6", message: "client-runtime: depend on @ryco/shared for stack helpers" },
      ],
    },
  ];

  const LOG703_FAIL = [
    "$ bun run test --filter=@ryco/web",
    " RUN  v3.2.4 /home/runner/work/ryco/ryco/apps/web",
    "",
    " ✓ src/components/pullRequests/PullRequestMergeBox.logic.test.ts (14 tests) 21ms",
    " ✓ src/lib/diffLines.test.ts (31 tests) 9ms",
    " ❯ src/components/pullRequests/stackLayers.logic.test.ts (5 tests | 1 failed) 18ms",
    "   ✓ planStackMerge > merges through a ready layer 2ms",
    "   × planStackMerge > refuses to merge through a draft layer below the target 6ms",
    "     → expected undefined to be 2 // Object.is equality",
    "   ✓ planStackMerge > refuses to merge through a closed layer in the middle 1ms",
    "",
    "⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯",
    "",
    " FAIL  src/components/pullRequests/stackLayers.logic.test.ts > planStackMerge > refuses to merge through a draft layer below the target",
    "AssertionError: expected undefined to be 2 // Object.is equality",
    "",
    "- Expected",
    "+ Received",
    "",
    "- 2",
    "+ undefined",
    "",
    " ❯ src/components/pullRequests/stackLayers.logic.test.ts:40:43",
    '     38|   it("refuses to merge through a draft layer below the target", () => {',
    "     39|     const plan = planStackMerge(stackOf([open(1), draft(2), open(3)]), 3);",
    "     40|     expect(plan.blockedBy?.entry.position).toBe(2);",
    "       |                                           ^",
    "     41|   });",
    "",
    " Test Files  1 failed | 211 passed (212)",
    "      Tests  1 failed | 1845 passed (1846)",
    "   Duration  57.94s",
    "",
    'error: script "test" exited with code 1',
    "##[error]Process completed with exit code 1.",
  ];

  const D703 = {
    number: 703,
    headSha: sha("8e5d1c6"),
    baseSha: sha("3f8a0c2"),
    body: BODY703,
    participants: ["sak0a", "mvogt", "eliotm", "tkessler", "ryco-ci[bot]"],
    reviewers: [
      { login: "mvogt", state: "changes_requested", submittedAt: m(52), requested: false },
      { login: "eliotm", state: "commented", submittedAt: m(190), requested: false },
    ],
    linkedIssues: [
      { number: 655, title: "Stacked PRs: show every layer and merge through one", state: "open" },
    ],
    linkedThreads: [
      {
        id: "th1",
        title: "Fix the draft walk in planStackMerge",
        state: "working",
        provider: "claude",
        model: "Opus 5.5",
        startedAt: m(6),
      },
    ],
    behindBy: 0,
    commits: C703,
    files: F703,
    threads: T703,
    timeline: TL703,
    pendingReview: null,
    checks: {
      workflows: [
        workflow(703, "ci", {
          runId: 18214433871,
          runNumber: 4182,
          headSha: sha("8e5d1c6"),
          startedMin: 9,
          outcomes: { "test-web": "failure" },
          logs: { "test-web": LOG703_FAIL },
        }),
        workflow(703, "release", {
          runId: 18214433902,
          runNumber: 611,
          headSha: sha("8e5d1c6"),
          startedMin: 9,
        }),
      ],
      statuses: [
        {
          name: "Vercel – ryco-web",
          state: "success",
          description: "Preview deployed",
          url: "https://ryco-web-git-ryco-stack-3-web-rail-ryco-labs.vercel.app",
          at: m(6),
        },
      ],
    },
  };

  /* ============================================================
     DETAIL #712 · review requested from you · pending review
     ============================================================ */
  const C712 = [
    ["2b8f1e0", "Flatten parsed diff files into virtual rows", d(2), "passing"],
    ["6a90c3d", "Render the PR diff through LegendList", d(2), "passing"],
    ["91d4e7b", "Sticky file headers inside the virtual list", m(1440 + 300), "passing"],
    ["c08a5f2", "Keep expanded files across tab switches", d(1), "passing"],
    ["3e7b6d1", "Measure row heights once per file", hr(20), "passing"],
    ["a5d29c8", "Tests for row flattening and sticky headers", hr(19), "passing"],
    ["7f13e04", "Handle \\ No newline at end of file in diffLines", m(18), "passing"],
  ].map(([short, message, committedAt, checks]) => ({
    sha: sha(short),
    short,
    message,
    author: "mvogt",
    committedAt,
    checks,
  }));

  const F712 = [
    {
      path: "apps/web/src/components/pullRequests/PullRequestDiffList.tsx",
      status: "added",
      viewed: "unviewed",
      commits: ["6a90c3d", "91d4e7b", "3e7b6d1"],
      patch: patch(`
@@ -0,0 +1 @@
+import { LegendList, type LegendListRef } from "@legendapp/list";
+import { memo, useMemo, useRef } from "react";
+
+import { useStickyFileHeader } from "../../hooks/useStickyFileHeader";
+import { DiffFileHeader } from "./DiffFileHeader";
+import { DiffLineRow } from "./DiffLineRow";
+import {
+  ESTIMATED_ROW_HEIGHT,
+  fileHeaderIndexes,
+  flattenDiffRows,
+  type DiffFileInput,
+  type DiffRow,
+} from "./diffRows.logic";
+
+export interface PullRequestDiffListProps {
+  readonly files: ReadonlyArray<DiffFileInput>;
+  readonly onToggleFile: (path: string) => void;
+}
+
+/**
+ * Every file of the PR in one virtual list. A 3,000-line diff used to mount
+ * 3,000 <div>s; this keeps roughly two screens of rows alive.
+ */
+export const PullRequestDiffList = memo(function PullRequestDiffList({
+  files,
+  onToggleFile,
+}: PullRequestDiffListProps) {
+  const listRef = useRef<LegendListRef>(null);
+  const rows = useMemo(() => flattenDiffRows(files), [files]);
+  const headers = useMemo(() => fileHeaderIndexes(rows), [rows]);
+  const sticky = useStickyFileHeader(listRef, headers);
+
+  return (
+    <div className="relative min-h-0 flex-1">
+      {sticky !== null ? (
+        <DiffFileHeader row={rows[sticky]} sticky onToggle={onToggleFile} />
+      ) : null}
+      <LegendList<DiffRow>
+        ref={listRef}
+        data={rows}
+        keyExtractor={(row) => row.key}
+        estimatedItemSize={ESTIMATED_ROW_HEIGHT}
+        drawDistance={1200}
+        recycleItems
+        getItemType={(row) => row.kind}
+        renderItem={({ item }) =>
+          item.kind === "file" ? (
+            <DiffFileHeader row={item} onToggle={onToggleFile} />
+          ) : item.kind === "hunk" ? (
+            <div className="diff-hunk-row">{item.header}</div>
+          ) : (
+            <DiffLineRow line={item.line} />
+          )
+        }
+        className="h-full"
+      />
+    </div>
+  );
+});
`),
    },
    {
      path: "apps/web/src/components/pullRequests/diffRows.logic.ts",
      status: "added",
      viewed: "viewed",
      commits: ["2b8f1e0", "3e7b6d1"],
      patch: patch(`
@@ -0,0 +1 @@
+import type { DiffLine } from "../../lib/diffLines";
+
+export const ESTIMATED_ROW_HEIGHT = 20;
+
+export interface DiffFileInput {
+  readonly path: string;
+  readonly additions: number;
+  readonly deletions: number;
+  readonly lines: ReadonlyArray<DiffLine>;
+  readonly collapsed: boolean;
+}
+
+export type DiffRow =
+  | {
+      readonly kind: "file";
+      readonly key: string;
+      readonly path: string;
+      readonly additions: number;
+      readonly deletions: number;
+    }
+  | { readonly kind: "hunk"; readonly key: string; readonly path: string; readonly header: string }
+  | { readonly kind: "line"; readonly key: string; readonly path: string; readonly line: DiffLine };
+
+/**
+ * One flat list for the virtualizer: a header row per file, then its hunks and
+ * lines unless the file is collapsed. Sticky headers index into this list.
+ */
+export function flattenDiffRows(files: ReadonlyArray<DiffFileInput>): ReadonlyArray<DiffRow> {
+  const rows: DiffRow[] = [];
+  for (const file of files) {
+    rows.push({
+      kind: "file",
+      key: "file:" + file.path,
+      path: file.path,
+      additions: file.additions,
+      deletions: file.deletions,
+    });
+    if (file.collapsed) continue;
+    file.lines.forEach((line, index) => {
+      const key = file.path + ":" + index;
+      rows.push(
+        line.kind === "hunk"
+          ? { kind: "hunk", key, path: file.path, header: line.text }
+          : { kind: "line", key, path: file.path, line },
+      );
+    });
+  }
+  return rows;
+}
+
+export function fileHeaderIndexes(rows: ReadonlyArray<DiffRow>): ReadonlyArray<number> {
+  const indexes: number[] = [];
+  rows.forEach((row, index) => {
+    if (row.kind === "file") indexes.push(index);
+  });
+  return indexes;
+}
`),
    },
    {
      path: "apps/web/src/components/pullRequests/PullRequestFilesTab.tsx",
      status: "modified",
      viewed: "unviewed",
      commits: ["6a90c3d", "c08a5f2"],
      patch: patch(`
@@ -9 +9 @@ import { usePullRequestFilesViewed } from "../projectExplorer/usePullRequestFilesViewed";
 import { Button } from "../ui/button";
 import { parseDiffLines } from "../../lib/diffLines";
+import { PullRequestDiffList } from "./PullRequestDiffList";
+import { usePullRequestFilesState } from "./usePullRequestFilesState";
 import { splitUnifiedDiffByFile } from "../../lib/unifiedDiffSplit";

 export function PullRequestFilesTab({ detail, active }: PullRequestFilesTabProps) {
-  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
+  // Lifted out of the tab so expanded files survive switching to Checks and back.
+  const { expanded, toggle } = usePullRequestFilesState(detail.number);
   const viewed = usePullRequestFilesViewed(detail, active);
   const diff = useChangeRequestDiff(detail, active && expanded.size > 0);
@@ -42 +45 @@ export function PullRequestFilesTab({ detail, active }: PullRequestFilesTabProps) {
-  const byFile = useMemo(() => (diff.data ? splitUnifiedDiffByFile(diff.data) : null), [diff.data]);
+  const files = useMemo(() => {
+    if (!diff.data) return [];
+    const byFile = splitUnifiedDiffByFile(diff.data);
+    return detail.files.map((file) => ({
+      path: file.path,
+      additions: file.additions,
+      deletions: file.deletions,
+      lines: parseDiffLines(byFile.get(file.path) ?? ""),
+      collapsed: !expanded.has(file.path),
+    }));
+  }, [detail.files, diff.data, expanded]);

   return (
     <div className="flex h-full min-h-0 flex-col">
       <PullRequestFilesToolbar viewed={viewed} total={detail.files.length} />
-      <div className="min-h-0 flex-1 overflow-y-auto">
-        {detail.files.map((file) => (
-          <PullRequestFileSection
-            key={file.path}
-            file={file}
-            expanded={expanded.has(file.path)}
-            onToggle={() => setExpanded((prev) => toggleSetEntry(prev, file.path))}
-          >
-            <pre className="overflow-x-auto font-mono text-xs">
-              {parseDiffLines(byFile?.get(file.path) ?? "").map((line, index) => (
-                <DiffLineRow key={index} line={line} />
-              ))}
-            </pre>
-          </PullRequestFileSection>
-        ))}
-      </div>
+      <PullRequestDiffList files={files} onToggleFile={toggle} />
     </div>
   );
 }
`),
    },
    {
      path: "apps/web/src/hooks/useStickyFileHeader.ts",
      status: "added",
      viewed: "unviewed",
      commits: ["91d4e7b"],
      patch: patch(`
@@ -0,0 +1 @@
+import type { LegendListRef } from "@legendapp/list";
+import { type RefObject, useEffect, useState } from "react";
+
+/**
+ * Index of the file header that should stick to the top of the list: the last
+ * header at or above the first visible row. Null while the list is at the top.
+ */
+export function useStickyFileHeader(
+  listRef: RefObject<LegendListRef | null>,
+  headerIndexes: ReadonlyArray<number>,
+): number | null {
+  const [sticky, setSticky] = useState<number | null>(null);
+
+  useEffect(() => {
+    const list = listRef.current;
+    if (!list) return;
+    return list.addViewableItemsListener(({ start }) => {
+      if (start <= 0) return setSticky(null);
+      let found: number | null = null;
+      for (const index of headerIndexes) {
+        if (index > start) break;
+        found = index;
+      }
+      setSticky(found === start ? null : found);
+    });
+  }, [listRef, headerIndexes]);
+
+  return sticky;
+}
`),
    },
    {
      path: "apps/web/src/lib/diffLines.ts",
      status: "modified",
      viewed: "viewed",
      commits: ["7f13e04"],
      patch: patch(`
@@ -1 +1 @@
 export interface DiffLine {
-  readonly kind: "hunk" | "context" | "add" | "remove";
+  readonly kind: "hunk" | "context" | "add" | "remove" | "meta";
   readonly oldLineNumber: number | null;
   readonly newLineNumber: number | null;
   readonly text: string;
 }
@@ -27 +27 @@ export function parseDiffLines(patch: string): DiffLine[] {
     if (raw.startsWith("@@")) {
       [oldLine, newLine] = parseHunkStart(raw);
       lines.push({ kind: "hunk", oldLineNumber: null, newLineNumber: null, text: raw });
       continue;
     }
+    // "\\ No newline at end of file" belongs to the line above, not the file.
+    if (raw.startsWith("\\\\")) {
+      lines.push({ kind: "meta", oldLineNumber: null, newLineNumber: null, text: raw.slice(2) });
+      continue;
+    }
     const marker = raw[0];
     const text = raw.slice(1);
`),
    },
    {
      path: "apps/web/package.json",
      status: "modified",
      viewed: "viewed",
      commits: ["6a90c3d"],
      patch: patch(`
@@ -31 +31 @@
     "@base-ui-components/react": "1.0.0-beta.4",
     "@effect/atom-react": "catalog:",
+    "@legendapp/list": "3.0.0-beta.31",
     "@pierre/diffs": "1.4.1",
     "@ryco/client-runtime": "workspace:*",
     "@ryco/contracts": "workspace:*",
`),
    },
    {
      path: "bun.lock",
      status: "modified",
      viewed: "unviewed",
      generated: true,
      commits: ["6a90c3d"],
      patch: patch(`
@@ -112 +112 @@
       "dependencies": {
         "@base-ui-components/react": "1.0.0-beta.4",
         "@effect/atom-react": "catalog:",
+        "@legendapp/list": "3.0.0-beta.31",
         "@pierre/diffs": "1.4.1",
         "@ryco/client-runtime": "workspace:*",
@@ -688 +689 @@
     "@jridgewell/trace-mapping": ["@jridgewell/trace-mapping@0.3.31", "", { "dependencies": { "@jridgewell/resolve-uri": "^3.1.0", "@jridgewell/sourcemap-codec": "^1.4.14" } }, "sha512-zzNR+SdQSDJzc8joaeP8QQoCQr8NuYx2dIIytl1QeBEZHJ9uW6hebsrYgbz8hJwUQao3TWCMtmfV8Nu1twOLAw=="],

+    "@legendapp/list": ["@legendapp/list@3.0.0-beta.31", "", { "dependencies": { "use-sync-external-store": "^1.5.0" }, "peerDependencies": { "react": "*" } }, "sha512-H4vJ6cQm2Tq0p8yJdYwL0aN3rX1uG8bK7sE2fZ5iP9oD3cV6tM1nR4hW8xA2yB5zC7dE9fG1hI3jK5lM7nO9pQ=="],
+
     "@napi-rs/wasm-runtime": ["@napi-rs/wasm-runtime@1.0.7", "", { "dependencies": { "@emnapi/core": "^1.5.0", "@emnapi/runtime": "^1.5.0", "@tybys/wasm-util": "^0.10.1" } }, "sha512-SeDnOO0Tk7Okiq6DbXmmBODgOAb9dp9gjlphokTUxmt8U3liIP1ZsozBahH69j/RJv+Rfs6IwUKHTgQYJ/HBAw=="],
`),
    },
    {
      path: "apps/web/src/components/pullRequests/diffRows.logic.test.ts",
      status: "added",
      viewed: "unviewed",
      commits: ["a5d29c8"],
      patch: patch(`
@@ -0,0 +1 @@
+import { describe, expect, it } from "vitest";
+
+import { parseDiffLines } from "../../lib/diffLines";
+import { fileHeaderIndexes, flattenDiffRows } from "./diffRows.logic";
+
+const file = (path: string, collapsed = false) => ({
+  path,
+  additions: 2,
+  deletions: 1,
+  collapsed,
+  lines: parseDiffLines("@@ -1,2 +1,3 @@\\n context\\n-old\\n+new\\n+added"),
+});
+
+describe("flattenDiffRows", () => {
+  it("emits a header, then hunks and lines, per file", () => {
+    const rows = flattenDiffRows([file("a.ts"), file("b.ts")]);
+    expect(rows.map((row) => row.kind)).toEqual([
+      "file", "hunk", "line", "line", "line", "line",
+      "file", "hunk", "line", "line", "line", "line",
+    ]);
+  });
+
+  it("keeps only the header of a collapsed file", () => {
+    const rows = flattenDiffRows([file("a.ts", true), file("b.ts")]);
+    expect(rows.slice(0, 2).map((row) => row.kind)).toEqual(["file", "file"]);
+  });
+
+  it("indexes file headers for the sticky header", () => {
+    const rows = flattenDiffRows([file("a.ts"), file("b.ts", true), file("c.ts")]);
+    expect(fileHeaderIndexes(rows)).toEqual([0, 6, 7]);
+  });
+});
`),
    },
    {
      path: "apps/web/src/components/pullRequests/PullRequestFilesTab.browser.tsx",
      status: "modified",
      viewed: "unviewed",
      commits: ["a5d29c8"],
      patch: patch(`
@@ -58 +58 @@ describe("PullRequestFilesTab", () => {
     await expect.element(page.getByText("2/5 viewed")).toBeVisible();
   });
+
+  it("mounts only the visible rows of a 3,000-line diff", async () => {
+    await renderFilesTab({ detail: largeDiffFixture, expandAll: true });
+    await expect.element(page.getByText("apps/server/src/ws.ts")).toBeVisible();
+    const mounted = document.querySelectorAll("[data-diff-row]").length;
+    expect(mounted).toBeGreaterThan(40);
+    expect(mounted).toBeLessThan(400);
+  });
+
+  it("keeps the current file header pinned while scrolling its lines", async () => {
+    await renderFilesTab({ detail: largeDiffFixture, expandAll: true });
+    await scrollDiffBy(2_400);
+    await expect
+      .element(page.getByTestId("diff-sticky-header"))
+      .toHaveTextContent("apps/server/src/ws.ts");
+  });
 });
`),
    },
    {
      path: "apps/web/src/index.css",
      status: "modified",
      viewed: "unviewed",
      commits: ["91d4e7b"],
      patch: patch(`
@@ -1388 +1388 @@
   .diff-render-file {
     contain: layout paint;
   }
+
+  .diff-hunk-row {
+    padding-inline: 0.75rem;
+    font-family: var(--font-mono);
+    font-size: 11px;
+    line-height: 20px;
+    color: var(--muted-foreground);
+    background: color-mix(in srgb, var(--muted) 60%, transparent);
+  }
 }
`),
    },
  ];

  const T712 = [
    {
      id: "712-t1",
      path: "apps/web/src/components/pullRequests/diffRows.logic.ts",
      side: "RIGHT",
      match: 'const key = file.path + ":" + index;',
      isResolved: false,
      isOutdated: false,
      comments: [
        {
          id: "712-c1",
          author: "eliotm",
          createdAt: hr(20),
          body: "Index keys will shift every row below a hunk once we load more context into it, and LegendList will recycle the wrong rows. Could the key come from the old/new line numbers instead?",
          reactions: [],
        },
        {
          id: "712-c2",
          author: "mvogt",
          createdAt: hr(19),
          body: "Agreed for hunk expansion, but nothing reorders today because expansion isn't wired up yet. I'd rather do it together with expansion in a follow-up. OK with you?",
          reactions: [],
        },
      ],
    },
    {
      id: "712-t2",
      path: "apps/web/src/components/pullRequests/PullRequestDiffList.tsx",
      side: "RIGHT",
      match: "estimatedItemSize={ESTIMATED_ROW_HEIGHT}",
      isResolved: true,
      resolvedBy: "mvogt",
      isOutdated: false,
      comments: [
        {
          id: "712-c3",
          author: "eliotm",
          createdAt: hr(20),
          body: "Is 20 still right once lines wrap?",
          reactions: [],
        },
        {
          id: "712-c4",
          author: "mvogt",
          createdAt: hr(19),
          body: "It's only the estimate for unwrapped lines. Wrapped rows are measured after the first layout, and 3e7b6d1 caches those measurements per file.",
          reactions: [{ emoji: "👍", count: 1, viewerReacted: false }],
        },
      ],
    },
  ];

  const BODY712 = `Replaces the \`<pre>\` diff in the Files tab with a single virtualized list (LegendList), so big PRs open instantly and scroll without dropping frames.

Part of #640.

### Numbers

Profiled on the 3,014-line diff from #640 (M5, Chrome 141):

| | before | after |
| --- | ---: | ---: |
| First paint of Files | 1.9 s | 180 ms |
| DOM nodes | 41,870 | 2,912 |
| Scroll (p95 frame) | 31 ms | 7 ms |

### How

1. \`flattenDiffRows\` turns parsed files into one list of \`file | hunk | line\` rows.
2. \`PullRequestDiffList\` renders it with LegendList and recycles rows by kind.
3. \`useStickyFileHeader\` pins the header of the file you're scrolling through.
4. Expanded files now live in \`usePullRequestFilesState\`, so they survive tab switches.

\`\`\`tsx
<LegendList<DiffRow>
  data={rows}
  keyExtractor={(row) => row.key}
  estimatedItemSize={ESTIMATED_ROW_HEIGHT}
  recycleItems
/>
\`\`\`

### Not in this PR

- [ ] Hunk expansion (needs a "file at revision" RPC)
- [ ] Split view in the virtual list
- [x] Viewed state keeps working

cc @sak0a for the sticky header behaviour, you wrote the original Files tab.`;

  const TL712 = [
    { id: "712-e1", kind: "opened", actor: "mvogt", at: d(2) },
    {
      id: "712-e2",
      kind: "commits",
      actor: "mvogt",
      at: d(2),
      commits: [
        { short: "2b8f1e0", message: "Flatten parsed diff files into virtual rows" },
        { short: "6a90c3d", message: "Render the PR diff through LegendList" },
      ],
    },
    { id: "712-e3", kind: "labeled", actor: "mvogt", at: d(2), label: "perf" },
    { id: "712-e4", kind: "labeled", actor: "mvogt", at: d(2), label: "area:web" },
    { id: "712-e5", kind: "assigned", actor: "mvogt", at: d(2), assignee: "mvogt" },
    { id: "712-e6", kind: "review_requested", actor: "mvogt", at: d(2), reviewer: "sak0a" },
    { id: "712-e7", kind: "review_requested", actor: "mvogt", at: d(2), reviewer: "eliotm" },
    {
      id: "712-e8",
      kind: "review_requested",
      actor: "mvogt",
      at: d(2),
      reviewer: "ryco-labs/web",
      team: true,
    },
    {
      id: "712-e9",
      kind: "comment",
      actor: "ryco-ci[bot]",
      at: m(2 * 1440 - 15),
      editedAt: m(14),
      body: `### Bundle size

| Entry | main | #712 | Δ |
| --- | ---: | ---: | ---: |
| \`web/index\` | 1,201.9 kB | 1,216.1 kB | +14.2 kB (+1.2%) |
| \`web/pull-requests\` | 38.2 kB | 41.0 kB | +2.8 kB (+7.3%) |

<details>
<summary>New dependencies</summary>

- \`@legendapp/list\` 3.0.0-beta.31 (+11.4 kB gzip)

</details>`,
      reactions: [],
    },
    {
      id: "712-e10",
      kind: "commits",
      actor: "mvogt",
      at: d(1),
      commits: [
        { short: "91d4e7b", message: "Sticky file headers inside the virtual list" },
        { short: "c08a5f2", message: "Keep expanded files across tab switches" },
      ],
    },
    {
      id: "712-e11",
      kind: "comment",
      actor: "mvogt",
      at: m(1440 - 30),
      body: "Recording of the 3k-line diff before/after is in the Linear issue. Scrolling now stays at 120 fps on the M5 and the sticky header doesn't jump at file boundaries anymore.",
      reactions: [
        { emoji: "🚀", count: 3, viewerReacted: true },
        { emoji: "👀", count: 1, viewerReacted: false },
      ],
    },
    {
      id: "712-e12",
      kind: "review",
      actor: "eliotm",
      at: hr(20),
      state: "commented",
      body: "Nice speedup. Two questions inline. The keys one matters once expansion lands.",
      threadIds: ["712-t1", "712-t2"],
    },
    {
      id: "712-e13",
      kind: "commits",
      actor: "mvogt",
      at: hr(19),
      commits: [
        { short: "3e7b6d1", message: "Measure row heights once per file" },
        { short: "a5d29c8", message: "Tests for row flattening and sticky headers" },
      ],
    },
    {
      id: "712-e14",
      kind: "commits",
      actor: "mvogt",
      at: m(18),
      commits: [{ short: "7f13e04", message: "Handle \\ No newline at end of file in diffLines" }],
    },
  ];

  const D712 = {
    number: 712,
    headSha: sha("7f13e04"),
    baseSha: sha("3f8a0c2"),
    body: BODY712,
    participants: ["mvogt", "eliotm", "sak0a", "ryco-ci[bot]"],
    reviewers: [
      { login: "sak0a", state: "pending", submittedAt: null, requested: true },
      { login: "eliotm", state: "commented", submittedAt: hr(20), requested: false },
      { login: "ryco-labs/web", state: "pending", submittedAt: null, requested: true, team: true },
    ],
    linkedIssues: [
      { number: 640, title: "Files tab is slow on large pull requests", state: "open" },
    ],
    linkedThreads: [],
    behindBy: 0,
    commits: C712,
    files: F712,
    threads: T712,
    timeline: TL712,
    /* The viewer's unsubmitted review: one inline draft comment. */
    pendingReview: {
      startedAt: m(12),
      body: "",
      comments: [
        {
          id: "712-p1",
          path: "apps/web/src/components/pullRequests/PullRequestDiffList.tsx",
          side: "RIGHT",
          match: "drawDistance={1200}",
          body: "Could the draw distance follow the viewport height instead of a fixed 1200? On a 4K display the list runs out of rendered rows when you fling-scroll.",
        },
      ],
    },
    checks: {
      workflows: [
        workflow(712, "ci", {
          runId: 18214391144,
          runNumber: 4179,
          headSha: sha("7f13e04"),
          startedMin: 18,
        }),
        workflow(712, "release", {
          runId: 18214391190,
          runNumber: 609,
          headSha: sha("7f13e04"),
          startedMin: 18,
        }),
      ],
      statuses: [
        {
          name: "Vercel – ryco-web",
          state: "success",
          description: "Preview deployed",
          url: "https://ryco-web-git-mvogt-pr-diff-virtualization-ryco-labs.vercel.app",
          at: m(14),
        },
      ],
    },
  };

  /* ============================================================
     DETAIL #701 · stack bottom · approved, green, mergeable
     ============================================================ */
  const C701 = [
    ["d1e4a07", "Add mergeStateStatus and headSha to stack entries", d(5), "passing"],
    ["6c2b9f1", "Decode mergeStateStatus from the stack GraphQL", d(5), "passing"],
    ["a8f03e6", "Stack snapshot state in client-runtime", d(4), "passing"],
    ["57de2c4", "Export the pull-request-stack subpath", d(4), "passing"],
    ["e2b6f90", "Allow sourceControl.getChangeRequestStack for operators", d(3), "passing"],
    ["0c4d8b5", "Contract tests for stack entry decoding", hr(5), "passing"],
  ].map(([short, message, committedAt, checks]) => ({
    sha: sha(short),
    short,
    message,
    author: "sak0a",
    committedAt,
    checks,
  }));

  const F701 = [
    {
      path: "packages/contracts/src/sourceControl.ts",
      status: "modified",
      viewed: "unviewed",
      commits: ["d1e4a07"],
      patch: patch(`
@@ -29 +29 @@ export const SourceControlChangeRequestMergeability = Schema.Literals([
 ]);
 export type SourceControlChangeRequestMergeability =
   typeof SourceControlChangeRequestMergeability.Type;

+/**
+ * GitHub's mergeStateStatus, kept verbatim so the merge box can say *why* a
+ * layer is blocked. UNKNOWN decodes to null: it means "not computed yet".
+ */
+export const SourceControlMergeStateStatus = Schema.Literals([
+  "BEHIND",
+  "BLOCKED",
+  "CLEAN",
+  "DIRTY",
+  "DRAFT",
+  "HAS_HOOKS",
+  "UNSTABLE",
+]);
+export type SourceControlMergeStateStatus = typeof SourceControlMergeStateStatus.Type;
+
 /** Compact stack identity used by change-request list rows. */
 export const SourceControlChangeRequestStackSummary = Schema.Struct({
   number: PositiveInt,
@@ -43 +58 @@ export type SourceControlChangeRequestStackSummary =
 export const SourceControlChangeRequestStackEntry = Schema.Struct({
   position: PositiveInt,
   number: PositiveInt,
   title: TrimmedNonEmptyString,
   url: TrimmedNonEmptyString,
   headRefName: TrimmedNonEmptyString,
+  headSha: TrimmedNonEmptyString,
   baseRefName: TrimmedNonEmptyString,
   state: ChangeRequestState,
   isDraft: Schema.Boolean,
   mergeability: SourceControlChangeRequestMergeability,
-  mergeStateStatus: Schema.optional(Schema.NullOr(Schema.String)),
+  mergeStateStatus: Schema.NullOr(SourceControlMergeStateStatus),
 });
`),
    },
    {
      path: "apps/server/src/sourceControl/gitHubPullRequestStacks.ts",
      status: "modified",
      viewed: "unviewed",
      commits: ["6c2b9f1"],
      patch: patch(`
@@ -16 +16 @@ export const GITHUB_PULL_REQUEST_STACK_QUERY = \`
         nodes {
           position
           pullRequest {
             number
             title
             url
             headRefName
+            headRefOid
             baseRefName
             state
             isDraft
             mergeable
+            mergeStateStatus
           }
         }
@@ -118 +120 @@ const RawStackEntrySchema = Schema.Struct({
-  mergeStateStatus: Schema.optional(Schema.NullOr(Schema.String)),
+  headRefOid: Schema.String,
+  mergeStateStatus: Schema.optionalWith(Schema.String, { nullable: true }),
 });

+const KNOWN_MERGE_STATES = new Set<string>([
+  "BEHIND",
+  "BLOCKED",
+  "CLEAN",
+  "DIRTY",
+  "DRAFT",
+  "HAS_HOOKS",
+  "UNSTABLE",
+]);
+
+/** UNKNOWN (or anything newer than this list) means "not computed yet". */
+function decodeMergeStateStatus(raw: string | undefined): SourceControlMergeStateStatus | null {
+  return raw && KNOWN_MERGE_STATES.has(raw) ? (raw as SourceControlMergeStateStatus) : null;
+}
+
 function toStackEntry(raw: typeof RawStackEntrySchema.Type): SourceControlChangeRequestStackEntry {
   return {
     position: raw.position,
     number: raw.pullRequest.number,
     title: raw.pullRequest.title,
     url: raw.pullRequest.url,
     headRefName: raw.pullRequest.headRefName,
+    headSha: raw.pullRequest.headRefOid,
     baseRefName: raw.pullRequest.baseRefName,
     state: toChangeRequestState(raw.pullRequest.state),
     isDraft: raw.pullRequest.isDraft,
     mergeability: toMergeability(raw.pullRequest.mergeable),
-    mergeStateStatus: raw.pullRequest.mergeStateStatus ?? null,
+    mergeStateStatus: decodeMergeStateStatus(raw.pullRequest.mergeStateStatus),
   };
 }
`),
    },
    {
      path: "apps/server/src/sourceControl/gitHubPullRequestStacks.test.ts",
      status: "modified",
      viewed: "unviewed",
      commits: ["6c2b9f1", "0c4d8b5"],
      patch: patch(`
@@ -84 +84 @@ describe("normalizeGitHubPullRequestStackPages", () => {
     expect(stack.entries.map((entry) => entry.position)).toEqual([1, 2, 3]);
   });
+
+  it("keeps known merge states and drops UNKNOWN to null", () => {
+    const stack = normalizeGitHubPullRequestStackPages(
+      [
+        stackPage([
+          rawEntry(1, { mergeStateStatus: "CLEAN" }),
+          rawEntry(2, { mergeStateStatus: "UNKNOWN" }),
+          rawEntry(3, { mergeStateStatus: "BEHIND" }),
+        ]),
+      ],
+      2,
+    );
+    expect(stack.entries.map((entry) => entry.mergeStateStatus)).toEqual(["CLEAN", null, "BEHIND"]);
+  });
+
+  it("carries each layer's head SHA for the merge guard", () => {
+    const stack = normalizeGitHubPullRequestStackPages([stackPage([rawEntry(1), rawEntry(2)])], 1);
+    expect(stack.entries[1]?.headSha).toBe("b".repeat(40));
+  });
 });
`),
    },
    {
      path: "packages/client-runtime/src/state/pull-request-stack.ts",
      status: "added",
      viewed: "viewed",
      commits: ["a8f03e6"],
      patch: patch(`
@@ -0,0 +1 @@
+import type { SourceControlChangeRequestStack } from "@ryco/contracts";
+
+export interface PullRequestStackSnapshot {
+  readonly stack: SourceControlChangeRequestStack | null;
+  readonly incomplete: boolean;
+}
+
+export const EMPTY_STACK_SNAPSHOT: PullRequestStackSnapshot = {
+  stack: null,
+  incomplete: false,
+};
+
+/**
+ * A stack is only trustworthy when every page decoded and the selected PR is
+ * one of its entries. Anything else is shown as "may be stale", never hidden.
+ */
+export function stackSnapshot(
+  stack: SourceControlChangeRequestStack | null,
+  selected: number,
+  metadataIncomplete: boolean,
+): PullRequestStackSnapshot {
+  const contains = stack?.entries.some((entry) => entry.number === selected) ?? false;
+  const incomplete = metadataIncomplete || (stack !== null && !contains);
+  return { stack, incomplete };
+}
+
+export function stackLayerAbove(stack: SourceControlChangeRequestStack, position: number) {
+  return stack.entries.find((entry) => entry.position === position + 1) ?? null;
+}
`),
    },
    {
      path: "packages/client-runtime/package.json",
      status: "modified",
      viewed: "viewed",
      commits: ["57de2c4", "0c4d8b5"],
      patch: patch(`
@@ -18 +18 @@
   "dependencies": {
     "@ryco/contracts": "workspace:*",
     "effect": "catalog:"
   },
   "devDependencies": {
+    "@effect/vitest": "catalog:",
     "vitest": "catalog:"
   },
@@ -104 +105 @@
     "./state/pull-request-review": "./src/state/pull-request-review/index.ts",
+    "./state/pull-request-stack": "./src/state/pull-request-stack.ts",
     "./state/threads": "./src/state/threads/index.ts",
`),
    },
    {
      path: "bun.lock",
      status: "modified",
      viewed: "unviewed",
      generated: true,
      commits: ["0c4d8b5"],
      patch: patch(`
@@ -74 +74 @@
     "packages/client-runtime": {
       "name": "@ryco/client-runtime",
       "version": "0.9.0",
       "dependencies": {
         "@ryco/contracts": "workspace:*",
         "effect": "catalog:",
       },
       "devDependencies": {
+        "@effect/vitest": "catalog:",
         "vitest": "catalog:",
       },
     },
`),
    },
    {
      path: "packages/contracts/src/sourceControl.test.ts",
      status: "modified",
      viewed: "unviewed",
      commits: ["0c4d8b5"],
      patch: patch(`
@@ -211 +211 @@ describe("SourceControlChangeRequestStack", () => {
     expect(decoded.entries).toHaveLength(2);
   });
+
+  it("rejects an entry without a head SHA", () => {
+    const { headSha: _, ...withoutHead } = stackEntryFixture(1);
+    expect(() =>
+      Schema.decodeUnknownSync(SourceControlChangeRequestStackEntry)(withoutHead),
+    ).toThrow(/headSha/);
+  });
+
+  it("accepts a null mergeStateStatus while GitHub is still computing it", () => {
+    const entry = { ...stackEntryFixture(1), mergeStateStatus: null };
+    expect(Schema.decodeUnknownSync(SourceControlChangeRequestStackEntry)(entry)).toMatchObject({
+      mergeStateStatus: null,
+    });
+  });
 });
`),
    },
    {
      path: "packages/shared/src/rpcAccessPolicy.ts",
      status: "modified",
      viewed: "viewed",
      commits: ["e2b6f90"],
      patch: patch(`
@@ -158 +158 @@ export const RPC_ACCESS_POLICY: Record<RpcMethod, RpcAccess> = {
   [WS_METHODS.sourceControlGetChangeRequestDetail]: "operator",
   [WS_METHODS.sourceControlGetChangeRequestDiff]: "operator",
+  [WS_METHODS.sourceControlGetChangeRequestStack]: "operator",
   [WS_METHODS.sourceControlMergeChangeRequest]: "operator",
   [WS_METHODS.sourceControlListWorkflowRuns]: "operator",
`),
    },
  ];

  const T701 = [
    {
      id: "701-t1",
      path: "apps/server/src/sourceControl/gitHubPullRequestStacks.ts",
      side: "RIGHT",
      match: "function decodeMergeStateStatus",
      isResolved: true,
      resolvedBy: "sak0a",
      isOutdated: false,
      comments: [
        {
          id: "701-c1",
          author: "tkessler",
          createdAt: d(4),
          body: "Should `UNKNOWN` decode to `null` here? Otherwise the UI shows a status it can't explain, and GitHub returns UNKNOWN for the first few seconds after every push.",
          reactions: [],
        },
        {
          id: "701-c2",
          author: "sak0a",
          createdAt: m(4 * 1440 - 40),
          body: "Yes. It maps to `null` now, and anything newer than the known list does too.",
          reactions: [{ emoji: "👍", count: 1, viewerReacted: false }],
        },
      ],
    },
  ];

  const BODY701 = `Bottom layer of the stacked-PR work. It's contracts and decoding only, with no UI.

- \`SourceControlChangeRequestStackEntry\` gains \`headSha\` and a typed \`mergeStateStatus\`.
- The stack GraphQL query asks for \`headRefOid\` and \`mergeStateStatus\`.
- New \`@ryco/client-runtime/state/pull-request-stack\` subpath with \`stackSnapshot\`.
- \`sourceControl.getChangeRequestStack\` is allowed for operators.

- [x] Contract tests
- [x] Decoder tests for UNKNOWN → null

Next layers: #702 (server reads) → #703 (rail + merge-through) → #704 (keyboard).`;

  const TL701 = [
    { id: "701-e1", kind: "opened", actor: "sak0a", at: d(5) },
    {
      id: "701-e2",
      kind: "commits",
      actor: "sak0a",
      at: d(5),
      commits: [
        { short: "d1e4a07", message: "Add mergeStateStatus and headSha to stack entries" },
        { short: "6c2b9f1", message: "Decode mergeStateStatus from the stack GraphQL" },
      ],
    },
    { id: "701-e3", kind: "labeled", actor: "sak0a", at: d(5), label: "contracts" },
    { id: "701-e4", kind: "labeled", actor: "sak0a", at: d(5), label: "stacks" },
    { id: "701-e5", kind: "review_requested", actor: "sak0a", at: d(5), reviewer: "mvogt" },
    { id: "701-e6", kind: "review_requested", actor: "sak0a", at: d(5), reviewer: "tkessler" },
    {
      id: "701-e7",
      kind: "commits",
      actor: "sak0a",
      at: d(4),
      commits: [
        { short: "a8f03e6", message: "Stack snapshot state in client-runtime" },
        { short: "57de2c4", message: "Export the pull-request-stack subpath" },
      ],
    },
    {
      id: "701-e8",
      kind: "review",
      actor: "tkessler",
      at: d(4),
      state: "commented",
      body: "",
      threadIds: ["701-t1"],
    },
    {
      id: "701-e9",
      kind: "commits",
      actor: "sak0a",
      at: d(3),
      commits: [
        { short: "e2b6f90", message: "Allow sourceControl.getChangeRequestStack for operators" },
      ],
    },
    {
      id: "701-e10",
      kind: "comment",
      actor: "sak0a",
      at: m(3 * 1440 - 20),
      body: "Stacked on top of this: #702 → #703 → #704. Merging this one alone is safe; nothing reads the new fields until #702.",
      reactions: [],
    },
    {
      id: "701-e11",
      kind: "commits",
      actor: "sak0a",
      at: hr(5),
      commits: [{ short: "0c4d8b5", message: "Contract tests for stack entry decoding" }],
    },
    {
      id: "701-e12",
      kind: "review",
      actor: "mvogt",
      at: hr(4),
      state: "approved",
      body: "",
      threadIds: [],
    },
    {
      id: "701-e13",
      kind: "review",
      actor: "tkessler",
      at: hr(3),
      state: "approved",
      body: "LGTM. Making the decoder strict about the merge states is the right call.",
      threadIds: [],
    },
  ];

  const D701 = {
    number: 701,
    headSha: sha("0c4d8b5"),
    baseSha: sha("3f8a0c2"),
    body: BODY701,
    participants: ["sak0a", "mvogt", "tkessler"],
    reviewers: [
      { login: "mvogt", state: "approved", submittedAt: hr(4), requested: false },
      { login: "tkessler", state: "approved", submittedAt: hr(3), requested: false },
    ],
    linkedIssues: [
      { number: 655, title: "Stacked PRs: show every layer and merge through one", state: "open" },
    ],
    linkedThreads: [],
    behindBy: 0,
    commits: C701,
    files: F701,
    threads: T701,
    timeline: TL701,
    pendingReview: null,
    checks: {
      workflows: [
        workflow(701, "ci", {
          runId: 18213902277,
          runNumber: 4171,
          headSha: sha("0c4d8b5"),
          startedMin: 300,
        }),
        workflow(701, "release", {
          runId: 18213902301,
          runNumber: 604,
          headSha: sha("0c4d8b5"),
          startedMin: 300,
        }),
      ],
      statuses: [],
    },
  };

  /* ============================================================
     DETAIL #688 · others · Release dry run failing
     ============================================================ */
  const C688 = [
    ["9d7a1b3", "Add notarize script with a keychain profile check", d(2), "passing"],
    ["e4c6f02", "Run notarization in the release workflow", d(2), "passing"],
    ["1b5f8d9", "Dry-run notarization in release-dry-run", d(1), "failing"],
    ["70a3e4c", "Pass APPLE_TEAM_ID through the electron-builder config", d(1), "failing"],
    ["c9e2b57", "Document the signing secrets in docs/release.md", hr(20), "failing"],
    ["5f81a6d", "Fail fast when the notary profile is missing", m(52), "failing"],
  ].map(([short, message, committedAt, checks]) => ({
    sha: sha(short),
    short,
    message,
    author: "jonasw",
    committedAt,
    checks,
  }));

  const F688 = [
    {
      path: ".github/workflows/release-dry-run.yml",
      status: "modified",
      viewed: "unviewed",
      commits: ["1b5f8d9"],
      patch: patch(`
@@ -21 +21 @@ jobs:
   desktop-mac:
     name: Desktop · macOS arm64
     runs-on: macos-15
+    environment: release-dry-run
     steps:
       - uses: actions/checkout@v5
       - uses: oven-sh/setup-bun@v2
         with:
           bun-version-file: package.json
       - run: bun install --frozen-lockfile
       - run: bun run build:desktop
       - name: Package DMG
         run: bun run --cwd apps/desktop dist --mac dmg --arm64
+      - name: Notarize (dry run)
+        run: bun run --cwd apps/desktop notarize release/Ryco-0.9.0-arm64.dmg --dry-run
+        env:
+          APPLE_TEAM_ID: \${{ secrets.APPLE_TEAM_ID }}
+          NOTARY_PROFILE: ryco-notary
+        secrets: inherit
`),
    },
    {
      path: ".github/workflows/release.yml",
      status: "modified",
      viewed: "unviewed",
      commits: ["e4c6f02"],
      patch: patch(`
@@ -48 +48 @@ jobs:
       - name: Package DMG
         run: bun run --cwd apps/desktop dist --mac dmg --arm64
+      - name: Import signing certificate
+        uses: apple-actions/import-codesign-certs@v5
+        with:
+          p12-file-base64: \${{ secrets.MAC_CERT_P12 }}
+          p12-password: \${{ secrets.MAC_CERT_PASSWORD }}
+      - name: Store notary credentials
+        run: |
+          xcrun notarytool store-credentials ryco-notary \\
+            --apple-id "\${{ secrets.NOTARY_APPLE_ID }}" \\
+            --team-id "\${{ secrets.APPLE_TEAM_ID }}" \\
+            --password "\${{ secrets.NOTARY_PASSWORD }}"
+      - name: Notarize and staple
+        run: bun run --cwd apps/desktop notarize release/Ryco-\${{ needs.version.outputs.version }}-arm64.dmg
+        env:
+          APPLE_TEAM_ID: \${{ secrets.APPLE_TEAM_ID }}
       - name: Upload DMG
         uses: actions/upload-artifact@v4
         with:
           name: ryco-desktop-mac-arm64
           path: apps/desktop/release/*.dmg
-          retention-days: 7
+          retention-days: 14
`),
    },
    {
      path: "apps/desktop/scripts/notarize.ts",
      status: "added",
      viewed: "unviewed",
      commits: ["9d7a1b3", "5f81a6d"],
      patch: patch(`
@@ -0,0 +1 @@
+import { notarize } from "@electron/notarize";
+import { execFile } from "node:child_process";
+import { stat } from "node:fs/promises";
+import { promisify } from "node:util";
+
+const run = promisify(execFile);
+
+export interface NotarizeOptions {
+  readonly dmgPath: string;
+  readonly keychainProfile: string;
+  readonly teamId: string;
+  readonly dryRun: boolean;
+}
+
+function log(message: string) {
+  console.log("[notarize] " + message);
+}
+
+/**
+ * notarytool reads credentials from a keychain profile created with
+ * \`xcrun notarytool store-credentials\`. A missing profile fails late and
+ * cryptically inside notarize(), so check it before uploading 180 MB.
+ */
+export async function verifyProfile(profile: string): Promise<void> {
+  log('verifying keychain profile "' + profile + '"…');
+  try {
+    await run("xcrun", ["notarytool", "history", "--keychain-profile", profile]);
+  } catch (cause) {
+    const message = cause instanceof Error ? cause.message : String(cause);
+    if (!message.includes("No Keychain password item found")) throw cause;
+    throw new Error("No Keychain password item found for profile: " + profile, { cause });
+  }
+}
+
+export function readOptions(env: NodeJS.ProcessEnv, argv: ReadonlyArray<string>): NotarizeOptions {
+  const teamId = env.APPLE_TEAM_ID;
+  if (!teamId) throw new Error("APPLE_TEAM_ID is not set");
+  return {
+    dmgPath: argv.find((arg) => arg.endsWith(".dmg")) ?? "release/Ryco-arm64.dmg",
+    keychainProfile: env.NOTARY_PROFILE ?? "ryco-notary",
+    teamId,
+    dryRun: argv.includes("--dry-run"),
+  };
+}
+
+async function main() {
+  const options = readOptions(process.env, process.argv.slice(2));
+  const { size } = await stat(options.dmgPath);
+  log(options.dmgPath.split("/").at(-1) + " (" + (size / 1e6).toFixed(1) + " MB)");
+  log("team ID: from APPLE_TEAM_ID");
+  // Dry runs still verify the profile so a broken secret fails on the PR.
+  await verifyProfile(options.keychainProfile);
+  if (options.dryRun) return log("dry run: skipping upload");
+  await notarize({ appPath: options.dmgPath, keychainProfile: options.keychainProfile });
+  log("notarized and stapled");
+}
+
+if (import.meta.main) await main();
`),
    },
    {
      path: "apps/desktop/scripts/notarize.test.ts",
      status: "added",
      viewed: "unviewed",
      commits: ["9d7a1b3"],
      patch: patch(`
@@ -0,0 +1 @@
+import { describe, expect, it } from "vitest";
+
+import { readOptions } from "./notarize";
+
+describe("readOptions", () => {
+  it("requires APPLE_TEAM_ID", () => {
+    expect(() => readOptions({}, ["release/Ryco.dmg"])).toThrow("APPLE_TEAM_ID is not set");
+  });
+
+  it("defaults the keychain profile to ryco-notary", () => {
+    const options = readOptions({ APPLE_TEAM_ID: "TEAMID1234" }, ["release/Ryco.dmg"]);
+    expect(options.keychainProfile).toBe("ryco-notary");
+  });
+
+  it("treats --dry-run as a flag, not a path", () => {
+    const options = readOptions({ APPLE_TEAM_ID: "TEAMID1234" }, ["release/Ryco.dmg", "--dry-run"]);
+    expect(options).toMatchObject({ dmgPath: "release/Ryco.dmg", dryRun: true });
+  });
+});
`),
    },
    {
      path: "apps/desktop/electron-builder.config.ts",
      status: "modified",
      viewed: "viewed",
      commits: ["70a3e4c"],
      patch: patch(`
@@ -22 +22 @@ export default {
   mac: {
     category: "public.app-category.developer-tools",
     target: [{ target: "dmg", arch: ["arm64", "x64"] }],
     hardenedRuntime: true,
-    notarize: false,
+    // Notarized by scripts/notarize.ts after the DMG is built, so the dry run
+    // can verify credentials without uploading anything.
+    notarize: false,
+    identity: process.env.CSC_NAME ?? null,
     entitlements: "build/entitlements.mac.plist",
     entitlementsInherit: "build/entitlements.mac.plist",
   },
`),
    },
    {
      path: "apps/desktop/package.json",
      status: "modified",
      viewed: "viewed",
      commits: ["9d7a1b3"],
      patch: patch(`
@@ -9 +9 @@
     "build": "bun run build:main && bun run build:renderer",
     "dist": "electron-builder --config electron-builder.config.ts",
+    "notarize": "bun scripts/notarize.ts",
     "typecheck": "tsgo --noEmit"
   },
   "devDependencies": {
+    "@electron/notarize": "3.0.1",
     "electron": "38.2.1",
     "electron-builder": "26.0.12",
`),
    },
    {
      path: "bun.lock",
      status: "modified",
      viewed: "unviewed",
      generated: true,
      commits: ["9d7a1b3"],
      patch: patch(`
@@ -41 +41 @@
     "apps/desktop": {
       "name": "@ryco/desktop",
       "version": "0.9.0",
       "devDependencies": {
+        "@electron/notarize": "3.0.1",
         "electron": "38.2.1",
         "electron-builder": "26.0.12",
       },
     },
@@ -402 +403 @@
     "@electron/get": ["@electron/get@2.0.3", "", { "dependencies": { "debug": "^4.1.1", "env-paths": "^2.2.0", "fs-extra": "^8.1.0", "got": "^11.8.5", "progress": "^2.0.3", "semver": "^6.2.0", "sumchecker": "^3.0.1" } }, "sha512-Qkzpg2s9GnVV2I2BjRksUi43U5e6+zaQMcjoJy0C+C5oxaKl+fmckGDQFtRpZpZV0NQekuZZ+tGz7EA9TVnQtQ=="],

+    "@electron/notarize": ["@electron/notarize@3.0.1", "", { "dependencies": { "debug": "^4.4.0", "promise-retry": "^2.0.1" } }, "sha512-5xzcOwvMGNjkSk7s0sPx4XcKWei9FYk4f2S5NkSorWW0ce5yktTOtlPa0W5yQHcREILh+C3JdH+t+M637g9TmQ=="],
+
     "@electron/osx-sign": ["@electron/osx-sign@1.3.3", "", { "dependencies": { "compare-version": "^0.1.2", "debug": "^4.3.4", "fs-extra": "^10.0.0", "isbinaryfile": "^4.0.8", "minimist": "^1.2.6", "plist": "^3.0.5" } }, "sha512-KZ8mhXvWv2rIEgMbWZ4y33bDHyUKMXnx4M0sTyPNK/vcB81ImdeY9Ggdqy0SWbMDgmbqyQ+phgejh6V3R2QuSg=="],
`),
    },
    {
      path: "docs/release.md",
      status: "modified",
      viewed: "unviewed",
      commits: ["c9e2b57"],
      patch: patch(`
@@ -34 +34 @@ bun run release:smoke

 ## Desktop builds

-macOS DMGs are currently unsigned. Gatekeeper will ask users to confirm the first launch.
+macOS DMGs are signed with the Developer ID certificate and notarized in CI.
+
+### Secrets
+
+| Secret | Used by |
+| --- | --- |
+| \`MAC_CERT_P12\`, \`MAC_CERT_PASSWORD\` | Importing the signing certificate |
+| \`NOTARY_APPLE_ID\`, \`NOTARY_PASSWORD\` | \`notarytool store-credentials\` |
+| \`APPLE_TEAM_ID\` | Both |
+
+The dry run on pull requests verifies the keychain profile but never uploads.
+Pull requests from forks don't receive these secrets, so the step is skipped there.

 ## Mobile builds
`),
    },
  ];

  const T688 = [
    {
      id: "688-t1",
      path: ".github/workflows/release-dry-run.yml",
      side: "RIGHT",
      match: "secrets: inherit",
      isResolved: false,
      isOutdated: false,
      comments: [
        {
          id: "688-c1",
          author: "anouk-d",
          createdAt: hr(20),
          body: "Pull requests from forks and Dependabot don't get secrets, so this step can never pass for outside contributors. Gate it on `github.event.pull_request.head.repo.full_name == github.repository`? (Also, `secrets: inherit` is only valid on reusable-workflow calls, not on a step.)",
          reactions: [{ emoji: "👍", count: 1, viewerReacted: false }],
        },
        {
          id: "688-c2",
          author: "jonasw",
          createdAt: hr(19),
          body: "Fair on both. Do we still want the DMG build for forks, just without notarize? I'd keep it, since that's where most packaging regressions show up.",
          reactions: [],
        },
      ],
    },
  ];

  const LOG688_FAIL = [
    "$ bun run build:desktop",
    "  • electron-builder  version=26.0.12 os=24.6.0",
    "  • packaging       platform=darwin arch=arm64 electron=38.2.1 appOutDir=release/mac-arm64",
    "  • signing         file=release/mac-arm64/Ryco.app identity=Developer ID Application: Ryco Labs (TEAMID1234)",
    "  • building        target=DMG arch=arm64 file=release/Ryco-0.9.0-arm64.dmg",
    "$ bun run --cwd apps/desktop notarize release/Ryco-0.9.0-arm64.dmg --dry-run",
    "[notarize] Ryco-0.9.0-arm64.dmg (182.4 MB)",
    "[notarize] team ID: from APPLE_TEAM_ID",
    '[notarize] verifying keychain profile "ryco-notary"…',
    "Error: No Keychain password item found for profile: ryco-notary",
    "    at verifyProfile (apps/desktop/scripts/notarize.ts:31:11)",
    "    at async main (apps/desktop/scripts/notarize.ts:52:3)",
    'error: script "notarize" exited with code 1',
    "##[error]Process completed with exit code 1.",
  ];

  const BODY688 = `Signs and notarizes the macOS DMG in the release workflow, and makes the PR dry run verify the notary credentials, so a broken secret fails here instead of on release day.

- \`apps/desktop/scripts/notarize.ts\` wraps \`@electron/notarize\` and checks the keychain profile first.
- \`release.yml\` imports the certificate, stores notary credentials, and notarizes and staples the DMG.
- \`release-dry-run.yml\` runs the same script with \`--dry-run\`.

### Before merging

- [x] Secrets added to the \`release\` environment
- [ ] Secrets added to \`release-dry-run\` (blocked on an org admin)
- [ ] One real release from a tag

\`\`\`sh
xcrun notarytool store-credentials ryco-notary --apple-id … --team-id … --password …
\`\`\``;

  const TL688 = [
    { id: "688-e1", kind: "opened", actor: "jonasw", at: d(2) },
    {
      id: "688-e2",
      kind: "commits",
      actor: "jonasw",
      at: d(2),
      commits: [
        { short: "9d7a1b3", message: "Add notarize script with a keychain profile check" },
        { short: "e4c6f02", message: "Run notarization in the release workflow" },
      ],
    },
    { id: "688-e3", kind: "labeled", actor: "jonasw", at: d(2), label: "area:desktop" },
    { id: "688-e4", kind: "labeled", actor: "jonasw", at: d(2), label: "release" },
    { id: "688-e5", kind: "review_requested", actor: "jonasw", at: d(2), reviewer: "anouk-d" },
    { id: "688-e6", kind: "review_requested", actor: "jonasw", at: d(2), reviewer: "tkessler" },
    {
      id: "688-e7",
      kind: "commits",
      actor: "jonasw",
      at: d(1),
      commits: [
        { short: "1b5f8d9", message: "Dry-run notarization in release-dry-run" },
        { short: "70a3e4c", message: "Pass APPLE_TEAM_ID through the electron-builder config" },
      ],
    },
    {
      id: "688-e8",
      kind: "review",
      actor: "anouk-d",
      at: hr(20),
      state: "commented",
      body: "Happy with the script. The dry-run wiring needs another look (inline).",
      threadIds: ["688-t1"],
    },
    {
      id: "688-e9",
      kind: "commits",
      actor: "jonasw",
      at: hr(20),
      commits: [{ short: "c9e2b57", message: "Document the signing secrets in docs/release.md" }],
    },
    {
      id: "688-e10",
      kind: "commits",
      actor: "jonasw",
      at: m(52),
      commits: [{ short: "5f81a6d", message: "Fail fast when the notary profile is missing" }],
    },
    {
      id: "688-e11",
      kind: "comment",
      actor: "github-actions[bot]",
      at: m(44),
      body: "**Release dry run** failed on `Desktop · macOS arm64` → *Notarize (dry run)*\n\n```\nError: No Keychain password item found for profile: ryco-notary\n    at verifyProfile (apps/desktop/scripts/notarize.ts:31:11)\n```\n\n[View the job log](https://github.com/ryco-labs/ryco/actions/runs/18214410556)",
      reactions: [{ emoji: "😕", count: 1, viewerReacted: false }],
    },
  ];

  const D688 = {
    number: 688,
    headSha: sha("5f81a6d"),
    baseSha: sha("3f8a0c2"),
    body: BODY688,
    participants: ["jonasw", "anouk-d", "github-actions[bot]"],
    reviewers: [
      { login: "anouk-d", state: "commented", submittedAt: hr(20), requested: false },
      { login: "tkessler", state: "pending", submittedAt: null, requested: true },
    ],
    linkedIssues: [
      { number: 602, title: "Gatekeeper warning on first launch of the DMG", state: "open" },
    ],
    linkedThreads: [],
    behindBy: 2,
    commits: C688,
    files: F688,
    threads: T688,
    timeline: TL688,
    pendingReview: null,
    checks: {
      workflows: [
        workflow(688, "ci", {
          runId: 18214410533,
          runNumber: 4180,
          headSha: sha("5f81a6d"),
          startedMin: 52,
        }),
        workflow(688, "release", {
          runId: 18214410556,
          runNumber: 610,
          headSha: sha("5f81a6d"),
          startedMin: 52,
          withSmoke: true,
          outcomes: { "desktop-mac": "failure", smoke: "skipped" },
          failStep: { "desktop-mac": "Notarize (dry run)" },
          logs: { "desktop-mac": LOG688_FAIL },
        }),
      ],
      statuses: [],
    },
  };

  /* ============================================================
     DETAIL #702 · stack layer 2 · checks running (medium detail)
     ============================================================ */
  const C702 = [
    ["b3e9d14", "Page stack entries 50 at a time", d(5), "passing"],
    ["f60a2c8", "Strict consistency checks across stack pages", d(4), "passing"],
    ["29c7e5a", "Batch stack summaries for list rows, 40 per query", d(3), "passing"],
    ["8d4f1b6", "Mark stack metadata incomplete instead of failing the detail", hr(26), "passing"],
    ["c71e0a9", "Retry stack reads once on secondary rate limits", m(25), "running"],
  ].map(([short, message, committedAt, checks]) => ({
    sha: sha(short),
    short,
    message,
    author: "sak0a",
    committedAt,
    checks,
  }));

  const F702 = [
    {
      path: "apps/server/src/sourceControl/gitHubPullRequestStacks.ts",
      status: "modified",
      viewed: "unviewed",
      commits: ["b3e9d14", "f60a2c8", "8d4f1b6"],
      patch: patch(`
@@ -980 +980 @@ export const getPullRequestStack = Effect.fn("getPullRequestStack")(function* (
   const pages: Array<typeof RawStackPageSchema.Type> = [];
   let after: string | null = null;
-  const page = yield* cli.graphql(GITHUB_PULL_REQUEST_STACK_QUERY, { owner, name, number });
-  pages.push(yield* decodeStackPage(page));
+  for (let guard = 0; guard < MAX_STACK_PAGES; guard++) {
+    const page = yield* cli.graphql(GITHUB_PULL_REQUEST_STACK_QUERY, {
+      owner,
+      name,
+      number,
+      first: GITHUB_STACK_PAGE_SIZE,
+      after,
+    });
+    const decoded = yield* decodeStackPage(page);
+    pages.push(decoded);
+    const { hasNextPage, endCursor } = decoded.stack.entries.pageInfo;
+    if (!hasNextPage) break;
+    // A cursor that does not move would loop forever; GitHub has done it twice.
+    if (endCursor === after) {
+      return yield* new StackPagingError({ number, reason: "cursor did not advance" });
+    }
+    after = endCursor;
+  }
   return normalizeGitHubPullRequestStackPages(pages, number);
 });
`),
    },
    {
      path: "apps/server/src/sourceControl/GitHubCli.ts",
      status: "modified",
      viewed: "unviewed",
      commits: ["c71e0a9"],
      patch: patch(`
@@ -1000 +1000 @@ export class GitHubCli extends Effect.Service<GitHubCli>()("GitHubCli", {
     graphql: (query: string, variables: Record<string, unknown>) =>
       executeGraphql(query, variables).pipe(
+        // Secondary rate limits come back as 403 with a Retry-After; one retry
+        // after that delay is enough for a stack read, more just piles up.
+        Effect.retry({
+          times: 1,
+          while: isSecondaryRateLimit,
+          schedule: Schedule.spaced(Duration.seconds(2)),
+        }),
         Effect.mapError(normalizeGitHubCliError),
       ),
`),
    },
    {
      path: "apps/server/src/sourceControl/gitHubPullRequestStacks.test.ts",
      status: "modified",
      viewed: "unviewed",
      commits: ["f60a2c8"],
      patch: patch(`
@@ -102 +102 @@ describe("getPullRequestStack", () => {
+  it.effect("follows cursors until the last page", () =>
+    Effect.gen(function* () {
+      const cli = fakeGraphql([page([1, 2], "c1"), page([3, 4], "c2"), page([5], null)]);
+      const stack = yield* getPullRequestStack({ number: 703 }).pipe(provideCli(cli));
+      expect(stack.entries.map((entry) => entry.position)).toEqual([1, 2, 3, 4, 5]);
+      expect(cli.calls.map((call) => call.after)).toEqual([null, "c1", "c2"]);
+    }),
+  );
+
+  it.effect("fails instead of looping when the cursor does not advance", () =>
+    Effect.gen(function* () {
+      const cli = fakeGraphql([page([1, 2], "c1"), page([3, 4], "c1")]);
+      const error = yield* getPullRequestStack({ number: 703 }).pipe(provideCli(cli), Effect.flip);
+      expect(error).toBeInstanceOf(StackPagingError);
+    }),
+  );
+
 });
`),
    },
    {
      path: "apps/server/src/ws/sourceControlRpc.ts",
      status: "modified",
      viewed: "viewed",
      commits: ["8d4f1b6"],
      patch: patch(`
@@ -212 +212 @@ export const makeSourceControlHandlers = Effect.gen(function* () {
       sourceControlRegistry.resolve({ cwd: input.cwd }).pipe(
         Effect.flatMap((provider) => provider.getChangeRequestDetail(input)),
+        // A stack read that fails must not take the whole detail down with it.
+        Effect.catchTag("StackPagingError", () =>
+          Effect.succeed({ ...detail, stack: null, stackMetadataIncomplete: true }),
+        ),
         Effect.tap(refreshStateForLinkedReference),
       ),
`),
    },
  ];

  const D702 = {
    number: 702,
    headSha: sha("c71e0a9"),
    baseSha: sha("0c4d8b5"),
    body: "Second layer of the stacked-PR work. Reads GitHub-native stacks with cursor paging (50 entries per page), batches list-row summaries 40 at a time, and degrades to `stackMetadataIncomplete` instead of failing the detail when a stack read breaks.\n\nStacked on #701.\n\n- [x] Paging with a cursor-advance guard\n- [x] Batched summaries for list rows\n- [ ] Retry on secondary rate limits (running in CI now)",
    participants: ["sak0a", "tkessler", "eliotm"],
    reviewers: [
      { login: "tkessler", state: "pending", submittedAt: null, requested: true },
      { login: "eliotm", state: "commented", submittedAt: hr(26), requested: false },
    ],
    linkedIssues: [
      { number: 655, title: "Stacked PRs: show every layer and merge through one", state: "open" },
    ],
    linkedThreads: [],
    behindBy: 0,
    commits: C702,
    files: F702,
    threads: [
      {
        id: "702-t1",
        path: "apps/server/src/sourceControl/gitHubPullRequestStacks.ts",
        side: "RIGHT",
        match: "if (endCursor === after)",
        isResolved: true,
        resolvedBy: "sak0a",
        isOutdated: false,
        comments: [
          {
            id: "702-c1",
            author: "eliotm",
            createdAt: hr(26),
            body: "Has this actually happened, or is it defensive?",
            reactions: [],
          },
          {
            id: "702-c2",
            author: "sak0a",
            createdAt: hr(25),
            body: "Twice on the sandbox repo while a layer was being retargeted. The comment says so now.",
            reactions: [],
          },
        ],
      },
    ],
    timeline: [
      { id: "702-e1", kind: "opened", actor: "sak0a", at: d(5) },
      { id: "702-e2", kind: "labeled", actor: "sak0a", at: d(5), label: "area:server" },
      { id: "702-e3", kind: "labeled", actor: "sak0a", at: d(5), label: "stacks" },
      {
        id: "702-e4",
        kind: "commits",
        actor: "sak0a",
        at: d(5),
        commits: [{ short: "b3e9d14", message: "Page stack entries 50 at a time" }],
      },
      { id: "702-e5", kind: "review_requested", actor: "sak0a", at: d(5), reviewer: "tkessler" },
      { id: "702-e6", kind: "review_requested", actor: "sak0a", at: d(5), reviewer: "eliotm" },
      {
        id: "702-e7",
        kind: "commits",
        actor: "sak0a",
        at: d(3),
        commits: [
          { short: "f60a2c8", message: "Strict consistency checks across stack pages" },
          { short: "29c7e5a", message: "Batch stack summaries for list rows, 40 per query" },
        ],
      },
      {
        id: "702-e8",
        kind: "base_changed",
        actor: "sak0a",
        at: d(3),
        from: "main",
        to: "ryco/stack-1-contracts",
      },
      {
        id: "702-e9",
        kind: "review",
        actor: "eliotm",
        at: hr(26),
        state: "commented",
        body: "Read through the paging and it looks right. One question inline.",
        threadIds: ["702-t1"],
      },
      {
        id: "702-e10",
        kind: "commits",
        actor: "sak0a",
        at: m(25),
        commits: [
          {
            short: "8d4f1b6",
            message: "Mark stack metadata incomplete instead of failing the detail",
          },
          { short: "c71e0a9", message: "Retry stack reads once on secondary rate limits" },
        ],
      },
    ],
    pendingReview: null,
    checks: {
      workflows: [
        workflow(702, "ci", {
          runId: 18214420017,
          runNumber: 4181,
          headSha: sha("c71e0a9"),
          startedMin: 4,
          outcomes: { "test-web": "running", browser: "queued", build: "running" },
        }),
        workflow(702, "release", {
          runId: 18214420040,
          runNumber: 612,
          headSha: sha("c71e0a9"),
          startedMin: 4,
          outcomes: { "desktop-mac": "running" },
        }),
      ],
      statuses: [],
    },
  };

  /* ============================================================
     DETAIL #704 · stack top · draft, no checks (medium detail)
     ============================================================ */
  const C704 = [
    ["e1a7c30", "J/K move between stack layers", d(2), "none"],
    ["4b9f2d7", "S toggles the stack rail", d(1), "none"],
    ["92c5e81", "Ignore layer shortcuts while focus is inside the diff", hr(1), "none"],
  ].map(([short, message, committedAt, checks]) => ({
    sha: sha(short),
    short,
    message,
    author: "sak0a",
    committedAt,
    checks,
  }));

  const F704 = [
    {
      path: "apps/web/src/components/pullRequests/PullRequestStackRail.tsx",
      status: "modified",
      viewed: "unviewed",
      commits: ["e1a7c30", "92c5e81"],
      patch: patch(`
@@ -27 +27 @@ export const PullRequestStackRail = memo(function PullRequestStackRail({
 }: PullRequestStackRailProps) {
   const listRef = useRef<HTMLOListElement>(null);
   const layers = stackLayers(stack).toReversed();
+  const navigate = useNavigate();
+  const step = useCallback(
+    (delta: 1 | -1) => {
+      const index = layers.findIndex(({ entry }) => entry.number === current);
+      const next = layers[index + delta];
+      if (next) navigate({ to: "/pull-requests/$number", params: { number: String(next.entry.number) } });
+    },
+    [layers, current, navigate],
+  );
+  // J/K walk the stack, but never while you're typing or reading inside a file.
+  useHotkeys("j", () => step(-1), { enabled: (event) => !isInsideDiff(event.target) });
+  useHotkeys("k", () => step(1), { enabled: (event) => !isInsideDiff(event.target) });
   const onKeyDown = useCallback((event: KeyboardEvent<HTMLOListElement>) => {
`),
    },
    {
      path: "apps/web/src/keybindings.ts",
      status: "modified",
      viewed: "unviewed",
      commits: ["4b9f2d7"],
      patch: patch(`
@@ -88 +88 @@ export const DEFAULT_KEYBINDINGS: ReadonlyArray<KeybindingDefinition> = [
   { command: "pullRequests.nextFile", key: "n", when: "pullRequestFilesFocus" },
   { command: "pullRequests.previousFile", key: "p", when: "pullRequestFilesFocus" },
+  { command: "pullRequests.toggleStackRail", key: "s", when: "pullRequestFocus && !inputFocus" },
+  { command: "pullRequests.stackLayerBelow", key: "j", when: "pullRequestFocus && !diffFocus" },
+  { command: "pullRequests.stackLayerAbove", key: "k", when: "pullRequestFocus && !diffFocus" },
 ];
`),
    },
    {
      path: "apps/web/src/components/pullRequests/PullRequestStackRail.browser.tsx",
      status: "modified",
      viewed: "unviewed",
      commits: ["92c5e81"],
      patch: patch(`
@@ -32 +32 @@ describe("PullRequestStackRail", () => {
     await expect.element(page.getByLabelText("Layer 2 of 4", { exact: false })).toHaveFocus();
   });
+
+  it("ignores J/K while focus is inside the diff", async () => {
+    const { router } = await renderWithRouter(
+      <>
+        <PullRequestStackRail stack={stackFixture} current={703} onMergeThrough={vi.fn()} />
+        <div data-diff-file-path="a.ts" tabIndex={0}>diff</div>
+      </>,
+    );
+    await userEvent.click(page.getByText("diff"));
+    await userEvent.keyboard("j");
+    expect(router.state.location.pathname).toBe("/pull-requests/703");
+  });
 });
`),
    },
  ];

  const D704 = {
    number: 704,
    headSha: sha("92c5e81"),
    baseSha: sha("8e5d1c6"),
    body: "Top layer. Keyboard support for stacks:\n\n- `J` / `K` move to the layer below / above\n- `S` toggles the stack rail\n- neither fires while focus is inside the diff (from @mvogt's review on #703)\n\n- [x] Shortcuts\n- [ ] Show them in the shortcuts sheet\n- [ ] Head-SHA guard before merge-through (`expectedHeads`)",
    participants: ["sak0a"],
    reviewers: [],
    linkedIssues: [],
    linkedThreads: [],
    behindBy: 0,
    commits: C704,
    files: F704,
    threads: [],
    timeline: [
      { id: "704-e1", kind: "opened", actor: "sak0a", at: d(2), isDraft: true },
      { id: "704-e2", kind: "labeled", actor: "sak0a", at: d(2), label: "area:web" },
      { id: "704-e3", kind: "labeled", actor: "sak0a", at: d(2), label: "stacks" },
      {
        id: "704-e4",
        kind: "commits",
        actor: "sak0a",
        at: d(2),
        commits: [{ short: "e1a7c30", message: "J/K move between stack layers" }],
      },
      {
        id: "704-e5",
        kind: "commits",
        actor: "sak0a",
        at: d(1),
        commits: [{ short: "4b9f2d7", message: "S toggles the stack rail" }],
      },
      {
        id: "704-e6",
        kind: "commits",
        actor: "sak0a",
        at: hr(1),
        commits: [
          { short: "92c5e81", message: "Ignore layer shortcuts while focus is inside the diff" },
        ],
      },
    ],
    pendingReview: null,
    checks: {
      workflows: [],
      statuses: [],
      note: "CI runs when the pull request is marked ready for review.",
    },
  };

  /* ============================================================
     App sidebar threads (the Ryco inbox, A · Glyph rows)
     ============================================================ */
  const sidebar = {
    project: { name: "ryco", repo: "ryco-labs/ryco" },
    threads: [
      {
        id: "th1",
        title: "Fix the draft walk in planStackMerge",
        state: "working",
        branch: "ryco/stack-3-web-rail",
        pr: 703,
        provider: "claude",
        at: m(6),
      },
      {
        id: "th2",
        title: "Bump effect to 3.19",
        state: "input",
        ask: "bun install --frozen-lockfile",
        branch: "renovate/effect-monorepo",
        pr: 711,
        provider: "codex",
        at: m(14),
      },
      {
        id: "th3",
        title: "Prototype virtualized diff rows",
        state: "done",
        unread: true,
        branch: "ryco/diff-rows-proto",
        diff: { add: 212, del: 58, files: 6 },
        provider: "codex",
        at: hr(2),
      },
      {
        id: "th4",
        title: "Write release notes for 0.9",
        state: "idle",
        branch: "main",
        provider: "claude",
        at: d(1),
      },
      {
        id: "th5",
        title: "Tune mobile file viewer scroll",
        state: "idle",
        branch: "ryco/mobile-file-scroll",
        pr: 610,
        provider: "opencode",
        at: d(3),
      },
    ],
  };

  /* ============================================================
     Post-processing: anchors, stats, summaries ← details, stacks
     ============================================================ */
  const details = { 703: D703, 712: D712, 701: D701, 688: D688, 702: D702, 704: D704 };

  /** Rows of a patch with old/new line numbers (same rules as core.js). */
  function patchRows(text) {
    const rows = [];
    let o = 0;
    let n = 0;
    let hunk = null;
    for (const line of text.split("\n")) {
      if (line.startsWith("@@")) {
        const mm = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)/);
        o = +mm[1];
        n = +mm[2];
        hunk = line;
        rows.push({ kind: "hunk", text: line });
      } else if (line[0] === "+")
        rows.push({ kind: "add", text: line.slice(1), old: null, new: n++, hunk });
      else if (line[0] === "-")
        rows.push({ kind: "del", text: line.slice(1), old: o++, new: null, hunk });
      else if (line[0] === "\\") rows.push({ kind: "meta", text: line });
      else rows.push({ kind: "ctx", text: line.slice(1), old: o++, new: n++, hunk });
    }
    return rows;
  }
  const sign = { add: "+", del: "-", ctx: " " };
  function anchor(detail, item) {
    if (!item.match || item.line != null) return;
    const file = detail.files.find((f) => f.path === item.path);
    if (!file) return console.warn("[pr-lab data] no file for anchor", item.id, item.path);
    const rows = patchRows(file.patch);
    const right = item.side !== "LEFT";
    const idx = rows.findIndex(
      (r) =>
        (right ? r.kind === "add" || r.kind === "ctx" : r.kind === "del" || r.kind === "ctx") &&
        r.text.includes(item.match),
    );
    if (idx < 0) return console.warn("[pr-lab data] anchor not found", item.id, item.match);
    const row = rows[idx];
    item.line = right ? row.new : row.old;
    item.originalLine = item.line;
    item.startLine = null;
    item.lineText = row.text;
    const from = Math.max(
      rows.lastIndexOf(
        rows
          .slice(0, idx)
          .reverse()
          .find((r) => r.kind === "hunk"),
      ),
      idx - 3,
    );
    const excerpt = rows.slice(from, idx + 1).filter((r) => r.kind !== "hunk" && r.kind !== "meta");
    const first = excerpt[0];
    item.diffHunk = [
      `@@ -${first.old ?? row.old ?? 0},${excerpt.filter((r) => r.kind !== "add").length} +${first.new ?? row.new ?? 0},${excerpt.filter((r) => r.kind !== "del").length} @@`,
      ...excerpt.map((r) => sign[r.kind] + r.text),
    ].join("\n");
  }

  function summarizeChecks(c) {
    const out = { state: "none", total: 0, passed: 0, failed: 0, running: 0, skipped: 0 };
    const add = (status, conclusion) => {
      out.total++;
      if (status !== "completed") out.running++;
      else if (conclusion === "success" || conclusion === "neutral") out.passed++;
      else if (conclusion === "skipped" || conclusion === "cancelled") out.skipped++;
      else out.failed++;
    };
    for (const w of c.workflows) for (const j of w.jobs) add(j.status, j.conclusion);
    for (const s of c.statuses)
      add(
        s.state === "pending" ? "in_progress" : "completed",
        s.state === "success" ? "success" : "failure",
      );
    out.state = out.failed ? "failing" : out.running ? "running" : out.total ? "passing" : "none";
    return out;
  }

  for (const [num, detail] of Object.entries(details)) {
    for (const f of detail.files) {
      const rows = patchRows(f.patch);
      f.additions = rows.filter((r) => r.kind === "add").length;
      f.deletions = rows.filter((r) => r.kind === "del").length;
    }
    for (const t of detail.threads) anchor(detail, t);
    for (const c of detail.pendingReview?.comments || []) anchor(detail, c);
    const pr = pullRequests.find((p) => p.number === +num);
    if (!pr) continue;
    pr.checks = summarizeChecks(detail.checks);
    pr.unresolvedThreads = detail.threads.filter((t) => !t.isResolved).length;
    pr.changedFiles = detail.files.length;
    pr.additions = detail.files.reduce((s, f) => s + f.additions, 0);
    pr.deletions = detail.files.reduce((s, f) => s + f.deletions, 0);
    pr.commitsCount = detail.commits.length;
    pr.headSha = detail.headSha;
    pr.hasDetail = true;
  }
  for (const pr of pullRequests) {
    pr.url = `${repo.url}/pull/${pr.number}`;
    pr.headSha = pr.headSha || sha(hex40("pr" + pr.number).slice(0, 7));
    pr.hasDetail = !!pr.hasDetail;
    pr.unread = !!pr.unread;
    pr.autoMerge = pr.autoMerge || null;
    pr.stack = null;
    pr.behindBy = pr.behindBy ?? details[pr.number]?.behindBy ?? 0;
  }
  for (const s of stacks) {
    s.size = s.entries.length;
    s.entries.forEach((n, i) => {
      const pr = pullRequests.find((p) => p.number === n);
      pr.stack = {
        id: s.id,
        number: s.number,
        position: i + 1,
        size: s.entries.length,
        baseRefName: s.baseRefName,
      };
    });
  }

  window.PR_LAB_DATA = {
    now: iso(NOW),
    repo,
    viewer: users.sak0a,
    users,
    teams,
    labels,
    pullRequests,
    stacks,
    details,
    sidebar,
  };
})();
