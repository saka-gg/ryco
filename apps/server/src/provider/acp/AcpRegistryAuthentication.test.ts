import { describe, expect, it } from "vitest";
import { projectAcpRegistryAuthMethod } from "./AcpRegistrySupport.ts";

describe("ACP authentication metadata", () => {
  it("projects required variable names with secret-safe defaults", () => {
    expect(
      projectAcpRegistryAuthMethod({
        type: "env_var",
        id: "key",
        name: "API Key",
        vars: [
          { name: "API_KEY" },
          { name: "ENDPOINT", optional: true, secret: false, label: "Endpoint" },
        ],
        _meta: { token: "secret" },
        link: "https://example.com/secret",
      }),
    ).toEqual({
      type: "env_var",
      id: "key",
      name: "API Key",
      variables: [
        { name: "API_KEY", optional: false, secret: true },
        { name: "ENDPOINT", optional: true, secret: false, label: "Endpoint" },
      ],
    });
  });
  it("never projects terminal arguments, environment, or extension payloads", () => {
    expect(
      projectAcpRegistryAuthMethod({
        type: "terminal",
        id: "cli",
        name: "CLI",
        args: ["--token", "secret"],
        env: { API_KEY: "secret" },
        _meta: { token: "secret" },
      }),
    ).toEqual({ type: "terminal", id: "cli", name: "CLI" });
  });
  it("retains ordinary negotiated agent methods", () => {
    expect(
      projectAcpRegistryAuthMethod({
        id: "login",
        name: "Login",
        description: "Open the agent login",
      }),
    ).toEqual({ type: "agent", id: "login", name: "Login", description: "Open the agent login" });
  });
});
