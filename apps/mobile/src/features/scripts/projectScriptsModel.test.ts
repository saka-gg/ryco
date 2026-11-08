import { describe, expect, it } from "vite-plus/test";

import type { ProjectScript } from "@ryco/contracts";

import { scriptRows, scriptRunRequest } from "./projectScriptsModel";

describe("project scripts", () => {
  it("lists scripts in project order with their symbol", () => {
    const scripts = [
      { id: "t", name: "Test", command: "bun run test", icon: "test", runOnWorktreeCreate: false },
      { id: "s", name: "Setup", command: "bun i", icon: "configure", runOnWorktreeCreate: true },
    ] as unknown as ProjectScript[];
    expect(scriptRows(scripts)).toEqual([
      { id: "t", name: "Test", command: "bun run test", symbol: "checkmark.seal", setup: false },
      { id: "s", name: "Setup", command: "bun i", symbol: "gearshape", setup: true },
    ]);
  });

  it("runs one command in the thread's workspace with the desktop's variables", () => {
    expect(
      scriptRunRequest({
        command: "  bun run dev ",
        projectCwd: "/repo",
        workspaceCwd: "/repo/.worktrees/x",
        worktreePath: "/repo/.worktrees/x",
      }),
    ).toEqual({
      cwd: "/repo/.worktrees/x",
      worktreePath: "/repo/.worktrees/x",
      env: { RYCO_PROJECT_ROOT: "/repo", RYCO_WORKTREE_PATH: "/repo/.worktrees/x" },
      input: "bun run dev\r",
    });
  });

  it("refuses blank commands and types multi-line ones line by line, like the desktop", () => {
    const base = { projectCwd: "/r", workspaceCwd: "/r", worktreePath: null };
    expect(scriptRunRequest({ ...base, command: "  " })).toBeNull();
    expect(scriptRunRequest({ ...base, command: "a\r\nb\n" })?.input).toBe("a\rb\r");
    expect(scriptRunRequest({ ...base, command: "ls" })?.env).toEqual({ RYCO_PROJECT_ROOT: "/r" });
  });
});
