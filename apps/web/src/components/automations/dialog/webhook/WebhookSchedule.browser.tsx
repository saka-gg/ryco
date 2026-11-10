import "../../../../index.css";
// The feature stylesheet loads with its page or dialog chunk in the app.
import "../../styles/automations.css";

import { useAgentControlStore } from "@ryco/client-runtime/state/agentControl";
import type {
  AgentControlAutomation,
  AutomationCentreSnapshot,
  AutomationHookInput,
  AutomationHookView,
  EnvironmentApi,
} from "@ryco/contracts";
import { page, userEvent } from "vite-plus/test/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => vi.fn(async () => undefined),
}));
vi.mock(
  "~/components/automations/useAutomationCentre",
  async () =>
    (await import("~/components/automations/dialog/testing/dialogFixtures"))
      .dialogAutomationCentreMock,
);

import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "../../../../environmentApi";
import { AppAtomRegistryProvider } from "../../../../rpc/atomRegistry";
import {
  LOCAL_ENV,
  RYCO_LOCAL,
  resetProjectsFixtureState,
  seedProjectsFixtureStore,
} from "../../../projects/testing/projectFixtures";
import {
  openAutomationsDialog,
  resetAutomationsDialogStoreForTests,
} from "../../automationsDialogStore";
import { resetDismissedLapsedProposalsForTests } from "../../data/useLapsedScheduleProposals";
import { AutomationsDialog } from "../AutomationsDialog";
import { dialogCentreFixture, fixtureSchedule, rycoLocalSnapshot } from "../testing/dialogFixtures";

async function renderDialog() {
  await page.viewport(1340, 820);
  return render(
    <AppAtomRegistryProvider>
      <AutomationsDialog />
    </AppAtomRegistryProvider>,
  );
}

const openRyco = () => openAutomationsDialog({ environmentId: LOCAL_ENV, projectId: RYCO_LOCAL });
const detailTitle = () =>
  document.querySelector(".ad-pane:not(.is-leaving) .ad-dtitle")?.textContent ?? null;
const lastCommand = () => dialogCentreFixture.commands.at(-1)?.input;

/** ryco on this device, which takes webhook triggers; optionally with a webhook schedule. */
function webhookSnapshot(options: { readonly withHook: boolean }): AutomationCentreSnapshot {
  const base = rycoLocalSnapshot();
  if (!options.withHook) return { ...base, webhooks: true };
  const timed = fixtureSchedule({
    id: "auto-hook",
    title: "Release notes",
    projectId: RYCO_LOCAL,
    nextInMinutes: 60,
    envMode: "worktree",
    prompt: "Write the release notes for the version in the request.",
  });
  const hooked = {
    ...timed,
    definition: { ...timed.definition, schedule: { kind: "webhook" } },
    nextRunAt: null,
  } as unknown as AgentControlAutomation;
  return { ...base, webhooks: true, automations: [...base.automations, hooked] };
}

function hookView(secret: string): AutomationHookView {
  return {
    automationId: "auto-hook",
    hookId: "hook-1",
    secret,
    directPath: "/api/automation-hooks/hook-1",
    cloudUrl: "https://hub.example/hooks/hook-1",
    cloudState: "registered",
    createdAt: "2026-11-01T09:00:00.000Z",
    secretUpdatedAt: "2026-11-01T09:00:00.000Z",
    lastRequest: {
      at: new Date(Date.now() - 5 * 60_000).toISOString(),
      via: "cloud",
      outcome: "started",
    },
  } as AutomationHookView;
}

