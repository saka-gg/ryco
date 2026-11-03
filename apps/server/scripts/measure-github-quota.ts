/**
 * GitHub GraphQL points one node spends in a simulated hour on what it polls by itself, by source.
 *   node apps/server/scripts/measure-github-quota.ts            (this branch)
 *   node apps/server/scripts/measure-github-quota.ts --baseline (rows read in full, as before)
 *   add --quiet for the same node with no CI running and nothing updated for days
 *
 * The node: 10 open pull requests across 3 repositories (4, 3, 3), each one a visible sidebar
 * row whose window is in the foreground, 3 of them with CI running (6 checks finishing four
 * minutes apart, two of them again after a push at minutes 30 and 35, so checks run for most of
 * the hour), one watched (`watch_pull_request`),
 * and one thread focused (its checkout's full status refreshes the repository every 30 s; agent
 * turns finish at minutes 15 and 45). Someone comments on a pull request at minute 30, and the
 * user comments through Ryco at minute 50.
 *
 * Simulated through the real code, on a virtual clock: every row's poll (30 s, ±8 % jitter, the
 * web client's cadence) runs the row read the RPC runs (`repositoryListCache` with its 10 s row
 * TTL, `changeRequestRowRevalidation`, `GitHubSourceControlProvider`, `GitHubCli` and its
 * fingerprint board) against a scripted `gh`, and the watch asks for its fingerprint every two
 * minutes as its sweep does. `--baseline` drops the revalidation, which is main's row read.
 *
 * Points: GitHub charges a GraphQL query the connections it asks for divided by 100, at least
 * one (docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api).
 * Every document here asks for fewer than 150, so each costs one point: `gh pr view` (about a
 * dozen first-100 connections), the stack and required-check reads, and a fingerprint document
 * (five connections per pull request, 25 pull requests at most). The merge-settings read is REST,
 * which has its own budget. Sources this branch does not change are listed from their production
 * cadences (`measure-pr-watch-reads.ts` for the watch's detail reads). Prints Markdown.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { SourceControlChangeRequestDetail } from "@ryco/contracts";
import { Clock, Effect, Layer, ManagedRuntime, Option } from "effect";
import { ChildProcessSpawner } from "effect/process";

import { makeChangeRequestRowRevalidation } from "../src/sourceControl/changeRequestRowRevalidation.ts";
import * as GitHubCli from "../src/sourceControl/GitHubCli.ts";
import * as GitHubSourceControlProvider from "../src/sourceControl/GitHubSourceControlProvider.ts";
import { makeRepositoryListCache } from "../src/sourceControl/repositoryListCache.ts";
import type { SourceControlProviderShape } from "../src/sourceControl/SourceControlProvider.ts";
import * as VcsProcess from "../src/vcs/VcsProcess.ts";
import { CHANGE_REQUEST_ROW_DETAIL_CACHE_TTL_MS } from "../src/ws/sourceControlRpc.ts";

const baseline = process.argv.includes("--baseline");
const quietNode = process.argv.includes("--quiet");
const MINUTE = 60_000;
const HOUR_MS = 60 * MINUTE;
const START_MS = Date.parse("2026-10-30T12:00:00Z");
const ROW_POLL_MS = 30_000;
const ROW_POLL_JITTER = 0.08;
const FOCUSED_REFRESH_MS = 30_000;
const WATCH_SWEEP_MS = 2 * MINUTE;

// ── The scripted host ───────────────────────────────────────────────────

interface ScriptedPullRequest {
  readonly repo: string;
  readonly number: number;
  /** Minutes (from the start) at which each of its CI's checks finish, per head. */
  readonly runs: ReadonlyArray<{ readonly fromMinute: number; readonly finishes: number[] }>;
  readonly createdUpdatedAt: number;
  readonly commentsAt: ReadonlyArray<number>;
}

