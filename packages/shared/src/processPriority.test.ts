import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import {
  AGENT_NICE_INCREMENT,
  type AgentLaunchFacts,
  agentCommandResolves,
  applyAgentLaunchPlan,
  hasDyldEnvironment,
  lowerChildProcessPriority,
  makeNiceExecutableResolver,
  planAgentLaunch,
} from "./processPriority.ts";

const LINUX_FACTS: AgentLaunchFacts = {
  enabled: true,
  platform: "linux",
  shell: false,
  niceExecutable: "/usr/bin/nice",
  commandResolves: true,
  dyldEnvironment: false,
};

describe("planAgentLaunch", () => {
  it("execs through nice on POSIX when the command resolves", () => {
    for (const platform of ["linux", "darwin"] as const) {
      const plan = planAgentLaunch({ ...LINUX_FACTS, platform });
      expect(plan).toEqual({ mode: "exec-nice", prefix: ["/usr/bin/nice", "-n", "5"] });
      expect(applyAgentLaunchPlan(plan, "codex", ["app-server"])).toEqual({
        command: "/usr/bin/nice",
        args: ["-n", "5", "codex", "app-server"],
      });
    }
  });

  it("is off when the setting is off", () => {
    const plan = planAgentLaunch({ ...LINUX_FACTS, enabled: false });
    expect(plan).toEqual({ mode: "off", prefix: [] });
    expect(applyAgentLaunchPlan(plan, "codex", ["app-server"])).toEqual({
      command: "codex",
      args: ["app-server"],
    });
  });

  it.each([
    ["Windows", { platform: "win32" }],
    ["a shell launch", { shell: true }],
    ["no nice executable", { niceExecutable: null }],
    ["an unresolvable command", { commandResolves: false }],
    ["DYLD_* variables on macOS", { platform: "darwin", dyldEnvironment: true }],
  ] as const)("lowers after spawn for %s and keeps the argv", (_label, overrides) => {
    const plan = planAgentLaunch({ ...LINUX_FACTS, ...overrides });
    expect(plan).toEqual({ mode: "after-spawn", prefix: [] });
    expect(applyAgentLaunchPlan(plan, "codex", ["app-server"])).toEqual({
      command: "codex",
      args: ["app-server"],
    });
  });

  it("keeps exec through nice for DYLD_* variables off macOS", () => {
    expect(planAgentLaunch({ ...LINUX_FACTS, dyldEnvironment: true }).mode).toBe("exec-nice");
  });

  it("honours an increment override", () => {
    expect(planAgentLaunch({ ...LINUX_FACTS, increment: 10 }).prefix).toEqual([
      "/usr/bin/nice",
      "-n",
      "10",
    ]);
  });
});

describe("hasDyldEnvironment", () => {
  it("detects any defined DYLD_* key", () => {
    expect(hasDyldEnvironment({ PATH: "/bin" })).toBe(false);
    expect(hasDyldEnvironment({ DYLD_LIBRARY_PATH: "/tmp/x" })).toBe(true);
    expect(hasDyldEnvironment({ DYLD_INSERT_LIBRARIES: undefined })).toBe(false);
  });
});

describe("lowerChildProcessPriority", () => {
  const recorder = (priorities: Record<number, number>) => {
    const calls: Array<[number, number]> = [];
    return {
      calls,
      deps: {
        selfPid: 4242,
        getPriority: (pid?: number) => priorities[pid ?? 0] ?? 0,
        setPriority: (pid: number, priority: number) => {
          calls.push([pid, priority]);
        },
      },
    };
  };

  it("lowers a POSIX child relative to the server", () => {
    const { calls, deps } = recorder({ 0: 0, 100: 0 });
    expect(lowerChildProcessPriority(100, { ...deps, platform: "linux" })).toBe("lowered");
    expect(calls).toEqual([[100, AGENT_NICE_INCREMENT]]);
  });

  it("keeps a child that already runs lower", () => {
    const { calls, deps } = recorder({ 0: 0, 100: 7 });
    expect(lowerChildProcessPriority(100, { ...deps, platform: "darwin" })).toBe("unchanged");
    expect(calls).toEqual([]);
  });

  it("caps the POSIX target at 19", () => {
    const { calls, deps } = recorder({ 0: 17, 100: 17 });
    expect(lowerChildProcessPriority(100, { ...deps, platform: "linux" })).toBe("lowered");
    expect(calls).toEqual([[100, 19]]);
  });

  it("uses Below Normal on Windows and keeps Idle", () => {
    const normal = recorder({ 100: 0 });
    expect(lowerChildProcessPriority(100, { ...normal.deps, platform: "win32" })).toBe("lowered");
    expect(normal.calls).toEqual([[100, 10]]);
    const idle = recorder({ 100: 19 });
    expect(lowerChildProcessPriority(100, { ...idle.deps, platform: "win32" })).toBe("unchanged");
    expect(idle.calls).toEqual([]);
  });

  it.each([undefined, 0, 1, -5, 1.5, 4242])("skips pid %s without any call", (pid) => {
    const { calls, deps } = recorder({});
    let reads = 0;
    expect(
      lowerChildProcessPriority(pid, {
        ...deps,
        platform: "linux",
        getPriority: () => {
          reads += 1;
          return 0;
        },
      }),
    ).toBe("skipped");
    expect(calls).toEqual([]);
    expect(reads).toBe(0);
  });

  it("reports a failing setPriority without throwing", () => {
    expect(
      lowerChildProcessPriority(100, {
        selfPid: 1,
        platform: "linux",
        getPriority: () => 0,
        setPriority: () => {
          throw Object.assign(new Error("EPERM"), { code: "EPERM" });
        },
      }),
    ).toBe("failed");
  });
});

