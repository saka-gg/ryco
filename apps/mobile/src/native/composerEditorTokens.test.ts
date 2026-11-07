import { collectComposerInlineTokens } from "@ryco/shared/composerInlineTokens";
import { describe, expect, it } from "vite-plus/test";

import { composerEditorTokenChips, skillLabelsByName } from "./composerEditorTokens";

describe("composerEditorTokenChips", () => {
  it("labels skills, threads and files", () => {
    const text = 'use $pdf on @"src/a.ts" and @thread:abc and @thread:gone ';
    const chips = composerEditorTokenChips({
      tokens: collectComposerInlineTokens(text),
      skillLabels: skillLabelsByName([{ name: "pdf", displayName: "PDF tools" }]),
      threadTitles: new Map([["abc", "Fix login"]]),
      fileIconUri: (path) => `icon:${path}`,
    });
    expect(chips.map((chip) => [chip.label, chip.iconUri])).toEqual([
      ["PDF tools", null],
      ["a.ts", "icon:src/a.ts"],
      ["Fix login", null],
      ["Thread", null],
    ]);
  });
});
