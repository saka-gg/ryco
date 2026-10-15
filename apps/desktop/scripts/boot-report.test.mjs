import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { isMainModule, readDesktopRuns, summarizeBackendPhases } from "./boot-report.mjs";

let root;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function desktopLog(lines) {
  root = mkdtempSync(join(tmpdir(), "ryco-boot-report-test-"));
  const file = join(root, "desktop-main.log");
  writeFileSync(file, `${lines.join("\n")}\n`);
  return file;
}

const timing = (run, phase, elapsedMs, detail) =>
  `[2026-10-15T10:00:00.000Z] [desktop run=${run}] startup timing phase=${phase} elapsedMs=${elapsedMs} deltaMs=0${detail ? ` ${detail}` : ""}`;

describe("boot-report", () => {
  it("reads pre-main time and backend phase durations per run", () => {
    const file = desktopLog([
      timing(
        "aa",
        "desktop.launch",
        0,
        "processUptimeMs=150 entryStartMs=80 mainModuleLoadMs=70 compileCache=on",
      ),
      timing("aa", "desktop.backend.spawn", 20),
      timing("aa", "backend.persistence.migrations", 900, "serverMs=700 durationMs=640"),
      // A milestone without a duration (older backend frames) is not a phase duration.
      timing("aa", "backend.http-bound", 950, "serverMs=750"),
      timing("aa", "desktop.window.app.shell-usable", 1_200),
    ]);

    const [run] = readDesktopRuns([file]);

    expect(run.preMainMs).toBe(150);
    expect(run.mainModuleLoadMs).toBe(70);
    expect(run.timings.shellUsable).toBe(1_200);
    expect(run.backendPhases).toEqual({ "persistence.migrations": 640 });
  });

  it("ranks backend phases by p90 and collapses provider instances", () => {
    const file = desktopLog([
      timing("aa", "desktop.launch", 0, "processUptimeMs=150"),
      timing("aa", "backend.persistence.migrations", 900, "serverMs=700 durationMs=640"),
      timing("aa", "backend.provider.instance.create_codex", 1_000, "serverMs=800 durationMs=90"),
      timing(
        "aa",
        "backend.provider.instance.create_copilot",
        1_000,
        "serverMs=800 durationMs=300",
      ),
      timing("bb", "desktop.launch", 0, "processUptimeMs=3800"),
      timing("bb", "backend.persistence.migrations", 900, "serverMs=700 durationMs=18036"),
      timing("bb", "backend.provider.instance.create_codex", 1_000, "serverMs=800 durationMs=120"),
    ]);

    const summary = summarizeBackendPhases(readDesktopRuns([file]));

    expect(summary.phases.map((phase) => [phase.name, phase.n, phase.max])).toEqual([
      ["persistence.migrations", 2, 18_036],
      ["provider.instance.create (slowest)", 2, 300],
    ]);
    expect(summary.worstProviderCreate).toEqual({
      instance: "copilot",
      durationMs: 300,
      run: "aa",
    });
  });

  it("recognizes itself as the entry point when run through a symlinked path", () => {
    root = mkdtempSync(join(tmpdir(), "ryco-boot-report-test-"));
    const script = join(root, "boot-report.mjs");
    writeFileSync(script, "");
    const link = join(root, "linked-boot-report.mjs");
    symlinkSync(script, link);
    // Node reports the module URL with symlinks resolved.
    const moduleUrl = pathToFileURL(realpathSync(script)).href;

    expect(isMainModule(moduleUrl, link)).toBe(true);
    expect(isMainModule(moduleUrl, script)).toBe(true);
    expect(isMainModule(moduleUrl, join(root, "missing.mjs"))).toBe(false);
    expect(isMainModule(moduleUrl, undefined)).toBe(false);
  });
});
