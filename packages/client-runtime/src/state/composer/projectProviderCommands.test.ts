import type { EnvironmentApi, ProviderInstanceId, ProviderProjectCommands } from "@ryco/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  ensureProjectProviderCommands,
  mergeProjectProviderCommands,
  PROJECT_PROVIDER_COMMANDS_FRESH_MS,
  PROJECT_PROVIDER_COMMANDS_RETRY_MS,
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

  describe("runtime sessions", () => {
    const setup = (
      respond: () => Promise<ProviderProjectCommands> = () => Promise.resolve(commands),
    ) => {
      const read = vi.fn(respond);
      const api = { server: { readProjectProviderCommands: read } } as unknown as EnvironmentApi;
      const ensure = (runtimeSessionId: string | null | undefined, nowMs = Date.now()) =>
        ensureProjectProviderCommands({
          api,
          supported: true,
          environmentId: "env",
          instanceId,
          cwd: "/repo",
          runtimeSessionId,
          nowMs,
        });
      const settled = (times: number) =>
        vi.waitFor(() => {
          expect(read).toHaveBeenCalledTimes(times);
          expect(
            readProjectProviderCommands(
              projectProviderCommandsKey({ environmentId: "env", instanceId, cwd: "/repo" }),
            ),
          ).toBeDefined();
        });
      return { read, ensure, settled };
    };

    it("reads once more for a new session inside the window, never for the same one or none", async () => {
      const { read, ensure, settled } = setup();
      ensure(null);
      await settled(1);
      ensure(null);
      ensure(undefined);
      ensure("");
      expect(read).toHaveBeenCalledTimes(1);
      ensure("session-1");
      expect(read).toHaveBeenCalledTimes(2);
      await new Promise((resolve) => setTimeout(resolve, 0));
      ensure("session-1");
      // A thread without a session in the same directory does not undo the session's read.
      ensure(null);
      ensure("session-1");
      expect(read).toHaveBeenCalledTimes(2);
      ensure("session-2");
      expect(read).toHaveBeenCalledTimes(3);
    });

    it("keeps one read in flight and reads once more for a session that appeared meanwhile", async () => {
      let resolveRead: (data: ProviderProjectCommands) => void = () => undefined;
      const { read, ensure } = setup(
        () =>
          new Promise((resolve) => {
            resolveRead = resolve;
          }),
      );
      ensure("session-1");
      ensure("session-1");
      expect(read).toHaveBeenCalledTimes(1);
      resolveRead(commands);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(read).toHaveBeenCalledTimes(1);

      ensure("session-2");
      ensure("session-3");
      expect(read).toHaveBeenCalledTimes(2);
      resolveRead(commands);
      await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(3));
      resolveRead(commands);
      await new Promise((resolve) => setTimeout(resolve, 0));
      ensure("session-3");
      expect(read).toHaveBeenCalledTimes(3);
    });

    it("honours the failure backoff for a new session", async () => {
      const { read, ensure } = setup(() => Promise.reject(new Error("offline")));
      ensure(null);
      await new Promise((resolve) => setTimeout(resolve, 0));
      ensure("session-1");
      expect(read).toHaveBeenCalledTimes(1);
      ensure("session-1", Date.now() + PROJECT_PROVIDER_COMMANDS_RETRY_MS);
      expect(read).toHaveBeenCalledTimes(2);
    });

    it("re-reads a directory that offered nothing after the retry delay, others after the window", async () => {
      const empty: ProviderProjectCommands = { skills: [], slashCommands: [] };
      let data = empty;
      const { read, ensure, settled } = setup(() => Promise.resolve(data));
      ensure(null);
      await settled(1);
      ensure(null, Date.now() + PROJECT_PROVIDER_COMMANDS_RETRY_MS - 1_000);
      expect(read).toHaveBeenCalledTimes(1);
      data = commands;
      ensure(null, Date.now() + PROJECT_PROVIDER_COMMANDS_RETRY_MS);
      expect(read).toHaveBeenCalledTimes(2);
      await new Promise((resolve) => setTimeout(resolve, 0));
      ensure(null, Date.now() + PROJECT_PROVIDER_COMMANDS_RETRY_MS);
      ensure(null, Date.now() + PROJECT_PROVIDER_COMMANDS_FRESH_MS - 1_000);
      expect(read).toHaveBeenCalledTimes(2);
      ensure(null, Date.now() + PROJECT_PROVIDER_COMMANDS_FRESH_MS);
      expect(read).toHaveBeenCalledTimes(3);
    });
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
