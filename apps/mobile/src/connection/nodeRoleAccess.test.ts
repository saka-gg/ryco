import { WS_METHODS } from "@ryco/contracts/rpc";
import { describe, expect, it } from "vite-plus/test";

import { nodeMethodBlockReason, nodeRoleAllows } from "./nodeRoleAccess";

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

const method = WS_METHODS.projectsPromoteChat;
const ready = { connectionState: "connected", mutationReady: true } as const;

describe("nodeMethodBlockReason", () => {
  it("allows a role the node's rule allows on a synchronized connection", () => {
    expect(nodeMethodBlockReason({ ...ready, role: "owner" }, method, "move chats")).toBeNull();
    expect(nodeMethodBlockReason({ ...ready, role: "operator" }, method, "move chats")).toBeNull();
    // An unknown role is the node's to check.
    expect(nodeMethodBlockReason(ready, method, "move chats")).toBeNull();
  });

  it("names the role when it is not enough", () => {
    expect(nodeMethodBlockReason({ ...ready, role: "viewer" }, method, "move chats")).toBe(
      "Your access to this machine can't move chats.",
    );
    // A direct pairing that is not the owner is a viewer to the node.
    expect(
      nodeMethodBlockReason({ ...ready, role: "client" }, method, "move chats"),
    ).not.toBeNull();
  });

  it("asks to reconnect until writes are synchronized", () => {
    expect(
      nodeMethodBlockReason(
        { role: "owner", connectionState: "connected", mutationReady: false },
        method,
        "move chats",
      ),
    ).toBe("Reconnect the machine to move chats.");
    expect(
      nodeMethodBlockReason({ role: "owner", connectionState: "offline" }, method, "move chats"),
    ).toBe("Reconnect the machine to move chats.");
  });
});
