process.env.TZ = "Europe/Berlin";

import {
  blankScheduleDraft,
  scheduleDraftKey,
  type ScheduleDraft,
  type ScheduleRow,
} from "@ryco/client-runtime/state/agentControl";
import type {
  AgentControlAutomation,
  AgentControlAutomationId,
  ProjectId,
  ProviderInstanceId,
} from "@ryco/contracts";
import { DAY_MS } from "@ryco/shared/automationSchedule";
import { describe, expect, it } from "vite-plus/test";

import {
  editorHint,
  editorOpening,
  tokenPopupSpot,
  type EditorCheckoutInput,
} from "./editorModel.logic";

// Wed, Oct 7 2026 10:40 in Berlin.
const NOW = new Date(2026, 9, 7, 10, 40).getTime();
const PROJECT = "project-ryco" as ProjectId;
const MODEL = { instanceId: "claude" as ProviderInstanceId, model: "claude-sonnet-5-5" };

const blank = (overrides: Partial<ScheduleDraft> = {}): ScheduleDraft => ({
  ...blankScheduleDraft({ projectId: PROJECT, nowMs: NOW, modelSelection: MODEL }),
  ...overrides,
});

const checkout: EditorCheckoutInput = { key: "local:ryco", projectId: PROJECT, providers: [] };

function automation(): AgentControlAutomation {
  const start = NOW - 3 * DAY_MS;
  return {
    automationId: "auto-1" as AgentControlAutomationId,
    principal: { kind: "user" },
    projectId: PROJECT,
    providerInstanceId: "claude",
    definition: {
      execution: {
        projectId: PROJECT,
        title: "Nightly check",
        prompt: "Check things.",
        modelSelection: MODEL,
        runtimeMode: "approval-required",
        envMode: "worktree",
        baseRef: "main",
      },
      schedule: {
        kind: "fixed-interval",
        startsAt: new Date(start).toISOString(),
        intervalMs: DAY_MS,
        endsAt: new Date(NOW + 20 * DAY_MS).toISOString(),
      },
      enabled: true,
    },
    revision: 3,
    enabled: true,
    cancelled: false,
    cancelledAt: null,
    nextRunAt: new Date(start + 4 * DAY_MS).toISOString(),
    createdAt: new Date(start).toISOString(),
    updatedAt: new Date(start).toISOString(),
  } as unknown as AgentControlAutomation;
}

function row(input: Partial<ScheduleRow> = {}): ScheduleRow {
  const a = automation();
  return {
    id: a.automationId,
    automation: a,
    proposal: null,
    lapsed: null,
    def: a.definition,
    title: "Nightly check",
    projectId: PROJECT,
    state: "scheduled",
    nextRunAt: null,
    dueRun: null,
    activeRun: null,
    lastRun: null,
    runs: [],
    history: [],
    ...input,
  };
}

describe("where the editor starts", () => {
  it("opens a new schedule blank on the asked device, clean", () => {
    const opening = editorOpening({
      source: { kind: "new", checkoutKey: "local:ryco" },
      checkouts: [checkout],
      nowMs: NOW,
      defaultBaseRef: "main",
      fallbackProjectId: PROJECT,
      blank: () => blank(),
    });
    expect(opening.isNew).toBe(true);
    expect(opening.checkoutKey).toBe("local:ryco");
    expect(opening.initialKey).toBe(scheduleDraftKey(opening.draft));
  });

  it("edits a schedule with its past start rolled forward to the next run", () => {
    const opening = editorOpening({
      source: { kind: "edit", checkoutKey: "local:ryco", row: row() },
      checkouts: [checkout],
      nowMs: NOW,
      defaultBaseRef: "main",
      fallbackProjectId: PROJECT,
      blank: () => blank(),
    });
    expect(opening.isNew).toBe(false);
    expect(opening.draft.id).toBe("auto-1");
    expect(opening.draft.start).toBeGreaterThan(NOW);
    expect(opening.draft.start - NOW).toBeLessThanOrEqual(DAY_MS);
    expect(opening.initialKey).toBe(scheduleDraftKey(opening.draft));
  });

  it("re-proposes an expired proposal as always worth saving", () => {
    const a = automation();
    const proposal = {
      id: "p-1",
      kind: "edit",
      automationId: a.automationId,
      projectId: PROJECT,
      title: "Nightly check v2",
      before: a.definition,
      after: {
        ...a.definition,
        execution: { ...a.definition.execution, title: "Nightly check v2" },
      },
      expectedRevision: 3,
      status: "expired",
      createdAt: "",
      expiresAt: "",
      expiresAtMs: 0,
    } as unknown as NonNullable<ScheduleRow["lapsed"]>;
    const opening = editorOpening({
      source: { kind: "repropose", checkoutKey: "local:ryco", row: row(), proposal },
      checkouts: [checkout],
      nowMs: NOW,
      defaultBaseRef: "main",
      fallbackProjectId: PROJECT,
      blank: () => blank(),
    });
    expect(opening.initialKey).toBe("");
    expect(opening.draft.title).toBe("Nightly check v2");
  });

  it("restores a discarded draft exactly", () => {
    const draft = blank({ title: "Weekly digest" });
    const opening = editorOpening({
      source: {
        kind: "restore",
        state: { checkoutKey: "studio:ryco", draft, initialKey: "k", isNew: true, dirty: true },
      },
      checkouts: [checkout],
      nowMs: NOW,
      defaultBaseRef: "main",
      fallbackProjectId: PROJECT,
      blank: () => blank(),
    });
    expect(opening).toEqual({ checkoutKey: "studio:ryco", draft, initialKey: "k", isNew: true });
  });
});

