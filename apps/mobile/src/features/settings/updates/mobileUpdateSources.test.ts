import { EnvironmentId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import { mobileUpdateSource } from "./mobileUpdateSources";

const machine = {
  environmentId: EnvironmentId.make("node"),
  label: "Build box",
  connectionState: "connected",
  role: "owner",
  mutationReady: true,
};
const state = { config: null, shellCurrent: true, nodeUpdate: null };

describe("mobileUpdateSource", () => {
  it("lets only the owner of a connected, ready machine update it", () => {
    expect(mobileUpdateSource(machine, state)).toMatchObject({ live: true, canMutate: true });
    expect(mobileUpdateSource({ ...machine, role: "operator" }, state).canMutate).toBe(false);
    expect(mobileUpdateSource({ ...machine, mutationReady: false }, state).canMutate).toBe(false);
    expect(mobileUpdateSource({ ...machine, connectionState: "connecting" }, state)).toMatchObject({
      live: false,
      canMutate: false,
    });
  });

  it("does not trust running chats until the machine's shell is current", () => {
    expect(mobileUpdateSource(machine, { ...state, shellCurrent: false }).live).toBe(false);
  });
});
