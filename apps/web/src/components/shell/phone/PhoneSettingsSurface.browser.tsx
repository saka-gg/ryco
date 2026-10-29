// Production CSS is part of the behavior under test: row heights, the
// full-screen popup geometry, and the safe-area/motion utility classes drive
// the assertions below.
import "../../../index.css";

import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  type LocalApi,
  type ServerConfig,
  type SourceControlDiscoveryResult,
} from "@ryco/contracts";
import { page, userEvent } from "vite-plus/test/browser";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

// The archived-threads section reaches for router state through the shared
// thread actions; the surface itself never navigates.
const navigate = vi.fn(async () => undefined);
const routerStub = { navigate, state: { matches: [] } };
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => navigate,
  useRouter: () => routerStub,
}));

vi.mock("../../../environments/runtime", () => {
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
        subscribeAuthAccess: (listener: (event: unknown) => void) => {
          listener({
            version: 1,
            revision: 1,
            type: "snapshot",
            payload: { pairingLinks: [], clientSessions: [] },
          });
          return () => {};
        },
        getAdvertisedEndpoints: async () => [],
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
    listEnvironmentConnections: () => [primaryConnection],
    resetSavedEnvironmentRegistryStoreForTests: () => undefined,
    resetSavedEnvironmentRuntimeStoreForTests: () => undefined,
    resolveEnvironmentHttpUrl: (_environmentId: unknown, path: string) =>
      new URL(path, "http://localhost:3000").toString(),
    waitForSavedEnvironmentRegistryHydration: async () => undefined,
    addSavedEnvironment: vi.fn(),
    connectPrimaryEnvironment: () => primaryConnection,
    connectDesktopWorkspaceEnvironment: vi.fn(),
    connectDesktopSshEnvironment: vi.fn(),
    disconnectPrimaryEnvironment: vi.fn(),
    disconnectSavedEnvironment: vi.fn(),
    ensureEnvironmentConnectionBootstrapped: async () => undefined,
    getPrimaryEnvironmentConnection: () => primaryConnection,
    readEnvironmentConnection: () => primaryConnection,
    reconnectSavedEnvironment: vi.fn(),
    removeSavedEnvironment: vi.fn(),
    requireEnvironmentConnection: () => primaryConnection,
    resetEnvironmentServiceForTests: () => undefined,
    startEnvironmentConnectionService: () => undefined,
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

import { setCoarsePointerEmulation } from "../../../../test/browserPointer";
import { __resetLocalApiForTests } from "../../../localApi";
import { syncDocumentPresentationTier } from "../../../lib/presentationTier";
import { AppAtomRegistryProvider } from "../../../rpc/atomRegistry";
import { resetServerStateForTests, setServerConfigSnapshot } from "../../../rpc/serverState";
import { useSettingsDialogStore } from "../../../settingsDialogStore";
import { PhoneSettingsSurface, PHONE_SETTINGS_GENERAL_LABELS } from "./PhoneSettingsSurface";

/**
 * The resting list's labels, DERIVED from the surface's own registry.
 *
 * It was a hardcoded array, and every assertion over it was "each of these is
 * present" — never "these are all of them". A section added to the desktop
 * dialog and forgotten here stayed green, which is how `security` shipped
 * unreachable on the phone tier. The set is checked against the desktop
 * inventory in `SettingsPage.test.ts`; this drives the geometry and push
 * assertions over whatever that set turns out to be.
 *
 * "Account" is filtered out at render in the standard client (it is hosted-only),
 * so it is not in the resting list this suite walks.
 */
const GENERAL_SECTION_LABELS = PHONE_SETTINGS_GENERAL_LABELS.filter((label) => label !== "Account");

function createBaseServerConfig(): ServerConfig {
  return {
    environment: {
      environmentId: EnvironmentId.make("environment-local"),
      label: "Local environment",
      platform: { os: "darwin" as const, arch: "arm64" as const },
      serverVersion: "0.0.0-test",
      capabilities: {
        repositoryIdentity: true,
        threadSettlement: false,
        threadPriorityRanking: false,
      },
    },
    auth: {
      policy: "loopback-browser",
      bootstrapMethods: ["one-time-token"],
      sessionMethods: ["browser-session-cookie", "bearer-session-token"],
      sessionCookieName: "ryco_session",
    },
    cwd: "/repo/project",
    keybindingsConfigPath: "/repo/project/.ryco-keybindings.json",
    keybindings: [],
    issues: [],
    providers: [],
    availableEditors: ["cursor"],
    observability: {
      logsDirectoryPath: "/repo/project/.ryco/logs",
      localTracingEnabled: true,
      otlpTracesUrl: "http://localhost:4318/v1/traces",
      otlpTracesEnabled: true,
      otlpMetricsEnabled: false,
    },
    settings: DEFAULT_SERVER_SETTINGS,
  };
}

/**
 * A minimal native API: enough for the settings panels to mount without
 * crashing. Panels whose data sources reject render their bounded error or
 * empty states — the surface bar (back affordance plus section heading) never
 * depends on panel data, which is exactly what the paged navigation tests
 * assert.
 */
function installNativeApiStub() {
  window.nativeApi = {
    persistence: {
      getClientSettings: vi.fn().mockResolvedValue(null),
      setClientSettings: vi.fn().mockResolvedValue(undefined),
      getSavedEnvironmentRegistry: vi.fn().mockResolvedValue([]),
      setSavedEnvironmentRegistry: vi.fn().mockResolvedValue(undefined),
      getSavedEnvironmentSecret: vi.fn().mockResolvedValue(null),
      setSavedEnvironmentSecret: vi.fn().mockResolvedValue(true),
      removeSavedEnvironmentSecret: vi.fn().mockResolvedValue(undefined),
    },
    server: {
      getConfig: vi.fn().mockResolvedValue(createBaseServerConfig()),
      refreshProviders: vi.fn().mockResolvedValue({ providers: [] }),
      upsertKeybinding: vi.fn().mockResolvedValue({ keybindings: [] }),
      getSettings: vi.fn().mockResolvedValue(DEFAULT_SERVER_SETTINGS),
      updateSettings: vi.fn().mockResolvedValue(DEFAULT_SERVER_SETTINGS),
      discoverSourceControl: vi.fn().mockResolvedValue({
        versionControlSystems: [],
        sourceControlProviders: [],
      } satisfies SourceControlDiscoveryResult),
      getStatistics: vi.fn().mockRejectedValue(new Error("Statistics unavailable in tests.")),
      getDiagnosticsSnapshot: vi
        .fn()
        .mockRejectedValue(new Error("Diagnostics unavailable in tests.")),
      listOpinionatedPlugins: vi.fn().mockResolvedValue({ plugins: [] }),
      checkOpinionatedPlugins: vi.fn().mockResolvedValue({ statuses: [] }),
    },
    shell: {
      openInEditor: vi.fn().mockResolvedValue(undefined),
      openExternal: vi.fn().mockResolvedValue(undefined),
    },
    dialogs: {
      pickFolder: vi.fn().mockResolvedValue(null),
      confirm: vi.fn().mockResolvedValue(false),
    },
    contextMenu: {
      show: vi.fn().mockResolvedValue(null),
    },
  } as unknown as LocalApi;
}

function settingsPopup(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-testid="phone-settings-surface"]');
}

function listRow(label: string): HTMLButtonElement | null {
  const popup = settingsPopup();
  if (!popup) return null;
  return (
    [...popup.querySelectorAll<HTMLButtonElement>("nav button")].find(
      (button) => button.textContent?.trim() === label,
    ) ?? null
  );
}

function sectionHeading(): HTMLElement | null {
  return settingsPopup()?.querySelector<HTMLElement>("h1[tabindex]") ?? null;
}

function backToSettingsButton(): HTMLElement | null {
  return (
    settingsPopup()?.querySelector<HTMLElement>('button[aria-label="Back to settings"]') ?? null
  );
}

function accessibleName(button: HTMLElement): string {
  return (
    button.getAttribute("aria-label")?.trim() ||
    (button.getAttribute("aria-labelledby")
      ? (document.getElementById(button.getAttribute("aria-labelledby") ?? "")?.textContent ?? "")
      : "") ||
    button.textContent?.trim() ||
    ""
  );
}

async function mountSurface() {
  return render(
    <AppAtomRegistryProvider>
      <PhoneSettingsSurface />
    </AppAtomRegistryProvider>,
  );
}

let mounted: Awaited<ReturnType<typeof render>> | null = null;

describe("PhoneSettingsSurface", () => {
  beforeAll(async () => {
    // Navigation assertions exercise rendered panels. Resolve their lazy modules
    // once so cold Vite transforms cannot exhaust a short interaction wait.
    await Promise.all([
      import("../../settings/ProvidersSettingsPanel"),
      import("../../settings/AiFocusSettings"),
      import("../../settings/OpinionatedPluginsSettings"),
      import("../../settings/McpServersSettings"),
      import("../../settings/AppearanceSettings"),
      import("../../settings/KeybindingsSettings"),
      import("../../settings/SourceControlSettings"),
      import("../../settings/ConnectionsSettings"),
      import("../../settings/NodeSecuritySettings"),
      import("../../settings/DiagnosticsSettings"),
      import("../../settings/StatisticsPanel"),
    ]);
    syncDocumentPresentationTier();
  });

  beforeEach(async () => {
    await page.viewport(390, 844);
    localStorage.clear();
    resetServerStateForTests();
    await __resetLocalApiForTests();
    installNativeApiStub();
    setServerConfigSnapshot(createBaseServerConfig());
    useSettingsDialogStore.setState({ open: false, section: "general" });
  });

  afterEach(async () => {
    await mounted?.unmount();
    mounted = null;
    useSettingsDialogStore.setState({ open: false, section: "general" });
    Reflect.deleteProperty(window, "nativeApi");
    resetServerStateForTests();
    await __resetLocalApiForTests();
    vi.restoreAllMocks();
    document.body.innerHTML = "";
    await page.viewport(1_280, 720);
  });

  it("lists every section as a labeled 44px row at 320px, with diagnostics under Advanced", async () => {
    await page.viewport(320, 568);
    mounted = await mountSurface();
    useSettingsDialogStore.getState().openSettings();

    const popup = await vi.waitFor(() => {
      const element = settingsPopup();
      expect(element).not.toBeNull();
      return element!;
    });
    // Full-screen: the popup covers the whole viewport.
    await vi.waitFor(() => {
      const rect = popup.getBoundingClientRect();
      expect(rect.width).toBeGreaterThanOrEqual(320 - 0.5);
      expect(rect.height).toBeGreaterThanOrEqual(568 - 0.5);
    });

    for (const label of GENERAL_SECTION_LABELS) {
      const row = listRow(label);
      expect(row, `Missing settings row "${label}".`).not.toBeNull();
      expect(row!.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    }
    // Diagnostics is not in the resting list: it lives behind the Advanced
    // progressive disclosure.
    expect(listRow("Diagnostics")).toBeNull();
    const advancedToggle = listRow("Advanced");
    expect(advancedToggle).not.toBeNull();
    expect(advancedToggle!.getAttribute("aria-expanded")).toBe("false");
    advancedToggle!.click();
    const diagnosticsRow = await vi.waitFor(() => {
      const row = listRow("Diagnostics");
      expect(row).not.toBeNull();
      return row!;
    });
    expect(advancedToggle!.getAttribute("aria-expanded")).toBe("true");
    expect(diagnosticsRow.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);

    // Label audit: every control inside the surface has an accessible name.
    for (const button of popup.querySelectorAll<HTMLElement>("button")) {
      expect(accessibleName(button), "Icon-only control without accessible name.").not.toBe("");
    }
    // No page-level horizontal overflow at 320px.
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(320);
  });

  it("pushes every section full-width with a working back affordance at 320px", async () => {
    await page.viewport(320, 568);
    mounted = await mountSurface();
    useSettingsDialogStore.getState().openSettings();
    await vi.waitFor(() => {
      expect(settingsPopup()).not.toBeNull();
    });

    const advancedToggle = listRow("Advanced");
    expect(advancedToggle).not.toBeNull();
    advancedToggle!.click();
    await vi.waitFor(() => {
      expect(listRow("Diagnostics")).not.toBeNull();
    });

    for (const label of [...GENERAL_SECTION_LABELS, "Diagnostics"]) {
      const row = await vi.waitFor(() => {
        const element = listRow(label);
        expect(element, `Missing settings row "${label}".`).not.toBeNull();
        return element!;
      });
      row.click();
      await vi.waitFor(() => {
        const heading = sectionHeading();
        expect(heading?.textContent).toBe(label);
        expect(backToSettingsButton()).not.toBeNull();
      });
      // The section page spans the full surface width; the store tracks the
      // pushed section.
      expect(useSettingsDialogStore.getState().section).toBe(
        label === "Diagnostics"
          ? "diagnostics"
          : {
              General: "general",
              Inbox: "inbox",
              Providers: "providers",
              Plugins: "opinionated-plugins",
              "MCP Servers": "mcp-servers",
              Appearance: "appearance",
              Keybindings: "keybindings",
              "Source Control": "source-control",
              Connections: "connections",
              Security: "security",
              Statistics: "statistics",
              Archive: "archived",
            }[label],
      );
      backToSettingsButton()!.click();
      await vi.waitFor(() => {
        expect(sectionHeading()).toBeNull();
        expect(listRow("General")).not.toBeNull();
      });
      if (label === "Diagnostics") continue;
      // The Advanced disclosure keeps its expanded state while paging.
      expect(listRow("Diagnostics")).not.toBeNull();
    }
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(320);
  });

  it("moves focus to the section on push and back to the originating row on pop", async () => {
    mounted = await mountSurface();
    useSettingsDialogStore.getState().openSettings();
    const appearanceRow = await vi.waitFor(() => {
      const row = listRow("Appearance");
      expect(row).not.toBeNull();
      return row!;
    });

    appearanceRow.click();
    await vi.waitFor(() => {
      const heading = sectionHeading();
      expect(heading?.textContent).toBe("Appearance");
      expect(document.activeElement).toBe(heading);
    });

    backToSettingsButton()!.click();
    await vi.waitFor(() => {
      const row = listRow("Appearance");
      expect(row).not.toBeNull();
      expect(document.activeElement).toBe(row);
    });
  });

  it("closes on Escape from both the list and a pushed section (desktop dialog parity)", async () => {
    mounted = await mountSurface();
    useSettingsDialogStore.getState().openSettings();
    await vi.waitFor(() => {
      expect(settingsPopup()).not.toBeNull();
    });

    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => {
      expect(useSettingsDialogStore.getState().open).toBe(false);
      expect(settingsPopup()).toBeNull();
    });

    useSettingsDialogStore.getState().openSettings();
    const row = await vi.waitFor(() => {
      const element = listRow("Appearance");
      expect(element).not.toBeNull();
      return element!;
    });
    row.click();
    await vi.waitFor(() => {
      expect(sectionHeading()?.textContent).toBe("Appearance");
    });
    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => {
      expect(useSettingsDialogStore.getState().open).toBe(false);
      expect(settingsPopup()).toBeNull();
    });
  });

  it("opens the phone appearance group's option sheet from inside the settings surface", async () => {
    mounted = await mountSurface();
    useSettingsDialogStore.getState().openSettings();

    const materialRow = await vi.waitFor(() => {
      const row = [
        ...(settingsPopup()?.querySelectorAll<HTMLButtonElement>(
          '[aria-label="Phone appearance"] [data-slot="mobile-list-row"]',
        ) ?? []),
      ].find((candidate) => candidate.textContent?.startsWith("Material"));
      expect(row, "Missing the phone appearance Material row.").toBeDefined();
      return row!;
    });
    expect(materialRow.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);

    // The option sheet is a real bottom sheet nested inside the full-screen
    // settings surface, not a desktop select.
    materialRow.click();
    const option = await vi.waitFor(() => {
      const rows = [
        ...document.querySelectorAll<HTMLButtonElement>(
          '[data-mobile-sheet] [data-slot="mobile-list-row"]',
        ),
      ];
      expect(rows.map((row) => row.textContent?.replace(/([a-z])([A-Z])/gu, "$1|$2"))).toEqual([
        "Solid|Opaque, no blur",
        "Standard|Single layer",
        "Glass|Thin material",
      ]);
      return rows[2]!;
    });

    option.click();
    await vi.waitFor(() => {
      expect(document.querySelector("[data-mobile-sheet]")).toBeNull();
      expect(JSON.parse(localStorage.getItem("ryco:appearance-preferences") ?? "{}")).toEqual({
        surfaceTransparency: "glass",
      });
    });
    // The settings surface itself stays open behind the dismissed sheet.
    expect(settingsPopup()).not.toBeNull();
  });

  it("lands directly on the section page for open-to-section deep links", async () => {
    mounted = await mountSurface();

    // Closed -> openSettings(section): the section page renders immediately.
    useSettingsDialogStore.getState().openSettings("source-control");
    await vi.waitFor(() => {
      expect(sectionHeading()?.textContent).toBe("Source Control");
      expect(backToSettingsButton()).not.toBeNull();
    });
    // The back affordance still reaches the list.
    backToSettingsButton()!.click();
    await vi.waitFor(() => {
      expect(sectionHeading()).toBeNull();
      expect(listRow("General")).not.toBeNull();
    });

    // Re-linking to the SAME section from the list is not a store no-op:
    // the back affordance rests the canonical section, so a palette or menu
    // deep link to the just-visited section pushes its page again.
    useSettingsDialogStore.getState().openSettings("source-control");
    await vi.waitFor(() => {
      expect(sectionHeading()?.textContent).toBe("Source Control");
    });
    backToSettingsButton()!.click();
    await vi.waitFor(() => {
      expect(sectionHeading()).toBeNull();
    });

    // While open, a menu-driven openSettings(section) pushes that section.
    useSettingsDialogStore.getState().openSettings("connections");
    await vi.waitFor(() => {
      expect(sectionHeading()?.textContent).toBe("Connections");
    });

    // Close and reopen generically: the list is the resting view again, and
    // the SAME deep link keeps working on the next open.
    useSettingsDialogStore.getState().closeSettings();
    await vi.waitFor(() => {
      expect(settingsPopup()).toBeNull();
    });
    useSettingsDialogStore.getState().openSettings();
    await vi.waitFor(() => {
      expect(settingsPopup()).not.toBeNull();
      expect(sectionHeading()).toBeNull();
      expect(listRow("General")).not.toBeNull();
    });
    useSettingsDialogStore.getState().closeSettings();
    await vi.waitFor(() => {
      expect(settingsPopup()).toBeNull();
    });
    useSettingsDialogStore.getState().openSettings("source-control");
    await vi.waitFor(() => {
      expect(sectionHeading()?.textContent).toBe("Source Control");
    });
  });

  it("keeps the QA tier-preview override reachable under Advanced diagnostics, dev-gated", async () => {
    mounted = await mountSurface();
    useSettingsDialogStore.getState().openSettings();
    const advancedToggle = await vi.waitFor(() => {
      const toggle = listRow("Advanced");
      expect(toggle).not.toBeNull();
      return toggle!;
    });
    advancedToggle.click();
    const diagnosticsRow = await vi.waitFor(() => {
      const row = listRow("Diagnostics");
      expect(row).not.toBeNull();
      return row!;
    });
    diagnosticsRow.click();
    await vi.waitFor(() => {
      expect(sectionHeading()?.textContent).toBe("Diagnostics");
    });
    // The dev-gated preview override renders inside the unchanged
    // DiagnosticsSettings section (the browser suite runs a dev build; the
    // gate itself stays `import.meta.env.DEV` in DiagnosticsSettings).
    await vi.waitFor(() => {
      expect(settingsPopup()?.textContent).toContain("Presentation tier preview");
      expect(settingsPopup()?.textContent).toContain("Overview");
      expect(settingsPopup()?.textContent).not.toContain("Performance now");
      expect(settingsPopup()?.textContent).not.toContain("Why was this slow?");
      expect(settingsPopup()?.textContent).not.toContain("Advanced diagnostics");
    });
  });

  it("declares safe-area and reduced-motion behavior on the surface popup", async () => {
    mounted = await mountSurface();
    useSettingsDialogStore.getState().openSettings();
    const popup = await vi.waitFor(() => {
      const element = settingsPopup();
      expect(element).not.toBeNull();
      return element!;
    });
    // Safe areas: top, both landscape sides, and a bottom inset composed
    // with the keyboard inset variable.
    expect(popup.className).toContain("pt-safe");
    expect(popup.className).toContain("pl-safe");
    expect(popup.className).toContain("pr-safe");
    expect(popup.className).toContain(
      "pb-[max(env(safe-area-inset-bottom),var(--app-keyboard-inset,0px))]",
    );
    // Reduced motion: the sheet transition declares a motion-reduce variant;
    // navigation correctness never depends on animation completion.
    expect(popup.className).toContain("motion-reduce:transition-none");
  });

  it("survives 200% text scaling at 320px without hiding controls or page overflow", async () => {
    await page.viewport(320, 568);
    const previousFontSize = document.documentElement.style.fontSize;
    document.documentElement.style.fontSize = "32px";
    try {
      mounted = await mountSurface();
      useSettingsDialogStore.getState().openSettings();
      const popup = await vi.waitFor(() => {
        const element = settingsPopup();
        expect(element).not.toBeNull();
        return element!;
      });
      // Wait out the entry transition before measuring geometry.
      await vi.waitFor(() => {
        const rect = popup.getBoundingClientRect();
        expect(rect.width).toBeGreaterThanOrEqual(320 - 0.5);
        expect(Math.round(rect.left)).toBe(0);
      });
      const closeButton = popup.querySelector<HTMLElement>('button[aria-label="Close settings"]')!;
      expect(closeButton).not.toBeNull();
      const closeRect = closeButton.getBoundingClientRect();
      expect(closeRect.width).toBeGreaterThan(0);
      expect(closeRect.right).toBeLessThanOrEqual(320 + 0.5);
      for (const label of GENERAL_SECTION_LABELS) {
        const row = listRow(label);
        expect(row, `Missing settings row "${label}" at 200% text scale.`).not.toBeNull();
        expect(row!.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
      }
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(320);
    } finally {
      document.documentElement.style.fontSize = previousFontSize;
    }
  });

  it("keeps the settings surface full-screen on a coarse landscape phone", async () => {
    // Acceptance-matrix gap fill (delivery step 10): 844×390 classifies as a
    // phone only through the coarse-pointer clause; the full-screen surface,
    // its 44px rows, and the section push/pop must hold there too.
    await page.viewport(844, 390);
    await setCoarsePointerEmulation(true);
    try {
      await vi.waitFor(() => {
        expect(document.documentElement.getAttribute("data-tier")).toBe("phone");
      });
      mounted = await mountSurface();
      useSettingsDialogStore.getState().openSettings();
      const popup = await vi.waitFor(() => {
        const element = settingsPopup();
        expect(element).not.toBeNull();
        return element!;
      });
      await vi.waitFor(() => {
        const rect = popup.getBoundingClientRect();
        expect(rect.width).toBeGreaterThanOrEqual(844 - 0.5);
        expect(rect.height).toBeGreaterThanOrEqual(390 - 0.5);
      });
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(844);

      const generalRow = await vi.waitFor(() => {
        const row = listRow("General");
        expect(row).not.toBeNull();
        return row!;
      });
      expect(generalRow.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);

      // Section push and the back affordance work in landscape, with the
      // pushed page still contained.
      generalRow.click();
      await vi.waitFor(() => {
        expect(sectionHeading()?.textContent).toContain("General");
      });
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(844);
      const back = await vi.waitFor(() => {
        const button = backToSettingsButton();
        expect(button).not.toBeNull();
        return button!;
      });
      back.click();
      await vi.waitFor(() => {
        expect(listRow("General")).not.toBeNull();
      });
    } finally {
      await setCoarsePointerEmulation(false);
    }
  });
});
