/**
 * Ryco's own oxlint rules, loaded through `jsPlugins` in the root vite.config.ts lint block and
 * reported as `ryco/<rule>`. Each rule lives in `rules/<rule>.ts` with its RuleTester cases in
 * `rules/<rule>.test.ts`; `wiring.test.ts` checks the real `vp lint` path loads this file.
 *
 * oxlint's JS plugin API is alpha. A vite-plus or oxlint bump can change it, and the tests in this
 * directory are the first place that shows.
 */
import { definePlugin } from "vite-plus/lint/plugins";

import requireSuppressionReason from "./rules/require-suppression-reason.ts";

export default definePlugin({
  meta: {
    name: "ryco",
  },
  rules: {
    "require-suppression-reason": requireSuppressionReason,
  },
});
