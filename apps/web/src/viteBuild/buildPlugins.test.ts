import { randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { describe, expect, it } from "vite-plus/test";

import { BOOT_FONT_SOURCE_NAME, findBootFontAsset } from "./bootFontPreload";
import { resolveBootAssets, type BundleGraphEntry } from "./bundleGraph";
import {
  createBootGraphMatcher,
  createBootVendorMatcher,
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
import { bootPreloadTags, resolveWebModulePreloadDependencies } from "./modulePreload";
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

  it("leaves index.html's hints to the boot preload plugin", () => {
    expect(
      resolveWebModulePreloadDependencies("assets/index.js", [...deps], {
        hostId: "index.html",
        hostType: "html",
      }),
    ).toEqual([]);
  });
});

describe("boot preload hints", () => {
  // `index.html`'s module script imports boot (the preload helper) and then the
  // app module dynamically; the app imports boot, its vendor chunk and the CSS.
  const entries: ReadonlyArray<BundleGraphEntry> = [
    {
      fileName: "assets/index-Entry123.js",
      isEntry: true,
      imports: ["assets/boot-Boot1234.js"],
      dynamicImports: ["assets/main-Main1234.js"],
    },
    {
      fileName: "assets/boot-Boot1234.js",
      imports: ["assets/boot-vendor-Vend1234.js", "assets/rolldown-runtime-Rt123456.js"],
      dynamicImports: ["assets/HostedHubRoot-Lazy1234.js"],
    },
    {
      fileName: "assets/boot-vendor-Vend1234.js",
      imports: ["assets/rolldown-runtime-Rt123456.js"],
    },
    { fileName: "assets/rolldown-runtime-Rt123456.js" },
    {
      fileName: "assets/main-Main1234.js",
      facadeModuleId: "/repo/apps/web/src/main.tsx",
      imports: ["assets/boot-Boot1234.js", "assets/boot-vendor-Vend1234.js"],
      importedCss: ["assets/main-Css12345.css"],
      importedAssets: ["assets/dm-sans-Font1234.woff2"],
    },
    { fileName: "assets/main-Css12345.css" },
    { fileName: "assets/HostedHubRoot-Lazy1234.js", imports: ["assets/icons-Icon1234.js"] },
  ];

  it("resolves the chain the entry evaluates before the app renders, helper first", () => {
    expect(resolveBootAssets(entries)).toEqual({
      entries: ["assets/index-Entry123.js"],
      modules: [
        "assets/index-Entry123.js",
        "assets/boot-Boot1234.js",
        "assets/boot-vendor-Vend1234.js",
        "assets/rolldown-runtime-Rt123456.js",
        "assets/main-Main1234.js",
      ],
      styles: ["assets/main-Css12345.css"],
    });
  });

  it("preloads the boot chain and its stylesheet, never a later phase", () => {
    const tags = bootPreloadTags(entries, "/base/");
    expect(tags.map((tag) => tag.attrs)).toEqual([
      { rel: "modulepreload", crossorigin: "", href: "/base/assets/boot-Boot1234.js" },
      { rel: "modulepreload", crossorigin: "", href: "/base/assets/boot-vendor-Vend1234.js" },
      { rel: "modulepreload", crossorigin: "", href: "/base/assets/rolldown-runtime-Rt123456.js" },
      { rel: "modulepreload", crossorigin: "", href: "/base/assets/main-Main1234.js" },
      // Same CORS mode as the stylesheet link the preload helper inserts.
      { rel: "preload", as: "style", crossorigin: "", href: "/base/assets/main-Css12345.css" },
    ]);
    // Link tags only: the hosted CSP allows exactly one inline script.
    expect(tags.every((tag) => tag.tag === "link" && tag.injectTo === "head")).toBe(true);
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
    expect(groups.map((group) => (typeof group.name === "string" ? group.name : "boot*"))).toEqual([
      "boot*",
      "boot*",
      "icons",
      "vendor",
      "lexical",
      "markdown-stack",
      "shiki-engine",
    ]);
    // The boot graph stays one chunk: a size split cut the effect runtime into
    // chunks that import each other, and boot then read uninitialised bindings.
    expect(groups[0]).not.toHaveProperty("maxSize");
    expect(groups[1]).not.toHaveProperty("maxSize");
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

  it("adds a build's boot roots and their static closure to the boot group", () => {
    const graph: Record<string, { code: string; importedIds: string[] }> = {
      "/repo/apps/web/src/main.tsx": { code: "main", importedIds: [] },
      "/repo/apps/web/src/routeViews/Layout.tsx": {
        code: "layout",
        importedIds: ["/repo/apps/web/src/store.ts"],
      },
      "/repo/apps/web/src/store.ts": { code: "store", importedIds: [] },
    };
    const context: ModuleGraphContext = { getModuleInfo: (id) => graph[id] ?? null };
    const withRoots = createBootGraphMatcher("/repo/apps/web/src/main.tsx", [
      "/repo/apps/web/src/routeViews/Layout.tsx",
    ]);
    const without = createBootGraphMatcher("/repo/apps/web/src/main.tsx");
    expect(withRoots("/repo/apps/web/src/routeViews/Layout.tsx", context)).toBe(true);
    expect(withRoots("/repo/apps/web/src/store.ts", context)).toBe(true);
    expect(without("/repo/apps/web/src/store.ts", context)).toBe(false);
  });

  it("puts the packages the boot graph imports in the boot vendor group", () => {
    const nm = "/repo/node_modules/.bun/pkg@1/node_modules";
    const graph: Record<string, { code: string; importedIds: string[] }> = {
      "/repo/apps/web/src/main.tsx": {
        code: "main",
        importedIds: ["/repo/apps/web/src/app.ts", `${nm}/react/index.js`],
      },
      "/repo/apps/web/src/app.ts": {
        code: "app",
        importedIds: [`${nm}/effect/dist/Schema.js`, `${nm}/lucide-react/dist/esm/icons/x.js`],
      },
      "/repo/apps/web/src/lazy.ts": { code: "lazy", importedIds: [`${nm}/shiki/index.js`] },
      [`${nm}/react/index.js`]: { code: "react", importedIds: [`${nm}/react/cjs/react.js`] },
      [`${nm}/react/cjs/react.js`]: { code: "react impl", importedIds: [] },
      [`${nm}/effect/dist/Schema.js`]: { code: "schema", importedIds: [] },
      [`${nm}/lucide-react/dist/esm/icons/x.js`]: { code: "icon", importedIds: [] },
      [`${nm}/shiki/index.js`]: { code: "shiki", importedIds: [] },
    };
    const context: ModuleGraphContext = { getModuleInfo: (id) => graph[id] ?? null };
    const isBootVendor = createBootVendorMatcher("/repo/apps/web/src/main.tsx");
    const captured = Object.keys(graph).filter((id) => isBootVendor(id, context));
    expect(captured).toEqual([
      `${nm}/react/index.js`,
      `${nm}/react/cjs/react.js`,
      `${nm}/effect/dist/Schema.js`,
    ]);
    // Ahead of `boot`, which would otherwise take them along as dependencies.
    const { groups } = createWebCodeSplittingOptions({ bootEntry: "/repo/apps/web/src/main.tsx" });
    const [boot, bootVendor] = groups as unknown as ReadonlyArray<{
      readonly name: (id: string, context: ModuleGraphContext) => string | null;
      readonly priority: number;
    }>;
    expect(boot!.name("/repo/apps/web/src/app.ts", context)).toBe("boot");
    expect(bootVendor!.name(`${nm}/react/index.js`, context)).toBe("boot-vendor");
    expect(bootVendor!.priority).toBeGreaterThan(boot!.priority);
  });

  it("gives merged groups short file names and leaves other chunks alone", () => {
    expect(webChunkFileName({ name: "boot-vendor" })).toBe("assets/boot-vendor-[hash].js");
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

describe("public icons", () => {
  // Losslessly optimised (oxipng, PNG frames in the ICO). The manifest icons
  // download on every PWA install or update and the Hub serves them no-store.
  const ceilings: ReadonlyArray<readonly [string, number]> = [
    ["web-app-manifest-512x512.png", 128 * 1024],
    ["web-app-manifest-192x192.png", 24 * 1024],
    ["apple-touch-icon.png", 24 * 1024],
    ["favicon-96x96.png", 8 * 1024],
    ["favicon.ico", 8 * 1024],
  ];

  it.each(ceilings)("keeps %s small", (file, ceiling) => {
    const size = statSync(new URL(`../../public/${file}`, import.meta.url)).size;
    expect(size).toBeLessThanOrEqual(ceiling);
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
