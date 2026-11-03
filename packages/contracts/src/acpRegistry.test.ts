import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { ACP_LOCAL_COMMAND_MAX_ARGS, AcpRegistrySettings } from "./acpRegistry.ts";

const decode = Schema.decodeUnknownSync(AcpRegistrySettings);
const encode = Schema.encodeSync(AcpRegistrySettings);

describe("ACP agent settings", () => {
  it("decodes an empty config as an unconfigured registry agent", () => {
    expect(decode({})).toEqual({
      agentId: "",
      version: "",
      source: "registry",
      command: "",
      args: [],
    });
  });

  it("keeps saved registry configs pointing at the registry", () => {
    const legacy = { agentId: "example-agent", version: "1.2.3", authMethodId: "login" };
    const decoded = decode(legacy);
    expect(decoded).toMatchObject({ ...legacy, source: "registry", command: "", args: [] });
    expect(decode(encode(decoded))).toEqual(decoded);
  });

  it("keeps local command arguments verbatim", () => {
    const args = ["--acp", " literal $(x) ; ", "", "*.ts", "$HOME"];
    expect(decode({ source: "local", command: "/opt/agent/bin/agent", args })).toMatchObject({
      source: "local",
      command: "/opt/agent/bin/agent",
      args,
    });
  });

  it("rejects NUL bytes, oversized values and too many arguments", () => {
    expect(() => decode({ source: "local", command: "/bin/agent\0--flag" })).toThrow();
    expect(() => decode({ source: "local", command: "/bin/agent", args: ["a\0b"] })).toThrow();
    expect(() => decode({ source: "local", command: "a".repeat(4097) })).toThrow();
    expect(() => decode({ source: "local", command: "agent", args: ["a".repeat(4097)] })).toThrow();
    const max = Array.from({ length: ACP_LOCAL_COMMAND_MAX_ARGS }, (_, index) => `${index}`);
    expect(decode({ source: "local", command: "agent", args: max }).args).toHaveLength(64);
    expect(() => decode({ source: "local", command: "agent", args: [...max, "65"] })).toThrow();
  });

  it("rejects unknown sources", () => {
    expect(() => decode({ source: "npx", command: "agent" })).toThrow();
  });
});
