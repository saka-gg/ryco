import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ThreadId, type ThreadLineage } from "@ryco/contracts";

import { scopedThreadKey, scopeThreadRef } from "../../scoped.ts";
import {
  isDelegatedThreadLineage,
  isThreadLineage,
  planDelegatedNesting,
  selectDelegatedChildThreads,
  threadLineagesEqual,
  type DelegatedNestingItem,
  type DelegatedNestingUrgency,
} from "./threadLineage.ts";

const ENV = EnvironmentId.make("environment-local");
const OTHER_ENV = EnvironmentId.make("environment-remote");

const keyOf = (threadId: string, environmentId: EnvironmentId = ENV) =>
  scopedThreadKey(scopeThreadRef(environmentId, ThreadId.make(threadId)));

const delegated = (parent: string, root: string = parent): ThreadLineage => ({
  parentThreadId: ThreadId.make(parent),
  rootThreadId: ThreadId.make(root),
  relationship: "delegated",
});

function item(
  threadId: string,
  overrides: Partial<Omit<DelegatedNestingItem, "key" | "threadId">> & {
    readonly urgency?: DelegatedNestingUrgency;
  } = {},
): DelegatedNestingItem {
  const environmentId = overrides.environmentId ?? ENV;
  return {
    key: keyOf(threadId, environmentId),
    environmentId,
    threadId: ThreadId.make(threadId),
    lineage: null,
    pinned: false,
    focused: false,
    urgency: "recent",
    ...overrides,
  };
}

const hostOf = (plan: ReturnType<typeof planDelegatedNesting>, threadId: string) =>
  plan.hostByChildKey.get(keyOf(threadId)) ?? null;

describe("planDelegatedNesting", () => {
  it("nests a quiet child under its parent", () => {
    const plan = planDelegatedNesting([
      item("parent"),
      item("child", { lineage: delegated("parent"), urgency: "settled" }),
    ]);
    expect(hostOf(plan, "child")).toBe(keyOf("parent"));
    expect(plan.childKeysByHostKey.get(keyOf("parent"))).toEqual([keyOf("child")]);
  });

  it("keeps a working or needs-input child top-level", () => {
    const plan = planDelegatedNesting([
      item("parent", { urgency: "recent" }),
      item("working", { lineage: delegated("parent"), urgency: "active" }),
      item("asking", { lineage: delegated("parent"), urgency: "needs-input" }),
    ]);
    expect(hostOf(plan, "working")).toBeNull();
    expect(hostOf(plan, "asking")).toBeNull();
    expect(plan.childKeysByHostKey.size).toBe(0);
  });

  it("only nests a child that is not more urgent than its host", () => {
    const recentUnderSettled = planDelegatedNesting([
      item("parent", { urgency: "settled" }),
      item("child", { lineage: delegated("parent"), urgency: "recent" }),
    ]);
    expect(hostOf(recentUnderSettled, "child")).toBeNull();

    const settledUnderRecent = planDelegatedNesting([
      item("parent", { urgency: "recent" }),
      item("child", { lineage: delegated("parent"), urgency: "settled" }),
    ]);
    expect(hostOf(settledUnderRecent, "child")).toBe(keyOf("parent"));
  });

  it("keeps pinned and focused children top-level", () => {
    const plan = planDelegatedNesting([
      item("parent"),
      item("pinned", { lineage: delegated("parent"), pinned: true }),
      item("focused", { lineage: delegated("parent"), focused: true }),
    ]);
    expect(hostOf(plan, "pinned")).toBeNull();
    expect(hostOf(plan, "focused")).toBeNull();
  });

  it("flattens a grandchild to the topmost visible host", () => {
    const plan = planDelegatedNesting([
      item("root"),
      item("child", { lineage: delegated("root") }),
      item("grandchild", { lineage: delegated("child", "root"), urgency: "settled" }),
    ]);
    expect(hostOf(plan, "child")).toBe(keyOf("root"));
    expect(hostOf(plan, "grandchild")).toBe(keyOf("root"));
    expect(plan.childKeysByHostKey.get(keyOf("root"))).toEqual([
      keyOf("child"),
      keyOf("grandchild"),
    ]);
  });

  it("walks an invisible intermediate through lineageByKey", () => {
    const plan = planDelegatedNesting(
      [item("root"), item("grandchild", { lineage: delegated("hidden-child", "other-root") })],
      { lineageByKey: new Map([[keyOf("hidden-child"), delegated("root")]]) },
    );
    expect(hostOf(plan, "grandchild")).toBe(keyOf("root"));
  });

  it("falls back to a visible root when an intermediate is missing", () => {
    const plan = planDelegatedNesting([
      item("root"),
      item("grandchild", { lineage: delegated("deleted-child", "root") }),
    ]);
    expect(hostOf(plan, "grandchild")).toBe(keyOf("root"));
  });

  it("does not nest under the same thread id in another environment", () => {
    const plan = planDelegatedNesting([
      item("parent", { environmentId: OTHER_ENV }),
      item("child", { lineage: delegated("parent") }),
    ]);
    expect(hostOf(plan, "child")).toBeNull();
  });

  it("renders unknown relationships flat", () => {
    const plan = planDelegatedNesting([
      item("parent"),
      item("forked", {
        lineage: {
          parentThreadId: ThreadId.make("parent"),
          rootThreadId: ThreadId.make("parent"),
          relationship: "future-kind",
        },
      }),
    ]);
    expect(hostOf(plan, "forked")).toBeNull();
  });

  it("terminates a two-node cycle with both items top-level", () => {
    const plan = planDelegatedNesting([
      item("a", { lineage: delegated("b") }),
      item("b", { lineage: delegated("a") }),
    ]);
    expect(hostOf(plan, "a")).toBeNull();
    expect(hostOf(plan, "b")).toBeNull();
    expect(plan.childKeysByHostKey.size).toBe(0);
  });

  it("keeps children in input order", () => {
    const plan = planDelegatedNesting([
      item("third", { lineage: delegated("parent") }),
      item("parent"),
      item("first", { lineage: delegated("parent") }),
      item("second", { lineage: delegated("parent"), urgency: "snoozed" }),
    ]);
    expect(plan.childKeysByHostKey.get(keyOf("parent"))).toEqual([
      keyOf("third"),
      keyOf("first"),
      keyOf("second"),
    ]);
  });
});

