import * as path from "node:path";
import { defineConfig, mergeConfig } from "vite-plus";

import { REAL_TIME_WAIT_LEGACY_FILES } from "./scripts/oxlint-plugin/legacy/realTimeWaitFiles.ts";

/**
 * `effect`'s root re-exports every module. Metro does not tree-shake, so one
 * root import anywhere in the mobile graph evaluates all of them at startup.
 */
const EFFECT_ROOT_IMPORT = {
  name: "effect",
  message:
    "Import the Effect module you use (e.g. effect/Schema); the root barrel pulls every module into the startup graph.",
};

/**
 * Each of `effect`'s directory indexes re-exports every module beneath it the
 * same way: `effect/reactivity` alone pulls in AtomHttpApi and the HTTP client
 * and server stack. Import the module itself (e.g. effect/reactivity/Atom).
 * `paths` match exactly, so the deep module paths stay allowed.
 */
const EFFECT_SUBBARREL_IMPORTS = [
  "ai",
  "cli",
  "cluster",
  "devtools",
  "encoding",
  "eventlog",
  "http",
  "http-api",
  "index",
  "net",
  "observability",
  "persistence",
  "process",
  "reactivity",
  "rpc",
  "schema",
  "socket",
  "sql",
  "testing",
  "workers",
  "workflow",
].map((directory) => ({
  name: `effect/${directory}`,
  message: `Import the module you use (e.g. effect/${directory}/<Module>); the effect/${directory} index pulls every module beneath it into the startup graph.`,
}));

/**
 * The same holds for the `@ryco/contracts` root: it re-exports every schema
 * module. Values come from the module's subpath (e.g. @ryco/contracts/orchestration);
 * types may stay on the root, since they are erased.
 */
const CONTRACTS_ROOT_IMPORT = {
  name: "@ryco/contracts",
  message:
    "Import values from the contracts module's subpath (e.g. @ryco/contracts/orchestration); the root barrel pulls every schema module into the mobile startup graph.",
  allowTypeImports: true,
};

const CLIENT_RUNTIME_RESTRICTED_PATTERNS = [
  {
    group: ["react", "react/*", "react-dom", "react-dom/*"],
    message: "@ryco/client-runtime is platform-neutral.",
  },
  {
    group: ["@effect/atom-react", "@effect/atom-react/*"],
    message: "React bindings belong in the app.",
  },
  {
    group: ["node:*", "node:*/**"],
    message: "Node built-ins are not available in @ryco/client-runtime.",
  },
  {
    group: ["@tanstack", "@tanstack/*"],
    message: "TanStack bindings belong in the app.",
  },
  {
    group: ["~", "~/*"],
    message: "@ryco/client-runtime must not import from the web app.",
  },
];

const TABLER_ROOT_IMPORT = {
  name: "@tabler/icons-react-native",
  message:
    "The package root evaluates every Tabler icon at startup. Import from apps/mobile/src/components/icons (one deep module per icon).",
  allowTypeImports: true,
};

/**
 * `correctness` and `suspicious` rules fail lint. These stay warnings: each
 * still has open hits (counts from 2026-11-14), and most are React Compiler
 * advisories or patterns that need a component-by-component look. Promote one
 * to an error once its count reaches zero.
 */
const WARN_ONLY_RULES = [
  "eslint/no-unused-vars", // 69 outside .docs
  "eslint/no-unused-expressions", // 4 outside .docs
  "eslint/no-unmodified-loop-condition", // 6, loops whose flag a callback flips
  "unicorn/no-useless-spread", // 36
  "unicorn/no-array-sort", // 42
  "unicorn/no-array-reverse", // 8
  "unicorn/prefer-add-event-listener", // 3
  "react/set-state-in-effect", // 141
  "react/refs", // 129
  "react/exhaustive-effect-dependencies", // 75
  "react/purity", // 30
  "react/memo-dependencies", // 18
  "react/exhaustive-deps", // 12
  "react/preserve-manual-memoization", // 9
  "react/immutability", // 7
  "react/capitalized-calls", // 5
  "react/static-components", // 3
  "react/globals", // 2
  "react/use-memo", // 1
] as const;

