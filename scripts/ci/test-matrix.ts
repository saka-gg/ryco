import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface TestJob {
  readonly name: string;
  readonly filters: string;
  readonly shard: string;
  readonly runner: string;
}

/** Resolve affected packages once, then shard without mixing Turbo's incompatible flags. */
export function testJobs(packages: readonly string[]): TestJob[] {
  const selected = [...new Set(packages)].toSorted();
  for (const name of selected) {
    if (!/^(?:@[a-zA-Z0-9_.-]+\/)?[a-zA-Z0-9_.-]+$/u.test(name)) {
      throw new Error(`Invalid test package: ${name}`);
    }
  }
  const jobs: TestJob[] = [];
  if (selected.includes("ryco-cli")) {
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
      runner: "blacksmith-2vcpu-ubuntu-2404",
    });
  }
  const rest = selected.filter((name) => name !== "ryco-cli" && name !== "@ryco/web");
  if (rest.length > 0) {
    jobs.push({
      name: "rest",
      filters: rest.map((name) => `--filter=${name}`).join(" "),
      shard: "",
      runner: "blacksmith-2vcpu-ubuntu-2404",
    });
  }
  return jobs;
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
  return { browser, desktop, release };
}

function main(): void {
  const affected = Boolean(process.env.TURBO_SCM_BASE);
  const args = ["run", "test", ...(affected ? ["--affected"] : []), "--dry=json"];
  const plan: unknown = JSON.parse(
    execFileSync("bun", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }),
  );
  const packages = testPackages(plan);
  const include = testJobs(packages);
  const paths = affected
    ? execFileSync(
        "git",
        ["diff", "--name-only", "--no-renames", "-z", `${process.env.TURBO_SCM_BASE}...HEAD`],
        { encoding: "utf8" },
      )
        .split("\0")
        .filter(Boolean)
    : [];
  const scope = affected
    ? validationScope(paths, packages)
    : { browser: true, desktop: true, release: true };
  const outputs = {
    include: JSON.stringify(include),
    "has-tests": String(include.length > 0),
    browser: String(scope.browser),
    desktop: String(scope.desktop),
    release: String(scope.release),
  };
  const output = Object.entries(outputs)
    .map(([name, value]) => `${name}=${value}\n`)
    .join("");
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output);
  process.stdout.write(output);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
