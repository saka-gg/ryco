/**
 * Background GitHub read load through the real provider stack, over gh or the direct API.
 * Run with Node; it never talks to the real GitHub:
 *
 *   node apps/server/scripts/bench-github-transport.ts --transport cli --repos 12 --out /tmp/cli.json
 *   node apps/server/scripts/bench-github-transport.ts --transport api --repos 12 --out /tmp/api.json
 *   node apps/server/scripts/bench-github-transport.ts --compare /tmp/cli.json /tmp/api.json
 *   node apps/server/scripts/bench-github-transport.ts --measure-real-gh
 *
 * A local fake GitHub (`gitHubApiTestServer`) answers every request after `--latency-ms`. A `gh`
 * shim (a Node script first on PATH) implements the subset Ryco runs by forwarding to it and logs
 * each invocation's subcommand, wall time and CPU time. The stack is production's:
 * `VcsProcess.layer` (governed by the process governor), `GitHubCli` and
 * `GitHubSourceControlProvider`, with `GitHubCli.layer` (gh only) or `GitHubCli.layerDirectApi`.
 *
 * Workload per repository, all in the background lane, cadences from the production constants:
 * - status poll every AUTOMATIC_DISCOVERY_REFRESH_MS: the change request index (`read("all")`,
 *   its own 60 s TTL) plus two PR-less branch lookups (`readBranch`, their own TTLs);
 * - a link-state sweep every WORKTREE_PULL_REQUEST_DISCOVERY_INTERVAL_MS: 40 pull requests and
 *   10 issues in one `getLinkStates`, plus two `getPullRequestState` (manual links);
 * - `--rows` inbox rows: active ones (1 - `--settled-share`) read `getChangeRequestDetail`
 *   (`gh pr view` + stack + merge settings + required checks + reactions) every
 *   AUTOMATIC_ACTIVE_REFRESH_MS through a CHANGE_REQUEST_ROW_DETAIL_CACHE_TTL_MS shared cache.
 * An interactive probe reads one link state every 2 s. Exact queue waits come from wrapping
 * `ProcessPool.prototype.request` (every admission, zero waits included).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer, ManagedRuntime } from "effect";
import { FetchHttpClient } from "effect/http";

import {
  ProcessPool,
  inBackgroundProcessLane,
  processGovernorStats,
} from "../src/processGovernor.ts";
import * as GitHubCli from "../src/sourceControl/GitHubCli.ts";
import * as GitHubSourceControlProvider from "../src/sourceControl/GitHubSourceControlProvider.ts";
import {
  startFakeGitHub,
  type FakeGitHubRequest,
} from "../src/sourceControl/gitHubApiTestServer.ts";
import {
  makePullRequestIndex,
  pullRequestIndexRepositoryKey,
} from "../src/sourceControl/pullRequestIndex.ts";
import { WORKTREE_PULL_REQUEST_DISCOVERY_INTERVAL_MS } from "../src/sourceControl/refreshWorktreeSourceControlState.ts";
import { CHANGE_REQUEST_ROW_DETAIL_CACHE_TTL_MS } from "../src/ws/sourceControlRpc.ts";
import * as VcsProcess from "../src/vcs/VcsProcess.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    transport: { type: "string", default: "cli" },
    repos: { type: "string", default: "12" },
    rows: { type: "string", default: "8" },
    "settled-share": { type: "string", default: "0.5" },
    minutes: { type: "string", default: "2" },
    "latency-ms": { type: "string", default: "80" },
    "list-size": { type: "string", default: "30" },
    label: { type: "string" },
    out: { type: "string" },
    compare: { type: "boolean", default: false },
    "measure-real-gh": { type: "boolean", default: false },
  },
});

const round = (value: number) => Math.round(value * 10) / 10;
const quantile = (sorted: ReadonlyArray<number>, q: number) =>
  sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
const summary = (samples: ReadonlyArray<number>) => {
  const sorted = samples.toSorted((a, b) => a - b);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    count: sorted.length,
    mean: round(sorted.length === 0 ? 0 : total / sorted.length),
    p50: round(quantile(sorted, 0.5)),
    p95: round(quantile(sorted, 0.95)),
    max: round(sorted.at(-1) ?? 0),
  };
};

// ── --compare / --measure-real-gh ─────────────────────────────────────

if (values.compare) {
  const runs = positionals.map((file) => JSON.parse(readFileSync(file, "utf8")) as BenchResult);
  const row = (name: string, pick: (run: BenchResult) => unknown) =>
    `| ${name} | ${runs.map((run) => String(pick(run))).join(" | ")} |`;
  const fmt = (value: { p50: number; p95: number; max: number } | undefined) =>
    value === undefined ? "-" : `${value.p50} / ${value.p95} / ${value.max}`;
  console.log(`| metric | ${runs.map((run) => run.label).join(" | ")} |`);
  console.log(`|---|${runs.map(() => "---").join("|")}|`);
  console.log(row("repos x rows", (run) => `${run.config.repos} x ${run.config.rows}`));
  console.log(row("gh spawns / min", (run) => run.gh.spawnsPerMinute));
  console.log(
    row(
      "offered gh demand / forge capacity per min",
      (run) => `${run.gh.spawnsPerMinute} / ${run.gh.forgeCapacityPerMinute}`,
    ),
  );
  console.log(
    row("gh spawns by subcommand / min", (run) =>
      Object.entries(run.gh.bySubcommandPerMinute)
        .map(([key, count]) => `${key} ${count}`)
        .join(", "),
    ),
  );
  console.log(row("gh child CPU s / min", (run) => run.gh.childCpuSecondsPerMinute));
  console.log(
    row("forge bg queue wait p50/p95/max ms", (run) => fmt(run.queueWait.forgeBackground)),
  );
  console.log(
    row("forge bg admissions that waited", (run) => `${run.queueWait.forgeBackgroundWaitedShare}%`),
  );
  console.log(
    row("github-api bg queue wait p50/p95/max ms", (run) => fmt(run.queueWait.apiBackground)),
  );
  console.log(
    row(
      "forge in-flight mean / peak",
      (run) => `${run.inFlight.forge.mean} / ${run.inFlight.forge.peak}`,
    ),
  );
  console.log(
    row(
      "forge queued mean / peak",
      (run) => `${run.inFlight.forgeQueued.mean} / ${run.inFlight.forgeQueued.peak}`,
    ),
  );
  console.log(
    row(
      "github-api in-flight mean / peak",
      (run) => `${run.inFlight.api.mean} / ${run.inFlight.api.peak}`,
    ),
  );
  for (const kind of ["linkStates", "pullRequestState", "rowDetail", "index", "branch"] as const) {
    console.log(row(`${kind} p50/p95/max ms`, (run) => fmt(run.latency[kind])));
  }
  console.log(row("interactive probe p50/p95/max ms", (run) => fmt(run.latency.probe)));
  console.log(
    row(
      "link-state batch (150 numbers) idle p50/p95 ms",
      (run) => `${run.batch.idle.p50} / ${run.batch.idle.p95}`,
    ),
  );
  console.log(
    row(
      "link-state batch (150 numbers) loaded p50/p95 ms",
      (run) => `${run.batch.loaded.p50} / ${run.batch.loaded.p95}`,
    ),
  );
  console.log(
    row(
      "HTTP requests / min (graphql, rest, shim)",
      (run) =>
        `${run.server.graphqlPerMinute}, ${run.server.restPerMinute}, ${run.server.shimPerMinute}`,
    ),
  );
  console.log(row("bench process CPU s / min", (run) => run.cpuSecondsPerMinute));
  console.log(row("failed reads", (run) => run.failures));
  process.exit(0);
}

if (values["measure-real-gh"]) {
  // Real gh's fixed process cost, offline: `--version` only (no token is read or printed).
  const time = (command: string, args: ReadonlyArray<string>) =>
    summary(
      Array.from({ length: 20 }, () => {
        const started = performance.now();
        spawnSync(command, args, { stdio: "ignore" });
        return performance.now() - started;
      }),
    );
  console.log(
    JSON.stringify(
      { ghVersion: time("gh", ["--version"]), nodeStartup: time(process.execPath, ["-e", "0"]) },
      null,
      2,
    ),
  );
  process.exit(0);
}

// ── Setup ─────────────────────────────────────────────────────────────

// The web client's poll cadences, loaded from its source (the server project does not include
// web files, so this is a runtime import rather than a static one).
const refreshPolicy = (await import(
  new URL("../../web/src/rpc/sourceControlRefreshPolicy.ts", import.meta.url).href
)) as {
  readonly AUTOMATIC_ACTIVE_REFRESH_MS: number;
  readonly AUTOMATIC_DISCOVERY_REFRESH_MS: number;
};
const { AUTOMATIC_ACTIVE_REFRESH_MS, AUTOMATIC_DISCOVERY_REFRESH_MS } = refreshPolicy;

const transport = values.transport === "api" ? "api" : "cli";
const repoCount = Number(values.repos);
const rowsPerRepo = Number(values.rows);
const settledShare = Number(values["settled-share"]);
const durationMs = Number(values.minutes) * 60_000;
const latencyMs = Number(values["latency-ms"]);
const listSize = Number(values["list-size"]);
const label = values.label ?? `${transport}-${repoCount}`;

const tmp = mkdtempSync(path.join(os.tmpdir(), "ryco-gh-bench-"));
const shimDir = path.join(tmp, "bin");
const shimLog = path.join(tmp, "gh.log");
mkdirSync(shimDir);
writeFileSync(shimLog, "");

// The shim: gh's argv in, the fake GitHub's answer out, one log line per invocation.
writeFileSync(
  path.join(shimDir, "gh"),
  `#!${process.execPath}
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const started = Date.now();
const cpu0 = process.cpuUsage();
const args = process.argv.slice(2);
const origin = process.env.RYCO_BENCH_GH_ORIGIN;
const repo = path.basename(process.cwd());
const finish = (code, out, err) => {
  if (out) process.stdout.write(out);
  if (err) process.stderr.write(err);
  const cpu = process.cpuUsage(cpu0);
  const command = args[0] === "api" && args[1] !== "graphql" ? "api rest" : args.slice(0, 2).join(" ");
  fs.appendFileSync(process.env.RYCO_BENCH_GH_LOG, JSON.stringify({ c: command, wallMs: Date.now() - started, cpuUs: cpu.user + cpu.system }) + "\\n");
  process.exitCode = code;
};
const readStdin = () => new Promise((resolve) => { let text = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", (chunk) => (text += chunk)); process.stdin.on("end", () => resolve(text)); });
const ghApiOutput = (status, body, graphql) => {
  let message = "";
  try {
    const parsed = JSON.parse(body);
    if (graphql && Array.isArray(parsed.errors) && parsed.errors.length > 0) message = parsed.errors.map((e) => e.message).join("\\n");
    else if (status > 299 && parsed.message) message = parsed.message + " (HTTP " + status + ")";
  } catch {}
  if (!message && status > 299) message = "HTTP " + status;
  return message ? [1, body, "gh: " + message + "\\n"] : [0, body, ""];
};
(async () => {
  if (args[0] === "--version") return finish(0, "gh version 0.0.0-bench\\n", "");
  if (args[0] === "auth" && args[1] === "token") return finish(0, "bench-token\\n", "");
  if (args[0] === "repo" || args[0] === "pr") {
    const response = await fetch(origin + "/shim/" + args[0] + "-" + args[1], { method: "POST", body: JSON.stringify({ repo, args }) });
    return finish(response.ok ? 0 : 1, await response.text(), response.ok ? "" : "gh: shim failure\\n");
  }
  if (args[0] === "api" && args[1] === "graphql") {
    let body;
    if (args.includes("--input")) body = await readStdin();
    else {
      let query = "";
      const variables = {};
      for (let index = 2; index < args.length; index += 1) {
        const flag = args[index];
        if (flag !== "-f" && flag !== "-F" && flag !== "--raw-field" && flag !== "--field") { if (flag === "--hostname") index += 1; continue; }
        const pair = args[++index];
        const eq = pair.indexOf("=");
        const key = pair.slice(0, eq);
        const raw = pair.slice(eq + 1);
        if (key === "query") { query = raw; continue; }
        const name = key.replace(/\\[\\]$/u, "");
        const value = flag === "-F" && /^-?\\d+$/u.test(raw) ? Number(raw) : flag === "-F" && (raw === "true" || raw === "false") ? raw === "true" : raw;
        if (key.endsWith("[]")) (variables[name] ??= []).push(value);
        else variables[name] = value;
      }
      body = JSON.stringify({ query, variables });
    }
    const response = await fetch(origin + "/api/graphql", { method: "POST", body, headers: { "content-type": "application/json" } });
    const [code, out, err] = ghApiOutput(response.status, await response.text(), true);
    return finish(code, out, err);
  }
  if (args[0] === "api") {
    const valued = new Set(["--hostname", "-H", "--header", "-X", "--method", "-f", "-F", "--raw-field", "--field", "-q", "--jq"]);
    const rest = args.slice(1);
    const endpoint = rest.find((arg, index) => !arg.startsWith("-") && !valued.has(rest[index - 1]));
    const response = await fetch(origin + "/api/v3/" + endpoint.replace(/^\\//u, ""));
    const [code, out, err] = ghApiOutput(response.status, await response.text(), false);
    return finish(code, out, err);
  }
  return finish(1, "", "gh: the bench shim does not implement " + args.slice(0, 2).join(" ") + "\\n");
})();
`,
);
chmodSync(path.join(shimDir, "gh"), 0o755);

// ── The fake GitHub ───────────────────────────────────────────────────

const serverCounts = {
  graphql: 0,
  rest: 0,
  notModified: 0,
  shim: 0,
  byRoute: {} as Record<string, number>,
};
const count = (route: string) => {
  serverCounts.byRoute[route] = (serverCounts.byRoute[route] ?? 0) + 1;
};
const rateHeaders = {
  "x-ratelimit-limit": "5000",
  "x-ratelimit-remaining": "4000",
  "x-ratelimit-reset": "1893456000",
};

const pullRequestSummary = (repo: string, number: number) => ({
  number,
  title: `Change ${number}`,
  url: `https://github.com/acme/${repo}/pull/${number}`,
  baseRefName: "main",
  headRefName: `feature/${number}`,
  state: number % 3 === 0 ? "MERGED" : "OPEN",
  mergedAt: number % 3 === 0 ? "2026-10-01T00:00:00Z" : null,
  closedAt: number % 3 === 0 ? "2026-10-01T00:00:00Z" : null,
  updatedAt: "2026-10-20T00:00:00Z",
  createdAt: "2026-10-01T00:00:00Z",
  isDraft: false,
  isCrossRepository: false,
  author: { login: "octo" },
  headRepository: { nameWithOwner: `acme/${repo}` },
  headRepositoryOwner: { login: "acme" },
});

const answerGraphQl = (query: string) => {
  if (/[pi]\d+: (?:pullRequest|issue)\(number:/u.test(query)) {
    count("graphql:linkStates");
    const repository: Record<string, unknown> = {};
    for (const [, kind, number] of query.matchAll(/([pi])(\d+): (?:pullRequest|issue)/gu)) {
      repository[`${kind}${number}`] =
        kind === "p"
          ? {
              number: Number(number),
              state: "OPEN",
              isDraft: false,
              closedAt: null,
              mergedAt: null,
            }
          : { number: Number(number), state: "OPEN" };
    }
    return { data: { repository } };
  }
  if (query.includes("reactionGroups")) {
    count("graphql:reactions");
    return { data: { nodes: [] } };
  }
  if (/\bstack\b|stackEntry/u.test(query)) {
    count("graphql:stack");
    return { data: { repository: { pullRequest: null } } };
  }
  if (/isRequired|requiredStatusCheck|checkSuites|statusCheckRollup/u.test(query)) {
    count("graphql:requiredChecks");
    return { data: { repository: { pullRequest: null } } };
  }
  count("graphql:other");
  return { data: {} };
};

const handle = (request: FakeGitHubRequest) => {
  if (request.url.startsWith("/shim/")) {
    serverCounts.shim += 1;
    const route = request.url.slice("/shim/".length);
    count(`shim:${route}`);
    const { repo, args } = JSON.parse(request.body) as { repo: string; args: string[] };
    if (route === "repo-view") {
      return { body: { nameWithOwner: `acme/${repo}`, url: `https://github.com/acme/${repo}` } };
    }
    if (route === "pr-list") {
      const head = args[args.indexOf("--head") + 1];
      const items = args.includes("--head")
        ? head?.startsWith("feature/")
          ? [pullRequestSummary(repo, Number(head.slice("feature/".length)))]
          : []
        : Array.from({ length: listSize }, (_, index) => pullRequestSummary(repo, index + 1));
      return { body: items };
    }
    if (route === "pr-view") {
      const number = Number(args[2]);
      return {
        body: {
          ...pullRequestSummary(repo, number),
          headRefOid: "0123456789abcdef0123456789abcdef01234567",
          mergeable: "MERGEABLE",
          body: "Body",
          comments: [
            {
              id: "IC_1",
              author: { login: "octo" },
              body: "First",
              createdAt: "2026-10-20T00:00:00Z",
            },
            {
              id: "IC_2",
              author: { login: "cat" },
              body: "Second",
              createdAt: "2026-10-20T00:01:00Z",
            },
          ],
          statusCheckRollup: [
            { __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "SUCCESS" },
          ],
          commits: [],
          files: [],
          additions: 1,
          deletions: 1,
          changedFiles: 1,
        },
      };
    }
    return { status: 404, body: { message: "Not Found" } };
  }
  if (request.method === "POST" && request.url.endsWith("/graphql")) {
    serverCounts.graphql += 1;
    return {
      headers: { ...rateHeaders, "x-ratelimit-resource": "graphql" },
      body: answerGraphQl(JSON.parse(request.body).query as string),
    };
  }
  if (request.method !== "GET" || !/^\/api\/v3\/repos\/[^/]+\/[^/]+$/u.test(request.url)) {
    count("unexpected");
    return { status: 404, body: { message: "Not Found" } };
  }
  serverCounts.rest += 1;
  count("rest:repos");
  if (request.headers["if-none-match"] === '"merge-settings"') {
    serverCounts.notModified += 1;
    return { status: 304, headers: { ...rateHeaders, etag: '"merge-settings"' } };
  }
  return {
    headers: { ...rateHeaders, "x-ratelimit-resource": "core", etag: '"merge-settings"' },
    body: {
      allow_merge_commit: true,
      allow_squash_merge: true,
      allow_rebase_merge: false,
      delete_branch_on_merge: true,
    },
  };
};

const server = await startFakeGitHub(async (request) => {
  const response = handle(request);
  return { ...response, delayMs: latencyMs };
});

process.env.PATH = `${shimDir}${path.delimiter}${process.env.PATH ?? ""}`;
process.env.RYCO_BENCH_GH_ORIGIN = server.origin;
process.env.RYCO_BENCH_GH_LOG = shimLog;
process.env.GH_CONFIG_DIR = path.join(tmp, "gh-config");
const resolvedGh = execFileSync("sh", ["-c", "command -v gh"], { encoding: "utf8" }).trim();
if (resolvedGh !== path.join(shimDir, "gh")) {
  throw new Error(`gh resolves to ${resolvedGh}, not the bench shim; refusing to run.`);
}

// Exact admission waits for every pool, zero waits included.
interface Admission {
  readonly pool: string;
  readonly lane: string;
  readonly queueWaitMs: number;
}
const admissions: Admission[] = [];
let recording = false;
const originalRequest = ProcessPool.prototype.request;
ProcessPool.prototype.request = function (this: ProcessPool, lane, onGranted) {
  return originalRequest.call(this, lane, (release, queueWaitMs) => {
    if (recording) admissions.push({ pool: this.name, lane, queueWaitMs });
    onGranted(release, queueWaitMs);
  });
};

const repos = Array.from({ length: repoCount }, (_, index) => {
  const cwd = path.join(tmp, `repo-${index + 1}`);
  mkdirSync(cwd);
  return {
    cwd,
    key: pullRequestIndexRepositoryKey({
      providerKind: "github",
      remoteUrl: `https://github.com/acme/repo-${index + 1}`,
    }),
  };
});

// The stack production builds: governed VcsProcess, GitHubCli (gh only or the direct API), provider.
type ApiModule = typeof import("../src/sourceControl/gitHubApi.ts");
const apiModule: ApiModule | null =
  transport === "api" ? await import("../src/sourceControl/gitHubApi.ts") : null;
const base = Layer.mergeAll(VcsProcess.layer, FetchHttpClient.layer).pipe(
  Layer.provideMerge(NodeServices.layer),
);
const runtime = ManagedRuntime.make(base);
const { github, poolStats } = await runtime.runPromise(
  Effect.gen(function* () {
    if (apiModule === null) {
      const gh = yield* Effect.gen(function* () {
        return yield* GitHubCli.GitHubCli;
      }).pipe(Effect.provide(GitHubCli.layer));
      return { github: gh, poolStats: null };
    }
    const api = yield* apiModule.make.pipe(
      Effect.provideService(apiModule.GitHubApiEnvironment, { GH_TOKEN: "bench-token" }),
      Effect.provideService(apiModule.GitHubApiEndpoints, () => server.urls),
    );
    const gh = yield* GitHubCli.make().pipe(Effect.provideService(apiModule.GitHubApi, api));
    return { github: gh, poolStats: api.poolStats };
  }),
);
const provider = await runtime.runPromise(
  GitHubSourceControlProvider.make().pipe(
    Effect.provideService(GitHubCli.GitHubCli, github),
    Effect.provide(NodeServices.layer),
  ),
);
const index = await runtime.runPromise(makePullRequestIndex);

// ── Workload ──────────────────────────────────────────────────────────

const latencies: Record<string, number[]> = {
  linkStates: [],
  pullRequestState: [],
  rowDetail: [],
  index: [],
  branch: [],
  probe: [],
};
let failures = 0;
const failureKinds: Record<string, number> = {};
const timed = <A, E>(
  kind: string,
  effect: Effect.Effect<A, E>,
  lane: "background" | "interactive" = "background",
) => {
  const started = performance.now();
  return runtime.runPromise(lane === "background" ? inBackgroundProcessLane(effect) : effect).then(
    () => {
      latencies[kind]?.push(performance.now() - started);
    },
    (error: unknown) => {
      failures += 1;
      const name = `${kind}: ${String((error as { message?: string })?.message ?? error)
        .split("\n")[0]
        ?.slice(0, 120)}`;
      failureKinds[name] = (failureKinds[name] ?? 0) + 1;
    },
  );
};

const rowCache = new Map<
  string,
  { readonly expiresAtMs: number; readonly read: Promise<unknown> }
>();
const readRow = (cwd: string, number: number) => {
  const key = `${cwd}\u0000${number}`;
  const cached = rowCache.get(key);
  const now = Date.now();
  if (cached && cached.expiresAtMs > now) return cached.read;
  const read = timed(
    "rowDetail",
    provider.getChangeRequestDetail({ cwd, reference: String(number) }),
  );
  rowCache.set(key, { expiresAtMs: now + CHANGE_REQUEST_ROW_DETAIL_CACHE_TTL_MS, read });
  return read;
};

let seed = 7;
const random = () => {
  seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
  return seed / 2_147_483_648;
};

interface Task {
  readonly periodMs: number;
  nextAtMs: number;
  readonly run: () => void;
}
const tasks: Task[] = [];
const every = (periodMs: number, run: () => void) =>
  tasks.push({ periodMs, nextAtMs: random() * periodMs, run });
for (const repo of repos) {
  every(AUTOMATIC_DISCOVERY_REFRESH_MS, () => {
    void timed(
      "index",
      index.read({ repository: repo.key, scope: "all", cwd: repo.cwd, provider }),
    );
    for (const branch of ["chore/no-pr-1", "chore/no-pr-2"]) {
      void timed(
        "branch",
        index.readBranch({ repository: repo.key, headSelector: branch, cwd: repo.cwd, provider }),
      );
    }
  });
  every(WORKTREE_PULL_REQUEST_DISCOVERY_INTERVAL_MS, () => {
    void timed(
      "linkStates",
      provider.getLinkStates!({
        cwd: repo.cwd,
        pullRequestNumbers: Array.from({ length: 40 }, (_, i) => i + 1),
        issueNumbers: Array.from({ length: 10 }, (_, i) => 101 + i),
      }),
    );
    for (const number of [3, 4])
      void timed("pullRequestState", provider.getPullRequestState({ cwd: repo.cwd, number }));
  });
  const activeRows = Math.round(rowsPerRepo * (1 - settledShare));
  for (let row = 0; row < activeRows; row += 1) {
    every(AUTOMATIC_ACTIVE_REFRESH_MS, () => void readRow(repo.cwd, row + 1));
  }
}
const probeRepo = repos[0]!;
every(2_000, () => {
  void timed(
    "probe",
    provider.getLinkStates!({ cwd: probeRepo.cwd, pullRequestNumbers: [1], issueNumbers: [] }),
    "interactive",
  );
});

const batch = () => {
  const started = performance.now();
  return runtime
    .runPromise(
      inBackgroundProcessLane(
        provider.getLinkStates!({
          cwd: probeRepo.cwd,
          pullRequestNumbers: Array.from({ length: 100 }, (_, i) => i + 1),
          issueNumbers: Array.from({ length: 50 }, (_, i) => 201 + i),
        }),
      ),
    )
    .then(() => performance.now() - started);
};

// Warm the repository resolutions, then the idle batch timings.
await Promise.all(
  repos.map((repo) =>
    runtime.runPromise(
      provider.getLinkStates!({ cwd: repo.cwd, pullRequestNumbers: [1], issueNumbers: [] }),
    ),
  ),
);
const idleBatch: number[] = [];
for (let run = 0; run < 20; run += 1) idleBatch.push(await batch());

// ── Run ───────────────────────────────────────────────────────────────

const shimLinesBefore = readFileSync(shimLog, "utf8").split("\n").filter(Boolean).length;
const serverBefore = {
  graphql: serverCounts.graphql,
  rest: serverCounts.rest,
  shim: serverCounts.shim,
  notModified: serverCounts.notModified,
};
const routesBefore = { ...serverCounts.byRoute };
const forgeBefore = processGovernorStats().find((stats) => stats.pool === "forge")!;
const cpuBefore = process.cpuUsage();
const samples = { forge: [] as number[], forgeQueued: [] as number[], api: [] as number[] };
const loadedBatch: number[] = [];
recording = true;
const startedAt = Date.now();
await new Promise<void>((resolve) => {
  let nextBatchAt = 5_000;
  const sampler = setInterval(() => {
    const forge = processGovernorStats().find((stats) => stats.pool === "forge")!;
    samples.forge.push(forge.inFlight);
    samples.forgeQueued.push(forge.queued);
    samples.api.push(poolStats?.().inFlight ?? 0);
  }, 100);
  const ticker = setInterval(() => {
    const elapsed = Date.now() - startedAt;
    if (elapsed >= durationMs) {
      clearInterval(ticker);
      clearInterval(sampler);
      resolve();
      return;
    }
    for (const task of tasks) {
      if (elapsed >= task.nextAtMs) {
        task.nextAtMs += task.periodMs;
        task.run();
      }
    }
    if (elapsed >= nextBatchAt && loadedBatch.length < 20) {
      nextBatchAt += Math.max(3_000, (durationMs - 10_000) / 20);
      void batch().then((ms) => loadedBatch.push(ms));
    }
  }, 50);
});
recording = false;
const elapsedMinutes = (Date.now() - startedAt) / 60_000;
const cpu = process.cpuUsage(cpuBefore);
// Let the last reads finish before counting.
await new Promise((resolve) => setTimeout(resolve, 3_000));

const shimLines = readFileSync(shimLog, "utf8")
  .split("\n")
  .filter(Boolean)
  .slice(shimLinesBefore)
  .map((line) => JSON.parse(line) as { c: string; wallMs: number; cpuUs: number });
const bySubcommand: Record<string, number> = {};
for (const line of shimLines) bySubcommand[line.c] = (bySubcommand[line.c] ?? 0) + 1;
const forgeAfter = processGovernorStats().find((stats) => stats.pool === "forge")!;
const meanShimWallMs =
  shimLines.length === 0
    ? 0
    : shimLines.reduce((sum, line) => sum + line.wallMs, 0) / shimLines.length;
const waitsOf = (pool: string) =>
  admissions
    .filter((item) => item.pool === pool && item.lane === "background")
    .map((item) => item.queueWaitMs);
const forgeWaits = waitsOf("forge");
const peakMean = (values: ReadonlyArray<number>) => ({
  mean: round(values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length)),
  peak: Math.max(0, ...values),
});
const perMinute = (value: number) => round(value / elapsedMinutes);
const routes: Record<string, number> = {};
for (const [route, total] of Object.entries(serverCounts.byRoute))
  routes[route] = perMinute(total - (routesBefore[route] ?? 0));

const result = {
  label,
  config: {
    transport,
    repos: repoCount,
    rows: rowsPerRepo,
    settledShare,
    minutes: round(elapsedMinutes),
    latencyMs,
    listSize,
    node: process.version,
  },
  gh: {
    spawnsPerMinute: perMinute(shimLines.length),
    governorForgeAdmittedPerMinute: perMinute(forgeAfter.admittedTotal - forgeBefore.admittedTotal),
    bySubcommandPerMinute: Object.fromEntries(
      Object.entries(bySubcommand).map(([key, total]) => [key, perMinute(total)]),
    ),
    meanShimWallMs: round(meanShimWallMs),
    forgeCapacityPerMinute: meanShimWallMs === 0 ? 0 : Math.round((4 * 60_000) / meanShimWallMs),
    childCpuSecondsPerMinute: round(
      shimLines.reduce((sum, line) => sum + line.cpuUs, 0) / 1e6 / elapsedMinutes,
    ),
  },
  queueWait: {
    forgeBackground: summary(forgeWaits),
    forgeBackgroundWaitedShare: round(
      (100 * forgeWaits.filter((wait) => wait > 0).length) / Math.max(1, forgeWaits.length),
    ),
    apiBackground: summary(waitsOf("github-api")),
  },
  inFlight: {
    forge: peakMean(samples.forge),
    forgeQueued: peakMean(samples.forgeQueued),
    api: peakMean(samples.api),
  },
  latency: Object.fromEntries(
    Object.entries(latencies).map(([kind, values]) => [kind, summary(values)]),
  ) as Record<string, ReturnType<typeof summary>>,
  batch: { idle: summary(idleBatch), loaded: summary(loadedBatch) },
  server: {
    graphqlPerMinute: perMinute(serverCounts.graphql - serverBefore.graphql),
    restPerMinute: perMinute(serverCounts.rest - serverBefore.rest),
    notModifiedPerMinute: perMinute(serverCounts.notModified - serverBefore.notModified),
    shimPerMinute: perMinute(serverCounts.shim - serverBefore.shim),
    routesPerMinute: routes,
  },
  cpuSecondsPerMinute: round((cpu.user + cpu.system) / 1e6 / elapsedMinutes),
  failures,
  failureKinds,
};
type BenchResult = typeof result;

if (values.out) writeFileSync(values.out, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
await runtime.dispose();
await server.close();
rmSync(tmp, { recursive: true, force: true });
process.exit(0);
