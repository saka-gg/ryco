#!/usr/bin/env node
/**
 * Change-scoped validation for the local and coding-agent loop (see AGENTS.md and USAGE below).
 *
 * The change is every file committed since the base plus staged, unstaged and untracked files: the
 * set Turbo's `--affected` and Vitest's `--changed` use. Related tests follow Vitest's import
 * graph, so this is an inner-loop tool; CI still runs every test of every affected package.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { delimiter, join, relative } from "node:path";
import { parseArgs } from "node:util";

const TYPE_MODES = ["full", "fast", "none"] as const;
const TEST_MODES = ["related", "affected", "none"] as const;

export const USAGE = `Usage: bun run check:changed [options]

Format, lint, typecheck (Turbo-cached) and run the tests the change affects.

  --types=full|fast|none          full: TS7 + Effect (default); fast: tsc-rs pre-check
  --tests=related|affected|none   related: Vitest's import graph plus tests that read sources
                                  from disk (default); affected: every test of every affected
                                  package
  --no-fmt, --no-lint             skip the format check or lint
  --base <ref>                    diff base (default: merge-base with origin/main)
  -h, --help                      show this help

bun run test:changed runs the related tests only.
`;

export interface Options {
  readonly base: string | undefined;
  readonly fmt: boolean;
  readonly lint: boolean;
  readonly types: (typeof TYPE_MODES)[number];
  readonly tests: (typeof TEST_MODES)[number];
}

export interface WorkspacePackage {
  readonly name: string;
  readonly path: string;
}

function oneOf<T extends string>(flag: string, value: string, allowed: readonly T[]): T {
  const match = allowed.find((candidate) => candidate === value);
  if (match === undefined) throw new Error(`--${flag} must be one of: ${allowed.join(", ")}`);
  return match;
}

export function parseOptions(argv: readonly string[]): Options {
  const { values } = parseArgs({
    args: [...argv],
    allowNegative: true,
    options: {
      base: { type: "string" },
      fmt: { type: "boolean", default: true },
      lint: { type: "boolean", default: true },
      types: { type: "string", default: "full" },
      tests: { type: "string", default: "related" },
    },
  });
  return {
    base: values.base,
    fmt: values.fmt,
    lint: values.lint,
    types: oneOf("types", values.types, TYPE_MODES),
    tests: oneOf("tests", values.tests, TEST_MODES),
  };
}

/**
 * Root files every test depends on without importing them. That includes the root Vitest helpers:
 * packages load them from their Vitest config, which Vitest's import graph does not follow, and
 * Vitest's own rerun-everything triggers only match `vitest.config.*`.
 */
const GLOBAL_TEST_INPUT = /^(?:bun\.lock|patches\/.+|tsconfig[^/]*\.json|vitest\.[^/]+\.ts)$/u;
/** Files Vitest's import graph follows, or that cannot affect a test (docs). */
const IMPORT_GRAPH_FILE = /\.(?:[cm]?[jt]sx?|css|mdx?)$/u;
/**
 * Fixture directories (fixtures/, __fixtures__/, testFixtures/): tests read or spawn their files by
 * path, code included. A fixture a test does import only runs more tests than needed.
 */
const FIXTURE_FILE = /(?:^|\/)(?:__)?(?:\w*F|f)ixtures?(?:__)?\//u;
/** Each package's pure/timing Vitest project lists: only vitest.config.ts imports them. */
const TEST_PROJECT_LIST = /(?:^|\/)test\/(?:pureTests|timingTests)\.ts$/u;
const escalatesPackage = (path: string) =>
  !IMPORT_GRAPH_FILE.test(path) || FIXTURE_FILE.test(path) || TEST_PROJECT_LIST.test(path);

/**
 * Splits the affected packages into those that must run every test and those whose tests Vitest can
 * select from the import graph. Fixtures (code included), snapshots, assets, SQL, test-project
 * lists and other files tests reach without importing escalate their own package; lockfile, patch,
 * root tsconfig and root Vitest config changes escalate them all.
 */
