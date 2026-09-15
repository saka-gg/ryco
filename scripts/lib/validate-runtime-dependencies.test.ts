import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectRuntimeImports,
  validateStagedNativePayloads,
  validateStagedRuntimeDependencies,
} from "./validate-runtime-dependencies.ts";

const roots: string[] = [];
function write(root: string, file: string, content = "payload"): string {
  const target = join(root, file);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
  return target;
}
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "ryco-runtime-deps-test-"));
  roots.push(root);
  const stage = join(root, "stage");
  write(stage, "apps/desktop/dist-electron/main.cjs", 'require("electron"); require("node:fs");');
  write(stage, "apps/server/dist/bin.mjs", 'import "node:path";');
  return stage;
}
function dependency(stage: string, name: string, exports: unknown): void {
  write(stage, `node_modules/${name}/package.json`, JSON.stringify({ name, exports }));
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("staged runtime imports", () => {
  it("parses actual imports, re-exports, lazy imports and requires, ignoring strings/comments", () => {
    expect(
      collectRuntimeImports(`
      import "static";
      export { x } from "re-export";
      import("lazy");
      require("commonjs");
      // require("comment");
      const text = 'import("string")';
      require(variable);
    `),
    ).toEqual([
      { specifier: "static", kind: "import" },
      { specifier: "re-export", kind: "import" },
      { specifier: "lazy", kind: "import" },
      { specifier: "commonjs", kind: "require" },
    ]);
  });

  it("uses the correct import and require export conditions and scoped subpaths", () => {
    const stage = fixture();
    dependency(stage, "@fixture/dual", {
      "./entry": { import: "./import.mjs", require: "./require.cjs" },
    });
    write(stage, "node_modules/@fixture/dual/import.mjs", "export {}; ");
    write(stage, "node_modules/@fixture/dual/require.cjs", "module.exports = {}; ");
    write(stage, "apps/server/dist/bin.mjs", 'import "@fixture/dual/entry";');
    write(stage, "apps/desktop/dist-electron/main.cjs", 'require("@fixture/dual/entry");');
    expect(validateStagedRuntimeDependencies(stage)).toBe(2);
    rmSync(join(stage, "node_modules/@fixture/dual/import.mjs"));
    expect(() => validateStagedRuntimeDependencies(stage)).toThrow(
      /bin\.mjs -> @fixture\/dual\/entry/,
    );
  });

  it("checks lazy chunks and rejects an external absent from the stage", () => {
    const stage = fixture();
    write(
      stage,
      "apps/server/dist/provider.mjs",
      'export const load = () => import("missing-sdk");',
    );
    expect(() => validateStagedRuntimeDependencies(stage)).toThrow(/provider\.mjs -> missing-sdk/);
  });

  it("does not resolve a missing dependency from ancestor development node_modules", () => {
    const stage = fixture();
    dependency(dirname(stage), "workspace-only", "./index.js");
    write(dirname(stage), "node_modules/workspace-only/index.js", "module.exports = {}; ");
    write(stage, "apps/desktop/dist-electron/main.cjs", 'require("workspace-only");');
    expect(() => validateStagedRuntimeDependencies(stage)).toThrow(
      /workspace-only: resolves outside/,
    );
  });

  it("rejects symlinks to packages outside the stage even when Node resolves them", () => {
    const stage = fixture();
    dependency(dirname(stage), "workspace-only", "./index.js");
    write(dirname(stage), "node_modules/workspace-only/index.js", "module.exports = {}; ");
    mkdirSync(join(stage, "node_modules"));
    symlinkSync(
      join(dirname(stage), "node_modules/workspace-only"),
      join(stage, "node_modules/workspace-only"),
      "junction",
    );
    write(stage, "apps/server/dist/bin.mjs", 'import "workspace-only";');
    expect(() => validateStagedRuntimeDependencies(stage)).toThrow(/resolves outside/);
  });

  it("rejects missing relative chunks and missing entries", () => {
    const stage = fixture();
    write(stage, "apps/server/dist/bin.mjs", 'import "./missing.mjs";');
    expect(() => validateStagedRuntimeDependencies(stage)).toThrow(/bin\.mjs -> \.\/missing\.mjs/);
    rmSync(join(stage, "apps/server/dist/bin.mjs"));
    expect(() => validateStagedRuntimeDependencies(stage)).toThrow("Missing staged entry");
  });

  it("allows Electron only in the desktop and ignores the unused server CJS variant", () => {
    const stage = fixture();
    write(stage, "apps/server/dist/bin.cjs", 'require("not-used-by-desktop");');
    expect(validateStagedRuntimeDependencies(stage)).toBe(0);
    write(stage, "apps/server/dist/bin.mjs", 'import "electron";');
    expect(() => validateStagedRuntimeDependencies(stage)).toThrow(/bin\.mjs -> electron/);
  });
});

function nativeFixture(platform: "darwin" | "linux" | "win32" = "darwin", arch = "arm64"): string {
  const stage = fixture();
  for (const name of platform === "win32" ? ["conpty", "conpty_console_list"] : ["pty"]) {
    write(stage, `node_modules/node-pty/prebuilds/${platform}-${arch}/${name}.node`);
  }
  write(stage, `node_modules/@github/keytar/prebuilds/${platform}-${arch}/keytar.node`);
  write(stage, `node_modules/@img/sharp-${platform}-${arch}/lib/sharp-${platform}-${arch}.node`);
  const vips =
    platform === "win32" ? `sharp-${platform}-${arch}` : `sharp-libvips-${platform}-${arch}`;
  write(
    stage,
    `node_modules/@img/${vips}/lib/libvips${platform === "win32" ? ".dll" : platform === "darwin" ? ".dylib" : ".so.42"}`,
  );
  return stage;
}

describe("staged native payload presence (not loadability)", () => {
  it.each(["darwin", "linux", "win32"] as const)(
    "checks %s payload layout without attempting to execute binaries",
    (platform) => {
      const stage = nativeFixture(platform);
      // These are deliberately fake bytes: passing this check must not mean ABI/load validation.
      expect(() => validateStagedNativePayloads(stage, platform, "arm64")).not.toThrow();
    },
  );

  it.each([
    "node-pty/prebuilds/darwin-arm64/pty.node",
    "@github/keytar/prebuilds/darwin-arm64/keytar.node",
    "@img/sharp-darwin-arm64/lib/sharp-darwin-arm64.node",
    "@img/sharp-libvips-darwin-arm64/lib/libvips.dylib",
  ])("fails when %s is absent despite package entry points remaining", (file) => {
    const stage = nativeFixture();
    write(stage, "node_modules/sharp/index.js", "module.exports = {}; ");
    rmSync(join(stage, "node_modules", file));
    expect(() => validateStagedNativePayloads(stage, "darwin", "arm64")).toThrow(
      "Missing staged native payload",
    );
  });

  it("rejects empty binaries and prebuilds for a different architecture", () => {
    const stage = nativeFixture("darwin", "x64");
    expect(() => validateStagedNativePayloads(stage, "darwin", "arm64")).toThrow(
      "Missing staged native payload",
    );
    write(stage, "node_modules/node-pty/prebuilds/darwin-x64/pty.node", "");
    expect(() => validateStagedNativePayloads(stage, "darwin", "x64")).toThrow(
      "Missing staged native payload",
    );
  });

  it("accepts an addon rebuilt by electron-builder", () => {
    const stage = nativeFixture("linux");
    rmSync(join(stage, "node_modules/node-pty/prebuilds"), { recursive: true });
    write(stage, "node_modules/node-pty/build/Release/pty.node");
    expect(() => validateStagedNativePayloads(stage, "linux", "arm64")).not.toThrow();
  });

  it("does not accept unrelated shared libraries as libvips", () => {
    const stage = nativeFixture();
    rmSync(join(stage, "node_modules/@img/sharp-libvips-darwin-arm64/lib/libvips.dylib"));
    write(stage, "node_modules/@img/sharp-libvips-darwin-arm64/lib/unrelated.dylib");
    expect(() => validateStagedNativePayloads(stage, "darwin", "arm64")).toThrow("sharp-libvips");
  });

  it("rejects native payload symlinks outside the stage", () => {
    const stage = nativeFixture();
    const addon = join(stage, "node_modules/node-pty/prebuilds/darwin-arm64/pty.node");
    rmSync(addon);
    const outside = write(dirname(stage), "development/pty.node");
    symlinkSync(outside, addon);
    expect(() => validateStagedNativePayloads(stage, "darwin", "arm64")).toThrow("node-pty");
  });
});
