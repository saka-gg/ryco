const { execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { getDefaultConfig } = require("expo/metro-config");
const { withUniwindConfig } = require("uniwind/metro");

/** @type {import("expo/metro-config").MetroConfig} */
const config = getDefaultConfig(__dirname);
const workspaceRoot = path.resolve(__dirname, "../..");
const escapedWorkspaceRoot = workspaceRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const mobileShikiRoot = path.dirname(require.resolve("shiki/package.json", { paths: [__dirname] }));
const clientRuntimeSourceRoot = path.join(workspaceRoot, "packages/client-runtime/src");
const resolveShikiDependencyRoot = (packageName) => {
  const entryPath = require.resolve(packageName, { paths: [mobileShikiRoot] });
  let currentDir = path.dirname(entryPath);

  while (!fs.existsSync(path.join(currentDir, "package.json"))) {
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      throw new Error(`Could not resolve package root for ${packageName}`);
    }
    currentDir = parentDir;
  }

  return currentDir;
};

// The open source license manifest the Settings > About > Open source licenses screen loads
// lazily: an ignored package Metro resolves as `@ryco/mobile-third-party-licenses`. It must exist
// before Metro crawls the file system, so it is written here, synchronously; the script returns
// at once when its inputs (bun.lock, the license config) are unchanged.
const generatedLicensesRoot = path.join(__dirname, ".generated", "third-party-licenses");
execFileSync(
  process.execPath,
  [path.join(__dirname, "scripts", "generate-third-party-licenses.mts")],
  { stdio: ["ignore", "inherit", "inherit"] },
);

// Metro keys a cached transform by the file's content, the Babel config files
// and cacheVersion, but not by the Babel presets and plugins those files load,
// so a dependency upgrade or a patch to a transform-time package changes output
// without touching any key. Tie cacheVersion to the lockfile and the patches
// (bun.lock records only a patch's path) so those start cold, instead of
// clearing the cache on every start.
const patchesRoot = path.join(workspaceRoot, "patches");
const dependencyHash = crypto
  .createHash("sha256")
  .update(fs.readFileSync(path.join(workspaceRoot, "bun.lock")));
for (const name of fs.readdirSync(patchesRoot).toSorted()) {
  dependencyHash.update(`\0${name}\0`).update(fs.readFileSync(path.join(patchesRoot, name)));
}
config.cacheVersion = dependencyHash.digest("hex").slice(0, 16);

config.watchFolders = [...new Set([...(config.watchFolders ?? []), workspaceRoot])];
config.resolver = {
  ...config.resolver,
  resolveRequest: (context, moduleName, platform) => {
    // @ryco/client-runtime is consumed as TypeScript source. Its NodeNext
    // barrels correctly use `.js` specifiers, but Metro does not map those
    // specifiers back to the colocated `.ts` source file. Keep the package's
    // Node contract intact and adapt only this React Native source boundary.
    if (
      context.originModulePath.startsWith(clientRuntimeSourceRoot) &&
      (moduleName.startsWith("./") || moduleName.startsWith("../")) &&
      moduleName.endsWith(".js")
    ) {
      const sourcePath = path.resolve(
        path.dirname(context.originModulePath),
        `${moduleName.slice(0, -3)}.ts`,
      );
      if (fs.existsSync(sourcePath)) {
        return context.resolveRequest(context, sourcePath, platform);
      }
    }
    // Workspace packages publish source through `import`-only export
    // conditions. With inline requires (below), Metro records every static
    // import as a `require` dependency and would match the `require`
    // condition, which those packages do not declare. Resolve them as the ESM
    // imports they are written as; the bundle's module set is unchanged.
    if (moduleName.startsWith("@ryco/") && context.isESMImport !== true) {
      return context.resolveRequest({ ...context, isESMImport: true }, moduleName, platform);
    }
    return context.resolveRequest(context, moduleName, platform);
  },
  blockList: [
    ...(Array.isArray(config.resolver?.blockList)
      ? config.resolver.blockList
      : config.resolver?.blockList
        ? [config.resolver.blockList]
        : []),
    // Ryco keeps per-workspace state (managed worktrees, chat folders) under
    // `.ryco/` at the workspace root, which Metro must not crawl.
    new RegExp(`${escapedWorkspaceRoot}[/\\\\]\\.ryco[/\\\\].*`),
  ],
  extraNodeModules: {
    ...config.resolver?.extraNodeModules,
    "@ryco/mobile-third-party-licenses": generatedLicensesRoot,
    shiki: mobileShikiRoot,
    "@shikijs/core": resolveShikiDependencyRoot("@shikijs/core"),
    "@shikijs/engine-javascript": resolveShikiDependencyRoot("@shikijs/engine-javascript"),
    "@shikijs/engine-oniguruma": resolveShikiDependencyRoot("@shikijs/engine-oniguruma"),
    "@shikijs/langs": resolveShikiDependencyRoot("@shikijs/langs"),
    "@shikijs/themes": resolveShikiDependencyRoot("@shikijs/themes"),
    "@shikijs/types": resolveShikiDependencyRoot("@shikijs/types"),
    "@shikijs/vscode-textmate": resolveShikiDependencyRoot("@shikijs/vscode-textmate"),
  },
};

