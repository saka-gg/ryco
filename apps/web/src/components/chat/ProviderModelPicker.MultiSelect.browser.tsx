import "../../index.css";

import {
  MODEL_MULTI_SELECT_OFF,
  retryModelMultiSelect,
  type ModelMultiSelectState,
} from "@ryco/client-runtime/state/composer";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderOptionSelection,
  type ServerProvider,
} from "@ryco/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@ryco/contracts/settings";
import { createModelCapabilities } from "@ryco/shared/model";
import { useState } from "react";
import { page, userEvent } from "vite-plus/test/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { __resetLocalApiForTests } from "../../localApi";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { SettingsEditingScopeProvider } from "../../settingsTarget";
import { ProviderModelPicker } from "./ProviderModelPicker";

vi.mock("../../environments/runtime", () => {
  const primaryConnection = {
    kind: "primary" as const,
    knownEnvironment: {
      id: "environment-local",
      label: "Local environment",
      source: "manual" as const,
      environmentId: EnvironmentId.make("environment-local"),
      target: { httpBaseUrl: "http://localhost:3000", wsBaseUrl: "ws://localhost:3000" },
    },
    environmentId: EnvironmentId.make("environment-local"),
    client: { server: { getConfig: vi.fn(), updateSettings: vi.fn() } },
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

const CODEX = ProviderInstanceId.make("codex");
const CLAUDE = ProviderInstanceId.make("claudeAgent");

function model(slug: string, name: string) {
  return {
    slug,
    name,
    isCustom: false,
    capabilities: createModelCapabilities({
      optionDescriptors: [
        {
          id: "effort",
          label: "Effort",
          type: "select" as const,
          options: [
            { id: "medium", label: "Medium", isDefault: true },
            { id: "high", label: "High" },
          ],
          currentValue: "medium",
        },
      ],
    }),
  };
}

function provider(
  driver: string,
  instanceId: ProviderInstanceId,
  displayName: string,
  models: ServerProvider["models"],
): ServerProvider {
  return {
    driver: ProviderDriverKind.make(driver),
    instanceId,
    displayName,
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

const PROVIDERS: ReadonlyArray<ServerProvider> = [
  provider("codex", CODEX, "Codex", [
    model("gpt-5-codex", "GPT-5 Codex"),
    model("gpt-5-mini", "GPT-5 Mini"),
  ]),
  provider("claudeAgent", CLAUDE, "Claude", [
    model("claude-opus-4-6", "Claude Opus 4.6"),
    model("claude-sonnet-4-6", "Claude Sonnet 4.6"),
    model("claude-haiku-4-5", "Claude Haiku 4.5"),
  ]),
];

async function mountPicker(options: {
  multiSelect: boolean;
  initialState?: ModelMultiSelectState;
  savedModelOptionsByInstance?: Readonly<Record<string, ReadonlyArray<ProviderOptionSelection>>>;
}) {
  const host = document.createElement("div");
  document.body.append(host);
  const onInstanceModelChange = vi.fn();
  const states: ModelMultiSelectState[] = [];
  const instanceEntries = sortProviderInstanceEntries(deriveProviderInstanceEntries(PROVIDERS));
  const modelOptionsByInstance = getCustomModelOptionsByInstance(
    DEFAULT_UNIFIED_SETTINGS,
    PROVIDERS,
    CODEX,
    "gpt-5-codex",
  );

  function Harness() {
    const [state, setState] = useState<ModelMultiSelectState>(
      options.initialState ?? MODEL_MULTI_SELECT_OFF,
    );
    return (
      <SettingsEditingScopeProvider value="all">
        <ProviderModelPicker
          activeInstanceId={CODEX}
          model="gpt-5-codex"
          modelOptions={[{ id: "effort", value: "high" }]}
          lockedProvider={null}
          instanceEntries={instanceEntries}
          modelOptionsByInstance={modelOptionsByInstance}
          savedModelOptionsByInstance={options.savedModelOptionsByInstance}
          onInstanceModelChange={onInstanceModelChange}
          {...(options.multiSelect
            ? {
                multiSelect: {
                  state,
                  onChange: (next: ModelMultiSelectState) => {
                    states.push(next);
                    setState(next);
                  },
                },
              }
            : {})}
        />
      </SettingsEditingScopeProvider>
    );
  }

  const screen = await render(<Harness />, { container: host });
  return {
    onInstanceModelChange,
    states,
    latest: () => states.at(-1) ?? MODEL_MULTI_SELECT_OFF,
    cleanup: async () => {
      await screen.unmount();
      host.remove();
    },
  };
}

const option = (name: string) => page.getByRole("option").filter({ hasText: name });
const checkedNames = () =>
  Array.from(document.querySelectorAll<HTMLElement>('[role="option"][aria-checked="true"]')).map(
    (element) => element.querySelector("div.font-medium")?.textContent?.trim() ?? "",
  );
const compareHint = () =>
  document.querySelector('[data-slot="model-picker-compare-hint"]')?.textContent ?? "";

async function openPicker() {
  await page.getByRole("button").first().click();
  await vi.waitFor(() => expect(document.querySelector(".model-picker-list")).not.toBeNull());
}

async function shiftClick(name: string) {
  await userEvent.keyboard("{Shift>}");
  await option(name).click();
  await userEvent.keyboard("{/Shift}");
}

describe("ProviderModelPicker — Compare models", () => {
  beforeEach(async () => {
    await __resetLocalApiForTests();
  });

  afterEach(async () => {
    document.body.innerHTML = "";
    await __resetLocalApiForTests();
  });

  it("offers no compare mode unless the composer allows it", async () => {
    const mounted = await mountPicker({ multiSelect: false });
    try {
      await openPicker();
      expect(document.querySelector('[data-slot="model-picker-compare"]')).toBeNull();
      await shiftClick("GPT-5 Mini");
      expect(mounted.onInstanceModelChange).toHaveBeenCalledWith(CODEX, "gpt-5-mini");
      expect(document.querySelector('[role="option"][aria-checked]')).toBeNull();
    } finally {
      await mounted.cleanup();
    }
  });

  it("adds a second model on Shift-click and keeps the picker open", async () => {
    const mounted = await mountPicker({ multiSelect: true });
    try {
      await openPicker();
      expect(compareHint()).toBe("Shift-click to pick several");
      await shiftClick("GPT-5 Mini");
      expect(mounted.onInstanceModelChange).not.toHaveBeenCalled();
      expect(mounted.latest()).toEqual({
        enabled: true,
        selections: [
          // The composer's model keeps its live options, and so does another
          // model of its instance, as a pick of it would.
          { instanceId: CODEX, model: "gpt-5-codex", options: [{ id: "effort", value: "high" }] },
          { instanceId: CODEX, model: "gpt-5-mini", options: [{ id: "effort", value: "high" }] },
        ],
      });
      await vi.waitFor(() => expect(checkedNames()).toEqual(["GPT-5 Codex", "GPT-5 Mini"]));
      expect(compareHint()).toBe("2 of 4 · each in its own worktree");
      expect(page.getByRole("switch", { name: "Compare models" }).element()).toHaveAttribute(
        "aria-checked",
        "true",
      );
      expect(document.querySelector(".model-picker-list")).not.toBeNull();
    } finally {
      await mounted.cleanup();
    }
  });

  it("gives a model of another instance the options the draft saved for it", async () => {
    const mounted = await mountPicker({
      multiSelect: true,
      savedModelOptionsByInstance: { [CLAUDE]: [{ id: "effort", value: "high" }] },
    });
    try {
      await openPicker();
      await page.getByRole("button", { name: "Claude", exact: true }).click();
      await shiftClick("Claude Opus 4.6");
      expect(mounted.latest().selections.at(-1)).toEqual({
        instanceId: CLAUDE,
        model: "claude-opus-4-6",
        options: [{ id: "effort", value: "high" }],
      });
      expect(mounted.onInstanceModelChange).not.toHaveBeenCalled();
    } finally {
      await mounted.cleanup();
    }
  });

  it("lets one model go out when it retries what an earlier send did not create", async () => {
    const mounted = await mountPicker({
      multiSelect: true,
      initialState: retryModelMultiSelect([{ instanceId: CLAUDE, model: "claude-opus-4-6" }]),
    });
    try {
      await openPicker();
      expect(compareHint()).toBe("1 of 4 · each in its own worktree");
      await page.getByRole("button", { name: "Claude", exact: true }).click();
      await option("Claude Opus 4.6").click();
      expect(mounted.latest()).toEqual({ enabled: true, selections: [], retry: true });
      await vi.waitFor(() => expect(compareHint()).toBe("Pick a model"));
    } finally {
      await mounted.cleanup();
    }
  });

  it("adds and removes models with plain clicks while compare mode is on", async () => {
    const mounted = await mountPicker({ multiSelect: true });
    try {
      await openPicker();
      await page.getByRole("switch", { name: "Compare models" }).click();
      expect(mounted.latest().selections.map((selection) => selection.model)).toEqual([
        "gpt-5-codex",
      ]);
      expect(compareHint()).toBe("Pick at least two models");
      await page.getByRole("button", { name: "Claude", exact: true }).click();
      await option("Claude Opus 4.6").click();
      await option("Claude Sonnet 4.6").click();
      await option("Claude Opus 4.6").click();
      expect(mounted.latest().selections.map((selection) => selection.model)).toEqual([
        "gpt-5-codex",
        "claude-sonnet-4-6",
      ]);
      expect(mounted.onInstanceModelChange).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(checkedNames()).toEqual(["Claude Sonnet 4.6"]));
    } finally {
      await mounted.cleanup();
    }
  });

  it("refuses a fifth model and says why", async () => {
    const mounted = await mountPicker({ multiSelect: true });
    try {
      await openPicker();
      await shiftClick("GPT-5 Mini");
      await page.getByRole("button", { name: "Claude", exact: true }).click();
      await option("Claude Opus 4.6").click();
      await option("Claude Sonnet 4.6").click();
      expect(mounted.latest().selections).toHaveLength(4);
      await option("Claude Haiku 4.5").click();
      expect(mounted.latest().selections).toHaveLength(4);
      await vi.waitFor(() => expect(compareHint()).toBe("Up to 4 models"));
      expect(option("Claude Haiku 4.5").element()).toHaveAttribute("aria-checked", "false");
    } finally {
      await mounted.cleanup();
    }
  });

  it("toggles the highlighted model with Shift+Enter", async () => {
    const mounted = await mountPicker({ multiSelect: true });
    try {
      await openPicker();
      await page.getByRole("combobox").fill("haiku");
      await vi.waitFor(() => expect(document.querySelectorAll('[role="option"]')).toHaveLength(1));
      await userEvent.keyboard("{Shift>}{Enter}{/Shift}");
      expect(mounted.latest().selections.map((selection) => selection.model)).toEqual([
        "gpt-5-codex",
        "claude-haiku-4-5",
      ]);
      expect(mounted.onInstanceModelChange).not.toHaveBeenCalled();
    } finally {
      await mounted.cleanup();
    }
  });

  it("names the compared models on the trigger and returns to one model when turned off", async () => {
    const mounted = await mountPicker({ multiSelect: true });
    try {
      await openPicker();
      await shiftClick("GPT-5 Mini");
      await userEvent.keyboard("{Escape}");
      const trigger = document.querySelector<HTMLElement>(
        '[data-chat-provider-model-picker="true"]',
      );
      await vi.waitFor(() => expect(trigger?.textContent).toContain("2 models"));
      expect(trigger).toHaveAttribute("aria-label", "Compare models: GPT-5 Codex, GPT-5 Mini");

      await openPicker();
      await page.getByRole("switch", { name: "Compare models" }).click();
      expect(mounted.latest()).toEqual(MODEL_MULTI_SELECT_OFF);
      await vi.waitFor(() => expect(trigger?.textContent).toContain("GPT-5 Codex"));
      expect(trigger).not.toHaveAttribute("aria-label");
      expect(document.querySelector('[role="option"][aria-checked]')).toBeNull();
    } finally {
      await mounted.cleanup();
    }
  });
});
