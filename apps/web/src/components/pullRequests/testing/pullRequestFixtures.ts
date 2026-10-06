/**
 * Contract-typed fixtures for the pull requests page, mirroring the PR lab
 * (`.docs/pr-lab/data.js`): one repository (ryco-labs/ryco), one viewer
 * (sak0a), 22 pull requests across "needs your review" / "yours" / "others",
 * the GitHub-native stack #701 → #704 and a second stack #715 → #716.
 *
 * Full detail (body, commits, files, diff, reviewers, stack, checks, timeline,
 * review threads, workflow runs/jobs/logs) exists for #703, #701, #702, #704,
 * #712 and #688. Every other row gets a synthesized, still-valid detail and
 * activity so selecting any row renders.
 *
 * Review threads anchor to real lines of `fixtureDiff()` (computed from the
 * patches, never hand-numbered), and the failing "Test · web" job log of #703
 * names `apps/web/src/components/pullRequests/stackLayers.logic.test.ts:40`,
 * a line in that diff.
 *
 * Times are relative to `FIXTURE_NOW_MS` (2026-10-03T08:24:00Z). Pin the clock
 * with `vi.setSystemTime(FIXTURE_NOW_MS)` for stable relative times in
 * screenshots.
 *
 * Test data only — never import this from app code.
 */
import {
  EnvironmentId,
  ProjectId,
  type ChangeRequest,
  type ChangeRequestActivity,
  type ChangeRequestActor,
  type ChangeRequestDiffSide,
  type ChangeRequestReviewComment,
  type ChangeRequestReviewThread,
  type ChangeRequestState,
  type ChangeRequestTimelineItem,
  type ChangeRequestViewerCapabilities,
  type SourceControlAssigneeCandidate,
  type SourceControlChangeRequestAutoMerge,
  type SourceControlChangeRequestCommit,
  type SourceControlChangeRequestDetail,
  type SourceControlChangeRequestFilesViewed,
  type SourceControlChangeRequestMergeability,
  type SourceControlChangeRequestMergeStateStatus,
  type SourceControlChangeRequestReviewDecision,
  type SourceControlChangeRequestReviewer,
  type SourceControlChangeRequestReviewerState,
  type SourceControlChangeRequestStack,
  type SourceControlCheckRollupItem,
  type SourceControlCommentReaction,
  type SourceControlCommentReactionContent,
  type SourceControlIssueComment,
  type SourceControlLabel,
  type SourceControlProviderInfo,
  type SourceControlWorkflowJob,
  type SourceControlWorkflowJobLogResult,
  type SourceControlWorkflowRun,
  type SourceControlWorkflowRunJobsResult,
  type SourceControlWorkflowRunListResult,
  type SourceControlWorkflowStep,
} from "@ryco/contracts";
import { DateTime, Option } from "effect";

import { projectCheckoutKey, type ProjectCheckoutOption } from "../../../projectCheckouts.logic";
import { FIXTURE_PATCHES, type FixturePatchFile } from "./pullRequestFixturePatches";

// ── Clock ─────────────────────────────────────────────────────────────

export const FIXTURE_NOW_ISO = "2026-10-03T08:24:00.000Z";
export const FIXTURE_NOW_MS = Date.parse(FIXTURE_NOW_ISO);

function minutesAgo(minutes: number): DateTime.Utc {
  return DateTime.makeUnsafe(FIXTURE_NOW_MS - Math.round(minutes * 60_000));
}
const m = minutesAgo;
const hr = (hours: number) => minutesAgo(hours * 60);
const d = (days: number) => minutesAgo(days * 1440);

function plusSeconds(time: DateTime.Utc, seconds: number): DateTime.Utc {
  return DateTime.makeUnsafe(DateTime.toEpochMillis(time) + seconds * 1000);
}

function isoString(time: DateTime.Utc): string {
  return new Date(DateTime.toEpochMillis(time)).toISOString();
}

// ── SHAs (same derivation as the lab, so short SHAs match) ─────────────

function hex40(seed: string): string {
  let out = "";
  let hash = 0x811c9dc5;
  for (let round = 0; out.length < 40; round += 1) {
    for (const character of `${seed}:${round}`) {
      hash ^= character.charCodeAt(0);
      hash = Math.imul(hash, 16777619) >>> 0;
    }
    out += hash.toString(16).padStart(8, "0");
  }
  return out.slice(0, 40);
}

/** Full 40-char SHA that starts with the given 7-char short SHA. */
export function fixtureSha(short: string): string {
  return (short + hex40(short)).slice(0, 40);
}

// ── Repository, viewer, people, labels ────────────────────────────────

export const FIXTURE_REPOSITORY = "ryco-labs/ryco";
export const FIXTURE_REPOSITORY_URL = "https://github.com/ryco-labs/ryco";
export const FIXTURE_VIEWER_LOGIN = "sak0a";
export const FIXTURE_ENVIRONMENT_ID = EnvironmentId.make("env-fixture-local");
export const FIXTURE_PROJECT_ID = ProjectId.make("project-fixture-ryco");
export const FIXTURE_CWD = "/Users/sak0a/code/ryco";

export const fixtureProvider: SourceControlProviderInfo = {
  kind: "github",
  name: "GitHub",
  baseUrl: "https://github.com",
};

export const fixtureRepositoryOption: ProjectCheckoutOption = {
  key: projectCheckoutKey(FIXTURE_ENVIRONMENT_ID, FIXTURE_PROJECT_ID),
  environmentId: FIXTURE_ENVIRONMENT_ID,
  projectId: FIXTURE_PROJECT_ID,
  cwd: FIXTURE_CWD,
  name: "ryco",
  environmentLabel: null,
  customAvatarContentHash: null,
  repositoryKey: "github.com/ryco-labs/ryco",
  isRepresentative: true,
};

interface FixturePerson {
  readonly login: string;
  readonly name: string;
  readonly bot?: boolean;
}

