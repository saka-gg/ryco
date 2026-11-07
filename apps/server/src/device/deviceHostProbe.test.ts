import { describe, expect, it } from "vitest";

import packageJson from "../../package.json" with { type: "json" };
import { parseRycoVersion, probeDeviceHost, type ProbeRun } from "./deviceHostProbe.ts";

const host = {
  name: "Studio",
  target: "me@studio.local",
  port: 2222,
  executable: "/opt/homebrew/bin/ryco",
};
const probe = (result: Partial<ProbeRun>) => {
  const calls: (readonly string[])[] = [];
  return {
    calls,
    result: probeDeviceHost(host, {
      run: async (_command, args) => {
        calls.push(args);
        return { code: 0, stdout: "", stderr: "", timedOut: false, ...result };
      },
      now: () => 0,
    }),
  };
};

describe("Test connection", () => {
  it("runs only the version over the device host's strict SSH options", async () => {
    const { calls, result } = probe({ stdout: `ryco v${packageJson.version}\n` });
    expect((await result).stage).toBe("ok");
    const args = calls[0]!;
    expect(args).toContain("BatchMode=yes");
    expect(args).toContain("StrictHostKeyChecking=yes");
    expect(args).toContain("ForwardAgent=no");
    expect(args.at(-1)).toBe("exec '/opt/homebrew/bin/ryco' --version");
  });

  it("names the stage that failed", async () => {
    expect(
      await probe({ code: 255, stderr: "Host key verification failed." }).result,
    ).toMatchObject({
      stage: "ssh",
      message: expect.stringContaining("Host key verification failed."),
    });
    expect((await probe({ timedOut: true, code: null }).result).stage).toBe("ssh");
    expect((await probe({ code: 127, stderr: "not found" }).result).stage).toBe("executable");
    expect((await probe({ code: 0, stdout: "hello" }).result).stage).toBe("executable");
    expect(await probe({ stdout: "ryco v0.0.1" }).result).toMatchObject({
      stage: "version",
      remoteVersion: "0.0.1",
      localVersion: packageJson.version,
    });
  });

  it("refuses a host that is not a valid configuration before running ssh", async () => {
    await expect(
      probeDeviceHost(
        { ...host, executable: "ryco; rm -rf /" },
        { run: async () => ({ code: 0, stdout: "", stderr: "", timedOut: false }) },
      ),
    ).rejects.toThrow();
  });

  it("reads versions with and without a prerelease", () => {
    expect(parseRycoVersion("ryco v0.1.37")).toBe("0.1.37");
    expect(parseRycoVersion("1.2.3-beta.1")).toBe("1.2.3-beta.1");
    expect(parseRycoVersion("nope")).toBeNull();
  });
});
