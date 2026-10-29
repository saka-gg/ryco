import { ORPHANED_PROVIDER_SESSION_ERROR } from "@ryco/shared/restartContinuation";
import { assert, describe, it } from "@effect/vitest";

import { formatRemoteThreads } from "./threads.ts";

const now = "2026-09-30T00:00:00.000Z";
const thread = (id: string, updatedAt: string, extra: Record<string, unknown> = {}) => ({
  id,
  projectId: "project-1",
  title: `Thread ${id}`,
  runtimeMode: "full-access",
  interactionMode: "default",
  updatedAt,
  archivedAt: null,
  session: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  ...extra,
});
const snapshot = {
  snapshotSequence: 10,
  projects: [{ id: "project-1", title: "ryco" }],
  threads: [
    thread("t-old", "2026-09-01T00:00:00.000Z"),
    thread("t-new", "2026-09-29T00:00:00.000Z", { hasPendingApprovals: true }),
    thread("t-gone", "2026-09-30T00:00:00.000Z", { archivedAt: now }),
    thread("t-restarted", "2026-08-31T00:00:00.000Z", {
      session: { status: "error", lastError: ORPHANED_PROVIDER_SESSION_ERROR },
    }),
    thread("t-failed", "2026-08-30T00:00:00.000Z", {
      session: { status: "error", lastError: "The provider crashed." },
    }),
  ],
  updatedAt: now,
} as never;

describe("ryco remote threads", () => {
  it("lists open threads newest first with what they need", () => {
    const lines = formatRemoteThreads(snapshot).split("\n");
    assert.deepEqual(
      lines.map((line) => line.split(/\s{2,}/u).slice(0, 2)),
      [
        ["t-new", "needs approval"],
        ["t-old", "idle"],
        // A node restart cut the turn off; nothing failed.
        ["t-restarted", "interrupted"],
        ["t-failed", "error"],
      ],
    );
    assert.include(lines[0]!, "ryco / Thread t-new");
  });
});
