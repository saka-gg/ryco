import type { ChangeRequest, VcsRef } from "@ryco/contracts";
import { getChangeRequestHostCapabilities } from "@ryco/shared/sourceControl";
import { Option } from "effect";
import { describe, expect, it } from "vitest";

import {
  branchFromRef,
  buildCreatePullRequestInput,
  defaultBaseBranch,
  defaultHeadBranch,
  describeCreatePullRequestNotice,
  findOpenChangeRequest,
  needsRemoteLookup,
  pickableBranches,
  resolveHeadPushState,
  validateCreatePullRequest,
  type CreatePullRequestBranch,
} from "./createPullRequest.logic";

function local(name: string, extra: Partial<VcsRef> = {}): VcsRef {
  return { name, current: false, isDefault: false, worktreePath: null, isRemote: false, ...extra };
}

function remote(name: string, remoteName = "origin"): VcsRef {
  return {
    name: `${remoteName}/${name}`,
    current: false,
    isDefault: false,
    worktreePath: null,
    isRemote: true,
    remoteName,
  };
}

const branch = (name: string, isRemote = false): CreatePullRequestBranch => ({
  name,
  refName: isRemote ? `origin/${name}` : name,
  isRemote,
});

function changeRequest(patch: Partial<ChangeRequest>): ChangeRequest {
  return {
    provider: "github",
    number: 812,
    title: "Fixture",
    url: "https://github.com/ryco-labs/ryco/pull/812",
    baseRefName: "main",
    headRefName: "feature",
    state: "open",
    updatedAt: Option.none(),
    ...patch,
  };
}

describe("branchFromRef", () => {
  it("keeps local names and strips the origin prefix from remote-tracking refs", () => {
    expect(branchFromRef(local("ryco/feature"))).toEqual({
      name: "ryco/feature",
      refName: "ryco/feature",
      isRemote: false,
    });
    expect(branchFromRef(remote("ryco/feature"))).toEqual({
      name: "ryco/feature",
      refName: "origin/ryco/feature",
      isRemote: true,
    });
  });

  it("drops other remotes and the remote's symbolic HEAD", () => {
    expect(branchFromRef(remote("feature", "upstream"))).toBeNull();
    expect(branchFromRef(remote("HEAD"))).toBeNull();
    // Without a parsed remote name the prefix still decides.
    const { remoteName: _remoteName, ...unparsed } = remote("feature");
    expect(branchFromRef(unparsed)).toEqual(branch("feature", true));
  });

  it("lists pickable branches once, in the server's order", () => {
    const refs = [
      local("main", { isDefault: true }),
      remote("x"),
      remote("x"),
      remote("y", "fork"),
    ];
    expect(pickableBranches(refs).map((entry) => entry.refName)).toEqual(["main", "origin/x"]);
  });
});

describe("defaults", () => {
  it("heads from the checkout's branch (status first, then the ref list)", () => {
    const refs = [local("other", { current: true })];
    expect(defaultHeadBranch({ status: { refName: "feature" }, refs })).toEqual(branch("feature"));
    expect(defaultHeadBranch({ status: { refName: null }, refs })).toEqual(branch("other"));
    expect(defaultHeadBranch({ status: null, refs: [] })).toBeNull();
  });

  it("bases on the repository default, else a conventional main or master", () => {
    expect(
      defaultBaseBranch({
        refs: [local("develop", { isDefault: true }), local("main")],
        head: "x",
      }),
    ).toEqual(branch("develop"));
    expect(defaultBaseBranch({ refs: [local("feature"), remote("main")], head: "x" })).toEqual(
      branch("main", true),
    );
    expect(defaultBaseBranch({ refs: [local("master")], head: "x" })).toEqual(branch("master"));
    expect(defaultBaseBranch({ refs: [local("feature")], head: "x" })).toBeNull();
  });

  it("never defaults the base to the head", () => {
    expect(
      defaultBaseBranch({ refs: [local("main", { isDefault: true })], head: "main" }),
    ).toBeNull();
  });
});

describe("resolveHeadPushState", () => {
  const status = { refName: "feature", hasUpstream: true, aheadCount: 0 };

  it("trusts the current branch's upstream and counts unpushed commits", () => {
    expect(resolveHeadPushState({ head: branch("feature"), status, remote: "absent" })).toEqual({
      kind: "pushed",
      unpushedCommits: 0,
    });
    expect(
      resolveHeadPushState({
        head: branch("feature"),
        status: { ...status, aheadCount: 2 },
        remote: "absent",
      }),
    ).toEqual({ kind: "pushed", unpushedCommits: 2 });
    expect(
      resolveHeadPushState({
        head: branch("feature"),
        status: { ...status, hasUpstream: false },
        remote: "present",
      }),
    ).toEqual({ kind: "unpushed" });
  });

  it("treats a remote-tracking head as pushed", () => {
    expect(resolveHeadPushState({ head: branch("x", true), status, remote: "absent" })).toEqual({
      kind: "pushed",
      unpushedCommits: 0,
    });
  });

  it("asks the remote for any other local branch", () => {
    const head = branch("other");
    expect(needsRemoteLookup(head, status)).toBe(true);
    expect(needsRemoteLookup(branch("feature"), status)).toBe(false);
    expect(needsRemoteLookup(branch("other", true), status)).toBe(false);
    expect(resolveHeadPushState({ head, status, remote: "present" }).kind).toBe("pushed");
    expect(resolveHeadPushState({ head, status, remote: "absent" }).kind).toBe("unpushed");
    expect(resolveHeadPushState({ head, status, remote: "checking" }).kind).toBe("checking");
    expect(resolveHeadPushState({ head, status, remote: "failed" }).kind).toBe("unknown");
    expect(resolveHeadPushState({ head: null, status, remote: "present" }).kind).toBe("none");
  });
});

