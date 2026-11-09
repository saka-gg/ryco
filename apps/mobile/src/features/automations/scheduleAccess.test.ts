import { describe, expect, it } from "vite-plus/test";

import { SCHEDULE_MACHINE_UNKNOWN, scheduleAccessOf } from "./scheduleAccessModel";

describe("schedule access", () => {
  it("lets the owner change schedules only once the machine takes changes", () => {
    const owner = { role: "owner", connectionState: "connected", mutationReady: true } as const;
    expect(scheduleAccessOf(owner)).toEqual({ editable: true, reason: null });
    // Socket up but the live snapshot has not landed: cached rows are not the node's state.
    expect(scheduleAccessOf({ ...owner, mutationReady: false }).editable).toBe(false);
    expect(scheduleAccessOf({ ...owner, connectionState: "read-only" }).editable).toBe(false);
  });

  it("does not assume an unknown role or a viewer may decide, and says why", () => {
    const ready = { connectionState: "connected", mutationReady: true } as const;
    expect(scheduleAccessOf(ready).editable).toBe(false);
    expect(scheduleAccessOf({ ...ready, role: "viewer" }).reason).toMatch(/owner/);
    expect(scheduleAccessOf(undefined)).toEqual({
      editable: false,
      reason: SCHEDULE_MACHINE_UNKNOWN,
    });
  });
});
