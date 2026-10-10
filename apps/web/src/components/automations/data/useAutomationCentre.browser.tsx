import {
  AgentControlAutomationId,
  AgentControlRpcError,
  EnvironmentId,
  ProjectId,
  type AgentControlProposal,
  type AgentControlProposalStreamEvent,
  type AutomationCentreCommand,
  type AutomationCentreSnapshot,
} from "@ryco/contracts";
import { useAgentControlStore } from "@ryco/client-runtime/state/agentControl";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

/* One device with a live connection; every call is recorded. */
const device = vi.hoisted(() => ({
  client: { server: { getConfig: () => Promise.resolve({ providers: [] }) } },
  streams: [] as Array<{
    readonly listener: (event: AgentControlProposalStreamEvent) => void;
    readonly onError: () => void;
  }>,
  snapshotReads: 0,
  commands: [] as AutomationCentreCommand[],
  command: vi.fn(),
}));
vi.mock("../../../environments/runtime", () => ({
  readEnvironmentConnection: () => ({ client: device.client }),
  subscribeEnvironmentConnections: () => () => {},
}));
vi.mock("../../../environmentApi", () => {
  const api = {
    automationCentre: {
      snapshot: () => {
        device.snapshotReads += 1;
        return Promise.resolve({
          automations: [],
          runs: [],
          proposals: [],
          unavailableRecords: 0,
          historyLimit: 50,
        } satisfies AutomationCentreSnapshot);
      },
      command: (input: AutomationCentreCommand) => {
        device.commands.push(input);
        return device.command(input);
      },
    },
    agentControl: {
      subscribeProposals: (
        listener: (event: AgentControlProposalStreamEvent) => void,
        options: { readonly onError: () => void },
      ) => {
        const stream = { listener, onError: options.onError };
        device.streams.push(stream);
        return () => {
          device.streams.splice(device.streams.indexOf(stream), 1);
        };
      },
    },
  };
  return { readEnvironmentApi: () => api, readEnvironmentApiForConnection: () => api };
});
vi.mock("../../../hostedHub/capabilities", () => ({
  useHostedRpcCapability: () => ({ allowed: true, reason: null }),
}));

import { useAutomationCentre, type AutomationCentreState } from "../useAutomationCentre";

const ENV = EnvironmentId.make("env-centre");
const ALPHA = ProjectId.make("alpha");
const BETA = ProjectId.make("beta");
const cancel = {
  kind: "cancel",
  projectId: ALPHA,
  automationId: AgentControlAutomationId.make("auto-1"),
  expectedRevision: 1,
} as const;

const latest = new Map<ProjectId, AutomationCentreState>();
function Probe(props: { readonly projectId: ProjectId }) {
  const state = useAutomationCentre(ENV, props.projectId);
  useEffect(() => {
    latest.set(props.projectId, state);
  });
  return <p data-testid={`error-${props.projectId}`}>{state.error ?? "ok"}</p>;
}

const queueSnapshot = (
  proposals: AgentControlProposal[] = [],
): AgentControlProposalStreamEvent => ({
  version: 1,
  type: "snapshot",
  queue: { revision: 1, active: proposals, recent: [] },
});

beforeEach(() => {
  device.streams.length = 0;
  device.snapshotReads = 0;
  device.commands.length = 0;
  device.command.mockReset();
  device.command.mockResolvedValue(undefined);
  latest.clear();
});
afterEach(() => {
  useAgentControlStore.getState().clearEnvironment(ENV);
});

describe("useAutomationCentre", () => {
  it("reads proposal changes from the device's one shared queue stream", async () => {
    const screen = await render(
      <>
        <Probe projectId={ALPHA} />
        <Probe projectId={BETA} />
      </>,
    );
    await expect.poll(() => device.snapshotReads).toBe(2);
    expect(device.streams).toHaveLength(1);

    device.streams[0]!.listener(queueSnapshot());
    await expect.poll(() => device.snapshotReads).toBe(4);

    // The server refused the queue: both say so.
    device.streams[0]!.onError();
    await expect.element(screen.getByTestId("error-alpha")).toHaveTextContent(/unavailable/);
    await expect.element(screen.getByTestId("error-beta")).toHaveTextContent(/unavailable/);

    screen.unmount();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(device.streams).toHaveLength(0);
  });

  it("sends every action as a new request and retries only an unanswered one", async () => {
    await render(<Probe projectId={ALPHA} />);
    await expect.poll(() => latest.get(ALPHA)?.snapshot).not.toBeNull();
    const run = () => latest.get(ALPHA)!.command(cancel);
    const ids = () => device.commands.map((command) => command.requestId);

    // Pause → (rejected elsewhere) → Pause: two proposals, not a replay.
    expect(await run()).toBe(true);
    expect(await run()).toBe(true);
    expect(new Set(ids()).size).toBe(2);

    // The connection dropped: the retry keeps the attempt's id.
    device.command.mockRejectedValueOnce(new Error("Socket closed"));
    expect(await run()).toBe(false);
    expect(await run()).toBe(true);
    expect(ids()[3]).toBe(ids()[2]);

    // The server refused it: the next try is a new request.
    device.command.mockRejectedValueOnce(
      new AgentControlRpcError({ code: "conflict", message: "Schedule changed." }),
    );
    expect(await run()).toBe(false);
    expect(await run()).toBe(true);
    expect(ids()[5]).not.toBe(ids()[4]);

    // An unanswered attempt that shows up in the queue did land.
    device.command.mockRejectedValueOnce(new Error("Socket closed"));
    expect(await run()).toBe(false);
    const landed = ids()[6]!;
    device.streams[0]!.listener(
      queueSnapshot([
        { requestId: landed, proposalId: "landed" } as unknown as AgentControlProposal,
      ]),
    );
    expect(await run()).toBe(true);
    expect(ids()[7]).not.toBe(landed);
  });
});
