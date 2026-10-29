import { describe, expect, it, vi } from "vitest";
import type {
  EffectiveProjectPreferences,
  EnvironmentApi,
  ModelSelection,
  PreferenceSource,
  ServerConfig,
  ServerProvider,
} from "@ryco/contracts";
import {
  DEFAULT_MODEL,
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@ryco/contracts";
import {
  initialDraftModelSelection,
  readEffectiveProjectPreferences,
  resolveNewDraftModelSelection,
  type StickyModelSelectionState,
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

describe("new draft model selection", () => {
  const codex = ProviderInstanceId.make("codex");
  const cursor = ProviderInstanceId.make("cursor");
  const claude = ProviderInstanceId.make("claudeAgent");
  const preferences = (value: ModelSelection, source: PreferenceSource) =>
    ({ initialModelSelection: { value, source } }) as unknown as EffectiveProjectPreferences;
  const builtin = preferences({ instanceId: codex, model: DEFAULT_MODEL }, "builtin");
  const provider = (
    instanceId: ProviderInstanceId,
    driver: string,
    state: Partial<ServerProvider> = {},
  ): ServerProvider =>
    ({
      instanceId,
      driver: ProviderDriverKind.make(driver),
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-10-28T00:00:00.000Z",
      models: [{ slug: `${driver}-default`, name: "Default", isCustom: false, capabilities: null }],
      slashCommands: [],
      skills: [],
      ...state,
    }) as ServerProvider;
  const signedOut = { status: "error", auth: { status: "unauthenticated" } } as const;
  const pending = { status: "warning", installed: false, auth: { status: "unknown" } } as const;
  const sticky = (...selections: ModelSelection[]): StickyModelSelectionState => ({
    stickyActiveProvider: selections[0]?.instanceId ?? null,
    stickyModelSelectionByProvider: Object.fromEntries(
      selections.map((selection) => [selection.instanceId, selection]),
    ),
  });
  const lastCursor = {
    instanceId: cursor,
    model: "composer-2",
    options: [{ id: "fastMode", value: true }],
  };

  it("opens on the last-used selection rather than Ryco's built-in default", () => {
    expect(
      resolveNewDraftModelSelection({
        effective: builtin,
        sticky: sticky(lastCursor),
        providers: [provider(codex, "codex"), provider(cursor, "cursor")],
      }),
    ).toEqual(lastCursor);
  });

  it("keeps a project or node preference over the last-used selection", () => {
    for (const source of ["project", "node", "legacy-project"] as const) {
      expect(
        resolveNewDraftModelSelection({
          effective: preferences({ instanceId: codex, model: "gpt-5.4" }, source),
          sticky: sticky(lastCursor),
          providers: [provider(codex, "codex"), provider(cursor, "cursor")],
        }),
      ).toEqual({ instanceId: codex, model: "gpt-5.4", options: [] });
    }
  });

  it("moves off a signed-out provider to the last-used one, else the first ready one", () => {
    const providers = [
      provider(codex, "codex", signedOut),
      provider(claude, "claudeAgent", signedOut),
      provider(cursor, "cursor"),
    ];
    const nodePreference = preferences({ instanceId: codex, model: "gpt-5.4" }, "node");
    expect(
      resolveNewDraftModelSelection({
        effective: nodePreference,
        sticky: sticky(lastCursor),
        providers,
      }),
    ).toEqual(lastCursor);
    expect(
      resolveNewDraftModelSelection({ effective: builtin, sticky: sticky(), providers }),
    ).toEqual({ instanceId: cursor, model: "cursor-default", options: [] });
    // A last-used selection on a provider that is now signed out is not kept either.
    expect(
      resolveNewDraftModelSelection({
        effective: builtin,
        sticky: sticky({ instanceId: claude, model: "claude-opus-4-6" }, lastCursor),
        providers,
      }),
    ).toEqual(lastCursor);
  });

  it("leaves the choice alone while providers are unknown or nothing else is ready", () => {
    const fallback = { instanceId: codex, model: DEFAULT_MODEL, options: [] };
    expect(
      resolveNewDraftModelSelection({ effective: builtin, sticky: sticky(), providers: [] }),
    ).toEqual(fallback);
    // Not probed yet: a pending snapshot is no reason to switch.
    expect(
      resolveNewDraftModelSelection({
        effective: builtin,
        sticky: sticky(),
        providers: [provider(codex, "codex", pending), provider(cursor, "cursor")],
      }),
    ).toEqual(fallback);
    expect(
      resolveNewDraftModelSelection({
        effective: builtin,
        sticky: sticky(),
        providers: [provider(codex, "codex", signedOut), provider(cursor, "cursor", pending)],
      }),
    ).toEqual(fallback);
  });

  it("moves off a last-used provider this node doesn't list", () => {
    // A custom instance that was deleted, or that only another node has.
    const lastMax = {
      instanceId: ProviderInstanceId.make("claude_max"),
      model: "claude-opus-4-6",
      options: [],
    };
    const fallback = { instanceId: codex, model: DEFAULT_MODEL, options: [] };
    expect(
      resolveNewDraftModelSelection({
        effective: builtin,
        sticky: sticky(lastMax),
        providers: [provider(codex, "codex")],
      }),
    ).toEqual(fallback);
    expect(
      resolveNewDraftModelSelection({
        effective: builtin,
        sticky: sticky(lastMax),
        providers: [provider(codex, "codex", signedOut), provider(claude, "claudeAgent")],
      }),
    ).toEqual({ instanceId: claude, model: "claudeAgent-default", options: [] });
    expect(
      resolveNewDraftModelSelection({
        effective: builtin,
        sticky: sticky(lastMax),
        providers: [provider(codex, "codex", pending)],
      }),
    ).toEqual(fallback);
    // Nothing can run: the built-in default, which the node lists, rather than the missing one.
    expect(
      resolveNewDraftModelSelection({
        effective: builtin,
        sticky: sticky(lastMax),
        providers: [provider(codex, "codex", signedOut), provider(claude, "claudeAgent", pending)],
      }),
    ).toEqual(fallback);
  });

  it("keeps a listed last-used provider that is ready or not probed yet, traits included", () => {
    const lastClaude = {
      instanceId: claude,
      model: "claude-opus-4-6",
      options: [{ id: "fastMode", value: true }],
    };
    for (const state of [{}, pending]) {
      expect(
        resolveNewDraftModelSelection({
          effective: builtin,
          sticky: sticky(lastClaude),
          providers: [provider(codex, "codex"), provider(claude, "claudeAgent", state)],
        }),
      ).toEqual(lastClaude);
    }
  });

  it("keeps a configured model whose probe failed, but not a last-used one", () => {
    // A version probe that timed out says nothing about sign-in; the next probe may pass.
    const probeFailed = { status: "error", auth: { status: "unknown" } } as const;
    const claudePreference = preferences({ instanceId: claude, model: "claude-opus-4-6" }, "node");
    const providers = [provider(codex, "codex"), provider(claude, "claudeAgent", probeFailed)];
    expect(
      resolveNewDraftModelSelection({ effective: claudePreference, sticky: sticky(), providers }),
    ).toEqual({ instanceId: claude, model: "claude-opus-4-6", options: [] });
    // Signed out or not installed is a reason to move even off a configured model.
    for (const state of [signedOut, { ...probeFailed, installed: false }]) {
      expect(
        resolveNewDraftModelSelection({
          effective: claudePreference,
          sticky: sticky(),
          providers: [provider(codex, "codex"), provider(claude, "claudeAgent", state)],
        }),
      ).toEqual({ instanceId: codex, model: "codex-default", options: [] });
    }
    expect(
      resolveNewDraftModelSelection({
        effective: builtin,
        sticky: sticky({ instanceId: claude, model: "claude-opus-4-6" }),
        providers,
      }),
    ).toEqual({ instanceId: codex, model: DEFAULT_MODEL, options: [] });
  });

  it("keeps an explicit choice and leaves a node without preferences to the sticky seed", () => {
    const explicit = { instanceId: codex, model: "caller-model" };
    expect(
      resolveNewDraftModelSelection({
        effective: builtin,
        explicit,
        sticky: sticky(lastCursor),
        providers: [provider(codex, "codex", signedOut), provider(cursor, "cursor")],
      }),
    ).toEqual({ ...explicit, options: [] });
    expect(
      resolveNewDraftModelSelection({
        effective: null,
        sticky: sticky(),
        providers: [provider(codex, "codex", signedOut), provider(cursor, "cursor")],
      }),
    ).toBeNull();
  });
});
