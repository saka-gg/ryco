import "../../../index.css";

import {
  AgentControlAutomationId,
  AgentControlProposal,
  AgentControlProposalId,
  type AutomationCentreSnapshot,
} from "@ryco/contracts";
import { deriveScheduleRows, useAgentControlStore } from "@ryco/client-runtime/state/agentControl";
import { Schema } from "effect";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

vi.mock(
  "~/components/automations/useAutomationCentre",
  async () =>
    (await import("~/components/projects/testing/automationFixtures")).automationCentreMock,
);

import type {
  SidebarProjectGroupMember,
  SidebarProjectSnapshot,
} from "../../../sidebarProjectGrouping";
import {
  automationCentreFixture,
  fixtureAutomation,
} from "../../projects/testing/automationFixtures";
import {
  LOCAL_ENV,
  RYCO_LOCAL,
  RYCO_STUDIO,
  STUDIO_ENV,
  fixtureProject,
  resetProjectsFixtureState,
  seedProjectsFixtureStore,
} from "../../projects/testing/projectFixtures";
import { isAgentControlProposalSyncRetained } from "./useAutomationProposalSync";
import {
  dismissLapsedScheduleProposal,
  resetDismissedLapsedProposalsForTests,
  restoreLapsedScheduleProposal,
  useLapsedScheduleProposals,
  type CheckoutProposalQueue,
} from "./useLapsedScheduleProposals";
import { useProjectAutomations, type ProjectAutomations } from "./useProjectAutomations";

function member(project: ReturnType<typeof fixtureProject>): SidebarProjectGroupMember {
  return {
    ...project,
    physicalProjectKey: `${project.environmentId}:${project.cwd}`,
    environmentLabel: null,
  };
}

/* The remote checkout first: the hook puts this device first anyway. */
const studio = member(
  fixtureProject({
    id: RYCO_STUDIO,
    environmentId: STUDIO_ENV,
    name: "ryco",
    cwd: "/home/me/src/ryco",
  }),
);
const local = member(
  fixtureProject({
    id: RYCO_LOCAL,
    environmentId: LOCAL_ENV,
    name: "ryco",
    cwd: "/Users/me/Code/ryco",
  }),
);
const rycoSnapshot = {
  ...studio,
  projectKey: "github.com/sak0a/ryco",
  displayName: "ryco",
  groupedProjectCount: 2,
  environmentPresence: "mixed",
  memberProjects: [studio, local],
  memberProjectRefs: [
    { environmentId: STUDIO_ENV, projectId: RYCO_STUDIO },
    { environmentId: LOCAL_ENV, projectId: RYCO_LOCAL },
  ],
  remoteEnvironmentLabels: ["Studio"],
} as SidebarProjectSnapshot;

const seen: ProjectAutomations[] = [];
const seenQueues: Array<ReadonlyMap<string, CheckoutProposalQueue>> = [];
/* Lapsing here does not depend on the clock: the proposal is already expired. */
const RENDER_NOW_MS = Date.parse("2026-10-06T12:00:00.000Z");

function LapsedProbe(props: { readonly snapshot: SidebarProjectSnapshot }) {
  const { checkouts, sources } = useProjectAutomations(props.snapshot);
  const queues = useLapsedScheduleProposals(checkouts);
  const [renders, setRenders] = useState(0);
  seenQueues.push(queues);
  // What the dialog does with them: the shared rows show the lapsed proposal.
  const lapsedTitles = checkouts.flatMap((checkout) => {
    const queue = queues.get(checkout.key);
    if (!checkout.snapshot || !queue) return [];
    return deriveScheduleRows({
      projectId: checkout.projectId,
      snapshot: checkout.snapshot,
      queueProposals: queue.queueProposals,
      dismissedLapsed: queue.dismissed,
      nowMs: RENDER_NOW_MS,
    })
      .filter((row) => row.state === "lapsed")
      .map((row) => row.title);
  });
  return (
    <div>
      {sources}
      <button type="button" onClick={() => setRenders(renders + 1)}>
        Render again
      </button>
      <p data-testid="lapsed">{lapsedTitles.join(", ") || "none lapsed"}</p>
      <ul>
        {[...queues.values()].map((queue) => (
          <li key={queue.key} data-testid="queue">
            {queue.environmentId} · {queue.hydrated ? "hydrated" : "waiting"} ·{" "}
            {queue.queueProposals.map((proposal) => proposal.status).join(",") || "empty"} ·{" "}
            {queue.dismissed.size} dismissed
          </li>
        ))}
      </ul>
    </div>
  );
}

