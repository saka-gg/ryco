import type { EnvironmentId } from "@ryco/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  purgeEnvironmentDeviceData,
  registerEnvironmentDevicePurge,
  resetEnvironmentDevicePurgesForTests,
} from "./environmentDevicePurge";

const ENV = "env-1" as EnvironmentId;

describe("environment device purges", () => {
  afterEach(() => resetEnvironmentDevicePurgesForTests());

  it("runs every registered purge, even after one fails, until unregistered", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const seen: string[] = [];
    registerEnvironmentDevicePurge(() => {
      throw new Error("boom");
    });
    const unregister = registerEnvironmentDevicePurge(async (id) => {
      seen.push(id);
    });
    await purgeEnvironmentDeviceData(ENV);
    expect(seen).toEqual([ENV]);
    unregister();
    await purgeEnvironmentDeviceData(ENV);
    expect(seen).toEqual([ENV]);
    warn.mockRestore();
  });
});
