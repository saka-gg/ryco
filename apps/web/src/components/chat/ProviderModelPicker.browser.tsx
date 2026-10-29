import { SettingsEditingScopeProvider } from "../../settingsTarget";
import {
  createComposerDraftStore,
  deriveEffectiveComposerModelState,
} from "@ryco/client-runtime/state/composer";
import { ThreadId } from "@ryco/contracts";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ResolvedKeybindingsConfig,
  type ServerProvider,
  type ProviderOptionSelection,
} from "@ryco/contracts";
import { EnvironmentId } from "@ryco/contracts";
import { createModelCapabilities } from "@ryco/shared/model";
import { page, userEvent } from "vite-plus/test/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { Suspense, type ReactNode } from "react";

import { LazyComposerModelTuning, ProviderModelPicker } from "./ProviderModelPicker";
import { ModelTuningDial } from "./ModelTuningDial";
import { resolveModelTuning, type ModelTuningSummary } from "./modelTuning.logic";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import type { ModelEsque } from "./providerIconUtils";
import {
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_UNIFIED_SETTINGS,
  type UnifiedSettings,
} from "@ryco/contracts/settings";
import { __resetLocalApiForTests } from "../../localApi";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";

// Mock the environments/runtime module to provide a mock primary environment connection
vi.mock("../../environments/runtime", () => {
  const primaryConnection = {
    kind: "primary" as const,
    knownEnvironment: {
      id: "environment-local",
      label: "Local environment",
      source: "manual" as const,
      environmentId: EnvironmentId.make("environment-local"),
      target: {
        httpBaseUrl: "http://localhost:3000",
        wsBaseUrl: "ws://localhost:3000",
      },
    },
    environmentId: EnvironmentId.make("environment-local"),
    client: {
      server: {
        getConfig: vi.fn(),
        updateSettings: vi.fn(),
      },
    },
    ensureBootstrapped: async () => undefined,
    reconnect: async () => undefined,
    dispose: async () => undefined,
  };

  return {
    getEnvironmentHttpBaseUrl: () => "http://localhost:3000",
    getSavedEnvironmentRecord: () => null,
    getSavedEnvironmentRuntimeState: () => null,
    hasSavedEnvironmentRegistryHydrated: () => true,
    listSavedEnvironmentRecords: () => [],
    resetSavedEnvironmentRegistryStoreForTests: vi.fn(),
    resetSavedEnvironmentRuntimeStoreForTests: vi.fn(),
    resolveEnvironmentHttpUrl: (_environmentId: unknown, path: string) =>
      new URL(path, "http://localhost:3000").toString(),
    waitForSavedEnvironmentRegistryHydration: async () => undefined,
    addSavedEnvironment: vi.fn(),
    disconnectSavedEnvironment: vi.fn(),
    ensureEnvironmentConnectionBootstrapped: async () => undefined,
    getPrimaryEnvironmentConnection: () => primaryConnection,
    readEnvironmentConnection: () => primaryConnection,
    reconnectSavedEnvironment: vi.fn(),
    removeSavedEnvironment: vi.fn(),
    requireEnvironmentConnection: () => primaryConnection,
    resetEnvironmentServiceForTests: vi.fn(),
    startEnvironmentConnectionService: vi.fn(),
    subscribeEnvironmentConnections: () => () => {},
    updateEnvironmentServerSettings: vi.fn().mockResolvedValue(undefined),
    useSavedEnvironmentRegistryStore: (
      selector: (state: { byId: Record<string, never> }) => unknown,
    ) => selector({ byId: {} }),
    useSavedEnvironmentRuntimeStore: (
      selector: (state: { byId: Record<string, never> }) => unknown,
    ) => selector({ byId: {} }),
  };
});

function selectDescriptor(
  id: string,
  label: string,
  options: ReadonlyArray<{ id: string; label: string; isDefault?: boolean }>,
) {
  return {
    id,
    label,
    type: "select" as const,
    options: [...options],
    ...(options.find((option) => option.isDefault)?.id
      ? { currentValue: options.find((option) => option.isDefault)?.id }
      : {}),
  };
}

function booleanDescriptor(id: string, label: string) {
  return {
    id,
    label,
    type: "boolean" as const,
  };
}

const TEST_PROVIDERS: ReadonlyArray<ServerProvider> = [
  {
    driver: ProviderDriverKind.make("codex"),
    instanceId: ProviderInstanceId.make("codex"),
    displayName: "Codex",
    enabled: true,
    installed: true,
    version: "0.116.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: new Date().toISOString(),
    slashCommands: [],
    skills: [],
    models: [
      {
        slug: "gpt-5-codex",
        name: "GPT-5 Codex",
        isCustom: false,
        capabilities: createModelCapabilities({
          optionDescriptors: [
            selectDescriptor("reasoningEffort", "Reasoning", [
              { id: "low", label: "low" },
              { id: "medium", label: "medium", isDefault: true },
              { id: "high", label: "high" },
            ]),
            booleanDescriptor("fastMode", "Fast Mode"),
          ],
        }),
      },
      {
        slug: "gpt-5.3-codex",
        name: "GPT-5.3 Codex",
        isCustom: false,
        capabilities: createModelCapabilities({
          optionDescriptors: [
            selectDescriptor("reasoningEffort", "Reasoning", [
              { id: "low", label: "low" },
              { id: "medium", label: "medium", isDefault: true },
              { id: "high", label: "high" },
            ]),
            booleanDescriptor("fastMode", "Fast Mode"),
          ],
        }),
      },
    ],
  },
  {
    driver: ProviderDriverKind.make("claudeAgent"),
    instanceId: ProviderInstanceId.make("claudeAgent"),
    displayName: "Claude",
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: new Date().toISOString(),
    slashCommands: [],
    skills: [],
    models: [
      {
        slug: "claude-opus-4-6",
        name: "Claude Opus 4.6",
        isCustom: false,
        capabilities: createModelCapabilities({
          optionDescriptors: [
            selectDescriptor("effort", "Reasoning", [
              { id: "low", label: "low" },
              { id: "medium", label: "medium", isDefault: true },
              { id: "high", label: "high" },
              { id: "max", label: "max" },
            ]),
            booleanDescriptor("thinking", "Thinking"),
          ],
        }),
      },
      {
        slug: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
        isCustom: false,
        capabilities: createModelCapabilities({
          optionDescriptors: [
            selectDescriptor("effort", "Reasoning", [
              { id: "low", label: "low" },
              { id: "medium", label: "medium", isDefault: true },
              { id: "high", label: "high" },
              { id: "max", label: "max" },
            ]),
            booleanDescriptor("thinking", "Thinking"),
          ],
        }),
      },
      {
        slug: "claude-haiku-4-5",
        name: "Claude Haiku 4.5",
        isCustom: false,
        capabilities: createModelCapabilities({
          optionDescriptors: [
            selectDescriptor("effort", "Reasoning", [
              { id: "low", label: "low" },
              { id: "medium", label: "medium", isDefault: true },
              { id: "high", label: "high" },
            ]),
            booleanDescriptor("thinking", "Thinking"),
          ],
        }),
      },
    ],
  },
];

const CODEX_INSTANCE_ID = ProviderInstanceId.make("codex");
const CLAUDE_INSTANCE_ID = ProviderInstanceId.make("claudeAgent");
const OPENCODE_INSTANCE_ID = ProviderInstanceId.make("opencode");

function buildCodexProvider(models: ServerProvider["models"]): ServerProvider {
  return {
    driver: ProviderDriverKind.make("codex"),
    instanceId: ProviderInstanceId.make("codex"),
    displayName: "Codex",
    enabled: true,
    installed: true,
    version: "0.116.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: new Date().toISOString(),
    models,
    slashCommands: [],
    skills: [],
  };
}

function buildOpenCodeProvider(models: ServerProvider["models"]): ServerProvider {
  return {
    driver: ProviderDriverKind.make("opencode"),
    instanceId: ProviderInstanceId.make("opencode"),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: new Date().toISOString(),
    models,
    slashCommands: [],
    skills: [],
  };
}

