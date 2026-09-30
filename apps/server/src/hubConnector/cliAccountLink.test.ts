import { HostedHubApiError } from "@ryco/client-runtime/authorization";
import { describe, expect, it } from "vite-plus/test";

import {
  AccountLinkError,
  approveOwnEnrollment,
  createCliHubAccount,
  describeAccountLinkFailure,
  type CliHubAccount,
} from "./cliAccountLink.ts";

const fingerprint = `SHA256:${"A".repeat(43)}`;

function fakeApi(enrollmentFingerprint: string) {
  const approved: string[] = [];
  const api = {
    lookupNodeEnrollment: async () => ({ fingerprint: enrollmentFingerprint }),
    approveNodeEnrollment: async (deviceCode: string) => {
      approved.push(deviceCode);
    },
  } as unknown as CliHubAccount["api"];
  return { api, approved };
}

describe("ryco hub login", () => {
  it("approves the node's own enrollment when the fingerprints match", async () => {
    const { api, approved } = fakeApi(fingerprint);
    await approveOwnEnrollment(api, { deviceCode: "ABCD-1234", fingerprint });
    expect(approved).toEqual(["ABCD-1234"]);
  });

  it("never approves an enrollment whose key is not this node's", async () => {
    const { api, approved } = fakeApi(`SHA256:${"B".repeat(43)}`);
    await expect(
      approveOwnEnrollment(api, { deviceCode: "ABCD-1234", fingerprint }),
    ).rejects.toBeInstanceOf(AccountLinkError);
    expect(approved).toEqual([]);
  });

  it("explains Hub refusals without echoing them", () => {
    expect(describeAccountLinkFailure(new HostedHubApiError("not_found", 404))).toContain(
      "ryco hub enroll",
    );
    expect(describeAccountLinkFailure(new HostedHubApiError("unauthorized", 401))).toContain(
      "passkey",
    );
    expect(describeAccountLinkFailure(new HostedHubApiError("rate_limited", 429))).toContain(
      "Too many",
    );
    expect(describeAccountLinkFailure(new TypeError("fetch failed"))).toContain(
      "could not be reached",
    );
  });

  it("signs Hub requests with a fresh DPoP proof and no stored credential", async () => {
    const requests: { url: string; headers: Headers }[] = [];
    const fakeFetch = async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), headers: new Headers(init?.headers) });
      return Response.json({ error: "not_found" }, { status: 404 });
    };
    const account = await createCliHubAccount("https://hub.example", fakeFetch as typeof fetch);
    await expect(
      account.api.startNativeIdentityPasswordLogin({
        kind: "username",
        username: "someone" as never,
        password: "correct horse battery" as never,
      }),
    ).rejects.toBeInstanceOf(HostedHubApiError);
    expect(requests[0]?.url).toBe("https://hub.example/api/auth/native/identity/password/start");
    const proof = requests[0]?.headers.get("DPoP") ?? "";
    const header = JSON.parse(Buffer.from(proof.split(".")[0]!, "base64url").toString());
    expect(header).toMatchObject({
      typ: "dpop+jwt",
      alg: "ES256",
      jwk: { kty: "EC", crv: "P-256" },
    });
    expect(header.jwk.d).toBeUndefined();
    expect(requests[0]?.headers.get("Authorization")).toBeNull();
  });
});
