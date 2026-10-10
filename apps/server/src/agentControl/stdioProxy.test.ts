import { PassThrough, Readable } from "node:stream";

import { describe, expect, it, vi } from "vite-plus/test";

import {
  AGENT_CONTROL_BOOTSTRAP_ENV,
  AGENT_CONTROL_BOOTSTRAP_URL_ENV,
} from "./ProviderInjection.ts";
import { runAgentControlStdioProxy } from "./stdioProxy.ts";

describe("Agent Control stdio proxy", () => {
  it("exchanges once, deletes bootstrap env, and forwards MCP without spawning children", async () => {
    const bootstrap = `rycoacb_${"b".repeat(43)}`;
    const bearer = `rycoac_${"a".repeat(43)}`;
    const env: NodeJS.ProcessEnv = {
      [AGENT_CONTROL_BOOTSTRAP_ENV]: bootstrap,
      [AGENT_CONTROL_BOOTSTRAP_URL_ENV]: "http://127.0.0.1:45000/_agent-control/bootstrap",
    };
    const output = new PassThrough();
    let written = "";
    output.on("data", (chunk) => (written += chunk.toString()));
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(env[AGENT_CONTROL_BOOTSTRAP_ENV]).toBeUndefined();
      expect(env[AGENT_CONTROL_BOOTSTRAP_URL_ENV]).toBeUndefined();
      if (String(url).endsWith("/bootstrap")) {
        expect(init?.body).toBe(JSON.stringify({ token: bootstrap }));
        return Response.json({
          endpointUrl: "http://127.0.0.1:45000/mcp",
          authorization: `Bearer ${bearer}`,
        });
      }
      expect(init?.headers).toMatchObject({ authorization: `Bearer ${bearer}` });
      return Response.json({ jsonrpc: "2.0", id: 1, result: {} });
    });

    await runAgentControlStdioProxy({
      env,
      input: Readable.from(['{"jsonrpc":"2.0","id":1,"method":"ping"}\n']),
      output,
      errorOutput: new PassThrough(),
      fetch: fetchMock as unknown as typeof fetch,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(written).toContain('"id":1');
    expect(JSON.stringify(env)).not.toContain("rycoac_");
  });

  const bootstrapEnv = (): NodeJS.ProcessEnv => ({
    [AGENT_CONTROL_BOOTSTRAP_ENV]: `rycoacb_${"b".repeat(43)}`,
    [AGENT_CONTROL_BOOTSTRAP_URL_ENV]: "http://127.0.0.1:45000/_agent-control/bootstrap",
  });
  const bootstrapResponse = () =>
    Response.json({
      endpointUrl: "http://127.0.0.1:45000/mcp",
      authorization: `Bearer rycoac_${"a".repeat(43)}`,
    });
  const collect = () => {
    const output = new PassThrough();
    const chunks: Buffer[] = [];
    output.on("data", (chunk: Buffer) => chunks.push(chunk));
    return { output, lines: () => Buffer.concat(chunks).toString("utf8").split("\n") };
  };

  it("carries a multi-megabyte call and a large result intact", async () => {
    const page = `<p>${"x".repeat(2_500_000)}</p>`;
    const request = JSON.stringify({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "ryco_html_render", arguments: { html: page, title: "Big", height: 400 } },
    });
    const result = JSON.stringify({
      jsonrpc: "2.0",
      id: 5,
      result: { content: [{ type: "image", data: "A".repeat(600_000), mimeType: "image/png" }] },
    });
    const sent: string[] = [];
    const { output, lines } = collect();
    await runAgentControlStdioProxy({
      env: bootstrapEnv(),
      input: Readable.from([`${request.slice(0, 1_000_000)}`, `${request.slice(1_000_000)}\n`]),
      output,
      errorOutput: new PassThrough(),
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        if (String(url).endsWith("/bootstrap")) return bootstrapResponse();
        sent.push(String(init?.body));
        return new Response(result, { headers: { "content-type": "application/json" } });
      }) as typeof fetch,
    });
    expect(sent).toEqual([request]);
    expect(lines()).toEqual([result, ""]);
  });

  it("answers an oversized or malformed call and keeps the connection", async () => {
    const { output, lines } = collect();
    const statuses = [413, 400, 413, 200];
    await runAgentControlStdioProxy({
      env: bootstrapEnv(),
      input: Readable.from([
        '{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{}}\n',
        "{nope\n",
        '{"jsonrpc":"2.0","method":"notifications/huge"}\n',
        '{"jsonrpc":"2.0","id":8,"method":"ping"}\n',
      ]),
      output,
      errorOutput: new PassThrough(),
      fetch: (async (url: string | URL | Request) => {
        if (String(url).endsWith("/bootstrap")) return bootstrapResponse();
        const status = statuses.shift();
        if (status === 413) return new Response(null, { status });
        if (status === 400)
          return Response.json(
            { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
            { status },
          );
        return Response.json({ jsonrpc: "2.0", id: 8, result: {} });
      }) as typeof fetch,
    });
    const answers = lines()
      .filter((line) => line.length > 0)
      .map(
        (line) => JSON.parse(line) as { id: unknown; error?: { code: number; message: string } },
      );
    expect(answers.map((answer) => answer.id)).toEqual([7, null, 8]);
    expect(answers[0]?.error).toEqual({
      code: -32600,
      message: "Request too large: Ryco accepts at most 3 MiB per call.",
    });
    expect(answers[1]?.error?.code).toBe(-32700);
  });

  it("still stops when the endpoint refuses the session", async () => {
    await expect(
      runAgentControlStdioProxy({
        env: bootstrapEnv(),
        input: Readable.from(['{"jsonrpc":"2.0","id":1,"method":"ping"}\n']),
        output: new PassThrough(),
        errorOutput: new PassThrough(),
        fetch: (async (url: string | URL | Request) =>
          String(url).endsWith("/bootstrap")
            ? bootstrapResponse()
            : new Response(null, { status: 401 })) as typeof fetch,
      }),
    ).rejects.toThrow("Agent Control MCP request failed");
  });
});