const expiredCreate = Schema.decodeUnknownSync(AgentControlProposal)({
  proposalId: "proposal-lapsed",
  requestId: "request-lapsed",
  principal: {
    kind: "automation-owner",
    projectId: RYCO_LOCAL,
    runtimeMode: "approval-required",
    envMode: "local",
  },
  planVersion: 1,
  plan: {
    kind: "createAutomation",
    automationId: "auto-lapsed",
    definition: {
      execution: {
        projectId: RYCO_LOCAL,
        title: "Weekly digest",
        prompt: "Summarise the week",
        modelSelection: { instanceId: "claude", model: "claude-sonnet-5-5" },
        runtimeMode: "approval-required",
        envMode: "local",
      },
      schedule: { kind: "once", runAt: "2026-10-10T09:00:00.000Z" },
      enabled: true,
    },
  },
  planDigest: "a".repeat(64),
  riskTags: [],
  promptSummary: "Create Weekly digest",
  status: "expired",
  createdAt: "2026-10-03T09:00:00.000Z",
  updatedAt: "2026-10-03T09:15:00.000Z",
  expiresAt: "2026-10-03T09:15:00.000Z",
  decidedAt: null,
  result: null,
});

function Probe(props: { readonly snapshot: SidebarProjectSnapshot }) {
  const automations = useProjectAutomations(props.snapshot);
  const [renders, setRenders] = useState(0);
  seen.push(automations);
  return (
    <div>
      {automations.sources}
      <button type="button" onClick={() => setRenders(renders + 1)}>
        Render again
      </button>
      <p data-testid="loading">{automations.loading ? "loading" : "ready"}</p>
      <ul>
        {automations.checkouts.map((checkout) => (
          <li key={checkout.key} data-testid="checkout">
            {checkout.deviceLabel} · {checkout.isPrimary ? "primary" : "remote"} ·{" "}
            {checkout.snapshot?.automations.length ?? "none"} schedules · {checkout.presence.status}
            <button
              type="button"
              onClick={() =>
                void checkout.command({
                  kind: "cancel",
                  projectId: checkout.projectId,
                  automationId: AgentControlAutomationId.make("auto-triage"),
                  expectedRevision: 1,
                })
              }
            >
              Cancel on {checkout.deviceLabel}
            </button>
            <button
              type="button"
              onClick={() =>
                void checkout.decide(AgentControlProposalId.make("proposal-due"), "accept")
              }
            >
              Approve on {checkout.deviceLabel}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

describe("useProjectAutomations", () => {
  beforeEach(() => {
    seedProjectsFixtureStore();
    automationCentreFixture.reset();
    automationCentreFixture.snapshots.set(STUDIO_ENV, {
      automations: [
        fixtureAutomation({
          id: "auto-linux",
          title: "Linux build",
          nextInMinutes: 30,
          projectId: RYCO_STUDIO,
        }),
      ],
      runs: [],
      proposals: [],
      unavailableRecords: 0,
      historyLimit: 50,
    } as unknown as AutomationCentreSnapshot);
    seen.length = 0;
  });
  afterEach(() => {
    resetProjectsFixtureState();
    automationCentreFixture.reset();
    resetDismissedLapsedProposalsForTests();
    useAgentControlStore.getState().clearEnvironment(LOCAL_ENV);
  });

  it("reads every checkout, this device first, and routes actions to its device", async () => {
    const screen = await render(<Probe snapshot={rycoSnapshot} />);
    await expect.poll(() => screen.getByTestId("checkout").elements().length).toBe(2);
    const rows = screen.getByTestId("checkout").elements();
    expect(rows[0]!.textContent).toContain("This device · primary · 3 schedules");
    expect(rows[1]!.textContent).toContain("Studio · remote · 1 schedules");
    await expect.element(screen.getByTestId("loading")).toMatchTextContent("ready");

    await screen.getByRole("button", { name: "Cancel on Studio" }).click();
    expect(automationCentreFixture.commands).toEqual([
      {
        environmentId: STUDIO_ENV,
        input: {
          kind: "cancel",
          projectId: RYCO_STUDIO,
          automationId: "auto-triage",
          expectedRevision: 1,
        },
      },
    ]);
    await screen.getByRole("button", { name: "Approve on This device" }).click();
    expect(automationCentreFixture.decisions).toEqual([
      { environmentId: LOCAL_ENV, proposalId: "proposal-due", decision: "accept" },
    ]);
    // The device queues behind lapsed proposals are kept live while shown.
    expect(isAgentControlProposalSyncRetained(LOCAL_ENV)).toBe(true);
    expect(isAgentControlProposalSyncRetained(STUDIO_ENV)).toBe(true);

    screen.unmount();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(isAgentControlProposalSyncRetained(LOCAL_ENV)).toBe(false);
    expect(isAgentControlProposalSyncRetained(STUDIO_ENV)).toBe(false);
  });

  it("keeps its identities when nothing it reads changed", async () => {
    const screen = await render(<Probe snapshot={rycoSnapshot} />);
    await expect.poll(() => seen.at(-1)?.checkouts.length).toBe(2);
    const before = seen.at(-1)!;
    const count = seen.length;
    await screen.getByRole("button", { name: "Render again" }).click();
    await expect.poll(() => seen.length).toBeGreaterThan(count);
    const after = seen.at(-1)!;
    expect(after.checkouts).toBe(before.checkouts);
    expect(after.checkouts[0]!.command).toBe(before.checkouts[0]!.command);
    expect(after.checkouts[0]!.decide).toBe(before.checkouts[0]!.decide);
    expect(after.checkouts[0]!.refresh).toBe(before.checkouts[0]!.refresh);
  });

  it("hands each checkout its device queue, expired proposals and session dismissals included", async () => {
    seenQueues.length = 0;
    useAgentControlStore.getState().applyStreamEvent(LOCAL_ENV, {
      version: 1,
      type: "snapshot",
      queue: { revision: 1, active: [], recent: [expiredCreate] },
    });
    const screen = await render(<LapsedProbe snapshot={rycoSnapshot} />);
    await expect.poll(() => screen.getByTestId("queue").elements().length).toBe(2);
    const text = () =>
      screen
        .getByTestId("queue")
        .elements()
        .map((row) => row.textContent);
    expect(text()).toEqual([
      `${LOCAL_ENV} · hydrated · expired · 0 dismissed`,
      `${STUDIO_ENV} · waiting · empty · 0 dismissed`,
    ]);

    await expect.element(screen.getByTestId("lapsed")).toMatchTextContent("Weekly digest");

    const before = seenQueues.at(-1)!.get(`${LOCAL_ENV}\0${RYCO_LOCAL}`)!;
    await screen.getByRole("button", { name: "Render again" }).click();
    const after = seenQueues.at(-1)!.get(`${LOCAL_ENV}\0${RYCO_LOCAL}`)!;
    expect(after.queueProposals).toBe(before.queueProposals);
    expect(after.dismissed).toBe(before.dismissed);

    dismissLapsedScheduleProposal(LOCAL_ENV, expiredCreate.proposalId);
    await expect.poll(() => text()[0]).toBe(`${LOCAL_ENV} · hydrated · expired · 1 dismissed`);
    await expect.element(screen.getByTestId("lapsed")).toMatchTextContent("none lapsed");
    expect(
      seenQueues
        .at(-1)!
        .get(`${LOCAL_ENV}\0${RYCO_LOCAL}`)!
        .dismissed.has(expiredCreate.proposalId),
    ).toBe(true);
    restoreLapsedScheduleProposal(LOCAL_ENV, expiredCreate.proposalId);
    await expect.poll(() => text()[0]).toBe(`${LOCAL_ENV} · hydrated · expired · 0 dismissed`);
    await expect.element(screen.getByTestId("lapsed")).toMatchTextContent("Weekly digest");
  });
});