describe("thread lineage helpers", () => {
  const summary = (
    id: string,
    overrides: {
      readonly lineage?: ThreadLineage | null;
      readonly createdAt?: string;
      readonly archivedAt?: string | null;
      readonly environmentId?: EnvironmentId;
    } = {},
  ) => ({
    id: ThreadId.make(id),
    environmentId: overrides.environmentId ?? ENV,
    createdAt: overrides.createdAt ?? "2026-10-01T00:00:00.000Z",
    archivedAt: overrides.archivedAt ?? null,
    lineage: overrides.lineage ?? null,
  });

  it("selects direct, delegated, unarchived children in creation order", () => {
    const parent = scopeThreadRef(ENV, ThreadId.make("parent"));
    const children = selectDelegatedChildThreads(
      [
        summary("later", { lineage: delegated("parent"), createdAt: "2026-10-01T00:00:03.000Z" }),
        summary("grandchild", { lineage: delegated("earlier", "parent") }),
        summary("archived", {
          lineage: delegated("parent"),
          archivedAt: "2026-10-01T00:00:05.000Z",
        }),
        summary("forked", {
          lineage: {
            parentThreadId: ThreadId.make("parent"),
            rootThreadId: ThreadId.make("parent"),
            relationship: "future-kind",
          },
        }),
        summary("remote", { lineage: delegated("parent"), environmentId: OTHER_ENV }),
        summary("earlier", { lineage: delegated("parent"), createdAt: "2026-10-01T00:00:01.000Z" }),
        summary("parent"),
      ],
      parent,
    );
    expect(children.map((child) => child.id)).toEqual(["earlier", "later"]);
  });

  it("treats null and undefined lineage as equal", () => {
    expect(threadLineagesEqual(null, undefined)).toBe(true);
    expect(threadLineagesEqual(undefined, undefined)).toBe(true);
    expect(threadLineagesEqual(delegated("a"), null)).toBe(false);
    expect(threadLineagesEqual(delegated("a"), delegated("a"))).toBe(true);
    expect(threadLineagesEqual(delegated("a"), delegated("a", "b"))).toBe(false);
  });

  it("narrows delegated lineage and validates untrusted lineage", () => {
    expect(isDelegatedThreadLineage(delegated("a"))).toBe(true);
    expect(isDelegatedThreadLineage(null)).toBe(false);
    expect(isDelegatedThreadLineage(undefined)).toBe(false);
    expect(isThreadLineage(delegated("a"))).toBe(true);
    expect(isThreadLineage({ parentThreadId: "a", rootThreadId: "a", relationship: "" })).toBe(
      false,
    );
    expect(isThreadLineage({ parentThreadId: "a" })).toBe(false);
  });
});
