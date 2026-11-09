import { ProjectId } from "@ryco/contracts";
import type { ProjectsPromoteChatPreviewResult } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  findFreeDestination,
  freeDestinationCandidates,
  previewForDestination,
} from "./promoteChatModel";

function preview(
  destination: string,
  status: ProjectsPromoteChatPreviewResult["destinationStatus"],
): ProjectsPromoteChatPreviewResult {
  return {
    projectId: ProjectId.make("project-chat"),
    source: "/Users/me/.ryco/chats/trip",
    defaultDestination: "/Users/me/code/trip",
    destination,
    destinationStatus: status,
    fileCount: 3,
    totalBytes: 2048,
    countTruncated: false,
    busyThreadIds: [],
    gitAvailable: true,
    gitIdentityConfigured: true,
    crossDevice: false,
  };
}

describe("promote chat preview", () => {
  it("speaks only for the location it was asked for", () => {
    const answer = {
      destination: "/Users/me/code/trip",
      result: preview("/Users/me/code/trip", "available"),
    };
    expect(previewForDestination(answer, " /Users/me/code/trip ")?.destinationStatus).toBe(
      "available",
    );
    expect(previewForDestination(answer, "/Users/me/code/trips")).toBeNull();
    expect(previewForDestination(null, "/Users/me/code/trip")).toBeNull();
  });

  it("lists the numbered siblings of a taken folder", () => {
    expect(freeDestinationCandidates("/Users/me/code/trip").slice(0, 2)).toEqual([
      "/Users/me/code/trip-2",
      "/Users/me/code/trip-3",
    ]);
    expect(freeDestinationCandidates("/Users/me/code/trip-4")[0]).toBe("/Users/me/code/trip-5");
    expect(freeDestinationCandidates("   ")).toEqual([]);
  });

  it("finds the first free sibling and gives up on a failed probe", async () => {
    const asked: string[] = [];
    const free = await findFreeDestination({
      candidates: ["/a/trip-2", "/a/trip-3", "/a/trip-4"],
      preview: async (destination) => {
        asked.push(destination);
        return preview(destination, destination.endsWith("-3") ? "available" : "exists");
      },
      cancelled: () => false,
    });
    expect(free).toBe("/a/trip-3");
    expect(asked).toEqual(["/a/trip-2", "/a/trip-3"]);

    const failed = await findFreeDestination({
      candidates: ["/a/trip-2"],
      preview: () => Promise.reject(new Error("offline")),
      cancelled: () => false,
    });
    expect(failed).toBeNull();

    const cancelled = await findFreeDestination({
      candidates: ["/a/trip-2"],
      preview: async (destination) => preview(destination, "available"),
      cancelled: () => true,
    });
    expect(cancelled).toBeNull();
  });
});
