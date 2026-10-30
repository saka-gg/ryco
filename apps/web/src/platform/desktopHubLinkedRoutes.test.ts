import { EnvironmentId } from "@ryco/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const remote = vi.hoisted(() => ({
  descriptors: new Map<string, string>(),
  wsUrl: vi.fn(),
  authError: class AuthError extends Error {},
}));
const catalog = vi.hoisted(() => ({
  linked: [] as Array<Record<string, unknown>>,
  bearers: new Map<string, string>(),
  removed: [] as string[],
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
  removeSavedEnvironmentBearerToken: async (environmentId: string) => {
    catalog.bearers.delete(environmentId);
  },
  useSavedEnvironmentRegistryStore: {
    getState: () => ({
      remove: (environmentId: string) => {
        catalog.removed.push(environmentId);
        catalog.linked = catalog.linked.filter((record) => record.environmentId !== environmentId);
      },
    }),
  },
}));

import {
  createDesktopHubLinkedRoutes,
  requestDesktopHubRouteCheck,
  forgetDesktopHubLinkedDirectAccess,
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
  catalog.removed = [];
  catalog.bearers = new Map([[DIRECT, "linked-bearer"]]);
});

afterEach(() => {
  requestDesktopHubRouteCheck(HUB);
});

describe("Desktop's routes to a Hub machine", () => {
  it("takes the best linked address that answers as the machine, with the linked bearer", async () => {
    catalog.linked = [linked("http://100.64.1.20:3773"), linked("https://studio.tail1.ts.net")];
    remote.descriptors.set("http://100.64.1.20:3773", DIRECT);
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
    catalog.linked = [linked("http://100.64.1.20:3773")];
    remote.descriptors.set("http://100.64.1.20:3773", "env-someone-else");

    expect(await createDesktopHubLinkedRoutes(HUB).resolve(signal())).toBeNull();
    expect(remote.wsUrl).not.toHaveBeenCalled();
  });

  it("uses no link that names another Hub machine or is due for renewal", async () => {
    catalog.linked = [
      linked("http://100.64.1.20:3773", {
        hubLink: { hubEnvironmentId: "env_other", linkedAt: new Date().toISOString() },
      }),
      linked("http://100.64.1.21:3773", {
        hubLink: { hubEnvironmentId: HUB, linkedAt: "2026-01-01T00:00:00.000Z" },
      }),
    ];
    remote.descriptors.set("http://100.64.1.20:3773", DIRECT);
    remote.descriptors.set("http://100.64.1.21:3773", DIRECT);

    expect(await createDesktopHubLinkedRoutes(HUB).resolve(signal())).toBeNull();
  });

  it("holds back an address whose bearer the machine refused until the link changes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      catalog.linked = [linked("http://100.64.1.20:3773")];
      remote.descriptors.set("http://100.64.1.20:3773", DIRECT);
      remote.wsUrl.mockRejectedValueOnce(new remote.authError("401"));
      const onRefused = vi.fn();
      const routes = createDesktopHubLinkedRoutes(HUB, { onRefused });

      expect(await routes.resolve(signal())).toBeNull();
      expect(onRefused).toHaveBeenCalledTimes(1);
      // Not on a timer: hours later it is still held, so a healthy relay
      // connection is never dropped for the same refusal.
      vi.setSystemTime(Date.now() + 6 * 60 * 60 * 1000);
      catalog.linked = [
        linked("http://100.64.1.20:3773", {
          hubLink: { hubEnvironmentId: HUB, linkedAt: new Date(Date.now() - 60_000).toISOString() },
        }),
      ];
      expect(await routes.resolve(signal())).toBeNull();
      expect(remote.wsUrl).toHaveBeenCalledTimes(1);

      // Relinked (renewed over the relay): the address is tried again.
      requestDesktopHubRouteCheck(HUB);
      expect(await routes.resolve(signal())).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("never sends the bearer to a plain LAN address, even one that answers as the machine", async () => {
    catalog.linked = [linked("http://192.168.1.20:3773")];
    remote.descriptors.set("http://192.168.1.20:3773", DIRECT);

    expect(await createDesktopHubLinkedRoutes(HUB).resolve(signal())).toBeNull();
    expect(remote.wsUrl).not.toHaveBeenCalled();
  });

  it("forgets a machine's links and their bearers on Remove direct access, or all on sign-out", async () => {
    catalog.linked = [
      linked("http://100.64.1.20:3773"),
      linked("http://100.64.1.30:3773", {
        environmentId: "env-other-direct",
        hubLink: { hubEnvironmentId: "env_other_hub", linkedAt: new Date().toISOString() },
      }),
    ];
    catalog.bearers.set("env-other-direct", "other-bearer");

    await forgetDesktopHubLinkedDirectAccess(HUB);
    expect(catalog.removed).toEqual([DIRECT]);
    expect(catalog.bearers.has(DIRECT)).toBe(false);
    expect(catalog.bearers.get("env-other-direct")).toBe("other-bearer");

    await forgetDesktopHubLinkedDirectAccess();
    expect(catalog.removed).toEqual([DIRECT, "env-other-direct"]);
    expect(catalog.bearers.size).toBe(0);
  });
});