describe("findOpenChangeRequest", () => {
  it("matches an open, same-repository request between the same branches", () => {
    const rows = [
      changeRequest({ number: 1, state: "closed" }),
      changeRequest({ number: 2, isCrossRepository: true }),
      changeRequest({ number: 3, baseRefName: "release" }),
      changeRequest({ number: 4 }),
    ];
    expect(findOpenChangeRequest({ rows, head: "feature", base: "main" })?.number).toBe(4);
    expect(findOpenChangeRequest({ rows, head: "feature", base: "develop" })).toBeNull();
    expect(findOpenChangeRequest({ rows: null, head: "feature", base: "main" })).toBeNull();
  });
});

describe("validateCreatePullRequest", () => {
  const pushed = { kind: "pushed", unpushedCommits: 0 } as const;
  const valid = {
    head: branch("feature"),
    base: branch("main"),
    title: "Add the create dialog",
    pushState: pushed,
    existing: null,
  };

  it("submits a titled request between two pushed branches", () => {
    expect(validateCreatePullRequest(valid)).toEqual({ canSubmit: true, notice: null });
  });

  it("requires a title without nagging about it", () => {
    expect(validateCreatePullRequest({ ...valid, title: "  " })).toEqual({
      canSubmit: false,
      notice: null,
    });
  });

  it("blocks the same branch on both sides, an unpushed head and an open duplicate", () => {
    expect(validateCreatePullRequest({ ...valid, base: branch("feature", true) }).notice).toEqual({
      kind: "same-branch",
      tone: "blocker",
      branch: "feature",
    });
    expect(validateCreatePullRequest({ ...valid, pushState: { kind: "unpushed" } })).toMatchObject({
      canSubmit: false,
      notice: { kind: "unpushed" },
    });
    expect(
      validateCreatePullRequest({ ...valid, existing: changeRequest({ number: 9 }) }),
    ).toMatchObject({ canSubmit: false, notice: { kind: "already-open", number: 9 } });
  });

  it("waits for the remote lookup, and lets the host decide when it failed", () => {
    expect(validateCreatePullRequest({ ...valid, pushState: { kind: "checking" } })).toMatchObject({
      canSubmit: false,
      notice: { kind: "checking" },
    });
    expect(validateCreatePullRequest({ ...valid, pushState: { kind: "unknown" } })).toEqual({
      canSubmit: true,
      notice: null,
    });
  });

  it("notes local commits the remote doesn't have, without blocking", () => {
    expect(
      validateCreatePullRequest({ ...valid, pushState: { kind: "pushed", unpushedCommits: 2 } }),
    ).toEqual({
      canSubmit: true,
      notice: { kind: "unpushed-commits", tone: "note", branch: "feature", count: 2 },
    });
  });

  it("describes notices in the host's words", () => {
    expect(
      describeCreatePullRequestNotice(
        { kind: "unpushed", tone: "blocker", branch: "feature" },
        { longName: "merge request" },
      ),
    ).toBe("feature isn't on origin yet. Push it, then open the merge request.");
    expect(
      describeCreatePullRequestNotice(
        { kind: "unpushed-commits", tone: "note", branch: "feature", count: 1 },
        { longName: "pull request" },
      ),
    ).toBe("1 local commit isn't on origin yet; the pull request opens without it.");
  });
});

describe("buildCreatePullRequestInput", () => {
  const input = {
    cwd: "/repo",
    head: branch("feature", true),
    base: branch("main"),
    title: "  Add the create dialog ",
    body: "Body\n\n",
    draft: true,
  };

  it("sends host branch names, a trimmed title and draft only where the host has drafts", () => {
    expect(
      buildCreatePullRequestInput({
        ...input,
        capabilities: getChangeRequestHostCapabilities("github"),
      }),
    ).toEqual({
      cwd: "/repo",
      baseRefName: "main",
      headRefName: "feature",
      title: "Add the create dialog",
      body: "Body",
      draft: true,
    });
    expect(
      buildCreatePullRequestInput({
        ...input,
        capabilities: { create: { supported: true, draft: false } },
      }),
    ).not.toHaveProperty("draft");
  });
});
