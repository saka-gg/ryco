// Node-only test helper; the app's react-native `tsconfig` resolves no Node builtins.
/// <reference types="node" />
/**
 * The pieces of Metro's transform that tests run for real: the app's Babel
 * config and `babel-preset-expo`, the `@babel/core` that preset loads, and the
 * `metro` that Expo's Metro config runs (its `metro-transform-plugins` are what
 * the worker applies after Babel). Each is resolved the way the bundler
 * resolves it, so a test transforms with exactly the copies a build uses.
 */
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);

/** `apps/mobile`. */
export const MOBILE_APP_DIR = join(import.meta.dirname, "..");
export const MOBILE_BABEL_CONFIG = join(MOBILE_APP_DIR, "babel.config.js");
export const BABEL_PRESET_EXPO = require.resolve("babel-preset-expo", { paths: [MOBILE_APP_DIR] });

/** Loads a module as `babel-preset-expo` does, e.g. `@babel/core`. */
export const requireFromBabelPreset = createRequire(BABEL_PRESET_EXPO);

/** Loads a module as Expo's Metro does, e.g. `metro-transform-plugins`. */
export const requireFromMetro = createRequire(
  createRequire(
    require.resolve("@expo/metro-config", {
      paths: [require.resolve("expo/package.json", { paths: [MOBILE_APP_DIR] })],
    }),
  ).resolve("metro/package.json"),
);

/**
 * The Babel caller Expo's Metro worker passes for an iOS transform once
 * `experiments.reactCompiler` is on; `isDev: false` is a release
 * `expo export:embed`.
 */
export function metroBabelCaller(isDev: boolean) {
  return {
    name: "metro",
    bundler: "metro",
    platform: "ios",
    supportsReactCompiler: true,
    isDev,
  } as const;
}
