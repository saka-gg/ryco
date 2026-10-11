import "../../../index.css";

import { ProviderInstanceId, type AgentControlAutomationId } from "@ryco/contracts";
import { blankScheduleDraft, useAgentControlStore } from "@ryco/client-runtime/state/agentControl";
import { page, userEvent } from "vite-plus/test/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

const navigate = vi.fn(async () => undefined);
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => navigate,
}));
vi.mock(
  "~/components/automations/useAutomationCentre",
  async () =>
    (await import("~/components/automations/dialog/testing/dialogFixtures"))
      .dialogAutomationCentreMock,
);

import { projectCheckoutKey } from "../../../projectCheckouts.logic";
import { AppAtomRegistryProvider } from "../../../rpc/atomRegistry";
import {
  HUB_LOCAL,
  LOCAL_ENV,
  RYCO_LOCAL,
  SCRATCH_LOCAL,
  RYCO_STUDIO,
  STUDIO_ENV,
  resetProjectsFixtureState,
  seedProjectsFixtureStore,
} from "../../projects/testing/projectFixtures";
import { toastManager } from "../../ui/toast";
import {
  openAutomationsDialog,
  resetAutomationsDialogStoreForTests,
  useAutomationsDialogStore,
} from "../automationsDialogStore";
import { resetDismissedLapsedProposalsForTests } from "../data/useLapsedScheduleProposals";
import { AutomationsDialog } from "./AutomationsDialog";
import type { ScheduleEditorSlotProps } from "./editorContract";
import {
  dialogCentreFixture,
  fullSnapshot,
  hubSnapshot,
  lapsedCreateProposal,
  queuedProposal,
  rycoLocalSnapshot,
  withRunDecided,
} from "./testing/dialogFixtures";

async function renderDialog(props: Parameters<typeof AutomationsDialog>[0] = {}) {
  await page.viewport(1340, 820);
  return render(
    <AppAtomRegistryProvider>
      {/* What a map card does: open straight into a schedule's editor. */}
      <button
        type="button"
        onClick={(event) =>
          openAutomationsDialog({
            environmentId: LOCAL_ENV,
            projectId: RYCO_LOCAL,
            automationId: "auto-changelog" as AgentControlAutomationId,
            mode: "edit",
            origin: event.currentTarget,
          })
        }
      >
        Edit from the map
      </button>
      <AutomationsDialog {...props} />
    </AppAtomRegistryProvider>,
  );
}

/** The device's Agent Control queue says this about the proposal. */
function queueSays(proposal: ReturnType<typeof queuedProposal>) {
  useAgentControlStore.getState().applyStreamEvent(LOCAL_ENV, {
    version: 1,
    type: "snapshot",
    queue: { revision: 1, active: [], recent: [proposal] },
  });
}

const openRyco = () => openAutomationsDialog({ environmentId: LOCAL_ENV, projectId: RYCO_LOCAL });

function selectedRowTitle(): string | null {
  return (
    document.querySelector('[data-ad-row][aria-selected="true"] .ad-row-title')?.textContent ?? null
  );
}

function detailTitle(): string | null {
  return document.querySelector(".ad-pane:not(.is-leaving) .ad-dtitle")?.textContent ?? null;
}

/**
 * A stand-in editor with a real dirty state: typing in its title reports a
 * dirty draft, Save reports a saved schedule.
 */
function DirtyEditor(props: ScheduleEditorSlotProps) {
  const checkoutKey = props.checkouts[0]?.key ?? "";
  const draft = blankScheduleDraft({
    projectId: props.checkouts[0]?.projectId ?? RYCO_LOCAL,
    nowMs: props.nowMs,
    modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "claude-sonnet-5-5" },
  });
  return (
    <div className="ad-ed-scroll">
      <input
        aria-label="Title"
        defaultValue={props.source.kind === "restore" ? props.source.state.draft.title : ""}
        onChange={(event) =>
          props.onDirtyChange(true, {
            checkoutKey,
            draft: { ...draft, title: event.target.value },
            initialKey: "",
            isNew: true,
            dirty: true,
          })
        }
      />
      <p data-testid="editor-source">{props.source.kind}</p>
      <p data-testid="editor-device">
        {props.source.kind === "new" ? (props.source.checkoutKey ?? "none") : ""}
      </p>
      <p data-testid="editor-confirm">{props.confirm ?? "none"}</p>
      <button type="button" onClick={() => props.onClose("discard")}>
        Discard draft
      </button>
      <button
        type="button"
        onClick={() =>
          props.onSaved({
            checkoutKey: projectCheckoutKey(LOCAL_ENV, RYCO_LOCAL),
            automationId: "auto-changelog" as AgentControlAutomationId,
            fromRect: null,
          })
        }
      >
        Save draft
      </button>
    </div>
  );
}

