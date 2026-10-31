import { ruleTester } from "../ruleTester.ts";
import rule from "./no-raw-mcp-dispatch.ts";

const HOW = "Add the tool with a with*Tools wrapper instead.";
const dispatch = (method: string) =>
  `Only the Agent Control listeners answer "${method}": they check the session lease and turn authority before a tool runs. ${HOW}`;
const CALL_TOOL = `MCP tool calls must enter through the Agent Control listener, which checks the session lease and turn authority. ${HOW}`;
const IMPORT = `Ryco serves MCP through the Agent Control listeners, not an MCP server library, so every tool passes their checks. ${HOW}`;

ruleTester.run("ryco/no-raw-mcp-dispatch", rule, {
  valid: [
    {
      name: "allows the Agent Control listener to answer MCP methods",
      filename: "/repo/apps/server/src/agentControl/Mcp/listener.ts",
      code: `
        switch (method) {
          case "tools/list": break;
          case "tools/call": break;
        }
      `,
    },
    {
      name: "allows the device tool gateway to answer MCP methods",
      filename: "/repo/apps/server/src/providerTools/deviceToolGateway.ts",
      code: `if (method === "tools/list") {} if (method !== "tools/call") {}`,
    },
    {
      name: "allows a client sending tools/list",
      filename: "/repo/apps/server/src/agentControl/ExternalMcp/probe.ts",
      code: `send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });`,
    },
    {
      name: "allows callTool inside Agent Control",
      filename: "/repo/apps/server/src/agentControl/Mcp/queueTools.ts",
      code: `const result = base.callTool(name, input);`,
    },
    {
      name: "ignores tests, which drive the listeners",
      filename: "/repo/apps/server/src/orchestration/listener.test.ts",
      code: `
        switch (method) { case "tools/call": break; }
        tools.callTool("x", {});
      `,
    },
  ],
  invalid: [
    {
      name: "reports answering tools/call in another file",
      filename: "/repo/apps/server/src/orchestration/rpc.ts",
      code: `switch (method) {\n  case "tools/call": break;\n}`,
      errors: [{ message: dispatch("tools/call"), line: 2 }],
    },
    {
      name: "reports comparing a method with tools/list",
      filename: "/repo/apps/server/src/provider/bridge.ts",
      code: `if ("tools/list" === request.method) {}`,
      errors: [{ message: dispatch("tools/list") }],
    },
    {
      name: "reports callTool outside Agent Control",
      filename: "/repo/apps/server/src/orchestration/x.ts",
      code: `const result = tools?.callTool("ryco_send_message", {});`,
      errors: [{ message: CALL_TOOL }],
    },
    {
      name: "reports an MCP server library import",
      filename: "/repo/apps/server/src/agentControl/Mcp/server.ts",
      code: `
        import { Server } from "@modelcontextprotocol/sdk/server/index.js";
        import * as McpServer from "effect/ai/McpServer";
        export * from "@modelcontextprotocol/sdk/server/stdio.js";
        const lazy = import("@modelcontextprotocol/sdk/server/mcp.js");
      `,
      errors: [{ message: IMPORT }, { message: IMPORT }, { message: IMPORT }, { message: IMPORT }],
    },
  ],
});