export const FIXTURE_PEOPLE: Readonly<Record<string, FixturePerson>> = {
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

export function fixtureActor(login: string): ChangeRequestActor {
  return FIXTURE_PEOPLE[login]?.bot ? { login, isBot: true } : { login };
}

function authorAssociation(login: string): string {
  return FIXTURE_PEOPLE[login]?.bot ? "NONE" : "MEMBER";
}

export const fixtureAssigneeCandidates: ReadonlyArray<SourceControlAssigneeCandidate> =
  Object.values(FIXTURE_PEOPLE)
    .filter((person) => !person.bot)
    .map((person) => ({ login: person.login, displayName: person.name }));

/** GitHub hex colours as the API returns them (no leading `#`). */
export const FIXTURE_LABELS = {
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
} as const satisfies Record<string, SourceControlLabel>;
export type FixtureLabelName = keyof typeof FIXTURE_LABELS;

/** Every repository label (what `useSourceControlIssueLabels` serves). */
export const fixtureLabelList: ReadonlyArray<SourceControlLabel> = Object.values(FIXTURE_LABELS);

function label(name: FixtureLabelName): SourceControlLabel {
  return FIXTURE_LABELS[name];
}

// ── Checks: workflow runs, jobs, logs ─────────────────────────────────

type JobKey =
  | "lint"
  | "typecheck"
  | "test-web"
  | "test-server"
  | "browser"
  | "build"
  | "desktop-mac"
  | "cli"
  | "smoke";
type JobOutcome = "success" | "failure" | "running" | "queued" | "skipped";
type WorkflowKind = "ci" | "release" | "docs";

const JOB_KEYS: ReadonlyArray<JobKey> = [
  "lint",
  "typecheck",
  "test-web",
  "test-server",
  "browser",
  "build",
  "desktop-mac",
  "cli",
  "smoke",
];

const PRE_STEPS = ["Set up job", "Checkout", "Setup Bun 1.3.2", "bun install --frozen-lockfile"];
const POST_STEPS = ["Post Setup Bun", "Complete job"];

const JOB_DEFS: Record<JobKey, { name: string; steps: ReadonlyArray<string>; seconds: number }> = {
  lint: { name: "Format & lint", steps: ["bun run fmt:check", "bun lint"], seconds: 48 },
  typecheck: { name: "Typecheck", steps: ["bun typecheck"], seconds: 131 },
  "test-web": { name: "Test · web", steps: ["bun run test --filter=@ryco/web"], seconds: 182 },
  "test-server": {
    name: "Test · server",
    steps: ["bun run test --filter=ryco-cli"],
    seconds: 160,
  },
  browser: {
    name: "Browser · web",
    steps: ["Install Playwright Chromium", "bun run --cwd apps/web test:browser"],
    seconds: 258,
  },
  build: { name: "Build", steps: ["bun run build"], seconds: 175 },
  "desktop-mac": {
    name: "Desktop · macOS arm64",
    steps: ["bun run build:desktop", "Package DMG", "Notarize (dry run)"],
    seconds: 462,
  },
  cli: {
    name: "CLI bundle",
    steps: ["bun run --filter ryco-cli build:bundle", "Smoke test dist/bin.mjs"],
    seconds: 96,
  },
  smoke: { name: "Release smoke", steps: ["bun run release:smoke"], seconds: 71 },
};

const WORKFLOW_DEFS: Record<WorkflowKind, { name: string; jobs: ReadonlyArray<JobKey> }> = {
  ci: { name: "CI", jobs: ["lint", "typecheck", "test-web", "test-server", "browser", "build"] },
  release: { name: "Release dry run", jobs: ["desktop-mac", "cli"] },
  docs: { name: "CI", jobs: ["lint", "typecheck", "build"] },
};

const OK_LOGS: Record<JobKey, ReadonlyArray<string>> = {
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

/** The failing "Test · web" log of #703; line 40 of the test file is in the diff. */
const LOG_703_TEST_WEB_FAILURE: ReadonlyArray<string> = [
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
  "::error file=/home/runner/work/ryco/ryco/apps/web/src/components/pullRequests/stackLayers.logic.test.ts,title=src/components/pullRequests/stackLayers.logic.test.ts > planStackMerge > refuses to merge through a draft layer below the target,line=40,column=43::AssertionError: expected undefined to be 2 // Object.is equality",
  "",
  " Test Files  1 failed | 211 passed (212)",
  "      Tests  1 failed | 1845 passed (1846)",
  "   Duration  57.94s",
  "",
  'error: script "test" exited with code 1',
  "##[error]Process completed with exit code 1.",
];

const LOG_688_DESKTOP_FAILURE: ReadonlyArray<string> = [
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

interface WorkflowPlan {
  readonly kind: WorkflowKind;
  readonly runId: number;
  readonly runNumber: number;
  readonly headShort: string;
  readonly headline: string;
  readonly startedMinutesAgo: number;
  readonly outcomes?: Partial<Record<JobKey, JobOutcome>>;
  readonly failStep?: Partial<Record<JobKey, string>>;
  readonly logs?: Partial<Record<JobKey, ReadonlyArray<string>>>;
  readonly withSmoke?: boolean;
}

interface StatusPlan {
  readonly name: string;
  readonly state: "success" | "pending" | "failure";
  readonly description: string;
  readonly url: string;
}

interface ChecksPlan {
  /** Runs on the current head; these feed the check rollup. */
  readonly workflows: ReadonlyArray<WorkflowPlan>;
  readonly statuses: ReadonlyArray<StatusPlan>;
  /** Older runs (previous heads) the runs list still reports. */
  readonly history?: ReadonlyArray<WorkflowPlan>;
}

interface BuiltJob {
  readonly job: SourceControlWorkflowJob;
  readonly key: JobKey;
  readonly log: string;
}

interface BuiltRun {
  readonly run: SourceControlWorkflowRun;
  readonly jobs: ReadonlyArray<BuiltJob>;
}

function jobId(runId: number, key: JobKey): string {
  return String(runId * 10 + JOB_KEYS.indexOf(key));
}

function rawLog(started: DateTime.Utc, stepCommand: string, lines: ReadonlyArray<string>): string {
  let tick = DateTime.toEpochMillis(started);
  const stamp = (line: string) => {
    tick += 137;
    return `${new Date(tick).toISOString().replace("Z", "0000Z")} ${line}`;
  };
  return [
    "##[group]Runner Image",
    "Image: ubuntu-24.04",
    "Version: 20260928.1",
    "##[endgroup]",
    "##[group]Run actions/checkout@v5",
    "Syncing repository: ryco-labs/ryco",
    "##[endgroup]",
    "##[group]Run oven-sh/setup-bun@v2",
    "Using a cached version of Bun: 1.3.2",
    "##[endgroup]",
    "##[group]Run bun install --frozen-lockfile",
    "bun install v1.3.2 (b2a0e1f4)",
    "Checked 1384 installs across 1502 packages (no changes) [1.21s]",
    "##[endgroup]",
    `##[group]Run ${stepCommand}`,
    stepCommand,
    "shell: /usr/bin/bash -e {0}",
    "##[endgroup]",
    ...lines,
  ]
    .map(stamp)
    .join("\n");
}

function buildRun(plan: WorkflowPlan, pr: FixtureRowSpec): BuiltRun {
  const definition = WORKFLOW_DEFS[plan.kind];
  const keys: ReadonlyArray<JobKey> =
    plan.kind === "release" && plan.withSmoke ? [...definition.jobs, "smoke"] : definition.jobs;
  const startedAt = m(plan.startedMinutesAgo);
  const runUrl = `${FIXTURE_REPOSITORY_URL}/actions/runs/${plan.runId}`;
  const jobs = keys.map((key): BuiltJob => {
    const def = JOB_DEFS[key];
    const outcome = plan.outcomes?.[key] ?? "success";
    const names = [...PRE_STEPS, ...def.steps, ...POST_STEPS];
    const failStep = plan.failStep?.[key] ?? def.steps[def.steps.length - 1];
    const runningIndex = PRE_STEPS.length + Math.max(0, def.steps.length - 1);
    const perStep = Math.max(2, Math.round(def.seconds / names.length));
    let failed = false;
    const steps = names.map((name, index): SourceControlWorkflowStep => {
      const stepStart = plusSeconds(startedAt, index * perStep);
      const finished = (conclusion: string, seconds = perStep): SourceControlWorkflowStep => ({
        number: index + 1,
        name,
        status: "completed",
        conclusion: Option.some(conclusion),
        startedAt: Option.some(stepStart),
        completedAt: Option.some(plusSeconds(stepStart, seconds)),
        durationMs: Option.some(seconds * 1000),
      });
      const waiting = (status: "queued" | "in_progress"): SourceControlWorkflowStep => ({
        number: index + 1,
        name,
        status,
        conclusion: Option.none(),
        startedAt: status === "in_progress" ? Option.some(stepStart) : Option.none(),
        completedAt: Option.none(),
        durationMs: Option.none(),
      });
      if (outcome === "queued") return waiting("queued");
      if (outcome === "running") {
        if (index === runningIndex) return waiting("in_progress");
        if (index > runningIndex) return waiting("queued");
        return finished("success");
      }
      if (outcome === "skipped") return finished("skipped", 0);
      if (outcome === "failure") {
        if (name === failStep) {
          failed = true;
          return finished("failure");
        }
        if (failed && !POST_STEPS.includes(name)) return finished("skipped", 0);
      }
      return finished("success");
    });
    const done = outcome !== "running" && outcome !== "queued";
    const seconds = outcome === "skipped" ? 0 : def.seconds;
    const id = jobId(plan.runId, key);
    const logLines =
      plan.logs?.[key] ??
      (outcome === "success"
        ? OK_LOGS[key]
        : outcome === "running"
          ? OK_LOGS[key].slice(0, 2)
          : []);
    return {
      key,
      log:
        outcome === "queued" || outcome === "skipped"
          ? ""
          : rawLog(startedAt, def.steps[def.steps.length - 1] ?? def.name, logLines),
      job: {
        jobId: id,
        name: def.name,
        status: done ? "completed" : outcome === "running" ? "in_progress" : "queued",
        conclusion: done ? Option.some(outcome) : Option.none(),
        startedAt: outcome === "queued" ? Option.none() : Option.some(startedAt),
        completedAt: done ? Option.some(plusSeconds(startedAt, seconds)) : Option.none(),
        durationMs: done ? Option.some(seconds * 1000) : Option.none(),
        url: Option.some(`${runUrl}/job/${id}`),
        steps,
      },
    };
  });
  const live = jobs.some(({ job }) => job.status !== "completed");
  const failedJob = jobs.some(({ job }) => Option.getOrNull(job.conclusion) === "failure");
  const longest = Math.max(
    ...jobs.map(({ job }) => Option.getOrElse(job.durationMs, () => 0) / 1000),
  );
  return {
    jobs,
    run: {
      provider: "github",
      runId: String(plan.runId),
      workflowName: definition.name,
      displayTitle: pr.title,
      branch: Option.some(pr.headRefName),
      event: "pull_request",
      commit: {
        oid: fixtureSha(plan.headShort),
        shortOid: plan.headShort,
        messageHeadline: plan.headline,
      },
      actor: Option.some(pr.author),
      status: live ? "in_progress" : "completed",
      conclusion: live ? Option.none() : Option.some(failedJob ? "failure" : "success"),
      startedAt: Option.some(startedAt),
      updatedAt: Option.some(live ? m(1) : plusSeconds(startedAt, longest + 14)),
      durationMs: live ? Option.none() : Option.some((longest + 14) * 1000),
      url: runUrl,
    },
  };
}

function rollupForRun(built: BuiltRun): ReadonlyArray<SourceControlCheckRollupItem> {
  return built.jobs.map(({ job }) => ({
    kind: "check-run",
    name: job.name,
    workflowName: built.run.workflowName,
    status: Option.some(job.status.toUpperCase()),
    conclusion: Option.map(job.conclusion, (value) => value.toUpperCase()),
    url: job.url,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
  }));
}

function rollupForStatus(status: StatusPlan): SourceControlCheckRollupItem {
  return {
    kind: "status-context",
    name: status.name,
    status: Option.some(status.state.toUpperCase()),
    conclusion: Option.none(),
    url: Option.some(status.url),
    startedAt: Option.none(),
    completedAt: Option.none(),
  };
}

function vercelStatus(headRefName: string, state: StatusPlan["state"] = "success"): StatusPlan {
  return {
    name: "Vercel – ryco-web",
    state,
    description: state === "success" ? "Preview deployed" : "Building preview",
    url: `https://ryco-web-git-${headRefName.replaceAll("/", "-")}-ryco-labs.vercel.app`,
  };
}

/** CI (6 jobs) + Release dry run (2 jobs) + the Vercel status = 9 checks. */
function standardChecks(
  number: number,
  headShort: string,
  headline: string,
  headRefName: string,
  options: {
    readonly startedMinutesAgo: number;
    readonly ci?: Partial<Record<JobKey, JobOutcome>>;
    readonly release?: Partial<Record<JobKey, JobOutcome>>;
    readonly vercel?: StatusPlan["state"] | false;
  },
): ChecksPlan {
  const base = 18_213_000_000 + number * 100;
  return {
    workflows: [
      {
        kind: "ci",
        runId: base + 1,
        runNumber: 3400 + number,
        headShort,
        headline,
        startedMinutesAgo: options.startedMinutesAgo,
        ...(options.ci ? { outcomes: options.ci } : {}),
      },
      {
        kind: "release",
        runId: base + 2,
        runNumber: 300 + number,
        headShort,
        headline,
        startedMinutesAgo: options.startedMinutesAgo,
        ...(options.release ? { outcomes: options.release } : {}),
      },
    ],
    statuses:
      options.vercel === false ? [] : [vercelStatus(headRefName, options.vercel ?? "success")],
  };
}

// ── Pull request rows ─────────────────────────────────────────────────

type ReviewerSpec = readonly [
  login: string,
  state: SourceControlChangeRequestReviewerState,
  submittedAt?: DateTime.Utc,
];

interface FixtureRowSpec {
  readonly number: number;
  readonly title: string;
  readonly author: string;
  readonly state: ChangeRequestState;
  readonly isDraft?: boolean;
  readonly headRefName: string;
  readonly baseRefName: string;
  readonly createdAt: DateTime.Utc;
  readonly updatedAt: DateTime.Utc;
  readonly reviewDecision: SourceControlChangeRequestReviewDecision | null;
  readonly reviewers: ReadonlyArray<ReviewerSpec>;
  readonly assignees: ReadonlyArray<string>;
  readonly labels: ReadonlyArray<FixtureLabelName>;
  readonly mergeability: SourceControlChangeRequestMergeability;
  readonly mergeStateStatus: SourceControlChangeRequestMergeStateStatus;
  readonly comments: number;
  readonly additions: number;
  readonly deletions: number;
  readonly changedFiles: number;
  /** Short SHA of the head commit (detailed PRs use the lab's). */
  readonly headShort?: string;
  readonly mergedAt?: DateTime.Utc;
  readonly mergedBy?: string;
  readonly closedAt?: DateTime.Utc;
  readonly autoMerge?: SourceControlChangeRequestAutoMerge;
  /** Checks on the head (null: no CI reported). */
  readonly checks: (row: {
    number: number;
    headShort: string;
    headRefName: string;
    title: string;
  }) => ChecksPlan | null;
}

const passing9 =
  (startedMinutesAgo: number) =>
  (row: { number: number; headShort: string; headRefName: string; title: string }) =>
    standardChecks(row.number, row.headShort, row.title, row.headRefName, { startedMinutesAgo });

const ROW_SPECS: ReadonlyArray<FixtureRowSpec> = [
  // ── needs your review ──
  {
    number: 712,
    title: "Virtualize the pull request diff with LegendList",
    author: "mvogt",
    state: "open",
    headRefName: "mvogt/pr-diff-virtualization",
    baseRefName: "main",
    createdAt: d(2),
    updatedAt: m(18),
    reviewDecision: "review_required",
    reviewers: [
      ["sak0a", "requested"],
      ["eliotm", "commented", hr(20)],
      ["ryco-labs/web", "requested"],
    ],
    assignees: ["mvogt"],
    labels: ["area:web", "perf"],
    mergeability: "mergeable",
    mergeStateStatus: "blocked",
    comments: 6,
    additions: 412,
    deletions: 138,
    changedFiles: 10,
    headShort: "7f13e04",
    checks: (row) =>
      standardChecks(
        row.number,
        row.headShort,
        "Handle \\ No newline at end of file in diffLines",
        row.headRefName,
        {
          startedMinutesAgo: 18,
        },
      ),
  },
  {
    number: 713,
    title: "Fix: split diff loses scroll position on window resize",
    author: "mvogt",
    state: "open",
    headRefName: "mvogt/split-diff-scroll-anchor",
    baseRefName: "main",
    createdAt: hr(3),
    updatedAt: m(40),
    reviewDecision: "review_required",
    reviewers: [["sak0a", "requested"]],
    assignees: [],
    labels: ["area:web", "bug"],
    mergeability: "mergeable",
    mergeStateStatus: "blocked",
    comments: 0,
    additions: 18,
    deletions: 6,
    changedFiles: 2,
    checks: (row) =>
      standardChecks(row.number, row.headShort, row.title, row.headRefName, {
        startedMinutesAgo: 6,
        ci: { "test-web": "running", browser: "queued", build: "running" },
      }),
  },
  {
    number: 709,
    title: "Add reviewer and label pickers to the PR sidebar",
    author: "priyar",
    state: "open",
    headRefName: "priyar/pr-sidebar-pickers",
    baseRefName: "main",
    createdAt: d(1),
    updatedAt: hr(2),
    reviewDecision: "review_required",
    reviewers: [
      ["sak0a", "requested"],
      ["mvogt", "requested"],
    ],
    assignees: ["priyar"],
    labels: ["area:web", "feature"],
    mergeability: "mergeable",
    mergeStateStatus: "blocked",
    comments: 2,
    additions: 286,
    deletions: 41,
    changedFiles: 7,
    checks: (row) =>
      standardChecks(row.number, row.headShort, row.title, row.headRefName, {
        startedMinutesAgo: 5,
        ci: { browser: "running", build: "queued" },
      }),
  },
  {
    number: 706,
    title: "Decode reviewThreads from GraphQL into contracts",
    author: "tkessler",
    state: "open",
    headRefName: "tkessler/review-threads-contract",
    baseRefName: "main",
    createdAt: d(3),
    updatedAt: hr(5),
    reviewDecision: "changes_requested",
    reviewers: [
      ["sak0a", "requested"],
      ["eliotm", "changes_requested", hr(7)],
    ],
    assignees: ["tkessler"],
    labels: ["area:server", "contracts"],
    mergeability: "mergeable",
    mergeStateStatus: "blocked",
    comments: 9,
    additions: 534,
    deletions: 72,
    changedFiles: 11,
    checks: (row) =>
      standardChecks(row.number, row.headShort, row.title, row.headRefName, {
        startedMinutesAgo: 300,
        ci: { "test-server": "failure" },
        vercel: false,
      }),
  },
  {
    number: 698,
    title: "Fix relay reconnect when the hub rotates tickets",
    author: "anouk-d",
    state: "open",
    headRefName: "anouk-d/relay-ticket-rotation",
    baseRefName: "main",
    createdAt: d(4),
    updatedAt: d(1),
    reviewDecision: "approved",
    reviewers: [
      ["sak0a", "requested"],
      ["tkessler", "approved", d(1)],
    ],
    assignees: ["anouk-d"],
    labels: ["area:hub", "bug"],
    mergeability: "mergeable",
    mergeStateStatus: "clean",
    comments: 4,
    additions: 97,
    deletions: 31,
    changedFiles: 4,
    checks: passing9(1500),
  },
  {
    number: 694,
    title: "Hosted: revalidate the session before accepting a shell snapshot",
    author: "jonasw",
    state: "open",
    headRefName: "jonasw/hosted-snapshot-revalidate",
    baseRefName: "main",
    createdAt: d(9),
    updatedAt: d(3),
    reviewDecision: "review_required",
    reviewers: [
      ["sak0a", "requested"],
      ["anouk-d", "commented", d(5)],
    ],
    assignees: ["jonasw"],
    labels: ["area:hub", "security"],
    mergeability: "conflicting",
    mergeStateStatus: "dirty",
    comments: 7,
    additions: 221,
    deletions: 88,
    changedFiles: 6,
    checks: passing9(4400),
  },
  // ── yours: stack #14 (bottom → top) ──
  {
    number: 701,
    title: "Contracts: stack entries carry mergeStateStatus",
    author: "sak0a",
    state: "open",
    headRefName: "ryco/stack-1-contracts",
    baseRefName: "main",
    createdAt: d(5),
    updatedAt: hr(3),
    reviewDecision: "approved",
    reviewers: [
      ["mvogt", "approved", hr(4)],
      ["tkessler", "approved", hr(3)],
    ],
    assignees: ["sak0a"],
    labels: ["contracts", "stacks"],
    mergeability: "mergeable",
    mergeStateStatus: "clean",
    comments: 3,
    additions: 0,
    deletions: 0,
    changedFiles: 8,
    headShort: "0c4d8b5",
    checks: () => ({
      workflows: [
        {
          kind: "ci",
          runId: 18213902277,
          runNumber: 4171,
          headShort: "0c4d8b5",
          headline: "Contract tests for stack entry decoding",
          startedMinutesAgo: 300,
        },
        {
          kind: "release",
          runId: 18213902301,
          runNumber: 604,
          headShort: "0c4d8b5",
          headline: "Contract tests for stack entry decoding",
          startedMinutesAgo: 300,
        },
      ],
      statuses: [],
    }),
  },
  {
    number: 702,
    title: "Server: read GitHub-native stacks with paged GraphQL",
    author: "sak0a",
    state: "open",
    headRefName: "ryco/stack-2-server",
    baseRefName: "ryco/stack-1-contracts",
    createdAt: d(5),
    updatedAt: m(25),
    reviewDecision: "review_required",
    reviewers: [
      ["tkessler", "requested"],
      ["eliotm", "commented", hr(26)],
    ],
    assignees: ["sak0a"],
    labels: ["area:server", "stacks"],
    mergeability: "mergeable",
    mergeStateStatus: "blocked",
    comments: 2,
    additions: 0,
    deletions: 0,
    changedFiles: 4,
    headShort: "c71e0a9",
    checks: () => ({
      workflows: [
        {
          kind: "ci",
          runId: 18214420017,
          runNumber: 4181,
          headShort: "c71e0a9",
          headline: "Retry stack reads once on secondary rate limits",
          startedMinutesAgo: 4,
          outcomes: { "test-web": "running", browser: "queued", build: "running" },
        },
        {
          kind: "release",
          runId: 18214420040,
          runNumber: 612,
          headShort: "c71e0a9",
          headline: "Retry stack reads once on secondary rate limits",
          startedMinutesAgo: 4,
          outcomes: { "desktop-mac": "running" },
        },
      ],
      statuses: [],
    }),
  },
  {
    number: 703,
    title: "Web: stack layers rail and merge-through-layer",
    author: "sak0a",
    state: "open",
    headRefName: "ryco/stack-3-web-rail",
    baseRefName: "ryco/stack-2-server",
    createdAt: d(4),
    updatedAt: m(7),
    reviewDecision: "changes_requested",
    reviewers: [
      ["mvogt", "changes_requested", m(52)],
      ["eliotm", "commented", m(190)],
    ],
    assignees: ["sak0a"],
    labels: ["area:web", "stacks"],
    mergeability: "mergeable",
    mergeStateStatus: "blocked",
    comments: 11,
    additions: 0,
    deletions: 0,
    changedFiles: 12,
    headShort: "8e5d1c6",
    checks: (row) => ({
      workflows: [
        {
          kind: "ci",
          runId: 18214433871,
          runNumber: 4182,
          headShort: "8e5d1c6",
          headline: "client-runtime: depend on @ryco/shared for stack helpers",
          startedMinutesAgo: 9,
          outcomes: { "test-web": "failure" },
          logs: { "test-web": LOG_703_TEST_WEB_FAILURE },
        },
        {
          kind: "release",
          runId: 18214433902,
          runNumber: 611,
          headShort: "8e5d1c6",
          headline: "client-runtime: depend on @ryco/shared for stack helpers",
          startedMinutesAgo: 9,
        },
      ],
      statuses: [vercelStatus(row.headRefName)],
      history: [
        {
          kind: "ci",
          runId: 18214310552,
          runNumber: 4176,
          headShort: "f2c7a19",
          headline: "Name the base branch in the stack merge confirmation",
          startedMinutesAgo: 180,
        },
      ],
    }),
  },
  {
    number: 704,
    title: "Web: stack keyboard navigation (J/K between layers, S for the rail)",
    author: "sak0a",
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
    mergeability: "mergeable",
    mergeStateStatus: "draft",
    comments: 0,
    additions: 0,
    deletions: 0,
    changedFiles: 3,
    headShort: "92c5e81",
    checks: () => null,
  },
  // ── yours: standalone ──
  {
    number: 697,
    title: "Overview rail: pinned state survives reloads",
    author: "sak0a",
    state: "open",
    headRefName: "ryco/overview-rail-pin-persist",
    baseRefName: "main",
    createdAt: d(2),
    updatedAt: hr(6),
    reviewDecision: "approved",
    reviewers: [["priyar", "approved", hr(7)]],
    assignees: ["sak0a"],
    labels: ["area:web"],
    mergeability: "mergeable",
    mergeStateStatus: "behind",
    comments: 1,
    additions: 52,
    deletions: 14,
    changedFiles: 3,
    checks: passing9(400),
  },
  {
    number: 690,
    title: "Inbox: settle animation respects reduced motion",
    author: "sak0a",
    state: "merged",
    headRefName: "ryco/inbox-settle-reduced-motion",
    baseRefName: "main",
    createdAt: d(3),
    updatedAt: d(1),
    mergedAt: d(1),
    mergedBy: "sak0a",
    reviewDecision: "approved",
    reviewers: [["mvogt", "approved", minutesAgo(1440 + 30)]],
    assignees: ["sak0a"],
    labels: ["area:web"],
    mergeability: "unknown",
    mergeStateStatus: "unknown",
    comments: 2,
    additions: 23,
    deletions: 11,
    changedFiles: 2,
    checks: passing9(1500),
  },
  {
    number: 683,
    title: "Try framer-motion for split panes",
    author: "sak0a",
    state: "closed",
    headRefName: "ryco/split-pane-framer",
    baseRefName: "main",
    createdAt: d(11),
    updatedAt: d(6),
    closedAt: d(6),
    reviewDecision: "review_required",
    reviewers: [],
    assignees: ["sak0a"],
    labels: ["area:web", "needs-design"],
    mergeability: "unknown",
    mergeStateStatus: "unknown",
    comments: 3,
    additions: 310,
    deletions: 122,
    changedFiles: 9,
    checks: () => null,
  },
  // ── others: stack #15 ──
  {
    number: 715,
    title: "Settings: extract settingsLayout primitives",
    author: "priyar",
    state: "open",
    headRefName: "priyar/settings-layout-primitives",
    baseRefName: "main",
    createdAt: d(1),
    updatedAt: hr(4),
    reviewDecision: "approved",
    reviewers: [["mvogt", "approved", hr(5)]],
    assignees: ["priyar"],
    labels: ["area:web"],
    mergeability: "mergeable",
    mergeStateStatus: "clean",
    comments: 1,
    additions: 204,
    deletions: 167,
    changedFiles: 8,
    checks: passing9(260),
  },
  {
    number: 716,
    title: "Settings: move provider instances onto the settings page",
    author: "priyar",
    state: "open",
    headRefName: "priyar/settings-provider-instances",
    baseRefName: "priyar/settings-layout-primitives",
    createdAt: d(1),
    updatedAt: hr(4),
    reviewDecision: "review_required",
    reviewers: [
      ["mvogt", "requested"],
      ["ryco-labs/web", "requested"],
    ],
    assignees: ["priyar"],
    labels: ["area:web", "feature"],
    mergeability: "mergeable",
    mergeStateStatus: "blocked",
    comments: 0,
    additions: 318,
    deletions: 96,
    changedFiles: 10,
    checks: passing9(250),
  },
  // ── others ──
  {
    number: 688,
    title: "Release: sign and notarize the desktop DMG in CI",
    author: "jonasw",
    state: "open",
    headRefName: "jonasw/desktop-notarize",
    baseRefName: "main",
    createdAt: d(2),
    updatedAt: m(52),
    reviewDecision: "review_required",
    reviewers: [
      ["anouk-d", "commented", hr(20)],
      ["tkessler", "dismissed", d(1)],
    ],
    assignees: ["jonasw"],
    labels: ["area:desktop", "release"],
    mergeability: "mergeable",
    mergeStateStatus: "blocked",
    comments: 5,
    additions: 0,
    deletions: 0,
    changedFiles: 8,
    headShort: "5f81a6d",
    checks: (row) => ({
      workflows: [
        {
          kind: "ci",
          runId: 18214380003,
          runNumber: 4177,
          headShort: "5f81a6d",
          headline: "Fail fast when the notary profile is missing",
          startedMinutesAgo: 50,
        },
        {
          kind: "release",
          runId: 18214380021,
          runNumber: 608,
          headShort: "5f81a6d",
          headline: "Fail fast when the notary profile is missing",
          startedMinutesAgo: 50,
          withSmoke: true,
          outcomes: { "desktop-mac": "failure" },
          failStep: { "desktop-mac": "Notarize (dry run)" },
          logs: { "desktop-mac": LOG_688_DESKTOP_FAILURE },
        },
      ],
      statuses: [vercelStatus(row.headRefName)],
    }),
  },
  {
    number: 711,
    title: "chore(deps): update effect to 3.19 and @effect/tsgo to 0.9",
    author: "renovate[bot]",
    state: "open",
    headRefName: "renovate/effect-monorepo",
    baseRefName: "main",
    createdAt: hr(9),
    updatedAt: hr(9),
    reviewDecision: "review_required",
    reviewers: [["ryco-labs/runtime", "requested"]],
    assignees: [],
    labels: ["dependencies"],
    mergeability: "mergeable",
    mergeStateStatus: "blocked",
    comments: 1,
    additions: 41,
    deletions: 41,
    changedFiles: 3,
    checks: passing9(530),
  },
  {
    number: 705,
    title: "Mobile: native pull request list (read-only)",
    author: "eliotm",
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
    mergeability: "mergeable",
    mergeStateStatus: "draft",
    comments: 2,
    additions: 612,
    deletions: 8,
    changedFiles: 14,
    checks: () => null,
  },
  {
    number: 692,
    title: "Terminal drawer: keep scrollback across reconnects",
    author: "tkessler",
    state: "open",
    headRefName: "tkessler/terminal-scrollback",
    baseRefName: "main",
    createdAt: d(3),
    updatedAt: hr(3),
    reviewDecision: "approved",
    reviewers: [["anouk-d", "approved", hr(4)]],
    assignees: ["tkessler"],
    labels: ["area:web", "bug"],
    mergeability: "mergeable",
    mergeStateStatus: "clean",
    autoMerge: { mergeMethod: "squash", enabledBy: "tkessler", enabledAt: hr(3) },
    comments: 3,
    additions: 64,
    deletions: 22,
    changedFiles: 3,
    checks: passing9(200),
  },
  {
    number: 700,
    title: "Docs: provider guide for OpenCode",
    author: "anouk-d",
    state: "merged",
    headRefName: "anouk-d/docs-opencode",
    baseRefName: "main",
    createdAt: d(4),
    updatedAt: d(2),
    mergedAt: d(2),
    mergedBy: "mvogt",
    reviewDecision: "approved",
    reviewers: [["mvogt", "approved", d(2)]],
    assignees: [],
    labels: ["docs"],
    mergeability: "unknown",
    mergeStateStatus: "unknown",
    comments: 1,
    additions: 141,
    deletions: 3,
    changedFiles: 2,
    checks: (row) => ({
      workflows: [
        {
          kind: "docs",
          runId: 18_213_070_001,
          runNumber: 4100,
          headShort: row.headShort,
          headline: row.title,
          startedMinutesAgo: 2900,
        },
      ],
      statuses: [vercelStatus(row.headRefName)],
    }),
  },
  {
    number: 687,
    title: "Server: cache gh pr view for 5s per cwd",
    author: "eliotm",
    state: "closed",
    headRefName: "eliotm/gh-pr-view-cache",
    baseRefName: "main",
    createdAt: d(14),
    updatedAt: d(12),
    closedAt: d(12),
    reviewDecision: "changes_requested",
    reviewers: [["sak0a", "changes_requested", d(13)]],
    assignees: ["eliotm"],
    labels: ["area:server", "perf"],
    mergeability: "unknown",
    mergeStateStatus: "unknown",
    comments: 4,
    additions: 88,
    deletions: 12,
    changedFiles: 3,
    checks: passing9(17_300),
  },
  {
    number: 679,
    title: "Composer: pasting a PR URL attaches it as context",
    author: "priyar",
    state: "merged",
    headRefName: "priyar/composer-pr-url-context",
    baseRefName: "main",
    createdAt: d(8),
    updatedAt: d(4),
    mergedAt: d(4),
    mergedBy: "priyar",
    reviewDecision: "approved",
    reviewers: [["sak0a", "approved", d(5)]],
    assignees: ["priyar"],
    labels: ["area:web", "feature"],
    mergeability: "unknown",
    mergeStateStatus: "unknown",
    comments: 2,
    additions: 133,
    deletions: 17,
    changedFiles: 5,
    checks: passing9(5800),
  },
];

/** PRs the viewer authored (what the `involvement: "authored"` list read returns, all states). */
export const fixtureAuthoredNumbers: ReadonlyArray<number> = [701, 702, 703, 704, 697, 690, 683];
/** PRs requesting the viewer's review (`involvement: "review-requested"`). */
export const fixtureReviewRequestedNumbers: ReadonlyArray<number> = [712, 713, 709, 706, 698, 694];

/** GitHub-native stacks, bottom → top. */
export const FIXTURE_STACKS = [
  { number: 14, baseRefName: "main", entries: [701, 702, 703, 704] },
  { number: 15, baseRefName: "main", entries: [715, 716] },
] as const;

/** PRs with hand-written detail, diff, activity, and checks. */
export const FIXTURE_DETAILED_NUMBERS: ReadonlyArray<number> = [703, 701, 702, 704, 712, 688];

const ROW_SPEC_BY_NUMBER = new Map(ROW_SPECS.map((spec) => [spec.number, spec]));

function requireRowSpec(number: number): FixtureRowSpec {
  const spec = ROW_SPEC_BY_NUMBER.get(number);
  if (!spec) throw new Error(`No pull request fixture for #${number}.`);
  return spec;
}

function headShortFor(spec: FixtureRowSpec): string {
  return spec.headShort ?? hex40(`pr${spec.number}`).slice(0, 7);
}

function prUrl(number: number): string {
  return `${FIXTURE_REPOSITORY_URL}/pull/${number}`;
}

// ── Built checks (memoized per PR) ────────────────────────────────────

interface BuiltChecks {
  readonly runs: ReadonlyArray<BuiltRun>;
  readonly history: ReadonlyArray<BuiltRun>;
  readonly rollup: ReadonlyArray<SourceControlCheckRollupItem>;
}

const builtChecksCache = new Map<number, BuiltChecks>();

function builtChecks(number: number): BuiltChecks {
  const cached = builtChecksCache.get(number);
  if (cached) return cached;
  const spec = requireRowSpec(number);
  const plan = spec.checks({
    number,
    headShort: headShortFor(spec),
    headRefName: spec.headRefName,
    title: spec.title,
  });
  const runs = (plan?.workflows ?? []).map((workflow) => buildRun(workflow, spec));
  const history = (plan?.history ?? []).map((workflow) => buildRun(workflow, spec));
  const built: BuiltChecks = {
    runs,
    history,
    rollup: [...runs.flatMap(rollupForRun), ...(plan?.statuses ?? []).map(rollupForStatus)],
  };
  builtChecksCache.set(number, built);
  return built;
}

const runIndex = new Map<string, { number: number; built: BuiltRun }>();
function indexRuns(): void {
  if (runIndex.size > 0) return;
  for (const spec of ROW_SPECS) {
    const checks = builtChecks(spec.number);
    for (const built of [...checks.runs, ...checks.history]) {
      runIndex.set(built.run.runId, { number: spec.number, built });
    }
  }
}

// ── Patches → files, diff, anchors ────────────────────────────────────

interface DiffRow {
  readonly kind: "add" | "del" | "ctx";
  readonly text: string;
  readonly oldLine: number | null;
  readonly newLine: number | null;
  readonly hunk: number;
}

function patchRows(patch: string): ReadonlyArray<DiffRow> {
  const rows: DiffRow[] = [];
  let oldLine = 0;
  let newLine = 0;
  let hunk = -1;
  for (const line of patch.split("\n")) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)/u.exec(line);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      hunk += 1;
      continue;
    }
    const marker = line[0];
    if (marker === "\\") continue;
    if (marker === "+")
      rows.push({ kind: "add", text: line.slice(1), oldLine: null, newLine: newLine++, hunk });
    else if (marker === "-")
      rows.push({ kind: "del", text: line.slice(1), oldLine: oldLine++, newLine: null, hunk });
    else
      rows.push({ kind: "ctx", text: line.slice(1), oldLine: oldLine++, newLine: newLine++, hunk });
  }
  return rows;
}

