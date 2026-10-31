import * as Option from "effect/Option";
import { defineRule, type ESTree } from "vite-plus/lint/plugins";

import { getPropertyName, isIdentifier, unwrapExpression } from "../utils.ts";

/**
 * A `vi.mock` of the web app's environment runtime built on the real module (`importOriginal`,
 * or `vi.importActual` inside the factory) hung an `apps/web` browser run for over ten minutes
 * (2026-10-16). Whole-module mocks are fine; a test that needs the real runtime overrides one
 * environment's API instead.
 */

const BROWSER_TEST_PATTERN = /\.browser\.[cm]?[jt]sx?$/u;
/** `…/environments/runtime`, a module under it, or `…/environmentApi`, with or without extension. */
const RUNTIME_MODULE_PATTERN =
  /(?:^|\/)(?:environments\/runtime(?:\/[^/]+)*|environmentApi)(?:\.[cm]?[jt]sx?)?$/u;
const CANDIDATE_TEXT_PATTERN = /vi\.(?:do)?[mM]ock\(/u;
const MOCKS = new Set(["mock", "doMock"]);

const MESSAGE =
  "Don't build a partial mock of the environment runtime on importOriginal: one hung a browser run for over ten minutes. Use the real runtime with __setEnvironmentApiOverrideForTests, or mock the whole module.";

const literalString = (node: unknown): string | undefined => {
  const expression = Option.getOrUndefined(unwrapExpression(node));
  if (expression?.type === "Literal" && typeof expression.value === "string") {
    return expression.value;
  }
  if (expression?.type === "TemplateLiteral" && expression.expressions.length === 0) {
    return expression.quasis[0]?.value.cooked ?? undefined;
  }
  // `vi.mock(import("../environmentApi"), …)`
  if (expression?.type === "ImportExpression") return literalString(expression.source);
  return undefined;
};

/** The module a specifier names, with `./` and `../` resolved against the test file's folder. */
function resolvedSpecifier(specifier: string, filename: string): string {
  if (!specifier.startsWith(".")) return specifier;
  const parts = filename.replaceAll("\\", "/").split("/").slice(0, -1);
  for (const segment of specifier.split("/")) {
    if (segment === "..") parts.pop();
    else if (segment !== ".") parts.push(segment);
  }
  return parts.join("/");
}

/** Whether the factory builds on the real module: it takes `importOriginal`, or calls `vi.importActual`. */
function buildsOnRealModule(factory: unknown, textOf: (node: ESTree.Node) => string): boolean {
  const builder = Option.getOrUndefined(unwrapExpression(factory));
  if (builder?.type !== "ArrowFunctionExpression" && builder?.type !== "FunctionExpression") {
    return false;
  }
  if (builder.params.length > 0) return true;
  return /\bvi\.importActual\s*\(/u.test(textOf(builder));
}

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow partial mocks of the environment runtime, built on the real module, in browser tests.",
    },
  },
  createOnce(context) {
    return {
      before: () =>
        BROWSER_TEST_PATTERN.test(context.filename) &&
        CANDIDATE_TEXT_PATTERN.test(context.sourceCode.text),
      CallExpression(node: ESTree.CallExpression) {
        const callee = Option.getOrUndefined(unwrapExpression(node.callee));
        if (callee?.type !== "MemberExpression") return;
        if (!isIdentifier(unwrapExpression(callee.object), "vi")) return;
        const method = Option.getOrUndefined(getPropertyName(callee.property));
        if (method === undefined || !MOCKS.has(method)) return;
        const [specifier, factory] = node.arguments;
        const source = literalString(specifier);
        if (source === undefined) return;
        if (!RUNTIME_MODULE_PATTERN.test(resolvedSpecifier(source, context.filename))) return;
        if (buildsOnRealModule(factory, (part) => context.sourceCode.getText(part))) {
          context.report({ node, message: MESSAGE });
        }
      },
    };
  },
});
