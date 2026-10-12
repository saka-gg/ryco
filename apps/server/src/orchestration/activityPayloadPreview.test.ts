import { EventId, ThreadId } from "@ryco/contracts";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";

import { PersistenceSqlError } from "../persistence/Errors.ts";
import {
  ACTIVITY_PAYLOAD_RESPONSE_MAX_BYTES,
  ACTIVITY_PREVIEW_MAX_BYTES,
  boundPayload,
  loadActivityPayload,
  jsonByteLength,
  previewActivityPayload,
  TOOL_ACTIVITY_PREVIEW_MAX_BYTES,
} from "./activityPayloadPreview.ts";

const preview = (kind: string, payload: unknown) =>
  previewActivityPayload({ kind, payload, payloadBytes: jsonByteLength(payload) });

describe("previewActivityPayload", () => {
  it("returns a payload that fits unchanged and by reference", () => {
    const payload = { itemType: "command_execution", data: { item: { command: "ls" } } };
    const result = preview("tool.completed", payload);
    expect(result.truncated).toBe(false);
    expect(result.payload).toBe(payload);
  });

  it("bounds tool output while keeping structure, scalars, and changed files", () => {
    const payload = {
      itemType: "file_change",
      status: "completed",
      data: {
        item: {
          exitCode: 2,
          changes: [
            { path: "a.ts", additions: 10, deletions: 2, diff: "+".repeat(200_000) },
            { path: "b.ts", additions: 1, deletions: 0, diff: "-".repeat(200_000) },
          ],
        },
      },
    };
    const result = preview("tool.completed", payload);
    expect(result.truncated).toBe(true);
    expect(result.bytes).toBeLessThanOrEqual(TOOL_ACTIVITY_PREVIEW_MAX_BYTES);
    expect(result.bytes).toBe(jsonByteLength(result.payload));
    const item = (result.payload as typeof payload).data.item;
    expect(item.exitCode).toBe(2);
    expect(
      item.changes.map(({ path, additions, deletions }) => [path, additions, deletions]),
    ).toEqual([
      ["a.ts", 10, 2],
      ["b.ts", 1, 0],
    ]);
    expect(item.changes[0]!.diff.endsWith("…")).toBe(true);
  });

  it("cuts long arrays and falls back to top-level scalars for pathological shapes", () => {
    const manyKeys = Object.fromEntries(
      Array.from({ length: 5_000 }, (_, index) => [`key-${index}`, { nested: index }]),
    );
    const result = preview("tool.completed", { status: "completed", huge: manyKeys });
    expect(result.truncated).toBe(true);
    expect(result.bytes).toBeLessThanOrEqual(TOOL_ACTIVITY_PREVIEW_MAX_BYTES);
    expect(result.payload).toEqual({ status: "completed" });

    const list = preview("tool.updated", { items: Array.from({ length: 10_000 }, (_, i) => i) });
    expect((list.payload as { items: number[] }).items.length).toBeLessThan(10_000);
    expect(list.bytes).toBeLessThanOrEqual(TOOL_ACTIVITY_PREVIEW_MAX_BYTES);
  });

  it("gives structured non-tool activities a much larger budget", () => {
    const payload = { requestId: "r1", questions: [{ prompt: "q".repeat(20_000) }] };
    expect(preview("user-input.requested", payload).truncated).toBe(false);
    const huge = { requestId: "r1", detail: "d".repeat(ACTIVITY_PREVIEW_MAX_BYTES * 2) };
    const result = preview("user-input.requested", huge);
    expect(result.truncated).toBe(true);
    expect((result.payload as typeof huge).requestId).toBe("r1");
    expect(result.bytes).toBeLessThanOrEqual(ACTIVITY_PREVIEW_MAX_BYTES);
  });

  it("never splits a surrogate pair", () => {
    const payload = { text: "😀".repeat(20_000) };
    const result = boundPayload({
      payload,
      payloadBytes: jsonByteLength(payload),
      maxBytes: 4_096,
    });
    const text = (result.payload as typeof payload).text;
    expect(text.endsWith("…")).toBe(true);
    expect(/[\uD800-\uDBFF]…$/.test(text)).toBe(false);
  });
});

describe("loadActivityPayload", () => {
  const input = { threadId: ThreadId.make("thread-1"), activityId: EventId.make("activity-1") };
  const run = (query: Parameters<typeof loadActivityPayload>[0]) =>
    Effect.runPromise(Effect.result(loadActivityPayload(query, input)));

  it("returns the stored payload whole when one response carries it", async () => {
    const payload = { data: { item: { aggregatedOutput: "z".repeat(500_000) } } };
    const result = await run(() =>
      Effect.succeed(
        Option.some({ kind: "tool.completed", payload, payloadBytes: jsonByteLength(payload) }),
      ),
    );
    expect(result._tag).toBe("Success");
    if (result._tag === "Success") {
      expect(result.success.payload).toBe(payload);
      expect(result.success.truncated).toBe(false);
      expect(result.success.fullBytes).toBe(jsonByteLength(payload));
    }
  });

  it("bounds a payload larger than one response", async () => {
    const payload = { data: { diff: "d".repeat(ACTIVITY_PAYLOAD_RESPONSE_MAX_BYTES + 10) } };
    const result = await run(() =>
      Effect.succeed(
        Option.some({ kind: "tool.completed", payload, payloadBytes: jsonByteLength(payload) }),
      ),
    );
    expect(result._tag).toBe("Success");
    if (result._tag === "Success") {
      expect(result.success.truncated).toBe(true);
      expect(jsonByteLength(result.success.payload)).toBeLessThanOrEqual(
        ACTIVITY_PAYLOAD_RESPONSE_MAX_BYTES,
      );
    }
  });

  it("reports missing activities, failed reads, and servers without the query", async () => {
    const reasonOf = (result: Awaited<ReturnType<typeof run>>) =>
      result._tag === "Failure" ? result.failure.reason : null;
    expect(reasonOf(await run(() => Effect.succeed(Option.none())))).toBe("not-found");
    expect(
      reasonOf(
        await run(() =>
          Effect.fail(new PersistenceSqlError({ operation: "read", detail: "boom" })),
        ),
      ),
    ).toBe("unavailable");
    expect(reasonOf(await run(undefined))).toBe("unavailable");
  });
});