describe("AutomationsDialog", () => {
  beforeEach(() => {
    seedProjectsFixtureStore();
    dialogCentreFixture.reset();
    resetAutomationsDialogStoreForTests();
    navigate.mockClear();
  });
  afterEach(() => {
    resetProjectsFixtureState();
    resetDismissedLapsedProposalsForTests();
    useAgentControlStore.getState().clearEnvironment(LOCAL_ENV);
    vi.restoreAllMocks();
  });

  it("opens on the waiting run, grouped by device, and approves it", async () => {
    const screen = await renderDialog();
    openRyco();
    const dialog = screen.getByRole("dialog");
    await expect.element(dialog.getByRole("heading", { name: "Triage new issues" })).toBeVisible();
    expect(selectedRowTitle()).toBe("Triage new issues");
    await expect
      .poll(() => document.activeElement?.getAttribute("data-ad-row"))
      .toContain("auto-triage");
    const list = dialog.getByRole("listbox", { name: /Schedules in/ });
    await expect.element(list.getByText("This device")).toBeVisible();
    await expect.element(list.getByText("Studio")).toBeVisible();
    await expect.element(dialog.getByText("Runs every 2 hours", { exact: false })).toBeVisible();
    await expect.element(dialog.getByText("Approving starts one thread now.")).toBeVisible();
    // The selected schedule's run is its detail's; the header only says the change.
    await expect
      .element(dialog.getByRole("button", { name: "1 change waiting for your approval. Show it" }))
      .toBeVisible();
    await dialog.getByRole("button", { name: "Approve run" }).click();
    expect(dialogCentreFixture.decisions).toEqual([
      { environmentId: LOCAL_ENV, proposalId: "proposal-due", decision: "accept" },
    ]);
  });

  it("moves through schedules with the keyboard, edits with E, and Escape closes the top layer first", async () => {
    const screen = await renderDialog();
    openRyco();
    const dialog = screen.getByRole("dialog");
    await expect.poll(selectedRowTitle).toBe("Triage new issues");
    await expect
      .poll(() => document.activeElement?.getAttribute("data-ad-row"))
      .toContain("auto-triage");
    await userEvent.keyboard("{ArrowDown}");
    await expect.poll(selectedRowTitle).toBe("Update the changelog");
    await expect.poll(detailTitle).toBe("Update the changelog");
    expect(document.activeElement?.getAttribute("aria-selected")).toBe("true");
    await userEvent.keyboard("{End}");
    await expect.poll(selectedRowTitle).toBe("Nightly e2e suite");
    await userEvent.keyboard("{Home}");
    await expect.poll(selectedRowTitle).toBe("Draft 0.14 release notes");

    await userEvent.keyboard("e");
    await expect
      .element(dialog.getByRole("region", { name: "Edit Draft 0.14 release notes" }))
      .toBeVisible();
    expect(document.querySelector(".ad-list")?.hasAttribute("inert")).toBe(true);
    // A clean draft: the first Escape closes the editor, not the dialog.
    await userEvent.keyboard("{Escape}");
    await expect.poll(detailTitle).toBe("Draft 0.14 release notes");
    expect(useAutomationsDialogStore.getState().open).toBe(true);
    await userEvent.keyboard("{Escape}");
    await expect.poll(() => useAutomationsDialogStore.getState().open).toBe(false);
  });

  it("selects what the header says is waiting and approves the proposed change", async () => {
    const screen = await renderDialog();
    openRyco();
    const dialog = screen.getByRole("dialog");
    await dialog
      .getByRole("button", { name: "1 change waiting for your approval. Show it" })
      .click();
    await expect.poll(detailTitle).toBe("Update the changelog");
    const block = dialog.getByRole("region", { name: "Change waiting for your approval" });
    await expect.element(block.getByText("+ “Skip PRs labelled internal.”")).toBeVisible();
    await expect
      .element(block.getByText("The current schedule keeps running until you approve."))
      .toBeVisible();
    // Now the run is the other schedule's, so the header says it.
    await expect
      .element(dialog.getByRole("button", { name: /Triage new issues: run waiting for approval/ }))
      .toBeVisible();
    await block.getByRole("button", { name: "Approve change" }).click();
    expect(dialogCentreFixture.decisions).toEqual([
      { environmentId: LOCAL_ENV, proposalId: "proposal-change", decision: "accept" },
    ]);
  });

  it("proposes a pause and a cancel for the selected schedule", async () => {
    const screen = await renderDialog();
    openRyco();
    const dialog = screen.getByRole("dialog");
    await expect.poll(detailTitle).toBe("Triage new issues");
    await dialog.getByRole("button", { name: "Pause" }).click();
    await expect.poll(() => dialogCentreFixture.commands.length).toBe(1);
    const pause = dialogCentreFixture.commands[0]!;
    expect(pause.environmentId).toBe(LOCAL_ENV);
    expect(pause.input).toMatchObject({
      kind: "save",
      projectId: RYCO_LOCAL,
      automationId: "auto-triage",
      expectedRevision: 1,
      definition: { enabled: false },
    });
    // The start rolls forward: the backend rejects a past one.
    const definition = pause.input.kind === "save" ? pause.input.definition : null;
    expect(
      definition?.schedule.kind === "fixed-interval" &&
        Date.parse(definition.schedule.startsAt) > Date.now(),
    ).toBe(true);

    await dialog.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitem", { name: "Cancel schedule" }).click();
    await expect.poll(() => dialogCentreFixture.commands.length).toBe(2);
    expect(dialogCentreFixture.commands[1]!.input).toEqual({
      kind: "cancel",
      projectId: RYCO_LOCAL,
      automationId: "auto-triage",
      expectedRevision: 1,
    });
  });

  it("switches projects and shows an empty one with its own New", async () => {
    const screen = await renderDialog();
    openRyco();
    const dialog = screen.getByRole("dialog");
    await expect.poll(detailTitle).toBe("Triage new issues");
    await dialog.getByRole("button", { name: /Switch project/ }).click();
    await page.getByRole("menuitemradio", { name: /ryco-hub/ }).click();
    await expect.poll(selectedRowTitle).toBe("Summarise relay logs");
    await expect.element(dialog.getByText("3 missed runs")).toBeVisible();
    await expect
      .element(
        dialog.getByRole("button", { name: "2 changes waiting for your approval. Show the first" }),
      )
      .toBeVisible();

    await dialog.getByRole("button", { name: /Switch project/ }).click();
    await page.getByRole("menuitemradio", { name: /scratch/ }).click();
    await expect
      .element(dialog.getByRole("heading", { name: "No schedules in scratch" }))
      .toBeVisible();
    await expect.element(dialog.getByText("~/tmp/scratch")).toBeVisible();
    await dialog.getByRole("button", { name: "New schedule" }).click();
    await expect.element(dialog.getByRole("region", { name: "New schedule" })).toBeVisible();
    await expect.element(dialog.getByText("Nothing runs until you approve it.")).toBeVisible();
  });

  it("keeps a proposal that expired undecided until it is removed", async () => {
    useAgentControlStore.getState().applyStreamEvent(LOCAL_ENV, {
      version: 1,
      type: "snapshot",
      queue: { revision: 1, active: [], recent: [lapsedCreateProposal(SCRATCH_LOCAL)] },
    });
    const screen = await renderDialog();
    openAutomationsDialog({ environmentId: LOCAL_ENV, projectId: SCRATCH_LOCAL });
    const dialog = screen.getByRole("dialog");
    await expect.poll(selectedRowTitle).toBe("Weekly cleanup");
    await expect.element(dialog.getByRole("listbox").getByText("Proposal expired")).toBeVisible();
    const block = dialog.getByRole("region", { name: "Proposal expired" });
    await expect.element(block.getByText("This new schedule expired undecided")).toBeVisible();
    await expect
      .element(block.getByText("Nothing was created. Propose it again to ask for approval."))
      .toBeVisible();
    await block.getByRole("button", { name: "Remove" }).click();
    await expect
      .element(dialog.getByRole("heading", { name: "No schedules in scratch" }))
      .toBeVisible();
  });

  it("asks once before discarding a dirty draft, then keeps it one click away", async () => {
    const screen = await renderDialog({ editorComponent: DirtyEditor });
    openRyco();
    const dialog = screen.getByRole("dialog");
    await expect.poll(detailTitle).toBe("Triage new issues");
    await userEvent.keyboard("n");
    const title = dialog.getByRole("textbox", { name: "Title" });
    await expect.element(title).toBeVisible();
    await userEvent.fill(title, "Weekly digest");
    await userEvent.keyboard("{Escape}");
    await expect.element(dialog.getByTestId("editor-confirm")).toMatchTextContent("escape");
    await userEvent.keyboard("{Escape}");
    await expect.element(dialog.getByText("Draft discarded.")).toBeVisible();
    expect(useAutomationsDialogStore.getState().open).toBe(true);

    await dialog.getByRole("button", { name: "Restore" }).click();
    await expect.element(dialog.getByTestId("editor-source")).toMatchTextContent("restore");
    await expect
      .element(dialog.getByRole("textbox", { name: "Title" }))
      .toHaveValue("Weekly digest");
    await userEvent.fill(dialog.getByRole("textbox", { name: "Title" }), "Weekly digest 2");

    // Closing the dialog with a dirty draft asks too; closing again discards it.
    await dialog.getByRole("button", { name: "Close" }).click();
    await expect.element(dialog.getByTestId("editor-confirm")).toMatchTextContent("close");
    expect(useAutomationsDialogStore.getState().open).toBe(true);
    await dialog.getByRole("button", { name: "Close" }).click();
    await expect.poll(() => useAutomationsDialogStore.getState().open).toBe(false);
  });

  it("lands a saved draft on its row", async () => {
    const screen = await renderDialog({ editorComponent: DirtyEditor });
    openRyco();
    const dialog = screen.getByRole("dialog");
    await expect.poll(detailTitle).toBe("Triage new issues");
    await dialog.getByRole("button", { name: "New schedule" }).click();
    await dialog.getByRole("button", { name: "Save draft" }).click();
    await expect.poll(selectedRowTitle).toBe("Update the changelog");
    await expect.poll(detailTitle).toBe("Update the changelog");
    await expect
      .poll(() => document.activeElement?.getAttribute("data-ad-row"))
      .toContain("auto-changelog");
    expect(dialog.getByText("Draft discarded.").elements()).toHaveLength(0);
  });

  it("works the run history from the keyboard: U toggles unread, Enter opens the thread", async () => {
    const screen = await renderDialog();
    openRyco();
    const dialog = screen.getByRole("dialog");
    await expect.poll(detailTitle).toBe("Triage new issues");
    const history = dialog.getByRole("list", { name: "Run history" });
    await expect.element(dialog.getByText("9 · 1 unread")).toBeVisible();
    await expect.element(dialog.getByRole("button", { name: "Show all 9" })).toBeVisible();
    expect(history.getByRole("listitem").elements()).toHaveLength(6);
    const first = history.getByRole("listitem").first();
    (first.element() as HTMLElement).focus();
    await userEvent.keyboard("u");
    await expect
      .poll(() => dialogCentreFixture.commands.at(-1)?.input)
      .toMatchObject({
        kind: "read",
        runId: "run-t1",
        unread: false,
      });
    await userEvent.keyboard("{ArrowDown}");
    await expect.poll(() => document.activeElement?.getAttribute("data-run")).toBe("run-t2");
    await userEvent.keyboard("{ArrowUp}");
    await userEvent.keyboard("{Enter}");
    await expect.poll(() => useAutomationsDialogStore.getState().open).toBe(false);
    expect(navigate).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: LOCAL_ENV, threadId: "thread-relay" },
    });
  });

  it("says the limit once and keeps New off at it", async () => {
    dialogCentreFixture.set(LOCAL_ENV, HUB_LOCAL, fullSnapshot(HUB_LOCAL));
    const screen = await renderDialog();
    openAutomationsDialog({ environmentId: LOCAL_ENV, projectId: HUB_LOCAL });
    const dialog = screen.getByRole("dialog");
    await expect.element(dialog.getByText("25 of 25 active")).toBeVisible();
    const newButton = dialog.getByRole("button", { name: "New schedule" });
    await expect.element(newButton).toHaveAttribute("aria-disabled", "true");
    (newButton.element() as HTMLElement).click();
    await userEvent.keyboard("n");
    expect(dialog.getByRole("region", { name: "New schedule" }).elements()).toHaveLength(0);
  });

  it("lands a request: a schedule's editor, a new draft on a device, a re-target while open", async () => {
    const screen = await renderDialog();
    openAutomationsDialog({
      environmentId: LOCAL_ENV,
      projectId: RYCO_LOCAL,
      automationId: "auto-changelog" as AgentControlAutomationId,
      mode: "edit",
    });
    const dialog = screen.getByRole("dialog");
    await expect
      .element(dialog.getByRole("region", { name: "Edit Update the changelog" }))
      .toBeVisible();
    await dialog.getByRole("button", { name: "Discard" }).click();
    await expect.poll(detailTitle).toBe("Update the changelog");

    // While open, another entry point re-targets it.
    openAutomationsDialog({ environmentId: LOCAL_ENV, projectId: HUB_LOCAL });
    await expect.poll(selectedRowTitle).toBe("Summarise relay logs");

    openAutomationsDialog({ environmentId: LOCAL_ENV, mode: "new" });
    await expect.element(dialog.getByRole("region", { name: "New schedule" })).toBeVisible();
  });

  it("takes Enter on a row to the schedule's first action", async () => {
    const screen = await renderDialog();
    openRyco();
    await expect
      .poll(() => document.activeElement?.getAttribute("data-ad-row"))
      .toContain("auto-triage");
    await userEvent.keyboard("{Enter}");
    await expect.poll(() => document.activeElement?.textContent).toBe("Edit");
    expect(screen.getByRole("dialog").getByRole("button", { name: "Edit" }).element()).toBe(
      document.activeElement,
    );
  });

  it("cross-fades the detail on a click and swaps it in place from the keyboard", async () => {
    const screen = await renderDialog();
    openRyco();
    const dialog = screen.getByRole("dialog");
    await expect.poll(detailTitle).toBe("Triage new issues");
    const leaving = () => document.querySelectorAll(".ad-pane.is-leaving");
    // Record every pane that leaves: it stays a moment, inert, under the new one.
    const retired: Element[] = [];
    const detail = document.querySelector(".ad-detail")!;
    const observer = new MutationObserver((records) => {
      for (const record of records)
        for (const node of record.addedNodes)
          if (node instanceof Element && node.matches(".ad-pane.is-leaving")) retired.push(node);
    });
    observer.observe(detail, { childList: true });
    await dialog.getByRole("option", { name: /Update the changelog/ }).click();
    await expect.poll(detailTitle).toBe("Update the changelog");
    await expect.poll(() => retired.length).toBe(1);
    expect(retired[0]!.hasAttribute("inert")).toBe(true);
    expect(retired[0]!.querySelector(".ad-dtitle")?.textContent).toBe("Triage new issues");
    await expect.poll(() => leaving().length).toBe(0);
    await userEvent.keyboard("{ArrowDown}");
    await expect.poll(detailTitle).toBe("Watch main CI for flakes");
    // Arrow keys swap the pane in place.
    expect(retired).toHaveLength(1);
    observer.disconnect();
  });

  it("keeps every change off, and says why, for a reader who can't make them", async () => {
    dialogCentreFixture.disabledReason = "Your role can view automations but not change them.";
    const screen = await renderDialog();
    openRyco();
    const dialog = screen.getByRole("dialog");
    await expect.poll(detailTitle).toBe("Triage new issues");
    await expect
      .element(dialog.getByRole("button", { name: "Approve run" }))
      .toHaveAttribute("aria-disabled", "true");
    await expect
      .element(dialog.getByRole("button", { name: "New schedule" }))
      .toHaveAttribute("aria-disabled", "true");
    (dialog.getByRole("button", { name: "Approve run" }).element() as HTMLElement).click();
    await userEvent.keyboard("e");
    await userEvent.keyboard("n");
    expect(dialogCentreFixture.decisions).toEqual([]);
    expect(dialog.getByRole("region", { name: /Edit|New schedule/ }).elements()).toHaveLength(0);
  });

  it("keeps the picked schedule (and focus on it) when its waiting run is approved", async () => {
    const screen = await renderDialog();
    openRyco();
    const dialog = screen.getByRole("dialog");
    await expect.poll(detailTitle).toBe("Triage new issues");
    dialogCentreFixture.afterDecide = () =>
      dialogCentreFixture.update(
        LOCAL_ENV,
        RYCO_LOCAL,
        withRunDecided(rycoLocalSnapshot(), "run-due", "approved"),
      );
    await dialog.getByRole("button", { name: "Approve run" }).click();
    await expect
      .element(dialog.getByText("Approving starts one thread now."))
      .not.toBeInTheDocument();
    expect(detailTitle()).toBe("Triage new issues");
    expect(selectedRowTitle()).toBe("Triage new issues");
    await expect
      .poll(() => document.activeElement?.getAttribute("data-ad-row"))
      .toContain("auto-triage");
  });

  it("keeps the shown schedule when a run turns up on another", async () => {
    dialogCentreFixture.set(
      LOCAL_ENV,
      RYCO_LOCAL,
      withRunDecided(rycoLocalSnapshot(), "run-due", "approved"),
    );
    await renderDialog();
    openRyco();
    await expect.poll(detailTitle).toBe("Draft 0.14 release notes");
    await expect
      .poll(() => document.activeElement?.getAttribute("data-ad-row"))
      .toContain("auto-draft");
    dialogCentreFixture.update(LOCAL_ENV, RYCO_LOCAL, rycoLocalSnapshot());
    await expect
      .element(page.getByRole("button", { name: /Triage new issues: run waiting/ }))
      .toBeVisible();
    expect(detailTitle()).toBe("Draft 0.14 release notes");
    expect(document.activeElement?.getAttribute("aria-selected")).toBe("true");
  });

  it("says when a run's approval expired before it went through", async () => {
    const toast = vi.spyOn(toastManager, "add");
    queueSays(queuedProposal(rycoLocalSnapshot(), "proposal-due", "pending-user-approval"));
    const screen = await renderDialog();
    openRyco();
    const dialog = screen.getByRole("dialog");
    await expect.poll(detailTitle).toBe("Triage new issues");
    dialogCentreFixture.afterDecide = () => {
      queueSays(queuedProposal(rycoLocalSnapshot(), "proposal-due", "expired"));
      dialogCentreFixture.update(
        LOCAL_ENV,
        RYCO_LOCAL,
        withRunDecided(rycoLocalSnapshot(), "run-due", "expired"),
      );
    };
    await dialog.getByRole("button", { name: "Approve run" }).click();
    await expect
      .poll(() => toast.mock.calls.map(([options]) => options.title))
      .toEqual(["That approval expired before it went through."]);
    expect(toast.mock.calls[0]![0]).toMatchObject({ type: "warning" });
  });

  it("says why an approved change couldn't be applied", async () => {
    const toast = vi.spyOn(toastManager, "add");
    const screen = await renderDialog();
    openAutomationsDialog({ environmentId: LOCAL_ENV, projectId: HUB_LOCAL });
    const dialog = screen.getByRole("dialog");
    await dialog
      .getByRole("button", { name: "2 changes waiting for your approval. Show the first" })
      .click();
    await expect.poll(detailTitle).toBe("Rotate staging relay keys");
    dialogCentreFixture.afterDecide = (_environmentId, proposalId) =>
      queueSays(
        queuedProposal(
          hubSnapshot(),
          proposalId,
          "failed",
          "The first run time passed before approval. Edit the start and save again.",
        ),
      );
    await dialog.getByRole("button", { name: "Approve schedule" }).click();
    await expect
      .poll(() => toast.mock.calls.map(([options]) => options.title))
      .toEqual(["The first run time passed before approval. Edit the start and save again."]);
    expect(toast.mock.calls[0]![0]).toMatchObject({ type: "error" });
  });

  it("gives focus back to what opened it straight into an editor", async () => {
    const screen = await renderDialog();
    const opener = screen.getByRole("button", { name: "Edit from the map" });
    await opener.click();
    await expect
      .element(screen.getByRole("region", { name: "Edit Update the changelog" }))
      .toBeVisible();
    await userEvent.keyboard("{Escape}");
    await expect.poll(detailTitle).toBe("Update the changelog");
    await userEvent.keyboard("{Escape}");
    await expect.poll(() => useAutomationsDialogStore.getState().open).toBe(false);
    await expect.poll(() => document.activeElement).toBe(opener.element());
  });

  it("lets Escape through a tip shown on keyboard focus", async () => {
    await renderDialog();
    openRyco();
    await expect
      .poll(() => document.activeElement?.getAttribute("data-ad-row"))
      .toContain("auto-triage");
    await userEvent.keyboard("{Enter}");
    await expect.poll(() => document.activeElement?.textContent).toBe("Edit");
    expect(document.activeElement?.getAttribute("aria-keyshortcuts")).toBe("E");
    await expect.element(page.getByText("Edit · E")).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await expect.poll(() => useAutomationsDialogStore.getState().open).toBe(false);
  });

  it("opens the project switcher on the current project and finds one by name", async () => {
    const screen = await renderDialog();
    openAutomationsDialog({ environmentId: LOCAL_ENV, projectId: HUB_LOCAL });
    const dialog = screen.getByRole("dialog");
    await expect.poll(selectedRowTitle).toBe("Summarise relay logs");
    const trigger = dialog.getByRole("button", { name: /Switch project/ });
    (trigger.element() as HTMLElement).focus();
    await userEvent.keyboard("{Enter}");
    const current = page.getByRole("menuitemradio", { name: /ryco-hub/ });
    await expect.poll(() => document.activeElement).toBe(current.element());
    await expect.element(current).toHaveAttribute("data-highlighted");
    await userEvent.keyboard("{Escape}");
    await expect.element(current).not.toBeInTheDocument();
    await userEvent.keyboard("{Enter}");
    await expect.poll(() => document.activeElement).toBe(current.element());
    await userEvent.keyboard("scr");
    await expect
      .poll(() => document.activeElement)
      .toBe(page.getByRole("menuitemradio", { name: /scratch/ }).element());
  });

  it("names each device's group, so every option says where it runs", async () => {
    const screen = await renderDialog();
    openRyco();
    const list = screen.getByRole("dialog").getByRole("listbox", { name: /Schedules in/ });
    const studio = list.getByRole("group", { name: "Studio" });
    await expect.element(studio).toBeVisible();
    await expect
      .element(studio.getByRole("option", { name: /Nightly dependency check/ }))
      .toBeVisible();
    expect(
      list
        .getByRole("group", { name: "This device" })
        .getByRole("option", { name: /Triage new issues/ })
        .elements(),
    ).toHaveLength(1);
  });

  it("says what a run did on its tab stop", async () => {
    const screen = await renderDialog();
    openRyco();
    const history = screen.getByRole("dialog").getByRole("list", { name: "Run history" });
    const failed = history.getByRole("listitem", { name: /^Failed/ });
    await expect
      .element(failed)
      .toHaveAccessibleDescription(/Codex app-server exited before the thread started/);
  });

  it("opens a device's own New schedule on that device, even at the limit", async () => {
    dialogCentreFixture.set(LOCAL_ENV, RYCO_LOCAL, fullSnapshot(RYCO_LOCAL));
    const screen = await renderDialog({ editorComponent: DirtyEditor });
    openAutomationsDialog({ environmentId: LOCAL_ENV, projectId: RYCO_LOCAL, mode: "new" });
    const dialog = screen.getByRole("dialog");
    await expect
      .element(dialog.getByTestId("editor-device"))
      .toHaveTextContent(projectCheckoutKey(LOCAL_ENV, RYCO_LOCAL));
    await userEvent.keyboard("{Escape}");
    await expect.element(dialog.getByTestId("editor-device")).not.toBeInTheDocument();
    // "New schedule" in the header goes where there is room.
    await dialog.getByRole("button", { name: "New schedule" }).click();
    await expect
      .element(dialog.getByTestId("editor-device"))
      .toHaveTextContent(projectCheckoutKey(STUDIO_ENV, RYCO_STUDIO));
  });
});