const at = (minute: number) => START_MS + minute * MINUTE;
const ciRun = (fromMinute: number, offset: number) => ({
  fromMinute,
  finishes: [1, 2, 3, 4, 5, 6].map((check) => fromMinute + offset + 4 * check),
});
const quiet = (repo: string, number: number, commentsAt: number[] = []): ScriptedPullRequest => ({
  repo,
  number,
  runs: [{ fromMinute: -3_000, finishes: [-2_990, -2_990, -2_990] }],
  createdUpdatedAt: at(-2 * 24 * 60),
  commentsAt,
});
const busyPullRequests: ReadonlyArray<ScriptedPullRequest> = [
  {
    repo: "web",
    number: 1,
    runs: [ciRun(-5, 0), ciRun(35, 0)],
    createdUpdatedAt: at(-5),
    commentsAt: [],
  },
  quiet("web", 2, [30]),
  quiet("web", 3, [50]),
  quiet("web", 4),
  {
    repo: "api",
    number: 11,
    runs: [ciRun(-5, 2), ciRun(30, 2)],
    createdUpdatedAt: at(-5),
    commentsAt: [],
  },
  quiet("api", 12),
  quiet("api", 13),
  { repo: "docs", number: 21, runs: [ciRun(-5, 4)], createdUpdatedAt: at(-5), commentsAt: [] },
  quiet("docs", 22),
  quiet("docs", 23),
];
const pullRequests = quietNode
  ? busyPullRequests.map((pr) => quiet(pr.repo, pr.number, pr.commentsAt.slice()))
  : busyPullRequests;
const WATCHED = pullRequests[0]!;
const FOCUSED_REPO = "web";

let nowMs = START_MS;
const iso = (ms: number) => new Date(ms).toISOString();

/** What GitHub reports for a pull request at `t`. */
function truth(pr: ScriptedPullRequest, t: number) {
  const runs = pr.runs.filter((run) => at(run.fromMinute) <= t);
  const run = runs.at(-1)!;
  const head = `${pr.repo}-${pr.number}-head-${runs.length}`;
  const checks = run.finishes.map((finish, index) => ({
    name: `check-${index + 1}`,
    done: at(finish) <= t,
    // The api pull request's last check fails.
    failed: pr.number === 11 && index === run.finishes.length - 1,
  }));
  const comments = pr.commentsAt.filter((minute) => at(minute) <= t);
  const updatedAt = Math.max(
    pr.createdUpdatedAt,
    ...runs.map((entry) => at(entry.fromMinute)),
    ...comments.map(at),
  );
  return { head, checks, comments: 1 + comments.length, updatedAt };
}

/** What a row shows of it: head, check results, comments and title edits. */
const rowSignature = (detail: {
  readonly headSha?: string | undefined;
  readonly checkRollup?: ReadonlyArray<{ readonly conclusion: Option.Option<string> }> | undefined;
  readonly comments: ReadonlyArray<unknown>;
}) =>
  [
    detail.headSha ?? "",
    (detail.checkRollup ?? []).map((check) => Option.getOrElse(check.conclusion, () => "-")),
    detail.comments.length,
  ].join(" ");

const truthSignature = (pr: ScriptedPullRequest, t: number) => {
  const now = truth(pr, t);
  return [
    now.head,
    now.checks.map((check) => (!check.done ? "-" : check.failed ? "FAILURE" : "SUCCESS")),
    now.comments,
  ].join(" ");
};

/** When the row-visible state last changed at or before `t`. */
function changedAt(pr: ScriptedPullRequest, t: number) {
  const times = [
    ...pr.runs.flatMap((run) => [at(run.fromMinute), ...run.finishes.map(at)]),
    ...pr.commentsAt.map(at),
  ].filter((time) => time <= t);
  return Math.max(START_MS, ...times);
}

const find = (repo: string, number: number) =>
  pullRequests.find((pr) => pr.repo === repo && pr.number === number)!;

