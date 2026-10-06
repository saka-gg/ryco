import "../../../../index.css";

import {
  blankScheduleDraft,
  useAgentControlStore,
  type ScheduleDraft,
} from "@ryco/client-runtime/state/agentControl";
import type {
  AgentControlAutomationDefinition,
  AutomationCentreSnapshot,
  ProviderInstanceId,
} from "@ryco/contracts";
import { DAY_MS, HOUR_MS, MINUTE_MS, intervalLabel } from "@ryco/shared/automationSchedule";
import { page, userEvent } from "vite-plus/test/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { useSyncExternalStore } from "react";
import { render } from "vitest-browser-react";

const hooks = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  let version = 0;
  return {
    /** Runs after a recorded command, before it resolves (a test's server). */
    afterCommand: null as
      | null
      | ((environmentId: string, projectId: string, input: unknown) => void),
    /** What every checkout's centre says went wrong (a refused command's reason). */
    error: null as string | null,
    /** The fixture's snapshots changed: every checkout re-reads, as a live reader would. */
    bump() {
      version += 1;
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    version: () => version,
  };
});

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => vi.fn(async () => undefined),
}));
vi.mock("~/components/automations/useAutomationCentre", async () => {
  const { dialogAutomationCentreMock } =
    await import("~/components/automations/dialog/testing/dialogFixtures");
  return {
    useAutomationCentre(
      ...args: Parameters<typeof dialogAutomationCentreMock.useAutomationCentre>
    ) {
      useSyncExternalStore(hooks.subscribe, hooks.version);
      const state = dialogAutomationCentreMock.useAutomationCentre(...args);
      return {
        ...state,
        error: hooks.error ?? state.error,
        command: async (input: Parameters<typeof state.command>[0]) => {
          const ok = await state.command(input);
          hooks.afterCommand?.(args[0], args[1], input);
          return ok;
        },
      };
    },
  };
});

import { projectCheckoutKey } from "../../../../projectCheckouts.logic";
import { runtimeModeConfig, runtimeModeOptions } from "../../../chat/sessionPolicyPresentation";
import { AppAtomRegistryProvider } from "../../../../rpc/atomRegistry";
import {
  HUB_LOCAL,
  LOCAL_ENV,
  RYCO_LOCAL,
  SCRATCH_LOCAL,
  resetProjectsFixtureState,
  seedProjectsFixtureStore,
} from "../../../projects/testing/projectFixtures";
import { toastManager } from "../../../ui/toast";
import {
  openAutomationsDialog,
  resetAutomationsDialogStoreForTests,
  useAutomationsDialogStore,
} from "../../automationsDialogStore";
import { resetDismissedLapsedProposalsForTests } from "../../data/useLapsedScheduleProposals";
import { AutomationsDialog } from "../AutomationsDialog";
import type { ScheduleEditorSlotProps } from "../editorContract";
import {
  dialogCentreFixture,
  fixtureCreateProposal,
  fullSnapshot,
  hubSnapshot,
  lapsedCreateProposal,
} from "../testing/dialogFixtures";
import { ScheduleEditor } from "./ScheduleEditor";

async function renderDialog(props: Parameters<typeof AutomationsDialog>[0] = {}) {
  await page.viewport(1340, 820);
  return render(
    <AppAtomRegistryProvider>
      <AutomationsDialog {...props} />
    </AppAtomRegistryProvider>,
  );
}

const openRyco = () => openAutomationsDialog({ environmentId: LOCAL_ENV, projectId: RYCO_LOCAL });

const selectedRowTitle = () =>
  document.querySelector('[data-ad-row][aria-selected="true"] .ad-row-title')?.textContent ?? null;
const detailTitle = () =>
  document.querySelector(".ad-pane:not(.is-leaving) .ad-dtitle")?.textContent ?? null;
const token = (kind: string) =>
  document.querySelector<HTMLElement>(`.ad-pane:not(.is-leaving) [data-tok="${kind}"]`);
const lastCommand = () => dialogCentreFixture.commands.at(-1)?.input;

