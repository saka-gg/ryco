import { expect, it, vi } from "vitest";
import { ComputerPermissionMonitor } from "./permissions.ts";

const hello = (status: string) => ({
  protocolVersion: 3,
  permissions: { accessibility: status, screenRecording: status },
});
it("refreshes permission changes and deduplicates simultaneous checks", async () => {
  const probe = vi.fn(async () => hello("denied"));
  const monitor = new ComputerPermissionMonitor(probe);
  expect(monitor.state().checkedAt).toBeNull();
  await Promise.all([monitor.refresh(), monitor.refresh(), monitor.refresh()]);
  expect(probe).toHaveBeenCalledOnce();
  expect(monitor.state()).toMatchObject({ accessibility: "denied", helperAvailable: true });
  probe.mockResolvedValue(hello("granted"));
  await monitor.refresh();
  expect(monitor.state()).toMatchObject({
    accessibility: "granted",
    screenRecording: "granted",
    error: null,
  });
});
it("does not retain a stale Granted state when the helper disappears", async () => {
  const probe = vi.fn(async () => hello("granted"));
  const monitor = new ComputerPermissionMonitor(probe);
  await monitor.refresh();
  probe.mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }));
  await monitor.refresh();
  expect(monitor.state()).toMatchObject({
    accessibility: "unknown",
    screenRecording: "unknown",
    helperAvailable: false,
  });
  expect(monitor.state().error).toMatch(/helper is missing/);
  probe.mockResolvedValue(hello("granted"));
  await monitor.refresh();
  expect(monitor.state().error).toBeNull();
});
it("rejects malformed and incompatible permission replies", async () => {
  for (const value of [null, { ...hello("granted"), protocolVersion: 1 }, hello("undefined")]) {
    const monitor = new ComputerPermissionMonitor(async () => value);
    expect((await monitor.refresh()).helperAvailable).toBe(false);
  }
});
