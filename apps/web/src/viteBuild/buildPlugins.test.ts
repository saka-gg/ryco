import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { describe, expect, it } from "vite-plus/test";

import { BOOT_FONT_SOURCE_NAME, findBootFontAsset } from "./bootFontPreload";
import {
  createBootGraphMatcher,
  createWebCodeSplittingOptions,
  isLexicalModule,
  isMarkdownModule,
  isMergeableIconModule,
  isMergeableVendorModule,
  isReexportBarrel,
  isShikiModule,
  webChunkFileName,
  type ModuleGraphContext,
} from "./codeSplitting";
import { resolveWebModulePreloadDependencies } from "./modulePreload";
import {
  createPrecompressedAssetsPlugin,
  PRECOMPRESS_MIN_BYTES,
  shouldPrecompressAsset,
} from "./precompressAssets";

describe("resolveWebModulePreloadDependencies", () => {
  const deps = ["assets/a-12345678.js", "assets/b-12345678.css"];

  it("preloads a dynamic import's whole static closure", () => {
    expect(
      resolveWebModulePreloadDependencies("assets/main.js", [...deps], {
        hostId: "assets/index.js",
        hostType: "js",
      }),
    ).toEqual(deps);
  });

  it("keeps index.html free of eager preloads", () => {
    expect(
      resolveWebModulePreloadDependencies("assets/index.js", [...deps], {
        hostId: "index.html",
        hostType: "html",
      }),
    ).toEqual([]);
  });
});