describe("makeNiceExecutableResolver", () => {
  const fakeFs = (files: Record<string, { file: boolean; executable: boolean }>) => {
    let stats = 0;
    return {
      get stats() {
        return stats;
      },
      fs: {
        statSync: (filePath: string) => {
          stats += 1;
          const entry = files[filePath];
          if (!entry) throw new Error("ENOENT");
          return { isFile: () => entry.file };
        },
        accessSync: (filePath: string) => {
          if (!files[filePath]?.executable) throw new Error("EACCES");
        },
      },
    };
  };

  it("returns the first executable candidate and computes it once", () => {
    const fake = fakeFs({
      "/a/nice": { file: true, executable: false },
      "/b/nice": { file: false, executable: true },
      "/c/nice": { file: true, executable: true },
      "/d/nice": { file: true, executable: true },
    });
    const resolve = makeNiceExecutableResolver(fake.fs, [
      "/a/nice",
      "/b/nice",
      "/c/nice",
      "/d/nice",
    ]);
    expect(resolve()).toBe("/c/nice");
    const statsAfterFirst = fake.stats;
    expect(resolve()).toBe("/c/nice");
    expect(fake.stats).toBe(statsAfterFirst);
  });

  it("returns null when no candidate is executable, also memoized", () => {
    const fake = fakeFs({});
    const resolve = makeNiceExecutableResolver(fake.fs, ["/a/nice"]);
    expect(resolve()).toBeNull();
    expect(resolve()).toBeNull();
    expect(fake.stats).toBe(1);
  });
});

describe.skipIf(process.platform === "win32")("agentCommandResolves", () => {
  let root = "";
  beforeAll(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "ryco-process-priority-"));
    mkdirSync(path.join(root, "bin"));
    mkdirSync(path.join(root, "work", "bin"), { recursive: true });
    writeFileSync(path.join(root, "bin", "agent-tool"), "#!/bin/sh\n");
    chmodSync(path.join(root, "bin", "agent-tool"), 0o755);
    writeFileSync(path.join(root, "bin", "not-executable"), "#!/bin/sh\n");
    chmodSync(path.join(root, "bin", "not-executable"), 0o644);
    writeFileSync(path.join(root, "work", "bin", "tool"), "#!/bin/sh\n");
    chmodSync(path.join(root, "work", "bin", "tool"), 0o755);
  });
  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  const options = () => ({
    env: { PATH: path.join(root, "bin") },
    cwd: path.join(root, "work"),
    platform: process.platform,
  });

  it("finds a bare name through the child's PATH", async () => {
    expect(await agentCommandResolves("agent-tool", options())).toBe(true);
    expect(await agentCommandResolves("missing-tool", options())).toBe(false);
  });

  it("does not accept a file that is not executable", async () => {
    expect(await agentCommandResolves("not-executable", options())).toBe(false);
  });

  it("resolves a relative command against the child's cwd", async () => {
    expect(await agentCommandResolves("./bin/tool", options())).toBe(true);
    expect(
      await agentCommandResolves("./bin/tool", { ...options(), cwd: path.join(root, "bin") }),
    ).toBe(false);
  });

  it("resolves relative PATH entries against the child's cwd, not the server's", async () => {
    // The child's cwd is `<root>/work`; this test process runs elsewhere, so a lookup relative to
    // its own cwd finds neither file.
    expect(await agentCommandResolves("tool", { ...options(), env: { PATH: "bin" } })).toBe(true);
    expect(
      await agentCommandResolves("agent-tool", { ...options(), env: { PATH: "../bin" } }),
    ).toBe(true);
    expect(
      await agentCommandResolves("tool", { ...options(), env: { PATH: "/nonexistent::bin" } }),
    ).toBe(true);
    expect(await agentCommandResolves("agent-tool", { ...options(), env: { PATH: "bin" } })).toBe(
      false,
    );
  });

  it("checks an absolute command directly", async () => {
    expect(await agentCommandResolves(path.join(root, "bin", "agent-tool"), options())).toBe(true);
    expect(await agentCommandResolves(path.join(root, "bin", "missing"), options())).toBe(false);
  });
});
