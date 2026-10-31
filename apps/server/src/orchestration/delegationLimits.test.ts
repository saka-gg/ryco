import { ThreadId } from "@ryco/contracts";
import { assert, describe, it } from "vitest";

import {
  delegationLimitRefusal,
  delegationPosition,
  delegationTreeTaskCount,
  mayDelegateAtDepth,
  type DelegationNode,
} from "./delegationLimits.ts";

const id = ThreadId.make;
const delegated = (thread: string, parent: string, root: string): DelegationNode => ({
  id: id(thread),
  lineage: { parentThreadId: id(parent), rootThreadId: id(root), relationship: "delegated" },
});
const tree = new Map<string, DelegationNode>(
  [
    { id: id("root") },
    delegated("a", "root", "root"),
    delegated("b", "a", "root"),
    {
      id: id("fork"),
      lineage: { parentThreadId: id("b"), rootThreadId: id("root"), relationship: "forked" },
    },
    delegated("c", "fork", "fork"),
  ].map((node) => [node.id, node]),
);
const lookup = (threadId: ThreadId) => tree.get(threadId);

describe("delegationPosition", () => {
  it("counts delegated hops up to the tree's root", () => {
    assert.deepStrictEqual(delegationPosition(tree.get("root")!, lookup), {
      depth: 0,
      rootThreadId: id("root"),
    });
    assert.deepStrictEqual(delegationPosition(tree.get("b")!, lookup), {
      depth: 2,
      rootThreadId: id("root"),
    });
  });

  it("starts a new tree at a fork, which was not delegated", () => {
    assert.deepStrictEqual(delegationPosition(tree.get("fork")!, lookup), {
      depth: 0,
      rootThreadId: id("fork"),
    });
    assert.deepStrictEqual(delegationPosition(tree.get("c")!, lookup), {
      depth: 1,
      rootThreadId: id("fork"),
    });
  });

  it("reads a delegation loop as the deepest possible", () => {
    const loop = new Map<string, DelegationNode>([
      ["x", delegated("x", "y", "r")],
      ["y", delegated("y", "x", "r")],
    ]);
    const position = delegationPosition(loop.get("x")!, (threadId) => loop.get(threadId));
    assert.isFalse(mayDelegateAtDepth({ maxDepth: 10, maxTasksPerTree: null }, position.depth));
  });
});

describe("delegationLimitRefusal", () => {
  it("allows everything without limits", () => {
    assert.isNull(
      delegationLimitRefusal({
        limits: { maxDepth: null, maxTasksPerTree: null },
        callerDepth: 40,
        treeTasks: 900,
        newTasks: 10,
      }),
    );
  });

  it("lets depth maxDepth - 1 delegate and refuses the last level", () => {
    const limits = { maxDepth: 2, maxTasksPerTree: null };
    assert.isNull(delegationLimitRefusal({ limits, callerDepth: 1, treeTasks: 0, newTasks: 3 }));
    assert.include(
      delegationLimitRefusal({ limits, callerDepth: 2, treeTasks: 0, newTasks: 1 }) ?? "",
      "at most 2 levels below",
    );
  });

  it("refuses a batch that does not fit the tree's remaining budget", () => {
    const limits = { maxDepth: null, maxTasksPerTree: 5 };
    assert.isNull(delegationLimitRefusal({ limits, callerDepth: 0, treeTasks: 3, newTasks: 2 }));
    const refusal = delegationLimitRefusal({ limits, callerDepth: 0, treeTasks: 3, newTasks: 3 });
    assert.include(refusal ?? "", "has 3 tasks, so 2 more tasks fit and 3 were requested");
  });
});

describe("delegationTreeTaskCount", () => {
  it("counts delegated threads of one root and skips deleted ones", () => {
    const threads = [
      ...tree.values(),
      { ...delegated("gone", "root", "root"), deletedAt: "2026-10-31T00:00:00.000Z" },
    ];
    assert.strictEqual(delegationTreeTaskCount(threads, id("root")), 2);
    assert.strictEqual(delegationTreeTaskCount(threads, id("fork")), 1);
  });
});
