import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { AGENT_CONTROL_EXTERNAL_CREDENTIAL_AUDIENCE } from "@ryco/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { generateAgentControlExternalCredential } from "../externalCredential.ts";
import { pairExternalMcpBridge, runExternalMcpBridge } from "./bridge.ts";
import {
  readExternalCredentialFile,
  writeExternalCredentialFile,
  writeExternalRuntimeDescriptor,
} from "./runtimeFiles.ts";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("external MCP stdio bridge", () => {
  it("pairs through the private runtime endpoint and stores the credential privately", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "ryco-external-pair-"));
    temporaryDirectories.push(stateDir);
    const integrationId = "integration-pair";
    await writeExternalRuntimeDescriptor(stateDir, {
      version: 1,
      pid: process.pid,
      instanceId: "runtime-pair",
      mcpUrl: "http://127.0.0.1:43110/mcp",
      pairingUrl: "http://127.0.0.1:43110/_ryco/external-pair",
      startedAt: new Date().toISOString(),
    });
    const credential = generateAgentControlExternalCredential();
    let requestSignal: AbortSignal | null = null;
    const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("http://127.0.0.1:43110/_ryco/external-pair");
      expect(JSON.parse(String(init?.body))).toEqual({
        integrationId,
        pairingCode: "ABCD234567",
      });
      requestSignal = init?.signal ?? null;
      return new Response(JSON.stringify({ integrationId, audience: "external-mcp", credential }));
    }) as unknown as typeof globalThis.fetch;

    await pairExternalMcpBridge({
      integrationId,
      stateDirs: [stateDir],
      pairingCode: " ABCD234567 ",
      fetch,
    });
    expect(requestSignal).not.toBeNull();
    expect((await readExternalCredentialFile(stateDir, integrationId)).credential).toBe(credential);
  });

  it("forwards requests concurrently so a wait cannot block ping", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "ryco-external-bridge-"));
    temporaryDirectories.push(stateDir);
    const integrationId = "integration-concurrency";
    await writeExternalRuntimeDescriptor(stateDir, {
      version: 1,
      pid: process.pid,
      instanceId: "runtime-1",
      mcpUrl: "http://127.0.0.1:43111/mcp",
      pairingUrl: "http://127.0.0.1:43111/_ryco/external-pair",
      startedAt: new Date().toISOString(),
    });
    await writeExternalCredentialFile(stateDir, {
      version: 1,
      integrationId,
      audience: AGENT_CONTROL_EXTERNAL_CREDENTIAL_AUDIENCE,
      credential: generateAgentControlExternalCredential(),
      pairedAt: new Date().toISOString(),
    });

    const input = new PassThrough();
    const output = new PassThrough();
    const errorOutput = new PassThrough();
    let rendered = "";
    output.on("data", (chunk) => {
      rendered += chunk.toString();
    });
    const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { id: number; method: string };
      if (request.method === "wait") await new Promise((resolve) => setTimeout(resolve, 50));
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} }));
    }) as unknown as typeof globalThis.fetch;

    const running = runExternalMcpBridge({
      integrationId,
      stateDirs: [stateDir],
      input,
      output,
      errorOutput,
      fetch,
    });
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "wait" })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" })}\n`);
    input.end();
    await running;

    const responses = rendered
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { id: number });
    expect(responses.map((response) => response.id)).toEqual([2, 1]);
  });

  it("rejects oversized stdio messages without forwarding them", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "ryco-external-bridge-size-"));
    temporaryDirectories.push(stateDir);
    const integrationId = "integration-size";
    await writeExternalRuntimeDescriptor(stateDir, {
      version: 1,
      pid: process.pid,
      instanceId: "runtime-1",
      mcpUrl: "http://127.0.0.1:43112/mcp",
      pairingUrl: "http://127.0.0.1:43112/_ryco/external-pair",
      startedAt: new Date().toISOString(),
    });
    await writeExternalCredentialFile(stateDir, {
      version: 1,
      integrationId,
      audience: AGENT_CONTROL_EXTERNAL_CREDENTIAL_AUDIENCE,
      credential: generateAgentControlExternalCredential(),
      pairedAt: new Date().toISOString(),
    });
    const input = new PassThrough();
    const output = new PassThrough();
    const errorOutput = new PassThrough();
    let calls = 0;
    let errors = "";
    errorOutput.on("data", (chunk) => {
      errors += chunk.toString();
    });
    const fetch = (async () => {
      calls += 1;
      return new Response("{}");
    }) as unknown as typeof globalThis.fetch;
    const running = runExternalMcpBridge({
      integrationId,
      stateDirs: [stateDir],
      input,
      output,
      errorOutput,
      fetch,
    });
    input.end(`${"x".repeat(128 * 1024 + 1)}\n`);
    await expect(running).rejects.toThrow("payload limit");
    expect(calls).toBe(0);
    expect(errors).toBe("");
  });

  it("answers refused or failed requests with a JSON-RPC error and keeps notifications silent", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "ryco-external-bridge-refused-"));
    temporaryDirectories.push(stateDir);
    const integrationId = "integration-refused";
    await writeExternalRuntimeDescriptor(stateDir, {
      version: 1,
      pid: process.pid,
      instanceId: "runtime-1",
      mcpUrl: "http://127.0.0.1:43113/mcp",
      pairingUrl: "http://127.0.0.1:43113/_ryco/external-pair",
      startedAt: new Date().toISOString(),
    });
    await writeExternalCredentialFile(stateDir, {
      version: 1,
      integrationId,
      audience: AGENT_CONTROL_EXTERNAL_CREDENTIAL_AUDIENCE,
      credential: generateAgentControlExternalCredential(),
      pairedAt: new Date().toISOString(),
    });
    const input = new PassThrough();
    const output = new PassThrough();
    const errorOutput = new PassThrough();
    let rendered = "";
    let errors = "";
    output.on("data", (chunk) => {
      rendered += chunk.toString();
    });
    errorOutput.on("data", (chunk) => {
      errors += chunk.toString();
    });
    const invalidAnswer = {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" },
    };
    const respond = async (_url: string | URL | Request, init?: RequestInit) => {
      const body = String(init?.body);
      if (body === "not json") {
        return new Response(JSON.stringify(invalidAnswer), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      const request = JSON.parse(body) as { readonly method: string };
      if (request.method === "initialize") return new Response(null, { status: 401 });
      if (request.method === "tools/list") return new Response(null, { status: 429 });
      if (request.method === "ping") return new Response(null, { status: 500 });
      if (request.method === "notifications/initialized") {
        return new Response(null, { status: 401 });
      }
      throw new TypeError("fetch failed: connect ECONNREFUSED http://127.0.0.1:43113/mcp");
    };
    const fetch: typeof globalThis.fetch = Object.assign(respond, {
      preconnect: globalThis.fetch.preconnect,
    });

    const running = runExternalMcpBridge({
      integrationId,
      stateDirs: [stateDir],
      input,
      output,
      errorOutput,
      fetch,
    });
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: "two", method: "tools/list" })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "ping" })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call" })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    input.write("not json\n");
    input.end();
    await running;

    const responses = rendered
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            readonly id: string | number | null;
            readonly error: { readonly code: number; readonly message: string };
          },
      );
    const byId = new Map(responses.map((response) => [response.id, response.error]));
    expect(responses).toHaveLength(5);
    expect(byId.get(1)?.message).toContain("reconnect the integration");
    expect(byId.get("two")?.message).toContain("Rate limited");
    expect(byId.get(3)).toEqual({ code: -32603, message: "Ryco request failed (HTTP 500)." });
    expect(byId.get(4)?.code).toBe(-32603);
    expect(byId.get(null)).toEqual(invalidAnswer.error);
    expect(rendered).not.toContain("ECONNREFUSED");
    expect(errors).not.toContain("127.0.0.1");
    expect(errors).toContain("External Ryco MCP request failed.");
  });
});
