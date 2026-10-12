import { EnvironmentId, ThreadId, type EnvironmentApi } from "@ryco/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import * as environmentApi from "./environmentApi";
import * as hostedCapabilities from "./hostedHub/capabilities";
import { removeLocalStorageItem } from "./hooks/useLocalStorage";
import {
  prepareThreadTerminal,
  readLastTerminalDimensions,
  rememberTerminalDimensions,
  resetPreparedTerminalOpensForTests,
  resolveThreadTerminalLaunch,
  takePreparedTerminalOpen,
  TERMINAL_DIMENSIONS_STORAGE_KEY,
  terminalLaunchKey,
} from "./terminalPrepare";

const environmentId = EnvironmentId.make("environment-local");
const threadId = ThreadId.make("thread-1");

function mockTerminalOpen() {
  const open = vi.fn(async () => ({ history: "", status: "running" }));
  vi.spyOn(environmentApi, "readEnvironmentApi").mockReturnValue({
    terminal: { open },
  } as unknown as EnvironmentApi);
  return open;
}

beforeEach(() => {
  removeLocalStorageItem(TERMINAL_DIMENSIONS_STORAGE_KEY);
  resetPreparedTerminalOpensForTests();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("resolveThreadTerminalLaunch", () => {
  it("starts in the thread worktree with the project script environment", () => {
    expect(
      resolveThreadTerminalLaunch({
        projectCwd: "/repo",
        threadWorktreePath: "/repo/.worktrees/a",
        launchContext: null,
      }),
    ).toEqual({
      cwd: "/repo/.worktrees/a",
      worktreePath: "/repo/.worktrees/a",
      runtimeEnv: { RYCO_PROJECT_ROOT: "/repo", RYCO_WORKTREE_PATH: "/repo/.worktrees/a" },
    });
  });

  it("keeps a server-reported launch, including one without a worktree", () => {
    expect(
      resolveThreadTerminalLaunch({
        projectCwd: "/repo",
        threadWorktreePath: "/repo/.worktrees/a",
        launchContext: { cwd: "/repo/sub", worktreePath: null },
      }),
    ).toEqual({
      cwd: "/repo/sub",
      worktreePath: null,
      runtimeEnv: { RYCO_PROJECT_ROOT: "/repo" },
    });
  });

  it("has no launch without a project", () => {
    expect(
      resolveThreadTerminalLaunch({
        projectCwd: null,
        threadWorktreePath: null,
        launchContext: null,
      }),
    ).toBeNull();
  });
});

describe("terminalLaunchKey", () => {
  it("ignores environment key order and treats a missing environment as empty", () => {
    expect(
      terminalLaunchKey({ cwd: "/repo", worktreePath: null, runtimeEnv: { B: "2", A: "1" } }),
    ).toBe(terminalLaunchKey({ cwd: "/repo", worktreePath: null, runtimeEnv: { A: "1", B: "2" } }));
    expect(
      terminalLaunchKey({ cwd: "/repo", worktreePath: undefined, runtimeEnv: undefined }),
    ).toBe(terminalLaunchKey({ cwd: "/repo", worktreePath: null, runtimeEnv: {} }));
  });
});

describe("prepareThreadTerminal", () => {
  const launch = { cwd: "/repo", worktreePath: null, runtimeEnv: { RYCO_PROJECT_ROOT: "/repo" } };

  it("opens once with the last fitted size and hands the result to the mounting terminal", async () => {
    const open = mockTerminalOpen();
    rememberTerminalDimensions("drawer", { cols: 132, rows: 31 });
    prepareThreadTerminal({
      environmentId,
      threadId,
      terminalId: "default",
      launch,
      layout: "drawer",
    });
    prepareThreadTerminal({
      environmentId,
      threadId,
      terminalId: "default",
      launch,
      layout: "drawer",
    });

    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith({
      threadId,
      terminalId: "default",
      cwd: "/repo",
      worktreePath: null,
      cols: 132,
      rows: 31,
      env: { RYCO_PROJECT_ROOT: "/repo" },
    });

    const prepared = takePreparedTerminalOpen({
      environmentId,
      threadId,
      terminalId: "default",
      launchKey: terminalLaunchKey(launch),
    });
    expect(prepared?.dimensions).toEqual({ cols: 132, rows: 31 });
    await expect(prepared?.promise).resolves.toMatchObject({ status: "running" });
    // Taken once.
    expect(
      takePreparedTerminalOpen({
        environmentId,
        threadId,
        terminalId: "default",
        launchKey: terminalLaunchKey(launch),
      }),
    ).toBeNull();
  });

  it("does not hand out a prepared open for another launch or after it went stale", () => {
    mockTerminalOpen();
    prepareThreadTerminal({
      environmentId,
      threadId,
      terminalId: "default",
      launch,
      layout: "panel",
    });
    expect(
      takePreparedTerminalOpen({
        environmentId,
        threadId,
        terminalId: "default",
        launchKey: terminalLaunchKey({ ...launch, cwd: "/elsewhere" }),
      }),
    ).toBeNull();

    vi.useFakeTimers();
    prepareThreadTerminal({
      environmentId,
      threadId,
      terminalId: "default",
      launch,
      layout: "panel",
    });
    vi.advanceTimersByTime(10_000);
    expect(
      takePreparedTerminalOpen({
        environmentId,
        threadId,
        terminalId: "default",
        launchKey: terminalLaunchKey(launch),
      }),
    ).toBeNull();
  });

  it("never opens early without hosted terminal access", () => {
    const open = mockTerminalOpen();
    vi.spyOn(hostedCapabilities, "readHostedRpcCapability").mockReturnValue({
      hosted: true,
      allowed: false,
      reason: "This action is unavailable while Hub authorization or the relay is stale.",
    });
    prepareThreadTerminal({
      environmentId,
      threadId,
      terminalId: "default",
      launch,
      layout: "drawer",
    });
    expect(open).not.toHaveBeenCalled();
    expect(
      takePreparedTerminalOpen({
        environmentId,
        threadId,
        terminalId: "default",
        launchKey: terminalLaunchKey(launch),
      }),
    ).toBeNull();
  });

  it("drops a failed prepare so the terminal opens on its own", async () => {
    const open = vi.fn(async () => {
      throw new Error("offline");
    });
    vi.spyOn(environmentApi, "readEnvironmentApi").mockReturnValue({
      terminal: { open },
    } as unknown as EnvironmentApi);
    prepareThreadTerminal({
      environmentId,
      threadId,
      terminalId: "default",
      launch,
      layout: "drawer",
    });
    expect(open).toHaveBeenCalledTimes(1);
    // Let the rejection settle before the terminal mounts.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      takePreparedTerminalOpen({
        environmentId,
        threadId,
        terminalId: "default",
        launchKey: terminalLaunchKey(launch),
      }),
    ).toBeNull();
  });
});

describe("terminal dimensions", () => {
  it("defaults to 80x24 and remembers each surface separately", () => {
    expect(readLastTerminalDimensions("panel")).toEqual({ cols: 80, rows: 24 });
    rememberTerminalDimensions("panel", { cols: 100, rows: 40 });
    expect(readLastTerminalDimensions("panel")).toEqual({ cols: 100, rows: 40 });
    expect(readLastTerminalDimensions("drawer")).toEqual({ cols: 80, rows: 24 });

    resetPreparedTerminalOpensForTests();
    expect(readLastTerminalDimensions("panel")).toEqual({ cols: 100, rows: 40 });
  });

  it("ignores sizes the server would reject", () => {
    rememberTerminalDimensions("drawer", { cols: 0, rows: 24 });
    expect(readLastTerminalDimensions("drawer")).toEqual({ cols: 80, rows: 24 });
  });
});
