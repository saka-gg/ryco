import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const HELPER_DIR = fileURLToPath(new URL("../../native/device-helper", import.meta.url));
const BUILD_SCRIPT = join(HELPER_DIR, "build.sh");
const HELPER_SOURCES = join(HELPER_DIR, "Sources");

type SimulatorKitLayout = "developer-private-frameworks" | "shared-frameworks" | "none";

interface FakeXcode {
  readonly root: string;
  readonly developerDir: string;
  readonly contentsDir: string;
  readonly outDir: string;
  readonly stubBin: string;
  readonly xcrunLog: string;
}

// Separates one recorded xcrun invocation from the next; each argument is on
// its own line so paths with spaces survive.
const CALL_MARKER = "::xcrun::";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/**
 * A fake Xcode bundle plus a stub `xcrun` that records its arguments and
 * touches whatever follows `-o`, so build.sh runs end to end without a
 * compiler. Only the SimulatorKit location differs between cases.
 */
function fakeXcode(layout: SimulatorKitLayout): FakeXcode {
  const root = mkdtempSync(join(tmpdir(), "ryco-helper-build-"));
  roots.push(root);
  const contentsDir = join(root, "Xcode.app", "Contents");
  const developerDir = join(contentsDir, "Developer");
  mkdirSync(developerDir, { recursive: true });
  if (layout === "developer-private-frameworks") {
    // Xcode 26 and earlier.
    mkdirSync(join(developerDir, "Library", "PrivateFrameworks", "SimulatorKit.framework"), {
      recursive: true,
    });
  } else if (layout === "shared-frameworks") {
    // Xcode 27: Contents/Developer/Library has no PrivateFrameworks at all.
    mkdirSync(join(developerDir, "Library", "Frameworks"), { recursive: true });
    mkdirSync(join(contentsDir, "SharedFrameworks", "SimulatorKit.framework"), {
      recursive: true,
    });
  }

  const stubBin = join(root, "bin");
  mkdirSync(stubBin);
  const xcrunLog = join(root, "xcrun.log");
  writeFileSync(
    join(stubBin, "xcrun"),
    [
      "#!/bin/sh",
      `{ printf '%s\\n' '${CALL_MARKER}'; for arg in "$@"; do printf '%s\\n' "$arg"; done; } >> '${xcrunLog}'`,
      'out=""',
      'while [ "$#" -gt 0 ]; do',
      '  if [ "$1" = "-o" ] && [ "$#" -gt 1 ]; then out="$2"; fi',
      "  shift",
      "done",
      'if [ -n "$out" ]; then : > "$out"; fi',
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(join(stubBin, "xcrun"), 0o755);

  return { root, developerDir, contentsDir, outDir: join(root, "out"), stubBin, xcrunLog };
}

function runBuild(xcode: FakeXcode, shell: "/bin/bash" | "/bin/sh" = "/bin/bash") {
  const result = spawnSync(shell, [BUILD_SCRIPT, xcode.outDir], {
    encoding: "utf8",
    env: { PATH: `${xcode.stubBin}:/usr/bin:/bin`, DEVELOPER_DIR: xcode.developerDir },
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    lastLine: result.stdout.trim().split("\n").at(-1),
  };
}

function xcrunCalls(xcode: FakeXcode): string[][] {
  if (!existsSync(xcode.xcrunLog)) return [];
  const calls: string[][] = [];
  for (const line of readFileSync(xcode.xcrunLog, "utf8").split("\n")) {
    if (line === CALL_MARKER) calls.push([]);
    else if (line.length > 0) calls.at(-1)?.push(line);
  }
  return calls;
}

const sourceFiles = (extension: string): string[] =>
  readdirSync(HELPER_SOURCES)
    .filter((name) => name.endsWith(extension))
    .toSorted();

// CI runs Linux, where /bin/sh is dash; build.sh is a bash script, so the
// portable cases run it through /bin/bash. Windows has neither.
describe.skipIf(process.platform === "win32")("device helper build.sh", () => {
  it("builds against an Xcode 26 layout (SimulatorKit under the developer dir)", () => {
    const xcode = fakeXcode("developer-private-frameworks");
    const result = runBuild(xcode);

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.lastLine).toBe(join(xcode.outDir, "ryco-device-helper"));
    expect(existsSync(join(xcode.outDir, "ryco-device-helper"))).toBe(true);
  });

  it("builds against an Xcode 27 layout (SimulatorKit in Contents/SharedFrameworks)", () => {
    const xcode = fakeXcode("shared-frameworks");
    const result = runBuild(xcode);

    expect(result.stderr).not.toContain("SimulatorKit not found");
    expect(result.status).toBe(0);
    expect(result.lastLine).toBe(join(xcode.outDir, "ryco-device-helper"));
    expect(existsSync(join(xcode.outDir, "ryco-device-helper"))).toBe(true);
  });

  it("fails before compiling when neither location has SimulatorKit, naming both", () => {
    const xcode = fakeXcode("none");
    const result = runBuild(xcode);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("SimulatorKit not found");
    expect(result.stderr).toContain(xcode.developerDir);
    expect(result.stderr).toContain(join(xcode.contentsDir, "SharedFrameworks"));
    expect(xcrunCalls(xcode)).toEqual([]);
    expect(existsSync(join(xcode.outDir, "ryco-device-helper"))).toBe(false);
  });

  it("compiles every Objective-C source separately with ARC, then links every Swift source", () => {
    const xcode = fakeXcode("shared-frameworks");
    expect(runBuild(xcode).status).toBe(0);

    const calls = xcrunCalls(xcode);
    const clangSources = calls
      .filter((argv) => argv[0] === "clang")
      .map((argv) => {
        expect(argv).toContain("-fobjc-arc");
        const source = argv.find((arg) => arg.endsWith(".m"));
        return source === undefined ? undefined : basename(source);
      });
    // Order matters only for readability; the list must name every .m file,
    // so a new bridge cannot be left out of the build.
    expect(clangSources).toEqual([
      "AXBridge.m",
      "CoreSimulatorVersion.m",
      "DTUHIDTransport.m",
      "HIDBridge.m",
    ]);
    expect(clangSources).toEqual(sourceFiles(".m"));

    const swiftc = calls.filter((argv) => argv[0] === "swiftc");
    expect(swiftc).toHaveLength(1);
    const swiftSources = swiftc[0]!
      .filter((arg) => arg.endsWith(".swift"))
      .map((arg) => basename(arg))
      .toSorted();
    expect(swiftSources).toEqual(sourceFiles(".swift"));
  });

  // build.sh's preflight and the helper's dlopen loop are in two languages, so
  // they cannot share one list; this keeps them from drifting apart. Each entry
  // is normalized to "<base>:<path below it>".
  it("checks the same SimulatorKit locations, in the same order, as the Swift loader", () => {
    const script = readFileSync(BUILD_SCRIPT, "utf8");
    const scriptBases: Record<string, string> = {
      DEVELOPER_DIR_PATH: "developer",
      CONTENTS_DIR: "contents",
    };
    const scriptCandidates = [
      ...script.matchAll(
        /"\$(DEVELOPER_DIR_PATH|CONTENTS_DIR)(\/[^"]*\/SimulatorKit\.framework)"/gu,
      ),
    ].map((match) => `${scriptBases[match[1]!]}:${match[2]}`);

    const bridge = readFileSync(join(HELPER_SOURCES, "CoreSimulatorBridge.swift"), "utf8");
    const body = /func simulatorKitCandidatePaths\([^)]*\) -> \[String\] \{([\s\S]*?)\n\}/u.exec(
      bridge,
    )?.[1];
    expect(body).toBeDefined();
    const swiftBases: Record<string, string> = {
      developerDirectory: "developer",
      contentsDirectory: "contents",
    };
    const swiftCandidates = [
      ...body!.matchAll(
        /(developerDirectory|contentsDirectory) \+ "(\/[^"]*\/SimulatorKit\.framework)\/SimulatorKit"/gu,
      ),
    ].map((match) => `${swiftBases[match[1]!]}:${match[2]}`);

    expect(scriptCandidates).toEqual([
      "developer:/Library/PrivateFrameworks/SimulatorKit.framework",
      "contents:/SharedFrameworks/SimulatorKit.framework",
    ]);
    expect(swiftCandidates).toEqual(scriptCandidates);
  });

  // The server runs `/bin/sh build.sh` (IosSimulatorBackend.compileHelper).
  // On macOS that is bash 3.2 in POSIX mode, which the SimulatorKit lookup
  // must stay compatible with.
  it.skipIf(process.platform !== "darwin")(
    "builds the Xcode 27 layout when run the way the server runs it (/bin/sh)",
    () => {
      const xcode = fakeXcode("shared-frameworks");
      const result = runBuild(xcode, "/bin/sh");

      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(result.lastLine).toBe(join(xcode.outDir, "ryco-device-helper"));
    },
  );
});