const calls = { prView: 0, stack: 0, requiredChecks: 0, fingerprints: 0, rest: 0 };
let fingerprintedPullRequests = 0;

const output = (body: unknown): VcsProcess.VcsProcessOutput => ({
  exitCode: ChildProcessSpawner.ExitCode(0),
  stdout: JSON.stringify(body),
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
});

function prView(repo: string, number: number) {
  const pr = find(repo, number);
  const now = truth(pr, nowMs);
  return {
    number,
    title: `Change ${number}`,
    url: `https://github.com/acme/${repo}/pull/${number}`,
    baseRefName: "main",
    headRefName: `feature/${number}`,
    headRefOid: now.head,
    mergeable: "MERGEABLE",
    state: "OPEN",
    mergedAt: null,
    updatedAt: iso(now.updatedAt),
    isDraft: false,
    isCrossRepository: false,
    headRepository: null,
    headRepositoryOwner: null,
    body: "Body",
    comments: Array.from({ length: now.comments }, (_, index) => ({
      author: { login: "octo" },
      body: `Comment ${index + 1}`,
      createdAt: iso(START_MS - MINUTE),
    })),
    statusCheckRollup: now.checks.map((check) => ({
      __typename: "CheckRun",
      name: check.name,
      status: check.done ? "COMPLETED" : "IN_PROGRESS",
      conclusion: check.done ? (check.failed ? "FAILURE" : "SUCCESS") : "",
    })),
  };
}

function fingerprintNode(repo: string, number: number) {
  const now = truth(find(repo, number), nowMs);
  const counts = new Map<string, number>();
  for (const check of now.checks) {
    const state = !check.done ? "IN_PROGRESS" : check.failed ? "FAILURE" : "SUCCESS";
    counts.set(state, (counts.get(state) ?? 0) + 1);
  }
  return {
    state: "OPEN",
    isDraft: false,
    updatedAt: iso(now.updatedAt),
    mergeable: "MERGEABLE",
    headRefOid: now.head,
    comments: { totalCount: now.comments, nodes: [{ updatedAt: iso(now.updatedAt) }] },
    reviews: { totalCount: 0, nodes: [] },
    reviewThreads: { totalCount: 0 },
    commits: {
      nodes: [
        {
          commit: {
            statusCheckRollup: {
              contexts: {
                checkRunCountsByState: [...counts].map(([state, count]) => ({ state, count })),
                statusContextCountsByState: [],
              },
            },
          },
        },
      ],
    },
  };
}

const flag = (args: ReadonlyArray<string>, name: string) =>
  args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1) ?? "";

const run: VcsProcess.VcsProcessShape["run"] = (input) =>
  Effect.sync(() => {
    const args = input.args;
    const repo = input.cwd.split("/").at(-1)!;
    if (args[0] === "pr" && args[1] === "view") {
      calls.prView += 1;
      return output(prView(repo, Number(args[2])));
    }
    if (args[0] === "api" && args[1] === "graphql" && args.includes("--input")) {
      const body = JSON.parse(input.stdin ?? "{}") as {
        readonly query: string;
        readonly variables: Record<string, string | number>;
      };
      if (!body.query.includes("PullRequestWatchFingerprints")) throw new Error(body.query);
      calls.fingerprints += 1;
      const data: Record<string, unknown> = {};
      for (let index = 0; `p${index}` in body.variables; index += 1) {
        fingerprintedPullRequests += 1;
        data[`w${index}`] = {
          pullRequest: fingerprintNode(
            String(body.variables[`n${index}`]),
            Number(body.variables[`p${index}`]),
          ),
        };
      }
      return output({ data });
    }
    if (args[0] === "api" && args[1] === "graphql") {
      const query = flag(args, "query");
      if (query.includes("stackEntry")) {
        calls.stack += 1;
        return output({ data: { repository: { pullRequest: { stackEntry: null, stack: null } } } });
      }
      if (query.includes("isRequired")) {
        calls.requiredChecks += 1;
        return output({
          data: {
            repository: {
              object: {
                statusCheckRollup: {
                  contexts: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
                },
              },
            },
          },
        });
      }
    }
    if (args[0] === "api") {
      calls.rest += 1;
      return output({
        allow_merge_commit: true,
        allow_squash_merge: true,
        allow_rebase_merge: true,
      });
    }
    throw new Error(`The scripted gh does not answer ${args.join(" ")}`);
  });

