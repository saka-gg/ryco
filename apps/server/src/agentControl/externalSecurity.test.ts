import { chmod, mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  AGENT_CONTROL_EXTERNAL_CREDENTIAL_AUDIENCE,
  AgentControlIntegrationId,
} from "@ryco/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  generateAgentControlExternalCredential,
  hashAgentControlExternalSecret,
  pairingCodeHash,
  parseExternalAuthorization,
} from "./externalCredential.ts";
import { makeExternalIntegrationSetup } from "./externalSetup.ts";
import { evaluateExternalMcpTopology } from "./externalTopology.ts";
import {
  discoverExternalRuntimeWithRetries,
  readExternalCredentialFile,
  selectSingleExternalCredential,
  selectSingleExternalRuntime,
  writeExternalCredentialFile,
} from "./ExternalMcp/runtimeFiles.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("external Agent Control credential and topology boundary", () => {
  it("uses a dedicated opaque credential prefix and one-way hashes", () => {
    const credential = generateAgentControlExternalCredential();
    expect(credential).toMatch(/^rycoext_[A-Za-z0-9_-]{43}$/);
    expect(hashAgentControlExternalSecret(credential)).not.toContain(credential);
    expect(parseExternalAuthorization(`Bearer ${credential}`)).toBe(credential);
    expect(parseExternalAuthorization(`Bearer rycointernal_${credential}`)).toBeNull();
    expect(parseExternalAuthorization(credential)).toBeNull();

    const integrationA = AgentControlIntegrationId.make("integration-a");
    const integrationB = AgentControlIntegrationId.make("integration-b");
    expect(pairingCodeHash(integrationA, "ABCD234567")).not.toBe(
      pairingCodeHash(integrationB, "ABCD234567"),
    );
  });

  it("enables setup only for a provable loopback direct topology", () => {
    const local = {
      host: "127.0.0.1",
      tailscaleServeEnabled: false,
      hubConnector: { enabled: false },
    } as const;
    expect(evaluateExternalMcpTopology(local)).toEqual({ available: true, reason: null });
    expect(evaluateExternalMcpTopology({ ...local, host: undefined }).available).toBe(false);
    expect(evaluateExternalMcpTopology({ ...local, host: "0.0.0.0" }).available).toBe(false);
    expect(evaluateExternalMcpTopology({ ...local, tailscaleServeEnabled: true }).available).toBe(
      false,
    );
    expect(evaluateExternalMcpTopology({ ...local, hubConnector: { enabled: true } })).toEqual({
      available: false,
      reason: "External integrations are disabled while this Ryco is Hub-connected.",
    });
    // An identity-less Desktop standby connector is not Hub-connected yet; it
    // yields the process before its first relay connection instead.
    expect(
      evaluateExternalMcpTopology({ ...local, hubConnector: { enabled: true, standby: true } }),
    ).toEqual({ available: true, reason: null });
  });

  it("generates client-specific setup without credential or pairing material", () => {
    const integrationId = AgentControlIntegrationId.make("integration-safe-config");
    for (const clientKind of ["codex", "claude-code", "claude-desktop", "generic-mcp"] as const) {
      const setup = makeExternalIntegrationSetup({
        integrationId,
        clientKind,
        runtime: {
          command: "/actual/runtime/node",
          entryPoint: "/actual/ryco/dist/bin.mjs",
          stateDir: "/actual/data/ryco",
        },
      });
      const serialized = JSON.stringify(setup);
      expect(serialized).toContain("/actual/runtime/node");
      expect(serialized).toContain("/actual/data/ryco");
      expect(serialized).toContain(integrationId);
      expect(serialized).not.toContain("rycoext_");
      expect(serialized).not.toContain("pairingCode");
      if (clientKind === "codex") expect(setup.configuration).toContain("[mcp_servers.ryco]");
      else expect(JSON.parse(setup.configuration)).toHaveProperty("mcpServers.ryco.command");
    }
  });

  it("refuses unsafe credential-file permissions and ambiguous selections", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "ryco-external-security-"));
    temporaryDirectories.push(stateDir);
    const credential = generateAgentControlExternalCredential();
    const value = {
      version: 1 as const,
      integrationId: "integration-permissions",
      audience: AGENT_CONTROL_EXTERNAL_CREDENTIAL_AUDIENCE,
      credential,
      pairedAt: new Date().toISOString(),
    };
    await writeExternalCredentialFile(stateDir, value);
    expect(await readExternalCredentialFile(stateDir, value.integrationId)).toEqual(value);

    if (process.platform !== "win32") {
      const credentialDirectory = path.join(stateDir, "external-mcp", "credentials");
      const [file] = await readdir(credentialDirectory);
      await chmod(path.join(credentialDirectory, file!), 0o644);
      await expect(readExternalCredentialFile(stateDir, value.integrationId)).rejects.toThrow(
        "Unsafe external MCP permissions",
      );
      await expect(writeExternalCredentialFile(stateDir, value)).rejects.toThrow(
        "Unsafe external MCP permissions",
      );
    }

    expect(() => selectSingleExternalCredential([])).toThrow("ambiguous");
    expect(() => selectSingleExternalCredential([value, value])).toThrow("ambiguous");
    expect(() => selectSingleExternalRuntime([])).toThrow("No local Ryco");
    const runtime = {
      version: 1 as const,
      pid: process.pid,
      instanceId: "runtime-1",
      mcpUrl: "http://127.0.0.1:43111/mcp",
      pairingUrl: "http://127.0.0.1:43111/_ryco/external-pair",
      startedAt: new Date().toISOString(),
    };
    expect(() =>
      selectSingleExternalRuntime([runtime, { ...runtime, instanceId: "runtime-2" }]),
    ).toThrow("Multiple local Ryco");
  });

  it("bounds failed runtime discovery retries", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "ryco-external-discovery-"));
    temporaryDirectories.push(stateDir);
    const startedAt = Date.now();
    await expect(
      discoverExternalRuntimeWithRetries([stateDir], { attempts: 2, delayMs: 1 }),
    ).rejects.toThrow("No local Ryco");
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });
});
