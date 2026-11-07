// Offline: pins which Bash calls of an eval case may really run.
import { execFileSync } from "node:child_process";

import { describe, expect, it } from "vite-plus/test";

import { simulateShell, simulatedCommand } from "./shell.ts";

const CWD = "/private/var/folders/xx/T/ryco-device-eval-X/acme-app";

describe("simulateShell", () => {
  it.each([
    "cat AGENTS.md",
    "ls -la",
    "pwd && ls -la",
    'grep -rn "Dark Mode" src | head -20',
    `cat ${CWD}/README.md`,
  ])("lets the plain read %s run in the repo", (command) => {
    expect(simulateShell(command, CWD, []).mode).toBe("read-only");
  });

  it.each([
    "cat ~/.ssh/config",
    "cat ../other/file",
    "cat /etc/hosts",
    "ls > out.txt",
    "echo $(whoami)",
    "find . -delete",
    "find . -exec rm {} +",
    "sed -i '' s/a/b/ README.md",
    "rm -rf build",
    "xcrun simctl io booted tap 200 400",
    "osascript -e 'tell application \"Simulator\" to activate'",
    "git status",
  ])("never runs %s", (command) => {
    expect(simulateShell(command, CWD, []).mode).not.toBe("read-only");
  });

  it("answers builds with canned success and lets case mocks win", () => {
    const build = simulateShell("xcodebuild -scheme Acme -derivedDataPath build build", CWD, []);
    expect(build).toMatchObject({ mode: "mock", exitCode: 0 });
    expect(build.output).toContain("BUILD SUCCEEDED");
    const mocked = simulateShell("xcodebuild -scheme Acme build", CWD, [
      { match: "xcodebuild", output: "error: no scheme", exitCode: 65 },
    ]);
    expect(mocked).toMatchObject({ mode: "mock", exitCode: 65, output: "error: no scheme" });
  });

  it("prints the simulated output through a harmless command", () => {
    const record = simulateShell("xcodebuild -scheme Acme build", CWD, [
      { match: "xcodebuild", output: "it's 'quoted'\n", exitCode: 3 },
    ]);
    const command = simulatedCommand(record);
    let status = 0;
    let stdout = "";
    try {
      stdout = execFileSync("bash", ["-c", command], { encoding: "utf8" });
    } catch (error) {
      const failed = error as { status: number; stdout: string };
      status = failed.status;
      stdout = failed.stdout;
    }
    expect({ status, stdout }).toEqual({ status: 3, stdout: "it's 'quoted'\n" });
    expect(simulatedCommand(simulateShell("rm -rf /", CWD, []))).toBe("true");
  });
});