// ── The node ────────────────────────────────────────────────────────────

const clock: Clock.Clock = {
  currentTimeMillisUnsafe: () => nowMs,
  currentTimeMillis: Effect.sync(() => nowMs),
  currentTimeNanosUnsafe: () => BigInt(nowMs) * 1_000_000n,
  currentTimeNanos: Effect.sync(() => BigInt(nowMs) * 1_000_000n),
  monotonicTimeNanosUnsafe: () => BigInt(nowMs) * 1_000_000n,
  monotonicTimeNanos: Effect.sync(() => BigInt(nowMs) * 1_000_000n),
  // The batch window: no reader is waiting on another here, so nothing to wait for.
  sleep: () => Effect.yieldNow,
};

const runtime = ManagedRuntime.make(
  Layer.mergeAll(
    GitHubCli.layer.pipe(Layer.provide(Layer.mock(VcsProcess.VcsProcess)({ run }))),
    NodeServices.layer,
  ),
);
const provider: SourceControlProviderShape = await runtime.runPromise(
  GitHubSourceControlProvider.make(),
);
const exec = <A, E>(effect: Effect.Effect<A, E>) =>
  runtime.runPromise(effect.pipe(Effect.provideService(Clock.Clock, clock)));

const listCache = makeRepositoryListCache({ nowMs: () => nowMs });

const rows = makeChangeRequestRowRevalidation();

/** The RPC's row read (`sourceControlGetChangeRequestDetail` with `view: "row"`). */
const readRow = (pr: ScriptedPullRequest) => {
  const cwd = `/repos/${pr.repo}`;
  const reference = String(pr.number);
  const key = JSON.stringify(["changeRequestDetail", reference, false]);
  const load = provider.getChangeRequestDetail({ cwd, reference });
  return listCache.get({
    repository: pr.repo,
    key,
    load,
    ttlMs: CHANGE_REQUEST_ROW_DETAIL_CACHE_TTL_MS,
    lastGood: true,
    ...(baseline
      ? {}
      : {
          revalidate: (changes) =>
            rows.read({ cwd, key, changes, load, provider: Effect.succeed(provider) }),
        }),
  });
};

// Deterministic jitter.
let seed = 0x9e3779b9;
const random = () => {
  seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;
  return seed / 2 ** 32;
};

type Event =
  | { readonly at: number; readonly kind: "row"; readonly pr: ScriptedPullRequest }
  | {
      readonly at: number;
      readonly kind: "poll" | "turn" | "mutation";
      readonly repo: string;
    }
  | { readonly at: number; readonly kind: "watch" };
const events: Event[] = [];
for (const pr of pullRequests) {
  for (let t = START_MS + random() * 1_000; t < START_MS + HOUR_MS;) {
    events.push({ at: t, kind: "row", pr });
    t += ROW_POLL_MS * (1 - ROW_POLL_JITTER + 2 * ROW_POLL_JITTER * random());
  }
}
for (let t = START_MS; t < START_MS + HOUR_MS; t += FOCUSED_REFRESH_MS) {
  events.push({ at: t + 500, kind: "poll", repo: FOCUSED_REPO });
}
for (const minute of [15, 45]) events.push({ at: at(minute), kind: "turn", repo: FOCUSED_REPO });
events.push({ at: at(50) + 1, kind: "mutation", repo: "web" });
for (let t = START_MS + 30_000; t < START_MS + HOUR_MS; t += WATCH_SWEEP_MS) {
  events.push({ at: t, kind: "watch" });
}
events.sort((left, right) => left.at - right.at);

