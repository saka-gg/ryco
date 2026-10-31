import * as Option from "effect/Option";
import { defineRule } from "vite-plus/lint/plugins";

import { getPropertyName, isIdentifier, unwrapExpression } from "../utils.ts";

/**
 * A `vi.mock` of the web app's environment runtime built on `importOriginal` hung an
 * `apps/web` browser run for over ten minutes (2026-10-16). Whole-module mocks are fine; a test
 * that needs the real runtime overrides one environment's API instead.
 */

const BROWSER_TEST_PATTERN = /\.browser\.[cm]?[jt]sx?$/u;
/** `…/environments/runtime`, a module under it, or `…/environmentApi`, with or without extension. */
const RUNTIME_MODULE_PATTERN =
  /(?:^|\/)(?:environments\/runtime(?:\/[^/]+)*|environmentApi)(?:\.[cm]?[jt]sx?)?$/u;
const CANDIDATE_TEXT_PATTERN = /vi\.mock\(/u;

const MESSAGE =
  "Don't build a partial mock of the environment runtime on importOriginal: one hung a browser run for over ten minutes. Use the real runtime with __setEnvironmentApiOverrideForTests, or mock the whole module.";

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow importOriginal-based partial mocks of the environment runtime in browser tests.",
    },
  },
  createOnce(context) {
    return {
      before: () =>
        BROWSER_TEST_PATTERN.test(context.filename) &&
        CANDIDATE_TEXT_PATTERN.test(context.sourceCode.text),
      CallExpression(node) {
        const callee = Option.getOrUndefined(unwrapExpression(node.callee));
        if (callee?.type !== "MemberExpression") return;
        if (!isIdentifier(unwrapExpression(callee.object), "vi")) return;
        if (Option.getOrUndefined(getPropertyName(callee.property)) !== "mock") return;
        const [specifier, factory] = node.arguments;
        const source = Option.getOrUndefined(unwrapExpression(specifier));
        if (source?.type !== "Literal" || typeof source.value !== "string") return;
        if (!RUNTIME_MODULE_PATTERN.test(source.value)) return;
        const builder = Option.getOrUndefined(unwrapExpression(factory));
        if (
          (builder?.type === "ArrowFunctionExpression" || builder?.type === "FunctionExpression") &&
          builder.params.length > 0
        ) {
          context.report({ node, message: MESSAGE });
        }
      },
    };
  },
});