async function mountPicker(props: {
  activeInstanceId?: ProviderInstanceId;
  model: string;
  tuning?: ReactNode;
  triggerTraits?: ModelTuningSummary | null;
  modelOptions?: ReadonlyArray<ProviderOptionSelection> | undefined;
  lockedProvider: ProviderDriverKind | null;
  lockedContinuationGroupKey?: string | null;
  providers?: ReadonlyArray<ServerProvider>;
  settings?: UnifiedSettings;
  keybindings?: ResolvedKeybindingsConfig;
  insideOpenDialog?: boolean;
  editingScope?: "all" | "node";
  open?: boolean;
  triggerVariant?: "ghost" | "outline";
  /** Mounts the picker in a Suspense boundary with this fallback, as in the app. */
  suspenseFallback?: ReactNode;
  savedModelOptionsByInstance?:
    | Readonly<Partial<Record<string, ReadonlyArray<ProviderOptionSelection>>>>
    | undefined;
  onSelect?: (
    instanceId: ProviderInstanceId,
    model: string,
    options?: ReadonlyArray<ProviderOptionSelection>,
  ) => void;
}) {
  const host = document.createElement("div");
  document.body.append(host);
  const onInstanceModelChange = vi.fn(props.onSelect);
  const providers = props.providers ?? TEST_PROVIDERS;
  const instanceEntries = sortProviderInstanceEntries(deriveProviderInstanceEntries(providers));
  const activeInstanceId = props.activeInstanceId ?? CODEX_INSTANCE_ID;
  const renderPicker = (model: string) => {
    const modelOptionsByInstance = getCustomModelOptionsByInstance(
      props.settings ?? DEFAULT_UNIFIED_SETTINGS,
      providers,
      activeInstanceId,
      model,
    );
    const picker = (
      <SettingsEditingScopeProvider value={props.editingScope ?? "all"}>
        <ProviderModelPicker
          activeInstanceId={activeInstanceId}
          model={model}
          modelOptions={props.modelOptions}
          savedModelOptionsByInstance={props.savedModelOptionsByInstance}
          lockedProvider={props.lockedProvider}
          lockedContinuationGroupKey={props.lockedContinuationGroupKey ?? null}
          instanceEntries={instanceEntries}
          {...(props.keybindings ? { keybindings: props.keybindings } : {})}
          modelOptionsByInstance={modelOptionsByInstance}
          {...(props.open !== undefined ? { open: props.open } : {})}
          triggerVariant={props.triggerVariant}
          {...(props.tuning ? { tuning: props.tuning } : {})}
          {...(props.triggerTraits ? { triggerTraits: props.triggerTraits } : {})}
          onInstanceModelChange={onInstanceModelChange}
        />
      </SettingsEditingScopeProvider>
    );
    const tree = props.insideOpenDialog ? (
      <Dialog open>
        <DialogPopup>
          <DialogTitle>Settings</DialogTitle>
          {picker}
        </DialogPopup>
      </Dialog>
    ) : (
      picker
    );
    return props.suspenseFallback === undefined ? (
      tree
    ) : (
      <Suspense fallback={props.suspenseFallback}>{tree}</Suspense>
    );
  };
  const screen = await render(renderPicker(props.model), { container: host });

  return {
    onInstanceModelChange,
    /** Hands the picker a new active model, as the composer does after a pick. */
    rerenderModel: async (model: string) => {
      await screen.rerender(renderPicker(model));
    },
    // Back-compat alias used by callers that still assert on the old callback
    // name. Delegates to the instance-aware mock so existing expectations work.
    get onProviderModelChange() {
      return onInstanceModelChange;
    },
    cleanup: async () => {
      await screen.unmount();
      host.remove();
    },
  };
}

function getModelPickerListElement() {
  const modelPickerList = document.querySelector<HTMLElement>(".model-picker-list");
  expect(modelPickerList).not.toBeNull();
  return modelPickerList!;
}

function getModelPickerListText() {
  return getModelPickerListElement().textContent ?? "";
}

function getVisibleModelNames() {
  return Array.from(getModelPickerListElement().querySelectorAll<HTMLDivElement>("div.font-medium"))
    .map((element) => element.textContent?.replace(/New$/u, "").trim() ?? "")
    .filter((text) => text.length > 0);
}

function getSidebarProviderOrder() {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-model-picker-provider]")).map(
    (element) => element.dataset.modelPickerProvider ?? "",
  );
}

/** The composer's code-split dial for a model with a two-step effort. */
function TestComposerModelTuning(props: { onModelOptionsChange: (nextOptions: unknown) => void }) {
  return (
    <LazyComposerModelTuning
      provider={ProviderDriverKind.make("claudeAgent")}
      model="tuning-model"
      models={[
        {
          slug: "tuning-model",
          name: "Tuning Model",
          isCustom: false,
          capabilities: createModelCapabilities({
            optionDescriptors: [
              {
                id: "effort",
                label: "Reasoning",
                type: "select",
                options: [
                  { id: "low", label: "Low" },
                  { id: "high", label: "High", isDefault: true },
                ],
              },
            ],
          }),
        },
      ]}
      modelOptions={undefined}
      prompt=""
      onPromptChange={() => {}}
      onModelOptionsChange={props.onModelOptionsChange}
    />
  );
}

