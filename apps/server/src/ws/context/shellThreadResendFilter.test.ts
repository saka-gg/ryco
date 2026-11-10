import type { OrchestrationShellStreamEvent, OrchestrationThreadShell } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  makeShellThreadResendFilter,
  SHELL_THREAD_TIMESTAMP_RESEND_MS,
  sameJsonValue,
} from "./shellThreadResendFilter.ts";

const row = (overrides: Record<string, unknown> = {}) =>
  ({
    id: "thread-1",
    title: "Thread",
    updatedAt: "2026-11-10T00:00:00.000Z",
    session: { status: "running", updatedAt: "2026-11-10T00:00:00.000Z" },
    latestTurn: null,
    ...overrides,
  }) as unknown as OrchestrationThreadShell;

const upsert = (thread: OrchestrationThreadShell, sequence = 1): OrchestrationShellStreamEvent => ({
  kind: "thread-upserted",
  sequence,
  thread,
});

describe("sameJsonValue", () => {
  it("compares JSON values deeply, ignoring key order, absent keys and one top-level key", () => {
    expect(sameJsonValue({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toBe(true);
    expect(sameJsonValue({ a: 1, b: undefined }, { a: 1 })).toBe(true);
    expect(sameJsonValue({ a: 1 }, { a: 2 })).toBe(false);
    expect(sameJsonValue({ a: [1] }, { a: [1, 2] })).toBe(false);
    expect(sameJsonValue({ a: 1, t: "x" }, { a: 1, t: "y" }, "t")).toBe(true);
    expect(sameJsonValue({ n: { t: "x" } }, { n: { t: "y" } }, "t")).toBe(false);
    expect(sameJsonValue({ a: null }, { a: {} })).toBe(false);
    expect(sameJsonValue([], {})).toBe(false);
  });
});

describe("makeShellThreadResendFilter", () => {
  it("sends the first row, drops repeats and timestamp-only changes until the resend interval", () => {
    let now = 0;
    const keep = makeShellThreadResendFilter(() => now);
    expect(keep(upsert(row()))).toBe(true);
    expect(keep(upsert(row()))).toBe(false);
    now = 1_000;
    expect(keep(upsert(row({ updatedAt: "2026-11-10T00:00:01.000Z" })))).toBe(false);
    now = SHELL_THREAD_TIMESTAMP_RESEND_MS;
    expect(keep(upsert(row({ updatedAt: "2026-11-10T00:00:10.000Z" })))).toBe(true);
    // The same row again is never resent, however late.
    now = 10 * SHELL_THREAD_TIMESTAMP_RESEND_MS;
    expect(keep(upsert(row({ updatedAt: "2026-11-10T00:00:10.000Z" })))).toBe(false);
  });

  it("sends every change of a field clients use at once", () => {
    const keep = makeShellThreadResendFilter(() => 0);
    expect(keep(upsert(row()))).toBe(true);
    expect(keep(upsert(row({ title: "Renamed" })))).toBe(true);
    // A session status change (the running-thread keep-alive orders by the session's time).
    expect(
      keep(
        upsert(
          row({
            title: "Renamed",
            session: { status: "ready", updatedAt: "2026-11-10T00:00:02.000Z" },
          }),
        ),
      ),
    ).toBe(true);
  });

  it("sends a thread again after it was removed, and passes every other item", () => {
    const keep = makeShellThreadResendFilter(() => 0);
    expect(keep(upsert(row()))).toBe(true);
    expect(keep({ kind: "thread-removed", sequence: 2, threadId: row().id })).toBe(true);
    expect(keep(upsert(row(), 3))).toBe(true);
    expect(keep({ kind: "project-removed", sequence: 4, projectId: "p" as never })).toBe(true);
  });
});
