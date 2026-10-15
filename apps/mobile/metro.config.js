const fs = require("node:fs");
const path = require("node:path");
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
      moduleName.startsWith("./") &&
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
    new RegExp(`${escapedWorkspaceRoot}[/\\\\]\\.t3[/\\\\].*`),
  ],
  extraNodeModules: {
    // oxlint-disable-next-line unicorn/no-useless-fallback-in-spread
    ...(config.resolver?.extraNodeModules ?? {}),
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

module.exports = withUniwindConfig(config, {
  cssEntryFile: "./global.css",
  polyfills: { rem: 14 },
});