export function partitionTests(
  changed: readonly string[],
  affected: readonly WorkspacePackage[],
  mode: Options["tests"],
): { readonly all: WorkspacePackage[]; readonly related: WorkspacePackage[] } {
  if (mode === "none") return { all: [], related: [] };
  if (mode === "affected" || changed.some((path) => GLOBAL_TEST_INPUT.test(path))) {
    return { all: [...affected], related: [] };
  }
  // The deepest package owns a file: mobile's native modules are packages nested in apps/mobile.
  const byDepth = affected.toSorted((left, right) => right.path.length - left.path.length);
  const escalated = new Set(
    changed
      .filter(escalatesPackage)
      .flatMap((path) => byDepth.find((pkg) => path.startsWith(`${pkg.path}/`)) ?? []),
  );
  return {
    all: affected.filter((pkg) => escalated.has(pkg)),
    related: affected.filter((pkg) => !escalated.has(pkg)),
  };
}

/**
 * Tests Vitest's import graph cannot connect to the sources they check: they read repo files from
 * disk (boundary, bundle-graph and corpus tests) or import through `@vite-ignore`. They run whenever
 * their package is affected, so `--changed` never skips them silently.
 */
const READS_REPO_FILES = /readFileSync|readdirSync|readFile\(|@vite-ignore/u;
const RELATIVE_TO_SELF = /import\.meta\.(?:dirname|url)|__dirname|process\.cwd\(\)/u;
const USES_TEMP_DIRECTORY = /makeTempDirectory|mkdtemp|tmpdir\(\)|TempDirectory/u;
// A repo source file located by path rather than imported, typically a mock process the test
// spawns (e.g. `path.join(__dirname, "../../scripts/acp-mock-agent.ts")`). Import specifiers
// never match: they are not arguments to path.join/resolve or new URL.
const LOCATES_REPO_SOURCE =
  /(?:\.(?:join|resolve)\(|new URL\()[^)]*["'`]\.{1,2}\/[^"'`\n]*\.[cm]?[jt]sx?["'`]/u;
// Vitest's default include; browser suites (`*.browser.tsx`) run under their own config.
const UNIT_TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;

export function isImportGraphBlind(source: string): boolean {
  return (
    (READS_REPO_FILES.test(source) &&
      RELATIVE_TO_SELF.test(source) &&
      !USES_TEMP_DIRECTORY.test(source)) ||
    LOCATES_REPO_SOURCE.test(source)
  );
}

/** NUL-separated so unusual file names survive unquoted. */
function gitPaths(command: string, ...args: string[]): string[] {
  const output = execFileSync("git", [command, "-z", ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return output.split("\0").filter(Boolean);
}

function resolveBase(explicit: string | undefined): string {
  const revParse = (ref: string) =>
    execFileSync("git", ["rev-parse", "--verify", `${ref}^{commit}`], { encoding: "utf8" }).trim();
  if (explicit) return revParse(explicit);
  for (const ref of ["origin/main", "main"]) {
    try {
      return execFileSync("git", ["merge-base", "HEAD", ref], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      // Try the next candidate.
    }
  }
  throw new Error("No merge-base with origin/main or main; pass --base <ref>.");
}

function changedFiles(base: string): string[] {
  const files = [
    ...gitPaths("diff", "--name-only", "--no-renames", `${base}...HEAD`),
    ...gitPaths("diff", "--name-only", "--no-renames", "HEAD"),
    ...gitPaths("ls-files", "--others", "--exclude-standard"),
  ];
  return [...new Set(files)].toSorted();
}

function importGraphBlindTests(pkg: WorkspacePackage): string[] {
  return gitPaths("ls-files", "--cached", "--others", "--exclude-standard", "--", pkg.path)
    .filter((path) => UNIT_TEST_FILE.test(path) && existsSync(path))
    .filter((path) => isImportGraphBlind(readFileSync(path, "utf8")))
    .map((path) => relative(pkg.path, path));
}

function run(label: string, command: string, args: readonly string[], env: NodeJS.ProcessEnv) {
  const started = performance.now();
  process.stdout.write(`\n== ${label}: ${command} ${args.join(" ")}\n`);
  const result = spawnSync(command, args, { stdio: "inherit", env });
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  const ok = result.status === 0;
  const outcome = ok ? "ok" : `failed (${result.error?.message ?? `exit ${result.status}`})`;
  process.stdout.write(`== ${label}: ${outcome} in ${seconds}s\n`);
  return ok;
}

function main(): void {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(USAGE);
    return;
  }
  let options: Options;
  try {
    options = parseOptions(argv);
  } catch (error) {
    // A usage mistake, not a crash: no stack trace. Later git and turbo failures keep theirs.
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`check:changed: ${message}\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  process.chdir(root);
  const base = resolveBase(options.base);
  const files = changedFiles(base);
  process.stdout.write(`base ${base.slice(0, 12)}: ${files.length} changed file(s)\n`);
  if (files.length === 0) return;

  const env = {
    ...process.env,
    // Runnable as `node scripts/check-changed.ts`, not only through `bun run`.
    PATH: `${join(root, "node_modules", ".bin")}${delimiter}${process.env.PATH ?? ""}`,
    // Turbo's --affected also counts uncommitted and untracked files.
    TURBO_SCM_BASE: base,
  };
  const results: boolean[] = [];
  if (options.fmt || options.lint) {
    // Repo-wide like CI: about 3 s, and no file list to keep in sync with the ignore patterns.
    const skip = [...(options.fmt ? [] : ["--no-fmt"]), ...(options.lint ? [] : ["--no-lint"])];
    results.push(run("format and lint", "vp", ["check", "--quiet", ...skip], env));
  }
  if (options.types !== "none") {
    // Not --affected: Turbo's cache already skips every package whose inputs were checked before,
    // and its hashes also cover inputs outside a package's directory (the server checks
    // scripts/lib), which --affected's package-membership diff misses.
    const task = options.types === "fast" ? "typecheck:fast" : "typecheck";
    const args = ["run", task, "--continue", "--output-logs=errors-only"];
    results.push(run("typecheck", "turbo", args, env));
  }

  if (options.tests !== "none") {
    const listing = execFileSync("turbo", ["ls", "--affected", "--output=json"], {
      encoding: "utf8",
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const affected = (JSON.parse(listing) as { packages: { items: WorkspacePackage[] } }).packages
      .items;
    results.push(...runTests(partitionTests(files, affected, options.tests), base, env));
  }
  if (results.includes(false)) process.exitCode = 1;
}

function runTests(
  { all, related }: ReturnType<typeof partitionTests>,
  base: string,
  env: NodeJS.ProcessEnv,
): boolean[] {
  const turboTest = (pkgs: readonly WorkspacePackage[]) => [
    "run",
    "test",
    "--continue",
    "--output-logs=errors-only",
    ...pkgs.map((pkg) => `--filter=${pkg.name}`),
  ];
  const results: boolean[] = [];
  if (all.length > 0) results.push(run("tests (all)", "turbo", turboTest(all), env));
  if (related.length === 0) return results;
  // No --passWithNoTests: `--changed` implies it, and the web script already passes it (Vitest's
  // CLI rejects the flag twice).
  const args = [...turboTest(related), "--", `--changed=${base}`];
  results.push(run("tests (related)", "turbo", args, env));
  for (const pkg of related) {
    const blind = importGraphBlindTests(pkg);
    if (blind.length === 0) continue;
    const args = [...turboTest([pkg]), "--", ...blind];
    results.push(run(`tests (read from disk, ${pkg.name})`, "turbo", args, env));
  }
  return results;
}

if (import.meta.main) main();
