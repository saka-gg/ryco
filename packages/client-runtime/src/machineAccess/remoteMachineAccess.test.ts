import { AuthSessionId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import { RemoteEnvironmentAuthHttpError } from "../connection/remoteApi.ts";
import type { HttpClientService, HttpRequestInit } from "../platform/index.ts";
import { createRemoteMachineAccessApi } from "./remoteMachineAccess.ts";

function recordingClient(answer: { readonly status?: number; readonly body: unknown }) {
  const calls: Array<{ readonly url: string; readonly init: HttpRequestInit | undefined }> = [];
  const client: HttpClientService = {
    fetch: async (url, init) => {
      calls.push({ url, init });
      const status = answer.status ?? 200;
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => answer.body,
        text: async () => JSON.stringify(answer.body),
      };
    },
  };
  return { client, calls };
}

const TARGET = { httpBaseUrl: "http://192.168.1.20:3773/", bearerToken: "bearer-1" };

describe("remote machine access api", () => {
  it("mints a labelled code with the saved pairing's bearer", async () => {
    const { client, calls } = recordingClient({
      body: { id: "link-1", credential: "ABCDEFGHJKLM", expiresAt: "2036-04-07T10:05:00.000Z" },
    });
    const result = await createRemoteMachineAccessApi(client).createPairingCredential(
      TARGET,
      "  iPad  ",
    );
    expect(result.id).toBe("link-1");
    expect(calls[0]?.url).toBe("http://192.168.1.20:3773/api/auth/pairing-token");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(calls[0]?.init?.headers).toMatchObject({ authorization: "Bearer bearer-1" });
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ label: "iPad" });
  });

  it("sends an empty body when the code has no label", async () => {
    const { client, calls } = recordingClient({
      body: { id: "link-1", credential: "ABCDEFGHJKLM", expiresAt: "2036-04-07T10:05:00.000Z" },
    });
    await createRemoteMachineAccessApi(client).createPairingCredential(TARGET, "   ");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({});
  });

  it("revokes exactly the link and the session it is given", async () => {
    const { client, calls } = recordingClient({ body: { revoked: true } });
    const api = createRemoteMachineAccessApi(client);
    await api.revokePairingLink(TARGET, "link-9");
    await api.revokeClientSession(TARGET, AuthSessionId.make("session-4"));
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      "/api/auth/pairing-links/revoke",
      "/api/auth/clients/revoke",
    ]);
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ id: "link-9" });
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({ sessionId: "session-4" });
  });

  it("reports how many other sessions were revoked", async () => {
    const { client } = recordingClient({ body: { revokedCount: 3 } });
    await expect(
      createRemoteMachineAccessApi(client).revokeOtherClientSessions(TARGET),
    ).resolves.toBe(3);
  });

  it("surfaces the node's refusal with its status", async () => {
    const { client } = recordingClient({
      status: 403,
      body: { error: "Only owner sessions can manage network access." },
    });
    const failure = createRemoteMachineAccessApi(client).revokePairingLink(TARGET, "link-1");
    await expect(failure).rejects.toBeInstanceOf(RemoteEnvironmentAuthHttpError);
    await expect(failure).rejects.toMatchObject({
      status: 403,
      message: "Only owner sessions can manage network access.",
    });
  });
});
