// The slim Test matrix CI job runs this before installing dependencies: import
// only `node:` builtins here.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface TestJob {
  readonly name: string;
  readonly filters: string;
  readonly shard: string;
  readonly runner: string;
  /** setup-ryco's `bun-cache` mode for this leg. */
  readonly bunCache: "read" | "write";
}

/** Resolve affected packages once, then shard without mixing Turbo's incompatible flags. */
export function testJobs(packages: readonly string[]): TestJob[] {
  const selected = [...new Set(packages)].toSorted();
  for (const name of selected) {
    if (!/^(?:@[a-zA-Z0-9_.-]+\/)?[a-zA-Z0-9_.-]+$/u.test(name)) {
      throw new Error(`Invalid test package: ${name}`);
    }
  }
  const jobs: Omit<TestJob, "bunCache">[] = [];
  if (selected.includes("ryco-cli")) {
    // Each shard runs its files four at a time, one per vCPU of this runner
    // (apps/server/vitest.config.ts), then its wall-clock-bound files one by
    // one. Measured on four cores, a third of the suite takes 0.8-1.8 min and
    // all of it 3-4.3 min, so a two-shard leg would run about as long as a
    // browser leg, which sets CI's wall time; three keep the server legs below.
    for (let index = 1; index <= 3; index += 1) {
      jobs.push({
        name: `server-${index}`,
        filters: "--filter=ryco-cli",
        shard: `--shard=${index}/3`,
        runner: "ubuntu-24.04",
      });
    }
  }
  if (selected.includes("@ryco/web")) {
    jobs.push({
      name: "web",
      filters: "--filter=@ryco/web",
      shard: "",
      // The suite is CPU-bound: the free GitHub-hosted runner's 4 vCPU run
      // four Vitest workers where a 2 vCPU runner ran two.
      runner: "ubuntu-24.04",
    });
  }
  const rest = selected.filter((name) => name !== "ryco-cli" && name !== "@ryco/web");
  if (rest.length > 0) {
    jobs.push({
      name: "rest",
      filters: rest.map((name) => `--filter=${name}`).join(" "),
      shard: "",
      // Turbo runs several packages' suites in parallel here; the free
      // GitHub-hosted runner's 4 vCPU finish them well ahead of 2 vCPU.
      runner: "ubuntu-24.04",
    });
  }
  // Blacksmith runners send actions/cache to Blacksmith's own backend, which
  // Static writes, so one GitHub-hosted leg writes GitHub's backend for the
  // others; more writers per backend would only race for the same key. The
  // rest and web legs end before the server shards, so their save adds no
  // wall time.
  const hosted = jobs.filter((job) => !job.runner.startsWith("blacksmith-"));
  const writer =
    hosted.find((job) => job.name === "rest") ??
    hosted.find((job) => job.name === "web") ??
    hosted[0];
  return jobs.map((job) => {
    const bunCache: TestJob["bunCache"] = job === writer ? "write" : "read";
    return Object.assign(job, { bunCache });
  });
}

export function testPackages(plan: unknown): string[] {
  if (
    typeof plan !== "object" ||
    plan === null ||
    !("tasks" in plan) ||
    !Array.isArray(plan.tasks)
  ) {
    throw new Error("Turbo did not return a task plan.");
  }
  return plan.tasks.flatMap((task: unknown) => {
    if (typeof task !== "object" || task === null || !("task" in task)) {
      throw new Error("Turbo returned an invalid task.");
    }
    if (task.task !== "test") return [];
    if (
      !("package" in task) ||
      typeof task.package !== "string" ||
      !("command" in task) ||
      typeof task.command !== "string"
    ) {
      throw new Error("Turbo returned an invalid test task.");
    }
    // Native-module workspaces without a test script appear in Turbo's dry plan too.
    return task.command === "<NONEXISTENT>" ? [] : [task.package];
  });
}

