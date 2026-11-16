import { OrchestrationDispatchCommandError } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  OrchestrationCommandAdmissionError,
  OrchestrationCommandInvariantError,
  OrchestrationCommandPreviouslyRejectedError,
  isSettledDispatchRejection,
} from "./Errors.ts";

describe("isSettledDispatchRejection", () => {
  const invariant = new OrchestrationCommandInvariantError({
    commandType: "thread.create",
    detail: "x",
  });

  it("matches a bare invariant or previously-rejected error", () => {
    expect(isSettledDispatchRejection(invariant)).toBe(true);
    expect(
      isSettledDispatchRejection(
        new OrchestrationCommandPreviouslyRejectedError({ commandId: "c", detail: "x" }),
      ),
    ).toBe(true);
  });

  it("matches a settled rejection wrapped as the cause of a dispatch error", () => {
    expect(
      isSettledDispatchRejection(
        new OrchestrationDispatchCommandError({ message: "failed", cause: invariant }),
      ),
    ).toBe(true);
  });

  it("does not match other failures", () => {
    expect(
      isSettledDispatchRejection(
        new OrchestrationDispatchCommandError({ message: "failed", cause: new Error("boom") }),
      ),
    ).toBe(false);
    expect(
      isSettledDispatchRejection(new OrchestrationCommandAdmissionError({ detail: "busy" })),
    ).toBe(false);
    expect(isSettledDispatchRejection(new Error("x"))).toBe(false);
    expect(isSettledDispatchRejection(null)).toBe(false);
    expect(isSettledDispatchRejection(undefined)).toBe(false);
    expect(isSettledDispatchRejection("OrchestrationCommandInvariantError")).toBe(false);
  });
});
