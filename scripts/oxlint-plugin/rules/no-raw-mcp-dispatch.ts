import * as Option from "effect/Option";
import { defineRule, type ESTree } from "vite-plus/lint/plugins";

import { getPropertyName, unwrapExpression } from "../utils.ts";

/**
 * Ryco serves MCP through its own JSON-RPC listeners, which resolve the session lease, transport
 * guard and turn authority before a tool runs. Adapted from T3 Code's `no-raw-mcp-registration`,
 * which guards Effect's McpServer; Ryco does not use it.
 */

/** The listeners that may answer MCP methods. */
const DISPATCH_OWNERS = [
  "apps/server/src/agentControl/Mcp/listener.ts",
  "apps/server/src/agentControl/ExternalMcp/listener.ts",
  "apps/server/src/providerTools/deviceToolGateway.ts",
];
/** Tools are composed with `with*Tools` wrappers around `AgentControlMcpTools.callTool`. */
const CALL_TOOL_OWNER_PATTERN = /(?:^|\/)apps\/server\/src\/agentControl\//u;
const DISPATCHED_METHODS = new Set(["tools/call", "tools/list"]);
const MCP_SERVER_MODULE_PATTERN =
  /^(?:@modelcontextprotocol\/sdk\/server(?:\/|$)|effect\/ai\/McpServer$)/u;
const TEST_FILE_PATTERN = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;
/** Text every reported file contains; the rest skip the AST walk. */
const CANDIDATE_TEXT_PATTERN =
  /tools\/(?:call|list)|callTool|@modelcontextprotocol\/sdk\/server|effect\/ai\/McpServer/u;

const HOW = "Add the tool with a with*Tools wrapper instead.";
const dispatchMessage = (method: string) =>
  `Only the Agent Control listeners answer "${method}": they check the session lease and turn authority before a tool runs. ${HOW}`;
const callToolMessage = `MCP tool calls must enter through the Agent Control listener, which checks the session lease and turn authority. ${HOW}`;
const importMessage = `Ryco serves MCP through the Agent Control listeners, not an MCP server library, so every tool passes their checks. ${HOW}`;

const normalized = (filename: string) => filename.replaceAll("\\", "/");

const literalString = (node: unknown): Option.Option<string> =>
  Option.flatMap(unwrapExpression(node), (expression) => {
    if (expression.type === "Literal" && typeof expression.value === "string") {
      return Option.some(expression.value);
    }
    if (expression.type === "TemplateLiteral" && expression.expressions.length === 0) {
      return Option.fromNullishOr(expression.quasis[0]?.value.cooked);
    }
    return Option.none();
  });

const dispatchedMethod = (node: unknown): Option.Option<string> =>
  Option.filter(literalString(node), (value) => DISPATCHED_METHODS.has(value));

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow answering MCP methods or calling tools outside the Agent Control listeners, which check who may call them.",
    },
  },
  createOnce(context) {
    const reportImport = (node: ESTree.Node, source: unknown) => {
      const specifier = literalString(source);
      if (Option.isSome(specifier) && MCP_SERVER_MODULE_PATTERN.test(specifier.value)) {
        context.report({ node, message: importMessage });
      }
    };
    return {
      before: () =>
        !TEST_FILE_PATTERN.test(context.filename) &&
        CANDIDATE_TEXT_PATTERN.test(context.sourceCode.text),
      SwitchCase(node) {
        if (DISPATCH_OWNERS.some((owner) => normalized(context.filename).endsWith(owner))) return;
        const method = dispatchedMethod(node.test);
        if (Option.isSome(method)) context.report({ node, message: dispatchMessage(method.value) });
      },
      BinaryExpression(node) {
        if (!["===", "!==", "==", "!="].includes(node.operator)) return;
        if (DISPATCH_OWNERS.some((owner) => normalized(context.filename).endsWith(owner))) return;
        const method = Option.orElse(dispatchedMethod(node.left), () =>
          dispatchedMethod(node.right),
        );
        if (Option.isSome(method)) context.report({ node, message: dispatchMessage(method.value) });
      },
      CallExpression(node) {
        if (CALL_TOOL_OWNER_PATTERN.test(normalized(context.filename))) return;
        const callee = Option.getOrUndefined(unwrapExpression(node.callee));
        if (callee?.type !== "MemberExpression") return;
        if (Option.getOrUndefined(getPropertyName(callee.property)) !== "callTool") return;
        context.report({ node, message: callToolMessage });
      },
      ImportDeclaration(node) {
        if (node.importKind !== "type") reportImport(node, node.source);
      },
      ImportExpression(node) {
        reportImport(node, node.source);
      },
      ExportNamedDeclaration(node) {
        if (node.source !== null && node.exportKind !== "type") reportImport(node, node.source);
      },
      ExportAllDeclaration(node) {
        if (node.exportKind !== "type") reportImport(node, node.source);
      },
    };
  },
});
