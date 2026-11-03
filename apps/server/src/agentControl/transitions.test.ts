import { describe, expect, it } from "vite-plus/test";

import {
  operationTransitionIssue,
  proposalTransitionIssue,
  type AgentControlTransitionActor,
} from "./transitions.ts";

const ACTORS: ReadonlyArray<AgentControlTransitionActor> = [
  "user",
  "executor",
  "system",
  "standing-approval",
];

describe("proposalTransitionIssue", () => {
  it("permits the documented lifecycle", () => {
    expect(
      proposalTransitionIssue({ from: "pending-user-approval", to: "approved", actor: "user" }),
    ).toBeNull();
    expect(
      proposalTransitionIssue({ from: "pending-user-approval", to: "rejected", actor: "user" }),
    ).toBeNull();
    expect(
      proposalTransitionIssue({ from: "pending-user-approval", to: "expired", actor: "system" }),
    ).toBeNull();
    expect(
      proposalTransitionIssue({ from: "approved", to: "executing", actor: "executor" }),
    ).toBeNull();
    expect(
      proposalTransitionIssue({ from: "executing", to: "completed", actor: "executor" }),
    ).toBeNull();
    expect(
      proposalTransitionIssue({ from: "executing", to: "failed", actor: "executor" }),
    ).toBeNull();
  });

  it("lets a standing approval approve a pending proposal and do nothing else", () => {
    expect(
      proposalTransitionIssue({
        from: "pending-user-approval",
        to: "approved",
        actor: "standing-approval",
      }),
    ).toBeNull();
    for (const [from, to] of [
      ["pending-user-approval", "rejected"],
      ["pending-user-approval", "cancelled"],
      ["pending-user-approval", "expired"],
      ["approved", "executing"],
      ["approved", "cancelled"],
      ["executing", "completed"],
    ] as const) {
      expect(proposalTransitionIssue({ from, to, actor: "standing-approval" })).not.toBeNull();
    }
    for (const [from, to] of [
      ["pending", "running"],
      ["running", "completed"],
    ] as const) {
      expect(operationTransitionIssue({ from, to, actor: "standing-approval" })).not.toBeNull();
    }
  });

  it("only the executor may move an accepted proposal into executing", () => {
    expect(
      proposalTransitionIssue({ from: "approved", to: "executing", actor: "user" }),
    ).not.toBeNull();
    expect(
      proposalTransitionIssue({ from: "approved", to: "executing", actor: "system" }),
    ).not.toBeNull();
  });

  it("never executes without an approval, even for the executor", () => {
    for (const from of ["pending-user-approval", "rejected", "expired", "cancelled"] as const) {
      for (const actor of ACTORS) {
        expect(proposalTransitionIssue({ from, to: "executing", actor })).not.toBeNull();
      }
    }
  });

  it("treats terminal states as terminal for every actor", () => {
    for (const from of ["rejected", "expired", "completed", "failed", "cancelled"] as const) {
      for (const to of ["pending-user-approval", "approved", "executing", "completed"] as const) {
        for (const actor of ACTORS) {
          expect(proposalTransitionIssue({ from, to, actor })).not.toBeNull();
        }
      }
    }
  });

  it("never re-enters pending-user-approval: plans cannot be edited in place", () => {
    for (const from of ["approved", "executing", "rejected", "cancelled"] as const) {
      for (const actor of ACTORS) {
        expect(
          proposalTransitionIssue({ from, to: "pending-user-approval", actor }),
        ).not.toBeNull();
      }
    }
  });
});

describe("operationTransitionIssue", () => {
  it("permits the executor-driven lifecycle", () => {
    expect(
      operationTransitionIssue({ from: "pending", to: "running", actor: "executor" }),
    ).toBeNull();
    expect(
      operationTransitionIssue({ from: "running", to: "compensating", actor: "executor" }),
    ).toBeNull();
    expect(
      operationTransitionIssue({ from: "compensating", to: "failed", actor: "executor" }),
    ).toBeNull();
  });

  it("rejects user-driven and illegal operation transitions", () => {
    expect(
      operationTransitionIssue({ from: "pending", to: "running", actor: "user" }),
    ).not.toBeNull();
    expect(
      operationTransitionIssue({ from: "pending", to: "completed", actor: "executor" }),
    ).not.toBeNull();
    expect(
      operationTransitionIssue({ from: "completed", to: "running", actor: "executor" }),
    ).not.toBeNull();
    expect(
      operationTransitionIssue({ from: "cancelled", to: "running", actor: "executor" }),
    ).not.toBeNull();
  });
});
