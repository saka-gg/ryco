import { describe, expect, it } from "vite-plus/test";

import type { HttpClientService } from "../platform/index.ts";
import { RemoteEnvironmentUnreachableError } from "./connectFailure.ts";
import { createRemoteEnvironmentApi } from "./remoteApi.ts";

const issuesToken: HttpClientService = {
  fetch: async () => ({
    ok: true,
    status: 200,
    json: async () => ({ token: "ws-token", expiresAt: "2026-10-30T12:00:00.000Z" }),
    text: async () => "",
  }),
};

describe("remote environment api", () => {
  it("builds a paired machine's socket address without a page origin", async () => {
    // The phone passes "" unless the build pins a server.
    const api = createRemoteEnvironmentApi(issuesToken, "");

    await expect(
      api.resolveRemoteWebSocketConnectionUrl({
        wsBaseUrl: "wss://studio.tail1.ts.net/",
        httpBaseUrl: "https://studio.tail1.ts.net/",
        bearerToken: "bearer",
      }),
    ).resolves.toBe("wss://studio.tail1.ts.net/?wsToken=ws-token");
  });

  it("still resolves a relative socket address against the page origin", async () => {
    const api = createRemoteEnvironmentApi(issuesToken, "https://app.example.com");

    await expect(
      api.resolveRemoteWebSocketConnectionUrl({
        wsBaseUrl: "/ws",
        httpBaseUrl: "https://app.example.com/",
        bearerToken: "bearer",
      }),
    ).resolves.toBe("https://app.example.com/ws?wsToken=ws-token");
  });

  it("reports a machine that never answered in plain words, keeping the URL off the message", async () => {
    const unreachable: HttpClientService = {
      fetch: async () => {
        throw new TypeError("The Internet connection appears to be offline.");
      },
    };
    const api = createRemoteEnvironmentApi(unreachable, "");
    const failure = await api
      .fetchRemoteSessionState({ httpBaseUrl: "http://192.168.68.99:14024", bearerToken: "b" })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(RemoteEnvironmentUnreachableError);
    expect((failure as Error).message).not.toContain("14024");
    expect((failure as RemoteEnvironmentUnreachableError).requestUrl).toBe(
      "http://192.168.68.99:14024/api/auth/session",
    );
  });
});