/** The real editor, started from a draft a test hands it (a restore). */
function editorWithDraft(make: (props: ScheduleEditorSlotProps) => ScheduleDraft) {
  return function DraftEditor(props: ScheduleEditorSlotProps) {
    const draft = make(props);
    return (
      <ScheduleEditor
        {...props}
        source={{
          kind: "restore",
          state: {
            checkoutKey: props.checkouts[0]!.key,
            draft,
            initialKey: "",
            isNew: true,
            dirty: true,
          },
        }}
      />
    );
  };
}

describe("ScheduleEditor", () => {
  beforeEach(() => {
    seedProjectsFixtureStore();
    dialogCentreFixture.reset();
    resetAutomationsDialogStoreForTests();
    hooks.afterCommand = null;
    hooks.error = null;
  });
  afterEach(() => {
    resetProjectsFixtureState();
    resetDismissedLapsedProposalsForTests();
    useAgentControlStore.getState().clearEnvironment(LOCAL_ENV);
    vi.restoreAllMocks();
  });

  it("writes a new schedule as a sentence, saves it for approval and lands on its pending row", async () => {
    hooks.afterCommand = (environmentId, projectId, input) => {
      if (environmentId !== LOCAL_ENV || projectId !== RYCO_LOCAL) return;
      const command = input as {
        kind: string;
        automationId: string;
        definition: AgentControlAutomationDefinition;
      };
      if (command.kind !== "save") return;
      const base = dialogCentreFixture.snapshots.get(projectCheckoutKey(LOCAL_ENV, RYCO_LOCAL));
      if (!base) return;
      dialogCentreFixture.set(LOCAL_ENV, RYCO_LOCAL, {
        ...base,
        proposals: [
          ...base.proposals,
          fixtureCreateProposal({
            id: "proposal-new",
            automationId: command.automationId,
            definition: command.definition,
          }),
        ],
      } as AutomationCentreSnapshot);
      hooks.bump();
    };
    const screen = await renderDialog();
    openRyco();
    const dialog = screen.getByRole("dialog");
    await expect.poll(detailTitle).toBe("Triage new issues");
    await userEvent.keyboard("n");
    const editor = dialog.getByRole("region", { name: "New schedule" });
    await expect.element(editor).toBeVisible();
    // The title takes focus; the sentence reads the lab's defaults.
    await expect.poll(() => document.activeElement?.getAttribute("aria-label")).toBe("Title");
    await expect
      .element(editor.getByRole("button", { name: "Repeat interval: every day" }))
      .toBeVisible();
    await expect
      .element(editor.getByRole("button", { name: /^First run: tomorrow 09:00/ }))
      .toBeVisible();
    await expect.element(editor.getByRole("button", { name: "Ends: for 30 days" })).toBeVisible();
    await expect
      .element(editor.getByRole("button", { name: "Runs in: a new worktree" }))
      .toBeVisible();
    await expect.element(editor.getByText("Nothing runs until you approve it.")).toBeVisible();

    await userEvent.fill(editor.getByRole("textbox", { name: "Title" }), "Weekly digest");
    await userEvent.fill(editor.getByRole("textbox", { name: "Prompt" }), "Summarise the week.");
    await expect.element(editor.getByText("19 / 12,000")).toBeVisible();
    // Every 2 hours, from the interval token's popover; a preset folds it away.
    await userEvent.click(editor.getByRole("button", { name: "Repeat interval: every day" }));
    await page.getByRole("radio", { name: intervalLabel(2 * HOUR_MS) }).click();
    await expect
      .element(editor.getByRole("button", { name: "Repeat interval: every 2 hours" }))
      .toBeVisible();
    await expect.poll(() => document.querySelector('[data-ae-pop$=":interval"]')).toBeNull();
    // ⌘↵ saves for approval.
    (editor.getByRole("textbox", { name: "Prompt" }).element() as HTMLElement).focus();
    await userEvent.keyboard("{Control>}{Enter}{/Control}");

    await expect.poll(() => dialogCentreFixture.commands.length).toBe(1);
    expect(dialogCentreFixture.commands[0]!.environmentId).toBe(LOCAL_ENV);
    expect(lastCommand()).toMatchObject({
      kind: "save",
      projectId: RYCO_LOCAL,
      expectedRevision: null,
      definition: {
        enabled: true,
        execution: {
          title: "Weekly digest",
          prompt: "Summarise the week.",
          envMode: "worktree",
          baseRef: "main",
          runtimeMode: "auto-accept-edits",
          modelSelection: { instanceId: "claude", model: "claude-sonnet-5-5" },
        },
        schedule: { kind: "fixed-interval", intervalMs: 2 * HOUR_MS },
      },
    });
    // The editor folds into the row, which says what waits, and takes focus.
    await expect.poll(selectedRowTitle).toBe("Weekly digest");
    await expect
      .element(dialog.getByRole("region", { name: "New schedule waiting for your approval" }))
      .toBeVisible();
    await expect
      .poll(() => document.activeElement?.querySelector(".ad-row-title")?.textContent)
      .toBe("Weekly digest");
  });

  it("refuses a save with what's missing, focusing the first field, and fixes it in one click", async () => {
    const screen = await renderDialog({
      editorComponent: editorWithDraft((props) => {
        const start = Math.floor(props.nowMs / MINUTE_MS) * MINUTE_MS - 2 * HOUR_MS;
        return {
          ...blankScheduleDraft({
            projectId: RYCO_LOCAL,
            nowMs: props.nowMs,
            modelSelection: {
              instanceId: "claude" as ProviderInstanceId,
              model: "claude-sonnet-5-5",
            },
          }),
          start,
          intervalMs: 5 * MINUTE_MS,
          endsAt: start - DAY_MS,
        };
      }),
    });
    openRyco();
    const dialog = screen.getByRole("dialog");
    await expect.poll(detailTitle).toBe("Triage new issues");
    await userEvent.keyboard("n");
    const editor = dialog.getByRole("region", { name: "New schedule" });
    await expect.element(editor.getByText("Starts in the past.")).toBeVisible();
    await expect.element(editor.getByText("Under the 15-minute minimum.")).toBeVisible();
    await expect.element(editor.getByText("Ends before the first run.")).toBeVisible();
    // The tokens point at their message.
    expect(token("interval")?.hasAttribute("data-invalid")).toBe(true);
    expect(token("interval")?.getAttribute("aria-describedby")).toBeTruthy();

    // Save: nothing is proposed; focus goes to the first field (the title).
    await editor.getByRole("button", { name: /Save for approval/ }).click();
    expect(dialogCentreFixture.commands).toEqual([]);
    await expect.element(editor.getByText("Give it a short title.")).toBeVisible();
    await expect.element(editor.getByText("Tell the agent what to do on each run.")).toBeVisible();
    await expect.poll(() => document.activeElement?.getAttribute("aria-label")).toBe("Title");

    await editor.getByRole("button", { name: "Use 15 minutes" }).click();
    await expect.element(editor.getByText("Under the 15-minute minimum.")).not.toBeInTheDocument();
    expect(token("interval")?.textContent).toBe("15 minutes");
    expect(document.activeElement).toBe(token("interval"));
    await editor.getByRole("button", { name: /^Use / }).click();
    await expect.element(editor.getByText("Starts in the past.")).not.toBeInTheDocument();
    await editor.getByRole("button", { name: /^End / }).click();
    await expect.element(editor.getByText("Ends before the first run.")).not.toBeInTheDocument();

    await userEvent.fill(editor.getByRole("textbox", { name: "Title" }), "Watch CI");
    await userEvent.fill(editor.getByRole("textbox", { name: "Prompt" }), "Look for flakes.");
    await editor.getByRole("button", { name: /Save for approval/ }).click();
    await expect.poll(() => dialogCentreFixture.commands.length).toBe(1);
    expect(lastCommand()).toMatchObject({
      kind: "save",
      definition: { schedule: { kind: "fixed-interval", intervalMs: 15 * MINUTE_MS } },
    });
  });

  it("asks once before Escape throws a draft away; keep editing, then discard and restore with ⌘Z", async () => {
    const screen = await renderDialog();
    openRyco();
    const dialog = screen.getByRole("dialog");
    await expect.poll(detailTitle).toBe("Triage new issues");
    await userEvent.keyboard("n");
    const title = dialog.getByRole("textbox", { name: "Title" });
    await userEvent.fill(title, "Weekly digest");
    await userEvent.keyboard("{Escape}");
    await expect
      .element(dialog.getByText("Unsaved changes. Press Esc again to discard them, or"))
      .toBeVisible();
    await dialog.getByRole("button", { name: "keep editing" }).click();
    await expect.element(dialog.getByText("Nothing runs until you approve it.")).toBeVisible();
    await expect.poll(() => document.activeElement?.getAttribute("aria-label")).toBe("Title");

    await userEvent.keyboard("{Escape}");
    await userEvent.keyboard("{Escape}");
    await expect.element(dialog.getByText("Draft discarded.")).toBeVisible();
    expect(useAutomationsDialogStore.getState().open).toBe(true);
    // ⌘Z brings it back, as it was.
    await expect.poll(detailTitle).toBe("Triage new issues");
    await userEvent.keyboard("{Control>}z{/Control}");
    await expect
      .element(dialog.getByRole("textbox", { name: "Title" }))
      .toHaveValue("Weekly digest");
  });

  it("opens tokens from the keyboard: a letter on the time types into it, ↵ sets it", async () => {
    const screen = await renderDialog();
    openRyco();
    const dialog = screen.getByRole("dialog");
    await expect.poll(detailTitle).toBe("Triage new issues");
    await userEvent.keyboard("n");
    await expect.element(dialog.getByRole("region", { name: "New schedule" })).toBeVisible();
    // ↵ on the title moves to the first token.
    await userEvent.keyboard("{Enter}");
    expect(document.activeElement).toBe(token("interval"));
    await userEvent.keyboard("{Tab}");
    expect(document.activeElement).toBe(token("start"));
    await userEvent.keyboard("t");
    const input = page.getByRole("combobox", { name: "First run" });
    await expect.element(input).toHaveValue("t");
    await userEvent.keyboard("omorrow 10");
    await userEvent.keyboard("{Enter}");
    await expect.poll(() => token("start")?.textContent).toBe("tomorrow 10:00");
    await expect.poll(() => document.querySelector('[data-ae-pop$=":start"]')).toBeNull();
    await expect.poll(() => document.activeElement).toBe(token("start"));

    // ↓ opens a menu; the main checkout drops "off main" from the sentence.
    (token("env") as HTMLElement).focus();
    await userEvent.keyboard("{ArrowDown}");
    await page.getByRole("menuitemradio", { name: "the main checkout" }).click();
    await expect.poll(() => token("env")?.textContent).toBe("the main checkout");
    expect(document.querySelector<HTMLElement>('[data-m="worktree"]')?.hidden).toBe(true);
    // Once: the interval and the end leave the sentence.
    await dialog.getByRole("radio", { name: "Once" }).click();
    expect(document.querySelector<HTMLElement>('[data-m="repeat"]')?.hidden).toBe(true);
    await expect.element(dialog.getByText("Once,")).toBeVisible();
  });

  it("opens on the model when the model is gone, and says why", async () => {
    const screen = await renderDialog();
    openRyco();
    const dialog = screen.getByRole("dialog");
    await dialog.getByRole("option", { name: /Nightly e2e suite/ }).click();
    await expect.poll(detailTitle).toBe("Nightly e2e suite");
    await dialog.getByRole("button", { name: "Edit model to resume" }).click();
    const editor = dialog.getByRole("region", { name: "Edit Nightly e2e suite" });
    await expect.element(editor).toBeVisible();
    await expect.poll(() => document.activeElement).toBe(token("model"));
    expect(token("model")?.hasAttribute("data-invalid")).toBe(true);
    await expect
      .element(editor.getByText(/claude-opus-4 isn't available on Claude any more/))
      .toBeVisible();
    // A screen reader hears why, on the pick itself.
    expect(token("model")?.getAttribute("aria-invalid")).toBe("true");
    const describedBy = token("model")?.getAttribute("aria-describedby") ?? "";
    expect(document.getElementById(describedBy)?.textContent).toMatch(/isn't available/);
    // The device a schedule runs on is plain text while editing it.
    expect(token("device")).toBeNull();
    await expect.element(editor.getByText("Studio", { exact: true })).toBeVisible();
  });

  it("widens the first run's popover as its calendar opens, and keeps it inside the dialog", async () => {
    const screen = await renderDialog();
    openRyco();
    const dialog = screen.getByRole("dialog");
    await expect.poll(detailTitle).toBe("Triage new issues");
    await userEvent.keyboard("n");
    await expect.element(dialog.getByRole("region", { name: "New schedule" })).toBeVisible();
    await userEvent.click(token("start")!);
    const popup = () => document.querySelector<HTMLElement>('[data-ae-pop$=":start"]');
    await expect.poll(popup).not.toBeNull();
    await page.getByRole("button", { name: "Open calendar" }).click();
    await expect.element(page.getByRole("listbox", { name: "Times" })).toBeVisible();
    const inside = (outer: DOMRect, inner: DOMRect) =>
      inner.left >= outer.left - 0.5 &&
      inner.right <= outer.right + 0.5 &&
      inner.top >= outer.top - 0.5 &&
      inner.bottom <= outer.bottom + 0.5;
    await expect
      .poll(() => {
        const pop = popup();
        const calendar = document.querySelector('[aria-label="Open calendar"]');
        const times = document.querySelector('[role="listbox"][aria-label="Times"]');
        const quick = document.querySelector('[aria-label="Quick picks"]');
        const frame = document.querySelector(".ad-dialog");
        if (!pop || !calendar || !times || !quick || !frame) return "missing";
        const box = pop.getBoundingClientRect();
        const viewport = pop.querySelector<HTMLElement>('[data-slot="popover-viewport"]');
        return [
          inside(box, calendar.getBoundingClientRect()),
          inside(box, times.getBoundingClientRect()),
          inside(box, quick.getBoundingClientRect()),
          inside(frame.getBoundingClientRect(), box),
          (viewport?.scrollWidth ?? 0) <= (viewport?.clientWidth ?? 0),
        ];
      })
      .toEqual([true, true, true, true, true]);
  });

  it("opens a token menu on the current choice, so ↑/↓ move from it", async () => {
    const screen = await renderDialog();
    openRyco();
    const dialog = screen.getByRole("dialog");
    await expect.poll(detailTitle).toBe("Triage new issues");
    await userEvent.keyboard("n");
    await expect.element(dialog.getByRole("region", { name: "New schedule" })).toBeVisible();
    const current = runtimeModeConfig["auto-accept-edits"].label;
    const next = runtimeModeOptions[runtimeModeOptions.indexOf("auto-accept-edits") + 1]!;
    const focused = () => document.activeElement?.getAttribute("aria-label");
    // From the keyboard…
    (token("mode") as HTMLElement).focus();
    await userEvent.keyboard("{Enter}");
    await expect.poll(focused).toBe(current);
    expect(document.activeElement?.hasAttribute("data-highlighted")).toBe(true);
    await userEvent.keyboard("{ArrowDown}");
    await expect.poll(focused).toBe(runtimeModeConfig[next].label);
    await userEvent.keyboard("{Escape}");
    await expect.poll(() => document.querySelector('[data-ae-pop$=":mode"]')).toBeNull();
    // …and from the pointer.
    await userEvent.click(token("mode")!);
    await expect.poll(focused).toBe(current);
    await userEvent.keyboard("{ArrowDown}");
    await expect.poll(focused).toBe(runtimeModeConfig[next].label);
  });

  it("says why the device refused a save, on the field it is about, until the draft changes", async () => {
    dialogCentreFixture.commandResult = false;
    hooks.afterCommand = () => {
      hooks.error = "Requested worktree base ref is unavailable.";
      hooks.bump();
    };
    const toast = vi.spyOn(toastManager, "add");
    const screen = await renderDialog();
    openRyco();
    const dialog = screen.getByRole("dialog");
    await expect.poll(detailTitle).toBe("Triage new issues");
    await userEvent.keyboard("n");
    const editor = dialog.getByRole("region", { name: "New schedule" });
    await userEvent.fill(editor.getByRole("textbox", { name: "Title" }), "Weekly digest");
    await userEvent.fill(editor.getByRole("textbox", { name: "Prompt" }), "Summarise the week.");
    await editor.getByRole("button", { name: /Save for approval/ }).click();
    await expect
      .element(editor.getByText("Requested worktree base ref is unavailable."))
      .toBeVisible();
    expect(toast.mock.calls.map(([options]) => options.title)).toContain(
      "That change couldn't be proposed.",
    );
    // The branch token points at it.
    expect(token("ref")?.hasAttribute("data-invalid")).toBe(true);
    const describedBy = token("ref")?.getAttribute("aria-describedby") ?? "";
    expect(document.getElementById(describedBy)?.textContent).toContain("base ref");
    // A change to the draft clears it.
    await userEvent.fill(editor.getByRole("textbox", { name: "Title" }), "Weekly digest 2");
    await expect
      .element(editor.getByText("Requested worktree base ref is unavailable."))
      .not.toBeInTheDocument();
    await expect.element(editor.getByText("Nothing runs until you approve it.")).toBeVisible();
  });

  it("closes without proposing when nothing changed, and says so", async () => {
    const toast = vi.spyOn(toastManager, "add");
    const screen = await renderDialog();
    openRyco();
    const dialog = screen.getByRole("dialog");
    await expect.poll(detailTitle).toBe("Triage new issues");
    await userEvent.keyboard("e");
    await expect
      .element(dialog.getByRole("region", { name: "Edit Triage new issues" }))
      .toBeVisible();
    await expect.element(dialog.getByText("Nothing changes until you approve it.")).toBeVisible();
    await userEvent.keyboard("{Control>}{Enter}{/Control}");
    await expect.poll(detailTitle).toBe("Triage new issues");
    expect(dialogCentreFixture.commands).toEqual([]);
    expect(toast.mock.calls.map(([options]) => options.title)).toContain(
      "Nothing changed, so nothing was proposed.",
    );
  });

  it("proposes an expired new schedule again from its own draft", async () => {
    useAgentControlStore.getState().applyStreamEvent(LOCAL_ENV, {
      version: 1,
      type: "snapshot",
      queue: { revision: 1, active: [], recent: [lapsedCreateProposal(SCRATCH_LOCAL)] },
    });
    const screen = await renderDialog();
    openAutomationsDialog({ environmentId: LOCAL_ENV, projectId: SCRATCH_LOCAL });
    const dialog = screen.getByRole("dialog");
    await expect.poll(selectedRowTitle).toBe("Weekly cleanup");
    await dialog.getByRole("button", { name: "Propose again" }).click();
    const editor = dialog.getByRole("region", { name: "New schedule" });
    await expect
      .element(editor.getByRole("textbox", { name: "Title" }))
      .toHaveValue("Weekly cleanup");
    // Unchanged, it is still worth proposing again.
    await editor.getByRole("button", { name: /Save for approval/ }).click();
    await expect.poll(() => dialogCentreFixture.commands.length).toBe(1);
    expect(lastCommand()).toMatchObject({
      kind: "save",
      projectId: SCRATCH_LOCAL,
      automationId: "auto-cleanup",
      expectedRevision: null,
    });
  });

  it("says the limit in the footer and keeps Save off at it", async () => {
    const full = fullSnapshot(HUB_LOCAL);
    const rotate = hubSnapshot().proposals.filter(
      (proposal) => proposal.plan.kind === "createAutomation",
    );
    dialogCentreFixture.set(LOCAL_ENV, HUB_LOCAL, { ...full, proposals: rotate });
    const screen = await renderDialog();
    openAutomationsDialog({ environmentId: LOCAL_ENV, projectId: HUB_LOCAL });
    const dialog = screen.getByRole("dialog");
    await dialog.getByRole("option", { name: /Rotate staging relay keys/ }).click();
    await expect.poll(detailTitle).toBe("Rotate staging relay keys");
    await userEvent.keyboard("e");
    // A proposed schedule is still new: nothing of it runs yet.
    const editor = dialog.getByRole("region", { name: "New schedule" });
    await expect
      .element(editor.getByRole("textbox", { name: "Title" }))
      .toHaveValue("Rotate staging relay keys");
    await expect
      .element(editor.getByText(/already has 25 active schedules, the most a project can have/))
      .toBeVisible();
    await expect.element(editor.getByRole("button", { name: /Save for approval/ })).toBeDisabled();
  });
});
