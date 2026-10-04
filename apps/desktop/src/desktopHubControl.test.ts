import { createDesktopHubControlClient, DesktopHubControlError } from "./desktopHubControl.ts";
import { describe, expect, it, vi } from "vite-plus/test";

const token = "A".repeat(43);
const descriptor = {
  protocolVersion: 1,
  state: "prepared",
  hubOrigin: "https://hub.example.test",
  environmentId: `env_${"B".repeat(22)}`,
  label: "Ada's Mac",
  platformOs: "darwin",
  platformArch: "arm64",
  clientVersion: "0.1.8",
  algorithm: "ed25519",
  publicKey: "A".repeat(43),
  fingerprint: `SHA256:${"A".repeat(43)}`,
} as const;

describe("Desktop main-only Hub control client", () => {
  it("posts with the child credential, no ambient credentials, and strict response decoding", async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      Response.json(descriptor),
    );
    const client = createDesktopHubControlClient({
      baseUrl: () => "http://127.0.0.1:13773",
      controlToken: () => token,
      fetch,
    });
    await expect(client.nodeClaimDescriptor()).resolves.toEqual(descriptor);
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe("http://127.0.0.1:13773/api/desktop/hub/native-node-claim/descriptor");
    expect(init).toMatchObject({ method: "POST", redirect: "error", credentials: "omit" });
    expect(new Headers(init?.headers).get("x-ryco-desktop-control")).toBe(token);
    expect(init?.body).toBeUndefined();

    fetch.mockResolvedValueOnce(Response.json({ ...descriptor, extra: true }));
    await expect(client.nodeClaimDescriptor()).rejects.toBeInstanceOf(DesktopHubControlError);
  });

  it("asks the child whether the Hub can reach this node", async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      Response.json({ protocolVersion: 1, reachable: true, connectorEnabled: true }),
    );
    const client = createDesktopHubControlClient({
      baseUrl: () => "http://127.0.0.1:13773",
      controlToken: () => token,
      fetch,
    });
    await expect(client.hubReachability()).resolves.toEqual({
      protocolVersion: 1,
      reachable: true,
      connectorEnabled: true,
    });
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe("http://127.0.0.1:13773/api/desktop/hub/reachability");
    expect(new Headers(init?.headers).get("x-ryco-desktop-control")).toBe(token);

    fetch.mockResolvedValueOnce(Response.json({}, { status: 404 }));
    await expect(client.hubReachability()).rejects.toMatchObject({
      code: "local_control_unavailable",
    });
  });

  it("collapses authentication and unavailable errors while preserving stable conflicts", async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      Response.json({ error: "local_introduction_conflict" }, { status: 409 }),
    );
    const client = createDesktopHubControlClient({
      baseUrl: () => "http://127.0.0.1:13773",
      controlToken: () => token,
      fetch,
    });
    await expect(client.localIntroductionDescriptor()).rejects.toMatchObject({
      code: "local_introduction_conflict",
    });

    const missing = createDesktopHubControlClient({
      baseUrl: () => "http://127.0.0.1:13773",
      controlToken: () => "",
      fetch,
    });
    await expect(missing.nodeClaimDescriptor()).rejects.toMatchObject({
      code: "local_control_unavailable",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
