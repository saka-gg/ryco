import { assert, describe, it } from "@effect/vitest";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { checkBundleBudgets, formatBundleBudgetReport } from "./bundleBudget.ts";
import {
  findChunk,
  normalizeSourcePath,
  parseChunkImports,
  readBundleGraph,
  staticClosure,
} from "./bundleGraph.ts";
import { DEFAULT_BUNDLE_BUDGET_POLICY, type BundleBudgetPolicy } from "./model.ts";

interface FakeChunk {
  readonly code: string;
  readonly sources?: readonly string[];
}

function withDist(chunks: Record<string, FakeChunk>, run: (distDir: string) => void): void {
  const distDir = mkdtempSync(path.join(os.tmpdir(), "ryco-bundle-budget-"));
  try {
    const assetsDir = path.join(distDir, "assets");
    mkdirSync(assetsDir);
    for (const [file, chunk] of Object.entries(chunks)) {
      writeFileSync(path.join(assetsDir, file), chunk.code);
      if (chunk.sources) {
        writeFileSync(
          path.join(assetsDir, `${file}.map`),
          JSON.stringify({ version: 3, sources: chunk.sources, mappings: "" }),
        );
      }
    }
    run(distDir);
  } finally {
    rmSync(distDir, { recursive: true, force: true });
  }
}

