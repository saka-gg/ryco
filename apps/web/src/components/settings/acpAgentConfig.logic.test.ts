import { describe, expect, it } from "vite-plus/test";

import {
  acpLocalCommandError,
  isAcpAgentConfigComplete,
  localCommandConfig,
  readAcpAgentConfig,
  registryAgentConfig,
  sameArguments,
  settlePublishedCommands,
} from "./acpAgentConfig.logic";

describe("readAcpAgentConfig", () => {
  it("reads saved registry configs, including ones from before local commands", () => {
    expect(readAcpAgentConfig({ agentId: "example", version: "1.2.3" })).toEqual({
      source: "registry",
      agentId: "example",
      version: "1.2.3",
      command: "",
      args: [],
    });
    expect(readAcpAgentConfig(undefined).source).toBe("registry");
    expect(readAcpAgentConfig({ source: "npx" }).source).toBe("registry");
  });

  it("keeps local arguments verbatim and drops values that are not strings", () => {
    expect(
      readAcpAgentConfig({ source: "local", command: "gemini", args: [" $(x) ; ", "", 3, null] }),
    ).toMatchObject({ source: "local", command: "gemini", args: [" $(x) ; ", ""] });
  });
});

describe("isAcpAgentConfigComplete", () => {
  it("needs a pinned agent for the registry and an executable for a local command", () => {
    expect(isAcpAgentConfigComplete({})).toBe(false);
    expect(isAcpAgentConfigComplete({ agentId: "example" })).toBe(false);
    expect(isAcpAgentConfigComplete({ agentId: "example", version: "1.2.3" })).toBe(true);
    expect(isAcpAgentConfigComplete({ source: "local", agentId: "a", version: "1" })).toBe(false);
    expect(isAcpAgentConfigComplete({ source: "local", command: "   " })).toBe(false);
    expect(isAcpAgentConfigComplete({ source: "local", command: "./agent" })).toBe(false);
    expect(isAcpAgentConfigComplete({ source: "local", command: "gemini" })).toBe(true);
  });
});

describe("acpLocalCommandError", () => {
  it.each([
    "gemini",
    "/usr/local/bin/gemini",
    "~/bin/agent",
    "C:\\tools\\agent.exe",
    "\\\\srv\\a",
    "",
  ])("accepts %j", (command) => expect(acpLocalCommandError(command)).toBeNull());

  it.each(["./agent", "bin/agent", "..\\agent", "~user/bin/agent"])("flags %j", (command) =>
    expect(acpLocalCommandError(command)).toBe("Use an absolute path or a command name on PATH."),
  );

  it("flags input the node would refuse to decode", () => {
    expect(acpLocalCommandError("agent\0")).not.toBeNull();
    expect(acpLocalCommandError(`/${"a".repeat(4096)}`)).not.toBeNull();
  });
});

describe("localCommandConfig", () => {
  it("drops registry fields, trims the executable and copies the arguments as given", () => {
    const args = ["--acp", " literal $(x) ; ", ""];
    const config = localCommandConfig(
      { agentId: "example", version: "1.2.3" },
      { command: "  /opt/agent  ", args },
    );
    expect(config).toEqual({ source: "local", command: "/opt/agent", args });
    expect(config.args).not.toBe(args);
    expect(localCommandConfig(undefined, { command: "gemini", args: [] })).toEqual({
      source: "local",
      command: "gemini",
      args: [],
    });
  });

  it("keeps the keys it does not own, such as the instance's custom models", () => {
    const current = {
      source: "local",
      command: "/opt/agent",
      args: ["--acp"],
      customModels: ["fast", "deep"],
      authMethodId: "browser",
    };
    expect(localCommandConfig(current, { command: "/opt/agent", args: ["--stdio"] })).toEqual({
      source: "local",
      command: "/opt/agent",
      args: ["--stdio"],
      customModels: ["fast", "deep"],
      authMethodId: "browser",
    });
    expect(current.args).toEqual(["--acp"]);
  });
});

describe("registryAgentConfig", () => {
  it("pins the install, drops local command fields and keeps every other key", () => {
    expect(
      registryAgentConfig(
        { agentId: "example", version: "1.0.0", customModels: ["fast"], args: ["--acp"] },
        { agentId: "example", version: "1.2.3" },
      ),
    ).toEqual({ agentId: "example", version: "1.2.3", customModels: ["fast"] });
    expect(registryAgentConfig({}, { agentId: "example", version: "1.2.3" })).toEqual({
      agentId: "example",
      version: "1.2.3",
    });
  });
});

describe("settlePublishedCommands", () => {
  const first = { command: "gemini", args: [""] };
  const second = { command: "gemini", args: ["--acp"] };
  const third = { command: "gemini", args: ["--acp", ""] };

  it("settles an echo and every edit before it, keeping the later ones", () => {
    expect(settlePublishedCommands([first, second, third], { ...first, args: [""] })).toEqual([
      second,
      third,
    ]);
    expect(settlePublishedCommands([second, third], second)).toEqual([third]);
    expect(settlePublishedCommands([first, second, third], third)).toEqual([]);
  });

  it("takes the oldest match, so a command published twice waits for both echoes", () => {
    expect(settlePublishedCommands([first, second, first], first)).toEqual([second, first]);
  });

  it("reports a command that was never published as an outside change", () => {
    expect(settlePublishedCommands([], first)).toBeNull();
    expect(settlePublishedCommands([first, second], { command: "other", args: [""] })).toBeNull();
  });
});

describe("sameArguments", () => {
  it("compares arguments by position and exact text", () => {
    expect(sameArguments(["a", ""], ["a", ""])).toBe(true);
    expect(sameArguments(["a"], ["a", ""])).toBe(false);
    expect(sameArguments(["a "], ["a"])).toBe(false);
  });
});
