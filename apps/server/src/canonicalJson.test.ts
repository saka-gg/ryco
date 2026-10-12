import { ProjectId, ProviderInstanceId, type AgentControlCreateThreadsPlan } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import { computeAgentControlPlanDigest } from "./agentControl/planDigest.ts";
import { canonicalJson, sha256Hex } from "./canonicalJson.ts";
import { stableStringifyContextHandoff } from "./orchestration/contextHandoff/ContextHandoffBuilder.ts";

describe("canonicalJson", () => {
  it("sorts keys by code unit at every depth and drops undefined entries", () => {
    expect(
      canonicalJson({
        b: 1,
        a: { z: [3, { y: undefined, x: "x" }], B: null, ä: true },
        c: undefined,
      }),
    ).toBe('{"a":{"B":null,"z":[3,{"x":"x"}],"ä":true},"b":1}');
  });

  it("writes non-finite numbers and non-JSON values as null", () => {
    expect(
      canonicalJson([Number.NaN, Number.POSITIVE_INFINITY, -0, 1.5, () => 1, Symbol("s"), 1n]),
    ).toBe("[null,null,0,1.5,null,null,null]");
  });

  it("is independent of key insertion order", () => {
    expect(canonicalJson({ sourceThreadId: "t", destination: { kind: "new-chat" } })).toBe(
      canonicalJson({ destination: { kind: "new-chat" }, sourceThreadId: "t" }),
    );
  });

  it("hashes UTF-8 text as lowercase hex", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("😀")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("keeps Agent Control plan digests and handoff JSON byte-identical", () => {
    // Pinned before the canonical JSON moved out of planDigest.ts: a changed digest would
    // invalidate every stored proposal approval.
    const plan: AgentControlCreateThreadsPlan = {
      kind: "createThreads",
      entries: [
        {
          projectId: ProjectId.make("project-1"),
          title: "Fix the flaky test",
          prompt: "Investigate and fix the flaky worktree test.",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6" },
          runtimeMode: "full-access",
          envMode: "worktree",
          baseRef: "main",
        },
      ],
    };
    expect(computeAgentControlPlanDigest(plan)).toBe(
      "be0b2b060650f65f9b35c41ed982e0419cd7ebbe339d8dd1789f527727068066",
    );
    const value = { b: [1, { d: undefined, c: Number.NaN }], a: "x" };
    expect(stableStringifyContextHandoff(value)).toBe(canonicalJson(value));
  });
});