const POLICY: BundleBudgetPolicy = {
  bootChunk: "main",
  closures: [
    {
      name: "boot",
      chunk: "main",
      beyondBoot: false,
      maxGzipBytes: 10_000,
      forbiddenSources: [{ pattern: /^node_modules\/@noble\//u, reason: "relay crypto" }],
    },
    {
      name: "Shell",
      chunk: "Shell",
      beyondBoot: true,
      maxGzipBytes: 10_000,
      forbiddenSources: [{ pattern: /^node_modules\/react-markdown\//u, reason: "markdown" }],
    },
  ],
};

describe("bundle graph", () => {
  it("separates static from dynamic chunk imports", () => {
    const parsed = parseChunkImports(
      'import{a}from"./shared-AAAAAAAA.js";export{b}from"./re-BBBBBBBB.js";const l=()=>import("./lazy-CCCCCCCC.js");',
    );
    assert.deepStrictEqual(parsed.staticImports, ["shared-AAAAAAAA.js", "re-BBBBBBBB.js"]);
    assert.deepStrictEqual(parsed.dynamicImports, ["lazy-CCCCCCCC.js"]);
  });

  it("maps sourcemap sources to repository paths whatever the dist location", () => {
    assert.equal(normalizeSourcePath("../../src/main.tsx"), "apps/web/src/main.tsx");
    assert.equal(
      normalizeSourcePath("../../../../packages/shared/src/relayE2eeKeys.ts"),
      "packages/shared/src/relayE2eeKeys.ts",
    );
    assert.equal(
      normalizeSourcePath(
        "../../../../node_modules/.bun/@noble+curves@2.3.0/node_modules/@noble/curves/ed25519.js",
      ),
      "node_modules/@noble/curves/ed25519.js",
    );
  });

  it("follows static imports only", () => {
    withDist(
      {
        "main-AAAAAAAA.js": { code: 'import"./dep-BBBBBBBB.js";import("./lazy-CCCCCCCC.js");' },
        "dep-BBBBBBBB.js": { code: "export const dep = 1;" },
        "lazy-CCCCCCCC.js": { code: "export const lazy = 1;" },
      },
      (distDir) => {
        const graph = readBundleGraph(path.join(distDir, "assets"));
        const main = findChunk(graph, "main");
        assert.equal(main, "main-AAAAAAAA.js");
        assert.deepStrictEqual([...staticClosure(graph, main!)].toSorted(), [
          "dep-BBBBBBBB.js",
          "main-AAAAAAAA.js",
        ]);
      },
    );
  });
});

describe("bundle budgets", () => {
  it("passes a clean standard build", () => {
    withDist(
      {
        "main-AAAAAAAA.js": {
          code: 'import"./runtime-BBBBBBBB.js";import("./Shell-CCCCCCCC.js");',
          sources: ["../../src/main.tsx"],
        },
        "runtime-BBBBBBBB.js": { code: "export const r = 1;" },
        "Shell-CCCCCCCC.js": {
          code: 'import"./runtime-BBBBBBBB.js";',
          sources: ["../../src/components/Shell.tsx"],
        },
      },
      (distDir) => {
        const report = checkBundleBudgets(distDir, POLICY);
        assert.deepStrictEqual(report.violations, []);
        assert.equal(report.closures[0]?.size?.files, 2);
        // The shell is measured beyond what boot already loads.
        assert.equal(report.closures[1]?.size?.files, 1);
        assert.match(
          formatBundleBudgetReport(report),
          /All budgets and forbidden-module rules pass/u,
        );
      },
    );
  });

  it("reports forbidden modules once per rule with the chunk that carries them", () => {
    withDist(
      {
        "main-AAAAAAAA.js": {
          code: 'import"./auth-BBBBBBBB.js";import("./Shell-CCCCCCCC.js");',
          sources: ["../../src/main.tsx"],
        },
        "auth-BBBBBBBB.js": {
          code: "export const a = 1;",
          sources: [
            "../../../../node_modules/.bun/@noble+curves@2.3.0/node_modules/@noble/curves/ed25519.js",
            "../../../../node_modules/.bun/@noble+hashes@2.3.0/node_modules/@noble/hashes/sha2.js",
          ],
        },
        "Shell-CCCCCCCC.js": {
          code: 'import"./md-DDDDDDDD.js";',
          sources: ["../../src/components/Shell.tsx"],
        },
        "md-DDDDDDDD.js": {
          code: "export const md = 1;",
          sources: ["../../../../node_modules/react-markdown/lib/index.js"],
        },
      },
      (distDir) => {
        const report = checkBundleBudgets(distDir, POLICY);
        assert.deepStrictEqual(
          report.violations.map((violation) => violation.closure),
          ["boot", "Shell"],
        );
        assert.include(report.violations[0]!.message, "relay crypto");
        assert.include(report.violations[0]!.message, "and 1 more module(s)");
        assert.include(report.violations[0]!.message, "auth-BBBBBBBB.js");
        assert.include(report.violations[1]!.message, "node_modules/react-markdown/lib/index.js");
      },
    );
  });

  it("fails a closure over its gzip budget and a closure whose chunk disappeared", () => {
    withDist(
      {
        "main-AAAAAAAA.js": {
          code: `export const big = "${"x".repeat(64)}";`,
          sources: ["../../src/main.tsx"],
        },
      },
      (distDir) => {
        const report = checkBundleBudgets(distDir, {
          bootChunk: "main",
          closures: [{ ...POLICY.closures[0]!, maxGzipBytes: 1 }, { ...POLICY.closures[1]! }],
        });
        assert.match(report.violations[0]!.message, /exceeds the 0\.0 KiB budget/u);
        assert.match(report.violations[1]!.message, /No 'Shell-\*\.js' chunk was emitted/u);
      },
    );
  });

  it("fails a closure that loads more files than its budget", () => {
    withDist(
      {
        "main-AAAAAAAA.js": {
          code: 'import"./a-BBBBBBBB.js";import"./b-CCCCCCCC.js";',
          sources: ["../../src/main.tsx"],
        },
        "a-BBBBBBBB.js": { code: "export const a = 1;" },
        "b-CCCCCCCC.js": { code: "export const b = 1;" },
      },
      (distDir) => {
        const within = checkBundleBudgets(distDir, {
          bootChunk: "main",
          closures: [{ ...POLICY.closures[0]!, maxFiles: 3 }],
        });
        assert.deepStrictEqual(within.violations, []);
        const over = checkBundleBudgets(distDir, {
          bootChunk: "main",
          closures: [{ ...POLICY.closures[0]!, maxFiles: 2 }],
        });
        assert.match(over.violations[0]!.message, /3 JS files exceed the 2-file budget/u);
      },
    );
  });

  it("keeps the WebAssembly engine out of the diff highlight worker", () => {
    const [workerRule] = DEFAULT_BUNDLE_BUDGET_POLICY.chunks ?? [];
    assert.isDefined(workerRule);
    const policy: BundleBudgetPolicy = { bootChunk: "main", closures: [], chunks: [workerRule!] };
    const main = { code: "export {};", sources: ["../../src/main.tsx"] };
    withDist(
      {
        "main-AAAAAAAA.js": main,
        // An ES module worker that loads the engine chunk on demand.
        "worker-BBBBBBBB.js": { code: "const e=()=>import(`./wasm-CCCCCCCC.js`);" },
        "wasm-CCCCCCCC.js": { code: "var e=Uint8Array.from(atob(`AGFzbQEAAAAB`));" },
      },
      (distDir) => {
        assert.deepStrictEqual(checkBundleBudgets(distDir, policy).violations, []);
      },
    );
    withDist(
      {
        "main-AAAAAAAA.js": main,
        // An IIFE worker with the engine inlined.
        "worker-BBBBBBBB.js": {
          code: `(function(){var e=Uint8Array.from(atob(\`AGFzbQEAAAAB${"A".repeat(500 * 1024)}\`))})();`,
        },
      },
      (distDir) => {
        const messages = checkBundleBudgets(distDir, policy).violations.map(
          (violation) => violation.message,
        );
        assert.strictEqual(messages.length, 2);
        assert.match(messages[0]!, /over the 400\.0 KiB budget/u);
        assert.match(messages[1]!, /inlined WebAssembly binary/u);
      },
    );
    withDist(
      {
        "main-AAAAAAAA.js": main,
        // An ES module worker that imports the engine chunk statically.
        "worker-BBBBBBBB.js": { code: `import"./wasm-CCCCCCCC.js";` },
        "wasm-CCCCCCCC.js": {
          code: `var e=Uint8Array.from(atob(\`AGFzbQEAAAAB${"A".repeat(500 * 1024)}\`));`,
        },
      },
      (distDir) => {
        const messages = checkBundleBudgets(distDir, policy).violations.map(
          (violation) => violation.message,
        );
        assert.strictEqual(messages.length, 2);
        assert.match(messages[0]!, /with its static imports \(2 files\), over the 400\.0 KiB/u);
        assert.match(
          messages[1]!,
          /statically imports wasm-CCCCCCCC\.js, which carries an inlined WebAssembly binary/u,
        );
      },
    );
    withDist(
      {
        "main-AAAAAAAA.js": main,
        "worker-BBBBBBBB.js": { code: "export {};" },
        "worker-DDDDDDDD.js": { code: "export {};" },
      },
      (distDir) => {
        assert.match(
          checkBundleBudgets(distDir, policy).violations[0]!.message,
          /2 chunks match 'worker-\*\.js'/u,
        );
      },
    );
    withDist({ "main-AAAAAAAA.js": main }, (distDir) => {
      assert.match(
        checkBundleBudgets(distDir, policy).violations[0]!.message,
        /No 'worker-\*\.js' chunk was emitted/u,
      );
    });
  });

  it("refuses dists it cannot judge", () => {
    withDist({ "main-AAAAAAAA.js": { code: "export {};" } }, (distDir) => {
      assert.throws(() => checkBundleBudgets(distDir, POLICY), /no sourcemaps/u);
      writeFileSync(path.join(distDir, "service-worker.js"), "");
      assert.throws(() => checkBundleBudgets(distDir, POLICY), /hosted-hub build/u);
    });
  });

  it("names every default closure after a module the web build loads as its own chunk", () => {
    // Rolldown names a dynamically imported entry's chunk after its module, so
    // a renamed or merged route view fails the dist check ("no chunk was
    // emitted"). Catch that here, without a build.
    const webSrc = fileURLToPath(new URL("../../apps/web/src/", import.meta.url));
    const files = readdirSync(webSrc, { recursive: true, encoding: "utf8" }).filter(
      (file) => /\.tsx?$/u.test(file) && !/\.(?:test|browser)\.tsx?$/u.test(file),
    );
    const sources = files.map((file) => readFileSync(path.join(webSrc, file), "utf8"));
    for (const closure of DEFAULT_BUNDLE_BUDGET_POLICY.closures) {
      if (closure.chunk === DEFAULT_BUNDLE_BUDGET_POLICY.bootChunk) continue;
      assert.isTrue(
        files.some((file) => path.basename(file).replace(/\.tsx?$/u, "") === closure.chunk),
        `${closure.name}: no apps/web/src module named ${closure.chunk}`,
      );
      assert.isTrue(
        sources.some((source) =>
          new RegExp(`import\\(\\s*["'][^"']*/${closure.chunk}["']\\s*\\)`, "u").test(source),
        ),
        `${closure.name}: nothing imports ${closure.chunk} dynamically`,
      );
    }
  });

  it("forbids the chat route's deferred surfaces and server-only schemas statically", () => {
    for (const name of ["ChatThreadRouteView", "DraftChatThreadRouteView"]) {
      const closure = DEFAULT_BUNDLE_BUDGET_POLICY.closures.find((entry) => entry.name === name)!;
      const forbidden = (source: string) =>
        closure.forbiddenSources.some((rule) => rule.pattern.test(source));
      for (const source of [
        "apps/web/src/components/chat/ChatOverviewPanel.tsx",
        "apps/web/src/components/overview/crown/CrownOverview.tsx",
        "apps/web/src/components/worktrees/LinkedWorktreeItemDialog.tsx",
        "apps/web/src/components/shell/phone/PhoneThreadAppBar.tsx",
        "apps/web/src/components/chat/MessageActionsSheet.tsx",
        "node_modules/@pierre/diffs/dist/index.js",
        "node_modules/shiki/dist/index.mjs",
        "node_modules/parse5/dist/index.js",
        "packages/contracts/src/agentControlMcp.ts",
      ]) {
        assert.isTrue(forbidden(source), `${name}: ${source}`);
      }
      for (const source of [
        // Statically shared with the route: layout constants, the lazy
        // wrappers themselves, and the chat markdown renderer.
        "apps/web/src/components/overview/crown/crownLayout.ts",
        "apps/web/src/components/shell/phone/lazyPhoneThreadSurfaces.ts",
        "apps/web/src/components/worktrees/lazyWorktreeDialogs.ts",
        "node_modules/react-markdown/lib/index.js",
        "packages/contracts/src/agentControl.ts",
      ]) {
        assert.isFalse(forbidden(source), `${name}: ${source}`);
      }
    }
  });

  it("forbids the hosted runtime in every default standard closure", () => {
    for (const closure of DEFAULT_BUNDLE_BUDGET_POLICY.closures) {
      const forbidden = (source: string) =>
        closure.forbiddenSources.some((rule) => rule.pattern.test(source));
      assert.isTrue(forbidden("node_modules/@noble/curves/ed25519.js"), closure.name);
      assert.isTrue(forbidden("apps/web/src/hostedHub/state.ts"), closure.name);
      assert.isFalse(forbidden("apps/web/src/hostedHub/state.standard.ts"), closure.name);
      assert.isFalse(
        forbidden("packages/client-runtime/src/authorization/nodeMutationLease.ts"),
        closure.name,
      );
      assert.isFalse(
        forbidden("packages/client-runtime/src/authorization/hostedStores.ts"),
        closure.name,
      );
      assert.isTrue(forbidden("packages/client-runtime/src/authorization/state.ts"), closure.name);
    }
  });
});
