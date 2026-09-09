import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { writeMacAppBootstrap, writeMacLaunchConfiguration } from "./mac-launcher-bootstrap.mjs";

const roots = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ryco-launcher-"));
  roots.push(root);
  const bundle = join(root, "Ryco.app");
  const worktree = join(root, "checkout");
  mkdirSync(join(worktree, "dist-electron"), { recursive: true });
  const main = join(worktree, "dist-electron", "main.cjs");
  writeFileSync(
    main,
    "process.stdout.write(JSON.stringify({ port: process.env.RYCO_PORT, callback: process.env.RYCO_DESKTOP_CALLBACK_RELAY ?? null }));",
  );
  writeMacAppBootstrap(bundle, true);
  return {
    root,
    worktree,
    main,
    bootstrap: join(bundle, "Contents", "Resources", "app", "main.cjs"),
  };
}

describe("stable macOS launcher bootstrap", () => {
  it("adopts callback launch configuration without rewriting signed resources", () => {
    const f = fixture();
    const signedBytes = readFileSync(f.bootstrap);
    for (const port of ["4773", "5773"]) {
      writeMacLaunchConfiguration(f.root, { RYCO_PORT: port }, f.main);
      const result = spawnSync(process.execPath, [f.bootstrap], { encoding: "utf8" });
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ port, callback: "1" });
      expect(readFileSync(f.bootstrap)).toEqual(signedBytes);
    }
  });

  it("uses the invoking worktree and environment for direct development launches", () => {
    const f = fixture();
    writeMacLaunchConfiguration(f.root, { RYCO_PORT: "wrong" }, "/unavailable/checkout.cjs");
    const result = spawnSync(process.execPath, [f.bootstrap, `--ryco-dev-root=${f.worktree}`], {
      encoding: "utf8",
      env: { ...process.env, RYCO_PORT: "4773", RYCO_DESKTOP_CALLBACK_RELAY: "" },
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ port: "4773", callback: "" });
  });
});
