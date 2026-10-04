import { describe, expect, it } from "vite-plus/test";

import { detectMissingOsKeyStore } from "./machine.ts";
import {
  backgroundServicePrompt,
  describeHubKeyStore,
  describeRuns,
  planNodeServiceLinger,
} from "./setupFlow.ts";

describe("ryco setup background service copy", () => {
  it("only promises a start at boot when a systemd user unit can outlive logout", () => {
    // A user unit without lingering starts at login and stops at logout.
    expect(backgroundServicePrompt("systemd", false)).toMatch(/starts when you log in/);
    expect(backgroundServicePrompt("systemd", null)).toMatch(/starts when you log in/);
    expect(backgroundServicePrompt("systemd", true)).toMatch(/starts at boot/);
    expect(backgroundServicePrompt("launchd", null)).toMatch(/starts when you log in/);
  });

  it("says in the summary that a non-lingering systemd node stops at logout", () => {
    expect(
      describeRuns({ background: true, preventSleep: true, platform: "systemd", lingering: false }),
    ).toBe("in the background, stays awake on power, only while you are logged in");
    expect(
      describeRuns({ background: true, preventSleep: false, platform: "systemd", lingering: true }),
    ).toBe("in the background");
    expect(
      describeRuns({ background: true, preventSleep: true, platform: "launchd", lingering: null }),
    ).toBe("in the background, stays awake on power");
    expect(
      describeRuns({
        background: false,
        preventSleep: true,
        platform: "systemd",
        lingering: false,
      }),
    ).toBe("when you start it");
  });
});

describe("planNodeServiceLinger", () => {
  it("offers the exact sudo command when systemd lingering is off", () => {
    expect(
      planNodeServiceLinger({ platform: "systemd", lingering: false, user: "ada", uid: 1000 }),
    ).toEqual({
      kind: "offer",
      command: "sudo",
      args: ["loginctl", "enable-linger", "ada"],
      display: "sudo loginctl enable-linger ada",
    });
    expect(
      planNodeServiceLinger({ platform: "systemd", lingering: false, user: "root", uid: 0 }),
    ).toMatchObject({ kind: "offer", display: "loginctl enable-linger root" });
  });

  it("offers nothing when lingering is on, unknown, or not a systemd concept", () => {
    for (const input of [
      { platform: "systemd" as const, lingering: true, user: "ada", uid: 1000 },
      { platform: "systemd" as const, lingering: null, user: "ada", uid: 1000 },
      { platform: "systemd" as const, lingering: false, user: "", uid: 1000 },
      { platform: "launchd" as const, lingering: null, user: "ada", uid: 501 },
      { platform: null, lingering: undefined, user: "ada", uid: 1000 },
    ]) {
      expect(planNodeServiceLinger(input)).toEqual({ kind: "not-needed" });
    }
  });
});

describe("ryco setup Hub key store", () => {
  it("shows the file fallback in the summary only when the operator chose it", () => {
    expect(
      describeHubKeyStore({ version: 1, hub: { enabled: true, allowFileSecretStore: true } }),
    ).toBe("owner-only file (no system keyring)");
    expect(describeHubKeyStore({ version: 1, hub: { enabled: true } })).toBeNull();
    expect(
      describeHubKeyStore({ version: 1, hub: { enabled: false, allowFileSecretStore: true } }),
    ).toBeNull();
  });

  it("probes for a missing keyring only on Linux and never decides by itself", async () => {
    let probes = 0;
    const failingProbe = async () => {
      probes += 1;
      return false;
    };
    expect(await detectMissingOsKeyStore({ platform: "darwin", probe: failingProbe })).toBe(false);
    expect(await detectMissingOsKeyStore({ platform: "win32", probe: failingProbe })).toBe(false);
    expect(probes).toBe(0);
    expect(await detectMissingOsKeyStore({ platform: "linux", probe: failingProbe })).toBe(true);
    expect(await detectMissingOsKeyStore({ platform: "linux", probe: async () => true })).toBe(
      false,
    );
  });
});
