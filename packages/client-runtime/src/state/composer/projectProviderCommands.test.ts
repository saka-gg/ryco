import type { EnvironmentApi, ProviderInstanceId, ProviderProjectCommands } from "@ryco/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  ensureProjectProviderCommands,
  mergeProjectProviderCommands,
  PROJECT_PROVIDER_COMMANDS_FRESH_MS,
  projectProviderCommandsKey,
  readProjectProviderCommands,
  resetProjectProviderCommandsForTests,
  subscribeProjectProviderCommands,
} from "./projectProviderCommands.ts";

const instanceId = "claude" as ProviderInstanceId;
const commands: ProviderProjectCommands = {
  skills: [{ name: "deploy", path: "/repo/.claude/skills/deploy/SKILL.md", enabled: true }],
  slashCommands: [{ name: "review-pr", description: "Project review" }],
};

afterEach(() => resetProjectProviderCommandsForTests());

describe("project provider commands", () => {
  it("reads once per directory and freshness window, notifying subscribers", async () => {
    const read = vi.fn(() => Promise.resolve(commands));
    const api = { server: { readProjectProviderCommands: read } } as unknown as EnvironmentApi;
    const listener = vi.fn();
    subscribeProjectProviderCommands(listener);
    const ensure = (cwd: string, nowMs: number) =>
      ensureProjectProviderCommands({
        api,
        supported: true,
        environmentId: "env",
        instanceId,
        cwd,
        nowMs,
      });
    ensure("/repo", 0);
    ensure("/repo", 1);
    await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(1));
    expect(
      readProjectProviderCommands(
        projectProviderCommandsKey({ environmentId: "env", instanceId, cwd: "/repo" }),
      ),
    ).toEqual(commands);
    ensure("/repo", 1_000);
    expect(read).toHaveBeenCalledTimes(1);
    ensure("/other", 1_000);
    expect(read).toHaveBeenCalledTimes(2);
    // Stale: read again while the old lists keep serving.
    ensure("/repo", Date.now() + PROJECT_PROVIDER_COMMANDS_FRESH_MS);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("never calls a node that does not advertise it", () => {
    const read = vi.fn(() => Promise.resolve(commands));
    const api = { server: { readProjectProviderCommands: read } } as unknown as EnvironmentApi;
    ensureProjectProviderCommands({
      api,
      supported: false,
      environmentId: "env",
      instanceId,
      cwd: "/repo",
    });
    expect(read).not.toHaveBeenCalled();
  });

  it("adds what the directory offers without renaming what the snapshot shows", () => {
    const base = {
      skills: [{ name: "deploy", path: "/repo/.claude/skills/deploy/SKILL.md", enabled: true }],
      slashCommands: [{ name: "Review-PR", description: "Global" }, { name: "compact" }],
    };
    const merged = mergeProjectProviderCommands(base, {
      skills: [
        ...commands.skills,
        { name: "lint", path: "/repo/.claude/skills/lint/SKILL.md", enabled: true },
      ],
      slashCommands: [...commands.slashCommands, { name: "ship" }],
    });
    expect(merged.skills.map((skill) => skill.name)).toEqual(["deploy", "lint"]);
    expect(merged.slashCommands).toEqual([
      { name: "Review-PR", description: "Global" },
      { name: "compact" },
      { name: "ship" },
    ]);
    expect(mergeProjectProviderCommands(base, undefined)).toBe(base);
  });
});
