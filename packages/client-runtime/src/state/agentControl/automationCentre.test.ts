import { describe, expect, it, vi } from "vite-plus/test";
import {
  ProjectId,
  type AgentControlProposal,
  type AutomationCentreSnapshot,
} from "@ryco/contracts";
import {
  automationRunStatusLabel,
  createAutomationCentreReader,
  isWaitingAutomationRun,
  waitingAutomationRunCount,
} from "./automationCentre.ts";
const snapshot: AutomationCentreSnapshot = {
  automations: [],
  runs: [],
  proposals: [],
  unavailableRecords: 0,
  historyLimit: 50,
};
describe("automation centre refresh", () => {
  it("discards a read completing after a connection generation is disposed", async () => {
    let resolve!: (value: AutomationCentreSnapshot) => void;
    const onSnapshot = vi.fn();
    const reader = createAutomationCentreReader({
      projectId: ProjectId.make("p"),
      api: {
        snapshot: () =>
          new Promise((r) => {
            resolve = r;
          }),
        command: vi.fn(),
      },
      onSnapshot,
      onError: vi.fn(),
    });
    const pending = reader.refresh();
    reader.stop();
    resolve(snapshot);
    await pending;
    expect(onSnapshot).not.toHaveBeenCalled();
  });
  it("coalesces concurrent invalidations into a single trailing refresh", async () => {
    let resolve!: (value: AutomationCentreSnapshot) => void;
    const query = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((r) => {
            resolve = r;
          }),
      )
      .mockResolvedValue(snapshot);
    const reader = createAutomationCentreReader({
      projectId: ProjectId.make("p"),
      api: { snapshot: query, command: vi.fn() },
      onSnapshot: vi.fn(),
      onError: vi.fn(),
    });
    const pending = reader.refresh();
    void reader.refresh();
    void reader.refresh();
    resolve(snapshot);
    await pending;
    expect(query).toHaveBeenCalledTimes(2);
  });
  it("discards a pre-error read and refreshes after resubscription", async () => {
    let resolve!: (value: AutomationCentreSnapshot) => void;
    const query = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((r) => {
            resolve = r;
          }),
      )
      .mockResolvedValue(snapshot);
    const onSnapshot = vi.fn();
    const reader = createAutomationCentreReader({
      projectId: ProjectId.make("p"),
      api: { snapshot: query, command: vi.fn() },
      onSnapshot,
      onError: vi.fn(),
    });
    const pending = reader.refresh();
    reader.invalidate();
    void reader.refresh();
    resolve(snapshot);
    await pending;
    expect(query).toHaveBeenCalledTimes(2);
    expect(onSnapshot).toHaveBeenCalledExactlyOnceWith(snapshot);
  });
  it("never labels dispatch completion as task success", () => {
    expect(automationRunStatusLabel.completed).toBe("Dispatched");
  });
});

const queued = (id: string, kind: string, status = "pending-user-approval") =>
  ({ proposalId: id, status, plan: { kind } }) as unknown as AgentControlProposal;

describe("runs waiting for approval", () => {
  it("counts automation runs still pending, on the given devices only", () => {
    const queues = {
      "env-local": {
        proposalsById: {
          a: queued("a", "automationRun"),
          b: queued("b", "automationRun", "expired"),
          c: queued("c", "createAutomation"),
        },
      },
      "env-studio": { proposalsById: { d: queued("d", "automationRun") } },
      "env-gone": { proposalsById: { e: queued("e", "automationRun") } },
    };
    expect(waitingAutomationRunCount(queues, ["env-local", "env-studio"])).toBe(2);
    expect(waitingAutomationRunCount(queues, [])).toBe(0);
  });

  it("leaves schedule changes to the dialog: they are proposed, not runs", () => {
    expect(isWaitingAutomationRun(queued("x", "updateAutomation"))).toBe(false);
    expect(isWaitingAutomationRun(queued("y", "automationRun", "approved"))).toBe(false);
  });
});
