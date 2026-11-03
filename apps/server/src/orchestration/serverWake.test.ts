import { MessageId, ProjectId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  SERVER_WAKE_COPY,
  serverWakeCopy,
  serverWakeGuard,
  serverWakeInScope,
  serverWakeSource,
} from "./serverWake.ts";

const shell = {
  projectId: ProjectId.make("project-1"),
  runtimeMode: "auto" as const,
  worktreePath: "/tmp/worktree",
};

describe("serverWakeGuard", () => {
  it("leaves a delegated result's guard as it was, so its command and event do not change", () => {
    const guard = serverWakeGuard(shell, MessageId.make("latest"), "delegation-return");
    expect(JSON.stringify(guard)).toBe(
      '{"latestUserMessageId":"latest","projectId":"project-1","runtimeMode":"auto","worktreePath":"/tmp/worktree"}',
    );
    expect(serverWakeSource(guard)).toBe("delegation-return");
  });

  it("names a pull request update's source", () => {
    const guard = serverWakeGuard(shell, null, "pull-request-watch");
    expect(guard).toEqual({
      latestUserMessageId: null,
      projectId: "project-1",
      runtimeMode: "auto",
      worktreePath: "/tmp/worktree",
      source: "pull-request-watch",
    });
    expect(serverWakeSource(guard)).toBe("pull-request-watch");
    expect(serverWakeCopy(guard)).toBe(SERVER_WAKE_COPY["pull-request-watch"]);
  });

  it("finds no source on a turn start without a guard", () => {
    expect(serverWakeSource(undefined)).toBeNull();
  });
});

describe("serverWakeInScope", () => {
  const captured = { runtimeMode: "auto" as const, worktreePath: "/tmp/worktree" };
  it("allows the same or less privilege in the same checkout", () => {
    expect(serverWakeInScope(captured, shell)).toBe(true);
    expect(serverWakeInScope(captured, { ...shell, runtimeMode: "approval-required" })).toBe(true);
  });
  it("refuses more privilege or another checkout", () => {
    expect(serverWakeInScope(captured, { ...shell, runtimeMode: "full-access" })).toBe(false);
    expect(serverWakeInScope(captured, { ...shell, worktreePath: "/tmp/other" })).toBe(false);
    expect(serverWakeInScope(captured, { ...shell, worktreePath: null })).toBe(false);
  });
});

describe("SERVER_WAKE_COPY", () => {
  it("never words a pull request update as a delegated result", () => {
    const delegated = JSON.stringify(SERVER_WAKE_COPY["delegation-return"]);
    for (const text of Object.values(SERVER_WAKE_COPY["pull-request-watch"]).flatMap((entry) =>
      typeof entry === "string" ? [entry] : [entry.summary, entry.detail],
    )) {
      expect(text).not.toMatch(/delegat/i);
      expect(delegated).not.toContain(text);
    }
  });
});
