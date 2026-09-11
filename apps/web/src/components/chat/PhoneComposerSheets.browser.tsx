// Production CSS is part of the behavior under test: the 44px row floor, the
// `pointer-coarse:` shortcut-hint rule, and the sheet's detent offset are CSS.
import "../../index.css";

import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ResolvedKeybindingsConfig,
  type ServerProvider,
} from "@ryco/contracts";
import { createModelCapabilities } from "@ryco/shared/model";
import { DEFAULT_CLIENT_SETTINGS, DEFAULT_UNIFIED_SETTINGS } from "@ryco/contracts/settings";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";

// The hosted mutation capability is a read-only hook over hosted lifecycle
// state. The tests drive it directly rather than assembling a hosted session:
// what is under test is that the composer CONSUMES it, not how it is computed
// (which `hostedHub/capabilities.test.ts` owns).
const capabilityState = {
  allowed: true,
  reason: null as string | null,
};
vi.mock("../../hostedHub/capabilities", () => ({
  useHostedRpcCapability: () => ({
    hosted: !capabilityState.allowed,
    allowed: capabilityState.allowed,
    reason: capabilityState.reason,
  }),
}));

vi.mock("../../environments/runtime", () => {
  const primaryConnection = {
    kind: "primary" as const,
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
    connectPrimaryEnvironment: vi.fn(),
    connectDesktopWorkspaceEnvironment: vi.fn(),
    disconnectPrimaryEnvironment: vi.fn(),
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

import { __resetLocalApiForTests } from "../../localApi";
import { getAppModelOptionsForInstance, type AppModelOption } from "../../modelSelection";
import {
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { setCoarsePointerEmulation, resetPointerEmulation } from "../../../test/browserPointer";
import { syncDocumentPresentationTier } from "../../lib/presentationTier";
import { createInitialContextWindowUsage } from "../../lib/contextWindow";
import { DraftId } from "../../composerDraftStore";
import { ComposerFooter, type ComposerFooterProps } from "./ComposerFooter";
import { renderProviderTraitsMenuContent } from "./composerProviderState";
import { PhoneSessionPolicySheet } from "./PhoneSessionPolicySheet";
import { ProviderModelPicker } from "./ProviderModelPicker";

const PHONE_VIEWPORT = { width: 390, height: 844 } as const;
const DESKTOP_VIEWPORT = { width: 1_280, height: 720 } as const;
const NARROW_VIEWPORT = { width: 320, height: 568 } as const;
const CODEX_INSTANCE_ID = ProviderInstanceId.make("codex");
/**
 * Longer than the 120-character bound on purpose. A fixture reason that already
 * fits would make every `length <= 120` assertion pass with or without the
 * bound.
 */
const LONG_CAPABILITY_REASON = `This action is unavailable while Hub authorization or the relay is stale. ${"Reconnect and retry once the directory is current again. ".repeat(4)}`;
const CLAUDE_INSTANCE_ID = ProviderInstanceId.make("claudeAgent");
/**
 * The model-jump shortcuts, supplied so the DESKTOP presentation really would
 * render `⌃1`–`⌃8` hints for this fixture. Without them the "no shortcut hint
 * under `pointer: coarse`" assertion could not fail, because the desktop picker
 * renders no hint at all when no jump shortcut is bound.
 */
const JUMP_COMMANDS = [
  "modelPicker.jump.1",
  "modelPicker.jump.2",
  "modelPicker.jump.3",
  "modelPicker.jump.4",
  "modelPicker.jump.5",
  "modelPicker.jump.6",
  "modelPicker.jump.7",
  "modelPicker.jump.8",
] as const;

const JUMP_KEYBINDINGS: ResolvedKeybindingsConfig = JUMP_COMMANDS.map((command, index) => ({
  command,
  shortcut: {
    key: String(index + 1),
    metaKey: false,
    ctrlKey: true,
    shiftKey: false,
    altKey: false,
    modKey: false,
  },
  whenAst: { type: "identifier", name: "modelPickerOpen" } as const,
}));

/** The longest label in the fixture set, used for the 320px overflow check. */
const LONGEST_MODEL_NAME = "Claude Opus 4.6 (1M context) extended-thinking preview build 20260722";

const REASONING_DESCRIPTOR = {
  id: "reasoningEffort",
  label: "Reasoning",
  type: "select" as const,
  currentValue: "medium",
  options: [
    { id: "low", label: "low" },
    { id: "medium", label: "medium", isDefault: true },
    { id: "high", label: "high" },
  ],
};

function buildProvider(
  driver: string,
  displayName: string,
  models: ReadonlyArray<{ slug: string; name: string }>,
  withTraits = false,
): ServerProvider {
  return {
    driver: ProviderDriverKind.make(driver),
    instanceId: ProviderInstanceId.make(driver),
    displayName,
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: new Date().toISOString(),
    slashCommands: [],
    skills: [],
    models: models.map((model) => ({
      slug: model.slug,
      name: model.name,
      isCustom: false,
      capabilities: createModelCapabilities({
        optionDescriptors: withTraits ? [REASONING_DESCRIPTOR] : [],
      }),
    })),
  };
}

const PROVIDERS: ReadonlyArray<ServerProvider> = [
  buildProvider("codex", "Codex", [
    { slug: "gpt-5-codex", name: "GPT-5 Codex" },
    { slug: "gpt-5.3-codex", name: "GPT-5.3 Codex" },
  ]),
  // Traits ride the Claude models: the codex driver normalises its slugs
  // (`gpt-5-codex` resolves to `gpt-5.4`), so a codex-keyed traits fixture
  // silently resolves to empty capabilities and renders nothing.
  buildProvider(
    "claudeAgent",
    "Claude",
    [
      { slug: "claude-opus-4-6", name: LONGEST_MODEL_NAME },
      { slug: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
      { slug: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
    ],
    true,
  ),
];

function instanceEntries() {
  return sortProviderInstanceEntries(deriveProviderInstanceEntries(PROVIDERS));
}

function modelOptions(): ReadonlyMap<ProviderInstanceId, ReadonlyArray<AppModelOption>> {
  return new Map(
    deriveProviderInstanceEntries(PROVIDERS).map(
      (entry) =>
        [entry.instanceId, getAppModelOptionsForInstance(DEFAULT_UNIFIED_SETTINGS, entry)] as const,
    ),
  );
}

/**
 * Walks outward one pixel at a time until the hit test stops resolving to the
 * control, and returns how far its hit area actually reaches. Copied in spirit
 * from `ui/toggle.browser.tsx`: `getBoundingClientRect` cannot see a `::after`
 * hit slop, so a rect assertion would pass against a control whose slop is
 * clipped by its own `overflow-hidden` — which is exactly how a 28px model pill
 * survived a step that exists to deliver 44px targets.
 */
function hitReach(
  element: HTMLElement,
  fromX: number,
  fromY: number,
  stepX: number,
  stepY: number,
  limit = 200,
): number {
  for (let distance = 1; distance <= limit; distance += 1) {
    const target = document.elementFromPoint(fromX + stepX * distance, fromY + stepY * distance);
    if (!target || (target !== element && !element.contains(target))) {
      return distance - 1;
    }
  }
  return limit;
}

function sheetPopup(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-mobile-sheet]");
}

function sheetRows(): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>('[data-slot="mobile-list-row"]')];
}

function sheetRow(label: string): HTMLButtonElement | null {
  return sheetRows().find((row) => (row.textContent ?? "").includes(label)) ?? null;
}

async function waitForSettledSheet(): Promise<HTMLElement> {
  const element = await vi.waitFor(() => {
    const found = sheetPopup();
    expect(found).not.toBeNull();
    expect(found!.getBoundingClientRect().height).toBeGreaterThan(0);
    return found!;
  });
  let previousTop = Number.NaN;
  await vi.waitFor(() => {
    const { top } = element.getBoundingClientRect();
    const settled = top === previousTop;
    previousTop = top;
    expect(settled, "the sheet is still animating").toBe(true);
  });
  return element;
}

function renderPicker(
  overrides: {
    readonly disabled?: boolean;
    readonly disabledReason?: string;
    readonly onInstanceModelChange?: (instanceId: ProviderInstanceId, model: string) => void;
  } = {},
) {
  const onInstanceModelChange = overrides.onInstanceModelChange ?? vi.fn();
  return {
    onInstanceModelChange,
    screen: render(
      <ProviderModelPicker
        activeInstanceId={CLAUDE_INSTANCE_ID}
        model="claude-sonnet-4-6"
        lockedProvider={null}
        lockedContinuationGroupKey={null}
        instanceEntries={instanceEntries()}
        modelOptionsByInstance={modelOptions()}
        keybindings={JUMP_KEYBINDINGS}
        phoneSheet
        disabled={overrides.disabled ?? false}
        {...(overrides.disabledReason ? { disabledReason: overrides.disabledReason } : {})}
        onInstanceModelChange={onInstanceModelChange}
      />,
    ),
  };
}

/**
 * The traits overflow content, constructed through the SAME helper the composer
 * uses, so the disabled pass-through under test is the production one
 * (`composerProviderState` -> `TraitsMenuContent`) rather than a prop set
 * directly on the leaf.
 */
function traitsMenuContent(): ReactNode {
  return renderProviderTraitsMenuContent({
    provider: ProviderDriverKind.make("claudeAgent"),
    instanceId: CLAUDE_INSTANCE_ID,
    draftId: DraftId.make("draft-traits"),
    model: "claude-sonnet-4-6",
    models: PROVIDERS[1]!.models,
    modelOptions: undefined,
    prompt: "",
    onPromptChange: () => {},
    disabled: !capabilityState.allowed,
    disabledReason: capabilityState.reason,
  });
}

function footerProps(overrides: Partial<ComposerFooterProps> = {}): ComposerFooterProps {
  return {
    isFooterCompact: true,
    isPrimaryActionsCompact: true,
    isMobileViewport: true,
    hideOnMobilePendingAnswers: false,
    environmentId: EnvironmentId.make("environment-local"),
    gitCwd: null,
    hasSourceControlRemote: false,
    onSelectIssue: () => {},
    onSelectChangeRequest: () => {},
    onAttachFile: () => {},
    selectedInstanceId: CODEX_INSTANCE_ID,
    selectedModel: "gpt-5-codex",
    lockedProvider: null,
    lockedContinuationGroupKey: null,
    providerInstanceEntries: instanceEntries(),
    keybindings: JUMP_KEYBINDINGS,
    modelOptionsByInstance: modelOptions(),
    terminalOpen: false,
    isModelPickerOpen: false,
    onModelPickerOpenChange: () => {},
    onProviderModelSelect: () => {},
    showInteractionModeToggle: true,
    askModeSupported: true,
    showPlanSidebarToggle: false,
    interactionMode: "default",
    runtimeMode: "approval-required",
    tokenMode: "balanced",
    planSidebarLabel: "Plan",
    planSidebarOpen: false,
    providerTraitsMenuContent: null,
    providerTraitsChips: null,
    onInteractionModeChange: () => {},
    onTogglePlanSidebar: () => {},
    onRuntimeModeChange: () => {},
    onTokenModeChange: () => {},
    contextWindowUsage: createInitialContextWindowUsage(null),
    contextWindowRateLimits: undefined,
    pendingAction: null,
    isRunning: false,
    showPlanFollowUpPrompt: false,
    promptHasText: false,
    isSendBusy: false,
    isConnecting: false,
    isEnvironmentUnavailable: false,
    isPreparingWorktree: false,
    hasSendableContent: false,
    onPreviousPendingQuestion: () => {},
    onInterrupt: () => {},
    onImplementPlanInNewThread: () => {},
    ...overrides,
  };
}

describe("phone model and session-policy sheets", () => {
  let mounted: Awaited<ReturnType<typeof render>> | null = null;

  beforeEach(async () => {
    capabilityState.allowed = true;
    capabilityState.reason = null;
    localStorage.removeItem("ryco:client-settings:v1");
    await __resetLocalApiForTests();
    syncDocumentPresentationTier();
  });

  afterEach(async () => {
    await mounted?.unmount();
    mounted = null;
    document.body.innerHTML = "";
    localStorage.removeItem("ryco:client-settings:v1");
    await resetPointerEmulation();
    await page.viewport(DESKTOP_VIEWPORT.width, DESKTOP_VIEWPORT.height);
    await __resetLocalApiForTests();
  });

  it("opens a sheet with no shortcut hints and 44px rows on the phone tier", async () => {
    await page.viewport(PHONE_VIEWPORT.width, PHONE_VIEWPORT.height);
    await setCoarsePointerEmulation(true);
    await vi.waitFor(() => {
      expect(document.documentElement.getAttribute("data-tier")).toBe("phone");
    });
    const rendered = renderPicker();
    mounted = await rendered.screen;
    expect(window.matchMedia("(pointer: coarse)").matches).toBe(true);

    await page.getByRole("button", { name: /Claude Sonnet 4\.6/u }).click();
    await waitForSettledSheet();

    // The desktop two-pane popover is not what opened.
    expect(document.querySelector(".model-picker-list")).toBeNull();
    expect(document.querySelector("[data-model-picker-sidebar]")).toBeNull();

    // The audit found the `⌘N` shortcut hints rendering under `pointer: coarse`.
    // The phone presentation renders none at all — verified falsifiable by
    // forcing the desktop popover onto this tier, which renders one hint per
    // visible row for the jump keybindings this fixture binds.
    // Asserted as DOM presence, not as visible text: `ModelPickerContent`
    // formats jump labels from `navigator.platform`, so a `⌘`/`⌃` text match
    // is dead on a non-macOS runner where the same hints read "Ctrl+1".
    expect(document.querySelectorAll('[data-slot="kbd"]')).toHaveLength(0);

    // Every option row clears the 44px floor, measured geometrically.
    const rows = sheetRows();
    expect(rows.length).toBeGreaterThanOrEqual(5);
    for (const row of rows) {
      const rect = row.getBoundingClientRect();
      expect(
        Math.min(rect.width, rect.height),
        `touch target for "${row.textContent?.trim()}"`,
      ).toBeGreaterThanOrEqual(44);
    }
  });

  it("keeps provider grouping, favourites, search, and selection reachable in the sheet", async () => {
    localStorage.setItem(
      "ryco:client-settings:v1",
      JSON.stringify({
        ...DEFAULT_CLIENT_SETTINGS,
        favorites: [{ provider: "codex", model: "gpt-5.3-codex" }],
      }),
    );
    await page.viewport(PHONE_VIEWPORT.width, PHONE_VIEWPORT.height);
    await vi.waitFor(() => {
      expect(document.documentElement.getAttribute("data-tier")).toBe("phone");
    });
    const onInstanceModelChange = vi.fn();
    const rendered = renderPicker({ onInstanceModelChange });
    mounted = await rendered.screen;

    await page.getByRole("button", { name: /Claude Sonnet 4\.6/u }).click();
    await waitForSettledSheet();

    // Both providers are sections in one list — the desktop rail's contents,
    // none of it behind a tab — with favourites leading.
    const groupLabels = [
      ...document.querySelectorAll<HTMLElement>('[data-slot="mobile-select-sheet-group-label"]'),
    ].map((element) => element.textContent?.trim());
    expect(groupLabels[0]).toBe("Favorites");
    expect(groupLabels).toContain("Codex");
    expect(groupLabels).toContain("Claude");
    expect(sheetRow("GPT-5 Codex")).not.toBeNull();
    expect(sheetRow("Claude Haiku 4.5")).not.toBeNull();
    // The favourite is listed once, under Favorites, not twice.
    expect(
      sheetRows().filter((row) => (row.textContent ?? "").includes("GPT-5.3 Codex")),
    ).toHaveLength(1);

    // The favourite toggle survives the translation as a sibling control.
    await expect.element(page.getByRole("button", { name: "Remove from favorites" })).toBeVisible();

    // Search narrows the same list through the shared scorer.
    const search = document.querySelector<HTMLInputElement>(
      '[data-slot="mobile-select-sheet-search"] input',
    )!;
    await userEvent.fill(search, "haiku");
    await vi.waitFor(() => {
      expect(sheetRow("Claude Haiku 4.5")).not.toBeNull();
      expect(sheetRow("GPT-5 Codex")).toBeNull();
    });

    sheetRow("Claude Haiku 4.5")!.click();
    await vi.waitFor(() => {
      expect(onInstanceModelChange).toHaveBeenCalledWith(CLAUDE_INSTANCE_ID, "claude-haiku-4-5");
    });
    await vi.waitFor(() => {
      expect(sheetPopup()).toBeNull();
    });
  });

  it("leaves the desktop two-pane popover, its autofocus, and its keyboard navigation alone", async () => {
    await page.viewport(DESKTOP_VIEWPORT.width, DESKTOP_VIEWPORT.height);
    await vi.waitFor(() => {
      expect(document.documentElement.getAttribute("data-tier")).toBe("desktop");
    });
    const onInstanceModelChange = vi.fn();
    const rendered = renderPicker({ onInstanceModelChange });
    mounted = await rendered.screen;

    await page.getByRole("button", { name: /Claude Sonnet 4\.6/u }).click();

    await vi.waitFor(() => {
      expect(document.querySelector(".model-picker-list")).not.toBeNull();
    });
    // No phone sheet mounts on the desktop tier.
    expect(sheetPopup()).toBeNull();
    expect(document.querySelector('[data-slot="mobile-select-sheet-list"]')).toBeNull();

    // Autofocus and keyboard navigation are unchanged.
    const search = document.querySelector<HTMLInputElement>(
      'input[placeholder="Search models..."]',
    );
    expect(search).not.toBeNull();
    await vi.waitFor(() => {
      expect(document.activeElement).toBe(search);
    });
    await userEvent.keyboard("{ArrowDown}");
    await vi.waitFor(() => {
      expect(
        document.querySelector('[data-slot="combobox-item"][data-highlighted]'),
      ).not.toBeNull();
    });
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() => {
      expect(onInstanceModelChange).toHaveBeenCalled();
    });
  });

  it("opens the session-policy sheet from its own control and keeps full access a warned, deliberate choice", async () => {
    await page.viewport(PHONE_VIEWPORT.width, PHONE_VIEWPORT.height);
    await setCoarsePointerEmulation(true);
    await vi.waitFor(() => {
      expect(document.documentElement.getAttribute("data-tier")).toBe("phone");
    });
    const onRuntimeModeChange = vi.fn();
    const onInteractionModeChange = vi.fn();
    const onTokenModeChange = vi.fn();
    mounted = await render(
      <ComposerFooter
        {...footerProps({ onRuntimeModeChange, onInteractionModeChange, onTokenModeChange })}
      />,
    );

    // It is its OWN control, not the model trigger.
    const policyTrigger = document.querySelector<HTMLButtonElement>(
      '[data-chat-session-policy-trigger="true"]',
    );
    expect(policyTrigger).not.toBeNull();
    expect(policyTrigger!.closest('[data-chat-provider-model-picker="true"]')).toBeNull();
    policyTrigger!.click();
    await waitForSettledSheet();

    // All three policy axes, each a segmented control of 44px segments.
    for (const group of ["Mode", "Access", "Tokens"]) {
      await expect.element(page.getByRole("group", { name: group })).toBeVisible();
    }
    const segments = [
      ...document.querySelectorAll<HTMLButtonElement>('[data-slot="mobile-segmented-option"]'),
    ];
    // Access carries four modes; Mode and Tokens three each.
    expect(segments).toHaveLength(10);
    for (const segment of segments) {
      const rect = segment.getBoundingClientRect();
      expect(
        Math.min(rect.width, rect.height),
        `touch target for "${segment.textContent?.trim()}"`,
      ).toBeGreaterThanOrEqual(44);
    }

    // Full access keeps the warning treatment and is a discrete activation of
    // its own, not something reached past the other two options.
    const fullAccess = segments.find((segment) => segment.textContent?.trim() === "Full access")!;
    expect(fullAccess.dataset.tone).toBe("caution");
    const autoAccept = segments.find(
      (segment) => segment.textContent?.trim() === "Auto-accept edits",
    )!;
    // Both must be equally UNSELECTED, or the colour comparison would pass on
    // the selected/unselected difference alone and re-fixturing `runtimeMode`
    // would silently make it vacuous.
    expect(autoAccept.dataset.tone).toBe("default");
    expect(autoAccept.getAttribute("aria-pressed")).toBe(fullAccess.getAttribute("aria-pressed"));
    expect(autoAccept.getAttribute("aria-pressed")).toBe("false");
    expect(getComputedStyle(fullAccess).color).not.toBe(getComputedStyle(autoAccept).color);
    fullAccess.click();
    expect(onRuntimeModeChange).toHaveBeenCalledWith("full-access");

    // The other two axes commit through the same sheet.
    segments.find((segment) => segment.textContent?.trim() === "Plan")!.click();
    expect(onInteractionModeChange).toHaveBeenCalledWith("plan");
    segments.find((segment) => segment.textContent?.trim() === "Aggressive")!.click();
    expect(onTokenModeChange).toHaveBeenCalledWith("aggressive");
  });

  it("blocks both sheets when the mutation capability is absent, with a bounded reason", async () => {
    capabilityState.allowed = false;
    capabilityState.reason = LONG_CAPABILITY_REASON;
    await page.viewport(PHONE_VIEWPORT.width, PHONE_VIEWPORT.height);
    await vi.waitFor(() => {
      expect(document.documentElement.getAttribute("data-tier")).toBe("phone");
    });
    const onProviderModelSelect = vi.fn();
    const onRuntimeModeChange = vi.fn();
    mounted = await render(
      <ComposerFooter
        {...footerProps({
          onProviderModelSelect,
          onRuntimeModeChange,
          providerTraitsMenuContent: traitsMenuContent(),
        })}
      />,
    );

    // Both triggers are disabled, so neither sheet can even be reached from the
    // composer, and the reason never leaks an identifier or a raw error.
    const modelTrigger = document.querySelector<HTMLButtonElement>(
      '[data-chat-provider-model-picker="true"]',
    )!;
    const policyTrigger = document.querySelector<HTMLButtonElement>(
      '[data-chat-session-policy-trigger="true"]',
    )!;
    expect(modelTrigger.disabled).toBe(true);
    expect(policyTrigger.disabled).toBe(true);
    // Bounded, and the fixture reason is longer than the bound, so this fails
    // if the bound is removed.
    expect(LONG_CAPABILITY_REASON.length).toBeGreaterThan(120);
    for (const [label, title] of [
      ["policy trigger", policyTrigger.title],
      ["model trigger", modelTrigger.title],
    ] as const) {
      expect(title, `${label} reason`).toBeTruthy();
      expect(title!.length, `${label} reason length`).toBeLessThanOrEqual(120);
      expect(title!.startsWith("This action is unavailable"), `${label} reason text`).toBe(true);
    }

    // The traits overflow beside them gates on the same capability rather than
    // staying live next to two disabled controls.
    // The fixture really does produce traits content, or the gate below would
    // be asserted against an empty menu.
    expect(traitsMenuContent()).not.toBeNull();
    const traitsTrigger = page.getByRole("button", { name: "More composer controls" });
    await traitsTrigger.click();
    const reasoning = await vi.waitFor(() => {
      const found = [...document.querySelectorAll<HTMLElement>('[data-slot="menu-radio-item"]')];
      expect(found.length).toBeGreaterThan(0);
      return found;
    });
    for (const item of reasoning) {
      expect(
        item.getAttribute("data-disabled") !== null ||
          item.getAttribute("aria-disabled") === "true",
        `traits option "${item.textContent?.trim()}" should be disabled`,
      ).toBe(true);
    }
    const traitsReason = document.querySelector<HTMLElement>(
      '[data-slot="traits-disabled-reason"]',
    );
    expect(traitsReason).not.toBeNull();
    expect((traitsReason!.textContent ?? "").length).toBeLessThanOrEqual(120);

    // Forcing the triggers open commits nothing either.
    modelTrigger.click();
    modelTrigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    policyTrigger.click();
    policyTrigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onProviderModelSelect).not.toHaveBeenCalled();
    expect(onRuntimeModeChange).not.toHaveBeenCalled();
  });

  it("renders the disabled presentation inside both sheets and commits nothing from them", async () => {
    await page.viewport(PHONE_VIEWPORT.width, PHONE_VIEWPORT.height);
    await vi.waitFor(() => {
      expect(document.documentElement.getAttribute("data-tier")).toBe("phone");
    });
    const reason = "This action is unavailable for your role on the selected node.";
    const onInstanceModelChange = vi.fn();
    const rendered = renderPicker({
      disabled: false,
      onInstanceModelChange,
    });
    mounted = await rendered.screen;

    // Open the sheet while mutations are still available, then take the
    // capability away: the sheet's own presentation must carry the gate, not
    // only the trigger.
    await page.getByRole("button", { name: /Claude Sonnet 4\.6/u }).click();
    await waitForSettledSheet();
    await mounted.rerender(
      <ProviderModelPicker
        activeInstanceId={CLAUDE_INSTANCE_ID}
        model="claude-sonnet-4-6"
        lockedProvider={null}
        lockedContinuationGroupKey={null}
        instanceEntries={instanceEntries()}
        modelOptionsByInstance={modelOptions()}
        keybindings={JUMP_KEYBINDINGS}
        phoneSheet
        open
        disabled
        disabledReason={reason}
        onOpenChange={() => {}}
        onInstanceModelChange={onInstanceModelChange}
      />,
    );

    await vi.waitFor(() => {
      expect(document.querySelector('[data-slot="mobile-select-sheet-reason"]')?.textContent).toBe(
        reason,
      );
    });
    for (const row of sheetRows()) {
      expect(row.disabled, `"${row.textContent?.trim()}" should be disabled`).toBe(true);
      row.click();
      row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }
    expect(onInstanceModelChange).not.toHaveBeenCalled();
  });

  it("gives the composer's model pill a 44px effective target, measured by hit test", async () => {
    await page.viewport(PHONE_VIEWPORT.width, PHONE_VIEWPORT.height);
    await setCoarsePointerEmulation(true);
    await vi.waitFor(() => {
      expect(document.documentElement.getAttribute("data-tier")).toBe("phone");
    });
    mounted = await render(<ComposerFooter {...footerProps()} />);
    // Asserted live, not merely requested: emulation that silently failed to
    // apply would make every coarse-gated claim in this file vacuous.
    expect(window.matchMedia("(pointer: coarse)").matches).toBe(true);

    const pill = document.querySelector<HTMLElement>('[data-chat-provider-model-picker="true"]')!;
    const rect = pill.getBoundingClientRect();
    const centreX = rect.left + rect.width / 2;
    const centreY = rect.top + rect.height / 2;
    expect(
      document.elementFromPoint(centreX, centreY)?.closest("[data-chat-provider-model-picker]"),
    ).toBe(pill);

    // Hit-tested, not measured from the rect. The pill previously measured 28px
    // of REACH while carrying `Button`'s 44px `::after` slop, because the
    // trigger is `overflow-hidden` on a `relative` button — so it clipped its
    // own slop — and the composer's control row is `overflow-x-auto`, which
    // clips whatever escapes. A rect assertion sees none of that.
    const up = hitReach(pill, centreX, centreY, 0, -1);
    const down = hitReach(pill, centreX, centreY, 0, 1);
    expect(up + down + 1, "model pill vertical hit target").toBeGreaterThanOrEqual(44);
    const left = hitReach(pill, centreX, centreY, -1, 0);
    const right = hitReach(pill, centreX, centreY, 1, 0);
    expect(left + right + 1, "model pill horizontal hit target").toBeGreaterThanOrEqual(44);

    // The session-policy trigger beside it holds the same floor.
    const policy = document.querySelector<HTMLElement>(
      '[data-chat-session-policy-trigger="true"]',
    )!;
    const policyRect = policy.getBoundingClientRect();
    const policyX = policyRect.left + policyRect.width / 2;
    const policyY = policyRect.top + policyRect.height / 2;
    expect(
      hitReach(policy, policyX, policyY, 0, -1) + hitReach(policy, policyX, policyY, 0, 1) + 1,
      "session policy trigger vertical hit target",
    ).toBeGreaterThanOrEqual(44);
  });

  it("disables every session-policy control and shows one bounded reason per group", async () => {
    capabilityState.allowed = false;
    capabilityState.reason = LONG_CAPABILITY_REASON;
    await page.viewport(PHONE_VIEWPORT.width, PHONE_VIEWPORT.height);
    await vi.waitFor(() => {
      expect(document.documentElement.getAttribute("data-tier")).toBe("phone");
    });
    const onRuntimeModeChange = vi.fn();
    const onTokenModeChange = vi.fn();
    const onInteractionModeChange = vi.fn();
    const onTogglePlanSidebar = vi.fn();
    mounted = await render(
      <PhoneSessionPolicySheet
        open
        onOpenChange={() => {}}
        interactionMode="default"
        runtimeMode="approval-required"
        tokenMode="balanced"
        showInteractionModeToggle
        askModeSupported
        showPlanToggle
        planSidebarLabel="Plan"
        planSidebarOpen={false}
        disabled
        disabledReason={LONG_CAPABILITY_REASON}
        onInteractionModeChange={onInteractionModeChange}
        onRuntimeModeChange={onRuntimeModeChange}
        onTokenModeChange={onTokenModeChange}
        onTogglePlanSidebar={onTogglePlanSidebar}
      />,
    );
    await waitForSettledSheet();

    // Every segment across all three axes is disabled and commits nothing.
    const segments = [
      ...document.querySelectorAll<HTMLButtonElement>('[data-slot="mobile-segmented-option"]'),
    ];
    expect(segments).toHaveLength(10);
    for (const segment of segments) {
      expect(segment.disabled, `"${segment.textContent?.trim()}" should be disabled`).toBe(true);
      segment.click();
      segment.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }

    // The plan-sidebar row is gated with them. It is a `MobileListRow`, not a
    // segment, so it is the one control that could be left live by accident.
    const planRow = sheetRows().find((row) => (row.textContent ?? "").includes("sidebar"));
    expect(planRow, "the plan sidebar row should be rendered").toBeTruthy();
    expect(planRow!.disabled).toBe(true);
    planRow!.click();
    planRow!.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(onRuntimeModeChange).not.toHaveBeenCalled();
    expect(onTokenModeChange).not.toHaveBeenCalled();
    expect(onInteractionModeChange).not.toHaveBeenCalled();
    expect(onTogglePlanSidebar).not.toHaveBeenCalled();

    // One bounded reason per segmented group, each describing its group rather
    // than renaming it.
    const reasons = [
      ...document.querySelectorAll<HTMLElement>('[data-slot="mobile-segmented-reason"]'),
    ];
    expect(reasons).toHaveLength(3);
    expect(LONG_CAPABILITY_REASON.length).toBeGreaterThan(120);
    for (const reason of reasons) {
      const text = reason.textContent ?? "";
      expect(text.length).toBeLessThanOrEqual(120);
      expect(text.length).toBeLessThan(LONG_CAPABILITY_REASON.length);
      expect(text.startsWith("This action is unavailable")).toBe(true);
    }
    for (const group of ["Mode", "Access", "Tokens"]) {
      const element = page.getByRole("group", { name: group }).element() as HTMLElement;
      expect(element.getAttribute("aria-describedby"), `${group} description`).not.toBeNull();
    }
  });

  it("reopens the model sheet browse-first after a selection made from search", async () => {
    await page.viewport(PHONE_VIEWPORT.width, PHONE_VIEWPORT.height);
    await vi.waitFor(() => {
      expect(document.documentElement.getAttribute("data-tier")).toBe("phone");
    });
    const rendered = renderPicker();
    mounted = await rendered.screen;

    const openSheet = async () => {
      await page
        .getByRole("button", { name: /Claude/u })
        .first()
        .click();
      return waitForSettledSheet();
    };

    const first = await openSheet();
    expect(first.hasAttribute("data-expanded")).toBe(false);

    // Focus search — the sheet moves to the full detent for the keyboard — then
    // commit a selection, which closes the sheet from the CONSUMER rather than
    // through Base UI's own close path.
    const search = document.querySelector<HTMLInputElement>(
      '[data-slot="mobile-select-sheet-search"] input',
    )!;
    search.focus();
    await vi.waitFor(() => {
      expect(sheetPopup()?.hasAttribute("data-expanded")).toBe(true);
    });
    await userEvent.fill(search, "haiku");
    await vi.waitFor(() => {
      expect(sheetRow("Claude Haiku 4.5")).not.toBeNull();
    });
    sheetRow("Claude Haiku 4.5")!.click();
    await vi.waitFor(() => {
      expect(sheetPopup()).toBeNull();
    });

    // Reopening must be browse-first again. Base UI resets its snap point only
    // on the closes it resolves itself, so a selection-close used to leave the
    // sheet stuck at the full, keyboard-shaped detent for the life of the page.
    const second = await openSheet();
    expect(second.hasAttribute("data-expanded")).toBe(false);
    expect(second.getBoundingClientRect().top).toBeGreaterThan(PHONE_VIEWPORT.height / 2 - 40);
    // …and the search field is unfocused again, as on the first open.
    const reopenedSearch = document.querySelector<HTMLInputElement>(
      '[data-slot="mobile-select-sheet-search"] input',
    )!;
    expect(document.activeElement).not.toBe(reopenedSearch);
    expect(reopenedSearch.value).toBe("");
  });

  it("does not overflow the page at 320px with the longest model name in the set", async () => {
    await page.viewport(NARROW_VIEWPORT.width, NARROW_VIEWPORT.height);
    await vi.waitFor(() => {
      expect(document.documentElement.getAttribute("data-tier")).toBe("phone");
    });
    const rendered = renderPicker();
    mounted = await rendered.screen;

    await page.getByRole("button", { name: /Claude Sonnet 4\.6/u }).click();
    const popup = await waitForSettledSheet();
    expect(sheetRow(LONGEST_MODEL_NAME)).not.toBeNull();

    // Measured, not the literal the viewport was REQUESTED at: the runner
    // scales the emulated viewport, and asserting against a constant the page
    // never confirmed is the shape of the 151px-column incident.
    const width = window.innerWidth;
    expect(width).toBeLessThanOrEqual(NARROW_VIEWPORT.width);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    expect(document.body.scrollWidth).toBeLessThanOrEqual(width);
    expect(popup.getBoundingClientRect().right).toBeLessThanOrEqual(width + 0.5);
    for (const row of sheetRows()) {
      const rect = row.getBoundingClientRect();
      expect(rect.left, `${row.textContent?.trim()} off-screen left`).toBeGreaterThanOrEqual(-0.5);
      expect(rect.right, `${row.textContent?.trim()} off-screen right`).toBeLessThanOrEqual(
        width + 0.5,
      );
    }
  });
});
