import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_LIFECYCLE_SUGGESTION_POLICY,
  LifecycleSuggestionPolicy,
  WorkspaceLifecycleSummary,
} from "./workspaceLifecycle.ts";

const decodePolicy = Schema.decodeUnknownSync(LifecycleSuggestionPolicy);

describe("LifecycleSuggestionPolicy", () => {
  it("fills fields a sparse settings file omitted with their defaults", () => {
    expect(DEFAULT_LIFECYCLE_SUGGESTION_POLICY).toEqual({
      archiveInactiveThreadsDays: 30,
      removeArchivedCheckoutsDays: 7,
    });
    expect(decodePolicy({})).toEqual(DEFAULT_LIFECYCLE_SUGGESTION_POLICY);
    expect(decodePolicy({ archiveInactiveThreadsDays: 14 })).toEqual({
      archiveInactiveThreadsDays: 14,
      removeArchivedCheckoutsDays: 7,
    });
  });

  it("keeps an explicit null as a disabled suggestion and rejects out-of-range days", () => {
    expect(decodePolicy({ removeArchivedCheckoutsDays: null })).toEqual({
      archiveInactiveThreadsDays: 30,
      removeArchivedCheckoutsDays: null,
    });
    expect(() => decodePolicy({ archiveInactiveThreadsDays: 0 })).toThrow();
  });

  it("still encodes every field", () => {
    const policy = { archiveInactiveThreadsDays: 30, removeArchivedCheckoutsDays: null };
    expect(Schema.encodeSync(LifecycleSuggestionPolicy)(policy)).toEqual(policy);
  });
});

describe("WorkspaceLifecycleSummary", () => {
  const summary = {
    worktreeId: "topic",
    projectId: "project",
    title: "Topic",
    branch: "topic",
    path: "/work/topic",
    origin: "branch",
    main: false,
    archivedAt: null,
    checkoutRemovedAt: null,
    checkout: "present",
    gitRegistered: true,
    branchExists: true,
    unmerged: false,
    changes: null,
    conversations: { active: 0, archived: 1, trashed: 0 },
    activeWork: [],
    actions: [],
    inspectedAt: "2026-10-28T00:00:00.000Z",
  };
  const decode = Schema.decodeUnknownSync(WorkspaceLifecycleSummary);

  it("decodes a summary from a node that predates merge proofs", () => {
    expect(decode(summary)).not.toHaveProperty("mergedBy");
  });

  it("carries what proved a branch merged", () => {
    const viaPullRequest = { kind: "pull-request", pullRequestNumber: 7 } as const;
    const viaDefaultBranch = { kind: "default-branch", ref: "origin/main" } as const;
    expect(decode({ ...summary, mergedBy: viaPullRequest }).mergedBy).toEqual(viaPullRequest);
    expect(decode({ ...summary, mergedBy: viaDefaultBranch }).mergedBy).toEqual(viaDefaultBranch);
    expect(decode({ ...summary, mergedBy: null }).mergedBy).toBeNull();
    expect(() =>
      decode({ ...summary, mergedBy: { kind: "pull-request", pullRequestNumber: 0 } }),
    ).toThrow();
    const encoded = Schema.encodeSync(WorkspaceLifecycleSummary)(
      decode({ ...summary, mergedBy: viaPullRequest }),
    );
    expect(encoded.mergedBy).toEqual(viaPullRequest);
  });
});
