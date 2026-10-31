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
const PLUGIN_PATTERN = /(?:^|\/)scripts\/oxlint-plugin\//u;
const MCP_SERVER_MODULE_PATTERN =
  /^(?:@modelcontextprotocol\/sdk\/server(?:\/|$)|effect\/ai\/McpServer$)/u;
/** Effect's AI barrels, which export `McpServer` by name (T3's rule checks them the same way). */
const AI_MODULES = new Set(["effect/ai", "effect/ai/index"]);
const TEST_FILE_PATTERN = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;
/** Text every reported file contains; the rest skip the AST walk. */
const CANDIDATE_TEXT_PATTERN =
  /tools\/(?:call|list)|callTool|@modelcontextprotocol\/sdk\/server|effect\/ai/u;

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

const namesMcpServer = (node: unknown) =>
  Option.getOrUndefined(getPropertyName(node)) === "McpServer";

/** A client sends a method (`{ method: "tools/list" }`); everything else that names one answers it. */
const isSentMethod = (node: ESTree.Node) => {
  const parent = node.parent;
  return (
    parent?.type === "Property" &&
    parent.value === node &&
    Option.getOrUndefined(getPropertyName(parent.key)) === "method"
  );
};

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow answering MCP methods or calling tools outside the Agent Control listeners, which check who may call them.",
    },
  },
  createOnce(context) {
    // The listeners, and this plugin, which names the methods to find them.
    const owner = () =>
      DISPATCH_OWNERS.some((path) => normalized(context.filename).endsWith(path)) ||
      PLUGIN_PATTERN.test(normalized(context.filename));
    const ownsCallTool = () => CALL_TOOL_OWNER_PATTERN.test(normalized(context.filename));
    const reportMethod = (node: ESTree.Node, value: string) => {
      if (!DISPATCHED_METHODS.has(value) || owner() || isSentMethod(node)) return;
      context.report({ node, message: dispatchMessage(value) });
    };
    const reportImport = (
      node: ESTree.Node,
      source: unknown,
      exposesByName: () => boolean = () => false,
    ) => {
      const specifier = literalString(source);
      if (Option.isNone(specifier)) return;
      if (
        MCP_SERVER_MODULE_PATTERN.test(specifier.value) ||
        (AI_MODULES.has(specifier.value) && exposesByName())
      ) {
        context.report({ node, message: importMessage });
      }
    };
    return {
      before: () =>
        !TEST_FILE_PATTERN.test(context.filename) &&
        CANDIDATE_TEXT_PATTERN.test(context.sourceCode.text),
      // Any spelling that names the method: a `case`, a comparison, a constant, a handler map key.
      Literal(node) {
        if (typeof node.value === "string") reportMethod(node, node.value);
      },
      TemplateLiteral(node) {
        const value = Option.getOrUndefined(literalString(node));
        if (value !== undefined) reportMethod(node, value);
      },
      // Any use of `callTool`: a call, a reference handed on, or a destructured name.
      MemberExpression(node) {
        if (ownsCallTool()) return;
        if (Option.getOrUndefined(getPropertyName(node.property)) !== "callTool") return;
        context.report({ node, message: callToolMessage });
      },
      ObjectPattern(node) {
        if (ownsCallTool()) return;
        for (const property of node.properties) {
          if (property.type !== "Property") continue;
          if (Option.getOrUndefined(getPropertyName(property.key)) === "callTool") {
            context.report({ node: property, message: callToolMessage });
          }
        }
      },
      ImportDeclaration(node) {
        if (node.importKind === "type") return;
        reportImport(node, node.source, () =>
          node.specifiers.some(
            (specifier) =>
              specifier.type !== "ImportSpecifier" ||
              (specifier.importKind !== "type" && namesMcpServer(specifier.imported)),
          ),
        );
      },
      ImportExpression(node) {
        reportImport(node, node.source, () => true);
      },
      ExportNamedDeclaration(node) {
        if (node.source === null || node.exportKind === "type") return;
        reportImport(node, node.source, () =>
          node.specifiers.some(
            (specifier) => specifier.exportKind !== "type" && namesMcpServer(specifier.local),
          ),
        );
      },
      ExportAllDeclaration(node) {
        if (node.exportKind !== "type") reportImport(node, node.source, () => true);
      },
    };
  },
});
