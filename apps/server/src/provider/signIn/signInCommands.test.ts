import { ProviderDriverKind, type ProviderInstanceConfig } from "@ryco/contracts";
import {
  CLAUDE_NON_LOGIN_CREDENTIAL_VARIABLES,
  CLAUDE_THIRD_PARTY_PROVIDER_FLAGS,
} from "@ryco/shared/claudeCredentialVariables";
import { describe, expect, it } from "vite-plus/test";

import { planTerminalSignIn } from "./signInCommands.ts";

const instance = (
  driver: string,
  config: Record<string, unknown> = {},
  environment: Record<string, string> = {},
  extra: Partial<ProviderInstanceConfig> = {},
): ProviderInstanceConfig => ({
  driver: ProviderDriverKind.make(driver),
  config,
  environment: Object.entries(environment).map(([name, value]) => ({
    name,
    value,
    sensitive: false,
  })),
  ...extra,
});

/** A node whose own environment sets nothing Claude reads instead of its login. */
const NODE = { PATH: "/usr/bin" };

const launch = (config: ProviderInstanceConfig, baseEnv: NodeJS.ProcessEnv = NODE) => {
  const plan = planTerminalSignIn(config, baseEnv);
  return plan?._tag === "ready" ? { command: plan.command, args: plan.args } : plan;
};

describe("planTerminalSignIn", () => {
  it("runs each CLI's own login, never a shell line", () => {
    expect(launch(instance("claudeAgent"))).toEqual({
      command: "claude",
      args: ["auth", "login"],
    });
    expect(launch(instance("cursor", { enabled: true }))).toEqual({
      command: "agent",
      args: ["login"],
    });
    expect(
      launch(
        instance("cursor", {
          enabled: true,
          binaryPath: "/opt/cursor-agent",
          apiEndpoint: "https://e.test",
        }),
      ),
    ).toEqual({ command: "/opt/cursor-agent", args: ["-e", "https://e.test", "login"] });
    expect(launch(instance("grok"))).toEqual({
      command: "grok",
      args: ["login", "--device-auth"],
    });
    expect(launch(instance("opencode", { binaryPath: "/opt/opencode" }))).toEqual({
      command: "/opt/opencode",
      args: ["auth", "login"],
    });
  });

  it("carries the instance's variables over the node's, and Claude's home", () => {
    const plan = planTerminalSignIn(
      instance("claudeAgent", { homePath: "/srv/claude-home" }, { CLAUDE_CONFIG_DIR: "/srv/cfg" }),
      { ...NODE, HOME: "/home/node" },
    );
    expect(plan).toMatchObject({
      _tag: "ready",
      driver: "claudeAgent",
      homePath: "/srv/claude-home",
      environment: { PATH: "/usr/bin", HOME: "/home/node", CLAUDE_CONFIG_DIR: "/srv/cfg" },
    });
  });

  it("has no terminal sign-in for Codex, Copilot or the ACP Registry", () => {
    expect(planTerminalSignIn(instance("codex"), NODE)).toBeUndefined();
    expect(planTerminalSignIn(instance("copilot"), NODE)).toBeUndefined();
    expect(planTerminalSignIn(instance("acpRegistry"), NODE)).toBeUndefined();
  });

  it("reports settings that do not decode, and a disabled instance", () => {
    expect(planTerminalSignIn(instance("grok", { binaryPath: 42 }), NODE)).toEqual({
      _tag: "invalid",
    });
    expect(planTerminalSignIn(instance("grok", {}, {}, { enabled: false }), NODE)).toEqual({
      _tag: "disabled",
    });
    // Cursor is off unless enabled, as in the registry.
    expect(planTerminalSignIn(instance("cursor"), NODE)).toEqual({ _tag: "disabled" });
  });

  it("refuses Claude for every credential it would use instead, naming it and never its value", () => {
    for (const name of CLAUDE_NON_LOGIN_CREDENTIAL_VARIABLES) {
      const plan = planTerminalSignIn(
        instance("claudeAgent", {}, { [name]: "secret-value-123" }),
        NODE,
      );
      expect(plan?._tag, name).toBe("refused");
      const reason = plan?._tag === "refused" ? plan.reason : "";
      expect(reason).toContain(name);
      expect(reason).not.toContain("secret-value-123");
    }
  });

  it("refuses Claude routed to another provider, but not for a flag that is off", () => {
    for (const name of CLAUDE_THIRD_PARTY_PROVIDER_FLAGS) {
      for (const on of ["1", "true", "YES", " on "]) {
        expect(planTerminalSignIn(instance("claudeAgent", {}, { [name]: on }), NODE)).toMatchObject(
          { _tag: "refused" },
        );
      }
      for (const off of ["0", "false", ""]) {
        expect(planTerminalSignIn(instance("claudeAgent", {}, { [name]: off }), NODE)?._tag).toBe(
          "ready",
        );
      }
    }
    // An empty credential is no credential.
    expect(
      planTerminalSignIn(instance("claudeAgent", {}, { ANTHROPIC_API_KEY: " " }), NODE)?._tag,
    ).toBe("ready");
  });

  it("refuses a Claude instance behind a CLIProxyAPI hub, without its URL or token", () => {
    const plan = planTerminalSignIn(
      instance(
        "claudeAgent",
        {},
        {
          ANTHROPIC_BASE_URL: "https://hub.example.test/claude",
          ANTHROPIC_AUTH_TOKEN: "hub-token-abc",
        },
      ),
      NODE,
    );
    expect(plan).toEqual({
      _tag: "refused",
      reason:
        "Claude uses ANTHROPIC_AUTH_TOKEN, set for this instance or on the node, instead of a claude.ai login, so it has no login to sign in to.",
    });
  });

  it("refuses Claude for a credential in the node's own environment", () => {
    const plan = planTerminalSignIn(instance("claudeAgent"), {
      ...NODE,
      ANTHROPIC_API_KEY: "sk-ambient",
    });
    expect(plan).toMatchObject({ _tag: "refused" });
    expect(plan?._tag === "refused" && plan.reason).toContain("ANTHROPIC_API_KEY");
    // Other drivers ignore Claude's variables.
    expect(
      planTerminalSignIn(instance("grok"), { ...NODE, ANTHROPIC_API_KEY: "sk-ambient" })?._tag,
    ).toBe("ready");
  });

  it("refuses an OpenCode instance that uses an external server", () => {
    expect(
      planTerminalSignIn(instance("opencode", { serverUrl: "http://127.0.0.1:4096" }), NODE),
    ).toEqual({
      _tag: "refused",
      reason: "This instance uses the OpenCode server at its server URL. Sign in on that server.",
    });
  });
});
