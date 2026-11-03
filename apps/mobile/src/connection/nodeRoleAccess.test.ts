import { WS_METHODS } from "@ryco/contracts/rpc";
import { describe, expect, it } from "vite-plus/test";

import { nodeRoleAllows } from "./nodeRoleAccess";

describe("nodeRoleAllows", () => {
  it("applies the node's own access rule to each role", () => {
    const merge = WS_METHODS.sourceControlMergeChangeRequest;
    expect(nodeRoleAllows("owner", merge)).toBe(true);
    expect(nodeRoleAllows("operator", merge)).toBe(true);
    expect(nodeRoleAllows("viewer", merge)).toBe(false);
  });

  it("treats a direct pairing that is not the node's owner as a viewer", () => {
    expect(nodeRoleAllows("client", WS_METHODS.sourceControlSubmitChangeRequestReview)).toBe(false);
    expect(nodeRoleAllows("client", WS_METHODS.sourceControlGetChangeRequestDetail)).toBe(false);
  });
});
