import { afterEach, describe, expect, it } from "vitest";

import { ComputerManager } from "./ComputerManager.ts";
import { FakeComputerBackend } from "./FakeComputerBackend.ts";

const managers: ComputerManager[] = [];
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.dispose();
});

function manager() {
  const backend = new FakeComputerBackend({
    windows: [
      {
        id: "w-safari",
        title: "Start Page",
        appName: "Safari",
        pid: 10,
        bounds: { x: 0, y: 0, width: 400, height: 300 },
        focused: true,
        minimized: false,
        visible: true,
      },
      {
        id: "w-nameless",
        title: "",
        pid: 20,
        bounds: { x: 0, y: 0, width: 400, height: 300 },
        focused: false,
        minimized: false,
        visible: true,
      },
    ],
    apps: [
      { pid: 10, name: "Safari", bundleId: "com.apple.Safari", running: true, active: true },
      { pid: 20, name: "Notes", bundleId: "com.apple.Notes", running: true, active: false },
    ],
  });
  const created = new ComputerManager({ backend });
  managers.push(created);
  return created;
}

describe("ComputerManager.approvalAppNames", () => {
  it("names windows, pids and app identities through the window list and running apps", async () => {
    expect(
      await manager().approvalAppNames({
        windowIds: ["w-safari", "w-nameless"],
        pids: [10],
        apps: ["com.apple.notes", "/Applications/Maps.app"],
      }),
    ).toEqual({
      names: ["Safari", "Safari", "Notes", "Notes", "/Applications/Maps.app"],
      unresolved: false,
    });
  });

  it("reports a window or pid it cannot name", async () => {
    expect(await manager().approvalAppNames({ windowIds: ["gone"], pids: [], apps: [] })).toEqual({
      names: [],
      unresolved: true,
    });
    expect(await manager().approvalAppNames({ windowIds: [], pids: [999], apps: [] })).toEqual({
      names: [],
      unresolved: true,
    });
  });
});
