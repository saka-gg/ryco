import type { EnvironmentId, OrchestrationThreadActivity, ThreadId } from "@ryco/contracts";
import { EventId } from "@ryco/contracts/base-schemas";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { appAtomRegistry } from "../../rpc/atomRegistry.ts";
import {
  createActivityPayloadQuery,
  resolveActivityChangedFiles,
  resolveActivityPayloadOutputView,
  type ActivityPayloadInput,
  type ActivityPayloadQueryState,
} from "./activityPayload.ts";
import { deriveWorkLogEntries } from "./session-logic.ts";

const environmentId = "env-1" as EnvironmentId;
const threadId = "thread-1" as ThreadId;
const input: ActivityPayloadInput = { environmentId, threadId, activityId: "activity-1" };

const commandPayload = (output: string) => ({
  itemType: "command_execution",
  data: { item: { type: "commandExecution", aggregatedOutput: output, exitCode: 2 } },
});

let reset: (() => void) | null = null;
afterEach(() => {
  reset?.();
  reset = null;
});

describe("createActivityPayloadQuery", () => {
  it("reads the stored payload through the injected environment API once per key", async () => {
    const getActivityPayload = vi.fn(async () => ({
      activityId: "activity-1",
      payload: commandPayload("full output"),
      fullBytes: 11,
      truncated: false,
    }));
    const resolveGetActivityPayload = vi.fn(() => getActivityPayload as never);
    const { query, resetForTests } = createActivityPayloadQuery({ resolveGetActivityPayload });
    reset = resetForTests;

    const key = query.keyOf(input);
    const release = query.watch(input);
    await vi.waitFor(() => expect(appAtomRegistry.get(query.getAtom(key)).data).not.toBeNull());
    expect(resolveGetActivityPayload).toHaveBeenCalledWith(environmentId);
    expect(getActivityPayload).toHaveBeenCalledExactlyOnceWith({
      threadId,
      activityId: "activity-1",
    });
    release();

    // Stored payloads never change: a reopen within the retention window
    // reads the cache.
    const releaseAgain = query.watch(input);
    expect(getActivityPayload).toHaveBeenCalledOnce();
    releaseAgain();
  });

  it("has no key, and sends nothing, without an activity id", () => {
    const getActivityPayload = vi.fn();
    const { query, resetForTests } = createActivityPayloadQuery({
      resolveGetActivityPayload: () => getActivityPayload as never,
    });
    reset = resetForTests;
    expect(query.keyOf({ ...input, activityId: null })).toBeNull();
    query.watch({ ...input, activityId: null })();
    expect(getActivityPayload).not.toHaveBeenCalled();
  });
});

describe("resolveActivityPayloadOutputView", () => {
  const state = (overrides: Partial<ActivityPayloadQueryState>): ActivityPayloadQueryState => ({
    data: null,
    isLoading: false,
    error: null,
    ...overrides,
  });

  it("is idle without a key and loading or failed until the payload arrives", () => {
    expect(resolveActivityPayloadOutputView(null, state({})).status).toBe("idle");
    expect(resolveActivityPayloadOutputView("key", state({ isLoading: true })).status).toBe(
      "loading",
    );
    expect(
      resolveActivityPayloadOutputView("key", state({ error: new Error("offline") })).status,
    ).toBe("error");
  });

  it("derives the output and exit code of a loaded payload", () => {
    const view = resolveActivityPayloadOutputView(
      "key",
      state({
        data: {
          activityId: "activity-1" as never,
          payload: commandPayload("full output"),
          fullBytes: 11,
          truncated: true,
        },
      }),
    );
    expect(view).toEqual({
      status: "loaded",
      output: "full output",
      exitCode: 2,
      changedFiles: [],
      truncated: true,
    });
  });

  it("completes a previewed edit's changed files from the loaded payload", () => {
    const fileChangePayload = (count: number) => ({
      itemType: "file_change",
      data: {
        changes: Array.from({ length: count }, (_, index) => ({
          path: `src/file-${index}.ts`,
          diff: `@@ -1 +1 @@\n-old ${index}\n+new ${index}`,
        })),
      },
    });
    // The window kept only the first 4 of the edit's 14 changes.
    const previewActivity: OrchestrationThreadActivity = {
      id: EventId.make("edit-1"),
      createdAt: "2026-10-15T00:00:00.000Z",
      kind: "tool.completed",
      summary: "Edited files",
      tone: "tool",
      payload: fileChangePayload(4),
      payloadPreview: { fullBytes: 400_000 },
      turnId: null,
    } as OrchestrationThreadActivity;
    const [entry] = deriveWorkLogEntries([previewActivity], undefined);
    expect(entry?.outputPreviewActivityId).toBe("edit-1");
    expect(entry?.changedFiles).toHaveLength(4);

    const loading = resolveActivityPayloadOutputView("key", state({ isLoading: true }));
    expect(resolveActivityChangedFiles(entry?.changedFiles ?? [], loading)).toHaveLength(4);

    const loaded = resolveActivityPayloadOutputView(
      "key",
      state({
        data: {
          activityId: "edit-1" as never,
          payload: fileChangePayload(14),
          fullBytes: 400_000,
          truncated: false,
        },
      }),
    );
    // Listed up to the work log's changed-file cap, as for a payload sent in full.
    const [full] = deriveWorkLogEntries(
      [{ ...previewActivity, payload: fileChangePayload(14), payloadPreview: undefined }],
      undefined,
    );
    expect(full?.changedFiles).toHaveLength(12);
    expect(resolveActivityChangedFiles(entry?.changedFiles ?? [], loaded)).toEqual(
      full?.changedFiles,
    );
  });
});
