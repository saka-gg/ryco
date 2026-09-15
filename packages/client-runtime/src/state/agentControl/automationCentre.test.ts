import { describe, expect, it, vi } from "vite-plus/test";
import { ProjectId, type AutomationCentreSnapshot } from "@ryco/contracts";
import { createAutomationCentreReader, automationRunStatusLabel } from "./automationCentre.ts";
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
