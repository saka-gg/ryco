import { describe, expect, it } from "vitest";

import { claudeApprovalPresentation } from "./claudeApprovalPresentation.ts";

describe("claudeApprovalPresentation", () => {
  it("keeps the CLI's reason without its terminal escapes", () => {
    expect(
      claudeApprovalPresentation({
        detail: 'Bash: rm -r -- "$dir"',
        options: {
          decisionReason: "\u001b[33mDangerous rm on a path built from a variable\u001b[39m",
        },
      }),
    ).toEqual({ reason: "Dangerous rm on a path built from a variable" });
  });

  it("omits a reason that only repeats the prompt", () => {
    expect(
      claudeApprovalPresentation({
        detail: "Bash: make",
        options: { decisionReason: " Bash: make " },
      }),
    ).toEqual({});
    expect(
      claudeApprovalPresentation({
        detail: "Read: notes.txt",
        options: {
          decisionReason: "Claude wants to read notes.txt",
          title: "Claude wants to read notes.txt",
        },
      }),
    ).toEqual({});
    expect(
      claudeApprovalPresentation({ detail: "Bash: make", options: { decisionReason: "  " } }),
    ).toEqual({});
  });

  it("withdraws the session-wide grant when the CLI suppresses it", () => {
    expect(
      claudeApprovalPresentation({
        detail: "Bash: git push",
        options: { suppressAlwaysAllowRule: true },
      }),
    ).toEqual({ acceptForSessionOffered: false });
    expect(
      claudeApprovalPresentation({
        detail: "Bash: git push",
        options: { suppressAlwaysAllowRule: false },
      }),
    ).toEqual({});
  });
});
