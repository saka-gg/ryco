import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScopedThreadRef } from "@ryco/contracts";
const mocks = vi.hoisted(() => ({
  native: false,
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
  isHostedHubMode: () => false,
}));
vi.mock("../hostedHub/capabilities", () => ({
  resolveHostedRpcCapability: () => ({ allowed: true }),
}));
vi.mock("../hostedHub/state", () => ({ useHostedHubStore: { getState: () => ({}) } }));
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
