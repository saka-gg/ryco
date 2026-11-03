import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@ryco/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@ryco/contracts/settings";
import { createModelCapabilities } from "@ryco/shared/model";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";

const chunks = vi.hoisted(() => ({
  /** Components whose chunk fails to load (offline, or a deploy replaced it). */
  failing: new Set<unknown>(),
  notify: vi.fn<(surface: string, error: unknown, retry: () => void) => void>(),
}));

// The app's own loaders, failing for the components in `chunks.failing`.
vi.mock("../../lib/preloadableLazy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/preloadableLazy")>();
  return {
    ...actual,
    preloadableLazy: <P extends object>(load: () => Promise<React.ComponentType<P>>) =>
      actual.preloadableLazy(() =>
        load().then((component) => {
          if (chunks.failing.has(component)) {
            throw new Error("Failed to fetch dynamically imported module");
          }
          return component;
        }),
      ),
  };
});
vi.mock("../ui/surfaceLoadFailure", () => ({
  notifySurfaceLoadFailure: chunks.notify,
}));

import { __resetLocalApiForTests } from "../../localApi";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { SettingsEditingScopeProvider } from "../../settingsTarget";
import { ComposerModelTuning } from "./ModelTuningDial";
import { LazyComposerModelTuning, ProviderModelPicker } from "./ProviderModelPicker";

const CLAUDE_INSTANCE_ID = ProviderInstanceId.make("claudeAgent");
const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");

const effortCapabilities = createModelCapabilities({
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
});

const PROVIDERS: ReadonlyArray<ServerProvider> = [
  {
    driver: CLAUDE_DRIVER,
    instanceId: CLAUDE_INSTANCE_ID,
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
        capabilities: effortCapabilities,
      },
    ],
  },
];

function mountPicker() {
  const instanceEntries = sortProviderInstanceEntries(deriveProviderInstanceEntries(PROVIDERS));
  return render(
    <SettingsEditingScopeProvider value="all">
      <ProviderModelPicker
        activeInstanceId={CLAUDE_INSTANCE_ID}
        model="claude-opus-4-6"
        modelOptions={undefined}
        lockedProvider={null}
        lockedContinuationGroupKey={null}
        instanceEntries={instanceEntries}
        modelOptionsByInstance={getCustomModelOptionsByInstance(
          DEFAULT_UNIFIED_SETTINGS,
          PROVIDERS,
          CLAUDE_INSTANCE_ID,
          "claude-opus-4-6",
        )}
        tuning={
          <LazyComposerModelTuning
            provider={CLAUDE_DRIVER}
            model="claude-opus-4-6"
            models={PROVIDERS[0]!.models}
            modelOptions={undefined}
            prompt=""
            onPromptChange={() => {}}
            onModelOptionsChange={() => {}}
          />
        }
        onInstanceModelChange={vi.fn()}
      />
    </SettingsEditingScopeProvider>,
  );
}

describe("ProviderModelPicker load failure", () => {
  beforeEach(async () => {
    await __resetLocalApiForTests();
  });

  afterEach(async () => {
    document.body.innerHTML = "";
    chunks.failing.clear();
    await __resetLocalApiForTests();
  });

  it("reports a tuning dial chunk that fails to load and opens with the dial on retry", async () => {
    chunks.failing.add(ComposerModelTuning);
    const mounted = await mountPicker();

    try {
      await page.getByRole("button").first().click();

      // The body's load fails with the dial's: the picker's own toast, and
      // nothing threw to an error boundary.
      await vi.waitFor(() => expect(chunks.notify).toHaveBeenCalledOnce());
      expect(chunks.notify.mock.calls[0]?.[0]).toBe("model picker");
      expect(document.querySelector(".model-picker-list")).toBeNull();
      expect(document.querySelector('[data-slot="model-tuning-dial"]')).toBeNull();
      await expect.element(page.getByRole("button").first()).toBeInTheDocument();

      // Retry loads both and opens the picker with the dial docked.
      chunks.failing.clear();
      chunks.notify.mock.calls[0]?.[2]();

      // The failed open reported before the picker's own module finished loading; on a busy
      // runner the retry can wait more than a second for it.
      await vi.waitFor(
        () => {
          expect(document.querySelector(".model-picker-list")).not.toBeNull();
          expect(document.querySelector('[data-slot="model-tuning-dial"]')).not.toBeNull();
        },
        { timeout: 15_000 },
      );
      expect(LazyComposerModelTuning.isLoaded()).toBe(true);
      expect(chunks.notify).toHaveBeenCalledOnce();
    } finally {
      await mounted.unmount();
    }
  });
});