/** The exact Turbo version bun.lock resolves for the workspace. */
export function pinnedTurboVersion(lockfile: string): string {
  const version = /^\s*"turbo": \["turbo@([^"]+)"/mu.exec(lockfile)?.[1];
  if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
    throw new Error("bun.lock does not resolve an exact turbo version.");
  }
  return version;
}

/** `bun` arguments that run Turbo's `test` task. */
function turboTestArguments(root: string): string[] {
  // Installed workspaces (browser shards, Build, local runs) use the canonical script.
  if (existsSync(join(root, "node_modules/turbo/package.json"))) return ["run", "test"];
  // Turbo's dry plan needs neither node_modules nor a build, so the slim job
  // fetches only the lockfile's Turbo instead of installing the workspace.
  const version = pinnedTurboVersion(readFileSync(join(root, "bun.lock"), "utf8"));
  return ["x", `turbo@${version}`, "run", "test"];
}

function isDocumentation(path: string): boolean {
  return /\.(?:md|mdx)$/u.test(path) || path.startsWith("docs/");
}

function isUnitTest(path: string): boolean {
  // The browser acceptance matrix reads these suite sources by name.
  if (/^apps\/web\/src\/(?:hostedHub|pwa)\//u.test(path)) return false;
  return /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(path);
}

export function validationScope(paths: readonly string[], packages: readonly string[]) {
  const runtimeChanges = paths.filter((path) => !isDocumentation(path) && !isUnitTest(path));
  const infrastructure = runtimeChanges.some(
    (path) =>
      path.startsWith(".github/") ||
      path.startsWith("scripts/") ||
      /^[^/]+(?:\.json|\.lock|\.ts)$/u.test(path) ||
      path.startsWith("patches/"),
  );
  const browser =
    infrastructure ||
    (runtimeChanges.length > 0 && packages.includes("@ryco/web")) ||
    paths.some((path) => /\.(?:browser|browser\.helpers)\.tsx$/u.test(path));
  const desktop =
    infrastructure ||
    runtimeChanges.some((path) => path.startsWith("native/")) ||
    (runtimeChanges.length > 0 &&
      packages.some((name) => ["@ryco/desktop", "ryco-cli", "@ryco/web"].includes(name)));
  const release =
    infrastructure ||
    runtimeChanges.some(
      (path) =>
        path.startsWith("scripts/") ||
        path.endsWith("/package.json") ||
        path.startsWith("apps/desktop/scripts/"),
    );
  // Nothing else bundles apps/mobile (it has no build task, and its unit tests
  // never run Metro), so a bad patch or a workspace export change would
  // otherwise surface only on a developer's Mac or in EAS. Workspace
  // dependencies reach it through the affected test plan; the path rule keeps
  // the app in scope whatever that plan lists.
  const mobile =
    infrastructure ||
    runtimeChanges.some((path) => path.startsWith("apps/mobile/")) ||
    (runtimeChanges.length > 0 && packages.includes("@ryco/mobile"));
  return { browser, desktop, release, mobile };
}

function main(): void {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const affected = Boolean(process.env.TURBO_SCM_BASE);
  const args = [...turboTestArguments(root), ...(affected ? ["--affected"] : []), "--dry=json"];
  const plan: unknown = JSON.parse(
    execFileSync("bun", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }),
  );
  const packages = testPackages(plan);
  const include = testJobs(packages);
  const paths = affected
    ? execFileSync(
        "git",
        ["diff", "--name-only", "--no-renames", "-z", `${process.env.TURBO_SCM_BASE}...HEAD`],
        { cwd: root, encoding: "utf8" },
      )
        .split("\0")
        .filter(Boolean)
    : [];
  const scope = affected
    ? validationScope(paths, packages)
    : { browser: true, desktop: true, release: true, mobile: true };
  const outputs = {
    include: JSON.stringify(include),
    "has-tests": String(include.length > 0),
    browser: String(scope.browser),
    desktop: String(scope.desktop),
    release: String(scope.release),
    mobile: String(scope.mobile),
  };
  const output = Object.entries(outputs)
    .map(([name, value]) => `${name}=${value}\n`)
    .join("");
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output);
  process.stdout.write(output);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