const lags: number[] = [];
let polls = 0;
for (const event of events) {
  nowMs = event.at;
  if (event.kind === "poll" || event.kind === "turn") {
    // What `invalidateRemoteStatus` does for the focused checkout's poll and after a turn.
    await exec(
      listCache.invalidate(
        event.repo,
        baseline ? {} : { revalidate: event.kind === "poll" ? "reuse" : "fresh" },
      ),
    );
  } else if (event.kind === "mutation") {
    await exec(listCache.invalidate(event.repo));
  } else if (event.kind === "watch") {
    // The sweep asks once per pass; the detail reads it gates are unchanged here.
    await exec(
      provider.getChangeRequestWatchFingerprint!({
        cwd: `/repos/${WATCHED.repo}`,
        number: WATCHED.number,
        url: `https://github.com/acme/${WATCHED.repo}/pull/${WATCHED.number}`,
        ...(baseline ? {} : { reuseSinceMs: nowMs }),
      }),
    );
  } else if (event.kind === "row") {
    polls += 1;
    const detail = (await exec(readRow(event.pr))) as SourceControlChangeRequestDetail;
    if (rowSignature(detail) !== truthSignature(event.pr, nowMs)) {
      lags.push(nowMs - changedAt(event.pr, nowMs));
    }
  }
}
await runtime.dispose();

// ── Report ──────────────────────────────────────────────────────────────

const rowsGraphQl = calls.prView + calls.stack + calls.requiredChecks + calls.fingerprints;
// Unchanged sources, from production cadences: the change request index (summary list, 60 s
// TTL, one per repository with a status subscriber), the focused thread's detail (30 s:
// `pr view`, stack, required checks), the linked-workspace sweep (one batched state read per
// repository every 5 min), and the watch's detail and activity reads (`measure-pr-watch-reads.ts`
// scenario (b): 12 detail reads of 3 points, 3 activity reads of 2).
const unchanged = [
  { source: "Sidebar status: change request index (3 repositories, 60 s)", points: 3 * 60 },
  { source: "Focused thread's pull request detail (30 s, 3 documents)", points: 120 * 3 },
  { source: "Linked-workspace sweep (3 repositories, 5 min)", points: 3 * 12 },
  { source: "Watch: detail and activity reads (scenario (b))", points: 12 * 3 + 3 * 2 },
];
const sorted = lags.toSorted((left, right) => left - right);
const seconds = (ms: number | undefined) => (ms === undefined ? "-" : `${Math.round(ms / 1000)} s`);

console.log(
  `GitHub GraphQL points in one simulated hour (${baseline ? "baseline: rows read in full" : "this branch"}${quietNode ? ", quiet node" : ""}):\n`,
);
console.log("| Source | GraphQL documents | points | REST requests |");
console.log("| --- | ---: | ---: | ---: |");
console.log(
  `| Sidebar rows and the watch's fingerprint (simulated): \`pr view\` ${calls.prView}, stack ${calls.stack}, required checks ${calls.requiredChecks}, fingerprint documents ${calls.fingerprints} (${fingerprintedPullRequests} pull requests) | ${rowsGraphQl} | ${rowsGraphQl} | ${calls.rest} |`,
);
for (const row of unchanged) console.log(`| ${row.source} | ${row.points} | ${row.points} | - |`);
const total = rowsGraphQl + unchanged.reduce((sum, row) => sum + row.points, 0);
console.log(`| **Total** | | **${total}** | |`);
console.log(
  `\nRow polls: ${polls}; polls that showed an older state than GitHub's: ${lags.length} (median ${seconds(sorted[Math.floor(sorted.length / 2)])}, max ${seconds(sorted.at(-1))} behind).`,
);
