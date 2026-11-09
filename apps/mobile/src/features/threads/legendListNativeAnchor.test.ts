// The app's `tsconfig` is the react-native one, which resolves no Node builtins;
// this test runs under Node, so it pulls the types in for itself.
/// <reference types="node" />
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vite-plus/test";

const require = createRequire(import.meta.url);
const LEGEND_LIST_DIR = dirname(require.resolve("@legendapp/list/react-native"));

/**
 * LegendList moves the list for its own position corrections through iOS's native
 * `maintainVisibleContentPosition`, anchored to a sentinel view far below the content. The chat
 * feed turns position restoration off while it follows the end and on again when the reader
 * drags; upstream that also switched the native anchor off and on, and iOS then compared the
 * frame it kept from before with the moved sentinel and shifted the offset by the whole
 * difference: one drag up landed at the top of the chat. Our patch
 * (`patches/@legendapp%2Flist@3.3.10.patch`) keeps the native anchor on for iOS. This fails if an
 * upgrade drops that hunk, before the jump reaches a phone.
 */
describe("LegendList native anchor on iOS", () => {
  it.each(["react-native.js", "react-native.mjs"])(
    "stays on whatever the list's position restoration is (%s)",
    (file) => {
      const source = readFileSync(join(LEGEND_LIST_DIR, file), "utf8");
      expect(source).toContain(
        'maintainVisibleContentPosition: Platform.OS === "ios" || maintainVisibleContentPosition.size || maintainVisibleContentPosition.data ? { minIndexForVisible: 0 } : void 0,',
      );
    },
  );
});
