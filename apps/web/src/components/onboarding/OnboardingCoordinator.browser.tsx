import "../../index.css";
import { useSyncExternalStore } from "react";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@ryco/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";
import { useSettingsDialogStore } from "../../settingsDialogStore";
import { useCommandPaletteStore } from "../../commandPaletteStore";
import { OnboardingCoordinator } from "./OnboardingCoordinator";
import { OnboardingReplaySetting } from "./OnboardingReplaySetting";
import { useOnboardingReplayStore } from "./onboardingState";

const fixture = vi.hoisted(() => ({
  revision: 0,
  listeners: new Set<() => void>(),
  id: "",
  eligible: true,
  tier: "desktop",
  config: null as { providers: readonly ServerProvider[] } | null,
  shell: {
    bootstrapComplete: false,
    hydratedFromCacheAt: undefined as number | undefined,
    projectIds: [] as string[],
  },
  connection: { phase: "connected", connectedAt: "generation-1" },
  scope: "client",
  settingsHydrated: true,
  settings: { localOnboardingCompletedEnvironmentIds: [] as string[] },
  updateSettings: vi.fn(),
  refresh: vi.fn<() => Promise<{ providers: readonly ServerProvider[] }>>(),
  apply: vi.fn(),
}));
function useFixtureRevision() {
  useSyncExternalStore(
    (listener) => {
      fixture.listeners.add(listener);
      return () => {
        fixture.listeners.delete(listener);
      };
    },
    () => fixture.revision,
  );
}
function notifyFixture() {
  fixture.revision += 1;
  fixture.listeners.forEach((listener) => listener());
}
vi.mock("../../hooks/useSettings", () => ({
  useClientSettingsHydrated: () => {
    useFixtureRevision();
    return fixture.settingsHydrated;
  },
  useSettings: (selector: (settings: object) => unknown) => {
    useFixtureRevision();
    return selector(fixture.settings);
  },
  getClientSettings: () => fixture.settings,
  useUpdateSettings: () => ({ updateSettings: fixture.updateSettings }),
}));
vi.mock("../../composerDraftStore", () => ({ DraftId: { make: (value: string) => value } }));
vi.mock("../../environments/primary", () => ({
  usePrimaryEnvironmentId: () => {
    useFixtureRevision();
    return fixture.id;
  },
}));
vi.mock("../../hooks/usePresentationTier", () => ({
  usePresentationTier: () => {
    useFixtureRevision();
    return fixture.tier;
  },
}));
vi.mock("./localOnboarding", () => ({ isLocalOnboardingClient: () => fixture.eligible }));
vi.mock("../../rpc/serverState", () => ({
  useServerConfig: () => {
    useFixtureRevision();
    return fixture.config;
  },
  applyProvidersUpdated: fixture.apply,
}));
vi.mock("../../rpc/wsConnectionState", () => ({
  getWsConnectionStatusForEnvironment: () => fixture.connection,
  useWsConnectionStatusForEnvironment: () => {
    useFixtureRevision();
    return fixture.connection;
  },
}));
vi.mock("../../store", () => ({
  useStore: (selector: (state: object) => unknown) => {
    useFixtureRevision();
    return selector({});
  },
  selectEnvironmentState: () => fixture.shell,
}));
vi.mock("../../hostedHub/capabilities", () => ({
  useHostedRpcCapability: () => ({ allowed: true }),
}));
vi.mock("../../environmentApi", () => ({
  readEnvironmentApi: () => ({ server: { refreshProviders: fixture.refresh } }),
}));
vi.mock("../../settingsTarget", () => ({ useSettingsEditingScope: () => fixture.scope }));

let mounted: Awaited<ReturnType<typeof render>> | undefined;
const provider = (
  id: string,
  auth: ServerProvider["auth"]["status"] = "authenticated",
): ServerProvider => ({
  instanceId: ProviderInstanceId.make(id.toLowerCase().replaceAll(" ", "-")),
  driver: ProviderDriverKind.make("codex"),
  displayName: id,
  enabled: true,
  installed: true,
  version: "1.0",
  status: "ready",
  auth: { status: auth },
  checkedAt: "2026-09-15T10:00:00Z",
  models: [],
  slashCommands: [],
  skills: [],
});
function Harness() {
  const settings = useSettingsDialogStore((state) => state.open);
  const palette = useCommandPaletteStore((state) => state.open);
  return (
    <>
      <OnboardingReplaySetting />
      <OnboardingCoordinator />
      {settings && (
        <button onClick={() => useSettingsDialogStore.getState().closeSettings()}>
          Close fixture settings
        </button>
      )}
      {palette && (
        <button onClick={() => useCommandPaletteStore.getState().setOpen(false)}>
          Close fixture project picker
        </button>
      )}
    </>
  );
}
async function mount() {
  mounted = await render(<Harness />);
}
async function update() {
  notifyFixture();
  await mounted!.rerender(<Harness />);
}
const dialog = () => page.getByRole("dialog");
const continueButton = () => page.getByRole("button", { name: "Continue", exact: true });

