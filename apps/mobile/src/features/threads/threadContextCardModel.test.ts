import { describe, expect, it } from "vite-plus/test";

import {
  contextRingPercent,
  machineStatusTone,
  threadContextCardQuickButtons,
  threadContextCardRows,
} from "./threadContextCardModel";

const noExtras = {
  goal: null,
  parent: null,
  delegatedCount: 0,
  agents: null,
  cacheSummary: null,
  receiptCount: 0,
  watchLabel: null,
} as const;

describe("thread context card", () => {
  it("offers only the quick buttons that apply", () => {
    expect(
      threadContextCardQuickButtons({
        filesVisible: true,
        reviewVisible: false,
        changeRequest: null,
      }).map((button) => button.id),
    ).toEqual(["files"]);
    expect(
      threadContextCardQuickButtons({
        filesVisible: true,
        reviewVisible: true,
        changeRequest: { kind: "pr" } as never,
      }).map((button) => button.label),
    ).toEqual(["Files", "Changes", "PR"]);
  });

  it("has no extra rows for a plain chat", () => {
    expect(threadContextCardRows(noExtras)).toEqual([]);
  });

  it("lists the chat's extras in order, each leading where it belongs", () => {
    const rows = threadContextCardRows({
      goal: { objective: "Ship the composer", status: "paused" },
      parent: { title: "Coordinator", resultLabel: "Returned" },
      delegatedCount: 2,
      agents: { label: "1 agent" },
      cacheSummary: "128k read",
      receiptCount: 3,
      watchLabel: "Watching",
    });
    expect(rows.map((row) => [row.id, row.target])).toEqual([
      ["goal", "details"],
      ["parent", "parent"],
      ["delegated", "details"],
      ["cache", "cache"],
      ["watch", "details"],
      ["receipts", "details"],
    ]);
    expect(rows[0]).toMatchObject({ label: "Ship the composer", detail: "Paused" });
    expect(rows[2]?.label).toBe("2 delegated chats");
  });

  it("shows the subagents when the chat delegated no chats", () => {
    expect(threadContextCardRows({ ...noExtras, agents: { label: "2 agents working" } })).toEqual([
      expect.objectContaining({ id: "agents", label: "2 agents working", target: "agents" }),
    ]);
  });

  it("rounds the context ring to a clamped percent", () => {
    expect(contextRingPercent(0.344)).toBe(34);
    expect(contextRingPercent(1.4)).toBe(100);
    expect(contextRingPercent(null)).toBeNull();
  });

  it("colors the machine dot by its connection", () => {
    expect(machineStatusTone("connected")).toBe("online");
    expect(machineStatusTone("reconnecting")).toBe("connecting");
    expect(machineStatusTone("offline")).toBe("offline");
    expect(machineStatusTone("error")).toBe("offline");
  });
});