/**
 * Patterns tests use on purpose: optional chains cast before a call (a miss
 * fails the test anyway), empty fake classes, generators that never yield.
 */
const TEST_ONLY_WARN_RULES = [
  "eslint/no-unsafe-optional-chaining",
  "eslint/no-unexpected-multiline",
  "eslint/require-yield",
  "eslint/no-control-regex",
  "typescript/no-this-alias",
  "typescript/no-extraneous-class",
  "unicorn/no-array-fill-with-reference-type",
] as const;

const rootConfig = {
  resolve: {
    alias: {
      "~": path.resolve(import.meta.dirname, "./apps/web/src"),
    },
  },
  test: {
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
  staged: {
    // Format fixes only: lint autofixes can change semantics (the
    // unicorn/require-module-specifiers fix breaks apps/mobile/uniwind-types.d.ts),
    // so lint only reports here.
    "*": [
      "vp check --fix --no-lint --no-error-on-unmatched-pattern",
      "vp check --no-fmt --quiet --no-error-on-unmatched-pattern",
    ],
  },
  fmt: {
    ignorePatterns: [
      ".reference",
      ".plans",
      "dist",
      "dist-electron",
      "node_modules",
      "bun.lock",
      "*.tsbuildinfo",
      "**/routeTree.gen.ts",
      "apps/web/test/public/mockServiceWorker.js",
      "apps/web/src/lib/vendor/qrcodegen.ts",
      "*.icon/**",
      // Generated and transcoded test vectors. `scripts/generate-e2ee-fixtures.ts`
      // owns these bytes and a drift test compares them byte for byte
      // (docs/relay-e2ee-protocol.md §16.1), so a formatter rewriting them would
      // put the two in permanent conflict.
      "packages/shared/fixtures/e2ee/v1/*.json",
      // The terminal renderer document. `apps/mobile/scripts/build-terminal-renderer.mts`
      // generates it, its CSP pins the inline script's hash, and a test compares
      // it to a fresh build byte for byte.
      "apps/mobile/src/features/terminal/renderer/terminal-renderer.html",
      // The device viewer's document, generated and hash-pinned the same way
      // (`apps/mobile/scripts/build-device-stream-renderer.mts`).
      "apps/mobile/src/features/devices/stream/renderer/device-stream.html",
      // Reports, mockups and screenshots committed as finished artifacts. Several
      // are generated or minified HTML; formatting them is noise, and an
      // unformatted one failed Format, which also skipped Lint and Typecheck in CI.
      "output/**",
    ],
    sortPackageJson: {},
    overrides: [
      {
        files: [".devcontainer/devcontainer.json"],
        options: {
          trailingComma: "none",
        },
      },
    ],
  },
  lint: {
    ignorePatterns: [
      "dist",
      "dist-electron",
      "node_modules",
      "bun.lock",
      "*.tsbuildinfo",
      "**/routeTree.gen.ts",
    ],
    plugins: ["eslint", "oxc", "react", "unicorn", "typescript"],
    // Ryco's own rules, reported as `ryco/<rule>` (scripts/oxlint-plugin).
    jsPlugins: ["./scripts/oxlint-plugin/index.ts"],
    categories: {
      correctness: "error",
      suspicious: "error",
      perf: "warn",
    },
    rules: {
      ...Object.fromEntries(WARN_ONLY_RULES.map((rule) => [rule, "warn"])),
      "react-in-jsx-scope": "off",
      "eslint/no-shadow": "off",
      "eslint/no-await-in-loop": "off",
      "eslint/no-underscore-dangle": "off",
      "react/no-object-type-as-default-prop": "off",
      "react/no-unstable-nested-components": "off",
      "unicorn/consistent-function-scoping": "off",
      "ryco/no-partial-runtime-mock-in-browser-tests": "error",
      "ryco/no-raw-mcp-dispatch": "error",
      "ryco/no-real-time-wait-in-tests": "error",
      "ryco/prefer-shared-error-message": "error",
      "ryco/require-suppression-reason": "error",
    },
    overrides: [
      {
        files: [
          "**/*.test.{ts,tsx}",
          "**/*.browser.{ts,tsx}",
          "**/test/**/*.{ts,tsx}",
          "apps/server/integration/**",
        ],
        rules: Object.fromEntries(TEST_ONLY_WARN_RULES.map((rule) => [rule, "warn"])),
      },
      {
        // Design prototypes, not shipped code.
        files: [".docs/**"],
        rules: {
          "eslint/no-control-regex": "warn",
          "oxc/only-used-in-recursion": "warn",
          "unicorn/prefer-string-starts-ends-with": "warn",
        },
      },
      {
        // Generated by Uniwind.
        files: ["apps/mobile/uniwind-types.d.ts"],
        rules: { "unicorn/require-module-specifiers": "off" },
      },
      {
        // Waited on the real clock before the rule existed; the list only shrinks.
        files: [...REAL_TIME_WAIT_LEGACY_FILES],
        rules: { "ryco/no-real-time-wait-in-tests": "off" },
      },
      {
        files: ["packages/client-runtime/src/**/*.{ts,tsx}"],
        rules: {
          "no-restricted-imports": [
            "error",
            {
              paths: [EFFECT_ROOT_IMPORT, ...EFFECT_SUBBARREL_IMPORTS, CONTRACTS_ROOT_IMPORT],
              patterns: CLIENT_RUNTIME_RESTRICTED_PATTERNS,
            },
          ],
        },
      },
      {
        // Shared by every client, so their modules sit in the mobile startup graph.
        files: ["packages/{contracts,shared}/src/**/*.{ts,tsx}"],
        rules: {
          "no-restricted-imports": [
            "error",
            { paths: [EFFECT_ROOT_IMPORT, ...EFFECT_SUBBARREL_IMPORTS, CONTRACTS_ROOT_IMPORT] },
          ],
        },
      },
      {
        // Tests never reach a client's startup graph.
        files: ["packages/client-runtime/src/**/*.test.{ts,tsx}"],
        rules: {
          "no-restricted-imports": ["error", { patterns: CLIENT_RUNTIME_RESTRICTED_PATTERNS }],
        },
      },
      {
        files: ["packages/{contracts,shared}/src/**/*.test.{ts,tsx}"],
        rules: {
          "no-restricted-imports": "off",
        },
      },
      {
        files: ["apps/mobile/**/*.{ts,tsx}"],
        rules: {
          "no-restricted-imports": [
            "error",
            {
              paths: [
                TABLER_ROOT_IMPORT,
                EFFECT_ROOT_IMPORT,
                ...EFFECT_SUBBARREL_IMPORTS,
                CONTRACTS_ROOT_IMPORT,
              ],
            },
          ],
        },
      },
      {
        // Tests never reach the app's startup graph.
        files: ["apps/mobile/**/*.test.{ts,tsx}"],
        rules: {
          "no-restricted-imports": [
            "error",
            {
              paths: [TABLER_ROOT_IMPORT, EFFECT_ROOT_IMPORT, ...EFFECT_SUBBARREL_IMPORTS],
            },
          ],
        },
      },
    ],
  },
};

export default defineConfig(async () => {
  const isVpBuild = process.argv.some((arg) => arg === "build");
  if (!isVpBuild) {
    return rootConfig;
  }

  const { default: webConfig } = await import("./apps/web/vite.config");
  return mergeConfig(webConfig, {
    ...rootConfig,
    root: path.resolve(import.meta.dirname, "./apps/web"),
  });
});
