import { describe, expect, it } from "vitest";

import { signAutomationHookBody, verifyAutomationHookRequest } from "./automationHookSignature.ts";

const secret = "s".repeat(43);
const body = new TextEncoder().encode('{"version":"0.1.45"}');

describe("automation hook signatures", () => {
  it("signs in GitHub's format, as openssl does", () => {
    // printf '%s' '{"version":"0.1.45"}' | openssl dgst -sha256 -hmac sss…s (43 s)
    expect(signAutomationHookBody(secret, body)).toBe(
      "sha256=0be51560cfe968d408ed358df63ea7cd7ac01aec446a52209e7432a476be99a5",
    );
  });

  it("accepts GitHub's header, or Ryco's when GitHub's is absent", () => {
    const signature = signAutomationHookBody(secret, body);
    for (const name of ["x-hub-signature-256", "x-ryco-signature-256"]) {
      expect(
        verifyAutomationHookRequest({
          secret,
          body,
          headers: { [name]: signature },
          allowBearer: false,
        }),
      ).toBe(true);
    }
    // Upper-case hex is the same signature.
    expect(
      verifyAutomationHookRequest({
        secret,
        body,
        headers: { "x-hub-signature-256": `sha256=${signature.slice(7).toUpperCase()}` },
        allowBearer: false,
      }),
    ).toBe(true);
  });

  it("refuses a wrong, malformed or missing signature", () => {
    const signature = signAutomationHookBody(secret, body);
    const wrong = signAutomationHookBody("t".repeat(43), body);
    const cases: Array<Record<string, string>> = [
      { "x-hub-signature-256": wrong },
      { "x-hub-signature-256": signature.slice(0, -1) },
      { "x-hub-signature-256": signature.replace("sha256=", "sha1=") },
      // GitHub's header decides when present, even with a good Ryco one.
      { "x-hub-signature-256": wrong, "x-ryco-signature-256": signature },
      {},
    ];
    for (const headers of cases) {
      expect(verifyAutomationHookRequest({ secret, body, headers, allowBearer: false })).toBe(
        false,
      );
    }
    // A different body.
    expect(
      verifyAutomationHookRequest({
        secret,
        body: new TextEncoder().encode("{}"),
        headers: { "x-hub-signature-256": signature },
        allowBearer: false,
      }),
    ).toBe(false);
  });

  it("takes the bearer secret only on the direct path", () => {
    const headers = { authorization: `Bearer ${secret}` };
    expect(verifyAutomationHookRequest({ secret, body, headers, allowBearer: true })).toBe(true);
    expect(verifyAutomationHookRequest({ secret, body, headers, allowBearer: false })).toBe(false);
    expect(
      verifyAutomationHookRequest({
        secret,
        body,
        headers: { authorization: `Bearer ${"x".repeat(43)}` },
        allowBearer: true,
      }),
    ).toBe(false);
    expect(
      verifyAutomationHookRequest({
        secret,
        body,
        headers: { authorization: `Basic ${secret}` },
        allowBearer: true,
      }),
    ).toBe(false);
  });
});

describe("direct route", () => {
  it("registers the contract's path", async () => {
    const { AUTOMATION_HOOK_NODE_PATH_PREFIX } = await import("@ryco/contracts/automation-hooks");
    const { AUTOMATION_HOOK_ROUTE_PREFIX } = await import("./automationHookHttp.ts");
    expect(AUTOMATION_HOOK_ROUTE_PREFIX).toBe(AUTOMATION_HOOK_NODE_PATH_PREFIX);
  });
});
