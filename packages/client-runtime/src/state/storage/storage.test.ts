import { describe, expect, it, vi } from "vitest";
import type { StorageCleanupPreview, StorageSnapshot } from "@ryco/contracts";
import type { WsRpcClient } from "../../rpc/wsRpcClient.ts";
import { createStorageManagementController } from "./index.ts";

const snapshot: StorageSnapshot = {
  entries: [],
  history: [],
  truncated: false,
  nextCursor: null,
  scannedAt: new Date().toISOString(),
};
const preview: StorageCleanupPreview = {
  token: "fixture",
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  entries: [],
};
function fixture() {
  const execute = vi.fn(async () => ({ results: [] }));
  const client = {
    storage: { scan: vi.fn(async () => snapshot), preview: vi.fn(async () => preview), execute },
  } as unknown as WsRpcClient;
  let current: WsRpcClient | null = client;
  let ready = true;
  const controller = createStorageManagementController({
    readClient: () => current,
    canManage: () => ready,
  });
  return {
    client,
    controller,
    execute,
    replace: (next: WsRpcClient | null) => {
      current = next;
    },
    stale: () => {
      ready = false;
    },
  };
}
describe("node storage request lifecycle", () => {
  it("requires confirmation, current connection and readiness before deletion", async () => {
    const f = fixture();
    await f.controller.preview(["owned"]);
    await f.controller.execute(false);
    expect(f.execute).not.toHaveBeenCalled();
    await f.controller.preview(["owned"]);
    f.stale();
    await f.controller.execute(true);
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.controller.getSnapshot().preview).toBeNull();
  });
  it("rejects a preview made on a superseded connection", async () => {
    const f = fixture();
    await f.controller.preview(["owned"]);
    f.replace({ ...f.client });
    await f.controller.execute(true);
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.controller.getSnapshot().error).toContain("current reviewed preview");
  });
  it("discards late scan results after switching scope", async () => {
    const f = fixture();
    let resolve!: (value: StorageSnapshot) => void;
    vi.mocked(f.client.storage.scan).mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const pending = f.controller.scan();
    f.controller.reset();
    resolve(snapshot);
    await pending;
    expect(f.controller.getSnapshot().snapshot).toBeNull();
    expect(f.controller.getSnapshot().busy).toBe(false);
  });
  it("does not duplicate an in-flight execution", async () => {
    const f = fixture();
    await f.controller.preview(["owned"]);
    await Promise.all([f.controller.execute(true), f.controller.execute(true)]);
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.execute).toHaveBeenCalledWith({
      token: "fixture",
      confirmation: "delete reviewed data",
    });
  });
  it("keeps presentation readiness in the shared controller and invalidates a disconnected preview", async () => {
    const f = fixture();
    const controller = createStorageManagementController({ readClient: () => f.client });
    await controller.scan();
    expect(f.client.storage.scan).not.toHaveBeenCalled();
    controller.setReady(true);
    await controller.preview(["owned"]);
    expect(controller.getSnapshot().preview).not.toBeNull();
    controller.setReady(false);
    await controller.execute(true);
    expect(controller.getSnapshot().preview).toBeNull();
    expect(f.execute).not.toHaveBeenCalled();
  });
});
