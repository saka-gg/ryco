import type { ProjectScript } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  nextProjectScriptId,
  projectScriptDraftError,
  withAddedProjectScript,
  withoutProjectScript,
  withUpdatedProjectScript,
} from "./scripts.ts";

const setup: ProjectScript = {
  id: "setup",
  name: "Setup",
  command: "bun install",
  icon: "configure",
  runOnWorktreeCreate: true,
};
const test: ProjectScript = {
  id: "test",
  name: "Test",
  command: "bun run test",
  icon: "test",
  runOnWorktreeCreate: false,
};

describe("project script ids", () => {
  it("slugifies and dedupes project script ids", () => {
    expect(nextProjectScriptId("Run Tests", [])).toBe("run-tests");
    expect(nextProjectScriptId("Run Tests", ["run-tests"])).toBe("run-tests-2");
    expect(nextProjectScriptId("!!!", [])).toBe("script");
  });
});

describe("editing the action list", () => {
  it("requires a name and a command", () => {
    expect(projectScriptDraftError({ name: " ", command: "x" })).toBe("Name is required.");
    expect(projectScriptDraftError({ name: "Lint", command: "" })).toBe("Command is required.");
    expect(projectScriptDraftError({ name: "Lint", command: "bun lint" })).toBeNull();
  });

  it("appends a new action with a fresh id", () => {
    const next = withAddedProjectScript([setup, test], {
      name: "Test",
      command: "vitest",
      icon: "test",
      runOnWorktreeCreate: false,
    });
    expect(next.scriptId).toBe("test-2");
    expect(next.scripts.map((script) => script.id)).toEqual(["setup", "test", "test-2"]);
    expect(next.scripts[0]?.runOnWorktreeCreate).toBe(true);
  });

  it("keeps one setup action when a new one takes over", () => {
    const next = withAddedProjectScript([setup, test], {
      name: "Bootstrap",
      command: "make",
      icon: "build",
      runOnWorktreeCreate: true,
    });
    expect(next.scripts.map((script) => [script.id, script.runOnWorktreeCreate])).toEqual([
      ["setup", false],
      ["test", false],
      ["bootstrap", true],
    ]);
  });

  it("updates in place and moves the setup flag", () => {
    const next = withUpdatedProjectScript([setup, test], "test", {
      name: "Tests",
      command: "bun run test",
      icon: "test",
      runOnWorktreeCreate: true,
    });
    expect(next).toEqual([
      { ...setup, runOnWorktreeCreate: false },
      { ...test, name: "Tests", runOnWorktreeCreate: true },
    ]);
    expect(() => withUpdatedProjectScript([setup], "gone", { ...test })).toThrow(
      "Script not found.",
    );
  });

  it("deletes by id", () => {
    expect(withoutProjectScript([setup, test], "setup")).toEqual([test]);
  });
});