describe("webhook schedules", () => {
  beforeEach(() => {
    seedProjectsFixtureStore();
    dialogCentreFixture.reset();
    resetAutomationsDialogStoreForTests();
  });
  afterEach(() => {
    resetProjectsFixtureState();
    resetDismissedLapsedProposalsForTests();
    __resetEnvironmentApiOverridesForTests();
    useAgentControlStore.getState().clearEnvironment(LOCAL_ENV);
    vi.restoreAllMocks();
  });

  it("offers the webhook trigger where the device takes it, hides the times and saves it", async () => {
    const screen = await renderDialog();
    openRyco();
    const dialog = screen.getByRole("dialog");
    await expect.poll(detailTitle).toBe("Triage new issues");
    await userEvent.keyboard("n");
    const editor = dialog.getByRole("region", { name: "New schedule" });
    await expect.element(editor).toBeVisible();
    // An older device refuses a webhook trigger: it is not offered.
    await expect
      .element(editor.getByRole("radio", { name: "When its webhook is called" }))
      .not.toBeInTheDocument();
    dialogCentreFixture.update(LOCAL_ENV, RYCO_LOCAL, webhookSnapshot({ withHook: false }));
    const webhook = editor.getByRole("radio", { name: "When its webhook is called" });
    await expect.element(webhook).toBeVisible();

    await userEvent.fill(editor.getByRole("textbox", { name: "Title" }), "Release notes");
    await userEvent.fill(editor.getByRole("textbox", { name: "Prompt" }), "Write the notes.");
    await webhook.click();
    await expect.element(webhook).toHaveAttribute("aria-checked", "true");
    await expect.element(editor.getByText("When its webhook is called, it runs")).toBeVisible();
    await expect
      .element(editor.getByRole("button", { name: /^First run:/ }))
      .not.toBeInTheDocument();
    await expect
      .element(editor.getByRole("button", { name: /^Repeat interval:/ }))
      .not.toBeInTheDocument();
    await expect
      .element(
        editor.getByText(/Each call starts one run, with the request body as untrusted input/),
      )
      .toBeVisible();
    await expect.element(editor.getByText("Next runs")).not.toBeInTheDocument();

    // Back to times: the draft kept them.
    await editor.getByRole("radio", { name: /Repeats/ }).click();
    await expect
      .element(editor.getByRole("button", { name: /^First run: tomorrow 09:00/ }))
      .toBeVisible();
    await expect.element(editor.getByText("Next runs")).toBeVisible();
    await webhook.click();

    await editor.getByRole("button", { name: /Save for approval/ }).click();
    await expect.poll(() => dialogCentreFixture.commands.length).toBe(1);
    expect(lastCommand()).toMatchObject({
      kind: "save",
      projectId: RYCO_LOCAL,
      expectedRevision: null,
      definition: { execution: { title: "Release notes", prompt: "Write the notes." } },
    });
    expect((lastCommand() as { definition: { schedule: unknown } }).definition.schedule).toEqual({
      kind: "webhook",
    });
  });

  it("shows a webhook schedule's hook and regenerates its secret after confirming", async () => {
    dialogCentreFixture.set(LOCAL_ENV, RYCO_LOCAL, webhookSnapshot({ withHook: true }));
    let secret = "first-secret-value";
    const hook = vi.fn(async (input: AutomationHookInput) => {
      if (input.action === "regenerate") secret = "second-secret-value";
      return hookView(secret);
    });
    __setEnvironmentApiOverrideForTests(LOCAL_ENV, {
      automationCentre: {
        snapshot: async () => dialogCentreFixture.snapshots.values().next().value,
        command: async () => dialogCentreFixture.snapshots.values().next().value,
        hook,
      },
    } as unknown as EnvironmentApi);

    const screen = await renderDialog();
    openRyco();
    const dialog = screen.getByRole("dialog");
    await expect.poll(detailTitle).toBe("Triage new issues");
    await dialog.getByRole("option", { name: /Release notes/ }).click();
    await expect.poll(detailTitle).toBe("Release notes");
    await expect.element(dialog.getByText("Runs when its webhook is called.")).toBeVisible();
    // It takes requests until paused.
    await expect.element(dialog.getByRole("button", { name: "Pause" })).toBeVisible();

    const panel = dialog.getByRole("region", { name: "Webhook" });
    await expect.element(panel.getByText("https://hub.example/hooks/hook-1").first()).toBeVisible();
    await expect.element(panel.getByText(/\/api\/automation-hooks\/hook-1$/).first()).toBeVisible();
    await expect.element(panel.getByText("started a run")).toBeVisible();
    await expect.element(panel.getByText("through the Hub", { exact: false })).toBeVisible();
    expect(hook).toHaveBeenCalledWith({
      projectId: RYCO_LOCAL,
      automationId: "auto-hook",
      action: "read",
    });
    // The secret is hidden until asked for, and never part of a snippet.
    expect(panel.element().textContent).not.toContain("first-secret-value");
    await panel.getByText("Test it with curl").click();
    const curl = panel.element().querySelector('[data-snippet="curl"] pre');
    await expect.poll(() => curl?.checkVisibility()).toBe(true);
    expect(curl?.textContent).toContain(`-hmac "$RYCO_HOOK_SECRET"`);
    expect(curl?.textContent).toContain("https://hub.example/hooks/hook-1");
    expect(panel.element().textContent).not.toContain("first-secret-value");
    await panel.getByRole("button", { name: "Show the secret" }).click();
    await expect.element(panel.getByText("first-secret-value")).toBeVisible();

    await panel.getByRole("button", { name: "Regenerate" }).click();
    const confirm = panel.getByRole("group", { name: /Regenerate the secret\?/ });
    await expect.element(confirm.getByText(/The old secret stops working at once/)).toBeVisible();
    // Keeping it changes nothing, and focus goes back to Regenerate.
    await expect.element(confirm.getByRole("button", { name: "Keep it" })).toHaveFocus();
    await confirm.getByRole("button", { name: "Keep it" }).click();
    await expect.element(confirm).not.toBeInTheDocument();
    await expect.element(panel.getByRole("button", { name: "Regenerate" })).toHaveFocus();
    expect(hook).not.toHaveBeenCalledWith(expect.objectContaining({ action: "regenerate" }));

    await panel.getByRole("button", { name: "Regenerate" }).click();
    await confirm.getByRole("button", { name: "Regenerate secret" }).click();
    await expect.element(panel.getByText("second-secret-value")).toBeVisible();
    expect(hook).toHaveBeenCalledWith({
      projectId: RYCO_LOCAL,
      automationId: "auto-hook",
      action: "regenerate",
    });
    // The Automations dialog stays open.
    await expect.element(dialog.getByRole("region", { name: "Webhook" })).toBeVisible();
  });
  it("says why a hook could not be read, inline", async () => {
    dialogCentreFixture.set(LOCAL_ENV, RYCO_LOCAL, webhookSnapshot({ withHook: true }));
    __setEnvironmentApiOverrideForTests(LOCAL_ENV, {
      automationCentre: {
        snapshot: async () => dialogCentreFixture.snapshots.values().next().value,
        command: async () => dialogCentreFixture.snapshots.values().next().value,
        hook: async () => {
          throw new Error("The webhook's secret is unavailable.");
        },
      },
    } as unknown as EnvironmentApi);
    const screen = await renderDialog();
    openRyco();
    const dialog = screen.getByRole("dialog");
    await expect.poll(detailTitle).toBe("Triage new issues");
    await dialog.getByRole("option", { name: /Release notes/ }).click();
    const panel = dialog.getByRole("region", { name: "Webhook" });
    await expect.element(panel.getByRole("alert")).toBeVisible();
    await expect.element(panel.getByText("The webhook's secret is unavailable.")).toBeVisible();
    await expect.element(panel.getByRole("button", { name: "Try again" })).toBeVisible();
  });
});
