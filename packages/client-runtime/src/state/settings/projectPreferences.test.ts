import { describe, expect, it, vi } from "vitest";
import type { EffectiveProjectPreferences, EnvironmentApi, ServerConfig } from "@ryco/contracts";
import { DEFAULT_MODEL, EnvironmentId, ProjectId, ProviderInstanceId } from "@ryco/contracts";
import {
  initialDraftModelSelection,
  readEffectiveProjectPreferences,
} from "./projectPreferences.ts";
import { createComposerDraftStore, DraftId } from "../composer/draftStore.ts";

function config(enabled?: boolean) {
  return { environment: { capabilities: { projectPreferences: enabled } } } as ServerConfig;
}
describe("shared project preference reads", () => {
  it("negotiates support against current node capabilities after upgrades and rollbacks", async () => {
    const read = vi.fn(async () => ({ marker: "effective" }));
    const api = { server: { getProjectPreferences: read } } as unknown as EnvironmentApi;
    expect(
      await readEffectiveProjectPreferences({
        api,
        config: config(),
        projectId: ProjectId.make("p"),
      }),
    ).toBeNull();
    expect(read).not.toHaveBeenCalled();
    expect(
      await readEffectiveProjectPreferences({
        api,
        config: config(true),
        projectId: ProjectId.make("p"),
      }),
    ).toEqual({ marker: "effective" });
    expect(read).toHaveBeenLastCalledWith({ projectId: "p" });
    expect(
      await readEffectiveProjectPreferences({
        api,
        config: config(false),
        projectId: ProjectId.make("p"),
      }),
    ).toBeNull();
    expect(read).toHaveBeenCalledOnce();
  });
  it("propagates disconnected/deleted project failures without guessing a replacement", async () => {
    const read = vi.fn(async () => {
      throw new Error("Project unavailable");
    });
    const api = { server: { getProjectPreferences: read } } as unknown as EnvironmentApi;
    await expect(
      readEffectiveProjectPreferences({
        api,
        config: config(true),
        projectId: ProjectId.make("gone"),
      }),
    ).rejects.toThrow("Project unavailable");
    await expect(
      readEffectiveProjectPreferences({ api: {}, config: config(true) } as never),
    ).rejects.toThrow("unavailable");
  });
});

describe("fresh target model presets", () => {
  const fallback = { instanceId: ProviderInstanceId.make("codex"), model: DEFAULT_MODEL };
  const traits = [
    { id: "reasoningEffort", value: "high" },
    { id: "fastMode", value: true },
  ];
  const preset = (model: string, options?: typeof traits) =>
    ({
      initialModelSelection: {
        value: { instanceId: fallback.instanceId, model, ...(options ? { options } : {}) },
        source: "project",
      },
    }) as unknown as EffectiveProjectPreferences;

  it("replaces sticky high/fast traits when the new project's preset omits options", () => {
    const store = createComposerDraftStore({
      storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
      flushStorage: () => {},
      revokePreviewUrl: () => {},
      hydrateImages: () => [],
      readPersistedAttachmentIds: () => [],
    }).useComposerDraftStore;
    const oldDraft = DraftId.make("old");
    const newDraft = DraftId.make("new");
    const project = {
      environmentId: EnvironmentId.make("node"),
      projectId: ProjectId.make("project"),
    };
    store.getState().setLogicalProjectDraftThreadId("old-project", project, oldDraft);
    store.getState().setModelSelection(oldDraft, { ...fallback, options: traits });
    store.getState().setStickyModelSelection({ ...fallback, options: traits });
    store.getState().setLogicalProjectDraftThreadId("new-project", project, newDraft);
    store.getState().applyStickyState(newDraft);
    store
      .getState()
      .setModelSelection(
        newDraft,
        initialDraftModelSelection({ effective: preset("new-model"), fallback }),
      );
    expect(
      store.getState().getComposerDraft(newDraft)?.modelSelectionByProvider[fallback.instanceId],
    ).toEqual({
      ...fallback,
      model: "new-model",
    });
    expect(
      store.getState().getComposerDraft(oldDraft)?.modelSelectionByProvider[fallback.instanceId]
        ?.options,
    ).toEqual(traits);
    const explicit = { ...fallback, model: "caller-model", options: traits };
    expect(
      initialDraftModelSelection({ effective: preset("project-model"), fallback, explicit }),
    ).toEqual(explicit);
  });

  it("uses target legacy defaults after a capable node switches to an older node with the same project id", async () => {
    const apiA = {
      server: { getProjectPreferences: async () => preset("node-a-model", traits) },
    } as unknown as EnvironmentApi;
    const apiB = { server: {} } as EnvironmentApi;
    const projectId = ProjectId.make("same-project");
    const a = initialDraftModelSelection({
      effective: await readEffectiveProjectPreferences({
        api: apiA,
        config: config(true),
        projectId,
      }),
      fallback,
    });
    expect(a.model).toBe("node-a-model");
    const b = initialDraftModelSelection({
      effective: await readEffectiveProjectPreferences({ api: apiB, config: config(), projectId }),
      fallback,
    });
    expect(b).toEqual({ ...fallback, options: [] });
    expect(b).not.toEqual(a);
  });
});