describe("web code splitting", () => {
  const bun = (name: string, file: string) =>
    `/repo/node_modules/.bun/${name.replace("/", "+")}@1.0.0/node_modules/${name}/${file}`;

  it("merges only shared, side-effect-free vendor modules", () => {
    expect(isMergeableIconModule("/repo/node_modules/lucide-react/dist/esm/icons/x.js")).toBe(true);
    expect(isMergeableIconModule(bun("lucide-react", "dist/esm/icons/x.js"))).toBe(true);
    expect(isMergeableVendorModule("/repo/node_modules/@base-ui/react/esm/dialog/root.js")).toBe(
      true,
    );
    expect(isMergeableVendorModule("/repo/apps/web/src/components/Sidebar.tsx")).toBe(false);
    expect(isMergeableVendorModule("/repo/node_modules/mermaid/dist/chunks/x.mjs")).toBe(false);
    expect(isMergeableIconModule("/repo/apps/web/src/lucide-react/local.ts")).toBe(false);

    const { groups } = createWebCodeSplittingOptions({ bootEntry: "/repo/apps/web/src/main.tsx" });
    expect(groups.map((group) => (typeof group.name === "string" ? group.name : "boot"))).toEqual([
      "boot",
      "icons",
      "vendor",
      "lexical",
      "markdown-stack",
      "shiki-engine",
    ]);
    // The boot graph stays one chunk: a size split cut the effect runtime into
    // chunks that import each other, and boot then read uninitialised bindings.
    expect(groups[0]).not.toHaveProperty("maxSize");
    for (const group of groups) {
      // The boot group regroups modules every entry has already evaluated.
      if (!("minShareCount" in group)) continue;
      // Entry-private modules stay in their entry chunk.
      expect(group.minShareCount).toBe(2);
      expect(group.entriesAware).toBe(true);
      expect(group.entriesAwareMergeThreshold).toBeGreaterThanOrEqual(2048);
    }
  });

  it("gives lexical, the markdown stack and Shiki's engine stable vendor groups", () => {
    expect(isLexicalModule(bun("lexical", "dist/Lexical.prod.mjs"))).toBe(true);
    expect(isLexicalModule(bun("@lexical/react", "LexicalComposer.prod.mjs"))).toBe(true);
    expect(isLexicalModule("/repo/apps/web/src/components/ComposerPromptEditor.tsx")).toBe(false);

    expect(isMarkdownModule(bun("react-markdown", "lib/index.js"))).toBe(true);
    expect(isMarkdownModule(bun("micromark-core-commonmark", "lib/list.js"))).toBe(true);
    expect(isMarkdownModule(bun("mdast-util-from-markdown", "lib/index.js"))).toBe(true);
    expect(isMarkdownModule(bun("parse5", "dist/index.js"))).toBe(true);
    // Shiki's markdown grammar is an on-demand language entry, not the parser.
    expect(isMarkdownModule(bun("@shikijs/langs", "dist/markdown.mjs"))).toBe(false);
    expect(isMarkdownModule(bun("markdown-it", "index.mjs"))).toBe(false);

    expect(isShikiModule(bun("shiki", "dist/index.mjs"))).toBe(true);
    expect(isShikiModule(bun("@shikijs/core", "dist/index.mjs"))).toBe(true);
    expect(isShikiModule(bun("oniguruma-to-es", "dist/esm/index.js"))).toBe(true);
    // Grammars, themes and the WASM binary load on demand and stay their own chunks.
    expect(isShikiModule(bun("@shikijs/langs", "dist/typescript.mjs"))).toBe(false);
    expect(isShikiModule(bun("@shikijs/themes", "dist/github-dark.mjs"))).toBe(false);
    expect(isShikiModule(bun("@shikijs/engine-oniguruma", "dist/wasm-inlined.mjs"))).toBe(false);
    expect(isShikiModule(bun("shiki", "dist/wasm.mjs"))).toBe(false);
  });

  it("recognises pure re-export barrels", () => {
    expect(
      isReexportBarrel(
        '/** Barrel. */\nexport * from "./a.ts";\nexport { b, c as d } from "./b.ts";\nexport * as e from "./e.ts";\n',
      ),
    ).toBe(true);
    expect(isReexportBarrel('export * from "./a.ts";\nexport const local = 1;\n')).toBe(false);
    expect(isReexportBarrel('import "./setup.ts";\nexport * from "./a.ts";\n')).toBe(false);
    expect(isReexportBarrel("")).toBe(false);
  });

  it("puts the boot graph's own modules in the boot group, not modules behind packages or barrels", () => {
    const graph: Record<string, { code: string; importedIds: string[] }> = {
      "/repo/apps/web/src/main.tsx": {
        code: "main",
        importedIds: [
          "/repo/apps/web/src/router.ts",
          "/repo/apps/web/src/index.css",
          "/repo/packages/client-runtime/src/state/index.ts",
          "/repo/node_modules/lucide-react/dist/esm/lucide-react.js",
          "/repo/apps/web/src/worker.ts?worker",
          "\0vite/preload-helper.js",
        ],
      },
      "/repo/apps/web/src/router.ts": {
        code: "router",
        importedIds: ["/repo/packages/shared/src/git.ts", "/repo/apps/web/src/main.tsx"],
      },
      "/repo/packages/shared/src/git.ts": { code: "git", importedIds: [] },
      "/repo/apps/web/src/index.css": { code: "css", importedIds: [] },
      "/repo/packages/client-runtime/src/state/index.ts": {
        code: 'export * from "./composer.ts";\nexport * from "./threads.ts";\n',
        importedIds: [
          "/repo/packages/client-runtime/src/state/composer.ts",
          "/repo/packages/client-runtime/src/state/threads.ts",
        ],
      },
      "/repo/packages/client-runtime/src/state/composer.ts": { code: "composer", importedIds: [] },
      "/repo/packages/client-runtime/src/state/threads.ts": { code: "threads", importedIds: [] },
      "/repo/node_modules/lucide-react/dist/esm/lucide-react.js": {
        code: 'export * from "./icons/x.js";',
        importedIds: ["/repo/apps/web/src/notReallyReached.ts"],
      },
    };
    let lookups = 0;
    const context: ModuleGraphContext = {
      getModuleInfo: (id) => {
        lookups += 1;
        return graph[id] ?? null;
      },
    };
    const isBoot = createBootGraphMatcher("/repo/apps/web/src/main.tsx");
    const captured = [...Object.keys(graph), "/repo/apps/web/src/notReallyReached.ts"].filter(
      (id) => isBoot(id, context),
    );

    expect(captured).toEqual(["/repo/apps/web/src/router.ts", "/repo/packages/shared/src/git.ts"]);
    // The closure is computed once per chunking pass, not once per module.
    const afterFirstPass = lookups;
    isBoot("/repo/apps/web/src/router.ts", context);
    expect(lookups - afterFirstPass).toBe(1);
  });

  it("gives merged groups short file names and leaves other chunks alone", () => {
    expect(webChunkFileName({ name: "icons~main~RootAppShell~ChatView" })).toBe(
      "assets/icons-[hash].js",
    );
    expect(webChunkFileName({ name: "vendor" })).toBe("assets/vendor-[hash].js");
    expect(webChunkFileName({ name: "boot" })).toBe("assets/boot-[hash].js");
    expect(webChunkFileName({ name: "markdown-stack~ChatView~MarkdownView" })).toBe(
      "assets/markdown-stack-[hash].js",
    );
    expect(webChunkFileName({ name: "iconsPicker" })).toBe("assets/[name]-[hash].js");
    expect(webChunkFileName({ name: "markdown" })).toBe("assets/[name]-[hash].js");
    expect(webChunkFileName({ name: "RootAppShell" })).toBe("assets/[name]-[hash].js");
  });
});

