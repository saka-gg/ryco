import { describeOfflineSince } from "@ryco/client-runtime/connection";
import type { NodeCatalogEntry } from "@ryco/client-runtime/state/nodes";
import { EnvironmentId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  describeNodePresence,
  nodeCodeRootLabels,
  nodeMachineKind,
  nodeOsLabel,
  nodeSummaryParts,
  nodeTone,
  NODE_TONES,
  resolveNodePickerAvailability,
} from "./nodePicker.ts";

function node(overrides: Partial<NodeCatalogEntry> = {}): NodeCatalogEntry {
  return {
    environmentId: EnvironmentId.make("environment-mini"),
    label: "Mac mini",
    isPrimary: false,
    isThisDevice: false,
    presence: "online",
    platformOs: "darwin",
    iconKind: null,
    canMutate: true,
    mutateBlockedReason: null,
    projectCopySupport: "yes",
    transport: "direct",
    lastSeenAt: null,
    ...overrides,
  };
}

describe("resolveNodePickerAvailability", () => {
  it("accepts an online node the client can mutate", () => {
    expect(resolveNodePickerAvailability(node(), {}, undefined)).toEqual({
      selectable: true,
      reason: null,
      reasonIsPresence: false,
    });
  });

  it("keeps offline nodes visible but not selectable unless allowed", () => {
    expect(resolveNodePickerAvailability(node({ presence: "offline" }), {}, undefined)).toEqual({
      selectable: false,
      reason: "Mac mini is offline",
      reasonIsPresence: true,
    });
    expect(
      resolveNodePickerAvailability(
        node({ presence: "offline" }),
        { allowOffline: true },
        undefined,
      ).selectable,
    ).toBe(true);
    expect(
      resolveNodePickerAvailability(node({ presence: "connecting" }), {}, undefined).selectable,
    ).toBe(true);
  });

  it("uses the catalog's reason when the node can't be mutated", () => {
    const blocked = node({
      canMutate: false,
      mutateBlockedReason: "Update Ryco on Mac mini to copy projects here",
    });
    expect(resolveNodePickerAvailability(blocked, {}, undefined).reason).toBe(
      "Update Ryco on Mac mini to copy projects here",
    );
    expect(
      resolveNodePickerAvailability(blocked, { requireMutate: false }, undefined).selectable,
    ).toBe(true);
  });

  it("disables nodes known to lack project copy but keeps unknown ones", () => {
    expect(
      resolveNodePickerAvailability(
        node({ projectCopySupport: "no" }),
        { requireProjectCopy: true },
        undefined,
      ),
    ).toEqual({
      selectable: false,
      reason: "Update Ryco on Mac mini to copy projects here",
      reasonIsPresence: false,
    });
    expect(
      resolveNodePickerAvailability(
        node({ projectCopySupport: "unknown" }),
        { requireProjectCopy: true },
        undefined,
      ).selectable,
    ).toBe(true);
  });

  it("lets the caller's reason win", () => {
    expect(
      resolveNodePickerAvailability(
        node({ presence: "offline" }),
        {},
        {
          disabledReason: "has it · ~/dev/ryco",
        },
      ),
    ).toEqual({ selectable: false, reason: "has it · ~/dev/ryco", reasonIsPresence: false });
  });
});

describe("node presentation", () => {
  it("names the OS", () => {
    expect(nodeOsLabel("darwin")).toBe("macOS");
    expect(nodeOsLabel("windows")).toBe("Windows");
    expect(nodeOsLabel("linux")).toBe("Linux");
    expect(nodeOsLabel("sunos")).toBe("Sunos");
    expect(nodeOsLabel(null)).toBeNull();
  });

  it("describes presence with when an offline node was seen", () => {
    const now = Date.parse("2026-10-22T12:00:00Z");
    expect(describeNodePresence(node(), now)).toEqual({ tone: "online", text: "online" });
    expect(
      describeNodePresence(node({ presence: "offline", lastSeenAt: now - 2 * 3_600_000 }), now),
    ).toEqual({
      tone: "offline",
      text: `offline ${describeOfflineSince(now - 2 * 3_600_000, { nowMs: now })}`,
    });
    expect(describeNodePresence(node({ presence: "offline" }), now).text).toBe("offline");
  });

  it("summarises projects and the code roots that aren't home", () => {
    const pathHints = {
      homeDirectory: "/Users/me",
      codeRoots: [
        { path: "/Users/me", source: "home" as const, projectCount: 0 },
        { path: "/Users/me/Code", source: "well-known" as const, projectCount: 3 },
        {
          path: "/Users/me/Dropbox/Code/Web",
          source: "existing-projects" as const,
          projectCount: 2,
        },
      ],
    };
    expect(nodeCodeRootLabels(pathHints)).toEqual(["~/Code", "~/Dropbox/Code/Web"]);
    expect(nodeSummaryParts({ projectCount: 3, pathHints })).toEqual({
      kind: "projects",
      projects: "3 projects",
      roots: "~/Code, ~/Dropbox/Code/Web",
    });
    expect(nodeSummaryParts({ projectCount: 1 })).toEqual({
      kind: "projects",
      projects: "1 project",
      roots: null,
    });
    expect(nodeSummaryParts({ pathHints })).toMatchObject({ projects: null });
    expect(nodeSummaryParts({ projectCount: 1, detail: "has it · ~/dev/ryco" })).toEqual({
      kind: "detail",
      text: "has it · ~/dev/ryco",
    });
    expect(nodeSummaryParts({})).toBeNull();
    expect(nodeSummaryParts(undefined)).toBeNull();
  });

  it("prefers the configured machine kind over the inferred one", () => {
    expect(nodeMachineKind(node())).toBe("mini-pc");
    expect(nodeMachineKind(node({ iconKind: "server" }))).toBe("server");
  });

  it("gives this device the brand tone and other nodes a stable categorical one", () => {
    expect(nodeTone(node({ isThisDevice: true }))).toBe("info");
    const tone = nodeTone(node());
    expect(tone).not.toBe("info");
    expect(NODE_TONES).toContain(tone);
    expect(nodeTone(node())).toBe(tone);
  });
});
