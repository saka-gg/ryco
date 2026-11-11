/// <reference types="node" />
/**
 * The native libraries the phone app links that npm does not describe: CocoaPods dependencies of
 * the autolinked pods, Swift packages of Expo's precompiled modules, and the Maven artifacts the
 * Android modules declare. `generate-third-party-licenses.test.ts` checks that each one is covered
 * by a custom notice (`nativeDependencies`) or a reasoned exclusion in
 * `third-party-licenses.config.json`.
 *
 * Ids: `pod:<name>`, `spm:<repository url>`, `maven:<group>:<artifact>`.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** `s.dependency 'X'` lines outside `test_spec` blocks; subspecs count as their pod. */
export function parsePodspecDependencies(source: string): ReadonlyArray<string> {
  const names = new Set<string>();
  let testSpecDepth = 0;
  for (const line of source.split("\n")) {
    const trimmed = line.trim();
    if (/\.test_spec\b.*\bdo\b/u.test(trimmed)) {
      testSpecDepth += 1;
      continue;
    }
    if (testSpecDepth > 0) {
      if (/\bdo\b(\s*\|[^|]*\|)?\s*$/u.test(trimmed)) testSpecDepth += 1;
      else if (trimmed === "end") testSpecDepth -= 1;
      continue;
    }
    const match = /^\w+\.dependency\s*\(?\s*["']([^"']+)["']/u.exec(trimmed);
    if (match?.[1]) names.add(match[1].split("/")[0]!);
  }
  return [...names].toSorted();
}

/** `group:artifact` of the Maven artifacts a Gradle build adds to its runtime classpath. */
export function parseGradleDependencies(source: string): ReadonlyArray<string> {
  const coordinates = new Set<string>();
  const patterns = [
    /^\s*(?:implementation|api)\s*\(?\s*(?:platform\()?["']([^"':\s]+):([^"':\s]+)(?::[^"']*)?["']/gmu,
    /^\s*add\(\s*\w+\s*,\s*["']([^"':\s]+):([^"':\s]+)(?::[^"']*)?["']/gmu,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) coordinates.add(`${match[1]}:${match[2]}`);
  }
  return [...coordinates].toSorted();
}

/** Repository URLs of the Swift packages an Expo `spm.config.json` builds into its prebuilt. */
export function parseSpmPackages(source: string): ReadonlyArray<string> {
  const config = JSON.parse(source) as {
    readonly products?: ReadonlyArray<{
      readonly spmPackages?: ReadonlyArray<{ readonly url?: string }>;
    }>;
  };
  const urls = new Set<string>();
  for (const product of config.products ?? []) {
    for (const spmPackage of product.spmPackages ?? []) {
      if (spmPackage.url) urls.add(spmPackage.url.replace(/\.git$/u, ""));
    }
  }
  return [...urls].toSorted();
}

/** Whether a configured id (`maven:androidx.*`, `pod:SDWebImage`) covers a found one. */
export function nativeIdMatches(pattern: string, id: string): boolean {
  return pattern.endsWith("*") ? id.startsWith(pattern.slice(0, -1)) : pattern === id;
}

export interface AutolinkedPackage {
  readonly name: string;
  readonly version: string;
  readonly root: string;
}

export interface NativeInventory {
  /** Packages Expo autolinking links on iOS or Android, with their roots. */
  readonly packages: ReadonlyArray<AutolinkedPackage>;
  /** Third-party native dependency ids, each with the packages that declare it. */
  readonly dependencies: ReadonlyMap<string, ReadonlyArray<string>>;
}

function packageRootOf(directory: string): string {
  let current = directory;
  while (!existsSync(join(current, "package.json"))) {
    const parent = dirname(current);
    if (parent === current) return directory;
    current = parent;
  }
  return current;
}

function podspecsIn(directory: string): ReadonlyArray<string> {
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.endsWith(".podspec"))
    .map((name) => join(directory, name));
}

function podspecsUnder(directory: string, skip: (path: string) => boolean): ReadonlyArray<string> {
  const found: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (skip(path)) continue;
      if (entry.isDirectory() && entry.name !== "node_modules") walk(path);
      else if (entry.isFile() && entry.name.endsWith(".podspec")) found.push(path);
    }
  };
  walk(directory);
  return found;
}

function readPackageJson(root: string): { readonly name?: string; readonly version?: string } {
  return JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    readonly name?: string;
    readonly version?: string;
  };
}

/**
 * Asks Expo autolinking (offline, as `expo prebuild` would) which packages the app links on each
 * platform, then reads their podspecs, `spm.config.json` and Gradle builds. React Native's own pods
 * are first party to the react-native package, except its third-party podspecs and Hermes.
 */
export function readNativeInventory(appDir: string): NativeInventory {
  const autolinking = join(appDir, "node_modules", ".bin", "expo-modules-autolinking");
  const run = (args: ReadonlyArray<string>): unknown =>
    JSON.parse(
      execFileSync(autolinking, [...args, "--json"], {
        cwd: appDir,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      }),
    );
  const podspecDirs = new Set<string>();
  const gradleDirs = new Set<string>();
  const roots = new Set<string>();
  let reactNativeRoot: string | null = null;
  for (const platform of ["ios", "android"] as const) {
    const expo = run(["resolve", "--platform", platform]) as {
      readonly modules: ReadonlyArray<{
        readonly pods?: ReadonlyArray<{ readonly podspecDir: string }>;
        readonly projects?: ReadonlyArray<{ readonly sourceDir: string }>;
      }>;
    };
    for (const module of expo.modules) {
      for (const pod of module.pods ?? []) {
        podspecDirs.add(pod.podspecDir);
        roots.add(packageRootOf(pod.podspecDir));
      }
      for (const project of module.projects ?? []) {
        gradleDirs.add(project.sourceDir);
        roots.add(packageRootOf(project.sourceDir));
      }
    }
    const community = run(["react-native-config", "--platform", platform]) as {
      readonly reactNativePath: string;
      readonly dependencies: Readonly<
        Record<
          string,
          {
            readonly root: string;
            readonly platforms: {
              readonly ios?: { readonly podspecPath: string } | null;
              readonly android?: { readonly sourceDir: string } | null;
            };
          }
        >
      >;
    };
    reactNativeRoot = community.reactNativePath;
    for (const dependency of Object.values(community.dependencies)) {
      const ios = dependency.platforms.ios;
      const android = dependency.platforms.android;
      if (ios) podspecDirs.add(dirname(ios.podspecPath));
      if (android) gradleDirs.add(android.sourceDir);
      if (ios || android) roots.add(dependency.root);
    }
  }

  const packages = [...roots].map((root): AutolinkedPackage => {
    const packageJson = existsSync(join(root, "package.json")) ? readPackageJson(root) : {};
    return {
      name: packageJson.name ?? basename(root),
      version: packageJson.version ?? "",
      root: realpathSync(root),
    };
  });

  // Pods some linked package provides itself: their license is that package's.
  const internalPods = new Set<string>();
  const declared: Array<{ readonly podspec: string; readonly owner: string }> = [];
  for (const directory of podspecDirs) {
    for (const podspec of podspecsIn(directory)) {
      internalPods.add(basename(podspec, ".podspec"));
      declared.push({ podspec, owner: readPackageJson(packageRootOf(directory)).name ?? "" });
    }
  }
  if (reactNativeRoot) {
    const thirdParty = (path: string) =>
      path.includes("/third-party-podspecs") || path.includes("/sdks/");
    for (const podspec of podspecsUnder(reactNativeRoot, () => false)) {
      if (!thirdParty(podspec)) internalPods.add(basename(podspec, ".podspec"));
      declared.push({ podspec, owner: "react-native" });
    }
  }

  const dependencies = new Map<string, Set<string>>();
  const add = (id: string, owner: string) => {
    const owners = dependencies.get(id) ?? new Set<string>();
    owners.add(owner);
    dependencies.set(id, owners);
  };
  for (const { podspec, owner } of declared) {
    for (const pod of parsePodspecDependencies(readFileSync(podspec, "utf8"))) {
      if (!internalPods.has(pod)) add(`pod:${pod}`, owner);
    }
  }
  for (const pkg of packages) {
    const spmConfig = join(pkg.root, "spm.config.json");
    if (!existsSync(spmConfig)) continue;
    for (const url of parseSpmPackages(readFileSync(spmConfig, "utf8")))
      add(`spm:${url}`, pkg.name);
  }
  for (const directory of gradleDirs) {
    const owner = readPackageJson(packageRootOf(directory)).name ?? directory;
    for (const file of ["build.gradle", "build.gradle.kts"]) {
      const path = join(directory, file);
      if (!existsSync(path)) continue;
      for (const coordinate of parseGradleDependencies(readFileSync(path, "utf8"))) {
        add(`maven:${coordinate}`, owner);
      }
    }
  }
  return {
    packages,
    dependencies: new Map(
      [...dependencies].map(([id, owners]) => [id, [...owners].toSorted()] as const),
    ),
  };
}
