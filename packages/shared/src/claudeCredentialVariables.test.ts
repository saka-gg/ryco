import { describe, expect, it } from "vite-plus/test";

import {
  CLAUDE_NON_LOGIN_CREDENTIAL_VARIABLES,
  CLAUDE_THIRD_PARTY_PROVIDER_FLAGS,
  claudeNonLoginCredentialSource,
} from "./claudeCredentialVariables.ts";

describe("claudeNonLoginCredentialSource", () => {
  it("names a credential set to a non-empty value", () => {
    for (const name of CLAUDE_NON_LOGIN_CREDENTIAL_VARIABLES) {
      expect(claudeNonLoginCredentialSource({ [name]: "value" })).toBe(name);
      expect(claudeNonLoginCredentialSource({ [name]: "  " })).toBeUndefined();
    }
  });

  it("names a provider flag only when it is on", () => {
    for (const name of CLAUDE_THIRD_PARTY_PROVIDER_FLAGS) {
      for (const on of ["1", "true", "Yes", " ON "]) {
        expect(claudeNonLoginCredentialSource({ [name]: on })).toBe(name);
      }
      for (const off of ["0", "false", "no", ""]) {
        expect(claudeNonLoginCredentialSource({ [name]: off })).toBeUndefined();
      }
    }
  });

  it("names a CLIProxyAPI hub by its token, and nothing for a plain environment", () => {
    expect(
      claudeNonLoginCredentialSource({
        ANTHROPIC_BASE_URL: "https://hub.example.test",
        ANTHROPIC_AUTH_TOKEN: "token",
      }),
    ).toBe("ANTHROPIC_AUTH_TOKEN");
    expect(claudeNonLoginCredentialSource({ HOME: "/home/a", PATH: "/usr/bin" })).toBeUndefined();
  });
});
