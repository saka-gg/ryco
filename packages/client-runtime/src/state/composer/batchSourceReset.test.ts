import { expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId, ProviderInstanceId } from "@ryco/contracts";
import { completeBatchSourceReset, type BatchSourceResetSnapshot } from "./batchSourceDraft.ts";

it.each([false, true])(
  "preserves target edits during delayed deletion: %s",
  async (editTargets) => {
    const snapshot: BatchSourceResetSnapshot = {
      environmentId: EnvironmentId.make("fixture-node"),
      projectId: ProjectId.make("fixture-project"),
      sourceId: "completed-source",
      prompt: "Retained prompt",
      attachments: [],
      selections: [{ instanceId: ProviderInstanceId.make("first"), model: "model" }],
    };
    let current = snapshot;
    let finishDeletion!: () => void;
    const deletion = new Promise<void>((resolve) => {
      finishDeletion = resolve;
    });
    const removeSource = vi.fn(() => deletion);
    const clearSource = vi.fn(() => {
      current = { ...current, prompt: "", attachments: [], selections: [] };
    });
    const releaseSource = vi.fn(async () => true);
    const reset = completeBatchSourceReset(snapshot, {
      releaseSource,
      removeSource,
      readCurrent: () => current,
      clearSource,
    });
    await vi.waitFor(() => expect(removeSource).toHaveBeenCalledTimes(1));
    expect(clearSource).not.toHaveBeenCalled();
    const newSelections = [{ instanceId: ProviderInstanceId.make("second"), model: "other-model" }];
    if (editTargets) current = { ...current, selections: newSelections };
    finishDeletion();
    expect(await reset).toBe(!editTargets);
    expect(releaseSource).toHaveBeenCalledTimes(1);
    if (editTargets) {
      expect(clearSource).not.toHaveBeenCalled();
      expect(current.selections).toBe(newSelections);
      expect(current.prompt).toBe(snapshot.prompt);
    } else {
      expect(clearSource).toHaveBeenCalledTimes(1);
      expect(current.selections).toEqual([]);
    }
  },
);
