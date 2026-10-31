import type { EnvironmentId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import { persistedSavedEnvironmentRecordFields } from "./savedEnvironmentRecord.ts";

const BASE = {
  environmentId: "env-studio" as EnvironmentId,
  label: "Studio Mac",
  wsBaseUrl: "ws://studio.local:3773",
  httpBaseUrl: "http://studio.local:3773",
  createdAt: "2026-10-24T00:00:00.000Z",
  lastConnectedAt: null,
};

describe("persistedSavedEnvironmentRecordFields", () => {
  it("keeps when a machine was switched off, so the next launch leaves it off", () => {
    expect(
      persistedSavedEnvironmentRecordFields({ ...BASE, disabledAt: "2026-10-31T09:00:00.000Z" }),
    ).toEqual({ ...BASE, disabledAt: "2026-10-31T09:00:00.000Z" });
  });

  it("writes no switch for a machine that is on", () => {
    const persisted = persistedSavedEnvironmentRecordFields({ ...BASE, disabledAt: undefined });
    expect(persisted).toEqual(BASE);
    expect("disabledAt" in persisted).toBe(false);
  });

  it("drops fields that are not part of the record, such as a credential", () => {
    const withSecret = { ...BASE, bearerToken: "not-stored-here" };
    expect(persistedSavedEnvironmentRecordFields(withSecret)).toEqual(BASE);
  });
});
