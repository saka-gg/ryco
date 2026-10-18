import { describe, expect, it } from "vite-plus/test";

import { resolveTasksAccess } from "./tasksAccess.logic";

const hosted = (allowed: boolean) => ({ hosted: true, allowed });

describe("resolveTasksAccess", () => {
  it("always allows the tasks outside hosted mode", () => {
    expect(
      resolveTasksAccess({
        capability: { hosted: false, allowed: true },
        role: null,
        allowedBefore: false,
      }),
    ).toEqual({ allowed: true, denied: false });
  });

  it("lets the role decide on the Hub", () => {
    expect(
      resolveTasksAccess({ capability: hosted(true), role: "owner", allowedBefore: false }),
    ).toEqual({ allowed: true, denied: false });
    expect(
      resolveTasksAccess({ capability: hosted(false), role: "viewer", allowedBefore: true }),
    ).toEqual({ allowed: false, denied: true });
  });

  it("keeps tasks allowed before through stale authorization or a relay gap", () => {
    // The relay is reconnecting: the capability refuses, the role still allows.
    expect(
      resolveTasksAccess({ capability: hosted(false), role: "owner", allowedBefore: true }),
    ).toEqual({ allowed: true, denied: false });
    // A failed directory refresh forgets the role for a moment.
    expect(
      resolveTasksAccess({ capability: hosted(false), role: null, allowedBefore: true }),
    ).toEqual({ allowed: true, denied: false });
    // Never allowed yet: wait, without calling it a denial.
    expect(
      resolveTasksAccess({ capability: hosted(false), role: null, allowedBefore: false }),
    ).toEqual({ allowed: false, denied: false });
  });
});
