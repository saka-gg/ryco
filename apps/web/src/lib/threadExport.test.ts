import { beforeEach, describe, expect, it, vi } from "vitest";
import { ORCHESTRATION_WS_METHODS, type ScopedThreadRef } from "@ryco/contracts";
const mocks = vi.hoisted(() => ({
  native: false,
  capability: vi.fn(),
  connection: {},
  status: { phase: "connected", connectedAt: "first", disconnectedAt: null },
  load: vi.fn(),
  download: vi.fn(),
  save: vi.fn(),
}));
vi.mock("@ryco/client-runtime/connection", () => ({
  loadThreadForExport: mocks.load,
  THREAD_EXPORT_RETRY: "Connection changed; retry",
}));
vi.mock("@ryco/client-runtime/rpc", () => ({
  getWsConnectionStatusForEnvironment: () => mocks.status,
}));
vi.mock("../environmentApi", () => ({ readEnvironmentApi: () => ({}) }));
vi.mock("../environments/runtime", () => ({ readEnvironmentConnection: () => mocks.connection }));
vi.mock("../env", () => ({
  get isElectron() {
    return mocks.native;
  },
}));
vi.mock("../hostedHub/capabilities", () => ({ readHostedRpcCapability: mocks.capability }));
vi.mock("../proposedPlan", () => ({ downloadPlanAsTextFile: mocks.download }));
import { exportThreadMarkdown } from "./threadExport";
const ref = { environmentId: "env", threadId: "thread" } as ScopedThreadRef;
const thread = {
  id: "thread",
  projectId: "p",
  title: "Test",
  modelSelection: { instanceId: "codex", model: "model" },
  createdAt: "2026-09-15T00:00:00Z",
  updatedAt: "2026-09-15T00:00:00Z",
  messages: [],
  activities: [],
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.native = false;
  mocks.status.connectedAt = "first";
  mocks.capability.mockReturnValue({ allowed: true });
  mocks.load.mockResolvedValue(thread);
  vi.stubGlobal("window", { desktopBridge: { saveThreadExport: mocks.save } });
});
describe("export delivery", () => {
  it("downloads only after complete history is loaded", async () => {
    expect(await exportThreadMarkdown(ref, new AbortController().signal)).toBe("downloaded");
    expect(mocks.download).toHaveBeenCalledWith(
      "ryco-Test.md",
      expect.stringContaining("Retained Ryco conversation"),
    );
  });
  it("does not download on history failure", async () => {
    mocks.load.mockRejectedValue(new Error("stalled"));
    await expect(exportThreadMarkdown(ref, new AbortController().signal)).rejects.toThrow(
      "stalled",
    );
    expect(mocks.download).not.toHaveBeenCalled();
  });
  it("rejects reconnect before delivery", async () => {
    mocks.load.mockImplementation(async () => {
      mocks.status.connectedAt = "replacement";
      return thread;
    });
    await expect(exportThreadMarkdown(ref, new AbortController().signal)).rejects.toThrow(
      "changed",
    );
    expect(mocks.download).not.toHaveBeenCalled();
  });
  it("does not deliver after cancellation", async () => {
    const controller = new AbortController();
    mocks.load.mockImplementation(async () => {
      controller.abort();
      return thread;
    });
    await expect(exportThreadMarkdown(ref, controller.signal)).rejects.toThrow();
    expect(mocks.download).not.toHaveBeenCalled();
  });
  it("checks the capability of the thread's own environment", async () => {
    const other = { environmentId: "other-env", threadId: "thread" } as ScopedThreadRef;
    mocks.capability.mockImplementation((_method, environmentId) => ({
      allowed: environmentId === "other-env",
    }));
    expect(await exportThreadMarkdown(other, new AbortController().signal)).toBe("downloaded");
    expect(mocks.capability).toHaveBeenCalledWith(
      ORCHESTRATION_WS_METHODS.getThreadWindow,
      "other-env",
    );
    expect(mocks.capability).not.toHaveBeenCalledWith(
      ORCHESTRATION_WS_METHODS.getThreadWindow,
      "env",
    );
  });
  it("refuses an export whose own environment is not currently allowed", async () => {
    mocks.capability.mockImplementation((_method, environmentId) => ({
      allowed: environmentId !== "env",
    }));
    await expect(exportThreadMarkdown(ref, new AbortController().signal)).rejects.toThrow(
      "changed",
    );
    expect(mocks.load).not.toHaveBeenCalled();
    expect(mocks.download).not.toHaveBeenCalled();
  });
  it.each(["saved", "cancelled"])("returns desktop %s without browser fallback", async (status) => {
    mocks.native = true;
    mocks.save.mockResolvedValue({ status });
    expect(await exportThreadMarkdown(ref, new AbortController().signal)).toBe(status);
    expect(mocks.save).toHaveBeenCalledWith({
      filename: "ryco-Test.md",
      contents: expect.stringContaining("Retained Ryco conversation"),
    });
    expect(mocks.download).not.toHaveBeenCalled();
  });
});
