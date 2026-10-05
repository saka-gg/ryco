import { describe, expect, it } from "vite-plus/test";

import {
  assignSubagentIdentities,
  formatSubagentRoleLabel,
  resolveSubagentDisplayLabel,
  resolveSubagentDisplayLabels,
  splitSubagentLabelScope,
  subagentRoleDuplicatesLabel,
} from "./subagentIdentity.ts";

describe("subagent identity", () => {
  it("resolves runtime and transcript keys to the same visual identity", () => {
    const runtimeIdentity = assignSubagentIdentities([
      { key: "agent-1", role: "code-reviewer", taskLabel: "Review reconnect handling" },
    ]).get("agent-1");
    const transcriptIdentity = assignSubagentIdentities([
      {
        key: "subagent:agent-1",
        role: "code-reviewer",
        taskLabel: "Review reconnect handling",
      },
    ]).get("subagent:agent-1");

    expect(runtimeIdentity).toEqual(transcriptIdentity);
    expect(runtimeIdentity).toMatchObject({
      role: "Code Reviewer",
      taskLabel: "Review reconnect handling",
      avatarKey: "agent-1",
    });
  });

  it("keeps provider roles open-ended while hiding generic or duplicate labels", () => {
    expect(formatSubagentRoleLabel("release-verifier")).toBe("Release Verifier");
    expect(formatSubagentRoleLabel("subagent")).toBeNull();
    expect(subagentRoleDuplicatesLabel("Reviewer", " reviewer ")).toBe(true);
    expect(subagentRoleDuplicatesLabel("Reviewer", "Inspect retries")).toBe(false);
  });

  it("leads with functional labels and falls back to the codename without one", () => {
    const resolve = (title: string | null) =>
      resolveSubagentDisplayLabel({ id: "agent-1", title, codename: "Turing" });
    expect(resolve("verify:implementor")).toBe("verify:implementor");
    expect(resolve(" Review reconnect handling ")).toBe("Review reconnect handling");
    expect(resolve(null)).toBe("Turing");
    expect(resolve("  ")).toBe("Turing");
    expect(resolve("Agent task")).toBe("Turing");
    expect(resolve("subagent:agent-1")).toBe("Turing");
  });

  it("numbers only colliding labels, in spawn order", () => {
    const labels = resolveSubagentDisplayLabels([
      { id: "a", title: "Explore", codename: "Turing" },
      { id: "b", title: "review:bugs", codename: "Dirac" },
      { id: "c", title: "Explore", codename: "Hegel" },
      { id: "d", title: null, codename: "Curie" },
    ]);
    expect([...labels.entries()]).toEqual([
      ["a", "Explore"],
      ["b", "review:bugs"],
      ["c", "Explore 2"],
      ["d", "Curie"],
    ]);
  });

  it("sets a workflow label's scope apart only for the scope:name convention", () => {
    expect(splitSubagentLabelScope("verify:implementor")).toEqual({
      scope: "verify",
      name: "implementor",
    });
    expect(splitSubagentLabelScope("review:src/app.ts")).toEqual({
      scope: "review",
      name: "src/app.ts",
    });
    expect(splitSubagentLabelScope("Review reconnect handling")).toEqual({
      scope: null,
      name: "Review reconnect handling",
    });
    expect(splitSubagentLabelScope("Fix: the retry loop")).toEqual({
      scope: null,
      name: "Fix: the retry loop",
    });
    expect(splitSubagentLabelScope("https://example.com")).toEqual({
      scope: null,
      name: "https://example.com",
    });
  });
});
