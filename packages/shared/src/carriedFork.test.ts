import { describe, expect, it } from "vite-plus/test";

import {
  carriedForkRemoteBranch,
  isValidCarriedBranchName,
  pickCarriedForkInstance,
} from "./carriedFork.ts";

describe("pickCarriedForkInstance", () => {
  it("prefers the driver's default instance, then the first enabled one by id", () => {
    const instances = [
      { instanceId: "work-codex", driver: "codex", enabled: true },
      { instanceId: "codex", driver: "codex", enabled: true },
      { instanceId: "a-claude", driver: "claudeAgent", enabled: true },
      { instanceId: "b-claude", driver: "claudeAgent", enabled: true },
      { instanceId: "claudeAgent", driver: "claudeAgent", enabled: false },
      { instanceId: "opencode", driver: "opencode", enabled: false },
    ];
    expect(pickCarriedForkInstance(instances, "codex")?.instanceId).toBe("codex");
    expect(pickCarriedForkInstance(instances, "claudeAgent")?.instanceId).toBe("a-claude");
    expect(pickCarriedForkInstance(instances, "opencode")).toBeNull();
    expect(pickCarriedForkInstance(instances, "cursor")).toBeNull();
  });
});

describe("carried fork branches", () => {
  it("takes only branches pushed to origin", () => {
    expect(carriedForkRemoteBranch("origin/feature/login")).toBe("feature/login");
    expect(carriedForkRemoteBranch("upstream/feature")).toBeNull();
    expect(carriedForkRemoteBranch("origin/")).toBeNull();
    expect(carriedForkRemoteBranch("feature")).toBeNull();
  });

  it("refuses names Git refuses or a refspec would misread", () => {
    for (const name of ["main", "feature/login", "ryco/fork-1a2b3c4d", "v1.2", "a_b-c"]) {
      expect(isValidCarriedBranchName(name), name).toBe(true);
    }
    for (const name of [
      "",
      "-x",
      "a..b",
      "a:refs/heads/main",
      "a b",
      "a*",
      "a?",
      "a[b",
      "a\\b",
      "a~1",
      "a^",
      "a@{1}",
      "@",
      "HEAD",
      "a//b",
      "/a",
      "a/",
      "a.",
      ".a",
      "a/.b",
      "a.lock",
      "a/b.lock/c",
      "a\u0000b",
      "a\u007fb",
    ]) {
      expect(isValidCarriedBranchName(name), JSON.stringify(name)).toBe(false);
    }
  });
});
