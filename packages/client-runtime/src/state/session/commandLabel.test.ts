import { describe, expect, it } from "vite-plus/test";

import { deriveReadableCommandDisplay, resolveCommandVisualKind } from "./commandLabel.ts";

const label = (command: string) => {
  const { verb, target } = deriveReadableCommandDisplay(command);
  return `${verb} ${target}`;
};

describe("command labels", () => {
  it("reads through rtk and rtk proxy to the wrapped command", () => {
    expect(label("rtk git status")).toBe("Checked git status");
    expect(label("rtk proxy git status")).toBe("Checked git status");
    expect(label("rtk cat src/components/App.tsx")).toBe("Read components/App.tsx");
    expect(resolveCommandVisualKind("rtk gh pr view 12")).toBe("github");
    expect(resolveCommandVisualKind("rtk proxy rg needle")).toBe("inspect");
    // Wrappers nest: env and timeout around rtk, rtk around env.
    expect(label("env FOO=1 rtk git status")).toBe("Checked git status");
    expect(label("rtk timeout 30 git status")).toBe("Checked git status");
  });

  it("keeps RTK's own subcommands and flags as they are", () => {
    for (const command of ["rtk gain", "rtk gain --history", "rtk discover", "rtk --version"]) {
      expect(deriveReadableCommandDisplay(command).target).toBe(command);
      expect(resolveCommandVisualKind(command)).toBe("terminal");
    }
    expect(deriveReadableCommandDisplay("rtk proxy").target).toBe("rtk proxy");
  });

  it("keeps the full command for detail and copy", () => {
    expect(deriveReadableCommandDisplay("rtk git status").fullCommand).toBe("rtk git status");
  });

  it("does not treat a command that only starts with rtk as the wrapper", () => {
    expect(label("rtkx git status")).toBe("Ran rtkx git status");
  });
});