function patchesFor(number: number): ReadonlyArray<FixturePatchFile> {
  return [...(FIXTURE_PATCHES[number] ?? [])].toSorted((left, right) =>
    left.path.localeCompare(right.path),
  );
}

function requirePatch(number: number, path: string): FixturePatchFile {
  const file = FIXTURE_PATCHES[number]?.find((entry) => entry.path === path);
  if (!file) throw new Error(`No fixture patch for #${number} ${path}.`);
  return file;
}

function fileStats(file: FixturePatchFile): { additions: number; deletions: number } {
  const rows = patchRows(file.patch);
  return {
    additions: rows.filter((row) => row.kind === "add").length,
    deletions: rows.filter((row) => row.kind === "del").length,
  };
}

export interface FixtureDiffAnchor {
  readonly line: number;
  /** GitHub-style excerpt: the last ≤4 lines of the hunk up to the anchored line. */
  readonly diffHunk: string;
}

/**
 * The diff line that contains `match`, on `side` (`right` = head/added or
 * context, `left` = base/deleted or context), searching from line `from`.
 */
export function fixtureDiffAnchor(
  number: number,
  path: string,
  match: string,
  options?: { readonly side?: ChangeRequestDiffSide; readonly from?: number },
): FixtureDiffAnchor {
  const side = options?.side ?? "right";
  const rows = patchRows(requirePatch(number, path).patch);
  const lineOf = (row: DiffRow) => (side === "right" ? row.newLine : row.oldLine);
  const index = rows.findIndex(
    (row) =>
      (side === "right" ? row.kind !== "del" : row.kind !== "add") &&
      (lineOf(row) ?? 0) >= (options?.from ?? 0) &&
      row.text.includes(match),
  );
  const row = rows[index];
  const line = row ? lineOf(row) : null;
  if (!row || line === null) {
    throw new Error(`Fixture anchor "${match}" not found in #${number} ${path} (${side}).`);
  }
  let start = index;
  while (start > 0 && index - start < 3 && rows[start - 1]?.hunk === row.hunk) start -= 1;
  const excerpt = rows.slice(start, index + 1);
  const first = excerpt[0] ?? row;
  const oldCount = excerpt.filter((entry) => entry.kind !== "add").length;
  const newCount = excerpt.filter((entry) => entry.kind !== "del").length;
  const oldStart = first.oldLine ?? excerpt.find((entry) => entry.oldLine !== null)?.oldLine ?? 0;
  const newStart = first.newLine ?? excerpt.find((entry) => entry.newLine !== null)?.newLine ?? 0;
  const sign = { add: "+", del: "-", ctx: " " } as const;
  return {
    line,
    diffHunk: [
      `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
      ...excerpt.map((entry) => sign[entry.kind] + entry.text),
    ].join("\n"),
  };
}

/**
 * A realistic `git diff` for the change request (files sorted by path, as the
 * host returns them). With `commitSha`, only the files that commit touched
 * (their whole PR patch — an approximation of a commit-scoped diff).
 */
export function fixtureDiff(
  number: number,
  options?: { readonly commitSha?: string | null | undefined },
): string {
  const commitShort = options?.commitSha ? options.commitSha.slice(0, 7) : null;
  return patchesFor(number)
    .filter((file) => commitShort === null || file.commits.includes(commitShort))
    .map((file) => {
      const blobAfter = hex40(`${number}:${file.path}:after`).slice(0, 7);
      const blobBefore = hex40(`${number}:${file.path}:before`).slice(0, 7);
      const header =
        file.status === "added"
          ? [
              `diff --git a/${file.path} b/${file.path}`,
              "new file mode 100644",
              `index 0000000..${blobAfter}`,
              "--- /dev/null",
              `+++ b/${file.path}`,
            ]
          : [
              `diff --git a/${file.path} b/${file.path}`,
              `index ${blobBefore}..${blobAfter} 100644`,
              `--- a/${file.path}`,
              `+++ b/${file.path}`,
            ];
      return [...header, file.patch].join("\n");
    })
    .join("\n")
    .concat("\n");
}

// ── Review threads ────────────────────────────────────────────────────

type ReactionSpec = readonly [SourceControlCommentReactionContent, number, boolean?];

interface CommentSpec {
  readonly id: string;
  readonly author: string;
  readonly at: DateTime.Utc;
  readonly body: string;
  readonly reactions?: ReadonlyArray<ReactionSpec>;
  readonly pending?: boolean;
}

function reactions(specs: ReadonlyArray<ReactionSpec> | undefined): {
  reactions?: ReadonlyArray<SourceControlCommentReaction>;
} {
  if (!specs || specs.length === 0) return {};
  return {
    reactions: specs.map(([content, count, viewerHasReacted]) => ({
      content,
      count,
      ...(viewerHasReacted ? { viewerHasReacted: true } : {}),
    })),
  };
}

function reviewComment(number: number, spec: CommentSpec): ChangeRequestReviewComment {
  const own = spec.author === FIXTURE_VIEWER_LOGIN;
  return {
    id: spec.id,
    author: fixtureActor(spec.author),
    authorAssociation: authorAssociation(spec.author),
    body: spec.body,
    createdAt: spec.at,
    url: `${prUrl(number)}#discussion_r${spec.id}`,
    ...reactions(spec.reactions),
    state: spec.pending ? "pending" : "submitted",
    viewerCanUpdate: own,
    viewerCanDelete: own,
  };
}

interface ThreadSpec {
  readonly id: string;
  readonly number: number;
  readonly path: string;
  readonly comments: ReadonlyArray<CommentSpec>;
  readonly resolvedBy?: string;
  readonly side?: ChangeRequestDiffSide;
  /** Line anchor (omit for file-level or outdated threads). */
  readonly match?: string;
  /** Start of a multi-line range on the same side. */
  readonly startMatch?: string;
  readonly outdated?: { readonly originalLine: number; readonly diffHunk: string };
}

function reviewThread(spec: ThreadSpec): ChangeRequestReviewThread {
  const side = spec.side ?? "right";
  const isResolved = spec.resolvedBy !== undefined;
  const base = {
    id: spec.id,
    path: spec.path,
    side,
    isResolved,
    ...(spec.resolvedBy !== undefined ? { resolvedBy: spec.resolvedBy } : {}),
    viewerCanReply: true,
    viewerCanResolve: !isResolved,
    viewerCanUnresolve: isResolved,
    comments: spec.comments.map((comment) => reviewComment(spec.number, comment)),
    totalComments: spec.comments.length,
  };
  if (spec.outdated) {
    return {
      ...base,
      subjectType: "line",
      line: null,
      startLine: null,
      originalLine: spec.outdated.originalLine,
      originalStartLine: null,
      diffHunk: spec.outdated.diffHunk,
      isOutdated: true,
    };
  }
  if (spec.match === undefined) {
    return { ...base, subjectType: "file", line: null, isOutdated: false };
  }
  const start =
    spec.startMatch !== undefined
      ? fixtureDiffAnchor(spec.number, spec.path, spec.startMatch, { side })
      : null;
  const end = fixtureDiffAnchor(spec.number, spec.path, spec.match, {
    side,
    ...(start ? { from: start.line } : {}),
  });
  return {
    ...base,
    subjectType: "line",
    line: end.line,
    originalLine: end.line,
    ...(start
      ? { startLine: start.line, originalStartLine: start.line, startSide: side }
      : { startLine: null, originalStartLine: null }),
    diffHunk: end.diffHunk,
    isOutdated: false,
  };
}

const RAIL = "apps/web/src/components/pullRequests/PullRequestStackRail.tsx";
const LAYERS = "apps/web/src/components/pullRequests/stackLayers.logic.ts";
const LAYERS_TEST = "apps/web/src/components/pullRequests/stackLayers.logic.test.ts";
const MERGE_BOX = "apps/web/src/components/pullRequests/PullRequestMergeBox.tsx";

/** Thread ids of #703, by what they are about. */
export const FIXTURE_703_THREADS = {
  /** Unresolved, mvogt (changes requested) + reply; stackLayers.logic.ts. */
  draftWalk: "703-t1",
  /** Unresolved, eliotm, with a ```suggestion block; PullRequestStackRail.tsx. */
  ariaCurrent: "703-t2",
  /** Resolved nit on the merge confirmation; PullRequestMergeBox.tsx. */
  baseBranchNit: "703-t3",
  /** Outdated (`line: null`, `originalLine: 23`), resolved. */
  outdatedSort: "703-t4",
  /** Resolved, on the test file. */
  closedLayerTest: "703-t5",
  /** Resolved multi-line range (`startLine` → `line`). */
  keyboardRange: "703-t6",
  /** Resolved, LEFT side (a deleted line). */
  deletedBlocker: "703-t7",
  /** Resolved, file-level (`subjectType: "file"`) on index.css. */
  fileLevelCss: "703-t8",
} as const;

const THREAD_SPECS: Readonly<Record<number, ReadonlyArray<ThreadSpec>>> = {
  703: [
    {
      id: "703-t1",
      number: 703,
      path: LAYERS,
      match: "if (target?.entry.isDraft) return",
      comments: [
        {
          id: "703-c1",
          author: "mvogt",
          at: m(52),
          body: "This only refuses when the *target* is a draft. A draft further down (say #702 flips back to draft while you're looking at this one) slips through, because `draft` isn't in the `blockedBy` filter below — and then `merge-async` 422s halfway up the stack.",
          reactions: [["thumbs-up", 1]],
        },
        {
          id: "703-c2",
          author: "sak0a",
          at: m(31),
          body: "Right, the walk should treat every unmerged layer under the target the same way. The new test in `stackLayers.logic.test.ts` already catches it (that's the red CI run). Fixing.",
        },
      ],
    },
    {
      id: "703-t2",
      number: 703,
      path: RAIL,
      match: "aria-selected={selected}",
      comments: [
        {
          id: "703-c3",
          author: "eliotm",
          at: m(190),
          body: '`aria-selected` only means something inside a listbox or tablist. Each layer is a link to its PR, so `aria-current` is the attribute screen readers announce here:\n\n```suggestion\n              aria-current={selected ? "page" : undefined}\n```',
        },
      ],
    },
    {
      id: "703-t3",
      number: 703,
      path: MERGE_BOX,
      match: "pull requests into",
      resolvedBy: "sak0a",
      comments: [
        {
          id: "703-c4",
          author: "mvogt",
          at: m(1440 + 200),
          body: 'nit: can the confirmation name the base branch? "Merge 3 pull requests into main" says what\'s about to happen; "Merge 3 PRs" makes me count.',
        },
        {
          id: "703-c5",
          author: "sak0a",
          at: hr(3),
          body: "Done in f2c7a19.",
          reactions: [["hooray", 1]],
        },
      ],
    },
    {
      id: "703-t4",
      number: 703,
      path: LAYERS,
      resolvedBy: "sak0a",
      outdated: {
        originalLine: 23,
        diffHunk:
          "@@ -0,0 +21,3 @@\n+/** Bottom → top: the order GitHub reports and the order a merge walks. */\n+export function stackLayers(stack: SourceControlChangeRequestStack): ReadonlyArray<StackLayer> {\n+  const ordered = stack.entries.sort((a, b) => a.position - b.position);",
      },
      comments: [
        {
          id: "703-c6",
          author: "eliotm",
          at: m(3 * 1440 + 30),
          body: "`entries.sort` sorts in place, so this mutates the array cached in the detail atom and every render re-sorts the shared copy.",
        },
        {
          id: "703-c7",
          author: "sak0a",
          at: m(2 * 1440 - 5),
          body: "Good catch. I dropped the sort entirely: GitHub already returns bottom → top and the contract documents it.",
          reactions: [["thumbs-up", 1]],
        },
      ],
    },
    {
      id: "703-t5",
      number: 703,
      path: LAYERS_TEST,
      match: 'describe("planStackMerge"',
      resolvedBy: "sak0a",
      comments: [
        {
          id: "703-c8",
          author: "mvogt",
          at: m(1440 + 200),
          body: "Can we get a case for a *closed* layer in the middle? That's the one that bit us on the sandbox repo.",
        },
        { id: "703-c9", author: "sak0a", at: d(1), body: "Added in 4e1d0b2." },
      ],
    },
    {
      id: "703-t6",
      number: 703,
      path: RAIL,
      startMatch: "const onKeyDown = useCallback",
      match: "}, []);",
      resolvedBy: "mvogt",
      comments: [
        {
          id: "703-c10",
          author: "mvogt",
          at: m(1440 + 200),
          body: "Querying `a` elements out of the DOM on every arrow key works, but a roving `tabIndex` would keep Tab from walking through every layer. Fine as a follow-up.",
        },
        {
          id: "703-c11",
          author: "sak0a",
          at: m(1440 + 150),
          body: "Agreed — tracked in #704, which owns keyboard handling for the rail.",
        },
      ],
    },
    {
      id: "703-t7",
      number: 703,
      path: MERGE_BOX,
      side: "left",
      match: "const blocker = pullRequestMergeBlocker(detail);",
      resolvedBy: "eliotm",
      comments: [
        {
          id: "703-c12",
          author: "eliotm",
          at: m(3 * 1440 + 30),
          body: "Without a stack, does this still say why a merge is blocked? Dropping this line looked like it loses the reason.",
        },
        {
          id: "703-c13",
          author: "sak0a",
          at: m(3 * 1440 - 10),
          body: "It still falls back to `pullRequestMergeBlocker(detail)` when there is no plan — same reason text as before.",
        },
      ],
    },
    {
      id: "703-t8",
      number: 703,
      path: "apps/web/src/index.css",
      resolvedBy: "sak0a",
      comments: [
        {
          id: "703-c14",
          author: "eliotm",
          at: m(190),
          body: "Should the rail keyframes live with the pull request styles instead of growing `index.css` further?",
        },
        {
          id: "703-c15",
          author: "sak0a",
          at: m(170),
          body: "Yes — they move once the page stylesheet split lands. Leaving them here so this PR stays reviewable.",
        },
      ],
    },
  ],
  712: [
    {
      id: "712-t1",
      number: 712,
      path: "apps/web/src/components/pullRequests/diffRows.logic.ts",
      match: 'const key = file.path + ":" + index;',
      comments: [
        {
          id: "712-c1",
          author: "eliotm",
          at: hr(20),
          body: "Index keys will shift every row below a hunk once we load more context into it, and LegendList will recycle the wrong rows. Could the key come from the old/new line numbers instead?",
        },
        {
          id: "712-c2",
          author: "mvogt",
          at: hr(19),
          body: "Agreed for hunk expansion, but nothing reorders today because expansion isn't wired up yet. I'd rather do it together with expansion in a follow-up. OK with you?",
        },
      ],
    },
    {
      id: "712-t2",
      number: 712,
      path: "apps/web/src/components/pullRequests/PullRequestDiffList.tsx",
      match: "estimatedItemSize={ESTIMATED_ROW_HEIGHT}",
      resolvedBy: "mvogt",
      comments: [
        { id: "712-c3", author: "eliotm", at: hr(20), body: "Is 20 still right once lines wrap?" },
        {
          id: "712-c4",
          author: "mvogt",
          at: hr(19),
          body: "It's only the estimate for unwrapped lines. Wrapped rows are measured after the first layout, and 3e7b6d1 caches those measurements per file.",
          reactions: [["thumbs-up", 1]],
        },
      ],
    },
    {
      id: "712-t3",
      number: 712,
      path: "apps/web/src/components/pullRequests/PullRequestDiffList.tsx",
      match: "drawDistance={1200}",
      comments: [
        {
          id: "712-p1",
          author: "sak0a",
          at: m(12),
          pending: true,
          body: "Could the draw distance follow the viewport height instead of a fixed 1200? On a 4K display the list runs out of rendered rows when you fling-scroll.",
        },
      ],
    },
  ],
  701: [
    {
      id: "701-t1",
      number: 701,
      path: "apps/server/src/sourceControl/gitHubPullRequestStacks.ts",
      match: "function decodeMergeStateStatus",
      resolvedBy: "sak0a",
      comments: [
        {
          id: "701-c1",
          author: "tkessler",
          at: d(4),
          body: "Should `UNKNOWN` decode to `null` here? Otherwise the UI shows a status it can't explain, and GitHub returns UNKNOWN for the first few seconds after every push.",
        },
        {
          id: "701-c2",
          author: "sak0a",
          at: m(4 * 1440 - 40),
          body: "Yes. It maps to `null` now, and anything newer than the known list does too.",
          reactions: [["thumbs-up", 1]],
        },
      ],
    },
  ],
  702: [
    {
      id: "702-t1",
      number: 702,
      path: "apps/server/src/sourceControl/gitHubPullRequestStacks.ts",
      match: "if (endCursor === after)",
      resolvedBy: "sak0a",
      comments: [
        {
          id: "702-c1",
          author: "eliotm",
          at: hr(26),
          body: "Has this actually happened, or is it defensive?",
        },
        {
          id: "702-c2",
          author: "sak0a",
          at: hr(25),
          body: "Twice on the sandbox repo while a layer was being retargeted. The comment says so now.",
        },
      ],
    },
  ],
  688: [
    {
      id: "688-t1",
      number: 688,
      path: ".github/workflows/release-dry-run.yml",
      match: "secrets: inherit",
      comments: [
        {
          id: "688-c1",
          author: "anouk-d",
          at: hr(20),
          body: "Pull requests from forks and Dependabot don't get secrets, so this step can never pass for outside contributors. Gate it on `github.event.pull_request.head.repo.full_name == github.repository`? (Also, `secrets: inherit` is only valid on reusable-workflow calls, not on a step.)",
          reactions: [["thumbs-up", 1]],
        },
        {
          id: "688-c2",
          author: "jonasw",
          at: hr(19),
          body: "Fair on both. Do we still want the DMG build for forks, just without notarize? I'd keep it, since that's where most packaging regressions show up.",
        },
      ],
    },
  ],
};

const threadCache = new Map<number, ReadonlyArray<ChangeRequestReviewThread>>();
function threadsFor(number: number): ReadonlyArray<ChangeRequestReviewThread> {
  const cached = threadCache.get(number);
  if (cached) return cached;
  const threads = (THREAD_SPECS[number] ?? []).map(reviewThread);
  threadCache.set(number, threads);
  return threads;
}

// ── Commits ───────────────────────────────────────────────────────────

type CommitCheck = "success" | "failure" | "pending" | "neutral";
type CommitSpec = readonly [short: string, headline: string, at: DateTime.Utc, check?: CommitCheck];

const COMMIT_SPECS: Readonly<Record<number, ReadonlyArray<CommitSpec>>> = {
  703: [
    ["a41c9e2", "Add stack layer assessment and merge planning", d(4), "success"],
    ["7d02f5b", "Render the stack rail next to the PR header", d(4), "success"],
    ["c3e81a0", "Wire merge-through-layer into the merge box", m(3 * 1440 + 120), "success"],
    ["19be4f7", "Browser test for rail keyboard focus", m(3 * 1440 + 115), "success"],
    ["4e1d0b2", "Cover a closed layer in the middle of the stack", d(1), "success"],
    ["0b9d3a8", "Use stack position in rail aria labels", hr(20), "success"],
    ["f2c7a19", "Name the base branch in the stack merge confirmation", hr(3), "success"],
    ["8e5d1c6", "client-runtime: depend on @ryco/shared for stack helpers", m(9), "failure"],
  ],
  712: [
    ["2b8f1e0", "Flatten parsed diff files into virtual rows", d(2), "success"],
    ["6a90c3d", "Render the PR diff through LegendList", d(2), "success"],
    ["91d4e7b", "Sticky file headers inside the virtual list", m(1440 + 300), "success"],
    ["c08a5f2", "Keep expanded files across tab switches", d(1), "success"],
    ["3e7b6d1", "Measure row heights once per file", hr(20), "success"],
    ["a5d29c8", "Tests for row flattening and sticky headers", hr(19), "success"],
    ["7f13e04", "Handle \\ No newline at end of file in diffLines", m(18), "success"],
  ],
  701: [
    ["d1e4a07", "Add mergeStateStatus and headSha to stack entries", d(5), "success"],
    ["6c2b9f1", "Decode mergeStateStatus from the stack GraphQL", d(5), "success"],
    ["a8f03e6", "Stack snapshot state in client-runtime", d(4), "success"],
    ["57de2c4", "Export the pull-request-stack subpath", d(4), "success"],
    ["e2b6f90", "Allow sourceControl.getChangeRequestStack for operators", d(3), "success"],
    ["0c4d8b5", "Contract tests for stack entry decoding", hr(5), "success"],
  ],
  702: [
    ["b3e9d14", "Page stack entries 50 at a time", d(5), "success"],
    ["f60a2c8", "Strict consistency checks across stack pages", d(4), "success"],
    ["29c7e5a", "Batch stack summaries for list rows, 40 per query", d(3), "success"],
    ["8d4f1b6", "Mark stack metadata incomplete instead of failing the detail", hr(26), "success"],
    ["c71e0a9", "Retry stack reads once on secondary rate limits", m(25), "pending"],
  ],
  704: [
    ["e1a7c30", "J/K move between stack layers", d(2)],
    ["4b9f2d7", "S toggles the stack rail", d(1)],
    ["92c5e81", "Ignore layer shortcuts while focus is inside the diff", hr(1)],
  ],
  688: [
    ["9d7a1b3", "Add notarize script with a keychain profile check", d(2), "success"],
    ["e4c6f02", "Run notarization in the release workflow", d(2), "success"],
    ["1b5f8d9", "Dry-run notarization in release-dry-run", d(1), "failure"],
    ["70a3e4c", "Pass APPLE_TEAM_ID through the electron-builder config", d(1), "failure"],
    ["c9e2b57", "Document the signing secrets in docs/release.md", hr(20), "failure"],
    ["5f81a6d", "Fail fast when the notary profile is missing", m(52), "failure"],
  ],
};

function commitSpecsFor(spec: FixtureRowSpec): ReadonlyArray<CommitSpec> {
  return COMMIT_SPECS[spec.number] ?? [[headShortFor(spec), spec.title, spec.createdAt]];
}

// ── Detail ────────────────────────────────────────────────────────────

const BODIES: Readonly<Record<number, string>> = {
  703: `Third layer of the stacked-PR work. It puts the stack **next to** the pull request instead of behind a chip, and lets you merge *through* any layer.

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

> The head-SHA guard (\`expectedHeads\`) lands in #704; this PR only records them.`,
  712: `Replaces the \`<pre>\` diff in the Files tab with a single virtualized list (LegendList), so big PRs open instantly and scroll without dropping frames.

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

cc @sak0a for the sticky header behaviour, you wrote the original Files tab.`,
  701: `Bottom layer of the stacked-PR work. It's contracts and decoding only, with no UI.

- \`SourceControlChangeRequestStackEntry\` gains \`headSha\` and a typed \`mergeStateStatus\`.
- The stack GraphQL query asks for \`headRefOid\` and \`mergeStateStatus\`.
- New \`@ryco/client-runtime/state/pull-request-stack\` subpath with \`stackSnapshot\`.
- \`sourceControl.getChangeRequestStack\` is allowed for operators.

- [x] Contract tests
- [x] Decoder tests for UNKNOWN → null

Next layers: #702 (server reads) → #703 (rail + merge-through) → #704 (keyboard).`,
  702: "Second layer of the stacked-PR work. Reads GitHub-native stacks with cursor paging (50 entries per page), batches list-row summaries 40 at a time, and degrades to `stackMetadataIncomplete` instead of failing the detail when a stack read breaks.\n\nStacked on #701.\n\n- [x] Paging with a cursor-advance guard\n- [x] Batched summaries for list rows\n- [ ] Retry on secondary rate limits (running in CI now)",
  704: "Top layer. Keyboard support for stacks:\n\n- `J` / `K` move to the layer below / above\n- `S` toggles the stack rail\n- neither fires while focus is inside the diff (from @mvogt's review on #703)\n\n- [x] Shortcuts\n- [ ] Show them in the shortcuts sheet\n- [ ] Head-SHA guard before merge-through (`expectedHeads`)",
  688: `Signs and notarizes the macOS DMG in the release workflow, and makes the PR dry run verify the notary credentials, so a broken secret fails here instead of on release day.

- \`apps/desktop/scripts/notarize.ts\` wraps \`@electron/notarize\` and checks the keychain profile first.
- \`release.yml\` imports the certificate, stores notary credentials, and notarizes and staples the DMG.
- \`release-dry-run.yml\` runs the same script with \`--dry-run\`.

### Before merging

- [x] Secrets added to the \`release\` environment
- [ ] Secrets added to \`release-dry-run\` (blocked on an org admin)
- [ ] One real release from a tag

\`\`\`sh
xcrun notarytool store-credentials ryco-notary --apple-id … --team-id … --password …
\`\`\``,
};

const LINKED_ISSUES: Readonly<Record<number, ReadonlyArray<number>>> = {
  703: [655],
  702: [655],
  701: [655],
  712: [640],
};

function bodyFor(spec: FixtureRowSpec): string {
  return (
    BODIES[spec.number] ??
    `${spec.title}.\n\nThis change is part of the regular ${spec.labels[0] ?? "maintenance"} work; see the commits for details.`
  );
}

function countTasks(body: string): number {
  return body.split("\n").filter((line) => /^\s*[-*] \[[ xX]\] /u.test(line)).length;
}

function rowHeadSha(spec: FixtureRowSpec): string {
  return fixtureSha(headShortFor(spec));
}

function rowStats(spec: FixtureRowSpec): {
  additions: number;
  deletions: number;
  changedFiles: number;
} {
  const patches = FIXTURE_PATCHES[spec.number];
  if (!patches) {
    return {
      additions: spec.additions,
      deletions: spec.deletions,
      changedFiles: spec.changedFiles,
    };
  }
  let additions = 0;
  let deletions = 0;
  for (const file of patches) {
    const stats = fileStats(file);
    additions += stats.additions;
    deletions += stats.deletions;
  }
  return { additions, deletions, changedFiles: patches.length };
}

function stackFor(number: number): SourceControlChangeRequestStack | null {
  const stack = FIXTURE_STACKS.find((candidate) =>
    (candidate.entries as ReadonlyArray<number>).includes(number),
  );
  if (!stack) return null;
  const entries = stack.entries.map((entryNumber, index) => {
    const spec = requireRowSpec(entryNumber);
    return {
      position: index + 1,
      number: entryNumber,
      title: spec.title,
      url: prUrl(entryNumber),
      headRefName: spec.headRefName,
      baseRefName: spec.baseRefName,
      state: spec.state,
      isDraft: spec.isDraft ?? false,
      mergeability: spec.mergeability,
      mergeStateStatus: spec.mergeStateStatus,
    };
  });
  return {
    number: stack.number,
    size: entries.length,
    position: (stack.entries as ReadonlyArray<number>).indexOf(number) + 1,
    baseRefName: stack.baseRefName,
    entries,
  };
}

function buildRow(spec: FixtureRowSpec): ChangeRequest {
  const stack = stackFor(spec.number);
  const stats = rowStats(spec);
  return {
    provider: "github",
    number: spec.number,
    title: spec.title,
    url: prUrl(spec.number),
    baseRefName: spec.baseRefName,
    headRefName: spec.headRefName,
    state: spec.state,
    updatedAt: Option.some(spec.updatedAt),
    isCrossRepository: false,
    isDraft: spec.isDraft ?? false,
    author: spec.author,
    assignees: spec.assignees,
    labels: spec.labels.map(label),
    commentsCount: spec.comments,
    headRepositoryNameWithOwner: FIXTURE_REPOSITORY,
    headRepositoryOwnerLogin: "ryco-labs",
    headSha: rowHeadSha(spec),
    mergeability: spec.mergeability,
    checkRollup: builtChecks(spec.number).rollup,
    ...(stack
      ? {
          stackSummary: {
            number: stack.number,
            size: stack.size,
            position: stack.position,
            baseRefName: stack.baseRefName,
          },
        }
      : {}),
    createdAt: spec.createdAt,
    reviewDecision: spec.reviewDecision,
    additions: stats.additions,
    deletions: stats.deletions,
    changedFiles: stats.changedFiles,
  };
}

/** List rows (all states), newest update first, as the host returns them. */
export const fixtureChangeRequests: ReadonlyArray<ChangeRequest> = ROW_SPECS.map(buildRow).toSorted(
  (left, right) =>
    Option.getOrElse(Option.map(right.updatedAt, DateTime.toEpochMillis), () => 0) -
    Option.getOrElse(Option.map(left.updatedAt, DateTime.toEpochMillis), () => 0),
);

const ROW_BY_NUMBER = new Map(fixtureChangeRequests.map((row) => [row.number, row]));

/** One list row; throws for numbers without a fixture. */
export function fixtureChangeRequest(number: number): ChangeRequest {
  const row = ROW_BY_NUMBER.get(number);
  if (!row) throw new Error(`No pull request fixture for #${number}.`);
  return row;
}

export function hasFixtureChangeRequest(number: number): boolean {
  return ROW_BY_NUMBER.has(number);
}

function reviewerStates(spec: FixtureRowSpec): ReadonlyArray<SourceControlChangeRequestReviewer> {
  return spec.reviewers.map(([login, state, submittedAt]) => ({
    login,
    kind: login.includes("/") ? "team" : FIXTURE_PEOPLE[login]?.bot ? "bot" : "user",
    state,
    ...(submittedAt ? { submittedAt } : {}),
    ...(login === "ryco-labs/web" ? { isCodeOwner: true } : {}),
  }));
}

function participants(number: number, spec: FixtureRowSpec) {
  const logins = new Set<string>([spec.author]);
  for (const [login] of spec.reviewers) if (!login.includes("/")) logins.add(login);
  for (const thread of threadsFor(number)) {
    for (const comment of thread.comments) logins.add(comment.author.login);
  }
  for (const item of timelineFor(number)) if (item.actor) logins.add(item.actor.login);
  return [...logins].map((login) => ({
    displayName: FIXTURE_PEOPLE[login]?.name ?? login,
    username: login,
  }));
}

function issueComments(number: number): ReadonlyArray<SourceControlIssueComment> {
  return timelineFor(number).flatMap((item): SourceControlIssueComment[] =>
    item.kind === "comment" && item.actor
      ? [
          {
            id: item.id,
            author: item.actor.login,
            body: item.body,
            createdAt: item.createdAt,
            ...(item.authorAssociation ? { authorAssociation: item.authorAssociation } : {}),
            ...(item.reactions ? { reactions: item.reactions } : {}),
          },
        ]
      : [],
  );
}

const detailCache = new Map<number, SourceControlChangeRequestDetail>();

/**
 * The `fullContent` detail. Hand-written for the detailed PRs, synthesized
 * (no files) for the rest. Throws for numbers without a list row.
 */
export function fixtureDetail(number: number): SourceControlChangeRequestDetail {
  const cached = detailCache.get(number);
  if (cached) return cached;
  const spec = requireRowSpec(number);
  const row = fixtureChangeRequest(number);
  const body = bodyFor(spec);
  const stack = stackFor(number);
  const files = patchesFor(number).map((file) => {
    const stats = fileStats(file);
    return { path: file.path, additions: stats.additions, deletions: stats.deletions };
  });
  const commits = commitSpecsFor(spec).map(
    ([short, headline, at]): SourceControlChangeRequestCommit => ({
      oid: fixtureSha(short),
      shortOid: short,
      messageHeadline: headline,
      committedDate: isoString(at),
      author: spec.author,
    }),
  );
  const states = reviewerStates(spec);
  const tasks = countTasks(body);
  const detail: SourceControlChangeRequestDetail = {
    ...row,
    body,
    comments: issueComments(number),
    truncated: false,
    ...(LINKED_ISSUES[number] ? { linkedIssueNumbers: LINKED_ISSUES[number] } : {}),
    reviewers: states.filter((reviewer) => reviewer.state === "requested").map((r) => r.login),
    participants: participants(number, spec),
    ...(tasks > 0 ? { tasksCount: tasks } : {}),
    commits,
    changedFiles: rowStats(spec).changedFiles,
    files,
    ...(stack ? { stack, stackMetadataIncomplete: false } : {}),
    mergeCapabilities: { merge: false, squash: true, rebase: true },
    reviewerStates: states,
    mergeStateStatus: spec.mergeStateStatus,
    autoMerge: spec.autoMerge ?? null,
    ...(spec.closedAt ? { closedAt: spec.closedAt } : {}),
    ...(spec.mergedAt ? { mergedAt: spec.mergedAt, closedAt: spec.mergedAt } : {}),
    ...(spec.mergedBy ? { mergedBy: spec.mergedBy } : {}),
    deleteBranchOnMerge: true,
  };
  detailCache.set(number, detail);
  return detail;
}

// ── Timeline ──────────────────────────────────────────────────────────

function at(id: string, actor: string | undefined, createdAt: DateTime.Utc) {
  return { id, createdAt, ...(actor ? { actor: fixtureActor(actor) } : {}) };
}

function commitItem(number: number, actor: string, spec: CommitSpec): ChangeRequestTimelineItem {
  const [short, headline, createdAt, check] = spec;
  return {
    id: `${number}-commit-${short}`,
    createdAt,
    actor: fixtureActor(actor),
    kind: "commit",
    oid: fixtureSha(short),
    shortOid: short,
    messageHeadline: headline,
    ...(check ? { checkState: check } : {}),
  };
}

function commitItems(number: number, actor: string): ReadonlyArray<ChangeRequestTimelineItem> {
  return (COMMIT_SPECS[number] ?? []).map((spec) => commitItem(number, actor, spec));
}

function comment(
  id: string,
  actor: string,
  createdAt: DateTime.Utc,
  body: string,
  options?: { readonly updatedAt?: DateTime.Utc; readonly reactions?: ReadonlyArray<ReactionSpec> },
): ChangeRequestTimelineItem {
  const own = actor === FIXTURE_VIEWER_LOGIN;
  return {
    ...at(id, actor, createdAt),
    kind: "comment",
    body,
    authorAssociation: authorAssociation(actor),
    ...(options?.updatedAt ? { updatedAt: options.updatedAt } : {}),
    url: `${FIXTURE_REPOSITORY_URL}/pull/${id.split("-")[0]}#issuecomment-${id}`,
    ...reactions(options?.reactions),
    viewerCanUpdate: own,
    viewerCanDelete: own,
  };
}

function review(
  id: string,
  actor: string,
  createdAt: DateTime.Utc,
  state: "approved" | "changes_requested" | "commented" | "dismissed",
  body: string,
  threadIds: ReadonlyArray<string>,
): ChangeRequestTimelineItem {
  return {
    ...at(id, actor, createdAt),
    kind: "review",
    state,
    body,
    authorAssociation: authorAssociation(actor),
    url: `${FIXTURE_REPOSITORY_URL}/pull/${id.split("-")[0]}#pullrequestreview-${id}`,
    threadIds,
    viewerCanUpdate: actor === FIXTURE_VIEWER_LOGIN,
  };
}

function labeled(
  id: string,
  actor: string,
  createdAt: DateTime.Utc,
  name: FixtureLabelName,
  kind: "labeled" | "unlabeled" = "labeled",
): ChangeRequestTimelineItem {
  return { ...at(id, actor, createdAt), kind, label: label(name) };
}

function requested(
  id: string,
  actor: string,
  createdAt: DateTime.Utc,
  reviewer: string,
  kind: "review-requested" | "review-request-removed" = "review-requested",
): ChangeRequestTimelineItem {
  return {
    ...at(id, actor, createdAt),
    kind,
    reviewer,
    reviewerKind: reviewer.includes("/") ? "team" : "user",
  };
}

const BUNDLE_COMMENT_703 = `### Bundle size

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

<sub>Updated for 8e5d1c6 · [details](https://github.com/ryco-labs/ryco/actions/runs/18214433871)</sub>`;

const BUNDLE_COMMENT_712 = `### Bundle size

| Entry | main | #712 | Δ |
| --- | ---: | ---: | ---: |
| \`web/index\` | 1,201.9 kB | 1,216.1 kB | +14.2 kB (+1.2%) |
| \`web/pull-requests\` | 38.2 kB | 41.0 kB | +2.8 kB (+7.3%) |

<details>
<summary>New dependencies</summary>

- \`@legendapp/list\` 3.0.0-beta.31 (+11.4 kB gzip)

</details>`;

function byTime(
  items: ReadonlyArray<ChangeRequestTimelineItem>,
): ReadonlyArray<ChangeRequestTimelineItem> {
  return items.toSorted(
    (left, right) =>
      DateTime.toEpochMillis(left.createdAt) - DateTime.toEpochMillis(right.createdAt),
  );
}

const TIMELINES: Readonly<Record<number, () => ReadonlyArray<ChangeRequestTimelineItem>>> = {
  703: () => [
    labeled("703-e1", "sak0a", d(4), "area:web"),
    labeled("703-e2", "sak0a", d(4), "stacks"),
    { ...at("703-e3", "sak0a", d(4)), kind: "assigned", assignee: "sak0a" },
    ...commitItems(703, "sak0a"),
    {
      ...at("703-e4", "sak0a", m(3 * 1440 + 110)),
      kind: "renamed",
      previousTitle: "Web: stack rail",
      currentTitle: "Web: stack layers rail and merge-through-layer",
    },
    { ...at("703-e5", "sak0a", m(3 * 1440 + 105)), kind: "ready-for-review" },
    requested("703-e6", "sak0a", m(3 * 1440 + 104), "mvogt"),
    requested("703-e7", "sak0a", m(3 * 1440 + 104), "eliotm"),
    review(
      "703-r1",
      "eliotm",
      m(3 * 1440 + 30),
      "commented",
      "Left two notes on the layer walk and the merge box.",
      ["703-t4", "703-t7"],
    ),
    {
      ...at("703-e8", "sak0a", d(2)),
      kind: "force-pushed",
      beforeOid: fixtureSha("e8d2c47"),
      afterOid: fixtureSha("19be4f7"),
    },
    {
      ...at("703-e9", "sak0a", m(2 * 1440 - 30)),
      kind: "cross-referenced",
      source: {
        kind: "change-request",
        number: 704,
        title: "Web: stack keyboard navigation (J/K between layers, S for the rail)",
        url: prUrl(704),
        repository: FIXTURE_REPOSITORY,
        state: "open",
      },
      willCloseTarget: false,
    },
    comment("703-ic1", "ryco-ci[bot]", m(2 * 1440 - 20), BUNDLE_COMMENT_703, { updatedAt: m(9) }),
    review("703-r2", "mvogt", m(1440 + 200), "commented", "", ["703-t3", "703-t5", "703-t6"]),
    comment(
      "703-ic2",
      "tkessler",
      m(1440 - 60),
      "Tried this against the sandbox repo with a 4-layer stack: merging through #2 landed both and GitHub retargeted #3 onto `main` within a couple of seconds. The rail updated on the next poll 🎉",
      {
        reactions: [
          ["thumbs-up", 2],
          ["hooray", 1, true],
        ],
      },
    ),
    review(
      "703-r3",
      "eliotm",
      m(190),
      "commented",
      "One a11y suggestion inline, otherwise this reads well.",
      ["703-t2", "703-t8"],
    ),
    review(
      "703-r4",
      "mvogt",
      m(52),
      "changes_requested",
      "The rail reads really well, and merge-through is exactly what I wanted from stacks. Two things before this goes in:\n\n1. the draft walk (inline), which is also why CI is red;\n2. J/K shouldn't move between layers while focus is inside a file in the diff. That probably belongs in #704, just flagging it.",
      ["703-t1"],
    ),
  ],
  712: () => [
    ...commitItems(712, "mvogt").slice(0, 2),
    labeled("712-e1", "mvogt", d(2), "perf"),
    labeled("712-e2", "mvogt", d(2), "area:web"),
    { ...at("712-e3", "mvogt", d(2)), kind: "assigned", assignee: "mvogt" },
    requested("712-e4", "mvogt", d(2), "sak0a"),
    requested("712-e5", "mvogt", d(2), "eliotm"),
    requested("712-e6", "mvogt", d(2), "ryco-labs/web"),
    comment("712-ic1", "ryco-ci[bot]", m(2 * 1440 - 15), BUNDLE_COMMENT_712, { updatedAt: m(14) }),
    ...commitItems(712, "mvogt").slice(2),
    comment(
      "712-ic2",
      "mvogt",
      m(1440 - 30),
      "Recording of the 3k-line diff before/after is in the Linear issue. Scrolling now stays at 120 fps on the M5 and the sticky header doesn't jump at file boundaries anymore.",
      {
        reactions: [
          ["rocket", 3, true],
          ["eyes", 1],
        ],
      },
    ),
    review(
      "712-r1",
      "eliotm",
      hr(20),
      "commented",
      "Nice speedup. Two questions inline. The keys one matters once expansion lands.",
      ["712-t1", "712-t2"],
    ),
  ],
  701: () => [
    ...commitItems(701, "sak0a"),
    labeled("701-e1", "sak0a", d(5), "contracts"),
    labeled("701-e2", "sak0a", d(5), "stacks"),
    requested("701-e3", "sak0a", d(5), "mvogt"),
    requested("701-e4", "sak0a", d(5), "tkessler"),
    review("701-r1", "tkessler", d(4), "commented", "", ["701-t1"]),
    comment(
      "701-ic1",
      "sak0a",
      m(3 * 1440 - 20),
      "Stacked on top of this: #702 → #703 → #704. Merging this one alone is safe; nothing reads the new fields until #702.",
    ),
    { ...at("701-e5", "sak0a", hr(5)), kind: "auto-merge-enabled", mergeMethod: "squash" },
    review("701-r2", "mvogt", hr(4), "approved", "", []),
    review(
      "701-r3",
      "tkessler",
      hr(3),
      "approved",
      "LGTM. Making the decoder strict about the merge states is the right call.",
      [],
    ),
    { ...at("701-e6", "sak0a", m(170)), kind: "auto-merge-disabled", mergeMethod: "squash" },
    comment(
      "701-ic2",
      "sak0a",
      m(168),
      "Turned auto-merge off again: I'd rather land #701 → #703 together with a stack merge once #703 is green.",
    ),
  ],
  702: () => [
    labeled("702-e1", "sak0a", d(5), "area:server"),
    labeled("702-e2", "sak0a", d(5), "stacks"),
    labeled("702-e3", "sak0a", d(5), "needs-design"),
    requested("702-e4", "sak0a", d(5), "tkessler"),
    requested("702-e5", "sak0a", d(5), "eliotm"),
    requested("702-e6", "sak0a", d(5), "anouk-d"),
    ...commitItems(702, "sak0a"),
    {
      ...at("702-e7", "sak0a", m(3 * 1440 - 5)),
      kind: "base-ref-changed",
      previousRefName: "main",
      currentRefName: "ryco/stack-1-contracts",
    },
    labeled("702-e8", "sak0a", m(3 * 1440 - 4), "needs-design", "unlabeled"),
    requested("702-e9", "sak0a", m(3 * 1440 - 3), "anouk-d", "review-request-removed"),
    review(
      "702-r1",
      "eliotm",
      hr(26),
      "commented",
      "Read through the paging and it looks right. One question inline.",
      ["702-t1"],
    ),
  ],
  704: () => [
    labeled("704-e1", "sak0a", d(2), "area:web"),
    labeled("704-e2", "sak0a", d(2), "stacks"),
    ...commitItems(704, "sak0a"),
    { ...at("704-e3", "sak0a", m(1440 - 10)), kind: "ready-for-review" },
    { ...at("704-e4", "sak0a", m(1440 - 12)), kind: "converted-to-draft" },
    { ...at("704-e5", "sak0a", hr(2)), kind: "assigned", assignee: "mvogt" },
    { ...at("704-e6", "sak0a", hr(2)), kind: "unassigned", assignee: "mvogt" },
  ],
  688: () => [
    ...commitItems(688, "jonasw"),
    labeled("688-e1", "jonasw", d(2), "area:desktop"),
    labeled("688-e2", "jonasw", d(2), "release"),
    requested("688-e3", "jonasw", d(2), "anouk-d"),
    requested("688-e4", "jonasw", d(2), "tkessler"),
    review(
      "688-r1",
      "tkessler",
      m(1440 + 30),
      "dismissed",
      "Looks good — the profile check makes the failure obvious.",
      [],
    ),
    {
      ...at("688-e5", "github-actions[bot]", m(1440 - 10)),
      kind: "review-dismissed",
      reviewAuthor: "tkessler",
      message: "Stale approval dismissed after new commits were pushed.",
    },
    review(
      "688-r2",
      "anouk-d",
      hr(20),
      "commented",
      "The dry run needs a guard for forks; see inline.",
      ["688-t1"],
    ),
    {
      ...at("688-e6", "sak0a", hr(18)),
      kind: "cross-referenced",
      source: {
        kind: "issue",
        number: 612,
        title: "macOS: Gatekeeper warns on first launch",
        url: `${FIXTURE_REPOSITORY_URL}/issues/612`,
        repository: FIXTURE_REPOSITORY,
        state: "open",
      },
      willCloseTarget: false,
    },
  ],
  690: () => [
    {
      ...at("690-commit", "sak0a", d(3)),
      kind: "commit",
      oid: fixtureSha(headShortFor(requireRowSpec(690))),
      shortOid: headShortFor(requireRowSpec(690)),
      messageHeadline: "Inbox: settle animation respects reduced motion",
      checkState: "success",
    },
    labeled("690-e1", "sak0a", d(3), "area:web"),
    requested("690-e2", "sak0a", d(3), "mvogt"),
    { ...at("690-e3", "sak0a", m(1440 + 40)), kind: "auto-merge-enabled", mergeMethod: "squash" },
    review(
      "690-r1",
      "mvogt",
      m(1440 + 30),
      "approved",
      "Checked with Reduce Motion on; settles instantly.",
      [],
    ),
    {
      ...at("690-e4", "sak0a", d(1)),
      kind: "merged",
      commitOid: fixtureSha("9a1c4e7"),
      baseRefName: "main",
    },
    { ...at("690-e5", "github-actions[bot]", m(1440 - 1)), kind: "head-ref-deleted" },
  ],
  683: () => [
    {
      ...at("683-commit", "sak0a", d(11)),
      kind: "commit",
      oid: fixtureSha(headShortFor(requireRowSpec(683))),
      shortOid: headShortFor(requireRowSpec(683)),
      messageHeadline: "Try framer-motion for split panes",
    },
    labeled("683-e1", "sak0a", d(11), "area:web"),
    labeled("683-e2", "sak0a", d(11), "needs-design"),
    labeled("683-e3", "sak0a", d(11), "perf"),
    labeled("683-e4", "sak0a", d(10), "perf", "unlabeled"),
    { ...at("683-e5", "sak0a", d(9)), kind: "closed" },
    { ...at("683-e6", "sak0a", d(9)), kind: "head-ref-deleted" },
    { ...at("683-e7", "sak0a", d(8)), kind: "head-ref-restored" },
    { ...at("683-e8", "sak0a", d(8)), kind: "reopened" },
    comment(
      "683-ic1",
      "sak0a",
      m(6 * 1440 + 10),
      "Closing for real: framer-motion adds 38 kB for one transition we can do with view transitions.",
    ),
    { ...at("683-e9", "sak0a", d(6)), kind: "closed" },
    { ...at("683-e10", "sak0a", d(6)), kind: "unassigned", assignee: "sak0a" },
  ],
};

const timelineCache = new Map<number, ReadonlyArray<ChangeRequestTimelineItem>>();
function timelineFor(number: number): ReadonlyArray<ChangeRequestTimelineItem> {
  const cached = timelineCache.get(number);
  if (cached) return cached;
  const spec = requireRowSpec(number);
  const build = TIMELINES[number];
  const timeline = byTime(
    build
      ? build()
      : [
          {
            ...at(`${number}-commit`, spec.author, spec.createdAt),
            kind: "commit",
            oid: rowHeadSha(spec),
            shortOid: headShortFor(spec),
            messageHeadline: spec.title,
          },
          ...spec.labels.map((name, index) =>
            labeled(`${number}-label-${index}`, spec.author, spec.createdAt, name),
          ),
        ],
  );
  timelineCache.set(number, timeline);
  return timeline;
}

function viewerCapabilities(spec: FixtureRowSpec): ChangeRequestViewerCapabilities {
  const open = spec.state === "open";
  return {
    login: FIXTURE_VIEWER_LOGIN,
    isAuthor: spec.author === FIXTURE_VIEWER_LOGIN,
    canUpdate: true,
    canMerge: open,
    canReview: open,
    canUpdateBranch: open && spec.mergeStateStatus === "behind",
    canEnableAutoMerge: open && spec.autoMerge === undefined,
    canDisableAutoMerge: open && spec.autoMerge !== undefined,
  };
}

const activityCache = new Map<number, ChangeRequestActivity>();

/** Timeline (oldest first), review threads, and viewer capabilities. */
export function fixtureActivity(number: number): ChangeRequestActivity {
  const cached = activityCache.get(number);
  if (cached) return cached;
  const spec = requireRowSpec(number);
  const activity: ChangeRequestActivity = {
    provider: "github",
    number,
    headSha: rowHeadSha(spec),
    viewer: viewerCapabilities(spec),
    timeline: timelineFor(number),
    timelineTruncated: false,
    reviewThreads: threadsFor(number),
    reviewThreadsTruncated: false,
    pendingReview: number === 712 ? { id: "712-pending-review", commentsCount: 1 } : null,
  };
  activityCache.set(number, activity);
  return activity;
}

// ── Workflow runs / jobs / logs ───────────────────────────────────────

/** What `useSourceControlWorkflowRuns({ pullRequestNumber })` returns: head runs first, then older ones. */
export function fixtureWorkflowRuns(number: number): SourceControlWorkflowRunListResult {
  const spec = requireRowSpec(number);
  const checks = builtChecks(number);
  return {
    provider: "github",
    repository: Option.some(FIXTURE_REPOSITORY),
    pullRequestNumber: Option.some(number),
    headSha: Option.some(rowHeadSha(spec)),
    runs: [...checks.runs, ...checks.history].map((built) => built.run),
  };
}

export function fixtureWorkflowRunJobs(runId: string): SourceControlWorkflowRunJobsResult {
  indexRuns();
  const entry = runIndex.get(runId);
  return {
    provider: "github",
    runId,
    jobs: entry ? entry.built.jobs.map((built) => built.job) : [],
  };
}

export function fixtureWorkflowJobLog(
  runId: string,
  jobIdValue: string,
): SourceControlWorkflowJobLogResult {
  indexRuns();
  const job = runIndex.get(runId)?.built.jobs.find((built) => built.job.jobId === jobIdValue);
  return { provider: "github", runId, jobId: jobIdValue, log: job?.log ?? "", truncated: false };
}

/** The failing job of #703 and the diff line its log points at. */
export const FIXTURE_703_FAILING_JOB = {
  runId: "18214433871",
  jobId: jobId(18214433871, "test-web"),
  name: "Test · web",
  workflowName: "CI",
  path: LAYERS_TEST,
  line: 40,
} as const;

/** The failing job of #688 (Release dry run). */
export const FIXTURE_688_FAILING_JOB = {
  runId: "18214380021",
  jobId: jobId(18214380021, "desktop-mac"),
  name: "Desktop · macOS arm64",
  workflowName: "Release dry run",
  path: "apps/desktop/scripts/notarize.ts",
  line: 31,
} as const;

// ── Files viewed ──────────────────────────────────────────────────────

/**
 * Viewed state per file: the lab's marks, with files the viewer had viewed
 * but the head commit touched again reported as `stale`.
 */
export function fixtureFilesViewed(number: number): SourceControlChangeRequestFilesViewed {
  const spec = requireRowSpec(number);
  const head = headShortFor(spec);
  return {
    provider: "github",
    capability: { storage: "host" },
    headSha: rowHeadSha(spec),
    files: patchesFor(number).map((file) => ({
      path: file.path,
      state:
        file.viewed === "viewed" ? (file.commits.includes(head) ? "stale" : "viewed") : "unviewed",
    })),
  };
}

/** Every timeline kind the fixtures cover (all kinds in the contract). */
export function fixtureTimelineKinds(): ReadonlySet<ChangeRequestTimelineItem["kind"]> {
  const kinds = new Set<ChangeRequestTimelineItem["kind"]>();
  for (const spec of ROW_SPECS) for (const item of timelineFor(spec.number)) kinds.add(item.kind);
  return kinds;
}