beforeEach(async () => {
  fixture.id = `onboarding-${crypto.randomUUID()}`;
  fixture.eligible = true;
  fixture.tier = "desktop";
  fixture.scope = "client";
  fixture.config = { providers: [provider("Codex Personal"), provider("Codex Work", "unknown")] };
  fixture.shell = { bootstrapComplete: true, hydratedFromCacheAt: undefined, projectIds: [] };
  fixture.connection = { phase: "connected", connectedAt: "generation-1" };
  fixture.settings = { localOnboardingCompletedEnvironmentIds: [] };
  fixture.settingsHydrated = true;
  fixture.updateSettings.mockReset().mockImplementation((patch) => {
    fixture.settings = { ...fixture.settings, ...patch };
    notifyFixture();
  });
  fixture.apply.mockReset();
  fixture.refresh.mockReset();
  fixture.refresh.mockResolvedValue({ providers: [provider("Refreshed")] });
  useOnboardingReplayStore.getState().consume();
  useSettingsDialogStore.getState().closeSettings();
  useCommandPaletteStore.getState().setOpen(false);
  await page.viewport(1100, 720);
});
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

describe("local first-run onboarding", () => {
  it("waits for a live shell, excluding cached and disconnected snapshots", async () => {
    fixture.shell.bootstrapComplete = false;
    await mount();
    expect(dialog().elements()).toHaveLength(0);
    fixture.shell.bootstrapComplete = true;
    fixture.shell.hydratedFromCacheAt = 1;
    await update();
    expect(dialog().elements()).toHaveLength(0);
    fixture.shell.hydratedFromCacheAt = undefined;
    fixture.connection.phase = "disconnected";
    await update();
    expect(dialog().elements()).toHaveLength(0);
    fixture.connection.phase = "connected";
    await update();
    await expect.element(dialog()).toBeVisible();
    expect(fixture.refresh).not.toHaveBeenCalled();
    await expect
      .element(page.getByText("Authentication not verified", { exact: false }))
      .toBeVisible();
  });

  it.each(["phone", "hosted"])(
    "does not mount setup or replay in %s presentation",
    async (surface) => {
      if (surface === "phone") fixture.tier = "phone";
      else fixture.eligible = false;
      await mount();
      expect(dialog().elements()).toHaveLength(0);
      expect(page.getByRole("button", { name: "Open welcome tour" }).elements()).toHaveLength(0);
      expect(fixture.refresh).not.toHaveBeenCalled();
    },
  );

  it("exempts established installations even after all projects are removed", async () => {
    fixture.shell.projectIds = ["existing-project"];
    await mount();
    expect(dialog().elements()).toHaveLength(0);
    expect(fixture.settings.localOnboardingCompletedEnvironmentIds.includes(fixture.id)).toBe(true);
    fixture.shell.projectIds = [];
    await update();
    expect(dialog().elements()).toHaveLength(0);
  });

  it("skips, replays once, finishes, and does not replay after remount or environment switch", async () => {
    await mount();
    await page.getByRole("button", { name: "Skip setup" }).click();
    await expect.element(dialog()).not.toBeInTheDocument();
    await page.getByRole("button", { name: "Open welcome tour" }).click();
    await expect.element(dialog()).toBeVisible();
    expect(useOnboardingReplayStore.getState().requestedFor).toBeNull();
    await continueButton().click();
    await continueButton().click();
    await page.getByRole("button", { name: "Finish setup" }).click();
    await expect.element(dialog()).not.toBeInTheDocument();
    await mounted!.unmount();
    await mount();
    expect(dialog().elements()).toHaveLength(0);
    const otherId = EnvironmentId.make(`other-${crypto.randomUUID()}`);
    fixture.settings.localOnboardingCompletedEnvironmentIds.push(otherId);
    fixture.id = otherId;
    await update();
    expect(dialog().elements()).toHaveLength(0);
  });

  it("consumes replay while setup is already active without reopening after completion", async () => {
    await mount();
    await page.getByRole("button", { name: "Provider settings", exact: true }).click();
    await page.getByRole("button", { name: "Open welcome tour" }).click();
    await expect.element(dialog()).toBeVisible();
    expect(useOnboardingReplayStore.getState().requestedFor).toBeNull();
    await page.getByRole("button", { name: "Skip setup" }).click();
    await expect.element(dialog()).not.toBeInTheDocument();
    await mounted!.unmount();
    await mount();
    expect(dialog().elements()).toHaveLength(0);
  });

  it("waits for client persistence hydration before interpreting an absent marker", async () => {
    fixture.settingsHydrated = false;
    await mount();
    expect(dialog().elements()).toHaveLength(0);
    fixture.settings.localOnboardingCompletedEnvironmentIds.push(fixture.id);
    fixture.settingsHydrated = true;
    await update();
    expect(dialog().elements()).toHaveLength(0);
  });

  it("discards a pending replay for a different environment", async () => {
    useOnboardingReplayStore.getState().replay(EnvironmentId.make("previous-environment"));
    fixture.settings.localOnboardingCompletedEnvironmentIds.push(fixture.id);
    await mount();
    expect(dialog().elements()).toHaveLength(0);
    expect(useOnboardingReplayStore.getState().requestedFor).toBeNull();
  });

  it("hands off to existing settings and project picker without two open dialogs or losing its step", async () => {
    await mount();
    await page.getByRole("button", { name: "Provider settings", exact: true }).click();
    expect(useSettingsDialogStore.getState().targetEnvironmentId).toBe(fixture.id);
    expect(fixture.settings.localOnboardingCompletedEnvironmentIds.includes(fixture.id)).toBe(
      false,
    );
    await expect.element(dialog()).not.toBeInTheDocument();
    await page.getByRole("button", { name: "Close fixture settings" }).click();
    await expect
      .element(page.getByRole("heading", { name: "Bring your coding agent" }))
      .toBeVisible();
    await continueButton().click();
    await page.getByRole("button", { name: "Add project", exact: true }).click();
    expect(useCommandPaletteStore.getState().openIntent?.kind).toBe("add-project");
    expect(fixture.settings.localOnboardingCompletedEnvironmentIds.includes(fixture.id)).toBe(
      false,
    );
    await expect.element(dialog()).not.toBeInTheDocument();
    await page.getByRole("button", { name: "Close fixture project picker" }).click();
    await expect
      .element(page.getByRole("heading", { name: "Choose a place to work" }))
      .toBeVisible();
    fixture.shell.projectIds = ["added-project"];
    await update();
    await expect.element(page.getByText("Your project is ready.")).toBeVisible();
    expect(fixture.settings.localOnboardingCompletedEnvironmentIds.includes(fixture.id)).toBe(
      false,
    );
  });

  it("suspends startup while another setup surface is open", async () => {
    useSettingsDialogStore.getState().openSettings("general");
    await mount();
    expect(dialog().elements()).toHaveLength(0);
    await page.getByRole("button", { name: "Close fixture settings" }).click();
    await expect.element(dialog()).toBeVisible();
  });

  it("refreshes only on request, reports failures, and ignores a late result after reconnect", async () => {
    await mount();
    fixture.refresh.mockRejectedValueOnce(new Error("fixture failure"));
    await page.getByRole("button", { name: "Refresh discovery" }).click();
    await expect.element(page.getByRole("alert")).toHaveTextContent("Provider discovery failed");
    let finish!: (value: { providers: readonly ServerProvider[] }) => void;
    fixture.refresh.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await page.getByRole("button", { name: "Refresh discovery" }).click();
    await expect.element(page.getByRole("button", { name: "Checking providers…" })).toBeDisabled();
    fixture.connection.phase = "disconnected";
    await update();
    await expect.element(page.getByRole("button", { name: "Refresh discovery" })).toBeDisabled();
    await expect
      .element(page.getByRole("button", { name: "Provider settings", exact: true }))
      .toBeDisabled();
    finish({ providers: [provider("Stale")] });
    await expect.poll(() => fixture.apply.mock.calls.length).toBe(0);
    fixture.connection = { phase: "connected", connectedAt: "generation-2" };
    await update();
    await page.getByRole("button", { name: "Refresh discovery" }).click();
    await expect.poll(() => fixture.apply.mock.calls.length).toBe(1);
    expect(fixture.refresh).toHaveBeenCalledTimes(3);
  });

  it("keeps controls in the small-laptop viewport and supports keyboard dismissal", async () => {
    await page.viewport(1024, 640);
    fixture.config = {
      providers: Array.from({ length: 12 }, (_, index) => provider(`Provider ${index}`)),
    };
    await mount();
    await expect.element(dialog()).toBeVisible();
    const footer = page
      .getByRole("button", { name: "Continue", exact: true })
      .element()
      .getBoundingClientRect();
    expect(footer.bottom).toBeLessThanOrEqual(640);
    expect(footer.left).toBeGreaterThanOrEqual(0);
    await userEvent.keyboard("{Escape}");
    await expect.element(dialog()).not.toBeInTheDocument();
    expect(fixture.settings.localOnboardingCompletedEnvironmentIds.includes(fixture.id)).toBe(true);
  });
});
