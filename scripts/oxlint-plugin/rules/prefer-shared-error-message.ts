import * as Option from "effect/Option";
import { defineRule, type ESTree } from "vite-plus/lint/plugins";

import { getPropertyName, unwrapExpression } from "../utils.ts";

/**
 * The web app turns a thrown value into user-facing text with `errorMessage(error, fallback)`
 * (apps/web/src/lib/errorMessage.ts). An inline `error instanceof Error ? error.message : "..."`
 * shows a blank toast for a tagged error whose `message` is empty and whose text is in `detail`,
 * and ignores thrown strings.
 *
 * Only the shape `errorMessage` replaces one for one is reported: a string literal or template as
 * the fallback. A named fallback (`fallback`, `props.label`) is not reported, because without
 * types the rule cannot tell a string from a `ReactNode` or `null`; pass a string name to
 * `errorMessage` yourself. `String(error)`, `null` and other fallbacks answer something different.
 */

const SCOPE_PATTERN = /(?:^|\/)apps\/web\/src\//u;
const TEST_FILE_PATTERN = /\.(?:test|spec|browser)\.[cm]?[jt]sx?$/u;
const OWNER_PATTERN = /(?:^|\/)apps\/web\/src\/lib\/errorMessage\.ts$/u;
/** Text every reported file contains; the rest skip the AST walk. */
const CANDIDATE_TEXT_PATTERN = /instanceof\s+Error/u;

const MESSAGE =
  'Use errorMessage(error, fallback) from "~/lib/errorMessage": it trims, reads a tagged error\'s detail when the message is empty, and keeps thrown strings.';

const normalized = (filename: string) => filename.replaceAll("\\", "/");

/** Whether the fallback is surely a string, so `errorMessage` takes it unchanged. */
const isStringFallback = (node: ESTree.Node) =>
  (node.type === "Literal" && typeof node.value === "string") || node.type === "TemplateLiteral";

export default defineRule({
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Require the web app's errorMessage helper instead of an inline `error instanceof Error ? error.message : fallback`.",
    },
  },
  createOnce(context) {
    return {
      before: () => {
        const filename = normalized(context.filename);
        return (
          SCOPE_PATTERN.test(filename) &&
          !TEST_FILE_PATTERN.test(filename) &&
          !OWNER_PATTERN.test(filename) &&
          CANDIDATE_TEXT_PATTERN.test(context.sourceCode.text)
        );
      },
      ConditionalExpression(node) {
        const test = Option.getOrUndefined(unwrapExpression(node.test));
        if (test?.type !== "BinaryExpression" || test.operator !== "instanceof") return;
        if (Option.getOrUndefined(getPropertyName(test.right)) !== "Error") return;
        const consequent = Option.getOrUndefined(unwrapExpression(node.consequent));
        if (consequent?.type !== "MemberExpression" || consequent.computed) return;
        if (Option.getOrUndefined(getPropertyName(consequent.property)) !== "message") return;
        const errorText = context.sourceCode.getText(test.left);
        if (context.sourceCode.getText(consequent.object) !== errorText) return;
        const alternate = Option.getOrUndefined(unwrapExpression(node.alternate));
        if (alternate === undefined || !isStringFallback(alternate)) return;
        context.report({ node, message: MESSAGE });
      },
    };
  },
});
