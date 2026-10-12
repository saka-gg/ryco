import { describe, expect, it } from "vite-plus/test";

import { validateCloudflareAccessCredentials } from "./cliProxyHubCredentials.ts";

describe("validateCloudflareAccessCredentials", () => {
  it("allows no token, a complete token, or a saved secret", () => {
    expect(validateCloudflareAccessCredentials({})).toBeNull();
    expect(
      validateCloudflareAccessCredentials({ clientId: "token.access", clientSecret: "secret" }),
    ).toBeNull();
    expect(
      validateCloudflareAccessCredentials({ clientId: "token.access", hasSavedSecret: true }),
    ).toBeNull();
  });

  it("rejects incomplete pairs and malformed header values", () => {
    for (const input of [
      { clientId: "token.access" },
      { clientSecret: "secret" },
      { hasSavedSecret: true },
    ]) {
      expect(validateCloudflareAccessCredentials(input)).toContain("Enter both");
    }
    for (const clientSecret of ["one two", "one\r\nX-Evil: two", "sëcret"]) {
      expect(
        validateCloudflareAccessCredentials({ clientId: "token.access", clientSecret }),
      ).toContain("must not contain");
    }
  });
});