// Inline requires: a module's imports are evaluated where they are first used
// instead of before its body, so launch evaluates only what the first surface
// touches (about 1,250 of 2,330 modules by the time the splash hides, measured
// on a release build). Modules whose import registers something are imported
// bare from index.ts, which is never inlined, so registration order is
// unchanged. React and React Native stay eager: they are needed immediately,
// and so is the React Compiler runtime. babel-preset-expo compiles for React 19,
// whose output imports `react/compiler-runtime` (not the `react-compiler-runtime`
// polyfill), and keeping it eager leaves one module-level binding instead of a
// require lookup in every compiled render.
const NON_INLINED_REQUIRES = [
  "React",
  "react",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
  "react/compiler-runtime",
  "react-native",
];
config.transformer = {
  ...config.transformer,
  getTransformOptions: async () => ({
    transform: {
      experimentalImportSupport: true,
      inlineRequires: true,
      nonInlinedRequires: NON_INLINED_REQUIRES,
    },
  }),
};

const finalConfig = withUniwindConfig(config, {
  cssEntryFile: "./global.css",
  polyfills: { rem: 14 },
});

// A release bundle may not ship an npm package the license manifest leaves out (one a
// `buildOnlyDependencies` rule in third-party-licenses.config.json skipped by mistake, say):
// production serialization fails and names it. Development bundles carry dev-only modules and
// are not checked.
const serializeBundle = finalConfig.serializer.customSerializer;
if (typeof serializeBundle !== "function") {
  throw new Error("expo/metro-config no longer sets serializer.customSerializer; adapt the check.");
}
finalConfig.serializer = {
  ...finalConfig.serializer,
  customSerializer: async (entryPoint, preModules, graph, options) => {
    if (!options.dev) {
      const { findUnlistedBundledPackages } = await import(
        pathToFileURL(path.join(workspaceRoot, "scripts", "lib", "third-party-licenses.ts")).href
      );
      const manifest = JSON.parse(
        fs.readFileSync(path.join(generatedLicensesRoot, "manifest.json"), "utf8"),
      );
      const unlisted = await findUnlistedBundledPackages(manifest, [
        ...preModules.map((module) => module.path),
        ...graph.dependencies.keys(),
      ]);
      if (unlisted.length > 0) {
        throw new Error(
          `The bundle includes npm packages the open source license manifest does not list: ${unlisted.join(", ")}. Remove the third-party-licenses.config.json rule that skips them.`,
        );
      }
    }
    return serializeBundle(entryPoint, preModules, graph, options);
  },
};

module.exports = finalConfig;
