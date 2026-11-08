import { describe, expect, it } from "vite-plus/test";

import {
  copyDestinationUsable,
  copyFormBlockedReason,
  legacySourceHints,
  type CopyFormReadinessInput,
} from "./form.ts";
import type { CopyDestinationSuggestion } from "./plan.ts";

const READY: CopyFormReadinessInput = {
  title: "notes",
  sourceLabel: "Mac mini",
  targetLabel: "Laptop",
  hasSource: true,
  sourceError: null,
  sourceChecked: true,
  targetHoldError: null,
  targetSupport: "yes",
  options: null,
  destination: { status: "available" } as CopyDestinationSuggestion,
  destinationError: null,
  capReason: null,
  setupInvalid: false,
  followUpProblem: null,
};

describe("copyFormBlockedReason", () => {
  it("is null once everything was read and nothing refuses", () => {
    expect(copyFormBlockedReason(READY)).toBeNull();
  });

  it("names an offline project first", () => {
    expect(copyFormBlockedReason({ ...READY, hasSource: false, sourceError: "x" })).toBe(
      "Every checkout of notes is offline.",
    );
  });

  it("waits for the source, then for the destination", () => {
    expect(copyFormBlockedReason({ ...READY, sourceChecked: false })).toBe("Checking Mac mini…");
    expect(copyFormBlockedReason({ ...READY, destination: null })).toBe("Checking Laptop…");
    // A node without project copy is not checked for a destination.
    expect(copyFormBlockedReason({ ...READY, destination: null, targetSupport: "no" })).toBeNull();
  });

  it("puts errors before the form's own problems", () => {
    expect(
      copyFormBlockedReason({ ...READY, targetHoldError: "Laptop is offline", setupInvalid: true }),
    ).toBe("Laptop is offline");
    expect(copyFormBlockedReason({ ...READY, setupInvalid: true })).toBe(
      "Enter the setup command, or turn setup off.",
    );
    expect(copyFormBlockedReason({ ...READY, followUpProblem: "Pick a model." })).toBe(
      "Pick a model.",
    );
  });
});

describe("copyDestinationUsable", () => {
  it("refuses a blocked folder and an existing project", () => {
    expect(copyDestinationUsable(null)).toBe(false);
    expect(copyDestinationUsable({ status: "blocked" } as CopyDestinationSuggestion)).toBe(false);
    expect(copyDestinationUsable({ status: "existing-project" } as CopyDestinationSuggestion)).toBe(
      false,
    );
    expect(copyDestinationUsable({ status: "link" } as CopyDestinationSuggestion)).toBe(true);
  });
});

describe("legacySourceHints", () => {
  it("infers the home and separator from the path", () => {
    expect(legacySourceHints({ cwd: "/Users/ada/code/notes" })).toEqual({
      homeDirectory: "/Users/ada",
      pathSeparator: "/",
    });
    expect(legacySourceHints({ cwd: "C:\\Users\\ada\\notes" })).toEqual({
      homeDirectory: "C:\\Users\\ada",
      pathSeparator: "\\",
    });
    expect(legacySourceHints({ cwd: "/srv/notes" })).toBeNull();
  });
});