describe("the footer and the counter", () => {
  it("asks before a dirty draft goes, else says the limit, else what saving means", () => {
    expect(editorHint({ confirm: "escape", limit: "full", isNew: true }).text).toBe(
      "Unsaved changes. Press Esc again to discard them, or",
    );
    expect(editorHint({ confirm: "close", limit: undefined, isNew: true }).text).toBe(
      "Unsaved changes. Close again to discard them, or",
    );
    expect(editorHint({ confirm: null, limit: "full", isNew: true })).toEqual({
      kind: "limit",
      text: "full",
    });
    expect(editorHint({ confirm: null, limit: undefined, isNew: true }).text).toBe(
      "Nothing runs until you approve it.",
    );
    expect(editorHint({ confirm: null, limit: undefined, isNew: false }).text).toBe(
      "Nothing changes until you approve it.",
    );
  });

  it("says why a save was refused until the draft changes, after a pending question", () => {
    const reason = "Requested worktree base ref is unavailable.";
    expect(editorHint({ confirm: null, failure: reason, limit: "full", isNew: true })).toEqual({
      kind: "failed",
      text: reason,
    });
    expect(
      editorHint({ confirm: "escape", failure: reason, limit: undefined, isNew: true }).kind,
    ).toBe("confirm");
  });
});

describe("where a token's popover lands", () => {
  const dialog = { left: 100, top: 50, right: 1100, bottom: 800 };
  const sentence = { left: 400, top: 120, right: 1000, bottom: 200 };

  it("goes under the whole sentence at the token's x", () => {
    expect(
      tokenPopupSpot({
        dialog,
        reference: sentence,
        token: { left: 520, top: 125, right: 600, bottom: 155 },
        popup: { width: 300, height: 200 },
        gap: 8,
      }),
    ).toEqual({ left: 520, top: 208 });
  });

  it("stays inside the dialog on the right", () => {
    expect(
      tokenPopupSpot({
        dialog,
        reference: sentence,
        token: { left: 950, top: 125, right: 1000, bottom: 155 },
        popup: { width: 300, height: 200 },
        gap: 8,
      }).left,
    ).toBe(1100 - 12 - 300);
  });

  it("goes above the sentence when there is no room below, else as low as fits", () => {
    const low = { left: 400, top: 600, right: 1000, bottom: 680 };
    expect(
      tokenPopupSpot({
        dialog,
        reference: low,
        token: { left: 520, top: 610, right: 600, bottom: 640 },
        popup: { width: 300, height: 200 },
        gap: 8,
      }).top,
    ).toBe(600 - 8 - 200);
    expect(
      tokenPopupSpot({
        dialog,
        reference: { left: 400, top: 150, right: 1000, bottom: 600 },
        token: { left: 520, top: 160, right: 600, bottom: 190 },
        popup: { width: 300, height: 400 },
        gap: 8,
      }).top,
    ).toBe(800 - 12 - 400);
  });
});
