import { EnvironmentId } from "@ryco/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const remote = vi.hoisted(() => ({
  descriptors: new Map<string, string>(),
  wsUrl: vi.fn(),
  authError: class AuthError extends Error {},
}));
const catalog = vi.hoisted(() => ({
  linked: [] as unknown[],
  bearers: new Map<string, string>(),
}));

vi.mock("../environments/remote/api", () => ({
  fetchRemoteEnvironmentDescriptor: async ({ httpBaseUrl }: { httpBaseUrl: string }) => {
    const environmentId = remote.descriptors.get(httpBaseUrl);
    if (environmentId === undefined) throw new Error("unreachable");
    return { environmentId };
  },
  resolveRemoteWebSocketConnectionUrl: remote.wsUrl,
  isRemoteEnvironmentAuthHttpError: (error: unknown) => error instanceof remote.authError,
}));
vi.mock("../environments/runtime/catalog", () => ({
  listLinkedDirectRecords: () => catalog.linked,
  readSavedEnvironmentBearerToken: async (environmentId: string) =>
    catalog.bearers.get(environmentId) ?? null,
}));

import {
  createDesktopHubLinkedRoutes,
  requestDesktopHubRouteCheck,
} from "./desktopHubLinkedRoutes";

const HUB = EnvironmentId.make("env_hub");
const DIRECT = "env-direct";

function linked(httpBaseUrl: string, overrides: Record<string, unknown> = {}) {
  return {
    environmentId: DIRECT,
    label: "Studio",
    httpBaseUrl,
    wsBaseUrl: httpBaseUrl.replace(/^http/u, "ws"),
    createdAt: "2026-10-20T00:00:00.000Z",
    lastConnectedAt: null,
    hubLink: { hubEnvironmentId: HUB, linkedAt: new Date(Date.now() - 60_000).toISOString() },
    ...overrides,
  };
}

const signal = () => new AbortController().signal;

beforeEach(() => {
  remote.descriptors.clear();
  remote.wsUrl.mockReset();
  remote.wsUrl.mockImplementation(
    async ({ wsBaseUrl, bearerToken }: { wsBaseUrl: string; bearerToken: string }) =>
      `${wsBaseUrl}/anything?wsToken=${bearerToken}-token`,
  );
  catalog.linked = [];
  catalog.bearers = new Map([[DIRECT, "linked-bearer"]]);
});

afterEach(() => {
  requestDesktopHubRouteCheck(HUB);
});

describe("Desktop's routes to a Hub machine", () => {
  it("takes the best linked address that answers as the machine, with the linked bearer", async () => {
    catalog.linked = [linked("http://192.168.1.20:3773"), linked("https://studio.tail1.ts.net")];
    remote.descriptors.set("http://192.168.1.20:3773", DIRECT);
    remote.descriptors.set("https://studio.tail1.ts.net", DIRECT);

    const route = await createDesktopHubLinkedRoutes(HUB).resolve(signal());

    expect(route).toEqual({
      routeKey: "https://studio.tail1.ts.net",
      url: "wss://studio.tail1.ts.net/ws?wsToken=linked-bearer-token",
    });
    expect(remote.wsUrl).toHaveBeenCalledWith(
      expect.objectContaining({ bearerToken: "linked-bearer" }),
    );
  });

  it("sends no credential to an address that answers as another machine, and falls back to the relay", async () => {
    catalog.linked = [linked("http://192.168.1.20:3773")];
    remote.descriptors.set("http://192.168.1.20:3773", "env-someone-else");

    expect(await createDesktopHubLinkedRoutes(HUB).resolve(signal())).toBeNull();
    expect(remote.wsUrl).not.toHaveBeenCalled();
  });

  it("uses no link that names another Hub machine or is due for renewal", async () => {
    catalog.linked = [
      linked("http://192.168.1.20:3773", {
        hubLink: { hubEnvironmentId: "env_other", linkedAt: new Date().toISOString() },
      }),
      linked("http://192.168.1.21:3773", {
        hubLink: { hubEnvironmentId: HUB, linkedAt: "2026-01-01T00:00:00.000Z" },
      }),
    ];
    remote.descriptors.set("http://192.168.1.20:3773", DIRECT);
    remote.descriptors.set("http://192.168.1.21:3773", DIRECT);

    expect(await createDesktopHubLinkedRoutes(HUB).resolve(signal())).toBeNull();
  });

  it("holds back an address whose bearer the machine refused until the link changes", async () => {
    catalog.linked = [linked("http://192.168.1.20:3773")];
    remote.descriptors.set("http://192.168.1.20:3773", DIRECT);
    remote.wsUrl.mockRejectedValueOnce(new remote.authError("401"));
    const routes = createDesktopHubLinkedRoutes(HUB);

    expect(await routes.resolve(signal())).toBeNull();
    expect(await routes.resolve(signal())).toBeNull();
    expect(remote.wsUrl).toHaveBeenCalledTimes(1);

    // Relinked (renewed over the relay): the address is tried again.
    requestDesktopHubRouteCheck(HUB);
    expect(await routes.resolve(signal())).not.toBeNull();
  });
});