describe("findBootFontAsset", () => {
  it("finds the hashed DM Sans latin face", () => {
    expect(
      findBootFontAsset({
        a: { type: "chunk", fileName: "assets/main-12345678.js" },
        b: {
          type: "asset",
          fileName: "assets/dm-sans-latin-wght-italic-12345678.woff2",
          names: ["dm-sans-latin-wght-italic.woff2"],
        },
        c: {
          type: "asset",
          fileName: "assets/dm-sans-latin-wght-normal-Xz1IZZA0.woff2",
          names: [BOOT_FONT_SOURCE_NAME],
        },
      }),
    ).toBe("assets/dm-sans-latin-wght-normal-Xz1IZZA0.woff2");
  });

  it("injects nothing when the face is not bundled", () => {
    expect(findBootFontAsset({})).toBeNull();
  });
});

describe("precompressed assets", () => {
  it("selects hashed, compressible files of at least 1 KiB", () => {
    expect(shouldPrecompressAsset("assets/main-C8t65ccR.js", 4096)).toBe(true);
    expect(shouldPrecompressAsset("assets/main-C8t65ccR.css", 4096)).toBe(true);
    expect(shouldPrecompressAsset("assets/quickjs-eval-zJSp5SB4.wasm", 4096)).toBe(true);
    expect(shouldPrecompressAsset("assets/main-C8t65ccR.js", PRECOMPRESS_MIN_BYTES - 1)).toBe(
      false,
    );
    expect(shouldPrecompressAsset("index.html", 4096)).toBe(false);
    expect(shouldPrecompressAsset("assets/main-C8t65ccR.js.map", 4096)).toBe(false);
    expect(shouldPrecompressAsset("assets/font-Xz1IZZA0.woff2", 4096)).toBe(false);
    expect(shouldPrecompressAsset("assets/logo-Xz1IZZA0.png", 4096)).toBe(false);
  });

  async function runPrecompression(
    files: Record<string, Buffer | string>,
    options?: Parameters<typeof createPrecompressedAssetsPlugin>[0],
  ): Promise<{ readonly outDir: string; readonly files: ReadonlyArray<string> }> {
    const outDir = await mkdtemp(path.join(tmpdir(), "ryco-precompress-"));
    for (const [name, contents] of Object.entries(files)) {
      await writeFile(path.join(outDir, name), contents);
    }
    const plugin = createPrecompressedAssetsPlugin(options);
    const configResolved = plugin.configResolved as (config: unknown) => void;
    configResolved({ root: outDir, build: { outDir: "." } });
    const writeBundle = plugin.writeBundle as (
      options: unknown,
      bundle: Record<string, { fileName: string }>,
    ) => Promise<void>;
    await writeBundle(
      {},
      Object.fromEntries(Object.keys(files).map((fileName) => [fileName, { fileName }])),
    );
    return { outDir, files: (await readdir(outDir)).toSorted() };
  }

  const compressible = Buffer.from("export const value = 1;\n".repeat(200));

  it("writes only byte-identical .gz siblings by default and skips small or incompressible files", async () => {
    const { outDir, files } = await runPrecompression({
      "main-C8t65ccR.js": compressible,
      "tiny-C8t65ccR.js": "export {};\n",
      "noise-C8t65ccR.wasm": randomBytes(4096),
    });
    try {
      expect(files).toEqual([
        "main-C8t65ccR.js",
        "main-C8t65ccR.js.gz",
        "noise-C8t65ccR.wasm",
        "tiny-C8t65ccR.js",
      ]);
      expect(gunzipSync(await readFile(path.join(outDir, "main-C8t65ccR.js.gz")))).toEqual(
        compressible,
      );
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("adds byte-identical .br siblings when brotli is enabled", async () => {
    const { outDir, files } = await runPrecompression(
      { "main-C8t65ccR.js": compressible, "noise-C8t65ccR.wasm": randomBytes(4096) },
      { brotli: true },
    );
    try {
      expect(files).toEqual([
        "main-C8t65ccR.js",
        "main-C8t65ccR.js.br",
        "main-C8t65ccR.js.gz",
        "noise-C8t65ccR.wasm",
      ]);
      expect(
        brotliDecompressSync(await readFile(path.join(outDir, "main-C8t65ccR.js.br"))),
      ).toEqual(compressible);
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });
});
