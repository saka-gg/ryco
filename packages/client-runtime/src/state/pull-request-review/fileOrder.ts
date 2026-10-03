/**
 * Reading order for a change request's files. A reviewer reads the change
 * itself first, then what proves it, then docs and configuration, and a
 * lockfile or build output only ever confirms what the source already said.
 * Ordering by path alone buries the one file the change is about under
 * whichever directory happens to sort first.
 *
 * Adapted from t3code's `pullRequestFileOrder.logic.ts` (MIT) without its
 * import-graph pass: this works on file paths alone, so it can order the file
 * list before any patch is loaded.
 */
export type ChangeRequestFileTier = "source" | "test" | "docs" | "config" | "generated";

const TIER_ORDER: Record<ChangeRequestFileTier, number> = {
  source: 0,
  test: 1,
  docs: 2,
  config: 3,
  generated: 4,
};

const GENERATED_FILE_NAMES = new Set([
  "pnpm-lock.yaml",
  "yarn.lock",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "bun.lockb",
  "bun.lock",
  "Cargo.lock",
  "go.sum",
  "composer.lock",
  "Gemfile.lock",
  "poetry.lock",
  "uv.lock",
  "Podfile.lock",
  "flake.lock",
  "Package.resolved",
  "pubspec.lock",
  "mix.lock",
]);
const GENERATED_DIRECTORIES = new Set([
  "__snapshots__",
  "__generated__",
  "generated",
  "dist",
  "build",
  "vendor",
  "node_modules",
]);
const TEST_DIRECTORIES = new Set(["__tests__", "__test__", "tests", "test", "spec", "e2e"]);
const DOC_EXTENSIONS = /\.(?:md|mdx|markdown|rst|adoc|txt)$/iu;
const CONFIG_FILE_NAMES = new Set([
  "package.json",
  "tsconfig.json",
  "jsconfig.json",
  "turbo.json",
  "nx.json",
  "lerna.json",
  "vercel.json",
  "biome.json",
  "renovate.json",
  "deno.json",
  "bunfig.toml",
  "pnpm-workspace.yaml",
  "Cargo.toml",
  "go.mod",
  "pyproject.toml",
  "setup.cfg",
  "setup.py",
  "Gemfile",
  "composer.json",
  "Makefile",
  "Dockerfile",
  "Procfile",
  "CODEOWNERS",
]);
const CONFIG_DIRECTORIES = new Set([".github", ".vscode", ".devcontainer", ".husky", ".changeset"]);

function fileName(path: string): string {
  return path.split("/").at(-1) ?? path;
}

function directories(path: string): ReadonlyArray<string> {
  return path.split("/").slice(0, -1);
}

export function changeRequestFileTier(path: string): ChangeRequestFileTier {
  const name = fileName(path);
  const dirs = directories(path);
  if (
    GENERATED_FILE_NAMES.has(name) ||
    name.endsWith(".snap") ||
    /\.min\.(?:js|css)$/u.test(name) ||
    /\.(?:generated|gen)\.[^.]+$/u.test(name) ||
    name.endsWith(".pb.go") ||
    /_pb2(?:_grpc)?\.py$/u.test(name) ||
    dirs.some((dir) => GENERATED_DIRECTORIES.has(dir))
  ) {
    return "generated";
  }
  if (
    /\.(?:test|spec)\.[^/]+$/u.test(name) ||
    /_test\.(?:go|py|rb)$/u.test(name) ||
    /^test_.+\.py$/u.test(name) ||
    dirs.some((dir) => TEST_DIRECTORIES.has(dir))
  ) {
    return "test";
  }
  if (
    CONFIG_FILE_NAMES.has(name) ||
    dirs.some((dir) => CONFIG_DIRECTORIES.has(dir)) ||
    /^tsconfig\..+\.json$/u.test(name) ||
    /\.config\.(?:[cm]?[jt]s|json)$/u.test(name) ||
    // Dotfiles at any depth: .gitignore, .npmrc, .eslintrc.json, .env.example …
    name.startsWith(".") ||
    /^docker-compose.*\.ya?ml$/u.test(name) ||
    /^Dockerfile\..+$/u.test(name) ||
    /^requirements.*\.txt$/u.test(name)
  ) {
    return "config";
  }
  if (
    DOC_EXTENSIONS.test(name) ||
    /^(?:LICENSE|LICENCE|CHANGELOG|README|CONTRIBUTING|NOTICE)(?:\..+)?$/u.test(name) ||
    dirs[0] === "docs"
  ) {
    return "docs";
  }
  return "source";
}

function stripExtension(name: string): string {
  const dot = name.indexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

/** The implementation a test names: `foo.test.ts`, `foo_test.go`, `test_foo.py`, `__tests__/foo.ts`. */
function testedBaseName(path: string): string {
  const name = fileName(path)
    .replace(/\.(?:test|spec)\..*$/u, "")
    .replace(/_test\.[^.]+$/u, "")
    .replace(/^test_/u, "");
  return stripExtension(name).toLowerCase();
}

function comparePaths(left: string, right: string): number {
  return left.localeCompare(right);
}

/**
 * Files in reading order: source by path (so one directory stays together),
 * tests next to the order of the source they cover (unrelated tests after),
 * then docs, configuration, and generated output. Stable for equal inputs.
 */
export function orderChangeRequestFiles<T extends { readonly path: string }>(
  files: ReadonlyArray<T>,
): ReadonlyArray<T>;
export function orderChangeRequestFiles<T>(
  files: ReadonlyArray<T>,
  getPath: (file: T) => string,
): ReadonlyArray<T>;
export function orderChangeRequestFiles<T>(
  files: ReadonlyArray<T>,
  getPath?: (file: T) => string,
): ReadonlyArray<T> {
  const pathOf = getPath ?? ((file: T) => (file as { readonly path: string }).path);
  const entries = files.map((file) => ({ file, path: pathOf(file) }));
  const tierOf = new Map(entries.map(({ path }) => [path, changeRequestFileTier(path)]));

  const source = entries
    .filter(({ path }) => tierOf.get(path) === "source")
    .toSorted((left, right) => comparePaths(left.path, right.path));
  const sourcePosition = new Map<string, number>();
  source.forEach(({ path }, index) => {
    const base = stripExtension(fileName(path)).toLowerCase();
    if (!sourcePosition.has(base)) sourcePosition.set(base, index);
  });

  const ordered = entries
    .filter(({ path }) => tierOf.get(path) !== "source")
    .toSorted((left, right) => {
      const leftTier = tierOf.get(left.path) ?? "source";
      const rightTier = tierOf.get(right.path) ?? "source";
      const byTier = TIER_ORDER[leftTier] - TIER_ORDER[rightTier];
      if (byTier !== 0) return byTier;
      if (leftTier === "test") {
        const leftPosition =
          sourcePosition.get(testedBaseName(left.path)) ?? Number.MAX_SAFE_INTEGER;
        const rightPosition =
          sourcePosition.get(testedBaseName(right.path)) ?? Number.MAX_SAFE_INTEGER;
        if (leftPosition !== rightPosition) return leftPosition - rightPosition;
      }
      return comparePaths(left.path, right.path);
    });

  return [...source, ...ordered].map(({ file }) => file);
}
