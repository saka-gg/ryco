import type { EnvironmentId, ThreadId } from "@ryco/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  forgetEnvironmentSavedThreadBodies,
  forgetSavedThreadBody,
  hasSavedThreadBody,
  installSavedThreadBodyLoader,
  replaceSavedThreadBodyKeys,
  requestSavedThreadBody,
  setEnvironmentSavedThreadBodyKeys,
} from "./savedThreadBodies";

const envA = "env-a" as EnvironmentId;
const envB = "env-b" as EnvironmentId;
const t1 = "t1" as ThreadId;
const t2 = "t2" as ThreadId;

afterEach(() => {
  installSavedThreadBodyLoader(null);
  replaceSavedThreadBodyKeys([]);
});

describe("saved thread bodies", () => {
  it("runs a request made before the cache started once it does, and later ones at once", async () => {
    requestSavedThreadBody(envA, t1);
    const loader = vi.fn(async () => undefined);
    installSavedThreadBodyLoader(loader);
    expect(loader).toHaveBeenCalledExactlyOnceWith(envA, t1);
    requestSavedThreadBody(envB, t2);
    expect(loader).toHaveBeenLastCalledWith(envB, t2);
  });

  it("forgets a thread's body when reading it fails", async () => {
    replaceSavedThreadBodyKeys([[envA, t1]]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    installSavedThreadBodyLoader(async () => {
      throw new Error("disk");
    });
    requestSavedThreadBody(envA, t1);
    await vi.waitFor(() => expect(hasSavedThreadBody(envA, t1)).toBe(false));
    warn.mockRestore();
  });

  it("tracks which threads have a saved body, per machine", () => {
    replaceSavedThreadBodyKeys([
      [envA, t1],
      [envA, t2],
      [envB, t1],
    ]);
    expect(hasSavedThreadBody(envA, t2)).toBe(true);
    setEnvironmentSavedThreadBodyKeys(envA, [t2]);
    expect(hasSavedThreadBody(envA, t1)).toBe(false);
    expect(hasSavedThreadBody(envB, t1)).toBe(true);
    forgetSavedThreadBody(envA, t2);
    expect(hasSavedThreadBody(envA, t2)).toBe(false);
    forgetEnvironmentSavedThreadBodies(envB);
    expect(hasSavedThreadBody(envB, t1)).toBe(false);
  });
});