describe("ProviderModelPicker", () => {
  beforeEach(async () => {
    // Reset test environment before each test
    await __resetLocalApiForTests();
  });

  afterEach(async () => {
    document.body.innerHTML = "";
    await __resetLocalApiForTests();
  });

  // First in the file on purpose: neither the picker body nor the dial has
  // loaded yet. The Suspense boundary stands in for the app's: without one, a
  // dial that suspended would only hold React's commit and the list would still
  // appear with its dial, so only the fallback shows the regression.
  it("docks the composer's code-split dial without suspending on a cold open", async () => {
    expect(LazyComposerModelTuning.isLoaded()).toBe(false);
    const onModelOptionsChange = vi.fn();
    let fallbackShown = false;
    let dialWithFirstList: boolean | null = null;
    // Mutation records, not the DOM: a fallback swapped out again before the
    // callback runs still shows up in them.
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node instanceof HTMLElement && node.dataset.testid === "picker-fallback") {
            fallbackShown = true;
          }
        }
      }
      if (dialWithFirstList !== null || !document.querySelector(".model-picker-list")) return;
      dialWithFirstList = document.querySelector('[data-slot="model-tuning-dial"]') !== null;
    });
    observer.observe(document.body, { childList: true, subtree: true });
    const mounted = await mountPicker({
      activeInstanceId: CLAUDE_INSTANCE_ID,
      model: "claude-opus-4-6",
      lockedProvider: null,
      suspenseFallback: <span data-testid="picker-fallback" />,
      tuning: <TestComposerModelTuning onModelOptionsChange={onModelOptionsChange} />,
    });

    try {
      await page.getByRole("button").first().click();
      await vi.waitFor(() => expect(dialWithFirstList).not.toBeNull());
      // The body's load settled only with the dial's, so the dial never
      // suspended and the list never showed without its footer.
      expect(dialWithFirstList).toBe(true);
      expect(fallbackShown).toBe(false);
      await expect.element(page.getByPlaceholder("Search models...")).toHaveFocus();
      await userEvent.keyboard("{ArrowLeft}");
      expect(onModelOptionsChange).toHaveBeenLastCalledWith([{ id: "effort", value: "low" }]);
      expect(fallbackShown).toBe(false);
    } finally {
      observer.disconnect();
      await mounted.cleanup();
    }
  });

  it("persists client favorites when the picker is embedded in node settings", async () => {
    const mounted = await mountPicker({
      model: "gpt-5-codex",
      lockedProvider: null,
      editingScope: "node",
    });
    try {
      await page.getByRole("button").click();
      await page
        .getByRole("option")
        .filter({ hasText: "GPT-5 Codex" })
        .getByRole("button", { name: "Add to favorites" })
        .click();
      await vi.waitFor(() =>
        expect(JSON.parse(localStorage.getItem("ryco:client-settings:v1")!).favorites).toEqual([
          { provider: "codex", model: "gpt-5-codex", reasoningEffort: "medium" },
        ]),
      );
      expect(mounted.onInstanceModelChange).not.toHaveBeenCalled();
    } finally {
      await mounted.cleanup();
      localStorage.removeItem("ryco:client-settings:v1");
    }
  });

  it("uses human effort labels only for the active model and actual presets", async () => {
    const providers = [
      buildCodexProvider(
        ["first", "second"].map((slug) => ({
          slug,
          name: slug,
          isCustom: false,
          capabilities: createModelCapabilities({
            optionDescriptors: [
              selectDescriptor("reasoningEffort", "Reasoning", [
                { id: "xhigh", label: "Extra High", isDefault: true },
                { id: "low", label: "Low" },
              ]),
            ],
          }),
        })),
      ),
    ];
    localStorage.setItem(
      "ryco:client-settings:v1",
      JSON.stringify({
        ...DEFAULT_CLIENT_SETTINGS,
        favorites: [{ provider: "codex", model: "second", reasoningEffort: "xhigh" }],
      }),
    );
    const mounted = await mountPicker({
      model: "first",
      lockedProvider: null,
      providers,
      modelOptions: [{ id: "reasoningEffort", value: "low" }],
    });
    try {
      await page.getByRole("button").click();
      await page.getByRole("button", { name: "Codex", exact: true }).click();
      expect(page.getByRole("option").filter({ hasText: "first" }).element().textContent).toContain(
        "Low",
      );
      expect(
        page.getByRole("option").filter({ hasText: "second" }).element().textContent,
      ).not.toMatch(/Low|Extra High|xhigh/);
      await page.getByRole("button", { name: "Favorites", exact: true }).click();
      expect(page.getByRole("option").element().textContent).toContain("Extra High");
      expect(page.getByRole("option").element().textContent).not.toContain("xhigh");
    } finally {
      await mounted.cleanup();
      localStorage.removeItem("ryco:client-settings:v1");
    }
  });

  it("indexes a large catalog once and does not rescan runtime models when searching", async () => {
    let slugReads = 0;
    const count = 200;
    const models = Array.from({ length: count }, (_, index) => ({
      get slug() {
        slugReads += 1;
        return `catalog-${index}`;
      },
      name: `Catalog ${index}`,
      isCustom: false,
      capabilities: createModelCapabilities({
        optionDescriptors: [
          selectDescriptor("reasoningEffort", "Reasoning", [
            { id: "high", label: "High", isDefault: true },
          ]),
        ],
      }),
    }));
    const mounted = await mountPicker({
      model: "catalog-0",
      lockedProvider: null,
      providers: [buildCodexProvider(models)],
    });
    try {
      slugReads = 0;
      await page.getByRole("button").click();
      expect(slugReads).toBeLessThanOrEqual(count * 3);
      const readsAfterOpen = slugReads;
      await page.getByRole("combobox").fill("catalog 19");
      await vi.waitFor(() =>
        expect(document.querySelectorAll('[role="option"]').length).toBeLessThan(count),
      );
      expect(slugReads).toBe(readsAfterOpen);
    } finally {
      await mounted.cleanup();
    }
  });

  it("recognizes and removes a legacy favorite in its provider tab, including after reload", async () => {
    localStorage.setItem(
      "ryco:client-settings:v1",
      JSON.stringify({
        ...DEFAULT_CLIENT_SETTINGS,
        favorites: [{ provider: "codex", model: "gpt-5-codex" }],
      }),
    );
    const mounted = await mountPicker({ model: "gpt-5-codex", lockedProvider: null });
    try {
      await page.getByRole("button").click();
      await page.getByRole("button", { name: "Codex", exact: true }).click();
      const row = page.getByRole("option").filter({ hasText: "GPT-5 Codex" });
      await row.getByRole("button", { name: "Remove from favorites" }).click();
      await vi.waitFor(() =>
        expect(JSON.parse(localStorage.getItem("ryco:client-settings:v1")!).favorites).toEqual([]),
      );
    } finally {
      await mounted.cleanup();
    }
    await __resetLocalApiForTests();
    const reloaded = await mountPicker({ model: "gpt-5-codex", lockedProvider: null });
    try {
      await page.getByRole("button").click();
      expect(
        page
          .getByRole("option")
          .filter({ hasText: "GPT-5 Codex" })
          .getByRole("button", { name: "Add to favorites" })
          .query(),
      ).not.toBeNull();
      expect(JSON.parse(localStorage.getItem("ryco:client-settings:v1")!).favorites).toEqual([]);
    } finally {
      await reloaded.cleanup();
      localStorage.removeItem("ryco:client-settings:v1");
    }
  });

  it.each([undefined, "low"])(
    "switches Claude -> Codex favorite (%s) using the destination draft options",
    async (reasoningEffort) => {
      const { useComposerDraftStore: store } = createComposerDraftStore({
        storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
        flushStorage: () => {},
        revokePreviewUrl: () => {},
        hydrateImages: () => [],
        readPersistedAttachmentIds: () => [],
      });
      const ref = {
        environmentId: EnvironmentId.make("favorite-test"),
        threadId: ThreadId.make("thread"),
      };
      const saved = [
        { id: "reasoningEffort", value: "xhigh" },
        { id: "fastMode", value: true },
      ];
      store.getState().setModelSelection(ref, {
        instanceId: CODEX_INSTANCE_ID,
        model: "gpt-5-codex",
        options: saved,
      });
      store.getState().setModelSelection(ref, {
        instanceId: CLAUDE_INSTANCE_ID,
        model: "claude-opus-4-6",
        options: [
          { id: "effort", value: "max" },
          { id: "fastMode", value: false },
        ],
      });
      store.getState().setRuntimeMode(ref, "approval-required");
      const providers = TEST_PROVIDERS.map((provider) =>
        provider.instanceId !== CODEX_INSTANCE_ID
          ? provider
          : {
              ...provider,
              models: provider.models.map((model) => ({
                ...model,
                capabilities: createModelCapabilities({
                  optionDescriptors: [
                    selectDescriptor("reasoningEffort", "Reasoning", [
                      { id: "low", label: "Low" },
                      { id: "medium", label: "Medium", isDefault: true },
                      { id: "xhigh", label: "Extra High" },
                    ]),
                    booleanDescriptor("fastMode", "Fast"),
                  ],
                }),
              })),
            },
      );
      const state = deriveEffectiveComposerModelState({
        draft: store.getState().getComposerDraft(ref),
        providers,
        selectedProvider: ProviderDriverKind.make("claudeAgent"),
        selectedInstanceId: CLAUDE_INSTANCE_ID,
        threadModelSelection: null,
        settings: DEFAULT_UNIFIED_SETTINGS,
      });
      localStorage.setItem(
        "ryco:client-settings:v1",
        JSON.stringify({
          ...DEFAULT_CLIENT_SETTINGS,
          favorites: [
            {
              provider: "codex",
              model: "gpt-5-codex",
              ...(reasoningEffort ? { reasoningEffort } : {}),
            },
          ],
        }),
      );
      const mounted = await mountPicker({
        activeInstanceId: CLAUDE_INSTANCE_ID,
        model: "claude-opus-4-6",
        lockedProvider: null,
        providers,
        modelOptions: state.modelOptions?.[CLAUDE_INSTANCE_ID],
        savedModelOptionsByInstance: state.modelOptions ?? undefined,
        onSelect: (instanceId, model, options) =>
          store
            .getState()
            .setModelSelection(ref, { instanceId, model, ...(options ? { options } : {}) }),
      });
      try {
        await page.getByRole("button").click();
        await page.getByRole("button", { name: "Favorites", exact: true }).click();
        await page.getByRole("option").filter({ hasText: "GPT-5 Codex" }).click();
        const draft = store.getState().getComposerDraft(ref)!;
        expect(draft.modelSelectionByProvider[CODEX_INSTANCE_ID]?.options).toEqual([
          { id: "reasoningEffort", value: reasoningEffort ?? "xhigh" },
          { id: "fastMode", value: true },
        ]);
        expect(draft.runtimeMode).toBe("approval-required");
        expect(draft.modelSelectionByProvider[CLAUDE_INSTANCE_ID]?.options).toEqual([
          { id: "effort", value: "max" },
          { id: "fastMode", value: false },
        ]);
        if (!reasoningEffort)
          expect(mounted.onInstanceModelChange).toHaveBeenCalledWith(
            CODEX_INSTANCE_ID,
            "gpt-5-codex",
          );
      } finally {
        await mounted.cleanup();
        localStorage.removeItem("ryco:client-settings:v1");
      }
    },
  );

  it("stars two efforts for one model without selecting it or closing the picker", async () => {
    for (const effort of ["low", "high"]) {
      const mounted = await mountPicker({
        model: "gpt-5-codex",
        lockedProvider: null,
        modelOptions: [{ id: "reasoningEffort", value: effort }],
      });
      try {
        await page.getByRole("button").click();
        await page.getByRole("button", { name: "Codex", exact: true }).click();
        await page
          .getByRole("option")
          .filter({ hasText: "GPT-5 Codex" })
          .getByRole("button", { name: "Add to favorites" })
          .click();
        expect(mounted.onInstanceModelChange).not.toHaveBeenCalled();
        await vi.waitFor(() => {
          expect(getModelPickerListText()).toContain("GPT-5 Codex");
          expect(
            JSON.parse(localStorage.getItem("ryco:client-settings:v1")!).favorites,
          ).toContainEqual({
            provider: "codex",
            model: "gpt-5-codex",
            reasoningEffort: effort,
          });
        });
      } finally {
        await mounted.cleanup();
      }
    }
    expect(JSON.parse(localStorage.getItem("ryco:client-settings:v1")!).favorites).toEqual([
      { provider: "codex", model: "gpt-5-codex", reasoningEffort: "low" },
      { provider: "codex", model: "gpt-5-codex", reasoningEffort: "high" },
    ]);
    localStorage.removeItem("ryco:client-settings:v1");
  });

  it("restores effort presets independently, preserves fast mode, removes exactly one, and reloads", async () => {
    localStorage.setItem(
      "ryco:client-settings:v1",
      JSON.stringify({
        ...DEFAULT_CLIENT_SETTINGS,
        favorites: [
          { provider: "codex", model: "gpt-5-codex", reasoningEffort: "low" },
          { provider: "codex", model: "gpt-5-codex", reasoningEffort: "high" },
        ],
      }),
    );
    const mounted = await mountPicker({
      model: "gpt-5-codex",
      lockedProvider: null,
      modelOptions: [
        { id: "reasoningEffort", value: "high" },
        { id: "fastMode", value: true },
      ],
    });
    try {
      await page.getByRole("button").click();
      await page.getByRole("button", { name: "Favorites", exact: true }).click();
      await vi.waitFor(() => expect(document.querySelectorAll('[role="option"]').length).toBe(2));
      await page.getByRole("option").filter({ hasText: "low" }).click();
      expect(mounted.onInstanceModelChange).toHaveBeenLastCalledWith(
        CODEX_INSTANCE_ID,
        "gpt-5-codex",
        [
          { id: "reasoningEffort", value: "low" },
          { id: "fastMode", value: true },
        ],
      );
      await page.getByRole("button").click();
      await page
        .getByRole("option")
        .filter({ hasText: "high" })
        .getByRole("button", { name: "Remove from favorites" })
        .click();
      await vi.waitFor(() => {
        expect(JSON.parse(localStorage.getItem("ryco:client-settings:v1")!).favorites).toEqual([
          { provider: "codex", model: "gpt-5-codex", reasoningEffort: "low" },
        ]);
      });
    } finally {
      await mounted.cleanup();
    }
    await __resetLocalApiForTests();
    const reloaded = await mountPicker({ model: "gpt-5-codex", lockedProvider: null });
    try {
      await page.getByRole("button").click();
      await page.getByRole("button", { name: "Favorites", exact: true }).click();
      await vi.waitFor(() => {
        expect(document.querySelectorAll('[role="option"]').length).toBe(1);
        expect(getModelPickerListText()).toContain("low");
      });
    } finally {
      await reloaded.cleanup();
      localStorage.removeItem("ryco:client-settings:v1");
    }
  });

  it("shows provider sidebar in unlocked mode", async () => {
    const mounted = await mountPicker({
      activeInstanceId: CLAUDE_INSTANCE_ID,
      model: "claude-opus-4-6",
      lockedProvider: null,
    });

    try {
      await page.getByRole("button").click();

      await vi.waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text).not.toContain("Codex");
        expect(text).toContain("Claude");
        expect(text).toContain("Claude Opus 4.6");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows favorites first in the provider sidebar", async () => {
    const mounted = await mountPicker({
      activeInstanceId: CLAUDE_INSTANCE_ID,
      model: "claude-opus-4-6",
      lockedProvider: null,
    });

    try {
      await page.getByRole("button").click();

      await vi.waitFor(() => {
        expect(getSidebarProviderOrder().slice(0, 3)).toEqual([
          "favorites",
          "codex",
          "claudeAgent",
        ]);
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("filters models by selected provider in sidebar", async () => {
    const mounted = await mountPicker({
      activeInstanceId: CLAUDE_INSTANCE_ID,
      model: "claude-opus-4-6",
      lockedProvider: null,
    });

    try {
      await page.getByRole("button").click();

      // Start with Claude models visible
      await vi.waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text).not.toContain("GPT-5 Codex");
        expect(text).toContain("Claude Opus 4.6");
      });

      // Click on Codex provider in sidebar
      await vi.waitFor(() => {
        expect(document.querySelector('[data-model-picker-provider="codex"]')).not.toBeNull();
      });
      await page.getByRole("button", { name: "Codex", exact: true }).click();

      // Now should only show Codex models
      await vi.waitFor(() => {
        const listText = getModelPickerListText();
        expect(listText).toContain("GPT-5 Codex");
        expect(listText).not.toContain("Claude Opus 4.6");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("uses client model visibility and ordering preferences", async () => {
    const mounted = await mountPicker({
      activeInstanceId: CLAUDE_INSTANCE_ID,
      model: "claude-opus-4-6",
      lockedProvider: null,
      settings: {
        ...DEFAULT_UNIFIED_SETTINGS,
        providerModelPreferences: {
          [CLAUDE_INSTANCE_ID]: {
            hiddenModels: ["claude-opus-4-6"],
            modelOrder: ["claude-haiku-4-5", "claude-sonnet-4-6"],
          },
        },
      },
    });

    try {
      await page.getByRole("button").click();

      await vi.waitFor(() => {
        expect(getVisibleModelNames()).toEqual(["Claude Haiku 4.5", "Claude Sonnet 4.6"]);
        expect(getModelPickerListText()).not.toContain("Claude Opus 4.6");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("focuses the search input after selecting a sidebar provider", async () => {
    const mounted = await mountPicker({
      activeInstanceId: CLAUDE_INSTANCE_ID,
      model: "claude-opus-4-6",
      lockedProvider: null,
    });

    try {
      await page.getByRole("button").click();

      await vi.waitFor(() => {
        expect(document.querySelector('[data-model-picker-provider="codex"]')).not.toBeNull();
      });
      await page.getByRole("button", { name: "Codex", exact: true }).click();

      await vi.waitFor(() => {
        const searchInput = document.querySelector<HTMLInputElement>(
          'input[placeholder="Search models..."]',
        );
        expect(searchInput).not.toBeNull();
        expect(document.activeElement).toBe(searchInput);
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows locked provider header and only its models in locked mode", async () => {
    localStorage.setItem(
      "ryco:client-settings:v1",
      JSON.stringify({
        ...DEFAULT_CLIENT_SETTINGS,
        favorites: [
          { provider: "codex", model: "gpt-5-codex" },
          { provider: "claudeAgent", model: "claude-sonnet-4-6" },
        ],
      }),
    );

    const mounted = await mountPicker({
      activeInstanceId: CLAUDE_INSTANCE_ID,
      model: "claude-opus-4-6",
      lockedProvider: ProviderDriverKind.make("claudeAgent"),
    });

    try {
      await page.getByRole("button").click();

      await vi.waitFor(() => {
        const text = document.body.textContent ?? "";
        // Should show locked provider label
        expect(text).toContain("Claude");
        expect(getVisibleModelNames()).toEqual([
          "Claude Sonnet 4.6",
          "Claude Opus 4.6",
          "Claude Haiku 4.5",
        ]);
      });
    } finally {
      localStorage.removeItem("ryco:client-settings:v1");
      await mounted.cleanup();
    }
  });

  it("keeps an instance sidebar in locked mode when that provider has multiple instances", async () => {
    const defaultCodexModels: ServerProvider["models"] = [
      {
        slug: "gpt-work",
        name: "GPT Work",
        isCustom: false,
        capabilities: createModelCapabilities({ optionDescriptors: [] }),
      },
    ];
    const personalCodexModels: ServerProvider["models"] = [
      {
        slug: "gpt-personal",
        name: "GPT Personal",
        isCustom: false,
        capabilities: createModelCapabilities({ optionDescriptors: [] }),
      },
    ];
    const isolatedCodexModels: ServerProvider["models"] = [
      {
        slug: "gpt-isolated",
        name: "GPT Isolated",
        isCustom: false,
        capabilities: createModelCapabilities({ optionDescriptors: [] }),
      },
    ];
    const providers: ReadonlyArray<ServerProvider> = [
      {
        ...buildCodexProvider(defaultCodexModels),
        instanceId: "codex" as ProviderInstanceId,
        displayName: "Codex Work",
        accentColor: "#2563eb",
        continuation: { groupKey: "codex:home:/Users/julius/.codex" },
      },
      {
        ...buildCodexProvider(personalCodexModels),
        instanceId: "codex_personal" as ProviderInstanceId,
        displayName: "Codex Personal",
        accentColor: "#dc2626",
        continuation: { groupKey: "codex:home:/Users/julius/.codex" },
      },
      {
        ...buildCodexProvider(isolatedCodexModels),
        instanceId: "codex_isolated" as ProviderInstanceId,
        displayName: "Codex Isolated",
        accentColor: "#16a34a",
        continuation: { groupKey: "codex:home:/Users/julius/.codex_isolated" },
      },
      TEST_PROVIDERS[1]!,
    ];
    const mounted = await mountPicker({
      activeInstanceId: "codex" as ProviderInstanceId,
      model: "gpt-work",
      lockedProvider: ProviderDriverKind.make("codex"),
      lockedContinuationGroupKey: "codex:home:/Users/julius/.codex",
      providers,
    });

    try {
      await page.getByRole("button").click();

      await vi.waitFor(() => {
        expect(getSidebarProviderOrder()).toEqual(["codex", "codex_personal"]);
        expect(getModelPickerListText()).not.toContain("Codex Isolated");
        expect(
          document.querySelector<HTMLElement>('[data-model-picker-provider="codex_personal"]')
            ?.dataset.providerAccentColor,
        ).toBe("#dc2626");
        expect(getModelPickerListText()).toContain("Codex Work");
        expect(getVisibleModelNames()).toEqual(["GPT Work"]);
      });

      await page.getByRole("button", { name: "Codex Personal" }).click();

      await vi.waitFor(() => {
        expect(getModelPickerListText()).toContain("Codex Personal");
        expect(getVisibleModelNames()).toEqual(["GPT Personal"]);
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("falls back to the active provider's first model when props.model belongs to another provider (#1982)", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const onInstanceModelChange = vi.fn();
    const modelOptionsByInstance = new Map<ProviderInstanceId, ReadonlyArray<ModelEsque>>([
      [
        "claudeAgent" as ProviderInstanceId,
        [
          { slug: "claude-opus-4-6", name: "Claude Opus 4.6" },
          { slug: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
        ],
      ],
      ["codex" as ProviderInstanceId, [{ slug: "gpt-5-codex", name: "GPT-5 Codex" }]],
      ["cursor" as ProviderInstanceId, []],
      ["opencode" as ProviderInstanceId, []],
    ]);
    const instanceEntries = sortProviderInstanceEntries(
      deriveProviderInstanceEntries(TEST_PROVIDERS),
    );
    const screen = await render(
      <ProviderModelPicker
        activeInstanceId={"claudeAgent" as ProviderInstanceId}
        model="gpt-5-codex"
        lockedProvider={null}
        instanceEntries={instanceEntries}
        modelOptionsByInstance={modelOptionsByInstance}
        onInstanceModelChange={onInstanceModelChange}
      />,
      { container: host },
    );

    try {
      const trigger = document.querySelector<HTMLElement>(
        '[data-chat-provider-model-picker="true"]',
      );
      expect(trigger).not.toBeNull();
      const label = trigger?.textContent ?? "";
      expect(label).not.toContain("gpt-5-codex");
      expect(label).toContain("Claude Opus 4.6");
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("uses the trigger label for locked opencode rows", async () => {
    const providers: ReadonlyArray<ServerProvider> = [
      buildOpenCodeProvider([
        {
          slug: "github-copilot/claude-opus-4.5",
          name: "Claude Opus 4.5",
          subProvider: "GitHub Copilot",
          shortName: "Opus 4.5",
          isCustom: false,
          capabilities: createModelCapabilities({
            optionDescriptors: [
              selectDescriptor("reasoningEffort", "Reasoning", [
                { id: "low", label: "low" },
                { id: "medium", label: "medium", isDefault: true },
                { id: "high", label: "high" },
              ]),
            ],
          }),
        },
      ]),
    ];
    const mounted = await mountPicker({
      activeInstanceId: OPENCODE_INSTANCE_ID,
      model: "github-copilot/claude-opus-4.5",
      lockedProvider: ProviderDriverKind.make("opencode"),
      providers,
    });

    try {
      await vi.waitFor(() => {
        const trigger = document.querySelector<HTMLElement>(
          '[data-chat-provider-model-picker="true"]',
        );
        expect(trigger?.textContent).toContain("GitHub Copilot");
        expect(trigger?.textContent).toContain("Opus 4.5");
      });

      await page.getByRole("button").click();

      await vi.waitFor(() => {
        expect(getVisibleModelNames()).toEqual(["GitHub Copilot · Opus 4.5"]);
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("searches models by name in flat list", async () => {
    const mounted = await mountPicker({
      activeInstanceId: CLAUDE_INSTANCE_ID,
      model: "claude-opus-4-6",
      lockedProvider: null,
    });

    try {
      await page.getByRole("button").click();

      await vi.waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text).toContain("Claude Opus 4.6");
        expect(text).not.toContain("GPT-5 Codex");
      });

      // Find and type in search box
      const searchInput = page.getByPlaceholder("Search models...");
      await searchInput.fill("claude");

      await vi.waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text).toContain("Claude Opus 4.6");
        expect(text).not.toContain("GPT-5 Codex");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("supports arrow-key navigation in the model picker", async () => {
    const mounted = await mountPicker({
      activeInstanceId: CLAUDE_INSTANCE_ID,
      model: "claude-opus-4-6",
      lockedProvider: ProviderDriverKind.make("claudeAgent"),
    });

    try {
      await page.getByRole("button").click();

      const searchInput = page.getByPlaceholder("Search models...");
      await userEvent.click(searchInput);
      await userEvent.keyboard("{ArrowDown}");
      await vi.waitFor(() => {
        const highlightedItem = document.querySelector<HTMLElement>(
          '[data-slot="combobox-item"][data-highlighted]',
        );
        expect(highlightedItem).not.toBeNull();
        expect(highlightedItem?.textContent).toContain("Claude Opus 4.6");
      });
      await userEvent.keyboard("{ArrowDown}");
      await vi.waitFor(() => {
        const highlightedItem = document.querySelector<HTMLElement>(
          '[data-slot="combobox-item"][data-highlighted]',
        );
        expect(highlightedItem).not.toBeNull();
        expect(highlightedItem?.textContent).toContain("Claude Sonnet 4.6");
      });
      await userEvent.keyboard("{Enter}");

      expect(mounted.onProviderModelChange).toHaveBeenCalledWith(
        "claudeAgent",
        "claude-sonnet-4-6",
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("supports model jump shortcuts when opened from inside a dialog", async () => {
    const mounted = await mountPicker({
      model: "gpt-5.3-codex",
      lockedProvider: null,
      insideOpenDialog: true,
      open: true,
      keybindings: [
        {
          command: "modelPicker.jump.1",
          shortcut: {
            key: "1",
            metaKey: false,
            ctrlKey: true,
            shiftKey: false,
            altKey: false,
            modKey: false,
          },
          whenAst: { type: "identifier", name: "modelPickerOpen" },
        },
      ],
    });

    try {
      await vi.waitFor(() => {
        expect(document.querySelector(".model-picker-list")).not.toBeNull();
      });

      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "1",
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );

      await vi.waitFor(() => {
        expect(mounted.onInstanceModelChange).toHaveBeenCalledWith(
          CODEX_INSTANCE_ID,
          "gpt-5-codex",
        );
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("hides the provider sidebar while searching", async () => {
    const mounted = await mountPicker({
      activeInstanceId: CLAUDE_INSTANCE_ID,
      model: "claude-opus-4-6",
      lockedProvider: null,
    });

    try {
      await page.getByRole("button").click();

      await vi.waitFor(() => {
        expect(getSidebarProviderOrder().length).toBeGreaterThan(0);
      });

      await page.getByPlaceholder("Search models...").fill("cla");

      await vi.waitFor(() => {
        expect(getSidebarProviderOrder()).toEqual([]);
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("closes the picker when escape is pressed in search", async () => {
    const mounted = await mountPicker({
      activeInstanceId: CLAUDE_INSTANCE_ID,
      model: "claude-opus-4-6",
      lockedProvider: null,
    });

    try {
      await page.getByRole("button").click();

      const searchInput = page.getByPlaceholder("Search models...");
      await searchInput.click();
      const searchInputElement = document.querySelector<HTMLInputElement>(
        'input[placeholder="Search models..."]',
      );
      expect(searchInputElement).not.toBeNull();
      searchInputElement!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );

      await vi.waitFor(() => {
        expect(document.querySelector(".model-picker-list")).toBeNull();
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("searches models by provider name", async () => {
    const mounted = await mountPicker({
      activeInstanceId: CLAUDE_INSTANCE_ID,
      model: "claude-opus-4-6",
      lockedProvider: null,
    });

    try {
      await page.getByRole("button").click();

      await vi.waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text).toContain("Claude Opus 4.6");
        expect(text).not.toContain("GPT-5 Codex");
      });

      // Search by provider name
      const searchInput = page.getByPlaceholder("Search models...");
      await searchInput.fill("codex");

      await vi.waitFor(() => {
        const listText = getModelPickerListText();
        expect(listText).toContain("GPT-5 Codex");
        expect(listText).not.toContain("Claude Opus 4.6");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("matches fuzzy multi-token queries across provider and model text", async () => {
    const providers: ReadonlyArray<ServerProvider> = [
      buildCodexProvider([
        {
          slug: "gpt-5-codex",
          name: "GPT-5 Codex",
          isCustom: false,
          capabilities: createModelCapabilities({
            optionDescriptors: [
              selectDescriptor("reasoningEffort", "Reasoning", [
                { id: "low", label: "low" },
                { id: "medium", label: "medium", isDefault: true },
                { id: "high", label: "high" },
              ]),
              booleanDescriptor("fastMode", "Fast Mode"),
            ],
          }),
        },
      ]),
      buildOpenCodeProvider([
        {
          slug: "github-copilot/claude-opus-4.7",
          name: "Claude Opus 4.7",
          subProvider: "GitHub Copilot",
          isCustom: false,
          capabilities: createModelCapabilities({
            optionDescriptors: [
              selectDescriptor("reasoningEffort", "Reasoning", [
                { id: "low", label: "low" },
                { id: "medium", label: "medium", isDefault: true },
                { id: "high", label: "high" },
              ]),
            ],
          }),
        },
      ]),
    ];
    const mounted = await mountPicker({
      activeInstanceId: OPENCODE_INSTANCE_ID,
      model: "github-copilot/claude-opus-4.7",
      lockedProvider: null,
      providers,
    });

    try {
      await page.getByRole("button").click();
      await page.getByPlaceholder("Search models...").fill("coplt op");

      await vi.waitFor(() => {
        const listText = getModelPickerListText();
        expect(listText).toContain("Claude Opus 4.7");
        expect(listText).not.toContain("GPT-5 Codex");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("renders each search result with its own provider branding", async () => {
    const providers: ReadonlyArray<ServerProvider> = [
      buildOpenCodeProvider([
        {
          slug: "github-copilot/claude-opus-4.7",
          name: "Claude Opus 4.7",
          subProvider: "GitHub Copilot",
          isCustom: false,
          capabilities: createModelCapabilities({
            optionDescriptors: [
              selectDescriptor("reasoningEffort", "Reasoning", [
                { id: "low", label: "low" },
                { id: "medium", label: "medium", isDefault: true },
                { id: "high", label: "high" },
              ]),
            ],
          }),
        },
      ]),
      {
        ...TEST_PROVIDERS[1]!,
        models: [
          {
            slug: "claude-opus-4-6",
            name: "Claude Opus 4.6",
            isCustom: false,
            capabilities: createModelCapabilities({
              optionDescriptors: [
                selectDescriptor("effort", "Reasoning", [
                  { id: "low", label: "low" },
                  { id: "medium", label: "medium", isDefault: true },
                  { id: "high", label: "high" },
                  { id: "max", label: "max" },
                ]),
                booleanDescriptor("thinking", "Thinking"),
              ],
            }),
          },
        ],
      },
    ];
    const mounted = await mountPicker({
      activeInstanceId: OPENCODE_INSTANCE_ID,
      model: "github-copilot/claude-opus-4.7",
      lockedProvider: null,
      providers,
    });

    try {
      await page.getByRole("button").click();
      await page.getByPlaceholder("Search models...").fill("opus");

      await vi.waitFor(() => {
        const listText = getModelPickerListText();
        expect(listText).toContain("OpenCode · GitHub Copilot");
        expect(listText).toContain("Claude");
        expect(listText).not.toContain("OpenCodeClaude Opus 4.6");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("toggles favorite stars when clicked", async () => {
    localStorage.removeItem("ryco:client-settings:v1");

    const mounted = await mountPicker({
      activeInstanceId: CLAUDE_INSTANCE_ID,
      model: "claude-opus-4-6",
      lockedProvider: null,
    });

    try {
      await page.getByRole("button").click();

      await vi.waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text).toContain("Claude Opus 4.6");
      });

      const getFirstStarButton = () => {
        const starButton = document.querySelector<HTMLButtonElement>(
          'button[aria-label*="favorites"]',
        );
        expect(starButton).not.toBeNull();
        return starButton!;
      };

      const firstStar = getFirstStarButton();
      const initialAriaLabel = firstStar.getAttribute("aria-label");
      expect(
        initialAriaLabel === "Add to favorites" || initialAriaLabel === "Remove from favorites",
      ).toBe(true);

      await page.getByRole("button", { name: initialAriaLabel! }).first().click();

      const expectedAriaLabel =
        initialAriaLabel === "Add to favorites" ? "Remove from favorites" : "Add to favorites";

      await vi.waitFor(() => {
        expect(getFirstStarButton().getAttribute("aria-label")).toBe(expectedAriaLabel);
      });
    } finally {
      await mounted.cleanup();
      localStorage.removeItem("ryco:client-settings:v1");
    }
  });

  it("does not duplicate favorited models across favorites and all models sections", async () => {
    localStorage.removeItem("ryco:client-settings:v1");

    const mounted = await mountPicker({
      activeInstanceId: CLAUDE_INSTANCE_ID,
      model: "claude-opus-4-6",
      lockedProvider: null,
    });

    try {
      await page.getByRole("button").click();

      await vi.waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text).toContain("Claude Opus 4.6");
      });

      const favoriteButton = page.getByRole("button", {
        name: "Add to favorites",
      });
      await favoriteButton.first().click();

      await vi.waitFor(async () => {
        const favoritedModelRows = Array.from(
          getModelPickerListElement().querySelectorAll<HTMLDivElement>("div.font-medium"),
        ).filter((element) => element.textContent?.trim() === "Claude Opus 4.6");
        expect(favoritedModelRows.length).toBe(1);
      });
    } finally {
      await mounted.cleanup();
      localStorage.removeItem("ryco:client-settings:v1");
    }
  });

  it("shows favorited models first within the selected provider list", async () => {
    localStorage.setItem(
      "ryco:client-settings:v1",
      JSON.stringify({
        ...DEFAULT_CLIENT_SETTINGS,
        favorites: [{ provider: "codex", model: "gpt-5.3-codex" }],
      }),
    );

    const mounted = await mountPicker({
      model: "gpt-5-codex",
      lockedProvider: null,
    });

    try {
      await page.getByRole("button").click();
      await page.getByRole("button", { name: "Codex", exact: true }).click();

      await vi.waitFor(() => {
        expect(getVisibleModelNames().slice(0, 2)).toEqual(["GPT-5.3 Codex", "GPT-5 Codex"]);
      });
    } finally {
      await mounted.cleanup();
      localStorage.removeItem("ryco:client-settings:v1");
    }
  });

  it("dispatches callback with correct provider and model when selected", async () => {
    const mounted = await mountPicker({
      activeInstanceId: CLAUDE_INSTANCE_ID,
      model: "claude-opus-4-6",
      lockedProvider: ProviderDriverKind.make("claudeAgent"),
    });

    try {
      await page.getByRole("button").click();

      await vi.waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text).toContain("Claude Sonnet 4.6");
      });

      // Click on a model
      const modelRow = page.getByText("Claude Sonnet 4.6").first();
      await modelRow.click();

      // Verify callback was called with correct values
      expect(mounted.onProviderModelChange).toHaveBeenCalledWith(
        "claudeAgent",
        "claude-sonnet-4-6",
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("only shows codex spark when the server reports it", async () => {
    const providersWithoutSpark: ReadonlyArray<ServerProvider> = [
      buildCodexProvider([
        {
          slug: "gpt-5.3-codex",
          name: "GPT-5.3 Codex",
          isCustom: false,
          capabilities: createModelCapabilities({
            optionDescriptors: [
              selectDescriptor("reasoningEffort", "Reasoning", [
                { id: "low", label: "low" },
                { id: "medium", label: "medium", isDefault: true },
                { id: "high", label: "high" },
              ]),
              booleanDescriptor("fastMode", "Fast Mode"),
            ],
          }),
        },
      ]),
      TEST_PROVIDERS[1]!,
    ];
    const providersWithSpark: ReadonlyArray<ServerProvider> = [
      buildCodexProvider([
        {
          slug: "gpt-5.3-codex",
          name: "GPT-5.3 Codex",
          isCustom: false,
          capabilities: createModelCapabilities({
            optionDescriptors: [
              selectDescriptor("reasoningEffort", "Reasoning", [
                { id: "low", label: "low" },
                { id: "medium", label: "medium", isDefault: true },
                { id: "high", label: "high" },
              ]),
              booleanDescriptor("fastMode", "Fast Mode"),
            ],
          }),
        },
        {
          slug: "gpt-5.3-codex-spark",
          name: "GPT-5.3 Codex Spark",
          isCustom: false,
          capabilities: createModelCapabilities({
            optionDescriptors: [
              selectDescriptor("reasoningEffort", "Reasoning", [
                { id: "low", label: "low" },
                { id: "medium", label: "medium", isDefault: true },
                { id: "high", label: "high" },
              ]),
              booleanDescriptor("fastMode", "Fast Mode"),
            ],
          }),
        },
      ]),
      TEST_PROVIDERS[1]!,
    ];

    const hidden = await mountPicker({
      model: "gpt-5.3-codex",
      lockedProvider: null,
      providers: providersWithoutSpark,
    });

    try {
      await page.getByRole("button").click();

      await vi.waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text).toContain("GPT-5.3 Codex");
        expect(text).not.toContain("GPT-5.3 Codex Spark");
      });
    } finally {
      await hidden.cleanup();
    }

    const visible = await mountPicker({
      model: "gpt-5.3-codex",
      lockedProvider: null,
      providers: providersWithSpark,
    });

    try {
      await page.getByRole("button").click();

      await vi.waitFor(() => {
        expect(document.body.textContent ?? "").toContain("GPT-5.3 Codex Spark");
      });
    } finally {
      await visible.cleanup();
    }
  });

  it("hides providers that are not set up from the sidebar", async () => {
    const disabledProviders = TEST_PROVIDERS.slice();
    const claudeIndex = disabledProviders.findIndex(
      (provider) => provider.instanceId === ProviderInstanceId.make("claudeAgent"),
    );
    if (claudeIndex >= 0) {
      const claudeProvider = disabledProviders[claudeIndex]!;
      disabledProviders[claudeIndex] = {
        ...claudeProvider,
        enabled: false,
        status: "disabled",
      };
    }

    const mounted = await mountPicker({
      model: "gpt-5-codex",
      lockedProvider: null,
      providers: disabledProviders,
    });

    try {
      await page.getByRole("button").click();

      await vi.waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text).toContain("GPT-5 Codex");
        // Neither the disabled provider's rail button nor its models are offered.
        expect(text).not.toContain("Claude Opus 4.6");
        expect(getSidebarProviderOrder()).toContain("codex");
        expect(getSidebarProviderOrder()).not.toContain("claudeAgent");
        expect(getSidebarProviderOrder()).not.toContain("gemini-coming-soon");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("docks the tuning footer and keeps the picker open on a pointer pick", async () => {
    const mounted = await mountPicker({
      activeInstanceId: CLAUDE_INSTANCE_ID,
      model: "claude-opus-4-6",
      lockedProvider: null,
      tuning: <div data-testid="tuning-probe">Tuning</div>,
    });

    try {
      await page.getByRole("button").first().click();
      await expect.element(page.getByTestId("tuning-probe")).toBeInTheDocument();

      await page.getByText("Claude Sonnet 4.6").first().click();
      expect(mounted.onInstanceModelChange).toHaveBeenCalledWith(
        CLAUDE_INSTANCE_ID,
        "claude-sonnet-4-6",
        undefined,
        { keepOpen: true },
      );
      await expect.element(page.getByTestId("tuning-probe")).toBeInTheDocument();

      // Re-picking the active row confirms and closes.
      await page.getByText("Claude Opus 4.6").first().click();
      await expect.element(page.getByTestId("tuning-probe")).not.toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });

  it("closes on a pointer pick when no tuning footer is docked", async () => {
    const mounted = await mountPicker({
      activeInstanceId: CLAUDE_INSTANCE_ID,
      model: "claude-opus-4-6",
      lockedProvider: null,
    });

    try {
      await page.getByRole("button").first().click();
      await page.getByText("Claude Sonnet 4.6").first().click();
      await vi.waitFor(() => {
        expect(document.querySelector(".model-picker-list")).toBeNull();
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("steps the docked dial with the arrow keys from an empty search", async () => {
    const onSelectEffort = vi.fn();
    const tuning = resolveModelTuning({
      caps: createModelCapabilities({
        optionDescriptors: [
          {
            id: "effort",
            label: "Reasoning",
            type: "select",
            options: [
              { id: "low", label: "Low" },
              { id: "high", label: "High", isDefault: true },
              { id: "max", label: "Max" },
            ],
          },
        ],
      }),
      selections: undefined,
      prompt: "",
    })!;
    const mounted = await mountPicker({
      activeInstanceId: CLAUDE_INSTANCE_ID,
      model: "claude-opus-4-6",
      lockedProvider: null,
      tuning: (
        <ModelTuningDial
          tuning={tuning}
          onSelectEffort={onSelectEffort}
          onSetThinking={() => {}}
          onSetSpeed={() => {}}
          onSelectContextWindow={() => {}}
          onReset={() => {}}
        />
      ),
    });

    try {
      await page.getByRole("button").first().click();
      const search = page.getByPlaceholder("Search models...");
      await expect.element(search).toHaveFocus();
      await userEvent.keyboard("{ArrowRight}");
      expect(onSelectEffort).toHaveBeenLastCalledWith("max");
      await userEvent.keyboard("{ArrowLeft}");
      expect(onSelectEffort).toHaveBeenLastCalledWith("low");
      // The dial names the active model and links back to its row.
      await expect
        .element(page.getByRole("button", { name: "Show Claude Opus 4.6 in the list" }))
        .toBeInTheDocument();
      // Typing a query hands the arrows back to the text field.
      await userEvent.keyboard("son");
      onSelectEffort.mockClear();
      await userEvent.keyboard("{ArrowLeft}");
      expect(onSelectEffort).not.toHaveBeenCalled();
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows effort, fast mode and context beside the model name in the trigger", async () => {
    const mounted = await mountPicker({
      activeInstanceId: CLAUDE_INSTANCE_ID,
      model: "claude-opus-4-6",
      lockedProvider: null,
      triggerTraits: {
        level: { id: "high", label: "High", index: 2 },
        speed: "fast",
        contextWindowLabel: "1M",
      },
    });

    try {
      const traits = document.querySelector('[data-slot="model-trigger-traits"]');
      expect(traits?.textContent).toContain("High");
      expect(traits?.textContent).toContain("1M");
      expect(traits?.querySelector('[data-reasoning-tone="high"]')).not.toBeNull();
      expect(traits?.querySelector("svg")).not.toBeNull();
    } finally {
      await mounted.cleanup();
    }
  });

  it("accepts outline trigger styling", async () => {
    const mounted = await mountPicker({
      model: "gpt-5-codex",
      lockedProvider: null,
      triggerVariant: "outline",
    });

    try {
      const button = document.querySelector("button");
      if (!(button instanceof HTMLButtonElement)) {
        throw new Error("Expected picker trigger button to be rendered.");
      }
      expect(button.className).toContain("border-input");
      expect(button.className).toContain("bg-popover");
    } finally {
      await mounted.cleanup();
    }
  });
});

function claudeModel(
  slug: string,
  name: string,
  extra: { isLegacy?: boolean; isCustom?: boolean } = {},
): ServerProvider["models"][number] {
  return {
    slug,
    name,
    isCustom: extra.isCustom ?? false,
    ...(extra.isLegacy ? { isLegacy: true } : {}),
    capabilities: createModelCapabilities({ optionDescriptors: [] }),
  };
}

// Two current Claude models with three legacy ones between and after them, as
// the manifest's `status: "legacy"` reaches the client.
const LEGACY_CLAUDE_MODELS: ServerProvider["models"] = [
  claudeModel("claude-opus-5", "Claude Opus 5"),
  claudeModel("claude-opus-4-6", "Claude Opus 4.6", { isLegacy: true }),
  claudeModel("claude-sonnet-5", "Claude Sonnet 5"),
  claudeModel("claude-sonnet-4-6", "Claude Sonnet 4.6", { isLegacy: true }),
  claudeModel("claude-haiku-4-5", "Claude Haiku 4.5", { isLegacy: true }),
];

function buildClaudeProvider(
  models: ServerProvider["models"],
  extra: Partial<ServerProvider> = {},
): ServerProvider {
  return { ...TEST_PROVIDERS[1]!, models, ...extra };
}

function getLegacySection() {
  return document.querySelector<HTMLElement>("[data-model-picker-legacy-section]");
}

function getUpdateNotices() {
  return Array.from(
    document.querySelectorAll<HTMLElement>("[data-model-picker-update-notice]"),
    (element) => element.textContent ?? "",
  );
}

function ctrlDigitJumpBinding(digit: 1 | 2 | 3): ResolvedKeybindingsConfig[number] {
  return {
    command: `modelPicker.jump.${digit}`,
    shortcut: {
      key: String(digit),
      metaKey: false,
      ctrlKey: true,
      shiftKey: false,
      altKey: false,
      modKey: false,
    },
    whenAst: { type: "identifier", name: "modelPickerOpen" },
  };
}

describe("ProviderModelPicker legacy models", () => {
  beforeEach(async () => {
    await __resetLocalApiForTests();
  });

  afterEach(async () => {
    document.body.innerHTML = "";
    localStorage.removeItem("ryco:client-settings:v1");
    await __resetLocalApiForTests();
  });

  it("folds a provider tab's legacy models into a collapsed section", async () => {
    const mounted = await mountPicker({
      activeInstanceId: CLAUDE_INSTANCE_ID,
      model: "claude-opus-5",
      lockedProvider: null,
      providers: [TEST_PROVIDERS[0]!, buildClaudeProvider(LEGACY_CLAUDE_MODELS)],
    });

    try {
      await page.getByRole("button").click();

      await vi.waitFor(() => {
        expect(getVisibleModelNames()).toEqual(["Claude Opus 5", "Claude Sonnet 5"]);
        const section = getLegacySection();
        expect(section?.textContent).toContain("Legacy models");
        expect(section?.textContent).toContain("3 models");
        expect(section?.getAttribute("aria-expanded")).toBe("false");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("expands and collapses the section on click without picking or closing", async () => {
    const mounted = await mountPicker({
      activeInstanceId: CLAUDE_INSTANCE_ID,
      model: "claude-opus-5",
      lockedProvider: null,
      providers: [TEST_PROVIDERS[0]!, buildClaudeProvider(LEGACY_CLAUDE_MODELS)],
    });

    try {
      await page.getByRole("button").click();
      await page.getByRole("option").filter({ hasText: "Legacy models" }).click();

      await vi.waitFor(() => {
        expect(getLegacySection()?.getAttribute("aria-expanded")).toBe("true");
        expect(getVisibleModelNames()).toEqual([
          "Claude Opus 5",
          "Claude Sonnet 5",
          "Claude Opus 4.6",
          "Claude Sonnet 4.6",
          "Claude Haiku 4.5",
        ]);
      });
      expect(document.querySelector(".model-picker-list")).not.toBeNull();
      expect(mounted.onInstanceModelChange).not.toHaveBeenCalled();

      await page.getByRole("option").filter({ hasText: "Legacy models" }).click();

      await vi.waitFor(() => {
        expect(getLegacySection()?.getAttribute("aria-expanded")).toBe("false");
        expect(getVisibleModelNames()).toEqual(["Claude Opus 5", "Claude Sonnet 5"]);
      });
      expect(mounted.onInstanceModelChange).not.toHaveBeenCalled();
    } finally {
      await mounted.cleanup();
    }
  });

  it("toggles the section with Enter once the arrow keys reach it", async () => {
    const mounted = await mountPicker({
      activeInstanceId: CLAUDE_INSTANCE_ID,
      model: "claude-opus-5",
      lockedProvider: ProviderDriverKind.make("claudeAgent"),
      providers: [TEST_PROVIDERS[0]!, buildClaudeProvider(LEGACY_CLAUDE_MODELS)],
    });

    try {
      await page.getByRole("button").click();
      await userEvent.click(page.getByPlaceholder("Search models..."));
      await userEvent.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}");
      await vi.waitFor(() => {
        expect(document.querySelector('[data-slot="combobox-item"][data-highlighted]')).toBe(
          getLegacySection(),
        );
      });

      await userEvent.keyboard("{Enter}");

      await vi.waitFor(() => {
        expect(getLegacySection()?.getAttribute("aria-expanded")).toBe("true");
        expect(getVisibleModelNames()).toContain("Claude Haiku 4.5");
      });

      // The highlight stays on the section row, so Enter folds it again.
      await userEvent.keyboard("{Enter}");

      await vi.waitFor(() => {
        expect(getLegacySection()?.getAttribute("aria-expanded")).toBe("false");
        expect(getVisibleModelNames()).not.toContain("Claude Haiku 4.5");
      });
      expect(mounted.onInstanceModelChange).not.toHaveBeenCalled();
    } finally {
      await mounted.cleanup();
    }
  });

  it("lists matching legacy models inline while searching", async () => {
    const mounted = await mountPicker({
      activeInstanceId: CLAUDE_INSTANCE_ID,
      model: "claude-opus-5",
      lockedProvider: null,
      providers: [TEST_PROVIDERS[0]!, buildClaudeProvider(LEGACY_CLAUDE_MODELS)],
    });

    try {
      await page.getByRole("button").click();
      await page.getByPlaceholder("Search models...").fill("4.6");

      await vi.waitFor(() => {
        expect(getVisibleModelNames()).toEqual(
          expect.arrayContaining(["Claude Opus 4.6", "Claude Sonnet 4.6"]),
        );
        expect(getLegacySection()).toBeNull();
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps a favorited legacy model in Favorites and among the current models", async () => {
    localStorage.setItem(
      "ryco:client-settings:v1",
      JSON.stringify({
        ...DEFAULT_CLIENT_SETTINGS,
        favorites: [{ provider: "claudeAgent", model: "claude-haiku-4-5" }],
      }),
    );
    const mounted = await mountPicker({
      activeInstanceId: CLAUDE_INSTANCE_ID,
      model: "claude-opus-5",
      lockedProvider: null,
      providers: [TEST_PROVIDERS[0]!, buildClaudeProvider(LEGACY_CLAUDE_MODELS)],
    });

    try {
      await page.getByRole("button").click();
      await page.getByRole("button", { name: "Favorites", exact: true }).click();

      await vi.waitFor(() => {
        expect(getVisibleModelNames()).toEqual(["Claude Haiku 4.5"]);
        expect(getLegacySection()).toBeNull();
      });

      await page.getByRole("button", { name: "Claude", exact: true }).click();

      await vi.waitFor(() => {
        expect(getVisibleModelNames()).toEqual([
          "Claude Haiku 4.5",
          "Claude Opus 5",
          "Claude Sonnet 5",
        ]);
        expect(getLegacySection()?.textContent).toContain("2 models");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps the active legacy model visible and selected while the section is folded", async () => {
    const mounted = await mountPicker({
      activeInstanceId: CLAUDE_INSTANCE_ID,
      model: "claude-sonnet-4-6",
      lockedProvider: null,
      providers: [TEST_PROVIDERS[0]!, buildClaudeProvider(LEGACY_CLAUDE_MODELS)],
    });

    try {
      await page.getByRole("button").click();

      await vi.waitFor(() => {
        expect(getVisibleModelNames()).toEqual([
          "Claude Opus 5",
          "Claude Sonnet 5",
          "Claude Sonnet 4.6",
        ]);
        expect(getLegacySection()?.getAttribute("aria-expanded")).toBe("false");
        expect(getLegacySection()?.textContent).toContain("2 models");
        expect(
          getModelPickerListElement().querySelector('[data-slot="combobox-item"][data-selected]')
            ?.textContent,
        ).toContain("Claude Sonnet 4.6");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps every row in place when a pick from the open section keeps the picker open", async () => {
    const tuning = resolveModelTuning({
      caps: createModelCapabilities({
        optionDescriptors: [
          {
            id: "effort",
            label: "Reasoning",
            type: "select",
            options: [
              { id: "low", label: "Low" },
              { id: "high", label: "High", isDefault: true },
            ],
          },
        ],
      }),
      selections: undefined,
      prompt: "",
    })!;
    const mounted = await mountPicker({
      activeInstanceId: CLAUDE_INSTANCE_ID,
      model: "claude-opus-5",
      lockedProvider: null,
      providers: [TEST_PROVIDERS[0]!, buildClaudeProvider(LEGACY_CLAUDE_MODELS)],
      tuning: (
        <ModelTuningDial
          tuning={tuning}
          onSelectEffort={() => {}}
          onSetThinking={() => {}}
          onSetSpeed={() => {}}
          onSelectContextWindow={() => {}}
          onReset={() => {}}
        />
      ),
    });
    const expandedOrder = [
      "Claude Opus 5",
      "Claude Sonnet 5",
      "Claude Opus 4.6",
      "Claude Sonnet 4.6",
      "Claude Haiku 4.5",
    ];
    const selectedRowText = () =>
      getModelPickerListElement().querySelector('[data-slot="combobox-item"][data-selected]')
        ?.textContent;

    try {
      await page.getByRole("button").first().click();
      await page.getByRole("option").filter({ hasText: "Legacy models" }).click();
      await vi.waitFor(() => {
        expect(getVisibleModelNames()).toEqual(expandedOrder);
      });

      await page.getByRole("option").filter({ hasText: "Claude Sonnet 4.6" }).click();
      expect(mounted.onInstanceModelChange).toHaveBeenCalledWith(
        CLAUDE_INSTANCE_ID,
        "claude-sonnet-4-6",
        undefined,
        { keepOpen: true },
      );
      // The composer makes the pick the active model; the picker stays open.
      await mounted.rerenderModel("claude-sonnet-4-6");

      await vi.waitFor(() => {
        expect(selectedRowText()).toContain("Claude Sonnet 4.6");
      });
      expect(getVisibleModelNames()).toEqual(expandedOrder);
      expect(getLegacySection()?.textContent).toContain("3 models");
      expect(getLegacySection()?.getAttribute("aria-expanded")).toBe("true");

      // Folded again, the dial's link back to the active row reopens the section.
      await page.getByRole("option").filter({ hasText: "Legacy models" }).click();
      await vi.waitFor(() => {
        expect(getVisibleModelNames()).toEqual(["Claude Opus 5", "Claude Sonnet 5"]);
      });
      await page.getByRole("button", { name: "Show Claude Sonnet 4.6 in the list" }).click();
      await vi.waitFor(() => {
        expect(getLegacySection()?.getAttribute("aria-expanded")).toBe("true");
        expect(getVisibleModelNames()).toEqual(expandedOrder);
        expect(selectedRowText()).toContain("Claude Sonnet 4.6");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("points the jump shortcuts at current models only", async () => {
    const mounted = await mountPicker({
      activeInstanceId: CLAUDE_INSTANCE_ID,
      model: "claude-opus-5",
      lockedProvider: null,
      open: true,
      providers: [TEST_PROVIDERS[0]!, buildClaudeProvider(LEGACY_CLAUDE_MODELS)],
      keybindings: [ctrlDigitJumpBinding(1), ctrlDigitJumpBinding(2), ctrlDigitJumpBinding(3)],
    });
    const pressCtrl = (key: string) =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key, ctrlKey: true, bubbles: true, cancelable: true }),
      );

    try {
      await vi.waitFor(() => {
        expect(getLegacySection()).not.toBeNull();
      });
      expect(getLegacySection()?.querySelector('[data-slot="kbd"]')).toBeNull();

      pressCtrl("3");
      expect(mounted.onInstanceModelChange).not.toHaveBeenCalled();

      pressCtrl("2");
      await vi.waitFor(() => {
        expect(mounted.onInstanceModelChange).toHaveBeenCalledWith(
          CLAUDE_INSTANCE_ID,
          "claude-sonnet-5",
        );
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("never folds a custom model", async () => {
    const mounted = await mountPicker({
      activeInstanceId: CLAUDE_INSTANCE_ID,
      model: "claude-opus-5",
      lockedProvider: null,
      providers: [
        TEST_PROVIDERS[0]!,
        buildClaudeProvider([
          ...LEGACY_CLAUDE_MODELS,
          claudeModel("proxy/claude-opus-4-6", "Proxy Opus 4.6", {
            isCustom: true,
            isLegacy: true,
          }),
        ]),
      ],
    });

    try {
      await page.getByRole("button").click();

      await vi.waitFor(() => {
        expect(getVisibleModelNames()).toEqual([
          "Claude Opus 5",
          "Claude Sonnet 5",
          "Proxy Opus 4.6",
        ]);
        expect(getLegacySection()?.textContent).toContain("3 models");
      });
    } finally {
      await mounted.cleanup();
    }
  });
});

describe("ProviderModelPicker update-required notice", () => {
  const FABLE_5_1 = { slug: "claude-fable-5-1", name: "Claude Fable 5.1", minVersion: "2.1.257" };
  const NOTICE = "Update Claude Code to v2.1.257 or newer to use Claude Fable 5.1.";
  const claudeNeedingUpdate = buildClaudeProvider(TEST_PROVIDERS[1]!.models, {
    updateRequiredModels: [FABLE_5_1],
  });

  beforeEach(async () => {
    await __resetLocalApiForTests();
  });

  afterEach(async () => {
    document.body.innerHTML = "";
    localStorage.removeItem("ryco:client-settings:v1");
    await __resetLocalApiForTests();
  });

  it("names the update under the provider tab's models", async () => {
    const mounted = await mountPicker({
      activeInstanceId: CLAUDE_INSTANCE_ID,
      model: "claude-opus-4-6",
      lockedProvider: null,
      providers: [TEST_PROVIDERS[0]!, claudeNeedingUpdate],
    });

    try {
      await page.getByRole("button").click();
      await vi.waitFor(() => {
        expect(getUpdateNotices()).toEqual([NOTICE]);
      });

      await page.getByRole("button", { name: "Codex", exact: true }).click();
      await vi.waitFor(() => {
        expect(getVisibleModelNames()).toContain("GPT-5 Codex");
        expect(getUpdateNotices()).toEqual([]);
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows it while a search matches the gated model only", async () => {
    const mounted = await mountPicker({
      activeInstanceId: CLAUDE_INSTANCE_ID,
      model: "claude-opus-4-6",
      lockedProvider: null,
      providers: [TEST_PROVIDERS[0]!, claudeNeedingUpdate],
    });

    try {
      await page.getByRole("button").click();
      const search = page.getByPlaceholder("Search models...");

      await search.fill("fable");
      await vi.waitFor(() => {
        expect(getUpdateNotices()).toEqual([NOTICE]);
      });

      await search.fill("sonnet");
      await vi.waitFor(() => {
        expect(getVisibleModelNames()).toContain("Claude Sonnet 4.6");
        expect(getUpdateNotices()).toEqual([]);
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows none on the Favorites tab", async () => {
    localStorage.setItem(
      "ryco:client-settings:v1",
      JSON.stringify({
        ...DEFAULT_CLIENT_SETTINGS,
        favorites: [{ provider: "claudeAgent", model: "claude-opus-4-6" }],
      }),
    );
    const mounted = await mountPicker({
      activeInstanceId: CLAUDE_INSTANCE_ID,
      model: "claude-opus-4-6",
      lockedProvider: null,
      providers: [TEST_PROVIDERS[0]!, claudeNeedingUpdate],
    });

    try {
      await page.getByRole("button").click();
      await page.getByRole("button", { name: "Favorites", exact: true }).click();
      await vi.waitFor(() => {
        expect(getVisibleModelNames()).toEqual(["Claude Opus 4.6"]);
      });
      expect(getUpdateNotices()).toEqual([]);
    } finally {
      await mounted.cleanup();
    }
  });

  it("leaves out other drivers' notices when locked", async () => {
    const mounted = await mountPicker({
      model: "gpt-5-codex",
      lockedProvider: ProviderDriverKind.make("codex"),
      providers: [TEST_PROVIDERS[0]!, claudeNeedingUpdate],
    });

    try {
      await page.getByRole("button").click();
      await page.getByPlaceholder("Search models...").fill("fable");
      await vi.waitFor(() => {
        expect(getModelPickerListText()).not.toContain("Claude");
        expect(document.body.textContent).toContain("No models found");
      });
      expect(getUpdateNotices()).toEqual([]);
    } finally {
      await mounted.cleanup();
    }
  });

  it("names the instance when a search spans two instances of one driver", async () => {
    const mounted = await mountPicker({
      activeInstanceId: CLAUDE_INSTANCE_ID,
      model: "claude-opus-4-6",
      lockedProvider: null,
      providers: [
        claudeNeedingUpdate,
        buildClaudeProvider(TEST_PROVIDERS[1]!.models, {
          instanceId: ProviderInstanceId.make("claude_hub"),
          displayName: "Claude Hub",
          updateRequiredModels: [FABLE_5_1],
        }),
      ],
    });

    try {
      await page.getByRole("button").click();
      await vi.waitFor(() => {
        expect(getUpdateNotices()).toEqual([NOTICE]);
      });

      await page.getByPlaceholder("Search models...").fill("fable");
      await vi.waitFor(() => {
        expect(getUpdateNotices()).toEqual([`Claude: ${NOTICE}`, `Claude Hub: ${NOTICE}`]);
      });
    } finally {
      await mounted.cleanup();
    }
  });
});
